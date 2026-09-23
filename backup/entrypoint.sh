#!/usr/bin/env bash
# Runs a backup as soon as the container starts (so opening Docker is enough to
# get one), then every BACKUP_INTERVAL_HOURS while the stack stays up.
set -uo pipefail

INTERVAL_H="${BACKUP_INTERVAL_HOURS:-6}"
echo "[entrypoint] in-stack backup up; interval=${INTERVAL_H}h"

while :; do
  /usr/local/bin/backup.sh
  sleep $(( INTERVAL_H * 3600 ))
done
