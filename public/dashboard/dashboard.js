import { connect, api, esc, money, clockText, ago, authHeaders } from '/shared/live.js';
import { createStudio } from '/shared/studio.js';

const $ = (s) => document.querySelector(s);
const art = (name, size = '') => (name ? `<span class="art ${size}" style="--art:url(/art/${name}.webp)" aria-hidden="true"></span>` : '');

const STATE_LABEL = {
  detected: 'Reading', matched: 'Queued', needs_review: 'Needs you', reserved: 'Held', invoiced: 'Pay link sent',
  paid: 'Paid', waitlisted: 'Waiting in line', expired: 'Time ran out', cancelled: 'Cancelled', ignored: 'Ignored',
};
const STATE_ART = {
  detected: 'ai-read', matched: 'ai-read', needs_review: 'state-needs-you', reserved: 'state-held', invoiced: 'state-link-sent',
  paid: 'paid', waitlisted: 'state-waitlist', expired: 'state-expired', cancelled: 'state-expired',
};
const LOT_LABEL = { detecting: 'Looking', draft: 'Draft', published: 'On sale', sold_out: 'Sold out', cancelled: 'Removed' };
const MODEL_NAMES = { 'rules (fast path)': 'Instant rule', 'muse-spark-1.3': 'Muse Spark 1.3', 'sam-3.1': 'SAM 3.1', 'sam-3-1': 'SAM 3.1', 'muse-voice-transcribe-1.0': 'Muse Voice', 'muse-image-1.0': 'Muse Image', regex: 'Rules', heuristic: 'Speech parser', scripted: 'Script', test: 'Test', woocommerce: 'WooCommerce', 'graph-api': 'Facebook / Instagram' };
const MODEL_ART = { 'rules (fast path)': 'ai-rule', regex: 'ai-rule', 'sam-3.1': 'ai-sam', 'sam-3-1': 'ai-sam', 'muse-voice-transcribe-1.0': 'ai-voice', 'muse-image-1.0': 'ai-image', heuristic: 'ai-write', scripted: 'home-demo', test: 'tester', woocommerce: 'setup-shop', 'graph-api': 'setup-meta' };
const modelName = (m) => MODEL_NAMES[m] || (m?.includes('spark-open') ? 'Muse Spark Open' : m || '');
const modelArt = (m) => MODEL_ART[m] || (m?.includes('spark') ? 'ai-spark' : m?.includes('sam') ? 'ai-sam' : 'ai-spark');
const STEPS = [['Add an item', 'step-add'], ['Check and publish', 'step-publish'], ['Wait for “sold”', 'step-sold'], ['Get paid', 'paid']];

let selectedLotId = null;
let lastActionsKey = '';
let traceTab = 'trace';
const seenComments = new Set();

const S = connect((type, data) => {
  if (type === 'snapshot') for (const c of S.comments) seenComments.add(c.id);
  if (type === 'snapshot' && S.outdated) newVersion();
  if (type === 'lot.created') selectedLotId = null;
  if (type === 'order.paid') toast(`Paid: ${money(sym(), data.total)}`);
  if (type === 'transcript' && data?.final) {
    const src = data.source === 'muse-asr' ? 'Muse Voice' : data.source === 'muse-asr-test' ? 'Mic test: Muse Voice' : data.source === 'typed' ? 'You typed' : 'Captions';
    $('#camHeard').innerHTML = data.text
      ? `${art('ai-voice', 's')}<span><b>${src} heard:</b> “${esc(data.text.slice(-160))}”</span>`
      : `${art('vision-miss', 's')}<span><b>${src} heard nothing.</b> Speak closer, or pick another microphone.</span>`;
  }
  if (type === 'show.updated' && data?.status !== 'live' && studio.isOn()) cameraOff();
  schedule();
});
const sym = () => S.config.currencySymbol || '£';
const selling = () => S.show?.status === 'live';
const activeLots = () => [...S.lots.values()].filter((l) => l.status !== 'cancelled').sort((a, b) => a.lotNumber - b.lotNumber);

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function render() {
  document.body.className = selling() ? 'mode-selling' : 'mode-start';
  renderTop();
  if (!selling()) { renderStart(); return; }
  renderNow();
  renderLot();
  renderReview();
  renderFeed();
  renderOrders();
  renderRail();
  renderTrace();
}

// ------------------------------------------------------------------ header
function renderTop() {
  const show = S.show;
  const live = selling();
  const el = $('#showStatus');
  if (!S.connected) el.innerHTML = `<span class="off-dot">Reconnecting…</span>`;
  else if (live) {
    const onPosts = show.mode === 'post';
    const label = show.demo ? 'Demo show' : onPosts ? 'Selling with posts' : 'Live';
    el.innerHTML = `<span class="live-dot${onPosts || show.demo ? ' post' : ''}" data-since="${show.startedAt}" data-label="${label}">${label} ${clockText(S.now() - show.startedAt)}</span>${S.replay?.running ? `<span class="pill-demo">Demo ${S.replay.done} of ${S.replay.total}</span>` : ''}`;
  } else el.innerHTML = `<span class="off-dot">Not selling</span>`;

  const st = S.stats || {};
  const medianS = st.medianReplyMs ? `${(st.medianReplyMs / 1000).toFixed(1)}s` : '–';
  $('#stats').innerHTML = live || st.claims ? [
    ['cash', 'paid', money(sym(), st.revenue || 0), 'paid'],
    ['', 'state-held', money(sym(), st.heldValue || 0), 'waiting for payment'],
    ['', 'step-sold', st.paid ?? 0, 'items sold'],
    ['', 'ai-rule', medianS, 'to send a pay link'],
  ].map(([c, a, v, l]) => `<div class="stat ${c}">${art(a)}<span><b>${esc(v)}</b><span>${l}</span></span></div>`).join('') : '';

  const dev = S.config.devTools;
  const judge = S.role === 'judge';
  const actionsKey = `${live}:${dev}:${S.config.claimTtlSec}:${show?.demo}:${judge}`;
  if (actionsKey !== lastActionsKey) {
    lastActionsKey = actionsKey;
    const settings = judge ? '<span class="pill-demo" title="You can use everything here except Settings">Judge pass</span>' : '<a class="bb small" href="/settings/"><span>Settings</span></a>';
    $('#actions').innerHTML = `${live ? `<button class="bb small" data-act="end">${art('btn-stop')}<span>${show?.demo ? 'Stop the demo' : 'Stop selling'}</span></button>` : ''}${settings}${dev ? menuHtml() : ''}`;
  }
  const tester = $('#tester');
  tester.hidden = !(dev && live);
  const realComments = S.platform?.kind === 'meta' && !show?.demo;
  $('#testerNote').textContent = realComments
    ? 'Type a comment as if you were a buyer. Real Facebook and Instagram comments show up on their own.'
    : 'Facebook isn’t connected yet, so pretend to be a buyer here.';
  if (!realComments && !tester.dataset.touched) tester.open = true;
}

