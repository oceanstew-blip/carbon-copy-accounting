
let bootstrap={categories:[],cards:[],rules:[]};
let transactions=[];
let pendingReceipts=[]; // credit-card receipts waiting for their card charge; never part of totals or exports
let receiptInbox=[];
let editingReceiptId=null;
let systemCheckRunning=false;

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
  if(name==='system') runSystemCheck().catch(console.error);
}

function wireNavigation(){
  $$('.nav').forEach((b)=>{ b.addEventListener('click',()=>showView(b.dataset.view)); });
}

async function loadBootstrap(){
  bootstrap=await api('bootstrap');
  renderRules();
  renderReceiptForm();
  renderMailSettings();
  renderDriveBackup();
}

async function renderDriveBackup(){
  const box=$('#driveBackup');
  if(!box) return;
  let v={};
  try{v=await api('vessel')}catch(e){return}
  if(!v.driveAccount&&!v.driveFolderUrl) return;
  $('#driveBackupText').textContent=v.driveAccount?('Receipts are saved automatically to the Google Drive of '+v.driveAccount+' (folder: '+(v.driveFolderName||'Receipts')+'). Sign in to that Google account to see them.'):'Receipts are saved automatically to Google Drive.';
  const l=$('#driveFolderLink');
  if(l&&v.driveFolderUrl){l.href=v.driveFolderUrl;l.hidden=false}
  box.hidden=false;
}

