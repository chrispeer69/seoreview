'use strict';
// The Stripe account is shared with CRMColumbus and the Review Tracker: a checkout made here is tagged app=seoreview
// and bound to its report, and only a paid session for THIS report (made by this app) unlocks it.
const test = require('node:test');
const assert = require('node:assert');
const { makeStripePay } = require('../stripe-pay');

function fakeStripe(sessions) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const json = b => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (opts && opts.method === 'POST') return json({ url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
    const id = decodeURIComponent(url.split('/').pop());
    return sessions[id] ? json(sessions[id]) : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { calls, pay: makeStripePay({ key: 'sk_test_x', baseUrl: 'https://seo.example', priceCents: 4900, fetchImpl }) };
}

test('checkout is tagged app=seoreview and bound to the report token', async () => {
  const { calls, pay } = fakeStripe({});
  assert.strictEqual(await pay.createCheckout('tok123', 'Cap Towing'), 'https://checkout.stripe.com/c/pay/cs_test_new');
  const body = new URLSearchParams(calls[0].opts.body);
  assert.strictEqual(body.get('client_reference_id'), 'tok123');
  assert.strictEqual(body.get('metadata[app]'), 'seoreview');
  assert.strictEqual(body.get('metadata[report_token]'), 'tok123');
  assert.strictEqual(body.get('payment_intent_data[metadata][app]'), 'seoreview');
  assert.strictEqual(body.get('line_items[0][price_data][unit_amount]'), '4900');
  assert.strictEqual(body.get('metadata[purpose]'), null, 'never the tracker\'s purpose tag (license/report)');
  assert.match(body.get('success_url'), /^https:\/\/seo\.example\/r\/tok123\?session_id=\{CHECKOUT_SESSION_ID\}$/);
});

test('only a paid session for this report, from this app, unlocks it', async () => {
  const { pay } = fakeStripe({
    cs_ok: { payment_status: 'paid', client_reference_id: 'tok123', metadata: { app: 'seoreview' } },
    cs_legacy: { payment_status: 'paid', client_reference_id: 'tok123', metadata: {} },          // before tagging
    cs_other_report: { payment_status: 'paid', client_reference_id: 'tok999', metadata: { app: 'seoreview' } },
    cs_crm: { payment_status: 'paid', client_reference_id: 'tok123', metadata: { app: 'crmcolumbus' } },
    cs_tracker: { payment_status: 'paid', client_reference_id: null, metadata: { purpose: 'license', item: 'monthly', account_id: '4' } },
    cs_unpaid: { payment_status: 'unpaid', client_reference_id: 'tok123', metadata: { app: 'seoreview' } },
  });
  assert.strictEqual(await pay.sessionPaidFor('cs_ok', 'tok123'), true);
  assert.strictEqual(await pay.sessionPaidFor('cs_legacy', 'tok123'), true);
  assert.strictEqual(await pay.sessionPaidFor('cs_other_report', 'tok123'), false);
  assert.strictEqual(await pay.sessionPaidFor('cs_crm', 'tok123'), false);
  assert.strictEqual(await pay.sessionPaidFor('cs_tracker', 'tok123'), false);
  assert.strictEqual(await pay.sessionPaidFor('cs_unpaid', 'tok123'), false);
  assert.strictEqual(await pay.sessionPaidFor('cs_missing', 'tok123'), false);
  assert.strictEqual(await pay.sessionPaidFor('cs_ok', ''), false);
});
