// Checks api/servicem8.js against stand-ins for Supabase and ServiceM8. Run: node tests/api_servicem8_test.js
const mod = require('../api/servicem8.js');
const { handler, mapJob, parseMeters, describeJob, signState, checkState } = mod;

let fails = 0;
const ok = (c, l) => { console.log((c ? 'PASS' : 'FAIL') + ': ' + l); if (!c) fails++; };

/* ---------- the pure parts ---------- */
function pureChecks() {
  let m = parseMeters('Did the 500 hr service. Hours: 4,530.5 and Km 123456', 'both');
  ok(m.length === 2 && m[0].value === 4530.5 && m[1].value === 123456, 'meters: "Hours: 4,530.5" and "Km 123456" are read; "500 hr service" is not a reading');
  ok(parseMeters('Hours: 4530', 'km').length === 0, 'meters: hours ignored on a km-only machine');
  ok(parseMeters('changed oil, took 3 hours', 'hours').length === 0, 'meters: "took 3 hours" is not a reading');

  const cfg = { contractor_name: 'Smith Mechanical', parts_queue_uuid: 'q-parts' };
  const wo = { id: 'w1', status: 'open', wo_type: 'breakdown', start_date: null };
  const act = (sch, s, e) => ({ active: 1, activity_was_scheduled: sch, start_date: s, end_date: e });
  let r = mapJob({ job: { active: 1, status: 'Work Order', generated_job_id: 77 }, activities: [act(1, '2026-11-03 07:00:00', '2026-11-04 15:00:00')], materials: [], wo, cfg });
  ok(r.patch.status === 'scheduled' && r.patch.start_date === '2026-11-03' && r.patch.end_date === '2026-11-04' && r.job.job_no === '77', 'booked in ServiceM8 → Scheduled, with his dates');
  ok(r.patch.assigned_to === 'Smith Mechanical', 'the contractor is filled in as Assigned');
  r = mapJob({ job: { active: 1, status: 'Work Order' }, activities: [act(1, '2026-11-03 07:00:00', '2026-11-03 09:00:00'), act(0, '2026-11-03 07:10:00', '2026-11-03 08:00:00')], materials: [], wo, cfg });
  ok(r.patch.status === 'in_progress', 'time recorded on the job → In progress');
  r = mapJob({ job: { active: 1, status: 'Work Order', queue_uuid: 'q-parts' }, activities: [], materials: [], wo: { ...wo, status: 'in_progress' }, cfg });
  ok(r.patch.status === 'awaiting_parts', 'in his "awaiting parts" queue → Awaiting parts');
  r = mapJob({ job: { active: 1, status: 'Work Order', queue_uuid: '' }, activities: [act(1, '2026-11-05 07:00:00', '2026-11-05 09:00:00')], materials: [], wo: { ...wo, status: 'awaiting_parts' }, cfg, prev: { sm8_queue: 'q-parts' } });
  ok(r.patch.status === 'scheduled', 'he takes it out of the parts queue, with a booking → Scheduled');
  r = mapJob({ job: { active: 1, status: 'Work Order', queue_uuid: '' }, activities: [], materials: [], wo: { ...wo, status: 'awaiting_parts' }, cfg, prev: { sm8_queue: null } });
  ok(!r.patch.status, '“Awaiting parts” set here (not his queue) stays');
  r = mapJob({ job: { active: 1, status: 'Work Order' }, activities: [{ active: 1, activity_was_scheduled: 0, activity_was_recorded: 1, start_date: '2026-11-03 07:00:00' }], materials: [], wo, cfg });
  ok(r.patch.status === 'in_progress' && !r.patch.start_date, 'recorded time only: In progress, and it isn’t taken as a booking');
  r = mapJob({ job: { active: 1, status: 'Work Order' }, activities: [act(1, '2026-11-05 07:00:00', '2026-11-05 09:00:00')], materials: [], wo: { ...wo, status: 'in_progress' }, cfg });
  ok(!r.patch.status, 'never backwards: In progress stays In progress when only a booking is seen');
  r = mapJob({ job: { active: 1, status: 'Completed', work_done_description: 'Replaced hose. Hours: 4530', completion_date: '2026-11-04 14:00:00' },
    activities: [], materials: [{ active: 1, name: 'Hydraulic hose', quantity: '2.0000' }, { active: 0, name: 'Deleted line', quantity: '1' }], wo, cfg,
    profile: { meter_type: 'hours' }, latest: { hours: 4500 } });
  ok(r.patch.status === 'completed' && r.patch.completion_notes === 'Replaced hose. Hours: 4530', 'Completed → Completed, his Work Done as the completion notes');
  ok(r.patch.parts.length === 1 && r.patch.parts[0].part === 'Hydraulic hose' && r.patch.parts[0].qty === '2', 'his materials → parts (deleted lines left out, "2.0000" → "2")');
  ok(r.meters.length === 1 && r.meters[0].value === 4530 && !r.service, 'a repair: the hours become a meter reading');
  {
    const sent = 'FraserFlow WO 1042 · Breakdown · High priority\nMachine: R12\n\nHose burst\n\nLeft boom';
    r = mapJob({ job: { active: 1, status: 'Completed', work_done_description: '', job_description: sent + '\nAlso found worn pins, replaced\nHours: 4600' },
      notes: [{ active: 1, note: 'Ordered hose from Pirtek', create_date: '2026-11-03 08:10:00' }, { active: 0, note: 'deleted' }, { active: 1, note: 'Fitted hose, tested OK', create_date: '2026-11-04 13:00:00' }],
      sent, activities: [], materials: [], wo, cfg, profile: { meter_type: 'hours' }, latest: { hours: 4500 } });
    ok(r.patch.completion_notes === '- 2026-11-03 08:10: Ordered hose from Pirtek\n- 2026-11-04 13:00: Fitted hose, tested OK', 'completed with no Work Done: his notes become the completion notes, oldest first (deleted ones left out)');
    ok(r.job.notes.length === 2 && r.job.notes[0].text === 'Ordered hose from Pirtek' && r.job.notes[1].at === '2026-11-04 13:00', 'his notes are kept for their own box on the work order');
    ok(r.job.description === 'Also found worn pins, replaced\nHours: 4600', 'his description is kept for its own box, without FraserFlow’s own text');
    ok(r.patch.parts.some(p => p.part === 'Hose'), 'a part he mentions ("Fitted hose") is added to the parts');
    ok(r.meters.length === 1 && r.meters[0].value === 4600, 'a reading in his notes or description is picked up too');
    r = mapJob({ job: { active: 1, status: 'Completed', work_done_description: 'Replaced hose' }, notes: [], sent, activities: [], materials: [],
      wo: { ...wo, status: 'completed', completion_notes: 'Completed in ServiceM8 (job 501)' }, cfg, profile: { meter_type: 'hours' }, latest: {} });
    ok(r.patch.completion_notes === 'Replaced hose' && !r.patch.status, 'a work order completed before this fix gets his notes on the next refresh');
  }
  r = mapJob({ job: { active: 1, status: 'Work Order', job_description: 'FraserFlow WO 1042\nNeeds new battery' },
    notes: [{ active: 1, note: 'Replaced oil filter and fuel filter, used 20L engine oil', create_date: '2026-11-03 08:10:00' }], sent: 'FraserFlow WO 1042', activities: [],
    materials: [{ active: 1, name: 'Fuel filter', quantity: '2' }], wo: { ...wo, status: 'in_progress', parts: [{ part: 'Grease', qty: '1' }] }, cfg });
  ok(!r.patch.status && r.job.notes[0].text.startsWith('Replaced oil filter') && r.job.description === 'Needs new battery', 'before completion: his notes and description come through live');
  ok(JSON.stringify(r.patch.parts) === JSON.stringify([{ part: 'Grease', qty: '1' }, { part: 'Fuel filter', qty: '2' }, { part: 'Oil filter', qty: '1' }, { part: 'Engine oil', qty: '20L' }]),
    'parts: what was there, his materials, then parts he mentions (each once; his materials win on quantity)');
  r = mapJob({ job: { active: 1, status: 'Completed', work_done_description: 'Hours: 12' }, activities: [], materials: [], wo, cfg, profile: { meter_type: 'hours' }, latest: { hours: 4500 } });
  ok(r.meters.length === 0, 'a reading lower than the machine’s last one is ignored');
  r = mapJob({ job: { active: 1, status: 'Completed', work_done_description: '', completion_date: '2026-11-04 14:00:00' }, activities: [], materials: [], wo: { ...wo, wo_type: 'service' }, cfg,
    profile: { meter_type: 'hours' }, latest: {} });
  ok(r.service && r.service.done_on === '2026-11-04' && r.service.mechanic === 'Smith Mechanical' && /Completed in ServiceM8/.test(r.patch.completion_notes),
    'a service: becomes the service record, dated when he completed it; empty Work Done gets a note');
  r = mapJob({ job: { active: 1, status: 'Work Order' }, activities: [], materials: [], wo: { ...wo, status: 'completed' }, cfg, prev: { sm8_status: 'Completed' } });
  ok(r.patch.status === 'in_progress', 'he reopens a completed job → In progress');
  r = mapJob({ job: { active: 1, status: 'Work Order' }, activities: [act(0, '2026-11-03 07:00:00', '2026-11-03 08:00:00')], materials: [], wo: { ...wo, status: 'completed' }, cfg, prev: { sm8_status: 'Work Order' } });
  ok(!r.patch.status, 'completed here while his job is still open: it stays completed (not undone by the next refresh)');
  r = mapJob({ job: { active: 1, status: 'Unsuccessful' }, activities: [act(1, '2026-11-05 07:00:00', '2026-11-05 09:00:00')], materials: [{ active: 1, name: 'x', quantity: 1 }], wo, cfg });
  ok(r.patch.status === 'cancelled' && !r.patch.parts && !r.patch.start_date, 'Unsuccessful → Cancelled (no parts or dates carried over)');
  r = mapJob({ job: { active: 0, status: 'Work Order' }, activities: [], materials: [], wo, cfg });
  ok(r.job.removed === true && r.patch === null, 'job deleted in ServiceM8 → marked removed, work order left alone');
  r = mapJob({ job: { active: 1, status: 'Completed' }, activities: [], materials: [], wo: { ...wo, status: 'closed' }, cfg });
  ok(r.patch === null, 'a verified & closed work order isn’t changed by ServiceM8');

  const d = describeJob({ wo: { number: 1042, wo_type: 'breakdown', priority: 'high', asset_id: 'm1', title: 'Hose burst', description: 'Left boom', safe_to_operate: false },
    machine: { name: 'R12', sub: 'Pneumatic roller', rego: 'ABC123' }, profile: { make: 'Cat', model: 'CW34', year: 2019, meter_type: 'hours' },
    meters: [{ kind: 'hours', value: 4512, read_at: '2026-10-30T01:00:00Z' }], defects: [{ number: 1012, title: 'Hydraulic leak', severity: 'major' }] });
  ok(/FraserFlow WO 1042/.test(d) && /Rego ABC123/.test(d) && /Cat CW34 2019/.test(d) && /4,512 h/.test(d) && /NOT SAFE/.test(d) && /D-1012 Hydraulic leak/.test(d) && /"Hours: 4530"/.test(d),
    'the job description carries the WO number, machine, rego, make/model, last reading, safety, defects and how to give the reading');

  const st = signState('secret', 'user-1');
  ok(checkState('secret', st) && checkState('secret', st).u === 'user-1' && !checkState('other', st) && !checkState('secret', st.slice(0, -2) + 'xx'), 'connect: the signed state can’t be forged');
}

