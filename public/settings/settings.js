import { api, esc } from '/shared/live.js';

const $ = (s) => document.querySelector(s);
const art = (name, size = '') => `<span class="art ${size}" style="--art:url(/art/${name}.webp)" aria-hidden="true"></span>`;
const TESTABLE = new Set(['shop', 'meta', 'ai']);
const PERMS = ['pages_show_list', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_posts', 'pages_manage_engagement', 'pages_manage_metadata', 'pages_messaging', 'business_management', 'publish_video', 'instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages', 'instagram_content_publish'];
let connectToken = '';
const STATE_TEXT = {
  shop: ['Set up', 'Practice shop'],
  meta: ['Set up', 'Not connected yet'],
  ai: ['Set up', 'Not set up'],
};
function badge(id) {
  const st = data.settings.status[id];
  if (st === undefined) return { cls: 'none', text: '' };
  if (st && tested[id] === true) return { cls: 'ok', text: 'Working' };
  if (st && tested[id] === false) return { cls: 'bad', text: 'Not working' };
  return { cls: st ? 'ok' : '', text: STATE_TEXT[id][st ? 0 : 1] };
}

let data = null; // { settings, selling }
const tested = {}; // section -> true/false from the last Test connection
const removed = new Set(); // secrets the seller asked to remove, not yet saved

async function load() {
  try {
    data = await api('/api/settings', null, 'GET');
    renderAll();
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  } catch (err) {
    $('#sections').innerHTML = `<div class="err-box">Couldn’t load the settings: ${esc(err.message)}</div>`;
  }
}

function renderAll() {
  const { settings, selling } = data;
  $('#sellingNote').hidden = !selling;
  $('#jump').innerHTML = settings.sections.map((s) => {
    const b = badge(s.id);
    return `<a href="#${s.id}">${art(s.art)}${esc(s.title)}${b.cls === 'none' ? '' : `<span class="dot ${b.cls}" title="${esc(b.text)}"></span>`}</a>`;
  }).join('');
  $('#sections').innerHTML = settings.sections.map(sectionHtml).join('');
}

function sectionHtml(sec) {
  const { settings, selling } = data;
  const fields = settings.fields.filter((f) => f.section === sec.id);
  const main = fields.filter((f) => !f.advanced);
  const adv = fields.filter((f) => f.advanced);
  const b = badge(sec.id);
  const locked = selling && !sec.live;
  return `<section class="card sec" id="${sec.id}" data-section="${sec.id}">
    <div class="sec-head">${art(sec.art)}<h2>${esc(sec.title)}</h2>
      <span class="state ${b.cls}">${esc(b.text)}</span>
      <p>${esc(sec.text)}</p></div>
    <form class="fields ${locked ? 'locked' : ''}" autocomplete="off">
      ${sec.id === 'meta' ? linkedHtml() : ''}
      ${main.map(fieldHtml).join('')}
      ${infoHtml(sec.id)}
      ${adv.length ? `<details class="more"><summary>More options</summary><div class="fields">${adv.map(fieldHtml).join('')}</div></details>` : ''}
    </form>
    <div class="sec-actions">
      ${locked ? '<p class="hint">Press <b>Stop selling</b> on the dashboard to change these.</p>' : `
      <button class="bb primary" data-save="${sec.id}">${art('step-publish')}<span>Save</span></button>
      ${TESTABLE.has(sec.id) ? `<button class="bb" data-test="${sec.id}">${art('btn-look')}<span>Test connection</span></button>` : ''}
      ${sec.id === 'meta' ? `<button class="bb" data-livetest>${art('home-live')}<span>Can this Page go live?</span></button>` : ''}`}
      <span class="result" id="result-${sec.id}" aria-live="polite"></span>
    </div>
  </section>`;
}

function fieldHtml(f) {
  const id = `f-${f.key.replace(/\W/g, '-')}`;
  const help = f.help ? `<span class="help">${esc(f.help)}</span>` : '';
  if (f.type === 'toggle') {
    return `<div class="f wide"><label class="switch"><input type="checkbox" id="${id}" data-key="${f.key}" ${f.value ? 'checked' : ''} /><span class="knob"></span>${esc(f.label)}</label>${help}</div>`;
  }
  if (f.type === 'secret') {
    const gone = removed.has(f.key);
    const status = gone ? '<span class="saved none">Will be removed when you save</span>'
      : f.set ? `<span class="saved">✓ Saved, ends in ${esc(f.hint.replace('…', ''))} <button type="button" data-remove="${f.key}">Remove</button></span>`
        : '<span class="saved none">Not set yet</span>';
    return `<div class="f"><label for="${id}">${esc(f.label)}</label>
      <input type="password" id="${id}" data-key="${f.key}" placeholder="${f.set && !gone ? 'Type a new one to replace it' : esc(f.placeholder || 'Paste it here')}" autocomplete="new-password" spellcheck="false" />
      ${status}${help}</div>`;
  }
  if (f.type === 'number') {
    return `<div class="f"><label for="${id}">${esc(f.label)}</label>
      <span class="with-unit"><input type="number" id="${id}" data-key="${f.key}" value="${esc(f.value)}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} step="any" inputmode="decimal" />${f.unit ? `<span>${esc(f.unit)}</span>` : ''}</span>${help}</div>`;
  }
  const wide = f.type === 'url' ? ' wide' : '';
  return `<div class="f${wide}"><label for="${id}">${esc(f.label)}</label>
    <input type="${f.type === 'url' ? 'url' : 'text'}" id="${id}" data-key="${f.key}" value="${esc(f.value)}" placeholder="${esc(f.placeholder)}" spellcheck="false" />${help}</div>`;
}

function infoHtml(section) {
  const { links, fields } = data.settings;
  const copy = (text) => `<span class="copy"><code>${esc(text)}</code><button type="button" data-copy="${esc(text)}">Copy</button></span>`;
  if (section === 'meta') {
    const verify = fields.find((f) => f.key === 'meta.verifyToken')?.value || '';
    const linked = Boolean(data.settings.connected?.page);
    const box = `<div class="connect">
        <b class="connect-title">Connect your Page with one token</b>
        <ol>
          <li>Fill in the <b>App ID</b> and <b>App secret</b> above.</li>
          <li>Open <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener">Graph API Explorer</a>. At the top right, pick your LiveLot app under <b>Meta App</b>.</li>
          <li>Under <b>Permissions</b>, add each of these: ${copy(PERMS.join(', '))}</li>
          <li>Press <b>Generate Access Token</b>. In the Facebook window, tick your Page (and its Instagram account), then copy the token.</li>
        </ol>
        <div class="connect-row"><input type="password" id="connectToken" placeholder="Paste the token from Graph API Explorer" autocomplete="off" spellcheck="false" />
          <button type="button" class="bb primary" data-connect>${art('setup-meta')}<span>Connect</span></button></div>
        <div id="connectOut" aria-live="polite"></div>
      </div>`;
    return `${linked ? `<details class="connect-more" id="connectMore"><summary>Connect a different Page</summary>${box}</details>` : box}
      <div class="info"><span>Optional, makes comments arrive instantly: in your Meta app under <b>Webhooks</b>, choose <i>Page</i>, subscribe to <i>feed</i> and <i>messages</i>, and use:</span>
      <span>Callback URL ${copy(links.webhook)}</span><span>Verify token ${copy(verify)}</span></div>`;
  }
  if (section === 'shop') {
    return `<div class="info"><span>So payments show up the moment a buyer pays, add these two lines to <b>wp-config.php</b> on your WordPress site (the helper plugin is in the LiveLot repo):</span>
      ${copy(`define('LIVELOT_URL', '${links.paidPing}');`)}
      <span><code>define('LIVELOT_SECRET', '…');</code> with the <b>Payment notice secret</b> from “More options” below.</span></div>`;
  }
  return '';
}

/** Which Page (and Instagram account) LiveLot sells through, with Switch and Disconnect. */
function linkedHtml() {
  const c = data.settings.connected || {};
  if (!c.page) return '';
  const name = c.page.name || `Page ${c.page.id}`;
  return `<div class="linked">${art('setup-meta')}
    <div class="linked-text"><b>Connected to the Facebook Page “${esc(name)}”</b>
      <span><a href="https://www.facebook.com/${esc(c.page.id)}" target="_blank" rel="noopener">Open the Page</a></span>
      <span>${c.instagram ? `Instagram: @${esc(c.instagram.username || c.instagram.id)}` : 'No Instagram account linked, so LiveLot sells on Facebook only.'}</span></div>
    <div class="linked-actions">
      <button type="button" class="bb small" data-switch><span>Switch Page</span></button>
      <button type="button" class="bb small danger" data-disconnect><span>Disconnect</span></button>
    </div></div>`;
}

let disconnectArmed = 0;
async function disconnect(b) {
  if (Date.now() - disconnectArmed > 5000) {
    disconnectArmed = Date.now();
    b.querySelector('span').textContent = 'Yes, disconnect';
    result('meta', 'bad', 'Press again to disconnect. LiveLot will stop posting to this Page and reading its comments.');
    setTimeout(() => { if (b.isConnected && Date.now() - disconnectArmed >= 5000) b.querySelector('span').textContent = 'Disconnect'; }, 5100);
    return;
  }
  disconnectArmed = 0;
  result('meta', 'busy', 'Disconnecting…');
  try {
    const r = await api('/api/settings/meta/disconnect', {});
    data.settings = r.settings;
    delete tested.meta;
    renderAll();
    result('meta', r.warning ? 'bad' : 'ok', esc(r.warning || 'Disconnected. Connect a Page again any time with the box below.'));
  } catch (err) {
    result('meta', 'bad', `${art('vision-miss')}<span>${esc(err.message)}</span>`);
  }
}

/** Only what the seller changed in this section. */
function changes(section) {
  const card = document.querySelector(`[data-section="${section}"]`);
  const out = {};
  for (const input of card.querySelectorAll('[data-key]')) {
    const f = data.settings.fields.find((x) => x.key === input.dataset.key);
    if (f.type === 'toggle') { if (input.checked !== Boolean(f.value)) out[f.key] = input.checked; continue; }
    if (f.type === 'secret') {
      if (input.value.trim()) out[f.key] = input.value.trim();
      else if (removed.has(f.key)) out[f.key] = null;
      continue;
    }
    if (String(input.value).trim() !== String(f.value ?? '')) out[f.key] = input.value;
  }
  return out;
}

function result(section, cls, html) {
  const el = $(`#result-${section}`);
  el.className = `result ${cls}`;
  el.innerHTML = html;
}

async function save(section) {
  const values = changes(section);
  if (!Object.keys(values).length) { result(section, '', 'Nothing changed'); return; }
  result(section, 'busy', 'Saving…');
  try {
    const r = await api('/api/settings', { values });
    for (const k of Object.keys(values)) removed.delete(k);
    data.settings = r.settings;
    renderAll();
    if (r.warning) { result(section, 'bad', `${art('state-expired')}${esc(r.warning)}`); return; }
    toast('Saved');
    if (TESTABLE.has(section) && data.settings.status[section]) await test(section, 'Saved. ');
    else result(section, 'ok', `${art('step-publish')}Saved`);
  } catch (err) {
    result(section, 'bad', `${art('vision-miss')}${esc(err.message)}`);
  }
}

async function test(section, prefix = '') {
  result(section, 'busy', `${prefix}Testing the connection…`);
  try {
    const { result: r } = await api('/api/settings/test', { section });
    tested[section] = r.ok;
    const card = document.querySelector(`[data-section="${section}"] .state`);
    const b = badge(section);
    card.className = `state ${b.cls}`;
    card.textContent = b.text;
    const dot = document.querySelector(`#jump a[href="#${section}"] .dot`);
    if (dot) dot.className = `dot ${b.cls}`;
    result(section, r.ok ? 'ok' : 'bad', r.ok ? `${art('paid')}${esc(prefix)}It works: ${esc(r.detail || 'connected')}`
      : `${art('vision-miss')}<span>${esc(prefix)}${esc(r.detail)}${r.raw && r.raw !== r.detail ? `<small>${esc(r.raw)}</small>` : ''}</span>`);
  } catch (err) {
    result(section, 'bad', `${art('vision-miss')}${esc(err.message)}`);
  }
}

async function connect(pageId = null) {
  const out = $('#connectOut');
  const typed = $('#connectToken')?.value.trim();
  if (typed) connectToken = typed;
  if (!connectToken) { out.innerHTML = '<p class="result bad">Paste the token first</p>'; return; }
  const appId = document.querySelector('[data-key="meta.appId"]')?.value.trim();
  const appSecret = document.querySelector('[data-key="meta.appSecret"]')?.value.trim();
  out.innerHTML = '<p class="result busy">Connecting…</p>';
  try {
    const r = await api('/api/settings/meta/connect', { appId, appSecret, userToken: connectToken, pageId });
    if (r.choose) {
      out.innerHTML = `<p><b>Which Page sells?</b></p><div class="bb-row">${r.choose.map((p) => `<button type="button" class="bb small" data-page="${esc(p.id)}"><span>${esc(p.name)}${p.instagram ? `<small>Instagram @${esc(p.instagram)}</small>` : ''}</span></button>`).join('')}</div>`;
      return;
    }
    connectToken = '';
    data.settings = r.settings;
    renderAll();
    const c = r.connected;
    const notes = [];
    if (!c.instagram) notes.push('No Instagram account is linked to this Page, so LiveLot sells on Facebook only. To add one: switch the Instagram account to Professional and link it in the Page’s settings, then connect again.');
    if (r.missing?.length) notes.push(`Missing permissions: ${r.missing.join(', ')}. Add them in Graph API Explorer and connect again.`);
    if (r.igMissing?.length) notes.push(`Missing Instagram permissions: ${r.igMissing.join(', ')}.`);
    if (r.warning) notes.push(r.warning);
    $('#connectOut').innerHTML = `<p class="result ok">${art('paid')}<span>Connected to the Page “${esc(c.page)}”${c.instagram ? ` and Instagram @${esc(c.instagram)}` : ''}. The token LiveLot saved doesn’t expire.</span></p>${notes.map((n) => `<p class="result bad"><span>${esc(n)}</span></p>`).join('')}`;
    test('meta');
  } catch (err) {
    out.innerHTML = `<p class="result bad">${art('vision-miss')}<span>${esc(err.message)}</span></p>`;
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-save], [data-test], [data-remove], [data-copy], [data-connect], [data-page], [data-livetest], [data-switch], [data-disconnect]');
  if (!b) return;
  e.preventDefault();
  if (b.hasAttribute('data-switch')) {
    const more = $('#connectMore');
    if (more) { more.open = true; more.scrollIntoView({ block: 'start', behavior: 'smooth' }); setTimeout(() => $('#connectToken')?.focus(), 300); }
    return;
  }
  if (b.hasAttribute('data-disconnect')) { disconnect(b); return; }
  if (b.hasAttribute('data-livetest')) {
    result('meta', 'busy', 'Asking Facebook…');
    try {
      const { result: r } = await api('/api/settings/meta/live-test', {});
      result('meta', r.ok ? 'ok' : 'bad', `${art(r.ok ? 'home-live' : 'vision-miss')}<span>${esc(r.detail)}</span>`);
    } catch (err) { result('meta', 'bad', `${art('vision-miss')}<span>${esc(err.message)}</span>`); }
  } else if (b.hasAttribute('data-connect')) connect();
  else if (b.dataset.page) connect(b.dataset.page);
  else if (b.dataset.save) save(b.dataset.save);
  else if (b.dataset.test) test(b.dataset.test);
  else if (b.dataset.remove) {
    removed.add(b.dataset.remove);
    const sec = data.settings.fields.find((f) => f.key === b.dataset.remove).section;
    const card = document.querySelector(`[data-section="${sec}"]`);
    card.outerHTML = sectionHtml(data.settings.sections.find((s) => s.id === sec));
    result(sec, '', 'Press Save to remove it');
  } else if (b.dataset.copy) {
    await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
    toast('Copied');
  }
});
// Enter in a field saves that section.
document.addEventListener('submit', (e) => {
  e.preventDefault();
  const sec = e.target.closest('[data-section]')?.dataset.section;
  if (sec) save(sec);
});

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

load();
