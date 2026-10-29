const {useState,useMemo,useEffect,useRef}=React;
const html=htm.bind(React.createElement);

/* ---------- dates ---------- */
const pad=n=>String(n).padStart(2,'0');
const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d,12)};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x};
const diffDays=(a,b)=>Math.round((parse(iso(b))-parse(iso(a)))/864e5);
const mondayOf=d=>addDays(d,-((d.getDay()+6)%7));
const isWeekend=d=>d.getDay()===0||d.getDay()===6;
/* is this date a working shift for the booking? weekdays always; Saturday and Sunday only when ticked
   (older bookings only have the single weekendShifts switch, which covers both days) */
/* night works default to Friday and Saturday off, Sunday on (Sunday night to Thursday night) */
const satOn=b=>b.satShift!==undefined?!!b.satShift:b.shift==='night'?false:!!b.weekendShifts;
const sunOn=b=>b.sunShift!==undefined?!!b.sunShift:b.shift==='night'?true:!!b.weekendShifts;
/* night works also have a Friday switch (Friday night is part of the weekend); day works always work Fridays */
const friOn=b=>b.shift!=='night'||!!b.friShift;
const worksOn=(b,d)=>b.offDays&&b.offDays.includes(iso(d))?false:d.getDay()===6?satOn(b):d.getDay()===0?sunOn(b):d.getDay()===5?friOn(b):true;
const TODAY=(()=>{const t=new Date();t.setHours(12,0,0,0);return t})();
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const fmtShort=d=>`${d.getDate()} ${MON[d.getMonth()]}`;
const fmtRange=(a,b)=>a.getFullYear()!==b.getFullYear()
  ?`${fmtShort(a)} ${a.getFullYear()} – ${fmtShort(b)} ${b.getFullYear()}`
  :`${fmtShort(a)} – ${fmtShort(b)} ${b.getFullYear()}`;
const covers=(b,k)=>b.start<=k&&b.end>=k;

/* ---------- resource types & booking kinds ---------- */
const TYPES={
  crew:{label:'Crews',one:'crew',def:'job'},
  machine:{label:'Machines',one:'machine',def:'service'},
  person:{label:'Staff',one:'staff member',def:'leave'},
  aplant:{label:'Asphalt plant',tab:'Plants',one:'asphalt plant',def:'plantmaint'},
};
const KINDS={
  job:{label:'Job',for:'crew'},
  standby:{label:'Standby / yard',for:'crew',hue:220,outline:true},
  crewtraining:{label:'Training',for:'crew',hue:95,hint:'e.g. Toolbox day, first aid, plant tickets'},
  leave:{label:'Annual leave',for:'person',hue:28,hatch:true,away:true},
  sick:{label:'Sick leave',for:'person',hue:352,hatch:true,away:true},
  rdo:{label:'RDO',for:'person',hue:200,outline:true,away:true},
  training:{label:'Training / ticket',for:'person',hue:95},
  service:{label:'Scheduled service',for:'machine',hue:252,hatch:true,down:true},
  repair:{label:'Breakdown / repair',for:'machine',hue:318,down:true},
  inspection:{label:'Inspection / rego',for:'machine',hue:170,outline:true},
  onjob:{label:'On job (crew colour)',for:'machine',derived:true},
  plantmaint:{label:'Plant maintenance',for:'aplant',hue:8,hatch:true,hint:'e.g. Burner service, drum repairs'},
  plantreduced:{label:'Reduced output',for:'aplant',hue:40,outline:true,hint:'e.g. One silo only, limited AC14'},
};
const kindsFor=t=>Object.keys(KINDS).filter(k=>KINDS[k].for===t&&!KINDS[k].derived);
const overlaps=(a,b)=>a.start<=b.end&&a.end>=b.start;
/* asphalt plant maintenance affects paving and small works crews */
const usesPlant=r=>r&&r.type==='crew'&&/pav|small/.test(workKey(r.sub));
/* plant maintenance can take out the day shift, the night shift or both (maintShift: 'day' | 'night' | 'both') */
const maintHits=(b,shift)=>{const m=b.maintShift||'both';return m==='both'||!shift||m===shift};
function plantMaintOn(data,blocks,k,shift){ /* names of asphalt plants under maintenance on a date (for a given shift) */
  return data.resources.filter(r=>r.type==='aplant'&&blocks.some(b=>b.resourceId===r.id&&b.kind==='plantmaint'&&covers(b,k)&&maintHits(b,shift))).map(r=>r.name);
}
/* plant assigned to a crew job shows on that machine's row, following the job's dates */
function plantBookings(blocks,machineId){
  return blocks.filter(b=>b.kind==='job'&&(b.plantIds||[]).includes(machineId)).map(b=>({
    id:'v-'+b.id+'-'+machineId,virtual:true,parent:b,kind:'onjob',resourceId:machineId,
    crewId:b.resourceId,jobId:b.jobId,start:b.start,end:b.end,shift:b.shift,address:b.address,
    weekendShifts:b.weekendShifts,satShift:b.satShift,sunShift:b.sunShift}));
}

/* a shift handed to another crew (shiftData[date].crewId) shows as a one-shift bar on that crew's row */
const coverOf=(b,k)=>{const c=b&&b.shiftData&&b.shiftData[k]&&b.shiftData[k].crewId;return c&&c!==b.resourceId?c:null};
function coverBookings(blocks,crewId){
  const out=[];
  blocks.forEach(b=>{if(b.kind!=='job'||!b.shiftData)return;
    Object.keys(b.shiftData).forEach(k=>{if(coverOf(b,k)!==crewId||k<b.start||k>b.end||!worksOn(b,parse(k)))return;
      out.push({id:'x-'+b.id+'-'+k,virtual:true,cover:true,parent:b,kind:'job',resourceId:crewId,crewId:b.resourceId,jobId:b.jobId,
        start:k,end:k,shift:b.shift,address:b.address,quoteNo:b.quoteNo,projectNo:b.projectNo,shiftData:{[k]:b.shiftData[k]},satShift:true,sunShift:true})})});
  return out;
}

/* Day jobs take their crew's colour; night works are always red. */
const CREW_HUES=[205,150,275,40,185,235,95,25,170,300,60,220];
function blockStyle(b,data){
  const k=KINDS[b.kind];
  if((b.kind==='job'||b.kind==='onjob')&&b.shift==='night')
    return {background:'hsl(0 72% var(--blk-l))',color:'hsl(0 55% var(--blk-fg-l))',boxShadow:'inset 3px 0 0 hsl(0 65% var(--blk-edge-l))'};
  const h=b.kind==='job'?(data.resources.find(r=>r.id===b.resourceId)?.hue??205)
    :b.kind==='onjob'?(data.resources.find(r=>r.id===b.crewId)?.hue??205):k.hue;
  if(k.outline) return {background:'var(--surface)',color:`hsl(${h} 45% var(--blk-fg-l))`,border:`1.5px dashed hsl(${h} 55% var(--blk-edge-l))`};
  if(k.hatch) return {
    backgroundImage:`repeating-linear-gradient(135deg,hsl(${h} 75% var(--blk-l)) 0 7px,hsl(${h} 60% var(--hatch-l)) 7px 14px)`,
    color:`hsl(${h} 60% var(--blk-fg-l))`,boxShadow:`inset 3px 0 0 hsl(${h} 70% var(--blk-edge-l))`};
  return {background:`hsl(${h} 68% var(--blk-l))`,color:`hsl(${h} 55% var(--blk-fg-l))`,boxShadow:`inset 3px 0 0 hsl(${h} 62% var(--blk-edge-l))`};
}
const jobLabel=j=>j?((j.customer||'').trim()?`${j.customer.trim()} · ${j.name}`:j.name):'Job';
const MAINT_LABEL={day:'Day shift',night:'Night shift'};
/* two short lines for bars too narrow for the full title (one-day jobs in the 14-day, 30-day and 2-month views):
   the customer on top and the start of the job name underneath; the full details are in the hover */
const shortLabel=b=>{const D=window.__rosterData;
  if(b.kind==='job'||b.kind==='onjob'){const j=D&&D.jobs.find(x=>x.id===b.jobId);
    if(!j)return [b.address||'Job',''];const c=(j.customer||'').trim();return c?[c,j.name]:[j.name,'']}
  return [b.title||KINDS[b.kind].label,'']};
const blockTitle=(b,jobs)=>b.kind==='plantmaint'&&MAINT_LABEL[b.maintShift]?`${b.title||KINDS[b.kind].label} · ${MAINT_LABEL[b.maintShift]}`:b.kind==='onjob'?(b.address||jobs.find(j=>j.id===b.jobId)?.name||'On job'):b.kind==='job'?jobLabel(jobs.find(j=>j.id===b.jobId)):(b.title||KINDS[b.kind].label);

const HUES=[12,205,150,280,40,330,185,100,240,60,0,120];
const uid=()=>Math.random().toString(36).slice(2,9);

/* ---------- storage (per-viewer convenience only) ---------- */
const KEY='crew-plant-roster-v2';

/* crews are grouped by type of work (Paving, Seal, Small works...) in first-seen order */
const workKey=s=>(s||'General').trim().toLowerCase();
function groupCrews(rows){
  const m=new Map();
  rows.forEach(r=>{const k=workKey(r.sub);if(!m.has(k))m.set(k,{key:k,label:(r.sub||'General').trim(),rows:[]});m.get(k).rows.push(r)});
  return [...m.values()];
}
const SEED_CUST={j1:'TMR',j2:'CMB',j3:'Sunstate',j4:'Logan City Council',j5:'SEE Civil',j6:'TMR',j7:'TMR',j8:'BMD'};
const SEED_ADDR={
  j1:'Bruce Hwy northbound, Caboolture QLD 4510',j2:'Gympie Rd & Hamilton Rd, Chermside QLD 4032',
  j3:'Creek Rd carpark, Carindale QLD 4152',j4:'Kingston Rd, Logan Central QLD 4114',
  j5:'Port Dr, Port of Brisbane QLD 4178',j6:'Ipswich Mwy, Darra QLD 4076',
  j7:'Brisbane Valley Hwy, Fernvale QLD 4306',j8:'Gympie Rd, Strathpine QLD 4500'};
/* board section order (Crews / Plant / Staff), always containing every type once */
const SECTIONS=[...Object.keys(TYPES),'tonnes'];
/* default order of the board's sections; people can drag them into their own order */
const DEFAULT_ORDER=['tonnes','aplant','crew','person','machine'];
const orderOf=d=>{const o=(d.sectionOrder||[]).filter(t=>SECTIONS.includes(t));
  if(!o.length)return [...DEFAULT_ORDER];
  DEFAULT_ORDER.forEach(t=>{if(!o.includes(t))o.push(t)});
  return o};
/* rows reorder only among their own scope: crews within their type of work, plant and staff within their section */
const scopeOf=r=>r.type==='crew'?'crew:'+workKey(r.sub):r.type;
function load(){try{const s=localStorage.getItem(KEY);if(s){const d=JSON.parse(s);if(d&&d.resources&&d.blocks&&d.jobs){
  d.jobs=d.jobs.map(j=>j.address!=null?j:{...j,address:SEED_ADDR[j.id]||''});
  if(d.orderV!==2){d.sectionOrder=[...DEFAULT_ORDER];d.orderV=2} /* one-time move to the new default order */
  if(!d.resources.some(r=>r.type==='aplant'))d.resources=[...d.resources,{id:'a'+uid(),type:'aplant',name:'Asphalt plant',sub:'Main plant',hue:8,visible:true}];
  d.blocks=d.blocks.map(b=>b.kind==='job'&&b.address==null?{...b,address:d.jobs.find(j=>j.id===b.jobId)?.address||'',plantIds:b.plantIds||[]}:b);
  return d}}}catch(e){}return null}
function save(d){try{localStorage.setItem(KEY,JSON.stringify(d))}catch(e){}}

