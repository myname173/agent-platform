-- =============================================================================
-- agent-platform knowledge base schema (KB-DESIGN v1.1, P1)
-- Apply:  docker exec -i postgres psql -U n8n -d n8n < n8n/scripts/kb-schema.sql
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kb_documents (
  doc_id      text PRIMARY KEY,              -- content-hash derived stable id
  title       text NOT NULL,
  source_type text NOT NULL,                 -- file | url | text
  source_ref  text,                          -- path / URL
  content_sha text NOT NULL,                 -- idempotent ingest fingerprint
  status      text NOT NULL DEFAULT 'active',-- active | retired
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kb_chunks (
  chunk_id   bigserial PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES kb_documents(doc_id) ON DELETE CASCADE,
  seq        int  NOT NULL,                 -- chunk order (restores reading flow)
  content    text NOT NULL,                 -- chunk body (what the model sees)
  n_tokens   int,
  embedding  vector(1024) NOT NULL,         -- qwen3.7-text-embedding, dim 1024
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_chunks_hnsw
  ON kb_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks (doc_id);
