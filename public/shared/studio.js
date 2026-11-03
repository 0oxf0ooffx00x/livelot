// Camera + microphone for LiveLot, shared by the studio page and the dashboard.
//  - 1 JPEG frame per second -> /api/frame (Muse Spark glance + SAM 3.1 pick the item from these)
//  - browser live captions (Web Speech, Chrome) -> /api/speech, instant
//  - ~6 s mono WAV chunks (resampled to 16 kHz here) -> /api/audio (Muse Voice Transcribe), no ffmpeg
//  - a live microphone level, so the seller can see LiveLot hears them
import { api, authHeaders } from '/shared/live.js';

/** What went wrong, in words a seller can act on. */
export function explainMediaError(err, what = 'camera') {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return `Chrome is blocking the ${what}. Click the camera icon at the right of the address bar, choose “Always allow”, then try again.`;
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return `The ${what} is busy in another app or tab. Close Zoom, Meet or Teams, close other LiveLot camera tabs, and in OBS remove any Video Capture Device using it. Then try again.`;
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return `No ${what} was found. Check it's connected and not switched off (some laptops have a camera key or shutter).`;
  if (!window.isSecureContext) return 'The camera only works on https:// pages.';
  return `The ${what} didn't start: ${err?.message || n || 'unknown error'}`;
}

