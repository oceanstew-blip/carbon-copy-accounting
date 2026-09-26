
let bootstrap={categories:[],cards:[],rules:[]};
let transactions=[];
let receiptInbox=[];

const $=(s)=>document.querySelector(s);
const $$=(s)=>Array.from(document.querySelectorAll(s));
const money=(n)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n||0));
const esc=(s='')=>String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const currentMonth=()=>($('#month')&&$('#month').value)||new Date().toISOString().slice(0,7);

function toast(msg){
  const t=$('#toast'); if(!t) return;
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2200);
}

async function api(path,opts={}){
  const r=await fetch('/api/'+path,opts);
  const ct=r.headers.get('content-type')||'';
  const d=ct.includes('json')?await r.json():await r.text();
  if(!r.ok) throw Object.assign(new Error((d&&d.error)||d||'Request failed'),{data:d,status:r.status});
  return d;
}

function showView(name){
  $$('.nav').forEach((b)=>b.classList.toggle('active',b.dataset.view===name));
  $$('.view').forEach((v)=>v.classList.toggle('active',v.id===name));
  if(name==='transactions') loadTransactions().catch(console.error);
  if(name==='receipts') loadReceiptInbox().catch(console.error);
}

function wireNavigation(){
  $$('.nav').forEach((b)=>{ b.addEventListener('click',()=>showView(b.dataset.view)); });
}

async function loadBootstrap(){
  bootstrap=await api('bootstrap');
  renderRules();
  renderReceiptForm();
}

async function loadDashboard(){
  const d=await api('dashboard?month='+encodeURIComponent(currentMonth()));
  const s=d.summary||{};
  const metrics=[
    ['Total Spend',money(s.total_spend)],
    ['Transactions',s.transactions||0],
    ['Missing Receipts',s.missing_receipts||0],
    ['Needs Category',s.needs_category||0],
    ['Needs Review',s.needs_review||0],
    ['Unmatched Receipts',s.unmatched_receipts||0]
  ];
  const box=$('#metrics');
  if(box) box.innerHTML=metrics.map((x)=>'<div class="metric"><strong>'+esc(x[1])+'</strong><span>'+esc(x[0])+'</span></div>').join('');
  renderBars('#byCategory',d.byCategory||[]);
  renderBars('#byVendor',d.byVendor||[]);
}

function renderBars(sel,rows){
  const el=$(sel); if(!el) return;
  const max=Math.max(1,...rows.map((r)=>Math.abs(Number(r.total)||0)));
  el.innerHTML=rows.length?rows.map((r)=>{
    const pct=Math.round(Math.abs(Number(r.total)||0)/max*100);
    return '<div class="barrow"><span>'+esc(r.name)+'</span><div class="bar"><i style="width:'+pct+'%"></i></div><b>'+money(r.total)+'</b></div>';
  }).join(''):'<p class="muted">No transactions yet.</p>';
}

async function loadTransactions(){
  const d=await api('transactions?month='+encodeURIComponent(currentMonth()));
  transactions=d.rows||[];
  renderTransactions();
}

function paymentLabel(t){
  if((t.payment_method||'credit_card')==='credit_card') return 'Credit Card •••• '+(t.last4||'0945');
  const names={wire:'Wire',check:'Check',cash:'Cash'};
  return names[t.payment_method]||t.payment_method||'';
}

