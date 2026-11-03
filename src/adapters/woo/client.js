// WooCommerce REST v3 adapter.
// - Products: simple, or variable with a "Size" attribute + variations (stock managed per variation).
// - Orders: one pending order per buyer per show; claims add lines, expiries remove them
//   (line_items: [{ id, quantity: 0 }]). A pending order does NOT reduce Woo stock, so LiveLot's
//   in-memory counter is the source of truth during the show; Woo reduces stock when the order is paid.

export class WooError extends Error {
  constructor(msg, { status, code, body } = {}) {
    super(msg);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function createWooClient(cfg, { fetchImpl = fetch, trace = () => {} } = {}) {
  const base = `${cfg.url}/wp-json/wc/v3`;
  const auth = 'Basic ' + Buffer.from(`${cfg.key}:${cfg.secret}`).toString('base64');

  async function call(method, path, body, purpose) {
    const t0 = Date.now();
    let url = `${base}${path}`;
    const headers = { Accept: 'application/json' };
    if (cfg.queryAuth) url += `${url.includes('?') ? '&' : '?'}consumer_key=${encodeURIComponent(cfg.key)}&consumer_secret=${encodeURIComponent(cfg.secret)}`;
    else headers.Authorization = auth;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    let text;
    try {
      res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
      text = await res.text();
    } catch (err) {
      trace({ model: 'woocommerce', purpose, ms: Date.now() - t0, ok: false, summary: err.message });
      throw new WooError(`Woo ${method} ${path}: ${err.message}`);
    }
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
      trace({ model: 'woocommerce', purpose, ms: Date.now() - t0, ok: false, summary: `${res.status} ${data.code || ''}` });
      throw new WooError(`Woo ${method} ${path}: ${res.status} ${data.code || ''} ${data.message || ''}`, { status: res.status, code: data.code, body: data });
    }
    trace({ model: 'woocommerce', purpose, ms: Date.now() - t0, ok: true, summary: `${method} ${path.split('?')[0]}` });
    return data;
  }

  const money = (n) => (n === null || n === undefined ? '' : Number(n).toFixed(2));

  async function createProduct(lot, { imageUrl } = {}) {
    try {
      return await createProductOnce(lot, { imageUrl });
    } catch (err) {
      // A photo Woo can't sideload (SVG, unreachable URL) shouldn't block the sale: retry without it.
      if (imageUrl && /image|upload|sideload|mime/i.test(`${err.code} ${err.message}`)) {
        trace({ model: 'woocommerce', purpose: 'product photo rejected, creating without it', ms: 0, ok: false, summary: err.code || err.message });
        return createProductOnce(lot, { imageUrl: null });
      }
      throw err;
    }
  }

  async function createProductOnce(lot, { imageUrl } = {}) {
    const isVariable = lot.variants.length > 1 || (lot.variants[0] && lot.variants[0].key !== 'default');
    const images = imageUrl ? [{ src: imageUrl, alt: lot.title }] : [];
    const common = {
      name: lot.title || `Lot ${lot.lotNumber}`,
      status: 'publish',
      description: descriptionHtml(lot),
      short_description: shortText(lot.description),
      sku: `LL-${lot.showId.slice(-6)}-${lot.lotNumber}`,
      images,
      categories: cfg.categoryId ? [{ id: cfg.categoryId }] : [],
      meta_data: [{ key: '_livelot_lot', value: lot.id }],
    };
    if (!isVariable) {
      const p = await call('POST', '/products', {
        ...common, type: 'simple', regular_price: money(lot.price),
        manage_stock: true, stock_quantity: Object.values(lot.initialStock)[0] ?? 1,
      }, `create product "${lot.title}"`);
      return { productId: p.id, variationIds: { [lot.variants[0].key]: null }, permalink: p.permalink };
    }
    const p = await call('POST', '/products', {
      ...common, type: 'variable',
      attributes: [{ name: 'Size', visible: true, variation: true, options: lot.variants.map((v) => v.label) }],
    }, `create variable product "${lot.title}"`);
    const batch = await call('POST', `/products/${p.id}/variations/batch`, {
      create: lot.variants.map((v) => ({
        regular_price: money(lot.price), manage_stock: true, stock_quantity: lot.initialStock[v.key] ?? 1,
        attributes: [{ name: 'Size', option: v.label }],
      })),
    }, `create ${lot.variants.length} size variations`);
    const variationIds = {};
    (batch.create || []).forEach((vr, i) => { variationIds[lot.variants[i].key] = vr.id; });
    return { productId: p.id, variationIds, permalink: p.permalink };
  }

  async function updateProduct(lot) {
    if (!lot.wooProductId) return;
    await call('PUT', `/products/${lot.wooProductId}`, {
      name: lot.title, description: descriptionHtml(lot), short_description: shortText(lot.description),
      ...(Object.values(lot.wooVariationIds).every((v) => v === null) ? { regular_price: money(lot.price) } : {}),
    }, `update product "${lot.title}"`);
  }

  const lineItem = (l) => ({
    product_id: l.productId,
    ...(l.variationId ? { variation_id: l.variationId } : {}),
    quantity: l.qty,
    meta_data: [{ key: '_livelot_claim', value: l.claimId }],
  });

  function mapLines(order, lines) {
    const out = {};
    const items = order.line_items || [];
    for (const l of lines) {
      const hit = items.find((it) => (it.meta_data || []).some((m) => m.key === '_livelot_claim' && m.value === l.claimId))
        || items.find((it) => it.product_id === l.productId && (it.variation_id || 0) === (l.variationId || 0) && !Object.values(out).includes(it.id));
      if (hit) out[l.claimId] = hit.id;
    }
    return out;
  }

  async function createOrder({ buyer, lines, showId }) {
    const [first, ...rest] = (buyer.displayName || 'Live buyer').split(' ');
    const o = await call('POST', '/orders', {
      status: 'pending', set_paid: false, created_via: 'livelot',
      billing: { first_name: first, last_name: rest.join(' '), ...(buyer.email ? { email: buyer.email } : {}) },
      line_items: lines.map(lineItem),
      customer_note: `Claimed live on ${buyer.platform}`,
      meta_data: [
        { key: '_livelot_show', value: showId },
        { key: '_livelot_buyer', value: buyer.id },
      ],
    }, `create pending order for ${buyer.displayName}`);
    return { orderId: o.id, orderKey: o.order_key, paymentUrl: o.payment_url || payUrl(o), lineIds: mapLines(o, lines), total: Number(o.total) };
  }

  const payUrl = (o) => `${cfg.url}/checkout/order-pay/${o.id}/?pay_for_order=true&key=${o.order_key}`;

  async function addLines(order, lines) {
    const o = await call('PUT', `/orders/${order.wooOrderId}`, { line_items: lines.map(lineItem) }, `add ${lines.length} line(s) to order #${order.wooOrderId}`);
    return { lineIds: mapLines(o, lines), total: Number(o.total), paymentUrl: o.payment_url || payUrl(o) };
  }

  async function removeLines(order, lineIds) {
    const o = await call('PUT', `/orders/${order.wooOrderId}`, { line_items: lineIds.map((id) => ({ id, quantity: 0 })) }, `remove line(s) from order #${order.wooOrderId}`);
    return { total: Number(o.total), remaining: (o.line_items || []).length };
  }

  async function cancelOrder(order) {
    await call('PUT', `/orders/${order.wooOrderId}`, { status: 'cancelled' }, `cancel order #${order.wooOrderId}`);
  }

  async function orderStatuses(wooIds) {
    if (!wooIds.length) return [];
    const rows = await call('GET', `/orders?include=${wooIds.join(',')}&per_page=100&_fields=id,status,total,billing`, null, 'check payments');
    return rows.map((r) => ({ id: r.id, status: r.status, total: Number(r.total), email: r.billing?.email }));
  }

  async function ping() {
    const r = await call('GET', '/system_status?_fields=environment', null, 'ping store');
    return { ok: true, wc: r?.environment?.version };
  }

  return { kind: 'woo', createProduct, updateProduct, createOrder, addLines, removeLines, cancelOrder, orderStatuses, ping };
}

const escHtml = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** The first sentence or two, for Woo's short description and social captions. */
export function shortText(text, max = 220) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}
/** Product page: the description, the specs Muse Spark found online, and where the item came from. */
export function descriptionHtml(lot) {
  const facts = lot.research?.facts || [];
  return [
    lot.description ? `<p>${escHtml(lot.description)}</p>` : '',
    facts.length ? `<ul>${facts.map((f) => `<li>${escHtml(f)}</li>`).join('')}</ul>` : '',
    `<p>Lot ${lot.lotNumber} from our live show.</p>`,
  ].filter(Boolean).join('\n');
}
