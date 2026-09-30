'use strict';
// $49 hosted-report checkout (Stripe REST, no SDK). The Stripe account is shared with CRMColumbus (same $49 flow)
// and the Review Tracker (licenses, reports, subscriptions, its own webhook), so every session this app creates is
// tagged metadata.app = "seoreview" and bound to its report (client_reference_id = the report token), and a
// session only unlocks the report it was bought for: a paid session from another app - or for another report -
// never unlocks anything here. This app has no webhook; payment is confirmed by reading the session back.
const APP = 'seoreview';

function makeStripePay({ key, baseUrl, priceCents, fetchImpl }) {
  const f = fetchImpl || fetch;
  const auth = () => ({ 'Authorization': 'Bearer ' + key });
  async function createCheckout(token, name) {
    if (!key || !token) return null;
    const p = new URLSearchParams();
    p.set('mode', 'payment');
    p.set('success_url', baseUrl + '/r/' + token + '?session_id={CHECKOUT_SESSION_ID}');
    p.set('cancel_url', baseUrl + '/r/' + token);
    p.set('client_reference_id', token);
    p.set('metadata[app]', APP);
    p.set('metadata[report_token]', token);
    p.set('payment_intent_data[metadata][app]', APP);
    p.set('payment_intent_data[metadata][report_token]', token);
    p.set('line_items[0][quantity]', '1');
    p.set('line_items[0][price_data][currency]', 'usd');
    p.set('line_items[0][price_data][unit_amount]', String(priceCents));
    p.set('line_items[0][price_data][product_data][name]', 'Full SEO & AI Search Report' + (name ? (' — ' + name) : ''));
    try {
      const r = await f('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, auth()), body: p.toString() });
      if (!r.ok) { console.error('stripe checkout', r.status, await r.text().catch(() => '')); return null; }
      return (await r.json()).url;
    } catch (e) { console.error('stripe checkout err', e.message); return null; }
  }
  // Paid AND for this report AND (for sessions made since tagging) by this app.
  async function sessionPaidFor(sessionId, token) {
    if (!key || !sessionId || !token) return false;
    try {
      const r = await f('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), { headers: auth() });
      if (!r.ok) return false;
      const s = await r.json();
      const app = (s.metadata || {}).app;
      return s.payment_status === 'paid' && s.client_reference_id === token && (!app || app === APP);
    } catch (e) { return false; }
  }
  return { createCheckout, sessionPaidFor };
}
module.exports = { makeStripePay, APP };
