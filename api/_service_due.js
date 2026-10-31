// Services raised automatically: when a machine comes within a service plan's warning window (or is overdue),
// a service work order is made for it, the same as clicking "Create work order" on the machine.
// The rules match maint.js (buildModel → planStatus, stageOf); keep the two in step.
// Not an endpoint (the leading underscore keeps it out of Vercel's functions): used by api/servicem8.js.

const DAY = 864e5;
const todayBne = () => new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10);   // Queensland: no daylight saving
const addDays = (k, n) => new Date(Date.parse(k + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const fmtN = n => Number(n).toLocaleString('en-AU', { maximumFractionDigits: 1 });
const catOf = m => String((m && m.category) || '').trim();
const ivUnit = p => (p.every_hours ? 'hours' : 'km');
const planCats = p => [...new Set((Array.isArray(p.categories) && p.categories.length ? p.categories : (p.category ? [p.category] : [])).map(c => String(c).trim().toLowerCase()).filter(Boolean))];
const ivsOf = p => (Array.isArray(p.intervals) ? p.intervals.filter(v => +v.every > 0).sort((a, b) => a.every - b.every) : []);
const ivLabel = (p, v) => String(v.label || '').trim() || `${fmtN(+v.every)} ${ivUnit(p) === 'km' ? 'km' : 'h'} service`;
function stageOf(p, last) {
  const ivs = ivsOf(p); if (ivs.length < 2 || !last) return null;
  const v0 = last[ivUnit(p)]; if (v0 == null) return null;
  const base = +ivs[0].every, cycle = +ivs[ivs.length - 1].every;
  const M = Math.round((+v0 + base) / base) * base; const r = M % cycle || cycle;
  const v = ivs.find(x => +x.every === r) || [...ivs].reverse().find(x => r % +x.every === 0) || ivs[0];
  return { every: +v.every, at: M, label: ivLabel(p, v), notes: String(v.notes || '').trim() };
}

// Is this plan due on this machine? → null, or { state: 'soon' | 'overdue', why, title, notes }
function planDue({ machine, profile, plan, last, cur, today }) {
  if (!last) return null;   // no service recorded yet: nothing to count from (same as the Fleet screen)
  const mt = (profile && profile.meter_type) || (/truck/i.test([catOf(machine), machine.name, machine.sub].join(' ')) ? 'both' : 'hours');
  const parts = [];
  if (plan.every_hours && mt !== 'km' && last.hours != null) {
    const due = +last.hours + +plan.every_hours; const left = cur.hours != null ? due - cur.hours : null;
    parts.push({ left, warn: +plan.warn_hours, txt: left == null ? null : left <= 0 ? `${fmtN(-left)} h overdue (due at ${fmtN(due)} h)` : `due at ${fmtN(due)} h, ${fmtN(left)} h to go` });
  }
  if (plan.every_km && mt !== 'hours' && last.km != null) {
    const due = +last.km + +plan.every_km; const left = cur.km != null ? due - cur.km : null;
    parts.push({ left, warn: +plan.warn_km, txt: left == null ? null : left <= 0 ? `${fmtN(-left)} km overdue (due at ${fmtN(due)} km)` : `due at ${fmtN(due)} km, ${fmtN(left)} km to go` });
  }
  if (plan.every_days) {
    const dueK = addDays(last.done_on, +plan.every_days); const left = dayDiff(today, dueK);
    parts.push({ left, warn: +plan.warn_days, txt: left <= 0 ? (left === 0 ? 'due today' : `${-left} days overdue`) : `due ${dueK}, ${left} days to go` });
  }
  const over = parts.filter(x => x.left != null && x.left <= 0), soon = parts.filter(x => x.left != null && x.left > 0 && x.left <= x.warn);
  if (!over.length && !soon.length) return null;
  const stage = stageOf(plan, last);
  return { state: over.length ? 'overdue' : 'soon', why: [...over, ...soon].map(x => x.txt).filter(Boolean).join('; '),
    title: stage ? `${plan.name} · ${stage.label}` : plan.name, notes: stage ? stage.notes : '' };
}

// Every row of a table (PostgREST returns at most 1,000 at a time)
async function all(D, path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await D.get(`${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${from}`);
    out.push(...(rows || []));
    if (!rows || rows.length < 1000) break;
  }
  return out;
}

// Look at every machine and plan; raise a work order for each service now due that doesn't have one.
// A plan isn't raised again while a work order made since its last service exists (open, done or cancelled),
// so cancelling an automatic one means "not this time".
async function raiseDueServices(D, { assignee = 'Bells Diesel', dryRun = false } = {}) {
  const today = todayBne();
  const [machines, profiles, plans, records, readings, wos] = await Promise.all([
    all(D, 'items?kind=eq.resource&data->>type=eq.machine&select=id,data'),
    all(D, 'asset_profiles?select=asset_id,meter_type,retired'),
    all(D, 'service_plans?active=is.true&select=*'),
    all(D, 'service_records?select=asset_id,plan_id,done_on,hours,km,created_at&plan_id=not.is.null&order=done_on.desc,created_at.desc'),
    all(D, 'meter_readings?select=asset_id,kind,value,read_at,created_at&order=read_at.asc,created_at.asc'),
    all(D, 'work_orders?select=asset_id,plan_id,status,created_at&plan_id=not.is.null'),
  ]);
  const prof = new Map(profiles.map(p => [p.asset_id, p]));
  const cur = new Map(); readings.forEach(r => { const m = cur.get(r.asset_id) || {}; m[r.kind] = +r.value; cur.set(r.asset_id, m); });   // newest wins
  const lastRec = new Map(); records.forEach(r => { const k = r.asset_id + '|' + r.plan_id; if (!lastRec.has(k)) lastRec.set(k, r); });   // newest first
  const raised = [];
  for (const it of machines) {
    const m = { id: it.id, ...(it.data || {}) };
    if (prof.get(m.id) && prof.get(m.id).retired) continue;
    const cat = catOf(m).toLowerCase();
    for (const plan of plans.filter(p => p.asset_id === m.id || (cat && planCats(p).includes(cat)))) {
      const last = lastRec.get(m.id + '|' + plan.id) || null;
      const due = planDue({ machine: m, profile: prof.get(m.id), plan, last, cur: cur.get(m.id) || {}, today });
      if (!due) continue;
      const since = last ? last.created_at : '';
      if (wos.some(w => w.asset_id === m.id && w.plan_id === plan.id && (!['completed', 'closed', 'cancelled'].includes(w.status) || String(w.created_at) > String(since)))) continue;
      const row = { asset_id: m.id, wo_type: 'service', plan_id: plan.id, title: due.title, priority: due.state === 'overdue' ? 'high' : 'medium', assigned_to: assignee,
        description: [due.notes, `Raised automatically by FraserFlow: ${due.state === 'overdue' ? 'overdue' : 'due soon'} (${due.why}).`].filter(Boolean).join('\n\n') };
      if (!dryRun) {
        try { await D.post('work_orders', row); }
        catch (e) { if (/one_open_per_plan|duplicate key/i.test(String(e.message))) continue; throw e; }   // someone raised it meanwhile
      }
      raised.push({ machine: m.name || m.id, title: due.title, state: due.state });
    }
  }
  return raised;
}

module.exports = { raiseDueServices, planDue, stageOf };