export function createStudio({ video, isSelling = () => true, hasAsr = () => false, lang = () => 'en-GB', onStatus = () => {}, onCaption = () => {}, onLevel = () => {} }) {
  const stat = { on: false, frames: 0, frameErr: '', speech: 'off', asr: 0, asrErr: '', micNote: '', mic: '', level: 0, hearing: false, quiet: false, suspended: false };
  let testSink = null;
  let stream = null;
  let frameTimer = null;
  let rec = null;
  let wantCaptions = true;
  let audioCtx = null;
  const status = () => onStatus({ ...stat });

  async function devices() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return {
      cameras: devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` })),
      mics: devs.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
    };
  }

  function open(cameraId, micId, withMic = true) {
    return navigator.mediaDevices.getUserMedia({
      video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: withMic ? { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true } : false,
    });
  }

  /** Start camera + mic. Falls back to default devices, then to camera only. Throws with .explain on failure. */
  async function start({ cameraId = '', micId = '' } = {}) {
    stop();
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('This browser has no camera access. Use Chrome.'), { explain: 'This browser has no camera access. Use Chrome.' });
    stat.micNote = '';
    try {
      try {
        stream = await open(cameraId, micId);
      } catch (e1) {
        if (e1.name === 'NotAllowedError') throw e1;
        try {
          stream = await open('', '');
        } catch (e2) {
          if (e2.name === 'NotAllowedError') throw e2;
          stream = await open('', '', false); // throws the camera's own error if the camera is the problem
          stat.micNote = explainMediaError(e2, 'microphone');
        }
      }
    } catch (err) {
      err.explain = explainMediaError(err, 'camera');
      throw err;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    stat.on = true;
    stat.mic = stream.getAudioTracks()[0]?.label || '';
    startFrames();
    if (stream.getAudioTracks().length) { startCaptions(); startAudio(); } else stat.speech = 'no microphone';
    status();
    return { cameraId: stream.getVideoTracks()[0]?.getSettings?.().deviceId || '', micId: stream.getAudioTracks()[0]?.getSettings?.().deviceId || '', micNote: stat.micNote };
  }

  function stop() {
    clearInterval(frameTimer);
    frameTimer = null;
    wantCaptionsRestart(false);
    try { rec?.abort(); } catch { /* not running */ }
    rec = null;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
    stat.on = false;
    stat.speech = 'off';
    status();
  }

  // ---- frames for Muse Spark + SAM 3.1
  function startFrames() {
    const canvas = document.createElement('canvas');
    frameTimer = setInterval(async () => {
      if (!video.videoWidth || !isSelling()) return;
      const w = Math.min(960, video.videoWidth);
      canvas.width = w;
      canvas.height = Math.round((video.videoHeight / video.videoWidth) * w);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      try {
        const res = await fetch('/api/frame', { method: 'POST', headers: authHeaders({ 'Content-Type': 'image/jpeg' }), body: blob });
        if (res.ok) { stat.frames++; stat.frameErr = ''; } else stat.frameErr = `HTTP ${res.status}`;
      } catch (e) { stat.frameErr = e.message; }
      status();
    }, 1000);
  }

  // ---- browser captions (instant; also carry the spoken "next lot" cue)
  let restartCaptions = true;
  function wantCaptionsRestart(v) { restartCaptions = v; }
  function startCaptions() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { stat.speech = 'needs Chrome'; status(); return; }
    try { rec?.abort(); } catch { /* not running */ }
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang();
    restartCaptions = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text && isSelling()) api('/api/speech', { text, final: true, source: 'webspeech' }).catch(() => {});
          onCaption(text, true);
        } else interim += r[0].transcript;
      }
      if (interim) onCaption(interim, false);
    };
    rec.onstart = () => { stat.speech = 'listening'; status(); };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      stat.speech = { network: 'captions offline', 'not-allowed': 'mic blocked', 'audio-capture': 'no mic' }[e.error] || e.error;
      status();
    };
    rec.onend = () => { if (restartCaptions && wantCaptions && stream) setTimeout(() => { try { rec?.start(); } catch { /* already started */ } }, 300); };
    try { rec.start(); } catch { /* already started */ }
  }
  function setCaptions(on) {
    wantCaptions = on;
    if (on && stream?.getAudioTracks().length) startCaptions();
    else { restartCaptions = false; try { rec?.stop(); } catch { /* not running */ } stat.speech = 'off'; status(); }
  }

  // ---- microphone: level meter + Muse Voice Transcribe chunks
  // The context runs at the device's own rate (asking Chrome for 16 kHz fails on some setups); chunks
  // are resampled to 16 kHz when encoded. "Voice" is judged against the room's own noise floor, so a
  // quiet laptop mic a metre away still counts.
  function startAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    const ctx = audioCtx;
    const wake = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
    wake();
    document.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const rate = ctx.sampleRate;
    let chunks = [];
    let samples = 0;
    let voiced = 0;
    let floor = 0.01;
    let lastVoice = 0;
    let loudest = 0;
    let loudestAt = Date.now();
    let lastLevel = 0;
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < d.length; i += 2) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / (d.length / 2));
      floor = rms < floor ? floor * 0.8 + rms * 0.2 : floor * 0.998 + rms * 0.002;
      const now = Date.now();
      const isVoice = rms > Math.max(0.003, floor * 2.2);
      if (isVoice) { voiced += d.length; lastVoice = now; }
      if (rms > loudest) { loudest = rms; loudestAt = now; }
      if (now - loudestAt > 12000) { loudest = rms; loudestAt = now; }
      stat.level = Math.min(100, Math.round(Math.sqrt(rms) * 190));
      stat.hearing = now - lastVoice < 1500;
      stat.quiet = loudest < 0.004; // nothing above a whisper for ~12 s: wrong or muted mic
      stat.suspended = false;
      if (testSink) testSink.push(new Float32Array(d));
      chunks.push(new Float32Array(d));
      samples += d.length;
      if (samples >= rate * 6) {
        const send = chunks;
        const hadVoice = voiced > rate * 0.3;
        chunks = []; samples = 0; voiced = 0;
        if (hadVoice && isSelling() && hasAsr()) upload(encodeWav(send, rate));
      }
      if (now - lastLevel > 150) { lastLevel = now; onLevel({ ...stat }); }
    };
    src.connect(proc);
    proc.connect(ctx.destination); // outputs silence; needed for Chrome to run the processor
    // If Chrome keeps audio paused (no click since the permission prompt), say so.
    setTimeout(() => { if (ctx.state !== 'running') { stat.suspended = true; onLevel({ ...stat }); } }, 1200);
  }

  /** Record a few seconds and ask Muse Voice what it heard, without touching any item. */
  async function testMic(seconds = 4) {
    if (!audioCtx) throw new Error('Turn the camera and microphone on first');
    await audioCtx.resume().catch(() => {});
    testSink = [];
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const got = testSink;
    testSink = null;
    if (!got.length) throw new Error('No sound arrived from the microphone');
    const res = await fetch('/api/audio?test=1', { method: 'POST', headers: authHeaders({ 'Content-Type': 'audio/wav' }), body: encodeWav(got, audioCtx.sampleRate) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
    return j.text || '';
  }
  async function upload(wav) {
    try {
      const r = await fetch('/api/audio', { method: 'POST', headers: authHeaders({ 'Content-Type': 'audio/wav' }), body: wav });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      stat.asr++; stat.asrErr = '';
    } catch (e) { stat.asrErr = e.message; }
    status();
  }

  return { start, stop, devices, setCaptions, stat, testMic, isOn: () => Boolean(stream), restartSpeech: () => stream?.getAudioTracks().length && startCaptions() };
}

/** Mono 16-bit WAV at 16 kHz (Muse Voice accepts 16 or 24 kHz), averaging down from the device rate. */
export function encodeWav(chunks, rate, outRate = 16000) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const flat = new Float32Array(len);
  let off = 0;
  for (const c of chunks) { flat.set(c, off); off += c.length; }
  const ratio = rate / outRate;
  const n = ratio > 1 ? Math.floor(len / ratio) : len;
  const pcm = new Float32Array(n);
  if (ratio > 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(len, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < b; j++) sum += flat[j];
      pcm[i] = sum / Math.max(1, b - a);
    }
  } else pcm.set(flat);
  const sr = ratio > 1 ? outRate : rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
