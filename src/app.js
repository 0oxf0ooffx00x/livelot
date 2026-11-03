import { createBus } from './core/bus.js';
import { createClock } from './core/clock.js';
import { createStore } from './core/store.js';
import { newShow } from './domain/models.js';
import { createClaimsEngine } from './pipeline/claims.js';
import { createLotsEngine } from './pipeline/lots.js';
import { createClassifier } from './agents/classifier.js';
import { createMatcher } from './agents/matcher.js';
import { createModelClient } from './ai/metaClient.js';
import { createSpark } from './ai/spark.js';
import { createSparkOpen } from './ai/sparkOpen.js';
import { createSam } from './ai/sam.js';
import { createAsr } from './ai/asr.js';
import { createImageEditor } from './ai/image.js';
import { createMockPlatform } from './adapters/mock/platform.js';
import { createMockCommerce } from './adapters/mock/commerce.js';
import { createMetaPlatform } from './adapters/meta/index.js';
import { createWooClient } from './adapters/woo/client.js';
import { createWooPoller } from './adapters/woo/poller.js';
import { computeStats } from './pipeline/stats.js';
import { applySettings, sectionOf, liveSafe } from './settings.js';
import { describeConfig } from './config.js';

/**
 * Wire LiveLot together. Everything is injectable so tests and the replay player run the exact
 * same pipeline with mock adapters and a manual clock.
 */
