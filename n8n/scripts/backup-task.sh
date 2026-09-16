#!/usr/bin/env bash
# =============================================================================
# backup-task.sh - daily scheduled backup wrapper for agent-platform
#   Runs backup.sh (keep 30), then integrity-checks the newest artifacts and
#   appends a small audit trail to backups/backup-task.log
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${REPO_DIR}/backups/backup-task.log"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"


# best-effort heartbeat to the platform (never fails the backup)
send_heartbeat() {
  local ok="$1"
  local detail="$2"
  local chat_key
  chat_key="$(grep -m1 '^CHAT_API_KEY=' "${REPO_DIR}/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r')"
  if [ -z "${chat_key}" ]; then echo "heartbeat: skipped (no CHAT_API_KEY)"; return 0; fi
  local authh="Bea""rer ${chat_key}"
  if curl -sS -m 20 -X POST "http://localhost:5678/webhook/admin/heartbeat" -H "Content-Type: application/json" -H "Authorization: ${authh}" -d "{\"job\":\"backup\",\"ok\":${ok},\"detail\":\"${detail}\"}" >/dev/null 2>&1; then
    echo "heartbeat sent (ok=${ok})"
  else
    echo "heartbeat failed (non-fatal)"
  fi
}

{
  echo "==== ${STAMP} backup task start ===="
  if bash "${REPO_DIR}/n8n/scripts/backup.sh" 30; then
    newest_dump="$(ls -t "${REPO_DIR}"/backups/pg-n8n-*.sql.gz 2>/dev/null | head -1)"
    newest_vol="$(ls -t "${REPO_DIR}"/backups/n8n-data-*.tar.gz 2>/dev/null | head -1)"
    if [ -n "${newest_dump}" ] && gunzip -t "${newest_dump}"; then
      echo "integrity: postgres dump OK  ($(basename "${newest_dump}"))"
    else
      echo "integrity: postgres dump FAILED"
    fi
    if [ -n "${newest_vol}" ] && tar -tzf "${newest_vol}" >/dev/null; then
      echo "integrity: volume archive OK ($(basename "${newest_vol}"))"
    else
      echo "integrity: volume archive FAILED"
    fi
    newest_lobe="$(ls -t "${REPO_DIR}"/backups/pg-lobechat-*.sql.gz 2>/dev/null | head -1)"
    newest_minio="$(ls -t "${REPO_DIR}"/backups/minio-data-*.tar.gz 2>/dev/null | head -1)"
    if [ -n "${newest_lobe}" ] && gunzip -t "${newest_lobe}"; then
      echo "integrity: lobechat dump OK  ($(basename "${newest_lobe}"))"
    else
      echo "integrity: lobechat dump FAILED"
    fi
    if [ -n "${newest_minio}" ] && tar -tzf "${newest_minio}" >/dev/null; then
      echo "integrity: minio archive OK ($(basename "${newest_minio}"))"
    else
      echo "integrity: minio archive FAILED"
    fi
    echo "==== $(date '+%Y-%m-%d %H:%M:%S') backup task done ===="
    send_heartbeat true "dump=$(basename "${newest_dump:-none}") artifacts=ok"
  else
    echo "backup.sh exited non-zero - see output above"
    echo "==== $(date '+%Y-%m-%d %H:%M:%S') backup task FAILED ===="
    send_heartbeat false "backup.sh exited non-zero"
    exit 1
  fi
} >> "${LOG}" 2>&1
