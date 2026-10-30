/* =====================================================================
   FraserFlow: site QA packs. One pack per booking shift: the JSA (job specific assessment) and an
   optional toolbox meeting. The supervisor fills it in on their phone; everyone signs on their own
   phone with a drawn signature; visitors and subbies sign on the supervisor's phone. Works without
   reception: changes wait on the phone and are sent when it's back. Database: supabase/qa.sql.
   Loaded with the Fleet files (maint.js first, for Modal and friends).
   ===================================================================== */
(function(){
const {Modal,Fld,fs,errMsg}=window.FFM;
const AFA='Alex Fraser Asphalt';
const FILL_ROLES=['admin','superuser','planner','supervisor'];
const newId=()=>{try{if(crypto.randomUUID)return crypto.randomUUID()}catch(e){}return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16)})};
const slug=t=>t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
const fmtDT=t=>t?new Date(t).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'';
const hhmm=()=>{const d=new Date();return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')};

/* ---------- the JSA, as on the paper form (version 0.1, issued 20.07.26) ---------- */
const JSA_VERSION='0.1';
const H=(hazard,...controls)=>({hazard,key:slug(hazard),controls});
const JSA_SECTIONS=[
  {id:'hs',label:'Health & Safety',hazards:[
    H('Movement of mobile plant','Exclusion zones / spotter','Separate work activities'),
    H('Open excavations / pits / trenches','Cover or barricade (fence off)'),
    H('Uneven ground','Delineate or barricade (fence off)'),
    H('Fatigue','Job rotation / take regular breaks'),
    H('Hazardous substances','Have SDS available','Additional PPE to be worn'),
    H('Hot product','Monitor maximum temperature','Ensure cool water is available at all times','Appropriate gloves to be worn (Glove Matrix)','All workers to carry a Bitumen Burns Card'),
    H('Bobcat / tractor broom','Separate from work activity','Operate under the control of a spotter'),
    H('Sprayer','Exclusion zones','Additional PPE to be worn'),
    H('Hazardous manual tasks','Use mechanical means where possible','Appropriate gloves to be worn'),
    H('Reversing on site','Truck controller / spotter in place'),
    H('Overhead wires (powerlines / communication cables etc.)','Identify with signage, bollards, painted lines','Spotter required'),
    H('Working on or adjacent to a road','Accredited traffic control in place'),
    H('Underground services','“Dial before you dig” or source info from customer','Identify with signage, bollards, or painted lines'),
    H('Working near water','Barricade (fence off)'),
    H('Working at night','Ensure all workers are wearing bio-motion clothing','Use lighting towers (check for overhead wires)'),
    H('Other work groups / pedestrians','Delineate work area with bollards / cones'),
    H('Heat stress / high ambient temperature','Water available for drinking','Hats issued to workers','Regular breaks to be taken by workers')]},
  {id:'env',label:'Environment',hazards:[
    H('Contamination / leakage','Ensure spill kits are available and stocked'),
    H('Dust','Sweep up'),
    H('Waste material','Establish a designated area for material to be dumped'),
    H('Noise / vibration','Notify sensitive receptors'),
    H('Discharges from site','Identify stormwater drains / inlets and isolate','Ensure spill kits are available and stocked'),
    H('Rubbish','Ensure bins are available on all job trucks')]},
  {id:'q',label:'Quality',hazards:[
    H('Conforming product','ITP’s in place and testing completed'),
    H('Approval to proceed','Customer sign off'),
    H('Measuring equipment','Calibrations current'),
    H('Product temperature','Measure temperatures with calibrated device')]}];
const CHECKS=[['swms','SWMS available'],['emergency','Emergency procedures available'],['prestarts','Plant prestarts completed'],['vest','Truck controller in alternate coloured vest']];
const HEAD=[['job_no','Job number'],['location','Job location'],['customer','Customer'],['date','Date'],['time','Time'],['foreman','Foreman'],['supervisor','Supervisor'],['client_rep','Client rep'],
  ['truck_controller','Truck controller'],['uhf','UHF channel'],['first_aid','First aid officers']];
const RISK=['Low','Medium','High','Extreme'];
const RISK_COL={Low:'hsl(145 55% 36%)',Medium:'hsl(38 90% 42%)',High:'hsl(20 85% 45%)',Extreme:'hsl(0 72% 47%)'};
const tickKey=(s,h,i)=>`${s}.${h.key}.${i}`;
const allTicks=()=>JSA_SECTIONS.flatMap(s=>s.hazards.flatMap(h=>h.controls.map((c,i)=>tickKey(s.id,h,i))));
const AGREE='We the signatories agree that we have been consulted with in the development and findings of this JSA / risk management form, have been communicated the information contained within it and agree to work to the control methods prescribed. Remember: if you do not understand or cannot complete the task safely, STOP WORK and refer the matter to your Supervisor or Manager for further direction.';

/* ---------- the shifts on a day, and what the pack starts with ---------- */
const entriesOn=(data,k)=>programEntries(data,k);
const jobOf=(data,b)=>data.jobs.find(j=>j.id===b.jobId);
const crewName=(data,id)=>(data.resources.find(r=>r.id===id)||{}).name||'Crew';
function prestartHint(data,b,k){const ids=b.plantIds||[];if(!ids.length)return null;const A=data.alerts||{};
  const done=ids.filter(id=>A[id]&&A[id].last_prestart_at&&iso(new Date(A[id].last_prestart_at))===k).length;return {done,of:ids.length}}
function newPack(data,e,myName){const b=e.b,j=jobOf(data,b)||{};const crew=data.resources.find(r=>r.id===e.crewId);
  return {id:newId(),block_id:b.id,shift_date:e.k,job_id:b.jobId||null,crew_id:e.crewId,status:'draft',toolbox:null,forms:{},
    jsa:{v:JSA_VERSION,type:isSealCrew(crew)?'seal':'asphalt',night:b.shift==='night',
      head:{job_no:j.projectNo||'',location:j.address||j.name||'',customer:j.customer||'',date:e.k,time:hhmm(),foreman:'',supervisor:myName||'',client_rep:'',truck_controller:'',uhf:'',first_aid:''},
      ticks:{},quality:{serial:''},extra:[],checks:{}}}}
/* another pack for the same shift: a copy of the latest one (not its signatures), as a new draft */
const packsFor=(packs,e)=>packs.filter(p=>p.block_id===e.b.id&&p.shift_date===e.k).sort((a,b)=>String(a.created_at||'9').localeCompare(String(b.created_at||'9')));
const packName=(p,list)=>p.label||(list.length>1?`Pack ${list.indexOf(p)+1}`:'QA pack');
function copyPack(prev,n){const c=JSON.parse(JSON.stringify({jsa:prev.jsa||{},toolbox:prev.toolbox||null,forms:prev.forms||{}}));c.jsa.head={...(c.jsa.head||{}),time:hhmm()};
  return {id:newId(),block_id:prev.block_id,shift_date:prev.shift_date,job_id:prev.job_id,crew_id:prev.crew_id,status:'draft',label:`Pack ${n+1}`,jsa:c.jsa,toolbox:c.toolbox,forms:c.forms}}
const newToolbox=(pack,myName)=>({location:(pack.jsa.head||{}).location||'',whs_rep:'',supervisor:myName||'',manager:'',topics:[{topic:'',action:'',date:'',who:''}],training:'',meeting_point:''});

/* ---------- waiting on this phone until there's reception ---------- */
const OB=u=>'qa-outbox:'+u;
const obRead=async u=>(await ffStore.get(OB(u)))||[];
async function obPush(u,op){let l=await obRead(u);op={...op,qid:newId()};
  if(op.t==='delpack'){l=l.filter(x=>!((x.t==='pack'&&x.row.id===op.id)||(x.t==='sig'&&x.row.pack_id===op.id)))}
  const i=op.t==='pack'?l.findIndex(x=>x.t==='pack'&&x.row.id===op.row.id):-1;if(i>=0)l[i]=op;else l.push(op);await ffStore.set(OB(u),l)}
let flushing=null;
function obFlush(sb,u){if(flushing)return flushing;
  flushing=(async()=>{const errs=[];let sent=0;
    for(let guard=0;guard<200;guard++){const l=await obRead(u);if(!l.length)break;const op=l[0];let error=null;
      try{if(op.t==='pack')({error}=await sb.from('qa_packs').upsert(op.row));
        else if(op.t==='sig')({error}=await sb.from('qa_signatures').insert(op.row));
        else if(op.t==='unsig')({error}=await sb.from('qa_signatures').delete().eq('id',op.id));
        else if(op.t==='delpack')({error}=await sb.from('qa_packs').delete().eq('id',op.id))}
      catch(e){error=e}
      if(error&&window.isNetErr&&window.isNetErr(error))break;   /* still no reception: try again later */
      if(error&&!(op.t==='sig'&&String(error.code)==='23505'))errs.push(errMsg(error));else sent++;
      await ffStore.set(OB(u),(await obRead(u)).filter(x=>x.qid!==op.qid))}
    return {sent,errs}})().finally(()=>{flushing=null;window.dispatchEvent(new CustomEvent('ff-qa-sent'))});
  return flushing}

/* packs and signatures for some days (or one booking), live, with what's waiting on this phone laid over the top */
function useQa(sb,me,filter,deps){
  const [srv,setSrv]=useState(null);const [ob,setOb]=useState([]);const [err,setErr]=useState('');const ck='qa-cache:'+JSON.stringify(filter);
  const load=async()=>{try{let q=sb.from('qa_packs').select('*');if(filter.date)q=q.eq('shift_date',filter.date);if(filter.block)q=q.eq('block_id',filter.block);
      const {data:packs,error}=await q;if(error)throw error;const ids=(packs||[]).map(p=>p.id);
      let sigs=[];if(ids.length){const r=await sb.from('qa_signatures').select('*').in('pack_id',ids);if(r.error)throw r.error;sigs=r.data||[]}
      const v={packs:packs||[],sigs};setSrv(v);setErr('');ffStore.set(ck,v)}
    catch(e){const saved=await ffStore.get(ck);if(saved)setSrv(s=>s||saved);else setErr(errMsg(e))}};
  const refreshOb=()=>obRead(me).then(setOb);
  useEffect(()=>{load();refreshOb();const go=()=>obFlush(sb,me);go();
    const sent=async()=>{await load();refreshOb()};   /* the server's copy first, then drop what was sent: never a moment showing the older copy */window.addEventListener('ff-qa-sent',sent);window.addEventListener('online',go);const iv=setInterval(()=>{if(navigator.onLine)go()},30000);
    let t=null,ch=null;try{ch=sb.channel('qa-'+newId());['qa_packs','qa_signatures'].forEach(tb=>ch.on('postgres_changes',{event:'*',schema:'public',table:tb},()=>{clearTimeout(t);t=setTimeout(load,400)}));ch.subscribe()}catch(e){}
    return()=>{window.removeEventListener('ff-qa-sent',sent);window.removeEventListener('online',go);clearInterval(iv);clearTimeout(t);try{if(ch)sb.removeChannel(ch)}catch(e){}}},deps);
  const view=useMemo(()=>{if(!srv)return null;const packs=new Map(srv.packs.map(p=>[p.id,p]));let sigs=[...srv.sigs];
    ob.forEach(op=>{if(op.t==='pack')packs.set(op.row.id,{...(packs.get(op.row.id)||{}),...op.row,pending:true});
      else if(op.t==='sig'){if(!sigs.some(s=>s.id===op.row.id))sigs.push({...op.row,pending:true})}else if(op.t==='unsig')sigs=sigs.filter(s=>s.id!==op.id);
      else if(op.t==='delpack'){packs.delete(op.id);sigs=sigs.filter(s=>s.pack_id!==op.id)}});
    return {packs:[...packs.values()],sigs,waiting:ob.length}},[srv,ob]);
  const save=async op=>{await obPush(me,op);await refreshOb();obFlush(sb,me)};
  return {v:view,err,reload:load,save}}

/* ---------- a drawn signature ---------- */
function SignPad({padRef,onInk}){
  const cv=useRef(null);const strokes=useRef([]);const cur=useRef(null);
  const paint=()=>{const c=cv.current;if(!c)return;const r=c.getBoundingClientRect();const dpr=Math.min(2,window.devicePixelRatio||1);
    if(c.width!==Math.round(r.width*dpr)||c.height!==Math.round(r.height*dpr)){c.width=Math.round(r.width*dpr);c.height=Math.round(r.height*dpr)}
    const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,r.width,r.height);g.lineWidth=2.4;g.lineCap='round';g.lineJoin='round';g.strokeStyle='#111';
    strokes.current.forEach(s=>{g.beginPath();s.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));if(s.length===1)g.lineTo(s[0][0]+.1,s[0][1]+.1);g.stroke()})};
  useEffect(paint);
  padRef.current={empty:()=>!strokes.current.some(s=>s.length),clear:()=>{strokes.current=[];paint();onInk(false)},
    png:()=>{const c=cv.current;const w=Math.min(600,c.width),h=Math.round(c.height*w/c.width);const out=document.createElement('canvas');out.width=w;out.height=h;
      const g=out.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,w,h);g.drawImage(c,0,0,w,h);return out.toDataURL('image/png')}};
  const pt=e=>{const r=cv.current.getBoundingClientRect();return [Math.round((e.clientX-r.left)*10)/10,Math.round((e.clientY-r.top)*10)/10]};
  const down=e=>{e.preventDefault();try{cv.current.setPointerCapture(e.pointerId)}catch(x){}cur.current=[pt(e)];strokes.current.push(cur.current);paint()};
  const move=e=>{if(!cur.current)return;e.preventDefault();cur.current.push(pt(e));paint()};
  const up=()=>{if(!cur.current)return;cur.current=null;onInk(true)};
  return html`<canvas id="qa-pad" ref=${cv} class="w-full rounded-lg border border-line block" style=${{height:170,background:'#fff',touchAction:'none',cursor:'crosshair'}}
    aria-label="Sign here" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onPointerLeave=${up}></canvas>`;
}
function SignDialog({title,mine,myName,onSave,onClose,sub,note,company=''}){
  const pad=useRef(null);const [ink,setInk]=useState(false);const [f,setF]=useState({name:'',company});const [err,setErr]=useState('');
  const save=()=>{if(!mine&&!f.name.trim()){setErr('Enter their name.');return}if(!pad.current||pad.current.empty()){setErr('Sign in the box.');return}
    onSave({name:mine?myName:f.name.trim(),company:mine?AFA:(f.company.trim()||AFA),signature:pad.current.png()})};
  return html`<${Modal} title=${title} sub=${mine?`Signing as ${myName} · ${AFA}`:(sub||'A visitor or subbie signs here, on your phone')} onClose=${onClose}
    foot=${html`${err&&html`<span id="qa-sign-err" class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="qa-sign-save" type="button" class="btn btn-primary" onClick=${save}>Sign</button>`}>
    <div class="grid gap-3">
      ${!mine&&html`<div class="grid sm:grid-cols-2 gap-3"><${Fld} label="Name"><input id="qa-v-name" class="field" style=${fs} value=${f.name} onInput=${e=>setF({...f,name:e.target.value})}/><//>
        <${Fld} label="Company"><input id="qa-v-company" class="field" style=${fs} placeholder=${AFA} value=${f.company} onInput=${e=>setF({...f,company:e.target.value})}/><//></div>`}
      ${note!==null&&html`<p class="text-[12px] text-muted">${note||AGREE}</p>`}
      <div class="grid gap-1"><div class="flex items-center"><span class="label flex-1">Sign here</span>${ink&&html`<button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>pad.current.clear()}>Clear</button>`}</div>
        <${SignPad} padRef=${pad} onInk=${setInk}/></div>
    </div><//>`;
}

