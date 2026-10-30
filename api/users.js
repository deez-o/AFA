// Create logins and reset passwords from inside FraserFlow (Fleet › Logins).
// Creating a Supabase login needs the project's service role key. That key stays here on the server:
// it is set in Vercel → Project → Settings → Environment Variables as SUPABASE_SERVICE_ROLE_KEY and is
// never sent to the browser. Every request must come from someone signed in as an administrator or superuser;
// the same rules as Fleet › Logins apply (only the administrator creates admins or resets an admin's password).
//
// POST /api/users  (Authorization: Bearer <the signed-in person's access token>)
//   { action: 'create', login: 'jsmith' | 'name@company.com', password: '<temporary>', role: 'operator', staff_id: '...' }
//   { action: 'reset', id: '<login id>', password: '<temporary>' }
// A temporary password: the person chooses their own the first time they sign in.

const LOGIN_DOMAIN = 'fraserflow.local';
const ROLES = ['admin', 'superuser', 'planner', 'supervisor', 'mechanic', 'operator', 'viewer'];

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const toEmail = v => { v = String(v || '').trim(); return v.includes('@') ? v.toLowerCase() : v.toLowerCase() + '@' + LOGIN_DOMAIN; };

async function handler(req, res, env = process.env, http = fetch) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  const url = (env.SUPABASE_URL || '').replace(/\/$/, ''), anon = env.SUPABASE_ANON_KEY, service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) return send(res, 500, { error: 'The app isn’t connected to its database yet.' });
  if (!service) return send(res, 501, { error: 'Creating logins isn’t switched on yet. Add SUPABASE_SERVICE_ROLE_KEY in Vercel → Settings → Environment Variables, then redeploy.' });
  const admin = { apikey: service, Authorization: 'Bearer ' + service, 'Content-Type': 'application/json' };

  // 1. who is asking (their own session), and are they allowed
  const token = String(req.headers.authorization || req.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return send(res, 401, { error: 'Sign in again.' });
  const who = await http(url + '/auth/v1/user', { headers: { apikey: anon, Authorization: 'Bearer ' + token } });
  if (!who.ok) return send(res, 401, { error: 'Sign in again.' });
  const me = await who.json();
  const pr = await http(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(me.id)}&select=role`, { headers: admin });
  const myRole = pr.ok ? ((await pr.json())[0] || {}).role : null;
  if (myRole !== 'admin' && myRole !== 'superuser') return send(res, 403, { error: 'Only administrators and superusers can manage logins.' });

  let b;
  try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
  const password = String(b.password || '');
  if (password.length < 8) return send(res, 400, { error: 'The temporary password needs at least 8 characters.' });

  if (b.action === 'create') {
    const login = String(b.login || '').trim();
    if (!login.includes('@') && !/^[a-z0-9][a-z0-9._-]{1,39}$/i.test(login)) return send(res, 400, { error: 'Usernames use letters, numbers, dots, dashes or underscores (2–40 characters).' });
    const role = ROLES.includes(b.role) ? b.role : 'viewer';
    if (role === 'admin' && myRole !== 'admin') return send(res, 403, { error: 'Only the administrator can create another admin.' });
    const made = await http(url + '/auth/v1/admin/users', { method: 'POST', headers: admin,
      body: JSON.stringify({ email: toEmail(login), password, email_confirm: true, user_metadata: { password_set: false } }) });
    const mj = await made.json().catch(() => ({}));
    if (!made.ok) {
      const msg = String(mj.msg || mj.message || mj.error_description || mj.error || '');
      return send(res, made.status === 422 && /already|exists|registered/i.test(msg) ? 409 : 400,
        { error: /already|exists|registered/i.test(msg) ? 'That username is already taken.' : (msg || 'Supabase didn’t create the login.') });
    }
    // the new login gets its profile automatically (as a viewer); set the role and Staff link
    const patch = { role };
    if (b.staff_id) patch.staff_id = String(b.staff_id);
    let up = await http(`${url}/rest/v1/profiles?id=eq.${mj.id}`, { method: 'PATCH', headers: { ...admin, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    if (!up.ok && patch.staff_id) {   // e.g. that Staff record is already linked: keep the login, without the link
      delete patch.staff_id;
      up = await http(`${url}/rest/v1/profiles?id=eq.${mj.id}`, { method: 'PATCH', headers: { ...admin, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      return send(res, 200, { id: mj.id, email: mj.email, warning: 'Login created, but that Staff record is already linked to another login.' });
    }
    if (!up.ok) return send(res, 200, { id: mj.id, email: mj.email, warning: 'Login created, but its role couldn’t be set. Set it in the list.' });
    return send(res, 200, { id: mj.id, email: mj.email });
  }

  if (b.action === 'reset') {
    const id = String(b.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return send(res, 400, { error: 'Bad request' });
    if (id === me.id) return send(res, 400, { error: 'Change your own password from the account menu.' });
    const tr = await http(`${url}/rest/v1/profiles?id=eq.${id}&select=role`, { headers: admin });
    const target = tr.ok ? (await tr.json())[0] : null;
    if (!target) return send(res, 404, { error: 'No such login.' });
    if (target.role === 'admin' && myRole !== 'admin') return send(res, 403, { error: 'Only the administrator can reset an admin’s password.' });
    const r = await http(`${url}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: admin, body: JSON.stringify({ password, user_metadata: { password_set: false } }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return send(res, 400, { error: String(j.msg || j.message || 'Supabase didn’t reset the password.') }); }
    return send(res, 200, { id });
  }

  return send(res, 400, { error: 'Unknown action' });
}

module.exports = (req, res) => handler(req, res).catch(e => send(res, 500, { error: 'Something went wrong: ' + (e && e.message || e) }));
module.exports.handler = handler;   // for the tests
