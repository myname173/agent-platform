// Idempotent consumer for the outbox pilot topic (P0 consumer-side closure).
//
// Contract: the outbox publisher keys every Kafka message with the outbox
// `dedupe_key` and repeats it inside the envelope. This consumer records each
// (topic, dedupe_key) exactly once in platform.consumed_events. The ledger
// insert and its primary key are the idempotency boundary:
//
//   DB transaction commits BEFORE the Kafka offset is committed. A crash in
//   between redelivers the message; ON CONFLICT DO NOTHING turns the replay
//   into a counted no-op instead of a duplicate effect.
//
// Pilot scope: consumes only the outbox topic, never touches Runtime state,
// Redis Streams kb_save, or n8n. Same isolation rule as outbox-publisher.js.
import http from 'node:http';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Kafka } from 'kafkajs';
import pg from 'pg';

const { Pool } = pg;

// Kept identical to the tail of n8n/scripts/platform-schema.sql. The consumer
// self-ensures the ledger so the pilot works without a manual schema step.
export const CONSUMER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS platform.consumed_events (
  topic            text NOT NULL,
  dedupe_key       text NOT NULL,
  event_id         text NOT NULL,
  trace_id         text,
  event_type       text,
  source           text,
  payload          jsonb,
  consumed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic, dedupe_key)
);
CREATE INDEX IF NOT EXISTS platform_consumed_events_trace_idx
  ON platform.consumed_events (trace_id, consumed_at);
`;

const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

// Pure handler factory so the dedupe/transaction contract is testable offline
// (see test-event-consumer.mjs). `pool` is a pg Pool; `counters` is a mutable
// object shared with the metrics endpoint.
export const createEnvelopeHandler = ({ pool, counters, log = console }) => {
  const bump = (name) => { counters[name] = Number(counters[name] || 0) + 1; };
  return async ({ topic, key, value }) => {
    let envelope = null;
    try { envelope = JSON.parse(value); } catch { envelope = null; }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      bump('invalid');
      log.error(JSON.stringify({ event: 'platform.consumer.invalid_message', topic, reason: 'bad_json' }));
      return 'invalid';
    }
    const dedupeKey = String(key || envelope.dedupe_key || envelope.event_id || '');
    if (!dedupeKey) {
      bump('invalid');
      log.error(JSON.stringify({ event: 'platform.consumer.invalid_message', topic, reason: 'missing_idempotency_key' }));
      return 'invalid';
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO platform.consumed_events
           (topic, dedupe_key, event_id, trace_id, event_type, source, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (topic, dedupe_key) DO NOTHING
         RETURNING dedupe_key`,
        [
          topic,
          dedupeKey,
          String(envelope.event_id || dedupeKey),
          envelope.trace_id ? String(envelope.trace_id) : null,
          envelope.event_type ? String(envelope.event_type) : null,
          envelope.source ? String(envelope.source) : null,
          envelope,
        ],
      );
      await client.query('COMMIT');
      if (inserted.rowCount > 0) {
        bump('processed');
        log.log(JSON.stringify({ event: 'platform.consumer.processed', topic, dedupe_key: dedupeKey, trace_id: envelope.trace_id || null }));
        return 'processed';
      }
      bump('duplicates');
      return 'duplicate';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      bump('errors');
      throw error;
    } finally {
      client.release();
    }
  };
};

// Wraps the handler with the offset-commit ordering. Exported for offline
// tests: a failing handler must NOT advance the committed offset.
export const createMessageProcessor = ({ handler, commitOffsets, log = console }) => async ({ topic, partition, message }) => {
  const key = message.key ? message.key.toString('utf8') : '';
  const value = message.value ? message.value.toString('utf8') : '';
  await handler({ topic, key, value });
  // Only reached when the DB transaction committed (or the message was
  // classified invalid and loudly counted). A throw above skips this commit.
  await commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
};

