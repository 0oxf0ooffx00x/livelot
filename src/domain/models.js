import { uid } from '../core/ids.js';
import { DEFAULT_VARIANT, normalizeSize } from './variants.js';

export function newShow({ platforms = ['facebook'], at = Date.now() } = {}) {
  return {
    id: uid('show'), platforms, fbLiveVideoId: null, igMediaId: null,
    status: 'live', startedAt: at, endedAt: null, recordingPath: null,
  };
}

/** Build the variant list + stock map from a listing's sizes/quantity. */
export function buildVariants({ variants = [], quantity = 1 } = {}) {
  const clean = (variants || [])
    .map((v) => (typeof v === 'string' ? { label: v, qty: 1 } : v))
    .filter((v) => v && v.label !== undefined && String(v.label).trim() !== '');
  if (!clean.length) {
    return { variants: [{ key: DEFAULT_VARIANT, label: 'One size' }], stock: { [DEFAULT_VARIANT]: Math.max(1, Number(quantity) || 1) } };
  }
  const out = [];
  const stock = {};
  for (const v of clean) {
    const label = String(v.label).trim();
    const key = normalizeSize(label) || label.toLowerCase();
    if (stock[key] !== undefined) {
      stock[key] += Math.max(1, Number(v.qty) || 1);
      continue;
    }
    out.push({ key, label: label.length <= 3 ? label.toUpperCase() : label });
    stock[key] = Math.max(1, Number(v.qty) || 1);
  }
  return { variants: out, stock };
}

export function newLot({ showId, lotNumber, at = Date.now() }) {
  return {
    id: uid('lot'), showId, lotNumber, status: 'detecting', shownAt: at,
    concept: null, title: '', description: '', price: null, currency: null,
    variants: [{ key: DEFAULT_VARIANT, label: 'One size' }], stock: { [DEFAULT_VARIANT]: 1 }, initialStock: { [DEFAULT_VARIANT]: 1 },
    transcript: [], imagePath: null, framePath: null, cropPath: null, cleanPath: null, box: null,
    wooProductId: null, wooVariationIds: {}, productUrl: null, needsReview: true,
    listingSource: null, listingConfidence: null, publishError: null, notes: [],
  };
}

export function newBuyer({ platform, platformUserId, displayName }) {
  return { id: `${platform}:${platformUserId}`, platform, platformUserId, displayName: displayName || 'Viewer', email: null, psid: null };
}

export function newClaim({ showId, buyerId, comment, at }) {
  return {
    id: uid('clm'), showId, itemId: null, lotNumber: null, buyerId, variant: null, qty: 1,
    commentId: comment.id, platform: comment.platform, text: comment.text, displayName: comment.from?.name,
    at: comment.at ?? at, createdAt: at, updatedAt: at, state: 'detected', confidence: null,
    classification: null, match: null, orderId: null, expiresAt: null, reason: null,
    privateReplySent: false, publicReplySent: false, waitlistPosition: null, error: null, history: [],
  };
}

export function newOrder({ showId, buyerId, at = Date.now() }) {
  return {
    id: uid('ord'), showId, buyerId, wooOrderId: null, orderKey: null, paymentUrl: null,
    claimIds: [], lineIds: {}, status: 'open', total: 0, createdAt: at, paidAt: null,
  };
}
