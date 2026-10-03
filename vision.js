// Optional second reader: a vision model reads the receipt image(s) and Tesseract cross-checks it.
// Off unless ANTHROPIC_API_KEY is set. Any failure falls back to the Tesseract result, never blocks a receipt.
import sharp from "sharp";
import { azureRegions } from "./receiptsplit.js";

const PROMPT=`These images are the pages of ONE receipt, top to bottom, in order. Read the printed text exactly; never guess a digit.
Return ONLY a JSON object with these keys (null when not printed or not legible):
vendor (business name, not the address), date (YYYY-MM-DD; if day/month are ambiguous prefer month-first unless a number is over 12),
total (the final amount charged, number), subtotal (number), tax (number),
payment_method (one of credit_card, cash, check, wire), card_last4 (4 digits if shown, else null),
total_page (1-based page where the final total is printed).`;

const azureOn=()=>Boolean(process.env.AZURE_DI_ENDPOINT&&process.env.AZURE_DI_KEY);
export const visionEnabled=()=>azureOn()||Boolean(process.env.ANTHROPIC_API_KEY);
export const visionEngine=()=>azureOn()?"azure-document-intelligence":process.env.ANTHROPIC_API_KEY?"claude-vision":null;
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const money=(f)=>f?.valueCurrency?.amount??f?.valueNumber??null;
// One line, single spaces, no stray symbols left on either end ("THE\nHOME\nDEPOT\n@" -> "THE HOME DEPOT").
export const tidyVendor=(s)=>String(s||"").replace(/\s+/g," ").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.)!]+$/g,"").trim()||null;

