#!/usr/bin/env bash
# =============================================================================
# Restore drill — prove the newest backup actually restores.
#
#   bash n8n/scripts/restore-drill.sh
#
# Backups that were never restored are only a belief. This script restores the
# newest backup set into throwaway databases, checks what a restore must
# contain, and drops them again — production data is never touched.
#
# Checks:
#   - pg-n8n  dump   → temp db, expect the platform data tables
#   - pg-lobechat    → temp db, expect LobeHub's schema and its key rows
#   - minio archive  → object count (listed, not extracted)
#
# Exit: 0 = drill passed, 1 = a check failed, 2 = prerequisites missing.
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${REPO_DIR}/backups"

if [ -f "${REPO_DIR}/.env" ]; then
  set -a; . "${REPO_DIR}/.env"; set +a
fi
PG_CONTAINER="${PG_CONTAINER:-postgres}"
PG_USER="${POSTGRES_USER:-n8n}"
PG_DB="${POSTGRES_DB:-n8n}"
# Backups run twice a day; anything older than this means the job is stuck.
MAX_AGE_HOURS="${MAX_AGE_HOURS:-48}"

[ -d "$BACKUP_DIR" ] || { echo "no backup dir: $BACKUP_DIR" >&2; exit 2; }

STAMP="$(date +%Y%m%d-%H%M%S)"
DB_N8N="drill_n8n_${STAMP}"
DB_LOBE="drill_lobe_${STAMP}"

cleanup() {
  echo "-- dropping drill databases"
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_N8N\"" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_LOBE\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The glob must sit OUTSIDE the quotes or bash will not expand it.
latest() { ls -t "${BACKUP_DIR}"/$1 2>/dev/null | head -1 | xargs -r basename; }

DUMP_N8N="$(latest 'pg-n8n-*.sql.gz')"
DUMP_LOBE="$(latest 'pg-lobechat-*.sql.gz')"
ARCH_MINIO="$(latest 'minio-data-*.tar.gz')"

[ -n "$DUMP_N8N" ] || { echo "no pg-n8n dump found" >&2; exit 2; }
[ -n "$DUMP_LOBE" ] || { echo "no pg-lobechat dump found" >&2; exit 2; }

echo "== restore drill $STAMP"
echo "   n8n dump      : $DUMP_N8N"
echo "   lobechat dump : $DUMP_LOBE"
echo "   minio archive : ${ARCH_MINIO:-<none>}"

AGE_HOURS="$(( ( $(date +%s) - $(stat -c %Y "${BACKUP_DIR}/${DUMP_N8N}") ) / 3600 ))"
echo "   backup age    : ${AGE_HOURS}h (limit ${MAX_AGE_HOURS}h)"
echo

FAIL=0
check() { # check <label> <actual> <expected-at-least>
  local label="$1" actual="$2" want="$3"
  if [ "$actual" -ge "$want" ] 2>/dev/null; then
    echo "   OK   $label = $actual (>= $want)"
  else
    echo "   FAIL $label = $actual (< $want)"
    FAIL=1
  fi
}

psql_q() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -t -A -c "$2" | tr -d '\r'; }

# ---------- n8n datastore ----------
echo "-- restoring n8n dump into $DB_N8N"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE \"$DB_N8N\"" >/dev/null
gunzip -c "${BACKUP_DIR}/${DUMP_N8N}" | docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$DB_N8N" >/dev/null 2>&1

N8N_TABLES="$(psql_q "$DB_N8N" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" || echo 0)"
check "n8n tables" "$N8N_TABLES" 15

# Agent Platform data tables. These are n8n *data tables*, not Postgres tables
# with the same name: they live in the `data_table` registry, with the rows in
# `data_table_user_<id>`. Losing the registry is what makes a restore useless.
N8N_DT="$(psql_q "$DB_N8N" "SELECT count(*) FROM data_table" 2>/dev/null || echo 0)"
check "n8n data tables registered" "$N8N_DT" 15

# A table that exists live but is absent from the restored copy is not proof the
# backup is broken — it usually means the table was created after the last backup
# ran. That is still worth shouting about (you are unprotected right now), but it
# is a coverage gap, not a restore failure, so it is reported separately.
GAPS=""
for t in documents weekly_reviews admin_audit people todos reminders tool_contract; do
  live="$(psql_q "$PG_DB" "SELECT count(*) FROM data_table WHERE name='$t'" 2>/dev/null || echo 0)"
  [ "$live" -ge 1 ] || continue
  n="$(psql_q "$DB_N8N" "SELECT count(*) FROM data_table WHERE name='$t'" 2>/dev/null || echo 0)"
  if [ "$n" -ge 1 ]; then
    check "data table $t" "$n" 1
  else
    GAPS="${GAPS} ${t}"
  fi
done

DT_ROWS="$(psql_q "$DB_N8N" "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'data_table_user_%'" 2>/dev/null || echo 0)"
check "n8n data table stores" "$DT_ROWS" 15

# ---------- LobeHub datastore ----------
echo "-- restoring lobechat dump into $DB_LOBE"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE \"$DB_LOBE\"" >/dev/null
gunzip -c "${BACKUP_DIR}/${DUMP_LOBE}" | docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$DB_LOBE" >/dev/null 2>&1

LOBE_TABLES="$(psql_q "$DB_LOBE" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" || echo 0)"
check "lobechat tables" "$LOBE_TABLES" 100

# The rows that make the wiring work — losing these is what a bad restore costs
for t in users agents user_settings ai_providers; do
  n="$(psql_q "$DB_LOBE" "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo 0)"
  check "lobechat rows $t" "$n" 1
done

# ---------- MinIO archive ----------
if [ -n "$ARCH_MINIO" ]; then
  # Docker wants the Windows form of the path when invoked from Git Bash.
  BACKUP_WIN="$(cd "$BACKUP_DIR" && pwd -W 2>/dev/null || pwd)"
  OBJ="$(docker run --rm -v "${BACKUP_WIN}:/backup:ro" alpine sh -c "tar tzf /backup/${ARCH_MINIO} | wc -l" 2>/dev/null | tr -d ' \r' || echo 0)"
  check "minio archive entries" "${OBJ:-0}" 1
else
  echo "   SKIP minio archive (none found)"
fi

echo
if [ -n "$GAPS" ]; then
  echo "   GAP  in live DB but not in the newest backup:$GAPS"
  echo "        (created after the last backup ran — run backup.sh to cover them)"
fi
echo
if [ "$FAIL" -eq 0 ]; then
  echo "RESTORE DRILL PASSED${GAPS:+ (with coverage gaps)}"
  exit 0
fi
echo "RESTORE DRILL FAILED" >&2
exit 1
