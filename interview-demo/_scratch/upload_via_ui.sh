#!/bin/bash
# Real-UI product upload: mint a session cookie, drive the composer's
# 「添加文件、技能和更多上下文」→ 附件 → 上传文件或图片 path, upload, screenshot.
#
# Usage:  bash upload_via_ui.sh [file-to-upload] [screenshot-path]
#
# NOTE: LobeHub dedupes uploads by content hash. Re-uploading a file whose hash
# it already knows does NOT create a new `files` row or a new bucket object —
# the composer just re-attaches the existing record. To exercise the write path
# you must upload content it has not seen before.
#
# The a11y snapshot renders as:  menuitem "附件" [expanded=false, ref=e78]
# so any ref-extraction regex MUST allow attributes between '[' and 'ref='.
# Previous attempt required '[ref=' immediately after the label and matched nothing.
set -u
cd /c/Users/13682/Desktop/agent-platform-main || exit 1
export NO_PROXY='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
PY="C:/Users/13682/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe"
DEXEC="bash interview-demo/_scratch/dexec.sh"
OUT="C:/Users/13682/Desktop/agent-platform-main/interview-demo/实机截图"
DOC="${1:-C:/Users/13682/Desktop/agent-platform-main/interview-demo/测试素材/Airbnb-JavaScript-代码规范.md}"
SHOT="${2:-60_upload_product.png}"
SNAP=/tmp/snap_a.txt

refof() {  # $1 = label substring, $2 = snapshot file
  grep -oE "(button|menuitem|option) \"[^\"]*$1[^\"]*\" \[[^]]*ref=e[0-9]+\]" "$2" \
    | head -1 | sed 's/.*ref=//; s/\]//'
}

TOK=$($DEXEC postgres psql -U n8n -d lobechat -t -A \
      -c "select token from auth_sessions order by expires_at desc limit 1;" | tr -d '\r\n')
SECRET=$($DEXEC lobechat printenv AUTH_SECRET | tr -d '\r\n')
SIG=$(TOK_ENV="$TOK" SEC_ENV="$SECRET" $PY -c "
import hmac,hashlib,base64,os
print(base64.b64encode(hmac.new(os.environ['SEC_ENV'].encode(),
      os.environ['TOK_ENV'].encode(),hashlib.sha256).digest()).decode())")

agent-browser open "http://127.0.0.1:3210/" >/dev/null 2>&1
sleep 3
agent-browser cookies set "better-auth.session_token" "$TOK.$SIG" --url "http://127.0.0.1:3210/" >/dev/null 2>&1
agent-browser open "http://127.0.0.1:3210/" >/dev/null 2>&1
sleep 15

echo "=== 1. open attach menu ==="
agent-browser snapshot > "$SNAP" 2>/dev/null
AREF=$(refof "添加文件" "$SNAP")
echo "attach ref: ${AREF:-NONE}"
if [ -z "$AREF" ]; then agent-browser close >/dev/null 2>&1; exit 1; fi
agent-browser click "@$AREF" >/dev/null 2>&1
sleep 3

echo
echo "=== 2. find 附件 submenu ref ==="
agent-browser snapshot > "$SNAP" 2>/dev/null
grep -nE "menuitem" "$SNAP" | head -10
FREF=$(refof "附件" "$SNAP")
echo "附件 ref: ${FREF:-NONE}"

if [ -n "$FREF" ]; then
  echo
  echo "=== 3. expand the submenu ==="
  agent-browser hover "@$FREF" >/dev/null 2>&1
  sleep 2
  agent-browser click "@$FREF" 2>&1 | head -2
  sleep 4
  agent-browser snapshot > "$SNAP" 2>/dev/null
  echo "--- snapshot lines mentioning 上传/文件/upload ---"
  grep -nE "上传|文件|upload|file" "$SNAP" | head -12
  echo "--- all menuitems now ---"
  grep -nE "menuitem" "$SNAP" | head -14
  echo "--- file inputs ---"
  agent-browser eval "(function(){var f=document.querySelectorAll('input[type=file]');return 'count='+f.length;})()" 2>/dev/null

  UREF=$(refof "上传" "$SNAP")
  echo "上传 item ref: ${UREF:-NONE}"
  if [ -n "$UREF" ]; then
    agent-browser click "@$UREF" 2>&1 | head -2
    sleep 3
    echo "--- file inputs after clicking upload ---"
    agent-browser eval "(function(){var f=document.querySelectorAll('input[type=file]');var o=[];for(var i=0;i<f.length;i++)o.push((f[i].accept||'*'));return 'count='+f.length+' accepts='+o.join(',');})()" 2>/dev/null
    echo "--- uploading ---"
    agent-browser upload "input[type=file]" "$DOC" 2>&1 | head -3
    sleep 25
  fi

  agent-browser screenshot body "$OUT/$SHOT" >/dev/null 2>&1
  [ -f "$OUT/$SHOT" ] && echo "screenshot: $(stat -c%s "$OUT/$SHOT") bytes"
  echo "--- page text head ---"
  agent-browser eval "document.body.innerText.replace(/\s+/g,' ').slice(0,300)" 2>/dev/null | head -3
fi

agent-browser close >/dev/null 2>&1
echo
echo "=== done ==="
