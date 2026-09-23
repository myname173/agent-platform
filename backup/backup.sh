#!/usr/bin/env bash
# =============================================================================
# backup.sh (in-stack) - one backup run, executed inside the compose stack.
#
# Produces the same five artefacts as the host script so the self-check's
# `backup heartbeat fresh` (n=5, bytes>0, integrity=4/4) keeps working:
#   n8n-data-*.tar.gz        n8n_data volume
#   config-n8n-data-*.tar.gz docker-compose.yml + .env (self-contained restore)
#   minio-data-*.tar.gz      minio_data volume
#   pg-n8n-*.sql.gz          pg_dump of the n8n database
#   pg-lobechat-*.sql.gz     pg_dump of the lobechat database
# =============================================================================
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
PGHOST="${PGHOST:-postgres}"
PGUSER="${PGUSER:?PGUSER is required}"
PGPASSWORD="${PGPASSWORD:-}"
PG_DB="${POSTGRES_DB:-n8n}"
export PGPASSWORD

MIN_AGE_H="${BACKUP_MIN_AGE_HOURS:-20}"
KEEP="${BACKUP_KEEP:-30}"
CHAT_API_KEY="${CHAT_API_KEY:-}"
HEARTBEAT_URL="${HEARTBEAT_URL:-http://n8n:5678/webhook/admin/heartbeat}"

log() { echo "[$(date '+%F %T')] $*"; }

# ---------------------------------------------------------------------------
# Freshness guard: skip when the last *successful* backup is recent.
# The marker is touched only after every integrity check passes, so "recent
# marker" means "recent good backup". Without this, a machine that stays up
# would produce a fresh ~110MB set on every interval.
# ---------------------------------------------------------------------------
MARKER="${BACKUP_DIR}/.last-ok"
if [ -f "$MARKER" ]; then
  now="$(date +%s)"
  m="$(stat -c %Y "$MARKER" 2>/dev/null || echo 0)"
  ageH=$(( (now - m) / 3600 ))
  if [ "$ageH" -lt "$MIN_AGE_H" ]; then
    log "skip: last successful backup was ${ageH}h ago (< ${MIN_AGE_H}h)"
    exit 0
  fi
fi

mkdir -p "$BACKUP_DIR"
cd "$BACKUP_DIR" || exit 1

# postgres may still be finishing its init right after the stack comes up
for _ in $(seq 1 60); do
  pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 5
done

N=0
NAME="n8n-data-${STAMP}.tar.gz"
tar czf "$NAME" -C /vol/n8n_data . && { log "volume archived: $NAME"; N=$((N + 1)); }

CFG="config-n8n-data-${STAMP}.tar.gz"
tar czf "$CFG" -C /cfg docker-compose.yml .env && { log "config bundle: $CFG"; N=$((N + 1)); }

MINIO="minio-data-${STAMP}.tar.gz"
tar czf "$MINIO" -C /vol/minio_data . && { log "minio archived: $MINIO"; N=$((N + 1)); }

PGN="pg-n8n-${STAMP}.sql.gz"
pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PG_DB" | gzip > "$PGN" && { log "postgres dump: $PGN"; N=$((N + 1)); }

PGL="pg-lobechat-${STAMP}.sql.gz"
if psql -h "$PGHOST" -U "$PGUSER" -d lobechat -c "SELECT 1" >/dev/null 2>&1; then
  pg_dump -h "$PGHOST" -U "$PGUSER" -d lobechat | gzip > "$PGL" && { log "postgres dump (lobechat): $PGL"; N=$((N + 1)); }
else
  log "WARNING: lobechat database not reachable - skipped"
fi

# ---------------------------------------------------------------------------
# Integrity: the self-check refuses a heartbeat that does not carry evidence.
# ---------------------------------------------------------------------------
INTEG_OK=0
check() {
  if [ -s "$1" ] && gzip -t "$1" 2>/dev/null; then
    INTEG_OK=$((INTEG_OK + 1)); log "integrity: $2 OK ($1)"
  else
    log "integrity: $2 FAILED ($1)"
  fi
}
check "$PGN" "postgres dump"
check "$NAME" "volume archive"
check "$PGL" "lobechat dump"
check "$MINIO" "minio archive"
INTEG="${INTEG_OK}/4"

BYTES="$(cat "$NAME" "$CFG" "$MINIO" "$PGN" "$PGL" 2>/dev/null | wc -c | tr -d ' ')"

# prune whole sets, never single files (a half-pruned set is worse than none)
ls -1t n8n-data-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
  s="${f#n8n-data-}"; s="${s%.tar.gz}"
  rm -f "n8n-data-${s}.tar.gz" "config-n8n-data-${s}.tar.gz" "minio-data-${s}.tar.gz" \
        "pg-n8n-${s}.sql.gz" "pg-lobechat-${s}.sql.gz"
  log "pruned set ${s}"
done

OK=false
if [ "$N" -eq 5 ] && [ "$INTEG_OK" -eq 4 ]; then
  OK=true
  touch "$MARKER"
else
  log "INCOMPLETE: artefacts=${N}/5 integrity=${INTEG} - marker not updated"
fi

# ---------------------------------------------------------------------------
# Heartbeat. The detail is a JSON object, so its quotes must be escaped, or the
# body is invalid JSON and the endpoint answers 422 -- which curl would happily
# report as success unless the HTTP status is read back.
# ---------------------------------------------------------------------------
send_heartbeat() {
  local ok="$1" detail="$2"
  if [ -z "$CHAT_API_KEY" ]; then log "heartbeat: skipped (no CHAT_API_KEY)"; return 0; fi
  local esc="${detail//\\/\\\\}"
  esc="${esc//\"/\\\"}"
  local body out http
  body="$(printf '{"job":"backup","ok":%s,"detail":"%s"}' "$ok" "$esc")"
  out="$(mktemp)"
  http="$(curl -sS -m 20 -o "$out" -w '%{http_code}' -X POST "$HEARTBEAT_URL" \
    -H 'Content-Type: application/json' -H "Authorization: Bea""rer ${CHAT_API_KEY}" \
    -d "$body" 2>/dev/null || echo 000)"
  if [ "$http" = "200" ]; then
    log "heartbeat sent (ok=${ok})"
  else
    log "heartbeat FAILED (http=${http}) $(head -c 200 "$out" 2>/dev/null)"
    log "  ^ no heartbeat landed, so the self-check will go stale"
  fi
  rm -f "$out"
}

DETAIL="$(printf '{"stamp":"%s","n":%d,"bytes":%d,"integrity":"%s"}' "$STAMP" "$N" "$BYTES" "$INTEG")"
log "heartbeat payload: ${DETAIL}"
send_heartbeat "$OK" "$DETAIL"
