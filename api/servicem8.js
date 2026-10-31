// The link to the contract mechanic's ServiceM8 (see supabase/servicem8.sql and the README).
//
// FraserFlow → ServiceM8: new work orders become jobs under AFA's client record in his ServiceM8.
// ServiceM8 → FraserFlow: when he books, starts, parks (awaiting parts), completes or abandons a job,
// the work order follows. Verifying and closing stay in FraserFlow.
//
// What it touches in his ServiceM8: only jobs FraserFlow made. When ServiceM8 reports a change to a job,
// the job's id is checked against servicem8_jobs first; jobs that aren't ours are never fetched.
//
// Settings (Vercel → Project → Settings → Environment Variables), besides SUPABASE_SERVICE_ROLE_KEY:
//   either SERVICEM8_APP_ID + SERVICEM8_APP_SECRET   (an unlisted ServiceM8 add-on: he connects it, and can disconnect it)
//   or     SERVICEM8_API_KEY                        (a key he makes in ServiceM8 → Settings → API Keys)
//   CRON_SECRET (optional): lets Vercel's daily check run (vercel.json → crons)
//
// Calls:
//   POST /api/servicem8 (Authorization: Bearer <signed-in person's access token>)
//     { action: 'status' }                       how the link is set up
//     { action: 'flush' }                        send waiting work orders, pass on changes, refresh a few jobs (mechanics, supervisors, admins)
//     { action: 'sync', wo: '<work order id>' }  refresh one work order from its job now
//     { action: 'connect' }                      administrators: the ServiceM8 address to connect the add-on
//     { action: 'setup' }                        administrators: find/make AFA's client record, turn on change reports
//     { action: 'queues' }                       administrators: his job queues (to pick "awaiting parts")
//     { action: 'disconnect' }                   administrators: forget the add-on's tokens
//   GET  /api/servicem8?action=callback&code=…&state=…   ServiceM8 returns here after he connects
//   POST /api/servicem8-hook/<key>                       ServiceM8 reports a job change (and checks the address when subscribing)
//   GET  /api/servicem8?cron=1  (Authorization: Bearer <CRON_SECRET>)   the daily check

const crypto = require('crypto');

const SM8 = 'https://api.servicem8.com/api_1.0';
const SM8_HOOKS = 'https://api.servicem8.com/webhook_subscriptions';
const OAUTH = 'https://go.servicem8.com/oauth';
const SCOPES = 'read_jobs create_jobs manage_jobs read_schedule read_job_materials read_job_queues read_customers manage_customers publish_job_notes';
const HOOK_FIELDS = ['status', 'queue_uuid', 'work_done_description', 'active', 'job_is_scheduled_until_stamp', 'total_invoice_amount'];
const HOOK_FIELDS_MIN = ['status', 'queue_uuid', 'work_done_description', 'active'];
const WORK_ROLES = ['admin', 'superuser', 'supervisor', 'mechanic'];
const MGR_ROLES = ['admin', 'superuser'];
const FINISHED = ['completed', 'closed', 'cancelled'];
const TYPE = { service: 'Scheduled service', defect: 'Defect repair', breakdown: 'Breakdown', request: 'Maintenance request' };
const PRI = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'URGENT' };

