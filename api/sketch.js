// Tidies a site diagram with Claude: the crew's hand drawing (a picture of it plus its shapes) comes in, a neat version
// comes back in the same shape format (straight lines, boxes, arrows, labels), so it stays editable in the drawing tool.
// Labels are added for the layers on the QA pack (layer type, depth, mix, area).
// POST /api/sketch { image: <base64 PNG/JPEG>, shapes: [...], layers: [{layer, depth, mix, area}], aspect }
//   → { shapes: [...], note }
// Signed-in FraserFlow users only. Uses ANTHROPIC_API_KEY (as api/docket.js); optional SKETCH_MODEL (default claude-sonnet-5-5).

const MODEL = process.env.SKETCH_MODEL || process.env.DOCKET_MODEL || 'claude-sonnet-5-5';
const COLOURS = ['#111111', '#d11a2a', '#1f5fd6', '#178a3e', '#e07b00', '#8a2be2'];

const send = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const r3 = v => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 1000) / 1000;
const pt = p => Array.isArray(p) && p.length >= 2 ? [r3(p[0]), r3(p[1])] : null;

// the drawing's shapes, made smaller for the prompt (pen strokes thinned out)
function compact(shapes) {
  return (Array.isArray(shapes) ? shapes : []).slice(0, 400).map(s => {
    if (!s || !s.t) return null;
    if (s.t === 'pen') { const pts = (s.pts || []).map(pt).filter(Boolean); const step = Math.max(1, Math.ceil(pts.length / 24)); return { t: 'pen', c: s.c, pts: pts.filter((_, i) => i % step === 0 || i === pts.length - 1) }; }
    if (s.t === 'text') return { t: 'text', c: s.c, p: pt(s.p), s: String(s.s || '').slice(0, 60) };
    return { t: s.t, c: s.c, a: pt(s.a), b: pt(s.b) };
  }).filter(Boolean);
}

// keep only well-formed shapes in the drawing tool's format
function clean(list) {
  const out = [];
  (Array.isArray(list) ? list : []).slice(0, 300).forEach(s => {
    if (!s || typeof s !== 'object') return;
    const c = COLOURS.includes(String(s.c || '').toLowerCase()) ? String(s.c).toLowerCase() : COLOURS[0];
    const w = Number(s.w) >= 5 ? 7 : 3;
    if (s.t === 'text') { const p = pt(s.p), t = String(s.s || '').trim().slice(0, 80); if (p && t) out.push({ t: 'text', p, s: t, c, size: Number(s.size) >= 0.031 ? 0.036 : 0.026 }); return; }
    if (['line', 'arrow', 'box', 'circle'].includes(s.t)) { const a = pt(s.a), b = pt(s.b); if (a && b && (a[0] !== b[0] || a[1] !== b[1])) out.push({ t: s.t, a, b, c, w }); return; }
    if (s.t === 'pen') { const pts = (s.pts || []).map(pt).filter(Boolean); if (pts.length >= 2) out.push({ t: 'pen', pts, c, w }); }
  });
  return out;
}

const TOOL = {
  name: 'diagram',
  description: 'The tidied site diagram, as shapes for the drawing tool.',
  input_schema: {
    type: 'object',
    properties: {
      shapes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            t: { type: 'string', enum: ['line', 'arrow', 'box', 'circle', 'text', 'pen'] },
            a: { type: 'array', items: { type: 'number' }, description: '[x, y] start / one corner (0–1)' },
            b: { type: 'array', items: { type: 'number' }, description: '[x, y] end / opposite corner (0–1)' },
            p: { type: 'array', items: { type: 'number' }, description: 'text: [x, y] of the left end of the text, vertically centred (0–1)' },
            s: { type: 'string', description: 'text: the words' },
            pts: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'pen: points (only for genuinely curved edges)' },
            c: { type: 'string', enum: COLOURS },
            w: { type: 'number', enum: [3, 7] },
            size: { type: 'number', enum: [0.026, 0.036] }
          },
          required: ['t']
        }
      },
      note: { type: 'string', description: 'One short sentence on anything you weren’t sure about' }
    },
    required: ['shapes']
  }
};

