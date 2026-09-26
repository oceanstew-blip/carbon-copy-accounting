import express from "express";
import multer from "multer";
import pg from "pg";
import crypto from "crypto";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
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


let ocrWorkerPromise=null;
async function getOcrWorker(){
  if(!ocrWorkerPromise){
    ocrWorkerPromise=(async()=>{
      const worker=await createWorker("eng");
      await worker.setParameters({
        tessedit_pageseg_mode:PSM.AUTO,
        preserve_interword_spaces:"1",
        user_defined_dpi:"300",
        load_system_dawg:"0",
        load_freq_dawg:"0"
      });
      return worker;
    })().catch((e)=>{ocrWorkerPromise=null;throw e});
  }
  return ocrWorkerPromise;
}
function isoReceiptDate(raw){
  if(!raw)return null;
  let m=String(raw).match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
  if(m)return [m[1],String(m[2]).padStart(2,"0"),String(m[3]).padStart(2,"0")].join("-");
  m=String(raw).match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2}|\d{2})\b/);
  if(!m)return null;
  let y=Number(m[3]);if(y<100)y+=2000;
  const mo=Number(m[1]),d=Number(m[2]);
  if(mo<1||mo>12||d<1||d>31)return null;
  return [y,String(mo).padStart(2,"0"),String(d).padStart(2,"0")].join("-");
}
function amountFromLine(line){
  const vals=[...String(line).matchAll(/(?:\$\s*)?(-?\d{1,6}(?:,\d{3})*\.\d{2})\b/g)]
    .map((m)=>Number(m[1].replace(/,/g,""))).filter(Number.isFinite);
  return vals.length?vals[vals.length-1]:null;
}
function suggestedCategoryFromText(text){
  const t=String(text||"").toLowerCase();
  if(/\b(diver|diving|bottom clean|underwater|zinc|hubbell|plug|cable|pump|hose|clamp|sealant|hardware|acetone|mineral spirits|handrail|gate|repair|maintenance|part|parts|engine room)\b/i.test(t))return "Repairs & Maintenance";
  if(/\b(food|grocery|groceries|meal|restaurant|cafe|coffee|snack|beverage|water|provision|provisions|market|publix|whole foods|trader joe)\b/i.test(t))return "Provisions";
  if(/\b(starlink|internet|wifi|directv|television|phone|cellular|communications)\b/i.test(t))return "Communications / Internet";
  if(/\b(dock|dockage|marina|slip|berth|yacht club|storage)\b/i.test(t))return "Dockage / Marina";
  if(/\b(customs|dtops|decal|port fee|entry fee)\b/i.test(t))return "Customs / Port Fees";
  if(/\b(office|paper|printer|ink|staples|notebook)\b/i.test(t))return "Supplies";
  if(/\b(weather|routing|forecast|buoyweather|weatherbell)\b/i.test(t))return "Navigation / Weather";
  if(/\b(uber|lyft|taxi|rideshare)\b/i.test(t))return "Transportation";
  if(/\b(fuel|diesel|gasoline|gas station|racetrac|wawa|lubricant|oil)\b/i.test(t))return "Fuel & Lubricants";
  return null;
}
function labeledAmount(lines,re){
  const matches=lines.filter((line)=>re.test(line));
  for(let i=matches.length-1;i>=0;i--){const a=amountFromLine(matches[i]);if(a!==null)return a}
  return null;
}
function parseOcrReceipt(text){
  const lines=String(text||"").split(/\r?\n/).map((x)=>x.replace(/\s+/g," ").trim()).filter(Boolean);
  const paymentText=lines.join(" ").toLowerCase();
  let detected_payment_method=null;
  if(/\b(payment|tender(?:ed)?|paid)\s*:?\s*cash\b|\bcash\s+(tendered|payment)\b/i.test(paymentText)) detected_payment_method="cash";
  else if(/\b(payment|paid)\s*:?\s*check\b|\bcheck\s*#?/i.test(paymentText)) detected_payment_method="check";
  else if(/\b(payment|paid)\s*:?\s*wire\b|\bwire\s+(transfer|payment)\b/i.test(paymentText)) detected_payment_method="wire";
  else if(/\b(visa|mastercard|amex|american express|discover|credit card|card ending|card #)\b/i.test(paymentText)) detected_payment_method="credit_card";

  let amount=labeledAmount(lines,/^(?:grand\s+total|total|amount\s+due|balance\s+due)\b/i);
  if(amount===null)amount=labeledAmount(lines,/\b(grand\s+total|amount\s+due|balance\s+due|total)\b/i);
  const subtotal=labeledAmount(lines,/^subtotal\b/i);
  const tax=labeledAmount(lines,/^(?:sales\s+)?tax\b/i);
  const total_verified=amount!==null&&subtotal!==null&&tax!==null&&Math.abs((subtotal+tax)-amount)<0.08;

  let receipt_date=null;
  for(const line of lines){receipt_date=isoReceiptDate(line);if(receipt_date)break}

  const reject=/\b(receipt|invoice|thank you|welcome|www\.|http|tel\b|phone\b|date\b|time\b|cashier\b|register\b|transaction\b|order\b|subtotal\b|total\b|tax\b|visa\b|mastercard\b|amex\b|payment\b|cash\b|change\b)\b/i;
  const vendor=lines.slice(0,10).find((line)=>
    line.length>=3&&line.length<=70&&!reject.test(line)&&
    !/^\W*[\d\s#()+.\/-]+\W*$/.test(line)&&
    !/^\d+\s+\w+\s+(st|street|ave|avenue|rd|road|blvd|drive|dr|hwy|highway)\b/i.test(line)
  )||null;

  return {
    vendor,receipt_date,amount,subtotal,tax,total_verified,
    receipt_text:lines.join("\n"),
    suggested_category:suggestedCategoryFromText(text),
    detected_payment_method
  };
}
function mergeOcrFields(full,top,bottom,confidence){
  const merged={
    vendor:top.vendor||full.vendor||null,
    receipt_date:full.receipt_date||top.receipt_date||bottom.receipt_date||null,
    amount:bottom.amount??full.amount??null,
    subtotal:bottom.subtotal??full.subtotal??null,
    tax:bottom.tax??full.tax??null,
    total_verified:Boolean(bottom.total_verified||full.total_verified),
    receipt_text:full.receipt_text||"",
    suggested_category:full.suggested_category||bottom.suggested_category||top.suggested_category||null,
    detected_payment_method:bottom.detected_payment_method||full.detected_payment_method||null,
    confidence:Math.round(Number(confidence)||0)
  };
  const reasons=[];
  if(!merged.vendor)reasons.push("vendor");
  if(!merged.receipt_date)reasons.push("date");
  if(merged.amount===null)reasons.push("total");
  if(!merged.detected_payment_method)reasons.push("payment method");
  if(!merged.suggested_category)reasons.push("category");
  if(merged.amount!==null&&!merged.total_verified&&merged.subtotal!==null&&merged.tax!==null)reasons.push("total arithmetic");
  let score=0;
  if(merged.vendor)score++;
  if(merged.receipt_date)score++;
  if(merged.amount!==null)score++;
  if(merged.detected_payment_method)score++;
  if(merged.suggested_category)score++;
  merged.field_score=score;
  merged.review_reasons=reasons;
  return merged;
}
async function ocrImage(buffer){
  const base=await sharp(buffer,{failOn:"none"})
    .rotate()
    .resize({width:2400,height:3200,fit:"inside",withoutEnlargement:true})
    .grayscale()
    .normalize()
    .sharpen()
    .extend({top:30,bottom:30,left:30,right:30,background:"white"})
    .png()
    .toBuffer();

  const meta=await sharp(base).metadata();
  const width=meta.width,height=meta.height;
  const topHeight=Math.max(1,Math.round(height*0.34));
  const bottomTop=Math.max(0,Math.round(height*0.45));
  const bottomHeight=Math.max(1,height-bottomTop);
  const topCrop=await sharp(base).extract({left:0,top:0,width,height:topHeight}).png().toBuffer();
  const bottomCrop=await sharp(base).extract({left:0,top:bottomTop,width,height:bottomHeight}).threshold(180).png().toBuffer();

  const worker=await getOcrWorker();
  await worker.setParameters({tessedit_pageseg_mode:PSM.AUTO,preserve_interword_spaces:"1"});
  const fullResult=await worker.recognize(base);
  await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK,preserve_interword_spaces:"1"});
  const topResult=await worker.recognize(topCrop);
  await worker.setParameters({tessedit_pageseg_mode:PSM.SPARSE_TEXT,preserve_interword_spaces:"1"});
  const bottomResult=await worker.recognize(bottomCrop);
  await worker.setParameters({tessedit_pageseg_mode:PSM.AUTO,preserve_interword_spaces:"1"});

  const full=parseOcrReceipt(fullResult?.data?.text||"");
  const top=parseOcrReceipt(topResult?.data?.text||"");
  const bottom=parseOcrReceipt(bottomResult?.data?.text||"");
  return mergeOcrFields(full,top,bottom,fullResult?.data?.confidence);
}
async function combineReceiptImages(files){
  if(!files?.length)throw new Error("No receipt images");
  if(files.length===1)return {buffer:files[0].buffer,content_type:files[0].mimetype,file_name:files[0].originalname};
  if(files.some((f)=>f.mimetype==="application/pdf"))throw Object.assign(new Error("Multi-image receipt bundles must be images, not PDFs"),{statusCode:422});
  const normalized=[];
  let maxWidth=0,totalHeight=0;
  for(const f of files){
    const buf=await sharp(f.buffer,{failOn:"none"}).rotate().resize({width:1800,fit:"inside",withoutEnlargement:true}).png().toBuffer();
    const m=await sharp(buf).metadata();
    normalized.push({buf,width:m.width,height:m.height});
    maxWidth=Math.max(maxWidth,m.width||0);
  }
  const gap=24;
  totalHeight=normalized.reduce((sum,x)=>sum+(x.height||0),0)+gap*(normalized.length-1);
  let top=0;
  const composite=[];
  for(const x of normalized){
    composite.push({input:x.buf,left:Math.round((maxWidth-x.width)/2),top});
    top+=(x.height||0)+gap;
  }
  const buffer=await sharp({create:{width:maxWidth,height:totalHeight,channels:3,background:"white"}}).composite(composite).png().toBuffer();
  return {buffer,content_type:"image/png",file_name:`receipt-bundle-${files.length}-images.png`};
}
function mergeReceiptPages(pages){
  const fullText=pages.map((p,i)=>`--- PAGE ${i+1} ---\n${p.receipt_text||""}`).join("\n");
  const vendor=pages.find((p)=>p.vendor)?.vendor||null;
  const receipt_date=pages.find((p)=>p.receipt_date)?.receipt_date||null;
  const amount=[...pages].reverse().find((p)=>p.amount!==null&&p.amount!==undefined)?.amount??null;
  const detected_payment_method=[...pages].reverse().find((p)=>p.detected_payment_method)?.detected_payment_method||null;
  const suggested_category=suggestedCategoryFromText(fullText);
  const subtotal=[...pages].reverse().find((p)=>p.subtotal!==null&&p.subtotal!==undefined)?.subtotal??null;
  const tax=[...pages].reverse().find((p)=>p.tax!==null&&p.tax!==undefined)?.tax??null;
  const total_verified=pages.some((p)=>p.total_verified);
  const confidence=Math.round(pages.reduce((sum,p)=>sum+(Number(p.confidence)||0),0)/Math.max(1,pages.length));
  return mergeOcrFields(
    {vendor,receipt_date,amount,subtotal,tax,total_verified,receipt_text:fullText,suggested_category,detected_payment_method},
    {vendor,receipt_date},
    {amount,subtotal,tax,total_verified,suggested_category,detected_payment_method},
    confidence
  );
}

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
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_method TEXT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_reference TEXT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ocr_confidence INT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ocr_field_score INT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ocr_review_reasons TEXT;
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
  if(!r||r.transaction_id||r.amount==null||!r.receipt_date||r.payment_method&&r.payment_method!=="credit_card")return null;
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


app.get("/api/ocr/status",(_req,res)=>res.json({enabled:true,mode:"server-side",engine:"tesseract",formats:["JPG","PNG","WEBP","HEIC","HEIF"],manual_fallback:true}));

app.get("/api/ocr/self-test",async(_req,res,next)=>{try{
  const svg=Buffer.from(`<svg width="1200" height="700" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="80" y="130" font-family="Arial" font-size="58" fill="black">HARBOR MARINE SUPPLY</text>
    <text x="80" y="240" font-family="Arial" font-size="48" fill="black">09/26/2026</text>
    <text x="80" y="350" font-family="Arial" font-size="42" fill="black">Bilge pump hose and stainless clamps</text>
    <text x="80" y="470" font-family="Arial" font-size="54" fill="black">TOTAL $87.46</text>
  </svg>`);
  const png=await sharp(svg).png().toBuffer();
  const data=await ocrImage(png);
  const vendorOk=/HARBOR|MARINE|SUPPLY/i.test(data.vendor||data.receipt_text||"");
  const amountOk=Math.abs(Number(data.amount)-87.46)<0.02;
  const dateOk=data.receipt_date==="2026-09-26";
  const categoryOk=data.suggested_category==="Repairs & Maintenance";
  const ok=vendorOk&&amountOk&&dateOk&&categoryOk;
  res.status(ok?200:503).json({ok,vendor_ok:vendorOk,amount_ok:amountOk,date_ok:dateOk,category_ok:categoryOk,confidence:data.confidence,parsed:{vendor:data.vendor,receipt_date:data.receipt_date,amount:data.amount,suggested_category:data.suggested_category}});
}catch(e){next(e)}});


app.post("/api/ocr",upload.any(),async(req,res,next)=>{try{
  const files=req.files||[];if(!files.length)return res.status(400).json({error:"Receipt image required"});
  if(files.some((f)=>f.mimetype==="application/pdf")){
    if(files.length>1)return res.status(422).json({error:"Multi-page bundles currently support image photos only. Upload PDF receipts one at a time."});
    return res.status(422).json({error:"PDF OCR is not enabled yet. You can still enter the receipt fields manually."});
  }
  const allowed=["image/jpeg","image/png","image/webp","image/heic","image/heif","application/octet-stream"];
  if(files.some((f)=>!allowed.includes(f.mimetype)))return res.status(415).json({error:"OCR supports JPG, PNG, WEBP, HEIC and HEIF images"});
  const pages=[];
  for(const f of files)pages.push(await ocrImage(f.buffer));
  const data=pages.length===1?pages[0]:mergeReceiptPages(pages);
  res.json({...data,page_count:files.length});
}catch(e){next(e)}});


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
    pool.query(`SELECT COUNT(*)::int transactions,COALESCE(SUM(t.amount),0)::numeric total_spend,
      COUNT(*) FILTER(WHERE t.category_id IS NULL)::int needs_category,
      COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts,
      COUNT(*) FILTER(WHERE t.captain_reviewed=false)::int needs_review
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
  const q=await pool.query(`SELECT r.id,r.receipt_date,r.vendor,r.amount,r.file_name,r.created_at,r.expires_at,r.purged_at,r.receipt_text,r.payment_method,r.payment_reference,
      r.review_required,r.ocr_confidence,r.ocr_field_score,r.ocr_review_reasons,c.name category_name,c.id category_id,
      CASE WHEN r.review_required OR r.payment_method IS NULL OR r.payment_method <> 'credit_card' THEN 'review' ELSE 'waiting' END bucket
    FROM receipts r LEFT JOIN categories c ON c.id=r.category_id WHERE r.transaction_id IS NULL ORDER BY COALESCE(r.receipt_date,r.created_at::date) DESC,r.id DESC`);
  res.json({rows:q.rows})
}catch(e){next(e)}});

app.post("/api/receipts",upload.any(),async(req,res,next)=>{try{
  const files=req.files||[];if(!files.length)return res.status(400).json({error:"Receipt file required"});
  const allowed=["image/jpeg","image/png","image/webp","image/heic","image/heif","application/pdf","application/octet-stream"];
  if(files.some((f)=>!allowed.includes(f.mimetype)))return res.status(415).json({error:"Use JPG, PNG, WEBP, HEIC, HEIF or PDF"});
  const combined=await combineReceiptImages(files);
  const f={buffer:combined.buffer,mimetype:combined.content_type,originalname:combined.file_name,size:combined.buffer.length};
  const sha=crypto.createHash("sha256").update(f.buffer).digest("hex");
  let tid=req.body.transaction_id?Number(req.body.transaction_id):null;
  const date=req.body.receipt_date||null,vendor=String(req.body.vendor||"").trim()||null,amount=moneyNum(req.body.amount),cat=req.body.category_id?Number(req.body.category_id):null,receiptText=String(req.body.receipt_text||"").trim()||null;
  const paymentMethod=["credit_card","wire","check","cash"].includes(req.body.payment_method)?req.body.payment_method:null;
  if(!paymentMethod)return res.status(400).json({error:"Confirm the payment method before saving this receipt"});
  const paymentReference=String(req.body.payment_reference||"").trim()||null;
  const existing=(await pool.query("SELECT * FROM receipts WHERE file_sha256=$1",[sha])).rows[0];
  if(existing){
    if(!existing.transaction_id && paymentMethod!=="credit_card"){
      const useDate=date||existing.receipt_date,useVendor=vendor||existing.vendor,useAmount=amount??(existing.amount==null?null:Number(existing.amount));
      if(useDate&&useVendor&&useAmount!==null){
        const chosenCategory=Number.isFinite(cat)?cat:(existing.category_id||null);
        const ext=crypto.createHash("sha256").update([useDate,paymentMethod,paymentReference||"",String(useVendor).toUpperCase(),Number(useAmount).toFixed(2)].join("|")).digest("hex");
        const tr=await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status,payment_method,payment_reference,captain_reviewed)
          VALUES($1,$1,$2,$2,$3,$4,NULL,'manual',$5,'posted',$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[useDate,useVendor,useAmount,chosenCategory,ext,paymentMethod,paymentReference,Boolean(chosenCategory)]);
        const newTid=tr.rows[0]?.id||((await pool.query("SELECT id FROM transactions WHERE external_id=$1 LIMIT 1",[ext])).rows[0]?.id||null);
        if(newTid){
          await pool.query("UPDATE receipts SET transaction_id=$1,receipt_date=COALESCE(receipt_date,$2),vendor=COALESCE(vendor,$3),amount=COALESCE(amount,$4),category_id=COALESCE(category_id,$5),receipt_text=COALESCE(receipt_text,$6),review_required=false WHERE id=$7",[newTid,useDate,useVendor,useAmount,chosenCategory,receiptText,existing.id]);
          return res.status(200).json({id:existing.id,duplicate:true,promoted:true,created_transaction_id:newTid,payment_method:paymentMethod});
        }
      }
    }
    return res.status(200).json({id:existing.id,duplicate:true,transaction_id:existing.transaction_id,payment_method:paymentMethod});
  }
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
  const q=await pool.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256,receipt_text,expires_at,payment_method,payment_reference,review_required)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+INTERVAL '60 days',$12,$13,false) RETURNING id,file_name,expires_at`,[Number.isFinite(tid)?tid:null,f.originalname,f.mimetype,f.size,f.buffer,date,vendor,amount,inferredCat,sha,receiptText,paymentMethod,paymentReference]);
  const matched=paymentMethod==="credit_card"?await autoMatchReceipt(q.rows[0].id):null;
  res.status(201).json({...q.rows[0],matched_transaction_id:matched,created_transaction_id:Number.isFinite(tid)?tid:null,payment_method:paymentMethod})
}catch(e){next(e)}});

