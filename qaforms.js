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
const LOT=[['client','Client / customer'],['job_no','Job number'],['location','Job location'],['date','Date'],['lot_desc','Job description'],['start_ch','Start chainage'],['end_ch','End chainage']];
function newLot(data,e,p){const h=((p&&p.jsa)||{}).head||{};const j=data.jobs.find(x=>x.id===e.b.jobId)||{};
  return {client:h.customer||j.customer||'',job_no:h.job_no||j.projectNo||'',location:h.location||j.address||j.name||'',date:e.k,lot_desc:'',start_ch:'',end_ch:''}}
function LotCard({f}){const L=f.pack.forms.lot||{};const set=(k,v)=>f.set('lot',l=>({...(l||{}),[k]:v}));
  return html`<${Card} title="Job details" id="qa-lot" sub="Shared by the forms below (entered once)">
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
  Editor:({f})=>{const d=f.pack.forms.aqr;const rows=d.rows||[];const tot=rows.reduce((a,r)=>a+claimedOf(r),0);
    const [err,setErr]=useState('');
    const setRow=(i,p)=>f.set('aqr',x=>({...x,rows:(x.rows||[]).map((r,k)=>k===i?{...r,...p}:r)}));
    const delRow=i=>f.set('aqr',x=>({...x,rows:(x.rows||[]).filter((r,k)=>k!==i)}));
    const confirm=i=>{const r=rows[i];if(blank(r.product)){setErr('Enter the product first.');return}if(!(claimedOf(r)>0)){setErr('Enter what was delivered (or the quantity claimed) first.');return}setErr('');setRow(i,{ok:true})};
    const shown=rows.map((r,i)=>({r,i})).filter(x=>x.r.ok||!f.canEdit);
    const kv=(l,v)=>v!==''&&v!=null&&html`<span><span class="text-faint">${l}</span> <span class="tnum">${v}</span></span>`;
    return html`<${FormCard} f=${f} id="aqr" title="Agreed quantity record" sub=${`Total tonnes claimed: ${fmtN(t1(tot))}`} sigForms=${['aqr_afa','aqr_client']}>
      ${shown.length>0&&html`<div class="rounded-xl border border-line overflow-hidden" id="qa-aqr-summary">
        <div class="px-3 py-2 bg-sunken flex items-center gap-2"><span class="label flex-1">What we are claiming</span><span class="label">Claimed</span></div>
        ${shown.map(({r,i})=>html`<div key=${i} class="px-3 py-2.5 border-t border-line flex items-start gap-3 qa-aqr-line">
          <div class="flex-1 min-w-0 grid gap-0.5"><div class="text-[14px] font-semibold">${r.product||'–'}${r.description&&html`<span class="font-normal text-muted"> · ${r.description}</span>`}</div>
            <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">${kv('Rate',r.rate)}${kv('Area',r.area&&(fmtN(n0(r.area))+' m²'))}${kv('Delivered',r.delivered)}${kv('Deductions',r.deductions)}</div>
            ${f.canEdit&&html`<div class="pt-1"><button type="button" class="btn qa-aqr-edit" style=${{height:28,fontSize:12}} onClick=${()=>{setRow(i,{ok:false});setErr('')}}>${Icon.pencil} Edit</button></div>`}</div>
          <div class="text-[18px] font-semibold tnum leading-tight text-right">${fmtN(t1(claimedOf(r)))}</div></div>`)}
        <div class="px-3 py-2.5 border-t border-line flex items-center gap-3 bg-sunken"><span class="flex-1 text-[13.5px] font-semibold">Total tonnes claimed</span><span class="text-[18px] font-semibold tnum" id="qa-aqr-total">${fmtN(t1(tot))}</span></div></div>`}
      ${f.canEdit&&rows.map((r,i)=>!r.ok&&html`<div key=${'e'+i} class=${rowStyle+' qa-row-aqr'}>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2"><${Fld} label="Product"><${In} v=${r.product} on=${v=>setRow(i,{product:v})} ph="e.g. AC14"/><//><${Fld} label="Description"><${In} v=${r.description} on=${v=>setRow(i,{description:v})}/><//>
          <${Fld} label="Application rate"><${In} v=${r.rate} on=${v=>setRow(i,{rate:v})} ph="L/m², m²/m³, mm"/><//><${Fld} label="Area (m²)"><${In} v=${r.area} on=${v=>setRow(i,{area:v})}/><//>
          <${Fld} label="Delivered (t or L)"><${In} v=${r.delivered} on=${v=>setRow(i,{delivered:v})}/><//><${Fld} label="Deductions"><${In} v=${r.deductions} on=${v=>setRow(i,{deductions:v})}/><//>
          <${Fld} label="Claimed"><${In} v=${r.claimed} on=${v=>setRow(i,{claimed:v})} ph=${r.delivered!==''?String(t1(n0(r.delivered)-n0(r.deductions))):''}/><//></div>
        <div class="flex flex-wrap items-center gap-3"><button type="button" class="btn btn-primary qa-aqr-confirm" onClick=${()=>confirm(i)}>Confirm product</button>
          <button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>{delRow(i);setErr('')}}>Remove</button></div></div>`)}
      ${err&&html`<div id="qa-aqr-err" class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      ${f.canEdit&&html`<div><button id="qa-aqr-add" type="button" class="btn" onClick=${()=>f.set('aqr',x=>({...x,rows:[...(x.rows||[]),aqrRow()]}))}>${Icon.plus} Add product</button></div>`}
      <div class="grid gap-3 sm:grid-cols-2"><${Sig} f=${f} form="aqr_afa" label="Agreed by: Alex Fraser Asphalt quality representative" other="Someone else signs for AFA"/>
        <${Sig} f=${f} form="aqr_client" label="Agreed by: client representative" me=${false} other="Client representative signs"/></div><//>`},
  pdf:o=>{const d=o.p.forms.aqr;const doc=o.doc;o.newPage('p');o.page('AGREED QUANTITY RECORD');let y=24;y=lotGrid(o,y,['client','job_no','location','date','lot_desc','start_ch','end_ch']);
    y=table(o,y+3,[['Product',1],['Description',1.6],['Application rate',1.1],['Area',.8],['Delivered to site',1],['Deductions',.9],['Claimed',.9]],(d.rows||[]).map(r=>[r.product,r.description,r.rate,r.area,r.delivered,r.deductions,fmtN(t1(claimedOf(r)))]));
    doc.setFont('helvetica','bold');doc.setFontSize(9.5);o.txt(`Total tonnes claimed: ${fmtN(t1((d.rows||[]).reduce((a,r)=>a+claimedOf(r),0)))}`,o.M,y+5);y+=12;
    y=sigBlock(o,y,'aqr_afa','Quantities agreed by: Alex Fraser Asphalt quality representative');y=sigBlock(o,y+3,'aqr_client','Client representative')}};

