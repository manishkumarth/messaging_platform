# Messaging Platform API

A REST API for a simplified **multi-tenant messaging platform**. Clients create messages; an external
provider reports delivery progress through a **webhook** that is safe against retries, duplicates and
out-of-order delivery. Includes a small React console for exploring it.

- **Backend:** Node.js (ESM) + Express 5 + SQLite (`better-sqlite3`), SQL migrations, no ORM
- **Frontend:** React 19 + Vite (create messages, browse history, simulate provider webhooks)
- **Tests:** Node's built-in test runner + supertest (49 tests)
- Design note (idempotency, transitions, isolation, production changes): [`docs/DESIGN.md`](docs/DESIGN.md)

## Quick start

Requires **Node.js 20+** (developed on 22) and npm.

```bash
cp backend/.env.example backend/.env   # placeholder values; edit WEBHOOK_SECRET if you like
npm run setup                          # installs backend + frontend dependencies
npm run migrate                        # creates ./backend/data/app.db (idempotent)
npm start                              # API on http://localhost:3000
```

```bash
npm test                               # backend test suite
npm run demo                           # curl walkthrough against the running API (see below)
```

`npm start` also applies pending migrations on boot, so `npm run migrate` is optional but kept as an
explicit, reproducible step. `better-sqlite3` ships prebuilt binaries for common platforms; on an unusual
platform it compiles from source and needs a C++ toolchain.

### React console

```bash
npm run dev:web          # http://localhost:5173  (API must be running on :3000)
# or
npm run build:web && npm start   # API serves the built console at http://localhost:3000
```

In dev, Vite proxies `/api` to the backend and adds the webhook secret to simulated provider calls
**server-side**, so the secret never reaches the browser bundle.

### Environment variables (`backend/.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/app.db` | SQLite file (parent directory is created) |
| `WEBHOOK_SECRET` | *(empty)* | Expected `x-webhook-secret` header on the webhook. Empty disables the check and logs a warning |
| `LOG_LEVEL` | `info` | `debug` `info` `warn` `error` `silent` |
| `MAX_TEXT_LENGTH` | `4096` | Max characters in a message body |

## API