// Azure AI Document Intelligence, prebuilt receipt model. One document per call: a PDF goes up as-is,
// several photos are stacked into one tall image first.
async function azureRead(buffers,{fetchImpl=fetch,original=null}={}){
  let bytes=original;
  if(!bytes){
    const imgs=await Promise.all(buffers.map((b)=>sharp(b,{failOn:"none"}).rotate().resize({width:1800,withoutEnlargement:true}).png().toBuffer()));
    if(imgs.length===1)bytes=imgs[0];
    else{
      const meta=await Promise.all(imgs.map((b)=>sharp(b).metadata()));
      const w=Math.max(...meta.map((m)=>m.width)),h=meta.reduce((n,m)=>n+m.height,0);
      let top=0;
      bytes=await sharp({create:{width:w,height:h,channels:3,background:"white"}}).composite(imgs.map((input,i)=>{const o={input,left:0,top};top+=meta[i].height;return o})).jpeg({quality:90}).toBuffer();
    }
  }
  const base=process.env.AZURE_DI_ENDPOINT.replace(/\/$/,"");
  const headers={"Ocp-Apim-Subscription-Key":process.env.AZURE_DI_KEY};
  // Azure's free tier throttles bursts (429): wait as long as it asks and try again.
  const call=async(url,init)=>{
    for(let n=0;;n++){
      const r=await fetchImpl(url,init);
      if((r.status!==429&&r.status!==503)||n>=5)return r;
      const ra=Number(r.headers.get("retry-after"));
      await sleep(Math.min(15000,Number.isFinite(ra)&&ra>=0?ra*1000:2000*(n+1)));
    }
  };
  const start=await call(`${base}/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30`,{
    method:"POST",headers:{...headers,"content-type":"application/json"},
    body:JSON.stringify({base64Source:bytes.toString("base64")}),signal:AbortSignal.timeout(30000)
  });
  if(start.status!==202)throw new Error(`azure analyze ${start.status}`);
  const poll=start.headers.get("operation-location");if(!poll)throw new Error("azure gave no operation location");
  for(let i=0;i<40;i++){
    await sleep(i?1000:500);
    const r=await call(poll,{headers,signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw new Error(`azure poll ${r.status}`);
    const j=await r.json();
    if(j.status==="failed")throw new Error("azure analysis failed");
    if(j.status!=="succeeded")continue;
    const docs=j.analyzeResult?.documents||[];
    if(!docs.length)return{vendor:null,receipt_date:null,amount:null,subtotal:null,tax:null,detected_payment_method:null,card_last4:null,total_page:null,multiple:false,conf:{}};
    const d=docs[0].fields||{};
    const num=(x)=>x==null?null:Math.round(Number(x)*100)/100;
    return{
      vendor:tidyVendor(d.MerchantName?.valueString),
      receipt_date:/^\d{4}-\d{2}-\d{2}$/.test(d.TransactionDate?.valueDate||"")?d.TransactionDate.valueDate:null,
      amount:num(money(d.Total)),subtotal:num(money(d.Subtotal)),tax:num(money(d.TotalTax)),
      detected_payment_method:null,card_last4:null,total_page:null,multiple:docs.length>1,
      regions:azureRegions(j.analyzeResult),
      conf:{total:d.Total?.confidence??null,vendor:d.MerchantName?.confidence??null,date:d.TransactionDate?.confidence??null}
    };
  }
  throw new Error("azure analysis timed out");
}

export async function visionRead(buffers,opts={}){
  if(azureOn())return azureRead(buffers,opts);
  const {fetchImpl=fetch}=opts;
  const content=[];
  for(const b of buffers){
    const jpeg=await sharp(b,{failOn:"none"}).rotate().resize({width:1600,height:2400,fit:"inside",withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
    content.push({type:"image",source:{type:"base64",media_type:"image/jpeg",data:jpeg.toString("base64")}});
  }
  content.push({type:"text",text:PROMPT});
  const res=await fetchImpl(`${process.env.ANTHROPIC_BASE_URL||"https://api.anthropic.com"}/v1/messages`,{
    method:"POST",
    headers:{"x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},
    body:JSON.stringify({model:process.env.OCR_VISION_MODEL||"claude-sonnet-5-5",max_tokens:500,messages:[{role:"user",content}]}),
    signal:AbortSignal.timeout(60000)
  });
  if(!res.ok)throw new Error(`vision API ${res.status}`);
  const text=(await res.json()).content?.map((c)=>c.text||"").join("")||"";
  const m=text.match(/\{[\s\S]*\}/);if(!m)throw new Error("vision reply had no JSON");
  const j=JSON.parse(m[0]);
  const num=(x)=>x==null||x===""?null:Number.isFinite(Number(x))?Math.round(Number(x)*100)/100:null;
  return{
    vendor:typeof j.vendor==="string"&&j.vendor.trim()?j.vendor.trim():null,
    receipt_date:/^\d{4}-\d{2}-\d{2}$/.test(j.date||"")?j.date:null,
    amount:num(j.total),subtotal:num(j.subtotal),tax:num(j.tax),
    detected_payment_method:["credit_card","cash","check","wire"].includes(j.payment_method)?j.payment_method:null,
    card_last4:/^\d{4}$/.test(String(j.card_last4||""))?String(j.card_last4):null,
    total_page:Number.isInteger(j.total_page)?j.total_page:null
  };
}

// Vision fills the fields; Tesseract's independent read decides whether the total is corroborated.
// Disagreement is flagged for the captain - it never silently picks one.
export function applyVision(tess,v){
  if(!v)return tess;
  const out={...tess,review_reasons:[...(tess.review_reasons||[])],vision:v};
  if(v.vendor)out.vendor=v.vendor;
  if(v.receipt_date)out.receipt_date=v.receipt_date;
  if(v.detected_payment_method)out.detected_payment_method=v.detected_payment_method;
  const strip=(r)=>{out.review_reasons=out.review_reasons.filter((x)=>x!==r)};
  if(v.vendor)strip("vendor");if(v.receipt_date)strip("date");if(v.detected_payment_method)strip("payment method");
  if(v.amount!=null){
    const agrees=tess.amount!=null&&Math.abs(tess.amount-v.amount)<0.01;
    const arithmetic=v.subtotal!=null&&v.tax!=null&&Math.abs(v.subtotal+v.tax-v.amount)<0.02;
    out.amount=v.amount;strip("total");strip("total unverified");strip("total arithmetic");
    out.total_verified=arithmetic;out.total_corroborated=agrees||arithmetic;
    if(!agrees&&!arithmetic)out.review_reasons.push(tess.amount==null?"total unverified":"total disagrees with second read");
    if(!agrees&&!arithmetic&&v.conf?.total!=null&&v.conf.total<0.8)out.review_reasons.push("total low confidence");
  }
  if(v.multiple)out.review_reasons.push("more than one receipt detected in this file");
  out.field_score=[out.vendor,out.receipt_date,out.amount!=null,out.detected_payment_method,out.suggested_category].filter(Boolean).length;
  return out;
}

// A receipt dated months ago (or in the future) is almost always a misread or a wrong printer clock.
export function dateSanity(d,today=new Date()){
  if(!d?.receipt_date)return d;
  const days=(today-new Date(`${d.receipt_date}T12:00:00Z`))/864e5;
  if((days>100||days<-3)&&!d.review_reasons.includes("date looks wrong"))d={...d,review_reasons:[...d.review_reasons,"date looks wrong"]};
  return d;
}

// Tesseract result in, best available result out.
export async function withVision(tess,buffers,opts){
  if(!visionEnabled())return dateSanity(tess);
  try{return dateSanity(applyVision(tess,await visionRead(buffers,opts)))}
  catch(e){console.error("VISION_READ_FAILED",e.message);return dateSanity(tess)}
}
