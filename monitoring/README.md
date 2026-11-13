# Platform Observability

Phase 1.3 keeps one business-facing source of truth and one infrastructure
metrics path:

- Console `/webhook/v1/stats/executions` remains the business view for request
  totals, success/error rate, average latency, token usage, cost and recent
  tool traces. Alerts consume the same stats API.
- `platform-runtime:3220/metrics` exposes Redis admission, rate-limit, lock,
  durable state and request latency metrics.
- `stream-bridge:3211/metrics` exposes request count, errors, rate limiting and
  latency metrics.
- `platform-outbox-publisher:9101/metrics` and
  `platform-event-consumer:9102/metrics` expose outbox queue state and
  idempotent-consumption counters. They only exist while the optional
  `event-bus-outbox` profile is running; Prometheus reports these targets down
  when the profile is stopped (expected, see `monitoring/prometheus.yml`).
- The K8s sandbox gateway exposes admission counters and Job latency on
  `:8080/metrics` (host view: `http://127.0.0.1:18080/metrics` through the
  pilot bridge). It lives in Kubernetes, not Compose, so the Compose
  Prometheus does not scrape it by default; the bridge is loopback-only and
  not reachable from containers via `host.docker.internal`.

Prometheus is only for internal runtime metrics. Grafana and a second business
metrics exporter are intentionally not part of this stack, so Console and
Prometheus do not duplicate business dashboards or develop separate metric
definitions.

Prometheus is in the optional `observability` profile and is bound to localhost
on `PROMETHEUS_PORT` (default `9090`):

```powershell
docker compose --profile observability up -d prometheus
```

The runtime-only baseline load test is safe to run against the internal service
and does not call an upstream model:

```powershell
docker compose exec -T platform-runtime npm run test:load
```

It reports p50/p95/max latency and verifies one-winner idempotency, rate-limit
cutoff and lock contention. The baseline is recorded in
`monitoring/baseline-2026-10-28.md`.

The read-only end-to-end business baseline crosses the host, n8n webhooks,
workflow execution and Postgres/Data Tables. It covers the Console's stats,
overview and settings APIs plus people/todo reads; it deliberately makes zero
model calls and zero business writes:

```powershell
node --env-file=.env n8n/scripts/e2e-business-load.mjs
```

Tune `E2E_REQUESTS_PER_ENDPOINT`, `E2E_CONCURRENCY` and `E2E_TIMEOUT_MS` for a
larger run. The latest 100-request result is recorded in
`monitoring/e2e-business-2026-10-29.md`.

## Phase 4.1 Agent quality and security

The first Agent evaluation is deliberately local and deterministic. It uses
the live Chat Gateway for a small tool-selection/client-tool set and the K8s
Sandbox Gateway for authentication, network/process/dynamic-execution/file
write policy checks. It adds no service, database, package or LLM judge:

```powershell
node --env-file=.env n8n/scripts/agent-eval.mjs
```

The command prints per-case results and a JSON report. Set
`EVAL_SANDBOX_URL` when the loopback Pilot bridge is not at
`http://127.0.0.1:18080`. A non-zero exit means at least one quality or
security contract failed.

The 2026-10-29 baseline is recorded in
`monitoring/agent-eval-2026-10-29.md`.

Phase 4.2 extends the same command with user-content prompt injection,
unregistered MCP tool calls, temporary KB poisoning and task-level answer
scoring. The KB fixture is created with a unique title and retired in a
`finally` cleanup path; a failed cleanup makes the command fail:

```powershell
node --env-file=.env n8n/scripts/agent-eval.mjs
```

The evaluator reads `chat_executions.tool_trace` for required and forbidden
tool assertions. It does not use an LLM judge: each task score is based on
required facts, forbidden markers, answer length and source/citation markers.

## Phase 4.3 assertion hardening

