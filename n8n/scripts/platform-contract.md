# Platform Runtime v1 Contract

## Scope

The runtime owns coordination and durable platform metadata. n8n remains the
business workflow engine. Domain tables such as `todos` and `reminders` remain
compatible with the current Data Table implementation during v1.

## Identity

- `request_id`: stable identifier for one accepted request.
- `trace_id`: 32 lowercase hex characters propagated through every service.
- `idempotency_key`: caller-provided key, or a gateway-derived key for a
  side-effect tool.
- `scope`: isolation boundary, normally `chat:<session_id>` or `mcp:<client>`.

## State rules

Only these transitions are valid:

```text
RECEIVED -> VALIDATED -> RUNNING
RUNNING -> SUCCEEDED | FAILED | TIMED_OUT | WAITING_APPROVAL | WAITING_RETRY
WAITING_APPROVAL -> RUNNING | FAILED | CANCELLED | TIMED_OUT
WAITING_RETRY -> RUNNING | FAILED | TIMED_OUT
```

Terminal states are immutable. A retry creates a new attempt on the same
`request_id`; it never creates a second side effect with the same idempotency
key.

## Runtime HTTP

All POST endpoints require `x-platform-runtime-key`.

- `GET /readyz`: returns `200` only when Redis is ready; used by Compose.
- `GET /metrics`: internal Prometheus text metrics for runtime counters.
- `POST /v1/idempotency/admit`: atomically claims a key with `PROCESSING`.
- `POST /v1/idempotency/complete`: stores a replayable successful result.
- `POST /v1/idempotency/unknown`: marks an ambiguous side effect as `UNKNOWN`
  without releasing the key, preventing an unsafe duplicate retry.
- `POST /v1/requests/start`: creates the durable request and records the
  `RECEIVED -> VALIDATED -> RUNNING` event sequence atomically.
- `POST /v1/requests/transition`: applies one validated request state change
  and appends a platform event.
- `POST /v1/tool-runs`: records a durable tool attempt tied to a request.
- `POST /v1/rate-limit`: increments a Redis window atomically.
- `POST /v1/locks/acquire`: `SET NX PX` with a random token.
- `POST /v1/locks/release`: token-checked Lua release.
- `POST /v1/jobs/enqueue`: create a Redis Streams-backed `kb_save` job.
- `POST /v1/jobs/attempt` / `POST /v1/jobs/retry`: record worker attempts and
  bounded retry state.
- `POST /v1/jobs/complete` and `GET /v1/jobs/<job_id>`: persist and inspect
  terminal async job state.

Redis is coordination state, not the source of truth. Runtime callers that use
`/v1/idempotency/admit` must fail closed for side effects when Redis is
unavailable. The stream-bridge ingress rate-limit integration is intentionally
fail-open during this rollout so a runtime restart does not interrupt existing
chat traffic; n8n remains the compatibility path until Phase 2 moves tool
admission behind the runtime.

The shared side-effect boundaries (`todo_add`, `todo_done`, `create_reminder`,
and `cancel_reminder`) use
`PLATFORM_TOOL_IDEMPOTENCY_MODE`: `off` disables the adapter, `fallback`
(default) uses Redis when available and keeps the existing Data Table behavior
when it is not, and `strict` returns a server error when runtime admission
cannot be confirmed. An ambiguous write is marked `UNKNOWN` and is never
automatically released for a duplicate retry. `todo_done` accepts the same
`x-session-id`, `x-idempotency-key`, `x-trace-id` and `x-request-id` contract as
`todo_add`; chat callers provide these fields automatically.
`create_reminder` accepts the same request metadata and uses a
`reminder:create:<session_id>` scope. Its runtime metadata is kept out of the
domain Data Table columns, so existing reminder rows and the fallback response
shape remain unchanged.
`cancel_reminder` uses a `reminder:cancel:<session_id>` scope and keeps the
existing `id + pending` update guard. A successful cancellation is replayable;
an already-canceled or missing reminder is recorded as a deterministic failed
tool result, while an ambiguous update is marked `UNKNOWN` and moved to
`WAITING_RETRY`.
`kb_save` wraps only the chat/MCP `mode=ingest` path with the `kb:save` scope.
The chat gateway passes its implicit tool key; a direct caller defaults to a
SHA-256 of the note text. The existing knowledge-base content hash remains the
domain-level duplicate guard. Embedding and the
Postgres write stay in the existing KB workflow; runtime metadata is kept out
of the KB tables. `list`, `search`, `health`, `retire`, manual ingest and
summary-archive callers remain on their original path. A successful replay is
HTTP 200; a recovered confirmed failure is replayed with a non-2xx status so
MCP and chat callers cannot report a failed save as successful.
The existing `idempotency_records` table is used only as a result-recovery
fallback after a confirmed todo insert; Redis remains the admission authority.
`UNKNOWN` is an idempotency-record state for an ambiguous side effect; it is
separate from the durable request state machine above.
Recovery is an operator-confirmed action: inspect the domain table first, then
resolve the Redis record with `/v1/idempotency/complete` using the confirmed
business result (which may be `{ ok: false, ... }`) and close the durable
request with `/v1/requests/transition` (normally `FAILED` for a confirmed
validation or write failure). A blind retry is never the recovery action. The
small helper below performs that two-part journal update; it does not inspect
domain tables or guess the outcome:

```powershell
node --env-file=.env n8n/scripts/recover-platform-request.mjs `
  --request-id <request-id> --scope <scope> `
  --idempotency-key <idempotency-key> --trace-id <32-hex> `
  --tool-name <tool> --result-json '{"ok":false,"status":422,"code":"..."}'
```

If Redis TTL has already expired, add `--allow-missing-idempotency`; the
durable request will still be closed, and the missing Redis record is reported
instead of being recreated.

The Postgres schema in `platform-schema.sql` is safe to apply repeatedly. The
runtime treats the platform tables as an observability/state journal: a state
store outage returns a runtime error to the caller but does not block the
default n8n `fallback` todo path.

## Phase 2 async boundary

`kb_save` is the first asynchronous boundary. With
`PLATFORM_KB_ASYNC_ENABLED=true`, admission creates a Redis Streams job and the
entry returns `202` with a `task_id`; `platform-worker` calls the existing KB
workflow and completes the same idempotency key and durable request. The flag
defaults to `false`, so the synchronous path remains the compatibility mode.
Only `kb_save` is queued in this phase; other tools are unchanged.

Phase 2.1 bounds worker recovery: stale stream deliveries are reclaimed with
`XAUTOCLAIM`, transient transport/server failures are retried up to the
configured attempt limit, and terminal job completion is ACKed exactly once.
The worker treats an already terminal runtime job as completed when recovering
after a crash, preventing a second business execution.