function renderTransactions(){
  const body=$('#txBody'); if(!body) return;
  const by=($('#sortBy')&&$('#sortBy').value)||'date';
  const dir=(($('#sortDir')&&$('#sortDir').value)==='asc')?1:-1;
  const filter=($('#txFilter')&&$('#txFilter').value)||'all';
  let rows=transactions.slice();

  if(filter==='attention') rows=rows.filter((t)=>!t.category_id||!t.receipt_id||!t.captain_reviewed);
  if(filter==='uncategorized') rows=rows.filter((t)=>!t.category_id);
  if(filter==='missing') rows=rows.filter((t)=>!t.receipt_id);
  if(filter==='unreviewed') rows=rows.filter((t)=>!t.captain_reviewed);

  rows.sort((a,b)=>{
    let x,y;
    if(by==='vendor'){x=(a.vendor_normalized||a.vendor_raw||'').toLowerCase();y=(b.vendor_normalized||b.vendor_raw||'').toLowerCase();}
    else if(by==='amount'){x=Number(a.amount)||0;y=Number(b.amount)||0;}
    else if(by==='category'){x=(a.category_name||'').toLowerCase();y=(b.category_name||'').toLowerCase();}
    else if(by==='card'){x=paymentLabel(a);y=paymentLabel(b);}
    else {x=a.transaction_date||'';y=b.transaction_date||'';}
    return x<y?-dir:x>y?dir:0;
  });

  body.innerHTML=rows.length?rows.map((t)=>{
    const options='<option value="">Uncategorized</option>'+bootstrap.categories.map((c)=>'<option value="'+c.id+'" '+(Number(t.category_id)===Number(c.id)?'selected':'')+'>'+esc(c.name)+'</option>').join('');
    const receipt=t.receipt_id
      ? '<a class="receipt-link" target="_blank" href="/api/receipts/'+t.receipt_id+'">'+esc(t.file_name||'Receipt')+'</a>'
      : '<label class="missing">Upload<input class="receipt" data-id="'+t.id+'" type="file" accept="image/*,.pdf,.heic,.heif" hidden></label>';
    const payment=paymentLabel(t)+(t.payment_reference?' · '+esc(t.payment_reference):'');
    return '<tr><td>'+esc(String(t.transaction_date||'').slice(0,10))+'</td><td>'+esc(t.vendor_normalized||t.vendor_raw||'')+'</td><td><b>'+money(t.amount)+'</b></td><td><select class="cat" data-id="'+t.id+'">'+options+'</select></td><td>'+payment+'</td><td>'+receipt+'</td><td><input class="review" data-id="'+t.id+'" type="checkbox" '+(t.captain_reviewed?'checked':'')+'></td></tr>';
  }).join(''):'<tr><td colspan="7">No transactions yet.</td></tr>';

  bindTransactionControls();
}

function bindTransactionControls(){
  $$('.cat').forEach((el)=>el.addEventListener('change',async()=>{
    await api('transactions/'+el.dataset.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({category_id:Number(el.value)||null})});
    await Promise.all([loadTransactions(),loadDashboard()]);
  }));
  $$('.review').forEach((el)=>el.addEventListener('change',async()=>{
    await api('transactions/'+el.dataset.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({captain_reviewed:el.checked})});
    await loadDashboard();
  }));
  $$('.receipt').forEach((el)=>el.addEventListener('change',async()=>{
    const f=el.files&&el.files[0]; if(!f) return;
    const fd=new FormData(); fd.append('file',f); fd.append('transaction_id',el.dataset.id);
    await api('receipts',{method:'POST',body:fd});
    toast('Receipt attached');
    await Promise.all([loadTransactions(),loadDashboard(),loadReceiptInbox()]);
  }));
}

async function loadReceiptInbox(){
  const d=await api('receipt-inbox');
  receiptInbox=d.rows||[];
  const el=$('#receiptInbox'); if(!el) return;
  el.innerHTML=receiptInbox.length?receiptInbox.map((r)=>{
    return '<div class="receipt-item"><b>'+esc(r.vendor||r.file_name||'Receipt')+'</b><div class="muted">'+esc(String(r.receipt_date||'No date').slice(0,10))+' · '+(r.amount==null?'No amount':money(r.amount))+'</div><div><span class="badge">'+esc(r.category_name||'Uncategorized')+'</span> · <a target="_blank" href="/api/receipts/'+r.id+'">'+esc(r.file_name||'Receipt')+'</a></div></div>';
  }).join(''):'<p class="muted">Nothing waiting. All card receipts are matched.</p>';
}

function renderRules(){
  const cats=$('#categoryList');
  if(cats) cats.innerHTML=(bootstrap.categories||[]).map((c)=>'<div class="category-item">'+esc(c.name)+'</div>').join('');
  const rules=$('#ruleList');
  if(rules) rules.innerHTML=(bootstrap.rules||[]).length?(bootstrap.rules||[]).map((r)=>'<div class="rule-item"><b>'+esc(r.vendor_pattern)+'</b> → '+esc(r.category_name)+'</div>').join(''):'<p class="muted">No vendor rules yet.</p>';
  const sel=$('#ruleCategory');
  if(sel) sel.innerHTML=(bootstrap.categories||[]).map((c)=>'<option value="'+c.id+'">'+esc(c.name)+'</option>').join('');
}

function renderReceiptForm(){
  const sel=$('#rCategory'); if(!sel) return;
  sel.innerHTML='<option value="">Choose category</option>'+(bootstrap.categories||[]).map((c)=>'<option value="'+c.id+'">'+esc(c.name)+'</option>').join('');
}