/* ---------- the handler, against stand-ins ---------- */
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', SERVICEM8_API_KEY: 'smk', CRON_SECRET: 'cron' };
const USERS = { 'tok-admin': { id: '00000000-0000-0000-0000-0000000000a1', role: 'admin' }, 'tok-mech': { id: '00000000-0000-0000-0000-0000000000a2', role: 'mechanic' },
  'tok-planner': { id: '00000000-0000-0000-0000-0000000000a3', role: 'planner' } };
const WO1 = '00000000-0000-0000-0000-00000000c001', JOB_OTHER = '00000000-0000-0000-0000-0000000000f9';
let db, sm8Calls, rpcCalls;
function reset() {
  db = {
    settings: { id: 1, enabled: true, auto_send: true, client_name: 'AFA', company_uuid: null, contractor_name: 'Smith Mechanical', job_address: '1 Depot Rd', parts_queue_uuid: null },
    secrets: { id: 1, webhook_key: 'ab'.repeat(24) },
    links: [{ work_order_id: WO1, state: 'pending', dirty: false, job_uuid: null, attempts: 0, updated_at: '2026-10-31T00:00:00+00:00' }],
    wos: [{ id: WO1, number: 1042, asset_id: 'm1', wo_type: 'breakdown', priority: 'high', title: 'Hose burst', description: 'Left boom', status: 'open' }],
    jobs: {}, companies: [], attachments: [], files: [], uploads: [],
  };
  sm8Calls = []; rpcCalls = [];
}
const json = (status, body, headers = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: k => headers[k.toLowerCase()] || null } });
async function http(url, o = {}) {
  const h = o.headers || {}, m = o.method || 'GET';
  if (url.endsWith('/auth/v1/user')) { const u = USERS[h.Authorization.replace('Bearer ', '')]; return u ? json(200, { id: u.id }) : json(401, {}); }
  if (url.includes('.supabase.co/storage/v1/object/maintenance/')) {
    if (h.apikey !== 'service') throw new Error('file store used without the service key');
    db.uploads.push({ path: decodeURIComponent(url.split('/object/maintenance/')[1]), type: h['Content-Type'], size: o.body.length }); return json(200, {});
  }
  if (url.includes('.supabase.co/rest/v1/')) {
    if (h.apikey !== 'service') throw new Error('database used without the service key');
    const p = decodeURIComponent(url.split('/rest/v1/')[1]);
    if (p.startsWith('profiles')) { const id = p.match(/id=eq\.([^&]+)/)[1]; const u = Object.values(USERS).find(x => x.id === id); return json(200, u ? [{ role: u.role }] : []); }
    if (p.startsWith('servicem8_settings')) { if (m === 'PATCH') Object.assign(db.settings, JSON.parse(o.body)); return json(200, [db.settings]); }
    if (p.startsWith('servicem8_secrets')) { if (m === 'PATCH') Object.assign(db.secrets, JSON.parse(o.body)); return json(200, [db.secrets]); }
    if (p.startsWith('servicem8_jobs')) {
      if (m === 'PATCH') {
        const id = p.match(/work_order_id=eq\.([^&]+)/)[1]; const st = (p.match(/state=eq\.([^&]+)/) || [])[1];
        const hit = db.links.filter(l => l.work_order_id === id && (!st || l.state === st));
        hit.forEach(l => Object.assign(l, JSON.parse(o.body)));
        return json(200, hit);
      }
      if (p.includes('job_uuid=in.')) { const ids = p.match(/job_uuid=in\.\(([^)]*)\)/)[1].split(','); return json(200, db.links.filter(l => l.state === 'sent' && ids.includes(l.job_uuid))); }
      if (p.includes('work_order_id=eq.')) { const id = p.match(/work_order_id=eq\.([^&]+)/)[1]; return json(200, db.links.filter(l => l.work_order_id === id)); }
      if (p.includes('or=(state.eq.pending')) return json(200, db.links.filter(l => ['pending', 'error'].includes(l.state) || (l.state === 'sent' && l.dirty)));
      if (p.includes('state=eq.sent')) return json(200, []);
      return json(200, db.links);
    }
    if (p.startsWith('work_orders')) { const id = p.match(/id=eq\.([^&]+)/)[1]; return json(200, db.wos.filter(w => w.id === id)); }
    if (p.startsWith('items')) return json(200, [{ data: { name: 'R12', sub: 'Pneumatic roller', rego: 'ABC123' } }]);
    if (p.startsWith('asset_profiles')) return json(200, [{ meter_type: 'hours' }]);
    if (p.startsWith('meter_readings')) return json(200, p.includes('kind=eq.hours') ? [{ kind: 'hours', value: 4500, read_at: '2026-10-30T00:00:00Z' }] : []);
    if (p.startsWith('defects')) return json(200, []);
    if (p.startsWith('maintenance_files') && m === 'POST') { if (db.filesBroken) return json(400, { message: 'column "work_order_id" does not exist' }); db.files.push(JSON.parse(o.body)); return json(201, null); }
    if (p.startsWith('maintenance_files')) { const ids = p.match(/sm8_uuid=in\.\(([^)]*)\)/)[1].split(','); return json(200, db.files.filter(f => ids.includes(f.sm8_uuid))); }
    if (p.startsWith('maintenance_audit')) return json(201, null);
    if (p.startsWith('rpc/servicem8_apply')) { const a = JSON.parse(o.body); rpcCalls.push(a); const l = db.links.find(x => x.work_order_id === a.p_wo); if (l) Object.assign(l, { sm8_status: a.p_job.sm8_status, job_no: a.p_job.job_no }); return json(200, (a.p_patch && a.p_patch.status) || 'open'); }
    throw new Error('unexpected database call ' + p);
  }
  if (url.startsWith('https://api.servicem8.com/')) {
    sm8Calls.push({ url: decodeURIComponent(url), method: m, body: o.body, headers: h });
    if (h['X-API-Key'] !== 'smk') return json(401, {});
    const path = decodeURIComponent(url.replace('https://api.servicem8.com/api_1.0', ''));
    if (url.startsWith('https://api.servicem8.com/webhook_subscriptions')) return json(200, { success: true });
    if (path.startsWith('/company.json') && m === 'GET') return json(200, db.companies);
    if (path === '/company.json' && m === 'POST') { const id = '00000000-0000-0000-0000-0000000000e1'; db.companies.push({ uuid: id, name: JSON.parse(o.body).name }); return json(200, {}, { 'x-record-uuid': id }); }
    if (path === '/job.json' && m === 'POST') { const b = JSON.parse(o.body); db.jobs[b.uuid] = { ...b, active: 1, generated_job_id: 501 }; return json(200, {}, { 'x-record-uuid': b.uuid }); }
    let mm = path.match(/^\/job\/([^.]+)\.json$/);
    if (mm && m === 'GET') return db.jobs[mm[1]] ? json(200, db.jobs[mm[1]]) : json(404, {});
    if (mm && m === 'POST') { Object.assign(db.jobs[mm[1]], JSON.parse(o.body)); return json(200, {}); }
    if (path.startsWith('/attachment.json')) { const u = path.match(/related_object_uuid eq '([^']+)'/)[1]; return json(200, db.attachments.filter(a => a.related_object_uuid === u)); }
    let mf = path.match(/^\/attachment\/([^./]+)\.file$/);
    if (mf) return json(200, 'JPEGDATA-' + mf[1]);
    mf = path.match(/^\/attachment\/([^./]+)\.json$/);
    if (mf) { const a = db.attachments.find(x => x.uuid === mf[1]); return a ? json(200, a) : json(404, {}); }
    let ma = path.match(/^\/jobactivity\/([^.]+)\.json$/);
    if (ma) return (db.activities || {})[ma[1]] ? json(200, db.activities[ma[1]]) : json(404, {});
    if (path.startsWith('/jobactivity.json')) return json(200, []);
    if (path.startsWith('/jobmaterial.json')) return json(200, []);
    if (path === '/note.json') return json(200, {});
    if (path.startsWith('/queue.json')) return json(200, [{ uuid: 'q1', name: 'Awaiting parts', active: 1 }]);
    throw new Error('unexpected ServiceM8 call ' + m + ' ' + path);
  }
  throw new Error('unexpected call ' + url);
}
async function call({ method = 'POST', token, body, query = {}, headers = {}, env = ENV, url }) {
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(s) { this.raw = s; try { this.body = JSON.parse(s) } catch (e) { this.body = s } } };
  await handler({ method, query, url, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), host: 'ff.example.com', ...headers }, body }, res, env, http);
  return res;
}