/* ---------- small helpers ---------- */
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function sendText(res, status, text) { res.statusCode = status; res.setHeader('Content-Type', 'text/plain'); res.end(text); }
function redirect(res, to) { res.statusCode = 302; res.setHeader('Location', to); res.end(); }
async function readBody(req) {
  if (req._ffBody) return req._ffBody;   // already read once
  let parsed;
  try { parsed = req.body; } catch (e) { return { _unreadable: errText(e) }; }   // Vercel's parser can throw on an odd body
  if (parsed && typeof parsed === 'object' && !Buffer.isBuffer(parsed)) return parsed;
  let raw = typeof parsed === 'string' ? parsed : Buffer.isBuffer(parsed) ? parsed.toString('utf8') : null;
  if (raw == null) { const chunks = []; for await (const c of req) chunks.push(c); raw = Buffer.concat(chunks).toString('utf8'); }
  raw = raw || '';
  const type = String((req.headers && req.headers['content-type']) || '');
  if (/multipart\/form-data/i.test(type)) return parseMultipart(raw, type);   // how ServiceM8 sends its address check
  try { return JSON.parse(raw || '{}'); } catch (e) { return Object.fromEntries(new URLSearchParams(raw)); }
}
// the text fields of a multipart/form-data body ({ mode: 'subscribe', challenge: '…' })
function parseMultipart(raw, type) {
  const m = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = m ? (m[1] || m[2]).trim() : (raw.match(/^--([^\r\n]+)/) || [])[1];
  const out = {};
  if (!boundary) return out;
  for (const part of raw.split('--' + boundary)) {
    const i = part.indexOf('\r\n\r\n');
    if (i < 0) continue;
    const name = (part.slice(0, i).match(/name="([^"]*)"/i) || [])[1];
    if (name == null) continue;
    let v = part.slice(i + 4);
    if (v.endsWith('\r\n')) v = v.slice(0, -2);
    out[name] = v;
  }
  if (typeof out.data === 'string') { try { Object.assign(out, JSON.parse(out.data)); } catch (e) { /* not JSON */ } }
  if (typeof out.entry === 'string') { try { out.entry = JSON.parse(out.entry); } catch (e) { /* not JSON */ } }
  return out;
}
function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const i = (req.url || '').indexOf('?');
  return i < 0 ? {} : Object.fromEntries(new URLSearchParams(req.url.slice(i + 1)));
}
const yes = v => v === true || v === 1 || String(v) === '1' || String(v) === 'true';
const day = s => { const d = String(s || '').slice(0, 10); return /^\d{4}-\d\d-\d\d$/.test(d) && d !== '0000-00-00' ? d : null; };
const todayBne = () => new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10);   // Queensland: no daylight saving
const fmtN = n => Number(n).toLocaleString('en-AU', { maximumFractionDigits: 1 });
const q = s => encodeURIComponent(s);
const filt = expr => '%24filter=' + q(expr);
const safeId = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const errText = e => String((e && e.message) || e).slice(0, 500);

/* ---------- the database, as the server (service role) ---------- */
function database(env, http) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1/';
  const h = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  const go = async (path, o = {}) => {
    const r = await http(url + path, { ...o, headers: { ...h, ...(o.headers || {}) } });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Database ${r.status}: ${t.slice(0, 300)}`); }
    return r.status === 204 ? null : r.json().catch(() => null);
  };
  return {
    get: path => go(path),
    one: async path => ((await go(path)) || [])[0] || null,
    patch: (path, body) => go(path, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) }),
    rpc: (fn, args) => go('rpc/' + fn, { method: 'POST', body: JSON.stringify(args) }),
    post: (path, body) => go(path, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) }),
  };
}

/* ---------- ServiceM8: who we are to it ---------- */
async function credentials(env, D, http) {
  if (env.SERVICEM8_API_KEY) return { mode: 'key', ok: true, headers: { 'X-API-Key': env.SERVICEM8_API_KEY } };
  if (!env.SERVICEM8_APP_ID || !env.SERVICEM8_APP_SECRET) return { mode: 'none', ok: false };
  const s = await D.one('servicem8_secrets?id=eq.1&select=*');
  if (!s || (!s.access_token && !s.refresh_token)) return { mode: 'oauth', ok: false };
  let token = s.access_token;
  if (!token || !s.expires_at || new Date(s.expires_at).getTime() - Date.now() < 120e3) {
    const r = await http(OAUTH + '/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.SERVICEM8_APP_ID, client_secret: env.SERVICEM8_APP_SECRET, refresh_token: s.refresh_token || '' }).toString() });
    if (!r.ok) return { mode: 'oauth', ok: false, error: 'ServiceM8 needs connecting again (' + r.status + ')' };
    const t = await r.json();
    token = t.access_token;
    await D.patch('servicem8_secrets?id=eq.1', { access_token: t.access_token, refresh_token: t.refresh_token || s.refresh_token,
      expires_at: new Date(Date.now() + (+t.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() });
  }
  return { mode: 'oauth', ok: true, headers: { Authorization: 'Bearer ' + token } };
}
function client(A, http) {
  const go = async (method, path, body) => {
    const o = { method, headers: { ...A.headers, Accept: 'application/json' } };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await http(path.startsWith('http') ? path : SM8 + path, o);
    if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error(`ServiceM8 ${r.status}: ${t.slice(0, 300)}`); e.status = r.status; throw e; }
    return r;
  };
  return {
    get: async path => (await go('GET', path)).json(),
    post: async (path, body) => { const r = await go('POST', path, body); return (r.headers && r.headers.get && r.headers.get('x-record-uuid')) || null; },
  };
}

/* ---------- what goes on his job ---------- */
// The job's description: everything he needs about the machine and the work, as plain text.
function describeJob({ wo, machine, profile, meters, defects }) {
  const m = machine || {}, p = profile || {};
  const name = [m.name, m.sub].filter(Boolean).join(' · ') || wo.asset_id;
  const lines = [`FraserFlow WO ${wo.number} · ${TYPE[wo.wo_type] || wo.wo_type} · ${PRI[wo.priority] || wo.priority} priority`,
    `Machine: ${name}${m.category ? ` (${m.category})` : ''}${m.rego ? ` · Rego ${m.rego}` : ''}`];
  const mk = [p.make, p.model, p.year].filter(Boolean).join(' ');
  if (mk || p.serial) lines.push([mk, p.serial ? 'Serial/VIN ' + p.serial : ''].filter(Boolean).join(' · '));
  const mt = (meters || []).map(r => `${fmtN(r.value)} ${r.kind === 'km' ? 'km' : 'h'} (${String(r.read_at || '').slice(0, 10)})`);
  if (mt.length) lines.push('Last reading: ' + mt.join(' · '));
  if (wo.wo_type === 'breakdown' && wo.safe_to_operate === false) lines.push('REPORTED NOT SAFE TO OPERATE');
  const out = [lines.join('\n'), wo.title, (wo.description || '').trim()];
  if (defects && defects.length) out.push('Defects:\n' + defects.map(d => `- D-${d.number} ${d.title} (${d.severity})${d.description ? ': ' + d.description : ''}`).join('\n'));
  const want = (p.meter_type || 'hours') === 'km' ? '"Km: 123456"' : (p.meter_type === 'both' ? '"Hours: 4530" and "Km: 123456"' : '"Hours: 4530"');
  out.push(`When it's done, please put the meter reading in Work Done, e.g. ${want}.`);
  return out.filter(Boolean).join('\n\n');
}

