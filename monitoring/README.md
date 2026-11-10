# Platform Observability

Phase 1.3 keeps one business-facing source of truth and one infrastructure
metrics path:

- Console `/webhook/v1/stats/executions` remains the business view for request
  totals, success/error rate, average latency, token usage, cost and recent
  tool traces. Alerts consume the same stats API.
- `platform-runtime:3220/metrics` exposes Redis admission, rate-limit, lock,
  durable state and request latency metrics.
- `stream-bridge:3211/metrics` exposes request count, errors, rate limiting and
  latency metrics.

Prometheus is only for internal runtime metrics. Grafana and a second business
metrics exporter are intentionally not part of this stack, so Console and
Prometheus do not duplicate business dashboards or develop separate metric
definitions.

Prometheus is in the optional `observability` profile and is bound to localhost
on `PROMETHEUS_PORT` (default `9090`):

```powershell
docker compose --profile observability up -d prometheus
```

The runtime-only baseline load test is safe to run against the internal service
and does not call an upstream model:

```powershell
docker compose exec -T platform-runtime npm run test:load
```

It reports p50/p95/max latency and verifies one-winner idempotency, rate-limit
cutoff and lock contention. The baseline is recorded in
`monitoring/baseline-2026-10-28.md`.

The read-only end-to-end business baseline crosses the host, n8n webhooks,
workflow execution and Postgres/Data Tables. It covers the Console's stats,
overview and settings APIs plus people/todo reads; it deliberately makes zero
model calls and zero business writes:

```powershell
node --env-file=.env n8n/scripts/e2e-business-load.mjs
```

Tune `E2E_REQUESTS_PER_ENDPOINT`, `E2E_CONCURRENCY` and `E2E_TIMEOUT_MS` for a
larger run. The latest 100-request result is recorded in
`monitoring/e2e-business-2026-10-29.md`.

## Phase 4.1 Agent quality and security

The first Agent evaluation is deliberately local and deterministic. It uses
the live Chat Gateway for a small tool-selection/client-tool set and the K8s
Sandbox Gateway for authentication, network/process/dynamic-execution/file
write policy checks. It adds no service, database, package or LLM judge:

```powershell
node --env-file=.env n8n/scripts/agent-eval.mjs
```

The command prints per-case results and a JSON report. Set
`EVAL_SANDBOX_URL` when the loopback Pilot bridge is not at
`http://127.0.0.1:18080`. A non-zero exit means at least one quality or
security contract failed.

The 2026-10-29 baseline is recorded in
`monitoring/agent-eval-2026-10-29.md`.

Phase 4.2 extends the same command with user-content prompt injection,
unregistered MCP tool calls, temporary KB poisoning and task-level answer
scoring. The KB fixture is created with a unique title and retired in a
`finally` cleanup path; a failed cleanup makes the command fail:

```powershell
node --env-file=.env n8n/scripts/agent-eval.mjs
```

The evaluator reads `chat_executions.tool_trace` for required and forbidden
tool assertions. It does not use an LLM judge: each task score is based on
required facts, forbidden markers, answer length and source/citation markers.

## Phase 4.3 assertion hardening

The same command now reads the server tool list from the chat gateway
workflow instead of carrying a copy of it, and a case that names a tool the
gateway does not have aborts the run instead of passing quietly. The network
case asserts against the platform's own tool trace — the trace records
whether the sandbox refused — rather than against a word in the answer. The
sandbox refuses code in two layers: the text scan, and a runtime guard inside
the child that refuses a renamed import, a renamed builtin, a write, a spawn
and a socket call.

The result, including what was not run, is recorded in
`monitoring/agent-eval-2026-11-05.md`.

## Evaluation foundation: shakedown is not release acceptance

PR #8 introduced 26 local scenarios (16 quality, 10 security), a trace miner,
judge and replay gate. Its two original CI checks did not execute this harness.
The follow-up adds offline contract tests with negative controls to CI. These
checks validate the measurement code, not actual model task success.

```powershell
node n8n/scripts/eval-validate.mjs
node n8n/scripts/eval-run.mjs --dry --runs 3
node --test n8n/scripts/eval-contract.test.mjs n8n/scripts/eval-mine.test.mjs n8n/scripts/eval-judge.test.mjs n8n/scripts/kb-eval.test.mjs
node --env-file=.env n8n/scripts/eval-run.mjs --preflight
```

