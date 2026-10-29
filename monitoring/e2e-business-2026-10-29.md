# End-to-end business baseline

Run date: 2026-10-29 (Asia/Shanghai)

This is a local Docker Desktop baseline. It is a read-only business-path test:
the requests cross the host, n8n webhooks, workflow execution and Postgres/Data
Tables. It does not call an upstream model and does not write business rows.

Command:

```powershell
node --env-file=.env n8n/scripts/e2e-business-load.mjs
```

Configuration: 20 requests per endpoint, concurrency 5, 30-second timeout.

| Endpoint | Requests | Success | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `chat_stats` | 20 | 20 | 655.06 ms | 782.71 ms | 782.71 ms |
| `platform_overview` | 20 | 20 | 783.74 ms | 1122.97 ms | 1122.97 ms |
| `platform_settings` | 20 | 20 | 360.39 ms | 450.19 ms | 450.19 ms |
| `people` | 20 | 20 | 448.05 ms | 857.68 ms | 857.68 ms |
| `todos` | 20 | 20 | 693.73 ms | 1051.63 ms | 1051.63 ms |

Result: 100/100 successful responses, 100% success rate, zero transport errors,
zero response-shape errors.

The same run also rechecked the platform coordination layer with 500 requests
(200 idempotency admissions, 100 rate-limit calls and 200 lock acquisitions at
concurrency 50):

| Operation | p50 | p95 | Max | Result |
| --- | ---: | ---: | ---: | --- |
| Idempotency admission | 75.27 ms | 226.16 ms | 291.11 ms | 1 admitted, 199 replayed/in-flight |
| Rate limit | 38.33 ms | 66.04 ms | 67.74 ms | 50 allowed, 50 blocked |
| Lock acquisition | 39.41 ms | 50.04 ms | 51.36 ms | 1 acquired, 199 contended |

Metrics validation after the run:

- Prometheus targets `platform-runtime` and `stream-bridge`: both `up`.
- Runtime `http_errors_total=0`, `state_store_errors_total=0`.
- Stream Bridge `stream_bridge_errors_total=0`.
- Runtime coordination counters reflected the load: `rate_limited_total=52`,
  `locks_contended_total=200`.

This baseline is not a capacity guarantee. The next higher-risk test would be
a separately approved model-backed chat load, because that incurs upstream
cost and changes business execution statistics.
