#!/bin/bash
# 验证：LobeChat 是否在「启动时」读 localStorage.theme
#   打开 -> 记录（应为 light / 空存储）
#   -> 手动写 localStorage.theme='dark' -> 重新打开 -> 记录（若为 dark 则「启动时读」成立）
set -u
cd /c/Users/13682/Desktop/agent-platform-main
export NO_PROXY='*'; export no_proxy='*'
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

LOG="interview-demo/_scratch/theme-boot.log"
: > "$LOG"
S=themeboot

DUMP='(function(){return JSON.stringify({
  theme: localStorage.getItem("theme"),
  htmlDataTheme: document.documentElement.getAttribute("data-theme"),
  htmlStyle: document.documentElement.getAttribute("style"),
  bodyBg: document.body?getComputedStyle(document.body).backgroundColor:null,
  htmlBg: getComputedStyle(document.documentElement).backgroundColor
});})()'

agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 10

echo "### 1) 全新会话（未登录、无存储）" >> "$LOG"
agent-browser eval "$DUMP" --session $S >> "$LOG" 2>&1

echo "### 2) 写入 localStorage.theme=dark" >> "$LOG"
agent-browser eval "localStorage.setItem('theme','dark'), 'seeded'" --session $S >> "$LOG" 2>&1

echo "### 3) 重新打开页面（测启动读取）" >> "$LOG"
agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 10
agent-browser eval "$DUMP" --session $S >> "$LOG" 2>&1

echo "### 4) 再试 auto（看默认解析）" >> "$LOG"
agent-browser eval "localStorage.setItem('theme','auto'), 'auto'" --session $S >> "$LOG" 2>&1
agent-browser open "http://127.0.0.1:3210/signin" --session $S >> "$LOG" 2>&1
sleep 10
agent-browser eval "$DUMP" --session $S >> "$LOG" 2>&1

agent-browser close --session $S >> "$LOG" 2>&1
echo "DONE" >> "$LOG"
