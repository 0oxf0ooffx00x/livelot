import fs from 'node:fs';
import path from 'node:path';

// In-memory state with a debounced JSON snapshot. A single Node process owns it, and the
// stock-holding code paths are synchronous, so two claims can never both take the last unit.
export function createStore({ dataDir = 'data', persist = true } = {}) {
  const file = path.join(dataDir, 'state.json');
  const s = {
    show: null,
    lots: new Map(),
    claims: new Map(),
    orders: new Map(),
    buyers: new Map(),
    comments: new Map(),
    lotCounter: 0,
  };

  let timer = null;
  function save() {
    if (!persist) return;
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
  }
  function flush() {
    if (!persist) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(toJSON()));
      fs.renameSync(file + '.tmp', file);
    } catch (err) {
      console.error('[store] snapshot failed', err.message);
    }
  }
  function toJSON() {
    return {
      show: s.show,
      lotCounter: s.lotCounter,
      lots: [...s.lots.values()],
      claims: [...s.claims.values()],
      orders: [...s.orders.values()],
      buyers: [...s.buyers.values()],
      comments: [...s.comments.values()].slice(-500),
    };
  }
  function load() {
    if (!persist || !fs.existsSync(file)) return false;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      s.show = j.show;
      s.lotCounter = j.lotCounter || 0;
      for (const x of j.lots || []) s.lots.set(x.id, x);
      for (const x of j.claims || []) s.claims.set(x.id, x);
      for (const x of j.orders || []) s.orders.set(x.id, x);
      for (const x of j.buyers || []) s.buyers.set(x.id, x);
      for (const x of j.comments || []) s.comments.set(x.id, x);
      return true;
    } catch (err) {
      console.error('[store] load failed', err.message);
      return false;
    }
  }
  function reset() {
    s.show = null;
    s.lotCounter = 0;
    s.lots.clear(); s.claims.clear(); s.orders.clear(); s.buyers.clear(); s.comments.clear();
    save();
  }

  // Query helpers
  const lots = () => [...s.lots.values()].sort((a, b) => a.lotNumber - b.lotNumber);
  const lotByNumber = (n) => lots().find((l) => l.lotNumber === Number(n));
  const claims = () => [...s.claims.values()].sort((a, b) => a.at - b.at || a.createdAt - b.createdAt);
  const claimsForLot = (lotId) => claims().filter((c) => c.itemId === lotId);
  const openOrderFor = (buyerId, showId) =>
    [...s.orders.values()].find((o) => o.buyerId === buyerId && o.showId === showId && o.status === 'open');

  return { s, save, flush, load, reset, toJSON, lots, lotByNumber, claims, claimsForLot, openOrderFor };
}
