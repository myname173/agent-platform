#!/usr/bin/env bash
# Check that THIS machine can actually run the stack, before anything is copied
# or started. Run it right after unpacking the migration pack.
#
#   ./preflight.sh                 # report only
#   ./preflight.sh --fix-ports     # rewrite .env to move off busy ports
#
# It answers what otherwise only surfaces 20 minutes into a failed restore:
#   - is the Docker daemon reachable, and is `docker compose` v2 available?
#   - is there enough disk / RAM?
#   - are the host ports free?  (a port held by our own containers on a re-run
#     is NOT a conflict and is never remapped)
#   - is a system proxy set, and does it bypass localhost?
#   - is a TUN-mode proxy active? If so it must be up BEFORE docker starts,
#     otherwise containers cache pre-TUN DNS and SearXNG/Telegram go dead.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PROJECT_DIR="$ROOT"
[ -d "$ROOT/project" ] && PROJECT_DIR="$ROOT/project"
ENV_FILE="$PROJECT_DIR/.env"
FIX_PORTS=0
[ "${1:-}" = "--fix-ports" ] && FIX_PORTS=1

PASS=0; WARN=0; FAIL=0
ok()   { printf '   OK    %s\n' "$1"; PASS=$((PASS+1)); }
warn() { printf '   WARN  %s\n' "$1"; WARN=$((WARN+1)); }
bad()  { printf '   FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n--- %s\n' "$1"; }

