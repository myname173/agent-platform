#!/usr/bin/env bash
# 体检脚本：用真实浏览器渲染 面试演示台.html，逐页强制显示后测量内容高度与余量。
#
# 为什么需要它：deck 每页是 .slide{height:min(94vh,900px)} + .body{overflow:auto}，
# 内容超高时不会报错，只会"悄悄变成可滚动"。1080p 全屏下每页 .body 可用高度约 783px，
# 超过这个值在投影时就会被截断。
#
# 输出两列：
#   余量   = 可用高度 - 内容底部（>2 会标 OVERFLOW）
#   余量   = 还空着多少。余量特别大说明这页太单薄，可以补内容或放大图。
#
# 依赖：agent-browser（见 agent-browser skill）。Windows 下截图路径必须写 C:/... 而非 /c/...。
# 注意：agent-browser 是全局单例，不要和别的采集脚本同时跑，否则会互相抢页面。
# 用法：bash interview-demo/check-deck.sh
set -u
DECK_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DECK_DIR/check-deck.log"
: > "$LOG"
URL="file:///C:/Users/13682/Desktop/agent-platform-main/interview-demo/%E9%9D%A2%E8%AF%95%E6%BC%94%E7%A4%BA%E5%8F%B0.html"

{
  agent-browser open "$URL"
  agent-browser set viewport 1600 950
  sleep 4
  # 关键：必须先 show(k) 让该页 display:flex，否则隐藏页测出来永远是 0。
  agent-browser eval "var out=[];var sl=document.querySelectorAll('.slide');for(var k=0;k<sl.length;k++){show(k);var b=sl[k].querySelector('.body');var ch=b.clientHeight;var bt=b.getBoundingClientRect().top;var bot=0;var kids=b.children;for(var j=0;j<kids.length;j++){var r=kids[j].getBoundingClientRect();var t=r.bottom-bt;if(t>bot)bot=t;}var o=Math.round(bot-ch);out.push((k+1)+'  '+(o>2?'OVERFLOW '+o:'ok')+'  内容 '+Math.round(bot)+' / 可用 '+ch+'  余量 '+Math.round(ch-bot)+'  '+(sl[k].querySelector('h2')?sl[k].querySelector('h2').textContent.slice(0,26):''));}show(0);out.join('\n')"
  agent-browser close
} >> "$LOG" 2>&1

cat "$LOG"
echo
echo "（每页 .body 可用高度 783px；OVERFLOW 要删内容或缩小图；余量过大说明该页太单薄）"