/* ---------- small pieces of the form ---------- */
const Tick=({on,label,onChange,disabled,id})=>html`<button type="button" id=${id} class="qa-tick w-full flex items-start gap-2.5 text-left rounded-lg px-2.5 py-2 border" disabled=${disabled}
  style=${{borderColor:on?'hsl(145 50% 40%)':'var(--line)',background:on?'hsl(145 50% var(--blk-l))':'var(--surface)',cursor:disabled?'default':'pointer'}} aria-pressed=${!!on} onClick=${()=>onChange(!on)}>
  <span class="w-5 h-5 shrink-0 rounded-[5px] inline-flex items-center justify-center mt-px" style=${{background:on?'hsl(145 55% 36%)':'transparent',boxShadow:on?'none':'inset 0 0 0 1.5px var(--line-strong)',color:'#fff'}}>${on&&html`<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`}</span>
  <span class="text-[13.5px] leading-snug">${label}</span></button>`;
function Card({title,sub,id,children,open:o0=true,right}){const [o,setO]=useState(o0);
  return html`<section class="panel" id=${id}><button type="button" class="w-full flex items-center gap-2 px-4 py-3 text-left" onClick=${()=>setO(!o)} aria-expanded=${o}>
      <span class="min-w-0 flex-1"><span class="block font-display text-[15.5px] font-semibold">${title}</span>${sub&&html`<span class="block text-[12px] text-muted">${sub}</span>`}</span>${right}
      <span class="text-muted inline-flex transition-transform" style=${{transform:o?'rotate(0deg)':'rotate(-90deg)'}}>${Icon.chevD}</span></button>
    ${o&&html`<div class="px-4 pb-4 grid grid-cols-[minmax(0,1fr)] gap-3">${children}</div>`}</section>`}
