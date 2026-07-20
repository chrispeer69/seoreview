// Blue Collar AI — SEO & AI Search Audit server
// - Serves the public audit tool
// - /api/proxy: server-side fetch (no flaky public CORS proxies)
// - Team zone: Google login (team whitelist) + Postgres-backed saved reports
// - Lead capture + optional Google Places reviews
//
// Everything degrades gracefully: with no DATABASE_URL / GOOGLE_* env vars the
// server still serves the public tool + proxy, and the team UI stays hidden.
'use strict';
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const cfg = {
  db: !!process.env.DATABASE_URL,
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  places: !!process.env.PLACES_API_KEY,
  email: !!process.env.RESEND_API_KEY,
  teamEmails: (process.env.TEAM_EMAILS || '').split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean),
};
const teamEnabled = cfg.db && cfg.google;

app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));

// ---------- Database ----------
let pool = null;
if (cfg.db) {
  const { Pool } = require('pg');
  const dbUrl = process.env.DATABASE_URL;
  // Railway's internal network (…railway.internal) speaks plain TCP — forcing SSL
  // there breaks the connection. Auto-detect; override with PGSSL=require|disable.
  const internal = /railway\.internal|localhost|127\.0\.0\.1/.test(dbUrl || '');
  const ssl = process.env.PGSSL === 'require' ? { rejectUnauthorized: false }
            : process.env.PGSSL === 'disable' ? false
            : (internal ? false : { rejectUnauthorized: false });
  pool = new Pool({ connectionString: dbUrl, ssl });
  pool.on('error', e => console.error('PG pool error:', e.message));
}
async function migrate() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      google_sub TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_login TIMESTAMPTZ
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_runs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      customer TEXT,
      urls TEXT[],
      results JSONB NOT NULL,
      summary JSONB,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_runs_created ON report_runs (created_at DESC);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      email TEXT,
      url TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );`);
}

// ---------- Auth (Google OAuth) ----------
let passport = null;
if (teamEnabled) {
  const session = require('express-session');
  const PgSession = require('connect-pg-simple')(session);
  passport = require('passport');
  const GoogleStrategy = require('passport-google-oauth20').Strategy;

  app.use(session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret-set-SESSION_SECRET',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: BASE_URL.startsWith('https'),
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000,
    },
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: BASE_URL + '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = ((profile.emails && profile.emails[0] && profile.emails[0].value) || '').toLowerCase();
      if (!email) return done(null, false);
      if (cfg.teamEmails.length && !cfg.teamEmails.includes(email)) return done(null, false, { message: 'not_authorized' });
      const name = profile.displayName || '';
      await pool.query(
        `INSERT INTO users (email, name, google_sub, last_login) VALUES ($1,$2,$3, now())
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, google_sub=EXCLUDED.google_sub, last_login=now()`,
        [email, name, profile.id]);
      return done(null, { email, name });
    } catch (e) { return done(e); }
  }));
  passport.serializeUser((u, d) => d(null, u.email));
  passport.deserializeUser((email, d) => d(null, { email }));

  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback', (req, res, next) => {
    passport.authenticate('google', (err, user, info) => {
      if (err) { console.error('OAuth callback error:', err && err.stack ? err.stack : err); return res.status(500).send('Login error: ' + (err && err.message ? err.message : String(err))); }
      if (!user) { return res.redirect('/web-analyzer-siteV7.html?login=denied'); }
      req.logIn(user, (e) => {
        if (e) { console.error('session logIn error:', e && e.stack ? e.stack : e); return res.status(500).send('Session error: ' + (e && e.message ? e.message : String(e))); }
        return res.redirect('/web-analyzer-siteV7.html?login=ok');
      });
    })(req, res, next);
  });
  app.get('/auth/logout', (req, res) => { req.logout(() => res.redirect('/web-analyzer-siteV7.html')); });
}

function loggedIn(req) { return !!(passport && req.isAuthenticated && req.isAuthenticated()); }
function requireAuth(req, res, next) {
  if (loggedIn(req)) return next();
  return res.status(401).json({ error: 'auth_required' });
}

// ---------- Public API: config ----------
app.get('/api/config', (req, res) => {
  res.json({
    teamEnabled,
    placesEnabled: cfg.places,
    user: loggedIn(req) ? req.user : null,
  });
});

// ---------- Server-side fetch proxy ----------
function isPrivateHost(hRaw) {
  const h = String(hRaw || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '169.254.169.254') return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}
app.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('missing url');
  let u;
  try { u = new URL(target); } catch (e) { return res.status(400).send('bad url'); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).send('only http/https allowed');
  if (isPrivateHost(u.hostname)) return res.status(403).send('blocked host');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(u.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // Present as a real Chrome browser so header-based bot filters pass.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
    });
    const body = await r.text();
    res.set('Access-Control-Allow-Origin', '*');
    // Detect interstitial bot-challenge pages (Cloudflare et al.) so the client
    // shows an accurate message rather than a generic proxy error.
    const challenged = (r.status === 403 || r.status === 503) &&
      /just a moment|cf-chl|challenge-platform|cf-mitigated|enable javascript and cookies/i.test(body);
    if (challenged) res.set('X-Proxy-Reason', 'bot-protection');
    res.status(challenged ? 502 : r.status).type('text/plain; charset=utf-8').send(body);
  } catch (e) {
    res.status(502).send('fetch failed: ' + (e && e.name ? e.name : 'error'));
  } finally { clearTimeout(t); }
});

// ---------- Email (Resend) ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function sendEmail({ to, subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true };
  const from = process.env.MAIL_FROM || 'Blue Collar AI <onboarding@resend.dev>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, reply_to: replyTo }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('email send failed', r.status, t); return { ok: false, status: r.status, body: t }; }
    return { ok: true };
  } catch (e) { console.error('email error', e.message); return { ok: false, error: e.message }; }
}

// ---------- Lead capture (public) ----------
app.post('/api/lead', async (req, res) => {
  const { email, url, meta } = req.body || {};
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: 'valid email required' });
  const clean = email.trim().toLowerCase();
  let stored = false;
  if (pool) {
    try { await pool.query('INSERT INTO leads (email, url, meta) VALUES ($1,$2,$3)', [clean, url || null, meta ? JSON.stringify(meta) : null]); stored = true; }
    catch (e) { console.error('lead store failed', e.message); }
  }
  let emailed = false;
  if (process.env.RESEND_API_KEY) {
    const sites = (meta && Array.isArray(meta.summary))
      ? meta.summary.map(s => `${escapeHtml(s.domain)}: ${s.error ? '—' : (escapeHtml(s.grade) + ' (' + s.score + ')')}`).join('<br>')
      : escapeHtml(url || '');
    // A) Alert the team of a new lead
    const n = await sendEmail({
      to: process.env.LEAD_NOTIFY_TO || clean,
      replyTo: clean,
      subject: `New audit lead: ${clean}`,
      html: `<h2>New SEO audit lead</h2><p><b>Email:</b> ${escapeHtml(clean)}<br><b>Requested:</b> ${escapeHtml(url || '')}</p><p><b>Scores:</b><br>${sites}</p>`,
    });
    emailed = !!(n && n.ok);
    // B) Thank the prospect (requires a verified sending domain in Resend)
    await sendEmail({
      to: clean,
      replyTo: process.env.LEAD_NOTIFY_TO || undefined,
      subject: 'Your SEO & AI Search audit — Blue Collar AI',
      html: `<h2>Thanks for running an audit</h2>
        <p>Here's a snapshot of what we found:</p>
        <p>${sites}</p>
        <p>Every issue in your report is fixable — usually faster than you'd think. Blue Collar AI helps local businesses turn audits like this into more calls and higher rankings in both Google <i>and</i> the new AI search tools.</p>
        <p>Just reply and we'll walk you through your results and a plan — no obligation.</p>
        <p style="color:#64748b;font-size:13px">Blue Collar AI, Inc. · AI-Powered Local SEO · www.bluecollarai.online</p>`,
    });
  }
  res.json({ ok: true, stored, emailed });
});

// ---------- Google Places reviews (server-side, optional) ----------
app.get('/api/places', async (req, res) => {
  if (!cfg.places) return res.status(503).json({ error: 'places_not_configured' });
  const query = (req.query.q || req.query.name || '').trim();
  if (!query) return res.status(400).json({ error: 'q_required' });
  const key = process.env.PLACES_API_KEY;
  try {
    const ts = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`).then(r => r.json());
    const first = ts.results && ts.results[0];
    if (!first) return res.json({ found: false });
    const det = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${first.place_id}&fields=name,rating,user_ratings_total,url,formatted_address,formatted_phone_number,reviews&key=${key}`).then(r => r.json());
    const d = det.result || {};
    res.json({
      found: true,
      name: d.name, rating: d.rating, reviews: d.user_ratings_total,
      address: d.formatted_address, phone: d.formatted_phone_number, mapsUrl: d.url,
      recent: (d.reviews || []).slice(0, 3).map(x => ({ author: x.author_name, rating: x.rating, text: x.text, when: x.relative_time_description })),
    });
  } catch (e) { res.status(502).json({ error: 'places_failed' }); }
});

// ---------- Team reports API (protected) ----------
app.get('/api/reports', requireAuth, async (req, res) => {
  const raw = (req.query.q || '').trim();
  const q = '%' + raw + '%';
  try {
    const { rows } = await pool.query(
      `SELECT id, name, customer, created_by, created_at, summary,
              COALESCE(array_length(urls,1),0) AS count
         FROM report_runs
        WHERE $1 = '' OR name ILIKE $2 OR COALESCE(customer,'') ILIKE $2
           OR COALESCE(array_to_string(urls,' '),'') ILIKE $2
        ORDER BY created_at DESC
        LIMIT 300`, [raw, q]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'list_failed' }); }
});
app.post('/api/reports', requireAuth, async (req, res) => {
  const { name, customer, reports, summary } = req.body || {};
  if (!name || !Array.isArray(reports) || !reports.length) return res.status(400).json({ error: 'name_and_reports_required' });
  const urls = reports.map(r => r.url || r.domain || '').filter(Boolean);
  const sum = Array.isArray(summary) ? summary : reports.map(r => ({ domain: r.domain, error: !!r.error }));
  try {
    const { rows } = await pool.query(
      `INSERT INTO report_runs (name, customer, urls, results, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, customer || null, urls, JSON.stringify(reports), JSON.stringify(sum), req.user.email]);
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: 'save_failed' }); }
});
app.get('/api/reports/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM report_runs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'get_failed' }); }
});
app.delete('/api/reports/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM report_runs WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'delete_failed' }); }
});