// Meter readings he wrote in Work Done ("Hours: 4,530", "Km 123456"). The label comes first, so "500 hr service" isn't one.
function parseMeters(text, meterType) {
  const t = String(text || ''), out = [];
  const num = s => +String(s).replace(/,/g, '');
  const h = t.match(/\b(?:engine\s+)?(?:hours|hrs|hour\s*meter|hourmeter|hm)\b\s*[:=\-]?\s*(\d[\d,]*(?:\.\d+)?)/i);
  const k = t.match(/\b(?:odometer|odo|kms?|kilomet(?:re|er)s)\b\s*[:=\-]?\s*(\d[\d,]*(?:\.\d+)?)/i);
  if (h && meterType !== 'km') out.push({ kind: 'hours', value: num(h[1]) });
  if (k && meterType !== 'hours') out.push({ kind: 'km', value: num(k[1]) });
  return out.filter(x => isFinite(x.value) && x.value > 0);
}

const qtyTxt = v => { const n = Number(v); return isFinite(n) && String(v).trim() !== '' ? String(+n.toFixed(3)) : String(v || '1').trim() || '1'; };

// A ServiceM8 job (with its bookings and materials) → what should change on the work order.
// Returns { patch, service, meters, job } for servicem8_apply, or null when nothing should change.
function mapJob({ job, activities, materials, wo, cfg, profile, latest, prev }) {
  const st = String(job.status || '');
  const was = prev || {};   // what the job looked like last time: only changes made in ServiceM8 move the work order
  const jobInfo = { job_no: job.generated_job_id != null ? String(job.generated_job_id) : null, sm8_status: st || null, queue_uuid: job.queue_uuid || '' };
  if (!yes(job.active)) return { patch: null, service: null, meters: null, job: { ...jobInfo, removed: true } };
  if (['closed', 'cancelled'].includes(wo.status)) return { patch: null, service: null, meters: null, job: jobInfo };
  const acts = (activities || []).filter(a => yes(a.active == null ? 1 : a.active));
  const worked = acts.filter(a => yes(a.activity_was_recorded) || !yes(a.activity_was_scheduled));   // time he recorded on the job
  const booked = acts.filter(a => yes(a.activity_was_scheduled) && !yes(a.activity_was_recorded));
  const patch = {};
  const starts = booked.map(a => day(a.start_date)).filter(Boolean).sort();
  const ends = booked.map(a => day(a.end_date) || day(a.start_date)).filter(Boolean).sort();
  if (starts.length) { patch.start_date = starts[0]; patch.end_date = ends[ends.length - 1] < starts[0] ? starts[0] : ends[ends.length - 1]; }
  const parts = (materials || []).filter(m => yes(m.active == null ? 1 : m.active) && String(m.name || '').trim())
    .map(m => ({ part: String(m.name).trim(), qty: qtyTxt(m.quantity) }));
  if (parts.length) patch.parts = parts;
  if (cfg.contractor_name) patch.assigned_to = cfg.contractor_name;

  const rank = { open: 0, scheduled: 1, in_progress: 2, awaiting_parts: 2 };
  let next = wo.status, service = null, meters = null;
  if (st === 'Completed') {
    next = 'completed';
    if (wo.status !== 'completed') {
      patch.completion_notes = String(job.work_done_description || '').trim() || `Completed in ServiceM8${jobInfo.job_no ? ' (job ' + jobInfo.job_no + ')' : ''}`;
      const cur = latest || {};
      meters = parseMeters(job.work_done_description, profile && profile.meter_type).filter(x => cur[x.kind] == null || x.value >= cur[x.kind]);
      if (wo.wo_type === 'service') {
        const mv = Object.fromEntries(meters.map(x => [x.kind, x.value]));
        service = { done_on: day(job.completion_date) || todayBne(), hours: mv.hours ?? null, km: mv.km ?? null, mechanic: cfg.contractor_name || 'ServiceM8' };
        meters = [];
      }
    }
  } else if (st === 'Unsuccessful') {
    next = 'cancelled';
  } else if (wo.status === 'completed') {
    if (was.sm8_status === 'Completed') next = 'in_progress';   // he reopened the job; completed here (not there) stays completed
  } else if (cfg.parts_queue_uuid && job.queue_uuid === cfg.parts_queue_uuid) {
    next = 'awaiting_parts';
  } else {
    const seen = worked.length ? 'in_progress' : booked.length ? 'scheduled' : null;
    const leftQueue = wo.status === 'awaiting_parts' && cfg.parts_queue_uuid && was.sm8_queue === cfg.parts_queue_uuid;   // he took it out of the parts queue
    if (leftQueue) next = seen || ((patch.start_date || wo.start_date) ? 'scheduled' : 'open');
    else if (seen && rank[seen] > (rank[wo.status] ?? 0)) next = seen;   // only forwards: open → scheduled → in progress
  }
  if (next !== wo.status) patch.status = next;
  if (next === 'cancelled') { delete patch.parts; delete patch.start_date; delete patch.end_date; }
  return { patch, service, meters, job: jobInfo };
}

