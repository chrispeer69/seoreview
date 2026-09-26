/* Blue Collar AI — SEO & AI Search audit engine. THE ONE COPY.
   Used by the public tool (web-analyzer-siteV7.html, and headless-audit.js for /api/v1) and by CRMColumbus,
   whose server redirects /seo-engine.js to this file on the seoreview deploy. Change the engine here only.
   Browser/jsdom script: needs DOMParser + fetch. Exposes window.SEO. */
(function(root){
"use strict";
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
const PROXIES = [
  // Our own server-side proxy first (reliable, no rate limits). Public proxies
  // remain as fallback for local file:// use or if the server is unavailable.
  { name:'self',           build:u=>`/api/proxy?url=${encodeURIComponent(u)}`, json:false },
  { name:'allorigins-raw', build:u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, json:false },
  { name:'corsproxy',      build:u=>`https://corsproxy.io/?url=${encodeURIComponent(u)}`, json:false },
  { name:'allorigins-get', build:u=>`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, json:true },
  { name:'corsfix',        build:u=>`https://proxy.corsfix.com/?${u}`, json:false },
];
const TAGS = {
  'Google Analytics':['google-analytics.com','gtag(','/g/collect','_gaq'],
  'Google Tag Manager':['googletagmanager.com'],
  'Google Ads':['googleadservices.com','gtag/js?id=AW-'],
  'Meta / Facebook Pixel':['connect.facebook.net','fbq(','facebook.com/tr'],
  'Microsoft Clarity':['clarity.ms'],
  'Hotjar':['hotjar.com'],
  'TikTok Pixel':['analytics.tiktok.com','ttq.'],
  'LinkedIn Insight':['snap.licdn.com'],
};
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
  'Sufficient content','Served over HTTPS','No mixed (insecure) content','LocalBusiness structured data',
  'Reasonable page weight','Limited render-blocking scripts','Q&A / FAQ structured data',
  'Semantic main-content region','Review / rating schema (stars)',
  'Mobile speed score','Desktop speed score','Largest Contentful Paint (mobile)','Layout stability (mobile CLS)'
]);
function isQuick(label){ return !PROJECT_FIXES.has(label); }
async function fetchHtml(targetUrl){
  let lastErr;
  for(const p of PROXIES){
    if(scanCtrl&&scanCtrl.signal.aborted) throw new DOMException('aborted','AbortError');
    const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),12000); linkAbort(ctrl);
    try{
      const res=await fetch(p.build(targetUrl),{signal:ctrl.signal});
      if(p.name==='self') _fetchMeta.set(targetUrl,{status:res.status, finalUrl:res.headers.get('x-final-url')||null});
      if(!res.ok){lastErr=new Error(p.name+' HTTP '+res.status);continue;}
      const html=p.json?(await res.json()).contents:await res.text();
      if(html&&html.length>50)return html;
      lastErr=new Error(p.name+' empty');
    }catch(e){lastErr=e;}finally{clearTimeout(t);}
  }
  throw lastErr||new Error('All proxies failed');
}
async function fetchAux(u){
  for(const p of PROXIES.slice(0,4)){
    if(scanCtrl&&scanCtrl.signal.aborted) return '';
    const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),8000); linkAbort(ctrl);
    try{
      const res=await fetch(p.build(u),{signal:ctrl.signal});
      if(res.ok){const txt=p.json?(await res.json()).contents:await res.text();clearTimeout(t);return txt||'';}
    }catch(e){}finally{clearTimeout(t);}
  }
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
function ldNodes(doc){
  const out=[];
  const walk=(v,depth)=>{ if(!v||typeof v!=='object'||depth>8) return;
    if(Array.isArray(v)){ v.forEach(x=>walk(x,depth+1)); return; }
    if(v['@type']) out.push(v);
    Object.keys(v).forEach(k=>{ if(k!=='@context') walk(v[k],depth+1); }); };
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
function resetLinkCache(){ _linkCache.clear(); _fetchMeta.clear(); _lcAvailable=true; }
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
  const tLow=(doc.querySelector('title')?.textContent||'').trim().toLowerCase();
  const cTitles=['just a moment','one moment','attention required','checking your browser','please wait','verifying you are human','ddos-guard'];
  // Cloudflare injects "/cdn-cgi/challenge-platform/" into NORMAL 200 pages, so that substring is NOT a block signal.
  // Gate strong markers behind an interstitial-sized body so real pages embedding a Turnstile widget aren't flagged.
  const cSigs=['cf-browser-verification','__cf_chl','cf_chl_opt','_imperva_','distil_r_captcha','challenges.cloudflare.com/turnstile'];
  const interstitial = bodyText.length < 1500;
  if(cTitles.some(t=>tLow.includes(t)) || (interstitial && cSigs.some(s=>html.includes(s)))) throw {blocked:true,reason:'Blocked by bot protection (a Cloudflare / DDoS-Guard style challenge page was returned, not the site).'};

  const checks=[];
  const add=(cat,label,points,status,detail,why,fix)=>checks.push({cat,label,points,status,detail,why,fix});

  // ---- gather ----
  const titleEl=doc.querySelector('title');
  const title=(titleEl?.textContent||'').trim();
  const titleCount=doc.querySelectorAll('title').length;
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
  const hasMap=/google\.com\/maps|maps\.google|goo\.gl\/maps/i.test(html);
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

  add(INDEX,'Page is indexable',14, noindex?'fail':'pass',
    noindex?'A "noindex" directive is present':'No noindex directive',
    'A "noindex" tag is a stop sign telling Google to hide this page completely. If it is there by mistake, nothing else you do matters — you are invisible in search.',
    'Remove the "noindex" value from the robots meta tag so search engines can list the page.');
  const canon=canonical?await canonicalCheck(canonical.getAttribute('href')||'', url, noindex):{status:'fail',detail:'No canonical link'};
  add(INDEX,'Canonical URL set',6, canon.status, canon.detail,
    'This tells Google which version of your web address is the real one, so your ranking power is not split between www / non-www or trailing-slash duplicates. A canonical that points at a redirect, an error page or a noindex page tells Google to index nothing.',
    canonical?'Point the canonical at the final, indexable URL of this page (the address that returns 200 with no redirect and no noindex).'
             :'Add <link rel="canonical" href="'+esc(origin)+'/"> in the page head pointing to the preferred URL.');

  add(CONTENT,'Title tag present',12, title?'pass':'fail',
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
  add(CONTENT,'Meta description present',9, desc?'pass':'fail',
    desc?('"'+desc.slice(0,90)+(desc.length>90?'…':'')+'"'):'Missing',
    'This is the grey summary under your title in Google. It does not change ranking, but a good one convinces people to click you instead of a competitor.',
    'Write a compelling 120–155 character summary with the service, location, and a reason to click (e.g. "Call now").');
  if(desc) add(CONTENT,'Description length optimal',3,(desc.length>=80&&desc.length<=160)?'pass':'warn',desc.length+' characters','Too short under-sells you; over ~160 characters gets cut off.','Target 120–155 characters.');
  add(CONTENT,'Exactly one H1 heading',8, h1.length===1?'pass':'fail',
    h1.length+' H1 tag(s)',
    'The H1 is the big headline on the page. None means Google cannot tell what the page is about; several muddy the signal and can look spammy.',
    h1.length===0?'Add a single visible <h1> with your main service + city.':'Keep one <h1> and demote the others to <h2>.');
  add(CONTENT,'Uses subheadings (H2)',3, h2.length>0?'pass':'warn',h2.length+' H2 tag(s)','Subheadings make the page easy to skim for customers and easy to understand for search engines and AI.','Break content into sections with descriptive H2 headings.');
  add(CONTENT,'Sufficient content',5, words>=250?'pass':'warn',words+' words of visible text','Thin pages rarely rank. Google rewards pages that actually answer what the visitor came for.','Add genuinely useful content — services, areas served, FAQs — aiming for 300+ words.');

  add(TECH,'Served over HTTPS',9, ssl?'pass':'fail', ssl?'Secure':'Not secure','The padlock in the browser bar. Google ranks secure sites higher and browsers scare visitors away from sites without it.','Install an SSL certificate (free via Let\'s Encrypt or your host) and force HTTPS.');
  add(TECH,'Mobile viewport set',7, viewport?'pass':'fail', viewport?'Configured':'Missing','Without this the site looks broken on phones — and Google judges your site by its phone version first.','Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
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
  add(LOCAL,'Review / rating schema (stars)',0, selfReview?'warn':'info',
    selfReview?'aggregateRating / review is marked up on the business itself (self-serving)':(hasReview?'Review markup found (not on the business entity)':'No review or rating schema'),
    'Google does not show review stars for a business\'s own reviews marked up on its own site (LocalBusiness / Organization), and can treat it as spammy structured data. Your stars come from your Google Business Profile reviews.',
    selfReview?'Remove aggregateRating / review from the LocalBusiness / Organization JSON-LD; keep earning reviews on your Google Business Profile.':'');
  add(LOCAL,'Click-to-call phone link',4, tel>0?'pass':'warn', tel>0?(tel+' tel: link(s)'):'None found','A tappable phone number turns a phone visitor into a phone call with one tap. Missing it quietly costs you leads.','Wrap the phone number in <a href="tel:+1...">.');
  add(LOCAL,'Map / location reference',3, hasMap?'pass':'warn', hasMap?'Map detected':'No map embed found','A map and visible address prove to Google (and customers) exactly where you serve.','Embed a Google Map and show the full address (matching your Google Business Profile).');

  add(SOCIAL,'Open Graph tags',5, ogCount>=2?'pass':(ogCount===1?'warn':'fail'), ogCount+' of 3 core OG tags','Controls how your link looks when shared on Facebook, in texts, and on LinkedIn. A bare, ugly link looks unprofessional and gets ignored.','Add og:title, og:description, and og:image meta tags.');
  add(SOCIAL,'Twitter / X card',3, twCard?'pass':'warn', twCard?'Configured':'Missing','Controls the preview when your link is shared on X (Twitter).','Add <meta name="twitter:card" content="summary_large_image">.');

  add(MEDIA,'Images have alt text',6, !imgs.length?'warn':(withAlt/imgs.length>=0.8?'pass':(withAlt/imgs.length>=0.4?'warn':'fail')),
    imgs.length?(withAlt+' of '+imgs.length+' images have alt text'):'No images detected in HTML',
    'Alt text describes images for visually-impaired visitors and helps you show up in Google Images — a free spot to work in your service and city.',
    'Add descriptive alt text to every meaningful image (e.g. "tow truck in Columbus OH").');
  add(MEDIA,'Images have dimensions',2, !imgs.length?'pass':(withDim/Math.max(1,imgs.length)>=0.6?'pass':'warn'),
    imgs.length?(withDim+' of '+imgs.length+' images set width/height'):'n/a','Telling the browser each image size stops the page from jumping around as it loads (something Google measures and dislikes).','Add width and height attributes to images.');

  add(PERF,'Reasonable page weight',3, sizeKb<500?'pass':'warn', sizeKb+' KB of HTML','A heavy page is slow to appear, especially on phones and slower connections — and slow pages lose visitors.','Trim inline content and let the builder lazy-load below-the-fold sections.');
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

  return { url, domain:o.hostname, origin, timestamp:new Date().toLocaleString(), ssl, checks, tracking, schemaTypes,
    title, h1text:(h1[0]&&h1[0].textContent||'').trim(), desc, words, jsShell, loadMs,
    bodySig:bodyText.slice(0,600).replace(/\s+/g,' ').toLowerCase().trim(),
    stats:{images:imgs.length, scripts:doc.querySelectorAll('script').length, stylesheets:doc.querySelectorAll('link[rel="stylesheet"]').length, sizeKb, words},
    aux:{robots:null,sitemap:null}, _origin:origin };
}

async function addAux(r){
  // best-effort robots.txt + sitemap + AI-crawler + llms.txt, never fail the audit
  const INDEX='Indexability & Crawlability';
  const robots=await fetchAux(r.origin+'/robots.txt');
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
      field: j.loadingExperience&&j.loadingExperience.overall_category?j.loadingExperience.overall_category:null
    };
  }catch(e){ return {error:e.name==='AbortError'?'timeout':'fetch failed'}; }
  finally{ clearTimeout(t); }
}
async function addSpeed(r, key){
  const SPEED='Page Speed & Core Web Vitals';
  const [m,d]=await Promise.all([fetchPSI(r.url,'mobile',key), fetchPSI(r.url,'desktop',key)]);
  r.speed={mobile:m, desktop:d};
  const scoreStatus=s=> s==null?'info' : s>=90?'pass' : s>=50?'warn':'fail';
  // Mobile score (weighted highest — Google is mobile-first)
  if(m.error){
    r.checks.push({cat:SPEED,label:'Mobile speed score',points:0,status:'info',detail:'Could not measure ('+m.error+')',why:'',fix:''});
  }else{
    r.checks.push({cat:SPEED,label:'Mobile speed score',points:6,status:scoreStatus(m.score),
      detail:(m.score!=null?m.score+'/100':'n/a')+(m.field?' · real users: '+m.field.toLowerCase().replace('_',' '):''),
      why:'Google measures your site by its phone version first, and most local searches happen on phones. A slow mobile site quietly loses customers and rankings.',
      fix:'Compress and lazy-load images, enable caching / a CDN, and defer non-critical scripts. PageSpeed Insights lists the exact opportunities.'});
    if(m.lcp!=null){ const s= m.lcp<=2500?'pass':m.lcp<=4000?'warn':'fail';
      r.checks.push({cat:SPEED,label:'Largest Contentful Paint (mobile)',points:4,status:s,
        detail:(m.lcpTxt||Math.round(m.lcp)+' ms')+' (good ≤ 2.5s)',
        why:'LCP is how long until the main content actually appears. Over 2.5 seconds feels slow and hurts both conversions and ranking.',
        fix:'Optimize the largest image / hero, use modern formats (WebP/AVIF), and remove render-blocking CSS and scripts.'});
    }
    if(m.cls!=null){ const s= m.cls<=0.1?'pass':m.cls<=0.25?'warn':'fail';
      r.checks.push({cat:SPEED,label:'Layout stability (mobile CLS)',points:2,status:s,
        detail:(m.clsTxt!=null?String(m.clsTxt):String(m.cls))+' (good ≤ 0.1)',
        why:'CLS measures how much the page jumps around while loading. Jumpy pages frustrate visitors and are penalized by Google.',
        fix:'Set width and height on images and reserve space for ads, banners, and embeds.'});
    }
  }
  // Desktop score
  if(d.error){
    r.checks.push({cat:SPEED,label:'Desktop speed score',points:0,status:'info',detail:'Could not measure ('+d.error+')',why:'',fix:''});
  }else{
    r.checks.push({cat:SPEED,label:'Desktop speed score',points:3,status:scoreStatus(d.score),
      detail:(d.score!=null?d.score+'/100':'n/a'),
      why:'Desktop speed still matters for the office and at-home customers researching your services on a computer.',
      fix:'Same wins as mobile: optimize images, enable caching, and defer non-critical scripts.'});
  }
}

