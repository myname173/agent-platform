# KB rerank (post-retrieval cross-encoder) — implemented + offline verified

- Date: 2026-11-12
- Status: **implemented on `feat/kb-rerank-20261112`, offline verified; NOT merged,
  live efficacy 未验.** Branched from `main` @ `0cb8c76`. PR opened, CI watched;
  awaiting the operator's typed merge decision. This doc is the design + delivery
  record (it was the review design; now updated to the implemented state).
- Scope chosen by operator: **rerank only (layer [A])**. Query rewriting [B],
  CRAG-lite [C] and contextual retrieval [D] are explicitly OUT of this increment
  (跟进层留作下一步).
- Builds on the merged hybrid retrieval (PR #15, `main` `0cb8c76`). Does not redo it.
- Standing rule honored: no live deploy, no shared-`.env` edit, **no real rerank
  API call from this session** (same precedent as kb-hybrid, which ran no real
  embeddings). Real efficacy is the deployment machine's `kb-eval` ruler.

## 1. Current boundary (verified by reading code, not assumed)

This is the **pre-increment baseline** (the boundary at `0cb8c76` before rerank
was added). The "Rerank: absent" row is what this increment fills; §3–§5 describe
the implemented stage.

| Stage | State | Evidence |
|---|---|---|
| Chunking | fixed window `CHUNK_CHARS=750` + `OVERLAP_CHARS=80` (naive, not semantic) | `kb-ingest.json` Run KB Ops |
| Embedding | DashScope `qwen3.7-text-embedding-flash`, 1024-d, via `this.helpers.httpRequest` | chat-gateway / kb-ingest / mcp-server |
| Recall | pgvector ANN + ParadeDB BM25 → RRF (k=60), pool `min(max(3k,20),50)`, degrades to vector-only | `n8n/lib/kb-hybrid.mjs` |
| **Rerank** | **absent** | grep `rerank\|cross.?encoder\|gte-rerank` over `n8n/` = 0 hits |
| Query transform | absent | grep `hyde\|query.?rewrit\|multi.?query` = 0 hits |
| Agent loop | `kb_search` is one tool call, `MAX_TOOL_ROUNDS=2`; prompt already says "ground + cite, admit when nothing relevant" | chat-gateway |
| Ruler | `kb-eval.mjs` hit@1/hit@5/MRR, frozen 5-doc/50-case, `--hybrid` flag, `requested_mode` vs `retrieval_mode` | `kb-eval.mjs` |

The rerank stage plugs in **after** the RRF fusion and **before** the result is
formatted/returned. The fused pool (≤50 rows) is exactly the reranker's input.

## 2. Technology choice

DashScope (阿里百炼) **`qwen3-rerank`** cross-encoder rerank. Rationale:

- **Zero new infrastructure.** The stack already calls DashScope for embeddings
  with `DASHSCOPE_API_KEY` via the Code-node built-in `this.helpers.httpRequest`.
  Rerank uses the same vendor, same key, same helper. No new service, no new
  dependency, no new secret.
- Cross-attention rerank is the standard post-retrieval quality lift; the vendor's
  documented flow is "recall 50–100 → rerank to top 5–10 → LLM", matching our pool.
- Model name is **env-configurable** (`KB_RERANK_MODEL`). The API doc notes
  `gte-rerank` scheduled offline 2026-05-30 (already past); `qwen3-rerank` is the
  recommended current model. Exact availability is a deployment-machine 未验.

### API contract (from the official DashScope text-rerank doc)

```
POST https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json

{ "model": "qwen3-rerank",
  "input": { "query": "<query text>", "documents": ["<chunk text>", ...] },
  "parameters": { "top_n": <int>, "return_documents": false, "instruct": "<optional>" } }

→ { "output": { "results": [ { "index": <int>, "relevance_score": <0..1> }, ... ] },
    "usage": { "total_tokens": <int> }, "request_id": "..." }
```

- `output.results` is sorted by `relevance_score` desc; `index` is the position in
  the input `documents` array → maps back to the fused row.
- `relevance_score` is **relative within one request, 0..1, NOT a cosine, not
  comparable across requests.** This drives the score-semantics decision below.
- Limits: ≤500 documents; ≤4000 tokens per query/document (HTTP 400 if exceeded,
  no truncation); request budget `query_tokens × doc_count + Σdoc_tokens ≤ 120000`.
  Our 750-char chunks (~1000 tokens for Chinese) × ≤50 ≈ 50k tokens — comfortably
  inside. A per-item char clamp is a safety net, not a blocker.
- The doc also shows a newer workspace-scoped host
  (`{WorkspaceId}.cn-beijing.maas.aliyuncs.com/...`). Default to the classic
  `dashscope.aliyuncs.com` host (consistent with the existing embedding call) and
  allow `KB_RERANK_URL` override. Exact endpoint is a deployment-machine 未验.

## 3. Design

### 3.1 Canonical module (`n8n/lib/kb-hybrid.mjs`)

Add inside the existing `KB-HYBRID-EMBED` region (so the drift guard covers it
automatically), mirroring the dependency-free style — `httpRequest` is **injected
like `pg`**, keeping the module importable by kb-eval and offline tests:

```js
const KB_RERANK_URL = 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
const KB_RERANK_MAX_ITEM_CHARS = 2600;   // conservative proxy for the 4000-token/item limit (Chinese)

// Rerank fused rows with a cross-encoder. Fail-open: any missing precondition or
// error returns the rows UNCHANGED (RRF order) and retrieval unchanged — never
// throws into the host. Returns { rows, retrieval, reranked }.
async function rerankKbRows(httpRequest, cfg, query, rows, topN, prevRetrieval) { ... }
```

Behavior:

- **Degrade (return `rows` unchanged, `retrieval = prevRetrieval`, `reranked:false`)**
  when: no `apiKey`, empty `rows`, empty `query`, `httpRequest` not a function,
  the call throws / non-2xx, response lacks `output.results`, or no valid index
  maps. This is the central safety property, exactly like the BM25 degrade.
- **Success**: map each `results[].index` → `rows[index]`, preserve all row fields,
  set `score = relevance_score`, `rerankScore = relevance_score`,
  `prevScore = <previous score>` (keep the pre-rerank ranking score), keep `vectorScore`.
  Slice to `topN` (clamped `1..rows.length`). `retrieval = prevRetrieval + '+rerank'`.
- **Token guard**: clamp each document and the query to `KB_RERANK_MAX_ITEM_CHARS`
  before sending; rely on fail-open for any residual 400.
- **Observable chain**: `retrieval` ∈ `vector | hybrid | vector+rerank | hybrid+rerank`.
  A silent no-op is visible (same principle as the hybrid `retrieval` flag).

### 3.2 Vendored copies + drift guard

The new region is copied **verbatim** into the three `kb_search` Code nodes
(chat-gateway Execute Tool, kb-ingest Run KB Ops, mcp-server Do MCP). The existing
`kb-hybrid.test.mjs` drift guard compares the whole region, so it covers rerank
with no new guard mechanism. Embedding is done by a one-off script that
`JSON.parse → replace region in jsCode → JSON.stringify(…,null,2)+'\n'`; all three
files were verified to **round-trip byte-identical**, so the diff stays minimal.

### 3.3 Call-site wiring (per node, outside the shared region)

After `hybridKbSearch`, change `const {rows,retrieval}` → `let` and insert:

```js
if (String($env.KB_RERANK_ENABLED || '').toLowerCase() === 'true' && rows.length) {
  const rr = await rerankKbRows((o) => this.helpers.httpRequest(o),
    { apiKey: $env.DASHSCOPE_API_KEY, model: $env.KB_RERANK_MODEL,
      endpoint: $env.KB_RERANK_URL, instruct: $env.KB_RERANK_INSTRUCT },
    QUERY, rows, Number($env.KB_RERANK_TOP_N) || K, retrieval);
  rows = rr.rows; retrieval = rr.retrieval;
}
```

- chat-gateway: `QUERY=kbq`, `K=k`; result already surfaces `retrieval`.
- kb-ingest: `QUERY=q`, `K=topK`; response already surfaces `retrieval`.
- mcp-server: variable is `hit`; **the cosine filter must change** from
  `retrieval === 'hybrid' ? hit : hit.filter(x=>Number(x.score)>0.2)` to
  `retrieval === 'vector' ? hit.filter(x=>Number(x.score)>0.2) : hit` — the >0.2
  cosine filter applies ONLY in pure vector mode; hybrid (RRF) and any rerank
  (relative score) modes skip it. The existing filter test is updated accordingly.

### 3.4 Score semantics

`score` becomes the rerank relative score in rerank mode; `vectorScore` (cosine)
and `prevScore` (the pre-rerank ranking score — RRF in hybrid mode, cosine in
vector mode) are preserved so no information is lost and callers can still inspect
them. The MCP >0.2 filter is skipped in rerank mode (it is not a cosine). No
absolute cross-request threshold is introduced.

## 4. Wiring

- **`kb-eval.mjs`**: `parseEvalFlags` gains `--rerank` (allowed set, length 1..3,
  order-independent, rejects duplicates/unknown). Flags are **orthogonal**:
  `--rerank` alone = `vector+rerank`, `--hybrid --rerank` = `hybrid+rerank`.
  `main` builds a fetch-based `httpRequest` wrapper matching the helper interface
  (`{method,url,headers,body}` → parsed JSON), calls `rerankKbRows` after
  `hybridKbSearch` when `--rerank`, and records
  `requested_mode = (hybrid?'hybrid':'vector') + (rerank?'+rerank':'')` vs the
  observed `retrieval_mode`. `--rerank` reporting `retrieval_mode` without
  `+rerank` means the rerank degraded (key/endpoint/model) — it did NOT run.
- **`.env.example`**: `KB_RERANK_ENABLED=false`, `KB_RERANK_MODEL=qwen3-rerank`,
  `KB_RERANK_URL=` (empty → module default), `KB_RERANK_TOP_N=0` (0 → use k),
  `KB_RERANK_INSTRUCT=` (optional).
- **`docker-compose.yml`**: inject the five vars into the **n8n** service (the
  Code nodes run inside n8n; `$env` reads the n8n container environment). Default
  off → zero regression.
- **CI**: **no new job and no `ci.yml` change.** The existing
  `kb-hybrid-contract-tests` job runs `kb-hybrid.test.mjs` and the eval job runs
  `kb-eval.test.mjs`; extending those files adds rerank coverage automatically.
  This also avoids a `ci.yml` merge conflict with the open P4 PR #16.
- **Schema**: **unchanged.** Rerank is a post-retrieval API call — no new table,
  index, or extension. `kb-schema.sql` is untouched.

## 5. Offline verification (this machine, no DB / no API / no network) — DONE

All green on `feat/kb-rerank-20261112`:

- **`kb-hybrid.test.mjs`: 27/27** (was 15; +12 rerank contracts). Covers: DashScope
  request-body shape (model/input/parameters/headers/timeout, default + overrides);
  `index → row` mapping and relevance reordering; `top_n` clamp `1..rows.length` +
  output slicing; per-item char clamp to `KB_RERANK_MAX_ITEM_CHARS`; partial map
  (out-of-range indices skipped, valid kept); JSON-string response; **fail-open
  degrade negative control** (14 bad shapes + a throwing `httpRequest` → same array
  reference, order unchanged, `reranked:false`, prev retrieval preserved, no throw);
  precondition skips (missing key/rows/query/non-function → **zero HTTP calls**);
  retrieval chain (`vector|hybrid` → `+rerank`, undefined prev defaults to vector).
- **`kb-eval.test.mjs` + eval group: 111/111** (`eval-contract`, `eval-mine`,
  `eval-judge`, `kb-eval`). `parseEvalFlags` `--rerank` positives (orthogonal,
  order-independent, all 3-flag permutations) + negatives (alone, duplicates,
  unknown, length>3); live-entry guard still refuses without `--isolated-stack`.
- **`validate-workflows.mjs`: 26 workflows, 0 warnings** (compose `${KB_RERANK_*}`
  ↔ `.env.example` consistent; workflow JSON valid).
- **Drift guard** over the grown region: all three Code nodes embed the canonical
  helper verbatim (now incl. `rerankKbRows`) + keep the §9.13 docs/chunks probe;
  wiring contract asserts the `KB_RERANK_ENABLED` gate, injected `httpRequest`,
  shared env config, per-node query/rows/topN args, and `let` reassignment.
- **Mutation proofs (green ≠ proof), all red then restored byte-identical:**
  (a) one-char drift in a vendored RRF region → drift guard red;
  (b) revert the mcp filter to the old hybrid-only form → filter test red;
  (c) remove the `KB_RERANK_ENABLED` wiring gate → wiring test red;
  (d) **behavioral**: extract the real `rerankKbRows` source, mutate the catch to
  rethrow, eval it → it throws on the degrade input while the real one fails open
  (proves the fail-open test is not vacuous). Post-restore: 27/27 green again.
- Remote CI: the PR runs `kb-hybrid-contract-tests`, the eval group, and
  `validate-workflows` (no `ci.yml` change); watched after push, result in the PR.

## 6. NOT verified here (未验 — deployment machine only)

1. Exact rerank endpoint + model availability (`qwen3-rerank` vs the possibly
   offline `gte-rerank-v2`; classic vs workspace-scoped host).
2. Real hit@1 / MRR gain: vector vs hybrid vs hybrid+rerank on the frozen corpus,
   and whether rerank beats the `hit@1 >= 0.80` gate by a meaningful margin.
3. Chinese chunk rerank quality on the real KB content.
4. End-to-end answer improvement (needs the agent eval, not just the retrieval ruler).

No real rerank API call is made here. The frozen 50-case corpus is a regression
ruler, not a production benchmark.

## 7. Deployment-machine commands (operator-run, after merge)

```bash
# enable rerank on a DISPOSABLE test stack (never shared KB):
#   KB_RERANK_ENABLED=true, KB_RERANK_MODEL=qwen3-rerank, DASHSCOPE_API_KEY set
node n8n/scripts/kb-eval.mjs --isolated-stack                 # vector baseline
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid        # BM25+vector RRF
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid --rerank  # + cross-encoder
# Compare hit_at_1 / mrr and retrieval_mode vs requested_mode in
# .eval-local/judge/kb-*.json. If --rerank reports a mode without '+rerank',
# the rerank degraded (key/endpoint/model) and did NOT run. Redact before publishing.
```

## 8. Rollback

- `KB_RERANK_ENABLED=false` (the default) → pure hybrid/vector, zero regression.
- Fail-open: any rerank API failure auto-degrades to RRF order, no code change.
- No schema/table/index change, no new service, no new key, no new dependency.

## 9. Resume framing (three verb tiers)

- **Authored**: the rerank stage itself — injected-`httpRequest` dependency-free
  design, fail-open degrade, score-semantics handling, drift-guarded verbatim
  vendoring across three nodes, offline contracts + mutation proofs.
- **Third-party 底座 (called, not authored)**: DashScope `qwen3-rerank` model.
- **Numbers**: gain figures only after deployment-machine measurement, and must
  survive three interview probes (what rerank changes, why relative scores break
  the cosine filter, how degrade keeps it safe).

## 10. Files changed (implemented)

| File | Change |
|---|---|
| `n8n/lib/kb-hybrid.mjs` | add `rerankKbRows` + constants inside embed region; export |
| `n8n/workflows/chat-gateway.json` | embed region + call-site wiring |
| `n8n/workflows/kb-ingest.json` | embed region + call-site wiring |
| `n8n/workflows/mcp-server.json` | embed region + call-site wiring + cosine-filter change |
| `n8n/scripts/kb-eval.mjs` | `--rerank` flag + fetch httpRequest + rerank call + report modes |
| `n8n/scripts/kb-hybrid.test.mjs` | rerank contracts + negative controls + drift + filter test |
| `n8n/scripts/kb-eval.test.mjs` | `parseEvalFlags --rerank` tests |
| `.env.example` | five `KB_RERANK_*` vars |
| `docker-compose.yml` | n8n service env injection |
| `monitoring/README.md` | rerank section |
| `AGENTS.md` | §4.4 / §5.1 / §6 + `verified_commit` |
| this doc | updated to the implemented + offline-verified delivery record |

No `ci.yml` change, no `kb-schema.sql` change.

## 11. Overlap with the open P4 PR #16

Both branch from `main` `0cb8c76`. Shared files: `docker-compose.yml` (n8n env
block), `AGENTS.md`, `monitoring/README.md`. `.env.example` edits are in different
sections (low risk). `ci.yml` is NOT touched by rerank. Whichever PR merges second
rebases — the same stacked-merge handling used for P2/P3. Rerank is independent of
P4 (different runtime files), so no functional dependency.

## 12. Candidate technique comparison (incl. Self-RAG and adaptive routing)

Mechanisms verified against primary sources: Self-RAG (Asai et al. 2023,
arXiv 2310.11511, ICLR 2024); Adaptive-RAG (Jeong et al. 2024, NAACL 2024);
2026 production guidance (mastra.ai agentic-RAG tradeoffs, meilisearch adaptive-RAG).

| Technique | Mechanism | Feasibility on this stack | Extra cost | Verdict |
|---|---|---|---|---|
| **Rerank [A]** (chosen) | cross-encoder re-scores the fused pool | ✓ same vendor/key/helper, 1 rerank API call | +1 fast/cheap rerank call | **Now**: fixes the "single-pass can't judge relevance" silent failure |
| Query rewrite / HyDE [B] | rewrite the turn into a standalone query, or embed a hypothetical answer | ✓ prompt-level (0 call) or HyDE (+1 LLM/embed) | 0 or +1 call | Follow-on: chat antecedent pain; prompt-level first |
| CRAG-lite [C] | grade evidence → re-retrieve / web fallback if insufficient | ✓ rerank score as grader (0 extra call), bounded by `MAX_TOOL_ROUNDS=2` | grading 0; correction +1 retrieval +1 LLM | Follow-on: builds on rerank; most agentic |
| Self-reflection lite | prompt the stock model to critique relevance/support before answering | ✓ pure prompt, but soft (model compliance) | +1 LLM pass per reflection | Follow-on: ≈ CRAG-lite; **NOT true Self-RAG** |
| Adaptive routing | complexity classifier → no-retrieval / single-step / multi-step | △ gateway tool-selection is already implicit routing; explicit depth router = heuristics (0 call) or +1 LLM classifier | heuristic 0; LLM router +1 call | Caution: modest marginal value on single-source KB + 2 rounds; add only with evidence |
| **Self-RAG (true)** | train an LM to emit reflection tokens (Retrieve / ISREL / ISSUP / ISUSE) | ✗ needs a fine-tuned model + expanded vocab + critic; stock DeepSeek/DashScope cannot | — | **Out**: prerequisite unmet; must NOT be claimed on a resume |
| Contextual retrieval [D] | prepend doc-level context before embedding | △ needs re-ingest + re-embed of the whole KB, changes frozen corpus | re-ingest cost | Later: heavy indexing-side |

### Key feasibility facts

- **True Self-RAG needs a trained reflection-token model** (official
  `selfrag_llama2_7b/13b`). The stack uses stock API models, so true Self-RAG is
  impossible here. The feasible cousin is prompt-based self-reflection (≈ CRAG-lite);
  labeling it "Self-RAG" would fail the three-probe resume test.
- **Adaptive routing is partially redundant**: the gateway's tool-selection loop
  already routes implicitly (the LLM chooses `kb_search` / `web_search` / direct
  answer, and may answer with no retrieval at all). The genuine delta is a
  complexity-based retrieval-DEPTH router. The original Adaptive-RAG trains a
  T5-Large classifier; the pattern is implementable with heuristics (0 extra call)
  or a zero-shot stock-LLM router (+1 call). On a single-source KB bounded to 2 tool
  rounds, the marginal value is moderate.

### Production guidance (2026)

mastra's agentic-RAG tradeoffs: *"Start simple. Build a working traditional RAG
pipeline first. Add agent orchestration only when you have evidence that
single-pass retrieval is failing."* Agentic layers cost latency/tokens (a 3-hop
query ≈ 3× cost) and add failure modes (wrong tool selection, retry loops, prompt
injection via retrieved text). Rerank is the post-retrieval quality lift that
addresses the silent-single-pass-failure mode BEFORE adding agentic orchestration.

## 13. Recommended sequence

1. **Now**: rerank [A] (implemented, offline verified). Measure vector vs hybrid vs
   hybrid+rerank on the deployment machine.
2. **If evidence shows single-pass failing** on complex/multi-hop queries: add
   CRAG-lite [C] (rerank score as grader) + a heuristic adaptive depth router as the
   agentic follow-on; self-reflection lite folds into CRAG-lite.
3. **Out / deferred**: true Self-RAG (needs a trained model), contextual retrieval
   [D] and GraphRAG (heavy re-ingest / new infrastructure).