/* ---------- the work ---------- */
async function settings(D) { return (await D.one('servicem8_settings?id=eq.1&select=*')) || {}; }

async function jobContext(D, wo) {
  const a = q(wo.asset_id);
  const [machine, profile, hours, km, defects] = await Promise.all([
    D.one(`items?kind=eq.resource&id=eq.${a}&select=data`).then(r => r && r.data),
    D.one(`asset_profiles?asset_id=eq.${a}&select=*`),
    D.one(`meter_readings?asset_id=eq.${a}&kind=eq.hours&select=kind,value,read_at&order=read_at.desc,created_at.desc&limit=1`),
    D.one(`meter_readings?asset_id=eq.${a}&kind=eq.km&select=kind,value,read_at&order=read_at.desc,created_at.desc&limit=1`),
    D.get(`defects?work_order_id=eq.${wo.id}&select=number,title,severity,description&order=number`).catch(() => []),
  ]);
  const mt = (profile && profile.meter_type) || 'hours';
  const meters = [mt !== 'km' && hours, mt !== 'hours' && km].filter(Boolean);
  return { machine, profile, meters, defects, latest: { hours: hours ? +hours.value : null, km: km ? +km.value : null } };
}

// AFA's client record in his ServiceM8: found by name, or made.
async function ensureCompany(D, S, cfg) {
  if (cfg.company_uuid) return cfg.company_uuid;
  const name = (cfg.client_name || 'AFA').trim();
  const found = await S.get(`/company.json?${filt(`name eq '${name.replace(/'/g, "''")}' and active eq 1`)}`);
  const id = (found && found[0] && found[0].uuid) || await S.post('/company.json', { name });
  if (!id) throw new Error('ServiceM8 didn’t return the client record');
  await D.patch('servicem8_settings?id=eq.1', { company_uuid: id });
  cfg.company_uuid = id;
  return id;
}

