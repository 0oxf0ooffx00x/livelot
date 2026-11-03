// Keyed promise queue. Work for the same key runs strictly one after another; different keys
// run in parallel. Used per buyer, so two claims from the same buyer can't both create an order.
export function createKeyedMutex() {
  const tails = new Map();
  return function withLock(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