export function createApp(cfg, inject = {}) {
  const bus = inject.bus || createBus();
  const clock = inject.clock || createClock();
  const store = inject.store || createStore({ dataDir: cfg.dataDir, persist: cfg.persist });
  const log = (level, msg, extra) => bus.log(level, msg, extra);
  const trace = (t) => bus.emit('trace', { at: Date.now(), ...t });

  // ---- AI. Rebuilt in place when settings change: the engines hold this same object.
  const ai = { spark: null, sam: null, asr: null, image: null, open: null };
  function buildAi() {
    if (inject.ai) { Object.assign(ai, inject.ai); return; }
    Object.assign(ai, { spark: null, sam: null, asr: null, image: null, open: null });
    if (cfg.aiMode === 'meta' && cfg.models.apiKey) {
      const client = createModelClient({ baseUrl: cfg.models.baseUrl, apiKey: cfg.models.apiKey, timeoutMs: cfg.models.timeoutMs, trace: (t) => trace({ ok: true, ...t }) });
      const traced = (name, obj) => wrapTrace(obj, name, trace);
      ai.spark = traced(cfg.models.spark, createSpark({ client, model: cfg.models.spark }));
      ai.sam = traced(cfg.models.sam, createSam({ client, model: cfg.models.sam }));
      ai.asr = traced(cfg.models.asr, createAsr({ client, model: cfg.models.asr }));
      ai.image = traced(cfg.models.image, createImageEditor({ client, model: cfg.models.image }));
    }
    if (cfg.sparkOpen.enabled && cfg.sparkOpen.apiKey) {
      const bclient = createModelClient({ baseUrl: cfg.sparkOpen.baseUrl, apiKey: cfg.sparkOpen.apiKey, timeoutMs: cfg.models.timeoutMs, trace: (t) => trace({ ok: true, ...t }) });
      ai.open = wrapTrace(createSparkOpen({ client: bclient, model: cfg.sparkOpen.model }), cfg.sparkOpen.model, trace);
    }
  }
  buildAi();

  // ---- comment agents (they capture the models and the stream delay, so they're rebuilt too)
  let classifyImpl = null;
  let matchImpl = null;
  function buildAgents() {
    const classifierModels = [ai.open, ai.spark].filter((m) => m?.classify);
    classifyImpl = createClassifier({ models: classifierModels, timeoutMs: cfg.models.classifyTimeoutMs, log });
    const describers = [ai.open, ai.spark].filter((m) => m?.match);
    const describe = describers.length
      ? async (ctx) => {
        for (const m of describers) {
          try { const { json } = await m.match(ctx); return { ...json, source: m.name }; } catch (err) { log('warn', `${m.name} match failed: ${err.message}`); }
        }
        throw new Error('no model could match');
      }
      : null;
    matchImpl = createMatcher({ lagSec: cfg.lagSec, boundarySec: cfg.boundarySec, describe, log });
  }
  buildAgents();
  const classify = inject.classify || ((...a) => classifyImpl(...a));
  const match = (...a) => matchImpl(...a);

  // ---- adapters. Demo shows (the replay) always use a pretend shop and pretend Facebook, even when
  // the server is connected to the real ones, so trying LiveLot never creates real products, orders
  // or messages.
  const current = {};
  const mockShop = () => createMockCommerce({ publicBaseUrl: cfg.publicBaseUrl, currencySymbol: cfg.currencySymbol });
  function buildPlatform() {
    current.platform = inject.platform || (cfg.platformMode === 'meta' ? createMetaPlatform({ cfg, trace, log }) : createMockPlatform());
    current.demoPlatform = inject.platform && !inject.demoAdapters ? current.platform : createMockPlatform();
  }
  function buildCommerce() {
    current.commerce = inject.commerce || (cfg.commerceMode === 'woo' ? createWooClient(cfg.woo, { trace }) : mockShop());
    current.demoCommerce = inject.commerce && !inject.demoAdapters ? current.commerce : mockShop();
  }
  buildPlatform();
  buildCommerce();
  const isDemo = () => Boolean(store.s.show?.demo);
  const switchable = (real, demo) => new Proxy({}, { get: (_, k) => (isDemo() ? current[demo] : current[real])[k] });
  const platform = switchable('platform', 'demoPlatform');
  const commerce = switchable('commerce', 'demoCommerce');

  // ---- engines
  let claims;
  const lots = createLotsEngine({ store, bus, clock, cfg, ai, commerce, log, getClaims: () => claims, platform });
  claims = createClaimsEngine({ store, bus, clock, cfg, platform, commerce, classify, match, lotsApi: lots, log });

  // ---- show lifecycle
  async function startShow({ platforms = ['facebook', 'instagram'], fbLiveVideoId = null, mode = 'live', fbPostId = null, igMediaId = null, useLatestPosts = false, demo = false } = {}) {
    if (store.s.show?.status === 'live') return store.s.show;
    store.reset();
    const show = newShow({ platforms, at: clock.now() });
    show.fbLiveVideoId = fbLiveVideoId;
    show.mode = mode === 'post' ? 'post' : 'live';
    show.fbPostId = fbPostId;
    show.igMediaId = igMediaId;
    show.useLatestPosts = Boolean(useLatestPosts);
    show.demo = Boolean(demo);
    store.s.show = show;
    bus.emit('show.updated', show);
    log('info', `${show.demo ? 'Demo show' : show.mode === 'post' ? 'Selling on posts' : 'Show started'} on ${platforms.join(' + ')} (${platform.kind} platform, ${commerce.kind} store)`);
    store.save();
    try {
      await platform.start(show, (c) => claims.handleComment(c), {
        onInfo: (info) => { Object.assign(show, info); bus.emit('show.updated', show); store.save(); },
      });
    } catch (err) {
      log('error', 'platform start failed', err);
    }
    return show;
  }

  function endShow() {
    const show = store.s.show;
    if (!show || show.status !== 'live') return show;
    claims.onShowEnding();
    platform.stop();
    show.status = 'ended';
    show.endedAt = clock.now();
    bus.emit('show.updated', show);
    log('info', 'Show ended');
    store.save();
    return show;
  }

  // ---- timers
  let sweepTimer = null;
  let poller = null;
  let timersOn = false;
  function startTimers() {
    timersOn = true;
    sweepTimer = setInterval(() => claims.expireDue().catch((err) => log('error', 'sweep failed', err)), 1000);
    startPoller();
  }
  function startPoller() {
    poller?.stop();
    poller = null;
    if (current.commerce.kind === 'woo') {
      poller = createWooPoller({ store, commerce: current.commerce, claims, log, intervalMs: cfg.woo.pollMs });
      poller.start();
    }
  }
  function stopTimers() {
    timersOn = false;
    clearInterval(sweepTimer);
    poller?.stop();
  }

  /**
   * Apply settings saved in the Settings screen to the running server. Shop, Facebook and web
   * address changes would pull the rug from under a running show, so they wait until it ends.
   */
  function reconfigure(values) {
    const keys = Object.keys(values);
    if (!keys.length) return;
    if (store.s.show?.status === 'live' && keys.some((k) => !liveSafe(k))) {
      throw Object.assign(new Error('Stop selling first. Shop, Facebook and web address settings can’t change during a show.'), { status: 409 });
    }
    applySettings(cfg, values);
    const touched = new Set(keys.map(sectionOf));
    if (touched.has('ai')) buildAi();
    buildAgents();
    if (touched.has('meta') || touched.has('server')) {
      try { current.platform.stop?.(); } catch { /* wasn't running */ }
      buildPlatform();
    }
    if (touched.has('shop') || touched.has('server')) {
      buildCommerce();
      if (timersOn) startPoller();
    }
    log('info', `Settings saved: ${[...touched].join(', ')}`);
    bus.emit('config.updated', { config: describeConfig(cfg), ai: aiNames(), platform: { kind: platform.kind, ...platform.state() }, commerce: commerce.kind });
  }

  /** One small real call to prove a section's credentials work. */
  async function checkSection(section) {
    const t0 = Date.now();
    try {
      let detail;
      if (section === 'shop') {
        if (current.commerce.kind !== 'woo') throw plain('Add the store address, consumer key and consumer secret first');
        await current.commerce.ping();
        detail = `Connected to ${cfg.woo.url.replace(/^https?:\/\//, '')}`;
      } else if (section === 'meta') {
        if (current.platform.kind !== 'meta') throw plain('Add the Page ID and Page access token first');
        const r = await current.platform.check();
        if (!r.page && !r.pageError) throw plain('Add the Page ID too');
        if (r.pageError || r.igError) throw new Error([r.pageError && `Facebook Page: ${r.pageError}`, r.igError && `Instagram: ${r.igError}`].filter(Boolean).join('. '));
        detail = [r.page && `Facebook Page “${r.page}”`, r.instagram && `Instagram ${r.instagram}`].filter(Boolean).join(' and ');
      } else if (section === 'ai') {
        if (!ai.spark) throw plain('Add the Meta Model API key first');
        const r = await ai.spark.classify({ text: 'sold!' }, 15000);
        detail = `Muse Spark answered in ${(r.ms / 1000 || (Date.now() - t0) / 1000).toFixed(1)} s`;
      } else throw plain('Nothing to test here');
      return { ok: true, ms: Date.now() - t0, detail };
    } catch (err) {
      if (err.plain) return { ok: false, ms: Date.now() - t0, detail: err.message };
      return { ok: false, ms: Date.now() - t0, detail: plainError(section, err.message), raw: err.message };
    }
  }
  const aiNames = () => Object.fromEntries(Object.entries(ai).map(([k, v]) => [k, v?.name || null]));

  function snapshot() {
    return {
      config: null,
      show: store.s.show,
      lots: store.lots(),
      claims: store.claims(),
      orders: [...store.s.orders.values()],
      buyers: [...store.s.buyers.values()],
      comments: [...store.s.comments.values()].slice(-200),
      history: bus.history(),
      stats: computeStats(store, clock),
      now: clock.now(),
      ai: aiNames(),
      platform: { kind: platform.kind, ...platform.state() },
      commerce: commerce.kind,
    };
  }

  /** Connectivity check for the dashboard's setup panel: one tiny call per configured service. */
  async function check() {
    const out = {};
    const probe = async (key, fn) => {
      try { out[key] = { ok: true, detail: await fn() }; } catch (err) { out[key] = { ok: false, detail: err.message }; }
    };
    const jobs = [];
    if (ai.spark) jobs.push(probe('spark', async () => (await ai.spark.classify({ text: 'sold!' }, 15000)).json));
    if (ai.open) jobs.push(probe('sparkOpen', async () => (await ai.open.classify({ text: 'sold!' }, 20000)).json));
    jobs.push(probe('platform', () => platform.check()));
    jobs.push(probe('commerce', () => commerce.ping()));
    await Promise.all(jobs);
    return out;
  }

  /** Post-show recap: numbers + a short social post (Muse Spark, or a template). */
  async function recap() {
    const s = computeStats(store, clock);
    const sold = store.lots().filter((l) => store.claimsForLot(l.id).some((c) => c.state === 'paid'));
    const ctx = { shop: cfg.shopName, lotsShown: s.lots, itemsSold: s.paid, revenue: `${cfg.currencySymbol}${s.revenue}`, buyers: s.buyers, medianSecondsToPayLink: s.medianReplyMs ? +(s.medianReplyMs / 1000).toFixed(1) : null, topItems: sold.slice(0, 3).map((l) => l.title) };
    let text = `${cfg.shopName} live show: ${s.paid} items sold to ${s.buyers} buyers, ${cfg.currencySymbol}${s.revenue} taken, every "sold" got a pay link in ${ctx.medianSecondsToPayLink ?? '~2'}s. No spreadsheet. #LiveLot`;
    let source = 'template';
    if (ai.spark) {
      try { const r = await ai.spark.recap(ctx); if (r.json?.text) { text = r.json.text; source = ai.spark.name; } } catch (err) { log('warn', `recap failed: ${err.message}`); }
    }
    return { stats: s, text, source, lots: store.lots().map((l) => ({ lotNumber: l.lotNumber, title: l.title, price: l.price, imagePath: l.imagePath, status: l.status, sold: store.claimsForLot(l.id).filter((c) => c.state === 'paid').length })) };
  }

  return { cfg, bus, clock, store, ai, platform, commerce, claims, lots, startShow, endShow, startTimers, stopTimers, snapshot, log, trace, check, checkSection, reconfigure, recap, stats: () => computeStats(store, clock) };
}