/* ---------- hold point release ---------- */
const HOLD={id:'hold',label:'Hold point release',short:'Hold point',
  make:(data,e)=>({comments:'',attention:'',released:false,no_client:false,...holdPlanned(e)}),
  Editor:({f})=>{const d=f.pack.forms.hold;const set=p=>f.set('hold',x=>({...x,...p}));const pl=holdPlanOf(d,f.e);
    return html`<${FormCard} f=${f} id="hold" title="Hold point release" sub=${d.released?'Released: work on this lot may proceed':'Authorisation to proceed'} sigForms=${['hold_afa','hold_client']}>
      <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid gap-3">
        <div class="grid grid-cols-2 gap-3"><${Fld} label="Planned tonnes"><${In} id="qa-hold-pt" v=${pl.planned_t} on=${v=>set({planned_t:v})} ph="t"/><//><${Fld} label="Planned area (m²)"><${In} id="qa-hold-pa" v=${pl.planned_a} on=${v=>set({planned_a:v})} ph="m²"/><//></div>
        <${Fld} label="Comments"><textarea id="qa-hold-comments" class="field" rows="2" style=${{height:'auto',padding:'6px 10px',fontSize:13}} value=${d.comments} onInput=${e=>set({comments:e.target.value})}></textarea><//></fieldset>
      <${Sig} f=${f} form="hold_afa" label="Alex Fraser Asphalt quality representative" other="Someone else signs for AFA"/>
      <div class="label mt-1">Client response</div>
      <label class="inline-flex items-start gap-2 text-[13.5px] cursor-pointer"><input id="qa-hold-noclient" type="checkbox" class="w-4 h-4 mt-0.5" disabled=${!f.canEdit} checked=${!!d.no_client} onChange=${e=>set({no_client:e.target.checked})}/>Customer not on site: no client signature required</label>
      ${!d.no_client&&html`<fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid gap-3">
        <${Fld} label="The following requires attention"><textarea id="qa-hold-attention" class="field" rows="2" style=${{height:'auto',padding:'6px 10px',fontSize:13}} value=${d.attention} onInput=${e=>set({attention:e.target.value})}></textarea><//>
        <label class="inline-flex items-start gap-2 text-[13.5px] cursor-pointer"><input id="qa-hold-released" type="checkbox" class="w-4 h-4 mt-0.5" checked=${!!d.released} onChange=${e=>set({released:e.target.checked})}/>Release of the hold point is granted. Work on this lot may proceed.</label></fieldset>
      <${Sig} f=${f} form="hold_client" label="Client representative" me=${false} other="Client representative signs"/>`}<//>`},
  pdf:o=>{const d=o.p.forms.hold;const doc=o.doc;o.newPage('p');o.page('HOLD POINT RELEASE FORM · Authorisation to Proceed');let y=24;y=lotGrid(o,y,['client','job_no','location','date','lot_desc','start_ch','end_ch']);
    const pl=holdPlanOf(d,o.e);y=kvGrid(o,y+2,[['Planned tonnes',pl.planned_t?pl.planned_t+' t':''],['Planned area',pl.planned_a?pl.planned_a+' m2':'']],2);
    y=para(o,y+3,'Comments',d.comments);y=sigBlock(o,y+2,'hold_afa','Alex Fraser Asphalt quality representative');
    doc.setFont('helvetica','bold');doc.setFontSize(10);doc.setTextColor(153,10,44);o.txt('Client response',o.M,y+6);y+=8;
    if(d.no_client){doc.setFont('helvetica','bold');doc.setFontSize(9.5);doc.setTextColor(0,0,0);o.txt('Customer not on site: no client signature required.',o.M,y+5);return}
    y=para(o,y,'The following requires attention',d.attention);
    doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(0,0,0);o.txt(`${d.released?'[✓]':'[  ]'} Release of the Hold Point described above is hereby granted. Work on this lot may proceed.`.replace('✓','x'),o.M,y+5);y+=9;
    y=sigBlock(o,y,'hold_client','Client representative')}};

/* the shift's planned tonnes and area (from the booking), unless typed in */
function holdPlanned(e){const ls=e?linesOn(e.b,e.k):[];const t=ls.reduce((a,l)=>a+n0(l.tonnes),0),a=ls.reduce((s,l)=>s+n0(l.area),0);return {planned_t:t?String(t1(t)):'',planned_a:a?String(t1(a)):''}}
const holdPlanOf=(d,e)=>{const c=holdPlanned(e);return {planned_t:d.planned_t!=null?d.planned_t:c.planned_t,planned_a:d.planned_a!=null?d.planned_a:c.planned_a}};
/* ---------- field site diagram ---------- */
function shrinkPhoto(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const sc=Math.min(1,1280/Math.max(im.width,im.height));
  const c=document.createElement('canvas');c.width=Math.round(im.width*sc);c.height=Math.round(im.height*sc);c.getContext('2d').drawImage(im,0,0,c.width,c.height);res(c.toDataURL('image/jpeg',.7))};im.onerror=rej;im.src=r.result};r.onerror=rej;r.readAsDataURL(file)})}
/* the site diagram: a full-screen drawing with a pen, straight lines, arrows, boxes, text labels and colours.
   Shapes are kept (as fractions of the page, 4:3) so the drawing can be changed later; a picture is saved for the PDF. */
const DG_COLOURS=['#111111','#d11a2a','#1f5fd6','#178a3e','#e07b00','#8a2be2'];
const DG_TOOLS=[['select','Select'],['pen','Pen'],['line','Line'],['arrow','Arrow'],['box','Box'],['circle','Circle'],['text','Text']];
/* quick labels: a starting list, plus any this phone has saved */
const DG_QUICK=['Patch','Overlay','Kerb','Driveway','Gully pit','Start','Finish','Joint','Profiled','Crossover'];
const QK=KEY+':dg-quick';const quickMine=()=>{try{return JSON.parse(localStorage.getItem(QK)||'[]')||[]}catch(e){return []}};
const fontFor=(s,W)=>`600 ${Math.round(s.size*W)}px "IBM Plex Sans",system-ui,sans-serif`;
function drawShapes(g,W,H,shapes,grid,selI){
  g.fillStyle='#fff';g.fillRect(0,0,W,H);
  if(grid){g.strokeStyle='#eef0f3';g.lineWidth=1;for(let i=1;i<20;i++){const x=Math.round(W*i/20)+.5,y=Math.round(H*i/20)+.5;g.beginPath();g.moveTo(x,0);g.lineTo(x,H);g.stroke();g.beginPath();g.moveTo(0,y);g.lineTo(W,y);g.stroke()}}
  const P=([x,y])=>[x*W,y*H];g.lineCap='round';g.lineJoin='round';
  shapes.forEach(s=>{g.strokeStyle=s.c;g.fillStyle=s.c;g.lineWidth=s.w*W/1000;
    if(s.t==='pen'){g.beginPath();s.pts.forEach((p,i)=>{const [x,y]=P(p);i?g.lineTo(x,y):g.moveTo(x,y)});if(s.pts.length===1){const [x,y]=P(s.pts[0]);g.lineTo(x+.1,y+.1)}g.stroke()}
    else if(s.t==='line'||s.t==='arrow'){const [x1,y1]=P(s.a),[x2,y2]=P(s.b);g.beginPath();g.moveTo(x1,y1);g.lineTo(x2,y2);g.stroke();
      if(s.t==='arrow'){const a=Math.atan2(y2-y1,x2-x1),L=Math.max(10,g.lineWidth*4);g.beginPath();g.moveTo(x2,y2);g.lineTo(x2-L*Math.cos(a-.45),y2-L*Math.sin(a-.45));g.lineTo(x2-L*Math.cos(a+.45),y2-L*Math.sin(a+.45));g.closePath();g.fill()}}
    else if(s.t==='box'){const [x1,y1]=P(s.a),[x2,y2]=P(s.b);g.strokeRect(Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1))}
    else if(s.t==='circle'){const [x1,y1]=P(s.a),[x2,y2]=P(s.b);g.beginPath();g.ellipse((x1+x2)/2,(y1+y2)/2,Math.max(1,Math.abs(x2-x1)/2),Math.max(1,Math.abs(y2-y1)/2),0,0,Math.PI*2);g.stroke()}
    else if(s.t==='text'){const [x,y]=P(s.p);g.font=fontFor(s,W);g.textBaseline='middle';g.fillText(s.s,x,y)}});
  if(selI!=null&&shapes[selI]){const b=boundsOf(g,shapes[selI],W,H);g.save();g.setLineDash([5,4]);g.strokeStyle='#1f5fd6';g.lineWidth=1.5;g.strokeRect(b.x-6,b.y-6,b.w+12,b.h+12);g.restore()}}