function menuHtml() {
  const item = (act, a, title, sub) => `<button data-act="${act}">${art(a)}<span>${title}</span><small>${sub}</small></button>`;
  return `<div class="menu"><button class="bb small" data-act="menu" aria-haspopup="true" aria-expanded="false"><span>More</span></button>
    <div class="menu-pop" hidden>
      ${item('replay', 'home-demo', 'Watch a demo show', 'Pretend buyers. Nothing real is posted or sold.')}
      ${item('ff', 'menu-skip', `Skip ahead ${Math.round((S.config.claimTtlSec || 900) / 60)} minutes`, 'Unpaid items go to the next person in line')}
      ${item('recap', 'home-recap', 'Show recap', 'A summary card to share')}
      ${item('overlay', 'menu-overlay', 'Stream overlay', 'For OBS when you go live')}
      ${item('studio', 'btn-camera', 'Separate camera page', 'For a second screen or OBS')}
      ${S.role === 'judge' ? '' : item('reset', 'btn-remove', 'Clear everything', 'Stops selling and deletes all items, comments and orders here')}
    </div></div>`;
}

// ------------------------------------------------------------- start screen
let lastSetupKey = '';
function renderStart() {
  const st = S.stats || {};
  const had = S.lots.size > 0;
  $('#lastShow').hidden = !had;
  if (had) $('#lastShowText').textContent = `${st.paid || 0} sold, ${money(sym(), st.revenue || 0)} paid${st.held ? `, ${st.held} still waiting for payment` : ''}. See the recap.`;

  const ai = Object.values(S.ai || {}).filter(Boolean);
  const meta = S.platform?.kind === 'meta';
  const woo = S.commerce === 'woo';
  const judge = S.role === 'judge';
  const key = `${ai.join()}:${meta}:${woo}:${S.config.shopName}:${S.config.pageName}:${judge}`;
  if (key === lastSetupKey) return;
  lastSetupKey = key;
  // With a judge pass the cards only show what's connected; Settings stays with the seller.
  const row = (a, title, ok, state, text, section) => judge
    ? `<div class="setup-item">${art(a)}<b>${title}</b><span class="state ${ok ? 'ok' : 'off'}">${state}</span><p>${text}</p></div>`
    : `<a class="setup-item" href="/settings/#${section}">${art(a)}<b>${title}</b><span class="state ${ok ? 'ok' : 'off'}">${state}</span><p>${text}</p><span class="setup-go">${ok ? 'Change' : 'Set up'}</span></a>`;
  $('#setup').innerHTML = [
    row('setup-shop', 'Your shop', woo, woo ? 'Connected' : 'Practice shop',
      woo ? `Products and orders go to ${esc(S.config.shopName || 'your shop')} on WooCommerce.` : 'Orders stay inside LiveLot until you add your WooCommerce store.', 'shop'),
    row('setup-meta', 'Facebook and Instagram', meta, meta ? 'Connected' : 'Not connected yet',
      meta ? `Posts go to ${S.config.pageName ? `the Page “${esc(S.config.pageName)}”` : 'your Page'}. Comments and private replies are real.` : 'You can still try everything: pretend to be a buyer on the selling screen.', 'meta'),
    row('ai-spark', 'Meta AI', ai.length > 0, ai.length ? `${ai.length} models ready` : 'Not set up',
      ai.length ? ai.map(modelName).join(', ') : 'Built-in rules stand in until a Meta Model API key is added.', 'ai'),
  ].join('');
}

// ------------------------------------------------------------- "do this now"
function nowState() {
  const lots = activeLots();
  const latest = lots[lots.length - 1];
  const open = [...S.orders.values()].filter((o) => o.status === 'open').length;
  const posts = S.show?.mode === 'post' && !S.show?.demo;
  const cam = studio.isOn();
  if (!latest) {
    return { step: 0, art: cam ? 'step-add' : 'btn-camera',
      text: cam ? 'Press <b>New item</b> under the camera, hold your item up and say what it is, the size and the price.' : 'Add your first item: turn on the camera below and hold it up, or upload a photo of it.' };
  }
  const n = latest.lotNumber;
  if (latest.status === 'detecting' && latest.visionStage === 'waiting') return { step: 0, art: 'step-add', text: `Hold Lot ${n} up inside the box on the camera, and say what it is and the price.` };
  if (latest.status === 'detecting') return { step: 0, art: 'ai-spark', text: `Looking at Lot ${n}… say what it is, the size and the price.` };
  if (latest.status === 'draft') {
    if (latest.visionMiss && !latest.price) return { step: 1, art: 'vision-miss', text: latest.fromPhoto ? `Couldn’t find Lot ${n} in your photo. Type its title and price, or upload a closer photo.` : `Couldn’t spot Lot ${n} in the picture. Hold it up inside the box and press <b>Look again</b>, or upload a photo.` };
    return latest.price
      ? { step: 1, art: 'step-publish', text: `Check Lot ${n}: the title, price and sizes. Then press <b>${posts ? 'Publish and post' : 'Publish'}</b>.` }
      : { step: 1, art: 'ai-write', text: `Lot ${n} needs a price. Type it in, or describe the item in the box.` };
  }
  if (open) return { step: 3, art: 'state-link-sent', text: `${open} buyer${open > 1 ? 's have' : ' has'} a pay link. They turn green when they pay. Add more items any time.` };
  return { step: 2, art: 'step-sold', text: `Lot ${n} is ${posts ? 'posted' : 'on sale'}. The first person to comment <b>sold</b> gets a pay link by private message.` };
}

