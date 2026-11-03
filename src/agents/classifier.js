import { normalizeSize } from '../domain/variants.js';

// Comment classification. A deterministic regex classifier runs on every comment; the model
// chain (Muse Spark Open on Baseten -> Muse Spark 1.3 -> regex) refines it within a time budget.

const CLAIM_RE = /\b(sold|s0ld|mine|i'?ll take|i will take|take (it|this|that|one|them|both)|want (it|this|that|one|them|both)|i want|i need|dibs|claim(ed)?|buy(ing)? (it|this|that|one)|i'?ll buy|me please|yes please|gimme|give me|reserve (it|this|one|for me)|i'?m in)\b|🙋|✋|🙌|🛒|💸/i;
const NEGATIVE_RE = /\b(sold out|already sold|is (it|this|that) sold|was sold|sold yet|has (it|that|this) sold|how much|what size|what sizes|still available|is it available|does it|do you|can you|ship(ping)? to|what'?s the price|price\?|not mine|don'?t want|no thanks|missed (it|out))\b/i;
const LOT_RE = /\b(?:lot|item|no\.?|number|num)\s*#?\s*(\d{1,3})\b|#\s*(\d{1,3})\b/i;
const SIZE_RE = /\b(?:size|sz|in (?:a |an |size )?)\s*(extra[\s-]small|extra[\s-]large|x[\s-]?small|x[\s-]?large|xx?s|xx?l|xxxl|2xl|small|medium|large|[sml]|\d{1,2}(?:\.5)?)\b/i;
const LOOSE_SIZE_RE = /\b(extra[\s-]small|extra[\s-]large|xx?s|xxxl|xx?l|2xl|small|medium|large)\b/i;
const SINGLE_LETTER_RE = /(?:^|\s)([SML])(?=$|[\s!.,])/;
const QTY_RE = /\b(?:x\s?(\d)|(\d)\s?x|(two|three|four|five|2|3|4|5) of (?:them|these|those|those|em)|(both))\b/i;
const INTENT_HINT_RE = /\b(get|have|want|need|like|buy|take|grab|reserve|hold|keep|pay|order|mine|me)\b|\d|\?/i;
const DESC_RE = /\b(?:the|that|this)\s+((?:[a-z']+\s+){0,3}[a-z']+)/i;
const DESC_STOP = new Set(['one', 'it', 'lot', 'size', 'last', 'first', 'next', 'price', 'item', 'thing', 'same']);
const QTY_WORDS = { two: 2, three: 3, four: 4, five: 5, both: 2 };

export function regexClassify(text) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  const res = { isClaim: false, confidence: 0.85, lotNumber: null, size: null, qty: 1, description: null, bareNumber: null, source: 'regex' };
  if (!t) return res;

  const claimWord = CLAIM_RE.test(t);
  const negative = NEGATIVE_RE.test(t);
  const question = /\?\s*$/.test(t) && !/\b(i'?ll take|mine|dibs|i want)\b/i.test(t);

  const lot = t.match(LOT_RE);
  if (lot) res.lotNumber = Number(lot[1] || lot[2]);

  const size = t.match(SIZE_RE) || t.match(LOOSE_SIZE_RE);
  if (size) res.size = normalizeSize(size[1]);
  else {
    const letter = t.match(SINGLE_LETTER_RE);
    if (letter && t.length < 40) res.size = normalizeSize(letter[1]);
  }

  const q = lower.match(QTY_RE);
  if (q) res.qty = Number(q[1] || q[2]) || QTY_WORDS[q[3] || q[4]] || Number(q[3]) || 1;

  // A bare number ("sold 10") could be a lot number or a size; the matcher decides.
  if (!res.lotNumber && !size) {
    const stripped = lower.replace(QTY_RE, ' ');
    const bare = stripped.match(/(?:^|\s)(\d{1,3}(?:\.5)?)(?=$|[\s!.,])/);
    if (bare) res.bareNumber = bare[1];
  }

  const d = lower.match(DESC_RE);
  if (d) {
    const words = d[1].replace(/\b(please|pls|plz|thanks|thx)\b/g, '').trim().split(/\s+/).filter(Boolean);
    while (words.length && /^(one|please)$/.test(words[words.length - 1]) && words.length > 1) words.pop();
    const phrase = words.join(' ');
    if (phrase && !DESC_STOP.has(phrase) && !/^\d/.test(phrase)) res.description = phrase;
  }

  if (claimWord && !negative && !question) {
    res.isClaim = true;
    res.confidence = 0.9;
  } else if (claimWord && (negative || question)) {
    res.isClaim = false;
    res.confidence = negative ? 0.85 : 0.55;
  } else if (!claimWord && (res.lotNumber || res.size) && !question && !negative && t.split(/\s+/).length <= 5) {
    // "lot 3 M please" / "size 10 please" - a claim with no claim word.
    res.isClaim = /\b(please|pls|plz|for me|me)\b|!/.test(lower);
    res.confidence = res.isClaim ? 0.7 : 0.6;
  }
  return res;
}

/** Map model JSON onto our shape and fill gaps from the regex result. */
export function mergeModel(json, rx, source) {
  const size = json.size ?? json.variant ?? null;
  const out = {
    isClaim: Boolean(json.is_claim ?? json.isClaim),
    confidence: clamp(Number(json.confidence ?? 0.7)),
    lotNumber: json.lot_number ?? json.lotNumber ?? rx.lotNumber ?? null,
    size: size ? normalizeSize(size) : rx.size,
    qty: Math.max(1, Math.min(10, Number(json.quantity ?? json.qty ?? rx.qty) || 1)),
    description: json.description || rx.description || null,
    bareNumber: rx.bareNumber,
    source,
  };
  if (out.lotNumber !== null) out.lotNumber = Number(out.lotNumber) || null;
  // A model may "helpfully" fill in the lot on screen. Only an explicitly written number counts,
  // because an explicit lot number overrides the stream-lag rule.
  if (out.lotNumber && out.lotNumber !== rx.lotNumber && !new RegExp(`(^|\\D)${out.lotNumber}(\\D|$)`).test(rx.text || '')) out.lotNumber = rx.lotNumber;
  return out;
}

export function isObviousClaim(text, rx) {
  const words = String(text).trim().split(/\s+/).length;
  return rx.isClaim && rx.confidence >= 0.9 && words <= 4 && !rx.description && !rx.bareNumber && !/\?/.test(text);
}

const clamp = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7);

/**
 * Build the classifier. `models` is an ordered list of { name, classify(ctx, timeout) }.
 * Returns the first model answer inside the time budget, else the regex result.
 */
export function createClassifier({ models = [], timeoutMs = 3500, log = () => {}, fastPath = process.env.CLASSIFY_FAST_PATH !== '0' }) {
  return async function classify(text, ctx = {}) {
    const rx = regexClassify(text);
    rx.text = text;
    // Obvious chatter ("love it", "hi from Leeds"): no claim word, no number, no question, no buying verb.
    // Anything with a hint of intent ("can I get the 10s?") goes to the model.
    if (!rx.isClaim && rx.confidence >= 0.85 && !CLAIM_RE.test(text) && !INTENT_HINT_RE.test(text) && !rx.lotNumber && !rx.size) return rx;
    // Obvious short claims ("sold!", "mine", "sold lot 3", "sold M"): answer instantly, so the pay
    // link goes out in under a second. The model reads everything ambiguous.
    if (fastPath && isObviousClaim(text, rx)) return { ...rx, source: 'rules (fast path)' };
    const deadline = Date.now() + timeoutMs;
    for (const m of models) {
      const left = deadline - Date.now();
      if (left < 400) break;
      try {
        const { json } = await m.classify({ text, ...ctx }, left);
        return mergeModel(json, rx, m.name);
      } catch (err) {
        log('warn', `classifier ${m.name} failed, falling back: ${err.message}`);
      }
    }
    return rx;
  };
}
