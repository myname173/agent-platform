#!/bin/bash
# 用探针账号登录，抓「登录后的 chat 页」是否也是深色（这是主界面，之前没验证过）
set -u
cd /c/Users/13682/Desktop/agent-platform-main
export NO_PROXY='*'; export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

OUT="C:/Users/13682/Desktop/agent-platform-main/interview-demo/_scratch"
LOG="interview-demo/_scratch/chat-login.log"
: > "$LOG"
S=chatlogin

EV() { agent-browser eval "$1" --session $S >> "$LOG" 2>&1; }
EVS() { agent-browser eval --stdin --session $S >> "$LOG" 2>&1; }

agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 10
agent-browser set viewport 1600 1000 --session $S >> "$LOG" 2>&1
sleep 2

echo "### 1) 页面上的输入框/按钮" >> "$LOG"
EV '(function(){return JSON.stringify({
  inputs:[].map.call(document.querySelectorAll("input"),function(e){return {type:e.type,name:e.name,ph:e.placeholder};}),
  btns:[].map.call(document.querySelectorAll("button"),function(e){return (e.innerText||"").trim().slice(0,20);}).filter(Boolean)
});})()'

echo "### 2) 填邮箱 + 下一步" >> "$LOG"
cat > /tmp/lg1.js <<'JS'
(function(){
  var inp=document.querySelector('input[type="email"]')||document.querySelector('input[name="email"]')||document.querySelector('input');
  if(!inp)return 'NO-INPUT';
  var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  d.call(inp,'probe-check@invalid.local');
  inp.dispatchEvent(new Event('input',{bubbles:true}));
  inp.dispatchEvent(new Event('change',{bubbles:true}));
  var b=null;
  document.querySelectorAll('button').forEach(function(x){
    var t=(x.innerText||'').trim();
    if(!b&&/下一步|继续|Next|Continue|登录|Sign/i.test(t))b=x;
  });
  if(!b)return 'NO-BUTTON';
  b.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return 'submitted-email';
})()
JS
EVS < /tmp/lg1.js
sleep 4

echo "### 2b) 勾选协议 + 同意并继续" >> "$LOG"
cat > /tmp/lg1b.js <<'JS'
(function(){
  var cb=document.querySelector('input[type="checkbox"]');
  if(cb&&!cb.checked){cb.click();}
  var b=null;
  document.querySelectorAll('button').forEach(function(x){
    var t=(x.innerText||'').trim();
    if(!b&&/同意并继续|同意|Agree|Accept/i.test(t))b=x;
  });
  if(!b)return 'NO-AGREE-BUTTON';
  b.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return 'agreed';
})()
JS
EVS < /tmp/lg1b.js
sleep 4

echo "### 3) 第二步有哪些输入框" >> "$LOG"
EV '(function(){return JSON.stringify({
  inputs:[].map.call(document.querySelectorAll("input"),function(e){return {type:e.type,name:e.name,ph:e.placeholder};}),
  btns:[].map.call(document.querySelectorAll("button"),function(e){return (e.innerText||"").trim().slice(0,20);}).filter(Boolean)
});})()'

echo "### 4) 填密码 + 提交" >> "$LOG"
cat > /tmp/lg2.js <<'JS'
(function(){
  var inp=document.querySelector('input[type="password"]');
  if(!inp)return 'NO-PASSWORD-INPUT';
  var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  d.call(inp,'Probe-Check-2026!x');
  inp.dispatchEvent(new Event('input',{bubbles:true}));
  inp.dispatchEvent(new Event('change',{bubbles:true}));
  var b=null;
  document.querySelectorAll('button').forEach(function(x){
    var t=(x.innerText||'').trim();
    if(!b&&/下一步|继续|Next|Continue|登录|Sign/i.test(t))b=x;
  });
  if(!b)return 'NO-BUTTON';
  b.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return 'submitted-password';
})()
JS
EVS < /tmp/lg2.js
sleep 12

echo "### 5) 登录后：URL + 主题" >> "$LOG"
agent-browser get url --session $S >> "$LOG" 2>&1
EV '(function(){var mat=document.getElementById("pivot-face-mat");var cs=mat?getComputedStyle(mat):null;return JSON.stringify({
  dataTheme:document.documentElement.getAttribute("data-theme"),
  stored:localStorage.getItem("theme"),
  htmlBg:getComputedStyle(document.documentElement).backgroundColor,
  bodyBg:document.body?getComputedStyle(document.body).backgroundColor:null,
  canvas:!!document.getElementById("pivot-particle-canvas"),
  matClass:mat?mat.className:null,
  matBlend:cs?cs.mixBlendMode:null,
  brand:(document.querySelector("#pivot-brand-widget")||{}).innerText||null
});})()'

agent-browser screenshot body "$OUT/chat-dark-1.png" --session $S >> "$LOG" 2>&1
sleep 2
agent-browser screenshot body "$OUT/chat-dark-2.png" --session $S >> "$LOG" 2>&1

echo "### 6) 走完 onboarding（通用推进循环）" >> "$LOG"
cat > /tmp/lg3.js <<'JS'
(function(){
  var adv=null,pick=null;
  document.querySelectorAll('button').forEach(function(x){
    var t=(x.innerText||'').trim();
    if(!t)return;
    if(/上一步|Back|取消|Cancel|English/i.test(t))return;
    if(/下一步|继续|Next|Continue|^开始$|完成|Finish|Done|保存|确定|Skip|跳过/i.test(t)){ if(!adv)adv=x; return; }
    if(/简体中文|跟随系统/.test(t)){ if(!pick)pick=x; }
  });
  var b=adv||pick;
  if(!b)return 'NO-ADVANCE';
  b.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  return 'clicked:'+(b.innerText||'').trim();
})()
JS
for i in 1 2 3 4 5 6 7 8 9 10; do
  echo "--- advance #$i ---" >> "$LOG"
  EVS < /tmp/lg3.js
  sleep 5
  agent-browser get url --session $S >> "$LOG" 2>&1
done
agent-browser screenshot body "$OUT/onb-after-start.png" --session $S >> "$LOG" 2>&1
EV '(function(){return JSON.stringify({
  url:location.href,
  h1:(document.querySelector("h1,h2")||{}).innerText||null,
  btns:[].map.call(document.querySelectorAll("button"),function(e){return (e.innerText||"").trim().slice(0,24);}).filter(Boolean).slice(0,14)
});})()'

echo "### 7) 进入 /chat 主界面" >> "$LOG"
agent-browser open "http://127.0.0.1:3210/chat" --session $S >> "$LOG" 2>&1
sleep 14
agent-browser get url --session $S >> "$LOG" 2>&1
EV '(function(){var mat=document.getElementById("pivot-face-mat");var cs=mat?getComputedStyle(mat):null;return JSON.stringify({
  dataTheme:document.documentElement.getAttribute("data-theme"),
  stored:localStorage.getItem("theme"),
  htmlBg:getComputedStyle(document.documentElement).backgroundColor,
  bodyBg:document.body?getComputedStyle(document.body).backgroundColor:null,
  canvas:!!document.getElementById("pivot-particle-canvas"),
  matClass:mat?mat.className:null,
  matBlend:cs?cs.mixBlendMode:null
});})()'
agent-browser screenshot body "$OUT/chat-dark-3.png" --session $S >> "$LOG" 2>&1
sleep 3
agent-browser screenshot body "$OUT/chat-dark-4.png" --session $S >> "$LOG" 2>&1

agent-browser close --session $S >> "$LOG" 2>&1
echo "DONE" >> "$LOG"
