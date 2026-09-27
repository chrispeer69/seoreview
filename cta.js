'use strict';
// "Handle this for me" report CTA: validation for the taps each hosted report beacons to POST /api/cta-tap.
// A beaconed CTA tap, validated: an http(s) report link (the view token stays — it identifies the link), a known kind.
function ctaLinkKey(u) { try { const x = new URL(u); return x.host + x.pathname; } catch (e) { return String(u || '').slice(0, 300); } }
function ctaTap(body) {
  let j; try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch (e) { return null; }
  if (!j || typeof j.link !== 'string' || !/^https?:\/\//.test(j.link)) return null;
  const pick = (v, ok) => (ok.includes(v) ? v : null);
  return { link: j.link.slice(0, 500), kind: pick(j.kind, ['call', 'text']), where: pick(j.where, ['top', 'fixes', 'footer']), rep: typeof j.rep === 'string' ? j.rep.slice(0, 40) : null };
}
module.exports = { ctaTap, ctaLinkKey };
