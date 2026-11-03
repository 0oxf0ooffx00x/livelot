// Muse Voice Transcribe, batch: POST /v1/asr/transcribe, multipart with a `request` JSON part
// and an `audio` part (WAV, mono, s16, 16 or 24 kHz, <=10 min). The studio page encodes WAV in
// the browser, so no ffmpeg is needed on the hot path.
export function createAsr({ client, model }) {
  return {
    name: model,
    async transcribe(wav, { keywords = [] } = {}) {
      const form = new FormData();
      // audioEncoding + mode are required (400 without them); keywords is accepted.
      const request = { model, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', ...(keywords.length ? { keywords: keywords.slice(0, 50) } : {}) };
      form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
      form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
      const data = await client.request('/asr/transcribe', { form, model, purpose: 'transcribe seller speech' });
      return { text: asrText(data), ms: data.__ms };
    },
  };
}

export function asrText(data) {
  if (!data) return '';
  if (typeof data.text === 'string') return data.text.trim();
  if (typeof data.transcript === 'string') return data.transcript.trim();
  const arr = data.results || data.segments || data.turns || data.utterances;
  if (Array.isArray(arr)) return arr.map((x) => x.text || x.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
  return '';
}
