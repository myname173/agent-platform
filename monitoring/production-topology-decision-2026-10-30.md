# Production Topology Decision（2026-10-30）

## Confirmed inventory

The current machine exposes two Kubernetes contexts, and both are local
single-node clusters:

| Context | Nodes | Classification |
| --- | ---: | --- |
| `docker-desktop` | 1 control-plane node | active Pilot context |
| `kind-agent-platform-pilot` | 1 control-plane node | inactive local Pilot context |

Neither context is a production HA cluster. No managed Kubernetes context or
multi-node production authority is configured in this workspace.

## Current ownership

| Component | Current owner | Persistence | Production status |
| --- | --- | --- | --- |
| n8n | Docker Compose | `n8n_data` | Pilot only |
| Postgres/pgvector | Docker Compose | `postgres_data_pg17` | Pilot only |
| Redis Streams | Docker Compose | `platform_redis_data` with AOF | Pilot only |
| RustFS object storage | Docker Compose | `minio_data` | Pilot only |
| Platform Runtime | Docker Compose | stateless, backed by Compose Redis/Postgres | Pilot only |
| Async Worker | Kubernetes Pilot | stateless Deployment | Pilot only |
| Sandbox Gateway/Jobs | Kubernetes Pilot | short-lived Jobs, no durable state | Pilot only |

The K8s Worker currently reaches Compose services through Docker Desktop host
gateway endpoints. This is a deliberate Pilot bridge and is not a production
service boundary.

## Backup ownership

The in-stack backup service currently produces five core artifacts:

- Postgres dumps for `n8n` and `lobechat`;
- `n8n_data` archive;
- `minio_data` archive;
- configuration bundle.

It also produces and validates a required Redis RDB snapshot. The existing
heartbeat keeps its five-core-artifact fields for compatibility and adds
`redis=ok`; a failed Redis snapshot prevents `.last-ok` from being updated and
reports a failed heartbeat. All artifacts still live on the same machine.

## Decision

For the current machine, the only confirmed ownership is **local Pilot
ownership**:

- Compose remains authoritative for n8n, Postgres, Redis, Runtime and RustFS.
- Docker Desktop Kubernetes remains an optional Worker/Sandbox execution edge.
- The Phase 6 production overlay is renderable but must not be applied as a
  production deployment.
- Kafka, Outbox and external ingress remain outside the production decision.

Production approval is still blocked by two concrete external decisions, not by
more application code:

1. Select a real multi-node/managed Kubernetes cluster, or explicitly accept a
   single-node controlled deployment as a non-HA service.
2. Select managed Postgres and Redis, or own their StatefulSet/PV/backup/
   restore operations. The local Compose route now has a Redis snapshot and
   restore check, but it remains a single-machine recovery boundary.

## 当前落地结果与下一边界

Do not apply `deploy/k8s/phase6-production` yet. The single-node route has now
completed its first low-risk boundary:

- `backup` image includes `redis-cli` and produces a required Redis RDB
  snapshot alongside the five existing core artifacts;
- `n8n/scripts/restore-drill.sh` validates the newest Redis RDB without touching
  the live Redis volume;
- one backup and one full restore drill passed on 2026-10-30.

The next step is operational rather than a new business path: keep this mode
running as `PLATFORM_DEPLOYMENT_MODE=single-node-controlled`, record the
startup/rollback procedure, and only revisit K8s production deployment after a
real multi-node or managed cluster is available.

This decision closes the cluster and stateful-service ownership confirmation for
Phase 6.5C without making a false HA claim.