The same command now reads the server tool list from the chat gateway
workflow instead of carrying a copy of it, and a case that names a tool the
gateway does not have aborts the run instead of passing quietly. The network
case asserts against the platform's own tool trace — the trace records
whether the sandbox refused — rather than against a word in the answer. The
sandbox refuses code in two layers: the text scan, and a runtime guard inside
the child that refuses a renamed import, a renamed builtin, a write, a spawn
and a socket call.

The result, including what was not run, is recorded in
`monitoring/agent-eval-2026-11-05.md`.

## Evaluation foundation: shakedown is not release acceptance

PR #8 introduced 26 local scenarios (16 quality, 10 security), a trace miner,
judge and replay gate. Its two original CI checks did not execute this harness.
The follow-up adds offline contract tests with negative controls to CI. These
checks validate the measurement code, not actual model task success.

```powershell
node n8n/scripts/eval-validate.mjs
node n8n/scripts/eval-run.mjs --dry --runs 3
node --test n8n/scripts/eval-contract.test.mjs n8n/scripts/eval-mine.test.mjs n8n/scripts/eval-judge.test.mjs n8n/scripts/kb-eval.test.mjs
node --env-file=.env n8n/scripts/eval-run.mjs --preflight
```

Read-only check on 2026-11-10: local n8n :5678 and runtime :13220 health
endpoints returned 200; `eval_runs` / `eval_results` were absent and the active
Chat Stats API lacked eval-traffic isolation. The dependency is therefore
**deployment readiness**, not an assumed offline stack. No workflows were
deployed by this check. Do not run a blanket deploy against the shared instance
without reviewing its live/source drift and coordinating with the other agent.

After an isolated test deployment is chosen and prepared, the shakedown command
is:

```powershell
node --env-file=<isolated-test-env> n8n/scripts/eval-run.mjs --isolated-stack --deterministic-only --runs 3 --record
node n8n/scripts/eval-gate.mjs --replay-dir .eval-local/replay/<run-id> --runs 3
```

`--isolated-stack` is an operator acknowledgement, not a technical sandbox.
These scenarios can create reminders/todos or, on an injection failure, cancel
existing records. Do not point this command at shared business data. Each real
user turn is sent after the previous real assistant answer: 26 x 3 means 78
attempts and **84 gateway requests**, not 78 model calls. Tool loops add an
unknown number of upstream calls. The budget stops before the next request;
one in-flight request may overshoot. Missing cost telemetry stops the run.

Live and replay share one assertion engine. Missing traces, empty responses,
unsupported assertions and incomplete fixture coverage fail closed. Fixtures
contain every attempt, not only successes, and bind case/suite/harness hashes.
A replay pass checks recorded observations only; it does not test the current
remote gateway. `pass_1`, `pass_k` (all k attempts), and `pass_at_k` (at least
one) are separate. Incomplete runs expose observed statistics but no comparable
baseline TSR/pass-k. Database persistence must pass read-back verification.

The runner deliberately marks judge quality and final database-state assertions
as unfinished; `--deterministic-only` cannot produce `release_ready=true`.
The judge calibration skeleton is not human-labeled evidence. KB retrieval
uses answerable queries as its denominator; unanswerable cases remain pending
answer evaluation, not retrieval failures or demonstrated correct refusals.

```powershell
node n8n/scripts/eval-mine.mjs --dry --days 3
node --env-file=.env n8n/scripts/eval-mine.mjs --days 3
```

Mining reads source rows only. Candidate reports and raw reports/replays default
to ignored `.eval-local/` directories; review and redact before publishing
anything to this public repository. Candidate count is not failure count, and
three days of retrospective rows is not three consecutive successful scheduled
runs. No nightly schedule has been installed. Reaching 60 reviewed cases,
collecting complete live fixtures, human calibration, and three comparable
baseline batches remain separate acceptance steps.

Local verification on 2026-11-10: 110 offline tests passed with zero skips and
26 workflow files validated with zero warnings. Four CLI negative controls
rejected missing replay fixtures (exit 1), the unfinished calibration skeleton,
KB execution without isolation confirmation, and a NaN repeat count (exit 2).
The new CI job has not run remotely; these are local checks, not live acceptance.
One read-only mining run (`--days 3 --limit 2000`) covered
2026-11-07T09:07:55.951Z through 2026-11-10T09:07:55.951Z with zero in-window
executions, messages or candidates, without truncation. Both source tables'
latest records were still dated November 2; zero candidates is not a health verdict.

