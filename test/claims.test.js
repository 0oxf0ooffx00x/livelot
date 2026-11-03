import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

const replies = (platform, kind) => platform.outbox.filter((m) => !kind || m.kind === kind);

test('last unit: first "sold" wins, second is waitlisted, no double-sell', async () => {
  const { app, platform, say, lot } = await makeApp();
  const l = lot({ title: 'Denim jacket', price: 15 });
  const a = await say('Alice', 'sold!');
  const b = await say('Bob', 'mine');
  assert.equal(a.state, 'invoiced');
  assert.equal(b.state, 'waitlisted');
  assert.equal(b.waitlistPosition, 1);
  assert.equal(l.stock.default, 0);
  assert.equal(l.status, 'sold_out');
  const priv = replies(platform, 'private');
  assert.equal(priv.length, 1);
  assert.equal(priv[0].commentId, a.commentId);
  assert.match(priv[0].url, /\/p\/ord_/);
  assert.match(priv[0].text, /It's yours, Alice/);
  const pub = replies(platform, 'public');
  assert.equal(pub.length, 1);
  assert.match(pub[0].text, /#1 on the waitlist/);
  assert.ok(app.store.s.orders.get(a.orderId).paymentUrl);
});

test('unpaid hold expires and the waitlisted buyer is promoted and gets the link', async () => {
  const { app, platform, say, lot, tick, commerce } = await makeApp({ claimTtlSec: 900 });
  const l = lot({ title: 'Mug', price: 8 });
  const a = await say('Alice', 'sold');
  const b = await say('Bob', 'sold');
  tick(901_000);
  await app.claims.expireDue();
  await app.claims.idle();
  assert.equal(a.state, 'expired');
  assert.equal(b.state, 'invoiced');
  assert.ok(b.promoted);
  assert.equal(l.stock.default, 0);
  const toBob = replies(platform, 'private').find((m) => m.commentId === b.commentId);
  assert.match(toBob.text, /Good news Bob/);
  // Alice's Woo order lost its only line and was cancelled
  const aOrder = app.store.s.orders.get(a.orderId);
  assert.equal(aOrder.status, 'cancelled');
  assert.equal(commerce.orders.get(aOrder.wooOrderId).status, 'cancelled');
});

test('two lots from one buyer bundle into one order', async () => {
  const { app, platform, say, lot } = await makeApp();
  lot({ title: 'Jacket', price: 15 });
  const a1 = await say('Alice', 'sold');
  lot({ title: 'Scarf', price: 5 });
  const a2 = await say('Alice', 'mine please');
  assert.equal(a1.orderId, a2.orderId);
  const order = app.store.s.orders.get(a1.orderId);
  assert.equal(order.claimIds.length, 2);
  assert.equal(order.total, 20);
  const second = replies(platform, 'private').find((m) => m.commentId === a2.commentId);
  assert.match(second.text, /Added Lot 2/);
  assert.match(second.buttonTitle, /£20/);
});

test('sizes: explicit size picks the variant; missing size asks, then a later size comment supersedes', async () => {
  const { platform, say, lot } = await makeApp();
  const l = lot({ title: 'Trainers', price: 25, variants: [{ label: '9', qty: 1 }, { label: '10', qty: 1 }] });
  const a = await say('Alice', 'size 10 please');
  assert.equal(a.state, 'invoiced');
  assert.equal(a.variant, '10');
  const b = await say('Bob', 'sold');
  assert.equal(b.state, 'needs_review');
  assert.match(replies(platform, 'public').at(-1).text, /which size/);
  const b2 = await say('Bob', 'sold 9');
  assert.equal(b2.state, 'invoiced');
  assert.equal(b2.variant, '9');
  assert.equal(b.state, 'cancelled');
  assert.deepEqual(l.stock, { 9: 0, 10: 0 });
});

test('explicit "lot N" beats the lot on screen', async () => {
  const { say, lot } = await makeApp();
  const l1 = lot({ title: 'Jacket', price: 15 });
  lot({ title: 'Mug', price: 8 });
  const a = await say('Alice', 'sold lot 1');
  assert.equal(a.itemId, l1.id);
});

test('stream lag: a comment just after a lot change goes to the lot the viewer was watching', async () => {
  const { say, lot, tick } = await makeApp({ lagSec: 8 });
  const l1 = lot({ title: 'Jacket', price: 15 });
  tick(30_000);
  const l2 = lot({ title: 'Mug', price: 8 });
  tick(4_000);
  const a = await say('Alice', 'sold');
  assert.equal(a.itemId, l1.id);
  tick(10_000);
  const b = await say('Bob', 'sold');
  assert.equal(b.itemId, l2.id);
});

test('comment right on a lot boundary goes to review', async () => {
  const { say, lot, tick } = await makeApp({ lagSec: 8 });
  lot({ title: 'Jacket', price: 15 });
  tick(30_000);
  lot({ title: 'Mug', price: 8 });
  tick(8_500);
  const a = await say('Alice', 'sold');
  assert.equal(a.state, 'needs_review');
});

test('duplicate claim from the same buyer is cancelled', async () => {
  const { say, lot } = await makeApp();
  const l = lot({ title: 'Mugs', price: 8, quantity: 3 });
  await say('Alice', 'sold');
  const dup = await say('Alice', 'SOLD!!');
  assert.equal(dup.state, 'cancelled');
  assert.equal(l.stock.default, 2);
});

test('questions and chatter do not create claims', async () => {
  const { app, say, lot } = await makeApp();
  const l = lot({ title: 'Jacket', price: 15 });
  for (const t of ['is it sold?', 'how much?', 'love this 😍', 'sold out?']) assert.equal(await say('Carol', t), null);
  assert.equal(l.stock.default, 1);
  assert.equal(app.store.claims().length, 0);
});

test('claims that arrive before the lot is approved queue in order', async () => {
  const { app, say, lot } = await makeApp();
  const l = lot({ title: 'Jacket', price: 15 }, { publish: false });
  const a = await say('Alice', 'sold');
  const b = await say('Bob', 'sold');
  assert.equal(a.state, 'matched');
  assert.equal(b.state, 'matched');
  app.lots.publish(l.id);
  await app.claims.idle();
  assert.equal(a.state, 'invoiced');
  assert.equal(b.state, 'waitlisted');
});

test('paid order marks claims paid and tells the waitlist it sold out', async () => {
  const { app, platform, say, lot } = await makeApp();
  lot({ title: 'Jacket', price: 15 });
  const a = await say('Alice', 'sold');
  const b = await say('Bob', 'sold');
  app.claims.markOrderPaid(a.orderId, { source: 'test' });
  await app.claims.idle();
  assert.equal(a.state, 'paid');
  assert.equal(b.state, 'cancelled');
  const toBob = replies(platform, 'private').find((m) => m.commentId === b.commentId);
  assert.match(toBob.text, /sold out/);
  assert.equal(app.stats().revenue, 15);
});

test('seller undo releases stock to the waitlist', async () => {
  const { app, say, lot } = await makeApp();
  const l = lot({ title: 'Jacket', price: 15 });
  const a = await say('Alice', 'sold');
  const b = await say('Bob', 'sold');
  await app.claims.undo(a.id);
  await app.claims.idle();
  assert.equal(a.state, 'cancelled');
  assert.equal(b.state, 'invoiced');
  assert.equal(l.stock.default, 0);
});

test('fairness: a slow model answer for the first comment still wins', async () => {
  const classify = async (text) => {
    await new Promise((r) => setTimeout(r, text.includes('slow') ? 60 : 1));
    return { isClaim: true, confidence: 0.95, lotNumber: null, size: null, qty: 1, description: null, source: 'test' };
  };
  const { app, say, lot } = await makeApp({}, { classify });
  lot({ title: 'Jacket', price: 15 });
  const p1 = app.claims.handleComment({ id: 'x1', platform: 'facebook', from: { id: 'a', name: 'Alice' }, text: 'sold (slow)', at: 1 });
  const p2 = app.claims.handleComment({ id: 'x2', platform: 'facebook', from: { id: 'b', name: 'Bob' }, text: 'sold', at: 2 });
  const [a, b] = await Promise.all([p1, p2]);
  await app.claims.idle();
  void say;
  assert.equal(a.state, 'invoiced');
  assert.equal(b.state, 'waitlisted');
});

test('multi-quantity lot sells to several buyers, then waitlists', async () => {
  const { say, lot } = await makeApp();
  const l = lot({ title: 'Mugs', price: 8, quantity: 3 });
  const states = [];
  for (const who of ['A', 'B', 'C', 'D']) states.push((await say(who, 'sold')).state);
  assert.deepEqual(states, ['invoiced', 'invoiced', 'invoiced', 'waitlisted']);
  assert.equal(l.status, 'sold_out');
});

test('instagram waitlist is closed with a private reply when the show ends', async () => {
  const { app, platform, say, lot } = await makeApp();
  lot({ title: 'Jacket', price: 15 });
  await say('Alice', 'sold', { platform: 'instagram' });
  const b = await say('bob_ig', 'sold', { platform: 'instagram' });
  app.endShow();
  await app.claims.idle();
  assert.equal(b.state, 'cancelled');
  assert.ok(replies(platform, 'private').some((m) => m.commentId === b.commentId && /sold out/.test(m.text)));
});

test('post mode: publishing posts the lot, and comments on its post claim that lot', async () => {
  const { app, platform, clock } = await makeApp({ publicBaseUrl: 'https://livelot.stream' });
  app.endShow();
  await app.startShow({ platforms: ['facebook', 'instagram'], mode: 'post' });
  const l1 = app.lots.nextLot({ listing: { title: 'Jacket', price: 15 }, image: '/media/jacket.jpg' });
  app.lots.publish(l1.id);
  clock.advance(60_000);
  const l2 = app.lots.nextLot({ listing: { title: 'Mug', price: 8 }, image: '/media/mug.jpg' });
  app.lots.publish(l2.id);
  await new Promise((r) => setTimeout(r, 20));
  const posts = platform.outbox.filter((m) => m.kind === 'post');
  assert.equal(posts.length, 2);
  assert.match(posts[0].caption, /Lot 1: Jacket · £15[\s\S]*Comment SOLD to buy/);
  assert.equal(posts[0].imageUrl, 'https://livelot.stream/media/jacket.jpg');
  assert.equal(l1.posts.facebook.id, 'mockfb_1');

  // Polled comment on Lot 1's post, made while Lot 2 is the newest lot
  const a = await app.claims.handleComment({ id: 'p1', platform: 'facebook', from: { id: 'a', name: 'Amy' }, text: 'sold!', at: clock.now(), lotId: l1.id, viewerLagSec: 0 });
  // Webhook comment: only the post id is known
  const b = await app.claims.handleComment({ id: 'p2', platform: 'facebook', from: { id: 'b', name: 'Ben' }, text: 'mine', at: clock.now(), liveId: 'mockfb_2' });
  // Comment on Lot 1's post that names Lot 2 explicitly
  const c = await app.claims.handleComment({ id: 'p3', platform: 'instagram', from: { id: 'c', name: '@cat' }, text: 'sold lot 2', at: clock.now(), lotId: l1.id });
  await app.claims.idle();
  assert.equal(a.itemId, l1.id);
  assert.match(a.match.reason, /Lot 1's post/);
  assert.equal(b.itemId, l2.id);
  assert.equal(c.itemId, l2.id);
  assert.equal(a.state, 'invoiced');
  assert.equal(b.state, 'invoiced');
  assert.equal(c.state, 'waitlisted');
});

test('a demo show never touches the real shop or real Facebook', async () => {
  const { createApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  const { createClock } = await import('../src/core/clock.js');
  const calls = [];
  const realCommerce = new Proxy({ kind: 'woo' }, { get: (t, k) => (k in t ? t[k] : async () => { calls.push(`commerce.${String(k)}`); throw new Error('real shop must not be used'); }) });
  const realPlatform = new Proxy({ kind: 'meta', state: () => ({}), stop() {} }, { get: (t, k) => (k in t ? t[k] : async () => { calls.push(`platform.${String(k)}`); return {}; }) });
  const cfg = loadConfig({ persist: false, dataDir: 'data/test', aiMode: 'mock', lagSec: 0 });
  const app = createApp(cfg, { clock: createClock({ manual: true }), platform: realPlatform, commerce: realCommerce, demoAdapters: true, ai: {} });
  await app.startShow({ demo: true });
  const l = app.lots.nextLot({ listing: { title: 'Jacket', price: 15 } });
  app.lots.publish(l.id);
  const c = await app.claims.handleComment({ id: 'd1', platform: 'facebook', from: { id: 'a', name: 'Amy' }, text: 'sold', at: Date.now() });
  await app.claims.idle();
  assert.equal(c.state, 'invoiced');
  assert.deepEqual(calls, []);
  app.endShow();
  await app.startShow({});
  assert.equal(app.snapshot().commerce, 'woo');
});
