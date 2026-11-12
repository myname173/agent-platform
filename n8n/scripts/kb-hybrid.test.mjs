import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rrfFuse, bm25Available, hybridKbSearch, rerankKbRows, gradeKbEvidence, cragLiteKbRows, KB_BM25_PROBE_SQL, kbVectorSql, kbBm25Sql, KB_RERANK_URL, KB_RERANK_MAX_ITEM_CHARS, KB_CRAG_WEB_URL, KB_CRAG_LOW_THRESHOLD, KB_CRAG_HIGH_THRESHOLD, KB_CRAG_WEB_TIMEOUT_MS, KB_CRAG_WEB_TOP_N } from '../lib/kb-hybrid.mjs';

// Offline contracts only: pure functions + a mock pg client + a mock httpRequest.
// No database, no embeddings, no rerank API, no network. Live hybrid/rerank
// efficacy (hit@1/MRR before/after) is operator-run on the deployment machine via
// kb-eval.mjs --isolated-stack [--hybrid] [--rerank]; offline green is not
// retrieval acceptance.

// ---------------- rrfFuse ----------------
test('rrfFuse sums reciprocal ranks across legs and dedups by chunk_id', () => {
  const a = [{ chunk_id: 1, title: 'A' }, { chunk_id: 2, title: 'B' }];
  const b = [{ chunk_id: 2, title: 'B' }, { chunk_id: 3, title: 'C' }];
  const out = rrfFuse([a, b], 60, 10);
  assert.equal(out.length, 3);
  assert.equal(out[0].row.chunk_id, 2, 'chunk in both legs must rank first');
  const s2 = out.find((o) => o.row.chunk_id === 2).score;
  assert.ok(Math.abs(s2 - (1 / 62 + 1 / 61)) < 1e-12);
  assert.ok(out.find((o) => o.row.chunk_id === 1).score > out.find((o) => o.row.chunk_id === 3).score);
});

test('rrfFuse keeps the first-seen row on ties and respects limit', () => {
  const out = rrfFuse([[{ chunk_id: 1, src: 'vec' }], [{ chunk_id: 1, src: 'bm' }]], 60, 10);
  assert.equal(out.length, 1);
  assert.equal(out[0].row.src, 'vec', 'vector leg (lists[0]) wins ties');
  const many = Array.from({ length: 5 }, (_, i) => [{ chunk_id: i }]);
  assert.equal(rrfFuse(many, 60, 2).length, 2);
});

test('rrfFuse negative controls: empty/invalid lists, missing chunk_id, defaults', () => {
  assert.deepEqual(rrfFuse([], 60, 10), []);
  assert.deepEqual(rrfFuse([[], []], 60, 10), []);
  assert.deepEqual(rrfFuse(null, 60, 10), []);
  assert.deepEqual(rrfFuse([[{ title: 'no id' }]], 60, 10), []);
  assert.deepEqual(rrfFuse([[null, { chunk_id: 0 }]], 60, 10).map((o) => o.row.chunk_id), [0], 'chunk_id 0 is valid');
  const out = rrfFuse([[{ chunk_id: 1 }]]);
  assert.ok(Math.abs(out[0].score - 1 / 61) < 1e-12, 'k defaults to 60');
});

// ---------------- bm25Available ----------------
test('bm25Available requires ext>0 AND idx AND fn>0 AND op>0', () => {
  const good = { ext: 1, idx: 'kb_chunks_bm25', fn: 1, op: 5 };
  assert.equal(bm25Available(good), true);
  for (const bad of [null, undefined, {}]) assert.equal(bm25Available(bad), false);
  for (const key of ['ext', 'fn', 'op']) assert.equal(bm25Available({ ...good, [key]: 0 }), false, key + '=0 disables');
  assert.equal(bm25Available({ ...good, idx: null }), false);
  assert.equal(bm25Available({ ...good, idx: '' }), false);
  assert.equal(bm25Available({ ext: '1', idx: 'kb_chunks_bm25', fn: '1', op: '5' }), true, 'pg count() strings accepted');
});

// ---------------- hybridKbSearch (mock pg) ----------------
function mockPg({ probe, vecRows = [], bmRows = [] }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('pg_extension') && sql.includes('kb_chunks_bm25')) return { rows: [probe] };
      if (sql.includes('pdb.score')) return { rows: bmRows };
      if (sql.includes('<=>')) return { rows: vecRows };
      throw new Error('unexpected SQL in mock: ' + sql);
    },
  };
}
const vrow = (id, score, title) => ({ chunk_id: id, content: 'c' + id, seq: 0, title: title || 'T' + id, doc_id: 'd' + id, score });
const GOOD_PROBE = { ext: 1, idx: 'kb_chunks_bm25', fn: 1, op: 5 };

test('hybridKbSearch runs both legs and RRF-fuses when bm25 is available', async () => {
  const pg = mockPg({ probe: GOOD_PROBE, vecRows: [vrow(1, 0.9), vrow(2, 0.8)], bmRows: [vrow(2, 5.0), vrow(3, 4.0)] });
  const { rows, retrieval } = await hybridKbSearch(pg, [0.1, 0.2], '检索', 6);
  assert.equal(retrieval, 'hybrid');
  assert.equal(pg.calls.length, 3, 'vector + probe + bm25');
  assert.ok(pg.calls.some((c) => c.sql.includes('pdb.score')));
  assert.equal(rows[0].chunk_id, 2);
  assert.ok(rows[0].score > rows.find((r) => r.chunk_id === 1).score);
  assert.equal(rows.find((r) => r.chunk_id === 1).vectorScore, 0.9, 'cosine preserved from vector leg');
  assert.equal(rows.find((r) => r.chunk_id === 3).vectorScore, null, 'bm25-only hit has null cosine');
});

