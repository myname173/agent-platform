#!/usr/bin/env node
/**
 * Frozen-corpus retrieval regression: 5 docs, 40 answerable + 10 refusal cases.
 * These texts are NOT a statement of current production architecture.
 * New gate: hit@1 >=0.80 over ANSWERABLE cases only. hit@5 is diagnostic
 * (returning all 5 docs makes it trivial); MRR is retained over the top 5.
 * Refusal cases are pending/not tested: no answer generation or refusal metric.
 *
 * Live use requires --isolated-stack, an explicit operator confirmation that
 * DB/embedding settings target a disposable test environment, not shared KB.
 * This flag is a confirmation, not automatic isolation/provisioning.
 * Optional --hybrid selects BM25+vector RRF retrieval (the production hybrid
 * path); without it the run is vector-only. Optional --rerank adds the
 * cross-encoder rerank stage on top of whichever retrieval ran (the production
 * KB_RERANK_ENABLED path). The flags are orthogonal and order-independent. All
 * go through the same canonical helper the workflow Code nodes embed, so the
 * ruler measures production code. If pg_search/the bm25 index is absent,
 * --hybrid degrades to vector; if the rerank key/endpoint is missing or the API
 * errors, --rerank fails open to the pre-rerank order. Either way the report's
 * retrieval_mode shows what actually ran against requested_mode (e.g. 'vector'
 * vs 'hybrid+rerank'), so a silent no-op is visible. --rerank is the ruler's
 * explicit toggle, independent of the production KB_RERANK_ENABLED env switch.
 * Optional --crag adds the CRAG-lite graded corrective stage on top: it grades
 * the retrieved evidence (cosine three-band) and, only if KB_CRAG_WEB_FALLBACK is
 * on, appends a bounded web supplement. --crag records grade distribution +
 * web-trigger rate in a separate `crag` report object; it does NOT change the
 * title-based hit@1/MRR ranking (the web supplement has no KB title and must not
 * pollute it). The kb-eval ruler cannot measure CRAG's answer-quality benefit —
 * that is the agent answer-eval. A zero web-trigger rate with web fallback off is
 * expected (grade-only); with it on, it means the grade never fired.
 * pg is loaded only inside main; imports and pure metric tests require no pg.
 * No .env is loaded. Reports default to the project root .eval-local/judge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { hybridKbSearch, rerankKbRows, cragLiteKbRows } from '../lib/kb-hybrid.mjs';

export const HIT_AT_1_THRESHOLD = 0.80;

/** Pure flag parser. Live eval needs --isolated-stack; --hybrid and --rerank are
 *  optional, orthogonal and order-independent. Rejects unknown flags, duplicates,
 *  and any other shape. Exported so the guard is testable without touching
 *  env/files/network. */
export function parseEvalFlags(argv) {
  const allowed = new Set(['--isolated-stack', '--hybrid', '--rerank', '--crag']);
  const ok = Array.isArray(argv) && argv.length >= 1 && argv.length <= 4
    && argv.includes('--isolated-stack')
    && argv.every((a) => allowed.has(a))
    && new Set(argv).size === argv.length;
  return { ok, hybrid: ok && argv.includes('--hybrid'), rerank: ok && argv.includes('--rerank'), crag: ok && argv.includes('--crag') };
}
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const round = (value) => Number(value.toFixed(3));

function acceptedTitles(row) {
  if (!isText(row?.q)) throw new Error('every case requires a nonempty question');
  if (row.expect_title === null) return null;
  if (!isText(row.expect_title)) throw new Error('expect_title must be a nonempty title or explicit null');
  if (row.accept_titles !== undefined && (!Array.isArray(row.accept_titles) || !row.accept_titles.length || !row.accept_titles.every(isText))) {
    throw new Error('accept_titles must be a nonempty array of titles');
  }
  return [...new Set([row.expect_title, ...(row.accept_titles ?? [])])];
}

