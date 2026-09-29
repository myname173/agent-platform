#!/usr/bin/env bash
# Restore the agent-platform migration pack on a Linux/macOS host.
#
# Same order as restore.ps1 — the ordering is the whole point:
#   volumes land before n8n/minio start, SQL lands before n8n migrates.
#
#   ./restore.sh [target-dir] [lan-ip]
set -euo pipefail

PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_SRC="$PACK_ROOT/project"
DATA_SRC="$PACK_ROOT/data"
TARGET="${1:-$HOME/agent-platform}"
LAN_IP="${2:-}"

say() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
ok()  { printf '   \033[32mOK\033[0m   %s\n' "$1"; }
warn(){ printf '   \033[33mWARN\033[0m %s\n' "$1"; }
die() { printf '\n   \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

env_val() { # env_val <file> <name>
  [ -f "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -1 | tr -d '"'"'"' | tr -d "'"
}
compose() { docker compose "$@" 2>/dev/null || docker-compose "$@"; }

[ -d "$PROJECT_SRC" ] || die "missing $PROJECT_SRC"
[ -d "$DATA_SRC" ]    || die "missing $DATA_SRC"
command -v docker >/dev/null || die "docker not installed"

say "0/8  preflight"
compose version >/dev/null 2>&1 || die "docker compose not usable"
ok "docker + compose available"

if [ -z "$LAN_IP" ]; then
  LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')"
  [ -n "$LAN_IP" ] || LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$LAN_IP" ] || { LAN_IP="127.0.0.1"; warn "could not detect LAN IP, using 127.0.0.1"; }
fi
ok "LAN IP   $LAN_IP"

say "1/8  copy project -> $TARGET"
mkdir -p "$TARGET"
cp -a "$PROJECT_SRC"/. "$TARGET"/
ok "project copied"
ENV_FILE="$TARGET/.env"
[ -f "$ENV_FILE" ] || die ".env did not land in $TARGET"

say "2/8  point .env at this machine"
OLD_IP="$(env_val "$ENV_FILE" PLATFORM_LAN_IP)"
sed -i.bak "s/^PLATFORM_LAN_IP=.*/PLATFORM_LAN_IP=$LAN_IP/; s/^LAN_IP=.*/LAN_IP=$LAN_IP/" "$ENV_FILE"
if [ -n "$OLD_IP" ] && [ "$OLD_IP" != "$LAN_IP" ]; then
  sed -i.bak "s/$OLD_IP/$LAN_IP/g" "$ENV_FILE"
fi
rm -f "$ENV_FILE.bak"
ok "PLATFORM_LAN_IP / LAN_IP  ${OLD_IP:-<none>} -> $LAN_IP"
if [ -z "$(env_val "$ENV_FILE" N8N_ENCRYPTION_KEY)" ]; then
  warn "N8N_ENCRYPTION_KEY empty — restored credentials will NOT decrypt"
else
  ok "N8N_ENCRYPTION_KEY present"
fi
PG_USER="$(env_val "$ENV_FILE" POSTGRES_USER)"; PG_USER="${PG_USER:-n8n}"
PG_DB="$(env_val "$ENV_FILE" POSTGRES_DB)";     PG_DB="${PG_DB:-n8n}"

say "3/8  create external volume n8n_data"
docker volume inspect n8n_data >/dev/null 2>&1 && ok "already exists" \
  || { docker volume create n8n_data >/dev/null; ok "created"; }

say "4/8  start postgres and wait for healthy"
(cd "$TARGET" && compose up -d postgres)
for _ in $(seq 1 60); do
  st="$(docker inspect -f '{{.State.Health.Status}}' postgres 2>/dev/null || echo "")"
  [ "$st" = "healthy" ] && break
  sleep 3
done
[ "$(docker inspect -f '{{.State.Health.Status}}' postgres 2>/dev/null)" = "healthy" ] \
  || die "postgres never went healthy"
ok "postgres healthy"

# healthcheck is only pg_isready, which passes before paradedb's
# 10_bootstrap_paradedb.sh has finished. Loading a dump on top of a
# half-bootstrapped cluster kills the server mid-restore.
echo "   letting paradedb bootstrap finish ..."
sleep 30
[ "$(docker inspect -f '{{.State.Status}}' postgres 2>/dev/null)" = "running" ] \
  || die "postgres stopped during bootstrap - run: docker logs postgres"
ok "bootstrap settled (container still running)"

say "5/8  restore volume snapshots"
docker pull alpine >/dev/null 2>&1 || true
restore_volume() { # restore_volume <volume> <glob>
  local vol="$1" glob="$2" f
  f="$(ls -1 "$DATA_SRC"/$glob 2>/dev/null | tail -1)"
  [ -n "$f" ] || { warn "no archive for $vol"; return 0; }
  docker volume create "$vol" >/dev/null
  docker run --rm -v "$vol:/vol" -v "$DATA_SRC:/src:ro" alpine \
    sh -c "tar xzf /src/$(basename "$f") -C /vol" || die "restore $vol failed"
  ok "$vol <- $(basename "$f")"
}
restore_volume n8n_data   'n8n-data-*.tar.gz'
restore_volume minio_data 'minio-data-*.tar.gz'

say "6/8  load SQL dumps"
# TEMPLATE template0 matters: paradedb's bootstrap injects a `paradedb` schema
# into template1, so a default CREATE DATABASE inherits it and the dump's own
# CREATE SCHEMA paradedb aborts with "already exists". template0 is pristine.
docker exec postgres psql -U "$PG_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='lobechat'" | grep -q 1 \
  && ok "database lobechat present" \
  || { docker exec postgres psql -U "$PG_USER" -d postgres -c "CREATE DATABASE lobechat TEMPLATE template0" \
       && ok "created database lobechat (TEMPLATE template0)"; }
load_db() { # load_db <db> <glob>
  local db="$1" glob="$2" f
  f="$(ls -1 "$DATA_SRC"/$glob 2>/dev/null | tail -1)"
  [ -n "$f" ] || { warn "no dump for $db"; return 0; }
  echo "   loading $(basename "$f") -> $db  (slow)"
  gunzip -c "$f" | docker exec -i postgres psql -U "$PG_USER" -d "$db" -v ON_ERROR_STOP=1 -q \
    || die "failed to load $(basename "$f")"
  ok "$db <- $(basename "$f")"
}
load_db "$PG_DB"  'pg-n8n-*.sql.gz'
load_db lobechat  'pg-lobechat-*.sql.gz'

say "7/8  build and start the whole stack"
(cd "$TARGET" && compose up -d --build)
ok "stack up"

say "8/8  done"
cat <<EOF
    Next:
      1. watch:   cd $TARGET && docker compose ps
      2. accept:  $TARGET/migration/verify.sh
      3. URLs:    http://$LAN_IP:3000  http://$LAN_IP:3210  http://$LAN_IP:5678
                  https://$LAN_IP:8443 .. 8446
EOF