envval() {  # envval <name> <default>
    local v=""
    if [ -f "$ENV_FILE" ]; then
        v="$(grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'\r')"
    fi
    printf '%s' "${v:-$2}"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── docker ──────────────────────────────────────────────────────────────────
head_ "docker"
if ! have docker; then
    bad "docker not on PATH — install Docker Engine / Docker Desktop first"
else
    if docker info >/dev/null 2>&1; then
        ok "docker daemon reachable"
        v="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
        [ -n "$v" ] && ok "server version $v"
    else
        bad "docker is installed but the daemon is not running — start it and re-run"
    fi
    if docker compose version >/dev/null 2>&1; then
        ok "docker compose available ($(docker compose version 2>/dev/null | head -1))"
    else
        bad "docker compose v2 not available"
    fi
fi

# ── resources ───────────────────────────────────────────────────────────────
head_ "resources"
if have free; then
    RAM=$(free -g 2>/dev/null | awk '/^Mem:/{print $2}')
    if [ -n "$RAM" ] && [ "$RAM" -ge 8 ]; then ok "RAM ${RAM} GB"
    elif [ -n "$RAM" ]; then warn "RAM only ${RAM} GB — 10 containers plus a Next.js build wants 8 GB or more"
    fi
fi
if [ -d "$PROJECT_DIR" ]; then
    FREE=$(df -BG "$PROJECT_DIR" 2>/dev/null | awk 'NR==2{gsub(/G/,"");print $4}')
    if [ -n "$FREE" ]; then
        if   [ "$FREE" -ge 15 ]; then ok "disk free ${FREE} GB"
        elif [ "$FREE" -ge 6 ];  then warn "disk only ${FREE} GB free — dumps + volumes + build want ~6 GB minimum"
        else                          bad  "disk only ${FREE} GB free — not enough"
        fi
    fi
fi

# ── ports ───────────────────────────────────────────────────────────────────
head_ "host ports"

# Is our own stack already up? Then its ports are ours, not conflicts.
OURS="postgres n8n platform-console lobechat minio searxng n8n-sandbox stream-bridge platform-backup caddy"
STACK_RUNNING=0
if have docker && docker info >/dev/null 2>&1; then
    for n in $OURS; do
        if [ "$(docker inspect -f '{{.State.Status}}' "$n" 2>/dev/null)" = "running" ]; then
            STACK_RUNNING=1; break
        fi
    done
fi
[ "$STACK_RUNNING" = 1 ] && echo "   (the stack is already running — its own ports are not treated as conflicts)"

port_free() {
    [ "$STACK_RUNNING" = 1 ] && return 0
    local p="$1" holder
    if have ss; then
        holder="$(ss -ltnH "sport = :$p" 2>/dev/null | head -1)"
    elif have lsof; then
        holder="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1)"
    else
        holder="$(netstat -ltn 2>/dev/null | grep -E "[:.]$p[[:space:]]" | head -1)"
    fi
    [ -z "$holder" ]
}

find_free() {
    local p=$1 i=0
    while [ $i -lt 200 ]; do
        if port_free "$p" && [ "$p" -lt 60000 ]; then echo "$p"; return 0; fi
        p=$((p+1)); i=$((i+1))
    done
    echo 0
}

# key:default:description
PORT_SPEC="
CONSOLE_PORT:3000:Kiranism console
LOBECHAT_PORT:3210:LobeHub chat
N8N_PORT:5678:n8n
SEARXNG_PORT:8080:SearXNG
MINIO_API_PORT:9000:MinIO S3 API
MINIO_CONSOLE_PORT:9001:MinIO console
STREAM_BRIDGE_PORT:3211:stream-bridge (127.0.0.1 only)
CADDY_PORT_CONSOLE:8443:HTTPS console
CADDY_PORT_LOBEHUB:8444:HTTPS LobeHub
CADDY_PORT_N8N:8445:HTTPS n8n
CADDY_PORT_MINIO:8446:HTTPS MinIO
"

BUSY_KEYS=""; BUSY_FROM=""; BUSY_TO=""
for spec in $PORT_SPEC; do
    key="$(echo "$spec" | cut -d: -f1)"
    def="$(echo "$spec" | cut -d: -f2)"
    desc="$(echo "$spec" | cut -d: -f3-)"
    want="$(envval "$key" "$def")"
    if port_free "$want"; then
        printf '   OK    %-28s %s\n' "$desc" "$want"
    else
        alt="$(find_free $((want+1)))"
        if [ "$alt" != "0" ]; then
            printf '   WARN  %-28s %s BUSY -> would move to %s\n' "$desc" "$want" "$alt"
            BUSY_KEYS="$BUSY_KEYS $key"; BUSY_FROM="$BUSY_FROM $want"; BUSY_TO="$BUSY_TO $alt"
        else
            printf '   FAIL  %-28s %s BUSY and no free port found\n' "$desc" "$want"
        fi
    fi
done

if [ -n "$BUSY_KEYS" ]; then
    if [ "$FIX_PORTS" = 1 ] && [ -f "$ENV_FILE" ]; then
        echo ""
        head_ "rewriting .env to avoid port conflicts"
        set -- $BUSY_KEYS; keys="$@"
        set -- $BUSY_FROM; froms="$@"
        set -- $BUSY_TO;   tos="$@"
        i=1
        for k in $keys; do
            newv="$(echo "$tos" | cut -d' ' -f$i)"
            oldv="$(echo "$froms" | cut -d' ' -f$i)"
            if grep -q "^$k=" "$ENV_FILE"; then
                sed -i.bak "s|^$k=.*|$k=$newv|" "$ENV_FILE"
            else
                printf '\n%s=%s\n' "$k" "$newv" >> "$ENV_FILE"
            fi
            ok "$k  $oldv -> $newv"
            i=$((i+1))
        done
        rm -f "$ENV_FILE.bak"
        echo "   .env updated — the stack will come up on the ports listed above"
    else
        echo "   re-run with --fix-ports to move these automatically"
    fi
fi

# ── system proxy ────────────────────────────────────────────────────────────
head_ "system proxy"
PROXY_ENV="${http_proxy:-${HTTP_PROXY:-}}"
if [ -z "$PROXY_ENV" ]; then
    ok "no http_proxy in the environment — nothing to bypass"
else
    ok "http_proxy=$PROXY_ENV"
    BYPASS="${no_proxy:-${NO_PROXY:-}}"
    if echo "$BYPASS" | grep -qE "localhost|127\.0\.0\.1"; then
        ok "no_proxy covers localhost"
    else
        warn "no_proxy does NOT contain localhost — local probes (and the browser) will be sent through $PROXY_ENV. Add localhost,127.0.0.1 to no_proxy."
    fi
fi

# ── TUN / transparent proxy ─────────────────────────────────────────────────
head_ "outbound path (affects SearXNG and Telegram)"
TUN=0
if have getent; then
    IPS="$(getent hosts api.telegram.org 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
elif have dig; then
    IPS="$(dig +short api.telegram.org 2>/dev/null | tr '\n' ' ')"
else
    IPS=""
fi
if [ -n "$IPS" ]; then
    if echo "$IPS" | grep -qE "198\.18\."; then
        TUN=1
        ok "TUN-mode proxy is ACTIVE (api.telegram.org -> Fake-IP $IPS)"
        echo "         -> SearXNG and Telegram egress go through it. KEEP TUN ON."
        echo "         -> Start the proxy BEFORE docker, else containers cache pre-TUN DNS."
    else
        ok "no Fake-IP — direct DNS ($IPS)"
        echo "         -> If SearXNG/Telegram later fail, this machine has no working"
        echo "            outbound path for them; a TUN/transparent proxy is what supplies it."
    fi
else
    warn "could not resolve api.telegram.org — outbound DNS may be blocked"
fi

if [ -n "$PROXY_ENV" ] && [ "$TUN" = 0 ]; then
    echo "         -> http_proxy is set but TUN is not detected: only apps that read"
    echo "            the proxy get out. Containers will NOT. Expect SearXNG to"
    echo "            return 0 results; turn on TUN mode."
    WARN=$((WARN+1))
fi

printf '\n'
if [ "$FAIL" = 0 ] && [ "$WARN" = 0 ]; then
    printf 'PREFLIGHT CLEAN — %s checks ok, nothing blocking.\n\n' "$PASS"
else
    printf 'PREFLIGHT: %s ok, %s warning(s), %s blocking.\n\n' "$PASS" "$WARN" "$FAIL"
fi
[ "$FAIL" = 0 ] || exit 1
exit 0
