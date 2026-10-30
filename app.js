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
/* today's date; kept current if the page is left open past midnight (see App) */
let TODAY=(()=>{const t=new Date();t.setHours(12,0,0,0);return t})();
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

/* small label for crews marked as subcontractors (Resources → Crews → edit) */
function SubTag(){return html`<span class="shrink-0 text-[9.5px] font-bold tracking-wide uppercase px-1 py-[1px] rounded border border-line text-muted" title="Subcontractor crew">Sub</span>`}

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
  trash:svg(html`<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,14),
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
  induct:svg(html`<path d="M5 2.5h6M4 2.5h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1v-10a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><path d="M6 1.5h4v2H6z" fill="currentColor"/><path d="M5.5 9l1.8 1.8L10.8 7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,11),
  sap:svg(html`<rect x="1.5" y="3" width="13" height="10" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M4.5 6.5h7M4.5 9.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 14L14 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,11),
  briefcase:svg(html`<rect x="2" y="4.5" width="12" height="9" rx="1.6" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5.8 4.5V3.2c0-.4.3-.7.7-.7h3c.4 0 .7.3.7.7v1.3M2 8.5h12" stroke="currentColor" stroke-width="1.5" fill="none"/>`,15),
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
function ListManager({title,hint,items,setItems,field,placeholder,data,setData,onRenamed,onRemoved,rapOf,binderOf,binderOptions,servicesOf,colorOf,onColor,truckOf,twoCoatOf}){
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
  /* drag to reorder: grab the handle and drop above or below another item (arrow keys on the handle also move it) */
  const listRef=useRef(null);const [drag,setDrag]=useState(null);   /* {from, before} */
  const dragAt=y=>{const rows=listRef.current?[...listRef.current.querySelectorAll('[data-li]')]:[];
    for(let r=0;r<rows.length;r++){const bx=rows[r].getBoundingClientRect();if(y<bx.top+bx.height/2)return r}return rows.length};
  const dragStart=(e,i)=>{if(e.button!==undefined&&e.button!==0)return;e.preventDefault();try{e.currentTarget.setPointerCapture(e.pointerId)}catch(x){}setDrag({from:i,before:i})};
  const dragMove=e=>{if(!drag)return;const b=dragAt(e.clientY);if(b!==drag.before)setDrag({...drag,before:b})};
  const dragEnd=()=>{if(!drag)return;const {from,before}=drag;setDrag(null);const to=before>from?before-1:before;
    if(to===from)return;const l=[...items];const [x]=l.splice(from,1);l.splice(to,0,x);setItems(l)};
  const dropLine=i=>drag&&drag.before===i&&drag.before!==drag.from&&drag.before!==drag.from+1;
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
    <ul class="px-2 py-1" ref=${listRef}>
      ${items.map((t,i)=>{const n=usage.get(t)||0;
        if(editing&&editing.from===t)return html`<li key=${t} data-li="1" class="rounded-lg px-2 py-2 bg-sunken" style=${{boxShadow:'inset 0 0 0 1.5px var(--accent)'}}>
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
            ${twoCoatOf&&html`<label class="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer">
              <input id=${idp+'2c-'+i} type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${!!editing.twoCoat} onChange=${e=>setEditingItem({...editing,twoCoat:e.target.checked})}/>
              Two coat seal <span class="text-muted">(second binder, stone, spray and spread rate)</span></label>`}
            ${truckOf&&html`<div class="grid grid-cols-[1fr_96px] gap-2">
              <label class="grid gap-1 text-[12.5px]"><span class="text-muted">Default driver</span>
                <input id=${idp+'drv-'+i} class="field field-sm" style=${{height:30,fontSize:13}} placeholder="Driver" value=${editing.driver||''} onInput=${e=>setEditingItem({...editing,driver:e.target.value})}/></label>
              <label class="grid gap-1 text-[12.5px]"><span class="text-muted">Default weight</span>
                <select id=${idp+'w-'+i} class="field field-sm mono" style=${{height:30,fontSize:13}} value=${editing.w||''} onChange=${e=>setEditingItem({...editing,w:e.target.value})}>
                  <option value="">None</option>${TRUCK_WEIGHTS.map(w=>html`<option key=${w} value=${w}>${w}</option>`)}</select></label>
              <span class="col-span-2 text-[11px] text-faint -mt-1">Filled in when this truck is picked in a booking.</span></div>`}
            ${servicesOf&&html`<label class="grid gap-1 text-[12.5px]"><span class="text-muted">Services they provide (one per line)</span>
              <textarea id=${idp+'svc-'+i} class="field field-sm" style=${{height:'auto',minHeight:72,padding:'6px 8px',fontSize:13,resize:'vertical'}} rows="3"
                placeholder=${'e.g. Shuttle buggy\nx 3 labourers\nBobcat hire'} value=${editing.services||''} onInput=${e=>setEditingItem({...editing,services:e.target.value})}></textarea></label>`}
            ${msg&&html`<span class="text-[12px]" style=${{color:'var(--bad)'}}>${msg}</span>`}
            <div class="flex gap-1.5 justify-end">
              <button type="button" class="btn btn-ghost" style=${{height:28}} onClick=${()=>{setEditingItem(null);setMsg('')}}>Cancel</button>
              <button type="submit" class="btn btn-primary" style=${{height:28}}>Save</button>
            </div>
          </form></li>`;
        return html`<li key=${t} data-li="1" class="group rounded-lg px-2 py-1 flex items-center gap-2 hover:bg-sunken"
            style=${{opacity:drag&&drag.from===i?.45:1,boxShadow:dropLine(i)?'inset 0 2px 0 var(--accent)':i===items.length-1&&dropLine(items.length)?'inset 0 -2px 0 var(--accent)':'none'}}>
          <span role="button" tabindex="0" class="w-5 h-7 shrink-0 inline-flex items-center justify-center rounded text-faint hover:text-ink hover:bg-surface select-none"
            style=${{cursor:drag?'grabbing':'grab',touchAction:'none'}} title="Drag to reorder"
            aria-label=${'Reorder '+t+'. Drag, or use the up and down arrow keys'}
            onPointerDown=${e=>dragStart(e,i)} onPointerMove=${dragMove} onPointerUp=${dragEnd} onPointerCancel=${()=>setDrag(null)}
            onKeyDown=${e=>{if(e.key==='ArrowUp'){e.preventDefault();move(i,-1)}else if(e.key==='ArrowDown'){e.preventDefault();move(i,1)}}}>${Icon.grip}</span>
          <div class="min-w-0 flex-1">
            <div class="mono font-semibold text-[13.5px] truncate">${t}</div>
            ${rapOf&&rapOf(t)>0&&html`<div class="text-[11.5px] font-medium" style=${{color:'var(--ok)'}}>${fmtN(rapOf(t))}% RAP</div>`}
            ${twoCoatOf&&twoCoatOf(t)&&html`<div class="text-[11.5px] font-medium" style=${{color:'var(--accent)'}}>Two coat</div>`}
            ${truckOf&&(truckOf(t).driver||truckOf(t).w)&&html`<div class="text-[11.5px] text-muted truncate">${[truckOf(t).driver,truckOf(t).w].filter(Boolean).join(' · ')}</div>`}
            ${servicesOf&&servicesOf(t).length>0&&html`<div class="text-[11.5px] text-muted truncate" title=${servicesOf(t).join(', ')}>${servicesOf(t).join(' · ')}</div>`}
          </div>
          ${colorOf&&html`<label class="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded hover:bg-surface cursor-pointer" title="Colour on the daily program PDF">
            <input type="color" class="w-5 h-5 p-0 border-0 bg-transparent cursor-pointer" value=${colorOf(t)} onChange=${e=>onColor(t,e.target.value)} aria-label=${'Daily program colour for '+t}/></label>`}
          ${confirm===t
            ?html`<div class="flex flex-col items-end gap-1 max-w-[150px]">
                ${n>0&&html`<span class="text-[11px] text-muted text-right leading-tight">Bookings using it keep it.</span>`}
                <div class="flex gap-1">
                  <button class="text-[11px] font-semibold px-2 py-0.5 rounded" style=${{background:'hsl(352 70% var(--blk-l))',color:'hsl(352 60% var(--blk-fg-l))'}} onClick=${()=>remove(t)}>Remove</button>
                  <button class="text-[11px] text-muted px-1.5" onClick=${()=>setConfirm(null)}>Keep</button></div></div>`
            :html`<div class="flex items-center gap-0.5 lg:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button class=${iconBtn} onClick=${()=>{const rp=rapOf?rapOf(t):0;setEditingItem({from:t,to:t,hasRap:rp>0,rap:rp>0?String(rp):'',binder:binderOf?binderOf(t):'',services:servicesOf?servicesOf(t).join('\n'):'',driver:truckOf?truckOf(t).driver||'':'',w:truckOf?truckOf(t).w||'':'',twoCoat:twoCoatOf?!!twoCoatOf(t):false});setConfirm(null);setMsg('')}} aria-label=${'Edit '+t} title="Edit">${Icon.pencil}</button>
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
      hint="Seal types offered on Seal crew bookings, in this order. Paving jobs can't pick these. Click the pencil to rename one, set its default binder or mark it as a two coat seal."
      items=${sealTypesOf(data)} setItems=${setter('sealTypes')}
      binderOf=${t=>sealBinderOf(data)[t]||''} binderOptions=${sealBindersOf(data)} twoCoatOf=${t=>sealIsTwoCoat(data,t)}
      onRenamed=${(d,from,to,ed)=>{const mb={...sealBinderOf(d)};delete mb[from];if(ed&&ed.binder)mb[to]=ed.binder;
        const tc={...sealTwoCoatOf(d)};delete tc[from];if(ed&&ed.twoCoat)tc[to]=true;return {...d,sealBinder:mb,sealTwoCoat:tc}}}
      onRemoved=${(d,t)=>{const mb={...sealBinderOf(d)};delete mb[t];const tc={...sealTwoCoatOf(d)};delete tc[t];return {...d,sealBinder:mb,sealTwoCoat:tc}}}/>
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
function Sidebar({data,setData,days,tab,setTab,onClose,onMaint,renameId,setRenameId,onImport,onMerge,screen,onImportMachines,notify}){
  /* Staff and Machines only show on their own screens; the Schedule screen gets everything else */
  const tabOK=t=>screen==='machines'||screen==='fleet'?t==='machine':(t!=='person'&&t!=='machine');   /* staff are managed on the Staff screen (People) */
  const [q,setQ]=useState('');
  const [f,setF]=useState({name:'',sub:'',crewId:''});
  const [confirmId,setConfirmId]=useState(null);
  const [draft,setDraft]=useState({name:'',sub:''});
  useEffect(()=>{const r=data.resources.find(x=>x.id===renameId);if(r){setDraft({name:r.name,sub:r.sub,hue:r.hue,subbie:!!r.subbie,category:r.category||'',rego:r.rego||''});setQ('');setConfirmId(null)}},[renameId]);
  const saveRename=e=>{e.preventDefault();if(!draft.name.trim())return;
    patch(renameId,{name:draft.name.trim(),sub:draft.sub.trim(),hue:draft.hue,...(data.resources.find(x=>x.id===renameId)?.type==='crew'?{subbie:!!draft.subbie}:{}),
      ...(data.resources.find(x=>x.id===renameId)?.type==='machine'?{category:(draft.category||'').trim(),rego:(draft.rego||'').trim().toUpperCase()}:{})});setRenameId(null)};
  const crews=data.resources.filter(r=>r.type==='crew');
  const list=data.resources.filter(r=>r.type===tab&&(r.name+' '+r.sub).toLowerCase().includes(q.toLowerCase()));
  const crewName=id=>crews.find(c=>c.id===id)?.name;
  /* Machines tab: drag categories into a new order, and machines within their category; saved straight away */
  /* collapsed machine categories (remembered in this browser) */
  const [mCol,setMCol]=useState(()=>{try{return JSON.parse(localStorage.getItem(KEY+':res-mcat')||'{}')||{}}catch(e){return {}}});
  const saveMCol=v=>{setMCol(v);try{localStorage.setItem(KEY+':res-mcat',JSON.stringify(v))}catch(e){}};
  const [mdrag,setMdrag]=useState(null);   /* {kind:'cat'|'mach', id, cat, over, after} */
  const [newCat,setNewCat]=useState(null);   /* text of the "Add category" box while it's open */
  const addCat=e=>{e&&e.preventDefault();const c=(newCat||'').trim();if(!c)return;
    if(machineCatsOf(data).some(x=>x.toLowerCase()===c.toLowerCase())){notify&&notify(`“${c}” is already a category`);return}
    setData(d=>({...d,machineCats:[...machineCatsOf(d),c]}));setNewCat(null);notify&&notify(`Category “${c}” added`)};
  const removeCat=key=>setData(d=>({...d,machineCats:(d.machineCats||[]).filter(c=>c.toLowerCase()!==key)}));
  /* rename a category: its machines move with it; renaming to an existing category merges the two */
  const [catEdit,setCatEdit]=useState(null);   /* {key, value} */
  const renameCat=()=>{const c=catEdit;if(!c)return;const nv=(c.value||'').trim();setCatEdit(null);if(!nv||nv.toLowerCase()===c.key&&machineCatsOf(data).includes(nv))return;
    setData(d=>{const list=machineCatsOf(d);const out=[];list.forEach(x=>{const y=x.toLowerCase()===c.key?nv:x;if(!out.some(o=>o.toLowerCase()===y.toLowerCase()))out.push(y)});
      return {...d,machineCats:out,resources:d.resources.map(r=>r.type==='machine'&&(r.category||'').trim().toLowerCase()===c.key?{...r,category:nv}:r)}});
    if(mCol[c.key]){const m={...mCol};delete m[c.key];m[nv.toLowerCase()]=true;saveMCol(m)}
    notify&&notify(`Category renamed to “${nv}”`)};
  const canDragM=tab==='machine'&&!q;
  const mStart=(e,kind,id,cat)=>{if(e.button!==undefined&&e.button!==0)return;e.preventDefault();e.stopPropagation();try{e.currentTarget.setPointerCapture(e.pointerId)}catch(x){}setMdrag({kind,id,cat,over:null,after:false})};
  const mMove=e=>{if(!mdrag)return;const el=document.elementFromPoint(e.clientX,e.clientY);const t=el&&el.closest(mdrag.kind==='cat'?'[data-mcat-head]':'[data-mid]');
    if(!t){if(mdrag.over)setMdrag({...mdrag,over:null});return}
    const over=mdrag.kind==='cat'?t.getAttribute('data-mcat-head'):t.getAttribute('data-mid');
    if(mdrag.kind==='mach'&&t.getAttribute('data-mcat')!==mdrag.cat){if(mdrag.over)setMdrag({...mdrag,over:null});return}
    const bx=t.getBoundingClientRect();const after=e.clientY>bx.top+bx.height/2;
    if(over!==mdrag.over||after!==mdrag.after)setMdrag({...mdrag,over,after})};
  const mEnd=()=>{const m=mdrag;setMdrag(null);if(!m||!m.over||m.over===m.id)return;
    if(m.kind==='cat'){setData(d=>{const o=machineCatsOf(d).filter(c=>c.toLowerCase()!==m.id);const lbl=machineCatsOf(d).find(c=>c.toLowerCase()===m.id);if(!lbl)return d;
      let i=o.findIndex(c=>c.toLowerCase()===m.over);if(i<0)return d;if(m.after)i++;o.splice(i,0,lbl);return {...d,machineCats:o}})}
    else setData(d=>{const res=[...d.resources];const from=res.findIndex(r=>r.id===m.id);if(from<0)return d;const [x]=res.splice(from,1);
      let i=res.findIndex(r=>r.id===m.over);if(i<0)return d;if(m.after)i++;res.splice(i,0,x);return {...d,resources:res}})};
  const mLine=(kind,id)=>mdrag&&mdrag.kind===kind&&mdrag.over===id&&mdrag.over!==mdrag.id?(mdrag.after?'inset 0 -2px 0 var(--accent)':'inset 0 2px 0 var(--accent)'):'none';
  const mGrip=(kind,id,cat,label)=>html`<span role="button" tabindex="-1" class="w-5 h-6 shrink-0 inline-flex items-center justify-center rounded text-faint hover:text-ink hover:bg-surface select-none"
    style=${{cursor:mdrag?'grabbing':'grab',touchAction:'none'}} title=${kind==='cat'?'Drag to move this category':'Drag to reorder within the category'} aria-label=${'Drag '+label}
    onPointerDown=${e=>mStart(e,kind,id,cat)} onPointerMove=${mMove} onPointerUp=${mEnd} onPointerCancel=${()=>setMdrag(null)}>${Icon.grip}</span>`;

  const add=e=>{
    e.preventDefault();if(!f.name.trim())return;
    const r={id:tab[0]+uid(),type:tab,name:f.name.trim(),sub:f.sub.trim()||(tab==='crew'?'General':tab==='person'?'Crew member':tab==='aplant'?'Asphalt plant':'Machine'),
      crewId:tab==='crew'||tab==='aplant'?undefined:(f.crewId||null),
      ...(tab==='machine'?{category:(f.category||'').trim(),rego:(f.rego||'').trim().toUpperCase()}:{}),
      hue:tab==='crew'?CREW_HUES[data.resources.filter(x=>x.type==='crew').length%CREW_HUES.length]:HUES[data.resources.length%HUES.length],visible:true};
    setData(d=>({...d,resources:[...d.resources,r]}));setF({name:'',sub:'',crewId:f.crewId,category:f.category||'',rego:''});
  };
  const patch=(id,p)=>setData(d=>({...d,resources:d.resources.map(r=>r.id===id?{...r,...p}:r)}));
  const remove=id=>{setData(d=>({...d,
    resources:d.resources.filter(r=>r.id!==id).map(r=>r.crewId===id?{...r,crewId:null}:r),
    blocks:d.blocks.filter(b=>b.resourceId!==id)}));setConfirmId(null)};

  const placeholders={crew:['Crew name, e.g. Crew 5','Type of work, e.g. Paving, Seal'],person:['Full name','Role, e.g. Roller operator'],machine:['Machine #, e.g. PV010','Description, e.g. Vogele Paver (2003)'],aplant:['Plant name, e.g. Asphalt plant 2','Location, e.g. Narangba']};

  const tabsBar=html`<div class="seg w-full !flex flex-wrap gap-0.5" role="tablist" aria-label="Settings sections">
        ${[...orderOf(data).filter(t=>TYPES[t]).map(t=>[t,TYPES[t].tab||TYPES[t].label,data.resources.filter(r=>r.type===t).length]),['mixes','Mixes',mixTypesOf(data).length],['seal','Seal',sealTypesOf(data).length],['trucks','Trucks',truckCosOf(data).length],['subs','Subcontractors',subCosOf(data).length]].filter(([t])=>tabOK(t))
          .map(([t,label,n])=>html`<button key=${t} role="tab" class="flex-auto !px-2 !text-[12.5px] whitespace-nowrap" aria-pressed=${tab===t} aria-selected=${tab===t} title=${`${label} (${n})`} onClick=${()=>{setTab(t);setConfirmId(null)}}>${label}</button>`)}
      </div>`;
  const headTop=html`<div class="flex items-center justify-between gap-2">
        <div class="font-display text-[17px] font-semibold leading-tight">${tab==='jobs'?'Jobs':'Settings'}</div>
        ${onClose&&html`<button class="btn btn-ghost lg:hidden" onClick=${onClose} aria-label=${tab==='jobs'?'Close jobs panel':'Close settings panel'}>${Icon.x}</button>`}
      </div>`;
  /* Jobs has its own button in the header, so it opens on its own without the settings tabs */
  if(tab==='jobs')return html`<aside class="panel flex flex-col h-full min-h-0 w-full overflow-hidden">
    <div class="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-3">${headTop}</div>
    <${JobsManager} data=${data} setData=${setData} onImport=${onImport} onMerge=${onMerge}/>
  </aside>`;
  if(tab==='subs')return html`<aside class="panel flex flex-col h-full min-h-0 w-full overflow-hidden">
    <div class="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-3">${headTop}${tabsBar}</div>
    <${SubsManager} data=${data} setData=${setData}/>
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
        <div class="font-display text-[17px] font-semibold leading-tight">Settings</div>
        ${onClose&&html`<button class="btn btn-ghost lg:hidden" onClick=${onClose} aria-label="Close settings panel">${Icon.x}</button>`}
      </div>
      ${tabsBar}
      <div>
        <label for="res-search" class="sr-only">Search ${TYPES[tab].label}</label>
        <input id="res-search" class="field" placeholder=${'Search '+TYPES[tab].label.toLowerCase()} value=${q} onInput=${e=>setQ(e.target.value)}/>
      </div>
    </div>
    <ul class="flex-1 min-h-0 overflow-y-auto px-2 py-2">
      <datalist id="work-types">${groupCrews(crews).map(g=>html`<option key=${g.key} value=${g.label}></option>`)}</datalist>
      <datalist id="mach-cats">${machineCatsOf(data).map(c=>html`<option key=${c} value=${c}></option>`)}</datalist>
      ${tab==='machine'&&!q&&html`<li class="px-2 pt-1 flex items-center gap-3 text-[12px]">
        ${list.length>0&&html`<button type="button" class="font-medium text-muted hover:text-ink underline underline-offset-2" onClick=${()=>{const v={};groupMachines(list,data,true).forEach(g=>{v[g.key]=true});saveMCol(v)}}>Collapse all</button>
        <button type="button" class="font-medium text-muted hover:text-ink underline underline-offset-2" onClick=${()=>saveMCol({})}>Expand all</button>`}
        <button id="mcat-add-open" type="button" class="ml-auto font-medium inline-flex items-center gap-1 text-muted hover:text-ink" onClick=${()=>setNewCat(newCat==null?'':null)} aria-expanded=${newCat!=null}>${Icon.plus} Add category</button></li>`}
      ${tab==='machine'&&!q&&newCat!=null&&html`<li class="px-2 pt-2"><div class="flex items-center gap-2" onKeyDown=${e=>{if(e.key==='Enter'){e.preventDefault();addCat()}else if(e.key==='Escape'){e.stopPropagation();setNewCat(null)}}}>
        <label class="sr-only" for="mcat-new">New category name</label>
        <input id="mcat-new" class="field field-sm flex-1" style=${{height:30}} placeholder="e.g. Water carts" value=${newCat} autoFocus=${true} onInput=${e=>setNewCat(e.target.value)}/>
        <button id="mcat-add" type="button" class="btn btn-primary" style=${{height:30}} disabled=${!newCat.trim()} onClick=${addCat}>Add</button>
        <button type="button" class="btn btn-ghost" style=${{height:30}} onClick=${()=>setNewCat(null)}>Cancel</button></div></li>`}
      ${(tab==='crew'?groupCrews(list).flatMap(g=>g.rows.map((r,i)=>({r,head:i===0?g:null})))
        :tab==='machine'?groupMachines(list,data,!q).flatMap(g=>g.empty?[{r:null,head:g}]:g.rows.map((r,i)=>({r,head:i===0?g:null})))
        :list.map(r=>({r,head:null}))).map(({r,head})=>{
        let hdr=head&&html`<li key=${'h-'+head.key} class="px-2 pt-3 pb-1 flex items-center gap-2" data-mcat-head=${tab==='machine'&&head.key!=='~'?head.key:undefined}
            style=${tab==='machine'?{boxShadow:mLine('cat',head.key),opacity:mdrag&&mdrag.kind==='cat'&&mdrag.id===head.key?.45:1}:null}>
          ${canDragM&&head.key!=='~'&&mGrip('cat',head.key,null,head.label)}
          ${tab==='machine'?html`<button type="button" class="flex items-center gap-1.5 min-w-0 text-left" onClick=${()=>saveMCol({...mCol,[head.key]:!mCol[head.key]})} aria-expanded=${!mCol[head.key]} title=${mCol[head.key]?'Show these machines':'Hide these machines'}>
              <span class="text-muted inline-flex transition-transform shrink-0" style=${{transform:mCol[head.key]&&!q?'rotate(-90deg)':'none'}}>${Icon.chevD}</span>
              <span class="label truncate" style=${{color:'var(--ink)'}}>${head.label}</span></button>`
            :html`<span class="label" style=${{color:'var(--ink)'}}>${head.label}</span>`}<span class="mono text-[11px] text-faint">${head.rows.length}</span><span class="flex-1 h-px bg-line"></span>
          ${tab==='machine'&&head.key!=='~'&&html`<button type="button" class="p-0.5 rounded text-faint hover:text-ink" onClick=${()=>setCatEdit({key:head.key,value:head.label})} aria-label=${'Rename category '+head.label} title="Rename category">${Icon.pencil}</button>`}</li>`;
        const hdrEdit=head&&tab==='machine'&&catEdit&&catEdit.key===head.key&&html`<li key=${'he-'+head.key} class="px-2 pt-3 pb-1"><div class="flex items-center gap-2" onKeyDown=${e=>{if(e.key==='Enter'){e.preventDefault();renameCat()}else if(e.key==='Escape'){e.stopPropagation();setCatEdit(null)}}}>
            <label class="sr-only" for="mcat-rename">Category name</label>
            <input id="mcat-rename" class="field field-sm flex-1" style=${{height:30}} value=${catEdit.value} autoFocus=${true} onInput=${e=>setCatEdit({...catEdit,value:e.target.value})}/>
            <button id="mcat-rename-save" type="button" class="btn btn-primary" style=${{height:30}} disabled=${!catEdit.value.trim()} onClick=${renameCat}>Save</button>
            <button type="button" class="btn btn-ghost" style=${{height:30}} onClick=${()=>setCatEdit(null)}>Cancel</button></div>
            ${machineCatsOf(data).some(x=>x.toLowerCase()===catEdit.value.trim().toLowerCase()&&x.toLowerCase()!==catEdit.key)&&html`<div class="text-[11.5px] text-muted mt-1">That category already exists. Saving moves these machines into it.</div>`}</li>`;
        if(hdrEdit)hdr=hdrEdit;
        if(!r)return [hdr,!mCol[head.key]&&html`<li key=${'e-'+head.key} class="px-3 py-2 flex items-center gap-2 text-[12px] text-muted">
            <span class="flex-1">No machines yet. Choose this category when adding or editing a machine.</span>
            <button type="button" class="font-medium underline underline-offset-2 hover:text-ink" onClick=${()=>removeCat(head.key)} aria-label=${'Remove category '+head.label}>Remove</button></li>`];
        if(tab==='machine'&&!q&&mCol[machCatOf(r).toLowerCase()||'~']&&renameId!==r.id)return [hdr];   /* category collapsed */
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
          meta=html`<div class="text-muted text-[12px] truncate">${r.sub}${r.type==='machine'&&r.rego?html` · <span class="mono">${r.rego}</span>`:''}</div>
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
              ${r.type==='machine'&&html`<div class="grid grid-cols-[1fr_96px] gap-1.5">
                <${Combo} id=${'rn-cat-'+r.id} className="field field-sm" style=${{height:30,fontSize:13}} placeholder="Category" label="Category" value=${draft.category||''} onChange=${v=>setDraft({...draft,category:v})} options=${machineCatsOf(data)}/>
                <input id=${'rn-rego-'+r.id} class="field field-sm mono" style=${{height:30,fontSize:13}} placeholder="Rego" value=${draft.rego||''} onInput=${e=>setDraft({...draft,rego:e.target.value})} aria-label="Rego"/></div>`}
              ${r.type==='crew'&&html`<label class="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer pt-0.5">
                <input id=${'rn-subbie-'+r.id} type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${!!draft.subbie} onChange=${e=>setDraft({...draft,subbie:e.target.checked})}/>
                Subcontractor crew</label>`}
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
        return [hdr,html`<li key=${r.id} class=${'group rounded-lg px-2 py-2 flex items-start gap-3 hover:bg-sunken '+(r.visible?'':'opacity-55')}
            data-mid=${tab==='machine'?r.id:undefined} data-mcat=${tab==='machine'?(machCatOf(r).toLowerCase()||'~'):undefined}
            style=${tab==='machine'?{boxShadow:mLine('mach',r.id),...(mdrag&&mdrag.kind==='mach'&&mdrag.id===r.id?{opacity:.45}:{})}:null}>
          ${canDragM&&html`<span class="-ml-1 mt-1.5">${mGrip('mach',r.id,machCatOf(r).toLowerCase()||'~',r.name)}</span>`}
          <${Badge} r=${r}/>
          <div class="min-w-0 flex-1">
            <div class="font-medium truncate flex items-center gap-1.5"><span class="truncate">${r.name}</span>${r.type==='crew'&&r.subbie&&html`<${SubTag}/>`}</div>
            ${meta}
          </div>
          ${confirmId===r.id
            ?html`<div class="flex flex-col gap-1 items-end">
                <button class="text-[11px] font-semibold px-2 py-0.5 rounded" style=${{background:'hsl(352 70% var(--blk-l))',color:'hsl(352 60% var(--blk-fg-l))'}} onClick=${()=>remove(r.id)}>Remove</button>
                <button class="text-[11px] text-muted px-2" onClick=${()=>setConfirmId(null)}>Keep</button></div>`
            :html`<div class="flex flex-col items-center gap-0.5 lg:opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                ${r.type==='machine'&&onMaint&&html`<button class="p-1 rounded text-muted hover:text-ink" onClick=${()=>onMaint(r.id)} aria-label=${'Maintenance for '+r.name} title="Maintenance">${Icon.wrench}</button>`}
                <button class="p-1 rounded text-muted hover:text-ink" onClick=${()=>setRenameId(r.id)} aria-label=${'Edit '+r.name} title="Edit name">${Icon.pencil}</button>
                <button class="p-1 rounded text-muted hover:text-ink" onClick=${()=>patch(r.id,{visible:!r.visible})} aria-label=${(r.visible?'Hide ':'Show ')+r.name} title=${r.visible?'Hide from board':'Show on board'}>${r.visible?Icon.eye:Icon.eyeOff}</button>
                <button class="p-1 rounded text-muted hover:text-ink" onClick=${()=>setConfirmId(r.id)} aria-label=${'Remove '+r.name} title="Remove">${Icon.x}</button></div>`}
        </li>`];})}
      ${list.length===0&&!(tab==='machine'&&!q&&(data.machineCats||[]).length)&&html`<li class="px-3 py-6 text-center text-muted text-[13px]">${q?`Nothing matches “${q}”.`:`No ${TYPES[tab].label.toLowerCase()} yet. Add one below.`}</li>`}
    </ul>
    <form class="border-t border-line px-4 py-3 flex flex-col gap-2 bg-sunken" onSubmit=${add}>
      <div class="flex items-center gap-2"><div class="label mr-auto">Add ${TYPES[tab].one}</div>
        ${tab==='machine'&&onImportMachines&&html`<button type="button" class="text-[12px] font-medium underline underline-offset-2 text-muted hover:text-ink" onClick=${onImportMachines}>Import from Excel</button>`}
        ${tab==='machine'&&data.resources.some(r=>r.type==='machine')&&html`<button type="button" class="text-[12px] font-medium underline underline-offset-2 text-muted hover:text-ink" onClick=${()=>exportMachines(data,notify||(()=>{}))}>Export to Excel</button>`}</div>
      <div class="flex gap-2">
        <input id="new-name" class="field" placeholder=${placeholders[tab][0]} value=${f.name} onInput=${e=>setF({...f,name:e.target.value})} aria-label="Name"/>
      </div>
      <input id="new-sub" list=${tab==='crew'?'work-types':undefined} class="field" placeholder=${placeholders[tab][1]} value=${f.sub} onInput=${e=>setF({...f,sub:e.target.value})} aria-label="Description"/>
      ${tab==='machine'&&html`<div class="grid grid-cols-[1fr_100px] gap-2">
        <${Combo} id="new-cat" className="field" placeholder="Category, e.g. Pavers" label="Category" value=${f.category||''} onChange=${v=>setF({...f,category:v})} options=${machineCatsOf(data)}/>
        <input id="new-rego" class="field mono" placeholder="Rego" value=${f.rego||''} onInput=${e=>setF({...f,rego:e.target.value})} aria-label="Rego"/></div>`}
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
function Board({data,days,view,onCreate,onEdit,onMove,onRename,onReorder,onExport,collapsed,toggleSection,notifPrefs,only,headLabel}){
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
          <div class="font-medium text-[13px] truncate flex items-center gap-1.5" title=${r.name}><span class="truncate">${r.name}</span>${r.type==='machine'&&data.alerts&&data.alerts[r.id]&&data.alerts[r.id].restricted&&html`<span class="shrink-0 text-[9.5px] font-bold uppercase tracking-wide px-1 rounded leading-[14px]" style=${{background:'hsl(0 72% 47%)',color:'#fff'}} title=${'Restricted: do not use. '+(data.alerts[r.id].restriction||'')}>Restricted</span>`}</div>
          <div class="text-[11.5px] text-muted truncate flex items-center gap-1.5">${r.type==='crew'&&r.subbie&&html`<${SubTag}/>`}<span class="truncate">${r.type==='crew'?`${ppl} staff · ${pl} machine${pl===1?'':'s'}`:`${r.sub}${crew?' · '+crew.name:''}`}</span></div>
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
            title=${`${vTip}${title}${night?' (night works)':''} · ${r.name}${!v&&it.b.kind==='job'&&it.b.shiftData?Object.keys(it.b.shiftData).filter(k=>coverOf(it.b,k)&&k>=it.b.start&&k<=it.b.end).sort().map(k=>`\n${WD[parse(k).getDay()]} ${fmtShort(parse(k))}: done by ${data.resources.find(c=>c.id===coverOf(it.b,k))?.name||'another crew'}`).join(''):''}${it.b.crewSize?`\n${it.b.crewSize} man crew`:''}${it.b.kind==='job'&&it.b.inductionReq?(it.b.inductionDone?'\nSite induction: paperwork sent':'\nSite induction required: paperwork not sent'):''}${it.b.kind==='job'&&!it.b.sapEntered?'\nNot entered into SAP':''}${it.b.kind==='job'&&it.b.creditIssue?'\nCredit issue':''}${it.b.projectNo?`\nProject ${it.b.projectNo}`:''}${it.b.quoteNo?`\nQuote ${it.b.quoteNo}`:''}${it.b.notes?`\n${it.b.notes.length>140?it.b.notes.slice(0,140)+'…':it.b.notes}`:''}${it.b.kind==='job'&&it.b.shiftData?(t=>t.tonnes||t.area?`\n${fmtN(t.tonnes)} t · ${fmtN(t.area)} m² over ${t.filled} shift${t.filled===1?'':'s'}`:'')(qtyTotals(it.b)):''}\n${fmtShort(parse(it.b.start))} – ${fmtShort(parse(it.b.end))}${v?(it.b.cover?'\nClick to edit the booking':'\nClick to edit the crew job'):''}`}
            onPointerDown=${e=>v?e.stopPropagation():startDrag(e,it.b)}
            onClick=${v?()=>onEdit(it.b.parent):undefined}
            onKeyDown=${e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onEdit(v?it.b.parent:it.b)}
              else if(!v&&e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();nudge(it.b,e.key==='ArrowLeft'?-1:1)}}}>
            ${(it.b.kind==='job'||it.b.kind==='onjob')&&days.slice(it.s,it.e+1).map((d,i)=>{const src=it.b.kind==='onjob'?it.b.parent:it.b;
                const off=!worksOn(it.b,d),cov=!off&&!it.b.cover&&coverOf(src,iso(d));if(!off&&!cov)return null;
                return html`<span key=${'w'+i} class=${'wkoff'+(cov?' cov':'')} aria-hidden="true" style=${{left:`${i/span*100}%`,width:`${100/span}%`}}></span>`})}
            ${it.cutL&&html`<span aria-hidden="true">‹</span>`}
            ${night&&html`<span class="shrink-0 inline-flex" title="Night works">${Icon.moon}</span>`}
            ${(src=>src&&src.kind==='job'&&html`
              ${src.end>=iso(TODAY)&&restrictedIn(data,src.plantIds).length>0&&html`<span class="shrink-0 inline-flex items-center justify-center rounded-[3px] bar-restricted" style=${{width:15,height:14,background:'hsl(0 75% 46%)',color:'#fff'}} title=${'Restricted machine on this job: '+restrictedIn(data,src.plantIds).map(id=>(data.resources.find(r=>r.id===id)||{}).name).join(', ')+'. Swap it for another machine.'}>${Icon.alert}</span>`}
              ${!src.sapEntered&&html`<span class="shrink-0 inline-flex items-center justify-center rounded-[3px]" style=${{width:15,height:13,background:'hsl(38 95% 55%)',color:'hsl(30 60% 12%)'}} title="Not entered into SAP">${Icon.sap}</span>`}
              ${src.inductionReq&&html`<span class="shrink-0 inline-flex items-center justify-center rounded-[3px]" style=${{width:15,height:14,background:src.inductionDone?'hsl(145 60% 34%)':'hsl(0 75% 46%)',color:'#fff'}} title=${src.inductionDone?'Site induction required: paperwork sent':'Site induction required: paperwork not sent yet'}>${Icon.induct}</span>`}
              ${src.creditIssue&&html`<span class="shrink-0 inline-flex items-center justify-center rounded-full font-bold" style=${{width:14,height:14,fontSize:10,lineHeight:1,background:'hsl(0 75% 46%)',color:'#fff',boxShadow:'0 0 0 1.5px #fff'}} title="Credit issue">$</span>`}`)(v?(it.b.cover?it.b.parent:null):it.b)}
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

  const SubHead=(g,pre='crew',noun='crew')=>{
    const ck=pre+':'+g.key;
    return html`<div key=${'g-'+g.key} class="flex border-b border-line">
      <button class="sticky left-0 z-10 bg-surface border-r border-line flex items-center gap-2 pl-6 pr-3 py-1.5 shrink-0 text-left" style=${{width:nameW}}
        onClick=${()=>toggleSection(ck)} aria-expanded=${!collapsed[ck]}>
        <span class="text-muted inline-flex transition-transform" style=${{transform:collapsed[ck]?'rotate(-90deg)':'none'}}>${Icon.chevD}</span>
        <span class="text-[12.5px] font-semibold truncate">${g.label}</span>
        <span class="mono text-[11px] text-faint shrink-0">${g.rows.length} ${noun}${g.rows.length===1?'':'s'}</span>
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

  const sections=orderOf(data).filter(t=>!only||only.includes(t)).map(t=>({t,rows:data.resources.filter(r=>r.type===t&&r.visible)}));

  return html`<div ref=${boxRef} class="scrollbox flex-1 min-h-0" role="region" aria-label="Schedule board">
    <div style=${{minWidth:nameW+N*colMin}} class="relative">
      <div class="flex sticky top-0 z-20 bg-surface border-b border-line">
        <div class="sticky left-0 z-30 bg-surface border-r border-line flex items-end px-4 pb-2 shrink-0" style=${{width:nameW}}>
          <span class="label">${headLabel||'Crews / machines / staff'}</span>
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
              <span class="mono text-[11px] text-faint whitespace-nowrap">${t==='tonnes'?`${fmtN(viewTotal)} t in view`:rows.length}</span>
            </button>
          </div>
          <div class="flex-1 grid" style=${grid}>
            ${days.map((d,i)=>html`<div key=${i}></div>`)}
          </div>
        </div>
        ${!collapsed[t]&&t==='tonnes'&&TonnesBody()}
        ${!collapsed[t]&&t!=='tonnes'&&(t==='crew'
          ?groupCrews(rows).map(g=>[SubHead(g),...(collapsed['crew:'+g.key]?[]:g.rows.map(Row))])
          :t==='machine'?groupMachines(rows,data).map(g=>[SubHead(g,'mcat','machine'),...(collapsed['mcat:'+g.key]?[]:g.rows.map(Row))])
          :rows.map(Row))}
        ${!collapsed[t]&&t!=='tonnes'&&rows.length===0&&html`<div class="px-4 py-4 text-muted text-[13px] border-b border-line">No ${TYPES[t].label.toLowerCase()} on the board. Add or unhide them in Settings.</div>`}
      </div>`;})}

    </div>
  </div>`;
}

/* ---------- mobile plant picker (crew jobs) ---------- */
/* ---------- maintenance alerts for the planner (live site): restricted machines, open defects, services due ---------- */
function useMachineAlerts(live,setRaw){
  useEffect(()=>{if(!live||!live.sb)return;const sb=live.sb;let off=false,t=null,ch=null;
    const load=async()=>{try{const {data:rows,error}=await sb.from('machine_alerts').select('*');if(error)throw error;
      const o={};(rows||[]).forEach(r=>{o[r.asset_id]=r});
      if(!off)setRaw(d=>JSON.stringify(d.alerts||{})===JSON.stringify(o)?d:{...d,alerts:o})}catch(e){}   /* not set up yet: no alerts */
      if(MAINT_ROLES.includes(live.role))try{const {data:ev,error}=await sb.from('maintenance_feed').select('*');if(error)throw error;
        if(!off)setRaw(d=>JSON.stringify(d.mfeed||[])===JSON.stringify(ev||[])?d:{...d,mfeed:ev||[]})}catch(e){}};
    load();const iv=setInterval(load,5*60e3);
    try{ch=sb.channel('alerts-'+uid());['restrictions','defects','meter_readings','service_records','service_plans','asset_profiles','prestarts','work_orders'].forEach(tb=>ch.on('postgres_changes',{event:'*',schema:'public',table:tb},()=>{clearTimeout(t);t=setTimeout(load,600)}));ch.subscribe()}catch(e){}
    return()=>{off=true;clearInterval(iv);clearTimeout(t);try{if(ch)sb.removeChannel(ch)}catch(e){}}},[]);
}
/* what to tell the planner about a machine: block = restricted (can't be added) */
const machAlert=(data,id)=>{const a=data&&data.alerts&&data.alerts[id];if(!a)return null;
  const dft=a.open_defects?`${a.open_defects} open defect${a.open_defects===1?'':'s'}`:'';
  if(a.restricted)return {block:true,tone:'var(--bad)',text:`Restricted: do not use${a.restriction?' · '+a.restriction:''}`};
  if(a.service==='overdue')return {tone:'var(--bad)',text:[`Service overdue: ${a.service_plans}`,dft].filter(Boolean).join(' · ')};
  const bits=[a.service==='soon'&&`Service due soon: ${a.service_plans}`,dft].filter(Boolean);
  return bits.length?{tone:'var(--warn)',text:bits.join(' · ')}:null};
const restrictedIn=(data,ids)=>(ids||[]).filter(id=>data&&data.alerts&&data.alerts[id]&&data.alerts[id].restricted);
function RestrictedNote({data,ids,what}){
  const bad=restrictedIn(data,ids).map(id=>data.resources.find(r=>r.id===id)).filter(Boolean);
  if(!bad.length)return null;
  return html`<div class="rounded-lg px-3 py-2 text-[12.5px] font-medium restricted-note" style=${{background:'hsl(0 80% 96%)',color:'hsl(0 72% 38%)',boxShadow:'inset 0 0 0 1.5px hsl(0 72% 47%)'}}>
    ${bad.map(m=>m.name).join(', ')} ${bad.length===1?'is':'are'} restricted (do not use): ${bad.map(m=>data.alerts[m.id].restriction).filter(Boolean).join('; ')}. Take ${bad.length===1?'it':'them'} off ${what} and pick another machine.</div>`;
}
function PlantPicker({f,set,data}){
  const machines=data.resources.filter(r=>r.type==='machine');
  const crew=data.resources.find(r=>r.id===f.resourceId);
  const own=machines.filter(m=>m.crewId===f.resourceId);
  const [pq,setPq]=useState('');const ql=pq.trim().toLowerCase();
  const hit=m=>!ql||[m.name,m.sub,m.rego,m.category].join(' ').toLowerCase().includes(ql);
  /* the crew's own plant first, then the rest by category */
  const plantSections=[...(own.filter(hit).length?[{key:'own',label:`${crew?.name||'Crew'}'s plant`,rows:own.filter(hit)}]:[]),
    ...groupMachines(machines.filter(m=>m.crewId!==f.resourceId&&hit(m)),data)];
  const picked=new Set(f.plantIds||[]);
  const toggle=id=>{const s=new Set(picked);if(s.has(id))s.delete(id);else if(!(machAlert(data,id)||{}).block)s.add(id);set({plantIds:[...s]})};
  const addOwn=()=>set({plantIds:[...new Set([...picked,...own.filter(m=>!(machAlert(data,m.id)||{}).block).map(m=>m.id)])]});
  const range={start:f.start,end:f.end};
  const status=m=>{
    const al=machAlert(data,m.id);if(al&&al.block)return al;
    if(!f.start||!f.end||f.end<f.start)return al;
    const down=data.blocks.find(b=>b.resourceId===m.id&&KINDS[b.kind].down&&overlaps(b,range));
    if(down)return {tone:'var(--bad)',text:`${b2s(down)}: ${down.title||KINDS[down.kind].label}`};
    const other=data.blocks.find(b=>b.id!==f.id&&b.kind==='job'&&(b.plantIds||[]).includes(m.id)&&overlaps(b,range));
    if(other){const c=data.resources.find(r=>r.id===other.resourceId);
      return {tone:'var(--warn)',text:`${b2s(other)}: already on ${c?.name||'another crew'}'s job`+(al?' · '+al.text:'')}}
    return al;
  };
  const b2s=b=>b.start===b.end?fmtShort(parse(b.start)):`${fmtShort(parse(b.start))}–${fmtShort(parse(b.end))}`;
  return html`<section class="grid gap-3 md:grid-cols-[minmax(0,1fr)_300px] md:items-start">
    ${restrictedIn(data,f.plantIds).length>0&&html`<div class="md:col-span-2"><${RestrictedNote} data=${data} ids=${f.plantIds} what="this booking"/></div>`}
    <div class="flex items-center gap-2 md:col-span-2">
      <h3 class="font-display text-[15px] font-semibold">Machines</h3>
      <span class="mono text-[11px] text-faint">${picked.size} assigned</span>
      <span class="flex-1"></span>
      ${own.length>0&&own.some(m=>!picked.has(m.id))&&html`<button type="button" class="text-[12px] font-medium underline underline-offset-2 text-muted hover:text-ink" onClick=${addOwn}>Add ${crew?.name||'crew'}'s plant</button>`}
    </div>
    ${machines.length===0
      ?html`<div class="text-[12.5px] text-muted md:col-span-2">No machines yet. Add them in Fleet › Machines.</div>`
      :html`${machines.length>8&&html`<input id="pl-search" class="field field-sm md:col-start-1" style=${{height:30,fontSize:13}} placeholder="Search machine #, description, rego or category" value=${pq} onInput=${e=>setPq(e.target.value)} aria-label="Search machines"/>`}
      <ul class="border border-line rounded-lg max-h-[min(460px,55vh)] overflow-y-auto divide-y md:col-start-1" style=${{borderColor:'var(--line)'}}>
        ${plantSections.length===0&&html`<li class="px-3 py-3 text-[12.5px] text-muted">No machines match.</li>`}
        ${plantSections.flatMap(sec=>[html`<li key=${'h-'+sec.key} class="px-2.5 py-1 bg-sunken label sticky top-0 z-[1]" style=${{borderColor:'var(--line)'}}>${sec.label} <span class="mono text-faint">${sec.rows.length}</span></li>`,
          ...sec.rows.map(m=>{const st=status(m);const isOwn=m.crewId===f.resourceId;
          return html`<li key=${m.id} style=${{borderColor:'var(--line)'}}>
            <label class="flex items-center gap-2.5 px-2.5 py-1.5 cursor-pointer hover:bg-sunken">
              <input id=${'pl-'+m.id} type="checkbox" class="w-4 h-4 shrink-0" style=${{accentColor:'var(--accent)'}} checked=${picked.has(m.id)} disabled=${!!(st&&st.block&&!picked.has(m.id))} title=${st&&st.block?'Restricted: can’t be added':''} onChange=${()=>toggle(m.id)}/>
              <${Badge} r=${m} size=${24}/>
              <div class="min-w-0 flex-1">
                <div class="text-[13px] truncate"><span class="font-medium mono">${m.name}</span> <span class="text-muted">${m.sub}</span></div>
                ${st&&html`<div class="text-[11.5px] truncate" style=${{color:st.tone}}>${st.text}</div>`}
              </div>
              ${m.rego&&html`<span class="mono text-[10.5px] text-faint shrink-0">${m.rego}</span>`}
            </label></li>`;})])}
      </ul>`}
    ${machines.length>0&&(()=>{const sel=machines.filter(m=>picked.has(m.id));const warn=sel.filter(m=>status(m)).length;
      return html`<div class="rounded-lg border border-line bg-sunken p-2.5 grid gap-2 content-start md:col-start-2 md:row-start-2 md:row-span-3" aria-label="Machines selected for this job">
        <div class="flex items-center gap-2">
          <span class="label" style=${{color:'var(--ink)'}}>Selected for this job</span><span class="mono text-[11px] text-faint">${sel.length}</span>
          ${warn>0&&html`<span class="text-[11.5px] font-medium" style=${{color:'var(--warn)'}}>${warn} need${warn===1?'s':''} checking</span>`}
          <span class="flex-1"></span>
          ${sel.length>0&&html`<button type="button" class="text-[12px] font-medium text-muted hover:text-ink underline underline-offset-2" onClick=${()=>set({plantIds:[]})}>Clear all</button>`}
        </div>
        ${sel.length===0&&html`<div class="text-[12.5px] text-muted py-2">Nothing selected yet. Tick machines in the list.</div>`}
        ${groupMachines(sel,data).map(g=>html`<div key=${g.key} class="grid gap-1">
          <div class="text-[11.5px] font-semibold text-muted">${g.label} <span class="mono text-faint">${g.rows.length}</span></div>
          <div class="flex flex-wrap gap-1.5">
            ${g.rows.map(m=>{const st=status(m);return html`<span key=${m.id} class="inline-flex items-center gap-1.5 rounded-md bg-surface border pl-2 pr-1 py-0.5 text-[12px] max-w-full"
                style=${{borderColor:st?st.tone:'var(--line)'}} title=${[m.name,m.sub,m.rego,st&&st.text].filter(Boolean).join(' · ')}>
              <span class="font-semibold mono shrink-0">${m.name}</span><span class="text-muted truncate">${m.sub||''}</span>
              ${st&&html`<span class="shrink-0 inline-flex" style=${{color:st.tone}}>${Icon.alert}</span>`}
              <button type="button" class="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>toggle(m.id)} aria-label=${'Remove '+m.name+' from this job'}>${Icon.x}</button>
            </span>`})}
          </div></div>`)}
      </div>`})()}
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
const sealTwoCoatOf=d=>d&&d.sealTwoCoat&&typeof d.sealTwoCoat==='object'?d.sealTwoCoat:{};
const sealIsTwoCoat=(d,type)=>{const m=sealTwoCoatOf(d);const t=String(type||'').trim().toLowerCase();return Object.keys(m).some(k=>m[k]&&k.toLowerCase()===t)};
const sealBinderOf=d=>d&&d.sealBinder&&typeof d.sealBinder==='object'?d.sealBinder:{};
/* Pavetech jobs are booked as a 6 man or 9 man crew */
const isPavetech=r=>!!r&&r.type==='crew'&&/pavetech/i.test(r.name||'');
/* the phone number last used for a supervisor, so it fills in by itself */
const superPhoneOf=(d,name)=>{const n=(name||'').trim().toLowerCase();if(!n)return '';
  const hit=[...(d.blocks||[]),...(d.plans||[])].filter(x=>(x.supervisor||'').trim().toLowerCase()===n&&(x.supervisorPhone||'').trim()).pop();return hit?hit.supervisorPhone.trim():''};
/* when the supervisor changes, swap in their phone unless one was typed in by hand */
const nextSuperPhone=(d,oldName,phone,newName)=>!(phone||'').trim()||phone===superPhoneOf(d,oldName)?(superPhoneOf(d,newName)||''):phone;
const isSealCrew=r=>!!r&&r.type==='crew'&&workKey(r.sub).includes('seal');
const binderForProduct=(d,crew,type)=>{if(!isSealCrew(crew))return binderForMix(d,type);
  const m=sealBinderOf(d);const t=(type||'').trim();const k=Object.keys(m).find(x=>x.toLowerCase()===t.toLowerCase());return k?m[k]:''};
/* a mix is its asphalt type plus binder, e.g. "AC14 · C320" */
const mixLabel=l=>((l.type||'').trim()||'No type')+(l.binder?' · '+l.binder:'');
const linesOf=q=>!q?[]:Array.isArray(q.lines)?q.lines:[q];
const lineHas=l=>l&&((l.type||'').trim()||l.binder||filledNum(l.tonnes)||filledNum(l.area)||filledNum(l.depth)||(l.stone||'').trim()||filledNum(l.spray)||filledNum(l.spread));
const hasQty=q=>linesOf(q).some(lineHas);
const cleanLine=l=>({type:(l.type||'').trim(),binder:l.binder||'',...(l.virgin?{virgin:true}:{}),tonnes:filledNum(l.tonnes)?num(l.tonnes):'',area:filledNum(l.area)?num(l.area):'',depth:filledNum(l.depth)?num(l.depth):'',...((l.stone||'').trim()?{stone:l.stone.trim()}:{}),...(filledNum(l.spray)?{spray:num(l.spray)}:{}),...(filledNum(l.spread)?{spread:num(l.spread)}:{}),
  ...(l.twoCoat?{twoCoat:true,binder2:l.binder2||'',stone2:(l.stone2||'').trim(),spray2:filledNum(l.spray2)?num(l.spray2):'',spread2:filledNum(l.spread2)?num(l.spread2):''}:{})});
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
const SEAL_COLS='grid-cols-[1fr_1fr_28px] sm:grid-cols-[1fr_92px_84px_76px_76px_80px_28px]';  /* seal: type, binder, stone, area, spray rate, spread rate */
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
  /* shifts before today are locked (greyed out) unless "Edit past shifts" is ticked */
  const [editPast,setEditPast]=useState(false);const todayK=iso(TODAY);const locked=k=>k<todayK&&!editPast;
  const empties=tot.dates.filter(k=>!hasQty(sd[k])&&!locked(k));
  const copyFirst=()=>{const src=linesOf(sd[first]);const next={...sd};empties.forEach(k=>{next[k]={...shiftBase(sd[k]),lines:src.map(l=>({...l}))}});set({shiftData:next})};
  const copyPrev=i=>{const p=tot.dates[i-1];if(p&&sd[p])put(tot.dates[i],linesOf(sd[p]).map(l=>({...l})))};
  /* split: put the whole job's quantities in Shift 1, then share tonnes and area evenly over every shift (any rounding goes on the last one) */
  const [splitAsk,setSplitAsk]=useState(false);
  const s0=tot.dates[0];const splitTo=tot.dates.filter(k=>!locked(k));
  const canSplit=!!s0&&!locked(s0)&&hasQty(sd[s0])&&splitTo.length>1;
  const othersFilled=splitTo.filter(k=>k!==s0&&hasQty(sd[k])).length;
  const splitFirst=()=>{const src=linesOf(sd[s0]).filter(lineHas);const n=splitTo.length;
    const part=(v,dp,idx)=>{if(!filledNum(v)||!num(v))return v;const t=num(v),m=10**dp,each=Math.round(t/n*m)/m;return idx===n-1?Math.round((t-each*(n-1))*m)/m:each};
    const next={...sd};splitTo.forEach((k,idx)=>{next[k]={...shiftBase(sd[k]),lines:src.map(l=>({...l,tonnes:part(l.tonnes,1,idx),area:part(l.area,0,idx)}))}});
    set({shiftData:next});setSplitAsk(false)};
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
      ${tot.dates.some(k=>k<todayK)&&html`<label class="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer" title="Shifts before today are locked so they aren't changed by accident">
        <input id="ed-edit-past" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${editPast} onChange=${e=>setEditPast(e.target.checked)}/>
        <span class=${editPast?'font-semibold text-ink':'text-muted'}>Edit past shifts</span></label>`}
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
        ${((first&&empties.length>0)||canSplit)&&html`<div class="flex flex-wrap justify-end items-center gap-x-4 gap-y-1 mb-1.5 text-[12px]">
          ${canSplit&&(splitAsk
            ?html`<span class="inline-flex flex-wrap items-center gap-2"><span>Replace the quantities in the ${othersFilled} other filled-in shift${othersFilled===1?'':'s'} with an even split?</span>
                <button id="ed-split-yes" type="button" class="btn btn-primary" style=${{height:26,fontSize:12}} onClick=${splitFirst}>Split</button>
                <button type="button" class="btn btn-ghost" style=${{height:26,fontSize:12}} onClick=${()=>setSplitAsk(false)}>Cancel</button></span>`
            :html`<button id="ed-split" type="button" class="font-medium underline underline-offset-2 text-muted hover:text-ink" title="Enter the whole job's quantities in Shift 1, then share the tonnes and area evenly over every shift"
                onClick=${()=>othersFilled?setSplitAsk(true):splitFirst()}>Split Shift 1 evenly across ${splitTo.length} shifts</button>`)}
          ${first&&empties.length>0&&!splitAsk&&html`<button type="button" class="font-medium underline underline-offset-2 text-muted hover:text-ink" onClick=${copyFirst}>Copy Shift ${tot.dates.indexOf(first)+1} to ${empties.length} empty shift${empties.length===1?'':'s'}</button>`}</div>`}
        <div id="ed-qty" tabindex="-1" class="border border-line rounded-lg overflow-hidden">
          <div class="max-h-[55vh] overflow-y-auto">
            <div class="hidden sm:grid grid-cols-[118px_1fr] gap-2 px-2.5 py-1.5 bg-sunken border-b border-line sticky top-0 z-[1]">
              <span class="label">Shift</span>
              <div class=${'grid gap-2 '+CO}><span class="label">${seal?'Seal type':'Asphalt type'}</span><span class="label">Binder</span>${seal&&html`<span class="label">Stone</span>`}${!seal&&html`<span class="label">Tonnes</span>`}<span class="label">Area m²</span>${!seal&&html`<span class="label">Depth mm</span>`}${seal&&html`<span class="label" title="Bitumen spray rate, litres per m²">Spray L/m²</span><span class="label" title="Stone spread rate, m² per m³">Spread m²/m³</span>`}<span></span></div>
            </div>
            ${tot.dates.map((k,i)=>{
              const ls=shown(k);const d=parse(k);
              const multi=ls.filter(lineHas).length>1;
              const sub=ls.reduce((a,l)=>({t:a.t+num(l.tonnes),a:a.a+num(l.area)}),{t:0,a:0});
              return html`<fieldset key=${k} disabled=${locked(k)} class="grid sm:grid-cols-[118px_1fr] gap-2 px-2.5 py-2.5 border-0 border-b border-line last:border-b-0 m-0 min-w-0"
                style=${locked(k)?{opacity:.5,background:'var(--sunken)'}:null} title=${locked(k)?'Past shift: tick "Edit past shifts" to change it':undefined}>
                <div class="flex flex-wrap sm:flex-col sm:items-start items-center gap-x-2 gap-y-0.5 min-w-0">
                  <div class="text-[13px] font-semibold flex items-center gap-1">Shift ${i+1}${night&&html`<span class="inline-flex" style=${{color:'hsl(0 60% var(--blk-edge-l))'}} title="Night works">${Icon.moon}</span>`}</div>
                  <div class="text-[11.5px] text-muted mono">${WD[d.getDay()]} ${fmtShort(d)}</div>
                  ${locked(k)&&html`<div class="text-[11px] font-semibold text-muted">Past shift</div>`}
                  ${!seal&&(()=>{const down=plantDown(k);const ex=(sd[k]&&sd[k].exbin)||null;   /* exbin: asphalt jobs only */
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
                      ${seal&&sealIsTwoCoat(data,l.type)&&html`<span class="shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-sunken" title="Two coat seal (set in Resources → Seal)">2 coat</span>`}
                      </div>
                      <label class="col-span-2 sm:col-span-1"><span class="sr-only">Shift ${i+1}${n} binder</span>
                        <select id=${`sh-${k}-${j}-b`} class="field field-sm mono" style=${{...ist,color:l.binder?'var(--ink)':'var(--faint)'}} value=${l.binder||''} onChange=${e=>setLine(k,j,{binder:e.target.value})}>
                          <option value="">Binder</option>
                          ${BINDS.map(b=>html`<option key=${b} value=${b} style=${{color:'var(--ink)'}}>${b}</option>`)}
                          ${l.binder&&!BINDS.includes(l.binder)&&html`<option value=${l.binder}>${l.binder}</option>`}
                        </select></label>
                      ${seal&&html`<label><span class="sr-only">Shift ${i+1}${n} stone</span>
                        <input id=${`sh-${k}-${j}-st`} class="field field-sm" style=${ist} placeholder="Stone" value=${l.stone||''} onInput=${e=>setLine(k,j,{stone:e.target.value})}/></label>`}
                      ${!seal&&html`<label><span class="sr-only">Shift ${i+1}${n} tonnes</span>
                        <input id=${`sh-${k}-${j}-t`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist} placeholder="t" value=${l.tonnes??''} onInput=${e=>setLine(k,j,{tonnes:e.target.value})}/></label>`}
                      <label><span class="sr-only">Shift ${i+1}${n} area in square metres</span>
                        <input id=${`sh-${k}-${j}-a`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist} placeholder="m²" value=${l.area??''} onInput=${e=>setLine(k,j,{area:e.target.value})}/></label>
                      ${seal&&html`<label><span class="sr-only">Shift ${i+1}${n} bitumen spray rate in litres per square metre</span>
                        <input id=${`sh-${k}-${j}-sp`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist} placeholder="L/m²" title="Bitumen spray rate (L/m²)" value=${l.spray??''} onInput=${e=>setLine(k,j,{spray:e.target.value})}/></label>
                      <label><span class="sr-only">Shift ${i+1}${n} stone spread rate in square metres per cubic metre</span>
                        <input id=${`sh-${k}-${j}-sr`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist} placeholder="m²/m³" title="Stone spread rate (m²/m³)" value=${l.spread??''} onInput=${e=>setLine(k,j,{spread:e.target.value})}/></label>`}
                      ${!seal&&html`<label><span class="sr-only">Shift ${i+1}${n} depth in millimetres</span>
                        <input id=${`sh-${k}-${j}-d`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist}
                          placeholder=${h!=null?`${h} mm`:'mm'} title=${h!=null?`Works out at about ${h} mm from the tonnes and area (2.4 t/m³)`:'Compacted depth in mm'}
                          value=${l.depth??''} onInput=${e=>setLine(k,j,{depth:e.target.value})}/></label>`}
                      ${ls.length>1
                        ?html`<button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>removeLine(k,j)} aria-label=${`Remove shift ${i+1} line ${j+1}`} title="Remove this line">${Icon.x}</button>`
                        :html`<span></span>`}
                    </div>${seal&&sealIsTwoCoat(data,l.type)&&html`<div key=${'c2-'+j} class=${'grid gap-2 items-center -mt-0.5 '+CO}>
                      <div class="col-span-2 sm:col-span-1 text-[12px] font-semibold text-muted sm:text-right pr-1">2nd coat</div>
                      <label class="col-span-2 sm:col-span-1"><span class="sr-only">Shift ${i+1}${n} second coat binder</span>
                        <select id=${`sh-${k}-${j}-b2`} class="field field-sm mono" style=${{...ist,color:(l.binder2||l.binder)?'var(--ink)':'var(--faint)'}} value=${l.binder2||''} onChange=${e=>setLine(k,j,{binder2:e.target.value})}>
                          <option value="">${l.binder?`Same (${l.binder})`:'Binder'}</option>
                          ${BINDS.map(b=>html`<option key=${b} value=${b} style=${{color:'var(--ink)'}}>${b}</option>`)}
                          ${l.binder2&&!BINDS.includes(l.binder2)&&html`<option value=${l.binder2}>${l.binder2}</option>`}
                        </select></label>
                      <label><span class="sr-only">Shift ${i+1}${n} second coat stone</span>
                        <input id=${`sh-${k}-${j}-st2`} class="field field-sm" style=${ist} placeholder="Stone" value=${l.stone2||''} onInput=${e=>setLine(k,j,{stone2:e.target.value})}/></label>
                      <span class="hidden sm:block text-[11px] text-faint text-center">same area</span>
                      <label><span class="sr-only">Shift ${i+1}${n} second coat spray rate</span>
                        <input id=${`sh-${k}-${j}-sp2`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist} placeholder="L/m²" title="2nd coat spray rate (L/m²)" value=${l.spray2??''} onInput=${e=>setLine(k,j,{spray2:e.target.value})}/></label>
                      <label><span class="sr-only">Shift ${i+1}${n} second coat spread rate</span>
                        <input id=${`sh-${k}-${j}-sr2`} type="number" inputmode="decimal" min="0" step="any" class=${inp} style=${ist} placeholder="m²/m³" title="2nd coat spread rate (m²/m³)" value=${l.spread2??''} onInput=${e=>setLine(k,j,{spread2:e.target.value})}/></label>
                      <span></span>
                    </div>`}`;})}
                  <div><button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>addLine(k)}>${Icon.plus} Add another ${seal?'seal':'mix'}</button></div>
                </div>
              </fieldset>`;})}
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
  {id:'details',label:'Booking Details',applies:()=>true,render:p=>html`${p.f.kind==='job'&&html`<div class="mb-3"><${RestrictedNote} data=${p.data} ids=${p.f.plantIds} what="this booking (Machines tab)"/></div>`}<${BookingDetails} ...${p}/>`},
  {id:'quantities',label:(f,d)=>isSealCrew(d.resources.find(r=>r.id===f.resourceId))?'Seal & Quantities':'Asphalt & Quantities',applies:f=>f.kind==='job',
    badge:(f,d)=>{const q=qtyTotals(f);if(isSealCrew(d.resources.find(r=>r.id===f.resourceId)))return q.area?`${fmtN(q.area)} m²`:null;return q.tonnes?`${fmtN(q.tonnes)} t`:null},
    render:p=>html`<${AsphaltShifts} f=${p.f} set=${p.set} data=${p.data}/>`},
  {id:'machines',label:'Machines',applies:f=>f.kind==='job',badge:(f,d)=>(f.plantIds||[]).length?`${restrictedIn(d,f.plantIds).length?'⚠ ':''}${(f.plantIds||[]).length}`:null,
    render:p=>html`<${PlantPicker} f=${p.f} set=${p.set} data=${p.data}/>`},
  {id:'trucks',label:'Trucks',applies:(f,d)=>f.kind==='job'&&!isSealCrew(d.resources.find(r=>r.id===f.resourceId)),
    badge:f=>{const n=Object.values(f.shiftData||{}).reduce((a,q)=>a+((q&&q.trucks)||[]).filter(truckHas).length,0);return n?`${n}`:null},
    render:p=>html`<${ProgramShifts} key="trucks" part="trucks" f=${p.f} set=${p.set} data=${p.data}/>`},
  {id:'program',label:'Subcontractors',applies:f=>f.kind==='job',
    badge:f=>{const n=Object.values(f.shiftData||{}).reduce((a,q)=>a+((q&&q.subs)||[]).filter(subHas).length,0);return n?`${n}`:null},
    render:p=>html`<${ProgramShifts} key="subs" part="subs" f=${p.f} set=${p.set} data=${p.data}/>`},
];

function Section({title,id,children,aside}){
  return html`<section class="grid gap-3" aria-labelledby=${id}>
    <div class="flex items-baseline gap-3"><h3 id=${id} class="font-display text-[15px] font-semibold">${title}</h3><span class="flex-1"></span>${aside}</div>
    ${children}
  </section>`;
}

function BookingDetails({f,set,data,rtype,err,changeRes}){
  return html`<div class="grid gap-6">
    ${f.fromMaintenance&&html`<div class="rounded-lg px-3 py-2 text-[12.5px]" style=${{background:'var(--accent-soft)'}}>This downtime comes from a maintenance work order. Change its dates on the work order in Fleet & Maintenance, or they’ll be put back.</div>`}
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
            <${Combo} id="ed-customer" className="field" placeholder="e.g. CMB, BMD" label="Customer"
              value=${f._customer??(f.jobId==='__new'?'':(data.jobs.find(j=>j.id===(f.jobId===''?'':(f.jobId||data.jobs[0]?.id)))?.customer||''))} onChange=${v=>set({_customer:v})}
              options=${[...new Set(data.jobs.map(j=>(j.customer||'').trim()).filter(Boolean))].sort()}/>
            <span class="text-[11.5px] text-faint">Saved to the job below, so every booking for that job shows the same customer.</span></label>
          <label class="grid gap-1"><span class="label">Job</span>
            <select id="ed-job" class="field" style=${f.jobId===''?{color:'var(--faint)'}:null} value=${f.jobId===''?'':(f.jobId||data.jobs[0]?.id||'__new')} onChange=${e=>{
                const v=e.target.value;
                if(v==='__new'){set({jobId:'__new',_newJobName:'',_customer:f._customer??'',address:''});return}
                const old=data.jobs.find(j=>j.id===(f.jobId===''?'':(f.jobId||data.jobs[0]?.id))),nj=data.jobs.find(j=>j.id===v);
                set({jobId:v,_customer:undefined,address:(!f.address||f.address===old?.address)?(nj?.address||''):f.address})}}>
              ${f.jobId===''&&html`<option value="" disabled>Choose a job…</option>`}
              <option value="__new" style=${{color:'var(--ink)'}}>+ New job…</option>
              ${data.jobs.filter(j=>!j.completed||j.id===f.jobId).map(j=>html`<option key=${j.id} value=${j.id} style=${{color:'var(--ink)'}}>${j.name}${j.completed?' (completed)':''}</option>`)}
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
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="grid gap-1"><span class="label">Supervisor</span>
              <${Combo} id="ed-super" className="field" label="Supervisor" placeholder="Name" value=${f.supervisor||''} onChange=${v=>set({supervisor:v,supervisorPhone:nextSuperPhone(data,f.supervisor,f.supervisorPhone,v)})} options=${data.resources.filter(r=>r.type==='person').map(p=>p.name)}/></label>
            <label class="grid gap-1"><span class="label">Supervisor phone</span>
              <input id="ed-phone" class="field mono" type="tel" placeholder="04xx xxx xxx" value=${f.supervisorPhone||''} onInput=${e=>set({supervisorPhone:e.target.value})}/></label>

          </div>
          <label class="grid gap-1"><span class="label">Site address</span>
            <input id="ed-address" class="field" placeholder="Street, suburb, postcode" value=${f.address||''} onInput=${e=>set({address:e.target.value})}/>
            <span class="text-[11.5px] text-faint">Shown on each machine assigned in the Machines tab.</span></label>
          <div class="grid gap-1">
            <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
              <label class="inline-flex items-center gap-2 text-[13.5px] cursor-pointer"><input id="ed-induct" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${!!f.inductionReq} onChange=${e=>set({inductionReq:e.target.checked,...(e.target.checked?{}:{inductionDone:false})})}/>Site induction required</label>
              ${f.inductionReq&&html`<label class="inline-flex items-center gap-2 text-[13.5px] cursor-pointer"><input id="ed-induct-done" type="checkbox" class="w-4 h-4" style=${{accentColor:'hsl(145 60% 36%)'}} checked=${!!f.inductionDone} onChange=${e=>set({inductionDone:e.target.checked})}/>Induction Paperwork Sent</label>`}
            </div>
            ${f.inductionReq&&html`<span class="text-[11.5px] text-faint">The bar shows a ${f.inductionDone?'green':'red'} induction icon${f.inductionDone?': paperwork sent.':' until the paperwork is sent.'}</span>`}
          </div>
          <label class="grid gap-1"><span class="label">Notes</span>
            <textarea id="ed-notes" class="field" style=${{height:'auto',minHeight:60,padding:'8px 10px',resize:'vertical'}} rows="2" placeholder="Anything the crew or plant should know" value=${f.notes||''} onInput=${e=>set({notes:e.target.value})}></textarea></label>
          <div class="grid gap-1"><span class="label">Shift</span>
            <div id="ed-shift" class="seg w-max rounded-lg">
              <button type="button" aria-pressed=${(f.shift||(f.id?'day':''))==='day'} onClick=${()=>set({shift:'day'})}>Day works</button>
              <button type="button" aria-pressed=${f.shift==='night'} onClick=${()=>set({shift:'night'})}>Night works</button>
            </div></div>
          ${isPavetech(data.resources.find(r=>r.id===f.resourceId))&&html`<div class="grid gap-1"><span class="label">Pavetech crew size</span>
            <div id="ed-crewsize" class="seg w-max rounded-lg">
              <button type="button" aria-pressed=${f.crewSize===6} onClick=${()=>set({crewSize:6})}>6 man crew</button>
              <button type="button" aria-pressed=${f.crewSize===9} onClick=${()=>set({crewSize:9})}>9 man crew</button>
            </div></div>`}
          <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label class="inline-flex items-center gap-2 text-[13.5px] cursor-pointer"><input id="ed-sap" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${!!f.sapEntered} onChange=${e=>set({sapEntered:e.target.checked})}/>Entered into SAP</label>
            <label class="inline-flex items-center gap-2 text-[13.5px] cursor-pointer"><input id="ed-credit" type="checkbox" class="w-4 h-4" style=${{accentColor:'hsl(0 72% 48%)'}} checked=${!!f.creditIssue} onChange=${e=>set({creditIssue:e.target.checked})}/>Credit issue</label>
          </div>
          <span class="text-[11.5px] text-faint -mt-2">The bar shows a small SAP icon until this booking is entered into SAP, and a red $ while there's a credit issue.</span>`
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
          <span>Asphalt plant maintenance on ${hits.join(', ')}. Tick Exbin on those shifts in the Asphalt & Quantities tab if asphalt is coming from another supplier.</span></div>`:null})()}
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

function Editor({initial,data,onSave,onDelete,onClose,onOpenPlan,notify}){
  const [planView,setPlanView]=useState(null);
  const [f,setF]=useState(initial);
  const [confirmDel,setConfirmDel]=useState(false);
  const isNew=!initial.id;
  const res=data.resources.find(r=>r.id===f.resourceId);
  const rtype=res?.type||'crew';
  const err=f.end<f.start?'End date is before the start date. Move the end date later.'
    :f.kind==='job'&&(f.jobId==='__new'||!data.jobs.length)&&!(f._newJobName||'').trim()?'Give the new job a name.'
    :f.kind==='job'&&f.jobId==='__new'&&data.jobs.some(j=>j.name.trim().toLowerCase()===(f._newJobName||'').trim().toLowerCase())?'There is already a job with that name. Pick it from the list.':'';
  const set=p=>setF(x=>({...x,...p}));
  /* new crew job bookings: these must be filled in before the booking can be added */
  const [tried,setTried]=useState(false);
  const missing=(()=>{if(!isNew||f.kind!=='job')return [];const m=[];const crewR=data.resources.find(r=>r.id===f.resourceId);
    const cust=(f._customer??(f.jobId==='__new'?'':(data.jobs.find(j=>j.id===(f.jobId===''?'':(f.jobId||data.jobs[0]?.id)))?.customer||''))).trim();
    if(!crewR||crewR.type!=='crew')m.push({id:'ed-res',label:'Crew',tab:'details'});
    if(!f.jobId)m.push({id:'ed-job',label:'Job',tab:'details'});
    if(!cust)m.push({id:'ed-customer',label:'Customer',tab:'details'});
    if(!(f.quoteNo||'').trim())m.push({id:'ed-quote',label:'Quote number',tab:'details'});
    if(!(f.address||'').trim())m.push({id:'ed-address',label:'Site address',tab:'details'});
    if(f.shift!=='day'&&f.shift!=='night')m.push({id:'ed-shift',label:'Shift (day or night)',tab:'details'});
    if(isPavetech(crewR)&&f.crewSize!==6&&f.crewSize!==9)m.push({id:'ed-crewsize',label:'Crew size (6 or 9 man)',tab:'details'});
    if(!f.start)m.push({id:'ed-start',label:'Start date',tab:'details'});
    if(!f.end)m.push({id:'ed-end',label:'End date',tab:'details'});
    const sealJ=isSealCrew(crewR);const k0=f.start&&f.end?qtyTotals(f).dates[0]:null;
    const ok0=k0&&linesOf((f.shiftData||{})[k0]).some(l=>(l.type||'').trim()&&(sealJ?num(l.area):num(l.tonnes)||num(l.area)));
    if(!ok0)m.push({id:'ed-qty',label:`Shift 1 ${sealJ?'seal':'asphalt'} quantities (${sealJ?'seal type and area':'asphalt type and tonnes'})`,tab:'quantities'});
    return m})();
  useEffect(()=>{const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);
  const days=f.start&&f.end&&!err?diffDays(parse(f.start),parse(f.end))+1:0;
  const changeRes=id=>{const t=data.resources.find(r=>r.id===id)?.type;set({resourceId:id,kind:KINDS[f.kind].for===t?f.kind:TYPES[t].def})};
  const tabs=BOOKING_TABS.filter(t=>t.applies(f,data));
  const [tab,setTab]=useState(tabs[0].id);
  const active=tabs.find(t=>t.id===tab)||tabs[0];
  const submit=e=>{e.preventDefault();if(err)return;
    if(missing.length){setTried(true);const m0=missing[0];setTab(m0.tab);setTimeout(()=>{const el=document.getElementById(m0.id);if(el){el.scrollIntoView({block:'center'});if(el.focus)el.focus()}},60);return}
    const out={...f,id:f.id||uid()};
    if(!out.inductionReq){delete out.inductionReq;delete out.inductionDone}
    if(out.kind!=='job'||!isPavetech(data.resources.find(r=>r.id===out.resourceId)))delete out.crewSize;
    if(out.kind!=='job'){delete out.jobId;delete out.shift;delete out.address;delete out.plantIds}
    else{out.jobId=out.jobId||data.jobs[0]?.id||'__new';out.shift=out.shift||'day';out.plantIds=out.plantIds||[];out.address=(out.address||'').trim();out.quoteNo=(out.quoteNo||'').trim();if(!out.quoteNo)delete out.quoteNo;
      if(out.projectNo===undefined){const pj=data.jobs.find(j=>j.id===out.jobId)?.projectNo;if(pj)out.projectNo=pj}
      out.projectNo=(out.projectNo||'').trim();if(!out.projectNo)delete out.projectNo;out.notes=(out.notes||'').trim();if(!out.notes)delete out.notes;
      ['supervisor','supervisorPhone'].forEach(k=>{out[k]=(out[k]||'').trim();if(!out[k])delete out[k]});delete out.siteContact;delete out.sitePhone}
    /* keep every shift's figures (including dates now outside the range); drop only fully empty rows */
    /* only mixes typed under "Other…" join the company list; removed mixes stay removed */
    const sealSave=out.kind==='job'&&isSealCrew(data.resources.find(r=>r.id===out.resourceId));
    const newMixes=[...new Set(Object.values(out.shiftData||{}).flatMap(q=>linesOf(q)).filter(l=>l._custom&&(l.type||'').trim()).map(l=>l.type.trim()))];
    if(out.shiftData){
      const clean=Object.fromEntries(Object.entries(out.shiftData).filter(([,q])=>hasQty(q)||progHas(q)||(q&&(q.exbin||(q.crewId&&q.crewId!==out.resourceId))))
        .map(([k,q])=>[k,{lines:linesOf(q).filter(lineHas).map(l=>cleanLine(sealSave?{...l,twoCoat:sealIsTwoCoat(data,l.type)}:l)),...(q&&q.exbin?{exbin:{supplier:q.exbin.supplier||''}}:{}),...(q&&q.crewId&&q.crewId!==out.resourceId?{crewId:q.crewId}:{}),...progClean(q)}]));
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
    <form class=${'panel pop w-full flex flex-col max-h-full overflow-hidden '+(wide?'max-w-[1280px] sm:h-[92vh]':'max-w-[500px]')} onSubmit=${submit} role="dialog" aria-modal="true" aria-labelledby="ed-title">
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
            onClick=${()=>setTab(t.id)}>${typeof t.label==='function'?t.label(f,data):t.label}${tried&&missing.some(m=>m.tab===t.id)&&html`<span class="ml-1 inline-block w-1.5 h-1.5 rounded-full align-middle" style=${{background:'var(--bad)'}} aria-label="needs filling in"></span>`}${t.badge&&t.badge(f,data)&&html`<span class="ml-1.5 mono text-[11px] px-1.5 py-0.5 rounded bg-sunken text-muted">${t.badge(f,data)}</span>`}</button>`)}
        </div>
      </div>
      ${isNew&&f.kind==='job'&&html`<style>${['ed-res','ed-customer','ed-job','ed-quote','ed-address','ed-start','ed-end'].map(i=>`label:has(#${i}) > .label::after`).join(',')}{content:' *';color:var(--bad)}
        .label:has(+ #ed-shift)::after,.label:has(+ #ed-crewsize)::after{content:' *';color:var(--bad)}
        ${tried?missing.map(m=>`#${m.id}`).join(',')+'{border-color:var(--bad)!important;box-shadow:0 0 0 1px var(--bad)!important}':''}</style>`}
      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-5" role="tabpanel" id=${'panel-'+active.id} aria-labelledby=${'tab-'+active.id}>
        ${f.kind==='job'&&active.id==='details'&&(()=>{const pl=planFor(data,f);return pl?html`<div class="mb-4 rounded-lg px-3 py-2.5 flex flex-wrap items-center gap-2" style=${{background:'var(--accent-soft)'}}>
            <span class="text-[13px]"><span class="font-semibold" style=${{color:'var(--accent)'}}>Job plan:</span> ${pl.title||pl.jobName||'Untitled plan'}${pl.appliedAt?'':' (not sent to the schedule yet)'}</span>
            <span class="flex-1"></span><button type="button" class="btn" style=${{height:30}} onClick=${()=>setPlanView(pl)}>View full plan</button></div>`:null})()}
        ${active.render({f,set,data,rtype,err,changeRes})}
        ${planView&&html`<${PlanViewDialog} data=${data} plan=${planView} onClose=${()=>setPlanView(null)} notify=${notify||(()=>{})} onOpenPlan=${id=>{setPlanView(null);onOpenPlan&&onOpenPlan(id)}}/>`}
      </div>
      <div class="px-5 py-3 border-t border-line bg-sunken flex flex-wrap items-center gap-2">
        ${!isNew&&(confirmDel
          ?html`<span class="text-[13px] text-muted">Delete this booking?</span>
               <button type="button" class="btn" style=${{color:'var(--bad)'}} onClick=${()=>onDelete(f.id)}>Delete</button>
               <button type="button" class="btn btn-ghost" onClick=${()=>setConfirmDel(false)}>Keep</button>`
          :html`<button type="button" class="btn btn-ghost text-muted" onClick=${()=>setConfirmDel(true)}>Delete</button>`)}
        <div class="flex-1 min-w-0">${tried&&missing.length>0&&html`<div id="ed-missing" role="alert" class="text-[12.5px] font-medium" style=${{color:'var(--bad)'}}>Still needed: ${missing.map(m=>m.label).join(', ')}</div>`}</div>
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
  const wb=new ExcelJS.Workbook();wb.creator='FraserFlow';wb.created=new Date();
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
  const wb=new ExcelJS.Workbook();wb.creator='FraserFlow';wb.created=new Date();
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
  const wb=new ExcelJS.Workbook();wb.creator='FraserFlow';wb.created=new Date();
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
  {id:'lists',label:'Mixes & seal lists',desc:'Mix, seal and binder lists edited.'},
  /* maintenance (shown to people with Fleet & Maintenance) */
  {id:'mcritical',maint:true,label:'Critical defects & restrictions',desc:'A machine is restricted: do not use.'},
  {id:'mbooking',maint:true,label:'Restricted machines on bookings',desc:'A booking from today on has a machine that must not be used.'},
  {id:'mbreak',maint:true,label:'Breakdowns',desc:'A breakdown is reported.'},
  {id:'mprestart',maint:true,label:'Prestart missing',desc:'A machine on today’s jobs has no prestart by 9 am (9 pm for night works).'},
  {id:'mreturn',maint:true,label:'Returned to service',desc:'A restricted machine is cleared to work again.'},
  {id:'mwo',maint:true,label:'Work orders',desc:'New work orders, and work orders completed and waiting for verification.'},
  {id:'mservice',maint:true,label:'Services due',desc:'Services overdue or due soon (once a day).'}];
const NOTIF_KEY=KEY+':notif-prefs';
const NOTIF_DEFAULT={quote:false,booking:false,job:false,resource:false,lists:false,   /* roster changes: off until a person turns them on */
  mcritical:false,mbooking:false,mbreak:false,mprestart:false,mreturn:false,mwo:false,mservice:false};   /* maintenance: off too until switched on in Settings */
const MAINT_ROLES=['admin','superuser','planner','supervisor','mechanic'];
/* maintenance notifications: events from the database feed, plus things true right now (services due, missing prestarts, restricted machines on bookings) */
function maintNotifs(data,prefs){
  const out=[],now=Date.now(),today=iso(TODAY),A=data.alerts||{};
  const name=id=>(data.resources.find(r=>r.id===id)||{}).name||(A[id]&&A[id].name)||id;
  const where=b=>{const c=data.resources.find(r=>r.id===b.resourceId);const j=data.jobs.find(x=>x.id===b.jobId);return [c&&c.name,j&&jobLabel(j)].filter(Boolean).join(' · ')};
  (data.mfeed||[]).forEach(e=>{if(!prefs[e.type])return;const at=Date.parse(e.at);if(!at||now-at>NOTIF_MS)return;out.push({id:'m-'+e.id,at,text:`${name(e.asset_id)}: ${e.text}`,sub:e.sub,assetId:e.asset_id})});
  const six=new Date(TODAY);six.setHours(6,0,0,0);
  if(prefs.mservice)Object.values(A).forEach(a=>{if(a.service)out.push({id:`m-sv-${a.asset_id}-${a.service}-${today}`,at:Math.min(six.getTime(),now),text:`${name(a.asset_id)}: service ${a.service==='overdue'?'overdue':'due soon'}`,sub:a.service_plans,assetId:a.asset_id})});
  if(prefs.mbooking)data.blocks.forEach(b=>{if(b.kind!=='job'||b.end<today)return;(b.plantIds||[]).forEach(id=>{const a=A[id];if(!a||!a.restricted)return;
    out.push({id:`m-rb-${b.id}-${id}`,at:Date.parse(a.restricted_since)||now,text:`${name(id)} is restricted but booked`,sub:`${where(b)} · ${fmtShort(parse(b.start))}${b.end!==b.start?' – '+fmtShort(parse(b.end)):''}`,blockId:b.id})})});
  if(prefs.mprestart){const nd=new Date();data.blocks.forEach(b=>{if(b.kind!=='job'||!covers(b,today)||!worksOn(b,TODAY))return;
    const th=new Date(TODAY);th.setHours(b.shift==='night'?21:9,0,0,0);if(nd<th)return;
    (b.plantIds||[]).forEach(id=>{const a=A[id];if(!a||(a.last_prestart_at&&iso(new Date(a.last_prestart_at))===today))return;
      out.push({id:`m-pm-${id}-${today}`,at:th.getTime(),text:`No prestart yet today: ${name(id)}`,sub:where(b),blockId:b.id})})})}
  const seen=new Set();return out.filter(c=>!seen.has(c.id)&&seen.add(c.id));
}
const loadNotifPrefs=()=>{try{return {...NOTIF_DEFAULT,...JSON.parse(localStorage.getItem(NOTIF_KEY)||'{}')}}catch(e){return {...NOTIF_DEFAULT}}};
const recentQuoteChanges=data=>(data.quoteChanges||[]).filter(c=>Date.now()-c.at<NOTIF_MS).sort((a,b)=>b.at-a.at);
const agoText=t=>{const m=Math.round((Date.now()-t)/6e4);if(m<1)return 'just now';if(m<60)return `${m} min ago`;const h=Math.round(m/60);return `${h} hr${h===1?'':'s'} ago`};
/* ---------- change log: every change to the shared roster becomes a notification ---------- */
const CHANGE_KEEP=7*DAY_MS;
const LIST_SETTINGS=[['planQuick','Planning quick-add subcontractors'],['planSteps','Planning quick-add method steps'],['truckCos','Trucks'],['subCos','Subcontractors'],['subServices','Subcontractor services'],['programLocs','Locations'],['locColors','Location colours'],['truckDefs','Truck defaults'],['machineCats','Machine categories'],['mixTypes','Mixes'],['binders','Binders'],['mixRap','Mix RAP %'],['mixBinder','Mix default binders'],['sealTypes','Seal types'],['sealBinders','Seal binders'],['sealBinder','Seal default binders'],['sealTwoCoat','Two coat seals']];
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
  if((p.crewSize||'')!==(x.crewSize||''))ch('Crew size',p.crewSize?p.crewSize+' man':'',x.crewSize?x.crewSize+' man':'');
  if(!!p.inductionReq!==!!x.inductionReq)ch('Site induction required',p.inductionReq?'Yes':'No',x.inductionReq?'Yes':'No');
  if(!!p.inductionDone!==!!x.inductionDone)ch('Induction paperwork sent',p.inductionDone?'Yes':'No',x.inductionDone?'Yes':'No');
  if(!!p.sapEntered!==!!x.sapEntered)ch('Entered into SAP',p.sapEntered?'Yes':'No',x.sapEntered?'Yes':'No');
  if(!!p.creditIssue!==!!x.creditIssue)ch('Credit issue',p.creditIssue?'Yes':'No',x.creditIssue?'Yes':'No');
  [['address','Site address'],['projectNo','Project number'],['quoteNo','Quote number'],['supervisor','Supervisor'],['supervisorPhone','Supervisor phone'],['title','Label'],['maintShift','Maintenance shift'],['notes','Notes']]
    .forEach(([f,l])=>{if((p[f]||'')!==(x[f]||''))ch(l,cut(p[f]),cut(x[f]))});
  const pa=p.plantIds||[],pb=x.plantIds||[];
  const add=pb.filter(i=>!pa.includes(i)).map(i=>rname(b,i)),rem=pa.filter(i=>!pb.includes(i)).map(i=>rname(a,i));
  if(add.length)L.push(`Mobile plant added: ${add.join(', ')}`);if(rem.length)L.push(`Mobile plant removed: ${rem.join(', ')}`);
  [['Friday',friOn],['Saturday',satOn],['Sunday',sunOn]].forEach(([l,fn])=>{if(fn(p)!==fn(x))ch(l,fn(p)?'shift':'off',fn(x)?'shift':'off')});
  const oa=p.offDays||[],ob=x.offDays||[];ob.filter(k=>!oa.includes(k)).forEach(k=>L.push(`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}: now a day off`));
  oa.filter(k=>!ob.includes(k)).forEach(k=>L.push(`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}: now a shift`));
  /* quantities, shift by shift */
  const sa=p.shiftData||{},sb=x.shiftData||{};
  const lineTxt=l=>[(l.type||'').trim(),l.binder,l.virgin?'virgin':'',num(l.tonnes)?`${fmtN(num(l.tonnes))} t`:'',num(l.area)?`${fmtN(num(l.area))} m²`:'',num(l.depth)?`${fmtN(num(l.depth))} mm`:'',(l.stone||'').trim()?`stone ${l.stone.trim()}`:'',num(l.spray)?`spray ${fmtN(num(l.spray))} L/m²`:'',num(l.spread)?`spread ${fmtN(num(l.spread))} m²/m³`:'',l.twoCoat?`2nd coat ${[l.binder2,l.stone2,num(l.spray2)?fmtN(num(l.spray2))+' L/m²':'',num(l.spread2)?fmtN(num(l.spread2))+' m²/m³':''].filter(Boolean).join(' ')}`:''].filter(Boolean).join(' ');
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
      if((p.crewId||'')!==(r.crewId||''))parts.push(r.crewId?`now in ${rname(b,r.crewId)}`:'no crew');if(p.hue!==r.hue)parts.push('colour');if((p.category||'')!==(r.category||''))parts.push(`category ${p.category||'(none)'} → ${r.category||'(none)'}`);if((p.rego||'')!==(r.rego||''))parts.push(`rego ${p.rego||'(none)'} → ${r.rego||'(none)'}`);if(!!p.subbie!==!!r.subbie)parts.push(r.subbie?'now a subcontractor':'no longer a subcontractor');
      out.push({type:'resource',text:`${w} changed: ${r.name}`,sub:parts.join(', ')})});
    a.resources.forEach(p=>{if(!bm.has(p.id))out.push({type:'resource',text:`${RES_WORD[p.type]||'Resource'} removed: ${p.name}`,sub:''})});
  }
  if(a.plans!==b.plans){const am=new Map((a.plans||[]).map(x=>[x.id,x])),bm=new Map((b.plans||[]).map(x=>[x.id,x]));const nm=x=>x.title||x.jobName||'Untitled plan';
    (b.plans||[]).forEach(x=>{const o=am.get(x.id);if(!o)out.push({type:'job',text:`Plan started: ${nm(x)}`,sub:''});else if(o.appliedAt!==x.appliedAt&&x.appliedAt)out.push({type:'job',text:`Plan sent to the schedule: ${nm(x)}`,sub:''})});
    (a.plans||[]).forEach(x=>{if(!bm.has(x.id))out.push({type:'job',text:`Plan deleted: ${nm(x)}`,sub:''})})}
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
                ${c.by&&html`<div class="text-[11.5px] text-faint mt-0.5">by ${showLogin(c.by)}</div>`}
              </div>
              ${b&&html`<button class="btn shrink-0" style=${{height:28}} onClick=${()=>{onClose();onOpen(b)}}>Open</button>`}
            </div></div>`})}
        ${shown.length>limit&&html`<div class="p-4 text-center"><button class="btn" onClick=${()=>setLimit(l=>l+300)}>Show more (${shown.length-limit} left)</button></div>`}
      </div>
    </div>
  </div>`;
}

/* =====================================================================
   Ideas: an admin-only board for planning what to add to FraserFlow,
   plus suggestions anyone can send in. Ideas and suggestions are only
   readable by administrators (database rule); everyone can add a suggestion.
   ===================================================================== */
/* --- only used once, to move a board made with the old password lock --- */
const vBytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function vaultKey(pw,salt){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function vaultOpen(key,vault){const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:vBytes(vault.iv)},key,vBytes(vault.ct));return JSON.parse(new TextDecoder().decode(pt))}
async function openSuggestion(privJwk,enc){
  const priv=await crypto.subtle.importKey('jwk',privJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
  const raw=await crypto.subtle.decrypt({name:'RSA-OAEP'},priv,vBytes(enc.k));const k=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:vBytes(enc.iv)},k,vBytes(enc.ct))))}

/* anyone can suggest an idea (it lands in the Ideas inbox, which only administrators can read) */
function SuggestDialog({setData,onClose,notify}){
  const [text,setText]=useState('');
  useEffect(()=>{const h=e=>{if(e.key==='Escape'){e.stopPropagation();onClose()}};window.addEventListener('keydown',h,true);return()=>window.removeEventListener('keydown',h,true)},[]);
  const send=e=>{e.preventDefault();const t=text.trim();if(!t)return;const now=Date.now();
    setData(d=>({...d,suggestions:[...(d.suggestions||[]),{id:'s'+uid(),at:now,text:t,by:window.__rosterMe||''}]}));notify&&notify('Thanks! Your suggestion was sent');onClose()};
  return html`<div class="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <form class="panel pop w-full max-w-[480px] p-5 grid gap-3" role="dialog" aria-modal="true" aria-labelledby="sg-t" onSubmit=${send}>
      <div class="flex items-start gap-3"><div class="min-w-0 flex-1"><div id="sg-t" class="font-display text-[18px] font-semibold">Suggest an idea</div>
        <div class="text-[12.5px] text-muted">Something FraserFlow should do, or do better? Only administrators can read suggestions.</div></div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button></div>
      <textarea id="sg-text" class="field" style=${{height:'auto',minHeight:120,padding:'8px 10px',resize:'vertical',fontSize:13.5}} rows="5" autoFocus=${true}
        placeholder="e.g. Text each crew tomorrow’s start time at 3pm" value=${text} onInput=${e=>setText(e.target.value)}></textarea>
      <div class="flex justify-end gap-2"><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="sg-send" type="submit" class="btn btn-primary" disabled=${!text.trim()}>Send suggestion</button></div>
    </form></div>`;
}

const IDEA_COLS=[['idea','Ideas','Things worth doing one day'],['planned','Planned','Decided, not started'],['doing','In progress','Being built now'],['done','Done','Shipped']];
const IDEA_PRI={high:['High','hsl(352 70% var(--blk-l))','hsl(352 60% var(--blk-fg-l))'],med:['Medium','hsl(38 85% var(--blk-l))','hsl(30 60% var(--blk-fg-l))'],low:['Low','var(--sunken)','var(--muted)']};

function IdeasScreen({data,setData,notify}){
  const items=data.ideas||[];
  const [q,setQ]=useState('');const [open,setOpen]=useState(null);const [ed,setEd]=useState(null);const [confirmDel,setConfirmDel]=useState(null);
  const [draft,setDraft]=useState({title:'',priority:'med'});
  const setItems=fn=>setData(d=>({...d,ideas:fn(d.ideas||[])}));
  const patch=(id,p)=>setItems(xs=>xs.map(x=>x.id===id?{...x,...p,updated:Date.now()}:x));
  const add=e=>{e.preventDefault();const t=draft.title.trim();if(!t)return;const now=Date.now();
    setItems(xs=>[{id:'i'+uid(),title:t,notes:'',status:'idea',priority:draft.priority,created:now,updated:now},...xs]);setDraft({...draft,title:''})};
  const move=(it,dir)=>{const i=IDEA_COLS.findIndex(c=>c[0]===it.status);const n=IDEA_COLS[i+dir];if(n)patch(it.id,{status:n[0]})};
  const startEdit=it=>{setOpen(it.id);setEd({title:it.title,notes:it.notes||''});setConfirmDel(null)};
  const finishEdit=it=>{if(ed&&(ed.title.trim()!==it.title||ed.notes!==(it.notes||'')))patch(it.id,{title:ed.title.trim()||it.title,notes:ed.notes});setOpen(null);setEd(null);setConfirmDel(null)};
  /* suggestions inbox */
  const sugg=(data.suggestions||[]).filter(s=>s.text).slice().sort((a,b)=>(a.at||0)-(b.at||0));
  const dropSugg=id=>setData(d=>({...d,suggestions:(d.suggestions||[]).filter(x=>x.id!==id)}));
  const takeSugg=s=>{const t=(s.text||'').trim();const first=t.split('\n')[0];const now=Date.now();const long=first.length>90;
    setData(d=>({...d,ideas:[{id:'i'+uid(),title:long?first.slice(0,87)+'…':first,
      notes:`${long?t:t.split('\n').slice(1).join('\n').trim()}${long||t.includes('\n')?'\n\n':''}Suggested by ${s.by||'someone'} on ${new Date(s.at).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}`,
      status:'idea',priority:'med',created:now,updated:now},...(d.ideas||[])],suggestions:(d.suggestions||[]).filter(x=>x.id!==s.id)}));notify&&notify('Added to Ideas')};

  /* a board made with the old password lock: open it once with its password and move it across */
  const vault=data.ideasVault&&data.ideasVault.ct?data.ideasVault:null;
  const [pw,setPw]=useState('');const [err,setErr]=useState('');const [busy,setBusy]=useState(false);const [discard,setDiscard]=useState(false);
  const migrate=async e=>{e.preventDefault();setErr('');if(!pw)return;setBusy(true);
    try{const o=await vaultOpen(await vaultKey(pw,vBytes(vault.salt)),vault);
      const old=await Promise.all((data.suggestions||[]).filter(s=>s.enc).map(s=>o.priv?openSuggestion(o.priv,s.enc).then(x=>({id:s.id,at:x.at||s.at,text:x.text,by:x.by||''})).catch(()=>null):null));
      setData(d=>({...d,ideas:[...(o.items||[]),...(d.ideas||[])],suggestions:[...(d.suggestions||[]).filter(s=>!s.enc),...old.filter(Boolean)],ideasVault:null,ideasPub:null}));
      notify&&notify('Ideas board moved. No password needed from now on')}
    catch(x){setErr('That password is wrong.')}finally{setBusy(false)}};
  if(vault)return html`<div class="flex-1 min-h-0 flex items-start justify-center pt-10 px-4">
    <form class="panel w-full max-w-[420px] p-6 grid gap-3" onSubmit=${migrate}>
      <div class="font-display text-[18px] font-semibold">Move your Ideas board</div>
      <p class="text-[13px] text-muted">Ideas no longer needs its own password: administrators can open it straight away. Enter the old password once to bring your existing board across.</p>
      <label class="grid gap-1"><span class="label">Old Ideas password</span><input id="ideas-pw" type="password" autocomplete="current-password" class="field" value=${pw} onInput=${e=>setPw(e.target.value)} autoFocus=${true}/></label>
      ${err&&html`<div id="ideas-err" role="alert" class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      <button id="ideas-go" type="submit" class="btn btn-primary justify-center" disabled=${busy}>${busy?'Moving…':'Move my board'}</button>
      <div class="text-[12.5px] text-muted">Forgotten it? ${discard
        ?html`<span>This deletes the old board for good. <button type="button" class="font-semibold underline" style=${{color:'var(--bad)'}} onClick=${()=>{setData(d=>({...d,ideasVault:null,ideasPub:null,suggestions:(d.suggestions||[]).filter(s=>!s.enc)}));setDiscard(false)}}>Delete it</button> · <button type="button" class="underline" onClick=${()=>setDiscard(false)}>Keep</button></span>`
        :html`<button type="button" class="underline hover:text-ink" onClick=${()=>setDiscard(true)}>Start a new board instead</button>`}</div>
    </form></div>`;

  const ql=q.trim().toLowerCase();
  const shown=items.filter(x=>!ql||(x.title+' '+(x.notes||'')).toLowerCase().includes(ql));
  const pri={high:0,med:1,low:2};
  return html`<div class="flex-1 min-h-0 flex flex-col gap-3">
    <section class="panel px-4 py-3 flex flex-wrap items-center gap-3">
      <span class="text-[12.5px] text-muted">Only administrators can see this page</span>
      <form class="flex flex-1 min-w-[300px] items-center gap-2" onSubmit=${add}>
        <input id="idea-new" class="field flex-1 min-w-0" placeholder="Add an idea for FraserFlow…" value=${draft.title} onInput=${e=>setDraft({...draft,title:e.target.value})} aria-label="New idea"/>
        <select id="idea-new-pri" class="field shrink-0" style=${{width:110}} value=${draft.priority} onChange=${e=>setDraft({...draft,priority:e.target.value})} aria-label="Priority">
          ${Object.entries(IDEA_PRI).map(([k,v])=>html`<option key=${k} value=${k}>${v[0]}</option>`)}</select>
        <button id="idea-add" class="btn btn-primary shrink-0" type="submit" disabled=${!draft.title.trim()}>${Icon.plus} Add</button>
      </form>
      <input id="idea-search" class="field shrink-0" style=${{width:200}} placeholder="Search ideas" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search ideas"/>
    </section>
    ${sugg.length>0&&html`<section id="ideas-inbox" class="panel px-4 py-3 grid gap-2" aria-label="Suggestions">
      <div class="flex items-baseline gap-2"><span class="font-display text-[15px] font-semibold">Suggestions</span><span class="mono text-[12px] text-faint">${sugg.length}</span>
        <span class="text-[12px] text-muted">Sent in by people using FraserFlow. Add the good ones to the board.</span></div>
      <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        ${sugg.map(s=>html`<article key=${s.id} class="rounded-lg border border-line bg-surface p-2.5 grid gap-1.5">
          <span class="text-[13px] whitespace-pre-line">${s.text}</span><span class="text-[11.5px] text-faint">${s.by||'Someone'} · ${new Date(s.at).toLocaleDateString('en-AU',{day:'numeric',month:'short'})}</span>
          <div class="flex items-center gap-2"><button type="button" class="btn btn-primary" style=${{height:28,fontSize:12.5}} onClick=${()=>takeSugg(s)}>${Icon.plus} Add to Ideas</button>
            <button type="button" class="btn btn-ghost" style=${{height:28,fontSize:12.5}} onClick=${()=>dropSugg(s.id)}>Dismiss</button></div></article>`)}
      </div></section>`}
    <div class="flex-1 min-h-0 overflow-auto">
      <div class="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-4 min-h-full items-start">
        ${IDEA_COLS.map(([st,label,hint],ci)=>{const col=shown.filter(x=>x.status===st).sort((a,b)=>(pri[a.priority]??1)-(pri[b.priority]??1)||(b.updated||0)-(a.updated||0));
          return html`<section key=${st} id=${'ideas-col-'+st} class="panel p-3 grid gap-2 content-start" aria-label=${label}>
            <div class="flex items-baseline gap-2 px-1"><span class="font-display text-[15px] font-semibold">${label}</span><span class="mono text-[12px] text-faint">${col.length}</span>
              <span class="flex-1"></span><span class="text-[11.5px] text-faint">${hint}</span></div>
            ${col.length===0&&html`<div class="text-[12.5px] text-faint px-1 py-3">${ql?'Nothing matches.':st==='idea'?'Add your first idea above.':'Nothing here yet.'}</div>`}
            ${col.map(it=>{const P=IDEA_PRI[it.priority]||IDEA_PRI.med;const isEd=open===it.id&&ed;
              return html`<article key=${it.id} class="rounded-lg border border-line bg-surface p-2.5 grid gap-1.5" style=${isEd?{boxShadow:'0 0 0 1.5px var(--accent)'}:null}>
                ${isEd?html`<input class="field field-sm font-semibold" aria-label="Title" value=${ed.title} onInput=${e=>setEd({...ed,title:e.target.value})}/>
                    <textarea class="field" style=${{height:'auto',minHeight:90,padding:'8px 10px',resize:'vertical',fontSize:13}} rows="4" placeholder="Details, why it matters, how it should work…" aria-label="Notes" value=${ed.notes} onInput=${e=>setEd({...ed,notes:e.target.value})}></textarea>
                    <div class="flex flex-wrap items-center gap-2">
                      <select class="field field-sm w-auto" aria-label="Status" value=${it.status} onChange=${e=>patch(it.id,{status:e.target.value})}>${IDEA_COLS.map(c=>html`<option key=${c[0]} value=${c[0]}>${c[1]}</option>`)}</select>
                      <select class="field field-sm w-auto" aria-label="Priority" value=${it.priority} onChange=${e=>patch(it.id,{priority:e.target.value})}>${Object.entries(IDEA_PRI).map(([k,v])=>html`<option key=${k} value=${k}>${v[0]} priority</option>`)}</select>
                      <span class="flex-1"></span>
                      ${confirmDel===it.id
                        ?html`<button type="button" class="text-[12px] font-semibold" style=${{color:'var(--bad)'}} onClick=${()=>{setItems(xs=>xs.filter(x=>x.id!==it.id));setConfirmDel(null);setOpen(null);setEd(null)}}>Delete</button><button type="button" class="text-[12px] text-muted" onClick=${()=>setConfirmDel(null)}>Keep</button>`
                        :html`<button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>setConfirmDel(it.id)}>Delete</button>`}
                      <button type="button" class="btn btn-primary" style=${{height:28}} onClick=${()=>finishEdit(it)}>Done</button></div>`
                  :html`<button type="button" class="text-left grid gap-1" onClick=${()=>{const cur=items.find(x=>x.id===open);if(cur)finishEdit(cur);startEdit(it)}} title="Edit">
                      <span class="font-medium text-[13.5px] leading-snug">${it.title}</span>
                      ${it.notes&&html`<span class="text-[12.5px] text-muted whitespace-pre-line" style=${{display:'-webkit-box',WebkitLineClamp:3,WebkitBoxOrient:'vertical',overflow:'hidden'}}>${it.notes}</span>`}</button>
                    <div class="flex items-center gap-1.5">
                      <span class="text-[10.5px] font-semibold px-1.5 py-0.5 rounded" style=${{background:P[1],color:P[2]}}>${P[0]}</span>
                      <span class="text-[11px] text-faint">${new Date(it.updated||it.created).toLocaleDateString('en-AU',{day:'numeric',month:'short'})}</span>
                      <span class="flex-1"></span>
                      <button type="button" class="w-6 h-6 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken disabled:opacity-30" disabled=${ci===0} onClick=${()=>move(it,-1)} aria-label=${'Move to '+(IDEA_COLS[ci-1]||[])[1]}>${Icon.chevL}</button>
                      <button type="button" class="w-6 h-6 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken disabled:opacity-30" disabled=${ci===IDEA_COLS.length-1} onClick=${()=>move(it,1)} aria-label=${'Move to '+(IDEA_COLS[ci+1]||[])[1]}>${Icon.chevR}</button></div>`}
              </article>`})}
          </section>`})}
      </div>
    </div>
  </div>`;
}

/* =====================================================================
   Jobs screen: every job at a glance, and one job in detail (bookings,
   quantities, crews, plans). Built to grow: paperwork comes next.
   ===================================================================== */
function jobSummary(data,j){
  const today=iso(TODAY);const bs=data.blocks.filter(b=>b.kind==='job'&&b.jobId===j.id).sort((a,b)=>a.start.localeCompare(b.start));
  let t=0,a=0,shifts=0,done=0;const mixes=new Map();
  bs.forEach(b=>{const q=qtyTotals(b);t+=q.tonnes;a+=q.area;q.byType.forEach(g=>mixes.set(g.type,(mixes.get(g.type)||0)+g.tonnes));
    const ds=shiftDates(b);shifts+=ds.length;done+=ds.filter(k=>k<today).length});
  const allDates=bs.flatMap(b=>shiftDates(b)).sort();
  const next=allDates.find(k=>k>=today)||null;
  const first=bs.length?bs[0].start:null,last=bs.reduce((m,b)=>!m||b.end>m?b.end:m,null);
  const crews=[...new Set(bs.map(b=>b.resourceId))].map(id=>data.resources.find(r=>r.id===id)).filter(Boolean);
  const status=j.completed?'done':!bs.length?'none':next===today||bs.some(b=>b.start<=today&&b.end>=today)?'now':next?'upcoming':'finished';
  return {bs,t,a,shifts,done,next,first,last,crews,status,mixes:[...mixes].sort((x,y)=>y[1]-x[1])}}
const JOB_STATUS={now:['On site today','var(--accent)','var(--accent-soft)'],upcoming:['Upcoming','hsl(210 70% var(--blk-fg-l))','hsl(210 80% var(--blk-l))'],
  finished:['All shifts done','hsl(145 50% var(--blk-fg-l))','hsl(145 50% var(--blk-l))'],none:['No bookings','var(--muted)','var(--sunken)'],done:['Completed','var(--muted)','var(--sunken)']};
const jobStatusChip=s=>{const [l,c,bg]=JOB_STATUS[s];return html`<span class="text-[10.5px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style=${{color:c,background:bg}}>${l}</span>`};

function JobsScreen({data,setData,notify,onEditBooking,onOpenPlan}){
  const [view,setView]=useState('active');const [q,setQ]=useState('');
  const [sel,setSel]=useState(()=>{try{return localStorage.getItem(KEY+':job')||''}catch(e){return ''}});
  const pick=id=>{setSel(id);setEdit(null);setConfirmDel(false);try{localStorage.setItem(KEY+':job',id)}catch(e){}};
  const [adding,setAdding]=useState(null);const [edit,setEdit]=useState(null);const [confirmDel,setConfirmDel]=useState(false);const [pending,setPending]=useState(null);const [msg,setMsg]=useState('');
  const sums=useMemo(()=>new Map(data.jobs.map(j=>[j.id,jobSummary(data,j)])),[data.jobs,data.blocks]);
  const order={now:0,upcoming:1,finished:2,none:3,done:4};
  const ql=q.trim().toLowerCase();
  const list=data.jobs.filter(j=>!!j.completed===(view==='completed')&&(!ql||[j.name,j.customer,j.address,j.projectNo].join(' ').toLowerCase().includes(ql)))
    .sort((x,y)=>{const a=sums.get(x.id),b=sums.get(y.id);if(view==='completed')return (y.completedAt||'').localeCompare(x.completedAt||'');
      return order[a.status]-order[b.status]||(a.next||'9').localeCompare(b.next||'9')||x.name.localeCompare(y.name)});
  const nDone=data.jobs.filter(j=>j.completed).length;
  const job=data.jobs.find(j=>j.id===sel)||null;const S=job&&sums.get(job.id);
  const customers=[...new Set(data.jobs.map(j=>(j.customer||'').trim()).filter(Boolean))].sort();
  const dup=(name,except)=>data.jobs.some(j=>j.id!==except&&j.name.trim().toLowerCase()===name.trim().toLowerCase());
  const create=e=>{e.preventDefault();const name=(adding.name||'').trim();if(!name){setMsg('Give the job a name.');return}if(dup(name)){setMsg(`There is already a job called ${name}.`);return}
    const id='j'+uid();setData(d=>({...d,jobs:[...d.jobs,{id,name,customer:(adding.customer||'').trim(),address:(adding.address||'').trim(),projectNo:(adding.projectNo||'').trim(),hue:JOB_HUES[d.jobs.length%JOB_HUES.length]}]}));
    setAdding(null);setMsg('');setView('active');pick(id);notify&&notify('Job added')};
  const saveEdit=e=>{e.preventDefault();const name=(edit.name||'').trim();if(!name){setMsg('Give the job a name.');return}if(dup(name,job.id)){setMsg(`There is already a job called ${name}.`);return}
    setData(d=>({...d,jobs:d.jobs.map(j=>j.id===job.id?{...j,name,customer:(edit.customer||'').trim(),address:(edit.address||'').trim(),projectNo:(edit.projectNo||'').trim()}:j)}));setEdit(null);setMsg('')};
  const setDone=(id,done)=>setData(d=>({...d,jobs:d.jobs.map(j=>j.id===id?(done?{...j,completed:true,completedAt:iso(TODAY)}:(({completed,completedAt,...rest})=>rest)(j)):j)}));
  const tryDone=done=>{if(!done){setDone(job.id,false);setView('active');return}const live=S.bs.filter(b=>b.end>=iso(TODAY));if(live.length)setPending(live);else{setDone(job.id,true);setView('completed')}};
  const fs={height:32,fontSize:13};
  const plans=job?(data.plans||[]).filter(p=>p.jobId===job.id||S.bs.some(b=>b.id===p.bookingId)):[];
  const tile=(k,v,sub,small)=>html`<div class="rounded-lg border border-line bg-surface px-3 py-2.5 min-w-0"><div class="label">${k}</div><div class=${'font-display font-semibold tnum truncate '+(small?'text-[15px] leading-[28px]':'text-[19px]')} title=${typeof v==='string'?v:undefined}>${v}</div>${sub&&html`<div class="text-[11.5px] text-muted truncate">${sub}</div>`}</div>`;
  const range=(a,b)=>a?`${fmtShort(parse(a))}${b&&b!==a?' – '+fmtShort(parse(b)):''}`:'–';

  return html`<div class="flex-1 min-h-0 flex gap-3">
    <aside class="panel w-[340px] shrink-0 flex flex-col min-h-0 overflow-hidden">
      <div class="px-3 pt-3 pb-2 grid gap-2 border-b border-line">
        <div class="flex items-center gap-2">
          <div class="seg flex-1" role="group" aria-label="Show jobs">
            <button type="button" class="flex-1" aria-pressed=${view==='active'} onClick=${()=>setView('active')}>Active <span class="mono text-[11px] text-faint">${data.jobs.length-nDone}</span></button>
            <button type="button" class="flex-1" aria-pressed=${view==='completed'} onClick=${()=>setView('completed')}>Completed <span class="mono text-[11px] text-faint">${nDone}</span></button></div>
          <button id="job-new" type="button" class="btn btn-primary shrink-0" onClick=${()=>{setAdding(adding?null:{name:'',customer:'',address:'',projectNo:''});setMsg('')}}>${Icon.plus} New</button></div>
        <input id="job-search" class="field" style=${fs} placeholder="Search job, customer, address, project" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search jobs"/>
      </div>
      ${adding&&html`<form class="px-3 py-3 grid gap-2 border-b border-line bg-sunken" onSubmit=${create}>
        <div class="text-[13px] font-semibold">New job</div>
        <input id="jn-name" class="field" style=${fs} placeholder="Job name, e.g. Duntroon St resheet" value=${adding.name} autoFocus=${true} onInput=${e=>setAdding({...adding,name:e.target.value})} aria-label="Job name"/>
        <${Combo} id="jn-customer" className="field" style=${fs} placeholder="Customer" label="Customer" value=${adding.customer} onChange=${v=>setAdding({...adding,customer:v})} options=${customers}/>
        <input id="jn-address" class="field" style=${fs} placeholder="Site address" value=${adding.address} onInput=${e=>setAdding({...adding,address:e.target.value})} aria-label="Site address"/>
        <input id="jn-project" class="field mono" style=${fs} placeholder="Project number" value=${adding.projectNo} onInput=${e=>setAdding({...adding,projectNo:e.target.value})} aria-label="Project number"/>
        ${msg&&html`<div class="text-[12px]" style=${{color:'var(--bad)'}}>${msg}</div>`}
        <div class="flex justify-end gap-2"><button type="button" class="btn btn-ghost" onClick=${()=>setAdding(null)}>Cancel</button><button id="jn-add" type="submit" class="btn btn-primary">Add job</button></div>
      </form>`}
      <ul class="flex-1 min-h-0 overflow-y-auto p-2 grid gap-1 content-start" aria-label="Jobs">
        ${list.length===0&&html`<li class="px-3 py-6 text-center text-[13px] text-muted">${ql?`Nothing matches “${q}”.`:view==='completed'?'No completed jobs yet.':'No active jobs. Add one with New.'}</li>`}
        ${list.map(j=>{const s=sums.get(j.id);const on=j.id===sel;
          return html`<li key=${j.id}><button type="button" class=${'w-full text-left rounded-lg px-2.5 py-2 grid gap-1 '+(on?'':'hover:bg-sunken')} style=${on?{background:'var(--accent-soft)',boxShadow:'inset 3px 0 0 var(--accent)'}:null} onClick=${()=>pick(j.id)} aria-current=${on?'true':undefined}>
            <div class="flex items-center gap-2 min-w-0"><span class="w-2.5 h-2.5 rounded-sm shrink-0" style=${{background:`hsl(${j.hue??200} 60% 55%)`}}></span>
              <span class="font-medium text-[13.5px] truncate flex-1">${j.customer?html`<span class="text-muted">${j.customer} · </span>`:''}${j.name}</span>${jobStatusChip(s.status)}</div>
            <div class="flex items-center gap-2 text-[11.5px] text-muted pl-[18px] min-w-0">
              <span class="truncate flex-1">${j.address||'No address'}</span>
              ${s.t>0&&html`<span class="mono tnum shrink-0">${fmtN(s.t)} t</span>`}</div>
            <div class="flex items-center gap-2 text-[11.5px] text-faint pl-[18px]">
              ${j.projectNo&&html`<span class="mono">P ${j.projectNo}</span>`}
              <span>${s.bs.length} booking${s.bs.length===1?'':'s'}</span>
              ${s.shifts>0&&html`<span>${s.done}/${s.shifts} shifts</span>`}
              ${s.next&&s.status!=='done'&&html`<span class="ml-auto">${s.next===iso(TODAY)?'Today':'Next '+WD[parse(s.next).getDay()]+' '+fmtShort(parse(s.next))}</span>`}</div>
          </button></li>`})}
      </ul>
    </aside>

    <div class="flex-1 min-w-0 min-h-0 overflow-y-auto pr-1">
      ${!job?html`<div class="panel p-8 text-center text-[13px] text-muted">Pick a job on the left to see everything about it.</div>`:html`<div class="grid gap-3">
        ${pending&&html`<div class="panel p-4 grid gap-2" role="alert" style=${{boxShadow:'inset 0 0 0 1.5px hsl(40 85% 50%)'}}>
          <div class="text-[13.5px] font-semibold">This job still has ${pending.length} booking${pending.length===1?'':'s'} today or later</div>
          <div class="text-[12.5px] text-muted">Completing it moves it to Completed but leaves the bookings on the schedule.</div>
          <div class="flex gap-2"><button type="button" class="btn" onClick=${()=>setPending(null)}>Keep active</button><button type="button" class="btn btn-primary" onClick=${()=>{setDone(job.id,true);setPending(null);setView('completed')}}>Complete anyway</button></div></div>`}
        <section class="panel p-4 grid gap-3">
          ${edit?html`<form class="grid gap-2" onSubmit=${saveEdit}>
              <div class="grid sm:grid-cols-2 gap-2">
                <label class="grid gap-1"><span class="label">Job name</span><input id="je-name" class="field" style=${fs} value=${edit.name} onInput=${e=>setEdit({...edit,name:e.target.value})}/></label>
                <label class="grid gap-1"><span class="label">Customer</span><${Combo} id="je-customer" className="field" style=${fs} label="Customer" value=${edit.customer} onChange=${v=>setEdit({...edit,customer:v})} options=${customers}/></label>
                <label class="grid gap-1"><span class="label">Site address</span><input id="je-address" class="field" style=${fs} value=${edit.address} onInput=${e=>setEdit({...edit,address:e.target.value})}/></label>
                <label class="grid gap-1"><span class="label">Project number</span><input id="je-project" class="field mono" style=${fs} value=${edit.projectNo} onInput=${e=>setEdit({...edit,projectNo:e.target.value})}/></label></div>
              ${msg&&html`<div class="text-[12px]" style=${{color:'var(--bad)'}}>${msg}</div>`}
              <div class="flex justify-end gap-2"><button type="button" class="btn btn-ghost" onClick=${()=>{setEdit(null);setMsg('')}}>Cancel</button><button id="je-save" type="submit" class="btn btn-primary">Save</button></div></form>`
            :html`<div class="flex flex-wrap items-start gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-[12.5px] text-muted">${job.customer||'No customer'}${job.projectNo?html` · <span class="mono">Project ${job.projectNo}</span>`:''}</div>
                <h2 class="font-display text-[22px] font-semibold leading-tight">${job.name}</h2>
                <div class="text-[13px] text-muted flex items-center gap-1.5 mt-0.5">${Icon.pin} ${job.address||'No site address'}</div>
              </div>
              <div class="flex flex-wrap items-center gap-2">${jobStatusChip(S.status)}
                <button id="job-edit" type="button" class="btn" onClick=${()=>{setEdit({name:job.name,customer:job.customer||'',address:job.address||'',projectNo:job.projectNo||''});setMsg('')}}>${Icon.pencil} Edit</button>
                <button id="job-done" type="button" class="btn" onClick=${()=>tryDone(!job.completed)}>${job.completed?'Reopen job':'Mark completed'}</button>
                ${S.bs.length===0&&(confirmDel?html`<button type="button" class="btn" style=${{color:'var(--bad)'}} onClick=${()=>{setData(d=>({...d,jobs:d.jobs.filter(x=>x.id!==job.id)}));pick('')}}>Delete job</button><button type="button" class="btn btn-ghost" onClick=${()=>setConfirmDel(false)}>Keep</button>`
                  :html`<button type="button" class="btn btn-ghost text-muted" onClick=${()=>setConfirmDel(true)}>Delete</button>`)}
              </div></div>`}
          <div class="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            ${tile('Bookings',S.bs.length,S.crews.map(c=>c.name).join(', ')||'–')}
            ${tile('Shifts',S.shifts?`${S.done} / ${S.shifts}`:'–',S.shifts?`${S.shifts-S.done} to go`:'')}
            ${tile('Next shift',S.next?(S.next===iso(TODAY)?'Today':`${WD[parse(S.next).getDay()]} ${fmtShort(parse(S.next))}`):'–',S.next?'':'Nothing booked ahead')}
            ${tile('Asphalt',S.t?`${fmtN(S.t)} t`:'–','')}
            ${tile('Area',S.a?`${fmtN(S.a)} m²`:'–','')}
            ${tile('Dates',range(S.first,S.last),job.completed&&job.completedAt?`Completed ${fmtShort(parse(job.completedAt))}`:'',true)}
          </div>
          ${S.mixes.length>0&&html`<div class="flex flex-wrap gap-1.5">${S.mixes.map(([m,t])=>html`<span key=${m} class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] bg-sunken border border-line"><span class="font-semibold mono">${m}</span>${t>0&&html`<span class="text-muted tnum">${fmtN(t)} t</span>`}</span>`)}</div>`}
        </section>

        <section class="panel p-4 grid gap-2" aria-labelledby="job-bk">
          <div class="flex items-baseline gap-2"><h3 id="job-bk" class="font-display text-[15px] font-semibold">Bookings</h3><span class="text-[12px] text-muted">Click one to open it</span></div>
          ${!S.bs.length?html`<div class="text-[12.5px] text-muted">No bookings for this job yet. Add one from the Schedule.</div>`:html`<div class="overflow-x-auto"><table class="w-full text-[12.5px]">
            <thead><tr class="text-left">${['Crew','Dates','Shift','Shifts','Tonnes','Supervisor','Quote','Flags'].map(h=>html`<th key=${h} class="label font-normal py-1.5 pr-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
            <tbody>${S.bs.map(b=>{const c=data.resources.find(r=>r.id===b.resourceId);const qt=qtyTotals(b);const ds=shiftDates(b);const today=iso(TODAY);const past=b.end<today,live=b.start<=today&&b.end>=today;
              return html`<tr key=${b.id} class="border-t border-line cursor-pointer hover:bg-sunken" style=${past?{opacity:.6}:null} onClick=${()=>onEditBooking(b)} tabindex="0" onKeyDown=${e=>{if(e.key==='Enter')onEditBooking(b)}}>
                <td class="py-2 pr-3 whitespace-nowrap"><span class="font-medium">${c?c.name:'Crew'}</span>${c&&c.subbie&&html` <${SubTag}/>`}${b.crewSize?html` <span class="text-muted">· ${b.crewSize} man</span>`:''}</td>
                <td class="py-2 pr-3 mono whitespace-nowrap">${range(b.start,b.end)}${live?html` <span class="text-[10.5px] font-semibold px-1 rounded" style=${{background:'var(--accent-soft)',color:'var(--accent)'}}>Now</span>`:''}</td>
                <td class="py-2 pr-3 whitespace-nowrap">${b.shift==='night'?html`<span class="inline-flex items-center gap-1">${Icon.moon} Night</span>`:'Day'}</td>
                <td class="py-2 pr-3 tnum">${ds.length}</td>
                <td class="py-2 pr-3 tnum mono">${qt.tonnes?fmtN(qt.tonnes):qt.area?fmtN(qt.area)+' m²':'–'}</td>
                <td class="py-2 pr-3 whitespace-nowrap">${b.supervisor||html`<span class="text-faint">–</span>`}${b.supervisorPhone?html`<div class="text-[11px] text-muted mono">${b.supervisorPhone}</div>`:''}</td>
                <td class="py-2 pr-3 mono whitespace-nowrap">${b.quoteNo||html`<span class="text-faint">–</span>`}</td>
                <td class="py-2 pr-3 whitespace-nowrap"><span class="inline-flex flex-wrap gap-1">
                  ${!b.sapEntered&&html`<span class="text-[10.5px] font-semibold px-1.5 rounded" style=${{background:'hsl(38 95% 55%)',color:'hsl(30 60% 12%)'}} title="Not entered into SAP">SAP</span>`}
                  ${b.creditIssue&&html`<span class="text-[10.5px] font-semibold px-1.5 rounded text-white" style=${{background:'hsl(0 75% 46%)'}}>Credit</span>`}
                  ${b.inductionReq&&html`<span class="text-[10.5px] font-semibold px-1.5 rounded text-white" style=${{background:b.inductionDone?'hsl(145 60% 34%)':'hsl(0 75% 46%)'}} title=${b.inductionDone?'Induction paperwork sent':'Induction paperwork not sent'}>Induction</span>`}
                  ${b.planId&&html`<span class="text-[10.5px] font-semibold px-1.5 rounded" style=${{background:'var(--accent-soft)',color:'var(--accent)'}}>Plan</span>`}</span></td>
              </tr>`})}</tbody></table></div>`}
        </section>

        <div class="grid gap-3 lg:grid-cols-2">
          <section class="panel p-4 grid gap-2 content-start" aria-labelledby="job-plans">
            <h3 id="job-plans" class="font-display text-[15px] font-semibold">Job plans</h3>
            ${!plans.length?html`<div class="text-[12.5px] text-muted">No plan for this job yet. Make one on the Planning page.</div>`
              :plans.map(p=>html`<div key=${p.id} class="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                  <div class="min-w-0 flex-1"><div class="text-[13px] font-medium truncate">${p.title||p.jobName||'Untitled plan'}</div>
                    <div class="text-[11.5px] text-muted">${p.status==='scheduled'?'On the schedule':p.status==='ready'?'Ready':'Draft'}${p.appliedAt?' · sent '+new Date(p.appliedAt).toLocaleDateString('en-AU',{day:'numeric',month:'short'}):''}</div></div>
                  <button type="button" class="btn" style=${{height:30}} onClick=${()=>onOpenPlan(p.id)}>Open</button></div>`)}
          </section>
          <section class="panel p-4 grid gap-2 content-start" aria-labelledby="job-paper" style=${{borderStyle:'dashed'}}>
            <h3 id="job-paper" class="font-display text-[15px] font-semibold">Paperwork</h3>
            <div class="text-[12.5px] text-muted">Coming soon: keep the job’s paperwork here, like inductions, traffic plans, test results and dockets.</div>
          </section>
        </div>
      </div>`}
    </div>
  </div>`;
}

/* ---------- Fleet & Maintenance and Prestarts: their own files (maint.js, prestart.js, defects.js, reports.js), loaded the first time either screen opens ---------- */
let maintLoading=null;
function loadMaint(){
  if(window.FleetScreen&&window.PrestartScreen&&window.FFD&&window.FFR)return Promise.resolve();
  if(maintLoading)return maintLoading;
  const v=((document.querySelector('script[src*="/app.js"]')||{}).src||'').split('?v=')[1]||Date.now();
  const one=f=>new Promise((res,rej)=>{const s=document.createElement('script');s.src='/'+f+'?v='+v;s.onload=res;s.onerror=rej;document.body.appendChild(s)});
  maintLoading=(window.FleetScreen?Promise.resolve():one('maint.js')).then(()=>window.PrestartScreen?null:one('prestart.js')).then(()=>window.FFD?null:one('defects.js')).then(()=>window.FFR?null:one('reports.js')).catch(e=>{maintLoading=null;throw e});
  return maintLoading;
}
function LazyFleet(props){
  const comp=props.comp||'FleetScreen';
  const [ok,setOk]=useState(!!(window.FleetScreen&&window.PrestartScreen&&window.FFD&&window.FFR));const [err,setErr]=useState('');
  useEffect(()=>{if(ok)return;loadMaint().then(()=>setOk(true),()=>setErr('Couldn’t load '+(comp==='PrestartScreen'?'Prestarts':'Fleet & Maintenance')+'. Check the connection and reload.'))},[]);
  if(err)return html`<div class="panel p-6 text-[13px]" style=${{color:'var(--bad)'}}>${err}</div>`;
  if(!ok||!window[comp])return html`<div class="panel p-6 text-[13px] text-muted">Loading…</div>`;
  const C=window[comp];return html`<${C} ...${props}/>`;
}
/* ---------- screens: the left menu ---------- */
/* features still being worked on: only the admin sees them until they are released to everyone with access (Settings menu) */
const PREVIEW_DEFAULT=['fleet','prestarts'];
const previewKeys=()=>Object.keys(SCREENS).filter(k=>SCREENS[k].preview);
/* a feature added after the admin last changed these switches starts out in progress too */
const previewOf=d=>{if(!d||!Array.isArray(d.previewOnly))return PREVIEW_DEFAULT;const known=Array.isArray(d.previewKnown)?d.previewKnown:['fleet'];
  return [...d.previewOnly,...previewKeys().filter(k=>!known.includes(k)&&!d.previewOnly.includes(k))]};
const screenOK0=(k,role,d)=>{const s=SCREENS[k];if(!s)return false;const admin=role==='admin'||role==='superuser';
  return (!s.admin||admin)&&(!s.roles||s.roles.includes(role))&&(!s.preview||role==='admin'||!previewOf(d).includes(k))};
/* operators only see Prestarts, once it is released to them */
const screenOK=(k,role,d)=>screenOK0(k,role,d)&&!(role==='prestart'&&k!=='prestarts'&&screenOK0('prestarts',role,d))
  &&k!=='machines';   /* machines are managed and booked in Fleet (Fleet › Machines and Calendar); the old Machines screen is gone */
/* Fleet's sections; the Calendar is the machines' schedule board */
const FLEET_TABS=[['dash','Dashboard'],['mc','Machines'],['cal','Calendar'],['wo','Work orders'],['df','Defects'],['plans','Service plans'],['ps','Prestarts'],['cl','Checklists'],['rp','Reports']];
const homeScreen=(role,d)=>role==='prestart'&&screenOK('prestarts',role,d)?'prestarts':'schedule';
const SCREENS={
  schedule:{label:'Schedule',title:'Schedule',only:['tonnes','aplant','crew'],legend:['Crews','Asphalt plant'],head:'Crews / plant'},
  jobs:{label:'Jobs',title:'Jobs',only:[],legend:[],head:''},
  planning:{label:'Planning',title:'Job planning',only:[],legend:[],head:''},
  staff:{label:'Staff',title:'Staff',only:['person'],tab:'person',legend:['Staff'],head:'Staff'},
  machines:{label:'Machines',title:'Machines',only:['machine'],tab:'machine',legend:['Machines'],head:'Machines'},
  fleet:{label:'Fleet',title:'Fleet & Maintenance',only:[],legend:[],head:'',tab:'machine',roles:['admin','superuser','planner','supervisor','mechanic'],preview:true},   /* maintenance: not for operators or viewers */
  prestarts:{label:'Prestarts',title:'Prestarts',only:[],legend:[],head:'',roles:['admin','superuser','planner','supervisor','mechanic','prestart'],preview:true},   /* the phone checklist; the only screen operators see */
  ideas:{label:'Ideas',title:'Ideas',only:[],legend:[],head:'',roles:['admin'],bottom:true},   /* the administrator only, never superusers; always at the bottom of the menu */   /* administrators only (button hidden for everyone else) */
};
const NAV_ICON={
  prestarts:svg(html`<rect x="3" y="2.5" width="10" height="12" rx="1.6" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 2.5V1.8h4v.7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><path d="M5.6 8.6l1.7 1.6 3.2-3.4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,20),
  fleet:svg(html`<path d="M10.5 2a3.5 3.5 0 00-3.2 4.9L2.5 11.7a1.3 1.3 0 001.8 1.8l4.8-4.8A3.5 3.5 0 0014 5.5l-2 2-1.8-.3-.3-1.8 2-2c-.4-.3-.9-.4-1.4-.4z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/>`,20),
  jobs:svg(html`<rect x="2" y="4.5" width="12" height="9" rx="1.6" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5.8 4.5V3.2c0-.4.3-.7.7-.7h3c.4 0 .7.3.7.7v1.3M2 8.5h12" stroke="currentColor" stroke-width="1.5" fill="none"/>`,20),
  ideas:svg(html`<path d="M8 1.8a4.4 4.4 0 00-2.6 7.9c.5.4.8 1 .8 1.6v.4h3.6v-.4c0-.6.3-1.2.8-1.6A4.4 4.4 0 008 1.8z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><path d="M6.4 13.6h3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,20),
  schedule:svg(html`<rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 9h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,20),
  staff:svg(html`<circle cx="8" cy="5.2" r="2.6" stroke="currentColor" stroke-width="1.5"/><path d="M3 14c.6-2.7 2.6-4.2 5-4.2s4.4 1.5 5 4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,20),
  planning:svg(html`<path d="M4 2.5h6l2.5 2.5v8.5H4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6 7h4.5M6 9.5h4.5M6 12h2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,20),
  machines:svg(html`<path d="M2 11.5V8.5l2-3h4l1.5 3H14v3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="4.5" cy="12" r="1.6" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="12" r="1.6" stroke="currentColor" stroke-width="1.4"/>`,20),
};
function NavRail({screen,go,isAdmin,role,data,badge={}}){
  const btn=([k,s])=>{const on=screen===k;
    return html`<button key=${k} class=${'flex flex-col items-center gap-1 rounded-lg py-2.5 text-[11px] font-semibold transition-colors '+(on?'':'text-muted hover:text-ink hover:bg-sunken')}
      style=${on?{background:'var(--accent-soft)',color:'var(--accent)'}:null} aria-current=${on?'page':undefined} onClick=${()=>go(k)} title=${s.label}>
      <span class="relative inline-flex">${NAV_ICON[k]}${badge[k]>0&&html`<span class="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold leading-4 text-center" style=${{background:'var(--accent)',color:'var(--accent-ink)'}} title=${badge[k]+' new'}>${badge[k]}</span>`}</span><span>${s.label}</span>${role==='admin'&&s.preview&&previewOf(data).includes(k)&&html`<span class="-mt-0.5 text-[8.5px] font-bold uppercase tracking-wide px-1 rounded leading-[13px]" style=${{background:'var(--ink)',color:'var(--surface)'}} title="Only you can see this while it is in progress">Preview</span>`}</button>`};
  const all=Object.entries(SCREENS).filter(([k])=>screenOK(k,role,data));
  if(all.length<2)return null;   /* one screen (operators: Prestarts): no menu needed */
  /* bottom of the bar: features still in progress (admin only, until released), then Ideas */
  const low=([k,s])=>s.bottom||(s.preview&&previewOf(data).includes(k));
  const order=([k,s])=>s.bottom?1:0;
  return html`<nav class="panel shrink-0 w-[68px] h-full flex flex-col gap-1 p-1.5" aria-label="Screens">
    ${all.filter(e=>!low(e)).map(btn)}
    <div class="flex-1"></div>
    ${all.filter(low).sort((a,b)=>order(a)-order(b)).map(btn)}
  </nav>`;
}
/* ---------- settings menu: dark mode, notifications and (live) account ---------- */
/* notifications bundled in groups: one switch for the whole group (shows how many are on), opened to pick them one by one */
function NotifGroup({id,label,types,prefs,setPrefs}){
  const [open,setOpen]=useState(false);const n=types.filter(t=>prefs[t.id]).length;const all=n===types.length;
  const setAll=v=>{const p={...prefs};types.forEach(t=>p[t.id]=v);setPrefs(p)};
  return html`<div class="rounded-lg" id=${'ng-'+id}>
    <div class="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-sunken">
      <button type="button" class="min-w-0 flex-1 flex items-center gap-1.5 text-left ng-open" aria-expanded=${open} onClick=${()=>setOpen(!open)}>
        <span class="text-muted inline-flex transition-transform" style=${{transform:open?'rotate(0deg)':'rotate(-90deg)'}}>${Icon.chevD}</span>
        <span class="min-w-0"><span class="block text-[13px] font-medium">${label}</span><span class="block text-[12px] text-muted ng-count">${n===0?'All off':all?'All on':`${n} of ${types.length} on`}</span></span></button>
      <span class="relative inline-flex shrink-0" title=${all?'Turn all off':'Turn all on'}>
        <input id=${'ng-all-'+id} type="checkbox" role="switch" aria-label=${label+' notifications'} class="peer sr-only" checked=${n>0} onChange=${()=>setAll(!all)}/>
        <span class="w-9 h-5 rounded-full transition-colors cursor-pointer" style=${{background:all?'var(--accent)':n?'color-mix(in srgb, var(--accent) 45%, var(--line-strong))':'var(--line-strong)'}} onClick=${()=>setAll(!all)}></span>
        <span class="absolute top-0.5 w-4 h-4 rounded-full transition-all pointer-events-none" style=${{left:all?18:n?10:2,background:'var(--surface)',boxShadow:'0 1px 2px rgba(0,0,0,.2)'}}></span></span>
    </div>
    ${open&&html`<div class="ml-5 border-l border-line pl-1">${types.map(t=>html`<${SwitchRow} key=${t.id} id=${'np-'+t.id} label=${t.label} title=${t.desc} on=${!!prefs[t.id]} onChange=${v=>setPrefs({...prefs,[t.id]:v})}/>`)}</div>`}
  </div>`;
}
function SwitchRow({id,label,desc,title,on,onChange}){
  return html`<label class="flex items-start gap-3 px-2 py-2 rounded-lg hover:bg-sunken cursor-pointer" title=${title||''}>
    <span class="min-w-0 flex-1"><span class="block text-[13px] font-medium">${label}</span>${desc&&html`<span class="block text-[12px] text-muted">${desc}</span>`}</span>
    <span class="relative inline-flex shrink-0 mt-0.5">
      <input id=${id} type="checkbox" role="switch" class="peer sr-only" checked=${!!on} onChange=${e=>onChange(e.target.checked)}/>
      <span class="w-9 h-5 rounded-full transition-colors" style=${{background:on?'var(--accent)':'var(--line-strong)'}}></span>
      <span class="absolute top-0.5 w-4 h-4 rounded-full transition-all" style=${{left:on?18:2,background:'var(--surface)',boxShadow:'0 1px 2px rgba(0,0,0,.2)'}}></span>
    </span>
  </label>`;
}
/* ---------- install FraserFlow as an app (phone home screen, or a desktop app) ---------- */
let installEvt=null;const installSubs=new Set();
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvt=e;installSubs.forEach(f=>f())});
window.addEventListener('appinstalled',()=>{installEvt=null;installSubs.forEach(f=>f())});
const isStandalone=()=>(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
const isIOS=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function useInstall(){
  const [,tick]=useState(0);
  useEffect(()=>{const s=()=>tick(x=>x+1);installSubs.add(s);return()=>{installSubs.delete(s)}},[]);
  if(isStandalone())return null;
  if(installEvt)return {kind:'prompt',go:async()=>{const e=installEvt;installEvt=null;try{e.prompt();await e.userChoice}catch(x){}installSubs.forEach(g=>g())}};
  if(isIOS())return {kind:'ios',steps:'In Safari, tap the Share button, then “Add to Home Screen”.'};
  return null;
}
window.ffUseInstall=useInstall;
function SettingsMenu({theme,toggleTheme,prefs,setPrefs,account,onLog,preview,maint,simple}){   /* simple (operators): dark mode and their account only */
  const inst0=useInstall();const inst=simple?null:inst0;const [left,setLeft]=useState(false);   /* open towards whichever side has room */
  const [open,setOpen]=useState(false);
  const ref=React.useRef(null);
  useEffect(()=>{if(!open)return;
    const out=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};const esc=e=>{if(e.key==='Escape')setOpen(false)};
    document.addEventListener('pointerdown',out);window.addEventListener('keydown',esc);
    return()=>{document.removeEventListener('pointerdown',out);window.removeEventListener('keydown',esc)}},[open]);
  const initial=account&&account.email?showLogin(account.email)[0].toUpperCase():'';
  const sectionLabel=t=>html`<div class="label px-2 pt-2 pb-1">${t}</div>`;
  return html`<div class="relative" ref=${ref}>
    <button class="btn px-2" onClick=${()=>{if(!open&&ref.current)setLeft(ref.current.getBoundingClientRect().right<330);setOpen(o=>!o)}} aria-expanded=${open} aria-label="Settings" title="Settings">
      ${account?html`<span class="w-6 h-6 rounded-full inline-flex items-center justify-center text-[12px] font-bold" style=${{background:'var(--ink)',color:'var(--surface)'}}>${initial}</span>`:Icon.gear}
    </button>
    ${open&&html`<div class=${'panel pop absolute top-[38px] z-40 w-[min(320px,calc(100vw-32px))] overflow-hidden '+(left?'left-0':'right-0')} role="dialog" aria-label="Settings">
      ${account&&html`<div class="px-4 py-3 border-b border-line">
        <div class="text-[12px] text-muted">Signed in as</div>
        <div class="text-[13.5px] font-semibold truncate">${showLogin(account.email)}</div>
        ${(account.role==='admin'||account.role==='superuser')&&html`<div class="text-[11.5px] text-muted mt-0.5 acct-role">${({admin:'Administrator',superuser:'Superuser (full access)'})[account.role]}</div>`}   ${'' /* roles are only shown to administrators and superusers */}
      </div>`}
      <div class="p-2">
        ${sectionLabel('Appearance')}
        <${SwitchRow} id="set-dark" label="Dark mode" on=${theme==='dark'} onChange=${()=>toggleTheme()}/>
        ${inst&&html`${sectionLabel('This device')}
          ${inst.kind==='prompt'?html`<button id="set-install" class="w-full flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-sunken text-left" onClick=${()=>{setOpen(false);inst.go()}}>${Icon.download}<span><span class="block text-[13px] font-medium">Install FraserFlow as an app</span><span class="block text-[12px] text-muted">Opens from its own icon, full screen</span></span></button>`
            :html`<div class="px-2 py-2 flex items-start gap-2">${Icon.download}<span><span class="block text-[13px] font-medium">Add FraserFlow to your home screen</span><span class="block text-[12px] text-muted">${inst.steps}</span></span></div>`}`}
        ${!simple&&sectionLabel('Notifications')}
        ${!simple&&html`<${NotifGroup} id="schedule" label="Schedule" types=${NOTIF_TYPES.filter(t=>!t.maint)} prefs=${prefs} setPrefs=${setPrefs}/>`}
        ${!simple&&maint&&html`<${NotifGroup} id="maint" label="Fleet & Maintenance" types=${NOTIF_TYPES.filter(t=>t.maint)} prefs=${prefs} setPrefs=${setPrefs}/>`}
        ${preview&&html`${sectionLabel('Features in progress')}
          <div class="px-2 pb-1 text-[12px] text-muted">Only you see these until you release them. Then everyone whose role allows it sees them.</div>
          ${Object.entries(SCREENS).filter(([,s])=>s.preview).map(([k,s])=>html`<${SwitchRow} key=${k} id=${'pv-'+k} label=${'Release '+s.title} desc=${preview.list.includes(k)?'In progress: only you can see it':'Released to everyone with access'}
            on=${!preview.list.includes(k)} onChange=${v=>preview.set(v?preview.list.filter(x=>x!==k):[...preview.list,k])}/>`)}`}
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

function Notifications({data,onOpen,prefs,setPrefs,maint,onMaint}){
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
  const list=[...(prefs.quote?recentQuoteChanges(data).map(c=>({...c,_q:true})):[]),...recentChanges(data,prefs),...(maint?maintNotifs(data,prefs):[])].filter(c=>!gone[c.id]).sort((a,b)=>b.at-a.at).slice(0,150);
  const me=window.__rosterMe||'';
  const allOff=NOTIF_TYPES.filter(t=>maint||!t.maint).every(t=>!prefs[t.id]);
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
              <div class="text-[11.5px] text-faint">${agoText(c.at)}${c.by?` · ${c.by===me?'you':showLogin(c.by)}`:''}</div>
            </div>
            ${b&&html`<button class="btn shrink-0" style=${{height:28}} onClick=${()=>{setOpen(false);onOpen(b)}}>Open</button>`}
            ${!b&&c.assetId&&onMaint&&html`<button class="btn shrink-0 nt-open-asset" style=${{height:28}} onClick=${()=>{setOpen(false);onMaint(c.assetId)}}>Open</button>`}
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
const TRUCK_WEIGHTS=['12T','15T','18T','25T'];
const DEFAULT_TRUCKS=['AFA WF','AFA 10 W','AFA 8 W','AFA FLOCON','BIG DAVES','YDD','RCA','SWARLY','CD CARTAGE','HT','PAVETECH','RAP RESOURCES','NEWY GROUP','ACE TIPPERS','KELLY','ALL ASPECTS','BITUMILL'];
const DEFAULT_SUBS=['BCM','SITE SERVICES','AL BAY','BEAU STRIKE','GPC CONTRACTORS','SOUTH EAST PROFILING','MR ROADS CREW MEMBERS','MASTERHIRE LIGHTING TOWER','BELLS DIESEL LIGHTING TOWER','HT','AUSTCORP','SWARLY','PAVETECH','RIVERCITY','ALL ASPECTS','BITUMILL','SHERRIN RENTALS'];
const PROGRAM_LOCATIONS=['SITE','SCA','BALD HILLS YARD'];
const PROGRAM_FOOTER=['SPOTTER TO WEAR PINK AT ALL TIMES','PRESTART ALL MACHINERY - PRESTARTS TO BE COMPLETED ON MEX.'];
const DEFAULT_SUB_SERVICES={'PAVETECH':['x 3 Labourers','Bobcat Hire'],'BCM':['Shuttle Buggy','2m Hourly'],'RIVERCITY':['10ft Paver Hire']};
const subServicesOf=d=>d&&d.subServices&&typeof d.subServices==='object'?d.subServices:DEFAULT_SUB_SERVICES;
const servicesFor=(d,name)=>{const m=subServicesOf(d);const k=Object.keys(m).find(x=>x.toLowerCase()===String(name||'').trim().toLowerCase());return k?m[k]:[]};
const addMin=(t,n)=>{const m=/^(\d{1,2}):(\d{2})/.exec(t||'');if(!m)return '';let v=(+m[1]*60+ +m[2]+n)%1440;if(v<0)v+=1440;return `${pad(Math.floor(v/60))}:${pad(v%60)}`};
/* after a booking is saved: subcontractors, services and trucks typed in by hand join the lists */
function learnProgramLists(d,b){
  const subs=[],trucks=[];Object.values(b.shiftData||{}).forEach(q=>{(q&&q.subs||[]).forEach(x=>subs.push(x));(q&&q.trucks||[]).forEach(x=>trucks.push(x))});
  if(!subs.length&&!trucks.length)return d;
  const has=(l,v)=>l.some(x=>x.toLowerCase()===v.toLowerCase());
  let subCos=[...subCosOf(d)],truckCos=[...truckCosOf(d)],svc={...subServicesOf(d)},locs=[...programLocsOf(d)],ch=false;
  subs.forEach(x=>{const n=(x.name||'').trim();if(!n)return;
    if(!has(subCos,n)){subCos.push(n);ch=true}
    const i=(x.info||'').trim();if(!i)return;const key=Object.keys(svc).find(k=>k.toLowerCase()===n.toLowerCase())||n;
    const cur=svc[key]||[];if(!has(cur,i)){svc[key]=[...cur,i];ch=true}});
  trucks.forEach(x=>{const n=(x.co||'').trim();if(n&&!has(truckCos,n)){truckCos.push(n);ch=true}
    const l=(x.loc||'').trim();if(l&&l.toLowerCase()!==(b.address||'').trim().toLowerCase()&&!has(locs,l)){locs.push(l);ch=true}});
  return ch?{...d,subCos,truckCos,subServices:svc,programLocs:locs}:d;
}
const DEFAULT_LOC_COLORS={'SITE':'#141414','SCA':'#9b0a1e','BALD HILLS YARD':'#407034'};
const LOC_PALETTE=['#9b0a1e','#407034','#26548c','#966014','#603c82','#0f766e'];
const locColorsOf=d=>d&&d.locColors&&typeof d.locColors==='object'?d.locColors:DEFAULT_LOC_COLORS;
/* a location's colour: the one picked in Resources → Trucks, else a colour from the palette by its place in the list */
const locColorOf=(d,name)=>{const m=locColorsOf(d);const n=String(name||'').trim().toLowerCase();const k=Object.keys(m).find(x=>x.toLowerCase()===n);if(k)return m[k];
  const i=programLocsOf(d).findIndex(x=>x.toLowerCase()===n);return LOC_PALETTE[(i<0?0:i)%LOC_PALETTE.length]};
const hexRgb=h=>{const m=/^#?([0-9a-f]{6})$/i.exec(h||'');if(!m)return [20,20,20];const v=parseInt(m[1],16);return [v>>16&255,v>>8&255,v&255]};
const programLocsOf=d=>d&&Array.isArray(d.programLocs)?d.programLocs:PROGRAM_LOCATIONS;
const truckDefsOf=d=>d&&d.truckDefs&&typeof d.truckDefs==='object'?d.truckDefs:{};
const truckDefOf=(d,name)=>{const m=truckDefsOf(d);const n=String(name||'').trim().toLowerCase();const k=Object.keys(m).find(x=>x.toLowerCase()===n);return k?m[k]:{}};
const truckCosOf=d=>d&&Array.isArray(d.truckCos)?d.truckCos:DEFAULT_TRUCKS;
const subCosOf=d=>d&&Array.isArray(d.subCos)?d.subCos:DEFAULT_SUBS;
const truckHas=t=>!!t&&!!(t.co||t.driver||t.w||t.time||t.loc);
const subHas=s=>!!s&&!!(s.name||s.info||s.time);
const progHas=q=>!!q&&((q.trucks||[]).some(truckHas)||(q.subs||[]).some(subHas)||!!q.start||!!(q.comments||'').trim());
const progClean=q=>{const o={};if(!q)return o;
  const t=(q.trucks||[]).filter(truckHas).map(x=>({co:(x.co||'').trim(),driver:(x.driver||'').trim(),w:x.w||'',time:x.time||'',loc:(x.loc||'').trim(),...(x.manual?{manual:true}:{})}));if(t.length)o.trucks=t;
  const s=(q.subs||[]).filter(subHas).map(x=>({name:(x.name||'').trim(),info:(x.info||'').trim(),time:x.time||''}));if(s.length)o.subs=s;
  if(q.start)o.start=q.start;if(q.locTimes){const L={};Object.entries(q.locTimes).forEach(([kk,v])=>{if(v&&(v.start||+v.gap))L[kk]={...(v.start?{start:v.start}:{}),...(+v.gap?{gap:+v.gap}:{})}});if(Object.keys(L).length)o.locTimes=L}const c=(q.comments||'').trim();if(c)o.comments=c;return o};
const linesOnly=q=>!q?[]:Array.isArray(q.lines)?q.lines:(q.type||q.tonnes||q.area?[q]:[]);
const fmtTime=t=>{if(!t)return '';const m=/^(\d{1,2}):(\d{2})/.exec(t);if(!m)return t;let h=+m[1];const ap=h>=12?'PM':'AM';h=h%12||12;return `${h}:${m[2]} ${ap}`};
const truckT=w=>parseFloat(String(w||'').replace(/[^\d.]/g,''))||0;
const truckSum=ts=>{const l=(ts||[]).filter(truckHas);return `${l.length} truck${l.length===1?'':'s'}${l.length?`, ${fmtN(l.reduce((a,t)=>a+truckT(t.w),0))}T`:''}`};

function TrucksManager({data,setData}){
  const setter=key=>(list,extra)=>setData(d=>{const n={...d,[key]:list};return extra?extra(n):n});
  return html`<div class="flex-1 min-h-0 overflow-y-auto">
    <${ListManager} title="Trucks" field="truckco" placeholder="e.g. BIG DAVES" data=${data} setData=${setData}
      hint="Truck companies offered in a booking's Trucks & Subcontractors tab, in this order. Click the pencil to rename one or set its default driver and weight."
      items=${truckCosOf(data)} setItems=${setter('truckCos')} truckOf=${t=>truckDefOf(data,t)}
      onRenamed=${(d,from,to,ed)=>{const m={...truckDefsOf(d)};const prev=m[from]||{};delete m[from];
        const v=ed&&('driver' in ed||'w' in ed)?{driver:(ed.driver||'').trim(),w:ed.w||''}:prev;if(v.driver||v.w)m[to]=v;return {...d,truckDefs:m}}}
      onRemoved=${(d,t)=>{const m={...truckDefsOf(d)};delete m[t];return {...d,truckDefs:m}}}/>
    <div class="border-t border-line mx-4"></div>
    <${ListManager} title="Locations" field="progloc" placeholder="e.g. BALD HILLS YARD" data=${data} setData=${setData}
      hint="Where trucks load or meet, offered in the Location column of the Trucks & Subcontractors tab. The booking's own site address is always offered too and uses SITE's colour. Click a swatch to pick the colour it's highlighted in on the daily program."
      items=${programLocsOf(data)} setItems=${setter('programLocs')}
      colorOf=${t=>locColorOf(data,t)} onColor=${(t,c)=>setData(d=>({...d,locColors:{...locColorsOf(d),[t]:c}}))}
      onRenamed=${(d,from,to)=>{const m={...locColorsOf(d)};if(m[from]){m[to]=m[from];delete m[from]}return {...d,locColors:m}}}
      onRemoved=${(d,t)=>{const m={...locColorsOf(d)};delete m[t];return {...d,locColors:m}}}/>
  </div>`;
}
function SubsManager({data,setData}){
  const setter=key=>(list,extra)=>setData(d=>{const n={...d,[key]:list};return extra?extra(n):n});
  return html`<div class="flex-1 min-h-0 overflow-y-auto">
    <${ListManager} title="Subcontractors" field="subco" placeholder="e.g. BCM" data=${data} setData=${setData}
      hint="Subcontractors offered in a booking's Trucks & Subcontractors tab, in this order. Click the pencil to rename one or list the services they provide."
      items=${subCosOf(data)} setItems=${setter('subCos')} servicesOf=${t=>subServicesOf(data)[t]||[]}
      onRenamed=${(d,from,to,ed)=>{const m={...subServicesOf(d)};const list=ed&&typeof ed.services==='string'?[...new Set(ed.services.split('\n').map(x=>x.trim()).filter(Boolean))]:(m[from]||[]);
        delete m[from];if(list.length)m[to]=list;return {...d,subServices:m}}}
      onRemoved=${(d,t)=>{const m={...subServicesOf(d)};delete m[t];return {...d,subServices:m}}}/>
  </div>`;
}

/* text box with a dropdown list: type to filter, or press ▾ / the down arrow to see every option,
   even when the box already has something in it (a plain browser suggestion list hides the others) */
function Combo({id,value,onChange,options,placeholder,style,className,label,onEnter}){
  const [open,setOpen]=useState(false);const [all,setAll]=useState(false);const [hi,setHi]=useState(-1);const ref=useRef(null);
  const v=value||'';const ql=v.trim().toLowerCase();
  const opts=[...new Set((options||[]).map(o=>String(o||'').trim()).filter(Boolean))];
  const shown=all||!ql?opts:opts.filter(o=>o.toLowerCase().includes(ql));
  useEffect(()=>{if(!open)return;const out=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};
    document.addEventListener('pointerdown',out);return()=>document.removeEventListener('pointerdown',out)},[open]);
  const pick=o=>{onChange(o);setOpen(false);setAll(false);setHi(-1)};
  const showAll=()=>{setOpen(true);setAll(true);setHi(Math.max(0,opts.indexOf(v)))};
  const key=e=>{
    if(e.key==='ArrowDown'){e.preventDefault();if(!open){showAll();return}setHi(h=>Math.min(shown.length-1,h+1))}
    else if(e.key==='ArrowUp'){if(open){e.preventDefault();setHi(h=>Math.max(0,h-1))}}
    else if(e.key==='Enter'){if(open&&hi>=0&&shown[hi]){e.preventDefault();pick(shown[hi])}else if(onEnter){e.preventDefault();setOpen(false);onEnter()}}
    else if(e.key==='Escape'){if(open){e.preventDefault();e.stopPropagation();setOpen(false)}}
    else if(e.key==='Tab')setOpen(false)};
  return html`<div class="relative min-w-0" ref=${ref}>
    <input id=${id} class=${(className||'field field-sm')} style=${{...(style||{}),paddingRight:opts.length?28:undefined}} placeholder=${placeholder} value=${v} autoComplete="off"
      role="combobox" aria-expanded=${open} aria-autocomplete="list" aria-label=${label}
      onInput=${e=>{onChange(e.target.value);setOpen(true);setAll(false);setHi(-1)}} onKeyDown=${key}/>
    ${opts.length>0&&html`<button type="button" tabindex="-1" class="absolute right-0 top-0 bottom-0 w-7 inline-flex items-center justify-center text-muted hover:text-ink"
      onPointerDown=${e=>e.preventDefault()} onClick=${()=>{if(open&&all)setOpen(false);else showAll()}} aria-label=${'Show all '+(label||'options')}>${Icon.chevD}</button>`}
    ${open&&shown.length>0&&html`<ul class="panel absolute left-0 right-0 top-full mt-1 z-40 py-1 max-h-[240px] overflow-y-auto" style=${{minWidth:160}} role="listbox">
      ${shown.map((o,i)=>html`<li key=${o} role="option" aria-selected=${o===v} class="px-2.5 py-1.5 text-[13px] cursor-pointer truncate"
        style=${{background:i===hi?'var(--accent-soft)':o===v?'var(--sunken)':'transparent',fontWeight:o===v?600:400}}
        onPointerDown=${e=>{e.preventDefault();pick(o)}} onPointerEnter=${()=>setHi(i)}>${o}</li>`)}</ul>`}
  </div>`;
}
/* time picker: hour, minutes (5-minute steps) and AM/PM as dropdowns; stores "HH:MM" (24 h) */
function TimeSelect({id,value,onChange,label,pm}){
  const m=/^(\d{1,2}):(\d{2})/.exec(value||'');const H=m?+m[1]:null,Mi=m?m[2]:'';
  const h12=H==null?'':String(H%12||12),ap=H==null?(pm?'PM':'AM'):(H>=12?'PM':'AM');
  const emit=(h,mi,a)=>{if(!h){onChange('');return}onChange(`${pad((+h%12)+(a==='PM'?12:0))}:${mi||'00'}`)};
  const mins=[...Array(12)].map((_,i)=>pad(i*5));if(Mi&&!mins.includes(Mi)){mins.push(Mi);mins.sort()}
  const st={height:30,fontSize:13,paddingLeft:6,paddingRight:2};
  return html`<span class="flex items-center gap-1 min-w-0" role="group" aria-label=${label}>
    <select id=${id+'-h'} class="field field-sm mono min-w-0 flex-1" style=${{...st,color:h12?'var(--ink)':'var(--faint)'}} value=${h12} onChange=${e=>emit(e.target.value,Mi||'00',ap)} aria-label=${label+' hour'}>
      <option value="">--</option>${[12,1,2,3,4,5,6,7,8,9,10,11].map(h=>html`<option key=${h} value=${String(h)} style=${{color:'var(--ink)'}}>${h}</option>`)}</select>
    <select id=${id+'-m'} class="field field-sm mono min-w-0 flex-1" style=${st} value=${Mi||'00'} disabled=${!h12} onChange=${e=>emit(h12,e.target.value,ap)} aria-label=${label+' minutes'}>
      ${mins.map(x=>html`<option key=${x} value=${x}>${x}</option>`)}</select>
    <select id=${id+'-ap'} class="field field-sm mono min-w-0 flex-1" style=${st} value=${ap} disabled=${!h12} onChange=${e=>emit(h12,Mi||'00',e.target.value)} aria-label=${label+' AM or PM'}>
      <option value="AM">AM</option><option value="PM">PM</option></select>
  </span>`;
}
/* booking editor tab: one shift at a time */
function ProgramShifts({f,set,data,part}){
  const dates=shiftDates(f);const sd=f.shiftData||{};
  /* opens on today's shift (or the next one, or the last one if the job is finished) */
  const defShift=()=>{const t=iso(TODAY);return dates.includes(t)?t:(dates.find(k=>k>=t)||dates[dates.length-1]||'')};
  const [sel,setSel]=useState(defShift);
  const [editPastP,setEditPastP]=useState(false);const [newLoc,setNewLoc]=useState('');const [ldrag,setLdrag]=useState(null);   /* before any early return: hooks must always run */
  const k=dates.includes(sel)?sel:defShift();
  if(!k)return html`<div class="text-[12.5px] text-muted">This booking has no shifts yet. Check the dates and the weekend ticks.</div>`;
  const q=sd[k]||{};const i=dates.indexOf(k);
  const upd=p=>set({shiftData:{...sd,[k]:{...shiftBase(q),lines:linesOnly(q),...p}}});
  const trucks=q.trucks&&q.trucks.length?q.trucks:[{}];
  const subs=q.subs&&q.subs.length?q.subs:[{}];
  /* default times: subcontractors start with the shift; the first truck at the start time, each one after 15 minutes later */
  /* truck times, location by location: each location has a first time (the shift start unless changed) and a gap;
     its trucks are timed in list order (first time, + gap, + 2 gaps...). A time picked on a truck sticks until it's reset. */
  const lt=q.locTimes||{};
  const lkey=t=>((t&&t.loc)||'').trim().toLowerCase();
  const locStart=key=>(lt[key]&&lt[key].start)||q.start||'';
  const locGap=key=>Math.round(num(lt[key]&&lt[key].gap))||0;
  const retime=(list,locT=lt,st=q.start)=>{const idx={};return list.map(t=>{if(!truckHas(t))return t;const kk=lkey(t);const n=idx[kk]=(idx[kk]??-1)+1;
    if(t.manual)return t;const s0=(locT[kk]&&locT[kk].start)||st||'';const g=Math.round(num(locT[kk]&&locT[kk].gap))||0;return {...t,time:s0?addMin(s0,g*n):''}})};
  /* bookings saved before location timing: keep their typed times (anything not on the shift start counts as set by hand) */
  const realTrucks=q.locTimes?(q.trucks||[]):(q.trucks||[]).map(t=>t.time&&t.time!==q.start?{...t,manual:true}:t);
  const updT=tr=>upd({trucks:tr,locTimes:lt});
  const setT=(j,p)=>{const list=realTrucks.map(t=>({...t}));const t={...list[j],...p};
    /* picking a truck fills its default driver and weight (unless they were typed in) */
    if('co' in p){const nd=truckDefOf(data,p.co),od=truckDefOf(data,list[j].co);
      if(nd.driver&&(!t.driver||t.driver===od.driver))t.driver=nd.driver;else if(!nd.driver&&t.driver&&t.driver===od.driver)t.driver='';
      if(nd.w&&(!t.w||t.w===od.w))t.w=nd.w;else if(!nd.w&&t.w&&t.w===od.w)t.w=''}
    if('time' in p){if(p.time)t.manual=true;else delete t.manual}
    list[j]=t;updT(retime(list))};
  const autoTime=j=>{const list=realTrucks.map(t=>({...t}));delete list[j].manual;updT(retime(list))};
  const addTruck=(loc,copy)=>{const list=realTrucks.filter(truckHas).map(t=>({...t}));const kk=(loc||'').trim().toLowerCase();let at=-1;list.forEach((t,x)=>{if(lkey(t)===kk)at=x});
    const nt={...(copy?{co:copy.co||'',w:copy.w||''}:{}),loc:loc||''};
    if(at<0)list.push(nt);else list.splice(at+1,0,nt);updT(retime(list))};
  const removeTruck=j=>updT(retime(realTrucks.filter((_,x)=>x!==j)));
  /* (a plain button, not a form: this tab sits inside the booking's form, and a nested form would save and close the booking) */
  /* drag a location box to change the order of the locations (the daily program lists them in this order) */
  const lStart=(e,key)=>{if(e.button!==undefined&&e.button!==0)return;e.preventDefault();try{e.currentTarget.setPointerCapture(e.pointerId)}catch(x){}setLdrag({key,over:null,after:false})};
  const lMove=e=>{if(!ldrag)return;const el=document.elementFromPoint(e.clientX,e.clientY);const t=el&&el.closest('[data-locbox]');
    if(!t){if(ldrag.over!==null)setLdrag({...ldrag,over:null});return}const over=t.getAttribute('data-locbox');const bx=t.getBoundingClientRect();const after=e.clientY>bx.top+bx.height/2;
    if(over!==ldrag.over||after!==ldrag.after)setLdrag({...ldrag,over,after})};
  const lEnd=()=>{const m=ldrag;setLdrag(null);if(!m||m.over===null||m.over===m.key)return;
    const order=[];realTrucks.forEach(t=>{const kk=lkey(t);if(!order.includes(kk))order.push(kk)});
    const o=order.filter(x=>x!==m.key);let i=o.indexOf(m.over);if(i<0)return;if(m.after)i++;o.splice(i,0,m.key);
    updT(retime(o.flatMap(kk=>realTrucks.filter(t=>lkey(t)===kk))))};
  const addNewLoc=()=>{const v=newLoc.trim();if(!v)return;addTruck(v);setNewLoc('')};
  const setLoc=(key,p)=>{const nl={...lt,[key]:{...(lt[key]||{}),...p}};upd({locTimes:nl,trucks:retime(realTrucks,nl)})};
  const setS=(j,p)=>{const s0={...subs[j],...p};if(!('time' in p)&&!s0.time&&subHas(s0)&&q.start)s0.time=q.start;upd({subs:subs.map((s,x)=>x===j?s0:s)})};
  const setStart=v=>{const old=q.start||'';
    const subs2=(q.subs||[]).map(s=>subHas(s)&&(!s.time||s.time===old)?{...s,time:v}:s);
    upd({start:v,subs:subs2,trucks:retime(realTrucks,lt,v),locTimes:lt})};
  const prog=o=>({trucks:(o.trucks||[]).map(t=>({...t})),subs:(o.subs||[]).map(s=>({...s})),start:o.start||'',comments:o.comments||'',locTimes:{...(o.locTimes||{})}});
  /* each tab copies only its own part: trucks (with their location timing) or subcontractors and comments */
  const pick=o=>{const p=prog(o);return part==='trucks'?{trucks:p.trucks,locTimes:p.locTimes,start:p.start}:{subs:p.subs,comments:p.comments,start:p.start}};
  const copyPrev=()=>upd(pick(sd[dates[i-1]]||{}));
  const todayP=iso(TODAY);const lockedP=k<todayP&&!editPastP;
  const copyAll=()=>{const next={...sd};dates.forEach(d=>{if(d===k||(d<todayP&&!editPastP))return;const o=sd[d]||{};next[d]={...o,...shiftBase(o),lines:linesOnly(o),...pick(q)}});set({shiftData:next})};
  const tl=(q.trucks||[]).filter(truckHas);const totT=tl.reduce((a,t)=>a+truckT(t.w),0);
  const night=f.shift==='night';
  const sealJob=isSealCrew(data.resources.find(r=>r.id===f.resourceId));   /* seal jobs: subcontractors only, no trucks */
  const locs=[...new Set([...programLocsOf(data),...(f.address?[f.address]:[])])];
  const fs={height:30,fontSize:13};const iconX='w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken';
  const TC='grid gap-2 grid-cols-[1fr_1fr_28px] sm:grid-cols-[1.2fr_1fr_72px_190px_1.1fr_28px] items-center';
  const SC2='grid gap-2 grid-cols-[1fr_1fr_28px] sm:grid-cols-[1.3fr_1.2fr_164px_28px] items-center';
  return html`<section class="grid gap-4" aria-labelledby="sec-program">
    <div class="flex flex-wrap items-end gap-3">
      <div class="mr-auto"><h3 id="sec-program" class="font-display text-[15px] font-semibold">${part==='trucks'?'Trucks':'Subcontractors'}</h3>
        <div class="text-[12px] text-muted">${part==='trucks'?'Goes on the daily program for each shift. Trucks and locations typed in by hand are added to the lists when you save.':'Goes on the daily program for each shift, with the shift comments. Subcontractors and services typed in by hand are added to the lists when you save.'}</div></div>
      <label class="grid gap-1"><span class="label">Shift</span>
        <select id="pg-shift" class="field field-sm" style=${{...fs,width:'auto'}} value=${k} onChange=${e=>setSel(e.target.value)}>
          ${dates.map((d,x)=>html`<option key=${d} value=${d}>Shift ${x+1} · ${WD[parse(d).getDay()]} ${fmtShort(parse(d))}${progHas(sd[d])?' ✓':''}</option>`)}
        </select></label>
      <fieldset disabled=${lockedP} class="border-0 p-0 m-0 min-w-0" style=${lockedP?{opacity:.5}:null}><label class="grid gap-1"><span class="label">${part==='trucks'?'Crew start time':'Start time'}</span>
        <span style=${{width:176}}><${TimeSelect} id="pg-start" label=${part==='trucks'?'Crew start time':'Start time'} value=${q.start||''} pm=${night} onChange=${setStart}/></span></label></fieldset>
    </div>
    <div class="flex flex-wrap items-center gap-2 -mt-2">
      ${dates.some(d=>d<todayP)&&html`<label class="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer mr-2" title="Shifts before today are locked so they aren't changed by accident">
        <input id="pg-edit-past" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${editPastP} onChange=${e=>setEditPastP(e.target.checked)}/>
        <span class=${editPastP?'font-semibold text-ink':'text-muted'}>Edit past shifts</span></label>`}
      ${lockedP&&html`<span class="text-[12px] font-semibold text-muted">Past shift: locked</span>`}
      ${i>0&&!lockedP&&html`<button type="button" class="btn btn-ghost text-muted" style=${{height:28}} onClick=${copyPrev}>Copy from shift ${i}</button>`}
      ${dates.length>1&&html`<button type="button" class="btn btn-ghost text-muted" style=${{height:28}} onClick=${copyAll} title=${part==='trucks'?'Replace the trucks on every other shift with this shift\'s':'Replace the subcontractors and comments on every other shift with this shift\'s'}>Copy this shift to all shifts</button>`}
    </div>

    <fieldset disabled=${lockedP} class="grid gap-4 border-0 p-0 m-0 min-w-0" style=${lockedP?{opacity:.5}:null}>
    ${part==='trucks'&&!sealJob&&html`<div class="grid gap-2">
      <div class="flex items-baseline gap-2"><span class="label" style=${{color:'var(--ink)'}}>Trucks</span><span class="text-[12px] text-muted tnum">${tl.length} · ${fmtN(totT)}T</span><span class="flex-1 h-px bg-line self-center"></span></div>
      <${PlanTruckNote} data=${data} f=${f} k=${k}/>
      <div class="text-[12px] text-muted -mt-1">Trucks are grouped by location. Each location has a first truck time and a gap: its trucks follow on in order. Pick a time on a truck to set it by hand. Drag a location by its ⋮⋮ handle to change the order they appear on the daily program.</div>
      ${(()=>{const groups=[];realTrucks.forEach((t,j)=>{const kk=lkey(t);let g=groups.find(x=>x.key===kk);if(!g){g={key:kk,label:(t.loc||'').trim(),items:[]};groups.push(g)}g.items.push({t,j})});
        return groups.map(g=>{const tT=g.items.reduce((a,{t})=>a+truckT(t.w),0);const sw=g.label?locColorOf(data,g.key===(f.address||'').trim().toLowerCase()?'SITE':g.label):'var(--line-strong)';
          return html`<div key=${'g-'+g.key} data-locbox=${g.key} class="rounded-lg border border-line"
            style=${{opacity:ldrag&&ldrag.key===g.key?.5:1,boxShadow:ldrag&&ldrag.over===g.key&&ldrag.key!==g.key?(ldrag.after?'0 3px 0 var(--accent)':'0 -3px 0 var(--accent)'):'none'}}>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 py-2 bg-sunken border-b border-line rounded-t-lg">
              ${groups.length>1&&html`<span role="button" tabindex="-1" class="w-5 h-6 -ml-1 shrink-0 inline-flex items-center justify-center rounded text-faint hover:text-ink hover:bg-surface select-none"
                style=${{cursor:ldrag?'grabbing':'grab',touchAction:'none'}} title="Drag to change the order of the locations (the daily program follows this order)" aria-label=${'Drag '+(g.label||'no location')}
                onPointerDown=${e=>lStart(e,g.key)} onPointerMove=${lMove} onPointerUp=${lEnd} onPointerCancel=${()=>setLdrag(null)}>${Icon.grip}</span>`}
              <span class="w-3 h-3 rounded-sm shrink-0" style=${{background:sw}}></span>
              <span class="text-[13px] font-semibold mr-1">${g.label||'No location'}</span>
              <span class="text-[12px] text-muted tnum">${g.items.length} truck${g.items.length===1?'':'s'}</span>
              <span class="text-[13px] font-semibold tnum rounded-md px-1.5 py-0.5 bg-surface border border-line" title="Total truck tonnes at this location">${fmtN(tT)}T</span>
              <span class="flex-1"></span>
              <span class="text-[12px] text-muted">First truck</span>
              <span style=${{width:164}}><${TimeSelect} id=${`pg-loc-${g.key||'none'}-start`} label=${`First truck time at ${g.label||'no location'}`} value=${locStart(g.key)} pm=${night} onChange=${v=>setLoc(g.key,{start:v})}/></span>
              <span class="text-[12px] text-muted">then</span>
              <select id=${`pg-loc-${g.key||'none'}-gap`} class="field field-sm mono w-auto" style=${{height:30,fontSize:12.5,paddingLeft:6}} value=${String(locGap(g.key))} onChange=${e=>setLoc(g.key,{gap:+e.target.value})} aria-label=${`Gap between trucks at ${g.label||'no location'}`}>
                ${[...new Set([0,5,10,15,20,25,30,45,60,locGap(g.key)])].sort((a,c)=>a-c).map(m=>html`<option key=${m} value=${String(m)}>${m?`every ${m} min`:'same time'}</option>`)}</select>
            </div>
            <div class="px-2.5 py-2 grid gap-1.5">
              <div class=${'hidden sm:grid '+TC}><span class="label">Truck</span><span class="label">Driver</span><span class="label">Weight</span><span class="label">Time</span><span class="label">Location</span><span></span></div>
              ${g.items.map(({t,j})=>html`<div key=${j} class=${TC}>
                <${Combo} id=${`pg-t${j}-co`} style=${fs} placeholder="Truck" value=${t.co||''} onChange=${v=>setT(j,{co:v})} label=${`Truck ${j+1} company`} options=${truckCosOf(data)}/>
                <input id=${`pg-t${j}-dr`} class="field field-sm" style=${fs} placeholder="Driver" value=${t.driver||''} onInput=${e=>setT(j,{driver:e.target.value})} aria-label=${`Truck ${j+1} driver`}/>
                <select id=${`pg-t${j}-w`} class="field field-sm mono" style=${{...fs,color:t.w?'var(--ink)':'var(--faint)'}} value=${t.w||''} onChange=${e=>setT(j,{w:e.target.value})} aria-label=${`Truck ${j+1} weight`}>
                  <option value="">T</option>${TRUCK_WEIGHTS.map(w=>html`<option key=${w} value=${w} style=${{color:'var(--ink)'}}>${w}</option>`)}
                  ${t.w&&!TRUCK_WEIGHTS.includes(t.w)&&html`<option value=${t.w}>${t.w}</option>`}</select>
                <span class="flex items-center gap-1 min-w-0"><span class="flex-1 min-w-0"><${TimeSelect} id=${`pg-t${j}-time`} label=${`Truck ${j+1} time`} value=${t.time||''} pm=${night} onChange=${v=>setT(j,{time:v})}/></span>
                  ${t.manual?html`<button type="button" class="w-6 h-6 shrink-0 inline-flex items-center justify-center rounded text-[13px] text-muted hover:text-ink hover:bg-sunken" onClick=${()=>autoTime(j)} title="Set by hand. Click to go back to the location's timing" aria-label=${`Truck ${j+1}: go back to automatic time`}>↺</button>`:html`<span class="w-6 shrink-0 text-[10px] text-faint text-center" title="Timed from the location">auto</span>`}</span>
                <${Combo} id=${`pg-t${j}-loc`} style=${fs} placeholder="Location" value=${t.loc||''} onChange=${v=>setT(j,{loc:v})} label=${`Truck ${j+1} location`} options=${locs}/>
                <button type="button" class=${iconX} onClick=${()=>removeTruck(j)} aria-label=${`Remove truck ${j+1}`} title="Remove">${Icon.x}</button>
              </div>`)}
              <div class="flex flex-wrap gap-3 pt-0.5">
                <button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>addTruck(g.label)}>${Icon.plus} Add truck${g.label?` at ${g.label}`:''}</button>
                ${g.items.length>0&&html`<button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>addTruck(g.label,g.items[g.items.length-1].t)}>${Icon.plus} Same truck again</button>`}
              </div>
            </div>
          </div>`})})()}
      ${tl.length>0&&(()=>{const byLoc=[];tl.forEach(t=>{const kk=lkey(t);let g=byLoc.find(x=>x.key===kk);if(!g){g={key:kk,label:(t.loc||'').trim()||'No location',t:0,n:0};byLoc.push(g)}g.t+=truckT(t.w);g.n++});
        return html`<div class="rounded-lg bg-sunken border border-line px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span class="text-[13px]"><span class="font-semibold">Total for this shift:</span> <span class="font-semibold tnum text-[14px]">${fmtN(totT)}T</span> <span class="text-muted">· ${tl.length} truck${tl.length===1?'':'s'}</span></span>
          ${byLoc.length>1&&html`<span class="text-[12px] text-muted tnum">${byLoc.map(g=>`${g.label} ${fmtN(g.t)}T`).join(' · ')}</span>`}
        </div>`})()}
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[12px] text-muted">${realTrucks.length?'Add trucks at another location':'Add trucks at'}</span>
        <span style=${{width:210}}><${Combo} id="pg-newloc" style=${fs} placeholder="Location, e.g. SCA" value=${newLoc} onChange=${setNewLoc} label="Location for new trucks" options=${locs} onEnter=${addNewLoc}/></span>
        <button type="button" class="btn" style=${{height:30}} disabled=${!newLoc.trim()} onClick=${addNewLoc}>${Icon.plus} Add</button>
      </div>
    </div>`}

    ${part!=='trucks'&&html`    <div class="grid gap-1.5">
      <div class="flex items-baseline gap-2"><span class="label" style=${{color:'var(--ink)'}}>Subcontractors</span><span class="flex-1 h-px bg-line self-center"></span></div>
      <div class=${'hidden sm:grid '+SC2}><span class="label">Subcontractor</span><span class="label">Service</span><span class="label">Start time</span><span></span></div>
      ${subs.map((s,j)=>html`<div key=${j} class=${SC2}>
        <${Combo} id=${`pg-s${j}-n`} style=${fs} placeholder="Subcontractor" value=${s.name||''} onChange=${v=>setS(j,{name:v})} label=${`Subcontractor ${j+1}`} options=${subCosOf(data)}/>
        <${Combo} id=${`pg-s${j}-i`} style=${fs} placeholder=${servicesFor(data,s.name).length?'Pick or type a service':'Type the service'} value=${s.info||''} onChange=${v=>setS(j,{info:v})} label=${`Subcontractor ${j+1} service`} options=${servicesFor(data,s.name)}/>
        <${TimeSelect} id=${`pg-s${j}-t`} label=${`Subcontractor ${j+1} start time`} value=${s.time||''} pm=${night} onChange=${v=>setS(j,{time:v})}/>
        <button type="button" class=${iconX} onClick=${()=>upd({subs:subs.filter((_,x)=>x!==j)})} aria-label=${`Remove subcontractor ${j+1}`} title="Remove">${Icon.x}</button>
      </div>`)}
      <div><button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>upd({subs:[...subs.filter(subHas),{time:q.start||''}]})}>${Icon.plus} Add subcontractor</button></div>
    </div>

    <label class="grid gap-1"><span class="label">Comments for this shift</span>
      <textarea id="pg-comments" class="field" style=${{height:'auto',minHeight:56,padding:'8px 10px',resize:'vertical'}} rows="2" placeholder=${night?'e.g. Standard PPE + UHF: 12, lighting towers on site':'e.g. Standard PPE + UHF: 12'} value=${q.comments||''} onInput=${e=>upd({comments:e.target.value})}></textarea></label>`}
    </fieldset>
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
/* rows of the daily program's plant box; optional rows only show when a machine lands in them */
const PLANT_GROUPS=[['Pavers',/paver/i],['Steel rollers',/steel|tandem|drum|smooth/i],['Multi rollers',/multi|pneumatic|tyre|tire|rubber/i],['Bobcat',/bobcat|skid|loader|posi/i],['Brooms',/broom|sweep/i,true]];
const SEAL_PLANT_GROUPS=[['Sprayer',/spray/i],['Roller',/roller|multi|steel|tandem|pneumatic/i],['Broom',/broom|sweep/i],['Bobcat',/bobcat|skid|loader|posi/i]];
function plantGroups(machines,seal){
  const G=seal?SEAL_PLANT_GROUPS:PLANT_GROUPS;const g=G.map(([l,,opt])=>({label:l,items:[],opt:!!opt}));const extra={label:'Additional',items:[]};
  /* the machine's own name and description decide first (e.g. "Tractor Broom" in the Spray Seal category is a broom), then its category */
  const find=t=>G.findIndex(([,re])=>re.test(t));
  machines.forEach(m=>{let i=find(`${m.name} ${m.sub||''}`);if(i<0)i=find(m.category||'');const t=`${m.name} ${m.sub||''} ${m.category||''}`;
    (i>=0?g[i]:(!seal&&/roller/i.test(t)?g[1]:extra)).items.push(m)});
  return [...g.filter(x=>!x.opt||x.items.length),extra];
}
const AFA_RED=[155,10,30],AFA_DARK=[58,58,58],AFA_GRID=[160,160,160];
function drawProgram(doc,data,{b,k,crewId}){
  const crew=data.resources.find(r=>r.id===crewId)||{name:'Crew'};
  const job=data.jobs.find(j=>j.id===b.jobId)||{name:'Job'};
  const seal=isSealCrew(crew)||isSealCrew(data.resources.find(r=>r.id===b.resourceId));
  const q=(b.shiftData||{})[k]||{};const lines=linesOf(q).filter(lineHas).map(l=>seal&&!l.twoCoat&&sealIsTwoCoat(data,l.type)?{...l,twoCoat:true}:l);
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
   ['PROJECT No :',b.projectNo||job.projectNo||'',{bold:true,color:AFA_RED}],['SUPERVISOR PH :',(()=>{const nm=pick('supervisor');return (b.supervisor||'').trim()?(b.supervisorPhone||'').trim()||superPhoneOf(data,nm):(sib.find(x=>(x.supervisor||'').trim()===nm&&(x.supervisorPhone||'').trim())||{}).supervisorPhone||superPhoneOf(data,nm)})(),{bold:true}]]
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
  const people=[[{t:crew.name,bold:true},'SITE',crew.subbie?`${crew.sub||''}${crew.sub?' - ':''}Subcontractor`:(crew.sub||''),st],...staff.map(p=>[p.name,'SITE',p.sub||'',st])].slice(0,10);
  while(people.length<5)people.push(['','','','']);
  people.forEach(v=>{ly=row(LX,ly,PC,v)});

  /* left: plant onsite */
  ly+=3;ly=head(LX,ly,LW,[['PLANT ONSITE',LW]]);
  const machines=(b.plantIds||[]).map(id=>data.resources.find(r=>r.id===id)).filter(Boolean);
  plantGroups(machines,seal).forEach(g=>{const its=g.items.length?g.items:[null];
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
    ?[['Job location:',null],['SUPPLIER :',()=>supplier],['SEAL TYPE :',l=>l.type+(l.twoCoat?' x2':'')],['BINDER :',l=>l.twoCoat&&l.binder2&&l.binder2!==l.binder?`${l.binder||'-'} / ${l.binder2}`:l.binder],['STONE :',l=>l.twoCoat?`${l.stone||'-'}/${l.stone2||'-'}`:(l.stone||'')],['APPROX AREA (M2) :',l=>num(l.area)?fmtN(num(l.area)):'']]
    :[['Job location:',null],['SUPPLIER :',()=>supplier],['MIX :',l=>{const r=rapOf(l.type);return (l.type||'')+(r&&!l.virgin?` ${fmtN(r)}% RAP`:'')}],['BINDER :',l=>l.binder],
      ['APPROX TONNAGE :',l=>num(l.tonnes)?fmtN(num(l.tonnes)):''],['APPROX AREA (M2) :',l=>num(l.area)?fmtN(num(l.area)):''],['DEPTH (mm) :',l=>num(l.depth)?fmtN(num(l.depth)):'']];
  matRows.forEach(([l,fn])=>{
    if(!fn){cell(RX,ry2,31,5.4,l,{align:'right',size:6.6,bold:true});cell(RX+31,ry2,63,5.4,b.address||job.address||job.name,{fill:[20,20,20],color:[255,255,255],bold:true,size:6.8});ry2+=5.4;return}
    ry2=row(RX,ry2,vc,[{t:l,align:'right',size:6.6},...[0,1,2].map(i=>L3[i]?{t:fn(L3[i]),bold:true,...(l==='SUPPLIER :'?{fill:AFA_RED,color:[255,255,255]}:{})}:'')])});
  if(lines.length>3){cell(RX,ry2,RW,5,`+ ${lines.length-3} more line${lines.length-3===1?'':'s'} - see the booking`,{border:false,size:6.4,color:[110,110,110]});ry2+=5}

  /* right (seal): spray & spread rates per product, instead of trucks */
  if(seal){ry2+=3;const RC=[['PRODUCT',26],['BITUMEN',14],['SPRAY L/M2',17],['STONE',14],['SPREAD M2/M3',23]];ry2=head(RX,ry2,RW,RC);
    const rr=(t,bd,sp,st,sr)=>[{t,bold:true},bd||'',{t:num(sp)?fmtN(num(sp)):'',bold:true,color:AFA_RED},st||'',{t:num(sr)?fmtN(num(sr)):'',bold:true,color:AFA_RED}];
    const rv=lines.flatMap(l=>l.twoCoat?[rr(`${l.type||''} 1st`,l.binder,l.spray,l.stone,l.spread),rr(`${l.type||''} 2nd`,l.binder2||l.binder,l.spray2,l.stone2,l.spread2)]:[rr(l.type,l.binder,l.spray,l.stone,l.spread)]);
    while(rv.length<6)rv.push(['','','','','']);rv.slice(0,12).forEach(v=>{ry2=row(RX,ry2,RC,v)})}
  /* right: trucks */
  if(!seal){ry2+=3;const TCo=[['TRUCKS',27],['DRIVER',16],['WEIGHT',12],['TIME',14],['LOCATION',25]];ry2=head(RX,ry2,RW,TCo);
  const tr=(q.trucks||[]).filter(truckHas);
  /* grouped by location (in order of first appearance, times in order within a group), a blank row between groups */
  const groups=[];tr.forEach(t=>{const key=(t.loc||'').trim().toLowerCase();let g=groups.find(x=>x.key===key);if(!g){g={key,items:[]};groups.push(g)}g.items.push(t)});
  groups.forEach(g=>g.items.sort((a,c)=>(a.time||'99')<(c.time||'99')?-1:(a.time||'99')>(c.time||'99')?1:0));
  const LOC_FILLS=[AFA_RED,[64,112,52],[38,84,140],[150,96,20],[96,60,130]];let fi=0;
  const usedC=new Set(groups.map(g=>{const s=!!b.address&&g.key===b.address.trim().toLowerCase();return s?locColorOf(data,'SITE'):(programLocsOf(data).some(x=>x.toLowerCase()===g.key)||Object.keys(locColorsOf(data)).some(x=>x.toLowerCase()===g.key))?locColorOf(data,g.key):null}).filter(Boolean).map(c=>c.toLowerCase()));
  const tv=[];groups.forEach((g,gi)=>{const isSite=!!b.address&&g.key===b.address.trim().toLowerCase();
    const known=programLocsOf(data).some(x=>x.toLowerCase()===g.key)||Object.keys(locColorsOf(data)).some(x=>x.toLowerCase()===g.key);
    let hex=isSite?locColorOf(data,'SITE'):known?locColorOf(data,g.key):null;
    if(!hex){hex=LOC_PALETTE.find(c=>!usedC.has(c.toLowerCase()))||LOC_PALETTE[(fi++)%LOC_PALETTE.length]}usedC.add(hex.toLowerCase());
    const fill=hexRgb(hex);
    const ink=(fill[0]*299+fill[1]*587+fill[2]*114)/1000>150?[0,0,0]:[255,255,255];   /* dark text on light colours */
    if(gi)tv.push(['','','','','']);
    g.items.forEach(t=>tv.push([t.co,{t:t.driver,color:AFA_RED,bold:true},t.w,fmtTime(t.time),t.loc?{t:t.loc,bold:true,fill,color:ink}:'']))});
  if(tv.length>24)tv.length=24;
  while(tv.length<12)tv.push(['','','','','']);tv.forEach(v=>{ry2=row(RX,ry2,TCo,v)});
  const tot=tr.reduce((a,t)=>a+truckT(t.w),0);
  ry2=row(RX,ry2,TCo,['',{t:'Total:',bold:true,align:'right'},{t:tot?`${fmtN(tot)}T`:'',bold:true},'',''],5.4);}

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
async function buildDailyProgramPdf(data,entries,withPlans=true){
  const JsPDF=await loadJsPDF();
  const doc=new JsPDF({orientation:'portrait',unit:'mm',format:'a4'});
  /* each job's daily program, followed by that shift's page(s) from the job plan when there is one */
  for(let n=0;n<entries.length;n++){const e=entries[n];if(n)doc.addPage();drawProgram(doc,data,e);
    const pl=withPlans?planFor(data,e.b):null;if(pl&&planDates(pl,data).includes(e.k))await buildPlanPdf(data,pl,{doc,shiftDate:e.k})}
  return doc.output('blob');
}
const programFileName=(data,e)=>{const crew=data.resources.find(r=>r.id===e.crewId);const j=data.jobs.find(x=>x.id===e.b.jobId)||{};const d=parse(e.k);
  return `${[crew&&crew.name,j.customer,j.name].filter(Boolean).join(' - ')} ${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`.replace(/[\\/:*?"<>|]+/g,' ').replace(/\s+/g,' ').trim()+'.pdf'};

/* ---------- upcoming works for subcontractor crews (crews with the SUB tag): a branded PDF ---------- */
/* every shift a crew works between two dates: its own bookings, plus shifts it covers on other crews' bookings */
function subWorks(data,crewId,from,to){
  const out=[];
  data.blocks.filter(b=>b.kind==='job').forEach(b=>{const ds=shiftDates(b);
    ds.forEach((k,i)=>{if(k<from||k>to)return;if((coverOf(b,k)||b.resourceId)!==crewId)return;out.push({b,k,idx:i,n:ds.length})})});
  return out.sort((a,c)=>a.k<c.k?-1:a.k>c.k?1:((a.b.shift==='night')-(c.b.shift==='night'))||(a.b.id<c.b.id?-1:1));
}
const subWorkRow=(data,{b,k,idx,n})=>{const job=data.jobs.find(j=>j.id===b.jobId)||{};const q=(b.shiftData||{})[k]||{};
  const lines=linesOf(q).filter(lineHas);const t=lines.reduce((a,l)=>a+num(l.tonnes),0),a=lines.reduce((s,l)=>s+num(l.area),0);
  return {job,q,lines,t,a,start:q.start||'',night:b.shift==='night',address:b.address||job.address||'',
    works:lines.map(l=>[mixLabel(l),num(l.area)?`${fmtN(num(l.area))} m²`:'',num(l.depth)?`@ ${fmtN(num(l.depth))} mm`:'',num(l.tonnes)?`${fmtN(num(l.tonnes))} t`:''].filter(Boolean).join(' ')),
    project:b.projectNo||job.projectNo||'',notes:[n>1?`Shift ${idx+1} of ${n}`:'',
      b.inductionReq?(b.inductionDone?'Induction: paperwork sent':'Induction required'):'',exbinOf(b,k)?`Exbin${exbinOf(b,k).supplier?' ('+exbinOf(b,k).supplier+')':''}`:'',(b.notes||'').trim()].filter(Boolean)}};

async function buildSubWorksPdf(data,crewIds,from,to){
  const JsPDF=await loadJsPDF();const doc=new JsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const PW=297,PH=210,M=12,W=PW-2*M;
  const clean=t=>String(t??'').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/²/g,'2').replace(/³/g,'3').replace(/·/g,'-').replace(/…/g,'...');
  const font=(s,b,c)=>{doc.setFont('helvetica',b?'bold':'normal');doc.setFontSize(s);doc.setTextColor(...(c||[0,0,0]))};
  const dLong=k=>{const d=parse(k);return `${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`};
  const range=`${dLong(from)} - ${dLong(to)} ${parse(to).getFullYear()}`;
  const COLS=[['SHIFT',19],['PROJECT No',20],['CREW SIZE',17],['CLIENT / JOB',50],['LOCATION',41],['WORKS',55],['TONNES',16],['SUPERVISOR',30],['NOTES',25]];
  const firstPageOf=[];
  crewIds.forEach((cid,ci)=>{const crew=data.resources.find(r=>r.id===cid)||{name:'Crew'};const rows=subWorks(data,cid,from,to).map(e=>({e,r:subWorkRow(data,e)}));
    if(ci)doc.addPage();firstPageOf.push(doc.getNumberOfPages());
    let y=0;
    const header=(first)=>{
      try{doc.addImage(AFA_LOGO,'PNG',M,8,first?46:34,first?17.8:13.2)}catch(x){}
      font(first?16:12,true);doc.text('UPCOMING WORKS',PW-M,first?14:12,{align:'right'});
      font(first?11:9,true,AFA_RED);doc.text(clean(crew.name)+(crew.sub?` - ${clean(crew.sub)}`:''),PW-M,first?20.5:17,{align:'right'});
      font(8.5,false,[90,90,90]);doc.text(clean(range),PW-M,first?25.5:21.5,{align:'right'});
      doc.setDrawColor(...AFA_RED);doc.setLineWidth(0.8);doc.line(M,first?29:24.5,PW-M,first?29:24.5);
      y=first?33:28};
    const colHead=()=>{doc.setFillColor(...AFA_DARK);doc.rect(M,y,W,6.2,'F');font(7.2,true,[255,255,255]);let x=M;COLS.forEach(([h,w])=>{doc.text(h,x+1.8,y+4.2);x+=w});y+=6.2};
    header(true);
    /* summary */
    const tot=rows.reduce((a,{r})=>({t:a.t+r.t,a:a.a+r.a}),{t:0,a:0});const jobs=new Set(rows.map(({e})=>e.b.jobId)).size;const nights=rows.filter(({r})=>r.night).length;
    const boxes=[['SHIFTS',String(rows.length)],['JOBS',String(jobs)],['DAY / NIGHT',`${rows.length-nights} / ${nights}`],['ASPHALT',tot.t?`${fmtN(tot.t)} t`:'-'],['AREA',tot.a?`${fmtN(tot.a)} m2`:'-']];
    const bw=(W-4*3)/5;boxes.forEach(([k,v],i)=>{const x=M+i*(bw+3);doc.setFillColor(244,244,246);doc.setDrawColor(220,220,226);doc.setLineWidth(0.2);doc.roundedRect(x,y,bw,14,1.5,1.5,'FD');
      font(6.8,true,[110,110,110]);doc.text(k,x+3,y+4.8);font(12,true,k==='ASPHALT'?AFA_RED:[20,20,20]);doc.text(clean(v),x+3,y+11.2)});
    y+=19;
    if(!rows.length){font(10,false,[90,90,90]);doc.text('No works booked for this crew in this period.',M,y+6)}
    else{colHead();
      let lastDay='';
      rows.forEach(({e,r},ri)=>{
        const cells=[[`${r.night?'NIGHT':'DAY'}${r.start?'\n'+fmtTime(r.start):''}`],[r.project||'-'],[e.b.crewSize?`${e.b.crewSize} man`:'-'],
          [`${r.job.customer||''}`,`${r.job.name||''}`],[r.address],[r.works.length?r.works.join('\n'):'-'],[r.t?fmtN(r.t):'-'],
          [[e.b.supervisor,e.b.supervisorPhone].filter(Boolean).join('\n')||'-'],[r.notes.join('\n')||'-']];
        const split=cells.map((c,i)=>{font(7.6,i===3||i===2);return doc.splitTextToSize(clean(c.filter(Boolean).join('\n')),COLS[i][1]-3.6)});
        const h=Math.max(...split.map(s=>s.length))*3.4+3.6;
        const needDay=e.k!==lastDay;
        if(y+h+(needDay?7:0)>PH-14){doc.addPage();header(false);colHead();lastDay=''}
        if(e.k!==lastDay){doc.setFillColor(...AFA_RED);doc.rect(M,y,W,5.6,'F');font(7.8,true,[255,255,255]);doc.text(clean(dLong(e.k)).toUpperCase(),M+1.8,y+3.9);
          const dayRows=rows.filter(x=>x.e.k===e.k);const dt=dayRows.reduce((a,x)=>a+x.r.t,0);
          font(7.2,false,[255,255,255]);doc.text(`${dayRows.length} shift${dayRows.length===1?'':'s'}${dt?` - ${fmtN(dt)} t`:''}`,PW-M-1.8,y+3.9,{align:'right'});y+=5.6;lastDay=e.k}
        if(ri%2){doc.setFillColor(248,248,250);doc.rect(M,y,W,h,'F')}
        doc.setDrawColor(225,225,230);doc.setLineWidth(0.15);doc.line(M,y+h,PW-M,y+h);
        let x=M;split.forEach((s,i)=>{font(7.6,i===3||i===6||i===2,i===0&&r.night?[40,40,110]:i===6?AFA_RED:[25,25,25]);
          if(i===3&&s.length){font(7.6,true);doc.text(s[0],x+1.8,y+4.3);font(7.6,false,[60,60,60]);if(s.length>1)doc.text(s.slice(1),x+1.8,y+4.3+3.4)}
          else doc.text(s,x+1.8,y+4.3);x+=COLS[i][1]});
        y+=h});
    }
  });
  /* footer on every page */
  const n=doc.getNumberOfPages();const printed=new Date().toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'});
  for(let i=1;i<=n;i++){doc.setPage(i);font(7,false,[130,130,130]);doc.text(`FraserFlow - Alex Fraser Group - printed ${printed}`,M,PH-6);doc.text(`Page ${i} of ${n}`,PW-M,PH-6,{align:'right'})}
  return doc.output('blob');
}

function SubWorksDialog({data,onClose,notify}){
  const subs=data.resources.filter(r=>r.type==='crew'&&r.subbie);
  const [crew,setCrew]=useState(subs[0]?subs[0].id:'');
  const [from,setFrom]=useState(()=>iso(TODAY));const [to,setTo]=useState(()=>iso(addDays(TODAY,13)));
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  useEffect(()=>{const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);
  const ids=crew==='all'?subs.map(c=>c.id):crew?[crew]:[];
  const ok=from&&to&&to>=from;
  const preview=ok?ids.map(id=>({c:data.resources.find(r=>r.id===id),list:subWorks(data,id,from,to)})):[];
  const mon=mondayOf(TODAY);
  const presets=[['Next 7 days',iso(TODAY),iso(addDays(TODAY,6))],['Next 14 days',iso(TODAY),iso(addDays(TODAY,13))],['Next week',iso(addDays(mon,7)),iso(addDays(mon,13))],['Next 4 weeks',iso(TODAY),iso(addDays(TODAY,27))]];
  const go=async()=>{setErr('');const dl=window.claude&&window.claude.use?await window.claude.use('downloads').catch(()=>null):null;
    if(!dl){setErr('Saving files isn’t available in this view.');return}setBusy(true);
    try{const blob=await buildSubWorksPdf(data,ids,from,to);const f=parse(from),t=parse(to);const nm=crew==='all'?'Subcontractor crews':(data.resources.find(r=>r.id===crew)||{}).name||'Crew';
      await dl.save({filename:`Upcoming works - ${nm.replace(/[\\/:*?"<>|]+/g,' ').trim()} - ${pad(f.getDate())}.${pad(f.getMonth()+1)} to ${pad(t.getDate())}.${pad(t.getMonth()+1)}.${t.getFullYear()}.pdf`,data:blob});notify('Upcoming works PDF saved');onClose()}
    catch(e){const c=e&&e.code;setErr(c==='declined'?'Download cancelled.':(e&&e.message)||'The PDF could not be built.')}finally{setBusy(false)}};
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full max-w-[620px] flex flex-col max-h-full overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="sw-title">
      <div class="px-5 pt-5 pb-3 border-b border-line flex items-start gap-3">
        <div class="min-w-0 flex-1"><div id="sw-title" class="font-display text-[18px] font-semibold">Subcontractor upcoming works</div>
          <div class="text-[12.5px] text-muted">A PDF of every shift a subcontractor crew has booked in a period, to send to them.</div></div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button></div>
      ${!subs.length?html`<div class="p-5 text-[13px] text-muted">No crews are marked as subcontractors yet. In Settings › Crews, edit a crew and tick <b>Subcontractor</b>.</div>`
      :html`<div class="px-5 py-4 grid gap-3 border-b border-line">
          <label class="grid gap-1"><span class="label">Crew</span>
            <select id="sw-crew" class="field" value=${crew} onChange=${e=>setCrew(e.target.value)}>
              ${subs.map(c=>html`<option key=${c.id} value=${c.id}>${c.name}${c.sub?' · '+c.sub:''}</option>`)}
              ${subs.length>1&&html`<option value="all">All subcontractor crews (one section each)</option>`}</select></label>
          <div class="grid grid-cols-2 gap-3">
            <label class="grid gap-1"><span class="label">From</span><input id="sw-from" type="date" class="field mono" value=${from} onChange=${e=>setFrom(e.target.value)}/></label>
            <label class="grid gap-1"><span class="label">To</span><input id="sw-to" type="date" class="field mono" value=${to} onChange=${e=>setTo(e.target.value)}/></label></div>
          <div class="flex flex-wrap gap-1.5">${presets.map(([l,a,b])=>html`<button key=${l} type="button" class=${'text-[12px] rounded-full border px-2.5 py-0.5 '+(from===a&&to===b?'font-semibold':'text-muted hover:text-ink')}
              style=${from===a&&to===b?{borderColor:'var(--accent)',color:'var(--accent)',background:'var(--accent-soft)'}:{borderColor:'var(--line)'}} onClick=${()=>{setFrom(a);setTo(b)}}>${l}</button>`)}</div>
          ${!ok&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>The end date is before the start date.</div>`}
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-5 py-3 grid gap-3 content-start">
          ${preview.map(({c,list})=>html`<div key=${c.id} class="grid gap-1">
            ${crew==='all'&&html`<div class="font-semibold text-[13px]">${c.name}</div>`}
            ${!list.length?html`<div class="text-[12.5px] text-muted">No works booked for ${c.name} in this period.</div>`
              :list.map(e=>{const r=subWorkRow(data,e);return html`<div key=${e.b.id+e.k} class="grid grid-cols-[96px_1fr_auto] gap-2 text-[12.5px] py-1 border-b border-line last:border-b-0">
                <span class="mono text-muted">${WD[parse(e.k).getDay()]} ${fmtShort(parse(e.k))}</span>
                <span class="min-w-0 truncate"><span class="font-medium">${r.job.customer?r.job.customer+' · ':''}${r.job.name||'Job'}</span><span class="text-muted">${r.night?' · night':' · day'}${r.start?' · '+fmtTime(r.start):''}${e.b.crewSize?` · ${e.b.crewSize} man`:''}</span></span>
                <span class="mono tnum">${r.t?fmtN(r.t)+' t':''}</span></div>`})}</div>`)}
        </div>`}
      <div class="px-5 py-3 border-t border-line bg-sunken flex flex-wrap items-center gap-2">
        ${err&&html`<span class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}
        <span class=${'text-[12px] text-muted'+(err?'':' mr-auto')}>${preview.reduce((a,x)=>a+x.list.length,0)} shift${preview.reduce((a,x)=>a+x.list.length,0)===1?'':'s'}</span>
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button id="sw-pdf" type="button" class="btn btn-primary" disabled=${busy||!ok||!ids.length} onClick=${go}>${Icon.download} ${busy?'Building…':'Export PDF'}</button>
      </div>
    </div></div>`;
}

/* header "Exports" menu: the daily program and subcontractor works PDFs */
function ExportsMenu({items}){
  const [open,setOpen]=useState(false);const ref=useRef(null);
  useEffect(()=>{if(!open)return;const out=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};const esc=e=>{if(e.key==='Escape')setOpen(false)};
    document.addEventListener('pointerdown',out);window.addEventListener('keydown',esc);return()=>{document.removeEventListener('pointerdown',out);window.removeEventListener('keydown',esc)}},[open]);
  return html`<div class="relative" ref=${ref}>
    <button id="btn-exports" type="button" class="btn" aria-haspopup="menu" aria-expanded=${open} onClick=${()=>setOpen(!open)}>${Icon.download} Exports <span class="inline-flex transition-transform" style=${{transform:open?'rotate(180deg)':'none'}}>${Icon.chevD}</span></button>
    ${open&&html`<div role="menu" class="panel pop absolute left-0 top-[calc(100%+6px)] z-40 w-[290px] p-1.5 grid gap-0.5" style=${{boxShadow:'0 10px 30px rgba(0,0,0,.18)'}}>
      ${items.map(it=>html`<button key=${it.id} id=${it.id} role="menuitem" type="button" class="w-full text-left rounded-lg px-2.5 py-2 hover:bg-sunken grid gap-0.5" onClick=${()=>{setOpen(false);it.run()}}>
        <span class="text-[13.5px] font-medium">${it.label}</span><span class="text-[12px] text-muted">${it.desc}</span></button>`)}
    </div>`}
  </div>`;
}
function DailyProgramDialog({data,onClose,notify}){
  const [day,setDay]=useState(()=>iso(addDays(TODAY,1)));
  const [incPlan,setIncPlan]=useState(true);
  const [off,setOff]=useState({});const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [dl,setDl]=useState(undefined);
  useEffect(()=>{let live=true;
    try{const p=window.claude?.use?.('downloads');if(p&&p.then)p.then(x=>{if(live)setDl(x)},()=>{if(live)setDl(null)});else setDl(null)}catch(e){setDl(null)}
    const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>{live=false;window.removeEventListener('keydown',h)}},[]);
  const entries=programEntries(data,day);const key=e=>e.b.id+'|'+e.k;
  const chosen=entries.filter(e=>!off[key(e)]);
  const step=n=>{setDay(iso(addDays(parse(day),n)));setOff({});setErr('')};
  const save=async(list,fn)=>{const blob=await buildDailyProgramPdf(data,list,incPlan);await dl.save({filename:fn,data:blob})};
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
          const sealE=isSealCrew(crew)||isSealCrew(data.resources.find(r=>r.id===e.b.resourceId));
          return html`<label key=${key(e)} class="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5 cursor-pointer hover:bg-sunken">
            <input type="checkbox" class="w-4 h-4 mt-0.5" style=${{accentColor:'var(--accent)'}} checked=${!off[key(e)]} onChange=${ev=>setOff(o=>({...o,[key(e)]:!ev.target.checked}))}/>
            <span class="min-w-0 grid gap-0.5">
              <span class="text-[13px] font-medium truncate">${jobLabel(j)}</span>
              <span class="text-[12px] text-muted">${crew?crew.name:''}${e.b.shift==='night'?' · night':' · day'}${e.crewId!==e.b.resourceId?' · covering':''}${(()=>{const pl=planFor(data,e.b);return pl&&planDates(pl,data).includes(e.k)?html` · <span class="font-semibold" style=${{color:'var(--accent)'}}>+ job plan</span>`:''})()}</span>
              ${sealE?html`<span class="text-[12px] text-muted">${pl} plant · ${sb} subcontractor${sb===1?'':'s'} · seal</span>`
                :html`<span class=${'text-[12px] '+(tr?'text-muted':'')} style=${tr?{}:{color:'var(--warn)'}}>${pl} plant · ${tr} truck${tr===1?'':'s'} · ${sb} subcontractor${sb===1?'':'s'}${tr?'':' (no trucks yet)'}</span>`}
            </span></label>`})}
      </div>
      ${err&&html`<div class="px-5 pb-2 text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
      <div class="px-5 py-3 border-t border-line flex flex-wrap items-center gap-2">
        <label class="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer mr-auto"><input id="dp-plans" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${incPlan} onChange=${e=>setIncPlan(e.target.checked)}/>Add the job plan for the shift</label>
        <span class="text-[12px] text-muted">${chosen.length} of ${entries.length} selected</span>
        <button type="button" class="btn" disabled=${busy||chosen.length<2} onClick=${()=>go(true)}>One combined PDF</button>
        <button type="button" class="btn btn-primary" disabled=${busy||!chosen.length} onClick=${()=>go(false)}>${busy?'Building…':chosen.length>1?`Download ${chosen.length} PDFs`:'Download PDF'}</button>
      </div>
    </div>
  </div>`;
}

/* Alex Fraser Group logo for the header: the oval, and the tagline (inverted in dark mode) */
const BRAND_OVAL='data:image/png;base64,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';
const BRAND_TAG='data:image/png;base64,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';
const AFA_LOGO='data:image/png;base64,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YyfWDAMRLILYtqYl2OEzJ1lBo9FFsRN+PQkYTz09O2laCo6OAEDWSDGhNKFlXStmnOkMEYQFDByYTgUTzv9ZkRhvAZWBSGrfq9n05Lrii8aO+/0UW4YDOOAY25jbZscUxm7548aeXd2A4eAxKQIsYW+nd82tK3WfThUKABwB9etIRIc5K4ggRFDziqbWNS2yXZKiZNEuE5EggoByk83kahhsebtatIhCtByRHZU1J3fPsipzvHny76elnVsAgEDnVS+UV76x25ESEVMQGzUqOmJUtDk9yhYjCQSDziwpjojsKGez0wigEEFaUKv89+6EyclJp2UhAaeekR1bGlf/bm3t23vadrXsfG+7q941/9kzOte1rr9njRbUJatkePtHZkWOOi+/aWVTx5Z2xR8QRFEQhWNffHAQzJLuD1a/+IEpOiL3ooW2vHRl156urzemnz73pOUdXde/+OILv9/v8/nWrFnz1VdfDT2VmJh4+eWXm83m/4Li0iWXXPLyyy/v2LFjKFDYtWuX2+0+2puEyWRatGjRunXruru7jUeWLVs2ffr0a6+99jDMCwB79uzp7OwMjZTPPvvsyZMnw39lF9Pe1z6s/fsblHP9+HIoQkZoe5j2G6Otc6BuoGtLR9bSfPBTwUQm3zEdxVkBZKB+995O9+4eZ5NLssuAQA2qslkChIADMKC6njwmOeOMXEQZCMjX6Kxbvjfo0bb/fStofOojcyljgaq+YK9f9an2FHtvec+hDtH44vuq+ijX96lGARAgQggxkSNOH/G0eRhnDBgHBoBkScYC5gRoQN/94u6yf5RJFlFySHKcGWNMJGKONuuK3vb+HnNmJDiD5S+U9bb09lT31q+oF5FojjPbM225Z4wq+fV4ImHskKJHRzevbeScI46YxmLSol3NrlU3fjnphulpZ+aYYsymzKjRv5+UsSi7/r291f8p7yzvWPXbz5y1TqoyySIZlKfruhQhlV43IfeS0VUvlNW9t6d/7wDVdNEkjVDPcAgmNWm+QMVzb1oS49JOmxpdlNW+saJrW1nixDEnLY2+//7777///oGh0N13333mmWfCfwWsVuvkyZN37do1FA/29vZ2dnYmJiYeVWOxKIo///nPp02bduuttxqKJcbYww8/PG7cuBkzZhw0RWBsv7m5OfRHZTKZ5s6dG/p6n8+3detWo7shdF3IOY+N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iNMZM2b8rxXHhKPp8CFpC2ZXP11tFwR7VoIjK2GwqhUIhnA98URNSfyf41EGUoxZkAnWOIqPT5k7/Qf5sSmK8vzzz2/evPlApX1MTExaWlpRUdG55557zjnnHJ5A33jjja+++qqmpubA5kiTyZSTkzN27Njzzz9/yZIlR9yllpaWO++8c2i0PQAQQpxO58MPP3xQNznG2NatWx988MFDNUQRQqKiopKTk7Oysk455ZSzzz47JyfnUJ/+2Wef/fnPf962bduwA5FledSoUbNnz7744osnTZpE/mfSL2QkTrFDkCLtvbtrBKYINjOWJWdNG6MMYRy+4sP4fkJR0ZIeJQgYB7X0xWelnTbrBwlzVFV95ZVXDnQRZYz5fL6Ojo6ysrJNmza5XK5JkyYddE7Ru+++e9ttt7322mstLS0HbWPXdb23t3f37t2bNm0aGBgoLS090LMj9HPffPPN//znP8Pu0L29vUuXLj1ULLl9+/bDNP8Y6tfu7u6ampq1a9du27ZNEISSkpIDT/hXX331u9/9btOmTQceCKW0p6dn69ate/fuXbx48Y86WQHHuRk0BKLZnLFwrt8bFAUhKj81qiCN6RRYOMIK43vROUlxVsEkEI2DIzLznIU/1FIRIXTEtXZzc/PDDz/86KOPDps4DwD//ve/b7jhhvXr14+kf7GpqemPf/zjjTfeeKABCoRM2XvzzTcPGqKuXLnyUJ8S2kEPR5opvXr16ptuuunee+8dxpU9PT133XVXdXX14beQlZV1Es7vPFloFABixo42xacRncsOa9KcUsluoQf8bsII4zhI7q2SHGdFHKhK0844zZGVdpJkYzDG06dP/+Uvfzl37txQZlcU5dlnnw2dOA8An3zyyR133NHU1HSgZVRaWlpubu6BwaOmaf/6178efPDBQ3l8lJWV7dix48AEkaZpy5YtG4mPiXFvsNlsERERDofjoJFvV1fXI4888vDDDxvz7IwoeM2aNUPTRGD/4PgLLrjg/PPPLywsHOLQ2267zf6DNuzCSZsbHQpI086Y3/LG247oiKjCjMQpha1fbgPKgISX9mEcN9JCCJmSHMQkiApHcXG555918lQtBEFYuHDhb37zm56envfff//hhx8e8qDr6+t76623Jk+ebESvra2td91117ApwXa7/Sc/+cm8efPS0tIEQXC73Zs3b37//feH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';  /* Alex Fraser Group, for the daily program PDF */

/* ---------- machines: rego, category and importing the fleet list ---------- */
const machCatOf=r=>((r&&r.category)||'').trim();
/* every category in use, in the saved order (from the fleet list), then any others */
const MACHINE_CATS_BUILTIN=['Brooms'];   /* always offered in the category box */
const machineCatsOf=d=>{const out=[];const add=c=>{c=(c||'').trim();if(c&&!out.some(x=>x.toLowerCase()===c.toLowerCase()))out.push(c)};
  (d.machineCats||[]).forEach(add);d.resources.forEach(r=>{if(r.type==='machine')add(r.category)});MACHINE_CATS_BUILTIN.forEach(add);return out};
function groupMachines(rows,d,withEmpty=false){
  const ord=machineCatsOf(d).map(x=>x.toLowerCase());const m=new Map();
  rows.forEach(r=>{const c=machCatOf(r);const k=c.toLowerCase()||'~';if(!m.has(k))m.set(k,{key:k,label:c||'No category',rows:[]});m.get(k).rows.push(r)});
  /* categories added by hand (or emptied) still show, so machines can be put in them */
  if(withEmpty)(d.machineCats||[]).forEach(c=>{c=(c||'').trim();const k=c.toLowerCase();if(c&&!m.has(k))m.set(k,{key:k,label:c,rows:[],empty:true})});
  return [...m.values()].sort((a,b)=>a.key==='~'?1:b.key==='~'?-1:(ord.indexOf(a.key)<0?999:ord.indexOf(a.key))-(ord.indexOf(b.key)<0?999:ord.indexOf(b.key)));
}
function loadSheetJS(){
  if(window.XLSX)return Promise.resolve(window.XLSX);
  return new Promise((res,rej)=>{const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload=()=>window.XLSX?res(window.XLSX):rej(new Error('Spreadsheet reader missing'));
    s.onerror=()=>rej(new Error('Could not load the spreadsheet reader'));document.head.appendChild(s)});
}
/* The fleet list: a heading on its own row starts a category (headings further left are parent groups,
   e.g. "Narangba Transport" › "Trucks"); a machine row has the rego, then the description that starts with the machine #. */
function parseFleetRows(rows){
  const out=[];let stack=[];let cols=null;
  rows.forEach((row,ri)=>{
    const cells=(row||[]).map((v,c)=>({c,v:String(v??'').replace(/\s+/g,' ').trim()})).filter(x=>x.v);
    if(!cells.length)return;
    /* a table with headings (e.g. this planner's own export): Category, Machine #, Description, Rego */
    const low=cells.map(x=>x.v.toLowerCase());
    if(low.includes('rego')&&low.some(v=>/^(machine\s*#?|machine no\.?|fleet no\.?)$/.test(v))){
      cols={};cells.forEach(x=>{const v=x.v.toLowerCase();if(v==='rego')cols.rego=x.c;else if(/^(machine|fleet)/.test(v))cols.name=x.c;else if(v==='description')cols.desc=x.c;else if(v==='category')cols.cat=x.c});return}
    if(cols){const g=c=>c==null?'':String((row||[])[c]??'').replace(/\s+/g,' ').trim();const name=g(cols.name);
      if(!name||!g(cols.rego)&&!g(cols.desc)){return}
      out.push({row:ri+1,rego:g(cols.rego).toUpperCase(),code:name.toUpperCase(),name:name.toUpperCase(),desc:g(cols.desc),full:`${name} ${g(cols.desc)}`.trim(),category:g(cols.cat),
        retired:/no longer in use|retired|\bsold\b|written off/i.test(g(cols.desc))});return}
    if(cells.length===1){const h=cells[0];stack=stack.filter(x=>x.c<h.c);stack.push(h);return}
    const rego=cells[0],desc=cells[cells.length-1];
    const category=stack.filter(x=>x.c<rego.c).map(x=>x.v).join(' – ');
    const m=desc.v.match(/^([A-Z]{1,5}\d{2,4}[A-Z]?)(?![A-Za-z0-9])\s*[-–:]?\s*(.*)$/i);
    const code=m?m[1].toUpperCase():'';
    out.push({row:ri+1,rego:rego.v.toUpperCase(),code,name:code||rego.v.toUpperCase(),desc:(m?m[2]:desc.v).trim()||desc.v,full:desc.v,category,
      retired:/no longer in use|retired|\bsold\b|written off/i.test(desc.v)});
  });
  return out;
}
/* ---------- export the machine list (a table that Import from Excel reads back) ---------- */
async function buildMachinesWorkbook(data){
  const ExcelJS=await loadExcelJS();const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Machines',{views:[{state:'frozen',ySplit:3}]});
  ws.columns=[{width:30},{width:13},{width:44},{width:12},{width:20},{width:10}];
  const dark='FF3A3A3A',red='FF9B0A1E',grey='FFF1F1F4',line={style:'thin',color:{argb:'FFBFBFBF'}};
  ws.mergeCells('A1:F1');const t=ws.getCell('A1');t.value='Machine list';t.font={bold:true,size:14};
  ws.mergeCells('A2:F2');const st=ws.getCell('A2');const n=new Date();st.value=`Exported ${n.getDate()} ${MONTHS_LONG[n.getMonth()]} ${n.getFullYear()}`;st.font={size:9,color:{argb:'FF777777'}};
  const h=ws.getRow(3);h.values=['Category','Machine #','Description','Rego','Crew','On board'];
  h.eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:dark}};c.border={top:line,bottom:line,left:line,right:line};c.alignment={vertical:'middle'}});h.height=18;
  const machines=data.resources.filter(r=>r.type==='machine');
  groupMachines(machines,data).forEach(g=>{
    const gr=ws.addRow([g.label,'','','','','']);ws.mergeCells(`A${gr.number}:F${gr.number}`);
    gr.getCell(1).font={bold:true,color:{argb:'FFFFFFFF'}};gr.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:red}};gr.getCell(1).value=`${g.label}  (${g.rows.length})`;
    g.rows.forEach((m,i)=>{const crew=data.resources.find(c=>c.id===m.crewId);
      const r=ws.addRow([machCatOf(m)||'',m.name,m.sub||'',m.rego||'',crew?crew.name:'',m.visible===false?'Hidden':'Yes']);
      r.eachCell({includeEmpty:true},c=>{c.border={top:line,bottom:line,left:line,right:line};if(i%2)c.fill={type:'pattern',pattern:'solid',fgColor:{argb:grey}}});
      r.getCell(2).font={bold:true};r.getCell(4).font={name:'Consolas'};r.getCell(1).font={color:{argb:'FF777777'}}});
  });
  ws.pageSetup={orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.4,right:.4,top:.5,bottom:.5,header:.2,footer:.2},printTitlesRow:'3:3'};
  const buf=await wb.xlsx.writeBuffer();
  return new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
async function exportMachines(data,notify){
  try{const dl=window.claude&&window.claude.use?await window.claude.use('downloads'):null;
    if(!dl){notify('Saving files isn’t available in this view.');return}
    const blob=await buildMachinesWorkbook(data);const n=new Date();
    await dl.save({filename:`Machine list ${pad(n.getDate())}.${pad(n.getMonth()+1)}.${n.getFullYear()}.xlsx`,data:blob});notify('Machine list saved');
  }catch(e){const c=e&&e.code;notify(c==='declined'?'Download cancelled.':c==='rate_limited'?'A save prompt is already open.':(e&&e.message)||'The machine list could not be exported.')}
}
async function readFleetFile(file){
  const XLSX=await loadSheetJS();const buf=await file.arrayBuffer();
  const wb=XLSX.read(buf,{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];
  return parseFleetRows(XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false,blankrows:false}));
}
const machineMatch=(resources,x)=>resources.findIndex(r=>r.type==='machine'&&((x.rego&&(r.rego||'').toUpperCase()===x.rego)||(r.name||'').toLowerCase()===x.name.toLowerCase()));
function applyMachineImport(d,list){
  const res=[...d.resources];let added=0,updated=0;
  list.forEach(x=>{const i=machineMatch(res,x);const p={name:x.name,sub:x.desc,rego:x.rego,category:x.category};
    if(i>=0){res[i]={...res[i],...p};updated++}
    else{res.push({id:'m'+uid(),type:'machine',...p,crewId:null,hue:HUES[res.length%HUES.length],visible:true});added++}});
  const cats=[...(d.machineCats||[])];list.forEach(x=>{if(x.category&&!cats.some(c=>c.toLowerCase()===x.category.toLowerCase()))cats.push(x.category)});
  return {data:{...d,resources:res,machineCats:cats},added,updated};
}
function MachineImport({data,setData,onClose,notify}){
  const [rows,setRows]=useState(null);const [off,setOff]=useState({});const [err,setErr]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{const h=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);
  const pick=async e=>{const file=e.target.files&&e.target.files[0];if(!file)return;setBusy(true);setErr('');
    try{const r=await readFleetFile(file);if(!r.length)throw new Error('No machines found in that file.');
      setRows(r);const o={};r.forEach((x,i)=>{if(x.retired)o[i]=true});setOff(o)}
    catch(x){setErr(x.message||'Couldn’t read that file.')}finally{setBusy(false);e.target.value=''}};
  const chosen=(rows||[]).filter((_,i)=>!off[i]);
  const groups=[];(rows||[]).forEach((x,i)=>{let g=groups.find(y=>y.cat===x.category);if(!g){g={cat:x.category,items:[]};groups.push(g)}g.items.push({x,i})});
  const run=()=>{setData(d=>{const r=applyMachineImport(d,chosen);setTimeout(()=>notify(`Machines imported: ${r.added} new, ${r.updated} updated`),0);return r.data});onClose()};
  const setGroup=(g,on)=>setOff(o=>{const n={...o};g.items.forEach(({i})=>{n[i]=!on});return n});
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class=${'panel pop w-full flex flex-col max-h-full overflow-hidden '+(rows?'max-w-[720px]':'max-w-[460px]')} role="dialog" aria-modal="true" aria-labelledby="mi-title">
      <div class="px-5 pt-5 pb-3 border-b border-line flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div id="mi-title" class="font-display text-[18px] font-semibold">Import machines</div>
          <div class="text-[12.5px] text-muted">${rows?'Check the list, then import. Machines already in the planner (same rego or machine #) are updated, not doubled up.':'Upload the fleet list (.xls or .xlsx): category headings, then each machine’s rego and description.'}</div>
        </div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
      </div>
      ${!rows
        ?html`<div class="p-5 grid gap-3">
            <label class="grid gap-2 place-items-center text-center rounded-xl border-2 border-dashed border-line px-4 py-8 cursor-pointer hover:bg-sunken">
              <span class="font-medium">${busy?'Reading…':'Choose the machine list'}</span>
              <span class="text-[12px] text-muted">Excel .xls, .xlsx or .csv</span>
              <input id="mi-file" type="file" accept=".xls,.xlsx,.csv" class="sr-only" onChange=${pick} disabled=${busy}/>
            </label>
            ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</div>`}
          </div>`
        :html`<div class="overflow-y-auto px-3 py-2">
            ${groups.map(g=>{const on=g.items.filter(({i})=>!off[i]).length;
              return html`<div key=${g.cat||'-'} class="mb-2">
                <div class="flex items-center gap-2 px-2 pt-2 pb-1">
                  <input type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${on===g.items.length} onChange=${e=>setGroup(g,e.target.checked)} aria-label=${'All of '+(g.cat||'No category')}/>
                  <span class="label" style=${{color:'var(--ink)'}}>${g.cat||'No category'}</span><span class="mono text-[11px] text-faint">${on}/${g.items.length}</span><span class="flex-1 h-px bg-line"></span></div>
                ${g.items.map(({x,i})=>{const ex=machineMatch(data.resources,x)>=0;
                  return html`<label key=${i} class="flex items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer hover:bg-sunken">
                    <input type="checkbox" class="w-4 h-4 shrink-0" style=${{accentColor:'var(--accent)'}} checked=${!off[i]} onChange=${e=>setOff(o=>({...o,[i]:!e.target.checked}))}/>
                    <span class="mono text-[12.5px] font-semibold w-[76px] shrink-0">${x.name}</span>
                    <span class="text-[12.5px] min-w-0 flex-1 truncate">${x.desc}</span>
                    <span class="mono text-[11.5px] text-muted shrink-0">${x.rego}</span>
                    <span class=${'text-[10.5px] font-semibold px-1.5 py-0.5 rounded shrink-0 '+(ex?'bg-sunken text-muted':'')} style=${ex?null:{background:'var(--accent-soft)',color:'var(--accent)'}}>${x.retired?'Not in use':ex?'Update':'New'}</span>
                  </label>`})}
              </div>`})}
          </div>
          <div class="px-5 py-3 border-t border-line flex items-center gap-2">
            <span class="text-[12px] text-muted mr-auto">${chosen.length} of ${rows.length} selected · ${groups.length} categor${groups.length===1?'y':'ies'}</span>
            <button type="button" class="btn" onClick=${()=>setRows(null)}>Choose another file</button>
            <button type="button" class="btn btn-primary" disabled=${!chosen.length} onClick=${run}>Import ${chosen.length}</button>
          </div>`}
    </div>
  </div>`;
}

/* =====================================================================
   Planning: the supervisor's site inspection and job methodology.
   A plan holds the site details, map pins, shift-by-shift asphalt and profiling,
   machines, trucking, subcontractors and safety. "Send to schedule" turns it into
   (or updates) the crew booking: dates, quantities per shift, machines, subcontractors.
   ===================================================================== */
const PLAN_PPE=['Hi-vis (day/night)','Steel cap boots','Long sleeves & pants','Wide brim hat','Sunscreen','Safety glasses','Gloves','Hearing protection','2-way radios (UHF)','Head lamps (nights)'];
const PLAN_TRUCK_TYPES=['Walking Floor','Body Truck'];
const PLAN_STEPS=['Put environmental protection out before profiler starts','Communicate with traffic control for all truck and plant movements',
  'Bring out sand for clean-up','Use watercart to wet down base and minimise dust','Use water at the end to help with clean-up',
  'Use straight edge on all joins to ensure transitions are correct','Use a 50mm block to mark out the ramp to be cut by the profiler',
  'Cut out ramps from last night’s work to the numbers on the ground','Tack coat before paving'];
const PLAN_HAZARDS=[
  {hazard:'Open trenches / uneven ground',control:'Exclusion zones, watch your step, paint ramps'},
  {hazard:'Slips, trips and falls',control:'Keep work area clear, good housekeeping'},
  {hazard:'Open drains and pits',control:'Cover pits with environmental covers; enviro trailer on site'},
  {hazard:'Sediment control',control:'Environmental protection out before profiling starts'},
  {hazard:'Lighting (night works)',control:'Light towers for night works, head lamps for the crew'},
  {hazard:'Traffic',control:'Traffic control to set out the job to the TGS and control trucks entering and leaving site'},
  {hazard:'Trucks and plant movements',control:'Spotters to communicate with trucks once on site'}];
const PIN_TYPES=[
  {id:'site',label:'Job location',color:'#9b0a1e'},
  {id:'access',label:'Site access',color:'#26548c'},
  {id:'float',label:'Float gear to / drop-off',color:'#407034'},
  {id:'dump',label:'Dump site',color:'#966014'},
  {id:'meet',label:'Truck meeting point',color:'#603c82'},
  {id:'other',label:'Other',color:'#3a3a3a'}];
const pinType=id=>PIN_TYPES.find(t=>t.id===id)||PIN_TYPES[PIN_TYPES.length-1];
const gmapsLink=p=>`https://www.google.com/maps/search/?api=1&query=${(+p.lat).toFixed(6)},${(+p.lng).toFixed(6)}`;
/* coordinates from a Google Maps link or typed "lat, lng" (short maps.app.goo.gl links can't be read: open them and copy the long link) */
function parseLatLng(s){
  s=String(s||'').trim();let m=s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)||s.match(/[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i)
    ||s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)||s.match(/^\s*(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\s*$/);
  if(!m)return null;const lat=+m[1],lng=+m[2];return Math.abs(lat)<=90&&Math.abs(lng)<=180?{lat,lng}:null;
}
const plansOf=d=>(d&&d.plans)||[];
/* trucking is set per shift (plans made before then had one setting for the whole job) */
const spTruck=(p,sp)=>(sp&&sp.trucking)||(p&&p.trucking)||{};
const spRounds=(p,sp)=>{const tr=spTruck(p,sp);const pr=num(tr.perRound);const st=((sp&&sp.lines)||[]).reduce((a,l)=>a+(lineHas(l)?planTonnes(l):0),0);return pr&&st?Math.ceil(st/pr*10)/10:0};
/* pictures for a shift: stored on their own (planImgs), shrunk to keep the roster light */
const planImgsOf=d=>(d&&d.planImgs)||[];
/* keep the plan where it is while a picture is being added (the file picker and the save would otherwise jump it) */
const holdPlanScroll=()=>{const el=document.getElementById('pl-scroll');const top=el?el.scrollTop:0,wy=window.scrollY;let n=0;
  const tick=()=>{const e=document.getElementById('pl-scroll');if(e&&Math.abs(e.scrollTop-top)>2)e.scrollTop=top;if(Math.abs(window.scrollY-wy)>2)window.scrollTo(0,wy);if(++n<30)requestAnimationFrame(tick)};requestAnimationFrame(tick)};
/* seal crew per shift: {on, onSite, area, type, binder} (older plans had one "product" box, read as the seal type); booked for the seal section's AFA crew unless another is picked */
const spSeal=sp=>!!(sp&&sp.seal&&sp.seal.on);
const sealCrewsOf=d=>d.resources.filter(isSealCrew);
const sealCrewDefault=d=>{const cs=sealCrewsOf(d);return cs.find(c=>/\bafa\b/i.test(c.name))||cs[0]||null};
const planSealCrew=(d,p)=>d.resources.find(r=>r.id===p.sealCrewId&&isSealCrew(r))||sealCrewDefault(d);
const slType=sl=>((sl&&(sl.type??sl.product))||'').trim();
const sealDefBinder=(d,t)=>{const m=sealBinderOf(d);t=(t||'').trim().toLowerCase();const k=Object.keys(m).find(x=>x.toLowerCase()===t);return k?m[k]:''};
const sealText=(sl,pm)=>[num(sl.area)?`${fmtN(num(sl.area))} m²`:'',[slType(sl),(sl.binder||'').trim()].filter(Boolean).join(' · '),sl.onSite?`on site ${fmtTime(sl.onSite)}`:''].filter(Boolean).join(' · ');
/* quick-add subcontractor buttons in a plan, each with an optional default supplier */
const PLAN_QUICK_DEFAULT=['2m profiler','1m profiler','350 profiler','Full service bobcat','Traffic control','Lighting towers'].map(label=>({label,supplier:''}));
const planQuickOf=d=>d&&Array.isArray(d.planQuick)?d.planQuick:PLAN_QUICK_DEFAULT;
/* quick-add steps for each shift's method / notes (edited in the plan, used on every plan) */
const planStepsOf=d=>d&&Array.isArray(d.planSteps)?d.planSteps:PLAN_STEPS;
/* profiling is ticked per shift; older plans had one tick for the whole job, used until a shift is set */
const spProf=(p,sp)=>!!(sp&&sp.profiling!=null?sp.profiling:p&&p.profiling);
function shrinkImage(file){return new Promise((res,rej)=>{const url=URL.createObjectURL(file);const im=new Image();
  im.onload=()=>{try{const max=1400;let w=im.naturalWidth,h=im.naturalHeight;const k=Math.min(1,max/Math.max(w,h));w=Math.round(w*k);h=Math.round(h*k);
    const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,w,h);g.drawImage(im,0,0,w,h);
    let q=.78,out=c.toDataURL('image/jpeg',q);while(out.length>650000&&q>.35){q-=.1;out=c.toDataURL('image/jpeg',q)}
    URL.revokeObjectURL(url);res({data:out,w,h})}catch(e){rej(e)}};
  im.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('That file isn’t a picture this browser can read.'))};im.src=url})}
const planTonnes=l=>{if(filledNum(l.tonnes)&&l._tManual)return num(l.tonnes);const a=num(l.area),dp=num(l.depth);return a&&dp?Math.round(a*dp/1000*DEFAULT_DENSITY*2)/2:num(l.tonnes)};
const planBlock=p=>({start:p.start,end:p.start,shift:p.shift||'day',...(p.fri!==undefined?{friShift:!!p.fri}:{}),...(p.sat!==undefined?{satShift:!!p.sat}:{}),...(p.sun!==undefined?{sunShift:!!p.sun}:{})});
/* the plan's booking on the schedule: its start date, crew, day/night and weekend ticks are the plan's */
const planBooking=(d,p)=>d&&p&&p.bookingId?d.blocks.find(b=>b.id===p.bookingId)||null:null;
function planDates(p,d){
  const bk=planBooking(d,p);if(bk)return shiftDates(bk);
  if(!p||!p.start||!(num(p.shifts)>0))return [];const pb=planBlock(p);const out=[];let x=parse(p.start);
  for(let g=0;out.length<num(p.shifts)&&g<400;g++){if(worksOn(pb,x))out.push(iso(x));x=addDays(x,1)}
  return out;
}
const planFor=(d,b)=>b&&(plansOf(d).find(p=>p.id===b.planId)||plansOf(d).find(p=>p.bookingId&&p.bookingId===b.id))||null;
/* changing the number of shifts in the plan moves the booking's end date */
function setBookingShifts(d,bookingId,n){const bk=d.blocks.find(b=>b.id===bookingId);if(!bk||!(n>0))return d;let x=parse(bk.start),c=0,end=bk.start;
  for(let g=0;g<400;g++){if(worksOn(bk,x)){c++;end=iso(x);if(c>=n)break}x=addDays(x,1)}
  return end===bk.end?d:{...d,blocks:d.blocks.map(b=>b.id===bookingId?{...b,end}:b)}}
function newPlan(d){
  return {id:'p'+uid(),title:'',status:'draft',bookingId:'',uhf:'',induction:false,supply:'AFA',
    ppe:['Hi-vis (day/night)','Steel cap boots','2-way radios (UHF)'],pins:[],sections:[],shiftPlans:[],jobSubs:[],machineIds:[],
    seal:{},
    hazards:PLAN_HAZARDS.map(h=>({...h})),createdAt:Date.now(),...(window.__rosterMe?{createdBy:window.__rosterMe}:{})};
}
/* what's in the way: machines on other jobs or down, and the crew already booked, on the plan's dates */
function planConflicts(d,p){
  const dates=planDates(p,d);if(!dates.length)return {machines:{},crew:[]};
  const has=b=>dates.some(k=>k>=b.start&&k<=b.end);const machines={};
  (p.machineIds||[]).forEach(id=>{const list=[];
    d.blocks.forEach(b=>{if(b.id===p.bookingId||!has(b))return;
      if(b.kind==='job'&&(b.plantIds||[]).includes(id)){const c=d.resources.find(r=>r.id===b.resourceId);const j=d.jobs.find(x=>x.id===b.jobId);list.push(`On ${c?c.name:'another crew'}'s job${j?` (${j.name})`:''}, ${fmtShort(parse(b.start))}${b.end!==b.start?'–'+fmtShort(parse(b.end)):''}`)}
      else if(b.resourceId===id&&KINDS[b.kind]&&KINDS[b.kind].down)list.push(`${b.title||KINDS[b.kind].label}, ${fmtShort(parse(b.start))}${b.end!==b.start?'–'+fmtShort(parse(b.end)):''}`)});
    /* other plans that want the same machine on the same dates (not on the schedule yet) */
    plansOf(d).forEach(o=>{if(o.id===p.id||o.status==='scheduled'||!(o.machineIds||[]).includes(id))return;const od=planDates(o,d);
      if(od.some(k=>dates.includes(k)))list.push(`Also planned for ${o.title||o.jobName||'another plan'} (${fmtShort(parse(od[0]))}${od.length>1?'–'+fmtShort(parse(od[od.length-1])):''})`)});
    if(list.length)machines[id]=list});
  const bkc=planBooking(d,p);const crewId=bkc?bkc.resourceId:p.crewId;
  const crew=crewId?d.blocks.filter(b=>b.resourceId===crewId&&b.id!==p.bookingId&&has(b)).map(b=>{const j=d.jobs.find(x=>x.id===b.jobId);return `${b.kind==='job'?(j?jobLabel(j):'Job'):(b.title||KINDS[b.kind].label)}, ${fmtShort(parse(b.start))}${b.end!==b.start?'–'+fmtShort(parse(b.end)):''}`}):[];
  return {machines,crew};
}
/* what sending the plan will do to seal bookings, so it can be checked first:
   new = book the seal crew; update = this plan's own seal booking for that day; existing = a seal booking for this job is
   already on the schedule that day (kept, no double-up, plan details only fill its empty fields); remove = this plan booked it before but the shift no longer needs the seal crew */
function sealPlanOf(d,p){
  const old=planBooking(d,p);if(!old)return {items:[],removes:[],crew:null};
  const want=shiftDates(old).map((k,i)=>({k,sl:((p.shiftPlans||[])[i]||{}).seal})).filter(x=>x.sl&&x.sl.on);
  const crew=want.length?planSealCrew(d,p):null;
  const own=d.blocks.filter(x=>x.planSealOf===p.id);
  const others=d.blocks.filter(x=>x.kind==='job'&&x.jobId===old.jobId&&x.planSealOf!==p.id&&isSealCrew(d.resources.find(r=>r.id===x.resourceId)));
  const items=want.map(({k,sl})=>{const mine=own.find(x=>x.start===k);
    const other=others.find(x=>x.start<=k&&x.end>=k&&worksOn(x,parse(k)));
    const busy=crew?d.blocks.filter(x=>x.resourceId===crew.id&&x.start<=k&&x.end>=k&&x.jobId!==old.jobId&&x.kind==='job'&&worksOn(x,parse(k))).map(x=>(d.jobs.find(j=>j.id===x.jobId)||{}).name||'another job'):[];
    if(other&&!mine)return {k,sl,act:'existing',b:other,busy};
    return {k,sl,act:mine?'update':'new',b:mine||null,busy,dupe:mine&&other?other:null}});
  return {items,removes:own.filter(x=>!want.some(w=>w.k===x.start)),crew};
}
/* turn the plan into the crew booking (creating the job if needed) */
function applyPlan(d,p){
  const old=planBooking(d,p);if(!old)return {data:d,err:'Pick the job from the schedule first.'};
  const dates=shiftDates(old);const sd={...(old.shiftData||{})};
  dates.forEach((k,i)=>{const sp=(p.shiftPlans||[])[i]||{};const q=sd[k]||{};
    const lines=(sp.lines||[]).filter(lineHas).map(l=>{const {_tManual,...r}=l;return cleanLine({...r,tonnes:planTonnes(l)})});
    const subs=[...(p.jobSubs||[]),...(sp.subs||[])].filter(subHas).map(s=>({name:(s.name||'').trim(),info:(s.info||'').trim(),time:s.time||p.crewOnSite||''}));
    sd[k]={...q,lines:lines.length?lines:linesOnly(q),...(subs.length?{subs}:{}),...(p.crewOnSite?{start:p.crewOnSite}:{})}});
  const b={...old,plantIds:[...(p.machineIds||[])],shiftData:sd,planId:p.id,...((p.address||'').trim()?{address:p.address.trim()}:{})};
  [['quoteNo',p.quoteNo],['projectNo',p.projectNo],['supervisor',p.supervisor],['supervisorPhone',p.supervisorPhone]].forEach(([k,v])=>{v=(v||'').trim();if(v)b[k]=v});
  if(p.induction&&!b.inductionReq)b.inductionReq=true;   /* the plan says a site induction is needed: flag it on the booking */
  let blocks=d.blocks.map(x=>x.id===old.id?b:x);
  /* seal crew shifts: a one-shift booking for each shift that needs the seal crew (updated, not duplicated, when sent again) */
  const sp0=sealPlanOf(d,p);const sc=sp0.crew;let sealN=0,sealKept=0;
  if(sp0.items.length&&!sc)return {data:d,err:'No seal crew to book. Add a crew in the Seal section first.'};
  const rm=new Set(sp0.removes.map(x=>x.id));blocks=blocks.filter(x=>!rm.has(x.id));
  sp0.items.forEach(({k,sl,act,b:ex})=>{const q=(ex&&ex.shiftData&&ex.shiftData[k])||{};
    const line=slType(sl)||(sl.binder||'').trim()||num(sl.area)?[cleanLine({type:slType(sl),binder:(sl.binder||'').trim(),area:sl.area,twoCoat:sealIsTwoCoat(d,slType(sl))})]:null;
    if(act==='existing'){   /* already booked: no second booking, just fill what's empty on that day */
      const nq={...q};if(line&&!linesOf(q).some(lineHas))nq.lines=line;if(sl.onSite&&!q.start)nq.start=sl.onSite;
      blocks=blocks.map(x=>x.id===ex.id?{...x,shiftData:{...(x.shiftData||{}),[k]:nq}}:x);sealKept++;return}
    const nb={...(ex||{id:uid(),kind:'job',title:'',plantIds:[]}),resourceId:sc.id,jobId:old.jobId,start:k,end:k,shift:old.shift||'day',planSealOf:p.id,planId:p.id,
      weekendShifts:true,satShift:true,sunShift:true,friShift:true,shiftData:{[k]:{...q,...(line?{lines:line}:{}),...(sl.onSite?{start:sl.onSite}:{})}}};
    ['address','quoteNo','projectNo','supervisor','supervisorPhone'].forEach(f=>{if(b[f])nb[f]=b[f]});if(p.induction&&!nb.inductionReq)nb.inductionReq=true;
    if(ex)blocks=blocks.map(x=>x.id===ex.id?nb:x);else blocks=[...blocks,nb];sealN++});
  const plans=plansOf(d).map(x=>x.id===p.id?{...p,jobId:old.jobId,status:'scheduled',appliedAt:Date.now()}:x);
  return {data:{...d,blocks,plans},bookingId:b.id,created:false,sealN,sealKept,sealCrew:sc&&sc.name};
}

/* ---------- map with pins (Leaflet + OpenStreetMap / satellite tiles) ---------- */
function loadLeaflet(){
  if(window.L&&window.L.map)return Promise.resolve(window.L);
  return new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
    s.onload=()=>window.L?res(window.L):rej(new Error('Map library missing'));s.onerror=()=>rej(new Error('Could not load the map'));document.head.appendChild(s)});
}
const pinIcon=(L,p)=>L.divIcon({className:'afa-pin',iconSize:[26,34],iconAnchor:[13,32],tooltipAnchor:[0,-30],
  html:`<svg width="26" height="34" viewBox="0 0 26 34"><path d="M13 33c-1-3.6-11-12.8-11-20A11 11 0 0 1 24 13c0 7.2-10 16.4-11 20z" fill="${pinType(p.type).color}" stroke="#fff" stroke-width="2"/><circle cx="13" cy="13" r="4" fill="#fff"/></svg>`});
function PlanMap({pins,onChange,readOnly,height=360}){
  const box=useRef(null),mapRef=useRef(null),layer=useRef(null),tiles=useRef({});
  const [err,setErr]=useState('');const [tileErr,setTileErr]=useState(false);const [addType,setAddType]=useState('site');const [sat,setSat]=useState(false);
  const [q,setQ]=useState('');const [searching,setSearching]=useState(false);const [paste,setPaste]=useState('');
  const pinsRef=useRef(pins);pinsRef.current=pins;const addRef=useRef(addType);addRef.current=addType;
  useEffect(()=>{let gone=false;loadLeaflet().then(L=>{if(gone||!box.current||mapRef.current)return;
      const first=(pins||[])[0];const m=L.map(box.current,{zoomControl:true,attributionControl:true}).setView(first?[first.lat,first.lng]:[-27.25,153.0],first?16:10);
      const street=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'});
      const imagery=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Imagery &copy; Esri'});
      [street,imagery].forEach(t=>t.on('tileerror',()=>setTileErr(true)));
      tiles.current={street,imagery};street.addTo(m);layer.current=L.layerGroup().addTo(m);mapRef.current=m;
      if(!readOnly)m.on('click',e=>{const t=addRef.current;const n={id:'pin'+uid(),type:t,label:pinType(t).label,lat:+e.latlng.lat.toFixed(6),lng:+e.latlng.lng.toFixed(6)};onChangeRef.current([...(pinsRef.current||[]),n])});
      draw();setTimeout(()=>m.invalidateSize(),60);
    }).catch(e=>setErr(e.message||'The map could not load.'));
    return()=>{gone=true;if(mapRef.current){mapRef.current.remove();mapRef.current=null}}},[]);
  const onChangeRef=useRef(onChange);onChangeRef.current=onChange;
  const draw=()=>{const L=window.L;const g=layer.current;if(!L||!g)return;g.clearLayers();
    (pinsRef.current||[]).forEach(p=>{if(!isFinite(+p.lat)||!isFinite(+p.lng))return;
      const mk=L.marker([+p.lat,+p.lng],{icon:pinIcon(L,p),draggable:!readOnly,title:p.label||pinType(p.type).label});
      mk.bindTooltip(p.label||pinType(p.type).label,{direction:'top',permanent:true,className:'afa-pin-label'});
      if(!readOnly)mk.on('dragend',()=>{const ll=mk.getLatLng();onChangeRef.current((pinsRef.current||[]).map(x=>x.id===p.id?{...x,lat:+ll.lat.toFixed(6),lng:+ll.lng.toFixed(6)}:x))});
      g.addLayer(mk)})};
  useEffect(draw,[pins]);
  useEffect(()=>{const m=mapRef.current,t=tiles.current;if(!m||!t.street)return;if(sat){m.removeLayer(t.street);t.imagery.addTo(m)}else{m.removeLayer(t.imagery);t.street.addTo(m)}},[sat]);
  const fit=()=>{const m=mapRef.current,L=window.L;const ps=(pins||[]).filter(p=>isFinite(+p.lat));if(!m||!ps.length)return;
    if(ps.length===1)m.setView([+ps[0].lat,+ps[0].lng],17);else m.fitBounds(L.latLngBounds(ps.map(p=>[+p.lat,+p.lng])),{padding:[40,40]})};
  const search=async()=>{const v=q.trim();if(!v)return;const ll=parseLatLng(v);if(ll&&mapRef.current){mapRef.current.setView([ll.lat,ll.lng],17);return}
    setSearching(true);setErr('');
    try{const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(v)}`,{headers:{'Accept':'application/json'}});
      const j=await r.json();if(j&&j[0]&&mapRef.current)mapRef.current.setView([+j[0].lat,+j[0].lon],17);else setErr('Address not found. Try a nearby street or suburb.')}
    catch(e){setErr('Address search isn’t available here. Zoom the map by hand, or paste a Google Maps link below.')}finally{setSearching(false)}};
  const addPasted=()=>{const ll=parseLatLng(paste);if(!ll){setErr(/goo\.gl|maps\.app/.test(paste)?'Short Google links can’t be read. Open the link, then copy the long address from the browser bar (it has @-27.2…,153.0… in it).':'No coordinates found. Paste a Google Maps link or type "lat, lng".');return}
    setErr('');onChange([...(pins||[]),{id:'pin'+uid(),type:addType,label:pinType(addType).label,...ll}]);setPaste('');if(mapRef.current)mapRef.current.setView([ll.lat,ll.lng],17)};
  const setPin=(id,p)=>onChange((pins||[]).map(x=>x.id===id?{...x,...p}:x));
  const fs={height:30,fontSize:13};
  return html`<div class="grid gap-2">
    ${!readOnly&&html`<div class="flex flex-wrap items-center gap-2">
      <span class="flex-1 min-w-[200px]"><input id="map-q" class="field field-sm" style=${fs} placeholder="Find an address, or paste coordinates" value=${q} onInput=${e=>setQ(e.target.value)}
        onKeyDown=${e=>{if(e.key==='Enter'){e.preventDefault();search()}}} aria-label="Find an address on the map"/></span>
      <button type="button" class="btn" style=${{height:30}} onClick=${search} disabled=${searching||!q.trim()}>${searching?'Finding…':'Find'}</button>
      <span class="text-[12px] text-muted ml-2">Click the map to drop a</span>
      <select id="map-type" class="field field-sm w-auto" style=${{height:30,fontSize:12.5}} value=${addType} onChange=${e=>setAddType(e.target.value)} aria-label="Type of pin to drop">
        ${PIN_TYPES.map(t=>html`<option key=${t.id} value=${t.id}>${t.label}</option>`)}</select>
    </div>`}
    <div class="relative rounded-lg border border-line overflow-hidden" style=${{height}}>
      <div ref=${box} class="absolute inset-0" style=${{background:'var(--sunken)'}}></div>
      <div class="absolute right-2 top-2 z-[1000] flex gap-1">
        <button type="button" class="btn bg-surface" style=${{height:28,fontSize:12}} onClick=${()=>setSat(s=>!s)}>${sat?'Street map':'Satellite'}</button>
        ${(pins||[]).length>0&&html`<button type="button" class="btn bg-surface" style=${{height:28,fontSize:12}} onClick=${fit}>Show all pins</button>`}
      </div>
      ${tileErr&&html`<div class="absolute left-2 bottom-6 right-2 z-[1000] text-[11.5px] px-2 py-1 rounded bg-surface border border-line text-muted">Some map tiles didn’t load here. Pins and their Google Maps links still work.</div>`}
    </div>
    ${err&&html`<div class="text-[12.5px]" style=${{color:'var(--warn)'}}>${err}</div>`}
    ${!readOnly&&html`<div class="flex flex-wrap items-center gap-2">
      <span class="flex-1 min-w-[220px]"><input id="map-paste" class="field field-sm" style=${fs} placeholder="…or paste a Google Maps link to drop a pin there" value=${paste} onInput=${e=>setPaste(e.target.value)}
        onKeyDown=${e=>{if(e.key==='Enter'){e.preventDefault();addPasted()}}} aria-label="Google Maps link"/></span>
      <button type="button" class="btn" style=${{height:30}} onClick=${addPasted} disabled=${!paste.trim()}>Add pin</button>
    </div>`}
    ${(pins||[]).length>0&&html`<ul class="grid gap-1.5">
      ${pins.map(p=>html`<li key=${p.id} class="flex flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1.5">
        <span class="w-3 h-3 rounded-full shrink-0" style=${{background:pinType(p.type).color}}></span>
        ${readOnly?html`<span class="text-[13px] font-medium">${p.label||pinType(p.type).label}</span><span class="text-[12px] text-muted">${pinType(p.type).label}</span>`
          :html`<select class="field field-sm w-auto" style=${{height:28,fontSize:12}} value=${p.type} onChange=${e=>setPin(p.id,{type:e.target.value})} aria-label="Pin type">
              ${PIN_TYPES.map(t=>html`<option key=${t.id} value=${t.id}>${t.label}</option>`)}</select>
            <span class="flex-1 min-w-[140px]"><input class="field field-sm" style=${{height:28,fontSize:12.5}} value=${p.label||''} placeholder="Label" onInput=${e=>setPin(p.id,{label:e.target.value})} aria-label="Pin label"/></span>`}
        <span class="mono text-[11px] text-faint">${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)}</span>
        <a class="text-[12px] font-medium underline underline-offset-2" style=${{color:'var(--accent)'}} href=${gmapsLink(p)} target="_blank" rel="noopener">Google Maps</a>
        ${!readOnly&&html`<button type="button" class="w-6 h-6 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>onChange(pins.filter(x=>x.id!==p.id))} aria-label=${'Remove pin '+(p.label||'')}>${Icon.x}</button>`}
      </li>`)}</ul>`}
  </div>`;
}

/* ---------- the plan form ---------- */
function PlanCard({id,title,sub,children,right}){
  return html`<section id=${id} class="panel p-4 grid gap-3 scroll-mt-4" aria-labelledby=${id+'-t'}>
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h3 id=${id+'-t'} class="font-display text-[15px] font-semibold">${title}</h3>${sub&&html`<span class="text-[12px] text-muted">${sub}</span>`}<span class="flex-1"></span>${right}</div>
    ${children}
  </section>`;
}
function PlanForm({plan,data,save,onDelete,onSchedule,onPdf,onOpenBooking,onShifts,onAddImg,onDelImg,onQuick,onSteps}){
  const [p,setP]=useState(plan);const dirty=useRef(false);const pRef=useRef(p);pRef.current=p;
  const [editPast,setEditPast]=useState(false);   /* shifts before today are locked unless this is ticked */
  const [quickSetup,setQuickSetup]=useState(false);
  const [stepsSetup,setStepsSetup]=useState(null);
  const [delImg,setDelImg]=useState(null);   /* picture waiting for "Remove?" to be confirmed */   /* which shift's method quick-adds are being edited */   /* editing the quick-add buttons and their default suppliers */
  useEffect(()=>{setP(plan);dirty.current=false},[plan.id]);
  /* pick up changes made elsewhere (e.g. sent to the schedule) when nothing is waiting to save */
  useEffect(()=>{if(!dirty.current)setP(plan)},[plan]);
  /* autosave a second after the last change, and when leaving the plan */
  useEffect(()=>{if(!dirty.current)return;const t=setTimeout(()=>{save(pRef.current);dirty.current=false},900);return()=>clearTimeout(t)},[p]);
  useEffect(()=>()=>{if(dirty.current)save(pRef.current)},[plan.id]);
  /* seal crew is per shift now: older plans had one set of details for the whole job */
  useEffect(()=>{const sl=plan.seal||{};if(!(num(sl.sealArea)||num(sl.tackArea)||sl.onSite))return;
    set(x=>{const n=planDates(x,data).length;const arr=[...(x.shiftPlans||[])];while(arr.length<n)arr.push({lines:[{}]});
      return {seal:{},shiftPlans:arr.map(sp=>sp&&sp.seal?sp:{...(sp||{}),seal:{on:true,onSite:sl.onSite||'',area:num(sl.sealArea)||num(sl.tackArea)||''}})}})},[plan.id]);
  /* subcontractors are for the whole job now: move any added to a single shift (older plans) into the job list */
  useEffect(()=>{if(!(plan.shiftPlans||[]).some(sp=>(sp&&sp.subs||[]).some(subHas)))return;
    set(x=>{const js=[...(x.jobSubs||[])];const key=s=>[s.name,s.info,s.time].map(v=>(v||'').trim().toLowerCase()).join('|');
      (x.shiftPlans||[]).forEach(sp=>(sp&&sp.subs||[]).filter(subHas).forEach(s=>{if(!js.some(o=>key(o)===key(s)))js.push({...s})}));
      return {jobSubs:js,shiftPlans:(x.shiftPlans||[]).map(sp=>{if(!sp)return sp;const {subs,...r}=sp;return r})}})},[plan.id]);
  const set=patch=>{dirty.current=true;setP(x=>({...x,...(typeof patch==='function'?patch(x):patch),updatedAt:Date.now()}))};
  const bk=planBooking(data,p);
  const crew=bk?data.resources.find(c=>c.id===bk.resourceId):null;
  const seal=isSealCrew(crew);const job=bk?data.jobs.find(j=>j.id===bk.jobId):null;const night=bk?bk.shift==='night':p.shift==='night';
  const dates=planDates(p,data);const conf=planConflicts(data,p);
  /* jobs on the schedule that can be planned: crew job bookings from a fortnight ago on */
  const bookable=data.blocks.filter(b=>b.kind==='job'&&(b.end>=iso(addDays(TODAY,-14))||b.id===p.bookingId)).sort((a,c)=>a.start<c.start?-1:a.start>c.start?1:0);
  const bLabel=b=>{const j=data.jobs.find(x=>x.id===b.jobId);const c=data.resources.find(r=>r.id===b.resourceId);return `${j?jobLabel(j):'Job'} · ${c?c.name:''} · ${fmtShort(parse(b.start))}${b.end!==b.start?'–'+fmtShort(parse(b.end)):''}${b.shift==='night'?' (night)':''}`};
  const pickBooking=id=>{const b=data.blocks.find(x=>x.id===id);if(!b){set({bookingId:''});return}const j=data.jobs.find(x=>x.id===b.jobId)||{};
    set(x=>({bookingId:b.id,jobId:b.jobId,crewId:b.resourceId,title:x.title||j.name||'',jobName:j.name||'',customer:j.customer||'',address:x.address||b.address||j.address||'',
      quoteNo:x.quoteNo||b.quoteNo||'',projectNo:x.projectNo||b.projectNo||j.projectNo||'',supervisor:x.supervisor||b.supervisor||'',supervisorPhone:x.supervisorPhone||b.supervisorPhone||superPhoneOf(data,x.supervisor||b.supervisor)||'',
      machineIds:(x.machineIds||[]).length?x.machineIds:[...(b.plantIds||[])]}))};
  const fs={height:32,fontSize:13};const fsm={height:30,fontSize:13};
  /* crew start: the plan's on-site time, else the start time on the booking's first shift */
  const crewStart=p.crewOnSite||(bk&&dates[0]&&((bk.shiftData||{})[dates[0]]||{}).start)||'';
  const MIXES=seal?sealTypesOf(data):mixTypesOf(data);const BINDS=seal?sealBindersOf(data):bindersOf(data);
  const sps=dates.map((_,i)=>(p.shiftPlans||[])[i]||{lines:[{}]});
  const setSP=(i,patch)=>set(x=>{const arr=[...(x.shiftPlans||[])];while(arr.length<=i)arr.push({lines:[{}]});arr[i]={...arr[i],...patch};return {shiftPlans:arr}});
  const setLine=(i,j,patch)=>{const ls=[...(sps[i].lines||[{}])];ls[j]={...ls[j],...patch};setSP(i,{lines:ls})};
  const totals=new Map();sps.forEach(sp=>(sp.lines||[]).filter(lineHas).forEach(l=>{const k=mixLabel(l);const t=totals.get(k)||{t:0,a:0};t.t+=planTonnes(l);t.a+=num(l.area);totals.set(k,t)}));
  const totalT=[...totals.values()].reduce((a,v)=>a+v.t,0);
  const setTr=(i,patch)=>setSP(i,{trucking:{...spTruck(p,sps[i]),...patch}});
  const addPics=async(i,files)=>{for(const f of [...(files||[])]){try{const r=await shrinkImage(f);const img={id:'img'+uid(),planId:p.id,name:f.name||'',...r};holdPlanScroll();onAddImg(img);
      set(x=>{const arr=[...(x.shiftPlans||[])];while(arr.length<=i)arr.push({lines:[{}]});arr[i]={...arr[i],images:[...(arr[i].images||[]),img.id]};return {shiftPlans:arr}})}catch(e){alert(e.message||'Couldn’t add that picture.')}}};
  const toggleIn=(arr,v)=>arr.includes(v)?arr.filter(x=>x!==v):[...arr,v];
  const machines=data.resources.filter(r=>r.type==='machine');const picked=new Set(p.machineIds||[]);
  const subRow=(list,onList,prefix)=>html`<div class="grid gap-1.5">
    ${list.map((s,j)=>html`<div key=${j} class="grid gap-2 grid-cols-[1fr_1fr_28px] sm:grid-cols-[1.2fr_1.2fr_170px_28px] items-center">
      <${Combo} id=${`${prefix}-n${j}`} style=${fsm} placeholder="Subcontractor, e.g. BCM" value=${s.name||''} onChange=${v=>onList(list.map((x,k)=>k===j?{...x,name:v}:x))} label="Subcontractor" options=${subCosOf(data)}/>
      <${Combo} id=${`${prefix}-i${j}`} style=${fsm} placeholder="Service, e.g. 2m profiler" value=${s.info||''} onChange=${v=>onList(list.map((x,k)=>k===j?{...x,info:v}:x))} label="Service" options=${servicesFor(data,s.name)}/>
      <${TimeSelect} id=${`${prefix}-t${j}`} label="Start time" value=${s.time||''} pm=${night} onChange=${v=>onList(list.map((x,k)=>k===j?{...x,time:v}:x))}/>
      <button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>onList(list.filter((_,k)=>k!==j))} aria-label="Remove subcontractor">${Icon.x}</button>
    </div>`)}
    <div><button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>onList([...list,{time:crewStart}])}>${Icon.plus} Add subcontractor</button></div>
  </div>`;
  const nav=[['pl-site','Site'],['pl-map','Map'],['pl-shifts','Shifts'],['pl-machines','Machines'],['pl-subs','Subcontractors'],['pl-safety','Safety'],['pl-notes','Notes']];
  const machConf=Object.keys(conf.machines).length;
  return html`<div class="grid gap-3">
    <div class="panel px-4 py-3 grid gap-2 sticky top-0 z-10">
      <div class="flex flex-wrap items-center gap-2">
        <input id="pl-title" class="field font-display font-semibold flex-1 min-w-[220px]" style=${{height:36,fontSize:16}} placeholder="Plan name, e.g. Discovery Drive deep lift" value=${p.title||''} onInput=${e=>set({title:e.target.value})} aria-label="Plan name"/>
        <select id="pl-status" class="field field-sm w-auto" style=${fs} value=${p.status||'draft'} onChange=${e=>set({status:e.target.value})} aria-label="Status">
          <option value="draft">Draft</option><option value="ready">Ready to schedule</option><option value="scheduled">On the schedule</option></select>
        <button type="button" class="btn" onClick=${()=>{save(pRef.current);dirty.current=false;onPdf(pRef.current)}}>${Icon.download} Plan PDF</button>
        ${p.bookingId&&data.blocks.some(b=>b.id===p.bookingId)&&html`<button type="button" class="btn" onClick=${()=>{save(pRef.current);dirty.current=false;onOpenBooking(p.bookingId)}}>Open booking</button>`}
        <button type="button" class="btn btn-primary" disabled=${!bk} onClick=${()=>{save(pRef.current);dirty.current=false;onSchedule(pRef.current)}}>${p.appliedAt?'Update the schedule':'Send to schedule'}</button>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        ${nav.map(([h,l])=>html`<a key=${h} href=${'#'+h} class="text-muted hover:text-ink underline-offset-2 hover:underline" onClick=${e=>{e.preventDefault();const el=document.getElementById(h);if(el)el.scrollIntoView({behavior:'smooth',block:'start'})}}>${l}</a>`)}
        <span class="flex-1"></span>
        ${(machConf>0||conf.crew.length>0)&&html`<span class="font-semibold" style=${{color:'var(--warn)'}}>${[machConf&&`${machConf} machine${machConf===1?'':'s'} clash`,conf.crew.length&&'crew already booked'].filter(Boolean).join(' · ')}</span>`}
        <span class="text-faint">${p.appliedAt?`Sent to schedule ${agoText(p.appliedAt)}`:'Not on the schedule yet'}</span>
      </div>
    </div>

    <${PlanCard} id="pl-site" title="Job & site" sub="From the site inspection">
      <label class="grid gap-1"><span class="label">Job on the schedule</span>
        <select id="pl-booking" class="field" style=${fs} value=${p.bookingId||''} onChange=${e=>pickBooking(e.target.value)}>
          <option value="">Pick the job booking…</option>
          ${bookable.map(b=>{const other=plansOf(data).find(x=>x.id!==p.id&&x.bookingId===b.id);return html`<option key=${b.id} value=${b.id}>${bLabel(b)}${other?' — already has a plan':''}</option>`})}</select>
        <span class="text-[11.5px] text-faint">Add the job to the schedule first. Its start date, crew and day/night come from the booking and are changed in the schedule.</span></label>
      ${!bk?html`<div class="text-[13px] text-muted rounded-lg border border-dashed border-line px-3 py-4 text-center">Pick the job from the schedule to start planning it.</div>`:html`
      <div class="grid gap-3 sm:grid-cols-4 rounded-lg bg-sunken px-3 py-2.5">
        <div><div class="label">Crew</div><div class="text-[13.5px] font-semibold">${crew?crew.name:'—'}</div></div>
        <div><div class="label">Works</div><div class="text-[13.5px] font-semibold">${night?'Night':'Day'}</div></div>
        <div><div class="label">First shift</div><div class="text-[13.5px] font-semibold">${WD[parse(bk.start).getDay()]} ${fmtShort(parse(bk.start))}</div></div>
        <label class="grid gap-0.5"><span class="label">Number of shifts</span>
          <input id="pl-shifts" type="number" min="1" max="60" class="field field-sm mono w-[90px]" style=${{height:30,fontSize:13}} value=${dates.length||''}
            onChange=${e=>{const n=Math.max(1,Math.min(60,parseInt(e.target.value)||1));onShifts(bk.id,n)}} title="Changes the booking's end date on the schedule"/></label>
      </div>
      <div class="text-[12.5px] text-muted">${dates.length} shift${dates.length===1?'':'s'}: ${dates.map(k=>`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}`).join(' · ')}</div>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="grid gap-1"><span class="label">Job location (address)</span>
          <input id="pl-addr" class="field" style=${fs} placeholder="Street, suburb" value=${p.address||''} onInput=${e=>set({address:e.target.value})}/></label>
        <label class="grid gap-1"><span class="label">Access to site</span>
          <input id="pl-access" class="field" style=${fs} placeholder="e.g. via Diamond Jubilee Way" value=${p.access||''} onInput=${e=>set({access:e.target.value})}/></label>
        <div class="grid grid-cols-2 gap-3">
          <label class="grid gap-1"><span class="label">Quote number</span><input id="pl-quote" class="field mono" style=${fs} value=${p.quoteNo||''} onInput=${e=>set({quoteNo:e.target.value})}/></label>
          <label class="grid gap-1"><span class="label">Project number</span><input id="pl-proj" class="field mono" style=${fs} value=${p.projectNo||''} onInput=${e=>set({projectNo:e.target.value})}/></label>
        </div>
        <label class="grid gap-1"><span class="label">Crew on site</span>
          <${TimeSelect} id="pl-onsite" label="Crew on site time" value=${p.crewOnSite||''} pm=${night} onChange=${v=>set(x=>{const was=x.crewOnSite||crewStart;return {crewOnSite:v,jobSubs:(x.jobSubs||[]).map(s=>!s.time||s.time===was?{...s,time:v}:s)}})}/></label>
      </div>`}
      ${conf.crew.length>0&&html`<div class="text-[12.5px] rounded-md px-2.5 py-1.5" style=${{background:'hsl(38 90% var(--blk-l))',color:'hsl(30 60% var(--blk-fg-l))'}}>${crew?crew.name:'The crew'} is already booked: ${conf.crew.join('; ')}</div>`}
      <div class="h-px bg-line"></div>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="grid gap-1"><span class="label">Supervisor</span>
          <${Combo} id="pl-super" className="field" style=${fs} label="Supervisor" value=${p.supervisor||''} onChange=${v=>set(x=>({supervisor:v,supervisorPhone:nextSuperPhone(data,x.supervisor,x.supervisorPhone,v)}))} options=${data.resources.filter(r=>r.type==='person').map(x=>x.name)}/></label>
        <label class="grid gap-1"><span class="label">Supervisor phone</span><input id="pl-phone" type="tel" class="field mono" style=${fs} placeholder="04xx xxx xxx" value=${p.supervisorPhone||''} onInput=${e=>set({supervisorPhone:e.target.value})}/></label>
        <label class="grid gap-1"><span class="label">Site UHF channel</span><input id="pl-uhf" class="field mono" style=${fs} placeholder="e.g. 12" value=${p.uhf||''} onInput=${e=>set({uhf:e.target.value})}/></label>
        <label class="grid gap-1"><span class="label">Asphalt supplied from</span>
          <select id="pl-supply" class="field" style=${fs} value=${p.supply||'AFA'} onChange=${e=>set({supply:e.target.value})}>
            ${['AFA',...EXBIN_SUPPLIERS,...(p.supply&&p.supply!=='AFA'&&!EXBIN_SUPPLIERS.includes(p.supply)?[p.supply]:[])].map(o=>html`<option key=${o} value=${o}>${o==='AFA'?'AFA asphalt plant':o+' (exbin)'}</option>`)}</select></label>
        <label class="inline-flex items-center gap-2 text-[13px] cursor-pointer self-end h-[32px]"><input id="pl-ind" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${!!p.induction} onChange=${e=>set({induction:e.target.checked})}/>Site induction required</label>
      </div>
    <//>

    ${bk&&html`
    <${PlanCard} id="pl-map" title="Map" sub="Pin the job, site access, drop-off points and the dump site">
      <${PlanMap} pins=${p.pins||[]} onChange=${pins=>set({pins})}/>
    <//>

    <${PlanCard} id="pl-shifts" right=${html`<span class="inline-flex flex-wrap items-center gap-4">
      ${dates.some(k=>k<iso(TODAY))&&html`<label class="inline-flex items-center gap-1.5 text-[13px] cursor-pointer" title="Shifts before today are locked so they aren't changed by accident"><input id="pl-editpast" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${editPast} onChange=${e=>setEditPast(e.target.checked)}/><span class=${editPast?'font-semibold':'text-muted'}>Edit past shifts</span></label>`}</span>`} title="Shift by shift" sub=${dates.length?`${fmtN(totalT)} t ${seal?'':'asphalt '}over ${dates.length} shift${dates.length===1?'':'s'}`:'Set the first shift and number of shifts above'}>
      ${totals.size>0&&html`<div class="flex flex-wrap gap-1.5">${[...totals.entries()].map(([k,v])=>html`<span key=${k} class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] bg-sunken border border-line">
        <span class="font-semibold mono">${k}</span><span class="text-muted tnum">${fmtN(v.t)} t · ${fmtN(v.a)} m²</span></span>`)}</div>`}
      ${dates.map((k,i)=>{const sp=sps[i];const lines=sp.lines&&sp.lines.length?sp.lines:[{}];const st=lines.reduce((a,l)=>a+(lineHas(l)?planTonnes(l):0),0);
        const vol=num(sp.profArea)&&num(sp.profDepth)?num(sp.profArea)*num(sp.profDepth)/1000:0;
        const lockedK=k<iso(TODAY)&&!editPast;
        return html`<fieldset key=${k} disabled=${lockedK} class="rounded-lg border border-line m-0 p-0 min-w-0" style=${lockedK?{opacity:.55}:null} title=${lockedK?'Past shift: tick "Edit past shifts" to change it':undefined}>
          <div class="flex flex-wrap items-center gap-2 px-3 py-2 bg-sunken border-b border-line rounded-t-lg">
            <span class="font-semibold text-[13.5px]">${night?'Night':'Shift'} ${i+1}</span><span class="mono text-[12px] text-muted">${WD[parse(k).getDay()]} ${fmtShort(parse(k))}</span>
            ${lockedK&&html`<span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Past shift</span>`}
            <span class="text-[12px] text-muted tnum">${fmtN(st)} t${!seal&&spRounds(p,sp)?` · ${fmtN(spRounds(p,sp))} rounds`:''}</span>
            <span class="flex-1"></span>
            ${i>0&&html`<button type="button" class="text-[12px] font-medium text-muted hover:text-ink underline underline-offset-2" onClick=${()=>{const pv=sps[i-1];
                const have=new Set((sp.images||[]).map(id=>planImgsOf(data).find(x=>x.id===id)?.data).filter(Boolean));
                const copies=(pv.images||[]).map(id=>planImgsOf(data).find(x=>x.id===id)).filter(im=>im&&!have.has(im.data)).map(im=>({...im,id:'img'+uid()}));
                copies.forEach(im=>onAddImg(im));
                setSP(i,{lines:(pv.lines||[]).map(l=>({...l})),profiling:spProf(p,pv),profArea:pv.profArea,profDepth:pv.profDepth,images:[...(sp.images||[]),...copies.map(im=>im.id)],sections:pv.sections,notes:pv.notes,seal:pv.seal?{...pv.seal}:undefined,trucking:{...spTruck(p,pv),types:[...(spTruck(p,pv).types||[])]}})}}>Same as ${night?'night':'shift'} ${i}</button>`}
          </div>
          <div class="p-3 grid gap-3">
            <label class="grid gap-1"><span class="label">Area / sections this shift</span>
              <input id=${`pl-s${i}-sec`} class="field field-sm" style=${fsm} placeholder="e.g. Main run section 1, half of the roundabout" value=${sp.sections||''} onInput=${e=>setSP(i,{sections:e.target.value})}/></label>
            ${!seal&&html`<label class="inline-flex items-center gap-2 text-[13px] cursor-pointer w-max"><input id=${`pl-s${i}-prof`} type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${spProf(p,sp)} onChange=${e=>setSP(i,{profiling:e.target.checked})}/>Profiling required this ${night?'night':'shift'}</label>`}
            ${!seal&&spProf(p,sp)&&html`<div class="flex flex-wrap items-end gap-3">
              <label class="grid gap-1"><span class="label">Profiling m²</span><input id=${`pl-s${i}-pa`} type="number" min="0" step="any" class="field field-sm mono w-[110px]" style=${fsm} value=${sp.profArea??''} onInput=${e=>setSP(i,{profArea:e.target.value})}/></label>
              <label class="grid gap-1"><span class="label">Profile depth mm</span><input id=${`pl-s${i}-pd`} type="number" min="0" step="any" class="field field-sm mono w-[110px]" style=${fsm} value=${sp.profDepth??''} onInput=${e=>setSP(i,{profDepth:e.target.value})}/></label>
              ${vol>0&&html`<span class="text-[12px] text-muted pb-2 tnum">≈ ${fmtN(Math.round(vol*10)/10)} m³ to profile</span>`}
            </div>`}
            ${!seal&&html`<label class="inline-flex items-center gap-2 text-[13px] cursor-pointer w-max"><input id=${`pl-s${i}-seal`} type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${spSeal(sp)} onChange=${e=>setSP(i,{seal:{...(sp.seal||{}),on:e.target.checked}})}/>Seal crew needed this ${night?'night':'shift'}</label>`}
            ${!seal&&spSeal(sp)&&html`<div class="flex flex-wrap items-end gap-3">
              <label class="grid gap-1"><span class="label">Seal crew on site</span><${TimeSelect} id=${`pl-s${i}-son`} label="Seal crew on site" pm=${night} value=${sp.seal.onSite||''} onChange=${v=>setSP(i,{seal:{...sp.seal,onSite:v}})}/></label>
              <label class="grid gap-1"><span class="label">m²</span><input id=${`pl-s${i}-sarea`} type="number" min="0" step="any" class="field field-sm mono w-[110px]" style=${fsm} value=${sp.seal.area??''} onInput=${e=>setSP(i,{seal:{...sp.seal,area:e.target.value}})}/></label>
              <label class="grid gap-1 min-w-[170px] flex-1 max-w-[240px]"><span class="label">Seal type</span><${Combo} id=${`pl-s${i}-stype`} style=${fsm} label="Seal type" placeholder="e.g. 10mm Seal" value=${slType(sp.seal)}
                options=${sealTypesOf(data)} onChange=${v=>{const sl=sp.seal;const was=sealDefBinder(data,slType(sl));const keep=(sl.binder||'').trim()&&sl.binder!==was;
                  const {product,...rest}=sl;setSP(i,{seal:{...rest,type:v,binder:keep?sl.binder:(sealDefBinder(data,v)||sl.binder||'')}})}}/></label>
              <label class="grid gap-1 min-w-[140px] flex-1 max-w-[200px]"><span class="label">Binder</span><${Combo} id=${`pl-s${i}-sbind`} style=${fsm} label="Seal binder" placeholder="e.g. CRS60" value=${sp.seal.binder||''}
                options=${sealBindersOf(data)} onChange=${v=>setSP(i,{seal:{...sp.seal,binder:v}})}/></label>
            </div>`}
            <div class="grid gap-1.5">
              <div class="hidden sm:grid gap-2 grid-cols-[1.1fr_1fr_90px_80px_90px_28px]"><span class="label">${seal?'Seal type':'Mix'}</span><span class="label">Binder</span><span class="label">Area m²</span><span class="label">${seal?'':'Depth mm'}</span><span class="label">${seal?'':'Tonnes'}</span><span></span></div>
              ${lines.map((l,j)=>html`<div key=${j} class="grid gap-2 grid-cols-2 sm:grid-cols-[1.1fr_1fr_90px_80px_90px_28px] items-center">
                <select class="field field-sm mono" style=${fsm} value=${l.type||''} onChange=${e=>{const v=e.target.value;const b=binderForProduct(data,crew,v);setLine(i,j,b&&!l.binder?{type:v,binder:b}:{type:v})}} aria-label="Mix">
                  <option value="">${seal?'Seal':'Mix'}</option>${MIXES.map(m=>html`<option key=${m} value=${m}>${m}</option>`)}${l.type&&!MIXES.includes(l.type)&&html`<option value=${l.type}>${l.type}</option>`}</select>
                <select class="field field-sm mono" style=${fsm} value=${l.binder||''} onChange=${e=>setLine(i,j,{binder:e.target.value})} aria-label="Binder">
                  <option value="">Binder</option>${BINDS.map(m=>html`<option key=${m} value=${m}>${m}</option>`)}${l.binder&&!BINDS.includes(l.binder)&&html`<option value=${l.binder}>${l.binder}</option>`}</select>
                <input type="number" min="0" step="any" class="field field-sm mono" style=${fsm} placeholder="m²" value=${l.area??''} onInput=${e=>setLine(i,j,{area:e.target.value})} aria-label="Area"/>
                ${seal?html`<span></span>`:html`<input type="number" min="0" step="any" class="field field-sm mono" style=${fsm} placeholder="mm" value=${l.depth??''} onInput=${e=>setLine(i,j,{depth:e.target.value})} aria-label="Depth"/>`}
                ${seal?html`<span></span>`:html`<input type="number" min="0" step="any" class="field field-sm mono" style=${fsm} placeholder="t" title="Works out from area × depth × 2.4. Type a number to set it yourself."
                  value=${l._tManual?(l.tonnes??''):(lineHas(l)&&planTonnes(l)?planTonnes(l):'')} onInput=${e=>setLine(i,j,e.target.value===''?{tonnes:'',_tManual:false}:{tonnes:e.target.value,_tManual:true})} aria-label="Tonnes"/>`}
                <button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken" onClick=${()=>setSP(i,{lines:lines.length>1?lines.filter((_,x)=>x!==j):[{}]})} aria-label="Remove line">${Icon.x}</button>
              </div>`)}
              <div><button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>setSP(i,{lines:[...lines,{}]})}>${Icon.plus} Add another ${seal?'seal':'mix'}</button></div>
            </div>
            ${!seal&&(()=>{const tr=spTruck(p,sp);const rd=spRounds(p,sp);return html`<div class="grid gap-2 rounded-lg border border-line px-3 py-2.5">
              <div class="flex flex-wrap items-end gap-3">
                <label class="grid gap-1"><span class="label">Tonnes per round</span><input id=${`pl-s${i}-round`} type="number" min="0" step="any" class="field field-sm mono w-[110px]" style=${fsm} placeholder="e.g. 185" value=${tr.perRound??''} onInput=${e=>setTr(i,{perRound:e.target.value})}/></label>
                <label class="grid gap-1"><span class="label">Start loading trucks</span><span style=${{width:176}}><${TimeSelect} id=${`pl-s${i}-load`} label="Start loading trucks" value=${tr.loadStart||''} pm=${night} onChange=${v=>setTr(i,{loadStart:v})}/></span></label>
                <div class="grid gap-1"><span class="label">Rounds</span><div class="h-[30px] flex items-center text-[14px] font-semibold tnum">${rd?`${fmtN(rd)} round${rd===1?'':'s'}`:html`<span class="text-[12px] font-normal text-muted">${num(tr.perRound)?'Add tonnes above':'Set tonnes per round'}</span>`}</div></div>
                <div class="grid gap-1"><span class="label">Truck sizes</span><div class="h-[30px] flex items-center gap-3 text-[13px]">
                  ${PLAN_TRUCK_TYPES.map(t=>html`<label key=${t} class="inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${(tr.types||[]).includes(t)} onChange=${()=>setTr(i,{types:toggleIn(tr.types||[],t)})}/>${t}</label>`)}</div></div>
              </div>
              <input id=${`pl-s${i}-trnote`} class="field field-sm" style=${fsm} placeholder="Trucking note, e.g. Trucking will be adjusted if needed" value=${tr.note||''} onInput=${e=>setTr(i,{note:e.target.value})} aria-label="Trucking note"/>
            </div>`})()}
            <div class="grid gap-1.5"><span class="label">Pictures</span>
              <div class="flex flex-wrap gap-2">
                ${(sp.images||[]).map(id=>{const im=planImgsOf(data).find(x=>x.id===id);return im?html`<div key=${id} class="relative w-[120px] h-[90px] rounded-md overflow-hidden border border-line bg-sunken">
                    <img src=${im.data} alt=${im.name||'Shift picture'} class="w-full h-full object-cover"/>
                    ${delImg===id
                      ?html`<div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5" style=${{background:'rgba(0,0,0,.6)'}}>
                          <button type="button" class="px-2.5 h-7 rounded-md text-[12px] font-semibold text-white" style=${{background:'hsl(0 70% 45%)'}}
                            onClick=${()=>{setSP(i,{images:(sp.images||[]).filter(x=>x!==id)});onDelImg(id);setDelImg(null)}} aria-label="Yes, remove this picture">Remove</button>
                          <button type="button" class="text-[11.5px] font-medium text-white underline" onClick=${()=>setDelImg(null)}>Keep</button></div>`
                      :html`<button type="button" class="absolute top-1 right-1 h-6 pl-1 pr-2 inline-flex items-center gap-0.5 rounded-full text-[11px] font-semibold text-white"
                          style=${{background:'rgba(0,0,0,.65)'}} onClick=${()=>setDelImg(id)} aria-label="Remove picture" title="Remove this picture">${Icon.x} Remove</button>`}</div>`:null})}
                <label class="relative w-[120px] h-[90px] rounded-md border-2 border-dashed border-line flex flex-col items-center justify-center gap-1 text-[12px] text-muted cursor-pointer hover:bg-sunken hover:text-ink">
                  ${Icon.plus}<span>Add picture</span>
                  <input id=${`pl-s${i}-pic`} type="file" accept="image/*" multiple class="sr-only" onChange=${e=>{holdPlanScroll();const fl=[...e.target.files];e.target.value='';e.target.blur();addPics(i,fl)}}/></label>
              </div>
              <span class="text-[11.5px] text-faint">Marked-up maps, photos of the site… They go on the plan PDF under this ${night?'night':'shift'}.</span></div>
            <label class="grid gap-1"><span class="label">Method / notes for the crew</span>
              <textarea id=${`pl-s${i}-notes`} class="field" style=${{height:'auto',minHeight:70,padding:'8px 10px',resize:'vertical',fontSize:13}} rows="3" placeholder="One step per line" value=${sp.notes||''} onInput=${e=>setSP(i,{notes:e.target.value})}></textarea></label>
            <div class="flex flex-wrap items-center gap-1.5">
              ${planStepsOf(data).map(t=>(t||'').trim()).filter(t=>t&&!(sp.notes||'').includes(t)).map(t=>html`<button key=${t} type="button" class="text-[11.5px] rounded-full border border-line px-2 py-0.5 text-muted hover:text-ink hover:bg-sunken" onClick=${()=>setSP(i,{notes:((sp.notes||'').trim()?(sp.notes||'').trimEnd()+'\n':'')+t})}>+ ${t}</button>`)}
              ${onSteps&&html`<button id=${`pl-s${i}-steps-edit`} type="button" class="ml-1 text-[11.5px] font-medium inline-flex items-center gap-1 text-muted hover:text-ink underline underline-offset-2" aria-expanded=${stepsSetup===i} onClick=${()=>setStepsSetup(stepsSetup===i?null:i)}>${Icon.gear} ${stepsSetup===i?'Done':'Edit quick adds'}</button>`}
            </div>
            ${onSteps&&stepsSetup===i&&(st=>html`<div class="rounded-lg border border-line bg-sunken p-3 grid gap-2">
              <div class="text-[12px] text-muted">Quick-add steps for the method / notes, on every shift of every plan.</div>
              ${st.map((t,j)=>html`<div key=${j} class="grid grid-cols-[1fr_28px] gap-2 items-center">
                <input id=${`pl-step${j}`} class="field field-sm" style=${fsm} aria-label=${'Quick-add step '+(j+1)} placeholder="e.g. Sweep the area before tacking" value=${t} onInput=${e=>onSteps(st.map((x,k)=>k===j?e.target.value:x))}/>
                <button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-surface" onClick=${()=>onSteps(st.filter((_,k)=>k!==j))} aria-label=${'Remove quick-add step '+(j+1)}>${Icon.x}</button></div>`)}
              <button id="pl-step-add" type="button" class="justify-self-start text-[12px] font-medium inline-flex items-center gap-1 text-muted hover:text-ink" onClick=${()=>onSteps([...st,''])}>${Icon.plus} Add a quick-add step</button>
            </div>`)(planStepsOf(data))}
          </div>
        </fieldset>`})}
      ${!seal&&sps.some(spSeal)&&(sc=>html`<div class="flex flex-wrap items-center gap-2 text-[13px] rounded-lg border border-line bg-sunken px-3 py-2">
        <label for="pl-seal-crew" class="font-medium">Seal crew</label>
        ${sealCrewsOf(data).length?html`<select id="pl-seal-crew" class="field field-sm w-auto" style=${fsm} value=${sc?sc.id:''} onChange=${e=>set({sealCrewId:e.target.value})}>
            ${sealCrewsOf(data).map(c=>html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}</select>`
          :html`<span class="text-muted">No crews in the Seal section yet</span>`}
        <span class="text-[12px] text-muted">Each ticked ${night?'night':'shift'} is booked for this crew when you send the plan to the schedule.</span></div>`)(planSealCrew(data,p))}
    <//>

    ${restrictedIn(data,p.machineIds).length>0&&html`<${RestrictedNote} data=${data} ids=${p.machineIds} what="this plan (Machines needed)"/>`}
    <${PlanCard} id="pl-machines" title="Machines needed" sub=${`${picked.size} selected`}
      right=${machConf>0&&html`<span class="text-[12px] font-semibold" style=${{color:'var(--warn)'}}>${machConf} clash${machConf===1?'':'es'} on these dates</span>`}>
      ${machines.length===0?html`<div class="text-[12.5px] text-muted">No machines yet. Add or import them in Fleet › Machines.</div>`
        :html`<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${groupMachines(machines,data).map(g=>html`<div key=${g.key} class="grid gap-1 content-start">
          <div class="label" style=${{color:'var(--ink)'}}>${g.label}</div>
          ${g.rows.map(m=>{const c=conf.machines[m.id];const al=machAlert(data,m.id);const blocked=!!(al&&al.block&&!picked.has(m.id));return html`<label key=${m.id} class=${'flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-sunken '+(blocked?'cursor-not-allowed':'cursor-pointer')} title=${[al&&al.text,...(c||[])].filter(Boolean).join('\n')}>
            <input id=${'plm-'+m.id} type="checkbox" class="w-4 h-4 mt-0.5 shrink-0" style=${{accentColor:'var(--accent)'}} checked=${picked.has(m.id)} disabled=${blocked} onChange=${()=>{if(!blocked)set({machineIds:toggleIn(p.machineIds||[],m.id)})}}/>
            <span class="min-w-0"><span class="text-[13px] font-semibold mono">${m.name}</span> <span class="text-[12.5px] text-muted">${m.sub||''}</span>
              ${al&&html`<span class="block text-[11.5px] font-medium" style=${{color:al.tone}}>${al.text}</span>`}
              ${c&&html`<span class="block text-[11.5px] font-medium" style=${{color:'var(--warn)'}}>${c[0]}${c.length>1?` (+${c.length-1} more)`:''}</span>`}</span></label>`})}
        </div>`)}</div>`}
    <//>


    <${PlanCard} id="pl-subs" title="Subcontractors" sub="For the whole job. Added to every shift when you send the plan to the schedule">
      ${subRow(p.jobSubs||[],v=>set({jobSubs:v}),'pl-js')}
      <div class="flex flex-wrap items-center gap-1.5">${planQuickOf(data).filter(q=>(q.label||'').trim()).map((q,j)=>html`<button key=${j} type="button" class="text-[11.5px] rounded-full border border-line px-2 py-0.5 text-muted hover:text-ink hover:bg-sunken"
          title=${q.supplier?`Adds ${q.label} from ${q.supplier}`:`Adds ${q.label}`} onClick=${()=>set({jobSubs:[...(p.jobSubs||[]),{name:(q.supplier||'').trim(),info:q.label.trim(),time:crewStart}]})}>+ ${q.label}${q.supplier?html` <span class="text-faint">· ${q.supplier}</span>`:''}</button>`)}
        ${onQuick&&html`<button id="pl-quick-setup" type="button" class="ml-1 text-[11.5px] font-medium inline-flex items-center gap-1 text-muted hover:text-ink underline underline-offset-2" aria-expanded=${quickSetup} onClick=${()=>setQuickSetup(!quickSetup)}>${Icon.gear} ${quickSetup?'Done':'Set default suppliers'}</button>`}</div>
      ${quickSetup&&onQuick&&(ql=>html`<fieldset class="rounded-lg border border-line bg-sunken p-3 grid gap-2 m-0 min-w-0" disabled=${false}>
        <div class="text-[12px] text-muted">Quick-add buttons for every plan. Pick the supplier each one adds by default; leave it blank to choose each time.</div>
        ${ql.map((q,j)=>html`<div key=${j} class="grid gap-2 grid-cols-[1fr_1fr_28px] items-center">
          <input id=${`pl-q${j}-l`} class="field field-sm" style=${fsm} placeholder="Button, e.g. 2m profiler" aria-label="Quick-add button" value=${q.label||''} onInput=${e=>onQuick(ql.map((x,k)=>k===j?{...x,label:e.target.value}:x))}/>
          <${Combo} id=${`pl-q${j}-s`} style=${fsm} placeholder="Default supplier (optional)" value=${q.supplier||''} label="Default supplier" options=${subCosOf(data)} onChange=${v=>onQuick(ql.map((x,k)=>k===j?{...x,supplier:v}:x))}/>
          <button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-surface" onClick=${()=>onQuick(ql.filter((_,k)=>k!==j))} aria-label=${'Remove quick-add '+(q.label||'')}>${Icon.x}</button></div>`)}
        <button id="pl-quick-add" type="button" class="justify-self-start text-[12px] font-medium inline-flex items-center gap-1 text-muted hover:text-ink" onClick=${()=>onQuick([...ql,{label:'',supplier:''}])}>${Icon.plus} Add a quick-add button</button>
      </fieldset>`)(planQuickOf(data))}
    <//>


    <${PlanCard} id="pl-safety" title="Safety & environment">
      <div class="grid gap-1.5"><span class="label">PPE</span>
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">${PLAN_PPE.map(t=>html`<label key=${t} class="inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${(p.ppe||[]).includes(t)} onChange=${()=>set({ppe:toggleIn(p.ppe||[],t)})}/>${t}</label>`)}</div>
        <input class="field field-sm" style=${fsm} placeholder="Other PPE" value=${p.ppeOther||''} onInput=${e=>set({ppeOther:e.target.value})} aria-label="Other PPE"/></div>
      <div class="grid gap-1.5"><span class="label">Hazards and controls</span>
        ${(p.hazards||[]).map((h,j)=>html`<div key=${j} class="grid gap-2 grid-cols-[1fr_28px] sm:grid-cols-[1fr_1.6fr_28px] items-start">
          <input class="field field-sm" style=${fsm} placeholder="Hazard" value=${h.hazard||''} onInput=${e=>set({hazards:p.hazards.map((x,k)=>k===j?{...x,hazard:e.target.value}:x)})} aria-label="Hazard"/>
          <input class="field field-sm sm:col-start-2" style=${fsm} placeholder="Control" value=${h.control||''} onInput=${e=>set({hazards:p.hazards.map((x,k)=>k===j?{...x,control:e.target.value}:x)})} aria-label="Control"/>
          <button type="button" class="w-7 h-7 inline-flex items-center justify-center rounded text-muted hover:text-ink hover:bg-sunken row-start-1 col-start-2 sm:col-start-3" onClick=${()=>set({hazards:p.hazards.filter((_,k)=>k!==j)})} aria-label="Remove hazard">${Icon.x}</button></div>`)}
        <div><button type="button" class="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink" onClick=${()=>set({hazards:[...(p.hazards||[]),{}]})}>${Icon.plus} Add hazard</button></div></div>

    <//>

    <${PlanCard} id="pl-notes" title="Site rules & notes">
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="grid gap-1"><span class="label">Traffic control</span><textarea class="field" style=${{height:'auto',minHeight:80,padding:'8px 10px',fontSize:13}} rows="3" placeholder="e.g. Set up as per TGS each night; manage driveways; mark out clean-up area" value=${p.traffic||''} onInput=${e=>set({traffic:e.target.value})}></textarea></label>
        <label class="grid gap-1"><span class="label">Leave the site clean</span><textarea class="field" style=${{height:'auto',minHeight:80,padding:'8px 10px',fontSize:13}} rows="3" placeholder="e.g. No rubbish left on site; gear parked neatly in the same place each night; sticky stomps down" value=${p.cleanup||''} onInput=${e=>set({cleanup:e.target.value})}></textarea></label>
      </div>
      <label class="grid gap-1"><span class="label">Other notes</span><textarea class="field" style=${{height:'auto',minHeight:70,padding:'8px 10px',fontSize:13}} rows="3" value=${p.notes||''} onInput=${e=>set({notes:e.target.value})}></textarea></label>
    <//>`}
    <div class="flex justify-end px-1"><button type="button" class="text-[12px] font-medium underline underline-offset-2" style=${{color:'var(--bad)'}} onClick=${()=>onDelete(p.id)}>Delete this plan</button></div>
  </div>`;
}

/* ---------- the Planning screen ---------- */
function PlanningScreen({data,setData,notify,onOpenBooking}){
  const plans=plansOf(data);
  const [sel,setSel]=useState(()=>{try{return localStorage.getItem(KEY+':plan')||''}catch(e){return ''}});
  const [q,setQ]=useState('');const [confirmDel,setConfirmDel]=useState(null);const [sched,setSched]=useState(null);
  const cur=plans.find(p=>p.id===sel)||null;
  const pick=id=>{setSel(id);try{localStorage.setItem(KEY+':plan',id)}catch(e){}};
  const save=p=>setData(d=>({...d,plans:plansOf(d).some(x=>x.id===p.id)?plansOf(d).map(x=>x.id===p.id?p:x):[...plansOf(d),p]}));
  const add=()=>{const p=newPlan(data);setData(d=>({...d,plans:[...plansOf(d),p]}));pick(p.id)};
  const del=id=>{setData(d=>({...d,plans:plansOf(d).filter(x=>x.id!==id),planImgs:planImgsOf(d).filter(x=>x.planId!==id),blocks:d.blocks.map(b=>b.planId===id?(({planId,...r})=>r)(b):b)}));setConfirmDel(null);pick('');notify('Plan deleted')};
  const [sealOk,setSealOk]=useState(false);   /* the person ticks that the seal shifts are right */
  const doSchedule=p=>{setSealOk(false);setSched(p)};
  const runSchedule=()=>{const p=sched;setSched(null);let res=null;
    setData(d=>{const cur=plansOf(d).find(x=>x.id===p.id)||p;res=applyPlan(d,cur);return res.err?d:res.data});
    setTimeout(()=>{if(res&&res.err)notify(res.err);else if(res)notify(['Booking updated',res.sealN?`${res.sealN} seal shift${res.sealN===1?'':'s'} booked for ${res.sealCrew}`:'',res.sealKept?`${res.sealKept} already on the schedule`:''].filter(Boolean).join(' · '))},0)};
  const ql=q.trim().toLowerCase();
  const shown=plans.filter(p=>{if(!ql)return true;const j=data.jobs.find(x=>x.id===p.jobId);const c=data.resources.find(r=>r.id===p.crewId);
    return [p.title,p.jobName,p.customer,p.address,j&&j.name,c&&c.name].join(' ').toLowerCase().includes(ql)})
    .sort((a,b)=>((a.start||'9')<(b.start||'9')?-1:(a.start||'9')>(b.start||'9')?1:0));
  const STATUS={draft:['Draft','var(--muted)'],ready:['Ready','var(--warn)'],scheduled:['On schedule','var(--ok)']};
  const label=p=>p.title||(data.jobs.find(j=>j.id===p.jobId)||{}).name||p.jobName||'Untitled plan';
  const schedInfo=sched&&(()=>{const p=plansOf(data).find(x=>x.id===sched.id)||sched;const ds=planDates(p,data);const c=planConflicts(data,p);const bk0=planBooking(data,p);const crew=bk0&&data.resources.find(r=>r.id===bk0.resourceId);
    const old=data.blocks.find(b=>b.id===p.bookingId);return {p,ds,c,crew,old,seal:sealPlanOf(data,p)}})();
  return html`<div class="flex-1 min-h-0 flex gap-3">
    <aside class="panel w-[280px] shrink-0 flex flex-col min-h-0 overflow-hidden">
      <div class="p-3 border-b border-line grid gap-2">
        <button type="button" class="btn btn-primary justify-center" onClick=${add}>${Icon.plus} New plan</button>
        <input class="field field-sm" style=${{height:30,fontSize:13}} placeholder="Search plans" value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search plans"/>
      </div>
      <ul class="flex-1 min-h-0 overflow-y-auto p-2 grid gap-1 content-start">
        ${shown.length===0&&html`<li class="px-3 py-6 text-center text-[13px] text-muted">${plans.length?'No plans match.':'No plans yet. Start one with New plan.'}</li>`}
        ${shown.map(p=>{const bk1=planBooking(data,p);const c=bk1&&data.resources.find(r=>r.id===bk1.resourceId);const ds=planDates(p,data);const [sl,sc]=STATUS[p.status]||STATUS.draft;const on=p.id===sel;
          return html`<li key=${p.id}><button type="button" class=${'w-full text-left rounded-lg px-2.5 py-2 grid gap-0.5 '+(on?'':'hover:bg-sunken')} style=${on?{background:'var(--accent-soft)'}:null} onClick=${()=>pick(p.id)}>
            <span class="text-[13px] font-semibold truncate">${label(p)}</span>
            <span class="text-[12px] text-muted truncate">${c?c.name:'No crew'}${ds.length?` · ${fmtShort(parse(ds[0]))}${ds.length>1?' – '+fmtShort(parse(ds[ds.length-1])):''} · ${ds.length} ${p.shift==='night'?'night':'shift'}${ds.length===1?'':'s'}`:''}</span>
            <span class="text-[11px] font-semibold" style=${{color:sc}}>${sl}</span></button></li>`})}
      </ul>
    </aside>
    <div id="pl-scroll" class="flex-1 min-w-0 min-h-0 overflow-y-auto pr-1">
      ${!cur?html`<div class="panel p-8 text-center grid gap-3 place-items-center">
          <div class="font-display text-[18px] font-semibold">Job planning</div>
          <p class="text-[13px] text-muted max-w-[520px]">Fill in the site inspection and the method for a job: site details and map pins, asphalt and profiling for each shift, the machines, trucking and subcontractors needed, and the safety checks. Send it to the schedule to create or update the crew’s booking, then print the plan as a PDF for the crew.</p>
          <button type="button" class="btn btn-primary" onClick=${add}>${Icon.plus} New plan</button></div>`
        :html`<${PlanForm} key=${cur.id} plan=${cur} data=${data} save=${save} onDelete=${id=>setConfirmDel(id)} onSchedule=${doSchedule} onOpenBooking=${onOpenBooking}
            onShifts=${(bid,n)=>setData(d=>setBookingShifts(d,bid,n))}
            onQuick=${list=>setData(d=>({...d,planQuick:list}))} onSteps=${list=>setData(d=>({...d,planSteps:list}))}
            onAddImg=${img=>setData(d=>({...d,planImgs:[...planImgsOf(d),img]}))} onDelImg=${id=>setData(d=>({...d,planImgs:planImgsOf(d).filter(x=>x.id!==id)}))}
            onPdf=${async p=>{try{const blob=await buildPlanPdf(data,p);const dl=window.claude&&window.claude.use?await window.claude.use('downloads'):null;if(!dl){notify('Saving files isn’t available in this view.');return}
              await dl.save({filename:`${(label(p)).replace(/[\\/:*?"<>|]+/g,' ').trim()} - job plan.pdf`,data:blob});notify('Plan PDF saved')}catch(e){notify(e&&e.code==='declined'?'Download cancelled.':(e&&e.message)||'The PDF could not be built.')}}}/>`}
    </div>
    ${confirmDel&&html`<div class="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)setConfirmDel(null)}}>
      <div class="panel pop w-full max-w-[420px] p-5 grid gap-3" role="dialog" aria-modal="true">
        <div class="font-display text-[17px] font-semibold">Delete this plan?</div>
        <p class="text-[13px] text-muted">The plan is removed. A booking already made from it stays on the schedule.</p>
        <div class="flex justify-end gap-2"><button class="btn" onClick=${()=>setConfirmDel(null)}>Keep</button><button class="btn" style=${{background:'var(--bad)',color:'#fff',borderColor:'var(--bad)'}} onClick=${()=>del(confirmDel)}>Delete</button></div>
      </div></div>`}
    ${schedInfo&&html`<div class="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)setSched(null)}}>
      <div class="panel pop w-full max-w-[520px] p-5 grid gap-3" role="dialog" aria-modal="true" aria-labelledby="ps-t">
        <div id="ps-t" class="font-display text-[17px] font-semibold">${schedInfo.p.appliedAt?'Update the booking from this plan?':'Send this plan to the schedule?'}</div>
        ${!schedInfo.old?html`<p class="text-[13px]" style=${{color:'var(--bad)'}}>Pick the job from the schedule first.</p>`
          :html`<ul class="text-[13px] grid gap-1">
            <li>${schedInfo.crew.name} · ${schedInfo.old&&schedInfo.old.shift==='night'?'night':'day'} works · ${fmtShort(parse(schedInfo.ds[0]))}${schedInfo.ds.length>1?' – '+fmtShort(parse(schedInfo.ds[schedInfo.ds.length-1])):''} (${schedInfo.ds.length} shift${schedInfo.ds.length===1?'':'s'})</li>
            <li>Quantities for each shift, ${(schedInfo.p.machineIds||[]).length} machine${(schedInfo.p.machineIds||[]).length===1?'':'s'}, subcontractors and the crew start time</li>
            <li class="text-muted">Dates stay as they are on the schedule. Trucks already entered on the booking are kept.</li></ul>
          ${(()=>{const was=new Set((schedInfo.old&&schedInfo.old.plantIds)||[]);const bad=restrictedIn(data,(schedInfo.p.machineIds||[]).filter(id=>!was.has(id)));
            return bad.length>0&&html`<div id="ps-restricted-push" class="text-[12.5px] rounded-md px-2.5 py-2 font-medium" style=${{background:'hsl(0 80% 96%)',color:'hsl(0 72% 38%)'}}>${bad.map(id=>(data.resources.find(r=>r.id===id)||{}).name).join(', ')} ${bad.length===1?'is':'are'} restricted (do not use) and can’t go on the booking. Take ${bad.length===1?'it':'them'} off the plan’s machines first.</div>`})()}
          ${(Object.keys(schedInfo.c.machines).length>0||schedInfo.c.crew.length>0)&&html`<div class="text-[12.5px] rounded-md px-2.5 py-2 grid gap-1" style=${{background:'hsl(38 90% var(--blk-l))',color:'hsl(30 60% var(--blk-fg-l))'}}>
            <span class="font-semibold">Clashes (you can still go ahead):</span>
            ${schedInfo.c.crew.length>0&&html`<span>${schedInfo.crew.name} is already booked: ${schedInfo.c.crew.join('; ')}</span>`}
            ${Object.entries(schedInfo.c.machines).map(([id,l])=>html`<span key=${id}>${(data.resources.find(r=>r.id===id)||{}).name}: ${l.join('; ')}</span>`)}</div>`}
          ${(schedInfo.seal.items.length>0||schedInfo.seal.removes.length>0)&&(S=>html`<div id="ps-seal" class="grid gap-2 rounded-lg border border-line p-3">
            <div class="text-[13px] font-semibold">Seal crew${S.crew?` · ${S.crew.name}`:''}: check these are right</div>
            ${!S.crew&&S.items.length>0&&html`<div class="text-[12.5px]" style=${{color:'var(--bad)'}}>No crew in the Seal section to book. Add one in Settings › Crews first.</div>`}
            <ul class="grid gap-1.5 text-[12.5px]">
              ${S.items.map(it=>{const tag={new:['New booking','var(--ok)'],update:['Update this plan’s booking','var(--muted)'],existing:['Already on the schedule','hsl(30 70% var(--blk-edge-l))']}[it.act];
                const bc=it.b&&data.resources.find(r=>r.id===it.b.resourceId);
                return html`<li key=${it.k} class="grid grid-cols-[86px_1fr] gap-2">
                  <span class="mono">${WD[parse(it.k).getDay()]} ${fmtShort(parse(it.k))}</span>
                  <span class="grid gap-0.5"><span><span class="font-semibold" style=${{color:tag[1]}}>${tag[0]}</span> · ${sealText(it.sl)||'no details yet'}</span>
                    ${it.act==='existing'&&html`<span class="text-muted">${bc?bc.name:'Seal crew'} ${it.b.start===it.b.end?'':`(${fmtShort(parse(it.b.start))} – ${fmtShort(parse(it.b.end))}) `}is already booked for this job. No second booking is made; the plan only fills in details that are empty on it.</span>`}
                    ${it.busy&&it.busy.length>0&&html`<span style=${{color:'hsl(30 70% var(--blk-edge-l))'}}>${S.crew.name} is also booked on ${it.busy.join(', ')} that day.</span>`}</span></li>`})}
              ${S.removes.map(x=>html`<li key=${x.id} class="grid grid-cols-[86px_1fr] gap-2"><span class="mono">${WD[parse(x.start).getDay()]} ${fmtShort(parse(x.start))}</span>
                <span><span class="font-semibold" style=${{color:'var(--bad)'}}>Remove</span> · this plan booked the seal crew here, but the shift no longer needs it</span></li>`)}
            </ul>
            <label class="inline-flex items-center gap-2 text-[13px] font-medium cursor-pointer"><input id="ps-seal-ok" type="checkbox" class="w-4 h-4" style=${{accentColor:'var(--accent)'}} checked=${sealOk} onChange=${e=>setSealOk(e.target.checked)}/>I’ve checked the seal shifts above</label>
          </div>`)(schedInfo.seal)}`}
        <div class="flex justify-end gap-2"><button class="btn" onClick=${()=>setSched(null)}>Cancel</button>
          <button id="ps-push-go" class="btn btn-primary" disabled=${!schedInfo.old||restrictedIn(data,(schedInfo.p.machineIds||[]).filter(id=>!((schedInfo.old&&schedInfo.old.plantIds)||[]).includes(id))).length>0||((schedInfo.seal.items.length>0||schedInfo.seal.removes.length>0)&&(!sealOk||(schedInfo.seal.items.length>0&&!schedInfo.seal.crew)))} onClick=${runSchedule}>Update booking</button></div>
      </div></div>`}
  </div>`;
}

/* ---------- the plan as a PDF (site inspection + methodology) ---------- */
/* opt.shiftDate: just that shift's plan; opt.doc: add the pages to an existing PDF (the daily program) */
async function buildPlanPdf(data,p,opt={}){
  const JsPDF=await loadJsPDF();const doc=opt.doc||new JsPDF({orientation:'portrait',unit:'mm',format:'a4'});if(opt.doc)doc.addPage();const firstPage=doc.getNumberOfPages();
  const M=12,W=186;let y=0;
  const bkp=planBooking(data,p);const crew=data.resources.find(r=>r.id===(bkp?bkp.resourceId:p.crewId));const job=data.jobs.find(j=>j.id===(bkp?bkp.jobId:p.jobId));const seal=isSealCrew(crew);const dates=planDates(p,data);const night=bkp?bkp.shift==='night':p.shift==='night';
  const font=(s,b,c)=>{doc.setFont('helvetica',b?'bold':'normal');doc.setFontSize(s);doc.setTextColor(...(c||[0,0,0]))};
  const clean=t=>String(t??'').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/²/g,'2').replace(/³/g,'3').replace(/°/g,' deg');
  const room=h=>{if(y+h>284){doc.addPage();y=14}};
  const head=t=>{room(12);doc.setFillColor(...AFA_DARK);doc.rect(M,y,W,7,'F');font(9,true,[255,255,255]);doc.text(clean(t),M+2,y+4.8);y+=9};
  const kv=(rows)=>{rows.filter(r=>r[1]!==undefined&&r[1]!==null&&String(r[1]).trim()!=='').forEach(([k,v])=>{font(8.5,false);const lines=doc.splitTextToSize(clean(v),W-52);
    font(8.5,true);const kl=doc.splitTextToSize(clean(k),46);const h=Math.max(lines.length,kl.length)*4;room(h+2);
    font(8.5,true,[80,80,80]);doc.text(kl,M,y+3.5);font(8.5,false);doc.text(lines,M+50,y+3.5);y+=h+1.6})};
  const para=(t,indent=0)=>{const lines=doc.splitTextToSize(clean(t),W-indent);font(8.5,false);lines.forEach(l=>{room(4.4);doc.text(l,M+indent,y+3.5);y+=4.2})};
  const bullets=t=>String(t||'').split('\n').map(s=>s.trim()).filter(Boolean).forEach(s=>{const lines=doc.splitTextToSize(clean(s.replace(/^[-*•]\s*/,'')),W-6);font(8.5,false);room(lines.length*4.2);doc.text('-',M+1,y+3.5);doc.text(lines,M+5,y+3.5);y+=lines.length*4.2});
  try{doc.addImage(AFA_LOGO,'PNG',M,8,44,17)}catch(e){}
  font(14,true);doc.text(seal?'SEAL JOB PLAN':'JOB PLAN & METHODOLOGY',198,14,{align:'right'});
  const one=opt.shiftDate?planDates(p,data).indexOf(opt.shiftDate):-1;
  font(10,true,AFA_RED);doc.text(clean(p.title||(job&&job.name)||p.jobName||''),198,20,{align:'right'});
  if(one>=0){font(9,true);doc.text(`${p.shift==='night'||(bkp&&bkp.shift==='night')?'Night':'Shift'} ${one+1} of ${planDates(p,data).length} - ${WD[parse(opt.shiftDate).getDay()]} ${fmtShort(parse(opt.shiftDate))} ${parse(opt.shiftDate).getFullYear()}`,198,25.5,{align:'right'})}
  font(7.5,false,[110,110,110]);doc.text(`Printed ${new Date().toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}`,198,one>=0?30:25,{align:'right'});
  y=one>=0?34:31;
  head('Job & site');
  kv([['Job',job?jobLabel(job):[p.customer,p.jobName].filter(Boolean).join(' - ')],['Client',p.customer||(job&&job.customer)],['Job location',p.address],['Access to site',p.access],
      ['Quote / project',[p.quoteNo&&`Quote ${p.quoteNo}`,p.projectNo&&`Project ${p.projectNo}`].filter(Boolean).join(' · ')],
      ['Crew',crew&&crew.name],['Shifts',dates.length?`${dates.length} ${night?'night':'day'} shift${dates.length===1?'':'s'}: ${dates.map(k=>`${WD[parse(k).getDay()]} ${fmtShort(parse(k))}`).join(', ')}`:''],
      ['Crew on site',fmtTime(p.crewOnSite)],['Supervisor',[p.supervisor,p.supervisorPhone].filter(Boolean).join(' · ')],['Site UHF channel',p.uhf],
      ['Site induction',p.induction?'Required':'Not required'],['Asphalt supply',p.supply==='AFA'||!p.supply?'AFA asphalt plant':`${p.supply} (exbin)`],
      ['PPE',[...(p.ppe||[]),p.ppeOther].filter(Boolean).join(', ')]]);
  if((p.pins||[]).length){head('Locations');(p.pins||[]).forEach(pin=>{room(5);font(8.5,true);doc.text(clean(pin.label||pinType(pin.type).label),M,y+3.5);
    font(8,false,[90,90,90]);doc.text(clean(pinType(pin.type).label),M+60,y+3.5);font(8,false,[38,84,140]);doc.textWithLink(`${(+pin.lat).toFixed(5)}, ${(+pin.lng).toFixed(5)} (Google Maps)`,M+105,y+3.5,{url:gmapsLink(pin)});y+=5})}
  const sps=dates.map((_,i)=>(p.shiftPlans||[])[i]||{});
  const idxs=one>=0?[one]:dates.map((_,i)=>i);
  const tot=new Map();if(one<0)sps.forEach(sp=>(sp.lines||[]).filter(lineHas).forEach(l=>{const k=mixLabel(l);const t=tot.get(k)||{t:0,a:0};t.t+=planTonnes(l);t.a+=num(l.area);tot.set(k,t)}));
  if(tot.size){head('Totals');[...tot.entries()].forEach(([k,v])=>{room(5);font(8.5,true);doc.text(clean(k),M,y+3.5);font(8.5,false);doc.text(seal?`${fmtN(v.a)} m2`:`${fmtN(v.t)} t over ${fmtN(v.a)} m2`,M+46,y+3.5);y+=4.6})}
  if(dates.length){head(one>=0?'This shift':'Shift by shift');
    idxs.forEach(i=>{const sp=sps[i];const k=dates[i];room(14);doc.setFillColor(241,241,244);doc.rect(M,y,W,6,'F');font(9,true);doc.text(`${night?'Night':'Shift'} ${i+1} - ${WD[parse(k).getDay()]} ${fmtShort(parse(k))}`,M+2,y+4.2);
      const st=(sp.lines||[]).reduce((a,l)=>a+(lineHas(l)?planTonnes(l):0),0);const rd=seal?0:spRounds(p,sp);if(st){font(8.5,true,AFA_RED);doc.text(`${fmtN(st)} t${rd?` - ${fmtN(rd)} rounds`:''}`,198-2,y+4.2,{align:'right'})}
      y+=7.5;
      if(sp.sections)kv([['Area / sections',sp.sections]]);
      if(spProf(p,sp)&&num(sp.profArea))kv([['Profiling',`${fmtN(num(sp.profArea))} m2 @ ${fmtN(num(sp.profDepth))} mm${num(sp.profDepth)?` (about ${fmtN(Math.round(num(sp.profArea)*num(sp.profDepth)/100)/10)} m3)`:''}`]]);
      if(!seal&&spSeal(sp))kv([['Seal crew',`${sealText(sp.seal)}${planSealCrew(data,p)?` (${planSealCrew(data,p).name})`:''}`]]);
      (sp.lines||[]).filter(lineHas).forEach(l=>kv([[seal?'Seal':'Asphalt',seal?`${l.type||''} ${l.binder||''} - ${fmtN(num(l.area))} m2`:`${fmtN(num(l.area))} m2 - ${fmtN(planTonnes(l))} t @ ${fmtN(num(l.depth))} mm ${mixLabel(l)}`]]));
      const subs=[...(p.jobSubs||[]),...(sp.subs||[])].filter(subHas);if(subs.length)kv([['Subcontractors',subs.map(s=>[s.name,s.info,fmtTime(s.time||p.crewOnSite)].filter(Boolean).join(' - ')).join('\n')]]);
      const tr=spTruck(p,sp);if(!seal&&(num(tr.perRound)||tr.loadStart||(tr.types||[]).length||tr.note))kv([['Trucking',[num(tr.perRound)&&`${fmtN(num(tr.perRound))} t per round${spRounds(p,sp)?` = ${fmtN(spRounds(p,sp))} rounds`:''}`,tr.loadStart&&`start loading ${fmtTime(tr.loadStart)}`,(tr.types||[]).length&&tr.types.join(', '),tr.note].filter(Boolean).join(' · ')]]);
      if((sp.notes||'').trim()){room(5);font(8.5,true,[80,80,80]);doc.text('Method',M,y+3.5);y+=4.6;bullets(sp.notes)}
      (sp.images||[]).map(id=>planImgsOf(data).find(x=>x.id===id)).filter(Boolean).forEach(im=>{const mw=W,mh=100;let w=mw,h=im.h&&im.w?mw*im.h/im.w:mw*.66;if(h>mh){w=w*mh/h;h=mh}
        room(h+3);try{doc.addImage(im.data,'JPEG',M+(W-w)/2,y+1,w,h);doc.setDrawColor(...AFA_GRID);doc.rect(M+(W-w)/2,y+1,w,h,'S')}catch(e){}y+=h+3});
      y+=2})}
  const machines=(p.machineIds||[]).map(id=>data.resources.find(r=>r.id===id)).filter(Boolean);
  if(machines.length){head('Machines');groupMachines(machines,data).forEach(g=>kv([[g.label,g.rows.map(m=>`${m.name}${m.sub?' '+m.sub:''}`).join(', ')]]))}
  if((p.jobSubs||[]).filter(subHas).length){head('Subcontractors (whole job)');kv((p.jobSubs||[]).filter(subHas).map(s=>[s.name||'-',[s.info,fmtTime(s.time||p.crewOnSite)].filter(Boolean).join(' - ')]))}
  const sl=p.seal||{};if(num(sl.tackArea)||num(sl.sealArea)||sl.onSite){head('Seal crew');kv([['On site',fmtTime(sl.onSite)],['Tack area',num(sl.tackArea)?`${fmtN(num(sl.tackArea))} m2`:''],['Seal area',num(sl.sealArea)?`${fmtN(num(sl.sealArea))} m2`:'']])}
  if((p.hazards||[]).some(h=>h.hazard||h.control)){head('Safety / environmental - hazards and controls');(p.hazards||[]).filter(h=>h.hazard||h.control).forEach(h=>kv([[h.hazard||'-',h.control||'']]))}
  if(p.traffic||p.cleanup||p.notes){head('Site rules & notes');if(p.traffic){font(8.5,true,[80,80,80]);room(5);doc.text('Traffic control',M,y+3.5);y+=4.6;bullets(p.traffic)}
    if(p.cleanup){font(8.5,true,[80,80,80]);room(5);doc.text('Leave the site clean',M,y+3.5);y+=4.6;bullets(p.cleanup)}if(p.notes){font(8.5,true,[80,80,80]);room(5);doc.text('Notes',M,y+3.5);y+=4.6;bullets(p.notes)}}
  const n=doc.getNumberOfPages();const cnt=n-firstPage+1;for(let i=firstPage;i<=n;i++){doc.setPage(i);font(7,false,[130,130,130]);doc.text(`${clean(p.title||'Job plan')}${one>=0?` - ${dates[one]?fmtShort(parse(dates[one])):''} plan`:''} - page ${i-firstPage+1} of ${cnt}`,105,292,{align:'center'})}
  return opt.doc?doc:doc.output('blob');
}

/* view a plan from the booking (read only) */
function PlanViewDialog({data,plan,onClose,onOpenPlan,notify}){
  useEffect(()=>{const h=e=>{if(e.key==='Escape'){e.stopPropagation();onClose()}};window.addEventListener('keydown',h,true);return()=>window.removeEventListener('keydown',h,true)},[]);
  const p=plan;const bkv=planBooking(data,p);const crew=data.resources.find(r=>r.id===(bkv?bkv.resourceId:p.crewId));const dates=planDates(p,data);const seal=isSealCrew(crew);const night=bkv?bkv.shift==='night':p.shift==='night';
  const sps=dates.map((_,i)=>(p.shiftPlans||[])[i]||{});
  const machines=(p.machineIds||[]).map(id=>data.resources.find(r=>r.id===id)).filter(Boolean);
  const row=(k,v)=>v&&String(v).trim()?html`<div class="grid grid-cols-[150px_1fr] gap-2 text-[13px]"><span class="text-muted">${k}</span><span class="whitespace-pre-line">${v}</span></div>`:null;
  const pdf=async()=>{try{const blob=await buildPlanPdf(data,p);const dl=window.claude&&window.claude.use?await window.claude.use('downloads'):null;if(!dl){notify('Saving files isn’t available in this view.');return}
    await dl.save({filename:`${(p.title||'Job plan').replace(/[\\/:*?"<>|]+/g,' ').trim()} - job plan.pdf`,data:blob});notify('Plan PDF saved')}catch(e){notify((e&&e.message)||'The PDF could not be built.')}};
  return html`<div class="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full max-w-[860px] flex flex-col max-h-full overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="pv-t">
      <div class="px-5 pt-5 pb-3 border-b border-line flex items-start gap-3">
        <div class="min-w-0 flex-1"><div id="pv-t" class="font-display text-[18px] font-semibold">${p.title||'Job plan'}</div>
          <div class="text-[12.5px] text-muted">${[crew&&crew.name,dates.length&&`${dates.length} ${night?'night':'day'} shift${dates.length===1?'':'s'} from ${fmtShort(parse(dates[0]))}`].filter(Boolean).join(' · ')}</div></div>
        <button type="button" class="btn" onClick=${pdf}>${Icon.download} PDF</button>
        <button type="button" class="btn" onClick=${()=>onOpenPlan(p.id)}>Open in Planning</button>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button>
      </div>
      <div class="overflow-y-auto p-5 grid gap-5">
        <div class="grid gap-1.5">${row('Job location',p.address)}${row('Access to site',p.access)}${row('Crew on site',fmtTime(p.crewOnSite))}${row('Supervisor',[p.supervisor,p.supervisorPhone].filter(Boolean).join(' · '))}
          ${row('UHF channel',p.uhf)}${row('Site induction',p.induction?'Required':'')}${row('PPE',[...(p.ppe||[]),p.ppeOther].filter(Boolean).join(', '))}</div>
        ${(p.pins||[]).length>0&&html`<${PlanMap} pins=${p.pins} readOnly=${true} height=${300} onChange=${()=>{}}/>`}
        <div class="grid gap-2"><div class="font-display text-[15px] font-semibold">Shift by shift</div>
          ${sps.map((sp,i)=>{const st=(sp.lines||[]).reduce((a,l)=>a+(lineHas(l)?planTonnes(l):0),0);const subs=[...(p.jobSubs||[]),...(sp.subs||[])].filter(subHas);
            return html`<div key=${i} class="rounded-lg border border-line p-3 grid gap-1.5">
              <div class="flex items-baseline gap-2"><span class="font-semibold text-[13.5px]">${night?'Night':'Shift'} ${i+1}</span><span class="mono text-[12px] text-muted">${WD[parse(dates[i]).getDay()]} ${fmtShort(parse(dates[i]))}</span>
                <span class="flex-1"></span>${st>0&&html`<span class="text-[12.5px] font-semibold tnum">${fmtN(st)} t${!seal&&spRounds(p,sp)?` · ${fmtN(spRounds(p,sp))} rounds`:''}</span>`}</div>
              ${row('Area / sections',sp.sections)}${spProf(p,sp)&&num(sp.profArea)?row('Profiling',`${fmtN(num(sp.profArea))} m² @ ${fmtN(num(sp.profDepth))} mm`):null}${!seal&&spSeal(sp)?row('Seal crew',sealText(sp.seal)):null}
              ${(sp.lines||[]).filter(lineHas).map((l,j)=>html`<div key=${j}>${row(seal?'Seal':'Asphalt',seal?`${l.type||''} ${l.binder||''} · ${fmtN(num(l.area))} m²`:`${fmtN(num(l.area))} m² · ${fmtN(planTonnes(l))} t @ ${fmtN(num(l.depth))} mm ${mixLabel(l)}`)}</div>`)}
              ${subs.length>0&&row('Subcontractors',subs.map(s=>[s.name,s.info,fmtTime(s.time||p.crewOnSite)].filter(Boolean).join(' · ')).join('\n'))}
              ${!seal&&(()=>{const tr=spTruck(p,sp);return row('Trucking',[num(tr.perRound)&&`${fmtN(num(tr.perRound))} t per round`,tr.loadStart&&`start loading ${fmtTime(tr.loadStart)}`,(tr.types||[]).join(', '),tr.note].filter(Boolean).join(' · '))})()}
              ${row('Method',sp.notes)}
              ${(sp.images||[]).length>0&&html`<div class="flex flex-wrap gap-2 pt-1">${(sp.images||[]).map(id=>{const im=planImgsOf(data).find(x=>x.id===id);return im?html`<a key=${id} href=${im.data} target="_blank" rel="noopener"><img src=${im.data} alt=${im.name||'Shift picture'} class="h-[110px] rounded-md border border-line"/></a>`:null})}</div>`}
            </div>`})}
        </div>
        ${machines.length>0&&html`<div class="grid gap-1.5"><div class="font-display text-[15px] font-semibold">Machines</div>${groupMachines(machines,data).map(g=>html`<div key=${g.key}>${row(g.label,g.rows.map(m=>`${m.name} ${m.sub||''}`).join(', '))}</div>`)}</div>`}
        ${(p.hazards||[]).some(h=>h.hazard)&&html`<div class="grid gap-1.5"><div class="font-display text-[15px] font-semibold">Hazards and controls</div>${p.hazards.filter(h=>h.hazard).map((h,j)=>html`<div key=${j}>${row(h.hazard,h.control)}</div>`)}</div>`}
        ${(p.traffic||p.cleanup||p.notes)&&html`<div class="grid gap-1.5"><div class="font-display text-[15px] font-semibold">Site rules & notes</div>${row('Traffic control',p.traffic)}${row('Leave the site clean',p.cleanup)}${row('Notes',p.notes)}</div>`}
      </div>
    </div>
  </div>`;
}
/* the trucking note from the plan, shown in the booking's Trucks tab */
function PlanTruckNote({data,f,k}){
  const p=planFor(data,f);if(!p)return null;const i=planDates(p,data).indexOf(k);if(i<0)return null;
  const sp=(p.shiftPlans||[])[i]||{};const tr=spTruck(p,sp);const perRound=num(tr.perRound);const rd=spRounds(p,sp);
  const st=(sp.lines||[]).reduce((a,l)=>a+(lineHas(l)?planTonnes(l):0),0);
  if(!perRound&&!(tr.types||[]).length&&!tr.loadStart&&!tr.note)return null;
  return html`<div class="rounded-lg px-3 py-2 text-[12.5px] grid gap-0.5" style=${{background:'var(--accent-soft)'}}>
    <div class="font-semibold" style=${{color:'var(--accent)'}}>From the job plan${p.title?`: ${p.title}`:''}</div>
    <div>${[perRound&&`${fmtN(perRound)} t of trucks per round${rd?` · ${fmtN(rd)} rounds this shift (${fmtN(st)} t)`:''}`,tr.loadStart&&`start loading ${fmtTime(tr.loadStart)}`,(tr.types||[]).length&&`truck sizes: ${tr.types.join(', ')}`].filter(Boolean).join(' · ')}</div>
    ${tr.note&&html`<div class="text-muted">${tr.note}</div>`}
  </div>`;
}

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
/* =====================================================================
   Staff: the leave panel beside the leave calendar, and the People view
   (the staff list, with each person's login for administrators and superusers)
   ===================================================================== */
const LEAVE_KINDS=['leave','sick','rdo','training'];
/* leave figures for the Staff screen's top bar: away today, away this week (Mon–Sun), starting in the next 4 weeks */
function leaveStats(data){
  const today=iso(TODAY),mon=mondayOf(TODAY),wk=[...Array(7)].map((_,i)=>iso(addDays(mon,i))),until=iso(addDays(TODAY,28));
  const people=new Map(data.resources.filter(r=>r.type==='person').map(p=>[p.id,p]));
  const bl=data.blocks.filter(b=>people.has(b.resourceId)&&LEAVE_KINDS.includes(b.kind)&&KINDS[b.kind].away);
  const today_=bl.filter(b=>covers(b,today)).map(b=>({b,p:people.get(b.resourceId)}));
  const inWeek=bl.filter(b=>b.start<=wk[6]&&b.end>=wk[0]);const weekIds=[...new Set(inWeek.map(b=>b.resourceId))];
  const weekDays=weekIds.reduce((s,id)=>s+wk.filter(k=>parse(k).getDay()%6&&inWeek.some(b=>b.resourceId===id&&covers(b,k))).length,0);
  const soon=bl.filter(b=>b.start>today&&b.start<=until).sort((a,b)=>a.start.localeCompare(b.start)).map(b=>({b,p:people.get(b.resourceId)}));
  return {today:today_,week:weekIds.map(id=>people.get(id)),weekDays,soon};
}
const leaveRange=b=>b.start===b.end?fmtShort(parse(b.start)):`${fmtShort(parse(b.start))} – ${fmtShort(parse(b.end))}`;
const leaveChip=k=>{const K=KINDS[k]||{};return html`<span class="shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style=${{background:`hsl(${K.hue||220} 70% var(--blk-l))`,color:`hsl(${K.hue||220} 50% var(--blk-fg-l))`}}>${K.label||k}</span>`};
function SDialog({title,sub,onClose,children,foot,width=520}){
  useEffect(()=>{const h=e=>{if(e.key==='Escape'&&!e.defaultPrevented)onClose()};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[]);
  return html`<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)onClose()}}>
    <div class="panel pop w-full flex flex-col max-h-full overflow-hidden" style=${{maxWidth:width}} role="dialog" aria-modal="true" aria-label=${typeof title==='string'?title:'Dialog'}>
      <div class="px-5 pt-5 pb-3 border-b border-line flex items-start gap-3"><div class="min-w-0 flex-1"><div class="font-display text-[18px] font-semibold">${title}</div>${sub&&html`<div class="text-[12.5px] text-muted">${sub}</div>`}</div>
        <button type="button" class="btn btn-ghost" onClick=${onClose} aria-label="Close">${Icon.x}</button></div>
      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-4">${children}</div>
      ${foot&&html`<div class="px-5 py-3 border-t border-line bg-sunken flex flex-wrap items-center gap-2">${foot}</div>`}
    </div></div>`;
}
const SFld=({label,children})=>html`<label class="grid gap-1 min-w-0"><span class="label">${label}</span>${children}</label>`;

/* add leave: who, what kind, when */
function LeaveDialog({data,setData,onClose,notify,personId}){
  const people=data.resources.filter(r=>r.type==='person').sort((a,b)=>a.name.localeCompare(b.name));
  const [f,setF]=useState({resourceId:personId||'',kind:'leave',start:iso(TODAY),end:iso(TODAY),title:''});const [err,setErr]=useState('');
  const save=()=>{if(!f.resourceId){setErr('Pick who is away.');return}if(!f.start||!f.end||f.end<f.start){setErr('Check the dates.');return}
    const clash=data.blocks.find(b=>b.resourceId===f.resourceId&&LEAVE_KINDS.includes(b.kind)&&b.start<=f.end&&b.end>=f.start);
    if(clash&&err!=='clash'){setErr('clash');return}
    setData(d=>({...d,blocks:[...d.blocks,{id:uid(),resourceId:f.resourceId,kind:f.kind,start:f.start,end:f.end,title:f.title.trim()}]}));
    const p=people.find(x=>x.id===f.resourceId);notify&&notify(`${KINDS[f.kind].label} added for ${p?p.name:'them'}`);onClose()};
  const clashB=err==='clash'&&data.blocks.find(b=>b.resourceId===f.resourceId&&LEAVE_KINDS.includes(b.kind)&&b.start<=f.end&&b.end>=f.start);
  return html`<${SDialog} title="Add leave" sub="Shows on the leave calendar, and on the schedule as staff away" onClose=${onClose}
    foot=${html`${err&&err!=='clash'&&html`<span class="text-[12.5px] mr-auto" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="lv-save" type="button" class="btn btn-primary" onClick=${save}>${clashB?'Add anyway':'Add leave'}</button>`}>
    <div class="grid sm:grid-cols-2 gap-3">
      <div class="sm:col-span-2"><${SFld} label="Who"><select id="lv-person" class="field" value=${f.resourceId} onChange=${e=>{setF({...f,resourceId:e.target.value});setErr('')}}><option value="">Choose…</option>${people.map(p=>html`<option key=${p.id} value=${p.id}>${p.name}${p.sub?' · '+p.sub:''}</option>`)}</select><//></div>
      <div class="sm:col-span-2"><${SFld} label="Type"><div class="seg w-max flex-wrap">${LEAVE_KINDS.map(k=>html`<button key=${k} id=${'lv-k-'+k} type="button" aria-pressed=${f.kind===k} onClick=${()=>setF({...f,kind:k})}>${KINDS[k].label}</button>`)}</div><//></div>
      <${SFld} label="From"><input id="lv-from" type="date" class="field mono" value=${f.start} onChange=${e=>{const v=e.target.value;setF({...f,start:v,end:f.end<v?v:f.end});setErr('')}}/><//>
      <${SFld} label="To (last day away)"><input id="lv-to" type="date" class="field mono" value=${f.end} min=${f.start} onChange=${e=>{setF({...f,end:e.target.value});setErr('')}}/><//>
      <div class="sm:col-span-2"><${SFld} label="Note (optional)"><input id="lv-note" class="field" placeholder="e.g. Back Monday, first aid course" value=${f.title} onInput=${e=>setF({...f,title:e.target.value})}/><//></div>
      ${clashB&&html`<div class="sm:col-span-2 text-[12.5px] rounded-md px-2.5 py-2" style=${{background:'hsl(38 90% var(--blk-l))'}}>They already have ${KINDS[clashB.kind].label.toLowerCase()} booked ${leaveRange(clashB)}. Add this as well?</div>`}
    </div><//>`;
}

/* ---------- logins: created and reset by the server (api/users.js), which holds Supabase's admin key ---------- */
const LOGIN_ROLES=[['admin','Admin'],['superuser','Superuser'],['planner','Planner'],['supervisor','Supervisor'],['mechanic','Mechanic'],['prestart','Prestart'],['viewer','Viewer']];
const roleKey=r=>r==='operator'?'prestart':r;   /* "operator" was the old name */
const TEMP_PASSWORD='temppass';   /* every new or reset login starts with this; they must choose their own at their first sign-in */
const tempPw=()=>TEMP_PASSWORD;
const suggestLogin=name=>{const w=String(name||'').toLowerCase().replace(/[^a-z\s'-]/g,'').split(/\s+/).filter(Boolean);return w.length>1?(w[0][0]+w[w.length-1]).replace(/[^a-z]/g,''):(w[0]||'')};
async function usersApi(sb,body){
  const {data:{session}}=await sb.auth.getSession();
  let r;try{r=await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(session&&session.access_token||'')},body:JSON.stringify(body)})}
  catch(e){throw new Error('No connection. Try again when you have reception.')}
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('The server said no ('+r.status+').'));return j}
function NewLoginDialog({sb,role,people,linked,person,onDone,onClose}){
  const [f,setF]=useState(()=>({login:person?suggestLogin(person.name):'',password:tempPw(),role:'prestart',staff_id:person?person.id:''}));const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
  const go=async()=>{setErr('');if(!f.login.trim()){setErr('Enter a username, e.g. jsmith.');return}setBusy(true);
    try{const r=await usersApi(sb,{action:'create',...f});onDone({login:f.login.trim().toLowerCase(),password:f.password,warning:r.warning})}catch(e){setErr(e.message||String(e))}finally{setBusy(false)}};
  return html`<${SDialog} title=${person?`Login for ${person.name}`:'New login'} sub="They sign in with the username and temporary password, then choose their own password" onClose=${onClose}
    foot=${html`${err&&html`<span id="lg-new-err" class="text-[12.5px] w-full" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span><button type="button" class="btn" onClick=${onClose}>Cancel</button><button id="lg-new-go" type="button" class="btn btn-primary" disabled=${busy} onClick=${go}>${busy?'Creating…':'Create login'}</button>`}>
    <div class="grid sm:grid-cols-2 gap-3">
      <${SFld} label="Username (or email)"><input id="lg-new-login" class="field" autocapitalize="none" spellcheck="false" placeholder="e.g. jsmith" value=${f.login} onInput=${e=>setF({...f,login:e.target.value})}/><//>
      <${SFld} label="Temporary password"><input id="lg-new-pw" class="field mono" value=${f.password} onInput=${e=>setF({...f,password:e.target.value})}/><//>
      <${SFld} label="Role"><select id="lg-new-role" class="field" value=${f.role} onChange=${e=>setF({...f,role:e.target.value})}>${LOGIN_ROLES.filter(([k])=>k!=='admin'||role==='admin').map(([k,l])=>html`<option key=${k} value=${k}>${l}</option>`)}</select><//>
      <${SFld} label="Staff member"><select id="lg-new-staff" class="field" value=${f.staff_id} disabled=${!!person} onChange=${e=>setF({...f,staff_id:e.target.value})}><option value="">Not linked (e.g. office)</option>${people.map(p=>html`<option key=${p.id} value=${p.id} disabled=${linked.has(p.id)}>${p.name}${linked.has(p.id)?' (has a login)':''}</option>`)}</select><//>
    </div><//>`;
}

/* add or edit a staff member */
function PersonDialog({data,setData,person,onClose,notify,prof,sb,canEdit,admin,myRole,me,onMade,startDel}){
  const isNew=!person;const crews=data.resources.filter(r=>r.type==='crew');
  const [f,setF]=useState(()=>person?{name:person.name,sub:person.sub||'',crewId:person.crewId||'',hue:person.hue}:{name:'',sub:'',crewId:'',hue:HUES[data.resources.length%HUES.length]});
  const [err,setErr]=useState('');const [del,setDel]=useState(!!startDel);
  const canDelLogin=!!(admin&&prof&&prof.id!==me&&!(roleKey(prof.role)==='admin'&&myRole!=='admin'));const [delLogin,setDelLogin]=useState(true);
  const withLogin=isNew&&admin;const [lg,setLg]=useState({on:true,login:'',edited:false,role:'prestart'});const [busy,setBusy]=useState(false);
  const loginName=lg.edited?lg.login:suggestLogin(f.name);
  const leave=person?data.blocks.filter(b=>b.resourceId===person.id).length:0;
  const save=async()=>{if(!f.name.trim()){setErr('Enter their name.');return}
    const id=isNew?'p'+uid():person.id;
    if(withLogin&&lg.on){if(!loginName.trim()){setErr('Enter a username for their login.');return}
      setBusy(true);setErr('');   /* the login first: if the username is taken, nothing is added yet */
      try{const r=await usersApi(sb,{action:'create',login:loginName.trim(),password:TEMP_PASSWORD,role:lg.role,staff_id:id});onMade&&onMade({login:loginName.trim().toLowerCase(),password:TEMP_PASSWORD,warning:r.warning})}
      catch(e){setBusy(false);setErr(e.message||String(e));return}setBusy(false)}
    if(isNew)setData(d=>({...d,resources:[...d.resources,{id,type:'person',name:f.name.trim(),sub:f.sub.trim()||'Crew member',crewId:f.crewId||null,hue:f.hue,visible:true}]}));
    else setData(d=>({...d,resources:d.resources.map(r=>r.id===person.id?{...r,name:f.name.trim(),sub:f.sub.trim(),crewId:f.crewId||null,hue:f.hue}:r)}));
    notify&&notify(isNew?`${f.name.trim()} added`:'Saved');onClose()};
  const remove=async()=>{if(!admin)return;const goLogin=canDelLogin&&delLogin;
    if(goLogin){setBusy(true);setErr('');try{await usersApi(sb,{action:'delete',id:prof.id})}catch(e){setBusy(false);setErr(e.message||String(e));return}setBusy(false)}   /* the login first: if that fails, nothing is removed */
    setData(d=>({...d,resources:d.resources.filter(r=>r.id!==person.id),blocks:d.blocks.filter(b=>b.resourceId!==person.id)}));
    if(prof&&sb&&!goLogin)try{await sb.from('profiles').update({staff_id:null}).eq('id',prof.id)}catch(e){}   /* their login stays, unlinked */
    notify&&notify(`${person.name} deleted${goLogin?' with their login':''}`);onMade&&goLogin&&onMade(null);onClose()};
  return html`<${SDialog} title=${isNew?'Add a staff member':person.name} onClose=${onClose}
    foot=${del?html`<div class="flex-1 min-w-0 grid gap-1" id="pd-del-confirm"><span class="text-[12.5px] font-medium" style=${{color:'var(--bad)'}}>Delete ${person.name}${leave?` and their ${leave} leave booking${leave===1?'':'s'}`:''}? This can’t be undone.</span>
        ${canDelLogin?html`<label class="inline-flex items-center gap-2 text-[12.5px] cursor-pointer"><input id="pd-del-login" type="checkbox" class="w-4 h-4" checked=${delLogin} onChange=${e=>setDelLogin(e.target.checked)}/>Also delete their login <span class="mono">${showLogin(prof.email)}</span></label>`
          :prof?html`<span class="text-[12px] text-muted">Their login stays, unlinked.</span>`:null}
        ${err&&html`<span class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</span>`}</div>
      <button type="button" class="btn" onClick=${()=>{if(startDel)onClose();else{setDel(false);setErr('')}}}>Cancel</button><button id="pd-remove-go" type="button" class="btn" disabled=${busy} style=${{background:'var(--bad)',color:'#fff',borderColor:'var(--bad)'}} onClick=${remove}>${busy?'Deleting…':'Yes, delete'}</button>`
      :html`${!isNew&&canEdit&&admin&&html`<button id="pd-remove" type="button" class="btn" style=${{color:'var(--bad)'}} onClick=${()=>{setDel(true);setErr('')}}>${Icon.trash} Delete</button>`}${err&&html`<span class="text-[12.5px]" style=${{color:'var(--bad)'}}>${err}</span>`}<span class="flex-1"></span>
        <button type="button" class="btn" onClick=${onClose}>${canEdit?'Cancel':'Close'}</button>${canEdit&&html`<button id="pd-save" type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>${busy?'Adding…':isNew?(withLogin&&lg.on?'Add with login':'Add staff member'):'Save'}</button>`}`}>
    <fieldset disabled=${!canEdit} class="m-0 p-0 border-0 min-w-0 grid sm:grid-cols-2 gap-3">
      <${SFld} label="Name"><input id="pd-name" class="field" placeholder="Full name" value=${f.name} onInput=${e=>setF({...f,name:e.target.value})}/><//>
      <${SFld} label="Position"><input id="pd-sub" class="field" placeholder="e.g. Roller operator" value=${f.sub} onInput=${e=>setF({...f,sub:e.target.value})}/><//>
      <${SFld} label="Crew"><select id="pd-crew" class="field" value=${f.crewId} onChange=${e=>setF({...f,crewId:e.target.value})}><option value="">No crew</option>${crews.map(c=>html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}</select><//>
      <${SFld} label="Colour"><div class="flex flex-wrap gap-1.5 pt-1">${HUES.map(h=>html`<button key=${h} type="button" class="w-6 h-6 rounded-full" aria-label=${'Colour '+h} aria-pressed=${f.hue===h} style=${{background:`hsl(${h} 65% 55%)`,boxShadow:f.hue===h?'0 0 0 2px var(--surface),0 0 0 4px var(--ink)':'none'}} onClick=${()=>setF({...f,hue:h})}></button>`)}</div><//>
      ${withLogin&&html`<div class="sm:col-span-2 rounded-lg border border-line p-3 grid sm:grid-cols-2 gap-3" id="pd-login">
        <label class="sm:col-span-2 inline-flex items-center gap-2 text-[13px] font-medium cursor-pointer"><input id="pd-login-on" type="checkbox" class="w-4 h-4" checked=${lg.on} onChange=${e=>setLg({...lg,on:e.target.checked})}/>Create their login</label>
        ${lg.on&&html`<${SFld} label="Username"><input id="pd-login-name" class="field mono" autocapitalize="none" spellcheck="false" placeholder="e.g. jsmith" value=${loginName} onInput=${e=>setLg({...lg,login:e.target.value,edited:true})}/><//>
          <${SFld} label="Role"><select id="pd-login-role" class="field" value=${lg.role} onChange=${e=>setLg({...lg,role:e.target.value})}>${LOGIN_ROLES.filter(([k])=>k!=='admin'||myRole==='admin').map(([k,l])=>html`<option key=${k} value=${k}>${l}</option>`)}</select><//>
          <div class="sm:col-span-2 text-[12px] text-muted">They sign in with this username and the password <span class="mono font-semibold text-ink">${TEMP_PASSWORD}</span>, then choose their own.</div>`}
      </div>`}
    </fieldset><//>`;
}

/* the People view: everyone on staff, their crew and leave, and (administrators) their login */
function StaffPeople({data,setData,live,notify,onAddLeave}){
  const admin=!!live&&(live.role==='admin'||live.role==='superuser');const canEdit=live?live.canEdit:true;const sb=live&&live.sb;const me=live&&live.user.id;const myRole=live&&live.role;
  const [profs,setProfs]=useState(null);const [perr,setPerr]=useState('');const [dlg,setDlg]=useState(null);const [made,setMade]=useState(null);
  const [reset,setReset]=useState(null);const [busy,setBusy]=useState(false);const [q,setQ]=useState('');const [crew,setCrew]=useState('');const [delL,setDelL]=useState(null);
  const doDelLogin=async p=>{setBusy(true);setPerr('');try{await usersApi(sb,{action:'delete',id:p.id});notify(`Login ${showLogin(p.email)} deleted`);setDelL(null);setMade(null);load()}catch(e){setPerr(e.message)}finally{setBusy(false)}};
  const delLoginCtl=p=>p.id===me||(roleKey(p.role)==='admin'&&myRole!=='admin')?null:delL===p.id
    ?html`<span class="inline-flex items-center gap-1.5 lg-del-confirm"><span class="text-[12px] font-medium" style=${{color:'var(--bad)'}}>Delete ${showLogin(p.email)}? They can’t sign in any more.</span><button type="button" class="btn" style=${{height:30}} onClick=${()=>setDelL(null)}>Cancel</button><button type="button" class="btn lg-del-yes" style=${{height:30,background:'var(--bad)',color:'#fff',borderColor:'var(--bad)'}} disabled=${busy} onClick=${()=>doDelLogin(p)}>${busy?'Deleting…':'Yes, delete'}</button></span>`
    :html`<button type="button" class="text-[12px] hover:underline lg-del" style=${{color:'var(--bad)',marginLeft:14}} onClick=${()=>{setDelL(p.id);setReset(null)}}>Delete</button>`;
  const load=async()=>{if(!admin)return;const {data:r,error}=await sb.from('profiles').select('*');if(error){setPerr(error.message);return}setProfs(r||[]);setPerr('')};
  useEffect(()=>{load()},[]);
  const saveProf=async(p,patch)=>{setPerr('');const {error}=await sb.from('profiles').update(patch).eq('id',p.id);if(error)setPerr(error.message);else notify('Login updated');load()};
  const doReset=async p=>{setBusy(true);setPerr('');try{await usersApi(sb,{action:'reset',id:p.id,password:reset.password});setMade({login:showLogin(p.email),password:reset.password,reset:true});setReset(null)}catch(e){setPerr(e.message)}finally{setBusy(false)}};
  const people=data.resources.filter(r=>r.type==='person');const byId=new Map(people.map(p=>[p.id,p]));
  const crews=data.resources.filter(r=>r.type==='crew');const crewName=id=>(crews.find(c=>c.id===id)||{}).name;
  const profOf=new Map((profs||[]).filter(p=>p.staff_id).map(p=>[p.staff_id,p]));const linked=new Set(profOf.keys());
  const loose=(profs||[]).filter(p=>!p.staff_id||!byId.has(p.staff_id)).sort((a,b)=>LOGIN_ROLES.findIndex(([k])=>k===roleKey(a.role))-LOGIN_ROLES.findIndex(([k])=>k===roleKey(b.role))||showLogin(a.email).localeCompare(showLogin(b.email)));
  const today=iso(TODAY);
  const leaveOf=p=>{const bs=data.blocks.filter(b=>b.resourceId===p.id&&LEAVE_KINDS.includes(b.kind)&&b.end>=today).sort((a,b)=>a.start.localeCompare(b.start));const b=bs[0];if(!b)return null;
    return b.start<=today?{now:true,b,t:`${KINDS[b.kind].label} · back ${fmtShort(addDays(parse(b.end),1))}`}:{b,t:`${KINDS[b.kind].label} ${leaveRange(b)}`}};
  const ql=q.trim().toLowerCase();
  const roleRank=p=>{const pr=profOf.get(p.id);if(!pr)return 99;const i=LOGIN_ROLES.findIndex(([k])=>k===roleKey(pr.role));return i<0?98:i};
  const list=people.filter(p=>(!crew||(crew==='~'?!p.crewId:p.crewId===crew))&&(!ql||[p.name,p.sub,crewName(p.crewId),profOf.get(p.id)&&showLogin(profOf.get(p.id).email)].join(' ').toLowerCase().includes(ql)))
    .sort((a,b)=>roleRank(a)-roleRank(b)||a.name.localeCompare(b.name));   /* by login role (admin first, no login last), then name */
  const roleSel=p=>{const self=p.id===me;const lock=self||(roleKey(p.role)==='admin'&&myRole!=='admin');
    return html`<select class="field w-auto lg-role" style=${{height:30,fontSize:12.5}} value=${roleKey(p.role)} disabled=${lock} title=${self?'You can’t change your own role':lock?'Only the admin can change this':''} onChange=${e=>saveProf(p,{role:e.target.value})} aria-label=${'Role for '+showLogin(p.email)}>
      ${LOGIN_ROLES.filter(([k])=>k!=='admin'||myRole==='admin'||roleKey(p.role)==='admin').map(([k,l])=>html`<option key=${k} value=${k}>${l}</option>`)}</select>`};
  const resetCtl=p=>p.id===me||(roleKey(p.role)==='admin'&&myRole!=='admin')?null:reset&&reset.id===p.id
    ?(reset.sure   /* second step: confirm */
      ?html`<span class="inline-flex items-center gap-1.5 lg-reset-confirm"><span class="text-[12px] font-medium" style=${{color:'var(--bad)'}}>Reset ${showLogin(p.email)}’s password? Their current one stops working.</span><button type="button" class="btn" style=${{height:30}} onClick=${()=>setReset(null)}>Cancel</button><button type="button" class="btn lg-reset-yes" style=${{height:30,background:'var(--bad)',color:'#fff',borderColor:'var(--bad)'}} disabled=${busy} onClick=${()=>doReset(p)}>${busy?'Resetting…':'Yes, reset'}</button></span>`
      :html`<span class="inline-flex items-center gap-1.5"><input class="field mono lg-reset-pw" style=${{height:30,fontSize:12.5,width:170}} value=${reset.password} onInput=${e=>setReset({...reset,password:e.target.value})} aria-label="New temporary password"/><button type="button" class="btn" style=${{height:30}} onClick=${()=>setReset(null)}>Cancel</button><button type="button" class="btn btn-primary lg-reset-go" style=${{height:30}} onClick=${()=>{if((reset.password||'').length<8){setPerr('The temporary password needs at least 8 characters.');return}setPerr('');setReset({...reset,sure:true})}}>Reset</button></span>`)
    :html`<button type="button" class="text-[12px] text-muted hover:text-ink lg-reset" onClick=${()=>{setReset({id:p.id,password:tempPw()});setMade(null)}}>Reset password…</button>`;
  return html`<div class="flex-1 min-h-0 overflow-y-auto grid gap-3 content-start" id="staff-people">
    <section class="panel flex flex-col min-h-0">
      <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line">
        <input id="sp-search" class="field" style=${{height:32,fontSize:13,width:230}} placeholder=${admin?'Search name, position, crew, username':'Search name, position, crew'} value=${q} onInput=${e=>setQ(e.target.value)} aria-label="Search staff"/>
        <select class="field w-auto" style=${{height:32,fontSize:13}} value=${crew} onChange=${e=>setCrew(e.target.value)} aria-label="Crew"><option value="">All crews</option>${crews.map(c=>html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}<option value="~">No crew</option></select>
        <span class="text-[12.5px] text-muted">${list.length} of ${people.length}</span><span class="flex-1"></span>
        ${canEdit&&html`<button id="sp-add" type="button" class="btn btn-primary" onClick=${()=>setDlg({k:'person'})}>${Icon.plus} Add staff member</button>`}
      </div>
      ${made&&html`<div id="lg-made" class="px-3 py-2.5 border-b border-line text-[13px] flex flex-wrap items-center gap-2" style=${{background:'hsl(145 50% var(--blk-l))'}}>
        <span class="flex-1">${made.reset?'Password reset.':'Login created.'} Give <span class="font-semibold">${made.login}</span> the temporary password <span class="mono font-semibold">${made.password}</span>. They choose their own when they sign in.${made.warning?html` <span style=${{color:'var(--bad)'}}>${made.warning}</span>`:''}</span>
        <button type="button" class="text-[12px] text-muted hover:text-ink" onClick=${()=>setMade(null)}>Done</button></div>`}
      ${perr&&html`<div id="lg-err" class="px-3 py-2 text-[12.5px]" style=${{color:'var(--bad)'}}>${perr}</div>`}
      <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="sp-table">
        <thead><tr class="text-left">${['Name','Crew','Leave',...(admin?['Login','Role','']:[]),...(canEdit&&admin?['']:[])].map((h,i)=>html`<th key=${i} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
        <tbody>${list.map(p=>{const lv=leaveOf(p);const pr=profOf.get(p.id);
          return html`<tr key=${p.id} class="border-t border-line" data-person=${p.name}>
            <td class="py-2 px-3"><button type="button" class="flex items-center gap-2.5 text-left sp-open" onClick=${()=>setDlg({k:'person',p})}><${Badge} r=${p} size=${28}/><span class="min-w-0"><span class="block font-medium text-[13px] hover:underline">${p.name}</span><span class="block text-[11.5px] text-muted">${p.sub||''}</span></span></button></td>
            <td class="py-2 px-3 whitespace-nowrap">${crewName(p.crewId)||html`<span class="text-faint">–</span>`}</td>
            <td class="py-2 px-3 whitespace-nowrap">${lv?html`<span class="text-[12px]" style=${lv.now?{color:'hsl(28 80% 40%)',fontWeight:600}:{color:'var(--muted)'}}>${lv.now?'Away: ':'Next: '}${lv.t}</span>`:html`<span class="text-faint">–</span>`}</td>
            ${admin&&(profs==null?html`<td colspan="3" class="py-2 px-3 text-muted">…</td>`:pr?html`<td class="py-2 px-3 mono whitespace-nowrap sp-login">${showLogin(pr.email)}${pr.id===me?html` <span class="text-muted font-sans">(you)</span>`:''}</td><td class="py-2 px-3">${roleSel(pr)}</td><td class="py-2 px-3 text-right whitespace-nowrap">${resetCtl(pr)}</td>`
              :html`<td class="py-2 px-3 text-faint">No login</td><td></td><td class="py-2 px-3 text-right"><button type="button" class="btn sp-newlogin" style=${{height:30}} onClick=${()=>{setMade(null);setDlg({k:'login',p})}}>${Icon.plus} Create login</button></td>`)}
            ${canEdit&&admin&&html`<td class="py-2 pl-1 pr-3 text-right w-0"><button type="button" class="sp-del w-8 h-8 inline-flex items-center justify-center rounded-md hover:opacity-70" style=${{color:'var(--bad)'}} title=${'Delete '+p.name} aria-label=${'Delete '+p.name} onClick=${()=>setDlg({k:'person',p,del:true})}>${Icon.trash}</button></td>`}
</tr>`})}
          ${!list.length&&html`<tr><td colspan="7" class="px-3 py-6 text-center text-muted">${people.length?'No staff match.':'No staff yet.'+(canEdit?' Add your first staff member.':'')}</td></tr>`}</tbody></table></div>
    </section>
    ${admin&&profs&&html`<section class="panel flex flex-col min-h-0" id="sp-loose">
      <div class="px-3 pt-3 pb-2 flex flex-wrap items-center gap-2 border-b border-line"><h3 class="font-display text-[15px] font-semibold">Logins without a staff member</h3><span class="text-[12px] text-muted">e.g. office staff. Link a login to someone on staff so their prestarts carry their name.</span><span class="flex-1"></span>
        <button id="lg-add" type="button" class="btn" onClick=${()=>{setMade(null);setDlg({k:'login'})}}>${Icon.plus} New login</button></div>
      <div class="overflow-x-auto"><table class="w-full text-[12.5px]" id="lg-table">
        <thead><tr class="text-left">${['Username','Role','Staff member',''].map((h,i)=>html`<th key=${i} class="label font-normal py-2 px-3 whitespace-nowrap">${h}</th>`)}</tr></thead>
        <tbody>${loose.map(p=>html`<tr key=${p.id} class="border-t border-line" data-email=${p.email}>
          <td class="py-2 px-3 mono whitespace-nowrap">${showLogin(p.email)}${p.id===me?html` <span class="text-muted font-sans">(you)</span>`:''}</td>
          <td class="py-2 px-3">${roleSel(p)}</td>
          <td class="py-2 px-3"><select class="field w-auto lg-staff" style=${{height:30,fontSize:12.5,minWidth:190}} value="" onChange=${e=>e.target.value&&saveProf(p,{staff_id:e.target.value})} aria-label=${'Link '+showLogin(p.email)+' to a staff member'}><option value="">Link to…</option>${people.filter(x=>!linked.has(x.id)).sort((a,b)=>a.name.localeCompare(b.name)).map(x=>html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}</select></td>
          <td class="py-2 px-3 text-right whitespace-nowrap">${delL===p.id?null:resetCtl(p)}${reset&&reset.id===p.id?null:delLoginCtl(p)}</td></tr>`)}
          ${!loose.length&&html`<tr><td colspan="4" class="px-3 py-4 text-center text-muted">Every login belongs to someone on staff.</td></tr>`}</tbody></table></div>
    </section>`}
    ${dlg&&dlg.k==='person'&&html`<${PersonDialog} key=${(dlg.p?dlg.p.id:'new')+(dlg.del?':del':'')} data=${data} setData=${setData} person=${dlg.p} prof=${dlg.p&&profOf.get(dlg.p.id)} sb=${sb} canEdit=${canEdit} admin=${admin} myRole=${myRole} me=${me} startDel=${dlg.del} onMade=${m=>{setMade(m);load()}} notify=${notify} onClose=${()=>setDlg(null)}/>`}
    ${dlg&&dlg.k==='login'&&html`<${NewLoginDialog} sb=${sb} role=${myRole} people=${people.slice().sort((a,b)=>a.name.localeCompare(b.name))} linked=${linked} person=${dlg.p} onClose=${()=>setDlg(null)} onDone=${m=>{setDlg(null);setMade(m);load()}}/>`}
  </div>`;
}

function OfflineBar({at}){
  const [on,setOn]=useState(navigator.onLine);
  useEffect(()=>{const a=()=>setOn(true),b=()=>setOn(false);window.addEventListener('online',a);window.addEventListener('offline',b);return()=>{window.removeEventListener('online',a);window.removeEventListener('offline',b)}},[]);
  return html`<div id="offline-bar" class="mb-2 rounded-lg px-3 py-2 text-[13px] flex flex-wrap items-center gap-2" style=${{background:on?'hsl(145 50% var(--blk-l))':'hsl(38 90% var(--blk-l))',color:'var(--ink)'}}>
    ${on?html`<span class="flex-1">You’re back online.</span><button type="button" class="btn" style=${{height:30}} onClick=${()=>location.reload()}>Reload</button>`
      :html`<span class="flex-1"><span class="font-semibold">No reception:</span> showing the copy saved on this device ${at?new Date(at).toLocaleString('en-AU',{weekday:'short',hour:'numeric',minute:'2-digit'}):''}. Prestarts still work: they send when you’re back online.</span>`}</div>`;
}
function App({boot,live}){
  /* ---- live data: local state, saved to Supabase, kept current with everyone else's changes ---- */
  const [data,setDataRaw]=useState(()=>({...boot,sectionOrder:boot.sectionOrder||[...DEFAULT_ORDER]}));
  const savedRef=useRef(data),remoteRef=useRef(null),pushQ=useRef(Promise.resolve());
  const setData=fn=>setDataRaw(cur=>{const next=typeof fn==='function'?fn(cur):fn;
    /* view-only people may only add suggestions */
    const noSugg=d=>({...d,suggestions:[]});const onlySugg=sharedKey(noSugg(next))===sharedKey(noSugg(cur))&&(cur.suggestions||[]).every(x=>(next.suggestions||[]).some(y=>y.id===x.id));
    if(!live.canEdit&&!onlySugg){setTimeout(()=>setToast(live.offline?'You’re offline: changes can’t be saved until you have reception again.':'You have view-only access. Ask an administrator for planner access to make changes.'),0);return cur}
    return withChangeLog(cur,next,live.user.email)});
  window.__rosterMe=live.user.email;
  const reloadAll=async()=>{try{const nd={...rowsToData(await fetchAllRows(live.sb))};nd.sectionOrder=nd.sectionOrder||[...DEFAULT_ORDER];setDataRaw(cur=>{const x={...nd,alerts:cur.alerts};remoteRef.current=x;return x})}catch(e){}};
  useMachineAlerts(live,fn=>setDataRaw(cur=>{const nd=fn(cur);if(nd!==cur)remoteRef.current=nd;return nd}));
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
  const [panel,setPanel]=useState(false);   /* the Settings panel starts closed every time FraserFlow opens */
  useEffect(()=>{try{localStorage.setItem(KEY+':panel',panel?'shown':'hidden')}catch(e){}},[panel]);
  const [tab,setTab]=useState('crew');
  /* the side panel shows either Settings (crews, mixes, trucks…) or Jobs; each header button opens its own view and closes it when pressed again */
  const lastSet=useRef('crew');useEffect(()=>{if(tab!=='jobs')lastSet.current=tab},[tab]);
  const panelOpen=()=>{let wide=true;try{wide=window.matchMedia('(min-width: 1024px)').matches}catch(e){}return wide?panel:drawer};
  const showPanel=v=>{let wide=true;try{wide=window.matchMedia('(min-width: 1024px)').matches}catch(e){}if(wide)setPanel(v);else setDrawer(v)};
  const toggleResources=()=>{if(tab==='jobs'){setTab(lastSet.current||'crew');showPanel(true)}else showPanel(!panelOpen())};
  const toggleJobs=()=>{if(tab==='jobs'&&panelOpen())showPanel(false);else{setTab('jobs');showPanel(true)}};
  /* roll "today" over at midnight when the page stays open */
  const [,setDayTick]=useState(0);
  useEffect(()=>{const chk=()=>{const n=new Date();if(iso(n)!==iso(TODAY)){n.setHours(12,0,0,0);TODAY=n;setDayTick(x=>x+1)}};
    const t=setInterval(chk,60000);document.addEventListener('visibilitychange',chk);window.addEventListener('focus',chk);
    return()=>{clearInterval(t);document.removeEventListener('visibilitychange',chk);window.removeEventListener('focus',chk)}},[]);
  /* which screen of the left menu is open (remembered in this browser) */
  const isAdmin=live.role==='admin'||live.role==='superuser';   /* superusers have the admin's powers */
  const [screen,setScreen]=useState(()=>{try{const v=localStorage.getItem(KEY+':screen');return screenOK(v,live.role,boot)?v:homeScreen(live.role,boot)}catch(e){return homeScreen(live.role,boot)}});
  /* Staff screen: the leave calendar, or the People list (staff and their logins) */
  const [staffView,setStaffView0]=useState(()=>{try{return localStorage.getItem(KEY+':staff-view')==='people'?'people':'leave'}catch(e){return 'leave'}});
  const setStaffView=v=>{setStaffView0(v);try{localStorage.setItem(KEY+':staff-view',v)}catch(e){}};
  const [leaveDlg,setLeaveDlg]=useState(null);   /* {personId} while adding leave */
  const peopleView=screen==='staff'&&staffView==='people';
  /* Fleet's section (remembered); its Calendar is the machine board */
  const [fleetTab,setFleetTab0]=useState(()=>{try{const v=localStorage.getItem(KEY+':fleet-tab');return FLEET_TABS.some(t=>t[0]===v)?v:'dash'}catch(e){return 'dash'}});
  const setFleetTab=v=>{setFleetTab0(v);try{localStorage.setItem(KEY+':fleet-tab',v)}catch(e){}};
  const [fleetCounts,setFleetCounts]=useState({});const [fleetAsset,setFleetAsset]=useState(null);
  const fleetCal=screen==='fleet'&&fleetTab==='cal';
  const boardScreen=screen!=='planning'&&screen!=='ideas'&&screen!=='jobs'&&(screen!=='fleet'||fleetCal)&&screen!=='prestarts'&&!peopleView;   /* the date controls and + Booking belong to the board screens */
  const goScreen=k=>{setScreen(k);try{localStorage.setItem(KEY+':screen',k)}catch(e){}
    const t=SCREENS[k].tab;if(t)setTab(t);else if(tab==='person'||tab==='machine')setTab('crew')};
  useEffect(()=>{const t=SCREENS[screen].tab;if(t&&tab!==t)setTab(t);else if(!t&&(tab==='person'||tab==='machine'))setTab('crew')},[screen,tab]);
  useEffect(()=>{if(!screenOK(screen,live.role,data)){if(screen==='machines'&&screenOK('fleet',live.role,data)){setFleetTab('cal');goScreen('fleet')}else goScreen(homeScreen(live.role,data))}},[screen,data.previewOnly,data.previewKnown]);
  const openFleetAsset=screenOK('fleet',live.role,data)?id=>{setFleetAsset({id,n:Date.now()});if(fleetTab==='cal')setFleetTab('dash');goScreen('fleet')}:null;
  const SCR=fleetCal?{...SCREENS.machines,title:SCREENS.fleet.title}:SCREENS[screen];
  useEffect(()=>{document.title='FraserFlow - '+SCR.title},[screen]);
  const [renameId,setRenameId]=useState(null);
  const [exporting,setExporting]=useState(null);
  const [importing,setImporting]=useState(false);const [merging,setMerging]=useState(false);const [logOpen,setLogOpen]=useState(false);const [machImport,setMachImport]=useState(false);
  const [forecast,setForecast]=useState(false);const [suggest,setSuggest]=useState(false);const [subWorksOpen,setSubWorksOpen]=useState(false);const [program,setProgram]=useState(false);
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
    setEditing({resourceId,start,end,kind:TYPES[t].def,jobId:data.jobs.length?'':'__new',title:'',address:'',plantIds:[]});   /* no job picked: choose one or make a new one */   /* shift is picked in the booking (required) */
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
    d=learnProgramLists(d,b);
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
    <${NavRail} screen=${screen} go=${goScreen} isAdmin=${isAdmin} role=${live.role} data=${data} badge=${{ideas:(data.suggestions||[]).length}}/>
    <div id="resources-panel" class=${'hidden w-[300px] shrink-0 h-full'+(panel&&screen!=='ideas'&&screen!=='jobs'&&(screen!=='fleet'||fleetCal)&&screen!=='prestarts'&&screen!=='staff'?' lg:block':'')}><${Sidebar} screen=${screen} notify=${setToast} onMaint=${openFleetAsset} onImportMachines=${()=>setMachImport(true)} data=${data} setData=${setData} days=${days} tab=${tab} setTab=${setTab} renameId=${renameId} setRenameId=${setRenameId} onImport=${()=>setImporting(true)} onMerge=${()=>setMerging(true)}/></div>
    ${drawer&&html`<div class="lg:hidden fixed inset-0 z-40 backdrop" onPointerDown=${e=>{if(e.target===e.currentTarget)setDrawer(false)}}>
      <div class="h-full w-[min(330px,90vw)] p-3" style=${{paddingLeft:'max(12px, env(safe-area-inset-left, 0px))',paddingTop:'max(12px, env(safe-area-inset-top, 0px))',paddingBottom:'max(12px, env(safe-area-inset-bottom, 0px))'}}>
        <${Sidebar} screen=${screen} notify=${setToast} onMaint=${openFleetAsset} onImportMachines=${()=>setMachImport(true)} data=${data} setData=${setData} days=${days} tab=${tab} setTab=${setTab} renameId=${renameId} setRenameId=${setRenameId} onImport=${()=>setImporting(true)} onMerge=${()=>setMerging(true)} onClose=${()=>setDrawer(false)}/></div></div>`}

    <main class="flex-1 min-w-0 h-full flex flex-col gap-3">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="flex items-center gap-2.5 shrink-0 pr-3 border-r border-line" title="Alex Fraser Group · Building greener roads">
          <img src=${BRAND_OVAL} alt="Alex Fraser Group" class="block h-[50px] w-auto select-none" draggable="false"/>
          <img src=${BRAND_TAG} alt="Building greener roads" class="brand-tag hidden xl:block h-[30px] w-auto select-none" draggable="false"/>
        </div>
        ${screen!=='ideas'&&screen!=='jobs'&&(screen!=='fleet'||fleetCal)&&screen!=='prestarts'&&screen!=='staff'&&live.role!=='prestart'&&(on=>html`<button id="btn-settings" class="btn" onClick=${toggleResources} aria-pressed=${on} aria-controls="resources-panel"
          title=${on?'Hide Settings':'Crews, plant, mixes, seal, trucks and subcontractors'}
          style=${on?{background:'var(--sunken)',borderColor:'var(--line-strong)'}:null}>${Icon.gear} Settings</button>`)(panel&&tab!=='jobs')}
        ${screen==='schedule'&&html`<${ExportsMenu} items=${[{id:'exp-program',label:'Daily program',desc:'PDF for each job working on a day',run:()=>setProgram(true)},
          ...(data.resources.some(r=>r.type==='crew'&&r.subbie)?[{id:'exp-subworks',label:'Subbie works',desc:'Upcoming works for a subcontractor crew',run:()=>setSubWorksOpen(true)}]:[])]}/>`}
        <div class="flex items-center gap-2 min-w-0">
          <h1 class="font-display font-semibold tracking-tight truncate text-[22px] leading-none">Fraser<span style=${{color:'var(--accent)'}}>Flow</span><span class="text-faint font-normal"> - </span>${SCR.title}</h1>
          ${!live.canEdit&&screen!=='prestarts'&&(screen!=='fleet'||fleetCal)&&!peopleView&&html`<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sunken border border-line text-muted" title="You can look but not change the schedule">View only</span>`}
        </div>
        <div class="flex-1"></div>
        ${boardScreen&&html`<div class="seg" role="group" aria-label="View length">
          <button aria-pressed=${view===7} onClick=${()=>pickView(7)}>Week</button>
          <button aria-pressed=${view===14} onClick=${()=>pickView(14)}>14 days</button>
          <button aria-pressed=${view===30} onClick=${()=>pickView(30)}>30 days</button>
          <button aria-pressed=${view===60} onClick=${()=>pickView(60)}>2 months</button>
        </div>
        <div class="flex items-center gap-1">
          <button class="btn px-2" onClick=${()=>move(-1)} aria-label=${view===60?'Previous month':'Previous'}>${Icon.chevL}</button>
          <button class="btn" onClick=${()=>setAnchor(mondayOf(TODAY))} disabled=${atToday}>Today</button>
          <button class="btn px-2" onClick=${()=>move(1)} aria-label=${view===60?'Next month':'Next'}>${Icon.chevR}</button>
        </div>`}
        ${live.role!=='prestart'&&html`<button id="btn-suggest" class="btn px-2" onClick=${()=>setSuggest(true)} title="Suggest an idea for FraserFlow" aria-label="Suggest an idea">${NAV_ICON.ideas}</button>`}
        ${live.role!=='prestart'&&html`<${Notifications} data=${data} onOpen=${b=>setEditing(b)} maint=${MAINT_ROLES.includes(live.role)&&screenOK('fleet',live.role,data)} onMaint=${openFleetAsset} prefs=${notifPrefs} setPrefs=${p=>{setNotifPrefs(p);try{localStorage.setItem(NOTIF_KEY,JSON.stringify(p))}catch(e){}}}/>`}
        ${boardScreen&&screen==='staff'&&html`<button id="btn-add-leave" class="btn btn-primary" disabled=${!live.canEdit} onClick=${()=>setLeaveDlg({})}>${Icon.plus} Add leave</button>`}
        ${boardScreen&&screen!=='staff'&&html`<button class="btn btn-primary" disabled=${!first} onClick=${()=>onCreate({resourceId:(vis(screen==='staff'?'person':screen==='machines'||screen==='fleet'?'machine':'crew')[0]||first).id,start:iso(onThisRange?TODAY:days[0]),end:iso(onThisRange?TODAY:days[0])})}>${Icon.plus} Booking</button>`}
        ${screen==='schedule'&&html`<button class="btn" onClick=${()=>setForecast(true)} title="Paving forecast for the next two months">${Icon.chart} Forecast</button>`}
        <${SettingsMenu} simple=${live.role==='prestart'} maint=${MAINT_ROLES.includes(live.role)&&screenOK('fleet',live.role,data)} theme=${theme} toggleTheme=${toggleTheme} prefs=${notifPrefs} setPrefs=${p=>{setNotifPrefs(p);try{localStorage.setItem(NOTIF_KEY,JSON.stringify(p))}catch(e){}}} account=${{email:live.user.email,role:live.role,onChangePw:()=>setChangePw(true),onSignOut:()=>live.sb.auth.signOut()}} onLog=${isAdmin?()=>setLogOpen(true):null} preview=${live.role==='admin'?{list:previewOf(data),set:l=>setData(d=>({...d,previewOnly:l,previewKnown:previewKeys()}))}:null}/>
      </header>

      ${live.offline&&html`<${OfflineBar} at=${live.offline.at}/>`}
      ${screen==='staff'&&html`<div class="flex flex-wrap items-center gap-2"><div class="seg" role="tablist" aria-label="Staff sections">
        <button id="sv-leave" type="button" role="tab" aria-selected=${!peopleView} aria-pressed=${!peopleView} onClick=${()=>setStaffView('leave')}>Leave calendar</button>
        <button id="sv-people" type="button" role="tab" aria-selected=${peopleView} aria-pressed=${peopleView} onClick=${()=>setStaffView('people')}>People</button></div></div>`}
      ${screen==='fleet'&&html`<div class="flex flex-wrap items-center gap-2"><div class="seg flex-wrap" role="tablist" aria-label="Fleet sections">${FLEET_TABS.map(([k,l])=>html`<button key=${k} id=${'fl-tab-'+k} type="button" role="tab" aria-selected=${fleetTab===k} aria-pressed=${fleetTab===k} onClick=${()=>setFleetTab(k)}>${l}${k==='wo'&&fleetCounts.wo!=null?html` <span class="mono text-[11px] text-faint">${fleetCounts.wo}</span>`:k==='df'&&fleetCounts.df!=null?html` <span class="mono text-[11px] text-faint">${fleetCounts.df}</span>`:''}</button>`)}</div></div>`}
      ${leaveDlg&&html`<${LeaveDialog} data=${data} setData=${setData} notify=${setToast} personId=${leaveDlg.personId} onClose=${()=>setLeaveDlg(null)}/>`}
      ${peopleView?html`<${StaffPeople} data=${data} setData=${setData} live=${live} notify=${setToast} onAddLeave=${id=>setLeaveDlg({personId:id})}/>`:(screen==='fleet'&&!fleetCal)||screen==='prestarts'?html`<${LazyFleet} key=${screen} comp=${screen==='prestarts'?'PrestartScreen':'FleetScreen'} data=${data} live=${live} notify=${setToast} setData=${setData} tab=${fleetTab} onCounts=${setFleetCounts} assetReq=${fleetAsset} onImportMachines=${()=>setMachImport(true)}/>`:screen==='jobs'?html`<${JobsScreen} data=${data} setData=${setData} notify=${setToast} onEditBooking=${b=>setEditing(b)} onOpenPlan=${id=>{try{localStorage.setItem(KEY+':plan',id)}catch(e){}goScreen('planning')}}/>`:screen==='ideas'?html`<${IdeasScreen} data=${data} setData=${setData} notify=${setToast}/>`:screen==='planning'?html`<${PlanningScreen} data=${data} setData=${setData} notify=${setToast} onOpenBooking=${id=>{const bk=data.blocks.find(x=>x.id===id);if(bk)setEditing(bk)}}/>`:html`
      ${screen==='staff'?(()=>{const L=leaveStats(data);return html`<section class="panel px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3" id="leave-stats">
        <${Stat} k="Away today" v=${L.today.length} sub=${L.today.length?L.today.map(x=>`${x.p.name.split(' ')[0]} (back ${fmtShort(addDays(parse(x.b.end),1))})`).join(', '):'everyone in'} tone=${L.today.length?'var(--warn)':null}/>
        <${Stat} k="Away this week" v=${L.week.length} sub=${L.week.length?`${L.weekDays} staff-day${L.weekDays===1?'':'s'} · ${L.week.map(p=>p.name.split(' ')[0]).join(', ')}`:'no leave this week'}/>
        <${Stat} k="Coming up (4 weeks)" v=${L.soon.length} sub=${L.soon.length?L.soon.slice(0,3).map(x=>`${x.p.name.split(' ')[0]} ${fmtShort(parse(x.b.start))}`).join(', ')+(L.soon.length>3?` +${L.soon.length-3} more`:''):'nothing booked'}/>
        <${Stat} k="Showing" v=${html`<span class="text-[16px]">${fmtRange(days[0],days[N-1])}</span>`} sub=""/>
      </section>`})():fleetCal?(()=>{const ms=vis('machine');const t=iso(TODAY);const on=ms.filter(m=>data.blocks.some(b=>b.start<=t&&b.end>=t&&(b.resourceId===m.id||(b.plantIds||[]).includes(m.id))&&!(KINDS[b.kind]&&KINDS[b.kind].down)));
        return html`<section class="panel px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3" id="fleet-cal-stats">
        <${Stat} k="Machines on jobs today" v=${`${on.length}/${ms.length}`} sub=${on.length?on.slice(0,4).map(m=>m.name).join(', ')+(on.length>4?` +${on.length-4} more`:''):'none booked'}/>
        <${Stat} k="Machines down today" v=${downToday.length} sub=${downToday.length?downToday.map(m=>m.name).join(', '):'all available'} tone=${downToday.length?'var(--bad)':null}/>
        <${Stat} k="Free today" v=${Math.max(0,ms.length-on.length-downToday.length)} sub="not booked or down"/>
        <${Stat} k="Showing" v=${html`<span class="text-[16px]">${fmtRange(days[0],days[N-1])}</span>`} sub=""/>
      </section>`})():html`<section class="panel px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
        <${Stat} k="Crews on jobs today" v=${`${crewsOnJob.length}/${vis('crew').length}`} sub=${`${util}% of crew-days booked`}/>
        <${Stat} k="Machines down today" v=${downToday.length} sub=${downToday.length?downToday.map(m=>m.name).join(', '):'all available'} tone=${downToday.length?'var(--bad)':null}/>
        <${Stat} k="Staff away today" v=${awayToday.length} sub=${awayToday.length?awayToday.map(m=>m.name.split(' ')[0]).join(', '):'full strength'} tone=${awayToday.length?'var(--warn)':null}/>
        <${Stat} k="Showing" v=${html`<span class="text-[16px]">${fmtRange(days[0],days[N-1])}</span>`} sub=""/>
      </section>`}

      <section class="panel flex-1 min-h-[320px] flex flex-col overflow-hidden">
        <${Board} data=${data} days=${days} view=${view} onCreate=${onCreate} onEdit=${b=>setEditing(b)} onMove=${onMove} onRename=${onRename} onReorder=${onReorder} onExport=${wks=>setExporting(wks)} notifPrefs=${notifPrefs} only=${SCR.only} headLabel=${SCR.head}
          collapsed=${collapsed} toggleSection=${t=>setCollapsed(c=>({...c,[t]:!c[t]}))}/>
        <div class="border-t border-line px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-muted">
          ${legend.filter(([g])=>SCR.legend.includes(g)).map(([g,ks])=>html`<span key=${g} class="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-semibold text-ink">${g}</span>
            ${ks.map(k=>html`<span key=${k} class="inline-flex items-center gap-1.5">
              <span class="inline-block w-5 h-3 rounded-[3px]" style=${blockStyle({kind:k,resourceId:data.resources.find(r=>r.type==='crew')?.id,crewId:data.resources.find(r=>r.type==='crew')?.id},data)}></span>${k==='job'?'Day job (crew colour)':KINDS[k].label}</span>`)}</span>`)}
          <span class="inline-flex items-center gap-1.5"><span class="inline-flex items-center justify-center w-5 h-3 rounded-[3px]" style=${blockStyle({kind:'job',shift:'night'},data)}>${Icon.moon}</span>Night works</span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block w-5 h-3 rounded-[3px]" style=${{boxShadow:'inset 0 0 0 2px hsl(0 75% var(--blk-edge-l))',backgroundImage:'repeating-linear-gradient(135deg,hsl(0 80% 50% / .16) 0 4px,transparent 4px 8px)'}}></span>Job on a plant maintenance day</span>
          <span class="flex-1"></span>
          <span>Signed in as ${showLogin(live.user.email)}${live.canEdit?'':' · view only'}</span>
        </div>
      </section>`}
    </main>

    ${changePw&&html`<${SetPassword} sb=${live.sb} onDone=${()=>{setChangePw(false);setToast('Password changed')}} onCancel=${()=>setChangePw(false)}/>`}
    ${forecast&&html`<${ForecastDialog} data=${data} onClose=${()=>setForecast(false)} notify=${setToast}/>`}
    ${program&&html`<${DailyProgramDialog} data=${data} onClose=${()=>setProgram(false)} notify=${setToast}/>`}
    ${importing&&html`<${TeamCalImport} data=${data} setData=${setData} onClose=${()=>setImporting(false)} notify=${setToast}/>`}
    ${merging&&html`<${MergeSplits} data=${data} setData=${setData} onClose=${()=>setMerging(false)} notify=${setToast}/>`}
    ${machImport&&html`<${MachineImport} data=${data} setData=${setData} onClose=${()=>setMachImport(false)} notify=${setToast}/>`}
    ${logOpen&&html`<${ChangeLogDialog} data=${data} onClose=${()=>setLogOpen(false)} onOpen=${b=>setEditing(b)}/>`}
    ${exporting&&html`<${ExportDialog} data=${data} onClose=${()=>setExporting(null)} notify=${setToast}/>`}
    ${subWorksOpen&&html`<${SubWorksDialog} data=${data} notify=${setToast} onClose=${()=>setSubWorksOpen(false)}/>`}
    ${suggest&&html`<${SuggestDialog} setData=${setData} notify=${setToast} onClose=${()=>setSuggest(false)}/>`}
    ${editing&&html`<${Editor} initial=${editing} data=${data} onSave=${onSave} onDelete=${onDelete} onClose=${()=>setEditing(null)} notify=${setToast}
      onOpenPlan=${id=>{try{localStorage.setItem(KEY+':plan',id)}catch(e){}setEditing(null);goScreen('planning')}}/>`}
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
const COLLECTIONS=[['resources','resource'],['jobs','job'],['blocks','block'],['quoteChanges','quote_change'],['changeLog','change'],['suggestions','suggestion'],['ideas','idea'],['plans','plan'],['planImgs','plan_img']];
const ORDERED=new Set(['resources','jobs']);           /* row order matters for these */
const SETTINGS=['mixTypes','binders','mixRap','mixBinder','sealTypes','sealBinder','sealBinders','sealTwoCoat','truckCos','subCos','subServices','programLocs','locColors','truckDefs','machineCats','ideasVault','ideasPub','previewOnly','previewKnown','planQuick','planSteps'];
const LOCAL_HIDDEN=KEY+':hidden',LOCAL_ORDER=KEY+':order';
const readLocal=(k,def)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):def}catch(e){return def}};
const writeLocal=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};

/* what gets stored for one record (per-person fields removed) */
const storedForm=(coll,item,i)=>{const {visible,pos,...rest}=item;return ORDERED.has(coll)?{...rest,pos:i}:rest};

/* rows from Supabase -> the app's data object */
function rowsToData(rows){
  const hidden=new Set(readLocal(LOCAL_HIDDEN,[]));
  const d={resources:[],jobs:[],blocks:[],quoteChanges:[],changeLog:[],suggestions:[],ideas:[],plans:[],planImgs:[]};
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
  /* suggestions are only added (anyone may add one, but only administrators can read them back), so they go in as plain inserts */
  const sug=upserts.filter(x=>x.kind==='suggestion');upserts=upserts.filter(x=>x.kind!=='suggestion');
  if(sug.length){const {error}=await sb.from('items').insert(sug);if(error&&error.code!=='23505')throw error}
  for(let i=0;i<upserts.length;i+=500){const {error}=await sb.from('items').upsert(upserts.slice(i,i+500));if(error)throw error}
  const byKind={};deletes.forEach(x=>{(byKind[x.kind]=byKind[x.kind]||[]).push(x.id)});
  for(const [kind,ids] of Object.entries(byKind)){const {error}=await sb.from('items').delete().eq('kind',kind).in('id',ids);if(error)throw error}
}

/* data for a brand-new, empty roster */
function emptyRoster(){
  return {resources:[{id:'a'+uid(),type:'aplant',name:'Asphalt plant',sub:'Main plant',hue:8,visible:true}],
    jobs:[],blocks:[],quoteChanges:[],changeLog:[],suggestions:[],ideas:[],plans:[],planImgs:[],mixTypes:[...ASPHALT_TYPES],binders:[...BINDERS],mixRap:{},mixBinder:{...DEFAULT_MIX_BINDER},sealTypes:[...SEAL_TYPES],sealBinder:{},sealBinders:[...SEAL_BINDERS],truckCos:[...DEFAULT_TRUCKS],subCos:[...DEFAULT_SUBS],subServices:{...DEFAULT_SUB_SERVICES},programLocs:[...PROGRAM_LOCATIONS],locColors:{...DEFAULT_LOC_COLORS},
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
    <div class="flex items-center gap-3"><img src=${BRAND_OVAL} alt="Alex Fraser Group" class="block h-[44px] w-auto"/>
      <span class="font-display text-[19px] font-semibold">Fraser<span style=${{color:'var(--accent)'}}>Flow</span></span></div>
    ${children}</div></div>`;
}
/* usernames: Supabase needs an email address for each login, so a username like "jsmith" is stored as
   jsmith@fraserflow.local (no mail is ever sent there). People type and see just the username. */
const LOGIN_DOMAIN='fraserflow.local';
const toLogin=v=>{v=String(v||'').trim();return v.includes('@')?v:v.toLowerCase()+'@'+LOGIN_DOMAIN};
const showLogin=e=>{e=String(e||'');return e.toLowerCase().endsWith('@'+LOGIN_DOMAIN)?e.slice(0,-LOGIN_DOMAIN.length-1):e};
window.showLogin=showLogin;
function Login({sb}){
  /* Email + password. Accounts are created by an administrator in Supabase with a temporary
     password; on first sign-in the person is asked to choose their own (see SetPassword). */
  const [email,setEmail]=useState('');const [pw,setPw]=useState('');const [show,setShow]=useState(false);
  const [busy,setBusy]=useState(false);const [err,setErr]=useState('');const [forgot,setForgot]=useState(false);
  const signIn=async e=>{e.preventDefault();setBusy(true);setErr('');
    const {error}=await sb.auth.signInWithPassword({email:toLogin(email),password:pw});
    setBusy(false);
    if(error)setErr(/invalid login|credentials/i.test(error.message)?'That username or password is wrong.':/not confirmed/i.test(error.message)?'This account isn’t active yet. Ask your administrator to confirm it.':error.message)};
  return html`<${Centered}>
    <form class="flex flex-col gap-3" onSubmit=${signIn}>
      <label class="grid gap-1"><span class="label">Username</span>
        <input id="login-email" type="text" required autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" class="field" value=${email} onInput=${e=>setEmail(e.target.value)}/></label>
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
          <p class="text-[13px] text-muted">The roster is empty. Start it, then add your crews, staff and machines in Settings, and your jobs under Jobs.</p>
          <button class="btn btn-primary justify-center" disabled=${busy} onClick=${async()=>{setBusy(true);await onStart(emptyRoster())}}>Start the roster</button>
        </div>`
      :html`<p class="text-[13px] text-muted">The roster hasn’t been set up yet. A planner needs to sign in first.</p>`}
  <//>`;
}
/* people created with a temporary password haven't chosen their own yet */
/* ---------- a small store on this device (IndexedDB) for working without reception ---------- */
const ffStore=(()=>{let dbp=null;
  const open=()=>dbp||(dbp=new Promise((res,rej)=>{try{const r=indexedDB.open('fraserflow',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}catch(e){rej(e)}}));
  const run=(mode,fn)=>open().then(db=>new Promise((res,rej)=>{const tx=db.transaction('kv',mode);const st=tx.objectStore('kv');const q=fn(st);tx.oncomplete=()=>res(q&&q.result);tx.onerror=()=>rej(tx.error)}));
  return {get:k=>run('readonly',s=>s.get(k)).catch(()=>undefined),set:(k,v)=>run('readwrite',s=>s.put(v,k)).catch(()=>{}),del:k=>run('readwrite',s=>s.delete(k)).catch(()=>{}),
    keys:()=>run('readonly',s=>s.getAllKeys()).catch(()=>[])};
})();
window.ffStore=ffStore;
/* a dropped connection (try again later), not a refusal from the server */
const isNetErr=e=>{if(!e)return false;if(typeof navigator!=='undefined'&&navigator.onLine===false)return true;
  const m=String((e&&(e.message||e.error_description))||e);return !(e.code||e.statusCode||e.status)&&(/fetch|network|load failed|offline|timed? ?out|internet/i.test(m)||e.name==='TypeError')};
window.isNetErr=isNetErr;
const needsPw=s=>!(s&&s.user&&s.user.user_metadata&&s.user.user_metadata.password_set);
function Root(){
  const [phase,setPhase]=useState('boot');            /* boot | error | login | loading | empty | ready */
  const [msg,setMsg]=useState('');
  const [sb,setSb]=useState(null);const [session,setSession]=useState(null);
  const [role,setRole]=useState('viewer');const [boot,setBoot]=useState(null);
  const [offline,setOffline]=useState(null);   /* {at}: running from the copy saved on this device */
  useEffect(()=>{(async()=>{
    try{
      let cfg;try{const r=await fetch('/api/config',{cache:'no-store'});cfg=await r.json();try{localStorage.setItem('ff:cfg',JSON.stringify(cfg))}catch(e){}}
      catch(e){cfg=JSON.parse(localStorage.getItem('ff:cfg')||'null');if(!cfg)throw e}   /* no reception: the settings saved last time */
      if(!cfg.url||!cfg.anonKey){setMsg('The app isn’t connected to its database yet. Add SUPABASE_URL and SUPABASE_ANON_KEY in Vercel, then redeploy.');setPhase('error');return}
      const client=window.supabase.createClient(cfg.url,cfg.anonKey);setSb(client);
      let s=null;try{s=(await client.auth.getSession()).data.session}catch(e){}
      if(!s&&!navigator.onLine){const u=JSON.parse(localStorage.getItem('ff:lastUser')||'null');if(u)s={user:{...u,user_metadata:{password_set:true}},offline:true}}   /* signed in last time, no reception now */
      setSession(s);setPhase(s?(needsPw(s)?'setpw':'loading'):'login');
      client.auth.onAuthStateChange((_e,s2)=>{setSession(s2);setPhase(p=>s2?(p==='login'?(needsPw(s2)?'setpw':'loading'):p):'login')});
    }catch(e){setMsg('Couldn’t reach the server. Check your connection and reload.');setPhase('error')}
  })()},[]);
  useEffect(()=>{if(phase!=='loading'||!sb||!session)return;(async()=>{
    try{
      const uidK=session.user.id;
      try{
        const {data:prof,error:pe}=await sb.from('profiles').select('role').eq('id',uidK).maybeSingle();if(pe)throw pe;
        const rl=((prof&&prof.role)==='operator'?'prestart':(prof&&prof.role))||'viewer';setRole(rl);   /* "operator" was the old name for prestart */
        const rows=await fetchAllRows(sb);
        if(!rows.length){setPhase('empty');return}
        setBoot(rowsToData(rows));setOffline(null);setPhase('ready');
        try{localStorage.setItem('ff:lastUser',JSON.stringify({id:uidK,email:session.user.email}));localStorage.setItem('ff:role:'+uidK,rl)}catch(e){}
        ffStore.set('rows:'+uidK,{at:Date.now(),rows});   /* the copy used when there's no reception */
      }catch(e){
        const saved=isNetErr(e)?await ffStore.get('rows:'+uidK):null;if(!saved)throw e;
        setRole((r=>r==='operator'?'prestart':r)(localStorage.getItem('ff:role:'+uidK))||'viewer');setBoot(rowsToData(saved.rows));setOffline({at:saved.at});setPhase('ready');
      }
    }catch(e){setMsg(isNetErr(e)?'Couldn’t reach the server. Check your connection and reload.':'Couldn’t load the roster: '+(e.message||e));setPhase('error')}
  })()},[phase,sb,session]);
  const start=async d=>{try{await pushRows(sb,diffRows({},d));setBoot(rowsToData(await fetchAllRows(sb)));setPhase('ready')}catch(e){setMsg('Couldn’t save: '+(e.message||e));setPhase('error')}};
  if(phase==='boot'||phase==='loading')return html`<${Centered}><p class="text-[13px] text-muted">Loading…</p><//>`;
  if(phase==='error')return html`<${Centered}><p class="text-[13px]">${msg}</p><button class="btn" onClick=${()=>location.reload()}>Reload</button><//>`;
  if(phase==='login')return html`<${Login} sb=${sb}/>`;
  if(phase==='setpw')return html`<${SetPassword} sb=${sb} first=${true} onDone=${()=>setPhase('loading')}/>`;
  if(phase==='empty')return html`<${FirstRun} canEdit=${role!=='viewer'} onStart=${start}/>`;
  return html`<${App} boot=${boot} live=${{sb,user:session.user,role,offline,canEdit:!offline&&(role==='admin'||role==='superuser'||role==='planner')}}/>`;
}


ReactDOM.createRoot(document.getElementById('root')).render(html`<${Root}/>`);