app.patch("/api/receipts/:id",async(req,res,next)=>{try{
  const id=Number(req.params.id),b=req.body;
  if(!Number.isFinite(id))return res.status(400).json({error:"Invalid receipt id"});
  const current=(await pool.query("SELECT * FROM receipts WHERE id=$1",[id])).rows[0];
  if(!current)return res.status(404).json({error:"Receipt not found"});

  const date=b.receipt_date===undefined?current.receipt_date:b.receipt_date||null;
  const vendor=b.vendor===undefined?current.vendor:String(b.vendor||"").trim()||null;
  const amount=b.amount===undefined?(current.amount==null?null:Number(current.amount)):moneyNum(b.amount);
  const categoryId=b.category_id===undefined?current.category_id:(b.category_id?Number(b.category_id):null);
  const receiptText=b.receipt_text===undefined?current.receipt_text:String(b.receipt_text||"").trim()||null;
  const paymentMethod=b.payment_method===undefined?current.payment_method:(["credit_card","wire","check","cash"].includes(b.payment_method)?b.payment_method:null);
  const paymentReference=b.payment_reference===undefined?current.payment_reference:String(b.payment_reference||"").trim()||null;
  if(!paymentMethod)return res.status(400).json({error:"Confirm the payment method before saving"});

  await pool.query(`UPDATE receipts SET receipt_date=$1,vendor=$2,amount=$3,category_id=$4,receipt_text=$5,payment_method=$6,payment_reference=$7,review_required=false WHERE id=$8`,
    [date,vendor,amount,categoryId,receiptText,paymentMethod,paymentReference,id]);

  let createdTransactionId=null,matched=null;
  if(!current.transaction_id && paymentMethod!=="credit_card"){
    if(!date||!vendor||amount===null)return res.status(400).json({error:"Date, vendor, and amount are required for cash, check, or wire"});
    const rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[vendor])).rows[0];
    const chosenCategory=categoryId||rule?.category_id||null;
    const ext=crypto.createHash("sha256").update(["receipt-correction",id,String(date).slice(0,10),paymentMethod,paymentReference||"",vendor.toUpperCase(),Number(amount).toFixed(2)].join("|")).digest("hex");
    const tr=await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status,payment_method,payment_reference,captain_reviewed)
      VALUES($1,$1,$2,$2,$3,$4,NULL,'receipt-correction',$5,'posted',$6,$7,$8)
      ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
      [date,vendor,amount,chosenCategory,ext,paymentMethod,paymentReference,Boolean(chosenCategory)]);
    createdTransactionId=tr.rows[0]?.id||((await pool.query("SELECT id FROM transactions WHERE external_id=$1 LIMIT 1",[ext])).rows[0]?.id||null);
    if(createdTransactionId)await pool.query("UPDATE receipts SET transaction_id=$1,category_id=COALESCE(category_id,$2) WHERE id=$3",[createdTransactionId,chosenCategory,id]);
  }else if(!current.transaction_id && paymentMethod==="credit_card"){
    matched=await autoMatchReceipt(id);
  }
  res.json({ok:true,created_transaction_id:createdTransactionId,matched_transaction_id:matched,payment_method:paymentMethod});
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
  const q=await pool.query(`SELECT COUNT(*) FILTER(WHERE t.category_id IS NULL)::int uncategorized,
    COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts,COUNT(*) FILTER(WHERE t.captain_reviewed=false)::int unreviewed,
    COALESCE(SUM(t.amount),0)::numeric total FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date`,[start,n]);
  const c=q.rows[0],u=(await pool.query("SELECT COUNT(*)::int count FROM receipts WHERE transaction_id IS NULL AND receipt_date >= $1::date AND receipt_date < $2::date",[start,n])).rows[0].count;
  if(c.uncategorized||c.missing_receipts||c.unreviewed||u)return res.status(409).json({closed:false,blockers:{...c,unmatched_receipts:u}});
  await pool.query(`INSERT INTO month_closes(month_start,calculated_total,closed,closed_at) VALUES($1,$2,true,NOW())
    ON CONFLICT(month_start) DO UPDATE SET calculated_total=EXCLUDED.calculated_total,closed=true,closed_at=NOW()`,[start,Number(c.total)]);
  res.json({closed:true,month})
}catch(e){next(e)}});

app.use((err,_req,res,_next)=>{console.error(err);if(err.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"Receipt must be under 20MB per image"});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});res.status(500).json({error:"Server error"})});

await init();
app.listen(port,"0.0.0.0",()=>console.log(`Carbon Copy Accounting listening on ${port}`));