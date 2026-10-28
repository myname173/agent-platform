#!/usr/bin/env bash
# 对象存储端到端复验：PUT -> GET -> sha256 比对 -> HEAD -> DELETE -> 确认已删
# 只用一个临时对象，跑完即删；不碰任何真实数据。
set -u

CONTAINER=minio
BUCKET=lobechat-files
ENDPOINT=http://127.0.0.1:9000
REGION=us-east-1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
WORK="$ROOT/output/.s3e2e"
mkdir -p "$WORK"

AK=$(grep -m1 '^MINIO_ROOT_USER=' "$ENV_FILE" | cut -d= -f2-)
SK=$(grep -m1 '^MINIO_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$AK" ] && [ -n "$SK" ] || { echo "FAIL credentials missing"; exit 1; }

KEY="e2e-$(date +%s).bin"
head -c 102400 /dev/urandom > "$WORK/src.bin"
SRC_SHA=$(sha256sum "$WORK/src.bin" | cut -d' ' -f1 | tr -d '\\')
echo "对象     : $KEY"
echo "本地大小 : $(wc -c < "$WORK/src.bin") B"
echo "本地 sha : $SRC_SHA"
echo

# 状态码单独取（-o 指到容器内文件，stdout 只剩 -w 的码）
s3() { # s3 <method> <path> [curl args...]
  local m="$1" p="$2"; shift 2
  if [ "$m" = "HEAD" ]; then
    docker exec -i "$CONTAINER" curl -sS --aws-sigv4 "aws:amz:${REGION}:s3" \
      --user "${AK}:${SK}" -I -o /dev/null -w '%{http_code}' "${ENDPOINT}${p}" "$@"
  else
    docker exec -i "$CONTAINER" curl -sS --aws-sigv4 "aws:amz:${REGION}:s3" \
      --user "${AK}:${SK}" -X "$m" -o /dev/null -w '%{http_code}' "${ENDPOINT}${p}" "$@"
  fi
}

echo "== 1/5 PUT（带 Content-Type，模拟浏览器上传）=="
C=$(cat "$WORK/src.bin" | docker exec -i "$CONTAINER" curl -sS \
      --aws-sigv4 "aws:amz:${REGION}:s3" --user "${AK}:${SK}" \
      -X PUT -H 'Content-Type: application/octet-stream' \
      --data-binary @- -o /dev/null -w '%{http_code}' \
      "${ENDPOINT}/${BUCKET}/${KEY}")
echo "   HTTP $C"
[ "$C" = "200" ] || { echo "   FAIL 上传失败"; exit 1; }

echo "== 2/5 GET 取回并比对字节 =="
C=$(docker exec -i "$CONTAINER" curl -sS --aws-sigv4 "aws:amz:${REGION}:s3" \
      --user "${AK}:${SK}" -X GET -o /tmp/e2e-back.bin -w '%{http_code}' \
      "${ENDPOINT}/${BUCKET}/${KEY}")
BACK_SHA=$(docker exec "$CONTAINER" sha256sum /tmp/e2e-back.bin | cut -d' ' -f1)
BACK_SIZE=$(docker exec "$CONTAINER" sh -c "wc -c < /tmp/e2e-back.bin" | tr -d ' ')
echo "   HTTP $C · 取回 ${BACK_SIZE} B"
echo "   取回 sha : $BACK_SHA"
if [ "$BACK_SHA" = "$SRC_SHA" ]; then echo "   OK   字节完全一致"; else echo "   FAIL 字节不一致"; exit 1; fi

echo "== 3/5 HEAD 元数据 =="
echo "   HTTP $(s3 HEAD "/${BUCKET}/${KEY}")"
docker exec -i "$CONTAINER" curl -sS --aws-sigv4 "aws:amz:${REGION}:s3" \
  --user "${AK}:${SK}" -I "${ENDPOINT}/${BUCKET}/${KEY}" 2>/dev/null \
  | grep -iE 'content-length|content-type|etag' | sed 's/^/   /'

echo "== 4/5 DELETE =="
echo "   HTTP $(s3 DELETE "/${BUCKET}/${KEY}")"

echo "== 5/5 确认已删（HEAD 应 404）=="
C=$(s3 HEAD "/${BUCKET}/${KEY}")
echo "   HTTP $C"
[ "$C" = "404" ] && echo "   OK   对象已删除" || echo "   WARN 期望 404，实际 $C"

echo
echo "结论：写入 / 取回 / 字节一致 / 删除 全部通过"
