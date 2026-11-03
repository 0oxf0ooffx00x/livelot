import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWooClient } from '../src/adapters/woo/client.js';

function fakeFetch() {
  const calls = [];
  let nextId = 100;
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method, body, auth: opts.headers.Authorization });
    let out = {};
    if (url.includes('/variations/batch')) out = { create: body.create.map(() => ({ id: ++nextId })) };
    else if (url.endsWith('/products')) out = { id: ++nextId, permalink: 'https://shop/p' };
    else if (url.endsWith('/orders')) out = { id: 555, order_key: 'wc_order_k', payment_url: 'https://shop/checkout/order-pay/555/?pay_for_order=true&key=wc_order_k', total: '25.00', line_items: body.line_items.map((l, i) => ({ id: 900 + i, product_id: l.product_id, variation_id: l.variation_id || 0, meta_data: l.meta_data })) };
    else if (/\/orders\/\d+$/.test(url)) out = { id: 555, total: '30.00', line_items: (body.line_items || []).filter((l) => l.quantity !== 0).map((l, i) => ({ id: 950 + i, product_id: l.product_id, variation_id: l.variation_id || 0, meta_data: l.meta_data })) };
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return { calls, fetchImpl };
}

const cfg = { url: 'https://shop.test', key: 'ck', secret: 'cs', queryAuth: false };

test('variable product gets a Size attribute and one variation per size with stock', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const woo = createWooClient(cfg, { fetchImpl });
  const lot = { id: 'lot_1', showId: 'show_abcdef', lotNumber: 2, title: 'Trainers', description: 'd', price: 25,
    variants: [{ key: '9', label: '9' }, { key: '10', label: '10' }], initialStock: { 9: 1, 10: 2 } };
  const r = await woo.createProduct(lot);
  assert.equal(calls[0].body.type, 'variable');
  assert.deepEqual(calls[0].body.attributes[0].options, ['9', '10']);
  assert.equal(calls[1].body.create[1].stock_quantity, 2);
  assert.equal(calls[1].body.create[0].regular_price, '25.00');
  assert.deepEqual(Object.keys(r.variationIds), ['9', '10']);
  assert.match(calls[0].auth, /^Basic /);
});

test('pending order returns the pay link and maps lines to claims; removal uses quantity 0', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const woo = createWooClient(cfg, { fetchImpl });
  const r = await woo.createOrder({ buyer: { id: 'facebook:1', displayName: 'Alice Smith', platform: 'facebook' }, showId: 's', lines: [{ claimId: 'clm_a', productId: 7, variationId: 8, qty: 1 }] });
  assert.equal(calls[0].body.status, 'pending');
  assert.equal(calls[0].body.set_paid, false);
  assert.equal(calls[0].body.billing.first_name, 'Alice');
  assert.match(r.paymentUrl, /order-pay\/555/);
  assert.deepEqual(r.lineIds, { clm_a: 900 });
  await woo.removeLines({ wooOrderId: 555 }, [900]);
  assert.deepEqual(calls.at(-1).body, { line_items: [{ id: 900, quantity: 0 }] });
});

test('query-string auth for hosts that strip Authorization', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const woo = createWooClient({ ...cfg, queryAuth: true }, { fetchImpl });
  await woo.createOrder({ buyer: { id: 'x', displayName: 'A', platform: 'facebook' }, showId: 's', lines: [{ claimId: 'c', productId: 1, qty: 1 }] });
  assert.match(calls[0].url, /consumer_key=ck&consumer_secret=cs/);
  assert.equal(calls[0].auth, undefined);
});

test('a rejected product photo falls back to creating the product without it', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(body);
    if (body?.images?.length) return { ok: false, status: 400, text: async () => JSON.stringify({ code: 'woocommerce_product_image_upload_error', message: 'Sorry, you are not allowed to upload this file type.' }) };
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 42, permalink: 'https://shop/p' }) };
  };
  const woo = createWooClient(cfg, { fetchImpl });
  const lot = { id: 'l', showId: 'show_abcdef', lotNumber: 1, title: 'Mug', price: 8, variants: [{ key: 'default', label: 'One size' }], initialStock: { default: 1 } };
  const r = await woo.createProduct(lot, { imageUrl: 'https://x/a.svg' });
  assert.equal(r.productId, 42);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].images, []);
});
