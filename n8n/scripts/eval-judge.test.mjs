import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreJudgment, scoreOne, parseThreshold, rowsFromInput,
  prepareCalibration, quadraticWeightedKappa, summarizeCalibration,
  summarizeScores, runScore, runCalibration, parseArgs, defaultReportPath, main,
} from './eval-judge.mjs';

// Synthetic unit probes only: never persisted as labels, fixtures, or calibration evidence.
const keys = ['correctness', 'faithfulness', 'instruction', 'conciseness'];
const answer = '测试原文：答案是四。';
const input = { task: '二加二等于多少？', answer };
const judgment = (rating = 5) => ({
  scores: Object.fromEntries(keys.map((key) => [key, rating])),
  evidence: Object.fromEntries(keys.map((key) => [key, ['答案是四']])),
  verdict: 'pass',
});
const evaluate = (value = judgment(), threshold = 0.75) => scoreJudgment({ answer, judgment: value, threshold });
const unitRows = (n = 20) => Array.from({ length: n }, (_, i) => ({
  id: `unit-only-${i}`, task: `单元测试题 ${i}：二加二？`, answer, human: i % 5 + 1,
}));
const unitResults = (rows) => rows.map((row) => evaluate(judgment(row.human)));
const silent = { log() {}, error() {} };
const noNetwork = () => { throw new Error('offline test: unexpected network request'); };
const options = { env: {}, chatKey: 'unit-test-only', fetchImpl: noNetwork };
const httpReply = (value = judgment()) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) });

test('complete numeric rubric passes; low ratings fail regardless of judge verdict', () => {
  const good = evaluate();
  assert.equal(good.status, 'pass');
  assert.equal(good.score, 1);
  assert.equal(good.complete, true);
  assert.equal(good.valid_weight, 1);
  const bad = evaluate(judgment(1));
  assert.equal(bad.status, 'fail');
  assert.equal(bad.score, 0);
  assert.equal(evaluate(judgment(4)).score, 0.75);
  assert.equal(evaluate(judgment(4), 0.75).status, 'pass');
  assert.equal(evaluate(judgment(4), 0.7501).status, 'fail');
});

test('each dimension strictly requires a number, integer, and range 1..5', () => {
  for (const key of keys) for (const bad of [undefined, null, '5', true, false, 0, -1, 6, 1.5, NaN, Infinity, [], {}]) {
    const value = judgment();
    value.scores[key] = bad;
    const result = evaluate(value);
    assert.equal(result.dimensions[key].raw, null, `${key}: ${String(bad)}`);
    assert.notEqual(result.status, 'pass');
    assert.notEqual(result.score, 1);
    assert.match(result.dimensions[key].invalid_reason, /integer/);
  }
});

test('each dimension needs a nonempty array of nonempty verbatim strings', () => {
  for (const key of keys) for (const bad of [undefined, null, [], '', '答案是四', {}, [''], ['  '], [null], [4], ['不在原文中'], ['答案是四', ''], ['答案是四', 'not verbatim']]) {
    const value = judgment();
    value.evidence[key] = bad;
    const result = evaluate(value);
    assert.equal(result.dimensions[key].raw, null, key);
    assert.notEqual(result.status, 'pass');
    assert.match(result.dimensions[key].invalid_reason, /evidence|verbatim/);
  }
  const absent = judgment();
  delete absent.evidence;
  assert.equal(evaluate(absent).score, null);
  const padded = judgment();
  padded.evidence.correctness = [' 答案是四 '];
  assert.equal(evaluate(padded).score, null, 'evidence is not trimmed into a match');
});

test('core dimensions are mandatory; optional invalid dimensions cannot be renormalized or pass', () => {
  for (const key of ['correctness', 'faithfulness']) {
    const value = judgment();
    delete value.scores[key];
    assert.equal(evaluate(value, 0).status, 'insufficient');
    assert.equal(evaluate(value, 0).score, null);
  }
  const value = judgment();
  delete value.evidence.instruction;
  delete value.evidence.conciseness;
  const partial = evaluate(value, 0);
  assert.equal(partial.score, 0.7);
  assert.equal(partial.valid_weight, 0.7);
  assert.equal(partial.complete, false);
  assert.equal(partial.status, 'partial');
});

test('threshold accepts finite 0..1 only and rejects empty input/judge shapes', () => {
  for (const value of [0, 1, 0.75, '0', '1', '0.75']) assert.equal(parseThreshold(value), Number(value));
  for (const value of ['', ' ', 'no', 'Infinity', NaN, Infinity, -0.01, 1.01, null, true, false, [], {}]) {
    assert.throws(() => parseThreshold(value), /threshold/);
  }
  for (const value of [null, [], '5', false]) assert.equal(evaluate(value).status, 'invalid');
  for (const value of ['', '  ', null, 5]) assert.equal(scoreJudgment({ answer: value, judgment: judgment() }).status, 'invalid');
  for (const data of [[], { rows: [] }, {}, null, { rows: {} }]) assert.throws(() => rowsFromInput(data), /nonempty/);
  assert.deepEqual(rowsFromInput({ rows: [input] }), [input]);
  assert.throws(() => summarizeScores([]), /nonempty/);
});

