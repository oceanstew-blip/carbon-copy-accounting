import express from "express";
import multer from "multer";
import pg from "pg";
import crypto from "crypto";
import sharp from "sharp";
import { withVision, visionRead, visionEnabled, visionEngine } from "./vision.js";
import { promises as fsp } from "fs";
import { ocrRaw, interpretRaw, combineRaws, groupLoosePhotos, pdfToImages, toReadable, isHeic, getOcrWorker, isoReceiptDate, amountFromLine, detectPaymentMethodFromText, suggestedCategoryFromText, labeledAmount, parseOcrReceipt, mergeOcrFields, chooseBestAmount, ocrImage } from "./ocr.js";
import { AwsClient } from "aws4fetch";
import ExcelJS from "exceljs";
import zlib from "zlib";
import { readFileSync } from "node:fs";
import { capitalOneCsv, initialRules, driveReceipts } from "./seed.js";
// One config file per boat; everything vessel-specific reads from here.
const V=JSON.parse(readFileSync(new URL("./vessel.config.json",import.meta.url),"utf8"));

const {Pool}=pg;
const app=express();
app.set("trust proxy",1);
const port=process.env.PORT||3000;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024}});

const SESSION_MAX_AGE_MS=90*24*60*60*1000;
function sessionSecret(){return process.env.SESSION_SECRET||process.env.APP_PASSWORD||`${V.slug}-dev-secret`}
function signSession(username){
  const expires=Date.now()+SESSION_MAX_AGE_MS;
  const payload=`${username}.${expires}`;
  const sig=crypto.createHmac("sha256",sessionSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifySession(token,expectedUser){
  if(!token)return false;
  const parts=String(token).split(".");
  if(parts.length!==3)return false;
  const [username,expires,sig]=parts;
  const expected=crypto.createHmac("sha256",sessionSecret()).update(`${username}.${expires}`).digest("hex");
  if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;
  if(Date.now()>Number(expires))return false;
  return username===expectedUser;
}
function parseCookies(req){
  const out={};
  for(const part of String(req.headers.cookie||"").split(";")){
    const i=part.indexOf("=");if(i<0)continue;
    out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function loginPage({error}={}){
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${V.appName} — Sign in</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=Fraunces:opsz,wght@9..144,600&display=swap');
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      font-family:'IBM Plex Sans',ui-sans-serif,sans-serif;
      background:linear-gradient(125deg,#061e30 0%,#0c3450 30%,#1b5a82 62%,#2f7fac 88%,#4ba0c9 100%);}
    .card{width:100%;max-width:380px;background:#fff;border:1.5px solid #c7d4d8;padding:36px 32px;margin:20px}
    .yacht{width:100%;height:120px;overflow:hidden;border:2px solid #0c3450;margin-bottom:20px}
    .yacht img{width:100%;height:100%;object-fit:cover;object-position:center 42%;display:block}
    .eyebrow{font:600 11px/1 'IBM Plex Mono',monospace;letter-spacing:.24em;color:#5c7278;margin-bottom:6px}
    h1{margin:0 0 24px;font-family:'Fraunces',serif;font-size:28px;font-weight:600;color:#16333c}
    label{display:block;font:600 11px 'IBM Plex Mono',monospace;letter-spacing:.08em;text-transform:uppercase;color:#5c7278;margin-bottom:6px}
    input{width:100%;border:1.5px solid #c7d4d8;padding:11px 12px;font:15px 'IBM Plex Sans',sans-serif;margin-bottom:16px;color:#16333c}
    input:focus{outline:2px solid #2f7fac;outline-offset:1px}
    button{width:100%;background:#1b5a82;border:none;color:#fff;font:700 13px 'IBM Plex Mono',monospace;letter-spacing:.06em;text-transform:uppercase;padding:14px;cursor:pointer}
    button:hover{background:#0c3450}
    .error{background:#fbe6e4;border:1px solid #e2a8a4;color:#b3312c;padding:10px 12px;font-size:13px;margin-bottom:16px}
  </style></head><body>
  <form class="card" method="post" action="/login">
    <div class="yacht"><img src="/assets/yacht.jpg" alt="${V.vesselName}"></div>
    <div class="eyebrow">${V.vesselName.toUpperCase()}</div>
    <h1>Accounting</h1>
    ${error?`<div class="error">${error}</div>`:""}
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
  </body></html>`;
}
function auth(req,res,next){
  const user=process.env.APP_USERNAME,pass=process.env.APP_PASSWORD;
  if(!user||!pass)return next();
  if(req.path==="/login"||req.path.startsWith("/assets/")||req.path.startsWith("/.well-known/"))return next();
  const cookies=parseCookies(req);
  if(verifySession(cookies.ccc_session,user))return next();
  // Basic Auth still works for API clients/scripts (e.g. the test suite) that
  // don't want the cookie-session login flow built for the browser UI.
  const h=req.headers.authorization||"";
  if(h.startsWith("Basic ")){
    const [u,p]=Buffer.from(h.slice(6),"base64").toString().split(":");
    if(u===user&&p===pass)return next();
  }
  if(req.method==="GET"&&(req.headers.accept||"").includes("text/html"))return res.redirect("/login");
  res.status(401).json({error:"Login required"});
}
app.use(auth);
app.use(express.urlencoded({extended:false}));
app.get("/login",(_req,res)=>res.type("html").send(loginPage()));
app.post("/login",(req,res)=>{
  const user=process.env.APP_USERNAME,pass=process.env.APP_PASSWORD;
  const {username,password}=req.body||{};
  // Username isn't a secret, so tolerate the phone-keyboard auto-capitalized
  // first letter that broke the captain's own login attempt (2026-09-27).
  // Password stays case-sensitive.
  if(String(username||"").toLowerCase()!==String(user).toLowerCase()||password!==pass)return res.status(401).type("html").send(loginPage({error:"Incorrect username or password."}));
  const token=signSession(user);
  res.cookie("ccc_session",token,{httpOnly:true,secure:req.secure,sameSite:"lax",maxAge:SESSION_MAX_AGE_MS});
  res.redirect("/");
});
app.get("/logout",(req,res)=>{
  res.clearCookie("ccc_session",{httpOnly:true,secure:req.secure,sameSite:"lax"});
  res.redirect("/login");
});
app.use(express.json({limit:"8mb"}));
app.get("/api/vessel",(q,r)=>r.json(V));
app.use(express.static("public"));





function safeFilePart(value){
  return String(value||"Receipt").replace(/[^a-z0-9 .&_-]+/gi,"").replace(/\s+/g," ").trim().slice(0,80)||"Receipt";
}
function receiptFileName(vendor,date,amount,mime,original){
  const ext=mime==="application/pdf"?".pdf":mime==="image/png"?".png":mime==="image/webp"?".webp":mime==="image/heic"?".heic":mime==="image/heif"?".heif":".jpg";
  const vendorPart=safeFilePart(vendor);
  let datePart="undated";
  if(date){
    const d=date instanceof Date?date:new Date(date);
    if(!Number.isNaN(d.getTime())) datePart=d.toISOString().slice(0,10);
    else datePart=String(date).slice(0,10);
  }
  const amountPart=amount!==null&&amount!==undefined&&Number.isFinite(Number(amount))?" - $"+Number(amount).toFixed(2):"";
  return safeFilePart(vendorPart+" - "+datePart+amountPart)+ext;
}








async function combineReceiptImages(files){
  if(!files?.length)throw new Error("No receipt images");
  if(files.length===1){
    const f=files[0];
    if(isHeic(f.buffer))return {buffer:await toReadable(f.buffer),content_type:"image/jpeg",file_name:String(f.originalname).replace(/\.hei[cf]$/i,"")+".jpg"};
    return {buffer:f.buffer,content_type:f.mimetype,file_name:f.originalname};
  }
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

function monthBounds(month){
  const m=/^\d{4}-\d{2}$/.test(month||"")?month:new Date().toISOString().slice(0,7);
  const [y,mo]=m.split("-").map(Number);
  return{month:m,start:m+"-01",next:new Date(Date.UTC(y,mo,1)).toISOString().slice(0,10)}
}
function moneyNum(v){const n=Number(v);return Number.isFinite(n)?Math.round(n*100)/100:null}
async function audit(actor,action,entityType,entityId,oldData,newData,{reason,source}={}){
  await pool.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,old_data,new_data,reason,source)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[actor,action,entityType,String(entityId),oldData?JSON.stringify(oldData):null,newData?JSON.stringify(newData):null,reason||null,source||null]);
}
async function assertMonthOpen(dateVal){
  // pg returns DATE columns as JS Date objects, not strings — normalize first.
  const iso=dateVal instanceof Date?dateVal.toISOString():String(dateVal);
  const monthStart=iso.slice(0,7)+"-01";
  const closed=(await pool.query("SELECT closed FROM month_closes WHERE month_start=$1",[monthStart])).rows[0]?.closed;
  if(closed){const e=new Error(`${iso.slice(0,7)} is closed. Reopen the month before making this change.`);e.statusCode=409;throw e}
}
// Owner approval on this boat happens before the captain makes the purchase, not
// after it posts — so a large transaction isn't an open decision, it's a record
// of a decision already made. Threshold defaults to $1,000 (captain-set 9/27)
// and marks straight to "approved" rather than "needed" so it doesn't sit on the
// dashboard or alert digest as something still awaiting a decision.
async function approvalStatusFor(amount){
  const row=(await pool.query("SELECT value FROM settings WHERE key='owner_approval_threshold'")).rows[0];
  // No row at all -> default $1,000. A row with value=null is the PUT endpoint's
  // documented way to disable the threshold entirely -- must stay null, not
  // collapse to Number(null)===0 (which would flag every non-zero charge).
  const threshold=row?row.value===null?null:Number(row.value):1000;
  return threshold!==null&&Number.isFinite(threshold)&&Math.abs(Number(amount))>threshold?"approved":"not_required";
}
// High-frequency vendors (Amazon, Publix, etc.) legitimately post more than one
// same-day, same-amount charge — two Amazon orders that both round to $24.99,
// two identical Publix provisioning runs. Fingerprint matching alone can't tell
// that apart from a real double-charge, so these vendors are exempt from the
// suspected-duplicate flag. Captain-editable via settings key
// 'duplicate_exempt_vendors' (JSON array of substrings, case-insensitive).
async function duplicateExemptVendorPatterns(){
  const row=(await pool.query("SELECT value FROM settings WHERE key='duplicate_exempt_vendors'")).rows[0];
  const list=row?row.value:["AMAZON","PUBLIX"];
  return (Array.isArray(list)?list:[]).map(s=>String(s).trim().toUpperCase()).filter(Boolean);
}
function fingerprint(r){
  return crypto.createHash("sha256").update([
    r.transaction_date||"",r.posted_date||"",String(r.card_last4||V.cardLast4).padStart(4,"0"),
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
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ocr_guess JSONB;
    CREATE TABLE IF NOT EXISTS receipt_pages(
      id BIGSERIAL PRIMARY KEY,receipt_id BIGINT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,page_no INT NOT NULL,
      file_name TEXT NOT NULL,file_sha256 TEXT NOT NULL,file_data BYTEA NOT NULL,raw JSONB,UNIQUE(receipt_id,page_no));
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS match_method TEXT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS match_score INT;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS matched_by TEXT;
    ALTER TABLE receipts ALTER COLUMN file_data DROP NOT NULL;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'credit_card';
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_reference TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS receipts_sha_idx ON receipts(file_sha256) WHERE file_sha256 IS NOT NULL;
    CREATE TABLE IF NOT EXISTS vendor_rules(
      id BIGSERIAL PRIMARY KEY,vendor_pattern TEXT NOT NULL UNIQUE,category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      approved BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS month_closes(
      id BIGSERIAL PRIMARY KEY,month_start DATE NOT NULL UNIQUE,calculated_total NUMERIC(12,2),closed BOOLEAN NOT NULL DEFAULT FALSE,closed_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS import_batches(
      id BIGSERIAL PRIMARY KEY,card_id BIGINT REFERENCES cards(id) ON DELETE SET NULL,source_filename TEXT,
      file_hash TEXT UNIQUE,uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),statement_start DATE,statement_end DATE,
      row_count INT,imported_by TEXT NOT NULL DEFAULT 'captain');
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS beginning_balance NUMERIC(12,2);
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS ending_balance NUMERIC(12,2);
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS reconciled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_batch_id BIGINT REFERENCES import_batches(id) ON DELETE SET NULL;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_row_number INT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS duplicate_status TEXT NOT NULL DEFAULT 'none' CHECK(duplicate_status IN('none','suspected'));
    CREATE TABLE IF NOT EXISTS audit_log(
      id BIGSERIAL PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor TEXT NOT NULL CHECK(actor IN('captain','system')),action TEXT NOT NULL,
      entity_type TEXT NOT NULL,entity_id TEXT,old_data JSONB,new_data JSONB,reason TEXT,source TEXT);
    CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type,entity_id);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value JSONB);
    CREATE TABLE IF NOT EXISTS petty_cash_periods(
      month_start DATE PRIMARY KEY,beginning_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      replenishments NUMERIC(12,2) NOT NULL DEFAULT 0,counted_balance NUMERIC(12,2),
      counted_at TIMESTAMPTZ,notes TEXT);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'not_required'
      CHECK(approval_status IN('not_required','needed','approved','declined','emergency_approved'));
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS approval_date TIMESTAMPTZ;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS approval_note TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS approved_by TEXT;
  `);
  await pool.query("INSERT INTO cards(label,last4) VALUES($1,$2) ON CONFLICT(last4) DO NOTHING",[V.cardLabel,V.cardLast4]);
  const cats=["Fuel & Lubricants","Dockage / Marina","Repairs & Maintenance","Provisions","Supplies","Insurance","Communications / Internet","Crew Travel","Crew Meals","Training / Certifications","Safety Equipment","Tender / Toys","Professional Services","Shipping / Freight","Customs / Port Fees","Guest Expenses","Transportation","Capital Improvements","Owner / Personal","Navigation / Weather","Miscellaneous"];
  for(let i=0;i<cats.length;i++)await pool.query("INSERT INTO categories(name,sort_order) VALUES($1,$2) ON CONFLICT(name) DO NOTHING",[cats[i],(i+1)*10]);
  // ponytail: seedInitialData() (imports seed.js's historical CSV/receipts, and
  // reclassifies existing uncategorized transactions) and purgeExpiredReceipts()
  // used to run here unconditionally on every startup/deploy, mutating live
  // accounting data every time the server restarted. Both are one-time/explicit
  // operations now — run `node server.js --seed-once` or
  // `node server.js --purge-expired`, not automatically.
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
      // vendor-rule match is system classification, not captain review (Priority 7)
      await pool.query(`UPDATE transactions SET category_id=$1,updated_at=NOW()
        WHERE category_id IS NULL AND vendor_raw ILIKE '%'||$2||'%'`,[c.id,pattern]);
    }
  }
  const lines=capitalOneCsv.replace(/\r/g,"").split("\n").filter(Boolean),headers=parseCsvLine(lines[0]).map(x=>x.toLowerCase().replace(/\./g,"").trim());
  const ix=n=>headers.findIndex(h=>h===n),card=(await pool.query("SELECT id FROM cards WHERE last4=$1 LIMIT 1",[V.cardLast4])).rows[0];
  for(const line of lines.slice(1)){
    const c=parseCsvLine(line),debit=Number(c[ix("debit")]||NaN),credit=Number(c[ix("credit")]||NaN);
    const amount=Number.isFinite(debit)&&debit!==0?Math.abs(debit):Number.isFinite(credit)&&credit!==0?-Math.abs(credit):null;
    const row={transaction_date:csvDate(c[ix("transaction date")]),posted_date:csvDate(c[ix("posted date")]),vendor_raw:c[ix("description")]||"",amount,card_last4:String(c[ix("card no")]||V.cardLast4).padStart(4,"0")};
    if(!row.transaction_date||!row.vendor_raw||row.amount===null)continue;
    const ext=fingerprint(row),rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[row.vendor_raw])).rows[0];
    // ponytail: deliberately not setting approval_status here — this seeds old
    // historical statement data (--seed-once only), and retroactively flagging
    // months-old already-processed charges as "needs owner approval" would just
    // be noise, not a real pending decision.
    await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status)
      VALUES($1,$2,$3,$3,$4,$5,$6,'capital-one-csv',$7,'posted') ON CONFLICT DO NOTHING`,
      [row.transaction_date,row.posted_date,row.vendor_raw,row.amount,rule?.category_id||null,card?.id||null,ext]);
  }
  for(const r of driveReceipts){
    const c=(await pool.query("SELECT id FROM categories WHERE name=$1",[r.category])).rows[0];
    const existing=(await pool.query("SELECT id FROM receipts WHERE source_url=$1",[r.url])).rows[0];if(existing)continue;
    const q=await pool.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256,source_url)
      VALUES(NULL,$1,'application/pdf',0,NULL,$2,$3,$4,$5,NULL,$6) RETURNING id`,[r.file_name,r.date,r.vendor,r.amount,c?.id||null,r.url]);
    await autoMatchReceipt(q.rows[0].id);
  }
}
function vendorSimilar(a,b){
  a=String(a||"").trim().toUpperCase();b=String(b||"").trim().toUpperCase();
  if(!a||!b)return false;
  return a.includes(b)||b.includes(a);
}
// Candidate transactions for a receipt, scored (not just amount+date). Never
// auto-links on amount+date alone if more than one transaction is plausible —
// that's how the wrong receipt gets attached to the wrong charge.
async function receiptMatchCandidates(r){
  const q=await pool.query(`
    SELECT t.id,t.transaction_date,t.posted_date,t.vendor_raw,t.amount,cd.last4,
      ABS(t.transaction_date-$2::date) day_gap
    FROM transactions t
    LEFT JOIN receipts rr ON rr.transaction_id=t.id
    LEFT JOIN cards cd ON cd.id=t.card_id
    WHERE rr.id IS NULL AND t.status='posted'
      AND ABS(t.amount-$1::numeric) < 0.02
      AND t.transaction_date BETWEEN $2::date-INTERVAL '4 days' AND $2::date+INTERVAL '4 days'
    ORDER BY t.transaction_date,t.id LIMIT 8`,[r.amount,r.receipt_date]);
  return q.rows.map(t=>{
    const vendorMatch=vendorSimilar(r.vendor,t.vendor_raw);
    const score=(vendorMatch?60:0)+Math.max(0,30-t.day_gap*10)+(t.day_gap===0?10:0);
    return {...t,vendor_match:vendorMatch,score};
  }).sort((a,b)=>b.score-a.score);
}
async function autoMatchReceipt(receiptId){
  const r=(await pool.query("SELECT * FROM receipts WHERE id=$1",[receiptId])).rows[0];
  if(!r||r.transaction_id||r.amount==null||!r.receipt_date||r.payment_method&&r.payment_method!=="credit_card")return null;
  const candidates=await receiptMatchCandidates(r);
  if(!candidates.length)return null;
  const [best,second]=candidates;
  // Strong match: clearly better than the runner-up, and has real signal behind
  // it (same day, or vendor text actually matches) — not just "closest amount".
  const strong=best.score>=60&&(!second||best.score-second.score>=20);
  if(!strong)return null;
  const method=best.vendor_match?"amount+date+vendor":"amount+date";
  await pool.query("UPDATE receipts SET transaction_id=$1,match_method=$2,match_score=$3,matched_at=NOW(),matched_by='system' WHERE id=$4",[best.id,method,best.score,r.id]);
  // system match: copy the receipt's category over if useful, but this is not
  // the captain reviewing the transaction — captain_reviewed stays untouched.
  if(r.category_id)await pool.query("UPDATE transactions SET category_id=COALESCE(category_id,$1),updated_at=NOW() WHERE id=$2",[r.category_id,best.id]);
  await audit("system","auto_match","receipt",r.id,{transaction_id:null},{transaction_id:best.id,match_method:method,match_score:best.score},{source:"autoMatchReceipt"});
  return best.id;
}
async function purgeExpiredReceipts(){
  await pool.query(`UPDATE receipts SET file_data=NULL,source_url=NULL,purged_at=NOW()
    WHERE purged_at IS NULL AND expires_at IS NOT NULL AND expires_at <= NOW()`);
}
// ponytail: no more automatic 24h purge loop — financial support documents
// should not disappear on their own. Run scripts/purge-expired-receipts.js
// by hand if a document-retention policy is ever agreed with the accountant.

async function matchAllReceipts(){
  const q=await pool.query("SELECT id FROM receipts WHERE transaction_id IS NULL AND amount IS NOT NULL AND receipt_date IS NOT NULL");
  let matched=0;for(const row of q.rows)if(await autoMatchReceipt(row.id))matched++;return matched
}

app.get("/health",(_req,res)=>res.json({ok:true}));


app.get("/api/ocr/status",(_req,res)=>res.json({enabled:true,mode:"server-side",engine:"tesseract",formats:["JPG","PNG","WEBP","HEIC","HEIF"],manual_fallback:true,second_reader:visionEngine()}));

app.get("/api/ocr/self-test",async(_req,res,next)=>{try{
  // ponytail: this used to render its own SVG-with-text at request time, which
  // depends on the host having a matching font installed — worked on macOS,
  // silently produced blank/garbled text on Railway's container. Using a PNG
  // fixture rendered once (on a machine with real fonts) removes that host
  // dependency entirely.
  const png=await fsp.readFile(new URL("./tests/fixtures/ocr-self-test-receipt.png",import.meta.url));
  const data=await ocrImage(png);
  const vendorOk=/HARBOR|MARINE|SUPPLY/i.test(data.vendor||data.receipt_text||"");
  const amountOk=Math.abs(Number(data.amount)-87.46)<0.02;
  const dateOk=data.receipt_date==="2026-09-26";
  const categoryOk=data.suggested_category==="Repairs & Maintenance";
  const ok=vendorOk&&amountOk&&dateOk&&categoryOk;
  res.status(ok?200:503).json({ok,vendor_ok:vendorOk,amount_ok:amountOk,date_ok:dateOk,category_ok:categoryOk,confidence:data.confidence,parsed:{vendor:data.vendor,receipt_date:data.receipt_date,amount:data.amount,suggested_category:data.suggested_category},raw_ocr_text:data.receipt_text});
}catch(e){next(e)}});


app.post("/api/ocr",upload.any(),async(req,res,next)=>{try{
  const files=req.files||[];if(!files.length)return res.status(400).json({error:"Receipt image required"});
  if(files.some((f)=>f.mimetype==="application/pdf")){
    if(files.length>1)return res.status(422).json({error:"Upload a PDF receipt on its own, or several photos together."});
    const {images}=pdfToImages(files[0].buffer);const raws=[];
    for(const img of images)raws.push(await ocrRaw(img));
    return res.json({...await withVision(interpretRaw(raws.length===1?raws[0]:combineRaws(raws)),images,{original:files[0].buffer}),page_count:images.length});
  }
  const allowed=["image/jpeg","image/png","image/webp","image/heic","image/heif","application/octet-stream"];
  if(files.some((f)=>!allowed.includes(f.mimetype)))return res.status(415).json({error:"OCR supports JPG, PNG, WEBP, HEIC and HEIF images"});
  const raws=[];
  for(const f of files)raws.push(await ocrRaw(f.buffer));
  const data=await withVision(interpretRaw(raws.length===1?raws[0]:combineRaws(raws)),await Promise.all(files.map((f)=>toReadable(f.buffer))));
  res.json({...data,page_count:files.length});
}catch(e){next(e)}});


app.get("/api/bootstrap",async(_req,res,next)=>{try{
  const [c,cd,r,threshold,mf,ae]=await Promise.all([
    pool.query("SELECT id,name,sort_order FROM categories WHERE active=true ORDER BY sort_order,name"),
    pool.query("SELECT id,label,last4 FROM cards WHERE active=true ORDER BY id"),
    pool.query("SELECT vr.id,vr.vendor_pattern,vr.category_id,c.name category_name FROM vendor_rules vr JOIN categories c ON c.id=vr.category_id ORDER BY vr.vendor_pattern"),
    pool.query("SELECT value FROM settings WHERE key='owner_approval_threshold'"),
    pool.query("SELECT value FROM settings WHERE key='mail_from'"),
    pool.query("SELECT value FROM settings WHERE key='alert_email_to'")
  ]);
  res.json({categories:c.rows,cards:cd.rows,rules:r.rows,payment_methods:["credit_card","wire","check","cash"],owner_approval_threshold:threshold.rows[0]?Number(threshold.rows[0].value):null,mail_from:mf.rows[0]?.value??null,alert_email_to:ae.rows[0]?.value??null})
}catch(e){next(e)}});

app.put("/api/settings/owner-approval-threshold",async(req,res,next)=>{try{
  const value=req.body.value===null?null:Number(req.body.value);
  if(value!==null&&!(Number.isFinite(value)&&value>=0))return res.status(400).json({error:"Threshold must be a non-negative number or null to disable"});
  const before=(await pool.query("SELECT value FROM settings WHERE key='owner_approval_threshold'")).rows[0]?.value??null;
  await pool.query(`INSERT INTO settings(key,value) VALUES('owner_approval_threshold',$1::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[JSON.stringify(value)]);
  await audit("captain","update","setting","owner_approval_threshold",{value:before},{value},{source:"PUT /api/settings/owner-approval-threshold"});
  res.json({owner_approval_threshold:value});
}catch(e){next(e)}});

// Lets the client point sends/alerts at their own address (e.g. a Captain's
// own domain instead of the vessel's default) without a code deploy. Each
// address must resolve to something that actually looks like an email --
// either bare ("x@y.com") or "Name <x@y.com>" -- so a typo doesn't silently
// become the new value the monitor/alert crons send to.
function extractEmailAddress(s){
  const m=String(s).match(/<([^>]+)>/);
  return (m?m[1]:String(s)).trim();
}
function isValidEmailValue(s){
  return typeof s==="string"&&s.trim().length>0&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extractEmailAddress(s));
}
app.put("/api/settings/mail",async(req,res,next)=>{try{
  const {mail_from,alert_email_to}=req.body;
  if(mail_from===undefined&&alert_email_to===undefined)return res.status(400).json({error:"Provide mail_from and/or alert_email_to"});
  const updates={};
  if(mail_from!==undefined){
    if(mail_from!==null&&!isValidEmailValue(mail_from))return res.status(400).json({error:"mail_from must be a valid email, e.g. 'Vessel Accounting <alerts@yourdomain.com>'"});
    updates.mail_from=mail_from;
  }
  if(alert_email_to!==undefined){
    if(alert_email_to!==null&&!isValidEmailValue(alert_email_to))return res.status(400).json({error:"alert_email_to must be a valid email address"});
    updates.alert_email_to=alert_email_to;
  }
  const result={};
  for(const [key,value] of Object.entries(updates)){
    const before=(await pool.query("SELECT value FROM settings WHERE key=$1",[key])).rows[0]?.value??null;
    await pool.query(`INSERT INTO settings(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[key,JSON.stringify(value)]);
    await audit("captain","update","setting",key,{value:before},{value},{source:"PUT /api/settings/mail"});
    result[key]=value;
  }
  res.json(result);
}catch(e){next(e)}});

app.get("/api/dashboard",async(req,res,next)=>{try{
  const {month,start,next:n}=monthBounds(req.query.month);
  const [s,bc,bv,ri]=await Promise.all([
    pool.query(`SELECT COUNT(*)::int transactions,COALESCE(SUM(t.amount),0)::numeric total_spend,
      COUNT(*) FILTER(WHERE t.category_id IS NULL)::int needs_category,
      COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts,
      COUNT(*) FILTER(WHERE t.captain_reviewed=false)::int needs_review,
      COUNT(*) FILTER(WHERE t.duplicate_status='suspected')::int suspected_duplicates,
      COUNT(*) FILTER(WHERE t.approval_status='needed')::int owner_approval_needed
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
    c.id category_id,c.name category_name,cd.last4,r.id receipt_id,r.file_name,r.expires_at,r.purged_at,t.payment_method,t.payment_reference,t.duplicate_status,
    t.approval_status,t.approval_date,t.approval_note,t.approved_by
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN cards cd ON cd.id=t.card_id LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.transaction_date >= $1::date AND t.transaction_date < $2::date ORDER BY t.transaction_date DESC,t.id DESC`,[start,n]);
  res.json({rows:q.rows})
}catch(e){next(e)}});

app.post("/api/transactions",async(req,res,next)=>{try{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[req.body];
  const card=(await pool.query("SELECT id FROM cards WHERE last4=$1 LIMIT 1",[V.cardLast4])).rows[0];

  // Whole-file re-upload safety: if the client sends a hash of the source file,
  // re-uploading the exact same statement is a safe no-op instead of relying on
  // per-row fingerprint collisions (which can't tell "same file again" apart
  // from "two legitimately identical charges" — see below).
  let batchId=null;
  if(req.body.file_hash){
    const existing=(await pool.query("SELECT id,row_count FROM import_batches WHERE file_hash=$1",[req.body.file_hash])).rows[0];
    if(existing){
      return res.status(201).json({inserted:0,skipped:rows.length,suspected_duplicates:0,receipts_matched:0,duplicate_import:true,batch_id:existing.id});
    }
    const dates=rows.map(r=>String(r.transaction_date||r.date||"").slice(0,10)).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const batch=await pool.query(`INSERT INTO import_batches(card_id,source_filename,file_hash,statement_start,statement_end,row_count)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[card?.id||null,req.body.source_filename||null,req.body.file_hash,dates[0]||null,dates[dates.length-1]||null,rows.length]);
    batchId=batch.rows[0].id;
  }

  const exemptVendors=await duplicateExemptVendorPatterns();
  let inserted=0,skipped=0,suspected=0,blockedClosedMonth=0;
  for(let i=0;i<rows.length;i++){
    const x=rows[i];
    const r={...x};
    r.transaction_date=String(r.transaction_date||r.date||"").slice(0,10);
    r.posted_date=r.posted_date?String(r.posted_date).slice(0,10):null;
    r.vendor_raw=String(r.vendor_raw||r.vendor||r.description||"").trim();
    r.amount=moneyNum(r.amount);
    r.card_last4=String(r.card_last4||r.card_no||V.cardLast4).replace(/\D/g,"").slice(-4).padStart(4,"0");
    r.payment_method=["credit_card","wire","check","cash"].includes(r.payment_method)?r.payment_method:"credit_card";
    if(!/^\d{4}-\d{2}-\d{2}$/.test(r.transaction_date)||!r.vendor_raw||r.amount===null){skipped++;continue}
    if((await pool.query("SELECT closed FROM month_closes WHERE month_start=$1",[r.transaction_date.slice(0,7)+"-01"])).rows[0]?.closed){blockedClosedMonth++;continue}
    const clientSuppliedId=Boolean(r.external_id);
    const fp=fingerprint(r);
    const rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[r.vendor_raw])).rows[0];
    const cardRow=(await pool.query("SELECT id FROM cards WHERE last4=$1 LIMIT 1",[r.card_last4])).rows[0]||card;
    const approvalStatus=await approvalStatusFor(r.amount);
    const insertArgs=(extId,dupStatus)=>[r.transaction_date,r.posted_date,r.vendor_raw,r.amount,rule?.category_id||null,r.payment_method==="credit_card"?(cardRow?.id||null):null,r.source||"import",extId,r.status==="pending"?"pending":"posted",r.payment_method,r.payment_reference||null,batchId,i,dupStatus,approvalStatus];
    const insertSql=`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status,payment_method,payment_reference,import_batch_id,source_row_number,duplicate_status,approval_status)
        VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;
    if(clientSuppliedId){
      // A stable id from the client (e.g. a bank transaction id) means we can tell
      // for certain this is the same source row, not just a similar-looking one.
      try{
        await pool.query(insertSql,insertArgs(r.external_id,"none"));
        inserted++
      }catch(e){if(e.code==="23505")skipped++;else throw e}
      continue;
    }
    // No stable id: a fingerprint match is ambiguous — could be a genuine
    // re-import, or two legitimately identical charges (same vendor/amount/day).
    // Never drop it silently; insert it flagged for review instead.
    const already=(await pool.query("SELECT COUNT(*)::int c FROM transactions WHERE external_id LIKE $1",[fp+"%"])).rows[0].c;
    const exempt=exemptVendors.some((v)=>r.vendor_raw.toUpperCase().includes(v));
    const extId=already?`${fp}#${already}`:fp;
    await pool.query(insertSql,insertArgs(extId,already&&!exempt?"suspected":"none"));
    inserted++;
    if(already&&!exempt)suspected++;
  }
  const matched=await matchAllReceipts();
  res.status(201).json({inserted,skipped,suspected_duplicates:suspected,blocked_closed_month:blockedClosedMonth,receipts_matched:matched,batch_id:batchId})
}catch(e){next(e)}});

app.patch("/api/transactions/:id",async(req,res,next)=>{try{
  const id=Number(req.params.id);if(!Number.isFinite(id))return res.status(400).json({error:"Invalid transaction id"});
  const c=(await pool.query("SELECT * FROM transactions WHERE id=$1",[id])).rows[0];if(!c)return res.status(404).json({error:"Not found"});
  await assertMonthOpen(c.transaction_date);
  const b=req.body;
  const newCategory=b.category_id===undefined?c.category_id:b.category_id;
  const reviewed=b.category_id!==undefined&&b.category_id!==null?true:(b.captain_reviewed===undefined?c.captain_reviewed:b.captain_reviewed);
  const vendorName=b.vendor_normalized===undefined?(c.vendor_normalized||c.vendor_raw):b.vendor_normalized;
  const paymentMethod=b.payment_method===undefined?c.payment_method:b.payment_method;
  const paymentReference=b.payment_reference===undefined?c.payment_reference:b.payment_reference;
  const duplicateStatus=b.duplicate_status==="none"?"none":c.duplicate_status;
  const validApprovalStatuses=["not_required","needed","approved","declined","emergency_approved"];
  const approvalStatus=validApprovalStatuses.includes(b.approval_status)?b.approval_status:c.approval_status;
  const approvalChanged=approvalStatus!==c.approval_status;
  const approvalDate=approvalChanged&&["approved","declined","emergency_approved"].includes(approvalStatus)?new Date():c.approval_date;
  const approvalNote=b.approval_note===undefined?c.approval_note:b.approval_note;
  const approvedBy=approvalChanged&&["approved","declined","emergency_approved"].includes(approvalStatus)?"captain":c.approved_by;
  await pool.query("UPDATE transactions SET category_id=$1,notes=$2,captain_reviewed=$3,vendor_normalized=$4,payment_method=$5,payment_reference=$6,duplicate_status=$7,approval_status=$8,approval_date=$9,approval_note=$10,approved_by=$11,updated_at=NOW() WHERE id=$12",[
    newCategory,b.notes===undefined?c.notes:b.notes,reviewed,vendorName,paymentMethod,paymentReference,duplicateStatus,approvalStatus,approvalDate,approvalNote,approvedBy,id]);
  if(b.category_id!==undefined&&b.category_id!==null){
    await pool.query(`INSERT INTO vendor_rules(vendor_pattern,category_id) VALUES($1,$2)
      ON CONFLICT(vendor_pattern) DO UPDATE SET category_id=EXCLUDED.category_id,approved=true`,[vendorName,Number(b.category_id)]);
  }
  await audit("captain","update","transaction",id,
    {category_id:c.category_id,notes:c.notes,captain_reviewed:c.captain_reviewed,vendor_normalized:c.vendor_normalized,payment_method:c.payment_method,payment_reference:c.payment_reference,duplicate_status:c.duplicate_status,approval_status:c.approval_status},
    {category_id:newCategory,notes:b.notes===undefined?c.notes:b.notes,captain_reviewed:reviewed,vendor_normalized:vendorName,payment_method:paymentMethod,payment_reference:paymentReference,duplicate_status:duplicateStatus,approval_status:approvalStatus,approval_note:approvalNote},
    {source:"PATCH /api/transactions/:id"});
  res.json({ok:true,learned_vendor_rule:b.category_id!==undefined&&b.category_id!==null})
}catch(e){next(e)}});

app.post("/api/categories",async(req,res,next)=>{try{
  const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"Category required"});
  const q=await pool.query("INSERT INTO categories(name,sort_order) VALUES($1,999) ON CONFLICT(name) DO UPDATE SET active=true RETURNING id,name,sort_order",[name]);
  await audit("captain","create","category",q.rows[0].id,null,q.rows[0],{source:"POST /api/categories"});
  res.status(201).json(q.rows[0])
}catch(e){next(e)}});

app.patch("/api/categories/:id",async(req,res,next)=>{try{
  const id=Number(req.params.id),name=String(req.body.name||"").trim();
  if(!Number.isFinite(id)||!name)return res.status(400).json({error:"Category and name required"});
  const exists=(await pool.query("SELECT id FROM categories WHERE id=$1 AND active=true",[id])).rows[0];
  if(!exists)return res.status(404).json({error:"Category not found"});
  const dup=(await pool.query("SELECT id FROM categories WHERE lower(name)=lower($1) AND id<>$2",[name,id])).rows[0];
  if(dup)return res.status(409).json({error:"A category with that name already exists"});
  const before=(await pool.query("SELECT name FROM categories WHERE id=$1",[id])).rows[0];
  const q=await pool.query("UPDATE categories SET name=$1 WHERE id=$2 RETURNING id,name,sort_order",[name,id]);
  await audit("captain","rename","category",id,before,q.rows[0],{source:"PATCH /api/categories/:id"});
  res.json(q.rows[0]);
}catch(e){next(e)}});

app.delete("/api/categories/:id",async(req,res,next)=>{try{
  const id=Number(req.params.id),replacement=Number(req.body?.replacement_category_id);
  if(!Number.isFinite(id))return res.status(400).json({error:"Invalid category"});
  const current=(await pool.query("SELECT id,name FROM categories WHERE id=$1 AND active=true",[id])).rows[0];
  if(!current)return res.status(404).json({error:"Category not found"});

  const [tx,rc,vr]=await Promise.all([
    pool.query("SELECT COUNT(*)::int count FROM transactions WHERE category_id=$1",[id]),
    pool.query("SELECT COUNT(*)::int count FROM receipts WHERE category_id=$1",[id]),
    pool.query("SELECT COUNT(*)::int count FROM vendor_rules WHERE category_id=$1",[id])
  ]);
  const usage={
    transactions:tx.rows[0].count,
    receipts:rc.rows[0].count,
    vendor_rules:vr.rows[0].count
  };
  const total=usage.transactions+usage.receipts+usage.vendor_rules;

  if(total>0&&!Number.isFinite(replacement)){
    return res.status(409).json({error:"Category is in use",usage});
  }
  if(Number.isFinite(replacement)){
    if(replacement===id)return res.status(400).json({error:"Choose a different replacement category"});
    const target=(await pool.query("SELECT id,name FROM categories WHERE id=$1 AND active=true",[replacement])).rows[0];
    if(!target)return res.status(400).json({error:"Replacement category not found"});
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("UPDATE transactions SET category_id=$1 WHERE category_id=$2",[replacement,id]);
      await client.query("UPDATE receipts SET category_id=$1 WHERE category_id=$2",[replacement,id]);
      await client.query("UPDATE vendor_rules SET category_id=$1 WHERE category_id=$2",[replacement,id]);
      await client.query("UPDATE categories SET active=false WHERE id=$1",[id]);
      await client.query("COMMIT");
    }catch(e){await client.query("ROLLBACK");throw e}
    finally{client.release()}
    await audit("captain","delete","category",id,current,{reassigned_to:replacement,usage},{source:"DELETE /api/categories/:id"});
    return res.json({ok:true,deleted_id:id,reassigned_to:replacement,usage});
  }

  await pool.query("UPDATE categories SET active=false WHERE id=$1",[id]);
  await audit("captain","delete","category",id,current,{usage},{source:"DELETE /api/categories/:id"});
  res.json({ok:true,deleted_id:id,usage});
}catch(e){next(e)}});


app.post("/api/vendor-rules",async(req,res,next)=>{try{
  const vendor=String(req.body.vendor_pattern||"").trim(),cid=Number(req.body.category_id);
  if(!vendor||!Number.isFinite(cid))return res.status(400).json({error:"Vendor and category required"});
  const before=(await pool.query("SELECT id,vendor_pattern,category_id FROM vendor_rules WHERE vendor_pattern=$1",[vendor])).rows[0]||null;
  const q=await pool.query(`INSERT INTO vendor_rules(vendor_pattern,category_id) VALUES($1,$2)
    ON CONFLICT(vendor_pattern) DO UPDATE SET category_id=EXCLUDED.category_id,approved=true RETURNING id,vendor_pattern,category_id`,[vendor,cid]);
  await audit("captain",before?"update":"create","vendor_rule",q.rows[0].id,before,q.rows[0],{source:"POST /api/vendor-rules"});
  res.status(201).json(q.rows[0])
}catch(e){next(e)}});

async function repairOrphanNonCardReceipts(){
  const rows=(await pool.query(`SELECT * FROM receipts
    WHERE transaction_id IS NULL
      AND payment_method IN ('cash','check','wire')
      AND receipt_date IS NOT NULL
      AND vendor IS NOT NULL
      AND amount IS NOT NULL
    ORDER BY id`)).rows;
  let repaired=0;
  for(const r of rows){
    const ext=crypto.createHash("sha256").update(["receipt-auto-repair",r.id,String(r.receipt_date).slice(0,10),r.payment_method,String(r.vendor).toUpperCase(),Number(r.amount).toFixed(2)].join("|")).digest("hex");
    const tr=await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status,payment_method,payment_reference,captain_reviewed,approval_status)
      VALUES($1,$1,$2,$2,$3,$4,NULL,'receipt-auto-repair',$5,'posted',$6,$7,$8,$9)
      ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,[
        r.receipt_date,r.vendor,Number(r.amount),r.category_id||null,ext,r.payment_method,r.payment_reference||null,false,await approvalStatusFor(r.amount)
      ]);
    const tid=tr.rows[0]?.id||((await pool.query("SELECT id FROM transactions WHERE external_id=$1 LIMIT 1",[ext])).rows[0]?.id||null);
    if(tid){
      await pool.query("UPDATE receipts SET transaction_id=$1,review_required=false WHERE id=$2",[tid,r.id]);
      repaired++;
    }
  }
  return repaired;
}

// ponytail: repair used to also run unconditionally here on every startup/deploy,
// mutating live transactions on every restart. It already runs per-request below
// (the only place it needs to), so the startup call was pure redundant risk.

app.get("/api/receipt-inbox",async(_req,res,next)=>{try{
  await repairOrphanNonCardReceipts();
  const q=await pool.query(`SELECT r.id,r.receipt_date,r.vendor,r.amount,r.file_name,r.created_at,r.expires_at,r.purged_at,r.receipt_text,r.payment_method,r.payment_reference,
      r.review_required,r.ocr_confidence,r.ocr_field_score,r.ocr_review_reasons,c.name category_name,c.id category_id,(SELECT COUNT(*)::int FROM receipt_pages p WHERE p.receipt_id=r.id) page_count,
      CASE WHEN r.payment_method = 'credit_card' THEN 'waiting' ELSE 'review' END bucket
    FROM receipts r LEFT JOIN categories c ON c.id=r.category_id WHERE r.transaction_id IS NULL ORDER BY COALESCE(r.receipt_date,r.created_at::date) DESC,r.id DESC`);
  res.json({rows:q.rows})
}catch(e){next(e)}});

app.get("/api/ocr/corrections",async(_req,res,next)=>{try{
  const q=await pool.query(`SELECT r.id,r.file_name,r.receipt_date,r.vendor,r.amount,r.payment_method,c.name category,r.ocr_guess
    FROM receipts r LEFT JOIN categories c ON c.id=r.category_id WHERE r.ocr_guess IS NOT NULL ORDER BY r.id DESC LIMIT 500`);
  const norm=(x)=>String(x||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  const rows=q.rows.map((r)=>{const g=r.ocr_guess,d=r.receipt_date?new Date(r.receipt_date).toISOString().slice(0,10):null;
    const changed=[];
    if(norm(g.vendor)!==norm(r.vendor))changed.push("vendor");
    if((g.date||null)!==d)changed.push("date");
    if(Number(g.amount)!==Number(r.amount))changed.push("total");
    if((g.payment||null)!==(r.payment_method||null))changed.push("payment");
    return {id:r.id,file_name:r.file_name,guess:g,final:{vendor:r.vendor,date:d,total:r.amount===null?null:Number(r.amount),payment:r.payment_method,category:r.category},changed};});
  const n=rows.length,fields=["vendor","date","total","payment"];
  res.json({receipts:n,corrected:Object.fromEntries(fields.map((f)=>[f,rows.filter((r)=>r.changed.includes(f)).length])),rows});
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
  f.originalname=receiptFileName(vendor,date,amount,f.mimetype,f.originalname);
  const submittedPayment=["credit_card","wire","check","cash"].includes(req.body.payment_method)?req.body.payment_method:null;
  const receiptDetectedPayment=detectPaymentMethodFromText(receiptText);
  const paymentMethod=(receiptDetectedPayment&&receiptDetectedPayment!=="credit_card")?receiptDetectedPayment:submittedPayment;
  if(!paymentMethod)return res.status(400).json({error:"Confirm the payment method before saving this receipt"});
  const paymentReference=String(req.body.payment_reference||"").trim()||null;
  const existing=(await pool.query("SELECT * FROM receipts WHERE file_sha256=$1",[sha])).rows[0];
  if(existing){
    if(!existing.transaction_id && paymentMethod!=="credit_card"){
      const useDate=date||existing.receipt_date,useVendor=vendor||existing.vendor,useAmount=amount??(existing.amount==null?null:Number(existing.amount));
      if(useDate&&useVendor&&useAmount!==null){
        const chosenCategory=Number.isFinite(cat)?cat:(existing.category_id||null);
        const ext=crypto.createHash("sha256").update([useDate,paymentMethod,paymentReference||"",String(useVendor).toUpperCase(),Number(useAmount).toFixed(2)].join("|")).digest("hex");
        const tr=await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status,payment_method,payment_reference,captain_reviewed,approval_status)
          VALUES($1,$1,$2,$2,$3,$4,NULL,'manual',$5,'posted',$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,[useDate,useVendor,useAmount,chosenCategory,ext,paymentMethod,paymentReference,Number.isFinite(cat),await approvalStatusFor(useAmount)]);
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
    await assertMonthOpen(date);
    const rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[vendor])).rows[0];
    const chosenCategory=inferredCat||rule?.category_id||null;
    const ext=crypto.createHash("sha256").update([date,paymentMethod,paymentReference||"",vendor.toUpperCase(),amount.toFixed(2)].join("|")).digest("hex");
    const tr=await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,notes,source,external_id,status,payment_method,payment_reference,captain_reviewed,approval_status)
      VALUES($1,$1,$2,$2,$3,$4,NULL,NULL,'manual',$5,'posted',$6,$7,$8,$9)
      ON CONFLICT DO NOTHING RETURNING id`,[date,vendor,amount,chosenCategory,ext,paymentMethod,paymentReference,Number.isFinite(cat),await approvalStatusFor(amount)]);
    // pg returns BIGINT ids as strings; without Number() the isFinite checks below failed, the receipt was saved
    // unlinked, and the orphan-repair later created a SECOND transaction for the same expense.
    const newTid=tr.rows[0]?.id||((await pool.query("SELECT id FROM transactions WHERE external_id=$1 LIMIT 1",[ext])).rows[0]?.id||null);
    tid=newTid==null?null:Number(newTid);
  }
  // what the reader guessed, kept beside what the captain saved, so corrections can be measured
  let ocrGuess=null;try{ocrGuess=req.body.ocr_guess?JSON.stringify(JSON.parse(req.body.ocr_guess)):null}catch{}
  const q=await pool.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256,receipt_text,expires_at,payment_method,payment_reference,review_required,ocr_guess)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+INTERVAL '60 days',$12,$13,false,$14) RETURNING id,file_name,expires_at`,[Number.isFinite(tid)?tid:null,f.originalname,f.mimetype,f.size,f.buffer,date,vendor,amount,inferredCat,sha,receiptText,paymentMethod,paymentReference,ocrGuess]);
  const matched=paymentMethod==="credit_card"?await autoMatchReceipt(q.rows[0].id):null;
  res.status(201).json({...q.rows[0],matched_transaction_id:matched,created_transaction_id:Number.isFinite(tid)?tid:null,payment_method:paymentMethod})
}catch(e){next(e)}});

app.post("/api/receipts/:id/ocr",async(req,res,next)=>{try{
  const id=Number(req.params.id);
  if(!Number.isFinite(id))return res.status(400).json({error:"Invalid receipt id"});
  const r=(await pool.query("SELECT file_name,content_type,file_data,purged_at FROM receipts WHERE id=$1",[id])).rows[0];
  if(!r)return res.status(404).json({error:"Receipt not found"});
  if(r.purged_at||!r.file_data)return res.status(410).json({error:"Receipt image is no longer available"});
  if(r.content_type==="application/pdf"){
    const {images}=pdfToImages(r.file_data);const raws=[];
    for(const img of images)raws.push(await ocrRaw(img));
    return res.json(await withVision(interpretRaw(raws.length===1?raws[0]:combineRaws(raws)),images,{original:r.file_data}));
  }
  if(!String(r.content_type||"").startsWith("image/")&&!/heic|heif|octet-stream/i.test(String(r.content_type||"")))return res.status(415).json({error:"This receipt type cannot be re-read automatically"});
  const out=await withVision(await ocrImage(r.file_data),[r.file_data]);
  res.json(out);
}catch(e){next(e)}});

// Read-only accuracy check on receipts the captain already filed: does each reader agree with what is saved?
// Spends one vision/Azure call per receipt (max 50). Saved values may themselves have been accepted without a close look.
app.get("/api/ocr/compare",async(req,res,next)=>{try{
  if(!visionEnabled())return res.status(412).json({error:"No second reader configured (set AZURE_DI_ENDPOINT + AZURE_DI_KEY, or ANTHROPIC_API_KEY)"});
  const limit=Math.min(50,Math.max(1,Number(req.query.limit)||20));
  const rows=(await pool.query(`SELECT id,content_type,file_data,receipt_date,vendor,amount FROM receipts
    WHERE transaction_id IS NOT NULL AND file_data IS NOT NULL AND purged_at IS NULL AND amount IS NOT NULL ORDER BY id DESC LIMIT $1`,[limit])).rows;
  const norm=(x)=>String(x||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const same={total:(a,b)=>a!=null&&b!=null&&Math.abs(Number(a)-Number(b))<0.01,
    date:(a,b)=>!!a&&!!b&&String(a).slice(0,10)===String(b).slice(0,10),
    vendor:(a,b)=>{const x=norm(a),y=norm(b);return x.length>2&&y.length>2&&(x.includes(y)||y.includes(x))}};
  const score={tesseract:{total:0,date:0,vendor:0},second:{total:0,date:0,vendor:0}},out=[];
  for(const r of rows){
    const saved={vendor:r.vendor,date:r.receipt_date&&new Date(r.receipt_date).toISOString().slice(0,10),total:Number(r.amount)};
    let t=null,v=null,err=null;
    try{
      let imgs=[r.file_data],original=null;
      if(r.content_type==="application/pdf"){imgs=pdfToImages(r.file_data).images;original=r.file_data}
      const raws=[];for(const i of imgs)raws.push(await ocrRaw(i));
      t=interpretRaw(raws.length===1?raws[0]:combineRaws(raws));
      v=await visionRead(imgs,{original});
      await new Promise((r)=>setTimeout(r,visionEngine()==="azure-document-intelligence"?3500:0)); // stay under the free-tier rate limit
    }catch(e){err=e.message}
    const row={id:r.id,saved,tesseract:t&&{vendor:t.vendor,date:t.receipt_date,total:t.amount},second:v&&{vendor:v.vendor,date:v.receipt_date,total:v.amount},error:err};
    for(const k of ["total","date","vendor"]){
      if(t&&same[k](saved[k],row.tesseract[k]))score.tesseract[k]++;
      if(v&&same[k](saved[k],row.second[k]))score.second[k]++;
    }
    out.push(row);
  }
  res.json({engine:visionEngine(),receipts:rows.length,correct:score,rows:out});
}catch(e){next(e)}});

// Read-only: cash/check/wire expenses that exist twice because of the unlinked-receipt bug (an unlinked 'manual' copy
// plus the 'receipt-auto-repair' copy attached to the receipt). Lists them; removes nothing.
app.get("/admin/twin-transactions",async(_req,res,next)=>{try{
  const q=await pool.query(`SELECT m.id orphan_id,a.id linked_id,m.transaction_date,m.vendor_raw,m.amount,m.payment_method,
      COALESCE((SELECT closed FROM month_closes c WHERE c.month_start=date_trunc('month',m.transaction_date)::date),false) month_closed
    FROM transactions m JOIN transactions a ON a.source='receipt-auto-repair' AND m.source='manual'
      AND m.transaction_date=a.transaction_date AND lower(m.vendor_raw)=lower(a.vendor_raw) AND m.amount=a.amount AND m.payment_method=a.payment_method
    WHERE NOT EXISTS(SELECT 1 FROM receipts r WHERE r.transaction_id=m.id) ORDER BY m.transaction_date`);
  res.json({count:q.rows.length,overcounted_total:q.rows.reduce((n,r)=>n+Number(r.amount),0),rows:q.rows});
}catch(e){next(e)}});

// ---- Remove test/sample receipts (preview first, then confirm) ----
// Nothing is deleted from a GET. Closed months are never touched. A receipt created from a manual (cash/check/wire)
// entry takes its transaction with it; a receipt matched to an imported card charge is removed alone.
const escHtml=(x)=>String(x??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function parseIds(q){return[...new Set(String(q||"").split(",").map(Number).filter((n)=>Number.isInteger(n)&&n>0))].slice(0,10)}
async function planTestRemoval(ids){
  const out=[];
  for(const id of ids){
    const r=(await pool.query(`SELECT r.id,r.vendor,r.receipt_date,r.amount,r.payment_method,r.transaction_id,t.source,t.transaction_date,t.amount tx_amount
      FROM receipts r LEFT JOIN transactions t ON t.id=r.transaction_id WHERE r.id=$1`,[id])).rows[0];
    if(!r){out.push({id,action:"missing"});continue}
    let closed=false;
    const when=r.transaction_date||r.receipt_date;
    if(r.transaction_id&&when){const iso=when instanceof Date?when.toISOString():String(when);
      closed=Boolean((await pool.query("SELECT closed FROM month_closes WHERE month_start=$1",[iso.slice(0,7)+"-01"])).rows[0]?.closed)}
    const action=closed?"blocked":!r.transaction_id?"remove_receipt":(r.source==="manual"||r.source==="receipt-auto-repair")?"remove_both":"remove_receipt";
    out.push({...r,action,closed});
  }
  return out;
}
app.get("/admin/test-receipts",async(req,res,next)=>{try{
  const ids=parseIds(req.query.ids);
  const plan=await planTestRemoval(ids);
  const label={remove_both:"Remove the receipt AND its manual transaction",remove_receipt:"Remove the receipt only (any linked card charge stays)",blocked:"Not touched: that month is closed",missing:"Not found"};
  const rows=plan.map((p)=>`<tr><td>#${p.id}</td><td>${escHtml(p.vendor)}</td><td>${escHtml(String(p.receipt_date||"").slice(0,10))}</td><td>${p.amount==null?"":"$"+Number(p.amount).toFixed(2)}</td><td>${escHtml(p.payment_method)}</td><td>${p.transaction_id?"txn "+p.transaction_id+" ("+escHtml(p.source)+")":"none"}</td><td><b>${label[p.action]}</b></td></tr>`).join("");
  const n=plan.filter((p)=>p.action==="remove_both"||p.action==="remove_receipt").length;
  res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remove test receipts</title>
<body style="font:16px system-ui;max-width:900px;margin:30px auto;padding:0 16px"><h1>Remove test receipts</h1>
<p>Nothing is removed until you press the button. Every removal is written to the audit log with the full record.</p>
<table border="1" cellpadding="8" style="border-collapse:collapse;width:100%"><tr><th>Receipt</th><th>Vendor</th><th>Date</th><th>Amount</th><th>Payment</th><th>Linked</th><th>What will happen</th></tr>${rows||'<tr><td colspan="7">Add ?ids=16,17,18 to the address.</td></tr>'}</table>
<p><button id="go" ${n?"":"disabled"} style="font-size:16px;padding:10px 18px">Remove ${n} test entr${n===1?"y":"ies"}</button> <span id="msg"></span></p>
<script>document.getElementById("go").onclick=async()=>{const b=document.getElementById("go");b.disabled=true;
const r=await fetch("/api/receipts/clear-tests",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids:${JSON.stringify(ids)}})});
document.getElementById("msg").textContent=r.ok?"Done: "+JSON.stringify((await r.json()).removed):"Failed: "+(await r.text())}</script></body>`);
}catch(e){next(e)}});
app.post("/api/receipts/clear-tests",async(req,res,next)=>{try{
  const ids=parseIds((req.body.ids||[]).join(","));
  if(!ids.length)return res.status(400).json({error:"No receipt ids"});
  const plan=await planTestRemoval(ids),removed=[];
  for(const p of plan){
    if(p.action!=="remove_both"&&p.action!=="remove_receipt")continue;
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const rec=(await client.query("SELECT id,file_name,vendor,receipt_date,amount,payment_method,transaction_id FROM receipts WHERE id=$1",[p.id])).rows[0];
      let tx=null;
      if(p.action==="remove_both")tx=(await client.query("DELETE FROM transactions WHERE id=$1 AND source IN('manual','receipt-auto-repair') RETURNING *",[p.transaction_id])).rows[0]||null;
      await client.query("DELETE FROM receipts WHERE id=$1",[p.id]);
      await client.query("COMMIT");
      await audit("captain","removed_test_data","receipt",String(p.id),{receipt:rec,transaction:tx},null,{reason:"Marked as a test/sample receipt",source:"POST /api/receipts/clear-tests"});
      removed.push({receipt:p.id,transaction:tx?tx.id:null});
    }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
  }
  res.json({removed,skipped:plan.filter((p)=>p.action==="blocked"||p.action==="missing").map((p)=>p.id)});
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

  const correctedFileName=receiptFileName(vendor,date,amount,current.content_type,current.file_name);
  await pool.query(`UPDATE receipts SET receipt_date=$1,vendor=$2,amount=$3,category_id=$4,receipt_text=$5,payment_method=$6,payment_reference=$7,review_required=false,file_name=$8 WHERE id=$9`,
    [date,vendor,amount,categoryId,receiptText,paymentMethod,paymentReference,correctedFileName,id]);

  let createdTransactionId=null,matched=null;
  if(!current.transaction_id && paymentMethod!=="credit_card"){
    if(!date||!vendor||amount===null)return res.status(400).json({error:"Date, vendor, and amount are required for cash, check, or wire"});
    await assertMonthOpen(date);
    const rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[vendor])).rows[0];
    const chosenCategory=categoryId||rule?.category_id||null;
    const ext=crypto.createHash("sha256").update(["receipt-correction",id,String(date).slice(0,10),paymentMethod,paymentReference||"",vendor.toUpperCase(),Number(amount).toFixed(2)].join("|")).digest("hex");
    const tr=await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status,payment_method,payment_reference,captain_reviewed,approval_status)
      VALUES($1,$1,$2,$2,$3,$4,NULL,'receipt-correction',$5,'posted',$6,$7,$8,$9)
      ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
      [date,vendor,amount,chosenCategory,ext,paymentMethod,paymentReference,b.category_id!==undefined&&b.category_id!==null,await approvalStatusFor(amount)]);
    createdTransactionId=tr.rows[0]?.id||((await pool.query("SELECT id FROM transactions WHERE external_id=$1 LIMIT 1",[ext])).rows[0]?.id||null);
    if(createdTransactionId)await pool.query("UPDATE receipts SET transaction_id=$1,category_id=COALESCE(category_id,$2) WHERE id=$3",[createdTransactionId,chosenCategory,id]);
  }else if(!current.transaction_id && paymentMethod==="credit_card"){
    matched=await autoMatchReceipt(id);
  }
  if(paymentMethod!=="credit_card"){
    const repaired=await repairOrphanNonCardReceipts();
    const linked=(await pool.query("SELECT transaction_id FROM receipts WHERE id=$1",[id])).rows[0]?.transaction_id||null;
    if(!linked)return res.status(500).json({error:"This receipt could not be posted to Transactions. It remains unsaved as an accounting transaction."});
    createdTransactionId=createdTransactionId||Number(linked);
  }
  res.json({ok:true,created_transaction_id:createdTransactionId,matched_transaction_id:matched,payment_method:paymentMethod});
}catch(e){next(e)}});

app.get("/api/receipts/:id/candidates",async(req,res,next)=>{try{
  const r=(await pool.query("SELECT * FROM receipts WHERE id=$1",[Number(req.params.id)])).rows[0];
  if(!r)return res.status(404).json({error:"Not found"});
  if(r.transaction_id)return res.json({already_matched:true,transaction_id:r.transaction_id,candidates:[]});
  if(r.amount==null||!r.receipt_date)return res.json({candidates:[],reason:"Receipt needs an amount and date before it can be matched"});
  res.json({candidates:await receiptMatchCandidates(r)});
}catch(e){next(e)}});

app.post("/api/receipts/:id/match",async(req,res,next)=>{try{
  const receiptId=Number(req.params.id),transactionId=Number(req.body.transaction_id);
  if(!Number.isFinite(receiptId)||!Number.isFinite(transactionId))return res.status(400).json({error:"receipt id and transaction_id required"});
  const r=(await pool.query("SELECT id,category_id FROM receipts WHERE id=$1",[receiptId])).rows[0];
  if(!r)return res.status(404).json({error:"Receipt not found"});
  const t=(await pool.query("SELECT id FROM transactions WHERE id=$1",[transactionId])).rows[0];
  if(!t)return res.status(404).json({error:"Transaction not found"});
  const taken=(await pool.query("SELECT id FROM receipts WHERE transaction_id=$1",[transactionId])).rows[0];
  if(taken)return res.status(409).json({error:"That transaction already has a receipt attached"});
  await pool.query("UPDATE receipts SET transaction_id=$1,match_method='manual',match_score=NULL,matched_at=NOW(),matched_by='captain' WHERE id=$2",[transactionId,receiptId]);
  if(r.category_id)await pool.query("UPDATE transactions SET category_id=COALESCE(category_id,$1),captain_reviewed=true,updated_at=NOW() WHERE id=$2",[r.category_id,transactionId]);
  await audit("captain","manual_match","receipt",receiptId,{transaction_id:null},{transaction_id:transactionId},{source:"POST /api/receipts/:id/match"});
  res.json({ok:true});
}catch(e){next(e)}});

app.get("/api/receipts/:id",async(req,res,next)=>{try{
  const q=await pool.query("SELECT file_name,content_type,file_data,source_url,purged_at FROM receipts WHERE id=$1",[Number(req.params.id)]);const r=q.rows[0];if(!r)return res.sendStatus(404);
  if(r.purged_at)return res.status(410).send("Receipt file expired after 60 days.");
  if(r.source_url)return res.redirect(r.source_url);
  res.type(r.content_type);res.set("Content-Disposition",`inline; filename="${String(r.file_name).replaceAll('"','')}"`);res.send(r.file_data)
}catch(e){next(e)}});


app.get("/api/audit-log",async(req,res,next)=>{try{
  const entityType=req.query.entity_type||null,entityId=req.query.entity_id||null;
  const limit=Math.min(500,Math.max(1,Number(req.query.limit)||100));
  const q=await pool.query(
    `SELECT id,created_at,actor,action,entity_type,entity_id,old_data,new_data,reason,source FROM audit_log
     WHERE ($1::text IS NULL OR entity_type=$1) AND ($2::text IS NULL OR entity_id=$2)
     ORDER BY id DESC LIMIT $3`,[entityType,entityId,limit]);
  res.json({rows:q.rows});
}catch(e){next(e)}});

function csvCell(v){
  if(v===null||v===undefined)return "";
  const s=String(v);
  return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;
}
app.get("/api/petty-cash",async(req,res,next)=>{try{
  const {month,start,next:n}=monthBounds(req.query.month);
  const period=(await pool.query("SELECT * FROM petty_cash_periods WHERE month_start=$1",[start])).rows[0]
    ||{month_start:start,beginning_balance:0,replenishments:0,counted_balance:null,counted_at:null,notes:null};
  const cashExpenses=(await pool.query(`SELECT COALESCE(SUM(t.amount),0)::numeric total,COUNT(*)::int count,
      COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts
    FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.payment_method='cash' AND t.status='posted' AND t.transaction_date>=$1::date AND t.transaction_date<$2::date`,[start,n])).rows[0];
  const expectedEnding=Number(period.beginning_balance)+Number(period.replenishments)-Number(cashExpenses.total);
  res.json({
    month,beginning_balance:Number(period.beginning_balance),replenishments:Number(period.replenishments),
    cash_expenses_total:Number(cashExpenses.total),cash_expense_count:cashExpenses.count,cash_expenses_missing_receipts:cashExpenses.missing_receipts,
    expected_ending_balance:Math.round(expectedEnding*100)/100,
    counted_balance:period.counted_balance==null?null:Number(period.counted_balance),
    difference:period.counted_balance==null?null:Math.round((Number(period.counted_balance)-expectedEnding)*100)/100,
    counted_at:period.counted_at,notes:period.notes
  });
}catch(e){next(e)}});

app.put("/api/petty-cash",async(req,res,next)=>{try{
  const {month,start}=monthBounds(req.body.month);
  const beginningBalance=moneyNum(req.body.beginning_balance),replenishments=moneyNum(req.body.replenishments)??0,
    countedBalance=req.body.counted_balance===undefined||req.body.counted_balance===null?null:moneyNum(req.body.counted_balance);
  if(beginningBalance===null)return res.status(400).json({error:"beginning_balance is required"});
  const before=(await pool.query("SELECT * FROM petty_cash_periods WHERE month_start=$1",[start])).rows[0]||null;
  await pool.query(`INSERT INTO petty_cash_periods(month_start,beginning_balance,replenishments,counted_balance,counted_at,notes)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(month_start) DO UPDATE SET beginning_balance=EXCLUDED.beginning_balance,replenishments=EXCLUDED.replenishments,
      counted_balance=EXCLUDED.counted_balance,counted_at=EXCLUDED.counted_at,notes=EXCLUDED.notes`,
    [start,beginningBalance,replenishments,countedBalance,countedBalance===null?null:new Date(),req.body.notes||null]);
  await audit("captain","update","petty_cash_period",month,before,{beginning_balance:beginningBalance,replenishments,counted_balance:countedBalance},{source:"PUT /api/petty-cash"});
  const cashExpenses=(await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM transactions
    WHERE payment_method='cash' AND status='posted' AND transaction_date>=$1::date AND transaction_date<(($1::date)+INTERVAL '1 month')`,[start])).rows[0];
  const expectedEnding=beginningBalance+replenishments-Number(cashExpenses.total);
  res.json({
    month,beginning_balance:beginningBalance,replenishments,cash_expenses_total:Number(cashExpenses.total),
    expected_ending_balance:Math.round(expectedEnding*100)/100,counted_balance:countedBalance,
    difference:countedBalance===null?null:Math.round((countedBalance-expectedEnding)*100)/100
  });
}catch(e){next(e)}});

app.get("/api/import-batches",async(_req,res,next)=>{try{
  const q=await pool.query(`SELECT id,source_filename,file_hash,uploaded_at,statement_start,statement_end,row_count,
    beginning_balance,ending_balance,reconciled,reconciled_at FROM import_batches ORDER BY uploaded_at DESC LIMIT 50`);
  res.json({rows:q.rows});
}catch(e){next(e)}});

app.get("/api/reconciliation/:batchId",async(req,res,next)=>{try{
  const batchId=Number(req.params.batchId);
  const batch=(await pool.query("SELECT * FROM import_batches WHERE id=$1",[batchId])).rows[0];
  if(!batch)return res.status(404).json({error:"Import batch not found"});
  const [totals,receiptGaps,suspected]=await Promise.all([
    pool.query(`SELECT COUNT(*)::int imported_row_count,
        COALESCE(SUM(amount) FILTER(WHERE amount>0),0)::numeric imported_charge_total,
        COALESCE(SUM(amount) FILTER(WHERE amount<0),0)::numeric imported_credit_total
      FROM transactions WHERE import_batch_id=$1`,[batchId]),
    pool.query(`SELECT COUNT(*)::int missing_receipt_count FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
      WHERE t.import_batch_id=$1 AND r.id IS NULL`,[batchId]),
    pool.query(`SELECT COUNT(*)::int suspected_duplicate_count FROM transactions WHERE import_batch_id=$1 AND duplicate_status='suspected'`,[batchId])
  ]);
  const t=totals.rows[0],rg=receiptGaps.rows[0],sd=suspected.rows[0];
  const unmatchedReceipts=(await pool.query(`SELECT COUNT(*)::int count FROM receipts WHERE transaction_id IS NULL AND payment_method='credit_card'
    AND receipt_date BETWEEN $1::date AND $2::date`,[batch.statement_start,batch.statement_end])).rows[0].count;
  let reconciliationDifference=null;
  if(batch.beginning_balance!=null&&batch.ending_balance!=null){
    const expectedEnding=Number(batch.beginning_balance)+Number(t.imported_charge_total)+Number(t.imported_credit_total);
    reconciliationDifference=Math.round((expectedEnding-Number(batch.ending_balance))*100)/100;
  }
  const cleanExceptions=rg.missing_receipt_count===0&&sd.suspected_duplicate_count===0&&unmatchedReceipts===0;
  res.json({
    batch_id:batchId,source_filename:batch.source_filename,statement_start:batch.statement_start,statement_end:batch.statement_end,
    beginning_balance:batch.beginning_balance,ending_balance:batch.ending_balance,
    imported_row_count:t.imported_row_count,imported_charge_total:t.imported_charge_total,imported_credit_total:t.imported_credit_total,
    unmatched_receipt_count:unmatchedReceipts,missing_receipt_count:rg.missing_receipt_count,suspected_duplicate_count:sd.suspected_duplicate_count,
    reconciliation_difference:reconciliationDifference,
    reconciliation_status:batch.reconciled?"reconciled":(reconciliationDifference===null?"needs_balances":(reconciliationDifference===0&&cleanExceptions?"ready":"discrepancy")),
    reconciled:batch.reconciled,reconciled_at:batch.reconciled_at
  });
}catch(e){next(e)}});

app.put("/api/reconciliation/:batchId",async(req,res,next)=>{try{
  const batchId=Number(req.params.batchId);
  const beginningBalance=moneyNum(req.body.beginning_balance),endingBalance=moneyNum(req.body.ending_balance);
  if(beginningBalance===null||endingBalance===null)return res.status(400).json({error:"beginning_balance and ending_balance are required"});
  const batch=(await pool.query("SELECT * FROM import_batches WHERE id=$1",[batchId])).rows[0];
  if(!batch)return res.status(404).json({error:"Import batch not found"});
  await pool.query("UPDATE import_batches SET beginning_balance=$1,ending_balance=$2 WHERE id=$3",[beginningBalance,endingBalance,batchId]);
  // Recompute status the same way the GET does, and only mark reconciled when it's actually clean.
  const totals=(await pool.query(`SELECT COALESCE(SUM(amount) FILTER(WHERE amount>0),0)::numeric charges,
      COALESCE(SUM(amount) FILTER(WHERE amount<0),0)::numeric credits FROM transactions WHERE import_batch_id=$1`,[batchId])).rows[0];
  const missing=(await pool.query(`SELECT COUNT(*)::int c FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id WHERE t.import_batch_id=$1 AND r.id IS NULL`,[batchId])).rows[0].c;
  const dup=(await pool.query("SELECT COUNT(*)::int c FROM transactions WHERE import_batch_id=$1 AND duplicate_status='suspected'",[batchId])).rows[0].c;
  const unmatched=(await pool.query(`SELECT COUNT(*)::int c FROM receipts WHERE transaction_id IS NULL AND payment_method='credit_card' AND receipt_date BETWEEN $1::date AND $2::date`,[batch.statement_start,batch.statement_end])).rows[0].c;
  const diff=Math.round((beginningBalance+Number(totals.charges)+Number(totals.credits)-endingBalance)*100)/100;
  const clean=diff===0&&missing===0&&dup===0&&unmatched===0;
  await pool.query(`UPDATE import_batches SET reconciled=$1,reconciled_at=CASE WHEN $1 THEN NOW() ELSE NULL END WHERE id=$2`,[clean,batchId]);
  await audit("captain","reconcile","import_batch",batchId,{reconciled:batch.reconciled},{reconciled:clean,difference:diff},{source:"PUT /api/reconciliation/:batchId"});
  res.json({batch_id:batchId,reconciliation_difference:diff,reconciled:clean});
}catch(e){next(e)}});

app.get("/api/export/register",async(req,res,next)=>{try{
  const {month,start,next:n}=monthBounds(req.query.month);
  const q=await pool.query(`SELECT t.transaction_date,t.posted_date,COALESCE(NULLIF(t.vendor_normalized,''),t.vendor_raw) vendor,t.amount,
      c.name category_name,t.payment_method,COALESCE(cd.last4,t.payment_reference) card_or_reference,
      t.captain_reviewed,r.id receipt_id,t.approval_status,t.notes
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN cards cd ON cd.id=t.card_id LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date
    ORDER BY t.transaction_date,t.id`,[start,n]);
  const headers=["Transaction Date","Posted Date","Vendor","Amount","Category","Payment Method","Card/Reference","Captain Reviewed","Receipt Attached","Owner Approval Status","Notes"];
  const toDate=(v)=>v instanceof Date?v.toISOString().slice(0,10):v;
  if(req.query.format==="xlsx"){
    const wb=new ExcelJS.Workbook();
    const sheet=wb.addWorksheet(month);
    sheet.columns=headers.map((header)=>({header,width:Math.max(header.length+2,14)}));
    for(const r of q.rows){
      sheet.addRow([toDate(r.transaction_date),toDate(r.posted_date),r.vendor,Number(r.amount),r.category_name||"Uncategorized",
        r.payment_method,r.card_or_reference,r.captain_reviewed?"Yes":"No",r.receipt_id?"Yes":"No",r.approval_status,r.notes]);
    }
    sheet.getColumn(4).numFmt="0.00";
    sheet.getRow(1).font={bold:true};
    sheet.columns.forEach((col)=>{
      let max=col.header.length;
      col.eachCell({includeEmpty:true},(cell)=>{max=Math.max(max,cell.value?String(cell.value).length:0)});
      col.width=col.header==="Notes"?Math.min(max+2,60):max+2;
    });
    res.set("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition",`attachment; filename="${V.slug}-register-${month}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }
  const lines=[headers.join(",")];
  for(const r of q.rows){
    lines.push([
      r.transaction_date instanceof Date?r.transaction_date.toISOString().slice(0,10):r.transaction_date,
      r.posted_date instanceof Date?r.posted_date.toISOString().slice(0,10):r.posted_date,
      r.vendor,Number(r.amount).toFixed(2),r.category_name||"Uncategorized",r.payment_method,r.card_or_reference,
      r.captain_reviewed?"Yes":"No",r.receipt_id?"Yes":"No",r.approval_status,r.notes
    ].map(csvCell).join(","));
  }
  res.set("Content-Type","text/csv");
  res.set("Content-Disposition",`attachment; filename="${V.slug}-register-${month}.csv"`);
  res.send(lines.join("\n"));
}catch(e){next(e)}});

app.get("/api/export/exceptions",async(req,res,next)=>{try{
  const {month,start,next:n}=monthBounds(req.query.month);
  const [missingReceipts,unmatchedCardReceipts,uncategorized,unreviewed,suspectedDuplicates,approvalNeeded]=await Promise.all([
    pool.query(`SELECT t.id,t.transaction_date,t.vendor_raw,t.amount FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
      WHERE r.id IS NULL AND t.status='posted' AND t.payment_method<>'cash' AND t.transaction_date>=$1::date AND t.transaction_date<$2::date ORDER BY t.transaction_date`,[start,n]),
    pool.query(`SELECT id,receipt_date,vendor,amount FROM receipts WHERE transaction_id IS NULL AND payment_method='credit_card'
      AND receipt_date>=$1::date AND receipt_date<$2::date ORDER BY receipt_date`,[start,n]),
    pool.query(`SELECT id,transaction_date,vendor_raw,amount FROM transactions WHERE category_id IS NULL AND status='posted'
      AND transaction_date>=$1::date AND transaction_date<$2::date ORDER BY transaction_date`,[start,n]),
    pool.query(`SELECT id,transaction_date,vendor_raw,amount FROM transactions WHERE captain_reviewed=false AND status='posted'
      AND transaction_date>=$1::date AND transaction_date<$2::date ORDER BY transaction_date`,[start,n]),
    pool.query(`SELECT id,transaction_date,vendor_raw,amount FROM transactions WHERE duplicate_status='suspected' AND status='posted'
      AND transaction_date>=$1::date AND transaction_date<$2::date ORDER BY transaction_date`,[start,n]),
    pool.query(`SELECT id,transaction_date,vendor_raw,amount FROM transactions WHERE approval_status='needed' AND status='posted'
      AND transaction_date>=$1::date AND transaction_date<$2::date ORDER BY transaction_date`,[start,n]),
  ]);
  res.json({
    month,
    missing_receipts:missingReceipts.rows,
    unmatched_card_receipts:unmatchedCardReceipts.rows,
    uncategorized:uncategorized.rows,
    unreviewed:unreviewed.rows,
    suspected_duplicates:suspectedDuplicates.rows,
    owner_approval_needed:approvalNeeded.rows,
  });
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
    COUNT(*) FILTER(WHERE t.duplicate_status='suspected')::int suspected_duplicates,
    COUNT(*) FILTER(WHERE t.approval_status='needed')::int owner_approval_needed,
    COALESCE(SUM(t.amount),0)::numeric total FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date`,[start,n]);
  const c=q.rows[0],u=(await pool.query("SELECT COUNT(*)::int count FROM receipts WHERE transaction_id IS NULL AND receipt_date >= $1::date AND receipt_date < $2::date",[start,n])).rows[0].count;
  if(c.uncategorized||c.missing_receipts||c.unreviewed||c.suspected_duplicates||c.owner_approval_needed||u)return res.status(409).json({closed:false,blockers:{...c,unmatched_receipts:u}});
  await pool.query(`INSERT INTO month_closes(month_start,calculated_total,closed,closed_at) VALUES($1,$2,true,NOW())
    ON CONFLICT(month_start) DO UPDATE SET calculated_total=EXCLUDED.calculated_total,closed=true,closed_at=NOW()`,[start,Number(c.total)]);
  await audit("captain","month_close","month",month,null,{calculated_total:Number(c.total)},{source:"POST /api/close-month"});
  res.json({closed:true,month})
}catch(e){next(e)}});

app.post("/api/reopen-month",async(req,res,next)=>{try{
  const {month,start}=monthBounds(req.body.month);
  const reason=String(req.body.reason||"").trim();
  if(!reason)return res.status(400).json({error:"A reason is required to reopen a closed month"});
  const existing=(await pool.query("SELECT closed FROM month_closes WHERE month_start=$1",[start])).rows[0];
  if(!existing?.closed)return res.status(400).json({error:"That month is not closed"});
  await pool.query("UPDATE month_closes SET closed=false,closed_at=NULL WHERE month_start=$1",[start]);
  await audit("captain","month_reopen","month",month,{closed:true},{closed:false},{reason,source:"POST /api/reopen-month"});
  res.json({closed:false,month});
}catch(e){next(e)}});

app.use((err,_req,res,_next)=>{console.error(err);if(err.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"Receipt must be under 20MB per image"});if(err.statusCode)return res.status(err.statusCode).json({error:err.message});res.status(500).json({error:"Server error"})});

// ponytail: legacy one-off receipt cleanup (vendor payment_method fix + filename
// normalization) used to run unconditionally on every startup/deploy. It's now an
// explicit maintenance command instead: `node server.js --legacy-cleanup`.
async function legacyReceiptCleanup(){
  await pool.query(`UPDATE receipts
    SET payment_method='credit_card'
    WHERE transaction_id IS NULL
      AND (
        vendor ILIKE '%National Marine%'
        OR vendor ILIKE '%Hodges%'
        OR vendor ILIKE '%BJB Marine%'
        OR file_name ILIKE '%NMS%'
        OR file_name ILIKE '%Hodges%'
        OR file_name ILIKE '%BJB%'
      )`);
  const legacyRows=(await pool.query(`SELECT id,vendor,receipt_date,amount,content_type,file_name
    FROM receipts
    WHERE vendor IS NOT NULL
      AND (file_name ILIKE 'ChatGPT Image%' OR file_name ILIKE 'Cash%.png' OR file_name ILIKE '%NMS%' OR file_name ILIKE '%Hodges%' OR file_name ILIKE '%BJB%')`)).rows;
  for(const r of legacyRows){
    const renamed=receiptFileName(r.vendor,r.receipt_date,r.amount,r.content_type,r.file_name);
    await pool.query("UPDATE receipts SET file_name=$1 WHERE id=$2",[renamed,r.id]);
  }
  console.log("LEGACY_RECEIPT_NORMALIZE complete");
  const refreshRows=(await pool.query(`SELECT id,vendor,receipt_date,amount,content_type,file_name FROM receipts WHERE vendor IS NOT NULL`)).rows;
  for(const r of refreshRows){
    const renamed=receiptFileName(r.vendor,r.receipt_date,r.amount,r.content_type,r.file_name);
    if(renamed!==r.file_name) await pool.query("UPDATE receipts SET file_name=$1 WHERE id=$2",[renamed,r.id]);
  }
  console.log("LEGACY_FILENAME_REFRESH complete");
}

// Captain-editable via settings keys 'mail_from' and 'alert_email_to' (PUT
// /api/settings/mail) so a client can point sends/alerts at their own address
// without a redeploy. RESEND_API_KEY stays a Railway-only secret — that's
// infrastructure, not something to expose in the app's settings UI.
async function getMailSetting(key,envFallback){
  const row=(await pool.query("SELECT value FROM settings WHERE key=$1",[key])).rows[0];
  return row?row.value:(envFallback||null);
}

// ponytail: email sending is a no-op (logs instead) until RESEND_API_KEY and a
// from-address are set — lets monitoring/backup/alert code be written and
// wired in now without blocking on the sending account being ready.
//
// Uses Resend's HTTPS API rather than SMTP: Railway's Hobby plan blocks
// outbound SMTP entirely (silently times out instead of refusing), which is
// what crashed the monitor/alerts cron jobs. An HTTPS API call isn't subject
// to that block.
async function sendMail({to,subject,text}){
  const apiKey=process.env.RESEND_API_KEY;
  const from=await getMailSetting("mail_from",process.env.MAIL_FROM);
  if(!apiKey||!from){console.log(`[mail not configured] would send to ${to}: ${subject}`);return{sent:false}}
  try{
    const res=await fetch("https://api.resend.com/emails",{
      method:"POST",
      headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
      body:JSON.stringify({from,to:[to],subject,text}),
    });
    if(!res.ok)throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return{sent:true};
  }catch(e){
    console.error("SEND_MAIL_FAILED",e.message);
    return{sent:false,error:e.message};
  }
}

async function backupDatabase(){
  const {rows:tables}=await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  const dump={created_at:new Date().toISOString(),tables:{}};
  for(const {table_name} of tables){
    // table_name comes from information_schema, not user input — safe to interpolate quoted.
    const q=await pool.query(`SELECT * FROM "${table_name}"`);
    dump.tables[table_name]=q.rows;
  }
  const gz=zlib.gzipSync(Buffer.from(JSON.stringify(dump)));
  const accessKeyId=process.env.BACKUP_S3_ACCESS_KEY_ID,secretAccessKey=process.env.BACKUP_S3_SECRET_ACCESS_KEY,
    endpoint=process.env.BACKUP_S3_ENDPOINT,bucket=process.env.BACKUP_S3_BUCKET;
  if(!accessKeyId||!secretAccessKey||!endpoint||!bucket){
    console.log("BACKUP_SKIPPED: S3 credentials not configured");
    return{uploaded:false,bytes:gz.length};
  }
  const client=new AwsClient({accessKeyId,secretAccessKey,region:"auto",service:"s3"});
  const key=`${V.slug}-${new Date().toISOString().slice(0,10)}-${Date.now()}.json.gz`;
  const url=`https://${bucket}.${new URL(endpoint).host}/${key}`;
  const res=await client.fetch(url,{method:"PUT",body:gz,headers:{"Content-Type":"application/gzip"}});
  if(!res.ok)throw new Error(`Backup upload failed: ${res.status} ${await res.text()}`);
  console.log(`BACKUP_COMPLETE: ${key} (${gz.length} bytes, ${tables.length} tables)`);
  return{uploaded:true,key,bytes:gz.length,tables:tables.length};
}

// Emailed receipts never auto-create a transaction — only the captain confirming
// cash/check/wire fields in Review/Fix does that. An emailed receipt always lands
// as payment_method='credit_card' (unless the text clearly says otherwise) with
// review_required=true, same as a manually-uploaded credit-card receipt: it just
// waits to match a statement charge, or sits in Needs Review if OCR came up short.
async function ingestReceiptFromEmail(buffer,mimetype,filename){
  const allowed=["image/jpeg","image/png","image/webp","image/heic","image/heif","application/pdf"];
  if(!allowed.includes(mimetype))return{skipped:true,reason:`unsupported type ${mimetype}`};
  if(mimetype==="application/pdf"){
    try{const r=await ingestPdf(buffer,filename||"receipt.pdf");return r.status==="duplicate"?{skipped:true,reason:"duplicate",id:r.id}:{skipped:false,id:r.id,matched_transaction_id:r.matched_transaction_id}}
    catch(e){console.error("EMAIL_PDF_FAILED",e.message);return{skipped:true,reason:"pdf could not be read"}}
  }
  const sha=crypto.createHash("sha256").update(buffer).digest("hex");
  const existing=(await pool.query("SELECT id FROM receipts WHERE file_sha256=$1",[sha])).rows[0];
  if(existing)return{skipped:true,reason:"duplicate",id:existing.id};
  let parsed={vendor:null,receipt_date:null,amount:null,suggested_category:null,detected_payment_method:null,receipt_text:null};
  if(mimetype!=="application/pdf"){
    try{
      const data=await ocrImage(buffer);
      parsed={vendor:data.vendor,receipt_date:data.receipt_date,amount:data.amount,suggested_category:data.suggested_category,detected_payment_method:data.detected_payment_method,receipt_text:data.receipt_text};
    }catch(e){console.error("EMAIL_RECEIPT_OCR_FAILED",e.message)}
  }
  const paymentMethod=(parsed.detected_payment_method&&parsed.detected_payment_method!=="credit_card")?parsed.detected_payment_method:"credit_card";
  const finalName=receiptFileName(parsed.vendor,parsed.receipt_date,parsed.amount,mimetype,filename||"receipt");
  const q=await pool.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256,receipt_text,expires_at,payment_method,review_required)
    VALUES(NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()+INTERVAL '60 days',$11,true) RETURNING id`,
    [finalName,mimetype,buffer.length,buffer,parsed.receipt_date,parsed.vendor,parsed.amount,null,sha,parsed.receipt_text,paymentMethod]);
  const matched=paymentMethod==="credit_card"?await autoMatchReceipt(q.rows[0].id):null;
  return{skipped:false,id:q.rows[0].id,matched_transaction_id:matched,payment_method:paymentMethod};
}


// ---- Folder inbox: one receipt = one or more photos, kept as separate pages ----
const IMG_TYPES={".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp",".heic":"image/heic",".heif":"image/heif",".pdf":"application/pdf"};
const sha256=(b)=>crypto.createHash("sha256").update(b).digest("hex");
function typeOfName(name,fallback){return IMG_TYPES[String(name).toLowerCase().match(/\.[^.]+$/)?.[0]]||fallback}
function interpretPages(raws,totalIdx){return interpretRaw(raws.length===1?raws[0]:combineRaws(raws,totalIdx))}

// pages: [{buffer,name,sha,raw}] (raw = ocrRaw result or null). Saves one receipt + its pages.
async function saveReceiptPages(pages,{autoGrouped=false,original=null,extraReasons=[]}={}){
  const groupSha=original?sha256(original.buffer):pages.length===1?pages[0].sha:sha256(pages.map((p)=>p.sha).join(""));
  const dup=(await pool.query("SELECT id FROM receipts WHERE file_sha256=$1",[groupSha])).rows[0];
  if(dup)return{status:"duplicate",id:dup.id};
  const raws=pages.map((p)=>p.raw).filter(Boolean);
  let d={vendor:null,receipt_date:null,amount:null,suggested_category:null,detected_payment_method:null,receipt_text:null,confidence:null,field_score:null,review_reasons:[]};
  if(raws.length===pages.length)d=await withVision(interpretPages(raws),pages.map((p)=>p.buffer),{original:original?.buffer});
  const reasons=[...(d.review_reasons||[])];
  if(pages.length>1)reasons.push(original?"multi-page PDF":autoGrouped?"photos grouped automatically":"multi-photo receipt");
  reasons.push(...extraReasons);
  const combined=original?{buffer:original.buffer,content_type:original.mime,file_name:original.name}:await combineReceiptImages(pages.map((p)=>({buffer:p.buffer,mimetype:typeOfName(p.name,"image/jpeg"),originalname:p.name})));
  const mime=combined.content_type,full=combined.buffer;
  const pay=(d.detected_payment_method&&d.detected_payment_method!=="credit_card")?d.detected_payment_method:"credit_card";
  const finalName=receiptFileName(d.vendor,d.receipt_date,d.amount,mime,combined.file_name||pages[0].name);
  const guess=JSON.stringify({vendor:d.vendor,date:d.receipt_date,amount:d.amount,payment:d.detected_payment_method,category:d.suggested_category,flags:reasons});
  const client=await pool.connect();let id;
  try{
    await client.query("BEGIN");
    const q=await client.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256,receipt_text,expires_at,payment_method,review_required,ocr_confidence,ocr_field_score,ocr_review_reasons,ocr_guess)
      VALUES(NULL,$1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,NOW()+INTERVAL '60 days',$10,true,$11,$12,$13,$14) RETURNING id`,
      [finalName,mime,full.length,full,d.receipt_date,d.vendor,d.amount,groupSha,d.receipt_text,pay,d.confidence==null?null:Math.round(d.confidence),d.field_score,reasons.join(","),guess]);
    id=q.rows[0].id;
    for(const [i,p] of pages.entries())await client.query("INSERT INTO receipt_pages(receipt_id,page_no,file_name,file_sha256,file_data,raw) VALUES($1,$2,$3,$4,$5,$6)",[id,i+1,p.name,p.sha,p.buffer,p.raw?JSON.stringify(p.raw):null]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
  const matched=pay==="credit_card"?await autoMatchReceipt(id):null;
  return{status:"ingested",id,pages:pages.length,matched_transaction_id:matched};
}

// A scanner-app PDF is one receipt; its pages are rendered and read like photos. The PDF itself is what gets filed.
async function ingestPdf(buffer,name){
  const {images,truncated,total}=pdfToImages(buffer);
  const base=String(name).replace(/\.pdf$/i,"");
  const pages=[];
  for(const [i,img] of images.entries()){
    let raw=null;try{raw=await ocrRaw(img)}catch(e){console.error("INBOX_OCR_FAILED",name,e.message)}
    pages.push({buffer:img,name:`${base}-p${i+1}.jpg`,sha:sha256(img),raw});
  }
  return saveReceiptPages(pages,{original:{buffer,mime:"application/pdf",name},extraReasons:truncated?[`PDF has ${total} pages, only the first ${images.length} were read`]:[]});
}

async function readPages(files){
  const out=[];
  for(const f of files){
    const heic=isHeic(f.buffer);
    const buffer=heic?await toReadable(f.buffer):f.buffer,sha=sha256(f.buffer);
    const name=heic?String(f.originalname).replace(/\.hei[cf]$/i,"")+".jpg":f.originalname;
    let raw=null;
    try{raw=await ocrRaw(buffer)}catch(e){console.error("INBOX_OCR_FAILED",name,e.message)}
    out.push({buffer,name,sha,raw});
  }
  return out;
}

// mode=folder: every file is one receipt (a subfolder). mode=auto: loose files, guess the groups.
app.post("/api/receipts/inbox",upload.any(),async(req,res,next)=>{try{
  const files=req.files||[];if(!files.length)return res.status(400).json({error:"Files required"});
  if(files.length>60)return res.status(413).json({error:"Send at most 60 files at once"});
  const bad=files.filter((f)=>!typeOfName(f.originalname,null));
  if(bad.length)return res.status(415).json({error:`Unsupported file type: ${bad.map((f)=>f.originalname).join(", ")}`});
  let mtimes=[];try{mtimes=JSON.parse(req.body.mtimes||"[]")}catch{}
  let groups;
  if(req.body.mode==="folder"){
    const order=files.map((_,i)=>i).sort((a,b)=>files[a].originalname.localeCompare(files[b].originalname,undefined,{numeric:true}));
    groups=files.some((f)=>/\.pdf$/i.test(f.originalname))?order.map((i)=>[i]):[order];
  }else groups=groupLoosePhotos(files.map((f,i)=>({name:f.originalname,mtime:Number(mtimes[i])||0})));
  const results=[];
  for(const g of groups){
    const gf=g.map((i)=>files[i]),names=gf.map((f)=>f.originalname);
    try{
      if(gf.length===1&&/\.pdf$/i.test(names[0])){
        results.push({files:names,...await ingestPdf(gf[0].buffer,names[0])});
      }else{
        const r=await saveReceiptPages(await readPages(gf),{autoGrouped:req.body.mode!=="folder"&&gf.length>1});
        results.push({files:names,...r});
      }
    }catch(e){console.error("INBOX_GROUP_FAILED",names,e.message);results.push({files:names,status:"error",error:e.message})}
  }
  res.json({groups:results});
}catch(e){next(e)}});

app.get("/api/receipts/:id/pages",async(req,res,next)=>{try{
  const q=await pool.query("SELECT page_no,file_name FROM receipt_pages WHERE receipt_id=$1 ORDER BY page_no",[Number(req.params.id)]);
  res.json({pages:q.rows});
}catch(e){next(e)}});
app.get("/api/receipts/:id/pages/:n",async(req,res,next)=>{try{
  const r=(await pool.query("SELECT file_name,file_data FROM receipt_pages WHERE receipt_id=$1 AND page_no=$2",[Number(req.params.id),Number(req.params.n)])).rows[0];
  if(!r)return res.sendStatus(404);
  res.type(typeOfName(r.file_name,"image/jpeg"));res.send(r.file_data);
}catch(e){next(e)}});

// "The total is on this photo": re-read the receipt using that photo's bottom as the total source. Returns fields; saves nothing.
app.post("/api/receipts/:id/total-page",async(req,res,next)=>{try{
  const id=Number(req.params.id),page=Number(req.body.page);
  const rows=(await pool.query("SELECT page_no,raw FROM receipt_pages WHERE receipt_id=$1 ORDER BY page_no",[id])).rows;
  if(!rows.length)return res.status(404).json({error:"No stored photos for this receipt"});
  const idx=rows.findIndex((r)=>r.page_no===page);if(idx<0)return res.status(400).json({error:"No such photo"});
  if(rows.some((r)=>!r.raw))return res.status(422).json({error:"These photos could not be read automatically"});
  res.json({...interpretPages(rows.map((r)=>r.raw),idx),page});
}catch(e){next(e)}});

// Split a bundled receipt after photo n into two receipts (re-interpreted from stored reads, no re-OCR).
app.post("/api/receipts/:id/split",async(req,res,next)=>{try{
  const id=Number(req.params.id),after=Number(req.body.after);
  const r=(await pool.query("SELECT transaction_id FROM receipts WHERE id=$1",[id])).rows[0];
  if(!r)return res.sendStatus(404);
  if(r.transaction_id)return res.status(409).json({error:"This receipt is already matched to a transaction"});
  const pg=(await pool.query("SELECT page_no,file_name,file_sha256 sha,file_data buffer,raw FROM receipt_pages WHERE receipt_id=$1 ORDER BY page_no",[id])).rows;
  const a=pg.filter((p)=>p.page_no<=after),b=pg.filter((p)=>p.page_no>after);
  if(!a.length||!b.length)return res.status(400).json({error:"Split must leave at least one photo on each side"});
  const toPages=(arr)=>arr.map((p)=>({buffer:p.buffer,name:p.file_name,sha:p.sha,raw:p.raw}));
  await pool.query("DELETE FROM receipts WHERE id=$1",[id]);
  const out=[];for(const part of [a,b])out.push(await saveReceiptPages(toPages(part),{autoGrouped:true}));
  await audit("captain","split","receipt",id,{pages:pg.length},{new_ids:out.map((x)=>x.id)},{source:"POST /api/receipts/:id/split"});
  res.json({receipts:out});
}catch(e){next(e)}});

async function pullReceiptEmails(){
  const user=process.env.GMAIL_USER,pass=process.env.GMAIL_APP_PASSWORD;
  if(!user||!pass){console.log("PULL_RECEIPTS_SKIPPED: Gmail not configured");return{pulled:0,skipped:0,errors:0}}
  const {ImapFlow}=await import("imapflow");
  const {simpleParser}=await import("mailparser");
  const client=new ImapFlow({host:"imap.gmail.com",port:993,secure:true,auth:{user,pass},logger:false});
  let pulled=0,skipped=0,errors=0;
  await client.connect();
  try{
    await client.mailboxOpen("INBOX");
    const uids=await client.search({seen:false},{uid:true});
    for(const uid of uids||[]){
      try{
        const msg=await client.download(uid,undefined,{uid:true});
        const parsedMail=await simpleParser(msg.content);
        const attachments=(parsedMail.attachments||[]).filter((a)=>a.size>0);
        if(!attachments.length){
          await client.messageFlagsAdd(uid,["\\Seen"],{uid:true});
          continue;
        }
        for(const att of attachments){
          const result=await ingestReceiptFromEmail(att.content,att.contentType,att.filename);
          if(result.skipped)skipped++;else pulled++;
          console.log(`PULL_RECEIPT uid=${uid} file=${att.filename} -> ${result.skipped?"skipped ("+result.reason+")":"receipt #"+result.id}`);
        }
        await client.messageFlagsAdd(uid,["\\Seen"],{uid:true});
      }catch(e){errors++;console.error(`PULL_RECEIPT_ERROR uid=${uid}`,e.message)}
    }
  }finally{
    await client.logout().catch(()=>{});
  }
  console.log(`PULL_RECEIPTS_COMPLETE pulled=${pulled} skipped=${skipped} errors=${errors}`);
  return{pulled,skipped,errors};
}

// The three states that genuinely need the captain to make a decision — not
// housekeeping (missing receipt, uncategorized) but an actual yes/no call:
// approve or decline a large charge, confirm or reject a suspected duplicate,
// or close out a month that's already clean and waiting.
async function sendAlertDigest(){
  const alertTo=await getMailSetting("alert_email_to",process.env.ALERT_EMAIL_TO);
  if(!alertTo){console.log("ALERTS_SKIPPED: alert_email_to not configured");return{sent:false}}
  const approvals=(await pool.query(`SELECT id,transaction_date,vendor_raw,amount FROM transactions
    WHERE approval_status='needed' AND status='posted' ORDER BY transaction_date`)).rows;
  const duplicates=(await pool.query(`SELECT id,transaction_date,vendor_raw,amount FROM transactions
    WHERE duplicate_status='suspected' AND status='posted' ORDER BY transaction_date`)).rows;
  const {month,start,next:n}=monthBounds();
  const blockers=(await pool.query(`SELECT COUNT(*) FILTER(WHERE t.category_id IS NULL)::int uncategorized,
      COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts,COUNT(*) FILTER(WHERE t.captain_reviewed=false)::int unreviewed,
      COUNT(*) FILTER(WHERE t.duplicate_status='suspected')::int suspected_duplicates,
      COUNT(*) FILTER(WHERE t.approval_status='needed')::int owner_approval_needed
    FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.status='posted' AND t.transaction_date>=$1::date AND t.transaction_date<$2::date`,[start,n])).rows[0];
  const alreadyClosed=(await pool.query("SELECT closed FROM month_closes WHERE month_start=$1",[start])).rows[0]?.closed;
  const monthReady=!alreadyClosed&&Object.values(blockers).every((v)=>v===0);

  if(!approvals.length&&!duplicates.length&&!monthReady){
    console.log("ALERTS_COMPLETE nothing to report");
    return{sent:false,reason:"nothing to report"};
  }
  const lines=[];
  if(approvals.length){
    lines.push(`OWNER APPROVAL NEEDED (${approvals.length}):`);
    for(const t of approvals)lines.push(`  ${String(t.transaction_date).slice(0,10)} — ${t.vendor_raw} — $${Number(t.amount).toFixed(2)}`);
    lines.push("");
  }
  if(duplicates.length){
    lines.push(`SUSPECTED DUPLICATES (${duplicates.length}):`);
    for(const t of duplicates)lines.push(`  ${String(t.transaction_date).slice(0,10)} — ${t.vendor_raw} — $${Number(t.amount).toFixed(2)}`);
    lines.push("");
  }
  if(monthReady)lines.push(`${month} has no open items and is ready to close.`);
  await sendMail({to:alertTo,subject:`${V.appName} — needs a decision`,text:lines.join("\n")});
  console.log(`ALERTS_COMPLETE sent: ${approvals.length} approvals, ${duplicates.length} duplicates, month_ready=${monthReady}`);
  return{sent:true,approvals:approvals.length,duplicates:duplicates.length,monthReady};
}

// Cron can't express "3 days before the 1st of next month" directly — month
// lengths vary — so this runs daily and only actually does anything on that day.
function isThreeDaysBeforeMonthEnd(date=new Date()){
  const y=date.getUTCFullYear(),m=date.getUTCMonth();
  const daysInMonth=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  return date.getUTCDate()===daysInMonth-2;
}

async function runMonitorCheck(){
  const results=[];
  const check=async(name,fn)=>{try{const detail=await fn();results.push({name,ok:true,detail})}catch(e){results.push({name,ok:false,detail:e.message})}};
  await check("Database connection",async()=>{await pool.query("SELECT 1");return"connected"});
  await check("Schema sanity",async()=>{
    const c=(await pool.query("SELECT COUNT(*)::int c FROM categories WHERE active=true")).rows[0].c;
    if(c<1)throw new Error("no active categories found");
    return`${c} active categories`;
  });
  await check("OCR pipeline",async()=>{
    const png=await fsp.readFile(new URL("./tests/fixtures/ocr-self-test-receipt.png",import.meta.url));
    const data=await ocrImage(png);
    if(Math.abs(Number(data.amount)-87.46)>=0.02)throw new Error(`expected $87.46, read ${data.amount}`);
    return`read $${data.amount} correctly (${data.confidence}% confidence)`;
  });
  await check("No months stuck without a close decision",async()=>{
    const {rows}=await pool.query(`SELECT COUNT(*)::int c FROM transactions WHERE status='posted'
      AND transaction_date < date_trunc('month',NOW())-INTERVAL '2 months'
      AND transaction_date NOT IN (SELECT month_start FROM month_closes WHERE closed=true)`);
    return rows[0].c>0?`heads up: ${rows[0].c} transactions older than 2 months in an unclosed period`:"clean";
  });
  const allOk=results.every(r=>r.ok);
  const lines=results.map(r=>`${r.ok?"PASS":"FAIL"} — ${r.name}: ${r.detail}`);
  console.log(`MONITOR_CHECK ${allOk?"PASS":"FAIL"}\n${lines.join("\n")}`);
  const alertTo=await getMailSetting("alert_email_to",process.env.ALERT_EMAIL_TO);
  if(alertTo){
    await sendMail({
      to:alertTo,
      subject:`${V.appName} — monthly check: ${allOk?"all clear":"needs attention"}`,
      text:lines.join("\n"),
    });
  }
  return{ok:allOk,results};
}

// Maintenance commands: run schema/reference-data init (always needed), then exit
// without starting the server if a one-time data operation was explicitly requested.
// Normal boot (`npm start` / `node server.js`) never touches transaction/receipt data.
await init();
const maintenanceFlag=process.argv.find(a=>["--legacy-cleanup","--seed-once","--purge-expired","--backup","--monitor","--pull-receipts","--alerts"].includes(a));
if(maintenanceFlag){
  if(maintenanceFlag==="--legacy-cleanup")await legacyReceiptCleanup();
  if(maintenanceFlag==="--seed-once")await seedInitialData();
  if(maintenanceFlag==="--purge-expired")await purgeExpiredReceipts();
  if(maintenanceFlag==="--backup")await backupDatabase();
  if(maintenanceFlag==="--monitor"){
    if(isThreeDaysBeforeMonthEnd())await runMonitorCheck();
    else console.log("MONITOR_SKIPPED: not 3 days before month end (runs daily, only acts on that day)");
  }
  if(maintenanceFlag==="--pull-receipts")await pullReceiptEmails();
  if(maintenanceFlag==="--alerts")await sendAlertDigest();
  console.log(`${maintenanceFlag} complete`);
  await pool.end();
  process.exit(0);
}

app.listen(port,"0.0.0.0",()=>console.log(`${V.appName} listening on ${port}`));

export {app,pool,init};