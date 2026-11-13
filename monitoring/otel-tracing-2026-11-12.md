# P4 OpenTelemetry cross-service tracing — build-here / verify-continuity-on-deployment

- Date: 2026-11-12
- Branch: `feat/otel-tracing-20261112` (base `main` @ `0cb8c76`)
- Scope authorized: "按完整方案开分支实现" — the FULL P4 plan: one canonical
  tracer vendored into both Node services, n8n native OTel wiring, an opt-in
  `tracing` profile (otel-collector + Jaeger), offline contracts with negative
  controls, and a disposable-collector OTLP acceptance check. Not phased.
- Standing rule honored: no live deploy to the shared stack, no shared-`.env`
  edit, no real model calls. The one live run here is the **disposable, isolated**
  collector acceptance the plan explicitly names — throwaway containers on a
  separate network/ports, removed afterward; the shared stack was never touched.
  Integration is branch → PR → CI → operator merge.

## What changed

| File | Change |
|---|---|
| `monitoring/otel/tracer.js` | New canonical, dependency-free **CommonJS** tracer: W3C traceparent parse/format, span lifecycle, OTLP/HTTP **JSON** export. Exports `createTracer, parseTraceparent, formatTraceparent, toAttributes, SPAN_KIND, STATUS`. |
| `stream-bridge/tracer.js` | Verbatim vendored copy (`.js` = CJS; the bridge runs on a stock image with no `package.json`). |
| `platform-runtime/tracer.cjs` | Verbatim vendored copy (`.cjs` because the package is `"type":"module"`; loaded via `createRequire`). Byte-identical to canonical. |
| `stream-bridge/server.js` | SERVER root span per inbound request + CLIENT spans for runtime / gateway / upstream(stream) / gateway(fallback) calls; `inject`/`extract` propagation; fail-open; shutdown flush registered **only when enabled**. |
| `platform-runtime/server.js` | SERVER span that `extract`s the traceparent injected by the bridge CLIENT span; business `trace_id` attached as an attribute; `createRequire('./tracer.cjs')`; shutdown flush. |
| `platform-runtime/Dockerfile` | `COPY tracer.cjs ./`. |
| `docker-compose.yml` | n8n `N8N_OTEL_*` env (2.37.7-available vars only); bridge/runtime `OTEL_*` env; new opt-in `tracing` profile (`otel-collector` + `jaeger`, loopback-only). |
| `monitoring/otel/otel-collector-config.yaml` | OTLP receiver (gRPC :4317 + HTTP :4318), batch processor, `otlp/jaeger` + `debug` exporters, `health_check` extension. |
| `.env.example` | 8 tracing vars, all defaulted off/empty. |
| `monitoring/otel/tracer.test.mjs` | 18 offline contracts (node:test, dependency-free, fake recording fetch). |
| `monitoring/otel/otlp-acceptance.mjs` | Disposable collector+Jaeger end-to-end acceptance using the REAL canonical tracer; isolated network/containers/ports; always cleans up. |
| `.github/workflows/ci.yml` | New `otel-tracing-contract-tests` job (8th; offline, no collector). |

## Design

- **One canonical tracer, vendored verbatim, drift-guarded.** Same pattern as
  `n8n/lib/kb-hybrid.mjs`: `monitoring/otel/tracer.js` is the source of truth;
  the two service copies must stay byte-identical (sha256 + `Buffer.equals` in
  the test). It is hand-rolled rather than the OTel SDK because stream-bridge
  runs on a stock `n8nio/runners` image with no `package.json` (only Node
  built-ins available), and n8n Code nodes cannot import an SDK at all
  (AGENTS.md §9.13) — so n8n uses its **native** OTel instead.
- **ESM/CJS interop.** `platform-runtime` is `"type":"module"`, so a CJS `.js`
  file would be parsed as ESM and fail. The runtime copy uses `.cjs` (forces CJS
  regardless of package type) and is loaded with `createRequire(import.meta.url)`.
  The drift guard compares **content, not filename**, so `.js`/`.cjs` copies stay
  identical.
