// Checks the rules in api/users.js against a stand-in for Supabase. Run: node tests/api_users_test.js
const { handler } = require('../api/users.js');
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
const USERS = { 'tok-admin': { id: '00000000-0000-0000-0000-0000000000a1', role: 'admin' }, 'tok-super': { id: '00000000-0000-0000-0000-0000000000a6', role: 'superuser' },
  'tok-planner': { id: '00000000-0000-0000-0000-0000000000a2', role: 'planner' } };
let made = [], patched = [], resets = [], deleted = [], existing = new Set(['taken@fraserflow.local']);
const ROLE_OF = { '00000000-0000-0000-0000-0000000000a1': 'admin', '00000000-0000-0000-0000-0000000000a7': 'prestart' };
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function http(url, o = {}) {
  const h = o.headers || {};
  if (url.endsWith('/auth/v1/user')) { const u = USERS[h.Authorization.replace('Bearer ', '')]; return u ? json(200, { id: u.id }) : json(401, {}); }
  if (url.includes('/rest/v1/profiles') && (!o.method || o.method === 'GET')) {
    if (h.apikey !== 'service') throw new Error('profiles read without the service key');
    const id = url.match(/id=eq\.([^&]+)/)[1]; const u = Object.values(USERS).find(x => x.id === id);
    const role = u ? u.role : ROLE_OF[id]; return json(200, role ? [{ role }] : []);
  }
  if (url.includes('/rest/v1/profiles') && o.method === 'PATCH') { patched.push({ url, body: JSON.parse(o.body) }); return json(204, null); }
  if (url.endsWith('/auth/v1/admin/users') && o.method === 'POST') {
    const b = JSON.parse(o.body); if (existing.has(b.email)) return json(422, { msg: 'A user with this email address has already been registered' });
    made.push(b); return json(200, { id: '00000000-0000-0000-0000-0000000000c1', email: b.email });
  }
  if (url.includes('/auth/v1/admin/users/') && o.method === 'DELETE') { deleted.push(url); return json(200, {}); }
  if (url.includes('/auth/v1/admin/users/') && o.method === 'PUT') { const b = JSON.parse(o.body); if (b.email && existing.has(b.email)) return json(422, { msg: 'A user with this email address has already been registered' }); resets.push({ url, body: b }); return json(200, {}); }
  throw new Error('unexpected call ' + url);
}
async function call(token, body, env = ENV) {
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(s) { this.body = JSON.parse(s) } };
  await handler({ method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body }, res, env, http);
  return res;
}
let fails = 0;
const ok = (c, l) => { console.log((c ? 'PASS' : 'FAIL') + ': ' + l); if (!c) fails++; };
(async () => {
  let r = await call('tok-admin', { action: 'create', login: 'x', password: 'temporary1' }, { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' });
  ok(r.statusCode === 501 && /SUPABASE_SERVICE_ROLE_KEY/.test(r.body.error), 'without the service key it says how to switch it on');
  r = await call(null, { action: 'create', login: 'x', password: 'temporary1' }); ok(r.statusCode === 401, 'not signed in: refused');
  r = await call('tok-planner', { action: 'create', login: 'x', password: 'temporary1' }); ok(r.statusCode === 403, 'a planner can’t create logins');
  r = await call('tok-super', { action: 'create', login: 'boss', password: 'temporary1', role: 'admin' }); ok(r.statusCode === 403 && made.length === 0, 'a superuser can’t create an admin');
  r = await call('tok-admin', { action: 'create', login: 'jsmith', password: 'short' }); ok(r.statusCode === 400 && made.length === 0, 'a temporary password under 8 characters is refused');
  r = await call('tok-admin', { action: 'create', login: 'j smith!', password: 'temporary1' }); ok(r.statusCode === 400, 'a username with spaces or symbols is refused');
  r = await call('tok-super', { action: 'create', login: 'JSmith', password: 'temporary1', role: 'prestart', staff_id: 'p-js' });
  ok(r.statusCode === 200 && made[0].email === 'jsmith@fraserflow.local' && made[0].email_confirm === true && made[0].user_metadata.password_set === false,
    'a superuser creates "JSmith": stored as jsmith@fraserflow.local, confirmed, must choose a password at first sign-in');
  ok(patched[0] && patched[0].body.role === 'prestart' && patched[0].body.staff_id === 'p-js', 'its role and Staff link are set');
  r = await call('tok-admin', { action: 'create', login: 'dan@afa.com.au', password: 'temporary1', role: 'planner' }); ok(r.statusCode === 200 && made[1].email === 'dan@afa.com.au', 'an email login can be created too');
  r = await call('tok-admin', { action: 'create', login: 'taken', password: 'temporary1' }); ok(r.statusCode === 409 && /already taken/.test(r.body.error), 'a username that exists already: “already taken”');
  r = await call('tok-super', { action: 'reset', id: '00000000-0000-0000-0000-0000000000a1', password: 'temporary2' }); ok(r.statusCode === 403 && resets.length === 0, 'a superuser can’t reset the admin’s password');
  r = await call('tok-admin', { action: 'reset', id: '00000000-0000-0000-0000-0000000000a1', password: 'temporary2' }); ok(r.statusCode === 400 && resets.length === 0, 'nobody resets their own password here');
  r = await call('tok-super', { action: 'reset', id: '00000000-0000-0000-0000-0000000000a7', password: 'temporary2' });
  ok(r.statusCode === 200 && resets[0].body.password === 'temporary2' && resets[0].body.user_metadata.password_set === false, 'a superuser resets an operator: they choose a new password at next sign-in');
  r = await call('tok-planner', { action: 'delete', id: '00000000-0000-0000-0000-0000000000a7' }); ok(r.statusCode === 403 && deleted.length === 0, 'a planner can’t delete a login');
  r = await call('tok-admin', { action: 'delete', id: '00000000-0000-0000-0000-0000000000a1' }); ok(r.statusCode === 400 && deleted.length === 0, 'nobody deletes their own login');
  r = await call('tok-super', { action: 'delete', id: '00000000-0000-0000-0000-0000000000a1' }); ok(r.statusCode === 403 && deleted.length === 0, 'a superuser can’t delete the admin’s login');
  r = await call('tok-super', { action: 'delete', id: '00000000-0000-0000-0000-0000000000a7' }); ok(r.statusCode === 200 && /a7$/.test(deleted[0]), 'a superuser deletes a prestart login (no password needed)');
  resets.length = 0; patched.length = 0;
  r = await call('tok-super', { action: 'rename', id: '00000000-0000-0000-0000-0000000000a7', login: 'OPete' }); ok(r.statusCode === 200 && resets[0].body.email === 'opete@fraserflow.local' && !resets[0].body.password && patched.some(x => x.body.email === 'opete@fraserflow.local'), 'a superuser renames a login (no password needed; the password stays)');
  r = await call('tok-super', { action: 'rename', id: '00000000-0000-0000-0000-0000000000a1', login: 'boss' }); ok(r.statusCode === 403, 'a superuser can’t rename the admin');
  r = await call('tok-admin', { action: 'rename', id: '00000000-0000-0000-0000-0000000000a7', login: 'taken' }); ok(r.statusCode === 409 && /already taken/.test(r.body.error), 'renaming to a username that’s taken: “already taken”');
  r = await call('tok-planner', { action: 'rename', id: '00000000-0000-0000-0000-0000000000a7', login: 'x1' }); ok(r.statusCode === 403, 'a planner can’t rename logins');
  console.log(fails ? `${fails} FAILED` : 'ALL LOGIN FUNCTION TESTS PASSED'); process.exit(fails ? 1 : 0);
})();
