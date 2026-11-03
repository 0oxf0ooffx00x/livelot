import { wordsToNumber, NUMBER_WORDS } from './numbers.js';
import { normalizeSize } from '../domain/variants.js';

// Deterministic listing extraction from the seller's speech. Used as the fallback when
// Muse Spark is unavailable, and to cross-check the price Spark returns.

const PRICE_RES = [
  /[£$€]\s?(\d{1,5}(?:[.,]\d{1,2})?)/,
  new RegExp(`\\b(${NUMBER_WORDS})\\s*(?:pounds?|quid|bucks|dollars?|euros?)\\b`, 'i'),
  new RegExp(`\\b(?:for|at|price(?:d)?(?: is| at)?|just|only)\\s+(${NUMBER_WORDS})\\b(?!\\s*(?:of|in|sizes?|left|available))`, 'i'),
];
const SIZE_TOKEN = '(?:extra[\\s-]small|extra[\\s-]large|xx?s|xxxl|xx?l|small|medium|large|[sml]|\\d{1,2}(?:\\.5)?)';
const SIZES_RE = new RegExp(`\\bsizes?\\s+((?:${SIZE_TOKEN})(?:\\s*(?:,|and|&|or|\\s)\\s*(?:${SIZE_TOKEN})\\b)*)`, 'i');
const QTY_RE = new RegExp(`\\b(${NUMBER_WORDS})\\s+(?:of (?:these|them|those|each)|available|in stock|left|units?|pieces?|pairs?)\\b`, 'i');
const GOT_RE = new RegExp(`\\b(?:i'?ve got|i have|we'?ve got|we have|got)\\s+(${NUMBER_WORDS})\\b(?!\\s*(?:pounds?|quid|£))`, 'i');
const EACH_RE = new RegExp(`\\b(${NUMBER_WORDS})\\s+of each\\b|\\beach size\\s+(?:has\\s+)?(${NUMBER_WORDS})`, 'i');
const LEAD_RE = /^\s*(?:(?:okay|ok|right|so|now|and|next)[\s,]+)*(?:lot\s+\w+[\s,:-]+)?(?:(?:a|an|the|some|this|these)\s+)?([a-z][\w' -]{2,40}?)\s*(?=,|\.|\bsizes?\b|\bfor\b|\bat\b|£|\$|€)/i;
const TITLE_RE = /\b(?:this is|here'?s|we'?ve got|i'?ve got|next up(?: is| we have| we'?ve got)?|lot \w+(?: is)?)[\s,:-]+(?:a |an |the |some |this |these )?(?!(?:sizes?|one|two|three|four|five|\d)\b)(.{3,60}?)(?=\s*(?:,|\.|!|\bsize|\bfor\b|\bat\b|\bit'?s\b|\bin\b|£|\$|€|\bonly\b|$))/i;

export function parsePrice(text) {
  for (const re of PRICE_RES) {
    const m = String(text).match(re);
    if (m) {
      const n = wordsToNumber(m[1].replace(',', '.').trim());
      if (n !== null && n > 0 && n < 100000) return n;
    }
  }
  return null;
}

export function heuristicListing(transcript, hint = {}) {
  const text = String(transcript || '');
  const price = parsePrice(text);

  let variants = [];
  const sm = text.match(SIZES_RE);
  if (sm) {
    const parts = sm[1].split(/\s*(?:,|and|&|or)\s*|\s+/i).map((p) => p.trim()).filter(Boolean);
    const seen = new Set();
    for (const p of parts) {
      const k = normalizeSize(p);
      if (k && !seen.has(k)) { seen.add(k); variants.push({ label: p.length <= 3 ? p.toUpperCase() : p, qty: 1 }); }
    }
  }

  let quantity = 1;
  const q = text.match(QTY_RE) || text.match(GOT_RE);
  if (q) quantity = Math.max(1, Math.min(99, wordsToNumber(q[1]) || 1));
  const each = text.match(EACH_RE);
  if (each && variants.length) {
    const n = wordsToNumber(each[1] || each[2]) || 1;
    variants = variants.map((v) => ({ ...v, qty: n }));
  }

  // What the seller said or typed beats the generic vision noun; the vision label is the fallback.
  let title = '';
  const tm = text.match(TITLE_RE);
  if (tm && !/^(one|it|that|this)$/i.test(tm[1].trim())) title = tm[1].trim();
  else {
    const lead = text.match(LEAD_RE);
    const cand = lead?.[1]?.trim();
    const looksLikePrice = cand && (parsePrice(`${cand} pounds`) !== null || parsePrice(cand) !== null || /\b(pounds?|quid|bucks|dollars?|euros?)\b/i.test(cand));
    if (cand && cand.split(/\s+/).length <= 6 && !looksLikePrice) title = cand;
  }
  if (!title) title = hint.label || hint.noun || '';
  title = title.replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 60);

  const fields = [price !== null, variants.length > 0 || quantity > 1, Boolean(title)].filter(Boolean).length;
  return {
    title: title || 'New item',
    description: hint.label ? `${hint.label}${hint.colors?.length ? ` in ${hint.colors.join('/')}` : ''}.` : '',
    price,
    variants,
    quantity: variants.length ? variants.reduce((a, v) => a + v.qty, 0) : quantity,
    condition: /\bbrand new|new with tags|bnwt\b/i.test(text) ? 'new' : /\bused|worn|pre-?loved|vintage\b/i.test(text) ? 'used' : null,
    confidence: price !== null ? 0.5 + fields * 0.1 : 0.3,
    source: 'heuristic',
  };
}