let lastNowKey = '';
function renderNow() {
  const g = nowState();
  const waiting = [...S.lots.values()].some((l) => l.status === 'detecting' && l.visionStage === 'waiting');
  $('#camFrame').classList.toggle('waiting', waiting);
  const key = JSON.stringify(g);
  if (key === lastNowKey) return;
  lastNowKey = key;
  $('#now').innerHTML = `<div class="now-tag">${art(g.art)}
      <p class="now-step">Step ${g.step + 1} of 4: ${STEPS[g.step][0]}</p>
      <p class="now-text">${g.text}</p></div>
    <ol class="track">${STEPS.map(([t, a], i) => `<li class="${i < g.step ? 'done' : i === g.step ? 'is-now' : ''}"${i === g.step ? ' aria-current="step"' : ''}>${art(a)}<span><span class="n">Step ${i + 1}</span>${t}</span></li>`).join('')}</ol>`;
}

// ------------------------------------------------------------------ camera
const studio = createStudio({
  video: $('#camVideo'),
  isSelling: selling,
  hasAsr: () => Boolean(S.ai?.asr),
  onStatus: (st) => {
    $('#camHint').textContent = st.on ? `${st.speech === 'listening' ? 'Listening' : `Speech: ${st.speech}`}${st.asr ? `, ${st.asr} voice clips sent` : ''}` : '';
  },
  onCaption: (text, final) => { $('#camCap').innerHTML = final ? esc(text) : `<i>${esc(text)}</i>`; },
  onLevel: (st) => showMic(st),
});

/** The mic row under the camera: what's listening, whether it hears anything, what to do if not. */
function showMic(st) {
  const box = $('#mic');
  $('#micLevel').style.width = `${st.level || 0}%`;
  let text = 'Listening. Say what it is, the size and the price.';
  let cls = '';
  if (st.speech === 'no microphone') { text = 'No microphone. Plug one in, or pick one below.'; cls = 'bad'; }
  else if (st.suspended) { text = 'Click anywhere on the page to switch the microphone on.'; cls = 'bad'; }
  else if (st.quiet) { text = 'Can’t hear anything. Pick another microphone below, or check it isn’t muted.'; cls = 'bad'; }
  else if (st.hearing) { text = `Hearing you${S.ai?.asr ? ': Muse Voice is listening' : ''}`; cls = 'ok'; }
  const state = $('#micState');
  state.textContent = text;
  state.className = `mic-state ${cls}`;
  box.classList.toggle('bad', cls === 'bad');
  box.classList.toggle('hearing', Boolean(st.hearing));
}
async function fillMics(selectedId) {
  try {
    const { mics } = await studio.devices();
    const sel = $('#micSel');
    sel.innerHTML = mics.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('') || '<option value="">No microphone found</option>';
    if (selectedId && mics.some((m) => m.id === selectedId)) sel.value = selectedId;
  } catch { /* device list unavailable */ }
}
$('#micSel').addEventListener('change', async (e) => {
  try {
    const r = await studio.start({ cameraId: camId, micId: e.target.value });
    await fillMics(r.micId);
    toast(`Microphone: ${studio.stat.mic || 'changed'}`);
  } catch (err) { camError(err.explain || err.message); }
});
function camError(msg) {
  $('#camErrText').textContent = msg || '';
  $('#camErr').hidden = !msg;
}
let camId = '';
async function cameraOn() {
  const waiting = setTimeout(() => camError('Chrome is asking for permission: click “Allow” in the box at the top-left of the window.'), 1500);
  try {
    const r = await studio.start();
    clearTimeout(waiting);
    camError(r.micNote ? `Camera on, but no microphone. ${r.micNote}` : '');
    camId = r.cameraId;
    fillMics(r.micId);
    $('#camPanel').classList.add('is-on');
    lastNowKey = '';
    schedule();
  } catch (err) {
    clearTimeout(waiting);
    camError(err.explain || err.message);
  }
}
function cameraOff() {
  studio.stop();
  $('#camPanel').classList.remove('is-on');
  $('#camCap').textContent = '';
  camError('');
  lastNowKey = '';
  schedule();
}

// --------------------------------------------------------------------- lot
const currentLot = () => {
  const lots = activeLots();
  return (selectedLotId && S.lots.get(selectedLotId)) || lots[lots.length - 1] || null;
};
let lastFormKey = '';

function renderLot() {
  const lot = currentLot();
  const panel = $('#lotPanel');
  $('#pipeline').innerHTML = lot ? pipelineHtml(lot) : '';
  if (!lot) {
    lastFormKey = '';
    panel.innerHTML = `<div class="lot-empty">${art('empty-item', 'xxl')}<span class="t">Your item shows up here</span><p>Meta AI looks at it, cuts it out and writes the listing. You check it and publish.</p></div>`;
    return;
  }
  const formKey = `${lot.id}:${lot.status}:${lot.visionMiss}:${lot.concept}:${lot.listingSource}:${lot.researchStage}:${lot.descriptionSource}:${(lot.description || '').length}:${lot.price}:${lot.title}:${JSON.stringify(lot.variants)}:${JSON.stringify(lot.stock)}:${lot.publishError}:${lot.wooProductId}:${JSON.stringify(lot.posts || null)}:${S.show?.mode}`;
  const focusInside = panel.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  const top = lotTopHtml(lot);
  if (focusInside && lastFormKey.startsWith(lot.id)) {
    panel.querySelector('.lot-visual').innerHTML = top;
    return;
  }
  if (formKey === lastFormKey && panel.querySelector('.lot-visual')) {
    panel.querySelector('.lot-visual').innerHTML = top;
    return;
  }
  lastFormKey = formKey;
  panel.innerHTML = `<div class="lot-visual">${top}</div>${lotFormHtml(lot)}`;
}

function lotTopHtml(lot) {
  const sold = lot.status === 'sold_out';
  const main = lot.imagePath || lot.cleanPath || lot.cropPath || lot.framePath;
  const waiting = lot.status === 'detecting' && lot.visionStage === 'waiting';
  const ph = lot.status === 'detecting'
    ? `${art(waiting ? 'step-add' : 'ai-spark', 'xl')}<span>${waiting ? 'Hold it up inside the box on the camera' : 'Looking at the camera…'}</span>`
    : `${art('btn-photo', 'xl')}<span>No picture yet</span>`;
  return `<div class="lot-head"><span class="tag">Lot ${lot.lotNumber}</span><span class="pill ${lot.status}">${LOT_LABEL[lot.status] || lot.status}</span>
      ${lot.productUrl ? `<a href="${esc(lot.productUrl)}" target="_blank" rel="noopener">View in shop</a>` : ''}</div>
    <div class="media">${main ? `<img class="main" src="${esc(main)}" alt="${esc(lot.title || 'Lot image')}" />` : `<div class="placeholder">${ph}</div>`}
      ${sold ? '<div class="soldstamp">SOLD</div>' : ''}</div>`;
}

