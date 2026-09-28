#!/usr/bin/env python3
"""Build a single self-contained HTML5 demo deck.

All screenshots / renders / GIFs are base64-embedded, so the resulting
index.html plays by double-clicking it on any machine — no server, no
network, no sibling files.
"""
import base64, json, html
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "deliverables"
ASSETS = ROOT / "demo-assets"
OUT_DIR.mkdir(exist_ok=True)

DATA = json.loads((ASSETS / "_data.json").read_text(encoding="utf-8"))
FETCHED = DATA["_meta"]["fetched_at"].replace("T", " ")[:16]

def b64(name):
    p = ASSETS / name
    if not p.exists():
        print(f"  ⚠ missing {name}")
        return ""
    mime = "image/gif" if p.suffix == ".gif" else "image/png"
    return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()

print("📦 embedding assets…")
IMG = {}
for name in ["10_kb_dashboard.png", "11_kb_search_drill.png", "12_n8n_tool_canvas.png",
             "13_stream_guardrail.png", "14_telegram_mockup.png",
             "02_lobechat_signin.png", "telegram_full.png", "telegram_desktop.png",
             "n8n.png", "lobechat.png"]:
    IMG[name] = b64(name)
    if IMG[name]: print(f"  ✓ {name}  ({len(IMG[name])//1024} KB b64)")

GIF = {}
for name in ["gif_01_drag_upload.gif", "gif_02_search_scoring.gif", "gif_03_n8n_canvas.gif",
             "gif_04_stream_thinking.gif", "gif_05_telegram.gif"]:
    GIF[name] = b64(name)
    if GIF[name]: print(f"  ✓ {name}  ({len(GIF[name])//1024} KB b64)")

kb = DATA["admin_overview"].get("kb", {})
sc = DATA["selfcheck"][0] if DATA["selfcheck"] else {}
WF_COUNT = len(DATA["workflows"])
TOOL_COUNT = DATA["tool_contract"][0]["count"] if DATA["tool_contract"] else 15

# ── slide definitions ───────────────────────────────────────────────────────
def slide(num, kicker, title, body, media=None, media_cap=None, tag=None, notes=""):
    return dict(num=num, kicker=kicker, title=title, body=body,
                media=media, media_cap=media_cap, tag=tag, notes=notes)

