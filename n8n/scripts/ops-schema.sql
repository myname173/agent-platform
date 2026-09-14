-- ============================================================================
-- agent-platform ops schema (priority 6: error-rate alerting)
-- Apply:  docker exec -i postgres psql -U n8n -d n8n < n8n/scripts/ops-schema.sql
-- Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ops_alerts (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL DEFAULT 'error_rate',
  window_minutes int NOT NULL,
  total       int  NOT NULL,
  errors      int  NOT NULL,
  error_rate  double precision NOT NULL,
  threshold   double precision NOT NULL,
  message     text NOT NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_alerts_created ON ops_alerts (created_at DESC);
