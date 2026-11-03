import { outputText } from './metaClient.js';
import { extractJson } from '../agents/json.js';
import * as P from './prompts.js';

// Muse Spark Open (open weights) on Baseten Model APIs, via /v1/chat/completions.
// No JSON mode, so we prompt for JSON and parse defensively. Empty content with
// finish_reason=length has been reported, so we use a generous max_tokens and throw on empty.
export function createSparkOpen({ client, model }) {
  async function ask({ text, purpose, timeout }) {
    const data = await client.request('/chat/completions', {
      json: {
        model,
        messages: [
          { role: 'system', content: 'You are a precise classifier. Reply with a single JSON object and nothing else.' },
          { role: 'user', content: text },
        ],
        max_tokens: 2048,
        temperature: 0,
        reasoning_effort: 'low',
      },
      model, purpose, timeout,
    });
    const out = outputText(data);
    if (!out) throw new Error(`${model}: empty content (finish_reason=${data.choices?.[0]?.finish_reason})`);
    return { json: extractJson(out), ms: data.__ms };
  }
  return {
    name: model,
    classify: (ctx, timeout) => ask({ text: P.CLASSIFY(ctx), purpose: 'classify comment (open weights)', timeout }),
    match: (ctx) => ask({ text: P.MATCH(ctx), purpose: 'match descriptive comment (open weights)', timeout: 6000 }),
  };
}