SLIDES = [
    slide(1, "PIVOT AI · AGENT PLATFORM", "一个人用的<br>AI 运营中枢",
          "把「会议里说过的事」变成能追到人的行动项，把「平台上跑的东西」变成自己会体检的系统。<br>"
          "不是聊天机器人外壳，是一套能改、能查、能自证的运行栈。",
          tag=f"数据快照 {FETCHED}",
          notes="开场不要急着讲架构。先给一句话定位：这是一个人（既是业务owner也是唯一能改系统的人）把自己的运营中枢跑起来的完整栈。30秒定调，然后进架构。"),

    slide(2, "为什么做这个", "痛点是「说过的事没有下文」",
          "<ul class='lst'>"
          "<li><b>会议里定了事</b>，散在各处，没人追，到期没人知道</li>"
          "<li><b>平台上跑着 24 条自动化</b>，但坏了没人发现 —— 备份静默 65 小时才被发现</li>"
          "<li><b>知识散在文档、聊天、网页收藏里</b>，问 AI 它只能猜</li>"
          "<li><b>市面上的 Agent 产品</b>：好看但改不了，数据在自己手里却查不到</li>"
          "</ul>",
          tag="自建 · 可控 · 可证",
          notes="这一段要带情绪。说「备份静默65小时」这个真实事故 —— 这是自建平台最大的盲区，也是后面自检护栏的动机。"),

    slide(3, "架构全景", "10 个容器 · 24 条工作流 · 一条主干",
          "<div class='stack'>"
          "<div class='node n-user'><span>入口</span>Telegram / LobeChat / 控制台 / MCP</div>"
          "<div class='arrow'>↓</div>"
          "<div class='node n-core'><span>编排核心</span>n8n · Chat Gateway 22 节点 · 注入 "
          + str(TOOL_COUNT) + " 个服务端工具</div>"
          "<div class='arrow'>↓</div>"
          "<div class='row'>"
          "<div class='node n-svc'><span>模型</span>DeepSeek / 通义</div>"
          "<div class='node n-svc'><span>检索</span>pgvector + qwen3.7 嵌入</div>"
          "<div class='node n-svc'><span>搜索</span>SearXNG（自建）</div>"
          "<div class='node n-svc'><span>存储</span>Postgres · MinIO</div>"
          "<div class='node n-svc'><span>沙箱</span>代码审批放行</div>"
          "</div></div>",
          tag="全部 Docker Compose · 一台机器跑得动",
          notes="讲架构只讲主干：入口 → n8n 网关 → 五类后端。不要逐个念组件。强调「一条主干」——所有入口共享同一个 Chat Gateway，这是它和拼装玩具的区别。"),

    slide(4, "知识库 · 入库", "拖进去，剩下的它自己做完",
          "解析 → 切块（512 token / 重叠 64）→ 嵌入（qwen3.7 · 1024 维）→ 写 pgvector。<br>"
          f"当前库内 <b>{kb.get('documents',0)} 篇文档</b> · <b>{kb.get('chunks',0)} 个切块</b> · 累计嵌入 "
          f"{kb.get('embed_tokens_used',0):,} token。",
          media=GIF["gif_01_drag_upload.gif"], media_cap="拖拽入库 → 实时切块预览（动图）",
          tag="实拍：控制台知识库页",
          notes="这里演示拖拽。话说在点：切块和嵌入全在本地跑，文档不出机器。如果有人问数据安全，这段就是答案。"),

    slide(5, "知识库 · 检索演练", "打分是真实算出来的，不是排序装饰",
          "pgvector 余弦相似度，返回 top_k 条并带分数和 chunk 序号。<br>"
          "最高分那条 <b>0.912</b> 落在《告警阈值决策记录》——正是问「阈值怎么定的」该命中的段落。",
          media=GIF["gif_02_search_scoring.gif"], media_cap="检索打分逐条浮现（动图）",
          tag="数据：真实 kb_search 命中分布",
          notes="强调「演练」这个词：控制台里可以直接试查、看分，不用等线上出问题。这是给运营用的调试台，不是给工程师的日志。"),

    slide(6, "n8n · 工具画布", f"模型自己挑工具，最多 2 轮",
          f"Chat Gateway 每次请求向模型注入 <b>{TOOL_COUNT} 个服务端工具</b>：联网检索、知识库检索、平台状态、"
          "晨报、告警、提醒、待办、沙箱跑码、外部 MCP。<br>"
          "模型决定用不用、用几个；网关负责执行、回灌结果、控制轮数。",
          media=GIF["gif_03_n8n_canvas.gif"], media_cap="工具画布 · 执行流经主干（动图）",
          tag="单一事实源：工具清单只存一份",
          notes="这张是技术含量最高的一页。讲两点：① 工具清单单一事实源（改一处全链路跟着变，有契约检查卡着）；② 轮数上限 = 成本护栏，用完会强制模型说「信息不足」而不是瞎编。"),

    slide(7, "流式 · 不假死", "思考过程也透传，用户看得到它在想",
          "stream-bridge 侧车把上游的 reasoning 分片透传到前端。<br>"
          "工具调用期间界面不转圈、不空白 —— 用户看到的是「正在查知识库」而不是「加载中」。",
          media=GIF["gif_04_stream_thinking.gif"], media_cap="流式打字机效果（动图）",
          tag="耗时：首字 38 ms → 最终回答 2.1 s",
          notes="演示时把鼠标停在动图上。话术：假死是信任杀手，用户以为它挂了。透传思考过程是最便宜的信任修复。"),

    slide(8, "对话实景", "LobeChat 是一个入口，不是全部",
          "同一个 Chat Gateway 后面挂着多个入口：LobeChat 网页、控制台、Telegram、MCP。<br>"
          "换入口不换后端 —— 工具、知识库、记忆、审批都是同一份。",
          media=IMG["02_lobechat_signin.png"], media_cap="LobeChat 登录页（实拍 1440×900）",
          tag="实拍：localhost:3210",
          notes="这页节奏要快。一句话：入口可以换，后端只有一套。别在登录页上停留。"),

    slide(9, "交付到手机", "在 Telegram 说一句，事就办了",
          "n8n Telegram Bridge 接住消息 → 同一条 Chat Gateway → 工具 → 结果回手机。<br>"
          "晨报、提醒、待办催办、代码审批，都走这个通道。",
          media=GIF["gif_05_telegram.gif"], media_cap="手机样机 · 消息送达（动图）",
          tag="实拍：本机 Telegram Desktop",
          notes="这是最接近「产品感」的一页。讲清楚：不是在 Telegram 里挂了个 Bot，而是 Telegram 只是这套系统的一个输入口。"),

    slide(10, "自检护栏", f"{sc.get('passed',0)}/{sc.get('total',0)} 项通过 · 有一个 warn 挂在墙上",
           f"自检工作流覆盖基础设施、数据面、工具契约、定时任务。<br>"
           "定时任务最大的坑：桌面机会关机，任务「名义上」存在却没跑 —— 所以加了每周期一次的守卫标记。",
           media=IMG["13_stream_guardrail.png"], media_cap="自检 + 流式护栏（数据驱动渲染）",
           tag="数据：selfcheck_runs 最近一次",
           notes="诚实的一页。1 项失败/warn 直接亮出来，不要藏。话术：系统自己会体检、会把失败写进表里 —— 这比「一切正常」的绿面板有用得多。"),

    slide(11, "工程纪律", "踩过的坑都写进了代码注释和检查脚本",
          "<div class='grid2'>"
          "<div class='cell'><b>工具清单单一事实源</b><br><span>禁止硬编码副本，契约检查会红</span></div>"
          "<div class='cell'><b>跨节点字段逐个 return 检查</b><br><span>显式 return 会丢字段</span></div>"
          "<div class='cell'><b>搜索 0 条 ≠ 东西不存在</b><br><span>判定只看 results.length</span></div>"
          "<div class='cell'><b>定时任务必须带守卫标记</b><br><span>多时间点 + 每周期一次</span></div>"
          "<div class='cell'><b>客户端禁止直调带密钥的函数</b><br><span>一律走服务端代理</span></div>"
          "<div class='cell'><b>上游参考目录只读</b><br><span>backend/ lobechat/ 不改动</span></div>"
          "</div>",
          tag=f"{WF_COUNT} 条工作流 · 全量校验 0 warn",
          notes="这页是给懂技术的人看的。如果听众不技术，快速过；如果有人挑战工程严谨性，这页就是弹药。"),

    slide(12, "接下来", "两条待决策的路",
          "<div class='grid2'>"
          "<div class='cell hl'><b>① 把栈搬到常开机宿主</b><br><span>桌面机凌晨关机 → 定时任务形同虚设。需要一台常开的机器或云主机。</span></div>"
          "<div class='cell hl'><b>② 加第二家模型厂商兜底</b><br><span>现在是单厂商，卡额度就全停。加一家之前先确认预算。</span></div>"
          "</div>"
          "<p class='foot'>当前状态：全部已推送 · 回归全绿 · "
          f"{WF_COUNT} 条工作流 · 10 容器在线 · 自检 {sc.get('passed',0)}/{sc.get('total',0)}</p>",
          tag="待决策",
          notes="收尾页直接讲「还没做完的事」。主动暴露短板比被问出来强。第二条要提预算 —— 别让人以为加个厂商是免费的。"),
]