test('hybridKbSearch degrades to vector-only and NEVER issues BM25 when probe fails', async () => {
  const probes = [null, { ext: 0, idx: 'kb_chunks_bm25', fn: 1, op: 5 }, { ...GOOD_PROBE, idx: null }, { ...GOOD_PROBE, fn: 0 }, { ...GOOD_PROBE, op: 0 }];
  for (const probe of probes) {
    const pg = mockPg({ probe, vecRows: [vrow(1, 0.9), vrow(2, 0.8), vrow(3, 0.7)] });
    const { rows, retrieval } = await hybridKbSearch(pg, [0.1], '检索', 2);
    assert.equal(retrieval, 'vector');
    assert.equal(pg.calls.length, 2, 'vector + probe only');
    assert.ok(!pg.calls.some((c) => c.sql.includes('pdb.score')), 'BM25 must not run when unavailable');
    assert.ok(!pg.calls.some((c) => c.sql.includes('||| $1')), '||| operator must not run when unavailable');
    assert.deepEqual(rows.map((r) => r.chunk_id), [1, 2], 'cosine order preserved, sliced to k');
    assert.equal(rows[0].score, 0.9, 'score === cosine in vector mode');
    assert.equal(rows[0].vectorScore, 0.9);
  }
});

test('hybridKbSearch degrades to vector when query is empty even if bm25 available', async () => {
  const pg = mockPg({ probe: GOOD_PROBE, vecRows: [vrow(1, 0.9)] });
  const { retrieval } = await hybridKbSearch(pg, [0.1], '   ', 6);
  assert.equal(retrieval, 'vector');
  assert.ok(!pg.calls.some((c) => c.sql.includes('pdb.score')));
});

test('hybridKbSearch docIds whitelist adds ANY($3) to both legs, query stays parameterized', async () => {
  const pg = mockPg({ probe: GOOD_PROBE, vecRows: [vrow(1, 0.9)], bmRows: [vrow(1, 5)] });
  await hybridKbSearch(pg, [0.1], '检索', 5, { docIds: ['d1', 'd2'] });
  const vec = pg.calls.find((c) => c.sql.includes('<=>'));
  const bm = pg.calls.find((c) => c.sql.includes('pdb.score'));
  assert.ok(vec.sql.includes('ANY($3::text[])') && bm.sql.includes('ANY($3::text[])'));
  assert.deepEqual(vec.params[2], ['d1', 'd2']);
  assert.deepEqual(bm.params[2], ['d1', 'd2']);
  assert.equal(bm.params[0], '检索', 'query text is a bound parameter, never interpolated');
});

test('hybridKbSearch without docIds omits the whitelist clause', async () => {
  const pg = mockPg({ probe: GOOD_PROBE, vecRows: [vrow(1, 0.9)], bmRows: [] });
  await hybridKbSearch(pg, [0.1], '检索', 5);
  for (const c of pg.calls) assert.ok(!c.sql.includes('ANY($3'));
});

test('hybridKbSearch clamps k to 1..10 and the fusion pool to 3x (cap 50)', async () => {
  const pg = mockPg({ probe: { ext: 0 }, vecRows: [] });
  await hybridKbSearch(pg, [0.1], 'q', 999);
  assert.equal(pg.calls.find((c) => c.sql.includes('<=>')).params[1], 30, 'k=10 -> pool 30');
  const pg2 = mockPg({ probe: { ext: 0 }, vecRows: [] });
  await hybridKbSearch(pg2, [0.1], 'q', 0);
  assert.equal(pg2.calls.find((c) => c.sql.includes('<=>')).params[1], 20, 'k=0 -> default 6 -> pool 20');
});

// ---------------- rerankKbRows (mock httpRequest) ----------------
// Captures the request and returns a canned response (or throws). No network,
// no real rerank API. The fail-open degrade is the central safety property.
function mockHttp(response, { throws = false } = {}) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    if (throws) throw new Error('simulated rerank API failure');
    return typeof response === 'function' ? response(req) : response;
  };
  fn.calls = calls;
  return fn;
}
const rrow = (id, score) => ({ chunk_id: id, content: 'content-' + id, seq: id, title: 'T' + id, doc_id: 'd' + id, score, vectorScore: score });
const okResponse = (results) => ({ output: { results }, usage: { total_tokens: 10 }, request_id: 'req-1' });
const CFG = { apiKey: 'test-key' };

test('rerankKbRows sends the DashScope text-rerank contract and maps results back by index', async () => {
  const rows = [rrow(0, 0.9), rrow(1, 0.8), rrow(2, 0.7)];
  const http = mockHttp(okResponse([{ index: 2, relevance_score: 0.95 }, { index: 0, relevance_score: 0.6 }, { index: 1, relevance_score: 0.2 }]));
  const out = await rerankKbRows(http, CFG, '检索 query', rows, 3, 'hybrid');
  assert.equal(http.calls.length, 1);
  const req = http.calls[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, KB_RERANK_URL, 'default classic endpoint');
  assert.equal(req.headers.Authorization, 'Bearer test-key');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.body.model, 'qwen3-rerank', 'default model');
  assert.equal(req.body.input.query, '检索 query');
  assert.deepEqual(req.body.input.documents, ['content-0', 'content-1', 'content-2']);
  assert.equal(req.body.parameters.top_n, 3);
  assert.equal(req.body.parameters.return_documents, false);
  assert.equal(req.body.parameters.instruct, undefined, 'no instruct unless configured');
  assert.equal(req.timeout, 15000, 'default timeout');
  assert.deepEqual(out.rows.map((r) => r.chunk_id), [2, 0, 1], 'reordered by relevance, not by index');
  assert.deepEqual(out.rows.map((r) => r.score), [0.95, 0.6, 0.2], 'score becomes relevance_score');
  assert.deepEqual(out.rows.map((r) => r.rerankScore), [0.95, 0.6, 0.2]);
  assert.deepEqual(out.rows.map((r) => r.prevScore), [0.7, 0.9, 0.8], 'pre-rerank score kept per row');
  assert.deepEqual(out.rows.map((r) => r.vectorScore), [0.7, 0.9, 0.8], 'cosine provenance preserved');
  assert.equal(out.rows[0].title, 'T2');
  assert.equal(out.retrieval, 'hybrid+rerank');
  assert.equal(out.reranked, true);
});

test('rerankKbRows honors cfg model/endpoint/instruct/timeout overrides', async () => {
  const http = mockHttp(okResponse([{ index: 0, relevance_score: 0.9 }]));
  await rerankKbRows(http, { apiKey: 'k', model: 'gte-rerank-v2', endpoint: 'https://ws.example/rerank', instruct: 'rank by relevance', timeoutMs: 5000 }, 'q', [rrow(0, 0.5)], 1, 'vector');
  const req = http.calls[0];
  assert.equal(req.url, 'https://ws.example/rerank');
  assert.equal(req.body.model, 'gte-rerank-v2');
  assert.equal(req.body.parameters.instruct, 'rank by relevance');
  assert.equal(req.timeout, 5000);
});

