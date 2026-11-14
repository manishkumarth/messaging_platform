import { AppError } from './errors.js';
import { WEBHOOK_STATUSES } from './statusMachine.js';

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(errors) {
  throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', errors);
}

function requireObject(body) {
  if (!isPlainObject(body)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Request body must be a JSON object (send Content-Type: application/json)',
    );
  }
}

function idField(body, field, errors, re = ID_RE) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    errors.push({ field, message: 'is required' });
  } else if (typeof value !== 'string' || !re.test(value)) {
    errors.push({ field, message: 'must be a string of letters, digits, "_", ".", ":" or "-" (max length applies)' });
  } else {
    return value;
  }
  return undefined;
}

export function validateTenantId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

export function validateConversationId(value) {
  if (!validateTenantId(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field: 'conversationId', message: 'must be a string of letters, digits, "_", ".", ":" or "-" (max 64)' },
    ]);
  }
  return value;
}

export function validateMessageId(value) {
  if (!validateTenantId(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field: 'messageId', message: 'is not a valid message id' },
    ]);
  }
  return value;
}

export function validateCreateMessage(body, { maxTextLength }) {
  requireObject(body);
  const errors = [];

  const tenantId = idField(body, 'tenantId', errors);
  const conversationId = idField(body, 'conversationId', errors);

  let to;
  if (body.to === undefined || body.to === null || body.to === '') {
    errors.push({ field: 'to', message: 'is required' });
  } else if (typeof body.to !== 'string' || !E164_RE.test(body.to)) {
    errors.push({ field: 'to', message: 'must be an E.164 phone number, e.g. +919876543210' });
  } else {
    to = body.to;
  }

  let text;
  if (body.text === undefined || body.text === null) {
    errors.push({ field: 'text', message: 'is required' });
  } else if (typeof body.text !== 'string') {
    errors.push({ field: 'text', message: 'must be a string' });
  } else if (body.text.trim().length === 0) {
    errors.push({ field: 'text', message: 'must not be empty or whitespace only' });
  } else if (body.text.length > maxTextLength) {
    errors.push({ field: 'text', message: `must be at most ${maxTextLength} characters` });
  } else {
    text = body.text;
  }

  if (errors.length) fail(errors);
  return { tenantId, conversationId, to, text };
}

export function validateWebhookEvent(body) {
  requireObject(body);
  const errors = [];

  const eventId = idField(body, 'eventId', errors, EVENT_ID_RE);
  const messageId = idField(body, 'messageId', errors);

  let status;
  if (body.status === undefined || body.status === null || body.status === '') {
    errors.push({ field: 'status', message: 'is required' });
  } else if (!WEBHOOK_STATUSES.includes(body.status)) {
    errors.push({ field: 'status', message: `must be one of ${WEBHOOK_STATUSES.join(', ')}` });
  } else {
    status = body.status;
  }

  let occurredAt;
  if (body.occurredAt === undefined || body.occurredAt === null || body.occurredAt === '') {
    errors.push({ field: 'occurredAt', message: 'is required' });
  } else if (
    typeof body.occurredAt !== 'string' ||
    !ISO_RE.test(body.occurredAt) ||
    Number.isNaN(Date.parse(body.occurredAt))
  ) {
    errors.push({ field: 'occurredAt', message: 'must be an ISO-8601 timestamp with timezone, e.g. 2026-10-16T08:30:00.000Z' });
  } else {
    // Normalise so string comparison == chronological comparison.
    occurredAt = new Date(body.occurredAt).toISOString();
  }

  if (errors.length) fail(errors);
  return { eventId, messageId, status, occurredAt };
}

export function parseLimit(raw) {
  if (raw === undefined) return 20;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field: 'limit', message: 'must be an integer between 1 and 100' },
    ]);
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > 100) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field: 'limit', message: 'must be an integer between 1 and 100' },
    ]);
  }
  return n;
}
