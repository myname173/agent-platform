# Outbox Publisher v1 Isolation Experiment

Run date: 2026-10-30 (Asia/Shanghai)

Scope: an isolated publisher reading only `platform.outbox` rows with
`kind=kafka-pilot` and publishing to `platform.events.outbox.v1`. Runtime state
transitions, the direct `platform.events` publisher and Redis Streams `kb_save`
were not changed.

## Basic delivery

- Publisher: `platform-outbox-publisher`, running in the `event-bus-outbox`
  Compose profile
- Topic: `platform.events.outbox.v1`
- Seed: 3 rows with unique `dedupe_key` values
- Result: all 3 rows reached `DELIVERED` with `attempts=1`
- Kafka verification: a fresh consumer group read all 3 run records

## Expired claim recovery

One seeded row was deliberately changed to `DELIVERING` with an expired
`next_retry_at`, simulating a publisher stopping after claiming a row. The
publisher reclaimed it, published it again and marked it `DELIVERED` with
`attempts=2`.

This verifies the pilot's recovery behavior without adding schema columns. It
also demonstrates the delivery contract: Kafka publication and the PostgreSQL
confirmation are not one atomic operation, so a crash between them can create
a duplicate. The message key is the outbox `dedupe_key`; consumers must use it
for idempotency.

## Runtime transactional shadow

For a bounded business check, Runtime was temporarily started with
`PLATFORM_OUTBOX_WRITE_MODE=transactional`. One `POST /v1/requests/start`
created three state-transition rows (`event_id` 354-356) and three matching
outbox rows in the same database transaction. All three outbox rows reached
`DELIVERED` with `attempts=1`, and a separate runtime topic preserved the same
`trace_id` across the three Kafka messages.

The Runtime container was then recreated with the default
`PLATFORM_OUTBOX_WRITE_MODE=off`; the isolated pilot publisher was restored to
`kind=kafka-pilot`. No normal business path is currently writing outbox rows.

## Backlog recovery

The isolated publisher was stopped directly and 20 `PENDING` pilot rows were
seeded. PostgreSQL showed all 20 rows pending while the publisher was down.
After the publisher restarted, all 20 rows reached `DELIVERED` with
`attempts=1`, confirming that a short publisher outage creates recoverable
backlog rather than losing the queued rows.

## Kafka publish failure and retry

The publisher was temporarily pointed at a topic that did not exist. A seeded
row remained in the outbox and moved to `RETRY` with the Kafka metadata error
recorded in `last_error`. After the topic was created, the same row was
published and reached `DELIVERED` on attempt 4. The publisher was then
restored to the normal pilot topic.

## Runtime write overhead sample

Using 40 concurrent `POST /v1/requests/start` calls on the local Docker
stack, the same endpoint was sampled with the feature off and with
`PLATFORM_OUTBOX_WRITE_MODE=transactional`:

| Mode | p50 | p95 | max | Successful |
| --- | ---: | ---: | ---: | ---: |
| Outbox off | 207.08 ms | 265.56 ms | 266.55 ms | 40/40 |
| Transactional outbox | 236.30 ms | 288.70 ms | 290.33 ms | 40/40 |

This single local sample showed roughly 14% p50 and 9% p95 overhead while
writing and publishing 120 outbox rows. It is a stability signal, not a
capacity benchmark; a repeated run under representative database load is
required before enabling the feature for normal traffic.

A three-round follow-up used 40 concurrent `requests/start` calls per round
(120 calls per mode, 100% successful). The observed ranges were:

| Mode | p50 range | p95 range |
| --- | ---: | ---: |
| Outbox off | 61.39-151.65 ms | 92.02-184.17 ms |
| Transactional outbox | 95.96-245.59 ms | 151.00-304.02 ms |

Each transactional request emits three state events, and the resulting 480
outbox rows from the repeated run all reached `DELIVERED`. The first round in
each mode included connection/container warm-up, so these ranges support a
relative overhead decision but are not a production capacity claim.

## Boundary

The experiment intentionally does not make Runtime state changes write to
`platform.outbox`. Phase 6.5B adds explicit `lease_until`, `locked_at` and
`locked_by` fields. The publisher now claims expired `DELIVERING` rows through
`lease_until` and only the current publisher can mark its claim delivered or
retryable. `next_retry_at` remains the retry schedule, not the lease itself.
Runtime transactional writes remain off; formal enablement still requires a
canary, consumer idempotency and pending/retry/dead-letter metrics.

## Phase 6.5B explicit lease step

The live schema was migrated idempotently with `lease_until`, `locked_at` and
`locked_by`, while preserving all existing rows. The publisher image was
rebuilt without changing its `kafka-pilot` scope.

The recovery check inserted one pilot row with `next_retry_at` one hour in the
future, `lease_until` already expired and `locked_by=dead-publisher`. The new
publisher reclaimed it and produced:

```text
before: DELIVERING | attempts=0 | next_retry_at=future | lease_until=expired | locked_by=dead-publisher
after:  DELIVERED  | attempts=1 | locked_by=empty         | lease_until=null
```

This confirms retry scheduling and claim lease expiry are separate. Existing
Runtime transactional writes remain `off`, and no normal `kb_save` request was
changed by this step.
