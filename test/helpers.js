import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createClock } from '../src/core/clock.js';
import { createMockPlatform } from '../src/adapters/mock/platform.js';
import { createMockCommerce } from '../src/adapters/mock/commerce.js';

process.env.QUIET = '1';
process.env.GLANCE_DELAY_MS = '0';
process.env.LISTING_DEBOUNCE_MS = '0';

export async function makeApp(overrides = {}, inject = {}) {
  const cfg = loadConfig({ persist: false, dataDir: 'data/test', platformMode: 'mock', commerceMode: 'mock', aiMode: 'mock', lagSec: 0, ...overrides });
  cfg.sparkOpen = { ...cfg.sparkOpen, enabled: false };
  const clock = createClock({ manual: true, start: 1_000_000 });
  const platform = createMockPlatform({ latencyMs: 0 });
  const commerce = createMockCommerce({ publicBaseUrl: cfg.publicBaseUrl, latencyMs: 0 });
  const app = createApp(cfg, { clock, platform, commerce, ai: {}, ...inject });
  await app.startShow({ platforms: ['facebook', 'instagram'] });
  let n = 0;
  const say = async (who, text, extra = {}) => {
    const c = { id: `c${++n}`, platform: extra.platform || 'facebook', from: { id: who.toLowerCase(), name: who }, text, at: clock.now(), ...extra };
    const claim = await app.claims.handleComment(c);
    await app.claims.idle();
    return claim;
  };
  const lot = (listing, opts = {}) => {
    const l = app.lots.nextLot({ at: clock.now(), listing: { title: 'Item', price: 10, ...listing }, ...opts });
    if (opts.publish !== false) app.lots.publish(l.id);
    return l;
  };
  return { app, cfg, clock, platform, commerce, say, lot, tick: (ms) => clock.advance(ms) };
}
