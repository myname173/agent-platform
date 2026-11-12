# Phase 3.3 K8s pilot closure

This directory is a pilot boundary, not a replacement for the current Compose
stack. It contains:

- a single-replica `platform-worker` Deployment with the existing Redis Stream
  recovery settings;
- a one-shot sandbox Job with `activeDeadlineSeconds`, `backoffLimit: 0`,
  `ttlSecondsAfterFinished`, resource limits, a non-root identity and a default
  deny-all NetworkPolicy.

## Pilot Runbook

Run these commands from the repository root. `apply` does not create the fixed
manual Sandbox Job; business requests create short-lived Jobs through the
Gateway instead.

```powershell
.\deploy\k8s\phase3-pilot\pilot.ps1 -Action apply -BuildImages
.\deploy\k8s\phase3-pilot\sandbox-bridge.ps1 -Action install
```

The installer registers a current-user scheduled task that keeps the
loopback-only bridge running and reconnects it after Docker/Kubernetes
restarts. Verify the complete boundary:

```powershell
.\deploy\k8s\phase3-pilot\pilot.ps1 -Action check
```

The bridge binds only to `127.0.0.1:18080`; it does not expose a LAN port.
Remove it with `sandbox-bridge.ps1 -Action uninstall` when returning to the
Compose-only path.

The worker uses a deliberate Docker Desktop bridge while the current Compose
stack remains authoritative: `n8n` is reached at the published port `5678`,
while Runtime and Redis use host-loopback pilot ports `13220` and `16379`.
Kubernetes resolves these through `host.docker.internal`; the NetworkPolicy
allows only the host gateway and these three TCP ports. The bridge is not a
LAN exposure and does not move stateful services into Kubernetes.

Set `PLATFORM_RUNTIME_HOST_PORT` and `PLATFORM_REDIS_HOST_PORT` in `.env` only
if the defaults are occupied, and keep the K8s ConfigMap and NetworkPolicy in
sync. A non-Docker-Desktop cluster should replace these values with internal
Service endpoints before applying the worker.

## Static validation

```powershell
kubectl kustomize deploy/k8s/phase3-pilot
kubectl apply --dry-run=client --validate=false -k deploy/k8s/phase3-pilot
```

`secret.example.yaml` is intentionally excluded from `kustomization.yaml` and
must never be applied with its placeholder values. Create real secrets in the
cluster first:

```powershell
kubectl -n agent-platform create secret generic platform-runtime-secrets `
  --from-literal=CHAT_API_KEY="$env:CHAT_API_KEY" `
  --from-literal=PLATFORM_RUNTIME_KEY="$env:PLATFORM_RUNTIME_KEY"

$payload = '{"code":"print(2 + 2)","timeout":5,"allow_network":false}'
kubectl -n agent-platform create secret generic platform-sandbox-input `
  --from-literal=request.json=$payload
```

Build the sandbox image after changing `sandbox_job.py`:

```powershell
docker build -f n8n/sandbox.Dockerfile -t agent-platform/sandbox:3.14-k8s-pilot n8n
```

The first acceptance test is the sandbox Job. Verify the JSON result,
timeout cleanup and that a code snippet using `socket` cannot reach the network.
Before enabling the worker, verify all three host-gateway endpoints from a pod;
the Compose path remains the compatibility path meanwhile and
`PLATFORM_KB_ASYNC_ENABLED` stays disabled by default.

## Business `run_python` path

The K8s gateway creates one short-lived Job per ordinary `run_python` call.
Build and apply it after the sandbox image is available:

```powershell
docker build -f n8n/sandbox-gateway.Dockerfile -t agent-platform/sandbox-gateway:0.3 n8n
kubectl apply -n agent-platform -f deploy/k8s/phase3-pilot/sandbox-gateway-rbac.yaml
kubectl apply -n agent-platform -f deploy/k8s/phase3-pilot/sandbox-gateway-deployment.yaml
kubectl apply -n agent-platform -f deploy/k8s/phase3-pilot/sandbox-gateway-service.yaml
```

Docker Desktop does not expose this NodePort through the host gateway by
default. Install the loopback-only bridge while the pilot is in use:

```powershell
.\deploy\k8s\phase3-pilot\sandbox-bridge.ps1 -Action install
.\deploy\k8s\phase3-pilot\sandbox-bridge.ps1 -Action check
```

Set `SANDBOX_URL=http://host.docker.internal:18080` and redeploy the Chat
Gateway. `SANDBOX_APPROVED_URL` remains `http://n8n-sandbox:8000`, so an
approved request that explicitly needs network access keeps the existing
Compose behavior; ordinary requests use the deny-all K8s Job.

