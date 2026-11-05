// Facebook Page Live comments.
//  - Find the live video ID (not the post ID): GET /{page-id}/live_videos?broadcast_status=["LIVE"]
//  - Stream: GET streaming-graph.facebook.com/{live-video-id}/live_comments (Server-Sent Events)
//  - Fallback: poll GET /{live-video-id}/comments

export function normalizeFbComment(c, liveId) {
  return {
    id: c.id,
    platform: 'facebook',
    from: c.from ? { id: c.from.id, name: c.from.name } : { id: `anon-${c.id}`, name: 'Facebook viewer', anonymous: true },
    text: c.message || '',
    at: c.created_time ? Date.parse(c.created_time) || Date.now() : Date.now(),
    liveId,
    receivedAt: Date.now(),
  };
}

/** Most recent post on the Page (used when selling on a post without giving its ID). */
export async function latestPagePost(graph, { pageId, token }) {
  const r = await graph.get(`/${pageId}/posts`, { token, params: { limit: '1', fields: 'id,message,created_time,permalink_url' }, purpose: 'find latest Page post' });
  return r.data?.[0] || null;
}

export async function findCurrentLiveVideo(graph, { pageId, token }) {
  const r = await graph.get(`/${pageId}/live_videos`, {
    token,
    params: { broadcast_status: '["LIVE"]', fields: 'id,status,title,permalink_url,creation_time' },
    purpose: 'find current FB live video',
  });
  return r.data?.[0] || null;
}

/** Parse an SSE byte stream into JSON payloads. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { yield JSON.parse(data); } catch { /* keep-alive or partial */ }
    }
  }
}

export function startFbComments({ graph, liveVideoId, token, rate = 'ten_per_second', pollMs = 2000, onComment, onGone = null, log, fetchImpl = fetch, pollOnly = false }) {
  let stopped = false;
  let missing = 0;
  // Ordinary Page posts have no live_comments stream: poll their comments edge instead.
  let mode = pollOnly ? 'poll' : 'stream';
  const seen = new Set();
  const emit = (c) => {
    if (!c?.id || seen.has(c.id)) return;
    seen.add(c.id);
    onComment(normalizeFbComment(c, liveVideoId));
  };
  let ctrl = null;
  let pollTimer = null;

  async function stream() {
    let failures = 0;
    while (!stopped && mode === 'stream') {
      ctrl = new AbortController();
      try {
        const qs = new URLSearchParams({ access_token: token, comment_rate: rate, fields: 'from{name,id},message,created_time,id' });
        const res = await fetchImpl(`https://streaming-graph.facebook.com/${liveVideoId}/live_comments?${qs}`, {
          headers: { Accept: 'text/event-stream' }, signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`live_comments SSE ${res.status} ${(await res.text()).slice(0, 160)}`);
        log('info', `FB live_comments stream connected for ${liveVideoId}`);
        failures = 0;
        for await (const evt of sseEvents(res.body)) {
          if (stopped) break;
          emit(evt);
        }
      } catch (err) {
        if (stopped) return;
        failures++;
        log('warn', `FB SSE dropped (${failures}): ${err.message}`);
        if (failures >= 3) {
          mode = 'poll';
          log('warn', 'FB comments: switching to polling');
          poll();
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * failures));
      }
    }
  }

  async function poll() {
    if (stopped) return;
    try {
      const r = await graph.get(`/${liveVideoId}/comments`, {
        token,
        params: { order: 'reverse_chronological', filter: 'stream', live_filter: 'no_filter', fields: 'id,message,from{id,name},created_time', limit: '50' },
      });
      for (const c of (r.data || []).reverse()) emit(c);
      missing = 0;
    } catch (err) {
      // Graph's answer for a deleted post (#100/33). Twice in a row, so one odd reply can't take an item off sale.
      if (onGone && err.code === 100 && err.subcode === 33 && ++missing >= 2) {
        stopped = true;
        onGone();
        return;
      }
      log('warn', `FB comment poll failed: ${err.message}`);
    }
    if (stopped) return;
    pollTimer = setTimeout(poll, typeof pollMs === 'function' ? pollMs() : pollMs);
  }

  if (pollOnly) poll();
  else stream();
  // Belt and braces: a slow poll runs alongside the stream to catch anything SSE missed.
  const safety = setInterval(() => { if (mode === 'stream') pollOnce(); }, 10000);
  async function pollOnce() {
    try {
      const r = await graph.get(`/${liveVideoId}/comments`, { token, params: { order: 'reverse_chronological', filter: 'stream', fields: 'id,message,from{id,name},created_time', limit: '25' } });
      for (const c of (r.data || []).reverse()) emit(c);
    } catch { /* stream is primary */ }
  }

  return {
    mode: () => mode,
    stop() {
      stopped = true;
      ctrl?.abort();
      clearTimeout(pollTimer);
      clearInterval(safety);
    },
  };
}
