/* agent-platform lightweight OpenTelemetry tracer — dependency-free, CommonJS.
 *
 * Canonical source. Vendored VERBATIM into stream-bridge/tracer.js and
 * platform-runtime/tracer.js; monitoring/otel/tracer.test.mjs asserts the three
 * copies never drift (same pattern as n8n/lib/kb-hybrid.mjs). It is hand-rolled
 * rather than the OTel SDK because stream-bridge runs on a stock image with no
 * package.json (only Node built-ins are available), and a single shared design
 * keeps the cross-service span tree coherent.
 *
 * What it does: W3C trace-context propagation (parse/format traceparent), span
 * lifecycle, and OTLP/HTTP **JSON** export to a collector. n8n's native OTel
 * exports OTLP/protobuf; the collector's OTLP receiver accepts both on /v1/traces.
 *
 * Two safety properties, both load-bearing:
 *   - opt-in: disabled unless an endpoint is configured. When disabled every
 *     operation is a no-op and inject() leaves headers untouched, so the host
 *     service behaves byte-for-byte as it did before tracing existed.
 *   - fail-open: a missing/unreachable/rejecting collector NEVER breaks a
 *     request. Export errors are swallowed; spans are dropped, not retried into
 *     the request path.
 *
 * No secrets are read here. The endpoint is a plain URL (e.g.
 * http://otel-collector:4318); auth headers, if ever needed, are passed in by the
 * caller, never logged. */
'use strict';
const crypto = require('crypto');

// OTLP protobuf enum values (Span.SpanKind / Status.StatusCode).
const SPAN_KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };
const STATUS = { UNSET: 0, OK: 1, ERROR: 2 };

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// OTLP int64 fields are JSON strings; wall-clock unix nanoseconds.
const nowNano = () => (BigInt(Date.now()) * 1000000n).toString();

/* Parse a W3C traceparent header. Returns {traceId, spanId, flags} or null.
 * All-zero trace/span ids are invalid per the spec and rejected. */
function parseTraceparent(value) {
  const m = String(value == null ? '' : value).trim()
    .match(/^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i);
  if (!m) return null;
  const traceId = m[2].toLowerCase();
  const spanId = m[3].toLowerCase();
  if (traceId === '00000000000000000000000000000000') return null;
  if (spanId === '0000000000000000') return null;
  return { traceId, spanId, flags: m[4].toLowerCase() };
}

function formatTraceparent(traceId, spanId, flags) {
  return '00-' + traceId + '-' + spanId + '-' + (flags || '01');
}

/* OTLP AnyValue: int64 as string, double as number, bool, else string. */
function attrValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return { stringValue: String(v == null ? '' : v) };
}
function toAttributes(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v != null)
    .map(([key, v]) => ({ key, value: attrValue(v) }));
}

/* createTracer({ serviceName, endpoint, enabled, fetchFn, flushIntervalMs,
 *                batchSize, timeoutMs }) -> tracer.
 * fetchFn is injectable so offline tests can capture the OTLP payload and
 * simulate a down/rejecting collector without any network. */
function createTracer(options) {
  const opts = options || {};
  const endpoint = String(opts.endpoint || '').trim().replace(/\/+$/, '');
  const enabled = !!endpoint && opts.enabled !== false;
  const serviceName = String(opts.serviceName || 'agent-platform');
  const doFetch = typeof opts.fetchFn === 'function' ? opts.fetchFn : (typeof fetch === 'function' ? fetch : null);
  const batchSize = Math.max(1, Number(opts.batchSize || 100));
  const timeoutMs = Math.max(1, Number(opts.timeoutMs || 3000));
  const buffer = [];
  let timer = null;
  let flushing = false;

  function scheduleFlush() {
    if (!enabled || timer || !doFetch) return;
    timer = setInterval(() => { flush().catch(() => {}); }, Math.max(50, Number(opts.flushIntervalMs || 2000)));
    if (timer.unref) timer.unref();
  }

  /* Export the buffered spans as one OTLP/JSON ResourceSpans payload. Fail-open:
   * any network error, non-2xx, or missing fetch simply drops the batch. */
  async function flush() {
    if (!enabled || flushing || buffer.length === 0 || !doFetch) return;
    flushing = true;
    const spans = buffer.splice(0, buffer.length);
    const payload = {
      resourceSpans: [{
        resource: { attributes: toAttributes({ 'service.name': serviceName }) },
        scopeSpans: [{ scope: { name: 'agent-platform-tracer', version: '1.0.0' }, spans }],
      }],
    };
    try {
      const r = await doFetch(endpoint + '/v1/traces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r && typeof r.ok === 'boolean' && !r.ok) { /* rejected: drop, fail-open */ }
    } catch (e) {
      /* collector down/unreachable/timeout: drop, never throw into the host */
    } finally {
      flushing = false;
    }
  }

  /* Extract incoming W3C context from request headers (always available, cheap,
   * even when export is disabled, so callers can correlate ids). */
  function extract(headers) {
    const h = headers || {};
    return parseTraceparent(h.traceparent != null ? h.traceparent : h.Traceparent);
  }

  /* Start a span. parent is an extracted context or another span ({traceId,
   * spanId}); traceId overrides the root trace id (used to pin the business
   * x-trace-id). When disabled the span is a cheap stub that endSpan ignores. */
  function startSpan(name, spanOpts) {
    const so = spanOpts || {};
    const parent = so.parent || null;
    const traceId = (parent && parent.traceId) || so.traceId || hex(16);
    return {
      traceId,
      spanId: hex(8),
      parentSpanId: (parent && parent.spanId) || '',
      name: String(name == null ? 'span' : name),
      kind: so.kind || SPAN_KIND.INTERNAL,
      startTimeUnixNano: nowNano(),
      attributes: toAttributes(so.attributes),
      _disabled: !enabled,
    };
  }

  /* End a span and queue it for export (no-op when disabled). status is an OTLP
   * StatusCode; error sets ERROR + a truncated message. */
  function endSpan(span, endOpts) {
    if (!enabled || !span || span._disabled) return;
    const eo = endOpts || {};
    span.endTimeUnixNano = nowNano();
    if (eo.attributes) span.attributes = span.attributes.concat(toAttributes(eo.attributes));
    const code = eo.error ? STATUS.ERROR : (eo.status != null ? eo.status : STATUS.UNSET);
    span.status = { code };
    if (eo.error) span.status.message = String((eo.error && eo.error.message) || eo.error).slice(0, 300);
    const out = { ...span };
    delete out._disabled;
    if (!out.parentSpanId) delete out.parentSpanId; // root spans omit parentSpanId
    buffer.push(out);
    if (buffer.length >= batchSize) flush().catch(() => {});
    else scheduleFlush();
  }

  function traceparent(span) {
    return span ? formatTraceparent(span.traceId, span.spanId, '01') : '';
  }

  /* Return headers with a span-linked traceparent when enabled; when disabled
   * return them unchanged so the caller's existing propagation is preserved. */
  function inject(headers, span) {
    const h = { ...(headers || {}) };
    if (enabled && span) h.traceparent = traceparent(span);
    return h;
  }

  async function shutdown() {
    if (timer) { clearInterval(timer); timer = null; }
    await flush().catch(() => {});
  }

  return {
    enabled, serviceName, SPAN_KIND, STATUS,
    extract, startSpan, endSpan, traceparent, inject, flush, shutdown,
    _buffer: buffer, // test/inspection hook
  };
}

module.exports = { createTracer, parseTraceparent, formatTraceparent, toAttributes, SPAN_KIND, STATUS };