/** The Meta models working on this lot, one row each, with what each produced. */
function pipelineHtml(lot) {
  const stage = lot.visionStage;
  const rows = [];
  const row = (cls, a, name, what, out = '') => rows.push(`<li class="st ${cls}">${art(a)}<span><b>${name}</b><span class="what">${what}</span></span><span class="out">${out}</span></li>`);
  const fromCamera = lot.framePath || ['glance', 'waiting', 'segment', 'listing', 'clean'].includes(stage);
  if (fromCamera) {
    row(stage === 'waiting' || stage === 'glance' ? 'run' : lot.concept ? 'done' : 'idle', 'ai-spark', 'Muse Spark',
      stage === 'waiting' ? 'is waiting for you to hold the item up' : lot.concept ? `sees “${esc(lot.concept)}”` : 'looks at the picture',
      lot.framePath && !lot.box ? `<img src="${esc(lot.framePath)}" alt="What the camera saw" />` : '');
    row(lot.box ? 'done' : stage === 'segment' ? 'run' : lot.wholePhoto ? 'skip' : lot.visionMiss ? 'skip' : 'idle', 'ai-sam', 'SAM 3.1',
      lot.box ? 'cut the item out of the picture' : lot.wholePhoto ? 'used your whole photo' : lot.visionMiss ? 'couldn’t find it in the picture' : 'cuts the item out of the picture',
      lot.box && lot.framePath ? `<span class="boxed"><img src="${esc(lot.framePath)}" alt="Camera frame" /><span class="samBox" style="left:${lot.box.x1 * 100}%;top:${lot.box.y1 * 100}%;width:${(lot.box.x2 - lot.box.x1) * 100}%;height:${(lot.box.y2 - lot.box.y1) * 100}%"></span></span>` : '');
    if (S.ai.image && !lot.visionMiss) {
      row(lot.cleanPath ? 'done' : stage === 'clean' ? 'run' : 'idle', 'ai-image', 'Muse Image',
        lot.cleanPath ? 'made a clean product photo' : 'makes a clean product photo',
        lot.cleanPath ? `<img src="${esc(lot.cleanPath)}" alt="Clean product photo" />` : '');
    }
  } else if (lot.imagePath) {
    row('done', 'home-demo', 'Demo script', 'supplied the picture');
  }
  const heard = lot.transcript?.length;
  if (S.ai.asr || heard) row(heard ? 'done' : 'idle', 'ai-voice', S.ai.asr ? 'Muse Voice' : 'Captions', heard ? `heard you describe it` : 'listens while you describe it');
  const src = lot.listingSource;
  row(src ? 'done' : heard ? 'run' : 'idle', 'ai-write', src && src !== 'heuristic' && src !== 'scripted' ? modelName(src) : 'Listing',
    src ? 'wrote the listing' : heard ? 'is writing the listing…' : 'writes the listing from what you say',
    lot.listingConfidence ? `${Math.round(lot.listingConfidence * 100)}% sure` : '');
  if (S.ai.spark) {
    const rs = lot.researchStage;
    const found = lot.research?.product || lot.research?.title;
    row(rs === 'done' ? 'done' : rs === 'running' ? 'run' : rs === 'failed' ? 'skip' : 'idle', 'btn-look', 'Muse Spark + web search',
      rs === 'done' ? (found ? `found “${esc(found)}”` : 'couldn’t pin down the exact product') : rs === 'running' ? 'is looking the product up online…' : rs === 'failed' ? 'couldn’t look it up this time' : 'looks the product up online for a full description',
      rs === 'done' && lot.research?.confidence ? `${Math.round(lot.research.confidence * 100)}% sure` : '');
  }
  row(lot.wooProductId ? 'done' : lot.status === 'published' ? 'run' : 'idle', 'setup-shop', S.commerce === 'woo' ? 'WooCommerce' : 'Shop',
    lot.wooProductId ? `product #${lot.wooProductId} created` : 'creates the product when you publish');
  return `<h3>Meta AI on Lot ${lot.lotNumber}</h3><ol>${rows.join('')}</ol>`;
}

function sizesText(lot) {
  if (lot.variants.length === 1 && lot.variants[0].key === 'default') return '';
  return lot.variants.map((v) => ((lot.initialStock?.[v.key] ?? 1) > 1 ? `${v.label}×${lot.initialStock[v.key]}` : v.label)).join(', ');
}

function lotFormHtml(lot) {
  const live = lot.status === 'published' || lot.status === 'sold_out';
  const said = (lot.transcript || []).map((t) => t.text).join(' ');
  const claims = [...S.claims.values()].filter((c) => c.itemId === lot.id);
  const count = (key, states) => claims.filter((c) => c.variant === key && states.includes(c.state)).reduce((a, c) => a + c.qty, 0);
  const stock = lot.variants.map((v) => {
    const left = lot.stock[v.key] ?? 0;
    const paid = count(v.key, ['paid']);
    const held = count(v.key, ['reserved', 'invoiced']);
    const label = v.key === 'default' ? 'In stock' : v.label;
    return `<span class="${left === 0 ? 'gone' : ''}">${esc(label)} ${left}<small>left${held ? `, ${held} held` : ''}${paid ? `, ${paid} paid` : ''}</small></span>`;
  }).join('');
  const qty = lot.variants.length === 1 && lot.variants[0].key === 'default' ? (lot.initialStock?.default ?? 1) : '';
  const posts = S.show?.mode === 'post';
  const miss = !live && lot.visionMiss
    ? `<div class="miss">${art('vision-miss')}<p>${lot.concept && lot.concept !== 'product' ? `Couldn’t spot the ${esc(lot.concept)} in the picture.` : lot.fromPhoto ? 'Couldn’t find the item in your photo.' : 'Nothing was held up to the camera.'} ${lot.fromPhoto ? 'Type the title and price below, or upload a closer photo.' : 'Hold it up inside the box and look again, or upload a photo.'}</p>
        ${lot.fromPhoto ? '' : `<button type="button" class="bb small" data-act="look">${art('btn-look')}<span>Look again</span></button>`}</div>`
    : '';
  const describe = !live ? `<div class="describe"><input name="say" placeholder="Describe it: brand, size, price, how many" aria-label="Describe the item" /><button type="button" class="bb small" data-act="say">${art('ai-write')}<span>Add</span></button></div>` : '';
  return `<form class="lot-form" data-lot="${lot.id}" autocomplete="off">
    ${miss}
    ${said ? `<div class="said">${art('ai-voice', 's')}<q>${esc(said.slice(-400))}</q></div>` : ''}
    ${describe}
    <label class="field"><span>Title</span><input class="title-input" name="title" value="${esc(lot.title)}" placeholder="What is it?" /></label>
    <div class="row2">
      <label class="field"><span>Price (${esc(sym())})</span><input class="price-input" name="price" inputmode="decimal" value="${lot.price ?? ''}" placeholder="0" /></label>
      ${live ? `<div class="field"><span>Stock</span><div class="stock">${stock}</div></div>`
        : `<label class="field"><span>Sizes, or how many</span><input name="sizes" value="${esc(sizesText(lot) || (qty > 1 ? String(qty) : ''))}" placeholder="M, or 9, 10, or 3" /></label>`}
    </div>
    ${descriptionHtml(lot)}
    ${lot.publishError ? `<p class="err">The shop said: ${esc(lot.publishError)}. Publishing again will retry.</p>` : ''}
    ${postsHtml(lot)}
    <div class="form-actions${live ? '' : ' sticky'}">
      ${live ? `<button type="submit" class="bb wide" name="save">${art('step-publish')}<span>Save changes</span></button>`
        : `<button type="submit" class="bb go wide" name="publish" ${lot.price ? '' : 'disabled'}>${art('step-publish')}<span>${posts ? 'Publish and post' : 'Publish'} ${lot.price ? money(sym(), lot.price) : ''}<small>${lot.price ? 'or press Enter' : 'Add a price first'}</small></span></button>
           <div class="more">
             ${lot.fromPhoto ? '' : `<button type="button" class="bb small" data-act="look" title="Look at the camera again for this item">${art('btn-look')}<span>Look again</span></button>`}
             <button type="button" class="bb small danger" data-act="cancel-lot">${art('btn-remove')}<span>Remove</span></button>
           </div>`}
    </div>
  </form>`;
}

