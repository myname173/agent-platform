#!/usr/bin/env node
/**
 * LLM-as-judge for open-ended answers (Phase E3).
 *
 * Rubric: 4 dimensions, 1-5 anchors, weighted, normalized to 0-1.
 *   correctness 0.40 / faithfulness 0.30 / instruction 0.20 / conciseness 0.10
 *   pass = weighted >= threshold (default 0.75)
 *
 * Hard rules from the framework (reports/agent-eval-framework-20261109):
 *   - judge MUST cite evidence spans from the answer; a span that does not
 *     appear in the answer invalidates that dimension (anti-hallucinated-judge)
 *   - judge model should differ from the agent model (EVAL_JUDGE_MODEL)
 *   - prompt version is hashed into every result (drift is detectable)
 *   - --calibrate: score a labeled file and report quadratic weighted kappa
 *     vs human labels; kappa >= 0.70 is the gate for judge entering the
 *     release gate
 *   - no judge key -> graceful "pending" (never silently pass)
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/eval-judge.mjs \
 *        --input <eval-results.json|replay-dir file> --out <scores.json>
 *   node --env-file=.env n8n/scripts/eval-judge.mjs --calibrate \
 *        --labels n8n/eval/labels/calibration-30.json [--judge-model deepseek-reasoner]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'deepseek-reasoner';
const AGENT_MODEL_BAN = new Set((process.env.EVAL_AGENT_MODELS || 'deepseek-agent').split(',').map((s) => s.trim()));
const THRESHOLD = Number(process.env.EVAL_JUDGE_THRESHOLD || 0.75);
const PROMPT_VERSION = 'grounded-v1.1';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const calibrate = argv.includes('--calibrate');
const labelsPath = arg('--labels', path.join(import.meta.dirname, '..', 'eval', 'labels', 'calibration-30.json'));
const inputPath = arg('--input', '');
const outPath = arg('--out', '');

const DIMENSIONS = [
  {
    key: 'correctness', weight: 0.40,
    anchor: '1=结论错误或答非所问; 3=大体正确但有小错或遗漏; 5=结论与关键事实全部正确',
  },
  {
    key: 'faithfulness', weight: 0.30,
    anchor: '1=编造事实或无来源断言; 3=大部分有依据但个别无来源; 5=每个事实性 claim 都有来源/依据，引用准确',
  },
  {
    key: 'instruction', weight: 0.20,
    anchor: '1=违反格式/语言/禁止项; 3=基本遵守但有轻微偏差; 5=完全遵守（格式、语言、字数、禁止动作）',
  },
  {
    key: 'conciseness', weight: 0.10,
    anchor: '1=冗长空洞或大量无关内容; 3=可用但啰嗦; 5=直接完整无废话',
  },
];

const systemPrompt = () => `You are an evaluation judge. Score the assistant answer on ${DIMENSIONS.length} dimensions using the anchors.
Rules:
1. Judge ONLY the answer against the task; do not judge the world.
2. For every dimension you MUST quote at least one evidence span copied VERBATIM from the answer.
3. If a quoted span does not appear verbatim in the answer, that dimension is invalid (score null).
4. Output STRICT JSON only, no markdown:
{"scores":{"correctness":1-5|null,"faithfulness":1-5|null,"instruction":1-5|null,"conciseness":1-5|null},
 "evidence":{"correctness":["..."],"faithfulness":["..."],"instruction":["..."],"conciseness":["..."]},
 "verdict":"pass"|"fail"|"uncertain"}
Prompt version: ${PROMPT_VERSION}. Anchors: ${DIMENSIONS.map((d) => `${d.key}: ${d.anchor}`).join(' | ')}`;

/* if judge model == agent model, someone is grading their own homework */
const judgeModelSafe = () => {
  if (AGENT_MODEL_BAN.has(JUDGE_MODEL)) {
    console.error(`REFUSING: judge model "${JUDGE_MODEL}" is also an agent model. Set EVAL_JUDGE_MODEL to a different model.`);
    process.exit(2);
  }
  return JUDGE_MODEL;
};

const promptHash = createHash('sha256').update(systemPrompt()).digest('hex').slice(0, 16);

const chat = async (payload) => {
  if (!CHAT_KEY) return { error: 'no CHAT_API_KEY' };
  const r = await fetch(`${N8N}/webhook/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAT_KEY}`,
      'Content-Type': 'application/json',
      'x-session-id': `judge-${Date.now().toString(36)}`,
      'x-client': 'eval',
    },
    body: JSON.stringify({ model: judgeModelSafe(), temperature: 0, messages: payload }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, content: body?.choices?.[0]?.message?.content || '', body };
};

const verifySpans = (evidence, answer) => {
  const text = String(answer || '');
  const bad = [];
  for (const [dim, spans] of Object.entries(evidence || {})) {
    for (const span of spans || []) {
      if (!text.includes(String(span))) bad.push({ dim, span });
    }
  }
  return bad;
};

