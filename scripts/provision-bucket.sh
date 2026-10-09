#!/usr/bin/env bash
# Provision the LobeHub object-storage bucket: create it if missing, and give it
# the CORS policy a BROWSER upload needs. Idempotent — safe to run on every
# deploy, and safe to run on a bucket that is already serving traffic.
#
# ---------------------------------------------------------------------------
# Why this script exists
# ---------------------------------------------------------------------------
# 1. LobeHub never creates the bucket itself. There is no CreateBucket call
#    anywhere in its server bundle, so a fresh install has no bucket at all and
#    every upload fails. The bucket is an out-of-band prerequisite.
#
# 2. A bucket WITHOUT a CORS policy answers the browser preflight with a bare
#    "200 OK" and *no* Access-Control-* headers. Chrome then refuses to send the
#    actual cross-origin PUT. The app sees a failed upload, calls
#    upload.abortS3Upload, and the row is left at status=released while nothing
#    lands in `files` or in the bucket. This is the single most confusing
#    failure in the whole file-upload path, because the storage layer itself
#    looks perfectly healthy from curl (curl has no CORS concept).
#
# 3. `mc` is NOT present in the rustfs/rustfs image, so the long-standing README
#    line `docker exec minio mc mb local/lobechat-files` cannot work on the
#    current stack. This script drives the S3 API through the `curl` that IS in
#    the image, which also means it needs nothing installed on the host beyond
#    docker itself.
#
# The CORS origins are DERIVED from .env (PLATFORM_LAN_IP / LOBECHAT_PORT)
# rather than hard-coded, so a LAN IP change does not silently leave a stale
# origin behind — that was a real defect in the hand-written policy.
#
# Usage:
#   bash scripts/provision-bucket.sh
#   bash scripts/provision-bucket.sh --bucket other-bucket
#   bash scripts/provision-bucket.sh --endpoint http://127.0.0.1:9000
#   bash scripts/provision-bucket.sh --check      # verify only, change nothing
#
# Exit codes: 0 = bucket + CORS verified, 1 = something failed.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
CONTAINER="minio"
REGION="us-east-1"
CHECK_ONLY=0

say()  { printf '\n\033[36m== %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '   \033[33mWARN\033[0m %s\n' "$1"; }
die()  { printf '\n   \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

# --- .env reader ------------------------------------------------------------
# Same stripping rule as migration/restore.sh: remove both quote styles. Do not
# "simplify" this to `tr -d "\"'"` — that leaves a dangling quote and bash then
# swallows the rest of the file.
env_val() { # env_val <name> [default]
  [ -f "$ENV_FILE" ] || { printf '%s' "${2:-}"; return 0; }
  local v
  v="$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -1 | tr -d "\"'")"
  printf '%s' "${v:-${2:-}}"
}

BUCKET="$(env_val S3_BUCKET lobechat-files)"
ENDPOINT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bucket)   BUCKET="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --check)    CHECK_ONLY=1; shift ;;
    -h|--help)  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "unknown argument: $1" ;;
  esac
done

AK="$(env_val MINIO_ROOT_USER)"
SK="$(env_val MINIO_ROOT_PASSWORD)"
LAN_IP="$(env_val PLATFORM_LAN_IP 127.0.0.1)"
LOBECHAT_PORT="$(env_val LOBECHAT_PORT 3210)"

# Inside the container the API is always on its own :9000 — no host port, no LAN
# IP. That is deliberate: provisioning then cannot break when the LAN IP drifts.
[ -n "$ENDPOINT" ] || ENDPOINT="http://127.0.0.1:9000"

[ -n "$AK" ] || die "MINIO_ROOT_USER missing from $ENV_FILE"
[ -n "$SK" ] || die "MINIO_ROOT_PASSWORD missing from $ENV_FILE"
docker inspect "$CONTAINER" >/dev/null 2>&1 \
  || die "container '$CONTAINER' not found — start the stack first (docker compose up -d)"

# --- S3 request helper ------------------------------------------------------
# curl 8.x in the rustfs image supports --aws-sigv4, so we get correct SigV4
# signing without boto3/mc/aws-cli. `-sS` keeps errors visible; the caller reads
# the HTTP status from -w.
s3() { # s3 <method> <path-with-leading-slash> [curl extra args...]
  local method="$1" path="$2"; shift 2
  # Use -I for HEAD: `curl -X HEAD` is documented to hang, because curl keeps
  # waiting for a response body that a HEAD reply will never contain.
  if [ "$method" = "HEAD" ]; then
    docker exec -i "$CONTAINER" curl -sS \
      --aws-sigv4 "aws:amz:${REGION}:s3" \
      --user "${AK}:${SK}" \
      -I -o /dev/stdout -w '\n%{http_code}' \
      "${ENDPOINT}${path}" "$@"
  else
    docker exec -i "$CONTAINER" curl -sS \
      --aws-sigv4 "aws:amz:${REGION}:s3" \
      --user "${AK}:${SK}" \
      -X "$method" \
      -o /dev/stdout -w '\n%{http_code}' \
      "${ENDPOINT}${path}" "$@"
  fi
}

split_status() { # stdin: body + "\n<status>"  -> sets BODY / STATUS
  local raw="$1"
  STATUS="${raw##*$'\n'}"
  BODY="${raw%$'\n'*}"
}

say "0/4  config"
ok "bucket      $BUCKET"
ok "endpoint    $ENDPOINT  (container '$CONTAINER', internal :9000)"
ok "cors origins from .env:  localhost:$LOBECHAT_PORT / 127.0.0.1:$LOBECHAT_PORT / $LAN_IP:$LOBECHAT_PORT"
[ "$CHECK_ONLY" = "1" ] && warn "--check: nothing will be written"

# --- 1. bucket --------------------------------------------------------------
say "1/4  bucket exists?"
BUCKET_MISSING=0
split_status "$(s3 HEAD "/${BUCKET}" || true)"
if [ "$STATUS" = "200" ]; then
  ok "already present (HEAD 200)"
elif [ "$CHECK_ONLY" = "1" ]; then
  warn "missing (HEAD $STATUS) — re-run without --check to create it"
  BUCKET_MISSING=1
else
  split_status "$(s3 PUT "/${BUCKET}" || true)"
  case "$STATUS" in
    200|409) ok "created (PUT $STATUS)" ;;
    *)       die "could not create bucket — PUT returned $STATUS: $BODY" ;;
  esac