/* ---------- small pieces ---------- */
function Badge({r,size=30}){
  const s={width:size,height:size,background:`hsl(${r.hue} 60% var(--blk-l))`,color:`hsl(${r.hue} 55% var(--blk-fg-l))`,boxShadow:`inset 0 0 0 1.5px hsl(${r.hue} 55% var(--blk-edge-l))`};
  if(r.type==='crew') return html`<span aria-hidden="true" class="inline-flex items-center justify-center rounded-lg shrink-0 font-display font-bold" style=${{...s,fontSize:size*.42}}>${(r.name.match(/\d+/)||[r.name[0]])[0]}</span>`;
  if(r.type==='aplant') return html`<span aria-hidden="true" class="inline-flex items-center justify-center rounded-md shrink-0" style=${{...s,borderRadius:5}}>${Icon.factory}</span>`;
  if(r.type==='machine') return html`<span aria-hidden="true" class="inline-flex items-center justify-center rounded-md shrink-0 mono font-semibold" style=${{...s,fontSize:size*.3,borderRadius:5}}>${r.name.replace(/[^A-Z0-9]/gi,'').slice(0,4)}</span>`;
  const ini=r.name.split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
  return html`<span aria-hidden="true" class="inline-flex items-center justify-center rounded-full shrink-0 font-semibold" style=${{...s,fontSize:size*.38}}>${ini}</span>`;
}
const svg=(d,w=16)=>html`<svg width=${w} height=${w} viewBox="0 0 16 16" fill="none" aria-hidden="true">${d}</svg>`;
const Icon={
  chevL:svg(html`<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`),
  chevR:svg(html`<path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`),
  chevD:svg(html`<path d="M3.5 6l4.5 4.5L12.5 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,14),
  plus:svg(html`<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,14),
  x:svg(html`<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,14),
  list:svg(html`<path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`),
  eye:svg(html`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/>`,15),
  pencil:svg(html`<path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.1.6.6-3.1 7.6-7.6z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,14),
  eyeOff:svg(html`<path d="M2 2l12 12M6.6 3.7A6.6 6.6 0 018 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 01-1.9 2.4M4.1 5A11 11 0 001.5 8S4 12.5 8 12.5c1 0 1.9-.3 2.7-.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,15),
  pin:svg(html`<path d="M8 1.8a4.4 4.4 0 00-4.4 4.4C3.6 9.5 8 14.2 8 14.2s4.4-4.7 4.4-8A4.4 4.4 0 008 1.8z" fill="currentColor"/><circle cx="8" cy="6.2" r="1.6" fill="var(--surface)"/>`,12),
  grip:svg(html`<circle cx="6" cy="4" r="1.2" fill="currentColor"/><circle cx="10" cy="4" r="1.2" fill="currentColor"/><circle cx="6" cy="8" r="1.2" fill="currentColor"/><circle cx="10" cy="8" r="1.2" fill="currentColor"/><circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="10" cy="12" r="1.2" fill="currentColor"/>`,14),
  up:svg(html`<path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,13),
  down:svg(html`<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,13),
  download:svg(html`<path d="M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 13h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,14),
  chart:svg(html`<path d="M2.5 13.5h11M4.5 11V8M7.5 11V5M10.5 11V7M13 11V3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,15),
  factory:svg(html`<path d="M2 14V7.5l3.5 2V7.5l3.5 2V4h2.2l.6-2h1.4l.6 2H14v10z" fill="currentColor"/>`,15),
  alert:svg(html`<path d="M8 1.8l6.6 11.7H1.4z" fill="currentColor"/><path d="M8 6v3.6M8 11.4v.1" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/>`,12),
  bell:svg(html`<path d="M8 2a3.8 3.8 0 00-3.8 3.8v2.4L3 10.6V11.5h10v-.9l-1.2-2.4V5.8A3.8 3.8 0 008 2zM6.5 13a1.5 1.5 0 003 0" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/>`,16),
  bellOff:svg(html`<path d="M8 2a3.8 3.8 0 00-3.8 3.8v2.4L3 10.6V11.5h10v-.9l-1.2-2.4V5.8A3.8 3.8 0 008 2zM6.5 13a1.5 1.5 0 003 0M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" fill="none"/>`,16),
  gear:svg(html`<circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,15),
  sun:svg(html`<circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,16),
  moonLg:svg(html`<path d="M13.2 10.4A5.8 5.8 0 015.6 2.8a5.8 5.8 0 107.6 7.6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/>`,16),
  logout:svg(html`<path d="M6 2.5H3.5v11H6M10.5 5l3 3-3 3M13.5 8H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,16),
  key:svg(html`<circle cx="5.5" cy="10.5" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M7.7 8.3L14 2M11.5 4.5l1.8 1.8M10 6l1.5 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,16),
  moon:svg(html`<path d="M12.5 10.2A5.5 5.5 0 015.8 3.5a5.5 5.5 0 106.7 6.7z" fill="currentColor"/>`,12),
  wrench:svg(html`<path d="M10.5 2a3.5 3.5 0 00-3.2 4.9L2.5 11.7a1.3 1.3 0 001.8 1.8l4.8-4.8A3.5 3.5 0 0014 5.5l-2 2-1.8-.3-.3-1.8 2-2c-.4-.3-.9-.4-1.4-.4z" fill="currentColor"/>`,11),
  person:svg(html`<circle cx="8" cy="5" r="2.6" fill="currentColor"/><path d="M3 14c.4-3 2.4-4.6 5-4.6s4.6 1.6 5 4.6z" fill="currentColor"/>`,11),
};

/* ---------- derived ---------- */
const membersOf=(data,crewId,type)=>data.resources.filter(r=>r.type===type&&r.crewId===crewId);
function rowStats(r,data,days){
  let workdays=0,jobDays=0,flagged=0;
  days.forEach(d=>{
    const k=iso(d);const here=data.blocks.filter(b=>b.resourceId===r.id&&covers(b,k));
    if(r.type==='crew'){if(isWeekend(d))return;workdays++;if(here.some(b=>b.kind==='job'))jobDays++}
    else if(r.type==='person'){if(here.some(b=>KINDS[b.kind].away))flagged++}
    else if(r.type==='aplant'){if(here.some(b=>b.kind==='plantmaint'))flagged++}
    else{if(here.some(b=>KINDS[b.kind].down))flagged++}
  });
  return {workdays,jobDays,flagged,util:workdays?jobDays/workdays:0};
}

/* ---------- mixes & binders manager (Resources panel → Mixes tab) ---------- */
/* One editable list: reorder, rename (also updates booking lines that use it), remove, add. */
function ListManager({title,hint,items,setItems,field,placeholder,data,setData,onRenamed,onRemoved,rapOf,binderOf,binderOptions}){
  const [name,setName]=useState('');
  const [editing,setEditingItem]=useState(null); /* {from,to} */
  const [confirm,setConfirm]=useState(null);
  const [msg,setMsg]=useState('');
  const usage=useMemo(()=>{const m=new Map();
    data.blocks.forEach(b=>Object.values(b.shiftData||{}).forEach(q=>linesOf(q).forEach(l=>{const t=(l[field]||'').trim();if(t)m.set(t,(m.get(t)||0)+1)})));
    return m},[data.blocks,field]);
  const exists=(t,except)=>items.some(m=>m!==except&&m.toLowerCase()===t.toLowerCase());
  const add=e=>{e.preventDefault();const t=name.trim();if(!t)return;
    if(exists(t)){setMsg(`${t} is already in the list.`);return}
    setItems([...items,t]);setName('');setMsg('')};
  const move=(i,dir)=>{const j=i+dir;if(j<0||j>=items.length)return;const l=[...items];[l[i],l[j]]=[l[j],l[i]];setItems(l)};
  const remove=t=>{setItems(items.filter(m=>m!==t),onRemoved?d=>onRemoved(d,t):undefined);setConfirm(null)};
  const rename=e=>{e.preventDefault();const {from}=editing;const to=editing.to.trim();
    if(!to){setMsg('Give it a name.');return}
    if(rapOf&&editing.hasRap){const v=parseFloat(editing.rap);if(!(v>0&&v<=100)){setMsg('Enter a RAP % between 0 and 100, or untick Contains RAP.');return}}
    if(exists(to,from)){setMsg(`${to} is already in the list.`);return}
    setItems(items.map(m=>m===from?to:m),d=>{const n={...d,blocks:d.blocks.map(b=>b.shiftData?{...b,shiftData:Object.fromEntries(Object.entries(b.shiftData).map(([k,q])=>
        [k,{...shiftBase(q),lines:linesOf(q).map(l=>(l[field]||'').trim()===from?{...l,[field]:to}:l)}]))}:b)};return onRenamed?onRenamed(n,from,to,editing):n});
    setEditingItem(null);setMsg('')};
  const iconBtn='w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-surface disabled:opacity-30 disabled:cursor-default';
  const idp=field+'-';
  return html`<section class="flex flex-col" aria-labelledby=${idp+'title'}>
    <div class="px-4 pt-3 pb-1">
      <div class="flex items-baseline gap-2"><h3 id=${idp+'title'} class="label" style=${{color:'var(--ink)'}}>${title}</h3><span class="mono text-[11px] text-faint">${items.length}</span><span class="flex-1 h-px bg-line self-center"></span></div>
      <div class="text-[12px] text-muted mt-1">${hint}</div>
    </div>
    <ul class="px-2 py-1">
      ${items.map((t,i)=>{const n=usage.get(t)||0;
        if(editing&&editing.from===t)return html`<li key=${t} class="rounded-lg px-2 py-2 bg-sunken" style=${{boxShadow:'inset 0 0 0 1.5px var(--accent)'}}>
          <form class="flex flex-col gap-1.5" onSubmit=${rename} onKeyDown=${e=>{if(e.key==='Escape'){e.stopPropagation();setEditingItem(null);setMsg('')}}}>
            <label class="sr-only" for=${idp+'rn-'+i}>New name for ${t}</label>
            <input id=${idp+'rn-'+i} class="field field-sm mono" style=${{height:30,fontSize:13}} value=${editing.to} autoFocus=${true} onInput=${e=>setEditingItem({...editing,to:e.target.value})}/>
            ${rapOf&&html`<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-h-[30px]">
              <label class="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer">
                <input id=${idp+'rap-on-'+i} type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${!!editing.hasRap}
                  onChange=${e=>{setEditingItem({...editing,hasRap:e.target.checked});setMsg('')}}/>
                Contains RAP</label>
              ${editing.hasRap&&html`<label class="inline-flex items-center gap-1.5">
                <span class="sr-only">RAP percent</span>
                <input id=${idp+'rap-'+i} type="number" inputmode="decimal" min="0" max="100" step="any" class="field field-sm mono w-[70px] text-right" style=${{height:30,fontSize:13}}
                  placeholder="e.g. 15" value=${editing.rap} onInput=${e=>{setEditingItem({...editing,rap:e.target.value});setMsg('')}}/>
                <span class="text-[12.5px] text-muted">%</span></label>`}
            </div>`}
            ${binderOf&&html`<label class="flex items-center gap-2 text-[12.5px]"><span class="text-muted">Default binder</span>
              <select id=${idp+'binder-'+i} class="field field-sm mono w-auto" style=${{height:30,fontSize:13}} value=${editing.binder||''} onChange=${e=>setEditingItem({...editing,binder:e.target.value})}>
                <option value="">None</option>
                ${binderOptions.map(b=>html`<option key=${b} value=${b}>${b}</option>`)}
                ${editing.binder&&!binderOptions.includes(editing.binder)&&html`<option value=${editing.binder}>${editing.binder}</option>`}
              </select></label>
              <span class="text-[11px] text-faint -mt-1">Filled in automatically when this mix is picked on a shift.</span>`}
            ${msg&&html`<span class="text-[12px]" style=${{color:'var(--bad)'}}>${msg}</span>`}
            <div class="flex gap-1.5 justify-end">
              <button type="button" class="btn btn-ghost" style=${{height:28}} onClick=${()=>{setEditingItem(null);setMsg('')}}>Cancel</button>
              <button type="submit" class="btn btn-primary" style=${{height:28}}>Save</button>
            </div>
          </form></li>`;
        return html`<li key=${t} class="group rounded-lg px-2 py-1 flex items-center gap-2 hover:bg-sunken">
          <div class="flex flex-col">
            <button class=${iconBtn+' !h-4'} onClick=${()=>move(i,-1)} disabled=${i===0} aria-label=${'Move '+t+' up'} title="Move up">${Icon.up}</button>
            <button class=${iconBtn+' !h-4'} onClick=${()=>move(i,1)} disabled=${i===items.length-1} aria-label=${'Move '+t+' down'} title="Move down">${Icon.down}</button>
          </div>
          <div class="min-w-0 flex-1">
            <div class="mono font-semibold text-[13.5px] truncate">${t}</div>
            ${rapOf&&rapOf(t)>0&&html`<div class="text-[11.5px] font-medium" style=${{color:'var(--ok)'}}>${fmtN(rapOf(t))}% RAP</div>`}
          </div>
          ${confirm===t
            ?html`<div class="flex flex-col items-end gap-1 max-w-[150px]">
                ${n>0&&html`<span class="text-[11px] text-muted text-right leading-tight">Bookings using it keep it.</span>`}
                <div class="flex gap-1">
                  <button class="text-[11px] font-semibold px-2 py-0.5 rounded" style=${{background:'hsl(352 70% var(--blk-l))',color:'hsl(352 60% var(--blk-fg-l))'}} onClick=${()=>remove(t)}>Remove</button>
                  <button class="text-[11px] text-muted px-1.5" onClick=${()=>setConfirm(null)}>Keep</button></div></div>`
            :html`<div class="flex items-center gap-0.5 lg:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button class=${iconBtn} onClick=${()=>{const rp=rapOf?rapOf(t):0;setEditingItem({from:t,to:t,hasRap:rp>0,rap:rp>0?String(rp):'',binder:binderOf?binderOf(t):''});setConfirm(null);setMsg('')}} aria-label=${'Edit '+t} title="Edit">${Icon.pencil}</button>
                <button class=${iconBtn} onClick=${()=>{setConfirm(t);setEditingItem(null)}} aria-label=${'Remove '+t} title="Remove from the list">${Icon.x}</button></div>`}
        </li>`;})}
      ${items.length===0&&html`<li class="px-3 py-4 text-center text-muted text-[13px]">Nothing in the list yet. Add one below.</li>`}
    </ul>
    <form class="px-4 pt-1 pb-3 flex flex-col gap-1.5" onSubmit=${add}>
      <div class="flex gap-2">
        <input id=${idp+'new'} class="field field-sm mono" style=${{height:32,fontSize:13}} placeholder=${placeholder} value=${name} onInput=${e=>{setName(e.target.value);setMsg('')}} aria-label=${'New '+title.toLowerCase().replace(/s$/,'')}/>
        <button class="btn btn-primary shrink-0" type="submit" disabled=${!name.trim()}>${Icon.plus} Add</button>
      </div>
      ${msg&&!editing&&html`<div class="text-[12px]" style=${{color:'var(--bad)'}}>${msg}</div>`}
    </form>
  </section>`;
}

function SealManager({data,setData}){
  const setter=key=>(list,extra)=>setData(d=>{const n={...d,[key]:list};return extra?extra(n):n});
  return html`<div class="flex-1 min-h-0 overflow-y-auto">
    <${ListManager} title="Seal types" field="type" placeholder="e.g. 10mm Seal" data=${data} setData=${setData}
      hint="Seal types offered on Seal crew bookings, in this order. Paving jobs can't pick these. Click the pencil to rename one or set its default binder."
      items=${sealTypesOf(data)} setItems=${setter('sealTypes')}
      binderOf=${t=>sealBinderOf(data)[t]||''} binderOptions=${sealBindersOf(data)}
      onRenamed=${(d,from,to,ed)=>{const mb={...sealBinderOf(d)};delete mb[from];if(ed&&ed.binder)mb[to]=ed.binder;return {...d,sealBinder:mb}}}
      onRemoved=${(d,t)=>{const mb={...sealBinderOf(d)};delete mb[t];return {...d,sealBinder:mb}}}/>
    <div class="border-t border-line mx-4"></div>
    <${ListManager} title="Seal binders" field="binder" placeholder="e.g. C170" data=${data} setData=${setData}
      hint="Binders offered on Seal crew bookings, in this order. Separate from the asphalt binders under Mixes."
      items=${sealBindersOf(data)} setItems=${setter('sealBinders')}
      onRenamed=${(d,from,to)=>({...d,sealBinder:Object.fromEntries(Object.entries(sealBinderOf(d)).map(([k,v])=>[k,v===from?to:v]))})}/>
  </div>`;
}
function MixesManager({data,setData}){
  /* setItems(list, extra) saves the list and optionally applies another change (e.g. renaming inside bookings) */
  const setter=key=>(list,extra)=>setData(d=>{const n={...d,[key]:list};return extra?extra(n):n});
  return html`<div class="flex-1 min-h-0 overflow-y-auto">
    <${ListManager} title="Mixes" field="type" placeholder="e.g. AC14 HM" data=${data} setData=${setData}
      hint="Asphalt types offered in a job's Asphalt & Job Quantities tab, in this order. Click the pencil to rename a mix or set its RAP % and default binder."
      items=${mixTypesOf(data)} setItems=${setter('mixTypes')}
      rapOf=${t=>num((data.mixRap||{})[t])}
      binderOf=${t=>mixBinderOf(data)[t]||''} binderOptions=${bindersOf(data)}
      onRenamed=${(d,from,to,ed)=>{const r={...(d.mixRap||{})};delete r[from];if(ed&&ed.hasRap)r[to]=Math.min(100,num(ed.rap));
        const mb={...mixBinderOf(d)};delete mb[from];if(ed&&ed.binder)mb[to]=ed.binder;return {...d,mixRap:r,mixBinder:mb}}}
      onRemoved=${(d,t)=>{const r={...(d.mixRap||{})};delete r[t];const mb={...mixBinderOf(d)};delete mb[t];return {...d,mixRap:r,mixBinder:mb}}}/>
    <div class="border-t border-line mx-4"></div>
    <${ListManager} title="Binders" field="binder" placeholder="e.g. A35P" data=${data} setData=${setData}
      hint="Binders offered for each mix line, in this order."
      items=${bindersOf(data)} setItems=${setter('binders')}
      onRenamed=${(d,from,to)=>({...d,mixBinder:Object.fromEntries(Object.entries(mixBinderOf(d)).map(([k,v])=>[k,v===from?to:v]))})}/>
  </div>`;
}

/* ---------- jobs manager (Resources panel → Jobs tab) ---------- */
const JOB_HUES=[205,152,268,330,185,48,100,20,240,300];
function JobsManager({data,setData,onImport,onMerge}){
  const [q,setQ]=useState('');
  const [f,setF]=useState({name:'',customer:'',address:''});
  const [edit,setEdit]=useState(null); /* {id,name,customer,address} */
  const [confirm,setConfirm]=useState(null);
  const [msg,setMsg]=useState('');
  const [view,setView]=useState('active');
  const uses=useMemo(()=>{const m=new Map();data.blocks.forEach(b=>{if(b.kind==='job'&&b.jobId)m.set(b.jobId,(m.get(b.jobId)||0)+1)});return m},[data.blocks]);
  /* what a job amounted to: bookings, dates, crews, tonnes, area and mixes */
  const statsOf=id=>{const bs=data.blocks.filter(b=>b.kind==='job'&&b.jobId===id);
    let t=0,a=0;const mixes=new Map();
    bs.forEach(b=>{const q=qtyTotals(b);t+=q.tonnes;a+=q.area;q.byType.forEach(g=>mixes.set(g.type,(mixes.get(g.type)||0)+g.tonnes))});
    const first=bs.reduce((m,b)=>!m||b.start<m?b.start:m,null),last=bs.reduce((m,b)=>!m||b.end>m?b.end:m,null);
    const crews=[...new Set(bs.map(b=>data.resources.find(r=>r.id===b.resourceId)?.name).filter(Boolean))];
    return {n:bs.length,t,a,first,last,crews,mixes:[...mixes].sort((x,y)=>y[1]-x[1])}};
  const setDone=(id,done)=>{setData(d=>({...d,jobs:d.jobs.map(j=>j.id===id?(done?{...j,completed:true,completedAt:iso(TODAY)}:(({completed,completedAt,...rest})=>rest)(j)):j)}));setConfirm(null);setEdit(null)};
  const nDone=data.jobs.filter(j=>j.completed).length,nActive=data.jobs.length-nDone;
  /* completing a job that still has work today or later asks first */
  const [pending,setPending]=useState(null); /* {job, bookings} */
  const tryDone=(j,done)=>{
    if(!done){setDone(j.id,false);return}
    const today=iso(TODAY);
    const live=data.blocks.filter(b=>b.kind==='job'&&b.jobId===j.id&&b.end>=today).sort((a,b)=>a.start.localeCompare(b.start));
    if(live.length)setPending({job:j,bookings:live});else setDone(j.id,true);
  };
  useEffect(()=>{if(!pending)return;const h=e=>{if(e.key==='Escape')setPending(null)};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[!!pending]);
  const customers=[...new Set(data.jobs.map(j=>(j.customer||'').trim()).filter(Boolean))].sort();
  const list=data.jobs.filter(j=>!!j.completed===(view==='completed')&&[j.name,j.customer,j.address].join(' ').toLowerCase().includes(q.toLowerCase()))
    .sort((x,y)=>view==='completed'?(y.completedAt||'').localeCompare(x.completedAt||''):0);
  const dup=(name,except)=>data.jobs.some(j=>j.id!==except&&j.name.trim().toLowerCase()===name.trim().toLowerCase());
  const add=e=>{e.preventDefault();const name=f.name.trim();if(!name)return;
    if(dup(name)){setMsg(`There is already a job called ${name}.`);return}
    setData(d=>({...d,jobs:[...d.jobs,{id:'j'+uid(),name,customer:f.customer.trim(),address:f.address.trim(),hue:JOB_HUES[d.jobs.length%JOB_HUES.length]}]}));
    setF({name:'',customer:'',address:''});setMsg('')};
  const save=e=>{e.preventDefault();const name=edit.name.trim();
    if(!name){setMsg('Give the job a name.');return}
    if(dup(name,edit.id)){setMsg(`There is already a job called ${name}.`);return}
    setData(d=>({...d,jobs:d.jobs.map(j=>j.id===edit.id?{...j,name,customer:edit.customer.trim(),address:edit.address.trim(),projectNo:(edit.projectNo||'').trim()}:j)}));
    setEdit(null);setMsg('')};
  const remove=id=>{setData(d=>({...d,jobs:d.jobs.filter(j=>j.id!==id)}));setConfirm(null)};
  const iconBtn='w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-surface';
  const fs={height:30,fontSize:13};
  return html`<div class="flex-1 min-h-0 flex flex-col">
    ${pending&&html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)setPending(null)}}>
      <div class="panel pop w-full max-w-[420px] p-5 flex flex-col gap-3" role="alertdialog" aria-modal="true" aria-labelledby="jw-title" aria-describedby="jw-desc">
        <div class="flex items-start gap-3">
          <span class="w-9 h-9 rounded-full inline-flex items-center justify-center shrink-0 font-bold" style=${{background:'hsl(40 85% var(--blk-l))',color:'hsl(35 70% var(--blk-fg-l))'}} aria-hidden="true">!</span>
          <div class="min-w-0">
            <div id="jw-title" class="font-display text-[17px] font-semibold">This job still has bookings</div>
            <div id="jw-desc" class="text-[13px] text-muted mt-0.5">${pending.job.customer?pending.job.customer+' · ':''}${pending.job.name} has ${pending.bookings.length} booking${pending.bookings.length===1?'':'s'} today or later. Completing it now won't remove ${pending.bookings.length===1?'it':'them'} from the planner.</div>
          </div>
        </div>
        <ul class="rounded-lg border border-line divide-y max-h-[200px] overflow-y-auto" style=${{borderColor:'var(--line)'}}>
          ${pending.bookings.map(b=>{const c=data.resources.find(r=>r.id===b.resourceId);
            return html`<li key=${b.id} class="px-3 py-2 flex items-center gap-2 text-[13px]" style=${{borderColor:'var(--line)'}}>
              <span class="font-medium">${c?.name||'Crew'}</span>
              <span class="text-muted mono text-[12px]">${fmtShort(parse(b.start))}${b.end!==b.start?' – '+fmtShort(parse(b.end)):''}</span>
              ${b.shift==='night'&&html`<span class="inline-flex text-[11px] items-center gap-1" style=${{color:'hsl(0 60% var(--blk-edge-l))'}}>${Icon.moon} Night</span>`}
              ${b.start<=iso(TODAY)&&b.end>=iso(TODAY)&&html`<span class="ml-auto text-[11px] font-semibold px-1.5 rounded" style=${{background:'var(--accent-soft)',color:'var(--accent)'}}>Today</span>`}
            </li>`;})}
        </ul>
        <div class="flex flex-wrap gap-2 justify-end pt-1">
          <button type="button" class="btn" onClick=${()=>setPending(null)} autoFocus=${true}>Keep active</button>
          <button type="button" class="btn btn-primary" onClick=${()=>{setDone(pending.job.id,true);setPending(null)}}>Complete anyway</button>
        </div>
      </div>
    </div>`}
    <datalist id="jobs-customers">${customers.map(c=>html`<option key=${c} value=${c}></option>`)}</datalist>
    <div class="px-4 pt-3 flex flex-col gap-2">
      <div class="seg w-full" role="group" aria-label="Show jobs">
        <button type="button" class="flex-1" aria-pressed=${view==='active'} onClick=${()=>{setView('active');setEdit(null);setConfirm(null)}}>Active <span class="mono text-[11px] text-faint">${nActive}</span></button>
        <button type="button" class="flex-1" aria-pressed=${view==='completed'} onClick=${()=>{setView('completed');setEdit(null);setConfirm(null)}}>Completed <span class="mono text-[11px] text-faint">${nDone}</span></button>
      </div>
      ${onImport&&html`<button type="button" class="btn w-full justify-center" onClick=${onImport}>${Icon.download} Import from TeamCal</button>`}
      ${onMerge&&html`<button type="button" class="btn w-full justify-center" onClick=${onMerge}>Merge split bookings</button>`}
      <label for="job-search" class="sr-only">Search jobs</label>
      <input id="job-search" class="field" placeholder="Search job, customer or address" value=${q} onInput=${e=>setQ(e.target.value)}/>
    </div>
    <ul class="flex-1 min-h-0 overflow-y-auto px-2 py-2">
      ${list.map(j=>{const n=uses.get(j.id)||0;
        if(edit&&edit.id===j.id)return html`<li key=${j.id} class="rounded-lg px-2 py-2 bg-sunken" style=${{boxShadow:'inset 0 0 0 1.5px var(--accent)'}}>
          <form class="flex flex-col gap-1.5" onSubmit=${save} onKeyDown=${e=>{if(e.key==='Escape'){e.stopPropagation();setEdit(null);setMsg('')}}}>
            <label class="grid gap-0.5"><span class="label">Customer</span>
              <input id=${'je-c-'+j.id} list="jobs-customers" class="field field-sm" style=${fs} placeholder="e.g. CMB" value=${edit.customer} onInput=${e=>setEdit({...edit,customer:e.target.value})}/></label>
            <label class="grid gap-0.5"><span class="label">Job name</span>
              <input id=${'je-n-'+j.id} class="field field-sm" style=${fs} value=${edit.name} autoFocus=${true} onInput=${e=>{setEdit({...edit,name:e.target.value});setMsg('')}}/></label>
            <label class="grid gap-0.5"><span class="label">Project number</span>
              <input id=${'je-p-'+j.id} class="field field-sm mono" style=${fs} placeholder="e.g. 402313" value=${edit.projectNo||''} onInput=${e=>setEdit({...edit,projectNo:e.target.value})}/></label>
            <label class="grid gap-0.5"><span class="label">Site address</span>
              <input id=${'je-a-'+j.id} class="field field-sm" style=${fs} placeholder="Street, suburb, postcode" value=${edit.address} onInput=${e=>setEdit({...edit,address:e.target.value})}/></label>
            <span class="text-[11.5px] text-muted">The address is the default for new bookings. Existing bookings keep their own address.</span>
            ${msg&&html`<span class="text-[12px]" style=${{color:'var(--bad)'}}>${msg}</span>`}
            <div class="flex gap-1.5 justify-end">
              <button type="button" class="btn btn-ghost" style=${{height:28}} onClick=${()=>{setEdit(null);setMsg('')}}>Cancel</button>
              <button type="submit" class="btn btn-primary" style=${{height:28}}>Save</button>
            </div>
          </form></li>`;
        const st=view==='completed'?statsOf(j.id):null;
        return html`<li key=${j.id} class="group rounded-lg px-2 py-2 flex items-start gap-2.5 hover:bg-sunken">
          <label class="pt-0.5 shrink-0 cursor-pointer" title=${j.completed?'Untick to move back to Active':'Tick when the job is complete'}>
            <span class="sr-only">${j.name} completed</span>
            <input id=${'jdone-'+j.id} type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--ok)'}} checked=${!!j.completed} onChange=${e=>tryDone(j,e.target.checked)}/>
          </label>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] truncate">${j.customer?html`<span class="font-semibold">${j.customer}</span><span class="text-muted"> · </span>`:''}<span class="font-medium">${j.name}</span></div>
            <div class="text-[12px] text-muted truncate">${j.projectNo?html`<span class="mono">P ${j.projectNo}</span> · `:''}${j.address||'No site address'}</div>
            ${st
              ?html`<div class="mt-1 grid gap-0.5 text-[11.5px] text-muted">
                  <div><span class="font-medium" style=${{color:'var(--ok)'}}>Completed ${j.completedAt?`${fmtShort(parse(j.completedAt))} ${parse(j.completedAt).getFullYear()}`:''}</span></div>
                  <div class="tnum">${st.n} booking${st.n===1?'':'s'}${st.first?` · ${fmtShort(parse(st.first))} – ${fmtShort(parse(st.last))} ${parse(st.last).getFullYear()}`:''}</div>
                  ${st.crews.length>0&&html`<div class="truncate">${st.crews.join(', ')}</div>`}
                  ${(st.t||st.a)?html`<div class="tnum"><span class="font-semibold text-ink">${fmtN(st.t)} t</span> · ${fmtN(st.a)} m²</div>`:''}
                  ${st.mixes.length>0&&html`<div class="flex flex-wrap gap-1 mt-0.5">${st.mixes.map(([m,t])=>html`<span key=${m} class="mono text-[10.5px] px-1.5 py-0.5 rounded bg-surface border border-line">${m} · ${fmtN(t)} t</span>`)}</div>`}
                </div>`
              :html`<div class="text-[11.5px] text-faint">${n?`${n} booking${n===1?'':'s'}`:'No bookings yet'}</div>`}
          </div>
          ${confirm===j.id
            ?(n>0
              ?html`<div class="flex flex-col items-end gap-1 max-w-[150px]"><span class="text-[11px] text-muted text-right leading-tight">Used by ${n} booking${n===1?'':'s'}. Move or delete ${n===1?'it':'them'} first.</span>
                  <button class="text-[11px] text-muted px-1.5" onClick=${()=>setConfirm(null)}>OK</button></div>`
              :html`<div class="flex gap-1 items-center">
                  <button class="text-[11px] font-semibold px-2 py-0.5 rounded" style=${{background:'hsl(352 70% var(--blk-l))',color:'hsl(352 60% var(--blk-fg-l))'}} onClick=${()=>remove(j.id)}>Remove</button>
                  <button class="text-[11px] text-muted px-1.5" onClick=${()=>setConfirm(null)}>Keep</button></div>`)
            :html`<div class="flex items-center gap-0.5 lg:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button class=${iconBtn} onClick=${()=>{setEdit({id:j.id,name:j.name,customer:j.customer||'',address:j.address||'',projectNo:j.projectNo||''});setConfirm(null);setMsg('')}} aria-label=${'Edit '+j.name} title="Edit">${Icon.pencil}</button>
                <button class=${iconBtn} onClick=${()=>{setConfirm(j.id);setEdit(null)}} aria-label=${'Remove '+j.name} title="Remove">${Icon.x}</button></div>`}
        </li>`;})}
      ${list.length===0&&html`<li class="px-3 py-6 text-center text-muted text-[13px]">${q?`No jobs match “${q}”.`:view==='completed'?'No completed jobs yet. Tick a job in Active when it is finished.':'No active jobs. Add one below.'}</li>`}
    </ul>
    ${view==='active'&&html`<form class="border-t border-line px-4 py-3 flex flex-col gap-2 bg-sunken" onSubmit=${add}>
      <div class="label">Add job</div>
      <input id="new-job-customer" list="jobs-customers" class="field" placeholder="Customer, e.g. CMB" value=${f.customer} onInput=${e=>setF({...f,customer:e.target.value})} aria-label="Customer"/>
      <input id="new-job-name" class="field" placeholder="Job name, e.g. Duntroon St resheet" value=${f.name} onInput=${e=>{setF({...f,name:e.target.value});setMsg('')}} aria-label="Job name"/>
      <div class="flex gap-2">
        <input id="new-job-address" class="field" placeholder="Site address" value=${f.address} onInput=${e=>setF({...f,address:e.target.value})} aria-label="Site address"/>
        <button class="btn btn-primary shrink-0" type="submit" disabled=${!f.name.trim()}>${Icon.plus} Add</button>
      </div>
      ${msg&&!edit&&html`<div class="text-[12px]" style=${{color:'var(--bad)'}}>${msg}</div>`}
    </form>`}
  </div>`;
}

/* ---------- sidebar ---------- */
function Sidebar({data,setData,days,tab,setTab,onClose,renameId,setRenameId,onImport,onMerge}){
  const [q,setQ]=useState('');
  const [f,setF]=useState({name:'',sub:'',crewId:''});
  const [confirmId,setConfirmId]=useState(null);
  const [draft,setDraft]=useState({name:'',sub:''});
  useEffect(()=>{const r=data.resources.find(x=>x.id===renameId);if(r){setDraft({name:r.name,sub:r.sub,hue:r.hue});setQ('');setConfirmId(null)}},[renameId]);
  const saveRename=e=>{e.preventDefault();if(!draft.name.trim())return;
    patch(renameId,{name:draft.name.trim(),sub:draft.sub.trim(),hue:draft.hue});setRenameId(null)};
  const crews=data.resources.filter(r=>r.type==='crew');
  const list=data.resources.filter(r=>r.type===tab&&(r.name+' '+r.sub).toLowerCase().includes(q.toLowerCase()));
  const crewName=id=>crews.find(c=>c.id===id)?.name;

  const add=e=>{
    e.preventDefault();if(!f.name.trim())return;
    const r={id:tab[0]+uid(),type:tab,name:f.name.trim(),sub:f.sub.trim()||(tab==='crew'?'General':tab==='person'?'Crew member':tab==='aplant'?'Asphalt plant':'Machine'),
      crewId:tab==='crew'||tab==='aplant'?undefined:(f.crewId||null),
      hue:tab==='crew'?CREW_HUES[data.resources.filter(x=>x.type==='crew').length%CREW_HUES.length]:HUES[data.resources.length%HUES.length],visible:true};
    setData(d=>({...d,resources:[...d.resources,r]}));setF({name:'',sub:'',crewId:f.crewId});
  };
  const patch=(id,p)=>setData(d=>({...d,resources:d.resources.map(r=>r.id===id?{...r,...p}:r)}));
  const remove=id=>{setData(d=>({...d,
    resources:d.resources.filter(r=>r.id!==id).map(r=>r.crewId===id?{...r,crewId:null}:r),
    blocks:d.blocks.filter(b=>b.resourceId!==id)}));setConfirmId(null)};

  const placeholders={crew:['Crew name, e.g. Crew 5','Type of work, e.g. Paving, Seal'],person:['Full name','Role, e.g. Roller operator'],machine:['Fleet no., e.g. R-09','Description, e.g. Tandem roller'],aplant:['Plant name, e.g. Asphalt plant 2','Location, e.g. Narangba']};

  const tabsBar=html`<div class="seg w-full !grid grid-cols-4 gap-0.5" role="tablist" aria-label="Resource type">
        ${[...orderOf(data).filter(t=>TYPES[t]).map(t=>[t,TYPES[t].tab||TYPES[t].label,data.resources.filter(r=>r.type===t).length]),['jobs','Jobs',data.jobs.length],['mixes','Mixes',mixTypesOf(data).length],['seal','Seal',sealTypesOf(data).length],['trucks','Trucks',truckCosOf(data).length]]
          .map(([t,label,n])=>html`<button key=${t} role="tab" class="flex-1 !px-1 !text-[12.5px]" aria-pressed=${tab===t} aria-selected=${tab===t} title=${`${label} (${n})`} onClick=${()=>{setTab(t);setConfirmId(null)}}>${label}</button>`)}
      </div>`;
  const headTop=html`<div class="flex items-center justify-between gap-2">
        <div class="font-display text-[17px] font-semibold leading-tight">Resources</div>
        ${onClose&&html`<button class="btn btn-ghost lg:hidden" onClick=${onClose} aria-label="Close resources panel">${Icon.x}</button>`}
      </div>`;
  if(tab==='jobs')return html`<aside class="panel flex flex-col h-full min-h-0 w-full overflow-hidden">
    <div class="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-3">${headTop}${tabsBar}</div>
    <${JobsManager} data=${data} setData=${setData} onImport=${onImport} onMerge=${onMerge}/>
  </aside>`;
  if(tab==='trucks')return html`<aside class="panel flex flex-col h-full min-h-0 w-full overflow-hidden">
    <div class="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-3">${headTop}${tabsBar}</div>
    <${TrucksManager} data=${data} setData=${setData}/>
  </aside>`;
  if(tab==='seal')return html`<aside class="panel flex flex-col h-full min-h-0 w-full overflow-hidden">
    <div class="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-3">${headTop}${tabsBar}</div>
    <${SealManager} data=${data} setData=${setData}/>
  </aside>`;
  if(tab==='mixes')return html`<aside class="panel flex flex-col h-full min-h-0 w-full overflow-hidden">
    <div class="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-3">${headTop}${tabsBar}</div>
    <${MixesManager} data=${data} setData=${setData}/>
  </aside>`;
  return html`<aside class="panel flex flex-col h-full min-h-0 w-full overflow-hidden">
    <div class="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <div class="font-display text-[17px] font-semibold leading-tight">Resources</div>
        ${onClose&&html`<button class="btn btn-ghost lg:hidden" onClick=${onClose} aria-label="Close resources panel">${Icon.x}</button>`}
      </div>
      ${tabsBar}
      <div>
        <label for="res-search" class="sr-only">Search ${TYPES[tab].label}</label>
        <input id="res-search" class="field" placeholder=${'Search '+TYPES[tab].label.toLowerCase()} value=${q} onInput=${e=>setQ(e.target.value)}/>
      </div>
    </div>
    <ul class="flex-1 min-h-0 overflow-y-auto px-2 py-2">
      <datalist id="work-types">${groupCrews(crews).map(g=>html`<option key=${g.key} value=${g.label}></option>`)}</datalist>
      ${(tab==='crew'?groupCrews(list).flatMap(g=>g.rows.map((r,i)=>({r,head:i===0?g:null}))):list.map(r=>({r,head:null}))).map(({r,head})=>{
        const hdr=head&&html`<li key=${'h-'+head.key} class="px-2 pt-3 pb-1 flex items-center gap-2">
          <span class="label" style=${{color:'var(--ink)'}}>${head.label}</span><span class="mono text-[11px] text-faint">${head.rows.length}</span><span class="flex-1 h-px bg-line"></span></li>`;
        const s=rowStats(r,data,days);
        let meta;
        if(r.type==='crew'){
          const pct=Math.round(s.util*100);const tone=pct>=90?'var(--warn)':pct>=50?'var(--ok)':'var(--faint)';
          const ppl=membersOf(data,r.id,'person'),pl=membersOf(data,r.id,'machine');
          meta=html`<div class="text-muted text-[12px] truncate">${r.sub} · ${ppl.length} staff · ${pl.length} machine${pl.length===1?'':'s'}</div>
            <div class="flex items-center gap-2 mt-1.5"><div class="h-1 flex-1 rounded-full bg-line overflow-hidden"><div class="h-full rounded-full" style=${{width:pct+'%',background:tone}}></div></div>
            <span class="mono text-[11px]" style=${{color:tone}} title="Weekdays on a job in this view">${pct}%</span></div>`;
        } else if(r.type==='aplant'){
          meta=html`<div class="text-muted text-[12px] truncate">${r.sub}</div>
            ${s.flagged>0&&html`<span class="inline-block mt-1 text-[10.5px] px-1.5 rounded mono" style=${{background:'hsl(8 75% var(--blk-l))',color:'hsl(8 60% var(--blk-fg-l))'}}>${s.flagged}d maintenance in view</span>`}`;
        } else {
          meta=html`<div class="text-muted text-[12px] truncate">${r.sub}</div>
            <div class="flex items-center gap-2 mt-1">
              <label class="sr-only" for=${'crew-'+r.id}>Crew for ${r.name}</label>
              <select id=${'crew-'+r.id} class="field field-sm w-auto max-w-[120px]" value=${r.crewId||''} onChange=${e=>patch(r.id,{crewId:e.target.value||null})}>
                <option value="">Unassigned</option>${crews.map(c=>html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
              </select>
              ${s.flagged>0&&html`<span class="text-[10.5px] px-1.5 rounded mono shrink-0" style=${r.type==='person'
                ?{background:'hsl(28 75% var(--blk-l))',color:'hsl(28 60% var(--blk-fg-l))'}
                :{background:'hsl(252 70% var(--blk-l))',color:'hsl(252 50% var(--blk-fg-l))'}}>${s.flagged}d ${r.type==='person'?'away':'down'}</span>`}
            </div>`;
        }
        if(renameId===r.id) return [hdr,html`<li key=${r.id} class="rounded-lg px-2 py-2 bg-sunken" style=${{boxShadow:'inset 0 0 0 1.5px var(--accent)'}}>
          <form class="flex items-start gap-3" onSubmit=${saveRename} onKeyDown=${e=>{if(e.key==='Escape'){e.stopPropagation();setRenameId(null)}}}>
            <${Badge} r=${{...r,name:draft.name||r.name,hue:draft.hue??r.hue}}/>
            <div class="min-w-0 flex-1 flex flex-col gap-1.5">
              <label class="sr-only" for=${'rn-name-'+r.id}>Name</label>
              <input id=${'rn-name-'+r.id} class="field field-sm" style=${{height:30,fontSize:13}} value=${draft.name} autoFocus=${true}
                placeholder=${r.type==='machine'?'Fleet no.':'Name'} onInput=${e=>setDraft({...draft,name:e.target.value})}/>
              <label class="sr-only" for=${'rn-sub-'+r.id}>${r.type==='crew'?'Type of work':r.type==='person'?'Role':'Description'}</label>
              <input id=${'rn-sub-'+r.id} list=${r.type==='crew'?'work-types':undefined} class="field field-sm" style=${{height:30,fontSize:13}} value=${draft.sub}
                placeholder=${r.type==='crew'?'Type of work':r.type==='person'?'Role':'Description'} onInput=${e=>setDraft({...draft,sub:e.target.value})}/>
              ${r.type==='crew'&&html`<div class="flex flex-col gap-1 pt-0.5">
                <span class="label" id=${'rn-col-'+r.id}>Crew colour</span>
                <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby=${'rn-col-'+r.id}>
                  ${CREW_HUES.map(h=>html`<button type="button" key=${h} role="radio" aria-checked=${draft.hue===h} aria-label=${'Colour '+h}
                    class="w-6 h-6 rounded-md" onClick=${()=>setDraft({...draft,hue:h})}
                    style=${{background:`hsl(${h} 62% var(--blk-edge-l))`,boxShadow:draft.hue===h?'0 0 0 2px var(--surface), 0 0 0 4px var(--ink)':'none'}}></button>`)}
                </div>
                <span class="text-[11px] text-faint">Red is kept for night works.</span>
              </div>`}
              <div class="flex gap-1.5 justify-end">
                <button type="button" class="btn btn-ghost" style=${{height:28}} onClick=${()=>setRenameId(null)}>Cancel</button>
                <button type="submit" class="btn btn-primary" style=${{height:28}} disabled=${!draft.name.trim()}>Save</button>
              </div>
            </div>
          </form></li>`];
        return [hdr,html`<li key=${r.id} class=${'group rounded-lg px-2 py-2 flex items-start gap-3 hover:bg-sunken '+(r.visible?'':'opacity-55')}>
          <${Badge} r=${r}/>
          <div class="min-w-0 flex-1">
            <div class="font-medium truncate">${r.name}</div>
            ${meta}
          </div>
          ${confirmId===r.id
            ?html`<div class="flex flex-col gap-1 items-end">
                <button class="text-[11px] font-semibold px-2 py-0.5 rounded" style=${{background:'hsl(352 70% var(--blk-l))',color:'hsl(352 60% var(--blk-fg-l))'}} onClick=${()=>remove(r.id)}>Remove</button>
                <button class="text-[11px] text-muted px-2" onClick=${()=>setConfirmId(null)}>Keep</button></div>`
            :html`<div class="flex flex-col items-center gap-0.5 lg:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button class="p-1 rounded text-muted hover:text-ink" onClick=${()=>setRenameId(r.id)} aria-label=${'Edit '+r.name} title="Edit name">${Icon.pencil}</button>
                <button class="p-1 rounded text-muted hover:text-ink" onClick=${()=>patch(r.id,{visible:!r.visible})} aria-label=${(r.visible?'Hide ':'Show ')+r.name} title=${r.visible?'Hide from board':'Show on board'}>${r.visible?Icon.eye:Icon.eyeOff}</button>
                <button class="p-1 rounded text-muted hover:text-ink" onClick=${()=>setConfirmId(r.id)} aria-label=${'Remove '+r.name} title="Remove">${Icon.x}</button></div>`}
        </li>`];})}
      ${list.length===0&&html`<li class="px-3 py-6 text-center text-muted text-[13px]">${q?`Nothing matches “${q}”.`:`No ${TYPES[tab].label.toLowerCase()} yet. Add one below.`}</li>`}
    </ul>
    <form class="border-t border-line px-4 py-3 flex flex-col gap-2 bg-sunken" onSubmit=${add}>
      <div class="label">Add ${TYPES[tab].one}</div>
      <div class="flex gap-2">
        <input id="new-name" class="field" placeholder=${placeholders[tab][0]} value=${f.name} onInput=${e=>setF({...f,name:e.target.value})} aria-label="Name"/>
      </div>
      <input id="new-sub" list=${tab==='crew'?'work-types':undefined} class="field" placeholder=${placeholders[tab][1]} value=${f.sub} onInput=${e=>setF({...f,sub:e.target.value})} aria-label="Description"/>
      <div class="flex gap-2">
        ${tab!=='crew'&&tab!=='aplant'&&html`<select id="new-crew" class="field" value=${f.crewId} onChange=${e=>setF({...f,crewId:e.target.value})} aria-label="Crew">
          <option value="">No crew</option>${crews.map(c=>html`<option key=${c.id} value=${c.id}>${c.name} · ${c.sub}</option>`)}</select>`}
        <button class="btn btn-primary shrink-0 ml-auto" type="submit" disabled=${!f.name.trim()}>${Icon.plus} Add</button>
      </div>
    </form>
  </aside>`;
}

/* ---------- lane packing ---------- */
function packLanes(items){
  const lanes=[];
  items.sort((a,b)=>a.s-b.s||b.e-a.e).forEach(it=>{
    let i=lanes.findIndex(end=>end<it.s);
    if(i===-1){i=lanes.length;lanes.push(it.e)}else lanes[i]=it.e;
    it.lane=i;
  });
  return Math.max(1,lanes.length);
}

/* ---------- board ---------- */
function Board({data,days,view,onCreate,onEdit,onMove,onRename,onReorder,onExport,collapsed,toggleSection,notifPrefs}){
  /* ---- drag to reorder sections and rows (by their grip handles) ---- */
  const boxRef=React.useRef(null);
  const [reo,setReo]=useState(null);
  const reoRef=React.useRef(null);
  reoRef.current=reo;
  const startReo=(e,kind,id,scope)=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();setReo({kind,id,scope,target:null,after:false})};
  useEffect(()=>{
    if(!reo)return;
    const mv=e=>{
      const r=reoRef.current;if(!r)return;
      e.preventDefault();
      const box=boxRef.current;
      if(box){const bb=box.getBoundingClientRect();
        if(e.clientY<bb.top+60)box.scrollTop-=14;else if(e.clientY>bb.bottom-40)box.scrollTop+=14}
      const el=document.elementFromPoint(e.clientX,e.clientY);
      const t=r.kind==='row'?el?.closest('[data-rid]'):el?.closest('[data-section]');
      let target=null,after=false;
      if(t){
        const tid=r.kind==='row'?t.dataset.rid:t.dataset.section;
        const ok=r.kind==='section'||t.dataset.scope===r.scope;
        if(ok&&tid!==r.id){const rc=t.getBoundingClientRect();target=tid;after=e.clientY>rc.top+rc.height/2}
      }
      if(target!==r.target||after!==r.after)setReo({...r,target,after});
    };
    const up=()=>{const r=reoRef.current;setReo(null);if(r&&r.target)onReorder(r.kind,r.id,r.target,r.after)};
    const esc=e=>{if(e.key==='Escape')setReo(null)};
    document.body.classList.add('is-dragging');
    window.addEventListener('pointermove',mv,{passive:false});
    window.addEventListener('pointerup',up);
    window.addEventListener('keydown',esc);
    return()=>{document.body.classList.remove('is-dragging');window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',up);window.removeEventListener('keydown',esc)};
  },[!!reo]);
  const reoMark=(kind,id)=>{
    if(!reo||reo.kind!==kind)return {style:null,line:null};
    if(reo.id===id)return {style:{opacity:.45},line:null};
    if(reo.target===id)return {style:null,line:html`<div class="reo-line" style=${reo.after?{bottom:-2}:{top:-2}}></div>`};
    return {style:null,line:null};
  };
  const Grip=(label,onDown,extra='')=>html`<span class=${'grip '+extra} role="button" tabindex="-1" aria-label=${label} title="Drag to reorder"
    onPointerDown=${onDown} onClick=${e=>{e.preventDefault();e.stopPropagation()}}>${Icon.grip}</span>`;
  window.__rosterData=data;
  const N=days.length;
  const colMin=view===7?120:view===14?68:view===60?26:40;
  const nameW=view===7?210:180;
  const rangeStart=days[0];
  const todayIdx=diffDays(rangeStart,TODAY);
  const [sel,setSel]=useState(null);
  /* ---- drag & drop of existing blocks ---- */
  const [drag,setDrag]=useState(null);
  const dragRef=React.useRef(null);
  dragRef.current=drag;
  const typeOf=id=>data.resources.find(r=>r.id===id)?.type;
  const startDrag=(e,b)=>{
    e.stopPropagation();
    if(e.button!==0)return;
    const area=e.currentTarget.closest('.dayarea');
    const colW=area.getBoundingClientRect().width/N;
    setDrag({b,x0:e.clientX,y0:e.clientY,x:e.clientX,y:e.clientY,colW,dx:0,rid:b.resourceId,moved:false});
  };
  useEffect(()=>{
    if(!drag)return;
    const mv=e=>{
      const d=dragRef.current;if(!d)return;
      const moved=d.moved||Math.abs(e.clientX-d.x0)>4||Math.abs(e.clientY-d.y0)>4;
      if(moved)e.preventDefault();
      const dx=Math.round((e.clientX-d.x0)/d.colW);
      let rid=d.rid;
      const row=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-rid]');
      if(row&&typeOf(row.dataset.rid)===typeOf(d.b.resourceId))rid=row.dataset.rid;
      setDrag({...d,x:e.clientX,y:e.clientY,dx,rid,moved});
    };
    const upH=()=>{
      const d=dragRef.current;setDrag(null);if(!d)return;
      if(!d.moved){onEdit(d.b);return}
      if(d.dx===0&&d.rid===d.b.resourceId)return;
      onMove({...d.b,resourceId:d.rid,start:iso(addDays(parse(d.b.start),d.dx)),end:iso(addDays(parse(d.b.end),d.dx))});
    };
    const cancel=e=>{if(e.key==='Escape')setDrag(null)};
    window.addEventListener('pointermove',mv);
    window.addEventListener('pointerup',upH);
    window.addEventListener('pointercancel',()=>setDrag(null));
    window.addEventListener('keydown',cancel);
    return()=>{window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',upH);window.removeEventListener('keydown',cancel)};
  },[!!drag]);
  useEffect(()=>{document.body.classList.toggle('is-dragging',!!(drag&&drag.moved))},[drag&&drag.moved]);
  const preview=drag&&drag.moved?{...drag.b,resourceId:drag.rid,start:iso(addDays(parse(drag.b.start),drag.dx)),end:iso(addDays(parse(drag.b.end),drag.dx))}:null;
  const effBlocks=preview?data.blocks.map(b=>b.id===preview.id?preview:b):data.blocks;
  const quoteFresh=new Set(!(notifPrefs&&notifPrefs.quote)?[]:recentQuoteChanges(data).map(c=>c.bookingId));
  const nudge=(b,n)=>onMove({...b,start:iso(addDays(parse(b.start),n)),end:iso(addDays(parse(b.end),n))});
  const grid={gridTemplateColumns:`repeat(${N},minmax(${colMin}px,1fr))`};
  const colBg=d=>diffDays(d,TODAY)===0?'var(--accent-soft)':isWeekend(d)?'var(--weekend)':'transparent';

  const idxAt=(e,el)=>{const r=el.getBoundingClientRect();return Math.max(0,Math.min(N-1,Math.floor((e.clientX-r.left)/r.width*N)))};
  const down=(e,r)=>{if(e.button!==0)return;const i=idxAt(e,e.currentTarget);e.currentTarget.setPointerCapture?.(e.pointerId);setSel({rid:r.id,a:i,b:i})};
  const move=e=>{if(!sel)return;const i=idxAt(e,e.currentTarget);if(i!==sel.b)setSel(s=>({...s,b:i}))};
  const up=()=>{if(!sel)return;const a=Math.min(sel.a,sel.b),b=Math.max(sel.a,sel.b);
    onCreate({resourceId:sel.rid,start:iso(addDays(rangeStart,a)),end:iso(addDays(rangeStart,b))});setSel(null)};

  /* crew warning flags: members away, plant down */
  const crewFlags=crew=>{
    const ppl=membersOf(data,crew.id,'person'),pl=membersOf(data,crew.id,'machine');
    const out=[];
    days.forEach((d,i)=>{
      const k=iso(d);
      const away=ppl.filter(p=>data.blocks.some(b=>b.resourceId===p.id&&covers(b,k)&&KINDS[b.kind].away));
      const dn=pl.filter(m=>data.blocks.some(b=>b.resourceId===m.id&&covers(b,k)&&KINDS[b.kind].down));
      if(away.length||dn.length)out.push({i,away,dn});
    });
    return out;
  };

  const Row=r=>{
    const items=[];
    [...effBlocks.filter(b=>b.resourceId===r.id),...(r.type==='machine'?plantBookings(effBlocks,r.id):[]),...(r.type==='crew'?coverBookings(effBlocks,r.id):[])].forEach(b=>{
      const s0=diffDays(rangeStart,parse(b.start)),e0=diffDays(rangeStart,parse(b.end));
      if(e0<0||s0>N-1)return;
      items.push({b,s:Math.max(0,s0),e:Math.min(N-1,e0),cutL:s0<0,cutR:e0>N-1});
    });
    const lanes=packLanes(items);
    const flags=r.type==='crew'?crewFlags(r):[];
    /* days this crew has a job while the asphalt plant is under maintenance */
    const clashes=usesPlant(r)?days.map((d,i)=>{const k=iso(d);
      /* a job clashes when the plant is down on that job's shift (day/night) and the shift has no exbin */
      const todays=effBlocks.filter(b=>b.resourceId===r.id&&b.kind==='job'&&covers(b,k)&&!exbinOf(b,k));
      const names=[...new Set(todays.flatMap(b=>plantMaintOn(data,effBlocks,k,b.shift||'day')))];
      return names.length?{i,names}:null}).filter(Boolean):[];
    const flagTop=10+lanes*32;
    const h=Math.max(56,lanes*28+(lanes-1)*4+20+(flags.length?20:0));
    const selHere=sel&&sel.rid===r.id;
    const crew=r.crewId&&data.resources.find(c=>c.id===r.crewId);
    const ppl=r.type==='crew'?membersOf(data,r.id,'person').length:0;
    const pl=r.type==='crew'?membersOf(data,r.id,'machine').length:0;
    const isDrop=preview&&preview.resourceId===r.id&&preview.resourceId!==drag.b.resourceId;
    const mk=reoMark('row',r.id);
    return html`<div key=${r.id} data-rid=${r.id} data-scope=${scopeOf(r)} class=${'relative flex border-b border-line'+(isDrop?' droprow':'')} style=${mk.style}>
      ${mk.line}
      <div class="group/name sticky left-0 z-10 bg-surface border-r border-line flex items-center gap-2 pl-1 pr-3 shrink-0" style=${{width:nameW,minHeight:h}}>
        ${Grip('Drag to move '+r.name,e=>startReo(e,'row',r.id,scopeOf(r)),'lg:opacity-0 group-hover/name:opacity-100')}
        <${Badge} r=${r} size=${28}/>
        <div class="min-w-0">
          <div class="font-medium text-[13px] truncate">${r.name}</div>
          <div class="text-[11.5px] text-muted truncate">${r.type==='crew'?`${ppl} staff · ${pl} machine${pl===1?'':'s'}`:`${r.sub}${crew?' · '+crew.name:''}`}</div>
        </div>
        <button class="ml-auto p-1 rounded text-muted hover:text-ink shrink-0 lg:opacity-0 group-hover/name:opacity-100 focus:opacity-100" onClick=${()=>onRename(r)} aria-label=${'Edit '+r.name} title="Edit name">${Icon.pencil}</button>
      </div>
      <div class="dayarea relative flex-1" style=${{height:h}}
           onPointerDown=${e=>down(e,r)} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${()=>setSel(null)}
           title="Drag across days to add a booking">
        <div class="absolute inset-0 grid pointer-events-none" style=${grid}>
          ${days.map((d,i)=>html`<div key=${i} class="border-r border-line last:border-r-0" style=${{background:colBg(d)}}></div>`)}
        </div>
        ${todayIdx>=0&&todayIdx<N&&html`<div class="absolute top-0 bottom-0 w-[2px] pointer-events-none z-[2]" style=${{left:`calc(${(todayIdx+.5)/N*100}% - 1px)`,background:'var(--accent)',opacity:.55}}></div>`}
        ${selHere&&html`<div class="absolute top-1.5 bottom-1.5 rounded-md pointer-events-none z-[4]" style=${{
            left:`calc(${Math.min(sel.a,sel.b)/N*100}% + 3px)`,width:`calc(${(Math.abs(sel.b-sel.a)+1)/N*100}% - 6px)`,
            border:'1.5px dashed var(--accent)',background:'var(--accent-soft)'}}></div>`}
        ${items.map(it=>{
          const title=blockTitle(it.b,data.jobs);
          const span=it.e-it.s+1;
          const compact=(view===30&&span<3)||(view===60&&span<5)||(view===14&&span<2);
          const night=(it.b.kind==='job'||it.b.kind==='onjob')&&it.b.shift==='night';
          const v=it.b.virtual;
          const vTip=v?(it.b.cover?`Covering a shift for ${data.resources.find(c=>c.id===it.b.crewId)?.name||'another crew'}\n`:`${data.jobs.find(j=>j.id===it.b.jobId)?.name||'Job'} · ${data.resources.find(c=>c.id===it.b.crewId)?.name||''}\n`):'';
          const dragging=preview&&preview.id===it.b.id;
          return html`<div key=${it.b.id} class=${'blk'+(dragging?' dragging':'')} role="button" tabindex="0" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
            style=${{...blockStyle(it.b,data),top:10+it.lane*32,left:`calc(${it.s/N*100}% + 3px)`,width:`calc(${span/N*100}% - 6px)`,
              borderTopLeftRadius:it.cutL?0:6,borderBottomLeftRadius:it.cutL?0:6,borderTopRightRadius:it.cutR?0:6,borderBottomRightRadius:it.cutR?0:6,
              justifyContent:compact?'center':'flex-start',padding:compact?'0 2px':undefined}}
            title=${`${vTip}${title}${night?' (night works)':''} · ${r.name}${!v&&it.b.kind==='job'&&it.b.shiftData?Object.keys(it.b.shiftData).filter(k=>coverOf(it.b,k)&&k>=it.b.start&&k<=it.b.end).sort().map(k=>`\n${WD[parse(k).getDay()]} ${fmtShort(parse(k))}: done by ${data.resources.find(c=>c.id===coverOf(it.b,k))?.name||'another crew'}`).join(''):''}${it.b.projectNo?`\nProject ${it.b.projectNo}`:''}${it.b.quoteNo?`\nQuote ${it.b.quoteNo}`:''}${it.b.notes?`\n${it.b.notes.length>140?it.b.notes.slice(0,140)+'…':it.b.notes}`:''}${it.b.kind==='job'&&it.b.shiftData?(t=>t.tonnes||t.area?`\n${fmtN(t.tonnes)} t · ${fmtN(t.area)} m² over ${t.filled} shift${t.filled===1?'':'s'}`:'')(qtyTotals(it.b)):''}\n${fmtShort(parse(it.b.start))} – ${fmtShort(parse(it.b.end))}${v?(it.b.cover?'\nClick to edit the booking':'\nClick to edit the crew job'):''}`}
            onPointerDown=${e=>v?e.stopPropagation():startDrag(e,it.b)}
            onClick=${v?()=>onEdit(it.b.parent):undefined}
            onKeyDown=${e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onEdit(v?it.b.parent:it.b)}
              else if(!v&&e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();nudge(it.b,e.key==='ArrowLeft'?-1:1)}}}>
            ${(it.b.kind==='job'||it.b.kind==='onjob')&&days.slice(it.s,it.e+1).map((d,i)=>{const src=it.b.kind==='onjob'?it.b.parent:it.b;
                const off=!worksOn(it.b,d),cov=!off&&!it.b.cover&&coverOf(src,iso(d));if(!off&&!cov)return null;
                return html`<span key=${'w'+i} class=${'wkoff'+(cov?' cov':'')} aria-hidden="true" style=${{left:`${i/span*100}%`,width:`${100/span}%`}}></span>`})}
            ${it.cutL&&html`<span aria-hidden="true">‹</span>`}
            ${night&&html`<span class="shrink-0 inline-flex" title="Night works">${Icon.moon}</span>`}
            ${!v&&quoteFresh.has(it.b.id)&&html`<span class="shrink-0 w-2 h-2 rounded-full" style=${{background:'var(--accent)',boxShadow:'0 0 0 2px var(--surface)'}} title="Quote number changed in the last 48 hours"></span>`}
            ${v&&!compact&&!it.b.cover&&html`<span class="shrink-0 inline-flex opacity-80">${Icon.pin}</span>`}
            ${compact
              ?(sl=>html`<span class="flex flex-col min-w-0 max-w-full leading-[1.15] text-center"><span class="t text-[10px] font-semibold">${sl[0]}</span>${sl[1]&&html`<span class="t text-[9.5px] opacity-80">${sl[1]}</span>`}</span>`)(shortLabel(it.b))
              :html`<span class="t">${title}</span>`}
            ${!compact&&span>=2&&view===7&&html`<span class="ml-auto mono text-[10.5px] opacity-70 shrink-0">${span}d</span>`}
            ${it.cutR&&html`<span aria-hidden="true" class=${compact?'':'ml-auto'}>›</span>`}
          </div>`;})}
        ${clashes.map(c=>html`<div key=${'c'+c.i} class="absolute top-1 bottom-1 z-[4] rounded-md pointer-events-none"
            style=${{left:`calc(${c.i/N*100}% + 1px)`,width:`calc(${100/N}% - 2px)`,boxShadow:'inset 0 0 0 2px hsl(0 75% var(--blk-edge-l))',
              backgroundImage:'repeating-linear-gradient(135deg,hsl(0 80% 50% / .16) 0 5px,transparent 5px 10px)'}}>
            <span class="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full inline-flex items-center justify-center pointer-events-auto cursor-help"
              style=${{background:'hsl(0 75% var(--blk-edge-l))',color:'var(--surface)'}}
              title=${`Asphalt plant maintenance on ${WD[days[c.i].getDay()]} ${fmtShort(days[c.i])}: ${c.names.join(', ')}. Check asphalt supply for this job.`}>${Icon.alert}</span>
          </div>`)}
        ${flags.map(fl=>{
          const tip=[fl.away.length&&`Away: ${fl.away.map(p=>p.name).join(', ')}`,fl.dn.length&&`Machines down: ${fl.dn.map(m=>m.name+' '+m.sub.toLowerCase()).join(', ')}`].filter(Boolean).join('\n');
          return html`<div key=${'f'+fl.i} class="absolute flex gap-1 justify-center z-[3]" style=${{top:flagTop,left:`calc(${fl.i/N*100}% + 3px)`,width:`calc(${100/N}% - 6px)`}} title=${tip}>
            ${fl.away.length>0&&html`<span class="flag px-1" style=${{position:'static',background:'hsl(28 75% var(--blk-l))',color:'hsl(28 60% var(--blk-fg-l))'}}>${Icon.person}${fl.away.length}${view===7?' away':''}</span>`}
            ${fl.dn.length>0&&html`<span class="flag px-1" style=${{position:'static',background:'hsl(4 70% var(--blk-l))',color:'hsl(4 60% var(--blk-fg-l))'}}>${Icon.wrench}${view===7?fl.dn.map(m=>m.name).join(' '):fl.dn.length}</span>`}
          </div>`;})}
      </div>
    </div>`;
  };

  const SubHead=g=>{
    const ck='crew:'+g.key;
    return html`<div key=${'g-'+g.key} class="flex border-b border-line">
      <button class="sticky left-0 z-10 bg-surface border-r border-line flex items-center gap-2 pl-6 pr-3 py-1.5 shrink-0 text-left" style=${{width:nameW}}
        onClick=${()=>toggleSection(ck)} aria-expanded=${!collapsed[ck]}>
        <span class="text-muted inline-flex transition-transform" style=${{transform:collapsed[ck]?'rotate(-90deg)':'none'}}>${Icon.chevD}</span>
        <span class="text-[12.5px] font-semibold truncate">${g.label}</span>
        <span class="mono text-[11px] text-faint shrink-0">${g.rows.length} crew${g.rows.length===1?'':'s'}</span>
      </button>
      <div class="flex-1 grid" style=${grid}>
        ${days.map((d,i)=>html`<div key=${i} style=${{background:isWeekend(d)?'var(--weekend)':'transparent'}}></div>`)}
      </div>
    </div>`;
  };

  /* ---- Paving tonnes: daily tonnes by mix for every paving crew's job, plus weekly totals ---- */
  const isPaving=r=>r.type==='crew'&&workKey(r.sub).includes('pav');
  const pavIds=new Set(data.resources.filter(isPaving).map(r=>r.id));
  const pavJobs=effBlocks.filter(b=>b.kind==='job'&&pavIds.has(b.resourceId)&&b.shiftData);
  const tonnesOn=dateKey=>{ /* Map(type -> tonnes) for one date */
    const m=new Map();
    pavJobs.forEach(b=>{if(dateKey<b.start||dateKey>b.end)return;
      if(!worksOn(b,parse(dateKey)))return;
      linesOf(b.shiftData[dateKey]).filter(lineHas).forEach(l=>{const t=num(l.tonnes);if(!t)return;
        const k=mixLabel(l);m.set(k,(m.get(k)||0)+t)})});
    return m;
  };
  const dayMaps=days.map(d=>tonnesOn(iso(d)));
  const mixTypes=[...new Set(dayMaps.flatMap(m=>[...m.keys()]))]
    .sort((a,b)=>{const ML=mixTypesOf(data),ia=ML.indexOf(a.split(' · ')[0]),ib=ML.indexOf(b.split(' · ')[0]);return (ia<0?99:ia)-(ib<0?99:ib)||a.localeCompare(b)});
  const dayTotals=dayMaps.map(m=>[...m.values()].reduce((a,v)=>a+v,0));
  const viewTotal=dayTotals.reduce((a,v)=>a+v,0);
  const weeks=[];days.forEach((d,i)=>{const wk=iso(mondayOf(d));const w=weeks[weeks.length-1];
    if(w&&w.key===wk)w.len++;else weeks.push({key:wk,start:i,len:1})});
  weeks.forEach(w=>{let t=0;const m=new Map();for(let i=0;i<7;i++){tonnesOn(iso(addDays(parse(w.key),i))).forEach((v,k)=>{t+=v;m.set(k,(m.get(k)||0)+v)})}
    w.total=t;w.byType=m;w.partial=w.len<7});
  const cellT=v=>v?(view===7?`${fmtN(v)} t`:fmtN(Math.round(v))):'';
  const TonnesBody=()=>{
    if(pavIds.size===0)return html`<div class="px-4 py-4 text-muted text-[13px] border-b border-line">No paving crews yet. Give a crew the type of work "Paving" to see its tonnes here.</div>`;
    const nameCell=(content,extra='')=>html`<div class=${'sticky left-0 z-10 bg-surface border-r border-line flex items-center gap-2 pl-4 pr-3 shrink-0 '+extra} style=${{width:nameW}}>${content}</div>`;
    const dayCells=(fn,bold)=>html`<div class="flex-1 grid" style=${grid}>${days.map((d,i)=>html`<div key=${i}
      class=${'border-r border-line last:border-r-0 flex items-center justify-center mono '+(bold?'text-[12.5px] font-semibold':'text-[12px]')}
      style=${{background:colBg(d)}}>${fn(i)}</div>`)}</div>`;
    return html`<div>
      ${mixTypes.length===0&&html`<div class="flex border-b border-line">
        ${nameCell(html`<span class="text-[12.5px] text-muted">No tonnes yet</span>`,'py-2.5')}
        <div class="flex-1 px-4 py-2.5 text-[12.5px] text-muted">Add tonnes in a paving job's Asphalt & Job Quantities tab.</div></div>`}
      ${mixTypes.map(mt=>html`<div key=${mt} class="flex border-b border-line" style=${{minHeight:34}}>
        ${nameCell(html`<span class="mono text-[12.5px] font-semibold">${mt}</span>`)}
        ${dayCells(i=>{const v=dayMaps[i].get(mt);return v?html`<span title=${`${mt}: ${fmtN(v)} t on ${fmtShort(days[i])}`}>${cellT(v)}</span>`:''})}
      </div>`)}
      ${mixTypes.length>0&&html`<div class="flex border-b border-line bg-sunken" style=${{minHeight:36}}>
        ${nameCell(html`<span class="text-[12.5px] font-semibold">Daily total</span>`,'!bg-sunken')}
        ${dayCells(i=>dayTotals[i]?html`<span title=${[...dayMaps[i]].map(([k,v])=>`${k}: ${fmtN(v)} t`).join('\n')}>${cellT(dayTotals[i])}</span>`:'',true)}
      </div>
      <div class="flex border-b border-line" style=${{minHeight:40}}>
        ${nameCell(html`<span class="text-[12.5px] font-semibold">Weekly total</span>
          <button class="ml-auto inline-flex items-center gap-1 h-7 px-2 rounded-md text-[12px] font-medium border border-line hover:bg-sunken" onClick=${()=>onExport(weeks.map(w=>w.key))} title="Export weekly tonnes to Excel">${Icon.download} Excel</button>`)}
        <div class="flex-1 grid" style=${grid}>
          ${weeks.map(w=>html`<div key=${w.key} class="border-r border-line last:border-r-0 flex items-center justify-center gap-1.5 px-1 py-1.5 overflow-hidden"
            style=${{gridColumn:`${w.start+1} / span ${w.len}`}}
            title=${`Week of ${fmtShort(parse(w.key))} (Mon–Sun)\n`+([...w.byType].map(([k,v])=>`${k}: ${fmtN(v)} t`).join('\n')||'No tonnes')}>
            ${w.len>=2||view===7
              ?html`<span class="text-[11px] text-muted whitespace-nowrap">Wk ${fmtShort(parse(w.key))}${w.partial?'*':''}</span>
                 <span class="mono text-[13px] font-semibold whitespace-nowrap" style=${{color:w.total?'var(--ink)':'var(--faint)'}}>${fmtN(w.total)} t</span>`
              :html`<span class="mono text-[11px] font-semibold">${fmtN(Math.round(w.total))}</span>`}
          </div>`)}
        </div>
      </div>
`}
    </div>`;
  };
  const SEC_LABEL=t=>t==='tonnes'?'Paving tonnes':TYPES[t].label;

  const sections=orderOf(data).map(t=>({t,rows:data.resources.filter(r=>r.type===t&&r.visible)}));

  return html`<div ref=${boxRef} class="scrollbox flex-1 min-h-0" role="region" aria-label="Schedule board">
    <div style=${{minWidth:nameW+N*colMin}} class="relative">
      <div class="flex sticky top-0 z-20 bg-surface border-b border-line">
        <div class="sticky left-0 z-30 bg-surface border-r border-line flex items-end px-4 pb-2 shrink-0" style=${{width:nameW}}>
          <span class="label">Crews / machines / staff</span>
        </div>
        <div class="flex-1 grid" style=${grid}>
          ${days.map((d,i)=>{
            const t=i===todayIdx;
            const showMonth=view===7||i===0||d.getDate()===1;
            return html`<div key=${i} class="py-2 text-center border-r border-line last:border-r-0" style=${{background:colBg(d)}}>
              <div class="text-[10.5px] uppercase tracking-wide h-[14px]" style=${{color:t?'var(--accent)':'var(--faint)',fontWeight:showMonth&&view!==7?600:500}}>
                ${view===7?`${WD[d.getDay()]} · ${MON[d.getMonth()]}`:(showMonth?MON[d.getMonth()]:(view===14?WD[d.getDay()]:WD[d.getDay()][0]))}</div>
              <div class=${'mono mt-0.5 '+(view===7?'text-[18px]':view===14?'text-[15px]':view===60?'text-[11.5px]':'text-[13px]')} style=${{color:t?'var(--accent)':isWeekend(d)?'var(--faint)':'var(--ink)',fontWeight:t?600:500}}>
                ${t?html`<span class="inline-flex items-center justify-center rounded-full" style=${{background:'var(--accent)',color:'var(--accent-ink)',minWidth:view===7?30:view===60?20:24,height:view===7?30:view===60?20:24,padding:'0 4px'}}>${d.getDate()}</span>`:d.getDate()}
              </div>
            </div>`;})}
        </div>
      </div>

      ${sections.map(({t,rows})=>{const mk=reoMark('section',t);return html`<div key=${t} data-section=${t} class="relative" style=${mk.style}>
        ${mk.line}
        <div class="flex border-b border-line bg-sunken">
          <div class="sticky left-0 z-10 bg-sunken flex items-center pl-1 shrink-0" style=${{width:nameW}}>
            ${Grip('Drag to move the '+SEC_LABEL(t)+' section',e=>startReo(e,'section',t,'sections'))}
            <button class="flex items-center gap-2 pl-1 pr-3 py-2 flex-1 min-w-0 text-left" onClick=${()=>toggleSection(t)} aria-expanded=${!collapsed[t]}>
              <span class="text-muted inline-flex transition-transform" style=${{transform:collapsed[t]?'rotate(-90deg)':'none'}}>${Icon.chevD}</span>
              <span class="label" style=${{color:'var(--ink)'}}>${SEC_LABEL(t)}</span>
              <span class="mono text-[11px] text-faint">${t==='tonnes'?`${fmtN(viewTotal)} t in view`:rows.length}</span>
            </button>
          </div>
          <div class="flex-1 grid" style=${grid}>
            ${days.map((d,i)=>html`<div key=${i}></div>`)}
          </div>
        </div>
        ${!collapsed[t]&&t==='tonnes'&&TonnesBody()}
        ${!collapsed[t]&&t!=='tonnes'&&(t==='crew'
          ?groupCrews(rows).map(g=>[SubHead(g),...(collapsed['crew:'+g.key]?[]:g.rows.map(Row))])
          :rows.map(Row))}
        ${!collapsed[t]&&t!=='tonnes'&&rows.length===0&&html`<div class="px-4 py-4 text-muted text-[13px] border-b border-line">No ${TYPES[t].label.toLowerCase()} on the board. Add or unhide them in the Resources panel.</div>`}
      </div>`;})}

    </div>
  </div>`;
}

/* ---------- mobile plant picker (crew jobs) ---------- */
function PlantPicker({f,set,data}){
  const machines=data.resources.filter(r=>r.type==='machine');
  const crew=data.resources.find(r=>r.id===f.resourceId);
  const own=machines.filter(m=>m.crewId===f.resourceId);
  const sorted=[...own,...machines.filter(m=>m.crewId!==f.resourceId)];
  const picked=new Set(f.plantIds||[]);
  const toggle=id=>{const s=new Set(picked);s.has(id)?s.delete(id):s.add(id);set({plantIds:[...s]})};
  const addOwn=()=>set({plantIds:[...new Set([...picked,...own.map(m=>m.id)])]});
  const range={start:f.start,end:f.end};
  const status=m=>{
    if(!f.start||!f.end||f.end<f.start)return null;
    const down=data.blocks.find(b=>b.resourceId===m.id&&KINDS[b.kind].down&&overlaps(b,range));
    if(down)return {tone:'var(--bad)',text:`${b2s(down)}: ${down.title||KINDS[down.kind].label}`};
    const other=data.blocks.find(b=>b.id!==f.id&&b.kind==='job'&&(b.plantIds||[]).includes(m.id)&&overlaps(b,range));
    if(other){const c=data.resources.find(r=>r.id===other.resourceId);
      return {tone:'var(--warn)',text:`${b2s(other)}: already on ${c?.name||'another crew'}'s job`}}
    return null;
  };
  const b2s=b=>b.start===b.end?fmtShort(parse(b.start)):`${fmtShort(parse(b.start))}–${fmtShort(parse(b.end))}`;
  return html`<section class="grid gap-2">
    <div class="flex items-center gap-2">
      <h3 class="font-display text-[15px] font-semibold">Mobile plant</h3>
      <span class="mono text-[11px] text-faint">${picked.size} assigned</span>
      <span class="flex-1"></span>
      ${own.length>0&&own.some(m=>!picked.has(m.id))&&html`<button type="button" class="text-[12px] font-medium underline underline-offset-2 text-muted hover:text-ink" onClick=${addOwn}>Add ${crew?.name||'crew'}'s plant</button>`}
    </div>
    ${machines.length===0
      ?html`<div class="text-[12.5px] text-muted">No machines yet. Add them in the Resources panel under Machines.</div>`
      :html`<ul class="border border-line rounded-lg max-h-[210px] overflow-y-auto divide-y" style=${{borderColor:'var(--line)'}}>
        ${sorted.map(m=>{const st=status(m);const isOwn=m.crewId===f.resourceId;
          return html`<li key=${m.id} style=${{borderColor:'var(--line)'}}>
            <label class="flex items-center gap-2.5 px-2.5 py-1.5 cursor-pointer hover:bg-sunken">
              <input id=${'pl-'+m.id} type="checkbox" class="w-4 h-4 shrink-0" style=${{accentColor:'var(--accent)'}} checked=${picked.has(m.id)} onChange=${()=>toggle(m.id)}/>
              <${Badge} r=${m} size=${24}/>
              <div class="min-w-0 flex-1">
                <div class="text-[13px] truncate"><span class="font-medium mono">${m.name}</span> <span class="text-muted">${m.sub}</span></div>
                ${st&&html`<div class="text-[11.5px] truncate" style=${{color:st.tone}}>${st.text}</div>`}
              </div>
              ${isOwn&&html`<span class="text-[10.5px] text-faint shrink-0">${crew?.name}</span>`}
            </label></li>`;})}
      </ul>`}
  </section>`;
}

/* ---------- shifts & asphalt quantities ---------- */
/* A job's shifts are its working days: weekdays, plus weekends when the booking says so.
   Quantities are saved per shift date in block.shiftData = {'YYYY-MM-DD': {type, tonnes, area}},
   so each shift keeps its own figures; moving a booking re-keys them (see onMove). */
const ASPHALT_TYPES=['AC7','AC10','AC14','AC20','EME2','SMA','Type1','Type2','Type3','Type4'];
/* the company's mix list: starts from the standard list and grows when someone saves a mix entered under "Other" */
const mixTypesOf=d=>d&&Array.isArray(d.mixTypes)&&d.mixTypes.length?d.mixTypes:ASPHALT_TYPES;
const linesTypes=sd=>Object.values(sd||{}).flatMap(q=>linesOf(q)).map(l=>(l.type||'').trim()).filter(Boolean);
function shiftDates(b){
  if(!b.start||!b.end||b.end<b.start)return [];
  const out=[];const n=diffDays(parse(b.start),parse(b.end));
  for(let i=0;i<=n;i++){const d=addDays(parse(b.start),i);if(worksOn(b,d))out.push(iso(d))}
  return out;
}
const num=v=>{const n=parseFloat(v);return isFinite(n)&&n>=0?n:0};
const DEFAULT_DENSITY=2.4; /* typical compacted dense-graded asphalt, t/m³ */
const filledNum=v=>v!==''&&v!=null;
/* Each shift holds one or more asphalt lines: shiftData[date] = {lines:[{type,tonnes,area,depth}]}.
   Older saves stored a single line directly on the shift; linesOf() reads both shapes. */
const BLANK_LINE={type:'',binder:'',tonnes:'',area:'',depth:''};
const BINDERS=['C320','MG','C600','A15E','EME2'];
/* Exbin: asphalt bought in from another supplier for a shift (covers asphalt plant maintenance) */
const EXBIN_SUPPLIERS=['FH','Downer','Austek','BCC'];
const exbinOf=(b,k)=>b&&b.shiftData&&b.shiftData[k]&&b.shiftData[k].exbin||null;
const shiftBase=q=>q&&Array.isArray(q.lines)?q:{};
const bindersOf=d=>d&&Array.isArray(d.binders)?d.binders:BINDERS;
/* binder filled in automatically when a mix is picked; set per mix in Resources → Mixes */
const DEFAULT_MIX_BINDER={EME2:'EME2',SMA:'A15E'};
const mixBinderOf=d=>d&&d.mixBinder&&typeof d.mixBinder==='object'?d.mixBinder:DEFAULT_MIX_BINDER;
const binderForMix=(d,type)=>{const m=mixBinderOf(d);const t=(type||'').trim();
  const k=Object.keys(m).find(x=>x.toLowerCase()===t.toLowerCase());return k?m[k]:''};
/* seal products (Resources → Seal): offered on Seal crew bookings instead of asphalt mixes; paving can't pick them */
const SEAL_TYPES=['Prime','Primerseal','7mm Seal','10mm Seal','14mm Seal'];
const sealTypesOf=d=>d&&Array.isArray(d.sealTypes)?d.sealTypes:SEAL_TYPES;
const SEAL_BINDERS=['C170','AMC0','AMC00','S35E','S45R'];
const sealBindersOf=d=>d&&Array.isArray(d.sealBinders)?d.sealBinders:SEAL_BINDERS;
const sealBinderOf=d=>d&&d.sealBinder&&typeof d.sealBinder==='object'?d.sealBinder:{};
const isSealCrew=r=>!!r&&r.type==='crew'&&workKey(r.sub).includes('seal');
const binderForProduct=(d,crew,type)=>{if(!isSealCrew(crew))return binderForMix(d,type);
  const m=sealBinderOf(d);const t=(type||'').trim();const k=Object.keys(m).find(x=>x.toLowerCase()===t.toLowerCase());return k?m[k]:''};
/* a mix is its asphalt type plus binder, e.g. "AC14 · C320" */
const mixLabel=l=>((l.type||'').trim()||'No type')+(l.binder?' · '+l.binder:'');
const linesOf=q=>!q?[]:Array.isArray(q.lines)?q.lines:[q];
const lineHas=l=>l&&((l.type||'').trim()||l.binder||filledNum(l.tonnes)||filledNum(l.area)||filledNum(l.depth));
const hasQty=q=>linesOf(q).some(lineHas);
const cleanLine=l=>({type:(l.type||'').trim(),binder:l.binder||'',...(l.virgin?{virgin:true}:{}),tonnes:filledNum(l.tonnes)?num(l.tonnes):'',area:filledNum(l.area)?num(l.area):'',depth:filledNum(l.depth)?num(l.depth):''});
const fmtN=n=>n.toLocaleString('en-AU',{maximumFractionDigits:1});
function qtyTotals(b){
  const dates=shiftDates(b);const sd=b.shiftData||{};
  let tonnes=0,area=0,filled=0;const byType=new Map();
  dates.forEach(k=>{const ls=linesOf(sd[k]).filter(lineHas);if(!ls.length)return;filled++;
    const seen=new Set();
    ls.forEach(l=>{const t=num(l.tonnes),a=num(l.area);tonnes+=t;area+=a;
      const key=mixLabel(l);const g=byType.get(key)||{type:key,tonnes:0,area:0,shifts:0};
      g.tonnes+=t;g.area+=a;if(!seen.has(key)){g.shifts++;seen.add(key)}byType.set(key,g)})});
  const outside=Object.keys(sd).filter(k=>hasQty(sd[k])&&!dates.includes(k)).length;
  return {dates,tonnes,area,filled,outside,byType:[...byType.values()].sort((x,y)=>y.tonnes-x.tonnes)};
}
const rekeyShifts=(sd,dx)=>sd&&dx?Object.fromEntries(Object.entries(sd).map(([k,v])=>[iso(addDays(parse(k),dx)),v])):sd;

const COLS='grid-cols-[1fr_1fr_1fr_28px] sm:grid-cols-[1fr_92px_80px_88px_76px_28px]';
const SEAL_COLS='grid-cols-[1fr_1fr_28px] sm:grid-cols-[1fr_110px_100px_28px]';  /* seal: type, binder, area */
function AsphaltShifts({f,set,data}){
  /* list = company mixes + any new ones typed in this booking (so other lines can pick them straight away) */
  const myCrew=data.resources.find(r=>r.id===f.resourceId);const seal=isSealCrew(myCrew);
  const sealSet=new Set(sealTypesOf(data).map(x=>x.toLowerCase()));
  const MIXES=seal?[...new Set([...sealTypesOf(data),...linesTypes(f.shiftData)])]
    :[...new Set([...mixTypesOf(data),...linesTypes(f.shiftData)])].filter(t=>!sealSet.has(t.toLowerCase())||mixTypesOf(data).includes(t));  /* paving can't pick seal products */
  const BF=v=>binderForProduct(data,myCrew,v);
  const BINDS=seal?sealBindersOf(data):bindersOf(data);
  const CO=seal?SEAL_COLS:COLS;
  const tot=qtyTotals(f);
  const sd=f.shiftData||{};
  const night=f.shift==='night';
  const shown=k=>{const ls=linesOf(sd[k]);return ls.length?ls:[BLANK_LINE]};
  const put=(k,lines)=>set({shiftData:{...sd,[k]:{...shiftBase(sd[k]),lines}}});
  const setCrew=(k,id)=>{const q={...shiftBase(sd[k]),lines:linesOf(sd[k])};if(id)q.crewId=id;else delete q.crewId;set({shiftData:{...sd,[k]:q}})};
  const ownCrew=data.resources.find(r=>r.id===f.resourceId);
  const otherCrews=data.resources.filter(r=>r.type==='crew'&&r.id!==f.resourceId&&(!ownCrew||workKey(r.sub)===workKey(ownCrew.sub)));  /* same section only */
  const setExbin=(k,v)=>{const q={...shiftBase(sd[k]),lines:linesOf(sd[k])};if(v)q.exbin=v;else delete q.exbin;set({shiftData:{...sd,[k]:q}})};
  const crewRes=(data?.resources||[]).find(r=>r.id===f.resourceId);
  const plantDown=k=>usesPlant(crewRes)?plantMaintOn(data,data.blocks,k,f.shift||'day'):[];
  const setLine=(k,i,p)=>{const ls=shown(k).map(l=>({...l}));ls[i]={...BLANK_LINE,...ls[i],...p};put(k,ls)};
  const addLine=k=>put(k,[...shown(k).map(l=>({...l})),{...BLANK_LINE}]);
  const removeLine=(k,i)=>{const ls=shown(k).filter((_,j)=>j!==i);put(k,ls.length?ls:[{...BLANK_LINE}])};
  const first=tot.dates.find(k=>hasQty(sd[k]));
  const empties=tot.dates.filter(k=>!hasQty(sd[k]));
  const copyFirst=()=>{const src=linesOf(sd[first]);const next={...sd};empties.forEach(k=>{next[k]={...shiftBase(sd[k]),lines:src.map(l=>({...l}))}});set({shiftData:next})};
  const copyPrev=i=>{const p=tot.dates[i-1];if(p&&sd[p])put(tot.dates[i],linesOf(sd[p]).map(l=>({...l})))};
  const depthHint=l=>{const t=num(l.tonnes),a=num(l.area);return t&&a?Math.round(t/DEFAULT_DENSITY/a*1000):null};
  /* adding a shift moves the booking's end date to the next working day (Saturday / Sunday only when ticked) */
  const nextShift=()=>{if(!f.end||f.end<f.start)return null;let d=addDays(parse(f.end),1);for(let g=0;g<7&&!worksOn(f,d);g++)d=addDays(d,1);return d};
  const prevShiftEnd=()=>{const ds=tot.dates;if(ds.length<2)return null;return ds[ds.length-2]};
  const ns=nextShift(),pe=prevShiftEnd();
  const addShift=()=>{if(ns)set({end:iso(ns)})};
  const removeLastShift=()=>{if(pe)set({end:pe})};
  const inp='field field-sm mono';const ist={height:30,fontSize:13};

  return html`<section class="grid gap-3" aria-labelledby="sec-asphalt">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 id="sec-asphalt" class="font-display text-[15px] font-semibold">${seal?'Seal':'Asphalt'} & job quantities</h3>
      <span class="text-[12px] text-muted">${tot.dates.length} shift${tot.dates.length===1?'':'s'} · ${tot.filled} filled in</span>
      <span class="flex-1"></span>
      <span class="inline-flex items-center gap-3 text-[12.5px] text-muted" role="group" aria-label="Weekend shifts" title="Unticked weekend days are greyed out on the booking and get no shift">
        ${night&&html`<label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input id="ed-fri" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${friOn(f)} onChange=${e=>set({friShift:e.target.checked,satShift:satOn(f),sunShift:sunOn(f)})}/>
          Friday</label>`}
        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input id="ed-sat" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${satOn(f)} onChange=${e=>set({satShift:e.target.checked,sunShift:sunOn(f)})}/>
          Saturday</label>
        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input id="ed-sun" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${sunOn(f)} onChange=${e=>set({sunShift:e.target.checked,satShift:satOn(f)})}/>
          Sunday</label></span>
    </div>
    ${(f.offDays||[]).filter(k=>k>=f.start&&k<=f.end).length>0&&html`<div class="flex flex-wrap items-center gap-1.5 -mt-1 text-[12px]">
      <span class="text-muted">Days off:</span>
      ${(f.offDays||[]).filter(k=>k>=f.start&&k<=f.end).map(k=>html`<button key=${k} type="button" class="inline-flex items-center gap-1 rounded-md border border-line bg-sunken px-1.5 py-0.5 hover:text-ink"
        title="Make this day a shift again" onClick=${()=>{const o=(f.offDays||[]).filter(x=>x!==k);set({offDays:o.length?o:undefined})}}>${WD[parse(k).getDay()]} ${fmtShort(parse(k))} <span aria-hidden="true">×</span><span class="sr-only">make a shift again</span></button>`)}
    </div>`}

    <div class="rounded-xl border border-line bg-sunken p-3 grid gap-2.5">
      <div class="grid grid-cols-2 gap-3">
        ${!seal&&html`<div><div class="label">Total asphalt</div><div class="font-display text-[20px] font-semibold tnum">${fmtN(tot.tonnes)}<span class="text-[12px] text-muted font-normal"> t</span></div></div>`}
        <div><div class="label">Total area</div><div class="font-display text-[20px] font-semibold tnum">${fmtN(tot.area)}<span class="text-[12px] text-muted font-normal"> m²</span></div></div>
      </div>
      ${tot.byType.length>0&&html`<div class="flex flex-wrap gap-1.5">
        ${tot.byType.map(g=>html`<span key=${g.type} class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] bg-surface border border-line">
          <span class="font-semibold mono">${g.type}</span>
          <span class="text-muted tnum">${seal?'':`${fmtN(g.tonnes)} t · `}${fmtN(g.area)} m² · ${g.shifts} shift${g.shifts===1?'':'s'}</span></span>`)}
      </div>`}
    </div>

    ${tot.dates.length===0
      ?html`<div class="text-[12.5px] text-muted">${f.end<f.start?'Fix the dates above to see the shifts.':'This booking only covers weekend days. Tick Saturday or Sunday to enter quantities.'}</div>`
      :html`<div>
        ${first&&empties.length>0&&html`<div class="flex justify-end mb-1.5">
          <button type="button" class="text-[12px] font-medium underline underline-offset-2 text-muted hover:text-ink" onClick=${copyFirst}>Copy Shift ${tot.dates.indexOf(first)+1} to ${empties.length} empty shift${empties.length===1?'':'s'}</button></div>`}
        <div class="border border-line rounded-lg overflow-hidden">
          <div class="max-h-[340px] overflow-y-auto">
            <div class="hidden sm:grid grid-cols-[118px_1fr] gap-2 px-2.5 py-1.5 bg-sunken border-b border-line sticky top-0 z-[1]">
              <span class="label">Shift</span>
              <div class=${'grid gap-2 '+CO}><span class="label">${seal?'Seal type':'Asphalt type'}</span><span class="label">Binder</span>${!seal&&html`<span class="label">Tonnes</span>`}<span class="label">Area m²</span>${!seal&&html`<span class="label">Depth mm</span>`}<span></span></div>
            </div>
            ${tot.dates.map((k,i)=>{
              const ls=shown(k);const d=parse(k);
              const multi=ls.filter(lineHas).length>1;
              const sub=ls.reduce((a,l)=>({t:a.t+num(l.tonnes),a:a.a+num(l.area)}),{t:0,a:0});
              return html`<div key=${k} class="grid sm:grid-cols-[118px_1fr] gap-2 px-2.5 py-2.5 border-b border-line last:border-b-0">
                <div class="flex flex-wrap sm:flex-col sm:items-start items-center gap-x-2 gap-y-0.5 min-w-0">
                  <div class="text-[13px] font-semibold flex items-center gap-1">Shift ${i+1}${night&&html`<span class="inline-flex" style=${{color:'hsl(0 60% var(--blk-edge-l))'}} title="Night works">${Icon.moon}</span>`}</div>
                  <div class="text-[11.5px] text-muted mono">${WD[d.getDay()]} ${fmtShort(d)}</div>
                  ${(()=>{const down=plantDown(k);const ex=(sd[k]&&sd[k].exbin)||null;
                    return html`
                    ${down.length>0&&html`<div class="text-[11px] font-medium inline-flex items-center gap-1" style=${{color:ex?'var(--ok)':'hsl(0 65% var(--blk-edge-l))'}}
                      title=${`${down.join(', ')} under maintenance`}>${ex?'✓':Icon.alert} ${ex?'Plant down, exbin':'Plant maintenance'}</div>`}
                    <label class="inline-flex items-center gap-1.5 text-[12px] cursor-pointer mt-0.5">
                      <input id=${`sh-${k}-exbin`} type="checkbox" class="w-3.5 h-3.5" style=${{accentColor:'var(--accent)'}} checked=${!!ex}
                        onChange=${e=>setExbin(k,e.target.checked?{supplier:(ex&&ex.supplier)||EXBIN_SUPPLIERS[0]}:null)}/>
                      <span class=${ex?'font-semibold text-ink':'text-muted'}>Exbin</span></label>
                    ${ex&&html`<label class="w-full sm:w-auto"><span class="sr-only">Exbin supplier for shift ${i+1}</span>
                      <select id=${`sh-${k}-exbin-sup`} class="field field-sm w-[104px]" style=${{height:26,fontSize:12}} value=${ex.supplier||''} onChange=${e=>setExbin(k,{supplier:e.target.value})}>
                        ${EXBIN_SUPPLIERS.map(o=>html`<option key=${o} value=${o}>${o}</option>`)}
                        ${ex.supplier&&!EXBIN_SUPPLIERS.includes(ex.supplier)&&html`<option value=${ex.supplier}>${ex.supplier}</option>`}
                      </select></label>`}`})()}
                  ${otherCrews.length>0&&(()=>{const c=(sd[k]&&sd[k].crewId)||'';return html`<label class="w-full sm:w-auto grid gap-0.5 mt-0.5">
                    <span class=${'text-[11px] '+(c?'font-semibold text-ink':'text-muted')}>Done by</span>
                    <select id=${`sh-${k}-crew`} class="field field-sm w-[112px]" style=${{height:26,fontSize:12}} value=${c} onChange=${e=>setCrew(k,e.target.value)}
                      aria-label=${`Crew for shift ${i+1}`}>
                      <option value="">${data.resources.find(r=>r.id===f.resourceId)?.name||'This crew'}</option>
                      ${otherCrews.map(r=>html`<option key=${r.id} value=${r.id}>${r.name}</option>`)}
                      ${c&&!otherCrews.some(r=>r.id===c)&&html`<option value=${c}>Removed crew</option>`}
                    </select></label>`})()}
                  ${multi&&html`<div class="text-[11px] text-muted tnum">${seal?'':`${fmtN(sub.t)} t · `}${fmtN(sub.a)} m²</div>`}
                  ${i>0&&!hasQty(sd[k])&&hasQty(sd[tot.dates[i-1]])&&html`<button type="button" class="ml-auto sm:ml-0 text-[11px] text-muted underline underline-offset-2 hover:text-ink" onClick=${()=>copyPrev(i)} title="Copy the previous shift's figures">Same as above</button>`}
                </div>
                <div class="grid gap-1.5 min-w-0">
                  ${ls.map((l,j)=>{const h=depthHint(l);const n=ls.length>1?` line ${j+1}`:'';
                    return html`<div key=${j} class=${'grid gap-2 items-center '+CO}>
                      <div class="col-span-2 sm:col-span-1 flex items-center gap-1.5 min-w-0">
                      <label class="flex-1 min-w-0"><span class="sr-only">Shift ${i+1}${n} ${seal?'seal':'asphalt'} type</span>
                        ${l._custom
                          ?html`<div class="flex gap-1">
                              <input id=${`sh-${k}-${j}-type`} class="field field-sm" style=${ist} placeholder=${seal?'Type the seal':'Type the mix'} value=${l.type||''} autoFocus=${true} onInput=${e=>{const v=e.target.value,b=BF(v);setLine(k,j,b?{type:v,binder:b}:{type:v})}}/>
                              <button type="button" class="shrink-0 w-7 h-[30px] inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" title="Pick from the list" aria-label="Pick from the mix list"
                                onClick=${()=>setLine(k,j,{_custom:false,type:MIXES.includes(l.type)?l.type:''})}>${Icon.chevD}</button></div>`
                          :html`<select id=${`sh-${k}-${j}-type`} class="field field-sm mono" style=${{...ist,color:l.type?'var(--ink)':'var(--faint)'}} value=${l.type||''}
                              onChange=${e=>{const v=e.target.value;if(v==='__other'){setLine(k,j,{_custom:true,type:''});return}const b=BF(v);setLine(k,j,b?{type:v,binder:b}:{type:v})}}>
                              <option value="">${seal?'Seal':'Mix'}</option>
                              ${MIXES.map(t=>html`<option key=${t} value=${t} style=${{color:'var(--ink)'}}>${t}</option>`)}
                              ${l.type&&!MIXES.includes(l.type)&&html`<option value=${l.type} style=${{color:'var(--ink)'}}>${l.type}</option>`}
                              <option value="__other" style=${{color:'var(--ink)'}}>Other…</option>
                            </select>`}</label>
                      ${!seal&&(()=>{const rp=num((data?.mixRap||{})[(l.type||'').trim()]);const off=!rp&&!l.virgin;
                        return html`<label class=${'inline-flex items-center gap-1 shrink-0 text-[11.5px] '+(off?'opacity-40 cursor-not-allowed':'cursor-pointer')}
                          title=${off?'This mix has no RAP':l.virgin?`Virgin: the ${fmtN(rp)}% RAP is left off this line`:`Tick if this line is laid as virgin mix (no RAP)`}>
                          <input id=${`sh-${k}-${j}-virgin`} type="checkbox" class="w-3.5 h-3.5" style=${{accentColor:'var(--accent)'}} checked=${!!l.virgin} disabled=${off}
                            onChange=${e=>setLine(k,j,{virgin:e.target.checked})}/>
                          <span class=${l.virgin?'font-semibold text-ink':'text-muted'}>Virgin</span></label>`})()}
                      </div>
                      <label class="col-span-2 sm:col-span-1"><span class="sr-only">Shift ${i+1}${n} binder</span>
                        <select id=${`sh-${k}-${j}-b`} class="field field-sm mono" style=${{...ist,color:l.binder?'var(--ink)':'var(--faint)'}} value=${l.binder||''} onChange=${e=>setLine(k,j,{binder:e.target.value})}>
                          <option value="">Binder</option>
                          ${BINDS.map(b=>html`<option key=${b} value=${b} style=${{color:'var(--ink)'}}>${b}</option>`)}
                          ${l.binder&&!BINDS.includes(l.binder)&&html`<option value=${l.binder}>${l.binder}</option>`}
                        </select></label>
                      ${!seal&&html`<label><span class="sr-only">Shift ${i+1}${n} tonnes</span>
                        <input id=${`sh-${k}-${j}-t`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist} placeholder="t" value=${l.tonnes??''} onInput=${e=>setLine(k,j,{tonnes:e.target.value})}/></label>`}
                      <label><span class="sr-only">Shift ${i+1}${n} area in square metres</span>
                        <input id=${`sh-${k}-${j}-a`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist} placeholder="m²" value=${l.area??''} onInput=${e=>setLine(k,j,{area:e.target.value})}/></label>
                      ${!seal&&html`<label><span class="sr-only">Shift ${i+1}${n} depth in millimetres</span>
                        <input id=${`sh-${k}-${j}-d`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist}
                          placeholder=${h!=null?`${h} mm`:'mm'} title=${h!=null?`Works out at about ${h} mm from the tonnes and area (2.4 t/m³)`:'Compacted depth in mm'}
                          value=${l.depth??''} onInput=${e=>setLine(k,j,{depth:e.target.value})}/></label>`}
                      ${ls.length>1
                        ?html`<button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>removeLine(k,j)} aria-label=${`Remove shift ${i+1} line ${j+1}`} title="Remove this line">${Icon.x}</button>`
                        :html`<span></span>`}
                    </div>`;})}
                  <div><button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>addLine(k)}>${Icon.plus} Add another ${seal?'seal':'mix'}</button></div>
                </div>
              </div>`;})}
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 mt-2">
          <button type="button" class="btn" onClick=${addShift} disabled=${!ns}>${Icon.plus} Add shift${ns?html`<span class="text-muted font-normal"> · ${WD[ns.getDay()]} ${fmtShort(ns)}</span>`:''}</button>
          ${pe&&html`<button type="button" class="btn btn-ghost text-muted" onClick=${removeLastShift} title="Shorten the booking by its last shift. Figures already entered for it are kept.">Remove last shift</button>`}
          <span class="text-[11.5px] text-faint">Changes the booking's end date. The bar on the planner updates when you save.</span>
        </div>
      </div>`}
  </section>`;
}

/* ---------- booking editor (tabbed) ---------- */
/* Tabs are a list so more can be added later: give each an id, label, when it applies, and a render function. */
const BOOKING_TABS=[
  {id:'details',label:'Booking Details',applies:()=>true,render:p=>html`<${BookingDetails} ...${p}/>`},
  {id:'quantities',label:(f,d)=>isSealCrew(d.resources.find(r=>r.id===f.resourceId))?'Plant, Seal & Quantities':'Plant, Asphalt & Quantities',applies:f=>f.kind==='job',
    badge:(f,d)=>{const q=qtyTotals(f);if(isSealCrew(d.resources.find(r=>r.id===f.resourceId)))return q.area?`${fmtN(q.area)} m²`:null;return q.tonnes?`${fmtN(q.tonnes)} t`:null},
    render:p=>html`<div class="grid gap-6"><${PlantPicker} f=${p.f} set=${p.set} data=${p.data}/><div class="h-px bg-line"></div><${AsphaltShifts} f=${p.f} set=${p.set} data=${p.data}/></div>`},
  {id:'program',label:'Trucks & Subcontractors',applies:f=>f.kind==='job',
    badge:f=>{const n=Object.values(f.shiftData||{}).reduce((a,q)=>a+((q&&q.trucks)||[]).filter(truckHas).length,0);return n?`${n}`:null},
    render:p=>html`<${ProgramShifts} f=${p.f} set=${p.set} data=${p.data}/>`},
];

function Section({title,id,children,aside}){
  return html`<section class="grid gap-3" aria-labelledby=${id}>
    <div class="flex items-baseline gap-3"><h3 id=${id} class="font-display text-[15px] font-semibold">${title}</h3><span class="flex-1"></span>${aside}</div>
    ${children}
  </section>`;
}

function BookingDetails({f,set,data,rtype,err,changeRes}){
  return html`<div class="grid gap-6">
    <${Section} title="Assignment" id="sec-assign">
      <label class="grid gap-1"><span class="label">Crew, staff member or machine</span>
        <select id="ed-res" class="field" value=${f.resourceId} onChange=${e=>changeRes(e.target.value)}>
          ${orderOf(data).filter(t=>TYPES[t]).map(t=>html`<optgroup key=${t} label=${TYPES[t].label}>
            ${data.resources.filter(r=>r.type===t).map(r=>html`<option key=${r.id} value=${r.id}>${r.name} · ${r.sub}</option>`)}</optgroup>`)}
        </select></label>
      <div>
        <div class="label mb-1.5">Type</div>
        <div class="flex flex-wrap gap-1.5">
          ${kindsFor(rtype).map(k=>html`<button type="button" key=${k} aria-pressed=${f.kind===k}
            class="h-8 px-3 rounded-lg text-[13px] font-medium border"
            style=${f.kind===k?{...blockStyle({kind:k,resourceId:f.resourceId,shift:k==='job'?f.shift:undefined},data),borderColor:'transparent'}:{borderColor:'var(--line)',color:'var(--muted)',background:'var(--surface)'}}
            onClick=${()=>set({kind:k})}>${KINDS[k].label}</button>`)}
        </div>
      </div>
    <//>

    <${Section} title=${f.kind==='job'?'Job & site':'Details'} id="sec-job">
      ${f.kind==='job'
        ?html`<label class="grid gap-1"><span class="label">Customer</span>
            <input id="ed-customer" list="customer-list" class="field" placeholder="e.g. CMB, BMD"
              value=${f._customer??(f.jobId==='__new'?'':(data.jobs.find(j=>j.id===(f.jobId||data.jobs[0]?.id))?.customer||''))} onInput=${e=>set({_customer:e.target.value})}/>
            <datalist id="customer-list">${[...new Set(data.jobs.map(j=>(j.customer||'').trim()).filter(Boolean))].sort().map(c=>html`<option key=${c} value=${c}></option>`)}</datalist>
            <span class="text-[11.5px] text-faint">Saved to the job below, so every booking for that job shows the same customer.</span></label>
          <label class="grid gap-1"><span class="label">Job</span>
            <select id="ed-job" class="field" value=${f.jobId||data.jobs[0]?.id||'__new'} onChange=${e=>{
                const v=e.target.value;
                if(v==='__new'){set({jobId:'__new',_newJobName:'',_customer:f._customer??'',address:''});return}
                const old=data.jobs.find(j=>j.id===(f.jobId||data.jobs[0]?.id)),nj=data.jobs.find(j=>j.id===v);
                set({jobId:v,_customer:undefined,address:(!f.address||f.address===old?.address)?(nj?.address||''):f.address})}}>
              ${data.jobs.filter(j=>!j.completed||j.id===f.jobId).map(j=>html`<option key=${j.id} value=${j.id}>${j.name}${j.completed?' (completed)':''}</option>`)}
              <option value="__new">+ New job…</option>
            </select></label>
          ${f.jobId==='__new'&&html`<label class="grid gap-1"><span class="label">New job name</span>
            <input id="ed-new-job" class="field" placeholder="e.g. Duntroon St resheet" value=${f._newJobName||''} autoFocus=${true} onInput=${e=>set({_newJobName:e.target.value})}/>
            <span class="text-[11.5px] text-faint">Added to the Jobs list when you save, with the customer and address on this booking.</span></label>`}

          <div class="grid grid-cols-2 gap-3">
            <label class="grid gap-1"><span class="label">Quote number</span>
              <input id="ed-quote" class="field mono" placeholder="e.g. 260271" value=${f.quoteNo||''} onInput=${e=>set({quoteNo:e.target.value})}/></label>
            <label class="grid gap-1"><span class="label">Project number</span>
              <input id="ed-project" class="field mono" placeholder="e.g. 402313" value=${f.projectNo??(data.jobs.find(j=>j.id===f.jobId)?.projectNo||'')} onInput=${e=>set({projectNo:e.target.value})}/></label>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label class="grid gap-1"><span class="label">Supervisor</span>
              <input id="ed-super" class="field" list="dl-staff" placeholder="Name" value=${f.supervisor||''} onInput=${e=>set({supervisor:e.target.value})}/></label>
            <label class="grid gap-1"><span class="label">Site contact</span>
              <input id="ed-contact" class="field" placeholder="Name" value=${f.siteContact||''} onInput=${e=>set({siteContact:e.target.value})}/></label>
            <label class="grid gap-1"><span class="label">Contact phone</span>
              <input id="ed-phone" class="field mono" type="tel" placeholder="04xx xxx xxx" value=${f.sitePhone||''} onInput=${e=>set({sitePhone:e.target.value})}/></label>
            <datalist id="dl-staff">${data.resources.filter(r=>r.type==='person').map(p=>html`<option key=${p.id} value=${p.name}/>`)}</datalist>
          </div>
          <label class="grid gap-1"><span class="label">Site address</span>
            <input id="ed-address" class="field" placeholder="Street, suburb, postcode" value=${f.address||''} onInput=${e=>set({address:e.target.value})}/>
            <span class="text-[11.5px] text-faint">Shown on each piece of plant assigned in the Plant, Asphalt & Quantities tab.</span></label>
          <label class="grid gap-1"><span class="label">Notes</span>
            <textarea id="ed-notes" class="field" style=${{height:'auto',minHeight:60,padding:'8px 10px',resize:'vertical'}} rows="2" placeholder="Anything the crew or plant should know" value=${f.notes||''} onInput=${e=>set({notes:e.target.value})}></textarea></label>
          <div class="grid gap-1"><span class="label">Shift</span>
            <div class="seg w-max">
              <button type="button" aria-pressed=${(f.shift||'day')==='day'} onClick=${()=>set({shift:'day'})}>Day works</button>
              <button type="button" aria-pressed=${f.shift==='night'} onClick=${()=>set({shift:'night'})}>Night works</button>
            </div></div>`
        :html`<label class="grid gap-1"><span class="label">Note</span>
            <input id="ed-label" class="field" placeholder=${KINDS[f.kind].hint||(rtype==='machine'?'e.g. 500 hr service, hydraulic leak':KINDS[f.kind].label)} value=${f.title||''} onInput=${e=>set({title:e.target.value})}/></label>
          ${f.kind==='plantmaint'&&html`<div class="grid gap-1"><span class="label">Plant unavailable for</span>
            <div class="seg w-max">
              <button type="button" aria-pressed=${(f.maintShift||'both')==='both'} onClick=${()=>set({maintShift:'both'})}>Day & night</button>
              <button type="button" aria-pressed=${f.maintShift==='day'} onClick=${()=>set({maintShift:'day'})}>Day shift</button>
              <button type="button" aria-pressed=${f.maintShift==='night'} onClick=${()=>set({maintShift:'night'})}>Night shift</button>
            </div>
            <span class="text-[11.5px] text-faint">${(f.maintShift||'both')==='both'?'Jobs on both shifts these days are flagged.':f.maintShift==='day'?'The plant is available for night shifts. Only day shift jobs are flagged.':'The plant is available for day shifts. Only night shift jobs are flagged.'}</span></div>`}`}
      <div class="grid grid-cols-2 gap-3">
        <label class="grid gap-1"><span class="label">Starts</span><input id="ed-start" type="date" class="field mono" value=${f.start} onChange=${e=>set({start:e.target.value})} required/></label>
        <label class="grid gap-1"><span class="label">Ends</span><input id="ed-end" type="date" class="field mono" value=${f.end} onChange=${e=>set({end:e.target.value})} required/></label>
      </div>
      ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      ${f.kind==='job'&&!err&&usesPlant(data.resources.find(r=>r.id===f.resourceId))&&(()=>{
        const hits=[];for(let d=parse(f.start);iso(d)<=f.end;d=addDays(d,1)){const k=iso(d);const n=plantMaintOn(data,data.blocks,k,f.shift||'day');if(n.length&&!exbinOf(f,k))hits.push(`${WD[d.getDay()]} ${fmtShort(d)}`)}
        return hits.length?html`<div class="flex gap-2 items-start text-[12.5px] rounded-md px-3 py-2" role="alert" style=${{background:'hsl(0 75% var(--blk-l))',color:'hsl(0 60% var(--blk-fg-l))'}}>
          <span class="mt-0.5 inline-flex">${Icon.alert}</span>
          <span>Asphalt plant maintenance on ${hits.join(', ')}. Tick Exbin on those shifts in the Plant, Asphalt & Quantities tab if asphalt is coming from another supplier.</span></div>`:null})()}
      ${f.kind==='job'&&f.jobId&&f.jobId!=='__new'&&(()=>{
            const job=data.jobs.find(j=>j.id===f.jobId);if(!job)return null;
            const done=f._jobDone??!!job.completed;const today=iso(TODAY);
            const live=[...data.blocks.filter(b=>b.kind==='job'&&b.jobId===job.id&&b.id!==f.id),{...f,id:f.id||'this'}].filter(b=>b.end>=today);
            return html`<div class="grid gap-1.5 rounded-lg border px-3 py-2.5" style=${{borderColor:done?'var(--ok)':'var(--line)',background:done?'hsl(150 40% var(--blk-l))':'var(--sunken)'}}>
              <label class="flex items-center gap-2 text-[13px] font-medium cursor-pointer">
                <input id="ed-job-done" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--ok)'}} checked=${done} onChange=${e=>set({_jobDone:e.target.checked})}/>
                Job completed</label>
              <span class="text-[11.5px] text-muted">${done?'Moves the job to Completed in the Jobs list when you save. Untick to keep it active.':'Tick when the whole job is finished. It moves to Completed in the Jobs list.'}</span>
              ${done&&!job.completed&&live.length>0&&html`<div class="flex gap-2 items-start text-[12px] rounded-md px-2.5 py-2" role="alert" style=${{background:'hsl(40 85% var(--blk-l))',color:'hsl(35 70% var(--blk-fg-l))'}}>
                <span class="font-bold" aria-hidden="true">!</span>
                <span>This job still has ${live.length} booking${live.length===1?'':'s'} today or later${live.some(b=>b.id==='this'||b.id===f.id)?', including this one':''}. Completing it won't remove ${live.length===1?'it':'them'} from the planner.</span></div>`}
            </div>`;})()}
    <//>

  </div>`;
}

function Editor({initial,data,onSave,onDelete,onClose}){
  const [f,setF]=useState(initial);
  const [confirmDel,setConfirmDel]=useState(false);
  const isNew=!initial.id;
  const res=data.resources.find(r=>r.id===f.resourceId);
  const rtype=res?.type||'crew';
  const err=f.end<f.start?'End date is before the start date. Move the end date later.'
    :f.kind==='job'&&(f.jobId==='__new'||!data.jobs.length)&&!(f._newJobName||'').trim()?'Give the new job a name.'
    :f.kind==='job'&&f.jobId==='__new'&&data.jobs.some(j=>j.name.trim().toLowerCase()===(f._newJobName||'').trim().toLowerCase())?'There is already a job with that name. Pick it from the list.':'';
  const set=p=>setF(x=>({...x,...p}));
  useEffect(()=>{const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);
  const days=f.start&&f.end&&!err?diffDays(parse(f.start),parse(f.end))+1:0;
  const changeRes=id=>{const t=data.resources.find(r=>r.id===id)?.type;set({resourceId:id,kind:KINDS[f.kind].for===t?f.kind:TYPES[t].def})};
  const tabs=BOOKING_TABS.filter(t=>t.applies(f));
  const [tab,setTab]=useState(tabs[0].id);
  const active=tabs.find(t=>t.id===tab)||tabs[0];
  const submit=e=>{e.preventDefault();if(err)return;
    const out={...f,id:f.id||uid()};
    if(out.kind!=='job'){delete out.jobId;delete out.shift;delete out.address;delete out.plantIds}
    else{out.jobId=out.jobId||data.jobs[0]?.id||'__new';out.shift=out.shift||'day';out.plantIds=out.plantIds||[];out.address=(out.address||'').trim();out.quoteNo=(out.quoteNo||'').trim();if(!out.quoteNo)delete out.quoteNo;
      if(out.projectNo===undefined){const pj=data.jobs.find(j=>j.id===out.jobId)?.projectNo;if(pj)out.projectNo=pj}
      out.projectNo=(out.projectNo||'').trim();if(!out.projectNo)delete out.projectNo;out.notes=(out.notes||'').trim();if(!out.notes)delete out.notes;
      ['supervisor','siteContact','sitePhone'].forEach(k=>{out[k]=(out[k]||'').trim();if(!out[k])delete out[k]})}
    /* keep every shift's figures (including dates now outside the range); drop only fully empty rows */
    /* only mixes typed under "Other…" join the company list; removed mixes stay removed */
    const newMixes=[...new Set(Object.values(out.shiftData||{}).flatMap(q=>linesOf(q)).filter(l=>l._custom&&(l.type||'').trim()).map(l=>l.type.trim()))];
    if(out.shiftData){
      const clean=Object.fromEntries(Object.entries(out.shiftData).filter(([,q])=>hasQty(q)||progHas(q)||(q&&(q.exbin||(q.crewId&&q.crewId!==out.resourceId))))
        .map(([k,q])=>[k,{lines:linesOf(q).filter(lineHas).map(cleanLine),...(q&&q.exbin?{exbin:{supplier:q.exbin.supplier||''}}:{}),...(q&&q.crewId&&q.crewId!==out.resourceId?{crewId:q.crewId}:{}),...progClean(q)}]));
      if(Object.keys(clean).length)out.shiftData=clean;else delete out.shiftData;
    }
    let newJob=null;
    if(out.kind==='job'&&(f.jobId==='__new'||!data.jobs.length)){
      newJob={id:'j'+uid(),name:(f._newJobName||'').trim(),customer:(out._customer||'').trim(),address:(out.address||'').trim(),hue:JOB_HUES[data.jobs.length%JOB_HUES.length]};
      out.jobId=newJob.id;delete out._customer}
    let jobPatch=null;
    if(out.kind==='job'&&out.jobId!=='__new'){const pch={};
      if(out._customer!==undefined)pch.customer=out._customer.trim();
      if(out._jobDone!==undefined)pch.completed=!!out._jobDone;
      if(Object.keys(pch).length)jobPatch={id:out.jobId,...pch}}
    delete out._customer;delete out._newJobName;delete out._jobDone;
    onSave(out,newMixes,jobPatch,newJob)};
  const resName=res?res.name:'';
  const wide=f.kind==='job';
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <form class=${'panel pop w-full flex flex-col max-h-full overflow-hidden '+(wide?'max-w-[840px]':'max-w-[500px]')} onSubmit=${submit} role="dialog" aria-modal="true" aria-labelledby="ed-title">
      <div class="px-5 pt-5 border-b border-line">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div id="ed-title" class="font-display text-[18px] font-semibold">${isNew?'New booking':'Edit booking'}</div>
            <div class="text-muted text-[12.5px] truncate"><span class="mono">${days?`${days} day${days>1?'s':''}`:'—'}</span>${resName&&` · ${resName}`}${f.kind==='job'&&f.jobId?` · ${data.jobs.find(j=>j.id===f.jobId)?.name||''}`:''}</div>
          </div>
          <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
        </div>
        <div class="flex gap-5 mt-3 -mb-px overflow-x-auto" role="tablist" aria-label="Booking sections">
          ${tabs.map(t=>html`<button type="button" key=${t.id} role="tab" id=${'tab-'+t.id} aria-selected=${active.id===t.id} aria-controls=${'panel-'+t.id}
            class="py-2 text-[13.5px] font-medium whitespace-nowrap border-b-2 transition-colors"
            style=${active.id===t.id?{borderColor:'var(--accent)',color:'var(--ink)'}:{borderColor:'transparent',color:'var(--muted)'}}
            onClick=${()=>setTab(t.id)}>${typeof t.label==='function'?t.label(f,data):t.label}${t.badge&&t.badge(f,data)&&html`<span class="ml-1.5 mono text-[11px] px-1.5 py-0.5 rounded bg-sunken text-muted">${t.badge(f,data)}</span>`}</button>`)}
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-5" role="tabpanel" id=${'panel-'+active.id} aria-labelledby=${'tab-'+active.id}>
        ${active.render({f,set,data,rtype,err,changeRes})}
      </div>
      <div class="px-5 py-3 border-t border-line bg-sunken flex flex-wrap items-center gap-2">
        ${!isNew&&(confirmDel
          ?html`<span class="text-[13px] text-muted">Delete this booking?</span>
               <button type="button" class="btn" style=${{color:'var(--bad)'}} onClick=${()=>onDelete(f.id)}>Delete</button>
               <button type="button" class="btn btn-ghost" onClick=${()=>setConfirmDel(false)}>Keep</button>`
          :html`<button type="button" class="btn btn-ghost text-muted" onClick=${()=>setConfirmDel(true)}>Delete</button>`)}
        <div class="flex-1"></div>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="submit" class="btn btn-primary" disabled=${!!err}>${isNew?'Add booking':'Save'}</button>
      </div>
    </form>
  </div>`;
}

/* ---------- Excel export of paving tonnes ---------- */
const isPavingCrew=r=>r.type==='crew'&&workKey(r.sub).includes('pav');
/* every asphalt line laid by a paving crew on one date: [{b, l}] */
function pavingLinesOn(data,k){
  const pav=new Set(data.resources.filter(isPavingCrew).map(r=>r.id));
  return data.blocks.filter(b=>b.kind==='job'&&pav.has(b.resourceId)&&b.shiftData&&k>=b.start&&k<=b.end&&worksOn(b,parse(k)))
    .flatMap(b=>linesOf(b.shiftData[k]).filter(lineHas).map(l=>({b,l})));
}
function loadExcelJS(){
  if(window.ExcelJS)return Promise.resolve(window.ExcelJS);
  return new Promise((res,rej)=>{const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
    s.onload=()=>window.ExcelJS?res(window.ExcelJS):rej(new Error('ExcelJS missing'));
    s.onerror=()=>rej(new Error('Could not load the spreadsheet library'));document.head.appendChild(s)});
}
async function buildTonnesWorkbook(data,startKey,endKey){
  const ExcelJS=await loadExcelJS();
  const C={ink:'FF1F2329',muted:'FF5E636E',accent:'FFE0670F',line:'FFDADDE2',white:'FFFFFFFF',band:'FFF4F5F7'};
  const thin={style:'thin',color:{argb:C.line}};
  const box={top:thin,left:thin,bottom:thin,right:thin};
  const fill=c=>({type:'pattern',pattern:'solid',fgColor:{argb:c}});
  const T='#,##0.0;-#,##0.0;""';
  const order=mixTypesOf(data);
  const sortMix=(a,b)=>{const ia=order.indexOf(a.split(' · ')[0]),ib=order.indexOf(b.split(' · ')[0]);return (ia<0?99:ia)-(ib<0?99:ib)||a.localeCompare(b)};
  /* one row per day per project: tonnes summed by mix */
  const rows=[];
  for(let d=parse(startKey);iso(d)<=endKey;d=addDays(d,1)){const k=iso(d);
    const byJob=new Map();
    pavingLinesOn(data,k).forEach(({b,l})=>{const t=num(l.tonnes);if(!t)return;
      const jb=data.jobs.find(j=>j.id===b.jobId);const name=(jb?.customer?jb.customer+' – ':'')+(jb?.name||'Job');
      const m=byJob.get(name)||new Map();const mx=mixLabel(l);m.set(mx,(m.get(mx)||0)+t);byJob.set(name,m)});
    [...byJob.keys()].sort().forEach(name=>rows.push({k,name,mix:byJob.get(name)}));
  }
  const mixes=[...new Set(rows.flatMap(r=>[...r.mix.keys()]))].sort(sortMix);
  const nCols=2+mixes.length;
  const wb=new ExcelJS.Workbook();wb.creator='Crew & Plant Roster';wb.created=new Date();
  const ws=wb.addWorksheet('Paving tonnes',{views:[{state:'frozen',ySplit:4,xSplit:2}],
    pageSetup:{orientation:mixes.length>5?'landscape':'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0}});
  ws.mergeCells(1,1,1,Math.max(nCols,3));ws.mergeCells(2,1,2,Math.max(nCols,3));
  const a=ws.getCell(1,1);a.value='Paving tonnes by day';a.font={bold:true,size:16,color:{argb:C.ink}};ws.getRow(1).height=24;
  const s=ws.getCell(2,1);s.value=`${WD[parse(startKey).getDay()]} ${fmtShort(parse(startKey))} to ${WD[parse(endKey).getDay()]} ${fmtShort(parse(endKey))} ${parse(endKey).getFullYear()}`;s.font={size:10,color:{argb:C.muted}};
  const h=ws.getRow(4);h.values=['Date','Project',...mixes.map(m=>m+' (t)')];
  h.eachCell(c=>{c.font={bold:true,color:{argb:C.white},size:10};c.fill=fill(C.ink);c.alignment={vertical:'middle',horizontal:'center',wrapText:true};c.border=box});
  h.getCell(2).alignment={vertical:'middle',horizontal:'left'};h.height=30;
  let r=5,day=-1,prev=null;
  rows.forEach(x=>{
    if(x.k!==prev){day++;prev=x.k}
    const row=ws.getRow(r);const d=parse(x.k);
    const firstOfDay=r===5||rows[r-6].k!==x.k;
    row.values=[firstOfDay?new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())):null,x.name,...mixes.map(m=>x.mix.get(m)||null)];
    row.getCell(1).numFmt='ddd d mmm yyyy';
    for(let c=1;c<=nCols;c++){const cell=row.getCell(c);cell.border=box;if(day%2)cell.fill=fill(C.band);
      if(c>2){cell.numFmt=T;cell.alignment={horizontal:'center'}}}
    if(firstOfDay){row.getCell(1).font={bold:true};if(r>5)for(let c=1;c<=nCols;c++)row.getCell(c).border={...box,top:{style:'medium',color:{argb:C.ink}}}}
    r++;
  });
  if(!rows.length){ws.getCell(5,1).value='No paving tonnes entered for these dates.';ws.getCell(5,1).font={italic:true,color:{argb:C.muted}}}
  ws.getColumn(1).width=17;ws.getColumn(2).width=38;for(let c=3;c<=nCols;c++)ws.getColumn(c).width=14;
  const buf=await wb.xlsx.writeBuffer();
  return new Blob([buf]);
}

/* "Weekly Tonnages" workbook in the company's own layout: one sheet per week, Sunday day shift to Saturday night shift,
   Day/Night shift column pairs, stacked Project / Tonnes / Mix / Binder blocks, weekly total. */
async function buildWeeklyTonnagesWorkbook(data,startKey,endKey){
  const rapOf=mix=>num((data.mixRap||{})[mix]);
  const ExcelJS=await loadExcelJS();
  const wb=new ExcelJS.Workbook();wb.creator='Crew & Plant Roster';wb.created=new Date();
  const ARGB=h=>'FF'+h;
  const DAY_COL={0:'4472C4',1:'ED7D31',2:'FFC000',3:'70AD47',4:'C00000',5:'00B0F0',6:'7030A0'}; /* Sun..Sat header colours */
  const DAYNAMES=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const GREY='F2F2F2',NIGHT='FBB6AB',BLACK='000000';
  const med={style:'medium',color:{argb:'FF000000'}},thin={style:'thin',color:{argb:'FF000000'}};
  const fill=h=>({type:'pattern',pattern:'solid',fgColor:{argb:ARGB(h)}});
  const font=(sz,bold,color)=>({name:'Arial',size:sz,bold:!!bold,color:{argb:ARGB(color||'000000')}});
  /* style every cell of a range; draw a medium outline around it */
  const area=(ws,r1,c1,r2,c2,{f,fo,al,fmt,merge=true,outline=true,inner}={})=>{
    if(merge&&(r1!==r2||c1!==c2))ws.mergeCells(r1,c1,r2,c2);
    for(let r=r1;r<=r2;r++)for(let c=c1;c<=c2;c++){const cell=ws.getCell(r,c);
      if(f)cell.fill=fill(f);if(fo)cell.font=fo;if(al)cell.alignment=al;if(fmt)cell.numFmt=fmt;
      if(outline){const b={};if(r===r1)b.top=med;if(r===r2)b.bottom=med;if(c===c1)b.left=med;if(c===c2)b.right=med;
        if(inner){if(r!==r1&&!b.top)b.top=inner;if(c!==c1&&!b.left)b.left=inner}
        cell.border={...(cell.border||{}),...b}}}
    return ws.getCell(r1,c1);
  };
  const shortAddr=a=>(a||'').split(',')[0].trim();
  /* Sunday-start weeks touched by the chosen dates */
  const sundays=[];for(let d=addDays(parse(startKey),-parse(startKey).getDay());iso(d)<=endKey;d=addDays(d,7))sundays.push(iso(d));
  const entriesFor=(k,shift)=>{ /* one entry per project + mix + binder on this shift */
    const m=new Map();
    pavingLinesOn(data,k).filter(({b})=>(b.shift||'day')===shift).forEach(({b,l})=>{
      const job=data.jobs.find(j=>j.id===b.jobId);
      const key=[b.jobId,b.address,(l.type||'').trim(),l.binder||'',l.virgin?'v':''].join('|');
      const e=m.get(key)||{name:job?.customer||job?.name||'Job',loc:shortAddr(b.address)||job?.name||'',mix:(l.type||'').trim(),virgin:!!l.virgin,binder:l.binder||'',t:0};
      e.t+=num(l.tonnes);m.set(key,e)});
    return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name));
  };
  sundays.forEach(sun=>{
    const S=parse(sun);
    /* shift columns: day and night for each day, Sunday to Saturday */
    let shifts=[];
    for(let i=0;i<7;i++){const k=iso(addDays(S,i));
      shifts.push({k,dow:i,shift:'day'},{k,dow:i,shift:'night'})}
    shifts.forEach(s=>{s.entries=entriesFor(s.k,s.shift)});
    const nBlocks=Math.max(4,...shifts.map(s=>s.entries.length));
    const lastCol=2+shifts.length*2;
    const name=`Weekly Tonnages ${pad(S.getDate())}.${pad(S.getMonth()+1)}`;
    const ws=wb.addWorksheet(name,{pageSetup:{orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:1,horizontalCentered:true}});
    ws.getColumn(1).width=9;ws.getColumn(2).width=4.7;
    shifts.forEach((_,i)=>{ws.getColumn(3+i*2).width=12.7;ws.getColumn(4+i*2).width=15});
    for(let r=1;r<=6;r++)ws.getRow(r).height=12.75;
    /* title banner */
    const t=area(ws,1,1,6,lastCol,{f:'FFFFFF',fo:font(20),al:{horizontal:'center',vertical:'middle'}});
    t.value='Aggregate Weekly Totals';
    /* shift headers + dates */
    ws.getRow(7).height=27;
    area(ws,7,1,7,2,{f:GREY});area(ws,8,1,9,2,{f:GREY});
    shifts.forEach((s,i)=>{const c=3+i*2;
      const h=area(ws,7,c,7,c+1,{f:DAY_COL[s.dow],fo:font(12,true,'FFFFFF'),al:{horizontal:'center',vertical:'middle',wrapText:true}});
      h.value=`${DAYNAMES[s.dow]} ${s.shift==='day'?'Day':'Night'} Shift`;
      const d=area(ws,8,c,9,c+1,{f:s.shift==='night'?NIGHT:GREY,fo:font(10),al:{horizontal:'center',vertical:'middle'},fmt:'[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy'});
      const dd=parse(s.k);d.value=new Date(Date.UTC(dd.getFullYear(),dd.getMonth(),dd.getDate()));
    });
    /* Project / Tonnes / Mix / Binder blocks, a black bar after each */
    const tonneCells=[];let r=10;
    for(let b=0;b<nBlocks;b++){
      const labels=[['Project:',r,r+1],['Tonnes:',r+2,r+3],['Mix:',r+4,r+5],['Binder:',r+6,r+7]];
      area(ws,r,1,r+7,2,{merge:false,f:GREY});
      labels.forEach(([txt,a,z])=>{const c=area(ws,a,1,z,2,{f:GREY,fo:font(10,true),al:{horizontal:'center',vertical:'middle'},outline:false});c.value=txt});
      area(ws,r,1,r+7,2,{merge:false});
      shifts.forEach((s,i)=>{const c=3+i*2;const e=s.entries[b];const bg=s.shift==='night'?NIGHT:GREY;
        const p1=area(ws,r,c,r,c+1,{f:bg,fo:font(10),al:{horizontal:'center',vertical:'middle',shrinkToFit:true},outline:false});
        const p2=area(ws,r+1,c,r+1,c+1,{f:bg,fo:font(10),al:{horizontal:'center',vertical:'middle',shrinkToFit:true},outline:false});
        const tn=area(ws,r+2,c,r+3,c+1,{f:bg,fo:font(12,true),al:{horizontal:'center',vertical:'middle'},fmt:'0',outline:false});
        const mx=area(ws,r+4,c,r+5,c+1,{f:bg,fo:font(11),al:{horizontal:'center',vertical:'middle',shrinkToFit:true},outline:false});
        const bd=area(ws,r+6,c,r+7,c+1,{f:bg,fo:font(10),al:{horizontal:'center',vertical:'middle'},outline:false});
        area(ws,r,c,r+7,c+1,{merge:false});
        if(e){const rp=rapOf(e.mix);p1.value=e.name;p2.value=e.loc;tn.value=Math.round(e.t*10)/10;mx.value=e.mix+(rp&&!e.virgin?` ${fmtN(rp)}% RAP`:'');bd.value=e.binder}
        if(!s.ahead)tonneCells.push(ws.getCell(r+2,c).address);
      });
      ws.getRow(r+8).height=6;
      for(let c=1;c<=lastCol;c++){const cell=ws.getCell(r+8,c);cell.fill=fill(BLACK);cell.border={left:c===1?med:undefined,right:c===lastCol?med:undefined,top:med,bottom:med}}
      r+=9;
    }
    /* weekly total of every shift on the sheet */
    const tr=r+3;ws.getRow(tr).height=18;
    const lab=area(ws,tr,1,tr+1,2,{f:GREY,fo:font(11),al:{horizontal:'center',vertical:'middle'}});lab.value='Weekly Total:';
    const tot=area(ws,tr,3,tr+1,4,{f:GREY,fo:font(14,true),al:{horizontal:'center',vertical:'middle'},fmt:'0"T"'});
    const sum=shifts.filter(s=>!s.ahead).reduce((a,s)=>a+s.entries.reduce((x,e)=>x+e.t,0),0);
    tot.value={formula:`SUM(${tonneCells.join(',')})`,result:sum};
  });
  const buf=await wb.xlsx.writeBuffer();
  return new Blob([buf]);
}

function ExportDialog({data,onClose,notify}){
  /* weeks run Sunday day shift → Saturday night shift */
  const sundayOf=d=>addDays(d,-d.getDay());
  const [week,setWeek]=useState(iso(sundayOf(TODAY)));
  const [count,setCount]=useState(1);
  const [busy,setBusy]=useState(false);
  const [layout,setLayout]=useState('weekly');
  const [err,setErr]=useState('');
  const [dl,setDl]=useState(undefined);
  useEffect(()=>{let live=true;
    try{const p=window.claude?.use?.('downloads');if(p&&p.then)p.then(x=>{if(live)setDl(x)},()=>{if(live)setDl(null)});else setDl(null)}catch(e){setDl(null)}
    const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);
    return()=>{live=false;window.removeEventListener('keydown',h)}},[]);
  const from=week,lastSun=iso(addDays(parse(week),7*(count-1)));
  const to=iso(addDays(parse(lastSun),6));            /* Saturday of the last week */
  const step=n=>{setWeek(iso(addDays(parse(week),7*n)));setErr('')};
  const preview={t:0,n:0};
  for(let d=parse(from);iso(d)<=to;d=addDays(d,1))pavingLinesOn(data,iso(d)).forEach(({l})=>{preview.t+=num(l.tonnes);preview.n++});
  const longDate=k=>{const d=parse(k);return `${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]} ${fmtShort(d)} ${d.getFullYear()}`};
  const isThisWeek=week===iso(sundayOf(TODAY));
  const go=async()=>{
    if(!dl){setErr('Saving files isn’t available in this view. Open the roster in claude.ai to export.');return}
    setBusy(true);setErr('');
    try{
      let blob,fn;const sun=parse(week);
      if(layout==='weekly'){
        blob=await buildWeeklyTonnagesWorkbook(data,from,to);
        fn=`Weekly Tonnages ${pad(sun.getDate())}.${pad(sun.getMonth()+1)}.${sun.getFullYear()}${count>1?` (${count} weeks)`:''}.xlsx`;
      }else{
        blob=await buildTonnesWorkbook(data,from,to);
        fn=`Paving tonnes ${pad(sun.getDate())}.${pad(sun.getMonth()+1)}.${sun.getFullYear()}${count>1?` (${count} weeks)`:''}.xlsx`;
      }
      await dl.save({filename:fn,data:blob});
      notify('Excel file saved');onClose();
    }catch(e){
      const c=e&&e.code;
      setErr(c==='declined'?'Download cancelled.':c==='rate_limited'?'A save prompt is already open. Finish that one first.'
        :c?'Saving isn’t available in this view.':(e&&e.message)||'The file could not be built.');
    }finally{setBusy(false)}
  };
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full max-w-[440px] p-5 flex flex-col gap-4" role="dialog" aria-modal="true" aria-labelledby="ex-title">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div id="ex-title" class="font-display text-[18px] font-semibold">Export paving tonnes</div>
          <div class="text-muted text-[12.5px]">Pick the week to export. Weeks start with the Sunday day shift.</div>
        </div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
      </div>
      <div class="grid gap-1"><span class="label" id="ex-week-l">Week</span>
        <div class="flex items-center gap-2" role="group" aria-labelledby="ex-week-l">
          <button type="button" class="btn px-2" onClick=${()=>step(-1)} aria-label="Previous week">${Icon.chevL}</button>
          <div class="flex-1 min-w-0 text-center rounded-lg border border-line bg-sunken px-3 py-1.5">
            <div class="font-semibold text-[14px]">Week of ${longDate(week)}</div>
            <div class="text-[12px] text-muted">Sun ${fmtShort(parse(from))} day shift → Sat ${fmtShort(parse(to))} night shift</div>
          </div>
          <button type="button" class="btn px-2" onClick=${()=>step(1)} aria-label="Next week">${Icon.chevR}</button>
        </div>
        <div class="flex items-center justify-between gap-2 mt-1">
          <button type="button" class="text-[12px] underline underline-offset-2 text-muted hover:text-ink disabled:opacity-40 disabled:no-underline" disabled=${isThisWeek} onClick=${()=>setWeek(iso(sundayOf(TODAY)))}>This week</button>
          <label class="inline-flex items-center gap-2 text-[12.5px] text-muted">Weeks to export
            <select id="ex-count" class="field field-sm w-[64px]" style=${{height:28}} value=${count} onChange=${e=>setCount(Number(e.target.value))}>
              ${[1,2,3,4,6,8].map(n=>html`<option key=${n} value=${n}>${n}</option>`)}</select></label>
        </div>
      </div>
      <div class="grid gap-1"><span class="label">Layout</span>
        <div class="seg w-full">
          <button type="button" class="flex-1" aria-pressed=${layout==='weekly'} onClick=${()=>setLayout('weekly')}>Weekly Tonnages sheet</button>
          <button type="button" class="flex-1" aria-pressed=${layout==='daily'} onClick=${()=>setLayout('daily')}>Daily list</button>
        </div></div>
      <div class="rounded-lg bg-sunken border border-line px-3 py-2 text-[12.5px] text-muted">
        <span class="font-semibold text-ink tnum">${count} week${count===1?'':'s'}</span> ·
        <span class="tnum">${fmtN(preview.t)} t</span> across ${preview.n} line${preview.n===1?'':'s'} ·
        ${layout==='weekly'?html`one sheet per week`:html`one row per day per project`}</div>
      ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      ${dl===null&&!err&&html`<div class="text-[12.5px] text-muted">Saving files isn’t available in this view.</div>`}
      <div class="flex items-center gap-2 justify-end">
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="button" class="btn btn-primary" onClick=${go} disabled=${busy||dl===null}>${busy?'Building…':html`${Icon.download} Download Excel`}</button>
      </div>
    </div>
  </div>`;
}

/* ---------- 2-month view: monthly totals of booked work ---------- */
const MONTHS_LONG=['January','February','March','April','May','June','July','August','September','October','November','December'];
function monthTotals(data,y,m){
  const first=new Date(y,m,1,12),last=new Date(y,m+1,0,12);
  const fk=iso(first),lk=iso(last);
  const dates=[];for(let d=first;d<=last;d=addDays(d,1))dates.push(iso(d));
  const weekdays=dates.filter(k=>!isWeekend(parse(k)));
  /* every figure on the monthly card counts paving crews only */
  const crews=data.resources.filter(r=>r.type==='crew'&&isPavingCrew(r));
  const pavIds=new Set(crews.map(c=>c.id));
  const jobs=data.blocks.filter(b=>b.kind==='job'&&pavIds.has(b.resourceId)&&b.start<=lk&&b.end>=fk);
  const dayCount=c=>{const mine=jobs.filter(b=>b.resourceId===c.id);return weekdays.filter(k=>mine.some(b=>covers(b,k))).length};
  const allRows=crews.map(c=>({c,days:dayCount(c)}));
  const crewDays=allRows.reduce((a,x)=>a+x.days,0),capacity=weekdays.length*crews.length;
  const crewRows=allRows;
  let nights=0;jobs.filter(b=>b.shift==='night').forEach(b=>shiftDates(b).forEach(k=>{if(k>=fk&&k<=lk)nights++}));
  let tonnes=0,area=0,pav=0;const byMix=new Map();
  jobs.forEach(b=>{if(!b.shiftData)return;shiftDates(b).forEach(k=>{if(k<fk||k>lk)return;
    linesOf(b.shiftData[k]).filter(lineHas).forEach(l=>{const t=num(l.tonnes);tonnes+=t;area+=num(l.area);if(pavIds.has(b.resourceId))pav+=t;
      if(t){const mx=mixLabel(l);byMix.set(mx,(byMix.get(mx)||0)+t)}})})});
  const jobIds=new Set(jobs.map(b=>b.jobId));
  const leave=data.resources.filter(r=>r.type==='person').reduce((a,p)=>a+weekdays.filter(k=>data.blocks.some(b=>b.resourceId===p.id&&covers(b,k)&&KINDS[b.kind].away)).length,0);
  const down=data.resources.filter(r=>r.type==='machine').reduce((a,mc)=>a+dates.filter(k=>data.blocks.some(b=>b.resourceId===mc.id&&covers(b,k)&&KINDS[b.kind].down)).length,0);
  return {label:`${MONTHS_LONG[m]} ${y}`,crewRows,crewDays,capacity,util:capacity?crewDays/capacity:0,nights,tonnes,pav,area,
    jobs:jobIds.size,bookings:jobs.length,leave,down,mixes:[...byMix].sort((a,b)=>b[1]-a[1]),workdays:weekdays.length};
}
function MonthTotals({data,months:mlist}){
  const months=mlist.map(([y,m])=>y*12+m);
  return html`<section class="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label="Monthly totals">
    ${months.map(k=>{const y=Math.floor(k/12),m=k%12;const t=monthTotals(data,y,m);const pct=Math.round(t.util*100);
      const tone=pct>=85?'var(--warn)':pct>=50?'var(--ok)':'var(--faint)';
      return html`<div key=${k} class="panel px-4 py-3 grid gap-3">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="font-display text-[16px] font-semibold">${t.label}</h2>
          <span class="text-[12px] text-muted tnum">Paving · ${t.workdays} working days · ${t.bookings} booking${t.bookings===1?'':'s'}</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
          <div><div class="label">Paving crew-days</div>
            <div class="font-display text-[20px] font-semibold tnum">${t.crewDays}<span class="text-[12px] text-muted font-normal"> / ${t.capacity}</span></div>
            <div class="h-1 rounded-full bg-line overflow-hidden mt-1"><div class="h-full rounded-full" style=${{width:pct+'%',background:tone}}></div></div>
            <div class="text-[11.5px] mt-0.5 tnum" style=${{color:tone}}>${pct}% booked</div></div>
          <div><div class="label">Paving tonnes</div>
            <div class="font-display text-[20px] font-semibold tnum">${fmtN(Math.round(t.tonnes))}<span class="text-[12px] text-muted font-normal"> t</span></div></div>
          <div><div class="label">Paving jobs</div>
            <div class="font-display text-[20px] font-semibold tnum">${t.jobs}</div>
            <div class="text-[11.5px] text-muted tnum">${t.nights} night shift${t.nights===1?'':'s'}</div></div>
        </div>
        <div class="grid sm:grid-cols-2 gap-x-5 gap-y-2">
          <div class="grid gap-1">
            <div class="label">Days booked per paving crew</div>
            ${t.crewRows.length===0&&html`<span class="text-[12px] text-muted">No crews with the type of work Paving.</span>`}
            ${t.crewRows.map(({c,days})=>html`<div key=${c.id} class="flex items-center gap-2 text-[12px]">
              <span class="w-[64px] truncate" title=${c.name+' · '+c.sub}>${c.name}</span>
              <div class="flex-1 h-2 rounded-full bg-line overflow-hidden"><div class="h-full rounded-full" style=${{width:(t.workdays?days/t.workdays*100:0)+'%',background:`hsl(${c.hue} 62% var(--blk-edge-l))`}}></div></div>
              <span class="mono text-[11.5px] text-muted w-[42px] text-right">${days}/${t.workdays}</span></div>`)}
          </div>
          <div class="grid gap-1 content-start">
            <div class="label">Paving tonnes by mix</div>
            ${t.mixes.length
              ?html`<div class="flex flex-wrap gap-1">${t.mixes.map(([mx,v])=>html`<span key=${mx} class="mono text-[11px] px-1.5 py-0.5 rounded bg-sunken border border-line">${mx} · ${fmtN(Math.round(v))} t</span>`)}</div>`
              :html`<span class="text-[12px] text-muted">No tonnes entered yet.</span>`}
            <div class="text-[11.5px] text-muted mt-1 tnum">${t.leave} staff leave day${t.leave===1?'':'s'} · ${t.down} machine down day${t.down===1?'':'s'}</div>
          </div>
        </div>
      </div>`;})}
  </section>`;
}

/* ---------- Forecast: paving totals for two months, with Excel export ---------- */
function forecastJobs(data,y,m){ /* paving jobs worked in a month: crews, booked weekdays, tonnes */
  const fk=iso(new Date(y,m,1,12)),lk=iso(new Date(y,m+1,0,12));
  const pav=new Set(data.resources.filter(isPavingCrew).map(c=>c.id));
  const byJob=new Map();
  data.blocks.filter(b=>b.kind==='job'&&pav.has(b.resourceId)&&b.start<=lk&&b.end>=fk).forEach(b=>{
    const j=data.jobs.find(x=>x.id===b.jobId);const e=byJob.get(b.jobId)||{job:j,crews:new Set(),days:0,nights:0,t:0,a:0,first:null,last:null};
    e.crews.add(data.resources.find(r=>r.id===b.resourceId)?.name||'');
    for(let d=parse(b.start>fk?b.start:fk);iso(d)<=(b.end<lk?b.end:lk);d=addDays(d,1)){const k=iso(d);
      if(worksOn(b,d)){e.days++;if(b.shift==='night')e.nights++}
      if(!e.first||k<e.first)e.first=k;if(!e.last||k>e.last)e.last=k}
    shiftDates(b).forEach(k=>{if(k<fk||k>lk||!b.shiftData)return;linesOf(b.shiftData[k]).filter(lineHas).forEach(l=>{e.t+=num(l.tonnes);e.a+=num(l.area)})});
    byJob.set(b.jobId,e)});
  return [...byJob.values()].sort((a,b)=>(a.first||'').localeCompare(b.first||''));
}
async function buildForecastWorkbook(data,months){
  const ExcelJS=await loadExcelJS();
  const C={ink:'FF1F2329',muted:'FF5E636E',accent:'FFE0670F',soft:'FFFDEBDB',line:'FFDADDE2',white:'FFFFFFFF',band:'FFF4F5F7',ok:'FF2F855A'};
  const thin={style:'thin',color:{argb:C.line}};const box={top:thin,left:thin,bottom:thin,right:thin};
  const fill=c=>({type:'pattern',pattern:'solid',fgColor:{argb:c}});
  const wb=new ExcelJS.Workbook();wb.creator='Crew & Plant Roster';wb.created=new Date();
  const T=months.map(([y,m])=>monthTotals(data,y,m));
  const span=`${T[0].label} – ${T[T.length-1].label}`;
  const title=(ws,text,n)=>{ws.mergeCells(1,1,1,n);ws.mergeCells(2,1,2,n);
    const a=ws.getCell(1,1);a.value=text;a.font={bold:true,size:16,color:{argb:C.ink}};ws.getRow(1).height=24;
    const b=ws.getCell(2,1);b.value=`${span}  ·  paving crews only  ·  exported ${fmtShort(TODAY)} ${TODAY.getFullYear()}`;b.font={size:10,color:{argb:C.muted}};
    for(let c=1;c<=n;c++)ws.getCell(3,c).border={top:{style:'medium',color:{argb:C.accent}}}};
  const head=(row)=>{row.eachCell(c=>{c.font={bold:true,color:{argb:C.white},size:10};c.fill=fill(C.ink);c.alignment={vertical:'middle',horizontal:'center',wrapText:true};c.border=box});row.getCell(1).alignment={vertical:'middle',horizontal:'left'};row.height=24};
  const section=(ws,r,text,n)=>{ws.mergeCells(r,1,r,n);const c=ws.getCell(r,1);c.value=text;c.font={bold:true,size:11,color:{argb:C.ink}};c.fill=fill(C.soft);c.border={bottom:{style:'thin',color:{argb:C.accent}}};ws.getRow(r).height=20};
  const n=1+T.length;

  /* Summary: metrics down, months across */
  const ws=wb.addWorksheet('Forecast',{views:[{state:'frozen',ySplit:4,xSplit:1}],pageSetup:{orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0}});
  title(ws,'Paving forecast',n);
  const h=ws.getRow(4);h.values=['',...T.map(t=>t.label)];head(h);
  let r=5;
  const metric=(label,vals,fmt,bold)=>{const row=ws.getRow(r);row.values=[label,...vals];
    row.eachCell({includeEmpty:true},(c,i)=>{c.border=box;if(i>1){c.numFmt=fmt;c.alignment={horizontal:'center'}}if(bold)c.font={bold:true}});r++};
  section(ws,r++,'Booked work',n);
  metric('Working days',T.map(t=>t.workdays),'0');
  metric('Paving crew-days booked',T.map(t=>t.crewDays),'0');
  metric('Paving crew-days available',T.map(t=>t.capacity),'0');
  metric('Booked',T.map(t=>t.util),'0%');
  metric('Night shifts',T.map(t=>t.nights),'0');
  r++;section(ws,r++,'Asphalt',n);
  metric('Paving tonnes',T.map(t=>Math.round(t.tonnes*10)/10),'#,##0.0');
  r++;section(ws,r++,'Days booked per paving crew',n);
  const crewNames=[...new Set(T.flatMap(t=>t.crewRows.map(x=>x.c.name)))];
  crewNames.forEach(nm=>metric(nm,T.map(t=>t.crewRows.find(x=>x.c.name===nm)?.days||0),'0'));
  r++;section(ws,r++,'Paving tonnes by mix',n);
  const mixes=[...new Set(T.flatMap(t=>t.mixes.map(([k])=>k)))];
  if(!mixes.length){ws.getCell(r,1).value='No tonnes entered yet.';ws.getCell(r,1).font={italic:true,color:{argb:C.muted}};r++}
  mixes.forEach(mx=>metric(mx,T.map(t=>Math.round((t.mixes.find(([k])=>k===mx)?.[1]||0)*10)/10),'#,##0.0;-#,##0.0;"–"'));
  ws.getColumn(1).width=32;for(let c=2;c<=n;c++)ws.getColumn(c).width=18;

  /* Jobs: every paving job in each month */
  const js=wb.addWorksheet('Paving jobs',{views:[{state:'frozen',ySplit:4}],pageSetup:{orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0}});
  title(js,'Paving jobs',9);
  const jh=js.getRow(4);jh.values=['Month','Customer','Job','Site address','Crews','First day','Last day','Booked days','Tonnes'];head(jh);
  let jr=5;
  months.forEach(([y,m],mi)=>{
    forecastJobs(data,y,m).forEach(e=>{const row=js.getRow(jr);
      const d=k=>{const x=parse(k);return new Date(Date.UTC(x.getFullYear(),x.getMonth(),x.getDate()))};
      row.values=[T[mi].label,e.job?.customer||'',e.job?.name||'Job',e.job?.address||'',[...e.crews].join(', '),d(e.first),d(e.last),e.days,Math.round(e.t*10)/10];
      row.getCell(6).numFmt='ddd d mmm';row.getCell(7).numFmt='ddd d mmm';row.getCell(9).numFmt='#,##0.0;-#,##0.0;"–"';
      row.eachCell({includeEmpty:true},(c,i)=>{c.border=box;if(mi%2)c.fill=fill(C.band);if(i>=6)c.alignment={horizontal:'center'}});
      if(e.nights)row.getCell(8).note=`${e.nights} night shift${e.nights===1?'':'s'}`;
      jr++});
  });
  if(jr===5){js.getCell(5,1).value='No paving jobs booked in these months.';js.getCell(5,1).font={italic:true,color:{argb:C.muted}}}
  else{js.autoFilter={from:{row:4,column:1},to:{row:jr-1,column:9}};
    const t=js.getRow(jr);t.values=['Total','','','','','','',{formula:`SUM(H5:H${jr-1})`},{formula:`SUM(I5:I${jr-1})`}];
    t.eachCell({includeEmpty:true},(c,i)=>{c.font={bold:true};c.fill=fill(C.soft);c.border={...box,top:{style:'medium',color:{argb:C.accent}}};if(i===9)c.numFmt='#,##0.0';if(i>=8)c.alignment={horizontal:'center'}})}
  [16,18,34,36,20,12,12,12,12].forEach((w,i)=>js.getColumn(i+1).width=w);
  const buf=await wb.xlsx.writeBuffer();return new Blob([buf]);
}
function ForecastDialog({data,onClose,notify}){
  const [start,setStart]=useState(TODAY.getFullYear()*12+TODAY.getMonth());
  const months=[0,1].map(i=>{const k=start+i;return [Math.floor(k/12),k%12]});
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [dl,setDl]=useState(undefined);
  useEffect(()=>{let live=true;
    try{const p=window.claude?.use?.('downloads');if(p&&p.then)p.then(x=>{if(live)setDl(x)},()=>{if(live)setDl(null)});else setDl(null)}catch(e){setDl(null)}
    const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);
    return()=>{live=false;window.removeEventListener('keydown',h)}},[]);
  const label=([y,m])=>`${MONTHS_LONG[m]} ${y}`;
  const isNow=start===TODAY.getFullYear()*12+TODAY.getMonth();
  /* export picker: any run of months, up to 12 */
  const [pick,setPick]=useState(null); /* {from,to} as year*12+month */
  const nowK=TODAY.getFullYear()*12+TODAY.getMonth();
  const monthOpts=Array.from({length:30},(_,i)=>nowK-6+i);
  const kLabel=k=>`${MONTHS_LONG[k%12]} ${Math.floor(k/12)}`;
  const pickCount=pick?pick.to-pick.from+1:0;
  const exportX=async()=>{
    if(!dl){setErr('Saving files isn’t available in this view. Open the roster in claude.ai to export.');return}
    if(!pick||pickCount<1||pickCount>12)return;
    const ms=Array.from({length:pickCount},(_,i)=>{const k=pick.from+i;return [Math.floor(k/12),k%12]});
    setBusy(true);setErr('');
    try{const blob=await buildForecastWorkbook(data,ms);
      const a=ms[0],b=ms[ms.length-1];
      const nm=ms.length===1?`${MONTHS_LONG[a[1]].slice(0,3)} ${a[0]}`:`${MONTHS_LONG[a[1]].slice(0,3)}${a[0]!==b[0]?' '+a[0]:''}–${MONTHS_LONG[b[1]].slice(0,3)} ${b[0]}`;
      await dl.save({filename:`Paving forecast ${nm}.xlsx`,data:blob});
      notify('Forecast saved');setPick(null)}
    catch(e){const c=e&&e.code;setErr(c==='declined'?'Download cancelled.':c==='rate_limited'?'A save prompt is already open. Finish that one first.':c?'Saving isn’t available in this view.':(e&&e.message)||'The file could not be built.')}
    finally{setBusy(false)}};
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full max-w-[1000px] flex flex-col max-h-full overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="fc-title">
      <div class="px-5 pt-5 pb-3 border-b border-line flex flex-wrap items-center gap-3">
        <div class="min-w-0 mr-auto">
          <div id="fc-title" class="font-display text-[19px] font-semibold">Forecast</div>
          <div class="text-[12.5px] text-muted">Paving crews' booked work for ${label(months[0])} and ${label(months[1])}</div>
        </div>
        <div class="flex items-center gap-1">
          <button type="button" class="btn px-2" onClick=${()=>setStart(s=>s-1)} aria-label="Earlier month">${Icon.chevL}</button>
          <button type="button" class="btn" onClick=${()=>setStart(TODAY.getFullYear()*12+TODAY.getMonth())} disabled=${isNow}>This month</button>
          <button type="button" class="btn px-2" onClick=${()=>setStart(s=>s+1)} aria-label="Later month">${Icon.chevR}</button>
        </div>
        <button type="button" class="btn btn-primary" onClick=${()=>{setErr('');setPick(p=>p?null:{from:start,to:start+1})}} aria-expanded=${!!pick} disabled=${dl===null}>${Icon.download} Export to Excel</button>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
      </div>
      ${pick&&html`<div class="px-5 py-3 border-b border-line bg-accent-soft flex flex-wrap items-end gap-3">
        <label class="grid gap-1"><span class="label">From</span>
          <select id="fc-from" class="field w-[170px]" value=${pick.from} onChange=${e=>{const v=Number(e.target.value);setPick(p=>({from:v,to:Math.max(v,Math.min(p.to,v+11))}))}}>
            ${monthOpts.map(k=>html`<option key=${k} value=${k}>${kLabel(k)}</option>`)}</select></label>
        <label class="grid gap-1"><span class="label">To</span>
          <select id="fc-to" class="field w-[170px]" value=${pick.to} onChange=${e=>{const v=Number(e.target.value);setPick(p=>({to:v,from:Math.min(v,Math.max(p.from,v-11))}))}}>
            ${monthOpts.map(k=>html`<option key=${k} value=${k}>${kLabel(k)}</option>`)}</select></label>
        <div class="text-[12.5px] text-muted pb-2">${pickCount} month${pickCount===1?'':'s'} · one column per month</div>
        <div class="flex gap-2 ml-auto">
          <button type="button" class="btn" onClick=${()=>setPick(null)}>Cancel</button>
          <button type="button" class="btn btn-primary" onClick=${exportX} disabled=${busy||pickCount<1}>${busy?'Building…':'Download'}</button>
        </div>
      </div>`}
      ${(err||dl===null)&&html`<div class="px-5 pt-3 text-[12.5px]" style=${{color:err?'var(--bad)':'var(--muted)'}}>${err||'Saving files isn’t available in this view.'}</div>`}
      <div class="flex-1 min-h-0 overflow-y-auto p-5 bg-sunken">
        <${MonthTotals} data=${data} months=${months}/>
      </div>
    </div>
  </div>`;
}

/* ---------- quote change notifications (last 48 hours) ---------- */
const DAY_MS=864e5;
const NOTIF_MS=2*DAY_MS; /* notifications stay for 48 hours */
/* kinds of notification a person can switch on or off (kept per person in this browser) */
const NOTIF_TYPES=[{id:'quote',label:'Quote number changes',desc:'When a booking\'s quote number is added, changed or removed.'},
  {id:'booking',label:'Bookings',desc:'Bookings added, moved, changed or deleted.'},
  {id:'job',label:'Jobs',desc:'Jobs added, changed, completed or deleted.'},
  {id:'resource',label:'Crews, staff, machines & plants',desc:'Added, renamed or removed.'},
  {id:'lists',label:'Mixes & seal lists',desc:'Mix, seal and binder lists edited.'}];
const NOTIF_KEY=KEY+':notif-prefs';
const NOTIF_DEFAULT={quote:false,booking:false,job:false,resource:false,lists:false}; /* all off until a person turns them on */
const loadNotifPrefs=()=>{try{return {...NOTIF_DEFAULT,...JSON.parse(localStorage.getItem(NOTIF_KEY)||'{}')}}catch(e){return {...NOTIF_DEFAULT}}};
const recentQuoteChanges=data=>(data.quoteChanges||[]).filter(c=>Date.now()-c.at<NOTIF_MS).sort((a,b)=>b.at-a.at);
const agoText=t=>{const m=Math.round((Date.now()-t)/6e4);if(m<1)return 'just now';if(m<60)return `${m} min ago`;const h=Math.round(m/60);return `${h} hr${h===1?'':'s'} ago`};
/* ---------- change log: every change to the shared roster becomes a notification ---------- */
const CHANGE_KEEP=7*DAY_MS;
const LIST_SETTINGS=[['truckCos','Trucks'],['subCos','Subcontractors'],['mixTypes','Mixes'],['binders','Binders'],['mixRap','Mix RAP %'],['mixBinder','Mix default binders'],['sealTypes','Seal types'],['sealBinders','Seal binders'],['sealBinder','Seal default binders']];
const RES_WORD={crew:'Crew',person:'Staff member',machine:'Machine',aplant:'Plant'};
/* exactly what changed on one booking, as "Field: before → after" lines */
function bookingDiff(a,b,p,x,rname,jname,when){
  const L=[];const same=(u,v)=>JSON.stringify(u)===JSON.stringify(v);
  const cut=t=>{t=String(t||'').replace(/\s+/g,' ').trim();return t.length>60?t.slice(0,60)+'…':t};
  const ch=(label,u,v)=>L.push(`${label}: ${u===''||u==null?'(none)':u} → ${v===''||v==null?'(none)':v}`);
  if(p.kind!==x.kind)ch('Type',KINDS[p.kind]?.label||p.kind,KINDS[x.kind]?.label||x.kind);
  if(p.resourceId!==x.resourceId)ch('Crew',rname(a,p.resourceId),rname(b,x.resourceId));
  if(p.start!==x.start||p.end!==x.end)ch('Dates',when(p),when(x));
  if((p.shift||'day')!==(x.shift||'day'))ch('Shift',p.shift==='night'?'Night':'Day',x.shift==='night'?'Night':'Day');
  if(p.jobId!==x.jobId)ch('Job',jname(a,p.jobId),jname(b,x.jobId));
  [['address','Site address'],['projectNo','Project number'],['quoteNo','Quote number'],['supervisor','Supervisor'],['siteContact','Site contact'],['sitePhone','Contact phone'],['title','Label'],['maintShift','Maintenance shift'],['notes','Notes']]
    .forEach(([f,l])=>{if((p[f]||'')!==(x[f]||''))ch(l,cut(p[f]),cut(x[f]))});
  const pa=p.plantIds||[],pb=x.plantIds||[];
  const add=pb.filter(i=>!pa.includes(i)).map(i=>rname(b,i)),rem=pa.filter(i=>!pb.includes(i)).map(i=>rname(a,i));
  if(add.length)L.push(`Mobile plant added: ${add.join(', ')}`);if(rem.length)L.push(`Mobile plant removed: ${rem.join(', ')}`);
  [['Friday',friOn],['Saturday',satOn],['Sunday',sunOn]].forEach(([l,fn])=>{if(fn(p)!==fn(x))ch(l,fn(p)?'shift':'off',fn(x)?'shift':'off')});
  const oa=p.offDays||[],ob=x.offDays||[];ob.filter(k=>!oa.includes(k)).forEach(k=>L.push(`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}: now a day off`));
  oa.filter(k=>!ob.includes(k)).forEach(k=>L.push(`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}: now a shift`));
  /* quantities, shift by shift */
  const sa=p.shiftData||{},sb=x.shiftData||{};
  const lineTxt=l=>[(l.type||'').trim(),l.binder,l.virgin?'virgin':'',num(l.tonnes)?`${fmtN(num(l.tonnes))} t`:'',num(l.area)?`${fmtN(num(l.area))} m²`:'',num(l.depth)?`${fmtN(num(l.depth))} mm`:''].filter(Boolean).join(' ');
  const qTxt=q=>linesOf(q).filter(lineHas).map(lineTxt).join(' + ');
  [...new Set([...Object.keys(sa),...Object.keys(sb)])].sort().forEach(k=>{const qa=sa[k],qb=sb[k];if(same(qa,qb))return;
    const day=`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}`;
    const ta=qTxt(qa),tb=qTxt(qb);if(ta!==tb)ch(day,ta,tb);
    const ea=qa&&qa.exbin?qa.exbin.supplier||'yes':'',eb=qb&&qb.exbin?qb.exbin.supplier||'yes':'';if(ea!==eb)ch(`${day} exbin`,ea,eb);
    const pa2=progClean(qa),pb2=progClean(qb);
    if(!same(pa2.trucks,pb2.trucks))ch(`${day} trucks`,truckSum(pa2.trucks),truckSum(pb2.trucks));
    if(!same(pa2.subs,pb2.subs))ch(`${day} subcontractors`,(pa2.subs||[]).map(x=>x.name).join(', '),(pb2.subs||[]).map(x=>x.name).join(', '));
    if((pa2.start||'')!==(pb2.start||''))ch(`${day} start time`,fmtTime(pa2.start),fmtTime(pb2.start));
    if((pa2.comments||'')!==(pb2.comments||''))ch(`${day} comments`,(pa2.comments||'').slice(0,60),(pb2.comments||'').slice(0,60));
    const ca=qa&&qa.crewId?rname(a,qa.crewId):'',cb=qb&&qb.crewId?rname(b,qb.crewId):'';if(ca!==cb)ch(`${day} done by`,ca||rname(a,p.resourceId),cb||rname(b,x.resourceId))});
  return L.length>14?[...L.slice(0,13),`…and ${L.length-13} more`]:L;
}
function describeChanges(a,b){
  const out=[];const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
  const rname=(d,id)=>d.resources.find(r=>r.id===id)?.name||'';
  const jname=(d,id)=>{const j=d.jobs.find(x=>x.id===id);return j?jobLabel(j):''};
  const what=(d,x)=>x.kind==='job'?(jname(d,x.jobId)||'Job'):(x.title||(KINDS[x.kind]&&KINDS[x.kind].label)||'Booking');
  const when=x=>x.start?`${fmtShort(parse(x.start))}${x.end&&x.end!==x.start?' – '+fmtShort(parse(x.end)):''}`:'';
  if(a.blocks!==b.blocks){
    const am=new Map(a.blocks.map(x=>[x.id,x])),bm=new Map(b.blocks.map(x=>[x.id,x]));
    b.blocks.forEach(x=>{const p=am.get(x.id);
      if(!p){out.push({type:'booking',text:`Booking added: ${what(b,x)}`,sub:`${rname(b,x.resourceId)} · ${when(x)}`,blockId:x.id});return}
      if(p===x||same(p,x))return;
      const quoteOnly=(p.quoteNo||'')!==(x.quoteNo||'')&&same({...p,quoteNo:''},{...x,quoteNo:''});  /* quote-only: own notification, still in the full log */
      out.push({type:'booking',text:`Booking changed: ${what(b,x)}`,sub:`${rname(b,x.resourceId)} · ${when(x)}`,details:bookingDiff(a,b,p,x,rname,jname,when),blockId:x.id,...(quoteOnly?{quoteOnly:true}:{})})});
    a.blocks.forEach(p=>{if(!bm.has(p.id))out.push({type:'booking',text:`Booking deleted: ${what(a,p)}`,sub:`${rname(a,p.resourceId)} · ${when(p)}`})});
  }
  if(a.jobs!==b.jobs){
    const am=new Map(a.jobs.map(x=>[x.id,x])),bm=new Map(b.jobs.map(x=>[x.id,x]));
    b.jobs.forEach(j=>{const p=am.get(j.id);const {pos:_a,...jj}=j;
      if(!p){out.push({type:'job',text:`Job added: ${jobLabel(j)}`,sub:j.projectNo?`Project ${j.projectNo}`:''});return}
      const {pos:_b,...pp}=p;if(same(pp,jj))return;
      if(!!p.completed!==!!j.completed){out.push({type:'job',text:`Job ${j.completed?'completed':'reopened'}: ${jobLabel(j)}`,sub:''});return}
      const parts=[];[['name','name'],['customer','customer'],['address','site address'],['projectNo','project number']].forEach(([f,l])=>{if((p[f]||'')!==(j[f]||''))parts.push(l)});
      out.push({type:'job',text:`Job changed: ${jobLabel(j)}`,sub:parts.length?parts.join(', '):(p.name!==j.name?`was ${p.name}`:'details')})});
    a.jobs.forEach(p=>{if(!bm.has(p.id))out.push({type:'job',text:`Job deleted: ${jobLabel(p)}`,sub:''})});
  }
  if(a.resources!==b.resources){
    const strip=r=>{const {visible,pos,...x}=r;return x};
    const am=new Map(a.resources.map(x=>[x.id,x])),bm=new Map(b.resources.map(x=>[x.id,x]));
    b.resources.forEach(r=>{const p=am.get(r.id);const w=RES_WORD[r.type]||'Resource';
      if(!p){out.push({type:'resource',text:`${w} added: ${r.name}`,sub:r.sub||''});return}
      if(same(strip(p),strip(r)))return;
      const parts=[];if(p.name!==r.name)parts.push(`was ${p.name}`);if((p.sub||'')!==(r.sub||''))parts.push(`now ${r.sub||'—'}`);
      if((p.crewId||'')!==(r.crewId||''))parts.push(r.crewId?`now in ${rname(b,r.crewId)}`:'no crew');if(p.hue!==r.hue)parts.push('colour');
      out.push({type:'resource',text:`${w} changed: ${r.name}`,sub:parts.join(', ')})});
    a.resources.forEach(p=>{if(!bm.has(p.id))out.push({type:'resource',text:`${RES_WORD[p.type]||'Resource'} removed: ${p.name}`,sub:''})});
  }
  const lists=LIST_SETTINGS.filter(([k])=>a[k]!==b[k]&&!same(a[k],b[k])).map(([,l])=>l);
  if(lists.length)out.push({type:'lists',text:`${lists.join(', ')} updated`,sub:''});
  /* a big batch (import, merge) becomes one notification */
  if(out.length>6){const c={};out.forEach(o=>{const k=o.text.split(':')[0];c[k]=(c[k]||0)+1});
    return [{type:out.some(o=>o.type==='booking')?'booking':out[0].type,text:`${out.length} changes`,sub:Object.entries(c).map(([k,n])=>`${n} × ${k.toLowerCase()}`).join(', ')}]}
  return out;
}
function withChangeLog(cur,next,by){
  if(!next||next===cur)return next;
  let ch;try{ch=describeChanges(cur,next)}catch(e){ch=[]}
  if(!ch.length)return next;
  const now=Date.now();let log=next.changeLog||[];
  if(log.length>4990)log=[...log].sort((x,y)=>x.at-y.at).slice(-4990);   /* full history: newest 5,000 changes */
  return {...next,changeLog:[...log,...ch.map(c=>({id:uid(),at:now,...c,...(by?{by}:{})}))]};
}
const recentChanges=(data,prefs)=>(data.changeLog||[]).filter(c=>!c.quoteOnly&&Date.now()-c.at<NOTIF_MS&&!!prefs[c.type]);
/* ---------- full change log (administrators) ---------- */
const LOG_TYPES=[['all','Everything'],['booking','Bookings'],['quote','Quote numbers'],['job','Jobs'],['resource','Crews, staff & machines'],['lists','Mixes & seal lists']];
function ChangeLogDialog({data,onClose,onOpen}){
  const [q,setQ]=useState('');const [type,setType]=useState('all');const [who,setWho]=useState('');const [limit,setLimit]=useState(300);
  useEffect(()=>{const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);
  /* quote-number-only edits are logged as booking changes flagged quoteOnly; list them under "Quote numbers" */
  const all=useMemo(()=>(data.changeLog||[]).map(c=>c.quoteOnly?{...c,type:'quote'}:c).sort((a,b)=>b.at-a.at),[data.changeLog]);
  const people=[...new Set(all.map(c=>c.by).filter(Boolean))].sort();
  const t=q.trim().toLowerCase();
  const shown=all.filter(c=>(type==='all'||c.type===type)&&(!who||c.by===who)&&(!t||[c.text,c.sub,c.by,...(c.details||[])].join(' ').toLowerCase().includes(t)));
  const dayOf=at=>{const d=new Date(at);return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`};
  const timeOf=at=>new Date(at).toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'});
  let last='';
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full max-w-[760px] flex flex-col max-h-full overflow-hidden" style=${{height:'min(820px,100%)'}} role="dialog" aria-modal="true" aria-labelledby="log-title">
      <div class="px-5 pt-5 pb-3 border-b border-line grid gap-3">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div id="log-title" class="font-display text-[18px] font-semibold">Change log</div>
            <div class="text-[12.5px] text-muted">Every change made to the roster, newest first. Only administrators see this.</div>
          </div>
          <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
        </div>
        <div class="flex flex-wrap gap-2">
          <input id="log-q" class="field field-sm flex-1 min-w-[160px]" style=${{height:32}} placeholder="Search: job, crew, quote, person…" value=${q} onInput=${e=>{setQ(e.target.value);setLimit(300)}} aria-label="Search the change log"/>
          <select id="log-type" class="field field-sm w-auto" style=${{height:32}} value=${type} onChange=${e=>{setType(e.target.value);setLimit(300)}} aria-label="Type of change">
            ${LOG_TYPES.map(([v,l])=>html`<option key=${v} value=${v}>${l}</option>`)}</select>
          ${people.length>0&&html`<select id="log-who" class="field field-sm w-auto" style=${{height:32}} value=${who} onChange=${e=>{setWho(e.target.value);setLimit(300)}} aria-label="Changed by">
            <option value="">Anyone</option>${people.map(p=>html`<option key=${p} value=${p}>${p}</option>`)}</select>`}
        </div>
        <div class="text-[12px] text-muted">${shown.length} change${shown.length===1?'':'s'}${shown.length!==all.length?` (of ${all.length})`:''}</div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto">
        ${shown.length===0&&html`<div class="px-5 py-10 text-center text-[13px] text-muted">${all.length?'No changes match.':'No changes recorded yet. Changes are logged from now on.'}</div>`}
        ${shown.slice(0,limit).map(c=>{const day=dayOf(c.at);const head=day!==last;last=day;const b=c.blockId&&data.blocks.find(x=>x.id===c.blockId);
          return html`<div key=${c.id}>
            ${head&&html`<div class="sticky top-0 z-[1] px-5 py-1.5 bg-sunken border-b border-line label">${day}</div>`}
            <div class="px-5 py-2.5 border-b border-line flex items-start gap-3">
              <span class="mono text-[11.5px] text-muted w-[58px] shrink-0 pt-0.5">${timeOf(c.at)}</span>
              <div class="min-w-0 flex-1">
                <div class="text-[13px] font-medium">${c.text}</div>
                ${c.sub&&html`<div class="text-[12px] text-muted">${c.sub}</div>`}
                ${c.details&&c.details.length>0&&html`<ul class="mt-1 grid gap-0.5 text-[12px] leading-snug">${c.details.map((d,i)=>html`<li key=${i} class="flex gap-1.5"><span class="text-faint shrink-0">•</span><span class="min-w-0 break-words">${d}</span></li>`)}</ul>`}
                ${c.by&&html`<div class="text-[11.5px] text-faint mt-0.5">by ${c.by}</div>`}
              </div>
              ${b&&html`<button class="btn shrink-0" style=${{height:28}} onClick=${()=>{onClose();onOpen(b)}}>Open</button>`}
            </div></div>`})}
        ${shown.length>limit&&html`<div class="p-4 text-center"><button class="btn" onClick=${()=>setLimit(l=>l+300)}>Show more (${shown.length-limit} left)</button></div>`}
      </div>
    </div>
  </div>`;
}

/* ---------- settings menu: dark mode, notifications and (live) account ---------- */
function SwitchRow({id,label,desc,on,onChange}){
  return html`<label class="flex items-start gap-3 px-2 py-2 rounded-lg hover:bg-sunken cursor-pointer">
    <span class="min-w-0 flex-1"><span class="block text-[13px] font-medium">${label}</span>${desc&&html`<span class="block text-[12px] text-muted">${desc}</span>`}</span>
    <span class="relative inline-flex shrink-0 mt-0.5">
      <input id=${id} type="checkbox" role="switch" class="peer sr-only" checked=${!!on} onChange=${e=>onChange(e.target.checked)}/>
      <span class="w-9 h-5 rounded-full transition-colors" style=${{background:on?'var(--accent)':'var(--line-strong)'}}></span>
      <span class="absolute top-0.5 w-4 h-4 rounded-full transition-all" style=${{left:on?18:2,background:'var(--surface)',boxShadow:'0 1px 2px rgba(0,0,0,.2)'}}></span>
    </span>
  </label>`;
}
function SettingsMenu({theme,toggleTheme,prefs,setPrefs,account,onLog}){
  const [open,setOpen]=useState(false);
  const ref=React.useRef(null);
  useEffect(()=>{if(!open)return;
    const out=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};const esc=e=>{if(e.key==='Escape')setOpen(false)};
    document.addEventListener('pointerdown',out);window.addEventListener('keydown',esc);
    return()=>{document.removeEventListener('pointerdown',out);window.removeEventListener('keydown',esc)}},[open]);
  const initial=account&&account.email?account.email[0].toUpperCase():'';
  const sectionLabel=t=>html`<div class="label px-2 pt-2 pb-1">${t}</div>`;
  return html`<div class="relative" ref=${ref}>
    <button class="btn px-2" onClick=${()=>setOpen(o=>!o)} aria-expanded=${open} aria-label="Settings" title="Settings">
      ${account?html`<span class="w-6 h-6 rounded-full inline-flex items-center justify-center text-[12px] font-bold" style=${{background:'var(--ink)',color:'var(--surface)'}}>${initial}</span>`:Icon.gear}
    </button>
    ${open&&html`<div class="panel pop absolute right-0 top-[38px] z-40 w-[min(320px,calc(100vw-32px))] overflow-hidden" role="dialog" aria-label="Settings">
      ${account&&html`<div class="px-4 py-3 border-b border-line">
        <div class="text-[12px] text-muted">Signed in as</div>
        <div class="text-[13.5px] font-semibold truncate">${account.email}</div>
        <div class="text-[11.5px] text-muted mt-0.5">${account.role==='admin'?'Administrator':account.role==='planner'?'Planner (can edit)':'View only'}</div>
      </div>`}
      <div class="p-2">
        ${sectionLabel('Appearance')}
        <${SwitchRow} id="set-dark" label="Dark mode" on=${theme==='dark'} onChange=${()=>toggleTheme()}/>
        ${sectionLabel('Notifications')}
        ${NOTIF_TYPES.map(t=>html`<${SwitchRow} key=${t.id} id=${'np-'+t.id} label=${t.label} desc=${t.desc} on=${!!prefs[t.id]} onChange=${v=>setPrefs({...prefs,[t.id]:v})}/>`)}
        ${onLog&&html`${sectionLabel('Administration')}
          <button class="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-sunken text-[13px] text-left" onClick=${()=>{setOpen(false);onLog()}}>${Icon.list} Change log</button>`}
      </div>
      ${account&&html`<div class="border-t border-line p-2 grid">
        <button class="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-sunken text-[13px] text-left" onClick=${()=>{setOpen(false);account.onChangePw()}}>${Icon.key} Change password</button>
        <button class="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-sunken text-[13px] text-left" onClick=${()=>{setOpen(false);account.onSignOut()}}>${Icon.logout} Sign out</button>
      </div>`}
    </div>`}
  </div>`;
}

function Notifications({data,onOpen,prefs,setPrefs}){
  const SEEN=KEY+':quote-seen';
  /* deleting a notification only hides it for this person (in this browser); others still see it */
  const GONE=KEY+':notif-dismissed';
  const [gone,setGone]=useState(()=>{try{return JSON.parse(localStorage.getItem(GONE)||'{}')||{}}catch(e){return {}}});
  const saveGone=g=>{const now=Date.now();const kept=Object.fromEntries(Object.entries(g).filter(([,t])=>now-t<CHANGE_KEEP));setGone(kept);try{localStorage.setItem(GONE,JSON.stringify(kept))}catch(e){}};
  const dismiss=id=>saveGone({...gone,[id]:Date.now()});
  const [open,setOpen]=useState(false);
  const [seen,setSeen]=useState(()=>{try{return Number(localStorage.getItem(SEEN))||0}catch(e){return 0}});
  const [,tick]=useState(0);
  useEffect(()=>{const t=setInterval(()=>tick(x=>x+1),6e4);return()=>clearInterval(t)},[]); /* keeps "x min ago" and the 24-hour window current */
  const ref=React.useRef(null);
  useEffect(()=>{if(!open)return;
    const out=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};const esc=e=>{if(e.key==='Escape')setOpen(false)};
    document.addEventListener('pointerdown',out);window.addEventListener('keydown',esc);
    return()=>{document.removeEventListener('pointerdown',out);window.removeEventListener('keydown',esc)}},[open]);
  const list=[...(prefs.quote?recentQuoteChanges(data).map(c=>({...c,_q:true})):[]),...recentChanges(data,prefs)].filter(c=>!gone[c.id]).sort((a,b)=>b.at-a.at).slice(0,150);
  const me=window.__rosterMe||'';
  const allOff=NOTIF_TYPES.every(t=>!prefs[t.id]);
  const unseen=list.filter(c=>c.at>seen).length;
  const toggle=()=>{const now=!open;setOpen(now);if(now){const t=Date.now();setSeen(t);try{localStorage.setItem(SEEN,String(t))}catch(e){}}};
  return html`<div class="relative" ref=${ref}>
    <button class="btn px-2 relative" onClick=${toggle} aria-expanded=${open} aria-label=${`Notifications${unseen?`, ${unseen} new`:''}`} title="Changes in the last 48 hours">
      ${allOff?Icon.bellOff:Icon.bell}
      ${unseen>0&&html`<span class="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-bold inline-flex items-center justify-center" style=${{background:'var(--accent)',color:'var(--accent-ink)'}}>${unseen}</span>`}
    </button>
    ${open&&html`<div class="panel pop absolute right-0 top-[38px] z-40 w-[min(360px,calc(100vw-32px))] overflow-hidden" role="dialog" aria-label="Notifications">
      <div class="px-4 py-3 border-b border-line flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="font-display text-[15px] font-semibold">Notifications</div>
          <div class="text-[12px] text-muted">Changes from the last 48 hours</div>
        </div>
        ${list.length>0&&html`<button class="text-[12px] font-medium text-muted hover:text-ink underline underline-offset-2 shrink-0 mt-0.5"
          onClick=${()=>{const g={...gone};list.forEach(c=>{g[c.id]=Date.now()});saveGone(g)}}>Clear all</button>`}
      </div>
      ${html`<ul class="max-h-[360px] overflow-y-auto">
        ${list.length===0&&html`<li class="px-4 py-6 text-center text-[13px] text-muted">${allOff?'Notifications are off. Turn them on in Settings.':'No notifications.'}</li>`}
        ${list.map(c=>{if(!c._q){const b=c.blockId&&data.blocks.find(x=>x.id===c.blockId);
          return html`<li key=${c.id} class="px-4 py-2.5 border-b border-line last:border-b-0 flex items-start gap-3">
            <span class="w-2 h-2 rounded-full mt-1.5 shrink-0" style=${{background:c.at>seen&&open?'var(--accent)':'var(--line-strong)'}}></span>
            <div class="min-w-0 flex-1">
              <div class="text-[13px]">${c.text}</div>
              ${c.sub&&html`<div class="text-[12px] text-muted">${c.sub}</div>`}
              ${c.details&&c.details.length>0&&html`<ul class="mt-1 grid gap-0.5 text-[12px] leading-snug">${c.details.map((t,i)=>html`<li key=${i} class="flex gap-1.5"><span class="text-faint shrink-0">•</span><span class="min-w-0 break-words">${t}</span></li>`)}</ul>`}
              <div class="text-[11.5px] text-faint">${agoText(c.at)}${c.by?` · ${c.by===me?'you':c.by}`:''}</div>
            </div>
            ${b&&html`<button class="btn shrink-0" style=${{height:28}} onClick=${()=>{setOpen(false);onOpen(b)}}>Open</button>`}
            <button class="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>dismiss(c.id)} aria-label="Delete this notification" title="Delete">${Icon.x}</button>
          </li>`}
          const b=data.blocks.find(x=>x.id===c.bookingId);const j=b&&data.jobs.find(x=>x.id===b.jobId);const crew=b&&data.resources.find(r=>r.id===b.resourceId);
          return html`<li key=${c.id} class="px-4 py-2.5 border-b border-line last:border-b-0 flex items-start gap-3">
            <span class="w-2 h-2 rounded-full mt-1.5 shrink-0" style=${{background:c.at>seen&&open?'var(--accent)':'var(--line-strong)'}}></span>
            <div class="min-w-0 flex-1">
              <div class="text-[13px]">${c.from?html`Quote <span class="mono line-through text-muted">${c.from}</span> → <span class="mono font-semibold">${c.to||'removed'}</span>`:html`Quote <span class="mono font-semibold">${c.to}</span> added`}</div>
              <div class="text-[12px] text-muted truncate">${j?jobLabel(j):(c.jobName||'Job')}${crew?` · ${crew.name}`:''}${b?` · ${fmtShort(parse(b.start))}${b.end!==b.start?'–'+fmtShort(parse(b.end)):''}`:''}</div>
              <div class="text-[11.5px] text-faint">${agoText(c.at)}</div>
            </div>
            ${b?html`<button class="btn shrink-0" style=${{height:28}} onClick=${()=>{setOpen(false);onOpen(b)}}>Open</button>`:html`<span class="text-[11.5px] text-faint shrink-0">Deleted</span>`}
            <button class="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>dismiss(c.id)} aria-label="Delete this notification" title="Delete">${Icon.x}</button>
          </li>`;})}
      </ul>`}
    </div>`}
  </div>`;
}

/* =====================================================================
   Daily program: trucks, subcontractors, start time and comments per shift,
   and a branded PDF for each job working on a given day.
   ===================================================================== */
const TRUCK_WEIGHTS=['3T','5T','10T','12T','15T','18T','25T'];
const DEFAULT_TRUCKS=['AFA WF','AFA 10 W','AFA 8 W','AFA FLOCON','BIG DAVES','YDD','RCA','SWARLY','CD CARTAGE','HT','PAVETECH','RAP RESOURCES','NEWY GROUP','ACE TIPPERS','KELLY','ALL ASPECTS','BITUMILL'];
const DEFAULT_SUBS=['BCM','SITE SERVICES','AL BAY','BEAU STRIKE','GPC CONTRACTORS','SOUTH EAST PROFILING','MR ROADS CREW MEMBERS','MASTERHIRE LIGHTING TOWER','BELLS DIESEL LIGHTING TOWER','HT','AUSTCORP','SWARLY','PAVETECH','RIVERCITY','ALL ASPECTS','BITUMILL','SHERRIN RENTALS'];
const PROGRAM_LOCATIONS=['SITE','SCA','BALD HILLS YARD'];
const PROGRAM_FOOTER=['SPOTTER TO WEAR PINK AT ALL TIMES','PRESTART ALL MACHINERY - PRESTARTS TO BE COMPLETED ON MEX.'];
const truckCosOf=d=>d&&Array.isArray(d.truckCos)?d.truckCos:DEFAULT_TRUCKS;
const subCosOf=d=>d&&Array.isArray(d.subCos)?d.subCos:DEFAULT_SUBS;
const truckHas=t=>!!t&&!!(t.co||t.driver||t.w||t.time||t.loc);
const subHas=s=>!!s&&!!(s.name||s.info||s.time);
const progHas=q=>!!q&&((q.trucks||[]).some(truckHas)||(q.subs||[]).some(subHas)||!!q.start||!!(q.comments||'').trim());
const progClean=q=>{const o={};if(!q)return o;
  const t=(q.trucks||[]).filter(truckHas).map(x=>({co:(x.co||'').trim(),driver:(x.driver||'').trim(),w:x.w||'',time:x.time||'',loc:(x.loc||'').trim()}));if(t.length)o.trucks=t;
  const s=(q.subs||[]).filter(subHas).map(x=>({name:(x.name||'').trim(),info:(x.info||'').trim(),time:x.time||''}));if(s.length)o.subs=s;
  if(q.start)o.start=q.start;const c=(q.comments||'').trim();if(c)o.comments=c;return o};
const linesOnly=q=>!q?[]:Array.isArray(q.lines)?q.lines:(q.type||q.tonnes||q.area?[q]:[]);
const fmtTime=t=>{if(!t)return '';const m=/^(\d{1,2}):(\d{2})/.exec(t);if(!m)return t;let h=+m[1];const ap=h>=12?'PM':'AM';h=h%12||12;return `${h}:${m[2]} ${ap}`};
const truckT=w=>parseFloat(String(w||'').replace(/[^\d.]/g,''))||0;
const truckSum=ts=>{const l=(ts||[]).filter(truckHas);return `${l.length} truck${l.length===1?'':'s'}${l.length?`, ${fmtN(l.reduce((a,t)=>a+truckT(t.w),0))}T`:''}`};

function TrucksManager({data,setData}){
  const setter=key=>(list,extra)=>setData(d=>{const n={...d,[key]:list};return extra?extra(n):n});
  return html`<div class="flex-1 min-h-0 overflow-y-auto">
    <${ListManager} title="Trucks" field="truckco" placeholder="e.g. BIG DAVES" data=${data} setData=${setData}
      hint="Truck companies offered in a booking's Trucks & Subcontractors tab, in this order."
      items=${truckCosOf(data)} setItems=${setter('truckCos')}/>
    <div class="border-t border-line mx-4"></div>
    <${ListManager} title="Subcontractors" field="subco" placeholder="e.g. BCM" data=${data} setData=${setData}
      hint="Subcontractors offered in a booking's Trucks & Subcontractors tab, in this order."
      items=${subCosOf(data)} setItems=${setter('subCos')}/>
  </div>`;
}

/* booking editor tab: one shift at a time */
function ProgramShifts({f,set,data}){
  const dates=shiftDates(f);const sd=f.shiftData||{};
  const [sel,setSel]=useState(()=>{const t=iso(TODAY);return dates.includes(t)?t:(dates.find(k=>k>=t)||dates[0]||'')});
  const k=dates.includes(sel)?sel:dates[0];
  if(!k)return html`<div class="text-[12.5px] text-muted">This booking has no shifts yet. Check the dates and the weekend ticks.</div>`;
  const q=sd[k]||{};const i=dates.indexOf(k);
  const upd=p=>set({shiftData:{...sd,[k]:{...shiftBase(q),lines:linesOnly(q),...p}}});
  const trucks=q.trucks&&q.trucks.length?q.trucks:[{}];
  const subs=q.subs&&q.subs.length?q.subs:[{}];
  const setT=(j,p)=>upd({trucks:trucks.map((t,x)=>x===j?{...t,...p}:t)});
  const setS=(j,p)=>upd({subs:subs.map((s,x)=>x===j?{...s,...p}:s)});
  const prog=o=>({trucks:(o.trucks||[]).map(t=>({...t})),subs:(o.subs||[]).map(s=>({...s})),start:o.start||'',comments:o.comments||''});
  const copyPrev=()=>upd(prog(sd[dates[i-1]]||{}));
  const copyAll=()=>{const next={...sd};dates.forEach(d=>{if(d===k)return;const o=sd[d]||{};next[d]={...shiftBase(o),lines:linesOnly(o),...prog(q)}});set({shiftData:next})};
  const tl=trucks.filter(truckHas);const totT=tl.reduce((a,t)=>a+truckT(t.w),0);
  const night=f.shift==='night';
  const locs=[...new Set([...PROGRAM_LOCATIONS,...(f.address?[f.address]:[])])];
  const fs={height:30,fontSize:13};const iconX='w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken';
  const TC='grid gap-2 grid-cols-[1fr_1fr_28px] sm:grid-cols-[1.3fr_1fr_76px_104px_1.2fr_28px] items-center';
  const SC2='grid gap-2 grid-cols-[1fr_1fr_28px] sm:grid-cols-[1.4fr_1.2fr_104px_28px] items-center';
  return html`<section class="grid gap-4" aria-labelledby="sec-program">
    <datalist id="dl-truckco">${truckCosOf(data).map(t=>html`<option key=${t} value=${t}/>`)}</datalist>
    <datalist id="dl-subco">${subCosOf(data).map(t=>html`<option key=${t} value=${t}/>`)}</datalist>
    <datalist id="dl-loc">${locs.map(t=>html`<option key=${t} value=${t}/>`)}</datalist>
    <div class="flex flex-wrap items-end gap-3">
      <div class="mr-auto"><h3 id="sec-program" class="font-display text-[15px] font-semibold">Trucks & subcontractors</h3>
        <div class="text-[12px] text-muted">Goes on the daily program for each shift. Plant onsite comes from the mobile plant on this booking.</div></div>
      <label class="grid gap-1"><span class="label">Shift</span>
        <select id="pg-shift" class="field field-sm" style=${{...fs,width:'auto'}} value=${k} onChange=${e=>setSel(e.target.value)}>
          ${dates.map((d,x)=>html`<option key=${d} value=${d}>Shift ${x+1} · ${WD[parse(d).getDay()]} ${fmtShort(parse(d))}${progHas(sd[d])?' ✓':''}</option>`)}
        </select></label>
      <label class="grid gap-1"><span class="label">Start time</span>
        <input id="pg-start" type="time" class="field field-sm mono" style=${{...fs,width:120}} value=${q.start||''} onInput=${e=>upd({start:e.target.value})}/></label>
    </div>
    <div class="flex flex-wrap gap-2 -mt-2">
      ${i>0&&html`<button type="button" class="btn btn-ghost text-muted" style=${{height:28}} onClick=${copyPrev}>Copy from shift ${i}</button>`}
      ${dates.length>1&&html`<button type="button" class="btn btn-ghost text-muted" style=${{height:28}} onClick=${copyAll} title="Replace the trucks, subcontractors, start time and comments on every other shift with this shift's">Copy this shift to all shifts</button>`}
    </div>

    <div class="grid gap-1.5">
      <div class="flex items-baseline gap-2"><span class="label" style=${{color:'var(--ink)'}}>Trucks</span><span class="text-[12px] text-muted tnum">${tl.length} · ${fmtN(totT)}T</span><span class="flex-1 h-px bg-line self-center"></span></div>
      <div class=${'hidden sm:grid '+TC}><span class="label">Truck</span><span class="label">Driver</span><span class="label">Weight</span><span class="label">Time</span><span class="label">Location</span><span></span></div>
      ${trucks.map((t,j)=>html`<div key=${j} class=${TC}>
        <input id=${`pg-t${j}-co`} class="field field-sm" style=${fs} list="dl-truckco" placeholder="Truck" value=${t.co||''} onInput=${e=>setT(j,{co:e.target.value})} aria-label=${`Truck ${j+1} company`}/>
        <input id=${`pg-t${j}-dr`} class="field field-sm" style=${fs} placeholder="Driver" value=${t.driver||''} onInput=${e=>setT(j,{driver:e.target.value})} aria-label=${`Truck ${j+1} driver`}/>
        <select id=${`pg-t${j}-w`} class="field field-sm mono" style=${{...fs,color:t.w?'var(--ink)':'var(--faint)'}} value=${t.w||''} onChange=${e=>setT(j,{w:e.target.value})} aria-label=${`Truck ${j+1} weight`}>
          <option value="">T</option>${TRUCK_WEIGHTS.map(w=>html`<option key=${w} value=${w} style=${{color:'var(--ink)'}}>${w}</option>`)}
          ${t.w&&!TRUCK_WEIGHTS.includes(t.w)&&html`<option value=${t.w}>${t.w}</option>`}</select>
        <input id=${`pg-t${j}-time`} type="time" class="field field-sm mono" style=${fs} value=${t.time||''} onInput=${e=>setT(j,{time:e.target.value})} aria-label=${`Truck ${j+1} time`}/>
        <input id=${`pg-t${j}-loc`} class="field field-sm" style=${fs} list="dl-loc" placeholder="Location" value=${t.loc||''} onInput=${e=>setT(j,{loc:e.target.value})} aria-label=${`Truck ${j+1} location`}/>
        <button type="button" class=${iconX} onClick=${()=>upd({trucks:trucks.filter((_,x)=>x!==j)})} aria-label=${`Remove truck ${j+1}`} title="Remove">${Icon.x}</button>
      </div>`)}
      <div class="flex flex-wrap gap-3">
        <button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>upd({trucks:[...trucks,{}]})}>${Icon.plus} Add truck</button>
        ${truckHas(trucks[trucks.length-1])&&html`<button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>upd({trucks:[...trucks,{...trucks[trucks.length-1],driver:''}]})}>${Icon.plus} Same truck again</button>`}
      </div>
    </div>

    <div class="grid gap-1.5">
      <div class="flex items-baseline gap-2"><span class="label" style=${{color:'var(--ink)'}}>Subcontractors</span><span class="flex-1 h-px bg-line self-center"></span></div>
      <div class=${'hidden sm:grid '+SC2}><span class="label">Subcontractor</span><span class="label">Info</span><span class="label">Start time</span><span></span></div>
      ${subs.map((s,j)=>html`<div key=${j} class=${SC2}>
        <input id=${`pg-s${j}-n`} class="field field-sm" style=${fs} list="dl-subco" placeholder="Subcontractor" value=${s.name||''} onInput=${e=>setS(j,{name:e.target.value})} aria-label=${`Subcontractor ${j+1}`}/>
        <input id=${`pg-s${j}-i`} class="field field-sm" style=${fs} placeholder="e.g. x 3 labourers, shuttle buggy" value=${s.info||''} onInput=${e=>setS(j,{info:e.target.value})} aria-label=${`Subcontractor ${j+1} info`}/>
        <input id=${`pg-s${j}-t`} type="time" class="field field-sm mono" style=${fs} value=${s.time||''} onInput=${e=>setS(j,{time:e.target.value})} aria-label=${`Subcontractor ${j+1} start time`}/>
        <button type="button" class=${iconX} onClick=${()=>upd({subs:subs.filter((_,x)=>x!==j)})} aria-label=${`Remove subcontractor ${j+1}`} title="Remove">${Icon.x}</button>
      </div>`)}
      <div><button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>upd({subs:[...subs,{}]})}>${Icon.plus} Add subcontractor</button></div>
    </div>

    <label class="grid gap-1"><span class="label">Comments for this shift</span>
      <textarea id="pg-comments" class="field" style=${{height:'auto',minHeight:56,padding:'8px 10px',resize:'vertical'}} rows="2" placeholder=${night?'e.g. Standard PPE + UHF: 12, lighting towers on site':'e.g. Standard PPE + UHF: 12'} value=${q.comments||''} onInput=${e=>upd({comments:e.target.value})}></textarea></label>
  </section>`;
}

/* ---------- the PDF ---------- */
function loadJsPDF(){
  if(window.jspdf&&window.jspdf.jsPDF)return Promise.resolve(window.jspdf.jsPDF);
  return new Promise((res,rej)=>{const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload=()=>window.jspdf&&window.jspdf.jsPDF?res(window.jspdf.jsPDF):rej(new Error('PDF library missing'));
    s.onerror=()=>rej(new Error('Could not load the PDF library'));document.head.appendChild(s)});
}
/* every crew job working on a date (a shift handed to another crew goes under that crew) */
function programEntries(data,k){
  const d=parse(k);const order=new Map(data.resources.map((r,i)=>[r.id,i]));
  return data.blocks.filter(b=>b.kind==='job'&&k>=b.start&&k<=b.end&&worksOn(b,d))
    .map(b=>({b,k,crewId:coverOf(b,k)||b.resourceId}))
    .sort((x,y)=>(order.get(x.crewId)??999)-(order.get(y.crewId)??999)||(x.b.shift==='night')-(y.b.shift==='night'));
}
const PLANT_GROUPS=[['Pavers',/paver/i],['Steel rollers',/steel|tandem|drum|smooth/i],['Multi rollers',/multi|pneumatic|tyre|tire|rubber/i],['Bobcat',/bobcat|skid|loader|posi/i]];
function plantGroups(machines){
  const g=PLANT_GROUPS.map(([l])=>({label:l,items:[]}));const extra={label:'Additional',items:[]};
  machines.forEach(m=>{const t=`${m.name} ${m.sub||''}`;const i=PLANT_GROUPS.findIndex(([,re])=>re.test(t));
    (i>=0?g[i]:(/roller/i.test(t)?g[1]:extra)).items.push(m)});
  return [...g,extra];
}
const AFA_RED=[155,10,30],AFA_DARK=[58,58,58],AFA_GRID=[160,160,160];
function drawProgram(doc,data,{b,k,crewId}){
  const crew=data.resources.find(r=>r.id===crewId)||{name:'Crew'};
  const job=data.jobs.find(j=>j.id===b.jobId)||{name:'Job'};
  const seal=isSealCrew(crew)||isSealCrew(data.resources.find(r=>r.id===b.resourceId));
  const q=(b.shiftData||{})[k]||{};const lines=linesOf(q).filter(lineHas);
  const dates=shiftDates(b);const idx=dates.indexOf(k);const d=parse(k);
  /* contact details: this booking, or the latest booking of the same job that has them */
  const sib=data.blocks.filter(x=>x.kind==='job'&&x.jobId===b.jobId).sort((x,y)=>x.start<y.start?1:-1);
  const pick=f=>(b[f]||'').trim()||(sib.find(x=>(x[f]||'').trim())||{})[f]||'';
  const W=190,M=10;
  const font=(size,bold,color)=>{doc.setFont('helvetica',bold?'bold':'normal');doc.setFontSize(size);doc.setTextColor(...(color||[0,0,0]))};
  const fit=(t,w)=>{t=String(t??'');if(doc.getTextWidth(t)<=w)return t;while(t.length>1&&doc.getTextWidth(t+'..')>w)t=t.slice(0,-1);return t+'..'};
  const cell=(x,y,w,h,t,o={})=>{
    if(o.fill){doc.setFillColor(...o.fill);doc.rect(x,y,w,h,'F')}
    if(o.border!==false){doc.setDrawColor(...AFA_GRID);doc.setLineWidth(0.2);doc.rect(x,y,w,h,'S')}
    if(t!==undefined&&t!==null&&t!==''){font(o.size||7.2,o.bold,o.color);const s=fit(t,w-2.4);
      const ax=o.align==='left'?x+1.2:o.align==='right'?x+w-1.2:x+w/2;doc.text(s,ax,y+h/2,{align:o.align||'center',baseline:'middle'})}};
  const head=(x,y,w,cols,h=6)=>{let cx=x;cols.forEach(([t,cw])=>{cell(cx,y,cw,h,t,{fill:AFA_DARK,color:[255,255,255],bold:true,size:6.8});cx+=cw});return y+h};
  const row=(x,y,cols,vals,h=5.4,o={})=>{let cx=x;cols.forEach(([,cw],i)=>{const v=vals[i];const vo=v&&typeof v==='object'&&!Array.isArray(v)?v:{t:v};cell(cx,y,cw,h,vo.t,{...o,...vo});cx+=cw});return y+h};

  /* header */
  try{doc.addImage(AFA_LOGO,'PNG',M,7,50,19.4)}catch(e){}
  font(12.5,true);doc.text(seal?'SEAL DAILY PROGRAM':'ASPHALT DAILY PROGRAM',101,11,{align:'center'});
  const longD=`${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]}, ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
  cell(140,5,60,6,longD,{fill:AFA_DARK,color:[255,255,255],bold:true,size:7.5,border:false});
  const rh=5.4;let ry=11.5;
  [['SHIFT :',b.shift==='night'?'NIGHT':'DAY',{bold:true}],['SHIFT No :',idx>=0?`${idx+1} OF ${dates.length}`:'',{bold:true}],
   ['PROJECT No :',b.projectNo||job.projectNo||'',{bold:true,color:AFA_RED}],['SITE CONTACT :',pick('siteContact'),{bold:true}],['',pick('sitePhone'),{bold:true}]]
    .forEach(([l,v,o])=>{cell(140,ry,22,rh,l,{border:false,align:'right',size:6.8,color:[70,70,70]});cell(162,ry,38,rh,v,o);ry+=rh});
  let my=16;
  [['CLIENT:',job.customer||''],['PROJECT LOCATION:',b.address||job.address||job.name],['JOB:',job.name],['SUPERVISOR:',pick('supervisor')],['QUOTE No:',b.quoteNo||'']]
    .forEach(([l,v])=>{cell(62,my,30,rh,l,{bold:true,size:6.4});cell(92,my,46,rh,v,{bold:l!=='SUPERVISOR:'});my+=rh});

  const top=Math.max(ry,my)+4;const LX=M,LW=94,RX=M+96,RW=94;

  /* left: personnel */
  const PC=[['PERSONNEL',36],['START LOC.',18],['ROLE',24],['TIME',16]];
  let ly=head(LX,top,LW,PC);
  const away=id=>data.blocks.some(x=>x.resourceId===id&&KINDS[x.kind]&&KINDS[x.kind].away&&k>=x.start&&k<=x.end);
  const staff=data.resources.filter(r=>r.type==='person'&&r.crewId===crewId&&!away(r.id));
  const st=fmtTime(q.start);
  const people=[[{t:crew.name,bold:true},'SITE',crew.sub||'',st],...staff.map(p=>[p.name,'SITE',p.sub||'',st])].slice(0,10);
  while(people.length<5)people.push(['','','','']);
  people.forEach(v=>{ly=row(LX,ly,PC,v)});

  /* left: plant onsite */
  ly+=3;ly=head(LX,ly,LW,[['PLANT ONSITE',LW]]);
  const machines=(b.plantIds||[]).map(id=>data.resources.find(r=>r.id===id)).filter(Boolean);
  plantGroups(machines).forEach(g=>{const its=g.items.length?g.items:[null];
    for(let s=0;s<its.length;s+=4){const v=[{t:s?'':g.label+':',bold:true,align:'left',size:6.6}];
      for(let c=0;c<4;c++){const m=its[s+c];v.push(m?{t:g.label==='Additional'&&m.sub?`${m.name} ${m.sub}`:m.name,bold:true,size:6.6}:'')}
      ly=row(LX,ly,[['',24],['',17.5],['',17.5],['',17.5],['',17.5]],v)}});

  /* left: subcontractors */
  ly+=3;const SCo=[['SUBCONTRACTORS',46],['INFO',30],['START TIME',18]];ly=head(LX,ly,LW,SCo);
  const subs=(q.subs||[]).filter(subHas).slice(0,10).map(s=>[s.name,s.info,fmtTime(s.time)]);
  while(subs.length<5)subs.push(['','','']);subs.forEach(v=>{ly=row(LX,ly,SCo,v)});

  /* right: job materials */
  let ry2=head(RX,top,RW,[['JOB MATERIALS REQUIRED',RW]]);
  const L3=lines.slice(0,3);const vc=[['',31],['',21],['',21],['',21]];
  const rapOf=t=>num(((data.mixRap)||{})[(t||'').trim()]);
  const supplier=q.exbin?(q.exbin.supplier||'EXBIN'):'AFA';
  const matRows=seal
    ?[['Job location:',null],['SUPPLIER :',()=>supplier],['SEAL TYPE :',l=>l.type],['BINDER :',l=>l.binder],['APPROX AREA (M2) :',l=>num(l.area)?fmtN(num(l.area)):'']]
    :[['Job location:',null],['SUPPLIER :',()=>supplier],['MIX :',l=>{const r=rapOf(l.type);return (l.type||'')+(r&&!l.virgin?` ${fmtN(r)}% RAP`:'')}],['BINDER :',l=>l.binder],
      ['APPROX TONNAGE :',l=>num(l.tonnes)?fmtN(num(l.tonnes)):''],['APPROX AREA (M2) :',l=>num(l.area)?fmtN(num(l.area)):''],['DEPTH (mm) :',l=>num(l.depth)?fmtN(num(l.depth)):'']];
  matRows.forEach(([l,fn])=>{
    if(!fn){cell(RX,ry2,31,5.4,l,{align:'right',size:6.6,bold:true});cell(RX+31,ry2,63,5.4,b.address||job.address||job.name,{fill:[20,20,20],color:[255,255,255],bold:true,size:6.8});ry2+=5.4;return}
    ry2=row(RX,ry2,vc,[{t:l,align:'right',size:6.6},...[0,1,2].map(i=>L3[i]?{t:fn(L3[i]),bold:true,...(l==='SUPPLIER :'?{fill:AFA_RED,color:[255,255,255]}:{})}:'')])});
  if(lines.length>3){cell(RX,ry2,RW,5,`+ ${lines.length-3} more line${lines.length-3===1?'':'s'} - see the booking`,{border:false,size:6.4,color:[110,110,110]});ry2+=5}

  /* right: trucks */
  ry2+=3;const TCo=[['TRUCKS',24],['DRIVER',18],['WEIGHT',12],['TIME',14],['LOCATION',26]];ry2=head(RX,ry2,RW,TCo);
  const tr=(q.trucks||[]).filter(truckHas).slice(0,22);
  const tv=tr.map(t=>[t.co,{t:t.driver,color:AFA_RED,bold:true},t.w,fmtTime(t.time),t.loc?{t:t.loc,bold:true,fill:/site/i.test(t.loc)||t.loc===(b.address||'')?[20,20,20]:AFA_RED,color:[255,255,255]}:'']);
  while(tv.length<12)tv.push(['','','','','']);tv.forEach(v=>{ry2=row(RX,ry2,TCo,v)});
  const tot=tr.reduce((a,t)=>a+truckT(t.w),0);
  ry2=row(RX,ry2,TCo,['',{t:'Total:',bold:true,align:'right'},{t:tot?`${fmtN(tot)}T`:'',bold:true},'',''],5.4);

  /* comments + footer */
  let y=Math.max(ly,ry2)+4;
  cell(M,y,W,6,'COMMENTS:',{fill:AFA_DARK,color:[255,255,255],bold:true,size:8,border:false});y+=6;
  const text=[q.comments,b.notes].map(s=>(s||'').trim()).filter(Boolean).join('\n');
  font(8,true);const wrapped=text?doc.splitTextToSize(text,W-6):[];const ch=Math.max(16,wrapped.length*4+6);
  doc.setDrawColor(...AFA_GRID);doc.setLineWidth(0.2);doc.rect(M,y,W,ch,'S');
  if(wrapped.length){font(8,true);doc.text(wrapped,105,y+5,{align:'center'})}
  y+=ch;
  PROGRAM_FOOTER.forEach((t,i)=>{cell(M,y,W,6,t,{fill:i?AFA_RED:AFA_DARK,color:[255,255,255],bold:true,size:8,border:false});y+=6});
  font(6,false,[130,130,130]);
  doc.text(`${crew.name} · ${jobLabel(job)} · printed ${new Date().toLocaleString('en-AU',{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'})}`,M,290);
}
async function buildDailyProgramPdf(data,entries){
  const JsPDF=await loadJsPDF();
  const doc=new JsPDF({orientation:'portrait',unit:'mm',format:'a4'});
  entries.forEach((e,n)=>{if(n)doc.addPage();drawProgram(doc,data,e)});
  return doc.output('blob');
}
const programFileName=(data,e)=>{const crew=data.resources.find(r=>r.id===e.crewId);const j=data.jobs.find(x=>x.id===e.b.jobId)||{};const d=parse(e.k);
  return `${[crew&&crew.name,j.customer,j.name].filter(Boolean).join(' - ')} ${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`.replace(/[\\/:*?"<>|]+/g,' ').replace(/\s+/g,' ').trim()+'.pdf'};

function DailyProgramDialog({data,onClose,notify}){
  const [day,setDay]=useState(()=>iso(addDays(TODAY,1)));
  const [off,setOff]=useState({});const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [dl,setDl]=useState(undefined);
  useEffect(()=>{let live=true;
    try{const p=window.claude?.use?.('downloads');if(p&&p.then)p.then(x=>{if(live)setDl(x)},()=>{if(live)setDl(null)});else setDl(null)}catch(e){setDl(null)}
    const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>{live=false;window.removeEventListener('keydown',h)}},[]);
  const entries=programEntries(data,day);const key=e=>e.b.id+'|'+e.k;
  const chosen=entries.filter(e=>!off[key(e)]);
  const step=n=>{setDay(iso(addDays(parse(day),n)));setOff({});setErr('')};
  const save=async(list,fn)=>{const blob=await buildDailyProgramPdf(data,list);await dl.save({filename:fn,data:blob})};
  const go=async combined=>{
    if(!dl){setErr('Saving files isn’t available in this view.');return}
    setBusy(true);setErr('');
    try{
      if(combined){const d=parse(day);await save(chosen,`Daily program ${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}.pdf`)}
      else for(const e of chosen)await save([e],programFileName(data,e));
      notify(combined||chosen.length===1?'Daily program saved':`${chosen.length} daily programs saved`);onClose();
    }catch(e){const c=e&&e.code;setErr(c==='declined'?'Download cancelled.':c==='rate_limited'?'A save prompt is already open. Finish that one first.':c?'Saving isn’t available in this view.':(e&&e.message)||'The PDF could not be built.')}
    finally{setBusy(false)}};
  const d=parse(day);
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full max-w-[560px] flex flex-col max-h-full overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="dp-title">
      <div class="px-5 pt-5 pb-3 border-b border-line flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div id="dp-title" class="font-display text-[18px] font-semibold">Daily program</div>
          <div class="text-[12.5px] text-muted">A PDF for each job working on the day: crew, plant onsite, materials, trucks and subcontractors.</div>
        </div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
      </div>
      <div class="px-5 py-3 flex items-center gap-2 border-b border-line">
        <button type="button" class="btn px-2" onClick=${()=>step(-1)} aria-label="Previous day">${Icon.chevL}</button>
        <input id="dp-day" type="date" class="field field-sm mono" style=${{height:32,width:'auto'}} value=${day} onChange=${e=>{if(e.target.value){setDay(e.target.value);setOff({})}}}/>
        <button type="button" class="btn px-2" onClick=${()=>step(1)} aria-label="Next day">${Icon.chevR}</button>
        <span class="text-[13px] font-medium ml-1">${WD[d.getDay()]} ${fmtShort(d)}</span>
      </div>
      <div class="overflow-y-auto p-3 grid gap-2">
        ${entries.length===0&&html`<div class="text-[13px] text-muted p-3 text-center">No crew jobs on this day.</div>`}
        ${entries.map(e=>{const j=data.jobs.find(x=>x.id===e.b.jobId);const crew=data.resources.find(r=>r.id===e.crewId);const q=(e.b.shiftData||{})[e.k]||{};
          const tr=(q.trucks||[]).filter(truckHas).length,sb=(q.subs||[]).filter(subHas).length,pl=(e.b.plantIds||[]).length;
          return html`<label key=${key(e)} class="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5 cursor-pointer hover:bg-sunken">
            <input type="checkbox" class="w-4 h-4 mt-0.5" style=${{accentColor:'var(--accent)'}} checked=${!off[key(e)]} onChange=${ev=>setOff(o=>({...o,[key(e)]:!ev.target.checked}))}/>
            <span class="min-w-0 grid gap-0.5">
              <span class="text-[13px] font-medium truncate">${jobLabel(j)}</span>
              <span class="text-[12px] text-muted">${crew?crew.name:''}${e.b.shift==='night'?' · night':' · day'}${e.crewId!==e.b.resourceId?' · covering':''}</span>
              <span class=${'text-[12px] '+(tr?'text-muted':'')} style=${tr?{}:{color:'var(--warn)'}}>${pl} plant · ${tr} truck${tr===1?'':'s'} · ${sb} subcontractor${sb===1?'':'s'}${tr?'':' (no trucks yet)'}</span>
            </span></label>`})}
      </div>
      ${err&&html`<div class="px-5 pb-2 text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      <div class="px-5 py-3 border-t border-line flex flex-wrap items-center gap-2">
        <span class="text-[12px] text-muted mr-auto">${chosen.length} of ${entries.length} selected</span>
        <button type="button" class="btn" disabled=${busy||chosen.length<2} onClick=${()=>go(true)}>One combined PDF</button>
        <button type="button" class="btn btn-primary" disabled=${busy||!chosen.length} onClick=${()=>go(false)}>${busy?'Building…':chosen.length>1?`Download ${chosen.length} PDFs`:'Download PDF'}</button>
      </div>
    </div>
  </div>`;
}

const AFA_LOGO='data:image/png;base64,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YyfWDAMRLILYtqYl2OEzJ1lBo9FFsRN+PQkYTz09O2laCo6OAEDWSDGhNKFlXStmnOkMEYQFDByYTgUTzv9ZkRhvAZWBSGrfq9n05Lrii8aO+/0UW4YDOOAY25jbZscUxm7548aeXd2A4eAxKQIsYW+nd82tK3WfThUKABwB9etIRIc5K4ggRFDziqbWNS2yXZKiZNEuE5EggoByk83kahhsebtatIhCtByRHZU1J3fPsipzvHny76elnVsAgEDnVS+UV76x25ESEVMQGzUqOmJUtDk9yhYjCQSDziwpjojsKGez0wigEEFaUKv89+6EyclJp2UhAaeekR1bGlf/bm3t23vadrXsfG+7q941/9kzOte1rr9njRbUJatkePtHZkWOOi+/aWVTx5Z2xR8QRFEQhWNffHAQzJLuD1a/+IEpOiL3ooW2vHRl156urzemnz73pOUdXde/+OILv9/v8/nWrFnz1VdfDT2VmJh4+eWXm83m/4Li0iWXXPLyyy/v2LFjKFDYtWuX2+0+2puEyWRatGjRunXruru7jUeWLVs2ffr0a6+99jDMCwB79uzp7OwMjZTPPvvsyZMnw39lF9Pe1z6s/fsblHP9+HIoQkZoe5j2G6Otc6BuoGtLR9bSfPBTwUQm3zEdxVkBZKB+995O9+4eZ5NLssuAQA2qslkChIADMKC6njwmOeOMXEQZCMjX6Kxbvjfo0bb/fStofOojcyljgaq+YK9f9an2FHtvec+hDtH44vuq+ijX96lGARAgQggxkSNOH/G0eRhnDBgHBoBkScYC5gRoQN/94u6yf5RJFlFySHKcGWNMJGKONuuK3vb+HnNmJDiD5S+U9bb09lT31q+oF5FojjPbM225Z4wq+fV4ImHskKJHRzevbeScI46YxmLSol3NrlU3fjnphulpZ+aYYsymzKjRv5+UsSi7/r291f8p7yzvWPXbz5y1TqoyySIZlKfruhQhlV43IfeS0VUvlNW9t6d/7wDVdNEkjVDPcAgmNWm+QMVzb1oS49JOmxpdlNW+saJrW1nixDEnLY2+//7777///oGh0N13333mmWfCfwWsVuvkyZN37do1FA/29vZ2dnYmJiYeVWOxKIo///nPp02bduuttxqKJcbYww8/PG7cuBkzZhw0RWBsv7m5OfRHZTKZ5s6dG/p6n8+3detWo7shdF3IOY+N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iNMZM2b8rxXHhKPp8CFpC2ZXP11tFwR7VoIjK2GwqhUIhnA98URNSfyf41EGUoxZkAnWOIqPT5k7/Qf5sSmK8vzzz2/evPlApX1MTExaWlpRUdG55557zjnnHJ5A33jjja+++qqmpubA5kiTyZSTkzN27Njzzz9/yZIlR9yllpaWO++8c2i0PQAQQpxO58MPP3xQNznG2NatWx988MFDNUQRQqKiopKTk7Oysk455ZSzzz47JyfnUJ/+2Wef/fnPf962bduwA5FledSoUbNnz7744osnTZpE/mfSL2QkTrFDkCLtvbtrBKYINjOWJWdNG6MMYRy+4sP4fkJR0ZIeJQgYB7X0xWelnTbrBwlzVFV95ZVXDnQRZYz5fL6Ojo6ysrJNmza5XK5JkyYddE7Ru+++e9ttt7322mstLS0HbWPXdb23t3f37t2bNm0aGBgoLS090LMj9HPffPPN//znP8Pu0L29vUuXLj1ULLl9+/bDNP8Y6tfu7u6ampq1a9du27ZNEISSkpIDT/hXX331u9/9btOmTQceCKW0p6dn69ate/fuXbx48Y86WQHHuRk0BKLZnLFwrt8bFAUhKj81qiCN6RRYOMIK43vROUlxVsEkEI2DIzLznIU/1FIRIXTEtXZzc/PDDz/86KOPDps4DwD//ve/b7jhhvXr14+kf7GpqemPf/zjjTfeeKABCoRM2XvzzTcPGqKuXLnyUJ8S2kEPR5opvXr16ptuuunee+8dxpU9PT133XVXdXX14beQlZV1Es7vPFloFABixo42xacRncsOa9KcUsluoQf8bsII4zhI7q2SHGdFHKhK0844zZGVdpJkYzDG06dP/+Uvfzl37txQZlcU5dlnnw2dOA8An3zyyR133NHU1HSgZVRaWlpubu6BwaOmaf/6178efPDBQ3l8lJWV7dix48AEkaZpy5YtG4mPiXFvsNlsERERDofjoJFvV1fXI4888vDDDxvz7IwoeM2aNUPTRGD/4PgLLrjg/PPPLywsHOLQ2267zf6DNuzCSZsbHQpI086Y3/LG247oiKjCjMQpha1fbgPKgISX9mEcN9JCCJmSHMQkiApHcXG555918lQtBEFYuHDhb37zm56envfff//hhx8e8qDr6+t76623Jk+ebESvra2td91117ApwXa7/Sc/+cm8efPS0tIEQXC73Zs3b37//feH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';  /* Alex Fraser Group, for the daily program PDF */

/* ---------- TeamCal import: reading the export ---------- */
/* TeamCal columns: Name (crew), Start Date, End Date, Summary (customer - quote - site (Project No.)),
   Location (quantities, e.g. "14,086m2 @ 90mm EME = 3,106 tons (7 Shifts)"). */
const TC_CUSTOMER_FIX={'wisnlow':'Winslow','bmd con':'BMD'};
const TC_KNOWN_CUSTOMER={'402236':'CMB'}; /* Old Gympie Rd, Caboolture: TeamCal doesn't name the customer */
const tcNum=s=>parseFloat(String(s).replace(/,/g,''));
const tcIsQuote=s=>/^\d{2}\/?\d{4,5}[A-Z]?$/i.test(String(s).trim());
function tcParseSummary(raw){
  let s=String(raw||'').replace(/\^/g,'').replace(/\s+/g,' ').trim();
  let projectNo='';
  s=s.replace(/\(\s*Project\s*No\.?\s*([\w\/-]+)\s*\)/i,(m,p)=>{projectNo=p;return ''}).trim();
  const parts=s.split(/\s*-\s+/).map(x=>x.trim()).filter(Boolean);
  let customer='',quoteNo='',site='';
  const lead=parts[0]?parts[0].match(/^(\d{2}\/?\d{4,5}[A-Z]?)\s+(.+)$/i):null;
  if(lead){quoteNo=lead[1];site=[lead[2],...parts.slice(1)].join(' - ')}
  else if(parts.length>=3&&tcIsQuote(parts[1])){customer=parts[0];quoteNo=parts[1];site=parts.slice(2).join(' - ')}
  else if(parts.length>=2){customer=parts[0];site=parts.slice(1).join(' - ')}
  else site=parts[0]||'';
  customer=TC_CUSTOMER_FIX[customer.toLowerCase()]||customer;
  if(!customer&&projectNo&&TC_KNOWN_CUSTOMER[projectNo])customer=TC_KNOWN_CUSTOMER[projectNo];
  return {customer,quoteNo,site,projectNo};
}
function tcParseMix(t){
  let m;
  if(/\bEME\s*2?\b/i.test(t))return 'EME2';
  if(/\bSMA\s*\d*/i.test(t))return 'SMA';
  if((m=t.match(/\bType[-\s]?(\d)/i)))return 'Type'+m[1];
  if((m=t.match(/\bAC\s*(\d+)/i)))return 'AC'+m[1];
  if((m=t.match(/\bDG\s*(\d+)/i)))return 'DG'+m[1];
  return '';
}
function tcParseBinder(t,mix){
  if(/BIO\s*BINDER\s*C320|C320\s*BIO/i.test(t))return 'C320 Bio';
  for(const b of ['A15E','C600','C320','MG']){if(new RegExp('\\b'+b+'\\b','i').test(t))return b}
  if(mix==='EME2')return 'EME2';
  if(mix==='SMA')return 'A15E';
  return '';
}
/* one "segment" of the Location text: area, depth, mix, binder, tonnes, shift count */
function tcParseSegment(seg){
  const t=String(seg);
  const tons=[...t.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:tonnes|tonne|tons|ton|t)\b/gi)].map(m=>tcNum(m[1]));
  const tonnes=tons.length?tons[tons.length-1]:0;
  const am=t.match(/([\d,]+(?:\.\d+)?)\s*m(?:2|²)/i);
  const dm=t.match(/([\d.]+)\s*mm/i);
  const sm=t.match(/\(\s*(\d+)\s*shifts?\s*\)/i);
  const mix=tcParseMix(t);
  return {tonnes,area:am?tcNum(am[1]):0,depth:dm?tcNum(dm[1]):0,mix,binder:tcParseBinder(t,mix),shifts:sm?Number(sm[1]):0,text:t.trim()};
}
const tcRound=v=>Math.round(v*10)/10;
/* spread a booking's tonnes over its days: "(N Shifts)" means the total is shared by N shifts,
   given out day by day in order; without it, the total is split evenly across the booking's days */
function tcAllocate(dates,segments){
  const out={};const add=(k,l)=>{(out[k]=out[k]||{lines:[]}).lines.push(l)};
  const asphalt=segments.filter(s=>s.tonnes>0);
  if(!asphalt.length)return {shiftData:null,warnings:[]};
  const warnings=[];
  if(asphalt.some(s=>s.shifts)){
    let at=0;
    asphalt.forEach((s,si)=>{
      const n=s.shifts||Math.max(1,dates.length-at);
      const use=dates.slice(at,at+n);
      if(!use.length){warnings.push(`${s.mix||'A mix'} (${s.tonnes} t) didn’t fit in the booking’s days`);return}
      const per=s.tonnes/n,perA=s.area/n;
      use.forEach(k=>add(k,{type:s.mix,binder:s.binder,tonnes:tcRound(per),area:Math.round(perA)||'',depth:s.depth||''}));
      if(n>use.length)warnings.push(`${s.mix||'Mix'}: ${n} shifts in TeamCal, ${use.length} in this booking (${tcRound(per)} t each)`);
      if(asphalt.length>1)at+=use.length;
    });
  }else{
    asphalt.forEach(s=>{
      const n=dates.length;let left=s.tonnes;
      dates.forEach((k,i)=>{const t=i===n-1?tcRound(left):tcRound(s.tonnes/n);left-=t;
        add(k,{type:s.mix,binder:s.binder,tonnes:t,area:Math.round(s.area/n)||'',depth:s.depth||''})});
    });
  }
  asphalt.filter(s=>!s.mix).forEach(s=>warnings.push(`No mix type found in “${s.text}”`));
  return {shiftData:out,warnings};
}
function tcDays(start,end){const out=[];for(let d=parse(start);iso(d)<=end;d=addDays(d,1))out.push(iso(d));return out}
/* rows: [{name,start,end,summary,location}] (dates as YYYY-MM-DD) -> bookings ready to map onto crews/jobs */
function tcParseRows(rows){
  return rows.filter(r=>r&&r.name&&r.start).map((r,i)=>{
    const end=r.end&&r.end>=r.start?r.end:r.start;
    const sum=tcParseSummary(r.summary);
    const loc=String(r.location||'').replace(/\s+/g,' ').trim();
    const segs=loc.split(/\s*\/\/\s*/).map(tcParseSegment);
    const dates=tcDays(r.start,end);
    const {shiftData,warnings}=tcAllocate(dates,segs);
    return {row:i+2,crewName:String(r.name).trim(),start:r.start,end,...sum,notes:loc,shiftData,warnings,
      tonnes:segs.reduce((a,s)=>a+s.tonnes,0),
      importKey:['tc',String(r.name).trim(),r.start,end,String(r.summary||'').trim(),loc].join('|')};
  });
}

/* ---------- TeamCal import: reading the file, review, and adding to the roster ---------- */
const tcCellText=v=>{if(v==null)return '';if(v instanceof Date)return v;if(typeof v==='object'){if(v.richText)return v.richText.map(r=>r.text).join('');if(v.text!=null)return String(v.text);if(v.result!=null)return v.result instanceof Date?v.result:String(v.result)}return String(v)};
const tcDateKey=v=>{
  if(v instanceof Date)return `${v.getUTCFullYear()}-${pad(v.getUTCMonth()+1)}-${pad(v.getUTCDate())}`;
  const s=String(v||'').trim();let m;
  if((m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)))return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  if((m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)))return `${m[3].length===2?'20'+m[3]:m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  return '';
};
async function readTeamCalFile(file){
  const ExcelJS=await loadExcelJS();const wb=new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws=wb.worksheets[0];if(!ws)throw new Error('The file has no sheets.');
  const head={};ws.getRow(1).eachCell((c,i)=>{head[String(tcCellText(c.value)).trim().toLowerCase()]=i});
  const col=n=>head[n];
  const need=['name','start date','end date','summary','location'];
  const missing=need.filter(n=>!col(n));
  if(missing.length)throw new Error(`This doesn’t look like a TeamCal export. Missing column${missing.length>1?'s':''}: ${missing.join(', ')}.`);
  const rows=[];
  for(let r=2;r<=ws.rowCount;r++){const row=ws.getRow(r);const g=n=>tcCellText(row.getCell(col(n)).value);
    const name=String(g('name')).trim();if(!name)continue;
    rows.push({name,start:tcDateKey(g('start date')),end:tcDateKey(g('end date')),summary:String(g('summary')),location:String(g('location'))});}
  return rows;
}
const tcPretty=n=>{const s=n.replace(/^SUB\s*-\s*/i,'').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()).replace(/\bAfa\b/g,'AFA');return /^SUB\s*-/i.test(n)?`${s} (sub)`:s};
const tcWorkType=n=>/seal/i.test(n)?'Seal':/small/i.test(n)?'Small works':'Paving';
const tcJobKey=b=>(b.customer||'').toLowerCase()+'|'+(b.site||'').toLowerCase();

/* add the reviewed TeamCal bookings to the roster data */
function applyTeamCalImport(d,{bookings,crewMap,customers}){
  let resources=[...d.resources],jobs=[...d.jobs],blocks=[...d.blocks];
  const crewId={};let newCrews=0,newJobs=0,added=0;
  Object.entries(crewMap).forEach(([tcName,m])=>{
    if(m.use!=='new'){crewId[tcName]=m.use;return}
    const id='c'+uid();const n=resources.filter(r=>r.type==='crew').length;
    resources.push({id,type:'crew',name:m.name.trim()||tcPretty(tcName),sub:m.sub.trim()||'Paving',hue:CREW_HUES[n%CREW_HUES.length],visible:true});
    crewId[tcName]=id;newCrews++;
  });
  const jobFor={};
  bookings.forEach(b=>{const key=tcJobKey(b);if(jobFor[key])return;
    const cust=(customers[key]??b.customer).trim();
    const proj=bookings.filter(x=>tcJobKey(x)===key).map(x=>x.projectNo).find(Boolean)||'';
    let j=jobs.find(x=>proj&&x.projectNo===proj)||jobs.find(x=>x.name.trim().toLowerCase()===b.site.toLowerCase()&&(x.customer||'').trim().toLowerCase()===cust.toLowerCase());
    if(!j){j={id:'j'+uid(),name:b.site,customer:cust,address:b.site,projectNo:proj,hue:JOB_HUES[jobs.length%JOB_HUES.length]};jobs.push(j);newJobs++}
    else if(proj&&!j.projectNo){j={...j,projectNo:proj};jobs=jobs.map(x=>x.id===j.id?j:x)}
    jobFor[key]=j.id;
  });
  const have=new Set(blocks.flatMap(b=>[b.importKey,...(b.importKeys||[])]).filter(Boolean));
  bookings.forEach(b=>{if(have.has(b.importKey)||!crewId[b.crewName])return;
    blocks.push({id:uid(),resourceId:crewId[b.crewName],kind:'job',title:'',start:b.start,end:b.end,shift:'day',
      jobId:jobFor[tcJobKey(b)],address:b.site,plantIds:[],...(b.quoteNo?{quoteNo:b.quoteNo}:{}),...(b.projectNo?{projectNo:b.projectNo}:{}),
      notes:b.notes,weekendShifts:true,satShift:true,sunShift:true,...(b.shiftData?{shiftData:b.shiftData}:{}),importKey:b.importKey});
    added++});
  /* mixes and binders the roster doesn't know yet */
  const mixes=[...mixTypesOf(d)],binders=[...bindersOf(d)];
  bookings.forEach(b=>Object.values(b.shiftData||{}).forEach(q=>q.lines.forEach(l=>{
    if(l.type&&!mixes.some(m=>m.toLowerCase()===l.type.toLowerCase()))mixes.push(l.type);
    if(l.binder&&!binders.some(m=>m.toLowerCase()===l.binder.toLowerCase()))binders.push(l.binder)})));
  return {data:{...d,resources,jobs,blocks,mixTypes:mixes,binders},added,newCrews,newJobs};
}

/* ---------- merging bookings that were split over a weekend ---------- */
/* Before Saturday/Sunday could be switched per booking, one job was often entered as several bookings
   (e.g. Wed–Fri, then Mon–Tue). Bookings for the same job, crew and shift whose gap is only weekend days
   (or no gap at all; for night works a gap may include Friday) are joined into one — paving crews only; a weekend day stays a shift only if one of the old bookings worked it. */
function mergePlan(data){
  const groups=new Map();
  const pav=new Set(data.resources.filter(isPavingCrew).map(r=>r.id));   /* paving crews only */
  data.blocks.filter(b=>b.kind==='job'&&pav.has(b.resourceId)&&b.jobId&&b.start&&b.end).forEach(b=>{
    const k=[b.resourceId,b.jobId,b.shift||'day'].join('|');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(b)});
  const plans=[];
  groups.forEach(list=>{
    list.sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:0);
    let run=[list[0]],endMax=list[0].end;
    const flush=()=>{if(run.length>1)plans.push(run)};
    for(let i=1;i<list.length;i++){const b=list[i];let ok=true;
      for(let d=addDays(parse(endMax),1);iso(d)<b.start;d=addDays(d,1))if(!isWeekend(d)&&!(d.getDay()===5&&b.shift==='night')){ok=false;break}
      if(ok){run.push(b);if(b.end>endMax)endMax=b.end}else{flush();run=[b];endMax=b.end}}
    flush()});
  return plans.sort((a,b)=>a[0].start<b[0].start?-1:1);
}
function mergeRun(run){
  const start=run.map(b=>b.start).sort()[0],end=run.map(b=>b.end).sort().slice(-1)[0];
  const works=(b,dow)=>{for(let d=parse(b.start);iso(d)<=b.end;d=addDays(d,1))if(d.getDay()===dow&&worksOn(b,d))return true;return false};
  const sd={};run.forEach(b=>Object.entries(b.shiftData||{}).forEach(([k,v])=>{if(!sd[k])sd[k]=v}));
  const pick=f=>run.map(b=>b[f]).find(v=>v&&String(v).trim())||'';
  const notes=[...new Set(run.map(b=>(b.notes||'').trim()).filter(Boolean))].join('\n');
  const keys=[...new Set(run.flatMap(b=>[b.importKey,...(b.importKeys||[])]).filter(Boolean))];
  const out={...run[0],start,end,satShift:run.some(b=>works(b,6)),sunShift:run.some(b=>works(b,0)),
    ...(run[0].shift==='night'?{friShift:run.some(b=>works(b,5))}:{}),
    plantIds:[...new Set(run.flatMap(b=>b.plantIds||[]))],address:pick('address'),quoteNo:pick('quoteNo'),projectNo:pick('projectNo'),notes};
  if(Object.keys(sd).length)out.shiftData=sd;else delete out.shiftData;
  if(keys.length)out.importKeys=keys;
  const off=[...new Set(run.flatMap(b=>b.offDays||[]))].sort();if(off.length)out.offDays=off;else delete out.offDays;
  return out;
}
function MergeSplits({data,setData,onClose,notify}){
  const plans=useMemo(()=>mergePlan(data),[]);
  const [on,setOn]=useState(()=>plans.map(()=>true));
  useEffect(()=>{const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);
  const rng=b=>b.start===b.end?`${WD[parse(b.start).getDay()]} ${fmtShort(parse(b.start))}`:`${WD[parse(b.start).getDay()]} ${fmtShort(parse(b.start))} – ${WD[parse(b.end).getDay()]} ${fmtShort(parse(b.end))}`;
  const n=on.filter(Boolean).length;
  const run=()=>{const chosen=plans.filter((_,i)=>on[i]);
    setData(d=>{const drop=new Set(chosen.flatMap(r=>r.map(b=>b.id)));
      const merged=new Map(chosen.map(r=>[r[0].id,mergeRun(r.map(b=>d.blocks.find(x=>x.id===b.id)||b))]));
      return {...d,blocks:d.blocks.flatMap(b=>merged.has(b.id)?[merged.get(b.id)]:drop.has(b.id)?[]:[b])}});
    setTimeout(()=>notify(`Merged into ${chosen.length} booking${chosen.length===1?'':'s'}`),0);onClose()};
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full max-w-[640px] flex flex-col max-h-full overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="mg-title">
      <div class="px-5 pt-5 pb-3 border-b border-line flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div id="mg-title" class="font-display text-[18px] font-semibold">Merge split bookings</div>
          <div class="text-[12.5px] text-muted">Paving crew bookings for the same job, crew and shift with only a weekend (or nothing) between them; for night works Friday counts as weekend. Weekend days nobody booked are greyed out.</div>
        </div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
      </div>
      <div class="overflow-y-auto p-3 grid gap-2">
        ${plans.length===0&&html`<div class="text-[13px] text-muted p-3">Nothing to merge. No paving job has bookings split over a weekend.</div>`}
        ${plans.map((r,i)=>{const m=mergeRun(r);const j=data.jobs.find(x=>x.id=== r[0].jobId);const crew=data.resources.find(x=>x.id===r[0].resourceId);
          const wk=[m.shift==='night'&&!m.friShift&&'Fri',!m.satShift&&'Sat',!m.sunShift&&'Sun'].filter(Boolean);const offs=(m.offDays||[]).map(k=>`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}`);
          return html`<label key=${r[0].id} class="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5 cursor-pointer hover:bg-sunken">
            <input type="checkbox" class="w-4 h-4 mt-0.5" style=${{accentColor:'var(--accent)'}} checked=${on[i]} onChange=${e=>setOn(o=>o.map((v,k)=>k===i?e.target.checked:v))}/>
            <span class="min-w-0 grid gap-0.5">
              <span class="text-[13px] font-medium truncate">${jobLabel(j)}</span>
              <span class="text-[12px] text-muted">${crew?crew.name:''}${r[0].shift==='night'?' · night':''} · ${r.map(rng).join('  +  ')}</span>
              <span class="text-[12px]">→ <span class="font-medium">${rng(m)}</span>${wk.length?html`<span class="text-muted"> · ${wk.join(' & ')} greyed out</span>`:''}${offs.length?html`<span class="text-muted"> · day off ${offs.join(', ')}</span>`:''}</span>
            </span></label>`})}
      </div>
      <div class="px-5 py-3 border-t border-line flex items-center gap-2">
        <span class="text-[12px] text-muted mr-auto">Quantities, plant and notes from every part are kept.</span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="button" class="btn btn-primary" disabled=${!n} onClick=${run}>Merge ${n}</button>
      </div>
    </div>
  </div>`;
}
function TeamCalImport({data,setData,onClose,notify}){
  const [step,setStep]=useState('pick');const [err,setErr]=useState('');const [busy,setBusy]=useState(false);
  const [parsed,setParsed]=useState([]);const [crewMap,setCrewMap]=useState({});const [customers,setCustomers]=useState({});
  useEffect(()=>{const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);
  const crews=data.resources.filter(r=>r.type==='crew');
  const pick=async e=>{const file=e.target.files&&e.target.files[0];if(!file)return;setBusy(true);setErr('');
    try{const rows=await readTeamCalFile(file);const bk=tcParseRows(rows);
      if(!bk.length)throw new Error('No bookings found in that file.');
      const cm={};[...new Set(bk.map(b=>b.crewName))].forEach(n=>{
        const ex=crews.find(c=>c.name.toLowerCase()===n.toLowerCase()||c.name.toLowerCase()===tcPretty(n).toLowerCase());
        cm[n]=ex?{use:ex.id,name:ex.name,sub:ex.sub}:{use:'new',name:tcPretty(n),sub:tcWorkType(n)}});
      setParsed(bk);setCrewMap(cm);setCustomers({});setStep('review');
    }catch(x){setErr(x.message||'Couldn’t read that file.')}finally{setBusy(false);e.target.value=''}};
  const have=new Set(data.blocks.flatMap(b=>[b.importKey,...(b.importKeys||[])]).filter(Boolean));
  const fresh=parsed.filter(b=>!have.has(b.importKey));
  const groups=[];fresh.forEach(b=>{const k=tcJobKey(b);let g=groups.find(x=>x.key===k);if(!g){g={key:k,site:b.site,customer:b.customer,projectNo:'',n:0,t:0};groups.push(g)}
    g.n++;g.t+=b.tonnes;if(b.projectNo&&!g.projectNo)g.projectNo=b.projectNo});
  const warnings=fresh.flatMap(b=>b.warnings.map(w=>`${fmtShort(parse(b.start))} · ${b.site}: ${w}`));
  const missingCust=groups.filter(g=>!(customers[g.key]??g.customer).trim()).length;
  const run=()=>{setData(d=>{const r=applyTeamCalImport(d,{bookings:fresh,crewMap,customers});
      setTimeout(()=>notify(`Imported ${r.added} booking${r.added===1?'':'s'}${r.newJobs?` · ${r.newJobs} new job${r.newJobs===1?'':'s'}`:''}${r.newCrews?` · ${r.newCrews} new crew${r.newCrews===1?'':'s'}`:''}`),0);
      return r.data});onClose()};
  const fs={height:30,fontSize:13};
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full ${step==='review'?'max-w-[920px]':'max-w-[460px]'} flex flex-col max-h-full overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="tc-title">
      <div class="px-5 pt-5 pb-3 border-b border-line flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div id="tc-title" class="font-display text-[18px] font-semibold">Import from TeamCal</div>
          <div class="text-[12.5px] text-muted">${step==='review'?'Check the details, then import. Nothing is added until you click Import.':'Upload the Excel export from TeamCal.'}</div>
        </div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
      </div>
      ${step==='pick'
        ?html`<div class="p-5 grid gap-3">
            <label class="grid gap-2 place-items-center text-center rounded-xl border-2 border-dashed border-line px-4 py-8 cursor-pointer hover:bg-sunken">
              <span class="font-medium">${busy?'Reading…':'Choose the TeamCal .xlsx file'}</span>
              <span class="text-[12px] text-muted">Columns needed: Name, Start Date, End Date, Summary, Location</span>
              <input id="tc-file" type="file" accept=".xlsx" class="sr-only" onChange=${pick} disabled=${busy}/>
            </label>
            ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
            <p class="text-[12px] text-muted">Each TeamCal booking becomes a crew job. Tonnes are spread across the booking’s days: when TeamCal says “(N Shifts)”, each shift gets the total ÷ N. Bookings already imported are skipped, so you can import an updated export again.</p>
          </div>`
        :html`<div class="flex-1 min-h-0 overflow-y-auto p-5 grid gap-6">
            <div class="flex flex-wrap gap-2 text-[12.5px]">
              <span class="px-2.5 py-1 rounded-full bg-sunken border border-line"><b>${fresh.length}</b> booking${fresh.length===1?'':'s'} to add</span>
              ${parsed.length>fresh.length&&html`<span class="px-2.5 py-1 rounded-full bg-sunken border border-line">${parsed.length-fresh.length} already imported, skipped</span>`}
              <span class="px-2.5 py-1 rounded-full bg-sunken border border-line">${groups.length} job${groups.length===1?'':'s'}</span>
              <span class="px-2.5 py-1 rounded-full bg-sunken border border-line">${fmtN(Math.round(fresh.reduce((a,b)=>a+b.tonnes,0)))} t</span>
            </div>
            <section class="grid gap-2"><h3 class="font-display text-[15px] font-semibold">Crews</h3>
              <p class="text-[12px] text-muted -mt-1">Match each TeamCal name to a crew, or add it as a new crew.</p>
              ${Object.entries(crewMap).map(([n,m])=>html`<div key=${n} class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
                <span class="mono text-[12.5px] font-semibold w-[150px] truncate" title=${n}>${n}</span><span class="text-muted">→</span>
                <select id=${'tc-crew-'+n} class="field field-sm w-auto" style=${fs} value=${m.use} onChange=${e=>setCrewMap({...crewMap,[n]:{...m,use:e.target.value}})}>
                  <option value="new">New crew…</option>
                  ${crews.map(c=>html`<option key=${c.id} value=${c.id}>${c.name} · ${c.sub}</option>`)}</select>
                ${m.use==='new'&&html`<input id=${'tc-cn-'+n} class="field field-sm w-[150px]" style=${fs} value=${m.name} onInput=${e=>setCrewMap({...crewMap,[n]:{...m,name:e.target.value}})} aria-label="New crew name"/>
                  <input id=${'tc-cs-'+n} list="work-types-tc" class="field field-sm w-[130px]" style=${fs} value=${m.sub} onInput=${e=>setCrewMap({...crewMap,[n]:{...m,sub:e.target.value}})} aria-label="Type of work"/>`}
              </div>`)}
              <datalist id="work-types-tc"><option value="Paving"></option><option value="Seal"></option><option value="Small works"></option></datalist>
            </section>
            <section class="grid gap-2"><h3 class="font-display text-[15px] font-semibold">Jobs</h3>
              ${missingCust>0&&html`<p class="text-[12px] -mt-1" style=${{color:'var(--warn)'}}>${missingCust} job${missingCust===1?' has':'s have'} no customer in TeamCal. Fill ${missingCust===1?'it':'them'} in below.</p>`}
              <div class="rounded-lg border border-line overflow-x-auto">
                <table class="w-full text-[12.5px]"><thead><tr class="bg-sunken text-left">
                  <th class="label px-3 py-2">Customer</th><th class="label px-3 py-2">Job / site</th><th class="label px-3 py-2">Project no.</th><th class="label px-3 py-2 text-right">Bookings</th><th class="label px-3 py-2 text-right">Tonnes</th></tr></thead>
                  <tbody>${groups.map(g=>{const c=customers[g.key]??g.customer;return html`<tr key=${g.key} class="border-t border-line">
                    <td class="px-3 py-1.5"><input id=${'tc-cu-'+g.key} class="field field-sm w-[120px]" style=${{...fs,borderColor:c.trim()?'var(--line)':'var(--warn)'}} value=${c} placeholder="Customer" onInput=${e=>setCustomers({...customers,[g.key]:e.target.value})}/></td>
                    <td class="px-3 py-1.5">${g.site}</td><td class="px-3 py-1.5 mono">${g.projectNo||html`<span class="text-faint">–</span>`}</td>
                    <td class="px-3 py-1.5 text-right tnum">${g.n}</td><td class="px-3 py-1.5 text-right tnum">${g.t?fmtN(Math.round(g.t)):'–'}</td></tr>`})}</tbody></table>
              </div>
            </section>
            ${warnings.length>0&&html`<section class="grid gap-1.5"><h3 class="font-display text-[15px] font-semibold">Check these</h3>
              <ul class="text-[12.5px] grid gap-1">${warnings.map((w,i)=>html`<li key=${i} class="flex gap-2"><span style=${{color:'var(--warn)'}}>${Icon.alert}</span><span>${w}</span></li>`)}</ul>
              <p class="text-[12px] text-muted">You can fix any of these in the booking afterwards.</p></section>`}
            <section class="grid gap-2"><h3 class="font-display text-[15px] font-semibold">Bookings</h3>
              <div class="rounded-lg border border-line max-h-[260px] overflow-y-auto">
                ${fresh.map(b=>{const days=Object.keys(b.shiftData||{}).length;return html`<div key=${b.importKey} class="px-3 py-2 border-b border-line last:border-b-0 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px]">
                  <span class="mono w-[118px] shrink-0">${fmtShort(parse(b.start))}${b.end!==b.start?' – '+fmtShort(parse(b.end)):''}</span>
                  <span class="w-[130px] shrink-0 truncate text-muted">${crewMap[b.crewName]?.use==='new'?crewMap[b.crewName].name:(crews.find(c=>c.id===crewMap[b.crewName]?.use)?.name||b.crewName)}</span>
                  <span class="min-w-0 flex-1 truncate"><b>${(customers[tcJobKey(b)]??b.customer)||'?'}</b> · ${b.site}${b.quoteNo?html` <span class="text-faint mono">Q ${b.quoteNo}</span>`:''}</span>
                  <span class="tnum text-muted shrink-0">${b.shiftData?`${fmtN(Math.round(Object.values(b.shiftData).reduce((a,q)=>a+q.lines.reduce((x,l)=>x+num(l.tonnes),0),0)))} t over ${days} shift${days===1?'':'s'}`:'No asphalt'}</span>
                </div>`})}
              </div></section>
          </div>
          <div class="px-5 py-3 border-t border-line bg-sunken flex flex-wrap items-center gap-2">
            <span class="text-[12px] text-muted mr-auto">Shifts are set to day works and include weekends. Change them in each booking if needed.</span>
            <button type="button" class="btn" onClick=${()=>setStep('pick')}>Choose another file</button>
            <button type="button" class="btn btn-primary" disabled=${!fresh.length} onClick=${run}>Import ${fresh.length} booking${fresh.length===1?'':'s'}</button>
          </div>`}
    </div>
  </div>`;
}

/* ---------- removing the sample data ---------- */
/* The sample roster uses fixed ids (crews c1–c4, staff s0–s12, machines m0–m6, plant a0, jobs j1–j8).
   Anything imported or added by people has different ids, so it is left alone. */
const SAMPLE_RES=new Set(['c1','c2','c3','c4',...Array.from({length:13},(_,i)=>'s'+i),...Array.from({length:7},(_,i)=>'m'+i)]);
const SAMPLE_JOBS=new Set(Array.from({length:8},(_,i)=>'j'+(i+1)));
const SAMPLE_PLANT_TITLES=new Set(['Burner service','Drum flight repairs','One silo only']);
function sampleParts(d){
  const res=d.resources.filter(r=>SAMPLE_RES.has(r.id));const rid=new Set(res.map(r=>r.id));
  const blocks=d.blocks.filter(b=>!b.importKey&&(rid.has(b.resourceId)||(b.resourceId==='a0'&&SAMPLE_PLANT_TITLES.has(b.title))||(b.kind==='job'&&SAMPLE_JOBS.has(b.jobId))));
  const bid=new Set(blocks.map(b=>b.id));
  const keepJobs=new Set(d.blocks.filter(b=>!bid.has(b.id)).map(b=>b.jobId));
  const jobs=d.jobs.filter(j=>SAMPLE_JOBS.has(j.id)&&!keepJobs.has(j.id));
  return {res,blocks,jobs};
}
function removeSampleData(d){
  const p=sampleParts(d);const rid=new Set(p.res.map(r=>r.id)),bid=new Set(p.blocks.map(b=>b.id)),jid=new Set(p.jobs.map(j=>j.id));
  let resources=d.resources.filter(r=>!rid.has(r.id)).map(r=>r.crewId&&rid.has(r.crewId)?{...r,crewId:null}:r);
  /* the sample plant becomes a plain plant with no sample maintenance */
  resources=resources.map(r=>r.id==='a0'&&r.sub==='Narangba'?{...r,sub:'Main plant'}:r);
  const blocks=d.blocks.filter(b=>!bid.has(b.id)).map(b=>b.plantIds&&b.plantIds.some(x=>rid.has(x))?{...b,plantIds:b.plantIds.filter(x=>!rid.has(x))}:b);
  const left=new Set(blocks.map(b=>b.id));
  return {...d,resources,blocks,jobs:d.jobs.filter(j=>!jid.has(j.id)),quoteChanges:(d.quoteChanges||[]).filter(c=>left.has(c.bookingId))};
}
/* ---------- app ---------- */
function App({boot,live}){
  /* ---- live data: local state, saved to Supabase, kept current with everyone else's changes ---- */
  const [data,setDataRaw]=useState(()=>({...boot,sectionOrder:boot.sectionOrder||[...DEFAULT_ORDER]}));
  const savedRef=useRef(data),remoteRef=useRef(null),pushQ=useRef(Promise.resolve());
  const setData=fn=>setDataRaw(cur=>{const next=typeof fn==='function'?fn(cur):fn;
    if(!live.canEdit&&sharedKey(next)!==sharedKey(cur)){setTimeout(()=>setToast('You have view-only access. Ask an administrator for planner access to make changes.'),0);return cur}
    return withChangeLog(cur,next,live.user.email)});
  window.__rosterMe=live.user.email;
  const reloadAll=async()=>{try{const nd={...rowsToData(await fetchAllRows(live.sb))};nd.sectionOrder=nd.sectionOrder||[...DEFAULT_ORDER];remoteRef.current=nd;setDataRaw(nd)}catch(e){}};
  useEffect(()=>{
    writeLocal(LOCAL_HIDDEN,data.resources.filter(r=>r.visible===false).map(r=>r.id));
    if(data.sectionOrder)writeLocal(LOCAL_ORDER,data.sectionOrder);
    if(remoteRef.current===data){savedRef.current=data;return}
    if(!live.canEdit)return;
    const ch=diffRows(savedRef.current,data);savedRef.current=data;
    if(!ch.upserts.length&&!ch.deletes.length)return;
    pushQ.current=pushQ.current.then(()=>pushRows(live.sb,ch)).catch(e=>{setToast('Couldn’t save your last change ('+(e.message||e)+'). Loading the latest roster.');reloadAll()});
  },[data]);
  useEffect(()=>{
    const ch=live.sb.channel('roster-items').on('postgres_changes',{event:'*',schema:'public',table:'items'},ev=>{
      const row=ev.eventType==='DELETE'?ev.old:ev.new;
      if(row&&row.updated_by&&row.updated_by===live.user.id)return;   /* our own change coming back */
      setDataRaw(cur=>{const nd=applyRemote(cur,ev);remoteRef.current=nd;return nd});
    }).subscribe();
    return()=>{live.sb.removeChannel(ch)};
  },[]);
  const [view,setView]=useState(()=>{try{const v=Number(localStorage.getItem(KEY+':view'));return [7,14,30,60].includes(v)?v:7}catch(e){return 7}});
  const [anchor,setAnchor]=useState(()=>mondayOf(TODAY));
  const [editing,setEditing]=useState(null);
  const [drawer,setDrawer]=useState(false);
  const [panel,setPanel]=useState(()=>{try{return localStorage.getItem(KEY+':panel')!=='hidden'}catch(e){return true}});
  useEffect(()=>{try{localStorage.setItem(KEY+':panel',panel?'shown':'hidden')}catch(e){}},[panel]);
  const toggleResources=()=>{let wide=true;try{wide=window.matchMedia('(min-width: 1024px)').matches}catch(e){}
    if(wide)setPanel(p=>!p);else setDrawer(d=>!d)};
  const [tab,setTab]=useState('crew');
  const [renameId,setRenameId]=useState(null);
  const [exporting,setExporting]=useState(null);
  const [importing,setImporting]=useState(false);const [merging,setMerging]=useState(false);const [logOpen,setLogOpen]=useState(false);
  const [forecast,setForecast]=useState(false);const [program,setProgram]=useState(false);
  const [changePw,setChangePw]=useState(false);
  const [notifPrefs,setNotifPrefs]=useState(loadNotifPrefs);
  /* dark mode: remembered per person; until chosen, follows the device setting */
  const [theme,setTheme]=useState(()=>{try{const t=localStorage.getItem(KEY+':theme');if(t==='dark'||t==='light')return t}catch(e){}
    try{return window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){return 'light'}});
  useEffect(()=>{document.documentElement.setAttribute('data-theme',theme)},[theme]);
  const toggleTheme=()=>{const t=theme==='dark'?'light':'dark';setTheme(t);try{localStorage.setItem(KEY+':theme',t)}catch(e){}};
  const onRename=r=>{setTab(r.type);setRenameId(r.id);
    let wide=true;try{wide=window.matchMedia('(min-width: 1024px)').matches}catch(e){}
    if(!wide)setDrawer(true);else setPanel(true)};
  /* collapsed sections and crew groups are remembered in this browser */
  const [collapsed,setCollapsed]=useState(()=>{try{return JSON.parse(localStorage.getItem(KEY+':collapsed')||'{}')||{}}catch(e){return {}}});
  useEffect(()=>{try{localStorage.setItem(KEY+':collapsed',JSON.stringify(collapsed))}catch(e){}},[collapsed]);
  const [toast,setToast]=useState('');
  useEffect(()=>{try{localStorage.setItem(KEY+':view',String(view))}catch(e){}},[view]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),2200);return()=>clearTimeout(t)},[toast]);

  const monthStart=d=>new Date(d.getFullYear(),d.getMonth(),1,12);
  /* 2-month view: from the 1st of the anchor's month to the end of the next month */
  const days=useMemo(()=>{
    if(view===60){const s0=monthStart(anchor),e=new Date(s0.getFullYear(),s0.getMonth()+2,0,12);return Array.from({length:diffDays(s0,e)+1},(_,i)=>addDays(s0,i))}
    return Array.from({length:view},(_,i)=>addDays(anchor,i))},[anchor,view]);
  const N=days.length;
  const step=view===30?28:view;
  const move=dir=>setAnchor(a=>{if(view===60){const s0=monthStart(a);return new Date(s0.getFullYear(),s0.getMonth()+dir,1,12)}return addDays(a,dir*step)});
  const atToday=view===60?monthStart(anchor).getTime()===monthStart(TODAY).getTime():diffDays(mondayOf(TODAY),anchor)===0;
  const pickView=v=>{setView(v);if(v!==60)setAnchor(a=>view===60&&monthStart(a).getTime()===monthStart(TODAY).getTime()?mondayOf(TODAY):mondayOf(a))};
  const onThisRange=TODAY>=days[0]&&TODAY<=days[N-1];

  const vis=t=>data.resources.filter(r=>r.type===t&&r.visible);
  const tk=iso(TODAY);
  const hasToday=(r,test)=>data.blocks.some(b=>b.resourceId===r.id&&covers(b,tk)&&test(b));
  const crewsOnJob=vis('crew').filter(c=>hasToday(c,b=>b.kind==='job'));
  const awayToday=vis('person').filter(p=>hasToday(p,b=>KINDS[b.kind].away));
  const downToday=vis('machine').filter(m=>hasToday(m,b=>KINDS[b.kind].down));
  const cs=vis('crew').map(c=>rowStats(c,data,days));
  const wd=cs.reduce((a,s)=>a+s.workdays,0),jd=cs.reduce((a,s)=>a+s.jobDays,0);
  const util=wd?Math.round(jd/wd*100):0;

  const onCreate=({resourceId,start,end})=>{
    const t=data.resources.find(r=>r.id===resourceId)?.type||'crew';
    const fj=data.jobs.find(j=>!j.completed);
    setEditing({resourceId,start,end,kind:TYPES[t].def,jobId:fj?.id||'__new',shift:'day',title:'',address:fj?.address||'',plantIds:[]});
  };
  const onSave=(b,newMixes=[],jobPatch=null,newJob=null)=>{setData(d=>{const exists=d.blocks.some(x=>x.id===b.id);
    if(newJob)d={...d,jobs:[...d.jobs,newJob]};
    if(jobPatch)d={...d,jobs:d.jobs.map(j=>{if(j.id!==jobPatch.id)return j;let n={...j};
      if('customer' in jobPatch)n.customer=jobPatch.customer;
      if('completed' in jobPatch){if(jobPatch.completed){if(!j.completed){n.completed=true;n.completedAt=iso(TODAY)}}else{delete n.completed;delete n.completedAt}}
      return n})};
    const sealJob=isSealCrew(d.resources.find(r=>r.id===b.resourceId));
    const known=sealJob?sealTypesOf(d):mixTypesOf(d);const sealNames=sealJob?[]:sealTypesOf(d).map(x=>x.toLowerCase());
    const added=newMixes.filter(t=>!known.some(k=>k.toLowerCase()===t.toLowerCase())&&!sealNames.includes(t.toLowerCase()));
    if(added.length)d={...d,[sealJob?'sealTypes':'mixTypes']:[...known,...added]};
    /* log quote number changes for the notifications bell (kept a week) */
    const prev=d.blocks.find(x=>x.id===b.id);
    if(b.kind==='job'&&(prev?.quoteNo||'')!==(b.quoteNo||'')){
      const j=d.jobs.find(x=>x.id===b.jobId);
      const log=(d.quoteChanges||[]).filter(c=>Date.now()-c.at<7*DAY_MS);
      d={...d,quoteChanges:[...log,{id:uid(),bookingId:b.id,from:prev?.quoteNo||'',to:b.quoteNo||'',at:Date.now(),jobName:j?jobLabel(j):'',...(window.__rosterMe?{by:window.__rosterMe}:{})}]};
    }
    return {...d,blocks:exists?d.blocks.map(x=>x.id===b.id?b:x):[...d.blocks,b]}});
    setToast(editing?.id?'Booking saved':'Booking added');setEditing(null)};
  const onDelete=id=>{setData(d=>({...d,blocks:d.blocks.filter(b=>b.id!==id)}));setEditing(null);setToast('Booking deleted')};
  const onReorder=(kind,id,target,after)=>setData(d=>{
    if(kind==='section'){
      const o=orderOf(d).filter(t=>t!==id);let i=o.indexOf(target);if(i<0)return d;if(after)i++;o.splice(i,0,id);
      return {...d,sectionOrder:o};
    }
    const me=d.resources.find(r=>r.id===id);if(!me)return d;
    const sc=scopeOf(me);const slots=[];
    d.resources.forEach((r,i)=>{if(scopeOf(r)===sc)slots.push(i)});
    const mem=slots.map(i=>d.resources[i]).filter(r=>r.id!==id);
    let i=mem.findIndex(r=>r.id===target);if(i<0)return d;if(after)i++;mem.splice(i,0,me);
    const arr=[...d.resources];slots.forEach((s,k)=>{arr[s]=mem[k]});
    return {...d,resources:arr};
  });
  const onMove=b0=>{
    const prev=data.blocks.find(x=>x.id===b0.id);
    const dx=prev?diffDays(parse(prev.start),parse(b0.start)):0;
    let b=b0.shiftData&&dx?{...b0,shiftData:rekeyShifts(b0.shiftData,dx)}:b0;
    if(dx&&b.offDays)b={...b,offDays:b.offDays.map(k=>iso(addDays(parse(k),dx)))};
    setData(d=>({...d,blocks:d.blocks.map(x=>x.id===b.id?b:x)}));
    const who=data.resources.find(r=>r.id===b.resourceId)?.name;
    setToast(`Moved${prev&&prev.resourceId!==b.resourceId?' to '+who:''} · ${fmtShort(parse(b.start))}${b.end!==b.start?' – '+fmtShort(parse(b.end)):''}`);
  };
  const first=data.resources[0];

  const Stat=({k,v,sub,tone})=>html`<div class="min-w-0">
    <div class="label">${k}</div>
    <div class="flex items-baseline gap-1.5 min-w-0"><span class="font-display text-[22px] font-semibold tnum shrink-0" style=${tone?{color:tone}:null}>${v}</span><span class="text-muted text-[12px] truncate">${sub}</span></div>
  </div>`;

  const legend=[['Crews',['job','standby','crewtraining']],['Asphalt plant',['plantmaint','plantreduced']],['Machines',['onjob','service','repair','inspection']],['Staff',['leave','sick','rdo','training']]];

  return html`<div class="shell h-full flex gap-4">
    <div id="resources-panel" class=${'hidden w-[300px] shrink-0 h-full'+(panel?' lg:block':'')}><${Sidebar} data=${data} setData=${setData} days=${days} tab=${tab} setTab=${setTab} renameId=${renameId} setRenameId=${setRenameId} onImport=${()=>setImporting(true)} onMerge=${()=>setMerging(true)}/></div>
    ${drawer&&html`<div class="lg:hidden fixed inset-0 z-40 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)setDrawer(false)}}>
      <div class="h-full w-[min(330px,90vw)] p-3" style=${{paddingLeft:'max(12px, env(safe-area-inset-left, 0px))',paddingTop:'max(12px, env(safe-area-inset-top, 0px))',paddingBottom:'max(12px, env(safe-area-inset-bottom, 0px))'}}>
        <${Sidebar} data=${data} setData=${setData} days=${days} tab=${tab} setTab=${setTab} renameId=${renameId} setRenameId=${setRenameId} onImport=${()=>setImporting(true)} onMerge=${()=>setMerging(true)} onClose=${()=>setDrawer(false)}/></div></div>`}

    <main class="flex-1 min-w-0 h-full flex flex-col gap-3">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button class="btn" onClick=${toggleResources} aria-pressed=${panel} aria-controls="resources-panel"
          title=${panel?'Hide the Resources panel':'Show the Resources panel'}
          style=${panel?{background:'var(--sunken)',borderColor:'var(--line-strong)'}:null}>${Icon.list} Resources</button>
        <div class="flex items-center gap-2 min-w-0">
          <span class="inline-flex w-7 h-7 rounded-md items-center justify-center font-display font-bold text-[13px]" style=${{background:'var(--ink)',color:'var(--surface)'}}>R</span>
          <h1 class="font-display text-[20px] font-semibold tracking-tight truncate">Crew & Plant Roster</h1>
          ${!live.canEdit&&html`<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sunken border border-line text-muted" title="You can look but not change anything">View only</span>`}
        </div>
        <div class="flex-1"></div>
        <div class="seg" role="group" aria-label="View length">
          <button aria-pressed=${view===7} onClick=${()=>pickView(7)}>Week</button>
          <button aria-pressed=${view===14} onClick=${()=>pickView(14)}>14 days</button>
          <button aria-pressed=${view===30} onClick=${()=>pickView(30)}>30 days</button>
          <button aria-pressed=${view===60} onClick=${()=>pickView(60)}>2 months</button>
        </div>
        <div class="flex items-center gap-1">
          <button class="btn px-2" onClick=${()=>move(-1)} aria-label=${view===60?'Previous month':'Previous'}>${Icon.chevL}</button>
          <button class="btn" onClick=${()=>setAnchor(mondayOf(TODAY))} disabled=${atToday}>Today</button>
          <button class="btn px-2" onClick=${()=>move(1)} aria-label=${view===60?'Next month':'Next'}>${Icon.chevR}</button>
        </div>
        <${Notifications} data=${data} onOpen=${b=>setEditing(b)} prefs=${notifPrefs} setPrefs=${p=>{setNotifPrefs(p);try{localStorage.setItem(NOTIF_KEY,JSON.stringify(p))}catch(e){}}}/>
        <button class="btn btn-primary" disabled=${!first} onClick=${()=>onCreate({resourceId:(vis('crew')[0]||first).id,start:iso(onThisRange?TODAY:days[0]),end:iso(onThisRange?TODAY:days[0])})}>${Icon.plus} Booking</button>
        <button class="btn" onClick=${()=>setProgram(true)} title="Daily program PDFs for each job on a day">${Icon.list} Daily program</button>
        <button class="btn" onClick=${()=>setForecast(true)} title="Paving forecast for the next two months">${Icon.chart} Forecast</button>
        <${SettingsMenu} theme=${theme} toggleTheme=${toggleTheme} prefs=${notifPrefs} setPrefs=${p=>{setNotifPrefs(p);try{localStorage.setItem(NOTIF_KEY,JSON.stringify(p))}catch(e){}}} account=${{email:live.user.email,role:live.role,onChangePw:()=>setChangePw(true),onSignOut:()=>live.sb.auth.signOut()}} onLog=${live.role==='admin'?()=>setLogOpen(true):null}/>
      </header>

      <section class="panel px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
        <${Stat} k="Crews on jobs today" v=${`${crewsOnJob.length}/${vis('crew').length}`} sub=${`${util}% of crew-days booked`}/>
        <${Stat} k="Machines down today" v=${downToday.length} sub=${downToday.length?downToday.map(m=>m.name).join(', '):'all available'} tone=${downToday.length?'var(--bad)':null}/>
        <${Stat} k="Staff away today" v=${awayToday.length} sub=${awayToday.length?awayToday.map(m=>m.name.split(' ')[0]).join(', '):'full strength'} tone=${awayToday.length?'var(--warn)':null}/>
        <${Stat} k="Showing" v=${html`<span class="text-[16px]">${fmtRange(days[0],days[N-1])}</span>`} sub=""/>
      </section>

      <section class="panel flex-1 min-h-[320px] flex flex-col overflow-hidden">
        <${Board} data=${data} days=${days} view=${view} onCreate=${onCreate} onEdit=${b=>setEditing(b)} onMove=${onMove} onRename=${onRename} onReorder=${onReorder} onExport=${wks=>setExporting(wks)} notifPrefs=${notifPrefs}
          collapsed=${collapsed} toggleSection=${t=>setCollapsed(c=>({...c,[t]:!c[t]}))}/>
        <div class="border-t border-line px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-muted">
          ${legend.map(([g,ks])=>html`<span key=${g} class="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-semibold text-ink">${g}</span>
            ${ks.map(k=>html`<span key=${k} class="inline-flex items-center gap-1.5">
              <span class="inline-block w-5 h-3 rounded-[3px]" style=${blockStyle({kind:k,resourceId:data.resources.find(r=>r.type==='crew')?.id,crewId:data.resources.find(r=>r.type==='crew')?.id},data)}></span>${k==='job'?'Day job (crew colour)':KINDS[k].label}</span>`)}</span>`)}
          <span class="inline-flex items-center gap-1.5"><span class="inline-flex items-center justify-center w-5 h-3 rounded-[3px]" style=${blockStyle({kind:'job',shift:'night'},data)}>${Icon.moon}</span>Night works</span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block w-5 h-3 rounded-[3px]" style=${{boxShadow:'inset 0 0 0 2px hsl(0 75% var(--blk-edge-l))',backgroundImage:'repeating-linear-gradient(135deg,hsl(0 80% 50% / .16) 0 4px,transparent 4px 8px)'}}></span>Job on a plant maintenance day</span>
          <span class="flex-1"></span>
          <span>Signed in as ${live.user.email}${live.canEdit?'':' · view only'}</span>
        </div>
      </section>
    </main>

    ${changePw&&html`<${SetPassword} sb=${live.sb} onDone=${()=>{setChangePw(false);setToast('Password changed')}} onCancel=${()=>setChangePw(false)}/>`}
    ${forecast&&html`<${ForecastDialog} data=${data} onClose=${()=>setForecast(false)} notify=${setToast}/>`}
    ${program&&html`<${DailyProgramDialog} data=${data} onClose=${()=>setProgram(false)} notify=${setToast}/>`}
    ${importing&&html`<${TeamCalImport} data=${data} setData=${setData} onClose=${()=>setImporting(false)} notify=${setToast}/>`}
    ${merging&&html`<${MergeSplits} data=${data} setData=${setData} onClose=${()=>setMerging(false)} notify=${setToast}/>`}
    ${logOpen&&html`<${ChangeLogDialog} data=${data} onClose=${()=>setLogOpen(false)} onOpen=${b=>setEditing(b)}/>`}
    ${exporting&&html`<${ExportDialog} data=${data} onClose=${()=>setExporting(null)} notify=${setToast}/>`}
    ${editing&&html`<${Editor} initial=${editing} data=${data} onSave=${onSave} onDelete=${onDelete} onClose=${()=>setEditing(null)}/>`}
    ${toast&&html`<div class="fixed left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-[13px] font-medium pop" role="status"
       style=${{bottom:'calc(20px + env(safe-area-inset-bottom, 0px))',background:'var(--ink)',color:'var(--surface)'}}>${toast}</div>`}
  </div>`;
}

/* =====================================================================
   Live data: Supabase storage, sign-in and real-time updates
   ---------------------------------------------------------------------
   Shared records live in one table, public.items (kind, id, data jsonb):
     kind = resource | job | block | quote_change | setting
   Per-person choices stay in this browser: hidden rows, section order,
   view length, dark mode and notification settings.
   ===================================================================== */
const COLLECTIONS=[['resources','resource'],['jobs','job'],['blocks','block'],['quoteChanges','quote_change'],['changeLog','change']];
const ORDERED=new Set(['resources','jobs']);           /* row order matters for these */
const SETTINGS=['mixTypes','binders','mixRap','mixBinder','sealTypes','sealBinder','sealBinders','truckCos','subCos'];
const LOCAL_HIDDEN=KEY+':hidden',LOCAL_ORDER=KEY+':order';
const readLocal=(k,def)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):def}catch(e){return def}};
const writeLocal=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};

/* what gets stored for one record (per-person fields removed) */
const storedForm=(coll,item,i)=>{const {visible,pos,...rest}=item;return ORDERED.has(coll)?{...rest,pos:i}:rest};

/* rows from Supabase -> the app's data object */
function rowsToData(rows){
  const hidden=new Set(readLocal(LOCAL_HIDDEN,[]));
  const d={resources:[],jobs:[],blocks:[],quoteChanges:[],changeLog:[]};
  rows.forEach(r=>{
    if(r.kind==='setting'){if(SETTINGS.includes(r.id))d[r.id]=r.data&&r.data.value;return}
    const c=COLLECTIONS.find(([,k])=>k===r.kind);if(!c)return;
    d[c[0]].push({id:r.id,...r.data});
  });
  ['resources','jobs'].forEach(c=>d[c].sort((a,b)=>(a.pos??0)-(b.pos??0)));
  d.resources=d.resources.map(r=>({...r,visible:!hidden.has(r.id)}));
  const order=readLocal(LOCAL_ORDER,null);if(order)d.sectionOrder=order;d.orderV=2;
  return d;
}

/* the shared part of the data, for comparing (used to keep view-only people read-only) */
const sharedKey=d=>JSON.stringify([COLLECTIONS.map(([c])=>(d[c]||[]).map((x,i)=>storedForm(c,x,i))),SETTINGS.map(k=>d[k])]);

/* work out which rows changed between two versions of the data */
function diffRows(prev,next){
  const upserts=[],deletes=[];
  COLLECTIONS.forEach(([c,kind])=>{
    const before=new Map((prev[c]||[]).map((x,i)=>[x.id,JSON.stringify(storedForm(c,x,i))]));
    const seen=new Set();
    (next[c]||[]).forEach((x,i)=>{seen.add(x.id);const s=storedForm(c,x,i);const j=JSON.stringify(s);
      if(before.get(x.id)!==j){const {id,...data}=s;upserts.push({kind,id:x.id,data})}});
    before.forEach((_,id)=>{if(!seen.has(id))deletes.push({kind,id})});
  });
  SETTINGS.forEach(k=>{if(next[k]!==undefined&&JSON.stringify(prev[k])!==JSON.stringify(next[k]))upserts.push({kind:'setting',id:k,data:{value:next[k]}})});
  return {upserts,deletes};
}

/* apply one real-time change from someone else */
function applyRemote(d,ev){
  const row=ev.eventType==='DELETE'?ev.old:ev.new;if(!row||!row.kind)return d;
  if(row.kind==='setting'){if(ev.eventType==='DELETE'||!SETTINGS.includes(row.id))return d;return {...d,[row.id]:row.data&&row.data.value}}
  const c=COLLECTIONS.find(([,k])=>k===row.kind);if(!c)return d;const coll=c[0];
  let list=(d[coll]||[]).filter(x=>x.id!==row.id);
  if(ev.eventType!=='DELETE'){
    const old=(d[coll]||[]).find(x=>x.id===row.id);
    const item={id:row.id,...row.data};
    if(coll==='resources')item.visible=old?old.visible:!new Set(readLocal(LOCAL_HIDDEN,[])).has(row.id);
    if(ORDERED.has(coll)){const at=Math.max(0,Math.min(list.length,row.data.pos??list.length));list=[...list.slice(0,at),item,...list.slice(at)]}
    else list=[...list,item];
  }
  return {...d,[coll]:list};
}

async function fetchAllRows(sb){
  const all=[];const page=1000;
  for(let from=0;;from+=page){
    const {data,error}=await sb.from('items').select('kind,id,data').range(from,from+page-1);
    if(error)throw error;all.push(...data);if(data.length<page)break;
  }
  return all;
}
async function pushRows(sb,{upserts,deletes}){
  for(let i=0;i<upserts.length;i+=500){const {error}=await sb.from('items').upsert(upserts.slice(i,i+500));if(error)throw error}
  const byKind={};deletes.forEach(x=>{(byKind[x.kind]=byKind[x.kind]||[]).push(x.id)});
  for(const [kind,ids] of Object.entries(byKind)){const {error}=await sb.from('items').delete().eq('kind',kind).in('id',ids);if(error)throw error}
}

/* data for a brand-new, empty roster */
function emptyRoster(){
  return {resources:[{id:'a'+uid(),type:'aplant',name:'Asphalt plant',sub:'Main plant',hue:8,visible:true}],
    jobs:[],blocks:[],quoteChanges:[],changeLog:[],mixTypes:[...ASPHALT_TYPES],binders:[...BINDERS],mixRap:{},mixBinder:{...DEFAULT_MIX_BINDER},sealTypes:[...SEAL_TYPES],sealBinder:{},sealBinders:[...SEAL_BINDERS],truckCos:[...DEFAULT_TRUCKS],subCos:[...DEFAULT_SUBS],
    sectionOrder:[...DEFAULT_ORDER],orderV:2};
}

/* Excel files: save straight to the computer (same call shape the exports already use) */
window.claude=window.claude||{use:async name=>name==='downloads'?{save:async({filename,data})=>{
  const blob=data instanceof Blob?data:new Blob([data]);const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500);return {status:'saved'}}}:null};

/* ---------- sign-in, first run and loading ---------- */
function Centered({children}){
  return html`<div class="min-h-full flex items-center justify-center p-6"><div class="panel w-full max-w-[400px] p-6 flex flex-col gap-4">
    <div class="flex items-center gap-2"><span class="inline-flex w-8 h-8 rounded-md items-center justify-center font-display font-bold" style=${{background:'var(--ink)',color:'var(--surface)'}}>R</span>
      <span class="font-display text-[19px] font-semibold">Crew & Plant Roster</span></div>
    ${children}</div></div>`;
}
function Login({sb}){
  /* Email + password. Accounts are created by an administrator in Supabase with a temporary
     password; on first sign-in the person is asked to choose their own (see SetPassword). */
  const [email,setEmail]=useState('');const [pw,setPw]=useState('');const [show,setShow]=useState(false);
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [forgot,setForgot]=useState(false);
  const signIn=async e=>{e.preventDefault();setBusy(true);setErr('');
    const {error}=await sb.auth.signInWithPassword({email:email.trim(),password:pw});
    setBusy(false);
    if(error)setErr(/invalid login|credentials/i.test(error.message)?'That email or password is wrong.':/not confirmed/i.test(error.message)?'This account isn’t active yet. Ask your administrator to confirm it.':error.message)};
  return html`<${Centered}>
    <form class="flex flex-col gap-3" onSubmit=${signIn}>
      <label class="grid gap-1"><span class="label">Email</span>
        <input id="login-email" type="email" required autocomplete="username" class="field" value=${email} onInput=${e=>setEmail(e.target.value)}/></label>
      <label class="grid gap-1"><span class="label">Password</span>
        <div class="flex gap-2">
          <input id="login-password" type=${show?'text':'password'} required autocomplete="current-password" class="field" value=${pw} onInput=${e=>setPw(e.target.value)}/>
          <button type="button" class="btn shrink-0" onClick=${()=>setShow(x=>!x)} aria-pressed=${show}>${show?'Hide':'Show'}</button>
        </div></label>
      ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      <button class="btn btn-primary justify-center" type="submit" disabled=${busy||!email.trim()||!pw}>${busy?'Signing in…':'Sign in'}</button>
      <button type="button" class="text-[12.5px] underline underline-offset-2 text-muted hover:text-ink self-start" onClick=${()=>setForgot(x=>!x)}>Forgot your password?</button>
      ${forgot&&html`<p class="text-[12.5px] text-muted -mt-1">Ask your administrator to reset it. You’ll get a temporary password and choose a new one when you sign in.</p>`}
    </form>
  <//>`;
}

/* choose your own password: on first sign-in (after a temporary one), or any time from the header */
function SetPassword({sb,first,onDone,onCancel}){
  const [pw,setPw]=useState('');const [pw2,setPw2]=useState('');const [show,setShow]=useState(false);
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const problem=pw.length>0&&pw.length<8?'Use at least 8 characters.':pw2&&pw!==pw2?'The two passwords don’t match.':'';
  const save=async e=>{e.preventDefault();if(problem||!pw||pw!==pw2)return;setBusy(true);setErr('');
    const {error}=await sb.auth.updateUser({password:pw,data:{password_set:true}});
    setBusy(false);
    if(error){setErr(/different/i.test(error.message)?'Choose a password different from your temporary one.':/weak|short|characters/i.test(error.message)?'That password is too weak. Make it longer, or mix in numbers and symbols.':error.message);return}
    onDone()};
  const body=html`<form class="flex flex-col gap-3" onSubmit=${save}>
      <div><div class="font-semibold">${first?'Choose your password':'Change your password'}</div>
        <p class="text-[13px] text-muted mt-1">${first?'You signed in with a temporary password. Choose your own to use from now on.':'Your new password works from your next sign-in.'}</p></div>
      <label class="grid gap-1"><span class="label">New password</span>
        <input id="new-password" type=${show?'text':'password'} autocomplete="new-password" class="field" value=${pw} autoFocus=${true} onInput=${e=>setPw(e.target.value)}/></label>
      <label class="grid gap-1"><span class="label">Type it again</span>
        <input id="new-password-2" type=${show?'text':'password'} autocomplete="new-password" class="field" value=${pw2} onInput=${e=>setPw2(e.target.value)}/></label>
      <label class="inline-flex items-center gap-2 text-[12.5px] text-muted"><input id="show-pw" type="checkbox" checked=${show} onChange=${e=>setShow(e.target.checked)}/> Show passwords</label>
      ${(problem||err)&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${problem||err}</div>`}
      <div class="flex gap-2 justify-end">
        ${onCancel&&html`<button type="button" class="btn" onClick=${onCancel}>Cancel</button>`}
        <button class="btn btn-primary" type="submit" disabled=${busy||!!problem||!pw||pw!==pw2}>${busy?'Saving…':'Save password'}</button>
      </div>
    </form>`;
  if(first)return html`<${Centered}>${body}<//>`;
  return html`<div class="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onCancel()}}>
    <div class="panel pop w-full max-w-[400px] p-5" role="dialog" aria-modal="true">${body}</div></div>`;
}
function FirstRun({canEdit,onStart}){
  const [busy,setBusy]=useState(false);
  return html`<${Centered}>
    ${canEdit
      ?html`<div class="flex flex-col gap-3">
          <div class="font-semibold">Set up your roster</div>
          <p class="text-[13px] text-muted">The roster is empty. Start it, then add your crews, staff and machines in the Resources panel, or bring in your jobs with Import from TeamCal in the Jobs tab.</p>
          <button class="btn btn-primary justify-center" disabled=${busy} onClick=${async()=>{setBusy(true);await onStart(emptyRoster())}}>Start the roster</button>
        </div>`
      :html`<p class="text-[13px] text-muted">The roster hasn’t been set up yet. A planner needs to sign in first.</p>`}
  <//>`;
}
/* people created with a temporary password haven't chosen their own yet */
const needsPw=s=>!(s&&s.user&&s.user.user_metadata&&s.user.user_metadata.password_set);
function Root(){
  const [phase,setPhase]=useState('boot');            /* boot | error | login | loading | empty | ready */
  const [msg,setMsg]=useState('');
  const [sb,setSb]=useState(null);const [session,setSession]=useState(null);
  const [role,setRole]=useState('viewer');const [boot,setBoot]=useState(null);
  useEffect(()=>{(async()=>{
    try{
      const r=await fetch('/api/config',{cache:'no-store'});const cfg=await r.json();
      if(!cfg.url||!cfg.anonKey){setMsg('The app isn’t connected to its database yet. Add SUPABASE_URL and SUPABASE_ANON_KEY in Vercel, then redeploy.');setPhase('error');return}
      const client=window.supabase.createClient(cfg.url,cfg.anonKey);setSb(client);
      const {data:{session:s}}=await client.auth.getSession();setSession(s);setPhase(s?(needsPw(s)?'setpw':'loading'):'login');
      client.auth.onAuthStateChange((_e,s2)=>{setSession(s2);setPhase(p=>s2?(p==='login'?(needsPw(s2)?'setpw':'loading'):p):'login')});
    }catch(e){setMsg('Couldn’t reach the server. Check your connection and reload.');setPhase('error')}
  })()},[]);
  useEffect(()=>{if(phase!=='loading'||!sb||!session)return;(async()=>{
    try{
      const {data:prof}=await sb.from('profiles').select('role').eq('id',session.user.id).maybeSingle();
      const rl=(prof&&prof.role)||'viewer';setRole(rl);
      const rows=await fetchAllRows(sb);
      if(!rows.length){setPhase('empty');return}
      setBoot(rowsToData(rows));setPhase('ready');
    }catch(e){setMsg('Couldn’t load the roster: '+(e.message||e));setPhase('error')}
  })()},[phase,sb,session]);
  const start=async d=>{try{await pushRows(sb,diffRows({},d));setBoot(rowsToData(await fetchAllRows(sb)));setPhase('ready')}catch(e){setMsg('Couldn’t save: '+(e.message||e));setPhase('error')}};
  if(phase==='boot'||phase==='loading')return html`<${Centered}><p class="text-[13px] text-muted">Loading…</p><//>`;
  if(phase==='error')return html`<${Centered}><p class="text-[13px]">${msg}</p><button class="btn" onClick=${()=>location.reload()}>Reload</button><//>`;
  if(phase==='login')return html`<${Login} sb=${sb}/>`;
  if(phase==='setpw')return html`<${SetPassword} sb=${sb} first=${true} onDone=${()=>setPhase('loading')}/>`;
  if(phase==='empty')return html`<${FirstRun} canEdit=${role!=='viewer'} onStart=${start}/>`;
  return html`<${App} boot=${boot} live=${{sb,user:session.user,role,canEdit:role==='admin'||role==='planner'}}/>`;
}


ReactDOM.createRoot(document.getElementById('root')).render(html`<${Root}/>`);
