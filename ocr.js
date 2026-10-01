import sharp from "sharp";
import heicConvert from "heic-convert";
import * as mupdf from "mupdf";
import { createWorker, PSM } from "tesseract.js";

let ocrWorkerPromise=null;
export async function getOcrWorker(){
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

const MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
export function isoReceiptDate(raw){
  if(!raw)return null;
  const t=String(raw),pad=(n)=>String(n).padStart(2,"0");
  let m=t.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
  if(m)return [m[1],pad(m[2]),pad(m[3])].join("-");
  m=t.match(/\b(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ ,-]+(20\d{2}|\d{2})\b/);
  if(m&&MONTHS[m[2].toLowerCase()]){let y=Number(m[3]);if(y<100)y+=2000;return [y,pad(MONTHS[m[2].toLowerCase()]),pad(m[1])].join("-")}
  m=t.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2}|\d{2})\b/);
  if(!m)return null;
  let y=Number(m[3]);if(y<100)y+=2000;
  let mo=Number(m[1]),d=Number(m[2]);
  // ponytail: month-first (US) wins when both readings are valid; day-first only when month-first is impossible.
  if(mo>12&&d<=12)[mo,d]=[d,mo];
  if(mo<1||mo>12||d<1||d>31)return null;
  return [y,pad(mo),pad(d)].join("-");
}
export function amountFromLine(line){
  const vals=[...String(line).matchAll(/(?:\$\s*)?(-?\d{1,6}(?:,\d{3})*\.\d{2})\b/g)]
    .map((m)=>Number(m[1].replace(/,/g,""))).filter(Number.isFinite);
  return vals.length?vals[vals.length-1]:null;
}

