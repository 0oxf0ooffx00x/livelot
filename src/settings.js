// Seller-editable settings. Env vars give the defaults; whatever the seller saves in the Settings
// screen is layered on top, written to SETTINGS_FILE (a Cloud Storage bucket mounted into Cloud Run,
// so it survives restarts and deploys) and applied to the running server without a restart.
// Secrets are write-only: the browser only ever learns whether one is set and its last 4 characters.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SECTIONS = [
  { id: 'shop', title: 'Your shop', art: 'setup-shop', live: false, text: 'Where products and orders go. Without these, LiveLot uses a practice shop.' },
  { id: 'meta', title: 'Facebook and Instagram', art: 'setup-meta', live: false, text: 'The Page LiveLot posts to, reads comments from and sends pay links from.' },
  { id: 'ai', title: 'Meta AI', art: 'ai-spark', live: true, text: 'Muse Spark, SAM 3.1, Muse Voice and Muse Image. One key for all four.' },
  { id: 'rules', title: 'Selling rules', art: 'state-held', live: true, text: 'How long buyers get to pay, and how LiveLot handles a busy show.' },
  { id: 'server', title: 'This LiveLot', art: 'home-posts', live: false, text: 'The web address buyers and Meta use to reach LiveLot, and a pass for judges.' },
];

// key = path inside the config object. live: false sections can't change while selling.
export const FIELDS = [
  { section: 'shop', key: 'shopName', label: 'Shop name', type: 'text', help: 'Buyers see it on the checkout page and in messages.' },
  { section: 'shop', key: 'woo.url', label: 'WooCommerce store address', type: 'url', placeholder: 'https://shop.example.com', help: 'The address of your WordPress shop.' },
  { section: 'shop', key: 'woo.key', label: 'Consumer key', type: 'secret', placeholder: 'ck_…', help: 'In WordPress: WooCommerce → Settings → Advanced → REST API → Add key. Permissions: Read/Write.' },
  { section: 'shop', key: 'woo.secret', label: 'Consumer secret', type: 'secret', placeholder: 'cs_…' },
  { section: 'shop', key: 'currencySymbol', label: 'Currency symbol', type: 'text', placeholder: '£', max: 4 },
  { section: 'shop', key: 'currency', label: 'Currency code', type: 'text', placeholder: 'GBP', max: 3, help: 'Must match your WooCommerce currency.' },
  { section: 'shop', key: 'woo.pingSecret', label: 'Payment notice secret', type: 'secret', advanced: true, help: 'The LIVELOT_SECRET you put in wp-config.php for the LiveLot helper plugin, so payments show up instantly.' },
  { section: 'shop', key: 'woo.categoryId', label: 'Product category ID', type: 'number', advanced: true, min: 1, help: 'Optional: put every LiveLot product in this WooCommerce category.' },

  { section: 'meta', key: 'meta.appId', label: 'App ID', type: 'text', placeholder: '1234567890123456', help: 'Your Meta app → App settings → Basic.' },
  { section: 'meta', key: 'meta.pageId', label: 'Facebook Page ID', type: 'text', advanced: true, placeholder: '1234567890', help: 'Facebook Page → About → Page transparency, or Meta Business Suite → Settings.' },
  { section: 'meta', key: 'meta.pageToken', label: 'Page access token', type: 'secret', advanced: true, help: 'From Graph API Explorer or your Meta app: a Page token with the permissions in the README.' },
  { section: 'meta', key: 'meta.igUserId', label: 'Instagram account ID', type: 'text', advanced: true, placeholder: '1784…', help: 'The Instagram professional account linked to the Page. Leave empty to sell on Facebook only.' },
  { section: 'meta', key: 'meta.appSecret', label: 'App secret', type: 'secret', help: 'Meta app → App settings → Basic. Proves webhooks really come from Meta.' },
  { section: 'meta', key: 'meta.verifyToken', label: 'Webhook verify token', type: 'text', advanced: true, help: 'Any word you like; type the same one in the Meta app’s webhook settings.' },
  { section: 'meta', key: 'meta.graphVersion', label: 'Graph API version', type: 'text', advanced: true, placeholder: 'v24.0' },
  // Filled in by Connect; shown as "Connected to …", never typed.
  { section: 'meta', key: 'meta.pageName', label: 'Page name', type: 'text', hidden: true },
  { section: 'meta', key: 'meta.igUsername', label: 'Instagram username', type: 'text', hidden: true },

  { section: 'ai', key: 'models.apiKey', label: 'Meta Model API key', type: 'secret', help: 'From the Meta Model API dashboard.' },
  { section: 'ai', key: 'models.baseUrl', label: 'API address', type: 'url', advanced: true },
  { section: 'ai', key: 'models.spark', label: 'Muse Spark model', type: 'text', advanced: true },
  { section: 'ai', key: 'models.sam', label: 'SAM model', type: 'text', advanced: true },
  { section: 'ai', key: 'models.asr', label: 'Muse Voice model', type: 'text', advanced: true },
  { section: 'ai', key: 'models.image', label: 'Muse Image model', type: 'text', advanced: true },
  { section: 'ai', key: 'models.cleanThumbnails', label: 'Make clean product photos with Muse Image', type: 'toggle', advanced: true },

  { section: 'rules', key: 'claimTtlSec', label: 'Time to pay', type: 'number', unit: 'minutes', scale: 60, min: 1, max: 1440, help: 'How long an item is held for a buyer before it goes to the next person in line.' },
  { section: 'rules', key: 'lagSec', label: 'Live video delay', type: 'number', unit: 'seconds', min: 0, max: 60, help: 'Viewers see your live video a few seconds late. LiveLot uses this to tell which item a “sold” was meant for.' },
  { section: 'rules', key: 'meta.publicWaitlistReply', label: 'Reply publicly when someone joins the waiting line', type: 'toggle' },
  { section: 'rules', key: 'autoPublish', label: 'Publish items without checking them first', type: 'toggle', advanced: true, help: 'Skips step 2. Only if you trust the AI’s listings completely.' },
  { section: 'rules', key: 'reviewThreshold', label: 'Ask me when LiveLot is less sure than', type: 'number', unit: '%', scale: 0.01, min: 0, max: 100, advanced: true },

  { section: 'server', key: 'publicBaseUrl', label: 'LiveLot web address', type: 'url', placeholder: 'https://livelot.example.com', help: 'Pay links and webhooks point here. Must be reachable from the internet.' },
  // Made by the server (POST /api/settings/judge), never typed in, so it's hidden from the form.
  { section: 'server', key: 'judgeToken', label: 'Judge pass', type: 'secret', hidden: true },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

const get = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);
function set(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  parts.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}

