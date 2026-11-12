# KB hybrid retrieval (Agentic RAG) — build-here / measure-on-deployment

- Date: 2026-11-12
- Branch: `feat/kb-hybrid-search-20261112` (base `main` @ `418e6f4`)
- Scope authorized: "Agentic RAG 混合检索" — add a BM25 full-text leg to KB
  retrieval and fuse it with the existing pgvector ANN leg via Reciprocal Rank
  Fusion (RRF). Correctness is verified offline here; **retrieval efficacy is
  not measured here** and is left to the deployment machine's `kb-eval` ruler.
- Standing rule honored: no live deploy, no shared-`.env` edit, no real model
  calls from this session. Integration is branch → PR → CI → operator merge.

## What changed

| File | Change |
|---|---|
| `n8n/lib/kb-hybrid.mjs` | New canonical, dependency-free module: `rrfFuse`, `bm25Available`, `hybridKbSearch`, `KB_BM25_PROBE_SQL`, `kbVectorSql`, `kbBm25Sql`. The region between the `KB-HYBRID-EMBED` markers is the single source of truth. |
| `n8n/workflows/chat-gateway.json` (Execute Tool) | `kb_search` now calls `hybridKbSearch`; result carries a `retrieval` flag. |
| `n8n/workflows/kb-ingest.json` (Run KB Ops) | `mode:search` now calls `hybridKbSearch`; response carries `retrieval`. |
| `n8n/workflows/mcp-server.json` (Do MCP) | `kb_search` now calls `hybridKbSearch`; keeps the cosine `>0.2` filter in vector mode, drops it in hybrid mode (RRF scores are not cosines). |
| `n8n/scripts/kb-schema.sql` | Adds a **guarded, idempotent, failure-tolerant** `kb_chunks_bm25` index (ParadeDB `pg_search`). Vector leg / HNSW unchanged. |
| `n8n/scripts/kb-eval.mjs` | New `--hybrid` flag + exported `parseEvalFlags`; both modes route through the same canonical helper with the frozen-corpus `docIds` whitelist; report records `requested_mode` vs `retrieval_mode`. |
| `n8n/scripts/kb-hybrid.test.mjs` | New offline contracts (15 tests): RRF unit + negatives, availability decision table, degradation, whitelist, clamps, SQL builders, **verbatim-embedding drift guard**, schema guard. |
| `n8n/scripts/kb-eval.test.mjs` | Additive `parseEvalFlags` tests; all prior tests preserved. |
| `.github/workflows/ci.yml` | New `kb-hybrid-contract-tests` job (offline, no DB). |

n8n Code nodes run in a runner sandbox that only allows `pg` and `crypto`, so
they cannot import the module. The helper is therefore embedded **verbatim** in
all three nodes; the drift guard fails CI if any copy diverges from the module.

## Design

- **RRF**: `score(row) = Σ_legs 1/(k + rank + 1)`, `k = 60`, rank 0-based, fused
  by `chunk_id`. Each leg fetches a pool of `min(max(3·k, 20), 50)`; ties keep
  first-seen order (vector leg first). Output is sliced to `k` (clamped 1..10).
- **Degradation is the central safety property.** Before any BM25 query, an
  error-safe catalog probe checks four things: `pg_extension` has `pg_search`,
  `to_regclass('public.kb_chunks_bm25')` is present, `pdb.score()` exists, and
  the `|||` operator exists. If any is missing — or the query text is empty —
  the helper returns **vector-only**, reproducing the previous cosine ordering
  and top-k exactly. The active mode is returned as `retrieval` so a silent
  no-op is observable.
- **§9.13 (AGENTS.md)**: a pg error response inside the runner sandbox is an
  uncaught exception that kills the whole runner; `try/catch` cannot catch it.
  The probe uses only catalog reads (`pg_extension` / `to_regclass` / `pg_proc`
  / `pg_operator`), which return `0`/`NULL` on absence, never an error. The BM25
  SQL (`content ||| $1`, `pdb.score(chunk_id)`) was verified on a disposable
  ParadeDB container to return 0 rows — not errors — for empty, colon,
  unbalanced-quote and punctuation queries. The query text is always a bound
  parameter (`$1`), never interpolated.
- **Score semantics**: every row carries `score` (the ranking score) and
  `vectorScore` (cosine, or `null` for a BM25-only hit). In vector mode
  `score === vectorScore === cosine`, so the MCP `>0.2` filter is unchanged. In
  hybrid mode `score` is the RRF value and the cosine filter is skipped.
