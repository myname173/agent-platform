#!/usr/bin/env node

// K8s sandbox gateway: one short-lived Job per /run request.
//
// P1 added request-level admission between key auth and Job creation:
// caller identity (x-sandbox-caller, accounting only), per-caller token
// bucket, a global in-flight Job cap and an opt-in caller allowlist.
// Rejections are loud: structured JSON log lines plus Prometheus counters
// on GET /metrics. See sandbox_admission.js / sandbox_metrics.js and
// deploy/k8s/phase3-pilot/README.md.
//
// The server is a factory (createGatewayServer) so offline contract tests
// can drive the real HTTP handler with a fake runJob; the Kubernetes client
// and env/SA reads only happen when this file is the process entrypoint.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { parseCaller, admissionConfigFromEnv, createAdmission } = require('./sandbox_admission.js');
const { createMetrics } = require('./sandbox_metrics.js');

const RUN_TIMEOUT_MS = 50000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
};

const logEvent = (fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'sandbox-gateway', ...fields }));

// Reads env + service-account files. Only called from the entrypoint below;
// tests never touch this path.
const loadRuntimeConfig = (env = process.env) => {
  const namespace = env.POD_NAMESPACE || fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
  const sandboxKey = env.SANDBOX_KEY || '';
  const apiHost = env.KUBERNETES_SERVICE_HOST;
  const apiPort = Number(env.KUBERNETES_SERVICE_PORT_HTTPS || env.KUBERNETES_SERVICE_PORT || 443);
  const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
  const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  const image = env.SANDBOX_IMAGE || 'agent-platform/sandbox:3.14-k8s-pilot';
  const port = Number(env.PORT || 8080);
  if (!sandboxKey || !apiHost || !token) throw new Error('sandbox gateway is missing Kubernetes or auth configuration');
  return { namespace, sandboxKey, apiHost, apiPort, token, ca, image, port };
};

const createJobRunner = ({ namespace, apiHost, apiPort, token, ca, image }) => {
  const apiRequest = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = https.request({
      hostname: apiHost,
      port: apiPort,
      path,
      method,
      ca,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: response.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  const apiJson = async (method, path, body) => {
    const response = await apiRequest(method, path, body);
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
      throw new Error(`Kubernetes API ${method} ${path} -> ${response.status}: ${detail.slice(0, 300)}`);
    }
    return response.body;
  };

  const podLogs = async (podName) => {
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/log?container=runner`;
    const response = await apiRequest('GET', path);
    if (response.status < 200 || response.status >= 300) return '';
    return typeof response.body === 'string' ? response.body : JSON.stringify(response.body || '');
  };

  const parseResult = (raw) => {
    for (const line of raw.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      try { return JSON.parse(line); } catch {}
    }
    return null;
  };

  return async (request) => {
    const id = crypto.randomBytes(6).toString('hex');
    const jobName = `platform-sandbox-${id}`;
    const secretName = `${jobName}-input`;
    const labels = { 'app.kubernetes.io/name': 'platform-sandbox', 'app.kubernetes.io/part-of': 'agent-platform', 'platform.agent/request': id };
    const jobRequest = {
      code: String(request.code || ''),
      timeout: request.timeout,
      allow_network: Boolean(request.allow_network),
    };

    await apiJson('POST', `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`, {
      metadata: { name: secretName, labels },
      type: 'Opaque',
      stringData: { 'request.json': JSON.stringify(jobRequest) },
    });

    try {
      await apiJson('POST', `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`, {
        metadata: { name: jobName, labels },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 45,
          ttlSecondsAfterFinished: 300,
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              serviceAccountName: 'platform-sandbox',
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 65532,
                runAsGroup: 65532,
                fsGroup: 65532,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [{
                name: 'runner',
                image,
                imagePullPolicy: 'IfNotPresent',
                command: ['python', '/sandbox_job.py'],
                env: [
                  { name: 'SANDBOX_REQUEST_JSON', valueFrom: { secretKeyRef: { name: secretName, key: 'request.json' } } },
                  { name: 'SANDBOX_TIMEOUT', value: '15' },
                  { name: 'SANDBOX_AS_MB', value: '1536' },
                ],
                resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '2Gi' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
              }],
              volumes: [{ name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } }],
            },
          },
        },
      });

      const deadline = Date.now() + RUN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const job = await apiJson('GET', `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(jobName)}`);
        const pods = await apiJson('GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent('job-name=' + jobName)}`);
        const pod = (pods.items || [])[0];
        if (job.status?.succeeded || job.status?.failed || pod?.status?.phase === 'Succeeded' || pod?.status?.phase === 'Failed') {
          if (pod?.metadata?.name) {
            const result = parseResult(await podLogs(pod.metadata.name));
            if (result) return { status: 200, body: result };
          }
          return { status: 502, body: { ok: false, error: 'sandbox_job_failed' } };
        }
        await sleep(250);
      }
      return { status: 504, body: { ok: false, timeout: true, message: '执行超时（Kubernetes Job）' } };
    } finally {
      await apiRequest('DELETE', `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(secretName)}`);
    }
  };
};

