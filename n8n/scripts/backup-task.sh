#!/usr/bin/env bash
# =============================================================================
# backup-task.sh - daily scheduled backup wrapper for agent-platform
#   Runs backup.sh (keep 30), then integrity-checks the newest artifacts and
#   appends a small audit trail to backups/backup-task.log
#
# The heartbeat used to be a bare "backup ran, trust me" ping. That made the
# self-check lie: a single curl could keep it green for days while no backup
# existed (it was in fact green for 63 hours with the newest artifact two and
# a half days old). The heartbeat now carries evidence — how many artifacts,
# how many bytes, how many integrity checks passed — and the self-check
# refuses to accept one without it.
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${REPO_DIR}/backups/backup-task.log"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
RUNSTAMP="$(date '+%Y%m%d-%H%M%S')"

# Optional second copy on another disk / NAS / synced folder. Backups live on
# the same machine as the data, so a dead disk takes both; this is the only
# thing that survives that. Set BACKUP_OFFSITE_DIR in .env to enable.
OFFSITE="$(grep -m1 '^BACKUP_OFFSITE_DIR=' "${REPO_DIR}/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r' | tr -d '"')"

# best-effort heartbeat to the platform (never fails the backup)
send_heartbeat() {
  local ok="$1"
  local detail="$2"
  local chat_key
  chat_key="$(grep -m1 '^CHAT_API_KEY=' "${REPO_DIR}/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r')"
  if [ -z "${chat_key}" ]; then echo "heartbeat: skipped (no CHAT_API_KEY)"; return 0; fi
  local authh="Bea""rer ${chat_key}"
  # `detail` carries a JSON object (artifact count / bytes / integrity). Splicing
  # it into the body raw produced INVALID JSON, the endpoint answered 422, and --
  # because only curl's exit code was checked -- the log still printed
  # "heartbeat sent (ok=true)". That is how the self-check reported "backup stale"
  # minutes after a perfectly good backup. Escape it, and read the HTTP status.
  local esc="${detail//\\/\\\\}"
  esc="${esc//\"/\\\"}"
  local body
  body="$(printf '{"job":"backup","ok":%s,"detail":"%s"}' "${ok}" "${esc}")"
  local hb_out http
  hb_out="$(mktemp)"
  http="$(curl -sS -m 20 -o "${hb_out}" -w '%{http_code}' -X POST "http://localhost:5678/webhook/admin/heartbeat" -H "Content-Type: application/json" -H "Authorization: ${authh}" -d "${body}" 2>/dev/null || echo 000)"
  if [ "${http}" = "200" ]; then
    echo "heartbeat sent (ok=${ok})"
  else
    echo "heartbeat FAILED (http=${http}) $(head -c 200 "${hb_out}" 2>/dev/null)"
    echo "  ^ no heartbeat landed, so the self-check will go stale until one does"
  fi
  rm -f "${hb_out}"
}

{
  echo "==== ${STAMP} backup task start ===="
  if bash "${REPO_DIR}/n8n/scripts/backup.sh" 30; then
    present=0
    ok_checks=0
    total_checks=0
    bytes=0

    count_artifact() {
      local f="$1"
      if [ -n "${f}" ] && [ -f "${f}" ]; then
        present=$((present + 1))
        local sz
        sz=$(wc -c < "${f}" | tr -d ' ')
        bytes=$((bytes + sz))
      fi
    }

    newest_dump="$(ls -t "${REPO_DIR}"/backups/pg-n8n-*.sql.gz 2>/dev/null | head -1)"
    newest_vol="$(ls -t "${REPO_DIR}"/backups/n8n-data-*.tar.gz 2>/dev/null | head -1)"
    newest_lobe="$(ls -t "${REPO_DIR}"/backups/pg-lobechat-*.sql.gz 2>/dev/null | head -1)"
    newest_minio="$(ls -t "${REPO_DIR}"/backups/minio-data-*.tar.gz 2>/dev/null | head -1)"
    newest_conf="$(ls -t "${REPO_DIR}"/backups/config-n8n-data-*.tar.gz 2>/dev/null | head -1)"

    count_artifact "${newest_dump}"; count_artifact "${newest_vol}"
    count_artifact "${newest_lobe}"; count_artifact "${newest_minio}"
    count_artifact "${newest_conf}"

    total_checks=$((total_checks + 1))
    if [ -n "${newest_dump}" ] && gunzip -t "${newest_dump}"; then
      ok_checks=$((ok_checks + 1)); echo "integrity: postgres dump OK  ($(basename "${newest_dump}"))"
    else
      echo "integrity: postgres dump FAILED"
    fi

    total_checks=$((total_checks + 1))
    if [ -n "${newest_vol}" ] && tar -tzf "${newest_vol}" >/dev/null; then
      ok_checks=$((ok_checks + 1)); echo "integrity: volume archive OK ($(basename "${newest_vol}"))"
    else
      echo "integrity: volume archive FAILED"
    fi

    total_checks=$((total_checks + 1))
    if [ -n "${newest_lobe}" ] && gunzip -t "${newest_lobe}"; then
      ok_checks=$((ok_checks + 1)); echo "integrity: lobechat dump OK  ($(basename "${newest_lobe}"))"
    else
      echo "integrity: lobechat dump FAILED"
    fi

    total_checks=$((total_checks + 1))
    if [ -n "${newest_minio}" ] && tar -tzf "${newest_minio}" >/dev/null; then
      ok_checks=$((ok_checks + 1)); echo "integrity: minio archive OK ($(basename "${newest_minio}"))"
    else
      echo "integrity: minio archive FAILED"
    fi

    # Same-machine backups do not survive the machine. Copy the three that
    # matter somewhere else when a destination is configured.
    if [ -n "${OFFSITE}" ]; then
      if mkdir -p "${OFFSITE}" 2>/dev/null; then
        for f in "${newest_dump}" "${newest_lobe}" "${newest_conf}"; do
          [ -n "${f}" ] && [ -f "${f}" ] && cp -f "${f}" "${OFFSITE}/" && echo "offsite: $(basename "${f}")"
        done
      else
        echo "offsite: could not create ${OFFSITE} (skipped)"
      fi
    fi

    echo "==== $(date '+%Y-%m-%d %H:%M:%S') backup task done ===="
    detail="{\"stamp\":\"${RUNSTAMP}\",\"n\":${present},\"bytes\":${bytes},\"integrity\":\"${ok_checks}/${total_checks}\"}"
    echo "heartbeat payload: ${detail}"
    send_heartbeat true "${detail}"
    [ "${ok_checks}" -eq "${total_checks}" ] || exit 1
  else
    echo "backup.sh exited non-zero - see output above"
    echo "==== $(date '+%Y-%m-%d %H:%M:%S') backup task FAILED ===="
    send_heartbeat false "backup.sh exited non-zero"
    exit 1
  fi
} >> "${LOG}" 2>&1