/** A message already written for the seller; shown as is. */
const plain = (msg) => Object.assign(new Error(msg), { plain: true });

/** Connection errors in words a seller can act on (the raw message is shown underneath). */
function plainError(section, msg = '') {
  const m = String(msg);
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|ECONNREFUSED|certificate|timed? ?out|aborted/i.test(m)) return 'Couldn’t reach that address. Check it’s typed right and the site is online.';
  if (section === 'shop') {
    if (/\b401\b|cannot_view|consumer_key|signature|invalid/i.test(m)) return 'The shop refused these keys. Check the consumer key and secret, and that the key has Read/Write permission.';
    if (/\b404\b|no_route|rest_no_route/i.test(m)) return 'No WooCommerce shop answered at that address. Check the store address, and that WooCommerce is switched on.';
    if (/\b403\b/.test(m)) return 'The shop blocked LiveLot. A security plugin or firewall may be blocking the WooCommerce API.';
  }
  if (section === 'meta') {
    if (/#190|expired|access token|OAuth/i.test(m)) return 'Facebook says the Page access token is wrong or has expired. Make a new one and paste it in.';
    if (/#100|does not exist|Unsupported get request/i.test(m)) return 'Facebook can’t find that Page or Instagram ID with this token. Check the IDs, and that the token is for this Page.';
    if (/#10\b|#200|permission/i.test(m)) return 'The token is missing a permission. Add the permissions listed in the README and make a new token.';
  }
  if (section === 'ai') {
    if (/\b401\b|\b403\b|api key|unauthor/i.test(m)) return 'Meta AI refused this key. Check the Meta Model API key.';
    if (/\b429\b|quota|rate/i.test(m)) return 'Meta AI says you’ve hit a limit or run out of credit.';
  }
  return m || 'It didn’t work';
}

/** Wrap each model method so successful calls emit a trace too (errors are traced by the client). */
function wrapTrace(obj, name, trace) {
  const out = { name: obj.name || name };
  for (const [k, fn] of Object.entries(obj)) {
    if (typeof fn !== 'function') continue;
    out[k] = async (...args) => {
      const t0 = Date.now();
      const r = await fn(...args);
      trace({ model: name, purpose: k, ms: r?.ms ?? Date.now() - t0, ok: true, summary: summarize(r) });
      return r;
    };
  }
  return out;
}

function summarize(r) {
  if (!r) return '';
  if (r.json) return JSON.stringify(r.json).slice(0, 140);
  if (r.boxes) return `${r.boxes.length} match(es)`;
  if (typeof r.text === 'string') return r.text.slice(0, 140);
  if (r.buffer) return `${Math.round(r.buffer.length / 1024)} KB image`;
  return '';
}
