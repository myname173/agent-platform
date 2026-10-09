#!/bin/bash
# 目的：把 PivotAI 登录页切到深色，验证「深底仍用 screen」这一支没被改坏。
# 一次调用完成：open -> 点主题下拉 -> 选深色 -> reload -> 探测 + 截图 -> close
set -u
cd /c/Users/13682/Desktop/agent-platform-main
export NO_PROXY='*'; export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

OUT="C:/Users/13682/Desktop/agent-platform-main/interview-demo/_scratch"
LOG="interview-demo/_scratch/theme-dark.log"
: > "$LOG"
S=themedark

agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 9
agent-browser set viewport 1600 1000 --session $S >> "$LOG" 2>&1
sleep 3

echo "=== A) 点开主题下拉 ===" >> "$LOG"
cat > /tmp/a.js <<'JS'
(function () {
  var all = document.querySelectorAll('.lobe-dropdown-menu-trigger');
  var themeBtn = null;
  all.forEach(function (b) {
    var r = b.getBoundingClientRect();
    if (r.left > 90 && r.left < 260 && r.top > innerHeight - 200) themeBtn = b;
  });
  if (!themeBtn) return 'NO-TRIGGER';
  themeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'clicked trigger at ' + Math.round(themeBtn.getBoundingClientRect().left);
})()
JS
agent-browser eval --stdin --session $S < /tmp/a.js >> "$LOG" 2>&1
sleep 2

echo "=== B) 列出菜单项 ===" >> "$LOG"
cat > /tmp/b.js <<'JS'
(function () {
  var items = [];
  document.querySelectorAll('[role="menuitem"],.lobe-dropdown-menu-item,[role="option"],button,div').forEach(function (e) {
    var t = (e.innerText || '').trim();
    var r = e.getBoundingClientRect();
    if (t && t.length < 14 && r.width > 40 && r.height > 16 && r.top > innerHeight - 320 && r.left < 460) {
      items.push({ t: t, x: Math.round(r.left), y: Math.round(r.top), tag: e.tagName });
    }
  });
  return JSON.stringify(items.slice(0, 20));
})()
JS
agent-browser eval --stdin --session $S < /tmp/b.js >> "$LOG" 2>&1
sleep 1

echo "=== C) 点「深色 / Dark / 暗色」 ===" >> "$LOG"
cat > /tmp/c.js <<'JS'
(function () {
  var want = /深色|暗色|Dark|dark/;
  var hit = null;
  document.querySelectorAll('[role="menuitem"],.lobe-dropdown-menu-item,[role="option"],div,button,li').forEach(function (e) {
    if (hit) return;
    var t = (e.innerText || '').trim();
    if (t && t.length < 14 && want.test(t)) {
      var r = e.getBoundingClientRect();
      if (r.width > 30 && r.height > 14) hit = e;
    }
  });
  if (!hit) return 'NO-DARK-ITEM';
  hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'clicked: ' + (hit.innerText || '').trim();
})()
JS
agent-browser eval --stdin --session $S < /tmp/c.js >> "$LOG" 2>&1
sleep 3

echo "=== D) reload ===" >> "$LOG"
agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 10

echo "=== E) 探测 DOM（期望 matClass 不含 pivot-face-light、blend=screen）===" >> "$LOG"
cat > /tmp/d.js <<'JS'
(function () {
  var mat = document.getElementById('pivot-face-mat');
  var cs = mat ? getComputedStyle(mat) : null;
  var out = {
    href: location.href,
    matExists: !!mat,
    matClass: mat ? mat.className : null,
    matOpacity: cs ? cs.opacity : null,
    matBlend: cs ? cs.mixBlendMode : null,
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null
  };
  try {
    var st = document.elementsFromPoint(Math.round(innerWidth * 0.85), Math.round(innerHeight * 0.5)) || [];
    out.probe = st.slice(0, 8).map(function (el) { return el.tagName + '#' + (el.id || '') + ' bg=' + getComputedStyle(el).backgroundColor; });
  } catch (e) { out.probe = 'ERR ' + e; }
  return JSON.stringify(out, null, 1);
})()
JS
agent-browser eval --stdin --session $S < /tmp/d.js >> "$LOG" 2>&1

echo "=== F) 截图 ===" >> "$LOG"
agent-browser screenshot body "$OUT/face-dark-auth.png" --session $S >> "$LOG" 2>&1

agent-browser close --session $S >> "$LOG" 2>&1
ls -la interview-demo/_scratch/face-dark-auth.png >> "$LOG" 2>&1
echo "DONE" >> "$LOG"
