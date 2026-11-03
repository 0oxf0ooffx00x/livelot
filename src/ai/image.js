import { dataUrl } from './metaClient.js';

// Muse Image 1.0: POST /v1/images/edits -> clean product shot on a plain background.
export function createImageEditor({ client, model, publicUrlFor }) {
  return {
    name: model,
    async cleanProductShot(buf, { title, publicUrl } = {}) {
      const prompt = `Product photo of ${title || 'this item'} for an online shop: keep the item exactly as it is (shape, colour, logos, wear), remove hands and background, place it centred on a soft light-grey studio background with a gentle shadow.`;
      const image_url = publicUrl || (publicUrlFor ? publicUrlFor() : null) || dataUrl(buf);
      const data = await client.request('/images/edits', {
        json: { model, prompt, images: [{ image_url }], n: 1 },
        model, purpose: 'clean product thumbnail',
        timeout: 45000,
      });
      const first = data.data?.[0] || data.images?.[0] || data.output?.[0];
      if (first?.b64_json) return { buffer: Buffer.from(first.b64_json, 'base64'), ms: data.__ms };
      const url = first?.url || first?.image_url;
      if (url) {
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`image download ${r.status}`);
        return { buffer: Buffer.from(await r.arrayBuffer()), ms: data.__ms };
      }
      throw new Error('muse-image: no image in response');
    },
  };
}