## KB hybrid retrieval (Agentic RAG)

KB retrieval gained an optional BM25 full-text leg fused with the pgvector ANN
leg via Reciprocal Rank Fusion. The canonical helper lives in
`n8n/lib/kb-hybrid.mjs` and is embedded verbatim in the three `kb_search` Code
nodes (chat-gateway, kb-ingest, mcp-server); a drift guard fails CI if a copy
diverges. Retrieval **degrades to vector-only** whenever `pg_search` / the
`kb_chunks_bm25` index is absent, so the current live stack (extension available
but not installed) is unchanged. The schema addition is guarded, idempotent and
failure-tolerant.

Offline contracts (RRF, availability, degradation, drift, schema) are in
`n8n/scripts/kb-hybrid.test.mjs` and run in the `kb-hybrid-contract-tests` CI
job. **Retrieval efficacy is not measured offline.** The before/after ruler is
operator-run on the deployment machine:

```powershell
docker exec -i postgres psql -U n8n -d n8n < n8n/scripts/kb-schema.sql
node n8n/scripts/kb-eval.mjs --isolated-stack            # vector baseline
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid   # BM25+vector RRF
```

Compare `hit_at_1` / `mrr` and `retrieval_mode` vs `requested_mode` in the
`.eval-local/judge/kb-*.json` reports; `--hybrid` reporting `retrieval_mode=vector`
means the index is missing and hybrid did not run. Design, offline results,
mutation proofs and the full 未验 list are in
`monitoring/kb-hybrid-search-2026-11-12.md`.

## KB rerank (post-retrieval cross-encoder)

An optional cross-encoder rerank layer sits **after** RRF fusion and **before**
the result is formatted. It calls DashScope (阿里百炼) `qwen3-rerank` with the
**same vendor, same `DASHSCOPE_API_KEY` and same `this.helpers.httpRequest`** as
the embeddings — no new service, dependency or secret. The canonical
`rerankKbRows` lives in the same `KB-HYBRID-EMBED` region of
`n8n/lib/kb-hybrid.mjs` (`httpRequest` injected like `pg`, so the module stays
importable offline) and is embedded verbatim in the same three `kb_search` Code
nodes; the existing drift guard covers it with no new mechanism.

It is **opt-in, default off** (`KB_RERANK_ENABLED=false`): the five `KB_RERANK_*`
vars are injected into the n8n service only, so the live stack is unchanged.
**Fail-open degrade is the central safety property** — a missing key, empty
query/pool, non-function `httpRequest`, API error/non-2xx, missing
`output.results` or unmappable index all return the fused pool **unchanged**
(same array reference, RRF order, `reranked:false`) and never throw into the
host. Rerank is HTTP, not pg, so the try/catch is effective (the §9.13
runner-kill trap does not apply). On success `score` becomes the rerank relative
score (0..1, **not a cosine, not cross-request comparable**); the prior score is
kept in `prevScore` and `vectorScore` is preserved. The `retrieval` flag chain is
now `vector | hybrid | vector+rerank | hybrid+rerank`. The MCP `score>0.2` filter
applies **only in pure vector mode** (RRF and rerank scores are not cosines). No
table, index or extension changes; `kb-schema.sql` is untouched.

Offline contracts (request shape, index mapping, clamps, fail-open negative
controls, drift, behavioral mutation proof, wiring) are in
`n8n/scripts/kb-hybrid.test.mjs` (27 tests) and the `--rerank` flag parser is
covered in `kb-eval.test.mjs`; both run in the existing CI jobs (no `ci.yml`
change). **Rerank efficacy is not measured offline and no real rerank API call
was made here.** The before/after ruler is operator-run on the deployment
machine:

```powershell
node n8n/scripts/kb-eval.mjs --isolated-stack                    # vector baseline
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid           # BM25+vector RRF
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid --rerank  # + cross-encoder
```

`--rerank` is the ruler's explicit toggle, independent of the production
`KB_RERANK_ENABLED` switch. Compare `hit_at_1` / `mrr` and `retrieval_mode` vs
`requested_mode`; `--rerank` reporting a mode **without** `+rerank` means the
rerank degraded (key/endpoint/model) and did NOT run. Design, offline results,
mutation proofs, the Self-RAG/adaptive-routing comparison and the full 未验 list
are in `monitoring/kb-rerank-design-2026-11-12.md`.

## KB CRAG-lite (graded corrective retrieval)

An optional **graded corrective-retrieval** layer sits **after** retrieval/rerank
and **before** the result is formatted — a bounded, "lite" approximation of CRAG
(Yan et al. 2024, arXiv 2401.15884), **not full CRAG and not Self-RAG** (no trained
T5 evaluator, no decompose-then-recompose, no query rewriter, no reflection
tokens). The canonical `gradeKbEvidence` (pure) + `cragLiteKbRows` (grade + bounded
correction) live in the same `KB-HYBRID-EMBED` region of `n8n/lib/kb-hybrid.mjs`
(the web callback is an injected `httpRequest`, so the module stays importable
offline) and are embedded verbatim in the same three `kb_search` Code nodes; the
existing drift guard covers them with no new mechanism.

The grader is a **cosine three-band** rule on `vectorScore` — **not** the rerank
relative score (which is within-request and cannot signal absolute
insufficiency): `topCos >= HIGH (0.5)` → `correct`, `< LOW (0.2)` → `incorrect`,
between → `ambiguous`; 0 rows → `incorrect`, all-null cosine → `ambiguous`.
`LOW`/`HIGH` are env-configurable and **their calibration is 未验**. Because it
grades on cosine, CRAG-lite is **independent of rerank** (vector/hybrid/rerank all
work). It is **opt-in, default off** (`KB_CRAG_ENABLED=false`): the seven
`KB_CRAG_*` vars are injected into the n8n service only, so the live stack is
byte-identical to today.

**Decision C — grade always, web fallback configurable.** The grade always runs
when enabled; the web supplement is behind a second switch `KB_CRAG_WEB_FALLBACK`
(**default `false`** = grade-only, the safe path). `correct` → no action;
`incorrect`/`ambiguous` → record the grade + insufficiency signal, and **only if
web fallback is on** make **one bounded SearXNG call** (original query, no
rewriter), **keep + label** the KB rows (not discard, unlike full CRAG) and append
a `source:'web'` supplement. **Fail-open is the central safety property** — any
web error/timeout/non-2xx/bad shape returns the KB rows **unchanged** (same array
reference, `action:'none'`, grade still recorded) and never throws into the host
(HTTP, not pg, so the §9.13 runner-kill trap does not apply). The correction is
**internal to one `kb_search` call (0 extra agent rounds)**; `MAX_TOOL_ROUNDS` is
untouched. The `retrieval` flag chain is unchanged (CRAG is orthogonal);
observability is a separate `crag:{grade,action,topCosine,webAdded}` object plus
`Execute Tool`'s `__trace.crag_grade/crag_action`. Gateway model-wiring forwards
`web_supplement` + `evidence_grade` and adds DIRECTIVE rule (9): on
`incorrect`/`ambiguous`, prefer the web supplement and cite `[来源:web]` (not a KB
title), else admit insufficiency honestly. No table/index/extension/service/key/
dependency changes; SearXNG is reused and `kb-schema.sql` is untouched.

**Private-KB caveat:** this KB is private internal documents, so a question the
KB cannot answer is often unanswerable from the public web too — web fallback's
value is **conditional** and must be measured, not assumed.

