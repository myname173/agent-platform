// Offline contracts for the phase6-kind verification overlay (P2) and the
// phase6-kind-elastic HPA drill root (P3).
// No Docker/kind/kubectl required: file-level assertions plus unit tests of
// the render checkers that kind-pilot.mjs uses operator-side. The live render
// checks (`kind-pilot.mjs render` / `render-elastic`) and the cluster drills
// are operator-run; green here is NOT live acceptance.
//
// Run: node --test deploy/k8s/phase6-kind/kind-overlay.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseDocuments, overlayContracts, elasticContracts, readDotEnv,
  CONTEXT, CLUSTER_NAME, METRICS_SERVER_VERSION, METRICS_SERVER_IMAGE,
  METRICS_SERVER_MANIFEST, ELASTIC_ROOT,
} from './kind-pilot.mjs';

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

test('parseDocuments reads metadata.name even when spec contains bare name: lines', () => {
  // Regression: a whole-document regex captured `name: cpu` from spec when
  // metadata had no labels block before name (HPA-shaped documents).
  const doc = 'apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: platform-worker\nspec:\n  metrics:\n    - resource:\n        name: cpu\n  scaleTargetRef:\n    name: platform-worker';
  assert.equal(parseDocuments(doc)[0].name, 'platform-worker');
  // Labels-before-name (the rendered shape) must keep working too.
  const withLabels = 'kind: HorizontalPodAutoscaler\nmetadata:\n  labels:\n    app.kubernetes.io/name: x\n  name: real-name\nspec:\n  metrics:\n    - resource:\n        name: cpu';
  assert.equal(parseDocuments(withLabels)[0].name, 'real-name');
});

// ---------------------------------------------------------------------------
// overlayContracts: synthetic render fixture (checker unit tests)
// ---------------------------------------------------------------------------

const deployment = (name, image, extra = '', replicasLine = '  replicas: 2\n') => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
${replicasLine}  strategy:
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

const WORKER_CONFIG_DOC = `apiVersion: v1
kind: ConfigMap
metadata:
  name: platform-worker-config
data:
  REDIS_URL: redis://redis-drill:6379
  N8N_URL: http://n8n.drill.invalid:5678
  PLATFORM_RUNTIME_URL: http://runtime.drill.invalid:13220
  JOB_STREAM: platform:jobs
  JOB_GROUP: platform-kb-workers`;

const WORKER_NETPOL_DOC = `apiVersion: networking.k8s.io/v1
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
          port: 6379`;

const REDIS_SERVICE_DOC = `apiVersion: v1
kind: Service
metadata:
  name: redis-drill
spec:
  ports:
    - port: 6379`;

