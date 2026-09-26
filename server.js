import express from "express";
import multer from "multer";
import pg from "pg";

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function auth(req,res,next){
  const user=process.env.APP_USERNAME, pass=process.env.APP_PASSWORD;
  if(!user || !pass) return next();
  const h=req.headers.authorization||"";
  if(!h.startsWith("Basic ")) { res.set("WWW-Authenticate",'Basic realm="Carbon Copy Accounting"'); return res.status(401).send("Login required"); }
  const [u,p]=Buffer.from(h.slice(6),"base64").toString().split(":");
  if(u!==user || p!==pass){ res.set("WWW-Authenticate",'Basic realm="Carbon Copy Accounting"'); return res.status(401).send("Invalid login"); }
  next();
}
app.use(auth);
app.use(express.json({limit:"5mb"}));
app.use(express.static("public"));

function monthBounds(month){
  const m=/^\d{4}-\d{2}$/.test(month||"")?month:new Date().toISOString().slice(0,7);
  const [y,mo]=m.split("-").map(Number);
  const start=m+"-01";
  const next=new Date(Date.UTC(y,mo,1)).toISOString().slice(0,10);
  return {month:m,start,next};
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
      id BIGSERIAL PRIMARY KEY,transaction_id BIGINT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,file_size BIGINT NOT NULL,file_data BYTEA NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS vendor_rules(
      id BIGSERIAL PRIMARY KEY,vendor_pattern TEXT NOT NULL UNIQUE,category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      approved BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS month_closes(
      id BIGSERIAL PRIMARY KEY,month_start DATE NOT NULL UNIQUE,calculated_total NUMERIC(12,2),closed BOOLEAN NOT NULL DEFAULT FALSE,closed_at TIMESTAMPTZ);
  `);
  await pool.query("INSERT INTO cards(label,last4) VALUES($1,$2) ON CONFLICT(last4) DO NOTHING",["Capital One","0945"]);
  const cats=["Fuel & Lubricants","Dockage / Marina","Repairs & Maintenance","Provisions","Supplies","Insurance","Communications / Internet","Crew Travel","Crew Meals","Training / Certifications","Safety Equipment","Tender / Toys","Professional Services","Shipping / Freight","Customs / Port Fees","Guest Expenses","Transportation","Capital Improvements","Owner / Personal","Miscellaneous"];
  for(let i=0;i<cats.length;i++) await pool.query("INSERT INTO categories(name,sort_order) VALUES($1,$2) ON CONFLICT(name) DO NOTHING",[cats[i],(i+1)*10]);
}
app.get("/health",(_req,res)=>res.json({ok:true}));

app.get("/api/bootstrap",async(_req,res,next)=>{try{
  const [c,cd,r]=await Promise.all([
    pool.query("SELECT id,name,sort_order FROM categories WHERE active=true ORDER BY sort_order,name"),
    pool.query("SELECT id,label,last4 FROM cards WHERE active=true ORDER BY id"),
    pool.query("SELECT vr.id,vr.vendor_pattern,vr.category_id,c.name category_name FROM vendor_rules vr JOIN categories c ON c.id=vr.category_id ORDER BY vr.vendor_pattern")
  ]); res.json({categories:c.rows,cards:cd.rows,rules:r.rows});
}catch(e){next(e)}});

app.get("/api/dashboard",async(req,res,next)=>{try{
  const {month,start,next:n}=monthBounds(req.query.month);
  const [s,bc,bv]=await Promise.all([
    pool.query(`SELECT COUNT(*)::int transactions,COALESCE(SUM(amount),0)::numeric total_spend,
      COUNT(*) FILTER(WHERE category_id IS NULL)::int needs_category,
      COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts,
      COUNT(*) FILTER(WHERE captain_reviewed=false)::int needs_review
      FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
      WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date`,[start,n]),
    pool.query(`SELECT COALESCE(c.name,'Uncategorized') name,COALESCE(SUM(t.amount),0)::numeric total
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date
      GROUP BY 1 ORDER BY total DESC`,[start,n]),
    pool.query(`SELECT COALESCE(NULLIF(vendor_normalized,''),vendor_raw) name,SUM(amount)::numeric total,COUNT(*)::int count
      FROM transactions WHERE status='posted' AND transaction_date >= $1::date AND transaction_date < $2::date
      GROUP BY 1 ORDER BY total DESC LIMIT 12`,[start,n])
  ]);
  res.json({month,summary:s.rows[0],byCategory:bc.rows,byVendor:bv.rows});
}catch(e){next(e)}});

app.get("/api/transactions",async(req,res,next)=>{try{
  const {start,next:n}=monthBounds(req.query.month);
  const q=await pool.query(`SELECT t.id,t.transaction_date,t.posted_date,t.vendor_raw,t.vendor_normalized,t.amount,t.notes,t.status,t.captain_reviewed,
    c.id category_id,c.name category_name,cd.last4,r.id receipt_id,r.file_name
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN cards cd ON cd.id=t.card_id LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.transaction_date >= $1::date AND t.transaction_date < $2::date ORDER BY t.transaction_date DESC,t.id DESC`,[start,n]);
  res.json({rows:q.rows});
}catch(e){next(e)}});

app.post("/api/transactions",async(req,res,next)=>{try{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[req.body];
  const card=(await pool.query("SELECT id FROM cards WHERE last4='0945' LIMIT 1")).rows[0];
  let inserted=0,skipped=0;
  for(const row of rows){
    const date=String(row.transaction_date||row.date||"").slice(0,10), vendor=String(row.vendor_raw||row.vendor||row.description||"").trim(), amount=Number(row.amount);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!vendor||!Number.isFinite(amount)){skipped++;continue}
    const rule=(await pool.query("SELECT category_id FROM vendor_rules WHERE $1 ILIKE '%'||vendor_pattern||'%' ORDER BY length(vendor_pattern) DESC LIMIT 1",[vendor])).rows[0];
    try{
      await pool.query(`INSERT INTO transactions(transaction_date,posted_date,vendor_raw,vendor_normalized,amount,category_id,card_id,source,external_id,status)
        VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9)`,[date,row.posted_date||null,vendor,amount,rule?.category_id||null,card?.id||null,row.source||"import",row.external_id||null,row.status==="pending"?"pending":"posted"]);
      inserted++;
    }catch(e){if(e.code==="23505")skipped++;else throw e}
  }
  res.status(201).json({inserted,skipped});
}catch(e){next(e)}});

app.patch("/api/transactions/:id",async(req,res,next)=>{try{
  const id=Number(req.params.id); if(!Number.isFinite(id)) return res.status(400).json({error:"Invalid transaction id"});
  const current=(await pool.query("SELECT * FROM transactions WHERE id=$1",[id])).rows[0]; if(!current)return res.status(404).json({error:"Not found"});
  const b=req.body;
  await pool.query(`UPDATE transactions SET category_id=$1,notes=$2,captain_reviewed=$3,vendor_normalized=$4,updated_at=NOW() WHERE id=$5`,[
    b.category_id===undefined?current.category_id:b.category_id,b.notes===undefined?current.notes:b.notes,
    b.captain_reviewed===undefined?current.captain_reviewed:b.captain_reviewed,b.vendor_normalized===undefined?current.vendor_normalized:b.vendor_normalized,id]);
  res.json({ok:true});
}catch(e){next(e)}});

app.post("/api/categories",async(req,res,next)=>{try{
  const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"Category required"});
  const q=await pool.query("INSERT INTO categories(name,sort_order) VALUES($1,999) ON CONFLICT(name) DO UPDATE SET active=true RETURNING id,name,sort_order",[name]);
  res.status(201).json(q.rows[0]);
}catch(e){next(e)}});

app.post("/api/vendor-rules",async(req,res,next)=>{try{
  const vendor=String(req.body.vendor_pattern||"").trim(),cid=Number(req.body.category_id);
  if(!vendor||!Number.isFinite(cid))return res.status(400).json({error:"Vendor and category required"});
  const q=await pool.query(`INSERT INTO vendor_rules(vendor_pattern,category_id) VALUES($1,$2)
    ON CONFLICT(vendor_pattern) DO UPDATE SET category_id=EXCLUDED.category_id,approved=true RETURNING id,vendor_pattern,category_id`,[vendor,cid]);
  res.status(201).json(q.rows[0]);
}catch(e){next(e)}});

app.post("/api/receipts",upload.single("file"),async(req,res,next)=>{try{
  const tid=Number(req.body.transaction_id),f=req.file;
  if(!f||!Number.isFinite(tid))return res.status(400).json({error:"Receipt file and transaction required"});
  const allowed=["image/jpeg","image/png","image/webp","application/pdf"]; if(!allowed.includes(f.mimetype))return res.status(415).json({error:"Use JPG, PNG, WEBP or PDF"});
  await pool.query("DELETE FROM receipts WHERE transaction_id=$1",[tid]);
  const q=await pool.query("INSERT INTO receipts(transaction_id,file_name,content_type,file_size,file_data) VALUES($1,$2,$3,$4,$5) RETURNING id,file_name",[tid,f.originalname,f.mimetype,f.size,f.buffer]);
  res.status(201).json(q.rows[0]);
}catch(e){next(e)}});

app.get("/api/receipts/:id",async(req,res,next)=>{try{
  const q=await pool.query("SELECT file_name,content_type,file_data FROM receipts WHERE id=$1",[Number(req.params.id)]);const r=q.rows[0];if(!r)return res.sendStatus(404);
  res.type(r.content_type);res.set("Content-Disposition",`inline; filename="${String(r.file_name).replaceAll('"','')}"`);res.send(r.file_data);
}catch(e){next(e)}});