function descriptionHtml(lot) {
  const r = lot.research;
  const by = lot.descriptionSource === 'research' ? 'Written by Muse Spark from the photo and a web search' : lot.descriptionSource === 'seller' ? 'Your words' : lot.researchStage === 'running' ? 'Muse Spark is looking it up online…' : '';
  const facts = r?.facts?.length ? `<ul class="facts">${r.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '';
  const sources = r?.sources?.length ? `<p class="sources">Sources: ${r.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`).join(', ')}</p>` : '';
  const again = S.ai.spark && !['published', 'sold_out'].includes(lot.status)
    ? `<button type="button" class="linkish" data-act="research">${lot.researchStage === 'done' ? 'Look it up again' : 'Look it up online'}</button>` : '';
  return `<label class="field"><span>Description ${by ? `<small class="by">${esc(by)}</small>` : ''}</span>
      <textarea name="description" rows="5" placeholder="What a buyer should know. Muse Spark fills this in from the photo and a web search.">${esc(lot.description || '')}</textarea></label>
    ${facts || sources || again ? `<div class="research">${facts}${sources}${again}</div>` : ''}`;
}

function postsHtml(lot) {
  const p = lot.posts;
  if (!p) return '';
  if (p.pending) return '<p class="hint posts">Posting to your Page and Instagram…</p>';
  if (p.error) return `<p class="err">Posting failed: ${esc(p.error)}</p>`;
  const item = (name, v) => (v?.id ? (v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">See the ${name} post</a>` : `<span>${name} post</span>`) : v?.error ? `<span class="err">${name}: ${esc(v.error)}</span>` : '');
  return `<p class="posts">${[item('Facebook', p.facebook), item('Instagram', p.instagram)].filter(Boolean).join(' ')}</p>`;
}

function parseSizes(text) {
  const t = String(text || '').trim();
  if (!t) return { variants: [], quantity: 1 };
  if (/^\d+$/.test(t) && Number(t) <= 50 && !/,/.test(t)) {
    // A lone number is a quantity unless it looks like a shoe size the seller meant as a size.
    return Number(t) <= 5 ? { variants: [], quantity: Number(t) } : { variants: [{ label: t, qty: 1 }], quantity: 1 };
  }
  const variants = t.split(/\s*[,/·]\s*|\s+and\s+/i).filter(Boolean).map((p) => {
    const m = p.match(/^(.+?)\s*(?:[×x*:]\s*(\d+))?$/i);
    return { label: m[1].trim(), qty: Number(m[2] || 1) };
  });
  return { variants, quantity: 1 };
}

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'postForm') {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/show/start', { platforms: ['facebook', 'instagram'], mode: 'post', fbPostId: f.fbPostId.value, igMediaId: f.igMediaId.value });
      toast('Selling on your posts. “sold” comments are being read.');
    } catch (err) { toast(err.message, true); }
    return;
  }
  const form = e.target;
  if (!form.classList.contains('lot-form')) return;
  e.preventDefault();
  const lotId = form.dataset.lot;
  const lot = S.lots.get(lotId);
  const body = { title: form.title.value, price: form.price.value, ...(form.description ? { description: form.description.value } : {}) };
  if (form.sizes) Object.assign(body, parseSizes(form.sizes.value));
  try {
    await api(`/api/lot/${lotId}/override`, body);
    if (lot.status !== 'published' && lot.status !== 'sold_out') {
      await api(`/api/lot/${lotId}/publish`);
      toast(`Lot ${lot.lotNumber} is on sale`);
    } else toast('Saved');
    document.activeElement?.blur();
  } catch (err) { toast(err.message, true); }
});

