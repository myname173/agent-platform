# Kind elastic drill (P3) — 2026-11-12

Branch `feat/hpa-elastic-20261112`, **stacked on** `feat/kind-multinode-20261112`
@ `95185a4` (PR #13, open, unmerged per operator instruction "先别合，P3 一起看").
The P3 PR targets `main`; its diff narrows automatically once #13 merges.
Deliverables:

- `deploy/k8s/phase6-production/components/elastic/` — opt-in Kustomize
  Component: two `autoscaling/v2` HPAs (worker min 2/max 6, gateway min 2/max 4,
  CPU Utilization 70%, scale-down stabilization 300s) + `replicas: null`
  patches that hand replica ownership to the HPAs.
- `deploy/k8s/phase6-kind-elastic/` — drill root: P2 kind boundary + the
  component + drill-only patches (stabilization 30s, gateway admission raised
  to 6000 rpm / burst 1000 / 30 in-flight).
- `deploy/k8s/phase6-kind/vendor/metrics-server-v0.9.1-components.yaml` —
  vendored upstream manifest (byte-for-byte below the provenance header).
- `kind-pilot.mjs` extended with `render-elastic` (offline) and `elastic`
  (live drill, 9 PASS steps, unconditional restore to the static boundary).

**Status: offline verification complete; the live elastic drill is 未跑.**
Per the standing operator instruction (2026-11-12: "除非必要，否则不用实跑，
只需要推到 github 上，让部署机拉下去跑"), no cluster was created and no
metrics-server was installed on this machine. The drill runs on the deployment
machine from this checkout, after the P2 `all` action.

## What was verified offline (this machine)

| Gate | Result |
| --- | --- |
| `node --test deploy/k8s/phase6-kind/kind-overlay.test.mjs` | 33/33 pass (18 P2 + 15 P3, incl. a `parseDocuments` regression test) |
| `node deploy/k8s/phase6-kind/kind-pilot.mjs render` | 26/26 pass — P2 static boundary unchanged |
| `node deploy/k8s/phase6-kind/kind-pilot.mjs render-elastic` | 26/26 pass — elastic composition contracts |
| `kubectl kustomize deploy/k8s/phase6-production` | 0 HPAs, both Deployments `replicas: 2` — the component is truly opt-in |
| Mutation M1: component reference commented out of the drill root | file test FAIL (sibling-root contract, comment-stripped) **and** render-elastic exit 1 (`hpa_*_present`) |
| Mutation M2: production stabilization 300s → 30s in `hpa.yaml` | file test FAIL (production-value contract); render-elastic stays green **by design** — the drill patch masks it, so the file gate is the only defense for the production value, and it held |
| Mutation M3: `replicas: null` → `replicas: 2` in the worker patch | file test FAIL **and** render-elastic exit 1 (`platform-worker_replicas_absent`) |
| All mutations restored | 33/33, render 26/26, render-elastic 26/26; files byte-identical to pre-mutation (diff-verified) |
| `node n8n/scripts/validate-workflows.mjs` | 26 workflows, 0 warnings |
| `node --check kind-pilot.mjs` | pass (also asserted inside the suite) |

Render facts confirmed against the real elastic root (16 documents): two HPAs
with `minReplicas: 2`, worker `maxReplicas: 6` / gateway `maxReplicas: 4`,
`cpu`/`Utilization`/`averageUtilization: 70`, drill `stabilizationWindowSeconds: 30`,
`scaleTargetRef` → the matching Deployment; **no `replicas:` field in either
Deployment**; gateway env `SANDBOX_RATE_RPM: "6000"`, `SANDBOX_RATE_BURST: "1000"`,
`SANDBOX_MAX_INFLIGHT: "30"` with `SANDBOX_ALLOWED_CALLERS` untouched; P2
boundary intact (no Job, redis-drill Deployment+Service, drill REDIS_URL, no
`192.168.65` ipBlock, both PDBs `minAvailable: 1`, gateway probes).

CI: the existing `kind-overlay-contract-tests` job runs the same test file —
33 tests now, no workflow change needed.

## Environment survey (read-only, no changes)

- kubectl v1.36.1 (kustomize v5.8.1) used for all renders; no cluster context
  was entered (kustomize is offline).
- `registry.k8s.io/metrics-server/metrics-server:v0.9.1` is **not cached** on
  this machine. The deployment machine must be able to pull it, or pre-pull +
  `docker save`/load it; the `elastic` action automatically `kind load`s it
  when present locally.
- Pre-existing kind cluster `agent-platform-pilot` was **not touched**; no
  `agent-platform-kind` cluster exists on this machine (P2 drill also 未跑).
- The vendored manifest's upstream sha256 is recorded in its header
  (`3c7f57cd…4c2a1`); v0.9.1 ships Kubernetes v0.36.5 dependencies, matching
  the pinned `kindest/node:v1.36.1`.

## Design decisions

1. **Component, not a base change.** `phase6-production` keeps rendering
   static-two-replica; elasticity is consumed via `components:` from a root.
   Verified: the base render contains 0 HPAs. This keeps the P2 PR (#13) and
   the production-candidate claim untouched by P3.
2. **Sibling drill root (`phase6-kind-elastic`), not a child directory.**
   Discovered empirically: kustomize's loader rejects a child kustomization
   referencing its own parent — `cycle detected: candidate root
   '…/phase6-kind' contains visited root '…/phase6-kind/elastic'`. The first
   layout attempt failed exactly this way. The sibling placement is encoded
   as a file-level test so nobody "tidies" it back into a cycle.
3. **`replicas: null` strategic-merge deletion.** The HPA must own the replica
   count; a leftover `spec.replicas` fights the HPA on every apply. Restore
   order matters: delete both HPAs FIRST, then re-apply the static root
   (which restores `replicas: 2`). The drill does this in a `finally` block,
   so a failed drill still returns the cluster to the static P2 boundary.
4. **Vendored metrics-server, no run-time download.** Upstream bytes +
   provenance header (source URL, sha256). The only kind-specific change,
   `--kubelet-insecure-tls`, is added at install time by an idempotent JSON
   patch (re-runs must not duplicate the arg); it is deliberately NOT baked
   into the vendored file, and a test asserts its absence there.
5. **Drill-only patches, production values protected.** Stabilization 300s is
   the production window; only the drill root shortens it to 30s so scale-in
   is observable in minutes. Admission is raised only in the drill root
   (6000/1000/30) because P1 already verified enforcement AT the defaults
   (`monitoring/sandbox-admission-2026-11-12.md`); the elastic drill tests the
   scaling mechanism, not the limiter. The behavior patch uses a `target:`
   selector so one patch hits both HPAs; the env patch merges by `name`.
6. **Load sized to move CPU without flooding etcd.** Gateway CPU requests are
   25m, so the 70% target is 17.5m; the gateway polls Job status every 250ms,
   and 16 closed-loop workers keep ~16 requests in flight → tens of API
   calls/s per replica, comfortably above threshold. Jobs run
   `time.sleep(2)` + small compute: real sandbox execution, but bounded churn
   (~250 Jobs over 60s; TTL is 300s and the gateway does not delete Jobs
   early). Distinct `elastic-load-<i>` caller identities keep per-caller
   buckets out of the way. The key is read from `.env` and never printed.
7. **Idle worker as negative control.** The drill stream is empty, so the
   worker blocks on Redis reads at near-zero CPU and must stay at 2
   throughout (`worker_stayed_at_min`). If it scaled, the HPA would be
   reacting to noise — that is a FAIL, not a bonus.
8. **Transient replicas dip is expected, not a failure.** Removing
   `spec.replicas` via apply can default the Deployment to 1 until the first
   HPA sync (~15s) restores min 2. The drill waits for a stable 2/2 with
   `ScalingActive=True` and a resolved CPU metric before starting the load;
   the PDB keeps ≥1 available during the dip.
9. **A ruler bug found and fixed (not a fixture workaround).** The P2
   `parseDocuments` name regex (`^metadata:\s*[\s\S]*?^\s+name:`) backtracks
   past `metadata.name` when metadata has no labels block before name, and
   captured `name: cpu` from an HPA's spec instead. Real renders survived
   only because their labels block accidentally blocked the wrong path; P2
   fixtures survived only because they had no second bare `name:` line.
   Fixed with a metadata-block-scoped line scan, added a dedicated regression
   test (both shapes), and re-verified BOTH render gates after the change.
10. **Budget rationale.** Gateway `maxReplicas: 4`: admission state is per
    replica, so cluster in-flight capacity = replicas × `SANDBOX_MAX_INFLIGHT`,
    and kind worker nodes must also host the sandbox Job pods. Worker
    `maxReplicas: 6` is a placeholder budget for the target cluster, not a
    measured capacity.

## Live drill — 未跑, operator commands

On the deployment machine, from the repo root (Docker engine, kind, kubectl,
Node 22, `.env` with `CHAT_API_KEY`; metrics-server image pullable or
pre-cached):

```bash
node deploy/k8s/phase6-kind/kind-pilot.mjs all            # P2 boundary first (15 PASS)
node deploy/k8s/phase6-kind/kind-pilot.mjs render-elastic # offline, before applying
node deploy/k8s/phase6-kind/kind-pilot.mjs elastic        # P3 drill (9 PASS)
node deploy/k8s/phase6-kind/kind-pilot.mjs delete         # remove the whole cluster
```

Expected: 9 PASS lines and `{"ok": true, ...}` — metrics-server ready (1),
both HPAs active with resolved CPU metrics and stable 2/2 (2), load generator
`ok > 0` (1), gateway peak > 2 and ≤ 4 (1), worker stayed at 2 (1), scale-in
to 2/2 within 240s (1), static boundary restored (1), NodePort healthz (1).
The restore runs even when a drill step fails; `restore_error` is a FAIL.
Full step list and boundaries: `deploy/k8s/phase6-kind/README.md`.

## Boundaries and unverified items (未跑)

- **No cluster was created, no metrics-server installed, no load ran.**
  Everything about live behavior (HPA sync timing, actual CPU utilization
  under the synthetic load, scale-in latency, metrics-server scrape health on
  kind) is design expectation, not measured fact, until the deployment
  machine runs it.
- **CPU is a placeholder metric for I/O-bound services.** The worker blocks
  on Redis reads and the gateway waits on Job pods; CPU utilization
  understates real load. The drill proves the scaling MECHANISM (HPA reads
  metrics, scales out under load, scales in after), not the metric's
  production fitness. Request-rate/queue-depth metrics via prometheus-adapter
  are the documented follow-up.
- **Synthetic load, not business throughput.** 16 concurrent `/run` Jobs with
  raised admission budgets; no kb_save path, no real caller traffic.
- **Worker max 6 is unvalidated capacity**; gateway max 4 is bounded by the
  per-replica admission design and kind node capacity.
- **kindnet does not enforce NetworkPolicy** (unchanged from P2); single
  host; results are "local multi-node cluster verification (non-production)".
  The production-topology decision is unchanged.
- Known drill timing risks (tunable in the script): metrics API wait 120s,
  HPA activation wait 180s each, load 60s, scale-in wait 240s, restore
  rollouts 180s each. If the deployment machine cannot reach
  `registry.k8s.io`, pre-pull the metrics-server image; the script loads it
  into kind automatically when cached.