test('HTTP failures, transport errors, JSON errors and missing content are invalid, never pending/pass', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    let decoded = false;
    const result = await scoreOne(input, { ...options, fetchImpl: async () => ({
      ok: false, status, json: async () => { decoded = true; return (await httpReply().json()); },
    }) });
    assert.equal(result.status, 'invalid');
    assert.equal(result.score, null);
    assert.match(result.reason, new RegExp(String(status)));
    assert.equal(decoded, false, 'error body must not masquerade as a successful judgment');
  }
  const failures = [
    async () => { throw new Error('timeout'); },
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 42 } }] }) }),
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not JSON' } }] }) }),
    async () => httpReply(null),
  ];
  for (const fetchImpl of failures) assert.equal((await scoreOne(input, { ...options, fetchImpl })).status, 'invalid');
});

test('scoreOne is standalone, missing key is pending, identity/calibration stay unverified', async () => {
  const pending = await scoreOne(input, { env: {}, fetchImpl: noNetwork });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.calibration_status, 'unverified');
  const result = await scoreOne(input, { ...options, fetchImpl: async () => httpReply() });
  assert.equal(result.status, 'pass');
  assert.equal(result.calibration_status, 'unverified');
  assert.equal(result.model_identity.status, 'unverified');
  assert.match(result.model_identity.reason, /do not prove/);
  assert.equal((await scoreOne({ ...input, answer: ' ' }, options)).status, 'invalid');
  for (const threshold of [2, null, '', false, NaN]) {
    assert.equal((await scoreOne(input, { ...options, threshold })).status, 'invalid');
  }
  const same = await scoreOne(input, { ...options, judgeModel: 'same', agentModels: ['same'] });
  assert.equal(same.status, 'invalid');
  assert.match(same.reason, /also an agent alias/);
});

test('actual 30-row skeleton, with or without a rows wrapper, is rejected before scoring/network', async () => {
  const skeleton = JSON.parse(fs.readFileSync(new URL('../eval/labels/calibration-30.json', import.meta.url), 'utf8'));
  assert.equal(skeleton.rows.length, 30);
  let calls = 0;
  const scorer = async () => { calls++; throw new Error('must not score skeleton'); };
  for (const data of [skeleton, skeleton.rows, { rows: skeleton.rows.map((row) => ({ ...row, human: 5 })) }]) {
    assert.throws(() => prepareCalibration(data), /got 0\/30/);
    await assert.rejects(runCalibration(data, options, scorer), /BEFORE any judge request/);
  }
  const errors = [];
  assert.equal(await main(['--calibrate'], { env: {}, scorer, saveReport: noNetwork, log() {}, error: (text) => errors.push(text) }), 2);
  assert.match(errors[0], /skeleton/);
  assert.equal(calls, 0);
});

test('calibration accepts arrays and rows; only non-placeholder integer human labels count', () => {
  const rows = unitRows();
  for (const data of [rows, { rows }]) assert.equal(prepareCalibration(data).rows.length, 20);
  assert.throws(() => prepareCalibration(rows.slice(0, 19)), /got 19\/19/);
  for (const human of [null, '5', true, 0, 6, 2.5, NaN, Infinity]) {
    assert.throws(() => prepareCalibration(rows.map((row, i) => i === 0 ? { ...row, human } : row)), /got 19\/20/);
  }
  for (const text of ['', ' ', '（待回填）', '（同上）', '（shakedown 后自动填充）', '（手写一个坏答案）', 'TODO', '...']) {
    assert.throws(() => prepareCalibration(rows.map((row, i) => i === 0 ? { ...row, answer: text } : row)), /got 19\/20/);
  }
  const prepared = prepareCalibration([...rows, { ...input, human: '5' }]);
  assert.equal(prepared.rows.length, 20);
  assert.equal(prepared.rejected.length, 1);
});

test('kappa requires valid categories; empty/constant/invalid pairs cannot establish agreement', () => {
  assert.equal(quadraticWeightedKappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), 1);
  assert.ok(quadraticWeightedKappa([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) < 0);
  for (const [a, b] of [[[], []], [[5, 5], [5, 5]], [[1], []], [['1'], [1]], [[1.5], [1]], [[6], [1]], [[1], [0]], [[NaN], [1]]]) {
    assert.equal(quadraticWeightedKappa(a, b), null);
  }
});

