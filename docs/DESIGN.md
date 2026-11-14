# Design note

## 1. Idempotency

**Goal:** a provider may deliver the same event many times, concurrently, across restarts, and the business
effect must happen exactly once.

- The provider's `eventId` is the idempotency key and the **primary key** of `message_events`. The database,
  not application code, guarantees uniqueness.
- Processing is one transaction: look up `eventId` → read message → decide transition → update message →
  insert event. `BEGIN IMMEDIATE` takes the write lock first, so two deliveries can't both pass the "not seen"
  check. HTTP `200` is returned only after `COMMIT`, so "acknowledged" always means "durably recorded".
- A replay returns `200` with `duplicate: true` and the *original* outcome. Returning success (not an error)
  is what stops provider retry loops.
- Same `eventId` with a different payload is a provider bug, not a retry → `409`, nothing applied.
- The ledger keeps ignored events too, so there is a complete audit trail of what was received and why it did
  or didn't change anything.
- Idempotency is also *semantic*: even with a **new** `eventId`, a repeated status can't double-apply because
  the state machine treats equal/older statuses as no-ops.

## 2. Status transitions

```
QUEUED → SENT → DELIVERED → READ      forward only, may skip
QUEUED | SENT → FAILED                terminal
```

- Order is decided by **rank in the state machine**, not by `occurredAt` or arrival order. That makes the
  result deterministic under any permutation of events, which is exactly the out-of-order guarantee needed.
- Skipping forward is allowed (`QUEUED → DELIVERED`) so a lost/late `SENT` never blocks progress.
- A late event that can't move the status still **backfills its empty timestamp** (never overwrites), so
  `sentAt` is right even if `SENT` arrived last.
- `FAILED` after `DELIVERED`/`READ` contradicts history and is recorded as `IGNORED_INVALID_TRANSITION`.
  `FAILED` is terminal. Trade-off: if a `FAILED` really preceded a later-arriving `DELIVERED`, the latter is
  dropped. We prefer a simple, predictable rule over trying to reconstruct provider truth from clocks.
- Status changes use optimistic concurrency (`version`), a second guard behind the transaction lock.

## 3. Tenant isolation

- Tenant identity comes from `x-tenant-id` (assumed to represent an authenticated principal; real systems
  would derive it from a verified token). The body is never trusted: a mismatched `tenantId` is `403`.
- Every query on tenant data includes `tenant_id` in its `WHERE` clause, and the pagination index leads with
  `(tenant_id, conversation_id)`. There is no code path that fetches by id alone for a client request.
- Cross-tenant access returns **404, not 403**, so message ids can't be used to learn what exists elsewhere.
- Cursors are bare sequence numbers; scope comes from the request, so a cursor can't be replayed to widen
  access. The same `conversationId` under two tenants is two independent conversations (tested).
- The webhook is the one non-tenant-scoped path (the provider isn't a tenant); it is protected by a shared
  secret compared in constant time, and derives the tenant from the message row.
- Logs include `tenantId` for debugging, never message content or phone numbers.

## 4. What changes in production / at high throughput

| Concern | This submission | Production |
|---|---|---|
| Ingestion | Process inline in the request | Webhook endpoint validates + authenticates, writes to a **broker** (Kafka/SQS/RabbitMQ) or a transactional **outbox**, acks, and workers process. Keeps ack latency flat during spikes and shields the DB |
| Ordering | State machine makes order irrelevant | Partition the topic by `messageId` so one message's events hit one consumer; the state machine still guards against reordering across partitions/retries |
| Retries | Provider retries on 5xx | Worker retry with exponential backoff + jitter; after N attempts → **dead-letter queue** with alerting and a replay tool. Idempotency makes retries safe |
| Database | SQLite, single writer | **PostgreSQL** (or a distributed SQL store): `INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING` for dedupe, `SELECT ... FOR UPDATE` or `UPDATE ... WHERE version = $n` for the transition. Read replicas for history queries; shard/partition by `tenant_id` |
| Event ledger | One table forever | Partition `message_events` by time, archive/TTL old rows; dedupe window sized to the provider's retry horizon (a Redis `SET NX` fast path can sit in front) |
| Unknown message | 404 | Store as `UNMATCHED` and reconcile when the message appears (provider can legitimately outrun a replicated write); expire after a window |
| Auth | Header + shared secret | JWT/mTLS for tenants; per-provider **HMAC signature** over the body with a timestamp (replay protection), secret rotation |
| Isolation | App-level `WHERE tenant_id` | Add Postgres **row-level security** as defence in depth; per-tenant rate limits and quotas |
| Observability | JSON logs, in-memory counters | OpenTelemetry traces propagating the correlation id across API → broker → worker; Prometheus metrics (ingest rate, outcome mix, queue lag, DLQ depth, p99 latency); alerts on DLQ growth and invalid-transition spikes |
| Deploy | `npm start` | Stateless containers behind a load balancer, migrations as a separate pre-deploy job, graceful shutdown draining in-flight work |
