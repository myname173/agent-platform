# KB CRAG-lite (graded corrective retrieval) — IMPLEMENTED (offline-verified), opt-in default-off

- Date: 2026-11-12
- Status: **IMPLEMENTED on branch `feat/kb-crag-lite-20261112` (base `main`
  `d044fc8`, rerank PR #17), offline-verified, awaiting the operator's typed merge
  decision.** §13 corrective-action decision = C (grade + configurable web
  fallback). The operator's typed "开分支实现" authorized implementation; the
  AskUserQuestion pick (C) authorized only the corrective-action choice. Default
  off (`KB_CRAG_ENABLED=false`) → byte-identical to today, zero regression. **Live
  efficacy is 未验** (deployment machine only); offline green proves the mechanism,
  not the benefit.
- Scope chosen by operator: **CRAG-lite first** of the RAG follow-on layers
  (rerank design §13). Query rewriting [B], true Self-RAG, contextual retrieval
  [D] and GraphRAG remain OUT. Adaptive depth routing is a later follow-on.
- Standing rules honored: no live deploy, no shared-`.env` edit, **no real web /
  rerank / embedding API call from this session** (same precedent as kb-hybrid and
  rerank). Real efficacy is the deployment machine's ruler.
- **Acceptance evidence: see §15 (offline results + on-disk mutation shakeout).**

## 1. Current boundary (verified by reading code, not assumed)

| Stage | State | Evidence |
|---|---|---|
| Agent loop | `Build Upstream Payload` (round 0, 16 static tools + wf_* + client) → `Call DeepSeek` → `Check Response` (`round < MAX_ROUNDS`, default 2) → `Needs Tools` → `Emit Tool Call Items` → `Execute Tool` → `Append Tool Results` → loop | `chat-gateway.json` |
| Round cap | `MAX_ROUNDS = Number($env.MAX_TOOL_ROUNDS \|\| 2)`; after the cap the follow-up drops tools + adds `BUDGET_NOTE`; a `tool_cap_hit` audit row is written if the model still wants tools at the cap | `Check Response`, `Append Tool Results` |
| kb_search | embedding → pg connect → `to_regclass` probe → `hybridKbSearch` → optional `rerankKbRows` → `{type:'kb', retrieval, results:[{title,seq,excerpt,score}]}`; whole branch inside a try/catch that turns any throw into `result.error` | `Execute Tool` kb_search branch |
| web_search | **inline** (not a helper): `GET http://searxng:8080/search?q&format=json`, timeout 20s, `results.slice(0,5)` → `{title,url,snippet}`; empty/dead-engine case carries a `notice` | `Execute Tool` web_search branch |
| Result → model | `Append Tool Results`: kb → `{tool, sources: res.results}` (the `retrieval` flag is **not** forwarded); web → `{tool, results, empty?, notice?}` | `Append Tool Results` |
| Grounding prompt | DIRECTIVE rule (2) cite kb as `[来源: <title>]`; rule (3) "If kb_search returns nothing relevant, say the KB does not cover it instead of guessing" | `Build Upstream Payload` |
| Grader signal available | each kb row carries `vectorScore` (cosine, absolute-ish) and `score` (cosine in vector mode, RRF in hybrid, **relative** rerank score in rerank mode) | `kb-hybrid.mjs` |
| Ruler | `kb-eval.mjs` ranks by **KB doc title** (`rows.map(r=>r.title)`), hit@1/hit@5/MRR vs `expect_title`; `--hybrid`/`--rerank` flags | `kb-eval.mjs:226` |

Two facts drive the design:

1. **The loop already lets the model call `web_search` in round 2**, and the
   DIRECTIVE biases toward *admitting ignorance* (rule 3) rather than correcting.
   So today, weak KB evidence usually produces "I don't know", not an automatic
   corrective lookup. CRAG-lite's delta is a **deterministic, graded correction
   inside one `kb_search` call** (0 extra agent rounds), not reliance on the model
   choosing to web-search.
2. **All Code nodes run in the same n8n container**, so `http://searxng:8080` is
   reachable from any of them; a web callback is just an injected `httpRequest`
   closure (the rerank injection pattern).

## 2. What CRAG is, and what "lite" means here (resume honesty)

Primary source: **Corrective Retrieval Augmented Generation**, Yan et al. 2024,
arXiv 2401.15884. Mechanism (abstract + documented detail):

- A **lightweight T5-based retrieval evaluator (~0.77B params)** scores retrieved
  documents → a confidence that triggers one of three actions:
  - **Correct** (high confidence): keep + refine via **decompose-then-recompose**
    (strip irrelevant material, keep key knowledge).
  - **Incorrect** (low confidence): **discard** the poor retrievals and **web
    search** for more reliable information.
  - **Ambiguous** (medium): **combine** refined retrieval + web search.
- Web queries are formed by a **query rewriter**; results pulled from
  authoritative sources (e.g. Wikipedia) and filtered for misinformation.

**CRAG-lite on this stack is a bounded approximation, NOT full CRAG:**

| Full CRAG | CRAG-lite (ours) |
|---|---|
| Trained T5 retrieval evaluator | **Heuristic cosine three-band grader** (0 extra call, no trained model) |
| Decompose-then-recompose strip filtering | **Not implemented** (rerank + top_k already do coarse precision) |
| Query rewriter for web search | **Original query** (query rewriting [B] is out of scope) |
| Discard poor retrievals on Incorrect | **Keep + label** KB rows, append web supplement (fail-open safety) |
| Large-scale web search + source filtering | **One bounded SearXNG call** (existing infra), top-N supplement |

It must **NOT** be claimed as "CRAG" or "Self-RAG" on a resume. True Self-RAG
needs a trained reflection-token model (impossible with stock API models); full
CRAG needs the trained evaluator + decompose-recompose + query rewriter. The
accurate label is **"CRAG-inspired graded corrective retrieval (lite)"**.

## 3. The evidence precondition (rerank design §13) — handled honestly

§13 conditions CRAG-lite on *"evidence that single-pass retrieval is failing"*,
and the mastra guidance quoted there says add orchestration only with such
evidence. **We have no live evidence yet** (rerank efficacy is 未验, deployment
machine only). Resolution, consistent with the rerank precedent:

- Build CRAG-lite as an **opt-in, default-off capability** (`KB_CRAG_ENABLED=false`),
  dormant in production → zero regression, exactly like rerank.
- Offline tests prove the **mechanism** (grade → correct → fail-open), **not** that
  it improves answers. The benefit is a **deployment-machine measurement** (agent
  answer-eval), never claimed from offline green.
- This design surfaces the precondition rather than hiding it: the operator
  decides to enable + measure on a disposable stack. The resume claim is the
  authored capability + its safety properties, with numbers gated on measurement.

## 4. Design

### 4.1 Grader — cosine three-band, NOT rerank relative score

**Correction to the rerank design §12 assumption** ("rerank score as grader"):
rerank `relevance_score` is **relative within one request** — if every chunk is
irrelevant, the best one still gets a high relative score, so it **cannot signal
absolute insufficiency**. The honest grader signal is **cosine (`vectorScore`)**,
the absolute-ish similarity the platform already trusts (the MCP `>0.2` filter).

```
grade(rows):
  if rows.length === 0            -> 'incorrect'   (nothing retrieved)
  topCos = max(vectorScore over rows, ignoring null)
  if topCos == null               -> 'ambiguous'   (no cosine evidence, e.g. all BM25-only hits)
  if topCos >= HIGH               -> 'correct'
  if topCos <  LOW                -> 'incorrect'
  else                            -> 'ambiguous'
```

- `LOW` default `0.2` (reuse the MCP cosine threshold), `HIGH` default `0.5`.
  **Both are env-configurable and their calibration is 未验** (deployment machine,
  real KB cosine distribution).
- Grading on cosine makes CRAG-lite **independent of rerank** (cosine is always
  computed by the vector leg). It works in vector, hybrid, and rerank modes.
- Hybrid caveat: a BM25-only top hit has `vectorScore=null`; the grader takes the
  max cosine across the returned rows, and an all-null pool grades `ambiguous`
  (conservative — augment, don't discard).

### 4.2 Corrective action — grade always, web fallback configurable (decision C)

**Operator decision (2026-11-12): C — grade + configurable web fallback.** The
grade always runs when CRAG is enabled; the web supplement is behind a second
switch `KB_CRAG_WEB_FALLBACK` (**default `false`** = grade-only, the safe path).
The operator runs grade-only first (observe grade distribution / trigger rate via
`kb-eval --crag`), then enables web after measuring. CRAG-faithful mapping,
"lite"-ified for safety:

- **correct** → no action; return KB rows unchanged.
- **incorrect / ambiguous** → record the grade + insufficiency signal. **If
  `KB_CRAG_WEB_FALLBACK=true`**: one bounded SearXNG web call (original query),
  append a clearly-labeled `web` supplement; **keep** the KB rows (do not discard,
  unlike full CRAG). **If false (default)**: grade-only — no web, the model is told
  KB evidence is weak and admits insufficiency (reinforces DIRECTIVE rule 3).
- Web fails / times out / bad shape → **fail-open**: `action='none'`, KB rows
  unchanged, grade still recorded. Never throw into the host.

**The private-KB caveat (genuine, newly surfaced by reading the code):** this KB
is *private internal documents*. If the KB doesn't cover a question, the public
web often won't either. So web fallback's value is **conditional** — mainly for
questions that reference public concepts, not purely-internal facts. This is why
the corrective action is the one decision worth confirming (§13), and why the
benefit must be measured, not assumed.

Alternatives considered:
- **Grade-only (0 web):** attach the grade + an insufficiency notice so the model
  admits ignorance (reinforces DIRECTIVE rule 3). Simplest, safest, no latency /
  cost / injection surface — but barely "corrective".
- **Re-retrieve with a larger pool:** without query rewriting [B] (out of scope),
  re-retrieving the same query is deterministic; a bigger `k` only adds weaker
  rows. **Marginal value**, so not the primary correction.

### 4.3 Placement — canonical module + injected web callback, drift-guarded

Mirror the rerank architecture exactly:

- Add `gradeKbEvidence(rows, cfg)` (pure) and `cragLiteKbRows(httpRequest, cfg,
  query, rows, retrieval, webCfg)` (grade + bounded correction) **inside the
  existing `KB-HYBRID-EMBED` region** of `n8n/lib/kb-hybrid.mjs`. `httpRequest` is
  injected like `pg`/rerank, so the module stays dependency-free and offline-
  testable; the web call is `httpRequest({method:'GET', url:'http://searxng:8080/search',
  qs:{q,format:'json'}, ...})` — the same SearXNG contract the inline web_search uses.
- The grown region is **vendored verbatim into all three** `kb_search` Code nodes;
  the existing drift guard covers it with no new mechanism.
- **Call-site wired in all three, opt-in default-off** (like rerank), so no
  vendored copy is dead code (honors "no dangling features"). Each injects the
  same SearXNG closure (same container). The **model-facing wiring** (Append Tool
  Results forwarding + DIRECTIVE) is **gateway-only** — mcp/kb-ingest return the
  augmented result JSON to their own callers.

### 4.4 Bounding & fail-open (central safety property)

- **One correction pass**, never recursive; the agent loop and `MAX_TOOL_ROUNDS`
  are **untouched** (correction is internal to one tool call, 0 extra rounds).
- Web call has its own timeout (`KB_CRAG_WEB_TIMEOUT_MS`, default 12s — tighter
  than the 20s standalone web_search to bound kb_search latency).
- Internal try/catch: any grade/correction error returns the **original KB rows
  unchanged** (same array reference), `action='none'`, never throws. (HTTP, not
  pg, so try/catch is effective — the §9.13 runner-kill trap does not apply.)
- `KB_CRAG_ENABLED=false` (default) → the whole stage is skipped, byte-identical
  to today's kb_search.

### 4.5 Result shape & model wiring (gateway)

```js
result = {
  type: 'kb', retrieval,
  results: [ {title, seq, excerpt, score} ],          // KB rows, unchanged
  crag: { grade, action, topCosine, webAdded },        // observable, always present when enabled
  web: [ {title, url, snippet, source:'web'} ],        // supplement, only when correction fired
};
```

- **`Append Tool Results`** (kb branch) forwards the supplement + grade:
  `{tool, sources: res.results, ...(res.web?.length ? {web_supplement: res.web} : {}),
  ...(res.crag ? {evidence_grade: res.crag.grade} : {})}`.
- **DIRECTIVE** gains a rule: when `evidence_grade` is `incorrect`/`ambiguous`, KB
  evidence is weak — **if `web_supplement` is present**, prefer it and cite it as
  `[来源:web]` (NOT as a KB title); **if absent (grade-only) or still insufficient**,
  say so honestly, don't guess. `web_supplement` is public web data, not internal KB
  documents. This covers both the web-fallback and the default grade-only path.
- Web scores are **not merged** with KB cosine/rerank scores (different scales);
  the supplement is a separate, labeled list.

### 4.6 Observability

`crag` is always attached when enabled (a silent no-op is visible — same principle
as the `retrieval` flag). `Execute Tool`'s `__trace` gains `crag_grade` /
`crag_action` (best-effort), so `chat_executions.tool_trace` can answer "did it
grade, did it correct, did web fire" — the evaluator can distinguish an honest
"KB insufficient" from a model that guessed.

### 4.7 Prompt-injection surface (honest note)

Auto-injecting public web text into a KB tool result **increases** the untrusted-
text surface (the mastra note in rerank design §12). It is not a new *class* of
risk — the standalone web_search already feeds untrusted text — but CRAG-lite
triggers it automatically. Mitigation: the supplement is labeled as web data, the
DIRECTIVE treats tool results as data not instructions, and the stage is opt-in.
This is a 未验 security consideration for the deployment-machine agent eval.

## 5. Wiring

- **`.env.example` + `docker-compose.yml` (n8n service only):** `KB_CRAG_ENABLED=false`,
  `KB_CRAG_LOW_THRESHOLD=0.2`, `KB_CRAG_HIGH_THRESHOLD=0.5`, `KB_CRAG_WEB_FALLBACK=false`,
  `KB_CRAG_WEB_URL=` (blank), `KB_CRAG_WEB_TOP_N=3`, `KB_CRAG_WEB_TIMEOUT_MS=12000`.
  Default off → zero regression; even with CRAG enabled, the default is grade-only
  (web fallback opt-in, decision C). **Deviation from the design's "six vars": a
  7th, `KB_CRAG_WEB_URL`, was added** to document the wired `$env` endpoint
  override (blank → the module default `http://searxng:8080/search`), mirroring
  rerank's `KB_RERANK_URL` knob. `validate-workflows` compose↔env consistency stays
  26/0 (every `${VAR}` is declared).
- **`kb-eval.mjs`:** a `--crag` flag (orthogonal to `--hybrid`/`--rerank`). **It
  records grade distribution + web-trigger rate only**; the title-based hit@1/MRR
  ranking still uses KB rows (web supplement has no KB title and must NOT pollute
  the ranking). **The kb-eval ruler cannot measure CRAG's answer-quality benefit** —
  that is the agent answer-eval (未验, deployment machine). `--crag` reporting a
  zero trigger rate means the grade never fired (thresholds too tight, or KB always
  sufficient) — observable, not silent.
- **CI: no new job, no `ci.yml` change.** Extend `kb-hybrid.test.mjs` (CRAG
  contracts) and `kb-eval.test.mjs` (`--crag` parser); the existing
  `kb-hybrid-contract-tests` and eval jobs pick them up. Avoids a `ci.yml` conflict
  with the open P4 PR #16.
- **Schema: unchanged.** CRAG-lite is post-retrieval grading + an HTTP web call —
  no new table, index, or extension. `kb-schema.sql` untouched.

## 6. Offline verification plan (this machine, no DB / no API / no network)

- Extend `kb-hybrid.test.mjs`: grade bands (0 rows, low/mid/high cosine, all-null
  cosine); correction trigger (incorrect/ambiguous → web called; correct → no web);
  web supplement shape + `source:'web'` labeling; **fail-open negative control**
  (web throws / times out / non-2xx / bad shape → KB rows same reference, order
  unchanged, `action='none'`, no throw); precondition skips (CRAG off → no grade /
  no web; missing web callback → grade-only); config (thresholds, web top_n,
  timeout, `KB_CRAG_WEB_FALLBACK=false` → grade-only); drift guard over the grown
  region; wiring contract (`KB_CRAG_ENABLED` gate, injected web callback, per-node
  args); model-wiring contract (Append forwards `web_supplement`+`evidence_grade`,
  DIRECTIVE has the web rule).
- Extend `kb-eval.test.mjs`: `parseEvalFlags --crag` positives/negatives (orthogonal
  combos, duplicates, unknown, order, length cap).
- Regression: rerank/hybrid contracts unchanged; eval group; `validate-workflows`
  26/0; `eval-validate`; `eval-run --dry`.
- **Mutation proofs (green ≠ proof):** (a) grade-band mutation → grader test red;
  (b) remove fail-open (catch rethrows) → behavioral proof: extracted real source
  throws on the degrade input while the real one fails open; (c) remove the
  `KB_CRAG_ENABLED` wiring gate → wiring test red; (d) revert Append forwarding →
  model-wiring test red. All red → restore byte-identical → green, no mutation left
  in the tree.

## 7. NOT verified here (未验 — deployment machine only)

1. **Threshold calibration** (`LOW`/`HIGH`) on the real KB cosine distribution.
2. **Real answer-quality gain** — agent answer-eval (NOT kb-eval): does web fallback
   improve answers, and how often does it fire usefully vs add noise.
3. **Private-KB answerability** — how often an insufficient-KB question is actually
   answerable from the public web (the §4.2 caveat).
4. **Latency / cost** of a web call inside kb_search; SearXNG reliability under the
   added load.
5. **Prompt-injection** behavior of auto-injected web text (agent security eval).
6. The extended CI jobs have not run remotely.

No real web / rerank / embedding API call is made here. Offline green proves the
mechanism, not the benefit.

## 8. Deployment-machine commands (operator-run, after merge)

```bash
# enable CRAG-lite on a DISPOSABLE test stack (never shared KB):
#   KB_CRAG_ENABLED=true, thresholds calibrated, DASHSCOPE_API_KEY set
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid --rerank --crag
#   -> records grade distribution + web-trigger rate (NOT a hit@1 gain claim)
# Answer-quality benefit is the agent answer-eval (eval-run.mjs --isolated-stack),
# comparing KB-only vs CRAG-lite on the same scenarios. Redact before publishing.
```

## 9. Rollback

- `KB_CRAG_ENABLED=false` (default) → today's kb_search, byte-identical, zero regression.
- `KB_CRAG_WEB_FALLBACK=false` → grade-only (0 web), still observable.
- Fail-open: any web failure auto-degrades to KB-only, no code change.
- No schema/table/index change, no new service, no new key, no new dependency.

## 10. Resume framing (three verb tiers)

- **Authored**: the graded corrective-retrieval stage — cosine three-band grader,
  bounded fail-open web-fallback correction, score-semantics handling, drift-guarded
  verbatim vendoring across three nodes, gateway model-wiring (supplement forwarding
  + DIRECTIVE), offline contracts + mutation proofs.
- **Third-party 底座 (called, not authored)**: SearXNG web search, DashScope
  embeddings/rerank, and the **CRAG *pattern*** (Yan et al. 2024) as inspiration.
- **NOT claimed**: full CRAG (no trained T5 evaluator, no decompose-then-recompose,
  no query rewriter), and NOT Self-RAG (no reflection tokens). Accurate label:
  "CRAG-inspired graded corrective retrieval (lite)".
- **Numbers**: answer-quality gain only after deployment-machine agent-eval, and
  must survive three probes (what the grade signals and why cosine not rerank score;
  why the correction is bounded/fail-open and 0 extra agent rounds; why it is lite,
  not full CRAG / Self-RAG).

## 11. Files changed (implementation approved + done)

| File | Change |
|---|---|
| `n8n/lib/kb-hybrid.mjs` | `gradeKbEvidence` + `cragLiteKbRows` inside embed region; export |
| `n8n/workflows/chat-gateway.json` | Execute Tool call-site + Append Tool Results forwarding + DIRECTIVE rule (9) + `__trace` |
| `n8n/workflows/kb-ingest.json` | embed region + opt-in call-site |
| `n8n/workflows/mcp-server.json` | embed region + opt-in call-site (grade + labeled web in text) |
| `n8n/scripts/kb-eval.mjs` | `--crag` flag + grade/trigger stats (no ranking pollution); GET+qs httpRequest wrapper |
| `n8n/scripts/kb-hybrid.test.mjs` | CRAG contracts + negative controls + drift + wiring + 2 behavioral mutation proofs (51 tests) |
| `n8n/scripts/kb-eval.test.mjs` | `parseEvalFlags --crag` tests (11 tests) |
| `.env.example` | seven `KB_CRAG_*` vars (incl. `KB_CRAG_WEB_URL`, §5) |
| `docker-compose.yml` | n8n service env injection (lines 79-85) |
| `monitoring/README.md` | CRAG-lite section |
| `AGENTS.md` | §4.4 / §6 + `verified_commit` `d044fc8` + `verified_scope` |
| this design doc | became this acceptance report (§15) |

No `ci.yml` change, no `kb-schema.sql` change.

## 12. Overlap with the open P4 PR #16

`main` is now `d044fc8` (rerank merged). #16 (OTel, `428ab0b`) already conflicts
with main on `AGENTS.md` (read-only merge-tree precheck). CRAG-lite adds more
`AGENTS.md` / `docker-compose.yml` / `monitoring/README.md` edits; `ci.yml` is NOT
touched. Whichever PR merges later rebases (the P2/P3 stacked-merge handling).
CRAG-lite is functionally independent of P4 (different runtime files).

## 13. Corrective action — DECIDED (operator, 2026-11-12)

**Chosen: C — grade + configurable web fallback.** The grade always runs when
CRAG is enabled; the web supplement is behind `KB_CRAG_WEB_FALLBACK` (default
`false` = grade-only safe path). Ships A's capability with B's safe default, so the
operator can run grade-only first and enable web after measuring. The alternatives
considered were:

- **(A) Web fallback + grade** (CRAG-faithful): incorrect/ambiguous → one bounded
  SearXNG supplement. Reuses existing infra; adds latency/cost/injection surface;
  benefit conditional on public answerability.
- **(B) Grade-only** (0 web): attach grade + insufficiency notice, reinforce honest
  refusal. Simplest/safest; barely "corrective".
- **(C) Grade + configurable web** ← **CHOSEN**: A with a knob (`KB_CRAG_WEB_FALLBACK`).

Everything else (cosine grader, placement, fail-open, opt-in, observability,
offline plan) is settled. Implementation still awaits the operator's typed go.

## 14. Recommended sequence

1. **Done (offline)**: CRAG-lite (this design), §13 decision C + typed "开分支实现"
   → implemented on `feat/kb-crag-lite-20261112`, awaiting typed merge decision.
2. **Next**: heuristic adaptive depth router (rerank design §12/§13) — only with
   evidence; self-reflection lite folds into CRAG-lite's grade.
3. **Out / deferred**: query rewriting [B] / HyDE, true Self-RAG (trained model),
   contextual retrieval [D], GraphRAG (heavy re-ingest / new infra).

## 15. Acceptance evidence (offline, this machine — 2026-11-12)

No database, no embeddings, no rerank API, no web call, no network. Pure functions
+ mock `pg` + mock `httpRequest` only. **Offline green proves the mechanism, not
the benefit** (§7 未验 list stands).

### 15.1 Test results

| Gate | Command | Result |
|---|---|---|
| KB hybrid + rerank + CRAG contracts | `node --test n8n/scripts/kb-hybrid.test.mjs` | **51/51** (27 pre-existing + 24 CRAG) |
| kb-eval flag parser + metrics | `node --test n8n/scripts/kb-eval.test.mjs` | **11/11** (+1 `--crag` test) |
| Eval offline contract group (CI) | `node --test eval-contract/eval-mine/eval-judge/kb-eval.test.mjs` | **112/112** |
| Workflow + compose↔env consistency | `node n8n/scripts/validate-workflows.mjs` | **26 workflows, 0 warnings** |
| Eval suite plan | `node n8n/scripts/eval-validate.mjs` | 26 cases OK |
| Eval dry plan | `node n8n/scripts/eval-run.mjs --dry --runs 3` | OK (no model calls) |

The 24 CRAG tests cover: grader three bands + boundaries (`>=HIGH`, `==LOW`,
`<LOW`) + cfg thresholds (number/string, empty→default, 0 valid); correction
trigger (correct→no web; incorrect/ambiguous→one bounded web call); web request
contract (GET SearXNG, `qs:{q,format:'json'}`, default timeout, overrides);
grade-only when fallback off (default) and string `"true"` enables it; topN clamp
1..10 + snippet clamp 300 + JSON-string response; **fail-open negative control**
(8 bad shapes + a thrower → same array reference, `action:'none'`, grade recorded,
never throw); precondition skips (empty query / non-function `httpRequest`);
retrieval passthrough across all modes; empty rows grade `incorrect`; drift guard
over the grown region + discriminating; wiring gate (`KB_CRAG_ENABLED` + injected
callback + per-node args) + discriminating; gateway Append forwards
`web_supplement`+`evidence_grade`; DIRECTIVE rule (9); `__trace` conditional; mcp
surfaces grade + labeled web; model-wiring discriminating; **2 behavioral mutation
proofs**.

### 15.2 Mutation proofs (green ≠ proof)

In-memory (self-contained, no disk write):
- **Fail-open removal**: extract the real `cragLiteKbRows` source, replace the
  catch's `return none` with `throw e`, inject `gradeKbEvidence` + constants via
  `new Function` → the web-throw degrade input **throws** while the real one fails
  open. Proves the catch is load-bearing.
- **Grade-band boundary**: mutate `topCos >= high` → `> high` → the `==HIGH`
  boundary case **misgrades** (`ambiguous` instead of `correct`); the real grader
  is correct. Proves the band test is discriminating.

On-disk shakeout (real file drift, then byte-identical restore):
- Baseline `n8n/lib/kb-hybrid.mjs` sha256
  `1a5bd70185f4cbee0e238a2411519a794fda413ff0289f35dc899dac09cee07d`.
- Mutated the **canonical module only** (`source: 'web'` → `source: 'kb'`, line
  280, inside the embed region), leaving the three vendored copies stale →
  `kb-hybrid.test.mjs` went **RED, 4 failures**: the original verbatim-embedding
  drift guard, the CRAG verbatim-embedding guard, the CRAG discriminating guard,
  **and the behavioral contract** asserting the supplement is labeled
  `source:'web'`. This proves the guards catch a *real* on-disk mislabel, not just
  an in-memory string.
- Restored → sha256 **matches baseline byte-for-byte** → suite back to **51/51**.
  No mutation left in the tree.

### 15.3 Default-off byte-identical

`KB_CRAG_ENABLED=false` (default) skips the whole stage. The result/`__trace`/
Append additions are conditional spreads (`...(crag ? {crag} : {})`,
`...(cragWeb.length ? {web} : {})`, `...(res.crag ? {evidence_grade} : {})`); mcp's
`cragNote` stays `''`. So with CRAG off the kb_search result, trace and model-facing
content are byte-identical to the pre-CRAG rerank layer. Zero regression.

### 15.4 Not done here (未验 — deployment machine, §7)

Threshold calibration, real answer-quality gain (agent answer-eval, NOT kb-eval),
private-KB public answerability, web latency/cost + SearXNG reliability,
prompt-injection behavior of auto-injected web text, and the remote CI run. No
real web/rerank/embedding API call was made. The PR's CI is watched but the live
efficacy ruler is the operator's, on a disposable stack.