const PROMPT = ({ aspect, shapes, layers }) => `You are tidying a road crew's hand-drawn asphalt site diagram (a sketch of where they paved, done on a phone).
The picture shows the drawing; below are its shapes. Coordinates are fractions of the page: x 0 (left) to 1 (right), y 0 (top) to 1 (bottom).
The page is ${aspect >= 1 ? 'landscape' : 'portrait'} (width ÷ height = ${Number(aspect || 4 / 3).toFixed(3)}).

Redraw it neatly and call the "diagram" tool:
- Keep the same layout, positions and meaning. Don't invent roads, areas or measurements that aren't drawn.
- Wobbly freehand lines become straight lines; rough rectangles become boxes; rough circles become circles; arrows stay arrows. Keep pen strokes only for genuinely curved edges (e.g. a cul-de-sac), smoothed with few points.
- Keep every label and measurement the crew wrote (fix obvious spelling only), placed neatly next to what it describes, not overlapping lines. Text size 0.026 (or 0.036 for a title). Text p is its left end, vertically centred.
- Text widths (fractions of the page WIDTH): each character is about 0.015 wide at size 0.026 and 0.021 at size 0.036; a line of text is about 1.3 × size tall in page-width units (so ${aspect >= 1 ? 'about 0.045 of the page height on this landscape page' : 'about 0.026 of the page height on this portrait page'}). Make any box around text (e.g. the key) wide and tall enough to hold its text with a small margin, and keep text inside the page.
- Keep the crew's colours where they mean something; otherwise black (#111111). Line width 3 (or 7 for main outlines).
${layers.length ? `- Add a small key (legend) in a clear corner listing the layers paved:
${layers.map((l, i) => `  ${i + 1}. ${[l.layer || `Layer ${i + 1}`, l.depth, l.mix, l.area ? l.area + ' m²' : ''].filter(Boolean).join(' · ')}`).join('\n')}
  If it's clear which drawn area is which layer, also label that area.` : ''}
- Leave a little margin: keep everything between 0.03 and 0.97.

The crew's shapes (JSON): ${JSON.stringify(shapes)}`;

module.exports = async (req, res) => {
  const env = process.env;
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  if (!env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'AI isn’t set up yet (ANTHROPIC_API_KEY).' });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !env.SUPABASE_URL) return send(res, 401, { error: 'Sign in again.' });
  try {
    const who = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token } });
    if (!who.ok) return send(res, 401, { error: 'Sign in again.' });
  } catch (e) { return send(res, 502, { error: 'Couldn’t check the sign-in.' }); }

  let body; try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
  const image = String(body.image || '').replace(/^data:[^,]+,/, '');
  if (!image || image.length > 6e6) return send(res, 400, { error: 'No drawing, or it’s too big.' });
  const mediaType = /^image\/(jpeg|png|webp)$/.test(body.mediaType || '') ? body.mediaType : 'image/png';
  const shapes = compact(body.shapes);
  if (!shapes.length) return send(res, 400, { error: 'Draw something first.' });
  const layers = (Array.isArray(body.layers) ? body.layers : []).slice(0, 6).map(l => ({ layer: String(l.layer || '').slice(0, 40), depth: String(l.depth || '').slice(0, 20), mix: String(l.mix || '').slice(0, 30), area: String(l.area || '').slice(0, 12) }))
    .filter(l => l.layer || l.depth || l.mix || l.area);

  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 16000, tools: [TOOL],
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: PROMPT({ aspect: Number(body.aspect) || 4 / 3, shapes, layers }) + '\n\nAlways answer by calling the "diagram" tool.' }
        ] }]
      })
    });
  } catch (e) { return send(res, 502, { error: 'The AI couldn’t be reached.' }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return send(res, 502, { error: (j.error && j.error.message) || `The AI answered ${r.status}` });
  const use = (j.content || []).find(c => c.type === 'tool_use');
  const out = clean(use && use.input && use.input.shapes);
  if (!out.length) return send(res, 502, { error: `The AI didn’t return a drawing (${j.stop_reason || 'no answer'})` });
  return send(res, 200, { shapes: out, note: String((use.input && use.input.note) || '').slice(0, 200), usage: j.usage || null });
};
