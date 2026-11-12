#!/usr/bin/env node

// P2: local multi-node verification of the phase6-production boundary on kind.
// Operator-run on the deployment machine; NOT part of CI (needs Docker + kind
// + kubectl). Offline contracts live in kind-overlay.test.mjs.
//
// Usage (repo root):
//   node deploy/k8s/phase6-kind/kind-pilot.mjs preflight   # read-only checks
//   node deploy/k8s/phase6-kind/kind-pilot.mjs render      # offline render + contracts
//   node deploy/k8s/phase6-kind/kind-pilot.mjs all         # preflight->create->images->apply->drill->check
//   node deploy/k8s/phase6-kind/kind-pilot.mjs delete      # remove the drill cluster
//
// Individual actions: create | images | apply | drill | check.
// `images --skip-build` reuses already-built local images.
//
// P3 elasticity (run AFTER `all` or `apply`, on the same drill cluster):
//   node deploy/k8s/phase6-kind/kind-pilot.mjs render-elastic  # offline render + contracts
//   node deploy/k8s/phase6-kind/kind-pilot.mjs elastic         # live HPA drill, restores static boundary
//
// Safety:
// - Every kubectl call pins --context kind-agent-platform-kind; the script
//   never touches the Docker Desktop pilot or whatever the current context is.
// - CHAT_API_KEY is read from env or the repo .env and never printed. The
//   .env file is only read, never written.
// - The drill cluster is disposable: `delete` removes the whole kind cluster.
// - redis-drill is an isolated fixture; the drill never joins the live
//   Compose Redis consumer group.
//
// Boundaries (see README.md): kindnet does not enforce NetworkPolicy; the
// worker kb_save business path is not exercised (n8n/runtime stay in Compose);
// admission state is per replica, so the e2e check runs against each gateway
// pod individually. This is local multi-node verification, not production.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

export const CLUSTER_NAME = 'agent-platform-kind';
export const CONTEXT = `kind-${CLUSTER_NAME}`;
export const NS = 'agent-platform';
export const NODE_IMAGE = 'kindest/node:v1.36.1';
export const NODEPORT_URL = 'http://127.0.0.1:18081';
export const IMAGES = [
  'agent-platform/platform-runtime:0.1',
  'agent-platform/sandbox-gateway:0.3',
  'agent-platform/sandbox:3.14-k8s-pilot',
  'redis:7.4-alpine',
];

// P3: vendored metrics-server (provenance + sha256 in the file header) and
// the sibling elastic root. The root is a SIBLING of phase6-kind because
// kustomize rejects a child kustomization referencing its own parent.
export const METRICS_SERVER_VERSION = 'v0.9.1';
export const METRICS_SERVER_IMAGE = `registry.k8s.io/metrics-server/metrics-server:${METRICS_SERVER_VERSION}`;
export const METRICS_SERVER_MANIFEST = join(here, 'vendor', `metrics-server-${METRICS_SERVER_VERSION}-components.yaml`);
export const ELASTIC_ROOT = resolve(here, '..', 'phase6-kind-elastic');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tool resolution: PATH first, then the Docker Desktop bin dir on Windows.
// ---------------------------------------------------------------------------

const dockerBinDir = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin')
  : null;

const toolPath = (name) => {
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8', shell: false });
  if (!probe.error) return name;
  if (dockerBinDir) {
    const exe = join(dockerBinDir, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(exe)) return exe;
  }
  throw new Error(`${name} not found on PATH${dockerBinDir ? ` or in ${dockerBinDir}` : ''}; install it first`);
};

