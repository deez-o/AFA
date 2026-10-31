// Checks api/_service_due.js (services raised automatically). Run: node tests/api_service_due_test.js
const { raiseDueServices, planDue } = require('../api/_service_due.js');
let fails = 0;
const ok = (c, l) => { console.log((c ? 'PASS' : 'FAIL') + ': ' + l); if (!c) fails++; };
const today = new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);

// the rules
const roller = { id: 'm1', name: 'R12', sub: 'Roller', category: 'Steel Rollers' };
const p250 = { id: 'p1', name: '250 h service', every_hours: 250, warn_hours: 50, warn_km: 1000, warn_days: 14 };
ok(planDue({ machine: roller, plan: p250, last: { hours: 1000, done_on: daysAgo(30) }, cur: { hours: 1150 }, today }) === null, 'not due yet (100 h to go, warning at 50): nothing');
let d = planDue({ machine: roller, plan: p250, last: { hours: 1000, done_on: daysAgo(30) }, cur: { hours: 1210 }, today });
ok(d && d.state === 'soon' && /due at 1,250 h, 40 h to go/.test(d.why), 'within the warning window (40 h to go): due soon');
d = planDue({ machine: roller, plan: p250, last: { hours: 1000, done_on: daysAgo(30) }, cur: { hours: 1260 }, today });
ok(d && d.state === 'overdue' && /10 h overdue/.test(d.why), 'past it: overdue');
ok(planDue({ machine: roller, plan: p250, last: null, cur: { hours: 9999 }, today }) === null, 'no service recorded yet: nothing to count from');
const yearly = { id: 'p2', name: 'Annual inspection', every_days: 365, warn_hours: 50, warn_km: 1000, warn_days: 14 };
ok(planDue({ machine: roller, plan: yearly, last: { done_on: daysAgo(355) }, cur: {}, today }).state === 'soon', 'by days: 10 days to go is due soon');
const cycle = { id: 'p3', name: 'Cat service', every_hours: 250, warn_hours: 50, warn_km: 1000, warn_days: 14,
  intervals: [{ every: 250, label: '250 h' }, { every: 500, label: '500 h', notes: 'Hydraulic filters' }, { every: 1000, label: '1000 h' }] };
d = planDue({ machine: roller, plan: cycle, last: { hours: 250, done_on: daysAgo(10) }, cur: { hours: 480 }, today });
ok(d && d.title === 'Cat service · 500 h' && d.notes === 'Hydraulic filters', 'a plan with several intervals: the next one in the cycle, with its notes');
const truck = { id: 'm2', name: 'T4', sub: 'Tipper truck', category: 'Trucks' };
const pkm = { id: 'p4', name: '10,000 km service', every_km: 10000, warn_hours: 50, warn_km: 1000, warn_days: 14 };
ok(planDue({ machine: truck, plan: pkm, last: { km: 50000, done_on: daysAgo(40) }, cur: { km: 59500 }, today }).state === 'soon', 'a truck counts km');
ok(planDue({ machine: roller, profile: { meter_type: 'hours' }, plan: pkm, last: { km: 50000, done_on: daysAgo(40) }, cur: { km: 59500 }, today }) === null, 'an hours-only machine ignores a km plan');

// raising them
function fakeDb(state) {
  const posted = [];
  const D = {
    get: async path => {
      const t = path.split('?')[0];
      if (/offset=[1-9]/.test(path)) return [];
      if (t === 'items') return state.machines.map(m => ({ id: m.id, data: m }));
      if (t === 'asset_profiles') return state.profiles || [];
      if (t === 'service_plans') return state.plans;
      if (t === 'service_records') return state.records;
      if (t === 'meter_readings') return state.readings;
      if (t === 'work_orders') return state.wos;
      throw new Error('unexpected ' + path);
    },
    post: async (t, row) => { if (state.clash) throw new Error('duplicate key value violates unique constraint "work_orders_one_open_per_plan"'); posted.push(row); state.wos.push({ ...row, status: 'open', created_at: new Date().toISOString() }); },
  };
  return { D, posted };
}
(async () => {
  const st = { machines: [roller, { id: 'm9', name: 'Old', category: 'Steel Rollers' }], profiles: [{ asset_id: 'm9', retired: true }], plans: [{ ...p250, category: 'Steel Rollers', active: true }],
    records: [{ asset_id: 'm1', plan_id: 'p1', hours: 1000, done_on: daysAgo(30), created_at: '2026-10-01T00:00:00Z' }, { asset_id: 'm9', plan_id: 'p1', hours: 0, done_on: daysAgo(300), created_at: '2026-01-01T00:00:00Z' }],
    readings: [{ asset_id: 'm1', kind: 'hours', value: 1100 }, { asset_id: 'm1', kind: 'hours', value: 1260 }, { asset_id: 'm9', kind: 'hours', value: 5000 }], wos: [] };
  let { D, posted } = fakeDb(st);
  let r = await raiseDueServices(D, { assignee: 'Bells Diesel' });
  ok(r.length === 1 && posted.length === 1, 'one service due: one work order raised (a retired machine is left out)');
  const w = posted[0];
  ok(w.wo_type === 'service' && w.plan_id === 'p1' && w.asset_id === 'm1' && w.priority === 'high' && w.assigned_to === 'Bells Diesel' && /Raised automatically by FraserFlow: overdue/.test(w.description),
    'it is a service work order for that plan: overdue → high priority, assigned to Bells Diesel, saying why');
  r = await raiseDueServices(D, {});
  ok(r.length === 0 && posted.length === 1, 'checking again: not raised twice while that work order is open');
  st.wos[0].status = 'cancelled';
  r = await raiseDueServices(D, {});
  ok(r.length === 0, 'cancelled: not raised again until the next service is due');
  st.records.unshift({ asset_id: 'm1', plan_id: 'p1', hours: 1255, done_on: today, created_at: new Date(Date.now() + 1000).toISOString() });
  st.readings.push({ asset_id: 'm1', kind: 'hours', value: 1460 });
  r = await raiseDueServices(D, {});
  ok(r.length === 1 && posted.length === 2 && posted[1].priority === 'medium', 'after that service is done, the next one is raised when it comes due (due soon → medium)');
  st.wos.length = 0; st.clash = true;
  r = await raiseDueServices(D, {});
  ok(r.length === 0, 'if someone raised it at the same moment, it is skipped quietly');
  console.log(fails ? `${fails} FAILED` : 'ALL SERVICE-DUE TESTS PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