export function settingsFile(cfg) {
  return process.env.SETTINGS_FILE || path.join(cfg.dataDir, 'settings.json');
}

/** Saved values from disk (sync, at startup). */
export function loadSavedSettings(cfg) {
  try {
    const saved = JSON.parse(readFileSync(settingsFile(cfg), 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/** Check and convert what the browser sent. Returns { key: value } in config units; throws on bad input. */
export function normalize(input) {
  const out = {};
  for (const [key, raw] of Object.entries(input || {})) {
    const f = BY_KEY.get(key);
    if (!f || f.hidden) throw Object.assign(new Error(`Unknown setting: ${key}`), { status: 400 });
    if (f.type === 'secret') {
      if (raw === null) { out[key] = ''; continue; } // "Remove"
      const v = String(raw ?? '').trim();
      if (v) out[key] = v; // empty = keep what's saved
      continue;
    }
    if (f.type === 'toggle') { out[key] = raw === true || raw === 'true' || raw === 'on'; continue; }
    if (f.type === 'number') {
      if (raw === '' || raw === null || raw === undefined) {
        if (f.key === 'woo.categoryId') { out[key] = null; continue; }
        throw Object.assign(new Error(`${f.label} needs a number`), { status: 400 });
      }
      const n = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
        throw Object.assign(new Error(`${f.label} must be a number${f.min !== undefined ? ` from ${f.min}` : ''}${f.max !== undefined ? ` to ${f.max}` : ''}`), { status: 400 });
      }
      out[key] = f.scale ? Math.round(n * f.scale * 1000) / 1000 : n;
      continue;
    }
    let v = String(raw ?? '').trim();
    if (f.max && v.length > f.max) throw Object.assign(new Error(`${f.label} is too long`), { status: 400 });
    if (f.type === 'url' && v) {
      if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
      let u;
      try { u = new URL(v); } catch { throw Object.assign(new Error(`${f.label} isn’t a web address`), { status: 400 }); }
      if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw Object.assign(new Error(`${f.label} must start with https://`), { status: 400 });
      v = `${u.origin}${u.pathname}`.replace(/\/$/, '');
    }
    if (f.key === 'currency') v = v.toUpperCase();
    if (f.key === 'publicBaseUrl' && !v) throw Object.assign(new Error('LiveLot web address can’t be empty'), { status: 400 });
    out[key] = v;
  }
  return out;
}

/** Put saved values into the live config and work out which services are switched on. */
export function applySettings(cfg, values) {
  for (const [key, v] of Object.entries(values)) if (BY_KEY.has(key)) set(cfg, key, v);
  const env = process.env;
  if (!env.IG_TOKEN && 'meta.pageToken' in values) cfg.meta.igToken = cfg.meta.pageToken;
  if (!env.COMMERCE) cfg.commerceMode = cfg.woo.url && cfg.woo.key && cfg.woo.secret ? 'woo' : 'mock';
  if (!env.PLATFORM) cfg.platformMode = cfg.meta.pageToken ? 'meta' : 'mock';
  if (!env.AI) cfg.aiMode = cfg.models.apiKey ? 'meta' : 'mock';
  return cfg;
}

export function sectionOf(key) { return BY_KEY.get(key)?.section; }
export function liveSafe(key) { return SECTIONS.find((s) => s.id === sectionOf(key))?.live === true; }

/** What the Settings screen shows. Never includes a secret's value. */
export function describeSettings(cfg, saved = {}) {
  const fields = FIELDS.filter((f) => !f.hidden).map((f) => {
    const v = get(cfg, f.key);
    const base = { key: f.key, section: f.section, label: f.label, type: f.type, help: f.help || '', placeholder: f.placeholder || '', advanced: Boolean(f.advanced), unit: f.unit || '', min: f.min, max: f.max, fromScreen: f.key in saved };
    if (f.type === 'secret') return { ...base, set: Boolean(v), hint: v ? `…${String(v).slice(-4)}` : '' };
    const shown = f.type === 'number' && f.scale && typeof v === 'number' ? Math.round((v / f.scale) * 100) / 100 : v;
    return { ...base, value: shown ?? '' };
  });
  return {
    sections: SECTIONS,
    fields,
    status: { shop: cfg.commerceMode === 'woo', meta: cfg.platformMode === 'meta', ai: cfg.aiMode === 'meta' && Boolean(cfg.models.apiKey) },
    connected: {
      page: cfg.meta.pageId && cfg.meta.pageToken ? { id: cfg.meta.pageId, name: cfg.meta.pageName || null } : null,
      instagram: cfg.meta.igUserId ? { id: cfg.meta.igUserId, username: cfg.meta.igUsername || null } : null,
    },
    links: {
      webhook: `${cfg.publicBaseUrl}/webhooks/meta`,
      paidPing: cfg.publicBaseUrl,
    },
    // Only sellers can read settings, so the seller can see and copy the judge link.
    // The pass rides after "#": browsers never send that part to a server, a log or a Referer.
    judge: cfg.judgeToken ? { on: true, link: `${cfg.publicBaseUrl}/dashboard/#token=${encodeURIComponent(cfg.judgeToken)}` } : { on: false },
  };
}

/** Merge and write (atomically where the filesystem allows). Secrets only ever live here and in env. */
export async function saveSettings(cfg, values) {
  if (cfg.persist === false) return;
  const file = settingsFile(cfg);
  const saved = loadSavedSettings(cfg);
  for (const [k, v] of Object.entries(values)) saved[k] = v;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  } catch {
    await writeFile(file, JSON.stringify(saved, null, 2), { mode: 0o600 }); // bucket mounts may not rename
  }
  return saved;
}

export async function readSaved(cfg) {
  try { return JSON.parse(await readFile(settingsFile(cfg), 'utf8')); } catch { return {}; }
}
