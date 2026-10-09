#!/bin/bash
# 「黑底」验收：全新会话（无任何存储）打开 /signin，应直接是深色。
# 同时检查两处修复是否都生效：
#   A. JS 抢先种下 localStorage.theme=dark -> html[data-theme="dark"]
#   B. CSS 特异性冲突已修 -> html/body 真的画出 #030712（不再 transparent）
set -u
cd /c/Users/13682/Desktop/agent-platform-main
export NO_PROXY='*'; export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

OUT="C:/Users/13682/Desktop/agent-platform-main/interview-demo/_scratch"
LOG="interview-demo/_scratch/dark-verify.log"
: > "$LOG"

PROBE='(function(){
  var mat=document.getElementById("pivot-face-mat");
  var cs=mat?getComputedStyle(mat):null;
  var o={};
  o.themeStored=localStorage.getItem("theme");
  o.htmlDataTheme=document.documentElement.getAttribute("data-theme");
  o.htmlStyle=document.documentElement.getAttribute("style");
  o.htmlBg=getComputedStyle(document.documentElement).backgroundColor;
  o.bodyBg=document.body?getComputedStyle(document.body).backgroundColor:null;
  o.bodyImg=document.body?(getComputedStyle(document.body).backgroundImage||"").slice(0,60):null;
  o.canvas=!!document.getElementById("pivot-particle-canvas");
  o.matExists=!!mat;
  o.matClass=mat?mat.className:null;
  o.matBlend=cs?cs.mixBlendMode:null;
  o.matOpacity=cs?cs.opacity:null;
  try{var st=document.elementsFromPoint(Math.round(innerWidth*0.85),Math.round(innerHeight*0.5))||[];
    o.painted=st.map(function(e){return getComputedStyle(e).backgroundColor;})
      .filter(function(b){return b!=="rgba(0, 0, 0, 0)";}).slice(-1)[0]||"none";}catch(e){o.painted="ERR";}
  return JSON.stringify(o);
})()'

# 每个阶段都用独立 session，保证「全新会话」
run() {  # $1=session  $2=url  $3=shot
  local S="$1" U="$2" SH="$3"
  echo "### session=$S url=$U" >> "$LOG"
  agent-browser open "$U" --session "$S" >> "$LOG" 2>&1
  sleep 10
  agent-browser set viewport 1600 1000 --session "$S" >> "$LOG" 2>&1
  sleep 3
  agent-browser eval "$PROBE" --session "$S" >> "$LOG" 2>&1
  [ -n "$SH" ] && agent-browser screenshot body "$OUT/$SH" --session "$S" >> "$LOG" 2>&1
  agent-browser close --session "$S" >> "$LOG" 2>&1
}

run darkfresh1 "http://127.0.0.1:3210/signin" "dark-auth-1.png"
run darkfresh2 "http://127.0.0.1:3210/signin" "dark-auth-2.png"
run darkroot   "http://127.0.0.1:3210/"       "dark-root.png"

echo "DONE" >> "$LOG"
