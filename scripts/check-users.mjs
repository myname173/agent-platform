// Read-only sanity check of the platform's Postgres: users + a few KB rows.
//
// Run it from the repo root with the gitignored .env:
//     node --env-file=.env scripts/check-users.mjs
//
// The password used to be a literal here, which meant it was committed -- and this
// repo sat on GitHub publicly. If this file ever contains a real credential again,
// scripts/secret-scan.sh (and the pre-push hook) now fails the push, so keep it env-only.
import { createRequire } from 'node:module';

// pg is not a dependency of this folder; it is borrowed from an installed subtree.
// The old single hardcoded path (frontent/node_modules/pg) went stale and the script
// died with an ERR_MODULE_NOT_FOUND stack before reaching any of its own checks --
// which is exactly how a credential gate ends up never running. Try both, then say
// plainly what to install.
const require = createRequire(import.meta.url);
const candidates = [
  '../platform-runtime/node_modules/pg/lib/index.js',
  '../frontent/node_modules/pg/lib/index.js',
];
let pg = null;
for (const c of candidates) {
  try {
    pg = require(c);
    break;
  } catch {
    /* try the next location */
  }
}
if (!pg) {
  console.error(
    'pg not found. Install it once:  npm --prefix platform-runtime install\n' +
      `(looked in: ${candidates.join(', ')})`
  );
  process.exit(1);
}

const PASSWORD = String(process.env.POSTGRES_PASSWORD || '').trim();
if (!PASSWORD) {
  console.error(
    'POSTGRES_PASSWORD is empty. Run it as:  node --env-file=.env scripts/check-users.mjs\n' +
      'Refusing to connect with a blank password -- that would look like an auth bug, not a missing env.'
  );
  process.exit(1);
}

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = Number(process.env.DB_PORT || 5432);

const client = new pg.Client({
  host: DB_HOST,
  port: DB_PORT,
  database: process.env.POSTGRES_DB || 'n8n',
  user: process.env.POSTGRES_USER || 'n8n',
  password: PASSWORD,
});

try {
  await client.connect();
  const res = await client.query('SELECT email, "firstName", "lastName" FROM "user"');
  console.log('n8n Users:', res.rows);
  const docs = await client.query('SELECT doc_id, title, status FROM kb_documents LIMIT 5');
  console.log('KB Docs:', docs.rows);
} catch (e) {
  const msg = e && e.code === 'ECONNREFUSED'
    ? `${e.code} connecting to ${DB_HOST}:${DB_PORT} -- ` +
      'the compose file does not publish Postgres on the host (no 5432 mapping, ' +
      'nothing listening locally). Run this from a container on the stack network, ' +
      'or add a port mapping first.'
    : (e.message || String(e));
  console.error(msg);
  process.exitCode = 1;
} finally {
  await client.end();
}
