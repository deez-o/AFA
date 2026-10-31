/* =====================================================================
   FraserFlow: Timesheets (in development: the administrator only, until it's released in Settings).
   Everyone puts in their hours each day; a supervisor checks and signs off the week; the week exports as a PDF for admin.
   - A day can only be filled in by the person if they signed on to a job that day (signed the JSA in a QA pack);
     otherwise a supervisor adds it.
   - Leave on the calendar fills in those days (annual leave, sick, RDO, training). A week of leave makes a timesheet on its own.
   - A timesheet starts on someone's first shift of the week (their first sign-on).
   - People in the same crew on the same day are compared: different hours are highlighted to check.
   Database: supabase/timesheets.sql (table timesheets; one row per person per week, days in jsonb).
   ===================================================================== */
(function(){
const DAY_KINDS=[['work','Work'],['leave','Annual leave'],['sick','Sick leave'],['rdo','RDO'],['training','Training'],['public_holiday','Public holiday'],['off','Off']];
const KIND_SHORT={leave:'AL',sick:'Sick',rdo:'RDO',training:'Trn',public_holiday:'PH',off:'Off'};
const LEAVE_HOURS=7.6;   /* a day of leave (38-hour week) */
const BREAKS=[0,15,30,45,60,90];
const kindLabel=k=>(DAY_KINDS.find(x=>x[0]===k)||[,k])[1];
const tmin=t=>{const m=/^(\d{1,2}):(\d{2})/.exec(t||'');return m?+m[1]*60+ +m[2]:null};
/* hours worked: finish − start − break (a finish before the start is the next morning: night works) */
const hoursOf=d=>{if(!d)return 0;if(d.kind&&d.kind!=='work')return d.kind==='off'?0:(d.hours!=null&&d.hours!==''?+d.hours:LEAVE_HOURS);
  const a=tmin(d.start),b=tmin(d.finish);if(a==null||b==null)return 0;let m=b-a;if(m<=0)m+=1440;m-=(+d.break||0);return Math.max(0,Math.round(m/60*100)/100)};
const h2=n=>(Math.round(n*100)/100).toLocaleString('en-AU',{maximumFractionDigits:2});
const weekDays=ws=>Array.from({length:7},(_,i)=>iso(addDays(parse(ws),i)));
const dayName=k=>`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}`;
const errMsg=e=>(e&&(e.message||e.error_description))||String(e||'Something went wrong');
const LEAVE_KIND={leave:'leave',sick:'sick',rdo:'rdo',training:'training'};

/* the week's data: timesheets, QA packs and JSA sign-ons, and (for supervisors) who's who */
function useWeek(sb,ws,mgr){
  const [v,setV]=useState(null);const [err,setErr]=useState('');const [n,setN]=useState(0);
  useEffect(()=>{let off=false;const ds=weekDays(ws);
    (async()=>{try{
      const ts=await sb.from('timesheets').select('*').eq('week_start',ws);if(ts.error)throw ts.error;
      const pk=await sb.from('qa_packs').select('id,block_id,shift_date,crew_id,job_id').gte('shift_date',ds[0]).lte('shift_date',ds[6]);if(pk.error)throw pk.error;
      const ids=(pk.data||[]).map(p=>p.id);let sigs=[];
      if(ids.length){const r=await sb.from('qa_signatures').select('pack_id,user_id,name,signed_at').eq('form','jsa').in('pack_id',ids);if(r.error)throw r.error;sigs=(r.data||[]).filter(s=>s.user_id)}
      const me=(await sb.auth.getUser()).data.user;const mine=await sb.from('profiles').select('id,staff_id,email').eq('id',me.id).maybeSingle();
      let profs=[];if(mgr){const r=await sb.from('profiles').select('id,staff_id,email,role');if(!r.error)profs=r.data||[]}
      if(!off){setV({ts:ts.data||[],packs:pk.data||[],sigs,me:{id:me.id,staff_id:mine.data&&mine.data.staff_id,email:me.email},profs});setErr('')}
    }catch(e){if(!off)setErr(errMsg(e))}})();
    return()=>{off=true}},[ws,n]);
  useEffect(()=>{let ch=null,t=null;try{ch=sb.channel('ts-'+Math.random().toString(36).slice(2));['timesheets','qa_signatures'].forEach(tb=>ch.on('postgres_changes',{event:'*',schema:'public',table:tb},()=>{clearTimeout(t);t=setTimeout(()=>setN(x=>x+1),500)}));ch.subscribe()}catch(e){}
    return()=>{clearTimeout(t);try{ch&&sb.removeChannel(ch)}catch(e){}}},[]);
  return {v,err,reload:()=>setN(x=>x+1)};
}

/* a person's sign-ons this week: { date: [{pack, block, crewId, label}] } */
function signOnsOf(v,data,userId){const out={};
  (v.sigs||[]).filter(s=>s.user_id===userId).forEach(s=>{const p=v.packs.find(x=>x.id===s.pack_id);if(!p)return;const b=data.blocks.find(x=>x.id===p.block_id);
    const crewId=p.crew_id||(b&&(coverOf(b,p.shift_date)||b.resourceId))||'';const crew=data.resources.find(r=>r.id===crewId);const j=data.jobs.find(x=>x.id===(p.job_id||(b&&b.jobId)));
    (out[p.shift_date]=out[p.shift_date]||[]).push({pack:p,block:b,crewId,label:[j?jobLabel(j):'Job',crew&&crew.name].filter(Boolean).join(' · '),night:b&&b.shift==='night'})});
  return out}
/* leave on the calendar for a staff member, Monday to Friday */
function leaveOf(data,staffId,ds){const out={};if(!staffId)return out;
  ds.slice(0,5).forEach(k=>{const b=data.blocks.find(x=>x.resourceId===staffId&&LEAVE_KIND[x.kind]&&x.start<=k&&x.end>=k);if(b)out[k]={kind:LEAVE_KIND[b.kind],hours:b.kind==='training'?null:LEAVE_HOURS,from:'calendar'}});return out}
/* a new timesheet's days: leave from the calendar, and the jobs signed on to (times to fill in) */
function startDays(data,staffId,ds,so){const days={...leaveOf(data,staffId,ds)};
  Object.entries(so||{}).forEach(([k,l])=>{if(!days[k]){const x=l[0];days[k]={kind:'work',pack_id:x.pack.id,block_id:x.pack.block_id,crew_id:x.crewId,job:x.label,night:!!x.night}}});return days}

function TimesheetsScreen({data,live,notify}){
  const sb=live.sb;const mgr=can('timesheets',2)||can('timesheets',1);const mineOk=can('timesheets.mine',2)||live.role==='admin';
  const [tab,setTab]=useState(mineOk?'mine':'all');
  const [ws,setWs]=useState(()=>iso(mondayOf(TODAY)));
  const {v,err,reload}=useWeek(sb,ws,mgr);
  const ds=weekDays(ws);
  const nav=html`<div class="flex items-center gap-1"><button type="button" class="btn px-2" onClick=${()=>setWs(iso(addDays(parse(ws),-7)))} aria-label="Previous week">${Icon.chevL}</button>
    <button type="button" class="btn" disabled=${ws===iso(mondayOf(TODAY))} onClick=${()=>setWs(iso(mondayOf(TODAY)))}>This week</button>
    <button type="button" class="btn px-2" onClick=${()=>setWs(iso(addDays(parse(ws),7)))} aria-label="Next week">${Icon.chevR}</button>
    <span class="text-[13px] font-medium ml-2">${dayName(ds[0])} – ${dayName(ds[6])} ${parse(ds[6]).getFullYear()}</span></div>`;
  if(err)return html`<div class="panel p-6 grid gap-2 max-w-[640px]"><div class="font-display text-[17px] font-semibold">Timesheets aren’t set up yet</div>
    <p class="text-[13px] text-muted">An administrator needs to run <span class="mono">supabase/timesheets.sql</span> in Supabase.</p><p class="text-[12px] text-faint">${err}</p></div>`;
  return html`<div class="flex-1 min-h-0 overflow-y-auto pr-1 grid grid-cols-[minmax(0,1fr)] gap-3 content-start" id="ts-screen">
    <div class="panel px-4 py-3 flex flex-wrap items-center gap-3">
      ${mineOk&&mgr&&html`<div class="seg" role="tablist"><button type="button" aria-pressed=${tab==='mine'} onClick=${()=>setTab('mine')}>My timesheet</button><button type="button" aria-pressed=${tab==='all'} onClick=${()=>setTab('all')}>All timesheets</button></div>`}
      ${nav}<span class="flex-1"></span>
      <span class="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded" style=${{background:'hsl(38 95% 50% / .18)',color:'hsl(30 90% 30%)'}}>In development</span></div>
    ${!v?html`<div class="panel p-6 text-[13px] text-muted">Loading…</div>`
      :tab==='mine'?html`<${MyWeek} key=${ws} sb=${sb} data=${data} v=${v} ws=${ws} ds=${ds} notify=${notify} reload=${reload}/>`
      :html`<${AllWeek} key=${ws} sb=${sb} data=${data} v=${v} ws=${ws} ds=${ds} notify=${notify} reload=${reload}/>`}
  </div>`;
}

/* ---------- someone's own week ---------- */
function MyWeek({sb,data,v,ws,ds,notify,reload}){
  const me=v.me;const staffId=me.staff_id;const person=data.resources.find(r=>r.id===staffId);
  const so=signOnsOf(v,data,me.id);const ts=v.ts.find(t=>t.staff_id===staffId);
  const [busy,setBusy]=useState('');const [err,setErr]=useState('');const made=useRef(false);
  /* the timesheet starts on the first sign-on of the week (or when the week has leave) */
  useEffect(()=>{if(ts||made.current||!staffId)return;const days=startDays(data,staffId,ds,so);if(!Object.keys(days).length)return;made.current=true;
    sb.from('timesheets').insert({staff_id:staffId,user_id:me.id,name:person?person.name:me.email,week_start:ws,days}).then(({error})=>{if(error&&!/duplicate/i.test(error.message))setErr(errMsg(error));reload()})},[ts,staffId]);
  if(!staffId)return html`<div class="panel p-5 text-[13px] text-muted">Your login isn’t linked to a staff member, so there’s no timesheet for you. (Staff › People: link the login.)</div>`;
  if(!ts)return html`<div class="panel p-5 text-[13px] text-muted">${Object.keys(so).length?'Starting your timesheet…':'No timesheet this week yet. It starts the first time you sign on to a job (sign the JSA in the QA pack).'}</div>`;
  const locked=ts.status==='approved';
  const save=async(days,status)=>{setErr('');setBusy('s');const {error}=await sb.from('timesheets').update({days,...(status?{status}:{})}).eq('id',ts.id);setBusy('');if(error){setErr(errMsg(error));return false}reload();return true};
  const tot=ds.reduce((a,k)=>a+hoursOf(ts.days[k]),0);
  return html`<div class="grid gap-3" id="ts-mine">
    <div class="panel px-4 py-3 flex flex-wrap items-center gap-3"><div class="font-display text-[16px] font-semibold">${person?person.name:'My timesheet'}</div>
      ${statusChip(ts)}<span class="flex-1"></span><span class="text-[13px]">Total <span class="font-semibold tnum">${h2(tot)} h</span></span></div>
    ${err&&html`<div class="panel px-4 py-2 text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
    ${ds.map(k=>{const d=ts.days[k];const signed=so[k];
      const canEdit=!locked&&!!signed&&(!d||!d.kind||d.kind==='work');
      return html`<${DayCard} key=${k} k=${k} d=${d} signed=${signed} editable=${canEdit} mgr=${false}
        onSave=${nd=>save({...ts.days,[k]:{...(signed&&signed[0]?{pack_id:signed[0].pack.id,block_id:signed[0].pack.block_id,crew_id:signed[0].crewId,job:signed[0].label}:{}),...d,...nd,kind:'work',by:'self'}})}/>`})}
    ${!locked&&html`<div class="panel px-4 py-3 flex flex-wrap items-center gap-2">
      <span class="text-[12.5px] text-muted flex-1">${ts.status==='submitted'?'Sent to your supervisor. You can still fix a day until they sign it off.':'At the end of the week, check your days and send it to your supervisor.'}</span>
      ${ts.status!=='submitted'&&html`<button id="ts-submit" type="button" class="btn btn-primary" disabled=${!!busy} onClick=${async()=>{if(await save(ts.days,'submitted'))notify('Timesheet sent to your supervisor')}}>Send to supervisor</button>`}</div>`}
  </div>`;
}
const statusChip=ts=>{const s=ts.status;const [l,c]=s==='approved'?[`Signed off${ts.approved_name?' by '+ts.approved_name:''}`,'hsl(145 55% 30%)']:s==='submitted'?['Sent to supervisor','hsl(212 70% 40%)']:['Being filled in','hsl(30 90% 36%)'];
  return html`<span class="text-[11.5px] font-semibold px-2 py-0.5 rounded-full" style=${{color:c,boxShadow:`inset 0 0 0 1px ${c}`}}>${l}</span>`};

/* one day: what it is (work at a job, leave, not signed on) and its times */
function DayCard({k,d,signed,editable,mgr,onSave,audit}){
  const [f,setF]=useState(()=>({kind:(d&&d.kind)||'work',start:(d&&d.start)||'',finish:(d&&d.finish)||'',break:d&&d.break!=null?String(d.break):'30',notes:(d&&d.notes)||'',hours:d&&d.hours!=null?String(d.hours):''}));
  useEffect(()=>{setF({kind:(d&&d.kind)||'work',start:(d&&d.start)||'',finish:(d&&d.finish)||'',break:d&&d.break!=null?String(d.break):'30',notes:(d&&d.notes)||'',hours:d&&d.hours!=null?String(d.hours):''})},[JSON.stringify(d||{})]);
  const leave=f.kind!=='work';const hrs=hoursOf({...f,break:+f.break||0,hours:f.hours===''?null:+f.hours});
  const dirty=JSON.stringify({kind:(d&&d.kind)||'work',start:(d&&d.start)||'',finish:(d&&d.finish)||'',break:d&&d.break!=null?String(d.break):'30',notes:(d&&d.notes)||'',hours:d&&d.hours!=null?String(d.hours):''})!==JSON.stringify(f);
  const commit=()=>{if(!dirty)return;const out={kind:f.kind,notes:f.notes.trim()};
    if(f.kind==='work')Object.assign(out,{start:f.start,finish:f.finish,break:+f.break||0,hours:hoursOf({kind:'work',start:f.start,finish:f.finish,break:+f.break||0})});
    else out.hours=f.kind==='off'?0:(f.hours===''?(f.kind==='training'?null:LEAVE_HOURS):+f.hours);
    if(mgr)out.by='supervisor';onSave(out)};
  const job=(d&&d.job)||(signed&&signed[0]&&signed[0].label);
  const tag=leave?html`<span class="text-[11.5px] font-semibold px-1.5 py-0.5 rounded" style=${{background:'hsl(28 90% 50% / .15)',color:'hsl(25 80% 32%)'}}>${kindLabel(f.kind)}${d&&d.from==='calendar'?' (from the calendar)':''}</span>`
    :signed?html`<span class="text-[11.5px] font-semibold px-1.5 py-0.5 rounded" style=${{background:'hsl(145 55% 36% / .14)',color:'hsl(145 55% 28%)'}}>Signed on</span>`
    :d&&d.by==='supervisor'?html`<span class="text-[11.5px] font-semibold px-1.5 py-0.5 rounded bg-sunken text-muted">Added by supervisor</span>`
    :html`<span class="text-[11.5px] text-muted">Not signed on</span>`;
  const fsx={height:38};
  return html`<div class="panel px-4 py-3 grid gap-2 ts-day" data-day=${k} style=${audit?{boxShadow:'inset 0 0 0 1.5px hsl(38 90% 48%)'}:null}>
    <div class="flex flex-wrap items-center gap-2"><span class="font-semibold text-[14px] w-[92px]">${dayName(k)}</span>${tag}${job&&!leave&&html`<span class="text-[12.5px] text-muted truncate min-w-0">${job}</span>`}
      <span class="flex-1"></span><span class="tnum font-semibold text-[14px]">${hrs?h2(hrs)+' h':''}</span></div>
    ${audit&&html`<div class="text-[12px] font-medium" style=${{color:'hsl(30 90% 32%)'}}>Different to the crew: ${audit}</div>`}
    ${editable||mgr?html`<div class="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
        ${mgr&&html`<label class="grid gap-1 sm:col-span-1"><span class="label">Day</span><select class="field" style=${fsx} value=${f.kind} onChange=${e=>setF({...f,kind:e.target.value})} onBlur=${commit}>${DAY_KINDS.map(([v,l])=>html`<option key=${v} value=${v}>${l}</option>`)}</select></label>`}
        ${!leave?html`<label class="grid gap-1"><span class="label">Start</span><input type="time" class="field mono ts-start" style=${fsx} value=${f.start} onInput=${e=>setF({...f,start:e.target.value})} onBlur=${commit}/></label>
          <label class="grid gap-1"><span class="label">Finish</span><input type="time" class="field mono ts-finish" style=${fsx} value=${f.finish} onInput=${e=>setF({...f,finish:e.target.value})} onBlur=${commit}/></label>
          <label class="grid gap-1"><span class="label">Break</span><select class="field ts-break" style=${fsx} value=${f.break} onChange=${e=>setF({...f,break:e.target.value})} onBlur=${commit}>${BREAKS.map(b=>html`<option key=${b} value=${String(b)}>${b} min</option>`)}</select></label>`
          :f.kind!=='off'&&html`<label class="grid gap-1"><span class="label">Hours</span><input type="number" step="0.1" min="0" class="field mono" style=${fsx} placeholder=${f.kind==='training'?'':String(LEAVE_HOURS)} value=${f.hours} onInput=${e=>setF({...f,hours:e.target.value})} onBlur=${commit}/></label>`}
        <label class=${'grid gap-1 '+(mgr?'col-span-2 sm:col-span-2':'col-span-2 sm:col-span-3')}><span class="label">Notes</span><input class="field ts-notes" style=${fsx} placeholder="e.g. travel, delays" value=${f.notes} onInput=${e=>setF({...f,notes:e.target.value})} onBlur=${commit}/></label>
      </div>
      ${dirty&&html`<div class="flex justify-end"><button type="button" class="btn btn-primary" style=${{height:32}} onClick=${commit}>Save day</button></div>`}`
      :!leave&&html`<div class="text-[12.5px] text-muted">${d&&(d.start||d.finish)?`${d.start||'?'} – ${d.finish||'?'}${d.break?` · ${d.break} min break`:''}${d.notes?' · '+d.notes:''}`:signed?'':'You didn’t sign on to a job this day. If you worked, your supervisor can add it.'}</div>`}
  </div>`;
}

/* ---------- everyone's week (supervisors) ---------- */
/* the same crew on the same day should have the same hours: anyone different is flagged */
function crewAudit(rows,ds){const flags={};
  ds.forEach(k=>{const by={};rows.forEach(r=>{const d=r.ts&&r.ts.days[k];if(!d||(d.kind&&d.kind!=='work')||!d.crew_id)return;const h=hoursOf(d);if(!h)return;(by[d.crew_id]=by[d.crew_id]||[]).push({r,h})});
    Object.values(by).forEach(list=>{if(list.length<2)return;const cnt={};list.forEach(x=>{cnt[x.h]=(cnt[x.h]||0)+1});const common=+Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0][0];
      list.forEach(x=>{if(Math.abs(x.h-common)>=0.25)flags[x.r.key+'|'+k]=`${h2(x.h)} h; most of the crew put ${h2(common)} h (${list.filter(y=>y!==x).map(y=>`${y.r.name} ${h2(y.h)} h`).join(', ')})`})})});
  return flags}

function AllWeek({sb,data,v,ws,ds,notify,reload}){
  const [open,setOpen]=useState(null);const [busy,setBusy]=useState('');const [err,setErr]=useState('');const made=useRef({});
  const persons=data.resources.filter(r=>r.type==='person');
  const profOf=sid=>v.profs.find(p=>p.staff_id===sid);
  /* everyone with a timesheet, a sign-on or leave this week */
  const rows=useMemo(()=>{const out=[];const seen=new Set();
    const add=(sid,uid,name)=>{const key=sid||('u:'+uid);if(seen.has(key))return;seen.add(key);
      const p=persons.find(x=>x.id===sid);const ts=v.ts.find(t=>sid?t.staff_id===sid:t.user_id===uid);
      out.push({key,sid,uid:uid||(ts&&ts.user_id)||(profOf(sid)||{}).id||null,name:(p&&p.name)||(ts&&ts.name)||name||'Unknown',crew:p&&p.crewId&&data.resources.find(r=>r.id===p.crewId),ts,
        so:signOnsOf(v,data,uid||(ts&&ts.user_id)||(profOf(sid)||{}).id),leave:leaveOf(data,sid,ds)})};
    v.ts.forEach(t=>add(t.staff_id,t.user_id,t.name));
    v.sigs.forEach(s=>{const pr=v.profs.find(p=>p.id===s.user_id);add(pr&&pr.staff_id,s.user_id,s.name)});
    persons.forEach(p=>{if(Object.keys(leaveOf(data,p.id,ds)).length)add(p.id,null,p.name)});
    return out.sort((a,b)=>a.name.localeCompare(b.name))},[v,data,ws]);
  /* make the timesheets that should exist: anyone who signed on, and anyone on leave all week */
  useEffect(()=>{rows.forEach(r=>{if(r.ts||!r.sid||made.current[r.sid])return;const so=Object.keys(r.so).length,lv=Object.keys(r.leave).length;
      if(!so&&lv<5)return;made.current[r.sid]=true;
      sb.from('timesheets').insert({staff_id:r.sid,user_id:r.uid,name:r.name,week_start:ws,days:startDays(data,r.sid,ds,r.so)}).then(({error})=>{if(error&&!/duplicate/i.test(error.message))setErr(errMsg(error));else reload()})})},[rows]);
  const flags=crewAudit(rows,ds);
  const cell=(r,k)=>{const d=r.ts&&r.ts.days[k];const f=flags[r.key+'|'+k];const so=r.so[k];
    if(d&&d.kind&&d.kind!=='work')return html`<span class="text-[11.5px] font-semibold" style=${{color:'hsl(25 80% 34%)'}}>${KIND_SHORT[d.kind]||d.kind}</span>`;
    const h=hoursOf(d);if(h)return html`<span class=${'tnum font-semibold'+(f?' px-1 rounded':'')} style=${f?{background:'hsl(38 95% 50% / .25)'}:null} title=${f||''}>${h2(h)}</span>`;
    return so?html`<span class="text-[11px] font-semibold" style=${{color:'var(--bad)'}} title="Signed on, no hours yet">no hrs</span>`:html`<span class="text-faint">–</span>`};
  const pdf=async list=>{setBusy('pdf');try{await timesheetPdf(list.filter(r=>r.ts).map(r=>({...r.ts,name:r.name})),ds)}catch(e){setErr(errMsg(e))}finally{setBusy('')}};
  const cur=open&&rows.find(r=>r.key===open);
  if(cur&&cur.ts)return html`<${PersonWeek} sb=${sb} data=${data} row=${cur} ds=${ds} flags=${flags} notify=${notify} reload=${reload} onBack=${()=>setOpen(null)} onPdf=${()=>pdf([cur])}/>`;
  const nFlag=Object.keys(flags).length,nApproved=rows.filter(r=>r.ts&&r.ts.status==='approved').length;
  return html`<div class="grid gap-3" id="ts-all">
    ${err&&html`<div class="panel px-4 py-2 text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
    <div class="panel px-4 py-3 flex flex-wrap items-center gap-3"><span class="text-[13px]"><span class="font-semibold">${rows.filter(r=>r.ts).length}</span> timesheets · ${nApproved} signed off${nFlag?html` · <span class="font-semibold" style=${{color:'hsl(30 90% 34%)'}}>${nFlag} day${nFlag===1?'':'s'} different to the crew</span>`:''}</span>
      <span class="flex-1"></span><button id="ts-pdf-week" type="button" class="btn" disabled=${!!busy||!rows.some(r=>r.ts)} onClick=${()=>pdf(rows)}>${Icon.download} ${busy==='pdf'?'Making PDF…':'Week PDF (all)'}</button></div>
    <div class="panel overflow-x-auto"><table class="w-full text-[12.5px] min-w-[860px]" id="ts-table">
      <thead><tr class="text-left">${['Name','Crew',...ds.map(k=>`${WD[parse(k).getDay()]} ${parse(k).getDate()}`),'Total','Status',''].map((h,i)=>html`<th key=${i} class=${'label font-normal py-2 px-3 whitespace-nowrap'+(i>=2&&i<=9?' text-right':'')}>${h}</th>`)}</tr></thead>
      <tbody>${rows.map(r=>{const tot=ds.reduce((a,k)=>a+hoursOf(r.ts&&r.ts.days[k]),0);
        return html`<tr key=${r.key} class="border-t border-line hover:bg-sunken cursor-pointer ts-row" onClick=${()=>r.ts&&setOpen(r.key)}>
          <td class="py-2 px-3 font-medium whitespace-nowrap">${r.name}</td><td class="py-2 px-3 text-muted whitespace-nowrap">${r.crew?r.crew.name:'–'}</td>
          ${ds.map(k=>html`<td key=${k} class="py-2 px-3 text-right">${cell(r,k)}</td>`)}
          <td class="py-2 px-3 text-right tnum font-semibold">${tot?h2(tot):'–'}</td>
          <td class="py-2 px-3 whitespace-nowrap">${r.ts?statusChip(r.ts):html`<span class="text-[11.5px] text-muted">Starting…</span>`}</td>
          <td class="py-2 px-3 text-right whitespace-nowrap">${r.ts&&html`<span class="text-[12px] font-medium" style=${{color:'var(--accent)'}}>Open ${Icon.chevR}</span>`}</td></tr>`})}
        ${!rows.length&&html`<tr><td colspan="12" class="px-3 py-6 text-center text-muted">No one has signed on or has leave this week.</td></tr>`}</tbody></table></div>
    <p class="text-[12px] text-muted px-1">A timesheet starts on someone’s first sign-on of the week (or when they’re on leave all week). Amber hours are different to the rest of that crew that day.</p>
  </div>`;
}

/* one person's week, for the supervisor: every day editable, then sign off */
function PersonWeek({sb,data,row,ds,flags,notify,reload,onBack,onPdf}){
  const ts=row.ts;const [busy,setBusy]=useState('');const [err,setErr]=useState('');
  const live=window.__ffLive;const myName=(()=>{const u=live&&live.user;const sid=live&&live.staffId;const p=sid&&data.resources.find(r=>r.id===sid);return p?p.name:(u&&typeof showLogin==='function'?showLogin(u.email):(u&&u.email)||'')})();
  const save=async patch=>{setErr('');setBusy('s');const {error}=await sb.from('timesheets').update(patch).eq('id',ts.id);setBusy('');if(error){setErr(errMsg(error));return false}reload();return true};
  const tot=ds.reduce((a,k)=>a+hoursOf(ts.days[k]),0);
  const locked=ts.status==='approved';
  return html`<div class="grid gap-3" id="ts-person">
    <div class="panel px-4 py-3 flex flex-wrap items-center gap-3">
      <button type="button" class="btn" onClick=${onBack}>${Icon.chevL} All timesheets</button>
      <div class="font-display text-[16px] font-semibold">${row.name}</div>${statusChip(ts)}
      <span class="flex-1"></span><span class="text-[13px]">Total <span class="font-semibold tnum">${h2(tot)} h</span></span>
      <button type="button" class="btn" onClick=${onPdf}>${Icon.download} PDF</button></div>
    ${err&&html`<div class="panel px-4 py-2 text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
    ${ds.map(k=>html`<${DayCard} key=${k} k=${k} d=${ts.days[k]} signed=${row.so[k]} editable=${!locked} mgr=${!locked} audit=${flags[row.key+'|'+k]}
      onSave=${nd=>save({days:{...ts.days,[k]:{...(ts.days[k]||{}),...(row.so[k]&&row.so[k][0]&&!(ts.days[k]||{}).crew_id?{pack_id:row.so[k][0].pack.id,block_id:row.so[k][0].pack.block_id,crew_id:row.so[k][0].crewId,job:row.so[k][0].label}:{}),...nd}}})}/>`)}
    <div class="panel px-4 py-3 flex flex-wrap items-center gap-2">
      <span class="text-[12.5px] text-muted flex-1">${locked?`Signed off${ts.approved_name?' by '+ts.approved_name:''}${ts.approved_at?' on '+new Date(ts.approved_at).toLocaleDateString('en-AU'):''}.`:'Check each day (amber ones are different to the crew), then sign off the week.'}</span>
      ${locked?html`<button type="button" class="btn" disabled=${!!busy} onClick=${async()=>{if(await save({status:'open'}))notify('Timesheet reopened')}}>Reopen</button>`
        :html`<button id="ts-approve" type="button" class="btn btn-primary" disabled=${!!busy} onClick=${async()=>{if(await save({status:'approved',approved_name:myName}))notify(`${row.name}’s timesheet signed off`)}}>Sign off week</button>`}</div>
  </div>`;
}

/* ---------- PDF for admin: one page per person ---------- */
async function timesheetPdf(list,ds){
  if(!list.length)throw new Error('No timesheets to export.');
  const Jp=await loadJsPDF();const doc=new Jp({orientation:'p',unit:'mm',format:'a4'});const M=14;
  list.forEach((ts,i)=>{if(i)doc.addPage();let y=18;
    doc.setFont('helvetica','bold');doc.setFontSize(15);doc.text('Timesheet',M,y);doc.setFontSize(11);doc.text(ts.name||'',196,y,{align:'right'});y+=6;
    doc.setFont('helvetica','normal');doc.setFontSize(9.5);doc.text(`Week ${dayName(ds[0])} – ${dayName(ds[6])} ${parse(ds[6]).getFullYear()}  ·  Alex Fraser Group`,M,y);y+=8;
    const cols=[['Day',26],['Job / leave',70],['Start',16],['Finish',16],['Break',16],['Hours',16],['Notes',26]];
    doc.setFillColor(153,10,44);doc.rect(M,y-4.5,182,7,'F');doc.setTextColor(255);doc.setFont('helvetica','bold');let x=M+1.5;cols.forEach(([h,w])=>{doc.text(h,x,y);x+=w});doc.setTextColor(0);doc.setFont('helvetica','normal');y+=7;
    let tot=0;ds.forEach(k=>{const d=ts.days[k]||{};const h=hoursOf(d);tot+=h;const leave=d.kind&&d.kind!=='work';
      const row=[dayName(k),leave?kindLabel(d.kind):(d.job||''),leave?'':d.start||'',leave?'':d.finish||'',leave||!d.start?'':(d.break||0)+' min',h?h2(h):'',d.notes||''];
      x=M+1.5;row.forEach((t,j)=>{const w=cols[j][1];doc.text(doc.splitTextToSize(String(t),w-2)[0]||'',x,y);x+=w});doc.setDrawColor(220);doc.line(M,y+2.2,M+182,y+2.2);y+=8});
    doc.setFont('helvetica','bold');doc.text('Total hours',M+1.5,y);doc.text(h2(tot),M+1.5+26+70+16+16+16,y);doc.setFont('helvetica','normal');y+=12;
    doc.text(ts.status==='approved'?`Signed off${ts.approved_name?' by '+ts.approved_name:''}${ts.approved_at?' on '+new Date(ts.approved_at).toLocaleDateString('en-AU'):''}`:'NOT YET SIGNED OFF',M,y);
  });
  const name=`Timesheets ${ds[0]}${list.length===1?' '+list[0].name:''}.pdf`.replace(/[\\/:*?"<>|]+/g,'-');
  const dl=await window.claude.use('downloads');await dl.save({filename:name,data:doc.output('blob')});
}

window.TimesheetsScreen=TimesheetsScreen;
})();