// -------------------------------------------------------------- needs you
let lastReviewKey = '';
function renderReview() {
  const items = [...S.claims.values()].filter((c) => c.state === 'needs_review').sort((a, b) => a.at - b.at);
  const key = items.map((c) => c.id + c.reason).join('|') + [...S.lots.keys()].length;
  if (key === lastReviewKey) return;
  if ($('#review').contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  lastReviewKey = key;
  const lots = activeLots();
  $('#review').innerHTML = items.map((c) => {
    const lot = c.itemId ? S.lots.get(c.itemId) : null;
    const opts = lots.map((l) => `<option value="${l.lotNumber}" ${l.id === c.itemId ? 'selected' : ''}>Lot ${l.lotNumber}: ${esc(l.title || l.concept || '…')}</option>`).join('');
    const sizes = lot && lot.variants.length > 1 ? `<select name="size" aria-label="Size">${lot.variants.map((v) => `<option value="${esc(v.key)}">${esc(v.label)}</option>`).join('')}</select>` : '';
    return `<div class="rv" data-claim="${c.id}">${art('state-needs-you')}
      <div class="rv-top"><span class="who">${esc(c.displayName)} might want to buy</span><span class="text">“${esc(c.text)}”</span><span class="why">${esc(c.reason || 'LiveLot isn’t sure')}</span></div>
      <div class="rv-actions"><select name="lot" aria-label="Lot">${opts}</select>${sizes}
        <button class="bb small go" data-act="approve"><span>Give it to them</span></button>
        <button class="bb small" data-act="reject"><span>Not a buyer</span></button></div></div>`;
  }).join('');
}

// ---------------------------------------------------------------- comments
function renderFeed() {
  const comments = S.comments.slice(-150).reverse();
  const now = S.now();
  const wants = S.stats.claims || 0;
  $('#feedHint').textContent = comments.length ? `${comments.length} comment${comments.length === 1 ? '' : 's'}, ${wants} wanting to buy` : 'Muse Spark reads every one and spots the buyers';
  if (!comments.length) {
    $('#feed').innerHTML = `<li class="feed-empty">${art('empty-comments', 'xl')}<span>Comments from Facebook and Instagram show up here, with what LiveLot did about each one.</span></li>`;
    return;
  }
  $('#feed').innerHTML = comments.map((c) => {
    const claim = c.claimId ? S.claims.get(c.claimId) : null;
    const fresh = !seenComments.has(c.id);
    seenComments.add(c.id);
    const initial = esc((c.from?.name || '?').replace(/^@/, '').slice(0, 1).toUpperCase());
    const cls = c.classification;
    let out = '';
    let why = '';
    if (claim) {
      const lot = claim.itemId ? S.lots.get(claim.itemId) : null;
      const variant = lot && claim.variant && claim.variant !== 'default' ? lot.variants.find((v) => v.key === claim.variant)?.label : claim.requestedSize;
      const label = claim.state === 'waitlisted' ? `In line, #${claim.waitlistPosition}` : STATE_LABEL[claim.state];
      out = `<span class="verdict ${claim.state}">${art(STATE_ART[claim.state])}${label}</span>
        ${lot ? `<span class="lotref">Lot ${lot.lotNumber}${variant ? `, size ${esc(variant)}` : ''}${claim.qty > 1 ? ` ×${claim.qty}` : ''}</span>` : ''}
        ${['reserved', 'invoiced', 'waitlisted', 'matched'].includes(claim.state) ? `<button class="bb small" data-act="undo" data-claim="${claim.id}"><span>Undo</span></button>` : ''}
        ${claim.error ? `<button class="bb small" data-act="retry" data-claim="${claim.id}"><span>Retry</span></button>` : ''}`;
      why = claim.error ? `<span class="err">${esc(claim.error)}</span>` : claim.replyError ? `<span class="err">Reply failed: ${esc(claim.replyError)}</span>` : esc(claim.reason || claim.match?.reason || '');
    } else if (c.kind === 'chatter') {
      out = `<span class="src">not a buyer</span>`;
    } else if (c.kind === 'pending') {
      out = `<span class="src">reading…</span>`;
    }
    const src = cls ? `<span class="src">${art(modelArt(cls.source))}${esc(modelName(cls.source))}${cls.ms ? `, ${(cls.ms / 1000).toFixed(1)} s` : ''}</span>` : '';
    return `<li class="c ${c.kind}${fresh ? ' fresh' : ''}">
      <span class="av ${c.platform}" title="${c.platform}">${initial}</span>
      <div><div class="who">${esc(c.from?.name)}<time>${ago(now, c.receivedAt || c.at)}</time></div>
        <div class="text">${esc(c.text)}</div>${why ? `<div class="why">${why}</div>` : ''}</div>
      <div class="out">${out}${src}</div></li>`;
  }).join('');
}

// ---------------------------------------------------------------- buyers
function renderOrders() {
  const orders = [...S.orders.values()];
  const rank = { open: 0, paid: 1, cancelled: 2 };
  orders.sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt - a.createdAt);
  const now = S.now();
  const st = S.stats || {};
  $('#ordersHint').textContent = orders.length ? `${st.paidOrders || 0} of ${st.orders || 0} paid` : '';
  const waitlisted = [...S.claims.values()].filter((c) => c.state === 'waitlisted');
  if (!orders.length && !waitlisted.length) {
    $('#orders').innerHTML = `<div class="orders-empty">${art('empty-buyers', 'xxl')}<span class="t">No buyers yet</span><p>When someone comments “sold”, they show up here with the pay link LiveLot sent them.</p></div>`;
    return;
  }
  const html = orders.map((o) => {
    const buyer = S.buyers.get(o.buyerId) || {};
    const claims = [...S.claims.values()].filter((c) => c.orderId === o.id || o.claimIds.includes(c.id));
    const lines = claims.map((c) => {
      const lot = S.lots.get(c.itemId);
      const v = lot && c.variant !== 'default' ? lot.variants.find((x) => x.key === c.variant)?.label : '';
      const gone = ['expired', 'cancelled'].includes(c.state);
      return `<li class="${gone ? 'x' : ''}"><span class="tag small">${lot?.lotNumber ?? '?'}</span>${esc(lot?.title || '')}${v ? ` (${esc(v)})` : ''}${c.qty > 1 ? ` ×${c.qty}` : ''}<span class="p">${money(sym(), (lot?.price || 0) * c.qty)}</span></li>`;
    }).join('');
    const live = claims.filter((c) => c.state === 'invoiced' || c.state === 'reserved');
    const exp = live.length ? Math.min(...live.map((c) => c.expiresAt || Infinity)) : null;
    const reply = [...S.replies].reverse().find((r) => r.buyerId === o.buyerId && (r.kind === 'private' || r.kind === 'dm'));
    const platform = buyer.platform || claims[0]?.platform;
    const state = o.status === 'paid'
      ? `${art('paid')}<span class="what">Paid${o.paidVia ? `<small>via ${esc(o.paidVia)}</small>` : ''}</span>`
      : o.status === 'cancelled' ? `${art('state-expired')}<span class="what">Released<small>They didn’t pay in time</small></span>`
        : `${art('state-link-sent')}<span class="what">Pay link sent<small>${exp && exp !== Infinity ? `<span class="count${exp - now < 120000 ? ' late' : ''}" data-expires="${exp}">${clockText(exp - now)}</span> left to pay` : 'Waiting for payment'}${o.openedAt ? ', link opened' : ''}</small></span>
           <button class="bb small" data-act="paid" data-order="${o.id}"><span>Mark paid</span></button>`;
    const bubble = reply ? `<div class="bubble ${platform === 'instagram' ? 'ig' : ''} ${reply.ok ? '' : 'fail'}">
        <span>${esc(reply.text)}</span>${reply.url && reply.ok ? `<a class="paybtn" href="${esc(reply.url)}" target="_blank" rel="noopener">${esc(reply.buttonTitle || 'Pay now')}</a>` : ''}
        <small>${reply.ok ? `${platform === 'instagram' ? 'Instagram' : 'Messenger'} private reply` : `Not delivered: ${esc(reply.error)}`}</small></div>` : '';
    return `<article class="ord ${o.status}">
      <div class="ord-top"><span class="av ${platform}">${esc((buyer.displayName || '?').replace(/^@/, '').slice(0, 1).toUpperCase())}</span><span class="name">${esc(buyer.displayName || 'Buyer')}</span><span class="total">${money(sym(), o.total)}</span></div>
      <ul class="lines">${lines}</ul>
      <div class="ord-state">${state}</div>
      ${o.status === 'open' ? bubble : ''}
    </article>`;
  }).join('');
  const wl = waitlisted.length ? `<div class="wl">${art('state-waitlist')}<span><b>Waiting in line:</b> ${waitlisted.sort((a, b) => a.at - b.at).map((c) => `${esc(c.displayName)} (Lot ${c.lotNumber}, #${c.waitlistPosition})`).join(', ')}</span></div>` : '';
  $('#orders').innerHTML = html + wl;
}

// ---------------------------------------------------------------- your items
function renderRail() {
  const lots = activeLots().reverse();
  const cur = currentLot();
  if (!lots.length) {
    $('#rail').innerHTML = `<li class="rail-empty">${art('empty-item', 'l')}<span>Items you add line up here.</span></li>`;
    return;
  }
  $('#rail').innerHTML = lots.map((l) => {
    const total = Object.values(l.initialStock || {}).reduce((a, n) => a + n, 0);
    const left = Object.values(l.stock || {}).reduce((a, n) => a + n, 0);
    const img = l.imagePath || l.cleanPath || l.cropPath || l.framePath;
    return `<li><button class="rl" data-lot="${l.id}" aria-current="${cur?.id === l.id}">
      <span class="img ${l.status === 'sold_out' ? 'sold' : ''}" style="${img ? `background-image:url('${esc(img)}')` : ''}"></span>
      <span class="tag small">Lot ${l.lotNumber}</span>
      <span class="t">${esc(l.title || l.concept || 'Untitled')}</span>
      <span class="pr">${money(sym(), l.price)}</span>
      <span class="m">${l.status === 'published' || l.status === 'sold_out' ? `${left} of ${total} left` : LOT_LABEL[l.status]}</span></button></li>`;
  }).join('');
}

// --------------------------------------------------------------- behind the scenes
function renderTrace() {
  const el = $('#trace');
  const t = S.traces;
  $('#behindHint').textContent = t.length ? `${t.length} calls so far. Every Meta AI call, as it happens.` : 'Every Meta AI call, as it happens';
  if (!$('#behind').open) return;
  if (traceTab === 'log') {
    const logs = S.logs.slice(-80).reverse();
    el.innerHTML = logs.length ? logs.map((l) => `<li class="tr ${l.level}">${art('ai-rule', 'bare')}<span class="what" title="${esc(l.msg)}"><span class="model">${esc(l.level)}</span> ${esc(l.msg)}${l.extra ? `: ${esc(l.extra)}` : ''}</span><span class="ms"></span></li>`).join('') : '<li class="trace-empty">Nothing logged yet.</li>';
    return;
  }
  const models = Object.values(S.ai || {}).filter(Boolean).map(modelName);
  el.innerHTML = t.length ? t.slice(-60).reverse().map((x) => `<li class="tr ${x.ok ? '' : 'fail'}">${art(modelArt(x.model))}<span class="what" title="${esc(x.summary || '')}"><span class="model">${esc(modelName(x.model))}</span> ${esc(x.purpose || '')}${x.summary ? `: ${esc(x.summary)}` : ''}</span><span class="ms">${x.ms ?? ''} ms</span></li>`).join('')
    : `<li class="trace-empty">${models.length ? `Connected: ${models.join(', ')}. Calls show up here as they happen.` : 'Running without a Meta Model API key, so the built-in rules and speech parser stand in. Add MODEL_API_KEY to use Muse Spark, SAM 3.1, Muse Voice and Muse Image.'}</li>`;
}
$('#behind').addEventListener('toggle', renderTrace);

// ------------------------------------------------------------- actions
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act], .rl, .chip, .tabs button');
  if (!b) {
    if (!e.target.closest('.menu-pop')) document.querySelectorAll('.menu-pop').forEach((m) => { m.hidden = true; });
    return;
  }
  if (b.classList.contains('rl')) { selectedLotId = b.dataset.lot; lastFormKey = ''; render(); return; }
  if (b.classList.contains('chip')) { sendComment(b.dataset.text); return; }
  if (b.dataset.tab) {
    traceTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderTrace();
    return;
  }
  const act = b.dataset.act;
  const lotForm = () => b.closest('form') || document.querySelector('.lot-form');
  try {
    switch (act) {
      case 'menu': {
        const pop = b.nextElementSibling;
        pop.hidden = !pop.hidden;
        b.setAttribute('aria-expanded', String(!pop.hidden));
        return;
      }
      case 'existing': {
        const f = $('#postForm');
        f.hidden = !f.hidden;
        b.setAttribute('aria-expanded', String(!f.hidden));
        if (!f.hidden) f.fbPostId.focus();
        return;
      }
      case 'start': await api('/api/show/start', { platforms: ['facebook', 'instagram'] }); toast('Live show started. Comments are being read.'); break;
      case 'start-posts': await api('/api/show/start', { platforms: ['facebook', 'instagram'], mode: 'post' }); toast('Selling with posts. Add your first item.'); break;
      case 'cam-on': await cameraOn(); return;
      case 'cam-off': cameraOff(); return;
      case 'mic-test': {
        b.disabled = true;
        b.querySelector('span:last-child').textContent = 'Speak now…';
        try {
          const text = await studio.testMic(4);
          toast(text ? `Muse Voice heard: “${text.slice(0, 80)}”` : 'Muse Voice heard nothing. Speak closer, or pick another microphone.', !text);
        } finally {
          b.disabled = false;
          b.querySelector('span:last-child').textContent = 'Test mic';
        }
        return;
      }
      case 'end': await api('/api/show/end'); toast('Stopped selling'); break;
      case 'next': await nextLot(); break;
      case 'replay': await api('/api/replay/start', { fixture: 'demo-show', speed: 1 }); toast('Demo show: pretend buyers, nothing real is sold'); break;
      case 'ff': { const r = await api('/api/dev/advance', { sec: S.config.claimTtlSec || 900 }); toast(r.expired ? `${r.expired} unpaid hold(s) released` : 'Skipped ahead, nothing expired'); break; }
      case 'recap': window.open('/recap/', '_blank'); break;
      case 'overlay': window.open('/overlay/', '_blank'); break;
      case 'studio': window.open('/capture/', '_blank'); break;
      case 'reset': if (window.confirm('Stop selling and clear all items, comments and orders?')) { await api('/api/show/reset'); location.reload(); } break;
      case 'undo': await api(`/api/claim/${b.dataset.claim}/undo`); toast('Undone. The item is free again.'); break;
      case 'retry': await api(`/api/claim/${b.dataset.claim}/retry`); break;
      case 'paid': await api(`/api/order/${b.dataset.order}/paid`); break;
      case 'approve': {
        const card = b.closest('.rv');
        await api(`/api/claim/${card.dataset.claim}/approve`, { lotNumber: Number(card.querySelector('[name=lot]').value), size: card.querySelector('[name=size]')?.value });
        lastReviewKey = '';
        break;
      }
      case 'reject': await api(`/api/claim/${b.closest('.rv').dataset.claim}/reject`); lastReviewKey = ''; break;
      case 'photo': $('#photoInput').click(); return;
      case 'look': {
        if (!studio.isOn()) { toast('Turn on the camera first, or upload a photo', true); return; }
        const form = lotForm();
        if (!form) return;
        await api(`/api/lot/${form.dataset.lot}/look`);
        lastFormKey = '';
        toast('Hold the item up inside the box');
        break;
      }
      case 'say': {
        const input = b.closest('form').say;
        if (!input.value.trim()) return;
        await api('/api/speech', { text: input.value.trim(), final: true, source: 'typed' });
        input.value = '';
        toast('Writing the listing…');
        break;
      }
      case 'cancel-lot': await api(`/api/lot/${b.closest('form').dataset.lot}/cancel`); selectedLotId = null; break;
      case 'research': await api(`/api/lot/${b.closest('form').dataset.lot}/research`); lastFormKey = ''; toast('Looking it up online…'); break;
      default: return;
    }
  } catch (err) {
    toast(err.message, true);
  }
  document.querySelectorAll('.menu-pop').forEach((m) => { m.hidden = true; });
});

