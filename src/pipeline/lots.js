import fs from 'node:fs';
import path from 'node:path';
import { newLot, buildVariants } from '../domain/models.js';
import { heuristicListing, parsePrice } from '../agents/listing.js';
import { normalizeBox, boxArea } from '../ai/sam.js';
import { lotCaption } from './replies.js';
import { cropToBox, imageSize, fitThumb, toJpeg } from '../ai/crop.js';

// Lot pipeline. "Next lot" (hotkey, dashboard button or the spoken cue "next lot") opens a lot.
// Vision runs on the frame where the seller holds the item up:
//   Muse Spark glance (is something held? what noun?) -> SAM 3.1 segments that noun -> crop
//   -> Muse Image clean product shot (background job)
// Speech (browser captions + Muse Voice Transcribe) -> Muse Spark drafts the listing.
// Seller approves (or AUTO_PUBLISH) -> WooCommerce product -> queued claims are processed.

export function createLotsEngine({ store, bus, clock, cfg, ai, commerce, log, getClaims, platform = null }) {
  const S = store.s;
  const mediaDir = path.join(cfg.dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const frames = [];
  const productJobs = new Map();
  const listingTimers = new Map();
  const researchTimers = new Map();
  const visionJobs = new Map();
  const emit = (lot) => { bus.emit('lot.updated', lot); store.save(); };
  const GLANCE_DELAY_MS = Number(process.env.GLANCE_DELAY_MS ?? 1200);
  // After "New item", keep watching this long for something to be held up before giving up.
  const VISION_WINDOW_MS = Number(process.env.VISION_WINDOW_MS ?? 15000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const latestFrame = () => frames[frames.length - 1] || null;
  // Recent speech, so words said just before pressing "New item" still describe the new item.
  const speechLog = [];
  const LISTING_DEBOUNCE_MS = Number(process.env.LISTING_DEBOUNCE_MS ?? 1800);

  const currentLot = () => store.lots().filter((l) => l.status !== 'cancelled').pop() || null;

  function saveMedia(name, buf) {
    fs.writeFileSync(path.join(mediaDir, name), buf);
    return `/media/${name}`;
  }

  // ------------------------------------------------------------- inputs

  function onFrame(buf, { at = clock.now() } = {}) {
    frames.push({ buf, at });
    while (frames.length > 20) frames.shift();
  }

  function frameAt(t) {
    if (!frames.length) return null;
    let best = frames[frames.length - 1];
    for (const f of frames) if (Math.abs(f.at - t) < Math.abs(best.at - t)) best = f;
    return best;
  }

  function nextLot({ at = clock.now(), hint = null, listing = null, image = null, frame = null } = {}) {
    if (!S.show || S.show.status !== 'live') throw new Error('start the show first');
    const lot = newLot({ showId: S.show.id, lotNumber: ++S.lotCounter, at });
    if (hint) {
      lot.concept = hint.noun || hint.concept || null;
      lot.colors = hint.colors || [];
      lot.title = hint.label || '';
    }
    S.lots.set(lot.id, lot);
    bus.emit('lot.created', lot);
    log('info', `Lot ${lot.lotNumber} on screen`);
    if (!listing && !image) {
      for (const s of speechLog) if (s.at >= at - 6000) lot.transcript.push({ ...s, carried: true });
    }
    emit(lot);

    if (image) {
      // Replay / tests: the product image is supplied, so skip the camera pipeline.
      lot.imagePath = image;
      lot.visionStage = 'done';
    }
    if (listing) {
      applyListing(lot, { ...listing, source: listing.source || 'scripted' });
      if (cfg.autoPublish || listing.autoPublish) publish(lot.id);
    } else if (frame) {
      // A photo uploaded from the dashboard: use exactly this image, no camera timing involved.
      lot.fromPhoto = true;
      const job = runVision(lot, { frame: { buf: frame, at } }).catch((err) => log('error', `vision failed for Lot ${lot.lotNumber}`, err));
      visionJobs.set(lot.id, job);
    } else if (!image) {
      const job = new Promise((r) => setTimeout(r, GLANCE_DELAY_MS)).then(() => runVision(lot)).catch((err) => log('error', `vision failed for Lot ${lot.lotNumber}`, err));
      visionJobs.set(lot.id, job);
    }
    return lot;
  }

  function onSpeech({ text, final = true, source = 'webspeech', at = clock.now() }) {
    if (!text?.trim()) return;
    bus.emit('transcript', { text, final, source, at });
    if (!final) return;
    if (/^\s*(?:(?:ok(?:ay)?|right|so|and)[\s,]+)?next lot\b/i.test(text) && S.show?.status === 'live' && process.env.VOICE_CUES !== '0') {
      const lot = nextLot({ at });
      const rest = text.replace(/^.*?next lot[\s,.]*/i, '');
      if (rest) addTranscript(lot, rest, source, at);
      return;
    }
    speechLog.push({ text: text.trim(), source, at });
    while (speechLog.length && speechLog[0].at < at - 30000) speechLog.shift();
    const lot = currentLot();
    // Talk while an item is already on sale is kept for the next item (see nextLot), not added to it.
    if (!lot || !['detecting', 'draft'].includes(lot.status)) return;
    addTranscript(lot, text, source, at);
  }

  function addTranscript(lot, text, source, at) {
    lot.transcript.push({ text: text.trim(), source, at });
    if (lot.transcript.length > 60) lot.transcript.shift();
    emit(lot);
    if (lot.status === 'detecting' || (lot.status === 'draft' && !lot.sellerEdited)) scheduleListing(lot);
  }

  async function onAudio(wav, { at = clock.now(), test = false } = {}) {
    if (!ai.asr) {
      if (test) throw new Error('Meta AI isn’t set up, so Muse Voice can’t listen. Add the key in Settings.');
      return null;
    }
    const lot = currentLot();
    const keywords = [...cfg.models.asrKeywords, lot?.concept, lot?.brand, 'lot', 'size', 'pounds'].filter(Boolean);
    try {
      const { text } = await ai.asr.transcribe(wav, { keywords });
      if (test) { bus.emit('transcript', { text: text || '', final: true, source: 'muse-asr-test', at }); return text; }
      if (text) onSpeech({ text, final: true, source: 'muse-asr', at });
      return text;
    } catch (err) {
      log('warn', `Muse Voice Transcribe failed: ${err.message}`);
      if (test) throw err;
      return null;
    }
  }

  // -------------------------------------------------------------- vision

  /**
   * Find the item and cut it out. With the camera, keep watching for up to VISION_WINDOW_MS until
   * Muse Spark sees something held up (people pick the item up after pressing "New item"). If the
   * seller names the item meanwhile, SAM looks for that name instead.
   */
  async function runVision(lot, { frame = null } = {}) {
    const runId = (lot.visionRun || 0) + 1;
    lot.visionRun = runId;
    const current = () => {
      const l = S.lots.get(lot.id);
      return l && l.visionRun === runId && (l.status === 'detecting' || l.status === 'draft');
    };
    const deadline = Date.now() + (frame ? 0 : VISION_WINDOW_MS);
    let f = null;
    let g = null;
    let tries = 0;
    for (;;) {
      if (!current()) return;
      f = frame || latestFrame();
      if (!f) {
        if (Date.now() > deadline) break;
        lot.visionStage = 'waiting';
        emit(lot);
        await sleep(1000);
        continue;
      }
      lot.framePath = saveMedia(`lot-${lot.lotNumber}-${lot.id.slice(-4)}-frame.jpg`, f.buf);
      lot.visionStage = tries ? 'waiting' : 'glance';
      emit(lot);
      g = await glance(f, lot);
      tries++;
      if (!g || frame || g.holding !== false || lot.spokenNoun || Date.now() > deadline) break;
      lot.visionStage = 'waiting';
      emit(lot);
      await sleep(1200);
      if (lot.spokenNoun) { f = latestFrame() || f; break; }
    }
    if (!current()) return;
    if (!f) {
      log('warn', `Lot ${lot.lotNumber}: no camera picture yet; listing from speech only`);
      lot.visionStage = 'done';
      emit(lot);
      scheduleListing(lot, 0);
      return;
    }
    // In an uploaded photo nobody is holding the item, so only the camera cares about "holding".
    const seen = g && g.noun && (g.holding !== false || lot.fromPhoto) ? g : null;
    if (seen) {
      lot.colors = Array.isArray(seen.colors) ? seen.colors.slice(0, 4) : [];
      lot.brand = seen.brand || null;
      lot.visionLabel = seen.label || null;
    }
    await segmentAndCrop(lot, f, lot.spokenNoun || seen?.noun || null, current);
  }

  async function glance(f, lot) {
    if (!ai.spark) return { holding: true, noun: lot.concept || null, label: lot.title || null, colors: lot.colors || [] };
    try {
      const r = await ai.spark.glance(f.buf, transcriptText(lot), { photo: Boolean(lot.fromPhoto) });
      bus.emit('vision', { lotId: lot.id, stage: 'glance', model: ai.spark.name, ms: r.ms, result: r.json });
      return r.json || null;
    } catch (err) {
      log('warn', `Spark glance failed: ${err.message}`);
      return null;
    }
  }

  /** SAM 3.1 finds `noun` in the frame. Most confident box wins (not the biggest: a wall picture is bigger than a remote). */
  async function segmentAndCrop(lot, f, noun, current = () => true) {
    lot.visionStage = 'segment';
    lot.concept = noun ? String(noun).slice(0, 40) : lot.concept;
    emit(lot);
    let box = null;
    if (noun && ai.sam) {
      // SAM works best with short names: "handheld game console" can miss where "console" hits.
      const words = String(noun).trim().split(/\s+/);
      const tries = [noun, ...(words.length > 1 ? [words[words.length - 1]] : [])];
      const maxArea = lot.fromPhoto ? 0.98 : 0.9; // in a photo the item can fill the frame
      try {
        const { width, height } = await imageSize(f.buf);
        for (const q of tries) {
          const r = await ai.sam.segment(f.buf, q);
          const boxes = r.boxes.map((b) => normalizeBox(b, width, height)).filter((b) => boxArea(b) > 0.002 && boxArea(b) < maxArea);
          box = boxes.sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5) || boxArea(b) - boxArea(a))[0] || null;
          bus.emit('vision', { lotId: lot.id, stage: 'segment', model: ai.sam.name, ms: r.ms, result: { query: q, matches: r.boxes.length, best: box } });
          if (box) break;
        }
      } catch (err) {
        log('warn', `SAM failed: ${err.message}`);
      }
    }
    if (!current()) return;
    let crop;
    lot.wholePhoto = false;
    if (box) {
      lot.box = box;
      lot.visionMiss = false;
      crop = await cropToBox(f.buf, box);
    } else if (lot.fromPhoto && (noun || lot.visionLabel)) {
      // An uploaded photo of the item: the whole photo is the product shot.
      lot.box = null;
      lot.visionMiss = false;
      lot.wholePhoto = true;
      crop = await fitThumb(f.buf).catch(() => f.buf);
    } else {
      lot.box = null;
      lot.visionMiss = true;
      log('info', noun ? `Lot ${lot.lotNumber}: couldn't find "${noun}" in the picture` : `Lot ${lot.lotNumber}: nothing was held up to the camera`);
      crop = await fitThumb(f.buf).catch(() => f.buf);
    }
    lot.framePath = saveMedia(`lot-${lot.lotNumber}-${lot.id.slice(-4)}-frame.jpg`, f.buf);
    lot.cropPath = saveMedia(`lot-${lot.lotNumber}-${lot.id.slice(-4)}-crop-${lot.visionRun || 1}.jpg`, crop);
    lot.cleanPath = null;
    lot.imagePath = lot.cropPath;
    lot.visionStage = 'listing';
    emit(lot);
    scheduleListing(lot, 0);
    lot.researchStage = null;
    scheduleResearch(lot, 0);

    // Only clean up a real cutout or the seller's own product photo; a photo of the room isn't a product shot.
    if ((box || lot.wholePhoto) && ai.image && cfg.models.cleanThumbnails) {
      lot.visionStage = 'clean';
      const run = lot.visionRun;
      ai.image.cleanProductShot(crop, { title: lot.visionLabel || lot.concept })
        .then(async ({ buffer, ms }) => {
          if (lot.visionRun !== run) return;
          lot.cleanPath = saveMedia(`lot-${lot.lotNumber}-${lot.id.slice(-4)}-clean-${run}.jpg`, await toJpeg(buffer));
          lot.imagePath = lot.cleanPath;
          bus.emit('vision', { lotId: lot.id, stage: 'clean', model: ai.image.name, ms });
          emit(lot);
          if (lot.wooProductId) commerce.updateProduct?.(lot).catch(() => {});
        })
        .catch((err) => log('warn', `Muse Image clean-up failed: ${err.message}`))
        .finally(() => { if (lot.visionStage === 'clean') { lot.visionStage = 'done'; emit(lot); } });
    } else {
      lot.visionStage = 'done';
      emit(lot);
    }
  }

  /** Seller pressed "Look again": watch the camera afresh for this item. */
  function lookAgain(lotId) {
    const lot = S.lots.get(lotId);
    if (!lot) throw new Error('no such lot');
    if (!['detecting', 'draft'].includes(lot.status)) throw new Error('this item is already on sale');
    if (!latestFrame()) throw new Error('turn on the camera first');
    lot.visionMiss = false;
    lot.box = null;
    lot.researchStage = null;
    const job = runVision(lot).catch((err) => log('error', `vision failed for Lot ${lot.lotNumber}`, err));
    visionJobs.set(lot.id, job);
    return lot;
  }

  // ------------------------------------------------------------- listing

  function scheduleListing(lot, delay = LISTING_DEBOUNCE_MS) {
    clearTimeout(listingTimers.get(lot.id));
    listingTimers.set(lot.id, setTimeout(() => draftListing(lot).catch((err) => log('error', 'listing failed', err)), delay));
  }

  function transcriptText(lot) {
    const asr = lot.transcript.filter((t) => t.source === 'muse-asr');
    const live = lot.transcript.filter((t) => t.source !== 'muse-asr');
    // Muse ASR is the better transcript; fall back to browser captions if it hasn't arrived.
    const use = asr.length && asr.join(' ').length >= live.join(' ').length * 0.5 ? asr : live.length ? live : asr;
    return use.map((t) => t.text).join(' ');
  }

  async function draftListing(lot) {
    const current = S.lots.get(lot.id);
    if (!current || current.sellerEdited || ['published', 'sold_out', 'cancelled'].includes(current.status)) return;
    const transcript = transcriptText(lot);
    // Nothing said and nothing seen yet: wait rather than invent a listing.
    if (!transcript.trim() && !lot.visionLabel && !lot.box) return;
    const hint = { label: lot.visionLabel, noun: lot.concept, colors: lot.colors, brand: lot.brand };
    const heur = heuristicListing(transcript, hint);
    let listing = heur;
    if (ai.spark) {
      try {
        const img = lot.cropPath && fs.existsSync(path.join(mediaDir, path.basename(lot.cropPath))) ? fs.readFileSync(path.join(mediaDir, path.basename(lot.cropPath))) : null;
        const { json, ms } = await ai.spark.listing({ transcript, ...hint, currency: cfg.currency }, img);
        if (json.noun && !lot.box) {
          // The seller named the item: look for exactly that (the camera loop picks this up, or we re-run SAM now).
          lot.spokenNoun = String(json.noun).slice(0, 40);
          if (lot.visionStage === 'done' && latestFrame()) segmentAndCrop(lot, latestFrame(), lot.spokenNoun).catch(() => {});
        }
        listing = {
          title: json.title || heur.title,
          description: json.description || heur.description,
          price: Number.isFinite(Number(json.price)) && json.price !== null ? Number(json.price) : heur.price,
          variants: Array.isArray(json.variants) && json.variants.length ? json.variants : heur.variants,
          quantity: Number(json.quantity) || heur.quantity,
          condition: json.condition || heur.condition,
          confidence: Number(json.confidence ?? 0.8),
          source: ai.spark.name,
          ms,
        };
        // Guard against an invented price: if the seller said a number, trust the words.
        const spoken = parsePrice(transcript);
        if (spoken !== null && listing.price !== spoken) listing.price = spoken;
      } catch (err) {
        log('warn', `Spark listing failed, using speech parser: ${err.message}`);
      }
    }
    applyListing(lot, listing);
    // Look it up once the picture is settled (the camera step starts research itself after the cut-out);
    // items with no picture at all are looked up from the words.
    if (!lot.researchStage && lot.visionStage === 'done' && !lot.cropPath && transcript.split(/\s+/).length >= 4) scheduleResearch(lot, 0);
    if (cfg.autoPublish && lot.price && lot.listingConfidence >= 0.7) publish(lot.id);
  }

  // ------------------------------------------------------------ research

  /** Muse Spark + web search: identify the exact product and write a full shop description. */
  function scheduleResearch(lot, delay = 0) {
    if (!ai.spark?.research) return;
    clearTimeout(researchTimers.get(lot.id));
    researchTimers.set(lot.id, setTimeout(() => runResearch(lot).catch((err) => log('warn', `research failed: ${err.message}`)), delay));
  }

  function mediaBuf(p) {
    if (!p || /\.svg$/i.test(p)) return null;
    const file = path.join(mediaDir, path.basename(p));
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  async function runResearch(lot) {
    const cur = S.lots.get(lot.id);
    if (!cur || cur.status === 'cancelled') return;
    if (cur.researchStage === 'running') { cur.researchAgain = true; return; }
    // The cut-out is the best picture; an uploaded photo is the item itself; a camera frame where the
    // item wasn't found would only describe the room, so then go on words alone.
    const img = cur.box || cur.wholePhoto ? mediaBuf(cur.cropPath) : cur.fromPhoto ? mediaBuf(cur.framePath) : null;
    const transcript = transcriptText(cur);
    if (!img && transcript.split(/\s+/).filter(Boolean).length < 4) return;
    cur.researchStage = 'running';
    cur.researchError = null;
    emit(cur);
    try {
      const { json, ms, searches } = await ai.spark.research({ transcript, label: cur.visionLabel, noun: cur.concept, brand: cur.brand, colors: cur.colors }, img);
      applyResearch(cur, json || {}, { ms, searches });
    } catch (err) {
      cur.researchStage = 'failed';
      cur.researchError = err.message;
      emit(cur);
      log('warn', `Lot ${cur.lotNumber}: web research failed: ${err.message}`);
    }
    if (cur.researchAgain) { cur.researchAgain = false; scheduleResearch(cur, 0); }
  }

  function applyResearch(lot, r, { ms = null, searches = [] } = {}) {
    const conf = Math.max(0, Math.min(1, Number(r.confidence ?? 0.6)));
    lot.research = {
      product: r.product ? String(r.product).slice(0, 120) : null,
      brand: r.brand && r.brand !== 'null' ? String(r.brand).slice(0, 60) : null,
      title: r.title ? String(r.title).slice(0, 80) : null,
      facts: (Array.isArray(r.facts) ? r.facts : []).map((f) => String(f).slice(0, 120)).filter(Boolean).slice(0, 8),
      sources: (Array.isArray(r.sources) ? r.sources : []).filter((x) => /^https?:\/\//.test(x?.url || '')).map((x) => ({ title: String(x.title || x.url).slice(0, 80), url: String(x.url) })).slice(0, 3),
      confidence: conf,
      searches: searches.slice(0, 3),
      ms,
    };
    lot.researchStage = 'done';
    const open = ['detecting', 'draft'].includes(lot.status);
    if (open && r.description && lot.descriptionSource !== 'seller') {
      lot.description = String(r.description).slice(0, 1500);
      lot.descriptionSource = 'research';
    }
    if (open && lot.research.title && conf >= 0.7 && lot.titleSource !== 'seller') {
      lot.title = lot.research.title;
      lot.titleSource = 'research';
    }
    if (lot.research.brand && !lot.brand) lot.brand = lot.research.brand;
    emit(lot);
    log('info', `Lot ${lot.lotNumber}: looked up online: ${lot.research.product || lot.research.title || 'no match'} (${Math.round(conf * 100)}% sure)`);
  }

  /** Seller pressed "Look it up again". */
  function researchAgain(lotId) {
    const lot = S.lots.get(lotId);
    if (!lot) throw new Error('no such lot');
    if (!ai.spark?.research) throw new Error('Meta AI isn’t set up');
    lot.researchStage = null;
    scheduleResearch(lot, 0);
    return lot;
  }

  function applyListing(lot, listing) {
    if (['published', 'sold_out'].includes(lot.status)) return;
    if (!lot.title || !['research', 'seller'].includes(lot.titleSource)) {
      lot.title = String(listing.title || lot.title || `Lot ${lot.lotNumber}`).slice(0, 80);
      lot.titleSource = 'listing';
    }
    if (!lot.description || !['research', 'seller'].includes(lot.descriptionSource)) {
      lot.description = listing.description || lot.description || '';
      lot.descriptionSource = 'listing';
    }
    lot.price = listing.price ?? lot.price;
    lot.currency = cfg.currency;
    lot.condition = listing.condition || null;
    const { variants, stock } = buildVariants({ variants: listing.variants, quantity: listing.quantity });
    lot.variants = variants;
    lot.stock = stock;
    lot.initialStock = { ...stock };
    lot.listingSource = listing.source || 'heuristic';
    lot.listingConfidence = listing.confidence ?? null;
    lot.needsReview = !lot.price || (listing.confidence ?? 0) < 0.7;
    if (lot.status === 'detecting') lot.status = 'draft';
    emit(lot);
  }

  function override(lotId, fields) {
    const lot = S.lots.get(lotId);
    if (!lot) throw new Error('no such lot');
    const editable = ['title', 'description', 'price'];
    for (const k of editable) {
      if (fields[k] === undefined) continue;
      const v = k === 'price' ? Number(fields[k]) : String(fields[k]);
      if (k === 'title' && v !== lot.title) lot.titleSource = 'seller';
      if (k === 'description' && v !== lot.description) lot.descriptionSource = 'seller';
      lot[k] = v;
    }
    if (fields.variants || fields.quantity) {
      if (lot.status === 'published' || lot.status === 'sold_out') {
        // After publishing, only top up stock; never take away units that are already held.
        for (const v of fields.variants || []) {
          const key = lot.variants.find((x) => x.label === v.label || x.key === v.key)?.key;
          if (key && Number(v.qty) > lot.initialStock[key]) {
            const add = Number(v.qty) - lot.initialStock[key];
            lot.initialStock[key] += add;
            lot.stock[key] += add;
          }
        }
      } else {
        const { variants, stock } = buildVariants({ variants: fields.variants, quantity: fields.quantity });
        lot.variants = variants;
        lot.stock = stock;
        lot.initialStock = { ...stock };
      }
    }
    lot.sellerEdited = true;
    if (lot.status === 'detecting') lot.status = 'draft';
    emit(lot);
    if (lot.wooProductId) commerce.updateProduct?.(lot).catch((err) => log('warn', `Woo update failed: ${err.message}`));
    if (lot.status === 'published' || lot.status === 'sold_out') for (const v of lot.variants) getClaims().promote(lot, v.key);
    return lot;
  }

  function publish(lotId) {
    const lot = S.lots.get(lotId);
    if (!lot) throw new Error('no such lot');
    if (lot.status === 'published' || lot.status === 'sold_out') return lot;
    if (!(Number(lot.price) > 0)) throw new Error(`Lot ${lot.lotNumber} needs a price`);
    clearTimeout(listingTimers.get(lot.id));
    lot.status = 'published';
    lot.publishedAt = clock.now();
    lot.needsReview = false;
    emit(lot);
    log('info', `Lot ${lot.lotNumber} live: ${lot.title} ${cfg.currencySymbol}${lot.price}`);
    ensureProduct(lot).catch(() => {});
    getClaims().onLotPublished(lot);
    if (S.show?.mode === 'post' && platform?.postLot && !lot.posts) postLot(lot);
    return lot;
  }

  /** Create the Woo product once; concurrent callers share the same promise. Retries after a failure. */
  function ensureProduct(lot) {
    if (lot.wooProductId) return Promise.resolve(lot);
    const existing = productJobs.get(lot.id);
    if (existing) return existing;
    const job = (async () => {
      const imageUrl = lot.imagePath && !/\.svg$/i.test(lot.imagePath) && cfg.publicBaseUrl.startsWith('https://') ? `${cfg.publicBaseUrl}${lot.imagePath}` : null;
      try {
        const r = await commerce.createProduct(lot, { imageUrl });
        lot.wooProductId = r.productId;
        lot.wooVariationIds = r.variationIds;
        lot.productUrl = r.permalink;
        lot.publishError = null;
        emit(lot);
        return lot;
      } catch (err) {
        lot.publishError = err.message;
        emit(lot);
        productJobs.delete(lot.id);
        throw err;
      }
    })();
    productJobs.set(lot.id, job);
    return job;
  }

  /** Post mode: publish the lot as a Facebook Page post and an Instagram post, then watch their comments. */
  async function postLot(lot) {
    lot.posts = { pending: true };
    emit(lot);
    const img = lot.imagePath && !/\.svg$/i.test(lot.imagePath) && cfg.publicBaseUrl.startsWith('https://') ? `${cfg.publicBaseUrl}${lot.imagePath}` : null;
    try {
      const r = await platform.postLot(lot, { imageUrl: img, caption: lotCaption({ lot, sym: cfg.currencySymbol }), platforms: S.show.platforms });
      lot.posts = r;
      for (const [p, post] of Object.entries(r)) {
        if (post?.id) platform.watchPost?.({ platform: p, id: post.id, lotId: lot.id, since: lot.publishedAt });
        if (post?.error) log('warn', `Lot ${lot.lotNumber}: posting to ${p} failed: ${post.error}`);
      }
      log('info', `Lot ${lot.lotNumber} posted: ${Object.entries(r).filter(([, v]) => v?.id).map(([p]) => p).join(' + ') || 'nowhere'}`);
    } catch (err) {
      lot.posts = { error: err.message };
      log('error', `Lot ${lot.lotNumber}: posting failed`, err);
    }
    emit(lot);
  }

  function cancelLot(lotId) {
    const lot = S.lots.get(lotId);
    if (!lot) throw new Error('no such lot');
    const live = store.claimsForLot(lot.id).some((c) => ['reserved', 'invoiced', 'paid'].includes(c.state));
    if (live) throw new Error('lot has claims; undo them first');
    lot.status = 'cancelled';
    emit(lot);
    return lot;
  }

  async function relist(lotId) {
    const lot = S.lots.get(lotId);
    if (!lot) throw new Error('no such lot');
    lot.sellerEdited = false;
    await draftListing(lot);
    return lot;
  }

  const visionIdle = () => Promise.allSettled([...visionJobs.values()]);

  return { nextLot, onFrame, onSpeech, onAudio, publish, override, ensureProduct, cancelLot, relist, draftListing, currentLot, visionIdle, postLot, lookAgain, researchAgain, frames: () => frames.length };
}