const statusOf=(p,sigs)=>!p?['Not started','var(--muted)']:p.status==='submitted'?['Submitted','hsl(145 55% 36%)']:[`In progress · ${sigs.filter(s=>s.pack_id===p.id&&s.form==='jsa').length} signed`,'hsl(38 90% 40%)'];
const chip=([t,c])=>html`<span class="inline-flex items-center text-[11.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap qa-status" style=${{color:c,background:'var(--sunken)',boxShadow:`inset 0 0 0 1px ${c}`}}>${t}</span>`;

/* ---------- signatures for one form ---------- */
function SignOff({form,pack,sigs,ctx,canEdit,open,me:allowMe=true,other='Visitor / subbie signs',max=0,empty='Nobody has signed yet.'}){
  const {me,myName,canFill,save}=ctx;const list=sigs.filter(s=>s.pack_id===pack.id&&s.form===form).sort((a,b)=>String(a.signed_at).localeCompare(String(b.signed_at)));
  const mine=list.find(s=>s.user_id===me);const live=pack.status==='draft';
  return html`<div class="grid grid-cols-[minmax(0,1fr)] gap-2" id=${'qa-signoff-'+form}>
    ${list.length===0?html`<div class="text-[12.5px] text-muted">${empty}</div>`
      :html`<div class="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">${list.map(s=>html`<div key=${s.id} class="rounded-lg border border-line p-2 flex items-center gap-3 qa-sig">
        <img src=${s.signature} alt=${'Signature of '+s.name} class="h-12 w-28 object-contain rounded bg-white border border-line shrink-0"/>
        <div class="min-w-0 flex-1"><div class="text-[13px] font-medium truncate">${s.name}${s.pending?html` <span class="text-[11px] font-normal" style=${{color:'hsl(38 90% 40%)'}}>· waiting to send</span>`:''}</div>
          <div class="text-[11.5px] text-muted truncate">${s.company||AFA} · ${fmtDT(s.signed_at)}</div></div>
        ${live&&(s.user_id===me||(canFill&&!s.user_id))&&html`<button type="button" class="text-[12px] text-muted hover:text-ink qa-unsign" onClick=${()=>save({t:'unsig',id:s.id})}>Remove</button>`}</div>`)}</div>`}
    ${live&&!(max&&list.length>=max)&&html`<div class="flex flex-wrap gap-2">
      ${allowMe&&!mine&&html`<button type="button" class="btn btn-primary qa-sign-me" style=${{height:40}} onClick=${()=>open({k:'sign',form,mine:true})}>Sign as ${myName}</button>`}
      ${canEdit&&other&&html`<button type="button" class="btn qa-sign-visitor" style=${{height:40}} onClick=${()=>open({k:'sign',form,mine:false,label:other})}>${Icon.plus} ${other}</button>`}</div>`}
  </div>`;
}

