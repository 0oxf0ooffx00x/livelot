// Stand-in for Facebook/Instagram. Comments come from the dashboard, the replay player or tests;
// replies are recorded so the dashboard's "buyer phones" can show what each buyer received.
export function createMockPlatform({ latencyMs = 80 } = {}) {
  const outbox = [];
  const usedComments = new Set();
  const wait = () => new Promise((r) => setTimeout(r, latencyMs));
  return {
    kind: 'mock',
    outbox,
    async start() { return { fb: true, ig: true }; },
    stop() {},
    async privateReply(msg) {
      await wait();
      if (usedComments.has(msg.commentId)) {
        const e = new Error('(#10900) Activity already replied to');
        e.code = 10900;
        throw e;
      }
      usedComments.add(msg.commentId);
      outbox.push({ kind: 'private', ...msg });
      return { ok: true, recipientId: `psid-${msg.commentId}` };
    },
    async publicReply(msg) {
      await wait();
      outbox.push({ kind: 'public', ...msg });
      return { ok: true };
    },
    async sendMessage(msg) {
      await wait();
      outbox.push({ kind: 'dm', ...msg });
      return { ok: true };
    },
    async postLot(lot, { caption, imageUrl, platforms = ['facebook', 'instagram'] }) {
      await wait();
      const out = {};
      if (platforms.includes('facebook')) out.facebook = { id: `mockfb_${lot.lotNumber}`, url: null };
      if (platforms.includes('instagram')) out.instagram = imageUrl ? { id: `mockig_${lot.lotNumber}`, url: null } : { error: 'Instagram posts need a photo' };
      outbox.push({ kind: 'post', lotNumber: lot.lotNumber, caption, imageUrl });
      return out;
    },
    watchPost() {},
    unwatchPost() {},
    async deletePost({ platform, id }) { await wait(); outbox.push({ kind: 'post-deleted', platform, id }); return { ok: true }; },
    async check() { return { mock: true }; },
    state: () => ({}),
  };
}
