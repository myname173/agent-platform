# Stability Load Test

Run date: 2026-10-30 (Asia/Shanghai)

The tests used isolated coordination keys and read-only business endpoints.
They did not call models, write the knowledge base or enqueue `kb_save` work.
Runtime Outbox write mode remained `off` during the high-volume runs.

## Platform Runtime

| Load | Result | p50 / p95 highlights |
| --- | --- | --- |
| 2,000 coordination requests, 100 concurrency | 2,000/2,000 successful; 1 admitted idempotency request; 500/500 rate split; one lock winner | idempotency p95 205 ms; rate p95 81 ms; lock p95 64 ms |
| 5,000 coordination requests, 200 concurrency | 5,000/5,000 successful; 1,250/1,250 rate split; one lock winner | idempotency p95 260 ms; rate p95 104 ms; lock p95 94 ms |
| 10,000 coordination requests, 300 concurrency | 10,000/10,000 successful; 2,500/2,500 rate split; one lock winner | idempotency p95 169 ms; rate p95 161 ms; lock p95 138 ms |

The 10,000-request run produced no transport errors or 5xx responses. Runtime
and Redis remained healthy after the run; the final Runtime health and readiness
checks both returned HTTP 200.

## Read-only business entrypoints

The existing `e2e-business-load.mjs` was run against five Console/admin
endpoints with 100 requests per endpoint and concurrency 20. All 500 requests
returned valid HTTP 200 responses with zero transport or shape errors. The
slowest p95 was `chat_stats` at about 8.45 seconds; the other endpoint p95
values were about 2.02-4.51 seconds. During this run n8n reached roughly 267%
CPU and Postgres roughly 63%, making n8n/Postgres read aggregation the visible
latency bottleneck.

## Decision signal

The current platform coordination layer is stable at this local test scale.
The result does not justify enabling transactional Outbox by itself: the
Outbox adds database writes and the existing direct event publisher is already
optional. If external traffic grows, the next capacity work should focus on
read aggregation/caching and n8n/Postgres concurrency before changing the
`kb_save` execution path.