const run = (file, args, { allowFailure = false, input, cwd, suppressError = false } = {}) => {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd: cwd || repoRoot,
    input,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw new Error(`${file} failed to start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = suppressError ? '(output suppressed: may contain secrets)' : (result.stderr || result.stdout || '').trim();
    throw new Error(`${file} ${args[0]} exited ${result.status}: ${detail}`);
  }
  return result;
};

let tools = null;
const useTools = () => {
  if (!tools) tools = { docker: toolPath('docker'), kind: toolPath('kind'), kubectl: toolPath('kubectl') };
  return tools;
};
const kubectl = (args, opts) => run(useTools().kubectl, ['--context', CONTEXT, ...args], opts);
const kind = (args, opts) => run(useTools().kind, args, opts);
const docker = (args, opts) => run(useTools().docker, args, opts);

export const readDotEnv = (name) => {
  if (process.env[name]) return process.env[name];
  const envFile = join(repoRoot, '.env');
  if (!existsSync(envFile)) return '';
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  if (!line) return '';
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
};

// ---------------------------------------------------------------------------
// Offline render contracts (pure; also imported by kind-overlay.test.mjs).
// ---------------------------------------------------------------------------

// metadata.name must be read from the metadata block ONLY. A whole-document
// regex backtracks past `metadata:\n  name: x` (the greedy \s* eats the
// indentation, so ^ no longer matches at the name line) and can capture a
// spec field instead — e.g. an HPA's `metrics.resource.name: cpu` — whenever
// metadata has no labels block before name.
const metadataName = (text) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (start < 0) return '';
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // next top-level key ends the block
    const m = lines[i].match(/^\s+name:\s*(\S+)/);
    if (m) return m[1];
  }
  return '';
};

export const parseDocuments = (yamlText) => String(yamlText)
  .split(/^---\s*$/m)
  .map((text) => text.trim())
  .filter(Boolean)
  .map((text) => ({
    kind: (text.match(/^kind:\s*(\S+)/m) || [])[1] || '',
    name: metadataName(text),
    text,
  }));

const doc = (docs, kindName, name) => docs.find((d) => d.kind === kindName && d.name === name);

export const overlayContracts = (renderedText, kindConfigText) => {
  const checks = [];
  const record = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const docs = parseDocuments(renderedText);

  record('no_reference_job', !docs.some((d) => d.kind === 'Job'),
    'the one-shot sandbox-job template must not be part of the applied boundary');

  for (const [name, image] of [
    ['platform-worker', 'agent-platform/platform-runtime:0.1'],
    ['platform-sandbox-gateway', 'agent-platform/sandbox-gateway:0.3'],
  ]) {
    const d = doc(docs, 'Deployment', name);
    record(`${name}_present`, Boolean(d));
    if (!d) continue;
    record(`${name}_two_replicas`, /replicas:\s*2/.test(d.text));
    record(`${name}_rolling_zero_unavailable`, /maxUnavailable:\s*0/.test(d.text) && /maxSurge:\s*1/.test(d.text) && /type:\s*RollingUpdate/.test(d.text));
    record(`${name}_anti_affinity`, /topologyKey:\s*kubernetes\.io\/hostname/.test(d.text) && /podAntiAffinity/.test(d.text));
    record(`${name}_image`, d.text.includes(`image: ${image}`));
  }

  for (const name of ['platform-worker', 'platform-sandbox-gateway']) {
    const d = doc(docs, 'PodDisruptionBudget', name);
    record(`pdb_${name}`, Boolean(d) && /minAvailable:\s*1/.test(d.text));
  }

  const cm = doc(docs, 'ConfigMap', 'platform-worker-config');
  record('worker_config_drill_redis', Boolean(cm) && cm.text.includes('REDIS_URL: redis://redis-drill:6379'));
  record('worker_config_inert_upstreams', Boolean(cm) && cm.text.includes('n8n.drill.invalid') && cm.text.includes('runtime.drill.invalid'));
  record('worker_config_stream_preserved', Boolean(cm) && /JOB_STREAM:\s*platform:jobs/.test(cm.text) && /JOB_GROUP:\s*platform-kb-workers/.test(cm.text));

  const np = doc(docs, 'NetworkPolicy', 'platform-worker');
  record('worker_netpol_no_host_ipblock', Boolean(np) && !np.text.includes('192.168.65'));
  record('worker_netpol_drill_redis', Boolean(np) && np.text.includes('redis-drill') && /port:\s*6379/.test(np.text));

  record('redis_drill_deployment', Boolean(doc(docs, 'Deployment', 'redis-drill')));
  record('redis_drill_service', Boolean(doc(docs, 'Service', 'redis-drill')));
  const gw = doc(docs, 'Deployment', 'platform-sandbox-gateway');
  record('gateway_probes', Boolean(gw) && /startupProbe/.test(gw.text) && /readinessProbe/.test(gw.text) && /livenessProbe/.test(gw.text));

  const nodes = String(kindConfigText).match(/- role:\s*(\S+)/g) || [];
  record('kind_three_nodes', nodes.length === 3, `roles=${nodes.join(',')}`);
  record('kind_one_control_plane', nodes.filter((n) => n.includes('control-plane')).length === 1);
  record('kind_two_workers', nodes.filter((n) => n.includes('worker')).length === 2);
  record('kind_pinned_node_image', (String(kindConfigText).match(/image:\s*kindest\/node:v[\d.]+/g) || []).length === 3);
  record('kind_nodeport_mapping', /containerPort:\s*30080/.test(kindConfigText) && /hostPort:\s*18081/.test(kindConfigText) && /listenAddress:\s*127\.0\.0\.1/.test(kindConfigText));

  return checks;
};

// Contracts for the ELASTIC drill root (phase6-kind-elastic): the P2 boundary
// plus HPA ownership. Drill-only values are asserted here (stabilization 30,
// raised admission env); the production component keeps 300s and the pilot
// admission defaults — see components/elastic/hpa.yaml.
export const elasticContracts = (renderedText) => {
  const checks = [];
  const record = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const docs = parseDocuments(renderedText);

  record('no_reference_job', !docs.some((d) => d.kind === 'Job'));

  for (const [name, max] of [['platform-worker', 6], ['platform-sandbox-gateway', 4]]) {
    const h = doc(docs, 'HorizontalPodAutoscaler', name);
    record(`hpa_${name}_present`, Boolean(h));
    if (!h) continue;
    record(`hpa_${name}_min_2`, /minReplicas:\s*2\b/.test(h.text));
    record(`hpa_${name}_max_${max}`, new RegExp(`maxReplicas:\\s*${max}\\b`).test(h.text));
    record(`hpa_${name}_cpu_utilization_70`, /name:\s*cpu\b/.test(h.text) && /type:\s*Utilization/.test(h.text) && /averageUtilization:\s*70\b/.test(h.text));
    record(`hpa_${name}_drill_stabilization_30`, /stabilizationWindowSeconds:\s*30\b/.test(h.text));
    const ref = h.text.split('scaleTargetRef:')[1] || '';
    record(`hpa_${name}_target_deployment`, /kind:\s*Deployment/.test(ref) && new RegExp(`name:\\s*${name}\\b`).test(ref));

    const d = doc(docs, 'Deployment', name);
    record(`${name}_replicas_absent`, Boolean(d) && !/^\s*replicas:/m.test(d.text),
      'spec.replicas must be deleted so the HPA owns the replica count');
  }

  const gw = doc(docs, 'Deployment', 'platform-sandbox-gateway');
  for (const [key, value] of [['SANDBOX_RATE_RPM', '6000'], ['SANDBOX_RATE_BURST', '1000'], ['SANDBOX_MAX_INFLIGHT', '30']]) {
    record(`gateway_admission_${key.toLowerCase()}_${value}`,
      Boolean(gw) && new RegExp(`name: ${key}\\s+value: "?${value}"?`).test(gw.text));
  }
  record('gateway_allowed_callers_preserved', Boolean(gw) && gw.text.includes('SANDBOX_ALLOWED_CALLERS'));

  // The elastic root must still sit on the P2 drill boundary.
  record('redis_drill_deployment', Boolean(doc(docs, 'Deployment', 'redis-drill')));
  record('redis_drill_service', Boolean(doc(docs, 'Service', 'redis-drill')));
  const cm = doc(docs, 'ConfigMap', 'platform-worker-config');
  record('worker_config_drill_redis', Boolean(cm) && cm.text.includes('REDIS_URL: redis://redis-drill:6379'));
  const np = doc(docs, 'NetworkPolicy', 'platform-worker');
  record('worker_netpol_no_host_ipblock', Boolean(np) && !np.text.includes('192.168.65'));
  for (const name of ['platform-worker', 'platform-sandbox-gateway']) {
    const p = doc(docs, 'PodDisruptionBudget', name);
    record(`pdb_${name}`, Boolean(p) && /minAvailable:\s*1/.test(p.text));
  }
  record('gateway_probes', Boolean(gw) && /startupProbe/.test(gw.text) && /readinessProbe/.test(gw.text) && /livenessProbe/.test(gw.text));

  return checks;
};

// ---------------------------------------------------------------------------
// Cluster helpers
// ---------------------------------------------------------------------------

const getJson = (args) => JSON.parse(kubectl([...args, '-o', 'json']).stdout);

const contextExists = () => {
  const result = run(useTools().kubectl, ['config', 'get-contexts', '-o', 'name'], { allowFailure: true });
  return (result.stdout || '').split(/\r?\n/).includes(CONTEXT);
};

const requireContext = () => {
  if (!contextExists()) throw new Error(`kubectl context ${CONTEXT} not found; run the create action first`);
};

const waitReady = async (label, fn, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const value = fn();
      if (value === true) return;
      last = String(value);
    } catch (e) { last = String(e.message || e); }
    await sleep(1000);
  }
  throw new Error(`${label} not ready within ${timeoutMs / 1000}s (last: ${last})`);
};

const deploymentReady = (name) => {
  const d = getJson(['-n', NS, 'get', 'deployment', name]);
  const ready = d.status?.readyReplicas || 0;
  const desired = d.spec?.replicas || 0;
  return ready === desired && desired > 0 ? true : `${name} ready=${ready}/${desired}`;
};

const podNodes = (label) => {
  const pods = getJson(['-n', NS, 'get', 'pods', '-l', `app.kubernetes.io/name=${label}`]);
  return (pods.items || [])
    .filter((p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp)
    .map((p) => ({ pod: p.metadata.name, node: p.spec.nodeName }));
};

const workerNodes = () => {
  const nodes = getJson(['get', 'nodes']);
  return (nodes.items || [])
    .filter((n) => !('node-role.kubernetes.io/control-plane' in (n.metadata.labels || {})))
    .map((n) => n.metadata.name);
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const actionPreflight = () => {
  const t = useTools();
  console.log(`docker: ${run(t.docker, ['--version']).stdout.trim()}`);
  console.log(`kind:   ${run(t.kind, ['--version']).stdout.trim()}`);
  console.log(`kubectl: ${run(t.kubectl, ['version', '--client']).stdout.trim().split('\n')[0]}`);
  docker(['info', '--format', '{{.ServerVersion}}']);
  console.log('docker engine: reachable');
  const key = readDotEnv('CHAT_API_KEY');
  if (!key) throw new Error('CHAT_API_KEY not found in env or repo .env');
  console.log('CHAT_API_KEY: present (value not printed)');
  const clusters = (kind(['get', 'clusters'], { allowFailure: true }).stdout || '').split(/\r?\n/).filter(Boolean);
  console.log(`kind clusters: ${clusters.join(', ') || '(none)'}`);
  if (clusters.includes(CLUSTER_NAME)) console.log(`note: ${CLUSTER_NAME} already exists; create will fail until you delete it`);
  for (const image of [NODE_IMAGE, ...IMAGES, METRICS_SERVER_IMAGE]) {
    const cached = docker(['image', 'inspect', image], { allowFailure: true }).status === 0;
    console.log(`image ${image}: ${cached ? 'cached' : 'will be pulled/built'}`);
  }
  console.log('preflight ok');
};

const actionRender = () => {
  // Offline: no cluster, context, docker or kind needed — kubectl only.
  const rendered = run(toolPath('kubectl'), ['kustomize', here]).stdout;
  const kindConfig = readFileSync(join(here, 'kind-config.yaml'), 'utf8');
  const checks = overlayContracts(rendered, kindConfig);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, total: checks.length, failed: failed.length }));
  if (failed.length) process.exitCode = 1;
};

const actionRenderElastic = () => {
  // Offline: kubectl only, no cluster needed. Verifies the component
  // composition (HPAs in, replicas out, drill patches applied, P2 boundary
  // intact) before anything is applied to a live cluster.
  const rendered = run(toolPath('kubectl'), ['kustomize', ELASTIC_ROOT]).stdout;
  const checks = elasticContracts(rendered);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, total: checks.length, failed: failed.length }));
  if (failed.length) process.exitCode = 1;
};

const actionCreate = async () => {
  useTools();
  kind(['create', 'cluster', '--name', CLUSTER_NAME, '--config', join(here, 'kind-config.yaml'), '--wait', '120s']);
  requireContext();
  await waitReady('nodes Ready', () => {
    const nodes = getJson(['get', 'nodes']);
    const items = nodes.items || [];
    if (items.length !== 3) return `nodes=${items.length}/3`;
    const ready = items.filter((n) => (n.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True'));
    return ready.length === 3 ? true : `ready=${ready.length}/3`;
  }, 180000);
  console.log('create ok: 3 nodes Ready');
};

const actionImages = ({ skipBuild = false } = {}) => {
  useTools();
  if (!skipBuild) {
    docker(['build', '-t', 'agent-platform/platform-runtime:0.1', '.'], { cwd: join(repoRoot, 'platform-runtime') });
    docker(['build', '-f', 'n8n/sandbox-gateway.Dockerfile', '-t', 'agent-platform/sandbox-gateway:0.3', 'n8n']);
    docker(['build', '-f', 'n8n/sandbox.Dockerfile', '-t', 'agent-platform/sandbox:3.14-k8s-pilot', 'n8n']);
  }
  if (docker(['image', 'inspect', 'redis:7.4-alpine'], { allowFailure: true }).status !== 0) {
    docker(['pull', 'redis:7.4-alpine']);
  }
  kind(['load', 'docker-image', ...IMAGES, '--name', CLUSTER_NAME]);
  console.log(`images ok: ${IMAGES.length} images loaded into ${CLUSTER_NAME}`);
};

const actionApply = async () => {
  requireContext();
  const chatKey = readDotEnv('CHAT_API_KEY');
  if (!chatKey) throw new Error('CHAT_API_KEY not found in env or repo .env');
  const runtimeKey = readDotEnv('PLATFORM_RUNTIME_KEY');
  const secretYaml = kubectl([
    '-n', NS, 'create', 'secret', 'generic', 'platform-runtime-secrets',
    `--from-literal=CHAT_API_KEY=${chatKey}`,
    `--from-literal=PLATFORM_RUNTIME_KEY=${runtimeKey}`,
    '--dry-run=client', '-o', 'yaml',
  ], { suppressError: true }).stdout;
  kubectl(['apply', '-f', '-'], { input: secretYaml, suppressError: true });
  console.log('secret platform-runtime-secrets applied (values not printed)');
  kubectl(['apply', '-k', here]);
  for (const name of ['redis-drill', 'platform-worker', 'platform-sandbox-gateway']) {
    await waitReady(`${name} rollout`, () => deploymentReady(name), 180000);
  }
  console.log('apply ok: redis-drill, platform-worker, platform-sandbox-gateway ready');
};

const rolloutRestartAndSample = async (name) => {
  const t = useTools();
  const child = spawn(t.kubectl, ['--context', CONTEXT, '-n', NS, 'rollout', 'status', `deployment/${name}`, '--timeout=180s'], { encoding: 'utf8' });
  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });
  let minAvailable = Infinity;
  const samples = [];
  while (!exited) {
    const d = getJson(['-n', NS, 'get', 'deployment', name]);
    const available = d.status?.availableReplicas || 0;
    minAvailable = Math.min(minAvailable, available);
    samples.push(available);
    await sleep(300);
  }
  const ok = exitCode === 0 && minAvailable >= 2;
  return { name, ok, minAvailable: minAvailable === Infinity ? null : minAvailable, samples: samples.length, exitCode };
};

const portForward = async (pod, localPort) => {
  const t = useTools();
  const child = spawn(t.kubectl, ['--context', CONTEXT, '-n', NS, 'port-forward', `pod/${pod}`, '--address', '127.0.0.1', `${localPort}:8080`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  let stderr = '';
  child.stdout.on('data', (d) => { if (/Forwarding from/.test(d.toString())) ready = true; });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const deadline = Date.now() + 15000;
  while (!ready && Date.now() < deadline) await sleep(100);
  if (!ready) { child.kill(); throw new Error(`port-forward ${pod} did not start: ${stderr.trim()}`); }
  return child;
};

const actionDrill = async () => {
  requireContext();
  const steps = [];
  const record = (name, ok, detail = '') => {
    steps.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  };

  try {
    // 1) topology: 3 nodes, 2 schedulable workers
    const workers = workerNodes();
    record('two_worker_nodes', workers.length === 2, workers.join(','));
    if (workers.length !== 2) throw new Error('drill aborted: expected 2 worker nodes');

    // 2) anti-affinity spread (soft preference; on an empty cluster the
    //    scheduler should place one replica per worker)
    for (const label of ['platform-worker', 'platform-sandbox-gateway']) {
      const pods = podNodes(label);
      const distinct = new Set(pods.map((p) => p.node));
      record(`${label}_spread`, pods.length === 2 && distinct.size === 2,
        pods.map((p) => `${p.pod}@${p.node}`).join(' '));
    }
    if (!steps.every((s) => s.ok)) throw new Error('drill aborted: distribution not as expected');

    // 3) PDBs present and allowing exactly one disruption
    const pdbs = getJson(['-n', NS, 'get', 'pdb']);
    const pdbOk = (pdbs.items || []).length === 2
      && pdbs.items.every((p) => p.spec.minAvailable === 1 && (p.status?.disruptionsAllowed || 0) === 1);
    record('pdbs_minavailable_1', pdbOk, (pdbs.items || []).map((p) => `${p.metadata.name} allowed=${p.status?.disruptionsAllowed}`).join(' '));

    // 4) rolling restart keeps both replicas available (maxUnavailable: 0)
    for (const name of ['platform-sandbox-gateway', 'platform-worker']) {
      kubectl(['-n', NS, 'rollout', 'restart', `deployment/${name}`]);
      const r = await rolloutRestartAndSample(name);
      record(`${name}_rolling_min_available`, r.ok, `minAvailable=${r.minAvailable} samples=${r.samples} exit=${r.exitCode}`);
    }

    // 5) admission e2e per gateway pod (state is per replica; NodePort would
    //    split counters across pods). Reuses the P1 acceptance script.
    const gatewayPods = podNodes('platform-sandbox-gateway').map((p) => p.pod);
    for (const pod of gatewayPods) {
      const forward = await portForward(pod, 18082);
      let result;
      try {
        result = run(process.execPath, [join(repoRoot, 'deploy', 'k8s', 'phase3-pilot', 'admission-check.mjs'), '--url', 'http://127.0.0.1:18082'], { allowFailure: true });
      } finally { forward.kill(); }
      let summary = '';
      try { summary = JSON.stringify(JSON.parse(result.stdout).probes.map((p) => `${p.name}=${p.ok ? 'ok' : 'FAIL'}`)); } catch { summary = (result.stdout || result.stderr || '').slice(-300); }
      record(`admission_e2e_${pod}`, result.status === 0, summary);
    }

    // 6) PDB drain negative control: first drain succeeds, second must be
    //    blocked because it would take the last ready replica below budget.
    const gwPods = podNodes('platform-sandbox-gateway');
    const nodeA = gwPods[0].node;
    const nodeB = workers.find((n) => n !== nodeA);
    const drainArgs = (node, timeout) => ['drain', node, '--ignore-daemonsets', '--delete-emptydir-data', `--timeout=${timeout}`];
    const first = kubectl(drainArgs(nodeA, '120s'), { allowFailure: true });
    record('drain_first_allowed', first.status === 0, `node=${nodeA} exit=${first.status}`);
    if (first.status !== 0) throw new Error('drill aborted: first drain failed');
    for (const name of ['platform-sandbox-gateway', 'platform-worker']) {
      await waitReady(`${name} after drain`, () => deploymentReady(name), 180000);
    }
    const second = kubectl(drainArgs(nodeB, '30s'), { allowFailure: true });
    const blocked = second.status !== 0 && /disruption budget/i.test(second.stderr || '');
    record('drain_second_blocked_by_pdb', blocked, `node=${nodeB} exit=${second.status} stderr=${(second.stderr || '').trim().slice(-200)}`);
    kubectl(['uncordon', nodeA]);
    kubectl(['uncordon', nodeB]);
    for (const name of ['platform-sandbox-gateway', 'platform-worker']) {
      kubectl(['-n', NS, 'rollout', 'restart', `deployment/${name}`]);
      await waitReady(`${name} rebalance`, () => deploymentReady(name), 180000);
    }
    for (const label of ['platform-worker', 'platform-sandbox-gateway']) {
      const pods = podNodes(label);
      const distinct = new Set(pods.map((p) => p.node));
      record(`${label}_respread_after_recovery`, pods.length === 2 && distinct.size === 2,
        pods.map((p) => `${p.pod}@${p.node}`).join(' '));
    }

    // 7) gateway startup config + NodePort surface after recovery
    const logs = kubectl(['-n', NS, 'logs', '-l', 'app.kubernetes.io/name=platform-sandbox-gateway', '--tail=200']).stdout;
    record('admission_config_logged', logs.includes('admission_config'));
    const health = await fetch(`${NODEPORT_URL}/healthz`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    record('nodeport_healthz', health.ok === true, JSON.stringify(health));
    const metrics = await fetch(`${NODEPORT_URL}/metrics`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text());
    record('nodeport_metrics', metrics.includes('sandbox_gateway_up 1'));
  } catch (e) {
    if (!steps.length || steps[steps.length - 1].ok) record('drill_error', false, String(e.message || e));
  }

  const ok = steps.every((s) => s.ok);
  console.log(JSON.stringify({ ok, cluster: CLUSTER_NAME, steps }, null, 2));
  if (!ok) process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// P3 elastic drill
// ---------------------------------------------------------------------------

const installMetricsServer = async () => {
  // Load the image into kind when cached locally; otherwise nodes pull it.
  if (docker(['image', 'inspect', METRICS_SERVER_IMAGE], { allowFailure: true }).status === 0) {
    kind(['load', 'docker-image', METRICS_SERVER_IMAGE, '--name', CLUSTER_NAME]);
  } else {
    console.log(`note: ${METRICS_SERVER_IMAGE} not cached locally; cluster nodes will pull it`);
  }
  kubectl(['apply', '-f', METRICS_SERVER_MANIFEST]);
  // kind kubelets serve self-signed certs; the upstream manifest does not set
  // --kubelet-insecure-tls, so add it idempotently (re-runs must not duplicate).
  const ms = getJson(['-n', 'kube-system', 'get', 'deployment', 'metrics-server']);
  const args = ms.spec?.template?.spec?.containers?.[0]?.args || [];
  if (!args.includes('--kubelet-insecure-tls')) {
    kubectl(['-n', 'kube-system', 'patch', 'deployment', 'metrics-server', '--type=json',
      '-p', '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]']);
  }
  kubectl(['-n', 'kube-system', 'rollout', 'status', 'deployment/metrics-server', '--timeout=180s']);
  await waitReady('metrics API', () => {
    const r = kubectl(['top', 'nodes', '--no-headers'], { allowFailure: true });
    if (r.status !== 0) return `top nodes exit=${r.status}`;
    const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
    if (lines.length !== 3) return `top nodes rows=${lines.length}/3`;
    if (lines.some((l) => l.includes('<unknown>'))) return 'metrics still <unknown>';
    return true;
  }, 120000);
};

// Closed-loop load: `concurrency` workers each keep one /run request in
// flight until the deadline. Real sandbox Jobs (2s sleep + small compute)
// keep the gateway's 250ms Job-status polling busy without flooding etcd
// with pod churn. Distinct caller identities keep per-caller buckets out of
// the way; the elastic root already raised the admission budgets so the
// limiter is not the bottleneck under test.
const elasticLoad = async (key, durationMs, concurrency, onSample) => {
  const stats = { issued: 0, ok: 0, rejected: 0, errors: 0 };
  const deadline = Date.now() + durationMs;
  let loading = true;
  const worker = async (i) => {
    while (Date.now() < deadline) {
      stats.issued += 1;
      try {
        const res = await fetch(`${NODEPORT_URL}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sandbox-key': key, 'x-sandbox-caller': `elastic-load-${i}` },
          body: JSON.stringify({ code: 'import time; time.sleep(2); print(sum(range(100000)))', timeout: 8, allow_network: false }),
          signal: AbortSignal.timeout(30000),
        });
        if (res.status === 200) stats.ok += 1; else stats.rejected += 1;
        await res.text();
      } catch { stats.errors += 1; }
    }
  };
  const sampler = (async () => {
    while (loading) {
      try { onSample(); } catch { /* transient API errors must not kill sampling */ }
      await sleep(2000);
    }
  })();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  loading = false;
  await sampler;
  try { onSample(); } catch { /* final sample is best-effort */ }
  return stats;
};

