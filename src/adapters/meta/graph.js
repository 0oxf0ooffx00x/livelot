// Minimal Graph API client (graph.facebook.com). Tokens go in the query string, as Graph expects.
export class GraphError extends Error {
  constructor(msg, { status, code, subcode, body } = {}) {
    super(msg);
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.body = body;
  }
}

export function createGraph({ version = 'v24.0', fetchImpl = fetch, trace = () => {} }) {
  const base = `https://graph.facebook.com/${version}`;
  async function call(method, path, { token, params = {}, body, purpose } = {}) {
    const t0 = Date.now();
    const qs = new URLSearchParams({ ...params, ...(token ? { access_token: token } : {}) });
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ''}`;
    let res;
    let data;
    try {
      res = await fetchImpl(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      trace({ model: 'graph-api', purpose, ms: Date.now() - t0, ok: false, summary: err.message });
      throw new GraphError(`Graph ${method} ${path}: ${err.message}`);
    }
    if (!res.ok || data.error) {
      const e = data.error || {};
      trace({ model: 'graph-api', purpose, ms: Date.now() - t0, ok: false, summary: `${res.status} #${e.code} ${e.message?.slice(0, 80) || ''}` });
      throw new GraphError(`Graph ${method} ${path}: ${res.status} #${e.code}/${e.error_subcode || '-'} ${e.message || ''}`, {
        status: res.status, code: e.code, subcode: e.error_subcode, body: data,
      });
    }
    if (purpose) trace({ model: 'graph-api', purpose, ms: Date.now() - t0, ok: true, summary: `${method} ${path}` });
    return data;
  }
  return {
    base,
    get: (path, opts) => call('GET', path, opts),
    post: (path, opts) => call('POST', path, opts),
    del: (path, opts) => call('DELETE', path, opts),
  };
}
