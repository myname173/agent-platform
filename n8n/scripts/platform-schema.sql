-- Platform Runtime v1 durable state.
-- Apply to the n8n database:
--   docker exec -i postgres psql -U n8n -d n8n < n8n/scripts/platform-schema.sql
-- Safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.requests (
  request_id       text PRIMARY KEY,
  trace_id         char(32) NOT NULL,
  scope            text NOT NULL DEFAULT 'default',
  session_id       text NOT NULL DEFAULT '',
  idempotency_key  text,
  state            text NOT NULL CHECK (state IN ('RECEIVED','VALIDATED','RUNNING','WAITING_APPROVAL','WAITING_RETRY','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED')),
  attempt          integer NOT NULL DEFAULT 0,
  deadline_at      timestamptz,
  error_code       text,
  error_message    text,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  UNIQUE (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS platform_requests_trace_idx ON platform.requests (trace_id);
CREATE INDEX IF NOT EXISTS platform_requests_state_idx ON platform.requests (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform.tool_runs (
  tool_run_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       text NOT NULL REFERENCES platform.requests(request_id) ON DELETE CASCADE,
  trace_id         char(32) NOT NULL,
  tool_name        text NOT NULL,
  tool_call_id     text,
  state            text NOT NULL CHECK (state IN ('PLANNED','RUNNING','SUCCEEDED','FAILED','REPLAYED','UNKNOWN')),
  attempt          integer NOT NULL DEFAULT 0,
  idempotency_key  text,
  input            jsonb,
  output           jsonb,
  error_code       text,
  error_message    text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_tool_runs_request_idx ON platform.tool_runs (request_id, created_at);
CREATE INDEX IF NOT EXISTS platform_tool_runs_trace_idx ON platform.tool_runs (trace_id);

CREATE TABLE IF NOT EXISTS platform.events (
  event_id         bigserial PRIMARY KEY,
  request_id       text,
  trace_id         char(32) NOT NULL,
  event_type       text NOT NULL,
  from_state       text,
  to_state         text,
  payload          jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_events_trace_idx ON platform.events (trace_id, created_at);

CREATE TABLE IF NOT EXISTS platform.outbox (
  outbox_id        bigserial PRIMARY KEY,
  request_id       text,
  trace_id         char(32) NOT NULL,
  kind             text NOT NULL,
  dedupe_key       text NOT NULL,
  payload          jsonb NOT NULL,
  state            text NOT NULL CHECK (state IN ('PENDING','DELIVERING','DELIVERED','RETRY','DEAD_LETTER')) DEFAULT 'PENDING',
  attempts         integer NOT NULL DEFAULT 0,
  next_retry_at    timestamptz NOT NULL DEFAULT now(),
  lease_until      timestamptz,
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  UNIQUE (dedupe_key)
);

ALTER TABLE platform.outbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE platform.outbox ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE platform.outbox ADD COLUMN IF NOT EXISTS locked_by text;

-- Preserve recovery timing for rows claimed by the pilot before explicit
-- lease columns existed.
UPDATE platform.outbox
   SET lease_until = next_retry_at
 WHERE state = 'DELIVERING'
   AND lease_until IS NULL;

CREATE INDEX IF NOT EXISTS platform_outbox_ready_idx ON platform.outbox (state, next_retry_at);
CREATE INDEX IF NOT EXISTS platform_outbox_claim_idx
  ON platform.outbox (kind, state, next_retry_at, lease_until, outbox_id);

-- P0 idempotent consumer ledger: one row per (topic, dedupe_key). The primary
-- key is the idempotency boundary; event-consumer.js self-ensures the same DDL
-- at startup, so applying this file is optional for the pilot.
CREATE TABLE IF NOT EXISTS platform.consumed_events (
  topic            text NOT NULL,
  dedupe_key       text NOT NULL,
  event_id         text NOT NULL,
  trace_id         text,
  event_type       text,
  source           text,
  payload          jsonb,
  consumed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic, dedupe_key)
);
CREATE INDEX IF NOT EXISTS platform_consumed_events_trace_idx
  ON platform.consumed_events (trace_id, consumed_at);