Read-only check on 2026-11-10: local n8n :5678 and runtime :13220 health
endpoints returned 200; `eval_runs` / `eval_results` were absent and the active
Chat Stats API lacked eval-traffic isolation. The dependency is therefore
**deployment readiness**, not an assumed offline stack. No workflows were
deployed by this check. Do not run a blanket deploy against the shared instance
without reviewing its live/source drift and coordinating with the other agent.

After an isolated test deployment is chosen and prepared, the shakedown command
is:

```powershell
node --env-file=<isolated-test-env> n8n/scripts/eval-run.mjs --isolated-stack --deterministic-only --runs 3 --record
node n8n/scripts/eval-gate.mjs --replay-dir .eval-local/replay/<run-id> --runs 3
```

`--isolated-stack` is an operator acknowledgement, not a technical sandbox.
These scenarios can create reminders/todos or, on an injection failure, cancel
existing records. Do not point this command at shared business data. Each real
user turn is sent after the previous real assistant answer: 26 x 3 means 78
attempts and **84 gateway requests**, not 78 model calls. Tool loops add an
unknown number of upstream calls. The budget stops before the next request;
one in-flight request may overshoot. Missing cost telemetry stops the run.

Live and replay share one assertion engine. Missing traces, empty responses,
unsupported assertions and incomplete fixture coverage fail closed. Fixtures
contain every attempt, not only successes, and bind case/suite/harness hashes.
A replay pass checks recorded observations only; it does not test the current
remote gateway. `pass_1`, `pass_k` (all k attempts), and `pass_at_k` (at least
one) are separate. Incomplete runs expose observed statistics but no comparable
baseline TSR/pass-k. Database persistence must pass read-back verification.

The runner deliberately marks judge quality and final database-state assertions
as unfinished; `--deterministic-only` cannot produce `release_ready=true`.
The judge calibration skeleton is not human-labeled evidence. KB retrieval
uses answerable queries as its denominator; unanswerable cases remain pending
answer evaluation, not retrieval failures or demonstrated correct refusals.

```powershell
node n8n/scripts/eval-mine.mjs --dry --days 3
node --env-file=.env n8n/scripts/eval-mine.mjs --days 3
```

Mining reads source rows only. Candidate reports and raw reports/replays default
to ignored `.eval-local/` directories; review and redact before publishing
anything to this public repository. Candidate count is not failure count, and
three days of retrospective rows is not three consecutive successful scheduled
runs. No nightly schedule has been installed. Reaching 60 reviewed cases,
collecting complete live fixtures, human calibration, and three comparable
baseline batches remain separate acceptance steps.

Local verification on 2026-11-10: 110 offline tests passed with zero skips and
26 workflow files validated with zero warnings. Four CLI negative controls
rejected missing replay fixtures (exit 1), the unfinished calibration skeleton,
KB execution without isolation confirmation, and a NaN repeat count (exit 2).
The new CI job has not run remotely; these are local checks, not live acceptance.
One read-only mining run (`--days 3 --limit 2000`) covered
2026-11-07T09:07:55.951Z through 2026-11-10T09:07:55.951Z with zero in-window
executions, messages or candidates, without truncation. Both source tables'
latest records were still dated November 2; zero candidates is not a health verdict.

## Phase 2 async KB save

The Redis Streams worker is optional and only handles `kb_save`:

```powershell
$env:PLATFORM_KB_ASYNC_ENABLED = 'true'
docker compose --profile phase2 up -d platform-worker
```

When enabled, the entry request returns `202` with a `task_id`; the worker
executes the existing KB workflow and runtime stores the final result. Leave
`PLATFORM_KB_ASYNC_ENABLED=false` to keep the synchronous path.

Phase 2.1 adds bounded worker recovery: stale Redis Stream deliveries are
claimed after `PLATFORM_JOB_CLAIM_IDLE_MS` (default 120 seconds), retryable
network/5xx/429 failures are retried up to `PLATFORM_JOB_MAX_ATTEMPTS` (default
3), and terminal failures are recorded as `FAILED`. The worker ACKs a message
only after a terminal runtime completion; a completed job reclaimed after a
worker restart is recognized as terminal and is only ACKed.

