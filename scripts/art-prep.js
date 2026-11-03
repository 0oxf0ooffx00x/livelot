// Turns a generated image (ChatGPT, Gemini…) into a UI-ready icon:
//   - keeps real transparency; otherwise removes a flat background (white, any solid colour, or a fake
//     "transparency" checkerboard) by flood-filling from the edges, with soft anti-aliased edges
//   - trims to the subject, centres it on a square and saves public/art/<name>.webp (512 px)
// CLI: node scripts/art-prep.js            -> process every file in art/raw/
//      node scripts/art-prep.js home-posts -> just that one
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_DIR = path.join(ROOT, 'art', 'raw');
export const OUT_DIR = path.join(ROOT, 'public', 'art');
const SIZE = 512;
const PAD = 0.03;

const dist = (r, g, b, c) => Math.sqrt((r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2);

/** The one or two colours that make up the border (two = a baked-in checkerboard). */
function borderColours(px, w, h) {
  const counts = new Map();
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
    const e = counts.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += px[i]; e.g += px[i + 1]; e.b += px[i + 2];
    counts.set(k, e);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); add(x, 1); add(x, h - 2); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); add(1, y); add(w - 2, y); }
  const total = [...counts.values()].reduce((a, e) => a + e.n, 0);
  const top = [...counts.values()].sort((a, b) => b.n - a.n);
  // Merge neighbouring buckets into the leaders.
  const leaders = [];
  for (const e of top) {
    const c = [e.r / e.n, e.g / e.n, e.b / e.n];
    const near = leaders.find((l) => dist(...c, l.c) < 26);
    if (near) near.n += e.n;
    else if (leaders.length < 2) leaders.push({ c, n: e.n });
  }
  const covered = leaders.reduce((a, l) => a + l.n, 0) / total;
  return { colours: leaders.filter((l) => l.n / total > 0.08).map((l) => l.c), covered };
}

export async function prepArt(input) {
  let img = sharp(input).rotate().ensureAlpha();
  const meta = await img.metadata();
  if (Math.max(meta.width, meta.height) > 1200) img = img.resize(1200, 1200, { fit: 'inside' });
  const { data: px, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;

  // Already transparent around the edges? Trust it.
  let clearEdge = 0;
  let edgeCount = 0;
  for (let x = 0; x < w; x += 2) for (const y of [0, h - 1]) { edgeCount++; if (px[(y * w + x) * 4 + 3] < 200) clearEdge++; }
  for (let y = 0; y < h; y += 2) for (const x of [0, w - 1]) { edgeCount++; if (px[(y * w + x) * 4 + 3] < 200) clearEdge++; }
  let method = 'transparent';
  if (clearEdge / edgeCount < 0.6) {
    const { colours, covered } = borderColours(px, w, h);
    if (!colours.length || covered < 0.75) {
      method = 'kept-background';
    } else {
      method = colours.length > 1 ? 'checkerboard-removed' : 'background-removed';
      const T1 = 30; // definitely background
      const T2 = 72; // definitely subject; in between = soft edge
      const near = (i) => Math.min(...colours.map((c) => dist(px[i], px[i + 1], px[i + 2], c)));
      const bg = new Uint8Array(n); // 1 = background
      const queue = new Int32Array(n);
      let qh = 0;
      let qt = 0;
      const seed = (p) => { if (!bg[p] && near(p * 4) < T1) { bg[p] = 1; queue[qt++] = p; } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (qh < qt) {
        const p = queue[qh++];
        const x = p % w;
        if (x > 0) seed(p - 1);
        if (x < w - 1) seed(p + 1);
        if (p >= w) seed(p - w);
        if (p < n - w) seed(p + w);
      }
      // Background trapped inside the subject (the gap in a coat hanger, inside a string loop): flat,
      // untextured patches of the background colour. Paper's own light parts are textured cream, so
      // they don't qualify.
      const seen = new Uint8Array(n);
      for (let s = 0; s < n; s++) {
        if (bg[s] || seen[s] || near(s * 4) >= 14) continue;
        const members = [s];
        seen[s] = 1;
        let sum = 0;
        for (let k = 0; k < members.length; k++) {
          const p = members[k];
          sum += near(p * 4);
          const x = p % w;
          for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
            if (q < 0 || q >= n || seen[q] || bg[q] || near(q * 4) >= 14) continue;
            seen[q] = 1;
            members.push(q);
          }
        }
        if (members.length > n * 0.001 && sum / members.length < 7) for (const p of members) bg[p] = 1;
      }
      for (let p = 0; p < n; p++) {
        const i = p * 4;
        if (bg[p]) { px[i + 3] = 0; continue; }
        // Soft edge: only for subject pixels touching the removed background.
        const x = p % w;
        const touches = (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (p >= w && bg[p - w]) || (p < n - w && bg[p + w]);
        if (!touches) continue;
        const d = near(i);
        if (d < T2) {
          const a = Math.max(0, Math.min(1, (d - T1) / (T2 - T1)));
          // Pull the background colour out of the edge so it doesn't leave a pale fringe.
          const c = colours[0];
          if (a > 0.05) for (let k = 0; k < 3; k++) px[i + k] = Math.max(0, Math.min(255, Math.round((px[i + k] - (1 - a) * c[k]) / a)));
          px[i + 3] = Math.round(px[i + 3] * a);
        }
      }
    }
  }

  // Trim to the subject.
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error('The image is empty after removing the background');
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const inner = Math.round(SIZE * (1 - PAD * 2));
  const subject = await sharp(px, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: x0, top: y0, width: cw, height: ch })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const webp = await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: subject, gravity: 'center' }])
    .webp({ quality: 86, alphaQuality: 92, effort: 5 })
    .toBuffer();
  return { webp, method, source: { width: meta.width, height: meta.height } };
}

export async function prepFile(name, buf) {
  const out = await prepArt(buf);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, `${name}.webp`), out.webp);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const only = process.argv[2];
  const files = (await readdir(RAW_DIR).catch(() => [])).filter((f) => /\.(png|jpe?g|webp|avif)$/i.test(f));
  for (const f of files) {
    const name = f.replace(/\.[^.]+$/, '');
    if (only && name !== only) continue;
    try {
      const r = await prepFile(name, await readFile(path.join(RAW_DIR, f)));
      console.log(`${name}: ${r.method}, ${Math.round(r.webp.length / 1024)} KB`);
    } catch (err) {
      console.error(`${name}: ${err.message}`);
    }
  }
}
