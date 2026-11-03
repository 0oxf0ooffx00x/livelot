// Wall clock with an offset, so the dashboard can "fast-forward 15 minutes" during the
// demo and tests can drive time by hand.
export function createClock({ manual = false, start = Date.now() } = {}) {
  let offset = 0;
  let manualNow = start;
  return {
    now: () => (manual ? manualNow : Date.now() + offset),
    advance(ms) {
      if (manual) manualNow += ms;
      else offset += ms;
    },
    set(ms) {
      manualNow = ms;
    },
    offset: () => offset,
  };
}
