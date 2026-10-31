/* =====================================================================
   FraserFlow: Fleet & Maintenance (Phase 2: core maintenance; Phase 3 prestarts are in prestart.js)
   Loaded only when the Fleet screen opens. Uses the app's own helpers
   (html, hooks, Icon, Combo, date helpers) and the Supabase tables made by
   supabase/maintenance.sql. The roster's machines are the asset list; every
   record here points at a machine by its id. No costs or prices anywhere.
   ===================================================================== */
(function(){
const MT=['asset_profiles','meter_readings','service_plans','service_records','work_orders'];
const P3=['prestart_templates','maintenance_files'];
const P5=['servicem8_jobs','servicem8_settings'];   /* the ServiceM8 link (supabase/servicem8.sql): optional until that script is run */
const P4=['defects','restrictions'];   /* Phase 4 (supabase/defects.sql): optional until that script is run */   /* Phase 3 (supabase/prestarts.sql): optional until that script is run */
const WO_STATUS={open:'Open',scheduled:'Scheduled',in_progress:'In progress',awaiting_parts:'Awaiting parts',completed:'Completed',closed:'Verified & closed',cancelled:'Cancelled'};
const WO_OPEN=s=>!['completed','closed','cancelled'].includes(s);
const WO_TYPE={service:'Scheduled service',defect:'Defect repair',breakdown:'Breakdown',request:'Maintenance request'};
const PRI={low:'Low',medium:'Medium',high:'High',urgent:'Urgent'};
const PRI_COL={low:'var(--muted)',medium:'hsl(212 60% 45%)',high:'hsl(30 90% 42%)',urgent:'hsl(0 72% 47%)'};
const ST={ok:['Operational','hsl(145 55% 36%)'],due:['Maintenance due','hsl(30 90% 46%)'],service:['Being serviced','hsl(212 75% 48%)'],out:['Out of service','hsl(0 72% 47%)']};
const PLAN_ST={ok:['OK','hsl(145 55% 36%)'],soon:['Due soon','hsl(30 90% 46%)'],overdue:['Overdue','hsl(0 72% 47%)'],nobase:['No service recorded','var(--muted)']};
const fs={height:32,fontSize:13};
const n0=v=>v===''||v==null?null:+v;
const dayDiff=(a,b)=>Math.round((parse(b)-parse(a))/864e5);
const fmtD=k=>k?`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}`:'';
const fmtTs=t=>t?new Date(t).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'}):'';
const woNo=w=>'WO '+w.number;
const localDay=ts=>ts?iso(new Date(ts)):'';   /* a database time as a local (Brisbane) date */
const errMsg=e=>(e&&(e.message||e.error_description))||String(e);

/* load every maintenance table (paged past Supabase's 1,000-row limit) and keep it live */
async function fetchAll(sb,t){const out=[];for(let from=0;;from+=1000){const {data,error}=await sb.from(t).select('*').range(from,from+999);if(error)throw error;out.push(...(data||[]));if(!data||data.length<1000)break}return out}
/* prestarts from the last 90 days, newest first */
async function fetchPrestarts(sb){const since=new Date(Date.now()-90*864e5).toISOString();const out=[];
  for(let from=0;;from+=1000){const {data,error}=await sb.from('prestarts').select('*').gte('submitted_at',since).order('submitted_at',{ascending:false}).range(from,from+999);if(error)throw error;out.push(...(data||[]));if(!data||data.length<1000)break}return out}
function useMaint(sb){
  const [db,setDb]=useState(null);const [err,setErr]=useState('');
  const load=async()=>{try{const r=await Promise.all(MT.map(t=>fetchAll(sb,t)));const o={};MT.forEach((t,i)=>o[t]=r[i]);
      try{const r3=await Promise.all([...P3.map(t=>fetchAll(sb,t)),fetchPrestarts(sb)]);P3.forEach((t,i)=>o[t]=r3[i]);o.prestarts=r3[P3.length];o.p3=true}
      catch(e){P3.forEach(t=>o[t]=[]);o.prestarts=[];o.p3=false;o.p3err=errMsg(e)}
      try{const r4=await Promise.all(P4.map(t=>fetchAll(sb,t)));P4.forEach((t,i)=>o[t]=r4[i]);o.p4=true}
      catch(e){P4.forEach(t=>o[t]=[]);o.p4=false;o.p4err=errMsg(e)}
      try{const r5=await Promise.all(P5.map(t=>fetchAll(sb,t)));P5.forEach((t,i)=>o[t]=r5[i]);o.sm8=true}
      catch(e){P5.forEach(t=>o[t]=[]);o.sm8=false}
      try{o.fleet_settings=await fetchAll(sb,'fleet_settings')}catch(e){o.fleet_settings=null}   /* supabase/service_auto.sql: optional */
      setDb(o);setErr('');if(window.ffStore)window.ffStore.set('maint',{...o,savedAt:Date.now()})}   /* kept on this device for working without reception */
    catch(e){const saved=window.isNetErr&&window.isNetErr(e)&&window.ffStore?await window.ffStore.get('maint'):null;
      if(saved){setDb(d=>d&&!d.offline?d:{...saved,offline:true});setErr('')}else setErr(errMsg(e))}};
  useEffect(()=>{load();let t=null;let ch=null;
    try{ch=sb.channel('maint-'+uid());[...MT,...P3,'prestarts',...P4,...P5,'fleet_settings'].forEach(tb=>ch.on('postgres_changes',{event:'*',schema:'public',table:tb},()=>{clearTimeout(t);t=setTimeout(load,350)}));ch.subscribe()}catch(e){}
    return()=>{clearTimeout(t);try{if(ch)sb.removeChannel(ch)}catch(e){}}},[]);
  return {db,err,reload:load};
}

/* ---------- the maintenance picture of the fleet, worked out from the records ---------- */
/* a plan with several intervals (e.g. 250 / 500 / 750 / 1000 h): one plan, the next service in the cycle */
const ivUnit=p=>p.every_hours?'hours':'km';
/* a plan can cover several machine categories (categories), category is the first of them */
const planCatList=p=>{const l=Array.isArray(p&&p.categories)&&p.categories.length?p.categories:(p&&p.category?[p.category]:[]);return [...new Set(l.map(c=>String(c).trim()).filter(Boolean))]};
const planCats=p=>planCatList(p).map(c=>c.toLowerCase());
const ivsOf=p=>Array.isArray(p&&p.intervals)?p.intervals.filter(v=>+v.every>0).sort((a,b)=>a.every-b.every):[];
const ivLabel=(p,v)=>(v.label||'').trim()||`${fmtN(+v.every)} ${ivUnit(p)==='km'?'km':'h'} service`;
function stageOf(p,last){const ivs=ivsOf(p);if(ivs.length<2||!last)return null;const v0=last[ivUnit(p)];if(v0==null)return null;
  const base=+ivs[0].every,cycle=+ivs[ivs.length-1].every;const M=Math.round((+v0+base)/base)*base;const r=M%cycle||cycle;
  const v=ivs.find(x=>+x.every===r)||[...ivs].reverse().find(x=>r%+x.every===0)||ivs[0];return {every:+v.every,at:M,label:ivLabel(p,v),notes:(v.notes||'').trim()}}
const svcName=x=>x.stage?`${x.plan.name} · ${x.stage.label}`:x.plan.name;
const ivTxt=p=>{const ivs=ivsOf(p);return ivs.length>1?ivs.map(v=>fmtN(+v.every)).join(' / ')+(ivUnit(p)==='km'?' km':' h'):null};
function buildModel(data,db){
  const today=iso(TODAY);
  const prof=new Map(db.asset_profiles.map(p=>[p.asset_id,p]));
  const meters=new Map();
  [...db.meter_readings].sort((a,b)=>a.read_at<b.read_at?-1:a.read_at>b.read_at?1:(a.created_at<b.created_at?-1:1))
    .forEach(r=>{const m=meters.get(r.asset_id)||{};m[r.kind]={value:+r.value,at:r.read_at};meters.set(r.asset_id,m)});
  /* every reading per machine and meter, oldest first: for the history and the yearly average */
  const readsBy=new Map();
  [...db.meter_readings].sort((a,b)=>a.read_at<b.read_at?-1:a.read_at>b.read_at?1:(a.created_at<b.created_at?-1:1))
    .forEach(r=>{const o=readsBy.get(r.asset_id)||{hours:[],km:[]};o[r.kind].push(r);readsBy.set(r.asset_id,o)});
  const recs=[...db.service_records].sort((a,b)=>a.done_on<b.done_on?1:a.done_on>b.done_on?-1:(a.created_at<b.created_at?1:-1));
  const machines=data.resources.filter(r=>r.type==='machine');
  const lastPs=new Map();(db.prestarts||[]).forEach(p=>{if(!lastPs.has(p.asset_id))lastPs.set(p.asset_id,p)});   /* newest first */
  const meterType=m=>{const p=prof.get(m.id);if(p&&p.meter_type)return p.meter_type;return /truck/i.test([machCatOf(m),m.name,m.sub].join(' '))?'both':'hours'};
  const plansFor=m=>db.service_plans.filter(p=>p.active&&(p.asset_id===m.id||planCats(p).includes(machCatOf(m).toLowerCase())));
  const planStatus=(m,p)=>{const mt=meterType(m);const last=recs.find(r=>r.asset_id===m.id&&r.plan_id===p.id);
    if(!last)return {state:'nobase',parts:[],last:null};
    const cur=meters.get(m.id)||{};const parts=[];
    if(p.every_hours&&mt!=='km'&&last.hours!=null){const due=+last.hours+ +p.every_hours;const left=cur.hours?due-cur.hours.value:null;
      parts.push({k:'hours',due,left,warn:+p.warn_hours,dueTxt:`${fmtN(due)} h`,leftTxt:left==null?'no hours reading':left<=0?`${fmtN(-left)} h overdue`:`${fmtN(left)} h to go`})}
    if(p.every_km&&mt!=='hours'&&last.km!=null){const due=+last.km+ +p.every_km;const left=cur.km?due-cur.km.value:null;
      parts.push({k:'km',due,left,warn:+p.warn_km,dueTxt:`${fmtN(due)} km`,leftTxt:left==null?'no km reading':left<=0?`${fmtN(-left)} km overdue`:`${fmtN(left)} km to go`})}
    if(p.every_days){const dueK=iso(addDays(parse(last.done_on),+p.every_days));const left=dayDiff(today,dueK);
      parts.push({k:'days',due:dueK,left,warn:+p.warn_days,dueTxt:fmtD(dueK),leftTxt:left<=0?(left===0?'due today':`${-left} days overdue`):`${left} days to go`})}
    if(!parts.length)return {state:'nobase',parts,last};
    const over=parts.filter(x=>x.left!=null&&x.left<=0),soon=parts.filter(x=>x.left!=null&&x.left>0&&x.left<=x.warn);
    const state=over.length?'overdue':soon.length?'soon':'ok';
    /* the trigger that comes first: anything overdue, else the one closest to its warning point */
    const first=[...parts].filter(x=>x.left!=null).sort((a,b)=>(a.left/Math.max(a.warn,1))-(b.left/Math.max(b.warn,1)))[0]||parts[0];
    return {state,parts,last,first,stage:stageOf(p,last)}};
  const assets=machines.map(m=>{const p=prof.get(m.id)||null;const plans=plansFor(m).map(pl=>({plan:pl,...planStatus(m,pl)}));
    const wos=db.work_orders.filter(w=>w.asset_id===m.id);const open=wos.filter(w=>WO_OPEN(w.status));
    const downNow=data.blocks.some(b=>b.resourceId===m.id&&KINDS[b.kind]&&KINDS[b.kind].down&&b.start<=today&&b.end>=today);
    const restr=(db.restrictions||[]).filter(r=>r.asset_id===m.id&&r.active);
    const defects=(db.defects||[]).filter(d=>d.asset_id===m.id&&!['closed','dismissed'].includes(d.status));
    const out=restr.length>0||open.some(w=>w.wo_type==='breakdown'&&w.safe_to_operate===false);
    const serv=open.some(w=>w.status==='in_progress')||downNow;
    const due=plans.some(x=>x.state==='overdue'||x.state==='soon');
    const status=out?'out':serv?'service':due?'due':'ok';
    const next=plans.filter(x=>x.first).sort((a,b)=>({overdue:0,soon:1,ok:2}[a.state]-{overdue:0,soon:1,ok:2}[b.state])||((a.first.left/Math.max(a.first.warn,1))-(b.first.left/Math.max(b.first.warn,1))))[0]||null;
    const crew=m.crewId?data.resources.find(r=>r.id===m.crewId):null;
    const rd=readsBy.get(m.id)||{hours:[],km:[]};
    return {m,p,mt:meterType(m),cur:meters.get(m.id)||{},reads:rd,use:{hours:usageOf(rd.hours),km:usageOf(rd.km)},plans,wos,open,status,next,crew,retired:!!(p&&p.retired),ps:lastPs.get(m.id)||null,restr,defects,
      overdue:plans.filter(x=>x.state==='overdue').length,soon:plans.filter(x=>x.state==='soon').length,last:recs.find(r=>r.asset_id===m.id)||null}});
  return {assets,byId:new Map(assets.map(a=>[a.m.id,a])),recs,meters,today}
}
/* average use per year from a meter's readings (since its last replacement): needs two readings at least 30 days apart */
function usageOf(rs){
  const i=rs.map(r=>r.source).lastIndexOf('replacement');const xs=i>=0?rs.slice(i):rs;if(xs.length<2)return null;
  const a=xs[0],b=xs[xs.length-1];const days=(new Date(b.read_at)-new Date(a.read_at))/864e5;const d=+b.value- +a.value;
  if(days<30||d<0)return null;return {perYear:d/days*365.25,days,from:a,to:b,n:xs.length}}
const perYrTxt=(a,k)=>{const u=a.use[k];if(!u)return null;return k==='hours'?`${fmtN(Math.round(u.perYear))} h/yr`:`${fmtN(Math.round(u.perYear/100)*100)} km/yr`};
const useTxt=a=>[a.mt!=='km'&&(perYrTxt(a,'hours')||'– h/yr'),a.mt!=='hours'&&(perYrTxt(a,'km')||'– km/yr')].filter(Boolean).join(' · ');
const stDot=(s,size=10)=>html`<span class="inline-block rounded-full shrink-0" style=${{width:size,height:size,background:ST[s][1]}} title=${ST[s][0]}></span>`;
const stChip=s=>html`<span class="inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style=${{color:ST[s][1],background:'var(--sunken)',boxShadow:`inset 0 0 0 1px ${ST[s][1]}`}}>${stDot(s,7)} ${ST[s][0]}</span>`;
const planChip=s=>html`<span class="text-[11px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style=${{color:PLAN_ST[s][1],background:'var(--sunken)',boxShadow:`inset 0 0 0 1px ${PLAN_ST[s][1]}`}}>${PLAN_ST[s][0]}</span>`;
const woChip=s=>html`<span class="text-[11px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style=${{background:s==='closed'?'hsl(145 50% var(--blk-l))':s==='cancelled'?'var(--sunken)':s==='completed'?'hsl(145 50% var(--blk-l))':s==='in_progress'?'hsl(212 80% var(--blk-l))':s==='awaiting_parts'?'hsl(38 85% var(--blk-l))':'var(--accent-soft)',color:s==='cancelled'?'var(--muted)':'var(--ink)'}}>${WO_STATUS[s]}</span>`;
const meterTxt=a=>[a.mt!=='km'&&(a.cur.hours?`${fmtN(a.cur.hours.value)} h`:'– h'),a.mt!=='hours'&&(a.cur.km?`${fmtN(a.cur.km.value)} km`:'– km')].filter(Boolean).join(' · ');

/* small building blocks */
function Modal({title,sub,onClose,children,foot,wide,noEsc}){
  const escRef=useRef(noEsc);escRef.current=noEsc;
  useEffect(()=>{const h=e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!escRef.current){onClose()}};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);   /* an open dropdown takes Escape first */
  return html`<div class="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class=${'panel pop w-full flex flex-col max-h-full overflow-hidden '+(wide?'max-w-[980px] sm:h-[90vh]':'max-w-[560px]')} role="dialog" aria-modal="true" aria-labelledby="mx-title">
      <div class="px-5 pt-5 pb-3 border-b border-line flex items-start gap-3"><div class="min-w-0 flex-1"><div id="mx-title" class="font-display text-[18px] font-semibold">${title}</div>${sub&&html`<div class="text-[12.5px] text-muted">${sub}</div>`}</div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button></div>
      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-4">${children}</div>
      ${foot&&html`<div class="px-5 py-3 border-t border-line bg-sunken flex flex-wrap items-center gap-2">${foot}</div>`}
    </div></div>`;
}
const Fld=({label,children,span})=>html`<label class=${'grid gap-1 min-w-0'+(span?' sm:col-span-2':'')}><span class="label">${label}</span>${children}</label>`;
function PartsEditor({parts,onChange,disabled}){
  const rows=parts&&parts.length?parts:[];
  return html`<div class="grid gap-1.5">
    ${rows.map((p,i)=>html`<div key=${i} class="grid grid-cols-[1fr_80px_28px] gap-2 items-center">
      <input class="field field-sm" style=${{height:30,fontSize:13}} placeholder="Part or material, e.g. Oil filter" value=${p.part||''} disabled=${disabled} aria-label="Part" onInput=${e=>onChange(rows.map((x,k)=>k===i?{...x,part:e.target.value}:x))}/>
      <input class="field field-sm mono" style=${{height:30,fontSize:13}} placeholder="Qty" value=${p.qty??''} disabled=${disabled} aria-label="Quantity" onInput=${e=>onChange(rows.map((x,k)=>k===i?{...x,qty:e.target.value}:x))}/>
      <button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" disabled=${disabled} onClick=${()=>onChange(rows.filter((_,k)=>k!==i))} aria-label="Remove part">${Icon.x}</button></div>`)}
    ${!disabled&&html`<button type="button" class="justify-self-start text-[12px] font-medium inline-flex items-center gap-1 text-muted hover:text-ink" onClick=${()=>onChange([...rows,{part:'',qty:''}])}>${Icon.plus} Add a part</button>`}
  </div>`;
}
const cleanParts=ps=>(ps||[]).filter(p=>(p.part||'').trim()).map(p=>({part:p.part.trim(),qty:(String(p.qty??'').trim())||'1'}));
const partsTxt=ps=>(ps||[]).map(p=>`${p.qty&&p.qty!=='1'?p.qty+' × ':''}${p.part}`).join(', ');

/* ---------- ServiceM8: the contract mechanic's job software (api/servicem8.js, supabase/servicem8.sql) ---------- */
const SM8_ST={pending:'Waiting to send',sending:'Sending…',sent:'In ServiceM8',held:'Not sent to ServiceM8',error:'Couldn’t send to ServiceM8',skipped:'Not sent: finished before it went',removed:'Deleted in ServiceM8'};
async function sm8Call(sb,body){const {data:{session}}=await sb.auth.getSession();
  let r;try{r=await fetch('/api/servicem8',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(session&&session.access_token||'')},body:JSON.stringify(body)})}
  catch(e){throw new Error('No connection: try again when you have reception.')}
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('The ServiceM8 link didn’t answer ('+r.status+')'));return j}
const sm8Cfg=db=>(db&&db.sm8&&db.servicem8_settings[0])||{};
const sm8On=db=>!!sm8Cfg(db).enabled;
/* who new work orders are assigned to: the contractor named in the ServiceM8 settings, or Bells Diesel */
const defaultAssignee=db=>(sm8Cfg(db).contractor_name||'').trim()||'Bells Diesel';
const sm8Of=(db,id)=>db&&db.sm8?db.servicem8_jobs.find(l=>l.work_order_id===id)||null:null;
/* send what's waiting and pass on changes, quietly: a problem shows on the work order itself */
function sm8Flush(ctx){if(sm8On(ctx.db))sm8Call(ctx.sb,{action:'flush'}).catch(()=>{})}
const agoTxt=t=>{if(!t)return '';const m=Math.round((Date.now()-new Date(t))/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:fmtTs(t)};
/* the little mark on the work orders list */
const sm8Mark=l=>!l||l.state==='held'||l.state==='skipped'?null:html`<span class="ml-1.5 text-[10.5px] font-semibold px-1 py-px rounded mono" title=${SM8_ST[l.state]+(l.job_no?' · job '+l.job_no:'')+(l.last_error?': '+l.last_error:'')}
  style=${{background:'var(--sunken)',color:l.state==='error'||l.state==='removed'?'var(--bad)':l.state==='sent'?'var(--ink)':'var(--muted)',boxShadow:'inset 0 0 0 1px var(--line)'}}>SM8${l.state==='error'?' !':l.state==='sent'?'':' …'}</span>`;

/* on a work order: where it is with ServiceM8, and what can be done */
function Sm8Panel({ctx,wo}){
  const {db,sb,notify,reload,perms}=ctx;const l=sm8Of(db,wo.id);const cfg=sm8Cfg(db);
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  if(!db.sm8||(!cfg.enabled&&!l))return null;
  const act=async(fn,msg)=>{setBusy(true);setErr('');try{await fn();if(msg)notify(msg);reload()}catch(e){setErr(errMsg(e))}finally{setBusy(false)}};
  const request=send=>act(async()=>{const {error}=await sb.rpc('servicem8_request',{p_wo:wo.id,p_send:send});if(error)throw error;
    if(send){const r=await sm8Call(sb,{action:'flush'});const mine=(r.errors||[]).find(x=>x.wo===wo.id);if(mine)throw new Error(mine.error)}},send?`${woNo(wo)} sent to ServiceM8`:`${woNo(wo)} won’t go to ServiceM8`);
  const sync=()=>act(()=>sm8Call(sb,{action:'sync',wo:wo.id}),`${woNo(wo)} updated from ServiceM8`);
  const st=l?l.state:'held';const open=WO_OPEN(wo.status);const who=cfg.contractor_name||'The contractor';
  const btn=(id,label,fn,danger)=>html`<button id=${id} type="button" class="btn" style=${{height:28,fontSize:12.5,...(danger?{color:'var(--bad)'}:{})}} disabled=${busy} onClick=${fn}>${label}</button>`;
  return html`<div id="wo-sm8" class="sm:col-span-2 rounded-lg border border-line p-3 grid gap-1.5" data-state=${st}>
    <div class="flex flex-wrap items-center gap-2">
      <span class="label">ServiceM8</span>
      <span class="text-[13px] font-medium" style=${{color:st==='error'||st==='removed'?'var(--bad)':'var(--ink)'}}>${st==='sent'?`Job${l.job_no?' '+l.job_no:''} · ${l.sm8_status||'Work Order'}`:SM8_ST[st]}</span>
      <span class="flex-1"></span>
      ${perms.work&&html`
        ${st==='sent'&&btn('sm8-sync','Refresh now',sync)}
        ${(st==='pending'||st==='error')&&open&&btn('sm8-send',st==='error'?'Try again':'Send now',()=>request(true))}
        ${(st==='pending'||st==='error')&&open&&btn('sm8-hold','Don’t send',()=>request(false),true)}
        ${(st==='held'||st==='skipped'||st==='removed')&&open&&cfg.enabled&&btn('sm8-send','Send to ServiceM8',()=>request(true))}`}
    </div>
    <div class="text-[12px] text-muted">${st==='sent'?`${who} works this job in ServiceM8: when it’s booked, started, waiting on parts, completed or abandoned there, this work order follows.${l.synced_at?' Last heard '+agoTxt(l.synced_at)+'.':''}`
      :st==='error'?(l.last_error||'')
      :st==='removed'?'The job was deleted in ServiceM8. Send it again, or carry on here.'
      :st==='pending'||st==='sending'?'It goes to ServiceM8 in a moment.'
      :open&&cfg.enabled?'This work order is handled here, not in ServiceM8.':''}</div>
    ${st==='sent'&&html`<div class="grid sm:grid-cols-2 gap-2 pt-1">
      <div id="wo-sm8-desc" class="rounded-md border border-line bg-sunken p-2.5 grid gap-1 content-start min-w-0"><span class="label">Description (from ServiceM8)</span>
        ${l.sm8_description?html`<div class="text-[13px] whitespace-pre-wrap break-words">${l.sm8_description}</div>`:html`<div class="text-[12.5px] text-muted">Nothing added to the job description yet.</div>`}</div>
      <div id="wo-sm8-notes" class="rounded-md border border-line bg-sunken p-2.5 grid gap-1.5 content-start min-w-0"><span class="label">Notes (from ServiceM8)</span>
        ${Array.isArray(l.sm8_notes)&&l.sm8_notes.length?l.sm8_notes.map((n,i)=>html`<div key=${i} class="text-[13px] break-words"><span class="text-[11.5px] text-muted mono">${n.at?n.at.slice(8,10)+'/'+n.at.slice(5,7)+' '+n.at.slice(11,16):''}</span> <span class="whitespace-pre-wrap">${n.text}</span></div>`)
          :html`<div class="text-[12.5px] text-muted">${Array.isArray(l.sm8_notes)?'No notes on the job yet.':'Notes show here once ServiceM8 is reconnected (Fleet › Work orders › ServiceM8).'}</div>`}</div>
    </div>`}
    ${(()=>{const files=(db.maintenance_files||[]).filter(f=>f.work_order_id===wo.id);if(!files.length&&st!=='sent')return null;
      const oldDb=st==='sent'&&!('files_error' in l);   /* servicem8.sql hasn't been run again since photos were added */
      const openFile=async f=>{const w=window.open('','_blank');try{const o=window.FFP?await window.FFP.signedUrls(sb,[f.path]):{};if(o[f.path]){if(w)w.location=o[f.path];else location.href=o[f.path]}else{if(w)w.close();setErr('Couldn’t open that file.')}}catch(e){if(w)w.close();setErr(errMsg(e))}};
      /* a file added here: kept with the machine's files, linked to this work order, and sent to his job */
      const addFile=async file=>{setErr('');if(file.size>15*1024*1024){setErr('That file is over 15 MB.');return}
        if(!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.type)){setErr('Add a PDF or a picture (JPG, PNG).');return}
        setBusy(true);try{const safe=file.name.replace(/[^\w.\- ]+/g,'_').slice(-80);const path=`assets/${wo.asset_id}/wo/${Date.now()}-${safe}`;
          const {error}=await sb.storage.from('maintenance').upload(path,file,{contentType:file.type,upsert:false});if(error)throw error;
          const {error:e2}=await sb.from('maintenance_files').insert({asset_id:wo.asset_id,kind:file.type==='application/pdf'?'document':'photo',name:`${woNo(wo)} · ${file.name}`,path,mime:file.type,size:file.size,work_order_id:wo.id});if(e2)throw e2;
          await sm8Call(sb,{action:'sync',wo:wo.id});notify(`${file.name} added and sent to ServiceM8`);reload()}
        catch(e){setErr(errMsg(e));reload()}finally{setBusy(false)}};
      return html`<div id="wo-sm8-files" class="rounded-md border border-line bg-sunken p-2.5 grid gap-1 content-start"><div class="flex items-center gap-2"><span class="label flex-1">Photos and documents (shared with ServiceM8)</span>
          ${perms.work&&st==='sent'&&!oldDb&&html`<label class="text-[12px] text-muted hover:text-ink inline-flex items-center gap-1 cursor-pointer">${Icon.plus} ${busy?'Sending…':'Add a file'}<input id="wo-sm8-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" class="hidden" disabled=${busy} onChange=${e=>{const f=e.target.files&&e.target.files[0];e.target.value='';if(f)addFile(f)}}/></label>`}</div>
        ${files.map(f=>html`<div key=${f.id} class="flex items-center gap-2 min-w-0"><button type="button" class="text-left text-[13px] hover:underline truncate flex-1 min-w-0" style=${{color:'var(--accent)'}} onClick=${()=>openFile(f)}>${f.name.replace(/^WO \d+ · /,'')}</button>
          <span class="text-[11.5px] text-muted whitespace-nowrap">${f.created_by?(f.sm8_uuid?'added here · in ServiceM8':'added here · sending…'):'from ServiceM8'}</span></div>`)}
        ${!files.length&&!oldDb&&!l.files_error&&html`<div class="text-[12.5px] text-muted">None yet. Photos (JPG, PNG) and PDFs added here or on his job show here, and in both places.</div>`}
        ${oldDb&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>To bring his photos across, an administrator runs supabase/servicem8.sql again in Supabase → SQL Editor.</div>`}
        ${l&&l.files_error&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${l.files_error}</div>`}</div>`})()}
    ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
  </div>`;
}

/* administrators: connecting ServiceM8 and how it's used */
function Sm8Settings({ctx,onClose}){
  const {db,sb,notify,reload}=ctx;const c0=sm8Cfg(db);
  const [f,setF]=useState({enabled:!!c0.enabled,auto_send:c0.auto_send!==false,client_name:c0.client_name||'AFA',contractor_name:c0.contractor_name||'',job_address:c0.job_address||'',parts_queue_uuid:c0.parts_queue_uuid||'',parts_queue_name:c0.parts_queue_name||''});
  const [st,setSt]=useState(null);const [queues,setQueues]=useState(null);const [busy,setBusy]=useState('');const [err,setErr]=useState('');
  useEffect(()=>{sm8Call(sb,{action:'status'}).then(setSt).catch(e=>setSt({mode:'?',connected:false,error:errMsg(e)}))},[]);
  const run=async(k,fn)=>{setBusy(k);setErr('');try{await fn()}catch(e){setErr(errMsg(e))}finally{setBusy('')}};
  const row=()=>({enabled:f.enabled,auto_send:f.auto_send,client_name:f.client_name.trim()||'AFA',contractor_name:f.contractor_name.trim()||null,job_address:f.job_address.trim()||null,
    parts_queue_uuid:f.parts_queue_uuid||null,parts_queue_name:f.parts_queue_uuid?f.parts_queue_name||null:null,...((f.client_name.trim()||'AFA')!==(c0.client_name||'AFA')?{company_uuid:null}:{})});
  const store=async extra=>{const {error}=await sb.from('servicem8_settings').update({...row(),...(extra||{})}).eq('id',1);if(error)throw error};
  const ready=!!(st&&st.connected);const hooked=!!(c0.hooks_on_at||(st&&st.hooksOn));
  const save=()=>run('save',async()=>{if(f.enabled&&!ready)throw new Error('Connect ServiceM8 first.');if(f.enabled&&!hooked)throw new Error('Click “Set up in ServiceM8” first.');
    await store();notify('ServiceM8 settings saved');reload();if(f.enabled)sm8Call(sb,{action:'flush'}).catch(()=>{});onClose()});
  const connect=()=>run('connect',async()=>{const r=await sm8Call(sb,{action:'connect'});window.location.href=r.url});
  const disconnect=()=>run('disconnect',async()=>{if(!confirm('Disconnect ServiceM8? Work orders stop going to it until it is connected again.'))return;await sm8Call(sb,{action:'disconnect'});setF({...f,enabled:false});setSt({...st,connected:false});reload();notify('ServiceM8 disconnected')});
  const setup=()=>run('setup',async()=>{await store({enabled:c0.enabled&&f.enabled});const r=await sm8Call(sb,{action:'setup'});setSt({...st,hooksOn:true});reload();
    notify(r.hooks==='full'&&r.bookings!==false?'ServiceM8 is set up':'ServiceM8 is set up (some changes are picked up by the regular refresh, not the moment they happen)')});
  const loadQ=()=>run('q',async()=>{const r=await sm8Call(sb,{action:'queues'});setQueues(r.queues||[])});
  const conn=!st?'Checking…':st.mode==='?'?st.error:st.mode==='key'?(st.connected?'Connected with an API key from his ServiceM8.':'API key set, but ServiceM8 refused it.')
    :st.mode==='oauth'?(st.connected?'Connected.':st.error||'Not connected yet.')
    :'Not set up on the server yet: add SERVICEM8_APP_ID and SERVICEM8_APP_SECRET (or SERVICEM8_API_KEY) in Vercel → Settings → Environment Variables, then redeploy. The README has the steps.';
  const qList=queues||(f.parts_queue_uuid?[{uuid:f.parts_queue_uuid,name:f.parts_queue_name||'(saved queue)'}]:[]);
  return html`<${Modal} title="ServiceM8" sub="Work orders go to the contract mechanic’s ServiceM8 as jobs, and their progress comes back" onClose=${onClose}
    foot=${html`${err&&html`<span id="sm8-err" class="text-[12.5px] w-full" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span>
      <button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="sm8-save" type="button" class="btn btn-primary" disabled=${!!busy} onClick=${save}>Save</button>`}>
    <div class="grid gap-4">
      <section class="grid gap-1.5"><div class="font-semibold text-[13.5px]">1. Connect his ServiceM8</div>
        <div id="sm8-conn" class="text-[13px]">${conn}</div>
        ${st&&st.connected&&html`<div id="sm8-last" class="text-[12px] text-muted">${st.lastHook?`Last report from ServiceM8: ${agoTxt(st.lastHook.at)}${st.lastHook.what?' ('+st.lastHook.what+')':''}.`:'No reports from ServiceM8 yet.'}</div>`}
        ${st&&st.mode==='oauth'&&!st.connected&&html`<div class="text-[12px] text-muted">He signs in to his own ServiceM8 on the next page and approves FraserFlow. He can disconnect it from ServiceM8 at any time.</div>
          <div><button id="sm8-connect" type="button" class="btn" disabled=${!!busy} onClick=${connect}>Connect ServiceM8</button></div>`}
        ${st&&st.mode==='oauth'&&st.connected&&html`<div><button id="sm8-disconnect" type="button" class="btn" style=${{color:'var(--bad)'}} disabled=${!!busy} onClick=${disconnect}>Disconnect</button></div>`}
      </section>
      <section class="grid sm:grid-cols-2 gap-3"><div class="sm:col-span-2 font-semibold text-[13.5px]">2. How AFA appears in his ServiceM8</div>
        <${Fld} label="AFA’s client name in his ServiceM8"><input id="sm8-client" class="field" style=${fs} value=${f.client_name} onInput=${e=>setF({...f,client_name:e.target.value})}/><//>
        <${Fld} label="Contractor (shown as Assigned)"><input id="sm8-contractor" class="field" style=${fs} placeholder="e.g. Smith Mechanical" value=${f.contractor_name} onInput=${e=>setF({...f,contractor_name:e.target.value})}/><//>
        <${Fld} label="Job address (where the machines are)" span=${true}><input id="sm8-address" class="field" style=${fs} placeholder="e.g. the depot’s street address" value=${f.job_address} onInput=${e=>setF({...f,job_address:e.target.value})}/><//>
        <div class="sm:col-span-2 flex flex-wrap items-center gap-2"><button id="sm8-setup" type="button" class="btn" disabled=${!!busy||!ready} onClick=${setup}>${busy==='setup'?'Setting up…':'Set up in ServiceM8'}</button>
          <span class="text-[12px] text-muted">${hooked?`Done${c0.hooks_on_at?' '+fmtTs(c0.hooks_on_at):''}. Run it again if you change the client name.`:'Finds (or makes) AFA’s client record, and asks ServiceM8 to report changes to AFA’s jobs.'}</span></div>
      </section>
      <section class="grid gap-1.5"><div class="font-semibold text-[13.5px]">3. His “awaiting parts” queue (optional)</div>
        <div class="flex flex-wrap items-center gap-2">
          <select id="sm8-queue" class="field" style=${{...fs,minWidth:220}} value=${f.parts_queue_uuid} onChange=${e=>{const q=qList.find(x=>x.uuid===e.target.value);setF({...f,parts_queue_uuid:e.target.value,parts_queue_name:q?q.name:''})}}>
            <option value="">None</option>${qList.map(x=>html`<option key=${x.uuid} value=${x.uuid}>${x.name}</option>`)}</select>
          ${!queues&&html`<button id="sm8-queues" type="button" class="btn" disabled=${!!busy||!ready} onClick=${loadQ}>Load his queues</button>`}</div>
        <div class="text-[12px] text-muted">When he puts an AFA job in this queue, its work order shows Awaiting parts.</div>
      </section>
      <section class="grid gap-2"><div class="font-semibold text-[13.5px]">4. Switch it on</div>
        <label class="flex items-start gap-2 text-[13px] cursor-pointer"><input id="sm8-enabled" type="checkbox" class="w-4 h-4 mt-0.5" checked=${f.enabled} onChange=${e=>setF({...f,enabled:e.target.checked})}/>
          <span>Send work orders to ServiceM8<span class="block text-[12px] text-muted">Work orders made before this aren’t sent unless you open one and choose Send to ServiceM8.</span></span></label>
        <label class="flex items-start gap-2 text-[13px] cursor-pointer"><input id="sm8-auto" type="checkbox" class="w-4 h-4 mt-0.5" checked=${f.auto_send} disabled=${!f.enabled} onChange=${e=>setF({...f,auto_send:e.target.checked})}/>
          <span>Send every new work order automatically<span class="block text-[12px] text-muted">Each new work order can still be kept back with “Don’t send”. Untick to send them one at a time instead.</span></span></label>
      </section>
    </div><//>`;
}

/* ---------- dialogs ---------- */
function ServiceDialog({ctx,a,plan,baseline,onClose}){
  const {sb,notify,reload,staff}=ctx;const px=plan&&!baseline&&a.plans.find(y=>y.plan.id===plan.id);const stg=px&&px.stage;
  const [f,setF]=useState({done_on:iso(TODAY),hours:a.mt!=='km'&&a.cur.hours?String(a.cur.hours.value):'',km:a.mt!=='hours'&&a.cur.km?String(a.cur.km.value):'',mechanic:'',work_done:stg&&stg.notes||'',notes:'',parts:[],service_type:plan?(stg?svcName(px):plan.name):''});
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const save=async()=>{setErr('');if(!f.service_type.trim()){setErr('Say what service was done.');return}if(!f.done_on){setErr('Pick the date it was done.');return}
    setBusy(true);const {error}=await sb.from('service_records').insert({asset_id:a.m.id,plan_id:plan?plan.id:null,service_type:f.service_type.trim(),done_on:f.done_on,hours:n0(f.hours),km:n0(f.km),
      mechanic:f.mechanic.trim()||null,work_done:f.work_done.trim()||null,notes:f.notes.trim()||null,parts:cleanParts(f.parts),baseline:!!baseline});
    setBusy(false);if(error){setErr(errMsg(error));return}notify(baseline?'Last service recorded':'Service recorded');reload();onClose()};
  return html`<${Modal} title=${baseline?'Last service before FraserFlow':'Record a service'} sub=${`${a.m.name} · ${a.m.sub||''}`} onClose=${onClose}
    foot=${html`${err&&html`<span class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="sv-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>${busy?'Saving…':'Save service'}</button>`}>
    ${baseline&&html`<p class="text-[12.5px] text-muted mb-3">Enter when this service was last done, and at what hours or km. FraserFlow works out when the next one is due from here.</p>`}
    <div class="grid sm:grid-cols-2 gap-3">
      <${Fld} label="Service" span=${true}><${Combo} id="sv-type" className="field" style=${fs} label="Service" value=${f.service_type} onChange=${v=>setF({...f,service_type:v})} options=${ctx.plans.map(p=>p.name)}/><//>
      <${Fld} label="Date done"><input id="sv-date" type="date" class="field mono" style=${fs} value=${f.done_on} max=${iso(TODAY)} onChange=${e=>setF({...f,done_on:e.target.value})}/><//>
      ${!baseline&&html`<${Fld} label="Mechanic or contractor"><${Combo} id="sv-mech" className="field" style=${fs} label="Mechanic" value=${f.mechanic} onChange=${v=>setF({...f,mechanic:v})} options=${staff}/><//>`}
      ${a.mt!=='km'&&html`<${Fld} label="Engine hours at service"><input id="sv-hours" type="number" min="0" step="any" class="field mono" style=${fs} value=${f.hours} onInput=${e=>setF({...f,hours:e.target.value})}/><//>`}
      ${a.mt!=='hours'&&html`<${Fld} label="Odometer km at service"><input id="sv-km" type="number" min="0" step="any" class="field mono" style=${fs} value=${f.km} onInput=${e=>setF({...f,km:e.target.value})}/><//>`}
      ${!baseline&&html`<${Fld} label="Work completed" span=${true}><textarea id="sv-work" class="field" style=${{height:'auto',minHeight:70,padding:'8px 10px',fontSize:13}} rows="3" value=${f.work_done} onInput=${e=>setF({...f,work_done:e.target.value})}></textarea><//>
        <div class="sm:col-span-2 grid gap-1"><span class="label">Parts replaced or used</span><${PartsEditor} parts=${f.parts} onChange=${v=>setF({...f,parts:v})}/></div>
        <${Fld} label="Notes" span=${true}><input class="field" style=${fs} value=${f.notes} onInput=${e=>setF({...f,notes:e.target.value})}/><//>`}
    </div><//>`;
}

function ReadingDialog({ctx,a,onClose}){
  const {sb,notify,reload,perms}=ctx;
  const [f,setF]=useState({kind:a.mt==='km'?'km':'hours',value:'',read_at:iso(TODAY),source:'manual',note:''});const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const save=async()=>{setErr('');if(f.value===''){setErr('Enter the reading.');return}setBusy(true);
    const ts=f.read_at===iso(TODAY)?new Date().toISOString():new Date(f.read_at+'T12:00:00').toISOString();
    const {error}=await sb.from('meter_readings').insert({asset_id:a.m.id,kind:f.kind,value:+f.value,read_at:ts,source:f.source,note:f.note.trim()||null});
    setBusy(false);if(error){setErr(errMsg(error));return}notify('Reading saved');reload();onClose()};
  const cur=a.cur[f.kind];
  return html`<${Modal} title="Add a meter reading" sub=${`${a.m.name} · now ${meterTxt(a)}`} onClose=${onClose}
    foot=${html`${err&&html`<span id="rd-err" class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="rd-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>Save reading</button>`}>
    <div class="grid sm:grid-cols-2 gap-3">
      ${a.mt==='both'&&html`<${Fld} label="Meter"><div class="seg w-max"><button type="button" aria-pressed=${f.kind==='hours'} onClick=${()=>setF({...f,kind:'hours'})}>Engine hours</button><button type="button" aria-pressed=${f.kind==='km'} onClick=${()=>setF({...f,kind:'km'})}>Odometer km</button></div><//>`}
      <${Fld} label=${f.kind==='hours'?'Engine hours':'Odometer km'}><input id="rd-value" type="number" min="0" step="any" class="field mono" style=${fs} value=${f.value} autoFocus=${true} onInput=${e=>setF({...f,value:e.target.value})}/><//>
      <${Fld} label="Date read"><input type="date" class="field mono" style=${fs} value=${f.read_at} max=${iso(TODAY)} onChange=${e=>setF({...f,read_at:e.target.value})}/><//>
      ${perms.mgr&&html`<${Fld} label="Type"><select class="field" style=${fs} value=${f.source} onChange=${e=>setF({...f,source:e.target.value})}>
          <option value="manual">Normal reading</option><option value="correction">Correction (fixes a wrong reading)</option><option value="replacement">Meter replaced (starts again)</option></select><//>`}
      <${Fld} label="Note"><input class="field" style=${fs} value=${f.note} onInput=${e=>setF({...f,note:e.target.value})}/><//>
    </div>
    <p class="text-[12px] text-muted mt-3">${cur?`Last ${f.kind==='hours'?'hours':'km'} reading: ${fmtN(cur.value)} on ${fmtTs(cur.at)}. `:''}A reading can’t be lower than the one before it${perms.mgr?' unless it is a correction or a new meter':'. If a reading was wrong, ask an administrator to correct it'}.</p><//>`;
}

function ProfileDialog({ctx,a,onClose}){
  const {sb,notify,reload}=ctx;const p=a.p||{};
  const [f,setF]=useState({make:p.make||'',model:p.model||'',year:p.year?String(p.year):'',serial:p.serial||'',meter_type:a.mt,retired:!!p.retired,notes:p.notes||''});const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const save=async()=>{setErr('');setBusy(true);const row={asset_id:a.m.id,make:f.make.trim()||null,model:f.model.trim()||null,year:f.year?+f.year:null,serial:f.serial.trim()||null,meter_type:f.meter_type,retired:f.retired,notes:f.notes.trim()||null};
    const {error}=a.p?await sb.from('asset_profiles').update(row).eq('asset_id',a.m.id):await sb.from('asset_profiles').insert(row);
    setBusy(false);if(error){setErr(errMsg(error));return}notify('Machine details saved');reload();onClose()};
  return html`<${Modal} title="Machine details" sub=${`${a.m.name} · ${a.m.sub||''}${a.m.rego?' · '+a.m.rego:''}`} onClose=${onClose}
    foot=${html`${err&&html`<span class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="pf-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>Save</button>`}>
    
    <div class="grid sm:grid-cols-2 gap-3">
      <${Fld} label="Make"><input id="pf-make" class="field" style=${fs} placeholder="e.g. Dynapac" value=${f.make} onInput=${e=>setF({...f,make:e.target.value})}/><//>
      <${Fld} label="Model"><input class="field" style=${fs} placeholder="e.g. CC1200" value=${f.model} onInput=${e=>setF({...f,model:e.target.value})}/><//>
      <${Fld} label="Year"><input type="number" min="1950" max="2100" class="field mono" style=${fs} value=${f.year} onInput=${e=>setF({...f,year:e.target.value})}/><//>
      <${Fld} label="Serial number"><input class="field mono" style=${fs} value=${f.serial} onInput=${e=>setF({...f,serial:e.target.value})}/><//>
      <${Fld} label="Meters"><select id="pf-meter" class="field" style=${fs} value=${f.meter_type} onChange=${e=>setF({...f,meter_type:e.target.value})}>
        <option value="hours">Engine hours</option><option value="km">Kilometres</option><option value="both">Hours and kilometres</option></select><//>
      <${Fld} label="Notes"><input class="field" style=${fs} value=${f.notes} onInput=${e=>setF({...f,notes:e.target.value})}/><//>
      <label class="inline-flex items-center gap-2 text-[13px] cursor-pointer sm:col-span-2"><input type="checkbox" class="w-4 h-4" checked=${f.retired} onChange=${e=>setF({...f,retired:e.target.checked})}/>Retired (kept for history, left out of the fleet counts)</label>
    </div><//>`;
}

/* one dialog for new and existing work orders, including completing a service and verifying */
function WorkOrderDialog({ctx,wo,init,onClose}){
  const {sb,notify,reload,perms,M,staff}=ctx;const isNew=!wo;
  const [f,setF]=useState(()=>wo?{...wo,start_date:wo.start_date||'',end_date:wo.end_date||'',assigned_to:wo.assigned_to||'',description:wo.description||'',servicem8_no:wo.servicem8_no||'',completion_notes:wo.completion_notes||'',parts:wo.parts||[]}
    :{asset_id:'',wo_type:'request',plan_id:null,title:'',description:'',servicem8_no:'',priority:'medium',assigned_to:defaultAssignee(ctx.db),start_date:'',end_date:'',parts:[],completion_notes:'',...(init||{})});
  /* fields ServiceM8 can change while this is open: refreshed unless you've changed them, and only saved if you have */
  const SYNCED=['start_date','end_date','assigned_to','completion_notes','parts'];
  const formOf=w=>({start_date:w.start_date||'',end_date:w.end_date||'',assigned_to:w.assigned_to||'',completion_notes:w.completion_notes||'',parts:w.parts||[]});
  const base=useRef(wo?formOf(wo):null);const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
  useEffect(()=>{if(!wo||!base.current)return;const now=formOf(wo);
    setF(prev=>{const n={...prev};SYNCED.forEach(k=>{if(same(prev[k],base.current[k]))n[k]=now[k]});return n});base.current=now},[wo&&wo.updated_at]);
  const a=M.byId.get(f.asset_id);
  const [svc,setSvc]=useState(()=>({done_on:iso(TODAY),hours:a&&a.mt!=='km'&&a.cur.hours?String(a.cur.hours.value):'',km:a&&a.mt!=='hours'&&a.cur.km?String(a.cur.km.value):''}));
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const sm8c=sm8Cfg(ctx.db);const [toSm8,setToSm8]=useState(()=>sm8On(ctx.db)&&sm8c.auto_send!==false);
  const D=window.FFD&&ctx.db.p4?window.FFD:null;
  const linked0=D&&!isNew?ctx.db.defects.filter(d=>d.work_order_id===wo.id).map(d=>d.id):((init&&init.defect_ids)||[]);
  const [dsel,setDsel]=useState(()=>new Set(linked0));
  const linkDefects=async woId=>{if(!D)return;const was=new Set(isNew?[]:ctx.db.defects.filter(d=>d.work_order_id===woId).map(d=>d.id));
    const add=[...dsel].filter(id=>!was.has(id)),drop=[...was].filter(id=>!dsel.has(id));
    if(add.length){const {error}=await sb.from('defects').update({work_order_id:woId}).in('id',add);if(error)throw error}
    if(drop.length){const {error}=await sb.from('defects').update({work_order_id:null}).in('id',drop);if(error)throw error}};
  const locked=!isNew&&(!perms.work||((wo.status==='closed'||wo.status==='cancelled')&&!perms.mgr));
  const row=()=>({wo_type:f.wo_type,plan_id:f.plan_id||null,title:f.title.trim(),description:f.description.trim()||null,priority:f.priority,assigned_to:f.assigned_to.trim()||null,
    start_date:f.start_date||null,end_date:f.end_date||f.start_date||null,parts:cleanParts(f.parts),completion_notes:f.completion_notes.trim()||null,
    ...((f.servicem8_no||'').trim()||(wo&&wo.servicem8_no)?{servicem8_no:(f.servicem8_no||'').trim()||null}:{})});
  const check=()=>{if(!f.asset_id)return 'Pick the machine.';if(!f.title.trim())return 'Give the work order a short title.';if(f.end_date&&f.start_date&&f.end_date<f.start_date)return 'The end date is before the start date.';return ''};
  const save=async status=>{const c=check();if(c){setErr(c);return}setErr('');setBusy(true);
    try{
      if(isNew){const r=row();const st=status||(r.start_date?'scheduled':'open');const {data:made,error}=await sb.from('work_orders').insert({...r,asset_id:f.asset_id,status:st}).select('id').single();if(error)throw error;
        await linkDefects(made.id);
        let sm8w='';   /* the work order is saved either way: a ServiceM8 problem is only a warning */
        if(sm8On(ctx.db)&&toSm8!==(sm8c.auto_send!==false)){const {error:e3}=await sb.rpc('servicem8_request',{p_wo:made.id,p_send:toSm8});if(e3)sm8w=' (ServiceM8: '+errMsg(e3)+')'}
        notify((dsel.size?`Work order created for ${dsel.size} defect${dsel.size===1?'':'s'}`:'Work order created')+sm8w)}
      else{const r=row();if(WO_OPEN(wo.status))await linkDefects(wo.id);const next=status||(wo.status==='open'&&r.start_date?'scheduled':wo.status);
        if(next==='completed'&&wo.status!=='completed'){
          if(!r.completion_notes)throw new Error('Add completion notes: what was done.');
          if(f.wo_type==='service'){   /* completing a service records it, which also moves its next due date */
            const {error:e1}=await sb.from('service_records').insert({asset_id:f.asset_id,plan_id:f.plan_id||null,work_order_id:wo.id,service_type:f.title.trim(),done_on:svc.done_on,hours:n0(svc.hours),km:n0(svc.km),
              mechanic:r.assigned_to,work_done:r.completion_notes,parts:r.parts});if(e1)throw e1}
          else{for(const [k,v] of [['hours',svc.hours],['km',svc.km]])if(v!==''&&a&&(k==='hours'?a.mt!=='km':a.mt!=='hours')&&(!a.cur[k]||+v>a.cur[k].value)){
            const {error:e2}=await sb.from('meter_readings').insert({asset_id:f.asset_id,kind:k,value:+v,source:'work_order',note:woNo(wo)});if(e2)throw e2}}
        }
        const upd={...r,status:next};const datesTouched=!same(f.start_date,base.current.start_date)||!same(f.end_date,base.current.end_date);
        SYNCED.forEach(k=>{if(same(f[k],base.current[k])&&!((k==='start_date'||k==='end_date')&&datesTouched))delete upd[k]});   /* don't put back what ServiceM8 changed */
        const {error}=await sb.from('work_orders').update(upd).eq('id',wo.id);if(error)throw error;
        notify(next!==wo.status?`${woNo(wo)}: ${WO_STATUS[next]}`:`${woNo(wo)} saved`)}
      sm8Flush(ctx);reload();onClose()}
    catch(e){setErr(errMsg(e))}finally{setBusy(false)}};
  const cur=isNew?null:wo.status;
  /* administrators and mechanics can delete a finished work order (its service record, readings, defects and files stay) */
  const [delAsk,setDelAsk]=useState(false);
  const delWo=async()=>{setErr('');setBusy(true);try{const {data:gone,error}=await sb.from('work_orders').delete().eq('id',wo.id).select('id');if(error)throw error;
      if(!gone||!gone.length)throw new Error('It wasn’t deleted: only completed or closed work orders, by an administrator or mechanic.');
      notify(`${woNo(wo)} deleted`);reload();onClose()}catch(e){setErr(errMsg(e));setDelAsk(false)}finally{setBusy(false)}};
  const acts=isNew?[]:[
    ...(['open','scheduled','awaiting_parts'].includes(cur)?[['in_progress',cur==='awaiting_parts'?'Resume work':'Start work']]:[]),
    ...(['open','scheduled','in_progress'].includes(cur)?[['awaiting_parts','Awaiting parts']]:[]),
    ...(['open','scheduled','in_progress','awaiting_parts'].includes(cur)?[['completed','Mark completed']]:[]),
    ...(cur==='completed'&&perms.verify?[['closed','Verify & close']]:[]),
    ...(cur==='completed'?[['in_progress','Reopen']]:[]),
    ...((cur==='closed'||cur==='cancelled')&&perms.mgr?[['open','Reopen']]:[]),
    ...(WO_OPEN(cur)?[['cancelled','Cancel work order']]:[])];
  const showSvc=!isNew&&WO_OPEN(cur)&&a;
  const assets=M.assets.filter(x=>!x.retired).sort((x,y)=>x.m.name.localeCompare(y.m.name));
  return html`<${Modal} title=${isNew?'New work order':`${woNo(wo)} · ${wo.title}`} sub=${isNew?'For servicing, a repair, a breakdown or any maintenance request':`${WO_TYPE[wo.wo_type]} · ${a?a.m.name:'Machine'} · created ${fmtTs(wo.created_at)}`} onClose=${onClose}
    foot=${html`${err&&html`<span id="wo-err" class="text-[12.5px] w-full" style=${{color:'var(--bad)'}}>${err}</span>`}
      ${!isNew&&woChip(cur)}
      ${!isNew&&perms.delWo&&(cur==='completed'||cur==='closed'||cur==='cancelled')&&(delAsk?html`<span class="text-[12.5px]">Delete ${woNo(wo)} for good?</span><button id="wo-del-yes" type="button" class="btn" style=${{color:'var(--bad)'}} disabled=${busy} onClick=${delWo}>Delete</button><button type="button" class="btn" onClick=${()=>setDelAsk(false)}>Keep</button>`
        :html`<button id="wo-del" type="button" class="btn btn-ghost" style=${{color:'var(--bad)'}} disabled=${busy} onClick=${()=>setDelAsk(true)} aria-label="Delete work order">${Icon.trash} Delete</button>`)}
      <span class="flex-1"></span>
      ${!locked&&acts.map(([s,l])=>html`<button key=${s+l} id=${'wo-act-'+s} type="button" class=${'btn'+(s==='completed'||s==='closed'?' btn-primary':'')} disabled=${busy} onClick=${()=>save(s)} style=${s==='cancelled'?{color:'var(--bad)'}:null}>${l}</button>`)}
      ${!locked&&html`<button id="wo-save" type="button" class=${'btn'+(isNew?' btn-primary':'')} disabled=${busy} onClick=${()=>save()}>${isNew?'Create work order':'Save'}</button>`}
      ${locked&&html`<button type="button" class="btn" onClick=${onClose}>Close</button>`}`}>
    <fieldset disabled=${locked} class="m-0 p-0 border-0 min-w-0 grid sm:grid-cols-2 gap-3">
      <${Fld} label="Machine">${isNew&&!(init&&init.asset_id)?html`<select id="wo-asset" class="field" style=${fs} value=${f.asset_id} onChange=${e=>setF({...f,asset_id:e.target.value})}>
          <option value="">Choose a machine…</option>${assets.map(x=>html`<option key=${x.m.id} value=${x.m.id}>${x.m.name} · ${x.m.sub||''}</option>`)}</select>`
        :html`<div class="field flex items-center" style=${fs}>${a?`${a.m.name} · ${a.m.sub||''}`:f.asset_id}</div>`}<//>
      <${Fld} label="Type"><select id="wo-type" class="field" style=${fs} value=${f.wo_type} onChange=${e=>setF({...f,wo_type:e.target.value})}>${Object.entries(WO_TYPE).map(([k,v])=>html`<option key=${k} value=${k}>${v}</option>`)}</select><//>
      <${Fld} label="Title" span=${true}><input id="wo-title" class="field" style=${fs} placeholder="e.g. 500 hr service, hydraulic hose leak" value=${f.title} onInput=${e=>setF({...f,title:e.target.value})}/><//>
      <${Fld} label="Description" span=${true}><textarea id="wo-desc" class="field" style=${{height:'auto',minHeight:64,padding:'8px 10px',fontSize:13}} rows="3" value=${f.description} onInput=${e=>setF({...f,description:e.target.value})}></textarea><//>
      ${!(wo&&(sm8Of(ctx.db,wo.id)||{}).job_no)&&html`<${Fld} label="ServiceM8 #"><input id="wo-sm8-no" class="field mono" style=${fs} placeholder="If it’s booked in ServiceM8 by hand" value=${f.servicem8_no||''} onInput=${e=>setF({...f,servicem8_no:e.target.value})}/><//>`}
      <${Fld} label="Priority"><select id="wo-pri" class="field" style=${fs} value=${f.priority} onChange=${e=>setF({...f,priority:e.target.value})}>${Object.entries(PRI).map(([k,v])=>html`<option key=${k} value=${k}>${v}</option>`)}</select><//>
      <${Fld} label="Assigned mechanic or contractor"><${Combo} id="wo-assign" className="field" style=${fs} label="Assigned to" value=${f.assigned_to} onChange=${v=>setF({...f,assigned_to:v})} options=${staff}/><//>
      <${Fld} label="Scheduled from"><input id="wo-start" type="date" class="field mono" style=${fs} value=${f.start_date} onChange=${e=>setF({...f,start_date:e.target.value,end_date:f.end_date&&f.end_date>=e.target.value?f.end_date:e.target.value})}/><//>
      <${Fld} label="Until"><input id="wo-end" type="date" class="field mono" style=${fs} value=${f.end_date} min=${f.start_date||undefined} onChange=${e=>setF({...f,end_date:e.target.value})}/><//>
      ${isNew&&sm8On(ctx.db)&&html`<label class="sm:col-span-2 flex items-center gap-2 text-[13px] cursor-pointer"><input id="wo-sm8" type="checkbox" class="w-4 h-4" checked=${toSm8} onChange=${e=>setToSm8(e.target.checked)}/>
        Send to ServiceM8${sm8c.contractor_name?` (${sm8c.contractor_name})`:''}</label>`}
      ${!isNew&&html`<${Sm8Panel} ctx=${ctx} wo=${wo}/>`}
      ${f.start_date&&html`<p class="sm:col-span-2 text-[12px] text-muted -mt-1">Scheduled dates show on the schedule board as ${f.wo_type==='service'?'a scheduled service':'a breakdown / repair'} for this machine, so it isn’t booked for jobs.</p>`}
      ${f.wo_type==='breakdown'&&f.safe_to_operate!=null&&html`<p class="sm:col-span-2 text-[12.5px] font-medium" style=${{color:f.safe_to_operate?'var(--ink)':'hsl(0 72% 47%)'}}>${f.safe_to_operate?'Reported as safe to operate.':'Reported as NOT safe to operate: shown as out of service until this is completed.'}</p>`}
      ${!isNew&&html`<div class="sm:col-span-2 grid gap-1"><span class="label">Parts replaced or used</span><${PartsEditor} parts=${f.parts} disabled=${locked} onChange=${v=>setF({...f,parts:v})}/></div>
        <${Fld} label="Completion notes" span=${true}><textarea id="wo-notes" class="field" style=${{height:'auto',minHeight:64,padding:'8px 10px',fontSize:13}} rows="3" placeholder="What was done" value=${f.completion_notes} onInput=${e=>setF({...f,completion_notes:e.target.value})}></textarea><//>`}
      ${showSvc&&html`<div class="sm:col-span-2 rounded-lg border border-line bg-sunken p-3 grid sm:grid-cols-3 gap-3">
        <div class="sm:col-span-3 text-[12.5px] text-muted">${f.wo_type==='service'?'When you mark it completed, this is saved as the service record and sets when the next one is due.':'Meters at completion (optional): saved as new readings.'}</div>
        ${f.wo_type==='service'&&html`<${Fld} label="Date done"><input id="wo-done" type="date" class="field mono" style=${fs} value=${svc.done_on} max=${iso(TODAY)} onChange=${e=>setSvc({...svc,done_on:e.target.value})}/><//>`}
        ${a.mt!=='km'&&html`<${Fld} label="Engine hours"><input id="wo-hours" type="number" min="0" step="any" class="field mono" style=${fs} value=${svc.hours} onInput=${e=>setSvc({...svc,hours:e.target.value})}/><//>`}
        ${a.mt!=='hours'&&html`<${Fld} label="Odometer km"><input id="wo-km" type="number" min="0" step="any" class="field mono" style=${fs} value=${svc.km} onInput=${e=>setSvc({...svc,km:e.target.value})}/><//>`}
      </div>`}
      ${D&&f.asset_id&&(()=>{const list=D.woDefects(ctx.db,f.asset_id,isNew?null:wo.id);const done=!isNew?ctx.db.defects.filter(d=>d.work_order_id===wo.id&&!D.OPEN(d.status)):[];
        if(!list.length&&!done.length)return null;
        return html`<div class="sm:col-span-2 grid gap-1.5" id="wo-defects"><span class="label">Defects on this work order</span>
          ${list.map(d=>html`<label key=${d.id} class="flex items-center gap-2 text-[13px] cursor-pointer"><input type="checkbox" class="w-4 h-4 wo-defect" data-no=${d.number} checked=${dsel.has(d.id)} disabled=${locked||!WO_OPEN(cur||'open')} onChange=${e=>{const s=new Set(dsel);if(e.target.checked)s.add(d.id);else s.delete(d.id);setDsel(s)}}/>
            <span class="mono text-[12px] text-muted">D-${d.number}</span><span class="flex-1 min-w-0 truncate">${d.title}</span>${D.sevChip(d.severity)}${D.stChip(d.status)}</label>`)}
          ${done.map(d=>html`<div key=${d.id} class="flex items-center gap-2 text-[13px] text-muted"><span class="mono text-[12px]">D-${d.number}</span><span class="flex-1 min-w-0 truncate">${d.title}</span>${D.stChip(d.status)}</div>`)}
          <span class="text-[12px] text-muted">Completing this work order marks its defects repaired; verifying it closes them.</span></div>`})()}
      ${!isNew&&(wo.completed_at||wo.verified_at)&&html`<div class="sm:col-span-2 text-[12px] text-muted">${wo.completed_at?`Completed ${fmtTs(wo.completed_at)}. `:''}${wo.verified_at?`Verified and closed ${fmtTs(wo.verified_at)}.`:''}</div>`}
    </fieldset>
    ${!perms.work&&html`<p class="text-[12px] text-muted mt-3">Only mechanics, supervisors and administrators can change work orders.</p>`}<//>`;
}

function BreakdownDialog({ctx,a,onClose}){
  const {sb,notify,reload,data}=ctx;
  const crewJob=(()=>{const today=iso(TODAY);const b=data.blocks.find(x=>x.kind==='job'&&x.start<=today&&x.end>=today&&(machinesOn(x,today).includes(a.m.id)||x.resourceId===a.m.crewId));
    if(!b)return '';const j=data.jobs.find(x=>x.id===b.jobId);return j?[j.customer,j.name].filter(Boolean).join(' · '):''})();
  const [f,setF]=useState({what:'',location:crewJob,safe:null,priority:'high',hours:'',km:''});const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const save=async()=>{setErr('');if(!f.what.trim()){setErr('Describe what failed.');return}if(f.safe==null){setErr('Say whether it is safe to operate.');return}setBusy(true);
    try{const first=f.what.trim().split('\n')[0];
      const {error}=await sb.from('work_orders').insert({asset_id:a.m.id,wo_type:'breakdown',assigned_to:defaultAssignee(ctx.db),title:first.length>80?first.slice(0,77)+'…':first,
        description:[f.what.trim(),f.location.trim()?'Location / job: '+f.location.trim():'',`Reported by ${window.__rosterMe?showLogin(window.__rosterMe):'someone'} at ${new Date().toLocaleString('en-AU',{dateStyle:'medium',timeStyle:'short'})}`].filter(Boolean).join('\n\n'),
        priority:f.priority,safe_to_operate:f.safe,reported_hours:n0(f.hours),reported_km:n0(f.km),start_date:f.safe?null:iso(TODAY),end_date:f.safe?null:iso(TODAY),status:f.safe?'open':'scheduled'});
      if(error)throw error;
      let warn='';for(const [k,v] of [['hours',f.hours],['km',f.km]])if(v!==''){const {error:e2}=await sb.from('meter_readings').insert({asset_id:a.m.id,kind:k,value:+v,source:'manual',note:'Breakdown report'});if(e2)warn=' (the meter reading wasn’t saved: '+errMsg(e2)+')'}
      notify('Breakdown reported'+warn);sm8Flush(ctx);reload();onClose()}
    catch(e){setErr(errMsg(e))}finally{setBusy(false)}};
  return html`<${Modal} title="Report a breakdown" sub=${`${a.m.name} · ${a.m.sub||''}`} onClose=${onClose}
    foot=${html`${err&&html`<span id="bd-err" class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="bd-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>Report breakdown</button>`}>
    <div class="grid sm:grid-cols-2 gap-3">
      <${Fld} label="What failed?" span=${true}><textarea id="bd-what" class="field" style=${{height:'auto',minHeight:80,padding:'8px 10px',fontSize:13.5}} rows="3" autoFocus=${true} placeholder="e.g. Hydraulic hose burst on the drum, oil on the mat" value=${f.what} onInput=${e=>setF({...f,what:e.target.value})}></textarea><//>
      <div class="sm:col-span-2 grid gap-1"><span class="label">Is it safe to operate?</span>
        <div class="flex gap-2"><button id="bd-safe-yes" type="button" class="btn flex-1 justify-center" style=${f.safe===true?{background:'hsl(145 50% var(--blk-l))',borderColor:'hsl(145 55% 36%)'}:null} onClick=${()=>setF({...f,safe:true})}>Yes, it can keep working</button>
          <button id="bd-safe-no" type="button" class="btn flex-1 justify-center" style=${f.safe===false?{background:'hsl(0 75% var(--blk-l))',borderColor:'hsl(0 72% 47%)'}:null} onClick=${()=>setF({...f,safe:false})}>No, take it out of service</button></div></div>
      <${Fld} label="Location or job"><input class="field" style=${fs} value=${f.location} onInput=${e=>setF({...f,location:e.target.value})}/><//>
      <${Fld} label="Urgency"><select class="field" style=${fs} value=${f.priority} onChange=${e=>setF({...f,priority:e.target.value})}>${Object.entries(PRI).map(([k,v])=>html`<option key=${k} value=${k}>${v}</option>`)}</select><//>
      ${a.mt!=='km'&&html`<${Fld} label="Engine hours (optional)"><input type="number" min="0" step="any" class="field mono" style=${fs} value=${f.hours} onInput=${e=>setF({...f,hours:e.target.value})}/><//>`}
      ${a.mt!=='hours'&&html`<${Fld} label="Odometer km (optional)"><input type="number" min="0" step="any" class="field mono" style=${fs} value=${f.km} onInput=${e=>setF({...f,km:e.target.value})}/><//>`}
    </div>
    <p class="text-[12px] text-muted mt-3">This creates a breakdown work order for the maintenance team.${' '}If it isn’t safe, the machine shows as out of service and is blocked on the schedule for today until the work order is updated.</p><//>`;
}

function PlanDialog({ctx,plan,onClose}){
  const {sb,notify,reload,data}=ctx;
  const [f,setF]=useState(()=>plan?{...plan,scope:plan.asset_id?'asset':'category',every_hours:plan.every_hours??'',every_km:plan.every_km??'',every_days:plan.every_days??'',category:plan.category||'',cats:planCatList(plan),asset_id:plan.asset_id||'',
      multi:ivsOf(plan).length>1,unit:ivUnit(plan),ivs:ivsOf(plan).length>1?ivsOf(plan).map(v=>({every:String(v.every),label:v.label||'',notes:v.notes||''})):[]}
    :{scope:'category',category:'',cats:[],asset_id:'',name:'',every_hours:'',every_km:'',every_days:'',warn_hours:50,warn_km:1000,warn_days:14,active:true,multi:false,unit:'hours',ivs:[]});
  const setIv=(i,p)=>setF(x=>({...x,ivs:x.ivs.map((v,k)=>k===i?{...v,...p}:v)}));
  const startMulti=()=>setF(x=>({...x,multi:true,ivs:x.ivs.length?x.ivs:[250,500,750,1000].map(n=>({every:String(n),label:'',notes:''}))}));
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const save=async()=>{setErr('');if(!f.name.trim()){setErr('Name the service, e.g. 250 hr service.');return}
    if(f.scope==='category'&&!f.cats.length){setErr('Pick at least one machine category.');return}if(f.scope==='asset'&&!f.asset_id){setErr('Pick the machine.');return}
    let ivs=null;
    if(f.multi){ivs=f.ivs.filter(v=>String(v.every).trim()!==''||v.label.trim()||v.notes.trim()).map(v=>({every:+v.every,label:v.label.trim(),notes:v.notes.trim()}));
      if(ivs.some(v=>!(v.every>0))){setErr('Each interval needs its '+(f.unit==='km'?'km':'hours')+'.');return}
      if(new Set(ivs.map(v=>v.every)).size!==ivs.length){setErr('Two intervals have the same '+(f.unit==='km'?'km':'hours')+'.');return}
      if(ivs.length<2){setErr('Add at least two intervals, or switch to one interval.');return}ivs.sort((a,b)=>a.every-b.every)}
    else if(f.every_hours===''&&f.every_km===''&&f.every_days===''){setErr('Set at least one interval: hours, km or days.');return}
    setBusy(true);const row={category:f.scope==='category'?f.cats[0]:null,asset_id:f.scope==='asset'?f.asset_id:null,name:f.name.trim(),
      every_hours:ivs?(f.unit==='hours'?ivs[0].every:null):n0(f.every_hours),every_km:ivs?(f.unit==='km'?ivs[0].every:null):n0(f.every_km),every_days:f.every_days===''?null:Math.round(+f.every_days),warn_hours:+f.warn_hours||0,warn_km:+f.warn_km||0,warn_days:Math.round(+f.warn_days||0),active:!!f.active};
    if(ivs||(plan&&plan.intervals))row.intervals=ivs;
    if(f.scope==='category'&&(f.cats.length>1||(plan&&Array.isArray(plan.categories))))row.categories=f.cats;else if(plan&&Array.isArray(plan.categories))row.categories=null;
    const {error}=plan?await sb.from('service_plans').update(row).eq('id',plan.id):await sb.from('service_plans').insert(row);
    setBusy(false);if(error){setErr(/intervals|categories/.test(errMsg(error))?'This needs a database update: an administrator needs to run supabase/service_intervals.sql.':errMsg(error));return}notify('Service plan saved');reload();onClose()};
  const machines=data.resources.filter(r=>r.type==='machine').sort((a,b)=>a.name.localeCompare(b.name));
  return html`<${Modal} title=${plan?'Edit service plan':'New service plan'} sub="A service due by engine hours, kilometres or time: whichever comes first" onClose=${onClose}
    foot=${html`${err&&html`<span class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="pl2-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>Save plan</button>`}>
    <div class="grid sm:grid-cols-2 gap-3">
      <${Fld} label="Applies to"><div class="seg w-max"><button type="button" aria-pressed=${f.scope==='category'} onClick=${()=>setF({...f,scope:'category'})}>A machine category</button><button type="button" aria-pressed=${f.scope==='asset'} onClick=${()=>setF({...f,scope:'asset'})}>One machine</button></div><//>
      ${f.scope==='category'?html`<div class="grid gap-1 min-w-0 sm:col-span-2"><span class="label">Categories <span class="normal-case font-normal tracking-normal text-muted">· pick one or more</span></span>
        <div class="flex flex-wrap gap-1.5" id="sp-cats">${[...new Set([...machineCatsOf(data),...f.cats])].map(c=>{const on=f.cats.some(x=>x.toLowerCase()===c.toLowerCase());
          return html`<button key=${c} type="button" aria-pressed=${on} class=${'sp-cat text-[12.5px] rounded-full border px-2.5 py-1 inline-flex items-center gap-1 '+(on?'font-semibold':'text-muted hover:text-ink')} style=${on?{background:'var(--accent-soft)',borderColor:'var(--accent)',color:'var(--accent)'}:{borderColor:'var(--line)'}}
            onClick=${()=>setF(x=>({...x,cats:on?x.cats.filter(y=>y.toLowerCase()!==c.toLowerCase()):[...x.cats,c]}))}>${on?'✓ ':''}${c}</button>`})}</div></div>`
        :html`<${Fld} label="Machine"><select id="sp-asset" class="field" style=${fs} value=${f.asset_id} onChange=${e=>setF({...f,asset_id:e.target.value})}><option value="">Choose…</option>${machines.map(m=>html`<option key=${m.id} value=${m.id}>${m.name} · ${m.sub||''}</option>`)}</select><//>`}
      <${Fld} label=${f.multi?'Plan name':'Service name'} span=${true}><input id="sp-name" class="field" style=${fs} placeholder=${f.multi?'e.g. Roller service plan':'e.g. 250 hr service, Annual inspection'} value=${f.name} onInput=${e=>setF({...f,name:e.target.value})}/><//>
      <${Fld} label="Intervals" span=${true}><div class="seg w-max" id="sp-mode"><button type="button" aria-pressed=${!f.multi} onClick=${()=>setF({...f,multi:false})}>One interval</button><button id="sp-multi" type="button" aria-pressed=${!!f.multi} onClick=${startMulti}>Several (e.g. 250 / 500 / 750 / 1000 h)</button></div><//>
      ${f.multi&&html`<div class="sm:col-span-2 grid gap-2" id="sp-ivs">
        <div class="flex flex-wrap items-center gap-2 text-[12.5px]"><span class="text-muted">Counted in</span><div class="seg w-max"><button type="button" aria-pressed=${f.unit==='hours'} onClick=${()=>setF({...f,unit:'hours'})}>Engine hours</button><button type="button" aria-pressed=${f.unit==='km'} onClick=${()=>setF({...f,unit:'km'})}>Kilometres</button></div></div>
        ${f.ivs.map((v,i)=>html`<div key=${i} class="rounded-lg border border-line p-2.5 grid gap-2 sp-iv">
          <div class="grid grid-cols-[110px_1fr_auto] gap-2 items-end"><${Fld} label=${'Every … '+(f.unit==='km'?'km':'hours')}><input type="number" min="1" step="any" class="field mono sp-iv-every" style=${fs} value=${v.every} onInput=${e=>setIv(i,{every:e.target.value})}/><//>
            <${Fld} label="Name"><input class="field sp-iv-label" style=${fs} placeholder=${v.every?`${fmtN(+v.every)} ${f.unit==='km'?'km':'h'} service`:'e.g. 500 h service'} value=${v.label} onInput=${e=>setIv(i,{label:e.target.value})}/><//>
            <button type="button" class="w-8 h-8 inline-flex items-center justify-center rounded-md text-muted hover:text-ink" aria-label="Remove this interval" onClick=${()=>setF(x=>({...x,ivs:x.ivs.filter((y,k)=>k!==i)}))}>${Icon.x}</button></div>
          <${Fld} label="Notes (what's done at this service)"><textarea class="field sp-iv-notes" rows="2" style=${{height:'auto',padding:'6px 10px',fontSize:13}} placeholder="e.g. Engine oil and filter, fuel filters, grease" value=${v.notes} onInput=${e=>setIv(i,{notes:e.target.value})}></textarea><//></div>`)}
        <div><button id="sp-iv-add" type="button" class="btn" onClick=${()=>setF(x=>({...x,ivs:[...x.ivs,{every:'',label:'',notes:''}]}))}>${Icon.plus} Add interval</button></div>
        <p class="text-[12px] text-muted">Due every ${(()=>{const xs=f.ivs.map(v=>+v.every).filter(x=>x>0);return xs.length?fmtN(Math.min(...xs)):'…'})()} ${f.unit==='km'?'km':'hours'} from the last service. Each one is the biggest interval that fits the cycle: with 250 / 500 / 750 / 1000, the services go 250, 500, 750, 1000, then 250 again at 1,250.</p></div>`}
      <div class="sm:col-span-2 grid grid-cols-3 gap-3">
        ${f.multi?html`<${Fld} label=${f.unit==='km'?'Warn … km before':'Warn … hours before'}><input type="number" min="0" class="field mono" style=${fs} value=${f.unit==='km'?f.warn_km:f.warn_hours} onInput=${e=>setF({...f,[f.unit==='km'?'warn_km':'warn_hours']:e.target.value})}/><//>
          <${Fld} label="Or every … days"><input id="sp-d" type="number" min="1" step="1" class="field mono" style=${fs} value=${f.every_days} onInput=${e=>setF({...f,every_days:e.target.value})}/><//>
          <${Fld} label="Warn … days before"><input type="number" min="0" class="field mono" style=${fs} value=${f.warn_days} onInput=${e=>setF({...f,warn_days:e.target.value})}/><//>`:html`
        <${Fld} label="Every … hours"><input id="sp-h" type="number" min="1" step="any" class="field mono" style=${fs} value=${f.every_hours} onInput=${e=>setF({...f,every_hours:e.target.value})}/><//>
        <${Fld} label="Every … km"><input id="sp-km" type="number" min="1" step="any" class="field mono" style=${fs} value=${f.every_km} onInput=${e=>setF({...f,every_km:e.target.value})}/><//>
        <${Fld} label="Every … days"><input id="sp-d" type="number" min="1" step="1" class="field mono" style=${fs} value=${f.every_days} onInput=${e=>setF({...f,every_days:e.target.value})}/><//>
        <${Fld} label="Warn … hours before"><input type="number" min="0" class="field mono" style=${fs} value=${f.warn_hours} onInput=${e=>setF({...f,warn_hours:e.target.value})}/><//>
        <${Fld} label="Warn … km before"><input type="number" min="0" class="field mono" style=${fs} value=${f.warn_km} onInput=${e=>setF({...f,warn_km:e.target.value})}/><//>
        <${Fld} label="Warn … days before"><input type="number" min="0" class="field mono" style=${fs} value=${f.warn_days} onInput=${e=>setF({...f,warn_days:e.target.value})}/><//>`}
      </div>
      <label class="inline-flex items-center gap-2 text-[13px] cursor-pointer"><input type="checkbox" class="w-4 h-4" checked=${!!f.active} onChange=${e=>setF({...f,active:e.target.checked})}/>Active</label>
    </div>
    <p class="text-[12px] text-muted mt-3">Weekly or monthly inspections: use days (7, 30). Six-monthly: 182. Annual: 365. Km only counts on machines that track km.</p><//>`;
}

/* ---------- one machine's maintenance ---------- */
/* the machine's photo on its card: loaded only when the card opens */
function shrinkPhoto(file,max=1000){return new Promise((ok,no)=>{const u=URL.createObjectURL(file);const im=new Image();
  im.onload=()=>{const k=Math.min(1,max/Math.max(im.width,im.height));const c=document.createElement('canvas');c.width=Math.round(im.width*k);c.height=Math.round(im.height*k);
    c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);ok(c.toDataURL('image/jpeg',.78))};
  im.onerror=()=>{URL.revokeObjectURL(u);no(new Error('That file isn’t a picture this phone can read.'))};im.src=u})}
function MachinePhoto({ctx,a}){
  const {sb,perms}=ctx;const id=a.m.id;const [ph,setPh]=useState(undefined);const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [big,setBig]=useState(false);
  useEffect(()=>{let off=false;setPh(undefined);(async()=>{try{const {data,error}=await sb.from('asset_photos').select('photo').eq('asset_id',id).maybeSingle();if(error)throw error;if(!off)setPh(data?data.photo:null)}catch(e){if(!off)setPh(null)}})();return()=>{off=true}},[id]);
  const add=async file=>{if(!file)return;setErr('');setBusy(true);
    try{const photo=await shrinkPhoto(file);const {error}=await sb.from('asset_photos').upsert({asset_id:id,photo});if(error)throw error;setPh(photo);ctx.notify&&ctx.notify('Photo saved')}
    catch(e){setErr(/asset_photos|relation|schema cache/.test(errMsg(e))?'Machine photos aren’t set up yet: an administrator needs to run supabase/machine_photos.sql.':errMsg(e))}finally{setBusy(false)}};
  const del=async()=>{setErr('');setBusy(true);try{const {error}=await sb.from('asset_photos').delete().eq('asset_id',id);if(error)throw error;setPh(null)}catch(e){setErr(errMsg(e))}finally{setBusy(false)}};
  const can=perms.work;
  if(ph===undefined)return html`<div class="rounded-md bg-sunken animate-pulse h-10" id="ap-photo-loading"></div>`;
  return html`<div class="grid gap-1.5" id="ap-photo">
    ${ph?html`<button type="button" class="block rounded-md overflow-hidden border border-line bg-sunken" style=${{aspectRatio:'4/3'}} onClick=${()=>setBig(true)} aria-label="View photo"><img src=${ph} alt=${a.m.name} class="w-full h-full object-cover" id="ap-photo-img"/></button>`
      :can&&html`<label class="rounded-md border border-dashed border-line-strong flex items-center justify-center gap-1.5 h-10 text-[12.5px] text-muted cursor-pointer hover:bg-sunken">${Icon.plus}<span>${busy?'Saving…':'Add a photo of the machine'}</span>
        <input id="ap-photo-file" type="file" accept="image/*" class="sr-only" disabled=${busy} onChange=${e=>{add(e.target.files[0]);e.target.value=''}}/></label>`}
    ${ph&&can&&html`<div class="flex items-center gap-3 text-[12px]"><label class="text-muted hover:text-ink cursor-pointer">${busy?'Saving…':'Change photo'}<input id="ap-photo-file" type="file" accept="image/*" class="sr-only" disabled=${busy} onChange=${e=>{add(e.target.files[0]);e.target.value=''}}/></label>
      <button id="ap-photo-del" type="button" class="text-muted hover:text-ink" disabled=${busy} onClick=${del}>Remove</button></div>`}
    ${err&&html`<div class="text-[12px]" style=${{color:'var(--bad)'}} id="ap-photo-err">${err}</div>`}
    ${big&&html`<div class="fixed inset-0 z-[80] bg-black/80 flex items-center justify-center p-4" onClick=${()=>setBig(false)}><img src=${ph} alt=${a.m.name} class="max-w-full max-h-full rounded-md"/></div>`}</div>`}

function AssetPanel({ctx,a,onClose,open,behind}){
  const {perms,data,M}=ctx;const [pdfBusy,setPdfBusy]=useState(false);
  const plans=a.plans.slice().sort((x,y)=>({overdue:0,soon:1,nobase:2,ok:3}[x.state]-{overdue:0,soon:1,nobase:2,ok:3}[y.state]));
  const recs=M.recs.filter(r=>r.asset_id===a.m.id);
  const reads=ctx.db.meter_readings.filter(r=>r.asset_id===a.m.id&&['manual','correction','replacement','work_order'].includes(r.source));
  const down=data.blocks.filter(b=>b.resourceId===a.m.id&&KINDS[b.kind]&&KINDS[b.kind].for==='machine'&&!b.fromMaintenance);
  const hist=[
    ...recs.map(r=>({ts:r.done_on===localDay(r.created_at)?r.created_at:r.done_on+'T12:00:00',ic:'svc',t:`${r.baseline?'Last service before FraserFlow: ':''}${r.service_type}`,d:[r.hours!=null&&`${fmtN(+r.hours)} h`,r.km!=null&&`${fmtN(+r.km)} km`,r.mechanic,r.work_done,(r.parts||[]).length&&'Parts: '+partsTxt(r.parts),r.notes].filter(Boolean).join(' · ')})),
    ...a.wos.flatMap(w=>[{ts:w.created_at,ic:'wo',t:`${woNo(w)} raised: ${w.title}`,d:`${WO_TYPE[w.wo_type]} · ${PRI[w.priority]}${w.wo_type==='breakdown'&&w.safe_to_operate===false?' · not safe to operate':''}`,wo:w},
      ...(w.completed_at?[{ts:w.completed_at,ic:'done',t:`${woNo(w)} completed`,d:[w.completion_notes,(w.parts||[]).length&&'Parts: '+partsTxt(w.parts)].filter(Boolean).join(' · '),wo:w}]:[]),
      ...(w.verified_at?[{ts:w.verified_at,ic:'ok',t:`${woNo(w)} verified and closed`,d:'',wo:w}]:[])]),
    ...reads.map(r=>({ts:r.read_at,ic:'meter',t:`${r.kind==='hours'?'Hours':'Km'} reading ${fmtN(+r.value)}${r.source==='correction'?' (correction)':r.source==='replacement'?' (new meter)':''}`,d:r.note||''})),
    ...(ctx.db.prestarts||[]).filter(p=>p.asset_id===a.m.id&&p.result!=='pass').map(p=>({ts:p.submitted_at,ic:p.result==='unsafe'?'unsafe':'ps',t:`Prestart by ${p.operator_name}: ${p.result==='unsafe'?'do not operate':'defects reported'}`,d:`${p.failed} item${p.failed===1?'':'s'} failed`,ps:p})),
    ...(ctx.db.defects||[]).filter(d=>d.asset_id===a.m.id).flatMap(d=>[{ts:d.created_at,ic:d.severity==='critical'?'unsafe':'ps',t:`D-${d.number} reported: ${d.title}`,d:`${d.severity} · by ${d.reported_name}${d.times_reported>1?` · seen ${d.times_reported} times`:''}`,df:d},
      ...(d.closed_at?[{ts:d.closed_at,ic:d.status==='dismissed'?'meter':'ok',t:`D-${d.number} ${d.status==='dismissed'?'dismissed':'repair verified'}`,d:d.resolution||'',df:d}]:[])]),
    ...(ctx.db.restrictions||[]).filter(r=>r.asset_id===a.m.id&&r.released_at).map(r=>({ts:r.released_at,ic:'ok',t:'Returned to service',d:[r.reason,r.release_note].filter(Boolean).join(' · ')})),
    ...down.map(b=>({ts:b.start+'T00:00:00',ic:'down',t:`${KINDS[b.kind].label}${b.title?': '+b.title:''}`,d:`On the schedule ${fmtShort(parse(b.start))}${b.end!==b.start?' – '+fmtShort(parse(b.end)):''}`}))
  ].map(h=>({...h,at:localDay(h.ts),t0:new Date(h.ts).getTime()})).sort((x,y)=>y.t0-x.t0);   /* newest first, by when it actually happened */
  const IC={svc:'hsl(145 55% 36%)',wo:'var(--accent)',done:'hsl(212 75% 48%)',ok:'hsl(145 55% 36%)',meter:'var(--faint)',down:'hsl(252 60% 55%)',ps:'hsl(30 90% 46%)',unsafe:'hsl(0 72% 47%)'};
  const p=a.p||{};
  return html`<${Modal} wide=${true} noEsc=${behind} title=${html`<span class="inline-flex items-center gap-2 flex-wrap">${a.m.name} <span class="text-muted font-normal text-[15px]">${a.m.sub||''}</span> ${stChip(a.status)}</span>`}
    sub=${[machCatOf(a.m)||'No category',a.m.rego&&'Rego '+a.m.rego,a.crew&&a.crew.name,a.retired&&'Retired'].filter(Boolean).join(' · ')} onClose=${onClose}
    foot=${html`${window.FFR&&html`<button id="ap-pdf" type="button" class="btn" disabled=${!!pdfBusy} onClick=${async()=>{setPdfBusy(true);try{await window.FFR.machinePdf(ctx,a)}catch(e){ctx.notify(errMsg(e))}finally{setPdfBusy(false)}}}>${Icon.download} ${pdfBusy?'Making PDF…':'History PDF'}</button>`}<span class="text-[12px] text-muted mr-auto">${a.open.length} open work order${a.open.length===1?'':'s'}</span>
      ${perms.work&&html`<button id="ap-breakdown" type="button" class="btn" style=${{color:'hsl(0 72% 47%)'}} onClick=${()=>open({k:'breakdown',a})}>${Icon.alert} Report breakdown</button>
        <button id="ap-newwo" type="button" class="btn btn-primary" onClick=${()=>open({k:'wo',init:{asset_id:a.m.id}})}>${Icon.plus} Work order</button>`}`}>
    <div class="grid gap-4">
      ${window.FFD&&html`<${window.FFD.RestrictionBanner} ctx=${ctx} a=${a}/>`}
      <div class="grid gap-3 md:grid-cols-3">
        <section class="rounded-lg border border-line p-3 grid gap-1 content-start">
          <div class="flex items-center gap-2"><span class="label flex-1">Machine details</span>${(perms.work||ctx.canEdit)&&html`<button id="ap-profile" type="button" class="text-[12px] text-muted hover:text-ink inline-flex items-center gap-1" onClick=${()=>open({k:'machine',a})}>${Icon.pencil} Edit</button>`}</div>
          <${MachinePhoto} key=${a.m.id} ctx=${ctx} a=${a}/>
          ${[['Make / model',[p.make,p.model].filter(Boolean).join(' ')],['Year',p.year],['Serial',p.serial],['Meters',a.mt==='both'?'Hours and km':a.mt==='km'?'Kilometres':'Engine hours'],['Notes',p.notes]].map(([k,v])=>html`<div key=${k} class="flex gap-2 text-[12.5px]"><span class="text-muted w-[92px] shrink-0">${k}</span><span class=${v?'':'text-faint'}>${v||'–'}</span></div>`)}
        </section>
        <section class="rounded-lg border border-line p-3 grid gap-1 content-start">
          <div class="flex items-center gap-2"><span class="label flex-1">Meters</span>${perms.work&&html`<button id="ap-reading" type="button" class="text-[12px] text-muted hover:text-ink inline-flex items-center gap-1" onClick=${()=>open({k:'reading',a})}>${Icon.plus} Reading</button>`}</div>
          ${a.mt!=='km'&&html`<div class="font-display text-[20px] font-semibold tnum">${a.cur.hours?fmtN(a.cur.hours.value)+' h':'–'}</div><div class="text-[11.5px] text-muted -mt-1">${a.cur.hours?'read '+fmtTs(a.cur.hours.at):'no hours reading yet'}</div>`}
          ${a.mt!=='hours'&&html`<div class="font-display text-[20px] font-semibold tnum">${a.cur.km?fmtN(a.cur.km.value)+' km':'–'}</div><div class="text-[11.5px] text-muted -mt-1">${a.cur.km?'read '+fmtTs(a.cur.km.at):'no km reading yet'}</div>`}
          <div class="text-[12px] mt-1" id="ap-use"><span class="text-muted">Average:</span> ${(a.use.hours||a.use.km)?useTxt(a):html`<span class="text-faint">needs two readings 30+ days apart</span>`}</div>
        </section>
        <section class="rounded-lg border border-line p-3 grid gap-1 content-start">
          <span class="label">Next service</span>
          ${a.next?html`<div class="font-display text-[16px] font-semibold">${svcName(a.next)}</div>${a.next.stage&&a.next.stage.notes&&html`<div class="text-[12px] text-muted whitespace-pre-line" id="ap-next-notes">${a.next.stage.notes}</div>`}<div class="text-[12.5px]">${planChip(a.next.state)} <span class="text-muted">${a.next.first.dueTxt} · ${a.next.first.leftTxt}</span></div>`
            :html`<div class="text-[12.5px] text-muted">${a.plans.length?'Record the last service to start tracking.':'No service plan for this category yet.'}</div>`}
          <div class="text-[11.5px] text-muted mt-1">Last service: ${a.last?`${a.last.service_type}, ${fmtTs(a.last.done_on)}`:'none recorded'}</div>
        </section>
      </div>

      <section class="grid gap-2"><div class="flex items-baseline gap-2"><h3 class="font-display text-[15px] font-semibold">Service schedule</h3><span class="text-[12px] text-muted">From the service plans for ${machCatOf(a.m)||'this machine'}${perms.mgr?'. Change plans on the Service plans tab':''}</span></div>
        ${!plans.length?html`<div class="text-[12.5px] text-muted">No service plans apply to this machine.${perms.mgr?' Add one on the Service plans tab.':''}</div>`
          :html`<div class="rounded-lg border border-line divide-y" style=${{borderColor:'var(--line)'}}>${plans.map(x=>{const hasWo=a.open.some(w=>w.plan_id===x.plan.id);
            return html`<div key=${x.plan.id} class="px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1" style=${{borderColor:'var(--line)'}}>
              <div class="min-w-[180px] flex-1"><div class="text-[13.5px] font-medium">${x.plan.name} ${planChip(x.state)}</div>
                ${x.stage&&html`<div class="text-[12.5px] ap-stage"><span class="text-muted">Next:</span> <span class="font-medium">${x.stage.label}</span>${x.stage.notes&&html`<div class="text-[12px] text-muted whitespace-pre-line">${x.stage.notes}</div>`}</div>`}
                <div class="text-[12px] text-muted">${ivTxt(x.plan)?`${ivTxt(x.plan)} cycle${x.plan.every_days?` or every ${x.plan.every_days} days`:''}`:[x.plan.every_hours&&`every ${fmtN(+x.plan.every_hours)} h`,x.plan.every_km&&`every ${fmtN(+x.plan.every_km)} km`,x.plan.every_days&&`every ${x.plan.every_days} days`].filter(Boolean).join(' or ')}${x.plan.asset_id?' · this machine only':''}</div></div>
              <div class="text-[12.5px] min-w-[200px]">${x.state==='nobase'?html`<span class="text-muted">${x.last?'The last service has no matching hours or km':'When was it last done?'}</span>`
                :x.parts.map(pt=>html`<div key=${pt.k}><span class="text-muted">Due</span> ${pt.dueTxt} <span class=${pt.left!=null&&pt.left<=0?'font-semibold':'text-muted'} style=${pt.left!=null&&pt.left<=0?{color:'hsl(0 72% 47%)'}:null}>· ${pt.leftTxt}</span></div>`)}</div>
              ${perms.work&&html`<div class="flex gap-2">
                ${x.state==='nobase'&&html`<button type="button" class="btn" style=${{height:30}} onClick=${()=>open({k:'service',a,plan:x.plan,baseline:true})}>Set last service</button>`}
                ${x.state!=='nobase'&&!hasWo&&html`<button type="button" class="btn" style=${{height:30}} onClick=${()=>open({k:'wo',init:{asset_id:a.m.id,wo_type:'service',plan_id:x.plan.id,title:svcName(x),...(x.stage&&x.stage.notes?{description:x.stage.notes}:{}),priority:x.state==='overdue'?'high':'medium'}})}>Create work order</button>`}
                ${hasWo&&html`<span class="text-[12px] text-muted self-center">Work order open</span>`}
                <button type="button" class="btn" style=${{height:30}} onClick=${()=>open({k:'service',a,plan:x.plan})}>Record service</button></div>`}
            </div>`})}</div>`}
      </section>

      <${ReadingsHistory} a=${a} ctx=${ctx}/>

      ${a.open.length>0&&html`<section class="grid gap-2"><h3 class="font-display text-[15px] font-semibold">Open work orders</h3>
        <div class="rounded-lg border border-line divide-y" style=${{borderColor:'var(--line)'}}>${a.open.map(w=>html`<button key=${w.id} type="button" class="w-full text-left px-3 py-2 flex flex-wrap items-center gap-2 hover:bg-sunken" style=${{borderColor:'var(--line)'}} onClick=${()=>open({k:'wo',wo:w})}>
          <span class="mono text-[12px] text-muted">${woNo(w)}</span><span class="text-[13px] font-medium flex-1 min-w-0 truncate">${w.title}</span>${woChip(w.status)}<span class="text-[12px]" style=${{color:PRI_COL[w.priority]}}>${PRI[w.priority]}</span>
          ${w.start_date&&html`<span class="text-[12px] text-muted mono">${fmtShort(parse(w.start_date))}</span>`}</button>`)}</div></section>`}

      ${window.FFD&&html`<${window.FFD.AssetDefects} ctx=${ctx} a=${a} open=${open}/>`}
      ${window.FFP&&html`<${window.FFP.AssetPrestarts} ctx=${ctx} a=${a} open=${open}/>`}

      <section class="grid gap-2"><h3 class="font-display text-[15px] font-semibold">Maintenance history</h3>
        ${!hist.length?html`<div class="text-[12.5px] text-muted">Nothing recorded yet.</div>`:html`<ol class="grid gap-0 relative">${hist.map((h,i)=>html`<li key=${i} class="grid grid-cols-[86px_14px_1fr] gap-2 text-[12.5px] py-1.5">
            <span class="mono text-muted">${fmtShort(parse(h.at))} ${parse(h.at).getFullYear()!==TODAY.getFullYear()?parse(h.at).getFullYear():''}</span>
            <span class="mt-1 w-2.5 h-2.5 rounded-full" style=${{background:IC[h.ic]}}></span>
            <span class="min-w-0">${h.df?html`<button type="button" class="font-medium text-left hover:underline" onClick=${()=>open({k:'defect',d:h.df})}>${h.t}</button>`:h.ps?html`<button type="button" class="font-medium text-left hover:underline" onClick=${()=>open({k:'ps',ps:h.ps})}>${h.t}</button>`:h.wo?html`<button type="button" class="font-medium text-left hover:underline" onClick=${()=>open({k:'wo',wo:h.wo})}>${h.t}</button>`:html`<span class="font-medium">${h.t}</span>`}${h.d&&html`<span class="block text-muted whitespace-pre-line">${h.d}</span>`}</span></li>`)}</ol>`}
      </section>

      ${window.FFP&&ctx.db.p3?html`<${window.FFP.FilesSection} ctx=${ctx} a=${a}/>`:html`<section class="rounded-lg border border-dashed border-line p-3"><div class="label">Manuals and documents</div><div class="text-[12.5px] text-muted mt-1">Arrives once supabase/prestarts.sql has been run.</div></section>`}
    </div><//>`;
}

/* ---------- tabs ---------- */
function Dashboard({ctx,open}){
  const {M,data,perms}=ctx;
  const [cat,setCat]=useState('');const [crew,setCrew]=useState('');const [st,setSt]=useState('');const [q,setQ]=useState('');
  const act=M.assets.filter(a=>!a.retired);
  const openWos=ctx.db.work_orders.filter(w=>WO_OPEN(w.status));
  const cnt=s=>act.filter(a=>a.status===s).length;
  const cards=[['Active machines',act.length,'',''],['Available for work',cnt('ok')+cnt('due'),'Operational or due soon','hsl(145 55% 36%)'],['Being serviced',cnt('service'),'In progress or down today','hsl(212 75% 48%)'],['Out of service',cnt('out'),'Restricted or unsafe','hsl(0 72% 47%)'],
    ['Services due soon',act.reduce((s,a)=>s+a.soon,0),'Within the warning window','hsl(30 90% 46%)'],['Overdue services',act.reduce((s,a)=>s+a.overdue,0),'',act.some(a=>a.overdue)?'hsl(0 72% 47%)':''],
    ['Open work orders',openWos.length,`${openWos.filter(w=>w.priority==='urgent'||w.priority==='high').length} high or urgent`,''],
    ...(ctx.db.p3?(()=>{const wk=iso(addDays(TODAY,-6));const ps=ctx.db.prestarts;const td=ps.filter(p=>localDay(p.submitted_at)===M.today);const bad=ps.filter(p=>p.result!=='pass'&&localDay(p.submitted_at)>=wk);
      return [['Prestarts today',td.length,`${new Set(td.map(p=>p.asset_id)).size} of ${act.length} machines checked`,''],...(ctx.db.p4?[]:[['Prestart defects',bad.length,'Prestarts with faults, last 7 days',bad.length?'hsl(30 90% 46%)':'']])]})()
      :[['Prestart defects','–','Prestarts aren’t set up yet','']]),
    ...(ctx.db.p4?(()=>{const od=ctx.db.defects.filter(d=>!['closed','dismissed'].includes(d.status));const cr=od.filter(d=>d.severity==='critical');
      return [['Open defects',od.length,`${od.filter(d=>!d.work_order_id).length} without a work order`,od.length?'hsl(30 90% 46%)':''],['Critical defects',cr.length,`${ctx.db.restrictions.filter(r=>r.active).length} restriction${ctx.db.restrictions.filter(r=>r.active).length===1?'':'s'} in place`,cr.length?'hsl(0 72% 47%)':'']]})()
      :[['Critical defects','–','Arrives with defects','']])];
  const ql=q.trim().toLowerCase();
  const rank={out:0,service:1,due:2,ok:3};
  const list=act.filter(a=>(!cat||machCatOf(a.m).toLowerCase()===cat.toLowerCase())&&(!crew||(crew==='~'?!a.m.crewId:a.m.crewId===crew))&&(!st||a.status===st)&&(!ql||[a.m.name,a.m.sub,a.m.rego,a.p&&a.p.make,a.p&&a.p.model].join(' ').toLowerCase().includes(ql)))
    .sort((x,y)=>rank[x.status]-rank[y.status]||y.overdue-x.overdue||x.m.name.localeCompare(y.m.name));
  const attention=act.flatMap(a=>a.plans.filter(x=>x.state==='overdue'||x.state==='soon').map(x=>({a,x}))).sort((u,v)=>(u.x.state==='overdue'?0:1)-(v.x.state==='overdue'?0:1));
  const crews=data.resources.filter(r=>r.type==='crew');
  return html`<div class="grid gap-3">
    <div class="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-10">${cards.map(([k,v,s,c])=>html`<div key=${k} class="panel px-3 py-2.5 min-w-0"><div class="label leading-tight">${k}</div><div class="font-display text-[22px] font-semibold tnum" style=${c?{color:c}:null}>${v}</div>${s&&html`<div class="text-[11px] text-muted truncate" title=${s}>${s}</div>`}</div>`)}</div>
    ${attention.length>0&&html`<section class="panel p-3 grid gap-2" aria-label="Services needing attention"><div class="flex items-baseline gap-2"><h3 class="font-display text-[15px] font-semibold">Services needing attention</h3><span class="text-[12px] text-muted">${attention.length}</span></div>
      <div class="grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">${attention.slice(0,12).map(({a,x})=>{const hasWo=a.open.some(w=>w.plan_id===x.plan.id);
        return html`<div key=${a.m.id+x.plan.id} class="rounded-lg border border-line px-3 py-2 flex items-center gap-2">
          <button type="button" class="min-w-0 flex-1 text-left" onClick=${()=>open({k:'asset',id:a.m.id})}><div class="text-[13px] font-medium truncate">${a.m.name} · ${svcName(x)}</div><div class="text-[12px] text-muted truncate">${planChip(x.state)} ${x.first.dueTxt} · ${x.first.leftTxt}</div></button>
          ${hasWo?html`<span class="text-[11.5px] text-muted">WO open</span>`:perms.work&&html`<button type="button" class="btn" style=${{height:28,fontSize:12}} onClick=${()=>open({k:'wo',init:{asset_id:a.m.id,wo_type:'service',plan_id:x.plan.id,title:svcName(x),...(x.stage&&x.stage.notes?{description:x.stage.notes}:{}),priority:x.state==='overdue'?'high':'medium'}})}>Work order</button>`}</div>`})}</div></section>`}
    <section class="panel flex flex-col min-h-0">
      <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line">
        <input id="fl-search" class="field" style=${{...fs,width:220}} placeholder="Search machine, rego, make" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search machines"/>
        <select id="fl-cat" class="field w-auto" style=${fs} value=${cat} onChange=${e=>setCat(e.target.value)} aria-label="Category"><option value="">All categories</option>${machineCatsOf(data).map(c=>html`<option key=${c} value=${c}>${c}</option>`)}</select>
        <select id="fl-crew" class="field w-auto" style=${fs} value=${crew} onChange=${e=>setCrew(e.target.value)} aria-label="Crew"><option value="">All crews</option>${crews.map(c=>html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}<option value="~">No crew</option></select>
        <select id="fl-status" class="field w-auto" style=${fs} value=${st} onChange=${e=>setSt(e.target.value)} aria-label="Status"><option value="">All statuses</option>${Object.entries(ST).map(([k,v])=>html`<option key=${k} value=${k}>${v[0]}</option>`)}</select>
        <span class="flex-1"></span>
        <span class="hidden lg:inline-flex items-center gap-3 text-[11.5px] text-muted">${Object.entries(ST).map(([k,v])=>html`<span key=${k} class="inline-flex items-center gap-1">${stDot(k,8)} ${v[0]}</span>`)}</span>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="fl-table">
        <thead><tr class="text-left">${['','Machine','Category','Rego','Meters','Avg / year','Next service','Work orders & defects',...(ctx.db.p3?['Last prestart']:[])].map(h=>html`<th key=${h} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
        <tbody>${list.map(a=>html`<tr key=${a.m.id} class="border-t border-line cursor-pointer hover:bg-sunken" tabindex="0" onClick=${()=>open({k:'asset',id:a.m.id})} onKeyDown=${e=>{if(e.key==='Enter')open({k:'asset',id:a.m.id})}}>
            <td class="py-2 pl-3 pr-1">${stDot(a.status)}</td>
            <td class="py-2 px-3"><div class="font-medium">${a.m.name}</div><div class="text-[11.5px] text-muted truncate max-w-[240px]">${a.m.sub||''}${a.p&&(a.p.make||a.p.model)?' · '+[a.p.make,a.p.model].filter(Boolean).join(' '):''}</div></td>
            <td class="py-2 px-3 whitespace-nowrap">${machCatOf(a.m)||html`<span class="text-faint">–</span>`}</td>
            <td class="py-2 px-3 mono whitespace-nowrap">${a.m.rego||html`<span class="text-faint">–</span>`}</td>
            <td class="py-2 px-3 mono tnum whitespace-nowrap">${meterTxt(a)}</td>
            <td class="py-2 px-3 tnum whitespace-nowrap fl-use" title=${(['hours','km'].map(k=>a.use[k]&&`${k==='hours'?'Hours':'Km'}: ${fmtN(+a.use[k].from.value)} → ${fmtN(+a.use[k].to.value)} over ${Math.round(a.use[k].days)} days (${a.use[k].n} readings)`).filter(Boolean).join('\n'))||'Needs two readings at least 30 days apart'}>${(a.use.hours||a.use.km)?useTxt(a):html`<span class="text-faint">–</span>`}</td>
            <td class="py-2 px-3">${a.next?html`<div class="whitespace-nowrap">${svcName(a.next)} ${planChip(a.next.state)}</div><div class="text-[11.5px] text-muted whitespace-nowrap">${a.next.first.dueTxt} · ${a.next.first.leftTxt}</div>`:html`<span class="text-faint">${a.plans.length?'Last service not set':'No plan'}</span>`}</td>
            <td class="py-2 px-3 whitespace-nowrap">${a.open.length?html`<span class="font-medium">${a.open.length} open</span>`:html`<span class="text-faint">–</span>`}${a.restr.length?html` <span class="text-[10.5px] font-bold uppercase tracking-wide px-1 rounded" style=${{background:'hsl(0 72% 47%)',color:'#fff'}} title="Restricted: must not be used">Restricted</span>`:a.defects.length?html` <span class="text-[11.5px] text-muted">· ${a.defects.length} defect${a.defects.length===1?'':'s'}</span>`:''}</td>
            ${ctx.db.p3&&html`<td class="py-2 px-3 whitespace-nowrap">${a.ps?html`<span class="inline-flex items-center gap-1.5"><span class="inline-block w-2 h-2 rounded-full" style=${{background:window.FFP?window.FFP.RES[a.ps.result][1]:'var(--muted)'}}></span>${localDay(a.ps.submitted_at)===M.today?new Date(a.ps.submitted_at).toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'}):fmtShort(new Date(a.ps.submitted_at))}${a.ps.result!=='pass'?html` <span class="text-[11px] font-semibold" style=${{color:window.FFP?window.FFP.RES[a.ps.result][1]:''}}>${a.ps.result==='unsafe'?'do not operate':a.ps.failed+' failed'}</span>`:''}</span>`:html`<span class="text-faint">–</span>`}</td>`}</tr>`)}
          ${!list.length&&html`<tr><td colspan="9" class="px-3 py-6 text-center text-muted">No machines match.</td></tr>`}</tbody></table></div>
    </section>
  </div>`;
}

function WorkOrders({ctx,open}){
  const {M,perms}=ctx;
  useEffect(()=>{if(perms.work)sm8Flush(ctx)},[]);   /* catch up on anything ServiceM8 didn't report */const [view,setView]=useState('open');const [q,setQ]=useState('');
  const ql=q.trim().toLowerCase();
  const rows=ctx.db.work_orders.filter(w=>(view==='all'||(view==='open'?WO_OPEN(w.status):!WO_OPEN(w.status)))).filter(w=>{const a=M.byId.get(w.asset_id);return !ql||[w.number,w.servicem8_no,(sm8Of(ctx.db,w.id)||{}).job_no,w.title,w.assigned_to,a&&a.m.name,a&&a.m.rego].join(' ').toLowerCase().includes(ql)})
    .sort((a,b)=>view==='open'?(['urgent','high','medium','low'].indexOf(a.priority)-['urgent','high','medium','low'].indexOf(b.priority))||(a.start_date||'9').localeCompare(b.start_date||'9')||b.number-a.number:b.number-a.number);
  return html`<section class="panel flex flex-col min-h-0">
    <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line">
      <div class="seg" role="group" aria-label="Show"><button type="button" aria-pressed=${view==='open'} onClick=${()=>setView('open')}>Open</button><button type="button" aria-pressed=${view==='done'} onClick=${()=>setView('done')}>Completed & closed</button><button type="button" aria-pressed=${view==='all'} onClick=${()=>setView('all')}>All</button></div>
      <input id="wo-search" class="field" style=${{...fs,width:220}} placeholder="Search FF #, ServiceM8 #, rego, machine…" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search work orders"/>
      <span class="flex-1"></span>${perms.mgr&&ctx.db.sm8&&html`<button id="wo-sm8-settings" type="button" class="btn" onClick=${()=>open({k:'sm8'})}>ServiceM8${sm8On(ctx.db)?'':' (off)'}</button>`}${perms.work&&html`<button id="wo-new" type="button" class="btn btn-primary" onClick=${()=>open({k:'wo'})}>${Icon.plus} New work order</button>`}
    </div>
    <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="wo-table">
      <thead><tr class="text-left">${['FF #','ServiceM8 #','Machine','Rego','Type','Title','Priority','Status','Assigned','Scheduled'].map(h=>html`<th key=${h} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
      <tbody>${rows.map(w=>{const a=M.byId.get(w.asset_id);return html`<tr key=${w.id} class="border-t border-line cursor-pointer hover:bg-sunken" tabindex="0" onClick=${()=>open({k:'wo',wo:w})} onKeyDown=${e=>{if(e.key==='Enter')open({k:'wo',wo:w})}}>
          <td class="py-2 px-3 mono whitespace-nowrap">${w.number}</td>
          <td class="py-2 px-3 mono whitespace-nowrap wo-sm8">${(sm8Of(ctx.db,w.id)||{}).job_no||w.servicem8_no||html`<span class="text-faint">–</span>`}</td>
          <td class="py-2 px-3 whitespace-nowrap">${a?html`<span class="inline-flex items-center gap-1.5">${stDot(a.status,8)} ${a.m.name}</span>`:w.asset_id}</td>
          <td class="py-2 px-3 mono whitespace-nowrap wo-rego">${a&&a.m.rego||html`<span class="text-faint">–</span>`}</td>
          <td class="py-2 px-3 whitespace-nowrap">${WO_TYPE[w.wo_type]}${w.wo_type==='breakdown'&&w.safe_to_operate===false?html` <span class="text-[11px] font-semibold" style=${{color:'hsl(0 72% 47%)'}}>unsafe</span>`:''}</td>
          <td class="py-2 px-3 min-w-[200px]">${w.title}</td>
          <td class="py-2 px-3 whitespace-nowrap font-medium" style=${{color:PRI_COL[w.priority]}}>${PRI[w.priority]}</td>
          <td class="py-2 px-3 whitespace-nowrap">${woChip(w.status)}</td>
          <td class="py-2 px-3 whitespace-nowrap">${w.assigned_to||html`<span class="text-faint">–</span>`}${sm8Mark(sm8Of(ctx.db,w.id))}</td>
          <td class="py-2 px-3 mono whitespace-nowrap">${w.start_date?`${fmtShort(parse(w.start_date))}${w.end_date&&w.end_date!==w.start_date?' – '+fmtShort(parse(w.end_date)):''}`:html`<span class="text-faint">–</span>`}</td></tr>`})}
        ${!rows.length&&html`<tr><td colspan="10" class="px-3 py-6 text-center text-muted">${view==='open'?'No open work orders.':'Nothing here yet.'}</td></tr>`}</tbody></table></div>
  </section>`;
}

/* every meter reading for a machine: a small chart per meter, and the list */
const SRC={manual:'Entered',service:'Service',prestart:'Prestart',work_order:'Work order',correction:'Correction',replacement:'New meter'};
function ReadingsChart({rs,unit}){
  const W=600,H=110,P=6;const pts=rs.map(r=>({t:new Date(r.read_at).getTime(),v:+r.value,r}));
  const t0=pts[0].t,t1=pts[pts.length-1].t||t0+1,v0=Math.min(...pts.map(p=>p.v)),v1=Math.max(...pts.map(p=>p.v));
  const x=t=>P+(t1===t0?W/2:(t-t0)/(t1-t0)*(W-2*P)),y=v=>H-P-(v1===v0?(H-2*P)/2:(v-v0)/(v1-v0)*(H-2*P));
  return html`<svg viewBox=${`0 0 ${W} ${H}`} class="w-full h-[110px] block" preserveAspectRatio="none" role="img" aria-label=${`${unit==='h'?'Hours':'Km'} readings over time`}>
    <polyline fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" points=${pts.map(p=>`${x(p.t)},${y(p.v)}`).join(' ')}/>
    ${pts.map((p,i)=>html`<circle key=${i} cx=${x(p.t)} cy=${y(p.v)} r="3" fill="var(--surface)" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"><title>${fmtTs(p.r.read_at)}: ${fmtN(p.v)} ${unit}</title></circle>`)}</svg>`;
}
function ReadingsHistory({a,ctx}){
  const canDel=!!(ctx&&ctx.perms&&ctx.perms.mgr);const [del,setDel]=useState(null);const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const remove=async r=>{setBusy(true);setErr('');try{const {error}=await ctx.sb.from('meter_readings').delete().eq('id',r.id);if(error)throw error;
      ctx.notify&&ctx.notify('Reading deleted');setDel(null);ctx.reload&&ctx.reload()}catch(e){setErr(/permission|policy|42501/.test(errMsg(e)+(e.code||''))?'Deleting readings needs a database update: an administrator needs to run supabase/maintenance.sql again.':errMsg(e))}finally{setBusy(false)}};
  const kinds=['hours','km'].filter(k=>a.reads[k].length&&(a.mt==='both'||a.mt===k||a.reads[k].length));
  const [k,setK]=useState(kinds[0]||'hours');const [all,setAll]=useState(false);
  const kk=kinds.includes(k)?k:kinds[0];
  if(!kk)return html`<section class="grid gap-2" id="ap-readings"><h3 class="font-display text-[15px] font-semibold">Meter readings</h3><div class="text-[12.5px] text-muted">No readings yet. Readings come from prestarts, services and the + Reading button.</div></section>`;
  const rs=a.reads[kk];const unit=kk==='hours'?'h':'km';const desc=[...rs].reverse();const shown=all?desc:desc.slice(0,8);const u=a.use[kk];
  return html`<section class="grid gap-2" id="ap-readings">
    <div class="flex flex-wrap items-center gap-2"><h3 class="font-display text-[15px] font-semibold">Meter readings</h3><span class="text-[12px] text-muted">${rs.length} reading${rs.length===1?'':'s'}${u?` · average ${perYrTxt(a,kk)} over ${u.days>=730?Math.round(u.days/365.25)+' years':Math.round(u.days/30.4)+' months'}`:''}</span>
      <span class="flex-1"></span>${kinds.length>1&&html`<div class="seg"><button type="button" aria-pressed=${kk==='hours'} onClick=${()=>setK('hours')}>Hours</button><button type="button" aria-pressed=${kk==='km'} onClick=${()=>setK('km')}>Km</button></div>`}</div>
    <div class="rounded-lg border border-line p-2">${rs.length>1?html`<${ReadingsChart} rs=${rs} unit=${unit}/>`:html`<div class="text-[12px] text-muted p-2">One reading so far. The chart starts with the second.</div>`}</div>
    <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="ap-read-table"><thead><tr class="text-left">${[...['Date','Reading','Change','Source','Note'],...(canDel?['']:[])].map((h,i)=>html`<th key=${i} class="label font-normal py-1.5 px-2 whitespace-nowrap">${h}</th>`)}</tr></thead>
      <tbody>${shown.map((r,i)=>{const prev=desc[desc.indexOf(r)+1];const ch=prev&&r.source!=='replacement'?+r.value- +prev.value:null;
        return html`<tr key=${r.id||i} class="border-t border-line"><td class="py-1.5 px-2 whitespace-nowrap">${fmtTs(r.read_at)}</td><td class="py-1.5 px-2 tnum whitespace-nowrap font-medium">${fmtN(+r.value)} ${unit}</td>
          <td class="py-1.5 px-2 tnum whitespace-nowrap text-muted">${ch==null?'–':(ch>=0?'+':'')+fmtN(ch)}</td><td class="py-1.5 px-2 whitespace-nowrap">${SRC[r.source]||r.source}</td><td class="py-1.5 px-2 text-muted">${r.note||''}</td>
          ${canDel&&html`<td class="py-1 px-2 text-right whitespace-nowrap ap-read-del">${del===r.id?html`<span class="inline-flex items-center gap-2"><span class="text-[12px]" style=${{color:'var(--bad)'}}>Delete this reading?</span>
              <button type="button" class="text-[12px] font-semibold ap-read-del-go" style=${{color:'var(--bad)'}} disabled=${busy} onClick=${()=>remove(r)}>${busy?'Deleting…':'Delete'}</button><button type="button" class="text-[12px] text-muted" onClick=${()=>setDel(null)}>Keep</button></span>`
            :html`<button type="button" class="p-1 rounded text-muted hover:text-ink ap-read-x" aria-label=${'Delete the reading '+fmtN(+r.value)+' '+unit+' from '+fmtTs(r.read_at)} title="Delete this reading" onClick=${()=>{setDel(r.id);setErr('')}}>${Icon.trash}</button>`}</td>`}</tr>`})}</tbody></table></div>
    ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}} id="ap-read-err">${err}</div>`}
    ${desc.length>8&&html`<div><button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>setAll(!all)}>${all?'Show fewer':`Show all ${desc.length}`}</button></div>`}
  </section>`;
}

/* Machines: the fleet list, added, changed and removed here (they are the schedule's machine rows) */
function MachinesTab({ctx,open}){
  const {M,data,perms,canEdit}=ctx;
  const [q,setQ]=useState('');const [cat,setCat]=useState('');const [ret,setRet]=useState(false);const [dlg,setDlg]=useState(null);
  const ql=q.trim().toLowerCase();const nRet=M.assets.filter(a=>a.retired).length;
  const hit=a=>(ret||!a.retired)&&(!cat||machCatOf(a.m).toLowerCase()===cat.toLowerCase())&&(!ql||[a.m.name,a.m.sub,a.m.rego,machCatOf(a.m),a.crew&&a.crew.name,a.p&&a.p.make,a.p&&a.p.model,a.p&&a.p.serial].join(' ').toLowerCase().includes(ql));
  const shown=data.resources.filter(r=>r.type==='machine').filter(r=>{const a=M.byId.get(r.id);return a&&hit(a)});
  const groups=groupMachines(shown,data);
  const canAdd=canEdit;const canDel=perms.admin;
  return html`<section class="panel flex flex-col min-h-0" id="fl-machines">
    <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line">
      <input id="mc-search" class="field" style=${{...fs,width:240}} placeholder="Search machine, rego, make, serial" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search machines"/>
      <select class="field w-auto" style=${fs} value=${cat} onChange=${e=>setCat(e.target.value)} aria-label="Category"><option value="">All categories</option>${machineCatsOf(data).map(c=>html`<option key=${c} value=${c}>${c}</option>`)}</select>
      ${nRet>0&&html`<label class="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer"><input type="checkbox" class="w-4 h-4" checked=${ret} onChange=${e=>setRet(e.target.checked)}/>Show retired (${nRet})</label>`}
      <span class="text-[12.5px] text-muted">${shown.length} machine${shown.length===1?'':'s'}</span><span class="flex-1"></span>
      ${canAdd&&html`<button id="mc-add" type="button" class="btn btn-primary" onClick=${()=>setDlg({isNew:true})}>${Icon.plus} Add machine</button>`}
    </div>
    <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="mc-table">
      <thead><tr class="text-left">${['','Machine','Rego','Crew','Make / model','Year','Meters','Avg / year',''].map((h,i)=>html`<th key=${i} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
      ${groups.map(g=>html`<tbody key=${g.key}><tr class="border-t border-line bg-sunken"><td colspan="9" class="py-1.5 px-3 label">${g.label} <span class="text-faint font-normal">${g.rows.length}</span></td></tr>
        ${g.rows.map(r=>{const a=M.byId.get(r.id);const p=a.p||{};return html`<tr key=${r.id} class="border-t border-line hover:bg-sunken" data-machine=${r.name}>
          <td class="py-2 pl-3 pr-1 w-0">${stDot(a.status)}</td>
          <td class="py-2 px-3"><button type="button" class="text-left mc-open" onClick=${()=>open({k:'asset',id:r.id})}><span class="block font-medium hover:underline">${r.name}${a.retired?html` <span class="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Retired</span>`:''}</span><span class="block text-[11.5px] text-muted truncate max-w-[280px]">${r.sub||''}</span></button></td>
          <td class="py-2 px-3 mono whitespace-nowrap">${r.rego||html`<span class="text-faint">–</span>`}</td>
          <td class="py-2 px-3 whitespace-nowrap">${a.crew?a.crew.name:html`<span class="text-faint">–</span>`}</td>
          <td class="py-2 px-3 whitespace-nowrap">${[p.make,p.model].filter(Boolean).join(' ')||html`<span class="text-faint">–</span>`}</td>
          <td class="py-2 px-3 tnum">${p.year||html`<span class="text-faint">–</span>`}</td>
          <td class="py-2 px-3 tnum whitespace-nowrap">${meterTxt(a)}</td>
          <td class="py-2 px-3 tnum whitespace-nowrap">${(a.use.hours||a.use.km)?useTxt(a):html`<span class="text-faint">–</span>`}</td>
          <td class="py-2 pr-3 text-right whitespace-nowrap w-0">
            ${(canEdit||perms.work)&&html`<button type="button" class="mc-edit w-8 h-8 inline-flex items-center justify-center rounded-md text-muted hover:text-ink" title=${'Edit '+r.name} aria-label=${'Edit '+r.name} onClick=${()=>setDlg({a})}>${Icon.pencil}</button>`}
            ${canDel&&html`<button type="button" class="mc-del w-8 h-8 inline-flex items-center justify-center rounded-md hover:opacity-70" style=${{color:'var(--bad)'}} title=${'Delete '+r.name} aria-label=${'Delete '+r.name} onClick=${()=>setDlg({a,del:true})}>${Icon.trash}</button>`}</td></tr>`})}</tbody>`)}
      ${!shown.length&&html`<tbody><tr><td colspan="9" class="px-3 py-6 text-center text-muted">${M.assets.length?'No machines match.':'No machines yet.'+(canAdd?' Add your first machine.':'')}</td></tr></tbody>`}
    </table></div>
    ${dlg&&html`<${MachineDialog} key=${dlg.isNew?'new':dlg.a.m.id+(dlg.del?':del':'')} ctx=${ctx} a=${dlg.a} isNew=${!!dlg.isNew} startDel=${!!dlg.del} onClose=${()=>setDlg(null)}/>`}
  </section>`;
}

/* add or change a machine: its schedule details (planners and administrators) and its fleet details (maintenance staff) in one place */
function MachineDialog({ctx,a,isNew,startDel,onClose}){
  const {sb,data,setData,perms,canEdit,notify,reload}=ctx;const m=a?a.m:{};const p=a&&a.p||{};
  const crews=data.resources.filter(r=>r.type==='crew');const cats=machineCatsOf(data);
  const [f,setF]=useState({name:m.name||'',sub:m.sub||'',category:m.category||'',rego:m.rego||'',crewId:m.crewId||'',
    make:p.make||'',model:p.model||'',year:p.year?String(p.year):'',serial:p.serial||'',meter_type:a?a.mt:'hours',retired:!!p.retired,notes:p.notes||''});
  const [err,setErr]=useState('');const [busy,setBusy]=useState(false);const [del,setDel]=useState(!!startDel);
  const canR=canEdit;const canP=perms.work;
  const bookings=a?data.blocks.filter(b=>b.resourceId===m.id).length:0;
  const profRow=id=>({asset_id:id,make:f.make.trim()||null,model:f.model.trim()||null,year:f.year?+f.year:null,serial:f.serial.trim()||null,meter_type:f.meter_type,retired:f.retired,notes:f.notes.trim()||null});
  const profChanged=()=>{const r=profRow(m.id),o={make:p.make||null,model:p.model||null,year:p.year||null,serial:p.serial||null,meter_type:a?a.mt:'hours',retired:!!p.retired,notes:p.notes||null};
    return Object.keys(o).some(k=>(r[k]==null?null:r[k])!==(o[k]==null?null:o[k]))||(!a||!a.p)&&(r.make||r.model||r.year||r.serial||r.notes||r.retired||(isNew&&r.meter_type!=='hours'))};
  const saveProf=async id=>{const row=profRow(id);
    for(let i=0;i<10;i++){   /* a new machine reaches the database a moment after it's added */
      const {error}=a&&a.p?await sb.from('asset_profiles').update(row).eq('asset_id',id):await sb.from('asset_profiles').insert(row);
      if(!error)return null;if(!isNew||!/roster|23503/.test(errMsg(error)+(error.code||'')))return errMsg(error);await new Promise(r=>setTimeout(r,700))}
    return 'The machine was added, but its fleet details couldn’t be saved yet. Open it again to add them.'};
  const save=async()=>{setErr('');const name=f.name.trim();
    if(canR){if(!name){setErr('Enter the machine’s fleet number.');return}
      if(data.resources.some(r=>r.type==='machine'&&r.id!==m.id&&r.name.trim().toLowerCase()===name.toLowerCase())){setErr(`There’s already a machine called ${name}.`);return}}
    const id=isNew?'m'+uid():m.id;
    if(canR){const ros={name,sub:f.sub.trim()||'Machine',category:f.category.trim(),rego:f.rego.trim().toUpperCase(),crewId:f.crewId||null};
      if(isNew)setData(d=>({...d,resources:[...d.resources,{id,type:'machine',...ros,hue:HUES[d.resources.length%HUES.length],visible:true}]}));
      else if(['name','sub','category','rego','crewId'].some(k=>(m[k]||'')!==(ros[k]||'')))setData(d=>({...d,resources:d.resources.map(r=>r.id===id?{...r,...ros}:r)}))}
    if(canP&&profChanged()){setBusy(true);const e=await saveProf(id);setBusy(false);if(e){setErr(e);if(!isNew)return}else reload()}
    notify(isNew?`${name} added`:'Machine saved');onClose()};
  const remove=async()=>{if(!perms.admin)return;
    setData(d=>({...d,resources:d.resources.filter(r=>r.id!==m.id),blocks:d.blocks.filter(b=>b.resourceId!==m.id).map(b=>b.plantIds&&b.plantIds.includes(m.id)?{...b,...withShiftMach(b,(k,ids)=>ids.filter(x=>x!==m.id))}:b)}));
    if(a&&a.p)try{await sb.from('asset_profiles').delete().eq('asset_id',m.id)}catch(e){}
    try{await sb.from('asset_photos').delete().eq('asset_id',m.id)}catch(e){}
    notify(`${m.name} deleted`);reload();onClose()};
  const T=(id,label,k,ph,cls='',dis=!canR)=>html`<${Fld} label=${label}><input id=${id} class=${'field '+cls} style=${fs} placeholder=${ph||''} value=${f[k]} disabled=${dis} onInput=${e=>setF({...f,[k]:e.target.value})}/><//>`;
  return html`<${Modal} title=${isNew?'Add a machine':m.name} sub=${isNew?'It appears on the schedule and in Fleet straight away':[m.sub,machCatOf(m)].filter(Boolean).join(' · ')} onClose=${onClose}
    foot=${del?html`<div class="flex-1 min-w-0 grid gap-0.5" id="mc-del-confirm"><span class="text-[12.5px] font-medium" style=${{color:'var(--bad)'}}>Delete ${m.name}${bookings?` and its ${bookings} booking${bookings===1?'':'s'} on the schedule`:''}? This can’t be undone.</span>
        <span class="text-[12px] text-muted">To keep its maintenance history in view, tick Retired instead.</span></div>
      <button type="button" class="btn" onClick=${()=>startDel?onClose():setDel(false)}>Cancel</button><button id="mc-del-go" type="button" class="btn" style=${{background:'var(--bad)',color:'#fff',borderColor:'var(--bad)'}} onClick=${remove}>Yes, delete</button>`
      :html`${!isNew&&perms.admin&&html`<button id="mc-remove" type="button" class="btn" style=${{color:'var(--bad)'}} onClick=${()=>setDel(true)}>${Icon.trash} Delete</button>`}${err&&html`<span id="mc-err" class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="mc-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>${busy?'Saving…':isNew?'Add machine':'Save'}</button>`}>
    <div class="grid gap-4">
      <div class="grid sm:grid-cols-2 gap-3">
        <div class="sm:col-span-2 label">On the schedule${!canR?html` <span class="normal-case font-normal tracking-normal text-muted">· planners and administrators change these</span>`:''}</div>
        ${T('mc-name','Fleet number','name','e.g. PV010','mono')}
        ${T('mc-sub','Description','sub','e.g. Vogele Paver 1900-3')}
        <${Fld} label="Category"><input id="mc-cat" list="mc-cats" class="field" style=${fs} placeholder="e.g. Pavers" value=${f.category} disabled=${!canR} onInput=${e=>setF({...f,category:e.target.value})}/><datalist id="mc-cats">${cats.map(c=>html`<option key=${c} value=${c}/>`)}</datalist><//>
        ${T('mc-rego','Rego','rego','e.g. 123ABC','mono uppercase')}
        <${Fld} label="Crew"><select id="mc-crew" class="field" style=${fs} value=${f.crewId} disabled=${!canR} onChange=${e=>setF({...f,crewId:e.target.value})}><option value="">No crew</option>${crews.map(c=>html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}</select><//>
      </div>
      <div class="grid sm:grid-cols-2 gap-3 border-t border-line pt-3">
        <div class="sm:col-span-2 label">Fleet details${!canP?html` <span class="normal-case font-normal tracking-normal text-muted">· mechanics, supervisors and administrators change these</span>`:''}</div>
        ${T('mc-make','Make','make','e.g. Dynapac','',!canP)}
        ${T('mc-model','Model','model','e.g. CC1200','',!canP)}
        <${Fld} label="Year"><input id="mc-year" type="number" min="1950" max="2100" class="field" style=${fs} value=${f.year} disabled=${!canP} onInput=${e=>setF({...f,year:e.target.value})}/><//>
        ${T('mc-serial','Serial / VIN','serial','','mono',!canP)}
        <${Fld} label="Meters"><select id="mc-meter" class="field" style=${fs} value=${f.meter_type} disabled=${!canP} onChange=${e=>setF({...f,meter_type:e.target.value})}>
          <option value="hours">Engine hours</option><option value="km">Kilometres</option><option value="both">Hours and kilometres</option></select><//>
        ${T('mc-notes','Notes','notes','e.g. owner, hire, tyre size','',!canP)}
        ${!isNew&&html`<label class="inline-flex items-center gap-2 text-[13px] cursor-pointer sm:col-span-2"><input id="mc-retired" type="checkbox" class="w-4 h-4" checked=${f.retired} disabled=${!canP} onChange=${e=>setF({...f,retired:e.target.checked})}/>Retired (kept for history, left out of the fleet counts)</label>`}
      </div>
    </div><//>`;
}

/* services raised automatically (api/_service_due.js, on the regular schedule) */
function AutoServices({ctx}){
  const {db,sb,perms,notify,reload}=ctx;const [busy,setBusy]=useState('');const [msg,setMsg]=useState('');
  if(!db.fleet_settings)return perms.mgr?html`<div class="px-3 py-2 text-[12px] text-muted border-b border-line">To raise service work orders automatically, run <span class="mono">supabase/service_auto.sql</span> in Supabase.</div>`:null;
  const fs=db.fleet_settings[0]||{};
  const toggle=async on=>{setBusy('t');setMsg('');const {error}=await sb.from('fleet_settings').update({auto_service:on}).eq('id',1);setBusy('');
    if(error){setMsg(errMsg(error));return}notify(on?'Services will be raised automatically':'Automatic services switched off');reload();if(on)check()};
  const check=async()=>{setBusy('c');setMsg('');try{const r=await sm8Call(sb,{action:'services'});
      setMsg(r.raised.length?`Raised ${r.raised.length}: ${r.raised.map(x=>`${x.machine} (${x.title})`).join(', ')}`:'Nothing new is due.');reload()}
    catch(e){setMsg(errMsg(e))}finally{setBusy('')}};
  return html`<div id="sp-auto" class="px-3 py-2.5 border-b border-line grid gap-1">
    <div class="flex flex-wrap items-center gap-2">
      <label class="flex items-center gap-2 text-[13px] font-medium cursor-pointer"><input id="sp-auto-on" type="checkbox" class="w-4 h-4" checked=${!!fs.auto_service} disabled=${!perms.mgr||!!busy} onChange=${e=>toggle(e.target.checked)}/>
        Raise service work orders automatically</label>
      <span class="flex-1"></span>
      ${perms.mgr&&html`<button id="sp-auto-check" type="button" class="btn" style=${{height:30,fontSize:12.5}} disabled=${!!busy} onClick=${check}>${busy==='c'?'Checking…':'Check now'}</button>`}</div>
    <div class="text-[12px] text-muted">When a machine comes within a plan’s warning (e.g. 50 h before), or is overdue, a service work order is made for it${sm8On(db)?' and sent to ServiceM8':''}. Checked every 10 minutes. Cancelling one skips that service.${fs.last_check_at?` Last checked ${agoTxt(fs.last_check_at)}${fs.last_raised?`, raised ${fs.last_raised}`:''}.`:''}</div>
    ${msg&&html`<div id="sp-auto-msg" class="text-[12.5px]">${msg}</div>`}
  </div>`;
}

function Plans({ctx,open}){
  const {perms,data}=ctx;const [del,setDel]=useState(null);
  const plans=ctx.db.service_plans.slice().sort((a,b)=>(a.category||'~').localeCompare(b.category||'~')||a.name.localeCompare(b.name));
  const covers=p=>p.asset_id?1:ctx.M.assets.filter(a=>!a.retired&&planCats(p).includes(machCatOf(a.m).toLowerCase())).length;
  const remove=async p=>{const {error}=await ctx.sb.from('service_plans').delete().eq('id',p.id);setDel(null);if(error){ctx.notify(errMsg(error));return}ctx.notify('Service plan removed');ctx.reload()};
  return html`<section class="panel flex flex-col min-h-0">
    <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line"><div class="text-[12.5px] text-muted">Each machine follows the plans for its category, plus any plans set for that machine alone. Default warnings: 50 h, 1,000 km, 14 days.</div>
      <span class="flex-1"></span>${perms.mgr&&html`<button id="sp-new" type="button" class="btn btn-primary" onClick=${()=>open({k:'plan'})}>${Icon.plus} New service plan</button>`}</div>
    <${AutoServices} ctx=${ctx}/>
    <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="sp-table">
      <thead><tr class="text-left">${['Applies to','Service','Every','Warn before','Machines','',''].map((h,i)=>html`<th key=${i} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
      <tbody>${plans.map(p=>{const m=p.asset_id&&data.resources.find(r=>r.id===p.asset_id);return html`<tr key=${p.id} class="border-t border-line" style=${p.active?null:{opacity:.55}}>
          <td class="py-2 px-3 whitespace-nowrap">${p.asset_id?html`<span class="font-medium">${m?m.name:p.asset_id}</span> <span class="text-muted">(one machine)</span>`:html`<span class="font-medium">${planCatList(p).join(', ')}</span>`}</td>
          <td class="py-2 px-3">${p.name}${!p.active?html` <span class="text-[11px] text-muted">(off)</span>`:''}</td>
          <td class="py-2 px-3 whitespace-nowrap">${ivTxt(p)?[ivTxt(p),p.every_days&&`${p.every_days} days`].filter(Boolean).join(' or '):[p.every_hours&&`${fmtN(+p.every_hours)} h`,p.every_km&&`${fmtN(+p.every_km)} km`,p.every_days&&`${p.every_days} days`].filter(Boolean).join(' / ')}</td>
          <td class="py-2 px-3 whitespace-nowrap text-muted">${[p.every_hours&&`${fmtN(+p.warn_hours)} h`,p.every_km&&`${fmtN(+p.warn_km)} km`,p.every_days&&`${p.warn_days} days`].filter(Boolean).join(' / ')}</td>
          <td class="py-2 px-3 tnum">${covers(p)}</td>
          <td class="py-2 px-3 text-right whitespace-nowrap" colspan="2">${perms.mgr&&(del===p.id?html`<button type="button" class="text-[12px] font-semibold mr-2" style=${{color:'var(--bad)'}} onClick=${()=>remove(p)}>Remove</button><button type="button" class="text-[12px] text-muted" onClick=${()=>setDel(null)}>Keep</button>`
            :html`<button type="button" class="p-1 rounded text-muted hover:text-ink" onClick=${()=>open({k:'plan',plan:p})} aria-label=${'Edit '+p.name}>${Icon.pencil}</button><button type="button" class="p-1 rounded text-muted hover:text-ink" onClick=${()=>setDel(p.id)} aria-label=${'Remove '+p.name}>${Icon.x}</button>`)}</td></tr>`})}
        ${!plans.length&&html`<tr><td colspan="7" class="px-3 py-6 text-center text-muted">No service plans yet.${perms.mgr?' Add one, e.g. Steel Rollers: 250 hr service every 250 hours.':' An administrator adds them.'}</td></tr>`}</tbody></table></div>
    ${!perms.mgr&&html`<p class="px-3 py-2 text-[12px] text-muted">Only administrators can change service plans.</p>`}
  </section>`;
}

/* ---------- the screen ---------- */
function FleetScreen({data,live,notify,setData,tab:tab0,onCounts,assetReq,onImportMachines}){
  const sb=live.sb;const role=live.role;
  /* mechanics: full access to Fleet; deleting machines (the roster's list) stays with administrators and superusers */
  /* what this role can do here (Admin › Roles) */
  const C=window.ffCan||(()=>false);
  const perms={work:C('fleet.workorders',2),verify:C('fleet.verify',2),mgr:C('fleet.manage',2),admin:C('fleet.machines',2)&&C('fleet.manage',2),delWo:C('fleet.manage',2)};
  const {db,err,reload}=useMaint(sb);
  /* while Fleet is open: every 5 minutes, send what's waiting and refresh outstanding work orders from ServiceM8 */
  const sm8Ref=useRef(null);sm8Ref.current=db&&perms.work?{db,sb}:null;
  useEffect(()=>{const t=setInterval(()=>{const c=sm8Ref.current;if(c&&!document.hidden)sm8Flush(c)},5*60e3);return()=>clearInterval(t)},[]);
  const tab=tab0||'dash';
  const [dlg,setDlg]=useState(null);const [asset,setAsset]=useState(null);
  useEffect(()=>{try{const id=localStorage.getItem(KEY+':fleetAsset');if(id){localStorage.removeItem(KEY+':fleetAsset');setAsset(id)}}catch(e){}},[]);
  useEffect(()=>{if(assetReq&&assetReq.id)setAsset(assetReq.id)},[assetReq&&assetReq.n]);
  useEffect(()=>{if(db&&onCounts)onCounts({wo:db.work_orders.filter(w=>WO_OPEN(w.status)).length,df:db.p4?db.defects.filter(d=>!['closed','dismissed'].includes(d.status)).length:null})},[db]);
  const M=useMemo(()=>db?buildModel(data,db):null,[db,data.resources,data.blocks]);
  if(err&&!db)return html`<div class="panel p-6 grid gap-2 max-w-[640px]"><div class="font-display text-[17px] font-semibold">Fleet & Maintenance isn’t set up yet</div>
    <p class="text-[13px] text-muted">The maintenance tables aren’t in the database yet. An administrator needs to run <span class="mono">supabase/maintenance.sql</span> once in Supabase → SQL Editor.</p><p class="text-[12px] text-faint mono">${err}</p>
    <div><button type="button" class="btn" onClick=${reload}>Try again</button></div></div>`;
  if(!M)return html`<div class="panel p-6 text-[13px] text-muted">Loading maintenance…</div>`;
  const staff=[...new Set(data.resources.filter(r=>r.type==='person').map(r=>r.name))].sort();
  const ctx={sb,db,data,M,perms,notify,reload,staff,plans:db.service_plans,me:live.user&&live.user.id,role,setData,canEdit:!!live.canEdit&&!!setData&&C('fleet.machines',2),onImportMachines};
  const open=o=>{if(o.k==='asset'){setAsset(o.id);return}setDlg(o)};
  const a=asset&&M.byId.get(asset);
  const P=window.FFP;
  const D=window.FFD;
  const tabOk=['dash','mc','wo','plans',...(D?['df']:[]),...(P?['ps','cl']:[]),...(window.FFR?['rp']:[])].includes(tab)?tab:'dash';
  return html`<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto pr-1">
    ${(err||!perms.work)&&html`<div class="flex flex-wrap items-center gap-2 -mt-1"><span class="flex-1"></span>${err&&html`<span class="text-[12px]" style=${{color:'var(--bad)'}}>${err}</span>`}
      ${!perms.work&&html`<span class="text-[12px] text-muted">View only: mechanics, supervisors and administrators record maintenance</span>`}</div>`}
    ${tabOk==='dash'?html`<${Dashboard} ctx=${ctx} open=${open}/>`:tabOk==='mc'?html`<${MachinesTab} ctx=${ctx} open=${open}/>`:tabOk==='wo'?html`<${WorkOrders} ctx=${ctx} open=${open}/>`
      :tabOk==='df'?html`<${D.DefectsTab} ctx=${ctx} open=${open}/>`:tabOk==='ps'?html`<${P.PrestartsTab} ctx=${ctx} open=${open}/>`:tabOk==='cl'?html`<${P.ChecklistsTab} ctx=${ctx} open=${open}/>`:tabOk==='rp'?html`<${window.FFR.ReportsTab} ctx=${ctx}/>`:html`<${Plans} ctx=${ctx} open=${open}/>`}
    ${a&&html`<${AssetPanel} ctx=${ctx} a=${a} open=${open} behind=${!!dlg} onClose=${()=>setAsset(null)}/>`}
    ${dlg&&dlg.k==='wo'&&html`<${WorkOrderDialog} ctx=${ctx} wo=${dlg.wo&&db.work_orders.find(w=>w.id===dlg.wo.id)||dlg.wo} init=${dlg.init} onClose=${()=>setDlg(null)}/>`}
    ${dlg&&dlg.k==='service'&&html`<${ServiceDialog} key=${(dlg.baseline?'b:':'r:')+dlg.a.m.id+(dlg.plan?dlg.plan.id:'')} ctx=${ctx} a=${M.byId.get(dlg.a.m.id)} plan=${dlg.plan} baseline=${dlg.baseline} onClose=${()=>setDlg(null)}/>`}
    ${dlg&&dlg.k==='reading'&&html`<${ReadingDialog} ctx=${ctx} a=${M.byId.get(dlg.a.m.id)} onClose=${()=>setDlg(null)}/>`}
    ${dlg&&dlg.k==='profile'&&html`<${ProfileDialog} ctx=${ctx} a=${M.byId.get(dlg.a.m.id)} onClose=${()=>setDlg(null)}/>`}
    ${dlg&&dlg.k==='machine'&&html`<${MachineDialog} ctx=${ctx} a=${M.byId.get(dlg.a.m.id)} onClose=${()=>setDlg(null)}/>`}
    ${dlg&&dlg.k==='breakdown'&&html`<${BreakdownDialog} ctx=${ctx} a=${M.byId.get(dlg.a.m.id)} onClose=${()=>setDlg(null)}/>`}
    ${dlg&&dlg.k==='sm8'&&html`<${Sm8Settings} ctx=${ctx} onClose=${()=>setDlg(null)}/>`}
    ${dlg&&dlg.k==='plan'&&html`<${PlanDialog} ctx=${ctx} plan=${dlg.plan} onClose=${()=>setDlg(null)}/>`}
    ${D&&dlg&&dlg.k==='defect'&&html`<${D.DefectDialog} ctx=${ctx} d=${(db.defects||[]).find(x=>x.id===dlg.d.id)||dlg.d} open=${open} onClose=${()=>setDlg(null)}/>`}
    ${D&&dlg&&dlg.k==='newdefect'&&html`<${D.NewDefectDialog} ctx=${ctx} a=${M.byId.get(dlg.a.m.id)} onClose=${()=>setDlg(null)}/>`}
    ${P&&dlg&&dlg.k==='ps'&&html`<${P.PrestartView} ctx=${ctx} ps=${dlg.ps} onClose=${()=>setDlg(null)}/>`}
    ${P&&dlg&&dlg.k==='checklist'&&html`<${P.ChecklistDialog} key=${dlg.n||(dlg.n=Date.now())} ctx=${ctx} tpl=${dlg.tpl} onClose=${()=>setDlg(null)}/>`}
  </div>`;
}
window.FleetScreen=FleetScreen;
window.FFM={Modal,Fld,fs,n0,errMsg,fmtTs,fmtD,localDay,useMaint,buildModel,meterTxt,stChip};   /* shared with prestart.js */
window.__maintModel=buildModel;
})();
