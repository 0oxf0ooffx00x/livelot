import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, canTransition, TransitionError, TRANSITIONS } from '../src/domain/claimMachine.js';

const claim = (state = 'detected') => ({ state, history: [] });

test('happy path detected -> paid records history', () => {
  const c = claim();
  for (const e of ['match', 'reserve', 'invoice', 'pay']) transition(c, e, { at: 1 });
  assert.equal(c.state, 'paid');
  assert.deepEqual(c.history.map((h) => h.to), ['matched', 'reserved', 'invoiced', 'paid']);
});

test('illegal transitions throw', () => {
  assert.throws(() => transition(claim('paid'), 'cancel'), TransitionError);
  assert.throws(() => transition(claim('detected'), 'pay'), TransitionError);
  assert.throws(() => transition(claim('expired'), 'promote'), TransitionError);
});

test('waitlist promotion and review paths exist', () => {
  assert.ok(canTransition('waitlisted', 'promote'));
  assert.ok(canTransition('needs_review', 'approve'));
  assert.ok(canTransition('invoiced', 'expire'));
  assert.ok(!canTransition('waitlisted', 'invoice'));
});

test('terminal states have no exits', () => {
  for (const s of ['paid', 'expired', 'cancelled', 'ignored']) assert.deepEqual(TRANSITIONS[s], {});
});
