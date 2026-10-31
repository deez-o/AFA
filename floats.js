/* =====================================================================
   FraserFlow: Floats. Moving machines between jobs on the float.
   From the schedule (which machines are on which booking, shift by shift, day or night) it works out every
   move a machine has to make: straight to its next job, or back to the yard when the next job is days away
   (and to the yard for a service). Each move has a window: from when the last shift finishes to when the
   next one starts. Road distance and drive time come from OpenStreetMap routing. The one float's day is then
   planned in order, with clashes and tight or late moves flagged, a live view of what the float should be
   doing now, and the next day's run sheet as a PDF or text for the driver.
   Settings, pick-up times and ticks are kept in the shared roster settings (floatCfg, floatPlan, floatGeo).
   ===================================================================== */
(function(){

/* ---------- settings ---------- */
const NO_FLOAT=/truck|bobcat|skid ?steer|tipper|water ?cart|ute\b|float|trailer|bogie|prime ?mover|semi\b|tanker|spray|car\b|vehicle/i;   /* drive themselves */
const CFG0={yardName:'Yard',yardAddr:'187-193 Potassium St, Narangba QLD',gapDays:3,dayStart:'06:00',nightStart:'18:00',shiftHrs:10,
  loadMin:30,unloadMin:30,slow:1.25,floatStart:'05:00',perLoad:1,driver:'',floatName:'Float',skipCats:null,
  /* what fits on the float together (AFA's float, Oct 2026): machine numbers (the start of the name, or the rego) */
  alone:['PV010'],
  groups:[{name:'Pavers that share',items:['PV008','PV009','PV012']},{name:'Small rollers',items:['SR004','SR005','SR010','SR011','SR013','SR014']},
    {name:'Big rollers',items:['SR012','SR015']},
    {name:'Small multis',items:['MT006']},{name:'Big multis',items:['1AP7VD','MT007','MT008','MT009']}],
  combos:[]};   /* the loads: made in Floats › Settings */
const cfgOf=d=>{const c={...CFG0,...((d&&d.floatCfg)||{})};
  /* groups saved before "Big rollers" was a starting group get it too */
  if(Array.isArray(c.groups)&&!c.groups.some(g=>/(big|large) rollers/i.test(g.name))&&!(c.groupsSeen||[]).includes('Big rollers')){const i=c.groups.findIndex(g=>/small rollers/i.test(g.name));
    const g={name:'Big rollers',items:[]};c.groups=i>=0?[...c.groups.slice(0,i+1),g,...c.groups.slice(i+1)]:[...c.groups,g]}
  return c};
const floatCats=(d,cfg)=>{const cats=machineCatsOf(d);return cfg.skipCats?cats.filter(c=>!cfg.skipCats.includes(c)):cats.filter(c=>!NO_FLOAT.test(c))};
const needsFloat=(m,d,cfg)=>{const c=(m.category||'').trim();if(!c)return !NO_FLOAT.test(m.name+' '+(m.sub||''));
  return cfg.skipCats?!cfg.skipCats.some(x=>x.toLowerCase()===c.toLowerCase()):!NO_FLOAT.test(c)};

/* ---------- time ---------- */
const at=(k,hm)=>{const [y,mo,d]=k.split('-').map(Number);const m=/^(\d{1,2}):(\d{2})/.exec(hm||'')||[0,0,0];return new Date(y,mo-1,d,+m[1],+m[2])};
const addMin=(t,m)=>new Date(t.getTime()+m*60000);
const hm=t=>`${pad(t.getHours())}:${pad(t.getMinutes())}`;
const dayOf=t=>iso(t);
const whenTxt=(t,ref)=>{const k=dayOf(t);return (ref&&k===ref?'':`${WD[t.getDay()]} ${t.getDate()} ${MON[t.getMonth()]} `)+hm(t)};
const durTxt=m=>m==null?'?':m<60?`${Math.round(m)} min`:`${Math.floor(m/60)} h ${pad(Math.round(m%60))}`;
const isoLocal=t=>`${iso(t)}T${hm(t)}`;
const fromIsoLocal=s=>{const m=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s||'');return m?at(m[1],m[2]):null};

/* ---------- where things are ---------- */
const normAddr=a=>String(a||'').toLowerCase().replace(/\(.*?\)/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
function placeOfBooking(d,b,geo){
  const j=d.jobs.find(x=>x.id===b.jobId);const addr=(b.address||(j&&j.address)||'').trim();
  const plan=plansOf(d).find(p=>p.bookingId===b.id)||plansOf(d).find(p=>p.jobId&&p.jobId===b.jobId&&(p.pins||[]).length);
  const pin=plan&&((plan.pins||[]).find(p=>p.type==='float')||(plan.pins||[]).find(p=>p.type==='site'));
  const crew=d.resources.find(r=>r.id===b.resourceId);
  const key=addr?'a:'+normAddr(addr):b.jobId?'j:'+b.jobId:'b:'+b.id;
  const g=geo[normAddr(addr)];
  const ll=pin&&isFinite(+pin.lat)?{lat:+pin.lat,lng:+pin.lng,src:pin.type==='float'?'float pin':'site pin'}:g&&!g.fail?{lat:g.lat,lng:g.lng,src:g.manual?'set by hand':'address'}:null;
  return {key,addr,ll,job:j?jobLabel(j):(addr||'Job'),jobId:b.jobId,crew:crew?crew.name:'',plan:plan&&plan.id};
}
function yardPlace(cfg,geo){const g=geo[normAddr(cfg.yardAddr)];return {key:'yard',addr:cfg.yardAddr,ll:g&&!g.fail?{lat:g.lat,lng:g.lng,src:'address'}:null,job:cfg.yardName||'Yard',crew:'',yard:true}}

/* ---------- 1. where each machine is, shift by shift ---------- */
/* allocations: {m, bid, k, shift, start, end, place, kind:'job'|'service'} */
function allocations(d,cfg,from,to,geo){
  const out=[];const yard=yardPlace(cfg,geo);
  const shiftTimes=(b,k)=>{const q=(b.shiftData||{})[k]||{};const night=b.shift==='night';const s=at(k,q.start||(night?cfg.nightStart:cfg.dayStart));return [s,addMin(s,(+cfg.shiftHrs||10)*60)]};
  d.blocks.forEach(b=>{
    if(!b.start||!b.end||b.end<from||b.start>to)return;
    if(b.kind==='job'){const pl=placeOfBooking(d,b,geo);
      shiftDates(b).forEach(k=>{if(k<from||k>to)return;machinesOn(b,k).forEach(id=>{const [s,e]=shiftTimes(b,k);out.push({m:id,bid:b.id,k,shift:b.shift==='night'?'night':'day',start:s,end:e,place:pl,kind:'job'})})});
      return}
    const r=d.resources.find(x=>x.id===b.resourceId);if(!r||r.type!=='machine')return;
    if(b.kind==='onjob'){const pl=placeOfBooking(d,b,geo);
      for(let k=b.start;k<=b.end;k=iso(addDays(parse(k),1))){if(k<from||k>to)continue;const [s,e]=shiftTimes(b,k);out.push({m:r.id,bid:b.id,k,shift:b.shift==='night'?'night':'day',start:s,end:e,place:pl,kind:'job'})}}
    else if(['service','repair','inspection'].includes(b.kind)){
      for(let k=b.start;k<=b.end;k=iso(addDays(parse(k),1))){if(k<from||k>to)continue;out.push({m:r.id,bid:b.id,k,shift:'day',start:at(k,'07:00'),end:at(k,'15:30'),place:{...yard,job:(KINDS[b.kind]||{label:'Service'}).label+' · '+(cfg.yardName||'Yard')},kind:'service'})}}
  });
  return out}

/* ---------- 2. the moves ---------- */
function buildMoves(d,opt){
  const cfg=opt.cfg||cfgOf(d),geo=opt.geo||{},now=opt.now||new Date();
  const from=opt.from,to=opt.to;const yard=yardPlace(cfg,geo);
  const machines=d.resources.filter(r=>r.type==='machine'&&needsFloat(r,d,cfg));
  const all=allocations(d,cfg,from,to,geo);
  const moves=[],clashes=[];const gapMs=(+cfg.gapDays||3)*864e5;
  machines.forEach(m=>{
    const A=all.filter(a=>a.m===m.id).sort((a,b)=>a.start-b.start||a.end-b.end);
    /* a machine in two places at once */
    for(let i=0;i<A.length;i++)for(let j=i+1;j<A.length&&A[j].start<A[i].end;j++){const a=A[i],b=A[j];
      if(a.bid!==b.bid&&!clashes.some(c=>c.m===m.id&&c.k===b.k&&((c.a===a.bid&&c.b===b.bid)||(c.a===b.bid&&c.b===a.bid))))
        clashes.push({m:m.id,name:m.name,k:b.k,a:a.bid,b:b.bid,pa:a.place,pb:b.place,ka:a.kind,kb:b.kind})}
    /* stints: a run of shifts at one place */
    const S=[];A.forEach(a=>{const s=S[S.length-1];if(s&&s.place.key===a.place.key){   /* same place: the machine stays (weekends, breaks) */if(a.end>s.end){s.end=a.end;s.last=a}s.n++;return}
      S.push({place:a.place,start:a.start,end:a.end,first:a,last:a,n:1,kind:a.kind})});
    const mk=(kind,fromP,toP,earliest,latest,why)=>{if(fromP.key===toP.key)return;moves.push({id:`${m.id}>${toP.key}@${isoLocal(latest)}`,kind,m:m.id,name:m.name,rego:m.rego||'',cat:m.category||'',desc:m.sub||'',
      from:fromP,to:toP,earliest,latest,why})};
    const atYard=s=>s.place.key==='yard';
    S.forEach((s,i)=>{const p=S[i-1];
      if(!p){   /* the first known place: brought from the yard if it starts later in the window */
        if(!atYard(s)&&s.start>addMin(at(from,'00:00'),36*60))mk('fromYard',yard,s.place,addMin(s.start,-24*60),s.start,{from:'At the yard (no earlier booking)',to:startWhy(s.first)});
        return}
      const gap=s.start-p.end;const why={from:endWhy(p.last),to:startWhy(s.first)};
      if(gap<=0)return;   /* booked in two places at once: shown as a clash, not a move */
      if(gap<gapMs)return mk(atYard(p)?'fromYard':atYard(s)?'toYard':'direct',p.place,s.place,p.end,s.start,why);
      if(atYard(p))return mk('fromYard',yard,s.place,new Date(Math.max(p.end,addMin(s.start,-24*60))),s.start,why);
      if(atYard(s))return mk('toYard',p.place,yard,p.end,s.start,why);
      /* next job days away: back to the yard, then out again the day before */
      const back=new Date(Math.max(addMin(p.end,12*60),Math.min(addMin(p.end,36*60),addMin(s.start,-24*60))));
      mk('toYard',p.place,yard,p.end,back,{from:why.from,to:`Next job ${whenTxt(s.start)} (${Math.round(gap/864e5)} days later): to the yard till then`});
      mk('fromYard',yard,s.place,new Date(Math.max(addMin(s.start,-24*60),back)),s.start,{from:'From the yard',to:why.to});
    });
    const L=S[S.length-1];
    if(L&&!atYard(L)&&L.end<addMin(at(to,'00:00'),-(+cfg.gapDays||3)*24*60))mk('toYard',L.place,yard,L.end,addMin(L.end,36*60),{from:endWhy(L.last),to:'Nothing booked after this: back to the yard'});
  });
  return {moves:moves.sort((a,b)=>a.latest-b.latest),clashes,yard,machines};
}
const endWhy=a=>a.kind==='service'?`Service finishes ${whenTxt(a.end)}`:`${a.shift==='night'?'Night':'Day'} shift finishes ${whenTxt(a.end)}`;
const startWhy=a=>a.kind==='service'?`In for service ${whenTxt(a.start)}`:`${a.shift==='night'?'Night':'Day'} shift starts ${whenTxt(a.start)}`;

/* ---------- 3. loads: machines going the same way at the same time share the float (up to "machines per load") ---------- */
/* which machines may share the float: some always go alone (e.g. the big paver); otherwise the combinations you know
   fit ("a paver + a multi roller", "SR012 + SR013"), each part a machine or a whole category. With no combinations
   set, up to "machines per load". A smaller load that's part of a combination fits too. */
const mno=x=>String(x||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const isNo=(no,name,rego)=>{const n=mno(no);if(!n)return false;const first=mno(String(name||'').trim().split(/[\s·\-–(]/)[0]);return first===n||mno(name)===n||mno(rego)===n};
const itemFits=(it,mv,cfg)=>it.startsWith('m:')?it.slice(2)===mv.m:it.startsWith('n:')?isNo(it.slice(2),mv.name,mv.rego)
  :it.startsWith('c:')?it.slice(2).toLowerCase()===(mv.cat||'').trim().toLowerCase()
  :it.startsWith('g:')?((cfg.groups||[]).find(g=>g.name===it.slice(2))||{items:[]}).items.some(no=>isNo(no,mv.name,mv.rego)):false;
const goesAlone=(mv,cfg)=>(cfg.alone||[]).some(no=>isNo(no,mv.name,mv.rego)||no===mv.m);
function loadFits(list,cfg){
  if(list.length<2)return true;
  if(list.some(mv=>goesAlone(mv,cfg)))return false;
  const combos=(cfg.combos||[]).filter(c=>(c.items||[]).filter(Boolean).length>1);
  if(!combos.length)return list.length<=Math.max(1,+cfg.perLoad||1);
  /* each machine needs its own part of the combination */
  const match=(i,used,items)=>i===list.length||items.some((it,j)=>!used[j]&&itemFits(it,list[i],cfg)&&match(i+1,{...used,[j]:1},items));
  return combos.some(c=>{const items=c.items.filter(Boolean);return items.length>=list.length&&match(0,{},items)})}
function toTrips(moves,cfg){
  const trips=[];
  moves.forEach(mv=>{const t=trips.find(t=>t.from.key===mv.from.key&&t.to.key===mv.to.key&&mv.earliest<t.latest&&t.earliest<mv.latest&&loadFits([...t.moves,mv],cfg));
    if(t){t.moves.push(mv);t.earliest=new Date(Math.max(t.earliest,mv.earliest));t.latest=new Date(Math.min(t.latest,mv.latest));t.id=t.moves.map(x=>x.id).sort().join('+');return}
    trips.push({id:mv.id,moves:[mv],from:mv.from,to:mv.to,earliest:mv.earliest,latest:mv.latest,kind:mv.kind})});
  return trips}

/* ---------- 4. the float's day: one float, trip after trip ---------- */
/* travel(a,b) → {min, km, est} (est: not from road routing yet). Dispatch rule: of the trips the float can start now,
   the one needed soonest; otherwise the next one that can start. A pick-up time set by hand is kept. */
function planFloat(trips,cfg,travel,plan,opt={}){
  const P=plan||{};const L=+cfg.loadMin||0,U=+cfg.unloadMin||0;
  const left=trips.filter(t=>!(P[t.id]&&P[t.id].skip));const out=[];
  const skipped=trips.filter(t=>P[t.id]&&P[t.id].skip).map(t=>({...t,skip:true}));
  let loc={key:'yard',ll:opt.yardLL||null},clock=null;
  while(left.length){
    const cand=left.map(t=>{const dh=travel(loc,t.from);const fixed=P[t.id]&&fromIsoLocal(P[t.id].time);
      const ready=clock?addMin(clock,dh.min||0):t.earliest;const pick=fixed||new Date(Math.max(t.earliest,ready));return {t,dh,pick,fixed:!!fixed}});
    const now=clock||new Date(Math.min(...left.map(t=>t.earliest)));
    const avail=cand.filter(c=>c.fixed?c.pick<=addMin(now,60):c.t.earliest<=addMin(now,(c.dh.min||0)));
    const pickc=(avail.length?avail:cand).sort((a,b)=>avail.length?(a.t.latest-b.t.latest||a.pick-b.pick):(a.pick-b.pick||a.t.latest-b.t.latest))[0];
    const {t,dh,pick,fixed}=pickc;left.splice(left.indexOf(t),1);
    const tr=travel(t.from,t.to);const depart=addMin(pick,L*t.moves.length);const arrive=addMin(depart,tr.min||0);const done=addMin(arrive,U*t.moves.length);
    const leave=addMin(pick,-(dh.min||0));
    const late=done>t.latest,tight=!late&&done>addMin(t.latest,-30),early=pick<t.earliest;
    out.push({...t,pick,leave,depart,arrive,done,drive:tr,deadhead:dh,fixed,late,tight,early,fromLoc:loc,
      ticked:!!(P[t.id]&&P[t.id].done),tickedAt:P[t.id]&&P[t.id].doneAt,note:(P[t.id]&&P[t.id].note)||''});
    clock=done;loc=t.to}
  return {runs:out,skipped}}

/* ---------- road distance and time (OpenStreetMap: Nominatim for addresses, OSRM for roads) ---------- */
const LS='ff:floatRoutes';let ROUTES={};try{ROUTES=JSON.parse(localStorage.getItem(LS)||'{}')||{}}catch(e){}
const saveRoutes=()=>{try{localStorage.setItem(LS,JSON.stringify(ROUTES))}catch(e){}};
const llKey=ll=>`${(+ll.lat).toFixed(4)},${(+ll.lng).toFixed(4)}`;
const hav=(a,b)=>{const R=6371,r=x=>x*Math.PI/180;const dLa=r(b.lat-a.lat),dLo=r(b.lng-a.lng);const h=Math.sin(dLa/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(dLo/2)**2;return 2*R*Math.asin(Math.sqrt(h))};
function makeTravel(cfg,need){
  return (a,b)=>{
    if(!a||!b||a.key===b.key)return {min:0,km:0};
    if(!a.ll||!b.ll)return {min:45,km:null,est:true,unknown:true};
    const k=llKey(a.ll)+'>'+llKey(b.ll);const r=ROUTES[k];
    if(r&&!r.fail)return {min:Math.round(r.min*(+cfg.slow||1)),km:r.km};
    if(!r&&need)need(k,a.ll,b.ll);
    const km=hav(a.ll,b.ll)*1.3;return {min:Math.round(km/55*60*(+cfg.slow||1)),km,est:true}};
}
let qBusy=false;const Q=[];const waiting=new Set();
function queue(job){Q.push(job);if(!qBusy)pump()}
async function pump(){qBusy=true;while(Q.length){const j=Q.shift();try{await j()}catch(e){}await new Promise(r=>setTimeout(r,1100))}qBusy=false}
function needRoute(k,a,b,onDone){if(waiting.has(k))return;waiting.add(k);
  queue(async()=>{try{const r=await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`);const j=await r.json();
    const rt=j&&j.routes&&j.routes[0];ROUTES[k]=rt?{km:rt.distance/1000,min:rt.duration/60}:{fail:true}}catch(e){/* offline: try again next time */waiting.delete(k);return}
    saveRoutes();onDone&&onDone()})}
async function geocode(addr){
  const q=/\b(qld|queensland|nsw|vic|australia)\b/i.test(addr)?addr:addr+', QLD';
  const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`,{headers:{'Accept':'application/json'}});
  const j=await r.json();if(j&&j[0])return {lat:+j[0].lat,lng:+j[0].lon};
  /* try without the street number / lot details: "Lot 3, 12-20 Smith St, Town" → "Smith St, Town" */
  const q2=q.replace(/^(lot\s*\d+[^,]*,\s*)?[\d\-\/a-z]*\d[\d\-\/a-z]*\s+/i,'');if(q2!==q){const r2=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q2)}`);const j2=await r2.json();if(j2&&j2[0])return {lat:+j2[0].lat,lng:+j2[0].lon,rough:true}}
  return null}
const LSG='ff:floatGeo';const localGeo=()=>{try{return JSON.parse(localStorage.getItem(LSG)||'{}')||{}}catch(e){return {}}};
const mapsDir=(a,b)=>a&&b&&a.ll&&b.ll?`https://www.google.com/maps/dir/?api=1&origin=${a.ll.lat},${a.ll.lng}&destination=${b.ll.lat},${b.ll.lng}&travelmode=driving`:
  b?`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.ll?b.ll.lat+','+b.ll.lng:b.addr||b.job)}`:'';

/* ---------- everything for a date range, ready to show ---------- */
function useFloatPlan(data,setData,canEdit){
  const cfg=cfgOf(data);
  const [tick,setTick]=useState(0);const bump=()=>setTick(x=>x+1);
  const [lg,setLg]=useState(localGeo);
  const geo={...lg,...((data.floatGeo)||{})};
  const today=iso(new Date());const from=iso(addDays(parse(today),-14)),to=iso(addDays(parse(today),28));
  const res=useMemo(()=>{
    const {moves,clashes,yard,machines}=buildMoves(data,{cfg,geo,from,to});
    const trips=toTrips(moves,cfg);
    const travel=makeTravel(cfg,(k,a,b)=>needRoute(k,a,b,bump));
    const cut=addMin(at(today,'00:00'),-24*60);
    const {runs,skipped}=planFloat(trips.filter(t=>t.latest>=cut),cfg,travel,data.floatPlan||{},{yardLL:yard.ll});
    /* places that still need finding on the map */
    const places=new Map();[...moves.flatMap(m=>[m.from,m.to]),yard].forEach(p=>{if(p&&!p.ll&&p.addr)places.set(normAddr(p.addr),p)});
    return {moves,clashes,yard,machines,trips,runs,skipped,missing:[...places.values()],travel}},
    [data.blocks,data.resources,data.jobs,data.plans,data.floatCfg,data.floatPlan,data.floatGeo,lg,tick]);
  /* find addresses on the map, one a second (Nominatim's rule) */
  useEffect(()=>{res.missing.forEach(p=>{const k=normAddr(p.addr);if(waiting.has('g:'+k)||geo[k])return;waiting.add('g:'+k);
    queue(async()=>{let g=null;try{g=await geocode(p.addr)}catch(e){waiting.delete('g:'+k);return}
      const v=g?{lat:g.lat,lng:g.lng,...(g.rough?{rough:true}:{})}:{fail:true};
      if(canEdit)setData(d=>({...d,floatGeo:{...(d.floatGeo||{}),[k]:v}}));
      else{const L=localGeo();L[k]=v;try{localStorage.setItem(LSG,JSON.stringify(L))}catch(e){}setLg(L)}})})},[res.missing.map(p=>p.addr).join('|')]);
  const setGeo=(addr,v)=>{const k=normAddr(addr);if(canEdit)setData(d=>({...d,floatGeo:{...(d.floatGeo||{}),[k]:v}}));else{const L={...localGeo(),[k]:v};try{localStorage.setItem(LSG,JSON.stringify(L))}catch(e){}setLg(L)}};
  return {...res,cfg,geo,setGeo}}

/* ---------- the screen ---------- */
const STAT={done:['Done','hsl(145 55% 30%)','hsl(145 50% 92%)'],now:['On the go','hsl(212 75% 34%)','hsl(212 80% 92%)'],next:['Next','hsl(212 75% 34%)','hsl(212 80% 95%)'],
  late:['Late','hsl(0 72% 40%)','hsl(0 80% 95%)'],tight:['Tight','hsl(30 85% 34%)','hsl(38 95% 90%)'],overdue:['Not ticked off','hsl(30 85% 34%)','hsl(38 95% 90%)'],plan:['Planned','var(--muted)','var(--sunken)']};
const statusOf=(r,now,nextId)=>r.ticked?'done':r.late?'late':(r.leave<=now&&now<r.done)?'now':r.done<now?'overdue':r.id===nextId?'next':r.tight?'tight':'plan';

function FloatsScreen({data,setData,notify}){
  const canEdit=ffCan('floats',2);
  const F=useFloatPlan(data,setData,canEdit);const cfg=F.cfg;
  const [day,setDay]=useState(()=>iso(new Date()));
  const [now,setNow]=useState(()=>new Date());useEffect(()=>{const t=setInterval(()=>setNow(new Date()),30000);return()=>clearInterval(t)},[]);
  const [tab,setTab]=useState('day');const [edit,setEdit]=useState(null);const [msg,setMsg]=useState('');
  const today=iso(now);
  const setPlan=(id,p)=>setData(d=>{const P={...(d.floatPlan||{})};const v={...(P[id]||{}),...p};Object.keys(v).forEach(k=>{if(v[k]==null||v[k]===''||v[k]===false)delete v[k]});if(Object.keys(v).length)P[id]=v;else delete P[id];
    /* tidy: ticks and times more than 3 weeks old */
    const cut=iso(addDays(new Date(),-21));Object.keys(P).forEach(k=>{const m=/@(\d{4}-\d{2}-\d{2})/.exec(k);if(m&&m[1]<cut)delete P[k]});return {...d,floatPlan:P}});
  const names=r=>r.moves.map(m=>m.name).join(' + ');
  const runsOn=k=>F.runs.filter(r=>dayOf(r.pick)===k);
  const dayRuns=runsOn(day);
  const nextId=(F.runs.find(r=>!r.ticked&&r.leave>now)||{}).id;
  const live=day===today?F.runs.find(r=>!r.ticked&&r.leave<=now&&now<r.done)||F.runs.find(r=>!r.ticked&&r.leave>now):null;
  const soon=[...Array(8)].map((_,i)=>iso(addDays(parse(today),i)));
  const horizonEnd=iso(addDays(parse(today),7));
  const probs=[
    ...F.clashes.filter(c=>c.k>=today&&c.k<=horizonEnd).map(c=>({k:c.k,kind:'clash',text:`${c.name} is booked in two places on ${WD[parse(c.k).getDay()]} ${fmtShort(parse(c.k))}: ${c.pa.job}${c.pa.crew?' ('+c.pa.crew+')':''} and ${c.pb.job}${c.pb.crew?' ('+c.pb.crew+')':''}`})),
    ...F.runs.filter(r=>r.late&&!r.ticked&&dayOf(r.pick)>=today&&dayOf(r.pick)<=horizonEnd).map(r=>({k:dayOf(r.pick),kind:'late',run:r,text:`${names(r)} can’t reach ${r.to.job} in time: needed by ${whenTxt(r.latest)}, the float gets there at ${whenTxt(r.done)}`})),
  ].sort((a,b)=>a.k.localeCompare(b.k));
  const yardMissing=!F.yard.ll;

  const exportPdf=async k=>{try{await runSheetPdf(data,cfg,runsOn(k),k);notify&&notify('Run sheet saved')}catch(e){notify&&notify(e&&e.code==='declined'?'Download cancelled.':(e&&e.message)||'The run sheet couldn’t be made.')}};
  const copyText=async k=>{const t=runSheetText(cfg,runsOn(k),k);try{await navigator.clipboard.writeText(t);notify&&notify('Copied: paste it into a text or email')}catch(e){setMsg(t)}};

  const Card=r=>{const st=statusOf(r,now,nextId);const [sl,sc,sb]=STAT[st];const ed=edit===r.id;
    return html`<li key=${r.id} class="panel p-3 sm:p-4 grid gap-2 fl-run" data-st=${st} style=${st==='now'?{boxShadow:'inset 3px 0 0 hsl(212 75% 45%)'}:st==='late'?{boxShadow:'inset 3px 0 0 hsl(0 72% 45%)'}:null}>
      <div class="flex items-start gap-3 flex-wrap">
        <div class="mono text-[20px] sm:text-[22px] font-semibold leading-none">${hm(r.pick)}<span class="text-faint text-[14px] font-normal"> → ${hm(r.done)}</span></div>
        <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full" style=${{color:sc,background:sb}}>${sl}</span>
        ${r.fixed&&!r.ticked&&html`<span class="text-[11px] text-muted">time set by hand</span>`}
        ${r.early&&!r.ticked&&html`<span class="text-[11px] font-semibold" style=${{color:'hsl(30 85% 34%)'}}>Before the machine is free (${hm(r.earliest)})</span>`}
        <div class="flex-1"></div>
        <a class="btn" style=${{height:30}} href=${mapsDir(r.from,r.to)} target="_blank" rel="noopener">${Icon.pin} Directions</a>
      </div>
      <div class="flex flex-wrap gap-2">${r.moves.map(m=>html`<span key=${m.id} class="grid leading-tight px-3 py-1.5 rounded-lg bg-sunken border border-line">
        <span class="text-[14px] font-semibold">${m.name}${m.rego?html` <span class="mono text-[12px] text-muted font-normal">${m.rego}</span>`:''}</span>
        ${(m.desc||m.cat)&&html`<span class="text-[12px] text-muted">${[m.desc,m.cat].filter(Boolean).join(' · ')}</span>`}</span>`)}</div>
      <div class="grid sm:grid-cols-2 gap-2 text-[13px]">
        <div class="grid gap-0.5"><span class="label">Pick up</span><span class="font-semibold">${r.from.job}${r.from.crew?html` <span class="text-muted font-normal">· ${r.from.crew}</span>`:''}</span>
          <span class="text-muted text-[12.5px]">${r.from.addr||'No address'}</span><span class="text-[12px]" style=${{color:'hsl(145 45% 30%)'}}>Free from ${whenTxt(r.earliest,dayOf(r.pick))} · ${r.moves[0].why.from}</span></div>
        <div class="grid gap-0.5"><span class="label">Drop off</span><span class="font-semibold">${r.to.job}${r.to.crew?html` <span class="text-muted font-normal">· ${r.to.crew}</span>`:''}</span>
          <span class="text-muted text-[12.5px]">${r.to.addr||'No address'}</span><span class="text-[12px]" style=${{color:r.late?'var(--bad)':'hsl(212 60% 36%)'}}>Needed by ${whenTxt(r.latest,dayOf(r.pick))} · ${r.moves[0].why.to}</span>
          ${r.late&&html`<span class="text-[12px] font-semibold" style=${{color:'var(--bad)'}}>Gets there ${durTxt((r.done-r.latest)/60000)} late</span>`}</div>
      </div>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <span>${r.drive.km!=null?`${Math.round(r.drive.km)} km · `:''}${durTxt(r.drive.min)} drive${r.drive.unknown?' (place not found yet)':r.drive.est?' (estimate)':''}</span>
        ${r.deadhead.min>0&&html`<span>Float leaves ${r.fromLoc.key==='yard'?'the yard':'the last drop'} ${hm(r.leave)} (${durTxt(r.deadhead.min)} empty)</span>`}
        <span>Load ${cfg.loadMin*r.moves.length} min · unload ${cfg.unloadMin*r.moves.length} min</span>
        ${r.ticked&&html`<span style=${{color:'hsl(145 55% 30%)'}}>Ticked off${r.tickedAt?' '+r.tickedAt:''}</span>`}
      </div>
      ${r.note&&html`<div class="text-[12.5px] rounded-md px-2 py-1 bg-sunken">${r.note}</div>`}
      ${canEdit&&html`<div class="flex flex-wrap items-center gap-2">
        <button type="button" class=${'btn '+(r.ticked?'':'btn-primary')} style=${{height:32}} onClick=${()=>setPlan(r.id,r.ticked?{done:null,doneAt:null}:{done:true,doneAt:hm(new Date()),...(r.fixed?{}:{time:isoLocal(r.pick)})})}>${r.ticked?'Undo done':'Mark done'}</button>
        <button type="button" class="btn" style=${{height:32}} onClick=${()=>setEdit(ed?null:r.id)} aria-expanded=${String(ed)}>${Icon.pencil} Change</button>
      </div>`}
      ${ed&&html`<div class="grid gap-2 rounded-lg border border-line p-3 bg-sunken fl-edit">
        <label class="grid gap-1 text-[12.5px]"><span class="label">Pick-up time</span>
          <span class="flex gap-2 items-center flex-wrap"><input type="date" class="field field-sm" style=${{height:32,maxWidth:160}} value=${dayOf(r.pick)} onChange=${e=>e.target.value&&setPlan(r.id,{time:e.target.value+'T'+hm(r.pick)})}/>
          <input type="time" class="field field-sm mono" style=${{height:32,maxWidth:120}} value=${hm(r.pick)} step="300" onChange=${e=>e.target.value&&setPlan(r.id,{time:dayOf(r.pick)+'T'+e.target.value})}/>
          ${r.fixed&&html`<button type="button" class="text-[12px] underline text-muted" onClick=${()=>setPlan(r.id,{time:null})}>Work it out again</button>`}</span></label>
        <label class="grid gap-1 text-[12.5px]"><span class="label">Note for the driver</span>
          <input class="field field-sm" style=${{height:32}} value=${r.note} placeholder="e.g. Key in the roller, gate code 1234" onChange=${e=>setPlan(r.id,{note:e.target.value.trim()})}/></label>
        <label class="inline-flex items-center gap-2 text-[12.5px]"><input type="checkbox" class="w-4 h-4" checked=${false} onChange=${()=>{setPlan(r.id,{skip:true});setEdit(null)}}/> Not needed: leave the machine where it is</label>
      </div>`}
    </li>`};

  return html`<div class="flex-1 min-h-0 overflow-y-auto grid gap-3 content-start pb-6" id="floats">
    <div class="flex flex-wrap items-center gap-2">
      <div class="seg" role="tablist" aria-label="Floats view">
        <button role="tab" aria-pressed=${tab==='day'} onClick=${()=>setTab('day')}>Float’s day</button>
        <button role="tab" aria-pressed=${tab==='week'} onClick=${()=>setTab('week')}>Next 7 days</button>
        ${canEdit&&html`<button role="tab" id="fl-tab-set" aria-pressed=${tab==='set'} onClick=${()=>setTab('set')}>Settings</button>`}
      </div>
      ${tab==='day'&&html`<div class="flex items-center gap-1">
        <button class="btn px-2" aria-label="Previous day" onClick=${()=>setDay(iso(addDays(parse(day),-1)))}>${Icon.chevL}</button>
        <button class="btn" disabled=${day===today} onClick=${()=>setDay(today)}>Today</button>
        <button class="btn" id="fl-tomorrow" disabled=${day===iso(addDays(parse(today),1))} onClick=${()=>setDay(iso(addDays(parse(today),1)))}>Tomorrow</button>
        <button class="btn px-2" aria-label="Next day" onClick=${()=>setDay(iso(addDays(parse(day),1)))}>${Icon.chevR}</button>
      </div>`}
      <div class="flex-1"></div>
      ${tab==='day'&&html`<button id="fl-pdf" class="btn btn-primary" onClick=${()=>exportPdf(day)} disabled=${!dayRuns.length}>${Icon.download} Run sheet PDF</button>
        <button id="fl-copy" class="btn" onClick=${()=>copyText(day)} disabled=${!dayRuns.length}>Copy as text</button>`}
    </div>

    ${yardMissing&&html`<div class="panel p-3 text-[13px]" style=${{color:'hsl(30 85% 34%)'}}>The yard (${cfg.yardAddr||'no address'}) isn’t on the map yet${canEdit?html`: check the address in <button class="underline font-semibold" onClick=${()=>setTab('set')}>Settings</button>.`:'.'}</div>`}

    ${tab==='day'&&html`
      <div class="flex items-baseline gap-2 flex-wrap">
        <h2 class="font-display text-[18px] font-semibold" id="fl-day">${day===today?'Today':day===iso(addDays(parse(today),1))?'Tomorrow':''} ${WD[parse(day).getDay()]} ${fmtShort(parse(day))}</h2>
        <span class="text-[13px] text-muted">${dayRuns.length?`${dayRuns.length} trip${dayRuns.length===1?'':'s'} · ${dayRuns.reduce((a,r)=>a+r.moves.length,0)} machine${dayRuns.reduce((a,r)=>a+r.moves.length,0)===1?'':'s'}${dayRuns.some(r=>r.drive.km!=null)?` · ${Math.round(dayRuns.reduce((a,r)=>a+(r.drive.km||0)+(r.deadhead.km||0),0))} km`:''}`:''}</span>
      </div>
      ${live&&html`<div id="fl-live" class="panel p-3 flex items-center gap-3 flex-wrap" style=${{background:'hsl(212 80% 96%)',borderColor:'hsl(212 60% 80%)'}}>
        <span class="relative flex h-2.5 w-2.5"><span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style=${{background:'hsl(212 75% 50%)'}}></span><span class="relative inline-flex rounded-full h-2.5 w-2.5" style=${{background:'hsl(212 75% 45%)'}}></span></span>
        <span class="text-[13.5px]"><b>${live.leave<=now?'Now':'Next'}:</b> ${live.leave<=now?(now<live.pick?`driving to ${live.from.job}`:now<live.depart?`loading ${names(live)} at ${live.from.job}`:now<live.arrive?`taking ${names(live)} to ${live.to.job}`:`unloading at ${live.to.job}`):`leave ${hm(live.leave)} to pick up ${names(live)} at ${live.from.job} (${hm(live.pick)})`}</span>
        <span class="text-[12px] text-muted ml-auto">${hm(now)}</span></div>`}
      ${dayRuns.length===0?html`<div class="panel p-6 text-center text-[13px] text-muted">No float moves ${day===today?'today':'this day'}.</div>`
        :html`<ol class="grid gap-2">${dayRuns.map((r,i)=>[day===today&&(i===0?now<r.leave:dayRuns[i-1].done<=now&&now<r.leave)&&html`<li key=${'now'+i} class="flex items-center gap-2 text-[11.5px] font-semibold" style=${{color:'hsl(212 75% 40%)'}} aria-hidden="true"><span class="h-px flex-1" style=${{background:'hsl(212 75% 55%)'}}></span>NOW ${hm(now)}<span class="h-px flex-1" style=${{background:'hsl(212 75% 55%)'}}></span></li>`,Card(r)])}</ol>`}
      ${F.skipped.filter(t=>dayOf(t.latest)===day||dayOf(t.earliest)===day).map(t=>html`<div key=${t.id} class="text-[12.5px] text-muted flex items-center gap-2">Not moving: ${t.moves.map(m=>m.name).join(' + ')} (${t.from.job} → ${t.to.job})${canEdit&&html`<button class="underline" onClick=${()=>setPlan(t.id,{skip:null})}>Move it after all</button>`}</div>`)}
    `}

    ${tab==='week'&&html`<div class="grid gap-4" id="fl-week">${soon.map(k=>{const rs=runsOn(k);const late=rs.filter(r=>r.late).length;return html`<section key=${k} class="panel overflow-hidden fl-weekday">
        <button type="button" class="w-full flex items-center gap-4 px-5 py-3 bg-sunken border-b border-line text-left hover:brightness-[.98]" onClick=${()=>{setDay(k);setTab('day')}} title="Open this day">
          <span class="font-display text-[17px] font-semibold">${k===today?'Today':k===iso(addDays(parse(today),1))?'Tomorrow':WD[parse(k).getDay()]} <span class="text-muted font-normal">${WD[parse(k).getDay()]} ${fmtShort(parse(k))}</span></span>
          <span class="text-[13px] text-muted">${rs.length?`${rs.length} trip${rs.length===1?'':'s'} · ${rs.reduce((a,r)=>a+r.moves.length,0)} machine${rs.reduce((a,r)=>a+r.moves.length,0)===1?'':'s'}${rs.some(r=>r.drive.km!=null)?` · ${Math.round(rs.reduce((a,r)=>a+(r.drive.km||0)+(r.deadhead.km||0),0))} km`:''}`:'No moves'}</span>
          ${late>0&&html`<span class="text-[11.5px] font-semibold px-2 py-0.5 rounded-full" style=${{color:STAT.late[1],background:STAT.late[2]}}>${late} late</span>`}
          <span class="ml-auto text-[12.5px] text-muted inline-flex items-center gap-1">Open day ${Icon.chevR}</span></button>
        ${rs.length>0&&html`<ol class="divide-y divide-line">${rs.map(r=>{const st=statusOf(r,now,nextId);const [sl,sc,sb]=STAT[st];return html`<li key=${r.id} class="grid grid-cols-[120px_minmax(260px,1.1fr)_minmax(0,2fr)] gap-6 px-5 py-4 fl-weekrow">
          <div class="grid content-start gap-1"><span class="mono text-[20px] font-semibold leading-none">${hm(r.pick)}</span><span class="text-[12.5px] text-muted">to ${hm(r.done)}</span>
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full justify-self-start" style=${{color:sc,background:sb}}>${sl}</span></div>
          <div class="grid content-start gap-1.5">${r.moves.map(m=>html`<div key=${m.id} class="rounded-lg border border-line px-3 py-2 leading-tight">
              <div class="text-[14px] font-semibold">${m.name}${m.rego?html` <span class="mono text-[12px] text-muted font-normal">${m.rego}</span>`:''}</div>
              <div class="text-[12.5px] text-muted">${[m.desc,m.cat].filter(Boolean).join(' · ')||'—'}</div></div>`)}</div>
          <div class="grid sm:grid-cols-2 gap-4 text-[13px] content-start">
            <div class="grid gap-0.5"><span class="label">From</span><span class="font-semibold">${r.from.job}</span>${r.from.crew&&html`<span class="text-muted">${r.from.crew}</span>`}<span class="text-muted text-[12.5px]">${r.from.addr||''}</span>
              <span class="text-[12px]" style=${{color:'hsl(145 45% 30%)'}}>Free ${whenTxt(r.earliest,k)}</span></div>
            <div class="grid gap-0.5"><span class="label">To</span><span class="font-semibold">${r.to.job}</span>${r.to.crew&&html`<span class="text-muted">${r.to.crew}</span>`}<span class="text-muted text-[12.5px]">${r.to.addr||''}</span>
              <span class="text-[12px]" style=${{color:r.late?'var(--bad)':'hsl(212 60% 36%)'}}>Needed by ${whenTxt(r.latest,k)}${r.late?` · ${durTxt((r.done-r.latest)/60000)} late`:''}</span>
              <span class="text-[12px] text-muted">${r.drive.km!=null?`${Math.round(r.drive.km)} km · `:''}${durTxt(r.drive.min)} drive</span></div></div>
        </li>`})}</ol>`}
      </section>`})}</div>`}

    ${tab!=='set'&&(probs.length>0||F.missing.length>0)&&html`<section class="panel p-3 sm:p-4 grid gap-2" id="fl-probs">
      <h3 class="font-display text-[15px] font-semibold">Needs sorting</h3>
      <ul class="grid gap-1.5 text-[13px]">
        ${probs.map((p,i)=>html`<li key=${i} class="flex gap-2 items-start"><span class="text-[10.5px] font-semibold px-1.5 py-0.5 rounded shrink-0 mt-0.5" style=${{color:'#fff',background:p.kind==='clash'?'hsl(0 72% 45%)':'hsl(30 85% 45%)'}}>${p.kind==='clash'?'Clash':'Late'}</span><span>${p.text}</span></li>`)}
        ${F.missing.map(p=>html`<${FixPlace} key=${p.addr} p=${p} geo=${F.geo} setGeo=${F.setGeo} canEdit=${canEdit}/>`)}
      </ul></section>`}

    ${tab==='set'&&canEdit&&html`<${FloatSettings} data=${data} setData=${setData} cfg=${cfg}/>`}

    ${msg&&html`<div class="panel p-3 grid gap-2"><div class="text-[13px] font-semibold">Copy this for the driver</div><textarea class="field mono text-[12px]" rows="12" readOnly value=${msg}></textarea><button class="btn justify-self-start" onClick=${()=>setMsg('')}>Close</button></div>`}
    <p class="text-[11.5px] text-faint">Distances and drive times: OpenStreetMap (road routing), ×${cfg.slow} for the float. Places come from the plan’s float or site pin, otherwise the booking’s address.</p>
  </div>`;
}

/* an address the map couldn't find: set it by hand */
function FixPlace({p,geo,setGeo,canEdit}){
  const g=geo[normAddr(p.addr)];const [v,setV]=useState('');const [err,setErr]=useState('');
  const save=()=>{const ll=parseLatLng(v);if(ll){setGeo(p.addr,{lat:ll.lat,lng:ll.lng,manual:true});setV('');setErr('');return}
    if(v.trim()){setErr('');geocode(v.trim()).then(x=>{if(x)setGeo(p.addr,{lat:x.lat,lng:x.lng,manual:true});else setErr('Still not found. Paste a Google Maps link or “-27.2, 152.9”.')}).catch(()=>setErr('No connection.'))}};
  return html`<li class="grid gap-1 fl-fix">
    <div class="flex gap-2 items-start"><span class="text-[10.5px] font-semibold px-1.5 py-0.5 rounded shrink-0 mt-0.5" style=${{color:'#fff',background:'hsl(30 85% 45%)'}}>Map</span>
      <span>${g&&g.fail?'Couldn’t find':'Finding'} <b>${p.job}</b>${p.addr?` (${p.addr})`:''} on the map${g&&g.fail?': drive times are guesses until it’s found.':'…'}</span></div>
    ${g&&g.fail&&canEdit&&html`<div class="flex gap-2 pl-[46px] flex-wrap"><input class="field field-sm flex-1 min-w-[200px]" style=${{height:30}} placeholder="Google Maps link, “-27.2, 152.9” or a nearby address" value=${v} onInput=${e=>setV(e.target.value)}/>
      <button type="button" class="btn" style=${{height:30}} onClick=${save} disabled=${!v.trim()}>Set</button>${err&&html`<span class="text-[12px] w-full" style=${{color:'var(--bad)'}}>${err}</span>`}</div>`}
  </li>`}

function FloatSettings({data,setData,cfg}){
  /* p: the changes, or a function of the latest settings giving them */
  const set=p=>setData(d=>({...d,floatCfg:{...(d.floatCfg||{}),...(typeof p==='function'?p(cfgOf(d)):p)}}));
  const cats=machineCatsOf(data);const on=floatCats(data,cfg);
  const num=(k,label,unit,step=1)=>html`<label class="grid gap-1"><span class="label">${label}</span><span class="flex items-center gap-2"><input id=${'fl-'+k} type="number" min="0" step=${step} class="field field-sm mono" style=${{height:32,maxWidth:110}} value=${cfg[k]} onChange=${e=>set({[k]:+e.target.value})}/><span class="text-[12.5px] text-muted">${unit}</span></span></label>`;
  return html`<section class="panel p-4 sm:p-5 grid gap-5" id="fl-settings">
    <div class="grid sm:grid-cols-2 gap-3">
      <label class="grid gap-1"><span class="label">Float</span><input class="field field-sm" style=${{height:32}} value=${cfg.floatName} onChange=${e=>set({floatName:e.target.value})} placeholder="e.g. Float · 123ABC"/></label>
      <label class="grid gap-1"><span class="label">Driver</span><input class="field field-sm" style=${{height:32}} value=${cfg.driver} onChange=${e=>set({driver:e.target.value})} placeholder="Name and phone"/></label>
      <label class="grid gap-1"><span class="label">Yard name</span><input class="field field-sm" style=${{height:32}} value=${cfg.yardName} onChange=${e=>set({yardName:e.target.value})}/></label>
      <label class="grid gap-1"><span class="label">Yard address</span><input id="fl-yard" class="field field-sm" style=${{height:32}} value=${cfg.yardAddr} onChange=${e=>set({yardAddr:e.target.value})}/></label>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      ${num('gapDays','Back to the yard when the next job is more than','days',.5)}
      ${num('shiftHrs','A shift lasts','hours',.5)}
      ${num('loadMin','Loading a machine','min',5)}
      ${num('unloadMin','Unloading','min',5)}
      ${num('slow','Float drive time × car time','×',.05)}
      <label class="grid gap-1"><span class="label">Day shift starts (if the booking has no time)</span><input type="time" class="field field-sm mono" style=${{height:32,maxWidth:130}} value=${cfg.dayStart} onChange=${e=>set({dayStart:e.target.value})}/></label>
      <label class="grid gap-1"><span class="label">Night shift starts (if the booking has no time)</span><input type="time" class="field field-sm mono" style=${{height:32,maxWidth:130}} value=${cfg.nightStart} onChange=${e=>set({nightStart:e.target.value})}/></label>
    </div>
    <${FloatLoads} data=${data} cfg=${cfg} set=${set}/>
  </section>`}

let DRAG=null;   /* the machine being dragged (kept outside React so every drop target sees it straight away) */
/* which machines can share the float: machines that go alone, named groups ("Small rollers"), and the loads that fit */
function FloatLoads({data,cfg,set:set0}){
  /* once the groups are saved, "Big rollers" isn't added again (even if renamed or emptied) */
  const seen=(p,c)=>p.groups?{...p,groupsSeen:[...new Set([...((c||cfg).groupsSeen||[]),'Big rollers'])]}:p;
  const set=p=>set0(typeof p==='function'?c=>seen(p(c),c):seen(p));
  const ms=data.resources.filter(r=>r.type==='machine'&&needsFloat(r,data,cfg)).sort((a,b)=>(a.category||'').localeCompare(b.category||'')||a.name.localeCompare(b.name,undefined,{numeric:true}));
  const noOf=m=>String(m.name||'').trim().split(/[\s·\-–(]/)[0]||m.name;
  const cats=[...new Set(ms.map(m=>(m.category||'').trim()).filter(Boolean))];
  const alone=cfg.alone||[],groups=cfg.groups||[],combos=cfg.combos||[];
  const found=no=>ms.some(m=>isNo(no,m.name,m.rego));
  /* a machine tag: its number, and what it is (description, category, rego) */
  /* drag a machine between groups (or out of them) */
  const [drag,setDrag]=useState(null);
  const unmark=()=>document.querySelectorAll('.fl-over').forEach(x=>x.classList.remove('fl-over'));
  const listOf=src=>src==='alone'?alone:src&&src.startsWith('g:')?(groups[+src.slice(2)]||{}).items||[]:[];
  const moveTo=(dst)=>{const d=DRAG||drag;DRAG=null;unmark();setDrag(null);if(!d||d.from===dst)return;
    set(c=>{let A=c.alone||[],G=(c.groups||[]).map(g=>({...g,items:[...(g.items||[])]}));
    if(d.from==='alone')A=A.filter(x=>x!==d.no);else if(d.from&&d.from.startsWith('g:'))G[+d.from.slice(2)].items=G[+d.from.slice(2)].items.filter(x=>x!==d.no);
    if(dst==='alone'){if(!A.includes(d.no))A=[...A,d.no]}else if(dst.startsWith('g:')){const g=G[+dst.slice(2)];if(!g.items.some(x=>isNo(x,d.no,'')||isNo(d.no,x,'')))g.items.push(d.no)}
    return {alone:A,groups:G}})};
  /* the highlight is set on the element itself, so nothing re-draws mid-drag */
  const drop=dst=>({onDragOver:e=>{if(!DRAG)return;e.preventDefault();e.dataTransfer.dropEffect='move';if(DRAG.from!==dst&&!e.currentTarget.classList.contains('fl-over')){unmark();e.currentTarget.classList.add('fl-over')}},
    onDragLeave:e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove('fl-over')},onDrop:e=>{e.preventDefault();moveTo(dst)}});
  const dropStyle=()=>null;
  const Chip=(no,onX,src)=>{const m=ms.find(x=>isNo(no,x.name,x.rego))||data.resources.find(x=>x.type==='machine'&&isNo(no,x.name,x.rego));
    const desc=m?[m.sub,m.category,m.rego&&!isNo(no,'',m.rego)?m.rego:''].filter(Boolean).join(' · '):'No machine with this number yet';
    return html`<span key=${no} class="fl-chip inline-flex items-center gap-2 pl-1.5 pr-1.5 py-1.5 rounded-lg border min-w-[180px] max-w-[320px] select-none" data-no=${no}
      draggable="true" onDragStart=${e=>{e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',no)}catch(x){}DRAG={no,from:src};e.currentTarget.style.opacity='.45'}} onDragEnd=${e=>{e.currentTarget.style.opacity='';setTimeout(()=>{DRAG=null;unmark()},0)}}
      style=${{cursor:'grab',...(m?{background:'var(--surface)',borderColor:'var(--line-strong)'}:{borderColor:'hsl(38 80% 60%)',background:'hsl(45 100% 96%)'})}} title=${desc+' (drag to another group)'}>
      <span class="text-faint shrink-0" aria-hidden="true">${Icon.grip}</span>
      <span class="grid min-w-0 flex-1 leading-tight"><span class="text-[14px] font-semibold" style=${m?null:{color:'hsl(30 85% 34%)'}}>${m&&!isNo(no,'',m.rego)?m.name:no}${m&&isNo(no,'',m.rego)?html` <span class="mono text-[12px] text-muted font-normal">${no}</span>`:''}</span>
        <span class="text-[12px] truncate" style=${{color:m?'var(--muted)':'hsl(30 85% 34%)'}}>${desc}</span></span>
      ${onX&&html`<button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-sunken shrink-0" aria-label=${'Remove '+no} onClick=${onX}>${Icon.x}</button>`}</span>`};
  const AddNo=(have,onAdd,id,label)=>html`<select id=${id} class="field" style=${{height:44,maxWidth:280}} value="" onChange=${e=>{const v=e.target.value;if(v)onAdd(v)}} aria-label=${label}>
      <option value="">+ Add a machine…</option>${ms.filter(m=>!have.some(no=>isNo(no,m.name,m.rego))).map(m=>html`<option key=${m.id} value=${noOf(m)}>${mLabel(m)}</option>`)}</select>`;
  const mLabel=m=>[m.name,m.sub,m.category].filter(Boolean).join(' · ');
  const lab=it=>it.startsWith('g:')?it.slice(2):it.startsWith('c:')?'Any '+it.slice(2):it.startsWith('n:')?it.slice(2):it.startsWith('m:')?((ms.find(m=>m.id===it.slice(2))||{}).name||'?'):'';
  const setCombo=(i,items)=>set({combos:combos.map((c,k)=>k===i?{...c,items}:c)});
  const opts=html`<option value="">Pick…</option>
    <optgroup label="Any one of a group">${groups.map(g=>html`<option key=${g.name} value=${'g:'+g.name}>${g.name}</option>`)}</optgroup>
    <optgroup label="Any machine in a category">${cats.map(c=>html`<option key=${c} value=${'c:'+c}>Any ${c}</option>`)}</optgroup>
    <optgroup label="A particular machine">${ms.map(m=>html`<option key=${m.id} value=${'n:'+noOf(m)}>${mLabel(m)}</option>`)}</optgroup>`;
  return html`<div class="grid gap-4 rounded-lg border border-line p-3" id="fl-loads">
    <div><div class="font-display text-[15px] font-semibold">Float loads</div><div class="text-[12.5px] text-muted">What can share the float. Machines going the same way at the same time go on one load when they fit.</div></div>
    <div class="grid gap-1.5"><span class="label">Always goes by itself</span>
      <div class="flex flex-wrap gap-2 items-center rounded-lg p-1 -m-1 min-h-[52px] fl-drop" data-drop="alone" ...${drop('alone')} style=${dropStyle('alone')}>${alone.map(no=>Chip(no,()=>set({alone:alone.filter(x=>x!==no)}),'alone'))}${AddNo(alone,v=>set({alone:[...alone,v]}),'fl-alone-add','Add a machine that goes by itself')}</div></div>
    <div class="grid gap-2"><span class="label">Groups</span>
      ${groups.map((g,i)=>html`<div key=${i} class="grid gap-2 fl-group fl-drop rounded-lg bg-sunken p-3" data-drop=${'g:'+i} ...${drop('g:'+i)} style=${dropStyle('g:'+i)}>
        <div class="flex items-center gap-2"><span class="font-display text-[16px] font-semibold px-1">${g.name}</span>
          </div>
        <div class="flex flex-wrap gap-2 items-center">${(g.items||[]).map(no=>Chip(no,()=>set({groups:groups.map((x,k)=>k===i?{...x,items:x.items.filter(y=>y!==no)}:x)}),'g:'+i))}
          ${!(g.items||[]).length&&html`<span class="text-[12.5px] text-muted px-1">Drag machines here</span>`}${AddNo(g.items||[],v=>set({groups:groups.map((x,k)=>k===i?{...x,items:[...(x.items||[]),v]}:x)}),'fl-group-add-'+i,'Add a machine to '+g.name)}</div></div>`)}
      <div class="grid gap-1.5 rounded-lg border border-dashed border-line p-3 fl-drop" data-drop="pool" ...${drop('pool')} style=${dropStyle('pool')}>
        <span class="label">Not in a group yet</span>
        <div class="flex flex-wrap gap-2">${ms.filter(m=>!groups.some(g=>(g.items||[]).some(no=>isNo(no,m.name,m.rego)))&&!alone.some(no=>isNo(no,m.name,m.rego))).map(m=>Chip(noOf(m),null,'pool'))}</div>
        <span class="text-[12px] text-muted">Drag a machine into a group, or back here to take it out.</span></div>
</div>
    <div class="grid gap-1.5"><span class="label">Loads that fit</span>
      ${combos.length===0&&html`<span class="text-[12.5px] text-muted">None: every machine goes on its own load.</span>`}
      ${combos.map((c,i)=>html`<div key=${i} class="flex flex-wrap items-center gap-1.5 fl-combo">
        ${(c.items||[]).map((it,j)=>html`${j>0&&html`<span class="text-muted">+</span>`}<span key=${j} class="inline-flex items-center fl-part"><select class="field" style=${{height:40,maxWidth:300,borderTopRightRadius:0,borderBottomRightRadius:0}} value=${it} onChange=${e=>setCombo(i,e.target.value?c.items.map((x,k)=>k===j?e.target.value:x):c.items.filter((_,k)=>k!==j))} aria-label=${'Part '+(j+1)+': '+lab(it)}>${opts}</select>
          <button type="button" class="btn fl-part-x" style=${{height:40,width:34,padding:0,justifyContent:'center',borderTopLeftRadius:0,borderBottomLeftRadius:0,marginLeft:-1}} title="Take this out of the load" aria-label=${'Take '+(lab(it)||'this')+' out of the load'} onClick=${()=>setCombo(i,c.items.filter((_,k)=>k!==j))}>${Icon.x}</button></span>`)}
        <button type="button" class="btn" style=${{height:40}} aria-label="Add another machine to this load" onClick=${()=>setCombo(i,[...(c.items||[]),''])}>${Icon.plus}</button>
        <button type="button" class="btn btn-ghost" style=${{height:40,color:'var(--bad)'}} aria-label="Remove this load" onClick=${()=>set({combos:combos.filter((_,k)=>k!==i)})}>${Icon.trash}</button></div>`)}
      <button type="button" id="fl-combo-add" class="btn justify-self-start" style=${{height:28}} onClick=${()=>set({combos:[...combos,{items:['','']}]})}>${Icon.plus} Add a load</button>
      <span class="text-[12px] text-muted">Part of a load fits too: “paver + 2 small rollers” also allows a paver with one small roller. Numbers in amber don’t match a machine yet.</span></div>
  </div>`}

/* ---------- the run sheet ---------- */
function runSheetText(cfg,runs,k){
  const d=parse(k);const L=[`${cfg.floatName||'Float'} run sheet – ${WD[d.getDay()]} ${fmtShort(d)} ${d.getFullYear()}`];if(cfg.driver)L.push(`Driver: ${cfg.driver}`);L.push('');
  runs.forEach((r,i)=>{L.push(`${i+1}. ${hm(r.pick)} pick up ${r.moves.map(m=>m.name+(m.rego?' ('+m.rego+')':'')).join(' + ')}`);
    L.push(`   From: ${r.from.job}${r.from.crew?' – '+r.from.crew:''}${r.from.addr?', '+r.from.addr:''}`);
    L.push(`   To:   ${r.to.job}${r.to.crew?' – '+r.to.crew:''}${r.to.addr?', '+r.to.addr:''}`);
    L.push(`   Free from ${whenTxt(r.earliest,k)} · needed by ${whenTxt(r.latest,k)} · ${r.drive.km!=null?Math.round(r.drive.km)+' km, ':''}${durTxt(r.drive.min)} drive`);
    if(r.deadhead.min>0)L.push(`   Leave ${hm(r.leave)} (${durTxt(r.deadhead.min)} empty from ${r.fromLoc.key==='yard'?cfg.yardName||'the yard':'the last drop'})`);
    if(r.note)L.push(`   Note: ${r.note}`);
    const u=mapsDir(r.from,r.to);if(u)L.push(`   Map: ${u}`);L.push('')});
  if(!runs.length)L.push('No moves.');return L.join('\n')}
async function runSheetPdf(data,cfg,runs,k){
  const JsPDF=await loadJsPDF();const doc=new JsPDF({unit:'mm',format:'a4'});const W=210,M=12;let y=M;const d=parse(k);
  const clean=s=>String(s==null?'':s).replace(/[–—]/g,'-').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[^\n\x20-\x7E\u00A0-\u00FF]/g,'');
  const font=(s,b)=>{doc.setFont('helvetica',b?'bold':'normal');doc.setFontSize(s)};
  const room=h=>{if(y+h>285){doc.addPage();y=M}};
  doc.setFillColor(155,10,30);doc.rect(0,0,W,4,'F');y+=4;
  font(16,true);doc.setTextColor(0);doc.text(clean(`${cfg.floatName||'Float'} run sheet`),M,y+4);font(11,false);doc.text(clean(`${WD[d.getDay()]} ${fmtShort(d)} ${d.getFullYear()}`),W-M,y+4,{align:'right'});y+=9;
  font(9.5,false);doc.setTextColor(90);doc.text(clean(`${cfg.driver?'Driver: '+cfg.driver+'   ':''}${runs.length} trip${runs.length===1?'':'s'}, ${runs.reduce((a,r)=>a+r.moves.length,0)} machines. Start from ${cfg.yardName}.`),M,y);y+=6;doc.setTextColor(0);
  if(!runs.length){font(11,false);doc.text('No moves.',M,y+4)}
  runs.forEach((r,i)=>{
    const from=doc.splitTextToSize(clean(`${r.from.job}${r.from.crew?' - '+r.from.crew:''}\n${r.from.addr||''}`),88),to=doc.splitTextToSize(clean(`${r.to.job}${r.to.crew?' - '+r.to.crew:''}\n${r.to.addr||''}`),88);
    const h=16+Math.max(from.length,to.length)*4.2+(r.note?5:0);room(h);
    doc.setDrawColor(200);doc.setLineWidth(.3);doc.roundedRect(M,y,W-2*M,h,1.5,1.5);
    font(13,true);doc.text(`${i+1}.  ${hm(r.pick)}`,M+3,y+6);font(10.5,true);doc.text(clean(r.moves.map(m=>m.name+(m.rego?' ('+m.rego+')':'')).join(' + ')),M+30,y+6);
    font(8.5,false);doc.setTextColor(90);doc.text(clean(`Leave ${hm(r.leave)} · load ${hm(r.pick)}-${hm(r.depart)} · arrive ${hm(r.arrive)} · ${r.drive.km!=null?Math.round(r.drive.km)+' km, ':''}${durTxt(r.drive.min)}`),W-M-3,y+6,{align:'right'});doc.setTextColor(0);
    font(8,true);doc.text('PICK UP',M+3,y+11.5);doc.text('DROP OFF',M+98,y+11.5);font(9.5,false);doc.text(from,M+3,y+15.5);doc.text(to,M+98,y+15.5);
    const yy=y+15.5+Math.max(from.length,to.length)*4.2;font(8.5,false);doc.setTextColor(40,110,60);doc.text(clean(`Free from ${whenTxt(r.earliest,k)}`),M+3,yy);doc.setTextColor(30,70,140);doc.text(clean(`Needed by ${whenTxt(r.latest,k)}`),M+98,yy);
    if(r.late){font(8.5,true);doc.setTextColor(180,20,30);doc.text(clean(`LATE: gets there ${durTxt((r.done-r.latest)/60000)} after`),M+135,yy);font(8.5,false)}doc.setTextColor(0);
    const u=mapsDir(r.from,r.to);if(u){doc.setTextColor(30,70,140);doc.textWithLink('Directions',W-M-20,yy,{url:u});doc.setTextColor(0)}
    if(r.note){font(9,true);doc.text(clean('Note: '+r.note),M+3,yy+5)}
    y+=h+3});
  font(7.5,false);doc.setTextColor(140);doc.text(clean(`Made ${fmtShort(new Date())} ${hm(new Date())} in FraserFlow. Drive times from OpenStreetMap, x${cfg.slow} for the float.`),M,292);
  const blob=doc.output('blob');const dl=window.claude&&window.claude.use?await window.claude.use('downloads'):null;
  const name=`${clean(cfg.floatName||'Float')} run sheet ${k}.pdf`;
  if(dl){await dl.save({filename:name,data:blob});return}
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},2000)}

window.FloatsScreen=FloatsScreen;
window.FFL={buildMoves,toTrips,loadFits,planFloat,makeTravel,cfgOf,runSheetText,normAddr,needsFloat};
})();
