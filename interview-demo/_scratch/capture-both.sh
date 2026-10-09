#!/bin/bash
# 验证修复后的双向行为：
#   阶段1 深色（已持久化）-> 期望 matClass 不含 pivot-face-light、blend=screen
#   阶段2 切到浅色（不刷新）-> 期望 observer 生效、class 出现、blend=multiply
#   阶段3 刷新一次          -> 期望 init 路径也给出同样的结果
set -u
cd /c/Users/13682/Desktop/agent-platform-main
export NO_PROXY='*'; export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

OUT="C:/Users/13682/Desktop/agent-platform-main/interview-demo/_scratch"
LOG="interview-demo/_scratch/face-both.log"
: > "$LOG"
S=faceboth

PROBE='(function(){
  var mat=document.getElementById("pivot-face-mat");
  var cs=mat?getComputedStyle(mat):null;
  var out={matExists:!!mat,matClass:mat?mat.className:null,
    matOpacity:cs?cs.opacity:null,matBlend:cs?cs.mixBlendMode:null,
    dataTheme:document.documentElement.getAttribute("data-theme"),
    inlineCS:document.documentElement.style.colorScheme||null,
    stored:localStorage.getItem("theme")};
  try{var st=document.elementsFromPoint(Math.round(innerWidth*0.85),Math.round(innerHeight*0.5))||[];
    out.painted=st.map(function(e){return getComputedStyle(e).backgroundColor;})
      .filter(function(b){return b!=="rgba(0, 0, 0, 0)";}).slice(-1)[0]||"none";}catch(e){out.painted="ERR";}
  return JSON.stringify(out);
})()'

# 通过左下角主题下拉切换
settheme() {
  cat > /tmp/st.js <<JS
(function(){
  var all=document.querySelectorAll('.lobe-dropdown-menu-trigger'),tb=null;
  all.forEach(function(b){var r=b.getBoundingClientRect();
    if(r.left>90&&r.left<260&&r.top>innerHeight-200)tb=b;});
  if(!tb)return 'NO-TRIGGER';
  tb.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return 'opened';
})()
JS
  agent-browser eval --stdin --session $S < /tmp/st.js >> "$LOG" 2>&1
  sleep 2
  cat > /tmp/st2.js <<JS
(function(){
  var want=/$1/,hit=null;
  document.querySelectorAll('[role="menuitem"],.lobe-dropdown-menu-item,div').forEach(function(e){
    if(hit)return;var t=(e.innerText||'').trim();
    if(t&&t.length<14&&want.test(t)){var r=e.getBoundingClientRect();
      if(r.width>30&&r.height>14)hit=e;}});
  if(!hit)return 'NO-ITEM';
  hit.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return 'clicked:'+(hit.innerText||'').trim();
})()
JS
  agent-browser eval --stdin --session $S < /tmp/st2.js >> "$LOG" 2>&1
}

agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 10
agent-browser set viewport 1600 1000 --session $S >> "$LOG" 2>&1
sleep 3

echo "### 阶段1 初始（应已是深色：验证 §9.6 的「默认深色」）" >> "$LOG"
agent-browser eval "$PROBE" --session $S >> "$LOG" 2>&1
agent-browser screenshot body "$OUT/face-dark-auth.png" --session $S >> "$LOG" 2>&1

echo "### 阶段2 切到浅色（不刷新，测 observer 是否加上 class）" >> "$LOG"
settheme 'Light|浅色|亮色'
sleep 4
agent-browser eval "$PROBE" --session $S >> "$LOG" 2>&1
agent-browser screenshot body "$OUT/face-light-noreload.png" --session $S >> "$LOG" 2>&1

echo "### 阶段3 切回深色（不刷新）" >> "$LOG"
settheme 'Dark|深色|暗色'
sleep 4
agent-browser eval "$PROBE" --session $S >> "$LOG" 2>&1
agent-browser screenshot body "$OUT/face-dark-noreload.png" --session $S >> "$LOG" 2>&1

echo "### 阶段4 深色下刷新（测 init 路径 + 持久化）" >> "$LOG"
agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 10
agent-browser eval "$PROBE" --session $S >> "$LOG" 2>&1
agent-browser screenshot body "$OUT/face-dark-reload.png" --session $S >> "$LOG" 2>&1

agent-browser close --session $S >> "$LOG" 2>&1
ls -la interview-demo/_scratch/face-*.png >> "$LOG" 2>&1
echo "DONE" >> "$LOG"