function score(r){
  if(!r||r.error) return {score:null,grade:'—',color:'#94a3b8',counts:{pass:0,warn:0,fail:0},byCat:{},verdict:'',scored:0};
  let earned=0,total=0,scored=0; const counts={pass:0,warn:0,fail:0}; const byCat={};
  r.checks.forEach(c=>{
    if(c.status==='pass')counts.pass++; else if(c.status==='warn')counts.warn++; else if(c.status==='fail')counts.fail++;
    if(c.status==='info'||!c.points) return;
    scored++;
    const w= c.status==='pass'?1: c.status==='warn'?0.5:0;
    earned+=c.points*w; total+=c.points;
    if(!byCat[c.cat])byCat[c.cat]={e:0,t:0};
    byCat[c.cat].e+=c.points*w; byCat[c.cat].t+=c.points;
  });
  const s= total? Math.round(100*earned/total):0;
  let grade,color;
  if(s>=90){grade='A';color='#16a34a';} else if(s>=80){grade='B';color='#65a30d';}
  else if(s>=70){grade='C';color='#f59e0b';} else if(s>=55){grade='D';color='#f97316';} else {grade='F';color='#dc2626';}
  const verdict = s>=90?'Strong SEO foundation with only minor polish needed.'
    : s>=80?'Solid, but a handful of fixes would meaningfully improve visibility.'
    : s>=70?'Several important gaps are holding this site back in search.'
    : s>=55?'Significant SEO problems are limiting how often this site is found.'
    : 'Major SEO issues — the site is likely losing substantial search traffic.';
  return {score:s,grade,color,counts,byCat,verdict,scored};
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
  let locs=[]; let via='sitemap';
  for(const sm of smList){
    const xml=await grab1(sm); const l=[...String(xml).matchAll(locRe)].map(m=>m[1]);
    const kids=l.filter(u=>/\.xml(\?|$)/i.test(u));
    if(kids.length && kids.length>=l.length-1){ for(const c of kids.slice(0,20)){ const cx=await grab1(c); locs=locs.concat([...String(cx).matchAll(locRe)].map(m=>m[1])); if(locs.length>max*3)break; } }
    else locs=locs.concat(l);
    if(locs.length) break;
  }
  let urls=[...new Set(locs.filter(u=>/^https?:\/\//i.test(u) && !/\.xml(\?|$)/i.test(u)))];
  if(!urls.length){ via='link-crawl'; let home=await grab(base+'/'); urls=linksIn(home);
    if(urls.length<3 && render){ try{ const rh=await render(base+'/'); if(rh){ const rl=linksIn(rh); if(rl.length>urls.length){ urls=rl; via='link-crawl (rendered)'; } } }catch(e){} }
    urls.unshift(base+'/'); urls=[...new Set(urls)]; }
  urls=[...new Set(urls.map(u=>u.split('#')[0]).filter(Boolean))];
  return { base, urls:urls.slice(0,max), total:urls.length, capped:urls.length>max, via };
}
function crossPageIssues(pages){
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
  const group=(key)=>{ const m={}; pages.forEach(p=>{ const k=norm(p[key]); if(k)(m[k]=m[k]||[]).push(p.url); }); return Object.keys(m).filter(k=>m[k].length>1).map(k=>({value:k.slice(0,80),urls:m[k]})); };
  const bodyGroups=(()=>{ const m={}; pages.forEach(p=>{ const k=p.bodySig; if(k)(m[k]=m[k]||[]).push(p.url); }); return Object.keys(m).filter(k=>m[k].length>1).map(k=>({sample:k.slice(0,80),urls:m[k]})); })();
  const stop=['home','page','service','services','ohio','near','the','and','for','with','your'];
  const mismatch=pages.filter(p=>{ if(!p.title||!p.bodySig)return false; const ws=norm(p.title).split(/[^a-z0-9]+/).filter(w=>w.length>=4&&stop.indexOf(w)<0); if(!ws.length)return false; return ws.filter(w=>p.bodySig.indexOf(w)>=0).length/ws.length < 0.34; }).map(p=>p.url);
  return { duplicateTitles:group('title'), duplicateH1:group('h1text'), duplicateBodies:bodyGroups, titleBodyMismatch:mismatch,
    thin:pages.filter(p=>p.words!=null&&p.words<250).map(p=>({url:p.url,words:p.words})),
    jsRendered:pages.filter(p=>p.jsShell).map(p=>p.url), missingH1:pages.filter(p=>!p.h1text).map(p=>p.url) };
}
async function crawlSite(root, opts){
  opts=opts||{}; const max=opts.max||150, conc=opts.concurrency||5, onProgress=opts.onProgress||function(){};
  resetLinkCache();
  const render=typeof opts.render==='function'?opts.render:null;
  const disc=await discoverPages(root, max, render);
  if(!disc.urls.length) return { error:'No pages discovered (no sitemap and no crawlable links — the site may be a JavaScript app with no sitemap).', root:disc.base };
  const pages=[]; let i=0, done=0, rendered=0;
  async function loadPage(u){
    let r;
    try{ r=await auditOne(u); }
    catch(e1){ // one free retry — most failures are transient (slow origin throttling under concurrency)
      try{ r=await auditOne(u); }
      catch(e2){ if(render){ const html=await render(u); if(html){ r=await auditOne(u, html); r._rendered=true; rendered++; return r; } } throw e2; }
    }
    if(r.jsShell && render){ try{ const html=await render(u); if(html){ r=await auditOne(u, html); r._rendered=true; rendered++; } }catch(e){} }
    return r;
  }
  async function worker(){ while(true){ const idx=i++; if(idx>=disc.urls.length)return; const u=disc.urls[idx];
    try{ const r=await loadPage(u); r._score=score(r); pages.push(r); }
    catch(e){ pages.push({ url:u, error:(e&&e.reason)||(e&&e.message)||'failed' }); }
    done++; onProgress(done, disc.urls.length, u); } }
  const pool=[]; for(let w=0; w<conc; w++) pool.push(worker()); await Promise.all(pool);
  const ok=pages.filter(p=>!p.error); const scored=ok.filter(p=>p._score&&p._score.score!=null);
  const siteScore=scored.length?Math.round(scored.reduce((a,p)=>a+p._score.score,0)/scored.length):null;
  const times=ok.map(p=>p.loadMs).filter(v=>v!=null);
  let perf=null;
  if(times.length){ const sorted=times.slice().sort((a,b)=>a-b); const avg=Math.round(times.reduce((a,b)=>a+b,0)/times.length);
    perf={ avg, median:sorted[Math.floor(sorted.length/2)], max:sorted[sorted.length-1], count:times.length,
      slow:ok.filter(p=>p.loadMs!=null&&p.loadMs>2000).map(p=>({url:p.url,ms:p.loadMs})).sort((a,b)=>b.ms-a.ms) }; }
  let local=null;
  if(typeof opts.places==='function'){
    try{
      const home=ok.find(p=>p.url===disc.base+'/'||p.url===disc.base)||ok[0];
      const bizName=(home&&home.title?home.title.split(/[|\-–—:·]/)[0].trim():'')||disc.base.replace(/^https?:\/\//,'').replace(/^www\./,'').split('.')[0];
      const pl=await opts.places(bizName);
      local=(pl&&(pl.name||pl.rating!=null||pl.address))
        ? { found:true, name:pl.name||bizName, rating:pl.rating, reviews:pl.reviews, address:pl.address, phone:pl.phone, website:pl.website, mapsUrl:pl.mapsUrl }
        : { found:false, query:bizName };
    }catch(e){ local=null; }
  }
  return { root:disc.base, siteScore, perf, local, crossPage:crossPageIssues(ok), pages,
    coverage:{ discovered:disc.total, audited:ok.length, failed:pages.length-ok.length, capped:disc.capped, cap:max, via:disc.via, rendered:rendered, renderAvailable:!!render } };
}
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
function siteReportHTML(res){
  if(!res||res.error) return '<p style="color:#dc2626;font-family:Inter,Arial,sans-serif">Crawl failed: '+esc(res&&res.error||'unknown')+'</p>';
  const F="font-family:'Inter',system-ui,Arial,sans-serif;color:#0f172a";
  const cov=res.coverage||{}; const cp=res.crossPage||{};
  const scol=s=> s==null?'#94a3b8':s>=90?'#16a34a':s>=80?'#65a30d':s>=70?'#f59e0b':s>=55?'#f97316':'#dc2626';
  const ok=(res.pages||[]).filter(p=>!p.error);
  const catAgg={}; ok.forEach(p=>{ const bc=p._score&&p._score.byCat||{}; Object.keys(bc).forEach(c=>{ catAgg[c]=catAgg[c]||{e:0,t:0}; catAgg[c].e+=bc[c].e; catAgg[c].t+=bc[c].t; }); });
  const catPct=c=>catAgg[c]&&catAgg[c].t?Math.round(100*catAgg[c].e/catAgg[c].t):null;
  const jsCount=(cp.jsRendered||[]).length; const aiPct=catPct('AI Search & Answer Engines');
  const engine=(label,val,note)=>'<div style="flex:1;min-width:150px;border:1px solid #e2e8f0;border-radius:8px;padding:12px"><div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">'+label+'</div><div style="font-size:24px;font-weight:800;color:'+scol(val)+'">'+(val==null?'—':val)+(val==null?'':'%')+'</div><div style="font-size:12px;color:#64748b;margin-top:2px">'+note+'</div></div>';
  const issue=(title,arr,fmt)=>{ arr=arr||[]; if(!arr.length) return ''; const items=arr.slice(0,8).map(fmt||(u=>esc(String(u)))).join('<br>'); return '<div style="border:1px solid #fee2e2;background:#fff7f7;border-radius:8px;padding:10px 12px;margin:0 0 8px"><div style="font-weight:800;color:#b91c1c">'+esc(title)+' ('+arr.length+')</div><div style="font-size:12px;color:#475569;margin-top:4px;line-height:1.6">'+items+(arr.length>8?'<br>…and '+(arr.length-8)+' more':'')+'</div></div>'; };
  const pageRows=ok.slice(0,60).map(p=>{ var s=p._score||{}; return '<tr style="border-bottom:1px solid #eef2f7"><td style="padding:5px 8px;font-weight:700;color:'+scol(s.score)+'">'+(s.grade||'?')+(s.score!=null?' '+s.score:'')+'</td><td style="padding:5px 8px;font-size:12px">'+esc(p.url.replace(res.root,'')||'/')+'</td><td style="padding:5px 8px;font-size:12px;color:#64748b">'+(p.words||0)+'w'+(p.jsShell?' · JS':'')+(p._rendered?' · rendered':'')+'</td></tr>'; }).join('');
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
        +((pf.slow&&pf.slow.length)?('<div style="margin-top:8px"><b style="color:#b91c1c">Slowest pages (over 2s):</b><div style="font-size:12px;color:#475569;margin-top:3px;line-height:1.7">'+pf.slow.slice(0,8).map(o=>esc(o.url.replace(res.root,'')||'/')+' — <b>'+fmt(o.ms)+'</b>').join('<br>')+(pf.slow.length>8?'<br>…and '+(pf.slow.length-8)+' more':'')+'</div></div>'):'')
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
      : '<div style="border:1px solid #fee2e2;background:#fff7f7;border-radius:8px;padding:12px 14px;font-size:13px;color:#b91c1c">No Google Business Profile match found for "'+esc(loc.query||'')+'". If they should have one, it may be unclaimed/misnamed — a major gap for local &amp; AI search. Claiming and optimizing GBP is high priority.</div>'));
  return '<div style="'+F+'">'
    +'<div style="border-bottom:3px solid #0f172a;padding-bottom:12px;margin-bottom:14px"><div style="font-size:20px;font-weight:800">'+esc(BRAND.name)+' — Full-Site SEO &amp; AI Search Audit</div><div style="color:#64748b;font-size:13px">'+esc(res.root)+'</div></div>'
    +'<div style="font-size:13px;color:#334155;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:14px"><b>Coverage:</b> audited <b>'+cov.audited+'</b> of <b>'+cov.discovered+'</b> pages found'+(cov.capped?(' (capped at '+cov.cap+' — more exist)'):'')+' · discovery via <b>'+esc(cov.via||'?')+'</b>'+(cov.failed?(' · '+cov.failed+' failed to load'):'')+(cov.renderAvailable?(' · '+cov.rendered+' JS pages rendered'):' · JS-rendering off (raw HTML only)')+'.</div>'
    +'<div style="font-size:15px;margin-bottom:6px"><b>Site score:</b> <span style="font-size:26px;font-weight:800;color:'+scol(res.siteScore)+'">'+(res.siteScore==null?'—':res.siteScore)+'</span> / 100 (average across audited pages)</div>'
    +speedHTML
    +'<h3 style="margin:18px 0 8px;font-size:15px">Readiness by search engine</h3><div style="display:flex;gap:10px;flex-wrap:wrap">'
      +engine('Google', res.siteScore, 'Overall on-page + technical (Google renders JS).')
      +engine('Bing', res.siteScore==null?null:Math.max(0,res.siteScore-(jsCount?Math.min(25,jsCount*3):0)), jsCount?(jsCount+' JS-only pages hurt Bing more'):'Reads mostly raw HTML.')
      +engine('AI Search', aiPct, jsCount?(jsCount+' pages invisible to AI (JS-only)'):'ChatGPT/Perplexity/AI Overviews.')
    +'</div>'
    +'<h3 style="margin:20px 0 8px;font-size:15px">Site-wide issues (what a single-page scan misses)</h3>'
    +(function(){ var out='';
      out+=issue('Pages sharing duplicate body content', cp.duplicateBodies, g=>g.urls.length+' pages: '+esc(g.urls.slice(0,3).map(u=>u.replace(res.root,'')).join(', ')));
      out+=issue('Duplicate page titles', cp.duplicateTitles, g=>'"'+esc(g.value)+'" — '+g.urls.length+' pages');
      out+=issue('Duplicate H1 headings', cp.duplicateH1, g=>'"'+esc(g.value)+'" — '+g.urls.length+' pages');
      out+=issue('Title doesn’t match page content', cp.titleBodyMismatch, u=>esc(u.replace(res.root,'')||'/'));
      out+=issue('Thin content (under 250 words)', cp.thin, o=>esc(o.url.replace(res.root,'')||'/')+' — '+o.words+'w');
      out+=issue('JavaScript-rendered (invisible to AI/Bing)', cp.jsRendered, u=>esc(u.replace(res.root,'')||'/'));
      out+=issue('Missing H1', cp.missingH1, u=>esc(u.replace(res.root,'')||'/'));
      return out||'<div style="color:#16a34a;font-size:13px">No site-wide issues detected across audited pages.</div>'; })()
    +'<h3 style="margin:20px 0 8px;font-size:15px">Per-page scores ('+ok.length+')</h3>'
    +'<div style="overflow:auto"><table style="border-collapse:collapse;width:100%;font-size:13px"><tr><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Grade</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Page</th><th style="text-align:left;padding:5px 8px;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Notes</th></tr>'+pageRows+'</table>'+(ok.length>60?'<div style="font-size:12px;color:#64748b;margin-top:6px">Showing first 60 of '+ok.length+'.</div>':'')+'</div>'
    +localHTML
    +aiExplainerHTML()
    +ctaBlockHTML()
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
  const card=c=>{const scol=c.status==='fail'?'#dc2626':'#f59e0b';return '<div style="border:1px solid #e2e8f0;border-left:5px solid '+scol+';border-radius:6px;padding:12px 14px;margin:0 0 10px"><div style="font-weight:800">'+esc(c.label)+'</div>'+(c.detail?'<div style="font-size:13px;color:#475569;margin-top:3px"><b>Now:</b> '+esc(c.detail)+'</div>':'')+(c.why?'<div style="font-size:13px;color:#475569;margin-top:3px"><b>Why:</b> '+esc(c.why)+'</div>':'')+(c.fix?'<div style="font-size:13px;margin-top:3px"><b>Fix:</b> '+esc(c.fix)+'</div>':'')+'</div>';};
  let speed='';
  if(r.speed&&((r.speed.mobile&&!r.speed.mobile.error)||(r.speed.desktop&&!r.speed.desktop.error))){
    const m=r.speed.mobile,d=r.speed.desktop;
    const chip=(l,s)=>{ if(!s||s.error||s.score==null)return ''; const c=s.score>=90?'#16a34a':s.score>=50?'#ea580c':'#dc2626'; return '<span style="display:inline-block;margin-right:20px"><b style="font-size:26px;color:'+c+'">'+s.score+'</b><span style="color:#64748b">/100 '+l+'</span></span>'; };
    speed='<h3 style="margin:22px 0 8px;font-size:15px">Page Speed — live Google data</h3><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px">'+chip('Mobile',m)+chip('Desktop',d)+'<div style="color:#7f1d1d;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;margin-top:10px;font-size:13px">Slow pages bounce customers to competitors and rank lower in Google.</div></div>';
  }
  return '<div style="'+F+';max-width:760px;margin:0 auto">'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;border-bottom:3px solid #0f172a;padding-bottom:12px;margin-bottom:18px">'
      +'<div><div style="font-size:20px;font-weight:800;color:#0f172a">'+esc(BRAND.name)+'</div><div style="color:#64748b;font-size:13px">'+esc(BRAND.tagline)+'</div></div>'
      +'<div style="text-align:right;font-size:12px;color:#64748b">SEO &amp; AI Search Audit<br>'+esc(r.domain)+' · '+esc(r.timestamp||'')+'</div>'
    +'</div>'
    +'<div style="border:2px solid '+col+';border-radius:10px;padding:18px 20px;margin-bottom:16px">'
      +'<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b">Executive summary — '+esc(r.domain)+'</div>'
      +'<div style="font-size:30px;font-weight:800;color:'+col+'">'+sc.score+'/100 · Grade '+sc.grade+'</div>'
      +'<div style="font-size:14px;color:#334155;margin-top:4px">'+esc(sc.verdict||'')+'</div>'
      +'<div style="font-size:13px;margin-top:6px"><b style="color:#16a34a">'+sc.counts.pass+'</b> passing · <b style="color:#b45309">'+sc.counts.warn+'</b> to improve · <b style="color:#b91c1c">'+sc.counts.fail+'</b> critical</div>'
    +'</div>'+speed
    +'<h3 style="margin:22px 0 8px;font-size:15px">Category breakdown</h3>'
    +cats.map(cat=>{const p=Math.round(100*sc.byCat[cat].e/sc.byCat[cat].t);const c=p>=80?'#16a34a':p>=60?'#f59e0b':'#dc2626';return '<div style="display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px"><span style="flex:0 0 180px;color:#475569">'+esc(cat)+'</span><span style="flex:1;height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden"><span style="display:block;height:100%;width:'+p+'%;background:'+c+'"></span></span><span style="flex:0 0 40px;text-align:right;font-weight:700;color:'+c+'">'+p+'%</span></div>';}).join('')
    +(quick.length?'<h3 style="margin:22px 0 8px;font-size:15px">Quick wins</h3>'+quick.map(card).join(''):'')
    +(proj.length?'<h3 style="margin:22px 0 8px;font-size:15px">Bigger projects</h3>'+proj.map(card).join(''):'')
    +'<h3 style="margin:22px 0 8px;font-size:15px">What\'s working ('+passes.length+')</h3><div style="font-size:13px;color:#334155;line-height:1.7">'+passes.map(c=>'✓ '+esc(c.label)).join('<br>')+'</div>'
    +aiExplainerHTML()
    +ctaBlockHTML()
  +'</div>';
}
function findingsHTML(r){
  if(!r||r.error) return '<p style="color:#dc2626">Audit unavailable.</p>';
  const sc=score(r);
  const issues=r.checks.filter(c=>c.status==='fail'||c.status==='warn').sort((a,b)=>(a.status===b.status?b.points-a.points:(a.status==='fail'?-1:1)));
  const col=sc.score>=91?'#16a34a':sc.score>=80?'#ea580c':'#dc2626';
  const rows=issues.map(c=>`<li style="margin:6px 0"><b style="color:${c.status==='fail'?'#b91c1c':'#b45309'}">${esc(c.label)}</b>${c.fix?`<br><span style="opacity:.8">${esc(c.fix)}</span>`:''}</li>`).join('');
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
    const p=Math.round(100*sc.byCat[cat].e/sc.byCat[cat].t); const c=p>=80?'#16a34a':p>=60?'#f59e0b':'#dc2626';
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
    +'<p style="color:#94a3b8;font-size:12px">'+esc(BRAND.name)+' · '+esc(BRAND.web)+'</p></div>';
}
function emailText(clientName,r){
  const sc=score(r); let t=(clientName?('Hi '+clientName+',\n\n'):'Hi,\n\n');
  t+='We audited your website across Google SEO and AI search (ChatGPT, Google AI Overviews, Perplexity) — where customers now decide who to call.\n\n';
  t+='EXECUTIVE SUMMARY — '+r.domain+'\n'+sc.score+'/100 · Grade '+sc.grade+'\n'+(sc.verdict||'')+'\n'+sc.counts.pass+' passing · '+sc.counts.warn+' to improve · '+sc.counts.fail+' critical\n\n';
  if(r.speed){ const m=r.speed.mobile,d=r.speed.desktop; const parts=[]; if(m&&!m.error&&m.score!=null)parts.push(m.score+'/100 Mobile'); if(d&&!d.error&&d.score!=null)parts.push(d.score+'/100 Desktop'); if(parts.length)t+='Page Speed (live Google data): '+parts.join(' · ')+'\nSlow pages bounce customers to competitors and rank lower in Google.\n\n'; }
  const cats=Object.keys(sc.byCat);
  if(cats.length){ t+='Category breakdown:\n'; cats.forEach(cat=>{ const p=Math.round(100*sc.byCat[cat].e/sc.byCat[cat].t); t+='  '+cat+': '+p+'%\n'; }); t+='\n'; }
  t+='Your weakest areas above are sending customers to competitors — every one is fixable. Reply or call for a free 15-minute walkthrough and we will show you the plan.\n\n'+BRAND.contacts.map(c=>c.name+' · '+c.phone+' · '+c.email).join('\n')+'\n'+BRAND.web+'\n';
  return t;
}
async function audit(url, opts){
  opts=opts||{};
  resetLinkCache();
  const r=await auditOne(url);
  try{ await addAux(r); }catch(e){}
  if(opts.speed!==false){ try{ await addSpeed(r, opts.psiKey||''); }catch(e){} }
  return r;
}
// Side-by-side comparison of many businesses (ranked leaderboard from stored audits).
// items: [{ name, report }]. Ranks best-to-worst; color-codes score, speed and each category.
function comparisonHTML(items){
  const F="font-family:'Inter',system-ui,Arial,sans-serif;color:#0f172a";
  const rows=(items||[]).filter(x=>x&&x.report).map(x=>{
    const sc=score(x.report); const sp=x.report.speed||{};
    const mob=(sp.mobile&&!sp.mobile.error&&sp.mobile.score!=null)?sp.mobile.score:null;
    return { name:x.name||x.report.domain, domain:x.report.domain, sc:sc, mobile:mob };
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
  const head='<tr>'+th('#')+th('Company')+th('Grade')+th('Score')+th('Mobile')+cats.map(thc).join('')+'</tr>';
  const body=rows.map((r,i)=>{
    const cells=cats.map(c=>{ const b=r.sc.byCat[c]; if(!b||!b.t) return '<td style="padding:8px 10px;color:#94a3b8">—</td>'; const p=Math.round(100*b.e/b.t); return '<td style="padding:8px 10px;font-weight:700;color:'+pcol(p)+'">'+p+'%</td>'; }).join('');
    const mob=r.mobile==null?'<td style="padding:8px 10px;color:#94a3b8">—</td>':'<td style="padding:8px 10px;font-weight:700;color:'+gcol(r.mobile)+'">'+r.mobile+'</td>';
    return '<tr style="border-bottom:1px solid #eef2f7;'+(i===0?'background:#f0fdf4':'')+'">'
      +'<td style="padding:8px 10px;font-weight:800">'+medal(i)+'</td>'
      +'<td style="padding:8px 10px;font-weight:700;white-space:nowrap">'+esc(r.name)+'<div style="font-size:11px;color:#94a3b8;font-weight:400">'+esc(r.domain)+'</div></td>'
      +'<td style="padding:8px 10px;font-weight:800;color:'+gcol(r.sc.score)+'">'+r.sc.grade+'</td>'
      +'<td style="padding:8px 10px;font-weight:800;color:'+gcol(r.sc.score)+'">'+r.sc.score+'</td>'
      +mob+cells+'</tr>';
  }).join('');
  return '<div style="'+F+'">'
    +'<div style="border-bottom:3px solid #0f172a;padding-bottom:12px;margin-bottom:16px"><div style="font-size:20px;font-weight:800">SEO &amp; AI Search — Side-by-Side</div><div style="color:#64748b;font-size:13px">'+esc(BRAND.name)+' · '+rows.length+' businesses ranked</div></div>'
    +'<div style="overflow:auto"><table style="border-collapse:collapse;width:100%;font-size:13px">'+head+body+'</table></div>'
    +'<div style="font-size:12px;color:#64748b;margin-top:10px">Ranked best to worst by overall score. Green ≥80% · amber 60–79% · red under 60%. The lowest-ranked businesses are your strongest sales prospects.</div>'
  +'</div>';
}
const API={ BRAND, PROXIES, TAGS, AI_BOTS, AISEARCH, PROJECT_FIXES, sleep, esc, isQuick, setAbort,
  fetchHtml, fetchAux, aiCrawlerStatus, auditOne, addAux, fetchPSI, addSpeed, score, audit,
  discoverPages, crossPageIssues, crawlSite, siteReportHTML, aiExplainerHTML, ctaBlockHTML,
  reportHTML, findingsHTML, emailHTML, emailText, comparisonHTML };
root.SEO=API;
if(typeof module!=="undefined"&&module.exports) module.exports=API;
})(typeof window!=="undefined"?window:globalThis);
