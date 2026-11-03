// Instagram Live comments. The comments/live_comments webhook needs Advanced Access (App Review),
// so in dev mode we poll GET /{ig-user-id}/live_media, which only returns media broadcasting now.

export function normalizeIgComment(c, mediaId) {
  const username = c.from?.username || c.username || 'instagram viewer';
  return {
    id: c.id,
    platform: 'instagram',
    from: { id: c.from?.id || `ig-${username}`, name: `@${username}`, username },
    text: c.text || '',
    at: c.timestamp ? Date.parse(c.timestamp) || Date.now() : Date.now(),
    liveId: mediaId,
    receivedAt: Date.now(),
  };
}

/** Most recent Instagram post (used when selling on a post without giving its ID). */
export async function latestIgMedia(graph, { igUserId, token }) {
  const r = await graph.get(`/${igUserId}/media`, { token, params: { limit: '1', fields: 'id,caption,timestamp,permalink,media_type' }, purpose: 'find latest Instagram post' });
  return r.data?.[0] || null;
}

/** Poll the comments of one Instagram post. Works for any professional account, no follower minimum. */
export function startIgMediaPoll({ graph, mediaId, token, pollMs = 2500, onComment, log }) {
  let stopped = false;
  let timer = null;
  let warned = false;
  const seen = new Set();
  async function tick() {
    if (stopped) return;
    try {
      const r = await graph.get(`/${mediaId}/comments`, { token, params: { fields: 'id,text,timestamp,username,from{id,username}', limit: '50' } });
      const comments = (r.data || []).slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      for (const c of comments) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        onComment(normalizeIgComment(c, mediaId));
      }
      warned = false;
    } catch (err) {
      if (!warned) log('warn', `IG comment poll failed: ${err.message}`);
      warned = true;
    }
    timer = setTimeout(tick, typeof pollMs === 'function' ? pollMs() : pollMs);
  }
  tick();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

export function startIgLivePoll({ graph, igUserId, token, pollMs = 2500, onComment, onMedia = () => {}, log }) {
  let stopped = false;
  let timer = null;
  let mediaId = null;
  const seen = new Set();
  let warned = false;

  async function tick() {
    if (stopped) return;
    try {
      const r = await graph.get(`/${igUserId}/live_media`, {
        token,
        params: { fields: 'id,media_type,media_product_type,timestamp,comments.limit(50){id,text,timestamp,username,from{id,username}}' },
      });
      const media = r.data?.[0];
      if (media && media.id !== mediaId) {
        mediaId = media.id;
        onMedia(mediaId);
        log('info', `IG Live detected: media ${mediaId}`);
      }
      for (const m of r.data || []) {
        const comments = (m.comments?.data || []).slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        for (const c of comments) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          onComment(normalizeIgComment(c, m.id));
        }
      }
      warned = false;
    } catch (err) {
      if (!warned) log('warn', `IG live_media poll failed: ${err.message}`);
      warned = true;
    }
    timer = setTimeout(tick, pollMs);
  }
  tick();
  return { stop() { stopped = true; clearTimeout(timer); }, mediaId: () => mediaId };
}
