-- 001_init.sql: messages + provider event ledger

CREATE TABLE messages (
  -- seq gives a total, gap-tolerant, insertion-ordered key used for stable pagination.
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT    NOT NULL UNIQUE,
  tenant_id       TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  recipient       TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  -- optimistic-concurrency counter, bumped on every status change
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  sent_at         TEXT,
  delivered_at    TEXT,
  read_at         TEXT,
  failed_at       TEXT
);

-- Serves GET /conversations/:id/messages (tenant + conversation scoped, ordered by seq)
CREATE INDEX idx_messages_tenant_conversation_seq
  ON messages (tenant_id, conversation_id, seq);

CREATE TABLE message_events (
  -- Provider event id is the idempotency key. PRIMARY KEY makes duplicates impossible
  -- even under concurrent delivery.
  event_id      TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages (id),
  tenant_id     TEXT NOT NULL,
  status        TEXT NOT NULL
                CHECK (status IN ('SENT', 'DELIVERED', 'READ', 'FAILED')),
  occurred_at   TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  -- What happened when the event was processed:
  --   APPLIED                     moved the message forward
  --   IGNORED_STALE               older/equal status; no status change (timestamps may be backfilled)
  --   IGNORED_INVALID_TRANSITION  not allowed by the state machine (e.g. FAILED after READ)
  outcome       TEXT NOT NULL
                CHECK (outcome IN ('APPLIED', 'IGNORED_STALE', 'IGNORED_INVALID_TRANSITION')),
  status_before TEXT NOT NULL,
  status_after  TEXT NOT NULL
);

CREATE INDEX idx_message_events_message ON message_events (message_id, received_at);
