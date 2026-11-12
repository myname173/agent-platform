// Offline contracts for the phase6-kind verification overlay (P2).
// No Docker/kind/kubectl required: file-level assertions plus unit tests of
// the render checker that kind-pilot.mjs uses operator-side. The live render
// check (`kind-pilot.mjs render`) and the cluster drill are operator-run;
// green here is NOT live acceptance.
//
// Run: node --test deploy/k8s/phase6-kind/kind-overlay.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseDocuments, overlayContracts, readDotEnv, CONTEXT, CLUSTER_NAME } from './kind-pilot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');
// Negative assertions must measure manifest content, not prose: drop
// full-line YAML comments before checking for forbidden literals.
const readManifest = (name) => read(name).replace(/^\s*#.*$/gm, '');
const pilot = read('kind-pilot.mjs');

// ---------------------------------------------------------------------------
// Script hygiene
// ---------------------------------------------------------------------------

test('kind-pilot.mjs passes node --check', () => {
  const r = spawnSync(process.execPath, ['--check', join(here, 'kind-pilot.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('pilot pins the drill context and never switches the operator context', () => {
  assert.equal(CONTEXT, `kind-${CLUSTER_NAME}`);
  assert.equal(CLUSTER_NAME, 'agent-platform-kind');
  assert.ok(pilot.includes("['--context', CONTEXT, ...args]"), 'kubectl wrapper must pin --context');
  assert.ok(!pilot.includes('use-context'), 'must never run kubectl config use-context');
  assert.ok(!pilot.includes('docker-desktop'), 'must never reference the pilot context');
});

test('pilot only reads .env, never writes it, and imports no writer', () => {
  assert.ok(!pilot.includes('writeFileSync'), 'no file writes at all in the pilot script');
  assert.ok(/import \{ readFileSync, existsSync \} from 'node:fs'/.test(pilot));
});

test('readDotEnv prefers env and returns empty for unknown keys without throwing', () => {
  process.env.KIND_PILOT_TEST_KEY = 'synthetic-value';
  assert.equal(readDotEnv('KIND_PILOT_TEST_KEY'), 'synthetic-value');
  delete process.env.KIND_PILOT_TEST_KEY;
  assert.equal(readDotEnv('KIND_PILOT_NONEXISTENT_KEY_12345'), '');
});

// ---------------------------------------------------------------------------
// parseDocuments
// ---------------------------------------------------------------------------

test('parseDocuments splits multi-doc YAML and extracts kind/name', () => {
  const docs = parseDocuments('kind: ConfigMap\nmetadata:\n  name: a\ndata: {}\n---\nkind: Service\nmetadata:\n  name: b\n');
  assert.deepEqual(docs.map((d) => [d.kind, d.name]), [['ConfigMap', 'a'], ['Service', 'b']]);
  assert.deepEqual(parseDocuments(''), []);
});

// ---------------------------------------------------------------------------
// overlayContracts: synthetic render fixture (checker unit tests)
// ---------------------------------------------------------------------------

const deployment = (name, image, extra = '') => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
      containers:
        - name: c
          image: ${image}
${extra}`;

const pdb = (name) => `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${name}
spec:
  minAvailable: 1`;

const FIXTURE = [
  deployment('platform-worker', 'agent-platform/platform-runtime:0.1'),
  deployment('platform-sandbox-gateway', 'agent-platform/sandbox-gateway:0.3',
    '          startupProbe: {}\n          readinessProbe: {}\n          livenessProbe: {}'),
  pdb('platform-worker'),
  pdb('platform-sandbox-gateway'),
  `apiVersion: v1
kind: ConfigMap
metadata:
  name: platform-worker-config
data:
  REDIS_URL: redis://redis-drill:6379
  N8N_URL: http://n8n.drill.invalid:5678
  PLATFORM_RUNTIME_URL: http://runtime.drill.invalid:13220
  JOB_STREAM: platform:jobs
  JOB_GROUP: platform-kb-workers`,
  `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: platform-worker
spec:
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: redis-drill
      ports:
        - protocol: TCP
          port: 6379`,
  deployment('redis-drill', 'redis:7.4-alpine'),
  `apiVersion: v1
kind: Service
metadata:
  name: redis-drill
spec:
  ports:
    - port: 6379`,
].join('\n---\n');

const KIND_FIXTURE = `kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    image: kindest/node:v1.36.1
  - role: worker
    image: kindest/node:v1.36.1
    extraPortMappings:
      - containerPort: 30080
        hostPort: 18081
        listenAddress: 127.0.0.1
        protocol: TCP
  - role: worker
    image: kindest/node:v1.36.1
`;

const failedNames = (rendered, kindConfig = KIND_FIXTURE) =>
  overlayContracts(rendered, kindConfig).filter((c) => !c.ok).map((c) => c.name);

test('overlayContracts passes a conforming render', () => {
  assert.deepEqual(failedNames(FIXTURE), []);
});

test('overlayContracts rejects a re-added reference Job', () => {
  const mutated = `${FIXTURE}\n---\napiVersion: batch/v1\nkind: Job\nmetadata:\n  name: platform-sandbox\n`;
  assert.ok(failedNames(mutated).includes('no_reference_job'));
});

test('overlayContracts rejects replica/strategy/affinity regressions', () => {
  assert.ok(failedNames(FIXTURE.replace('replicas: 2', 'replicas: 1')).includes('platform-worker_two_replicas'));
  assert.ok(failedNames(FIXTURE.replace('maxUnavailable: 0', 'maxUnavailable: 1')).includes('platform-worker_rolling_zero_unavailable'));
  assert.ok(failedNames(FIXTURE.replace('podAntiAffinity', 'podAffinity')).includes('platform-worker_anti_affinity'));
});

test('overlayContracts rejects missing PDBs', () => {
  const mutated = FIXTURE.replace(pdb('platform-sandbox-gateway'), 'kind: ConfigMap\nmetadata:\n  name: unrelated');
  assert.ok(failedNames(mutated).includes('pdb_platform-sandbox-gateway'));
});

test('overlayContracts rejects live-stack endpoints sneaking back in', () => {
  assert.ok(failedNames(FIXTURE.replace('redis://redis-drill:6379', 'redis://host.docker.internal:16379')).includes('worker_config_drill_redis'));
  assert.ok(failedNames(FIXTURE.replace('n8n.drill.invalid', 'host.docker.internal')).includes('worker_config_inert_upstreams'));
  assert.ok(failedNames(FIXTURE.replace('JOB_STREAM: platform:jobs', 'JOB_STREAM: other')).includes('worker_config_stream_preserved'));
  assert.ok(failedNames(FIXTURE.replace('app.kubernetes.io/name: redis-drill\n      ports:\n        - protocol: TCP\n          port: 6379', 'ipBlock:\n            cidr: 192.168.65.254/32')).includes('worker_netpol_no_host_ipblock'));
});

test('overlayContracts rejects kind topology regressions', () => {
  assert.ok(failedNames(FIXTURE, KIND_FIXTURE.replace('  - role: worker\n    image: kindest/node:v1.36.1\n', '')).includes('kind_two_workers'));
  assert.ok(failedNames(FIXTURE, KIND_FIXTURE.replaceAll('image: kindest/node:v1.36.1', 'image: kindest/node:latest')).includes('kind_pinned_node_image'));
  assert.ok(failedNames(FIXTURE, KIND_FIXTURE.replace('hostPort: 18081', 'hostPort: 18080')).includes('kind_nodeport_mapping'));
});

// ---------------------------------------------------------------------------
// File-level contracts on the committed overlay (catch deletions/typos in CI)
// ---------------------------------------------------------------------------

test('kind-config.yaml: 1 control-plane + 2 workers, pinned image, loopback NodePort', () => {
  const cfg = read('kind-config.yaml');
  assert.equal((cfg.match(/- role: control-plane/g) || []).length, 1);
  assert.equal((cfg.match(/- role: worker/g) || []).length, 2);
  assert.equal((cfg.match(/image: kindest\/node:v1\.36\.1/g) || []).length, 3);
  assert.ok(/containerPort: 30080/.test(cfg) && /hostPort: 18081/.test(cfg) && /listenAddress: 127\.0\.0\.1/.test(cfg));
});

test('kustomization builds on phase6-production and references existing patch files', () => {
  const k = read('kustomization.yaml');
  assert.ok(k.includes('- ../phase6-production'));
  assert.ok(k.includes('- redis-drill.yaml'));
  for (const p of ['worker-configmap-patch.yaml', 'worker-networkpolicy-patch.yaml', 'delete-sandbox-job-patch.yaml']) {
    assert.ok(k.includes(`- path: ${p}`), `missing patch reference ${p}`);
    assert.ok(existsSync(join(here, p)), `patch file missing: ${p}`);
  }
});

test('delete patch removes exactly the reference Job', () => {
  const p = read('delete-sandbox-job-patch.yaml');
  assert.ok(/\$patch: delete/.test(p));
  assert.ok(/kind: Job/.test(p) && /name: platform-sandbox/.test(p));
});

test('worker config patch points at the drill fixture and inert upstreams', () => {
  const p = readManifest('worker-configmap-patch.yaml');
  assert.ok(p.includes('REDIS_URL: redis://redis-drill:6379'));
  assert.ok(p.includes('n8n.drill.invalid') && p.includes('runtime.drill.invalid'));
  assert.ok(!p.includes('host.docker.internal'));
});

test('worker netpol patch drops the Docker Desktop ipBlock and keeps DNS', () => {
  const p = readManifest('worker-networkpolicy-patch.yaml');
  assert.ok(!p.includes('192.168.65'));
  assert.ok(/app\.kubernetes\.io\/name: redis-drill/.test(p) && /port: 6379/.test(p));
  assert.ok(/port: 53/.test(p), 'DNS egress must be preserved');
});

test('redis-drill is a disposable fixture: no persistence, no PVC, non-root', () => {
  const r = readManifest('redis-drill.yaml');
  assert.ok(r.includes('image: redis:7.4-alpine'));
  assert.ok(/--save/.test(r) && /--appendonly/.test(r) && /"no"/.test(r));
  assert.ok(!/persistentVolumeClaim/i.test(r));
  assert.ok(/runAsNonRoot: true/.test(r));
  assert.ok(/kind: Service/.test(r) && /name: redis-drill/.test(r));
});

test('phase6 base stays production-candidate: 2 replicas, zero-unavailable rolling, PDBs, probes', () => {
  const base = join(here, '..', 'phase6-production');
  const worker = readFileSync(join(base, 'worker-production-patch.yaml'), 'utf8');
  const gateway = readFileSync(join(base, 'gateway-production-patch.yaml'), 'utf8');
  const pdbs = readFileSync(join(base, 'poddisruptionbudgets.yaml'), 'utf8');
  assert.ok(/replicas: 2/.test(worker) && /maxUnavailable: 0/.test(worker) && /maxSurge: 1/.test(worker));
  assert.ok(/replicas: 2/.test(gateway) && /startupProbe/.test(gateway) && /readinessProbe/.test(gateway) && /livenessProbe/.test(gateway));
  assert.equal((pdbs.match(/minAvailable: 1/g) || []).length, 2);
});