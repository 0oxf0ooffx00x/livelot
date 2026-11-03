import { transition, canTransition, HOLDS_STOCK } from '../domain/claimMachine.js';
import { newBuyer, newClaim, newOrder } from '../domain/models.js';
import { resolveVariant, variantLabel } from '../domain/variants.js';
import { lotCard } from '../agents/matcher.js';
import { createKeyedMutex } from '../core/mutex.js';
import * as T from './replies.js';

// The claim agent: comment -> classify -> match lot/size -> reserve or waitlist -> pending Woo
// order (one per buyer per show) -> private reply with the pay link -> expiry -> promote waitlist.
//
// Fairness: comments are analysed in parallel (model calls), but committed strictly in arrival
// order, and stock is taken synchronously, so the first valid "sold" always wins.

export function createClaimsEngine({ store, bus, clock, cfg, platform, commerce, classify, match, lotsApi, log }) {
  const withLock = createKeyedMutex();
  const repliedComments = new Set();
  let commitTail = Promise.resolve();
  const sym = cfg.currencySymbol;
  const ttlMs = () => cfg.claimTtlSec * 1000;
  const ttlMin = () => Math.max(1, Math.round(cfg.claimTtlSec / 60));
  const pending = new Set();

  const S = store.s;
  const emitClaim = (c) => { bus.emit('claim.updated', c); store.save(); };
  const emitOrder = (o) => { bus.emit('order.updated', o); store.save(); };
  const emitLot = (l) => { bus.emit('lot.updated', l); store.save(); };
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p; };

  function upsertBuyer(comment) {
    const b = newBuyer({ platform: comment.platform, platformUserId: comment.from.id, displayName: comment.from.name });
    const existing = S.buyers.get(b.id);
    if (existing) {
      if (comment.from.name && existing.displayName !== comment.from.name) existing.displayName = comment.from.name;
      return existing;
    }
    S.buyers.set(b.id, b);
    return b;
  }

  // ---------------------------------------------------------------- intake

  function handleComment(comment) {
    if (!comment?.id || S.comments.has(comment.id)) return Promise.resolve(null);
    if (!S.show || S.show.status !== 'live') {
      log('info', `comment ignored (no live show): ${comment.text}`);
      return Promise.resolve(null);
    }
    const rec = { ...comment, at: comment.at ?? clock.now(), receivedAt: clock.now(), kind: 'pending', classification: null };
    if (!rec.lotId && rec.liveId) {
      // Webhook comments carry the post id; find the lot that post belongs to.
      const owner = store.lots().find((l) => l.posts && Object.values(l.posts).some((p) => p?.id && (p.id === rec.liveId || p.id.endsWith(`_${rec.liveId}`) || rec.liveId.endsWith(`_${p.id}`))));
      if (owner) { rec.lotId = owner.id; rec.viewerLagSec = 0; }
    }
    S.comments.set(rec.id, rec);
    bus.emit('comment.received', rec);

    const analysis = analyse(rec).catch((err) => {
      log('error', `analyse failed for "${rec.text}"`, err);
      return null;
    });
    const done = commitTail.then(() => analysis).then((a) => (a ? commit(rec, a) : null)).catch((err) => {
      log('error', `commit failed for "${rec.text}"`, err);
      return null;
    });
    commitTail = done.catch(() => {});
    return track(done);
  }

  async function analyse(c) {
    const lots = store.lots();
    const viewerT = c.at - (c.viewerLagSec ?? cfg.lagSec) * 1000;
    const current = lots.filter((l) => l.shownAt <= viewerT).pop() || lots[lots.length - 1];
    const t0 = Date.now();
    const cls = await classify(c.text, { currentLot: current ? lotCard(current) : null });
    cls.text = c.text;
    cls.ms = Date.now() - t0;
    if (!cls.isClaim && cls.confidence >= cfg.reviewThreshold) return { cls, m: null };
    const m = await match({ cls, at: c.at, viewerLagSec: c.viewerLagSec, lots, lotId: c.lotId || null });
    return { cls, m };
  }

  function commit(c, { cls, m }) {
    c.classification = { isClaim: cls.isClaim, confidence: cls.confidence, source: cls.source, lotNumber: cls.lotNumber, size: cls.size, qty: cls.qty, description: cls.description, ms: cls.ms };
    if (!m) {
      c.kind = 'chatter';
      bus.emit('comment.updated', c);
      return null;
    }
    const buyer = upsertBuyer(c);
    const claim = newClaim({ showId: S.show.id, buyerId: buyer.id, comment: c, at: clock.now() });
    claim.classification = c.classification;
    claim.qty = cls.qty || 1;
    claim.requestedSize = m.size || cls.size || null;
    claim.match = { lotNumber: m.lot?.lotNumber ?? null, confidence: m.confidence, reason: m.reason, source: m.source || null };
    claim.confidence = Math.min(cls.isClaim ? cls.confidence : 1 - cls.confidence, m.confidence);
    S.claims.set(claim.id, claim);
    c.kind = 'claim';
    c.claimId = claim.id;
    bus.emit('comment.updated', c);

    if (m.lot) {
      claim.itemId = m.lot.id;
      claim.lotNumber = m.lot.lotNumber;
    }
    const at = clock.now();
    if (!m.lot) {
      transition(claim, 'lowConfidence', { at, reason: m.reason });
    } else if (!cls.isClaim || claim.confidence < cfg.reviewThreshold) {
      transition(claim, 'lowConfidence', { at, reason: !cls.isClaim ? 'might not be a claim' : m.reason });
    } else {
      transition(claim, 'match', { at, reason: m.reason });
    }
    emitClaim(claim);
    if (claim.state === 'matched') processMatched(claim);
    return claim;
  }

  // ------------------------------------------------------- reserve / waitlist

  /** Synchronous: decides reserve vs waitlist. Never awaits, so it can't race. */
  function processMatched(claim) {
    const lot = S.lots.get(claim.itemId);
    if (!lot) return;
    if (lot.status === 'detecting' || lot.status === 'draft') {
      claim.reason = `waiting for Lot ${lot.lotNumber} to be listed`;
      emitClaim(claim);
      return;
    }
    const at = clock.now();
    const variant = resolveVariant(lot, claim.requestedSize);
    if (variant === null) {
      transition(claim, 'lowConfidence', { at, reason: claim.requestedSize ? `no size "${claim.requestedSize}"` : 'which size?' });
      emitClaim(claim);
      track(publicReply(claim, T.whichSizeText({ claim, lot })));
      return;
    }
    claim.variant = variant;
    const dup = store.claimsForLot(lot.id).find((c) => c.id !== claim.id && c.buyerId === claim.buyerId && c.variant === variant
      && ['reserved', 'invoiced', 'paid', 'waitlisted'].includes(c.state));
    if (dup) {
      transition(claim, 'cancel', { at, reason: `duplicate of earlier claim (${dup.state})` });
      emitClaim(claim);
      return;
    }
    const available = lot.stock[variant] ?? 0;
    if (available >= claim.qty) {
      lot.stock[variant] = available - claim.qty;
      transition(claim, 'reserve', { at, reason: `${lot.stock[variant]} left` });
      claim.expiresAt = at + ttlMs();
      supersedeReviews(claim);
      updateLotStatus(lot);
      emitClaim(claim);
      track(invoice(claim));
    } else {
      transition(claim, 'conflict', { at, reason: available ? `only ${available} left` : 'sold out' });
      claim.waitlistPosition = waitlistPosition(claim);
      emitClaim(claim);
      if (cfg.meta.publicWaitlistReply) track(publicReply(claim, T.waitlistPublicText({ claim, lot, position: claim.waitlistPosition })));
    }
  }

  /** A buyer who left "sold" (no size) and then "size 10" ends up with one live claim, not two. */
  function supersedeReviews(claim) {
    for (const c of store.claimsForLot(claim.itemId)) {
      if (c.id !== claim.id && c.buyerId === claim.buyerId && c.state === 'needs_review') {
        transition(c, 'cancel', { at: clock.now(), reason: 'superseded by a later comment' });
        emitClaim(c);
      }
    }
  }

  function waitlistPosition(claim) {
    const list = store.claimsForLot(claim.itemId).filter((c) => c.state === 'waitlisted' && c.variant === claim.variant);
    return list.findIndex((c) => c.id === claim.id) + 1;
  }

  function updateLotStatus(lot) {
    if (lot.status !== 'published' && lot.status !== 'sold_out') return;
    const left = Object.values(lot.stock).reduce((a, n) => a + n, 0);
    const next = left > 0 ? 'published' : 'sold_out';
    if (next !== lot.status) {
      lot.status = next;
    }
    emitLot(lot);
  }

  // ---------------------------------------------------------------- invoice

  function invoice(claim, { promoted = false } = {}) {
    return withLock(claim.buyerId, async () => {
      if (claim.state !== 'reserved') return;
      const lot = S.lots.get(claim.itemId);
      const buyer = S.buyers.get(claim.buyerId);
      try {
        await lotsApi.ensureProduct(lot);
      } catch (err) {
        claim.error = `product not in store yet: ${err.message}`;
        emitClaim(claim);
        log('error', `invoice blocked for Lot ${lot.lotNumber}`, err);
        return;
      }
      const vLabel = variantLabel(lot, claim.variant);
      const line = {
        claimId: claim.id,
        productId: lot.wooProductId,
        variationId: lot.wooVariationIds?.[claim.variant] || null,
        qty: claim.qty,
        name: `Lot ${lot.lotNumber} · ${lot.title}${vLabel ? ` (${vLabel})` : ''}`,
        price: lot.price,
        image: lot.imagePath,
      };
      let order = store.openOrderFor(buyer.id, S.show.id);
      try {
        if (!order) {
          order = newOrder({ showId: S.show.id, buyerId: buyer.id, at: clock.now() });
          const r = await commerce.createOrder({ buyer, lines: [line], showId: S.show.id });
          Object.assign(order, { wooOrderId: r.orderId, orderKey: r.orderKey, paymentUrl: r.paymentUrl, total: r.total });
          order.lineIds = { ...r.lineIds };
          S.orders.set(order.id, order);
        } else {
          const r = await commerce.addLines(order, [line]);
          Object.assign(order.lineIds, r.lineIds);
          order.total = r.total;
          if (r.paymentUrl) order.paymentUrl = r.paymentUrl;
        }
      } catch (err) {
        claim.error = `order failed: ${err.message}`;
        emitClaim(claim);
        log('error', `order failed for ${buyer.displayName}`, err);
        return;
      }
      claim.error = null;
      order.claimIds.push(claim.id);
      claim.orderId = order.id;
      const at = clock.now();
      transition(claim, 'invoice', { at, reason: promoted ? 'promoted from waitlist' : undefined });
      claim.expiresAt = at + ttlMs();
      claim.invoicedAt = at;
      emitOrder(order);
      emitClaim(claim);
      const bundledCount = order.claimIds.filter((id) => S.claims.get(id)?.state === 'invoiced' || S.claims.get(id)?.state === 'paid').length;
      const text = T.payLinkText({ claim, lot, order, sym, ttlMin: ttlMin(), variantLabel: vLabel, bundledCount, promoted });
      track(sendPayLink(claim, order, text));
    });
  }

  function payLinkFor(order) {
    return cfg.publicBaseUrl.startsWith('https://') || cfg.commerceMode === 'mock' ? `${cfg.publicBaseUrl}/p/${order.id}` : order.paymentUrl;
  }

  async function sendPayLink(claim, order, text) {
    const buyer = S.buyers.get(claim.buyerId);
    const url = payLinkFor(order);
    const buttonTitle = T.payButtonTitle(sym, order.total);
    const base = { claimId: claim.id, buyerId: buyer.id, displayName: buyer.displayName, platform: claim.platform, text, url, buttonTitle, lotNumber: claim.lotNumber };
    if (repliedComments.has(claim.commentId)) {
      if (buyer.psid && buyer.windowUntil && buyer.windowUntil > Date.now()) {
        try {
          await platform.sendMessage({ platform: claim.platform, psid: buyer.psid, text, url, buttonTitle });
          bus.emit('reply.sent', { ...base, kind: 'dm', ok: true });
        } catch (err) {
          bus.emit('reply.sent', { ...base, kind: 'dm', ok: false, error: err.message });
        }
      } else {
        bus.emit('reply.sent', { ...base, kind: 'none', ok: false, error: 'comment already used its private reply; buyer has not messaged us' });
      }
      return;
    }
    repliedComments.add(claim.commentId);
    try {
      const r = await platform.privateReply({ platform: claim.platform, commentId: claim.commentId, text, url, buttonTitle });
      if (r?.recipientId) buyer.psid = r.recipientId;
      claim.privateReplySent = true;
      claim.replyAt = clock.now();
      emitClaim(claim);
      bus.emit('reply.sent', { ...base, kind: 'private', ok: true, latencyMs: claim.replyAt - (claim.at || claim.createdAt) });
    } catch (err) {
      claim.replyError = err.message;
      emitClaim(claim);
      bus.emit('reply.sent', { ...base, kind: 'private', ok: false, error: err.message });
      log('error', `private reply failed for ${buyer.displayName}`, err);
    }
  }

  async function publicReply(claim, text) {
    if (claim.publicReplySent) return;
    claim.publicReplySent = true;
    const buyer = S.buyers.get(claim.buyerId);
    const base = { claimId: claim.id, buyerId: claim.buyerId, displayName: buyer?.displayName, platform: claim.platform, text, lotNumber: claim.lotNumber };
    try {
      await platform.publicReply({ platform: claim.platform, commentId: claim.commentId, text });
      bus.emit('reply.sent', { ...base, kind: 'public', ok: true });
    } catch (err) {
      bus.emit('reply.sent', { ...base, kind: 'public', ok: false, error: err.message });
      log('warn', `public reply failed: ${err.message}`);
    }
  }

  async function privateNotice(claim, text) {
    if (repliedComments.has(claim.commentId)) return;
    repliedComments.add(claim.commentId);
    const buyer = S.buyers.get(claim.buyerId);
    const base = { claimId: claim.id, buyerId: claim.buyerId, displayName: buyer?.displayName, platform: claim.platform, text, lotNumber: claim.lotNumber };
    try {
      await platform.privateReply({ platform: claim.platform, commentId: claim.commentId, text });
      bus.emit('reply.sent', { ...base, kind: 'private', ok: true });
    } catch (err) {
      bus.emit('reply.sent', { ...base, kind: 'private', ok: false, error: err.message });
    }
  }

  // ------------------------------------------------- release / expire / promote

  function release(claim, event, reason) {
    return withLock(claim.buyerId, async () => {
      if (!canTransition(claim.state, event)) return false;
      const holding = HOLDS_STOCK.has(claim.state);
      const order = claim.orderId ? S.orders.get(claim.orderId) : null;
      const lineId = order?.lineIds?.[claim.id];
      transition(claim, event, { at: clock.now(), reason });
      emitClaim(claim);
      const lot = S.lots.get(claim.itemId);
      if (holding && lot) {
        lot.stock[claim.variant] = (lot.stock[claim.variant] ?? 0) + claim.qty;
        updateLotStatus(lot);
        promote(lot, claim.variant);
      }
      if (order && lineId) {
        try {
          const r = await commerce.removeLines(order, [lineId]);
          delete order.lineIds[claim.id];
          order.claimIds = order.claimIds.filter((id) => id !== claim.id);
          order.total = r.total;
          if (r.remaining === 0 && order.status === 'open') {
            await commerce.cancelOrder(order);
            order.status = 'cancelled';
          }
          emitOrder(order);
        } catch (err) {
          log('error', `could not remove line for ${claim.id}`, err);
        }
      }
      return true;
    });
  }

  /** Give freed stock to the earliest waitlisted claim(s). */
  function promote(lot, variant) {
    const queue = store.claimsForLot(lot.id).filter((c) => c.state === 'waitlisted' && c.variant === variant);
    for (const next of queue) {
      if ((lot.stock[variant] ?? 0) < next.qty) break;
      lot.stock[variant] -= next.qty;
      const at = clock.now();
      transition(next, 'promote', { at, reason: 'earlier claim released' });
      next.expiresAt = at + ttlMs();
      next.promoted = true;
      emitClaim(next);
      log('info', `Lot ${lot.lotNumber}: ${next.displayName} promoted from the waitlist`);
      track(invoice(next, { promoted: true }));
    }
    for (const c of store.claimsForLot(lot.id).filter((x) => x.state === 'waitlisted' && x.variant === variant)) {
      const pos = waitlistPosition(c);
      if (pos !== c.waitlistPosition) { c.waitlistPosition = pos; emitClaim(c); }
    }
    updateLotStatus(lot);
  }

  async function expireDue() {
    const now = clock.now();
    const due = store.claims().filter((c) => (c.state === 'invoiced' || c.state === 'reserved') && c.expiresAt && c.expiresAt <= now);
    for (const c of due) {
      log('info', `Lot ${c.lotNumber}: ${c.displayName}'s hold expired`);
      await release(c, 'expire', 'not paid in time');
    }
    return due.length;
  }

  // ------------------------------------------------------------- paid / end

  function markOrderPaid(orderId, { source = 'manual' } = {}) {
    const order = S.orders.get(orderId) || [...S.orders.values()].find((o) => String(o.wooOrderId) === String(orderId));
    if (!order) return null;
    if (order.status === 'paid') return order;
    order.status = 'paid';
    order.paidAt = clock.now();
    order.paidVia = source;
    const lots = new Set();
    for (const id of order.claimIds) {
      const c = S.claims.get(id);
      if (c && canTransition(c.state, 'pay')) {
        transition(c, 'pay', { at: order.paidAt, reason: `paid (${source})` });
        emitClaim(c);
        lots.add(c.itemId);
      }
    }
    emitOrder(order);
    bus.emit('order.paid', { orderId: order.id, total: order.total, buyerId: order.buyerId });
    for (const lotId of lots) finalizeWaitlist(S.lots.get(lotId));
    return order;
  }

  /** When a variant is gone for good (stock 0 and every hold paid), tell its waitlist. */
  function finalizeWaitlist(lot, { force = false } = {}) {
    if (!lot) return;
    for (const v of lot.variants) {
      const claims = store.claimsForLot(lot.id).filter((c) => c.variant === v.key);
      const open = claims.some((c) => c.state === 'reserved' || c.state === 'invoiced');
      if (!force && ((lot.stock[v.key] ?? 0) > 0 || open)) continue;
      for (const c of claims.filter((x) => x.state === 'waitlisted')) {
        const position = c.waitlistPosition;
        transition(c, 'cancel', { at: clock.now(), reason: 'sold out' });
        emitClaim(c);
        track(privateNotice(c, T.soldOutText({ claim: c, lot, position })));
      }
    }
  }

  /** IG private replies only work during the broadcast, so close IG waitlists before it ends. */
  function onShowEnding() {
    for (const lot of store.lots()) {
      const igWaiting = store.claimsForLot(lot.id).filter((c) => c.state === 'waitlisted' && c.platform === 'instagram');
      for (const c of igWaiting) {
        const position = c.waitlistPosition;
        transition(c, 'cancel', { at: clock.now(), reason: 'show ended' });
        emitClaim(c);
        track(privateNotice(c, T.soldOutText({ claim: c, lot, position })));
      }
    }
  }

  // ---------------------------------------------------------- seller actions

  function onLotPublished(lot) {
    const waiting = store.claimsForLot(lot.id).filter((c) => c.state === 'matched');
    for (const c of waiting) processMatched(c);
  }

  function approve(claimId, { lotNumber, size } = {}) {
    const c = S.claims.get(claimId);
    if (!c || c.state !== 'needs_review') throw new Error('claim is not awaiting review');
    if (lotNumber) {
      const lot = store.lotByNumber(lotNumber);
      if (!lot) throw new Error(`no lot ${lotNumber}`);
      c.itemId = lot.id;
      c.lotNumber = lot.lotNumber;
    }
    if (!c.itemId) throw new Error('pick a lot');
    if (size) c.requestedSize = size;
    transition(c, 'approve', { at: clock.now(), reason: 'approved by seller' });
    emitClaim(c);
    processMatched(c);
    return c;
  }

  function reject(claimId) {
    const c = S.claims.get(claimId);
    if (!c || !canTransition(c.state, 'reject')) throw new Error('cannot reject');
    transition(c, 'reject', { at: clock.now(), reason: 'rejected by seller' });
    emitClaim(c);
    return c;
  }

  async function undo(claimId) {
    const c = S.claims.get(claimId);
    if (!c) throw new Error('no such claim');
    if (!canTransition(c.state, 'cancel')) throw new Error(`cannot undo a ${c.state} claim`);
    await release(c, 'cancel', 'undone by seller');
    return c;
  }

  function retry(claimId) {
    const c = S.claims.get(claimId);
    if (!c) throw new Error('no such claim');
    if (c.state === 'reserved') return track(invoice(c));
    if (c.state === 'matched') { processMatched(c); return Promise.resolve(); }
    throw new Error(`nothing to retry for a ${c.state} claim`);
  }

  function onBuyerMessage({ platform: p, psid, text }) {
    const buyer = [...S.buyers.values()].find((b) => b.psid === psid && b.platform === p);
    if (!buyer) return;
    buyer.windowUntil = Date.now() + 24 * 3600e3;
    log('info', `${buyer.displayName} messaged us ("${text.slice(0, 40)}"); 24h window open`);
    store.save();
  }

  const idle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
    await commitTail;
  };

  return {
    handleComment, processMatched, invoice, release, expireDue, promote, markOrderPaid, finalizeWaitlist,
    onShowEnding, onLotPublished, approve, reject, undo, retry, onBuyerMessage, payLinkFor, idle,
  };
}