- **Opt-in = zero regression.** A tracer is disabled unless an endpoint is
  configured (`OTEL_EXPORTER_OTLP_ENDPOINT` empty for bridge/runtime;
  `N8N_OTEL_ENABLED=false` loads no n8n SDK). When disabled every operation is a
  no-op and `inject()` returns headers **unchanged**, so the host behaves
  byte-for-byte as before tracing existed. The bridge registers shutdown signal
  handlers only when enabled, keeping Node's default signal behavior intact.
- **Fail-open is load-bearing.** A missing/unreachable/rejecting/timing-out
  collector NEVER breaks a request: export errors are swallowed and the batch is
  dropped, not retried into the request path.
- **OTLP/JSON correctness.** traceId/spanId/parentSpanId are **hex strings** (not
  base64); int64 fields (`startTimeUnixNano`/`endTimeUnixNano`/`intValue`) are
  JSON **strings**; `kind` is the int enum (SERVER:2, CLIENT:3); root spans omit
  `parentSpanId`; POST to `endpoint + /v1/traces` with `Content-Type:
  application/json`. The collector's OTLP receiver accepts this JSON **and**
  n8n's native http/protobuf on the same :4318 endpoint.
- **Cross-service span tree.** bridge SERVER root → bridge CLIENT (`inject`
  traceparent) → runtime SERVER (`extract`) stay one trace. The bridge pins the
  OTel traceId to the business `x-trace-id` (already normalized to 32-hex by
  `traceIdFor`), and both services keep the business id as a `trace.id` span
  attribute, so a trace can always be correlated back to logs even if
  propagation breaks.
- **n8n native OTel, version-gated.** Only `N8N_OTEL_*` vars available in 2.37.7
  are set (ENABLED / EXPORTER_OTLP_ENDPOINT / EXPORTER_SERVICE_NAME /
  TRACES_SAMPLE_RATE / TRACES_PRODUCTION_ONLY). Protocol selection
  (`EXPORTER_OTLP_PROTOCOL`, 2.39) and `OTEL_PROPAGATORS` (2.47) do NOT exist in
  2.37.7 and are deliberately not set. Default transport is http/protobuf;
  outbound traceparent injection is on by default.
- **`tracing` profile is opt-in and loopback-only**, mirroring the
  `observability` profile. Jaeger all-in-one stores traces in memory (pilot, no
  persistence, no auth). The core stack never depends on it.

## Offline verification (this machine, no collector / no network for the contracts)

| Gate | Result |
|---|---|
| `node --test monitoring/otel/tracer.test.mjs` | **18 pass / 0 fail** |
| `node n8n/scripts/validate-workflows.mjs` | **26 files, 0 warnings** |
| compose / `.env.example` structural cross-check | **18 / 18 PASS** |
| CI YAML parse (8 jobs) | valid |
| image tags exist (Docker Hub API, read-only) | `otel/opentelemetry-collector:0.115.0`, `jaegertracing/all-in-one:1.62.0` both present |

Negative controls / mutation proofs (green ≠ proof):

- **Drift gate is load-bearing**: mutating a vendored copy made the suite fail
  (17 pass / 1 fail); restoring from canonical (via `cp`, not `git checkout`)
  returned 18/18 with matching hashes.
- **Fail-open catch is load-bearing**: a temp-copy mutant that rethrows in the
  export catch fails the "never throws into the host" test; the real module
  swallows it. Proven without touching the working tree.
- **All-zero traceparent rejection is load-bearing**: a mutant that accepts
  all-zero ids fails the invalid-input test.
