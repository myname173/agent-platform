#!/usr/bin/env node
/**
 * KB golden-set evaluation (KB-DESIGN v1.1 §7).
 * Runs INSIDE the n8n container (needs pg + DashScope key):
 *   docker cp n8n/eval/golden-set.json n8n:/tmp/golden-set.json
 *   docker exec n8n sh -c 'cd /usr/local/lib/node_modules/n8n && \
 *     NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules \
 *     node --no-warnings /usr/local/lib/node_modules/n8n/scripts/kb-eval.mjs'
 * Metrics: hit@5 and MRR over the golden cases (retrieval relevance,
 * the first of the four RAG evaluation dimensions).
 */
const fs = require('fs');
const { Client } = require('pg');

const GS = process.env.KB_GOLDEN || '/tmp/golden-set.json';
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';

(async () => {
  const key = (process["DASHSCOPE_API_KEY"] || '').trim();
  const gs = JSON.parse(fs.readFileSync(GS, 'utf8'));
  const pg = new Client({
    host: process.env.DB_POSTGRESDB_HOST || 'postgres',
    port: Number(process.env.DB_POSTGRESDB_PORT || 5432),
    database: process.env.DB_POSTGRESDB_DATABASE || 'n8n',
    user: process.env.DB_POSTGRESDB_USER || 'n8n',
    password: process.env.DB_POSTGRESDB_PASSWORD,
  });
  await pg.connect();

  const embed = async (text, type) => {
    const resp = await fetch(DASHSCOPE_URL, {
      method: 'POST',
      headers: { Authorization: '***' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-text-embedding',
        input: { texts: [text] },
        parameters: {
          dimension: 1024,
          text_type: type,
          output_type: 'dense',
          ...(type === 'query' ? { instruct: 'Given a user question about internal documents, retrieve the most relevant passages' } : {}),
        },
      }),
    });
    if (!resp.ok) throw new Error('embed failed: ' + resp.status + ' ' + (await resp.text()).slice(0, 150));
    return (await resp.json()).output.embeddings[0].embedding;
  };

  // ensure the golden docs are ingested (idempotent by content)
  for (const doc of gs.docs) {
    const sha = require('crypto').createHash('sha256').update(doc.text).digest('hex');
    const docId = 'kb-' + sha.slice(0, 16);
    const exists = await pg.query('SELECT content_sha FROM kb_documents WHERE doc_id = $1', [docId]);
    if (exists.rows.length && exists.rows[0].content_sha === sha) continue;
    console.log('ingesting golden doc:', doc.title);
    const chunks = [doc.text]; // short docs: single chunk
    const embs = [await embed(doc.text, 'document')];
    await pg.query('BEGIN');
    await pg.query(
      `INSERT INTO kb_documents (doc_id, title, source_type, source_ref, content_sha, status)
       VALUES ($1,$2,'text','golden-set',$3,'active')
       ON CONFLICT (doc_id) DO UPDATE SET status='active', updated_at=now()`,
      [docId, doc.title, sha]
    );
    await pg.query('DELETE FROM kb_chunks WHERE doc_id = $1', [docId]);
    for (let i = 0; i < chunks.length; i++) {
      await pg.query(
        `INSERT INTO kb_chunks (doc_id, seq, content, embedding) VALUES ($1,$2,$3,$4::vector)`,
        [docId, i, chunks[i], '[' + embs[i].join(',') + ']']
      );
    }
    await pg.query('COMMIT');
  }

  // run the cases
  let mrrSum = 0;
  let hits = 0;
  const detail = [];
  for (const c of gs.cases) {
    const vec = await embed(c.q, 'query');
    const r = await pg.query(
      `SELECT d.title, 1 - (c.embedding <=> $1::vector) AS score
         FROM kb_chunks c JOIN kb_documents d ON d.doc_id = c.doc_id
        WHERE d.status = 'active'
        ORDER BY c.embedding <=> $1::vector LIMIT 5`,
      ['[' + vec.join(',') + ']']
    );
    const rank = r.rows.findIndex((x) => x.title === c.expect_title);
    const hit = rank >= 0 ? 1 : 0;
    hits += hit;
    mrrSum += rank >= 0 ? 1 / (rank + 1) : 0;
    detail.push({ q: c.q, hit, rank: rank >= 0 ? rank + 1 : null, top1: r.rows[0]?.title || null });
    console.log((hit ? 'HIT ' : 'MISS') + (rank >= 0 ? '@' + (rank + 1) : '   '), '|', c.q.slice(0, 40), '| top1:', r.rows[0]?.title || '—');
  }
  const report = {
    cases: gs.cases.length,
    hit_at_5: Number((hits / gs.cases.length).toFixed(3)),
    mrr: Number((mrrSum / gs.cases.length).toFixed(3)),
    ran_at: new Date().toISOString(),
  };
  console.log('\n=== KB EVAL REPORT ===');
  console.log(JSON.stringify(report, null, 1));
  fs.writeFileSync('/tmp/kb-eval-report.json', JSON.stringify({ ...report, detail }, null, 1));
  await pg.end();
  if (report.hit_at_5 < 0.8) {
    console.error('hit@5 below 0.8 threshold');
    process.exit(1);
  }
})().catch((e) => { console.error('EVAL FAILED:', e.message); process.exit(1); });
