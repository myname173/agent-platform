// Outbox metrics helpers for outbox-publisher.js (P0 dead-letter visibility).
// Pure rendering + a small DB collector so both are testable offline without
// a broker (see test-event-consumer.mjs).
//
// The README's promotion rule asks for pending/retry/dead-letter metrics;
// these gauges/counters are that surface, scraped by Prometheus on the
// publisher's metrics port.

export const OUTBOX_STATES = ['PENDING', 'DELIVERING', 'DELIVERED', 'RETRY', 'DEAD_LETTER'];

const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

// Returns every state with a zero default so dashboards/alerts never see a
// missing series (a missing DEAD_LETTER series must read as 0, not absent).
export const collectOutboxStats = async (pool, kind) => {
  const counts = await pool.query(
    'SELECT state, count(*)::int AS n FROM platform.outbox WHERE kind = $1 GROUP BY state',
    [kind],
  );
  const byState = Object.fromEntries(OUTBOX_STATES.map((state) => [state, 0]));
  for (const row of counts.rows) {
    if (Object.prototype.hasOwnProperty.call(byState, row.state)) byState[row.state] = Number(row.n);
  }
  const oldest = await pool.query(
    `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))), 0)::float8 AS age_seconds
       FROM platform.outbox
      WHERE kind = $1 AND state IN ('PENDING', 'RETRY')`,
    [kind],
  );
  return { byState, oldestReadySeconds: Number(oldest.rows[0]?.age_seconds || 0) };
};

export const renderOutboxMetrics = ({ kind, stats, counters }) => [
  '# HELP platform_outbox_publisher_up Outbox publisher process is running.',
  '# TYPE platform_outbox_publisher_up gauge',
  'platform_outbox_publisher_up 1',
  '# HELP platform_outbox_rows Outbox rows by state for the configured kind.',
  '# TYPE platform_outbox_rows gauge',
  ...OUTBOX_STATES.map((state) => `platform_outbox_rows{kind="${escapeLabel(kind)}",state="${state}"} ${Number(stats?.byState?.[state] || 0)}`),
  '# HELP platform_outbox_oldest_ready_seconds Age of the oldest PENDING/RETRY row.',
  '# TYPE platform_outbox_oldest_ready_seconds gauge',
  `platform_outbox_oldest_ready_seconds ${Number(stats?.oldestReadySeconds || 0)}`,
  '# HELP platform_outbox_published_total Rows confirmed DELIVERED by this publisher process.',
  '# TYPE platform_outbox_published_total counter',
  `platform_outbox_published_total ${Number(counters?.published || 0)}`,
  '# HELP platform_outbox_failed_total Publish failures by outcome.',
  '# TYPE platform_outbox_failed_total counter',
  `platform_outbox_failed_total{outcome="retry"} ${Number(counters?.retry || 0)}`,
  `platform_outbox_failed_total{outcome="dead_letter"} ${Number(counters?.deadLetter || 0)}`,
].join('\n') + '\n';