// Request-level admission for the K8s sandbox gateway (P1).
//
// Pure logic, no I/O: the gateway wires it between key auth and Job creation,
// and the offline contract tests drive it with a fake clock. State is
// in-memory and therefore per replica; the phase6 two-replica layout gets
// per-replica limits, not a shared budget (documented in the pilot README).
//
// Caller identity is ACCOUNTING, not authentication: x-sandbox-caller is
// self-declared and only meaningful behind the shared x-sandbox-key. The
// allowlist is opt-in (SANDBOX_ALLOWED_CALLERS); empty means every
// authenticated caller is admitted and merely labelled.

const DEFAULT_CALLER = 'default';
const CALLER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Strict on purpose: silently normalising an invalid identity could merge two
// distinct callers into one bucket. Anything outside the charset is refused.
const parseCaller = (header) => {
  if (header === undefined || header === null || header === '') return { caller: DEFAULT_CALLER };
  const value = String(header);
  if (!CALLER_PATTERN.test(value)) return { error: 'invalid_caller' };
  return { caller: value };
};

const clampInt = (raw, fallback, min, max) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const parseAllowedCallers = (raw) => {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return [];
  const list = text.split(',').map((entry) => entry.trim()).filter(Boolean);
  // Fail closed on a malformed allowlist: starting with a silently dropped
  // entry could admit a caller the operator meant to block.
  for (const entry of list) {
    if (!CALLER_PATTERN.test(entry)) {
      throw new Error(`SANDBOX_ALLOWED_CALLERS entry is not a valid caller identity: ${JSON.stringify(entry)}`);
    }
  }
  return [...new Set(list)];
};

const admissionConfigFromEnv = (env = {}) => ({
  rateRpm: clampInt(env.SANDBOX_RATE_RPM, 30, 1, 6000),
  rateBurst: clampInt(env.SANDBOX_RATE_BURST, 10, 1, 600),
  maxInflight: clampInt(env.SANDBOX_MAX_INFLIGHT, 4, 1, 64),
  allowedCallers: parseAllowedCallers(env.SANDBOX_ALLOWED_CALLERS),
});

// Token bucket per caller: capacity = rateBurst, refill = rateRpm per minute.
// `now` is injectable so tests can advance time without sleeping.
const createAdmission = ({ rateRpm = 30, rateBurst = 10, maxInflight = 4, allowedCallers = [], now = Date.now } = {}) => {
  const buckets = new Map();
  const decisions = new Map();
  let inflight = 0;

  const record = (caller, decision) => {
    let byDecision = decisions.get(caller);
    if (!byDecision) {
      byDecision = new Map();
      decisions.set(caller, byDecision);
    }
    byDecision.set(decision, (byDecision.get(decision) || 0) + 1);
  };

  const check = (caller) => {
    if (allowedCallers.length && !allowedCallers.includes(caller)) {
      record(caller, 'caller_not_allowed');
      return { allowed: false, status: 403, error: 'caller_not_allowed' };
    }
    const at = now();
    let bucket = buckets.get(caller);
    if (!bucket) {
      bucket = { tokens: rateBurst, at };
      buckets.set(caller, bucket);
    }
    bucket.tokens = Math.min(rateBurst, bucket.tokens + ((at - bucket.at) / 60000) * rateRpm);
    bucket.at = at;
    if (bucket.tokens < 1) {
      record(caller, 'rate_limited');
      const retryAfterSec = Math.max(1, Math.ceil(((1 - bucket.tokens) / rateRpm) * 60));
      return { allowed: false, status: 429, error: 'rate_limited', retryAfterSec };
    }
    bucket.tokens -= 1;
    return { allowed: true };
  };

  // Global cap on concurrent runJob calls. Each in-flight run owns one
  // Kubernetes Job (up to 1 CPU / 2Gi), so this is the cluster guard.
  const acquire = () => {
    if (inflight >= maxInflight) return false;
    inflight += 1;
    return true;
  };
  const release = () => {
    inflight = Math.max(0, inflight - 1);
  };

  const snapshot = () => ({
    inflight,
    maxInflight,
    decisions: [...decisions.entries()].map(([caller, byDecision]) => ({
      caller,
      decisions: [...byDecision.entries()].map(([decision, count]) => ({ decision, count })),
    })),
  });

  return {
    check,
    acquire,
    release,
    snapshot,
    get inflight() { return inflight; },
  };
};

module.exports = { DEFAULT_CALLER, CALLER_PATTERN, parseCaller, clampInt, parseAllowedCallers, admissionConfigFromEnv, createAdmission };