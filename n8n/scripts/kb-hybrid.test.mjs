import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rrfFuse, bm25Available, hybridKbSearch, KB_BM25_PROBE_SQL, kbVectorSql, kbBm25Sql } from '../lib/kb-hybrid.mjs';

// Offline contracts only: pure functions + a mock pg client. No database, no
// embeddings, no network. Live hybrid efficacy (hit@1/MRR before/after) is
// operator-run on the deployment machine via kb-eval.mjs --isolated-stack
// [--hybrid]; offline green is not retrieval acceptance.

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
  assert.ok(region.length > 1000 && region.includes('function hybridKbSearch'));
  for (const [file, node] of NODES) {
    const code = codeOf(file, node);
    assert.ok(code.includes(region), file + ' :: ' + node + ' helper drifted from canonical module');
    assert.ok(code.includes('hybridKbSearch('), file + ' does not call hybridKbSearch');
    assert.ok(code.includes("to_regclass('public.kb_documents')") && code.includes("to_regclass('public.kb_chunks')"), file + ' lost the §9.13 docs/chunks probe');
  }
});

test('drift guard is discriminating: a mutated helper would NOT match', () => {
  const mutated = region.replace('1 / (kk + rank + 1)', '1 / (kk + rank + 2)');
  assert.notEqual(mutated, region);
  for (const [file, node] of NODES) assert.ok(!codeOf(file, node).includes(mutated), 'guard must reject a mutated helper');
});

test('mcp keeps cosine >0.2 filter in vector mode, drops it in hybrid; others surface retrieval flag', () => {
  assert.ok(codeOf('../workflows/mcp-server.json', 'Do MCP').includes("retrieval === 'hybrid' ? hit : hit.filter((x) => Number(x.score) > 0.2)"));
  const cg = codeOf('../workflows/chat-gateway.json', 'Execute Tool');
  assert.ok(cg.includes("type: 'kb'") && cg.includes('retrieval,'));
  assert.ok(codeOf('../workflows/kb-ingest.json', 'Run KB Ops').includes('top_k: topK, retrieval,'));
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