const FIXTURE = [
  deployment('platform-worker', 'agent-platform/platform-runtime:0.1'),
  deployment('platform-sandbox-gateway', 'agent-platform/sandbox-gateway:0.3',
    '          startupProbe: {}\n          readinessProbe: {}\n          livenessProbe: {}'),
  pdb('platform-worker'),
  pdb('platform-sandbox-gateway'),
  WORKER_CONFIG_DOC,
  WORKER_NETPOL_DOC,
  deployment('redis-drill', 'redis:7.4-alpine'),
  REDIS_SERVICE_DOC,
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
// elasticContracts: synthetic elastic render fixture (P3 checker unit tests)
// ---------------------------------------------------------------------------

const hpa = (name, max, stab = 30) => `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}
spec:
  behavior:
    scaleDown:
      stabilizationWindowSeconds: ${stab}
  maxReplicas: ${max}
  metrics:
    - resource:
        name: cpu
        target:
          averageUtilization: 70
          type: Utilization
      type: Resource
  minReplicas: 2
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}`;

const GATEWAY_DRILL_ENV = `          env:
            - name: SANDBOX_RATE_RPM
              value: "6000"
            - name: SANDBOX_RATE_BURST
              value: "1000"
            - name: SANDBOX_MAX_INFLIGHT
              value: "30"
            - name: SANDBOX_ALLOWED_CALLERS
              value: ""`;

// Elastic render shape: deployments WITHOUT spec.replicas (HPA owns it),
// two HPAs with drill stabilization, raised admission env, P2 boundary kept.
const ELASTIC_FIXTURE = [
  deployment('platform-worker', 'agent-platform/platform-runtime:0.1', '', ''),
  deployment('platform-sandbox-gateway', 'agent-platform/sandbox-gateway:0.3',
    '          startupProbe: {}\n          readinessProbe: {}\n          livenessProbe: {}\n' + GATEWAY_DRILL_ENV, ''),
  hpa('platform-worker', 6),
  hpa('platform-sandbox-gateway', 4),
  pdb('platform-worker'),
  pdb('platform-sandbox-gateway'),
  WORKER_CONFIG_DOC,
  WORKER_NETPOL_DOC,
  deployment('redis-drill', 'redis:7.4-alpine'),
  REDIS_SERVICE_DOC,
].join('\n---\n');

const elasticFailed = (rendered) => elasticContracts(rendered).filter((c) => !c.ok).map((c) => c.name);

test('elasticContracts passes a conforming elastic render', () => {
  const checks = elasticContracts(ELASTIC_FIXTURE);
  assert.equal(checks.length, 26);
  assert.deepEqual(checks.filter((c) => !c.ok), []);
});

test('elasticContracts rejects a missing HPA', () => {
  const mutated = ELASTIC_FIXTURE.replace(hpa('platform-worker', 6), 'kind: ConfigMap\nmetadata:\n  name: unrelated');
  const failed = elasticFailed(mutated);
  assert.ok(failed.includes('hpa_platform-worker_present'));
  // Dependent HPA checks are skipped when the HPA is absent (present is the gate).
  assert.ok(!failed.includes('hpa_platform-sandbox-gateway_present'), 'the other HPA must stay green');
});

test('elasticContracts rejects a re-added spec.replicas (HPA ownership conflict)', () => {
  const mutated = ELASTIC_FIXTURE.replace('kind: Deployment\nmetadata:\n  name: platform-worker\nspec:\n  strategy:',
    'kind: Deployment\nmetadata:\n  name: platform-worker\nspec:\n  replicas: 2\n  strategy:');
  assert.ok(elasticFailed(mutated).includes('platform-worker_replicas_absent'));
});

test('elasticContracts rejects production stabilization leaking into the drill', () => {
  const mutated = ELASTIC_FIXTURE.replaceAll('stabilizationWindowSeconds: 30', 'stabilizationWindowSeconds: 300');
  const failed = elasticFailed(mutated);
  assert.ok(failed.includes('hpa_platform-worker_drill_stabilization_30'));
  assert.ok(failed.includes('hpa_platform-sandbox-gateway_drill_stabilization_30'));
});

test('elasticContracts rejects budget/target regressions', () => {
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace('maxReplicas: 4', 'maxReplicas: 8')).includes('hpa_platform-sandbox-gateway_max_4'));
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace('minReplicas: 2', 'minReplicas: 1')).includes('hpa_platform-worker_min_2'));
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace('averageUtilization: 70', 'averageUtilization: 80')).includes('hpa_platform-worker_cpu_utilization_70'));
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace('kind: Deployment\n    name: platform-worker', 'kind: StatefulSet\n    name: platform-worker')).includes('hpa_platform-worker_target_deployment'));
});

test('elasticContracts rejects admission env regressions', () => {
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace('value: "6000"', 'value: "30"')).includes('gateway_admission_sandbox_rate_rpm_6000'));
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace('value: "30"', 'value: "4"')).includes('gateway_admission_sandbox_max_inflight_30'));
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace('            - name: SANDBOX_ALLOWED_CALLERS\n              value: ""', '')).includes('gateway_allowed_callers_preserved'));
});