const scoreOne = async ({ task, answer }) => {
  const res = await chat([
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: `## Task given to the assistant\n${task}\n\n## Assistant answer\n${answer}` },
  ]);
  if (res.error) return { status: 'pending', reason: res.error };
  let parsed;
  try {
    const raw = res.content.replace(/^```json\s*|```\s*$/g, '');
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'judge did not return parseable JSON', raw: res.content.slice(0, 500) };
  }
  const badSpans = verifySpans(parsed.evidence, answer);
  let weighted = 0; let used = 0;
  const detail = {};
  for (const d of DIMENSIONS) {
    const rawScore = parsed.scores?.[d.key];
    const hasBadSpan = badSpans.some((b) => b.dim === d.key);
    const invalid = rawScore === null || rawScore === undefined || hasBadSpan;
    detail[d.key] = {
      raw: invalid ? null : Number(rawScore),
      norm: invalid ? null : Number((((Number(rawScore) - 1) / 4)).toFixed(3)),
      weight: d.weight,
      invalid_reason: invalid ? (hasBadSpan ? 'evidence span not found verbatim' : 'null score') : null,
      evidence: (parsed.evidence?.[d.key] || []).slice(0, 3),
    };
    if (!invalid) { weighted += detail[d.key].norm * d.weight; used += d.weight; }
  }
  const score = used >= 0.6 ? Number((weighted / used).toFixed(3)) : null; // renormalize; need >=60% weight valid
  return {
    status: score === null ? 'insufficient' : (score >= THRESHOLD ? 'pass' : 'fail'),
    score,
    threshold: THRESHOLD,
    verdict_judge: parsed.verdict || null,
    dimensions: detail,
    invalid_spans: badSpans,
    judge_model: JUDGE_MODEL,
    prompt_version: PROMPT_VERSION,
    prompt_hash: promptHash,
  };
};

/* quadratic weighted kappa between judge numeric scores and human labels */
const quadraticWeightedKappa = (a, b) => {
  const cats = [1, 2, 3, 4, 5];
  const n = a.length;
  if (n === 0 || n !== b.length) return null;
  const O = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (let i = 0; i < n; i++) O[cats.indexOf(a[i])][cats.indexOf(b[i])]++;
  const w = Array.from({ length: 5 }, (_, i) => cats.map((_, j) => ((cats[i] - cats[j]) ** 2) / 16));
  const ha = Array(5).fill(0); const hb = Array(5).fill(0);
  for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { ha[i] += O[i][j]; hb[j] += O[i][j]; } }
  let observed = 0; let expected = 0;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    observed += w[i][j] * (O[i][j] / n);
    expected += w[i][j] * ((ha[i] / n) * (hb[j] / n));
  }
  return expected === 0 ? null : Number((1 - observed / expected).toFixed(3));
};

const runCalibration = async () => {
  if (!fs.existsSync(labelsPath)) {
    console.error(`labels file not found: ${labelsPath}`);
    console.error('Create it first: [{"id":"...","task":"...","answer":"...","human":1-5}, ...] (30 rows, stratified).');
    process.exit(2);
  }
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  if (!Array.isArray(labels) || labels.length < 20) {
    console.error(`need >= 20 labeled rows for a meaningful kappa (got ${labels.length})`);
    process.exit(2);
  }
  const out = [];
  const human = []; const judge = [];
  for (const row of labels) {
    const r = await scoreOne({ task: row.task, answer: row.answer });
    out.push({ id: row.id, human: row.human, judge_raw: r.dimensions ? Object.fromEntries(Object.entries(r.dimensions).map(([k, v]) => [k, v.raw])) : null, status: r.status, score: r.score ?? null });
    if (r.dimensions?.correctness?.raw !== null && r.dimensions?.correctness?.raw !== undefined && row.human >= 1) {
      human.push(Number(row.human)); judge.push(Number(r.dimensions.correctness.raw));
    }
    console.log(`${r.status.padEnd(6)} ${row.id} judge=${r.dimensions?.correctness?.raw ?? '-'} human=${row.human}`);
  }
  const kappa = quadraticWeightedKappa(human, judge);
  const agreement = human.length ? Number((human.filter((h, i) => h === judge[i]).length / human.length).toFixed(3)) : null;
  const summary = {
    calibration: labelsPath, n: labels.length, scored_pairs: human.length,
    quadratic_weighted_kappa: kappa,
    exact_agreement: agreement,
    gate: kappa !== null && kappa >= 0.7 ? 'PASS (kappa >= 0.70 — judge may enter release gate)' : 'FAIL (recalibrate rubric before release-gate use)',
    prompt_version: PROMPT_VERSION, prompt_hash: promptHash, judge_model: JUDGE_MODEL,
    rows: out,
  };
  console.log('\n=== CALIBRATION ===');
  console.log(JSON.stringify({ n: summary.n, scored_pairs: summary.scored_pairs, kappa: summary.quadratic_weighted_kappa, exact_agreement: summary.exact_agreement, gate: summary.gate }, null, 2));
  const outFile = outPath || labelsPath.replace(/\.json$/, `.judge-${Date.now().toString(36)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n');
  console.log(`saved -> ${outFile}`);
  process.exit(kappa !== null && kappa >= 0.7 ? 0 : 1);
};

const runScore = async () => {
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error('--input <file> required (JSON array of {id, task, answer})');
    process.exit(2);
  }
  const rowsData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const results = [];
  for (const row of rowsData) {
    const r = await scoreOne(row);
    results.push({ id: row.id || null, ...r });
    console.log(`${r.status.padEnd(6)} ${row.id || ''} score=${r.score ?? '-'}`);
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const summary = {
    scored: results.length,
    pass: passed,
    fail: results.filter((r) => r.status === 'fail').length,
    pending_or_invalid: results.filter((r) => !['pass', 'fail'].includes(r.status)).length,
    mean_score: (() => {
      const nums = results.map((r) => r.score).filter((n) => n !== null);
      return nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3)) : null;
    })(),
    threshold: THRESHOLD, judge_model: JUDGE_MODEL, prompt_version: PROMPT_VERSION, prompt_hash: promptHash,
  };
  const outFile = outPath || inputPath.replace(/\.json$/, `.judged-${Date.now().toString(36)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`saved -> ${outFile}`);
};

if (calibrate) await runCalibration(); else await runScore();