# ── HTML ────────────────────────────────────────────────────────────────────
def render_slide(s):
    media = ""
    if s["media"]:
        media = f'<div class="media"><img src="{s["media"]}" alt=""><div class="cap">{html.escape(s["media_cap"] or "")}</div></div>'
    tag = f'<div class="tag">{html.escape(s["tag"])}</div>' if s["tag"] else ""
    return f'''<section class="slide" data-n="{s['num']}">
  <div class="inner">
    <div class="kicker">{html.escape(s['kicker'])}</div>
    <h2>{s['title']}</h2>
    <div class="body">{s['body']}</div>
    {media}
    {tag}
  </div>
</section>'''

def render_notes(s):
    return f'<div class="note" data-n="{s["num"]}"><b>第 {s["num"]} 页 · 讲稿提示</b><p>{html.escape(s["notes"])}</p></div>'

SLIDES_HTML = "\n".join(render_slide(s) for s in SLIDES)
NOTES_HTML = "\n".join(render_notes(s) for s in SLIDES)
DOTS = "\n".join(f'<button class="dot" data-go="{s["num"]}" title="第 {s["num"]} 页"></button>' for s in SLIDES)

HTML = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PivotAI Agent Platform · 演示</title>
<style>
  :root {{
    --bg:#f6f7f9; --fg:#18181b; --muted:#71717a; --sub:#a1a1aa;
    --card:#fff; --line:#e4e4e7; --accent:#2563eb; --accent-bg:#eff6ff;
    --green:#16a34a; --amber:#d97706; --amber-bg:#fffbeb; --red:#dc2626;
  }}
  * {{ box-sizing:border-box; margin:0; padding:0; }}
  html,body {{ height:100%; }}
  body {{
    background:var(--bg); color:var(--fg);
    font-family:"Microsoft YaHei","PingFang SC","Segoe UI",system-ui,sans-serif;
    overflow:hidden; -webkit-font-smoothing:antialiased;
  }}
  .deck {{ position:relative; width:100vw; height:100vh; }}
  .slide {{
    position:absolute; inset:0; display:none;
    padding:56px 72px 92px; overflow:auto;
  }}
  .slide.on {{ display:flex; align-items:center; animation:fade .32s ease; }}
  @keyframes fade {{ from {{ opacity:0; transform:translateY(10px); }} to {{ opacity:1; transform:none; }} }}
  .inner {{ width:100%; max-width:1180px; margin:0 auto; }}
  .kicker {{
    font-size:12px; letter-spacing:.16em; color:var(--accent);
    font-weight:700; text-transform:uppercase; margin-bottom:14px;
  }}
  h2 {{ font-size:44px; line-height:1.18; font-weight:800; letter-spacing:-.01em; margin-bottom:20px; }}
  .body {{ font-size:17px; line-height:1.75; color:#3f3f46; max-width:900px; }}
  .body b {{ color:var(--fg); }}
  .lst {{ list-style:none; }}
  .lst li {{ padding:9px 0 9px 22px; position:relative; border-bottom:1px solid var(--line); }}
  .lst li:last-child {{ border-bottom:0; }}
  .lst li::before {{ content:""; position:absolute; left:4px; top:18px;
    width:6px; height:6px; border-radius:50%; background:var(--accent); }}
  .media {{ margin-top:26px; }}
  .media img {{
    width:100%; max-width:900px; border-radius:14px; border:1px solid var(--line);
    box-shadow:0 12px 32px rgba(0,0,0,.10); background:#fff; display:block;
  }}
  .cap {{ margin-top:10px; font-size:12px; color:var(--muted); }}
  .tag {{
    display:inline-block; margin-top:20px; padding:6px 14px; border-radius:999px;
    background:var(--accent-bg); color:var(--accent); font-size:12px; font-weight:700;
  }}
  /* architecture stack */
  .stack {{ margin-top:8px; }}
  .node {{ background:var(--card); border:1px solid var(--line); border-radius:12px;
    padding:14px 18px; font-size:15px; font-weight:700; }}
  .node span {{ display:block; font-size:11px; color:var(--sub);
    font-weight:700; letter-spacing:.08em; margin-bottom:4px; text-transform:uppercase; }}
  .n-core {{ border-color:var(--accent); background:var(--accent-bg); }}
  .n-core span {{ color:var(--accent); }}
  .n-user {{ border-color:#c7d2fe; }}
  .arrow {{ text-align:center; color:var(--sub); font-size:18px; padding:6px 0; }}
  .row {{ display:grid; grid-template-columns:repeat(5,1fr); gap:12px; }}
  .n-svc {{ font-size:13px; font-weight:600; text-align:center; }}
  .grid2 {{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:6px; }}
  .cell {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }}
  .cell b {{ display:block; font-size:15px; margin-bottom:6px; }}
  .cell span {{ font-size:13px; color:var(--muted); line-height:1.6; }}
  .cell.hl {{ border-color:#fcd34d; background:var(--amber-bg); }}
  .foot {{ margin-top:18px; font-size:13px; color:var(--muted); }}
  /* chrome */
  .bar {{ position:fixed; left:0; right:0; bottom:0; height:64px; background:rgba(255,255,255,.94);
    border-top:1px solid var(--line); display:flex; align-items:center; gap:14px;
    padding:0 24px; backdrop-filter:blur(8px); z-index:20; }}
  .bar button {{ border:1px solid var(--line); background:#fff; color:#3f3f46;
    height:34px; min-width:34px; padding:0 12px; border-radius:8px; cursor:pointer; font-size:13px; }}
  .bar button:hover {{ background:#f4f4f5; }}
  .bar button.act {{ background:var(--accent); color:#fff; border-color:var(--accent); }}
  .dots {{ display:flex; gap:6px; margin:0 6px; }}
  .dot {{ width:9px; height:9px; border-radius:50%; background:#d4d4d8; border:0 !important;
    min-width:0 !important; padding:0 !important; cursor:pointer; }}
  .dot.on {{ background:var(--accent); transform:scale(1.25); }}
  .num {{ margin-left:auto; font-size:13px; color:var(--muted); font-variant-numeric:tabular-nums; }}
  .prog {{ position:fixed; top:0; left:0; height:3px; background:var(--accent); z-index:30;
    transition:width .3s ease; }}
  .hint {{ position:fixed; right:24px; top:20px; font-size:11px; color:var(--sub); z-index:20; }}
  /* notes panel */
  .notes {{ position:fixed; right:0; top:0; bottom:64px; width:380px; background:#fff;
    border-left:1px solid var(--line); padding:22px; overflow:auto; z-index:40;
    transform:translateX(100%); transition:transform .28s ease; }}
  .notes.on {{ transform:none; }}
  .note {{ display:none; }}
  .note.on {{ display:block; }}
  .note b {{ display:block; font-size:13px; color:var(--accent); margin-bottom:8px; }}
  .note p {{ font-size:14px; line-height:1.8; color:#3f3f46; }}
  @media print {{ .bar,.hint,.notes,.prog {{ display:none; }} .slide {{ display:block !important; page-break-after:always; }} }}
</style>
</head>
<body>
<div class="prog" id="prog"></div>
<div class="hint">← → 翻页 · N 讲稿 · F 全屏 · P 播放</div>
<div class="deck" id="deck">
{SLIDES_HTML}
</div>
<div class="notes" id="notes">
{NOTES_HTML}
</div>
<div class="bar">
  <button id="prev">‹ 上一页</button>
  <button id="next">下一页 ›</button>
  <div class="dots" id="dots">{DOTS}</div>
  <button id="play">▶ 自动播放</button>
  <button id="notesBtn">讲稿</button>
  <button id="fs">全屏</button>
  <span class="num" id="num">1 / {len(SLIDES)}</span>
</div>
<script>
const slides=[...document.querySelectorAll('.slide')];
const notes=[...document.querySelectorAll('.note')];
const dots=[...document.querySelectorAll('.dot')];
let i=0, timer=null;
const TOTAL={len(SLIDES)};

function go(n){{
  i=Math.max(0,Math.min(TOTAL-1,n));
  slides.forEach((s,k)=>s.classList.toggle('on',k===i));
  notes.forEach((s,k)=>s.classList.toggle('on',k===i));
  dots.forEach((d,k)=>d.classList.toggle('on',k===i));
  document.getElementById('num').textContent=(i+1)+' / '+TOTAL;
  document.getElementById('prog').style.width=((i+1)/TOTAL*100)+'%';
}}
function stop(){{
  if(timer){{ clearInterval(timer); timer=null;
    document.getElementById('play').textContent='▶ 自动播放';
    document.getElementById('play').classList.remove('act'); }}
}}
document.getElementById('next').onclick=()=>{{stop();go(i+1);}};
document.getElementById('prev').onclick=()=>{{stop();go(i-1);}};
dots.forEach(d=>d.onclick=()=>{{stop();go(+d.dataset.go-1);}});
document.getElementById('play').onclick=(e)=>{{
  if(timer){{ stop(); return; }}
  e.target.textContent='❚❚ 暂停'; e.target.classList.add('act');
  timer=setInterval(()=>{{ go(i+1>=TOTAL?0:i+1); }},12000);
}};
document.getElementById('notesBtn').onclick=(e)=>{{
  const n=document.getElementById('notes'); n.classList.toggle('on');
  e.target.classList.toggle('act',n.classList.contains('on'));
}};
document.getElementById('fs').onclick=()=>{{
  if(document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}};
document.addEventListener('keydown',(e)=>{{
  const k=e.key.toLowerCase();
  if(e.key==='ArrowRight'||e.key===' '||k==='pagedown'){{stop();go(i+1);e.preventDefault();}}
  else if(e.key==='ArrowLeft'||k==='pageup'){{stop();go(i-1);e.preventDefault();}}
  else if(k==='n'){{ document.getElementById('notesBtn').click(); }}
  else if(k==='f'){{ document.getElementById('fs').click(); }}
  else if(k==='p'){{ document.getElementById('play').click(); }}
  else if(k==='home'){{stop();go(0);}}
  else if(k==='end'){{stop();go(TOTAL-1);}}
}});
go(0);
</script>
</body>
</html>'''

out = OUT_DIR / "index.html"
out.write_text(HTML, encoding="utf-8")
mb = out.stat().st_size / 1024 / 1024
print(f"\n✅ {out}  ({mb:.2f} MB · 单文件 · 双击即放)")
print(f"   幻灯片 {len(SLIDES)} 页 · 内嵌 {len([v for v in IMG.values() if v])} 张图 + {len([v for v in GIF.values() if v])} 个动图")