#!/usr/bin/env bash
# Walks through every behaviour of the API with curl. Safe to re-run (event ids are unique per run).
#
#   BASE_URL=http://localhost:3000 WEBHOOK_SECRET=<same as backend/.env> bash scripts/demo.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"
RUN="$(date +%s)-$$"
CONV="conv-demo-$RUN"

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
call() { # call <label> <curl args...>  -> prints status + body
  local out
  out="$(curl -sS -w '\nHTTP %{http_code}' "${@:2}")"
  printf '%s\n' "$out"
}
webhook() { # webhook <json>
  curl -sS -w '\nHTTP %{http_code}' -X POST "$BASE_URL/api/v1/webhooks/provider" \
    -H 'content-type: application/json' -H "x-webhook-secret: $WEBHOOK_SECRET" -d "$1"
  echo
}

say "Health"
call health "$BASE_URL/health"

say "1. Create a message as tenant-a  (-> 201, status QUEUED)"
CREATED="$(curl -sS -X POST "$BASE_URL/api/v1/messages" \
  -H 'content-type: application/json' -H 'x-tenant-id: tenant-a' \
  -d "{\"tenantId\":\"tenant-a\",\"conversationId\":\"$CONV\",\"to\":\"+919876543210\",\"text\":\"Your order has shipped\"}")"
echo "$CREATED"
MSG_ID="$(printf '%s' "$CREATED" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
echo "message id: $MSG_ID"

say "2. Provider says DELIVERED  (-> APPLIED, status DELIVERED)"
webhook "{\"eventId\":\"evt-$RUN-1\",\"messageId\":\"$MSG_ID\",\"status\":\"DELIVERED\",\"occurredAt\":\"2026-10-16T08:30:00.000Z\"}"

say "3. Same eventId retried  (-> 200, duplicate:true, no second effect)"
webhook "{\"eventId\":\"evt-$RUN-1\",\"messageId\":\"$MSG_ID\",\"status\":\"DELIVERED\",\"occurredAt\":\"2026-10-16T08:30:00.000Z\"}"

say "4. READ arrives, then a LATE 'SENT'  (-> IGNORED_STALE, status stays READ, sentAt backfilled)"
webhook "{\"eventId\":\"evt-$RUN-2\",\"messageId\":\"$MSG_ID\",\"status\":\"READ\",\"occurredAt\":\"2026-10-16T08:45:00.000Z\"}"
webhook "{\"eventId\":\"evt-$RUN-3\",\"messageId\":\"$MSG_ID\",\"status\":\"SENT\",\"occurredAt\":\"2026-10-16T08:29:00.000Z\"}"

say "5. FAILED after READ  (-> IGNORED_INVALID_TRANSITION)"
webhook "{\"eventId\":\"evt-$RUN-4\",\"messageId\":\"$MSG_ID\",\"status\":\"FAILED\",\"occurredAt\":\"2026-10-16T08:50:00.000Z\"}"

say "6. Message details  (status READ with all timestamps)"
call get "$BASE_URL/api/v1/messages/$MSG_ID" -H 'x-tenant-id: tenant-a'

say "7. Add two more messages, then paginate with limit=2"
for i in 2 3; do
  curl -sS -o /dev/null -X POST "$BASE_URL/api/v1/messages" \
    -H 'content-type: application/json' -H 'x-tenant-id: tenant-a' \
    -d "{\"tenantId\":\"tenant-a\",\"conversationId\":\"$CONV\",\"to\":\"+919876543210\",\"text\":\"follow-up $i\"}"
done
PAGE1="$(curl -sS "$BASE_URL/api/v1/conversations/$CONV/messages?limit=2" -H 'x-tenant-id: tenant-a')"
echo "$PAGE1"
CURSOR="$(printf '%s' "$PAGE1" | sed -n 's/.*"nextCursor":"\([^"]*\)".*/\1/p')"
echo "--- page 2 (cursor=$CURSOR)"
call page2 "$BASE_URL/api/v1/conversations/$CONV/messages?limit=2&cursor=$CURSOR" -H 'x-tenant-id: tenant-a'

say "8. Tenant isolation: tenant-b asks for tenant-a's message and conversation"
call iso-msg  "$BASE_URL/api/v1/messages/$MSG_ID" -H 'x-tenant-id: tenant-b'
call iso-conv "$BASE_URL/api/v1/conversations/$CONV/messages" -H 'x-tenant-id: tenant-b'

say "9. Validation errors are 4xx"
call bad-body -X POST "$BASE_URL/api/v1/messages" -H 'content-type: application/json' -H 'x-tenant-id: tenant-a' \
  -d '{"tenantId":"tenant-a","to":"nope"}'
call bad-event -X POST "$BASE_URL/api/v1/webhooks/provider" -H 'content-type: application/json' \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -d '{"eventId":"x","messageId":"y","status":"NOPE","occurredAt":"soon"}'

say "10. Webhook for an unknown message  (-> 404)"
webhook "{\"eventId\":\"evt-$RUN-9\",\"messageId\":\"msg_unknown\",\"status\":\"SENT\",\"occurredAt\":\"2026-10-16T08:30:00.000Z\"}"

say "Metrics"
call metrics "$BASE_URL/metrics"