function setupFolderUpload(){
  const pick=$('#folderPick'),btn=$('#folderUploadBtn'),out=$('#folderUploadStatus');
  if(!pick||!btn) return;
  btn.addEventListener('click',()=>pick.click());
  pick.addEventListener('change',async()=>{
    const all=[...pick.files];
    const okType=/\.(jpe?g|png|webp|heic|heif|pdf)$/i,MAX=20*1024*1024;
    const rel=(f)=>f.webkitRelativePath||f.name;
    const usable=all.filter((f)=>okType.test(f.name)&&!/(^|\/)Done\//.test(rel(f)));
    const tooBig=usable.filter((f)=>f.size>MAX);
    const files=usable.filter((f)=>f.size<=MAX).sort((a,b)=>rel(a).localeCompare(rel(b),undefined,{numeric:true}));
    const skipped=all.length-usable.length;
    if(!files.length){out.textContent='No receipt photos or PDFs found in that folder.';pick.value='';return}
    if(!confirm('Upload '+files.length+' file'+(files.length===1?'':'s')+' from this folder? Each one is read and added as a receipt. Duplicates are skipped.')){pick.value='';return}
    btn.disabled=true;
    const tally={ingested:0,duplicate:0,failed:0},problems=[];
    const BATCH=15;
    for(let i=0;i<files.length;i+=BATCH){
      const batch=files.slice(i,i+BATCH);
      out.textContent='Uploading '+Math.min(i+BATCH,files.length)+' of '+files.length+'... please keep this page open.';
      const fd=new FormData();
      fd.append('mode','auto');
      fd.append('mtimes',JSON.stringify(batch.map((f)=>f.lastModified)));
      batch.forEach((f)=>fd.append('files',f,f.name));
      try{
        const res=await api('receipts/inbox',{method:'POST',body:fd});
        (res.groups||[]).forEach((g)=>{
          if(g.status==='ingested') tally.ingested++;
          else if(g.status==='duplicate') tally.duplicate++;
          else{tally.failed++;problems.push((g.files||[]).join(', ')+': '+(g.error||'could not be read'))}
        });
      }catch(e){tally.failed+=batch.length;problems.push(batch.length+' files ('+batch[0].name+' ...): '+e.message)}
    }
    tooBig.forEach((f)=>problems.push(f.name+': larger than 20 MB, not uploaded'));
    let msg='Done. '+tally.ingested+' new receipt'+(tally.ingested===1?'':'s')+', '+tally.duplicate+' already in the system'+(tally.failed?', '+tally.failed+' failed':'')+'.';
    if(skipped) msg+=' '+skipped+' other file'+(skipped===1?'':'s')+' (not photos or PDFs) '+(skipped===1?'was':'were')+' ignored.';
    out.innerHTML=esc(msg)+(problems.length?'<ul>'+problems.map((p)=>'<li>'+esc(p)+'</li>').join('')+'</ul>':'');
    pick.value='';btn.disabled=false;
    Promise.all([loadDashboard(),loadTransactions(),loadReceiptInbox()]).catch(console.error);
  });
}

function renderMailSettings(){
  const from=$('#settingsMailFrom'),to=$('#settingsAlertTo');
  if(from) from.value=bootstrap.mail_from||'';
  if(to) to.value=bootstrap.alert_email_to||'';
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
  pendingReceipts=d.pending||[];
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

  // Pending card receipts sit above the real rows (all-transactions view only) and are visibly not posted.
  const pendingHtml=(filter==='all'?pendingReceipts:[]).map((p)=>
    '<tr class="pending"><td>'+esc(String(p.transaction_date||'').slice(0,10))+'</td><td>'+esc(p.vendor_raw||p.file_name||'Receipt')+'</td><td><b>'+money(p.amount)+'</b></td><td>'+esc(p.category_name||'Uncategorized')+'</td>'+
    '<td><span class="badge">Awaiting card match</span>'+(p.review_required?' <span class="muted">· unconfirmed</span>':'')+'</td>'+
    '<td><a class="receipt-link" target="_blank" href="/api/receipts/'+p.receipt_id+'">'+esc(p.file_name||'Receipt')+'</a></td>'+
    '<td><button class="pending-fix" data-id="'+p.receipt_id+'" type="button">Review / Fix</button></td></tr>').join('');

  body.innerHTML=pendingHtml+(rows.length?rows.map((t)=>{
    const options='<option value="">Uncategorized</option>'+bootstrap.categories.map((c)=>'<option value="'+c.id+'" '+(Number(t.category_id)===Number(c.id)?'selected':'')+'>'+esc(c.name)+'</option>').join('');
    const receipt=t.receipt_id
      ? '<a class="receipt-link" target="_blank" href="/api/receipts/'+t.receipt_id+'">'+esc(t.file_name||'Receipt')+'</a>'
      : '<label class="missing">Upload<input class="receipt" data-id="'+t.id+'" type="file" accept="image/*,.pdf,.heic,.heif" hidden></label>';
    const payment=paymentLabel(t)+(t.payment_reference?' · '+esc(t.payment_reference):'');
    return '<tr><td>'+esc(String(t.transaction_date||'').slice(0,10))+'</td><td>'+esc(t.vendor_normalized||t.vendor_raw||'')+'</td><td><b>'+money(t.amount)+'</b></td><td><select class="cat" data-id="'+t.id+'">'+options+'</select></td><td>'+payment+'</td><td>'+receipt+'</td><td><input class="review" data-id="'+t.id+'" type="checkbox" '+(t.captain_reviewed?'checked':'')+'></td></tr>';
  }).join(''):(pendingHtml?'':'<tr><td colspan="7">No transactions yet.</td></tr>'));

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
  $$('.pending-fix').forEach((el)=>el.addEventListener('click',async()=>{
    showView('receipts'); await loadReceiptInbox();
    const b=document.querySelector('.edit-receipt[data-id="'+el.dataset.id+'"]'); if(b) b.click();
  }));
  $$('.receipt').forEach((el)=>el.addEventListener('change',async()=>{
    const f=el.files&&el.files[0]; if(!f) return;
    const fd=new FormData(); fd.append('file',f); fd.append('transaction_id',el.dataset.id);
    await api('receipts',{method:'POST',body:fd});
    toast('Receipt attached');
    await Promise.all([loadTransactions(),loadDashboard(),loadReceiptInbox()]);
  }));
}

let trashRows=[];
document.addEventListener('click',(e)=>{if(e.target&&e.target.id==='emptyTrash')emptyTrash();});
async function loadTrash(){
  const box=$('#receiptTrash'); if(!box) return;
  trashRows=(await api('receipts-trash')).rows||[];
  renderTrash();
}
async function emptyTrash(){
  if(!trashRows.length){alert('The Trash is already empty.');return;}
  if(!confirm('Permanently delete all '+trashRows.length+' receipts in the Trash? This cannot be undone.'))return;
  try{const r=await api('receipts-trash/empty',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'EMPTY'})});toast(r.deleted+' receipts permanently deleted');}
  catch(e){alert(e.message||'Could not empty the Trash');return;}
  await loadTrash();
}
function renderTrash(){
  const box=$('#receiptTrash'); if(!box) return;
  const eb=$('#emptyTrash'); if(eb) eb.disabled=!trashRows.length;
  const q=(($('#trashSearch')&&$('#trashSearch').value)||'').trim().toLowerCase();
  const rows=trashRows.filter((r)=>!q||[r.id,r.vendor,r.file_name,r.amount,r.receipt_date].join(' ').toLowerCase().includes(q));
  box.innerHTML=rows.length?rows.map((r)=>
    '<div class="receipt-item"><b>'+esc(r.vendor||r.file_name||'Receipt')+'</b>'+
    '<div class="muted">'+esc(String(r.receipt_date||'No date').slice(0,10))+' · '+(r.amount==null?'No amount':money(r.amount))+' · deleted '+esc(String(r.deleted_at||'').slice(0,10))+'</div>'+
    '<div class="row"><a class="receipt-link" target="_blank" href="/api/receipts-trash/'+r.id+'/file">View file</a> '+
    '<button class="restore-receipt" data-id="'+r.id+'" type="button">Restore</button></div></div>').join('')
    :'<p class="muted">'+(trashRows.length?'No trashed receipts match your search.':'The Trash is empty.')+'</p>';
  $$('.restore-receipt').forEach((btn)=>btn.addEventListener('click',async()=>{
    try{await api('receipts-trash/'+btn.dataset.id+'/restore',{method:'POST'});toast('Receipt restored');}
    catch(e){alert(e.message||'Could not restore');return;}
    await Promise.all([loadReceiptInbox(),loadTransactions(),loadDashboard()]);
  }));
}