/* the box around a shape (pixels), for selecting and highlighting */
function boundsOf(g,s,W,H){
  if(s.t==='text'){g.font=fontFor(s,W);const w=g.measureText(s.s).width,h=s.size*W;return {x:s.p[0]*W,y:s.p[1]*H-h/2,w,h}}
  const pts=s.t==='pen'?s.pts:[s.a,s.b];const xs=pts.map(p=>p[0]*W),ys=pts.map(p=>p[1]*H);const x=Math.min(...xs),y=Math.min(...ys);return {x,y,w:Math.max(...xs)-x,h:Math.max(...ys)-y}}
const segDist=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1];const L=dx*dx+dy*dy;let t=L?((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L:0;t=Math.max(0,Math.min(1,t));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)};
/* is the point (pixels) on this shape? */
function hitShape(g,s,P,W,H){const T=([x,y])=>[x*W,y*H];const tol=Math.max(12,s.w*W/1000/2+8);
  if(s.t==='text'){const b=boundsOf(g,s,W,H);return P[0]>=b.x-6&&P[0]<=b.x+b.w+6&&P[1]>=b.y-6&&P[1]<=b.y+b.h+6}
  if(s.t==='pen'){const q=s.pts.map(T);if(q.length===1)return Math.hypot(P[0]-q[0][0],P[1]-q[0][1])<tol;for(let i=1;i<q.length;i++)if(segDist(P,q[i-1],q[i])<tol)return true;return false}
  const a=T(s.a),b=T(s.b);
  if(s.t==='line'||s.t==='arrow')return segDist(P,a,b)<tol;
  if(s.t==='box'){const c=[[a[0],a[1]],[b[0],a[1]],[b[0],b[1]],[a[0],b[1]]];for(let i=0;i<4;i++)if(segDist(P,c[i],c[(i+1)%4])<tol)return true;return false}
  if(s.t==='circle'){const cx=(a[0]+b[0])/2,cy=(a[1]+b[1])/2,rx=Math.max(1,Math.abs(b[0]-a[0])/2),ry=Math.max(1,Math.abs(b[1]-a[1])/2);const k=Math.hypot((P[0]-cx)/rx,(P[1]-cy)/ry);return Math.abs(k-1)*Math.min(rx,ry)<tol||k<1}
  return false}
