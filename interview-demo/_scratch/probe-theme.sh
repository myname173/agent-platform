#!/bin/bash
set -u
cd /c/Users/13682/Desktop/agent-platform-main
export NO_PROXY='*'; export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
LOG="interview-demo/_scratch/theme-probe.log"
: > "$LOG"
S=themeprobe

agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 9

cat > /tmp/theme-probe.js <<'JS'
(function () {
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  var themeish = {};
  keys.forEach(function (k) {
    if (/theme|mode|appearance|color/i.test(k)) themeish[k] = (localStorage.getItem(k) || '').slice(0, 300);
  });
  // 找左下角那排按钮的可访问名
  var btns = [];
  document.querySelectorAll('button,[role="button"]').forEach(function (b) {
    var r = b.getBoundingClientRect();
    if (r.top > innerHeight - 140 && r.left < 400) {
      btns.push({
        txt: (b.innerText || '').trim().slice(0, 24),
        aria: b.getAttribute('aria-label') || '',
        cls: (b.className || '').toString().slice(0, 60),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
      });
    }
  });
  return JSON.stringify({ allKeys: keys, themeish: themeish, bottomLeftButtons: btns }, null, 1);
})()
JS
agent-browser eval --stdin --session $S < /tmp/theme-probe.js >> "$LOG" 2>&1
agent-browser close --session $S >> "$LOG" 2>&1
echo "DONE" >> "$LOG"