/* ---------- one pack: the JSA, and the toolbox meeting if there is one ---------- */
function PackView({ctx,data,e,pack,sigs,onBack,inModal}){
  const {canFill,save,myName,isManager}=ctx;
  const [p,setP]=useState(pack);const tm=useRef(null);const [dlg,setDlg]=useState(null);const [busy,setBusy]=useState(false);const [msg,setMsg]=useState('');
  useEffect(()=>{if(!tm.current)setP(pack)},[pack]);   /* someone else's change arrives (not while we're typing) */
  const canEdit=canFill&&p.status==='draft';
  const upd=fn=>setP(x=>{const n=fn(x);clearTimeout(tm.current);tm.current=setTimeout(()=>{tm.current=null;save({t:'pack',row:rowOf(n)})},600);return n});
  const rowOf=x=>({id:x.id,block_id:x.block_id,shift_date:x.shift_date,job_id:x.job_id,crew_id:x.crew_id,status:x.status,label:x.label||null,jsa:x.jsa,toolbox:x.toolbox,forms:x.forms||{}});
  const J=p.jsa||{};const setJ=f=>upd(x=>({...x,jsa:{...x.jsa,...f(x.jsa)}}));
  const ticks=J.ticks||{};const nT=allTicks().filter(k=>ticks[k]).length;
  const hint=prestartHint(data,e.b,e.k);
  const jsaSigs=sigs.filter(s=>s.pack_id===p.id&&s.form==='jsa');
  const submit=()=>{if(missAll.length){setShowMiss(true);setMsg('');try{const el=document.getElementById('qa-pack');const sc=el&&el.closest('.overflow-y-auto');if(sc)sc.scrollTop=0}catch(x){}return}
    clearTimeout(tm.current);tm.current=null;const n={...p,status:'submitted'};setP(n);save({t:'pack',row:rowOf(n)});setMsg('')};
  const reopen=()=>{const n={...p,status:'draft'};setP(n);save({t:'pack',row:rowOf(n)})};
  const [del,setDel]=useState(false);
  const remove=()=>{clearTimeout(tm.current);tm.current=null;save({t:'delpack',id:p.id});ctx.notify&&ctx.notify('QA pack deleted');onBack&&onBack()};
  const pdf=async()=>{setBusy(true);try{await packPdf(data,e,p,sigs)}catch(x){setMsg(errMsg(x))}finally{setBusy(false)}};
  const T=p.toolbox;const setT=f=>upd(x=>({...x,toolbox:{...x.toolbox,...f(x.toolbox)}}));
  const FF=window.FFQF;const forms=p.forms||{};
  const fctx={data,e,pack:p,sigs,ctx,canEdit,open:setDlg,set:(id,f)=>upd(x=>({...x,forms:{...(x.forms||{}),[id]:typeof f==='function'?f((x.forms||{})[id]):f}})),
    add:id=>upd(x=>{const fs0=x.forms||{};const lot=fs0.lot||FF.newLot(data,e,x);return {...x,forms:{...fs0,lot,[id]:FF.byId[id].make(data,e,x,ctx)}}}),
    remove:id=>{upd(x=>{const n={...(x.forms||{})};delete n[id];return {...x,forms:n}});setSec('jsa')}};
  const head=J.head||{};
  /* the forms in the pack: the JSA, lot details and the required forms; laying record and toolbox when added */
  const [sec,setSec]=useState('jsa');const [showMiss,setShowMiss]=useState(false);
  const go=id=>{setSec(id);try{const el=document.getElementById('qa-pack');const sc=el&&el.closest('.overflow-y-auto');if(sc)sc.scrollTop=0}catch(x){}};
  const optOn=id=>id==='toolbox'?!!T:!!forms[id];
  const tabs=[{id:'jsa',label:'JSA'},...(FF&&canFill?[{id:'lot',label:'Lot details'},...FF.FORMS.filter(f=>f.required).map(f=>({id:f.id,label:f.short})),...FF.FORMS.filter(f=>!f.required).map(f=>({id:f.id,label:f.short,opt:true,on:optOn(f.id)}))]:[]),
    ...(canFill||T?[{id:'toolbox',label:'Toolbox meeting',opt:true,on:!!T}]:[])].filter(t=>!(t.opt&&!t.on&&!canEdit));
  const order=tabs.filter(t=>!t.opt||t.on);
  const o={p,sigs};
  const jsaMiss=()=>{const need=[['job_no','Job number'],['location','Job location'],['customer','Customer'],['date','Date'],['time','Time'],['foreman','Foreman'],['supervisor','Supervisor']].filter(([k])=>!String(head[k]||'').trim()).map(([,l])=>l);
    const ex=(J.extra||[]).filter(x=>String(x.hazard||'').trim()&&(!x.risk||!String(x.controls||'').trim()||!x.residual)).length;
    return [...need,...(nT?[]:['Tick the control measures in place']),...(ex?[`${ex} added hazard${ex===1?'':'s'} missing a risk rating, controls or residual risk`]:[]),...(jsaSigs.length?[]:['At least one signature'])]};
  const tbMiss=()=>T?[...(!(T.topics||[]).some(x=>String(x.topic||'').trim())?['At least one topic discussed']:[]),...(String(T.meeting_point||'').trim()?[]:['Emergency meeting point']),...(sigs.some(s=>s.pack_id===p.id&&s.form==='toolbox')?[]:['Attendees’ signatures'])]:[];
  const missOf=id=>id==='jsa'?jsaMiss():id==='toolbox'?tbMiss():id==='lot'?(FF?FF.lotCheck(o):[]):FF&&FF.byId[id]?(forms[id]?FF.byId[id].check(forms[id],o):(FF.byId[id].required?['Not started']:[])):[];
  const missAll=order.map(t=>({id:t.id,label:t.label,items:missOf(t.id)})).filter(g=>g.items.length);
  const addOpt=id=>{if(id==='toolbox')upd(x=>({...x,toolbox:x.toolbox||newToolbox(x,myName)}));else fctx.add(id);go(id)};
  /* a pack started before the forms were required gets them now */
  useEffect(()=>{if(!canEdit||!FF)return;const need=FF.FORMS.filter(f=>f.required&&!(p.forms||{})[f.id]);if(!need.length&&(p.forms||{}).lot)return;
    upd(x=>{const fs0={...(x.forms||{})};if(!fs0.lot)fs0.lot=FF.newLot(data,e,x);need.forEach(f=>{if(!fs0[f.id])fs0[f.id]=f.make(data,e,x,ctx)});return {...x,forms:fs0}})},[p.id,canEdit]);
  const body=html`<div class="grid grid-cols-[minmax(0,1fr)] gap-3 pb-4" id="qa-pack">
    <div class="panel px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      ${!inModal&&html`<button type="button" class="btn px-2" onClick=${onBack} aria-label="Back">${Icon.chevL}</button>`}
      <div class="min-w-0 flex-1"><div class="font-display text-[17px] font-semibold leading-tight truncate">${jobLabel(jobOf(data,e.b))}</div>
        <div class="text-[12.5px] text-muted">${crewName(data,e.crewId)} · ${WD[parse(e.k).getDay()]} ${fmtShort(parse(e.k))}${e.b.shift==='night'?' · night':''}</div></div>
      ${chip(statusOf(p,sigs))}${p.pending&&html`<span class="text-[11.5px]" style=${{color:'hsl(38 90% 40%)'}}>Waiting to send</span>`}
      ${(canEdit||p.label)&&html`<div class="w-full flex items-center gap-2 pt-1"><span class="label shrink-0">Pack name</span>${canEdit?html`<input id="qa-label" class="field" style=${{...fs,maxWidth:320}} placeholder="e.g. Second work area (optional)" value=${p.label||''} onInput=${ev=>upd(x=>({...x,label:ev.target.value}))}/>`:html`<span class="text-[13px] font-medium">${p.label}</span>`}</div>`}
    </div>
    ${p.status==='submitted'&&html`<div class="rounded-lg px-3 py-2 text-[12.5px]" style=${{background:'hsl(145 50% var(--blk-l))'}}>Submitted${p.submitted_name?' by '+p.submitted_name:''}${p.submitted_at?' · '+fmtDT(p.submitted_at):''}. It can’t be changed${isManager?' unless you reopen it':''}.</div>`}
    ${!canFill&&p.status==='draft'&&html`<div class="rounded-lg px-3 py-2 text-[12.5px]" style=${{background:'var(--accent-soft)'}}>Read through the JSA, then sign at the bottom.</div>`}
    <nav class="panel px-2 py-2 flex gap-1.5 overflow-x-auto sticky top-0" style=${{zIndex:6}} id="qa-tabs" aria-label="Forms in this pack">
      ${tabs.map(t=>{const on=t.id===sec;const add=t.opt&&!t.on;const mi=add?[]:missOf(t.id);const ok=!add&&!mi.length;
        return html`<button key=${t.id} type="button" id=${'qa-tab-'+t.id} class=${'shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 h-9 text-[12.5px] font-medium whitespace-nowrap border'+(add?' border-dashed':'')}
          style=${{background:on?'var(--accent-soft)':'var(--surface)',borderColor:on?'var(--accent)':'var(--line)',color:add?'var(--muted)':'var(--ink)'}} aria-current=${on?'step':undefined}
          onClick=${()=>add?addOpt(t.id):go(t.id)} title=${add?'Optional: add it if you need it':mi.length?'Still needed: '+mi.join(', '):'Complete'}>
          ${add?Icon.plus:ok?html`<span class="w-4 h-4 rounded-full inline-flex items-center justify-center qa-tab-ok" style=${{background:'hsl(145 55% 36%)',color:'#fff'}}><svg width="9" height="9" viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
            :html`<span class="min-w-[16px] h-4 px-1 rounded-full inline-flex items-center justify-center text-[10px] font-bold qa-tab-n" style=${{background:'hsl(38 90% 48%)',color:'#fff'}}>${mi.length}</span>`}
          ${t.label}${t.opt?html`<span class="text-[10.5px] text-faint">${add?'optional':''}</span>`:''}</button>`})}
    </nav>
    ${showMiss&&missAll.length>0&&html`<section class="panel px-4 py-3 grid gap-2" id="qa-missing" style=${{boxShadow:'inset 0 0 0 1.5px hsl(38 90% 45%)'}}>
      <div class="font-display text-[15px] font-semibold">Before this pack can be submitted</div>
      ${missAll.map(g=>html`<div key=${g.id} class="grid gap-0.5"><button type="button" class="text-left text-[13px] font-semibold hover:underline qa-miss-go" style=${{color:'var(--accent)'}} onClick=${()=>go(g.id)}>${g.label} ›</button>
        <ul class="text-[12.5px] text-muted pl-4 list-disc">${g.items.map((x,i)=>html`<li key=${i}>${x}</li>`)}</ul></div>`)}
    </section>`}

    ${sec==='jsa'&&html`<${Card} title="Job specific assessment (JSA)" sub=${`Version ${J.v||JSA_VERSION} · ${J.type==='seal'?'Spray seal':'Asphalt'}`} id="qa-head">
      <fieldset disabled=${!canEdit} class="m-0 p-0 border-0 min-w-0 grid gap-3">
        <div class="seg w-max"><button type="button" aria-pressed=${J.type!=='seal'} onClick=${()=>setJ(()=>({type:'asphalt'}))}>Asphalt</button><button type="button" aria-pressed=${J.type==='seal'} onClick=${()=>setJ(()=>({type:'seal'}))}>Spray seal</button></div>
        <div class="grid grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-4 gap-3">${HEAD.map(([k,l])=>html`<${Fld} key=${k} label=${l}><input id=${'qa-h-'+k} class="field" style=${fs} type=${k==='date'?'date':k==='time'?'time':'text'} value=${head[k]||''} onInput=${ev=>setJ(j=>({head:{...j.head,[k]:ev.target.value}}))}/><//>`)}</div>
      </fieldset><//>

    ${JSA_SECTIONS.map(s=>{const keys=s.hazards.flatMap(h=>h.controls.map((c,i)=>tickKey(s.id,h,i)));const n=keys.filter(k=>ticks[k]).length;
      return html`<${Card} key=${s.id} id=${'qa-sec-'+s.id} title=${s.label} sub=${`${n} of ${keys.length} controls in place · tick each control actually implemented`}>
        <div class="grid gap-3 md:grid-cols-2">${s.hazards.map(h=>html`<div key=${h.key} class="grid gap-1.5 content-start">
          <div class="text-[12.5px] font-semibold">${h.hazard}</div>
          ${h.controls.map((c,i)=>{const k=tickKey(s.id,h,i);return html`<${Tick} key=${k} id=${'qa-t-'+k.replace(/\./g,'-')} label=${c} on=${!!ticks[k]} disabled=${!canEdit} onChange=${v=>setJ(j=>({ticks:{...j.ticks,[k]:v}}))}/>`})}
          ${s.id==='q'&&h.key==='product-temperature'&&html`<input id="qa-serial" class="field" style=${fs} placeholder="Device serial number" value=${(J.quality||{}).serial||''} disabled=${!canEdit} onInput=${ev=>setJ(j=>({quality:{...j.quality,serial:ev.target.value}}))}/>`}
        </div>`)}</div><//>`})}

    <${Card} title="Additional hazards & controls" id="qa-extra" sub="Site, work location, task or process specific hazards, and controls you couldn’t put in place from the list">
      ${(J.extra||[]).length===0&&html`<div class="text-[12.5px] text-muted">None added.</div>`}
      ${(J.extra||[]).map((x,i)=>html`<div key=${i} class="rounded-lg border border-line p-3 grid gap-2 qa-extra-row">
        <fieldset disabled=${!canEdit} class="m-0 p-0 border-0 min-w-0 grid gap-2 sm:grid-cols-2">
          <${Fld} label=${`Hazard ${i+1}`}><textarea class="field qa-x-hazard" rows="2" style=${{height:'auto',padding:'6px 10px',fontSize:13}} value=${x.hazard} onInput=${ev=>setJ(j=>({extra:j.extra.map((y,k)=>k===i?{...y,hazard:ev.target.value}:y)}))}></textarea><//>
          <${Fld} label="Additional controls implemented"><textarea class="field qa-x-controls" rows="2" style=${{height:'auto',padding:'6px 10px',fontSize:13}} value=${x.controls} onInput=${ev=>setJ(j=>({extra:j.extra.map((y,k)=>k===i?{...y,controls:ev.target.value}:y)}))}></textarea><//>
          <${Fld} label="Risk rating"><select class="field qa-x-risk" style=${{...fs,color:RISK_COL[x.risk]||''}} value=${x.risk} onChange=${ev=>setJ(j=>({extra:j.extra.map((y,k)=>k===i?{...y,risk:ev.target.value}:y)}))}><option value="">Choose…</option>${RISK.map(r=>html`<option key=${r} value=${r}>${r}</option>`)}</select><//>
          <${Fld} label="Residual risk"><select class="field qa-x-residual" style=${{...fs,color:RISK_COL[x.residual]||''}} value=${x.residual} onChange=${ev=>setJ(j=>({extra:j.extra.map((y,k)=>k===i?{...y,residual:ev.target.value}:y)}))}><option value="">Choose…</option>${RISK.map(r=>html`<option key=${r} value=${r}>${r}</option>`)}</select><//>
        </fieldset>
        ${canEdit&&html`<div><button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>setJ(j=>({extra:j.extra.filter((y,k)=>k!==i)}))}>Remove this hazard</button></div>`}</div>`)}
      ${canEdit&&html`<div><button id="qa-add-hazard" type="button" class="btn" onClick=${()=>setJ(j=>({extra:[...(j.extra||[]),{hazard:'',risk:'',controls:'',residual:''}]}))}>${Icon.plus} Add hazard</button></div>`}<//>

    <${Card} title="Checklists" id="qa-checks">
      <div class="grid gap-1.5 sm:grid-cols-2">${CHECKS.map(([k,l])=>html`<div key=${k}><${Tick} id=${'qa-c-'+k} label=${l} on=${!!(J.checks||{})[k]} disabled=${!canEdit} onChange=${v=>setJ(j=>({checks:{...j.checks,[k]:v}}))}/>
        ${k==='prestarts'&&hint&&html`<div class="text-[11.5px] mt-0.5 ml-1" id="qa-ps-hint" style=${{color:hint.done===hint.of?'hsl(145 55% 32%)':'hsl(30 90% 38%)'}}>${hint.done} of ${hint.of} machine${hint.of===1?'':'s'} on this job ${hint.of===1?'has':'have'} done a prestart today</div>`}</div>`)}</div>
      <//>

    <${Card} title="Sign-off" id="qa-sign" sub=${`${jsaSigs.length} signed`}>
      <p class="text-[12px] text-muted">${AGREE}</p>
      <${SignOff} form="jsa" pack=${p} sigs=${sigs} ctx=${ctx} canEdit=${canEdit} open=${setDlg}/><//>`}

    ${FF&&sec==='lot'&&html`<${FF.LotCard} f=${fctx}/>`}
    ${FF&&FF.byId[sec]&&forms[sec]&&(Ed=>html`<${Ed} key=${sec} f=${fctx}/>`)(FF.byId[sec].Editor)}

    ${sec==='toolbox'&&html`${T?html`<${Card} title="Toolbox meeting" id="qa-toolbox" sub=${`${sigs.filter(s=>s.pack_id===p.id&&s.form==='toolbox').length} attended`}>
        <fieldset disabled=${!canEdit} class="m-0 p-0 border-0 min-w-0 grid gap-3">
          <div class="grid grid-cols-2 gap-3">${[['location','Location'],['whs_rep','WHS&E rep'],['supervisor','Supervisor'],['manager','Manager']].map(([k,l])=>html`<${Fld} key=${k} label=${l}><input id=${'qa-tb-'+k} class="field" style=${fs} value=${T[k]||''} onInput=${ev=>setT(()=>({[k]:ev.target.value}))}/><//>`)}</div>
          <div class="label">Topics discussed</div>
          ${(T.topics||[]).map((x,i)=>html`<div key=${i} class="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_1fr_auto] items-end qa-topic">
            <${Fld} label="Topic"><input class="field qa-tb-topic" style=${fs} value=${x.topic} onInput=${ev=>setT(t=>({topics:t.topics.map((y,k)=>k===i?{...y,topic:ev.target.value}:y)}))}/><//>
            <${Fld} label="Action"><input class="field" style=${fs} value=${x.action} onInput=${ev=>setT(t=>({topics:t.topics.map((y,k)=>k===i?{...y,action:ev.target.value}:y)}))}/><//>
            <${Fld} label="Date"><input type="date" class="field" style=${fs} value=${x.date} onInput=${ev=>setT(t=>({topics:t.topics.map((y,k)=>k===i?{...y,date:ev.target.value}:y)}))}/><//>
            <${Fld} label="Who"><input class="field" style=${fs} value=${x.who} onInput=${ev=>setT(t=>({topics:t.topics.map((y,k)=>k===i?{...y,who:ev.target.value}:y)}))}/><//>
            ${canEdit&&html`<button type="button" class="btn btn-ghost px-2" style=${{height:32}} aria-label="Remove topic" onClick=${()=>setT(t=>({topics:t.topics.filter((y,k)=>k!==i)}))}>${Icon.x}</button>`}</div>`)}
          ${canEdit&&html`<div><button id="qa-tb-add-topic" type="button" class="btn" onClick=${()=>setT(t=>({topics:[...(t.topics||[]),{topic:'',action:'',date:'',who:''}]}))}>${Icon.plus} Add topic</button></div>`}
          <div class="grid sm:grid-cols-2 gap-3"><${Fld} label="Training covered"><input id="qa-tb-training" class="field" style=${fs} value=${T.training||''} onInput=${ev=>setT(()=>({training:ev.target.value}))}/><//>
            <${Fld} label="Emergency meeting point"><input id="qa-tb-meeting" class="field" style=${fs} value=${T.meeting_point||''} onInput=${ev=>setT(()=>({meeting_point:ev.target.value}))}/><//></div>
        </fieldset>
        <div class="label">Attendees</div>
        <${SignOff} form="toolbox" pack=${p} sigs=${sigs} ctx=${ctx} canEdit=${canEdit} open=${setDlg}/>
        ${canEdit&&!sigs.some(s=>s.pack_id===p.id&&s.form==='toolbox')&&html`<div><button id="qa-tb-remove" type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>{upd(x=>({...x,toolbox:null}));setSec('jsa')}}>Remove the toolbox meeting</button></div>`}<//>`
      :canEdit&&html`<button id="qa-add-toolbox" type="button" class="panel px-4 py-3 text-left flex items-center gap-2 hover:bg-sunken" onClick=${()=>upd(x=>({...x,toolbox:newToolbox(x,myName)}))}>${Icon.plus}<span><span class="block font-display text-[15px] font-semibold">Add a toolbox meeting</span><span class="block text-[12px] text-muted">Only when you hold one</span></span></button>`}`}

    ${(()=>{const i=order.findIndex(t=>t.id===sec);const nx=order[i+1];return nx&&html`<div class="flex justify-end"><button id="qa-next" type="button" class="btn" onClick=${()=>go(nx.id)}>Next: ${nx.label} ${Icon.chevR}</button></div>`})()}
    <div class="panel px-4 py-3 flex flex-wrap items-center gap-2 sticky bottom-0" style=${{zIndex:5}}>
      ${msg&&html`<span id="qa-msg" class="text-[12.5px] w-full" style=${{color:'var(--bad)'}}>${msg}</span>`}
      <button id="qa-pdf" type="button" class="btn" disabled=${busy} onClick=${pdf}>${Icon.download} ${busy?'Making PDF…':'PDF'}</button>
      <span class="text-[12px] text-muted flex-1" id="qa-progress">${order.length-missAll.length} of ${order.length} form${order.length===1?'':'s'} complete</span>
      ${canEdit&&!del&&html`<button id="qa-delete" type="button" class="btn" style=${{color:'var(--bad)'}} onClick=${()=>setDel(true)}>${Icon.trash} Delete</button>`}
      ${canEdit&&del&&html`<span id="qa-del-confirm" class="w-full flex flex-wrap items-center gap-2"><span class="text-[12.5px] font-medium flex-1" style=${{color:'var(--bad)'}}>Delete this pack${jsaSigs.length?` and its ${sigs.filter(s=>s.pack_id===p.id).length} signature${sigs.filter(s=>s.pack_id===p.id).length===1?'':'s'}`:''}? This can’t be undone.</span>
        <button type="button" class="btn" onClick=${()=>setDel(false)}>Cancel</button><button id="qa-del-go" type="button" class="btn" style=${{background:'var(--bad)',color:'#fff',borderColor:'var(--bad)'}} onClick=${remove}>Yes, delete</button></span>`}
      ${canEdit&&!del&&html`<button id="qa-submit" type="button" class="btn btn-primary" onClick=${submit}>Submit pack</button>`}
      ${isManager&&p.status==='submitted'&&html`<button id="qa-reopen" type="button" class="btn" onClick=${reopen}>Reopen</button>`}
    </div>
    ${dlg&&dlg.k==='sign'&&html`<${SignDialog} key=${dlg.form+(dlg.mine?':me':':other')} title=${dlg.title||(dlg.form==='jsa'?'Sign the JSA':dlg.form==='toolbox'?'Sign the toolbox meeting':(FF&&FF.signTitle(dlg.form))||'Sign')} mine=${dlg.mine} myName=${myName}
      sub=${dlg.label&&dlg.form!=='jsa'&&dlg.form!=='toolbox'?dlg.label+', on your phone':null} note=${dlg.form==='jsa'||dlg.form==='toolbox'?'':((FF&&FF.signNote(dlg.form))||null)} company=${dlg.form&&/client/.test(dlg.form)?((forms.lot||{}).client||''):''}
      onClose=${()=>setDlg(null)} onSave=${s=>{save({t:'sig',row:{id:newId(),pack_id:p.id,form:dlg.form,user_id:dlg.mine?ctx.me:null,name:s.name,company:s.company,signature:s.signature,signed_at:new Date().toISOString()}});setDlg(null)}}/>`}
  </div>`;
  return body;
}

