// Canonical hybrid KB retrieval: pgvector ANN + ParadeDB BM25, fused with RRF.
// Dependency-free (the pg client is passed in) so it is importable by kb-eval
// and by the offline contract tests without a database or embeddings.
//
// n8n Code nodes run in a runner sandbox that only allows `pg` and `crypto`,
// so they cannot import this file. The region between the EMBED markers below
// is therefore copied VERBATIM into three Code nodes:
//   - n8n/workflows/chat-gateway.json  (Execute Tool, kb_search branch)
//   - n8n/workflows/kb-ingest.json     (Run KB Ops, mode:search branch)
//   - n8n/workflows/mcp-server.json    (Do MCP, kb_search branch)
// n8n/scripts/kb-hybrid.test.mjs asserts the three copies have not drifted.
//
// §9.13 (AGENTS.md): a pg error response inside the runner sandbox is an
// uncaught exception that kills the WHOLE runner — try/catch cannot catch it.
// So every optional object is catalog-probed first: pg_extension / to_regclass
// / pg_proc / pg_operator return 0 / NULL on absence, never an error response.
// When pg_search or the bm25 index is missing we degrade to vector-only, which
// reproduces the previous behaviour exactly (same ordering, same top-k). The
// `retrieval` flag makes the active mode observable so a silent no-op is visible.

// >>> KB-HYBRID-EMBED-BEGIN (verbatim copy into workflow Code nodes; drift-guarded)
// Reciprocal Rank Fusion. `lists` is an array of ranked row arrays (best first).
// Each row must carry a stable chunk_id. score(row) = sum over lists of
// 1 / (k + rank + 1), rank 0-based. Ties keep first-seen order (vector leg first
// when it is lists[0]), because Array.prototype.sort is stable. Pure.
function rrfFuse(lists, k, limit) {
  const kk = Number.isFinite(Number(k)) ? Number(k) : 60;
  const cap = Number.isFinite(Number(limit)) ? Number(limit) : 10;
  const byId = new Map();
  for (const list of Array.isArray(lists) ? lists : []) {
    if (!Array.isArray(list)) continue;
    list.forEach((row, rank) => {
      if (!row || row.chunk_id == null) return;
      const id = String(row.chunk_id);
      const contrib = 1 / (kk + rank + 1);
      const prev = byId.get(id);
      if (prev) prev.score += contrib;
      else byId.set(id, { row, score: contrib });
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, cap);
}

// Decide whether the BM25 leg is safe to run from a catalog probe row. All four
// must be present: the extension, the index, pdb.score(), and the ||| operator.
// Pure; never touches the database itself.
function bm25Available(probe) {
  return !!(probe && Number(probe.ext) > 0 && probe.idx && Number(probe.fn) > 0 && Number(probe.op) > 0);
}

// Error-safe catalog probe (no optional object is ever referenced directly).
const KB_BM25_PROBE_SQL = `SELECT
    (SELECT count(*) FROM pg_extension WHERE extname = 'pg_search') AS ext,
    to_regclass('public.kb_chunks_bm25') AS idx,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'pdb' AND p.proname = 'score') AS fn,
    (SELECT count(*) FROM pg_operator WHERE oprname = '|||') AS op`;

// Vector leg: cosine ANN over active chunks. $1 vector literal, $2 limit,
// optional $3 doc_id whitelist (text[]). chunk_id is selected so RRF can fuse.
function kbVectorSql(withDocs) {
  return `SELECT c.chunk_id, c.content, c.seq, d.title, d.doc_id,
                 1 - (c.embedding <=> $1::vector) AS score
            FROM kb_chunks c JOIN kb_documents d ON d.doc_id = c.doc_id
           WHERE d.status = 'active'${withDocs ? ' AND d.doc_id = ANY($3::text[])' : ''}
           ORDER BY c.embedding <=> $1::vector LIMIT $2`;
}

// BM25 leg: ParadeDB full-text. $1 query text, $2 limit, optional $3 whitelist.
// `|||` matches any token; pdb.score(chunk_id) ranks by BM25. Only run after
// bm25Available(probe) is true, so a missing extension/index never errors.
function kbBm25Sql(withDocs) {
  return `SELECT c.chunk_id, c.content, c.seq, d.title, d.doc_id,
                 pdb.score(c.chunk_id) AS score
            FROM kb_chunks c JOIN kb_documents d ON d.doc_id = c.doc_id
           WHERE d.status = 'active' AND c.content ||| $1${withDocs ? ' AND d.doc_id = ANY($3::text[])' : ''}
           ORDER BY pdb.score(c.chunk_id) DESC LIMIT $2`;
}

// Hybrid retrieval. `pg` is a connected client with .query(); `vec` is the query
// embedding (number[]); `query` is the raw text (for BM25); `k` is the result
// count (clamped 1..10); opts.docIds optionally restricts to a doc_id whitelist.
// Returns { rows, retrieval } where retrieval is 'hybrid' or 'vector'. Each row
// carries { chunk_id, content, seq, title, doc_id, score, vectorScore }:
//   - vector mode: score === vectorScore === cosine similarity (unchanged).
//   - hybrid mode: score === RRF score; vectorScore === cosine or null.
// Callers that filtered on cosine (mcp >0.2) keep doing so in vector mode and
// skip the filter in hybrid mode, where score is no longer a cosine.
async function hybridKbSearch(pg, vec, query, k, opts) {
  const options = opts || {};
  const docIds = Array.isArray(options.docIds) && options.docIds.length ? options.docIds : null;
  const withDocs = !!docIds;
  const limit = Math.min(Math.max(Number(k) || 6, 1), 10);
  const poolN = Math.min(Math.max(limit * 3, 20), 50);
  const vecLiteral = '[' + vec.join(',') + ']';

  const vecRes = await pg.query(kbVectorSql(withDocs), withDocs ? [vecLiteral, poolN, docIds] : [vecLiteral, poolN]);
  const vecRows = (vecRes.rows || []).map((r) => ({ ...r, vectorScore: Number(r.score) }));

  const q = String(query == null ? '' : query).trim();
  const probe = (await pg.query(KB_BM25_PROBE_SQL)).rows[0] || null;
  if (!bm25Available(probe) || !q) {
    return { rows: vecRows.slice(0, limit).map((r) => ({ ...r, score: r.vectorScore })), retrieval: 'vector' };
  }

  const bmRes = await pg.query(kbBm25Sql(withDocs), withDocs ? [q, poolN, docIds] : [q, poolN]);
  const bmRows = bmRes.rows || [];
  const fused = rrfFuse([vecRows, bmRows], 60, limit);
  return {
    rows: fused.map((f) => ({ ...f.row, score: f.score, vectorScore: f.row.vectorScore == null ? null : f.row.vectorScore })),
    retrieval: 'hybrid',
  };
}
// <<< KB-HYBRID-EMBED-END

export { rrfFuse, bm25Available, hybridKbSearch, KB_BM25_PROBE_SQL, kbVectorSql, kbBm25Sql };