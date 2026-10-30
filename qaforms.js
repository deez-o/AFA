/* =====================================================================
   FraserFlow: the rest of the site QA pack, each form added to a pack when it's needed:
   agreed quantity record, hold point release, field site diagram, asphalt laying record,
   site environmental checklist and external costs summary. They share the lot details.
   Loaded after qa.js (uses its Card, Tick, SignOff and SignPad).
   ===================================================================== */
(function(){
const {Modal,Fld,fs}=window.FFM;const {Card,SignOff,SignPad,AFA}=window.FFQ;
const n0=v=>{const x=parseFloat(String(v==null?'':v).replace(/,/g,''));return isFinite(x)?x:0};
const t1=v=>Math.round(v*100)/100;
const hhmm=()=>{const d=new Date();return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')};
const linesOn=(b,k)=>linesOf((b.shiftData||{})[k]).filter(l=>l&&(l.type||l.tonnes||l.area));
const dateTxt=k=>k?`${fmtShort(parse(k))} ${parse(k).getFullYear()}`:'';
const In=({id,v,on,ph,type='text',mono,w})=>html`<input id=${id} type=${type} class=${'field'+(mono?' mono':'')} style=${{...fs,...(w?{width:w}:{})}} placeholder=${ph||''} value=${v==null?'':v} onInput=${e=>on(e.target.value)}/>`;
const rowStyle='rounded-lg border border-line p-2.5 grid gap-2';

/* ---------- lot details, shared by the forms ---------- */
const LOT=[['client','Client / customer'],['job_no','Job number'],['location','Job location'],['date','Date'],['lot_desc','Lot description'],['lot_no','Lot number'],['start_ch','Start chainage'],['end_ch','End chainage']];
function newLot(data,e,p){const h=((p&&p.jsa)||{}).head||{};const j=data.jobs.find(x=>x.id===e.b.jobId)||{};
  return {client:h.customer||j.customer||'',job_no:h.job_no||j.projectNo||'',location:h.location||j.address||j.name||'',date:e.k,lot_desc:'',lot_no:'',start_ch:'',end_ch:''}}
function LotCard({f}){const L=f.pack.forms.lot||{};const set=(k,v)=>f.set('lot',l=>({...(l||{}),[k]:v}));
  return html`<${Card} title="Lot details" id="qa-lot" sub="Shared by the forms below (entered once)">
    <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-4 gap-3">
      ${LOT.map(([k,l])=>html`<${Fld} key=${k} label=${l}><${In} id=${'qa-lot-'+k} type=${k==='date'?'date':'text'} v=${L[k]} on=${v=>set(k,v)}/><//>`)}</fieldset><//>`}
/* a form's card, with "remove" while nothing on it is signed */
function FormCard({f,id,title,sub,sigForms,children}){
  const signed=f.sigs.some(s=>s.pack_id===f.pack.id&&sigForms.includes(s.form))||(FORMS.find(x=>x.id===id)||{}).required;
  return html`<${Card} title=${title} sub=${sub} id=${'qa-f-'+id}>${children}
    ${f.canEdit&&!signed&&html`<div><button type="button" class="text-[12px] text-muted hover:text-ink qa-form-remove" onClick=${()=>f.remove(id)}>Remove this form</button></div>`}<//>`}
const Rows=({f,id,items,make,render,addLabel,addId})=>html`<div class="grid gap-2">
  ${items.map((r,i)=>html`<div key=${i} class=${rowStyle+' qa-row-'+id}>
    <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid gap-2">${render(r,i,patch=>f.set(id,d=>({...d,rows:d.rows.map((x,k)=>k===i?{...x,...patch}:x)})))}</fieldset>
    ${f.canEdit&&html`<div><button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>f.set(id,d=>({...d,rows:d.rows.filter((x,k)=>k!==i)}))}>Remove</button></div>`}</div>`)}
  ${f.canEdit&&html`<div><button id=${addId} type="button" class="btn" onClick=${()=>f.set(id,d=>({...d,rows:[...(d.rows||[]),make(d)]}))}>${Icon.plus} ${addLabel}</button></div>`}</div>`;
const Sig=({f,form,label,me=true,other,empty})=>html`<div class="grid gap-1.5"><div class="label">${label}</div>
  <${SignOff} form=${form} pack=${f.pack} sigs=${f.sigs} ctx=${f.ctx} canEdit=${f.canEdit} open=${f.open} me=${me} other=${other} max=${1} empty=${empty||'Not signed yet.'}/></div>`;

/* ---------- agreed quantity record ---------- */
const aqrRow=()=>({product:'',description:'',rate:'',area:'',delivered:'',deductions:'',claimed:''});
const claimedOf=r=>r.claimed!==''&&r.claimed!=null?n0(r.claimed):(r.delivered!==''?n0(r.delivered)-n0(r.deductions):0);
const AQR={id:'aqr',label:'Agreed quantity record',short:'Agreed quantities',
  make:(data,e)=>{const ls=linesOn(e.b,e.k);return {rows:ls.length?ls.map(l=>({product:l.type||'',description:[l.binder,l.virgin?'virgin':''].filter(Boolean).join(' · '),rate:l.depth?`${l.depth} mm`:'',area:l.area?String(l.area):'',delivered:l.tonnes?String(l.tonnes):'',deductions:'',claimed:''})):[aqrRow()]}},
  Editor:({f})=>{const d=f.pack.forms.aqr;const tot=(d.rows||[]).reduce((a,r)=>a+claimedOf(r),0);
    return html`<${FormCard} f=${f} id="aqr" title="Agreed quantity record" sub=${`Total tonnes claimed: ${fmtN(t1(tot))}`} sigForms=${['aqr_afa','aqr_client']}>
      <div class="label">Quantities</div>
      <${Rows} f=${f} id="aqr" items=${d.rows||[]} make=${aqrRow} addLabel="Add product" addId="qa-aqr-add" render=${(r,i,set)=>html`
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2"><${Fld} label="Product"><${In} v=${r.product} on=${v=>set({product:v})} ph="e.g. AC14"/><//><${Fld} label="Description"><${In} v=${r.description} on=${v=>set({description:v})}/><//>
          <${Fld} label="Application rate"><${In} v=${r.rate} on=${v=>set({rate:v})} ph="L/m², m²/m³, mm"/><//><${Fld} label="Area (m²)"><${In} v=${r.area} on=${v=>set({area:v})}/><//>
          <${Fld} label="Delivered (t or L)"><${In} v=${r.delivered} on=${v=>set({delivered:v})}/><//><${Fld} label="Deductions"><${In} v=${r.deductions} on=${v=>set({deductions:v})}/><//>
          <${Fld} label="Claimed"><${In} v=${r.claimed} on=${v=>set({claimed:v})} ph=${r.delivered!==''?String(t1(n0(r.delivered)-n0(r.deductions))):''}/><//></div>`}/>
      <div class="text-[13.5px] font-semibold" id="qa-aqr-total">Total tonnes claimed: ${fmtN(t1(tot))}</div>
      <div class="grid gap-3 sm:grid-cols-2"><${Sig} f=${f} form="aqr_afa" label="Agreed by: Alex Fraser Asphalt quality representative" other="Someone else signs for AFA"/>
        <${Sig} f=${f} form="aqr_client" label="Agreed by: client representative" me=${false} other="Client representative signs"/></div><//>`},
  pdf:o=>{const d=o.p.forms.aqr;const doc=o.doc;o.newPage('p');o.page('AGREED QUANTITY RECORD');let y=24;y=lotGrid(o,y,['client','job_no','location','date','lot_desc','lot_no','start_ch','end_ch']);
    y=table(o,y+3,[['Product',1],['Description',1.6],['Application rate',1.1],['Area',.8],['Delivered to site',1],['Deductions',.9],['Claimed',.9]],(d.rows||[]).map(r=>[r.product,r.description,r.rate,r.area,r.delivered,r.deductions,fmtN(t1(claimedOf(r)))]));
    doc.setFont('helvetica','bold');doc.setFontSize(9.5);o.txt(`Total tonnes claimed: ${fmtN(t1((d.rows||[]).reduce((a,r)=>a+claimedOf(r),0)))}`,o.M,y+5);y+=12;
    y=sigBlock(o,y,'aqr_afa','Quantities agreed by: Alex Fraser Asphalt quality representative');y=sigBlock(o,y+3,'aqr_client','Client representative')}};

/* ---------- hold point release ---------- */
const HOLD={id:'hold',label:'Hold point release',short:'Hold point',
  make:()=>({lot_numbers:'',comments:'',attention:'',released:false}),
  Editor:({f})=>{const d=f.pack.forms.hold;const set=p=>f.set('hold',x=>({...x,...p}));
    return html`<${FormCard} f=${f} id="hold" title="Hold point release" sub=${d.released?'Released: work on this lot may proceed':'Authorisation to proceed'} sigForms=${['hold_afa','hold_client']}>
      <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid gap-3">
        <${Fld} label="Comments"><textarea id="qa-hold-comments" class="field" rows="2" style=${{height:'auto',padding:'6px 10px',fontSize:13}} value=${d.comments} onInput=${e=>set({comments:e.target.value})}></textarea><//></fieldset>
      <${Sig} f=${f} form="hold_afa" label="Alex Fraser Asphalt quality representative" other="Someone else signs for AFA"/>
      <div class="label mt-1">Client response</div>
      <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid gap-3">
        <${Fld} label="The following requires attention"><textarea id="qa-hold-attention" class="field" rows="2" style=${{height:'auto',padding:'6px 10px',fontSize:13}} value=${d.attention} onInput=${e=>set({attention:e.target.value})}></textarea><//>
        <label class="inline-flex items-start gap-2 text-[13.5px] cursor-pointer"><input id="qa-hold-released" type="checkbox" class="w-4 h-4 mt-0.5" checked=${!!d.released} onChange=${e=>set({released:e.target.checked})}/>Release of the hold point is granted. Work on this lot may proceed.</label></fieldset>
      <${Sig} f=${f} form="hold_client" label="Client representative" me=${false} other="Client representative signs"/><//>`},
  pdf:o=>{const d=o.p.forms.hold;const doc=o.doc;o.newPage('p');o.page('HOLD POINT RELEASE FORM · Authorisation to Proceed');let y=24;y=lotGrid(o,y,['client','job_no','location','date','lot_desc','lot_no','start_ch','end_ch']);
    y=para(o,y+3,'Comments',d.comments);y=sigBlock(o,y+2,'hold_afa','Alex Fraser Asphalt quality representative');
    doc.setFont('helvetica','bold');doc.setFontSize(10);doc.setTextColor(153,10,44);o.txt('Client response',o.M,y+6);y+=8;y=para(o,y,'The following requires attention',d.attention);
    doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(22,24,29);o.txt(`${d.released?'[✓]':'[  ]'} Release of the Hold Point described above is hereby granted. Work on this lot may proceed.`.replace('✓','x'),o.M,y+5);y+=9;
    y=sigBlock(o,y,'hold_client','Client representative')}};

/* ---------- field site diagram ---------- */
function shrinkPhoto(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const sc=Math.min(1,1280/Math.max(im.width,im.height));
  const c=document.createElement('canvas');c.width=Math.round(im.width*sc);c.height=Math.round(im.height*sc);c.getContext('2d').drawImage(im,0,0,c.width,c.height);res(c.toDataURL('image/jpeg',.7))};im.onerror=rej;im.src=r.result};r.onerror=rej;r.readAsDataURL(file)})}
function SketchDialog({onSave,onClose}){const pad=useRef(null);const [ink,setInk]=useState(false);
  return html`<${Modal} wide=${true} title="Draw the site diagram" sub="All patchwork must be clearly measured and marked on the map with chainages" onClose=${onClose}
    foot=${html`${ink&&html`<button type="button" class="btn" onClick=${()=>pad.current.clear()}>Clear</button>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="qa-sketch-save" type="button" class="btn btn-primary" disabled=${!ink} onClick=${()=>onSave(pad.current.png())}>Save drawing</button>`}>
    <div class="qa-sketch"><${SignPad} padRef=${pad} onInk=${setInk}/></div><//>`}
const DIAGRAM={id:'diagram',label:'Field site diagram',short:'Site diagram',
  make:(data,e,p,ctx)=>{const ls=linesOn(e.b,e.k);return {layer:'',depth:ls[0]&&ls[0].depth?`${ls[0].depth} mm`:'',mix:[...new Set(ls.map(l=>l.type).filter(Boolean))].join(', '),prepared_by:ctx.myName||'',sketch:null,photos:[]}},
  Editor:({f})=>{const d=f.pack.forms.diagram;const set=p=>f.set('diagram',x=>({...x,...p}));const [draw,setDraw]=useState(false);const [busy,setBusy]=useState(false);
    const addPhotos=async files=>{setBusy(true);try{const out=[];for(const fl of [...files].slice(0,4-(d.photos||[]).length))out.push(await shrinkPhoto(fl));set({photos:[...(d.photos||[]),...out]})}catch(e){}finally{setBusy(false)}};
    return html`<${FormCard} f=${f} id="diagram" title="Field site diagram" sub="All patchwork must be clearly measured and marked on the map with chainages" sigForms=${[]}>
      <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <${Fld} label="Layer"><${In} id="qa-dg-layer" v=${d.layer} on=${v=>set({layer:v})} ph="e.g. Wearing course"/><//><${Fld} label="Nominal depth"><${In} id="qa-dg-depth" v=${d.depth} on=${v=>set({depth:v})}/><//>
        <${Fld} label="Mix type"><${In} id="qa-dg-mix" v=${d.mix} on=${v=>set({mix:v})}/><//><${Fld} label="Map prepared by"><${In} id="qa-dg-by" v=${d.prepared_by} on=${v=>set({prepared_by:v})}/><//></fieldset>
      ${d.sketch?html`<img id="qa-dg-sketch" src=${d.sketch} alt="Site diagram" class="w-full rounded-lg border border-line bg-white"/>`:html`<div class="text-[12.5px] text-muted">No drawing yet.</div>`}
      ${(d.photos||[]).length>0&&html`<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${d.photos.map((ph,i)=>html`<div key=${i} class="relative"><img src=${ph} alt=${'Site photo '+(i+1)} class="w-full h-28 object-cover rounded-lg border border-line qa-dg-photo"/>
        ${f.canEdit&&html`<button type="button" class="absolute top-1 right-1 btn px-1.5" style=${{height:26}} aria-label="Remove photo" onClick=${()=>set({photos:d.photos.filter((x,k)=>k!==i)})}>${Icon.x}</button>`}</div>`)}</div>`}
      ${f.canEdit&&html`<div class="flex flex-wrap gap-2"><button id="qa-dg-draw" type="button" class="btn" onClick=${()=>setDraw(true)}>${Icon.pencil} ${d.sketch?'Redraw':'Draw the diagram'}</button>
        ${d.sketch&&html`<button type="button" class="btn" onClick=${()=>set({sketch:null})}>Remove drawing</button>`}
        ${(d.photos||[]).length<4&&html`<label class="btn cursor-pointer">${Icon.plus} ${busy?'Adding…':'Photo of a hand-drawn map'}<input id="qa-dg-photo" type="file" accept="image/*" capture="environment" multiple class="sr-only" onChange=${e=>{addPhotos(e.target.files);e.target.value=''}}/></label>`}</div>`}
      ${draw&&html`<${SketchDialog} onClose=${()=>setDraw(false)} onSave=${png=>{set({sketch:png});setDraw(false)}}/>`}<//>`},
  pdf:o=>{const d=o.p.forms.diagram;const doc=o.doc;o.newPage('p');o.page('FIELD SITE DIAGRAM');let y=24;
    y=kvGrid(o,y,[['Job location',o.lot.location],['Customer',o.lot.client],['Date',dateTxt(o.lot.date)],['Lot number',o.lot.lot_no],['Job number',o.lot.job_no],['Start chainage',o.lot.start_ch],['End chainage',o.lot.end_ch],['Layer',d.layer],['Nominal depth',d.depth],['Mix type',d.mix],['Map prepared by',d.prepared_by]]);
    doc.setFont('helvetica','italic');doc.setFontSize(8.5);doc.setTextColor(94,99,110);o.txt('All patchwork must be clearly measured and marked on the map with chainages',o.M,y+4);y+=7;
    const W=doc.internal.pageSize.getWidth()-2*o.M;const pics=[d.sketch,...(d.photos||[])].filter(Boolean);
    pics.forEach((im,i)=>{try{const pr=doc.getImageProperties(im);const w=W,h=Math.min(pr.height*w/pr.width,(i===0?170:120));const ww=pr.width*h/pr.height;
      if(y+h>285){o.newPage('p');o.page('FIELD SITE DIAGRAM (continued)');y=24}doc.addImage(im,/jpeg/i.test(im.slice(5,20))?'JPEG':'PNG',o.M,y,Math.min(w,ww),h,'dg'+i,'FAST');o.box(o.M,y,Math.min(w,ww),h);y+=h+4}catch(e){}});
    if(!pics.length){o.box(o.M,y,W,170);y+=172}}};

/* ---------- asphalt laying record ---------- */
const layRow=()=>({docket:'',rego:'',time:hhmm(),temp:'',tonnes:'',ch_start:'',ch_finish:'',dip_l:'',dip_c:'',dip_r:'',comments:''});
const LAYING={id:'laying',label:'Asphalt laying record',short:'Laying record',
  make:(data,e,p,ctx)=>({date_placed:e.k,rows:[],device:'',serial:((p.jsa||{}).quality||{}).serial||'',prepared_by:ctx.myName||''}),
  Editor:({f})=>{const d=f.pack.forms.laying;const set=p=>f.set('laying',x=>({...x,...p}));let run=0;const tot=(d.rows||[]).reduce((a,r)=>a+n0(r.tonnes),0);
    return html`<${FormCard} f=${f} id="laying" title="Asphalt laying record (paving)" sub=${`${(d.rows||[]).length} load${(d.rows||[]).length===1?'':'s'} · ${fmtN(t1(tot))} t`} sigForms=${[]}>
      <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <${Fld} label="Date placed"><${In} type="date" v=${d.date_placed} on=${v=>set({date_placed:v})}/><//><${Fld} label="Prepared by"><${In} v=${d.prepared_by} on=${v=>set({prepared_by:v})}/><//>
        <${Fld} label="Calibrated temperature device"><${In} id="qa-lay-device" v=${d.device} on=${v=>set({device:v})}/><//><${Fld} label="Serial number"><${In} v=${d.serial} on=${v=>set({serial:v})}/><//></fieldset>
      <${Rows} f=${f} id="laying" items=${d.rows||[]} make=${layRow} addLabel="Add a truck load" addId="qa-lay-add" render=${(r,i,s)=>{run+=n0(r.tonnes);return html`
        <div class="flex items-center gap-2 text-[12.5px]"><span class="font-semibold">Load ${i+1}</span><span class="text-muted">Progressive total ${fmtN(t1(run))} t</span></div>
        <div class="grid grid-cols-3 sm:grid-cols-5 gap-2"><${Fld} label="Docket number"><${In} v=${r.docket} on=${v=>s({docket:v})}/><//><${Fld} label="Truck rego"><${In} v=${r.rego} on=${v=>s({rego:v.toUpperCase()})}/><//>
          <${Fld} label="Time in"><${In} type="time" v=${r.time} on=${v=>s({time:v})}/><//><${Fld} label="Temperature °C"><${In} v=${r.temp} on=${v=>s({temp:v})}/><//><${Fld} label="Tonnes"><${In} v=${r.tonnes} on=${v=>s({tonnes:v})}/><//></div>
        <div class="grid grid-cols-3 sm:grid-cols-5 gap-2"><${Fld} label="Chainage start"><${In} v=${r.ch_start} on=${v=>s({ch_start:v})}/><//><${Fld} label="Chainage finish"><${In} v=${r.ch_finish} on=${v=>s({ch_finish:v})}/><//>
          <${Fld} label="Loose dip left"><${In} v=${r.dip_l} on=${v=>s({dip_l:v})}/><//><${Fld} label="Centre"><${In} v=${r.dip_c} on=${v=>s({dip_c:v})}/><//><${Fld} label="Right"><${In} v=${r.dip_r} on=${v=>s({dip_r:v})}/><//></div>
        <${Fld} label="Run location / comments"><${In} v=${r.comments} on=${v=>s({comments:v})} ph="e.g. Run 1, overlay / patch"/><//>`}}/>
      <div class="text-[13.5px] font-semibold" id="qa-lay-total">Total: ${fmtN(t1(tot))} t</div><//>`},
  pdf:o=>{const d=o.p.forms.laying;const doc=o.doc;o.newPage('l');o.page('ASPHALT LAYING RECORD (PAVING)');let y=24;
    y=kvGrid(o,y,[['Customer',o.lot.client],['Job location',o.lot.location],['Job number',o.lot.job_no],['Date placed',dateTxt(d.date_placed)]],4);let run=0;
    y=table(o,y+2,[['Docket number',1.1],['Truck rego',1],['Time in',.7],['Temperature',.9],['Tonnes',.7],['Progressive total',1],['Chainage start',.9],['Chainage finish',.9],['Dip left',.6],['Dip centre',.6],['Dip right',.6],['Run location / comments',2.2]],
      (d.rows||[]).map(r=>{run+=n0(r.tonnes);return [r.docket,r.rego,r.time,r.temp,r.tonnes,fmtN(t1(run)),r.ch_start,r.ch_finish,r.dip_l,r.dip_c,r.dip_r,r.comments]}),'l');
    y=kvGrid(o,y+3,[['Calibrated temperature device used',d.device],['Serial number',d.serial],['Prepared by',d.prepared_by],['Total tonnes',fmtN(t1(run))]],4)}};

/* ---------- operations site environmental checklist ---------- */
const ENV_ITEMS=[['residents','Residents notified'],['kerb','Kerb and channel clean'],['gully','Gully pits clean'],['profiling','Profiling required'],['swept','Pave section swept and clean'],['linemarking','Temporary line marking / stick ’n’ stomps'],['prime','Prime / bitumen on kerb, crossovers'],
  ['noise','Noise and dust suppression kept to minimum'],['profilings','Profilings removed from site'],['pits','Gully pits / inspection pipes protected'],['stormwater','Stormwater outlets protected'],['excess','Excess noise generated'],['spills','Fuel, bitumen, oil, emulsion spills contained'],
  ['animals','Nesting and territorial animals, including birds, dogs, bees / wasps (discuss controls with customer)'],['trees','Overhanging trees / branches, other flora (discuss controls with customer)']];
const YNA=[['yes','Yes'],['no','No'],['na','N/A']];
const Ynb=({v,on,dis,id})=>html`<div class="seg w-max" id=${id}>${YNA.map(([k,l])=>html`<button key=${k} type="button" disabled=${dis} aria-pressed=${v===k} onClick=${()=>on(v===k?'':k)}>${l}</button>`)}</div>`;
const ENV={id:'env',label:'Site environmental checklist',short:'Environmental',
  make:(data,e,p,ctx)=>({items:{},before:'',after:'',prepared_by:ctx.myName||''}),
  Editor:({f})=>{const d=f.pack.forms.env;const it=d.items||{};const setI=(k,p)=>f.set('env',x=>({...x,items:{...(x.items||{}),[k]:{...((x.items||{})[k]||{}),...p}}}));const set=p=>f.set('env',x=>({...x,...p}));
    const done=ENV_ITEMS.filter(([k])=>(it[k]||{}).pre).length;
    return html`<${FormCard} f=${f} id="env" title="Operations site environmental checklist" sub=${`${done} of ${ENV_ITEMS.length} checked before surfacing`} sigForms=${['env']}>
      <div class="grid gap-2">${ENV_ITEMS.map(([k,l],i)=>{const a=it[k]||{};return html`<div key=${k} class="${rowStyle} qa-env-item">
        <div class="text-[13px] font-medium">${l}</div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]"><span class="inline-flex items-center gap-2"><span class="text-muted w-[86px]">Pre-surfacing</span><${Ynb} id=${'qa-env-'+k+'-pre'} v=${a.pre} dis=${!f.canEdit} on=${v=>setI(k,{pre:v})}/></span>
          <span class="inline-flex items-center gap-2"><span class="text-muted w-[86px]">Post surfacing</span><${Ynb} id=${'qa-env-'+k+'-post'} v=${a.post} dis=${!f.canEdit} on=${v=>setI(k,{post:v})}/></span></div>
        <input class="field" style=${fs} placeholder="Comments" value=${a.comment||''} disabled=${!f.canEdit} onInput=${e=>setI(k,{comment:e.target.value})}/></div>`})}</div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="grid gap-1"><span class="label">Condition of site prior to paving</span><div class="seg w-max" id="qa-env-before">${[['safe','Safe'],['unsafe','Unsafe']].map(([k,l])=>html`<button key=${k} type="button" disabled=${!f.canEdit} aria-pressed=${d.before===k} onClick=${()=>set({before:d.before===k?'':k})}>${l}</button>`)}</div></div>
        <div class="grid gap-1"><span class="label">Condition of site after job complete</span><div class="seg w-max" id="qa-env-after">${[['clean','Clean'],['unclean','Unclean']].map(([k,l])=>html`<button key=${k} type="button" disabled=${!f.canEdit} aria-pressed=${d.after===k} onClick=${()=>set({after:d.after===k?'':k})}>${l}</button>`)}</div></div></div>
      <${Sig} f=${f} form="env" label="Prepared by" other="Someone else signs"/><//>`},
  pdf:o=>{const d=o.p.forms.env;const it=d.items||{};const doc=o.doc;o.newPage('p');o.page('OPERATIONS SITE ENVIRONMENTAL CHECKLIST');let y=24;
    y=kvGrid(o,y,[['Customer',o.lot.client],['Date',dateTxt(o.lot.date)],['Job number',o.lot.job_no],['Job location',o.lot.location],['Lot number',o.lot.lot_no]],3);
    const yn=v=>({yes:'YES',no:'NO',na:'N/A'})[v]||'';
    y=table(o,y+2,[['Item',3],['Pre-surfacing',1],['Post surfacing',1],['Comments',2]],ENV_ITEMS.map(([k,l])=>[l,yn((it[k]||{}).pre),yn((it[k]||{}).post),(it[k]||{}).comment||'']));
    doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(22,24,29);o.txt(`Condition of site prior to paving: ${({safe:'Safe',unsafe:'Unsafe'})[d.before]||'–'}`,o.M,y+5);o.txt(`Condition of site after job complete: ${({clean:'Clean',unclean:'Unclean'})[d.after]||'–'}`,o.M,y+10);y+=14;
    y=sigBlock(o,y,'env','Prepared by')}};

/* ---------- QA external costs summary ---------- */
const costRow=()=>({contractor:'',type:'',rego:'',docket:'',start:'',finish:''});
const COSTS={id:'costs',label:'External costs summary',short:'External costs',
  make:(data,e,p,ctx)=>{const q=(e.b.shiftData||{})[e.k]||{};const rows=[...(q.subs||[]).filter(s=>s&&(s.name||s.info)).map(s=>({...costRow(),contractor:s.name||'',type:s.info||'',start:s.time||''})),
      ...(q.trucks||[]).filter(t=>t&&(t.co||t.driver)).map(t=>({...costRow(),contractor:t.co||t.driver||'',type:'Truck'+(t.w?' '+t.w:''),start:t.time||''}))];
    return {supervisor:ctx.myName||'',start_paving:'',finish_paving:'',rows:rows.length?rows:[costRow()],comments:'',none:false}},
  Editor:({f})=>{const d=f.pack.forms.costs;const set=p=>f.set('costs',x=>({...x,...p}));
    return html`<${FormCard} f=${f} id="costs" title="QA external costs summary" sub=${`${(d.rows||[]).filter(r=>r.contractor).length} contractor${(d.rows||[]).filter(r=>r.contractor).length===1?'':'s'}`} sigForms=${[]}>
      <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid grid-cols-2 lg:grid-cols-3 gap-3">
        <${Fld} label="Supervisor name"><${In} v=${d.supervisor} on=${v=>set({supervisor:v})}/><//><${Fld} label="Start paving"><${In} type="time" v=${d.start_paving} on=${v=>set({start_paving:v})}/><//><${Fld} label="Finish paving"><${In} type="time" v=${d.finish_paving} on=${v=>set({finish_paving:v})}/><//></fieldset>
      <label class="inline-flex items-center gap-2 text-[13px] cursor-pointer"><input id="qa-cost-none" type="checkbox" class="w-4 h-4" disabled=${!f.canEdit} checked=${!!d.none} onChange=${e=>set({none:e.target.checked})}/>No external contractors on this shift</label>
      ${!d.none&&html`<${Rows} f=${f} id="costs" items=${d.rows||[]} make=${costRow} addLabel="Add contractor" addId="qa-cost-add" render=${(r,i,s)=>html`
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2"><${Fld} label="Contractor"><${In} v=${r.contractor} on=${v=>s({contractor:v})} ph="e.g. Big Daves"/><//><${Fld} label="Type"><${In} v=${r.type} on=${v=>s({type:v})} ph="e.g. Profiling"/><//>
          <${Fld} label="Rego"><${In} v=${r.rego} on=${v=>s({rego:v.toUpperCase()})}/><//><${Fld} label="Start time"><${In} type="time" v=${r.start} on=${v=>s({start:v})}/><//><${Fld} label="Finish time"><${In} type="time" v=${r.finish} on=${v=>s({finish:v})}/><//>
          <${Fld} label="Docket no (office use)"><${In} v=${r.docket} on=${v=>s({docket:v})}/><//></div>`}/>`}
      <${Fld} label="Comments"><textarea class="field" rows="2" style=${{height:'auto',padding:'6px 10px',fontSize:13}} disabled=${!f.canEdit} value=${d.comments} onInput=${e=>set({comments:e.target.value})}></textarea><//><//>`},
  pdf:o=>{const d=o.p.forms.costs;o.newPage('p');o.page('QA EXTERNAL COSTS SUMMARY');let y=24;
    y=kvGrid(o,y,[['Date',dateTxt(o.lot.date)],['Customer',o.lot.client],['Project number',o.lot.job_no],['Supervisor name',d.supervisor],['Job location',o.lot.location],['Start paving',d.start_paving],['Finish paving',d.finish_paving]],2);
    y=table(o,y+2,[['Contractor',1.5],['Type',1.2],['Rego',.9],['Docket no (office use)',1.2],['Start time',.8],['Finish time',.8]],(d.rows||[]).filter(r=>r.contractor||r.type).map(r=>[r.contractor,r.type,r.rego,r.docket,r.start,r.finish]));
    y=para(o,y+3,'Comments',d.comments)}};

/* ---------- PDF building blocks ---------- */
function lotGrid(o,y,keys){const L=o.lot;return kvGrid(o,y,keys.map(k=>[LOT.find(x=>x[0]===k)[1],k==='date'?dateTxt(L.date):L[k]]),2)}
function kvGrid(o,y,pairs,cols=3){const doc=o.doc;const W=doc.internal.pageSize.getWidth()-2*o.M;const cw=W/cols;
  pairs.forEach(([k,v],i)=>{const x=o.M+(i%cols)*cw,yy=y+Math.floor(i/cols)*10;o.box(x,yy,cw,10);doc.setFont('helvetica','bold');doc.setFontSize(6.8);doc.setTextColor(94,99,110);o.txt(k,x+1.5,yy+3.4);
    doc.setFont('helvetica','normal');doc.setFontSize(8.8);doc.setTextColor(22,24,29);o.txt(doc.splitTextToSize(String(v||''),cw-3)[0]||'',x+1.5,yy+8)});return y+Math.ceil(pairs.length/cols)*10}
function table(o,y,cols,rows,orient='p'){const doc=o.doc;const W=doc.internal.pageSize.getWidth()-2*o.M,Hh=doc.internal.pageSize.getHeight();const tot=cols.reduce((a,c)=>a+c[1],0);const ws=cols.map(c=>W*c[1]/tot);
  const head=()=>{doc.setFontSize(7);doc.setFont('helvetica','bold');doc.setTextColor(22,24,29);const hs=cols.map((c,i)=>doc.splitTextToSize(c[0],ws[i]-2));const h=Math.max(...hs.map(x=>x.length))*2.9+2.6;let x=o.M;
    hs.forEach((t,i)=>{doc.setFillColor(244,244,246);doc.rect(x,y,ws[i],h,'F');o.box(x,y,ws[i],h);o.txt(t,x+1.1,y+3.3);x+=ws[i]});y+=h};
  head();doc.setFont('helvetica','normal');
  (rows.length?rows:[cols.map(()=>'')]).forEach(r=>{doc.setFontSize(7.8);const cs=r.map((v,i)=>doc.splitTextToSize(String(v==null?'':v),ws[i]-2));const h=Math.max(1,...cs.map(c=>c.length))*3.3+2.4;
    if(y+h>Hh-12){o.newPage(orient);o.page('(continued)');y=24;head();doc.setFont('helvetica','normal');doc.setFontSize(7.8)}
    let x=o.M;cs.forEach((c,i)=>{o.box(x,y,ws[i],h);o.txt(c,x+1.1,y+3.6);x+=ws[i]});y+=h});return y}
function para(o,y,label,text){const doc=o.doc;const W=doc.internal.pageSize.getWidth()-2*o.M;doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.setTextColor(22,24,29);o.txt(label+':',o.M,y+4);
  doc.setFont('helvetica','normal');const t=doc.splitTextToSize(text||'–',W);o.txt(t,o.M,y+8.5);return y+8.5+t.length*3.8}
function sigBlock(o,y,form,label){const doc=o.doc;const W=doc.internal.pageSize.getWidth()-2*o.M;const s=o.sigs.find(x=>x.pack_id===o.p.id&&x.form===form);
  doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.setTextColor(22,24,29);o.txt(label,o.M,y+4);y+=6;const cw=[W*.32,W*.26,W*.2,W*.22];let x=o.M;
  ['Name','Company','Date','Signature'].forEach((h,i)=>{o.box(x,y,cw[i],5);doc.setFontSize(7);o.txt(h,x+1.1,y+3.5);x+=cw[i]});y+=5;x=o.M;cw.forEach(w=>{o.box(x,y,w,12);x+=w});
  if(s){doc.setFont('helvetica','normal');doc.setFontSize(8.5);o.txt(s.name,o.M+1.2,y+7);o.txt(s.company||AFA,o.M+cw[0]+1.2,y+7);doc.setFontSize(7.5);o.txt(o.fmtDT(s.signed_at),o.M+cw[0]+cw[1]+1.2,y+7);
    o.img(s.signature,o.M+cw[0]+cw[1]+cw[2]+2,y+1,28,10,'sig-'+s.id)}else{doc.setFont('helvetica','italic');doc.setFontSize(8);doc.setTextColor(140,145,155);o.txt('Not signed',o.M+1.2,y+7)}
  return y+14}

/* ---------- what each form needs before the pack can be submitted ---------- */
const signedOn=(o,form)=>o.sigs.some(s=>s.pack_id===o.p.id&&s.form===form);
const blank=v=>!String(v==null?'':v).trim();
const LOT_NEED=[['client','Client / customer'],['job_no','Job number'],['location','Job location'],['date','Date'],['lot_no','Lot number']];
const lotCheck=o=>{const L=(o.p.forms||{}).lot||{};return LOT_NEED.filter(([k])=>blank(L[k])).map(([,l])=>l)};
AQR.check=(d,o)=>[...(!(d.rows||[]).some(r=>!blank(r.product)&&claimedOf(r)>0)?['At least one product with its quantity']:[]),...(signedOn(o,'aqr_afa')?[]:['AFA quality rep’s signature']),...(signedOn(o,'aqr_client')?[]:['Client rep’s signature'])];
HOLD.check=(d,o)=>[...(signedOn(o,'hold_afa')?[]:['AFA quality rep’s signature']),...(!d.released&&blank(d.attention)?['Client response: release it, or say what needs attention']:[]),...(signedOn(o,'hold_client')?[]:['Client rep’s signature'])];
DIAGRAM.check=d=>[...(!d.sketch&&!(d.photos||[]).length?['The diagram (draw it, or add a photo)']:[]),...(blank(d.mix)?['Mix type']:[]),...(blank(d.depth)?['Nominal depth']:[]),...(blank(d.prepared_by)?['Map prepared by']:[])];
ENV.check=(d,o)=>{const it=d.items||{};const pre=ENV_ITEMS.filter(([k])=>!(it[k]||{}).pre).length,post=ENV_ITEMS.filter(([k])=>!(it[k]||{}).post).length;
  return [...(pre?[`${pre} item${pre===1?'':'s'} not answered before surfacing`]:[]),...(post?[`${post} item${post===1?'':'s'} not answered after surfacing`]:[]),...(blank(d.before)?['Condition of the site before paving']:[]),...(blank(d.after)?['Condition of the site after the job']:[]),...(signedOn(o,'env')?[]:['Signature of whoever prepared it'])]};
COSTS.check=d=>[...(blank(d.supervisor)?['Supervisor name']:[]),...(blank(d.start_paving)?['Start paving time']:[]),...(blank(d.finish_paving)?['Finish paving time']:[]),...(!d.none&&!(d.rows||[]).some(r=>!blank(r.contractor))?['The external contractors (or tick “No external contractors”)']:[])];
LAYING.check=d=>[...(!(d.rows||[]).some(r=>!blank(r.docket)&&n0(r.tonnes)>0)?['At least one load with its docket number and tonnes']:[]),...(blank(d.device)?['Calibrated temperature device']:[]),...(blank(d.serial)?['Its serial number']:[]),...(blank(d.prepared_by)?['Prepared by']:[])];
[AQR,HOLD,DIAGRAM,ENV,COSTS].forEach(f=>f.required=true);LAYING.required=false;
const FORMS=[AQR,HOLD,DIAGRAM,LAYING,ENV,COSTS];
const SIGN_TITLES={aqr_afa:'Agree the quantities (AFA)',aqr_client:'Agree the quantities (client)',hold_afa:'Hold point (AFA quality rep)',hold_client:'Release the hold point (client)',env:'Sign the environmental checklist'};
const SIGN_NOTES={aqr_afa:'I agree the quantities on this record.',aqr_client:'I agree the quantities on this record.',hold_afa:'Hold point inspection by the Alex Fraser Asphalt quality representative.',
  hold_client:'Signing records the client response above. Tick “Release granted” on the form when work on this lot may proceed.',env:'I prepared this checklist.'};
/* the PDF hooks need the shared lot details */
FORMS.forEach(F=>{const inner=F.pdf;F.pdf=o=>inner({...o,lot:(o.p.forms||{}).lot||newLot(o.data,o.e,o.p)})});
window.FFQF={FORMS,byId:Object.fromEntries(FORMS.map(f=>[f.id,f])),LotCard,newLot,lotCheck,signTitle:k=>SIGN_TITLES[k],signNote:k=>SIGN_NOTES[k]};
})();