// The HTTP surface. `runJob` is injected so tests can substitute a fake;
// admission and metrics are the real modules (pure, offline-safe).
const createGatewayServer = ({ sandboxKey, runJob, admission, metrics, log = logEvent }) => {
  const reject = (res, caller, decision, status, body, extraHeaders = {}) => {
    metrics.request(caller, decision);
    log({ event: 'request_rejected', caller, decision, status });
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...extraHeaders });
    res.end(payload);
  };

  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true, service: 'platform-sandbox-gateway' });
    // Counters only, no secrets; scraped in-cluster or through the loopback
    // bridge. Same no-auth pattern as platform-runtime /metrics.
    if (req.method === 'GET' && req.url === '/metrics') {
      const payload = metrics.render();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
      return res.end(payload);
    }
    if (req.method !== 'POST' || req.url !== '/run') return json(res, 404, { ok: false, error: 'not found' });

    // 1) Authentication: the shared key remains the only trust boundary.
    if (req.headers['x-sandbox-key'] !== sandboxKey) {
      return reject(res, 'unknown', 'unauthorized', 401, { ok: false, error: 'unauthorized' });
    }

    // 2) Caller identity: strict charset, fail closed on anything odd.
    const identity = parseCaller(req.headers['x-sandbox-caller']);
    if (identity.error) {
      return reject(res, 'invalid', 'invalid_caller', 400, { ok: false, error: 'invalid_caller' });
    }
    const caller = identity.caller;

    // 3) Allowlist + per-caller rate. Tokens are spent before body parsing
    //    so malformed floods still cost the caller quota.
    const verdict = admission.check(caller);
    if (!verdict.allowed) {
      const headers = verdict.retryAfterSec ? { 'Retry-After': String(verdict.retryAfterSec) } : {};
      const body = { ok: false, error: verdict.error, ...(verdict.retryAfterSec ? { retry_after: verdict.retryAfterSec } : {}) };
      return reject(res, caller, verdict.error, verdict.status, body, headers);
    }

    // 4) Existing input guards, unchanged bodies/statuses.
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 25000) return reject(res, caller, 'too_large', 413, { ok: false, error: 'request too large' });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {
      return reject(res, caller, 'invalid_request', 400, { ok: false, error: 'invalid json' });
    }
    const code = String(body.code || '');
    if (!code.trim()) return reject(res, caller, 'invalid_request', 400, { ok: false, error: 'code is required' });
    if (code.length > 20000) return reject(res, caller, 'invalid_request', 400, { ok: false, error: 'code too long' });

    // 5) Global concurrency cap: one slot per in-flight Kubernetes Job.
    if (!admission.acquire()) {
      return reject(res, caller, 'busy', 429, { ok: false, error: 'busy', retry_after: 1 }, { 'Retry-After': '1' });
    }
    metrics.request(caller, 'admitted');
    metrics.setInflight(admission.inflight);
    const startedAt = Date.now();
    try {
      const result = await runJob(body);
      const outcome = result.status === 200 ? 'ok' : (result.status === 504 ? 'timeout' : 'job_failed');
      metrics.run(caller, outcome);
      metrics.observeJobSeconds((Date.now() - startedAt) / 1000);
      log({ event: 'run_finished', caller, status: result.status, duration_ms: Date.now() - startedAt });
      return json(res, result.status, result.body);
    } catch (error) {
      metrics.run(caller, 'error');
      metrics.observeJobSeconds((Date.now() - startedAt) / 1000);
      log({ event: 'run_finished', caller, status: 502, duration_ms: Date.now() - startedAt });
      return json(res, 502, { ok: false, error: String(error.message || error).slice(0, 300) });
    } finally {
      admission.release();
      metrics.setInflight(admission.inflight);
    }
  });
};

if (require.main === module) {
  const config = loadRuntimeConfig();
  const admissionConfig = admissionConfigFromEnv(process.env);
  const admission = createAdmission(admissionConfig);
  const metrics = createMetrics();
  const runJob = createJobRunner(config);
  logEvent({ event: 'admission_config', ...admissionConfig });
  const server = createGatewayServer({ sandboxKey: config.sandboxKey, runJob, admission, metrics });
  server.listen(config.port, '0.0.0.0', () => console.log(`[sandbox-gateway] listening on ${config.port}`));
}

module.exports = { createGatewayServer, createJobRunner, loadRuntimeConfig };