Offline contracts (grade bands/boundaries/config, correction trigger, web request
shape, `source:'web'` labeling, clamps, **fail-open negative controls**,
precondition skips, retrieval passthrough, drift, wiring + model-wiring guards,
and **two behavioral mutation proofs**) are in `n8n/scripts/kb-hybrid.test.mjs`
(51 tests) and the `--crag` flag parser is covered in `kb-eval.test.mjs` (11
tests); both run in the existing CI jobs (no `ci.yml` change). An on-disk mutation
shakeout (mislabel `source:'web'`→`'kb'` in the canonical module only) turned the
drift + behavioral guards **red (4 failures)**, then restored byte-identical →
green. **CRAG efficacy is not measured offline and no real web/rerank/embedding
API call was made here.** `kb-eval --crag` records **grade distribution +
web-trigger rate only** — the title-based hit@1/MRR ranking still uses KB rows
(the web supplement has no KB title and must not pollute it), so the ruler
**cannot** measure CRAG's answer-quality benefit. That is the agent answer-eval
(未验, deployment machine):

```powershell
node n8n/scripts/kb-eval.mjs --isolated-stack                          # vector baseline
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid --rerank        # + cross-encoder
node n8n/scripts/kb-eval.mjs --isolated-stack --hybrid --rerank --crag # + grade/web-trigger stats
```

`--crag` is the ruler's explicit toggle, independent of the production
`KB_CRAG_ENABLED` switch; a zero web-trigger rate means the grade never fired
(thresholds too tight, or KB always sufficient) — observable, not silent. Design,
offline results, mutation proofs, the full-CRAG/Self-RAG honesty boundary and the
complete 未验 list are in `monitoring/kb-crag-lite-design-2026-11-12.md`.

## web_fetch (search → select → fetch → read follow-up layer)

An optional **fetch-and-read** tool closes the snippet-only gap in the web leg:
`web_search` returns `{title, url, snippet(≤300)}` cards, so the agent could
*discover* public pages but never *read* them ("版本待核实" was structural, not a
prompt choice). `web_fetch(url)` lets the model **select** an authoritative result
and read its **full text**, then ground the answer in the page and cite `[来源:<url>]`.
It is a **bounded approximation, NOT a browsing agent**: one HTTP GET per call (no
headless browser, no JS rendering, no crawl), a **heuristic pure-JS HTML→text
stripper** (no readability/cheerio dep — the Code-node sandbox allows only `pg` +
builtin `crypto`), and a hostname/literal-IP SSRF guard with redirects disabled.

The canonical module `n8n/lib/web-fetch.mjs` (`assertPublicUrl` + `isPrivateIPv4/6`
+ `decodeEntities` + `extractReadableText` + `sanitizeUntrusted` + `fetchWebPage`,
`httpRequest` injected like pg/rerank/CRAG so it imports offline) is embedded
**verbatim in one node** — `chat-gateway` Execute Tool. It is a **new tool, not a
kb_search stage**, so it deliberately does **not** live in the `KB-HYBRID-EMBED`
region; `mcp-server.json` / `kb-ingest.json` are untouched (**gateway-only v1**,
decision D3). `web-fetch.test.mjs` carries the drift guard.

**SSRF guard is the central security property** — `assertPublicUrl` runs **before
any network call** and denies non-http schemes, userinfo, loopback/RFC1918/
link-local + cloud-metadata (`169.254.169.254`)/CGNAT/ULA/multicast literals
(including the URL-normalized `127.1` / `0x7f000001` / `2130706433` bypass forms and
a deny-all on `::ffff:` IPv4-mapped), internal service names, single-label hosts,
`.internal/.local/.localhost` and the `.nip.io/.sslip.io/.xip.io` wildcard-DNS
rebinding suffixes. A denied URL returns `{ok:false, reason:'blocked_private_url'}`
with **zero** `httpRequest` calls (negative control + a public-URL positive control).
**Fail-open** — timeout / non-2xx / 3xx redirect / bad content-type / oversized body
/ a throwing client all return `{ok:false, url, reason}` and **never throw into the
host** (HTTP, not pg, so the §9.13 runner-kill trap does not apply). **Bounding** —
one URL per call, no recursion, `MAX_TOOL_ROUNDS` untouched (search→fetch→answer
fits the default 2 rounds; multi-page needs ≥3), timeout 12s, text clamp 6000 chars,
and `WEB_FETCH_MAX_BYTES` is a best-effort `content-length` gate + post-download
char-proxy slice (**not** a streaming download cap — `httpRequest` exposes none).

