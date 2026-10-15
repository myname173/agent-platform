#!/usr/bin/env node
/**
 * Re-embed existing vectors before switching all writers/readers to
 * qwen3.7-text-embedding-flash. Run inside the n8n container:
 *   docker cp n8n/scripts/reembed-flash.mjs n8n:/tmp/reembed-flash.mjs
 *   docker exec n8n node /tmp/reembed-flash.mjs --dry-run
 *   # Back up kb_chunks, agent_memories and user_memories first.
 *   docker exec -e MIGRATION_BACKUPS_CONFIRMED=1 n8n node /tmp/reembed-flash.mjs --apply
 *
 * Uses the bundled pg package; never prints keys or full document text. A
 * failed API request leaves stored vectors intact because no DB write starts
 * until ALL embeddings have been produced and validated.
 */
import { createRequire } from 'node:module';

const require = createRequire('/usr/local/lib/node_modules/n8n/package.json');
const { Client } = require('pg');
const MODEL = 'qwen3.7-text-embedding-flash';
const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
const action = process.argv[2];
if (!['--dry-run', '--apply'].includes(action)) {
  console.error('Usage: node reembed-flash.mjs --dry-run|--apply');
  process.exit(2);
}
if (action === '--apply' && process.env.MIGRATION_BACKUPS_CONFIRMED !== '1') {
  console.error('Back up kb_chunks, agent_memories, user_memories first; set MIGRATION_BACKUPS_CONFIRMED=1');
  process.exit(2);
}

const config = (database) => ({
  host: process.env.DB_POSTGRESDB_HOST || 'postgres',
  port: Number(process.env.DB_POSTGRESDB_PORT || 5432),
  database,
  user: process.env.DB_POSTGRESDB_USER || 'n8n',
  password: process.env.DB_POSTGRESDB_PASSWORD,
});
const db = new Client(config(process.env.DB_POSTGRESDB_DATABASE || 'n8n'));
const lobe = new Client(config('lobechat'));
let totalTokens = 0;
let requests = 0;

async function embedBatch(texts) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.DASHSCOPE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: { texts },
      parameters: { dimension: 1024, text_type: 'document', output_type: 'dense' },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`embedding HTTP ${response.status}: ${result.code || ''} ${result.message || ''}`);
  const vectors = result.output?.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length ||
      !vectors.every((entry) => Array.isArray(entry.embedding) &&
        entry.embedding.length === 1024 && entry.embedding.every(Number.isFinite))) {
    throw new Error('embedding batch response has missing or invalid 1024-dimensional vectors');
  }
  totalTokens += Number(result.usage?.total_tokens || 0);
  requests += 1;
  return vectors.map((entry) => '[' + entry.embedding.join(',') + ']');
}

async function buildVectors(rows) {
  const cache = new Map();
  const unique = [...new Set(rows.map((row) => row.text))];
  for (let i = 0; i < unique.length; i += 20) {
    const texts = unique.slice(i, i + 20);
    const vectors = await embedBatch(texts);
    for (let j = 0; j < texts.length; j++) cache.set(texts[j], vectors[j]);
    console.log(`  embedded ${Math.min(i + 20, unique.length)}/${unique.length} distinct texts; tokens=${totalTokens}`);
  }
  return cache;
}

async function commitVectors(client, label, update) {
  await client.query('BEGIN');
  try {
    const n = await update();
    await client.query('COMMIT');
    console.log(`${label}: committed ${n} row(s)`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

try {
  await Promise.all([db.connect(), lobe.connect()]);
  const chunks = (await db.query('SELECT chunk_id, content FROM kb_chunks ORDER BY chunk_id')).rows;
  const memories = (await db.query('SELECT id, text FROM agent_memories WHERE embedding IS NOT NULL ORDER BY id')).rows;
  const lobeMemories = (await lobe.query(`
    SELECT id, summary, details, summary_vector_1024 IS NOT NULL AS has_summary,
           details_vector_1024 IS NOT NULL AS has_details
      FROM user_memories
     WHERE summary_vector_1024 IS NOT NULL OR details_vector_1024 IS NOT NULL
     ORDER BY id
  `)).rows;
  const inputs = [
    ...chunks.map((x) => ({ text: x.content })),
    ...memories.map((x) => ({ text: x.text })),
    ...lobeMemories.flatMap((x) => [
      ...(x.has_summary ? [{ text: x.summary }] : []),
      ...(x.has_details ? [{ text: x.details }] : []),
    ]),
  ];
  if (inputs.some((x) => !x.text?.trim())) throw new Error('found an empty text with a stored vector; aborting');
  console.log(JSON.stringify({ model: MODEL, chunks: chunks.length, agentMemories: memories.length,
    lobeMemories: lobeMemories.length, distinctTexts: new Set(inputs.map((x) => x.text)).size,
    totalChars: inputs.reduce((n, x) => n + x.text.length, 0), action }));
  if (action === '--dry-run') process.exitCode = 0;
  else {
    if (!process.env.DASHSCOPE_API_KEY) throw new Error('DASHSCOPE_API_KEY is missing');
    const vectors = await buildVectors(inputs);
    await commitVectors(db, 'n8n', async () => {
      let updated = 0;
      for (const row of chunks) {
        const result = await db.query(
          'UPDATE kb_chunks SET embedding = $1::vector WHERE chunk_id = $2 AND content = $3',
          [vectors.get(row.content), row.chunk_id, row.content],
        );
        if (result.rowCount !== 1) throw new Error(`kb_chunks changed concurrently: ${row.chunk_id}`);
        updated += 1;
      }
      for (const row of memories) {
        const result = await db.query(
          'UPDATE agent_memories SET embedding = $1::vector WHERE id = $2 AND text = $3',
          [vectors.get(row.text), row.id, row.text],
        );
        if (result.rowCount !== 1) throw new Error(`agent_memories changed concurrently: ${row.id}`);
        updated += 1;
      }
      return updated;
    });
    await commitVectors(lobe, 'lobechat', async () => {
      let updated = 0;
      for (const row of lobeMemories) {
        const result = await lobe.query(`
          UPDATE user_memories
             SET summary_vector_1024 = CASE WHEN $1::boolean THEN $2::vector ELSE summary_vector_1024 END,
                 details_vector_1024 = CASE WHEN $3::boolean THEN $4::vector ELSE details_vector_1024 END
           WHERE id = $5 AND summary IS NOT DISTINCT FROM $6 AND details IS NOT DISTINCT FROM $7
        `, [row.has_summary, row.has_summary ? vectors.get(row.summary) : null,
          row.has_details, row.has_details ? vectors.get(row.details) : null,
          row.id, row.summary, row.details]);
        if (result.rowCount !== 1) throw new Error(`user_memories changed concurrently: ${row.id}`);
        updated += 1;
      }
      return updated;
    });
    console.log(`Migration complete: ${requests} embedding request(s), ${totalTokens} tokens; verify retrieval before deleting backups.`);
  }
} catch (error) {
  console.error(`Migration FAILED: ${error.message}. Keep backups; if the n8n transaction committed, restore vectors from the backup before retrying.`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([db.end(), lobe.end()]);
}
