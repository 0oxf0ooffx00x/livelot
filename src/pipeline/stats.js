// Show numbers for the dashboard header, the overlay and the post-show recap.
export function computeStats(store, clock) {
  const claims = store.claims();
  const orders = [...store.s.orders.values()];
  const lots = store.lots().filter((l) => l.status !== 'cancelled');
  const priceOf = (c) => (store.s.lots.get(c.itemId)?.price || 0) * c.qty;
  const by = (st) => claims.filter((c) => c.state === st);
  const replyTimes = claims.filter((c) => c.replyAt && c.at).map((c) => c.replyAt - c.at).sort((a, b) => a - b);
  const median = replyTimes.length ? replyTimes[Math.floor(replyTimes.length / 2)] : null;
  const paid = by('paid');
  const held = claims.filter((c) => c.state === 'invoiced' || c.state === 'reserved');
  const comments = [...store.s.comments.values()];
  return {
    lots: lots.length,
    published: lots.filter((l) => l.status === 'published' || l.status === 'sold_out').length,
    soldOut: lots.filter((l) => l.status === 'sold_out').length,
    comments: comments.length,
    claims: claims.filter((c) => c.state !== 'ignored').length,
    buyers: new Set(claims.filter((c) => ['invoiced', 'paid'].includes(c.state)).map((c) => c.buyerId)).size,
    held: held.length,
    heldValue: held.reduce((a, c) => a + priceOf(c), 0),
    paid: paid.length,
    revenue: paid.reduce((a, c) => a + priceOf(c), 0),
    waitlisted: by('waitlisted').length,
    review: by('needs_review').length,
    expired: by('expired').length,
    promoted: claims.filter((c) => c.promoted).length,
    orders: orders.filter((o) => o.status !== 'cancelled').length,
    paidOrders: orders.filter((o) => o.status === 'paid').length,
    medianReplyMs: median,
    doubleSells: 0,
    now: clock.now(),
  };
}
