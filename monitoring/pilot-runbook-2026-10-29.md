# K8s Pilot Runbook

Date: 2026-10-29

This runbook closes Phase 5.1 for the local Docker Desktop Pilot. It documents
the current operating boundary; it does not turn the Pilot into a production
deployment.

## Operating model

| Area | Current authority | Boundary |
| --- | --- | --- |
| n8n and Chat Gateway | Docker Compose | `127.0.0.1:5678` |
| Redis | Docker Compose | internal Compose network; Pilot bridge `127.0.0.1:16379` |
| Platform Runtime | Docker Compose | health/metrics at `127.0.0.1:13220` |
| Async `kb_save` Worker | K8s `platform-worker` | namespace `agent-platform`, one replica |
| Sandbox execution | K8s `platform-sandbox-gateway` + short-lived Jobs | supervised loopback bridge `127.0.0.1:18080` |
| Business metrics | Console stats API | Prometheus is for internal runtime metrics only |

The expected Kubernetes context is `docker-desktop`. The Compose stack remains
the source of truth for stateful services and the Chat Gateway.

## Start or restore the Pilot

Run from the repository root in PowerShell.

1. Start the Compose stack:

   ```powershell
   docker compose up -d
   ```

2. Apply the Pilot resources. Use `-BuildImages` after changing either sandbox
   image; omit it when the local images are already current:

   ```powershell
   .\deploy\k8s\phase3-pilot\pilot.ps1 -Action apply -BuildImages
   ```

3. Install the loopback bridge. It runs as a current-user scheduled task and
   reconnects after Docker/Kubernetes restarts:

   ```powershell
   .\deploy\k8s\phase3-pilot\sandbox-bridge.ps1 -Action install
   ```

4. In another terminal, run the complete boundary check:

   ```powershell
   .\deploy\k8s\phase3-pilot\pilot.ps1 -Action check
   ```

`check` verifies Worker/Gateway rollout, Compose health endpoints, Redis
availability and a zero pending count on `platform:jobs`.

## Routine verification

Use the smallest check that answers the current question:

```powershell
# Pilot and queue boundary
.\deploy\k8s\phase3-pilot\pilot.ps1 -Action check

# Read-only business path; no model calls or business writes
node --env-file=.env n8n/scripts/e2e-business-load.mjs

# Async kb_save path when PLATFORM_KB_ASYNC_ENABLED=true
node --env-file=.env n8n/scripts/test-kb-async.mjs

# Full quality/security gate when Agent or sandbox code changes
node --env-file=.env n8n/scripts/agent-eval.mjs
```

For Console-facing business health, use the existing Console stats view. For
internal runtime health, inspect `platform-runtime:3220/metrics`; do not create
a second business dashboard for the Pilot.

## First response to a failure

1. Run `pilot.ps1 -Action check` and identify whether the failure is Compose,
   Worker, Gateway or Redis pending.
2. For a K8s failure, inspect the relevant pod without deleting it:

   ```powershell
   kubectl -n agent-platform get pods -o wide
   kubectl -n agent-platform logs deployment/platform-worker --tail=100
   kubectl -n agent-platform logs deployment/platform-sandbox-gateway --tail=100
   ```

3. If only the bridge is down, run `sandbox-bridge.ps1 -Action install` again.
   It is intentionally loopback-only; no LAN exposure is expected.
4. If pending jobs are non-zero, keep the stream intact and inspect Worker
   logs/recovery state before restarting the Worker. Do not delete pending
   messages as a first response.
5. Sandbox Jobs are expected to be short-lived. After a test run, inspect the
   list and remove only completed/failed Jobs; leave active business Jobs
   untouched:

   ```powershell
   $jobs = kubectl -n agent-platform get jobs -l app.kubernetes.io/name=platform-sandbox -o json | ConvertFrom-Json
   $jobs.items | Where-Object { $_.status.succeeded -or $_.status.failed } | ForEach-Object {
     kubectl -n agent-platform delete job $_.metadata.name
   }
   ```

## Controlled rollback to Compose

Use this only when the K8s Pilot boundary itself is the suspected cause. This
keeps the namespace and persistent data intact.

1. Remove the scheduled bridge with
   `sandbox-bridge.ps1 -Action uninstall`.
2. In `.env`, set:

   ```text
   PLATFORM_KB_ASYNC_ENABLED=false
   SANDBOX_URL=http://n8n-sandbox:8000
   ```

3. Stop Pilot consumers before serving synchronous traffic:

   ```powershell
   kubectl -n agent-platform scale deployment/platform-worker --replicas=0
   kubectl -n agent-platform scale deployment/platform-sandbox-gateway --replicas=0
   ```

4. Recreate n8n with the Compose values and refresh the Chat Gateway workflow:

   ```powershell
   docker compose up -d n8n
   node --env-file=.env n8n/scripts/deploy.mjs chat-gateway
   ```

5. Confirm the synchronous boundary and Compose sandbox path with the normal
   Console smoke check. Do not run the async test while the flag is disabled.

Re-enable the Pilot by restoring the `.env` values, applying the manifests,
and running the start sequence above. No database or Redis stream deletion is
part of this rollback.

## Known Pilot limits

- Worker and Gateway are single-replica Deployments.
- The Gateway is reachable through a supervised local bridge, not Ingress/TLS.
- Docker Desktop host-gateway wiring is specific to this local context.
- Compose remains authoritative for n8n, Redis and Runtime.
- There is no HPA, multi-node failover or production deployment authority.

These are explicit release boundaries, not missing runtime fallbacks. The
Phase 5.0 gate result is recorded in
`monitoring/release-gate-2026-10-29.md`.
