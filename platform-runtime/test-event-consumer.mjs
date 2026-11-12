// Offline contract tests for the P0 consumer-side closure. No broker, no
// database, no credentials: `node --test test-event-consumer.mjs`.
//
// Boundary (honest): the fake pool emulates the ledger primary key so these
// tests prove the handler's branching, transaction shape and offset-commit
// ordering. The actual ON CONFLICT semantics are Postgres's job and are
// covered by the live replay check in deploy/event-bus/consumer-pilot.ps1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnvelopeHandler,
  createMessageProcessor,
  renderConsumerMetrics,
  CONSUMER_SCHEMA_SQL,
} from './event-consumer.js';
import { collectOutboxStats, renderOutboxMetrics, OUTBOX_STATES } from './outbox-metrics.js';

const envelope = (overrides = {}) => JSON.stringify({
  event_id: 'evt-1',
  event_type: 'platform.outbox.pilot',
  occurred_at: '2026-11-12T00:00:00Z',
  source: 'test',
  trace_id: 'a'.repeat(32),
  dedupe_key: 'outbox-pilot:run:1',
  data: { probe: true },
  ...overrides,
});

// Fake pg pool: enforces (topic, dedupe_key) uniqueness like the real PK and
// records the SQL verb sequence so tests can assert transaction shape.
const createFakePool = ({ failInsert = false } = {}) => {
  const ledger = new Map();
  const verbs = [];
  const statements = [];
  return {
    ledger,
    verbs,
    statements,
    async connect() {
      return {
        async query(sql, params) {
          const trimmed = sql.trim();
          verbs.push(trimmed.split(/\s+/)[0].toUpperCase());
          statements.push(trimmed);
          const head = trimmed.toUpperCase();
          if (head.startsWith('BEGIN') || head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) {
            return { rows: [], rowCount: 0 };
          }
          if (head.startsWith('INSERT INTO PLATFORM.CONSUMED_EVENTS')) {
            if (failInsert) throw new Error('simulated database failure');
            const [topic, dedupeKey] = params;
            const pk = `${topic}|${dedupeKey}`;
            if (ledger.has(pk)) return { rows: [], rowCount: 0 };
            ledger.set(pk, params);
            return { rows: [{ dedupe_key: dedupeKey }], rowCount: 1 };
          }
          throw new Error(`unexpected sql in fake pool: ${trimmed.slice(0, 80)}`);
        },
        release() {},
      };
    },
  };
};

const silentLog = { log() {}, error() {} };
const TOPIC = 'platform.events.outbox.v1';

test('first delivery is processed inside BEGIN/INSERT/COMMIT and recorded once', async () => {
  const pool = createFakePool();
  const counters = {};
  const handler = createEnvelopeHandler({ pool, counters, log: silentLog });
  const outcome = await handler({ topic: TOPIC, key: 'outbox-pilot:run:1', value: envelope() });
  assert.equal(outcome, 'processed');
  assert.equal(pool.ledger.size, 1);
  assert.equal(counters.processed, 1);
  assert.deepEqual(pool.verbs, ['BEGIN', 'INSERT', 'COMMIT']);
  // The dedupe clause is the contract; removing it must break this test.
  assert.match(pool.statements[1], /ON CONFLICT \(topic, dedupe_key\) DO NOTHING/);
});

test('redelivery of the same key is a counted no-op (idempotency)', async () => {
  const pool = createFakePool();
  const counters = {};
  const handler = createEnvelopeHandler({ pool, counters, log: silentLog });
  await handler({ topic: TOPIC, key: 'outbox-pilot:run:1', value: envelope() });
  const outcome = await handler({ topic: TOPIC, key: 'outbox-pilot:run:1', value: envelope() });
  assert.equal(outcome, 'duplicate');
  assert.equal(pool.ledger.size, 1, 'duplicate must not create a second ledger row');
  assert.equal(counters.duplicates, 1);
  assert.equal(counters.processed, 1);
});

test('a different key is a distinct effect', async () => {
  const pool = createFakePool();
  const counters = {};
  const handler = createEnvelopeHandler({ pool, counters, log: silentLog });
  await handler({ topic: TOPIC, key: 'k1', value: envelope({ dedupe_key: 'k1' }) });
  const outcome = await handler({ topic: TOPIC, key: 'k2', value: envelope({ dedupe_key: 'k2', event_id: 'evt-2' }) });
  assert.equal(outcome, 'processed');
  assert.equal(pool.ledger.size, 2);
});

test('key falls back to envelope.dedupe_key then event_id when message key is absent', async () => {
  const pool = createFakePool();
  const counters = {};
  const handler = createEnvelopeHandler({ pool, counters, log: silentLog });
  assert.equal(await handler({ topic: TOPIC, key: '', value: envelope() }), 'processed');
  // Same envelope dedupe_key, no message key -> duplicate via fallback.
  assert.equal(await handler({ topic: TOPIC, key: '', value: envelope() }), 'duplicate');
  const noDedupe = envelope({ dedupe_key: undefined, event_id: 'evt-only' });
  assert.equal(await handler({ topic: TOPIC, key: '', value: noDedupe }), 'processed');
  assert.ok(pool.ledger.has(`${TOPIC}|evt-only`));
});

test('unparseable message is invalid, loudly counted, and never touches the ledger', async () => {
  const pool = createFakePool();
  const counters = {};
  const errors = [];
  const handler = createEnvelopeHandler({ pool, counters, log: { log() {}, error: (line) => errors.push(line) } });
  const outcome = await handler({ topic: TOPIC, key: 'k', value: '{not json' });
  assert.equal(outcome, 'invalid');
  assert.equal(counters.invalid, 1);
  assert.equal(pool.ledger.size, 0);
  assert.equal(pool.verbs.length, 0, 'invalid messages must not open a transaction');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bad_json/);
});