The repeatable regression requires the flag and worker to be active:

```powershell
node --env-file=.env n8n/scripts/test-kb-async.mjs
```

The recovery regression temporarily manages the worker and n8n containers:

```powershell
node --env-file=.env n8n/scripts/test-kb-async-recovery.mjs
```

## Phase 5.0 Release Gate

The lightweight Pilot release gate reuses the checks above plus the read-only
business baseline, platform boundary regression and Agent evaluation. It does
not add a runner or change runtime configuration. The 2026-10-29 result is
recorded in `monitoring/release-gate-2026-10-29.md`.

## Phase 5.1 Pilot closeout

The operational runbook for the current Docker Desktop Pilot covers startup,
the smallest routine checks, failure triage, controlled rollback to Compose and
the explicit non-production limits:
`monitoring/pilot-runbook-2026-10-29.md`.

The first Phase 5.2 capacity baseline and Kafka decision are recorded in
`monitoring/phase5.2-capacity-decision-2026-10-29.md`.

## Phase 5.2A external access boundary

The opt-in external Compose overlay removes direct application/storage host
ports, terminates public TLS at Caddy on `80/443`, and keeps Redis, Runtime,
Worker and the Kubernetes Sandbox Gateway private:
`deploy/external/README.md`.

## Phase 6.5A Release Candidate freeze

The first production closeout step is intentionally read-only. It verifies
that the default Compose service set contains only the core stack, optional
Kafka/Outbox/Prometheus/Worker profiles stay opt-in, the K8s pilot manifests
still render, and the local Console/n8n/Runtime/Redis health boundary is up:

```powershell
.\deploy\release\phase65a.ps1 -Action check
```

The command reports whether the current `.env` is using the `compose-sync` or
`pilot-async` boundary and never changes services or business data. A passing
check is a Release Candidate configuration check, not a production HA approval.

## Phase 6.5C K8s production-candidate boundary

The production-candidate overlay keeps the existing Pilot base but adds two
replicas, RollingUpdate, PDBs and Sandbox Gateway probes. It is render-only
until a real multi-node or managed cluster is selected:

```powershell
kubectl kustomize deploy/k8s/phase6-production
kubectl apply --dry-run=server -k deploy/k8s/phase6-production
```

The current `docker-desktop` context remains the one-replica Pilot. Before an
apply, replace its Docker Desktop host-gateway endpoints with target-cluster
Service or managed-service endpoints and make the stateful-service ownership
explicit.

## Phase 5.3 Kafka event-bus pilot

Kafka is available as an opt-in single-node KRaft profile for event-contract
and produce/consume validation. It does not replace the Redis Streams
`kb_save` queue. See `deploy/event-bus/README.md`.

## Runtime `.env` key audit (2026-11-05)

Recorded in `monitoring/env-ledger-2026-11-05.md`. Two silent-failure findings on
the local `.env` (never tracked; no secret values recorded): `ALERT_WEBHOOK_URL`
is empty while `docker-compose.yml:91` falls back with `:-`, so alert pushes have
no downstream and nothing errors; and `ADMIN_PASSWORD_HASH` is assigned twice
(empty early, real value later). A throwaway-file test showed Compose honours the
**last** assignment, so the Phase 6.1 external-edge requirement below is currently
met — but the ordering is fragile, and the two compose files disagree on failure
mode (`:-` stays silent, `:?` in `deploy/external/` fails loudly). Recommended
fix is a manual `.env` edit, not a scripted one.

## Phase 6.1 external access boundary

The Sandbox Gateway now uses a supervised loopback-only bridge at
`127.0.0.1:18080`, with a current-user scheduled task that reconnects after
Docker/Kubernetes restarts. The external Caddy edge remains opt-in and refuses
to start until a real `PLATFORM_DOMAIN`, `ACME_EMAIL` and
`ADMIN_PASSWORD_HASH` are present in `.env`. Use `deploy/external/edge.ps1` for
the preflight and lifecycle commands.

When the router cannot provide inbound port forwarding, use the router-
independent Cloudflare Tunnel overlay in `deploy/cloudflare/README.md`. It
keeps the local Caddy path intact and adds an outbound-only `cloudflared`
connector on the existing Docker network.
