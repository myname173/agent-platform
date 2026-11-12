# Phase 6 kind multi-node verification (P2) + elastic drill (P3)

Local multi-node verification of the `phase6-production` boundary on a
disposable [kind](https://kind.sigs.k8s.io/) cluster: 1 control-plane +
2 workers. This answers the question the single-node Docker Desktop pilot
cannot: do the two-replica RollingUpdate, PodDisruptionBudgets and soft
anti-affinity actually behave as declared when pods can land on different
nodes? The P3 elastic drill additionally verifies HPA scale-out/scale-in on
the same cluster.

**This is not a production deployment.** kind runs inside Docker on one host;
the production-topology decision
(`monitoring/production-topology-decision-2026-10-30.md`) is unchanged, and
stateful ownership (Postgres, Redis, n8n, object storage) stays in Compose.
Results may only be described as "local multi-node cluster verification
(non-production)".

## What is applied

`kustomization.yaml` builds on `../phase6-production` unchanged and adds only
the verification fixture:

| File | Effect |
| --- | --- |
| `redis-drill.yaml` | Disposable Redis (no PVC, no AOF/RDB, no backup) so the real worker image starts and stays Ready. Deleted with the cluster. |
| `worker-configmap-patch.yaml` | `REDIS_URL` → `redis://redis-drill:6379`; n8n/runtime URLs → reserved `.invalid` names (the kb_save business path is not exercised). `JOB_STREAM`/`JOB_GROUP`/tuning unchanged. |
| `worker-networkpolicy-patch.yaml` | Replaces the Docker-Desktop host-gateway ipBlock with the drill fixture; DNS egress preserved. |
| `delete-sandbox-job-patch.yaml` | Drops the one-shot `sandbox-job.yaml` reference template from the render; the gateway creates its own Jobs during the drill. |

Why an isolated Redis instead of the Compose one: the drill must not join the
live `platform:jobs` consumer group, and `host.docker.internal` reachability
differs between Docker Desktop and Linux kind hosts. The fixture keeps the
drill self-contained on any machine with Docker + kind + kubectl.

## Prerequisites

- Docker engine running; `kind` (tested with v0.33.0) and `kubectl` (v1.36
  line) on PATH — on Windows the Docker Desktop bin dir is used as fallback.
- Repo `.env` with `CHAT_API_KEY` (read-only; the value is never printed).
- Node 22+ (repo standard).
- Node image `kindest/node:v1.36.1` (pinned in `kind-config.yaml`; pulled on
  first use — `docker pull kindest/node:v1.36.1` ahead of time makes cluster
  creation offline-friendly).
- App images are built by the `images` action from this checkout:
  `platform-runtime:0.1`, `sandbox-gateway:0.3`, `sandbox:3.14-k8s-pilot`,
  plus `redis:7.4-alpine`. All are loaded into every kind node.

## Run it (deployment machine)

```bash
# everything: preflight -> create -> images -> apply -> drill -> check
node deploy/k8s/phase6-kind/kind-pilot.mjs all

# reuse already-built images
node deploy/k8s/phase6-kind/kind-pilot.mjs all --skip-build

# inspect afterwards, then remove the whole drill cluster
node deploy/k8s/phase6-kind/kind-pilot.mjs check
node deploy/k8s/phase6-kind/kind-pilot.mjs delete
```

Individual actions: `preflight` (read-only), `render` (offline, no cluster
needed), `create`, `images`, `apply`, `drill`, `check`, `delete`.
P3 adds `render-elastic` (offline) and `elastic` (live HPA drill, see below).

Safety properties:

- Every kubectl call pins `--context kind-agent-platform-kind`. The script
  never touches the `docker-desktop` pilot. Note that `kind create` itself
  sets the current kubectl context to the new cluster; after `delete`, switch
  back with `kubectl config use-context docker-desktop` if desired.
- Host port **18081** (loopback) maps the gateway NodePort 30080, so the kind
  drill and the docker-desktop pilot bridge (18080) can coexist.
- `delete` removes only the named kind cluster `agent-platform-kind`.

## What the drill asserts (expected output)

`drill` prints one PASS/FAIL line per step and a JSON summary; exit code 0
only if every step passed.

1. `two_worker_nodes` — 3 nodes total, 2 schedulable workers.
2. `platform-worker_spread`, `platform-sandbox-gateway_spread` — both
   replicas of each deployment on two different worker nodes (soft
   anti-affinity on an empty cluster should spread them; co-location is a
   FAIL, but note the preference is not a hard guarantee under pressure).
3. `pdbs_minavailable_1` — both PDBs exist with `disruptionsAllowed: 1`.
4. `*_rolling_min_available` — `rollout restart` of each deployment samples
   `availableReplicas` every 300 ms; the minimum must stay **≥ 2**
   (`maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds: 5`).
5. `admission_e2e_<pod>` — the P1 acceptance script
   (`../phase3-pilot/admission-check.mjs`) runs against **each gateway pod**
   via a temporary pod port-forward (18082). Per-pod on purpose: admission
   state is per replica, and NodePort would split counters across pods.
   Spawns real short-lived Jobs; expect 8/8 probes per pod.
6. PDB drain negative control:
   - `drain_first_allowed` — draining the node hosting one gateway replica
     succeeds (budget allows one disruption); deployments recover to 2/2.
   - `drain_second_blocked_by_pdb` — draining the second worker **must fail**
     with a disruption-budget error: evicting the last ready replica would
     violate `minAvailable: 1`. A successful second drain is a FAIL.
   - both nodes uncordoned, deployments restarted, `*_respread_after_recovery`
     asserts the spread is restored.
7. `admission_config_logged`, `nodeport_healthz`, `nodeport_metrics` — gateway
   startup config visible in logs; `http://127.0.0.1:18081/healthz` and
   `/metrics` answer through the NodePort mapping after recovery.

## Elastic drill (P3): HPA scale-out / scale-in

Run **after** `all` (or at least `apply`) on the same drill cluster:

```bash
node deploy/k8s/phase6-kind/kind-pilot.mjs render-elastic  # offline contracts
node deploy/k8s/phase6-kind/kind-pilot.mjs elastic         # live drill
```

The elastic root is `../phase6-kind-elastic` — a **sibling** of this directory
on purpose: kustomize's loader rejects a child kustomization that references
its own parent ("cycle detected"). It composes this directory's static
boundary + the production elastic component
(`../phase6-production/components/elastic`) + two drill-only patches:

- HPA scale-down stabilization 300s → **30s**, so scale-in is observable in
  minutes;
- gateway admission raised to 6000 rpm / burst 1000 / 30 in-flight, so the
  load generator — not the P1 limiter — is the bottleneck under test.
  Admission at the production defaults was already verified in P1
  (`monitoring/sandbox-admission-2026-11-12.md`).

`elastic` installs metrics-server **v0.9.1 from the vendored manifest**
(`vendor/metrics-server-v0.9.1-components.yaml`, upstream bytes + provenance
header; no download at run time), idempotently adds `--kubelet-insecure-tls`
(kind kubelet certs are self-signed), and waits for `kubectl top nodes` to
return data. If the image is cached locally it is `kind load`ed; otherwise the
nodes pull `registry.k8s.io/metrics-server/metrics-server:v0.9.1` (pre-pull it
on network-restricted machines).

Expected output — 9 PASS lines + JSON summary, exit 0 only if all pass:

1. `metrics_server_ready` — vendored manifest applied, metrics API serving.
2. `hpa_platform-worker_active`, `hpa_platform-sandbox-gateway_active` —
   `ScalingActive=True`, CPU metric resolved, replicas stable at 2/2.
   (Deleting `spec.replicas` can transiently default a Deployment to 1 until
   the first HPA sync; the drill waits this out. PDB keeps ≥1 available.)
3. `load_generator` — 16 closed-loop workers drive real `/run` Jobs
   (`time.sleep(2)` + small compute) through the NodePort for 60s; `ok > 0`.
4. `gateway_scaled_out` — gateway replica peak **> 2 and ≤ 4** during load.
   Gateway CPU requests are 25m, so the 70% target (17.5m) is crossed easily
   by the 250ms Job-status polling under concurrent load.
5. `worker_stayed_at_min` — **negative control**: the idle worker (blocking
   Redis reads, empty drill stream) must stay at 2 throughout. Scaling here
   would mean the HPA reacts to noise, not load.
6. `gateway_scaled_in` — back to 2/2 within 240s after the load stops
   (30s stabilization + HPA sync).
7. `static_boundary_restored` — **runs even when the drill fails**: both HPAs
   are deleted FIRST, then the static root is re-applied (restores
   `spec.replicas: 2`), both deployments wait back to 2/2.
8. `nodeport_healthz_after_restore` — NodePort surface healthy afterwards.

The drill is re-runnable: metrics-server install and the insecure-TLS patch
are idempotent, and the restore always returns the cluster to the static P2
boundary. `delete` still removes the whole cluster (metrics-server included).

## Boundaries (do not overclaim)

- **kindnet does not enforce NetworkPolicy**, exactly like the docker-desktop
  pilot. The policies are applied and correct, but isolation on kind comes
  from the process-level sandbox guard and the admission layer, not from
  network enforcement. A policy-enforcing CNI (e.g. Calico) is a separate
  follow-up.
- **Worker business path not exercised**: n8n and the Platform Runtime stay
  in Compose; the drill enqueues no kb_save jobs. The worker is verified as
  "starts against Redis, stays Ready, survives rolling restart and drain".
- **redis-drill is a fixture**, not a production Redis decision.
- **Admission budgets are per replica**: with 2 gateway replicas the cluster
  admits up to 2× the per-replica rate/concurrency. The phase6-production
  README carries the same note.
- One host, one Docker engine: this verifies scheduling behavior, not host
  failure tolerance.
- **Elastic drill verifies the scaling mechanism, not the production metric**:
  CPU utilization on I/O-bound services understates real load; the drill
  raises admission limits and drives synthetic parallel `/run` traffic to
  make CPU move. Custom/external metrics (prometheus-adapter) remain a
  documented follow-up. The raised admission budgets and the 30s
  stabilization exist ONLY in the elastic drill root — the production
  component keeps 300s and the pilot keeps the P1 defaults.

## Offline verification (no cluster needed)

```bash
node --test deploy/k8s/phase6-kind/kind-overlay.test.mjs   # 33 contracts, CI runs these
node deploy/k8s/phase6-kind/kind-pilot.mjs render           # 26 render contracts, needs kubectl only
node deploy/k8s/phase6-kind/kind-pilot.mjs render-elastic   # 26 elastic render contracts, kubectl only
```

The render gates have been mutation-tested: pointing `REDIS_URL` back at
`host.docker.internal` fails `worker_config_drill_redis`; disabling the
deletion patch fails `no_reference_job` (the file-level text test alone does
not catch a commented-out patch reference — the render layer does). For P3:
commenting out the component reference fails both the sibling-root file test
and `render-elastic`; drifting the production stabilization 300s → 30s is
caught ONLY by the file gate (the drill patch masks it in the render);
re-adding `spec.replicas` fails both layers. See
`monitoring/kind-multinode-2026-11-12.md` (P2) and
`monitoring/kind-elastic-2026-11-12.md` (P3) for the recorded offline evidence
and the live-drill status.