/**
 * Wraps `fn` in BEGIN IMMEDIATE ... COMMIT (ROLLBACK on any throw).
 *
 * IMMEDIATE acquires SQLite's write lock at BEGIN, before the first read. Concurrent
 * callers are therefore serialised and cannot interleave a read-decide-write sequence
 * (a deferred transaction could read stale data and then fail to upgrade to a writer).
 */
export function immediateTransaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // connection already closed or transaction already rolled back
      }
      throw err;
    }
  };
}
