import express from "express";
import multer from "multer";
import pg from "pg";
import crypto from "crypto";

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
    CREATE UNIQUE INDEX IF NOT EXISTS receipts_sha_idx ON receipts(file_sha256) WHERE file_sha256 IS NOT NULL;
    CREATE TABLE IF NOT EXISTS vendor_rules(
      id BIGSERIAL PRIMARY KEY,vendor_pattern TEXT NOT NULL UNIQUE,category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      approved BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS month_closes(
      id BIGSERIAL PRIMARY KEY,month_start DATE NOT NULL UNIQUE,calculated_total NUMERIC(12,2),closed BOOLEAN NOT NULL DEFAULT FALSE,closed_at TIMESTAMPTZ);
  `);
  await pool.query("INSERT INTO cards(label,last4) VALUES($1,$2) ON CONFLICT(last4) DO NOTHING",["Capital One","0945"]);
  const cats=["Fuel & Lubricants","Dockage / Marina","Repairs & Maintenance","Provisions","Supplies","Insurance","Communications / Internet","Crew Travel","Crew Meals","Training / Certifications","Safety Equipment","Tender / Toys","Professional Services","Shipping / Freight","Customs / Port Fees","Guest Expenses","Transportation","Capital Improvements","Owner / Personal","Miscellaneous"];
  for(let i=0;i<cats.length;i++)await pool.query("INSERT INTO categories(name,sort_order) VALUES($1,$2) ON CONFLICT(name) DO NOTHING",[cats[i],(i+1)*10]);
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
  if(r.category_id)await pool.query("UPDATE transactions SET category_id=COALESCE(category_id,$1),updated_at=NOW() WHERE id=$2",[r.category_id,t.id]);
  return t.id;
}
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
  ]);res.json({categories:c.rows,cards:cd.rows,rules:r.rows})
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
    c.id category_id,c.name category_name,cd.last4,r.id receipt_id,r.file_name
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
    if(!/^\d{4}-\d{2}-\d{2}$/.test(r.transaction_date)||!r.vendor_raw||r.amount===null){skipped++;continue}
    r.external_id=r.external_id||fingerprint(r);
    const rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[r.vendor_raw])).rows[0];
    const cardRow=(await pool.query("SELECT id FROM cards WHERE last4=$1 LIMIT 1",[r.card_last4])).rows[0]||card;
    try{
      await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status)
        VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9)`,[r.transaction_date,r.posted_date,r.vendor_raw,r.amount,rule?.category_id||null,cardRow?.id||null,r.source||"import",r.external_id,r.status==="pending"?"pending":"posted"]);
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
  await pool.query("UPDATE transactions SET category_id=$1,notes=$2,captain_reviewed=$3,vendor_normalized=$4,updated_at=NOW() WHERE id=$5",[
    b.category_id===undefined?c.category_id:b.category_id,b.notes===undefined?c.notes:b.notes,
    b.captain_reviewed===undefined?c.captain_reviewed:b.captain_reviewed,b.vendor_normalized===undefined?c.vendor_normalized:b.vendor_normalized,id]);
  res.json({ok:true})
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
  const q=await pool.query(`SELECT r.id,r.receipt_date,r.vendor,r.amount,r.file_name,r.created_at,c.name category_name,c.id category_id
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
  const tid=req.body.transaction_id?Number(req.body.transaction_id):null;
  const date=req.body.receipt_date||null,vendor=String(req.body.vendor||"").trim()||null,amount=moneyNum(req.body.amount),cat=req.body.category_id?Number(req.body.category_id):null;
  const q=await pool.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,file_name`,[Number.isFinite(tid)?tid:null,f.originalname,f.mimetype,f.size,f.buffer,date,vendor,amount,Number.isFinite(cat)?cat:null,sha]);
  const matched=await autoMatchReceipt(q.rows[0].id);
  res.status(201).json({...q.rows[0],matched_transaction_id:matched})
}catch(e){next(e)}});

app.patch("/api/receipts/:id",async(req,res,next)=>{try{
  const id=Number(req.params.id),b=req.body;
  await pool.query("UPDATE receipts SET receipt_date=COALESCE($1,receipt_date),vendor=COALESCE($2,vendor),amount=COALESCE($3,amount),category_id=COALESCE($4,category_id) WHERE id=$5",[
    b.receipt_date||null,b.vendor||null,b.amount==null?null:moneyNum(b.amount),b.category_id==null?null:Number(b.category_id),id]);
  const matched=await autoMatchReceipt(id);res.json({ok:true,matched_transaction_id:matched})
}catch(e){next(e)}});

app.get("/api/receipts/:id",async(req,res,next)=>{try{
  const q=await pool.query("SELECT file_name,content_type,file_data,source_url FROM receipts WHERE id=$1",[Number(req.params.id)]);const r=q.rows[0];if(!r)return res.sendStatus(404);
  if(r.source_url)return res.redirect(r.source_url);
  res.type(r.content_type);res.set("Content-Disposition",`inline; filename="${String(r.file_name).replaceAll('"','')}"`);res.send(r.file_data)
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