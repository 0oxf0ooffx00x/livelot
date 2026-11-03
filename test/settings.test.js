import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { normalize, applySettings, loadSavedSettings } from '../src/settings.js';

process.env.QUIET = '1';

test('settings input is checked and converted to config units', () => {
  const v = normalize({ 'woo.url': 'shop.example.com/', claimTtlSec: '20', 'woo.key': '', 'woo.secret': 'cs_123', 'meta.publicWaitlistReply': false, currency: 'eur' });
  assert.equal(v['woo.url'], 'https://shop.example.com');
  assert.equal(v.claimTtlSec, 1200); // minutes on screen, seconds in config
  assert.equal('woo.key' in v, false); // empty secret = keep the saved one
  assert.equal(v['woo.secret'], 'cs_123');
  assert.equal(v['meta.publicWaitlistReply'], false);
  assert.equal(v.currency, 'EUR');
  assert.equal(normalize({ 'woo.key': null })['woo.key'], ''); // explicit remove
  assert.throws(() => normalize({ 'woo.url': 'http://shop.example.com' }), /https/);
  assert.throws(() => normalize({ claimTtlSec: '0' }), /from 1/);
  assert.throws(() => normalize({ adminToken: 'x' }), /Unknown setting/);
});

test('saved shop keys switch the real shop on; removing them switches it off', () => {
  const cfg = loadConfig({ persist: false });
  applySettings(cfg, { 'woo.url': 'https://shop.example.com', 'woo.key': 'ck', 'woo.secret': 'cs' });
  assert.equal(cfg.commerceMode, 'woo');
  applySettings(cfg, { 'woo.key': '' });
  assert.equal(cfg.commerceMode, 'mock');
});

async function boot(dir) {
  process.env.SETTINGS_FILE = path.join(dir, 'settings.json');
  const cfg = loadConfig({ persist: true, dataDir: dir, adminToken: 'tok', platformMode: 'mock', commerceMode: 'mock', aiMode: 'mock' });
  const { http, app } = createServer(cfg);
  const srv = await new Promise((r) => { const s = http.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, body) => (await fetch(`${base}${p}`, { method: body ? 'POST' : 'GET', headers: { 'x-livelot-token': 'tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  return { app, cfg, call, close: () => new Promise((r) => srv.close(r)) };
}

test('settings screen: secrets never come back, changes apply live and are stored for next time', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'livelot-settings-'));
  const { app, call, close } = await boot(dir);
  try {
    const saved = await call('/api/settings', { values: { 'woo.url': 'https://shop.example.com', 'woo.key': 'ck_live_abcd1234', 'woo.secret': 'cs_live_wxyz9876', shopName: 'Rob’s Rail', claimTtlSec: 10 } });
    assert.equal(saved.ok, true);
    assert.equal(app.commerce.kind, 'woo'); // switched without a restart
    assert.equal(app.cfg.claimTtlSec, 600);
    const got = await call('/api/settings');
    const text = JSON.stringify(got);
    assert.equal(text.includes('ck_live_abcd1234'), false);
    assert.equal(text.includes('cs_live_wxyz9876'), false);
    const key = got.settings.fields.find((f) => f.key === 'woo.key');
    assert.deepEqual([key.set, key.hint], [true, '…1234']);
    assert.equal(got.settings.status.shop, true);
    // stored on disk for the next start
    const disk = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(disk['woo.url'], 'https://shop.example.com');
    assert.equal(loadSavedSettings(app.cfg).shopName, 'Rob’s Rail');
    // during a show: rules can change, the shop can't
    await call('/api/show/start', { platforms: ['facebook'], mode: 'post' });
    assert.equal((await call('/api/settings', { values: { lagSec: 5 } })).ok, true);
    const blocked = await call('/api/settings', { values: { 'woo.url': 'https://other.example.com' } });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Stop selling first/);
  } finally {
    await close();
    delete process.env.SETTINGS_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

test('connection test: setup hints come through as written, real errors in plain words', async () => {
  const cfg = loadConfig({ persist: false, platformMode: 'mock', commerceMode: 'mock', aiMode: 'mock' });
  const { createApp } = await import('../src/app.js');
  const app = createApp(cfg, { ai: {} });
  assert.equal((await app.checkSection('meta')).detail, 'Add the Page ID and Page access token first');
  assert.equal((await app.checkSection('shop')).detail, 'Add the store address, consumer key and consumer secret first');
  app.reconfigure({ 'woo.url': 'https://127.0.0.1:9', 'woo.key': 'ck', 'woo.secret': 'cs' });
  const r = await app.checkSection('shop');
  assert.equal(r.ok, false);
  assert.match(r.detail, /Couldn’t reach that address/);
});

test('Connect turns one user token into a Page, a lasting Page token and the linked Instagram', async () => {
  const { connectWithUserToken } = await import('../src/adapters/meta/connect.js');
  const calls = [];
  const pages = [
    { id: '111', name: 'Rob’s Rail', access_token: 'PAGE_TOKEN_111', instagram_business_account: { id: '1784', username: 'robsrail' } },
    { id: '222', name: 'Other Page', access_token: 'PAGE_TOKEN_222' },
  ];
  const fake = (list) => async (u) => {
    calls.push(u.pathname);
    const body = u.pathname.endsWith('/oauth/access_token') ? { access_token: 'LONG_USER' }
      : u.pathname.endsWith('/me/permissions') ? { data: ['pages_show_list', 'pages_messaging', 'publish_video'].map((permission) => ({ permission, status: 'granted' })) }
        : { data: list };
    if (u.pathname.endsWith('/me/accounts')) assert.equal(u.searchParams.get('access_token'), 'LONG_USER'); // long-lived user token -> lasting Page token
    return { ok: true, json: async () => body };
  };
  const two = await connectWithUserToken({ appId: 'a', appSecret: 's', userToken: 'short', fetchImpl: fake(pages) });
  assert.deepEqual(two.choose.map((p) => p.name), ['Rob’s Rail', 'Other Page']);
  const one = await connectWithUserToken({ appId: 'a', appSecret: 's', userToken: 'short', pageId: '111', fetchImpl: fake(pages) });
  assert.equal(one.pageToken, 'PAGE_TOKEN_111');
  assert.deepEqual(one.instagram, { id: '1784', username: 'robsrail' });
  assert.equal(one.canGoLive, true);
  assert.ok(one.missing.includes('pages_manage_posts'));
  const bad = async () => ({ ok: false, json: async () => ({ error: { message: 'Error validating application. Invalid application ID.', code: 101 } }) });
  await assert.rejects(connectWithUserToken({ appId: 'x', appSecret: 'y', userToken: 't', fetchImpl: bad }), /App ID or App secret is wrong/);
});
