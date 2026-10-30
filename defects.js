/* =====================================================================
   FraserFlow: Defects (Phase 4 of Fleet & Maintenance)
   Loaded after maint.js and prestart.js. Uses the tables made by supabase/defects.sql.
   - Fleet › Defects: the defect register
   - Defect dialog: acknowledge, severity, work order, repaired, verify, dismiss, reopen
   - Machine panel: restriction banner (release = return to service) and open defects
   Failed prestart items become defects in the database itself; a critical one restricts the machine.
   ===================================================================== */
(function(){
const {Modal,Fld,fs,errMsg,fmtTs}=window.FFM;
const DST={reported:['Reported','hsl(30 90% 42%)'],acknowledged:['Waiting for repair','hsl(30 90% 42%)'],in_repair:['In repair','hsl(212 75% 45%)'],
  repaired:['Repaired: to verify','hsl(262 55% 50%)'],closed:['Verified & closed','hsl(145 55% 34%)'],dismissed:['Dismissed','var(--muted)']};
const SEV={minor:['Minor','hsl(220 9% 46%)'],major:['Major','hsl(30 90% 42%)'],critical:['Critical','hsl(0 72% 47%)']};
const OPEN=s=>!['closed','dismissed'].includes(s);
const dNo=d=>'D-'+d.number;
const chip=([l,c],id)=>html`<span id=${id} class="inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style=${{color:c,background:'var(--sunken)',boxShadow:`inset 0 0 0 1px ${c}`}}>${l}</span>`;
const sevChip=s=>chip(SEV[s]||SEV.major);
const stChip=s=>chip(DST[s]||DST.reported);
const fmtDT=t=>t?new Date(t).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'';
const PRI_FOR={critical:'urgent',major:'high',minor:'medium'};
const ta={height:'auto',minHeight:60,padding:'8px 10px',fontSize:13};

/* ---------- report a defect by hand ---------- */
function NewDefectDialog({ctx,a,onClose}){
  const {sb,notify,reload}=ctx;const [f,setF]=useState({title:'',description:'',severity:'major'});const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const save=async()=>{if(!f.title.trim()){setErr('Say what the defect is.');return}setBusy(true);setErr('');
    const {error}=await sb.from('defects').insert({asset_id:a.m.id,title:f.title.trim(),description:f.description.trim()||null,severity:f.severity});setBusy(false);
    if(error){setErr(errMsg(error));return}notify(f.severity==='critical'?'Defect reported: the machine is now restricted':'Defect reported');reload();onClose()};
  return html`<${Modal} title="Report a defect" sub=${`${a.m.name} · ${a.m.sub||''}`} onClose=${onClose}
    foot=${html`${err&&html`<span class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="nd-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>Report defect</button>`}>
    <div class="grid gap-3">
      <${Fld} label="Defect"><input id="nd-title" class="field" style=${fs} placeholder="e.g. Cracked windscreen" value=${f.title} onInput=${e=>setF({...f,title:e.target.value})}/><//>
      <${Fld} label="Details"><textarea class="field" rows="3" style=${ta} value=${f.description} onInput=${e=>setF({...f,description:e.target.value})}></textarea><//>
      <${Fld} label="Severity"><div class="seg w-max">${Object.entries(SEV).map(([k,[l]])=>html`<button key=${k} id=${'nd-sev-'+k} type="button" aria-pressed=${f.severity===k} onClick=${()=>setF({...f,severity:k})}>${l}</button>`)}</div><//>
      ${f.severity==='critical'&&html`<p class="text-[12.5px] font-medium" style=${{color:SEV.critical[1]}}>A critical defect restricts the machine: it must not be used until the repair is verified and an administrator returns it to service.</p>`}
    </div><//>`;
}

/* ---------- one defect ---------- */
function DefectDialog({ctx,d,onClose,open}){
  const {sb,notify,reload,perms,M,db}=ctx;const a=M.byId.get(d.asset_id);
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [ask,setAsk]=useState(null);const [txt,setTxt]=useState('');
  const urls=window.FFP&&window.FFP.useSigned?window.FFP.useSigned(sb,d.photos||[]):{};
  const wo=d.work_order_id&&db.work_orders.find(w=>w.id===d.work_order_id);
  const restr=(db.restrictions||[]).find(r=>r.defect_id===d.id&&r.active);
  const openWos=db.work_orders.filter(w=>w.asset_id===d.asset_id&&!['completed','closed','cancelled'].includes(w.status));
  const ps=d.prestart_id&&db.prestarts.find(p=>p.id===d.prestart_id);
  const upd=async(patch,msg)=>{setBusy(true);setErr('');const {error}=await sb.from('defects').update(patch).eq('id',d.id);setBusy(false);
    if(error){setErr(errMsg(error));return false}notify(msg);reload();setAsk(null);setTxt('');return true};
  const isOpen=OPEN(d.status);
  const acts=[];
  if(perms.work&&d.status==='reported')acts.push(['ack','Acknowledge',()=>upd({status:'acknowledged'},`${dNo(d)} acknowledged`)]);
  if(perms.work&&isOpen&&!d.work_order_id)acts.push(['wo','Raise work order',()=>{onClose();open({k:'wo',init:{asset_id:d.asset_id,wo_type:'defect',title:d.title,description:[`${dNo(d)}: ${d.title}`,d.description].filter(Boolean).join('\n\n'),priority:PRI_FOR[d.severity]||'high',defect_ids:[d.id]}})}]);
  if(perms.work&&isOpen&&!d.work_order_id&&d.status!=='repaired')acts.push(['fixed','Fixed on the spot…',()=>{setAsk('repaired');setTxt('')}]);
  if(perms.verify&&d.status==='repaired')acts.push(['verify','Verify & close',()=>upd({status:'closed'},`${dNo(d)} verified and closed`)]);
  if(perms.verify&&isOpen)acts.push(['dismiss','Dismiss…',()=>{setAsk('dismissed');setTxt('')}]);
  if(perms.mgr&&!isOpen)acts.push(['reopen','Reopen',()=>upd({status:'acknowledged'},`${dNo(d)} reopened`)]);
  return html`<${Modal} title=${html`<span class="inline-flex items-center gap-2 flex-wrap">${dNo(d)} · ${d.title} ${sevChip(d.severity)}</span>`} sub=${`${a?a.m.name+' · '+(a.m.sub||''):d.asset_id} · reported ${fmtDT(d.created_at)} by ${d.reported_name}`} onClose=${onClose}
    foot=${ask?html`<input id="df-reason" class="field flex-1 min-w-[220px]" style=${fs} placeholder=${ask==='repaired'?'What was done to fix it?':'Why dismiss it? e.g. Not a fault, duplicate'} value=${txt} onInput=${e=>setTxt(e.target.value)} aria-label="Reason"/>
        <button type="button" class="btn" onClick=${()=>setAsk(null)}>Back</button>
        <button id="df-confirm" type="button" class="btn btn-primary" disabled=${busy} onClick=${()=>{if(!txt.trim()){setErr(ask==='repaired'?'Say what was done.':'Give a reason.');return}upd({status:ask,resolution:txt.trim()},ask==='repaired'?`${dNo(d)} marked repaired: waiting for verification`:`${dNo(d)} dismissed`)}}>${ask==='repaired'?'Mark repaired':'Dismiss defect'}</button>`
      :html`${stChip(d.status)}<span class="flex-1"></span>${acts.map(([k,l,fn])=>html`<button key=${k} id=${'df-'+k} type="button" class=${'btn'+(k==='wo'||k==='verify'?' btn-primary':'')} disabled=${busy} onClick=${fn} style=${k==='dismiss'?{color:'var(--muted)'}:null}>${l}</button>`)}`}>
    <div class="grid gap-3" id="df-view">
      ${err&&html`<div id="df-err" class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      ${restr&&html`<div class="rounded-lg px-3 py-2 text-[12.5px] font-medium" style=${{background:'hsl(0 80% 96%)',color:'hsl(0 72% 38%)'}}>This defect restricts ${a?a.m.name:'the machine'}: it must not be used. ${d.status==='closed'||d.status==='dismissed'?'An administrator can now return it to service from the machine panel.':'Once the repair is verified, an administrator returns it to service.'}</div>`}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-[12.5px]">
        ${[['Status',DST[d.status][0]],['Reported',d.times_reported>1?`${d.times_reported} times, last ${fmtDT(d.last_reported_at)}`:'Once'],['Source',d.source==='prestart'?'Prestart':'Reported by hand'],['Work order',wo?`WO ${wo.number}`:'None']].map(([k,v])=>html`<div key=${k}><span class="text-muted">${k}</span><div>${v}</div></div>`)}
      </div>
      ${perms.work&&isOpen&&html`<div class="flex flex-wrap items-center gap-2 text-[12.5px]"><span class="text-muted">Severity</span>
        <div class="seg">${Object.entries(SEV).map(([k,[l]])=>html`<button key=${k} id=${'df-sev-'+k} type="button" aria-pressed=${d.severity===k} disabled=${busy} onClick=${()=>d.severity!==k&&upd({severity:k},k==='critical'?`${dNo(d)} is now critical: the machine is restricted`:`${dNo(d)} severity: ${l}`)}>${l}</button>`)}</div>
        ${!d.work_order_id&&openWos.length>0&&html`<span class="text-muted ml-2">Add to</span><select id="df-addwo" class="field w-auto" style=${fs} value="" onChange=${e=>e.target.value&&upd({work_order_id:e.target.value},`${dNo(d)} added to the work order`)}><option value="">an open work order…</option>${openWos.map(w=>html`<option key=${w.id} value=${w.id}>WO ${w.number} · ${w.title}</option>`)}</select>`}</div>`}
      ${d.description&&html`<div class="grid gap-1"><div class="label">What was reported</div><div class="text-[13px] whitespace-pre-line">${d.description}</div></div>`}
      ${(d.photos||[]).length>0&&html`<div class="flex flex-wrap gap-2">${d.photos.map(p=>html`<a key=${p} href=${urls[p]||'#'} target="_blank" rel="noopener"><img src=${urls[p]||''} alt="Photo" class="w-24 h-24 rounded-lg object-cover border border-line bg-sunken"/></a>`)}</div>`}
      ${d.resolution&&html`<div class="grid gap-1"><div class="label">${d.status==='dismissed'?'Why it was dismissed':'Repair'}</div><div class="text-[13px] whitespace-pre-line">${d.resolution}</div>
        <div class="text-[12px] text-muted">${[d.repaired_at&&'Repaired '+fmtDT(d.repaired_at),d.closed_at&&(d.status==='dismissed'?'Dismissed ':'Verified ')+fmtDT(d.closed_at)].filter(Boolean).join(' · ')}</div></div>`}
      <div class="flex flex-wrap gap-3 text-[12.5px]">
        ${ps&&html`<button type="button" class="hover:underline" style=${{color:'var(--accent)'}} onClick=${()=>open({k:'ps',ps})}>Open the prestart that reported it</button>`}
        ${wo&&html`<button type="button" class="hover:underline" style=${{color:'var(--accent)'}} onClick=${()=>open({k:'wo',wo})}>Open WO ${wo.number} (${({open:'open',scheduled:'scheduled',in_progress:'in progress',awaiting_parts:'awaiting parts',completed:'completed',closed:'verified',cancelled:'cancelled'})[wo.status]})</button>`}
      </div>
      ${d.status==='repaired'&&!perms.verify&&html`<p class="text-[12px] text-muted">A supervisor or administrator verifies the repair.</p>`}
    </div><//>`;
}

/* ---------- Fleet › Defects: the register ---------- */
function DefectsTab({ctx,open}){
  const {db,M,perms}=ctx;const [view,setView]=useState('open');const [sev,setSev]=useState('');const [q,setQ]=useState('');
  if(!db.p4)return html`<div class="panel p-6 grid gap-2 max-w-[640px]"><div class="font-display text-[17px] font-semibold">Defects aren’t set up yet</div><p class="text-[13px] text-muted">An administrator needs to run <span class="mono">supabase/defects.sql</span> once in Supabase → SQL Editor (after prestarts.sql).</p><p class="text-[12px] text-faint mono">${db.p4err||''}</p></div>`;
  const ql=q.trim().toLowerCase();
  const rows=db.defects.filter(d=>(view==='all'||(view==='open'?OPEN(d.status):!OPEN(d.status)))&&(!sev||d.severity===sev)&&(!ql||[dNo(d),d.title,d.reported_name,(M.byId.get(d.asset_id)||{m:{}}).m.name].join(' ').toLowerCase().includes(ql)))
    .sort((x,y)=>view==='open'?(['critical','major','minor'].indexOf(x.severity)-['critical','major','minor'].indexOf(y.severity))||(y.number-x.number):y.number-x.number);
  const openAll=db.defects.filter(d=>OPEN(d.status));const restricted=new Set(db.restrictions.filter(r=>r.active).map(r=>r.asset_id));
  return html`<section class="panel flex flex-col min-h-0">
    <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line">
      <div class="seg" role="group" aria-label="Show"><button type="button" aria-pressed=${view==='open'} onClick=${()=>setView('open')}>Open</button><button type="button" aria-pressed=${view==='done'} onClick=${()=>setView('done')}>Closed</button><button type="button" aria-pressed=${view==='all'} onClick=${()=>setView('all')}>All</button></div>
      <select class="field w-auto" style=${fs} value=${sev} onChange=${e=>setSev(e.target.value)} aria-label="Severity"><option value="">All severities</option>${Object.entries(SEV).map(([k,[l]])=>html`<option key=${k} value=${k}>${l}</option>`)}</select>
      <input id="df-search" class="field" style=${{...fs,width:220}} placeholder="Search defect, machine, who reported" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search defects"/>
      <span class="flex-1"></span><span class="text-[12.5px] text-muted"><span class="font-semibold text-ink">${openAll.length}</span> open · <span class="font-semibold" style=${{color:SEV.critical[1]}}>${openAll.filter(d=>d.severity==='critical').length}</span> critical · ${restricted.size} machine${restricted.size===1?'':'s'} restricted</span>
    </div>
    <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="df-table">
      <thead><tr class="text-left">${['No.','Machine','Defect','Severity','Status','Reported','Seen','Work order'].map(h=>html`<th key=${h} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
      <tbody>${rows.map(d=>{const a=M.byId.get(d.asset_id);const wo=d.work_order_id&&db.work_orders.find(w=>w.id===d.work_order_id);
        return html`<tr key=${d.id} class="border-t border-line cursor-pointer hover:bg-sunken" tabindex="0" onClick=${()=>open({k:'defect',d})} onKeyDown=${e=>{if(e.key==='Enter')open({k:'defect',d})}}>
          <td class="py-2 px-3 mono whitespace-nowrap">${dNo(d)}</td>
          <td class="py-2 px-3 whitespace-nowrap"><span class="font-medium">${a?a.m.name:d.asset_id}</span>${restricted.has(d.asset_id)&&html` <span class="text-[10.5px] font-bold uppercase tracking-wide px-1 rounded" style=${{background:SEV.critical[1],color:'#fff'}} title="Restricted: must not be used">Restricted</span>`}</td>
          <td class="py-2 px-3 min-w-[220px]">${d.title}</td>
          <td class="py-2 px-3">${sevChip(d.severity)}</td><td class="py-2 px-3">${stChip(d.status)}</td>
          <td class="py-2 px-3 whitespace-nowrap">${fmtDT(d.created_at)} <span class="text-muted">· ${d.reported_name}</span></td>
          <td class="py-2 px-3 tnum">${d.times_reported>1?html`<span class="font-semibold">${d.times_reported}×</span>`:'1'}</td>
          <td class="py-2 px-3 whitespace-nowrap">${wo?`WO ${wo.number}`:html`<span class="text-faint">–</span>`}</td></tr>`})}
        ${!rows.length&&html`<tr><td colspan="8" class="px-3 py-6 text-center text-muted">${view==='open'?'No open defects.':'Nothing here yet.'}</td></tr>`}</tbody></table></div>
    ${!perms.work&&html`<p class="px-3 py-2 text-[12px] text-muted">Mechanics, supervisors and administrators work on defects.</p>`}
  </section>`;
}

/* ---------- machine panel: restriction (return to service) and open defects ---------- */
function RestrictionBanner({ctx,a}){
  const {db,sb,perms,notify,reload}=ctx;const [note,setNote]=useState(null);const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [add,setAdd]=useState(null);
  if(!db.p4)return null;
  const rs=db.restrictions.filter(r=>r.asset_id===a.m.id&&r.active);
  const release=async r=>{setBusy(true);setErr('');const {error}=await sb.from('restrictions').update({active:false,release_note:(note||'').trim()||null}).eq('id',r.id);setBusy(false);
    if(error){setErr(errMsg(error));return}setNote(null);notify(`${a.m.name} returned to service`);reload()};
  const restrict=async()=>{if(!(add||'').trim()){setErr('Give the reason.');return}setBusy(true);setErr('');const {error}=await sb.from('restrictions').insert({asset_id:a.m.id,reason:add.trim()});setBusy(false);
    if(error){setErr(errMsg(error));return}setAdd(null);notify(`${a.m.name} restricted`);reload()};
  if(!rs.length)return perms.mgr?html`<div class="flex justify-end -mb-2">${add==null?html`<button id="ap-restrict" type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>setAdd('')}>Take out of service…</button>`
    :html`<div class="flex flex-wrap items-center gap-2 w-full"><input id="ap-restrict-reason" class="field flex-1" style=${fs} placeholder="Why must it not be used?" value=${add} onInput=${e=>setAdd(e.target.value)}/><button type="button" class="btn" onClick=${()=>setAdd(null)}>Cancel</button><button id="ap-restrict-go" type="button" class="btn" style=${{color:'var(--bad)'}} disabled=${busy} onClick=${restrict}>Restrict machine</button>${err&&html`<span class="text-[12px] w-full" style=${{color:'var(--bad)'}}>${err}</span>`}</div>`}</div>`:null;
  return html`<section id="ap-restriction" class="rounded-lg p-3 grid gap-2" style=${{background:'hsl(0 80% 96%)',boxShadow:'inset 0 0 0 1.5px hsl(0 72% 47%)'}}>
    <div class="font-display text-[15px] font-semibold" style=${{color:'hsl(0 72% 38%)'}}>Restricted: do not use this machine</div>
    ${rs.map(r=>{const d=r.defect_id&&db.defects.find(x=>x.id===r.defect_id);const ready=!d||!OPEN(d.status);
      return html`<div key=${r.id} class="grid gap-1.5 text-[12.5px]"><div>${r.reason} <span class="text-muted">· since ${fmtDT(r.created_at)}</span></div>
        ${perms.mgr?(ready?(note==null?html`<div><button id="ap-release" type="button" class="btn" style=${{height:32}} onClick=${()=>setNote('')}>Return to service…</button></div>`
            :html`<div class="flex flex-wrap items-center gap-2"><input id="ap-release-note" class="field flex-1 min-w-[200px]" style=${fs} placeholder="Note (optional), e.g. Tested on site" value=${note} onInput=${e=>setNote(e.target.value)}/><button type="button" class="btn" onClick=${()=>setNote(null)}>Cancel</button><button id="ap-release-go" type="button" class="btn btn-primary" disabled=${busy} onClick=${()=>release(r)}>Return to service</button></div>`)
          :html`<div class="text-muted">It can go back into service once ${d?`${dNo(d)} is repaired and the repair verified`:'the problem is fixed'}.</div>`)
          :html`<div class="text-muted">An administrator returns it to service once the repair is verified.</div>`}</div>`})}
    ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
  </section>`;
}
function AssetDefects({ctx,a,open}){
  const {db,perms}=ctx;if(!db.p4)return null;
  const ds=db.defects.filter(d=>d.asset_id===a.m.id&&OPEN(d.status)).sort((x,y)=>['critical','major','minor'].indexOf(x.severity)-['critical','major','minor'].indexOf(y.severity)||y.number-x.number);
  return html`<section class="grid gap-2" id="ap-defects"><div class="flex items-baseline gap-2"><h3 class="font-display text-[15px] font-semibold">Open defects</h3><span class="text-[12px] text-muted">${ds.length}</span><span class="flex-1"></span>
      ${perms.work&&html`<button id="ap-newdefect" type="button" class="text-[12px] text-muted hover:text-ink inline-flex items-center gap-1" onClick=${()=>open({k:'newdefect',a})}>${Icon.plus} Report a defect</button>`}</div>
    ${!ds.length?html`<div class="text-[12.5px] text-muted">None.</div>`:html`<div class="rounded-lg border border-line divide-y" style=${{borderColor:'var(--line)'}}>${ds.map(d=>html`<button key=${d.id} type="button" class="w-full text-left px-3 py-2 flex flex-wrap items-center gap-2 hover:bg-sunken" style=${{borderColor:'var(--line)'}} onClick=${()=>open({k:'defect',d})}>
      <span class="mono text-[12px] text-muted">${dNo(d)}</span><span class="text-[13px] font-medium flex-1 min-w-0 truncate">${d.title}</span>${d.times_reported>1&&html`<span class="text-[12px] text-muted">${d.times_reported}×</span>`}${sevChip(d.severity)}${stChip(d.status)}</button>`)}</div>`}
  </section>`;
}

/* which open defects a work order can carry, for the work order dialog */
const woDefects=(db,asset,woId)=>(db.defects||[]).filter(d=>d.asset_id===asset&&OPEN(d.status)&&(!d.work_order_id||d.work_order_id===woId));

window.FFD={DefectsTab,DefectDialog,NewDefectDialog,RestrictionBanner,AssetDefects,woDefects,sevChip,stChip,dNo,OPEN,SEV,DST};
})();
