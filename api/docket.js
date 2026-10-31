// Reads a photo of a delivery docket with Claude (Anthropic API) and returns the fields the laying record needs.
// POST /api/docket  { image: <base64 JPEG>, mediaType?, previous?: [docket numbers on this record], regos?: [known truck regos] }
//   → { docket, docketGap, tonnes, rego, product, load, unsure: [...], note }
// Signed-in FraserFlow users only (the Supabase sign-in is checked). The phone's own reader (Tesseract) stays as the
// fallback when there's no reception or this isn't set up.
// Settings (Vercel → Project → Settings → Environment Variables): ANTHROPIC_API_KEY, plus SUPABASE_URL and SUPABASE_ANON_KEY (already set).
// Optional: DOCKET_MODEL (default claude-sonnet-5-5).

const MODEL = process.env.DOCKET_MODEL || 'claude-sonnet-5-5';

const send = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const PROMPT = ({ previous, regos }) => `This is a photo of an asphalt delivery docket (weighbridge ticket), usually from Alex Fraser.
Read it and call the "docket" tool with what's printed on it.

- docket: the number after "Delivery No" (or "Delivery Number" / "Docket No"). Digits only.
  The docket printer sometimes leaves a blank vertical strip, so one digit of the number isn't printed at all (a gap between digits).
  If you can see a gap like that, put "?" where the missing digit is and set docket_gap true. Never guess a missing digit.${previous.length ? `
  Other dockets already on this paving record (same day, same plant; numbers are usually close to these): ${previous.join(', ')}.` : ''}
- tonnes: the NET weight in tonnes (e.g. "Net Weight 17.160 t" → 17.16; "25,480 kg" → 25.48). If only gross and tare are readable, use gross − tare.
- rego: the TRUCK's registration plate (the "Rego" on the truck line, not the trailer), letters and digits only, no spaces.
  Words like REGIONAL in a customer name are not a rego.${regos.length ? ` Trucks seen on this job or in the fleet: ${regos.join(', ')} (it's often one of these, but read what's printed).` : ''}
- product: the mix / product code if shown (e.g. AC14, SMA10).
- load: the load number if shown.
- unsure: list any field you couldn't read clearly (e.g. ["docket"]). Leave a field out rather than guess it.
If the photo isn't a docket, return nothing but a note saying so.`;

const TOOL = {
  name: 'docket',
  description: 'The fields read from the delivery docket.',
  input_schema: {
    type: 'object',
    properties: {
      docket: { type: 'string', description: 'Delivery / docket number, digits only; "?" for a digit the printer left out' },
      docket_gap: { type: 'boolean', description: 'true if a digit of the docket number is missing (printer gap)' },
      tonnes: { type: 'number', description: 'Net weight in tonnes' },
      rego: { type: 'string', description: 'Truck rego, letters and digits only' },
      product: { type: 'string' },
      load: { type: 'string' },
      unsure: { type: 'array', items: { type: 'string', enum: ['docket', 'tonnes', 'rego', 'product', 'load'] } },
      note: { type: 'string', description: 'Anything the crew should know, e.g. "photo is blurry"' }
    }
  }
};

module.exports = async (req, res) => {
  const env = process.env;
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  if (!env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'Docket reading isn’t set up yet (ANTHROPIC_API_KEY).', setup: true });
  // signed in?
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !env.SUPABASE_URL) return send(res, 401, { error: 'Sign in again.' });
  try {
    const who = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
    if (!who.ok) return send(res, 401, { error: 'Sign in again.' });
  } catch (e) { return send(res, 502, { error: 'Couldn’t check the sign-in.' }); }

  let body; try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
  const image = String(body.image || '').replace(/^data:[^,]+,/, '');
  if (!image || image.length > 6e6) return send(res, 400, { error: 'No photo, or the photo is too big.' });
  const mediaType = /^image\/(jpeg|png|webp)$/.test(body.mediaType || '') ? body.mediaType : 'image/jpeg';
  const clean = (xs, re, n) => (Array.isArray(xs) ? xs : []).map(x => String(x || '').toUpperCase().trim()).filter(x => re.test(x)).slice(0, n);
  const previous = clean(body.previous, /^\d{4,14}$/, 30), regos = [...new Set(clean(body.regos, /^[A-Z0-9]{3,9}$/, 80))];

  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 500, tools: [TOOL], tool_choice: { type: 'tool', name: 'docket' },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: PROMPT({ previous, regos }) }
        ] }]
      })
    });
  } catch (e) { return send(res, 502, { error: 'The docket reader couldn’t be reached.' }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return send(res, 502, { error: (j.error && j.error.message) || `The docket reader answered ${r.status}` });
  const use = (j.content || []).find(c => c.type === 'tool_use');
  const x = (use && use.input) || {};
  // tidy what came back
  let docket = String(x.docket || '').toUpperCase().replace(/[^0-9?]/g, '');
  const gapAt = docket.indexOf('?');
  const tonnes = Number(x.tonnes);
  const out = {
    docket: docket.replace(/\?/g, ''), docketGapAt: gapAt >= 0 ? gapAt : null, docketGap: gapAt >= 0 || !!x.docket_gap,
    tonnes: isFinite(tonnes) && tonnes > 0 && tonnes < 100 ? String(Math.round(tonnes * 1000) / 1000) : '',
    rego: String(x.rego || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9),
    product: String(x.product || '').trim().slice(0, 20),
    load: String(x.load || '').replace(/[^0-9]/g, '').slice(0, 5),
    unsure: Array.isArray(x.unsure) ? x.unsure : [],
    note: String(x.note || '').slice(0, 200),
    model: MODEL,
    usage: j.usage || null
  };
  return send(res, 200, out);
};
