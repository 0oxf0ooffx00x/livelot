// Paid detection without trusting a single channel: the mu-plugin ping and Woo webhooks are
// instant, and this poll catches anything they miss.
const PAID = new Set(['processing', 'completed', 'on-hold']);

export function createWooPoller({ store, commerce, claims, log, intervalMs = 15000 }) {
  let timer = null;
  async function tick() {
    const open = [...store.s.orders.values()].filter((o) => o.status === 'open' && o.wooOrderId);
    if (open.length) {
      try {
        const rows = await commerce.orderStatuses(open.map((o) => o.wooOrderId));
        for (const r of rows) if (PAID.has(r.status)) claims.markOrderPaid(String(r.id), { source: 'woo poll' });
      } catch (err) {
        log('warn', `Woo payment poll failed: ${err.message}`);
      }
    }
    timer = setTimeout(tick, intervalMs);
  }
  return { start: () => { timer = setTimeout(tick, intervalMs); }, stop: () => clearTimeout(timer), tick };
}
