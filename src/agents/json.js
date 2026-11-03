// Models without a JSON mode (Spark Open on Baseten) sometimes wrap JSON in prose or
// ```fences```, or add trailing commas. Pull out the first balanced object and parse it.
export function extractJson(text) {
  if (text === null || text === undefined) throw new Error('empty model output');
  if (typeof text === 'object') return text;
  let t = String(text).trim();
  if (!t) throw new Error('empty model output');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON in model output: ${t.slice(0, 80)}`);
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      const raw = t.slice(start, i + 1);
      try {
        return JSON.parse(raw);
      } catch {
        return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
      }
    }
  }
  throw new Error('unbalanced JSON in model output');
}
