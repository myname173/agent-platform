# Kind multi-node verification (P2) — 2026-11-12

Branch `feat/kind-multinode-20261112`, base `main` at `587cd07` (P1 merged).
Deliverable: `deploy/k8s/phase6-kind/` — a disposable 1 control-plane + 2
worker kind cluster that verifies the `phase6-production` boundary's
multi-node claims (two-replica RollingUpdate with `maxUnavailable: 0`,
`minAvailable: 1` PDBs, soft hostname anti-affinity), plus an isolated Redis
fixture and an operator-run drill script.

**Status: offline verification complete; the live cluster drill is 未跑.**
Per operator instruction (2026-11-12: "除非必要，否则不用实跑，只需要推到
github 上，让部署机拉下去跑"), no cluster was created on this machine. The
drill runs on the deployment machine from this checkout.

## What was verified offline (this machine)

| Gate | Result |
| --- | --- |
| `node --test deploy/k8s/phase6-kind/kind-overlay.test.mjs` | 18/18 pass |
| `node deploy/k8s/phase6-kind/kind-pilot.mjs render` (kubectl kustomize + 26 structural contracts) | 26/26 pass |
| Mutation 1: `REDIS_URL` → `redis://host.docker.internal:16379` | render exit 1, `FAIL worker_config_drill_redis`; file tests exit 1 |
| Mutation 2: deletion patch commented out of kustomization | render exit 1, `FAIL no_reference_job`; file tests alone did NOT catch it (the commented line still contains the path substring) — the render layer is the gate that catches this class |
| Both mutations restored, gates re-run | render 26/26, tests 18/18 |
| `node n8n/scripts/validate-workflows.mjs` | 26 workflows, 0 warnings |
| `node --check kind-pilot.mjs` | pass (also asserted inside the test suite) |

Render facts confirmed against the real overlay: no `Job` document in the
applied boundary; both deployments `replicas: 2`, `RollingUpdate`,
`maxUnavailable: 0`, `maxSurge: 1`, hostname anti-affinity weight 100; both
PDBs `minAvailable: 1`; gateway startup/readiness/liveness probes preserved;
worker ConfigMap `REDIS_URL: redis://redis-drill:6379` with
`JOB_STREAM`/`JOB_GROUP`/`JOB_MAX_ATTEMPTS` unchanged and `.invalid` inert
upstreams; worker NetworkPolicy egress = DNS + redis-drill:6379, no
`192.168.65` ipBlock; images `platform-runtime:0.1`, `sandbox-gateway:0.3`,
`redis:7.4-alpine`.

## Environment survey (read-only, no changes)

- kind v0.33.0, kubectl v1.36.1 (kustomize v5.8.1) present on this machine.
- `kindest/node:v1.36.1` and `v1.37.0` cached locally; the config pins
  **v1.36.1** to match the kubectl client line.
- All four drill images already built/cached locally
  (`platform-runtime:0.1`, `sandbox-gateway:0.3`, `sandbox:3.14-k8s-pilot`,
  `redis:7.4-alpine`).
- Pre-existing kind cluster `agent-platform-pilot` (single node, from the
  2026-10-30 topology survey) was **not touched**. The drill uses a separate
  name `agent-platform-kind` and context `kind-agent-platform-kind`; every
  kubectl call in the script pins that context. The `docker-desktop` pilot
  was not touched.

## Design decisions

1. **Isolated `redis-drill` fixture instead of the Compose Redis.** The worker
   exits at startup if it cannot connect (`await redis.connect()`), so the
   drill needs a reachable Redis. Reusing the live Compose Redis would make
   drill workers join the live `platform:jobs` consumer group and would
   depend on `host.docker.internal` semantics that differ between Docker
   Desktop and Linux kind hosts. The fixture has no PVC, no AOF/RDB, no
   backup; it is deleted with the cluster and does not change stateful
   ownership (Compose remains authoritative).
2. **Inert upstreams.** `N8N_URL`/`PLATFORM_RUNTIME_URL` point at the reserved
   `.invalid` TLD: the kb_save business path is not exercised, and any
   accidental call fails loudly instead of reaching a real service.
3. **Reference Job dropped from the render.** `sandbox-job.yaml` in the base
   is a one-shot template; applying it would run an untracked Job at apply
   time against a fixed-name Secret nothing creates. The gateway creates its
   own uniquely-named Jobs during the drill (proven by the per-pod admission
   e2e step).
4. **Host port 18081** for the NodePort mapping so the kind drill and the
   docker-desktop pilot bridge (18080) can coexist; loopback-only.
5. **Per-pod admission e2e.** Admission state is per replica; behind NodePort
   the P1 acceptance script's counters would split across pods. The drill
   port-forwards to each gateway pod (18082) and runs
   `phase3-pilot/admission-check.mjs` unchanged against each.
6. **Node .mjs orchestrator** (not PowerShell): the deployment machine's OS is
   not assumed; Node 22 is a repo standard, and the pure checker
   (`overlayContracts`) is unit-testable in CI without kubectl.

## Live drill — 未跑, operator commands

On the deployment machine, from the repo root (requires Docker engine, kind,
kubectl, Node 22, and `.env` with `CHAT_API_KEY`):

```bash
node deploy/k8s/phase6-kind/kind-pilot.mjs all      # preflight→create→images→apply→drill→check
node deploy/k8s/phase6-kind/kind-pilot.mjs delete   # remove the drill cluster
```

Expected: 15 PASS lines and `{"ok": true, ...}` from the drill — topology
(1), spread (2), PDB status (1), rolling min-available ≥ 2 (2), per-pod
admission 8/8 (2), drain allowed/blocked + respread (4), startup log +
NodePort healthz/metrics (3). The **second drain must fail** with a
disruption-budget error; that failure is a PASS of
`drain_second_blocked_by_pdb`. Full step list and boundaries:
`deploy/k8s/phase6-kind/README.md`.

## Boundaries and unverified items (未跑)

- **No cluster was created and no drill step ran.** Everything about live
  behavior (drain timing, PDB eviction messages, NodePort reachability
  through a drained node, image load times) is design expectation, not
  measured fact, until the deployment machine runs it.
- **kindnet does not enforce NetworkPolicy** (same as the docker-desktop
  pilot). Policies are applied but declarative; sandbox isolation rests on
  the process-level guard + admission layer. A policy-enforcing CNI is a
  separate follow-up.
- **Worker business path not exercised**: no kb_save jobs are enqueued;
  n8n/runtime stay in Compose. The worker is verified only as "starts,
  stays Ready, survives rolling restart and drain".
- **Admission budgets are per replica**: 2 gateway replicas admit up to
  2× the per-replica rate/concurrency cluster-wide.
- **Anti-affinity is soft**: spread is asserted on an empty cluster, but the
  scheduler may co-locate under pressure; that is not a defect.
- **Single host**: kind verifies scheduling behavior, not host-failure
  tolerance. Results are "local multi-node cluster verification
  (non-production)"; the production-topology decision is unchanged.
- Known drill timing risks (tunable in the script): first drain waits up to
  120 s, second drain expects the PDB block within 30 s, rollouts up to
  180 s. During the second drain the fixture Redis (no PDB) is evicted and
  stays Pending until uncordon; workers tolerate this via client reconnect
  and have no readiness probe, so the recovery assertions are unaffected.