const moved=(s,dx,dy)=>{const m=([x,y])=>[x+dx,y+dy];return s.t==='pen'?{...s,pts:s.pts.map(m)}:s.t==='text'?{...s,p:m(s.p)}:{...s,a:m(s.a),b:m(s.b)}};
function SketchDialog({initial,aspect:a0,onSave,onClose}){
  /* the page's shape: kept from the first drawing; a new one is portrait on an upright phone, landscape otherwise */
  const [AR]=useState(()=>a0||(window.innerHeight>window.innerWidth*1.15?3/4:4/3));
  const cv=useRef(null),box=useRef(null);const [hist,setHist]=useState(()=>[initial||[]]);const shapes=hist[hist.length-1];
  const [tool,setTool]=useState('pen');const [col,setCol]=useState(DG_COLOURS[0]);const [thick,setThick]=useState(false);
  const cur=useRef(null);const drag=useRef(null);const [,tick]=useState(0);const [txt,setTxt]=useState(null);const [sz,setSz]=useState({w:300,h:225});
  const [sel,setSel]=useState(null);const [mine,setMine]=useState(quickMine);
  const push=n=>setHist(h=>[...h,n]);
  /* the page fits the space inside the box (less its padding), so the whole drawing shows without zooming out;
     refitted when the space changes (turning the phone, the tools wrapping onto more rows) */
  useEffect(()=>{const fit=()=>{const el=box.current;if(!el)return;const cs=getComputedStyle(el);
      const W=el.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight),H=el.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);
      if(W<=0||H<=0)return;let w=W,h=w/AR;if(h>H){h=H;w=h*AR}setSz(o=>o.w===Math.floor(w)&&o.h===Math.floor(h)?o:{w:Math.floor(w),h:Math.floor(h)})};
    fit();window.addEventListener('resize',fit);let ro=null;try{ro=new ResizeObserver(fit);ro.observe(box.current)}catch(e){}
    return()=>{window.removeEventListener('resize',fit);try{ro&&ro.disconnect()}catch(e){}}},[]);
  const view=()=>{let l=cur.current?[...shapes,cur.current]:shapes;const dr=drag.current;if(dr&&dr.moved)l=l.map((x,k)=>k===dr.i?moved(dr.orig,dr.dx,dr.dy):x);return l};
  useEffect(()=>{const c=cv.current;if(!c)return;const dpr=Math.min(2,window.devicePixelRatio||1);c.width=Math.round(sz.w*dpr);c.height=Math.round(sz.h*dpr);
    const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);drawShapes(g,sz.w,sz.h,view(),true,sel)});
  const pt=e=>{const r=cv.current.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))]};
  const S=useRef({});S.current={tool,col,thick,shapes,sel};   /* what's chosen right now, for the pointer handlers */
  const down=e=>{e.preventDefault();const p=pt(e);const {tool,col,thick,shapes}=S.current;const w=thick?7:3;
    if(tool==='select'){const g=cv.current.getContext('2d');let hitI=-1;for(let k=shapes.length-1;k>=0;k--)if(hitShape(g,shapes[k],[p[0]*sz.w,p[1]*sz.h],sz.w,sz.h)){hitI=k;break}
      setSel(hitI>=0?hitI:null);setTxt(null);if(hitI>=0){try{cv.current.setPointerCapture(e.pointerId)}catch(x){}drag.current={i:hitI,orig:shapes[hitI],p0:p,dx:0,dy:0,moved:false}}return}
    if(tool==='text'){setTxt({p,value:''});return}
    try{cv.current.setPointerCapture(e.pointerId)}catch(x){}
    cur.current=tool==='pen'?{t:'pen',pts:[p],c:col,w}:{t:tool,a:p,b:p,c:col,w};tick(x=>x+1)};
  const move=e=>{const p=pt(e);const dr=drag.current;if(dr){e.preventDefault();dr.dx=p[0]-dr.p0[0];dr.dy=p[1]-dr.p0[1];if(Math.hypot(dr.dx*sz.w,dr.dy*sz.h)>3)dr.moved=true;tick(x=>x+1);return}
    if(!cur.current)return;e.preventDefault();if(cur.current.t==='pen')cur.current.pts.push(p);else cur.current.b=p;tick(x=>x+1)};
  const up=()=>{const dr=drag.current;if(dr){drag.current=null;if(dr.moved)setHist(h=>{const l=h[h.length-1];return [...h,l.map((x,k)=>k===dr.i?moved(dr.orig,dr.dx,dr.dy):x)]});tick(x=>x+1);return}
    const s=cur.current;if(!s)return;cur.current=null;
    if(s.t!=='pen'&&Math.hypot(s.a[0]-s.b[0],s.a[1]-s.b[1])<.004){tick(x=>x+1);return}   /* a tap, not a line */
    if(s.t==='pen')s.pts=s.pts.map(([x,y])=>[Math.round(x*10000)/10000,Math.round(y*10000)/10000]);setHist(h=>[...h,[...h[h.length-1],s]])};
  const addText=v0=>{const v=(v0!=null?v0:(txt&&txt.value||'')).trim();const {col,thick}=S.current;
    if(v){if(txt&&txt.edit!=null)setHist(h=>{const l=h[h.length-1];return [...h,l.map((x,k)=>k===txt.edit?{...x,s:v}:x)]});
      else{const t={t:'text',p:txt.p,s:v,c:col,size:thick?.036:.026};setHist(h=>[...h,[...h[h.length-1],t]])}}setTxt(null)};
  const delSel=()=>{if(sel==null)return;setHist(h=>{const l=h[h.length-1];return [...h,l.filter((x,k)=>k!==sel)]});setSel(null)};
  const saveQuick=v=>{v=(v||'').trim();if(!v||DG_QUICK.includes(v)||mine.includes(v))return;const n=[...mine,v];setMine(n);try{localStorage.setItem(QK,JSON.stringify(n))}catch(e){}};
  const dropQuick=v=>{const n=mine.filter(x=>x!==v);setMine(n);try{localStorage.setItem(QK,JSON.stringify(n))}catch(e){}};
  const save=()=>{const W=AR>=1?1600:1200,H=AR>=1?1200:1600;const c=document.createElement('canvas');c.width=W;c.height=H;drawShapes(c.getContext('2d'),W,H,shapes,false,null);onSave({png:c.toDataURL('image/png'),shapes,aspect:AR})};
  const tb='inline-flex items-center justify-center h-9 px-2.5 rounded-lg border text-[12.5px] font-medium shrink-0';
  const selS=sel!=null&&shapes[sel];
  return html`<div class="fixed inset-0 z-[70] flex flex-col" style=${{background:'var(--bg)'}} role="dialog" aria-modal="true" aria-label="Draw the site diagram" id="qa-sketch">
    <div class="flex flex-wrap items-center gap-1.5 px-2 py-2 border-b border-line shrink-0" style=${{background:'var(--surface)'}} id="dg-tools">
      ${DG_TOOLS.map(([k,l])=>html`<button key=${k} type="button" id=${'dg-tool-'+k} class=${tb} aria-pressed=${tool===k} style=${{borderColor:tool===k?'var(--accent)':'var(--line)',background:tool===k?'var(--accent-soft)':'var(--surface)'}} onClick=${()=>{setTool(k);setTxt(null);if(k!=='select')setSel(null)}}>${l}</button>`)}
      <span class="w-px h-6 bg-line mx-1 shrink-0"></span>
      ${DG_COLOURS.map(c=>html`<button key=${c} type="button" class="w-8 h-8 rounded-full shrink-0 dg-colour" aria-label=${'Colour '+c} aria-pressed=${col===c} style=${{background:c,boxShadow:col===c?'0 0 0 2px var(--surface),0 0 0 4px var(--ink)':'none'}}
        onClick=${()=>{setCol(c);if(selS)setHist(h=>{const l=h[h.length-1];return [...h,l.map((x,k)=>k===sel?{...x,c}:x)]})}}></button>`)}
      <span class="w-px h-6 bg-line mx-1 shrink-0"></span>
      <button type="button" id="dg-thick" class=${tb} style=${{borderColor:'var(--line)'}} onClick=${()=>setThick(!thick)} title="Line thickness and text size">${thick?'Thick':'Thin'}</button>
      <button type="button" id="dg-undo" class=${tb} style=${{borderColor:'var(--line)'}} disabled=${hist.length<2} onClick=${()=>{setSel(null);setHist(h=>h.length>1?h.slice(0,-1):h)}}>Undo</button>
      <button type="button" id="dg-clear" class=${tb} style=${{borderColor:'var(--line)'}} disabled=${!shapes.length} onClick=${()=>{setSel(null);push([])}}>Clear</button>
    </div>
    <div class="h-[46px] shrink-0 px-3 flex items-center gap-2 border-b border-line text-[12.5px] overflow-hidden" style=${{background:selS?'var(--accent-soft)':'transparent'}}>
      ${selS?html`<span class="flex-1 min-w-0 truncate" id="dg-selbar">${({pen:'Drawing',line:'Line',arrow:'Arrow',box:'Box',circle:'Circle',text:'Label'})[selS.t]} selected · drag to move it</span>
        ${selS.t==='text'&&html`<button type="button" id="dg-sel-edit" class="btn shrink-0" style=${{height:32}} onClick=${()=>setTxt({p:selS.p,value:selS.s,edit:sel})}>Edit text</button>`}
        <button type="button" id="dg-sel-del" class="btn shrink-0" style=${{height:32,color:'var(--bad)'}} onClick=${delSel}>${Icon.trash} Delete</button>`
      :html`<span class="text-[12px] text-muted leading-snug" style=${{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden'}}>${tool==='select'?'Tap something to select it, then drag it, change its colour or delete it.':tool==='text'?'Tap where the label goes, then type it or pick a quick label.':tool==='pen'?'Draw freehand. Mark patchwork clearly, with chainages.':'Drag from one point to another. Turn the phone sideways for more room.'}</span>`}
    </div>
    <div ref=${box} class="flex-1 min-h-0 min-w-0 overflow-hidden p-3 flex items-center justify-center">
      <div class="relative" style=${{width:sz.w,height:sz.h}}>
        <canvas ref=${cv} id="dg-canvas" class="block rounded-lg border border-line" style=${{width:sz.w,height:sz.h,touchAction:'none',cursor:tool==='text'?'text':tool==='select'?'pointer':'crosshair',background:'#fff'}}
          onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}></canvas>
        ${txt&&html`<div class="absolute grid gap-1.5 rounded-lg p-2 shadow" id="dg-textbox" style=${{left:Math.max(0,Math.min(txt.p[0]*sz.w,sz.w-280)),top:Math.max(0,Math.min(txt.p[1]*sz.h-20,sz.h-170)),width:Math.min(280,sz.w),background:'var(--surface)',border:'1px solid var(--line)',zIndex:2}}>
          <div class="flex items-center gap-1"><input id="dg-text" class="field" style=${{height:36,fontSize:16,flex:1,minWidth:0}} placeholder="Label" autoFocus=${true} value=${txt.value} onInput=${e=>{const v=e.target.value;setTxt(t=>({...t,value:v}))}} onKeyDown=${e=>{if(e.key==='Enter')addText();if(e.key==='Escape')setTxt(null)}}/>
            <button id="dg-text-add" type="button" class="btn btn-primary" style=${{height:32}} onClick=${()=>addText()}>${txt.edit!=null?'Save':'Add'}</button></div>
          ${txt.edit==null&&html`<div class="flex flex-wrap gap-1 max-h-[96px] overflow-y-auto" id="dg-quick">${[...DG_QUICK,...mine].map(q=>html`<span key=${q} class="inline-flex items-center rounded-full border border-line text-[12px] overflow-hidden">
              <button type="button" class="px-2 py-0.5 hover:bg-sunken dg-q" onClick=${()=>addText(q)}>${q}</button>${mine.includes(q)&&html`<button type="button" class="px-1 text-faint hover:text-ink" aria-label=${'Remove quick label '+q} onClick=${()=>dropQuick(q)}>×</button>`}</span>`)}</div>
            ${(txt.value||'').trim()&&![...DG_QUICK,...mine].includes(txt.value.trim())&&html`<button type="button" id="dg-quick-save" class="text-[12px] text-left" style=${{color:'var(--accent)'}} onClick=${()=>saveQuick(txt.value)}>+ Save “${txt.value.trim()}” as a quick label</button>`}`}</div>`}
      </div>
    </div>
    <div class="flex items-center gap-2 px-3 py-2 border-t border-line" style=${{background:'var(--surface)',paddingBottom:'max(8px, env(safe-area-inset-bottom, 0px))'}}>
      <span class="text-[12px] text-muted flex-1">${shapes.length} mark${shapes.length===1?'':'s'}</span>
      <button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="qa-sketch-save" type="button" class="btn btn-primary" disabled=${!shapes.length} onClick=${save}>Save drawing</button>
    </div></div>`;
}
const dgLayer=()=>({layer:'',depth:'',mix:'',area:''});
/* the layers on the job (older packs kept one layer in layer/depth/mix) */
const layersOf=d=>Array.isArray(d.layers)&&d.layers.length?d.layers:[{layer:d.layer||'',depth:d.depth||'',mix:d.mix||'',area:d.area||''}];
const DIAGRAM={id:'diagram',label:'Field site diagram',short:'Site diagram',
  make:(data,e,p,ctx)=>{const ls=linesOn(e.b,e.k).filter(l=>l.type);
    return {layers:ls.length?ls.map(l=>({layer:'',depth:l.depth?`${l.depth} mm`:'',mix:l.type,area:l.area?String(l.area):''})):[dgLayer()],prepared_by:ctx.myName||'',sketch:null,photos:[]}},
  Editor:({f})=>{const d=f.pack.forms.diagram;const set=p=>f.set('diagram',x=>({...x,...p}));const [draw,setDraw]=useState(false);const [busy,setBusy]=useState(false);
    const addPhotos=async files=>{setBusy(true);try{const out=[];for(const fl of [...files].slice(0,4-(d.photos||[]).length))out.push(await shrinkPhoto(fl));set({photos:[...(d.photos||[]),...out]})}catch(e){}finally{setBusy(false)}};
    return html`<${FormCard} f=${f} id="diagram" title="Field site diagram" sub="All patchwork must be clearly measured and marked on the map with chainages" sigForms=${[]}>
      <div class="grid gap-2" id="qa-dg-layers">${layersOf(d).map((L,i,all)=>{const setL=p=>set({layers:layersOf(d).map((x,k)=>k===i?{...x,...p}:x)});
        return html`<div key=${i} class=${rowStyle+' qa-dg-layer'}><div class="flex items-center gap-2"><span class="text-[12.5px] font-semibold flex-1">Layer ${i+1}</span>
            ${f.canEdit&&all.length>1&&html`<button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>set({layers:layersOf(d).filter((x,k)=>k!==i)})}>Remove</button>`}</div>
          <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid grid-cols-2 lg:grid-cols-4 gap-2">
            <${Fld} label="Layer"><${In} v=${L.layer} on=${v=>setL({layer:v})} ph="e.g. Wearing course"/><//><${Fld} label="Nominal depth"><${In} v=${L.depth} on=${v=>setL({depth:v})} ph="e.g. 50 mm"/><//>
            <${Fld} label="Mix type"><${In} v=${L.mix} on=${v=>setL({mix:v})}/><//><${Fld} label="Area m²"><input type="number" inputmode="decimal" class="field qa-dg-area" style=${fs} value=${L.area} onInput=${e=>setL({area:e.target.value})}/><//></fieldset></div>`})}
        ${f.canEdit&&html`<div><button id="qa-dg-add-layer" type="button" class="btn" onClick=${()=>set({layers:[...layersOf(d),dgLayer()]})}>${Icon.plus} Add a layer</button></div>`}</div>
      <fieldset disabled=${!f.canEdit} class="m-0 p-0 border-0 min-w-0 grid grid-cols-2 gap-3"><${Fld} label="Map prepared by"><${In} id="qa-dg-by" v=${d.prepared_by} on=${v=>set({prepared_by:v})}/><//></fieldset>
      ${d.sketch?html`<img id="qa-dg-sketch" src=${d.sketch} alt="Site diagram" class="w-full rounded-lg border border-line bg-white"/>`:html`<div class="text-[12.5px] text-muted">No drawing yet.</div>`}
      ${(d.photos||[]).length>0&&html`<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${d.photos.map((ph,i)=>html`<div key=${i} class="relative"><img src=${ph} alt=${'Site photo '+(i+1)} class="w-full h-28 object-cover rounded-lg border border-line qa-dg-photo"/>
        ${f.canEdit&&html`<button type="button" class="absolute top-1 right-1 btn px-1.5" style=${{height:26}} aria-label="Remove photo" onClick=${()=>set({photos:d.photos.filter((x,k)=>k!==i)})}>${Icon.x}</button>`}</div>`)}</div>`}
      ${f.canEdit&&html`<div class="flex flex-wrap gap-2"><button id="qa-dg-draw" type="button" class="btn" onClick=${()=>setDraw(true)}>${Icon.pencil} ${d.sketch?'Redraw':'Draw the diagram'}</button>
        ${d.sketch&&html`<button type="button" class="btn" onClick=${()=>set({sketch:null,shapes:null})}>Remove drawing</button>`}
        ${(d.photos||[]).length<4&&html`<label class="btn cursor-pointer">${Icon.plus} ${busy?'Adding…':'Photo of a hand-drawn map'}<input id="qa-dg-photo" type="file" accept="image/*" capture="environment" multiple class="sr-only" onChange=${e=>{addPhotos(e.target.files);e.target.value=''}}/></label>`}</div>`}
      ${draw&&html`<${SketchDialog} initial=${d.shapes||null} aspect=${d.shapes&&d.shapes.length?d.aspect||4/3:null} onClose=${()=>setDraw(false)} onSave=${r=>{set({sketch:r.png,shapes:r.shapes,aspect:r.aspect});setDraw(false)}}/>`}<//>`},
  pdf:o=>{const d=o.p.forms.diagram;const doc=o.doc;o.newPage('p');o.page('FIELD SITE DIAGRAM');let y=24;
    y=kvGrid(o,y,[['Job location',o.lot.location],['Customer',o.lot.client],['Date',dateTxt(o.lot.date)],['Job number',o.lot.job_no],['Start chainage',o.lot.start_ch],['End chainage',o.lot.end_ch],['Map prepared by',d.prepared_by]]);
    y=table(o,y+2,[['Layer',1.4],['Nominal depth',1],['Mix type',1.4],['Area m²',1]],layersOf(d).map((L,i)=>[L.layer||`Layer ${i+1}`,L.depth,L.mix,L.area?fmtN(n0(L.area)):'']));
    doc.setFont('helvetica','italic');doc.setFontSize(8.5);doc.setTextColor(94,99,110);o.txt('All patchwork must be clearly measured and marked on the map with chainages',o.M,y+4);y+=7;
    const W=doc.internal.pageSize.getWidth()-2*o.M;const pics=[d.sketch,...(d.photos||[])].filter(Boolean);
    pics.forEach((im,i)=>{try{const pr=doc.getImageProperties(im);const w=W,h=Math.min(pr.height*w/pr.width,(i===0?170:120));const ww=pr.width*h/pr.height;
      if(y+h>285){o.newPage('p');o.page('FIELD SITE DIAGRAM (continued)');y=24}doc.addImage(im,/jpeg/i.test(im.slice(5,20))?'JPEG':'PNG',o.M,y,Math.min(w,ww),h,'dg'+i,'FAST');o.box(o.M,y,Math.min(w,ww),h);y+=h+4}catch(e){}});
    if(!pics.length){o.box(o.M,y,W,170);y+=172}}};

