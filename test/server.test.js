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

test('no token configured means open (local dev)', async () => {
  const { base, close } = await boot({ adminToken: '' });
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 200);
  } finally {
    await close();
  }
});
