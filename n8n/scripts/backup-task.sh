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
    echo "==== $(date '+%Y-%m-%d %H:%M:%S') backup task done ===="
  else
    echo "backup.sh exited non-zero - see output above"
    echo "==== $(date '+%Y-%m-%d %H:%M:%S') backup task FAILED ===="
    exit 1
  fi
} >> "${LOG}" 2>&1