- **Current live stack**: the deployment Postgres has `pg_search` *available*
  but the extension is **not installed** and there is no BM25 index. So today
  every path degrades to vector-only — **zero regression**. Hybrid activates
  only after an operator applies the new `kb-schema.sql` on a box that preloads
  `pg_search` (the live `paradedb` image already does, per `docker-compose.yml`).

## Offline verification (this machine, no DB / no embeddings / no network)

| Gate | Result |
|---|---|
| `node --test n8n/scripts/kb-hybrid.test.mjs` | **15 pass / 0 fail** |
| `node --test …eval-contract …eval-mine …eval-judge …kb-eval` | **111 pass / 0 fail** |
| `node n8n/scripts/validate-workflows.mjs` | **26 files, 0 warnings** |
| `node n8n/scripts/eval-validate.mjs` | OK, 26 cases |
| `node n8n/scripts/eval-run.mjs --dry --runs 3` | plan emitted, no model calls |

Negative controls / mutation proofs (green ≠ proof):

- **Drift gate is load-bearing**: injecting `/*MUTATION*/` into the chat-gateway
  embedded helper made the suite fail with "helper drifted from canonical
  module" (14 pass / 1 fail); restoring returned 15/15. A separate test asserts
  a mutated RRF formula is *not* found in any node.
- **Degradation guard is load-bearing**: a temp-copy mutant with
  `bm25Available() → true` issues the BM25 leg against an absent `pg_search`
  (the §9.13 runner-killer); the real module does not. Proven without touching
  the working tree.
- Availability decision table forces `ext=0 / fn=0 / op=0 / idx=null` each to
  disable BM25; degradation tests assert the `|||` operator and `pdb.score`
  are **never** issued when the probe fails.

## NOT verified here (未验 — deployment machine only)

1. **Live hybrid efficacy**: hit@1 / hit@5 / MRR before (vector) vs after
   (hybrid) on the frozen corpus, and whether hybrid actually beats the
   `hit@1 >= 0.80` gate by a meaningful margin. No real embeddings were run.
2. **BM25 index creation on the real box**: that `kb-schema.sql` creates
   `kb_chunks_bm25` successfully on the deployment Postgres (preload, version,
   permissions). The guarded block was verified on a disposable container, not
   the live instance.
3. **Chinese tokenization / ranking quality on the real corpus**: ParadeDB's
   out-of-box tokenizer matched and ranked Chinese probe terms on the disposable
   container; behavior on the actual KB content is unmeasured.
4. **End-to-end agent answer improvement**: retrieval rank gains do not by
   themselves prove better final answers; that needs the agent eval, not just
   the retrieval ruler.
5. **The new CI job has not run remotely**: the numbers above are local checks.

The frozen 5-doc / 50-case corpus is a **regression ruler**, not a statement of
production architecture, and 50 KB queries are not the 26 agent scenarios.

## Deployment-machine commands (operator-run)

```bash
# 1. Apply the guarded schema (idempotent; creates pg_search + kb_chunks_bm25
#    only if available, else logs a notice and leaves vector-only):
docker exec -i postgres psql -U n8n -d n8n < n8n/scripts/kb-schema.sql

# 2. Confirm the index exists and the probe will see it:
docker exec -i postgres psql -U n8n -d n8n -c \
  "SELECT to_regclass('public.kb_chunks_bm25') AS idx, \
          (SELECT count(*) FROM pg_extension WHERE extname='pg_search') AS ext;"

# 3. Baseline (vector-only) vs hybrid, on a DISPOSABLE test stack.
#    --isolated-stack is an operator acknowledgement, not automatic isolation.
#    Point DB_* / DASHSCOPE_API_KEY at a throwaway environment, never shared KB.
node n8n/scripts/kb-eval.mjs --isolated-stack            # requested_mode=vector
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid   # requested_mode=hybrid

# 4. Compare the two reports in .eval-local/judge/kb-*.json:
#    hit_at_1 / mrr, and retrieval_mode vs requested_mode. If --hybrid reports
#    retrieval_mode=vector, the index/extension is missing — hybrid did NOT run.
```

Redact `.eval-local/` reports before publishing anything to this public repo.

## Rollback

- Drop the index (`DROP INDEX IF EXISTS kb_chunks_bm25;`) or uninstall
  `pg_search`: every path auto-degrades to vector-only, no code change needed.
- The schema block is guarded and exception-tolerant, so re-running it on a box
  without `pg_search` is a no-op notice, never an error.
- No `.env` change, no new service, no new data table; the vector leg and HNSW
  index are untouched.