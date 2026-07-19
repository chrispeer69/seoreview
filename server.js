// Blue Collar AI — SEO & AI Search Audit server
// Serves the public audit tool AND a server-side fetch proxy so audits no
// longer depend on flaky public CORS proxies. (Step 1 of the team-zone build.)
'use strict';
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Server-side fetch proxy (replaces public CORS proxies) ----
// Blocks obviously-private hosts to reduce SSRF risk. Redirects are followed
// because target sites commonly redirect (http->https, apex->www).
function isPrivateHost(hRaw) {
  const h = String(hRaw || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '169.254.169.254') return true;              // cloud metadata endpoint
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // 172.16.0.0 – 172.31.255.255
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
        'User-Agent': 'Mozilla/5.0 (compatible; BlueCollarAI-SEO-Audit/1.0; +https://www.bluecollarai.online)',
        'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8'
      }
    });
    const body = await r.text();
    res.set('Access-Control-Allow-Origin', '*');
    res.status(r.status).type('text/plain; charset=utf-8').send(body);
  } catch (e) {
    res.status(502).send('fetch failed: ' + (e && e.name ? e.name : 'error'));
  } finally {
    clearTimeout(t);
  }
});

app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

// ---- Static public tool ----
app.use(express.static(__dirname, { extensions: ['html'] }));

// Root -> index.html (redirects on to web-analyzer-siteV7.html)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`SEO audit server listening on :${PORT}`));
