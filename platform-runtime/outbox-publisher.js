import http from 'node:http';
import os from 'node:os';
import { Kafka } from 'kafkajs';
import pg from 'pg';
import { collectOutboxStats, renderOutboxMetrics } from './outbox-metrics.js';

const { Pool } = pg;
const DB = {
  host: process.env.DB_POSTGRESDB_HOST || 'postgres',
  port: Number(process.env.DB_POSTGRESDB_PORT || 5432),
  database: process.env.DB_POSTGRESDB_DATABASE || 'n8n',
  user: process.env.DB_POSTGRESDB_USER || 'n8n',
  password: process.env.DB_POSTGRESDB_PASSWORD || '',
};
const BROKERS = String(process.env.KAFKA_BROKERS || 'kafka:19092').split(',').map((value) => value.trim()).filter(Boolean);
const TOPIC = process.env.KAFKA_TOPIC || 'platform.events.outbox.v1';
const KIND = process.env.OUTBOX_KIND || 'kafka-pilot';
const POLL_MS = Math.max(100, Number(process.env.OUTBOX_POLL_MS || 500));
const BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.OUTBOX_BATCH_SIZE || 50)));
const LEASE_SEC = Math.max(5, Number(process.env.OUTBOX_LEASE_SEC || 30));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.OUTBOX_MAX_ATTEMPTS || 5));
const PUBLISHER_ID = process.env.OUTBOX_PUBLISHER_ID || `outbox-publisher-${os.hostname()}-${process.pid}`;
const METRICS_PORT = Number(process.env.OUTBOX_METRICS_PORT || 9101);

const pool = new Pool({ ...DB, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
const kafka = new Kafka({ clientId: PUBLISHER_ID, brokers: BROKERS });
const producer = kafka.producer({ allowAutoTopicCreation: false });
let stopping = false;
let metricsServer;
const counters = { published: 0, retry: 0, deadLetter: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const claimBatch = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH candidates AS (
         SELECT outbox_id
           FROM platform.outbox
          WHERE kind = $1
            AND (
              (state IN ('PENDING', 'RETRY') AND next_retry_at <= now())
              OR (state = 'DELIVERING' AND COALESCE(lease_until, next_retry_at) <= now())
            )
          ORDER BY outbox_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE platform.outbox AS outbox
          SET state = 'DELIVERING',
              attempts = outbox.attempts + 1,
             lease_until = now() + ($3 * interval '1 second'),
             locked_at = now(),
             locked_by = $4,
              last_error = NULL
         FROM candidates
        WHERE outbox.outbox_id = candidates.outbox_id
       RETURNING outbox.outbox_id, outbox.request_id, outbox.trace_id,
                 outbox.kind, outbox.dedupe_key, outbox.payload, outbox.attempts,
                 outbox.created_at`,
      [KIND, BATCH_SIZE, LEASE_SEC, PUBLISHER_ID],
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const markDelivered = async (row) => {
  await pool.query(
    `UPDATE platform.outbox
        SET state = 'DELIVERED', delivered_at = now(), last_error = NULL,
            lease_until = NULL, locked_at = NULL, locked_by = NULL
      WHERE outbox_id = $1 AND state = 'DELIVERING' AND locked_by = $2`,
    [row.outbox_id, PUBLISHER_ID],
  );
};

const markFailed = async (row, error) => {
  const deadLetter = Number(row.attempts) >= MAX_ATTEMPTS;
  const retryDelay = Math.min(60, 2 ** Math.max(0, Number(row.attempts) - 1));
  await pool.query(
    `UPDATE platform.outbox
        SET state = $2,
            next_retry_at = now() + ($3 * interval '1 second'),
            lease_until = NULL, locked_at = NULL, locked_by = NULL,
            last_error = $4
      WHERE outbox_id = $1 AND state = 'DELIVERING' AND locked_by = $5`,
    [row.outbox_id, deadLetter ? 'DEAD_LETTER' : 'RETRY', deadLetter ? 86400 : retryDelay, String(error.message || error).slice(0, 500), PUBLISHER_ID],
  );
  console.error(JSON.stringify({
    event: 'platform.outbox.publish_failed',
    outbox_id: String(row.outbox_id),
    attempts: row.attempts,
    state: deadLetter ? 'DEAD_LETTER' : 'RETRY',
    error: String(error.message || error).slice(0, 300),
  }));
  return deadLetter ? 'dead_letter' : 'retry';
};

const publishRow = async (row) => {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const eventId = payload.event_id || String(row.outbox_id);
  const eventType = payload.event_type || row.kind;
  const occurredAt = payload.occurred_at || row.created_at;
  const traceId = payload.trace_id || row.trace_id;
  const source = payload.source || 'platform-outbox-publisher';
  const data = Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : row.payload;
  await producer.send({
    topic: TOPIC,
    messages: [{
      key: row.dedupe_key,
      value: JSON.stringify({
        event_id: String(eventId),
        event_type: eventType,
        occurred_at: occurredAt,
        source,
        trace_id: traceId,
        dedupe_key: row.dedupe_key,
        data,
      }),
    }],
  });
};

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  if (metricsServer) metricsServer.close();
  await producer.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await pool.query('SELECT 1');
await producer.connect();

// P0 metrics surface: pending/retry/dead-letter visibility required by the
// promotion rule. Scraped by Prometheus; never affects the delivery loop.
metricsServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'platform-outbox-publisher' }));
  }
  if (req.method !== 'GET' || req.url !== '/metrics') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'not found' }));
  }
  try {
    const stats = await collectOutboxStats(pool, KIND);
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(renderOutboxMetrics({ kind: KIND, stats, counters }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'platform.outbox.metrics_error', error: String(error.message || error).slice(0, 300) }));
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'metrics_unavailable' }));
  }
});
metricsServer.listen(METRICS_PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'platform.outbox.metrics_listening', port: METRICS_PORT }));
});

console.log(JSON.stringify({
  event: 'platform.outbox.publisher_ready',
  publisher_id: PUBLISHER_ID,
  kind: KIND,
  topic: TOPIC,
  brokers: BROKERS,
  metrics_port: METRICS_PORT,
}));

while (!stopping) {
  try {
    const rows = await claimBatch();
    if (!rows.length) {
      await sleep(POLL_MS);
      continue;
    }
    for (const row of rows) {
      try {
        await publishRow(row);
        await markDelivered(row);
        counters.published += 1;
        console.log(JSON.stringify({
          event: 'platform.outbox.published',
          outbox_id: String(row.outbox_id),
          dedupe_key: row.dedupe_key,
          topic: TOPIC,
          attempts: row.attempts,
        }));
      } catch (error) {
        const outcome = await markFailed(row, error);
        if (outcome === 'dead_letter') counters.deadLetter += 1;
        else counters.retry += 1;
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'platform.outbox.publisher_error', error: String(error.message || error).slice(0, 300) }));
    await sleep(POLL_MS);
  }
}