**Prompt-injection handling reduces, does not eliminate, the surface:**
`sanitizeUntrusted` strips C0/C1 control chars and wraps the text in a
`<<<UNTRUSTED_WEB_CONTENT url=…>>>` delimiter; DIRECTIVE rule (10) tells the model
the text is **quoted source data, not instructions**, to cite the URL, and to admit
"could not read" on `ok:false` rather than fabricate. It is **opt-in, default off**
(`WEB_FETCH_ENABLED=false`): the six `WEB_FETCH_*` vars are injected into the n8n
service (execution) and `WEB_FETCH_ENABLED` into stream-bridge (advertise-only,
`SERVER_TOOLS` sync per §9.4). Off → the static table stays **16**, the system
prompt is byte-identical, and the Execute Tool branch is unreachable (a smuggled
`web_fetch` falls through to `unknown tool`); on → **17**. `web_fetch` is **not** in
`SIDE_EFFECT` (read-only). Observability is `__trace.web_fetch_{ok,host,chars,reason}`
(**no full text**). No table/index/extension/service/key/dependency change;
`kb-schema.sql` untouched.

**Residual risks (honest, 未验):** `dns` is **not** allowlisted, so resolve-time IP
pinning is structurally impossible — arbitrary **DNS-rebinding** (a public name
resolving to a private IP) remains a residual, mitigated only for the known
wildcard-DNS services. Whether n8n `httpRequest` honors `followRedirect:false`, the
byte-cap availability, real-page extractor quality (boilerplate leak / JS-rendered
miss), injection behavior, latency/cost and round-budget pressure are all
deployment-machine questions.

Offline contracts (SSRF negative + positive controls, IP-range boundaries, entity
decode, heuristic extractor incl. the boilerplate-leak / JS-missed honesty cases,
sanitizer delimiter + control-char strip, `fetchWebPage` success shape +
**zero-call-on-deny** + fail-open + every gate + JSON/Buffer/object bodies + cfg
number/string parsing, verbatim drift guard, **gateway-only** assertion, Execute
Tool wiring, **behavioral** opt-in registration running the real gateway Code node
(16 off / 17 on / 0 when tools disabled) + DIRECTIVE rule (10) gating, **behavioral**
Append forwarding, bridge `SERVER_TOOLS` 16/17 + name-set sync) are in
`n8n/scripts/web-fetch.test.mjs` (**42 tests**) with **5 in-memory mutation proofs**
(disable private-IP deny → guard allows loopback; same mutant → 1 http call on a
private URL vs the real 0; remove fail-open catch → throws; flip opt-in always-on →
17 when env=false; mutate canonical → drift red). A new CI job
`web-fetch-contract-tests` runs it (no deps, no network). An **on-disk mutation
shakeout** (canonical drift, vendored-copy drift, gate always-on) turned the
corresponding guards **red**, then restored **byte-identical (SHA-256 verified)** →
green; no mutation left in the tree. Regression stayed green: kb-hybrid **51**,
validate-workflows **26/0**, eval offline group **112**.

**web_fetch efficacy is not measured offline and no real web/fetch/embedding API
call was made here.** `kb-eval` (KB-title hit@1/MRR) **cannot** measure it —
web_fetch is not a KB stage. The ruler is the **agent answer-eval** on a disposable
isolated stack (未验, deployment machine): enable `WEB_FETCH_ENABLED=true` (never
shared production), then compare snippet-only vs search+fetch on the same public-web
scenarios; SSRF/injection behavior is a separate security eval. Design, offline
results, mutation proofs, the browsing-agent/readability/injection-proof honesty
boundary and the complete 未验 list are in
`monitoring/web-fetch-design-2026-11-13.md`.