All success bodies are `{ "data": ... }`. All errors share one envelope (see [Errors](#errors)).
Timestamps are ISO-8601 UTC strings.

### Authentication assumption

`x-tenant-id` **stands in for an authenticated identity.** Every `/api/v1/messages` and
`/api/v1/conversations` call must send it, and all data access is scoped to that tenant. In production the
tenant would come from a verified credential (JWT claim / API key lookup) set by an auth layer, never from a
client-controlled value. The provider webhook is not tenant-scoped (the provider is not a tenant); it is
authenticated with a shared secret in `x-webhook-secret` instead.

### `POST /api/v1/messages`

Headers: `x-tenant-id`, `content-type: application/json`.

```bash
curl -X POST localhost:3000/api/v1/messages \
  -H 'content-type: application/json' -H 'x-tenant-id: tenant-a' \
  -d '{"tenantId":"tenant-a","conversationId":"conv-100","to":"+919876543210","text":"Your order has shipped"}'
```

`201 Created`
```json
{
  "data": {
    "id": "msg_4172ee7d-c2ee-4f61-9276-a516acb46119",
    "tenantId": "tenant-a",
    "conversationId": "conv-100",
    "to": "+919876543210",
    "text": "Your order has shipped",
    "status": "QUEUED",
    "createdAt": "2026-11-14T05:19:46.461Z",
    "updatedAt": "2026-11-14T05:19:46.461Z",
    "timestamps": { "sentAt": null, "deliveredAt": null, "readAt": null, "failedAt": null }
  }
}
```

Validation: `tenantId`, `conversationId` match `[A-Za-z0-9_.:-]{1,64}`; `to` is E.164 (`+` and 7-15 digits);
`text` is a non-blank string up to `MAX_TEXT_LENGTH`. Body `tenantId` must equal the `x-tenant-id` header (else `403`).

### `GET /api/v1/conversations/:conversationId/messages?limit=20&cursor=...`

Messages in chronological order (insertion order), tenant-scoped. `limit` is 1-100 (default 20).

```bash
curl 'localhost:3000/api/v1/conversations/conv-100/messages?limit=2' -H 'x-tenant-id: tenant-a'
```
```json
{
  "data": [ { "...": "message objects as above" } ],
  "pagination": { "limit": 2, "hasMore": true, "nextCursor": "Mg" }
}
```

Pass `nextCursor` back as `cursor` for the next page; `nextCursor` is `null` on the last page. Cursors are opaque.
An unknown conversation, or one belonging to another tenant, returns an empty list (`200`).

### `GET /api/v1/messages/:messageId`

Returns the message with its current `status` and timestamps. A message owned by another tenant returns
`404`, identical to a missing one, so ids cannot be probed across tenants.

### `POST /api/v1/webhooks/provider`

Headers: `x-webhook-secret`, `content-type: application/json`.

```bash
curl -X POST localhost:3000/api/v1/webhooks/provider \
  -H 'content-type: application/json' -H 'x-webhook-secret: <WEBHOOK_SECRET>' \
  -d '{"eventId":"evt-001","messageId":"msg_...","status":"DELIVERED","occurredAt":"2026-10-16T08:30:00.000Z"}'
```

`200 OK`
```json
{ "data": { "eventId": "evt-001", "messageId": "msg_...", "duplicate": false,
            "outcome": "APPLIED", "messageStatus": "DELIVERED" } }
```

| Field | Rules |
|---|---|
| `eventId` | string, `[A-Za-z0-9_.:-]{1,128}`, the idempotency key |
| `messageId` | string, an existing message id |
| `status` | `SENT` \| `DELIVERED` \| `READ` \| `FAILED` |
| `occurredAt` | ISO-8601 with timezone; normalised to UTC |

`outcome` is one of `APPLIED`, `IGNORED_STALE`, `IGNORED_INVALID_TRANSITION`. Ignored events still return
`200`: the provider's job is done and retrying would never change the result. `duplicate: true` means this
`eventId` was seen before; `outcome` then replays the original result.

### `GET /health` and `GET /metrics`

```json
{ "status": "ok", "checks": { "database": "up" }, "uptimeSeconds": 42 }
```
`/health` runs `SELECT 1`; it returns `503` with `"database": "down"` if that fails, and never exposes paths or
connection details. `/metrics` returns in-process counters (`http_requests_total`, `messages_created_total`,
`webhook_events_total{outcome}`) as JSON.

### Errors

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
             "details": [ { "field": "to", "message": "must be an E.164 phone number, e.g. +919876543210" } ],
             "requestId": "806615de-5778-47ae-823f-abdff188bda7" } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad/missing fields, bad `limit` or `cursor`, non-object body |
| 400 | `INVALID_JSON` | Malformed JSON body |
| 401 | `UNAUTHENTICATED` | Missing/invalid `x-tenant-id` |
| 401 | `INVALID_WEBHOOK_SECRET` | Missing/wrong `x-webhook-secret` |
| 403 | `TENANT_MISMATCH` | Body `tenantId` differs from the authenticated tenant |
| 404 | `MESSAGE_NOT_FOUND` | Unknown message id (or another tenant's), or webhook for an unknown message |
| 404 | `ROUTE_NOT_FOUND` | No such route |
| 409 | `EVENT_ID_CONFLICT` | Same `eventId` re-sent with a *different* payload |
| 409 | `CONCURRENT_UPDATE` | Optimistic-lock miss (should not occur, see below) |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 16 KB |
| 500 | `INTERNAL_ERROR` | Unexpected; generic message to the client, details in logs |

`requestId` is the correlation id (also returned as the `x-request-id` header; an incoming `x-request-id` is honoured).

## Status transition rules

```
QUEUED ──► SENT ──► DELIVERED ──► READ        forward only; steps may be skipped
   └────────┴──► FAILED                       only from QUEUED or SENT; terminal
```

| Current → incoming | Result |
|---|---|
| Strictly further along (`QUEUED→DELIVERED`, `SENT→READ`, ...) | `APPLIED` |
| Same or earlier status (`READ→SENT`, `SENT→SENT`) | `IGNORED_STALE`: never moves backwards |
| `FAILED` while `DELIVERED` or `READ` | `IGNORED_INVALID_TRANSITION` |
| Anything but `FAILED` while `FAILED` | `IGNORED_INVALID_TRANSITION` (terminal) |

**Out-of-order handling.** Ordering is decided by the state machine, not by `occurredAt`, so the result is the
same whatever order events arrive in. Skipping is allowed so a lost or late `SENT` does not block `DELIVERED`.
A stale `SENT`/`DELIVERED`/`READ` still fills its timestamp if it is empty (never overwrites), so the history
stays accurate: `READ` then a late `SENT` leaves status `READ` with `sentAt` populated. Every event, applied or
ignored, is kept in the `message_events` ledger with its outcome.

## Idempotency and durability

- `message_events.event_id` is the **primary key**; a duplicate cannot be inserted even under concurrency.
- Each webhook runs in a single `BEGIN IMMEDIATE` transaction: dedupe check → decide → update message →
  insert event. The write lock serialises concurrent deliveries; the `200` is sent only **after commit**, so
  an acknowledged event is always durable.
- A repeat returns `200` with `duplicate: true` and the original outcome, with no second effect.
- The same `eventId` carrying a different payload is rejected with `409`.
- Messages also carry a `version`; the status `UPDATE` is `... WHERE id = ? AND version = ?` (optimistic
  concurrency), as a second line of defence if the locking strategy ever changes.
- **Unknown `messageId`** → `404 MESSAGE_NOT_FOUND`, nothing stored. Message ids are generated by this service
  before any provider can know them, so an unknown id means a bad or foreign event; a clear 404 lets the
  provider alert or dead-letter rather than the service quietly accumulating orphans. (Alternative for real
  systems: store as `UNMATCHED` and reconcile later; discussed in the design note.)

## Database schema

Defined in [`backend/migrations/001_init.sql`](backend/migrations/001_init.sql); applied by a tiny runner
(`schema_migrations` table, one transaction per file, re-runnable).

```
messages
  seq              INTEGER PK AUTOINCREMENT   -- stable pagination order
  id               TEXT UNIQUE                -- msg_<uuid>
  tenant_id, conversation_id, recipient, body
  status           TEXT  CHECK IN (QUEUED, SENT, DELIVERED, READ, FAILED)
  version          INTEGER                    -- optimistic concurrency
  created_at, updated_at, sent_at, delivered_at, read_at, failed_at
  INDEX (tenant_id, conversation_id, seq)

message_events                               -- idempotency + audit ledger
  event_id         TEXT PRIMARY KEY           -- provider's id
  message_id       TEXT REFERENCES messages(id)
  tenant_id, status, occurred_at, received_at
  outcome          TEXT  CHECK IN (APPLIED, IGNORED_STALE, IGNORED_INVALID_TRANSITION)
  status_before, status_after
```

## Pagination

Keyset pagination on `seq` (`WHERE tenant_id=? AND conversation_id=? AND seq > ? ORDER BY seq LIMIT n+1`).
No offsets, so pages never skip or repeat when new messages arrive; new messages simply appear at the end.
The extra row tells us `hasMore` without a `COUNT`. The cursor contains only a number; tenant and conversation
come from the request, so a cursor cannot be used to reach another tenant's data.

## Logging and observability

- One JSON line per entry (`time`, `level`, `msg`, fields) with a **correlation id** per request.
- Access log has method, route *pattern*, status, latency, `requestId`, `tenantId`.
- Webhook log has `eventId`, `messageId`, status, outcome.
- **Never logged:** message text, phone numbers, request bodies, headers, the webhook secret (covered by a test).
- 5xx errors log the error and stack server-side; the client only gets a generic message and `requestId`.

## Tests

`npm test` runs 49 tests against an in-memory SQLite database (plus a temp file for the restart test):

- **Success paths:** create/read message, full `QUEUED→SENT→DELIVERED→READ` flow, pagination.
- **Idempotency:** duplicate event, duplicate after the message moved on, 10 concurrent identical events,
  same `eventId` with different payload.
- **Edge/failure cases:** out-of-order (`READ` then `SENT`), `FAILED` after `DELIVERED`, `FAILED` terminal,
  unknown message, malformed JSON, invalid fields, oversized text, missing/wrong secret, bad `limit`/`cursor`.
- **Isolation:** cross-tenant read by id, same conversation id under two tenants, cursor reuse.
- **Persistence:** data and event ledger survive closing and reopening the database file; migrations are idempotent.
- **Operations:** health up/503, metrics labels, log content contains no message text or secrets.
- Table-driven unit tests for every status-machine transition.

## Trying it with curl

`npm run demo` (or `bash scripts/demo.sh`) runs the whole story against a running server: create, deliver,
duplicate retry, out-of-order, invalid transition, pagination, tenant isolation, validation errors, unknown
message. Set `WEBHOOK_SECRET` to the value in `backend/.env`:

```bash
WEBHOOK_SECRET=replace-with-a-long-random-string npm run demo
```

## Assumptions

- `x-tenant-id` represents the authenticated tenant (see above); `tenantId` in the create body must match it.
- The provider is trusted via a shared secret; no per-tenant provider credentials.
- Messages are never actually sent. They stay `QUEUED` until the provider webhook says otherwise.
- `occurredAt` is provider-supplied and trusted for timestamps; it does not decide ordering.
- `to` is E.164; text is plain text up to 4096 characters.

## Trade-offs and limitations

- **SQLite = one writer.** Fine for this scope (WAL mode, `busy_timeout`); not horizontally scalable.
  Single-process only: running several API instances against one file is not supported.
- **Synchronous processing, no queue.** Webhooks are applied inside the request, which is the simplest way
  to guarantee "persisted before acknowledged". There is no retry/backoff or dead-letter worker; a failure
  returns a 5xx and relies on the provider to retry (safe, because processing is idempotent).
- **The concurrency test is single-process.** It exercises serialisation through the transaction, but it is
  not a multi-process stress test.
- **Unknown-message events are rejected, not stored.** If the provider could legitimately race ahead of
  message creation, an `UNMATCHED` store + reconciliation job would be needed.
- **`FAILED` is terminal.** A `DELIVERED` that truly happened before a `FAILED` but arrives after it is
  ignored; chosen for simplicity and predictability.
- No rate limiting, no real authentication, no CORS (the console uses a proxy / same origin), metrics are
  in-memory and reset on restart, no OpenAPI document.
- No Docker or worker-queue implementation; the production design for those is in `docs/DESIGN.md`.