test('rerankKbRows clamps top_n to 1..rows.length and slices the mapped output', async () => {
  const rows = [rrow(0, 0.9), rrow(1, 0.8), rrow(2, 0.7)];
  const all = okResponse([{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.8 }, { index: 2, relevance_score: 0.7 }]);
  const big = mockHttp(all);
  const outBig = await rerankKbRows(big, CFG, 'q', rows, 99, 'vector');
  assert.equal(big.calls[0].body.parameters.top_n, 3, 'topN capped at rows.length');
  assert.equal(outBig.rows.length, 3);
  const zero = mockHttp(all);
  await rerankKbRows(zero, CFG, 'q', rows, 0, 'vector');
  assert.equal(zero.calls[0].body.parameters.top_n, 3, 'topN 0 -> rows.length');
  const neg = mockHttp(all);
  const outNeg = await rerankKbRows(neg, CFG, 'q', rows, -5, 'vector');
  assert.equal(neg.calls[0].body.parameters.top_n, 1, 'negative topN -> 1');
  assert.equal(outNeg.rows.length, 1, 'output sliced to cap even if API returns more');
  const two = mockHttp(all);
  const outTwo = await rerankKbRows(two, CFG, 'q', rows, 2, 'vector');
  assert.equal(two.calls[0].body.parameters.top_n, 2);
  assert.equal(outTwo.rows.length, 2);
});

test('rerankKbRows clamps oversized query/documents to KB_RERANK_MAX_ITEM_CHARS (API rejects, never truncates)', async () => {
  const long = 'x'.repeat(KB_RERANK_MAX_ITEM_CHARS + 500);
  const http = mockHttp(okResponse([{ index: 0, relevance_score: 0.9 }]));
  await rerankKbRows(http, CFG, long, [{ chunk_id: 0, content: long, score: 0.5 }], 1, 'vector');
  assert.equal(http.calls[0].body.input.documents[0].length, KB_RERANK_MAX_ITEM_CHARS);
  assert.equal(http.calls[0].body.input.query.length, KB_RERANK_MAX_ITEM_CHARS);
  const short = mockHttp(okResponse([{ index: 0, relevance_score: 0.9 }]));
  await rerankKbRows(short, CFG, 'q', [rrow(0, 0.5)], 1, 'vector');
  assert.equal(short.calls[0].body.input.documents[0], 'content-0', 'short content untouched');
});

test('rerankKbRows skips out-of-range indices but keeps valid ones (partial map)', async () => {
  const rows = [rrow(0, 0.9), rrow(1, 0.8)];
  const http = mockHttp(okResponse([{ index: 5, relevance_score: 0.99 }, { index: 1, relevance_score: 0.7 }, { index: 0, relevance_score: 0.3 }]));
  const out = await rerankKbRows(http, CFG, 'q', rows, 2, 'vector');
  assert.deepEqual(out.rows.map((r) => r.chunk_id), [1, 0], 'invalid index 5 skipped, valid kept in API order');
  assert.equal(out.reranked, true);
});

test('rerankKbRows accepts a JSON-string response (httpRequest may return text)', async () => {
  const rows = [rrow(0, 0.5), rrow(1, 0.4)];
  const http = mockHttp(JSON.stringify(okResponse([{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }])));
  const out = await rerankKbRows(http, CFG, 'q', rows, 2, 'vector');
  assert.deepEqual(out.rows.map((r) => r.chunk_id), [1, 0]);
  assert.equal(out.reranked, true);
});

test('rerankKbRows FAILS OPEN: API throw / bad shape keep the pre-rerank order, never throw', async () => {
  const rows = [rrow(0, 0.9), rrow(1, 0.8), rrow(2, 0.7)];
  const badResponses = [
    null, undefined, {}, { output: null }, { output: {} }, { output: { results: null } },
    { output: { results: [] } }, { output: { results: 'nope' } }, 'not-json',
    { output: { results: [{ index: 99, relevance_score: 0.9 }] } },
    { output: { results: [{ index: -1, relevance_score: 0.9 }] } },
    { output: { results: [{ index: 1.5, relevance_score: 0.9 }] } },
    { output: { results: [{ index: 'x', relevance_score: 0.9 }] } },
    { output: { results: [{ relevance_score: 0.9 }] } },
  ];
  for (const resp of badResponses) {
    const http = mockHttp(resp);
    const out = await rerankKbRows(http, CFG, 'q', rows, 3, 'hybrid');
    assert.equal(http.calls.length, 1, 'a real attempt was made before degrading');
    assert.equal(out.rows, rows, 'same array reference, no mutation, for ' + JSON.stringify(resp));
    assert.deepEqual(out.rows.map((r) => r.chunk_id), [0, 1, 2]);
    assert.equal(out.reranked, false);
    assert.equal(out.retrieval, 'hybrid', 'prev retrieval preserved');
  }
  const thrower = mockHttp(null, { throws: true });
  const out = await rerankKbRows(thrower, CFG, 'q', rows, 3, 'vector');
  assert.equal(thrower.calls.length, 1);
  assert.equal(out.rows, rows);
  assert.equal(out.reranked, false);
  assert.equal(out.retrieval, 'vector');
});

test('rerankKbRows skips without any HTTP call when key/rows/query/httpRequest is missing', async () => {
  const rows = [rrow(0, 0.9)];
  const preconditions = [
    [{ apiKey: '' }, 'q', rows], [{ apiKey: '   ' }, 'q', rows], [{ apiKey: null }, 'q', rows], [{}, 'q', rows],
    [CFG, '', rows], [CFG, '   ', rows], [CFG, null, rows],
    [CFG, 'q', []], [CFG, 'q', null], [CFG, 'q', 'not-array'],
  ];
  for (const [cfg, query, rws] of preconditions) {
    const http = mockHttp(okResponse([{ index: 0, relevance_score: 0.9 }]));
    const out = await rerankKbRows(http, cfg, query, rws, 1, 'hybrid');
    assert.equal(http.calls.length, 0, 'no HTTP call for ' + JSON.stringify([cfg, query, rws]));
    assert.equal(out.reranked, false);
    assert.equal(out.retrieval, 'hybrid');
    assert.deepEqual(out.rows, Array.isArray(rws) ? rws : []);
  }
  for (const notFn of [null, undefined, {}, 'str']) {
    const out = await rerankKbRows(notFn, CFG, 'q', rows, 1, 'vector');
    assert.equal(out.reranked, false);
    assert.equal(out.rows, rows);
    assert.equal(out.retrieval, 'vector');
  }
});