/* ---------- asphalt laying record ---------- */
/* reading a delivery docket with the phone camera (tesseract.js, in the browser; it keeps working without reception once loaded) */
const OCR_JS='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const OCR_LANG='https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int';
let ocrWorker=null;
function loadOcr(){if(ocrWorker)return ocrWorker;
  ocrWorker=(async()=>{if(!window.Tesseract)await new Promise((res,rej)=>{const s=document.createElement('script');s.src=OCR_JS;s.onload=res;s.onerror=()=>rej(new Error('The docket reader didn’t load. Check the connection and try again.'));document.head.appendChild(s)});
    let w;try{w=await window.Tesseract.createWorker('eng',1,{langPath:OCR_LANG})}catch(e){w=await window.Tesseract.createWorker('eng')}
    try{await w.setParameters({tessedit_pageseg_mode:'6'})}catch(e){}return w})().catch(e=>{ocrWorker=null;throw e});
  return ocrWorker}
/* the photo, cleaned up for reading: a sensible size, grey, contrast stretched */
function prepDocket(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{
    const target=Math.max(900,Math.min(1500,im.width*3));const sc=target/im.width;const c=document.createElement('canvas');c.width=Math.round(im.width*sc);c.height=Math.round(im.height*sc);
    const g=c.getContext('2d');g.imageSmoothingQuality='high';g.drawImage(im,0,0,c.width,c.height);
    try{const d=g.getImageData(0,0,c.width,c.height),px=d.data;let lo=255,hi=0;const gr=new Uint8ClampedArray(px.length/4);
      for(let k=0;k<gr.length;k++){const v=Math.round(.3*px[k*4]+.59*px[k*4+1]+.11*px[k*4+2]);gr[k]=v;if(v<lo)lo=v;if(v>hi)hi=v}
      const span=Math.max(1,hi-lo);for(let k=0;k<gr.length;k++){const v=Math.round((gr[k]-lo)*255/span);px[k*4]=px[k*4+1]=px[k*4+2]=v}g.putImageData(d,0,0)}catch(e){}
    res(c)};im.onerror=()=>rej(new Error('That photo couldn’t be opened.'));im.src=r.result};r.onerror=rej;r.readAsDataURL(file)})}
