import express from "express";
import multer from "multer";
import pg from "pg";
import crypto from "crypto";
import { capitalOneCsv, initialRules, driveReceipts } from "./seed.js";

const {Pool}=pg;
const app=express();
const port=process.env.PORT||3000;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024}});

function auth(req,res,next){
  const user=process.env.APP_USERNAME,pass=process.env.APP_PASSWORD;
  if(!user||!pass)return next();
  const h=req.headers.authorization||"";
  if(!h.startsWith("Basic ")){res.set("WWW-Authenticate",'Basic realm="Carbon Copy Accounting"');return res.status(401).send("Login required")}
  const [u,p]=Buffer.from(h.slice(6),"base64").toString().split(":");
  if(u!==user||p!==pass){res.set("WWW-Authenticate",'Basic realm="Carbon Copy Accounting"');return res.status(401).send("Invalid login")}
  next();
}
app.use(auth);
app.use(express.json({limit:"8mb"}));
app.use(express.static("public"));

function monthBounds(month){
  const m=/^\d{4}-\d{2}$/.test(month||"")?month:new Date().toISOString().slice(0,7);
  const [y,mo]=m.split("-").map(Number);
  return{month:m,start:m+"-01",next:new Date(Date.UTC(y,mo,1)).toISOString().slice(0,10)}
}
function moneyNum(v){const n=Number(v);return Number.isFinite(n)?Math.round(n*100)/100:null}
function fingerprint(r){
  return crypto.createHash("sha256").update([
    r.transaction_date||"",r.posted_date||"",String(r.card_last4||"0945").padStart(4,"0"),
    String(r.vendor_raw||"").trim().toUpperCase(),Number(r.amount||0).toFixed(2)
  ].join("|")).digest("hex")
}
async function init(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cards(id BIGSERIAL PRIMARY KEY,label TEXT NOT NULL,last4 TEXT NOT NULL UNIQUE,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS categories(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL UNIQUE,active BOOLEAN NOT NULL DEFAULT TRUE,sort_order INT NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS transactions(
      id BIGSERIAL PRIMARY KEY,transaction_date DATE NOT NULL,posted_date DATE,vendor_raw TEXT NOT NULL,vendor_normalized TEXT,
      amount NUMERIC(12,2) NOT NULL,category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,card_id BIGINT REFERENCES cards(id) ON DELETE SET NULL,
      notes TEXT,source TEXT NOT NULL DEFAULT 'manual',external_id TEXT,status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN('pending','posted')),
      payment_method TEXT NOT NULL DEFAULT 'credit_card' CHECK(payment_method IN('credit_card','wire','check','cash')),
      payment_reference TEXT,
      captain_reviewed BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_external_id_idx ON transactions(external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(transaction_date DESC);
    CREATE TABLE IF NOT EXISTS receipts(
      id BIGSERIAL PRIMARY KEY,transaction_id BIGINT UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,file_size BIGINT NOT NULL,file_data BYTEA NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS receipt_date DATE;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS vendor TEXT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2);
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS file_sha256 TEXT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS receipt_text TEXT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
    ALTER TABLE receipts ALTER COLUMN file_data DROP NOT NULL;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'credit_card';
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_reference TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS receipts_sha_idx ON receipts(file_sha256) WHERE file_sha256 IS NOT NULL;
    CREATE TABLE IF NOT EXISTS vendor_rules(
      id BIGSERIAL PRIMARY KEY,vendor_pattern TEXT NOT NULL UNIQUE,category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      approved BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS month_closes(
      id BIGSERIAL PRIMARY KEY,month_start DATE NOT NULL UNIQUE,calculated_total NUMERIC(12,2),closed BOOLEAN NOT NULL DEFAULT FALSE,closed_at TIMESTAMPTZ);
  `);
  await pool.query("INSERT INTO cards(label,last4) VALUES($1,$2) ON CONFLICT(last4) DO NOTHING",["Capital One","0945"]);
  const cats=["Fuel & Lubricants","Dockage / Marina","Repairs & Maintenance","Provisions","Supplies","Insurance","Communications / Internet","Crew Travel","Crew Meals","Training / Certifications","Safety Equipment","Tender / Toys","Professional Services","Shipping / Freight","Customs / Port Fees","Guest Expenses","Transportation","Capital Improvements","Owner / Personal","Navigation / Weather","Miscellaneous"];
  for(let i=0;i<cats.length;i++)await pool.query("INSERT INTO categories(name,sort_order) VALUES($1,$2) ON CONFLICT(name) DO NOTHING",[cats[i],(i+1)*10]);
  await seedInitialData();
  await purgeExpiredReceipts();
}
function parseCsvLine(line){
  const out=[];let cur="",q=false;
  for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){cur+='"';i++}else q=!q}else if(ch===','&&!q){out.push(cur);cur=""}else cur+=ch}
  out.push(cur);return out;
}
function csvDate(v){const d=new Date(v);return !isNaN(d)?d.toISOString().slice(0,10):null}
async function seedInitialData(){
  for(const [pattern,category] of initialRules){
    const c=(await pool.query("SELECT id FROM categories WHERE name=$1",[category])).rows[0];
    if(c){
      await pool.query(`INSERT INTO vendor_rules(vendor_pattern,category_id) VALUES($1,$2)
        ON CONFLICT(vendor_pattern) DO UPDATE SET category_id=EXCLUDED.category_id,approved=true`,[pattern,c.id]);
      await pool.query(`UPDATE transactions SET category_id=$1,captain_reviewed=true,updated_at=NOW()
        WHERE category_id IS NULL AND vendor_raw ILIKE '%'||$2||'%'`,[c.id,pattern]);
    }
  }
  const lines=capitalOneCsv.replace(/\r/g,"").split("\n").filter(Boolean),headers=parseCsvLine(lines[0]).map(x=>x.toLowerCase().replace(/\./g,"").trim());
  const ix=n=>headers.findIndex(h=>h===n),card=(await pool.query("SELECT id FROM cards WHERE last4='0945' LIMIT 1")).rows[0];
  for(const line of lines.slice(1)){
    const c=parseCsvLine(line),debit=Number(c[ix("debit")]||NaN),credit=Number(c[ix("credit")]||NaN);
    const amount=Number.isFinite(debit)&&debit!==0?Math.abs(debit):Number.isFinite(credit)&&credit!==0?-Math.abs(credit):null;
    const row={transaction_date:csvDate(c[ix("transaction date")]),posted_date:csvDate(c[ix("posted date")]),vendor_raw:c[ix("description")]||"",amount,card_last4:String(c[ix("card no")]||"945").padStart(4,"0")};
    if(!row.transaction_date||!row.vendor_raw||row.amount===null)continue;
    const ext=fingerprint(row),rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[row.vendor_raw])).rows[0];
    await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status)
      VALUES($1,$2,$3,$3,$4,$5,$6,'capital-one-csv',$7,'posted') ON CONFLICT DO NOTHING`,
      [row.transaction_date,row.posted_date,row.vendor_raw,row.amount,rule?.category_id||null,card?.id||null,ext]);
    if(rule?.category_id){
      await pool.query("UPDATE transactions SET captain_reviewed=true WHERE external_id=$1",[ext]);
    }
  }
  for(const r of driveReceipts){
    const c=(await pool.query("SELECT id FROM categories WHERE name=$1",[r.category])).rows[0];
    const existing=(await pool.query("SELECT id FROM receipts WHERE source_url=$1",[r.url])).rows[0];if(existing)continue;
    const q=await pool.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256,source_url)
      VALUES(NULL,$1,'application/pdf',0,NULL,$2,$3,$4,$5,NULL,$6) RETURNING id`,[r.file_name,r.date,r.vendor,r.amount,c?.id||null,r.url]);
    await autoMatchReceipt(q.rows[0].id);
  }
}
async function autoMatchReceipt(receiptId){
  const r=(await pool.query("SELECT * FROM receipts WHERE id=$1",[receiptId])).rows[0];
  if(!r||r.transaction_id||r.amount==null||!r.receipt_date)return null;
  const q=await pool.query(`
    SELECT t.id,t.transaction_date,t.vendor_raw,t.amount,
      ABS(t.transaction_date-$2::date) day_gap
    FROM transactions t
    LEFT JOIN receipts rr ON rr.transaction_id=t.id
    WHERE rr.id IS NULL AND t.status='posted'
      AND ABS(t.amount-$1::numeric) < 0.02
      AND t.transaction_date BETWEEN $2::date-INTERVAL '4 days' AND $2::date+INTERVAL '4 days'
    ORDER BY ABS(t.transaction_date-$2::date),t.id LIMIT 3`,[r.amount,r.receipt_date]);
  if(q.rows.length!==1)return null;
  const t=q.rows[0];
  await pool.query("UPDATE receipts SET transaction_id=$1 WHERE id=$2",[t.id,r.id]);
  if(r.category_id)await pool.query("UPDATE transactions SET category_id=COALESCE(category_id,$1),captain_reviewed=true,updated_at=NOW() WHERE id=$2",[r.category_id,t.id]);
  return t.id;
}
async function purgeExpiredReceipts(){
  await pool.query(`UPDATE receipts SET file_data=NULL,source_url=NULL,purged_at=NOW()
    WHERE purged_at IS NULL AND expires_at IS NOT NULL AND expires_at <= NOW()`);
}
setInterval(()=>purgeExpiredReceipts().catch(console.error),24*60*60*1000).unref();

async function matchAllReceipts(){
  const q=await pool.query("SELECT id FROM receipts WHERE transaction_id IS NULL AND amount IS NOT NULL AND receipt_date IS NOT NULL");
  let matched=0;for(const row of q.rows)if(await autoMatchReceipt(row.id))matched++;return matched
}

app.get("/health",(_req,res)=>res.json({ok:true}));

app.get("/api/bootstrap",async(_req,res,next)=>{try{
  const [c,cd,r]=await Promise.all([
    pool.query("SELECT id,name,sort_order FROM categories WHERE active=true ORDER BY sort_order,name"),
    pool.query("SELECT id,label,last4 FROM cards WHERE active=true ORDER BY id"),
    pool.query("SELECT vr.id,vr.vendor_pattern,vr.category_id,c.name category_name FROM vendor_rules vr JOIN categories c ON c.id=vr.category_id ORDER BY vr.vendor_pattern")
  ]);res.json({categories:c.rows,cards:cd.rows,rules:r.rows,payment_methods:["credit_card","wire","check","cash"]})
}catch(e){next(e)}});

app.get("/api/dashboard",async(req,res,next)=>{try{
  const {month,start,next:n}=monthBounds(req.query.month);
  const [s,bc,bv,ri]=await Promise.all([
    pool.query(`SELECT COUNT(*)::int transactions,COALESCE(SUM(amount),0)::numeric total_spend,
      COUNT(*) FILTER(WHERE category_id IS NULL)::int needs_category,
      COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts,
      COUNT(*) FILTER(WHERE captain_reviewed=false)::int needs_review
      FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
      WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date`,[start,n]),
    pool.query(`SELECT COALESCE(c.name,'Uncategorized') name,COALESCE(SUM(t.amount),0)::numeric total
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date GROUP BY 1 ORDER BY total DESC`,[start,n]),
    pool.query(`SELECT COALESCE(NULLIF(vendor_normalized,''),vendor_raw) name,SUM(amount)::numeric total,COUNT(*)::int count
      FROM transactions WHERE status='posted' AND transaction_date >= $1::date AND transaction_date < $2::date GROUP BY 1 ORDER BY total DESC LIMIT 12`,[start,n]),
    pool.query("SELECT COUNT(*)::int count FROM receipts WHERE transaction_id IS NULL")
  ]);
  res.json({month,summary:{...s.rows[0],unmatched_receipts:ri.rows[0].count},byCategory:bc.rows,byVendor:bv.rows})
}catch(e){next(e)}});

app.get("/api/transactions",async(req,res,next)=>{try{
  const {start,next:n}=monthBounds(req.query.month);
  const q=await pool.query(`SELECT t.id,t.transaction_date,t.posted_date,t.vendor_raw,t.vendor_normalized,t.amount,t.notes,t.status,t.captain_reviewed,
    c.id category_id,c.name category_name,cd.last4,r.id receipt_id,r.file_name,r.expires_at,r.purged_at,t.payment_method,t.payment_reference
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN cards cd ON cd.id=t.card_id LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.transaction_date >= $1::date AND t.transaction_date < $2::date ORDER BY t.transaction_date DESC,t.id DESC`,[start,n]);
  res.json({rows:q.rows})
}catch(e){next(e)}});

app.post("/api/transactions",async(req,res,next)=>{try{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[req.body];
  const card=(await pool.query("SELECT id FROM cards WHERE last4='0945' LIMIT 1")).rows[0];
  let inserted=0,skipped=0;
  for(const x of rows){
    const r={...x};
    r.transaction_date=String(r.transaction_date||r.date||"").slice(0,10);
    r.posted_date=r.posted_date?String(r.posted_date).slice(0,10):null;
    r.vendor_raw=String(r.vendor_raw||r.vendor||r.description||"").trim();
    r.amount=moneyNum(r.amount);
    r.card_last4=String(r.card_last4||r.card_no||"0945").replace(/\D/g,"").slice(-4).padStart(4,"0");
    r.payment_method=["credit_card","wire","check","cash"].includes(r.payment_method)?r.payment_method:"credit_card";
    if(!/^\d{4}-\d{2}-\d{2}$/.test(r.transaction_date)||!r.vendor_raw||r.amount===null){skipped++;continue}
    r.external_id=r.external_id||fingerprint(r);
    const rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[r.vendor_raw])).rows[0];
    const cardRow=(await pool.query("SELECT id FROM cards WHERE last4=$1 LIMIT 1",[r.card_last4])).rows[0]||card;
    try{
      await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status,payment_method,payment_reference)
        VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[r.transaction_date,r.posted_date,r.vendor_raw,r.amount,rule?.category_id||null,r.payment_method==="credit_card"?(cardRow?.id||null):null,r.source||"import",r.external_id,r.status==="pending"?"pending":"posted",r.payment_method,r.payment_reference||null]);
      inserted++
    }catch(e){if(e.code==="23505")skipped++;else throw e}
  }
  const matched=await matchAllReceipts();
  res.status(201).json({inserted,skipped,receipts_matched:matched})
}catch(e){next(e)}});

app.patch("/api/transactions/:id",async(req,res,next)=>{try{
  const id=Number(req.params.id);if(!Number.isFinite(id))return res.status(400).json({error:"Invalid transaction id"});
  const c=(await pool.query("SELECT * FROM transactions WHERE id=$1",[id])).rows[0];if(!c)return res.status(404).json({error:"Not found"});
  const b=req.body;
  const newCategory=b.category_id===undefined?c.category_id:b.category_id;
  const reviewed=b.category_id!==undefined&&b.category_id!==null?true:(b.captain_reviewed===undefined?c.captain_reviewed:b.captain_reviewed);
  const vendorName=b.vendor_normalized===undefined?(c.vendor_normalized||c.vendor_raw):b.vendor_normalized;
  const paymentMethod=b.payment_method===undefined?c.payment_method:b.payment_method;
  const paymentReference=b.payment_reference===undefined?c.payment_reference:b.payment_reference;
  await pool.query("UPDATE transactions SET category_id=$1,notes=$2,captain_reviewed=$3,vendor_normalized=$4,payment_method=$5,payment_reference=$6,updated_at=NOW() WHERE id=$7",[
    newCategory,b.notes===undefined?c.notes:b.notes,reviewed,vendorName,paymentMethod,paymentReference,id]);
  if(b.category_id!==undefined&&b.category_id!==null){
    await pool.query(`INSERT INTO vendor_rules(vendor_pattern,category_id) VALUES($1,$2)
      ON CONFLICT(vendor_pattern) DO UPDATE SET category_id=EXCLUDED.category_id,approved=true`,[vendorName,Number(b.category_id)]);
  }
  res.json({ok:true,learned_vendor_rule:b.category_id!==undefined&&b.category_id!==null})
}catch(e){next(e)}});

app.post("/api/categories",async(req,res,next)=>{try{
  const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"Category required"});
  const q=await pool.query("INSERT INTO categories(name,sort_order) VALUES($1,999) ON CONFLICT(name) DO UPDATE SET active=true RETURNING id,name,sort_order",[name]);
  res.status(201).json(q.rows[0])
}catch(e){next(e)}});

app.post("/api/vendor-rules",async(req,res,next)=>{try{
  const vendor=String(req.body.vendor_pattern||"").trim(),cid=Number(req.body.category_id);
  if(!vendor||!Number.isFinite(cid))return res.status(400).json({error:"Vendor and category required"});
  const q=await pool.query(`INSERT INTO vendor_rules(vendor_pattern,category_id) VALUES($1,$2)
    ON CONFLICT(vendor_pattern) DO UPDATE SET category_id=EXCLUDED.category_id,approved=true RETURNING id,vendor_pattern,category_id`,[vendor,cid]);
  res.status(201).json(q.rows[0])
}catch(e){next(e)}});

app.get("/api/receipt-inbox",async(_req,res,next)=>{try{
  const q=await pool.query(`SELECT r.id,r.receipt_date,r.vendor,r.amount,r.file_name,r.created_at,r.expires_at,r.purged_at,r.receipt_text,c.name category_name,c.id category_id
    FROM receipts r LEFT JOIN categories c ON c.id=r.category_id WHERE r.transaction_id IS NULL ORDER BY COALESCE(r.receipt_date,r.created_at::date) DESC,r.id DESC`);
  res.json({rows:q.rows})
}catch(e){next(e)}});

app.post("/api/receipts",upload.single("file"),async(req,res,next)=>{try{
  const f=req.file;if(!f)return res.status(400).json({error:"Receipt file required"});
  const allowed=["image/jpeg","image/png","image/webp","image/heic","image/heif","application/pdf","application/octet-stream"];
  if(!allowed.includes(f.mimetype))return res.status(415).json({error:"Use JPG, PNG, WEBP, HEIC, HEIF or PDF"});
  const sha=crypto.createHash("sha256").update(f.buffer).digest("hex");
  const existing=(await pool.query("SELECT id,transaction_id FROM receipts WHERE file_sha256=$1",[sha])).rows[0];
  if(existing)return res.status(200).json({id:existing.id,duplicate:true,transaction_id:existing.transaction_id});
  let tid=req.body.transaction_id?Number(req.body.transaction_id):null;
  const date=req.body.receipt_date||null,vendor=String(req.body.vendor||"").trim()||null,amount=moneyNum(req.body.amount),cat=req.body.category_id?Number(req.body.category_id):null,receiptText=String(req.body.receipt_text||"").trim()||null;
  const paymentMethod=["credit_card","wire","check","cash"].includes(req.body.payment_method)?req.body.payment_method:"credit_card";
  const paymentReference=String(req.body.payment_reference||"").trim()||null;
  let inferredCat=Number.isFinite(cat)?cat:null;
  if(!inferredCat){
    const txt=(receiptText||"").toLowerCase();
    let inferredName=null;
    if(/\b(diver|diving|bottom clean|underwater|hubbell|plug|cable|pump|hardware|acetone|mineral spirits|handrail|gate|repair|maintenance|part|parts)\b/i.test(txt)) inferredName="Repairs & Maintenance";
    else if(/\b(food|grocery|groceries|meal|restaurant|coffee|snack|beverage|water|provision|provisions)\b/i.test(txt)) inferredName="Provisions";
    else if(/\b(starlink|internet|wifi|directv|television|phone|cellular|communications)\b/i.test(txt)) inferredName="Communications / Internet";
    else if(/\b(dock|dockage|marina|slip|storage)\b/i.test(txt)) inferredName="Dockage / Marina";
    else if(/\b(customs|dtops|decal|port fee|entry fee)\b/i.test(txt)) inferredName="Customs / Port Fees";
    else if(/\b(office|paper|printer|ink|staple|staples|notebook)\b/i.test(txt)) inferredName="Supplies";
    else if(/\b(weather|routing|forecast|buoyweather|weatherbell)\b/i.test(txt)) inferredName="Navigation / Weather";
    if(inferredName) inferredCat=(await pool.query("SELECT id FROM categories WHERE name=$1 LIMIT 1",[inferredName])).rows[0]?.id||null;
  }
  if(!Number.isFinite(tid) && paymentMethod!=="credit_card"){
    if(!date||!vendor||amount===null)return res.status(400).json({error:"Date, vendor, and amount are required for wire, check, or cash expenses"});
    const rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[vendor])).rows[0];
    const chosenCategory=inferredCat||rule?.category_id||null;
    const ext=crypto.createHash("sha256").update([date,paymentMethod,paymentReference||"",vendor.toUpperCase(),amount.toFixed(2)].join("|")).digest("hex");
    const tr=await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,notes,source,external_id,status,payment_method,payment_reference,captain_reviewed)
      VALUES($1,$1,$2,$2,$3,$4,NULL,NULL,'manual',$5,'posted',$6,$7,$8)
      ON CONFLICT DO NOTHING RETURNING id`,[date,vendor,amount,chosenCategory,ext,paymentMethod,paymentReference,Boolean(chosenCategory)]);
    tid=tr.rows[0]?.id||((await pool.query("SELECT id FROM transactions WHERE external_id=$1 LIMIT 1",[ext])).rows[0]?.id||null);
  }
  const q=await pool.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256,receipt_text,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+INTERVAL '60 days') RETURNING id,file_name,expires_at`,[Number.isFinite(tid)?tid:null,f.originalname,f.mimetype,f.size,f.buffer,date,vendor,amount,inferredCat,sha,receiptText]);
  const matched=await autoMatchReceipt(q.rows[0].id);
  res.status(201).json({...q.rows[0],matched_transaction_id:matched})
}catch(e){next(e)}});

app.patch("/api/receipts/:id",async(req,res,next)=>{try{
  const id=Number(req.params.id),b=req.body;
  await pool.query("UPDATE receipts SET receipt_date=COALESCE($1,receipt_date),vendor=COALESCE($2,vendor),amount=COALESCE($3,amount),category_id=COALESCE($4,category_id),receipt_text=COALESCE($5,receipt_text) WHERE id=$6",[
    b.receipt_date||null,b.vendor||null,b.amount==null?null:moneyNum(b.amount),b.category_id==null?null:Number(b.category_id),b.receipt_text||null,id]);
  const matched=await autoMatchReceipt(id);res.json({ok:true,matched_transaction_id:matched})
}catch(e){next(e)}});

app.get("/api/receipts/:id",async(req,res,next)=>{try{
  const q=await pool.query("SELECT file_name,content_type,file_data,source_url,purged_at FROM receipts WHERE id=$1",[Number(req.params.id)]);const r=q.rows[0];if(!r)return res.sendStatus(404);
  if(r.purged_at)return res.status(410).send("Receipt file expired after 60 days.");
  if(r.source_url)return res.redirect(r.source_url);
  res.type(r.content_type);res.set("Content-Disposition",`inline; filename="${String(r.file_name).replaceAll('"','')}"`);res.send(r.file_data)
}catch(e){next(e)}});