## Phase 2 async KB save

The Redis Streams worker is optional and only handles `kb_save`:

```powershell
$env:PLATFORM_KB_ASYNC_ENABLED = 'true'
docker compose --profile phase2 up -d platform-worker
```

When enabled, the entry request returns `202` with a `task_id`; the worker
executes the existing KB workflow and runtime stores the final result. Leave
`PLATFORM_KB_ASYNC_ENABLED=false` to keep the synchronous path.

Phase 2.1 adds bounded worker recovery: stale Redis Stream deliveries are
claimed after `PLATFORM_JOB_CLAIM_IDLE_MS` (default 120 seconds), retryable
network/5xx/429 failures are retried up to `PLATFORM_JOB_MAX_ATTEMPTS` (default
3), and terminal failures are recorded as `FAILED`. The worker ACKs a message
only after a terminal runtime completion; a completed job reclaimed after a
worker restart is recognized as terminal and is only ACKed.

The repeatable regression requires the flag and worker to be active:

```powershell
node --env-file=.env n8n/scripts/test-kb-async.mjs
```

The recovery regression temporarily manages the worker and n8n containers:

```powershell
node --env-file=.env n8n/scripts/test-kb-async-recovery.mjs
```

## Phase 5.0 Release Gate

The lightweight Pilot release gate reuses the checks above plus the read-only
business baseline, platform boundary regression and Agent evaluation. It does
not add a runner or change runtime configuration. The 2026-10-29 result is
recorded in `monitoring/release-gate-2026-10-29.md`.

## Phase 5.1 Pilot closeout

The operational runbook for the current Docker Desktop Pilot covers startup,
the smallest routine checks, failure triage, controlled rollback to Compose and
the explicit non-production limits:
`monitoring/pilot-runbook-2026-10-29.md`.

The first Phase 5.2 capacity baseline and Kafka decision are recorded in
`monitoring/phase5.2-capacity-decision-2026-10-29.md`.

## Phase 5.2A external access boundary

The opt-in external Compose overlay removes direct application/storage host
ports, terminates public TLS at Caddy on `80/443`, and keeps Redis, Runtime,
Worker and the Kubernetes Sandbox Gateway private:
`deploy/external/README.md`.

## Phase 6.5A Release Candidate freeze

The first production closeout step is intentionally read-only. It verifies
that the default Compose service set contains only the core stack, optional
Kafka/Outbox/Prometheus/Worker profiles stay opt-in, the K8s pilot manifests
still render, and the local Console/n8n/Runtime/Redis health boundary is up:

```powershell
.\deploy\release\phase65a.ps1 -Action check
```

The command reports whether the current `.env` is using the `compose-sync` or
`pilot-async` boundary and never changes services or business data. A passing
check is a Release Candidate configuration check, not a production HA approval.

## Phase 6.5C K8s production-candidate boundary

The production-candidate overlay keeps the existing Pilot base but adds two
replicas, RollingUpdate, PDBs and Sandbox Gateway probes. It is render-only
until a real multi-node or managed cluster is selected:

```powershell
kubectl kustomize deploy/k8s/phase6-production
kubectl apply --dry-run=server -k deploy/k8s/phase6-production
```

The current `docker-desktop` context remains the one-replica Pilot. Before an
apply, replace its Docker Desktop host-gateway endpoints with target-cluster
Service or managed-service endpoints and make the stateful-service ownership
explicit.

## Kind multi-node verification (P2)

`deploy/k8s/phase6-kind/` verifies the production-candidate boundary on a
disposable local kind cluster (1 control-plane + 2 workers): replica spread,
zero-unavailable rolling restart, PDB-blocked second drain, and per-pod
admission e2e. An isolated `redis-drill` fixture keeps the drill away from the
live Compose Redis; the worker kb_save business path is not exercised.