app.post("/api/close-month",async(req,res,next)=>{try{
  const {month,start,next:n}=monthBounds(req.body.month);
  const q=await pool.query(`SELECT COUNT(*) FILTER(WHERE category_id IS NULL)::int uncategorized,
    COUNT(*) FILTER(WHERE r.id IS NULL)::int missing_receipts,COUNT(*) FILTER(WHERE captain_reviewed=false)::int unreviewed,
    COALESCE(SUM(amount),0)::numeric total FROM transactions t LEFT JOIN receipts r ON r.transaction_id=t.id
    WHERE t.status='posted' AND t.transaction_date >= $1::date AND t.transaction_date < $2::date`,[start,n]);
  const c=q.rows[0];if(c.uncategorized||c.missing_receipts||c.unreviewed)return res.status(409).json({closed:false,blockers:c});
  await pool.query(`INSERT INTO month_closes(month_start,calculated_total,closed,closed_at) VALUES($1,$2,true,NOW())
    ON CONFLICT(month_start) DO UPDATE SET calculated_total=EXCLUDED.calculated_total,closed=true,closed_at=NOW()`,[start,Number(c.total)]);
  res.json({closed:true,month});
}catch(e){next(e)}});

app.use((err,_req,res,_next)=>{console.error(err);if(err.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"Receipt must be under 15MB"});res.status(500).json({error:"Server error"});});

await init();
app.listen(port,"0.0.0.0",()=>console.log(`Carbon Copy Accounting listening on ${port}`));
