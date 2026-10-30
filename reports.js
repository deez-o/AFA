/* =====================================================================
   FraserFlow: Fleet reports and the machine history PDF (Phase 6)
   Loaded after maint.js, prestart.js and defects.js. Every report is worked out from the records
   already loaded for the Fleet screen, so it always matches what the other tabs show.
   Each report exports to CSV (for Excel) and a branded PDF.
   ===================================================================== */
(function(){
const {fs,errMsg,fmtTs,localDay}=window.FFM;
const D=window.FFD;
const DAYMS=864e5;
const fmtD=k=>k?`${fmtShort(parse(k))} ${parse(k).getFullYear()}`:'';
const fmtDT=t=>t?new Date(t).toLocaleString('en-AU',{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}):'';
const daysBetween=(a,b)=>Math.max(0,Math.round((new Date(b)-new Date(a))/DAYMS*10)/10);
const pct=(a,b)=>b?Math.round(a/b*100)+'%':'–';
const dayList=(from,to)=>{const out=[];for(let d=parse(from);iso(d)<=to;d=addDays(d,1))out.push(iso(d));return out};
const WO_ST={open:'Open',scheduled:'Scheduled',in_progress:'In progress',awaiting_parts:'Awaiting parts',completed:'Completed',closed:'Verified & closed',cancelled:'Cancelled'};
const WO_TY={service:'Scheduled service',defect:'Defect repair',breakdown:'Breakdown',request:'Maintenance request'};
const PRI={low:'Low',medium:'Medium',high:'High',urgent:'Urgent'};
const PLAN_ST={ok:'OK',soon:'Due soon',overdue:'Overdue',nobase:'No service recorded'};
const SEV={minor:'Minor',major:'Major',critical:'Critical'};
const DST={reported:'Reported',acknowledged:'Waiting for repair',in_repair:'In repair',repaired:'Repaired: to verify',closed:'Verified & closed',dismissed:'Dismissed'};

/* ---------- exports ---------- */
const csvCell=v=>{const s=v==null?'':String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
function download(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500)}
function exportCsv(rep,file){
  const lines=[];rep.sections.forEach((s,i)=>{if(i||rep.sections.length>1)lines.push(csvCell(s.heading));lines.push(s.cols.map(c=>csvCell(c.h)).join(','));s.rows.forEach(r=>lines.push(r.map(csvCell).join(',')));lines.push('')});
  download(file+'.csv',new Blob(['﻿'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'}));
}
/* a branded PDF: logo, maroon strip, title; summary figures; tables that carry on over pages with their headings repeated */
async function makePdf({title,sub,sections,file,portrait}){
  const J=await loadJsPDF();const doc=new J({orientation:portrait?'p':'l',unit:'mm',format:'a4'});
  const W=doc.internal.pageSize.getWidth(),H=doc.internal.pageSize.getHeight(),M=12;let y=0;
  const head=()=>{doc.setFillColor(153,10,44);doc.rect(0,0,W,2.2,'F');try{doc.addImage(AFA_LOGO,'PNG',M,7,38,14.7)}catch(e){}
    doc.setFont('helvetica','bold');doc.setFontSize(15);doc.setTextColor(22,24,29);doc.text(title,W-M,13,{align:'right'});
    doc.setFont('helvetica','normal');doc.setFontSize(8.5);doc.setTextColor(94,99,110);doc.text(sub,W-M,18.5,{align:'right'});
    doc.setDrawColor(219,221,226);doc.line(M,25,W-M,25);y=31};
  const room=h=>{if(y+h>H-12){doc.addPage();head();return true}return false};
  head();
  for(const s of sections){
    room(20);
    doc.setFont('helvetica','bold');doc.setFontSize(11.5);doc.setTextColor(22,24,29);doc.text(s.heading,M,y);y+=5;
    if(s.summary&&s.summary.length){doc.setFontSize(8.5);let x=M;
      s.summary.forEach(([k,v])=>{const t1=String(v),t2=' '+k;doc.setFont('helvetica','bold');const w1=doc.getTextWidth(t1);doc.setFont('helvetica','normal');const w2=doc.getTextWidth(t2);
        if(x+w1+w2>W-M){x=M;y+=4.6}doc.setFont('helvetica','bold');doc.setTextColor(153,10,44);doc.text(t1,x,y);doc.setFont('helvetica','normal');doc.setTextColor(94,99,110);doc.text(t2,x+w1,y);x+=w1+w2+7});y+=6}
    if(!s.rows.length){doc.setFontSize(9);doc.setTextColor(140,145,155);doc.text(s.empty||'Nothing in this period.',M,y);y+=9;continue}
    const tot=s.cols.reduce((a,c)=>a+(c.w||1),0);const ws=s.cols.map(c=>(W-2*M)*(c.w||1)/tot);
    const th=()=>{doc.setFillColor(244,244,246);doc.rect(M,y-3.6,W-2*M,5.6,'F');doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.setTextColor(94,99,110);
      let x=M;s.cols.forEach((c,i)=>{doc.text(c.h.toUpperCase(),c.right?x+ws[i]-1.5:x+1.5,y,{align:c.right?'right':'left'});x+=ws[i]});y+=5};
    th();doc.setFont('helvetica','normal');doc.setFontSize(8.2);
    for(const r of s.rows){
      const cells=r.map((v,i)=>doc.splitTextToSize(v==null?'':String(v),ws[i]-3));const h=Math.max(...cells.map(c=>c.length))*3.6+1.8;
      if(room(h+2)){th();doc.setFont('helvetica','normal');doc.setFontSize(8.2)}
      let x=M;doc.setTextColor(22,24,29);cells.forEach((c,i)=>{doc.text(c,s.cols[i].right?x+ws[i]-1.5:x+1.5,y,{align:s.cols[i].right?'right':'left'});x+=ws[i]});
      y+=h;doc.setDrawColor(233,234,237);doc.line(M,y-2.6,W-M,y-2.6)}
    y+=5}
  const n=doc.internal.getNumberOfPages();
  for(let i=1;i<=n;i++){doc.setPage(i);doc.setFontSize(7.5);doc.setTextColor(140,145,155);doc.text(`FraserFlow · Alex Fraser Group · generated ${fmtDT(Date.now())}`,M,H-6);doc.text(`Page ${i} of ${n}`,W-M,H-6,{align:'right'})}
  doc.save(file+'.pdf');
}

/* ---------- the reports ---------- */
const mName=(M,id)=>{const a=M.byId.get(id);return a?a.m.name:id};
const mDesc=(M,id)=>{const a=M.byId.get(id);return a?`${a.m.name} · ${a.m.sub||''}`:id};
const inCat=(M,cat)=>id=>{if(!cat)return true;const a=M.byId.get(id);return !!a&&machCatOf(a.m).toLowerCase()===cat.toLowerCase()};
const REPORTS=[
  {id:'backlog',label:'Work order backlog',now:true,make:(ctx,{cat})=>{const {db,M}=ctx;const ok=inCat(M,cat);const today=Date.now();
    const wos=db.work_orders.filter(w=>!['completed','closed','cancelled'].includes(w.status)&&ok(w.asset_id))
      .sort((a,b)=>['urgent','high','medium','low'].indexOf(a.priority)-['urgent','high','medium','low'].indexOf(b.priority)||a.created_at.localeCompare(b.created_at));
    const ages=wos.map(w=>daysBetween(w.created_at,today));
    const df=(db.defects||[]).filter(d=>D&&D.OPEN(d.status)&&ok(d.asset_id));
    return {sections:[
      {heading:'Open work orders',summary:[['open',wos.length],['urgent or high',wos.filter(w=>w.priority==='urgent'||w.priority==='high').length],['awaiting parts',wos.filter(w=>w.status==='awaiting_parts').length],['oldest (days)',ages.length?Math.round(Math.max(...ages)):0]],
        cols:[{h:'No.',w:.55},{h:'Machine',w:1.5},{h:'Type',w:1},{h:'Title',w:2.4},{h:'Priority',w:.7},{h:'Status',w:1},{h:'Age (days)',w:.7,right:1},{h:'Assigned',w:1.1},{h:'Scheduled',w:.9}],
        rows:wos.map((w,i)=>[w.number,mDesc(M,w.asset_id),WO_TY[w.wo_type],w.title,PRI[w.priority],WO_ST[w.status],Math.round(ages[i]),w.assigned_to||'',w.start_date?fmtD(w.start_date):'']),empty:'No open work orders.'},
      ...(db.p4?[{heading:'Open defects without a work order',summary:[['open defects',df.length],['critical',df.filter(d=>d.severity==='critical').length],['without a work order',df.filter(d=>!d.work_order_id).length]],
        cols:[{h:'No.',w:.6},{h:'Machine',w:1.5},{h:'Defect',w:2.6},{h:'Severity',w:.7},{h:'Status',w:1.1},{h:'Reported',w:1.2},{h:'Seen',w:.5,right:1}],
        rows:df.filter(d=>!d.work_order_id).map(d=>['D-'+d.number,mDesc(M,d.asset_id),d.title,SEV[d.severity],DST[d.status],fmtDT(d.created_at),d.times_reported]),empty:'Every open defect is on a work order.'}]:[])]}}},
  {id:'compliance',label:'Service compliance',now:true,make:(ctx,{cat})=>{const {M}=ctx;
    const as=M.assets.filter(a=>!a.retired&&(!cat||machCatOf(a.m).toLowerCase()===cat.toLowerCase()));
    const rows=as.flatMap(a=>a.plans.map(x=>({a,x}))).sort((p,q)=>({overdue:0,soon:1,nobase:2,ok:3}[p.x.state]-{overdue:0,soon:1,nobase:2,ok:3}[q.x.state])||p.a.m.name.localeCompare(q.a.m.name));
    const n=s=>rows.filter(r=>r.x.state===s).length;const tracked=n('ok')+n('soon')+n('overdue');
    return {sections:[{heading:'Service status',summary:[['compliant',pct(n('ok')+n('soon'),tracked)],['overdue',n('overdue')],['due soon',n('soon')],['no service recorded',n('nobase')],['machines with no plan',as.filter(a=>!a.plans.length).length]],
      cols:[{h:'Machine',w:1.6},{h:'Category',w:1},{h:'Service',w:1.4},{h:'Status',w:.9},{h:'Last done',w:.9},{h:'Due',w:1.4},{h:'Remaining',w:1.4}],
      rows:rows.map(({a,x})=>[`${a.m.name} · ${a.m.sub||''}`,machCatOf(a.m),svcName(x),PLAN_ST[x.state],x.last?fmtD(x.last.done_on):'',x.parts.map(p=>p.dueTxt).join(' / '),x.parts.map(p=>p.leftTxt).join(' / ')]),empty:'No service plans apply.'}]}}},
  {id:'prestarts',label:'Prestart compliance',max:90,make:(ctx,{from,to,cat})=>{const {db,M,data}=ctx;const end=to<iso(TODAY)?to:iso(TODAY);const days=from<=end?dayList(from,end):[];
    const as=M.assets.filter(a=>!a.retired&&(!cat||machCatOf(a.m).toLowerCase()===cat.toLowerCase()));
    const jobs=data.blocks.filter(b=>b.kind==='job'&&(b.plantIds||[]).length&&b.end>=from&&b.start<=end);
    const rows=as.map(a=>{const booked=days.filter(k=>jobs.some(b=>(b.plantIds||[]).includes(a.m.id)&&covers(b,k)&&worksOn(b,parse(k))));
      const ps=db.prestarts.filter(p=>p.asset_id===a.m.id&&localDay(p.submitted_at)>=from&&localDay(p.submitted_at)<=to);const pd=new Set(ps.map(p=>localDay(p.submitted_at)));
      const missing=booked.filter(k=>!pd.has(k));return {a,booked:booked.length,done:booked.length-missing.length,missing,ps}}).filter(r=>r.booked||r.ps.length)
      .sort((x,y)=>y.missing.length-x.missing.length||x.a.m.name.localeCompare(y.a.m.name));
    const B=rows.reduce((s,r)=>s+r.booked,0),Dn=rows.reduce((s,r)=>s+r.done,0);
    return {sections:[{heading:'Prestarts on days machines were booked',summary:[['compliance',pct(Dn,B)],['machine-days booked',B],['missing prestarts',B-Dn],['prestarts done',rows.reduce((s,r)=>s+r.ps.length,0)],['with faults',rows.reduce((s,r)=>s+r.ps.filter(p=>p.result!=='pass').length,0)]],
      cols:[{h:'Machine',w:1.6},{h:'Category',w:1},{h:'Days booked',w:.7,right:1},{h:'With prestart',w:.8,right:1},{h:'Compliance',w:.7,right:1},{h:'Prestarts',w:.6,right:1},{h:'With faults',w:.6,right:1},{h:'Missing on',w:2.4}],
      rows:rows.map(r=>[`${r.a.m.name} · ${r.a.m.sub||''}`,machCatOf(r.a.m),r.booked,r.done,pct(r.done,r.booked),r.ps.length,r.ps.filter(p=>p.result!=='pass').length,r.missing.map(k=>fmtShort(parse(k))).join(', ')]),
      empty:'No machines were booked on jobs in this period.'}]}}},
  {id:'downtime',label:'Downtime',make:(ctx,{from,to,cat})=>{const {db,M,data}=ctx;const days=dayList(from,to);const today=iso(TODAY);
    const as=M.assets.filter(a=>!a.retired&&(!cat||machCatOf(a.m).toLowerCase()===cat.toLowerCase()));
    const rows=as.map(a=>{const bl=data.blocks.filter(b=>b.resourceId===a.m.id&&KINDS[b.kind]&&KINDS[b.kind].down&&b.end>=from&&b.start<=to);
      const svc=new Set(),rep=new Set(),res=new Set();
      days.forEach(k=>{bl.forEach(b=>{if(covers(b,k))(b.kind==='service'?svc:rep).add(k)});
        (db.restrictions||[]).filter(r=>r.asset_id===a.m.id).forEach(r=>{const s=localDay(r.created_at),e=r.released_at?localDay(r.released_at):today;if(k>=s&&k<=e&&k<=today)res.add(k)})});
      const all=new Set([...svc,...rep,...res]);return {a,svc:svc.size,rep:rep.size,res:res.size,all:all.size}}).filter(r=>r.all).sort((x,y)=>y.all-x.all);
    const tot=rows.reduce((s,r)=>s+r.all,0);
    return {sections:[{heading:'Days out of action',summary:[['machine-days down',tot],['fleet availability',pct(as.length*days.length-tot,as.length*days.length)],['machines affected',rows.length]],
      cols:[{h:'Machine',w:1.8},{h:'Category',w:1.1},{h:'Scheduled service',w:.9,right:1},{h:'Breakdown / repair',w:.9,right:1},{h:'Restricted',w:.8,right:1},{h:'Total days down',w:.9,right:1},{h:'Of the period',w:.8,right:1}],
      rows:rows.map(r=>[`${r.a.m.name} · ${r.a.m.sub||''}`,machCatOf(r.a.m),r.svc,r.rep,r.res,r.all,pct(r.all,days.length)]),empty:'No downtime in this period.'}]}}},
  {id:'breakdowns',label:'Breakdowns',make:(ctx,{from,to,cat})=>{const {db,M}=ctx;const ok=inCat(M,cat);
    const wos=db.work_orders.filter(w=>w.wo_type==='breakdown'&&localDay(w.created_at)>=from&&localDay(w.created_at)<=to&&ok(w.asset_id)).sort((a,b)=>b.created_at.localeCompare(a.created_at));
    const done=wos.filter(w=>w.completed_at);const avg=done.length?Math.round(done.reduce((s,w)=>s+daysBetween(w.created_at,w.completed_at),0)/done.length*10)/10:'–';
    const per={};wos.forEach(w=>{per[w.asset_id]=(per[w.asset_id]||0)+1});const top=Object.entries(per).sort((a,b)=>b[1]-a[1])[0];
    return {sections:[{heading:'Breakdowns reported',summary:[['breakdowns',wos.length],['not safe to operate',wos.filter(w=>w.safe_to_operate===false).length],['average days to fix',avg],['most',top?`${mName(M,top[0])} (${top[1]})`:'–']],
      cols:[{h:'Reported',w:1.1},{h:'No.',w:.5},{h:'Machine',w:1.5},{h:'What failed',w:2.6},{h:'Safe?',w:.5},{h:'Priority',w:.6},{h:'Status',w:1},{h:'Days to fix',w:.7,right:1}],
      rows:wos.map(w=>[fmtDT(w.created_at),w.number,mDesc(M,w.asset_id),w.title,w.safe_to_operate===false?'No':w.safe_to_operate?'Yes':'',PRI[w.priority],WO_ST[w.status],w.completed_at?daysBetween(w.created_at,w.completed_at):'']),empty:'No breakdowns in this period.'}]}}},
  {id:'defects',label:'Defects',needs:'p4',make:(ctx,{from,to,cat})=>{const {db,M}=ctx;const ok=inCat(M,cat);
    const ds=(db.defects||[]).filter(d=>localDay(d.created_at)>=from&&localDay(d.created_at)<=to&&ok(d.asset_id)).sort((a,b)=>b.number-a.number);
    const closed=ds.filter(d=>d.status==='closed');const avg=closed.length?Math.round(closed.reduce((s,d)=>s+daysBetween(d.created_at,d.closed_at),0)/closed.length*10)/10:'–';
    return {sections:[{heading:'Defects reported',summary:[['reported',ds.length],['critical',ds.filter(d=>d.severity==='critical').length],['still open',ds.filter(d=>D.OPEN(d.status)).length],['average days to verified repair',avg],['seen more than once',ds.filter(d=>d.times_reported>1).length]],
      cols:[{h:'No.',w:.6},{h:'Reported',w:1.1},{h:'Machine',w:1.5},{h:'Defect',w:2.4},{h:'Severity',w:.7},{h:'Status',w:1.1},{h:'Seen',w:.5,right:1},{h:'Days open',w:.7,right:1},{h:'From',w:.7}],
      rows:ds.map(d=>['D-'+d.number,fmtDT(d.created_at),mDesc(M,d.asset_id),d.title,SEV[d.severity],DST[d.status],d.times_reported,daysBetween(d.created_at,d.closed_at||Date.now()),d.source==='prestart'?'Prestart':'By hand']),empty:'No defects in this period.'}]}}},
  {id:'services',label:'Service history',make:(ctx,{from,to,cat})=>{const {db,M}=ctx;const ok=inCat(M,cat);
    const rs=db.service_records.filter(r=>!r.baseline&&r.done_on>=from&&r.done_on<=to&&ok(r.asset_id)).sort((a,b)=>b.done_on.localeCompare(a.done_on));
    return {sections:[{heading:'Services done',summary:[['services',rs.length],['machines',new Set(rs.map(r=>r.asset_id)).size]],
      cols:[{h:'Date',w:.8},{h:'Machine',w:1.5},{h:'Service',w:1.3},{h:'Hours',w:.6,right:1},{h:'Km',w:.6,right:1},{h:'Mechanic',w:1},{h:'Work done',w:2.4},{h:'Parts',w:1.6}],
      rows:rs.map(r=>[fmtD(r.done_on),mDesc(M,r.asset_id),r.service_type,r.hours!=null?fmtN(+r.hours):'',r.km!=null?fmtN(+r.km):'',r.mechanic||'',r.work_done||'',(r.parts||[]).map(p=>`${p.qty&&p.qty!=='1'?p.qty+' × ':''}${p.part}`).join(', ')]),empty:'No services in this period.'}]}}},
];

function ReportsTab({ctx}){
  const {data,db,notify}=ctx;
  const [id,setId]=useState(()=>{try{return localStorage.getItem(KEY+':fleet-report')||'backlog'}catch(e){return 'backlog'}});
  const pick=k=>{setId(k);try{localStorage.setItem(KEY+':fleet-report',k)}catch(e){}};
  const [from,setFrom]=useState(()=>iso(addDays(TODAY,-29)));const [to,setTo]=useState(()=>iso(TODAY));const [cat,setCat]=useState('');const [busy,setBusy]=useState(false);
  const list=REPORTS.filter(r=>!r.needs||db[r.needs]);const R=list.find(r=>r.id===id)||list[0];
  let f=from,warn='';if(R.max&&dayList(from,to).length>R.max){f=iso(addDays(parse(to),-(R.max-1)));warn=`Prestarts are kept here for the last 90 days: showing ${fmtD(f)} onwards.`}
  const rep=R.make(ctx,{from:f,to,cat});
  const period=R.now?`As at ${fmtDT(Date.now())}`:`${fmtD(f)} – ${fmtD(to)}`;
  const file=`FraserFlow ${R.label} ${R.now?iso(TODAY):f+' to '+to}${cat?' '+cat:''}`;
  const quick=n=>{setTo(iso(TODAY));setFrom(iso(addDays(TODAY,-(n-1))))};
  const month=()=>{const d=new Date(TODAY);d.setDate(1);setFrom(iso(d));setTo(iso(TODAY))};
  const pdf=async()=>{setBusy(true);try{await makePdf({title:R.label,sub:[period,cat||'All categories'].join(' · '),sections:rep.sections,file})}catch(e){notify(errMsg(e))}finally{setBusy(false)}};
  return html`<div class="grid gap-3 lg:grid-cols-[210px_minmax(0,1fr)] items-start">
    <nav class="panel p-1.5 grid gap-0.5" aria-label="Reports">${list.map(r=>html`<button key=${r.id} id=${'rp-'+r.id} type="button" class=${'text-left px-3 py-2 rounded-lg text-[13px] '+(r.id===R.id?'font-semibold':'text-muted hover:text-ink hover:bg-sunken')} style=${r.id===R.id?{background:'var(--accent-soft)',color:'var(--accent)'}:null} aria-current=${r.id===R.id?'page':undefined} onClick=${()=>pick(r.id)}>${r.label}</button>`)}</nav>
    <section class="panel flex flex-col min-h-0" id="rp-view">
      <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line">
        <div class="font-display text-[16px] font-semibold mr-2">${R.label}</div>
        ${R.now?html`<span class="text-[12.5px] text-muted">${period}</span>`:html`
          <input id="rp-from" type="date" class="field mono w-auto" style=${fs} value=${from} max=${to} onChange=${e=>setFrom(e.target.value)} aria-label="From"/>
          <span class="text-muted">–</span><input id="rp-to" type="date" class="field mono w-auto" style=${fs} value=${to} min=${from} onChange=${e=>setTo(e.target.value)} aria-label="To"/>
          <div class="seg"><button type="button" onClick=${month}>This month</button><button type="button" onClick=${()=>quick(30)}>30 days</button><button type="button" onClick=${()=>quick(90)}>90 days</button></div>`}
        <select class="field w-auto" style=${fs} value=${cat} onChange=${e=>setCat(e.target.value)} aria-label="Category"><option value="">All categories</option>${machineCatsOf(data).map(c=>html`<option key=${c} value=${c}>${c}</option>`)}</select>
        <span class="flex-1"></span>
        <button id="rp-csv" type="button" class="btn" onClick=${()=>exportCsv(rep,file)}>${Icon.download} CSV</button>
        <button id="rp-pdf" type="button" class="btn btn-primary" disabled=${busy} onClick=${pdf}>${Icon.download} ${busy?'Making PDF…':'PDF'}</button>
      </div>
      ${warn&&html`<div class="px-3 py-2 text-[12.5px] border-b border-line" style=${{color:'hsl(30 90% 36%)'}}>${warn}</div>`}
      ${rep.sections.map((s,i)=>html`<div key=${i} class="grid gap-2 py-3">
        <div class="px-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">${rep.sections.length>1&&html`<h3 class="font-display text-[14.5px] font-semibold w-full">${s.heading}</h3>`}
          ${(s.summary||[]).map(([k,v])=>html`<span key=${k} class="text-[12.5px]"><span class="font-display text-[18px] font-semibold tnum rp-fig" data-k=${k}>${v}</span> <span class="text-muted">${k}</span></span>`)}</div>
        <div class="overflow-x-auto"><table class="w-full text-[12.5px] rp-table">
          <thead><tr class="text-left">${s.cols.map(c=>html`<th key=${c.h} class=${'label font-normal py-2 px-3 whitespace-nowrap'+(c.right?' text-right':'')}>${c.h}</th>`)}</tr></thead>
          <tbody>${s.rows.map((r,j)=>html`<tr key=${j} class="border-t border-line">${r.map((v,k)=>html`<td key=${k} class=${'py-1.5 px-3 align-top'+(s.cols[k].right?' text-right tnum':'')+(k===0?' whitespace-nowrap':'')}>${v}</td>`)}</tr>`)}
            ${!s.rows.length&&html`<tr><td colspan=${s.cols.length} class="px-3 py-5 text-center text-muted">${s.empty||'Nothing in this period.'}</td></tr>`}</tbody></table></div></div>`)}
    </section></div>`;
}

/* ---------- one machine's history, as a PDF ---------- */
async function machinePdf(ctx,a){
  const {db,M,data}=ctx;const p=a.p||{};const id=a.m.id;
  const wos=db.work_orders.filter(w=>w.asset_id===id).sort((x,y)=>y.number-x.number);
  const recs=db.service_records.filter(r=>r.asset_id===id).sort((x,y)=>y.done_on.localeCompare(x.done_on));
  const ds=(db.defects||[]).filter(d=>d.asset_id===id).sort((x,y)=>y.number-x.number);
  const ps=db.prestarts.filter(x=>x.asset_id===id);
  const rs=(db.restrictions||[]).filter(r=>r.asset_id===id).sort((x,y)=>y.created_at.localeCompare(x.created_at));
  const reads=db.meter_readings.filter(r=>r.asset_id===id).sort((x,y)=>y.read_at.localeCompare(x.read_at)).slice(0,25);
  const sections=[
    {heading:'Machine',summary:[['status',({ok:'Operational',due:'Maintenance due',service:'Being serviced',out:'Out of service'})[a.status]],...(a.mt!=='km'?[['hours',a.cur.hours?fmtN(a.cur.hours.value):'–']]:[]),...(a.mt!=='hours'?[['km',a.cur.km?fmtN(a.cur.km.value):'–']]:[]),['open work orders',a.open.length],['open defects',(a.defects||[]).length]],
      cols:[{h:'Detail',w:1},{h:'',w:3}],rows:[['Fleet no.',a.m.name],['Description',a.m.sub||''],['Category',machCatOf(a.m)],['Rego',a.m.rego||''],['Home crew',a.crew?a.crew.name:''],['Make / model',[p.make,p.model].filter(Boolean).join(' ')],['Year',p.year||''],['Serial',p.serial||''],
        ['Restriction',rs.filter(r=>r.active).map(r=>`${r.reason} (since ${fmtDT(r.created_at)})`).join('; ')||'None']]},
    {heading:'Service schedule',cols:[{h:'Service',w:1.4},{h:'Status',w:.9},{h:'Last done',w:1},{h:'Due',w:1.4},{h:'Remaining',w:1.4}],
      rows:a.plans.map(x=>[svcName(x),PLAN_ST[x.state],x.last?fmtD(x.last.done_on):'',x.parts.map(q=>q.dueTxt).join(' / '),x.parts.map(q=>q.leftTxt).join(' / ')]),empty:'No service plans apply.'},
    {heading:'Service records',cols:[{h:'Date',w:.8},{h:'Service',w:1.3},{h:'Hours',w:.6,right:1},{h:'Km',w:.6,right:1},{h:'Mechanic',w:1},{h:'Work done',w:2.4},{h:'Parts',w:1.6}],
      rows:recs.map(r=>[fmtD(r.done_on),(r.baseline?'Before FraserFlow: ':'')+r.service_type,r.hours!=null?fmtN(+r.hours):'',r.km!=null?fmtN(+r.km):'',r.mechanic||'',r.work_done||'',(r.parts||[]).map(q=>`${q.qty&&q.qty!=='1'?q.qty+' × ':''}${q.part}`).join(', ')]),empty:'No services recorded.'},
    {heading:'Work orders',cols:[{h:'No.',w:.5},{h:'Raised',w:1},{h:'Type',w:1},{h:'Title',w:2.2},{h:'Status',w:1},{h:'Completed',w:1},{h:'Notes',w:2.2}],
      rows:wos.map(w=>[w.number,fmtD(localDay(w.created_at)),WO_TY[w.wo_type],w.title,WO_ST[w.status],w.completed_at?fmtD(localDay(w.completed_at)):'',w.completion_notes||'']),empty:'No work orders.'},
    ...(db.p4?[{heading:'Defects',cols:[{h:'No.',w:.6},{h:'Reported',w:1.1},{h:'Defect',w:2.2},{h:'Severity',w:.7},{h:'Status',w:1.1},{h:'Seen',w:.5,right:1},{h:'Repair',w:2.2}],
      rows:ds.map(d=>['D-'+d.number,fmtDT(d.created_at),d.title,SEV[d.severity],DST[d.status],d.times_reported,d.resolution||'']),empty:'No defects.'},
      {heading:'Restrictions',cols:[{h:'From',w:1.1},{h:'Reason',w:2.6},{h:'Returned to service',w:1.1},{h:'Note',w:1.6}],rows:rs.map(r=>[fmtDT(r.created_at),r.reason,r.released_at?fmtDT(r.released_at):'Still restricted',r.release_note||'']),empty:'Never restricted.'}]:[]),
    ...(db.p3?[{heading:'Prestarts (last 90 days)',summary:[['prestarts',ps.length],['with faults',ps.filter(x=>x.result!=='pass').length]],cols:[{h:'When',w:1.2},{h:'Operator',w:1.4},{h:'Result',w:1},{h:'Failed',w:.5,right:1},{h:'Hours',w:.6,right:1},{h:'Km',w:.6,right:1},{h:'Location',w:2}],
      rows:ps.map(x=>[fmtDT(x.submitted_at),x.operator_name,({pass:'Good to go',defects:'Defects reported',unsafe:'Do not operate'})[x.result],x.failed,x.hours!=null?fmtN(+x.hours):'',x.km!=null?fmtN(+x.km):'',x.location||'']),empty:'No prestarts.'}]:[]),
    {heading:'Recent meter readings',cols:[{h:'When',w:1.2},{h:'Meter',w:.7},{h:'Reading',w:.8,right:1},{h:'Source',w:.9},{h:'Note',w:2.4}],
      rows:reads.map(r=>[fmtDT(r.read_at),r.kind==='hours'?'Hours':'Km',fmtN(+r.value),({manual:'Reading',service:'Service',prestart:'Prestart',work_order:'Work order',correction:'Correction',replacement:'New meter'})[r.source]||r.source,r.note||'']),empty:'No readings.'},
  ];
  await makePdf({title:`${a.m.name} · Machine history`,sub:[a.m.sub,machCatOf(a.m),a.m.rego&&'Rego '+a.m.rego].filter(Boolean).join(' · '),sections,file:`${a.m.name} machine history ${iso(TODAY)}`,portrait:false});
}

window.FFR={ReportsTab,machinePdf,makePdf,exportCsv,REPORTS};
})();