async function loadReceiptInbox(){
  const d=await api('receipt-inbox');
  receiptInbox=d.rows||[];
  const waiting=$('#receiptWaiting'),review=$('#receiptReview');
  if(!waiting||!review) return;

  const paymentNames={credit_card:'Credit Card',cash:'Cash',wire:'Wire',check:'Check'};
  const renderItem=(r,showFix)=>{
    const reasons=String(r.ocr_review_reasons||'').split(',').filter(Boolean);
    const quality=r.ocr_field_score!=null
      ? '<div class="muted">OCR key fields: '+esc(r.ocr_field_score)+'/5'+(reasons.length?' · Check '+esc(reasons.join(', ')):'')+'</div>'
      : '';
    return '<div class="receipt-item"><b>'+esc(r.vendor||r.file_name||'Receipt')+'</b>'+
      '<div class="muted">'+esc(String(r.receipt_date||'No date').slice(0,10))+' · '+(r.amount==null?'No amount':money(r.amount))+
      ' · '+esc(paymentNames[r.payment_method]||'Payment not confirmed')+'</div>'+
      quality+
      (r.page_count>1?'<div class="muted">'+r.page_count+' pages in this receipt</div>':'')+
      '<div><span class="badge">'+esc(r.category_name||'Uncategorized')+'</span></div>'+
      '<button class="receipt-thumb" data-id="'+r.id+'" type="button"><img src="/api/receipts/'+r.id+'" alt="Receipt '+r.id+' preview"></button>'+
      '<div class="row"><button class="show-receipt" data-id="'+r.id+'" type="button">View Here</button></div>'+
      '<div class="row"><button class="edit-receipt" data-id="'+r.id+'" type="button">Review / Fix</button></div>'+
      '<div class="row"><button class="trash-receipt" data-id="'+r.id+'" type="button">Move to Trash</button></div>'+
      '</div>';
  };

  const waitingRows=receiptInbox.filter((r)=>r.bucket==='waiting');
  const reviewRows=receiptInbox.filter((r)=>r.bucket!=='waiting');
  waiting.innerHTML=waitingRows.length?waitingRows.map((r)=>renderItem(r,false)).join(''):'<p class="muted">No credit-card receipts waiting to match.</p>';
  review.innerHTML=reviewRows.length?reviewRows.map((r)=>renderItem(r,true)).join(''):'<p class="muted">Nothing needs review.</p>';

  $$('.trash-receipt').forEach((btn)=>btn.addEventListener('click',async()=>{
    const r=receiptInbox.find((x)=>String(x.id)===String(btn.dataset.id));
    if(!confirm('Move "'+((r&&(r.vendor||r.file_name))||'this receipt')+'" to the Trash? You can restore it from the Trash list below.'))return;
    try{
      await api('receipts/'+btn.dataset.id+'/trash',{method:'POST'});
      toast('Moved to Trash');
    }catch(e){alert(e.message||'Could not move to the Trash');return;}
    await Promise.all([loadReceiptInbox(),loadTransactions(),loadDashboard()]);
  }));
  loadTrash().catch(console.error);

  const showReceiptInline=(id)=>{
    renderExistingReceiptPreview(id);
    const box=$('#receiptPreview');
    if(box)box.scrollIntoView({behavior:'smooth',block:'center'});
  };
  $$('.show-receipt,.receipt-thumb').forEach((btn)=>btn.addEventListener('click',()=>{
    showReceiptInline(btn.dataset.id);
  }));

  $$('.edit-receipt').forEach((btn)=>btn.addEventListener('click',async()=>{
    const r=receiptInbox.find((x)=>String(x.id)===String(btn.dataset.id));
    if(!r)return;
    resetReceiptReview();
    editingReceiptId=r.id;
    $('#rFile').value='';
    $('#rDate').value=String(r.receipt_date||'').slice(0,10);
    $('#rVendor').value=r.vendor||'';
    $('#rAmount').value=r.amount==null?'':Number(r.amount).toFixed(2);
    $('#rPayment').value=r.payment_method||'';
    $('#rReference').value=r.payment_reference||'';
    $('#rText').value=r.receipt_text||'';
    $('#rCategory').value=r.category_id?String(r.category_id):'';
    $('#ocrStatus').className='warn';
    $('#ocrStatus').textContent='Reviewing an existing receipt. Correct any field below, confirm payment method, then save.';
    $('#reviewPrompt').textContent='Editing receipt #'+r.id+'. Your corrections will replace the extracted values.';
    $('#uploadReceipt').textContent='Save Corrections';
    renderExistingReceiptPreview(r.id);
    if(r.page_count>1)renderPageStrip(r.id);
    const preview=$('#receiptPreview');
    if(preview)preview.scrollIntoView({behavior:'smooth',block:'center'});

    // Use this receipt's saved values first, then re-read its image and fill only blanks.
    try{
      const fresh=await api('receipts/'+r.id+'/ocr',{method:'POST'});
      if(!$('#rDate').value&&fresh.receipt_date) $('#rDate').value=fresh.receipt_date;
      if(!$('#rVendor').value.trim()&&fresh.vendor) $('#rVendor').value=fresh.vendor;
      if(!$('#rAmount').value&&fresh.amount!=null) $('#rAmount').value=Number(fresh.amount).toFixed(2);
      if(!$('#rPayment').value&&fresh.detected_payment_method) $('#rPayment').value=fresh.detected_payment_method;
      if(!$('#rText').value&&fresh.receipt_text) $('#rText').value=fresh.receipt_text;
      if(!$('#rCategory').value&&fresh.suggested_category){
        const cat=(bootstrap.categories||[]).find((c)=>c.name===fresh.suggested_category);
        if(cat) $('#rCategory').value=String(cat.id);
      }
      const stillMissing=[];
      if(!$('#rDate').value) stillMissing.push('date');
      if(!$('#rVendor').value.trim()) stillMissing.push('vendor');
      if(!$('#rAmount').value) stillMissing.push('amount');
      if(!$('#rPayment').value) stillMissing.push('payment method');
      $('#ocrStatus').className=stillMissing.length?'warn':'ok';
      $('#ocrStatus').textContent=stillMissing.length
        ? 'Loaded saved values and re-read this receipt. Still check: '+stillMissing.join(', ')+'.'
        : 'Loaded saved values and re-read this receipt. Review the fields, then save.';
    }catch(e){
      console.info('Receipt re-read unavailable',e);
      $('#ocrStatus').className='warn';
      $('#ocrStatus').textContent='Loaded the values already saved for this receipt. Automatic re-reading was not available for this file, so review the fields and fill any blanks.';
    }
  }));
}
function renderRules(){
  const cats=$('#categoryList');
  if(cats){
    cats.innerHTML=(bootstrap.categories||[]).map((c)=>
      '<div class="category-item category-manage"><span>'+esc(c.name)+'</span><div class="row">'+
      '<button class="edit-category" data-id="'+c.id+'" type="button">Edit</button>'+
      '<button class="delete-category" data-id="'+c.id+'" type="button">Delete</button>'+
      '</div></div>'
    ).join('');
    $$('.edit-category').forEach((btn)=>btn.addEventListener('click',async()=>{
      const c=(bootstrap.categories||[]).find((x)=>String(x.id)===String(btn.dataset.id));if(!c)return;
      const name=window.prompt('Rename category:',c.name);
      if(name===null||!name.trim()||name.trim()===c.name)return;
      try{
        await api('categories/'+c.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:name.trim()})});
        await loadBootstrap();
        await Promise.all([loadTransactions(),loadDashboard(),loadReceiptInbox()]);
        toast('Category renamed');
      }catch(e){toast(e.message)}
    }));
    $$('.delete-category').forEach((btn)=>btn.addEventListener('click',async()=>{
      const c=(bootstrap.categories||[]).find((x)=>String(x.id)===String(btn.dataset.id));if(!c)return;
      if(!window.confirm('Delete '+c.name+'?'))return;
      try{
        await api('categories/'+c.id,{method:'DELETE',headers:{'content-type':'application/json'},body:'{}'});
        await loadBootstrap();
        await Promise.all([loadTransactions(),loadDashboard(),loadReceiptInbox()]);
        toast('Category deleted');
      }catch(e){
        if(e.status!==409||!e.data?.usage){toast(e.message);return}
        const choices=(bootstrap.categories||[]).filter((x)=>String(x.id)!==String(c.id));
        const numbered=choices.map((x,i)=>(i+1)+'. '+x.name).join('\n');
        const u=e.data.usage;
        const pick=window.prompt(
          c.name+' is in use by '+u.transactions+' transaction(s), '+u.receipts+' receipt(s), and '+u.vendor_rules+' vendor rule(s).\n\nChoose the category to move them to before deleting '+c.name+':\n'+numbered+'\n\nEnter a number:'
        );
        const n=Number(pick);
        if(!Number.isInteger(n)||n<1||n>choices.length)return;
        const target=choices[n-1];
        if(!window.confirm('Move everything from '+c.name+' to '+target.name+' and delete '+c.name+'?'))return;
        try{
          await api('categories/'+c.id,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({replacement_category_id:target.id})});
          await loadBootstrap();
          await Promise.all([loadTransactions(),loadDashboard(),loadReceiptInbox()]);
          toast('Category merged and deleted');
        }catch(err){toast(err.message)}
      }
    }));
  }
  const rules=$('#ruleList');
  if(rules) rules.innerHTML=(bootstrap.rules||[]).length?(bootstrap.rules||[]).map((r)=>'<div class="rule-item"><b>'+esc(r.vendor_pattern)+'</b> → '+esc(r.category_name)+'</div>').join(''):'<p class="muted">No vendor rules yet.</p>';
  const sel=$('#ruleCategory');
  if(sel) sel.innerHTML=(bootstrap.categories||[]).map((c)=>'<option value="'+c.id+'">'+esc(c.name)+'</option>').join('');
}