/* ---------- the QA screen: today's shifts, a pack for each ---------- */
function useMe(sb,me,data,email){
  const [prof,setProf]=useState(()=>{try{return JSON.parse(localStorage.getItem('ff:prof:'+me)||'null')}catch(e){return null}});
  useEffect(()=>{sb.from('profiles').select('*').eq('id',me).maybeSingle().then(({data:p})=>{if(p){setProf(p);try{localStorage.setItem('ff:prof:'+me,JSON.stringify(p))}catch(e){}}}).catch(()=>{})},[]);
  const staff=prof&&prof.staff_id?data.resources.find(r=>r.id===prof.staff_id):null;
  return {staff,name:staff?staff.name:showLogin(email||'')}}
function QaScreen({data,live,notify}){
  const sb=live.sb;const me=live.user.id;const role=roleKey(live.role);const canFill=FILL_ROLES.includes(role);
  const [day,setDay]=useState(()=>iso(TODAY));const [openId,setOpenId]=useState(null);
  const who=useMe(sb,me,data,live.user.email);
  const {v,err,save}=useQa(sb,me,{date:day},[day]);
  const ctx={sb,me,myName:who.name,canFill,isManager:role==='admin'||role==='superuser',save,notify};
  if(err&&!v)return html`<div class="panel p-6 grid gap-2 max-w-[640px]"><div class="font-display text-[17px] font-semibold">QA packs aren’t set up yet</div><p class="text-[13px] text-muted">An administrator needs to run <span class="mono">supabase/qa.sql</span> once in Supabase → SQL Editor.</p><p class="text-[12px] text-faint mono">${err}</p></div>`;
  if(!v)return html`<div class="panel p-6 text-[13px] text-muted">Loading…</div>`;
  const myCrew=who.staff&&who.staff.crewId;
  const list=entriesOn(data,day).sort((a,b)=>(b.crewId===myCrew)-(a.crewId===myCrew));
  const op=openId&&v.packs.find(p=>p.id===openId);const cur=op&&list.find(e=>e.b.id===op.block_id&&e.k===op.shift_date);
  if(op&&cur)return html`<div class="flex-1 min-h-0 overflow-y-auto pr-1" id="qa-scroll"><${PackView} key=${op.id} ctx=${ctx} data=${data} e=${cur} pack=${op} sigs=${v.sigs} onBack=${()=>setOpenId(null)}/></div>`;
  const start=e=>{const p=newPack(data,e,who.name);save({t:'pack',row:p});setOpenId(p.id)};
  const another=(e,ps)=>{const p=copyPack(ps[ps.length-1],ps.length);save({t:'pack',row:p});setOpenId(p.id)};
  return html`<div class="flex-1 min-h-0 overflow-y-auto pr-1 grid grid-cols-[minmax(0,1fr)] gap-3 content-start" id="qa-scroll">
    <div class="panel px-4 py-3 flex flex-wrap items-center gap-2">
      <button type="button" class="btn px-2" aria-label="Previous day" onClick=${()=>setDay(iso(addDays(parse(day),-1)))}>${Icon.chevL}</button>
      <input id="qa-day" type="date" class="field w-auto" style=${fs} value=${day} onChange=${ev=>ev.target.value&&setDay(ev.target.value)}/>
      <button type="button" class="btn px-2" aria-label="Next day" onClick=${()=>setDay(iso(addDays(parse(day),1)))}>${Icon.chevR}</button>
      <button type="button" class="btn" disabled=${day===iso(TODAY)} onClick=${()=>setDay(iso(TODAY))}>Today</button>
      <span class="flex-1"></span>${v.waiting>0&&html`<span id="qa-waiting" class="text-[12px] font-medium" style=${{color:'hsl(38 90% 40%)'}}>${v.waiting} change${v.waiting===1?'':'s'} waiting for reception</span>`}
      <span class="text-[12.5px] text-muted">Signed in as ${who.name}</span>
    </div>
    ${list.length===0&&html`<div class="panel p-6 text-[13.5px] text-muted text-center">No jobs on ${WD[parse(day).getDay()]} ${fmtShort(parse(day))}.</div>`}
    ${list.map(e=>{const ps=packsFor(v.packs,e);const j=jobOf(data,e.b);
      return html`<div key=${e.b.id+e.k} class="panel px-4 py-3 grid gap-2 qa-entry" data-crew=${crewName(data,e.crewId)}>
        <div class="flex flex-wrap items-center gap-3"><div class="min-w-0 flex-1"><div class="text-[14.5px] font-semibold truncate">${jobLabel(j)}</div>
          <div class="text-[12.5px] text-muted truncate">${crewName(data,e.crewId)}${e.crewId===myCrew?' (your crew)':''}${e.b.shift==='night'?' · night':''}${j&&j.address&&j.address!==j.name?' · '+j.address:''}</div></div>
          ${!ps.length&&chip(statusOf(null,v.sigs))}
          ${!ps.length&&(canFill?html`<button type="button" class="btn btn-primary qa-start" onClick=${()=>start(e)}>Start JSA</button>`:html`<span class="text-[12px] text-muted">Waiting for the supervisor to start the JSA</span>`)}</div>
        ${ps.map(p=>{const mineS=v.sigs.some(s=>s.pack_id===p.id&&s.form==='jsa'&&s.user_id===me);
          return html`<div key=${p.id} class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 qa-packrow" data-pack=${packName(p,ps)}>
            <span class="text-[13px] font-medium flex-1 min-w-[90px]">${packName(p,ps)}</span>${chip(statusOf(p,v.sigs))}${mineS&&html`<span class="text-[11.5px] font-medium" style=${{color:'hsl(145 55% 32%)'}}>You’ve signed</span>`}
            <button type="button" class=${'btn qa-open'+(!canFill&&!mineS&&p.status==='draft'?' btn-primary':'')} onClick=${()=>setOpenId(p.id)}>${canFill?(p.status==='draft'?'Continue':'Open'):(!mineS&&p.status==='draft'?'Read & sign':'Open')}</button></div>`})}
        ${ps.length>0&&canFill&&html`<div><button type="button" class="text-[12.5px] font-medium inline-flex items-center gap-1 qa-another" style=${{color:'var(--accent)'}} onClick=${()=>another(e,ps)}>${Icon.plus} Add another QA pack for this shift</button><span class="text-[11.5px] text-muted"> · copies the details from ${packName(ps[ps.length-1],ps)}, not the signatures</span></div>`}
      </div>`})}
  </div>`;
}

