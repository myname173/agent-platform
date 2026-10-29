# Phase 5.2 Capacity and Kafka Decision

Date: 2026-10-29

## Current baseline

The first capacity check intentionally used read-only paths so it could run
against the live Pilot without model cost or business side effects.

| Test | Configuration | Result |
| --- | --- | --- |
| Business E2E | 5 endpoints, 30 requests each, concurrency 10 | 150/150 successful; 0 model calls; 0 business writes |
| Runtime idempotency | 200 requests, concurrency 50 | 200/200 transport-successful; one winner, 199 replay/in-flight |
| Runtime rate limit | 100 requests, concurrency 50 | 50 allowed, 50 blocked as expected |
| Runtime lock | 200 requests, concurrency 50 | 200/200 transport-successful; one lock winner |

Observed runtime p95 latency was 203.70 ms for idempotency, 120.45 ms for
rate-limit and 106.32 ms for lock operations. Business endpoint p95 ranged from
1.03 s to 3.94 s in this read-only run.

This is a platform and read-path baseline, not a model capacity guarantee.
Model latency, provider quotas, streaming connections and long-running tools
need a separate controlled test before promising a concurrency target.

## Kafka decision

Do not add Kafka to the current Phase 5.2A path. `kb_save` is the only current
asynchronous business job, and the existing Redis Stream already provides the
needed queueing, idempotency, pending recovery and bounded retry behavior.

Kafka becomes an explicit follow-up when at least one of these is true in a
production-like measurement:

- the job stream sustains roughly 500-1000 events/second or has a backlog that
  does not drain during the expected peak window;
- several independent consumers need durable replay of the same event stream;
- messages must be retained for days/weeks for audit, billing or analytics;
- queue recovery, partitioning or cross-cluster replication becomes a real
  requirement rather than a theoretical one.

User count alone is not a Kafka trigger. For the current target of a few
hundred users, the first scaling levers are external ingress, per-user or
per-tenant rate-limit scopes, Gateway/Worker replicas, model quotas and the
Redis/Postgres durability plan.

## Next capacity gate

Before claiming a production capacity target, run a staged test at 30, 50 and
100 concurrent requests with a controlled model budget, then record:

- request p95/p99 and error rate;
- active model calls and provider throttles;
- Redis stream pending and queue wait time;
- Worker completion/failure/retry counts;
- Postgres connection saturation.

The result decides whether to add replicas or change queue settings. It does
not pre-commit the project to Kafka.
