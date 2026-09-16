#!/usr/bin/env bash
# =============================================================================
# n8n data volume backup / restore for agent-platform
#
# Usage:
#   bash n8n/scripts/backup.sh                  # backup, keep last 14
#   bash n8n/scripts/backup.sh 30               # backup, keep last 30
#   bash n8n/scripts/backup.sh restore <archive> # restore a backup (destructive)
#
# What is backed up:
#   - the whole n8n_data volume (n8n config files; SQLite legacy since the
#     Postgres migration — kept as a rollback artifact)
#   - a Postgres logical dump (pg_dump) — the live n8n datastore
#   - docker-compose.yml and .env (so a restore is self-contained)
#
# Notes:
#   - Backup runs while n8n is up (hot copy of SQLite incl. wal/shm).
#     For a guaranteed-consistent snapshot, stop n8n first:
#       docker compose stop n8n && bash n8n/scripts/backup.sh && docker compose start n8n
#   - Archives contain credentials and chat history. Keep them private.
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${REPO_DIR}/backups"
VOLUME="n8n_data"
KEEP_DAYS="${1:-14}"

# Postgres is the n8n primary datastore since 2026-09-14; pull creds from .env
if [ -f "${REPO_DIR}/.env" ]; then
  set -a; . "${REPO_DIR}/.env"; set +a
fi
PG_CONTAINER="${PG_CONTAINER:-postgres}"
PG_USER="${POSTGRES_USER:-n8n}"
PG_DB="${POSTGRES_DB:-n8n}"

mkdir -p "$BACKUP_DIR"

case "${1:-}" in
  restore)
    ARCHIVE="${2:?usage: backup.sh restore <archive>}"
    if [ ! -f "$ARCHIVE" ]; then
      echo "archive not found: $ARCHIVE" >&2; exit 1
    fi
    ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd -W 2>/dev/null || pwd)/$(basename "$ARCHIVE")"
    echo "!! Restoring will OVERWRITE the $VOLUME volume with $ARCHIVE"
    echo "!! The current n8n container will be stopped. Type 'yes' to continue:"
    read -r ANSWER
    [ "$ANSWER" = "yes" ] || { echo "aborted"; exit 1; }
    cd "$REPO_DIR"
    docker compose stop n8n
    docker run --rm -v "$VOLUME":/data -v "$ARCHIVE":/backup/archive.tar.gz alpine \
      sh -c "rm -rf /data/* && tar xzf /backup/archive.tar.gz -C /data --no-same-owner && echo restored"
    docker compose start n8n
    echo "restore done. n8n restarting..."
    ;;

  *)
    if [ "${1:-}" = "restore" ]; then exit 1; fi
    KEEP_DAYS="${1:-14}"
    STAMP="$(date +%Y%m%d-%H%M%S)"
    NAME="n8n-data-${STAMP}.tar.gz"
    TARGET="${BACKUP_DIR}/${NAME}"
    echo "backing up volume '$VOLUME' -> $TARGET"
    # pwd -W yields a docker-compatible windows path under git-bash
    BACKUP_DIR_WIN="$(cd "$BACKUP_DIR" && pwd -W 2>/dev/null || echo "$BACKUP_DIR")"
    REPO_DIR_WIN="$(pwd -W 2>/dev/null || echo "$REPO_DIR")"
    docker run --rm \
      -v "$VOLUME":/data:ro \
      -v "$BACKUP_DIR_WIN":/backup \
      alpine sh -c "tar czf /backup/${NAME} -C /data . && echo volume archived"
    # compose + .env are appended into a nested archive for self-contained restores
    if [ -f "$REPO_DIR/.env" ]; then
      docker run --rm \
        -v "$BACKUP_DIR_WIN":/backup \
        -v "$REPO_DIR_WIN":/repo:ro \
        alpine sh -c "tar czf /backup/config-${NAME} -C /repo docker-compose.yml .env"
      echo "config bundle: $BACKUP_DIR/config-${NAME}"
    fi
    # MinIO data volume (LobeHub file/image objects)
    MINIONAME="minio-data-${STAMP}.tar.gz"
    if docker volume inspect minio_data >/dev/null 2>&1; then
      docker run --rm \
        -v minio_data:/data:ro \
        -v "$BACKUP_DIR_WIN":/backup \
        alpine sh -c "tar czf /backup/${MINIONAME} -C /data . && echo minio archived"
      echo "minio volume: ${BACKUP_DIR}/${MINIONAME} ($(du -h "${BACKUP_DIR}/${MINIONAME}" | cut -f1))"
    else
      echo "WARNING: volume minio_data not found — skipped MinIO backup" >&2
    fi
    # Postgres logical dump (n8n primary datastore)
    if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
      PGNAME="pg-n8n-${STAMP}.sql.gz"
      docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" | gzip > "${BACKUP_DIR}/${PGNAME}"
      echo "postgres dump: ${BACKUP_DIR}/${PGNAME} ($(du -h "${BACKUP_DIR}/${PGNAME}" | cut -f1))"
      LOBENAME="pg-lobechat-${STAMP}.sql.gz"
      if docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d lobechat -c "SELECT 1" >/dev/null 2>&1; then
        docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d lobechat | gzip > "${BACKUP_DIR}/${LOBENAME}"
        echo "postgres dump (lobechat): ${BACKUP_DIR}/${LOBENAME} ($(du -h "${BACKUP_DIR}/${LOBENAME}" | cut -f1))"
      else
        echo "WARNING: database lobechat not reachable — skipped lobechat dump" >&2
      fi
    else
      echo "WARNING: ${PG_CONTAINER} not running — skipped the Postgres dump" >&2
    fi
    SIZE=$(du -h "$TARGET" | cut -f1)
    echo "backup complete: $TARGET ($SIZE)"
    # prune old archives
    PRUNED=$(find "$BACKUP_DIR" \( -name 'n8n-data-*.tar.gz*' -o -name 'pg-n8n-*.sql.gz' -o -name 'pg-lobechat-*.sql.gz' -o -name 'minio-data-*.tar.gz' -o -name 'config-n8n-data-*.tar.gz' \) -mtime "+${KEEP_DAYS}" -print -delete || true)
    if [ -n "$PRUNED" ]; then
      echo "pruned archives older than ${KEEP_DAYS} days:"
      echo "$PRUNED"
    fi
    ;;
esac