test('calibration needs >=20 complete valid pairs AND kappa >=0.70', async () => {
  const rows = unitRows();
  const good = unitResults(rows);
  assert.equal(summarizeCalibration(rows, good).gate, 'PASS');
  for (const count of [0, 2, 19]) {
    const results = good.map((r, i) => i < count ? r : { status: 'invalid', score: null });
    const report = summarizeCalibration(rows, results);
    assert.equal(report.scored_pairs, count);
    assert.equal(report.gate, 'FAIL');
    if (count > 1) assert.equal(report.quadratic_weighted_kappa, 1);
  }
  const poor = rows.map((row) => evaluate(judgment(6 - row.human)));
  assert.equal(summarizeCalibration(rows, poor).gate, 'FAIL');
  const partial = judgment();
  partial.evidence.instruction = [];
  const mixed = [...good.slice(0, 19), evaluate(partial)];
  assert.equal(summarizeCalibration(rows, mixed).scored_pairs, 19);
  // Aggregation must not trust a caller-supplied complete/pass flag over bad evidence.
  for (const evidence of [[], [''], ['not in answer']]) {
    const corrupt = structuredClone(good);
    corrupt[19].dimensions.correctness.evidence = evidence;
    assert.equal(summarizeCalibration(rows, corrupt).scored_pairs, 19);
    assert.equal(summarizeCalibration(rows, corrupt).gate, 'FAIL');
  }
  const constant = rows.map((row) => ({ ...row, human: 5 }));
  assert.equal(summarizeCalibration(constant, unitResults(constant)).gate, 'FAIL');
  assert.throws(() => summarizeCalibration([], []), /nonempty/);
  assert.throws(() => summarizeCalibration(rows, []), /aligned/);
  const report = await runCalibration({ rows }, { env: {} }, async (row) => evaluate(judgment(row.human)));
  assert.equal(report.exitCode, 0);
  assert.equal(report.summary.gate, 'PASS');
  assert.match(report.summary.scope, /Not release-gate approval/);
});

test('kappa just below 0.70 cannot pass due to display rounding', () => {
  const rows = unitRows(2000);
  const ratings = rows.map((row, i) => i < 300 ? 6 - row.human : i === 300 ? 2 : row.human);
  const byRating = new Map([1, 2, 3, 4, 5].map((n) => [n, evaluate(judgment(n))]));
  const summary = summarizeCalibration(rows, ratings.map((rating) => byRating.get(rating)));
  assert.ok(summary.quadratic_weighted_kappa < 0.70);
  assert.equal(Number(summary.quadratic_weighted_kappa.toFixed(3)), 0.70);
  assert.equal(summary.gate, 'FAIL');
});

test('score run rejects malformed rows before requests and exits nonzero for pending/invalid/partial/fail', async () => {
  for (const data of [[], { rows: [] }, [{ ...input, answer: '' }], [input, null]]) {
    await assert.rejects(runScore(data, options, noNetwork));
  }
  for (const status of ['pending', 'invalid', 'insufficient', 'partial', 'fail']) {
    const report = await runScore({ rows: [input] }, { env: {} }, async () => ({ status, score: status === 'fail' ? 0 : null }));
    assert.equal(report.exitCode, 1);
  }
  const pending = await runScore([input], { env: {}, fetchImpl: noNetwork });
  assert.equal(pending.exitCode, 1);
  assert.equal(pending.summary.mean_score, null);
  const summary = summarizeScores([{ status: 'invalid' }, { status: 'pending', score: NaN }, { status: 'pass', score: 1 }]);
  assert.equal(summary.mean_score, 1);
});

test('CLI --judge-model overrides environment and is actually sent; default outputs stay local', async () => {
  const calls = [];
  const saved = [];
  const argv = ['--input', 'unit-only.json', '--judge-model', 'unit-judge-alias', '--threshold', '1'];
  assert.equal(parseArgs(argv).judgeModel, 'unit-judge-alias');
  const exit = await main(argv, {
    env: { EVAL_JUDGE_MODEL: 'old-alias', CHAT_API_KEY: 'unit-test-only' },
    readJson: () => ({ rows: [input] }),
    scorer: (row, config) => scoreOne(row, { ...config, fetchImpl: async (_url, request) => {
      calls.push(JSON.parse(request.body));
      return httpReply();
    } }),
    saveReport: (file, report) => saved.push({ file, report }),
    ...silent,
  });
  assert.equal(exit, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'unit-judge-alias');
  assert.equal(saved[0].report.summary.threshold, 1);
  const localDir = fileURLToPath(new URL('../../.eval-local/judge/', import.meta.url));
  assert.equal(path.dirname(saved[0].file), path.resolve(localDir));
  assert.equal(path.dirname(defaultReportPath('calibration', 'unit-only')), path.resolve(localDir));
});

test('CLI returns setup error for invalid thresholds, unknown/missing options, empty inputs, or same alias', async () => {
  for (const argv of [
    ['--input', 'unit.json', '--threshold', '-1'], ['--input', 'unit.json', '--threshold', 'NaN'],
    ['--judge-model'], ['--unknown'], [], ['--input', 'unit.json', '--judge-model', 'deepseek-agent'],
  ]) {
    const exit = await main(argv, { env: {}, readJson: () => [input], scorer: noNetwork, saveReport: noNetwork, ...silent });
    assert.equal(exit, 2);
  }
  assert.equal(await main(['--input', 'unit.json'], { env: {}, readJson: () => [], scorer: noNetwork, saveReport: noNetwork, ...silent }), 2);
  assert.equal(await main(['--input', 'unit.json'], { env: {}, readJson: () => [input], saveReport() {}, ...silent }), 1);
  assert.equal(await main(['--input', 'unit.json'], { env: { EVAL_JUDGE_THRESHOLD: '' }, readJson: noNetwork, saveReport: noNetwork, ...silent }), 2);
});
