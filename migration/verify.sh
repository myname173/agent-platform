#!/usr/bin/env bash
# Acceptance check for a restored agent-platform (Linux/macOS).
# Compares the live stack against SOURCE.json from the pack.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="$SCRIPT_DIR/SOURCE.json"
[ -f "$SOURCE" ] || { echo "SOURCE.json missing"; exit 1; }

pass=0; fail=0
check() { # check <name> <ok:0|1> <detail>
  if [ "$2" = "1" ]; then printf '   \033[32mPASS\033[0m  %-34s %s\n' "$1" "$3"; pass=$((pass+1))
  else                    printf '   \033[31mFAIL\033[0m  %-34s %s\n' "$1" "$3"; fail=$((fail+1)); fi
}
jget() { python3 -c "import json,sys;d=json.load(open('$SOURCE'));print($1)" 2>/dev/null \
         || sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\?\([^\",}]*\)\"\?.*/\1/p" "$SOURCE" | head -1; }

env_val() { sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -1 | tr -d '"'"'"' | tr -d "'"; }
ENV_FILE="$PROJECT_DIR/.env"
PG_USER="$(env_val "$ENV_FILE" POSTGRES_USER)"; PG_USER="${PG_USER:-n8n}"
PG_DB="$(env_val "$ENV_FILE" POSTGRES_DB)";     PG_DB="${PG_DB:-n8n}"
N8N_KEY="$(env_val "$ENV_FILE" N8N_API_KEY)"
LAN_IP="$(env_val "$ENV_FILE" PLATFORM_LAN_IP)"

echo; echo "=== containers ==="
for s in postgres n8n platform-console lobechat minio searxng n8n-sandbox stream-bridge platform-backup caddy; do
  st="$(docker inspect -f '{{.State.Status}}' "$s" 2>/dev/null || echo absent)"
  case "$st" in running) check "container $s" 1 "$st";; *) check "container $s" 0 "$st";; esac
done

echo; echo "=== environment ==="
KEY="$(env_val "$ENV_FILE" N8N_ENCRYPTION_KEY)"
SRC_KEY="$(jget "d['n8n_encryption_key']")"
[ "$KEY" = "$SRC_KEY" ] && check "N8N_ENCRYPTION_KEY matches source" 1 identical \
                        || check "N8N_ENCRYPTION_KEY matches source" 0 "DIFFERENT - credentials will not decrypt"
[ -n "$LAN_IP" ] && [ "$LAN_IP" != "127.0.0.1" ] && check "PLATFORM_LAN_IP set" 1 "$LAN_IP" \
                                                  || check "PLATFORM_LAN_IP set" 0 "${LAN_IP:-empty}"

psql1() { docker exec postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>/dev/null | tr -d ' '; }
echo; echo "=== postgres ==="
WF="$(psql1 'select count(*) from workflow_entity')";  WANT="$(jget "d['counts']['workflows']")"
[ "$WF" = "$WANT" ] && check "workflows = $WANT" 1 "got $WF" || check "workflows = $WANT" 0 "got $WF"
EX="$(psql1 'select count(*) from execution_entity')"; WANT="$(jget "d['counts']['executions']')"
[ "${EX:-0}" -ge "${WANT:-0}" ] && check "executions >= $WANT" 1 "got $EX" || check "executions >= $WANT" 0 "got $EX"
CR="$(psql1 'select count(*) from credentials_entity')"; WANT="$(jget "d['counts']['credentials']")"
[ "$CR" = "$WANT" ] && check "credentials = $WANT" 1 "got $CR" || check "credentials = $WANT" 0 "got $CR"

echo; echo "=== business data tables ==="
while IFS='|' read -r name cnt; do
  [ -z "$name" ] && continue
  want="$(jget "d['data_tables'].get('$name', -1)")"
  [ -z "$want" ] && want=-1
  [ "${cnt:-0}" -ge "${want:-0}" ] && check "table $name >= $want" 1 "got $cnt" \
                                  || check "table $name >= $want" 0 "got $cnt"
done < <(docker exec postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "select d.name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', 'data_table_user_' || d.id), false, true, '')))[1]::text::bigint from data_table d order by d.name" 2>/dev/null)

echo; echo "=== HTTP endpoints ==="
# --noproxy '*': an inherited http_proxy would send localhost probes off-box.
# n8n 2.x also 404s a request with no Accept header, so send one explicitly.
httpcode() { curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -H 'Accept: */*' \
             --max-time 15 "$1" 2>/dev/null || echo 0; }
for pair in "console:3000|http://localhost:3000/" "lobechat:3210|http://localhost:3210/" \
            "n8n:5678|http://localhost:5678/signin" "minio:9001|http://localhost:9001/" \
            "searxng:8080|http://localhost:8080/"; do
  n="${pair%%|*}"; u="${pair##*|}"; c="$(httpcode "$u")"
  [ "$c" = "200" ] || [ "$c" = "307" ] || [ "$c" = "302" ] && check "$n" 1 "HTTP $c" || check "$n" 0 "HTTP $c"
done

echo; echo "=== n8n API ==="
if [ -n "$N8N_KEY" ]; then
  n="$(curl -s -H "X-N8N-API-KEY: $N8N_KEY" --max-time 20 'http://localhost:5678/api/v1/workflows?limit=250' \
      | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null || echo 0)"
  WANT="$(jget "d['counts']['workflows']")"
  [ "$n" = "$WANT" ] && check "n8n API workflows = $WANT" 1 "got $n" || check "n8n API workflows = $WANT" 0 "got $n"
fi

echo
[ "$fail" -eq 0 ] && echo "ALL $pass CHECKS PASSED" || echo "$pass passed, $fail FAILED"
echo
[ "$fail" -eq 0 ] || exit 1
