// Thin fetch client for the Meta Model API (api.meta.ai/v1, OpenAI-compatible) and Baseten.
// Every call is reported to `trace` so the dashboard can show which Meta model did what, and how fast.

export class ModelError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function createModelClient({ baseUrl, apiKey, timeoutMs = 20000, fetchImpl = fetch, trace = () => {} }) {
  async function request(path, { method = 'POST', json, form, timeout = timeoutMs, model, purpose }) {
    const t0 = Date.now();
    const headers = { Authorization: `Bearer ${apiKey}` };
    let body;
    if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) body = form;
    let res;
    let text;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeout) });
      text = await res.text();
    } catch (err) {
      trace({ model, purpose, ms: Date.now() - t0, ok: false, summary: err.name === 'TimeoutError' ? 'timeout' : err.message });
      throw new ModelError(`${model || path}: ${err.message}`, { code: err.name });
    }
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const code = data?.error?.code || data?.error?.type || res.status;
      const msg = data?.error?.message || text.slice(0, 200);
      trace({ model, purpose, ms: Date.now() - t0, ok: false, summary: `${res.status} ${code}` });
      throw new ModelError(`${model || path}: ${res.status} ${code} ${msg}`, { status: res.status, code, body: data });
    }
    data.__ms = Date.now() - t0;
    return data;
  }

  return { request, baseUrl, hasKey: Boolean(apiKey) };
}

/** Pull the text out of a Responses-API or Chat-Completions-shaped payload. */
export function outputText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (typeof item?.text === 'string') parts.push(item.text);
      for (const c of item?.content || []) {
        if (typeof c?.text === 'string') parts.push(c.text);
        else if (typeof c?.output_text === 'string') parts.push(c.output_text);
      }
    }
    if (parts.length) return parts.join('\n');
  }
  const choice = data.choices?.[0];
  if (choice) {
    const content = choice.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c) => c.text || '').join('');
  }
  if (typeof data.text === 'string') return data.text;
  return '';
}

export const dataUrl = (buf, mime = 'image/jpeg') => `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