test('rerankKbRows retrieval chain: prev defaults to vector, success appends +rerank', async () => {
  const rows = [rrow(0, 0.5)];
  const resp = okResponse([{ index: 0, relevance_score: 0.9 }]);
  assert.equal((await rerankKbRows(mockHttp(resp), CFG, 'q', rows, 1, undefined)).retrieval, 'vector+rerank');
  assert.equal((await rerankKbRows(mockHttp(resp), CFG, 'q', rows, 1, 'vector')).retrieval, 'vector+rerank');
  assert.equal((await rerankKbRows(mockHttp(resp), CFG, 'q', rows, 1, 'hybrid')).retrieval, 'hybrid+rerank');
});

// ---------------- SQL builders ----------------
test('SQL builders are parameterized, select chunk_id, and keep active filter', () => {
  for (const withDocs of [false, true]) {
    const v = kbVectorSql(withDocs); const b = kbBm25Sql(withDocs);
    assert.ok(v.includes('c.chunk_id') && v.includes('$1::vector') && v.includes('LIMIT $2'));
    assert.ok(b.includes('c.chunk_id') && b.includes('||| $1') && b.includes('pdb.score(c.chunk_id)') && b.includes('LIMIT $2'));
    assert.equal(v.includes('ANY($3::text[])'), withDocs);
    assert.equal(b.includes('ANY($3::text[])'), withDocs);
    assert.ok(v.includes("d.status = 'active'") && b.includes("d.status = 'active'"));
  }
  assert.ok(KB_BM25_PROBE_SQL.includes('pg_extension') && KB_BM25_PROBE_SQL.includes('to_regclass')
    && KB_BM25_PROBE_SQL.includes('pg_proc') && KB_BM25_PROBE_SQL.includes('pg_operator'), 'probe is catalog-only (error-safe)');
});

// ---------------- embedded-helper drift guard ----------------
const modText = fs.readFileSync(new URL('../lib/kb-hybrid.mjs', import.meta.url), 'utf8');
const B = '// >>> KB-HYBRID-EMBED-BEGIN'; const E = '// <<< KB-HYBRID-EMBED-END';
const region = modText.slice(modText.indexOf(B), modText.indexOf(E) + E.length);
const NODES = [['../workflows/chat-gateway.json', 'Execute Tool'], ['../workflows/kb-ingest.json', 'Run KB Ops'], ['../workflows/mcp-server.json', 'Do MCP']];
const codeOf = (file, node) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8')).nodes.find((n) => n.name === node).parameters.jsCode;

test('all three Code nodes embed the canonical helper verbatim and keep the docs/chunks probe', () => {
  assert.ok(region.length > 1000 && region.includes('function hybridKbSearch') && region.includes('function rerankKbRows'));
  for (const [file, node] of NODES) {
    const code = codeOf(file, node);
    assert.ok(code.includes(region), file + ' :: ' + node + ' helper drifted from canonical module');
    assert.ok(code.includes('hybridKbSearch('), file + ' does not call hybridKbSearch');
    assert.ok(code.includes('rerankKbRows('), file + ' does not call rerankKbRows');
    assert.ok(code.includes("to_regclass('public.kb_documents')") && code.includes("to_regclass('public.kb_chunks')"), file + ' lost the §9.13 docs/chunks probe');
  }
});

test('drift guard is discriminating: a mutated helper would NOT match', () => {
  const mutated = region.replace('1 / (kk + rank + 1)', '1 / (kk + rank + 2)');
  assert.notEqual(mutated, region);
  for (const [file, node] of NODES) assert.ok(!codeOf(file, node).includes(mutated), 'guard must reject a mutated helper');
});

test('rerank drift guard is discriminating: a silent-no-op mutation would NOT match', () => {
  // Drop the +rerank observability flag -> rerank would become a silent no-op.
  const mutated = region.replace("retrieval: prev + '+rerank'", 'retrieval: prev');
  assert.notEqual(mutated, region);
  for (const [file, node] of NODES) assert.ok(!codeOf(file, node).includes(mutated), 'guard must reject a mutated rerank helper');
});

test('behavioral mutation proof: removing fail-open makes the degrade case throw', async () => {
  // Mutate the REAL rerankKbRows source: catch rethrows instead of failing open.
  const fnSrc = modText.slice(modText.indexOf('async function rerankKbRows'), modText.indexOf('// <<< KB-HYBRID-EMBED-END'));
  const mutantSrc = fnSrc.replace(
    '    // API down / timeout / non-2xx / bad JSON: drop rerank, keep RRF order.\n    return { rows: list, retrieval: prev, reranked: false };',
    '    throw e;',
  );
  assert.notEqual(mutantSrc, fnSrc, 'mutation must actually change the source');
  const mutant = new Function('KB_RERANK_URL', 'KB_RERANK_MAX_ITEM_CHARS', mutantSrc + '\nreturn rerankKbRows;')(KB_RERANK_URL, KB_RERANK_MAX_ITEM_CHARS);
  const rows = [rrow(0, 0.9)];
  const thrower = mockHttp(null, { throws: true });
  await assert.rejects(() => mutant(thrower, CFG, 'q', rows, 1, 'vector'), /simulated rerank API failure/);
  // The real one fails open (proves the degrade test above is not vacuous).
  const real = await rerankKbRows(thrower, CFG, 'q', rows, 1, 'vector');
  assert.equal(real.reranked, false);
  assert.equal(real.rows, rows);
});

