import express from "express";
import multer from "multer";
import pg from "pg";
import crypto from "crypto";
import sharp from "sharp";
import { promises as fsp } from "fs";
import { createWorker, PSM } from "tesseract.js";
import { capitalOneCsv, initialRules, driveReceipts } from "./seed.js";

const {Pool}=pg;
const app=express();
app.set("trust proxy",1);
const port=process.env.PORT||3000;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024}});

const SESSION_MAX_AGE_MS=90*24*60*60*1000;
function sessionSecret(){return process.env.SESSION_SECRET||process.env.APP_PASSWORD||"carbon-copy-dev-secret"}
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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Carbon Copy Accounting — Sign in</title>
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
    <div class="yacht"><img src="/assets/yacht.jpg" alt="M/Y Carbon Copy"></div>
    <div class="eyebrow">M/Y CARBON COPY</div>
    <h1>Accounting</h1>
    ${error?`<div class="error">${error}</div>`:""}
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" autofocus>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
  </body></html>`;
}
function auth(req,res,next){
  const user=process.env.APP_USERNAME,pass=process.env.APP_PASSWORD;
  if(!user||!pass)return next();
  if(req.path==="/login"||req.path.startsWith("/assets/"))return next();
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
  if(username!==user||password!==pass)return res.status(401).type("html").send(loginPage({error:"Incorrect username or password."}));
  const token=signSession(user);
  res.cookie("ccc_session",token,{httpOnly:true,secure:req.secure,sameSite:"lax",maxAge:SESSION_MAX_AGE_MS});
  res.redirect("/");
});
app.get("/logout",(req,res)=>{
  res.clearCookie("ccc_session",{httpOnly:true,secure:req.secure,sameSite:"lax"});
  res.redirect("/login");
});
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
function detectPaymentMethodFromText(text){
  const t=String(text||"").toLowerCase();
  if(/\b(payment|tender(?:ed)?|paid)\s*:?\s*cash\b|\bcash\s+(tendered|payment)\b/i.test(t))return "cash";
  if(/\b(payment|paid)\s*:?\s*check\b|\bcheck\s*#?/i.test(t))return "check";
  if(/\b(payment|paid)\s*:?\s*wire\b|\bwire\s+(transfer|payment)\b/i.test(t))return "wire";
  if(/\b(visa|mastercard|amex|american express|discover|credit card|card ending|card #)\b/i.test(t))return "credit_card";
  return null;
}
function suggestedCategoryFromText(text){
  const t=String(text||"").toLowerCase();
  if(/\b(diver|diving|bottom clean|underwater|zinc|hubbell|plug|cable|pump|hose|clamp|sealant|hardware|acetone|mineral spirits|handrail|gate|repair|maintenance|part|parts|engine room)\b/i.test(t))return "Repairs & Maintenance";
  if(/\b(food|grocery|groceries|meal|restaurant|cafe|coffee|snack|beverage|water|provision|provisions|market|publix|whole foods|trader joe)\b/i.test(t))return "Provisions";
  if(/\b(starlink|internet|wifi|directv|television|phone|cellular|communications)\b/i.test(t))return "Communications / Internet";
  if(/\b(dock|dockage|marina|slip|berth|yacht club|storage)\b/i.test(t))return "Dockage / Marina";
  if(/\b(customs|dtops|decal|port fee|entry fee)\b/i.test(t))return "Customs / Port Fees";
  if(/\b(office|paper|printer|ink|staples|notebook)\b/i.test(t))return "Supplies";
  if(/\b(weather|routing|forecast|buoyweather|weatherbell)\b/i.test(t))return "Navigation Bridge";
  if(/\b(uber|lyft|taxi|rideshare)\b/i.test(t))return "Transportation";
  if(/\b(fuel|diesel|gasoline|gas station|racetrac|wawa|lubricant|oil)\b/i.test(t))return "Fuel & Lubricants";
  return null;
}
function labeledAmount(lines,re){
  for(let i=lines.length-1;i>=0;i--){
    if(!re.test(lines[i]))continue;
    const same=amountFromLine(lines[i]);
    if(same!==null)return same;
    for(let step=1;step<=2;step++){
      const next=lines[i+step];
      if(!next)break;
      if(/subtotal|cash tendered|tendered|change|tip|gratuity/i.test(next))break;
      const a=amountFromLine(next);
      if(a!==null)return a;
    }
  }
  return null;
}
function parseOcrReceipt(text){
  const lines=String(text||"").split(/\r?\n/).map((x)=>x.replace(/\s+/g," ").trim()).filter(Boolean);
  const paymentText=lines.join(" ");
  const detected_payment_method=detectPaymentMethodFromText(paymentText);

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
function chooseBestAmount(parsedList){
  const candidates=parsedList.filter((p)=>p&&p.amount!==null&&p.amount!==undefined);
  if(!candidates.length)return null;
  const verified=candidates.filter((p)=>p.total_verified);
  if(verified.length){
    const counts=new Map();
    verified.forEach((p)=>counts.set(Number(p.amount).toFixed(2),(counts.get(Number(p.amount).toFixed(2))||0)+1));
    return Number([...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0]);
  }
  const counts=new Map();
  candidates.forEach((p)=>counts.set(Number(p.amount).toFixed(2),(counts.get(Number(p.amount).toFixed(2))||0)+1));
  const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1]);
  if(ranked[0]&&ranked[0][1]>=2)return Number(ranked[0][0]);
  return Number(candidates[0].amount);
}

async function ocrImage(buffer){
  const base=await sharp(buffer,{failOn:"none"})
    .rotate()
    .resize({width:2600,height:3600,fit:"inside",withoutEnlargement:true})
    .grayscale()
    .normalize()
    .sharpen()
    .extend({top:40,bottom:40,left:40,right:40,background:"white"})
    .png()
    .toBuffer();

  const meta=await sharp(base).metadata();
  const width=meta.width,height=meta.height;
  const topHeight=Math.max(1,Math.round(height*0.34));
  const bottomTop=Math.max(0,Math.round(height*0.42));
  const bottomHeight=Math.max(1,height-bottomTop);

  const topCrop=await sharp(base).extract({left:0,top:0,width,height:topHeight}).png().toBuffer();
  const bottomGray=await sharp(base).extract({left:0,top:bottomTop,width,height:bottomHeight}).png().toBuffer();
  const bottomT160=await sharp(bottomGray).threshold(160).png().toBuffer();
  const bottomT200=await sharp(bottomGray).threshold(200).png().toBuffer();

  const worker=await getOcrWorker();
  await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK,preserve_interword_spaces:"1"});
  const fullResult=await worker.recognize(base);
  const topResult=await worker.recognize(topCrop);
  const bottomGrayResult=await worker.recognize(bottomGray);
  const bottom160Result=await worker.recognize(bottomT160);
  const bottom200Result=await worker.recognize(bottomT200);

  const full=parseOcrReceipt(fullResult?.data?.text||"");
  const top=parseOcrReceipt(topResult?.data?.text||"");
  const b1=parseOcrReceipt(bottomGrayResult?.data?.text||"");
  const b2=parseOcrReceipt(bottom160Result?.data?.text||"");
  const b3=parseOcrReceipt(bottom200Result?.data?.text||"");
  const amount=chooseBestAmount([b1,b2,b3,full]);

  const merged=mergeOcrFields(full,top,b1,fullResult?.data?.confidence);
  merged.amount=amount;
  merged.total_verified=[b1,b2,b3,full].some((p)=>p.total_verified&&p.amount!==null&&amount!==null&&Math.abs(Number(p.amount)-Number(amount))<0.01);
  const combinedBottomText=[b1.receipt_text,b2.receipt_text,b3.receipt_text].filter(Boolean).join("\n");
  merged.detected_payment_method=detectPaymentMethodFromText(combinedBottomText)||merged.detected_payment_method;
  if(merged.amount===null&&!merged.review_reasons.includes("total"))merged.review_reasons.push("total");
  if(merged.amount!==null)merged.review_reasons=merged.review_reasons.filter((x)=>x!=="total");
  merged.field_score=[merged.vendor,merged.receipt_date,merged.amount!==null,merged.detected_payment_method,merged.suggested_category].filter(Boolean).length;
  return merged;
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
async function approvalStatusFor(amount){
  const row=(await pool.query("SELECT value FROM settings WHERE key='owner_approval_threshold'")).rows[0];
  const threshold=row?Number(row.value):null;
  return Number.isFinite(threshold)&&Math.abs(Number(amount))>=threshold?"needed":"not_required";
}
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
  await pool.query("INSERT INTO cards(label,last4) VALUES($1,$2) ON CONFLICT(last4) DO NOTHING",["Capital One","0945"]);
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
  const ix=n=>headers.findIndex(h=>h===n),card=(await pool.query("SELECT id FROM cards WHERE last4='0945' LIMIT 1")).rows[0];
  for(const line of lines.slice(1)){
    const c=parseCsvLine(line),debit=Number(c[ix("debit")]||NaN),credit=Number(c[ix("credit")]||NaN);
    const amount=Number.isFinite(debit)&&debit!==0?Math.abs(debit):Number.isFinite(credit)&&credit!==0?-Math.abs(credit):null;
    const row={transaction_date:csvDate(c[ix("transaction date")]),posted_date:csvDate(c[ix("posted date")]),vendor_raw:c[ix("description")]||"",amount,card_last4:String(c[ix("card no")]||"945").padStart(4,"0")};
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


app.get("/api/ocr/status",(_req,res)=>res.json({enabled:true,mode:"server-side",engine:"tesseract",formats:["JPG","PNG","WEBP","HEIC","HEIF"],manual_fallback:true}));

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
  const [c,cd,r,threshold]=await Promise.all([
    pool.query("SELECT id,name,sort_order FROM categories WHERE active=true ORDER BY sort_order,name"),
    pool.query("SELECT id,label,last4 FROM cards WHERE active=true ORDER BY id"),
    pool.query("SELECT vr.id,vr.vendor_pattern,vr.category_id,c.name category_name FROM vendor_rules vr JOIN categories c ON c.id=vr.category_id ORDER BY vr.vendor_pattern"),
    pool.query("SELECT value FROM settings WHERE key='owner_approval_threshold'")
  ]);res.json({categories:c.rows,cards:cd.rows,rules:r.rows,payment_methods:["credit_card","wire","check","cash"],owner_approval_threshold:threshold.rows[0]?Number(threshold.rows[0].value):null})
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
  const card=(await pool.query("SELECT id FROM cards WHERE last4='0945' LIMIT 1")).rows[0];

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

  let inserted=0,skipped=0,suspected=0,blockedClosedMonth=0;
  for(let i=0;i<rows.length;i++){
    const x=rows[i];
    const r={...x};
    r.transaction_date=String(r.transaction_date||r.date||"").slice(0,10);
    r.posted_date=r.posted_date?String(r.posted_date).slice(0,10):null;
    r.vendor_raw=String(r.vendor_raw||r.vendor||r.description||"").trim();
    r.amount=moneyNum(r.amount);
    r.card_last4=String(r.card_last4||r.card_no||"0945").replace(/\D/g,"").slice(-4).padStart(4,"0");
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
    const extId=already?`${fp}#${already}`:fp;
    await pool.query(insertSql,insertArgs(extId,already?"suspected":"none"));
    inserted++;
    if(already)suspected++;
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
      r.review_required,r.ocr_confidence,r.ocr_field_score,r.ocr_review_reasons,c.name category_name,c.id category_id,
      CASE WHEN r.payment_method = 'credit_card' THEN 'waiting' ELSE 'review' END bucket
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
    tid=tr.rows[0]?.id||((await pool.query("SELECT id FROM transactions WHERE external_id=$1 LIMIT 1",[ext])).rows[0]?.id||null);
  }
  const q=await pool.query(`INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data,receipt_date,vendor,amount,category_id,file_sha256,receipt_text,expires_at,payment_method,payment_reference,review_required)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+INTERVAL '60 days',$12,$13,false) RETURNING id,file_name,expires_at`,[Number.isFinite(tid)?tid:null,f.originalname,f.mimetype,f.size,f.buffer,date,vendor,amount,inferredCat,sha,receiptText,paymentMethod,paymentReference]);
  const matched=paymentMethod==="credit_card"?await autoMatchReceipt(q.rows[0].id):null;
  res.status(201).json({...q.rows[0],matched_transaction_id:matched,created_transaction_id:Number.isFinite(tid)?tid:null,payment_method:paymentMethod})
}catch(e){next(e)}});

