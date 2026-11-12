# Sandbox gateway request admission — live acceptance (2026-11-12)

P1 acceptance for `n8n/sandbox_gateway.js` admission control, run against the
Docker Desktop Kubernetes pilot (`docker-desktop` context, namespace
`agent-platform`). Offline contracts: `node --test n8n/sandbox-gateway.test.mjs`
(24/24, CI job `sandbox-admission-contract-tests`). This report is the live
gate; offline green alone is not acceptance.

## What was deployed

- Image `agent-platform/sandbox-gateway:0.3` built from
  `n8n/sandbox-gateway.Dockerfile` (gateway + `sandbox_admission.js` +
  `sandbox_metrics.js`), applied via
  `deploy/k8s/phase3-pilot/sandbox-gateway-deployment.yaml`.
- Admission config confirmed from the pod's structured startup log:
  `rateRpm=30, rateBurst=10, maxInflight=4, allowedCallers=[]`.
- Acceptance tool: `deploy/k8s/phase3-pilot/admission-check.mjs` (reads
  `CHAT_API_KEY` from env/`.env`, never prints it).

## Commands

```powershell
docker build -f n8n/sandbox-gateway.Dockerfile -t agent-platform/sandbox-gateway:0.3 n8n
kubectl apply -n agent-platform -f deploy/k8s/phase3-pilot/sandbox-gateway-deployment.yaml
kubectl rollout status deployment/platform-sandbox-gateway -n agent-platform
# temporary operator port-forward (the scheduled bridge task is disabled, see below)
kubectl -n agent-platform port-forward service/platform-sandbox-gateway --address 127.0.0.1 18080:8080

node deploy/k8s/phase3-pilot/admission-check.mjs                       # accounting mode
# live negative control: enforce an allowlist, re-run, then revert
kubectl set env deployment/platform-sandbox-gateway -n agent-platform SANDBOX_ALLOWED_CALLERS=chat-gateway,agent-eval,admission-check,admission-check-rate,admission-check-busy
node deploy/k8s/phase3-pilot/admission-check.mjs --allowlist chat-gateway,agent-eval,admission-check,admission-check-rate,admission-check-busy
kubectl set env deployment/platform-sandbox-gateway -n agent-platform SANDBOX_ALLOWED_CALLERS-
kubectl apply -n agent-platform -f deploy/k8s/phase3-pilot/sandbox-gateway-deployment.yaml
```

## Results

Accounting mode (allowlist empty) — exit 0, 8/8 probes:

| Probe | Result |
|---|---|
| healthz | 200 |
| missing key | 401 `unauthorized` |
| invalid caller (`Bad Caller`) | 400 `invalid_caller`, no Job created |
| happy path `print(2 + 2)` | 200, real Job, stdout `4\n` |
| header-less default caller | 200 (admitted, labelled `default`) |
| 12 parallel requests, fresh caller | 4 admitted / 6 `busy` / 2 `rate_limited`, `Retry-After` ≥ 1 |
| 6 parallel `time.sleep(4)` Jobs, fresh caller | 4 admitted / 2 `busy` (cap 4) |
| metrics surface | unauthorized=1, invalid_caller=1, admitted=10, rate_limited=2, busy=8; runs ok + histogram present; inflight back to 0 |

Allowlist enforcement (live negative control) — exit 0, 10/10 probes:

| Probe | Result |
|---|---|
| unlisted caller | 403 `caller_not_allowed` |
| header-less (`default` not listed) | 403 `caller_not_allowed` |
| listed caller happy path | 200, stdout `4\n` |
| rate / concurrency probes | same shape as accounting mode |
| metrics surface | caller_not_allowed=3 visible alongside the other classes |

Restore verification: after removing the override and re-applying the
manifest, the new pod logged `allowedCallers=[]` and a header-less
`print(6*7)` request returned 200 with stdout `42\n` — the exact request
shape the currently deployed n8n workflow sends (it does not yet carry the
caller header; see boundaries).

## Defects found and fixed while verifying

1. `reject()` called `res.setHeader` after `res.writeHead`
   (`ERR_HTTP_HEADERS_SENT`), which would have killed every rejection path.
   Caught by the offline HTTP contracts before any live run; fixed by
   passing all headers in one `writeHead` call.
2. The test harness hung on keep-alive sockets and, under a mutation that
   removed the concurrency cap, deadlocked instead of failing. Fixed with
   `closeAllConnections()`, per-test timeouts, a root `after()` server
   registry and an unref'd gate timer.
3. One test assertion was a bad ruler (expected two 403s under one caller
   label; they are correctly labelled per caller). Fixed the assertion, not
   the gate.

Mutation negative control (offline): disabling the cap and the rate refusal
in `sandbox_admission.js` turned the suite red (5 failing tests, exit 1);
restoring the module returned 24/24 green. The gate is not vacuous.

## Boundaries / 未跑

- The persistent bridge scheduled task `AgentPlatform-SandboxBridge` exists
  but is **disabled**; acceptance used a temporary operator port-forward
  that was stopped afterwards. Until the bridge is restored
  (`.\deploy\k8s\phase3-pilot\sandbox-bridge.ps1 -Action install`), the live
  n8n `SANDBOX_URL=http://host.docker.internal:18080` path is ECONNREFUSED —
  the same state as before this change.
- End-to-end `run_python` through the live n8n workflow was **not run**
  (needs an upstream model call). The gateway side of that exact request
  shape (shared key, no caller header) is proven by the restore probe.
- The n8n workflow has **not been redeployed**; the `x-sandbox-caller:
  chat-gateway` header lands on the next operator deploy
  (`sandbox-caller-patch.mjs`, covered offline). Accounting mode admits
  header-less callers, so nothing breaks in between.
- Admission state is in-memory and per replica; the phase6 two-replica
  overlay gets per-replica budgets. Caller identity is accounting behind the
  shared key, not authentication.
- Probe Jobs self-clean via `ttlSecondsAfterFinished=300`; all probe input
  Secrets were deleted by the gateway's `finally`. The remaining
  `platform-sandbox-input` Secret is the 14-day-old manual runbook Job, not
  acceptance residue.

## Live state after acceptance

Gateway `0.3`, one replica, allowlist empty (manifest re-applied, live
matches repo), admission defaults 30 rpm / burst 10 / 4 in-flight. Compose
stack, Runtime, Redis Streams `kb_save` and n8n workflows untouched.