/* the fields we need from an Alex Fraser delivery docket's text */
function parseDocket(t){
  const out={};const fix=v=>v.replace(/[Oo]/g,'0').replace(/[Il|]/g,'1').replace(/[Ss](?=\d)/g,'5');
  const dn=t.match(/Deliv\w*\s*\w{0,3}[:.,]?\s*([0-9OIl|]{6,12})/i);if(dn)out.docket=fix(dn[1]);
  const rg=t.match(/R[e3]g[o0c]\s*[:.,]?\s*([A-Z0-9]{3,8})/i);
  if(rg){let v=rg[1].toUpperCase();const m=v.match(/^([A-Z]{2,3})([A-Z0-9]{2,4})$/);if(m)v=m[1]+m[2].replace(/O/g,'0').replace(/[IL]/g,'1');out.rego=v}
  const nw=t.match(/Net\s*W\w*[:.,]?\s*([0-9]{1,3}[.,][0-9]{1,3})/i);if(nw)out.tonnes=nw[1].replace(',','.');
  const pr=t.match(/Product\s*[:.,]?[^\n\-–]*[\-–]\s*([A-Z0-9][A-Z0-9/]{3,})/i)||t.match(/Product\s*[:.,]?\s*([A-Z]{2}\d[A-Z0-9/]{2,})/i);if(pr)out.product=pr[1].replace(/^4C/,'AC');
  const ld=t.match(/Load\s*No\s*[:.,]?\s*(\d{1,5})/i);if(ld)out.load=String(+ld[1]);
  return out}
