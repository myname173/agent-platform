import pg from '../frontent/node_modules/pg/lib/index.js';

const client = new pg.Client({
  host: 'localhost',
  port: 5432,
  database: 'n8n',
  user: 'n8n',
  password: 'SaajSkNd8cyPZJVoLJzX0RuJVKhd6Uzt',
});

try {
  await client.connect();
  const res = await client.query('SELECT email, "firstName", "lastName" FROM "user"');
  console.log('n8n Users:', res.rows);
  const docs = await client.query('SELECT doc_id, title, status FROM kb_documents LIMIT 5');
  console.log('KB Docs:', docs.rows);
} catch (e) {
  console.error(e);
} finally {
  await client.end();
}
