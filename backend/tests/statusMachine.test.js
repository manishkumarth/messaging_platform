import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DECISION } from '../src/statusMachine.js';

const { APPLY, STALE, INVALID } = DECISION;

const cases = [
  // current, incoming, expected
  ['QUEUED', 'SENT', APPLY],
  ['QUEUED', 'DELIVERED', APPLY], // SENT event lost or late: skipping is allowed
  ['QUEUED', 'READ', APPLY],
  ['QUEUED', 'FAILED', APPLY],
  ['SENT', 'DELIVERED', APPLY],
  ['SENT', 'READ', APPLY],
  ['SENT', 'FAILED', APPLY],
  ['DELIVERED', 'READ', APPLY],
  ['SENT', 'SENT', STALE],
  ['DELIVERED', 'SENT', STALE], // out of order: never move backwards
  ['READ', 'SENT', STALE],
  ['READ', 'DELIVERED', STALE],
  ['READ', 'READ', STALE],
  ['DELIVERED', 'FAILED', INVALID], // contradicts history
  ['READ', 'FAILED', INVALID],
  ['FAILED', 'FAILED', STALE],
  ['FAILED', 'SENT', INVALID], // FAILED is terminal
  ['FAILED', 'DELIVERED', INVALID],
  ['FAILED', 'READ', INVALID],
];

for (const [current, incoming, expected] of cases) {
  test(`decide(${current}, ${incoming}) -> ${expected}`, () => {
    assert.equal(decide(current, incoming), expected);
  });
}
