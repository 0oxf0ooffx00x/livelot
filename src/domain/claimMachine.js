// Claim lifecycle. Every state change goes through `transition`, which refuses anything
// not in this table and records the move in claim.history.
//
//   detected ─match→ matched ─reserve→ reserved ─invoice→ invoiced ─pay→ paid
//      │                 │                 │                  └─expire→ expired
//      ├─lowConfidence→ needs_review       └─expire→ expired
//      └─notAClaim→ ignored     matched ─conflict→ waitlisted ─promote→ reserved
//   (cancel from any live state; needs_review ─approve→ matched / ─reject→ ignored)

export const STATES = [
  'detected', 'matched', 'needs_review', 'ignored', 'reserved', 'waitlisted',
  'invoiced', 'paid', 'expired', 'cancelled',
];

export const TRANSITIONS = {
  detected: { match: 'matched', lowConfidence: 'needs_review', notAClaim: 'ignored', cancel: 'cancelled' },
  needs_review: { approve: 'matched', reject: 'ignored', cancel: 'cancelled' },
  matched: { reserve: 'reserved', conflict: 'waitlisted', lowConfidence: 'needs_review', cancel: 'cancelled' },
  waitlisted: { promote: 'reserved', cancel: 'cancelled' },
  reserved: { invoice: 'invoiced', expire: 'expired', cancel: 'cancelled' },
  invoiced: { pay: 'paid', expire: 'expired', cancel: 'cancelled' },
  paid: {},
  expired: {},
  cancelled: {},
  ignored: {},
};

/** States that hold a unit of stock. */
export const HOLDS_STOCK = new Set(['reserved', 'invoiced', 'paid']);
/** States where the claim is still in play. */
export const ACTIVE = new Set(['detected', 'matched', 'needs_review', 'reserved', 'waitlisted', 'invoiced']);
export const TERMINAL = new Set(['paid', 'expired', 'cancelled', 'ignored']);

export class TransitionError extends Error {
  constructor(from, event) {
    super(`Illegal claim transition: ${from} --${event}-->`);
    this.from = from;
    this.event = event;
  }
}

export function canTransition(state, event) {
  return Boolean(TRANSITIONS[state]?.[event]);
}

export function transition(claim, event, { at = Date.now(), reason } = {}) {
  const to = TRANSITIONS[claim.state]?.[event];
  if (!to) throw new TransitionError(claim.state, event);
  claim.history.push({ from: claim.state, event, to, at, ...(reason ? { reason } : {}) });
  claim.state = to;
  claim.updatedAt = at;
  if (reason) claim.reason = reason;
  return claim;
}