export function detectPaymentMethodFromText(text){
  const t=String(text||"").toLowerCase();
  if(/\b(visa|mastercard|amex|american express|discover|credit card|debit|card ending|card #)\b|[x*]{4,}\s*\d{4}\b/i.test(t))return "credit_card";
  if(/\b(payment|tender(?:ed)?|paid)\s*(?:mode)?\s*:?\s*cash\b|\bcash\s+(tendered|payment)\b|(?:^|\n)\s*cash\s*(?:rm|usd|\$)?\s*:?\s*\d/i.test(t))return "cash";
  if(/\b(payment|paid)\s*:?\s*check\b|\bcheck\s*#?\s*\d/i.test(t))return "check";
  if(/\b(payment|paid)\s*:?\s*wire\b|\bwire\s+(transfer|payment)\b/i.test(t))return "wire";
  return null;
}
export function suggestedCategoryFromText(text){
  const t=String(text||"").toLowerCase();
  if(/\b(unleaded|gallons?|diesel|fuel dock|gas station|racetrac|wawa|lubricant)\b/i.test(t))return "Fuel & Lubricants";
  if(/\b(diver|diving|bottom clean|underwater|zinc|hubbell|plug|cable|pump|hose|clamp|sealant|hardware|acetone|mineral spirits|handrail|gate|repair|maintenance|part|parts|engine room|epoxy|bilge|west marine|boat owners|fastener|paint|brush)\b/i.test(t))return "Repairs & Maintenance";
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

export function labeledAmount(lines,re){
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


const SUMMARY_START=/\b(gst|tax|sst|vat)\s*(summary|code|analysis)\b/i;
const STRONG_TOTAL=/\b(grand\s+total|total\s+amount|amount\s+due|balance\s+due|(?:rounded?|net|nett)\s+total|total\s+sales?|total\s+incl\w*|total\s+after|total\s+payable|total\s+due)\b/i;
const NOT_TOTAL=/\b(sub\s*-?\s*total|change|tender(?:ed)?|cash|gst|tax|vat|sst|service|discount|qty|quantity|items?|points?|rounding|savings?|tip|gratuity|deposit)\b/i;
// Lines that can name the receipt total, with a weight. Nothing after a tax-summary
// header counts, and "% / @" lines are tax-included notes, not totals.
export function totalCandidates(lines){
  const out=[];let inSummary=false;
  lines.forEach((line,i)=>{
    if(SUMMARY_START.test(line)){inSummary=true;return}
    if(inSummary||/[%@]/.test(line))return;
    const strong=STRONG_TOTAL.test(line),plain=/\btotal\b/i.test(line),weak=/\b(amount|amt|pay|payment|due|balance)\b/i.test(line);
    if(!strong&&!plain&&!weak)return;
    if(!strong&&NOT_TOTAL.test(line))return;
    let a=amountFromLine(line);
    if(a===null&&lines[i+1]&&!NOT_TOTAL.test(lines[i+1])&&!/[%@]/.test(lines[i+1]))a=amountFromLine(lines[i+1]);
    if(a===null||a<=0)return;
    out.push({amount:a,weight:strong?3:plain?2:1});
  });
  return out;
}
function tenderAmounts(lines){
  let cash=null,change=null;
  for(const l of lines){
    if(cash===null&&/^\W*(cash|tendered|cash tendered)\b/i.test(l))cash=amountFromLine(l);
    if(change===null&&/^\W*change\b/i.test(l)){const a=amountFromLine(l);if(a)change=a}
  }
  return {cash,change};
}
// Picks one total from all the reads of a receipt and says whether anything backs it up:
// subtotal+tax, cash-change, or two independent reads agreeing. Unbacked totals get flagged.
export function pickTotal(parsed){
  const votes=new Map();
  parsed.forEach((p,vi)=>{for(const c of p.total_candidates||[]){
    const k=c.amount.toFixed(2),v=votes.get(k)||{amount:c.amount,w:0,reads:new Set()};v.w+=c.weight;v.reads.add(vi);votes.set(k,v)}});
  if(!votes.size)return {amount:null,corroborated:false,verified:false};
  const subs=parsed.map((p)=>p.subtotal).filter((x)=>x>0),taxes=parsed.map((p)=>p.tax).filter((x)=>x>0);
  const tenders=parsed.map((p)=>p.tender).filter((t)=>t&&t.cash>0&&t.change>=0&&t.change!==null);
  let best=null;
  for(const v of votes.values()){
    v.arith=subs.some((s)=>taxes.some((t)=>Math.abs(s+t-v.amount)<0.03));
    v.cashChange=tenders.some((t)=>t.change!==null&&Math.abs(t.cash-t.change-v.amount)<0.03);
    v.score=v.w+(v.arith?4:0)+(v.cashChange?4:0);
    if(!best||v.score>best.score||(v.score===best.score&&v.amount>best.amount))best=v;
  }
  return {amount:best.amount,verified:best.arith,corroborated:best.arith||best.cashChange||best.reads.size>=2};
}
const BUSINESS=/\b(sdn\.?\s*bhd|s\/b|bhd|ltd|inc|llc|co\.|corp|enterprises?|trading|restaurant|cafe|market|mart|store|marine|warehouse|hardware|supply|supplies|depot|pharmacy|bakery|confectionery|shop|centre|center|marina|fuel|station|wawa|publix)\b/i;
function pickVendor(lines,reject){
  const looksLikeName=(l)=>{
    const flat=l.replace(/\s/g,"");
    return l.length>=3&&l.length<=70&&/[A-Za-z]{3,}/.test(l)&&(l.match(/[A-Za-z]/g)||[]).length/flat.length>=0.6&&!reject.test(l)&&
      !/^\W*[\d\s#()+.\/-]+\W*$/.test(l)&&!/^\d+\s+\w+\s+(st|street|ave|avenue|rd|road|blvd|drive|dr|hwy|highway)\b/i.test(l);
  };
  // strip OCR junk tokens off the ends ("Wawa #5194 a\t 1" -> "Wawa #5194")
  const tidy=(l)=>{const t=l.replace(/[|\\]+/g," ").split(/\s+/).filter(Boolean);
    while(t.length>1&&!/[A-Za-z0-9]{3,}/.test(t[t.length-1]))t.pop();return t.join(" ")};
  const rawHead=lines.slice(0,14);
  const named=rawHead.find((l)=>BUSINESS.test(l)&&!reject.test(l)&&/[A-Za-z]{3,}/.test(l)&&!/^\d/.test(l));
  if(named)return tidy(named);
  return rawHead.filter(looksLikeName)[0]||null;
}

export function parseOcrReceipt(text){
  const lines=String(text||"").split(/\r?\n/).map((x)=>x.replace(/\s+/g," ").trim()).filter(Boolean);
  const paymentText=lines.join(" ");
  const detected_payment_method=detectPaymentMethodFromText(paymentText);

  const total_candidates=totalCandidates(lines);
  const tender=tenderAmounts(lines);
  const amount=total_candidates.length?pickTotal([{total_candidates,tender,subtotal:labeledAmount(lines,/^subtotal\b/i),tax:labeledAmount(lines,/^(?:sales\s+)?tax\b/i)}]).amount:null;
  const subtotal=labeledAmount(lines,/^subtotal\b/i);
  const tax=labeledAmount(lines,/^(?:sales\s+)?tax\b/i);
  const total_verified=amount!==null&&subtotal!==null&&tax!==null&&Math.abs((subtotal+tax)-amount)<0.08;

  let receipt_date=null;
  for(const line of lines){receipt_date=isoReceiptDate(line);if(receipt_date)break}

  const reject=/\b(receipt|invoice|thank you|welcome|www\.|http|tel\b|phone\b|date\b|time\b|cashier\b|register\b|transaction\b|order\b|subtotal\b|total\b|tax\b|visa\b|mastercard\b|amex\b|payment\b|cash\b|change\b)\b/i;
  const vendor=pickVendor(lines,reject);

  return {
    vendor,receipt_date,amount,subtotal,tax,total_verified,total_candidates,tender,
    receipt_text:lines.join("\n"),
    suggested_category:suggestedCategoryFromText(text),
    detected_payment_method
  };
}

export function mergeOcrFields(full,top,bottom,confidence){
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

export function chooseBestAmount(parsedList){
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

// sharp's prebuilt binary cannot open HEIC (iPhone default), so convert those to JPEG first.
export function isHeic(b){return b.length>12&&b.toString("latin1",4,8)==="ftyp"&&/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(b.toString("latin1",8,12))}
export async function toReadable(buffer){return isHeic(buffer)?Buffer.from(await heicConvert({buffer,format:"JPEG",quality:0.9})):buffer}
async function prepare(buffer,resize){
  return sharp(buffer,{failOn:"none"}).rotate()
    .resize({height:3600,fit:"inside",...resize})
    .grayscale().normalize().sharpen()
    .extend({top:40,bottom:40,left:40,right:40,background:"white"})
    .png().toBuffer();
}
// Two stages so the slow Tesseract pass can be cached and the parser tuned offline.
// Read at normal size; if that comes back empty or weak (small crops read as blank),
// read again enlarged to 1800px wide and keep it only if it is clearly better.
export async function ocrRaw(buffer){
  buffer=await toReadable(buffer);
  const first=await ocrPass(await prepare(buffer,{width:2600,withoutEnlargement:true}));
  const len=first.full.trim().length;
  if(len>=60&&first.confidence>=30)return first;
  const second=await ocrPass(await prepare(buffer,{width:1800}));
  return second.full.trim().length>Math.max(len*2,60)?second:first;
}
async function ocrPass(base){
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

  return {
    full:fullResult?.data?.text||"",top:topResult?.data?.text||"",
    b1:bottomGrayResult?.data?.text||"",b2:bottom160Result?.data?.text||"",b3:bottom200Result?.data?.text||"",
    confidence:fullResult?.data?.confidence
  };
}
export function interpretRaw(raw){
  const full=parseOcrReceipt(raw.full);
  const top=parseOcrReceipt(raw.top);
  const b1=parseOcrReceipt(raw.b1);
  const b2=parseOcrReceipt(raw.b2);
  const b3=parseOcrReceipt(raw.b3);
  const pick=pickTotal([b1,b2,b3,full]);
  const amount=pick.amount;

  const merged=mergeOcrFields(full,top,b1,raw.confidence);
  merged.amount=amount;
  merged.total_verified=pick.verified;
  merged.total_corroborated=pick.corroborated;
  const combinedBottomText=[b1.receipt_text,b2.receipt_text,b3.receipt_text].filter(Boolean).join("\n");
  merged.detected_payment_method=detectPaymentMethodFromText(combinedBottomText)||merged.detected_payment_method;
  if(merged.amount===null&&!merged.review_reasons.includes("total"))merged.review_reasons.push("total");
  if(merged.amount!==null)merged.review_reasons=merged.review_reasons.filter((x)=>x!=="total");
  if(merged.amount!==null&&!pick.corroborated&&!merged.review_reasons.includes("total unverified"))merged.review_reasons.push("total unverified");
  merged.field_score=[merged.vendor,merged.receipt_date,merged.amount!==null,merged.detected_payment_method,merged.suggested_category].filter(Boolean).length;
  return merged;
}
export async function ocrImage(buffer){return interpretRaw(await ocrRaw(buffer))}
// Several photos of one long receipt: join the page texts and run the single-receipt logic once,
// so subtotal+tax / cash-change checks and agreeing reads work across pages.
// Vendor comes from the first page's top; the precise total reads (thresholded) from the last page's bottom.
export function combineRaws(raws,totalIdx=raws.length-1){
  const last=raws[totalIdx];
  return {
    full:raws.map((r)=>r.full).join("\n"),
    top:raws[0].top,
    b1:last.b1,b2:last.b2,b3:last.b3,
    confidence:raws.reduce((n,r)=>n+(Number(r.confidence)||0),0)/raws.length
  };
}

// Loose photos in one folder: guess which belong to the same long receipt.
// Same filename prefix, consecutive numbers, taken within 30s of each other, max 6 photos.
// ponytail: a guess, never trusted - the server always flags auto-groups for the captain
// (thumbnail strip + split). mtime is unreliable after a bulk sync, so a split is expected sometimes.
export function groupLoosePhotos(items,{gapMs=30000,maxPages=6}={}){
  const parse=(n)=>{const m=/^(.*?)(\d+)(\.[^.]*)?$/.exec(n);return m?{prefix:m[1],num:Number(m[2])}:{prefix:n,num:null}};
  const order=items.map((it,i)=>({...it,i,...parse(it.name)})).sort((a,b)=>a.prefix.localeCompare(b.prefix)||(a.num??0)-(b.num??0)||a.name.localeCompare(b.name));
  const groups=[];let cur=[];
  for(const it of order){
    const prev=cur[cur.length-1];
    const joins=prev&&prev.prefix===it.prefix&&prev.num!==null&&it.num===prev.num+1&&Math.abs((it.mtime||0)-(prev.mtime||0))<=gapMs&&cur.length<maxPages&&!/\.pdf$/i.test(it.name)&&!/\.pdf$/i.test(prev.name);
    if(joins)cur.push(it);else{if(cur.length)groups.push(cur);cur=[it]}
  }
  if(cur.length)groups.push(cur);
  return groups.map((g)=>g.map((x)=>x.i));
}

// Scanner-app PDFs (CamScanner etc.): render each page to an image so the normal photo OCR can read it.
// ponytail: renders at ~200dpi, max 12 pages; a longer PDF is cut off and the caller is told via truncated.
export function pdfToImages(buffer,{maxPages=12,dpi=200}={}){
  const doc=mupdf.Document.openDocument(buffer,"application/pdf");
  const total=doc.countPages(),n=Math.min(total,maxPages),out=[];
  for(let i=0;i<n;i++){
    const pix=doc.loadPage(i).toPixmap(mupdf.Matrix.scale(dpi/72,dpi/72),mupdf.ColorSpace.DeviceRGB,false,true);
    out.push(Buffer.from(pix.asJPEG(88,false)));
  }
  return{images:out,truncated:total>n,total};
}
