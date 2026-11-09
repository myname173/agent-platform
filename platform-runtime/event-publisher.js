import { Kafka } from 'kafkajs';
import pg from 'pg';

const { Pool } = pg;
const DB = {
  host: process.env.DB_POSTGRESDB_HOST || 'postgres',
  port: Number(process.env.DB_POSTGRESDB_PORT || 5432),
  database: process.env.DB_POSTGRESDB_DATABASE || 'n8n',
  user: process.env.DB_POSTGRESDB_USER || 'n8n',
  password: process.env.DB_POSTGRESDB_PASSWORD || '',
};
const BROKERS = String(process.env.KAFKA_BROKERS || 'kafka:19092').split(',').map((value) => value.trim()).filter(Boolean);
const TOPIC = process.env.KAFKA_TOPIC || 'platform.events.v1';
const POLL_MS = Math.max(100, Number(process.env.PLATFORM_EVENT_POLL_MS || 500));
const BATCH_SIZE = Math.max(1, Math.min(500, Number(process.env.PLATFORM_EVENT_BATCH_SIZE || 100)));
const START_ID = String(process.env.PLATFORM_EVENT_START_ID || 'latest').trim().toLowerCase();

const pool = new Pool({ ...DB, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
const kafka = new Kafka({ clientId: 'platform-event-publisher', brokers: BROKERS });
const producer = kafka.producer({ allowAutoTopicCreation: false });
let cursor = 0;
let stopping = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const initialiseCursor = async () => {
  if (START_ID === 'latest') {
    const result = await pool.query('SELECT COALESCE(MAX(event_id), 0) AS event_id FROM platform.events');
    cursor = Number(result.rows[0]?.event_id || 0);
    return;
  }
  cursor = Math.max(0, Number(START_ID) || 0);
};

const publishBatch = async () => {
  const result = await pool.query(
    `SELECT event_id, request_id, trace_id, event_type, from_state, to_state, payload, created_at
       FROM platform.events
      WHERE event_id > $1
      ORDER BY event_id
      LIMIT $2`,
    [cursor, BATCH_SIZE],
  );
  if (!result.rows.length) return 0;

  await producer.send({
    topic: TOPIC,
    messages: result.rows.map((row) => ({
      key: String(row.event_id),
      value: JSON.stringify({
        event_id: String(row.event_id),
        event_type: row.event_type,
        occurred_at: row.created_at,
        source: 'platform-runtime',
        trace_id: row.trace_id,
        data: {
          request_id: row.request_id,
          from_state: row.from_state,
          to_state: row.to_state,
          payload: row.payload,
        },
      }),
    })),
  });
  cursor = Number(result.rows[result.rows.length - 1].event_id);
  console.log(JSON.stringify({ event: 'platform.events.published', count: result.rows.length, cursor, topic: TOPIC }));
  return result.rows.length;
};

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await producer.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await pool.query('SELECT 1');
await producer.connect();
await initialiseCursor();
console.log(JSON.stringify({ event: 'platform.events.publisher_ready', topic: TOPIC, brokers: BROKERS, cursor }));

while (!stopping) {
  try {
    const published = await publishBatch();
    if (!published) await sleep(POLL_MS);
  } catch (error) {
    console.error(JSON.stringify({ event: 'platform.events.publisher_error', error: String(error.message || error).slice(0, 300) }));
    await sleep(POLL_MS);
  }
}