function parseCSV(text){
  const lines=text.replace(/\r/g,'').split('\n').filter(Boolean);
  if(lines.length<2) return [];
  const parse=(line)=>{
    const out=[];let cur='',q=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}
      else if(ch===','&&!q){out.push(cur);cur='';}
      else cur+=ch;
    }
    out.push(cur);
    return out.map((x)=>x.trim());
  };
  const h=parse(lines[0]).map((x)=>x.toLowerCase().replace(/\./g,'').trim());
  const idx=(names)=>{for(const n of names){const i=h.findIndex((x)=>x===n||x.includes(n));if(i>=0)return i;}return-1;};
  const di=idx(['transaction date','date']),pi=idx(['posted date']),ci=idx(['card no','card']),vi=idx(['description','vendor','merchant']),ai=idx(['amount']),dei=idx(['debit']),cri=idx(['credit']);
  const normDate=(v)=>{const d=new Date(v);return /^\d{4}-\d{2}-\d{2}$/.test(v)?v:!isNaN(d)?d.toISOString().slice(0,10):'';};
  const num=(v)=>{if(v===undefined||v===null||String(v).trim()==='')return NaN;return Number(String(v).replace(/[$,()]/g,''));};
  return lines.slice(1).map((line)=>{
    const c=parse(line),de=num(c[dei]),cr=num(c[cri]);let amt=ai>=0?num(c[ai]):NaN;
    if(!Number.isFinite(amt)) amt=Number.isFinite(de)&&de!==0?Math.abs(de):Number.isFinite(cr)&&cr!==0?-Math.abs(cr):NaN;
    return {transaction_date:normDate(c[di]||''),posted_date:normDate(c[pi]||''),vendor_raw:c[vi]||'',amount:amt,card_last4:String(c[ci]||'0945').replace(/\D/g,'').slice(-4).padStart(4,'0'),payment_method:'credit_card',source:'capital-one-csv'};
  }).filter((r)=>r.transaction_date&&r.vendor_raw&&Number.isFinite(r.amount));
}