fi

if [ "$BUCKET_MISSING" = "1" ]; then
  say "stopped"
  warn "nothing to read back — the bucket does not exist yet.
        Run without --check to create it and install the CORS policy."
  exit 1
fi

# --- 2. CORS policy ---------------------------------------------------------
CORS_XML="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<CORSConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">
  <CORSRule>
    <AllowedOrigin>http://localhost:${LOBECHAT_PORT}</AllowedOrigin>
    <AllowedOrigin>http://127.0.0.1:${LOBECHAT_PORT}</AllowedOrigin>
    <AllowedOrigin>http://${LAN_IP}:${LOBECHAT_PORT}</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-amz-request-id</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>"

if [ "$CHECK_ONLY" = "0" ]; then
  say "2/4  write CORS policy"
  split_status "$(printf '%s' "$CORS_XML" | s3 PUT "/${BUCKET}?cors" \
      -H 'Content-Type: application/xml' --data-binary @- || true)"
  case "$STATUS" in
    200|204) ok "PutBucketCors accepted (HTTP $STATUS)" ;;
    *)       die "PutBucketCors returned $STATUS: $BODY" ;;
  esac
else
  say "2/4  write CORS policy (skipped, --check)"
fi

# --- 3. read it back --------------------------------------------------------
say "3/4  read the policy back"
split_status "$(s3 GET "/${BUCKET}?cors" || true)"
[ "$STATUS" = "200" ] || die "GetBucketCors returned $STATUS — the policy did not stick: $BODY"
for o in "http://localhost:${LOBECHAT_PORT}" "http://127.0.0.1:${LOBECHAT_PORT}" "http://${LAN_IP}:${LOBECHAT_PORT}"; do
  case "$BODY" in
    *"$o"*) ok "origin present: $o" ;;
    *)      die "origin MISSING from the stored policy: $o" ;;
  esac
done

# --- 4. replay the browser preflight ---------------------------------------
# This is the check that actually matters. A bucket can answer OPTIONS with 200
# and still be useless to the browser if no Access-Control-* header comes back.
say "4/4  replay the browser preflight (this is the real test)"
PREFLIGHT="$(docker exec -i "$CONTAINER" curl -sS -D - -o /dev/null \
  -X OPTIONS "${ENDPOINT}/${BUCKET}/.provision-probe" \
  -H "Origin: http://127.0.0.1:${LOBECHAT_PORT}" \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-length' || true)"
printf '%s\n' "$PREFLIGHT" | grep -i '^HTTP/' | sed 's/^/   /' || true
if printf '%s' "$PREFLIGHT" | grep -qi '^access-control-allow-origin'; then
  printf '%s\n' "$PREFLIGHT" | grep -i '^access-control' | sed 's/^/   /'
  ok "preflight carries Access-Control-* — the browser will send the PUT"
else
  printf '%s\n' "$PREFLIGHT" | sed 's/^/   /'
  die "preflight returned no Access-Control-Allow-Origin — the browser PUT will be blocked.
        This is exactly the failure this script exists to prevent."
fi

say "done"
ok "bucket '$BUCKET' provisioned and verified"
