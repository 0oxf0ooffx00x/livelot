// npm run replay                 -> fast run, prints the outcome (a smoke test of the whole pipeline)
// npm run replay -- --realtime   -> serves the dashboard and plays the show in real time (demo fallback)
// options: --fixture demo-show  --speed 2  --port 3000
import { loadConfig } from '../config.js';
import { createServer } from '../server.js';

const args = process.argv.slice(2);
const flag = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const realtime = Boolean(flag('realtime', false));
const fixture = flag('fixture', 'demo-show');
const speed = Number(flag('speed', realtime ? 1 : 40));

process.env.GLANCE_DELAY_MS ??= '0';
if (!realtime) { process.env.QUIET = '1'; process.env.LISTING_DEBOUNCE_MS = '50'; }
const cfg = loadConfig({
  platformMode: 'mock', commerceMode: 'mock', persist: false, dataDir: 'data/replay',
  port: Number(flag('port', process.env.PORT || 3000)),
});
if (!realtime) cfg.aiMode = process.env.REPLAY_AI === 'meta' ? cfg.aiMode : 'mock';
cfg.publicBaseUrl = `http://localhost:${cfg.port}`;
const { http, app, replay } = createServer(cfg);
app.startTimers();

if (realtime) {
  http.listen(cfg.port, () => {
    console.log(`\n  Replay "${fixture}" in 3s. Open http://localhost:${cfg.port}/dashboard/ and /overlay\n`);
    setTimeout(() => replay.start({ fixture, speed }), 3000);
  });
} else {
  const script = replay.load(fixture);
  const last = Math.max(...script.events.map((e) => e.t));
  await replay.start({ fixture, speed });
  await new Promise((r) => setTimeout(r, (last * 1000) / speed + 1500));
  await app.claims.idle();
  const s = app.stats();
  const lots = app.store.lots();
  console.log(`\nReplay "${script.name}" (${script.events.length} events at ${speed}×)\n`);
  for (const l of lots) {
    const cs = app.store.claimsForLot(l.id);
    console.log(`  Lot ${l.lotNumber} ${l.title} ${cfg.currencySymbol}${l.price} [${l.variants.map((v) => `${v.label}:${l.stock[v.key]}/${l.initialStock[v.key]}`).join(' ')}] ${l.status}`);
    for (const c of cs) console.log(`     ${c.state.padEnd(12)} ${String(c.displayName).padEnd(14)} "${c.text}"${c.variant && c.variant !== 'default' ? ` (${c.variant})` : ''}${c.reason ? `  · ${c.reason}` : ''}`);
  }
  const replies = app.platform.outbox;
  console.log(`\n  claims ${s.claims} · paid ${s.paid} (${cfg.currencySymbol}${s.revenue}) · held ${s.held} · waitlisted ${s.waitlisted} · review ${s.review} · expired ${s.expired} · promoted ${s.promoted}`);
  console.log(`  replies: ${replies.filter((r) => r.kind === 'private').length} private, ${replies.filter((r) => r.kind === 'public').length} public · median comment→pay link ${s.medianReplyMs ?? '-'} ms\n`);
  app.stopTimers();
  process.exit(0);
}