/* ---------- inside a booking: a pack per shift ---------- */
function QaBookingTab({data,block,live}){
  const sb=live.sb;const me=live.user.id;const role=roleKey(live.role);const canFill=FILL_ROLES.includes(role);
  const who=useMe(sb,me,data,live.user.email);
  const {v,err,save}=useQa(sb,me,{block:block.id},[block.id]);const [open,setOpen]=useState(null);
  if(err&&!v)return html`<div class="text-[13px] text-muted">QA packs aren’t set up yet: an administrator needs to run <span class="mono">supabase/qa.sql</span>. <span class="text-faint">${err}</span></div>`;
  if(!v)return html`<div class="text-[13px] text-muted">Loading…</div>`;
  const ctx={sb,me,myName:who.name,canFill,isManager:role==='admin'||role==='superuser',save};
  const days=shiftDates(block).map(k=>({b:block,k,crewId:coverOf(block,k)||block.resourceId}));
  const cp=open&&v.packs.find(p=>p.id===open);const cur=cp&&days.find(e=>e.k===cp.shift_date);
  return html`<div class="grid gap-2" id="qa-booking">
    <p class="text-[12.5px] text-muted">The site QA pack for each shift: the JSA and, when there is one, the toolbox meeting. Supervisors fill them in on their phone (QA in the left menu); the crew sign on theirs.</p>
    <div class="rounded-lg border border-line divide-y" style=${{borderColor:'var(--line)'}}>${days.map((e,i)=>{const ps=packsFor(v.packs,e);
      return html`<div key=${e.k} class="px-3 py-2.5 grid gap-1.5 qa-shift" style=${{borderColor:'var(--line)'}}>
        <div class="flex flex-wrap items-center gap-3"><div class="min-w-[150px] flex-1"><div class="text-[13.5px] font-semibold">Shift ${i+1} · ${WD[parse(e.k).getDay()]} ${fmtShort(parse(e.k))}</div><div class="text-[12px] text-muted">${crewName(data,e.crewId)}</div></div>
          ${!ps.length&&chip(statusOf(null,v.sigs))}
          ${!ps.length&&(canFill?html`<button type="button" class="btn qa-start" onClick=${()=>{const p=newPack(data,e,who.name);save({t:'pack',row:p});setOpen(p.id)}}>Start JSA</button>`:html`<span class="text-[12px] text-faint">Not started</span>`)}
          ${ps.length>0&&canFill&&html`<button type="button" class="btn qa-another" title="Copies the details from the latest pack, not the signatures" onClick=${()=>{const p=copyPack(ps[ps.length-1],ps.length);save({t:'pack',row:p});setOpen(p.id)}}>${Icon.plus} Another pack</button>`}</div>
        ${ps.map(p=>html`<div key=${p.id} class="flex flex-wrap items-center gap-2 pl-3 qa-packrow"><span class="text-[12.5px] flex-1">${packName(p,ps)}${p.toolbox?' · toolbox meeting':''}</span>${chip(statusOf(p,v.sigs))}
          <button type="button" class="btn qa-open" style=${{height:30}} onClick=${()=>setOpen(p.id)}>Open</button><button type="button" class="btn px-2" style=${{height:30}} title="PDF" aria-label="PDF" onClick=${()=>packPdf(data,e,p,v.sigs)}>${Icon.download}</button></div>`)}
      </div>`})}</div>
    ${cur&&cp&&html`<${Modal} wide=${true} title="Site QA pack" sub=${`${jobLabel(jobOf(data,block))} · ${WD[parse(cur.k).getDay()]} ${fmtShort(parse(cur.k))}`} onClose=${()=>setOpen(null)}>
      <${PackView} key=${cp.id} ctx=${ctx} data=${data} e=${cur} pack=${cp} sigs=${v.sigs} inModal=${true} onBack=${()=>setOpen(null)}/><//>`}
  </div>`;
}

/* ---------- the PDF: laid out like the paper JSA, signatures included ---------- */
async function packPdf(data,e,p,sigs){
  const Jp=await loadJsPDF();const doc=new Jp({orientation:'l',unit:'mm',format:'a4'});
  const W=297,Ht=210,M=10;let y=0;const J=p.jsa||{};const hd=J.head||{};const ticks=J.ticks||{};
  const txt=(t,x,yy,o)=>doc.text(Array.isArray(t)?t:String(t==null?'':t),x,yy,o);
  const img=(d,x,yy,w,h,alias)=>{try{doc.addImage(d,'PNG',x,yy,w,h,alias,'FAST')}catch(e){}};
  const page=(title,orient)=>{const w=doc.internal.pageSize.getWidth();doc.setFillColor(153,10,44);doc.rect(0,0,w,2,'F');img(AFA_LOGO,w-M-34,5,34,13.2,'afa-logo');
    doc.setFont('helvetica','bold');doc.setFontSize(13);doc.setTextColor(22,24,29);txt(title+(p.label?' · '+p.label:''),M,13);y=22};
  const foot=()=>{const n=doc.internal.getNumberOfPages();for(let i=1;i<=n;i++){doc.setPage(i);const w=doc.internal.pageSize.getWidth(),h=doc.internal.pageSize.getHeight();doc.setFont('helvetica','normal');doc.setFontSize(7);doc.setTextColor(120,125,135);
    txt(`Approved by Dan Soundy – Operations Manager · JSA version ${J.v||JSA_VERSION} · FraserFlow · ${p.status==='submitted'?'submitted '+fmtDT(p.submitted_at)+(p.submitted_name?' by '+p.submitted_name:''):'draft'}`,M,h-5);txt(`Page ${i} of ${n}`,w-M,h-5,{align:'right'})}};
  const box=(x,yy,w,h)=>{doc.setDrawColor(60,60,60);doc.setLineWidth(.2);doc.rect(x,yy,w,h)};
  const room=(h)=>{const hh=doc.internal.pageSize.getHeight();if(y+h>hh-10){doc.addPage('a4','l');page('JOB SPECIFIC ASSESSMENT (JSA) FORM (continued)');return true}return false};
  page('JOB SPECIFIC ASSESSMENT (JSA) FORM');
  /* header grid: 5 columns × 3 rows like the form */
  const cells=[['Job Number',hd.job_no],['Job Location',hd.location],['Customer',hd.customer],['Date',hd.date?fmtShort(parse(hd.date))+' '+parse(hd.date).getFullYear():''],['Time',hd.time],
    ['Foreman',hd.foreman],['Supervisor',hd.supervisor],['Client Rep',hd.client_rep],['Truck Controller',hd.truck_controller],['UHF Channel',hd.uhf],
    ['First Aid Officers',hd.first_aid],['Type',J.type==='seal'?'Spray Seal':'Asphalt']];
  const cw=(W-2*M)/5;cells.forEach(([k,v],i)=>{const x=M+(i%5)*cw,yy=y+Math.floor(i/5)*10;box(x,yy,cw,10);doc.setFont('helvetica','bold');doc.setFontSize(6.8);doc.setTextColor(94,99,110);txt(k,x+1.5,yy+3.4);
    doc.setFont('helvetica','normal');doc.setFontSize(8.5);doc.setTextColor(22,24,29);txt(doc.splitTextToSize(String(v||''),cw-3)[0]||'',x+1.5,yy+8)});y+=33;
  doc.setFontSize(7.5);doc.setTextColor(94,99,110);txt('Ticks mark the control measures actually implemented. Hazards that needed other controls are listed under Site / work location / task / process specific hazards.',M,y);y+=3;
  /* hazards: two columns per section, like the paper */
  const colW=(W-2*M)/2;
  for(const s of JSA_SECTIONS){
    const rows=s.hazards.flatMap(h=>h.controls.map((c,i)=>({h:i===0?h.hazard:'',c,on:!!ticks[tickKey(s.id,h,i)]})));
    if(s.id==='q'){const r=rows.find(x=>/calibrated/i.test(x.c));if(r&&(J.quality||{}).serial)r.c+=` (device serial ${(J.quality||{}).serial})`}
    const half=Math.ceil(rows.length/2);const lines=[rows.slice(0,half),rows.slice(half)];
    doc.setFontSize(7.2);const wrap=it=>it?{a:(doc.setFont('helvetica','bold'),doc.splitTextToSize(it.h,colW*.38-2.4)),b:(doc.setFont('helvetica','normal'),doc.splitTextToSize(it.c,colW*.54-2.4))}:{a:[],b:[]};
    room(14);doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(153,10,44);txt(s.label,M,y+3.5);y+=5.5;
    for(let r=0;r<half;r++){doc.setFontSize(7.2);const L=[wrap(lines[0][r]),wrap(lines[1][r])];const rh=Math.max(1,...L.flatMap(x=>[x.a.length,x.b.length]))*3+2.2;room(rh);
      [0,1].forEach(side=>{const it=lines[side][r];if(!it)return;const x=M+side*colW;
      box(x,y,colW*.38,rh);box(x+colW*.38,y,colW*.54,rh);box(x+colW*.92,y,colW*.08,rh);
      doc.setFont('helvetica','bold');doc.setFontSize(7.2);doc.setTextColor(22,24,29);txt(L[side].a,x+1.2,y+3.5);
      doc.setFont('helvetica','normal');txt(L[side].b,x+colW*.38+1.2,y+3.5);
      if(it.on){doc.setDrawColor(20,120,60);doc.setLineWidth(.6);const cx=x+colW*.96,cy=y+rh/2;doc.line(cx-1.6,cy,cx-.5,cy+1.2);doc.line(cx-.5,cy+1.2,cx+1.7,cy-1.4);doc.setLineWidth(.2)}});y+=rh}
    y+=3}
  /* additional hazards */
  const ex=(J.extra||[]).filter(x=>x.hazard||x.controls);
  room(16);doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(153,10,44);txt('Site / work location / task / process specific hazards',M,y+3.5);y+=5.5;
  const xc=[[M,(W-2*M)*.38,'Hazard'],[M+(W-2*M)*.38,(W-2*M)*.1,'Risk rating'],[M+(W-2*M)*.48,(W-2*M)*.42,'Additional controls implemented'],[M+(W-2*M)*.9,(W-2*M)*.1,'Residual risk']];
  doc.setFontSize(7.2);xc.forEach(([x,w,h])=>{box(x,y,w,5);doc.setFont('helvetica','bold');doc.setTextColor(22,24,29);txt(h,x+1.2,y+3.5)});y+=5;
  (ex.length?ex:[{hazard:'None',risk:'',controls:'',residual:''}]).forEach((x,i)=>{const a=doc.splitTextToSize(`${ex.length?(i+1)+'. ':''}${x.hazard||''}`,xc[0][1]-2),c=doc.splitTextToSize(x.controls||'',xc[2][1]-2);const h=Math.max(a.length,c.length,1)*3.4+2;
    room(h);xc.forEach(([xx,w])=>box(xx,y,w,h));doc.setFont('helvetica','normal');doc.setTextColor(22,24,29);txt(a,xc[0][0]+1.2,y+3.4);txt(x.risk||'',xc[1][0]+1.2,y+3.4);txt(c,xc[2][0]+1.2,y+3.4);txt(x.residual||'',xc[3][0]+1.2,y+3.4);y+=h});
  y+=4;
  /* checklists */
  room(16);doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(153,10,44);txt('Checklists',M,y+3.5);y+=5.5;doc.setFontSize(7.6);doc.setTextColor(22,24,29);
  const mark=(on,x,yy)=>{box(x,yy-3,3.4,3.4);if(on){doc.setDrawColor(20,120,60);doc.setLineWidth(.5);doc.line(x+.6,yy-1.4,x+1.4,yy-.5);doc.line(x+1.4,yy-.5,x+2.9,yy-2.5);doc.setLineWidth(.2)}};
  CHECKS.forEach(([k,l],i)=>{const x=M+(i%4)*(W-2*M)/4,yy=y+3+Math.floor(i/4)*5;mark((J.checks||{})[k],x,yy);doc.setFont('helvetica','normal');txt(l,x+5,yy)});
  y+=13;
  /* attendees */
  const sigTable=(form,label)=>{const list=sigs.filter(s=>s.pack_id===p.id&&s.form===form);room(22);
    doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(153,10,44);txt(label,M,y+3.5);y+=5;
    if(form==='jsa'){doc.setFont('helvetica','normal');doc.setFontSize(6.8);doc.setTextColor(60,64,72);const a=doc.splitTextToSize('Attendees: '+AGREE,W-2*M);txt(a,M,y+2.5);y+=a.length*2.9+2}
    const cw3=[(W-2*M)*.34,(W-2*M)*.26,(W-2*M)*.18,(W-2*M)*.22];const hdr=['Name','Company','Signed','Signature'];
    doc.setFontSize(7.2);let x=M;hdr.forEach((h,i)=>{box(x,y,cw3[i],5);doc.setFont('helvetica','bold');doc.setTextColor(22,24,29);txt(h,x+1.2,y+3.5);x+=cw3[i]});y+=5;
    (list.length?list:[null]).forEach(s=>{room(11);let x=M;cw3.forEach(w=>{box(x,y,w,11);x+=w});if(!s){doc.setFont('helvetica','normal');txt('Nobody has signed',M+1.2,y+6.5);y+=11;return}
      doc.setFont('helvetica','normal');doc.setFontSize(8.2);txt(s.name,M+1.2,y+6.5);txt(s.company||AFA,M+cw3[0]+1.2,y+6.5);doc.setFontSize(7.2);txt(fmtDT(s.signed_at),M+cw3[0]+cw3[1]+1.2,y+6.5);
      img(s.signature,M+cw3[0]+cw3[1]+cw3[2]+2,y+.6,26,9.8,'sig-'+s.id);y+=11})};
  y+=2;sigTable('jsa','Sign-off');
  /* the other forms, in the order of the paper pack */
  if(window.FFQF)for(const f of window.FFQF.FORMS)if((p.forms||{})[f.id]&&f.pdf){f.pdf({doc,J:p,p,data,e,sigs,M,txt,img,box,page,newPage:o=>{doc.addPage('a4',o||'l');},AFA,fmtDT})}
  /* toolbox meeting (optional), portrait like the paper */
  const T=p.toolbox;
  if(T){doc.addPage('a4','p');const w=210;page('TOOLBOX MEETING RECORD FORM');doc.setFontSize(8.5);doc.setTextColor(22,24,29);
    const kv=[['Date',hd.date?fmtShort(parse(hd.date))+' '+parse(hd.date).getFullYear():''],['Location',T.location],['WHS&E Rep',T.whs_rep],['Supervisor',T.supervisor],['Manager',T.manager]];
    kv.forEach(([k,v],i)=>{const x=M+(i%2)*(w-2*M)/2,yy=y+Math.floor(i/2)*6;doc.setFont('helvetica','bold');txt(k+':',x,yy);doc.setFont('helvetica','normal');txt(v||'',x+24,yy)});y+=20;
    const tc=[[M,(w-2*M)*.36,'Topics discussed'],[M+(w-2*M)*.36,(w-2*M)*.36,'Action'],[M+(w-2*M)*.72,(w-2*M)*.13,'Date'],[M+(w-2*M)*.85,(w-2*M)*.15,'Who']];
    doc.setFontSize(7.6);tc.forEach(([x,ww,h])=>{box(x,y,ww,5.5);doc.setFont('helvetica','bold');txt(h,x+1.2,y+3.8)});y+=5.5;
    (T.topics||[]).filter(t=>t.topic||t.action).forEach(t=>{const a=doc.splitTextToSize(t.topic||'',tc[0][1]-2),b=doc.splitTextToSize(t.action||'',tc[1][1]-2);const h=Math.max(a.length,b.length,1)*3.5+2;
      tc.forEach(([x,ww])=>box(x,y,ww,h));doc.setFont('helvetica','normal');txt(a,tc[0][0]+1.2,y+3.6);txt(b,tc[1][0]+1.2,y+3.6);txt(t.date?fmtShort(parse(t.date)):'',tc[2][0]+1.2,y+3.6);txt(t.who||'',tc[3][0]+1.2,y+3.6);y+=h});
    y+=4;doc.setFontSize(8.5);[['Training covered',T.training],['Emergency meeting point',T.meeting_point]].forEach(([k,v])=>{doc.setFont('helvetica','bold');txt(k+':',M,y);doc.setFont('helvetica','normal');txt(doc.splitTextToSize(v||'',w-2*M-45),M+45,y);y+=6});
    y+=2;const W0=W;
    /* attendees table on the portrait page */
    const list=sigs.filter(s=>s.pack_id===p.id&&s.form==='toolbox');const cw3=[(w-2*M)*.32,(w-2*M)*.26,(w-2*M)*.18,(w-2*M)*.24];
    doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(153,10,44);txt('Attendees (name & sign)',M,y);y+=3;doc.setTextColor(22,24,29);doc.setFontSize(7.2);
    let x=M;['Name','Company','Signed','Signature'].forEach((h,i)=>{box(x,y,cw3[i],5);txt(h,x+1.2,y+3.5);x+=cw3[i]});y+=5;
    (list.length?list:[null]).forEach(s=>{if(y+11>287){doc.addPage('a4','p');page('TOOLBOX MEETING RECORD FORM (continued)')}let x=M;cw3.forEach(ww=>{box(x,y,ww,11);x+=ww});
      if(!s){doc.setFont('helvetica','normal');txt('Nobody has signed',M+1.2,y+6.5);y+=11;return}
      doc.setFont('helvetica','normal');doc.setFontSize(8.2);txt(s.name,M+1.2,y+6.5);txt(s.company||AFA,M+cw3[0]+1.2,y+6.5);doc.setFontSize(7.2);txt(fmtDT(s.signed_at),M+cw3[0]+cw3[1]+1.2,y+6.5);
      img(s.signature,M+cw3[0]+cw3[1]+cw3[2]+2,y+.6,26,9.8,'sig-'+s.id);y+=11})}
  foot();
  const j=jobOf(data,e.b);doc.save(`QA pack ${(j&&(j.projectNo||j.name))||'job'} ${e.k}${p.label?' '+p.label:''}.pdf`.replace(/[\\/:*?"<>|]+/g,'-'));
}

window.QaScreen=QaScreen;
window.QaBookingTab=QaBookingTab;
window.FFQ={JSA_SECTIONS,packPdf,allTicks,Card,Tick,SignOff,SignPad,newId,AFA,chip};
})();
