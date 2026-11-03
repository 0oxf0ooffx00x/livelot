import crypto from 'node:crypto';
import { normalizeIgComment } from './igLive.js';
import { normalizeFbComment } from './fbLive.js';

/** Verify X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Turn a Meta webhook payload into { comments: [...], messages: [...] }.
 *  - instagram changes: live_comments / comments
 *  - page changes: feed (item=comment, verb=add)
 *  - messaging: Messenger / IG DMs (opens the 24h window for that PSID)
 */
export function parseWebhook(payload) {
  const comments = [];
  const messages = [];
  const platform = payload?.object === 'instagram' ? 'instagram' : 'facebook';
  for (const entry of payload?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (platform === 'instagram' && (ch.field === 'live_comments' || ch.field === 'comments')) {
        comments.push({ ...normalizeIgComment({ id: v.id, text: v.text, from: v.from, timestamp: v.timestamp }, v.media?.id), via: `webhook:${ch.field}` });
      } else if (platform === 'facebook' && ch.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        comments.push({ ...normalizeFbComment({ id: v.comment_id, message: v.message, from: v.from, created_time: v.created_time ? new Date(v.created_time * 1000).toISOString() : undefined }, v.post_id), via: 'webhook:feed' });
      }
    }
    for (const m of entry.messaging || []) {
      if (m.message && !m.message.is_echo) messages.push({ platform, psid: m.sender?.id, text: m.message.text || '', at: m.timestamp || Date.now() });
      if (m.postback) messages.push({ platform, psid: m.sender?.id, text: m.postback.title || m.postback.payload || '', at: m.timestamp || Date.now() });
    }
  }
  return { comments, messages };
}
