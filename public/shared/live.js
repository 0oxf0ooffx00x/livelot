// Live state client shared by the dashboard, overlay and studio. One SSE stream, one state object.

// Seller token: arrives once as ?token=..., then lives in localStorage (OBS keeps it in the URL).
let memToken = '';
(() => {
  const params = new URLSearchParams(location.search);
  const t = params.get('token');
  if (!t) return;
  memToken = t;
  try { localStorage.setItem('livelot-token', t); } catch { /* private mode: keep it in memory */ }
  if (!window.obsstudio) {
    params.delete('token');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
  }
})();
export function token() {
  try { return localStorage.getItem('livelot-token') || memToken; } catch { return memToken; }
}
export const authHeaders = (h = {}) => (token() ? { ...h, 'x-livelot-token': token() } : h);
const isOverlay = () => location.pathname.startsWith('/overlay');
export function needLogin() {
  if (isOverlay()) { document.body.dataset.auth = 'missing'; return; }
  location.href = `/login/?next=${encodeURIComponent(location.pathname)}`;
}

export async function api(path, body, method = 'POST') {
  const res = await fetch(path, { method, headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.auth) { needLogin(); throw new Error('Seller token required'); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function connect(onChange) {
  const state = {
    connected: false, show: null, config: {}, stats: {}, ai: {}, platform: {}, commerce: null, replay: {},
    lots: new Map(), claims: new Map(), orders: new Map(), buyers: new Map(),
    comments: [], traces: [], replies: [], logs: [], transcript: [], offset: 0,
  };
  state.now = () => Date.now() + state.offset;
  const push = (arr, item, max) => { arr.push(item); if (arr.length > max) arr.splice(0, arr.length - max); };
  let es;

  const handlers = {
    snapshot(d) {
      // A new deploy: this page's code may be older than the server's. Tell the page once.
      if (state.build && d.build && d.build !== state.build) state.outdated = true;
      state.build = d.build || state.build;
      state.show = d.show; state.config = d.config || {}; state.stats = d.stats || {}; state.ai = d.ai || {};
      state.platform = d.platform || {}; state.commerce = d.commerce; state.replay = d.replay || {};
      state.offset = d.now - Date.now();
      state.lots = new Map(d.lots.map((x) => [x.id, x]));
      state.claims = new Map(d.claims.map((x) => [x.id, x]));
      state.orders = new Map(d.orders.map((x) => [x.id, x]));
      state.buyers = new Map(d.buyers.map((x) => [x.id, x]));
      state.comments = d.comments || [];
      state.traces = []; state.replies = []; state.logs = [];
      for (const h of d.history || []) {
        if (h.type === 'trace') push(state.traces, h.data, 80);
        else if (h.type === 'reply.sent') push(state.replies, h.data, 200);
        else if (h.type === 'log') push(state.logs, h.data, 120);
      }
    },
    'show.updated': (d) => { state.show = d; },
    'lot.created': (d) => { state.lots.set(d.id, d); },
    'lot.updated': (d) => { state.lots.set(d.id, d); },
    'claim.updated': (d) => { state.claims.set(d.id, d); },
    'order.updated': (d) => { state.orders.set(d.id, d); },
    'comment.received': (d) => { push(state.comments, d, 300); },
    'comment.updated': (d) => {
      const i = state.comments.findIndex((c) => c.id === d.id);
      if (i >= 0) state.comments[i] = d; else push(state.comments, d, 300);
    },
    'reply.sent': (d) => push(state.replies, d, 200),
    trace: (d) => push(state.traces, d, 80),
    log: (d) => push(state.logs, d, 120),
    transcript: (d) => push(state.transcript, d, 40),
    stats: (d) => { state.stats = d; },
    clock: (d) => { state.offset = d.now - Date.now(); },
    replay: (d) => { state.replay = d; },
    'config.updated': (d) => {
      if (d.config) state.config = d.config;
      if (d.ai) state.ai = d.ai;
      if (d.platform) state.platform = d.platform;
      if (d.commerce) state.commerce = d.commerce;
    },
    reset: () => { state.lots.clear(); state.claims.clear(); state.orders.clear(); state.buyers.clear(); state.comments = []; state.replies = []; state.show = null; },
    vision: () => {},
    'order.paid': () => {},
  };

  let retry = 0;
  let retryTimer = null;
  function open() {
    clearTimeout(retryTimer);
    es = new EventSource(`/api/events${token() ? `?token=${encodeURIComponent(token())}` : ''}`);
    es.onopen = () => { retry = 0; state.connected = true; onChange('connected', null, state); };
    es.onerror = async () => {
      state.connected = false;
      onChange('disconnected', null, state);
      // EventSource hides the status code; ask once whether this is a missing token.
      const r = await fetch('/api/state', { headers: authHeaders() }).catch(() => null);
      if (r?.status === 401) { es.close(); needLogin(); return; }
      // Chrome stops retrying for good after some failures (e.g. the server restarting during a
      // deploy). Never stay disconnected: reopen with a short back-off.
      if (es.readyState === EventSource.CLOSED) {
        retry = Math.min(retry + 1, 6);
        retryTimer = setTimeout(open, 1000 * retry);
      }
    };
    for (const [type, fn] of Object.entries(handlers)) {
      es.addEventListener(type, (e) => {
        const data = JSON.parse(e.data);
        fn(data);
        if (type === 'claim.updated' || type === 'order.updated') refreshBuyers(data);
        onChange(type, data, state);
      });
    }
  }
  // Buyers are not streamed individually; derive names from claims.
  function refreshBuyers(d) {
    if (d.buyerId && !state.buyers.has(d.buyerId)) state.buyers.set(d.buyerId, { id: d.buyerId, displayName: d.displayName, platform: d.platform });
  }
  open();
  return state;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const money = (sym, n) => (n === null || n === undefined || n === '' ? '' : `${sym}${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`);
export const clockText = (ms) => {
  if (ms <= 0) return '0:00';
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const ago = (now, t) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};
