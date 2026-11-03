// Cuts the generated icon sheets (art/sheets/sheet-N.*) into single icons using art/manifest.json:
// remove the flat background, find each icon as a blob, order the blobs row by row, then clean and
// save each one as public/art/<name>.webp.  Run: npm run art:sheets  (or: node scripts/art-sheets.js 3)
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { prepFile, RAW_DIR } from './art-prep.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS = path.join(ROOT, 'art', 'sheets');
const manifest = JSON.parse(await readFile(path.join(ROOT, 'art', 'manifest.json'), 'utf8'));

/** Foreground mask: anything clearly different from the sheet's border colour. */
async function mask(buf) {
  const { data, info } = await sharp(buf).rotate().flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  // Border colour = median-ish of the outermost pixels.
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let x = 0; x < w; x += 3) for (const y of [0, h - 1]) { const i = (y * w + x) * 3; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  const bg = [r / n, g / n, b / n];
  const fg = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 3;
    if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 45) fg[p] = 1;
  }
  return { fg, w, h };
}

/** Blobs on a coarse grid (so one icon's separate parts merge), largest first. */
function blobs({ fg, w, h }) {
  const cell = Math.max(4, Math.round(Math.min(w, h) / 160));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const grid = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fg[y * w + x]) grid[Math.floor(y / cell) * gw + Math.floor(x / cell)]++;
  const on = new Uint8Array(gw * gh);
  const min = cell * cell * 0.04;
  // Dilate by 2 cells so gaps inside an icon (string, motion lines) don't split it.
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (grid[y * gw + x] <= min) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy; const xx = x + dx;
      if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) on[yy * gw + xx] = 1;
    }
  }
  const seen = new Int32Array(gw * gh).fill(-1);
  const out = [];
  for (let s = 0; s < gw * gh; s++) {
    if (!on[s] || seen[s] >= 0) continue;
    const id = out.length;
    const st = [s]; seen[s] = id;
    let x0 = gw; let y0 = gh; let x1 = 0; let y1 = 0; let mass = 0;
    while (st.length) {
      const p = st.pop();
      const x = p % gw; const y = (p / gw) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      mass += grid[p];
      for (const q of [p - 1, p + 1, p - gw, p + gw]) {
        if (q < 0 || q >= gw * gh || seen[q] >= 0 || !on[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === gw - 1)) continue;
        seen[q] = id; st.push(q);
      }
    }
    out.push({ x0: x0 * cell, y0: y0 * cell, x1: Math.min(w, (x1 + 1) * cell), y1: Math.min(h, (y1 + 1) * cell), mass });
  }
  return out.sort((a, b) => b.mass - a.mass);
}

async function cutSheet(sheet, file) {
  const buf = await readFile(file);
  const m = await mask(buf);
  const want = sheet.names.length;
  // Icons are laid out on a grid (3×2, or 2×2 for four). Every piece belongs to the cell its centre
  // falls in, so icons made of separate pieces (sound waves, motion lines, a bubble) stay whole.
  const cols = want === 4 ? 2 : 3;
  const rows = 2;
  const found = blobs(m);
  const total = found.reduce((a, b) => a + b.mass, 0);
  const cells = Array.from({ length: cols * rows }, () => null);
  for (const b of found) {
    if (b.mass < total * 0.002) continue; // specks
    const c = Math.min(cols - 1, Math.floor(((b.x0 + b.x1) / 2) / (m.w / cols)));
    const r = Math.min(rows - 1, Math.floor(((b.y0 + b.y1) / 2) / (m.h / rows)));
    const cur = cells[r * cols + c];
    cells[r * cols + c] = cur ? { x0: Math.min(cur.x0, b.x0), y0: Math.min(cur.y0, b.y0), x1: Math.max(cur.x1, b.x1), y1: Math.max(cur.y1, b.y1) } : { ...b };
  }
  const keep = cells.slice(0, want);
  if (keep.some((c) => !c)) throw new Error(`couldn't find an icon in every grid cell. Ask for a ${cols}×${rows} grid with wide gaps and save it again`);
  const src = sharp(buf).rotate();
  await mkdir(RAW_DIR, { recursive: true });
  const done = [];
  for (let i = 0; i < want; i++) {
    const b = keep[i];
    const pad = Math.round(Math.min(m.w, m.h) * 0.01);
    const left = Math.max(0, b.x0 - pad); const top = Math.max(0, b.y0 - pad);
    const width = Math.min(m.w, b.x1 + pad) - left; const height = Math.min(m.h, b.y1 + pad) - top;
    const piece = await src.clone().extract({ left, top, width, height }).png().toBuffer();
    const name = sheet.names[i];
    await writeFile(path.join(RAW_DIR, `${name}.png`), piece);
    const r = await prepFile(name, piece);
    done.push(`${name} (${r.method})`);
  }
  return done;
}

const only = process.argv[2] ? Number(process.argv[2]) : null;
const files = await readdir(SHEETS).catch(() => []);
for (const sheet of manifest.sheets) {
  if (only && sheet.n !== only) continue;
  const f = files.find((x) => new RegExp(`^sheet[-_ ]?${sheet.n}\\.(png|jpe?g|webp|avif)$`, 'i').test(x));
  if (!f) { console.log(`sheet-${sheet.n}: not there yet`); continue; }
  try {
    console.log(`sheet-${sheet.n}: ${(await cutSheet(sheet, path.join(SHEETS, f))).join(', ')}`);
  } catch (err) {
    console.error(`sheet-${sheet.n}: ${err.message}`);
  }
}
