import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateRetrieval, validateGoldenSet, HIT_AT_1_THRESHOLD, parseEvalFlags, main } from './kb-eval.mjs';

// Pure ranking probes only: no database, embeddings, answers, or saved reports.
const golden = JSON.parse(fs.readFileSync(new URL('../eval/golden-set.json', import.meta.url), 'utf8'));
const titles = golden.docs.map((doc) => doc.title);
const perfectRankings = golden.cases.map((row) => row.expect_title === null ? null : [row.expect_title, ...titles.filter((title) => title !== row.expect_title)]);

test('frozen corpus remains 5 docs / 40 answerable + 10 pending refusal cases', () => {
  assert.equal(validateGoldenSet(golden), golden);
  assert.equal(golden.docs.length, 5);
  assert.equal(golden.cases.length, 50);
  assert.equal(golden.cases.filter((row) => row.expect_title !== null).length, 40);
  assert.equal(golden.cases.filter((row) => row.expect_title === null).length, 10);
  assert.match(golden.note, /冻结语料/);
  assert.match(golden.note, /不代表现网架构事实/);
  assert.match(golden.note, /hit@1 >= 0.80/);
  assert.match(golden.note, /拒答单列 pending\/未测/);
});

test('replacement questions are supported by existing frozen text, not invented architecture facts', () => {
  const supported = [
    ['网关将每次对话写入数据表是为了什么？', '平台架构速览', '用于统计与成本核算'],
    ['工具循环达到轮数上限后，网关如何强制收口？', '流式与工具链', '之后网关移除工具列表强制收口'],
    ['platform-runtime 用什么保存协调状态和审计日志？', '平台状态运行时', '以 Redis 为协调状态、Postgres 为审计日志'],
  ];
  for (const [question, title, evidence] of supported) {
    const matches = golden.cases.filter((row) => row.q === question);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].expect_title, title);
    assert.ok(golden.docs.find((doc) => doc.title === title).text.includes(evidence));
  }
  for (const old of ['查询单条消息历史时网关会怎么补全上下文？', 'run_python 的执行环境是什么？', 'WAITING_RETRY 之后可以回到什么状态？']) {
    assert.ok(!golden.cases.some((row) => row.q === old));
  }
});

test('all correct rankings pass hit@1, hit@5 and MRR without including null expectations', () => {
  const report = evaluateRetrieval(golden.cases, perfectRankings);
  assert.equal(report.answerable_cases, 40);
  assert.equal(report.retrieval_tested, 40);
  assert.equal(report.hit_at_1, 1);
  assert.equal(report.hit_at_5, 1);
  assert.equal(report.mrr, 1);
  assert.equal(report.gate.metric, 'hit_at_1');
  assert.equal(report.gate.threshold, 0.8);
  assert.equal(report.gate.status, 'PASS');
  assert.equal(report.refusal.cases, 10);
  assert.equal(report.refusal.status, 'pending');
  assert.equal(report.refusal.tested, 0);
  assert.equal(report.refusal.correctness, null);
  assert.equal(report.detail.filter((row) => row.status === 'pending').length, 10);
  for (const row of report.detail.filter((row) => row.status === 'pending')) {
    assert.equal(row.hit_at_5, undefined, 'unanswerable is not MISS');
    assert.equal(row.rank, undefined);
  }
  const answeredOnly = golden.cases.filter((row) => row.expect_title !== null);
  const subset = evaluateRetrieval(answeredOnly, perfectRankings.filter((row) => row !== null));
  for (const metric of ['hit_at_1', 'hit_at_5', 'mrr']) assert.equal(subset[metric], report[metric]);
});

test('seeded random ranking and correct ranking are distinguished despite both having hit@5=1', () => {
  let state = 20261109;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const randomRankings = golden.cases.map((row) => {
    if (row.expect_title === null) return null;
    const shuffled = [...titles];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  });
  const randomReport = evaluateRetrieval(golden.cases, randomRankings);
  const correctReport = evaluateRetrieval(golden.cases, perfectRankings);
  assert.equal(randomReport.hit_at_5, 1, 'five docs in top5 is a degenerate diagnostic');
  assert.equal(correctReport.hit_at_5, 1);
  assert.ok(randomReport.hit_at_1 < HIT_AT_1_THRESHOLD);
  assert.ok(randomReport.mrr < correctReport.mrr);
  assert.equal(randomReport.gate.status, 'FAIL');
  assert.equal(correctReport.gate.status, 'PASS');
});

test('top5-only success fails the new gate; MRR and top5 cutoff are preserved', () => {
  const cases = [{ q: 'unit-only ranking question', expect_title: 'target' }];
  const fifth = evaluateRetrieval(cases, [['wrong1', 'wrong2', 'wrong3', 'wrong4', 'target']]);
  assert.equal(fifth.hit_at_1, 0);
  assert.equal(fifth.hit_at_5, 1);
  assert.equal(fifth.mrr, 0.2);
  assert.equal(fifth.gate.status, 'FAIL');
  const sixth = evaluateRetrieval(cases, [['wrong1', 'wrong2', 'wrong3', 'wrong4', 'wrong5', 'target']]);
  assert.equal(sixth.hit_at_5, 0);
  assert.equal(sixth.mrr, 0);
  const empty = evaluateRetrieval(cases, [[]]);
  assert.equal(empty.hit_at_1, 0);
  assert.equal(empty.detail[0].rank, null);
  assert.equal(empty.gate.status, 'FAIL');
});

