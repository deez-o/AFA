// Hands the browser the Supabase project URL and public (anon) key.
// Both are set in Vercel → Project → Settings → Environment Variables.
// The anon key is meant to be public; the database rules (see supabase/schema.sql)
// are what stop anyone who isn't signed in from reading or changing the roster.
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || ''
  }));
};