function resetReceiptReview(){
  editingReceiptId=null;
  $('#rDate').value='';
  $('#rVendor').value='';
  $('#rAmount').value='';
  $('#rPayment').value='';
  $('#rReference').value='';
  $('#rText').value='';
  $('#rCategory').value='';
  $('#receiptUploadStatus').innerHTML='';
  $('#ocrStatus').className='muted';
  $('#ocrStatus').textContent='';
  if($('#receiptPreview'))$('#receiptPreview').textContent='Receipt preview will appear here.';
  $('#reviewPrompt').textContent='The system extracted what it could. Review every field, especially amount and payment method, before saving.';
  $('#uploadReceipt').textContent='Confirm & Save Expense';
}

function renderLocalReceiptPreview(files){
  const box=$('#receiptPreview'); if(!box)return;
  const imgs=[...files].filter((f)=>String(f.type||'').startsWith('image/'));
  if(!imgs.length){box.textContent='Preview unavailable for this file type.';return}
  const urls=imgs.map((f)=>URL.createObjectURL(f));
  box.innerHTML='<div class="preview-strip">'+urls.map((u,i)=>'<img src="'+u+'" alt="Receipt page '+(i+1)+'">').join('')+'</div>';
}
// Long receipts shot as several photos: tap the photo that has the total, or split a mistaken bundle.
async function renderPageStrip(id){
  const box=$('#receiptPreview'); if(!box)return;
  const d=await api('receipts/'+id+'/pages').catch(()=>null);
  const pages=d&&d.pages||[]; if(pages.length<2)return;
  const strip=document.createElement('div'); strip.className='preview-strip';
  strip.innerHTML='<p class="muted">'+pages.length+' pages. Tap the one that shows the total, or split if these are different receipts.</p>'+
    pages.map((p,i)=>'<div class="page-card"><img src="/api/receipts/'+id+'/pages/'+p.page_no+'" alt="Page '+p.page_no+'">'+
      '<div class="row"><button type="button" class="total-here" data-page="'+p.page_no+'">Total is on page '+p.page_no+'</button></div>'+
      (i<pages.length-1?'<div class="row"><button type="button" class="split-here" data-page="'+p.page_no+'">Split after page '+p.page_no+'</button></div>':'')+'</div>').join('');
  box.appendChild(strip);
  strip.querySelectorAll('.total-here').forEach((b)=>b.addEventListener('click',async()=>{
    try{
      const f=await api('receipts/'+id+'/total-page',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page:Number(b.dataset.page)})});
      if(f.amount!=null)$('#rAmount').value=Number(f.amount).toFixed(2);
      $('#ocrStatus').className=f.amount==null?'warn':'ok';
      $('#ocrStatus').textContent=f.amount==null?'No total could be read on page '+b.dataset.page+'. Type it in from the photo.':'Total read from page '+b.dataset.page+': '+money(f.amount)+'. Check it against the photo, then save.';
    }catch(e){toast(e.message||'Could not re-read')}
  }));
  strip.querySelectorAll('.split-here').forEach((b)=>b.addEventListener('click',async()=>{
    if(!confirm('Split into two receipts after page '+b.dataset.page+'?'))return;
    try{
      await api('receipts/'+id+'/split',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({after:Number(b.dataset.page)})});
      toast('Split into two receipts');
      resetReceiptReview();
      await loadReceiptInbox();
    }catch(e){toast(e.message||'Could not split')}
  }));
}
function renderExistingReceiptPreview(id){
  const box=$('#receiptPreview'); if(!box)return;
  box.innerHTML='<img src="/api/receipts/'+encodeURIComponent(id)+'" alt="Receipt preview">';
}

