import fs from 'node:fs';
import path from 'node:path';

// Plays a scripted show (fixtures/*.json) through the real pipeline: lots open, the seller's
// speech goes through the listing parser / Muse Spark, comments go through the classifier and the
// claim agent, payments arrive. Used for tests, rehearsals and the demo-day fallback.
export function createReplayPlayer({ app, root }) {
  let timers = [];
  let state = { running: false, fixture: null, startedAt: null, speed: 1, done: 0, total: 0 };

  function load(name) {
    const file = path.join(root, 'fixtures', `${name.replace(/[^a-z0-9_-]/gi, '')}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function stop() {
    for (const t of timers) clearTimeout(t);
    timers = [];
    state.running = false;
    app.bus.emit('replay', { ...state });
    return state;
  }

  const findLot = (n) => app.store.lotByNumber(n) || app.lots.currentLot();

  async function run(evt) {
    const { lots, claims, store, clock } = app;
    switch (evt.type) {
      case 'lot': {
        const lot = lots.nextLot({ hint: evt.hint || null, image: evt.image || null });
        if (evt.speech) {
          const parts = Array.isArray(evt.speech) ? evt.speech : [evt.speech];
          parts.forEach((text, i) => timers.push(setTimeout(() => lots.onSpeech({ text, final: true, source: 'replay' }), (i * 1200) / state.speed)));
        }
        if (evt.listing) lot.scriptedListing = evt.listing;
        break;
      }
      case 'speech':
        lots.onSpeech({ text: evt.text, final: true, source: 'replay' });
        break;
      case 'publish': {
        const lot = findLot(evt.lot);
        if (!lot) break;
        // The seller approves what LiveLot drafted. Draft now if the debounce hasn't fired yet.
        if (lot.status === 'detecting' || !lot.price) await lots.draftListing(lot);
        if (!lot.price && lot.scriptedListing) lots.override(lot.id, lot.scriptedListing);
        lots.publish(lot.id);
        break;
      }
      case 'comment':
        await claims.handleComment({
          id: `rp_${state.startedAt}_${evt.i}`,
          platform: evt.platform || 'facebook',
          from: { id: (evt.userId || evt.name).toLowerCase().replace(/[^a-z0-9@]+/g, '-'), name: evt.platform === 'instagram' && !evt.name.startsWith('@') ? `@${evt.name}` : evt.name },
          text: evt.text,
          at: clock.now(),
          viewerLagSec: 0,
          simulated: true,
        });
        break;
      case 'advance':
        clock.advance((evt.sec || app.cfg.claimTtlSec) * 1000);
        app.log('info', `⏩ fast-forward ${Math.round((evt.sec || app.cfg.claimTtlSec) / 60)} min`);
        await claims.expireDue();
        app.bus.emit('clock', { now: clock.now() });
        break;
      case 'pay': {
        const buyer = [...store.s.buyers.values()].find((b) => b.displayName === evt.name);
        const order = buyer && store.openOrderFor(buyer.id, store.s.show.id);
        if (order) {
          app.commerce.markPaid?.(order.wooOrderId);
          claims.markOrderPaid(order.id, { source: 'checkout' });
        }
        break;
      }
      case 'end':
        app.endShow();
        break;
      default:
        app.log('warn', `replay: unknown event ${evt.type}`);
    }
  }

  async function start({ fixture = 'demo-show', speed = 1 } = {}) {
    stop();
    const script = load(fixture);
    if (app.store.s.show?.status === 'live') app.endShow();
    await app.startShow({ platforms: script.platforms || ['facebook', 'instagram'], demo: true });
    state = { running: true, fixture, startedAt: Date.now(), speed, done: 0, total: script.events.length, name: script.name };
    app.bus.emit('replay', { ...state });
    app.log('info', `▶ Replay "${script.name}" at ${speed}×`);
    script.events.forEach((evt, i) => {
      timers.push(setTimeout(async () => {
        try { await run({ ...evt, i }); } catch (err) { app.log('error', `replay step ${i} (${evt.type}) failed`, err); }
        state.done++;
        if (state.done === state.total) { state.running = false; app.log('info', '■ Replay finished'); }
        app.bus.emit('replay', { ...state });
      }, (evt.t * 1000) / speed));
    });
    return { ...state };
  }

  return { start, stop, status: () => ({ ...state }), load };
}