test('mcp applies cosine >0.2 filter ONLY in pure vector mode (skips it for hybrid and rerank); others surface retrieval flag', () => {
  const mcp = codeOf('../workflows/mcp-server.json', 'Do MCP');
  assert.ok(mcp.includes("retrieval === 'vector' ? hit.filter((x) => Number(x.score) > 0.2) : hit"), 'cosine filter must be vector-only');
  assert.ok(!mcp.includes("retrieval === 'hybrid' ? hit : hit.filter"), 'old hybrid-only filter must be gone (rerank score is not a cosine)');
  const cg = codeOf('../workflows/chat-gateway.json', 'Execute Tool');
  assert.ok(cg.includes("type: 'kb'") && cg.includes('retrieval,'));
  assert.ok(codeOf('../workflows/kb-ingest.json', 'Run KB Ops').includes('top_k: topK, retrieval,'));
});

test('all three kb_search call sites wire rerank behind KB_RERANK_ENABLED with the injected httpRequest', () => {
  const expected = [
    ['../workflows/chat-gateway.json', 'Execute Tool', 'kbq, rows, Number($env.KB_RERANK_TOP_N) || k, retrieval'],
    ['../workflows/kb-ingest.json', 'Run KB Ops', 'q, rows, Number($env.KB_RERANK_TOP_N) || topK, retrieval'],
    ['../workflows/mcp-server.json', 'Do MCP', 'q, hit, Number($env.KB_RERANK_TOP_N) || k, retrieval'],
  ];
  for (const [file, node, args] of expected) {
    const code = codeOf(file, node);
    assert.ok(code.includes("String($env.KB_RERANK_ENABLED || '').toLowerCase() === 'true'"), file + ' must gate rerank behind KB_RERANK_ENABLED (default off)');
    assert.ok(code.includes('rerankKbRows((o) => this.helpers.httpRequest(o),'), file + ' must inject the n8n httpRequest helper');
    assert.ok(code.includes('{ apiKey: $env.DASHSCOPE_API_KEY, model: $env.KB_RERANK_MODEL, endpoint: $env.KB_RERANK_URL, instruct: $env.KB_RERANK_INSTRUCT }'), file + ' must pass the shared env config');
    assert.ok(code.includes(args), file + ' must pass the right query/rows/topN/retrieval');
    assert.ok(/let \{ rows(: hit)?, retrieval \} = await hybridKbSearch/.test(code), file + ' must use let so rerank can reassign rows/retrieval');
  }
});

// ---------------- schema guard contracts ----------------
const schema = fs.readFileSync(new URL('./kb-schema.sql', import.meta.url), 'utf8');
test('kb-schema BM25 index is guarded, idempotent and failure-tolerant; vector leg unchanged', () => {
  assert.ok(schema.includes('CREATE EXTENSION IF NOT EXISTS vector'));
  assert.ok(schema.includes('kb_chunks_hnsw'));
  assert.ok(schema.includes('DO $$') && schema.includes('pg_available_extensions') && schema.includes("name = 'pg_search'"));
  assert.ok(schema.includes('CREATE INDEX IF NOT EXISTS kb_chunks_bm25'));
  assert.ok(schema.includes('USING bm25 (chunk_id, content)') && schema.includes("key_field=''chunk_id''"));
  assert.ok(schema.includes('EXCEPTION WHEN OTHERS THEN'), 'index failure must degrade, not abort the schema');
  assert.ok(!schema.split('DO $$')[0].includes('kb_chunks_bm25'), 'bm25 index must live inside the guarded DO block');
});

// ---------------- CRAG-lite: gradeKbEvidence (pure cosine three-band) ----------------
// No network: a mock web httpRequest captures the request and returns a canned
// SearXNG-shaped response (or throws). The fail-open degrade is the central safety
// property. Live answer-quality benefit is operator-run on the deployment machine
// (agent answer-eval); offline green proves the mechanism, not the benefit.
function mockWeb(response, { throws = false } = {}) {
  const calls = [];
  const fn = async (req) => { calls.push(req); if (throws) throw new Error('simulated web failure'); return typeof response === 'function' ? response(req) : response; };
  fn.calls = calls;
  return fn;
}
const kbRow = (id, cos) => ({ chunk_id: id, content: 'c' + id, seq: id, title: 'T' + id, doc_id: 'd' + id, score: cos, vectorScore: cos });
const wrow = (i) => ({ title: 'W' + i, url: 'https://example/' + i, content: 'web-content-' + i });
const webOk = (n) => ({ results: Array.from({ length: n }, (_, i) => wrow(i)) });
const WEB_ON = { webFallback: true };
const WEB_OFF = { webFallback: false };

test('gradeKbEvidence cosine three-band: 0 rows / low / mid / high / all-null / mixed / non-array', () => {
  assert.deepEqual(gradeKbEvidence([]), { grade: 'incorrect', topCosine: null });
  assert.deepEqual(gradeKbEvidence([kbRow(1, 0.9)]), { grade: 'correct', topCosine: 0.9 });
  assert.deepEqual(gradeKbEvidence([kbRow(1, 0.1)]), { grade: 'incorrect', topCosine: 0.1 });
  assert.deepEqual(gradeKbEvidence([kbRow(1, 0.35)]), { grade: 'ambiguous', topCosine: 0.35 });
  assert.deepEqual(gradeKbEvidence([{ vectorScore: null }, { vectorScore: null }]), { grade: 'ambiguous', topCosine: null }, 'all-null pool is ambiguous (augment, don\'t discard)');
  assert.deepEqual(gradeKbEvidence([{ vectorScore: null }, kbRow(2, 0.6), kbRow(3, 0.2)]), { grade: 'correct', topCosine: 0.6 }, 'max finite cosine across rows, ignoring null');
  assert.deepEqual(gradeKbEvidence(null), { grade: 'incorrect', topCosine: null });
  assert.deepEqual(gradeKbEvidence('nope'), { grade: 'incorrect', topCosine: null });
  assert.deepEqual(gradeKbEvidence([{ title: 'no cosine' }]), { grade: 'ambiguous', topCosine: null }, 'missing vectorScore treated as null');
});

test('gradeKbEvidence boundaries: >=HIGH correct, ==LOW ambiguous, <LOW incorrect', () => {
  assert.equal(gradeKbEvidence([kbRow(1, KB_CRAG_HIGH_THRESHOLD)]).grade, 'correct', '==HIGH is correct');
  assert.equal(gradeKbEvidence([kbRow(1, KB_CRAG_HIGH_THRESHOLD - 0.001)]).grade, 'ambiguous');
  assert.equal(gradeKbEvidence([kbRow(1, KB_CRAG_LOW_THRESHOLD)]).grade, 'ambiguous', '==LOW is ambiguous (not <LOW)');
  assert.equal(gradeKbEvidence([kbRow(1, KB_CRAG_LOW_THRESHOLD - 0.001)]).grade, 'incorrect');
});

