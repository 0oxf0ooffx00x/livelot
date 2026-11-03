import { outputText, dataUrl } from './metaClient.js';
import { extractJson } from '../agents/json.js';
import * as P from './prompts.js';

// Muse Spark 1.3 via the Responses API (POST /v1/responses).
// Reasoning effort matters a lot for latency (measured 31 Oct 2026, classify prompt):
// default 3.5-14 s, low 2.3-3.3 s, minimal 1.2-2.3 s with the same verdicts.
const FAST = process.env.SPARK_EFFORT_FAST || 'minimal';
const SLOW = process.env.SPARK_EFFORT || 'low';

export function createSpark({ client, model }) {
  async function ask({ text, image, purpose, timeout, effort = SLOW, search = false }) {
    const content = [{ type: 'input_text', text }];
    if (image) content.push({ type: 'input_image', image_url: Buffer.isBuffer(image) ? dataUrl(image) : image });
    const data = await client.request('/responses', {
      json: {
        model,
        input: [{ role: 'user', content }],
        ...(effort && effort !== 'default' ? { reasoning: { effort } } : {}),
        // Search grounding: Muse Spark decides what to look up and cites what it used.
        ...(search ? { tools: [{ type: 'web_search', search_context_size: 'low' }], include: ['web_search_call.results'] } : {}),
      },
      model, purpose, timeout,
    });
    // With web search the reply can come in several messages ("I'll search…", then the answer): use the last.
    const messages = (data.output || []).filter((o) => o.type === 'message');
    const out = search && messages.length ? outputText({ output: [messages[messages.length - 1]] }) : outputText(data);
    if (!out) throw new Error(`${model}: empty output`);
    const searches = (data.output || []).filter((o) => o.type === 'web_search_call').map((w) => w.action?.query).filter(Boolean);
    return { json: extractJson(out), ms: data.__ms, searches };
  }

  return {
    name: model,
    glance: (frame, said = '', { photo = false } = {}) => ask({ text: photo ? P.GLANCE_PHOTO(said) : P.GLANCE(said), image: frame, purpose: photo ? 'glance: what is in the photo?' : 'glance: what is being held?' }),
    listing: (ctx, image) => ask({ text: P.LISTING(ctx), image, purpose: 'draft listing from speech + image' }),
    research: (ctx, image) => ask({ text: P.RESEARCH(ctx), image, purpose: 'web search: identify the product, write the description', timeout: 45000, search: true }),
    classify: (ctx, timeout) => ask({ text: P.CLASSIFY(ctx), purpose: 'classify comment', timeout, effort: FAST }),
    match: (ctx) => ask({ text: P.MATCH(ctx), purpose: 'match descriptive comment to lot', timeout: 6000, effort: FAST }),
    recap: (ctx) => ask({ text: P.RECAP(ctx), purpose: 'post-show recap' }),
  };
}