/** Pure metrics. rankings[i] is the retrieved title list; null rows need no ranking. */
export function evaluateRetrieval(cases, rankings) {
  if (!Array.isArray(cases) || !cases.length || !Array.isArray(rankings) || rankings.length !== cases.length) {
    throw new Error('nonempty cases and aligned rankings required');
  }
  let answerable = 0;
  let hit1 = 0;
  let hit5 = 0;
  let reciprocalRanks = 0;
  const detail = cases.map((row, i) => {
    const accepted = acceptedTitles(row);
    if (accepted === null) return { q: row.q, status: 'pending', evaluation: 'refusal', reason: 'answer/refusal not tested' };
    const ranking = rankings[i];
    if (!Array.isArray(ranking) || !ranking.every(isText)) throw new Error(`missing or invalid retrieval ranking at case ${i}`);
    answerable++;
    const index = ranking.slice(0, 5).findIndex((title) => accepted.includes(title));
    const rank = index < 0 ? null : index + 1;
    if (rank === 1) hit1++;
    if (rank !== null) { hit5++; reciprocalRanks += 1 / rank; }
    return { q: row.q, status: 'tested', evaluation: 'retrieval', hit_at_1: rank === 1 ? 1 : 0, hit_at_5: rank !== null ? 1 : 0, rank, top1: ranking[0] ?? null };
  });
  if (answerable === 0) throw new Error('at least one answerable retrieval case required');
  return {
    cases: cases.length,
    answerable_cases: answerable,
    retrieval_tested: answerable,
    refusal: { status: 'pending', cases: cases.length - answerable, tested: 0, correctness: null, reason: 'No answer generation/refusal evaluation performed' },
    hit_at_1: round(hit1 / answerable),
    hit_at_5: round(hit5 / answerable),
    mrr: round(reciprocalRanks / answerable),
    gate: {
      metric: 'hit_at_1', threshold: HIT_AT_1_THRESHOLD,
      status: hit1 / answerable >= HIT_AT_1_THRESHOLD ? 'PASS' : 'FAIL',
    },
    metric_note: 'hit@1 >=0.80 is the new retrieval gate; hit@5 is diagnostic only (5-document corpus); MRR uses top-5 ranks. Null expectations are excluded from all retrieval denominators.',
    scope: 'Frozen-corpus retrieval regression only, not current platform architecture, answer correctness, or refusal capability.',
    detail,
  };
}

