import { EventEmitter } from 'node:events';

// One event bus for the whole app. Every state change goes through here, and the SSE
// endpoint forwards it to the dashboard, the overlay and the studio page.
export function createBus({ historySize = 300 } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  const history = [];
  let seq = 0;

  function emit(type, data) {
    const evt = { seq: ++seq, type, at: Date.now(), data };
    if (type === 'trace' || type === 'log' || type === 'reply.sent' || type === 'comment.received') {
      history.push(evt);
      if (history.length > historySize) history.shift();
    }
    emitter.emit('event', evt);
    return evt;
  }

  return {
    emit,
    on: (fn) => {
      emitter.on('event', fn);
      return () => emitter.off('event', fn);
    },
    history: () => history.slice(),
    log: (level, msg, extra) => {
      const line = `[${level}] ${msg}`;
      if (level === 'error') console.error(line, extra ?? '');
      else if (process.env.QUIET !== '1') console.log(line);
      emit('log', { level, msg, ...(extra ? { extra: String(extra?.message || extra) } : {}) });
    },
  };
}