export const renderConsumerMetrics = (counters, { group, topic }) => [
  '# HELP platform_event_consumer_up Consumer process is running.',
  '# TYPE platform_event_consumer_up gauge',
  'platform_event_consumer_up 1',
  '# HELP platform_event_consumer_info Consumer group and topic.',
  '# TYPE platform_event_consumer_info gauge',
  `platform_event_consumer_info{group="${escapeLabel(group)}",topic="${escapeLabel(topic)}"} 1`,
  '# HELP platform_event_consumer_processed_total Events recorded for the first time.',
  '# TYPE platform_event_consumer_processed_total counter',
  `platform_event_consumer_processed_total ${Number(counters.processed || 0)}`,
  '# HELP platform_event_consumer_duplicates_total Redeliveries skipped by the dedupe ledger.',
  '# TYPE platform_event_consumer_duplicates_total counter',
  `platform_event_consumer_duplicates_total ${Number(counters.duplicates || 0)}`,
  '# HELP platform_event_consumer_invalid_total Messages without parseable envelope or idempotency key.',
  '# TYPE platform_event_consumer_invalid_total counter',
  `platform_event_consumer_invalid_total ${Number(counters.invalid || 0)}`,
  '# HELP platform_event_consumer_errors_total Failed ledger transactions (offset not committed).',
  '# TYPE platform_event_consumer_errors_total counter',
  `platform_event_consumer_errors_total ${Number(counters.errors || 0)}`,
].join('\n') + '\n';

const main = async () => {
  const DB = {
    host: process.env.DB_POSTGRESDB_HOST || 'postgres',
    port: Number(process.env.DB_POSTGRESDB_PORT || 5432),
    database: process.env.DB_POSTGRESDB_DATABASE || 'n8n',
    user: process.env.DB_POSTGRESDB_USER || 'n8n',
    password: process.env.DB_POSTGRESDB_PASSWORD || '',
  };
  const BROKERS = String(process.env.KAFKA_BROKERS || 'kafka:19092').split(',').map((value) => value.trim()).filter(Boolean);
  const TOPIC = process.env.KAFKA_TOPIC || 'platform.events.outbox.v1';
  const GROUP = process.env.PLATFORM_CONSUMER_GROUP || 'platform-event-consumer-v1';
  // fromBeginning only applies when the group has no committed offsets; an
  // existing group always resumes where it stopped. Replay is safe by design.
  const FROM_BEGINNING = String(process.env.PLATFORM_CONSUMER_FROM_BEGINNING || 'true').trim().toLowerCase() !== 'false';
  const METRICS_PORT = Number(process.env.PLATFORM_CONSUMER_METRICS_PORT || 9102);

  const pool = new Pool({ ...DB, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  await pool.query('SELECT 1');
  await pool.query(CONSUMER_SCHEMA_SQL);

  const counters = { processed: 0, duplicates: 0, invalid: 0, errors: 0 };
  const handler = createEnvelopeHandler({ pool, counters });

  const kafka = new Kafka({ clientId: `${GROUP}-${os.hostname()}`, brokers: BROKERS });
  const consumer = kafka.consumer({ groupId: GROUP });
  // A crashed consumer must exit non-zero so `restart: unless-stopped` brings
  // it back; silently staying alive without consuming is the failure mode we
  // refuse.
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    console.error(JSON.stringify({ event: 'platform.consumer.crashed', error: String(payload?.error?.message || payload?.error || 'unknown').slice(0, 300) }));
    process.exit(1);
  });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: FROM_BEGINNING });

  const processMessage = createMessageProcessor({
    handler,
    commitOffsets: (offsets) => consumer.commitOffsets(offsets),
  });
  await consumer.run({ autoCommit: false, eachMessage: processMessage });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'platform-event-consumer' }));
    }
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(renderConsumerMetrics(counters, { group: GROUP, topic: TOPIC }));
  });
  server.listen(METRICS_PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'platform.consumer.ready', group: GROUP, topic: TOPIC, from_beginning: FROM_BEGINNING, metrics_port: METRICS_PORT }));
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await consumer.disconnect().catch(() => {});
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'platform.consumer.fatal', error: String(error.message || error).slice(0, 300) }));
    process.exit(1);
  });
}