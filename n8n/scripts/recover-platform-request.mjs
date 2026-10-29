#!/usr/bin/env node
/**
 * Resolve one operator-confirmed platform UNKNOWN request.
 *
 * This deliberately does not inspect or guess the business side effect. Check
 * the domain table first, then run this command with the confirmed failure
 * result. It resolves the Redis idempotency record and closes the durable
 * request as FAILED.
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/recover-platform-request.mjs \
 *     --request-id <id> --scope <scope> --idempotency-key <key> \
 *     --trace-id <32-hex> --tool-name <tool> \
 *     --result-json '{"ok":false,"status":422,"code":"..."}'
 *     [--allow-missing-idempotency]
 *
 * Docker CLI must be available. Set DOCKER_BIN when it is not on PATH.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOCKER = process.env.DOCKER_BIN || 'docker';
const argv = process.argv.slice(2);

const readArg = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '') : '';
};

const requestId = readArg('--request-id');
const scope = readArg('--scope');
const idempotencyKey = readArg('--idempotency-key');
const traceId = readArg('--trace-id');
const toolName = readArg('--tool-name');
const resultRaw = readArg('--result-json');
const allowMissingIdempotency = argv.includes('--allow-missing-idempotency');
if (!requestId || !scope || !idempotencyKey || !traceId || !toolName || !resultRaw) {
  console.error('required: --request-id --scope --idempotency-key --trace-id --tool-name --result-json');
  process.exit(2);
}
if (!/^[0-9a-f]{32}$/i.test(traceId)) {
  console.error('--trace-id must be 32 lowercase hexadecimal characters');
  process.exit(2);
}

let result;
try { result = JSON.parse(resultRaw); } catch {
  console.error('--result-json must be valid JSON');
  process.exit(2);
}

const payload = { scope, idempotency_key: idempotencyKey, request_id: requestId, trace_id: traceId, result };
const toolNameLiteral = JSON.stringify(toolName);
const script = [
  'const payload = ' + JSON.stringify(payload) + ';',
  "const key = process.env.PLATFORM_RUNTIME_KEY || process.env.CHAT_API_KEY || '';",
  "const headers = { 'Content-Type': 'application/json', 'x-platform-runtime-key': key };",
  "const call = async (path, body) => { const response = await fetch('http://127.0.0.1:3220' + path, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };",
  "const complete = await call('/v1/idempotency/complete', payload);",
  "if (!complete.body.persisted && !(" + String(allowMissingIdempotency) + " && complete.body.error === 'idempotency_record_missing')) throw new Error('idempotency completion failed: ' + JSON.stringify(complete.body));",
  "const tool = await call('/v1/tool-runs', { request_id: payload.request_id, trace_id: payload.trace_id, tool_name: " + toolNameLiteral + ", state: 'FAILED', idempotency_key: payload.idempotency_key, output: payload.result, error_code: payload.result.code || 'operator_confirmed_failure', error_message: payload.result.error || 'operator confirmed failure' });",
  "const transition = await call('/v1/requests/transition', { request_id: payload.request_id, trace_id: payload.trace_id, scope: payload.scope, idempotency_key: payload.idempotency_key, to_state: 'FAILED', result: payload.result, error_code: payload.result.code || 'operator_confirmed_failure', error_message: payload.result.error || 'operator confirmed failure' });",
  "if (transition.body.state !== 'FAILED') throw new Error('request transition failed: ' + JSON.stringify(transition.body));",
  "console.log(JSON.stringify({ complete, tool, transition }));",
].join('');

try {
  const { stdout } = await execFileAsync(DOCKER, ['exec', 'platform-runtime', 'node', '-e', script], { maxBuffer: 1_000_000 });
  console.log(stdout.trim());
} catch (error) {
  console.error(String(error.stderr || error.message || error).trim());
  process.exit(1);
}