// one work order → a ServiceM8 job
async function sendOne(D, S, cfg, link) {
  const wo = await D.one(`work_orders?id=eq.${link.work_order_id}&select=*`);
  if (!wo) return 'missing';
  if (FINISHED.includes(wo.status)) { await D.patch(`servicem8_jobs?work_order_id=eq.${wo.id}`, { state: 'skipped', updated_at: new Date().toISOString() }); return 'skipped'; }
  // claim it, so two sends at once can't both make a job
  const uuid = link.job_uuid || crypto.randomUUID();
  const claimed = await D.patch(`servicem8_jobs?work_order_id=eq.${wo.id}&state=eq.${link.state}&updated_at=eq.${q(link.updated_at)}`,
    { state: 'sending', job_uuid: uuid, dirty: false, attempts: (link.attempts || 0) + 1, updated_at: new Date().toISOString() });
  if (!claimed || !claimed.length) return 'busy';
  try {
    let exists = false;
    if (link.job_uuid) { try { const j = await S.get(`/job/${uuid}.json`); exists = !!(j && j.uuid); } catch (e) { if (e.status !== 404) throw e; } }
    const ctx = await jobContext(D, wo);
    if (!exists) {
      const company = await ensureCompany(D, S, cfg);
      await S.post('/job.json', { uuid, status: 'Work Order', company_uuid: company, job_address: (cfg.job_address || '').trim() || (cfg.client_name || 'AFA'),
        job_description: describeJob({ wo, ...ctx }), purchase_order_number: 'FF WO ' + wo.number });
    }
    await D.patch(`servicem8_jobs?work_order_id=eq.${wo.id}`, { state: 'sent', sent_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() });
    await pullOne(D, S, cfg, { ...link, job_uuid: uuid, state: 'sent' }, wo, ctx);
    return 'sent';
  } catch (e) {
    await D.patch(`servicem8_jobs?work_order_id=eq.${wo.id}`, { state: 'error', last_error: errText(e), updated_at: new Date().toISOString() });
    throw e;
  }
}

// a change made in FraserFlow → his job (description, or cancelled)
async function pushChange(D, S, cfg, link) {
  const wo = await D.one(`work_orders?id=eq.${link.work_order_id}&select=*`);
  const done = ['Completed', 'Unsuccessful'].includes(link.sm8_status);
  if (wo && !done) {
    if (wo.status === 'cancelled') {
      await S.post(`/job/${link.job_uuid}.json`, { status: 'Unsuccessful' });
      await S.post('/note.json', { related_object: 'job', related_object_uuid: link.job_uuid, note: `Cancelled in FraserFlow (WO ${wo.number}).` }).catch(() => null);
    } else {
      const ctx = await jobContext(D, wo);
      await S.post(`/job/${link.job_uuid}.json`, { job_description: describeJob({ wo, ...ctx }) });
    }
  }
  await D.patch(`servicem8_jobs?work_order_id=eq.${link.work_order_id}`, { dirty: false, updated_at: new Date().toISOString() });
}

// his job → the work order
async function pullOne(D, S, cfg, link, wo, ctx) {
  wo = wo || await D.one(`work_orders?id=eq.${link.work_order_id}&select=*`);
  if (!wo) return null;
  let job;
  try { job = await S.get(`/job/${link.job_uuid}.json`); }
  catch (e) { if (e.status === 404) job = { active: 0 }; else throw e; }
  const f = filt(`job_uuid eq '${link.job_uuid}' and active eq 1`);
  const [activities, materials] = yes(job.active) ? await Promise.all([S.get(`/jobactivity.json?${f}`), S.get(`/jobmaterial.json?${f}`)]) : [[], []];
  ctx = ctx || await jobContext(D, wo);
  const m = mapJob({ job, activities, materials, wo, cfg, profile: ctx.profile, latest: ctx.latest, prev: link });
  return D.rpc('servicem8_apply', { p_wo: wo.id, p_patch: m.patch || {}, p_service: m.service, p_meters: m.meters || [], p_job: m.job });
}

// send what's waiting, pass on changes, and refresh the jobs not heard from for a while
async function flush(D, S, cfg, { sendLimit = 10, refresh = 5, staleMinutes = 15 } = {}) {
  const out = { sent: 0, changed: 0, refreshed: 0, errors: [] };
  const stuck = new Date(Date.now() - 5 * 60e3).toISOString();
  const todo = await D.get(`servicem8_jobs?or=(state.eq.pending,and(state.eq.error,attempts.lt.6),and(state.eq.sending,updated_at.lt.${q(stuck)}),and(state.eq.sent,dirty.is.true))&order=updated_at.asc&limit=${sendLimit}&select=*`);
  for (const l of todo || []) {
    try {
      if (l.state === 'sent') { await pushChange(D, S, cfg, l); out.changed++; }
      else if ((await sendOne(D, S, cfg, l)) === 'sent') out.sent++;
    } catch (e) { out.errors.push({ wo: l.work_order_id, error: errText(e) }); }
  }
  if (refresh) {
    const since = new Date(Date.now() - staleMinutes * 60e3).toISOString();
    const stale = await D.get(`servicem8_jobs?state=eq.sent&or=(synced_at.is.null,synced_at.lt.${q(since)})&select=*,work_orders!inner(status)&work_orders.status=not.in.(closed,cancelled)&order=synced_at.asc.nullsfirst&limit=${refresh}`);
    const list = stale || [];
    for (let i = 0; i < list.length; i += 5) {   // five at a time
      await Promise.all(list.slice(i, i + 5).map(l => pullOne(D, S, cfg, l).then(() => { out.refreshed++; }, e => { out.errors.push({ wo: l.work_order_id, error: errText(e) }); })));
    }
  }
  return out;
}

