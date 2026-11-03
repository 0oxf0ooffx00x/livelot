import { normalizeSize } from '../domain/variants.js';

// Which lot does a claim refer to? Rules, in order:
//  1. explicit "lot N"
//  2. a descriptive comment ("the blue mug") -> Muse Spark with recent lot cards
//  3. the lot that was on screen `lag` seconds before the comment (stream latency)
// Comments landing right on a lot change get low confidence and go to review.

export function lotOnScreenAt(lots, t) {
  let best = null;
  for (const l of lots) if (l.shownAt <= t && (!best || l.shownAt > best.shownAt || (l.shownAt === best.shownAt && l.lotNumber > best.lotNumber))) best = l;
  return best;
}

export function lotCard(l) {
  return {
    lotNumber: l.lotNumber, title: l.title, concept: l.concept, colors: l.colors || [],
    sizes: l.variants?.length > 1 ? l.variants.map((v) => v.label).join('/') : null,
  };
}

const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Cheap fallback for descriptive matching: word overlap with title + concept + colours. */
export function keywordMatch(description, lots) {
  const want = new Set(tokenize(description));
  let best = null;
  for (const l of lots) {
    const have = new Set([...tokenize(l.title), ...tokenize(l.concept), ...(l.colors || []).flatMap(tokenize)]);
    let hit = 0;
    for (const w of want) if (have.has(w) || have.has(w.replace(/s$/, ''))) hit++;
    const score = want.size ? hit / want.size : 0;
    if (score > 0 && (!best || score > best.score || (score === best.score && l.shownAt > best.lot.shownAt))) best = { lot: l, score };
  }
  return best ? { lot: best.lot, confidence: Math.min(0.85, 0.45 + best.score * 0.45), reason: `keywords matched "${description}"` } : null;
}

export function createMatcher({ lagSec = 8, boundarySec = 2, describe = null, log = () => {} }) {
  return async function match({ cls, at, viewerLagSec, lots, lotId = null }) {
    const shown = lots.filter((l) => l.status !== 'cancelled').sort((a, b) => a.shownAt - b.shownAt);
    const lag = (viewerLagSec ?? lagSec) * 1000;
    if (!shown.length) return { lot: null, confidence: 0, reason: 'no lots shown yet', size: cls.size };

    // Post mode: a comment on a lot's own post belongs to that lot, unless it names another lot.
    const onPost = lotId ? shown.find((l) => l.id === lotId) : null;
    if (onPost && (!cls.lotNumber || cls.lotNumber === onPost.lotNumber)) {
      return { lot: onPost, confidence: 0.97, reason: `comment on Lot ${onPost.lotNumber}'s post`, size: cls.size };
    }

    if (cls.lotNumber) {
      const lot = shown.find((l) => l.lotNumber === cls.lotNumber);
      return lot
        ? { lot, confidence: 0.97, reason: `said "lot ${cls.lotNumber}"`, size: cls.size }
        : { lot: null, confidence: 0.3, reason: `no lot ${cls.lotNumber}`, size: cls.size };
    }

    const seen = lotOnScreenAt(shown, at - lag) || shown[0];
    let size = cls.size;

    // "sold 10": size 10 of the lot on screen, or lot 10?
    if (cls.bareNumber && !size) {
      const n = normalizeSize(cls.bareNumber);
      if (seen.variants.some((v) => normalizeSize(v.key) === n)) size = n;
      else {
        const byNum = shown.find((l) => l.lotNumber === Number(cls.bareNumber));
        if (byNum) return { lot: byNum, confidence: 0.8, reason: `number ${cls.bareNumber} read as lot`, size };
      }
    }

    if (cls.description) {
      const recent = shown.slice(-8);
      // If the description plainly fits the lot on screen, no need to ask a model.
      const local = keywordMatch(cls.description, [seen]);
      if (local && local.confidence >= 0.8) return { ...local, size };
      if (describe) {
        try {
          const r = await describe({ text: cls.text || cls.description, description: cls.description, lots: recent.map(lotCard) });
          const lot = shown.find((l) => l.lotNumber === Number(r.lot_number));
          if (lot) return { lot, confidence: Number(r.confidence ?? 0.75), reason: r.reason || `model matched "${cls.description}"`, size, source: r.source };
        } catch (err) {
          log('warn', `descriptive match failed: ${err.message}`);
        }
      }
      const kw = keywordMatch(cls.description, recent);
      if (kw) return { ...kw, size };
    }

    // Lag rule with a boundary check.
    const viewerT = at - lag;
    const nearChange = lag > 0 && shown.some((l) => l !== shown[0] && Math.abs(l.shownAt - viewerT) < boundarySec * 1000);
    if (nearChange) return { lot: seen, confidence: 0.55, reason: 'comment landed on a lot change', size };
    return { lot: seen, confidence: 0.92, reason: lag ? `on screen ${Math.round(lag / 1000)}s before comment` : 'on screen', size };
  };
}
