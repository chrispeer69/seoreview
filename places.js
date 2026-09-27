'use strict';
// Google Business Profile lookup for the audit engine. Search by the business NAME (schema name / title brand) and
// PHONE, falling back to the ADDRESS — never by industry + city (that finds a competitor). When several places come
// back, the one whose phone matches the site's phone wins.
// CRMColumbus/server.js keeps an identical copy of makePlacesLookup + pickPlace (separate repo) — change both.
const digits = s => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const norm = s => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();

// Choose among place details: phone match first, then a name match, else the first candidate.
function pickPlace(cands, want) {
  const phone = digits(want && want.phone), name = norm(want && want.name);
  if (!cands.length) return null;
  if (phone) { const byPhone = cands.find(c => digits(c.formatted_phone_number || c.international_phone_number) === phone); if (byPhone) return { place: byPhone, matchedBy: 'phone' }; }
  if (name) { const byName = cands.find(c => { const n = norm(c.name); return n && (n === name || n.includes(name) || name.includes(n)); }); if (byName) return { place: byName, matchedBy: 'name' }; }
  return { place: cands[0], matchedBy: 'first result' };
}

function makePlacesLookup(getJson, key) {
  const FIELDS = 'place_id,name,rating,user_ratings_total,url,formatted_address,formatted_phone_number,international_phone_number,reviews,website,opening_hours';
  const api = (p, q) => getJson('https://maps.googleapis.com/maps/api/place/' + p + '/json?' + q + '&key=' + encodeURIComponent(key));
  return async function placesLookup(name, opts) {
    opts = opts || {};
    const ids = [], add = list => (list || []).forEach(r => { if (r && r.place_id && !ids.includes(r.place_id)) ids.push(r.place_id); });
    const d = digits(opts.phone);
    const tried = [];
    if (d.length === 10) { tried.push('phone'); add((await api('findplacefromtext', 'inputtype=phonenumber&fields=place_id&input=' + encodeURIComponent('+1' + d))).candidates); }
    if (name) { tried.push('name'); add(((await api('textsearch', 'query=' + encodeURIComponent(name + (opts.address ? ' ' + opts.address : '')))).results || []).slice(0, 5)); }
    if (!ids.length && opts.address) { tried.push('address'); add(((await api('textsearch', 'query=' + encodeURIComponent(opts.address))).results || []).slice(0, 3)); }
    if (!ids.length) return { found: false, query: { name: name || null, phone: opts.phone || null, address: opts.address || null }, tried };
    const details = (await Promise.all(ids.slice(0, 3).map(id => api('details', 'place_id=' + id + '&fields=' + FIELDS).then(j => j.result).catch(() => null)))).filter(Boolean);
    const pick = pickPlace(details, { phone: opts.phone, name });
    if (!pick) return { found: false, tried };
    const p = pick.place, oh = p.opening_hours;
    return {
      found: true, matchedBy: pick.matchedBy, candidates: details.length, tried,
      name: p.name, rating: p.rating, reviews: p.user_ratings_total, address: p.formatted_address, phone: p.formatted_phone_number, mapsUrl: p.url, website: p.website || null,
      // GBP hours; open247 = Google's "open 24 hours" (one period opening Sunday 00:00 with no close).
      hours: oh ? { weekdayText: oh.weekday_text || [], open247: !!(oh.periods && oh.periods.length === 1 && oh.periods[0].open && oh.periods[0].open.time === '0000' && !oh.periods[0].close) } : null,
      recent: (p.reviews || []).slice(0, 3).map(x => ({ author: x.author_name, rating: x.rating, text: x.text, when: x.relative_time_description })),
    };
  };
}
module.exports = { makePlacesLookup, pickPlace };
