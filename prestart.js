/* =====================================================================
   FraserFlow: Prestarts (Phase 3 of Fleet & Maintenance)
   Loaded after maint.js, only when the Prestarts or Fleet screen opens.
   - Prestarts screen: the phone checklist operators fill in before starting a machine
   - Fleet › Prestarts: inspection history; Fleet › Checklists: the checklist builder;
     Fleet › Logins: roles and the link from each login to its Staff record
   - Machine panel: recent prestarts, manuals and documents
   Photos, signatures and manuals live in the Supabase Storage bucket "maintenance".
   Submitted prestarts are checked and saved by the database (submit_prestart) and can't be changed.
   ===================================================================== */
(function(){
const {Modal,Fld,fs,errMsg,fmtTs,localDay,useMaint,buildModel,meterTxt}=window.FFM;
const BUCKET='maintenance';
const RES={pass:['Good to go','hsl(145 55% 36%)'],defects:['Defects reported','hsl(30 90% 42%)'],unsafe:['Do not operate','hsl(0 72% 47%)']};
const resChip=r=>RES[r]?html`<span class="inline-flex items-center text-[11.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style=${{color:RES[r][1],background:'var(--sunken)',boxShadow:`inset 0 0 0 1px ${RES[r][1]}`}}>${RES[r][0]}</span>`:null;
const I={
  tick:svg(html`<path d="M3 8.5l3.2 3L13 4.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,18),
  cross:svg(html`<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,18),
  dash:svg(html`<path d="M4 8h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,18),
  camera:svg(html`<path d="M2.5 5.5h2.2l1.2-1.8h4.2l1.2 1.8h2.2v7h-11z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><circle cx="8" cy="8.8" r="2.2" stroke="currentColor" stroke-width="1.4" fill="none"/>`,16),
  file:svg(html`<path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M9 1.8v3h3" stroke="currentColor" stroke-width="1.4" fill="none"/>`,16),
  back:svg(html`<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,16),
};
const fmtDT=t=>t?new Date(t).toLocaleString('en-AU',{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'';
const fmtTime=t=>t?new Date(t).toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'}):'';
const newId=()=>{try{if(crypto.randomUUID)return crypto.randomUUID()}catch(e){}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16)})};
const kindOf=it=>it.kind||'check';
const tplFor=(tpls,m)=>{const c=machCatOf(m).toLowerCase();const act=tpls.filter(t=>t.active);
  return act.find(t=>t.asset_id&&t.asset_id===m.id)||act.find(t=>!t.asset_id&&t.category&&t.category.trim().toLowerCase()===c)||act.find(t=>!t.asset_id&&!t.category)||null};
const sectionsOf=items=>{const out=[];items.forEach((it,i)=>{const s=(it.section||'').trim()||'Checks';let g=out.find(x=>x.s===s);if(!g){g={s,items:[]};out.push(g)}g.items.push({...it,i})});return out};
const isFault=e=>!!(e&&e.code);   /* an answer from the database (a rule), not a dropped connection */

/* the standard list: a starting point for a new checklist */
const STANDARD=[
  ['Walk-around','leaks','No oil, fuel, coolant or hydraulic leaks',0],['Walk-around','tyres','Tyres, tracks or drums in good condition',0],
  ['Walk-around','damage','No damage to body, guards, panels or attachments',0],['Walk-around','glass','Windscreen, windows and mirrors clean and undamaged',0],
  ['Fluids','oil','Engine oil level OK',0],['Fluids','coolant','Coolant level OK',0],['Fluids','hydraulic','Hydraulic oil level OK',0],['Fluids','fuel','Fuel level (%)',0,'number'],
  ['Safety','brakes','Service brakes and park brake work',1],['Safety','steering','Steering works properly',1],['Safety','estop','Emergency stop works',1],
  ['Safety','seatbelt','Seatbelt in good condition and works',1],['Safety','alarm','Reversing alarm and beacon work',1],['Safety','rops','ROPS / FOPS undamaged',1],
  ['Safety','horn','Horn works',0],['Safety','lights','Lights work',0],['Safety','extinguisher','Fire extinguisher present, charged and in date',0],
  ['After start-up','gauges','Gauges and warning lights normal',0],['After start-up','controls','All controls work properly',0],
].map(([section,key,text,critical,kind])=>({key,section,text,kind:kind||'check',critical:!!critical}));

/* ---------- the file store ---------- */
const SIGNED=new Map();   /* path → {url, until} */
async function signedUrls(sb,paths){
  const now=Date.now();const need=[...new Set(paths)].filter(p=>p&&!(SIGNED.has(p)&&SIGNED.get(p).until>now));
  if(need.length){const {data}=await sb.storage.from(BUCKET).createSignedUrls(need,3600);(data||[]).forEach(d=>{if(d&&d.signedUrl)SIGNED.set(d.path,{url:d.signedUrl,until:now+3000e3})})}
  const o={};paths.forEach(p=>{if(SIGNED.has(p))o[p]=SIGNED.get(p).url});return o;
}
function useSigned(sb,paths){
  const k=paths.join('|');const [m,setM]=useState({});
  useEffect(()=>{if(!paths.length)return;let off=false;signedUrls(sb,paths).then(o=>{if(!off)setM(o)}).catch(()=>{});return()=>{off=true}},[k]);
  return m;
}
async function shrink(file,max=1600){
  const url=URL.createObjectURL(file);
  try{const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('That file isn’t a picture'));i.src=url});
    const k=Math.min(1,max/Math.max(img.naturalWidth||1,img.naturalHeight||1));const c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(img.naturalWidth*k));c.height=Math.max(1,Math.round(img.naturalHeight*k));c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    return await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('Couldn’t read that picture')),'image/jpeg',.82))}
  finally{URL.revokeObjectURL(url)}
}

/* ---------- drafts: kept on this phone until the prestart is submitted ---------- */
const DK=u=>KEY+':ps-drafts:'+u;
const readDrafts=u=>{try{const all=JSON.parse(localStorage.getItem(DK(u))||'{}');const o={};
  Object.values(all).forEach(d=>{if(d&&d.asset_id&&Date.now()-(d.saved_at||0)<18*3600e3)o[d.asset_id]=d});return o}catch(e){return {}}};   /* a draft older than 18 hours is yesterday's: dropped */
const writeDraft=(u,d)=>{try{const all=readDrafts(u);if(d.del)delete all[d.asset_id];else all[d.asset_id]=d;localStorage.setItem(DK(u),JSON.stringify(all))}catch(e){}};

/* ---------- no reception: photos, signatures and finished prestarts wait on this phone, then send themselves ---------- */
const LOCAL=new Map();   /* path → picture kept on this phone, for showing it */
const OBK=u=>'ps-outbox:'+u;
async function keepBlob(path,blob){await ffStore.set('blob:'+path,blob);try{LOCAL.set(path,URL.createObjectURL(blob))}catch(e){}}
async function loadLocal(paths){let n=0;for(const p of paths){if(LOCAL.has(p))continue;const b=await ffStore.get('blob:'+p);if(b){LOCAL.set(p,URL.createObjectURL(b));n++}}return n}
async function upload(sb,path,blob,type){const r=await sb.storage.from(BUCKET).upload(path,blob,{contentType:type,upsert:false});
  if(r&&r.error&&!/exist|duplicate/i.test(errMsg(r.error)))throw r.error}   /* already there from an earlier try: fine */
/* upload now if there's reception, otherwise keep it on the phone */
async function uploadOrKeep(sb,path,blob,type){try{await upload(sb,path,blob,type)}catch(e){if(!isNetErr(e))throw e;await keepBlob(path,blob);return false}return true}
const filesOf=pl=>[pl.signature,...Object.values(pl.answers||{}).flatMap(a=>a.photos||[])].filter(Boolean);
async function sendPrestart(sb,pl){
  for(const p of filesOf(pl)){const b=await ffStore.get('blob:'+p);if(!b)continue;await upload(sb,p,b,b.type||(p.endsWith('.png')?'image/png':'image/jpeg'));await ffStore.del('blob:'+p)}
  const {data,error}=await sb.rpc('submit_prestart',{p:pl});if(error)throw error;return data}
const readOutbox=async u=>(await ffStore.get(OBK(u)))||[];
async function addToOutbox(u,item){const l=await readOutbox(u);await ffStore.set(OBK(u),[...l.filter(x=>x.client_id!==item.client_id),item])}
async function removeFromOutbox(u,ids,errs){const l=await readOutbox(u);await ffStore.set(OBK(u),l.filter(x=>!ids.includes(x.client_id)).map(x=>errs&&errs[x.client_id]?{...x,error:errs[x.client_id]}:x))}
let flushing=null;
/* send what's waiting, oldest first; the database never makes two of the same prestart (client_id) */
function flushOutbox(sb,u){if(flushing)return flushing;flushing=(async()=>{const sent=[],errs={};
  try{for(const it of await readOutbox(u)){if(it.error)continue;
      try{await sendPrestart(sb,it.payload);sent.push(it.client_id)}catch(e){if(isNetErr(e))break;errs[it.client_id]=errMsg(e)}}
    if(sent.length||Object.keys(errs).length)await removeFromOutbox(u,sent,errs)}
  finally{flushing=null;window.dispatchEvent(new CustomEvent('ff-outbox',{detail:{sent:sent.length}}))}
  return sent.length})();return flushing}
const localResult=(tpl,ans)=>{let f=0,c=0;(tpl.items||[]).forEach(it=>{if(kindOf(it)==='check'&&(ans[it.key]||{}).answer==='fail'){f++;if(it.critical)c++}});return {result:c?'unsafe':f?'defects':'pass',failed:f}};

/* the job this machine's crew is on today, to fill in the location */
const jobToday=(data,m)=>{const today=iso(TODAY);const b=data.blocks.find(x=>x.kind==='job'&&x.start<=today&&x.end>=today&&(machinesOn(x,today).includes(m.id)||(m.crewId&&x.resourceId===m.crewId)));
  if(!b)return '';const j=data.jobs.find(x=>x.id===b.jobId);return j?[j.customer,j.name].filter(Boolean).join(' · '):''};

/* ---------- signature ---------- */
function SignPad({padRef,onInk}){
  const cv=useRef(null);const strokes=useRef([]);const live=useRef(null);
  const paint=()=>{const c=cv.current;if(!c)return;const r=c.getBoundingClientRect();const dpr=window.devicePixelRatio||1;
    if(c.width!==Math.round(r.width*dpr)||c.height!==Math.round(r.height*dpr)){c.width=Math.round(r.width*dpr);c.height=Math.round(r.height*dpr)}
    const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,r.width,r.height);g.lineWidth=2.4;g.lineCap='round';g.lineJoin='round';g.strokeStyle='#111';
    strokes.current.forEach(s=>{g.beginPath();s.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));if(s.length===1)g.lineTo(s[0][0]+.1,s[0][1]+.1);g.stroke()})};
  useEffect(paint);   /* every render: the strokes are kept, so the picture survives a redraw */
  padRef.current={empty:()=>!strokes.current.some(s=>s.length),clear:()=>{strokes.current=[];paint();onInk(false)},
    blob:()=>new Promise((res,rej)=>{const c=cv.current;const out=document.createElement('canvas');out.width=c.width;out.height=c.height;const g=out.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,out.width,out.height);g.drawImage(c,0,0);out.toBlob(b=>b?res(b):rej(new Error('Couldn’t save the signature')),'image/png')})};
  const pt=e=>{const r=cv.current.getBoundingClientRect();return [Math.round((e.clientX-r.left)*10)/10,Math.round((e.clientY-r.top)*10)/10]};
  const down=e=>{e.preventDefault();try{cv.current.setPointerCapture(e.pointerId)}catch(x){}live.current=[pt(e)];strokes.current.push(live.current);paint()};
  const move=e=>{if(!live.current)return;e.preventDefault();live.current.push(pt(e));paint()};
  const up=()=>{if(!live.current)return;live.current=null;onInk(true)};
  return html`<canvas id="ps-sign" ref=${cv} class="w-full rounded-lg border border-line block" style=${{height:150,background:'#fff',touchAction:'none',cursor:'crosshair'}}
    aria-label="Sign here" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onPointerLeave=${up}></canvas>`;
}

/* ---------- one question ---------- */
function Question({it,a,set,onPhoto,busy,urls,n,known}){
  const k=kindOf(it);const ans=a.answer||'';
  const opt=(v,l,ic,col)=>html`<button type="button" id=${`ps-${it.key}-${v}`} class="rounded-lg border text-[14px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors" aria-pressed=${ans===v}
    style=${{height:48,borderColor:ans===v?col:'var(--line)',background:ans===v?col:'var(--surface)',color:ans===v?'#fff':'var(--ink)'}} onClick=${()=>set({answer:ans===v?'':v})}>${ic} ${l}</button>`;
  return html`<div id=${'ps-q-'+it.key} class="panel p-3 grid gap-2.5" style=${ans==='fail'?{boxShadow:'inset 0 0 0 1.5px hsl(0 72% 47%)'}:null}>
    <div class="flex items-start gap-2"><span class="mono text-[11px] text-faint mt-1 w-5 shrink-0">${n}</span>
      <div class="text-[15px] font-medium leading-snug flex-1">${it.text}${it.critical&&html` <span class="align-middle ml-1 text-[10.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style=${{background:'hsl(0 72% 47%)',color:'#fff'}} title="A fault here means the machine must not be used">Critical</span>`}</div></div>
    ${known&&html`<div class="text-[12.5px] rounded-md px-2 py-1" style=${{background:'var(--sunken)'}}>Already reported: D-${known.number}, ${({reported:'reported',acknowledged:'waiting for repair',in_repair:'in repair',repaired:'repaired, to be checked'})[known.status]||known.status}. If it’s still faulty, fail it again.</div>`}
    ${k==='check'?html`<div class="grid grid-cols-3 gap-2">${opt('pass','Pass',I.tick,'hsl(145 55% 34%)')}${opt('fail','Fail',I.cross,'hsl(0 72% 47%)')}${opt('na','N/A',I.dash,'hsl(220 9% 46%)')}</div>`
      :k==='number'?html`<input id=${'ps-'+it.key+'-value'} type="number" inputmode="decimal" step="any" class="field mono" style=${{height:44,fontSize:16}} value=${ans} onInput=${e=>set({answer:e.target.value})} aria-label=${it.text}/>`
      :html`<textarea id=${'ps-'+it.key+'-value'} class="field" rows="2" style=${{height:'auto',minHeight:56,padding:'8px 10px',fontSize:15}} value=${ans} placeholder="Optional" onInput=${e=>set({answer:e.target.value})} aria-label=${it.text}></textarea>`}
    ${ans==='fail'&&html`<div class="grid gap-2">
      <textarea id=${'ps-'+it.key+'-comment'} class="field" rows="2" style=${{height:'auto',minHeight:60,padding:'8px 10px',fontSize:15}} placeholder="What’s wrong? (required)" value=${a.comment||''} onInput=${e=>set({comment:e.target.value})} aria-label="What’s wrong"></textarea>
      <div class="flex flex-wrap items-center gap-2">
        ${(a.photos||[]).map(p=>html`<span key=${p} class="relative inline-block"><img src=${urls[p]||''} alt="Photo" class="w-16 h-16 rounded-lg object-cover border border-line bg-sunken"/>
          <button type="button" class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full inline-flex items-center justify-center text-white" style=${{background:'var(--ink)'}} aria-label="Remove photo" onClick=${()=>set({photos:(a.photos||[]).filter(x=>x!==p)})}>${Icon.x}</button></span>`)}
        <label class="btn cursor-pointer" style=${{height:40}}>${I.camera} ${busy?'Uploading…':'Add photo'}
          <input id=${'ps-'+it.key+'-photo'} type="file" accept="image/*" capture="environment" class="hidden" disabled=${busy} onChange=${e=>{const f=e.target.files&&e.target.files[0];e.target.value='';if(f)onPhoto(f)}}/></label>
      </div></div>`}
  </div>`;
}

/* ---------- the prestart form ---------- */
function PsForm({ctx,a,tpl,onDone,onBack}){
  const {sb,me,data}=ctx;
  const [d,setD]=useState(()=>{const old=readDrafts(me)[a.m.id];
    const base={client_id:newId(),asset_id:a.m.id,template_id:tpl.id,started_at:new Date().toISOString(),hours:'',km:'',location:jobToday(data,a.m),notes:'',answers:{}};
    return old?{...base,...old,template_id:tpl.id}:base});   /* a draft keeps its answers, matched by question, even if the checklist changed */
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [ink,setInk]=useState(false);const [agree,setAgree]=useState(false);const [uploading,setUploading]=useState({});
  const pad=useRef(null);const sig=useRef({path:null,dirty:true});
  const upd=f=>setD(x=>{const n=typeof f==='function'?f(x):{...x,...f};writeDraft(me,{...n,saved_at:Date.now()});return n});
  const setAns=(key,patch)=>upd(x=>({...x,answers:{...x.answers,[key]:{...(x.answers[key]||{}),...patch}}}));
  const items=tpl.items||[];const need=items.filter(it=>kindOf(it)!=='text');
  const answered=it=>{const v=((d.answers[it.key]||{}).answer||'').trim();return kindOf(it)==='check'?['pass','fail','na'].includes(v):v!==''};
  const done=need.filter(answered).length;
  const meters=[a.mt!=='km'&&'hours',a.mt!=='hours'&&'km'].filter(Boolean);
  const photos=Object.values(d.answers).flatMap(x=>x.photos||[]);const signed=useSigned(sb,photos);
  const [,bump]=useState(0);useEffect(()=>{loadLocal(photos).then(n=>{if(n)bump(x=>x+1)})},[photos.join('|')]);
  const urls={...signed};photos.forEach(p=>{if(!urls[p]&&LOCAL.has(p))urls[p]=LOCAL.get(p)});
  const addPhoto=async(key,file)=>{setUploading(u=>({...u,[key]:true}));setErr('');
    try{const blob=await shrink(file);const path=`prestarts/${me}/${d.client_id}/${key}-${Date.now()}.jpg`;
      await uploadOrKeep(sb,path,blob,'image/jpeg');   /* no reception: kept on this phone and sent with the prestart */
      setAns(key,{photos:[...((d.answers[key]||{}).photos||[]),path]})}
    catch(e){setErr('The photo didn’t save: '+errMsg(e))}finally{setUploading(u=>({...u,[key]:false}))}};
  const warn=k=>{const v=d[k];const cur=a.cur[k];if(v===''||!cur)return '';const unit=k==='hours'?'h':'km';
    if(+v<cur.value)return `Lower than the last reading (${fmtN(cur.value)} ${unit}). Check the ${k==='hours'?'hour meter':'odometer'}.`;
    const jump=+v-cur.value;if(jump>(k==='hours'?300:5000))return `That’s ${fmtN(jump)} ${unit} more than the last reading (${fmtN(cur.value)} ${unit}). Check it.`;return ''};
  const firstProblem=()=>{
    for(const k of meters)if(d[k]==='')return {id:'ps-'+k,msg:k==='hours'?'Enter the engine hours.':'Enter the odometer km.'};
    for(const it of items){const x=d.answers[it.key]||{};
      if(kindOf(it)!=='text'&&!answered(it))return {id:'ps-q-'+it.key,msg:`Answer every question: “${it.text}” is missing.`};
      if(x.answer==='fail'&&!(x.comment||'').trim())return {id:'ps-'+it.key+'-comment',msg:`Say what’s wrong for “${it.text}”.`};}
    if(Object.values(uploading).some(Boolean))return {id:null,msg:'Wait for the photo to finish uploading.'};
    if(!pad.current||pad.current.empty())return {id:'ps-sign',msg:'Sign the prestart.'};
    if(!agree)return {id:'ps-agree',msg:'Tick the declaration.'};
    return null};
  const submit=async()=>{const p=firstProblem();if(p){setErr(p.msg);if(p.id){const el=document.getElementById(p.id);if(el){el.scrollIntoView({block:'center',behavior:'smooth'});try{el.focus({preventScroll:true})}catch(e){}}}return}
    setBusy(true);setErr('');
    try{if(sig.current.dirty||!sig.current.path){const blob=await pad.current.blob();const path=`prestarts/${me}/${d.client_id}/signature-${Date.now()}.png`;
        await uploadOrKeep(sb,path,blob,'image/png');sig.current={path,dirty:false}}
      const ans={};items.forEach(it=>{const x=d.answers[it.key]||{};ans[it.key]={answer:(x.answer||'').trim(),comment:x.answer==='fail'?(x.comment||'').trim():'',photos:x.answer==='fail'?(x.photos||[]):[]}});
      const pl={client_id:d.client_id,asset_id:a.m.id,template_id:tpl.id,started_at:d.started_at,hours:d.hours,km:d.km,location:d.location,notes:d.notes,signature:sig.current.path,answers:ans};
      let r;try{r=await sendPrestart(sb,pl)}
      catch(e){if(!isNetErr(e))throw e;   /* no reception: it waits on this phone and sends itself later */
        const lr=localResult(tpl,ans);await addToOutbox(me,{client_id:pl.client_id,asset_id:a.m.id,payload:pl,at:Date.now(),...lr});r={...lr,queued:true}}
      writeDraft(me,{asset_id:a.m.id,del:true});onDone(r)}
    catch(e){setErr(errMsg(e)+(isFault(e)?'':'. Your answers are kept on this phone: try again in a moment.'))}
    finally{setBusy(false)}};
  let n=0;
  return html`<div class="grid gap-3 pb-6" id="ps-form">
    <div class="sticky top-0 z-10 -mx-1 px-1 pt-1 pb-2 grid gap-2" style=${{background:'var(--bg)'}}>
      <div class="flex items-center gap-2"><button type="button" id="ps-back" class="btn px-2" onClick=${onBack} aria-label="Back to machines">${I.back}</button>
        <div class="min-w-0 flex-1"><div class="font-display text-[18px] font-semibold leading-tight truncate">${a.m.name} <span class="text-muted font-normal text-[14px]">${a.m.sub||''}</span></div>
          <div class="text-[12px] text-muted truncate">${tpl.name} · v${tpl.version} · saved on this phone as you go</div></div></div>
      <div class="flex items-center gap-2"><div class="flex-1 h-2.5 rounded-full overflow-hidden" style=${{background:'var(--sunken)'}} role="progressbar" aria-valuemin="0" aria-valuemax=${need.length} aria-valuenow=${done} aria-label="Questions answered">
          <div class="h-full rounded-full transition-all" style=${{width:(need.length?done/need.length*100:100)+'%',background:done===need.length?'hsl(145 55% 36%)':'var(--accent)'}}></div></div>
        <span id="ps-progress" class="mono text-[12px] text-muted whitespace-nowrap">${done} of ${need.length}</span></div>
    </div>

    ${a.restr&&a.restr.length>0&&html`<div id="ps-restricted" class="rounded-lg px-3 py-2.5 text-[14px] font-medium" style=${{background:'hsl(0 80% 96%)',color:'hsl(0 72% 38%)',boxShadow:'inset 0 0 0 1.5px hsl(0 72% 47%)'}}>Do not use this machine: ${a.restr.map(r=>r.reason).join('; ')}. You can still do the check; tell your supervisor.</div>`}
    <section class="panel p-3 grid gap-3"><div class="label">Before you start</div>
      ${meters.map(k=>html`<label key=${k} class="grid gap-1"><span class="text-[14px] font-medium">${k==='hours'?'Engine hours':'Odometer km'}</span>
        <input id=${'ps-'+k} type="number" inputmode="decimal" min="0" step="any" class="field mono" style=${{height:44,fontSize:16}} value=${d[k]} onInput=${e=>upd({[k]:e.target.value})}/>
        <span class="text-[12px] text-muted">${a.cur[k]?`Last reading ${fmtN(a.cur[k].value)} ${k==='hours'?'h':'km'}, ${fmtTs(a.cur[k].at)}`:'No reading recorded yet'}</span>
        ${warn(k)&&html`<span class="text-[12.5px] font-medium" style=${{color:'hsl(30 90% 38%)'}}>${warn(k)}</span>`}</label>`)}
      <label class="grid gap-1"><span class="text-[14px] font-medium">Location or job</span><input id="ps-location" class="field" style=${{height:44,fontSize:15}} value=${d.location} onInput=${e=>upd({location:e.target.value})}/></label>
    </section>

    ${sectionsOf(items).map(g=>html`<section key=${g.s} class="grid gap-2"><h3 class="font-display text-[15px] font-semibold px-1 mt-1">${g.s}</h3>
      ${g.items.map(it=>{n++;return html`<${Question} key=${it.key} it=${it} n=${n} known=${(a.defects||[]).find(x=>x.item_key===it.key)} a=${d.answers[it.key]||{}} set=${p=>setAns(it.key,p)} busy=${!!uploading[it.key]} urls=${urls} onPhoto=${f=>addPhoto(it.key,f)}/>`})}</section>`)}

    <section class="panel p-3 grid gap-3"><div class="label">Finish</div>
      <label class="grid gap-1"><span class="text-[14px] font-medium">Notes (optional)</span><textarea id="ps-notes" class="field" rows="2" style=${{height:'auto',minHeight:56,padding:'8px 10px',fontSize:15}} value=${d.notes} onInput=${e=>upd({notes:e.target.value})}></textarea></label>
      <div class="grid gap-1"><div class="flex items-center"><span class="text-[14px] font-medium flex-1">Signature</span>${ink&&html`<button type="button" class="text-[12.5px] text-muted hover:text-ink" onClick=${()=>{pad.current.clear();sig.current={path:null,dirty:true}}}>Clear</button>`}</div>
        <${SignPad} padRef=${pad} onInk=${v=>{setInk(v);if(v)sig.current={path:null,dirty:true}}}/></div>
      <label class="flex items-start gap-2.5 text-[14px] cursor-pointer"><input id="ps-agree" type="checkbox" class="w-5 h-5 mt-0.5 shrink-0" checked=${agree} onChange=${e=>setAgree(e.target.checked)}/>
        <span>I have checked this machine myself and these answers are true.</span></label>
      ${err&&html`<div id="ps-err" role="alert" class="text-[13.5px] font-medium rounded-lg px-3 py-2" style=${{color:'hsl(0 72% 40%)',background:'hsl(0 80% 96%)'}}>${err}</div>`}
      <button id="ps-submit" type="button" class="btn btn-primary w-full justify-center text-[15px]" style=${{height:50}} disabled=${busy} onClick=${submit}>${busy?'Submitting…':'Submit prestart'}</button>
    </section>
  </div>`;
}

function PsDone({res,a,onHome,onView}){
  const r=RES[res.result]||RES.pass;
  const msg=res.queued?(res.result==='pass'?'You’re good to go.':res.result==='defects'?'Tell your supervisor about the faults before you start.':'A critical item failed. Don’t use this machine. Tell your supervisor now.')
    :res.result==='pass'?'Prestart saved. You’re good to go.':res.result==='defects'?'Prestart saved. The faults have gone to the workshop as defects. Tell your supervisor before you start.':'A critical item failed. Don’t use this machine: it is now restricted. Tell your supervisor now.';
  return html`<div class="grid gap-3 max-w-[560px] mx-auto w-full" id="ps-done">
    <div class="panel p-5 grid gap-2 text-center" style=${{boxShadow:`inset 0 0 0 2px ${r[1]}`}}>
      <div class="mx-auto w-14 h-14 rounded-full inline-flex items-center justify-center text-white" style=${{background:r[1]}}>${res.result==='pass'?I.tick:res.result==='defects'?Icon.alert:I.cross}</div>
      <div id="ps-result" class="font-display text-[24px] font-semibold" style=${{color:r[1]}}>${r[0]}</div>
      <div class="text-[15px]">${a.m.name} · ${a.m.sub||''}</div><div class="text-[14px] text-muted">${msg}</div>
      ${res.meter_note&&html`<div class="text-[13px] font-medium mt-1" style=${{color:'hsl(30 90% 38%)'}}>${res.meter_note}. The workshop will check the meter.</div>`}
      ${res.queued&&html`<div id="ps-queued" class="text-[13.5px] font-medium rounded-lg px-3 py-2 mt-1" style=${{background:'hsl(38 90% var(--blk-l))'}}>No reception: saved on this phone. It sends automatically when you have reception. Keep the app open or open it again later.</div>`}
    </div>
    <div class=${'grid gap-2 '+(res.queued?'grid-cols-1':'grid-cols-2')}>${!res.queued&&html`<button type="button" class="btn justify-center" style=${{height:46}} onClick=${onView}>View prestart</button>`}<button id="ps-home" type="button" class="btn btn-primary justify-center" style=${{height:46}} onClick=${onHome}>Back to machines</button></div>
  </div>`;
}

/* ---------- a submitted prestart (read only) ---------- */
function PrestartView({ctx,ps,onClose}){
  const {sb,M,db}=ctx;const [rows,setRows]=useState(null);const [err,setErr]=useState('');
  const [del,setDel]=useState(null);const [busy,setBusy]=useState(false);   /* the administrator can delete one (e.g. a test), giving a reason */
  const remove=async()=>{if(!(del||'').trim()){setErr('Say why it’s being deleted.');return}setBusy(true);setErr('');
    const {error}=await sb.rpc('delete_prestart',{pid:ps.id,reason:del.trim()});setBusy(false);
    if(error){setErr(errMsg(error));return}ctx.notify&&ctx.notify('Prestart deleted');ctx.reload&&ctx.reload();onClose()};
  useEffect(()=>{sb.from('prestart_answers').select('*').eq('prestart_id',ps.id).order('pos').then(({data,error})=>{if(error)setErr(errMsg(error));else setRows(data||[])})},[ps.id]);
  const a=M.byId.get(ps.asset_id);const tpl=db.prestart_templates.find(t=>t.id===ps.template_id);
  const urls=useSigned(sb,[ps.signature,...(rows||[]).flatMap(r=>r.photos||[])].filter(Boolean));
  const groups=[];(rows||[]).forEach(r=>{const s=r.section||'Checks';let g=groups.find(x=>x.s===s);if(!g){g={s,rows:[]};groups.push(g)}g.rows.push(r)});
  const mark=r=>r.kind!=='check'?null:r.answer==='pass'?html`<span class="w-6 h-6 rounded-full inline-flex items-center justify-center text-white shrink-0" style=${{background:'hsl(145 55% 36%)'}} title="Pass">${I.tick}</span>`
    :r.answer==='fail'?html`<span class="w-6 h-6 rounded-full inline-flex items-center justify-center text-white shrink-0" style=${{background:'hsl(0 72% 47%)'}} title="Fail">${I.cross}</span>`
    :html`<span class="w-6 h-6 rounded-full inline-flex items-center justify-center shrink-0 text-muted" style=${{background:'var(--sunken)'}} title="Not applicable">${I.dash}</span>`;
  return html`<${Modal} title=${html`<span class="inline-flex items-center gap-2 flex-wrap">Prestart · ${a?a.m.name:ps.asset_id} ${resChip(ps.result)}</span>`} sub=${`${fmtDT(ps.submitted_at)} · ${ps.operator_name}`} onClose=${onClose}
    foot=${del!=null?html`<input id="ps-del-reason" class="field flex-1 min-w-[200px]" style=${fs} placeholder="Why delete it? e.g. Test prestart" value=${del} onInput=${e=>setDel(e.target.value)} aria-label="Reason for deleting"/>
        <button type="button" class="btn" onClick=${()=>{setDel(null);setErr('')}}>Keep</button><button id="ps-del-go" type="button" class="btn" style=${{color:'var(--bad)'}} disabled=${busy} onClick=${remove}>${busy?'Deleting…':'Delete prestart'}</button>`
      :html`<span class="text-[12px] text-muted mr-auto">Submitted prestarts can’t be changed</span>${ctx.role==='admin'&&html`<button id="ps-del" type="button" class="btn" style=${{color:'var(--bad)'}} onClick=${()=>setDel('')}>Delete…</button>`}<button type="button" class="btn" onClick=${onClose}>Close</button>`}>
    <div class="grid gap-3" id="ps-view">
      <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
        ${[['Machine',a?`${a.m.name} · ${a.m.sub||''}`:ps.asset_id],['Checklist',tpl?`${tpl.name} · v${tpl.version}`:''],['Meters',[ps.hours!=null&&`${fmtN(+ps.hours)} h`,ps.km!=null&&`${fmtN(+ps.km)} km`].filter(Boolean).join(' · ')],
          ['Location',ps.location],['Started',fmtTime(ps.started_at)],['Failed items',String(ps.failed)]].map(([k,v])=>html`<div key=${k} class="min-w-0"><span class="text-muted">${k}</span><div class="truncate">${v||'–'}</div></div>`)}
      </div>
      ${ps.meter_note&&html`<div class="text-[12.5px] font-medium rounded-lg px-3 py-2" style=${{color:'hsl(30 90% 34%)',background:'var(--sunken)'}}>${ps.meter_note}</div>`}
      ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      ${!rows&&!err&&html`<div class="text-[12.5px] text-muted">Loading answers…</div>`}
      ${groups.map(g=>html`<section key=${g.s} class="grid gap-1"><div class="label">${g.s}</div>
        <div class="rounded-lg border border-line divide-y" style=${{borderColor:'var(--line)'}}>${g.rows.map(r=>html`<div key=${r.id} class="px-3 py-2 grid gap-1" style=${{borderColor:'var(--line)',background:r.answer==='fail'?'hsl(0 80% 97%)':null}}>
          <div class="flex items-start gap-2">${mark(r)}<div class="min-w-0 flex-1 text-[13px] ${r.kind==='check'?'':'pl-0'}">${r.question}${r.critical&&html` <span class="text-[10px] font-bold uppercase tracking-wide px-1 rounded" style=${{background:'hsl(0 72% 47%)',color:'#fff'}}>Critical</span>`}
            ${r.kind!=='check'&&html`<div class="font-medium mono">${r.answer||html`<span class="text-faint">–</span>`}</div>`}
            ${r.comment&&html`<div class="text-[12.5px] font-medium" style=${{color:'hsl(0 72% 40%)'}}>${r.comment}</div>`}</div></div>
          ${(r.photos||[]).length>0&&html`<div class="flex flex-wrap gap-2 pl-8">${r.photos.map(p=>html`<a key=${p} href=${urls[p]||'#'} target="_blank" rel="noopener"><img src=${urls[p]||''} alt="Photo" class="w-20 h-20 rounded-lg object-cover border border-line bg-sunken"/></a>`)}</div>`}
        </div>`)}</div></section>`)}
      ${ps.notes&&html`<div class="grid gap-1"><div class="label">Notes</div><div class="text-[13px] whitespace-pre-line">${ps.notes}</div></div>`}
      <div class="grid gap-1"><div class="label">Signed</div><div class="rounded-lg border border-line bg-white p-1 max-w-[320px]">${urls[ps.signature]?html`<img id="ps-view-sign" src=${urls[ps.signature]} alt="Signature" class="w-full"/>`:html`<div class="h-16"></div>`}</div>
        <div class="text-[12px] text-muted">${ps.operator_name} · ${fmtDT(ps.submitted_at)}</div></div>
    </div><//>`;
}

/* ---------- the Prestarts screen (phones) ---------- */
function PrestartScreen({data,live,notify}){
  const sb=live.sb;const me=live.user.id;
  const {db,err,reload}=useMaint(sb);
  const [prof,setProf]=useState(null);
  useEffect(()=>{const cached=()=>{try{return JSON.parse(localStorage.getItem('ff:prof:'+me)||'null')}catch(e){return null}};
    sb.from('profiles').select('*').eq('id',me).maybeSingle().then(({data:p,error})=>{if(error)throw error;setProf(p||{});try{localStorage.setItem('ff:prof:'+me,JSON.stringify(p||{}))}catch(e){}}).catch(()=>setProf(cached()||{}))},[]);
  /* prestarts waiting on this phone: sent when there's reception (now, when it comes back, and every 30 seconds) */
  const [queue,setQueue]=useState([]);
  useEffect(()=>{let off=false;const refresh=()=>readOutbox(me).then(l=>{if(!off)setQueue(l)});
    const go=()=>flushOutbox(sb,me);
    const done=e=>{refresh();if(e.detail&&e.detail.sent){notify(`${e.detail.sent} prestart${e.detail.sent===1?'':'s'} sent`);reload()}};
    refresh();go();window.addEventListener('online',go);window.addEventListener('ff-outbox',done);const iv=setInterval(()=>{if(navigator.onLine)go()},30000);
    return()=>{off=true;window.removeEventListener('online',go);window.removeEventListener('ff-outbox',done);clearInterval(iv)}},[]);
  const [view,setView]=useState({k:'home'});const [q,setQ]=useState('');const [show,setShow]=useState(null);
  const inst=window.ffUseInstall?window.ffUseInstall():null;const [hideInst,setHideInst]=useState(()=>{try{return localStorage.getItem(KEY+':ps-noinstall')==='1'}catch(e){return false}});
  const M=useMemo(()=>db?buildModel(data,db):null,[db,data.resources,data.blocks]);
  useEffect(()=>{const el=document.getElementById('ps-scroll');if(el)el.scrollTop=0},[view.k,view.a&&view.a.m.id]);
  if(err&&!db)return html`<div class="panel p-6 grid gap-2 max-w-[640px]"><div class="font-display text-[17px] font-semibold">Prestarts aren’t set up yet</div><p class="text-[13px] text-muted">An administrator needs to run the Fleet & Maintenance database scripts in Supabase.</p><p class="text-[12px] text-faint mono">${err}</p><div><button type="button" class="btn" onClick=${reload}>Try again</button></div></div>`;
  if(!M||!prof)return html`<div class="panel p-6 text-[13px] text-muted">Loading…</div>`;
  if(!db.p3)return html`<div class="panel p-6 grid gap-2 max-w-[640px]"><div class="font-display text-[17px] font-semibold">Prestarts aren’t set up yet</div><p class="text-[13px] text-muted">An administrator needs to run <span class="mono">supabase/prestarts.sql</span> once in Supabase → SQL Editor.</p><p class="text-[12px] text-faint mono">${db.p3err||''}</p><div><button type="button" class="btn" onClick=${reload}>Try again</button></div></div>`;
  const ctx={sb,db,data,M,me,notify,reload,role:live.role};
  const staff=prof.staff_id?data.resources.find(r=>r.id===prof.staff_id):null;
  const tpls=db.prestart_templates;
  let body;
  if(view.k==='form'){const a=M.byId.get(view.a.m.id)||view.a;const tpl=tplFor(tpls,a.m);
    body=tpl?html`<${PsForm} key=${a.m.id} ctx=${ctx} a=${a} tpl=${tpl} onBack=${()=>setView({k:'home'})} onDone=${r=>{if(r.queued)readOutbox(me).then(setQueue);else reload();setView({k:'done',a,res:r})}}/>`
      :html`<div class="panel p-4 text-[14px]">There’s no prestart checklist for ${machCatOf(a.m)||'this machine'} any more. <button class="btn mt-2" type="button" onClick=${()=>setView({k:'home'})}>Back</button></div>`}
  else if(view.k==='done'){body=html`<${PsDone} res=${view.res} a=${view.a} onHome=${()=>setView({k:'home'})} onView=${()=>{const p=db.prestarts.find(x=>x.id===view.res.id);if(p)setShow(p)}}/>`}
  else{
    const today=M.today;const drafts=readDrafts(me);
    const todays=new Map();db.prestarts.filter(p=>localDay(p.submitted_at)===today).forEach(p=>{if(!todays.has(p.asset_id))todays.set(p.asset_id,p)});
    const mine=db.prestarts.filter(p=>p.operator===me).slice(0,8);
    const ql=q.trim().toLowerCase();const crewId=staff&&staff.crewId;
    /* booked for today's shift (ticked on a job booking): those come first, the operator's own crew's job before others */
    const nowShift=new Date().getHours()>=15?'night':'day';
    const bookedOn=m=>{const bs=data.blocks.filter(b=>b.kind==='job'&&machinesOn(b,today).includes(m.id)&&covers(b,today)&&worksOn(b,TODAY));
      return bs.find(b=>(b.shift||'day')===nowShift)||bs[0]||null};
    const bk=new Map(M.assets.map(a=>[a.m.id,bookedOn(a.m)]));
    const rank=a=>{const b=bk.get(a.m.id);return b?(crewId&&b.resourceId===crewId?0:1):(crewId&&a.m.crewId===crewId?2:3)};
    const list=M.assets.filter(a=>!a.retired&&(!ql||[a.m.name,a.m.sub,a.m.rego,machCatOf(a.m)].join(' ').toLowerCase().includes(ql)))
      .sort((x,y)=>rank(x)-rank(y)||x.m.name.localeCompare(y.m.name));
    const bkText=b=>{const c=data.resources.find(r=>r.id===b.resourceId);const j=data.jobs.find(x=>x.id===b.jobId);return [c&&c.name,j&&[j.customer,j.name].filter(Boolean).join(' · ')].filter(Boolean).join(' · ')+(b.shift==='night'?' (night)':'')};
    const dlist=Object.values(drafts).map(dr=>({dr,a:M.byId.get(dr.asset_id)})).filter(x=>x.a);
    const showInst=inst&&!hideInst&&window.innerWidth<900;
    body=html`<div class="grid gap-3 pb-6">
      <div class="grid gap-0.5"><div class="font-display text-[20px] font-semibold">Prestart check</div>
        <div class="text-[13px] text-muted">${staff?`Signed in as ${staff.name}`:html`Signed in as ${showLogin(live.user.email)}. <span style=${{color:'hsl(30 90% 38%)'}}>Your login isn’t linked to your Staff record yet: ask an administrator.</span>`}</div></div>
      ${showInst&&html`<div id="ps-install" class="panel p-3 flex items-center gap-3"><img src="/icons/icon-192.png" alt="" class="w-11 h-11 rounded-xl border border-line shrink-0"/>
        <div class="min-w-0 flex-1"><div class="text-[14px] font-semibold">Put FraserFlow on your home screen</div><div class="text-[12.5px] text-muted">${inst.kind==='prompt'?'It opens like an app, straight to your prestarts.':inst.steps}</div></div>
        ${inst.kind==='prompt'&&html`<button type="button" class="btn btn-primary" style=${{height:38}} onClick=${inst.go}>Install</button>`}
        <button type="button" class="p-1 rounded text-muted hover:text-ink" aria-label="Not now" onClick=${()=>{setHideInst(true);try{localStorage.setItem(KEY+':ps-noinstall','1')}catch(e){}}}>${Icon.x}</button></div>`}
      ${queue.length>0&&html`<section id="ps-outbox" class="panel p-3 grid gap-2" aria-label="Waiting to send" style=${{boxShadow:'inset 0 0 0 1.5px hsl(38 90% 45%)'}}>
        <div class="flex items-center gap-2"><span class="text-[14.5px] font-semibold flex-1">Waiting to send (${queue.length})</span>${navigator.onLine&&html`<button type="button" class="btn" style=${{height:34}} onClick=${()=>flushOutbox(sb,me)}>Send now</button>`}</div>
        <div class="text-[12.5px] text-muted">Saved on this phone with no reception. They send automatically when there’s reception.</div>
        ${queue.map(x=>{const qa=M.byId.get(x.asset_id);return html`<div key=${x.client_id} class="grid gap-1 border-t border-line pt-2">
          <div class="flex items-center gap-2"><span class="text-[14px] font-medium flex-1 truncate">${qa?qa.m.name:x.asset_id} <span class="text-muted font-normal">${qa?qa.m.sub||'':''}</span></span><span class="text-[12px] text-muted">${fmtTime(x.at)}</span>${resChip(x.result)}</div>
          ${x.error&&html`<div class="flex items-center gap-2"><span class="text-[12.5px] flex-1" style=${{color:'var(--bad)'}}>Couldn’t send: ${x.error}</span>
            <button type="button" class="text-[12.5px] text-muted hover:text-ink" onClick=${async()=>{await removeFromOutbox(me,[x.client_id]);setQueue(await readOutbox(me))}}>Remove</button>
            <button type="button" class="btn" style=${{height:30}} onClick=${async()=>{const l=await readOutbox(me);await ffStore.set(OBK(me),l.map(y=>y.client_id===x.client_id?{...y,error:null}:y));flushOutbox(sb,me)}}>Try again</button></div>`}</div>`})}
      </section>`}
      ${dlist.length>0&&html`<section class="grid gap-2" aria-label="Unfinished prestarts">${dlist.map(({dr,a})=>html`<div key=${a.m.id} class="panel p-3 flex items-center gap-3" style=${{boxShadow:'inset 0 0 0 1.5px var(--accent)'}}>
          <div class="min-w-0 flex-1"><div class="text-[14.5px] font-semibold truncate">Unfinished: ${a.m.name} · ${a.m.sub||''}</div><div class="text-[12.5px] text-muted">Started ${fmtTime(dr.started_at)}, ${Object.keys(dr.answers||{}).length} answered</div></div>
          <button type="button" class="text-[12.5px] text-muted hover:text-ink px-1" onClick=${()=>{writeDraft(me,{asset_id:a.m.id,del:true});setView({k:'home',t:Date.now()})}}>Discard</button>
          <button type="button" class="btn btn-primary" style=${{height:40}} onClick=${()=>setView({k:'form',a})}>Continue</button></div>`)}</section>`}
      <input id="ps-search" type="search" class="field" style=${{height:44,fontSize:16}} placeholder="Find a machine: fleet no., name or rego" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Find a machine"/>
      <section class="panel divide-y overflow-hidden" style=${{borderColor:'var(--line)'}} aria-label="Machines" id="ps-machines">
        ${list.map((a,i)=>{const tpl=tplFor(tpls,a.m);const t=todays.get(a.m.id);const mineCrew=crewId&&a.m.crewId===crewId;const b=bk.get(a.m.id);
          const head=i===0&&b?'Booked for today':(i>0&&bk.get(list[i-1].m.id)&&!b)?'Other machines':null;
          return html`${head&&html`<div key=${'h'+i} class="px-3 py-1.5 label bg-sunken ps-group">${head}</div>`}<button key=${a.m.id} type="button" class="w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-sunken disabled:opacity-60" style=${{borderColor:'var(--line)'}} disabled=${!tpl} onClick=${()=>setView({k:'form',a})}>
            <div class="min-w-0 flex-1"><div class="text-[15px] font-semibold">${a.m.name} <span class="font-normal text-muted text-[13.5px]">${a.m.sub||''}</span>${mineCrew&&html` <span class="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Your crew</span>`}</div>
              <div class="text-[12.5px] text-muted truncate">${a.m.rego&&html`<span class="mono font-medium text-ink ps-rego">Rego ${a.m.rego}</span> · `}${tpl?`${machCatOf(a.m)||'No category'} · ${meterTxt(a)}`:`No prestart checklist for ${machCatOf(a.m)||'this machine'} yet`}</div>
              ${b&&html`<div class="text-[12.5px] font-medium truncate ps-booked" style=${{color:'var(--accent)'}}>Today: ${bkText(b)}</div>`}</div>
            ${a.restr&&a.restr.length?html`<span class="shrink-0 text-[10.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style=${{background:'hsl(0 72% 47%)',color:'#fff'}}>Do not use</span>`:''}
            ${t?html`<span class="text-right shrink-0"><span class="block">${t.result==='unsafe'?resChip('unsafe'):html`<span class="inline-flex items-center text-[11.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ps-done-chip" style=${{color:'hsl(145 55% 32%)',background:'var(--sunken)',boxShadow:'inset 0 0 0 1px hsl(145 55% 36%)'}}>Prestart done</span>`}</span><span class="block text-[11.5px] text-muted mt-0.5">${fmtTime(t.submitted_at)} · ${t.operator_name.split(' ')[0]}</span></span>`:tpl&&html`<span class="text-muted shrink-0">${Icon.chevR}</span>`}</button>`})}
        ${!list.length&&html`<div class="px-3 py-6 text-center text-[13px] text-muted">No machines match.</div>`}
      </section>
      ${mine.length>0&&html`<section class="grid gap-2"><h3 class="font-display text-[15px] font-semibold px-1">Your recent prestarts</h3>
        <div class="panel divide-y overflow-hidden" style=${{borderColor:'var(--line)'}}>${mine.map(p=>{const a=M.byId.get(p.asset_id);return html`<button key=${p.id} type="button" class="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-sunken" style=${{borderColor:'var(--line)'}} onClick=${()=>setShow(p)}>
          <div class="min-w-0 flex-1"><div class="text-[14px] font-medium truncate">${a?a.m.name:p.asset_id} <span class="text-muted font-normal">${a?a.m.sub||'':''}</span></div><div class="text-[12px] text-muted">${fmtDT(p.submitted_at)}</div></div>${resChip(p.result)}</button>`})}</div></section>`}
    </div>`;
  }
  return html`<div id="ps-scroll" class="flex-1 min-h-0 overflow-y-auto"><div class="max-w-[640px] mx-auto w-full px-1">${body}</div>
    ${show&&html`<${PrestartView} ctx=${ctx} ps=${show} onClose=${()=>setShow(null)}/>`}</div>`;
}

/* ---------- Fleet › Prestarts: inspection history ---------- */
function PrestartsTab({ctx,open}){
  const {M,db}=ctx;const [res,setRes]=useState('');const [q,setQ]=useState('');const [days,setDays]=useState(30);
  if(!db.p3)return html`<${NotSetUp} db=${db}/>`;
  const since=iso(addDays(TODAY,-(days-1)));const ql=q.trim().toLowerCase();
  const rows=db.prestarts.filter(p=>localDay(p.submitted_at)>=since&&(!res||(res==='bad'?p.result!=='pass':p.result===res))&&(!ql||[p.operator_name,p.location,(M.byId.get(p.asset_id)||{m:{}}).m.name,(M.byId.get(p.asset_id)||{m:{}}).m.sub].join(' ').toLowerCase().includes(ql)));
  const today=db.prestarts.filter(p=>localDay(p.submitted_at)===M.today);const act=M.assets.filter(a=>!a.retired);
  const checked=new Set(today.map(p=>p.asset_id));
  return html`<section class="panel flex flex-col min-h-0">
    <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line">
      <div class="seg" role="group" aria-label="Result"><button type="button" aria-pressed=${res===''} onClick=${()=>setRes('')}>All</button><button type="button" id="psh-bad" aria-pressed=${res==='bad'} onClick=${()=>setRes('bad')}>With defects</button><button type="button" aria-pressed=${res==='unsafe'} onClick=${()=>setRes('unsafe')}>Do not operate</button></div>
      <select class="field w-auto" style=${fs} value=${days} onChange=${e=>setDays(+e.target.value)} aria-label="Period"><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>
      <input id="psh-search" class="field" style=${{...fs,width:220}} placeholder="Search machine, operator, location" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search prestarts"/>
      <span class="flex-1"></span><span class="text-[12.5px] text-muted">Today: <span class="font-semibold text-ink">${today.length}</span> prestart${today.length===1?'':'s'}, ${checked.size} of ${act.length} machines checked</span>
    </div>
    <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="psh-table">
      <thead><tr class="text-left">${['When','Machine','Operator','Checklist','Result','Failed','Meters','Location'].map(h=>html`<th key=${h} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
      <tbody>${rows.map(p=>{const a=M.byId.get(p.asset_id);const t=db.prestart_templates.find(x=>x.id===p.template_id);return html`<tr key=${p.id} class="border-t border-line cursor-pointer hover:bg-sunken" tabindex="0" onClick=${()=>open({k:'ps',ps:p})} onKeyDown=${e=>{if(e.key==='Enter')open({k:'ps',ps:p})}}>
          <td class="py-2 px-3 whitespace-nowrap mono">${fmtDT(p.submitted_at)}</td>
          <td class="py-2 px-3 whitespace-nowrap"><span class="font-medium">${a?a.m.name:p.asset_id}</span> <span class="text-muted">${a?a.m.sub||'':''}</span></td>
          <td class="py-2 px-3 whitespace-nowrap">${p.operator_name}</td>
          <td class="py-2 px-3 whitespace-nowrap text-muted">${t?`${t.name} v${t.version}`:''}</td>
          <td class="py-2 px-3 whitespace-nowrap">${resChip(p.result)}</td>
          <td class="py-2 px-3 tnum">${p.failed||html`<span class="text-faint">0</span>`}</td>
          <td class="py-2 px-3 mono tnum whitespace-nowrap">${[p.hours!=null&&`${fmtN(+p.hours)} h`,p.km!=null&&`${fmtN(+p.km)} km`].filter(Boolean).join(' · ')}${p.meter_note?html` <span title=${p.meter_note} style=${{color:'hsl(30 90% 40%)'}}>${Icon.alert}</span>`:''}</td>
          <td class="py-2 px-3 truncate max-w-[220px]">${p.location||html`<span class="text-faint">–</span>`}</td></tr>`})}
        ${!rows.length&&html`<tr><td colspan="8" class="px-3 py-6 text-center text-muted">No prestarts ${res?'like that ':''}in this period.</td></tr>`}</tbody></table></div>
  </section>`;
}
const NotSetUp=({db})=>html`<div class="panel p-6 grid gap-2 max-w-[640px]"><div class="font-display text-[17px] font-semibold">Prestarts aren’t set up yet</div>
  <p class="text-[13px] text-muted">An administrator needs to run <span class="mono">supabase/prestarts.sql</span> once in Supabase → SQL Editor.</p><p class="text-[12px] text-faint mono">${db.p3err||''}</p></div>`;

/* ---------- Fleet › Checklists: the builder ---------- */
function ChecklistDialog({ctx,tpl,onClose}){
  const {sb,notify,reload,data,db}=ctx;
  const [f,setF]=useState(()=>({name:tpl?tpl.name:'',category:tpl?tpl.category||'':'',scope:tpl&&tpl.asset_id?'asset':'category',asset_id:tpl&&tpl.asset_id||'',items:tpl?tpl.items.map(x=>({...x})):[]}));
  /* start a new checklist from one already made (the newest version of each) */
  const fams=(()=>{const m=new Map();db.prestart_templates.forEach(t=>{const o=m.get(t.family);if(!o||t.version>o.version)m.set(t.family,t)});return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name))})();
  const machName=id=>{const r=data.resources.find(x=>x.id===id);return r?`${r.name}${r.sub?' · '+r.sub:''}`:id};
  const copyFrom=id=>{const t=fams.find(x=>x.family===id);if(!t)return;setF(x=>({...x,name:x.name||`${t.name} (copy)`,items:t.items.map(it=>({...it}))}))};
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const setItem=(i,p)=>setF(x=>({...x,items:x.items.map((it,k)=>k===i?{...it,...p}:it)}));
  const move=(i,dir)=>setF(x=>{const a=[...x.items];const j=i+dir;if(j<0||j>=a.length)return x;[a[i],a[j]]=[a[j],a[i]];return {...x,items:a}});
  const add=()=>setF(x=>({...x,items:[...x.items,{key:'q-'+Math.random().toString(36).slice(2,8),section:(x.items[x.items.length-1]||{}).section||'',text:'',kind:'check',critical:false}]}));
  const sections=[...new Set([...f.items.map(i=>(i.section||'').trim()),...STANDARD.map(s=>s.section)].filter(Boolean))];
  const taken=db.prestart_templates.filter(t=>t.active&&!t.asset_id&&(!tpl||t.family!==tpl.family)).map(t=>(t.category||'').toLowerCase());
  const takenM=db.prestart_templates.filter(t=>t.active&&t.asset_id&&(!tpl||t.family!==tpl.family)).map(t=>t.asset_id);
  const machines=data.resources.filter(r=>r.type==='machine'&&!takenM.includes(r.id)).sort((a,b)=>a.name.localeCompare(b.name));
  const cats=machineCatsOf(data).filter(c=>!taken.includes(c.toLowerCase())||(tpl&&(tpl.category||'').toLowerCase()===c.toLowerCase()));
  const save=async()=>{setErr('');const items=f.items.map(i=>({key:i.key,section:(i.section||'').trim(),text:(i.text||'').trim(),kind:i.kind||'check',critical:kindOf(i)==='check'&&!!i.critical})).filter(i=>i.text);
    if(!f.name.trim()){setErr('Name the checklist, e.g. Roller prestart.');return}if(!items.length){setErr('Add at least one question.');return}
    if(f.scope==='asset'&&!f.asset_id){setErr('Pick the machine.');return}
    const cat=f.scope==='asset'?null:(f.category.trim()||null),aid=f.scope==='asset'?f.asset_id:null;
    if(tpl&&JSON.stringify(items)===JSON.stringify(tpl.items)&&f.name.trim()===tpl.name&&cat===(tpl.category||null)&&aid===(tpl.asset_id||null)){onClose();return}
    setBusy(true);const row={name:f.name.trim(),category:cat,items};if(aid)row.asset_id=aid;if(tpl)row.family=tpl.family;
    const {error}=await sb.from('prestart_templates').insert(row);setBusy(false);
    if(error){setErr(/asset_id/.test(errMsg(error))?'Checklists for one machine aren’t set up yet: an administrator needs to run supabase/prestarts.sql again.':errMsg(error));return}notify(tpl?`Checklist saved as version ${tpl.version+1}`:'Checklist saved');reload();onClose()};
  return html`<${Modal} wide=${true} title=${tpl?`Edit checklist · ${tpl.name}`:'New prestart checklist'} sub=${tpl?`Saving makes version ${tpl.version+1}. Prestarts already done keep the questions they answered.`:'The questions operators answer before starting a machine'} onClose=${onClose}
    foot=${html`${err&&html`<span id="cl-err" class="text-[12.5px] w-full" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="text-[12px] text-muted mr-auto">${f.items.filter(i=>(i.text||'').trim()).length} questions · ${f.items.filter(i=>i.critical&&kindOf(i)==='check').length} critical</span>
      <button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="cl-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>${busy?'Saving…':'Save checklist'}</button>`}>
    <div class="grid gap-4">
      <div class="grid sm:grid-cols-2 gap-3">
        <${Fld} label="Checklist name"><input id="cl-name" class="field" style=${fs} placeholder="e.g. Roller prestart" value=${f.name} onInput=${e=>setF({...f,name:e.target.value})}/><//>
        <div class="grid gap-1 min-w-0"><span class="label">Used for</span><div class="grid gap-2"><div class="seg w-max" id="cl-scope"><button type="button" aria-pressed=${f.scope==='category'} onClick=${()=>setF({...f,scope:'category'})}>A machine category</button><button id="cl-scope-asset" type="button" aria-pressed=${f.scope==='asset'} onClick=${()=>setF({...f,scope:'asset'})}>One machine</button></div>
          ${f.scope==='asset'?html`<select id="cl-asset" class="field" style=${fs} value=${f.asset_id} onChange=${e=>setF({...f,asset_id:e.target.value})}><option value="">Choose the machine…</option>${machines.map(m=>html`<option key=${m.id} value=${m.id}>${m.name}${m.sub?' · '+m.sub:''}</option>`)}</select>`
          :html`<select id="cl-cat" class="field" style=${fs} value=${f.category} onChange=${e=>setF({...f,category:e.target.value})}>
          ${(!taken.includes('')||(tpl&&!tpl.category&&!tpl.asset_id))&&html`<option value="">All other machines (no checklist of their own)</option>`}
          ${cats.map(c=>html`<option key=${c} value=${c}>${c}</option>`)}</select>`}</div></div>
        ${!tpl&&fams.length>0&&html`<${Fld} label="Copy from" span=${true}><select id="cl-copy" class="field" style=${fs} value="" onChange=${e=>{copyFrom(e.target.value);e.target.value=''}}><option value="">Start from a checklist already made…</option>${fams.map(t=>html`<option key=${t.family} value=${t.family}>${t.name} (${t.asset_id?machName(t.asset_id):t.category||'all other machines'}${t.active?'':', not in use'})</option>`)}</select><//>`}
      </div>
      ${f.scope==='asset'&&html`<p class="text-[12.5px] text-muted -mt-2">This machine uses this checklist instead of the one for its category.</p>`}
      <p class="text-[12.5px] text-muted -mt-2">A <span class="font-semibold" style=${{color:'hsl(0 72% 47%)'}}>critical</span> question that fails means the machine must not be used. Pass / Fail questions need a comment when they fail, and can have photos.</p>
      ${!f.items.length&&html`<div class="rounded-lg border border-dashed border-line p-4 grid gap-2 justify-items-start"><div class="text-[13px]">Start from the standard list (walk-around, fluids, safety, after start-up) and change it to suit, or add your own questions.</div>
        <div class="flex gap-2"><button id="cl-standard" type="button" class="btn btn-primary" onClick=${()=>setF({...f,items:STANDARD.map(x=>({...x}))})}>Use the standard list</button><button type="button" class="btn" onClick=${add}>${Icon.plus} Add a question</button></div></div>`}
      ${f.items.length>0&&html`<div class="grid gap-1.5" id="cl-items">
        <div class="hidden md:grid grid-cols-[52px_170px_1fr_120px_70px_28px] gap-2 label px-1"><span></span><span>Section</span><span>Question</span><span>Answer</span><span>Critical</span><span></span></div>
        ${f.items.map((it,i)=>html`<div key=${it.key} class="grid grid-cols-[52px_1fr_28px] md:grid-cols-[52px_170px_1fr_120px_70px_28px] gap-2 items-center rounded-lg md:rounded-none border md:border-0 border-line p-2 md:p-0">
          <span class="inline-flex"><button type="button" class="w-6 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken disabled:opacity-30" disabled=${i===0} onClick=${()=>move(i,-1)} aria-label="Move up">${Icon.up}</button><button type="button" class="w-6 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken disabled:opacity-30" disabled=${i===f.items.length-1} onClick=${()=>move(i,1)} aria-label="Move down">${Icon.down}</button></span>
          <span class="md:contents grid gap-2 min-w-0">
            <${Combo} id=${'cl-sec-'+i} className="field" style=${{height:30,fontSize:13}} label="Section" value=${it.section||''} placeholder="Section" onChange=${v=>setItem(i,{section:v})} options=${sections}/>
            <input id=${'cl-q-'+i} class="field" style=${{height:30,fontSize:13}} placeholder="e.g. Brakes and park brake work" value=${it.text} onInput=${e=>setItem(i,{text:e.target.value})} aria-label="Question"/>
            <select id=${'cl-kind-'+i} class="field" style=${{height:30,fontSize:13}} value=${kindOf(it)} onChange=${e=>setItem(i,{kind:e.target.value})} aria-label="Answer type"><option value="check">Pass / Fail</option><option value="number">Number</option><option value="text">Note (optional)</option></select>
            <label class="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer"><input id=${'cl-crit-'+i} type="checkbox" class="w-4 h-4" disabled=${kindOf(it)!=='check'} checked=${!!it.critical&&kindOf(it)==='check'} onChange=${e=>setItem(i,{critical:e.target.checked})}/><span class="md:hidden">Critical</span></label>
          </span>
          <button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>setF({...f,items:f.items.filter((_,k)=>k!==i)})} aria-label="Remove question">${Icon.x}</button></div>`)}
        <button id="cl-add" type="button" class="justify-self-start text-[12.5px] font-medium inline-flex items-center gap-1 text-muted hover:text-ink mt-1" onClick=${add}>${Icon.plus} Add a question</button></div>`}
    </div><//>`;
}

function ChecklistsTab({ctx,open}){
  const {db,perms,M,sb,notify,reload}=ctx;
  if(!db.p3)return html`<${NotSetUp} db=${db}/>`;
  const fam=new Map();db.prestart_templates.forEach(t=>{const o=fam.get(t.family);if(!o||t.version>o.version)fam.set(t.family,t)});
  const list=[...fam.values()].sort((a,b)=>(b.active-a.active)||(!!a.asset_id-!!b.asset_id)||((a.category||'~').localeCompare(b.category||'~')));
  const covers=t=>M.assets.filter(a=>!a.retired&&tplFor(db.prestart_templates,a.m)===t).length;
  const uncovered=M.assets.filter(a=>!a.retired&&!tplFor(db.prestart_templates,a.m));
  const used=id=>db.prestarts.filter(p=>db.prestart_templates.some(t=>t.id===p.template_id&&t.family===id)).length;
  const setActive=async(t,v)=>{const {error}=await sb.from('prestart_templates').update({active:v}).eq('id',t.id);if(error){notify(errMsg(error));return}notify(v?'Checklist back in use':'Checklist taken out of use');reload()};
  return html`<section class="panel flex flex-col min-h-0">
    <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line"><div class="text-[12.5px] text-muted">Each machine uses its own checklist if it has one, otherwise the one for its category. A checklist for “all other machines” covers the rest.</div>
      <span class="flex-1"></span>${perms.mgr&&html`<button id="cl-new" type="button" class="btn btn-primary" onClick=${()=>open({k:'checklist'})}>${Icon.plus} New checklist</button>`}</div>
    ${uncovered.length>0&&html`<div class="px-3 py-2 text-[12.5px] border-b border-line" style=${{color:'hsl(30 90% 36%)'}}>${uncovered.length} machine${uncovered.length===1?' has':'s have'} no prestart checklist: ${[...new Set(uncovered.map(a=>machCatOf(a.m)||'no category'))].join(', ')}</div>`}
    <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="cl-table">
      <thead><tr class="text-left">${['Used for','Checklist','Questions','Version','Machines','Prestarts (90 days)',''].map((h,i)=>html`<th key=${i} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
      <tbody>${list.map(t=>html`<tr key=${t.family} class="border-t border-line" style=${t.active?null:{opacity:.55}}>
          <td class="py-2 px-3 whitespace-nowrap font-medium">${t.asset_id?html`${(ctx.data.resources.find(r=>r.id===t.asset_id)||{}).name||t.asset_id} <span class="text-muted font-normal">(one machine)</span>`:t.category||'All other machines'}</td>
          <td class="py-2 px-3">${t.name}${!t.active?html` <span class="text-[11px] text-muted">(not in use)</span>`:''}</td>
          <td class="py-2 px-3 whitespace-nowrap">${t.items.length} <span class="text-muted">· ${t.items.filter(i=>i.critical).length} critical</span></td>
          <td class="py-2 px-3 whitespace-nowrap">v${t.version} <span class="text-muted">· ${fmtTs(t.created_at)}</span></td>
          <td class="py-2 px-3 tnum">${t.active?covers(t):'–'}</td>
          <td class="py-2 px-3 tnum">${used(t.family)}</td>
          <td class="py-2 px-3 text-right whitespace-nowrap">${perms.mgr&&html`${t.active&&html`<button type="button" class="p-1 rounded text-muted hover:text-ink" onClick=${()=>open({k:'checklist',tpl:t})} aria-label=${'Edit '+t.name}>${Icon.pencil}</button>`}
            <button type="button" class="text-[12px] text-muted hover:text-ink ml-1" onClick=${()=>setActive(t,!t.active)}>${t.active?'Take out of use':'Put back in use'}</button>`}</td></tr>`)}
        ${!list.length&&html`<tr><td colspan="7" class="px-3 py-6 text-center text-muted">No checklists yet.${perms.mgr?' Add one: the standard list is a good start.':' An administrator adds them.'}</td></tr>`}</tbody></table></div>
    ${!perms.mgr&&html`<p class="px-3 py-2 text-[12px] text-muted">Only administrators can change checklists.</p>`}
  </section>`;
}

/* logins live on the Staff screen (People) in app.js */

/* ---------- machine panel: prestarts, manuals and documents ---------- */
function AssetPrestarts({ctx,a,open}){
  const {db}=ctx;if(!db.p3)return null;
  const ps=db.prestarts.filter(p=>p.asset_id===a.m.id).slice(0,6);
  return html`<section class="grid gap-2"><div class="flex items-baseline gap-2"><h3 class="font-display text-[15px] font-semibold">Recent prestarts</h3><span class="text-[12px] text-muted">Last 90 days</span></div>
    ${!ps.length?html`<div class="text-[12.5px] text-muted">No prestarts yet.</div>`:html`<div class="rounded-lg border border-line divide-y" style=${{borderColor:'var(--line)'}}>${ps.map(p=>html`<button key=${p.id} type="button" class="w-full text-left px-3 py-2 flex flex-wrap items-center gap-2 hover:bg-sunken" style=${{borderColor:'var(--line)'}} onClick=${()=>open({k:'ps',ps:p})}>
      <span class="mono text-[12px] text-muted w-[150px]">${fmtDT(p.submitted_at)}</span><span class="text-[13px] flex-1 min-w-0 truncate">${p.operator_name}</span>${p.failed>0&&html`<span class="text-[12px] text-muted">${p.failed} failed</span>`}${resChip(p.result)}</button>`)}</div>`}
  </section>`;
}
function FilesSection({ctx,a}){
  const {db,sb,perms,notify,reload}=ctx;const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [del,setDel]=useState(null);
  if(!db.p3)return null;
  const files=db.maintenance_files.filter(f=>f.asset_id===a.m.id).sort((x,y)=>x.name.localeCompare(y.name));
  const add=async file=>{setErr('');if(file.size>15*1024*1024){setErr('That file is over 15 MB.');return}
    if(!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.type)){setErr('Add a PDF or a picture (JPG, PNG).');return}
    setBusy(true);try{const safe=file.name.replace(/[^\w.\- ]+/g,'_').slice(-80);const path=`assets/${a.m.id}/${Date.now()}-${safe}`;
      const {error}=await sb.storage.from(BUCKET).upload(path,file,{contentType:file.type,upsert:false});if(error)throw error;
      const {error:e2}=await sb.from('maintenance_files').insert({asset_id:a.m.id,kind:file.type==='application/pdf'?'manual':'photo',name:file.name,path,mime:file.type,size:file.size});if(e2)throw e2;
      notify('Document added');reload()}catch(e){setErr(errMsg(e))}finally{setBusy(false)}};
  const openFile=async f=>{const w=window.open('','_blank');try{const o=await signedUrls(sb,[f.path]);if(o[f.path]){if(w)w.location=o[f.path];else location.href=o[f.path]}else{if(w)w.close();setErr('Couldn’t open that file.')}}catch(e){if(w)w.close();setErr(errMsg(e))}};
  const remove=async f=>{setDel(null);const {error}=await sb.from('maintenance_files').delete().eq('id',f.id);if(error){setErr(errMsg(error));return}
    await sb.storage.from(BUCKET).remove([f.path]);notify('Document removed');reload()};
  return html`<section class="rounded-lg border border-line p-3 grid gap-2" id="ap-files"><div class="flex items-center gap-2"><span class="label flex-1">Manuals and documents</span>
      ${perms.work&&html`<label class="text-[12px] text-muted hover:text-ink inline-flex items-center gap-1 cursor-pointer">${Icon.plus} ${busy?'Uploading…':'Add a file'}<input id="ap-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" class="hidden" disabled=${busy} onChange=${e=>{const f=e.target.files&&e.target.files[0];e.target.value='';if(f)add(f)}}/></label>`}</div>
    ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
    ${!files.length?html`<div class="text-[12.5px] text-muted">None yet.${perms.work?' Add operator manuals, service manuals or rego papers (PDF or pictures).':''}</div>`
      :html`<div class="grid gap-1">${files.map(f=>html`<div key=${f.id} class="flex items-center gap-2 text-[13px]"><span class="text-muted">${I.file}</span>
        <button type="button" class="hover:underline text-left min-w-0 flex-1 truncate" onClick=${()=>openFile(f)}>${f.name}</button><span class="text-[11.5px] text-muted whitespace-nowrap">${f.size?Math.max(1,Math.round(f.size/1024))+' KB · ':''}${fmtTs(f.created_at)}</span>
        ${perms.mgr&&(del===f.id?html`<button type="button" class="text-[12px] font-semibold" style=${{color:'var(--bad)'}} onClick=${()=>remove(f)}>Remove</button><button type="button" class="text-[12px] text-muted" onClick=${()=>setDel(null)}>Keep</button>`
          :html`<button type="button" class="p-1 rounded text-muted hover:text-ink" onClick=${()=>setDel(f.id)} aria-label=${'Remove '+f.name}>${Icon.x}</button>`)}</div>`)}</div>`}
  </section>`;
}

window.PrestartScreen=PrestartScreen;
window.FFP={useSigned,signedUrls,PrestartsTab,ChecklistsTab,ChecklistDialog,PrestartView,AssetPrestarts,FilesSection,tplFor,RES};
})();