test('gradeKbEvidence cfg thresholds (number/string), empty falls back to default, 0 is a valid threshold', () => {
  assert.equal(gradeKbEvidence([kbRow(1, 0.3)], { low: 0.1, high: 0.4 }).grade, 'ambiguous');
  assert.equal(gradeKbEvidence([kbRow(1, 0.3)], { low: '0.1', high: '0.4' }).grade, 'ambiguous', 'string thresholds parsed');
  assert.equal(gradeKbEvidence([kbRow(1, 0.45)], { low: 0.1, high: 0.4 }).grade, 'correct');
  assert.equal(gradeKbEvidence([kbRow(1, 0.05)], { low: 0.1, high: 0.4 }).grade, 'incorrect');
  assert.equal(gradeKbEvidence([kbRow(1, 0.1)], { low: '', high: '' }).grade, 'incorrect', 'empty string must NOT collapse to 0; defaults apply');
  assert.equal(gradeKbEvidence([kbRow(1, 0.1)], { low: '  ', high: null }).grade, 'incorrect');
  assert.equal(gradeKbEvidence([kbRow(1, 0.0)], { low: 0, high: 0.5 }).grade, 'ambiguous', '0 is a valid low (not treated as absent)');
  assert.equal(gradeKbEvidence([kbRow(1, 0.1)], { low: 'abc', high: 'xyz' }).grade, 'incorrect', 'non-finite cfg -> default');
});

// ---------------- CRAG-lite: cragLiteKbRows (grade + bounded correction) ----------------
test('cragLiteKbRows correct grade -> no web call even when fallback on; rows kept, action none', async () => {
  const rows = [kbRow(1, 0.9)];
  const http = mockWeb(webOk(3));
  const out = await cragLiteKbRows(http, WEB_ON, 'q', rows, 'hybrid', {});
  assert.equal(http.calls.length, 0, 'correct evidence must not trigger web');
  assert.equal(out.rows, rows, 'same array reference');
  assert.equal(out.retrieval, 'hybrid', 'retrieval passthrough');
  assert.deepEqual(out.crag, { grade: 'correct', action: 'none', topCosine: 0.9, webAdded: 0 });
  assert.deepEqual(out.web, []);
});

test('cragLiteKbRows incorrect/ambiguous + fallback on -> one bounded web call, labeled supplement, KB rows kept', async () => {
  for (const cos of [0.1, 0.35]) {
    const rows = [kbRow(1, cos)];
    const http = mockWeb(webOk(5));
    const out = await cragLiteKbRows(http, WEB_ON, '检索 query', rows, 'vector', { topN: 3 });
    assert.equal(http.calls.length, 1, 'exactly one web call (never recursive)');
    assert.equal(out.crag.grade, cos < 0.2 ? 'incorrect' : 'ambiguous');
    assert.equal(out.crag.action, 'web');
    assert.equal(out.crag.webAdded, 3, 'sliced to topN');
    assert.equal(out.rows, rows, 'KB rows kept, never discarded (unlike full CRAG)');
    assert.equal(out.web.length, 3);
    for (const w of out.web) {
      assert.equal(w.source, 'web', 'every supplement row labeled as web');
      assert.ok('title' in w && 'url' in w && 'snippet' in w);
    }
    assert.equal(out.web[0].title, 'W0');
    assert.equal(out.web[0].url, 'https://example/0');
    assert.equal(out.web[0].snippet, 'web-content-0');
  }
});

test('cragLiteKbRows web request contract: GET SearXNG, qs q+format, default timeout; overrides honored', async () => {
  const rows = [kbRow(1, 0.1)];
  const http = mockWeb(webOk(1));
  await cragLiteKbRows(http, WEB_ON, '检索', rows, 'vector', {});
  const req = http.calls[0];
  assert.equal(req.method, 'GET');
  assert.equal(req.url, KB_CRAG_WEB_URL, 'default SearXNG endpoint');
  assert.deepEqual(req.qs, { q: '检索', format: 'json' });
  assert.equal(req.timeout, KB_CRAG_WEB_TIMEOUT_MS, 'default 12s (tighter than standalone web_search)');
  const http2 = mockWeb(webOk(1));
  await cragLiteKbRows(http2, WEB_ON, 'q', rows, 'vector', { endpoint: 'http://mock/search', topN: 2, timeoutMs: 5000 });
  assert.equal(http2.calls[0].url, 'http://mock/search');
  assert.equal(http2.calls[0].timeout, 5000);
});

test('cragLiteKbRows grade-only when fallback off (default): grade recorded, zero web calls', async () => {
  const rows = [kbRow(1, 0.1)];
  for (const cfg of [WEB_OFF, {}, { webFallback: 'false' }, { webFallback: null }]) {
    const http = mockWeb(webOk(3));
    const out = await cragLiteKbRows(http, cfg, 'q', rows, 'vector', {});
    assert.equal(http.calls.length, 0, 'no web when fallback off');
    assert.equal(out.crag.grade, 'incorrect');
    assert.equal(out.crag.action, 'none');
    assert.equal(out.crag.webAdded, 0);
    assert.deepEqual(out.web, []);
    assert.equal(out.rows, rows);
  }
});

test('cragLiteKbRows webFallback string "true" enables web (env values are strings)', async () => {
  const rows = [kbRow(1, 0.1)];
  const http = mockWeb(webOk(2));
  const out = await cragLiteKbRows(http, { webFallback: 'true' }, 'q', rows, 'vector', {});
  assert.equal(http.calls.length, 1);
  assert.equal(out.crag.action, 'web');
});

