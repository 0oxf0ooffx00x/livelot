import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

process.env.QUIET = '1';

async function boot(overrides) {
  const cfg = loadConfig({ persist: false, dataDir: 'data/test', platformMode: 'mock', commerceMode: 'mock', aiMode: 'mock', ...overrides });
  const { http } = createServer(cfg);
  const srv = await new Promise((r) => { const s = http.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((r) => srv.close(r)) };
}

test('seller token gates seller routes but not buyer routes', async () => {
  const { base, close } = await boot({ adminToken: 'tok-123' });
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { 'x-livelot-token': 'nope' } })).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { 'x-livelot-token': 'tok-123' } })).status, 200);
    assert.equal((await fetch(`${base}/api/state?token=tok-123`)).status, 200);
    // capitalised paths must not dodge the sign-in
    for (const p of ['/API/state', '/Api/settings', '/api/State']) assert.notEqual((await fetch(`${base}${p}`)).status, 200, p);
    assert.notEqual((await fetch(`${base}/API/show/reset`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/api/show/reset`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"sold"}' })).status, 401);
    // buyer-facing and signed routes stay reachable
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/mock/order/1`)).status, 404);
    assert.equal((await fetch(`${base}/api/woo/paid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"order_id":1,"secret":"wrong"}' })).status, 401);
    assert.equal((await fetch(`${base}/p/nope`)).status, 404);
    assert.equal((await fetch(`${base}/dashboard/`)).status, 200);
  } finally {
    await close();
  }
});

test('webhooks and the paid ping fail closed without their secrets', async () => {
  const { base, close } = await boot({ adminToken: 'tok-123' });
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    // no App secret: unsigned Meta webhooks are refused
    assert.equal((await post('/webhooks/meta', { object: 'page', entry: [] })).status, 401);
    // no Woo webhook secret: the route is off
    assert.equal((await post('/webhooks/woo', { id: 1, status: 'processing' })).status, 404);
    // the example ping secret is refused on a public server, even when sent correctly
    assert.equal((await post('/api/woo/paid', { order_id: 1, secret: 'change-me' })).status, 401);
  } finally {
    await close();
  }
  const signed = await boot({ adminToken: 'tok-123', woo: { ...loadConfig().woo, pingSecret: 'a-long-real-secret', webhookSecret: 'whsec' } });
  try {
    assert.equal((await fetch(`${signed.base}/api/woo/paid`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-livelot-secret': 'a-long-real-secret' }, body: '{"order_id":1}' })).status, 200);
    assert.equal((await fetch(`${signed.base}/webhooks/woo`, { method: 'POST', headers: { 'x-wc-webhook-signature': 'forged' }, body: '{"id":1,"status":"processing"}' })).status, 401);
  } finally {
    await signed.close();
  }
});

test('judge pass: same dashboard, no Settings, no Clear everything; a new pass replaces the old', async () => {
  const { base, close } = await boot({ adminToken: 'tok-123', judgeToken: 'judge-abc' });
  const as = (t) => ({ 'x-livelot-token': t, 'content-type': 'application/json' });
  try {
    const st = await fetch(`${base}/api/state`, { headers: as('judge-abc') });
    assert.equal(st.status, 200);
    assert.equal((await st.json()).role, 'judge');
    assert.equal((await (await fetch(`${base}/api/state`, { headers: as('tok-123') })).json()).role, 'seller');
    assert.equal((await fetch(`${base}/api/settings`, { headers: as('judge-abc') })).status, 403);
    assert.equal((await fetch(`${base}/api/settings/judge`, { method: 'POST', headers: as('judge-abc'), body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/show/reset`, { method: 'POST', headers: as('judge-abc') })).status, 403);
    assert.equal((await fetch(`${base}/api/comment`, { method: 'POST', headers: as('judge-abc'), body: '{"text":"sold"}' })).status, 200);
    // other spellings of the blocked paths don't get a judge through either
    for (const p of ['/api/Settings', '/API/settings/judge', '/api/settings/', '/api/show/reset/', '/api/SHOW/reset']) {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers: as('judge-abc'), body: '{"on":true}' });
      assert.ok(r.status === 403 || r.status === 404, `${p} gave ${r.status}`);
    }
    // a comment ID sent from the browser is ignored: pretend buyers always get our own sim_ ID
    assert.equal((await fetch(`${base}/api/show/start`, { method: 'POST', headers: as('judge-abc'), body: '{"mode":"post"}' })).status, 200);
    await fetch(`${base}/api/comment`, { method: 'POST', headers: as('judge-abc'), body: '{"text":"mine"}' });
    await fetch(`${base}/api/comment`, { method: 'POST', headers: as('judge-abc'), body: '{"text":"sold","id":"1383851404815782_999","userId":"24680","name":"Real Buyer"}' });
    const seen = (await (await fetch(`${base}/api/state`, { headers: as('tok-123') })).json()).comments;
    assert.ok(seen.length >= 2 && seen.every((c) => c.id.startsWith('sim_')), `comment ids: ${seen.map((c) => c.id)}`);
    // ...and so is a buyer ID: pretend buyers can't be merged into a real buyer
    const buyerIds = seen.map((c) => c.from?.id ?? c.buyerId ?? c.userId).filter(Boolean);
    assert.ok(buyerIds.length >= 2 && buyerIds.every((id) => String(id).startsWith('sim-')), `buyer ids: ${buyerIds}`);
    // a live feed opened with the judge pass...
    const ctl = new AbortController();
    const reader = (await fetch(`${base}/api/events?token=judge-abc`, { signal: ctl.signal })).body.getReader();
    await reader.read();
    // the seller makes a new pass: the old one stops working, the new one works
    const made = await (await fetch(`${base}/api/settings/judge`, { method: 'POST', headers: as('tok-123'), body: '{"on":true}' })).json();
    // ...is closed straight away
    const ended = await Promise.race([(async () => { for (;;) if ((await reader.read()).done) return true; })(), new Promise((r) => setTimeout(() => r(false), 2000))]);
    ctl.abort();
    assert.equal(ended, true, 'the old pass’s live feed should close');
    assert.equal(made.settings.judge.on, true);
    assert.ok(!made.settings.judge.link.includes('?token='), 'pass must not be in the query string');
    const fresh = new URLSearchParams(new URL(made.settings.judge.link).hash.slice(1)).get('token');
    assert.match(fresh, /^judge-/);
    assert.equal((await fetch(`${base}/api/state`, { headers: as('judge-abc') })).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: as(fresh) })).status, 200);
    // and can turn it off
    await fetch(`${base}/api/settings/judge`, { method: 'POST', headers: as('tok-123'), body: '{"on":false}' });
    assert.equal((await fetch(`${base}/api/state`, { headers: as(fresh) })).status, 401);
  } finally {
    await close();
  }
});

test('no token configured means open (local dev)', async () => {
  const { base, close } = await boot({ adminToken: '' });
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 200);
  } finally {
    await close();
  }
});