app.get("/api/report",async(req,res,next)=>{try{
  const scope=["month","quarter","year"].includes(req.query.scope)?req.query.scope:"month";
  const year=Number(req.query.year)||new Date().getFullYear();
  let start,end,label;
  if(scope==="year"){start=`${year}-01-01`;end=`${year+1}-01-01`;label=String(year)}
  else if(scope==="quarter"){const q=Math.min(4,Math.max(1,Number(req.query.quarter)||1)),m=(q-1)*3;start=new Date(Date.UTC(year,m,1)).toISOString().slice(0,10);end=new Date(Date.UTC(year,m+3,1)).toISOString().slice(0,10);label=`${year} Q${q}`}
  else {const m=String(req.query.month||new Date().getMonth()+1).padStart(2,"0"),mi=Number(m);start=`${year}-${m}-01`;end=new Date(Date.UTC(year,mi,1)).toISOString().slice(0,10);label=`${year}-${m}`}
  const [summary,cats,payments,vendors]=await Promise.all([
    pool.query(`SELECT COUNT(*)::int transaction_count,COALESCE(SUM(amount),0)::numeric total FROM transactions WHERE status='posted' AND transaction_date >= $1::date AND transaction_date < $2::date`,[start,end]),
    pool.query(`SELECT COALESCE(c.name,'Uncategorized') name,SUM(t.amount)::numeric total FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date GROUP BY 1 ORDER BY total DESC`,[start,end]),
    pool.query(`SELECT payment_method name,SUM(amount)::numeric total,COUNT(*)::int count FROM transactions WHERE status='posted' AND transaction_date >= $1::date AND transaction_date < $2::date GROUP BY payment_method ORDER BY total DESC`,[start,end]),
    pool.query(`SELECT COALESCE(NULLIF(vendor_normalized,''),vendor_raw) name,SUM(amount)::numeric total,COUNT(*)::int count FROM transactions WHERE status='posted' AND transaction_date >= $1::date AND transaction_date < $2::date GROUP BY 1 ORDER BY total DESC LIMIT 25`,[start,end])
  ]);
  res.json({label,start,end,summary:summary.rows[0],byCategory:cats.rows,byPaymentMethod:payments.rows,topVendors:vendors.rows});
}catch(e){next(e)}});