- The 18 contracts also cover: traceparent round-trip / case-normalize /
  invalid rejection, AnyValue typing, disabled no-op + header preservation,
  `enabled:false` override, endpoint enable + trailing-slash normalize, root
  OTLP/JSON shape, error-span ERROR + 300-char truncation, child traceId/parent
  inheritance, cross-service propagation continuity, and each vendored copy
  functioning in its own module context.

## Disposable-collector acceptance (this machine, ISOLATED throwaway containers)

`node monitoring/otel/otlp-acceptance.mjs` — **16 / 16 PASS**. It starts a
throwaway `otel-collector` + `jaeger` on a separate network (`otel-verify-net`)
and host-loopback ports 14318/14313/16687, drives the **real canonical tracer**,
then removes everything (verified: no leftover containers/network, ports
released, shared stack intact).

| Assertion | Result |
|---|---|
| collector `health_check` + Jaeger query API reachable | PASS |
| real tracer → real collector accepts OTLP/JSON | **HTTP 200, 200** |
| **negative control**: malformed OTLP body rejected | **HTTP 400** (proves the 200 is meaningful) |
| trace lands in Jaeger with the full tree | **3 spans** |
| root has no parent; bridge CLIENT child of bridge SERVER | PASS |
| **runtime SERVER child of bridge CLIENT (cross-service link)** | PASS |
| two services in one trace (`stream-bridge`, `platform-runtime`) | PASS |
| all spans share the propagated traceId | PASS |

This proves the OTLP/JSON shape is accepted by a real collector, forwarded over
OTLP/gRPC to a real Jaeger, stored, and queryable with the correct cross-service
parent/child links — not just a mock.

## NOT verified here (未验 — deployment machine only)

1. **n8n incoming traceparent extraction (the key risk).** Upstream docs do not
   state whether n8n 2.37.7 extracts an incoming `traceparent` to CONTINUE a
   trace. If it does not, n8n spans start a fresh trace and the bridge→n8n link
   is broken even though bridge→runtime is continuous. Must be confirmed on the
   deployment machine with real traffic. Fallback already in place: the business
   `x-trace-id` is kept as a `trace.id` span attribute for correlation regardless.
2. **Live cross-service continuity into n8n**: the full bridge→n8n→runtime tree
   under a real chat request (the disposable check covers bridge→runtime only;
   n8n native protobuf emission was not exercised here).
3. **n8n native OTel actually emitting** with the configured env on the live
   image (protobuf transport to the collector, node spans, sampling).
4. **Real-traffic span shape/attributes in the Jaeger UI**, and collector
   batch/memory behavior under sustained load.
5. **The new CI job has not run remotely**: the numbers above are local checks.

The disposable acceptance is a pre-deploy sanity check, **not** live tracing
acceptance. Offline/this green does not prove n8n continuity.

## Deployment-machine commands (operator-run)

```bash
# 0. Optional pre-deploy sanity (disposable, isolated; never touches the stack):
node monitoring/otel/otlp-acceptance.mjs

# 1. Enable tracing in .env (operator edit; never scripted here):
#      OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
#      N8N_OTEL_ENABLED=true
# 2. Start the opt-in profile:
docker compose --profile tracing up -d

# 3. Jaeger UI: http://127.0.0.1:16686 — pick service stream-bridge /
#    platform-runtime / n8n, find a trace, inspect the span tree.

# 4. Confirm n8n continuity (the key 未验 item): send one real chat request,
#    then check whether the n8n spans share the SAME traceId as the
#    stream-bridge spans. If they form a separate trace, n8n did not extract
#    the incoming traceparent — correlate via the trace.id attribute instead.
docker logs platform-otel-collector   # debug exporter echoes one line per batch
```

## Rollback

- Set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) and `N8N_OTEL_ENABLED=false`:
  bridge/runtime tracers disable, n8n loads no SDK — byte-for-byte the
  pre-tracing behavior. No code change needed.
- `docker compose --profile tracing down` removes the collector + Jaeger.
- No new data table, no schema change. Fail-open means even a collector that
  dies while enabled never breaks a request.