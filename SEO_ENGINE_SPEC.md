# Blue Collar AI — SEO Analyzer v2 Spec (for approval)

**Goal:** the most thorough SEO analyzer in the local-service space. Crawl **every page** of a
site, review the **actual code**, and give an **honest** verdict on how that code affects
ranking in **Google, Bing, and AI search** (ChatGPT / Perplexity / Google AI Overviews / Copilot).

**Two tools, one engine:** the public tool (seoreview) and the CRM (CRMColumbus) load the **same
engine source** — identical output, no drift, ever.

**Honesty rule (baked in):** every report states pages crawled, pages skipped/capped, and any
check that couldn't run (e.g. speed quota). No silent gaps. Nothing fabricated is ever rewarded.

---

## 1. Crawl (every page, first to last)
- Discover pages via **sitemap.xml** (handles sitemap-index); **fallback = link-crawl** from the
  homepage following internal links.
- Cap configurable (default up to ~150 pages); report exactly what was and wasn't covered.
- Fetch **raw HTML** (what Bing & AI crawlers mostly see) **and render with headless Chrome**
  (what Google sees) — then **compare the two** and flag content that only exists after JS.

## 2. Per-page code review — grouped, each tagged by engine impact [G]oogle [B]ing [AI]
- **Indexability/crawl:** HTTP status & redirects, `noindex`, canonical, robots.txt rules,
  in-sitemap? [G][B][AI]
- **Head/meta code:** title (present/length/**unique across site**), meta description, canonical
  correctness, hreflang, viewport, charset, `lang`. [G][B][AI]
- **Content code:** exactly one H1, heading hierarchy, **word count / thin content**,
  **rendered-vs-raw delta (JS-dependency)**, keyword/intent match of title↔body. [G][B][AI]
- **Structured data:** JSON-LD present **+ valid schema.org type** (not just present), required
  fields, **breadcrumb correctness**, **fabricated / aggregate-rating risk flagged**. [G][AI]
- **Technical/mobile:** HTTPS, mixed content, render-blocking scripts, page weight, image
  optimization + alt, dimensions/lazy-load. [G][B]
- **Performance (key pages):** Lighthouse via PageSpeed — Performance + **Core Web Vitals** +
  Google's own **SEO / Accessibility / Best-Practices** category scores (mobile + desktop). [G]
- **AI-search readiness:** raw-HTML content visible w/o JS, **AI-crawler access** (robots for
  GPTBot / ClaudeBot / PerplexityBot / Google-Extended / CCBot…), `llms.txt`, semantic
  `<main>/<article>`, FAQ/Q&A schema, Organization + `sameAs` entity data. [AI]
- **Bing-specific:** IndexNow support, cleaner-markup weighting, **Bing renders less JS than
  Google** (so raw-HTML gaps hurt Bing more) — called out explicitly. [B]

## 3. Cross-page / site-level (what single-page tools can't do)
- Duplicate titles / meta / H1 / body across pages.
- **Title↔body mismatch** per page (the exact "98 but broken" failure).
- Thin / near-duplicate pages.
- Internal link graph: orphan pages, click-depth.
- Consistency of schema type, brand/legal name, and NAP across all pages.
- Sitemap vs actual-pages coverage gaps.

## 4. Local / off-site (uses your Places key)
- Google Business Profile presence, **review count + average rating**, NAP consistency.

## 5. Authority (Phase 3 — licensed data, you fund the API)
- Backlink profile / domain authority, competitor keyword gaps via a licensed provider
  (DataForSEO cheapest pay-as-you-go; Ahrefs/SEMrush pricier). Honest note: no tool "builds"
  this — everyone licenses it.

## 6. Output
- Site-wide score + honest verdict; **per-engine readiness** (Google / Bing / AI) breakdown;
  per-page issue list; cross-page findings; prioritized fix list.
- Branded report (Blue Collar AI + contacts + Why-AI-Search), landscape print, comparison view.

## 7. Architecture
- Crawl runs **server-side** (reliably hits many pages, shows live progress); results cached per
  audit; shared `seo-engine` module used by both repos.

## 8. Phasing (each phase built once, then proven on real sites before "done")
- **Phase 1:** whole-site crawler + per-page code review + rendered-vs-raw + cross-page analysis +
  per-engine (Google/Bing/AI) scoring + honest coverage reporting.
- **Phase 2:** local / off-site (Places).
- **Phase 3:** authority (licensed API — needs provider + budget from you).

**Proof-of-done for Phase 1:** run end-to-end against columbusroadsidetowing.com and show it
catches the duplicate-body-across-routes, title↔body mismatch, JS-hidden content, invalid schema
types, and fabricated-rating issues the current single-page tool missed — before it goes near a client.