app.post("/api/close-month",async(req,res,next)=>{try{
  const {month,start,next:n}=monthBounds(req.body.month);
  const q=await pool.query(`SELECT COUNT(*) FILTER(WHERE category_id IS NULL)::int uncategorized,
    COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts,COUNT(*) FILTER(WHERE captain_reviewed=false)::int unreviewed,
    COALESCE(SUM(amount),0)::numeric total FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date`,[start,n]);
  const c=q.rows[0],u=(await pool.query("SELECT COUNT(*)::int count FROM receipts WHERE transaction_id IS NULL AND receipt_date >= $1::date AND receipt_date < $2::date",[start,n])).rows[0].count;
  if(c.uncategorized||c.missing_receipts||c.unreviewed||u)return res.status(409).json({closed:false,blockers:{...c,unmatched_receipts:u}});
  await pool.query(`INSERT INTO month_closes(month_start,calculated_total,closed,closed_at) VALUES($1,$2,true,NOW())
    ON CONFLICT(month_start) DO UPDATE SET calculated_total=EXCLUDED.calculated_total,closed=true,closed_at=NOW()`,[start,Number(c.total)]);
  res.json({closed:true,month})
}catch(e){next(e)}});

app.use((err,_req,res,_next)=>{console.error(err);if(err.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"Receipt must be under 20MB"});res.status(500).json({error:"Server error"})});

await init();
app.listen(port,"0.0.0.0",()=>console.log(`Carbon Copy Accounting listening on ${port}`));