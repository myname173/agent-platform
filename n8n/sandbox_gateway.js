#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const NAMESPACE = process.env.POD_NAMESPACE || fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
const SANDBOX_KEY = process.env.SANDBOX_KEY || '';
const API_HOST = process.env.KUBERNETES_SERVICE_HOST;
const API_PORT = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || 443);
const TOKEN = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
const CA = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
const IMAGE = process.env.SANDBOX_IMAGE || 'agent-platform/sandbox:3.14-k8s-pilot';
const RUN_TIMEOUT_MS = 50000;

if (!SANDBOX_KEY || !API_HOST || !TOKEN) throw new Error('sandbox gateway is missing Kubernetes or auth configuration');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
};

const apiRequest = (method, path, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = https.request({
    hostname: API_HOST,
    port: API_PORT,
    path,
    method,
    ca: CA,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
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
  const path = `/api/v1/namespaces/${encodeURIComponent(NAMESPACE)}/pods/${encodeURIComponent(podName)}/log?container=runner`;
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

const runJob = async (request) => {
  const id = crypto.randomBytes(6).toString('hex');
  const jobName = `platform-sandbox-${id}`;
  const secretName = `${jobName}-input`;
  const labels = { 'app.kubernetes.io/name': 'platform-sandbox', 'app.kubernetes.io/part-of': 'agent-platform', 'platform.agent/request': id };
  const jobRequest = {
    code: String(request.code || ''),
    timeout: request.timeout,
    allow_network: Boolean(request.allow_network),
  };

  await apiJson('POST', `/api/v1/namespaces/${encodeURIComponent(NAMESPACE)}/secrets`, {
    metadata: { name: secretName, labels },
    type: 'Opaque',
    stringData: { 'request.json': JSON.stringify(jobRequest) },
  });

  try {
    await apiJson('POST', `/apis/batch/v1/namespaces/${encodeURIComponent(NAMESPACE)}/jobs`, {
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
              image: IMAGE,
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
      const job = await apiJson('GET', `/apis/batch/v1/namespaces/${encodeURIComponent(NAMESPACE)}/jobs/${encodeURIComponent(jobName)}`);
      const pods = await apiJson('GET', `/api/v1/namespaces/${encodeURIComponent(NAMESPACE)}/pods?labelSelector=${encodeURIComponent('job-name=' + jobName)}`);
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
    await apiRequest('DELETE', `/api/v1/namespaces/${encodeURIComponent(NAMESPACE)}/secrets/${encodeURIComponent(secretName)}`);
  }
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true, service: 'platform-sandbox-gateway' });
  if (req.method !== 'POST' || req.url !== '/run') return json(res, 404, { ok: false, error: 'not found' });
  if (req.headers['x-sandbox-key'] !== SANDBOX_KEY) return json(res, 401, { ok: false, error: 'unauthorized' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25000) return json(res, 413, { ok: false, error: 'request too large' });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
  const code = String(body.code || '');
  if (!code.trim()) return json(res, 400, { ok: false, error: 'code is required' });
  if (code.length > 20000) return json(res, 400, { ok: false, error: 'code too long' });
  try {
    const result = await runJob(body);
    return json(res, result.status, result.body);
  } catch (error) {
    return json(res, 502, { ok: false, error: String(error.message || error).slice(0, 300) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[sandbox-gateway] listening on ${PORT}`));