The deploy patch (`n8n/scripts/sandbox-caller-patch.mjs`) also sends
`x-sandbox-caller: chat-gateway`; `agent-eval.mjs` sends `agent-eval`. The
header is admission accounting, not authentication — the shared
`x-sandbox-key` remains the only trust boundary.

## Request admission

The gateway (image `0.3`) admits requests in this order: shared-key auth,
caller identity, allowlist + per-caller token bucket, input validation,
global in-flight Job cap. Every rejection returns a distinct error code,
a structured JSON log line (`event=request_rejected`) and a counter on
`GET /metrics` (`sandbox_gateway_requests_total{caller,decision}`), so
refusals are observable without log parsing. `/metrics` needs no key and
exposes counters only; scrape it in-cluster or through the loopback bridge.

| Env | Default | Meaning |
|---|---|---|
| `SANDBOX_RATE_RPM` | `30` | Sustained requests per minute per caller (token refill rate). |
| `SANDBOX_RATE_BURST` | `10` | Token bucket capacity per caller (instant burst). |
| `SANDBOX_MAX_INFLIGHT` | `4` | Global cap on concurrent Jobs; each Job may use 1 CPU / 2Gi. |
| `SANDBOX_ALLOWED_CALLERS` | empty | Comma-separated allowlist. Empty = accounting mode: every authenticated caller is admitted and labelled. Set e.g. `chat-gateway,agent-eval` to enforce; anyone else (including header-less callers, which map to `default`) gets 403. |

Rejection codes: 401 `unauthorized` (bad key), 400 `invalid_caller`
(identity outside `[a-z0-9][a-z0-9_-]{0,31}` — refused, never normalised),
403 `caller_not_allowed`, 429 `rate_limited` and 429 `busy` (both carry
`Retry-After`). Rate tokens are spent before body parsing, so malformed
floods still cost the caller quota; concurrency slots are only taken after
validation and are released even when the Job fails.

Boundaries to keep honest:

- Admission state is in-memory and **per replica**. The phase6 two-replica
  overlay therefore gets per-replica budgets, not a shared cluster budget.
- Caller identity is self-declared behind the shared key; it separates
  budgets and attribution, it does not authenticate. Promoting to the
  allowlist only blocks callers that do not know a listed name.
- A malformed `SANDBOX_ALLOWED_CALLERS` entry fails startup (fail closed)
  rather than silently dropping the entry.

Offline contracts: `node --test n8n/sandbox-gateway.test.mjs` (CI job
`sandbox-admission-contract-tests`). Live acceptance is operator-run against
the bridge; offline green is not live acceptance:

```powershell
node deploy/k8s/phase3-pilot/admission-check.mjs
# allowlist-enforcement pass (list must include the three admission-check* callers):
node deploy/k8s/phase3-pilot/admission-check.mjs --allowlist chat-gateway,agent-eval,admission-check,admission-check-rate,admission-check-busy
```

The 2026-11-12 live run (both modes plus restore) is recorded in
`monitoring/sandbox-admission-2026-11-12.md`.

## Enable the Worker on Docker Desktop

The current pilot uses `docker-desktop` and the gateway `192.168.65.254`. If
that gateway changes, update both `worker-configmap.yaml` and
`worker-networkpolicy.yaml` before applying them:

```powershell
kubectl apply -n agent-platform -f deploy/k8s/phase3-pilot/worker-configmap.yaml
kubectl apply -n agent-platform -f deploy/k8s/phase3-pilot/worker-networkpolicy.yaml
kubectl apply -n agent-platform -f deploy/k8s/phase3-pilot/worker-deployment.yaml
kubectl rollout status deployment/platform-worker -n agent-platform
```

The explicit namespace is intentional because these files are also useful
individually; applying them without `-n agent-platform` would create resources
in the current default namespace.