test('elasticContracts still enforces the P2 drill boundary', () => {
  assert.ok(elasticFailed(`${ELASTIC_FIXTURE}\n---\napiVersion: batch/v1\nkind: Job\nmetadata:\n  name: platform-sandbox\n`).includes('no_reference_job'));
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace('redis://redis-drill:6379', 'redis://host.docker.internal:16379')).includes('worker_config_drill_redis'));
  assert.ok(elasticFailed(ELASTIC_FIXTURE.replace(pdb('platform-worker'), 'kind: ConfigMap\nmetadata:\n  name: unrelated')).includes('pdb_platform-worker'));
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

// ---------------------------------------------------------------------------
// P3 file-level contracts: elastic component, drill root, vendored manifest
// ---------------------------------------------------------------------------

const componentDir = join(here, '..', 'phase6-production', 'components', 'elastic');
const readComponent = (name) => readFileSync(join(componentDir, name), 'utf8');

test('elastic component is opt-in: Component kind, base roots do not consume it', () => {
  const k = readComponent('kustomization.yaml').replace(/^\s*#.*$/gm, '');
  assert.ok(/kind: Component/.test(k));
  assert.ok(k.includes('- hpa.yaml'));
  for (const p of ['worker-replicas-null.yaml', 'gateway-replicas-null.yaml']) {
    assert.ok(k.includes(`- path: ${p}`), `missing patch reference ${p}`);
    assert.ok(existsSync(join(componentDir, p)), `patch file missing: ${p}`);
  }
  // Neither the production base nor the static kind root may pull it in.
  const prod = readFileSync(join(here, '..', 'phase6-production', 'kustomization.yaml'), 'utf8').replace(/^\s*#.*$/gm, '');
  const staticKind = readManifest('kustomization.yaml');
  assert.ok(!/components:/.test(prod), 'production base must stay static-two-replica');
  assert.ok(!/components:/.test(staticKind) && !staticKind.includes('elastic'), 'static kind root must stay static');
});

test('hpa.yaml: autoscaling/v2, min 2, worker max 6 / gateway max 4, CPU 70%, production stabilization 300', () => {
  const h = readComponent('hpa.yaml');
  assert.equal((h.match(/kind: HorizontalPodAutoscaler/g) || []).length, 2);
  assert.equal((h.match(/apiVersion: autoscaling\/v2/g) || []).length, 2);
  assert.equal((h.match(/minReplicas: 2/g) || []).length, 2);
  assert.ok(/name: platform-worker[\s\S]*?maxReplicas: 6/.test(h));
  assert.ok(/name: platform-sandbox-gateway[\s\S]*?maxReplicas: 4/.test(h));
  assert.equal((h.match(/averageUtilization: 70/g) || []).length, 2);
  assert.equal((h.match(/type: Utilization/g) || []).length, 2);
  assert.equal((h.match(/stabilizationWindowSeconds: 300/g) || []).length, 2, 'production window is 300s; only the drill root shortens it');
  assert.equal((h.match(/app\.kubernetes\.io\/part-of: agent-platform/g) || []).length, 2);
});

test('replicas-null patches delete spec.replicas from exactly the two deployments', () => {
  for (const [file, name] of [['worker-replicas-null.yaml', 'platform-worker'], ['gateway-replicas-null.yaml', 'platform-sandbox-gateway']]) {
    const p = readComponent(file);
    assert.ok(/kind: Deployment/.test(p) && p.includes(`name: ${name}`));
    assert.ok(/replicas: null/.test(p), 'strategic-merge null deletes the field');
  }
});

test('elastic drill root is a SIBLING of phase6-kind (kustomize parent-reference cycle)', () => {
  assert.equal(dirname(ELASTIC_ROOT), dirname(here), 'a child root referencing its parent is rejected by the kustomize loader');
  // Strip comments: a commented-out reference still contains the substring.
  const k = readFileSync(join(ELASTIC_ROOT, 'kustomization.yaml'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.ok(k.includes('- ../phase6-kind'));
  assert.ok(k.includes('- ../phase6-production/components/elastic'));
  for (const p of ['hpa-drill-behavior-patch.yaml', 'gateway-admission-drill-patch.yaml']) {
    assert.ok(k.includes(`- path: ${p}`), `missing patch reference ${p}`);
    assert.ok(existsSync(join(ELASTIC_ROOT, p)), `patch file missing: ${p}`);
  }
  assert.ok(/kind: HorizontalPodAutoscaler/.test(k), 'behavior patch must target both HPAs via selector');
});

test('drill patches: stabilization 30 and raised admission budgets, env merge shape', () => {
  const b = readFileSync(join(ELASTIC_ROOT, 'hpa-drill-behavior-patch.yaml'), 'utf8');
  assert.ok(/stabilizationWindowSeconds: 30\b/.test(b));
  const a = readFileSync(join(ELASTIC_ROOT, 'gateway-admission-drill-patch.yaml'), 'utf8');
  assert.ok(/name: platform-sandbox-gateway/.test(a) && /- name: gateway/.test(a));
  for (const [key, value] of [['SANDBOX_RATE_RPM', '6000'], ['SANDBOX_RATE_BURST', '1000'], ['SANDBOX_MAX_INFLIGHT', '30']]) {
    assert.ok(new RegExp(`- name: ${key}\\s+value: "${value}"`).test(a), `${key}=${value}`);
  }
  assert.ok(!a.includes('SANDBOX_ALLOWED_CALLERS'), 'allowlist must not be touched by the drill patch');
});

test('vendored metrics-server manifest: provenance header, pinned image, no baked-in insecure flag', () => {
  assert.equal(METRICS_SERVER_VERSION, 'v0.9.1');
  assert.equal(METRICS_SERVER_IMAGE, 'registry.k8s.io/metrics-server/metrics-server:v0.9.1');
  assert.ok(existsSync(METRICS_SERVER_MANIFEST));
  const m = readFileSync(METRICS_SERVER_MANIFEST, 'utf8');
  assert.ok(/# Source: https:\/\/github\.com\/kubernetes-sigs\/metrics-server\/releases\/download\/v0\.9\.1\/components\.yaml/.test(m), 'provenance URL');
  assert.ok(/# sha256 \(upstream bytes\): [0-9a-f]{64}/.test(m), 'upstream sha256 recorded at vendoring time');
  assert.ok(m.includes(`image: ${METRICS_SERVER_IMAGE}`));
  assert.ok(/kind: Deployment/.test(m) && /name: metrics-server/.test(m) && /namespace: kube-system/.test(m));
  assert.ok(/--kubelet-preferred-address-types/.test(m), 'upstream preferred-address-types must already be present');
  // Negative assertion measures manifest content, not the provenance prose
  // (the header itself mentions the flag it explains).
  assert.ok(!m.replace(/^\s*#.*$/gm, '').includes('--kubelet-insecure-tls'), 'kind-only flag is added at install time, not vendored');
});

test('pilot wires the elastic actions and restores HPAs-before-static in the right order', () => {
  assert.ok(pilot.includes("case 'render-elastic': actionRenderElastic();"));
  assert.ok(pilot.includes("case 'elastic': await actionElastic();"));
  const elastic = pilot.slice(pilot.indexOf('const actionElastic'));
  const deleteAt = elastic.indexOf("['-n', NS, 'delete', 'hpa'");
  const reapplyAt = elastic.indexOf("kubectl(['apply', '-k', here])");
  assert.ok(deleteAt > 0 && reapplyAt > deleteAt, 'HPAs must be deleted BEFORE the static root is re-applied');
  assert.ok(elastic.includes('finally {'), 'restore must run even when the drill fails');
  assert.ok(elastic.includes("'--ignore-not-found'"), 'restore must be safe when the elastic root was never applied');
  assert.ok(pilot.includes('worker_stayed_at_min'), 'idle-worker negative control must stay in the drill');
});