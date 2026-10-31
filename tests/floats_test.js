// Checks the float moves logic in floats.js. Run: node tests/floats_test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
// app.js's helpers (dates, bookings) with the browser stubbed out
const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : any, apply: () => any, construct: () => any });
const ctx = { console, React: { useState: any, useMemo: any, useEffect: any, useRef: any, createElement: any }, htm: { bind: () => () => null },
  ReactDOM: any, supabase: any, document: any, navigator: any, location: { search: '', hash: '', href: '' }, setTimeout, clearTimeout, setInterval: () => 0, URL, fetch: () => new Promise(() => {}),
  localStorage: { getItem: () => null, setItem: () => {} }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
ctx.window = ctx; ctx.addEventListener = () => {}; ctx.removeEventListener = () => {}; vm.createContext(ctx);
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
try { vm.runInContext(src, ctx) } catch (e) { if (process.env.DBG) console.log(e) }   // the start-up at the end needs a browser; the helpers above it are defined
vm.runInContext(fs.readFileSync(path.join(__dirname, '../floats.js'), 'utf8'), ctx);
const { buildMoves, toTrips, planFloat, makeTravel, cfgOf, loadFits } = ctx.FFL;
let fails = 0; const ok = (c, l) => { console.log((c ? 'PASS' : 'FAIL') + ': ' + l); if (!c) fails++; };
const t = s => { const [d, h] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [H, M] = h.split(':').map(Number); return new Date(y, m - 1, dd, H, M) };
const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const R = (id, name, category = 'Pavers') => ({ id, type: 'machine', name, category, rego: '', visible: true });
const base = () => ({ jobs: [{ id: 'jA', name: 'Job A', address: '1 A St, Morayfield' }, { id: 'jB', name: 'Job B', address: '2 B Rd, Strathpine' }, { id: 'jC', name: 'Job C', address: '3 C Ave, Caboolture' }],
  resources: [{ id: 'c1', type: 'crew', name: 'Crew 1' }, { id: 'c2', type: 'crew', name: 'Crew 2' }, R('p1', 'PV010 Paver'), R('r1', 'RL05 Roller', 'Steel rollers'), R('t1', 'TK01 Tipper', 'Trucks')],
  blocks: [], plans: [] });
const bk = (id, job, crew, start, end, shift, plant, extra = {}) => ({ id, kind: 'job', jobId: job, resourceId: crew, start, end, shift, plantIds: plant, address: '', weekendShifts: true, satShift: true, sunShift: true, ...extra });
const cfg = { ...cfgOf({}), gapDays: 3 };
const run = (d, from = '2026-11-01', to = '2026-11-30') => buildMoves(d, { cfg, geo: {}, from, to });

// 1. night shift finishing, day shift next morning at another job
let d = base();
d.blocks.push(bk('b1', 'jA', 'c1', '2026-11-09', '2026-11-11', 'night', ['p1', 'r1', 't1']));
d.blocks.push(bk('b2', 'jB', 'c2', '2026-11-12', '2026-11-13', 'day', ['p1'], { shiftData: { '2026-11-12': { start: '06:30' } } }));
let M = run(d).moves.filter(m => m.m === 'p1');
const direct = M.find(m => m.kind === 'direct');
ok(direct && direct.from.job.includes('Job A') && direct.to.job.includes('Job B'), 'night job A → day job B is one direct move');
ok(direct && hm(direct.earliest) === '04:00' && direct.earliest.getDate() === 12, 'free from 04:00 (night shift 18:00 + 10 h, the 11th into the 12th)');
ok(direct && hm(direct.latest) === '05:30' && direct.latest.getDate() === 12, 'needed by 05:30: an hour before the 06:30 start');
ok(!run(d).moves.some(m => m.m === 't1'), 'a tipper (Trucks) drives itself: no float');
ok(!M.some(m => m.from.job === 'Job A' && m.to.job === 'Job A'), 'no move between shifts of the same job');

// 2. a long gap: back to the yard and out again
d = base();
d.blocks.push(bk('b1', 'jA', 'c1', '2026-11-02', '2026-11-03', 'day', ['r1']));
d.blocks.push(bk('b2', 'jC', 'c1', '2026-11-12', '2026-11-12', 'day', ['r1']));
M = run(d).moves.filter(m => m.m === 'r1');
ok(M.some(m => m.kind === 'toYard' && m.from.job === 'Job A') && M.some(m => m.kind === 'fromYard' && m.to.job === 'Job C'), 'next job 9 days away: to the yard, then out to it');
const out = M.find(m => m.kind === 'fromYard' && m.to.job === 'Job C');
ok(out && out.earliest.getDate() <= 11 && hm(out.latest) === '05:00' && out.latest.getDate() === 12, 'out of the yard in the days before, there by 05:00 for the 06:00 start');

// 3. the same site over a weekend: stays
d = base();
d.blocks.push(bk('b1', 'jA', 'c1', '2026-11-06', '2026-11-06', 'day', ['p1']));
d.blocks.push(bk('b2', 'jA', 'c1', '2026-11-09', '2026-11-10', 'day', ['p1']));
ok(!run(d).moves.some(m => m.kind === 'direct' || (m.from.job === 'Job A' && m.to.yard && m.latest < new Date(2026, 10, 9))), 'same job after a weekend: the machine stays on site');

// 4. clash: one paver on two jobs the same night
d = base();
d.blocks.push(bk('b1', 'jA', 'c1', '2026-11-09', '2026-11-09', 'night', ['p1']));
d.blocks.push(bk('b2', 'jB', 'c2', '2026-11-09', '2026-11-09', 'night', ['p1']));
const C = run(d).clashes;
ok(C.length === 1 && C[0].name === 'PV010 Paver' && C[0].k === '2026-11-09', 'the same paver on two jobs the same night is a clash');

// 5. a service: to the yard (workshop)
d = base();
d.blocks.push(bk('b1', 'jA', 'c1', '2026-11-02', '2026-11-04', 'day', ['p1']));
d.blocks.push({ id: 's1', kind: 'service', resourceId: 'p1', start: '2026-11-05', end: '2026-11-05' });
M = run(d).moves.filter(m => m.m === 'p1');
ok(M.some(m => m.to.yard && m.from.job === 'Job A' && hm(m.latest) === '07:00'), 'in for a service the next day: to the yard by 07:00');

// 6. the float: one at a time, late ones flagged, two machines on one load when allowed
d = base();
d.blocks.push(bk('b1', 'jA', 'c1', '2026-11-09', '2026-11-09', 'night', ['p1', 'r1']));
d.blocks.push(bk('b2', 'jB', 'c2', '2026-11-10', '2026-11-10', 'day', ['p1', 'r1']));
const travel = () => ({ min: 40, km: 30 });
M = run(d).moves.filter(m => m.kind === 'direct');
let P = planFloat(toTrips(M, cfg), cfg, travel, {}).runs;
ok(P.length === 2 && P[0].pick < P[1].pick, 'one float: the two machines go one after the other');
ok(P[0].pick.getHours() === 4 && hm(P[0].done) === '05:40', 'first: picked up 04:00 when the night shift ends; 30 min load + 40 min drive + 30 min unload: done 05:40');
ok(P[1].late, 'second: the float can’t be back in time for 06:00, so it’s marked late');
const cfg2 = { ...cfg, perLoad: 2, combos: [], alone: [] };
P = planFloat(toTrips(M, cfg2), cfg2, travel, {}).runs;
ok(P.length === 1 && P[0].moves.length === 2 && hm(P[0].done) === '06:40' && P[0].late, 'two machines per load: one trip (loading and unloading both: done 06:40, still late for 06:00)');
// a pick-up time set by hand is kept
const id = toTrips(M, cfg)[1].id;
P = planFloat(toTrips(M, cfg), cfg, travel, { [id]: { time: '2026-11-10T03:00' } }).runs;
ok(P.find(r => r.id === id).fixed && hm(P.find(r => r.id === id).pick) === '03:00', 'a pick-up time set by hand is kept');
P = planFloat(toTrips(M, cfg), cfg, travel, { [id]: { skip: true } });
ok(P.runs.length === 1 && P.skipped.length === 1, '“Not needed”: the move is left out');

// loads made from the groups (as AFA described them)
const CF = { ...cfgOf({}), combos: [{ items: ['g:Pavers that share', 'g:Small rollers', 'g:Small rollers'] }, { items: ['g:Pavers that share', 'n:SR012'] }, { items: ['g:Pavers that share', 'n:SR015'] },
  { items: ['g:Small rollers', 'g:Small rollers'] }, { items: ['n:SR012', 'n:SR015'] }, { items: ['g:Pavers that share', 'g:Big multis'] }, { items: ['g:Pavers that share', 'g:Small multis', 'g:Small rollers'] }] };
ok(cfgOf({}).combos.length === 0 && cfgOf({}).groups.map(g => g.name).join() === 'Pavers that share,Small rollers,Big rollers,Small multis,Big multis', 'to start: the five groups, and no loads (you make them)');
ok(cfgOf({ floatCfg: { groups: [{ name: 'Small rollers', items: [] }, { name: 'Multis', items: [] }] } }).groups.map(g => g.name).join() === 'Small rollers,Big rollers,Multis', 'groups saved earlier get Big rollers too (after Small rollers)');
ok(cfgOf({ floatCfg: { groups: [{ name: 'Rollers', items: [] }], groupsSeen: ['Big rollers'] } }).groups.length === 1, '…but not once it has been renamed or taken out');
ok(!loadFits([{ m: 'a', name: 'PV009' }, { m: 'b', name: 'SR004' }], cfgOf({})), 'with no loads made, nothing shares');
const mv = (name, cat = '', rego = '') => ({ m: 'id-' + name, name, cat, rego });
const fits = (...ms) => loadFits(ms.map(x => typeof x === 'string' ? mv(x) : x), CF);
ok(!fits('PV010', 'SR004'), 'PV010 goes by itself');
ok(fits('PV009', 'SR004', 'SR005') && fits('PV012 Vogele', 'SR010', 'SR014'), 'paver + two small rollers');
ok(!fits('PV009', 'SR004', 'SR005', 'SR010'), 'not three rollers with a paver');
ok(fits('PV008', 'SR012') && !fits('PV008', 'SR012', 'SR004'), 'SR012 with a paver, but no other roller');
ok(fits('PV009', 'SR015') && !fits('PV009', 'SR015', 'SR013'), 'SR015 the same');
ok(fits('SR004', 'SR013') && fits('SR012', 'SR015'), 'two small rollers together; SR012 + SR015 together');
ok(fits('PV009', 'MT007') && fits('PV012', mv('Multi roller', 'Multi Rollers', '1AP7VD')) && !fits('PV009', 'MT007', 'MT008'), 'a paver + one multi (1AP7VD found by its rego), not two');
ok(fits('PV008', 'MT006', 'SR011') && !fits('PV008', 'MT006', 'SR011', 'SR004'), 'paver + MT006 + one small roller');
ok(!fits('PV009', 'PV012'), 'two pavers don’t share');
ok(!fits('PV009', 'SR099'), 'a roller not on the list doesn’t go with a paver');
ok(!ctx.FFL.needsFloat({ name: 'SS003', category: 'Bobcats' }, {}, CF) && !ctx.FFL.needsFloat({ name: 'WC1', category: 'Water Carts' }, {}, CF), 'bobcats and water carts aren’t floated');

// when the float moves: the driver's hours, weekdays first (1 Nov 2026 is a Sunday)
{
  const tr = () => ({ min: 40, km: 30 });
  const trip = (e, l) => ({ id: 'x', moves: [{ m: 'a', name: 'PV009' }], from: { key: 'A' }, to: { key: 'B' }, earliest: t(e), latest: t(l) });
  const cd = { ...cfgOf({}) };   // day driver 06:00–16:00, weekdays first
  let r = planFloat([trip('2026-11-06 16:00', '2026-11-09 06:00')], cd, tr, {}).runs[0];
  ok(r.pick.getDay() === 0 && hm(r.leave) === '06:00' && !r.outHours, 'Friday 16:00 → needed Monday 06:00: Sunday during the day, the day before (not Friday or Sunday night)');
  r = planFloat([trip('2026-11-09 16:00', '2026-11-11 06:00')], cd, tr, {}).runs[0];
  ok(r.pick.getDate() === 10 && !r.weekend && !r.outHours && !r.curfew, 'Monday 16:00 → Wednesday 06:00: Tuesday, the day before, in hours and out of the curfew');
  ok(hm(r.leave) === '09:00', '…the float leaves at 09:00, as the morning curfew ends');
  r = planFloat([trip('2026-11-09 16:00', '2026-11-13 05:00')], cd, tr, {}).runs[0];
  ok(r.pick.getDate() === 12, 'Monday → Friday start: Thursday, the day before (not as soon as it’s free)');
  r = planFloat([{ ...trip('2026-11-09 16:00', '2026-11-13 05:00'), to: { key: 'yard' } }], cd, tr, {}).runs[0];
  ok(r.pick.getDate() === 10, 'back to the yard: as soon as it can in hours (Tuesday)');
  r = planFloat([trip('2026-11-05 16:00', '2026-11-09 06:00')], cd, tr, {}).runs[0];
  ok(r.pick.getDay() === 5 && !r.curfew && !r.outHours, 'Thursday 16:00 → Monday: Friday daytime, not the weekend, clear of the curfew');
  r = planFloat([trip('2026-11-10 04:00', '2026-11-10 06:30')], cd, tr, {}).runs[0];
  ok(hm(r.pick) === '04:00' && r.outHours && !r.late, 'night shift ends 04:00, day starts 06:30: still planned on time, marked outside the driver’s hours');
  r = planFloat([trip('2026-11-09 16:00', '2026-11-11 06:00')], { ...cd, driverShift: 'night' }, tr, {}).runs[0];
  ok(r.pick.getDate() === 10 && hm(r.leave) === '18:00', 'a night driver: the night before (Tuesday 18:00)');
  r = planFloat([trip('2026-11-06 16:00', '2026-11-09 06:00')], { ...cd, avoidWeekend: false, driverShift: 'any' }, tr, {}).runs[0];
  ok(r.pick.getDay() === 0 && hm(r.pick) === '06:00', 'any time, weekends fine: still the day before, in daylight (Sunday 06:00)');
}

// the oversize peak-hour curfew: the float isn't on the road 7–9am and 4–6pm on weekdays (empty or loaded)
{
  const tr = () => ({ min: 40, km: 30 });
  const trip = (e, l) => ({ id: 'y', moves: [{ m: 'a', name: 'PV009' }], from: { key: 'A' }, to: { key: 'B' }, earliest: t(e), latest: t(l) });
  const cd = cfgOf({});
  let r = planFloat([trip('2026-11-10 07:00', '2026-11-10 15:00')], cd, tr, {}).runs[0];
  ok(!r.curfew && r.depart >= t('2026-11-10 09:00') && r.arrive <= t('2026-11-10 16:00'), 'free at 7am Tuesday: loaded and away at 9am, there before the 4pm curfew');
  r = planFloat([trip('2026-11-10 04:00', '2026-11-10 06:30')], cd, tr, {}).runs[0];
  ok(!r.curfew && r.arrive <= t('2026-11-10 07:00'), 'night shift off at 4am, needed 6:30am: driven before 7am');
  r = planFloat([trip('2026-11-14 07:00', '2026-11-14 12:00')], { ...cd, avoidWeekend: false }, tr, {}).runs[0];
  ok(!r.curfew && r.depart < t('2026-11-14 09:00'), 'Saturday: no curfew, so it goes before 9am');
  r = planFloat([trip('2026-11-10 07:00', '2026-11-10 09:00')], cd, tr, {}).runs[0];
  ok(r.curfew && !r.late, 'only possible in the curfew (free 7am, needed by 9am): planned on time, and marked');
  r = planFloat([trip('2026-11-10 07:00', '2026-11-10 15:00')], cd, tr, {}).runs[0];
  ok(r.leave >= t('2026-11-10 09:00') || r.pick <= t('2026-11-10 07:00'), 'the empty run to the pick-up isn’t in the curfew either (leaves 9am or later)');
  r = planFloat([trip('2026-11-10 07:00', '2026-11-10 15:00')], { ...cd, curfew: false }, tr, {}).runs[0];
  ok(!r.curfew, 'curfew switched off: not checked');
}
console.log(fails ? `${fails} FAILED` : 'ALL FLOAT TESTS PASSED'); process.exit(fails ? 1 : 0);
