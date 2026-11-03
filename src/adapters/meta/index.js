import { createGraph } from './graph.js';
import { findCurrentLiveVideo, latestPagePost, startFbComments } from './fbLive.js';
import { startIgLivePoll, startIgMediaPoll, latestIgMedia } from './igLive.js';

// The real Facebook + Instagram platform adapter.
export function createMetaPlatform({ cfg, trace, log, fetchImpl = fetch }) {
  const m = cfg.meta;
  const graph = createGraph({ version: m.graphVersion, fetchImpl, trace });
  let fb = null;
  let ig = null;
  let findTimer = null;
  let onCommentRef = null;
  const watchers = new Map();
  let newestWatch = null;
  const state = { fbLiveVideoId: null, fbPostId: null, igMediaId: null, fbMode: null, mode: 'live' };

  async function start(show, onComment, { onInfo = () => {} } = {}) {
    stop();
    onCommentRef = onComment;
    if (m.pageId && m.pageToken) subscribePage().catch((err) => log('warn', `webhook subscription failed (polling still works): ${err.message}`));
    const wantFb = show.platforms.includes('facebook') && m.pageId && m.pageToken;
    const wantIg = show.platforms.includes('instagram') && m.igUserId && m.igToken;
    state.mode = show.mode || 'live';

    if (show.mode === 'post') {
      // Selling on ordinary posts ("comment SOLD"): no live video needed, so no follower minimum.
      // Comments written before the show started are skipped, so a restart can't re-sell anything.
      const since = (show.startedAt || Date.now()) - 60e3;
      const fresh = (c) => {
        if (c.at < since) return;
        onComment({ ...c, viewerLagSec: 0 });
      };
      // Each published lot gets its own post (postLot + watchPost). Existing posts are only read
      // when the seller names them; useLatestPosts picks the newest ones instead.
      if (wantFb && (show.fbPostId || show.useLatestPosts)) {
        const post = show.fbPostId ? { id: show.fbPostId } : await latestPagePost(graph, { pageId: m.pageId, token: m.pageToken }).catch((err) => { log('error', 'could not find a Page post', err); return null; });
        if (post) {
          state.fbPostId = post.id;
          onInfo({ fbPostId: post.id, fbPostUrl: post.permalink_url || null });
          log('info', `Selling on Facebook post ${post.id}${post.message ? ` ("${post.message.slice(0, 40)}")` : ''}`);
          fb = startFbComments({ graph, liveVideoId: post.id, token: m.pageToken, pollMs: m.fbPollMs, onComment: fresh, log, fetchImpl, pollOnly: true });
        }
      }
      if (wantIg && (show.igMediaId || show.useLatestPosts)) {
        const media = show.igMediaId ? { id: show.igMediaId } : await latestIgMedia(graph, { igUserId: m.igUserId, token: m.igToken }).catch((err) => { log('error', 'could not find an Instagram post', err); return null; });
        if (media) {
          state.igMediaId = media.id;
          onInfo({ igMediaId: media.id, igPostUrl: media.permalink || null });
          log('info', `Selling on Instagram post ${media.id}${media.caption ? ` ("${media.caption.slice(0, 40)}")` : ''}`);
          ig = startIgMediaPoll({ graph, mediaId: media.id, token: m.igToken, pollMs: m.igPollMs, onComment: fresh, log });
        }
      }
      return { fb: Boolean(wantFb), ig: Boolean(wantIg), mode: 'post' };
    }

    if (wantFb) {
      const attach = (id) => {
        state.fbLiveVideoId = id;
        onInfo({ fbLiveVideoId: id });
        fb = startFbComments({ graph, liveVideoId: id, token: m.pageToken, rate: m.commentRate, pollMs: m.fbPollMs, onComment, log, fetchImpl });
      };
      if (show.fbLiveVideoId) attach(show.fbLiveVideoId);
      else {
        // You can press Start before OBS is live; keep looking for up to 10 minutes.
        const t0 = Date.now();
        const look = async () => {
          try {
            const v = await findCurrentLiveVideo(graph, { pageId: m.pageId, token: m.pageToken });
            if (v) { log('info', `FB Live found: ${v.id} ${v.title || ''}`); attach(v.id); return; }
          } catch (err) {
            log('warn', `find FB live failed: ${err.message}`);
          }
          if (Date.now() - t0 < 10 * 60e3) findTimer = setTimeout(look, 5000);
          else log('warn', 'No FB Live found after 10 min; set the live video ID manually');
        };
        look();
      }
    }
    if (wantIg) {
      ig = startIgLivePoll({
        graph, igUserId: m.igUserId, token: m.igToken, pollMs: m.igPollMs, onComment, log,
        onMedia: (id) => { state.igMediaId = id; onInfo({ igMediaId: id }); },
      });
    }
    return { fb: Boolean(wantFb), ig: Boolean(wantIg) };
  }

  function stop() {
    clearTimeout(findTimer);
    fb?.stop();
    ig?.stop();
    fb = null;
    ig = null;
    for (const w of watchers.values()) w.stop();
    watchers.clear();
    newestWatch = null;
  }

  /** Subscribe the Page to this app's webhook (feed = comments, messages = 24h window). Needs pages_manage_metadata. */
  async function subscribePage() {
    await graph.post(`/${m.pageId}/subscribed_apps`, { token: m.pageToken, body: { subscribed_fields: ['feed', 'messages'] }, purpose: 'subscribe Page to webhooks' });
    log('info', 'Page subscribed to webhooks (feed, messages)');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Post mode: publish a lot as a Page photo post and an Instagram post. Needs pages_manage_posts / instagram_content_publish. */
  async function postLot(lot, { imageUrl, caption, platforms = ['facebook', 'instagram'] }) {
    const out = {};
    if (platforms.includes('facebook') && m.pageId && m.pageToken) {
      try {
        let id;
        if (imageUrl) {
          const r = await graph.post(`/${m.pageId}/photos`, { token: m.pageToken, body: { url: imageUrl, caption, published: true }, purpose: `post Lot ${lot.lotNumber} to the Page` });
          id = r.post_id || r.id;
        } else {
          const r = await graph.post(`/${m.pageId}/feed`, { token: m.pageToken, body: { message: caption }, purpose: `post Lot ${lot.lotNumber} to the Page` });
          id = r.id;
        }
        const info = await graph.get(`/${id}`, { token: m.pageToken, params: { fields: 'permalink_url' } }).catch(() => ({}));
        out.facebook = { id, url: info.permalink_url || null };
      } catch (err) {
        out.facebook = { error: err.message };
      }
    }
    if (platforms.includes('instagram') && m.igUserId && m.igToken) {
      if (!imageUrl) out.instagram = { error: 'Instagram posts need a photo' };
      else {
        try {
          const c = await graph.post(`/${m.igUserId}/media`, { token: m.igToken, body: { image_url: imageUrl, caption }, purpose: `create Instagram post for Lot ${lot.lotNumber}` });
          let mediaId = null;
          for (let i = 0; i < 12 && !mediaId; i++) {
            try {
              const p = await graph.post(`/${m.igUserId}/media_publish`, { token: m.igToken, body: { creation_id: c.id }, purpose: `publish Lot ${lot.lotNumber} on Instagram` });
              mediaId = p.id;
            } catch (err) {
              // The container needs a few seconds to process the image (#9007 / 2207027 "not ready").
              if (i === 11 || !/9007|2207027|not ready|not available/i.test(err.message)) throw err;
              await sleep(1500);
            }
          }
          const info = await graph.get(`/${mediaId}`, { token: m.igToken, params: { fields: 'permalink' } }).catch(() => ({}));
          out.instagram = { id: mediaId, url: info.permalink || null };
        } catch (err) {
          out.instagram = { error: err.message };
        }
      }
    }
    return out;
  }

  /** Read comments on a lot's own post. Webhooks deliver FB comments instantly; this poll is the backstop. */
  function watchPost({ platform: p, id, lotId, since }) {
    const key = `${p}:${id}`;
    if (watchers.has(key) || !onCommentRef) return;
    newestWatch = lotId;
    // The newest lot's posts are checked every 5 s, older ones every 20 s (Graph API rate limits).
    const interval = () => (newestWatch === lotId ? 5000 : 20000);
    const tag = (c) => {
      if (since && c.at < since - 60e3) return;
      onCommentRef({ ...c, viewerLagSec: 0, lotId });
    };
    const w = p === 'instagram'
      ? startIgMediaPoll({ graph, mediaId: id, token: m.igToken, pollMs: interval, onComment: tag, log })
      : startFbComments({ graph, liveVideoId: id, token: m.pageToken, pollMs: interval, onComment: tag, log, fetchImpl, pollOnly: true });
    watchers.set(key, w);
  }

  function buttonMessage(text, url, title) {
    return { attachment: { type: 'template', payload: { template_type: 'button', text: text.slice(0, 640), buttons: [{ type: 'web_url', url, title: title.slice(0, 20) }] } } };
  }

  // One private reply per comment (FB: within 7 days; IG Live: only while the broadcast is live).
  async function privateReply({ platform, commentId, text, url, buttonTitle = 'Pay now' }) {
    if (platform === 'instagram') {
      const message = { text: url ? `${text}\n${url}` : text };
      try {
        const r = await graph.post(`/${m.igUserId}/messages`, { token: m.igToken, body: { recipient: { comment_id: commentId }, message }, purpose: 'IG private reply' });
        return { ok: true, recipientId: r.recipient_id, messageId: r.message_id };
      } catch (err) {
        // Facebook-Login IG messaging is also reachable through the Page node.
        const r = await graph.post(`/${m.pageId || 'me'}/messages`, { token: m.pageToken || m.igToken, body: { recipient: { comment_id: commentId }, message }, purpose: 'IG private reply (page node)' });
        return { ok: true, recipientId: r.recipient_id, messageId: r.message_id, note: err.message };
      }
    }
    const send = (message, purpose) => graph.post(`/${m.pageId}/messages`, { token: m.pageToken, body: { recipient: { comment_id: commentId }, message }, purpose });
    if (url && m.useButtonTemplate) {
      try {
        const r = await send(buttonMessage(text, url, buttonTitle), 'FB private reply (button)');
        return { ok: true, recipientId: r.recipient_id, messageId: r.message_id };
      } catch (err) {
        // #10900 = already replied; don't retry that one.
        if (err.code === 10900 || /already/i.test(err.message)) throw err;
        log('warn', `button template rejected, sending text: ${err.message}`);
      }
    }
    const r = await send({ text: url ? `${text}\n${url}` : text }, 'FB private reply');
    return { ok: true, recipientId: r.recipient_id, messageId: r.message_id };
  }

  async function publicReply({ platform, commentId, text }) {
    if (platform === 'instagram') {
      await graph.post(`/${commentId}/replies`, { token: m.igToken, params: { message: text }, purpose: 'IG public reply' });
    } else {
      await graph.post(`/${commentId}/comments`, { token: m.pageToken, params: { message: text }, purpose: 'FB public reply' });
    }
    return { ok: true };
  }

  // Inside the 24h window after the buyer messages us.
  async function sendMessage({ platform, psid, text, url, buttonTitle = 'Pay now' }) {
    const node = platform === 'instagram' ? m.igUserId : m.pageId;
    const token = platform === 'instagram' ? m.igToken : m.pageToken;
    const message = url && platform === 'facebook' && m.useButtonTemplate ? buttonMessage(text, url, buttonTitle) : { text: url ? `${text}\n${url}` : text };
    const r = await graph.post(`/${node}/messages`, { token, body: { recipient: { id: psid }, messaging_type: 'RESPONSE', message }, purpose: `${platform} message (24h window)` });
    return { ok: true, messageId: r.message_id };
  }

  async function check() {
    const out = {};
    if (m.pageId && m.pageToken) {
      try {
        const p = await graph.get(`/${m.pageId}`, { token: m.pageToken, params: { fields: 'id,name' }, purpose: 'check page token' });
        out.page = p.name;
      } catch (err) { out.pageError = err.message; }
    }
    if (m.igUserId && m.igToken) {
      try {
        const u = await graph.get(`/${m.igUserId}`, { token: m.igToken, params: { fields: 'id,username' }, purpose: 'check IG account' });
        out.instagram = `@${u.username}`;
      } catch (err) { out.igError = err.message; }
    }
    return out;
  }

  return { kind: 'meta', start, stop, privateReply, publicReply, sendMessage, postLot, watchPost, check, state: () => ({ ...state, fbMode: fb?.mode?.() || null, watching: watchers.size }) };
}
