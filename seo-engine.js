/* Blue Collar AI — SEO & AI Search audit engine. THE ONE COPY.
   Used by the public tool (web-analyzer-siteV7.html, and headless-audit.js for /api/v1) and by CRMColumbus,
   whose server redirects /seo-engine.js to this file on the seoreview deploy. Change the engine here only.
   Browser/jsdom script: needs DOMParser + fetch. Exposes window.SEO. */
(function(root){
"use strict";
// Stamped by the server when this file is served (engine-version.js): "<commit>-<content hash>". Results carry it and
// every report prints it, so we can always tell which engine produced a report.
const ENGINE_VERSION='__ENGINE_VERSION__';
const BRAND = {
  name:'Blue Collar AI, Inc.',
  tagline:'AI-Powered Local SEO',
  web:'www.bluecollarai.online',
  webUrl:'https://www.bluecollarai.online',
  bookUrl:'https://calendar.app.google/REPLACE-WITH-YOUR-GOOGLE-APPOINTMENT-LINK',   /* Google Calendar > Appointment schedule > share this booking page link */
  buyUrl:'https://www.bluecollarai.online/buy-report',    /* TODO: your real Stripe/payment link for the $49 report */
  reportPrice:'$49',
  sites:['www.bluecollarai.online','www.ustowalliance.com','www.usautoalliance.com'],
  contacts:[
    { name:'Chris',  phone:'614-633-7935', tel:'+16146337935', email:'chris@bluecollarai.online' },
    { name:'Dustin', phone:'614-206-3606', tel:'+16142063606', email:'dustin@bluecollarai.online' },
  ]
};
// Don't ship the placeholder booking link as a dead CTA — blank it so the email/text fall back to a working mailto.
if(/REPLACE|\bREPLACE-WITH\b/i.test(BRAND.bookUrl||'')) BRAND.bookUrl='';
if(/buy-report/i.test(BRAND.buyUrl||'')) BRAND.buyUrl='';  // TODO placeholder → let a real server share link (opts.buyUrl) or webUrl take over
// Every fetch goes through OUR server (/api/proxy, /api/render) — never a third-party CORS proxy (allorigins,
// corsproxy, corsfix…): they leak the audit to strangers, get rate-limited and can return other people's pages.
const PROXIES = [ { name:'self', build:u=>`/api/proxy?url=${encodeURIComponent(u)}`, json:false } ];
const RE_CHALLENGE_BODY=/just a moment|cf-chl|challenge-platform|cf-mitigated|enable javascript and cookies|attention required|ddos-guard/i;
let CHALLENGE_BACKOFF_MS=3000; // tests shorten it (SEO._x.setBackoff)
const TAGS = {
  'Google Analytics':['google-analytics.com','gtag(','/g/collect','_gaq'],
  'Google Tag Manager':['googletagmanager.com'],
  'Google Ads':['googleadservices.com','gtag/js?id=AW-'],
  'Meta / Facebook Pixel':['connect.facebook.net','fbq(','facebook.com/tr'],
  'Microsoft Clarity':['clarity.ms'],
  'Hotjar':['hotjar.com'],
  'TikTok Pixel':['analytics.tiktok.com','ttq.'],
  'LinkedIn Insight':['snap.licdn.com'],
  // call tracking
  'CallRail':['cdn.callrail.com','callrail.com/companies'],
  'CallTrackingMetrics':['tctm.co','calltrackingmetrics.com'],
  'Invoca':['invocacdn.com','solutions.invocacdn','invoca.net'],
  'WhatConverts':['whatconverts.com'],
};
// Live-chat and messaging widgets (stack fingerprint, not scored).
const CHAT_WIDGETS = { 'Intercom':['widget.intercom.io','intercomcdn'], 'Drift':['js.driftt.com'], 'tawk.to':['embed.tawk.to'], 'LiveChat':['cdn.livechatinc.com'],
  'Podium':['connect.podium.com','podium.com/widget'], 'Birdeye':['birdeye.com/embed','birdeye.com/widget'], 'Tidio':['code.tidio.co'], 'Zendesk Chat':['static.zdassets.com','v2.zopim.com'],
  'HubSpot Chat':['js.hs-scripts.com','js.usemessages.com'], 'Facebook Messenger':['connect.facebook.net/en_US/sdk/xfbml.customerchat'], 'Olark':['static.olark.com'], 'Crisp':['client.crisp.chat'],
  'Smartsupp':['smartsuppchat.com'], 'Freshchat':['wchat.freshchat.com'], 'LiveAgent':['ladesk.com'], 'Weave':['weavehelp','getweave.com'] };
const PAYMENTS = { 'PayPal':['paypal.com','paypalobjects.com'], 'CardPointe':['cardpointe','cardconnect.com'], 'Square':['squareup.com','square.site','squarecdn'], 'Stripe':['js.stripe.com','buy.stripe.com','checkout.stripe.com'],
  'Clover':['clover.com'], 'Authorize.net':['authorize.net'], 'Braintree':['braintreegateway','braintree-api'], 'Venmo':['venmo.com'], 'Heartland':['heartlandpaymentsystems','hps.io'],
  'QuickBooks Payments':['quickbooks.intuit.com','connect.intuit.com'], 'Zelle':['zellepay.com'] };
// Crawlers that fetch pages for live search / AI answers — blocking these removes the site from those answers (scored).
const AI_SEARCH_BOTS = ['OAI-SearchBot','ChatGPT-User','PerplexityBot','Perplexity-User','ClaudeBot','Bingbot','Googlebot'];
// Crawlers that only collect model-training data — blocking them is a legitimate choice (reported, never penalized).
const AI_TRAINING_BOTS = ['GPTBot','Google-Extended','CCBot','Bytespider','Applebot-Extended','Meta-ExternalAgent','anthropic-ai','Amazonbot'];
const AI_BOTS = AI_SEARCH_BOTS.concat(AI_TRAINING_BOTS);

const AISEARCH = 'AI Search & Answer Engines';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
// Whole-scan AbortController (the public tool's Stop button). The page hands it over with SEO.setAbort(ctrl).
let scanCtrl=null;
function setAbort(ctrl){ scanCtrl=ctrl||null; resetLinkCache(); } // a new scan also starts with fresh URL checks
function linkAbort(ctrl){ if(scanCtrl){ if(scanCtrl.signal.aborted){ try{ctrl.abort();}catch(e){} } else scanCtrl.signal.addEventListener('abort',()=>{try{ctrl.abort();}catch(e){}},{once:true}); } }
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
// Fixes that are bigger projects (need content, dev work, or third-party setup) vs. quick wins.
const PROJECT_FIXES = new Set([
  'Unique content','Unique vs sibling pages','Local detail','Served over HTTPS','No mixed (insecure) content','LocalBusiness structured data',
  'Reasonable page weight','Limited render-blocking scripts','Q&A / FAQ structured data',
  'Semantic main-content region','Review / rating schema',
  'Mobile speed score','Desktop speed score','Largest Contentful Paint (mobile)','Layout stability (mobile CLS)'
]);
function isQuick(label){ return !PROJECT_FIXES.has(label); }
async function fetchOnce(url, ms){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),ms||12000); linkAbort(ctrl);
  try{ return await fetch(url,{signal:ctrl.signal}); } finally{ clearTimeout(t); }
}
// Plain-language names for the server's X-Fetch-Failure kinds (fetch-resilient.js), shown in the report and the API.
const FETCH_FAILURE_LABELS={ dns:'Domain gone - the web address no longer resolves', tls:'Bad security certificate', not_found:'Page not found (404)',
  server_error:"Site down - the website's server returned an error", blocked:'Blocked by bot protection', rate_limited:'Rate-limited by the site',
  timeout:'Timed out', network:'Could not connect to the site', parked:'Domain expired or for sale' };
// Fall back to the rendering service (a real browser) when the server's own fetch was refused or errored - never for
// a 404, a dead domain, a bad certificate or a parked domain (a browser would not do better), at most once per URL
// and at most RENDER_FALLBACK_CAP times per scan (renders are paid).
const RENDER_FALLBACK_STATUSES=new Set([0,403,429,500,502,503,504,520,521,522,523,524]);
const NO_RENDER_KINDS=new Set(['dns','tls','not_found','parked']);
let RENDER_FALLBACK_CAP=25, _renderFallbacks=0; const _renderTried=new Set();
async function renderFallback(targetUrl){
  if(_renderTried.has(targetUrl)||_renderFallbacks>=RENDER_FALLBACK_CAP) return null;
  _renderTried.add(targetUrl); _renderFallbacks++;
  try{ const r=await fetchOnce('/api/render?url='+encodeURIComponent(targetUrl), 50000);
    if(r.ok){ const html=await r.text(); if(html&&html.length>50&&!RE_CHALLENGE_BODY.test(html.slice(0,5000))){ _fetchMeta.set(targetUrl,{status:200, finalUrl:null, viaRender:true}); return html; } } }catch(e){}
  return null;
}
// Page HTML via our proxy. On a Cloudflare / bot challenge: back off, retry once, then try the rendering service
// (ScrapingBee, a real browser). Still blocked -> a "blocked" error, which the report lists. A refused or errored
// fetch (403 / 5xx / 429 / connection error) also tries the rendering service once before failing.
async function fetchHtml(targetUrl){
  if(scanCtrl&&scanCtrl.signal.aborted) throw new DOMException('aborted','AbortError');
  let lastErr=null, challenged=false, status=null, kind=null;
  for(let attempt=0; attempt<2; attempt++){
    if(attempt) await sleep(CHALLENGE_BACKOFF_MS);
    try{
      const res=await fetchOnce(PROXIES[0].build(targetUrl), 35000); // the server queues per host and retries
      _fetchMeta.set(targetUrl,{status:res.status, finalUrl:res.headers.get('x-final-url')||null, contentType:res.headers.get('content-type')||null});
      const body=(res.ok||res.status===403||res.status===503||res.status===502)?await res.text():'';
      const isChallenge=/bot-protection/i.test(res.headers.get('x-proxy-reason')||'')||((res.status===403||res.status===503)&&RE_CHALLENGE_BODY.test(body));
      if(res.ok&&body&&body.length>50) return body;
      status=res.status; kind=res.headers.get('x-fetch-failure')||null;
      if(!isChallenge){ lastErr=new Error('proxy HTTP '+res.status+(kind&&FETCH_FAILURE_LABELS[kind]?' — '+FETCH_FAILURE_LABELS[kind]:'')); break; }
      challenged=true; lastErr=new Error('bot challenge');
    }catch(e){ if(scanCtrl&&scanCtrl.signal.aborted) throw e; lastErr=e; status=0; break; }
  }
  if(!challenged && status!=null && (RENDER_FALLBACK_STATUSES.has(status) || (status===200)) && !NO_RENDER_KINDS.has(kind)){
    const html=await renderFallback(targetUrl);
    if(html) return html;
  }
  if(lastErr && kind) lastErr.fetchFailure=kind;
  if(challenged){
    const html=await renderFallback(targetUrl); if(html) return html;
    throw { blocked:true, challenged:true, reason:'Blocked by bot protection (Cloudflare-style challenge) — retried after a pause and through ScrapingBee, still blocked.' };
  }
  throw lastErr||new Error('fetch failed');
}
async function fetchAux(u){
  if(scanCtrl&&scanCtrl.signal.aborted) return '';
  try{ const res=await fetchOnce(PROXIES[0].build(u), 8000); if(res.ok) return (await res.text())||''; }catch(e){}
  return null;
}

// Parse robots.txt into user-agent groups. A bot obeys the group naming it (else the "*" group); it is blocked from
// the whole site when that group disallows "/" and does not also allow "/".
function robotsGroups(robots){
  const groups=[]; let cur=null;
  for(const raw of String(robots).split(/\r?\n/)){
    const line=raw.replace(/#.*/,'').trim(); if(!line)continue;
    const ua=line.match(/^user-agent:\s*(.+)$/i);
    if(ua){ if(!cur||cur.hasRules){cur={agents:[],hasRules:false,allow:[],disallow:[]};groups.push(cur);} cur.agents.push(ua[1].trim().toLowerCase()); continue; }
    const rule=line.match(/^(allow|disallow):\s*(.*)$/i);
    if(rule&&cur){ cur.hasRules=true; cur[rule[1].toLowerCase()].push(rule[2].trim()); }
  }
  return groups;
}
function botBlocked(groups, bot){
  const lb=bot.toLowerCase();
  let mine=groups.filter(g=>g.agents.includes(lb));
  if(!mine.length) mine=groups.filter(g=>g.agents.includes('*'));
  const dis=mine.some(g=>g.disallow.includes('/')), allow=mine.some(g=>g.allow.includes('/'));
  return dis&&!allow;
}
function aiCrawlerStatus(robots){
  const groups=robotsGroups(robots);
  const blocked=AI_SEARCH_BOTS.filter(b=>botBlocked(groups,b));
  const trainingBlocked=AI_TRAINING_BOTS.filter(b=>botBlocked(groups,b));
  const globalBlocked=groups.some(g=>g.agents.includes('*')&&g.disallow.includes('/')&&!g.allow.includes('/'));
  return {blocked, trainingBlocked, globalBlocked};
}

// ---------- Structured data (JSON-LD) ----------
// LocalBusiness and its schema.org subtypes. Organization (and its non-local subtypes) is NOT a local business.
const LB_TYPES = new Set(('LocalBusiness AnimalShelter ArchiveOrganization AutomotiveBusiness AutoBodyShop AutoDealer AutoPartsStore AutoRental '
  +'AutoRepair AutoWash GasStation MotorcycleDealer MotorcycleRepair ChildCare Dentist DryCleaningOrLaundry EmergencyService FireStation '
  +'Hospital PoliceStation EmploymentAgency EntertainmentBusiness AdultEntertainment AmusementPark ArtGallery Casino ComedyClub MovieTheater '
  +'NightClub FinancialService AccountingService AutomatedTeller BankOrCreditUnion InsuranceAgency FoodEstablishment Bakery BarOrPub Brewery '
  +'CafeOrCoffeeShop Distillery FastFoodRestaurant IceCreamShop Restaurant Winery GovernmentOffice PostOffice HealthAndBeautyBusiness '
  +'BeautySalon DaySpa HairSalon HealthClub NailSalon TattooParlor HomeAndConstructionBusiness Electrician GeneralContractor HVACBusiness '
  +'HousePainter Locksmith MovingCompany Plumber RoofingContractor InternetCafe LegalService Attorney Notary Library LodgingBusiness '
  +'BedAndBreakfast Campground Hostel Hotel Motel Resort VacationRental MedicalBusiness MedicalClinic Optician Pharmacy Physician '
  +'ProfessionalService RadioStation RealEstateAgent RecyclingCenter SelfStorage ShoppingCenter SportsActivityLocation BowlingAlley '
  +'ExerciseGym GolfCourse PublicSwimmingPool SkiResort SportsClub StadiumOrArena TennisComplex Store TelevisionStation '
  +'TouristInformationCenter TravelAgency').split(' '));
const ORG_TYPES = /^(Organization|Corporation|NGO|OnlineBusiness|OnlineStore|NewsMediaOrganization|EducationalOrganization|MedicalOrganization|SportsOrganization|WorkersUnion|Airline|Consortium|FundingScheme|GovernmentOrganization|LibrarySystem|PerformingGroup|PoliticalParty|Project|ResearchOrganization|SearchRescueOrganization)$/;
const typesOf = n => [].concat(n && n['@type'] || []).map(t => String(t).replace(/^.*[/#]/, ''));
const isLocalType = t => LB_TYPES.has(t) || /Store$/.test(t);
// Every typed node in the page's JSON-LD (top level, @graph, and nested values), so a business nested under a
// WebPage or listed in a graph is found the same as a top-level one.
// Places the page describes rather than the business itself: venues in a Service's areaServed / containsPlace,
// places it mentions, an Event's location. A Hospital or StadiumOrArena there is a LocalBusiness subtype, but it is
// not the site's business, so the business-entity and business-name checks skip it.
const _describedPlaces=new WeakSet();
const isDescribedPlace=n=>!!n&&typeof n==='object'&&_describedPlaces.has(n);
const DESCRIBED_KEYS=new Set(['areaServed','containsPlace','containedInPlace','mentions']);
function ldNodes(doc){
  const out=[];
  const walk=(v,depth,described)=>{ if(!v||typeof v!=='object'||depth>8) return;
    if(Array.isArray(v)){ v.forEach(x=>walk(x,depth+1,described)); return; }
    if(v['@type']){ out.push(v); if(described) _describedPlaces.add(v); }
    const evt=typesOf(v).some(t=>/Event$/.test(t));
    Object.keys(v).forEach(k=>{ if(k!=='@context') walk(v[k],depth+1,described||DESCRIBED_KEYS.has(k)||(evt&&k==='location')); }); };
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(n=>{ try{ walk(JSON.parse(n.textContent),0); }catch(e){} });
  return out;
}
const hasVal = v => v!=null && !(Array.isArray(v)&&!v.length) && String(typeof v==='object'?JSON.stringify(v):v).trim()!=='' && String(v)!=='{}';
// Best LocalBusiness node and which of Google's key local fields it lacks.
function businessSchema(nodes){
  const local=nodes.filter(n=>typesOf(n).some(isLocalType));
  const org=nodes.filter(n=>typesOf(n).some(t=>ORG_TYPES.test(t)));
  const REQ=['address','telephone','openingHoursSpecification'];
  if(local.length){
    const scored=local.map(n=>({n, missing:REQ.filter(f=>!hasVal(n[f]))})).sort((a,b)=>a.missing.length-b.missing.length);
    return { kind:'local', type:typesOf(scored[0].n).find(isLocalType), missing:scored[0].missing };
  }
  if(org.length) return { kind:'org', type:typesOf(org[0]).find(t=>ORG_TYPES.test(t)), missing:REQ };
  return { kind:'none', missing:REQ };
}
// aggregateRating / review attached to the site's own business entity = "self-serving" reviews, which Google does
// not show as stars for LocalBusiness / Organization and can treat as spammy structured data.
function selfServingReview(nodes){
  const biz=nodes.filter(n=>typesOf(n).some(t=>isLocalType(t)||ORG_TYPES.test(t)));
  const ids=new Set(biz.map(n=>n['@id']).filter(Boolean));
  if(biz.some(n=>hasVal(n.aggregateRating)||hasVal(n.review))) return true;
  return nodes.some(n=>typesOf(n).some(t=>t==='AggregateRating'||t==='Review') && n.itemReviewed &&
    (typesOf(n.itemReviewed).some(t=>isLocalType(t)||ORG_TYPES.test(t)) || ids.has(n.itemReviewed['@id'])));
}

// ---------- URL status checks (canonical targets, internal links) ----------
// Batched through the server's /api/linkcheck (no redirect-following, so redirects are seen as redirects).
// Resolves to {url,status,location,noindex,challenged} or null when it could not be checked.
const _linkCache=new Map(); let _lcQueue=[], _lcTimer=null, _lcAvailable=true;
const _fetchMeta=new Map(); // page URL → {finalUrl,status} as seen by our own proxy
// "Now" for date math — a crawl can pin it (test fixtures) via opts.now.
let _nowOverride=null;
const _nowMs=()=>_nowOverride!=null?_nowOverride:Date.now();
// ---------- Industry + market (audit input) ----------
// Industry config lives in /config/industries/<name>.json (served next to this engine). "general" (or none) = no
// industry checks. The market (area codes, city list) comes from the audit input, else the industry's default.
let _industry=null, _market=null;
async function loadIndustry(name, market){
  _industry=null; _market=null;
  if(name && name!=='general'){
    try{ const res=await fetch('/config/industries/'+encodeURIComponent(String(name).toLowerCase())+'.json'); if(res.ok) _industry=await res.json(); }catch(e){}
    if(_industry){ _industry.name=_industry.industry||name;
      _industry._license=(_industry.license_patterns||[]).map(p=>{ try{ return new RegExp(p,'gi'); }catch(e){ return null; } }).filter(Boolean); }
  }
  const m=market||{};
  const dm=_industry&&_industry.default_market, codes=m.areaCodes||(_industry&&dm&&(_industry.market_area_codes||{})[dm])||null;
  _market={ name:m.name||dm||null, areaCodes:codes, cities:Array.isArray(m.cities)?m.cities:null };
  return _industry;
}
function resetLinkCache(){ _linkCache.clear(); _fetchMeta.clear(); _lcAvailable=true; _renderTried.clear(); _renderFallbacks=0; }
function checkUrl(u){
  if(_linkCache.has(u)) return _linkCache.get(u);
  const p=new Promise(res=>{ _lcQueue.push({u,res}); if(!_lcTimer) _lcTimer=setTimeout(flushLinkChecks,40); });
  _linkCache.set(u,p); return p;
}
async function flushLinkChecks(){
  _lcTimer=null;
  const batch=_lcQueue.splice(0,40); if(_lcQueue.length) _lcTimer=setTimeout(flushLinkChecks,40);
  if(!batch.length) return;
  let out=null;
  for(let attempt=0; attempt<3 && _lcAvailable && !out; attempt++){
    try{
      const res=await fetch('/api/linkcheck',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({urls:batch.map(b=>b.u)})});
      if(res.ok) out=await res.json();
      else if(res.status===404||res.status===405) _lcAvailable=false;
      else if(res.status===429) await sleep(4000*(attempt+1));
      else break;
    }catch(e){ break; }
  }
  const byUrl={}; ((out&&out.results)||[]).forEach(x=>{ byUrl[x.url]=x; });
  batch.forEach(b=>b.res(byUrl[b.u]||null));
}
const sameUrl=(a,b)=>{ try{ return new URL(a).href===new URL(b).href; }catch(e){ return a===b; } };
async function canonicalCheck(href, pageUrl, pageNoindex){
  let target; try{ target=new URL(href, pageUrl).href; }catch(e){ return {status:'fail', detail:'Canonical is not a valid URL: '+href}; }
  const self=sameUrl(target,pageUrl);
  const meta=_fetchMeta.get(pageUrl);
  if(self && meta && meta.status===200 && meta.finalUrl && sameUrl(meta.finalUrl,pageUrl))
    return pageNoindex ? {status:'fail', detail:'→ this page, which is noindex'} : {status:'pass', detail:'→ this page (200, indexable)'};
  const c=await checkUrl(target);
  if(!c||c.challenged||!c.status) return {status:'pass', detail:'→ '+target+' (target could not be verified)'};
  if(c.status>=300&&c.status<400) return {status:'fail', detail:'→ '+target+' redirects ('+c.status+(c.location?' to '+c.location:'')+')'};
  if(c.status!==200) return {status:'fail', detail:'→ '+target+' returns HTTP '+c.status};
  if(c.noindex) return {status:'fail', detail:'→ '+target+', which is noindex'};
  return {status:'pass', detail:'→ '+(self?'this page (200, indexable)':target+' (200, indexable)')};
}

// ---------- Page type ----------
// home | service | location | blog | utility | archive | hub | other — from the URL first (most reliable), since
// titles on local sites name the service AND the city on nearly every page.
const US_STATES='al|ak|az|ar|ca|co|ct|de|fl|ga|ia|id|il|ks|ky|la|ma|md|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy'
  +'|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|idaho|illinois|indiana|iowa|kansas|kentucky'
  +'|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new-hampshire|new-jersey'
  +'|new-mexico|new-york|north-carolina|north-dakota|ohio|oklahoma|oregon|pennsylvania|rhode-island|south-carolina|south-dakota|tennessee'
  +'|texas|utah|vermont|virginia|washington|west-virginia|wisconsin|wyoming';
const RE_UTILITY=/^(contact(-us)?|privacy(-policy)?|privacy-notice|terms.*|legal|disclaimer|cookies?(-policy)?|accessibility(-statement)?|(get-a-|free-|request-a-|request-|get-)?quotes?|estimate|pay|payments?|pay-now|pay-online|make-a-payment|thank-?you.*|login|log-in|sign-?in|account|my-account|cart|checkout|sitemap|404|search)$/;
const RE_LOC_DIR=/^(service-?areas?|areas?(-we-serve|-served)?|locations?|cities|city|communities|towns?|neighborhoods?|counties|county|near-?me|where-we-serve)$/;
const RE_SVC_DIR=/^(services?|our-services|what-we-do|solutions|specialties)$/;
const RE_BLOG_DIR=/^(blog|news|articles?|posts?|insights|resources|tips|learn|guides?)$/;
const RE_SVC_WORD=/(tow|repair|roadside|recovery|lockout|jump-?start|battery|fuel|tire|winch|impound|repo|brake|transmission|oil-change|lube|inspection|exhaust|muffler|suspension|alignment|diagnos|engine|electrical|hvac|heating|cooling|air-condition|plumb|drain|roof|gutter|siding|clean|detail|collision|body-?shop|paint|glass|windshield|install|replace|maintenance|tune-?up|mechanic|auction|fleet|flatbed|wheel-lift|haul|moving|junk|removal|landscap|lawn|pest|electric|remodel|construction|pressure-wash|locksmith|garage-door|fence|concrete|paving|service)/;
const RE_STATE_SLUG=new RegExp('-('+US_STATES+')$');
function pathSegs(u){ try{ return new URL(u).pathname.toLowerCase().split('/').filter(Boolean).map(s=>{ try{ return decodeURIComponent(s); }catch(e){ return s; } }); }catch(e){ return []; } }
// "<service>-in-<city>[-st]" slugs ("towing-in-grove-city-ohio"): the service words and the city.
const RE_SLUG_STOP=/^(and|the|for|with|near|in|of|a|to|service|services|our|page|best|local|24|hour|7)$/;
function slugParts(u){
  const segs=pathSegs(u), last=(segs[segs.length-1]||'').replace(/\.(html?|php|aspx?)$/,'').replace(RE_STATE_SLUG,'');
  const m=last.match(/^(.+?)-in-(.+)$/);
  return m?{ service:m[1].split('-').filter(w=>w.length>=3&&!RE_SLUG_STOP.test(w)), city:m[2].replace(/-/g,' ') }:null;
}
const normPlace=s=>String(s||'').toLowerCase().replace(/&amp;/g,'&').replace(/[^a-z0-9]+/g,' ').trim();
// The business's own city from its schema address (LocalBusiness / Organization addressLocality).
function schemaCity(nodes){
  for(const n of (nodes||[])){ if(!typesOf(n).some(t=>isLocalType(t)||ORG_TYPES.test(t))) continue;
    const a=[].concat(n.address||[]).find(x=>x&&typeof x==='object'&&x.addressLocality); if(a) return String(a.addressLocality); }
  return null;
}
// ctx (optional): { primaryCity, h1 }. A "<service>-in-<city>" page is a SERVICE page when <city> is the business's
// own city; it is a LOCATION page only when the city differs AND the page is city-led (H1 starts with the city).
function classifyPage(u, nodes, ctx){
  const segs=pathSegs(u);
  if(!segs.length) return 'home';
  const last=segs[segs.length-1].replace(/\.(html?|php|aspx?)$/,'');
  if(segs.some(s=>RE_UTILITY.test(s))) return 'utility';
  if(segs.some(s=>/^(category|categories|tag|tags|author|archives?)$/.test(s)) || segs.includes('page') || segs.every(s=>/^\d+$/.test(s))) return 'archive';
  if(segs.length===1 && RE_BLOG_DIR.test(segs[0])) return 'archive';          // the blog index is a listing
  if((segs.length>=2 && RE_BLOG_DIR.test(segs[0])) || /^\d{4}$/.test(segs[0])) return 'blog';
  // A blog post: BlogPosting / NewsArticle schema, or "Article" schema on a WordPress post (body class single-post) -
  // SEO plugins also put "Article" on ordinary pages (broadandjames.com /services/), so Article alone is not enough.
  // A "<service>-in-<city>" slug stays a money page even as a post (capitaltowing.com publishes those as posts).
  const types=(nodes||[]).flatMap(typesOf);
  if(!slugParts(u) && (types.some(t=>t==='BlogPosting'||t==='NewsArticle') || (ctx&&ctx.wpPost&&types.includes('Article')))) return 'blog';
  if(segs.some((s,i)=>RE_LOC_DIR.test(s) && i<segs.length-1)) return 'location';
  if(segs.length===1 && RE_LOC_DIR.test(segs[0])) return 'hub';               // "all our service areas" page
  const sp=slugParts(u);
  if(sp){ const city=normPlace(sp.city), primary=normPlace(ctx&&ctx.primaryCity), h1=normPlace(ctx&&ctx.h1);
    if(primary && city===primary) return 'service';
    return (h1 && (h1===city || h1.indexOf(city+' ')===0)) ? 'location' : 'service'; }
  if(RE_STATE_SLUG.test(last) && last.split('-').length>=2) return 'location';   // /towing-dublin-oh
  if(segs.some((s,i)=>RE_SVC_DIR.test(s) && i<segs.length-1)) return 'service';
  if(RE_SVC_DIR.test(last) || RE_SVC_WORD.test(last)) return 'service';
  return 'other';
}

// ---------- Main content ----------
// The page's own content: <main>/<article> when it holds most of the text, else the body — either way without
// header / nav / footer / aside and their builder look-alikes. Returned as text blocks (one per block element).
const BLOCK_TAGS=new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TBODY','THEAD','TFOOT','TR','TD','TH','UL','BR','DETAILS','SUMMARY']);
const SKIP_TEXT_TAGS=new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','svg','IFRAME']);
const RE_CHROME=/(^|[\s_-])(site[-_]?header|site[-_]?footer|masthead|colophon|navbar|nav|navigation|main-?menu|mobile-?menu|menu|sidebar|widget-?area|cookie[\w-]*|breadcrumbs?|top-?bar|skip-?link|location-header|location-footer)($|[\s_])/i;
const countWords=t=>(String(t).match(/[A-Za-z0-9][A-Za-z0-9'’&.-]*/g)||[]).length;
function textBlocks(root){
  const out=[]; let buf=[];
  const flush=()=>{ const t=buf.join(' ').replace(/\s+/g,' ').trim(); buf=[]; if(t) out.push(t); };
  const walk=n=>{ for(let c=n.firstChild;c;c=c.nextSibling){
    if(c.nodeType===3) buf.push(c.nodeValue);
    else if(c.nodeType===1){ if(SKIP_TEXT_TAGS.has(c.tagName)) continue; if(BLOCK_TAGS.has(c.tagName)){ flush(); walk(c); flush(); } else walk(c); } } };
  walk(root); flush();
  return out;
}
function mainContent(doc){
  if(!doc.body) return [];
  const clone=doc.body.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,template,svg,iframe,form,button,select,nav,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[aria-hidden="true"],[hidden]').forEach(e=>e.remove());
  clone.querySelectorAll('header,footer').forEach(e=>{ if(!e.closest('main,article')) e.remove(); });
  const total=countWords(clone.textContent);
  clone.querySelectorAll('[id],[class]').forEach(e=>{
    if(!e.isConnected || e.matches('main,article') || e.querySelector('main,article')) return;
    const tag=(e.getAttribute('id')||'')+' '+(typeof e.className==='string'?e.className:'');
    if(RE_CHROME.test(tag) && countWords(e.textContent)<total*0.5) e.remove();
  });
  const words=countWords(clone.textContent);
  const arts=[...clone.querySelectorAll('article')].sort((a,b)=>countWords(b.textContent)-countWords(a.textContent));
  const cand=clone.querySelector('main')||arts[0]||null;
  const root=(cand && countWords(cand.textContent)>=words*0.5) ? cand : clone;
  return textBlocks(root);
}
// 32-bit FNV-1a — block and shingle fingerprints
function fnv(s){ let h=0x811c9dc5; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193); } return h>>>0; }
const normBlock=t=>String(t).toLowerCase().replace(/\s+/g,' ').trim();
function shingles(text){
  const w=String(text).toLowerCase().match(/[a-z0-9]+/g)||[]; const set=new Set();
  for(let i=0;i+5<=w.length;i++) set.add(fnv(w.slice(i,i+5).join(' ')));
  return set;
}
function jaccard(a,b){
  if(!a.size||!b.size) return 0;
  const [s,l]=a.size<b.size?[a,b]:[b,a]; let inter=0;
  s.forEach(x=>{ if(l.has(x)) inter++; });
  return inter/(a.size+b.size-inter);
}

// ---------- Local detail (location pages) ----------
// Named roads, routes, exits and landmarks — the specifics that prove a location page is about that place.
const RE_ENT_STOP=/^(The|A|An|Our|Your|We|This|That|Any|Every|Best|Fast|Top|Call|Contact|Customer|Service|Services|Help|Auto|Towing|Tow|Emergency|Main|New|Get|Free|Local|Near|All|Why|How|What|When)\b/;
const RE_ENT_GENERIC=/\b(Service|Services|Repair|Towing|Tow|Auto|Care|Business|Call|Help|Contact|Customer|Dispatch|Our|Your)\b/;
const RE_ENTITIES=[
  /\b((?:[A-Z][A-Za-z'.-]+ ){1,3}(?:Road|Rd|Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Parkway|Pkwy|Highway|Hwy|Pike|Trail|Expressway|Freeway|Turnpike|Bypass|Circle|Court|Ct|Place|Pl|Square|Plaza|Crossing|Corridor))\b\.?/g,
  /\b((?:I|Interstate)[- ]?\d{1,3})\b/g,
  /\b((?:US|U\.S\.|SR|State Route|Route|Rt\.?|County Road|CR|OH|Ohio)[- ]?\d{1,4})\b/g,
  /\b(Exit \d{1,3}[A-Z]?)\b/g,
  /\b((?:[A-Z][A-Za-z'.&-]+ ){1,4}(?:Park|Mall|Center|Centre|Stadium|Arena|Airport|Hospital|University|College|High School|Church|Lake|River|Creek|Bridge|Market|Library|Zoo|Museum|Hall|Field|Station|Commons|Outlets|Festival|Fairgrounds|Reservoir|District|Campus|Speedway|Terminal))\b/g,
];
function localEntities(text){
  const found=new Set();
  RE_ENTITIES.forEach(re=>{ re.lastIndex=0; let m; while((m=re.exec(text))){
    // Drop a sentence end caught in front ("Yes. Polaris Fashion Place"); keep "E. Main St" / "St. Clair Ave".
    const e=m[1].trim().replace(/^(?:(?!(?:St|Mt|Ft|Pt)\.)[A-Za-z]{2,}[.!?]\s+)+/,'')
      .replace(/^(?:(?:Serving|Near|Around|At|From|To|Of|On|In|And|With|By|Including|Covering|Past|Behind|Off|Along|Across|Via)\s+)+/,''); // "Serving Capital University" = "Capital University"
    if(!e || RE_ENT_STOP.test(e) || RE_ENT_GENERIC.test(e)) continue;
    // One spelling per place: "E. Main Street" = "E Main St".
    found.add(e.toLowerCase().replace(/\binterstate[- ]?/,'i-').replace(/^i[- ]?(\d)/,'i-$1').replace(/\./g,'').replace(/\s+/g,' ').trim()
      .split(' ').map(w=>STREET_ABBR[w]||w).join(' '));
  } });
  return [...found];
}
// Content checks, shared by the single-page audit and the crawl (which re-runs them with cross-page knowledge).
const CONTENT_FULL={ blog:800 };
function uniqueContentCheck(type, words, strippedAcrossSite){
  const why='Search engines and AI rank the words that are unique to this page — not the header, menus, footer and other text repeated on every page. Pages without enough of their own content rarely rank.';
  if(type==='utility'||type==='archive') return {label:'Unique content',points:0,status:'na',detail:'Exempt ('+type+' page) · '+words+' unique words',why,fix:''};
  const full=CONTENT_FULL[type]||500, frac=Math.max(0,Math.min(1,(words-100)/(full-100)));
  // Severity by words, not points: critical under 150, high under 300, medium under 500 (blog: low up to 800).
  const sev=frac>=1?null:words<150?'Critical':words<300?'High':words<500?'Medium':'Low';
  return {label:'Unique content',points:25,frac,sev,status:frac>=1?'pass':words<150?'fail':'warn',
    detail:words+' words unique to this page (full credit at '+full+'+'+(strippedAcrossSite?', site-wide boilerplate removed)':', header/nav/footer removed)'),
    why, fix:'Add genuinely useful, page-specific content — what the service involves, pricing factors, the areas and roads you cover, FAQs — aiming for '+full+'+ words that are not repeated on other pages.'};
}
function localDetailCheck(ents, compared){
  const n=ents.length, frac=Math.min(1,n/12);
  return {label:'Local detail',points:10,frac,status:frac>=1?'pass':n===0?'fail':'warn',
    detail:n+' named road'+(n===1?'':'s')+'/routes/exits/landmarks'+(compared?' unique to this page':'')+(n?': '+ents.slice(0,8).join(', ')+(n>8?'…':''):''),
    why:'A location page earns its place by proving local knowledge: the roads, highway exits and landmarks of that town. Pages that just swap the city name into the same template look like doorway pages to Google.',
    fix:'Name the specific roads, highway exits, landmarks and neighborhoods you serve in this town (12+), in real sentences — not a copy of another city page.'};
}

// ---------- Links and dates (for the crawl's link-health and freshness scores) ----------
const siteKey=h=>String(h||'').toLowerCase().replace(/^www\./,'');
const RE_ASSET=/\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|pdf|zip|rar|docx?|xlsx?|pptx?|mp3|mp4|mov|webm|woff2?|ttf|eot)$/i;
const RE_SKIP_PATH=/^\/(wp-admin|wp-json|wp-login|xmlrpc|cdn-cgi|feed|comments\/feed|api)(\/|$)|\/feed\/?$|\/amp\/?$/i;
// Same-site <a href> targets (www and bare host count as the same site), without #fragments. Links carrying a query
// string (filters, tracking, calendars) are not treated as pages.
function internalLinks(doc, pageUrl){ return [...new Set(anchorDetails(doc, pageUrl).map(a=>a.url))]; }
// Every same-site <a>: target, visible anchor text and rel=nofollow — for inlink counts, anchor texts, generic
// anchors and internal nofollow findings.
function anchorDetails(doc, pageUrl){
  let base; try{ base=new URL(pageUrl); }catch(e){ return []; }
  const out=[];
  doc.querySelectorAll('a[href]').forEach(a=>{
    const h=(a.getAttribute('href')||'').trim();
    if(!h||/^(#|mailto:|tel:|sms:|javascript:|data:)/i.test(h)) return;
    let u; try{ u=new URL(h, base); }catch(e){ return; }
    if(!/^https?:$/.test(u.protocol) || siteKey(u.hostname)!==siteKey(base.hostname)) return;
    u.hash=''; if(u.search) return;
    if(RE_ASSET.test(u.pathname) || RE_SKIP_PATH.test(u.pathname)) return;
    const text=(a.textContent||a.getAttribute('aria-label')||(a.querySelector('img')&&a.querySelector('img').getAttribute('alt'))||'').replace(/\s+/g,' ').trim().slice(0,80);
    out.push({ url:u.href, text, nofollow:/\bnofollow\b/i.test(a.getAttribute('rel')||''), href:h });
  });
  return out;
}
// Newest publish / modify dates the page states (JSON-LD, article meta, a /YYYY/MM/DD/ URL). ISO strings or null.
function pageDates(doc, nodes, url, nowMs){
  const ok=d=>{ const t=Date.parse(d); return !isNaN(t) && t>Date.UTC(1995,0,1) && t<nowMs+2*864e5 ? t : null; };
  const pub=[], mod=[];
  nodes.forEach(n=>{ if(n.datePublished) pub.push(ok(n.datePublished)); if(n.dateModified) mod.push(ok(n.dateModified)); });
  const meta=p=>{ const m=doc.querySelector('meta[property="'+p+'"],meta[name="'+p+'"]'); return m?m.getAttribute('content'):null; };
  pub.push(ok(meta('article:published_time'))); mod.push(ok(meta('article:modified_time')), ok(meta('og:updated_time')));
  const m=String(url).match(/\/((?:19|20)\d{2})\/(\d{2})(?:\/(\d{2}))?\//);
  if(m) pub.push(ok(m[1]+'-'+m[2]+'-'+(m[3]||'01')+'T00:00:00Z'));
  const max=a=>{ const v=a.filter(x=>x!=null); return v.length?new Date(Math.max(...v)).toISOString():null; };
  return { published:max(pub), modified:max(mod) };
}

// ---------- Site-wide consistency signals (per page; compared across pages in the crawl) ----------
const RE_PHONE=/(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/g;
const RE_STREET=/\b(\d{2,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][A-Za-z0-9'.-]*\s+){1,4}(?:Road|Rd|Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Parkway|Pkwy|Highway|Hwy|Pike|Pk|Way|Court|Ct|Circle|Cir|Place|Pl))\b\.?/g;
const STREET_ABBR={road:'rd',street:'st',avenue:'ave',boulevard:'blvd',drive:'dr',lane:'ln',parkway:'pkwy',highway:'hwy',pike:'pike',pk:'pike',court:'ct',circle:'cir',place:'pl',north:'n',south:'s',east:'e',west:'w'};
const normStreet=a=>String(a).toLowerCase().replace(/[.,]/g,'').replace(/\s+/g,' ').trim().split(' ').map(w=>STREET_ABBR[w]||w).join(' ');
// How close (characters of page text) a street must sit to a phone number to count as an address block.
const NAP_NEAR=300;
const normPhone=(a,b,c)=>'('+a+') '+b+'-'+c;
// JSON-LD written by some CMSs carries HTML entities ("Broad &amp; James").
const decodeEntities=s=>String(s).replace(/&(amp|quot|apos|lt|gt|#0?39|#x27);/gi,(m,e)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>','#039':"'",'#39':"'",'#x27':"'"})[e.toLowerCase()]||m);
function napSignals(doc, bodyText, nodes){
  const tel=[], visible=[], streets=[];
  doc.querySelectorAll('a[href^="tel:"]').forEach(a=>{ const d=(a.getAttribute('href')||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,''); if(d.length===10) tel.push(normPhone(d.slice(0,3),d.slice(3,6),d.slice(6))); });
  let m; const phoneAt=[]; RE_PHONE.lastIndex=0; while((m=RE_PHONE.exec(bodyText))){ const ph=normPhone(m[1],m[2],m[3]); visible.push(ph); phoneAt.push({ i:m.index, ph }); }
  // napStreets: "street@phone" for each street written next to a phone number (an address block), as opposed to a
  // venue's address in prose. napIssues keeps only the ones next to the business's own phone.
  const napStreets=[]; RE_STREET.lastIndex=0;
  while((m=RE_STREET.exec(bodyText))){ const s=normStreet(m[1]); streets.push(s); phoneAt.filter(p=>Math.abs(p.i-m.index)<=NAP_NEAR).forEach(p=>napStreets.push(s+'@'+p.ph)); }
  // Addresses of places the page describes (a stadium, a campus) in schema — never the business's own.
  const placeStreets=[]; nodes.filter(isDescribedPlace).forEach(n=>[].concat(n.address||[]).forEach(a=>{ if(a&&typeof a==='object'&&a.streetAddress) placeStreets.push(normStreet(a.streetAddress)); }));
  const biz=nodes.filter(n=>!isDescribedPlace(n)&&typesOf(n).some(t=>isLocalType(t)||ORG_TYPES.test(t)));
  const schema={ names:[], phones:[], streets:[] };
  biz.forEach(n=>{
    if(typeof n.name==='string') schema.names.push(decodeEntities(n.name).trim());
    if(n.telephone){ const d=String(n.telephone).replace(/\D/g,'').replace(/^1(?=\d{10}$)/,''); if(d.length===10) schema.phones.push(normPhone(d.slice(0,3),d.slice(3,6),d.slice(6))); }
    const ad=n.address; [].concat(ad||[]).forEach(a=>{ if(a&&typeof a==='object'&&a.streetAddress) schema.streets.push(normStreet(a.streetAddress)); });
  });
  const uniq=a=>[...new Set(a)];
  return { tel:uniq(tel), visible:uniq(visible), streets:uniq(streets), napStreets:uniq(napStreets), placeStreets:uniq(placeStreets), schema:{ names:uniq(schema.names), phones:uniq(schema.phones), streets:uniq(schema.streets) } };
}
// Hard-coded counts ("all 34 service areas", "18 towing services") — checked against the pages the crawl finds.
// A number glued to "/", "-" or another number is part of something else: "24/7 Towing Services" is not 7 services.
const RE_AREA_CLAIM=/\b([Aa]ll|[Oo]ver|[Mm]ore than|[Ss]erving|[Aa]cross|[Oo]ur)?\s*\b(?<![\/\d.,-])(\d{1,3})(\+)?\s+((?:(?:[A-Z][a-z]+|local|nearby|surrounding|different|major)\s+){0,3})([Cc]ities|[Tt]owns|[Ll]ocations|[Cc]ommunities|[Cc]ounties|[Ss]uburbs|[Nn]eighborhoods|[Ss]ervice [Aa]reas|[Aa]reas)\b/g;
const RE_SERVICE_CLAIM=/\b([Aa]ll|[Oo]ver|[Mm]ore than|[Oo]ffer|[Pp]rovide|[Oo]ur)?\s*\b(?<![\/\d.,-])(\d{1,3})(\+)?\s+((?:(?:[A-Z][a-z]+|towing|repair|roadside|auto|different|specialized|professional|core)\s+){0,2})([Ss]ervices)\b/g;
function countClaims(text){
  const out=[];
  [[RE_AREA_CLAIM,'location'],[RE_SERVICE_CLAIM,'service']].forEach(([re,kind])=>{ re.lastIndex=0; let m;
    while((m=re.exec(text))){ const n=+m[2]; if(n<3) continue;
      const q=(m[1]||'').toLowerCase(); out.push({ kind, n, atLeast:!!m[3]||q==='over'||q==='more than', text:m[0].trim().replace(/\s+/g,' ') }); } });
  return out;
}
// H1 words glued together in the raw text: "<span>Towing</span><span>Columbus</span>" reads as "TowingColumbus" to
// any crawler that takes the text as-is (most AI crawlers). Returns the glued sample or null.
function h1Glued(h1){
  if(!h1) return null;
  const parts=[]; const walk=n=>{ for(let c=n.firstChild;c;c=c.nextSibling){ if(c.nodeType===3){ if(c.nodeValue) parts.push({t:c.nodeValue,p:c.parentNode}); } else if(c.nodeType===1){ if(c.tagName==='BR') parts.push({br:true}); else walk(c); } } };
  walk(h1);
  for(let i=1;i<parts.length;i++){
    let j=i-1, br=false; while(j>=0&&parts[j].br){ br=true; j--; } if(j<0||parts[i].br) continue;
    const a=parts[j], b=parts[i];
    if((br||a.p!==b.p) && /[a-z0-9.,!?:)]$/.test(a.t) && /^[A-Z0-9(]/.test(b.t)) return (a.t.trim().split(/\s+/).pop()||'')+(b.t.trim().split(/\s+/)[0]||'');
  }
  return null;
}
// Links labelled "Text us" / "SMS" that actually dial (tel:) — tapping them starts a call, not a text.
function smsLabelTelLinks(doc){
  return [...doc.querySelectorAll('a[href^="tel:"]')].map(a=>(a.textContent||a.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim())
    .filter(t=>/\b(sms|txt|text(ing)?)\b/i.test(t)).slice(0,5);
}

// Pages where noindex is a deliberate choice, not a mistake.
const RE_INTENTIONAL_NOINDEX=/(^|\/)(privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|legal|disclaimer|cookies?|careers?|jobs?|employment|apply|application|job-application|employment-application|feedback|survey|review-us|thank-?you|thanks|confirmation|login|account|cart|checkout|search)(\/|-|$)|\/page\/\d+\/?$/i;
function intentionalNoindex(u, type){ if(type==='archive') return true; let p=''; try{ p=new URL(u).pathname.toLowerCase(); }catch(e){ p=String(u); } return RE_INTENTIONAL_NOINDEX.test(p); }
// Flat penalties (taken off the page's final score) for the misses that make everything else moot.
const GATES={ 'Served over HTTPS':20, 'Title tag present':10 };
function applyGates(r){
  (r.checks||[]).forEach(c=>{
    delete c.penalty;
    if(c.status!=='fail') return;
    if(c.label==='Page is indexable' && (r.pageType==='service'||r.pageType==='location')) c.penalty=20; // a money page hidden from Google
    else if(GATES[c.label]) c.penalty=GATES[c.label];
  });
}

async function auditOne(raw, prefetchedHtml){
  let url=raw.trim();
  if(!/^https?:\/\//i.test(url)) url='https://'+url;
  const o=new URL(url); const origin=o.origin;
  const _t0=Date.now();
  const html=(prefetchedHtml!=null)?prefetchedHtml:await fetchHtml(url);
  const loadMs=(prefetchedHtml!=null)?null:(Date.now()-_t0); // server response time (measured during fetch)
  const doc=new DOMParser().parseFromString(html,'text/html');

  // guards
  const bodyText=(doc.body?.textContent||'').trim();
  // JS-rendered shell detection: scripts / SPA markers but almost no readable text = client-side-rendered content
  // that crawlers & AI answer engines can't see. Flag it as a finding, don't fail the audit.
  const _scriptCount=doc.querySelectorAll('script').length;
  const _hasBundle=/<script[^>]+\bsrc=/i.test(html);
  const _spaRoot=/id=["'](root|app|__next|__nuxt|__gatsby|q-app|svelte)["']|data-reactroot|__NEXT_DATA__|window\.__NUXT__|ng-version|data-server-rendered/i.test(html);
  const jsShell = bodyText.length<200 && html.length>=500 && (_hasBundle||_spaRoot||_scriptCount>=2);
  if((html.length<500||bodyText.length<30) && !jsShell) throw {blocked:true,reason:'Empty or near-empty response — the real page could not be retrieved (proxy or site issue). Try again.'};
  // A page title is a <title> outside <svg> (an inline icon's <title> is its tooltip, not the page's title).
  const pageTitles=[...doc.querySelectorAll('title')].filter(t=>!t.closest('svg'));
  const tLow=((pageTitles[0]||{}).textContent||'').trim().toLowerCase();
  const cTitles=['just a moment','one moment','attention required','checking your browser','please wait','verifying you are human','ddos-guard'];
  // Cloudflare injects "/cdn-cgi/challenge-platform/" into NORMAL 200 pages, so that substring is NOT a block signal.
  // Gate strong markers behind an interstitial-sized body so real pages embedding a Turnstile widget aren't flagged.
  const cSigs=['cf-browser-verification','__cf_chl','cf_chl_opt','_imperva_','distil_r_captcha','challenges.cloudflare.com/turnstile'];
  const interstitial = bodyText.length < 1500;
  if(cTitles.some(t=>tLow.includes(t)) || (interstitial && cSigs.some(s=>html.includes(s)))) throw {blocked:true,reason:'Blocked by bot protection (a Cloudflare / DDoS-Guard style challenge page was returned, not the site).'};

  const checks=[];
  const add=(cat,label,points,status,detail,why,fix)=>checks.push({cat,label,points,status,detail,why,fix});

  // ---- gather ----
  const titleEl=pageTitles[0]||null;
  const title=(titleEl?.textContent||'').trim();
  const titleCount=pageTitles.length;
  const desc=(doc.querySelector('meta[name="description"]')?.getAttribute('content')||'').trim();
  const h1=doc.querySelectorAll('h1'); const h2=doc.querySelectorAll('h2');
  const robotsMeta=[...doc.querySelectorAll('meta[name="robots" i],meta[name="googlebot" i]')].map(m=>m.getAttribute('content')||'').join(',').toLowerCase();
  const noindex=robotsMeta.includes('noindex');
  const canonical=doc.querySelector('link[rel="canonical"]');
  const viewport=doc.querySelector('meta[name="viewport"]');
  const charset=doc.querySelector('meta[charset]')||doc.querySelector('meta[http-equiv="Content-Type" i]');
  const lang=doc.documentElement.getAttribute('lang');
  const favicon=doc.querySelector('link[rel~="icon"]');
  const ogT=doc.querySelector('meta[property="og:title"]'), ogD=doc.querySelector('meta[property="og:description"]'), ogI=doc.querySelector('meta[property="og:image"]');
  const ogCount=[ogT,ogD,ogI].filter(Boolean).length;
  const twCard=doc.querySelector('meta[name="twitter:card"]');
  const imgs=[...doc.querySelectorAll('img')];
  const withAlt=imgs.filter(i=>(i.getAttribute('alt')||'').trim()).length;
  const withDim=imgs.filter(i=>i.getAttribute('width')&&i.getAttribute('height')).length;
  const words=bodyText.split(/\s+/).filter(Boolean).length;
  const tel=doc.querySelectorAll('a[href^="tel:"]').length;
  const hasMap=/google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl|maps\.apple\.com|bing\.com\/maps/i.test(html) || [...doc.querySelectorAll('a')].some(a=>/\b(get )?directions\b/i.test(a.textContent||''));
  const ssl=url.startsWith('https');
  const mixed= ssl ? [...doc.querySelectorAll('[src],[href]')].filter(el=>/^http:\/\//i.test(el.getAttribute('src')||el.getAttribute('href')||'')).length : 0;
  const blocking=doc.querySelectorAll('head script[src]:not([async]):not([defer])').length;
  const sizeKb=Math.round(html.length/1024);
  // schema
  let schemaTypes=[];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(n=>{try{const j=JSON.parse(n.textContent);const arr=Array.isArray(j)?j:[j];arr.forEach(x=>{const t=x['@type'];if(t)schemaTypes=schemaTypes.concat(Array.isArray(t)?t:[t]);if(x['@graph'])x['@graph'].forEach(g=>{if(g['@type'])schemaTypes=schemaTypes.concat(g['@type'])})});}catch(e){}});
  if(doc.querySelector('[itemtype]')) schemaTypes.push((doc.querySelector('[itemtype]').getAttribute('itemtype')||'').split('/').pop());
  schemaTypes=[...new Set(schemaTypes.filter(Boolean))];
  const schemaStr=schemaTypes.join(' ');
  const ld=ldNodes(doc);
  const biz=businessSchema(ld);
  const selfReview=selfServingReview(ld);
  const primaryCity=schemaCity(ld);
  const pageType=classifyPage(url, ld, { primaryCity, h1:(h1[0]&&h1[0].textContent||'').trim(), wpPost:/(^|\s)single-post(\s|$)/.test((doc.body&&doc.body.getAttribute('class'))||'') });
  const blocks=mainContent(doc);
  const mainText=blocks.join('\n');
  const mainWords=countWords(mainText);
  const entities=pageType==='location'?localEntities(mainText):[];
  const anchors=anchorDetails(doc, url);
  const links=[...new Set(anchors.map(a=>a.url))];
  const bytes=(typeof TextEncoder!=='undefined')?new TextEncoder().encode(html).length:html.length;
  const dates=pageDates(doc, ld, url, _nowMs());
  const pageText=doc.body?textBlocks(doc.body).join('\n'):''; // whole page incl. header/footer (NAP, claims live there)
  const nap=napSignals(doc, pageText, ld);
  const yClaims=yearClaims(pageText); yClaims.founded.forEach(f=>{ f.url=url; });
  const claims=countClaims(mainText);
  const h1Glue=h1Glued(h1[0]);
  const smsTel=smsLabelTelLinks(doc);
  // AI-search / rich-result signals
  const hasFaq = /FAQPage|QAPage|Question/i.test(schemaStr) || /"@type"\s*:\s*"(FAQPage|QAPage|Question)"/i.test(html);
  const hasOrg = schemaTypes.some(t=>/Organization|LocalBusiness|AutoRepair|AutomotiveBusiness|Store|ProfessionalService|HomeAndConstructionBusiness|EmergencyService/i.test(t));
  const hasSameAs = /"sameAs"/i.test(html);
  const hasReview = /AggregateRating|"@type"\s*:\s*"Review"|"reviewRating"|"ratingValue"/i.test(html);
  const hasMain = !!(doc.querySelector('main')||doc.querySelector('article'));
  // tracking (informational)
  const tracking=Object.keys(TAGS).filter(name=>TAGS[name].some(s=>html.includes(s)));

  // ---- CHECKS ----
  const INDEX='Indexability & Crawlability', CONTENT='On-Page Content', TECH='Technical & Mobile', LOCAL='Local SEO', SOCIAL='Social Sharing', MEDIA='Images & Accessibility', PERF='Performance Hygiene';

  // Presence checks are gates: few points for having them; applyGates() adds a flat penalty for the misses that
  // sink a page outright.
  // Pages that are noindexed on purpose — archives, pagination, privacy/terms, careers/application forms, feedback —
  // get no "remove noindex" finding and no canonical check (and leave the page average).
  const archiveNoindex=noindex&&intentionalNoindex(url, pageType);
  add(INDEX,'Page is indexable',4, archiveNoindex?'na':noindex?'fail':'pass',
    archiveNoindex?'N/A — '+pageType+' page, noindex is intentional':noindex?'A "noindex" directive is present':'No noindex directive',
    'A "noindex" tag is a stop sign telling Google to hide this page completely. If it is there by mistake, nothing else you do matters — you are invisible in search.',
    'Remove the "noindex" value from the robots meta tag so search engines can list the page.');
  const canon=archiveNoindex?{status:'na',detail:'N/A — intentionally noindexed page'}:canonical?await canonicalCheck(canonical.getAttribute('href')||'', url, noindex):{status:'fail',detail:'No canonical link'};
  add(INDEX,'Canonical URL set',6, canon.status, canon.detail,
    'This tells Google which version of your web address is the real one, so your ranking power is not split between www / non-www or trailing-slash duplicates. A canonical that points at a redirect, an error page or a noindex page tells Google to index nothing.',
    canonical?'Point the canonical at the final, indexable URL of this page (the address that returns 200 with no redirect and no noindex).'
             :'Add <link rel="canonical" href="'+esc(origin)+'/"> in the page head pointing to the preferred URL.');

  add(CONTENT,'Title tag present',3, title?'pass':'fail',
    title?('"'+title+'"'):'Missing',
    'Your title is the blue headline people click in Google. It is the single strongest thing on the page for both ranking and earning the click.',
    'Add a unique <title> of about 50–60 characters that names the business and primary service + city.');
  if(title){
    const tl=title.length;
    add(CONTENT,'Title length optimal',4, (tl>=30&&tl<=60)?'pass':'warn',
      tl+' characters',
      'Titles under ~30 characters waste the opportunity; over ~60 get chopped off mid-sentence in results.',
      'Aim for 50–60 characters, e.g. "Auto Repair in Hilliard, OH | Shop Name".');
    if(titleCount>1) add(CONTENT,'Single title tag',2,'warn',titleCount+' title tags found','More than one title confuses search engines about which one to show.','Keep exactly one <title> tag.');
  }
  add(CONTENT,'Meta description present',2, desc?'pass':'fail',
    desc?('"'+desc.slice(0,90)+(desc.length>90?'…':'')+'"'):'Missing',
    'This is the grey summary under your title in Google. It does not change ranking, but a good one convinces people to click you instead of a competitor.',
    'Write a compelling 120–155 character summary with the service, location, and a reason to click (e.g. "Call now").');
  if(desc) add(CONTENT,'Description length optimal',3,(desc.length>=80&&desc.length<=160)?'pass':'warn',desc.length+' characters','Too short under-sells you; over ~160 characters gets cut off.','Target 120–155 characters.');
  add(CONTENT,'Exactly one H1 heading',8, h1.length===1?'pass':'fail',
    h1.length+' H1 tag(s)',
    'The H1 is the big headline on the page. None means Google cannot tell what the page is about; several muddy the signal and can look spammy.',
    h1.length===0?'Add a single visible <h1> with your main service + city.':'Keep one <h1> and demote the others to <h2>.');
  add(CONTENT,'Uses subheadings (H2)',3, h2.length>0?'pass':'warn',h2.length+' H2 tag(s)','Subheadings make the page easy to skim for customers and easy to understand for search engines and AI.','Break content into sections with descriptive H2 headings.');
  checks.push(Object.assign({cat:CONTENT}, uniqueContentCheck(pageType, mainWords, false)));
  checks.push({cat:CONTENT,label:'Unique vs sibling pages',points:0,status:'na',detail:'Compared against the site\'s other pages in a whole-site crawl',why:'',fix:''});
  if(pageType==='location') checks.push(Object.assign({cat:LOCAL}, localDetailCheck(entities, false)));

  add(TECH,'Served over HTTPS',3, ssl?'pass':'fail', ssl?'Secure':'Not secure','The padlock in the browser bar. Google ranks secure sites higher and browsers scare visitors away from sites without it.','Install an SSL certificate (free via Let\'s Encrypt or your host) and force HTTPS.');
  add(TECH,'Mobile viewport set',2, viewport?'pass':'fail', viewport?'Configured':'Missing','Without this the site looks broken on phones — and Google judges your site by its phone version first.','Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  add(TECH,'No mixed (insecure) content',4, mixed===0?'pass':'warn', mixed===0?'Clean':(mixed+' http:// resources'),'Insecure files on a secure page trigger browser warnings and can stop images or features from loading.','Update http:// links for images/scripts/styles to https://.');
  add(TECH,'Character encoding declared',2, charset?'pass':'warn', charset?'Declared':'Missing','Prevents letters and symbols from showing up as garbled characters.','Add <meta charset="UTF-8"> as the first head tag.');
  add(TECH,'Language declared',2, lang?'pass':'warn', lang?('lang="'+lang+'"'):'Missing','Tells search engines what language your site is in so it reaches the right people.','Add lang="en" to the <html> tag.');
  add(TECH,'Favicon present',1, favicon?'pass':'warn', favicon?'Present':'Missing','The little icon in the browser tab and search results — small, but it makes you look established.','Add a favicon link in the head.');

  const bizStatus = biz.kind==='local' ? (biz.missing.length?'warn':'pass') : biz.kind==='org' ? 'warn' : 'fail';
  add(LOCAL,'LocalBusiness structured data',12, bizStatus,
    biz.kind==='local' ? (biz.type+' schema'+(biz.missing.length?' — missing '+biz.missing.join(', '):' with address, telephone and opening hours'))
      : biz.kind==='org' ? (biz.type+' schema only — not a LocalBusiness type')
      : (schemaTypes.length?('No LocalBusiness schema (found: '+schemaTypes.join(', ')+')'):'No schema found'),
    'This is the behind-the-scenes data that powers the Google Map pack and "near me" results — the single biggest win there is for a local service business. It only counts as a local business when it is a LocalBusiness type (or subtype such as AutoRepair) with the address, phone and opening hours filled in.',
    biz.kind==='local' ? ('Add '+biz.missing.join(', ')+' to the '+biz.type+' JSON-LD.')
      : 'Add JSON-LD LocalBusiness (or the closest subtype, e.g. AutoRepair) with name, address, telephone, openingHoursSpecification and geo coordinates.');
  add(LOCAL,'Review / rating schema',0, selfReview?'warn':'info',
    selfReview?'aggregateRating / review is marked up on the business itself (self-serving)':(hasReview?'Review markup found (not on the business entity)':'No review or rating schema'),
    'Review markup about your own business does not earn stars in Google (not eligible since 2019) and can be treated as spammy structured data. Show your real Google reviews on your website — that’s what builds trust with visitors and AI.',
    selfReview?'Remove aggregateRating / review from the LocalBusiness / Organization JSON-LD. Show your real Google reviews on your website — that’s what builds trust with visitors and AI.':'');
  add(LOCAL,'Click-to-call phone link',4, tel>0?'pass':'warn', tel>0?(tel+' tel: link(s)'):'None found','A tappable phone number turns a phone visitor into a phone call with one tap. Missing it quietly costs you leads.','Wrap the phone number in <a href="tel:+1...">.');
  const mapPage=pageType==='home'||pageType==='location'||/contact|about|location/i.test(url);
  if(!mapPage) checks.push({cat:LOCAL,label:'Map / location reference',points:0,status:'na',detail:'Checked on the homepage, contact, about and location pages',why:'',fix:''});
  else add(LOCAL,'Map / location reference',3, hasMap?'pass':'warn', hasMap?'Map or directions link found':'No map embed or directions link','A map and visible address prove to Google (and customers) exactly where you serve.','Embed a Google Map and show the full address (matching your Google Business Profile).');

  add(SOCIAL,'Open Graph tags',5, ogCount>=2?'pass':(ogCount===1?'warn':'fail'), ogCount+' of 3 core OG tags','Controls how your link looks when shared on Facebook, in texts, and on LinkedIn. A bare, ugly link looks unprofessional and gets ignored.','Add og:title, og:description, and og:image meta tags.');
  add(SOCIAL,'Twitter / X card',3, twCard?'pass':'warn', twCard?'Configured':'Missing','Controls the preview when your link is shared on X (Twitter).','Add <meta name="twitter:card" content="summary_large_image">.');

  add(MEDIA,'Images have alt text',6, !imgs.length?'na':(withAlt/imgs.length>=0.8?'pass':(withAlt/imgs.length>=0.4?'warn':'fail')),
    imgs.length?(withAlt+' of '+imgs.length+' images have alt text'):'N/A — no images in the HTML',
    'Alt text describes images for visually-impaired visitors and helps you show up in Google Images — a free spot to work in your service and city.',
    'Add descriptive alt text to every meaningful image (e.g. "tow truck in Columbus OH").');
  add(MEDIA,'Images have dimensions',2, !imgs.length?'na':(withDim/Math.max(1,imgs.length)>=0.6?'pass':'warn'),
    imgs.length?(withDim+' of '+imgs.length+' images set width/height'):'n/a','Telling the browser each image size stops the page from jumping around as it loads (something Google measures and dislikes).','Add width and height attributes to images.');

  const assets=pageAssets(doc, url);
  checks.push(Object.assign({cat:PERF}, weightCheck(bytes, assets, null)));
  checks.push(Object.assign({cat:MEDIA}, imageCheck(assets, null)));
  checks.push(Object.assign({cat:TECH}, viewportZoomCheck(doc)));
  checks.push(Object.assign({cat:CONTENT}, headingHierarchyCheck(doc)));
  checks.push(Object.assign({cat:INDEX}, soft404Check(pageType, title, (h1[0]&&h1[0].textContent||'').trim(), mainWords)));
  checks.push(Object.assign({cat:CONTENT}, titleQualityCheck(title, url, pageType)));
  const brandNames=[].concat((nap.schema||{}).names||[], [(doc.querySelector('meta[property="og:site_name"]')||{getAttribute:()=>null}).getAttribute('content'), titleBrand(title)]).filter(Boolean);
  checks.push(Object.assign({cat:CONTENT}, genericH1Check(h1[0]&&h1[0].textContent, brandNames)));
  checks.push(Object.assign({cat:CONTENT}, descEqualsTitleCheck(title, desc)));
  checks.push(Object.assign({cat:CONTENT}, genericAnchorCheck(anchors)));
  const SD='Structured Data';
  [jsonLdSyntaxCheck(doc), businessEntityCheck(ld), schemaNapCheck(nap), openingHoursCheck(ld, pageText), serviceSchemaCheck(ld, pageType),
    breadcrumbCheck(ld, pageType), faqMatchCheck(ld, pageText), schemaTypesCheck(ld), richResultsCheck(ld, url)].filter(Boolean).forEach(c=>checks.push(Object.assign({cat:SD}, c)));
  const TRUST='Trust & Conversion';
  [licenseCheck(pageText, pageType), pricingCheck(pageText, anchors, pageType), insuranceCheck(pageText, pageType)].filter(Boolean).forEach(c=>checks.push(Object.assign({cat:TRUST}, c)));
  [questionAnswerCheck(doc, pageType), citableFactsCheck(pageText, pageType, anchors)].filter(Boolean).forEach(c=>checks.push(Object.assign({cat:AISEARCH}, c)));
  checks.push(Object.assign({cat:LOCAL}, callAboveFoldCheck(doc, pageType)));
  checks.push(Object.assign({cat:LOCAL}, areaCodeCheck(doc, _market)));
  checks.push(Object.assign({cat:CONTENT}, staleClaimsCheck(yClaims, null)));
  checks.push(Object.assign({cat:CONTENT}, placeholderCheck(mainText)));
  const privacy=defaultPrivacyCheck(url, mainText); if(privacy) checks.push(Object.assign({cat:CONTENT}, privacy));
  add(PERF,'Limited render-blocking scripts',3, blocking<=3?'pass':'warn', blocking+' blocking script(s) in head','Scripts loaded the wrong way make visitors stare at a blank screen longer before your page appears.','Add async or defer to non-critical head scripts.');

  // ---- AI SEARCH / ANSWER ENGINES ----
  add(AISEARCH,'Q&A / FAQ structured data',5, hasFaq?'pass':'warn',
    hasFaq?'FAQ / Q&A schema found':'No FAQ or Q&A schema',
    'AI answer engines (ChatGPT, Google AI Overviews, Perplexity) pull short answers straight from FAQ and Q&A markup — one of the best ways to get your business quoted in an AI answer.',
    'Add a short FAQ section to the page and mark it up with FAQPage JSON-LD schema.');
  add(AISEARCH,'Organization / entity data',4, (hasOrg&&hasSameAs)?'pass':(hasOrg?'warn':'fail'),
    hasOrg?(hasSameAs?'Organization schema with linked profiles':'Organization schema, but no sameAs links'):'No Organization schema',
    'AI tools build a profile of your business from Organization schema and "sameAs" links to your other profiles. Without it, they may not know who you are or trust your details.',
    'Add Organization (or LocalBusiness) JSON-LD with your name, logo, and sameAs links to your Google Business Profile, Facebook, etc.');
  add(AISEARCH,'Semantic main-content region',2, hasMain?'pass':'warn',
    hasMain?'Uses <main> / <article>':'No <main> or <article> landmark',
    'A clear main-content region helps AI crawlers and screen readers find your real content instead of menus and footers.',
    'Wrap the primary content of each page in a <main> or <article> tag.');

  add(AISEARCH,'Content readable without JavaScript',6, jsShell?'fail':'pass',
    jsShell?('Only ~'+bodyText.length+' characters of text in the raw HTML — this page is JavaScript-rendered')
           :(words+' words of readable text in the raw HTML'),
    'Google can render JavaScript, but AI answer engines (ChatGPT, Perplexity, Google AI Overviews) and many crawlers do NOT. If your content only appears after JavaScript runs, they see a near-empty page and cannot read or recommend you.',
    'Serve your main content, headings and business info in the initial HTML via server-side rendering (SSR), static generation, or prerendering.');

  const result={ url, domain:o.hostname, origin, timestamp:new Date().toLocaleString(), ssl, checks, tracking, schemaTypes,
    title, h1text:(h1[0]&&h1[0].textContent||'').trim(), desc, words, jsShell, loadMs,
    bodySig:bodyText.slice(0,600).replace(/\s+/g,' ').toLowerCase().trim(),
    engineVersion:ENGINE_VERSION, noindex, primaryCity, pageType, mainWords, entities, links, datePublished:dates.published, dateModified:dates.modified,
    nap, claims, h1Glue, smsTel, bytes, siteName:((doc.querySelector('meta[property="og:site_name"]')||{getAttribute:()=>null}).getAttribute('content')||'').trim()||null,
    stats:{images:imgs.length, scripts:doc.querySelectorAll('script').length, stylesheets:doc.querySelectorAll('link[rel="stylesheet"]').length, sizeKb, words},
    aux:{robots:null,sitemap:null}, _origin:origin };
  // Main-content text blocks for the crawl's cross-page analysis — kept out of JSON (saved reports, API results).
  applyGates(result);
  Object.defineProperty(result,'_blocks',{value:blocks,enumerable:false,writable:true,configurable:true});
  // Raw HTML and anchor details stay available to the crawl's checks but out of saved results.
  Object.defineProperty(result,'_html',{value:html,enumerable:false,writable:true,configurable:true});
  Object.defineProperty(result,'_anchors',{value:anchors,enumerable:false,writable:true,configurable:true});
  Object.defineProperty(result,'_assets',{value:assets,enumerable:false,writable:true,configurable:true});
  Object.defineProperty(result,'_yearClaims',{value:yClaims,enumerable:false,writable:true,configurable:true});
  Object.defineProperty(result,'_pageText',{value:pageText,enumerable:false,writable:true,configurable:true});
  return result;
}

async function addAux(r){
  // best-effort robots.txt + sitemap + AI-crawler + llms.txt, never fail the audit
  const INDEX='Indexability & Crawlability';
  const robots=await fetchAux(r.origin+'/robots.txt');
  Object.defineProperty(r,'_robotsTxt',{value:robots,enumerable:false,writable:true,configurable:true});
  if(robots===null){
    r.checks.push({cat:INDEX,label:'robots.txt present',points:0,status:'info',detail:'Could not verify (fetch blocked)',why:'',fix:''});
    r.checks.push({cat:AISEARCH,label:'AI search crawlers allowed',points:0,status:'info',detail:'Could not verify robots.txt',why:'',fix:''});
  }else{
    const ok=/user-agent|disallow|sitemap/i.test(robots)&&!/<html/i.test(robots.slice(0,200));
    r.checks.push({cat:INDEX,label:'robots.txt present',points:4,status:ok?'pass':'warn',
      detail:ok?'Found':'Not found / not a valid robots file',
      why:'This file guides search engines and is usually where your sitemap is listed.',
      fix:'Add a /robots.txt that allows crawling and lists your sitemap.'});
    let smUrl=(robots.match(/sitemap:\s*(\S+)/i)||[])[1];
    let sm=null;
    if(smUrl) sm=await fetchAux(smUrl);
    if(!sm) sm=await fetchAux(r.origin+'/sitemap.xml');
    const smOk= sm!==null && /<urlset|<sitemapindex/i.test(sm) && /<loc>\s*https?:\/\//i.test(sm);
    r.checks.push({cat:INDEX,label:'XML sitemap present',points:5,status: sm===null?'info':(smOk?'pass':'warn'),
      detail: sm===null?'Could not verify':(smOk?'Found':'Not found (or no URLs in it)'),
      why:'A sitemap is a table of contents that helps Google find and list all your pages quickly.',
      fix:'Generate /sitemap.xml and reference it in robots.txt.'});
    // AI crawler access (uses the robots.txt we already fetched). Only crawlers that fetch pages for live search / AI
    // answers are scored; training-only crawlers are reported without penalty.
    const ai=aiCrawlerStatus(robots);
    const coreBlocked=ai.blocked.filter(b=>b==='Googlebot'||b==='Bingbot');
    let st,det;
    if(!ai.blocked.length){ st='pass'; det='No AI search crawlers blocked'; }
    else { st=(coreBlocked.length||ai.blocked.length===AI_SEARCH_BOTS.length)?'fail':'warn'; det='Blocking: '+ai.blocked.join(', '); }
    r.checks.push({cat:AISEARCH,label:'AI search crawlers allowed',points:5,status:st,detail:det,
      why:'These crawlers fetch pages to answer searches live (ChatGPT search, Perplexity, Claude, Bing/Copilot, Google and AI Overviews). If robots.txt blocks them, those tools cannot read your site and will not recommend your business.',
      fix:'In robots.txt, do not disallow '+AI_SEARCH_BOTS.join(', ')+'.'});
    r.checks.push({cat:AISEARCH,label:'AI training crawlers',points:0,status:'info',
      detail:ai.trainingBlocked.length?('Blocking: '+ai.trainingBlocked.join(', ')+' — training only, no effect on search visibility'):'None blocked',
      why:'Training crawlers (GPTBot, Google-Extended, CCBot…) only collect data to train AI models. Blocking them does not remove you from AI search answers, so it is not scored.',fix:''});
  }
  // llms.txt — reported only: no search engine or AI answer engine is confirmed to use it, so it earns no points.
  const llms=await fetchAux(r.origin+'/llms.txt');
  const llmsOk = llms!==null && llms.length>20 && !/<html/i.test(llms.slice(0,200));
  r.checks.push({cat:AISEARCH,label:'llms.txt AI guide file',points:0,status:'info',
    detail: llms===null?'Could not verify':(llmsOk?'Found':'Not found'),
    why:'llms.txt is a proposed plain-text summary of your site for AI assistants. No major AI search engine has confirmed it uses the file, so it does not affect the score.',
    fix:''});
}

// ---- Google PageSpeed Insights (real load speed, mobile + desktop) ----
// Chrome UX Report field data as PageSpeed returns it (real users; absent for low-traffic sites).
function cruxOf(le){ if(!le||!le.metrics) return null; const m=le.metrics, p=k=>m[k]&&m[k].percentile!=null?m[k].percentile:null;
  const cls=p('CUMULATIVE_LAYOUT_SHIFT_SCORE');
  return { category:le.overall_category||null, lcp:p('LARGEST_CONTENTFUL_PAINT_MS'), inp:p('INTERACTION_TO_NEXT_PAINT'), cls:cls==null?null:cls/100 }; }
async function fetchPSI(url, strategy, key){
  let api=`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance`;
  if(key) api+=`&key=${encodeURIComponent(key)}`;
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),60000); linkAbort(ctrl);
  try{
    const res=await fetch(api,{signal:ctrl.signal});
    if(!res.ok) return {error:'HTTP '+res.status};
    const j=await res.json();
    const lh=j.lighthouseResult;
    if(!lh) return {error:'no data'};
    const a=lh.audits||{};
    const perf=lh.categories&&lh.categories.performance?lh.categories.performance.score:null;
    return {
      score: perf==null?null:Math.round(perf*100),
      lcp: a['largest-contentful-paint']?a['largest-contentful-paint'].numericValue:null,
      lcpTxt: a['largest-contentful-paint']?a['largest-contentful-paint'].displayValue:null,
      cls: a['cumulative-layout-shift']?a['cumulative-layout-shift'].numericValue:null,
      clsTxt: a['cumulative-layout-shift']?a['cumulative-layout-shift'].displayValue:null,
      tbtTxt: a['total-blocking-time']?a['total-blocking-time'].displayValue:null,
      field: j.loadingExperience&&j.loadingExperience.overall_category?j.loadingExperience.overall_category:null,
      fieldData: { url:cruxOf(j.loadingExperience), origin:cruxOf(j.originLoadingExperience) }
    };
  }catch(e){ return {error:e.name==='AbortError'?'timeout':'fetch failed'}; }
  finally{ clearTimeout(t); }
}
// Lighthouse scores swing run to run, so each URL + form factor is measured PSI_RUNS times and the median is
// scored; the min–max range is kept for the detail view.
const PSI_RUNS=3;
const median=a=>{ const v=a.filter(x=>x!=null).sort((x,y)=>x-y); if(!v.length) return null; const m=Math.floor(v.length/2); return v.length%2?v[m]:(v[m-1]+v[m])/2; };
async function fetchPSIMedian(url, strategy, key){
  const runs=await Promise.all(Array.from({length:PSI_RUNS},()=>fetchPSI(url,strategy,key)));
  const ok=runs.filter(x=>x&&!x.error);
  if(!ok.length) return runs[0]||{error:'no data'};
  const pick=k=>ok.map(x=>x[k]).filter(v=>v!=null);
  const range=k=>{ const v=pick(k); return v.length?[Math.min(...v),Math.max(...v)]:null; };
  const sc=median(pick('score')), lcp=median(pick('lcp')), cls=median(pick('cls'));
  return { score:sc==null?null:Math.round(sc), lcp, cls,
    lcpTxt:lcp==null?null:(lcp/1000).toFixed(1)+' s', clsTxt:cls==null?null:String(Math.round(cls*1000)/1000),
    field:(ok.find(x=>x.field)||{}).field||null, fieldData:(ok.find(x=>x.fieldData&&(x.fieldData.url||x.fieldData.origin))||{}).fieldData||null, runs:ok.length, range:{ score:range('score'), lcp:range('lcp'), cls:range('cls') } };
}
const psiRange=(m,k,fmt)=>{ const r=m.range&&m.range[k]; if(!r||m.runs<2) return ''; return ' · range '+fmt(r[0])+'–'+fmt(r[1])+' over '+m.runs+' runs'; };
async function addSpeed(r, key){
  const SPEED='Page Speed & Core Web Vitals';
  const [m,d]=await Promise.all([fetchPSIMedian(r.url,'mobile',key), fetchPSIMedian(r.url,'desktop',key)]);
  r.speed={mobile:m, desktop:d};
  const scoreStatus=s=> s==null?'info' : s>=90?'pass' : s>=50?'warn':'fail';
  const num=x=>String(Math.round(x)), secs=x=>(x/1000).toFixed(1)+'s', cl=x=>String(Math.round(x*1000)/1000);
  // Mobile score (weighted highest — Google is mobile-first)
  if(m.error){
    r.checks.push({cat:SPEED,label:'Mobile speed score',points:0,status:'info',detail:'Could not measure ('+m.error+')',why:'',fix:''});
  }else{
    r.checks.push({cat:SPEED,label:'Mobile speed score',points:6,status:scoreStatus(m.score),
      detail:(m.score!=null?m.score+'/100 (median)':'n/a')+psiRange(m,'score',num)+(m.field?' · real users: '+m.field.toLowerCase().replace('_',' '):''),
      why:'Google measures your site by its phone version first, and most local searches happen on phones. A slow mobile site quietly loses customers and rankings.',
      fix:'Compress and lazy-load images, enable caching / a CDN, and defer non-critical scripts. PageSpeed Insights lists the exact opportunities.'});
    if(m.lcp!=null){ const s= m.lcp<=2500?'pass':m.lcp<=4000?'warn':'fail';
      r.checks.push({cat:SPEED,label:'Largest Contentful Paint (mobile)',points:4,status:s,
        detail:(m.lcpTxt||Math.round(m.lcp)+' ms')+' median (good ≤ 2.5s)'+psiRange(m,'lcp',secs),
        why:'LCP is how long until the main content actually appears. Over 2.5 seconds feels slow and hurts both conversions and ranking.',
        fix:'Optimize the largest image / hero, use modern formats (WebP/AVIF), and remove render-blocking CSS and scripts.'});
    }
    if(m.cls!=null){ const s= m.cls<=0.1?'pass':m.cls<=0.25?'warn':'fail';
      r.checks.push({cat:SPEED,label:'Layout stability (mobile CLS)',points:2,status:s,
        detail:(m.clsTxt!=null?String(m.clsTxt):String(m.cls))+' median (good ≤ 0.1)'+psiRange(m,'cls',cl),
        why:'CLS measures how much the page jumps around while loading. Jumpy pages frustrate visitors and are penalized by Google.',
        fix:'Set width and height on images and reserve space for ads, banners, and embeds.'});
    }
  }
  // Desktop score
  if(d.error){
    r.checks.push({cat:SPEED,label:'Desktop speed score',points:0,status:'info',detail:'Could not measure ('+d.error+')',why:'',fix:''});
  }else{
    r.checks.push({cat:SPEED,label:'Desktop speed score',points:3,status:scoreStatus(d.score),
      detail:(d.score!=null?d.score+'/100 (median)':'n/a')+psiRange(d,'score',num),
      why:'Desktop speed still matters for the office and at-home customers researching your services on a computer.',
      fix:'Same wins as mobile: optimize images, enable caching, and defer non-critical scripts.'});
  }
}

// ---------- Severity + problem-state titles ----------
// Severity follows the score shortfall (points actually lost, plus any penalty), not the check's weight; a check can
// fix its own severity (c.sev) where the rule is explicit (sibling overlap, unique content).
const SEV_RANK={ Critical:4, High:3, Medium:2, Low:1 };
function shortfallSeverity(lost){ return lost>=8?'Critical':lost>=4?'High':lost>=1.5?'Medium':'Low'; }
function checkSeverity(c){
  if(c.status!=='fail'&&c.status!=='warn') return null;
  if(c.sev) return c.sev;
  const w=c.frac!=null?c.frac:c.status==='warn'?0.5:0;
  return shortfallSeverity((c.points||0)*(1-w)+(c.penalty||0));
}
// What is wrong, in words — shown instead of the check's name whenever it warns or fails
// ("JavaScript too heavy: 681 KB", "No insurance mention", "Title too long: 65 chars").
function problemTitle(c){
  if(c.problem) return c.problem;
  const d=String(c.detail||''), n=re=>{ const m=d.match(re); return m?m[1]:null; };
  switch(c.label){
    case 'Page is indexable': return 'Page is set to noindex';
    case 'Canonical URL set': return /No canonical/.test(d)?'No canonical tag':/redirects/.test(d)?'Canonical points to a redirect':/returns HTTP (\d+)/.test(d)?'Canonical target returns '+n(/returns HTTP (\d+)/):/noindex/.test(d)?'Canonical target is noindex':'Canonical URL is invalid';
    case 'Title tag present': return 'No title tag';
    case 'Title length optimal': { const k=+n(/(\d+) characters/); return k>60?'Title too long: '+k+' chars':'Title too short: '+k+' chars'; }
    case 'Single title tag': return n(/(\d+) title tags/)+' title tags on the page';
    case 'Meta description present': return 'No meta description';
    case 'Description length optimal': { const k=+n(/(\d+) characters/); return k>160?'Meta description too long: '+k+' chars':'Meta description too short: '+k+' chars'; }
    case 'Exactly one H1 heading': { const k=+n(/(\d+) H1/); return k===0?'No H1 heading':k+' H1 headings on one page'; }
    case 'Uses subheadings (H2)': return 'No H2 subheadings';
    case 'Unique content': return 'Thin content: '+n(/^(\d+) words/)+' unique words';
    case 'Unique vs sibling pages': return n(/^(\d+)%/)+'% of the text is shared with '+(n(/\(([^)]+)\)$/)||'another page');
    case 'Local detail': return 'Only '+n(/^(\d+)/)+' local details (roads, exits, landmarks)';
    case 'Served over HTTPS': return 'Not served over HTTPS';
    case 'Mobile viewport set': return 'No mobile viewport tag';
    case 'No mixed (insecure) content': return n(/^(\d+)/)+' insecure http:// resources';
    case 'Character encoding declared': return 'No character encoding declared';
    case 'Language declared': return 'No lang attribute on <html>';
    case 'Favicon present': return 'No favicon';
    case 'LocalBusiness structured data': return /missing (.+)$/.test(d)?'LocalBusiness schema missing '+n(/missing (.+)$/):/only/.test(d)?'Organization schema only — no LocalBusiness':'No LocalBusiness schema';
    case 'Review / rating schema': return 'Self-serving review markup on the business';
    case 'Click-to-call phone link': return 'No click-to-call link';
    case 'Map / location reference': return 'No map or directions link';
    case 'Open Graph tags': return 'Only '+n(/^(\d+) of 3/)+' of 3 Open Graph tags';
    case 'Twitter / X card': return 'No Twitter/X card';
    case 'Images have alt text': { const a=+n(/^(\d+) of/), t=+n(/of (\d+) images/); return (t-a)+' of '+t+' images missing alt text'; }
    case 'Images have dimensions': { const a=+n(/^(\d+) of/), t=+n(/of (\d+) images/); return (t-a)+' of '+t+' images without width/height'; }
    case 'Limited render-blocking scripts': return n(/^(\d+)/)+' render-blocking scripts in <head>';
    case 'Q&A / FAQ structured data': return 'No FAQ schema';
    case 'Organization / entity data': return /no sameAs/i.test(d)?'Organization schema has no sameAs links':'No Organization schema';
    case 'Semantic main-content region': return 'No <main> or <article> region';
    case 'Content readable without JavaScript': return 'Content only appears after JavaScript runs';
    case 'Soft 404': return /says/.test(d)?'"Not found" page answers 200 (soft 404)':'Near-empty page: only '+n(/only (\d+) words/)+' words of its own (soft 404)';
    case 'Viewport allows zoom': return 'Pinch-zoom is disabled';
    case 'Heading hierarchy': return 'Heading levels skip: '+(n(/^(H\d → H\d)/)||'a level');
    case 'Specific H1': return 'Generic H1: "'+(n(/"([^"]+)"/)||'')+'"';
    case 'Meta description differs from title': return 'Meta description repeats the title';
    case 'Descriptive links to money pages': return n(/^(\d+) link/)+' "'+(n(/say only "([^"]+)"/)||'read more')+'" links to money pages';
    case 'Years-in-business claims current': return 'Stale claim: "'+n(/"(\d+ years)"/)+'" (founded '+n(/founded (\d{4})/)+')';
    case 'No placeholder text': return 'Placeholder text: "'+n(/"([^"]+)"/)+'"';
    case 'Real privacy policy (not the WordPress default)': return 'WordPress sample privacy policy still published';
    case 'JSON-LD syntax valid': return n(/^(\d+) of/)+' JSON-LD block(s) do not parse';
    case 'One business entity with a stable @id': return /no @id/.test(d)?'Business schema has no @id':n(/^(\d+)/)+' separate business entities in the schema';
    case 'Schema NAP matches the page': return /telephone/.test(d)?'Schema phone is not the phone on the page':'Schema address differs from the page';
    case 'Schema hours match the page': return 'Schema hours contradict the 24/7 claim';
    case 'Service schema': return 'No Service schema on a service page';
    case 'Breadcrumb schema': return 'No breadcrumb schema';
    case 'FAQ schema matches the visible FAQ': return 'FAQ schema doesn\'t match the page ('+n(/^(\d+ of \d+)/)+')';
    case 'Valid schema.org types': return 'Invalid schema type: '+(n(/types: (.+)$/)||'');
    case 'License / registration numbers shown': return 'No license / registration number on the page';
    case 'Pricing transparency': return /Claims/.test(d)?'Claims "'+n(/Claims "([^"]+)"/)+'" but shows no prices':'No prices or pricing page';
    case 'Insurance mentioned': return 'No insurance mention';
    case 'Question headings with direct answers': return /No question/.test(d)?'No question-form headings':'Question headings without a short direct answer';
    case 'Citable facts': return 'Missing citable facts: '+(n(/Missing: (.+)$/)||'licence #, service areas, hours, prices');
    case 'Click-to-call at the top (mobile)': return /No tel/.test(d)?'No phone link on the page':'No tap-to-call near the top of the page';
    case 'Mobile speed score': return 'Slow on mobile: '+(n(/^(\d+)\/100/)||'?')+'/100';
    case 'Desktop speed score': return 'Slow on desktop: '+(n(/^(\d+)\/100/)||'?')+'/100';
    case 'Largest Contentful Paint (mobile)': return 'Main content appears late: '+(n(/^([\d.]+ ?m?s)/)||d.split(' ')[0]);
    case 'Layout stability (mobile CLS)': return 'Page jumps while loading: CLS '+d.split(' ')[0];
    case 'robots.txt present': return 'No valid robots.txt';
    case 'XML sitemap present': return 'No XML sitemap';
    case 'AI search crawlers allowed': return 'AI search crawlers blocked: '+(n(/Blocking: (.+)$/)||'all');
    // site findings
    case 'HTTPS + www redirects': return 'Domain variants do not redirect cleanly: '+d;
    case 'Redirect chains and loops': return d;
    case 'Duplicate URL variants': return d;
    case 'Sitemap lists only live, indexable URLs': return d;
    case 'Sitemap lastmod dates': return d;
    case 'robots.txt allows CSS, JS and key pages': return d;
    case 'Core Web Vitals (real users)': return 'Real-user Core Web Vitals are '+(n(/data: ([a-z ]+)/)||'poor');
    case 'Money pages well linked': return d.replace(/ \(−1 each\)$/,'');
    case 'No internal nofollow links': return d;
    case 'Blog posts have their own dates': return d;
    case 'Copyright year current': return 'Copyright year out of date: '+d;
    case 'Consistent arrival-time claims': return 'Contradictory arrival times: '+(n(/promise (.+?) minutes/)||'')+' min';
    case 'Consistent hours claims': return 'Contradictory hours: '+d;
    case 'Consistent years-in-business claims': return 'Contradictory years in business: '+d;
    case 'Google reviews shown on the site': return 'No Google reviews shown on the site';
    case 'Reviews page linked': return 'Reviews page is not linked from anywhere';
    case 'Google Business Profile matches the site': return 'Google Business Profile differs from the site: '+d;
    case 'About page names the owner / founding': return /No About/.test(d)?'No About page':'About page has no owner or founding details';
    case 'Form endpoints respond': return d;
    case 'Privacy policy covers the tracking in use': return d;
    case 'One business name everywhere': return 'Business name differs: '+d;
    case 'No Bingbot-specific blocks': return d;
  }
  if(/^Service coverage/.test(c.label)) return 'Only '+d.split(' · ')[0];
  if(/^Location coverage/.test(c.label)) return 'Missing town pages: '+d;
  return c.label+': '+d;
}
// A category's percentage for display. AI Search never shows above 95 anywhere (live AI answers are not observed).
function catPercent(name, b){ return b&&b.t?Math.min(name===AISEARCH?95:100, Math.round(100*b.e/b.t)):null; }
function score(r){
  if(!r||r.error) return {score:null,grade:'—',color:'#94a3b8',counts:{pass:0,warn:0,fail:0},byCat:{},verdict:'',scored:0};
  let earned=0,total=0,scored=0; const counts={pass:0,warn:0,fail:0}; const byCat={};
  r.checks.forEach(c=>{
    if(c.status==='pass')counts.pass++; else if(c.status==='warn')counts.warn++; else if(c.status==='fail')counts.fail++;
    // problem-state title + shortfall severity for anything that warns or fails (recomputed on every score)
    if(c.status==='fail'||c.status==='warn'){ c.issue=problemTitle(c); c.severity=checkSeverity(c); } else { delete c.issue; delete c.severity; }
    if(c.status==='info'||c.status==='na'||!c.points) return; // info = not verifiable, na = nothing to evaluate
    scored++;
    const w= c.frac!=null ? c.frac : c.status==='pass'?1: c.status==='warn'?0.5:0; // frac = partial credit
    earned+=c.points*w; total+=c.points;
    if(!byCat[c.cat])byCat[c.cat]={e:0,t:0};
    byCat[c.cat].e+=c.points*w; byCat[c.cat].t+=c.points;
  });
  // AI Search never reads 100 in any mode: live AI answers are not observed, so the category tops out at 95%.
  const ai=byCat[AISEARCH]; if(ai && ai.e>0.95*ai.t){ earned-=ai.e-0.95*ai.t; ai.e=0.95*ai.t; }
  const penalty=r.checks.reduce((a,c)=>a+(c.penalty||0),0);
  let s= Math.max(0,(total? Math.round(100*earned/total):0)-penalty);
  // Thin location pages are capped after every check: <150 unique words -> max 70, <300 -> max 80 (a city page that
  // is mostly template can't score well however clean its code is). Crawl = boilerplate-stripped words.
  let cap=null;
  if(r.pageType==='location'){ const uw=r.uniqueWords!=null?r.uniqueWords:r.mainWords;
    if(uw!=null&&uw<150) cap={max:70, reason:'Thin location page ('+uw+' unique words, under 150)'};
    else if(uw!=null&&uw<300) cap={max:80, reason:'Thin location page ('+uw+' unique words, under 300)'};
    if(cap&&s>cap.max) s=cap.max; else if(cap&&s<=cap.max) cap.applied=false; }
  let grade,color;
  if(s>=90){grade='A';color='#16a34a';} else if(s>=80){grade='B';color='#65a30d';}
  else if(s>=70){grade='C';color='#f59e0b';} else if(s>=55){grade='D';color='#f97316';} else {grade='F';color='#dc2626';}
  const verdict = s>=90?'Strong SEO foundation with only minor polish needed.'
    : s>=80?'Solid, but a handful of fixes would meaningfully improve visibility.'
    : s>=70?'Several important gaps are holding this site back in search.'
    : s>=55?'Significant SEO problems are limiting how often this site is found.'
    : 'Major SEO issues — the site is likely losing substantial search traffic.';
  return {score:s,grade,color,counts,byCat,verdict,scored,penalty,cap};
}

// ---------- Whole-site crawl (SEO Analyzer v2) — mirrors CRMColumbus/public/seo-engine.js ----------
async function discoverPages(root, max, render){
  max=max||150; let base;
  try{ base=new URL(/^https?:\/\//i.test(root)?root:'https://'+root).origin; }catch(e){ return {base:root,urls:[],total:0,capped:false,via:'error'}; }
  const grab=async(u)=>{ try{ return (await fetchAux(u))||''; }catch(e){ return ''; } };
  const locRe=/<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  const linksIn=(html)=>[...new Set([...String(html).matchAll(/href=["']([^"'#]+)["']/gi)].map(m=>m[1])
      .map(h=>{ try{ return new URL(h, base+'/').href.split('#')[0]; }catch(e){ return null; } })
      .filter(u=>u && u.indexOf(base)===0 && !/\.(png|jpe?g|gif|svg|css|js|pdf|zip|ico|webp|mp4|woff2?)(\?|$)/i.test(u)))];
  // Find sitemap(s): robots.txt "Sitemap:" directives first, then /sitemap.xml — each with one retry (flaky origins).
  const grab1=async(u)=>{ let x=await grab(u); if(!x) x=await grab(u); return x; };
  let smList=[];
  const robotsTxt=await grab(base+'/robots.txt');
  [...String(robotsTxt).matchAll(/sitemap:\s*(\S+)/gi)].forEach(m=>{ const s=m[1].trim(); if(/^https?:\/\//i.test(s)) smList.push(s); });
  smList.push(base+'/sitemap.xml'); smList=[...new Set(smList)].slice(0,8);
  let locs=[]; let via='sitemap'; const lastmod={};
  const readUrls=xml=>{ [...String(xml).matchAll(/<url>([\s\S]*?)<\/url>/gi)].forEach(m=>{
    const loc=(m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)||[])[1], lm=(m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)||[])[1];
    if(loc&&lm) lastmod[loc.split('#')[0]]=lm; }); };
  for(const sm of smList){
    const xml=await grab1(sm); const l=[...String(xml).matchAll(locRe)].map(m=>m[1]);
    const kids=l.filter(u=>/\.xml(\?|$)/i.test(u));
    if(kids.length && kids.length>=l.length-1){ for(const c of kids.slice(0,20)){ const cx=await grab1(c); readUrls(cx); locs=locs.concat([...String(cx).matchAll(locRe)].map(m=>m[1])); if(locs.length>max*3)break; } }
    else { readUrls(xml); locs=locs.concat(l); }
    if(locs.length) break;
  }
  const sitemapUrls=[...new Set(locs.filter(u=>/^https?:\/\//i.test(u) && !/\.xml(\?|$)/i.test(u)).map(u=>u.split('#')[0]))];
  if(!sitemapUrls.length) via='link-crawl';
  // The crawl always starts at the homepage and follows its links; the sitemap URLs join the same queue.
  let seeds=[];
  if(!sitemapUrls.length && render){ // JS-only nav yields ~no links in raw HTML — take them from the rendered homepage
    const raw=linksIn(await grab(base+'/'));
    if(raw.length<3){ try{ const rh=await render(base+'/'); if(rh){ const rl=linksIn(rh); if(rl.length>raw.length){ seeds=rl; via='link-crawl (rendered)'; } } }catch(e){} }
  }
  const urls=[...new Set([base+'/'].concat(sitemapUrls, seeds))];
  return { base, urls, sitemapUrls, lastmod, total:urls.length, capped:false, via };
}
// NAP (name / address / phone) as the pages state it. A phone in a tel: link or in schema counts from one page;
// a phone or street address in plain text only once it appears on 2+ pages (so a number quoted in a blog post
// is not taken for the business's own).
function napIssues(pages){
  const tally=(get,minPages)=>{ const m={}; pages.forEach(p=>[...new Set(get(p)||[])].forEach(v=>{ (m[v]=m[v]||new Set()).add(p.url); }));
    const out={}; Object.keys(m).forEach(k=>{ if(m[k].size>=minPages) out[k]=m[k].size; }); return out; };
  const merge=(...ts)=>{ const o={}; ts.forEach(t=>Object.keys(t).forEach(k=>{ o[k]=Math.max(o[k]||0,t[k]); })); return Object.keys(o).map(k=>({value:k,pages:o[k]})).sort((a,b)=>b.pages-a.pages); };
  const n=p=>p.nap||{tel:[],visible:[],streets:[],schema:{names:[],phones:[],streets:[]}};
  const phones=merge(tally(p=>n(p).tel,1), tally(p=>n(p).schema.phones,1), tally(p=>n(p).visible,2));
  const streets=merge(tally(p=>n(p).schema.streets,1), tally(p=>n(p).streets,2));
  const names=merge(tally(p=>n(p).schema.names,1));
  // Addresses: a street that appears consistently (in schema, or on half the pages or more) is a real location.
  // 2+ of those = a multi-location business (info, not a problem). Only a street on a few pages, next to a dominant
  // one, is flagged as an inconsistency.
  const schemaStreets=new Set(Object.keys(tally(p=>n(p).schema.streets,1))), N=pages.length;
  const consistent=streets.filter(v=>schemaStreets.has(v.value)||v.pages>=Math.max(2,Math.ceil(N*0.5)));
  const few=Math.max(1,Math.floor(N*0.2));
  // A stray must look like the business's own address: written next to a phone number somewhere, and not the schema
  // address of a place a page describes (venue and campus pages quote their venues' street addresses).
  // Pages from before these fields existed (no napStreets) keep the old behaviour.
  const legacy=pages.every(p=>!p.nap||!p.nap.napStreets);
  // Next to the business's own (most-used) phone number — an impound lot's address beside the city's number is not ours.
  const ownPhone=phones.length?phones[0].value:null;
  const nearPhone=new Set(pages.flatMap(p=>(n(p).napStreets||[])).filter(x=>x.endsWith('@'+ownPhone)).map(x=>x.slice(0,x.lastIndexOf('@'))));
  const venues=new Set(pages.flatMap(p=>(n(p).placeStreets||[])));
  const ownLike=v=>legacy||(nearPhone.has(v.value)&&!venues.has(v.value));
  const strays=consistent.length?streets.filter(v=>!consistent.includes(v)&&v.pages<=few&&v.pages<consistent[0].pages&&ownLike(v)):[];
  const multiLocation=consistent.length>1?consistent:[];
  const addressIssue=strays.length?consistent.concat(strays):[];
  const inconsistent=[]; if(phones.length>1) inconsistent.push('phone'); if(addressIssue.length) inconsistent.push('address'); if(names.length>1) inconsistent.push('name');
  return { phones, streets, names, inconsistent, multiLocation, addressIssue };
}
// Hard-coded counts vs what the site actually has ("see all 34 service areas" with 35 area pages).
// siteTypes (optional): { url: pageType } for every URL the site lists (crawled + sitemap), so a crawl that stopped
// short of every area page doesn't make a correct "all 40 service areas" look wrong.
function claimIssues(pages, siteTypes){
  const typed=siteTypes&&Object.keys(siteTypes).length?Object.keys(siteTypes).map(url=>({url, pageType:siteTypes[url]})):pages.filter(p=>!p.error);
  const actual={ location:typed.filter(p=>p.pageType==='location').length, service:typed.filter(p=>p.pageType==='service').length };
  // Neighborhood pages nested under an area page (/service-area/columbus/short-north under /service-area/columbus) are
  // sub-areas: "all 40 service areas" may count the top-level areas only, so either count matches.
  const pathOf=u=>{ try{ return new URL(u).pathname.replace(/\/+$/,''); }catch(e){ return String(u); } };
  const areaPaths=new Set(typed.filter(p=>p.pageType==='location'||p.pageType==='hub').map(p=>pathOf(p.url)));
  const topAreas=typed.filter(p=>p.pageType==='location'&&!areaPaths.has(pathOf(p.url).replace(/\/[^/]+$/,''))).length;
  const m={};
  pages.forEach(p=>(p.claims||[]).forEach(c=>{ const have=actual[c.kind];
    const matches=n=>c.atLeast?n>=c.n:n===c.n;
    if(matches(have)||(c.kind==='location'&&topAreas!==have&&matches(topAreas))) return;
    const k=c.kind+'|'+c.text.toLowerCase(); (m[k]=m[k]||{claim:c.text, claimed:c.n, kind:c.kind, actual:have, urls:[]}).urls.push(p.url); }));
  return Object.values(m).sort((a,b)=>b.urls.length-a.urls.length);
}
function crossPageIssues(pages, siteTypes){
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
  const group=(key)=>{ const m={}; pages.forEach(p=>{ const k=norm(p[key]); if(k)(m[k]=m[k]||[]).push(p.url); }); return Object.keys(m).filter(k=>m[k].length>1).map(k=>({value:k.slice(0,80),urls:m[k]})); };
  const bodyGroups=(()=>{ const m={}; pages.forEach(p=>{ const k=p.bodySig; if(k)(m[k]=m[k]||[]).push(p.url); }); return Object.keys(m).filter(k=>m[k].length>1).map(k=>({sample:k.slice(0,80),urls:m[k]})); })();
  const stop=['home','page','service','services','ohio','near','the','and','for','with','your'];
  const mismatch=pages.filter(p=>{ if(!p.title||!p.bodySig)return false; const ws=norm(p.title).split(/[^a-z0-9]+/).filter(w=>w.length>=4&&stop.indexOf(w)<0); if(!ws.length)return false; return ws.filter(w=>p.bodySig.indexOf(w)>=0).length/ws.length < 0.34; }).map(p=>p.url);
  return { duplicateTitles:group('title'), duplicateDescriptions:group('desc'), duplicateH1:group('h1text'), duplicateBodies:bodyGroups, titleBodyMismatch:mismatch,
    nap:napIssues(pages), countClaims:claimIssues(pages, siteTypes),
    h1Spacing:pages.filter(p=>p.h1Glue).map(p=>({url:p.url, sample:p.h1Glue})),
    smsTelLinks:pages.filter(p=>p.smsTel&&p.smsTel.length).map(p=>({url:p.url, labels:p.smsTel})),
    thin:pages.filter(p=>p.pageType!=='utility'&&p.pageType!=='archive'&&(p.uniqueWords!=null?p.uniqueWords:p.words)<250).map(p=>({url:p.url,words:p.uniqueWords!=null?p.uniqueWords:p.words})),
    jsRendered:pages.filter(p=>p.jsShell).map(p=>p.url), missingH1:pages.filter(p=>!p.h1text).map(p=>p.url) };
}
// What the sitemap says about a site, without crawling it: page count, service / location pages (by URL), newest
// lastmod. Used by homepage snapshots and snapshot comparisons.
// THE page-type classifier for a set of URLs — used by both the sitemap columns (sitemapSummary) and the crawl's
// coverage, so the two always agree. Each URL is typed by classifyPage (or typeOf), then a service/location/other
// URL with 2+ URLs under its path in the same set is a hub (a directory page, not a page of its own).
function pageTypesFor(urls, typeOf){
  const pathOf=u=>{ try{ return new URL(u).pathname.replace(/\/+$/,'').toLowerCase(); }catch(e){ return ''; } };
  const paths=urls.map(pathOf), types={};
  urls.forEach((u,i)=>{ let t=typeOf?typeOf(u):classifyPage(u,[]);
    if(paths[i] && (t==='service'||t==='location'||t==='other') && paths.filter((q,j)=>j!==i&&q.indexOf(paths[i]+'/')===0).length>=2) t='hub';
    types[u]=t; });
  return types;
}
async function sitemapSummary(root, opts){
  let disc; try{ disc=await discoverPages(root, 5000, null); }catch(e){ return { found:false }; }
  const urls=(disc&&disc.sitemapUrls)||[];
  if(!urls.length) return { found:false };
  const types=Object.values(pageTypesFor(urls, u=>classifyPage(u,[],{ primaryCity:opts&&opts.primaryCity })));
  const service=types.filter(t=>t==='service').length, location=types.filter(t=>t==='location').length;
  const times=Object.values(disc.lastmod||{}).map(d=>Date.parse(d)).filter(t=>!isNaN(t)&&t<Date.now()+2*864e5);
  return { found:true, total:urls.length, service, location, newest:times.length?new Date(Math.max(...times)).toISOString().slice(0,10):null };
}
// Cross-page content analysis — what one page alone cannot show:
//  - hub pages (a directory page with its own sub-pages) are told apart from the pages under them;
//  - boilerplate: a text block on >50% of a URL group's pages (first path segment; flat URLs share one group), or
//    on >50% of all pages, is template, not content — "Unique content" is re-measured without it;
//  - near-duplicates: 5-word shingles, Jaccard, against every other non-utility page;
//  - local detail on a location page counts only entities no other location page names.
const NEAR_DUP=0.8;
function crossPageContent(pages, sitemapUrls){
  const N=pages.length;
  const pathOf=u=>{ try{ return new URL(u).pathname.replace(/\/+$/,'').toLowerCase(); }catch(e){ return ''; } };
  // Same classifier as the sitemap columns, over the crawled pages plus the sitemap's URLs.
  const cityCount={}; pages.forEach(p=>{ if(p.primaryCity) cityCount[p.primaryCity]=(cityCount[p.primaryCity]||0)+1; });
  const siteCity=Object.keys(cityCount).sort((a,b)=>cityCount[b]-cityCount[a])[0]||null;
  const byUrl={}; pages.forEach(p=>{ byUrl[p.url]=p; });
  const types=pageTypesFor([...new Set(pages.map(p=>p.url).concat(sitemapUrls||[]))], u=>byUrl[u]?byUrl[u].pageType:classifyPage(u,[],{ primaryCity:siteCity }));
  pages.forEach(p=>{ p.pageType=types[p.url];
    // Location pages describe the town: keep only first-person founding claims there (see yearClaims).
    if(p.pageType==='location'&&p._yearClaims) p._yearClaims.founded=p._yearClaims.founded.filter(f=>f.firstPerson); });
  const groupOf=p=>{ const s=pathSegs(p.url); return s.length>=2?s[0]:'/'; };
  // A location page's own place name (from its URL slug) is masked before blocks are compared, so a template sentence
  // with only the city swapped ("…reaches Dublin day or night…") is recognised as the same block on every city page.
  const placeMask=p=>{ if(p.pageType!=='location') return null;
    const slug=(pathSegs(p.url).pop()||'').replace(RE_STATE_SLUG,'').replace(/^(towing|tow-truck|auto-repair|roadside-assistance|service|services)-(in-)?/,'');
    const words=slug.split('-').filter(w=>w.length>1 && !/^(in|near|oh|and|the)$/.test(w));
    return words.length?new RegExp('\\b'+words.join('[\\s-]+')+'\\b','gi'):null; };
  const masked=(p,b)=>{ const re=p._place; return re?String(b).replace(re,'{place}'):b; };
  // Boilerplate is judged per sentence, not per paragraph: a template paragraph where only one clause changes
  // (a list of roads) must not count as unique in full.
  const sentences=b=>String(b).split(/(?<=[.!?])\s+(?=[A-Z0-9("])/).filter(s=>s.trim());
  const units=p=>(p._blocks||[]).flatMap(sentences);
  const groupSize={}, inGroup={}, inSite={};
  pages.forEach(p=>{ const g=groupOf(p); groupSize[g]=(groupSize[g]||0)+1; p._place=placeMask(p);
    p._bh=[...new Set(units(p).map(b=>fnv(normBlock(masked(p,b)))))];
    p._bh.forEach(h=>{ const k=g+'|'+h; inGroup[k]=(inGroup[k]||0)+1; inSite[h]=(inSite[h]||0)+1; }); });
  const isBoiler=(p,h)=>{ const g=groupOf(p), gs=groupSize[g];
    return (gs>=3 && inGroup[g+'|'+h]>gs*0.5) || (N>=3 && inSite[h]>N*0.5); };
  pages.forEach(p=>{
    const seen=new Set(), own=[];
    units(p).forEach(b=>{ const h=fnv(normBlock(masked(p,b))); if(seen.has(h)) return; seen.add(h); if(!isBoiler(p,h)) own.push(b); });
    p._ownText=own.join('\n'); p.uniqueWords=countWords(p._ownText);
    // Main content as served (shared template text IS the duplication), place name masked the same way.
    p._sh=shingles((p._blocks||[]).map(b=>masked(p,b)).join('\n'));
  });
  // Sibling / near-duplicate comparison: real content pages only. Utility pages, archives (blog index, category,
  // author, date listings — they repeat posts by design) and noindexed pages are left out; archive duplication is
  // reported once, site-wide (archivePairs).
  const excluded=p=>p.pageType==='utility'||p.pageType==='archive'||p.noindex;
  const pool=pages.filter(p=>!excluded(p));
  const pairs=[], archivePairs=[];
  pool.forEach((p,i)=>{ p._maxSim=0; p._simWith=null; });
  const archives=pages.filter(p=>p.pageType==='archive');
  archives.forEach(a=>pages.filter(b=>b!==a&&b.pageType!=='utility').forEach(b=>{ if(b.pageType==='archive'&&b.url<a.url) return; const sim=jaccard(a._sh,b._sh);
    if(sim>=NEAR_DUP) archivePairs.push({ a:a.url, b:b.url, similarity:Math.round(sim*100)/100, indexable:!a.noindex&&!b.noindex }); }));
  for(let i=0;i<pool.length;i++) for(let j=i+1;j<pool.length;j++){
    const a=pool[i], b=pool[j], s=jaccard(a._sh,b._sh);
    if(s>a._maxSim){ a._maxSim=s; a._simWith=b.url; } if(s>b._maxSim){ b._maxSim=s; b._simWith=a.url; }
    if(s>=NEAR_DUP) pairs.push({a:a.url,b:b.url,similarity:Math.round(s*100)/100});
  }
  const locs=pages.filter(p=>p.pageType==='location');
  const entCount={}; locs.forEach(p=>(p.entities||[]).forEach(e=>{ entCount[e]=(entCount[e]||0)+1; }));
  const setCheck=(p,label,cat,chk)=>{ const i=p.checks.findIndex(c=>c.label===label); const c=Object.assign({cat},chk); if(i>=0) p.checks[i]=c; else p.checks.push(c); };
  pages.forEach(p=>{
    setCheck(p,'Unique content','On-Page Content',p.noindex?{label:'Unique content',points:0,status:'na',detail:'N/A — page is noindex (not meant to rank)',why:'',fix:''}:uniqueContentCheck(p.pageType,p.uniqueWords,true));
    if(excluded(p)) setCheck(p,'Unique vs sibling pages','On-Page Content',{label:'Unique vs sibling pages',points:0,status:'na',detail:'N/A — '+(p.noindex?'noindex page':p.pageType+' page'),why:'',fix:''});
    else { const sim=p._maxSim||0, frac=1-sim, rel=p._simWith?(p._simWith.replace(/^https?:\/\/[^/]+/,'')||'/'):'';
      // Overlap bands: under 40% is normal site furniture (not a problem); 40–60% medium, 60–80% high, over 80% critical.
      // Banded on the whole percent the report prints, so "40% overlap" is never labelled as under 40%.
      const pct=Math.round(sim*100);
      const sev=pct<40?null:pct<60?'Medium':pct<80?'High':'Critical';
      setCheck(p,'Unique vs sibling pages','On-Page Content',{label:'Unique vs sibling pages',points:15,frac,sev,status:pct<40?'pass':pct<60?'warn':'fail',
        detail:pct+'% overlap with its closest sibling'+(rel?' ('+rel+')':''),
        why:'Pages that repeat another page\'s text (the same template with the city or service swapped) compete with each other and look like doorway pages; Google picks one and ignores the rest.',
        fix:'Rewrite this page so most of its text is specific to it — its own service details, local specifics and FAQs — instead of the shared template.'}); }
    if(p.pageType==='location'){ const own=(p.entities||[]).filter(e=>entCount[e]===1);
      setCheck(p,'Local detail','Local SEO',localDetailCheck(own,true)); }
    else { const i=p.checks.findIndex(c=>c.label==='Local detail'); if(i>=0) p.checks.splice(i,1); }
    applyGates(p);
    p.bodySig=String(p._ownText||'').slice(0,600).replace(/\s+/g,' ').toLowerCase().trim();
  });
  return { nearDuplicates:pairs, archivePairs, siteTypes:types };
}
// ---------- Site score ----------
// Final = 50% average page score + 50% site level. Site level = coverage 30% + freshness 20% + link health 20% +
// duplication 15% + technical 15%. Caps: no service AND no location pages -> max 70; no new content in 24 months ->
// max 75. Every part is returned (siteBreakdown) so the report can show its working.
const SITE_WEIGHTS={ coverage:0.30, freshness:0.20, linkHealth:0.20, duplication:0.15, technical:0.15 };
// Page average weights by page type, and the money-page floor under which the site score is capped at 70.
const PAGE_WEIGHTS={ home:3, service:2, location:2, utility:0.5, archive:0.5 };
const MIN_MONEY_PAGES=5;
const clamp100=v=>Math.max(0,Math.min(100,v));
function coverageScore(pages){
  const service=pages.filter(p=>p.pageType==='service').length, location=pages.filter(p=>p.pageType==='location').length;
  return { score:Math.round(50*Math.min(1,service/10)+50*Math.min(1,location/10)), service, location };
}
function freshnessScore(pages, lastmod, nowMs){
  const content=pages.filter(p=>p.pageType!=='utility'&&p.pageType!=='archive');
  const newest=arr=>arr.map(d=>Date.parse(d)).filter(t=>!isNaN(t)&&t<nowMs+2*864e5).reduce((a,b)=>Math.max(a,b),-Infinity);
  let t=newest(content.map(p=>p.datePublished)), source='publish dates on the pages';
  if(t===-Infinity){ t=newest(content.map(p=>p.dateModified)); source='last-modified dates on the pages'; }
  if(t===-Infinity){
    const lm=content.map(p=>lastmod[p.url]).filter(Boolean);
    const generated=lm.length>=5 && new Set(lm.map(d=>String(d).slice(0,10))).size===1; // every URL stamped the same day = build time
    // A sitemap <lastmod> is whatever the CMS writes there, not a date on the page: used, but labelled unverified.
    if(lm.length && !generated){ t=newest(lm); source='sitemap lastmod (unverified: not a date shown on the page)'; }
  }
  if(t===-Infinity) return { score:50, newest:null, ageDays:null, source:'no content dates found (scored neutral)' };
  const ageDays=Math.max(0,Math.round((nowMs-t)/864e5));
  return { score:Math.round(clamp100(100*(1-(ageDays-90)/(730-90)))), newest:new Date(t).toISOString().slice(0,10), ageDays, source };
}
function technicalScore(siteChecks, speedRuns){
  const pct=c=>!c||c.status==='info'?null:c.status==='pass'?100:c.status==='warn'?50:0;
  const find=l=>siteChecks.find(c=>c.label===l);
  const sp=(speedRuns||[]).map(s=>s.score).filter(v=>v!=null);
  const parts={ robots:pct(find('robots.txt present')), sitemap:pct(find('XML sitemap present')), aiCrawlers:pct(find('AI search crawlers allowed')),
    pageSpeed:sp.length?Math.round(sp.reduce((a,b)=>a+b,0)/sp.length):null };
  const W={ robots:20, sitemap:20, aiCrawlers:20, pageSpeed:40 };
  let e=0,t=0; Object.keys(W).forEach(k=>{ if(parts[k]!=null){ e+=W[k]*parts[k]; t+=W[k]; } });
  return { score:t?Math.round(e/t):50, parts };
}

// =====================================================================================================================
// EXTENDED CHECKS. Every finding carries evidence (URL + exact snippet / selector / value); no evidence, no finding.
// Page checks add to the page's points. Site checks ("site findings") deduct from one of the five site-level
// components — each names its component: fail = full deduction, warn = half, info/pass = none.
// =====================================================================================================================
const kb=b=>b==null?'?':(b>=1048576?(b/1048576).toFixed(1)+' MB':Math.round(b/1024)+' KB');
const snip=(t,n)=>{ t=String(t==null?'':t).replace(/\s+/g,' ').trim(); n=n||140; return t.length>n?t.slice(0,n-1)+'…':t; };
// A site finding. component: technical | linkHealth | freshness | duplication | coverage.
function finding(component, label, points, status, detail, evidence, fix, extra){
  return Object.assign({ component, label, points, status, detail, evidence:(evidence||[]).slice(0,8), fix:fix||'' }, extra||{});
}
// Scripts, stylesheets and images a page loads (absolute URLs), plus inline JS size.
function pageAssets(doc, url){
  const abs=h=>{ try{ return h&&!/^data:/i.test(h)?new URL(h,url).href:null; }catch(e){ return null; } };
  const uniq=a=>[...new Set(a.filter(Boolean))];
  // Only what a browser actually runs by default: no source maps (*.map), no nomodule fallbacks, no non-JS script
  // types (templates, JSON), no alternate or disabled stylesheets.
  const RE_MAP=/\.map(\?|#|$)/i, jsType=t=>!t||/^(module|text\/javascript|application\/javascript|application\/ecmascript|text\/ecmascript)$/i.test(t.trim());
  const scripts=uniq([...doc.querySelectorAll('script[src]')].filter(s=>jsType(s.getAttribute('type'))&&!s.hasAttribute('nomodule')&&!RE_MAP.test(s.getAttribute('src')||'')).map(s=>abs(s.getAttribute('src'))));
  const css=uniq([...doc.querySelectorAll('link[rel~="stylesheet"][href]')].filter(l=>!/\balternate\b/i.test(l.getAttribute('rel')||'')&&!l.hasAttribute('disabled')&&!RE_MAP.test(l.getAttribute('href')||'')).map(l=>abs(l.getAttribute('href'))));
  const inlineJs=[...doc.querySelectorAll('script:not([src])')].filter(s=>!/json|template|html|text\/x-/i.test(s.getAttribute('type')||'')).reduce((a,s)=>a+(s.textContent||'').length,0);
  const seen=new Set(), images=[];
  [...doc.querySelectorAll('img')].forEach((im,i)=>{
    const src=im.getAttribute('src')||im.getAttribute('data-src')||im.getAttribute('data-lazy-src')||''; const u=abs(src);
    if(!u||seen.has(u)) return; seen.add(u);
    images.push({ url:u, idx:i, lazy:(im.getAttribute('loading')||'').toLowerCase()==='lazy'||im.hasAttribute('data-src')||im.hasAttribute('data-lazy-src')||/\blazy/i.test(im.getAttribute('class')||'') });
  });
  return { scripts, css, images, inlineJs };
}
const RE_LEGACY_IMG=/\.(jpe?g|png|gif|bmp|tiff?)(\?|$)/i, RE_MODERN_IMG=/\.(webp|avif)(\?|$)/i;
// Page weight: HTML + JS + CSS + images. Asset sizes are measured (crawl, key pages) or unknown (HTML-only estimate).
function weightCheck(bytes, a, m){
  const js=a.inlineJs+(m?m.js:0), total=bytes+(m?m.js+m.css+m.img:0), heavy=total>2e6||js>5e5;
  // Name the failing resource type and its largest file: JavaScript over 500 KB, else (page over 2 MB) the type
  // that weighs the most.
  const TYPE={ js:'JavaScript', css:'CSS', img:'Images' };
  const failType=!heavy?null:js>5e5?'js':(m?['js','css','img'].sort((x,y)=>(m[y]||0)-(m[x]||0))[0]:'js');
  const typeBytes=failType==='js'?js:m?m[failType]:0;
  const largest=m&&m.topByType&&failType?m.topByType[failType]:null;
  // "style.css"; a URL whose last segment is not a file name ("…/gtag/js?id=G-1") shows host + path instead.
  const fileName=u=>{ try{ const x=new URL(u), last=decodeURIComponent(x.pathname.split('/').pop()); return /\.[a-z0-9]{1,5}$/i.test(last)?last:x.hostname.replace(/^www\./,'')+x.pathname; }catch(e){ return u; } };
  const problem=!heavy?null:(TYPE[failType]+' too heavy: '+kb(typeBytes)+(largest?' (largest file: '+fileName(largest.url)+', '+kb(largest.bytes)+')':'')+(failType!=='js'?' — page total '+kb(total):''));
  const ev=m&&m.topByTypeList&&failType?m.topByTypeList[failType]:(m&&m.top)||[];
  return { label:'Reasonable page weight', points:3, status:heavy?'warn':'pass', problem,
    detail:m?('Total '+kb(total)+' (HTML '+kb(bytes)+' · JS '+kb(js)+' · CSS '+kb(m.css)+' · images '+kb(m.img)+')')
            :('HTML '+kb(bytes)+' · inline JS '+kb(a.inlineJs)+' · '+a.scripts.length+' scripts, '+a.images.length+' images (asset sizes measured on key pages in a site crawl)'),
    evidence:ev.map(x=>({ snippet:(failType?TYPE[failType]+': ':'')+x.url+' — '+kb(x.bytes) })),
    why:'Heavy pages load slowly on phones. Google measures real load speed, and visitors leave slow pages.',
    fix:failType==='img'?'Compress and resize the largest images (WebP/AVIF, sized to how they display) and lazy-load the rest.'
       :failType==='css'?'Remove unused CSS (page builders ship a lot), split critical CSS, and minify the rest.'
       :'Keep JavaScript under ~500 KB: drop unused plugins/scripts, defer the rest, and load third-party widgets on interaction.' };
}
// Image efficiency: >150 KB images and old formats warn; eager images below the first screen are noted (info).
function imageCheck(a, sizes){
  const imgs=a.images;
  if(!imgs.length) return { label:'Image efficiency', points:4, status:'na', detail:'N/A — no images in the HTML', evidence:[], why:'', fix:'' };
  const heavy=sizes?imgs.map(i=>({url:i.url, bytes:sizes[i.url]})).filter(x=>x.bytes>150*1024).sort((a,b)=>b.bytes-a.bytes):[];
  const legacy=imgs.filter(i=>RE_LEGACY_IMG.test(i.url)||(!RE_MODERN_IMG.test(i.url)&&sizes&&sizes['ct:'+i.url]&&!/webp|avif|svg/i.test(sizes['ct:'+i.url])));
  const eager=imgs.filter(i=>i.idx>=3&&!i.lazy);
  const ev=heavy.slice(0,5).map(x=>({ snippet:x.url+' — '+kb(x.bytes) })).concat(heavy.length?[]:legacy.slice(0,5).map(x=>({ snippet:x.url })));
  const problem=heavy.length?(heavy.length+' image'+(heavy.length===1?'':'s')+' over 150 KB (largest '+kb(heavy[0].bytes)+')'):legacy.length?(legacy.length+' of '+imgs.length+' images are JPG/PNG, not WebP/AVIF'):null;
  return { label:'Image efficiency', points:4, status:(heavy.length||legacy.length)?'warn':'pass', problem,
    detail:(sizes?heavy.length+' image'+(heavy.length===1?'':'s')+' over 150 KB · ':'')+legacy.length+' of '+imgs.length+' in JPG/PNG/GIF (not WebP/AVIF)'+(eager.length?' · '+eager.length+' below-the-fold image'+(eager.length===1?' is':'s are')+' not lazy-loaded (info)':''),
    evidence:ev, why:'Images are usually most of a page\'s weight. Large JPG/PNG files slow the page on phones; WebP/AVIF are ~30–50% smaller.',
    fix:'Convert photos to WebP/AVIF, resize them to the size they display at (under ~150 KB), and add loading="lazy" to images below the first screen.' };
}
function viewportZoomCheck(doc){
  const v=doc.querySelector('meta[name="viewport"]'); const c=(v&&v.getAttribute('content')||'').toLowerCase();
  const noScale=/user-scalable\s*=\s*(no|0)\b/.test(c), mx=(c.match(/maximum-scale\s*=\s*([\d.]+)/)||[])[1], lowMax=mx!=null&&parseFloat(mx)<2;
  return { label:'Viewport allows zoom', points:2, status:(noScale||lowMax)?'warn':'pass', detail:v?('viewport: "'+snip(c,90)+'"'):'No viewport tag',
    evidence:(noScale||lowMax)?[{ snippet:'<meta name="viewport" content="'+snip(c,120)+'">' }]:[],
    why:'Blocking pinch-zoom fails accessibility guidelines and frustrates visitors who need to zoom.', fix:'Remove user-scalable=no and any maximum-scale below 2 from the viewport tag.' };
}
function headingHierarchyCheck(doc){
  const hs=[...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h=>({ lv:+h.tagName[1], t:snip(h.textContent,60) }));
  for(let i=1;i<hs.length;i++){ if(hs[i].lv>hs[i-1].lv+1 && hs[i-1].lv>=1)
    return { label:'Heading hierarchy', points:1, status:'warn', detail:'H'+hs[i-1].lv+' → H'+hs[i].lv+' skips a level', evidence:[{ snippet:'<h'+hs[i-1].lv+'>'+hs[i-1].t+'</h'+hs[i-1].lv+'> → <h'+hs[i].lv+'>'+hs[i].t+'</h'+hs[i].lv+'>' }],
      why:'Headings are the page outline for search engines, AI and screen readers; skipped levels blur the structure.', fix:'Use headings in order (H2, then H3 under it) — style them with CSS instead of picking a smaller tag.' }; }
  return { label:'Heading hierarchy', points:1, status:hs.length<2?'na':'pass', detail:hs.length<2?'N/A — fewer than 2 headings':hs.length+' headings in order', evidence:[], why:'', fix:'' };
}
const RE_NOT_FOUND=/\b(page\s+not\s+found|not\s+found|404|page\s+(can(no|’|')t|could\s*n[o’']t)\s+be\s+found|no\s+longer\s+available)\b/i;
const SOFT404_WORDS=25;
function soft404Check(type, title, h1, words){
  if(type==='home'||type==='utility'||type==='archive') return { label:'Soft 404', points:0, status:'na', detail:'Not checked on '+type+' pages', evidence:[], why:'', fix:'' };
  const msg=[title,h1].find(t=>RE_NOT_FOUND.test(t||''));
  // Under SOFT404_WORDS words of its own = an empty shell; a short real page (contact, quote form) stays above it.
  const bad=!!msg || words<SOFT404_WORDS;
  return { label:'Soft 404', points:4, status:bad?'fail':'pass',
    detail:bad?(msg?'Returns 200 but says "'+snip(msg,80)+'"':'Returns 200 with only '+words+' words of its own'):'Real page ('+words+' words of its own)',
    evidence:bad?[{ snippet:msg?('title/H1: "'+snip(msg,100)+'"'):(words+' unique words') }]:[],
    why:'A page that answers 200 but is empty or says "not found" wastes crawl budget and can drag down how Google judges the site.',
    fix:'Give the page real content, or return a proper 404/410 (or 301 it to the right page).' };
}
// robots.txt path matching (Google's rules: longest match wins, Allow wins ties; * and $ supported).
function robotsRulesFor(robots, ua){
  const groups=robotsGroups(robots||''); let mine=groups.filter(g=>g.agents.includes(ua.toLowerCase()));
  if(!mine.length) mine=groups.filter(g=>g.agents.includes('*'));
  return { allow:mine.flatMap(g=>g.allow).filter(Boolean), disallow:mine.flatMap(g=>g.disallow).filter(Boolean) };
}
function robotsAllowed(rules, path){
  const re=p=>{ const end=p.endsWith('$'); const body=(end?p.slice(0,-1):p).split('*').map(x=>x.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*'); return new RegExp('^'+body+(end?'$':'')); };
  let a=-1,d=-1, rule=null;
  rules.allow.forEach(p=>{ if(re(p).test(path)) a=Math.max(a,p.length); });
  rules.disallow.forEach(p=>{ if(re(p).test(path)&&p.length>d){ d=p.length; rule=p; } });
  return { allowed:d<0||a>=d, rule };
}
// Follow a URL's redirects one hop at a time (no auto-follow), up to 6 hops.
async function chainOf(u){
  const hops=[]; let cur=u;
  for(let i=0;i<6;i++){
    const c=await checkUrl(cur);
    if(!c||!c.status||c.challenged) return { hops, end:cur, status:c&&c.status||0 };
    if(c.status>=300&&c.status<400&&c.location){ hops.push({ from:cur, status:c.status, to:c.location });
      if(hops.some(h=>sameUrl(h.from,c.location))) return { hops, end:c.location, loop:true }; cur=c.location; }
    else return { hops, end:cur, status:c.status, canonical:c.canonical||null };
  }
  return { hops, end:cur, status:null, tooLong:true };
}
const chainText=ch=>ch.hops.map(h=>h.from+' → '+h.status).concat([ch.end+(ch.status?' ('+ch.status+')':'')]).join(' → ');

// Phase 2 — technical site findings (all feed "technical").
async function technicalFindings(ctx){
  const out=[], { ok, home, disc, graph, keyOf, robots } = ctx;
  // HTTP→HTTPS and www / non-www: one 301 hop to one canonical origin.
  try{
    const host=new URL(disc.base).hostname.replace(/^www\./,'');
    const variants=['http://'+host+'/','http://www.'+host+'/','https://'+host+'/','https://www.'+host+'/'];
    const chains=await Promise.all(variants.map(v=>chainOf(v)));
    const live=chains.map((c,i)=>({ v:variants[i], c })).filter(x=>x.c.status||x.c.hops.length);
    const finals=[...new Set(live.filter(x=>x.c.status===200).map(x=>{ try{ return new URL(x.c.end).origin; }catch(e){ return x.c.end; } }))];
    const direct200=live.filter(x=>!x.c.hops.length&&x.c.status===200).map(x=>x.v);
    const problems=[];
    if(direct200.length>1) problems.push({ s:'fail', t:'Serves 200 on '+direct200.length+' variants', ev:direct200.map(v=>({ url:v, snippet:v+' → 200' })) });
    live.forEach(x=>{ if(x.c.loop) problems.push({ s:'fail', t:'Redirect loop', ev:[{ url:x.v, snippet:chainText(x.c) }] });
      else if(x.c.hops.length>1) problems.push({ s:'fail', t:'Chain of '+x.c.hops.length+' redirects', ev:[{ url:x.v, snippet:chainText(x.c) }] });
      else if(x.c.hops.length===1 && x.c.hops[0].status!==301 && x.c.hops[0].status!==308) problems.push({ s:'warn', t:'Temporary ('+x.c.hops[0].status+') redirect', ev:[{ url:x.v, snippet:chainText(x.c) }] }); });
    if(finals.length>1) problems.push({ s:'fail', t:'Variants end on different origins', ev:finals.map(f=>({ snippet:f })) });
    const st=problems.some(p=>p.s==='fail')?'fail':problems.length?'warn':'pass';
    out.push(finding('technical','HTTPS + www redirects',8,st,
      st==='pass'?('All variants reach '+(finals[0]||disc.base)+' in one 301'):problems.map(p=>p.t).join(' · '),
      st==='pass'?live.map(x=>({ url:x.v, snippet:chainText(x.c) })):problems.flatMap(p=>p.ev),
      'Make http://, https://, www and non-www each 301 straight to the one canonical https origin — one hop, no chains.'));
  }catch(e){}
  // Redirect chains (> 1 hop) and loops met in the crawl.
  const bad=(graph.chains||[]).filter(c=>c.loop||c.hops>1);
  out.push(finding('technical','Redirect chains and loops',6,bad.length?'fail':'pass',
    bad.length?(bad.length+' redirect'+(bad.length===1?'':'s')+' take more than one hop'+(bad.some(c=>c.loop)?' (including a loop)':'')):((graph.chains||[]).length+' internal redirects, all single-hop'),
    bad.map(c=>({ url:c.from, snippet:c.chain.join(' → ')+(c.loop?' (loop)':'') })),
    'Point every redirect straight at its final URL, and update internal links to the final URL.'));
  // Duplicate URL variants answering 200 without pointing their canonical at the clean URL.
  const sample=[home].concat(ctx.money.slice(0,4)).filter(Boolean);
  const dupEv=[];
  for(const p of sample){
    let u; try{ u=new URL(p.url); }catch(e){ continue; }
    const vs=[];
    const slashless=u.pathname.length>1&&u.pathname.endsWith('/'), path=u.pathname;
    if(path!=='/') vs.push(u.origin+(slashless?path.slice(0,-1):path+'/'));
    if(/[a-z]/.test(path)&&path!=='/') vs.push(u.origin+path.toUpperCase());
    vs.push(u.origin+(path.endsWith('/')?path:path+'/')+'index.html');
    vs.push(u.origin+path+'?utm_source=seo-audit');
    const res=await Promise.all(vs.map(v=>checkUrl(v)));
    res.forEach((c,i)=>{ if(c&&c.status===200 && !(c.canonical&&sameUrl(c.canonical,p.url))) dupEv.push({ url:vs[i], snippet:vs[i]+' → 200'+(c.canonical?' (canonical → '+c.canonical+')':' (no canonical)') }); });
  }
  out.push(finding('technical','Duplicate URL variants',4,dupEv.length?'warn':'pass',
    dupEv.length?(dupEv.length+' variant URL'+(dupEv.length===1?'':'s')+' answer 200 as separate pages'):'Variants redirect or point their canonical at the real URL',
    dupEv,'301 trailing-slash, uppercase and /index.html variants to the real URL, and make every page\'s canonical point at its clean URL (so ?utm links fold into it).'));
  // Sitemap quality.
  const smUrls=disc.sitemapUrls||[];
  if(smUrls.length){
    const badSm=[];
    for(const u of smUrls.slice(0,400)){ const c=await checkUrl(u); if(!c||!c.status||c.challenged) continue;
      if(c.status!==200) badSm.push({ url:u, snippet:u+' → '+c.status+(c.location?' → '+c.location:'') });
      else if(c.noindex) badSm.push({ url:u, snippet:u+' → 200 but noindex' }); }
    out.push(finding('technical','Sitemap lists only live, indexable URLs',6,badSm.length?'fail':'pass',
      badSm.length?(badSm.length+' of '+smUrls.length+' sitemap URLs redirect, error or are noindex'):('All '+smUrls.length+' sitemap URLs answer 200 and are indexable'),
      badSm,'List only final, indexable (200, no noindex) URLs in the sitemap; drop redirects and dead pages.'));
    const lm=disc.lastmod||{}, withLm=smUrls.filter(u=>lm[u]), days=new Set(withLm.map(u=>String(lm[u]).slice(0,10)));
    const missing=smUrls.length-withLm.length, same=withLm.length>=5&&days.size===1;
    out.push(finding('technical','Sitemap lastmod dates',2,(missing||same)?'warn':'pass',
      missing?(missing+' of '+smUrls.length+' URLs have no <lastmod>'):same?('Every <lastmod> is '+[...days][0]+' (generated, not real edit dates)'):('Real <lastmod> dates on all '+smUrls.length+' URLs'),
      missing?smUrls.filter(u=>!lm[u]).slice(0,5).map(u=>({ url:u, snippet:'<url><loc>'+u+'</loc> — no <lastmod>' })):same?withLm.slice(0,3).map(u=>({ url:u, snippet:'<lastmod>'+lm[u]+'</lastmod>' })):[],
      'Give every sitemap URL a <lastmod> that changes only when that page\'s content changes.'));
  }
  // robots.txt blocking CSS/JS or important pages.
  if(robots!=null){
    const rules=robotsRulesFor(robots,'Googlebot'), blocked=[];
    const assets=home&&home._assets?home._assets.scripts.concat(home._assets.css):[];
    const test=(u,kind)=>{ try{ const x=new URL(u); if(siteKey(x.hostname)!==siteKey(new URL(disc.base).hostname)) return; const r=robotsAllowed(rules,x.pathname+x.search); if(!r.allowed) blocked.push({ url:u, snippet:kind+' '+x.pathname+' blocked by "Disallow: '+r.rule+'"' }); }catch(e){} };
    assets.forEach(u=>test(u,'asset'));
    [home].concat(ctx.money).filter(Boolean).forEach(p=>test(p.url,'page'));
    out.push(finding('technical','robots.txt allows CSS, JS and key pages',6,blocked.length?'fail':'pass',
      blocked.length?(blocked.length+' important URL'+(blocked.length===1?' is':'s are')+' disallowed for Googlebot'):'Googlebot can fetch the homepage, key pages and their CSS/JS',
      blocked,'Remove the Disallow rules that cover CSS/JS files and important pages; Google needs them to render and rank the page.'));
  }
  // Core Web Vitals field data (real Chrome users, from PageSpeed's CrUX data).
  const field=(ctx.speedRuns||[]).map(s=>s.mobile&&s.mobile.fieldData).find(Boolean);
  if(field&&field.origin&&field.origin.category){
    const cat=field.origin.category, st=cat==='FAST'?'pass':cat==='AVERAGE'?'warn':'fail';
    out.push(finding('technical','Core Web Vitals (real users)',6,st,'Origin field data: '+cat.toLowerCase().replace('_',' ')+fieldMetrics(field.origin),
      [{ url:disc.base, snippet:'CrUX origin: '+cat+fieldMetrics(field.origin) }],'Fix the slow metric first (usually LCP: hero image size and server response).'));
  } else out.push(finding('technical','Core Web Vitals (real users)',0,'info','No Chrome UX Report field data for this site (too little traffic) — lab PageSpeed only',[],''));
  return out;
}
const fieldMetrics=f=>(f.lcp!=null?' · LCP '+(f.lcp/1000).toFixed(1)+'s':'')+(f.inp!=null?' · INP '+f.inp+'ms':'')+(f.cls!=null?' · CLS '+f.cls:'');

// Deduct site findings from their components: fail = full points, warn = half; floor 0. Each component keeps its list.
function applyDeductions(components, findings){
  Object.keys(components).forEach(k=>{ const c=components[k]; if(!c) return; const mine=findings.filter(f=>f.component===k);
    const d=mine.reduce((a,f)=>a+(f.status==='fail'?f.points:f.status==='warn'?f.points/2:0),0);
    c.base=c.score; c.deducted=Math.round(d*10)/10; c.score=Math.round(clamp100(c.score-d));
    c.findings=mine.filter(f=>f.status==='fail'||f.status==='warn').map(f=>({ label:f.label, status:f.status, points:f.status==='fail'?f.points:f.points/2 })); });
}
function setPageCheck(p, label, chk){ const i=p.checks.findIndex(c=>c.label===label); const c=Object.assign({cat:(i>=0?p.checks[i].cat:'On-Page Content')},chk); if(i>=0) p.checks[i]=c; else p.checks.push(c); }
// Fetch the size (and type) of every asset on the key pages, then redo their weight + image checks with real bytes.
async function measureAssets(pages, cap){
  const seen=new Set();
  for(const p of pages){
    const a=p._assets; if(!a) continue;
    const list=a.scripts.concat(a.css, a.images.map(i=>i.url)).slice(0,120);
    const fresh=list.filter(u=>!seen.has(u)); if(seen.size+fresh.length>cap) continue; fresh.forEach(u=>seen.add(u));
    const res=await Promise.all(list.map(u=>checkUrl(u)));
    const size={}; res.forEach((c,i)=>{ if(c&&c.status===200&&c.bytes){ size[list[i]]=c.bytes; if(c.contentType) size['ct:'+list[i]]=c.contentType; } });
    const sum=arr=>arr.reduce((t,u)=>t+(size[u]||0),0);
    const m={ js:sum(a.scripts), css:sum(a.css), img:sum(a.images.map(i=>i.url)),
      top:list.filter(u=>size[u]).sort((x,y)=>size[y]-size[x]).slice(0,5).map(u=>({url:u, bytes:size[u]})) };
    // Largest files per type (for 'CSS too heavy: … (largest file: …)').
    const byType={ js:a.scripts, css:a.css, img:a.images.map(i=>i.url) };
    m.topByTypeList={}; m.topByType={};
    Object.keys(byType).forEach(k=>{ const l=byType[k].filter(u=>size[u]).sort((x,y)=>size[y]-size[x]).slice(0,5).map(u=>({url:u, bytes:size[u]})); m.topByTypeList[k]=l; m.topByType[k]=l[0]||null; });
    setPageCheck(p,'Reasonable page weight',weightCheck(p.bytes||0,a,m));
    setPageCheck(p,'Image efficiency',imageCheck(a,size));
    p.assetBytes={ js:m.js, css:m.css, img:m.img };
  }
}
// ---------- Phase 3 — on-page ----------
// Approximate pixel width of a title in Google's results (Arial ~20px); Google truncates around 580–600px.
function titlePixels(t){ let w=0; for(const ch of String(t)){
  if(/[iljI.,:;|!'’`]/.test(ch)) w+=5.6; else if(/[mwMW@]/.test(ch)) w+=16.7; else if(/[A-Z]/.test(ch)) w+=13.3; else if(/[0-9]/.test(ch)) w+=11.1;
  else if(ch===' ') w+=5.6; else if(/[frt]/.test(ch)) w+=6.7; else w+=10; } return Math.round(w); }
const RE_TITLE_SEP=/\s[-–—|•·:]\s|\s?[|•·]\s?/g;
// The service or place a money page is about, from its URL slug ("/services/flatbed-towing" -> flatbed, towing).
function slugTerms(u, type){
  const last=(pathSegs(u).pop()||'').replace(/\.(html?|php)$/,'').replace(RE_STATE_SLUG,'');
  const stop=/^(and|the|for|with|near|in|of|a|to|service|services|our|oh|page)$/;
  const words=last.split('-').filter(w=>w.length>=3&&!stop.test(w));
  return type==='location'?[words.join(' ')].filter(Boolean):words;
}
function titleQualityCheck(title, url, type){
  const t=String(title||'').trim();
  if(!t) return { label:'Title quality', points:0, status:'na', detail:'No title (see Title tag present)', evidence:[], why:'', fix:'' };
  const seps=(t.match(RE_TITLE_SEP)||[]).length, trailing=/[-–—|•·:]\s*$/.test(t), px=titlePixels(t);
  const money=type==='service'||type==='location';
  // This page's own service words and place, from its own slug ("towing-in-grove-city-ohio" -> towing / grove city).
  const sp=slugParts(url);
  const place=money?(sp?sp.city:(type==='location'?placeOfSlug(url):null)):null;
  const svc=money?(sp?sp.service:(type==='service'?slugTerms(url,'service'):[])):[];
  // Case-insensitive, punctuation-blind: "Grove City, OH", "grove city ohio" and "Grove City" all name the place.
  const nt=' '+normPlace(t)+' ';
  const missPlace=!!place && nt.indexOf(' '+normPlace(place)+' ')<0;
  const missSvc=type==='service' && svc.length && !svc.some(w=>nt.indexOf(' '+normPlace(w))>=0);
  const tc=s=>String(s).replace(/\b[a-z]/g,c=>c.toUpperCase());
  const suggestion=(svc.length?tc(svc.join(' ')):'Towing')+(place?' in '+tc(place):'')+' | Your Business Name';
  const probs=[];
  if(missPlace) probs.push({ s:'fail', t:'does not name the place ('+tc(place)+')' });
  if(missSvc) probs.push({ s:'fail', t:'does not name the service ('+svc.join(' ')+')' });
  if(seps>=3) probs.push({ s:'fail', t:seps+' separators' });
  if(trailing) probs.push({ s:'fail', t:'ends with a separator' });
  if(px>580) probs.push({ s:'warn', t:'~'+px+'px wide (Google cuts at ~580px)' });
  const st=probs.some(p=>p.s==='fail')?'fail':probs.length?'warn':'pass';
  return { label:'Title quality', points:4, status:st, problem:st==='pass'?null:'Title '+probs.map(p=>p.t).join(', '), detail:st==='pass'?('"'+snip(t,70)+'" · ~'+px+'px'):('Title '+probs.map(p=>p.t).join(', ')),
    evidence:st==='pass'?[]:[{ snippet:'<title>'+snip(t,120)+'</title>' }],
    why:'The title is the headline in Google. On a money page it has to name the service or the town, once, and fit on screen.',
    fix:money?'Lead with this page\'s service'+(place?' and town':'')+', then the brand once, e.g. "'+suggestion+'" — at most two separators.':'Keep one or two separators and under ~580px (≈55 characters).' };
}
// The town a location page is about, from its slug: "/service-area/grove-city" -> grove city,
// "/towing-dublin-oh" -> dublin (service words dropped).
function placeOfSlug(u){
  const last=(pathSegs(u).pop()||'').replace(/\.(html?|php)$/,'').replace(RE_STATE_SLUG,'');
  const words=last.split('-').filter(w=>w&&!RE_SLUG_STOP.test(w)&&!RE_SVC_WORD.test(w));
  return words.join(' ')||null;
}
const GENERIC_H1=/^(gallery|contact( us)?|inquire|services|pay now|home|about( us)?|blog|welcome|untitled|page)$/i;
// The business name alone ("Capital Towing & Recovery", "Welcome to Capital Towing") says who, not what or where.
const normBrand=s=>String(s||'').toLowerCase().replace(/&amp;/g,'&').replace(/^welcome to\s+/,'').replace(/\b(llc|inc|co|corp|ltd|the)\b\.?/g,' ').replace(/[^a-z0-9&]+/g,' ').replace(/\s+/g,' ').trim();
function genericH1Check(h1, brands){
  const t=String(h1||'').replace(/\s+/g,' ').trim();
  if(!t) return { label:'Specific H1', points:0, status:'na', detail:'No H1 (see Exactly one H1 heading)', evidence:[], why:'', fix:'' };
  const brandOnly=!!normBrand(t)&&(brands||[]).some(b=>normBrand(b)===normBrand(t));
  const bad=GENERIC_H1.test(t)||brandOnly;
  return { label:'Specific H1', points:3, status:bad?'fail':'pass', problem:brandOnly?'H1 is only the business name':null, detail:bad?('H1 is just "'+t+'"'+(brandOnly?' (the business name)':'')):('H1: "'+snip(t,70)+'"'), evidence:bad?[{ snippet:'<h1>'+t+'</h1>' }]:[],
    why:'A one-word H1 like "Gallery" or "Contact" tells Google and AI nothing about the business, service or town.',
    fix:'Rewrite the H1 to say what the page offers and where, e.g. "Towing & Auto Repair Photos — Columbus, OH".' };
}
function descEqualsTitleCheck(title, desc){
  const same=title&&desc&&title.trim().toLowerCase()===desc.trim().toLowerCase();
  return { label:'Meta description differs from title', points:1, status:same?'warn':'pass', detail:same?'The meta description repeats the title':'Distinct title and description',
    evidence:same?[{ snippet:'<meta name="description" content="'+snip(desc,100)+'">' }]:[], why:'A description that repeats the title wastes the second line of your Google listing.', fix:'Write a description that adds the offer, the area and a reason to call.' };
}
const RE_GENERIC_ANCHOR=/^(click here|read more|learn more|more|here|details|view more|see more|find out more|more info|continue reading|click)$/i;
function genericAnchorCheck(anchors){
  const toMoney=anchors.filter(a=>/^(service|location)$/.test(classifyPage(a.url,[])));
  if(!toMoney.length) return { label:'Descriptive links to money pages', points:1, status:'na', detail:'N/A — no links to service or location pages', evidence:[], why:'', fix:'' };
  const bad=toMoney.filter(a=>RE_GENERIC_ANCHOR.test(a.text||''));
  return { label:'Descriptive links to money pages', points:1, status:bad.length?'warn':'pass',
    detail:bad.length?(bad.length+' link'+(bad.length===1?'':'s')+' to service/location pages say only "'+bad[0].text+'"'):'Links to service/location pages use descriptive text',
    evidence:bad.slice(0,5).map(a=>({ snippet:'<a href="'+a.href+'">'+a.text+'</a>' })),
    why:'Anchor text tells Google what the linked page is about. "Click here" wastes that signal on your most important pages.', fix:'Use the service or town as the link text, e.g. "flatbed towing" or "towing in Dublin".' };
}
// Link health: weakly linked money pages and internal nofollow.
function onPageLinkFindings(ok){
  const out=[], money=ok.filter(p=>p.pageType==='service'||p.pageType==='location');
  const weak=money.filter(p=>p.inlinks<3||(p.clickDepth!=null&&p.clickDepth>3)||p.clickDepth==null);
  out.push(finding('linkHealth','Money pages well linked',weak.length,weak.length?'fail':'pass',
    weak.length?(weak.length+' service/location page'+(weak.length===1?' has':'s have')+' <3 internal links or sit >3 clicks deep (−1 each)'):'Every service/location page has 3+ internal links and is ≤3 clicks from home',
    weak.map(p=>({ url:p.url, snippet:p.inlinks+' inlink'+(p.inlinks===1?'':'s')+' · '+(p.clickDepth==null?'not reachable from the homepage':'depth '+p.clickDepth) })),
    'Link each service and town page from the homepage or the main menu/hub page, and from related pages.'));
  const nf=[]; ok.forEach(p=>(p._anchors||[]).filter(a=>a.nofollow).forEach(a=>nf.push({ url:p.url, snippet:'<a href="'+a.href+'" rel="nofollow">'+snip(a.text,40)+'</a>' })));
  out.push(finding('linkHealth','No internal nofollow links',4,nf.length?'warn':'pass',nf.length?(nf.length+' internal link'+(nf.length===1?' is':'s are')+' rel="nofollow"'):'No internal links use nofollow',nf,
    'Remove rel="nofollow" from links to your own pages — it stops them passing ranking value.'));
  return out;
}

// ---------- Phase 4 — content ----------
const nowYear=()=>new Date(_nowMs()).getUTCFullYear();
// Years-in-business statements: founding years ("since 1973", "established 1973", "est. 1973") and durations
// ("51 years", "for 30 years", "over 20 years of experience"). Each with its snippet.
// Each founding claim carries firstPerson: location pages describe the town ("the library has served the community since
// 1924"), so there only first-person sentences, a bare tag line or the explicit business forms count (the crawl applies
// it once page types are final).
function yearClaims(text){
  const out={ founded:[], years:[] }; const t=String(text); let m;
  // Words that make a founding year the business's own ("university-owned airport, established in 1943" is not ours).
  // "us" is matched case-sensitively, so "US 33" is a highway, not a pronoun.
  const FIRST_RE=/\b(we|we've|we're|our|ours)\b/i, US=/\b[Uu]s\b/;
  const OURS_RE=/\b(family|(?<!-)owned|(?<!-)operated|business|company|calls|jobs|customers|proudly|locally|serving|served|providing|trusted)\b/i;
  const FIRST={ test:s=>FIRST_RE.test(s)||US.test(s) }, OURS={ test:s=>FIRST.test(s)||OURS_RE.test(s) };
  const reF=/\b(since|established(?:\s+in)?|founded(?:\s+in)?|est\.?|serving\s+\w+\s+since|in\s+business\s+since)\s+((?:19|20)\d{2})\b/gi;
  while((m=reF.exec(t))){
    // Only the business's own founding: "in business since", "serving Columbus since", a bare "Since 1973" / "Est. 1973" /
    // "Trusted since 1973" tag line, or a sentence about us ("we have", "our family", "100,000 calls completed since 2020"). "The
    // governor's residence since 1957" or "the stadium, established 1999" describes a place on the page, not the business.
    let ctx, sure=/^(in\s+business|serving)/i.test(m[1]);
    // A window of whole words only: a cut "Columbus" must not read as "us". Sentences end at ". " or, where blocks were
    // joined without a space, at ".Next".
    const win=(a,b)=>{ a=Math.max(0,a); b=Math.min(t.length,b); let w=t.slice(a,b);
      if(a>0&&/\S/.test(t[a-1])) w=w.replace(/^\S*/,''); if(b<t.length&&/\S/.test(t[b])) w=w.replace(/\S*$/,''); return w; };
    const SENT=/[.!?](?:\s|(?=[A-Z]))|\n/;
    if(/^[A-Z]/.test(m[1])&&t[m.index+m[0].length]===','){
      // A sentence that opens "Since 2012, ..." is about whatever follows: "Since 2012, we have ..." vs "Since 2012, parking on campus ...".
      ctx=win(m.index+m[0].length, m.index+m[0].length+80).split(SENT)[0];
    } else {
      // A capitalised "Since" right after a word with no punctuation starts a new block (heading, list item).
      ctx=/^[A-Z]/.test(m[1])&&/[a-z0-9]\s*$/.test(t.slice(Math.max(0,m.index-2), m.index))?''
        :win(m.index-90, m.index).split(SENT).pop().trim();
      if(ctx.split(/\s+/).filter(Boolean).length<=1) sure=true; // tag line
    }
    if(!sure&&!OURS.test(ctx)) continue;
    out.founded.push({ year:+m[2], firstPerson:sure||FIRST.test(ctx), snippet:snip(t.slice(Math.max(0,m.index-40), m.index+m[0].length+40),120) }); }
  const reY=/\b(over|more than|nearly|almost|for)?\s*(\d{1,3})\+?\s+years?\b(?!\s+old)/gi;
  while((m=reY.exec(t))){ const n=+m[2]; const ctx=t.slice(Math.max(0,m.index-60), m.index+m[0].length+60);
    if(n<3||n>150) continue;
    if(!/(experience|in business|serving|family|owned|operat|trusted|company|since|history|years? of|providing|helping)/i.test(ctx)) continue;
    out.years.push({ n, atLeast:/over|more than/i.test(m[1]||''), snippet:snip(ctx,130) }); }
  return out;
}
function staleClaimsCheck(pageClaims, siteFounded){
  const founded=siteFounded||(pageClaims.founded[0]&&pageClaims.founded[0]);
  if(!pageClaims.years.length && !pageClaims.founded.length) return { label:'Years-in-business claims current', points:0, status:'na', detail:'No years-in-business claims', evidence:[], why:'', fix:'' };
  if(!founded||!pageClaims.years.length) return { label:'Years-in-business claims current', points:0, status:'na', detail:'Claims found but nothing to check them against', evidence:pageClaims.years.concat(pageClaims.founded).slice(0,2).map(c=>({ snippet:c.snippet })), why:'', fix:'' };
  const actual=nowYear()-founded.year;
  const bad=pageClaims.years.filter(c=>c.atLeast?c.n>actual+1:Math.abs(c.n-actual)>1);
  return { label:'Years-in-business claims current', points:3, status:bad.length?'fail':'pass',
    detail:bad.length?('Says "'+bad[0].n+' years" but founded '+founded.year+' = '+actual+' years in '+nowYear()):('Year claims match founding in '+founded.year),
    evidence:bad.length?[{ snippet:bad[0].snippet },{ url:founded.url, snippet:founded.snippet }]:[],
    why:'A hard-coded "51 years" that no longer matches "since 1973" tells visitors (and AI) the site is not maintained.',
    fix:'Say "since '+founded.year+'" instead of a year count — it never goes stale.' };
}
const RE_PLACEHOLDER=/\b(lorem ipsum|dolor sit amet|coming soon|sample page|hello world!?|just another wordpress site|this is an example page|your (content|text) goes here|insert (your )?text here|edit this text|add your (content|text) here)\b/i;
function placeholderCheck(text){
  const m=String(text).match(RE_PLACEHOLDER);
  return { label:'No placeholder text', points:5, status:m?'fail':'pass', detail:m?('Contains "'+m[0]+'"'):'No template / placeholder text',
    evidence:m?[{ snippet:snip(String(text).slice(Math.max(0,m.index-50), m.index+m[0].length+50),130) }]:[],
    why:'Leftover template text ("lorem ipsum", "sample page", "coming soon") looks abandoned to visitors and low-quality to Google.', fix:'Replace or remove the placeholder text.' };
}
function defaultPrivacyCheck(url, text){
  if(!/privacy/i.test(url)) return null;
  const m=String(text).match(/Suggested text:|When visitors leave comments on the site/i);
  return { label:'Real privacy policy (not the WordPress default)', points:3, status:m?'fail':'pass', detail:m?'The WordPress sample privacy policy is still published':'Custom privacy policy',
    evidence:m?[{ snippet:snip(String(text).slice(Math.max(0,m.index-30), m.index+140),160) }]:[],
    why:'The default WordPress policy (with "Suggested text:" notes) describes comment cookies, not your business — it is not a valid policy for the tracking you run.',
    fix:'Replace it with a policy that covers the forms, analytics, pixels and call tracking the site actually uses.' };
}
// Hours statements: round-the-clock claims and specific opening times.
const RE_24_7=/\b(24\s*\/\s*7|24\/7\/365|24 hours a day|24-hour|24 hour|around the clock|never close[sd]?|open 24)\b/i;
const RE_HOURS=/\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b[^.\n]{0,25}?\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)/i;
function contentFreshnessFindings(ok){
  const out=[];
  const posts=ok.filter(p=>p.pageType==='blog'&&p.datePublished);
  const days={}; posts.forEach(p=>{ const d=String(p.datePublished).slice(0,10); (days[d]=days[d]||[]).push(p.url); });
  const one=posts.length>=3&&Object.keys(days).length===1;
  out.push(finding('freshness','Blog posts have their own dates',20,one?'fail':posts.length>=3?'pass':'info',
    one?('All '+posts.length+' blog posts are dated '+Object.keys(days)[0]):posts.length>=3?(posts.length+' posts across '+Object.keys(days).length+' dates'):'Fewer than 3 dated blog posts',
    one?posts.slice(0,5).map(p=>({ url:p.url, snippet:'datePublished '+String(p.datePublished).slice(0,10) })):[],
    'Publish posts over time with their real dates — a batch dropped in on one day reads as imported filler.'));
  const home=ok.find(p=>p.pageType==='home')||ok[0];
  const txt=home&&home._html?home._html.replace(/<[^>]+>/g,' '):'';
  const cm=[...txt.matchAll(/(?:©|&copy;|copyright)\s*(?:(?:19|20)\d{2}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map(m=>({ y:+m[1], s:snip(m[0],60) }));
  if(cm.length){ const c=cm.sort((a,b)=>b.y-a.y)[0], old=c.y<nowYear();
    out.push(finding('freshness','Copyright year current',10,old?'warn':'pass',old?('Footer says '+c.y+' in '+nowYear()):('Footer year '+c.y),old?[{ url:home.url, snippet:c.s }]:[],'Update the footer year (or print it automatically).')); }
  else out.push(finding('freshness','Copyright year current',0,'info','No copyright year found',[],''));
  return out;
}
// Contradictions across pages (feeds duplication): arrival times, hours, years in business.
function contradictionFindings(ok){
  const out=[];
  // Arrival times: only statements about arriving ("reached in", "arrive within", "response time"), compared within
  // the same scope — "most metro calls in 20–40" and "outer communities in 40–60" are two promises, not a clash;
  // "a lockout takes 5–15 minutes" is a job duration, not an arrival time.
  const eta=[];
  ok.filter(p=>p.pageType!=='location'&&p.pageType!=='utility').forEach(p=>{ const t=(p._blocks||[]).join('\n'); let m; const re=/\b(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:min|minutes)\b/gi;
    while((m=re.exec(t))){ const before=t.slice(Math.max(0,m.index-70), m.index);
      if(!/(reach|arriv|respon|get to (you|me)|on scene|on-scene|\beta\b|there (in|within)|dispatch(ed)? (in|within))/i.test(before)) continue;
      if(/(take|takes|resolve|opened|done|finish|complete|install|last)/i.test(before.slice(-30))) continue;
      // Scope from the clause the range sits in ("Delaware is one of our outer communities, where most calls are
      // reached in 40 to 60" is the outer promise even though "outer" is 50 characters back), not a fixed window.
      const clause=t.slice(Math.max(0,m.index-160), m.index).split(/[.!?;\n]\s|\n|\band\b|\bwhile\b|\bbut\b/i).pop();
      const scope=/(outer|outlying|rural|surrounding|farther|further|outside)/i.test(clause)?'outer':'core';
      eta.push({ url:p.url, scope, range:m[1]+'–'+m[2], snippet:snip(t.slice(Math.max(0,m.index-60), m.index+m[0].length+30),120) }); } });
  const byScope={}; eta.forEach(e=>{ (byScope[e.scope]=byScope[e.scope]||new Set()).add(e.range); });
  const clash=Object.keys(byScope).filter(k=>byScope[k].size>1);
  const clashRanges=clash.flatMap(k=>[...byScope[k]]);
  out.push(finding('duplication','Consistent arrival-time claims',6,clash.length?'fail':'pass',
    clash.length?('Pages promise '+clashRanges.slice(0,4).join(' / ')+' minutes for the same area'):eta.length?('Arrival times stated consistently ('+Object.keys(byScope).map(k=>[...byScope[k]].join('/')+' min '+(k==='outer'?'outer area':'core area')).join('; ')+')'):'No arrival-time claims',
    clash.length?clashRanges.slice(0,4).map(r=>{ const e=eta.find(x=>x.range===r&&clash.includes(x.scope)); return { url:e.url, snippet:e.snippet }; }):[],
    'Use one arrival-time promise per area, the same on every page (per-town times belong on the town pages).'));
  // Hours: a 24/7 claim clashes with set hours — unless the set hours are explicitly for the office / shop / yard.
  const h24=[], hrs=[];
  // Blog posts talk about other businesses (impound lots, dealers), so they are not the business's own hours.
  ok.filter(p=>p.pageType!=='blog').forEach(p=>{ const t=(p._blocks||[]).join('\n'); const a=t.match(RE_24_7);
    if(a) h24.push({ url:p.url, snippet:snip(t.slice(Math.max(0,a.index-50), a.index+a[0].length+40),110) });
    const re=new RegExp(RE_HOURS.source,'gi'); let b;
    while((b=re.exec(t))){ const before=t.slice(Math.max(0,b.index-60), b.index);
      if(/(office|shop|yard|lobby|repair|service department|parts|store|showroom|garage|counter|pick-?up|business hours for)/i.test(before)) continue;
      // Someone else's hours, attributed on the page ("The City lists vehicle retrieval as Monday–Friday 10–4",
      // "per the county's site", "their hours are"), are not the business's hours.
      const sentence=t.slice(Math.max(0,b.index-220), b.index).replace(/\b([ap])\.m\./gi,'$1m').split(/[.!?]\s|\n/).pop();
      if(/\b(the city|city's|county|county's|state's|according to|per the|per its|per their|lists|posts|their|its hours|retrieval)\b/i.test(sentence)) continue;
      hrs.push({ url:p.url, snippet:snip(t.slice(Math.max(0,b.index-40), b.index+b[0].length),110) }); break; } });
  const conflict=h24.length&&hrs.length;
  out.push(finding('duplication','Consistent hours claims',6,conflict?'fail':'pass',
    conflict?(h24.length+' page'+(h24.length===1?' says':'s say')+' 24/7, '+hrs.length+' list'+(hrs.length===1?'s':'')+' set hours'):(h24.length?'24/7 stated consistently':hrs.length?'Set hours stated consistently':'No hours claims'),
    conflict?[h24[0],hrs[0]].concat(h24.slice(1,2),hrs.slice(1,2)):[],
    'Say which service runs 24/7 and which keeps office hours ("24/7 towing · shop open Mon–Fri 8–5") — the same way on every page.',
    { claims24_7:h24.map(x=>x.url) }));
  const yc=ok.map(p=>({ p, c:p._yearClaims||{founded:[],years:[]} }));
  const fy=[...new Set(yc.flatMap(x=>x.c.founded.map(f=>f.year)))], yn=[...new Set(yc.flatMap(x=>x.c.years.filter(y=>!y.atLeast).map(y=>y.n)))];
  const yConf=fy.length>1||yn.length>1;
  const yev=[]; if(fy.length>1) fy.slice(0,3).forEach(y=>{ const x=yc.find(z=>z.c.founded.some(f=>f.year===y)); yev.push({ url:x.p.url, snippet:x.c.founded.find(f=>f.year===y).snippet }); });
  if(yn.length>1) yn.slice(0,3).forEach(n=>{ const x=yc.find(z=>z.c.years.some(f=>f.n===n)); yev.push({ url:x.p.url, snippet:x.c.years.find(f=>f.n===n).snippet }); });
  out.push(finding('duplication','Consistent years-in-business claims',6,yConf?'fail':'pass',
    yConf?((fy.length>1?'Founding years '+fy.join(' / '):'')+(fy.length>1&&yn.length>1?' · ':'')+(yn.length>1?'Year counts '+yn.join(' / '):'')):'Years in business stated consistently',
    yev,'Pick one founding year and use it everywhere ("since 1973").'));
  return out;
}

// ---------- Phase 5 — local SEO ----------
const termRe=t=>new RegExp('\\b'+String(t).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/[\s-]+/g,'[\\s-]+')+'\\b','i');
// Industry service taxonomy vs the site: covered = a service page of its own (URL, title or H1 names it),
// partial = mentioned somewhere but no page, missing = not mentioned. Score = covered / taxonomy size.
function serviceCoverage(ok, industry){
  if(!industry||!industry.services) return null;
  const svc=ok.filter(p=>p.pageType==='service'), text=ok.map(p=>({ url:p.url, t:(p._pageText||'') }));
  const rows=industry.services.map(s=>{
    const res=(s.terms||[s.name]).map(termRe);
    const page=svc.find(p=>res.some(r=>r.test(pathSegs(p.url).join(' ').replace(/-/g,' '))||r.test(p.title||'')||r.test(p.h1text||'')));
    if(page) return { service:s.name, status:'covered', url:page.url };
    const m=text.find(x=>res.some(r=>r.test(x.t)));
    if(m){ const r=res.find(r=>r.test(m.t)), i=m.t.search(r); return { service:s.name, status:'partial', url:m.url, snippet:snip(m.t.slice(Math.max(0,i-40), i+60),100) }; }
    return { service:s.name, status:'missing' };
  });
  const covered=rows.filter(r=>r.status==='covered').length;
  return { rows, covered, partial:rows.filter(r=>r.status==='partial').length, missing:rows.filter(r=>r.status==='missing').length, size:rows.length, score:Math.round(100*covered/rows.length) };
}
// Market towns vs the location pages (only when the audit input supplies the market's city list).
function locationCoverage(ok, market){
  if(!market||!market.cities||!market.cities.length) return null;
  const locs=ok.filter(p=>p.pageType==='location');
  const rows=market.cities.map(c=>{ const r=termRe(c); const pg=locs.find(p=>r.test(pathSegs(p.url).join(' ').replace(/-/g,' '))||r.test(p.title||'')||r.test(p.h1text||'')); return { city:c, status:pg?'covered':'missing', url:pg&&pg.url||null }; });
  const covered=rows.filter(r=>r.status==='covered').length;
  return { rows, covered, size:rows.length, score:Math.round(100*covered/rows.length) };
}
// Click-to-call near the top of the page. Estimated from document order (no mobile layout render): a tel: link in
// the header/nav, in a fixed/sticky call bar, or within the first ~1,200 characters of visible text.
function callAboveFoldCheck(doc, type){
  if(!/^(home|service|location)$/.test(type)) return { label:'Click-to-call at the top (mobile)', points:0, status:'na', detail:'Checked on the homepage and money pages', evidence:[], why:'', fix:'' };
  const tels=[...doc.querySelectorAll('a[href^="tel:"]')];
  const why='On a phone the first screen decides the call. A tap-to-call button there is the single biggest conversion win for a local service.', fix='Put a tap-to-call button in the header (sticky on mobile).';
  if(!tels.length) return { label:'Click-to-call at the top (mobile)', points:3, status:'fail', detail:'No tel: link on the page', evidence:[], why, fix };
  // Pass when any tel: link is (a) inside the header / nav, (b) inside a sticky or fixed element (a call bar that
  // follows the visitor), or (c) within the first ~20% of the body's HTML. Estimated from the markup — no layout render.
  const bodyHtml=(doc.body&&doc.body.innerHTML)||'';
  const frac=a=>{ const i=bodyHtml.indexOf(a.outerHTML); return i<0||!bodyHtml.length?1:i/bodyHtml.length; };
  const stickyUp=a=>{ for(let el=a; el&&el!==doc.body; el=el.parentElement){ const tag=((el.getAttribute&&(el.getAttribute('class')||''))+' '+(el.id||'')+' '+((el.getAttribute&&el.getAttribute('style'))||''));
      if(/(sticky|fixed|call-?bar|mobile-?call|floating|position\s*:\s*(fixed|sticky))/i.test(tag)) return true; } return false; };
  const why2=a=>a.closest('header,nav,[role="banner"]')?'in the header/navigation':stickyUp(a)?'in a sticky/fixed call bar':frac(a)<=0.2?'in the first '+Math.max(1,Math.round(frac(a)*100))+'% of the page':null;
  const top=tels.find(a=>why2(a));
  return { label:'Click-to-call at the top (mobile)', points:3, status:top?'pass':'fail',
    detail:top?('Tap-to-call '+why2(top)+': '+snip(top.textContent||top.getAttribute('href'),50)):'The first tel: link is '+Math.round(frac(tels[0])*100)+'% of the way down the page, not in the header or a sticky bar',
    evidence:[{ snippet:'<a href="'+(top||tels[0]).getAttribute('href')+'">'+snip((top||tels[0]).textContent,50)+'</a>' }], why, fix };
}
function areaCodeCheck(doc, market){
  const codes=market&&market.areaCodes;
  const nums=[...new Set([...doc.querySelectorAll('a[href^="tel:"]')].map(a=>(a.getAttribute('href')||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'')).filter(d=>d.length===10))];
  if(!codes||!nums.length) return { label:'Local area code', points:0, status:'na', detail:nums.length?'No market area codes supplied':'No phone link', evidence:[], why:'', fix:'' };
  const local=nums.filter(n=>codes.includes(n.slice(0,3)));
  return { label:'Local area code', points:0, status:'info', detail:local.length?('Local number ('+local[0].slice(0,3)+')'):('Phone '+nums[0].slice(0,3)+' is not a local '+codes.join('/')+' number'),
    evidence:[{ snippet:'tel:'+nums[0] }], why:'A local area code reassures callers they are reaching a nearby business.', fix:'' };
}
const RE_REVIEW_LINK=/(g\.page\/[^"'\s]*\/review|search\.google\.com\/local\/writereview|google\.com\/maps\/place|google\.com\/maps\?cid=|maps\.google\.com\/\?cid=|maps\.app\.goo\.gl|g\.co\/kgs|google-review|reviewSummary|elfsight|trustindex|embedsocial|reviewsonmywebsite|birdeye|podium|grade\.us|nicejob|sociablekit|widget\.trustmary|featurable)/i;
function localFindings(ok, ctx){
  const out=[], ind=_industry, home=ctx.home;
  // coverage: industry taxonomy + market towns
  const sc=serviceCoverage(ok, ind);
  if(sc) out.push(finding('coverage','Service coverage vs '+(ind.label||ind.name)+' services',20,sc.score>=60?'pass':sc.score>=30?'warn':'fail',
    sc.covered+' of '+sc.size+' services have their own page · '+sc.partial+' mentioned without a page · '+sc.missing+' missing',
    sc.rows.filter(r=>r.status!=='covered').slice(0,8).map(r=>({ url:r.url||'', snippet:r.service+': '+(r.status==='partial'?'mentioned, no page — "'+(r.snippet||'')+'"':'not mentioned') })),
    'Give each service you offer its own page (what it is, when to call, pricing factors, areas) — AI and Google match searches to pages, not to lists.',
    { matrix:sc }));
  const lc=locationCoverage(ok, _market);
  if(lc) out.push(finding('coverage','Location coverage vs market towns',15,lc.score>=60?'pass':lc.score>=30?'warn':'fail',lc.covered+' of '+lc.size+' market towns have a page',
    lc.rows.filter(r=>r.status==='missing').slice(0,8).map(r=>({ snippet:r.city+': no page' })),'Add a real page for each town you serve (roads, landmarks, local FAQs — not a template).',{ matrix:lc }));
  else out.push(finding('coverage','Location coverage vs market towns',0,'info','No market city list supplied with this audit',[],''));
  // Google reviews shown on the site
  const rv=ok.map(p=>({ p, m:(p._html||'').match(RE_REVIEW_LINK) })).filter(x=>x.m);
  out.push(finding('coverage','Google reviews shown on the site',6,rv.length?'pass':'warn',rv.length?('Review link/widget on '+rv.length+' page'+(rv.length===1?'':'s')):'No Google review link or reviews widget found',
    rv.length?rv.slice(0,3).map(x=>({ url:x.p.url, snippet:x.m[0] })):[{ url:(ok[0]||{}).url||'', snippet:'Checked '+ok.length+' pages: no Google review link (g.page, writereview, maps ?cid) and no reviews widget' }],'Show your real Google reviews on your website — that\'s what builds trust with visitors and AI — and link to your Google review page.'));
  const revPage=ok.find(p=>/(^|\/)(reviews?|testimonials?)(\/|$)/i.test(new URL(p.url).pathname));
  if(revPage) out.push(finding('linkHealth','Reviews page linked',4,revPage.inlinks>0?'pass':'warn',revPage.inlinks>0?('Reviews page has '+revPage.inlinks+' internal link'+(revPage.inlinks===1?'':'s')):'The reviews page exists but nothing links to it',
    [{ url:revPage.url, snippet:revPage.inlinks+' inlinks' }],'Link the reviews page from the menu and from every service page.'));
  // GBP comparison (Google Places data)
  const loc=ctx.local;
  if(loc&&loc.found){
    const probs=[], hp=ok.map(p=>p.nap||{}), phones=new Set(hp.flatMap(n=>(n.tel||[]).concat(n.visible||[]))), schemaNames=new Set(hp.flatMap(n=>(n.schema||{}).names||[]));
    const digits=s=>String(s||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
    if(loc.phone && ![...phones].some(p=>digits(p)===digits(loc.phone))) probs.push({ s:'fail', t:'GBP phone '+loc.phone+' is not on the site' });
    if(loc.name && schemaNames.size && ![...schemaNames].some(n=>n.toLowerCase()===String(loc.name).toLowerCase())) probs.push({ s:'warn', t:'GBP name "'+loc.name+'" vs schema "'+[...schemaNames][0]+'"' });
    if(loc.website){ try{ if(siteKey(new URL(loc.website).hostname)!==siteKey(new URL(ctx.disc.base).hostname)) probs.push({ s:'fail', t:'GBP website points to '+new URL(loc.website).hostname }); }catch(e){} }
    if(loc.address){ const street=normStreet(String(loc.address).split(',')[0]); const streets=new Set(hp.flatMap(n=>(n.streets||[]).concat((n.schema||{}).streets||[])));
      if(streets.size && !streets.has(street)) probs.push({ s:'warn', t:'GBP address "'+String(loc.address).split(',')[0]+'" not found on the site' }); }
    const h24=(ctx.claims24_7||[]).length;
    if(h24 && loc.hours && !loc.hours.open247) probs.push({ s:'fail', t:'Site claims 24/7 on '+h24+' page'+(h24===1?'':'s')+' but GBP hours are not 24 hours' });
    const st=probs.some(p=>p.s==='fail')?'fail':probs.length?'warn':'pass';
    out.push(finding('technical','Google Business Profile matches the site',8,st,st==='pass'?'Name, phone, address, website and hours agree with the site':probs.map(p=>p.t).join(' · '),
      [{ url:loc.mapsUrl||'', snippet:'GBP: '+[loc.name,loc.phone,loc.address,loc.website].filter(Boolean).join(' · ')+(loc.hours?' · hours: '+(loc.hours.open247?'open 24 hours':(loc.hours.weekdayText||[]).slice(0,2).join('; ')):'') }],
      'Make the Google Business Profile and the site say the same name, phone, address, website and hours — Google cross-checks them.'));
  } else out.push(finding('technical','Google Business Profile matches the site',0,'info',loc?'No Google Business Profile match found':'Google Places lookup not available for this audit',[],''));
  return out;
}

// ---------- Phase 6 — structured data ----------
// schema.org types in common use (plus every LocalBusiness subtype above). A type outside this list is almost always
// an invented one (e.g. "TowingService"), which search engines ignore.
const SCHEMA_TYPES=new Set(('Thing Action PropertyValueSpecification CommunicateAction Schedule DayOfWeek LocationFeatureSpecification CreativeWork Article BlogPosting NewsArticle LiveBlogPosting SocialMediaPosting DiscussionForumPosting Report TechArticle ScholarlyArticle '
  +'WebPage AboutPage ContactPage CollectionPage FAQPage QAPage ItemPage ProfilePage SearchResultsPage CheckoutPage MedicalWebPage RealEstateListing WebSite WebPageElement '
  +'SiteNavigationElement WPHeader WPFooter WPSideBar WPAdBlock Table ImageObject VideoObject AudioObject MediaObject Photograph ImageGallery VideoGallery MediaGallery Book Movie '
  +'MusicRecording Recipe Review AggregateRating Rating EmployerAggregateRating ClaimReview Question Answer Comment HowTo HowToStep HowToSection HowToTool HowToSupply '
  +'HowToDirection HowToTip Course Event BusinessEvent Place Organization Corporation NGO OnlineBusiness OnlineStore Person Product Offer AggregateOffer OfferCatalog Brand '
  +'Service FinancialProduct BroadcastService CableOrSatelliteService GovernmentService TaxiService Taxi FoodService PostalAddress GeoCoordinates GeoShape GeoCircle ContactPoint '
  +'OpeningHoursSpecification SpecialAnnouncement BreadcrumbList ListItem ItemList PropertyValue QuantitativeValue MonetaryAmount PriceSpecification UnitPriceSpecification '
  +'CompoundPriceSpecification DeliveryChargeSpecification PaymentMethod PaymentChargeSpecification SpeakableSpecification EntryPoint SearchAction ReadAction OrderAction ReserveAction '
  +'ContactAction ViewAction WatchAction InteractionCounter Country State City AdministrativeArea PostalCodeRangeSpecification ServiceChannel Language Audience PeopleAudience '
  +'BusinessAudience DefinedTerm DefinedTermSet CreativeWorkSeries WebApplication SoftwareApplication MobileApplication Dataset DataCatalog Map Menu MenuItem MenuSection '
  +'Reservation Ticket Trip JobPosting Occupation Vehicle Car Motorcycle BusOrCoach Duration Distance ProductModel IndividualProduct SomeProducts ProductGroup Accommodation '
  +'House Apartment Residence CivicStructure Airport Park ParkingFacility TouristAttraction LandmarksOrHistoricalBuildings BodyOfWater PlaceOfWorship Church School '
  +'CollegeOrUniversity EducationalOrganization MedicalOrganization WarrantyPromise Demand Episode TVSeries Clip Blog Collection Quotation Poster NewsMediaOrganization '
  +'SportsOrganization GovernmentOrganization ResearchOrganization Consortium LocalBusiness Project VirtualLocation MerchantReturnPolicy ShippingDeliveryTime OfferShippingDetails '
  +'DefinedRegion Observation StatisticalVariable Grant FundingScheme Legislation Guide Thesis '
  // Place / CivicStructure / Landform / EducationalOrganization / Event subtypes (schema.org vocabulary).
  +'TouristDestination Landform Mountain Volcano Continent LakeBodyOfWater RiverBodyOfWater Reservoir Pond Canal Waterfall SeaBodyOfWater '
  +'Aquarium Beach BoatTerminal Bridge BusStation BusStop Cemetery Crematorium EventVenue GovernmentBuilding CityHall Courthouse '
  +'DefenceEstablishment Embassy LegislativeBuilding MovieTheater Museum MusicVenue PerformingArtsTheater Playground PublicToilet RVPark '
  +'StadiumOrArena SubwayStation TaxiStand TrainStation Zoo FireStation PoliceStation Hospital Library ShoppingCenter GolfCourse '
  +'BuddhistTemple CatholicChurch HinduTemple Mosque Synagogue ElementarySchool MiddleSchool HighSchool Preschool '
  +'SportsEvent MusicEvent Festival FoodEvent SocialEvent ExhibitionEvent ComedyEvent TheaterEvent ScreeningEvent SaleEvent '
  +'EducationEvent ChildrensEvent DanceEvent LiteraryEvent VisualArtsEvent EventSeries CourseInstance').split(' '));
const isKnownType=t=>SCHEMA_TYPES.has(t)||isLocalType(t)||ORG_TYPES.test(t)||/:/.test(t);
function jsonLdSyntaxCheck(doc){
  const scripts=[...doc.querySelectorAll('script[type="application/ld+json"]')];
  if(!scripts.length) return { label:'JSON-LD syntax valid', points:0, status:'na', detail:'No JSON-LD on the page', evidence:[], why:'', fix:'' };
  const bad=[]; scripts.forEach((s,i)=>{ try{ JSON.parse(s.textContent); }catch(e){ bad.push({ snippet:'<script type="application/ld+json"> #'+(i+1)+': '+snip(e.message,60)+' — '+snip(s.textContent,80) }); } });
  return { label:'JSON-LD syntax valid', points:3, status:bad.length?'fail':'pass', detail:bad.length?(bad.length+' of '+scripts.length+' JSON-LD blocks do not parse'):(scripts.length+' JSON-LD block'+(scripts.length===1?'':'s')+' parse cleanly'),
    evidence:bad, why:'A JSON-LD block with a syntax error is thrown away whole — none of its structured data counts.', fix:'Fix the JSON (usually a trailing comma or an unescaped quote) and re-test in Google\'s Rich Results Test.' };
}
function businessEntityCheck(nodes){
  const biz=nodes.filter(n=>!isDescribedPlace(n)&&typesOf(n).some(t=>isLocalType(t)||ORG_TYPES.test(t))&&(n.name||n['@id']));
  // A nested copy without @id but with the same name as an @id'd entity is the same entity.
  const idByName={}; biz.forEach(n=>{ if(n['@id']&&n.name) idByName[String(n.name).toLowerCase()]=n['@id']; });
  let keys=[...new Set(biz.map(n=>n['@id']||idByName[String(n.name).toLowerCase()]||('name:'+String(n.name).toLowerCase())))];
  // Entities explicitly tied together (parentOrganization / branchOf / subOrganization) count as one business.
  const refs=v=>[].concat(v||[]).map(x=>x&&typeof x==='object'?x['@id']:x).filter(Boolean);
  const linked=new Set(); biz.forEach(n=>{ refs(n.parentOrganization).concat(refs(n.branchOf),refs(n.subOrganization)).forEach(id=>{ if(keys.includes(id)&&n['@id']){ linked.add(id); linked.add(n['@id']); } }); });
  if(linked.size) keys=keys.filter(k=>!linked.has(k)).concat(['linked:'+[...linked].sort().join('|')]);
  if(!biz.length) return { label:'One business entity with a stable @id', points:0, status:'na', detail:'No business entity in the schema', evidence:[], why:'', fix:'' };
  const noId=biz.every(n=>!n['@id']);
  const st=keys.length>1?'warn':noId?'warn':'pass';
  return { label:'One business entity with a stable @id', points:2, status:st,
    detail:keys.length>1?(keys.length+' different business entities on the page'):noId?'Business entity has no @id':('One business entity: '+biz[0]['@id']),
    evidence:st==='pass'?[]:biz.slice(0,3).map(n=>({ snippet:typesOf(n).join('/')+' '+(n['@id']?'@id '+n['@id']:'(no @id)')+' "'+snip(n.name,40)+'"' })),
    why:'Search engines and AI merge facts about you by entity. Two business entities (or one without an @id) split that profile.', fix:'Describe the business once, with a fixed "@id" (e.g. https://site.com/#business), and reference that @id everywhere else.' };
}
function schemaNapCheck(nap){
  const s=nap&&nap.schema||{};
  if(!s.phones.length&&!s.streets.length) return { label:'Schema NAP matches the page', points:0, status:'na', detail:'No phone or street address in the schema', evidence:[], why:'', fix:'' };
  const vis=new Set((nap.tel||[]).concat(nap.visible||[])), streets=new Set(nap.streets||[]), probs=[];
  s.phones.forEach(p=>{ if(!vis.has(p)) probs.push('schema telephone '+p+' is not on the page'); });
  s.streets.forEach(a=>{ if(streets.size && !streets.has(a)) probs.push('schema street "'+a+'" differs from the page ("'+[...streets][0]+'")'); });
  return { label:'Schema NAP matches the page', points:3, status:probs.length?'fail':'pass', detail:probs.length?probs.join(' · '):'Schema phone/address match what visitors see',
    evidence:probs.length?[{ snippet:'schema: '+s.phones.concat(s.streets).join(' · ')+' | page: '+[...vis].slice(0,2).concat([...streets].slice(0,1)).join(' · ') }]:[],
    why:'Google trusts structured data only when it matches the visible page; a mismatched phone or address undermines the local listing.', fix:'Make the schema telephone and address identical to the ones printed on the page.' };
}
// Is the schema's opening-hours 24/7?
function schema247(nodes){
  const biz=nodes.filter(n=>typesOf(n).some(t=>isLocalType(t)||ORG_TYPES.test(t)));
  let known=false, all=false;
  biz.forEach(n=>{ const spec=[].concat(n.openingHoursSpecification||[]); const oh=[].concat(n.openingHours||[]).join(' ');
    if(spec.length||oh){ known=true;
      const days=new Set(); spec.forEach(sp=>{ const o=String(sp.opens||''), c=String(sp.closes||''); if(/^00:00/.test(o)&&/^(23:59|24:00|00:00)/.test(c)) [].concat(sp.dayOfWeek||[]).forEach(d=>days.add(String(d).replace(/^.*\//,''))); });
      if(days.size>=7||/Mo-Su\s*00:00-(23:59|24:00)|24\/7|00:00-23:59/i.test(oh)) all=true; } });
  return { known, all };
}
function openingHoursCheck(nodes, pageText){
  const s=schema247(nodes); if(!s.known) return { label:'Schema hours match the page', points:0, status:'na', detail:'No opening hours in the schema', evidence:[], why:'', fix:'' };
  const claims=RE_24_7.test(pageText);
  const bad=claims&&!s.all;
  return { label:'Schema hours match the page', points:1, status:bad?'warn':'pass', detail:bad?'Page says 24/7 but the schema hours are not 24/7':(s.all?'Schema says 24/7':'Schema lists set hours'),
    evidence:bad?[{ snippet:snip((pageText.match(new RegExp('.{0,50}'+RE_24_7.source+'.{0,30}','i'))||[''])[0],110) }]:[], why:'Google shows the schema hours; if they contradict the page, customers get the wrong answer.', fix:'Mark 24/7 service as opens 00:00 / closes 23:59 on all seven days (and list office hours separately if needed).' };
}
function serviceSchemaCheck(nodes, type){
  if(type!=='service') return null;
  const has=nodes.some(n=>typesOf(n).some(t=>t==='Service'||/Service$/.test(t)&&SCHEMA_TYPES.has(t)));
  return { label:'Service schema', points:2, status:has?'pass':'warn', detail:has?'Service schema present':'No Service schema on this service page', evidence:[],
    why:'Service schema names the service, the area served and the provider, so AI answers can quote the page precisely.', fix:'Add Service JSON-LD (serviceType, areaServed, provider → your business @id).' };
}
function breadcrumbCheck(nodes, type){
  if(type==='home') return null;
  const has=nodes.some(n=>typesOf(n).includes('BreadcrumbList'));
  return { label:'Breadcrumb schema', points:1, status:has?'pass':'warn', detail:has?'BreadcrumbList present':'No BreadcrumbList schema', evidence:[], why:'Breadcrumbs show the page\'s place in the site in Google results.', fix:'Add BreadcrumbList JSON-LD (Home › Services › This page).' };
}
function faqMatchCheck(nodes, pageText){
  const qs=nodes.filter(n=>typesOf(n).includes('Question')&&n.name);
  if(!qs.length) return null;
  const norm=t=>String(t||'').toLowerCase().replace(/<[^>]+>/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
  const page=' '+norm(pageText)+' ';
  const miss=qs.filter(q=>!page.includes(' '+norm(q.name)+' ') || (q.acceptedAnswer&&q.acceptedAnswer.text&&!page.includes(' '+norm(q.acceptedAnswer.text).slice(0,120))));
  return { label:'FAQ schema matches the visible FAQ', points:2, status:miss.length?'fail':'pass', detail:miss.length?(miss.length+' of '+qs.length+' FAQ schema questions/answers are not on the page as written'):(qs.length+' FAQ schema questions match the page'),
    evidence:miss.slice(0,3).map(q=>({ snippet:'Q: '+snip(q.name,90) })), why:'FAQ markup must mirror the visible FAQ word for word; hidden or reworded Q&A is a structured-data violation.', fix:'Generate the FAQ JSON-LD from the same text shown on the page.' };
}
// ---------- Rich results eligibility ----------
// Google's Rich Results Test has no public API, so this applies the same published requirements per rich-result type
// (developers.google.com/search/docs/appearance/structured-data): a missing REQUIRED property makes the item invalid
// (no rich result - an error in Google's tool); a missing RECOMMENDED one is a warning (still eligible). Features Google
// has retired or restricted are reported, never penalised. Every result links to Google's own test for that URL.
const RICH_TYPES=[
  { name:'Local business', match:t=>isLocalType(t), required:['name','address'],
    recommended:['telephone','url','geo','openingHoursSpecification','image','priceRange'],
    nested:{ address:{ recommended:['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'] } } },
  { name:'Breadcrumb', match:t=>t==='BreadcrumbList', required:['itemListElement'], custom:(n,get)=>{
      const items=[].concat(get(n.itemListElement)||[]).map(get).filter(Boolean), errs=[];
      if(!items.length) errs.push('itemListElement has no ListItem');
      items.forEach((it,i)=>{ if(!hasVal(it.position)) errs.push('ListItem '+(i+1)+' has no position'); if(!hasVal(it.name)&&!hasVal((get(it.item)||{}).name)) errs.push('ListItem '+(i+1)+' has no name');
        if(i<items.length-1&&!hasVal(it.item)) errs.push('ListItem '+(i+1)+' has no item (URL)'); });
      return { errors:errs, warnings:items.length===1?['only one ListItem (Google shows a trail from two)']:[] }; } },
  { name:'FAQ', match:t=>t==='FAQPage', required:['mainEntity'], note:'Google shows FAQ rich results only for well-known government and health sites (since Aug 2023)',
    custom:(n,get)=>{ const qs=[].concat(get(n.mainEntity)||[]).map(get).filter(Boolean), errs=[];
      qs.forEach((q,i)=>{ if(!hasVal(q.name)) errs.push('Question '+(i+1)+' has no name'); const a=get([].concat(q.acceptedAnswer||[])[0]); if(!a||!hasVal(a.text)) errs.push('Question '+(i+1)+' has no acceptedAnswer.text'); });
      return { errors:qs.length?errs:['mainEntity has no Question'], warnings:[] }; } },
  { name:'Article', match:t=>t==='Article'||t==='BlogPosting'||t==='NewsArticle', required:[], recommended:['headline','image','datePublished','dateModified','author'],
    custom:(n,get)=>{ const a=get([].concat(n.author||[])[0]); return { errors:[], warnings:a&&!hasVal(a.name)&&!hasVal(a.url)?['author has no name or url']:[] }; } },
  { name:'Logo', match:t=>ORG_TYPES.test(t)||isLocalType(t), when:n=>hasVal(n.logo), required:['logo','url'], recommended:[] },
  { name:'Review snippet', match:t=>t==='AggregateRating'||t==='Review', required:[], custom:(n,get,parent)=>{
      const errs=[], isAgg=typesOf(n).includes('AggregateRating');
      if(isAgg){ if(!hasVal(n.ratingValue)) errs.push('ratingValue missing'); if(!hasVal(n.ratingCount)&&!hasVal(n.reviewCount)) errs.push('ratingCount or reviewCount missing'); }
      else { if(!hasVal(get(n.reviewRating)&&get(n.reviewRating).ratingValue)) errs.push('reviewRating.ratingValue missing'); if(!hasVal(n.author)) errs.push('author missing'); }
      const host=parent||get(n.itemReviewed);
      const self=host&&typesOf(host).some(t=>isLocalType(t)||ORG_TYPES.test(t));
      return { errors:errs, warnings:[], ineligible:self?'rating is on the business itself - Google does not show stars for self-serving reviews of a LocalBusiness/Organization':null }; } },
  { name:'Product', match:t=>t==='Product', required:['name'], custom:n=>({ errors:!hasVal(n.offers)&&!hasVal(n.review)&&!hasVal(n.aggregateRating)?['needs one of offers, review or aggregateRating']:[], warnings:[] }) },
  { name:'Event', match:t=>/Event$/.test(t)&&SCHEMA_TYPES.has(t), required:['name','startDate','location'], recommended:['endDate','description','image','offers','organizer'] },
  { name:'Video', match:t=>t==='VideoObject', required:['name','thumbnailUrl','uploadDate'], recommended:['description','duration','contentUrl','embedUrl'] },
  { name:'Job posting', match:t=>t==='JobPosting', required:['title','description','datePosted','hiringOrganization'], recommended:['validThrough','baseSalary','employmentType'],
    custom:n=>({ errors:!hasVal(n.jobLocation)&&!(String(n.jobLocationType||'').toUpperCase()==='TELECOMMUTE')?['jobLocation missing (or jobLocationType TELECOMMUTE)']:[], warnings:[] }) },
  { name:'How-to', match:t=>t==='HowTo', retired:'Google stopped showing How-to rich results (Sept 2023)' },
  { name:'Sitelinks search box', match:t=>t==='SearchAction', retired:'Google retired the sitelinks search box (Nov 2024)' },
];
function richResultsTestUrl(u){ return 'https://search.google.com/test/rich-results?url='+encodeURIComponent(u||''); }
function richResultsCheck(nodes, url){
  if(!nodes||!nodes.length) return null;
  const byId={}; nodes.forEach(n=>{ if(n['@id']&&typesOf(n).length) byId[n['@id']]=n; });
  const get=v=>v&&typeof v==='object'&&!Array.isArray(v)&&v['@id']&&!v['@type']&&byId[v['@id']]?byId[v['@id']]:v;
  // Ratings nested in a business node belong to it (self-serving check).
  const parentOf=new Map(); nodes.forEach(n=>['aggregateRating','review'].forEach(k=>[].concat(n[k]||[]).forEach(r=>{ const x=get(r); if(x&&typeof x==='object') parentOf.set(x,n); })));
  const seen=new Set(), items=[];
  nodes.forEach(n=>{ const ts=typesOf(n);
    RICH_TYPES.forEach(rt=>{ if(!ts.some(rt.match)) return; if(rt.when&&!rt.when(n)) return;
      const key=rt.name+'|'+(n['@id']||JSON.stringify(n).slice(0,200)); if(seen.has(key)) return; seen.add(key);
      if(rt.retired){ items.push({ type:rt.name, retired:rt.retired }); return; }
      const errors=(rt.required||[]).filter(p=>!hasVal(get(n[p]))).map(p=>p+' missing');
      const warnings=(rt.recommended||[]).filter(p=>!hasVal(get(n[p]))).map(p=>p+' (recommended)');
      Object.keys(rt.nested||{}).forEach(k=>{ const v=get([].concat(n[k]||[])[0]); if(v&&typeof v==='object') (rt.nested[k].recommended||[]).forEach(p=>{ if(!hasVal(v[p])) warnings.push(k+'.'+p+' (recommended)'); }); });
      let ineligible=null;
      if(rt.custom){ const c=rt.custom(n,get,parentOf.get(n)); errors.push(...c.errors); warnings.push(...c.warnings); ineligible=c.ineligible||null; }
      items.push({ type:rt.name, schemaType:ts[0], errors, warnings, ineligible, note:rt.note||null });
    }); });
  const test=richResultsTestUrl(url);
  if(!items.length) return { label:'Rich results eligible', points:0, status:'na', detail:'No structured data that can produce a Google rich result on this page', evidence:[], why:'', fix:'' };
  const scored=items.filter(i=>!i.retired&&!i.ineligible);
  const invalid=scored.filter(i=>i.errors.length), valid=scored.filter(i=>!i.errors.length);
  const describe=i=>i.retired?(i.type+': '+i.retired):i.ineligible?(i.type+': not eligible - '+i.ineligible):(i.type+' ('+i.schemaType+'): '+(i.errors.length?'invalid - '+i.errors.join(', '):'valid')+(i.warnings.length?' · warnings: '+i.warnings.slice(0,4).join(', '):'')+(i.note?' · '+i.note:''));
  const status=!scored.length?'info':invalid.length?'fail':'pass';
  return { label:'Rich results eligible', points:status==='info'?0:3, status,
    problem:invalid.length?('Invalid rich-result markup: '+invalid.map(i=>i.type).join(', ')):null,
    detail:(valid.length?valid.map(i=>i.type).join(', ')+' eligible':'No eligible rich result')+(invalid.length?' · invalid: '+invalid.map(i=>i.type+' ('+i.errors.join(', ')+')').join('; '):'')
      +(items.some(i=>i.retired||i.ineligible)?' · '+items.filter(i=>i.retired||i.ineligible).map(i=>i.type+(i.retired?' retired':' not eligible')).join(', '):''),
    evidence:items.map(i=>({ url, snippet:describe(i) })).concat([{ url:test, snippet:'Verify in Google\'s Rich Results Test: '+test }]),
    why:'Rich results (stars, business details, breadcrumbs, event dates) make a listing bigger and more clickable in Google. Markup missing a required property is ignored outright.',
    fix:invalid.length?('Add the missing required properties ('+invalid.map(i=>i.type+': '+i.errors.join(', ')).join('; ')+'), then confirm in Google\'s Rich Results Test: '+test)
      :('Confirm in Google\'s Rich Results Test: '+test) };
}
function schemaTypesCheck(nodes){
  const bad=[...new Set(nodes.flatMap(typesOf).filter(t=>t&&!isKnownType(t)))];
  if(!nodes.length) return null;
  return { label:'Valid schema.org types', points:1, status:bad.length?'warn':'pass', detail:bad.length?('Not schema.org types: '+bad.join(', ')):'All types are schema.org types',
    evidence:bad.map(t=>({ snippet:'"@type": "'+t+'"' })), why:'Invented types (e.g. "TowingService") are ignored — the data in them never reaches Google.', fix:'Use the closest real type (e.g. "AutomotiveBusiness" with a "Service" of serviceType "Towing").' };
}

// ---------- Phase 7 — trust & conversion ----------
const isMoneyOrHome=t=>t==='home'||t==='service'||t==='location';
function licenseMatches(text){
  const res=(_industry&&_industry._license)||[]; const out=[];
  res.forEach(re=>{ re.lastIndex=0; let m; while((m=re.exec(text))) out.push(m[0].replace(/\s+/g,' ').trim()); });
  return [...new Set(out)];
}
function licenseCheck(pageText, type){
  if(!_industry||!(_industry._license||[]).length||!isMoneyOrHome(type)) return null;
  const found=licenseMatches(pageText);
  return { label:'License / registration numbers shown', points:3, status:found.length?'pass':'fail', detail:found.length?('Shows '+found.slice(0,3).join(', ')):'No '+(_industry.label||_industry.name)+' license/registration number on the page',
    evidence:found.slice(0,3).map(x=>({ snippet:x })), why:'Licence and registration numbers (e.g. PUCO, USDOT) are hard proof of a legitimate operator — for customers, for Google and for AI answers.',
    fix:'Print your registration numbers (e.g. "PUCO #… · USDOT #…") in the footer of every page.' };
}
const RE_PRICE=/\$\s?\d{1,4}(?:[.,]\d{2})?(?:\s*(?:\/|per)\s*(?:mi|mile|hr|hour))?/i;
const RE_PRICE_CLAIM=/\b(competitive (pricing|prices|rates)|affordable (rates|prices|pricing)|upfront (pricing|prices|quotes?)|transparent pricing|flat[- ]rate|no hidden fees|low(est)? (rates|prices)|best prices?|fair (pricing|prices|rates))\b/i;
// pricingPages (crawl): URLs of pages that publish prices — a link to one of those counts as "pricing linked".
// A dollar amount is a price only in a pricing context (rate, fee, per mile, hook-up, starting at ...), never a
// discount, coupon, insurance limit, bond, reward or wage ("$50 off", "$1,000,000 liability coverage").
const RE_PRICE_CONTEXT=/\b(price[sd]?|pricing|rates?|fees?|costs?|starting|starts|from|per mile|mile|hook-?up|base|flat|tows?|towing|service call|quote|charge[sd]?|only|just)\b|\/\s*mi\b/i;
const RE_NOT_PRICE=/\b(off|save|saving|savings|discount|coupon|rebate|insur\w*|coverage|liabilit\w*|bond\w*|million|reward|gift|donat\w*|raised|salary|wage|hiring|bonus|sign-?on|financing|deductible)\b/i;
function findPrice(text){
  const re=new RegExp(RE_PRICE.source,'gi'); let m;
  while((m=re.exec(text))){ const around=text.slice(Math.max(0,m.index-60), m.index+m[0].length+40);
    if(RE_PRICE_CONTEXT.test(around)&&!RE_NOT_PRICE.test(around)) return m; }
  return null;
}
const countPrices=text=>{ let n=0; const re=new RegExp(RE_PRICE.source,'gi'); let m; while((m=re.exec(text))){ const around=text.slice(Math.max(0,m.index-60), m.index+m[0].length+40); if(RE_PRICE_CONTEXT.test(around)&&!RE_NOT_PRICE.test(around)) n++; } return n; };
// A pricing link: a pricing page's path, or link text that says pricing - not "first-rate" or "cost-effective".
const isPricingLink=a=>{ let path=''; try{ path=new URL(a.url).pathname; }catch(e){ path=String(a.url||''); }
  return /\/(pricing|prices|rates|rate-card|fees|towing-rates|towing-prices|cost)(\/|$|[-.])/i.test(path)||/^\s*(our\s+)?(pricing|prices|rates|rate card|fees|towing (rates|prices|costs?))\s*$/i.test(a.text||''); };
function pricingCheck(pageText, anchors, type, pricingPages){
  if(!isMoneyOrHome(type)) return null;
  const price=findPrice(pageText), link=(anchors||[]).find(a=>isPricingLink(a)||(pricingPages&&pricingPages.has(a.url))), claim=pageText.match(RE_PRICE_CLAIM);
  const st=price||link?'pass':claim?'fail':'warn';
  return { label:'Pricing transparency', points:2, status:st,
    detail:price?('Shows a price: "'+price[0]+'"'):link?('Links to pricing: '+link.url):claim?('Claims "'+claim[0]+'" but shows no price or pricing page'):'No prices or pricing page',
    evidence:st==='pass'?[{ snippet:price?snip(pageText.slice(Math.max(0,price.index-40), price.index+40),90):('<a href="'+link.href+'">'+link.text+'</a>') }]:claim?[{ snippet:snip(pageText.slice(Math.max(0,claim.index-40), claim.index+60),110) }]:[],
    why:'People (and AI answers) look for a price range before they call. "Affordable rates" without a number reads as a dodge.', fix:'Publish a rate card or typical price ranges (hook-up fee, per-mile rate) and link it from every service page.' };
}
function insuranceCheck(pageText, type){
  if(!isMoneyOrHome(type)) return null;
  const m=pageText.match(/\b(fully insured|licensed (and|&) insured|insured|insurance|bonded)\b/i);
  return { label:'Insurance mentioned', points:1, status:m?'pass':'fail', detail:m?('Mentions "'+m[0]+'"'):'No mention of insurance', evidence:m?[{ snippet:snip(pageText.slice(Math.max(0,m.index-40), m.index+50),100) }]:[],
    why:'"Licensed & insured" is one of the first things customers look for before letting someone handle their vehicle or property.', fix:'State that you are fully insured (and with whom, if you can) on the homepage and service pages.' };
}
const RE_STOCK=/(shutterstock|istock(photo)?|gettyimages|getty-images|adobestock|adobe-stock|depositphotos|dreamstime|123rf|bigstock|stock-photo)/i;
const PRIVACY_TERMS={ 'Google Analytics':/analytics/i, 'Google Tag Manager':/tag manager|google/i, 'Google Ads':/google ads|advertis|remarketing/i, 'Meta / Facebook Pixel':/facebook|meta|pixel/i,
  'Microsoft Clarity':/clarity|microsoft/i, 'Hotjar':/hotjar|session record/i, 'TikTok Pixel':/tiktok/i, 'LinkedIn Insight':/linkedin/i,
  'CallRail':/call ?rail|call tracking|record(ed|ing)? (calls|phone)/i, 'CallTrackingMetrics':/call ?tracking/i, 'Invoca':/invoca|call tracking/i, 'WhatConverts':/whatconverts|call tracking/i };
function trustFindings(ok, stack){
  const out=[];
  const about=ok.find(p=>/(^|\/)(about|about-us|our-story|who-we-are|history)(\/|$)/i.test(new URL(p.url).pathname));
  const ab=about&&(about._pageText||'').match(/\b(owner|owned by|founder|founded|family[- ]owned|established|since (19|20)\d{2}|president|ceo|started (the|our) (business|company))\b/i);
  out.push(finding('coverage','About page names the owner / founding',4,about&&ab?'pass':'warn',about?(ab?'About page mentions "'+ab[0]+'"':'About page has no owner or founding details'):'No About page',
    about?(ab?[{ url:about.url, snippet:snip(about._pageText.slice(Math.max(0,ab.index-40), ab.index+60),110) }]:[{ url:about.url, snippet:'no owner/founder/established wording' }]):[{ snippet:'No /about page among '+ok.length+' crawled pages' }],
    'Add an About page with the owner\'s name, when and how the business started, and a photo of the team.'));
  // Forms: GET their endpoint (never submit).
  const forms=[]; ok.forEach(p=>{ const html=p._html||''; [...html.matchAll(/<form\b[^>]*\baction=["']([^"']+)["']/gi)].forEach(m=>{ const a=m[1].trim(); if(!a||/^(#|javascript:|mailto:)/i.test(a)) return; try{ forms.push({ page:p.url, action:new URL(a.replace(/&amp;/g,'&'),p.url).href }); }catch(e){} }); });
  const uniq=[...new Map(forms.map(f=>[f.action,f])).values()].slice(0,20);
  out.push(Object.assign({ _async:true, _forms:uniq }, finding('linkHealth','Form endpoints respond',6,'info',uniq.length?'Checking…':'No forms with an action URL',[],'')));
  // Stock photos (filenames).
  const stock=[]; ok.forEach(p=>((p._assets||{}).images||[]).forEach(i=>{ if(RE_STOCK.test(i.url)) stock.push({ url:p.url, snippet:i.url }); }));
  out.push(finding('technical','Stock photo signals',0,'info',stock.length?(stock.length+' image'+(stock.length===1?' has a':'s have') +' stock-library filename'):'No stock-library filenames',stock.slice(0,5),'Swap stock shots for real photos of your trucks, team and jobs — they convert better and prove you are local.'));
  // Privacy policy vs detected tracking.
  const tools=[...new Set((stack&&stack.tracking)||[])];
  const pp=ok.find(p=>/privacy/i.test(p.url));
  if(tools.length){ const txt=pp?(pp._pageText||''):''; const missing=tools.filter(t=>PRIVACY_TERMS[t]&&!PRIVACY_TERMS[t].test(txt));
    out.push(finding('technical','Privacy policy covers the tracking in use',4,!pp||missing.length?'warn':'pass',!pp?('No privacy page, but the site runs '+tools.join(', ')):missing.length?('Policy does not mention '+missing.join(', ')):('Policy covers '+tools.join(', ')),
      [{ url:pp?pp.url:'', snippet:'Detected: '+tools.join(', ')+(missing.length?' · not mentioned: '+missing.join(', '):'') }],'Name every analytics, ad pixel and call-tracking tool in the privacy policy, with what it collects.')); }
  return out;
}
async function resolveAsyncFindings(findings){
  for(const f of findings.filter(x=>x._async)){
    const forms=f._forms||[]; delete f._async; delete f._forms;
    if(!forms.length) continue;
    const res=await Promise.all(forms.map(x=>checkUrl(x.action)));
    const dead=forms.map((x,i)=>({ x, c:res[i] })).filter(y=>y.c&&(y.c.status===404||y.c.status===410));
    const checked=res.filter(c=>c&&c.status).length;
    f.status=dead.length?'fail':checked?'pass':'info';
    f.detail=dead.length?(dead.length+' form'+(dead.length===1?' posts':'s post')+' to an endpoint that returns 404'):checked?(checked+' form endpoint'+(checked===1?'':'s')+' respond (checked with GET, not submitted)'):'Form endpoints could not be checked';
    f.evidence=dead.map(y=>({ url:y.x.page, snippet:'<form action="'+y.x.action+'"> → '+y.c.status }));
    f.fix='Point the form at a working handler and send a test lead — a dead form silently loses every enquiry.';
  }
}

// ---------- Phase 8 — AI search ----------
function questionAnswerCheck(doc, type){
  if(!/^(home|service|location|blog)$/.test(type)) return null;
  const qs=[...doc.querySelectorAll('h2,h3')].filter(h=>/\?\s*$/.test(h.textContent||''));
  if(!qs.length) return { label:'Question headings with direct answers', points:2, status:'fail', detail:'No question-form H2/H3 headings', evidence:[],
    why:'AI answer engines lift a question heading plus the short answer right under it. Pages without them are harder to quote.', fix:'Add 3–5 real customer questions as H2/H3 headings, each followed by a 1–3 sentence answer (under 60 words).' };
  const answerOf=h=>{ let el=h.nextElementSibling; for(let i=0;i<4&&el;i++,el=el.nextElementSibling){ const t=(el.textContent||'').replace(/\s+/g,' ').trim(); if(/^H[1-6]$/.test(el.tagName)) return ''; if(t) return t; }
    const d=h.closest('details,[class*="faq" i],[class*="accordion" i]'); return d?(d.textContent||'').replace(h.textContent,'').replace(/\s+/g,' ').trim():''; };
  const pairs=qs.map(h=>({ q:(h.textContent||'').trim(), a:answerOf(h) }));
  const good=pairs.filter(p=>{ const n=countWords(p.a); return n>=3&&n<=60; });
  return { label:'Question headings with direct answers', points:2, status:good.length?'pass':'warn',
    detail:good.length?(good.length+' of '+pairs.length+' question headings have a short direct answer'):(pairs.length+' question heading'+(pairs.length===1?'':'s')+', but no answer under 60 words right after'),
    evidence:(good.length?good:pairs).slice(0,2).map(p=>({ snippet:'"'+snip(p.q,70)+'" → '+countWords(p.a)+' words: '+snip(p.a,70) })),
    why:'AI answer engines lift a question heading plus the short answer right under it. Pages without them are harder to quote.', fix:'Answer each question heading in 1–3 sentences (under 60 words) directly below it, then expand.' };
}
function citableFactsCheck(pageText, type, anchors){
  if(!isMoneyOrHome(type)) return null;
  const facts=[];
  const lic=licenseMatches(pageText); if(lic.length||/\b(licen[cs]e|registration)\s*(no\.?|number|#)\s*[:#]?\s*\w*\d{3,}/i.test(pageText)) facts.push('licence # '+(lic[0]||''));
  const areaLinks=(anchors||[]).filter(a=>classifyPage(a.url,[])==='location').length;
  if(areaLinks>=3||/\b(serving|service area|we serve|areas? served)\b[^.]{0,120}(,[^.,]{2,30}){2,}/i.test(pageText)) facts.push('service-area list');
  if(RE_24_7.test(pageText)||RE_HOURS.test(pageText)) facts.push('hours');
  if(RE_PRICE.test(pageText)) facts.push('pricing');
  // Evidence lists what is MISSING — the facts to add.
  const ALL={ 'licence #':/^licence/, 'service-area list':/^service-area/, 'hours':/^hours/, 'pricing':/^pricing/ };
  const missing=Object.keys(ALL).filter(k=>!facts.some(f=>ALL[k].test(f)));
  return { label:'Citable facts', points:2, status:facts.length>=2?'pass':facts.length?'warn':'fail', detail:(facts.length?'States '+facts.join(', ')+' · ':'')+(missing.length?'Missing: '+missing.join(', '):'All four present'),
    evidence:missing.map(f=>({ snippet:'missing: '+f })), why:'AI answers quote concrete facts — licence numbers, areas served, hours, prices. Pages without them get summarised vaguely or skipped.',
    fix:'State the facts plainly on the page: licence numbers, the towns you serve, your hours and typical prices.' };
}
function aiSiteFindings(ok, ctx){
  const out=[], home=ctx.home, loc=ctx.local;
  const schemaNames=[...new Set(ok.flatMap(p=>((p.nap||{}).schema||{}).names||[]))];
  const brand=schemaNames[0];
  if(brand){
    const probs=[], low=brand.toLowerCase();
    if(schemaNames.length>1) probs.push('schema uses '+schemaNames.map(n=>'"'+n+'"').join(' and '));
    if(home&&home.title&&!home.title.toLowerCase().includes(low)) probs.push('homepage title "'+snip(home.title,60)+'" does not contain "'+brand+'"');
    const foot=home&&home._html?((home._html.match(/<footer[\s\S]*?<\/footer>/i)||[''])[0].replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&')):'';
    if(foot&&!foot.toLowerCase().includes(low)) probs.push('footer does not say "'+brand+'"');
    if(loc&&loc.found&&loc.name&&loc.name.toLowerCase()!==low) probs.push('Google Business Profile is "'+loc.name+'"');
    out.push(finding('technical','One business name everywhere',4,probs.length?'warn':'pass',probs.length?probs.join(' · '):('"'+brand+'" in the title, schema, footer'+(loc&&loc.found?' and GBP':'')),
      probs.length?[{ url:home&&home.url, snippet:'schema name "'+brand+'"; '+probs[0] }]:[],'Use exactly the same business name in the page titles, schema "name", footer and Google Business Profile (a legal name can go in "legalName").'));
  }
  if(ctx.robots!=null){
    const groups=robotsGroups(ctx.robots), bing=groups.filter(g=>g.agents.includes('bingbot')||g.agents.includes('msnbot'));
    const blocks=bing.flatMap(g=>g.disallow.filter(Boolean));
    out.push(finding('technical','No Bingbot-specific blocks',6,blocks.length?'fail':'pass',blocks.length?('robots.txt blocks Bingbot from '+blocks.join(', ')):'No rules single out Bingbot',
      blocks.map(d=>({ url:ctx.disc.base+'/robots.txt', snippet:'User-agent: bingbot · Disallow: '+d })),'Remove the Bingbot-only Disallow rules — Bing feeds ChatGPT search and Copilot.'));
  }
  const ix=/indexnow/i.test((home&&home._html||'')+' '+(ctx.robots||''));
  out.push(finding('technical','IndexNow',0,'info',ix?'IndexNow reference found':'No IndexNow reference (the key file name is private, so it cannot be probed)',[],'Turn on IndexNow (most SEO plugins and Cloudflare support it) so Bing and Yandex see changes within minutes.'));
  return out;
}

// ---------- Phase 9 — stack & agency fingerprint (info only, never scored) ----------
const BUILDERS=[ ['Beaver Builder',/fl-builder|bb-plugin|beaver-builder/i], ['Elementor',/elementor/i], ['Divi',/et_pb_|\/themes\/Divi\//i], ['WPBakery',/js_composer|vc_row/i],
  ['Oxygen',/oxygen-builder|ct-section/i], ['Bricks',/bricks-builder|brxe-/i], ['Gutenberg blocks',/wp-block-/i], ['Wix',/wixstatic\.com|X-Wix|_wixCIDX/i], ['Squarespace',/static1\.squarespace\.com|squarespace-cdn/i],
  ['GoDaddy Website Builder',/img1\.wsimg\.com|godaddy.*builder/i], ['Duda',/irp\.cdn-website\.com|dudamobile|cdn-website\.com/i], ['Webflow',/data-wf-site|webflow\.js/i],
  ['Shopify',/cdn\.shopify\.com/i], ['Weebly',/weebly\.com|editmysite\.com/i], ['Framer',/framerusercontent|framer\.com\/m\//i], ['Hibu',/hibu/i], ['Scorpion',/scorpion\.co/i] ];
const FRAMEWORKS=[ ['Next.js',/\/_next\/static|__NEXT_DATA__/], ['Nuxt',/\/_nuxt\/|window\.__NUXT__/], ['Gatsby',/\/page-data\/|___gatsby/], ['Vite',/<script[^>]+type=["']module["'][^>]+src=["'][^"']*\/assets\/index-[\w-]+\.js/i],
  ['React',/data-reactroot|id=["']root["']/], ['Angular',/ng-version=/], ['Vue',/data-v-[0-9a-f]{8}|data-server-rendered/] ];
const KNOWN_PLUGINS={ 'gravityforms':'Gravity Forms', 'wonderplugin-carousel':'WonderPlugin Carousel', 'wordpress-seo':'Yoast SEO', 'seo-by-rank-math':'Rank Math', 'contact-form-7':'Contact Form 7',
  'wpforms-lite':'WPForms', 'elementor':'Elementor', 'bb-plugin':'Beaver Builder', 'beaver-builder-lite-version':'Beaver Builder (lite)', 'woocommerce':'WooCommerce', 'jetpack':'Jetpack',
  'wp-rocket':'WP Rocket', 'litespeed-cache':'LiteSpeed Cache', 'w3-total-cache':'W3 Total Cache', 'autoptimize':'Autoptimize', 'akismet':'Akismet', 'revslider':'Slider Revolution', 'js_composer':'WPBakery', 'gp-premium':'GP Premium (GeneratePress)',
  'simple-banner':'Simple Banner', 'lightweight-social-icons':'Lightweight Social Icons', 'all-in-one-seo-pack':'All in One SEO', 'wpcf7':'Contact Form 7' };
function verCmp(a,b){ const x=String(a).split('.').map(Number), y=String(b).split('.').map(Number); for(let i=0;i<Math.max(x.length,y.length);i++){ const d=(x[i]||0)-(y[i]||0); if(d) return d; } return 0; }
async function stackFingerprint(ok, ctx){
  const html=ok.map(p=>p._html||'').join('\n');
  const home=ctx.home, homeHtml=home&&home._html||'';
  const gen=[...new Set([...html.matchAll(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/gi)].map(m=>m[1]))];
  const wp=/\/wp-content\/|\/wp-includes\//i.test(html);
  const themes=[...new Set([...html.matchAll(/\/wp-content\/themes\/([a-z0-9_-]+)\//gi)].map(m=>m[1].toLowerCase()))];
  const plugins={};
  [...html.matchAll(/\/wp-content\/plugins\/([a-z0-9_-]+)\/[^"'\s)]*?(?:\?ver=([\d.]+))?["'\s)]/gi)].forEach(m=>{ const slug=m[1].toLowerCase(); const v=m[2]||null;
    if(!plugins[slug]) plugins[slug]={ slug, name:KNOWN_PLUGINS[slug]||slug, version:null };
    if(v&&(!plugins[slug].version||verCmp(v,plugins[slug].version)>0)) plugins[slug].version=v; });
  if(/gform_wrapper|gform_fields/i.test(html)&&!plugins.gravityforms) plugins.gravityforms={ slug:'gravityforms', name:'Gravity Forms', version:null };
  // Latest versions from the WordPress.org plugins API (premium plugins like Gravity Forms are not listed there).
  const list=Object.values(plugins).slice(0,25);
  await Promise.all(list.map(async p=>{ try{ const t=await fetchAux('https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D='+encodeURIComponent(p.slug)); const j=t?JSON.parse(t):null;
    if(j&&j.version){ p.latest=j.version; if(p.version) p.outdated=verCmp(p.version,j.version)<0; } else p.latest=null; }catch(e){ p.latest=null; } }));
  const builders=BUILDERS.filter(([,re])=>re.test(html)).map(([n])=>n);
  const frameworks=FRAMEWORKS.filter(([,re])=>re.test(homeHtml)).map(([n])=>n);
  const has=(map)=>Object.keys(map).filter(k=>map[k].some(s=>html.includes(s)));
  const tracking=has(TAGS), chat=has(CHAT_WIDGETS), payments=has(PAYMENTS);
  const ops=((_industry&&_industry.ops_tools)||[]).filter(t=>t.patterns.some(s=>html.toLowerCase().includes(s.toLowerCase()))).map(t=>t.name);
  // Agency attribution: footer credits, meta author, HTML comments, UTM tags on the GBP website link.
  const credits=[]; const txt=html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,' ');
  [...txt.matchAll(/(?:website|web ?site|web design|site|designed|developed|built|powered|marketing|seo)\s+(?:and\s+\w+\s+)?by\s*(?:<[^>]+>\s*)*([A-Z0-9][\w&.' -]{2,40}?)(?=\s*(?:<|\||·|,|\.|$))/gi)].slice(0,50).forEach(m=>{ const n=m[1].replace(/<[^>]+>/g,'').trim(); if(n&&!/^(WordPress|the|our|us|you|Google)$/i.test(n)) credits.push({ source:'footer credit', value:snip(m[0].replace(/<[^>]+>/g,' '),80) }); });
  [...html.matchAll(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/gi)].forEach(m=>{ if(!(home&&home.title||'').toLowerCase().includes(m[1].toLowerCase())) credits.push({ source:'meta author', value:m[1] }); }); // the business itself is not an agency
  [...html.matchAll(/<!--([\s\S]{3,200}?)-->/g)].map(m=>m[1].trim()).filter(c=>/(website|web ?site|site|designed|developed|built|powered|created|made)\s+(and\s+\w+\s+)?by\s+\S|\bagency\b/i.test(c)&&!/(\[if|endif|wp:|\/wp:|google tag|end google|begin|yoast|seo plugin)/i.test(c)).slice(0,5).forEach(c=>credits.push({ source:'HTML comment', value:snip(c,80) }));
  const gbpSite=ctx.local&&ctx.local.website; let gbpUtm=null; if(gbpSite){ try{ const u=new URL(gbpSite); const src=u.searchParams.get('utm_source'); if(src) gbpUtm={ utm_source:src, utm_medium:u.searchParams.get('utm_medium'), utm_campaign:u.searchParams.get('utm_campaign'), url:gbpSite }; }catch(e){} }
  // Hosting / CDN from response headers.
  const hdrs=ok.map(p=>p.headers).filter(Boolean), h=k=>hdrs.map(x=>x[k]).find(Boolean);
  const hosting=[]; const server=h('server');
  if(h('cf-ray')||/cloudflare/i.test(server||'')) hosting.push('Cloudflare (CDN)');
  if(h('x-vercel-id')) hosting.push('Vercel'); if(h('x-nf-request-id')) hosting.push('Netlify'); if(h('x-amz-cf-id')) hosting.push('Amazon CloudFront');
  if(/fastly/i.test((h('x-served-by')||'')+(h('via')||''))) hosting.push('Fastly'); if(h('x-kinsta-cache')) hosting.push('Kinsta'); if(h('x-wpe-backend')||h('wpe-backend')) hosting.push('WP Engine');
  if(h('x-litespeed-cache')||/litespeed/i.test(server||'')) hosting.push('LiteSpeed'); if(h('x-sucuri-id')) hosting.push('Sucuri'); if(h('x-github-request-id')) hosting.push('GitHub Pages');
  if(h('x-wix-request-id')) hosting.push('Wix'); if(h('x-shopify-stage')) hosting.push('Shopify'); if(h('x-squarespace-served-by')) hosting.push('Squarespace'); if(/railway/i.test(server||'')) hosting.push('Railway');
  if(server&&!hosting.length) hosting.push('Server: '+server);
  const licenses=[...new Set(ok.flatMap(p=>licenseMatches(p._pageText||'')))];
  return { cms:wp?'WordPress':(gen[0]||null), generator:gen, theme:themes, builders, frameworks, plugins:list, tracking, chat, payments, opsTools:ops,
    agency:{ credits:[...new Map(credits.filter(c=>!/(rank math|yoast|all in one seo|seopress|search engine optimization by)/i.test(c.value)).map(c=>[c.source+'|'+c.value.toLowerCase(),c])).values()].slice(0,6), gbpUtm }, hosting, server:server||null, licenses };
}

// Link graph facts per page: click depth from the homepage (BFS over audited pages' links), inlink count and the
// anchor texts used; plus the full redirect chain for every redirecting URL met (hops, loops, final URL).
function crawlGraph(pages, base, redirected, keyOf){
  const byKey={}; pages.forEach(p=>{ byKey[keyOf(p.url)]=p; });
  const redir={}; redirected.forEach(x=>{ if(x.location) redir[x.url]=x.location; });
  const resolve=u=>{ const seen=[u]; let cur=u; while(redir[cur]){ cur=redir[cur]; if(seen.includes(cur)){ seen.push(cur); return {chain:seen, loop:true}; } seen.push(cur); if(seen.length>10) break; } return {chain:seen, loop:false}; };
  const target=u=>{ const r=resolve(u); return keyOf(r.chain[r.chain.length-1]); };
  const inl={};
  pages.forEach(p=>(p._anchors||[]).forEach(a=>{ const k=target(a.url); if(k===keyOf(p.url)) return;
    const e=inl[k]||(inl[k]={from:new Set(),anchors:{}}); e.from.add(p.url); if(a.text) e.anchors[a.text]=(e.anchors[a.text]||0)+1; }));
  const home=byKey[keyOf(base+'/')]||pages.find(p=>p.pageType==='home')||pages[0];
  const depth={}; if(home){ depth[keyOf(home.url)]=0; const q=[home];
    while(q.length){ const p=q.shift(), d=depth[keyOf(p.url)]; (p.links||[]).forEach(l=>{ const k=target(l); if(depth[k]==null&&byKey[k]){ depth[k]=d+1; q.push(byKey[k]); } }); } }
  pages.forEach(p=>{ const k=keyOf(p.url), e=inl[k];
    p.clickDepth=depth[k]==null?null:depth[k];
    p.inlinks=e?e.from.size:0;
    p.inlinkAnchors=e?Object.entries(e.anchors).sort((a,b)=>b[1]-a[1]).slice(0,5).map(x=>x[0]):[]; });
  const chains=redirected.map(x=>{ const r=resolve(x.url); return { from:x.url, chain:r.chain, hops:r.chain.length-1, loop:r.loop, final:r.loop?null:r.chain[r.chain.length-1] }; });
  return { chains };
}
// What to look the business up by on Google: its NAME (schema name, else og:site_name, else the brand part of the
// homepage title — never a "Towing Columbus OH" service+city phrase), its PHONE and its street ADDRESS.
function titleBrand(title){
  const parts=String(title||'').split(/\s[|–—·:-]\s|\s?\|\s?/).map(x=>x.trim()).filter(Boolean);
  if(parts.length<2) return null;
  const generic=/^(home|welcome|official site)$|\b(towing|tow truck|roadside|repair|services?|near me|\d{5}|[A-Z]{2}$)\b/i;
  return parts.slice().reverse().find(p=>/\b(inc|llc|co|company|corp|ltd|&)\b/i.test(p))||parts.slice().reverse().find(p=>!generic.test(p))||null;
}
function gbpQuery(home, pages){
  const nap=(home&&home.nap)||{}, sch=nap.schema||{};
  const name=sch.names&&sch.names[0]||(home&&home.siteName)||titleBrand(home&&home.title)||null;
  const phone=(sch.phones&&sch.phones[0])||(nap.tel&&nap.tel[0])||null;
  const street=(sch.streets&&sch.streets[0])||(nap.streets&&nap.streets[0])||null;
  return { name, phone, address:street };
}
// Archive listings (blog index, category, author, date) repeat the posts they list. One site-wide finding: a warning
// when such duplicates are indexable, informational when the archives are noindexed (handled correctly).
function archiveDuplicationFinding(pairs){
  const live=pairs.filter(p=>p.indexable);
  return finding('duplication','Archive pages duplicate posts',4,live.length?'warn':pairs.length?'pass':'info',
    live.length?(live.length+' indexable archive/post pair'+(live.length===1?'':'s')+' share 80%+ of their text'):pairs.length?(pairs.length+' archive duplicate'+(pairs.length===1?'':'s')+', all noindexed — fine'):'No archive duplication',
    (live.length?live:pairs).slice(0,5).map(p=>({ url:p.a, snippet:p.a+' ≈ '+p.b+' ('+Math.round(p.similarity*100)+'%)'+(p.indexable?'':' — noindex') })),
    'Noindex date/author/tag archives (most SEO plugins have a switch), or show excerpts instead of full posts on listing pages.');
}
// Re-time each page that took over 2s during the crawl: two sequential fetches, no other traffic.
async function retestSlowPages(pages){
  for(const p of pages.filter(x=>x.loadMs!=null&&x.loadMs>2000)){
    const ms=[];
    for(let i=0;i<2;i++){ const t0=Date.now(); try{ await fetchHtml(p.url); ms.push(Date.now()-t0); }catch(e){ ms.push(null); } }
    p.retestMs=ms; p.slowUnderLoadOnly=ms.every(v=>v!=null&&v<2000);
  }
}
async function crawlSite(root, opts){
  opts=opts||{};
  resetLinkCache();
  _nowOverride=opts.now?Date.parse(opts.now):null;
  await loadIndustry(opts.industry, opts.market);
  try{ return await crawlSiteRun(root, opts); } finally { _nowOverride=null; }
}
async function crawlSiteRun(root, opts){
  const max=opts.max||150, conc=opts.concurrency||5, onProgress=opts.onProgress||function(){};
  const render=typeof opts.render==='function'?opts.render:null;
  // onPhase(name, info) lets a UI say what the crawl is doing: discovering, crawling, links, pagespeed, scoring.
  const phase=(name,info)=>{ try{ if(typeof opts.onPhase==='function') opts.onPhase(name,info||{}); }catch(e){} };
  phase('discovering');
  const disc=await discoverPages(root, max, render);
  if(!disc.urls.length) return { error:'No pages discovered (no sitemap and no crawlable links — the site may be a JavaScript app with no sitemap).', root:disc.base };
  const baseKey=siteKey(new URL(disc.base).hostname);
  const keyOf=u=>{ try{ const x=new URL(u); return siteKey(x.hostname)+(x.pathname.replace(/\/+$/,'')||'/').toLowerCase(); }catch(e){ return String(u); } };
  // One queue: homepage, sitemap URLs, then every internal link the audited pages contain. Each URL is status-checked
  // first (no redirect following): redirects and errors are recorded, not audited; 200s are audited up to the cap.
  const queue=[], queued=new Set();
  const enqueue=u=>{ const k=keyOf(u); if(queued.has(k)||queue.length>=max*3) return; queued.add(k); queue.push(u); };
  disc.urls.forEach(enqueue);
  const pages=[], redirected=[], broken=[], nonHtml=[], sameKeyFollowed=new Set(); let qi=0, active=0, done=0, rendered=0, audited=0, capped=false;
  async function visit(u){
    const st=await checkUrl(u);
    if(st && !st.challenged && st.status>=300 && st.status<400){
      redirected.push({url:u, status:st.status, location:st.location});
      if(st.location){ try{ const l=new URL(st.location,u);
        if(siteKey(l.hostname)===baseKey && !RE_ASSET.test(l.pathname)){
          // The same page on another host or scheme (capitaltowing.com/ -> https://www.capitaltowing.com/) shares the
          // queue key, so enqueue() would drop it and the homepage would never be audited: queue it once as is.
          if(keyOf(l.href)===keyOf(u)){ if(!sameKeyFollowed.has(l.href)&&l.href!==u){ sameKeyFollowed.add(l.href); queue.push(l.href); } }
          else enqueue(l.href);
        } }catch(e){} }
      return;
    }
    if(st && !st.challenged && st.status>=400){ broken.push({url:u, status:st.status}); return; }
    // Only HTML pages are audited; maps (.kml), XML, PDFs, images and feeds are listed, not scored.
    if(isNonHtml(u, st&&st.contentType)){ nonHtml.push({ url:u, contentType:(st&&st.contentType)||null, status:(st&&st.status)||null }); return; }
    if(audited>=max){ capped=true; return; }
    audited++;
    try{ const r=await loadPage(u);
      // Per-URL crawl data: status, final URL, response headers, bytes (HTML), rendered or not.
      const meta=_fetchMeta.get(u)||{};
      r.httpStatus=st&&st.status||meta.status||null; r.finalUrl=meta.finalUrl||u; r.headers=st&&st.headers||null; r.rendered=!!r._rendered;
      pages.push(r); (r.links||[]).forEach(enqueue); }
    catch(e){ const meta=_fetchMeta.get(u)||{};
      pages.push({ url:u, error:(e&&e.reason)||(e&&e.message)||'failed', status:(st&&st.status)||meta.status||null, challenged:!!((st&&st.challenged)||(e&&e.challenged)) }); }
  }
  async function worker(){
    while(true){
      if(scanCtrl&&scanCtrl.signal.aborted) return;
      if(qi<queue.length){ const u=queue[qi++]; active++; try{ await visit(u); } finally{ active--; } done++; onProgress(Math.min(done,max), Math.min(queue.length,max), u); }
      else if(active>0) await sleep(50);
      else return;
    }
  }
  // Raw HTML (what AI crawlers see) and rendered HTML (only when rendered) — kept off the saved result.
  const keepHtml=(r,raw,rendered)=>{ Object.defineProperty(r,'_html',{value:raw,enumerable:false,writable:true,configurable:true}); Object.defineProperty(r,'_renderedHtml',{value:rendered,enumerable:false,writable:true,configurable:true}); };
  async function loadPage(u){
    let r;
    try{ r=await auditOne(u); }
    catch(e1){ // one free retry — most failures are transient (slow origin throttling under concurrency)
      if(e1&&e1.challenged) throw e1; // bot challenge: fetchHtml already backed off, retried and tried ScrapingBee
      try{ r=await auditOne(u); }
      catch(e2){ if(render && !_renderTried.has(u)){ _renderTried.add(u); const html=await render(u); if(html){ r=await auditOne(u, html); r._rendered=true; rendered++; keepHtml(r,null,html); return r; } } throw e2; }
    }
    if(r.jsShell && render){ try{ const raw=r._html; const html=await render(u); if(html){ r=await auditOne(u, html); r._rendered=true; rendered++; keepHtml(r,raw,html); } }catch(e){} }
    return r;
  }
  phase('crawling',{queued:queue.length});
  const pool=[]; for(let w=0; w<conc; w++) pool.push(worker()); await Promise.all(pool);
  pages.sort((a,b)=>a.url<b.url?-1:a.url>b.url?1:0); // stable order, whatever order the workers finished in
  const ok=pages.filter(p=>!p.error);
  if(!ok.length) return { error:'No page could be audited — the site may block automated access or is unavailable.', root:disc.base,
    pages, coverage:{ discovered:queued.size, audited:0, failed:pages.length, capped, cap:max, via:disc.via, rendered, renderAvailable:!!render } };
  const graph=crawlGraph(ok, disc.base, redirected, keyOf);
  const content=crossPageContent(ok, disc.sitemapUrls||[]);

  // Link health: every internal link target on the audited pages, status-checked (cached from the crawl queue).
  phase('links');
  const sources={};
  ok.forEach(p=>(p.links||[]).forEach(l=>{ if(keyOf(l)===keyOf(p.url)) return; (sources[l]=sources[l]||[]).push(p.url); }));
  const targets=Object.keys(sources).slice(0,400), statusOf={};
  await Promise.all(targets.map(async t=>{ statusOf[t]=await checkUrl(t); }));
  const brokenLinks=[], redirectLinks=[];
  targets.forEach(t=>{ const s=statusOf[t]; if(!s||s.challenged||!s.status) return;
    if(s.status>=400) brokenLinks.push({url:t, status:s.status, from:sources[t].slice(0,5), linkedFrom:sources[t].length});
    else if(s.status>=300) redirectLinks.push({url:t, status:s.status, location:s.location, from:sources[t].slice(0,5), linkedFrom:sources[t].length}); });
  const linked=new Set();
  targets.forEach(t=>{ linked.add(keyOf(t)); const s=statusOf[t]; if(s&&s.location) linked.add(keyOf(s.location)); });
  const smKeys=new Set((disc.sitemapUrls||[]).map(keyOf));
  const orphans=ok.filter(p=>p.pageType!=='home' && smKeys.has(keyOf(p.url)) && !linked.has(keyOf(p.url))).map(p=>p.url);
  const linkHealth={ score:Math.round(clamp100(100-2*brokenLinks.length-0.5*redirectLinks.length-orphans.length)),
    broken:brokenLinks.length, redirects:redirectLinks.length, orphans:orphans.length };

  // Technical: robots.txt, sitemap, AI search crawler access (once, for the site) + PageSpeed on the homepage and
  // two money pages (service pages first, then location pages).
  const home=ok.find(p=>p.pageType==='home')||ok[0];
  // Money pages = the service (then location) pages the site links to most.
  const inbound={}; Object.keys(sources).forEach(t=>{ inbound[keyOf(t)]=(inbound[keyOf(t)]||0)+sources[t].length; });
  const byLinks=type=>ok.filter(p=>p.pageType===type).sort((a,b)=>(inbound[keyOf(b.url)]||0)-(inbound[keyOf(a.url)]||0)||(a.url<b.url?-1:1));
  const money=byLinks('service').concat(byLinks('location'));
  // Measure every script, stylesheet and image (key pages first; 400 distinct asset URLs at most) for the weight and
  // image checks.
  await measureAssets([home].concat(money, ok).filter((p,i,a)=>p&&a.indexOf(p)===i), 400);
  // Page checks that need the whole crawl, then page scores.
  // The site's founding year (earliest one stated anywhere) checks every page's "X years" claims.
  const allFounded=ok.flatMap(p=>(p._yearClaims||{founded:[]}).founded).sort((a,b)=>a.year-b.year);
  ok.forEach(p=>{ if(p._yearClaims) setPageCheck(p,'Years-in-business claims current',staleClaimsCheck(p._yearClaims, allFounded[0]||null)); });
  // Pages that publish a rate card (2+ prices) — linking to one counts as pricing transparency.
  const pricingPages=new Set(ok.filter(p=>countPrices(p._pageText||'')>=2).map(p=>p.url));
  ok.forEach(p=>{ const pc=pricingCheck(p._pageText||'', p._anchors, p.pageType, pricingPages); if(pc) setPageCheck(p,'Pricing transparency',pc); });
  ok.forEach(p=>{ setPageCheck(p,'Title quality',titleQualityCheck(p.title,p.url,p.pageType)); setPageCheck(p,'Soft 404',soft404Check(p.pageType,p.title,p.h1text,p.uniqueWords!=null?p.uniqueWords:p.mainWords)); applyGates(p); p._score=score(p); });
  // Noindexed pages are not meant to rank, so they leave the page average — except the homepage and money pages,
  // where noindex is itself the defect (and carries its penalty).
  const scored=ok.filter(p=>p._score&&p._score.score!=null&&!(p.noindex&&!/^(home|service|location)$/.test(p.pageType)));
  // Weighted: the pages that win calls count more (homepage 3, service/location 2, others 1, utility/archive 0.5).
  const wOf=p=>PAGE_WEIGHTS[p.pageType]!=null?PAGE_WEIGHTS[p.pageType]:1;
  const wSum=scored.reduce((a,p)=>a+wOf(p),0);
  const pageAverage=wSum?Math.round(scored.reduce((a,p)=>a+wOf(p)*p._score.score,0)/wSum):null;
  const aux={ origin:home.origin, checks:[] };
  try{ await addAux(aux); }catch(e){}
  let speedRuns=[];
  if(opts.speed!==false) phase('pagespeed',{pages:3, runs:PSI_RUNS});
  if(opts.speed!==false){
    const speedPages=[home].concat(money).filter((p,i,a)=>a.indexOf(p)===i).slice(0,3);
    speedRuns=await Promise.all(speedPages.map(async p=>{
      const s={ url:p.url, checks:[] };
      try{ await addSpeed(s, opts.psiKey||''); }catch(e){}
      // Mobile counts 70%, desktop 30% (Google ranks the mobile version; most local searches are on phones).
      const ps=x=>x&&!x.error&&x.score!=null?x.score:null;
      const m=ps(s.speed&&s.speed.mobile), d=ps(s.speed&&s.speed.desktop);
      const blend=m!=null&&d!=null?Math.round(0.7*m+0.3*d):(m!=null?m:d);
      return { url:p.url, score:blend, mobile:s.speed&&s.speed.mobile||null, desktop:s.speed&&s.speed.desktop||null, checks:s.checks };
    }));
  }
  // Google Business Profile (Places), needed by the GBP comparison.
  let local=null;
  if(typeof opts.places==='function'){
    try{
      const home=ok.find(p=>p.url===disc.base+'/'||p.url===disc.base)||ok[0];
      const q=gbpQuery(home, ok);
      if(!q.name&&!q.phone&&!q.address) local={ found:false, query:q, reason:'No business name, phone or address on the site to search with' };
      else {
        const pl=await opts.places(q.name||'', { phone:q.phone, address:q.address });
        local=(pl&&pl.found!==false&&(pl.name||pl.rating!=null||pl.address))
          ? { found:true, name:pl.name||q.name, rating:pl.rating, reviews:pl.reviews, address:pl.address, phone:pl.phone, website:pl.website, mapsUrl:pl.mapsUrl, hours:pl.hours||null, matchedBy:pl.matchedBy||null, query:q }
          : { found:false, query:q };
      }
    }catch(e){ local=null; }
  }
  // Site findings (each deducts from its component).
  const ctx={ ok, home, money, disc, graph, keyOf, robots:aux._robotsTxt, speedRuns, sources, statusOf, opts };
  const siteFindings=[];
  try{ siteFindings.push(...await technicalFindings(ctx)); }catch(e){}
  siteFindings.push(...onPageLinkFindings(ok));
  siteFindings.push(...contentFreshnessFindings(ok));
  const contra=contradictionFindings(ok); siteFindings.push(...contra);
  siteFindings.push(archiveDuplicationFinding(content.archivePairs||[]));
  const claims24=(contra.find(f=>f.label==='Consistent hours claims')||{}).claims24_7||[];
  siteFindings.push(...localFindings(ok, { home, disc, local, claims24_7:claims24 }));
  let stack=null; try{ stack=await stackFingerprint(ok, { home, local }); }catch(e){}
  siteFindings.push(...trustFindings(ok, { tracking:(stack&&stack.tracking)||[...new Set(ok.flatMap(p=>p.tracking||[]))] }));
  siteFindings.push(...aiSiteFindings(ok, { home, local, robots:aux._robotsTxt, disc }));
  try{ await resolveAsyncFindings(siteFindings); }catch(e){}
  phase('scoring');
  const technical=technicalScore(aux.checks, speedRuns);
  const coverage=coverageScore(ok);
  // Industry audits blend in the service taxonomy (and market towns when supplied): score = covered / size.
  const mx=siteFindings.filter(f=>f.matrix&&f.component==='coverage').map(f=>f.matrix.score);
  if(mx.length){ coverage.pageCounts=coverage.score; coverage.score=Math.round((coverage.score+mx.reduce((x,y)=>x+y,0))/(1+mx.length)); coverage.taxonomy=mx; }
  const freshness=freshnessScore(ok, disc.lastmod||{}, _nowMs());
  const dupPool=ok.filter(p=>p.pageType!=='utility'&&p.pageType!=='archive'&&!p.noindex);
  const inPairs=new Set(); (content.nearDuplicates||[]).forEach(x=>{ inPairs.add(x.a); inPairs.add(x.b); });
  const duplication={ score:Math.round(100*(1-(dupPool.length?inPairs.size/dupPool.length:0))), pagesInNearDuplicatePairs:inPairs.size, pagesCompared:dupPool.length };
  applyDeductions({ technical, coverage, freshness, linkHealth, duplication }, siteFindings);
  const parts={ coverage:coverage.score, freshness:freshness.score, linkHealth:linkHealth.score, duplication:duplication.score, technical:technical.score };
  const siteLevel=Math.round(Object.keys(SITE_WEIGHTS).reduce((a,k)=>a+SITE_WEIGHTS[k]*parts[k],0));
  let siteScore=pageAverage==null?null:Math.round(0.5*pageAverage+0.5*siteLevel);
  // Site-wide penalties — once per site, however many pages repeat the problem.
  const cpEarly=crossPageIssues(ok, content.siteTypes);
  const selfReview=ok.some(p=>p.checks.some(c=>c.label==='Review / rating schema'&&c.status==='warn'));
  const penalties=[
    (cpEarly.countClaims||[]).length && {points:2, reason:'Hard-coded count claims that don’t match the site'},
    (cpEarly.h1Spacing||[]).length && {points:2, reason:'H1 words run together in the page code'},
    (cpEarly.smsTelLinks||[]).length && {points:1, reason:'"Text"/"SMS" links that dial (tel:)'},
    selfReview && {points:2, reason:'Self-serving review markup on the business'},
  ].filter(Boolean);
  const caps=[];
  const moneyCount=(coverage.service||0)+(coverage.location||0);
  if(siteScore!=null && moneyCount<MIN_MONEY_PAGES){ caps.push({max:70, reason:moneyCount?('Only '+moneyCount+' service/location page'+(moneyCount===1?'':'s')+' (under '+MIN_MONEY_PAGES+')'):'No service or location pages'}); siteScore=Math.min(siteScore,70); }
  if(siteScore!=null && freshness.ageDays!=null && freshness.ageDays>=730){ caps.push({max:75, reason:'No new content in 24 months (newest '+freshness.newest+')'}); siteScore=Math.min(siteScore,75); }
  // Penalties come off after the caps: a cap is the most the site can earn, and its site-wide defects still cost points.
  if(siteScore!=null) siteScore=Math.max(0,siteScore-penalties.reduce((a,x)=>a+x.points,0));
  const aiCat={e:0,t:0}; ok.forEach(p=>{ const b=p._score&&p._score.byCat&&p._score.byCat[AISEARCH]; if(b){ aiCat.e+=b.e; aiCat.t+=b.t; } });
  const aiSearch=aiCat.t?Math.min(95,Math.round(100*aiCat.e/aiCat.t)):null; // never 100: live AI answers are not observed
  const siteBreakdown={ final:siteScore, pageAverage, siteLevel, weights:SITE_WEIGHTS, coverage, freshness, linkHealth, duplication, technical, penalties, caps, aiSearch };
  const findingsOut=siteFindings.map(f=>{ const o=Object.assign({},f); return o; });
  // Pages over 2s under crawl load are fetched again, one at a time, twice: a page that is fast on its own is slow
  // only under crawl concurrency ("slow under crawl load only"), not for a visitor.
  await retestSlowPages(ok);
  const times=ok.map(p=>p.loadMs).filter(v=>v!=null);
  let perf=null;
  if(times.length){ const sorted=times.slice().sort((a,b)=>a-b); const avg=Math.round(times.reduce((a,b)=>a+b,0)/times.length);
    perf={ avg, median:sorted[Math.floor(sorted.length/2)], max:sorted[sorted.length-1], count:times.length,
      slow:ok.filter(p=>p.loadMs!=null&&p.loadMs>2000).map(p=>({url:p.url,ms:p.loadMs,retestMs:p.retestMs||null,loadOnly:!!p.slowUnderLoadOnly})).sort((a,b)=>b.ms-a.ms) }; }
  const crossPage=Object.assign(cpEarly, content, { redirectChains:graph.chains, brokenLinks, redirectLinks, orphans,
    sitemapRedirects:redirected.filter(x=>smKeys.has(keyOf(x.url))), sitemapBroken:broken.filter(x=>smKeys.has(keyOf(x.url))) });
  delete crossPage.siteTypes; // working data for the count check, not result
  ok.forEach(p=>{ p.linkCount=(p.links||[]).length; delete p.links; delete p._blocks; delete p._bh; delete p._sh; delete p._ownText; delete p._simWith; delete p._place; }); // working data, not results (crawl results get saved)
  return { engineVersion:ENGINE_VERSION, nonHtml, root:disc.base, siteScore, pageAverage, siteBreakdown, siteChecks:aux.checks, siteFindings:findingsOut, stack, speed:speedRuns, perf, local, crossPage, pages,
    coverage:{ discovered:queued.size, inSitemap:(disc.sitemapUrls||[]).length, audited:ok.length, failed:pages.length-ok.length, redirected:redirected.length, broken:broken.length, nonHtml:nonHtml.length,
      capped, cap:max, via:disc.via==='sitemap'?'sitemap + links':disc.via, rendered, renderAvailable:!!render } };
}
// ---------- Report: every finding in one list, ranked ----------
// Page checks that failed/warned are grouped by check across pages; site findings keep their component. Severity =
// (fail 1 / warn 0.5) x points; rank = severity x pages affected.
const COMPONENT_NAMES={ technical:'Technical (site)', linkHealth:'Link health', freshness:'Freshness', duplication:'Duplication', coverage:'Coverage' };
function sevLabel(v){ return v>=6?'Critical':v>=3?'High':v>=1.5?'Medium':'Low'; }
function allFindings(res){
  // Page checks that warn/fail, grouped by check across the INDEXABLE pages (noindex pages never headline). Within a
  // check, pages with the same problem wording (numbers aside) form a variant; the headline is the most common
  // variant with its count, and its fix, evidence and severity come from that same variant.
  const ok=(res.pages||[]).filter(p=>!p.error&&!p.noindex), byLabel={};
  const shape=s=>String(s).replace(/\d[\d.,]*/g,'#');
  ok.forEach(p=>(p.checks||[]).forEach(c=>{ if(c.status!=='fail'&&c.status!=='warn') return; if(!c.points&&!c.penalty) return;
    const sevName=c.severity||checkSeverity(c), issue=c.issue||problemTitle(c), key=shape(issue);
    const e=byLabel[c.label]||(byLabel[c.label]={ label:c.label, category:c.cat, fails:0, warns:0, pages:[], variants:{} });
    if(c.status==='fail') e.fails++; else e.warns++; e.pages.push(p.url);
    const v=e.variants[key]||(e.variants[key]={ key, issues:[], pages:[], rank:0, sevName:null, fix:c.fix, detail:c.detail, evidence:null });
    v.issues.push(issue); v.pages.push(p.url);
    const r=SEV_RANK[sevName]||1; if(r>v.rank){ v.rank=r; v.sevName=sevName; }
    if(!v.evidence){ const ev=(c.evidence||[])[0]; v.evidence=ev?{ url:ev.url||p.url, snippet:ev.snippet }:{ url:p.url, snippet:c.detail }; } }));
  // "Thin content: 181–437 unique words" — each number slot shows its range across the variant's pages.
  const headline=v=>{ const nums=v.issues.map(t=>(String(t).match(/\d[\d.,]*/g)||[]));
    let i=0; return v.key.replace(/#/g,()=>{ const col=nums.map(a=>a[i]).filter(x=>x!=null); i++;
      const vals=[...new Set(col)]; if(vals.length<=1) return vals[0]||'';
      const n=col.map(x=>parseFloat(String(x).replace(/,/g,''))); return Math.min(...n)+'–'+Math.max(...n); }); };
  const page=Object.values(byLabel).map(e=>{
    const vs=Object.values(e.variants).sort((a,b)=>b.pages.length-a.pages.length||b.rank-a.rank), top=vs[0], n=e.pages.length;
    const others=vs.slice(1).map(v=>headline(v)+' ('+v.pages.length+')');
    return { title:headline(top)+' — '+top.pages.length+' page'+(top.pages.length===1?'':'s'), check:e.label, category:e.category, scope:'page',
      status:e.fails>=e.warns?'fail':'warn', severity:top.sevName, sev:top.rank, pagesAffected:n, urls:top.pages.slice(0,5), evidence:top.evidence,
      detail:top.detail+(others.length?' · other variants: '+others.slice(0,3).join('; '):''), fix:top.fix, variants:vs.length, rank:top.rank*n }; });
  const capped=ok.filter(p=>p._score&&p._score.cap&&p._score.cap.applied!==false);
  if(capped.length) page.push({ title:capped.length+' thin location page'+(capped.length===1?'':'s')+' capped at '+(capped.some(p=>p._score.cap.max===70)?'70–80':'80'), check:'Thin location cap', category:'On-Page Content', scope:'page', status:'fail', severity:'High', sev:3,
    pagesAffected:capped.length, urls:capped.slice(0,5).map(p=>p.url), evidence:{ url:capped[0].url, snippet:capped[0]._score.cap.reason+' → capped at '+capped[0]._score.cap.max },
    detail:capped.length+' location page'+(capped.length===1?'':'s')+' capped at 70 (<150 unique words) or 80 (<300)', fix:'Write 300+ words that only this town’s page has: its roads, exits, landmarks, local FAQs.', rank:3*capped.length });
  // Site findings: severity from the points they take off their component (fail = all, warn = half).
  const site=(res.siteFindings||[]).filter(f=>f.status==='fail'||f.status==='warn').map(f=>{ const sevName=shortfallSeverity(f.status==='fail'?f.points:f.points/2), rank=SEV_RANK[sevName];
    const urls=[...new Set((f.evidence||[]).map(e=>e.url).filter(Boolean))];
    return { title:problemTitle(f), check:f.label, category:COMPONENT_NAMES[f.component]||f.component, scope:'site', status:f.status, severity:sevName, sev:rank, pagesAffected:Math.max(1,urls.length), urls:urls.slice(0,5),
      evidence:(f.evidence||[])[0]||{ snippet:f.detail }, detail:f.detail, fix:f.fix, rank:rank*Math.max(1,urls.length) }; });
  return page.concat(site).sort((a,b)=>b.rank-a.rank||b.sev-a.sev);
}
function topFixesHTML(list){
  if(!list.length) return '';
  const col=s=>s==='Critical'?'#b91c1c':s==='High'?'#c2410c':s==='Medium'?'#b45309':'#64748b';
  return '<h3 style="margin:18px 0 8px;font-size:15px">Top 10 fixes</h3><ol style="margin:0 0 6px;padding-left:20px;font-size:13px;line-height:1.55">'
    +list.slice(0,10).map(f=>'<li style="margin:0 0 7px"><b>'+esc(f.title)+'</b> <span style="font-size:11px;font-weight:800;color:'+col(f.severity)+';text-transform:uppercase">'+f.severity+'</span>'
      +' <span style="color:#64748b">· '+(f.scope==='site'?'site-wide':f.pagesAffected+' page'+(f.pagesAffected===1?'':'s'))+'</span>'
      +'<div style="color:#475569">'+esc(snip(f.detail,160))+'</div>'+(f.fix?'<div><b>Fix:</b> '+esc(f.fix)+'</div>':'')+'</li>').join('')+'</ol>'
    +'<div style="font-size:12px;color:#64748b">Ranked by severity × pages affected.</div>';
}
function findingsByCategoryHTML(list, root){
  if(!list.length) return '';
  const rel=u=>esc(String(u||'').replace(root,'')||'/'), groups={};
  list.forEach(f=>{ (groups[f.category||'Other']=groups[f.category||'Other']||[]).push(f); });
  const col=s=>s==='Critical'?'#b91c1c':s==='High'?'#c2410c':s==='Medium'?'#b45309':'#64748b';
  return '<h3 style="margin:22px 0 8px;font-size:15px">All findings by category</h3>'+Object.keys(groups).sort().map(g=>'<details style="margin:0 0 8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px"><summary style="font-weight:800">'+esc(g)+' ('+groups[g].length+')</summary>'
    +groups[g].map(f=>'<div style="border-top:1px solid #f1f5f9;padding:8px 0;font-size:13px"><div><b>'+esc(f.title)+'</b> <span style="font-size:11px;font-weight:800;color:'+col(f.severity)+'">'+f.severity.toUpperCase()+'</span> · '
      +(f.scope==='site'?'site-wide':f.pagesAffected+' page'+(f.pagesAffected===1?'':'s'))+'</div>'
      +(f.urls.length?'<div style="font-size:12px;color:#475569">'+f.urls.map(rel).join(' · ')+(f.pagesAffected>5?' · …':'')+'</div>':'')
      +(f.evidence&&f.evidence.snippet?'<div style="font-size:12px;font-family:ui-monospace,Consolas,monospace;background:#f8fafc;border:1px solid #eef2f7;border-radius:4px;padding:4px 6px;margin:4px 0;word-break:break-word">'+(f.evidence.url?rel(f.evidence.url)+' — ':'')+esc(snip(f.evidence.snippet,220))+'</div>':'')
      +(f.fix?'<div style="font-size:12px"><b>Fix:</b> '+esc(f.fix)+'</div>':'')+'</div>').join('')+'</details>').join('');
}
// Files the crawl met that are not web pages (KML maps, XML, PDFs, images, feeds): listed, never audited.
const RE_NONHTML_URL=/\.(kml|kmz|xml|pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|mov|webm|mp3|wav|zip|rar|gz|docx?|xlsx?|pptx?|csv|txt|json|rss|atom|ics|vcf)$/i;
function isNonHtml(u, contentType){
  let path=''; try{ path=new URL(u).pathname; }catch(e){ path=String(u); }
  if(RE_NONHTML_URL.test(path) || /(^|\/)(feed|rss|atom)\/?$/i.test(path)) return true;
  return !!contentType && !/html/i.test(contentType);
}
function nonHtmlHTML(res){
  const f=res.nonHtml||[]; if(!f.length) return '';
  return '<h3 style="margin:22px 0 8px;font-size:15px">Non-HTML files found ('+f.length+') <span style="font-size:12px;color:#64748b;font-weight:400">— listed for reference, not audited</span></h3><div style="font-size:12px;color:#475569;line-height:1.7">'
    +f.slice(0,30).map(x=>esc(x.url)+(x.contentType?' <span style="color:#94a3b8">('+esc(x.contentType.split(';')[0])+')</span>':'')).join('<br>')+(f.length>30?'<br>…and '+(f.length-30)+' more':'')+'</div>';
}
// How a GBP search is described in the report (the query is {name, phone, address}; older results stored a string).
function gbpQueryText(q){ if(!q) return '(nothing to search with)'; if(typeof q==='string') return q; return [q.name,q.phone,q.address].filter(Boolean).join(' · ')||'(nothing to search with)'; }
// "45 URLs found · 23 pages audited · 21 redirects · 1 broken" — every URL found is accounted for.
function coverageLine(cov){
  const n=(k,one,many)=>cov[k]?' · <b>'+cov[k]+'</b> '+(cov[k]===1?one:many):'';
  const notAudited=Math.max(0,(cov.discovered||0)-(cov.audited||0)-(cov.redirected||0)-(cov.broken||0)-(cov.failed||0)-(cov.nonHtml||0));
  return '<b>'+(cov.discovered||0)+'</b> URLs found · <b>'+(cov.audited||0)+'</b> pages audited'+n('redirected','redirect','redirects')+n('broken','broken','broken')
    +n('failed','failed to load','failed to load')+n('nonHtml','non-HTML file','non-HTML files')+(cov.capped&&notAudited?' · <b>'+notAudited+'</b> not audited (capped at '+cov.cap+')':'');
}
// Pages the crawl found but could not load, with the HTTP status and the error.
function failedPagesHTML(res){
  const f=(res.pages||[]).filter(p=>p.error); if(!f.length) return '';
  return '<h3 style="margin:22px 0 8px;font-size:15px">Pages that failed to load ('+f.length+')</h3><div style="overflow:auto"><table style="border-collapse:collapse;width:100%;font-size:13px">'
    +'<tr><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">URL</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Status</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Error</th></tr>'
    +f.map(p=>'<tr style="border-bottom:1px solid #eef2f7"><td style="padding:5px 8px;word-break:break-all">'+esc(p.url)+'</td><td style="padding:5px 8px">'+(p.status||'—')+(p.challenged?' (bot challenge)':'')+'</td><td style="padding:5px 8px;color:#475569">'+esc(snip(p.error,140))+'</td></tr>').join('')+'</table></div>';
}
// Industry taxonomy × site(s): ✓ own page · ◐ mentioned only · ✗ missing.
function coverageMatrixHTML(results){
  const sets=(results||[]).filter(r=>r&&!r.error).map(r=>({ name:String(r.root).replace(/^https?:\/\/(www\.)?/,''), m:((r.siteFindings||[]).find(f=>f.matrix&&f.matrix.rows&&f.matrix.rows[0]&&f.matrix.rows[0].service)||{}).matrix })).filter(x=>x.m);
  if(!sets.length) return '';
  const cell=r=>r.status==='covered'?'<td style="text-align:center;color:#16a34a;font-weight:800" title="own page">✓</td>':r.status==='partial'?'<td style="text-align:center;color:#b45309;font-weight:800" title="mentioned, no page">◐</td>':'<td style="text-align:center;color:#dc2626;font-weight:800" title="missing">✗</td>';
  const th=t=>'<th style="text-align:center;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">'+esc(t)+'</th>';
  return '<h3 style="margin:22px 0 8px;font-size:15px">Service coverage matrix</h3><div style="overflow:auto"><table style="border-collapse:collapse;width:100%;font-size:13px"><tr><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Service</th>'+sets.map(s=>th(s.name)).join('')+'</tr>'
    +sets[0].m.rows.map((row,i)=>'<tr style="border-bottom:1px solid #f1f5f9"><td style="padding:4px 8px">'+esc(row.service)+'</td>'+sets.map(s=>cell(s.m.rows[i]||{status:'missing'})).join('')+'</tr>').join('')
    +'<tr><td style="padding:6px 8px;font-weight:800">Covered</td>'+sets.map(s=>'<td style="text-align:center;font-weight:800">'+s.m.covered+'/'+s.m.size+'</td>').join('')+'</tr></table></div>'
    +'<div style="font-size:12px;color:#64748b;margin-top:4px">✓ has its own page · ◐ mentioned but no page · ✗ not mentioned. Coverage score = services with their own page ÷ services in the industry list.</div>';
}
function stackHTML(st){
  if(!st) return '';
  const row=(k,v)=>v&&(Array.isArray(v)?v.length:true)?'<tr><td style="padding:4px 8px;color:#64748b;white-space:nowrap;vertical-align:top">'+k+'</td><td style="padding:4px 8px">'+(Array.isArray(v)?v.map(esc).join(', '):v)+'</td></tr>':'';
  const plugins=(st.plugins||[]).map(p=>esc(p.name)+(p.version?' '+esc(p.version):'')+(p.outdated?' <b style="color:#b91c1c">(outdated — latest '+esc(p.latest)+')</b>':p.latest&&p.version?' <span style="color:#16a34a">(current)</span>':'')).join(', ');
  const ag=st.agency||{};
  return '<h3 style="margin:22px 0 8px;font-size:15px">Stack &amp; agency</h3><table style="border-collapse:collapse;width:100%;font-size:13px">'
    +row('Platform',st.cms?esc(st.cms)+(st.generator&&st.generator[0]&&st.generator[0]!==st.cms?' ('+esc(st.generator[0])+')':''):null)+row('Theme',st.theme)+row('Builder',st.builders)+row('Framework',st.frameworks)
    +(plugins?'<tr><td style="padding:4px 8px;color:#64748b;vertical-align:top">Plugins</td><td style="padding:4px 8px">'+plugins+'</td></tr>':'')
    +row('Tracking',st.tracking)+row('Chat',st.chat)+row('Payments',st.payments)+row('Industry tools',st.opsTools)+row('Hosting / CDN',st.hosting)+row('Licences found',st.licenses)
    +row('Agency',(ag.credits||[]).map(c=>c.source+': '+c.value).concat(ag.gbpUtm?['GBP website link tagged utm_source='+ag.gbpUtm.utm_source]:[]))
    +'</table><div style="font-size:12px;color:#64748b;margin-top:4px">Information only — not scored.</div>';
}
// How the site score was built — every part and cap, so the number can be checked by hand.
function siteBreakdownHTML(b, scol){
  if(!b) return '';
  const row=(label,val,weight,note)=>'<tr style="border-bottom:1px solid #eef2f7"><td style="padding:5px 8px">'+label+'</td><td style="padding:5px 8px;font-weight:800;color:'+scol(val)+'">'+(val==null?'—':val)+'</td><td style="padding:5px 8px;color:#64748b">'+weight+'</td><td style="padding:5px 8px;font-size:12px;color:#475569">'+note+'</td></tr>';
  const pct=w=>Math.round(w*100)+'% of site level';
  const f=b.freshness||{}, l=b.linkHealth||{}, c=b.coverage||{}, d=b.duplication||{}, t=b.technical||{}, tp=t.parts||{};
  const ded=x=>x&&x.deducted?' · −'+x.deducted+' from findings ('+(x.findings||[]).map(y=>esc(y.label)).join(', ')+')':'';
  const tparts=['robots.txt '+(tp.robots==null?'n/a':tp.robots),'sitemap '+(tp.sitemap==null?'n/a':tp.sitemap),'AI search crawlers '+(tp.aiCrawlers==null?'n/a':tp.aiCrawlers),'PageSpeed '+(tp.pageSpeed==null?'not measured':tp.pageSpeed+' (homepage + 2 money pages, mobile 70% / desktop 30%)')].join(' · ');
  return '<div style="overflow:auto;margin:6px 0 10px"><table style="border-collapse:collapse;width:100%;font-size:13px">'
    +'<tr><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Part</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Score</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Weight</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Basis</th></tr>'
    +row('<b>Pages</b> (average page score)',b.pageAverage,'50% of final','Every audited page scored on its own checks, then averaged.')
    +row('<b>Site level</b>',b.siteLevel,'50% of final','The five parts below.')
    +row('&nbsp;&nbsp;Coverage',c.score,pct(b.weights.coverage),(c.service||0)+' service pages · '+(c.location||0)+' location pages (full credit at 10 of each)'+(c.taxonomy?' · averaged with industry coverage '+c.taxonomy.join('/')+'%':'')+ded(c))
    +row('&nbsp;&nbsp;Freshness',f.score,pct(b.weights.freshness),(f.newest?('Newest content '+esc(f.newest)+' ('+f.ageDays+' days ago, from '+esc(f.source)+'); full at ≤90 days, 0 at 24 months'):esc(f.source||'no dates'))+ded(f))
    +row('&nbsp;&nbsp;Link health',l.score,pct(b.weights.linkHealth),(l.broken||0)+' broken internal links (−2 each) · '+(l.redirects||0)+' redirecting links (−0.5 each) · '+(l.orphans||0)+' orphan pages (−1 each)'+ded(l))
    +row('&nbsp;&nbsp;Duplication',d.score,pct(b.weights.duplication),(d.pagesInNearDuplicatePairs||0)+' of '+(d.pagesCompared||0)+' pages are near-duplicates (80%+ shared text) of another page'+ded(d))
    +row('&nbsp;&nbsp;Technical',t.score,pct(b.weights.technical),tparts+ded(t))
    +'</table>'
    +((b.penalties||[]).length?'<div style="font-size:13px;color:#b45309;margin-top:6px"><b>Site-wide penalties:</b> '+b.penalties.map(x=>esc(x.reason)+' −'+x.points).join(' · ')+'</div>':'')
    +((b.caps||[]).length?'<div style="font-size:13px;color:#b91c1c;margin-top:6px"><b>Score capped:</b> '+b.caps.map(x=>esc(x.reason)+' → max '+x.max).join(' · ')+'</div>':'')
  +'</div>';
}
// PageSpeed for the homepage + money pages: the median of PSI_RUNS runs, with the range seen.
function speedRunsHTML(runs, root){
  runs=(runs||[]).filter(x=>x&&(x.mobile||x.desktop));
  if(!runs.length) return '';
  const cell=m=>{ if(!m||m.error||m.score==null) return '<span style="color:#94a3b8">not measured</span>';
    const c=m.score>=90?'#16a34a':m.score>=50?'#ea580c':'#dc2626', r=m.range&&m.range.score;
    return '<b style="color:'+c+'">'+m.score+'</b>'+(r&&m.runs>1?' <span style="color:#64748b;font-size:12px">('+r[0]+'–'+r[1]+')</span>':''); };
  const th=t=>'<th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">'+t+'</th>';
  return '<h3 style="margin:18px 0 8px;font-size:15px">Google PageSpeed — median of '+PSI_RUNS+' runs (range in brackets)</h3>'
    +'<div style="overflow:auto"><table style="border-collapse:collapse;width:100%;font-size:13px"><tr>'+th('Page')+th('Mobile')+th('Desktop')+th('Mobile LCP')+'</tr>'
    +runs.map(x=>'<tr style="border-bottom:1px solid #eef2f7"><td style="padding:5px 8px">'+esc(String(x.url).replace(root,'')||'/')+'</td><td style="padding:5px 8px">'+cell(x.mobile)+'</td><td style="padding:5px 8px">'+cell(x.desktop)+'</td><td style="padding:5px 8px">'+(x.mobile&&x.mobile.lcpTxt?esc(x.mobile.lcpTxt):'—')+'</td></tr>').join('')
    +'</table></div><div style="font-size:12px;color:#64748b;margin-top:4px">Mobile counts 70% and desktop 30% of each page\'s speed score. Lighthouse varies run to run, which is why the median is used.</div>';
}
// The three problems most worth a prospect's attention, in plain words — the summary shown before the full report.
function siteTopIssues(res, n){
  if(!res||res.error) return [];
  const cp=res.crossPage||{}, b=res.siteBreakdown||{}, rel=u=>String(u||'').replace(res.root,'')||'/', out=[];
  const add=(w,title,detail)=>out.push({w,title,detail});
  const mob=(res.speed||[]).map(x=>x.mobile&&!x.mobile.error?x.mobile.score:null).filter(v=>v!=null);
  (b.caps||[]).forEach(c=>add(100,'Score capped at '+c.max,c.reason));
  if(mob.length && Math.min(...mob)<50) add(95,'Slow on phones: mobile PageSpeed '+Math.min(...mob)+'/100','Most local searches happen on phones; Google ranks the mobile version.');
  if((cp.jsRendered||[]).length) add(92,cp.jsRendered.length+' page'+(cp.jsRendered.length===1?' is':'s are')+' invisible to AI search','Their content only appears after JavaScript runs.');
  if((cp.brokenLinks||[]).length) add(90,cp.brokenLinks.length+' broken internal link'+(cp.brokenLinks.length===1?'':'s'),'e.g. '+rel(cp.brokenLinks[0].url)+' returns '+cp.brokenLinks[0].status);
  if(b.freshness&&b.freshness.score<50&&b.freshness.newest) add(85,'No fresh content since '+b.freshness.newest,'Search and AI tools favour sites that keep publishing.');
  if(b.coverage&&b.coverage.score<50) add(84,'Few service or location pages ('+b.coverage.service+' service, '+b.coverage.location+' location)','Each service and each town you serve needs its own page to rank for it.');
  if((cp.nearDuplicates||[]).length) add(80,(cp.nearDuplicates.length)+' near-duplicate page pair'+(cp.nearDuplicates.length===1?'':'s'),'Pages sharing 80%+ of their text compete with each other.');
  if(cp.nap&&(cp.nap.inconsistent||[]).length) add(80,'Business '+cp.nap.inconsistent.join(' / ')+' differs across pages','Inconsistent NAP confuses Google and AI about who you are.');
  if((cp.thin||[]).length) add(70,(cp.thin.length)+' thin page'+(cp.thin.length===1?'':'s'),'Under 250 words of their own content.');
  if((cp.countClaims||[]).length) add(55,'Page copy contradicts the site','"'+cp.countClaims[0].claim+'" — the site has '+cp.countClaims[0].actual+' '+cp.countClaims[0].kind+' pages.');
  if((cp.missingH1||[]).length) add(50,(cp.missingH1.length)+' page'+(cp.missingH1.length===1?'':'s')+' without an H1 headline','');
  if((cp.orphans||[]).length) add(45,(cp.orphans.length)+' orphan page'+(cp.orphans.length===1?'':'s'),'In the sitemap but linked from nowhere.');
  if((cp.redirectLinks||[]).length) add(40,(cp.redirectLinks.length)+' internal link'+(cp.redirectLinks.length===1?'':'s')+' that redirect','e.g. '+rel(cp.redirectLinks[0].url));
  if((b.penalties||[]).some(p=>/review/i.test(p.reason))) add(35,'Self-serving review markup','Not eligible for Google stars; show your real Google reviews on the site instead.');
  if((cp.duplicateTitles||[]).length) add(30,'Duplicate page titles','"'+cp.duplicateTitles[0].value+'" on '+cp.duplicateTitles[0].urls.length+' pages.');
  return out.sort((a,b)=>b.w-a.w).slice(0,n||3).map(x=>({title:x.title,detail:x.detail}));
}
// Ranked side-by-side of full-site crawls (the deep competitor comparison).
function siteComparisonHTML(results){
  const F="font-family:'Inter',system-ui,Arial,sans-serif;color:#0f172a";
  const rows=(results||[]).filter(r=>r&&!r.error&&r.siteScore!=null).sort((a,b)=>b.siteScore-a.siteScore);
  const failed=(results||[]).filter(r=>!r||r.error||r.siteScore==null);
  const gcol=s=> s==null?'#94a3b8':s>=90?'#16a34a':s>=80?'#65a30d':s>=70?'#f59e0b':s>=55?'#f97316':'#dc2626';
  const grade=s=> s>=90?'A':s>=80?'B':s>=70?'C':s>=55?'D':'F';
  const medal=i=> i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'.';
  const th=t=>'<th style="text-align:left;padding:8px 8px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #e2e8f0;white-space:nowrap">'+t+'</th>';
  const td=(v,c)=>'<td style="padding:8px 8px;font-weight:700;color:'+(c||gcol(v))+'">'+(v==null?'—':v)+'</td>';
  const body=rows.map((r,i)=>{ const b=r.siteBreakdown||{}; const home=(r.speed||[])[0]; const mob=home&&home.mobile&&!home.mobile.error?home.mobile.score:null; const top=siteTopIssues(r,1)[0];
    return '<tr style="border-bottom:1px solid #eef2f7;'+(i===0?'background:#f0fdf4':'')+'"><td style="padding:8px;font-weight:800">'+medal(i)+'</td>'
      +'<td style="padding:8px;font-weight:700;white-space:nowrap">'+esc(String(r.root).replace(/^https?:\/\/(www\.)?/,''))+'<div style="font-size:11px;color:#94a3b8;font-weight:400">'+((r.coverage||{}).audited||0)+' pages audited</div></td>'
      +td(grade(r.siteScore)+' · '+r.siteScore,gcol(r.siteScore))+td(b.pageAverage)+td(b.coverage&&b.coverage.score)+td(b.freshness&&b.freshness.score)+td(b.linkHealth&&b.linkHealth.score)+td(b.duplication&&b.duplication.score)+td(mob)+td(b.aiSearch)
      +'<td style="padding:8px;font-size:12px;color:#475569">'+(top?esc(top.title):'—')+'</td></tr>'; }).join('');
  const cta=(results||[]).find(r=>r&&r.rep)||{};
  return '<div style="'+F+'">'
    +handleItHTML(cta,'top')
    +'<div style="border-bottom:3px solid #0f172a;padding-bottom:12px;margin-bottom:14px"><div style="font-size:20px;font-weight:800">Full-site comparison — '+rows.length+' site'+(rows.length===1?'':'s')+' ranked</div><div style="color:#64748b;font-size:13px">'+esc(BRAND.name)+' · every page of every site crawled and scored the same way</div></div>'
    +'<div style="overflow:auto"><table style="border-collapse:collapse;width:100%;font-size:13px"><tr>'+th('#')+th('Site')+th('Score')+th('Pages')+th('Coverage')+th('Freshness')+th('Links')+th('Duplication')+th('Mobile speed')+th('AI search')+th('Biggest issue')+'</tr>'+body+'</table></div>'
    +handleItHTML(cta,'fixes')
    +coverageMatrixHTML(rows)
    +(failed.length?'<div style="font-size:12px;color:#b91c1c;margin-top:8px">Could not crawl: '+failed.map(r=>esc((r&&r.root)||'?')+(r&&r.error?' ('+esc(r.error)+')':'')).join(' · ')+'</div>':'')
    +handleItHTML(cta,'footer')
    +engineFooterHTML(((results||[]).find(r=>r&&r.engineVersion)||{}).engineVersion)
    +'<div style="font-size:12px;color:#64748b;margin-top:8px">Score = 50% average page score + 50% site level (coverage, freshness, link health, duplication, technical). Mobile speed is the homepage\'s median of '+PSI_RUNS+' PageSpeed runs.</div>'
  +'</div>';
}
// Which engine produced a report (the version stored in the result; falls back to the running engine).
function engineFooterHTML(v){ return '<div style="font-size:11px;color:#94a3b8;margin-top:14px">Audit engine v'+esc(v||ENGINE_VERSION)+'</div>'; }
function aiExplainerHTML(){
  return '<h3 style="margin:24px 0 8px;font-size:15px">Why AI Search Matters</h3>'
    +'<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;font-size:13px;line-height:1.6;color:#334155">'
    +'<p style="margin:0 0 10px"><b>What it is.</b> AI search tools — ChatGPT, Google\'s AI Overviews, Perplexity, Microsoft Copilot, and Gemini — answer a question in plain language instead of handing back a page of links. You ask, and the AI writes a direct answer, often recommending just one or two businesses by name.</p>'
    +'<div style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 10px">'
      +'<div style="flex:1;min-width:210px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:10px"><div style="font-weight:800;margin-bottom:4px">Traditional search — Google &amp; Bing</div>Hands you ~10 links to click through. The site ranking #1 wins the visit — mostly about keywords and backlinks.</div>'
      +'<div style="flex:1;min-width:210px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:10px"><div style="font-weight:800;margin-bottom:4px">AI search — ChatGPT, AI Overviews, Perplexity…</div>Gives one written answer and names only a few sources — the customer often never clicks a site. The goal isn\'t ranking #1; it\'s being the business the AI recommends, based on clear content, structured data, and reviews.</div>'
    +'</div>'
    +'<p style="margin:0 0 10px"><b>Who\'s using it.</b> The fastest-adopted consumer technology in history — hundreds of millions use these tools every week. Highest among ages 18–44, who ask AI for recommendations before they ever open Google, and growing fast across every age group.</p>'
    +'<p style="margin:0"><b>Why it matters for you.</b> People now research local services through AI the way they used to Google them — "best-reviewed shop near me," "who can tow my car tonight." If the AI can\'t read and understand your site, your business isn\'t part of that conversation. The AI-search items in this report are what put you there.</p>'
  +'</div>';
}
function ctaBlockHTML(){
  var contacts=(BRAND.contacts||[]).map(function(c){return '<div style="font-size:14px;color:#cbd5e1;line-height:1.9"><b style="color:#fff">'+esc(c.name)+'</b> · <a href="tel:'+esc(c.tel||c.phone)+'" style="color:#93c5fd;text-decoration:none">'+esc(c.phone)+'</a> · <a href="mailto:'+esc(c.email)+'" style="color:#93c5fd;text-decoration:none">'+esc(c.email)+'</a></div>';}).join('');
  var sites=(BRAND.sites||[BRAND.web]).filter(Boolean).map(function(s){return '<a href="https://'+esc(s)+'" style="color:#93c5fd;text-decoration:none">'+esc(s)+'</a>';}).join(' &nbsp;·&nbsp; ');
  return '<div style="background:#0f172a;color:#fff;border-radius:10px;padding:20px 22px;margin-top:22px">'
    +'<div style="font-size:17px;font-weight:800;margin-bottom:6px">Ready to fix this?</div>'
    +'<p style="margin:0 0 12px;color:#e2e8f0;font-size:14px;line-height:1.6">Everything in this report is fixable — most of it faster than you\'d think. <b>'+esc(BRAND.name)+'</b> turns audits like this into more calls and higher rankings in Google <i>and</i> the new AI search tools — including the AI-search items most agencies aren\'t even checking yet.</p>'
    +'<div style="font-weight:800;margin-bottom:4px">'+esc(BRAND.name)+'</div>'+contacts
    +'<div style="margin-top:8px;font-size:13px">'+sites+'</div>'
  +'</div>';
}
// "Handle this for me": call or text the assigned rep. The rep is the result's `rep` (a BRAND.contacts name), or
// ?rep=<name> on the report link, else the first contact. Every tap is beaconed to seoreview with the report link
// (location.href), so taps are counted per link wherever the report is hosted.
const CTA_TRACK_URL='https://seoreview-production.up.railway.app/api/cta-tap';
const PACKAGES=[
  { name:'Fix-It Sprint', scope:'We fix the top issues in this report: titles, schema, broken links, page speed.', price:'from $___' },
  { name:'Local Growth', scope:'Service + town pages, Google Business Profile and a review engine, tracked on the map grid monthly.', price:'from $___/mo' },
  { name:'Done-For-You Website', scope:'A fast, AI-search-ready site with tap-to-call on every screen and call tracking.', price:'from $___' },
];
function repFor(x){
  const list=BRAND.contacts||[]; let want=x&&x.rep;
  try{ const m=/[?&]rep=([a-z]+)/i.exec((root.location&&root.location.search)||''); if(m) want=m[1]; }catch(e){}
  return list.find(c=>c.name.toLowerCase()===String(want||'').toLowerCase())||list[0]||null;
}
// where: 'top' | 'fixes' | 'footer'. The 'fixes' block is the full one, with "What we'll do".
function handleItHTML(x, where, domain){
  const rep=repFor(x); if(!rep) return '';
  const telNum=rep.tel||rep.phone, body='Hi '+rep.name+', please handle the fixes in my SEO report'+(domain?' for '+domain:'')+'.';
  const nm='<span data-cta-name>'+esc(rep.name)+'</span>';
  const tap=kind=>"try{navigator.sendBeacon('"+CTA_TRACK_URL+"',JSON.stringify({link:location.href,kind:'"+kind+"',where:'"+where+"',rep:this.getAttribute('data-cta-rep')}))}catch(e){}";
  const btn=(kind,label,href,bg)=>'<a href="'+esc(href)+'" data-cta="'+kind+'" data-cta-rep="'+esc(rep.name)+'" onclick="'+esc(tap(kind))+'" style="display:inline-block;background:'+bg+';color:#fff;text-decoration:none;font-weight:800;font-size:15px;padding:12px 18px;border-radius:10px;margin:4px 8px 4px 0;min-width:130px;text-align:center">'+label+'</a>';
  const buttons=btn('call','📞 Call '+nm,'tel:'+telNum,'#16a34a')+btn('text','💬 Text '+nm,'sms:'+telNum+'?&body='+encodeURIComponent(body),'#2563eb');
  if(where!=='fixes') return '<div data-handle-it="'+where+'" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;margin:0 0 16px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px">'
    +'<div style="font-weight:800;font-size:15px;color:#0f172a">Handle this for me<div style="font-weight:400;font-size:13px;color:#475569">'+nm+' will fix it for you · <span data-cta-phone>'+esc(rep.phone)+'</span></div></div><div>'+buttons+'</div></div>'
    +(where==='footer'?repSwitchScript():'');
  return '<div data-handle-it="fixes" style="background:#0f172a;color:#fff;border-radius:12px;padding:18px 18px 14px;margin:18px 0">'
    +'<div style="font-size:18px;font-weight:800">Handle this for me</div>'
    +'<div style="font-size:14px;color:#cbd5e1;margin:4px 0 10px">Don’t want to do it yourself? '+nm+' will take it from here.</div>'+buttons
    +'<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin:14px 0 6px">What we’ll do</div>'
    +PACKAGES.map(p=>'<div style="border-top:1px solid #1e293b;padding:8px 0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div style="flex:1 1 220px"><b>'+esc(p.name)+'</b><div style="font-size:13px;color:#cbd5e1">'+esc(p.scope)+'</div></div><div style="font-weight:800;color:#93c5fd;white-space:nowrap">'+esc(p.price)+'</div></div>').join('')
    +'</div>';
}
// A stored report (e.g. /report/:id) was rendered with its default rep; this swaps in ?rep=<name> when the page loads.
// (Reports inserted with innerHTML never run it; there the engine read ?rep= itself while rendering.)
function repSwitchScript(){
  const reps={}; (BRAND.contacts||[]).forEach(c=>{ reps[c.name.toLowerCase()]={ name:c.name, phone:c.phone, tel:c.tel||c.phone }; });
  return '<script>(function(){try{var m=/[?&]rep=([a-z]+)/i.exec(location.search);var R='+JSON.stringify(reps).replace(/</g,'')+';var r=m&&R[m[1].toLowerCase()];if(!r)return;'
    +'document.querySelectorAll("[data-cta-name]").forEach(function(s){s.textContent=r.name;});'
    +'document.querySelectorAll("[data-cta-phone]").forEach(function(s){s.textContent=r.phone;});'
    +'document.querySelectorAll("a[data-cta]").forEach(function(a){var old=a.getAttribute("data-cta-rep");a.setAttribute("data-cta-rep",r.name);'
    +'a.href=a.getAttribute("data-cta")==="call"?"tel:"+r.tel:"sms:"+r.tel+"?&body="+encodeURIComponent(decodeURIComponent(a.getAttribute("href").split("body=")[1]||"").split(old).join(r.name));});'
    +'}catch(e){}})();</scr'+'ipt>';
}
function siteReportHTML(res){
  if(!res||res.error) return '<p style="color:#dc2626;font-family:Inter,Arial,sans-serif">Crawl failed: '+esc(res&&res.error||'unknown')+'</p>';
  const F="font-family:'Inter',system-ui,Arial,sans-serif;color:#0f172a";
  const siteDomain=String(res.root||'').replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'');
  const cov=res.coverage||{}; const cp=res.crossPage||{};
  const scol=s=> s==null?'#94a3b8':s>=90?'#16a34a':s>=80?'#65a30d':s>=70?'#f59e0b':s>=55?'#f97316':'#dc2626';
  const ok=(res.pages||[]).filter(p=>!p.error);
  const catAgg={}; ok.forEach(p=>{ const bc=p._score&&p._score.byCat||{}; Object.keys(bc).forEach(c=>{ catAgg[c]=catAgg[c]||{e:0,t:0}; catAgg[c].e+=bc[c].e; catAgg[c].t+=bc[c].t; }); });
  const catPct=c=>catAgg[c]&&catAgg[c].t?catPercent(c,catAgg[c]):null;
  const jsCount=(cp.jsRendered||[]).length; const aiPct=catPct('AI Search & Answer Engines');
  const engine=(label,val,note)=>'<div style="flex:1;min-width:150px;border:1px solid #e2e8f0;border-radius:8px;padding:12px"><div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">'+label+'</div><div style="font-size:24px;font-weight:800;color:'+scol(val)+'">'+(val==null?'—':val)+(val==null?'':'%')+'</div><div style="font-size:12px;color:#64748b;margin-top:2px">'+note+'</div></div>';
  const issue=(title,arr,fmt)=>{ arr=arr||[]; if(!arr.length) return ''; const items=arr.slice(0,8).map(fmt||(u=>esc(String(u)))).join('<br>'); return '<div style="border:1px solid #fee2e2;background:#fff7f7;border-radius:8px;padding:10px 12px;margin:0 0 8px"><div style="font-weight:800;color:#b91c1c">'+esc(title)+' ('+arr.length+')</div><div style="font-size:12px;color:#475569;margin-top:4px;line-height:1.6">'+items+(arr.length>8?'<br>…and '+(arr.length-8)+' more':'')+'</div></div>'; };
  const pageRows=ok.slice(0,60).map(p=>{ var s=p._score||{}; return '<tr style="border-bottom:1px solid #eef2f7"><td style="padding:5px 8px;font-weight:700;color:'+scol(s.score)+'">'+(s.grade||'?')+(s.score!=null?' '+s.score:'')+'</td><td style="padding:5px 8px;font-size:12px">'+esc(p.url.replace(res.root,'')||'/')+'</td><td style="padding:5px 8px;font-size:12px;color:#64748b">'+(p.pageType?esc(p.pageType)+' · ':'')+(p.uniqueWords!=null?p.uniqueWords+' unique words':(p.words||0)+'w')+(p.jsShell?' · JS':'')+(p._rendered?' · rendered':'')+'</td></tr>'; }).join('');
  const pf=res.perf;
  const speedHTML = !pf ? '' : (function(){
    const v=pf.avg, col= v<800?'#16a34a':v<1800?'#f59e0b':'#dc2626';
    const verdict= v<800?'Fast — good server response.':v<1800?'Moderate — slower than ideal; worth improving.':'Slow — this is hurting rankings and crawl budget. Likely the biggest technical problem.';
    const fmt=ms=>ms>=1000?(ms/1000).toFixed(1)+'s':ms+'ms';
    return '<h3 style="margin:18px 0 8px;font-size:15px">Server speed (how fast pages respond)</h3>'
      +'<div style="border:2px solid '+col+';border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.8">'
        +'<div style="font-size:15px"><b>Average page response: <span style="color:'+col+'">'+fmt(v)+'</span></b> &nbsp;·&nbsp; median '+fmt(pf.median)+' &nbsp;·&nbsp; slowest '+fmt(pf.max)+' &nbsp;<span style="color:#64748b">(across '+pf.count+' pages)</span></div>'
        +'<div style="color:'+col+';font-weight:700;margin-top:2px">'+verdict+'</div>'
        +'<div style="font-size:12px;color:#64748b;margin-top:4px">Measured live while crawling (server + network time to fetch each page). Slow responses mean a slower experience for visitors and search engines, which can hurt rankings and reduce how often your pages get crawled and indexed.</div>'
        +((pf.slow&&pf.slow.length)?('<div style="margin-top:8px"><b style="color:#b91c1c">Slowest pages (over 2s):</b><div style="font-size:12px;color:#475569;margin-top:3px;line-height:1.7">'+pf.slow.slice(0,8).map(o=>esc(o.url.replace(res.root,'')||'/')+' — <b>'+fmt(o.ms)+'</b>'+(o.retestMs?' · retested alone: '+o.retestMs.map(fmt).join(', ')+(o.loadOnly?' <span style="color:#16a34a;font-weight:700">slow under crawl load only</span>':' <span style="color:#b91c1c;font-weight:700">slow on its own</span>'):'')).join('<br>')+(pf.slow.length>8?'<br>…and '+(pf.slow.length-8)+' more':'')+'</div></div>'):'')
      +'</div>';
  })();
  const loc=res.local;
  const rcol=r=> r>=4.5?'#16a34a':r>=4?'#65a30d':r>=3?'#f59e0b':'#dc2626';
  const localHTML = !loc ? '' : ('<h3 style="margin:20px 0 8px;font-size:15px">Local presence &amp; reviews (Google)</h3>'
    + (loc.found
      ? '<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.8">'
        +'<div><b>Google Business Profile:</b> found — '+esc(loc.name||'')+'</div>'
        +'<div><b>Rating:</b> '+(loc.rating!=null?('<b style="color:'+rcol(loc.rating)+'">'+loc.rating+' ★</b>'):'—')+' &nbsp;·&nbsp; <b>'+(loc.reviews!=null?loc.reviews:0)+'</b> reviews'+((loc.reviews!=null&&loc.reviews<20)?' <span style="color:#b45309">(low — reviews are a top local + AI ranking factor)</span>':'')+'</div>'
        +(loc.address?'<div><b>Address (NAP):</b> '+esc(loc.address)+'</div>':'')
        +(loc.phone?'<div><b>Phone:</b> '+esc(loc.phone)+'</div>':'')
        +(loc.mapsUrl?'<div><a href="'+esc(loc.mapsUrl)+'" style="color:#2563eb;text-decoration:none">View on Google Maps →</a></div>':'')
      +'</div>'
      : '<div style="border:1px solid #fee2e2;background:#fff7f7;border-radius:8px;padding:12px 14px;font-size:13px;color:#b91c1c">No Google Business Profile match found for "'+esc(gbpQueryText(loc.query))+'". If they should have one, it may be unclaimed/misnamed — a major gap for local &amp; AI search. Claiming and optimizing GBP is high priority.</div>'));
  return '<div style="'+F+'">'
    +'<div style="border-bottom:3px solid #0f172a;padding-bottom:12px;margin-bottom:14px"><div style="font-size:20px;font-weight:800">'+esc(BRAND.name)+' — Full-Site SEO &amp; AI Search Audit</div><div style="color:#64748b;font-size:13px">'+esc(res.root)+'</div></div>'
    +handleItHTML(res,'top',siteDomain)
    +'<div style="font-size:13px;color:#334155;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:14px"><b>Coverage:</b> '+coverageLine(cov)+' · discovery via <b>'+esc(cov.via||'?')+'</b>'+(cov.renderAvailable?(' · '+cov.rendered+' JS pages rendered'):' · JS-rendering off (raw HTML only)')+'.</div>'
    +'<div style="font-size:15px;margin-bottom:6px"><b>Site score:</b> <span style="font-size:26px;font-weight:800;color:'+scol(res.siteScore)+'">'+(res.siteScore==null?'—':res.siteScore)+'</span> / 100'+(res.siteBreakdown?'':' (average across audited pages)')+'</div>'
    +siteBreakdownHTML(res.siteBreakdown, scol)
    +topFixesHTML(allFindings(res))
    +handleItHTML(res,'fixes',siteDomain)
    +speedRunsHTML(res.speed, res.root)
    +speedHTML
    +'<h3 style="margin:18px 0 8px;font-size:15px">Readiness by search engine</h3><div style="display:flex;gap:10px;flex-wrap:wrap">'
      +engine('Google', res.siteScore, 'Overall on-page + technical (Google renders JS).')
      +engine('Bing', res.siteScore==null?null:Math.max(0,res.siteScore-(jsCount?Math.min(25,jsCount*3):0)), jsCount?(jsCount+' JS-only pages hurt Bing more'):'Reads mostly raw HTML.')
      +engine('AI Search', res.siteBreakdown&&res.siteBreakdown.aiSearch!=null?res.siteBreakdown.aiSearch:(aiPct==null?null:Math.min(95,aiPct)), jsCount?(jsCount+' pages invisible to AI (JS-only)'):'ChatGPT/Perplexity/AI Overviews. Capped at 95 — live AI answers are not observed.')
    +'</div>'
    +'<h3 style="margin:20px 0 8px;font-size:15px">Site-wide issues (what a single-page scan misses)</h3>'
    +(function(){ var out='';
      const rel=u=>esc(String(u||'').replace(res.root,'')||'/');
      const nap=cp.nap||{};
      out+=issue('Broken internal links', cp.brokenLinks, o=>rel(o.url)+' — HTTP '+o.status+' · linked from '+o.linkedFrom+' page'+(o.linkedFrom===1?'':'s')+' (e.g. '+rel(o.from[0])+')');
      out+=issue('Internal links that redirect', cp.redirectLinks, o=>rel(o.url)+' → '+rel(o.location||'?')+' ('+o.status+') · linked from '+o.linkedFrom+' page'+(o.linkedFrom===1?'':'s'));
      out+=issue('Orphan pages (in the sitemap, linked from nowhere)', cp.orphans, rel);
      out+=issue('Sitemap URLs that redirect or fail', [].concat(cp.sitemapRedirects||[], cp.sitemapBroken||[]), o=>rel(o.url)+' — HTTP '+o.status+(o.location?' → '+rel(o.location):''));
      out+=issue('Near-duplicate pages (80%+ shared text)', cp.nearDuplicates, o=>rel(o.a)+' ≈ '+rel(o.b)+' ('+Math.round(o.similarity*100)+'%)');
      if((nap.inconsistent||[]).length) out+=issue('Inconsistent business name / address / phone (NAP)', nap.inconsistent.map(f=>f), f=>{ const list=f==='phone'?nap.phones:f==='address'?(nap.addressIssue||nap.streets):nap.names;
        return '<b>'+esc(f)+'</b>: '+list.slice(0,5).map(v=>esc(v.value)+' ('+v.pages+' page'+(v.pages===1?'':'s')+')').join(' · '); });
      if((nap.multiLocation||[]).length>1) out+='<div style="border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;padding:10px 12px;margin:0 0 8px"><div style="font-weight:800;color:#334155">Multiple locations detected ('+nap.multiLocation.length+') — info</div><div style="font-size:12px;color:#475569;margin-top:4px;line-height:1.6">These addresses appear consistently (footer/schema), so they read as separate locations, not an inconsistency: '+nap.multiLocation.slice(0,6).map(v=>esc(v.value)+' ('+v.pages+' page'+(v.pages===1?'':'s')+')').join(' · ')+'</div></div>';
      out+=issue('Hard-coded counts that don’t match the site', cp.countClaims, o=>'"'+esc(o.claim)+'" — the site has '+o.actual+' '+o.kind+' page'+(o.actual===1?'':'s')+' · on '+o.urls.length+' page'+(o.urls.length===1?'':'s'));
      out+=issue('H1 words run together in the page code', cp.h1Spacing, o=>rel(o.url)+' — reads as "'+esc(o.sample)+'"');
      out+=issue('"Text"/"SMS" links that dial instead of texting (tel:)', cp.smsTelLinks, o=>rel(o.url)+' — "'+esc(o.labels[0])+'"');
      out+=issue('Pages sharing duplicate body content', cp.duplicateBodies, g=>g.urls.length+' pages: '+esc(g.urls.slice(0,3).map(u=>u.replace(res.root,'')).join(', ')));
      out+=issue('Duplicate page titles', cp.duplicateTitles, g=>'"'+esc(g.value)+'" — '+g.urls.length+' pages');
      out+=issue('Duplicate meta descriptions', cp.duplicateDescriptions, g=>'"'+esc(g.value)+'" — '+g.urls.length+' pages');
      out+=issue('Duplicate H1 headings', cp.duplicateH1, g=>'"'+esc(g.value)+'" — '+g.urls.length+' pages');
      out+=issue('Title doesn’t match page content', cp.titleBodyMismatch, u=>esc(u.replace(res.root,'')||'/'));
      out+=issue('Thin content (under 250 words)', cp.thin, o=>esc(o.url.replace(res.root,'')||'/')+' — '+o.words+'w');
      out+=issue('JavaScript-rendered (invisible to AI/Bing)', cp.jsRendered, u=>esc(u.replace(res.root,'')||'/'));
      out+=issue('Missing H1', cp.missingH1, u=>esc(u.replace(res.root,'')||'/'));
      return out||'<div style="color:#16a34a;font-size:13px">No site-wide issues detected across audited pages.</div>'; })()
    +failedPagesHTML(res)
    +nonHtmlHTML(res)
    +findingsByCategoryHTML(allFindings(res), res.root)
    +coverageMatrixHTML([res])
    +stackHTML(res.stack)
    +'<h3 style="margin:20px 0 8px;font-size:15px">Per-page scores ('+ok.length+')</h3>'
    +'<div style="overflow:auto"><table style="border-collapse:collapse;width:100%;font-size:13px"><tr><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Grade</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Page</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Notes</th></tr>'+pageRows+'</table>'+(ok.length>60?'<div style="font-size:12px;color:#64748b;margin-top:6px">Showing first 60 of '+ok.length+'.</div>':'')+'</div>'
    +localHTML
    +aiExplainerHTML()
    +handleItHTML(res,'footer',siteDomain)
    +ctaBlockHTML()
    +engineFooterHTML(res.engineVersion)
  +'</div>';
}

// ---------- CRMColumbus report / email helpers ----------
function reportHTML(r){
  if(!r||r.error) return '<p style="color:#dc2626">Report unavailable.</p>';
  const sc=score(r); const col=sc.color;
  const issues=r.checks.filter(c=>c.status==='fail'||c.status==='warn').sort((a,b)=>a.status===b.status?b.points-a.points:(a.status==='fail'?-1:1));
  const quick=issues.filter(c=>isQuick(c.label)), proj=issues.filter(c=>!isQuick(c.label));
  const passes=r.checks.filter(c=>c.status==='pass');
  const cats=Object.keys(sc.byCat);
  const F="font-family:'Inter',system-ui,Arial,sans-serif;color:#0f172a";
  const card=c=>{const scol=c.status==='fail'?'#dc2626':'#f59e0b';return '<div style="border:1px solid #e2e8f0;border-left:5px solid '+scol+';border-radius:6px;padding:12px 14px;margin:0 0 10px"><div style="font-weight:800">'+esc(c.issue||problemTitle(c))+'</div>'+(c.detail?'<div style="font-size:13px;color:#475569;margin-top:3px"><b>Now:</b> '+esc(c.detail)+'</div>':'')+(c.why?'<div style="font-size:13px;color:#475569;margin-top:3px"><b>Why:</b> '+esc(c.why)+'</div>':'')+(c.fix?'<div style="font-size:13px;margin-top:3px"><b>Fix:</b> '+esc(c.fix)+'</div>':'')+'</div>';};
  let speed='';
  if(r.speed&&((r.speed.mobile&&!r.speed.mobile.error)||(r.speed.desktop&&!r.speed.desktop.error))){
    const m=r.speed.mobile,d=r.speed.desktop;
    const chip=(l,s)=>{ if(!s||s.error||s.score==null)return ''; const c=s.score>=90?'#16a34a':s.score>=50?'#ea580c':'#dc2626'; return '<span style="display:inline-block;margin-right:20px"><b style="font-size:26px;color:'+c+'">'+s.score+'</b><span style="color:#64748b">/100 '+l+'</span></span>'; };
    speed='<h3 style="margin:22px 0 8px;font-size:15px">Page Speed — live Google data</h3><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px">'+chip('Mobile',m)+chip('Desktop',d)+'<div style="color:#7f1d1d;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;margin-top:10px;font-size:13px">Slow pages bounce customers to competitors and rank lower in Google.</div></div>';
  }
  return '<div style="'+F+';max-width:760px;margin:0 auto">'+SNAPSHOT_BANNER_HTML
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;border-bottom:3px solid #0f172a;padding-bottom:12px;margin-bottom:18px">'
      +'<div><div style="font-size:20px;font-weight:800;color:#0f172a">'+esc(BRAND.name)+'</div><div style="color:#64748b;font-size:13px">'+esc(BRAND.tagline)+'</div></div>'
      +'<div style="text-align:right;font-size:12px;color:#64748b">SEO &amp; AI Search Audit<br>'+esc(r.domain)+' · '+esc(r.timestamp||'')+'</div>'
    +'</div>'
    +handleItHTML(r,'top',r.domain)
    +sitemapLineHTML(r.sitemap)
    +'<div style="border:2px solid '+col+';border-radius:10px;padding:18px 20px;margin-bottom:16px">'
      +'<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b">Executive summary — '+esc(r.domain)+'</div>'
      +'<div style="font-size:30px;font-weight:800;color:'+col+'">'+sc.score+'/100 · Grade '+sc.grade+'</div>'
      +'<div style="font-size:14px;color:#334155;margin-top:4px">'+esc(sc.verdict||'')+'</div>'
      +'<div style="font-size:13px;margin-top:6px"><b style="color:#16a34a">'+sc.counts.pass+'</b> passing · <b style="color:#b45309">'+sc.counts.warn+'</b> to improve · <b style="color:#b91c1c">'+sc.counts.fail+'</b> critical</div>'
    +'</div>'+speed
    +'<h3 style="margin:22px 0 8px;font-size:15px">Category breakdown</h3>'
    +cats.map(cat=>{const p=catPercent(cat,sc.byCat[cat]);const c=p>=80?'#16a34a':p>=60?'#f59e0b':'#dc2626';return '<div style="display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px"><span style="flex:0 0 180px;color:#475569">'+esc(cat)+'</span><span style="flex:1;height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden"><span style="display:block;height:100%;width:'+p+'%;background:'+c+'"></span></span><span style="flex:0 0 40px;text-align:right;font-weight:700;color:'+c+'">'+p+'%</span></div>';}).join('')
    +(quick.length?'<h3 style="margin:22px 0 8px;font-size:15px">Quick wins</h3>'+quick.map(card).join(''):'')
    +(proj.length?'<h3 style="margin:22px 0 8px;font-size:15px">Bigger projects</h3>'+proj.map(card).join(''):'')
    +handleItHTML(r,'fixes',r.domain)
    +'<h3 style="margin:22px 0 8px;font-size:15px">What\'s working ('+passes.length+')</h3><div style="font-size:13px;color:#334155;line-height:1.7">'+passes.map(c=>'✓ '+esc(c.label)).join('<br>')+'</div>'
    +aiExplainerHTML()
    +handleItHTML(r,'footer',r.domain)
    +ctaBlockHTML()
    +engineFooterHTML(r.engineVersion)
  +'</div>';
}
function findingsHTML(r){
  if(!r||r.error) return '<p style="color:#dc2626">Audit unavailable.</p>';
  const sc=score(r);
  const issues=r.checks.filter(c=>c.status==='fail'||c.status==='warn').sort((a,b)=>(a.status===b.status?b.points-a.points:(a.status==='fail'?-1:1)));
  const col=sc.score>=91?'#16a34a':sc.score>=80?'#ea580c':'#dc2626';
  const rows=issues.map(c=>`<li style="margin:6px 0"><b style="color:${c.status==='fail'?'#b91c1c':'#b45309'}">${esc(c.issue||problemTitle(c))}</b>${c.fix?`<br><span style="opacity:.8">${esc(c.fix)}</span>`:''}</li>`).join('');
  return `<div>
    <div style="font-size:20px;font-weight:800;color:${col}">Grade ${sc.grade} · ${sc.score}/100</div>
    <div style="opacity:.8;font-size:13px;margin:2px 0 8px">${sc.counts.fail} critical · ${sc.counts.warn} to improve · ${sc.counts.pass} passing</div>
    ${issues.length?`<ul style="margin:0;padding-left:18px;font-size:13px">${rows}</ul>`:'<div style="color:#16a34a">No major issues found.</div>'}
  </div>`;
}
// Solicitation email = the REPORT SNAPSHOT (executive summary + live page speed + category breakdown)
// with sales verbiage. Deliberately NO issue list and NO fixes — the category bars show weak areas;
// the exact step-by-step fixes are the paid deliverable.
function emailHTML(clientName,r,opts){
  opts=opts||{};
  const sc=score(r); const col=sc.color; const cats=Object.keys(sc.byCat);
  const contacts=BRAND.contacts.map(c=>esc(c.name)+' · '+esc(c.phone)+' · '+esc(c.email)).join('<br>');
  const F="font-family:'Helvetica Neue',Arial,sans-serif;color:#0f172a";
  // Live Page Speed — big number(s) + loss callout (only if we measured it)
  let speed='';
  if(r.speed&&((r.speed.mobile&&!r.speed.mobile.error&&r.speed.mobile.score!=null)||(r.speed.desktop&&!r.speed.desktop.error&&r.speed.desktop.score!=null))){
    const chip=(l,s)=>{ if(!s||s.error||s.score==null)return ''; const c=s.score>=90?'#16a34a':s.score>=50?'#ea580c':'#dc2626'; return '<span style="display:inline-block;margin-right:22px"><b style="font-size:28px;color:'+c+'">'+s.score+'</b><span style="color:#64748b">/100 '+l+'</span></span>'; };
    speed='<h3 style="margin:22px 0 8px;font-size:15px">Page Speed — live Google data</h3>'
      +'<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px">'+chip('Mobile',r.speed.mobile)+chip('Desktop',r.speed.desktop)
      +'<div style="color:#7f1d1d;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;margin-top:10px;font-size:13px">Slow pages bounce customers to competitors and rank lower in Google.</div></div>';
  }
  // Category breakdown — table-based bars (robust across email clients)
  const catRows=cats.map(cat=>{
    const p=catPercent(cat,sc.byCat[cat]); const c=p>=80?'#16a34a':p>=60?'#f59e0b':'#dc2626';
    return '<tr>'
      +'<td style="color:#475569;padding:4px 10px 4px 0;font-size:13px;white-space:nowrap;vertical-align:middle">'+esc(cat)+'</td>'
      +'<td style="padding:4px 0;vertical-align:middle;width:100%"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;background:#e2e8f0;border-radius:999px"><tr>'
        +'<td style="height:10px;background:'+c+';border-radius:999px;font-size:0;line-height:0;width:'+p+'%">&nbsp;</td>'+(p<100?'<td style="font-size:0;line-height:0">&nbsp;</td>':'')
      +'</tr></table></td>'
      +'<td style="text-align:right;font-weight:700;color:'+c+';padding:4px 0 4px 10px;font-size:13px;white-space:nowrap;vertical-align:middle">'+p+'%</td>'
    +'</tr>';
  }).join('');
  const breakdown='<h3 style="margin:22px 0 8px;font-size:15px">Category breakdown</h3><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">'+catRows+'</table>';
  const buyBtn=opts.buyUrl?'<div style="margin-top:12px"><a href="'+opts.buyUrl+'" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:800;padding:10px 18px;border-radius:6px">Get the full report — $'+((BRAND.reportPrice||'$49').replace(/[^0-9]/g,'')||'49')+' (DIY)</a></div>':'';
  return '<div style="'+F+';max-width:640px;margin:0 auto;padding:8px">'
    +'<div style="border-bottom:3px solid #0f172a;padding-bottom:12px;margin-bottom:16px"><div style="font-size:22px;font-weight:800">SEO &amp; AI Search Audit</div><div style="color:#64748b;font-size:13px">'+esc(BRAND.name)+' · '+esc(BRAND.tagline)+'</div></div>'
    +(clientName?'<p style="font-size:15px">Hi '+esc(clientName)+',</p>':'')
    +'<p style="font-size:15px;line-height:1.6">We audited your website across Google SEO and AI search (ChatGPT, Google AI Overviews, Perplexity) — where customers now decide who to call. Here is where you stand and what it is costing you.</p>'
    // Executive summary card (outlined in grade color)
    +'<div style="border:2px solid '+col+';border-radius:10px;padding:18px 20px;margin:0 0 16px">'
      +'<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b">Executive summary — '+esc(r.domain)+'</div>'
      +'<div style="font-size:30px;font-weight:800;color:'+col+';margin-top:2px">'+sc.score+'/100 · Grade '+sc.grade+'</div>'
      +'<div style="font-size:14px;color:#334155;margin-top:4px">'+esc(sc.verdict||'')+'</div>'
      +'<div style="font-size:13px;margin-top:6px"><b style="color:#16a34a">'+sc.counts.pass+'</b> passing · <b style="color:#b45309">'+sc.counts.warn+'</b> to improve · <b style="color:#b91c1c">'+sc.counts.fail+'</b> critical</div>'
    +'</div>'
    +speed
    +breakdown
    // Sales CTA
    +'<div style="background:#0f172a;color:#fff;border-radius:10px;padding:22px 24px;margin:20px 0 16px"><div style="font-size:19px;font-weight:800;margin-bottom:8px">Let us turn this into more calls — this week.</div>'
      +'<p style="margin:0 0 14px;color:#e2e8f0;font-size:14px;line-height:1.6">Your weakest areas above are quietly sending customers to competitors. '+esc(BRAND.name)+' handles the Google SEO and the AI-search work most agencies are not doing yet — so you show up first and win the call. Every one of these is fixable, usually faster than you think.</p>'
      +'<div style="margin-bottom:6px">Reply or call for a <b>free 15-minute walkthrough</b> and we will show you the plan.</div>'+buyBtn
      +'<div style="margin-top:14px;font-size:14px;color:#cbd5e1;line-height:1.7">'+contacts+'</div></div>'
    +'<p style="color:#94a3b8;font-size:12px">'+esc(BRAND.name)+' · '+esc(BRAND.web)+' · audit engine v'+esc(r.engineVersion||ENGINE_VERSION)+'</p></div>';
}
function emailText(clientName,r){
  const sc=score(r); let t=(clientName?('Hi '+clientName+',\n\n'):'Hi,\n\n');
  t+='We audited your website across Google SEO and AI search (ChatGPT, Google AI Overviews, Perplexity) — where customers now decide who to call.\n\n';
  t+='EXECUTIVE SUMMARY — '+r.domain+'\n'+sc.score+'/100 · Grade '+sc.grade+'\n'+(sc.verdict||'')+'\n'+sc.counts.pass+' passing · '+sc.counts.warn+' to improve · '+sc.counts.fail+' critical\n\n';
  if(r.speed){ const m=r.speed.mobile,d=r.speed.desktop; const parts=[]; if(m&&!m.error&&m.score!=null)parts.push(m.score+'/100 Mobile'); if(d&&!d.error&&d.score!=null)parts.push(d.score+'/100 Desktop'); if(parts.length)t+='Page Speed (live Google data): '+parts.join(' · ')+'\nSlow pages bounce customers to competitors and rank lower in Google.\n\n'; }
  const cats=Object.keys(sc.byCat);
  if(cats.length){ t+='Category breakdown:\n'; cats.forEach(cat=>{ const p=catPercent(cat,sc.byCat[cat]); t+='  '+cat+': '+p+'%\n'; }); t+='\n'; }
  t+='Your weakest areas above are sending customers to competitors — every one is fixable. Reply or call for a free 15-minute walkthrough and we will show you the plan.\n\n'+BRAND.contacts.map(c=>c.name+' · '+c.phone+' · '+c.email).join('\n')+'\n'+BRAND.web+'\n';
  return t;
}
async function audit(url, opts){
  opts=opts||{};
  resetLinkCache();
  await loadIndustry(opts.industry, opts.market);
  const r=await auditOne(url);
  try{ await addAux(r); }catch(e){}
  try{ r.sitemap=await sitemapSummary(r.origin||r.url, { primaryCity:r.primaryCity }); }catch(e){}
  try{ await measureAssets([r], 120); }catch(e){} // real image / script sizes for the weight + image checks
  if(opts.speed!==false){ try{ await addSpeed(r, opts.psiKey||''); }catch(e){} }
  r.engine='Homepage snapshot';
  return r;
}
// Homepage-only results say so, and point at the full-site audit.
const SNAPSHOT_BANNER_HTML='<div style="background:#fef3c7;border:1px solid #fcd34d;color:#78350f;border-radius:8px;padding:8px 12px;margin:0 0 12px;font-size:13px;font-weight:600">Homepage snapshot — full-site audit available.</div>';
function sitemapLineHTML(sm){ if(!sm) return ''; return '<div style="font-size:13px;color:#475569;margin:0 0 12px">'+(sm.found?'Sitemap: <b>'+sm.total+'</b> pages · <b>'+sm.service+'</b> service · <b>'+sm.location+'</b> location · newest content <b>'+esc(sm.newest||'not dated')+'</b>':'No XML sitemap found')+'</div>'; }
// Side-by-side comparison of many businesses (ranked leaderboard from stored audits).
// items: [{ name, report }]. Ranks best-to-worst; color-codes score, speed and each category.
function comparisonHTML(items){
  const F="font-family:'Inter',system-ui,Arial,sans-serif;color:#0f172a";
  const rows=(items||[]).filter(x=>x&&x.report&&!x.report.error).map(x=>{
    const rep=x.report;
    if(rep.coverage && rep.siteScore!=null){ // a saved full-site crawl
      const s=rep.siteScore, b=rep.siteBreakdown||{}, home=(rep.speed||[])[0], cv=b.coverage||{};
      const byCat={}; (rep.pages||[]).forEach(p=>{ const bc=p._score&&p._score.byCat||{}; Object.keys(bc).forEach(c=>{ byCat[c]=byCat[c]||{e:0,t:0}; byCat[c].e+=bc[c].e; byCat[c].t+=bc[c].t; }); });
      return { name:x.name||String(rep.root).replace(/^https?:\/\//,''), domain:String(rep.root).replace(/^https?:\/\//,''), engine:'Full-site crawl',
        sc:{score:s, grade:s>=90?'A':s>=80?'B':s>=70?'C':s>=55?'D':'F', byCat}, mobile:home&&home.mobile&&!home.mobile.error?home.mobile.score:null,
        sm:{found:true, total:(rep.coverage||{}).audited, service:cv.service, location:cv.location, newest:(b.freshness||{}).newest||null} };
    }
    const sc=score(rep); const sp=rep.speed||{};
    const mob=(sp.mobile&&!sp.mobile.error&&sp.mobile.score!=null)?sp.mobile.score:null;
    return { name:x.name||rep.domain, domain:rep.domain, sc:sc, mobile:mob, engine:'Homepage snapshot', sm:rep.sitemap||null };
  });
  if(!rows.length) return '<p style="'+F+'">Select two or more audited companies to compare. (Companies without a saved audit can\'t be ranked yet — run their audit first.)</p>';
  rows.sort((a,b)=>(b.sc.score||0)-(a.sc.score||0));
  const catSet={}; rows.forEach(r=>Object.keys(r.sc.byCat).forEach(c=>catSet[c]=1)); const cats=Object.keys(catSet);
  const gcol=s=> s>=90?'#16a34a':s>=80?'#65a30d':s>=70?'#f59e0b':s>=55?'#f97316':'#dc2626';
  const pcol=p=> p>=80?'#16a34a':p>=60?'#f59e0b':'#dc2626';
  const medal=i=> i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'.';
  const CATSHORT={'Indexability & Crawlability':'Index','On-Page Content':'On-Page','Technical & Mobile':'Technical','Local SEO':'Local SEO','Social Sharing':'Social','Images & Accessibility':'Images','Performance Hygiene':'Perf.','AI Search & Answer Engines':'AI Search','Page Speed & Core Web Vitals':'Speed'};
  const th=t=>'<th style="text-align:left;padding:8px 10px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e2e8f0;white-space:nowrap">'+esc(t)+'</th>';
  const thc=(c)=>'<th title="'+esc(c)+'" style="text-align:left;padding:8px 6px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.03em;border-bottom:2px solid #e2e8f0">'+esc(CATSHORT[c]||c)+'</th>';
  const hasSm=rows.some(r=>r.sm);
  const smTd=v=>'<td style="padding:8px 10px">'+(v==null?'—':esc(String(v)))+'</td>';
  const head='<tr>'+th('#')+th('Company')+th('Audit')+th('Grade')+th('Score')+th('Mobile')+cats.map(thc).join('')+(hasSm?th('Pages')+th('Service pages')+th('Location pages')+th('Newest content'):'')+'</tr>';
  const body=rows.map((r,i)=>{
    const cells=cats.map(c=>{ const b=r.sc.byCat[c]; if(!b||!b.t) return '<td style="padding:8px 10px;color:#94a3b8">—</td>'; const p=catPercent(c,b); return '<td style="padding:8px 10px;font-weight:700;color:'+pcol(p)+'">'+p+'%</td>'; }).join('');
    const mob=r.mobile==null?'<td style="padding:8px 10px;color:#94a3b8">—</td>':'<td style="padding:8px 10px;font-weight:700;color:'+gcol(r.mobile)+'">'+r.mobile+'</td>';
    return '<tr style="border-bottom:1px solid #eef2f7;'+(i===0?'background:#f0fdf4':'')+'">'
      +'<td style="padding:8px 10px;font-weight:800">'+medal(i)+'</td>'
      +'<td style="padding:8px 10px;font-weight:700;white-space:nowrap">'+esc(r.name)+'<div style="font-size:11px;color:#94a3b8;font-weight:400">'+esc(r.domain)+'</div></td>'
      +'<td style="padding:8px 10px;font-size:11px;color:#64748b;white-space:nowrap">'+esc(r.engine)+'</td>'
      +'<td style="padding:8px 10px;font-weight:800;color:'+gcol(r.sc.score)+'">'+r.sc.grade+'</td>'
      +'<td style="padding:8px 10px;font-weight:800;color:'+gcol(r.sc.score)+'">'+r.sc.score+'</td>'
      +mob+cells+(hasSm?(r.sm&&r.sm.found?smTd(r.sm.total)+smTd(r.sm.service)+smTd(r.sm.location)+smTd(r.sm.newest):'<td colspan="4" style="padding:8px 10px;color:#94a3b8">'+(r.sm?'no sitemap':'—')+'</td>'):'')+'</tr>';
  }).join('');
  const ctaFor=(items||[]).map(x=>x&&(x.rep?x:x.report)).find(x=>x&&x.rep)||{};
  return '<div style="'+F+'">'
    +'<div style="border-bottom:3px solid #0f172a;padding-bottom:12px;margin-bottom:16px"><div style="font-size:20px;font-weight:800">SEO &amp; AI Search — Side-by-Side</div><div style="color:#64748b;font-size:13px">'+esc(BRAND.name)+' · '+rows.length+' businesses ranked</div></div>'
    +(rows.some(r=>r.engine==='Homepage snapshot')?SNAPSHOT_BANNER_HTML:'')
    +handleItHTML(ctaFor,'top')
    +'<div style="overflow:auto"><table style="border-collapse:collapse;width:100%;font-size:13px">'+head+body+'</table></div>'
    +handleItHTML(ctaFor,'fixes')
    +'<div style="font-size:12px;color:#64748b;margin-top:10px">Ranked best to worst by overall score. Green ≥80% · amber 60–79% · red under 60%. The lowest-ranked businesses are your strongest sales prospects.</div>'
    +handleItHTML(ctaFor,'footer')
  +'</div>';
}
const API={ BRAND, PROXIES, TAGS, AI_BOTS, AISEARCH, PROJECT_FIXES, sleep, esc, isQuick, setAbort,
  fetchHtml, fetchAux, aiCrawlerStatus, auditOne, addAux, fetchPSI, addSpeed, score, audit,
  ENGINE_VERSION, engineFooterHTML, intentionalNoindex, gbpQueryText, failedPagesHTML, nonHtmlHTML, isNonHtml, coverageLine, archiveDuplicationFinding, retestSlowPages, pageTypesFor, gbpQuery, titleBrand, problemTitle, checkSeverity, shortfallSeverity, catPercent, measureAssets, loadIndustry, allFindings, discoverPages, sitemapSummary, crossPageIssues, crawlSite, siteReportHTML, siteTopIssues, siteComparisonHTML, speedRunsHTML, aiExplainerHTML, ctaBlockHTML, PSI_RUNS,
  reportHTML, findingsHTML, emailHTML, emailText, comparisonHTML,
  // building blocks, exposed for tests
  handleItHTML, repFor, PACKAGES, CTA_TRACK_URL,
  classifyPage, mainContent, localEntities, countClaims, h1Glued, smsLabelTelLinks, businessSchema, ldNodes, AI_SEARCH_BOTS, AI_TRAINING_BOTS,
  // individual checks, for unit tests
  _x:{ setBackoff:ms=>{ CHALLENGE_BACKOFF_MS=ms; }, setRenderCap:n=>{ RENDER_FALLBACK_CAP=n; }, resetScan:()=>resetLinkCache(), freshnessScore, findPrice, isPricingLink, soft404Check, viewportZoomCheck, headingHierarchyCheck, imageCheck, weightCheck, pageAssets, robotsRulesFor, robotsAllowed, chainOf, technicalFindings, applyDeductions, titleQualityCheck, uniqueContentCheck, titlePixels, genericH1Check, descEqualsTitleCheck, genericAnchorCheck, onPageLinkFindings, yearClaims, staleClaimsCheck, placeholderCheck, defaultPrivacyCheck, contentFreshnessFindings, contradictionFindings, serviceCoverage, locationCoverage, callAboveFoldCheck, areaCodeCheck, localFindings, jsonLdSyntaxCheck, businessEntityCheck, schemaNapCheck, napIssues, claimIssues, richResultsCheck, richResultsTestUrl, openingHoursCheck, serviceSchemaCheck, breadcrumbCheck, faqMatchCheck, schemaTypesCheck, licenseCheck, pricingCheck, insuranceCheck, trustFindings, resolveAsyncFindings, questionAnswerCheck, citableFactsCheck, aiSiteFindings, stackFingerprint, loadIndustry, setMarket:(m)=>{ _market=m; } } };
root.SEO=API;
if(typeof module!=="undefined"&&module.exports) module.exports=API;
})(typeof window!=="undefined"?window:globalThis);