/* ---------- OAuth state: who asked to connect, signed so it can't be forged ---------- */
const b64u = s => Buffer.from(s).toString('base64url');
function signState(secret, uid) {
  const body = b64u(JSON.stringify({ u: uid, e: Date.now() + 15 * 60e3 }));
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}
function checkState(secret, state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const v = JSON.parse(Buffer.from(body, 'base64url').toString()); return v.e > Date.now() ? v : null; } catch (e) { return null; }
}
const origin = (req, env) => (env.SERVICEM8_PUBLIC_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host || ''))).replace(/\/$/, '');

/* ---------- the entry point ---------- */
async function handler(req, res, env = process.env, http = fetch) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return send(res, 500, { error: 'The app isn’t connected to its database yet.' });
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return send(res, 501, { error: 'The ServiceM8 link needs SUPABASE_SERVICE_ROLE_KEY in Vercel → Settings → Environment Variables.' });
  const D = database(env, http);
  const Q = queryOf(req);

  // 0. ServiceM8's address check can also arrive at the add-on's own Callback URL (no key there): answer it anywhere
  if (!req.headers.authorization && Q.hook == null && !/servicem8-hook/.test(String(req.url || '')) && !(req.method === 'GET' && (Q.action === 'callback' || Q.cron != null))) {
    const b = req.method === 'POST' ? (req._ffBody = await readBody(req)) : {};
    const challenge = b.challenge || b['hub.challenge'] || Q.challenge || Q['hub.challenge'];
    await D.post('maintenance_audit', { tbl: 'servicem8_hook', action: 'call', new: { method: req.method, type: String(req.headers['content-type'] || ''), keyOk: false,
      keyExtra: 'at ' + String(req.url || '').split('?')[0], query: Object.fromEntries(Object.entries(Q).filter(([k]) => k !== 'hook' && k !== 'key')), body: JSON.stringify(b).slice(0, 600), answered: 200, reply: challenge ? String(challenge).slice(0, 100) : 'ok' } }).catch(() => null);
    if (challenge) return sendText(res, 200, String(challenge));
    if (req.method === 'POST' && (b.object || b.entry || b.eventName || b.event)) return sendText(res, 200, 'ok');   // an event sent to the add-on address: acknowledged
  }

  // 1. ServiceM8 reporting a change to a job (the key is in the path: /api/servicem8-hook/<key>, see vercel.json)
  const hookKey = Q.hook != null ? Q.hook : (String(req.url || '').match(/\/servicem8-hook\/([0-9a-f]+)/i) || [])[1];
  if (hookKey != null) {
    const sec = await D.one('servicem8_secrets?id=eq.1&select=webhook_key');
    const key = (sec && sec.webhook_key) || '';
    const given = String(hookKey).match(/^[0-9a-f]*/i)[0];   // ignore anything ServiceM8 tacks on after the key
    const h = v => crypto.createHash('sha256').update(String(v)).digest();
    const b = req.method === 'POST' ? await readBody(req) : {};
    // what ServiceM8 sent, for working out setup problems (kept in the maintenance audit log, without the key)
    const seen = { method: req.method, type: String(req.headers['content-type'] || ''), keyOk: !!key && crypto.timingSafeEqual(h(given), h(key)),
      keyExtra: String(hookKey).slice(given.length).slice(0, 200), query: Object.fromEntries(Object.entries(Q).filter(([k]) => k !== 'hook' && k !== 'key')),
      body: JSON.stringify(b).slice(0, 600) };
    const answer = async (status, text) => {
      if (status !== 200 || !b.object) await D.post('maintenance_audit', { tbl: 'servicem8_hook', action: 'call', new: { ...seen, answered: status, reply: String(text).slice(0, 100) } }).catch(() => null);
      return sendText(res, status, text);
    };
    if (!seen.keyOk) return answer(403, 'Unknown');
    // the check when subscribing: answer with the challenge, however it is sent (query or body, GET or POST)
    const challenge = b.challenge || b.Challenge || b['hub.challenge'] || Q.challenge || Q['hub.challenge'] || (String(hookKey).match(/challenge=([^&]+)/) || [])[1];
    if (challenge && !b.object) return answer(200, decodeURIComponent(String(challenge)));
    if (req.method !== 'POST' || !b.object) return answer(200, 'ok');
    if (b.object !== 'job') return sendText(res, 200, 'ignored');
    const ids = (Array.isArray(b.entry) ? b.entry : []).map(e => e && e.uuid).filter(safeId);
    if (!ids.length) return sendText(res, 200, 'ok');
    const links = await D.get(`servicem8_jobs?state=eq.sent&job_uuid=in.(${ids.map(q).join(',')})&select=*`);
    if (!links || !links.length) return sendText(res, 200, 'not ours');   // another client's job: never looked at
    const cfg = await settings(D);
    if (!cfg.enabled) return sendText(res, 200, 'switched off');
    const A = await credentials(env, D, http);
    if (!A.ok) return sendText(res, 503, 'not connected');
    const S = client(A, http);
    for (const l of links) await pullOne(D, S, cfg, l);   // a failure → 500, and ServiceM8 tries again later
    return sendText(res, 200, 'ok');
  }

  // 2. back from connecting the add-on in ServiceM8
  if (req.method === 'GET' && Q.action === 'callback') {
    const st = env.SERVICEM8_APP_SECRET && checkState(env.SERVICEM8_APP_SECRET, Q.state);
    if (!st || !Q.code) return redirect(res, '/?servicem8=failed');
    const r = await http(OAUTH + '/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.SERVICEM8_APP_ID, client_secret: env.SERVICEM8_APP_SECRET,
        code: String(Q.code), redirect_uri: origin(req, env) + '/api/servicem8?action=callback' }).toString() });
    if (!r.ok) return redirect(res, '/?servicem8=failed');
    const t = await r.json();
    await D.patch('servicem8_secrets?id=eq.1', { access_token: t.access_token, refresh_token: t.refresh_token,
      expires_at: new Date(Date.now() + (+t.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() });
    return redirect(res, '/?servicem8=connected');
  }

  // 3. Vercel's daily check
  if (req.method === 'GET' && Q.cron != null) {
    const auth = String(req.headers.authorization || '');
    if (!env.CRON_SECRET || auth !== 'Bearer ' + env.CRON_SECRET) return send(res, 401, { error: 'Not allowed' });
    const cfg = await settings(D);
    if (!cfg.enabled) return send(res, 200, { off: true });
    const A = await credentials(env, D, http);
    if (!A.ok) return send(res, 200, { connected: false });
    return send(res, 200, await flush(D, client(A, http), cfg, { sendLimit: 25, refresh: 100, staleMinutes: 60 }));
  }

  // 4. people in FraserFlow
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  const token = String(req.headers.authorization || req.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return send(res, 401, { error: 'Sign in again.' });
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const who = await http(base + '/auth/v1/user', { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
  if (!who.ok) return send(res, 401, { error: 'Sign in again.' });
  const me = await who.json();
  const prof = await D.one(`profiles?id=eq.${q(me.id)}&select=role`);
  const role = prof && prof.role;
  if (!WORK_ROLES.includes(role)) return send(res, 403, { error: 'Only mechanics, supervisors and administrators can do this.' });
  const mgr = MGR_ROLES.includes(role);
  let b;
  try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
  const cfg = await settings(D);
  const A = await credentials(env, D, http);

  if (b.action === 'status') {
    const sec = mgr ? await D.one('servicem8_secrets?id=eq.1&select=webhook_key') : null;
    return send(res, 200, { mode: A.mode, connected: A.ok, error: A.error || null, enabled: !!cfg.enabled,
      canConnect: !!(env.SERVICEM8_APP_ID && env.SERVICEM8_APP_SECRET), hooksOn: !!cfg.hooks_on_at, hasHookKey: !!(sec && sec.webhook_key) });
  }
  if (b.action === 'connect') {
    if (!mgr) return send(res, 403, { error: 'Only administrators connect ServiceM8.' });
    if (!env.SERVICEM8_APP_ID || !env.SERVICEM8_APP_SECRET) return send(res, 501, { error: 'Add SERVICEM8_APP_ID and SERVICEM8_APP_SECRET in Vercel first (or use SERVICEM8_API_KEY).' });
    const u = new URLSearchParams({ response_type: 'code', client_id: env.SERVICEM8_APP_ID, scope: SCOPES,
      redirect_uri: origin(req, env) + '/api/servicem8?action=callback', state: signState(env.SERVICEM8_APP_SECRET, me.id) });
    return send(res, 200, { url: OAUTH + '/authorize?' + u.toString() });
  }
  if (b.action === 'disconnect') {
    if (!mgr) return send(res, 403, { error: 'Only administrators can do this.' });
    await D.patch('servicem8_secrets?id=eq.1', { access_token: null, refresh_token: null, expires_at: null, updated_at: new Date().toISOString() });
    await D.patch('servicem8_settings?id=eq.1', { enabled: false, hooks_on_at: null });
    return send(res, 200, { disconnected: true });
  }

  if (!A.ok) return send(res, 409, { error: A.error || 'ServiceM8 isn’t connected yet. An administrator connects it in Fleet › Work orders › ServiceM8.' });
  const S = client(A, http);

  if (b.action === 'queues') {
    if (!mgr) return send(res, 403, { error: 'Only administrators can do this.' });
    const list = await S.get(`/queue.json?${filt('active eq 1')}`);
    return send(res, 200, { queues: (list || []).map(x => ({ uuid: x.uuid, name: x.name })) });
  }
  if (b.action === 'setup') {
    if (!mgr) return send(res, 403, { error: 'Only administrators can do this.' });
    const company = await ensureCompany(D, S, cfg);
    const sec = await D.one('servicem8_secrets?id=eq.1&select=webhook_key');
    const key = crypto.randomBytes(24).toString('hex');   // a fresh one each time it is set up
    await D.patch('servicem8_secrets?id=eq.1', { webhook_key: key, updated_at: new Date().toISOString() });
    const hook = async fields => {
      const r = await http(SM8_HOOKS, { method: 'POST', headers: { ...A.headers, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ object: 'job', fields: fields.join(','), callback_url: origin(req, env) + '/api/servicem8-hook/' + key, unique_id: 'fraserflow' }).toString() });
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`ServiceM8 ${r.status}: ${t.slice(0, 200)}`); }
    };
    let hooks = 'full';
    const started = new Date(Date.now() - 2000).toISOString();
    try {
      try { await hook(HOOK_FIELDS); } catch (e) { hooks = 'basic'; await hook(HOOK_FIELDS_MIN); }
    } catch (e) {
      const calls = await D.get(`maintenance_audit?tbl=eq.servicem8_hook&at=gt.${q(started)}&select=new&order=at.desc&limit=3`).catch(() => []);
      const what = (calls || []).map(c => { const n = c.new || {}; return `${n.method} ${n.type || '(no type)'}${n.keyOk ? '' : ' KEY NOT RECOGNISED'}${n.keyExtra ? ' extra after key: ' + n.keyExtra : ''} query ${JSON.stringify(n.query)} body ${n.body} → answered ${n.answered} "${n.reply}"`; });
      throw new Error(errText(e) + ' | ' + (what.length ? 'What ServiceM8 sent: ' + what.join(' || ')
        : `ServiceM8's check never reached FraserFlow at ${origin(req, env)}/api/servicem8-hook/… (is the site behind Vercel Deployment Protection?)`));
    }
    await D.patch('servicem8_settings?id=eq.1', { hooks_on_at: new Date().toISOString() });
    return send(res, 200, { company_uuid: company, hooks });
  }
  if (b.action === 'sync') {
    if (!safeId(b.wo)) return send(res, 400, { error: 'Bad request' });
    const l = await D.one(`servicem8_jobs?work_order_id=eq.${b.wo}&select=*`);
    if (!l || l.state !== 'sent') return send(res, 409, { error: 'This work order isn’t in ServiceM8.' });
    return send(res, 200, { status: await pullOne(D, S, cfg, l) });
  }
  if (b.action === 'flush') {
    if (!cfg.enabled) return send(res, 200, { off: true });
    return send(res, 200, await flush(D, S, cfg));
  }
  return send(res, 400, { error: 'Unknown action' });
}

module.exports = (req, res) => handler(req, res).catch(e => send(res, 500, { error: 'Something went wrong: ' + errText(e) }));
module.exports.handler = handler;   // for the tests
module.exports.mapJob = mapJob;
module.exports.parseMeters = parseMeters;
module.exports.describeJob = describeJob;
module.exports.checkState = checkState;
module.exports.signState = signState;