test('cragLiteKbRows topN clamp 1..10, snippet clamp 300, JSON-string response accepted', async () => {
  const rows = [kbRow(1, 0.1)];
  const many = { results: Array.from({ length: 20 }, (_, i) => ({ title: 'W' + i, url: 'u' + i, content: 'x'.repeat(500) })) };
  const outBig = await cragLiteKbRows(mockWeb(many), WEB_ON, 'q', rows, 'vector', { topN: 99 });
  assert.equal(outBig.web.length, 10, 'topN capped at 10');
  assert.equal(outBig.web[0].snippet.length, 300, 'snippet clamped to 300');
  const outZero = await cragLiteKbRows(mockWeb(many), WEB_ON, 'q', rows, 'vector', { topN: 0 });
  assert.equal(outZero.web.length, KB_CRAG_WEB_TOP_N, 'topN 0 -> default 3');
  const outNeg = await cragLiteKbRows(mockWeb(many), WEB_ON, 'q', rows, 'vector', { topN: -5 });
  assert.equal(outNeg.web.length, 1, 'negative topN -> 1');
  const outStr = await cragLiteKbRows(mockWeb(JSON.stringify(webOk(2))), WEB_ON, 'q', rows, 'vector', {});
  assert.equal(outStr.crag.action, 'web');
  assert.equal(outStr.web.length, 2);
});

test('cragLiteKbRows FAILS OPEN: web throw / bad shape keep KB rows, action none, grade recorded, never throw', async () => {
  const rows = [kbRow(1, 0.1), kbRow(2, 0.15)];
  const badResponses = [null, undefined, {}, { results: null }, { results: [] }, { results: 'nope' }, 'not-json', { output: { results: [] } }];
  for (const resp of badResponses) {
    const http = mockWeb(resp);
    const out = await cragLiteKbRows(http, WEB_ON, 'q', rows, 'hybrid', {});
    assert.equal(http.calls.length, 1, 'a real attempt was made before degrading');
    assert.equal(out.rows, rows, 'same array reference for ' + JSON.stringify(resp));
    assert.deepEqual(out.rows.map((r) => r.chunk_id), [1, 2], 'order unchanged');
    assert.equal(out.crag.action, 'none');
    assert.equal(out.crag.grade, 'incorrect', 'grade still recorded on degrade');
    assert.equal(out.crag.webAdded, 0);
    assert.deepEqual(out.web, []);
    assert.equal(out.retrieval, 'hybrid');
  }
  const thrower = mockWeb(null, { throws: true });
  const out = await cragLiteKbRows(thrower, WEB_ON, 'q', rows, 'vector', {});
  assert.equal(thrower.calls.length, 1);
  assert.equal(out.rows, rows);
  assert.equal(out.crag.action, 'none');
  assert.equal(out.crag.grade, 'incorrect');
});

test('cragLiteKbRows precondition skips: empty query / non-function httpRequest -> grade-only, zero web calls', async () => {
  const rows = [kbRow(1, 0.1)];
  for (const q of ['', '   ', null]) {
    const http = mockWeb(webOk(3));
    const out = await cragLiteKbRows(http, WEB_ON, q, rows, 'vector', {});
    assert.equal(http.calls.length, 0, 'no web for empty query');
    assert.equal(out.crag.action, 'none');
    assert.equal(out.crag.grade, 'incorrect');
  }
  for (const notFn of [null, undefined, {}, 'str']) {
    const out = await cragLiteKbRows(notFn, WEB_ON, 'q', rows, 'vector', {});
    assert.equal(out.crag.action, 'none');
    assert.equal(out.rows, rows);
  }
});

test('cragLiteKbRows retrieval passthrough across all modes; crag object always present', async () => {
  const rows = [kbRow(1, 0.9)];
  for (const mode of ['vector', 'hybrid', 'vector+rerank', 'hybrid+rerank', undefined]) {
    const out = await cragLiteKbRows(mockWeb(webOk(1)), WEB_ON, 'q', rows, mode, {});
    assert.equal(out.retrieval, mode || 'vector', 'CRAG is orthogonal to retrieval mode');
    assert.ok(out.crag && typeof out.crag.grade === 'string' && 'action' in out.crag && 'topCosine' in out.crag && 'webAdded' in out.crag, 'crag always present + observable');
  }
});

test('cragLiteKbRows empty KB rows grade incorrect and (fallback on) still attempt web', async () => {
  const http = mockWeb(webOk(2));
  const out = await cragLiteKbRows(http, WEB_ON, 'q', [], 'vector', {});
  assert.equal(out.crag.grade, 'incorrect');
  assert.equal(out.crag.topCosine, null);
  assert.equal(http.calls.length, 1, '0 rows is incorrect -> web supplement attempted');
  assert.equal(out.crag.action, 'web');
  assert.deepEqual(out.rows, []);
});

// ---------------- CRAG drift guard + wiring + model-wiring ----------------
const CRAG_GATE = "String($env.KB_CRAG_ENABLED || '').toLowerCase() === 'true'";
const CRAG_CFG = '{ low: $env.KB_CRAG_LOW_THRESHOLD, high: $env.KB_CRAG_HIGH_THRESHOLD, webFallback: $env.KB_CRAG_WEB_FALLBACK }';
const CRAG_WEBCFG = '{ endpoint: $env.KB_CRAG_WEB_URL, topN: $env.KB_CRAG_WEB_TOP_N, timeoutMs: $env.KB_CRAG_WEB_TIMEOUT_MS }';

test('CRAG grows the canonical region and all three nodes embed it verbatim + call cragLiteKbRows', () => {
  assert.ok(region.includes('function gradeKbEvidence') && region.includes('function cragLiteKbRows'));
  for (const [file, node] of NODES) {
    const code = codeOf(file, node);
    assert.ok(code.includes(region), file + ' :: ' + node + ' CRAG region drifted from canonical');
    assert.ok(code.includes('cragLiteKbRows('), file + ' does not call cragLiteKbRows');
  }
});

test('CRAG drift guard is discriminating: mislabeling web as kb would NOT match', () => {
  const mutated = region.replace("source: 'web',", "source: 'kb',");
  assert.notEqual(mutated, region);
  for (const [file, node] of NODES) assert.ok(!codeOf(file, node).includes(mutated), 'guard must reject a mutated CRAG helper');
});