test('null expectations never affect denominators even with retrieved/accepted titles', () => {
  const cases = [
    { q: 'unit-only answerable', expect_title: 'a' },
    { q: 'unit-only refusal', expect_title: null, accept_titles: ['a'] },
  ];
  const report = evaluateRetrieval(cases, [['a'], ['a']]);
  assert.equal(report.answerable_cases, 1);
  assert.equal(report.hit_at_1, 1);
  assert.equal(report.mrr, 1);
  assert.equal(report.refusal.tested, 0);
});

test('gate threshold is inclusive at 0.80 and rejects below it', () => {
  const cases = Array.from({ length: 5 }, (_, i) => ({ q: `unit-only-${i}`, expect_title: 'target' }));
  const atThreshold = evaluateRetrieval(cases, cases.map((_, i) => [i < 4 ? 'target' : 'wrong']));
  assert.equal(atThreshold.hit_at_1, 0.8);
  assert.equal(atThreshold.gate.status, 'PASS');
  const below = evaluateRetrieval(cases, cases.map((_, i) => [i < 3 ? 'target' : 'wrong']));
  assert.equal(below.gate.status, 'FAIL');
});

test('alternative accepted titles are supported, but absent cases/rankings and malformed expectations are rejected', () => {
  const row = { q: 'unit-only query', expect_title: 'a', accept_titles: ['b'] };
  assert.equal(evaluateRetrieval([row], [['b']]).hit_at_1, 1);
  assert.equal(evaluateRetrieval([row], [['a']]).hit_at_1, 1);
  for (const [cases, rankings] of [
    [[], []], [[row], []], [[row], [null]], [[row], [[null]]],
    [[{ q: 'missing expectation' }], [[]]], [[{ q: '', expect_title: 'a' }], [[]]],
    [[{ q: 'refusal only', expect_title: null }], [null]],
    [[{ ...row, accept_titles: 'a' }], [['a']]],
  ]) assert.throws(() => evaluateRetrieval(cases, rankings));
  assert.throws(() => validateGoldenSet({ docs: [], cases: [] }));
  assert.throws(() => validateGoldenSet({ ...golden, cases: [{ q: 'unit-only query', expect_title: 'unknown' }] }), /frozen corpus/);
});

test('live entry refuses without explicit isolated-stack confirmation before config, pg, files or network', async () => {
  // Only exercise the no-I/O guard, never the live --isolated-stack branch.
  const env = new Proxy({}, { get() { assert.fail('guard must not read environment'); } });
  for (const argv of [[], ['--help'], ['--rerank'], ['--isolated-stack=false'], ['--isolated-stack', 'false'], ['--unknown', '--isolated-stack'], ['--isolated-stack', '--hybrid', '--rerank', '--extra']]) {
    const errors = [];
    const code = await main(argv, { env, log() { assert.fail('no live output'); }, error: (text) => errors.push(text) });
    assert.equal(code, 2);
    assert.match(errors[0], /SETUP ERROR.*--isolated-stack/);
    assert.match(errors[0], /Shared KB must not be used/);
  }
});

test('parseEvalFlags accepts --isolated-stack with optional --hybrid/--rerank (orthogonal, order-independent), rejects everything else', () => {
  // Pure guard: no env/files/network. Positives must not be reachable by the
  // live-I/O path in tests; this only checks the flag decision.
  assert.deepEqual(parseEvalFlags(['--isolated-stack']), { ok: true, hybrid: false, rerank: false });
  assert.deepEqual(parseEvalFlags(['--isolated-stack', '--hybrid']), { ok: true, hybrid: true, rerank: false });
  assert.deepEqual(parseEvalFlags(['--hybrid', '--isolated-stack']), { ok: true, hybrid: true, rerank: false });
  assert.deepEqual(parseEvalFlags(['--isolated-stack', '--rerank']), { ok: true, hybrid: false, rerank: true });
  assert.deepEqual(parseEvalFlags(['--rerank', '--isolated-stack']), { ok: true, hybrid: false, rerank: true });
  assert.deepEqual(parseEvalFlags(['--isolated-stack', '--hybrid', '--rerank']), { ok: true, hybrid: true, rerank: true });
  assert.deepEqual(parseEvalFlags(['--rerank', '--hybrid', '--isolated-stack']), { ok: true, hybrid: true, rerank: true });
  assert.deepEqual(parseEvalFlags(['--hybrid', '--rerank', '--isolated-stack']), { ok: true, hybrid: true, rerank: true });
  for (const argv of [
    [], ['--help'], ['--hybrid'], ['--rerank'], ['--hybrid', '--rerank'],
    ['--isolated-stack=false'], ['--isolated-stack', 'false'],
    ['--unknown', '--isolated-stack'], ['--isolated-stack', '--isolated-stack'],
    ['--isolated-stack', '--rerank', '--rerank'], ['--isolated-stack', '--hybrid', '--hybrid'],
    ['--isolated-stack', '--hybrid', '--extra'], ['--isolated-stack', '--rerank', '--extra'],
    ['--isolated-stack', '--hybrid', '--rerank', '--extra'],
    ['--isolated-stack', '--hybrid', '--rerank', '--isolated-stack'],
    null, 'string',
  ]) {
    assert.equal(parseEvalFlags(argv).ok, false, 'must reject ' + JSON.stringify(argv));
  }
});
