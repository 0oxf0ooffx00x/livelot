// npm run smoke: one real call per configured service, so Saturday's setup can be ticked off.
// Prints what works and the exact error for what doesn't. Makes no purchases; creates nothing in Woo.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createModelClient, outputText } from '../src/ai/metaClient.js';
import { createSpark } from '../src/ai/spark.js';
import { createSam } from '../src/ai/sam.js';
import { createSparkOpen } from '../src/ai/sparkOpen.js';
import { createGraph } from '../src/adapters/meta/graph.js';
import { createWooClient } from '../src/adapters/woo/client.js';

const cfg = loadConfig();
const line = (ok, name, detail) => console.log(`${ok ? '✓' : '✗'} ${name.padEnd(28)} ${String(detail).slice(0, 160)}`);
const img = process.argv[2] && fs.existsSync(process.argv[2]) ? fs.readFileSync(process.argv[2]) : null;

async function step(name, fn) {
  try { line(true, name, await fn()); } catch (err) { line(false, name, err.message); }
}

console.log('\nLiveLot smoke test\n');
if (cfg.models.apiKey) {
  const client = createModelClient({ baseUrl: cfg.models.baseUrl, apiKey: cfg.models.apiKey, timeoutMs: 30000 });
  const spark = createSpark({ client, model: cfg.models.spark });
  await step(`Muse Spark (${cfg.models.spark})`, async () => JSON.stringify((await spark.classify({ text: 'sold! size 10 please' }, 30000)).json));
  if (img) {
    await step('Muse Spark glance', async () => JSON.stringify((await spark.glance(img)).json));
    const sam = createSam({ client, model: cfg.models.sam });
    await step(`SAM (${cfg.models.sam})`, async () => { const r = await sam.segment(img, process.argv[3] || 'jacket'); return `${r.boxes.length} box(es) ${JSON.stringify(r.boxes[0] || {})}`; });
  } else line(false, 'SAM / glance', 'skipped: pass a photo, e.g. npm run smoke -- photo.jpg "denim jacket"');
  await step('Model list', async () => { const r = await client.request('/models', { method: 'GET', model: 'list' }); return (r.data || []).map((m) => m.id).join(', ') || outputText(r); });
} else line(false, 'Meta Model API', 'MODEL_API_KEY not set');

if (cfg.sparkOpen.apiKey) {
  const b = createModelClient({ baseUrl: cfg.sparkOpen.baseUrl, apiKey: cfg.sparkOpen.apiKey, timeoutMs: 40000 });
  await step(`Spark Open (${cfg.sparkOpen.model})`, async () => JSON.stringify((await createSparkOpen({ client: b, model: cfg.sparkOpen.model }).classify({ text: 'mine!' }, 40000)).json));
} else line(false, 'Spark Open (Baseten)', 'BASETEN_API_KEY not set');

if (cfg.meta.pageToken) {
  const g = createGraph({ version: cfg.meta.graphVersion });
  await step('Page token', async () => { const p = await g.get(`/${cfg.meta.pageId}`, { token: cfg.meta.pageToken, params: { fields: 'id,name' } }); return p.name; });
  await step('Token permissions', async () => { const r = await g.get('/me/permissions', { token: cfg.meta.pageToken }); return (r.data || []).filter((p) => p.status === 'granted').map((p) => p.permission).join(', ') || 'page token (check in Access Token Debugger)'; });
  await step('Current FB live video', async () => { const r = await g.get(`/${cfg.meta.pageId}/live_videos`, { token: cfg.meta.pageToken, params: { broadcast_status: '["LIVE"]', fields: 'id,title' } }); return r.data?.[0] ? `${r.data[0].id} ${r.data[0].title || ''}` : 'none live right now (fine)'; });
  if (cfg.meta.igUserId) await step('Instagram account', async () => { const u = await g.get(`/${cfg.meta.igUserId}`, { token: cfg.meta.igToken, params: { fields: 'id,username' } }); return `@${u.username}`; });
} else line(false, 'Facebook Page', 'FB_PAGE_TOKEN not set');

if (cfg.woo.url) {
  const woo = createWooClient(cfg.woo);
  await step('WooCommerce REST', async () => { const r = await woo.ping(); return `WooCommerce ${r.wc}`; });
} else line(false, 'WooCommerce', 'WOO_URL not set');
console.log(`\nPublic URL: ${cfg.publicBaseUrl}${cfg.publicBaseUrl.startsWith('https://') ? '' : '  (needs https for webhooks and pay links)'}\n`);
