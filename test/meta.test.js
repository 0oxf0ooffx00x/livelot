import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetaPlatform } from '../src/adapters/meta/index.js';
import { startFbComments } from '../src/adapters/meta/fbLive.js';
import { GraphError } from '../src/adapters/meta/graph.js';
import { loadConfig } from '../src/config.js';

function fakeGraph(now) {
  const iso = (ms) => new Date(ms).toISOString();
  const routes = {
    '/PAGE/posts': { data: [{ id: 'PAGE_post1', message: 'Lot 1 jacket £15', permalink_url: 'https://fb/p1' }] },
    '/PAGE_post1/comments': { data: [
      { id: 'fc_new', message: 'sold!', from: { id: 'u1', name: 'Amy' }, created_time: iso(now + 1000) },
      { id: 'fc_old', message: 'sold', from: { id: 'u0', name: 'Old' }, created_time: iso(now - 3600e3) },
    ] },
    '/IG/media': { data: [{ id: 'm1', caption: 'Lot 1', permalink: 'https://ig/m1' }] },
    '/m1/comments': { data: [{ id: 'ic1', text: 'mine', username: 'bob', from: { id: 'ig9', username: 'bob' }, timestamp: iso(now + 2000) }] },
  };
  const calls = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname.replace(/^\/v[\d.]+/, '');
    calls.push(path);
    const body = routes[path] || { error: { code: 100, message: `no route ${path}` } };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('post mode reads comments on the latest Page post and Instagram post, skipping older comments', async () => {
  const now = Date.now();
  const cfg = loadConfig();
  cfg.meta = { ...cfg.meta, pageId: 'PAGE', pageToken: 't', igUserId: 'IG', igToken: 't', fbPollMs: 50, igPollMs: 50 };
  const { fetchImpl, calls } = fakeGraph(now);
  const platform = createMetaPlatform({ cfg, trace: () => {}, log: () => {}, fetchImpl });
  const got = [];
  const info = {};
  const r = await platform.start({ platforms: ['facebook', 'instagram'], mode: 'post', startedAt: now, useLatestPosts: true }, (c) => got.push(c), { onInfo: (i) => Object.assign(info, i) });
  await new Promise((res) => setTimeout(res, 120));
  platform.stop();
  assert.equal(r.mode, 'post');
  assert.equal(info.fbPostId, 'PAGE_post1');
  assert.equal(info.igMediaId, 'm1');
  assert.ok(!calls.some((p) => p.includes('live')), 'no live endpoints in post mode');
  const ids = [...new Set(got.map((c) => c.id))].sort();
  assert.deepEqual(ids, ['fc_new', 'ic1']);
  assert.ok(got.every((c) => c.viewerLagSec === 0));
  assert.equal(got.find((c) => c.id === 'ic1').from.name, '@bob');
});

test('postLot publishes a Page photo post and an Instagram post, retrying while the IG container is not ready', async () => {
  const cfg = loadConfig();
  cfg.meta = { ...cfg.meta, pageId: 'PAGE', pageToken: 't', igUserId: 'IG', igToken: 't' };
  let publishTries = 0;
  const bodies = {};
  const fetchImpl = async (url, opts) => {
    const path = new URL(url).pathname.replace(/^\/v[\d.]+/, '');
    if (opts.body) bodies[path] = JSON.parse(opts.body);
    let body;
    if (path === '/PAGE/photos') body = { id: 'photo1', post_id: 'PAGE_77' };
    else if (path === '/PAGE_77') body = { permalink_url: 'https://fb/77' };
    else if (path === '/IG/media') body = { id: 'container1' };
    else if (path === '/IG/media_publish') body = ++publishTries < 2 ? { error: { code: 9007, error_subcode: 2207027, message: 'Media ID is not available' } } : { id: 'igmedia1' };
    else if (path === '/igmedia1') body = { permalink: 'https://ig/p/1' };
    else body = { error: { code: 100, message: `no route ${path}` } };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
  };
  const platform = createMetaPlatform({ cfg, trace: () => {}, log: () => {}, fetchImpl });
  const r = await platform.postLot({ lotNumber: 3 }, { imageUrl: 'https://livelot.stream/media/x.jpg', caption: 'Lot 3: Mug', platforms: ['facebook', 'instagram'] });
  assert.deepEqual(r.facebook, { id: 'PAGE_77', url: 'https://fb/77' });
  assert.deepEqual(r.instagram, { id: 'igmedia1', url: 'https://ig/p/1' });
  assert.equal(publishTries, 2);
  assert.equal(bodies['/PAGE/photos'].url, 'https://livelot.stream/media/x.jpg');
  assert.equal(bodies['/IG/media'].caption, 'Lot 3: Mug');
});

test('a post deleted on Facebook is noticed after two "does not exist" answers, not one', async () => {
  const replies = [
    new GraphError('gone', { code: 100, subcode: 33 }), // one odd answer...
    { data: [] }, // ...then fine: still watching
    new GraphError('rate limit', { code: 4 }), // other errors never count
    new GraphError('gone', { code: 100, subcode: 33 }),
    new GraphError('gone', { code: 100, subcode: 33 }),
  ];
  let calls = 0;
  let gone = 0;
  const graph = { get: async () => { const r = replies[calls++]; if (r instanceof Error) throw r; return r; } };
  const w = startFbComments({ graph, liveVideoId: 'p1', token: 't', pollMs: 1, onComment: () => {}, onGone: () => { gone++; }, log: () => {}, pollOnly: true });
  await new Promise((r) => setTimeout(r, 80));
  w.stop();
  assert.equal(gone, 1);
  assert.equal(calls, 5); // and it stopped reading once the post was gone
});