async function nextLot() {
  const f = $('#camFlash');
  f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
  const r = await api('/api/next-lot', {});
  selectedLotId = null;
  lastFormKey = '';
  toast(`Lot ${r.lot.lotNumber}: hold it up, then say what it is and the price`);
}

document.addEventListener('keydown', (e) => {
  // Enter in the "Describe it" box adds the description; it must not publish the lot.
  if (e.target?.name === 'say' && e.key === 'Enter') {
    e.preventDefault();
    e.target.closest('form')?.querySelector('[data-act=say]')?.click();
    return;
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'N') {
    if (S.show?.status === 'live') nextLot().catch((err) => toast(err.message, true));
  } else if (e.key === 'Enter') {
    if (document.activeElement?.tagName === 'BUTTON' || document.activeElement?.tagName === 'SUMMARY') return;
    const form = document.querySelector('.lot-form');
    if (form?.publish && !form.publish.disabled) form.requestSubmit(form.publish);
  } else if (e.key === 'Escape') {
    document.querySelectorAll('.menu-pop').forEach((m) => { m.hidden = true; });
  }
});

// ------------------------------------------------------------ photo lots
// Downscale on the device (phone photos are 3-8 MB), then send the JPEG; the server runs
// Spark glance -> SAM 3.1 -> crop -> Muse Image on exactly this picture.
document.body.insertAdjacentHTML('beforeend', '<input type="file" id="photoInput" accept="image/*" hidden />');
$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    const res = await fetch('/api/lot/photo', { method: 'POST', headers: authHeaders({ 'Content-Type': 'image/jpeg' }), body: blob });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    selectedLotId = null;
    lastFormKey = '';
    toast(`Lot ${data.lot.lotNumber}: looking at your photo. Add a price, or describe it.`);
  } catch (err) { toast(err.message, true); }
});

