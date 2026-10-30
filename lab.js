/* =====================================================================
   FraserFlow: Lab (in progress). Every shift already worked, by job, with what was actually laid
   (from the submitted QA pack: tonnes from the laying record, m² from the site diagram layers),
   the QA pack PDFs, and the lab's reports (uploaded per job, or per shift).
   Database: supabase/lab.sql. Loaded with the Fleet files (after qa.js and qaforms.js).
   ===================================================================== */
(function(){
const {Modal,Fld,fs,errMsg}=window.FFM;
const BUCKET='lab';
const n0=v=>{const x=parseFloat(String(v==null?'':v).replace(/,/g,''));return isFinite(x)?x:0};
const f1=v=>v?fmtN(Math.round(v*10)/10):'–';
const KINDS=[['asphalt','Asphalt report'],['core','Core report'],['ncr','NCR']];const kindLabel=k=>(KINDS.find(x=>x[0]===k)||[,'Lab report'])[1];
const UPLOAD_ROLES=['admin','superuser','planner','lab'];
const ACCEPT='application/pdf,image/jpeg,image/png,image/webp,.xlsx,.xls,.csv,.docx';
const OK_TYPE=/^(application\/pdf|image\/(jpeg|png|webp)|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document)|application\/vnd\.ms-excel|text\/csv)$/;

/* what a submitted pack says was laid */
function laidOf(p){const F=(p&&p.forms)||{};const L=F.laying||{};const D=F.diagram||{};
  const rows=(L.rows||[]).filter(r=>n0(r.tonnes)>0);
  const layers=Array.isArray(D.layers)&&D.layers.length?D.layers:[{area:D.area,mix:D.mix}];
  return {t:rows.reduce((a,r)=>a+n0(r.tonnes),0),loads:rows.length,a:layers.reduce((a,l)=>a+n0(l.area),0),mixes:[...new Set(layers.map(l=>(l.mix||'').trim()).filter(Boolean))]}}
const plannedOf=(b,k)=>{const ls=linesOf((b.shiftData||{})[k]).filter(lineHas);return {t:ls.reduce((a,l)=>a+num(l.tonnes),0),a:ls.reduce((a,l)=>a+num(l.area),0)}};

function useLab(sb,from){
  const [v,setV]=useState(null);const [err,setErr]=useState('');
  const load=async()=>{try{
      const {data:packs,error}=await sb.from('qa_packs').select('*').gte('shift_date',from);if(error)throw error;
      let reports=[],rErr='';try{const r=await sb.from('lab_reports').select('*');if(r.error)throw r.error;reports=r.data||[]}catch(e){rErr=errMsg(e)}
      setV({packs:packs||[],reports,rErr});setErr('')}catch(e){setErr(errMsg(e))}};
  useEffect(()=>{load();let ch=null,t=null;try{ch=sb.channel('lab-'+Math.random().toString(36).slice(2));['qa_packs','lab_reports'].forEach(tb=>ch.on('postgres_changes',{event:'*',schema:'public',table:tb},()=>{clearTimeout(t);t=setTimeout(load,500)}));ch.subscribe()}catch(e){}
    return()=>{clearTimeout(t);try{ch&&sb.removeChannel(ch)}catch(e){}}},[from]);
  return {v,err,reload:load};
}

function LabScreen({data,live,notify}){
  const sb=live.sb;const canUp=UPLOAD_ROLES.includes(live.role);const mgr=live.role==='admin'||live.role==='superuser';
  const [days,setDays]=useState(90);const [q,setQ]=useState('');const [open,setOpen]=useState(null);const [busy,setBusy]=useState('');const [msg,setMsg]=useState('');const [up,setUp]=useState(null);
  const today=iso(TODAY);const from=iso(addDays(TODAY,-days));
  const {v,err,reload}=useLab(sb,from);
  /* every shift already worked, by job */
  const jobs=useMemo(()=>{const by=new Map();
    const seen=new Set();
    data.blocks.filter(b=>b.kind==='job'&&b.jobId).forEach(b=>{const ks=new Set(shiftDates(b).filter(k=>k<=today&&k>=from));
      /* a submitted pack counts even if its booking has since been moved or shortened */
      if(v)v.packs.forEach(p=>{if(p.block_id===b.id&&p.status==='submitted'&&p.shift_date>=from)ks.add(p.shift_date)});
      [...ks].forEach(k=>{seen.add(b.id+'|'+k);
      const j=data.jobs.find(x=>x.id===b.jobId);if(!j)return;const crewId=coverOf(b,k)||b.resourceId;
      const ps=v?v.packs.filter(p=>p.block_id===b.id&&p.shift_date===k):[];const sub=ps.filter(p=>p.status==='submitted');
      const laid=sub.map(laidOf).reduce((a,x)=>({t:a.t+x.t,a:a.a+x.a,loads:a.loads+x.loads,mixes:[...new Set([...a.mixes,...x.mixes])]}),{t:0,a:0,loads:0,mixes:[]});
      const o=by.get(j.id)||{j,shifts:[]};o.shifts.push({e:{b,k,crewId},crew:data.resources.find(r=>r.id===crewId),plan:plannedOf(b,k),packs:ps,sub,laid});by.set(j.id,o)})});
    return [...by.values()].map(o=>({...o,shifts:o.shifts.sort((x,y)=>y.e.k.localeCompare(x.e.k)||(x.crew&&y.crew?x.crew.name.localeCompare(y.crew.name):0)),
      last:o.shifts.reduce((m,s)=>s.e.k>m?s.e.k:m,''),t:o.shifts.reduce((a,s)=>a+s.laid.t,0),a:o.shifts.reduce((a,s)=>a+s.laid.a,0),nSub:o.shifts.filter(s=>s.sub.length).length}))
      .sort((x,y)=>y.last.localeCompare(x.last))},[data.blocks,data.jobs,v,from]);
  const ql=q.trim().toLowerCase();
  const shown=jobs.filter(o=>!ql||[o.j.name,o.j.customer,o.j.address,o.j.projectNo].join(' ').toLowerCase().includes(ql));
  const reportsFor=(jobId,k)=>((v&&v.reports)||[]).filter(r=>r.job_id===jobId&&(k===undefined?true:k===null?!r.shift_date:r.shift_date===k)).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  const pdfs=async(list,label)=>{if(!list.length)return;setBusy(label);setMsg('');
    try{const ids=list.map(x=>x.p.id);const {data:sigs,error}=await sb.from('qa_signatures').select('*').in('pack_id',ids);if(error)throw error;
      for(const x of list){await window.FFQ.packPdf(data,x.e,x.p,sigs||[]);await new Promise(r=>setTimeout(r,400))}}
    catch(e){setMsg(errMsg(e))}finally{setBusy('')}};
  const openFile=async r=>{const w=window.open('','_blank');try{const {data:d,error}=await sb.storage.from(BUCKET).createSignedUrl(r.path,600);if(error||!d)throw error||new Error('Couldn’t open that file.');if(w)w.location=d.signedUrl;else location.href=d.signedUrl}catch(e){if(w)w.close();setMsg(errMsg(e))}};
  const delFile=async r=>{const {error}=await sb.from('lab_reports').delete().eq('id',r.id);if(error){setMsg(errMsg(error));return}try{await sb.storage.from(BUCKET).remove([r.path])}catch(e){}notify&&notify('Lab report removed');reload()};
  const setupMsg=v&&v.rErr&&/lab_reports|relation|schema cache/.test(v.rErr);

  const Rep=({r})=>html`<div class="flex items-center gap-2 text-[12.5px] lab-report"><span class="text-muted shrink-0">${Icon.download}</span>
    <button type="button" class="hover:underline text-left min-w-0 flex-1 truncate" onClick=${()=>openFile(r)}>${r.name}</button>
    <span class="text-[11px] font-semibold px-1.5 rounded shrink-0" style=${{background:'var(--accent-soft)',color:'var(--accent)'}}>${kindLabel(r.kind)}</span>
    <span class="text-[11.5px] text-muted whitespace-nowrap">${r.shift_date?fmtShort(parse(r.shift_date))+' · ':''}${new Date(r.created_at).toLocaleDateString('en-AU',{day:'numeric',month:'short'})}${r.note?' · '+r.note:''}</span>
    ${(mgr||(canUp&&r.created_by===live.user.id))&&html`<button type="button" class="p-1 rounded text-muted hover:text-ink" aria-label=${'Remove '+r.name} onClick=${()=>delFile(r)}>${Icon.x}</button>`}</div>`;

  return html`<div class="flex-1 min-h-0 overflow-y-auto grid gap-3 content-start" id="lab">
    <section class="panel px-4 py-3 flex flex-wrap items-center gap-2">
      <div class="min-w-0 flex-1"><div class="font-display text-[16px] font-semibold">Lab</div><div class="text-[12.5px] text-muted">Shifts already worked, by job: what was laid (from the submitted QA pack), the QA, and lab reports.</div></div>
      <input id="lab-search" class="field" style=${{...fs,width:220}} placeholder="Search job, customer, project" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search jobs"/>
      <select id="lab-days" class="field w-auto" style=${fs} value=${days} onChange=${e=>setDays(+e.target.value)} aria-label="How far back">${[[30,'Last 30 days'],[90,'Last 90 days'],[180,'Last 6 months'],[365,'Last 12 months']].map(([d,l])=>html`<option key=${d} value=${d}>${l}</option>`)}</select>
    </section>
    ${setupMsg&&html`<div class="panel px-4 py-3 text-[12.5px]" style=${{color:'hsl(30 90% 36%)'}}>Lab reports aren’t set up yet: an administrator needs to run <span class="mono">supabase/lab.sql</span> in Supabase.</div>`}
    ${(err||msg)&&html`<div class="panel px-4 py-3 text-[12.5px]" style=${{color:'var(--bad)'}} id="lab-err">${msg||err}</div>`}
    ${!v&&!err&&html`<div class="panel p-6 text-[13px] text-muted">Loading…</div>`}
    ${v&&!shown.length&&html`<div class="panel p-6 text-center text-[13px] text-muted">${ql?`Nothing matches “${q}”.`:'No shifts worked in this period.'}</div>`}
    ${v&&shown.map(o=>{const isOpen=open===o.j.id||(shown.length===1);const allSub=o.shifts.flatMap(s=>s.sub.map(p=>({e:s.e,p})));const jr=reportsFor(o.j.id);
      return html`<section key=${o.j.id} class="panel overflow-hidden lab-job" data-job=${o.j.id}>
        <button type="button" class="w-full text-left px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 hover:bg-sunken lab-job-head" aria-expanded=${isOpen} onClick=${()=>setOpen(isOpen?null:o.j.id)}>
          <span class="w-2.5 h-2.5 rounded-sm shrink-0" style=${{background:`hsl(${o.j.hue??200} 60% 55%)`}}></span>
          <span class="min-w-0 flex-1"><span class="block font-medium text-[14px] truncate">${jobLabel(o.j)}</span><span class="block text-[12px] text-muted truncate">${[o.j.projectNo&&'P '+o.j.projectNo,o.j.address].filter(Boolean).join(' · ')||'No address'}</span></span>
          <span class="text-[12.5px] text-muted whitespace-nowrap">${o.shifts.length} shift${o.shifts.length===1?'':'s'} · QA ${o.nSub}/${o.shifts.length}</span>
          <span class="text-[13px] font-semibold tnum whitespace-nowrap lab-job-t">${f1(o.t)} t</span><span class="text-[13px] font-semibold tnum whitespace-nowrap">${f1(o.a)} m²</span>
          <span class="text-[12px] text-muted whitespace-nowrap">${jr.length} lab report${jr.length===1?'':'s'}</span>
          <span class="text-muted" style=${{transform:isOpen?'rotate(180deg)':null}}>${Icon.chevD}</span></button>
        ${isOpen&&html`<div class="border-t border-line px-4 py-3 grid gap-3">
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn lab-qa-all" disabled=${!allSub.length||!!busy} onClick=${()=>pdfs(allSub,o.j.id)}>${Icon.download} ${busy===o.j.id?'Making PDFs…':`Download QA (${allSub.length} pack${allSub.length===1?'':'s'})`}</button>
            ${canUp&&!setupMsg&&KINDS.map(([kk,l])=>html`<button key=${kk} type="button" class=${'btn btn-primary lab-upload lab-upload-'+kk} onClick=${()=>setUp({job:o.j,shifts:o.shifts.map(s=>s.e.k),kind:kk,n:Date.now()})}>${Icon.plus} ${({asphalt:'Upload Asphalt Report',core:'Upload Core Report',ncr:'Upload NCR'})[kk]}</button>`)}</div>
          <div class="overflow-x-auto"><table class="w-full text-[12.5px] min-w-[720px]">
            <thead><tr class="text-left">${['Shift','Crew','Planned','Laid (QA)','Area m² (QA)','Loads','QA',''].map((h,i)=>html`<th key=${i} class=${'label font-normal py-1.5 pr-3 whitespace-nowrap'+(i>=2&&i<=5?' text-right':'')}>${h}</th>`)}</tr></thead>
            <tbody>${o.shifts.map(s=>{const sr=reportsFor(o.j.id,s.e.k);const draft=s.packs.length&&!s.sub.length;
              return html`<tr key=${s.e.b.id+s.e.k} class="border-t border-line align-top lab-shift" data-date=${s.e.k}>
                <td class="py-2 pr-3 whitespace-nowrap"><span class="font-medium">${WD[parse(s.e.k).getDay()]} ${fmtShort(parse(s.e.k))}</span>${s.e.b.shift==='night'?html` <span class="text-muted">· night</span>`:''}
                  ${sr.length>0&&html`<div class="grid gap-0.5 mt-1 max-w-[280px]">${sr.map(r=>html`<${Rep} key=${r.id} r=${r}/>`)}</div>`}</td>
                <td class="py-2 pr-3 whitespace-nowrap">${s.crew?s.crew.name:'–'}</td>
                <td class="py-2 pr-3 tnum text-right whitespace-nowrap text-muted">${s.plan.t?f1(s.plan.t)+' t':''}${s.plan.t&&s.plan.a?' · ':''}${s.plan.a?f1(s.plan.a)+' m²':''}${!s.plan.t&&!s.plan.a?'–':''}</td>
                <td class="py-2 pr-3 tnum text-right whitespace-nowrap font-semibold lab-laid-t">${s.sub.length?f1(s.laid.t)+' t':html`<span class="text-faint font-normal">–</span>`}</td>
                <td class="py-2 pr-3 tnum text-right whitespace-nowrap font-semibold lab-laid-a">${s.sub.length?f1(s.laid.a):html`<span class="text-faint font-normal">–</span>`}</td>
                <td class="py-2 pr-3 tnum text-right">${s.sub.length?s.laid.loads:''}</td>
                <td class="py-2 pr-3 whitespace-nowrap">${s.sub.length?html`<span class="text-[11.5px] font-semibold px-1.5 py-0.5 rounded" style=${{background:'hsl(145 55% 36% / .14)',color:'hsl(145 55% 28%)'}}>Submitted</span>`
                  :draft?html`<span class="text-[11.5px] font-semibold px-1.5 py-0.5 rounded" style=${{background:'hsl(38 95% 50% / .16)',color:'hsl(30 90% 32%)'}}>In progress</span>`:html`<span class="text-[11.5px] text-muted">No QA</span>`}</td>
                <td class="py-2 text-right whitespace-nowrap">${s.sub.length>0&&html`<button type="button" class="btn lab-qa" style=${{height:28,fontSize:12}} disabled=${!!busy} onClick=${()=>pdfs(s.sub.map(p=>({e:s.e,p})),s.e.b.id+s.e.k)}>${Icon.download} ${busy===s.e.b.id+s.e.k?'…':'QA PDF'}</button>`}</td></tr>`})}</tbody></table></div>
          ${(()=>{const jl=reportsFor(o.j.id,null);return jl.length>0&&html`<div class="grid gap-1"><div class="label">Lab reports for the whole job</div>${jl.map(r=>html`<${Rep} key=${r.id} r=${r}/>`)}</div>`})()}
        </div>`}</section>`})}
    ${up&&html`<${UploadDialog} key=${up.n} sb=${sb} up=${up} live=${live} onClose=${()=>setUp(null)} onDone=${()=>{setUp(null);notify&&notify('Lab report uploaded');reload()}}/>`}
  </div>`;
}

function UploadDialog({sb,up,onClose,onDone}){
  const shiftsU=[...new Set(up.shifts)].sort().reverse();const [k,setK]=useState(up.k||shiftsU[0]||'');   /* reports are per shift */const [file,setFile]=useState(null);const [note,setNote]=useState('');const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const save=async()=>{setErr('');if(!k){setErr('Pick the shift.');return}if(!file){setErr('Choose the report file.');return}if(file.size>25*1024*1024){setErr('That file is over 25 MB.');return}
    if(!OK_TYPE.test(file.type||'')){setErr('Add a PDF, a picture, or an Excel, CSV or Word file.');return}
    setBusy(true);try{const safe=file.name.replace(/[^\w.\- ]+/g,'_').slice(-80);const path=`jobs/${up.job.id}/${Date.now()}-${safe}`;
      const {error}=await sb.storage.from(BUCKET).upload(path,file,{contentType:file.type,upsert:false});if(error)throw error;
      const row={job_id:up.job.id,kind:up.kind||'other',name:file.name,path,mime:file.type,size:file.size,note:note.trim()||null};if(k)row.shift_date=k;
      const {error:e2}=await sb.from('lab_reports').insert(row);if(e2){try{await sb.storage.from(BUCKET).remove([path])}catch(x){}throw e2}
      onDone()}catch(e){setErr(errMsg(e))}finally{setBusy(false)}};
  return html`<${Modal} title=${'Upload '+(up.kind==='ncr'?'an NCR':'a '+kindLabel(up.kind).toLowerCase())} sub=${jobLabel(up.job)} onClose=${onClose}
    foot=${html`${err&&html`<span id="lab-up-err" class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="lab-up-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>${busy?'Uploading…':'Upload'}</button>`}>
    <div class="grid gap-3">
      <${Fld} label="Shift"><select id="lab-up-shift" class="field" style=${fs} value=${k} onChange=${e=>setK(e.target.value)}>${shiftsU.map(d=>html`<option key=${d} value=${d}>Shift ${WD[parse(d).getDay()]} ${fmtShort(parse(d))}</option>`)}</select><//>
      <${Fld} label="Report (PDF, picture, Excel, CSV or Word, up to 25 MB)"><input id="lab-up-file" type="file" accept=${ACCEPT} class="field" style=${{...fs,paddingTop:5}} onChange=${e=>setFile(e.target.files&&e.target.files[0]||null)}/><//>
      <${Fld} label="Note (optional)"><input id="lab-up-note" class="field" style=${fs} placeholder=${up.kind==='core'?'e.g. Density results':up.kind==='ncr'?'e.g. NCR number, what it’s about':'e.g. Binder content, grading'} value=${note} onInput=${e=>setNote(e.target.value)}/><//>
    </div><//>`;
}

window.LabScreen=LabScreen;
})();