async function runReceiptOcr(files){
  const status=$('#ocrStatus');
  const list=[...files];
  if(!list.length||!status)return;
  status.className='muted';
  status.textContent='Reading '+list.length+' receipt image'+(list.length>1?'s':'')+'…';
  if(list.length>1&&list.some((f)=>/pdf/i.test(f.type)||/\.pdf$/i.test(f.name||''))){
    status.className='warn';
    status.textContent='Upload a PDF receipt on its own, or several photos together.';
    return;
  }
  const fd=new FormData();list.forEach((f)=>fd.append('files',f));
  window.__ocrGuess=null;
  try{
    const r=await api('ocr',{method:'POST',body:fd});
    window.__ocrGuess={vendor:r.vendor,date:r.receipt_date,amount:r.amount,payment:r.detected_payment_method,category:r.suggested_category,flags:r.review_reasons};
    $('#rDate').value=r.receipt_date||'';
    $('#rVendor').value=r.vendor||'';
    $('#rAmount').value=r.amount==null?'':Number(r.amount).toFixed(2);
    $('#rText').value=r.receipt_text||'';
    $('#rPayment').value=r.detected_payment_method||'';
    $('#rCategory').value='';
    if(r.suggested_category){
      const cat=(bootstrap.categories||[]).find((c)=>c.name===r.suggested_category);
      if(cat)$('#rCategory').value=String(cat.id);
    }
    const missing=Array.isArray(r.review_reasons)?r.review_reasons:[];
    const score=Number(r.field_score)||0;
    status.className=missing.length?'warn':'ok';
    status.textContent=missing.length
      ? score+'/5 key fields found across '+(r.page_count||list.length)+' image(s). Review '+missing.join(', ')+'. Nothing has been saved.'
      : '5/5 key fields found across '+(r.page_count||list.length)+' image(s). Review the extracted values, then click Confirm & Save Expense.';
  }catch(e){
    console.error(e);
    status.className='warn';
    status.textContent='Could not read this receipt bundle automatically. Enter the fields manually, confirm payment method, and save.';
  }
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


async function runSystemCheck(){
  if(systemCheckRunning) return;
  systemCheckRunning=true;
  const summary=$('#systemCheckSummary'),box=$('#systemCheckResults'),details=$('#systemCheckDetails');
  if(!summary||!box){systemCheckRunning=false;return;}
  summary.textContent='Running read-only checks…';
  box.innerHTML='';
  if(details) details.innerHTML='';

  const results=[];
  const add=(name,ok,detail)=>{results.push({name,ok,detail});};
  const test=async(name,fn)=>{
    try{const detail=await fn();add(name,true,detail||'OK');}
    catch(e){add(name,false,(e&&e.message)||String(e));}
  };

  const expectedViews=['dashboard','transactions','receipts','import','reports','rules','settings','system'];
  await test('Navigation structure',async()=>{
    const missing=expectedViews.filter((id)=>!document.getElementById(id)||!document.querySelector('.nav[data-view="'+id+'"]'));
    if(missing.length) throw new Error('Missing: '+missing.join(', '));
    return expectedViews.length+' tabs/views present';
  });

  await test('Navigation wiring',async()=>{
    const bad=expectedViews.filter((id)=>{
      const btn=document.querySelector('.nav[data-view="'+id+'"]');
      const view=document.getElementById(id);
      return !btn||!view||btn.dataset.view!==id;
    });
    if(bad.length) throw new Error('Broken navigation: '+bad.join(', '));
    return 'All tabs are wired without changing views';
  });

  await test('Bootstrap API',async()=>{
    const d=await api('bootstrap');
    if(!Array.isArray(d.categories)||!Array.isArray(d.cards)||!Array.isArray(d.payment_methods)) throw new Error('Unexpected response shape');
    if(!d.payment_methods.includes('cash')||!d.payment_methods.includes('wire')||!d.payment_methods.includes('check')||!d.payment_methods.includes('credit_card')) throw new Error('Payment methods incomplete');
    return d.categories.length+' categories · '+d.cards.length+' card(s)';
  });

  let txRows=[];
  await test('Dashboard API',async()=>{
    const d=await api('dashboard?month='+encodeURIComponent(currentMonth()));
    if(!d.summary) throw new Error('Missing summary');
    return String(d.summary.transactions||0)+' transactions · '+money(d.summary.total_spend);
  });

  await test('Transactions API',async()=>{
    const d=await api('transactions?month='+encodeURIComponent(currentMonth()));
    if(!Array.isArray(d.rows)) throw new Error('Rows missing');
    txRows=d.rows;
    return d.rows.length+' rows loaded';
  });

  await test('Receipt Inbox API',async()=>{
    const d=await api('receipt-inbox');
    if(!Array.isArray(d.rows)) throw new Error('Rows missing');
    return d.rows.length+' waiting receipt(s)';
  });

  await test('OCR service',async()=>{
    const d=await api('ocr/status');
    if(!d.enabled) throw new Error('OCR disabled');
    if(!d.manual_fallback) throw new Error('Manual fallback missing');
    return 'Server-side OCR ready · manual fallback available';
  });

  await test('Reports API',async()=>{
    const m=currentMonth().split('-');
    const d=await api('report?scope=month&year='+encodeURIComponent(m[0])+'&month='+encodeURIComponent(Number(m[1])));
    if(!d.summary) throw new Error('Missing report summary');
    return String(d.summary.transaction_count||0)+' transactions · '+money(d.summary.total);
  });

  await test('Cash workflow visibility',async()=>{
    const cash=txRows.filter((t)=>t.payment_method==='cash');
    if(!cash.length) return 'No cash transactions in '+currentMonth()+' yet';
    const linked=cash.filter((t)=>t.receipt_id).length;
    return cash.length+' cash transaction(s) · '+linked+' with linked receipt(s)';
  });

  await test('Receipt file endpoint',async()=>{
    const t=txRows.find((x)=>x.receipt_id);
    if(!t) return 'No linked receipt available to probe';
    const r=await fetch('/api/receipts/'+t.receipt_id,{method:'HEAD',redirect:'manual'});
    if(!(r.ok||r.type==='opaqueredirect'||(r.status>=300&&r.status<400))) throw new Error('HTTP '+r.status);
    return (t.file_name||('Receipt #'+t.receipt_id))+' reachable';
  });

  const passed=results.filter((r)=>r.ok).length;
  const failed=results.length-passed;
  summary.className=failed?'system-summary warn':'system-summary ok';
  summary.textContent=failed?passed+' passed · '+failed+' failed':passed+' of '+results.length+' checks passed';
  box.innerHTML=results.map((r)=>'<div class="check-item '+(r.ok?'pass':'fail')+'"><div><b>'+(r.ok?'PASS':'FAIL')+'</b> '+esc(r.name)+'</div><span>'+esc(r.detail)+'</span></div>').join('');

  if(details&&txRows.length){
    const cash=txRows.filter((t)=>t.payment_method==='cash');
    details.innerHTML='<h3>Current-month cash transactions</h3>'+(cash.length
      ? '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Vendor</th><th>Amount</th><th>Receipt</th></tr></thead><tbody>'+cash.map((t)=>'<tr><td>'+esc(String(t.transaction_date||'').slice(0,10))+'</td><td>'+esc(t.vendor_normalized||t.vendor_raw||'')+'</td><td>'+money(t.amount)+'</td><td>'+(t.receipt_id?'<a class="receipt-link" target="_blank" href="/api/receipts/'+t.receipt_id+'">'+esc(t.file_name||'Receipt')+'</a>':'Missing')+'</td></tr>').join('')+'</tbody></table></div>'
      : '<p class="muted">No cash transactions found for '+esc(currentMonth())+'.</p>');
  }
  systemCheckRunning=false;
}

function wireStaticControls(){
  if($('#rFile')) $('#rFile').addEventListener('change',()=>{
    const files=$('#rFile').files;
    if(!files||!files.length)return;
    resetReceiptReview();
    renderLocalReceiptPreview(files);
    runReceiptOcr(files).catch(console.error);
  });
  const monthEl=$('#month');
  if(monthEl){monthEl.value=new Date().toISOString().slice(0,7);monthEl.addEventListener('change',()=>Promise.all([loadDashboard(),loadTransactions()]));}
  setupFolderUpload();
  if($('#refresh')) $('#refresh').addEventListener('click',()=>Promise.all([loadDashboard(),loadTransactions(),loadReceiptInbox()]));
  if($('#runSystemCheck')) $('#runSystemCheck').addEventListener('click',()=>runSystemCheck().catch((e)=>{console.error(e);toast('System check failed to run');}));
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
    const payment=$('#rPayment').value;
    if(!payment)return toast('Confirm the payment method before saving');
    if(!$('#rDate').value||!$('#rVendor').value.trim()||!$('#rAmount').value)return toast('Review date, vendor, and amount before saving');

    if(editingReceiptId){
      const r=await api('receipts/'+editingReceiptId,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({
        receipt_date:$('#rDate').value,
        vendor:$('#rVendor').value.trim(),
        amount:Number($('#rAmount').value),
        payment_method:payment,
        payment_reference:$('#rReference').value,
        receipt_text:$('#rText').value,
        category_id:$('#rCategory').value?Number($('#rCategory').value):null
      })});
      let msg='Corrections saved.';
      if(r.created_transaction_id) msg='Corrected and posted as '+String(payment).replace('_',' ').toUpperCase()+'.';
      else if(r.matched_transaction_id) msg='Corrected and matched to the credit-card transaction.';
      else if(payment==='credit_card') msg='Corrected. Waiting for the matching credit-card transaction.';
      $('#receiptUploadStatus').innerHTML='<p class="ok">'+esc(msg)+'</p>';
      const correctedDate=$('#rDate').value;
      const correctedPayment=r.payment_method||payment;
      resetReceiptReview();
      $('#receiptUploadStatus').innerHTML='<p class="ok">'+esc(msg)+'</p>';
      if(['cash','check','wire'].includes(correctedPayment)&&correctedDate&&$('#month')) $('#month').value=correctedDate.slice(0,7);
      await Promise.all([loadReceiptInbox(),loadTransactions(),loadDashboard()]);
      if(['cash','check','wire'].includes(correctedPayment)) showView('transactions');
      return;
    }

    const files=$('#rFile').files; if(!files||!files.length) return toast('Choose one or more receipt images');
    const fd=new FormData();
    [...files].forEach((f)=>fd.append('files',f));
    fd.append('receipt_date',$('#rDate').value);fd.append('vendor',$('#rVendor').value.trim());fd.append('amount',$('#rAmount').value);
    fd.append('payment_method',payment);fd.append('payment_reference',$('#rReference').value);fd.append('receipt_text',$('#rText').value);
    if($('#rCategory').value) fd.append('category_id',$('#rCategory').value);
    if(window.__ocrGuess) fd.append('ocr_guess',JSON.stringify(window.__ocrGuess));
    const r=await api('receipts',{method:'POST',body:fd});
    const actualPayment=r.payment_method||payment;
    const nonCard=['cash','wire','check'].includes(actualPayment);
    let msg='Saved.';
    if(r.duplicate&&r.promoted) msg='Existing receipt corrected to '+String(actualPayment).replace('_',' ').toUpperCase()+' and posted to Transactions.';
    else if(r.duplicate&&nonCard) msg='This '+String(actualPayment).replace('_',' ').toUpperCase()+' receipt was already uploaded. Review / Fix it if anything needs correction.';
    else if(r.duplicate) msg='This credit-card receipt was already uploaded. Review / Fix it if anything needs correction.';
    else if(nonCard) msg='Saved as '+String(actualPayment).replace('_',' ').toUpperCase()+' and posted to Transactions.';
    else if(r.matched_transaction_id) msg='Saved and matched to the credit-card transaction.';
    else if(actualPayment==='credit_card') msg='Saved as CREDIT CARD. Waiting to Match with Capital One.';
    else msg='Saved. Review this receipt in Needs Review / Fix.';
    $('#receiptUploadStatus').innerHTML='<p class="ok">'+esc(msg)+'</p>';
    const savedDate=$('#rDate').value;
    $('#rFile').value='';
    resetReceiptReview();
    $('#receiptUploadStatus').innerHTML='<p class="ok">'+esc(msg)+'</p>';
    if(nonCard&&savedDate&&$('#month')) $('#month').value=savedDate.slice(0,7);
    await Promise.all([loadReceiptInbox(),loadTransactions(),loadDashboard()]);
    if(nonCard) showView('transactions');
  });

  if($('#addCategory')) $('#addCategory').addEventListener('click',async()=>{
    await api('categories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:$('#newCategory').value})});
    $('#newCategory').value='';await loadBootstrap();
  });
  if($('#saveMailSettings')) $('#saveMailSettings').addEventListener('click',async()=>{
    const status=$('#mailSettingsStatus');
    const mail_from=$('#settingsMailFrom').value.trim();
    const alert_email_to=$('#settingsAlertTo').value.trim();
    try{
      await api('settings/mail',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({
        mail_from:mail_from||null,
        alert_email_to:alert_email_to||null
      })});
      await loadBootstrap();
      if(status) status.innerHTML='<p class="ok">Saved.</p>';
      toast('Email settings saved');
    }catch(e){
      if(status) status.innerHTML='<p class="warn">'+esc(e.message)+'</p>';
    }
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
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='quixotic-'+currentMonth()+'.csv';a.click();
  });

  if($('#runReport')) $('#runReport').addEventListener('click',async()=>{
    const scope=$('#reportScope').value,year=Number($('#reportYear').value)||new Date().getFullYear(),m=Number($('#reportMonth').value)||new Date().getMonth()+1,q=Number($('#reportQuarter').value)||Math.floor(new Date().getMonth()/3)+1;
    const r=await api('report?scope='+scope+'&year='+year+'&month='+m+'&quarter='+q);
    const categories=(r.byCategory||[]).map((x)=>'<div class="barrow"><span>'+esc(x.name)+'</span><span></span><b>'+money(x.total)+'</b></div>').join('');
    const payments=(r.byPaymentMethod||[]).map((x)=>'<div class="barrow"><span>'+esc(String(x.name||'').replace('_',' '))+'</span><span></span><b>'+money(x.total)+'</b></div>').join('');
    const vendors=(r.topVendors||[]).map((x)=>'<div class="barrow"><span>'+esc(x.name)+'</span><span></span><b>'+money(x.total)+'</b></div>').join('');
    $('#reportOutput').innerHTML='<h2>'+esc(r.label)+'</h2><p><b>Total:</b> '+money(r.summary.total)+' · <b>Transactions:</b> '+r.summary.transaction_count+'</p><div class="grid2"><div><h3>By Category</h3>'+categories+'</div><div><h3>By Payment Method</h3>'+payments+'</div></div><h3>Top Vendors</h3>'+vendors;
  });

  if($('#downloadRegisterXlsx')) $('#downloadRegisterXlsx').addEventListener('click',()=>{
    const year=Number($('#reportYear').value)||new Date().getFullYear(),m=Number($('#reportMonth').value)||new Date().getMonth()+1;
    const month=year+'-'+String(m).padStart(2,'0');
    window.location.href='/api/export/register?format=xlsx&month='+encodeURIComponent(month);
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
