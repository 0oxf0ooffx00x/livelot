// Crop the SAM box out of the frame (with a little padding) using sharp. If sharp isn't
// installed the full frame is used instead.
let sharpMod;
async function getSharp() {
  if (sharpMod === undefined) {
    try {
      sharpMod = (await import('sharp')).default;
    } catch {
      sharpMod = null;
    }
  }
  return sharpMod;
}

export async function imageSize(buf) {
  const sharp = await getSharp();
  if (!sharp) return { width: 1280, height: 720 };
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height };
}

export async function cropToBox(buf, box, { pad = 0.08, size = 800 } = {}) {
  const sharp = await getSharp();
  if (!sharp) return buf;
  const { width, height } = await sharp(buf).metadata();
  const bw = box.x2 - box.x1;
  const bh = box.y2 - box.y1;
  const x1 = Math.max(0, box.x1 - bw * pad);
  const y1 = Math.max(0, box.y1 - bh * pad);
  const x2 = Math.min(1, box.x2 + bw * pad);
  const y2 = Math.min(1, box.y2 + bh * pad);
  const left = Math.round(x1 * width);
  const top = Math.round(y1 * height);
  const w = Math.max(16, Math.round((x2 - x1) * width));
  const h = Math.max(16, Math.round((y2 - y1) * height));
  return sharp(buf)
    .extract({ left, top, width: Math.min(w, width - left), height: Math.min(h, height - top) })
    .resize(size, size, { fit: 'contain', background: { r: 245, g: 245, b: 245, alpha: 1 } })
    .jpeg({ quality: 88 })
    .toBuffer();
}

/** Muse Image returns WebP; WordPress wants the bytes to match the extension, so store JPEG. */
export async function toJpeg(buf) {
  const sharp = await getSharp();
  if (!sharp) return buf;
  return sharp(buf).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
}

/** Whole frame, letterboxed: used when the item wasn't found, so nothing gets cropped away. */
export async function fitThumb(buf, size = 800) {
  const sharp = await getSharp();
  if (!sharp) return buf;
  return sharp(buf).resize(size, size, { fit: 'contain', background: { r: 245, g: 245, b: 245, alpha: 1 } }).jpeg({ quality: 85 }).toBuffer();
}

export async function squareThumb(buf, size = 800) {
  const sharp = await getSharp();
  if (!sharp) return buf;
  return sharp(buf).resize(size, size, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
}