```bash
node deploy/k8s/phase6-kind/kind-pilot.mjs render   # offline, kubectl only
node deploy/k8s/phase6-kind/kind-pilot.mjs all      # operator-run drill
node deploy/k8s/phase6-kind/kind-pilot.mjs delete   # remove the cluster
```

Offline contracts run in CI; the cluster drill is operator-run on the
deployment machine. kindnet does not enforce NetworkPolicy, and this is local
multi-node verification, not production HA. Evidence and the live-drill status
are recorded in `monitoring/kind-multinode-2026-11-12.md`.

## Kind elastic drill (P3)

`deploy/k8s/phase6-production/components/elastic/` is an opt-in Kustomize
Component adding two CPU-utilization HPAs (worker min 2/max 6, gateway
min 2/max 4, target 70%, 300s scale-down stabilization) and deleting
`spec.replicas` from both Deployments. The base render stays
static-two-replica. `deploy/k8s/phase6-kind-elastic/` composes it onto the P2
kind boundary with drill-only tweaks (30s stabilization, raised admission
budgets); `kind-pilot.mjs elastic` installs the vendored metrics-server
v0.9.1, drives 16-way parallel `/run` load, asserts gateway scale-out > 2 and
≤ 4, asserts the idle worker stays at 2 (negative control), waits for
scale-in, and restores the static boundary even on failure.

```bash
node deploy/k8s/phase6-kind/kind-pilot.mjs render-elastic  # offline, kubectl only
node deploy/k8s/phase6-kind/kind-pilot.mjs elastic         # after `all`, operator-run
```

CPU is a placeholder metric for these I/O-bound services; custom/external
metrics (prometheus-adapter) are the documented follow-up. The live drill is
operator-run; evidence and 未跑 items are recorded in
`monitoring/kind-elastic-2026-11-12.md`.

## Phase 5.3 Kafka event-bus pilot

Kafka is available as an opt-in single-node KRaft profile for event-contract
and produce/consume validation. It does not replace the Redis Streams
`kb_save` queue. See `deploy/event-bus/README.md`.

The P0 consumer-side closure adds an idempotent consumer
(`platform-runtime/event-consumer.js`, ledger `platform.consumed_events`) and
outbox queue metrics on the publisher. The contract is covered by offline
tests (`npm run test:consumer` in `platform-runtime`); the live closed-loop
check (`deploy/event-bus/consumer-pilot.ps1 -Action check`) passed on
2026-11-12 and is recorded in `monitoring/consumer-closure-2026-11-12.md`.

## Runtime `.env` key audit (2026-11-05)

Recorded in `monitoring/env-ledger-2026-11-05.md`. Two silent-failure findings on
the local `.env` (never tracked; no secret values recorded): `ALERT_WEBHOOK_URL`
is empty while `docker-compose.yml:91` falls back with `:-`, so alert pushes have
no downstream and nothing errors; and `ADMIN_PASSWORD_HASH` is assigned twice
(empty early, real value later). A throwaway-file test showed Compose honours the
**last** assignment, so the Phase 6.1 external-edge requirement below is currently
met — but the ordering is fragile, and the two compose files disagree on failure
mode (`:-` stays silent, `:?` in `deploy/external/` fails loudly). Recommended
fix is a manual `.env` edit, not a scripted one.

## Phase 6.1 external access boundary

The Sandbox Gateway now uses a supervised loopback-only bridge at
`127.0.0.1:18080`, with a current-user scheduled task that reconnects after
Docker/Kubernetes restarts. The external Caddy edge remains opt-in and refuses
to start until a real `PLATFORM_DOMAIN`, `ACME_EMAIL` and
`ADMIN_PASSWORD_HASH` are present in `.env`. Use `deploy/external/edge.ps1` for
the preflight and lifecycle commands.

When the router cannot provide inbound port forwarding, use the router-
independent Cloudflare Tunnel overlay in `deploy/cloudflare/README.md`. It
keeps the local Caddy path intact and adds an outbound-only `cloudflared`
connector on the existing Docker network.
