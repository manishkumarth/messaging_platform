/**
 * Message status state machine.
 *
 *   QUEUED -> SENT -> DELIVERED -> READ        (forward only; steps may be skipped)
 *   QUEUED | SENT -> FAILED                    (FAILED is terminal)
 *
 * Skipping is allowed because providers retry and reorder events: seeing DELIVERED
 * before SENT is normal, and the message must not be held back waiting for SENT.
 */
export const STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'];
export const WEBHOOK_STATUSES = ['SENT', 'DELIVERED', 'READ', 'FAILED'];

const RANK = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

export const DECISION = {
  APPLY: 'APPLIED',
  STALE: 'IGNORED_STALE',
  INVALID: 'IGNORED_INVALID_TRANSITION',
};

/**
 * Decide what an incoming status does to a message currently in `current`.
 *  - APPLIED:  strictly forward move; update status.
 *  - IGNORED_STALE: same or older status (retry / out-of-order); never moves backwards.
 *  - IGNORED_INVALID_TRANSITION: contradicts history (FAILED after DELIVERED/READ,
 *    or anything but FAILED after FAILED).
 */
export function decide(current, incoming) {
  if (current === incoming) return DECISION.STALE;

  if (current === 'FAILED') return DECISION.INVALID;

  if (incoming === 'FAILED') {
    return current === 'QUEUED' || current === 'SENT' ? DECISION.APPLY : DECISION.INVALID;
  }

  return RANK[incoming] > RANK[current] ? DECISION.APPLY : DECISION.STALE;
}