window.__parseDocket=parseDocket;
const fmt2=n=>(Math.round(n*100)/100).toLocaleString('en-AU',{maximumFractionDigits:2});
const layRow=()=>({docket:'',rego:'',time:hhmm(),temp:'',tonnes:'',ch_start:'',ch_finish:'',comments:''});
const rowDone=r=>!blank(r.docket)&&n0(r.tonnes)>0&&!blank(r.temp);
function LayingEditor({f}){
  const d=f.pack.forms.laying;const set=p=>f.set('laying',x=>({...x,...p}));const rows=d.rows||[];
  const setRow=(i,p)=>f.set('laying',x=>({...x,rows:x.rows.map((r,k)=>k===i?{...r,...p}:r)}));
  const [open,setOpen]=useState(()=>{const k=rows.findIndex(r=>!rowDone(r));return k});   /* the load being filled in */
  const [busy,setBusy]=useState('');const [err,setErr]=useState('');const fileRef=useRef(null);
  const blocker=rows.findIndex(r=>!rowDone(r));   /* a load still missing its docket, tonnes or temperature */
  const addRow=r=>{f.set('laying',x=>({...x,rows:[...(x.rows||[]),r]}));setOpen(rows.length)};
  const scan=async file=>{if(!file)return;setErr('');setBusy('Reading the docket…');const time=hhmm();
    try{const [w,c]=await Promise.all([loadOcr(),prepDocket(file)]);const {data}=await w.recognize(c);const got=parseDocket(data.text||'');
      addRow({...layRow(),time,docket:got.docket||'',rego:got.rego||'',tonnes:got.tonnes||'',comments:'',product:got.product||'',docket_load:got.load||'',scanned:true});
      if(!got.docket||!got.tonnes)setErr('Some of the docket couldn’t be read. Check it and fill in what’s missing.')}
    catch(e){addRow({...layRow(),time});setErr((e&&e.message)||'The docket couldn’t be read. Type the details in.')}
    finally{setBusy('')}};
  const close=i=>{const r=rows[i];if(blank(r.temp)){setErr('Enter the temperature for this load.');return}if(blank(r.docket)||!(n0(r.tonnes)>0)){setErr('Each load needs its docket number and tonnes.');return}setErr('');setOpen(-1)};
  let run=0;const tot=rows.reduce((a,r)=>a+n0(r.tonnes),0);
  const canAdd=f.canEdit&&blocker<0&&!busy;
  return html`<${FormCard} f=${f} id="laying" title="Asphalt laying record (paving)" sub=${`${rows.length} load${rows.length===1?'':'s'} · ${fmt2((tot))} t`} sigForms=${[]}>
    ${/* the date placed is the shift's date, and the temp gun serial comes from the JSA (Quality): neither is asked again here */''}
    <div class="grid gap-2" id="qa-lay-rows">
      ${rows.map((r,i)=>{run+=n0(r.tonnes);const isOpen=i===open&&f.canEdit;
        return isOpen?html`<div key=${i} class=${rowStyle+' qa-row-laying qa-lay-open'} style=${{boxShadow:'inset 0 0 0 1.5px var(--accent)'}}>
            <div class="flex items-center gap-2 text-[12.5px]"><span class="font-semibold whitespace-nowrap">Load ${i+1}</span><span class="text-muted">${r.scanned?'from the docket · ':''}progressive total ${fmt2((run))} t</span></div>
            ${(()=>{const k=rows.findIndex((x,j)=>j!==i&&!blank(r.docket)&&x.docket===r.docket);return k>=0&&html`<div id="qa-lay-dup" class="text-[12.5px] font-medium rounded-md px-2 py-1" style=${{background:'hsl(38 90% var(--blk-l))'}}>Docket ${r.docket} is already on load ${k+1}. Scanned twice?</div>`})()}
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <${Fld} label="Docket number"><${In} id="qa-lay-docket" v=${r.docket} on=${v=>setRow(i,{docket:v})}/><//><${Fld} label="Truck rego"><${In} id="qa-lay-rego" v=${r.rego} on=${v=>setRow(i,{rego:v.toUpperCase()})}/><//>
              <${Fld} label="Time in"><${In} type="time" v=${r.time} on=${v=>setRow(i,{time:v})}/><//>
              <${Fld} label="Temperature °C *"><input id="qa-lay-temp" type="number" inputmode="decimal" class="field" style=${{...fs,boxShadow:blank(r.temp)?'inset 0 0 0 1.5px hsl(38 90% 48%)':''}} autoFocus=${!!r.scanned} value=${r.temp} onInput=${e=>setRow(i,{temp:e.target.value})}/><//>
              <${Fld} label="Tonnes"><${In} id="qa-lay-tonnes" v=${r.tonnes} on=${v=>setRow(i,{tonnes:v})}/><//></div>
            <div class="grid grid-cols-2 gap-2"><${Fld} label="Chainage start"><${In} id="qa-lay-chs" v=${r.ch_start} on=${v=>setRow(i,{ch_start:v})}/><//><${Fld} label="Chainage finish"><${In} id="qa-lay-chf" v=${r.ch_finish} on=${v=>setRow(i,{ch_finish:v})}/><//></div>
            <${Fld} label="Run location / comments"><${In} v=${r.comments} on=${v=>setRow(i,{comments:v})} ph="e.g. Run 1, overlay / patch"/><//>
            <div class="flex flex-wrap gap-2"><button id="qa-lay-done" type="button" class="btn btn-primary" onClick=${()=>close(i)}>${Icon.plus} Add load</button>
              <button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>{f.set('laying',x=>({...x,rows:x.rows.filter((y,k)=>k!==i)}));setOpen(-1);setErr('')}}>Remove this load</button></div></div>`
          :html`<div key=${i} class="rounded-lg border border-line px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] qa-row-laying qa-lay-line">
            <span class="font-semibold">Load ${i+1}</span>
            <span class="mono">${r.docket||html`<span class="text-faint">no docket</span>`}</span>
            <span class="mono">${r.rego||'–'}</span><span>${r.time||''}</span>
            <span style=${blank(r.temp)?{color:'var(--bad)',fontWeight:600}:null}>${blank(r.temp)?'no temperature':r.temp+' °C'}</span>
            <span class="font-semibold tnum">${r.tonnes||'–'} t</span><span class="text-muted tnum">total ${fmt2((run))} t</span>
            ${(r.ch_start||r.ch_finish)&&html`<span class="text-muted">Ch ${r.ch_start||'?'}–${r.ch_finish||'?'}</span>`}
            ${r.comments&&html`<span class="text-muted truncate max-w-[220px]">${r.comments}</span>`}
            <span class="flex-1"></span>${f.canEdit&&html`<button type="button" class="btn qa-lay-edit" style=${{height:28,fontSize:12}} disabled=${open>=0&&open!==i} onClick=${()=>{setOpen(i);setErr('')}}>${Icon.pencil} Edit</button>`}</div>`})}
    </div>
    ${err&&html`<div id="qa-lay-err" class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
    ${f.canEdit&&html`<div class="flex flex-wrap items-center gap-2">
      <label class=${'btn btn-primary '+(canAdd&&open<0?'cursor-pointer':'opacity-50 pointer-events-none')} style=${{height:42}} id="qa-lay-scan">${busy||html`${Icon.plus} Scan docket`}
        <input ref=${fileRef} id="qa-lay-file" type="file" accept="image/*" capture="environment" class="sr-only" disabled=${!(canAdd&&open<0)} onChange=${e=>{const fl=e.target.files&&e.target.files[0];e.target.value='';scan(fl)}}/></label>
      <button id="qa-lay-add" type="button" class="btn" style=${{height:42}} disabled=${!(canAdd&&open<0)} onClick=${()=>addRow(layRow())}>Add without scanning</button>
      ${blocker>=0&&open<0&&html`<span class="text-[12px]" style=${{color:'hsl(30 90% 38%)'}}>Finish load ${blocker+1} (${blank(rows[blocker].temp)?'temperature':'docket and tonnes'}) before adding another.</span>`}</div>`}
    <div class="text-[13.5px] font-semibold" id="qa-lay-total">Total: ${fmt2((tot))} t</div><//>`;
}
/* the calibrated temp gun's serial: entered once, on the JSA (an older laying record may have its own) */
const laySerial=(p,d)=>String((((p||{}).jsa||{}).quality||{}).serial||'').trim()||String((d||{}).serial||'').trim();
const LAYING={id:'laying',label:'Asphalt laying record',short:'Laying record',
  make:(data,e,p,ctx)=>({date_placed:e.k,rows:[],device:'',serial:((p.jsa||{}).quality||{}).serial||'',prepared_by:ctx.myName||''}),
  Editor:LayingEditor,
  pdf:o=>{const d=o.p.forms.laying;const doc=o.doc;o.newPage('p');o.page('ASPHALT LAYING RECORD (PAVING)');let y=24;
    y=kvGrid(o,y,[['Customer',o.lot.client],['Job location',o.lot.location],['Job number',o.lot.job_no],['Date placed',dateTxt(d.date_placed||o.p.shift_date)]],2);let run=0;
    y=table(o,y+2,[['Docket number',1.2],['Truck rego',1],['Time in',.7],['Temperature',.9],['Tonnes',.8],['Progressive total',1],['Chainage start',.9],['Chainage finish',.9],['Run location / comments',2.6]],
      (d.rows||[]).map(r=>{run+=n0(r.tonnes);return [r.docket,r.rego,r.time,r.temp,r.tonnes,fmt2((run)),r.ch_start,r.ch_finish,r.comments]}),'p');
    y=kvGrid(o,y+3,[['Calibrated temp gun serial number',laySerial(o.p,d)],['Total tonnes',fmt2((run))]],2)}};

/* ---------- operations site environmental checklist ---------- */
const ENV_ITEMS=[['residents','Residents notified'],['kerb','Kerb and channel clean'],['gully','Gully pits clean'],['profiling','Profiling required'],['swept','Pave section swept and clean'],['linemarking','Temporary line marking / stick ’n’ stomps'],['prime','Prime / bitumen on kerb, crossovers'],
  ['noise','Noise and dust suppression kept to minimum'],['profilings','Profilings removed from site'],['pits','Gully pits / inspection pipes protected'],['excess','Excess noise generated'],['spills','Fuel, bitumen, oil, emulsion spills contained'],
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
    y=kvGrid(o,y,[['Customer',o.lot.client],['Date',dateTxt(o.lot.date)],['Job number',o.lot.job_no],['Job location',o.lot.location]],3);
    const yn=v=>({yes:'YES',no:'NO',na:'N/A'})[v]||'';
    y=table(o,y+2,[['Item',3],['Pre-surfacing',1],['Post surfacing',1],['Comments',2]],ENV_ITEMS.map(([k,l])=>[l,yn((it[k]||{}).pre),yn((it[k]||{}).post),(it[k]||{}).comment||'']));
    doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(0,0,0);o.txt(`Condition of site prior to paving: ${({safe:'Safe',unsafe:'Unsafe'})[d.before]||'–'}`,o.M,y+5);o.txt(`Condition of site after job complete: ${({clean:'Clean',unclean:'Unclean'})[d.after]||'–'}`,o.M,y+10);y+=14;
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
  pairs.forEach(([k,v],i)=>{const x=o.M+(i%cols)*cw,yy=y+Math.floor(i/cols)*10;o.box(x,yy,cw,10);doc.setFont('helvetica','bold');doc.setFontSize(6.8);doc.setTextColor(0,0,0);o.txt(k,x+1.5,yy+3.4);
    doc.setFont('helvetica','normal');doc.setFontSize(8.8);doc.setTextColor(0,0,0);o.txt(doc.splitTextToSize(String(v||''),cw-3)[0]||'',x+1.5,yy+8)});return y+Math.ceil(pairs.length/cols)*10}
