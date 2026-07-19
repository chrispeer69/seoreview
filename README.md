# SEO & AI Search Audit Tool

A single-file, browser-based tool that scans any public website for traditional
**Google SEO** and modern **AI search readiness (AEO/GEO)**, then generates a
branded, printable report.

Built by **Blue Collar AI, Inc.** — AI-Powered Local SEO.
📧 chris@bluecollarai.online · 🌐 www.bluecollarai.online

## What it checks

- **Indexability & crawlability** — noindex, canonical, robots.txt, XML sitemap
- **On-page content** — title, meta description, headings, word count
- **Technical & mobile** — HTTPS, viewport, mixed content, charset, language
- **Local SEO** — LocalBusiness schema, review/rating (star) schema, click-to-call, maps
- **Social sharing** — Open Graph, Twitter/X cards
- **Images & accessibility** — alt text, image dimensions
- **Performance hygiene** — page weight, render-blocking scripts
- **AI search & answer engines (AEO/GEO)** — AI crawler access (GPTBot, ClaudeBot,
  PerplexityBot, Google-Extended, etc.), llms.txt, FAQ/Q&A schema, Organization
  entity data, semantic main-content region

## Usage

Open `web-analyzer-siteV7.html` in a browser. Because the tool fetches target
pages through public CORS proxies, serve it over HTTP rather than `file://`:

```bash
python -m http.server 8000
# then visit http://localhost:8000/web-analyzer-siteV7.html
```

Enter one or more site URLs (one per line), run the audit, then open the branded
report and print / save as PDF.

## Files

- `web-analyzer-siteV7.html` — current tool (SEO + AI Search)
- `web-analyzer-site.html` — earlier version
