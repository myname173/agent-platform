#!/bin/bash
# 找出 LobeChat 的主题偏好到底存在哪：
# 打开页面 -> 记录存储 -> 点 Dark -> 再记录 -> 对比出「变了什么」
set -u
cd /c/Users/13682/Desktop/agent-platform-main
export NO_PROXY='*'; export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

LOG="interview-demo/_scratch/theme-store.log"
: > "$LOG"
S=themestore

DUMP='(function(){
  var ls={}; for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i); ls[k]=(localStorage.getItem(k)||"").slice(0,400);}
  var ss={}; for(var j=0;j<sessionStorage.length;j++){var k2=sessionStorage.key(j); ss[k2]=(sessionStorage.getItem(k2)||"").slice(0,400);}
  return JSON.stringify({
    cookies: document.cookie,
    localStorage: ls,
    sessionStorage: ss,
    htmlClass: document.documentElement.className,
    htmlDataTheme: document.documentElement.getAttribute("data-theme"),
    htmlStyle: document.documentElement.getAttribute("style"),
    bodyClass: document.body ? document.body.className : null,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    mediaDark: window.matchMedia("(prefers-color-scheme: dark)").matches
  });
})()'

agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 10
agent-browser set viewport 1600 1000 --session $S >> "$LOG" 2>&1
sleep 2

echo "### A) 初始（浅色）" >> "$LOG"
agent-browser eval "$DUMP" --session $S >> "$LOG" 2>&1

echo "### B) 点主题菜单 -> Dark" >> "$LOG"
cat > /tmp/ts1.js <<'JS'
(function(){
  var all=document.querySelectorAll('.lobe-dropdown-menu-trigger'),tb=null;
  all.forEach(function(b){var r=b.getBoundingClientRect();
    if(r.left>90&&r.left<260&&r.top>innerHeight-200)tb=b;});
  if(!tb)return 'NO-TRIGGER';
  tb.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return 'opened';
})()
JS
agent-browser eval --stdin --session $S < /tmp/ts1.js >> "$LOG" 2>&1
sleep 2
cat > /tmp/ts2.js <<'JS'
(function(){
  var want=/Dark/,hit=null;
  document.querySelectorAll('[role="menuitem"],.lobe-dropdown-menu-item,div').forEach(function(e){
    if(hit)return;var t=(e.innerText||'').trim();
    if(t&&t.length<14&&want.test(t)){var r=e.getBoundingClientRect();
      if(r.width>30&&r.height>14)hit=e;}});
  if(!hit)return 'NO-ITEM';
  hit.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return 'clicked:'+(hit.innerText||'').trim();
})()
JS
agent-browser eval --stdin --session $S < /tmp/ts2.js >> "$LOG" 2>&1
sleep 3

echo "### C) 切到 Dark 之后" >> "$LOG"
agent-browser eval "$DUMP" --session $S >> "$LOG" 2>&1

agent-browser close --session $S >> "$LOG" 2>&1
echo "DONE" >> "$LOG"