test('envelope without any idempotency key is invalid, not silently processed', async () => {
  const pool = createFakePool();
  const counters = {};
  const handler = createEnvelopeHandler({ pool, counters, log: silentLog });
  const outcome = await handler({ topic: TOPIC, key: '', value: envelope({ dedupe_key: undefined, event_id: undefined }) });
  assert.equal(outcome, 'invalid');
  assert.equal(counters.invalid, 1);
  assert.equal(pool.ledger.size, 0);
});

test('database failure rolls back, counts an error, and leaves no effect', async () => {
  const pool = createFakePool({ failInsert: true });
  const counters = {};
  const handler = createEnvelopeHandler({ pool, counters, log: silentLog });
  await assert.rejects(
    handler({ topic: TOPIC, key: 'k1', value: envelope() }),
    /simulated database failure/,
  );
  assert.deepEqual(pool.verbs, ['BEGIN', 'INSERT', 'ROLLBACK']);
  assert.equal(counters.errors, 1);
  assert.equal(pool.ledger.size, 0);
});

test('offset commits exactly once, after the ledger write, at offset+1', async () => {
  const pool = createFakePool();
  const counters = {};
  const sequence = [];
  const originalConnect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      if (sql.trim().toUpperCase().startsWith('INSERT')) sequence.push('db');
      return originalQuery(sql, params);
    };
    return client;
  };
  const commits = [];
  const processor = createMessageProcessor({
    handler: createEnvelopeHandler({ pool, counters, log: silentLog }),
    commitOffsets: async (offsets) => { sequence.push('commit'); commits.push(offsets); },
    log: silentLog,
  });
  await processor({
    topic: TOPIC,
    partition: 0,
    message: { key: Buffer.from('k1'), value: Buffer.from(envelope()), offset: '41' },
  });
  assert.deepEqual(sequence, ['db', 'commit'], 'DB effect must precede the offset commit');
  assert.deepEqual(commits, [[{ topic: TOPIC, partition: 0, offset: '42' }]]);
});

test('a failing handler must NOT advance the committed offset (crash => replay)', async () => {
  const commits = [];
  const processor = createMessageProcessor({
    handler: async () => { throw new Error('db down'); },
    commitOffsets: async (offsets) => { commits.push(offsets); },
    log: silentLog,
  });
  await assert.rejects(
    processor({ topic: TOPIC, partition: 2, message: { key: null, value: Buffer.from(envelope()), offset: '7' } }),
    /db down/,
  );
  assert.equal(commits.length, 0, 'no commit on failure: the message must be redelivered');
});

test('consumer metrics expose all counters and escape label values', () => {
  const text = renderConsumerMetrics(
    { processed: 3, duplicates: 2, invalid: 1, errors: 0 },
    { group: 'g"r\\oup', topic: TOPIC },
  );
  assert.match(text, /^platform_event_consumer_up 1$/m);
  assert.match(text, /^platform_event_consumer_processed_total 3$/m);
  assert.match(text, /^platform_event_consumer_duplicates_total 2$/m);
  assert.match(text, /^platform_event_consumer_invalid_total 1$/m);
  assert.match(text, /^platform_event_consumer_errors_total 0$/m);
  assert.match(text, /group="g\\"r\\\\oup"/);
  assert.ok(text.endsWith('\n'));
});

test('schema DDL keeps the composite primary key that makes replay a no-op', () => {
  assert.match(CONSUMER_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS platform\.consumed_events/);
  assert.match(CONSUMER_SCHEMA_SQL, /PRIMARY KEY \(topic, dedupe_key\)/);
});

test('outbox stats zero-fill every state so DEAD_LETTER=0 is visible, not absent', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('GROUP BY state')) {
        return { rows: [{ state: 'DELIVERED', n: 7 }, { state: 'DEAD_LETTER', n: 2 }] };
      }
      if (sql.includes('age_seconds')) return { rows: [{ age_seconds: 12.5 }] };
      throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
    },
  };
  const stats = await collectOutboxStats(pool, 'kafka-pilot');
  assert.deepEqual(stats.byState, { PENDING: 0, DELIVERING: 0, DELIVERED: 7, RETRY: 0, DEAD_LETTER: 2 });
  assert.equal(stats.oldestReadySeconds, 12.5);
});

test('outbox metrics render all five states, failure outcomes, and escape kind', () => {
  const stats = { byState: { PENDING: 1, DELIVERING: 0, DELIVERED: 7, RETRY: 2, DEAD_LETTER: 3 }, oldestReadySeconds: 4 };
  const text = renderOutboxMetrics({ kind: 'k"ind', stats, counters: { published: 7, retry: 2, deadLetter: 3 } });
  for (const state of OUTBOX_STATES) {
    assert.ok(text.includes(`state="${state}"`), `missing state series ${state}`);
  }
  assert.match(text, /^platform_outbox_rows\{kind="k\\"ind",state="DEAD_LETTER"\} 3$/m);
  assert.match(text, /^platform_outbox_oldest_ready_seconds 4$/m);
  assert.match(text, /^platform_outbox_published_total 7$/m);
  assert.match(text, /^platform_outbox_failed_total\{outcome="retry"\} 2$/m);
  assert.match(text, /^platform_outbox_failed_total\{outcome="dead_letter"\} 3$/m);
});

test('outbox metrics tolerate a cold process with no stats yet', () => {
  const text = renderOutboxMetrics({ kind: 'kafka-pilot', stats: undefined, counters: undefined });
  assert.match(text, /^platform_outbox_rows\{kind="kafka-pilot",state="PENDING"\} 0$/m);
  assert.match(text, /^platform_outbox_failed_total\{outcome="dead_letter"\} 0$/m);
});