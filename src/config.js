// All runtime configuration comes from env vars (see .env.example).
// Adapter modes default to "mock" unless the credentials for the real thing are present,
// so `npm start` with no .env gives a fully working local demo.

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const port = num(env.PORT, 3000);

export function loadConfig(overrides = {}) {
  const cfg = {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir: env.DATA_DIR || 'data',
    persist: bool(env.PERSIST, true),

    currency: env.CURRENCY || 'GBP',
    currencySymbol: env.CURRENCY_SYMBOL || '£',
    shopName: env.SHOP_NAME || 'LiveLot Demo Shop',

    claimTtlSec: num(env.CLAIM_TTL_SEC, 15 * 60),
    lagSec: num(env.STREAM_LAG_SEC, 8),
    boundarySec: num(env.LOT_BOUNDARY_SEC, 2),
    reviewThreshold: num(env.REVIEW_THRESHOLD, 0.6),
    autoPublish: bool(env.AUTO_PUBLISH, false),
    devTools: bool(env.DEV_TOOLS, true),
    // When set, every seller-side /api route needs it (header x-livelot-token or ?token=). Required on any public URL.
    adminToken: env.ADMIN_TOKEN || '',

    platformMode: env.PLATFORM || (env.FB_PAGE_TOKEN ? 'meta' : 'mock'),
    commerceMode: env.COMMERCE || (env.WOO_URL ? 'woo' : 'mock'),
    aiMode: env.AI || (env.MODEL_API_KEY ? 'meta' : 'mock'),

    meta: {
      graphVersion: env.GRAPH_VERSION || 'v24.0',
      appId: env.META_APP_ID || '',
      appSecret: env.META_APP_SECRET || '',
      verifyToken: env.META_VERIFY_TOKEN || 'livelot-verify',
      pageId: env.FB_PAGE_ID || '',
      pageToken: env.FB_PAGE_TOKEN || '',
      igUserId: env.IG_USER_ID || '',
      igToken: env.IG_TOKEN || env.FB_PAGE_TOKEN || '',
      commentRate: env.FB_COMMENT_RATE || 'ten_per_second',
      igPollMs: num(env.IG_POLL_MS, 2500),
      fbPollMs: num(env.FB_POLL_MS, 2000),
      useButtonTemplate: bool(env.FB_BUTTON_TEMPLATE, true),
      publicWaitlistReply: bool(env.PUBLIC_WAITLIST_REPLY, true),
    },

    models: {
      baseUrl: (env.MODEL_API_BASE || 'https://api.meta.ai/v1').replace(/\/$/, ''),
      apiKey: env.MODEL_API_KEY || '',
      spark: env.SPARK_MODEL || 'muse-spark-1.3',
      sam: env.SAM_MODEL || 'sam-3.1',
      asr: env.ASR_MODEL || 'muse-voice-transcribe-1.0',
      image: env.IMAGE_MODEL || 'muse-image-1.0',
      cleanThumbnails: bool(env.CLEAN_THUMBNAILS, true),
      timeoutMs: num(env.MODEL_TIMEOUT_MS, 20000),
      classifyTimeoutMs: num(env.CLASSIFY_TIMEOUT_MS, 3500),
      asrKeywords: list(env.ASR_KEYWORDS),
    },

    sparkOpen: {
      baseUrl: (env.BASETEN_BASE || 'https://inference.baseten.co/v1').replace(/\/$/, ''),
      apiKey: env.BASETEN_API_KEY || '',
      // The hackathon guide: "use meta-models/muse-spark-open-1026" (the docs say …-open).
      model: env.SPARK_OPEN_MODEL || 'meta-models/muse-spark-open-1026',
      enabled: bool(env.SPARK_OPEN, Boolean(env.BASETEN_API_KEY)),
    },

    woo: {
      url: (env.WOO_URL || '').replace(/\/$/, ''),
      key: env.WOO_CONSUMER_KEY || '',
      secret: env.WOO_CONSUMER_SECRET || '',
      queryAuth: bool(env.WOO_QUERY_AUTH, false),
      pingSecret: env.LIVELOT_PING_SECRET || 'change-me',
      webhookSecret: env.WOO_WEBHOOK_SECRET || '',
      pollMs: num(env.WOO_POLL_MS, 15000),
      categoryId: env.WOO_CATEGORY_ID ? Number(env.WOO_CATEGORY_ID) : null,
    },
    ...overrides,
  };
  return cfg;
}

export function describeConfig(cfg) {
  return {
    platform: cfg.platformMode,
    commerce: cfg.commerceMode,
    ai: cfg.aiMode,
    sparkOpen: cfg.sparkOpen.enabled,
    publicBaseUrl: cfg.publicBaseUrl,
    claimTtlSec: cfg.claimTtlSec,
    lagSec: cfg.lagSec,
    autoPublish: cfg.autoPublish,
    currencySymbol: cfg.currencySymbol,
    shopName: cfg.shopName,
    pageName: cfg.platformMode === 'meta' ? cfg.meta.pageName || null : null,
    devTools: cfg.devTools,
    auth: Boolean(cfg.adminToken),
  };
}
