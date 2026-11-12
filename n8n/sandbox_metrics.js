// Prometheus text metrics for the K8s sandbox gateway (P1 admission surface).
// Hand-rolled like platform-runtime/outbox-metrics.js: no client library, no
// I/O, render() is a pure function of the recorded state so the offline
// contract tests can assert exact series.
//
// Rejections are first-class series: every refused request lands in
// sandbox_gateway_requests_total{caller,decision}, so an alert can fire on
// rate_limited / busy / caller_not_allowed without parsing logs.

const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const DURATION_BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 45, 60];

const createMetrics = () => {
  const requests = new Map(); // `${caller}\u0000${decision}` -> count
  const runs = new Map(); // `${caller}\u0000${outcome}` -> count
  const duration = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
  let inflight = 0;

  const bump = (map, caller, key) => {
    const id = `${caller}\u0000${key}`;
    map.set(id, (map.get(id) || 0) + 1);
  };

  return {
    request(caller, decision) { bump(requests, caller, decision); },
    run(caller, outcome) { bump(runs, caller, outcome); },
    observeJobSeconds(seconds) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 0) return;
      duration.sum += value;
      duration.count += 1;
      DURATION_BUCKETS.forEach((bound, index) => {
        if (value <= bound) duration.buckets[index] += 1;
      });
    },
    setInflight(value) { inflight = Math.max(0, Number(value) || 0); },
    render() {
      const lines = [
        '# HELP sandbox_gateway_up Sandbox gateway process is running.',
        '# TYPE sandbox_gateway_up gauge',
        'sandbox_gateway_up 1',
        '# HELP sandbox_gateway_requests_total /run requests by caller and admission decision.',
        '# TYPE sandbox_gateway_requests_total counter',
      ];
      for (const [id, count] of [...requests.entries()].sort()) {
        const [caller, decision] = id.split('\u0000');
        lines.push(`sandbox_gateway_requests_total{caller="${escapeLabel(caller)}",decision="${escapeLabel(decision)}"} ${count}`);
      }
      lines.push(
        '# HELP sandbox_gateway_runs_total Admitted runs by execution outcome.',
        '# TYPE sandbox_gateway_runs_total counter',
      );
      for (const [id, count] of [...runs.entries()].sort()) {
        const [caller, outcome] = id.split('\u0000');
        lines.push(`sandbox_gateway_runs_total{caller="${escapeLabel(caller)}",outcome="${escapeLabel(outcome)}"} ${count}`);
      }
      lines.push(
        '# HELP sandbox_gateway_inflight_jobs Kubernetes Jobs currently owned by this gateway.',
        '# TYPE sandbox_gateway_inflight_jobs gauge',
        `sandbox_gateway_inflight_jobs ${inflight}`,
        '# HELP sandbox_gateway_job_duration_seconds End-to-end runJob duration for admitted requests.',
        '# TYPE sandbox_gateway_job_duration_seconds histogram',
      );
      DURATION_BUCKETS.forEach((bound, index) => {
        lines.push(`sandbox_gateway_job_duration_seconds_bucket{le="${bound}"} ${duration.buckets[index]}`);
      });
      lines.push(
        `sandbox_gateway_job_duration_seconds_bucket{le="+Inf"} ${duration.count}`,
        `sandbox_gateway_job_duration_seconds_sum ${duration.sum}`,
        `sandbox_gateway_job_duration_seconds_count ${duration.count}`,
      );
      return lines.join('\n') + '\n';
    },
  };
};

module.exports = { createMetrics, DURATION_BUCKETS };