app.post("/api/receipts/:id/ocr",async(req,res,next)=>{try{
  const id=Number(req.params.id);
  if(!Number.isFinite(id))return res.status(400).json({error:"Invalid receipt id"});
  const r=(await pool.query("SELECT file_name,content_type,file_data,purged_at FROM receipts WHERE id=$1",[id])).rows[0];
  if(!r)return res.status(404).json({error:"Receipt not found"});
  if(r.purged_at||!r.file_data)return res.status(410).json({error:"Receipt image is no longer available"});
  if(r.content_type==="application/pdf")return res.status(422).json({error:"PDF re-reading is not enabled yet"});
  if(!String(r.content_type||"").startsWith("image/")&&!/heic|heif|octet-stream/i.test(String(r.content_type||"")))return res.status(415).json({error:"This receipt type cannot be re-read automatically"});
  const out=await ocrImage(r.file_data);
  res.json(out);
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
  res.set("Content-Disposition",`attachment; filename="carbon-copy-register-${month}.csv"`);
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

// Maintenance commands: run schema/reference-data init (always needed), then exit
// without starting the server if a one-time data operation was explicitly requested.
// Normal boot (`npm start` / `node server.js`) never touches transaction/receipt data.
await init();
const maintenanceFlag=process.argv.find(a=>["--legacy-cleanup","--seed-once","--purge-expired"].includes(a));
if(maintenanceFlag){
  if(maintenanceFlag==="--legacy-cleanup")await legacyReceiptCleanup();
  if(maintenanceFlag==="--seed-once")await seedInitialData();
  if(maintenanceFlag==="--purge-expired")await purgeExpiredReceipts();
  console.log(`${maintenanceFlag} complete`);
  await pool.end();
  process.exit(0);
}

app.listen(port,"0.0.0.0",()=>console.log(`Carbon Copy Accounting listening on ${port}`));

export {app,pool,init};