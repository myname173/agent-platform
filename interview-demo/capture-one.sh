#!/bin/bash
# One page per invocation: login -> shoot ONE page -> close.
# (The agent-browser daemon does not survive between tool calls, and a long run loses the session.)
set -u
cd /c/Users/13682/Desktop/agent-platform-main || exit 1
export NO_PROXY='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

PAGE="$1"; NAME="$2"
OUT="C:/Users/13682/Desktop/agent-platform-main/interview-demo/实机截图"

SK=$(grep -E '^CLERK_SECRET_KEY=' frontent/.env.local | cut -d= -f2- | tr -d '\r')
TOKEN=""
for i in 1 2 3 4 5; do
  TOKEN=$(curl -sS -X POST -H "Authorization: Bearer $SK" -H 'Content-Type: application/json' \
    -d '{"user_id":"user_3KETaGEWybAr25tIOtILcHGE1jM","expires_in_seconds":1800}' \
    https://api.clerk.com/v1/sign_in_tokens 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ ${#TOKEN} -gt 100 ] && break
  echo "  retry $i"; sleep 4
done
[ ${#TOKEN} -le 100 ] && { echo "!! no ticket"; exit 1; }
echo "ticket ok"

agent-browser open "http://127.0.0.1:3001/auth/sign-in?__clerk_ticket=$TOKEN" > /dev/null 2>&1
sleep 15
URL="$(agent-browser get url 2>/dev/null | head -1)"
case "$URL" in *sign-in*) echo "!! NOT LOGGED IN"; exit 2;; esac
echo "logged in"

agent-browser set viewport 1600 1000 > /dev/null 2>&1
agent-browser open "http://127.0.0.1:3001$PAGE" > /dev/null 2>&1
sleep 10

# confirm we are still logged in: look for POSITIVE evidence (the app sidebar),
# not for absence of sign-in text (the SPA shell can briefly contain it).
BODY=$(agent-browser eval "document.body.innerText.replace(/\n+/g,' ')" 2>/dev/null)
case "$BODY" in
  *"Toggle Sidebar"*) echo "  app shell present";;
  *) echo "!! not logged in on $PAGE"; exit 3;;
esac

# dismiss the Clerk dev-mode notice by ref, then hide it with a CSS rule for the shot
agent-browser snapshot > /tmp/ab_snap.txt 2>/dev/null
REF=$(grep -oE 'button "I.ll remove it myself" \[ref=[^]]+\]' /tmp/ab_snap.txt | head -1 | sed 's/.*\[ref=//; s/\]//')
[ -n "${REF:-}" ] && { agent-browser click "@$REF" > /dev/null 2>&1; sleep 2; }
agent-browser eval "(function(){var s=document.createElement('style');s.textContent='.cl-modalBackdrop{display:none !important;}';document.head.appendChild(s);return 'ok';})()" > /dev/null 2>&1
sleep 1

agent-browser screenshot body "$OUT/$NAME" > /dev/null 2>&1
agent-browser close > /dev/null 2>&1
if [ -f "$OUT/$NAME" ]; then echo "saved $NAME ($(stat -c%s "$OUT/$NAME") bytes)"; else echo "!! MISSING $NAME"; exit 4; fi
