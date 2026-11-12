# Phase 6.5C production-candidate K8s boundary

This overlay is a production-candidate manifest, not a command to apply to the
current Docker Desktop Pilot. It keeps the existing Pilot resources as the
base and adds only the stateless boundary changes:

- Worker and Sandbox Gateway run with two replicas.
- Both use RollingUpdate with `maxUnavailable: 0` and a one-pod surge.
- Soft pod anti-affinity prefers spreading replicas across nodes.
- Both deployments have a `minAvailable: 1` PodDisruptionBudget.
- Sandbox Gateway has startup, readiness and liveness probes on `/healthz`.
- Gateway request admission (rate bucket, in-flight cap, optional caller
  allowlist) is configured on the base Deployment; its state is in-memory,
  so with two replicas the budgets are **per replica**, not shared. A shared
  budget needs an external store and is not part of this overlay.
- The existing Sandbox Job timeout, resource limits, TTL cleanup and deny-all
  NetworkPolicy remain in force.

Render and inspect without changing a cluster:

```powershell
kubectl kustomize deploy/k8s/phase6-production
kubectl apply --dry-run=client --validate=false -k deploy/k8s/phase6-production
```

Do not apply this overlay to `docker-desktop` as a production claim. Before a
real apply, replace the Pilot-specific Worker ConfigMap endpoints (`host.docker.internal`,
`192.168.65.254`, published Redis/Runtime ports) with internal Service names or
managed-service endpoints for the target cluster. Create real secrets through
the cluster secret manager; never commit them to this directory.

Multi-node verification of this boundary (two-replica rolling update, PDB
drain behavior, anti-affinity spread) lives in `../phase6-kind`: a disposable
1 control-plane + 2 worker kind cluster with an isolated Redis fixture and an
operator-run drill script. It is a local verification environment, not a
production deployment, and it does not change the stateful ownership decision.

The stateful boundary remains outside this overlay. Postgres, Redis, n8n and
object storage need an explicit managed-service or StatefulSet/backup decision
before production approval.

The current ownership decision is recorded in
`monitoring/production-topology-decision-2026-10-30.md`. The standing local
Kubernetes contexts are single-node Pilots, and the `phase6-kind` drill
cluster (when created) is a disposable verification fixture; do not treat any
of them as the production deployment authority.
