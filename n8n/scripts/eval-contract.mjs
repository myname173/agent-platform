/** Shared deterministic contract for live runs and offline replay. No I/O on import. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim().length > 0);
const allowed = (obj, keys, label, errors) => {
  if (!object(obj)) { errors.push(`${label}: expected object`); return false; }
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${label}: unsupported assertion ${k}`);
  return true;
};
export function positiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}
export function loadTools(file) {
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  const code = w.nodes?.find((n) => n.name === 'Build Upstream Payload')?.parameters?.jsCode || '';
  const start = code.indexOf('const TOOLS = [');
  const end = code.indexOf('const DIRECTIVE');
  if (start < 0 || end <= start) throw new Error('cannot locate gateway TOOLS');
  const names = [...code.slice(start, end).matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  if (!names.length || new Set(names).size !== names.length) throw new Error('empty or duplicate gateway tools');
  return new Set(names);
}
export function validateCase(c, tools) {
  const errors = [];
  if (!object(c)) return ['case must be an object'];
  if (typeof c.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(c.id)) errors.push('invalid case id');
  if (typeof c.category !== 'string' || !c.category.trim()) errors.push('missing category');
  // Other protocols are handled by agent-eval, not by this chat runner.
  if (c.kind !== 'chat') errors.push('only kind=chat is implemented by eval-run');
  if (!['ported', 'real-failure', 'boundary', 'canary'].includes(c.origin)) errors.push('invalid origin');
  if (c.origin === 'ported' && !c.ported_from?.trim()) errors.push('ported_from required');
  if (c.origin === 'real-failure' && !c.why?.trim()) errors.push('real-failure requires human why');
  if (c.runs !== undefined) { try { positiveInteger(c.runs, 'case runs'); } catch (e) { errors.push(e.message); } }
  if (c.weight !== undefined && c.weight !== 1) errors.push('weighted metrics are not implemented; weight must be 1');
  if (c.turns && c.messages) errors.push('use turns or messages, not both');
  const turns = c.turns || c.messages;
  if (!Array.isArray(turns) || !turns.length || turns.some((t) => !object(t) || t.role !== 'user' || typeof t.content !== 'string' || !t.content.trim())) {
    errors.push('turns must contain nonempty user messages; assistant turns come from actual execution');
  }
  if (c.system !== undefined && typeof c.system !== 'string') errors.push('system must be a string');
  const prompt = [c.system, ...(Array.isArray(turns) ? turns.map((t) => t?.content) : [])].join(' ');
  if (/evaluation fixture|you are being (?:evaluated|tested)|this is a test/i.test(prompt)) errors.push('eval-aware prompt wording');
  const e = c.expect;
  if (!allowed(e, ['status', 'tools', 'args', 'answer', 'judge'], 'expect', errors)) return errors;
  let assertions = 0;
  if (e.status !== undefined) {
    if (!Number.isInteger(e.status) || e.status < 100 || e.status > 599) errors.push('invalid HTTP status');
    else assertions++;
  }
  if (e.tools !== undefined && allowed(e.tools, ['required', 'forbidden'], 'tools', errors)) {
    for (const key of ['required', 'forbidden']) if (e.tools[key] !== undefined) {
      if (!strings(e.tools[key])) errors.push(`tools.${key} must be a string array`);
      else assertions += e.tools[key].length;
    }
    for (const t of e.tools.required || []) if (e.tools.forbidden?.includes(t)) errors.push(`tool both required and forbidden: ${t}`);
  }
  if (e.args !== undefined) {
    if (!Array.isArray(e.args)) errors.push('args must be an array');
    else for (const r of e.args) {
      if (!allowed(r, ['tool', 'includes'], 'args entry', errors) || typeof r.tool !== 'string' || typeof r.includes !== 'string' || !r.includes.length) errors.push('args entry needs tool and nonempty includes');
      else assertions++;
    }
  }
  if (e.answer !== undefined && allowed(e.answer, ['must_include', 'must_not_include', 'citation_doc_ids', 'refusal', 'min_chars', 'max_chars'], 'answer', errors)) {
    for (const k of ['must_include', 'must_not_include', 'citation_doc_ids']) if (e.answer[k] !== undefined) {
      if (!strings(e.answer[k])) errors.push(`answer.${k} must be a string array`);
      else assertions += e.answer[k].length;
    }
    if (e.answer.refusal !== undefined) {
      if (typeof e.answer.refusal !== 'boolean') errors.push('refusal must be boolean');
      if (e.answer.refusal === true) assertions++;
    }
    for (const k of ['min_chars', 'max_chars']) if (e.answer[k] !== undefined) {
      if (!Number.isInteger(e.answer[k]) || e.answer[k] < 0) errors.push(`${k} must be a nonnegative integer`);
      else assertions++;
    }
    if (e.answer.min_chars > e.answer.max_chars) errors.push('min_chars exceeds max_chars');
  }
  if (e.judge !== undefined && allowed(e.judge, ['rubric', 'threshold'], 'judge', errors)) {
    if (typeof e.judge.rubric !== 'string' || !e.judge.rubric || !Number.isFinite(e.judge.threshold) || e.judge.threshold < 0 || e.judge.threshold > 1) errors.push('invalid judge rubric/threshold');
  }
  if (!assertions) errors.push('no implemented deterministic assertion');
  const refs = [...(Array.isArray(e.tools?.required) ? e.tools.required : []), ...(Array.isArray(e.tools?.forbidden) ? e.tools.forbidden : []), ...(Array.isArray(e.args) ? e.args.map((r) => r?.tool) : [])];
  for (const t of refs) if (!tools.has(t) && !/^wf_[a-zA-Z0-9_]+$/.test(t)) errors.push(`unknown tool: ${t}`);
  return errors;
}
export function loadSuites(dir, tools, selected = null) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (selected) for (const s of selected) if (!files.includes(`${s}.json`)) throw new Error(`unknown suite: ${s}`);
  const cases = []; const hashes = []; const ids = new Set();
  for (const file of files.filter((f) => !selected || selected.includes(f.slice(0, -5)))) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const suite = JSON.parse(raw);
    if (!Array.isArray(suite.cases) || !suite.cases.length) throw new Error(`${file}: empty suite`);
    hashes.push([file, raw]);
    for (const c of suite.cases) {
      const errors = validateCase(c, tools);
      if (ids.has(c.id)) errors.push('duplicate id');
      if (errors.length) throw new Error(`${file}/${c.id}: ${errors.join('; ')}`);
      ids.add(c.id);
      cases.push({ ...c, suite: suite.suite || file.slice(0, -5) });
    }
  }
  if (!cases.length) throw new Error('no cases loaded');
  return { cases, suiteHash: digest(hashes) };
}

export function checkCase(result, c, { deterministicOnly = false } = {}) {
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok: ok === true, message });
  const e = c.expect || {};
  if (e.status !== undefined) add('status', result.status === e.status, `HTTP ${e.status}`);
  add('response', typeof result.content === 'string' && result.content.trim().length > 0, 'nonempty assistant answer');
  const observable = result.trace?.available === true && Array.isArray(result.trace.trace);
  // An absent trace is UNKNOWN, not proof that no forbidden tool ran.
  add('trace_available', observable, 'valid execution trace available');
  const trace = observable ? result.trace.trace : [];
  const names = trace.map((t) => t.tool);
  for (const tool of e.tools?.required || []) add('tool_required', observable && names.includes(tool), `tool used: ${tool}`);
  for (const tool of e.tools?.forbidden || []) add('tool_forbidden', observable && !names.includes(tool), `tool not used: ${tool}`);
  for (const r of e.args || []) add('args', observable && trace.some((t) => t.tool === r.tool && (typeof t.args === 'string' ? t.args : JSON.stringify(t.args || {})).includes(r.includes)), `arguments match: ${r.tool}`);
  const text = typeof result.content === 'string' ? result.content : '';
  const a = e.answer || {};
  for (const n of a.must_include || []) add('answer_include', text.includes(n), `answer includes ${JSON.stringify(n)}`);
  for (const n of a.must_not_include || []) add('answer_forbidden', !text.includes(n), `answer excludes ${JSON.stringify(n)}`);
  for (const n of a.citation_doc_ids || []) add('citation', text.includes(n), `answer cites ${n}`);
  if (a.min_chars !== undefined) add('min_chars', text.trim().length >= a.min_chars, `min chars ${a.min_chars}`);
  if (a.max_chars !== undefined) add('max_chars', text.length <= a.max_chars, `max chars ${a.max_chars}`);
  if (a.refusal) add('refusal', ['没有', '未收录', '找不到', '未找到', '不包含', '无法回答', 'not found', 'no relevant'].some((m) => text.toLowerCase().includes(m)), 'refusal marker present (heuristic, not semantic proof)');
  if (e.judge && !deterministicOnly) add('judge_pending', false, 'calibrated judge unavailable; --deterministic-only is shakedown, not release acceptance');
  return checks;
}

export function checkAttempt(result, c, options = {}) {
  const checks = checkCase(result, c, options);
  const turns = Array.isArray(result.turns) ? result.turns : [];
  checks.push({ id: 'turns_complete', ok: turns.length === (c.turns || c.messages).length && !result.stop_reason && turns.every((t) => t.status === (c.expect.status ?? 200) && typeof t.answer === 'string' && t.answer.trim().length > 0 && t.trace?.available === true && Array.isArray(t.trace.trace)), message: 'all requested turns completed with telemetry' });
  const knownCosts = turns.length > 0 && turns.every((t) => Number.isFinite(t.trace?.cost) && t.trace.cost >= 0);
  checks.push({ id: 'cost_known', ok: knownCosts && Number.isFinite(result.cost) && result.cost >= 0 && Math.abs(turns.reduce((s, t) => s + t.trace.cost, 0) - result.cost) < 1e-8, message: 'every turn has observed cost and agrees with the attempt total' });
  return checks;
}

export function scorecard(results, plannedCases, k) {
  const attempts = results.flatMap((r) => r.attempts);
  const complete = results.length === plannedCases && results.every((r) => r.attempts.length === k);
  const rate = (n, d) => d ? Number((n / d).toFixed(4)) : null;
  const sample = results.filter((r) => r.attempts.length === k);
  const percentile = (p) => {
    const values = attempts.map((a) => a.ms).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    return values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : null;
  };
  return {
    complete,
    totals: {
      planned_cases: plannedCases, cases: results.length, attempts: attempts.length,
      planned_attempts: plannedCases * k, passed_attempts: attempts.filter((a) => a.passed).length,
      tsr: complete ? rate(attempts.filter((a) => a.passed).length, attempts.length) : null,
      observed_tsr: rate(attempts.filter((a) => a.passed).length, attempts.length),
      pass_1: complete ? rate(results.filter((r) => r.attempts[0]?.passed).length, plannedCases) : null,
      pass_k: complete ? rate(sample.filter((r) => r.attempts.every((a) => a.passed)).length, plannedCases) : null,
      pass_at_k: complete ? rate(sample.filter((r) => r.attempts.some((a) => a.passed)).length, plannedCases) : null,
      k,
    },
    latency_ms: { p50: percentile(.5), p95: percentile(.95) },
    cost_usd: attempts.length && attempts.every((a) => Number.isFinite(a.cost) && a.cost >= 0) ? Number(attempts.reduce((s, a) => s + a.cost, 0).toFixed(6)) : null,
    safety_violations: attempts.filter((a) => a.checks?.some((c) => c.id === 'tool_forbidden' && !c.ok && a.trace?.available)).length,
  };
}

export function replayFixture(fx, c, suiteHash, harnessHash, runs) {
  const errors = [];
  if (fx.schema_version !== 2 || fx.source !== 'live') errors.push('not a recorded v2 live fixture');
  if (fx.case_id !== c.id || fx.case_hash !== digest(c)) errors.push('case identity/hash mismatch');
  if (fx.suite_hash !== suiteHash || fx.harness_hash !== harnessHash) errors.push('stale suite/harness hash');
  if (!Array.isArray(fx.attempts) || fx.attempts.length !== runs || fx.runs !== runs) errors.push(`fixture needs all ${runs} attempts`);
  if (errors.length) return errors;
  for (const [i, a] of fx.attempts.entries()) {
    for (const check of checkAttempt(a, c, { deterministicOnly: true })) if (!check.ok) errors.push(`attempt ${i + 1}: ${check.message}`);
  }
  return errors;
}
export function harnessHash(dir) {
  return digest(['eval-contract.mjs', 'eval-run.mjs', 'eval-gate.mjs'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
}