export function validateGoldenSet(gs) {
  if (!Array.isArray(gs?.docs) || !gs.docs.length || !Array.isArray(gs.cases) || !gs.cases.length) throw new Error('nonempty golden docs and cases required');
  const titles = new Set();
  for (const doc of gs.docs) {
    if (!isText(doc?.title) || !isText(doc?.text) || titles.has(doc.title)) throw new Error('golden docs require unique nonempty titles and nonempty text');
    titles.add(doc.title);
  }
  let answerable = 0;
  for (const row of gs.cases) {
    const accepted = acceptedTitles(row);
    if (accepted === null) continue;
    answerable++;
    if (accepted.some((title) => !titles.has(title))) throw new Error('expected titles must exist in the frozen corpus');
  }
  if (!answerable) throw new Error('at least one answerable retrieval case required');
  return gs;
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, error = console.error } = {}) {
  // MUST run before reading any config/input, loading pg, connecting, or embedding.
  const { ok, hybrid, rerank, crag } = parseEvalFlags(argv);
  if (!ok) {
    error('SETUP ERROR: live KB evaluation requires explicit --isolated-stack confirmation of a disposable test environment; it writes KB data and consumes embeddings. Shared KB must not be used. Optional --hybrid selects BM25+vector RRF retrieval (default vector-only); optional --rerank adds the cross-encoder rerank stage (fails open to the pre-rerank order); optional --crag adds graded corrective retrieval (grade distribution + web-trigger stats only, no ranking change).');
    return 2;
  }
  let pg;
  try {
    const key = (env.DASHSCOPE_API_KEY || '').trim();
    if (!key) { error('SETUP ERROR: DASHSCOPE_API_KEY required for isolated-stack evaluation'); return 2; }
    const gs = validateGoldenSet(JSON.parse(fs.readFileSync(env.KB_GOLDEN || '/tmp/golden-set.json', 'utf8')));
    const { Client } = createRequire(import.meta.url)('pg');
    pg = new Client({
      host: env.DB_POSTGRESDB_HOST || 'postgres',
      port: Number(env.DB_POSTGRESDB_PORT || 5432),
      database: env.DB_POSTGRESDB_DATABASE || 'n8n',
      user: env.DB_POSTGRESDB_USER || 'n8n',
      password: env.DB_POSTGRESDB_PASSWORD,
    });
    await pg.connect();
    const embed = async (text, type) => {
      const resp = await fetch(DASHSCOPE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.7-text-embedding-flash',
          input: { texts: [text] },
          parameters: {
            dimension: 1024, text_type: type, output_type: 'dense',
            ...(type === 'query' ? { instruct: 'Given a user question about internal documents, retrieve the most relevant passages' } : {}),
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!resp.ok) throw new Error(`embed failed: HTTP ${resp.status}`);
      const embedding = (await resp.json()).output?.embeddings?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length !== 1024 || !embedding.every(Number.isFinite)) throw new Error('invalid embedding response');
      return '[' + embedding.join(',') + ']';
    };

    // Node-side stand-in for n8n's this.helpers.httpRequest: same contract the
    // canonical rerankKbRows / cragLiteKbRows expect ({method,url,headers,body,qs,
    // timeout} -> parsed JSON). Handles rerank (POST + JSON body) and the CRAG web
    // supplement (GET + qs query string). Non-2xx throws, which both helpers catch
    // and fail open. This keeps the ruler on the exact production code path, not a
    // reimplementation.
    const httpRequest = async ({ method, url, headers, body, qs, timeout }) => {
      let target = url;
      if (qs && typeof qs === 'object') {
        const u = new URL(url);
        for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, String(v));
        target = u.toString();
      }
      const resp = await fetch(target, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(Number(timeout) || 15000),
      });
      if (!resp.ok) throw new Error(`http failed: HTTP ${resp.status}`);
      return resp.json();
    };

    const docIds = [];
    for (const doc of gs.docs) {
      const sha = createHash('sha256').update(doc.text).digest('hex');
      const docId = 'kb-' + sha.slice(0, 16);
      docIds.push(docId);
      const exists = await pg.query('SELECT content_sha FROM kb_documents WHERE doc_id = $1', [docId]);
      if (exists.rows.length && exists.rows[0].content_sha === sha) continue;
      log('ingesting frozen doc:', doc.title);
      const embedding = await embed(doc.text, 'document');
      await pg.query('BEGIN');
      try {
        await pg.query(
          `INSERT INTO kb_documents (doc_id, title, source_type, source_ref, content_sha, status)
           VALUES ($1,$2,'text','golden-set',$3,'active')
           ON CONFLICT (doc_id) DO UPDATE SET status='active', updated_at=now()`,
          [docId, doc.title, sha],
        );
        await pg.query('DELETE FROM kb_chunks WHERE doc_id = $1', [docId]);
        await pg.query('INSERT INTO kb_chunks (doc_id, seq, content, embedding) VALUES ($1,0,$2,$3::vector)', [docId, doc.text, embedding]);
        await pg.query('COMMIT');
      } catch (cause) {
        await pg.query('ROLLBACK');
        throw cause;
      }
    }

    const rankings = [];
    const seenModes = new Set();
    const cragStats = crag ? { web_fallback_enabled: String(env.KB_CRAG_WEB_FALLBACK || '').toLowerCase() === 'true', graded: 0, correct: 0, incorrect: 0, ambiguous: 0, web_triggered: 0 } : null;
    for (const [index, row] of gs.cases.entries()) {
      if (row.expect_title === null) {
        rankings.push(null);
        log(`PENDING refusal case ${index + 1}: not tested`);
        continue; // No embedding/retrieval: that cannot test answer refusal.
      }
      const vector = await embed(row.q, 'query');
      // Same canonical helper the workflow Code nodes embed. docIds restricts to
      // the frozen corpus; k=5 matches the ruler's top-5 cutoff. In vector mode
      // this reproduces the previous cosine ordering exactly; in hybrid mode it
      // fuses BM25 + vector with RRF. retrieval reports what actually ran.
      let { rows, retrieval } = await hybridKbSearch(pg, JSON.parse(vector), row.q, 5, { docIds });
      if (rerank) {
        // Same canonical rerank the Code nodes run; env config is shared with
        // production (KB_RERANK_MODEL/URL/TOP_N/INSTRUCT). Fails open to the
        // pre-rerank order, so retrieval_mode reveals whether rerank truly ran.
        const rr = await rerankKbRows(httpRequest,
          { apiKey: key, model: env.KB_RERANK_MODEL, endpoint: env.KB_RERANK_URL, instruct: env.KB_RERANK_INSTRUCT },
          row.q, rows, Number(env.KB_RERANK_TOP_N) || 5, retrieval);
        rows = rr.rows; retrieval = rr.retrieval;
      }
      if (crag) {
        // Same canonical CRAG-lite the Code nodes run; env config shared with
        // production (KB_CRAG_*). Grades the evidence and (only if web fallback is
        // on) appends a bounded supplement. KB rows are kept unchanged, so the
        // title ranking below is unaffected — we only tally grade/trigger stats.
        const cr = await cragLiteKbRows(httpRequest,
          { low: env.KB_CRAG_LOW_THRESHOLD, high: env.KB_CRAG_HIGH_THRESHOLD, webFallback: env.KB_CRAG_WEB_FALLBACK },
          row.q, rows, retrieval,
          { endpoint: env.KB_CRAG_WEB_URL, topN: env.KB_CRAG_WEB_TOP_N, timeoutMs: env.KB_CRAG_WEB_TIMEOUT_MS });
        cragStats.graded++;
        cragStats[cr.crag.grade]++;
        if (cr.crag.action === 'web') cragStats.web_triggered++;
      }
      seenModes.add(retrieval);
      rankings.push(rows.map((r) => r.title));
      log(`TESTED retrieval case ${index + 1} (${retrieval})`);
    }
    const report = {
      ...evaluateRetrieval(gs.cases, rankings),
      requested_mode: (hybrid ? 'hybrid' : 'vector') + (rerank ? '+rerank' : ''),
      retrieval_mode: [...seenModes].sort().join('+') || 'vector',
      ...(cragStats ? { crag: cragStats } : {}),
      ran_at: new Date().toISOString(),
    };
    const { detail, ...summary } = report;
    log(JSON.stringify(summary, null, 2));
    const outFile = path.join(PROJECT_ROOT, '.eval-local', 'judge', `kb-${Date.now().toString(36)}.json`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
    log(`saved -> ${outFile}`);
    return report.gate.status === 'PASS' ? 0 : 1;
  } catch (cause) {
    error('EVAL FAILED:', cause.message);
    return 1;
  } finally {
    if (pg) await pg.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