// -------------------------------------------------------------- pretend buyer
$('#tester').addEventListener('toggle', (e) => { if (e.isTrusted) e.target.dataset.touched = '1'; });
const QUICK = ['sold', 'mine!', 'size 10 please', 'sold lot 1', "I'll take the blue one", 'is it sold?', 'how much is postage?'];
$('#quick').innerHTML = QUICK.map((t) => `<button type="button" class="chip" data-text="${esc(t)}">${esc(t)}</button>`).join('');
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = e.target.text.value.trim();
  if (!text) return;
  sendComment(text);
  e.target.text.value = '';
});
async function sendComment(text) {
  const f = $('#composer');
  try {
    await api('/api/comment', { text, name: f.name.value || 'Viewer', platform: f.platform.value });
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------- misc
/** LiveLot was updated while this page was open: reload, unless that would interrupt the seller. */
function newVersion() {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (!studio.isOn() && !typing) { location.reload(); return; }
  if (document.getElementById('updateBar')) return;
  document.body.insertAdjacentHTML('beforeend', '<div class="update-bar" id="updateBar" role="status">LiveLot was updated. <button class="bb small primary" type="button" id="updateNow"><span>Reload</span></button></div>');
  document.getElementById('updateNow').onclick = () => location.reload();
}
let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

setInterval(() => {
  const now = S.now();
  document.querySelectorAll('[data-expires]').forEach((el) => {
    const left = Number(el.dataset.expires) - now;
    el.textContent = clockText(left);
    el.classList.toggle('late', left < 120000);
  });
  const dot = document.querySelector('.live-dot[data-since]');
  if (dot) dot.textContent = `${dot.dataset.label || 'Live'} ${clockText(now - Number(dot.dataset.since))}`;
}, 1000);

window.__livelotReady = true;
