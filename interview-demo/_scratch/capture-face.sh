#!/bin/bash
# 单次调用完成：open -> 探测 DOM -> 截图 -> close
# 要点（见 live-ui-evidence-capture skill）：
#   - 绝不 `| tail`：daemon 继承管道写端，tail 永远等不到 EOF，看起来像卡死
#   - NO_PROXY='*' + unset 代理变量
#   - screenshot 是 [selector] [path]，不是 [path]
#   - Windows 截图路径必须 C:/ 形式
set -u
cd /c/Users/13682/Desktop/agent-platform-main

export NO_PROXY='*'; export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

OUT="C:/Users/13682/Desktop/agent-platform-main/interview-demo/_scratch"
LOG="interview-demo/_scratch/face-capture.log"
: > "$LOG"
S=facefix

echo "=== 1) open ===" >> "$LOG"
agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
echo "open exit=$?" >> "$LOG"

sleep 10

echo "=== 2) get url ===" >> "$LOG"
agent-browser get url --session $S >> "$LOG" 2>&1

echo "=== 3) set viewport ===" >> "$LOG"
agent-browser set viewport 1600 1000 --session $S >> "$LOG" 2>&1
sleep 4

echo "=== 4) probe DOM ===" >> "$LOG"
cat > /tmp/face-probe.js <<'JS'
(function () {
  var mat = document.getElementById('pivot-face-mat');
  var cs = mat ? getComputedStyle(mat) : null;
  var out = {
    href: location.href,
    title: document.title,
    matExists: !!mat,
    matClass: mat ? mat.className : null,
    matOpacity: cs ? cs.opacity : null,
    matBlend: cs ? cs.mixBlendMode : null,
    matMask: cs ? (cs.maskImage || cs.webkitMaskImage || 'none').slice(0, 70) : null,
    matBgUrl: cs ? (cs.backgroundImage || '').slice(0, 120) : null,
    canvasExists: !!document.getElementById('pivot-particle-canvas'),
    canvasCount: document.querySelectorAll('canvas').length,
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null
  };
  if (mat) {
    var r = mat.getBoundingClientRect();
    out.matRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }
  try {
    out.faceResource = performance.getEntriesByType('resource')
      .filter(function (e) { return /pivot-face/.test(e.name); })
      .map(function (e) { return { name: e.name.split('/').pop(), size: e.transferSize, ms: Math.round(e.duration) }; });
  } catch (e) { out.faceResource = 'ERR ' + e; }
  try {
    var st = document.elementsFromPoint(Math.round(innerWidth * 0.85), Math.round(innerHeight * 0.5)) || [];
    out.probe = st.slice(0, 8).map(function (el) {
      var c = getComputedStyle(el);
      return el.tagName + '#' + (el.id || '') + ' bg=' + c.backgroundColor;
    });
  } catch (e) { out.probe = 'ERR ' + e; }
  return JSON.stringify(out, null, 1);
})()
JS
agent-browser eval --stdin --session $S < /tmp/face-probe.js >> "$LOG" 2>&1

echo "=== 5) screenshot (viewport, body) ===" >> "$LOG"
agent-browser screenshot body "$OUT/face-light-auth.png" --session $S >> "$LOG" 2>&1
echo "shot exit=$?" >> "$LOG"

echo "=== 6) close ===" >> "$LOG"
agent-browser close --session $S >> "$LOG" 2>&1

echo "=== 产物 ===" >> "$LOG"
ls -la interview-demo/_scratch/face-light-auth.png >> "$LOG" 2>&1
echo "SCRIPT-DONE" >> "$LOG"