(async () => {
  pureChecks();
  reset();
  let r = await call({ token: 'tok-admin', body: { action: 'status' }, env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' } });
  ok(r.statusCode === 501 && /SUPABASE_SERVICE_ROLE_KEY/.test(r.body.error), 'without the service key it says how to switch it on');
  r = await call({ body: { action: 'flush' } }); ok(r.statusCode === 401, 'not signed in: refused');
  r = await call({ token: 'tok-planner', body: { action: 'flush' } }); ok(r.statusCode === 403, 'a planner can’t send to ServiceM8');
  r = await call({ token: 'tok-mech', body: { action: 'setup' } }); ok(r.statusCode === 403, 'a mechanic can’t change the ServiceM8 setup');
  r = await call({ token: 'tok-mech', body: { action: 'status' } }); ok(r.statusCode === 200 && r.body.mode === 'key' && r.body.connected, 'status: using an API key, connected');

  // sending a new work order
  r = await call({ token: 'tok-mech', body: { action: 'flush' } });
  const job = Object.values(db.jobs)[0];
  ok(r.statusCode === 200 && r.body.sent === 1 && job, 'flush: the waiting work order is sent');
  ok(job.status === 'Work Order' && job.purchase_order_number === 'FF WO 1042' && job.job_address === '1 Depot Rd' && /Rego ABC123/.test(job.job_description) && /4,500 h/.test(job.job_description),
    'the job: a Work Order, PO "FF WO 1042", the depot address, the machine and its last reading');
  ok(db.companies.length === 1 && db.settings.company_uuid === db.companies[0].uuid && job.company_uuid === db.companies[0].uuid, 'AFA’s client record is made once (none existed) and the job sits under it');
  const link = db.links[0];
  ok(link.state === 'sent' && link.job_uuid === job.uuid && link.job_no === '501', 'the work order is linked to the job, with his job number');
  ok(rpcCalls.length === 1 && rpcCalls[0].p_patch.assigned_to === 'Smith Mechanical', 'after sending, the contractor shows as Assigned');
  r = await call({ token: 'tok-mech', body: { action: 'flush' } });
  ok(Object.keys(db.jobs).length === 1 && r.body.sent === 0, 'flushing again doesn’t send it twice');

  // ServiceM8 reporting changes
  const key = db.secrets.webhook_key;
  r = await call({ method: 'POST', query: { hook: 'x'.repeat(48) }, body: { object: 'job', entry: [{ uuid: link.job_uuid }] } });
  ok(r.statusCode === 403, 'a report with the wrong key is refused');
  r = await call({ method: 'POST', query: { hook: key }, body: { mode: 'subscribe', challenge: 'abc123' } });
  ok(r.statusCode === 200 && r.raw === 'abc123', 'ServiceM8’s challenge is answered (form POST)');
  r = await call({ method: 'GET', query: { hook: key, mode: 'subscribe', challenge: 'c08f57bd' } });
  ok(r.statusCode === 200 && r.raw === 'c08f57bd', 'ServiceM8’s challenge is answered (in the address, GET)');
  r = await call({ method: 'POST', query: { hook: key + '?mode=subscribe&challenge=c08f57bd' }, body: {} });
  ok(r.statusCode === 200 && r.raw === 'c08f57bd', 'ServiceM8’s challenge is answered (tacked onto the address after the key)');
  r = await call({ method: 'POST', query: { hook: key }, body: { challenge: 'zz9' } });
  ok(r.statusCode === 200 && r.raw === 'zz9', 'ServiceM8’s challenge is answered (no mode given)');
  {
    const B = '------------------------85OKRJ1qxwEOz6skUGgbh4';
    const raw = `--${B}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nsubscribe\r\n--${B}\r\nContent-Disposition: form-data; name="challenge"\r\n\r\n83f47603fd9b2688\r\n--${B}--\r\n`;
    r = await call({ method: 'POST', query: { hook: key, key }, body: raw, headers: { 'content-type': 'multipart/form-data; boundary=' + B } });
    ok(r.statusCode === 200 && r.raw === '83f47603fd9b2688', 'ServiceM8’s check sent as multipart/form-data (as it really does) is answered');
  }
  r = await call({ method: 'POST', query: {}, body: { mode: 'subscribe', challenge: 'addon1' }, url: '/api/servicem8' });
  ok(r.statusCode === 200 && r.raw === 'addon1', 'the check is answered at the add-on’s own address too (no key)');
  r = await call({ method: 'POST', headers: {}, query: {}, body: { challenge: 'p1' }, url: '/api/servicem8-hook/' + key });
  ok(r.statusCode === 200 && r.raw === 'p1', 'the key can come in the path');
  sm8Calls.length = 0;
  r = await call({ method: 'POST', query: { hook: key }, body: { object: 'job', entry: [{ uuid: JOB_OTHER, changed_fields: ['status'] }] } });
  ok(r.statusCode === 200 && sm8Calls.length === 0, 'a change to one of his other clients’ jobs: ignored without looking at it');
  db.jobs[link.job_uuid].status = 'Completed'; db.jobs[link.job_uuid].work_done_description = 'Replaced hose. Hours: 4530';
  rpcCalls.length = 0;
  r = await call({ method: 'POST', query: { hook: key }, body: { object: 'job', entry: [{ uuid: link.job_uuid, changed_fields: ['status'] }] } });
  ok(r.statusCode === 200 && rpcCalls.length === 1 && rpcCalls[0].p_patch.status === 'completed' && rpcCalls[0].p_meters[0].value === 4530, 'he completes our job: the work order is completed with his notes and the reading');

  db.settings.enabled = false; sm8Calls.length = 0; rpcCalls.length = 0;
  r = await call({ method: 'POST', query: { hook: key }, body: { object: 'job', entry: [{ uuid: link.job_uuid }] } });
  ok(r.statusCode === 200 && !sm8Calls.length && !rpcCalls.length, 'switched off: reports are acknowledged and ignored (ServiceM8 doesn’t keep retrying)');
  db.settings.enabled = true;
  r = await call({ method: 'POST', query: { hook: 'ü'.repeat(24) }, body: {} });
  ok(r.statusCode === 403, 'an odd key (other characters, other length) is refused, not an error');

  // a booking changed (reported as a job activity)
  db.jobs[link.job_uuid].status = 'Work Order'; db.wos[0].status = 'open'; rpcCalls.length = 0; sm8Calls.length = 0;
  db.activities = { '00000000-0000-0000-0000-0000000000b1': { uuid: '00000000-0000-0000-0000-0000000000b1', job_uuid: link.job_uuid }, '00000000-0000-0000-0000-0000000000b2': { uuid: '00000000-0000-0000-0000-0000000000b2', job_uuid: JOB_OTHER } };
  r = await call({ method: 'POST', query: { hook: key }, body: { object: 'JobActivity', entry: [{ uuid: '00000000-0000-0000-0000-0000000000b1' }] } });
  ok(r.statusCode === 200 && rpcCalls.length === 1 && rpcCalls[0].p_wo === WO1, 'a booking made in ServiceM8 refreshes its work order');
  rpcCalls.length = 0; sm8Calls.length = 0;
  r = await call({ method: 'POST', query: { hook: key }, body: { object: 'jobactivity', entry: [{ uuid: '00000000-0000-0000-0000-0000000000b2' }] } });
  ok(r.statusCode === 200 && !rpcCalls.length && !sm8Calls.some(c => c.url.includes('/job/')), 'a booking on another client’s job: only its job link is read, then dropped');

  // his photos and PDFs
  db.wos[0].status = 'in_progress'; db.jobs[link.job_uuid].status = 'Work Order';
  db.attachments = [
    { uuid: '00000000-0000-0000-0000-0000000000d1', related_object: 'job', related_object_uuid: link.job_uuid, attachment_name: 'Burst hose', file_type: '.JPG', active: 1 },
    { uuid: '00000000-0000-0000-0000-0000000000d2', related_object: 'job', related_object_uuid: link.job_uuid, attachment_name: 'Pirtek invoice.pdf', file_type: '.pdf', active: 1 },
    { uuid: '00000000-0000-0000-0000-0000000000d3', related_object: 'job', related_object_uuid: link.job_uuid, attachment_name: 'Clip', file_type: '.mov', active: 1 },
    { uuid: '00000000-0000-0000-0000-0000000000d4', related_object: 'job', related_object_uuid: JOB_OTHER, attachment_name: 'Someone else', file_type: '.jpg', active: 1 }];
  r = await call({ token: 'tok-mech', body: { action: 'sync', wo: WO1 } });
  ok(r.statusCode === 200 && db.files.length === 2 && db.uploads.length === 2, 'his photo and PDF are copied in (a video is skipped)');
  ok(/Not copied .*Clip \(\.mov\)/.test(db.links[0].files_error || ''), 'the skipped video is named on the work order, with why');
  const ph = db.files.find(f => f.sm8_uuid === '00000000-0000-0000-0000-0000000000d1'), pdf = db.files.find(f => f.sm8_uuid === '00000000-0000-0000-0000-0000000000d2');
  ok(ph && ph.kind === 'photo' && ph.mime === 'image/jpeg' && ph.name === 'WO 1042 · Burst hose.jpg' && ph.work_order_id === WO1 && ph.path === 'assets/m1/sm8/00000000-0000-0000-0000-0000000000d1.jpg'
    && pdf && pdf.kind === 'document' && pdf.name === 'WO 1042 · Pirtek invoice.pdf', 'they’re kept with the machine’s files, linked to the work order, named with the WO number');
  r = await call({ token: 'tok-mech', body: { action: 'sync', wo: WO1 } });
  ok(db.files.length === 2 && db.uploads.length === 2, 'refreshing again doesn’t copy them twice');
  sm8Calls.length = 0; rpcCalls.length = 0;
  r = await call({ method: 'POST', query: { hook: key }, body: { object: 'attachment', entry: [{ uuid: '00000000-0000-0000-0000-0000000000d4' }] } });
  ok(r.statusCode === 200 && !rpcCalls.length && !sm8Calls.some(c => c.url.includes('.file')), 'a photo on another client’s job: its link is read, nothing is copied');
  db.attachments.push({ uuid: '00000000-0000-0000-0000-0000000000d5', related_object: 'job', related_object_uuid: link.job_uuid, attachment_name: 'After', file_type: '.png', active: 1 });
  r = await call({ method: 'POST', query: { hook: key }, body: { object: 'attachment', entry: [{ uuid: '00000000-0000-0000-0000-0000000000d5' }] } });
  ok(r.statusCode === 200 && db.files.length === 3 && db.files[2].mime === 'image/png', 'a photo he adds later arrives as soon as ServiceM8 reports it');

  db.filesBroken = true;
  db.attachments.push({ uuid: '00000000-0000-0000-0000-0000000000d6', related_object: 'job', related_object_uuid: link.job_uuid, attachment_name: 'Gauge.jpeg', file_type: 'jpeg', active: 1 });
  r = await call({ token: 'tok-mech', body: { action: 'sync', wo: WO1 } });
  ok(r.statusCode === 200 && /work_order_id/.test(db.links[0].files_error || ''), 'when a photo can’t be copied, the reason shows on the work order (the rest of the update still happens)');
  db.filesBroken = false;
  r = await call({ token: 'tok-mech', body: { action: 'sync', wo: WO1 } });
  ok(db.files.some(f => f.sm8_uuid === '00000000-0000-0000-0000-0000000000d6' && f.mime === 'image/jpeg') && !/work_order_id/.test(db.links[0].files_error || ''), 'a file type given without the dot ("jpeg") is copied, and the problem clears');

  // a change made in FraserFlow
  db.links[0].sm8_status = 'Work Order'; db.jobs[link.job_uuid].status = 'Work Order';
  db.wos[0].status = 'cancelled'; db.links[0].dirty = true;
  r = await call({ token: 'tok-mech', body: { action: 'flush' } });
  ok(db.jobs[link.job_uuid].status === 'Unsuccessful' && sm8Calls.some(c => c.url.endsWith('/note.json')) && db.links[0].dirty === false, 'cancelled in FraserFlow: his job is marked Unsuccessful, with a note');

  // a work order finished before it was sent
  reset(); db.wos[0].status = 'completed';
  r = await call({ token: 'tok-mech', body: { action: 'flush' } });
  ok(db.links[0].state === 'skipped' && !Object.keys(db.jobs).length, 'a work order already finished before sending is skipped, not sent');

  // ServiceM8 refusing
  reset(); r = await call({ token: 'tok-mech', body: { action: 'flush' }, env: { ...ENV, SERVICEM8_API_KEY: 'wrong' } });
  ok(r.body.errors.length === 1 && db.links[0].state === 'error' && /401/.test(db.links[0].last_error), 'when ServiceM8 refuses, the work order shows the error and is tried again later');

  // setup, cron
  reset(); db.companies.push({ uuid: '00000000-0000-0000-0000-0000000000e7', name: 'AFA' });
  r = await call({ token: 'tok-admin', body: { action: 'setup' } });
  const sub = sm8Calls.find(c => c.url.includes('webhook_subscriptions'));
  ok(r.statusCode === 200 && r.body.bookings === true && sm8Calls.some(c => c.url.includes('webhook_subscriptions') && c.body.includes('object=jobactivity')) && db.settings.company_uuid === '00000000-0000-0000-0000-0000000000e7' && sub && sub.body.includes('object=job') && sub.body.includes(encodeURIComponent('https://ff.example.com/api/servicem8-hook/' + db.secrets.webhook_key)),
    'setup: finds the existing AFA client and tells ServiceM8 where to report job changes');
  r = await call({ method: 'GET', query: { cron: '1' }, headers: { authorization: 'Bearer nope' } }); ok(r.statusCode === 401, 'the daily check needs CRON_SECRET');
  r = await call({ method: 'GET', query: { cron: '1' }, headers: { authorization: 'Bearer cron' } }); ok(r.statusCode === 200 && r.body.sent === 1, 'the daily check sends anything still waiting');
  r = await call({ method: 'GET', query: { cron: '1', all: '1' }, headers: { authorization: 'Bearer cron' } }); ok(r.statusCode === 200 && r.body.errors.length === 0, 'the 10-minute schedule runs');
  db.settings.enabled = false; r = await call({ token: 'tok-mech', body: { action: 'flush' } }); ok(r.body.off === true, 'switched off: nothing is sent');

  console.log(fails ? `${fails} FAILED` : 'ALL SERVICEM8 FUNCTION TESTS PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