const actionElastic = async () => {
  requireContext();
  const key = readDotEnv('CHAT_API_KEY');
  if (!key) throw new Error('CHAT_API_KEY not found in env or repo .env');
  const steps = [];
  const record = (name, ok, detail = '') => {
    steps.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  };

  const replicaSnapshot = () => {
    const out = {};
    for (const name of ['platform-worker', 'platform-sandbox-gateway']) {
      const d = getJson(['-n', NS, 'get', 'deployment', name]);
      const h = getJson(['-n', NS, 'get', 'hpa', name]);
      out[name] = {
        desired: d.spec?.replicas ?? 0,
        ready: d.status?.readyReplicas || 0,
        cpu: h.status?.currentMetrics?.[0]?.resource?.current?.averageUtilization ?? null,
      };
    }
    return out;
  };

  try {
    // 0) the static P2 boundary must already be applied and healthy
    for (const name of ['redis-drill', 'platform-worker', 'platform-sandbox-gateway']) {
      await waitReady(`${name} before elastic`, () => deploymentReady(name), 60000);
    }

    // 1) metrics-server from the vendored manifest (kind needs insecure TLS)
    await installMetricsServer();
    record('metrics_server_ready', true, `${METRICS_SERVER_VERSION}; kubectl top nodes returns data`);

    // 2) apply the elastic root; HPAs take over replica ownership
    kubectl(['apply', '-k', ELASTIC_ROOT]);
    for (const name of ['platform-worker', 'platform-sandbox-gateway']) {
      await waitReady(`hpa ${name} active`, () => {
        const h = getJson(['-n', NS, 'get', 'hpa', name]);
        const active = (h.status?.conditions || []).some((c) => c.type === 'ScalingActive' && c.status === 'True');
        if (!active) return 'ScalingActive!=True';
        const util = h.status?.currentMetrics?.[0]?.resource?.current?.averageUtilization;
        if (typeof util !== 'number') return 'currentMetrics unresolved';
        const d = getJson(['-n', NS, 'get', 'deployment', name]);
        // Deleting spec.replicas can transiently default the Deployment to 1
        // until the first HPA sync; wait for a stable min=2 (PDB keeps >=1).
        if (d.spec?.replicas !== 2 || (d.status?.readyReplicas || 0) !== 2) {
          return `replicas=${d.spec?.replicas} ready=${d.status?.readyReplicas || 0}`;
        }
        return true;
      }, 180000);
      const h = getJson(['-n', NS, 'get', 'hpa', name]);
      record(`hpa_${name}_active`, true, `cpu=${h.status?.currentMetrics?.[0]?.resource?.current?.averageUtilization}% replicas=2/2`);
    }

    // 3) closed-loop load through the NodePort while sampling replicas+CPU
    const samples = [];
    const stats = await elasticLoad(key, 60000, 16, () => samples.push(replicaSnapshot()));
    const gwSeries = samples.map((s) => s['platform-sandbox-gateway'].desired);
    const wkSeries = samples.map((s) => s['platform-worker'].desired);
    const gwPeak = gwSeries.length ? Math.max(...gwSeries) : 0;
    const gwCpuPeak = Math.max(0, ...samples.map((s) => s['platform-sandbox-gateway'].cpu ?? 0));
    record('load_generator', stats.ok > 0, JSON.stringify(stats));
    record('gateway_scaled_out', gwPeak > 2 && gwPeak <= 4, `peak=${gwPeak} cpuPeak=${gwCpuPeak}% series=${gwSeries.join(',')}`);
    // Negative control: the idle worker (blocking Redis reads, no jobs in the
    // drill stream) must NOT scale — proves the HPA reacts to load, not noise.
    record('worker_stayed_at_min', wkSeries.length > 0 && wkSeries.every((r) => r === 2), `series=${wkSeries.join(',')}`);

    // 4) scale-in after the load stops (drill stabilization 30s + HPA sync)
    await waitReady('gateway scale-in', () => {
      const d = getJson(['-n', NS, 'get', 'deployment', 'platform-sandbox-gateway']);
      return d.spec?.replicas === 2 && (d.status?.readyReplicas || 0) === 2
        ? true : `replicas=${d.spec?.replicas} ready=${d.status?.readyReplicas || 0}`;
    }, 240000);
    record('gateway_scaled_in', true, 'back to 2/2 after load stopped');
  } catch (e) {
    if (!steps.length || steps[steps.length - 1].ok) record('drill_error', false, String(e.message || e));
  } finally {
    // Restore the static boundary regardless of drill outcome: delete the
    // HPAs FIRST, then re-apply the static root (restores spec.replicas: 2).
    // Re-applying while HPAs are alive would fight them over replicas.
    try {
      kubectl(['-n', NS, 'delete', 'hpa', 'platform-worker', 'platform-sandbox-gateway', '--ignore-not-found'], { allowFailure: true });
      kubectl(['apply', '-k', here]);
      for (const name of ['platform-worker', 'platform-sandbox-gateway']) {
        await waitReady(`${name} static restore`, () => {
          const d = getJson(['-n', NS, 'get', 'deployment', name]);
          return d.spec?.replicas === 2 && (d.status?.readyReplicas || 0) === 2
            ? true : `replicas=${d.spec?.replicas} ready=${d.status?.readyReplicas || 0}`;
        }, 180000);
      }
      record('static_boundary_restored', true, 'HPAs deleted, static root re-applied, 2/2 replicas');
      const health = await fetch(`${NODEPORT_URL}/healthz`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
      record('nodeport_healthz_after_restore', health.ok === true, JSON.stringify(health));
    } catch (e) {
      record('restore_error', false, String(e.message || e));
    }
  }

  const ok = steps.every((s) => s.ok);
  console.log(JSON.stringify({ ok, cluster: CLUSTER_NAME, steps }, null, 2));
  if (!ok) process.exitCode = 1;
};

const actionCheck = async () => {
  requireContext();
  for (const name of ['redis-drill', 'platform-worker', 'platform-sandbox-gateway']) {
    kubectl(['-n', NS, 'rollout', 'status', `deployment/${name}`, '--timeout=60s']);
  }
  const spread = {};
  for (const label of ['platform-worker', 'platform-sandbox-gateway']) {
    const pods = podNodes(label);
    spread[label] = pods.map((p) => `${p.pod}@${p.node}`);
  }
  const health = await fetch(`${NODEPORT_URL}/healthz`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  if (health.ok !== true) throw new Error(`NodePort healthz failed: ${JSON.stringify(health)}`);
  kubectl(['-n', NS, 'get', 'deployment,pod,pdb', '-l', 'app.kubernetes.io/part-of=agent-platform', '-o', 'wide']);
  console.log(JSON.stringify({ ok: true, spread, nodeport: NODEPORT_URL, health }, null, 2));
};

const actionDelete = () => {
  useTools();
  kind(['delete', 'cluster', '--name', CLUSTER_NAME]);
  console.log(`delete ok: kind cluster ${CLUSTER_NAME} removed`);
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const main = async () => {
  const args = process.argv.slice(2);
  const action = args.find((a) => !a.startsWith('--')) || 'preflight';
  const skipBuild = args.includes('--skip-build');
  switch (action) {
    case 'preflight': actionPreflight(); break;
    case 'render': actionRender(); break;
    case 'render-elastic': actionRenderElastic(); break;
    case 'create': await actionCreate(); break;
    case 'images': actionImages({ skipBuild }); break;
    case 'apply': await actionApply(); break;
    case 'drill': await actionDrill(); break;
    case 'elastic': await actionElastic(); break;
    case 'check': await actionCheck(); break;
    case 'delete': actionDelete(); break;
    case 'all':
      actionPreflight();
      await actionCreate();
      actionImages({ skipBuild });
      await actionApply();
      await actionDrill();
      if (process.exitCode) throw new Error('drill failed; skipping final check');
      await actionCheck();
      break;
    default:
      console.error(`unknown action: ${action}\nactions: preflight render render-elastic create images apply drill elastic check delete all`);
      process.exit(2);
  }
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}