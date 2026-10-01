// Optional second reader: a vision model reads the receipt image(s) and Tesseract cross-checks it.
// Off unless ANTHROPIC_API_KEY is set. Any failure falls back to the Tesseract result, never blocks a receipt.
import sharp from "sharp";

const PROMPT=`These images are the pages of ONE receipt, top to bottom, in order. Read the printed text exactly; never guess a digit.
Return ONLY a JSON object with these keys (null when not printed or not legible):
vendor (business name, not the address), date (YYYY-MM-DD; if day/month are ambiguous prefer month-first unless a number is over 12),
total (the final amount charged, number), subtotal (number), tax (number),
payment_method (one of credit_card, cash, check, wire), card_last4 (4 digits if shown, else null),
total_page (1-based page where the final total is printed).`;

export const visionEnabled=()=>Boolean(process.env.ANTHROPIC_API_KEY);

export async function visionRead(buffers,{fetchImpl=fetch}={}){
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
  }
  out.field_score=[out.vendor,out.receipt_date,out.amount!=null,out.detected_payment_method,out.suggested_category].filter(Boolean).length;
  return out;
}

// Tesseract result in, best available result out.
export async function withVision(tess,buffers,opts){
  if(!visionEnabled())return tess;
  try{return applyVision(tess,await visionRead(buffers,opts))}
  catch(e){console.error("VISION_READ_FAILED",e.message);return tess}
}
