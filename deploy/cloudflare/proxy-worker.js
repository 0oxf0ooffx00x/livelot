// Puts LiveLot (Cloud Run, europe-west2) on livelot.stream. Cloud Run only answers to its own
// *.run.app host, and custom domain mappings aren't offered in europe-west2, so this Worker
// forwards every request unchanged (streaming bodies, SSE, redirects, webhook signatures intact).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    return fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
  },
};
