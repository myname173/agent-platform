# Phase 5.0 Release Gate

Date: 2026-10-29

Scope: controlled Pilot release on Docker Desktop Kubernetes context
`docker-desktop`. Compose remains authoritative for n8n, Redis and the
platform runtime; the K8s Worker and Sandbox Gateway are the Pilot boundary.

## Gate result

**PASS for the current Pilot scope.** No new runtime component or defensive
fallback was added for this gate.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Static/syntax/diff | PASS | `node --check` for evaluator/deploy scripts; `git diff --check` |
| K8s Pilot health | PASS | Worker and Sandbox Gateway `1/1`; n8n/runtime/gateway health `200`; Redis `PONG` |
| Read-only business E2E | PASS | 100/100 requests; 100% success; 0 transport/shape errors; 0 model calls; 0 business writes |
| Platform boundaries | PASS | todo/reminder add/done/cancel; 4 replay checks; deterministic no-op |
| `kb_save` async boundary | PASS | `202` queue, Worker completion, same-key replay, trace propagation; temporary document retired |
| Agent quality/security | PASS | 12/12; quality 2/2; security 10/10; scored cases 2/2; average ratio 1 |
| Post-test cleanup | PASS | No Sandbox Jobs remain; Redis stream pending `0`; no active temporary KB fixtures |

## Runtime snapshot

`platform-runtime:3220/metrics` after the gate:

```text
jobs_enqueued_total 12
jobs_completed_total 12
jobs_failed_total 0
jobs_retried_total 0
rate_limited_total 0
state_store_errors_total 0
```

## Configuration note

The current `.env` has `PLATFORM_KB_ASYNC_ENABLED=true`, so the synchronous
Phase 1.3 `test-kb-boundary.mjs` is not applicable in this environment: its
first request correctly returned `202` instead of the synchronous `200` it
asserts. The release gate used the matching `test-kb-async.mjs` contract and
did not change the environment to force a different mode.

## Release boundary

This is a controlled Pilot release gate, not a production HA approval. The
current K8s setup remains single-replica and uses the existing local
loopback bridge boundary. Productionization (HA, ingress, autoscaling and a
separate deployment authority) is intentionally deferred until there is a
real deployment requirement.