function wireStaticControls(){
  const monthEl=$('#month');
  if(monthEl){monthEl.value=new Date().toISOString().slice(0,7);monthEl.addEventListener('change',()=>Promise.all([loadDashboard(),loadTransactions()]));}
  if($('#refresh')) $('#refresh').addEventListener('click',()=>Promise.all([loadDashboard(),loadTransactions(),loadReceiptInbox()]));
  if($('#txFilter')) $('#txFilter').addEventListener('change',renderTransactions);
  if($('#sortBy')) $('#sortBy').addEventListener('change',renderTransactions);
  if($('#sortDir')) $('#sortDir').addEventListener('change',renderTransactions);

  if($('#importCsv')) $('#importCsv').addEventListener('click',async()=>{
    const f=$('#csvFile').files&&$('#csvFile').files[0]; if(!f) return toast('Choose a CSV first');
    const rows=parseCSV(await f.text());
    const r=await api('transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rows})});
    $('#importStatus').innerHTML='<p class="ok">Imported '+r.inserted+'; skipped '+r.skipped+' duplicates/invalid; matched '+(r.receipts_matched||0)+' waiting receipts.</p>';
    await Promise.all([loadDashboard(),loadTransactions(),loadReceiptInbox()]);
  });

  if($('#addManual')) $('#addManual').addEventListener('click',async()=>{
    await api('transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      transaction_date:$('#mDate').value,vendor_raw:$('#mVendor').value,amount:Number($('#mAmount').value),
      source:'manual',payment_method:$('#mPayment').value,payment_reference:$('#mReference').value
    })});
    toast('Expense added');
    await Promise.all([loadDashboard(),loadTransactions()]);
  });

  if($('#uploadReceipt')) $('#uploadReceipt').addEventListener('click',async()=>{
    const f=$('#rFile').files&&$('#rFile').files[0]; if(!f) return toast('Choose a receipt image or PDF');
    const fd=new FormData();
    fd.append('file',f);fd.append('receipt_date',$('#rDate').value);fd.append('vendor',$('#rVendor').value);fd.append('amount',$('#rAmount').value);
    fd.append('payment_method',$('#rPayment').value);fd.append('payment_reference',$('#rReference').value);fd.append('receipt_text',$('#rText').value);
    if($('#rCategory').value) fd.append('category_id',$('#rCategory').value);
    const r=await api('receipts',{method:'POST',body:fd});
    const nonCard=['cash','wire','check'].includes(r.payment_method);
    let msg='Saved.';
    if(r.duplicate&&r.promoted) msg='Existing receipt converted to '+String(r.payment_method).toUpperCase()+' and added to Transactions.';
    else if(r.duplicate) msg='Already uploaded.';
    else if(nonCard&&r.created_transaction_id) msg='Saved as '+String(r.payment_method).toUpperCase()+' and added to Transactions.';
    else if(r.matched_transaction_id) msg='Saved and matched to the credit-card transaction.';
    else msg='Saved. Waiting for the matching credit-card transaction.';
    $('#receiptUploadStatus').innerHTML='<p class="ok">'+esc(msg)+'</p>';
    await Promise.all([loadReceiptInbox(),loadTransactions(),loadDashboard()]);
  });

  if($('#addCategory')) $('#addCategory').addEventListener('click',async()=>{
    await api('categories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:$('#newCategory').value})});
    $('#newCategory').value='';await loadBootstrap();
  });
  if($('#addRule')) $('#addRule').addEventListener('click',async()=>{
    await api('vendor-rules',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({vendor_pattern:$('#ruleVendor').value,category_id:Number($('#ruleCategory').value)})});
    $('#ruleVendor').value='';await loadBootstrap();
  });
  if($('#closeMonth')) $('#closeMonth').addEventListener('click',async()=>{
    try{
      const r=await api('close-month',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({month:currentMonth()})});
      $('#closeStatus').innerHTML='<p class="ok">'+esc(r.month)+' closed successfully.</p>';
    }catch(e){
      const b=e.data&&e.data.blockers;
      $('#closeStatus').innerHTML=b?'<p class="warn">Cannot close: '+b.uncategorized+' uncategorized, '+b.missing_receipts+' missing receipts, '+b.unreviewed+' unreviewed, '+(b.unmatched_receipts||0)+' unmatched receipts.</p>':'<p class="warn">'+esc(e.message)+'</p>';
    }
  });

  if($('#exportCsv')) $('#exportCsv').addEventListener('click',()=>{
    const head=['Date','Vendor','Amount','Category','Payment Method','Payment Reference','Receipt','Reviewed'];
    const rows=transactions.map((t)=>[t.transaction_date,t.vendor_normalized||t.vendor_raw,t.amount,t.category_name||'',t.payment_method||'credit_card',t.payment_reference||'',t.receipt_id?'Yes':'No',t.captain_reviewed?'Yes':'No']);
    const csv=[head,...rows].map((r)=>r.map((v)=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='carbon-copy-'+currentMonth()+'.csv';a.click();
  });

  if($('#runReport')) $('#runReport').addEventListener('click',async()=>{
    const scope=$('#reportScope').value,year=Number($('#reportYear').value)||new Date().getFullYear(),m=Number($('#reportMonth').value)||new Date().getMonth()+1,q=Number($('#reportQuarter').value)||Math.floor(new Date().getMonth()/3)+1;
    const r=await api('report?scope='+scope+'&year='+year+'&month='+m+'&quarter='+q);
    const categories=(r.byCategory||[]).map((x)=>'<div class="barrow"><span>'+esc(x.name)+'</span><span></span><b>'+money(x.total)+'</b></div>').join('');
    const payments=(r.byPaymentMethod||[]).map((x)=>'<div class="barrow"><span>'+esc(String(x.name||'').replace('_',' '))+'</span><span></span><b>'+money(x.total)+'</b></div>').join('');
    const vendors=(r.topVendors||[]).map((x)=>'<div class="barrow"><span>'+esc(x.name)+'</span><span></span><b>'+money(x.total)+'</b></div>').join('');
    $('#reportOutput').innerHTML='<h2>'+esc(r.label)+'</h2><p><b>Total:</b> '+money(r.summary.total)+' · <b>Transactions:</b> '+r.summary.transaction_count+'</p><div class="grid2"><div><h3>By Category</h3>'+categories+'</div><div><h3>By Payment Method</h3>'+payments+'</div></div><h3>Top Vendors</h3>'+vendors;
  });
}

async function boot(){
  wireNavigation();
  wireStaticControls();
  try{
    await loadBootstrap();
    await Promise.all([loadDashboard(),loadTransactions(),loadReceiptInbox()]);
  }catch(e){
    console.error(e);
    toast('Some data could not load, but navigation is available.');
  }
}

boot();