test('all three kb_search call sites wire CRAG behind KB_CRAG_ENABLED with the injected httpRequest', () => {
  const expected = [
    ['../workflows/chat-gateway.json', 'Execute Tool', 'kbq, rows, retrieval,'],
    ['../workflows/kb-ingest.json', 'Run KB Ops', 'q, rows, retrieval,'],
    ['../workflows/mcp-server.json', 'Do MCP', 'q, rows, retrieval,'],
  ];
  for (const [file, node, args] of expected) {
    const code = codeOf(file, node);
    assert.ok(code.includes(CRAG_GATE), file + ' must gate CRAG behind KB_CRAG_ENABLED (default off)');
    assert.ok(code.includes('cragLiteKbRows((o) => this.helpers.httpRequest(o),'), file + ' must inject the n8n httpRequest helper');
    assert.ok(code.includes(CRAG_CFG), file + ' must pass the shared grade/fallback config');
    assert.ok(code.includes(CRAG_WEBCFG), file + ' must pass the shared web config');
    assert.ok(code.includes(args), file + ' must pass the right query/rows/retrieval');
  }
});

test('CRAG wiring gate is discriminating: a gate-removed mutant would fail the guard', () => {
  for (const [file, node] of NODES) {
    const code = codeOf(file, node);
    const mutated = code.replace(CRAG_GATE, 'true');
    assert.notEqual(mutated, code, 'mutation must change the code');
    assert.ok(!mutated.includes(CRAG_GATE), 'a gate-removed mutant must not satisfy the wiring guard');
  }
});

test('gateway Append Tool Results forwards web_supplement + evidence_grade (kb branch)', () => {
  const ap = codeOf('../workflows/chat-gateway.json', 'Append Tool Results');
  assert.ok(ap.includes('...(res.web && res.web.length ? { web_supplement: res.web } : {})'), 'must forward the web supplement');
  assert.ok(ap.includes('...(res.crag ? { evidence_grade: res.crag.grade } : {})'), 'must forward the evidence grade');
});

test('gateway DIRECTIVE gains the CRAG evidence-grade web rule (9)', () => {
  const bu = codeOf('../workflows/chat-gateway.json', 'Build Upstream Payload');
  assert.ok(bu.includes('(9) KB evidence grade'), 'DIRECTIVE must gain rule 9');
  assert.ok(bu.includes('web_supplement') && bu.includes('[来源:web]'), 'rule must name web_supplement and the web citation');
  assert.ok(bu.includes('evidence_grade') && bu.includes('incorrect or ambiguous'), 'rule must cover the weak-evidence bands');
});

test('gateway Execute Tool __trace carries crag_grade/crag_action only when present', () => {
  const et = codeOf('../workflows/chat-gateway.json', 'Execute Tool');
  assert.ok(et.includes('...((result && result.crag) ? { crag_grade: String(result.crag.grade || \'\'), crag_action: String(result.crag.action || \'\') } : {})'), 'trace must conditionally add crag fields (default-off => byte-identical)');
});

test('mcp surfaces the CRAG grade + labeled web supplement in its text result', () => {
  const mcp = codeOf('../workflows/mcp-server.json', 'Do MCP');
  assert.ok(mcp.includes('let cragNote'), 'mcp must build a crag note');
  assert.ok(mcp.includes('[evidence_grade: '), 'mcp must surface the grade');
  assert.ok(mcp.includes('Web supplement (public web, not internal KB)'), 'mcp must label the web supplement');
  assert.ok(mcp.includes('+ cragNote };'), 'mcp must append the note to the text');
});

test('model-wiring guard is discriminating: the pre-CRAG Append form would fail it', () => {
  const oldForm = 'content = JSON.stringify({ tool: it.tool_name, sources: res.results });';
  assert.ok(!oldForm.includes('web_supplement') && !oldForm.includes('evidence_grade'), 'old form lacks forwarding');
  const ap = codeOf('../workflows/chat-gateway.json', 'Append Tool Results');
  assert.ok(ap.includes('web_supplement') && ap.includes('evidence_grade'), 'real form has forwarding');
  assert.ok(!ap.includes(oldForm), 'real Append must not be the pre-CRAG form');
});

test('behavioral mutation proof: removing CRAG fail-open makes the web-throw case throw', async () => {
  // Mutate the REAL cragLiteKbRows source: catch rethrows instead of failing open.
  const fnSrc = modText.slice(modText.indexOf('async function cragLiteKbRows'), modText.indexOf('// <<< KB-HYBRID-EMBED-END'));
  const mutantSrc = fnSrc.replace(
    '    // Web down / timeout / non-2xx / bad JSON: fail-open, KB rows unchanged.\n    return none;',
    '    throw e;',
  );
  assert.notEqual(mutantSrc, fnSrc, 'mutation must actually change the source');
  const mutant = new Function('KB_CRAG_WEB_URL', 'KB_CRAG_WEB_TIMEOUT_MS', 'KB_CRAG_WEB_TOP_N', 'gradeKbEvidence', mutantSrc + '\nreturn cragLiteKbRows;')(KB_CRAG_WEB_URL, KB_CRAG_WEB_TIMEOUT_MS, KB_CRAG_WEB_TOP_N, gradeKbEvidence);
  const rows = [kbRow(1, 0.1)];
  const thrower = mockWeb(null, { throws: true });
  await assert.rejects(() => mutant(thrower, WEB_ON, 'q', rows, 'vector', {}), /simulated web failure/);
  // The real one fails open (proves the degrade test above is not vacuous).
  const real = await cragLiteKbRows(thrower, WEB_ON, 'q', rows, 'vector', {});
  assert.equal(real.crag.action, 'none');
  assert.equal(real.rows, rows);
});

test('behavioral mutation proof: a grade-band boundary mutation misgrades; the real grader is correct', () => {
  const fnSrc = modText.slice(modText.indexOf('function gradeKbEvidence'), modText.indexOf('// Graded corrective retrieval'));
  const mutantSrc = fnSrc.replace("topCos >= high ? 'correct'", "topCos > high ? 'correct'");
  assert.notEqual(mutantSrc, fnSrc, 'mutation must actually change the source');
  const mutant = new Function('KB_CRAG_LOW_THRESHOLD', 'KB_CRAG_HIGH_THRESHOLD', mutantSrc + '\nreturn gradeKbEvidence;')(KB_CRAG_LOW_THRESHOLD, KB_CRAG_HIGH_THRESHOLD);
  const atHigh = [kbRow(1, KB_CRAG_HIGH_THRESHOLD)];
  assert.equal(mutant(atHigh).grade, 'ambiguous', 'mutant misgrades the ==HIGH boundary');
  assert.equal(gradeKbEvidence(atHigh).grade, 'correct', 'real grader: ==HIGH is correct (boundary test not vacuous)');
});