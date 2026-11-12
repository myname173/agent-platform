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
  embedding  vector(1024) NOT NULL,         -- qwen3.7-text-embedding-flash, dim 1024
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_chunks_hnsw
  ON kb_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks (doc_id);

-- =============================================================================
-- Optional BM25 full-text leg for hybrid retrieval (Agentic RAG: vector + BM25
-- fused with RRF). Guarded and failure-tolerant: the index is only created when
-- ParadeDB pg_search is installable, and any failure (e.g. not preloaded via
-- shared_preload_libraries) is caught and logged, leaving vector-only retrieval.
-- The runtime probe (n8n/lib/kb-hybrid.mjs) checks for this index before ever
-- issuing a BM25 query, so an absent index degrades silently to the previous
-- vector behaviour — zero regression on stacks without pg_search. Idempotent.
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search') THEN
    BEGIN
      EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_search';
      EXECUTE 'CREATE INDEX IF NOT EXISTS kb_chunks_bm25 ON kb_chunks USING bm25 (chunk_id, content) WITH (key_field=''chunk_id'')';
      RAISE NOTICE 'kb_chunks_bm25 ready — hybrid BM25 leg enabled';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pg_search present but kb_chunks_bm25 not created (%); hybrid degrades to vector-only', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'pg_search not available; kb_chunks_bm25 skipped — hybrid degrades to vector-only';
  END IF;
END
$$;
