// In-memory stand-in for WooCommerce with the same interface. Payment links point at
// LiveLot's own /pay/:id page, so the whole flow can be demoed with no store.
export function createMockCommerce({ publicBaseUrl, latencyMs = 120, currencySymbol = '£' }) {
  const products = new Map();
  const orders = new Map();
  let pid = 500;
  let oid = 1000;
  let lid = 9000;
  const wait = () => new Promise((r) => setTimeout(r, latencyMs));

  const total = (o) => o.lines.reduce((a, l) => a + l.price * l.qty, 0);

  return {
    kind: 'mock',
    orders,
    products,
    async createProduct(lot) {
      await wait();
      const id = ++pid;
      const variationIds = {};
      for (const v of lot.variants) variationIds[v.key] = lot.variants.length > 1 ? ++pid : null;
      products.set(id, { id, name: lot.title, price: lot.price, variationIds });
      return { productId: id, variationIds, permalink: `${publicBaseUrl}/shop/lot/${lot.lotNumber}` };
    },
    async updateProduct() { await wait(); },
    async createOrder({ buyer, lines }) {
      await wait();
      const id = ++oid;
      const o = { id, buyer: buyer.displayName, status: 'pending', lines: [], key: `wc_order_${Math.random().toString(36).slice(2, 10)}` };
      const lineIds = {};
      for (const l of lines) { const lineId = ++lid; o.lines.push({ ...l, id: lineId }); lineIds[l.claimId] = lineId; }
      orders.set(id, o);
      return { orderId: id, orderKey: o.key, paymentUrl: `${publicBaseUrl}/pay/${id}?key=${o.key}`, lineIds, total: total(o) };
    },
    async addLines(order, lines) {
      await wait();
      const o = orders.get(order.wooOrderId);
      if (!o) throw new Error(`mock order ${order.wooOrderId} missing`);
      const lineIds = {};
      for (const l of lines) { const lineId = ++lid; o.lines.push({ ...l, id: lineId }); lineIds[l.claimId] = lineId; }
      return { lineIds, total: total(o), paymentUrl: `${publicBaseUrl}/pay/${o.id}?key=${o.key}` };
    },
    async removeLines(order, lineIds) {
      await wait();
      const o = orders.get(order.wooOrderId);
      if (!o) return { total: 0, remaining: 0 };
      o.lines = o.lines.filter((l) => !lineIds.includes(l.id));
      return { total: total(o), remaining: o.lines.length };
    },
    async cancelOrder(order) {
      const o = orders.get(order.wooOrderId);
      if (o) o.status = 'cancelled';
    },
    async orderStatuses(ids) {
      return ids.map((id) => orders.get(id)).filter(Boolean).map((o) => ({ id: o.id, status: o.status, total: total(o) }));
    },
    markPaid(wooOrderId) {
      const o = orders.get(Number(wooOrderId));
      if (o) o.status = 'processing';
      return o;
    },
    view(wooOrderId) {
      const o = orders.get(Number(wooOrderId));
      if (!o) return null;
      return { id: o.id, buyer: o.buyer, status: o.status, key: o.key, currencySymbol, total: total(o), lines: o.lines.map((l) => ({ name: l.name, qty: l.qty, price: l.price, image: l.image })) };
    },
    async ping() { return { ok: true, wc: 'mock' }; },
  };
}
