import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeConfig } from './config.js';
import { normalize, describeSettings, saveSettings, readSaved, applySettings, loadSavedSettings } from './settings.js';
import { createApp } from './app.js';
import { verifySignature, parseWebhook } from './adapters/meta/webhook.js';
import { createReplayPlayer } from './replay/player.js';
import { connectWithUserToken } from './adapters/meta/connect.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Changes on every deploy (Cloud Run sets K_REVISION), so open pages can tell they're out of date.
const BUILD = process.env.K_REVISION || `dev-${Date.now().toString(36)}`;

export function createServer(cfg = loadConfig(), inject = {}) {
  const app = createApp(cfg, inject);
  const { bus, store, claims, lots } = app;
  const replay = createReplayPlayer({ app, root });
  const http = express();
  http.disable('x-powered-by');
  http.set('trust proxy', true);

  // Seller token gate. Buyer-facing routes stay open: pay links (/p, /pay), the test checkout,
  // signed webhooks and the Woo paid ping (which has its own secret).
  const PUBLIC_API = [/^\/api\/woo\/paid$/, /^\/api\/mock\/(order|pay)\//];
  // Constant-time compare of two secrets of any length (hashing first makes the lengths equal).
  const sameSecret = (got, want) => {
    if (!got || !want) return false;
    const a = crypto.createHash('sha256').update(String(got)).digest();
    const b = crypto.createHash('sha256').update(String(want)).digest();
    return crypto.timingSafeEqual(a, b);
  };
  // The judge pass (made in Settings) opens the same live setup but can't touch Settings or clear the
  // seller's items, so judges can try everything without being able to break it for the next judge.
  const JUDGE_BLOCKED = [/^\/api\/settings/, /^\/api\/show\/reset$/];
  http.use((req, res, next) => {
    req.role = 'seller';
    if (!cfg.adminToken || !req.path.startsWith('/api/') || PUBLIC_API.some((r) => r.test(req.path))) return next();
    const got = req.get('x-livelot-token') || req.query.token;
    if (sameSecret(got, cfg.adminToken)) return next();
    if (cfg.judgeToken && sameSecret(got, cfg.judgeToken)) {
      req.role = 'judge';
      if (JUDGE_BLOCKED.some((r) => r.test(req.path))) return res.status(403).json({ ok: false, error: 'The judge pass opens everything except Settings and Clear everything.', judge: true });
      return next();
    }
    res.status(401).json({ ok: false, error: 'Seller token required', auth: true });
  });

  const ok = (res, data = {}) => res.json({ ok: true, ...data });
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) ok(res, out || {});
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 400).json({ ok: false, error: err.message });
    }
  };

  // Raw bodies first (webhooks need the exact bytes for HMAC, frames/audio are binary).
  http.post('/webhooks/meta', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    // Fail closed: without the App secret we can't tell Meta from anyone else, so nothing gets in.
    if (!verifySignature(raw, req.get('x-hub-signature-256'), cfg.meta.appSecret)) {
      app.log('warn', cfg.meta.appSecret ? 'Meta webhook: bad signature' : 'Meta webhook ignored: add the App secret in Settings');
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
    const { comments, messages } = parseWebhook(payload);
    for (const c of comments) claims.handleComment(c);
    for (const m of messages) claims.onBuyerMessage(m);
  });
  http.post('/webhooks/woo', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    // Optional path (the mu-plugin ping and the order poll already catch payments). Fail closed:
    // with no WOO_WEBHOOK_SECRET it's off, since an unsigned "order 12 is paid" could come from anyone.
    if (!cfg.woo.webhookSecret) return res.sendStatus(404);
    const want = crypto.createHmac('sha256', cfg.woo.webhookSecret).update(raw).digest('base64');
    if (!sameSecret(req.get('x-wc-webhook-signature'), want)) return res.sendStatus(401);
    res.sendStatus(200);
    try {
      const o = JSON.parse(raw.toString('utf8'));
      // Same statuses as the poller: offline methods (the store's "Test payment") leave a paid order on-hold.
      if (['processing', 'completed', 'on-hold'].includes(o.status)) claims.markOrderPaid(String(o.id), { source: 'woo webhook' });
    } catch { /* Woo sends a non-JSON ping when the webhook is created */ }
  });
  http.post('/api/frame', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '4mb' }), (req, res) => {
    if (!req.body?.length) return res.status(400).end();
    lots.onFrame(req.body);
    res.status(204).end();
  });
  http.post('/api/lot/photo', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '8mb' }), wrap(async (req) => {
    if (!req.body?.length) throw new Error('no photo');
    return { lot: lots.nextLot({ frame: req.body }) };
  }));
  http.post('/api/audio', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '12mb' }), wrap(async (req) => {
    if (!req.body?.length) throw new Error('no audio');
    const text = await lots.onAudio(req.body, { test: req.query.test === '1' });
    return { text };
  }));

  http.use(express.json({ limit: '1mb' }));
  http.use(express.urlencoded({ extended: false }));

  // ---- Meta webhook verification
  http.get('/webhooks/meta', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.meta.verifyToken) return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
  });

  // ---- state + live feed
  http.get('/health', (req, res) => ok(res, { show: store.s.show?.status || 'none', ...describeConfig(cfg) }));
  http.get('/api/state', (req, res) => res.json({ ...app.snapshot(), config: describeConfig(cfg), replay: replay.status(), build: BUILD, role: req.role }));
  http.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', { ...app.snapshot(), config: describeConfig(cfg), replay: replay.status(), build: BUILD, role: req.role });
    const off = bus.on((evt) => send(evt.type, evt.data));
    let statsDue = false;
    const offStats = bus.on((evt) => { if (evt.type.startsWith('claim') || evt.type.startsWith('order') || evt.type.startsWith('lot')) statsDue = true; });
    const statsTimer = setInterval(() => { if (statsDue) { statsDue = false; send('stats', app.stats()); } }, 400);
    const hb = setInterval(() => { res.write(`: hb\n\n`); send('clock', { now: app.clock.now() }); }, 5000);
    req.on('close', () => { off(); offStats(); clearInterval(hb); clearInterval(statsTimer); });
  });

  // ---- show
  http.post('/api/show/start', wrap(async (req) => {
    const b = req.body || {};
    const id = (v) => (v ? String(v).trim() : null);
    return { show: await app.startShow({ platforms: b.platforms || ['facebook', 'instagram'], fbLiveVideoId: id(b.fbLiveVideoId), mode: b.mode, fbPostId: id(b.fbPostId), igMediaId: id(b.igMediaId), useLatestPosts: b.useLatestPosts === true }) };
  }));
  http.post('/api/show/end', wrap(async () => ({ show: app.endShow() })));
  http.post('/api/show/reset', wrap(async () => {
    replay.stop();
    app.endShow();
    store.reset();
    bus.emit('reset', {});
    return {};
  }));
  http.get('/api/check', wrap(async () => app.check ? app.check() : {}));

  // ---- settings (seller token required, like every /api route)
  http.get('/api/settings', wrap(async () => {
    if (cfg.meta.pageId && cfg.meta.pageToken && !cfg.meta.pageName) {
      // Connected before names were remembered: ask Facebook once and keep it.
      try {
        const g = `https://graph.facebook.com/${cfg.meta.graphVersion}`;
        const p = await fetch(`${g}/${cfg.meta.pageId}?fields=name&access_token=${encodeURIComponent(cfg.meta.pageToken)}`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
        if (p?.name) {
          const values = { 'meta.pageName': p.name };
          if (cfg.meta.igUserId && !cfg.meta.igUsername) {
            const ig = await fetch(`${g}/${cfg.meta.igUserId}?fields=username&access_token=${encodeURIComponent(cfg.meta.pageToken)}`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
            if (ig?.username) values['meta.igUsername'] = ig.username;
          }
          applySettings(cfg, values);
          await saveSettings(cfg, values).catch(() => {});
        }
      } catch { /* show "Connected" without a name */ }
    }
    return { settings: describeSettings(cfg, await readSaved(cfg)), selling: store.s.show?.status === 'live' };
  }));
  // Forget the Page (the app ID and secret stay, so reconnecting is one token away).
  http.post('/api/settings/meta/disconnect', wrap(async () => {
    const { pageId, pageToken, graphVersion } = cfg.meta;
    const values = { 'meta.pageId': '', 'meta.pageToken': '', 'meta.pageName': '', 'meta.igUserId': '', 'meta.igUsername': '' };
    app.reconfigure(values); // refuses while selling
    if (pageId && pageToken) {
      // Stop Facebook sending this Page's webhooks to us (best effort).
      await fetch(`https://graph.facebook.com/${graphVersion}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`, { method: 'DELETE', signal: AbortSignal.timeout(4000) }).catch(() => {});
    }
    let warning = '';
    try { await saveSettings(cfg, values); } catch (err) { warning = `Disconnected now, but couldn’t be stored for next time: ${err.message}`; }
    return { settings: describeSettings(cfg, await readSaved(cfg)), warning };
  }));
  http.post('/api/settings', wrap(async (req) => {
    const values = normalize(req.body?.values);
    app.reconfigure(values);
    let warning = '';
    try { await saveSettings(cfg, values); } catch (err) { warning = `Working now, but couldn’t be stored for next time: ${err.message}`; }
    return { settings: describeSettings(cfg, await readSaved(cfg)), warning };
  }));
  http.post('/api/settings/test', wrap(async (req) => ({ result: await app.checkSection(String(req.body?.section || '')) })));
  // Judge pass on/off. A new pass replaces the old one at once (anyone still using the old one is signed out).
  http.post('/api/settings/judge', wrap(async (req) => {
    const values = { judgeToken: req.body?.on === false ? '' : `judge-${crypto.randomBytes(18).toString('base64url')}` };
    applySettings(cfg, values);
    let warning = '';
    try { await saveSettings(cfg, values); } catch (err) { warning = `Working now, but couldn’t be stored for next time: ${err.message}`; }
    return { settings: describeSettings(cfg, await readSaved(cfg)), warning };
  }));
  // Can this Page go live through the API (Facebook hides the Go live button on Pages under 100
  // followers)? Creates an unpublished test broadcast that nobody sees, then deletes it.
  http.post('/api/settings/meta/live-test', wrap(async () => {
    const { pageId, pageToken, graphVersion, appId, appSecret } = cfg.meta;
    if (!pageId || !pageToken) throw Object.assign(new Error('Connect your Page first'), { status: 400 });
    const g = `https://graph.facebook.com/${graphVersion}`;
    // Which permissions the saved Page token really carries (debug_token with the app's own token).
    let scopes = null;
    if (appId && appSecret) {
      const d = await fetch(`${g}/debug_token?input_token=${encodeURIComponent(pageToken)}&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`).then((r) => r.json()).catch(() => null);
      scopes = d?.data?.scopes || null;
    }
    const res = await fetch(`${g}/${pageId}/live_videos`, { method: 'POST', body: new URLSearchParams({ status: 'UNPUBLISHED', title: 'LiveLot test (not shown to anyone)', access_token: pageToken }) });
    const j = await res.json().catch(() => ({}));
    const e = j.error;
    app.trace({ model: 'graph-api', purpose: 'live test: create unpublished live video', ms: 0, ok: !e, summary: e ? `#${e.code}/${e.error_subcode || '-'} ${e.message} ${e.error_user_msg || ''}` : `live video ${j.id}` });
    if (e) {
      const why = [e.error_user_title, e.error_user_msg].filter(Boolean).join(': ');
      const missing = scopes ? ['publish_video', 'pages_manage_posts', 'pages_read_engagement'].filter((p) => !scopes.includes(p)) : [];
      return { result: { ok: false, detail: `No. Facebook said: ${why || e.message} (#${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})${missing.length ? `. The token is missing: ${missing.join(', ')}` : ''}`, scopes } };
    }
    await fetch(`${g}/${j.id}?access_token=${encodeURIComponent(pageToken)}`, { method: 'DELETE' }).catch(() => {});
    return { result: { ok: true, detail: 'Yes. Facebook let LiveLot create a live video on this Page, so you can stream to it from OBS even without the Go live button. (The test broadcast was deleted.)', scopes } };
  }));
  // One token from Graph API Explorer -> Page ID, a Page token that doesn't expire, and Instagram.
  http.post('/api/settings/meta/connect', wrap(async (req) => {
    const b = req.body || {};
    const appId = String(b.appId || cfg.meta.appId || '').trim();
    const appSecret = String(b.appSecret || cfg.meta.appSecret || '').trim();
    const userToken = String(b.userToken || '').trim();
    if (!appId || !appSecret) throw Object.assign(new Error('Fill in the App ID and App secret first'), { status: 400 });
    if (!userToken) throw Object.assign(new Error('Paste the token from Graph API Explorer'), { status: 400 });
    const r = await connectWithUserToken({ appId, appSecret, userToken, pageId: b.pageId || null, version: cfg.meta.graphVersion });
    if (r.choose) return { choose: r.choose, missing: r.missing };
    const values = { 'meta.appId': appId, 'meta.appSecret': appSecret, 'meta.pageId': r.page.id, 'meta.pageToken': r.pageToken, 'meta.pageName': r.page.name || '', 'meta.igUserId': r.instagram?.id || '', 'meta.igUsername': r.instagram?.username || '' };
    app.reconfigure(values);
    let warning = '';
    try { await saveSettings(cfg, values); } catch (err) { warning = `Working now, but couldn’t be stored for next time: ${err.message}`; }
    return { connected: { page: r.page.name, instagram: r.instagram?.username || null, canGoLive: r.canGoLive }, missing: r.missing, igMissing: r.igMissing, warning, settings: describeSettings(cfg, await readSaved(cfg)) };
  }));

  // ---- studio inputs
  http.post('/api/speech', wrap(async (req) => { lots.onSpeech({ text: req.body.text, final: req.body.final !== false, source: req.body.source || 'webspeech' }); }));
  http.post('/api/next-lot', wrap(async (req) => ({ lot: lots.nextLot({ hint: req.body?.hint || null, listing: req.body?.listing || null, image: req.body?.image || null }) })));

  // ---- lots
  http.post('/api/lot/:id/draft', wrap(async (req) => ({ lot: await lots.relist(req.params.id) })));
  http.post('/api/lot/:id/publish', wrap(async (req) => ({ lot: lots.publish(req.params.id) })));
  http.post('/api/lot/:id/override', wrap(async (req) => ({ lot: lots.override(req.params.id, req.body || {}) })));
  http.post('/api/lot/:id/cancel', wrap(async (req) => ({ lot: lots.cancelLot(req.params.id) })));
  http.post('/api/lot/:id/look', wrap(async (req) => ({ lot: lots.lookAgain(req.params.id) })));
  http.post('/api/lot/:id/research', wrap(async (req) => ({ lot: lots.researchAgain(req.params.id) })));

  // ---- claims / orders
  http.post('/api/claim/:id/approve', wrap(async (req) => ({ claim: claims.approve(req.params.id, req.body || {}) })));
  http.post('/api/claim/:id/reject', wrap(async (req) => ({ claim: claims.reject(req.params.id) })));
  http.post('/api/claim/:id/undo', wrap(async (req) => ({ claim: await claims.undo(req.params.id) })));
  http.post('/api/claim/:id/retry', wrap(async (req) => { await claims.retry(req.params.id); }));
  http.post('/api/order/:id/paid', wrap(async (req) => {
    const o = claims.markOrderPaid(req.params.id, { source: 'seller' });
    if (!o) throw new Error('no such order');
    app.commerce.markPaid?.(o.wooOrderId);
    return { order: o };
  }));

  // ---- comments (demo injection / replay)
  let injected = 0;
  http.post('/api/comment', wrap(async (req) => {
    const b = req.body || {};
    if (!b.text) throw new Error('text required');
    const platform = b.platform === 'instagram' ? 'instagram' : 'facebook';
    const name = b.name || 'Viewer';
    const claim = await claims.handleComment({
      id: b.id || `sim_${Date.now()}_${++injected}`,
      platform,
      from: { id: b.userId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: platform === 'instagram' && !name.startsWith('@') ? `@${name}` : name },
      text: b.text,
      at: app.clock.now(),
      viewerLagSec: b.viewerLagSec ?? 0,
      simulated: true,
    });
    return { claim };
  }));

  // ---- payments
  http.post('/api/woo/paid', wrap(async (req) => {
    // On a public server (seller token set) the example secret "change-me" is refused, so a copy of
    // this repo deployed without its own secret can't have orders marked paid by strangers.
    const want = cfg.woo.pingSecret;
    const usable = want && !(cfg.adminToken && want === 'change-me');
    if (!usable || !sameSecret(req.get('x-livelot-secret') || req.body?.secret, want)) {
      if (!usable) app.log('warn', 'Paid ping refused: set your own payment notice secret (LIVELOT_PING_SECRET) in Settings → Shop');
      const e = new Error('bad secret'); e.status = 401; throw e;
    }
    const o = claims.markOrderPaid(String(req.body.order_id), { source: 'woo ping' });
    return { matched: Boolean(o) };
  }));
  // Pay links go through LiveLot so the seller sees "link opened", then on to Woo's order-pay page.
  http.get('/p/:orderId', (req, res) => {
    const o = store.s.orders.get(req.params.orderId);
    if (!o) return res.status(404).send('Order not found');
    if (!o.openedAt) {
      o.openedAt = app.clock.now();
      bus.emit('order.updated', o);
      app.log('info', `${store.s.buyers.get(o.buyerId)?.displayName} opened their pay link`);
    }
    res.redirect(302, o.paymentUrl);
  });
  // Mock checkout (COMMERCE=mock)
  http.get('/api/mock/order/:wooId', (req, res) => {
    const v = app.commerce.view?.(req.params.wooId);
    if (!v) return res.status(404).json({ ok: false });
    res.json({ ok: true, order: v, shopName: cfg.shopName });
  });
  http.post('/api/mock/pay/:wooId', wrap(async (req) => {
    const o = app.commerce.markPaid?.(req.params.wooId);
    if (!o) throw new Error('no such order');
    claims.markOrderPaid(String(req.params.wooId), { source: 'checkout' });
  }));
  http.get('/pay/:wooId', (req, res) => res.sendFile(path.join(root, 'public/pay/index.html')));

  // ---- dev / demo tools
  http.post('/api/dev/advance', wrap(async (req) => {
    if (!cfg.devTools) throw new Error('dev tools disabled');
    const sec = Number(req.body?.sec || cfg.claimTtlSec);
    app.clock.advance(sec * 1000);
    app.log('info', `⏩ fast-forward ${Math.round(sec / 60)} min`);
    const n = await claims.expireDue();
    bus.emit('clock', { now: app.clock.now() });
    return { expired: n };
  }));
  http.post('/api/replay/start', wrap(async (req) => replay.start({ fixture: req.body?.fixture || 'demo-show', speed: Number(req.body?.speed || 1) })));
  http.post('/api/replay/stop', wrap(async () => replay.stop()));
  http.get('/api/recap', wrap(async () => app.recap()));

  // ---- static
  http.use('/media', express.static(path.join(cfg.dataDir, 'media'), { maxAge: '1h' }));
  http.use('/fixtures', express.static(path.join(root, 'fixtures'), { maxAge: '1h' }));
  // Pages, scripts and icons change with every deploy. Cloudflare forces a 4-hour browser cache on
  // .js/.css/.webp unless the origin says no-store, so scripts and styles are no-store (small, fetched
  // once per page load) and pages revalidate. A missing icon is never cached, so it appears once added.
  const fresh = { extensions: ['html'], setHeaders: (res, file) => res.setHeader('Cache-Control', /\.(js|css)$/.test(file) ? 'no-store' : 'no-cache') };
  http.use('/art', express.static(path.join(root, 'public', 'art'), fresh), (req, res) => res.set('Cache-Control', 'no-store').status(404).end());
  http.use(express.static(path.join(root, 'public'), fresh));
  http.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
  http.get('/', (req, res) => res.redirect('/dashboard/'));

  return { http, app, replay };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const saved = loadSavedSettings(cfg);
  if (Object.keys(saved).length) applySettings(cfg, saved);
  const { http, app } = createServer(cfg);
  if (Object.keys(saved).length) app.log('info', `Loaded ${Object.keys(saved).length} settings saved from the Settings screen`);
  if (store_load(app)) app.log('info', 'Restored previous state from data/state.json');
  app.startTimers();
  http.listen(cfg.port, () => {
    const d = describeConfig(cfg);
    console.log(`\n  LiveLot on http://localhost:${cfg.port}`);
    console.log(`  dashboard  /dashboard   studio  /capture   overlay  /overlay`);
    console.log(`  platform=${d.platform} commerce=${d.commerce} ai=${d.ai} sparkOpen=${d.sparkOpen} public=${d.publicBaseUrl}\n`);
  });
  const shutdown = () => { app.store.flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function store_load(app) {
  const loaded = app.store.load();
  // Pending orders from a previous process stay, but the comment stream must be restarted.
  if (loaded && app.store.s.show?.status === 'live') {
    app.platform.start(app.store.s.show, (c) => app.claims.handleComment(c), {}).catch(() => {});
  }
  return loaded;
}