// Send a finished report to a client (team-only — protects sending reputation)
app.post('/api/send-report', requireAuth, async (req, res) => {
  const { to, subject, html } = req.body || {};
  if (!to || !/.+@.+\..+/.test(to) || !html) return res.status(400).json({ error: 'to_and_html_required' });
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'email_not_configured' });
  const r = await sendEmail({ to, subject: subject || 'Your SEO Audit', html, replyTo: req.user.email });
  if (r && r.ok) return res.json({ ok: true });
  return res.status(502).json({ error: 'send_failed' });
});

app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
// DB connectivity check (no secrets) — helps diagnose login/session failures
app.get('/healthz/db', async (req, res) => {
  if (!pool) return res.json({ db: false });
  try { await pool.query('SELECT 1'); res.json({ db: true, ok: true }); }
  catch (e) { res.status(500).json({ db: true, ok: false, error: e.message }); }
});

// ---------- Static public tool ----------
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Log the real error behind any 500 (e.g. failed login/session writes)
app.use((err, req, res, next) => {
  console.error('Unhandled error on', req.method, req.path, '-', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send('Internal Server Error');
});

(async () => {
  try { await migrate(); if (pool) console.log('DB ready'); }
  catch (e) { console.error('DB migrate failed (team features may be off):', e.message); }
  app.listen(PORT, () => {
    console.log(`SEO audit server on :${PORT} | team=${teamEnabled} places=${cfg.places} email=${cfg.email} whitelist=${cfg.teamEmails.length}`);
  });
})();