function table(o,y,cols,rows,orient='p'){const doc=o.doc;const W=doc.internal.pageSize.getWidth()-2*o.M,Hh=doc.internal.pageSize.getHeight();const tot=cols.reduce((a,c)=>a+c[1],0);const ws=cols.map(c=>W*c[1]/tot);
  const head=()=>{doc.setFontSize(7);doc.setFont('helvetica','bold');doc.setTextColor(0,0,0);const hs=cols.map((c,i)=>doc.splitTextToSize(c[0],ws[i]-2));const h=Math.max(...hs.map(x=>x.length))*2.9+2.6;let x=o.M;
    hs.forEach((t,i)=>{doc.setFillColor(244,244,246);doc.rect(x,y,ws[i],h,'F');o.box(x,y,ws[i],h);o.txt(t,x+1.1,y+3.3);x+=ws[i]});y+=h};
  head();doc.setFont('helvetica','normal');
  (rows.length?rows:[cols.map(()=>'')]).forEach(r=>{doc.setFontSize(7.8);const cs=r.map((v,i)=>doc.splitTextToSize(String(v==null?'':v),ws[i]-2));const h=Math.max(1,...cs.map(c=>c.length))*3.3+2.4;
    if(y+h>Hh-12){o.newPage(orient);o.page('(continued)');y=24;head();doc.setFont('helvetica','normal');doc.setFontSize(7.8)}
    let x=o.M;cs.forEach((c,i)=>{o.box(x,y,ws[i],h);o.txt(c,x+1.1,y+3.6);x+=ws[i]});y+=h});return y}
function para(o,y,label,text){const doc=o.doc;const W=doc.internal.pageSize.getWidth()-2*o.M;doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.setTextColor(0,0,0);o.txt(label+':',o.M,y+4);
  doc.setFont('helvetica','normal');const t=doc.splitTextToSize(text||'–',W);o.txt(t,o.M,y+8.5);return y+8.5+t.length*3.8}
function sigBlock(o,y,form,label){const doc=o.doc;const W=doc.internal.pageSize.getWidth()-2*o.M;const s=o.sigs.find(x=>x.pack_id===o.p.id&&x.form===form);
  doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.setTextColor(0,0,0);o.txt(label,o.M,y+4);y+=6;const cw=[W*.32,W*.26,W*.2,W*.22];let x=o.M;
  ['Name','Company','Date','Signature'].forEach((h,i)=>{o.box(x,y,cw[i],5);doc.setFontSize(7);o.txt(h,x+1.1,y+3.5);x+=cw[i]});y+=5;x=o.M;cw.forEach(w=>{o.box(x,y,w,12);x+=w});
  if(s){doc.setFont('helvetica','normal');doc.setFontSize(8.5);o.txt(s.name,o.M+1.2,y+7);o.txt(s.company||AFA,o.M+cw[0]+1.2,y+7);doc.setFontSize(7.5);o.txt(o.fmtDT(s.signed_at),o.M+cw[0]+cw[1]+1.2,y+7);
    o.img(s.signature,o.M+cw[0]+cw[1]+cw[2]+2,y+1,28,10,'sig-'+s.id)}else{doc.setFont('helvetica','italic');doc.setFontSize(8);doc.setTextColor(140,145,155);o.txt('Not signed',o.M+1.2,y+7)}
  return y+14}

/* ---------- what each form needs before the pack can be submitted ---------- */
const signedOn=(o,form)=>o.sigs.some(s=>s.pack_id===o.p.id&&s.form===form);
const blank=v=>!String(v==null?'':v).trim();
const LOT_NEED=[['client','Client / customer'],['job_no','Job number'],['location','Job location'],['date','Date']];
const lotCheck=o=>{const L=(o.p.forms||{}).lot||{};return LOT_NEED.filter(([k])=>blank(L[k])).map(([,l])=>l)};
AQR.check=(d,o)=>{const un=(d.rows||[]).filter(r=>!r.ok).length;return [...(!(d.rows||[]).some(r=>r.ok&&!blank(r.product)&&claimedOf(r)>0)?['At least one confirmed product with its quantity']:[]),...(un?[`${un} product${un===1?'':'s'} not confirmed yet`]:[]),...(signedOn(o,'aqr_afa')?[]:['AFA quality rep’s signature']),...(signedOn(o,'aqr_client')?[]:['Client rep’s signature'])]};
HOLD.check=(d,o)=>[...(signedOn(o,'hold_afa')?[]:['AFA quality rep’s signature']),...(!d.no_client&&!d.released&&blank(d.attention)?['Client response: release it, or say what needs attention (or tick customer not on site)']:[]),...(d.no_client||signedOn(o,'hold_client')?[]:['Client rep’s signature'])];
DIAGRAM.check=d=>[...(!d.sketch&&!(d.photos||[]).length?['The diagram (draw it, or add a photo)']:[]),...layersOf(d).flatMap((L,i,a)=>{const n=a.length>1?` (layer ${i+1})`:'';return [...(blank(L.mix)?['Mix type'+n]:[]),...(blank(L.depth)?['Nominal depth'+n]:[]),...(!(n0(L.area)>0)?['Area m²'+n]:[])]}),...(blank(d.prepared_by)?['Map prepared by']:[])];
ENV.check=(d,o)=>{const it=d.items||{};const pre=ENV_ITEMS.filter(([k])=>!(it[k]||{}).pre).length,post=ENV_ITEMS.filter(([k])=>!(it[k]||{}).post).length;
  return [...(pre?[`${pre} item${pre===1?'':'s'} not answered before surfacing`]:[]),...(post?[`${post} item${post===1?'':'s'} not answered after surfacing`]:[]),...(blank(d.before)?['Condition of the site before paving']:[]),...(blank(d.after)?['Condition of the site after the job']:[]),...(signedOn(o,'env')?[]:['Signature of whoever prepared it'])]};
COSTS.check=d=>[...(blank(d.supervisor)?['Supervisor name']:[]),...(blank(d.start_paving)?['Start paving time']:[]),...(blank(d.finish_paving)?['Finish paving time']:[]),...(!d.none&&!(d.rows||[]).some(r=>!blank(r.contractor))?['The external contractors (or tick “No external contractors”)']:[])];
LAYING.check=(d,o)=>[...((d.rows||[]).some(r=>!rowDone(r))?['Every load needs its docket number, tonnes and temperature']:[]),...((d.rows||[]).length&&!laySerial(o&&o.p,d)?['Temp gun serial number (on the JSA, under Quality)']:[])];   /* no loads is fine */
const FORMS=[HOLD,AQR,DIAGRAM,LAYING,ENV,COSTS];
FORMS.forEach(f=>f.required=true);
const SIGN_TITLES={aqr_afa:'Agree the quantities (AFA)',aqr_client:'Agree the quantities (client)',hold_afa:'Hold point (AFA quality rep)',hold_client:'Release the hold point (client)',env:'Sign the environmental checklist'};
const SIGN_NOTES={aqr_afa:'I agree the quantities on this record.',aqr_client:'I agree the quantities on this record.',hold_afa:'Hold point inspection by the Alex Fraser Asphalt quality representative.',
  hold_client:'Signing records the client response above. Tick “Release granted” on the form when work on this lot may proceed.',env:'I prepared this checklist.'};
/* the PDF hooks need the shared lot details */
FORMS.forEach(F=>{const inner=F.pdf;F.pdf=o=>inner({...o,lot:(o.p.forms||{}).lot||newLot(o.data,o.e,o.p)})});
window.FFQF={FORMS,byId:Object.fromEntries(FORMS.map(f=>[f.id,f])),LotCard,newLot,lotCheck,signTitle:k=>SIGN_TITLES[k],signNote:k=>SIGN_NOTES[k]};
})();
