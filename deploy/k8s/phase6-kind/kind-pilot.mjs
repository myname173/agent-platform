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

export const parseDocuments = (yamlText) => String(yamlText)
  .split(/^---\s*$/m)
  .map((text) => text.trim())
  .filter(Boolean)
  .map((text) => ({
    kind: (text.match(/^kind:\s*(\S+)/m) || [])[1] || '',
    name: (text.match(/^metadata:\s*[\s\S]*?^\s+name:\s*(\S+)/m) || [])[1] || '',
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
  for (const image of [NODE_IMAGE, ...IMAGES]) {
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
    case 'create': await actionCreate(); break;
    case 'images': actionImages({ skipBuild }); break;
    case 'apply': await actionApply(); break;
    case 'drill': await actionDrill(); break;
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
      console.error(`unknown action: ${action}\nactions: preflight render create images apply drill check delete all`);
      process.exit(2);
  }
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}