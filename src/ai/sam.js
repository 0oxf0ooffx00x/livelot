import { outputText, dataUrl } from './metaClient.js';

// SAM 3.1 via /v1/responses: one short noun phrase per request, returns
// <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=<img w>;h=<img h>;c=<conf>|><|mask;...|> tokens, one line per frame
// (verified 31 Oct 2026: pixel coords, w/h are the image size, c is confidence).
export function createSam({ client, model }) {
  return {
    name: model,
    async segment(image, noun) {
      const data = await client.request('/responses', {
        json: {
          model,
          input: [{ role: 'user', content: [
            { type: 'input_image', image_url: Buffer.isBuffer(image) ? dataUrl(image) : image },
            { type: 'input_text', text: noun },
          ] }],
          metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
        },
        model, purpose: `segment "${noun}"`,
      });
      const boxes = parseSamBoxes(outputText(data) || JSON.stringify(data.output || ''));
      return { boxes, ms: data.__ms };
    },
  };
}

/** Parse SAM box tokens. Coordinates may be pixels or 0..1 normalised; both are returned. */
export function parseSamBoxes(text) {
  const out = [];
  if (!text) return out;
  const re = /<\|box;([^|]*)\|>/g;
  let m;
  while ((m = re.exec(text))) {
    const kv = {};
    for (const part of m[1].split(';')) {
      const [k, v] = part.split('=');
      if (k && v !== undefined) kv[k.trim()] = Number(v);
    }
    if ([kv.x1, kv.y1, kv.x2, kv.y2].some((n) => !Number.isFinite(n))) continue;
    const conf = kv.c ?? kv.score ?? kv.conf ?? kv.confidence ?? null;
    out.push({ x1: kv.x1, y1: kv.y1, x2: kv.x2, y2: kv.y2, w: kv.w ?? null, h: kv.h ?? null, confidence: conf });
  }
  return out;
}

/** Convert a SAM box to normalised 0..1 coords given the frame size. */
export function normalizeBox(box, width, height) {
  const isNorm = box.x2 <= 1.0001 && box.y2 <= 1.0001;
  const W = isNorm ? 1 : box.w && box.w > 1 && box.w >= box.x2 ? box.w : width;
  const H = isNorm ? 1 : box.h && box.h > 1 && box.h >= box.y2 ? box.h : height;
  const c = (v) => Math.min(1, Math.max(0, v));
  return { x1: c(box.x1 / W), y1: c(box.y1 / H), x2: c(box.x2 / W), y2: c(box.y2 / H), confidence: box.confidence };
}

export const boxArea = (b) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
