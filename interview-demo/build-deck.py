#!/usr/bin/env python3
"""Build the interview deck from the live screenshots in interview-demo/实机截图/.

Self-contained output: every image is base64-embedded, so the deck plays by
double-clicking it. Re-run after re-capturing screenshots.
"""
import base64
from pathlib import Path

ROOT = Path(r"C:\Users\13682\Desktop\agent-platform-main")
SHOTS = ROOT / "interview-demo" / "实机截图"
ASSETS = ROOT / "interview-demo" / "测试素材"
OUT = ROOT / "interview-demo"
OUT.mkdir(exist_ok=True)


def b64(name):
    p = SHOTS / name
    if not p.exists():
        print(f"  !! missing {name}")
        return ""
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()


def datauri(name, mime):
    """Embed a test asset (audio / photo) so the deck stays a single file."""
    p = ASSETS / name
    if not p.exists():
        print(f"  !! missing asset {name}")
        return ""
    return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()


IMG = {n: b64(n) for n in [
    "01_overview.png", "02_ai_chat.png", "02_ai_chat_empty.png",
    "03_knowledge.png", "04_keys.png", "05_models.png",
    "06_people.png", "07_alerts.png", "09_workflows.png", "10_docs.png",
    "20_n8n_workflows.png", "21_n8n_chat_gateway.png", "22_n8n_mcp_server.png",
    "23_lobe_pivot_themed.png",
    "30_briefs.png", "32_settings.png",
    "41_telegram_bridge.png",
    "50_alerts_fired.png", "51_topics_watch.png",
    "53_overview_alert.png", "60_upload_product.png",
]}
print("embedded:", sum(1 for v in IMG.values() if v), "images")

VOICE_WAV = datauri("语音测试.wav", "audio/wav")
TEST_PHOTO = datauri("图片测试-输入.jpg", "image/jpeg")
print("embedded audio:", 1 if VOICE_WAV else 0,
      "| test photo:", 1 if TEST_PHOTO else 0)


def shot(key, cap, tall=False, small=False):
    cls = "shot" + (" tall" if tall else "") + (" small" if small else "")
    return (f'<figure class="{cls}"><img src="{IMG[key]}" alt="{cap}">'
            f'<figcaption>{cap}</figcaption></figure>')


ARCH = """<div class="arch"><svg viewBox="0 0 1080 430" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,Segoe UI,sans-serif">
  <defs><marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="#5b6b8c"/></marker></defs>
  <text x="14" y="30" fill="#8ea0c0" font-size="12">入口</text>
  <text x="14" y="150" fill="#8ea0c0" font-size="12">前端</text>
  <text x="14" y="262" fill="#8ea0c0" font-size="12">模型网关</text>
  <text x="14" y="348" fill="#8ea0c0" font-size="12">数据/能力</text>
  <rect x="330" y="12" width="200" height="34" rx="8" fill="#1e2a44" stroke="#3d5277"/>
  <text x="430" y="34" fill="#dce6f7" font-size="13" text-anchor="middle">浏览器 / 手机</text>
  <rect x="600" y="12" width="240" height="34" rx="8" fill="#22304d" stroke="#4a6389"/>
  <text x="720" y="34" fill="#dce6f7" font-size="13" text-anchor="middle">Caddy · TLS 8443-8446</text>
  <line x1="530" y1="29" x2="596" y2="29" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="70" y="86" width="200" height="48" rx="9" fill="#1b3a2e" stroke="#2f6b52"/>
  <text x="170" y="107" fill="#d6f2e4" font-size="13" text-anchor="middle" font-weight="600">控制台 (frontent)</text>
  <text x="170" y="124" fill="#8fbfa8" font-size="11" text-anchor="middle">Next.js + Clerk · :3001</text>
  <rect x="300" y="86" width="200" height="48" rx="9" fill="#16323c" stroke="#2c6b7d"/>
  <text x="400" y="107" fill="#d5f2fa" font-size="13" text-anchor="middle" font-weight="600">对话前台 · PivotAI</text>
  <text x="400" y="124" fill="#8ec3d1" font-size="11" text-anchor="middle">基于 LobeChat 定制 · :3210</text>
  <rect x="530" y="86" width="180" height="48" rx="9" fill="#2a2440" stroke="#574a86"/>
  <text x="620" y="107" fill="#e6e0ff" font-size="13" text-anchor="middle" font-weight="600">n8n 编辑器</text>
  <text x="620" y="124" fill="#a79ddb" font-size="11" text-anchor="middle">24 条工作流 · :5678</text>
  <rect x="740" y="86" width="180" height="48" rx="9" fill="#2b2330" stroke="#6a4a70"/>
  <text x="830" y="107" fill="#f0dff4" font-size="13" text-anchor="middle" font-weight="600">RustFS 控制台</text>
  <text x="830" y="124" fill="#bd9cc4" font-size="11" text-anchor="middle">对象存储 · :9002</text>
  <line x1="170" y1="46" x2="170" y2="82" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="400" y1="46" x2="400" y2="82" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="620" y1="46" x2="620" y2="82" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="830" y1="46" x2="830" y2="82" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="250" y="196" width="420" height="46" rx="9" fill="#1d2f4d" stroke="#3f6ea8" stroke-width="1.6"/>
  <text x="460" y="217" fill="#d9e8ff" font-size="13.5" text-anchor="middle" font-weight="600">stream-bridge · OpenAI 兼容统一网关 :3211</text>
  <text x="460" y="233" fill="#8fb2dd" font-size="11" text-anchor="middle">换模型不改调用方 · 流式/非流式 · 向量化 · 语音</text>
  <line x1="170" y1="134" x2="330" y2="192" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="400" y1="134" x2="420" y2="192" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="620" y1="134" x2="560" y2="192" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="330" y="288" width="260" height="44" rx="9" fill="#3a2418" stroke="#8a5a34"/>
  <text x="460" y="308" fill="#ffe3cf" font-size="13" text-anchor="middle" font-weight="600">n8n Webhook 网关</text>
  <text x="460" y="324" fill="#c9a184" font-size="11" text-anchor="middle">15 个工具 · MCP 17 个工具</text>
  <line x1="460" y1="242" x2="460" y2="284" stroke="#5b6b8c" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="30" y="356" width="230" height="52" rx="9" fill="#22303f" stroke="#4a6b85"/>
  <text x="145" y="377" fill="#dbeaf5" font-size="12.5" text-anchor="middle" font-weight="600">Postgres 17 + pgvector</text>
  <text x="145" y="394" fill="#93b3c9" font-size="10.5" text-anchor="middle">pg_cron · 24 张数据表 · 向量检索</text>
  <rect x="280" y="356" width="180" height="52" rx="9" fill="#22303f" stroke="#4a6b85"/>
  <text x="370" y="377" fill="#dbeaf5" font-size="12.5" text-anchor="middle" font-weight="600">RustFS</text>
  <text x="370" y="394" fill="#93b3c9" font-size="10.5" text-anchor="middle">S3 兼容对象存储</text>
  <rect x="480" y="356" width="200" height="52" rx="9" fill="#22303f" stroke="#4a6b85"/>
  <text x="580" y="377" fill="#dbeaf5" font-size="12.5" text-anchor="middle" font-weight="600">SearXNG</text>
  <text x="580" y="394" fill="#93b3c9" font-size="10.5" text-anchor="middle">自建聚合搜索 :8081</text>
  <rect x="700" y="356" width="200" height="52" rx="9" fill="#22303f" stroke="#4a6b85"/>
  <text x="800" y="377" fill="#dbeaf5" font-size="12.5" text-anchor="middle" font-weight="600">n8n-sandbox</text>
  <text x="800" y="394" fill="#93b3c9" font-size="10.5" text-anchor="middle">代码执行隔离</text>
  <rect x="920" y="356" width="140" height="52" rx="9" fill="#2a2a2a" stroke="#5a5a5a"/>
  <text x="990" y="377" fill="#e6e6e6" font-size="12.5" text-anchor="middle" font-weight="600">platform-backup</text>
  <text x="990" y="394" fill="#a0a0a0" font-size="10.5" text-anchor="middle">定时备份</text>
  <line x1="420" y1="332" x2="200" y2="352" stroke="#5b6b8c" stroke-width="1.4" marker-end="url(#a)"/>
  <line x1="440" y1="332" x2="380" y2="352" stroke="#5b6b8c" stroke-width="1.4" marker-end="url(#a)"/>
  <line x1="480" y1="332" x2="560" y2="352" stroke="#5b6b8c" stroke-width="1.4" marker-end="url(#a)"/>
  <line x1="510" y1="332" x2="780" y2="352" stroke="#5b6b8c" stroke-width="1.4" marker-end="url(#a)"/>
</svg></div>"""

SLIDES = []

SLIDES.append(("封面", "", """
<div class="cover">
  <div class="badge">本机全栈 · 实机演示</div>
  <h1>Agent 协作平台</h1>
  <p class="lead">一个人也能运维的私有 Agent 平台：<b>n8n 编排 + 两个自建前端 + 统一模型网关</b></p>
  <div class="kpis">
    <div><b>10</b><span>容器</span></div>
    <div><b>24</b><span>工作流</span></div>
    <div><b>47</b><span>自检项</span></div>
    <div><b>17</b><span>MCP 工具</span></div>
    <div><b>3879</b><span>累计执行</span></div>
  </div>
  <p class="foot">以下每一张界面截图，都采集自这台机器上正在运行的实例。</p>
</div>
""", "开场先给结论：这不是 PPT 画的架构图，是一个真跑起来的系统。所有截图都来自本机运行实例，随时可以现场复现。"))

SLIDES.append(("可信度声明", "为什么先讲这个", """
<h2>先说清楚：哪些是实拍，哪些不是</h2>
<div class="cols">
  <div class="col">
    <h3 class="bad">仓库自带演示包的真实情况</h3>
    <ul>
      <li>10 张 PNG 里只有 <b>5 张是实机截图</b>，其中 <b>3 张还是登录页</b></li>
      <li><b>4 张是数据驱动合成渲染</b>（PIL 画的），1 张是实拍+后期合成</li>
      <li>5 个 GIF <b>全是后期动效</b>，不是产品录屏</li>
      <li>没有一张登录后的 n8n 原生画布，也没有一张登录后的对话实拍</li>
      <li>作者自己的采集脚本登录 n8n 失败过 —— 前后两张截图字节数完全一致</li>
    </ul>
  </div>
  <div class="col">
    <h3 class="good">本次演示的做法</h3>
    <ul>
      <li>全部 <b>重新实机采集</b>，不用仓库里的合成图</li>
      <li>通过 Clerk 后端 API 签发登录票据，<b>真的登进了控制台</b></li>
      <li>用 n8n 管理员账号，<b>真的进了编辑器</b>并截到了画布</li>
      <li>在控制台聊天页<b>真发了一条消息</b>，截到真实的思考过程与回答</li>
      <li>把 PivotAI 主题<b>真的注入进 LobeChat 容器</b>并验证生效</li>
      <li>把「能力就绪但没跑过」的 <b>10 项功能全部真跑一遍</b>（见「功能全景 ⑩」），
          每项都在数据库里留下真实运行痕迹，不是造一条假记录</li>
    </ul>
  </div>
</div>
<p class="note">面试时最容易被问倒的不是「你做了什么」，而是「这个图是真的吗」。我先把边界划清楚。</p>
""", "这是全场最重要的铺垫。仓库作者自己写了一份《截图真实性清单》，承认大部分交付图是合成的。我不沿用它们，而是重新实拍。面试官如果去核对，每一张都经得起查。"))

SLIDES.append(("问题与定位", "为什么做", """
<h2>要解决的问题</h2>
<div class="cards3">
  <div class="card"><h4>知识散落</h4><p>笔记、待办、会议纪要、告警散在四五个工具里，没有一个统一的入口能被「问」。</p></div>
  <div class="card"><h4>自动化门槛高</h4><p>想搭一套「收到消息→查知识库→调工具→回写」的链路，传统做法要写一个后端服务。</p></div>
  <div class="card"><h4>模型与数据要自己掌控</h4><p>不想把私域数据交给第三方 SaaS，又要能随时换模型、看成本。</p></div>
</div>
<h3>所以这套平台的定位</h3>
<ul class="tight">
  <li><b>编排层用 n8n</b>：24 条工作流就是 24 个可独立部署、可观测、可重放的能力单元</li>
  <li><b>两个前端，面向两类人</b>：给用户的是对话前台（LobeChat 定制成 PivotAI）；给运维的是自建控制台</li>
  <li><b>模型层收口</b>：所有请求过一个 OpenAI 兼容网关，换模型不改调用方</li>
  <li><b>数据留在本机</b>：Postgres + 对象存储 + 自建检索，全在本地 Docker 里</li>
</ul>
""", "先讲问题再讲方案。注意我强调的不是「用了什么技术」，而是「把哪三件事变简单了」。另外要主动说清：前端有两个，面向的人不一样。"))

SLIDES.append(("架构总览", "10 个容器怎么拼起来", """
<h2>架构总览</h2>
@@ARCH@@
<p class="note">关键设计：<b>入口层全部是「可选的」</b>。Caddy 只是加了一层 TLS 与统一域名，停掉它原有端口照常可用；控制台和对话前台都只是 n8n 的客户端，彼此不互相调用。</p>
""", "讲架构要讲取舍。最大的取舍是：不自研编排引擎，直接站在 n8n 上；但前端要自己做（或定制），因为面向人的交互是产品差异化的地方。"))

SLIDES.append(("功能全景 ①", "一张表看懂能力面", """
<h2>功能全景：一张表看懂能力面</h2>
<table>
  <tr><th>能力域</th><th>覆盖什么</th><th>证据来源</th></tr>
  <tr>
    <td>对话与工具</td>
    <td>15 个网关工具：检索 / 待办 / 提醒 / 平台遥控 / 代码沙箱 / 出向 MCP</td>
    <td>实测 <code>/healthz</code></td>
  </tr>
  <tr>
    <td>多模态输入</td>
    <td>语音双向（识别 + 合成）、图片视觉，LobeHub 与 Telegram 双入口</td>
    <td class="good">网关实测</td>
  </tr>
  <tr>
    <td>定时与推送</td>
    <td>晨报 08:30 / 周报周日 20:00 / 动态监控 21:00 / 提醒每分钟巡检</td>
    <td>控制台实拍</td>
  </tr>
  <tr>
    <td>工具与沙箱</td>
    <td>run_python（rlimits + 人工审批）、出向 MCP、L2 点火权、企业工作包</td>
    <td>审计表实数据</td>
  </tr>
  <tr>
    <td>治理与可观测</td>
    <td>幂等、tool_trace、多 Key 限流、数据保留、额度与错误率告警</td>
    <td>控制台实拍 + 表数据</td>
  </tr>
  <tr>
    <td>控制台</td>
    <td>13 个真实路由（另有 6 个脚手架页尚未清理）</td>
    <td>实拍 + 路由核对</td>
  </tr>
  <tr>
    <td>运维与工程化</td>
    <td>定时备份 + 完整性校验、心跳上报、24 条工作流源码化、CI 双 job、对象存储</td>
    <td>产物 + 表数据</td>
  </tr>
</table>
<p class="note">证据分四档：<b class="good">端到端实测</b> / <b>控制台实拍</b> / <b>真实数据表</b> / <b>仅源码与端点</b>。凡只有源码、没有运行数据的，后面几页我都会明确标出来 —— 不拿「代码里有」冒充「跑起来了」。</p>
""", "这一页是给面试官建立索引：后面 8 页逐行展开。重点是第三列——我把每一项的证据等级都标了。这样被追问「这个你实际用过吗」时，我能直接答上来，而不是含糊过去。"))

SLIDES.append(("功能全景 ②", "对话能力：语音 / 图片 / 待办 / 记忆 / 提醒", """
<h2>对话能力：说一句就能用</h2>
<div class="cols">
  <div class="col">
    <h3>网关向模型暴露的 15 个工具（实测 <code>/healthz</code>）</h3>
    <ul class="tight">
      <li>检索：<code>web_search</code> · <code>kb_search</code></li>
      <li>平台遥控：<code>platform_status</code> · <code>run_brief</code> · <code>list_alerts</code> · <code>kb_save</code></li>
      <li>提醒：<code>create_reminder</code> · <code>list_reminders</code> · <code>cancel_reminder</code></li>
      <li>待办：<code>todo_add</code> · <code>todo_list</code> · <code>todo_done</code></li>
      <li>沙箱 / 出向：<code>run_python</code> · <code>mcp_list_tools</code> · <code>mcp_call</code></li>
    </ul>
    <p class="note">「记一下周五交房租」·「1 分钟后提醒我喝杯水」·「平台现在怎么样？」—— 都是真实注册的工具，不是我描述的能力。</p>
  </div>
  <div class="col">
    <h3>语音与图片（stream-bridge 侧车）</h3>
    <ul class="tight">
      <li><b>语音进</b>：TG 语音 → <code>/voice/transcribe</code>（qwen3-asr-flash）→ 文本进全链路，记忆与工具照常生效</li>
      <li><b>语音出</b>：回复 → <code>/voice/reply</code>（qwen-tts，音色 Cherry）→ <code>sendVoice</code>；超 900 字自动降级文字</li>
      <li><b>图片</b>：LobeHub / TG 发图 → 本地 <code>:3210</code>/<code>:9000</code> 的 URL 内联成 base64 → 上游视觉作答</li>
    </ul>
    <h3>这里我要如实说</h3>
    <ul class="tight">
      <li>待办 <b>3 条</b>、提醒 <b>1 条</b> —— 有真实数据</li>
      <li>语音 / 图片：<b class="good">已端到端跑通</b>，下一页音频可以直接点播放</li>
      <li>记忆：<b class="good">已跑通</b> —— 从一轮真实对话提取到 <b>2 条</b>长期偏好（<code>source=tg-extract</code>），
          并<b>双向镜像</b>进 LobeHub 的 <code>user_memories</code>；语义检索命中 <b>score 0.71</b></li>
    </ul>
  </div>
</div>
""", "这页补的是「你做了什么功能」。左边是硬证据（15 个工具名是实测抓的）；右边主动交代哪些还没数据。面试官更信这种——把边界说清楚的人，说「这个能用」才可信。这轮把记忆那条从「0 条」跑成了 2 条：不是手工插库，是拿一轮真实对话过提取器，DeepSeek 判定值得长期记住的偏好，落本机 pgvector 库并镜像到 LobeHub 表，再用自然语言问回来能命中——整条记忆闭环都通了。"))

SLIDES.append(("功能全景 ③", "定时任务与推送", f"""
<h2>定时任务与推送：不靠人盯</h2>
<div class="two">
  {shot("30_briefs.png", "晨报页 · 本机实拍（含真实检索结果）", small=True)}
  {shot("51_topics_watch.png", "动态监控页 · 本机实拍（已加关键词并真扫描过）", small=True)}
</div>
<div class="grid2">
  <div><b>08:30</b><span>晨报 Daily Brief</span></div>
  <div><b>04:15</b><span>平台自检</span></div>
  <div><b>03:00</b><span>数据保留清理</span></div>
  <div><b>周日 20:00</b><span>周报 Weekly Review</span></div>
</div>
<p class="note">另有：提醒巡检<b>每分钟</b>、错误率告警<b>每 15 分钟</b>、动态监控<b>每天 21:00</b>、备份心跳每日上报。
推送统一走 Notify 出口（飞书 / 企微 / Slack / Telegram），推送体可带 <b>inline 按钮</b>（待办"已完成"、提醒"1 小时后再响"）点完写回原行。
<b>触达渠道两个页面口径不一致</b>：Settings 页报 <code>webhook_configured=false</code>（没配 <code>ALERT_WEBHOOK_URL</code>），
但告警页显示<b>已配置（format: telegram）</b> —— 告警实际走的是 Telegram 分支，而且<b>实测真的送达了</b>（<code>delivered=ok</code>）。
同一件事两个页面给出相反答案，已记入「已知问题」。</p>
""", "这页讲「平台自己会动」。晨报那张是真实生成的，里面的新闻是真实检索结果。这里有个我主动挑出来的不一致：Settings 页说渠道没配，告警页说配了，而实测告警是真送达的——说明是 Settings 的判断口径漏了 Telegram 分支。主动说出来比被问出来好。"))

SLIDES.append(("功能全景 ④", "工具与沙箱：边界是硬的", """
<h2>工具与沙箱：模型能动手，但边界是硬的</h2>
<div class="cards2">
  <div class="card">
    <h4>run_python 代码沙箱</h4>
    <p>独立容器、<b>不对宿主机发布端口</b>；每次执行前设 rlimits（CPU / 512M 内存 / 16M 文件 / 64 fd）+ 墙钟超时 + 8KB 输出上限。
    <b>默认拒绝</b>联网、起子进程、动态执行、写文件，并返回人类可读的理由。</p>
  </div>
  <div class="card">
    <h4>被拦下的代码走人工审批</h4>
    <p>登记 <code>sha256(代码)</code> + 理由 + 15 分钟 TTL → 推给机主「允许执行一次 / 拒绝」→ 批准后由桥接<b>直接执行</b>，不等模型重试。
    批准绑定的就是真正会跑的那段代码。</p>
  </div>
  <div class="card">
    <h4>出向 MCP</h4>
    <p>平台不只是 MCP Server，还能作为客户端连别人的 MCP：<code>mcp_list_tools</code> / <code>mcp_call</code>。
    外部工具列表被当成<b>不可信输入</b> —— 模型读到疑似注入的描述会主动提示，不会照其描述执行。</p>
  </div>
  <div class="card">
    <h4>L2 自建流程工具</h4>
    <p>把你在 n8n 里亲手搭的 POST Webhook 注册成对话工具，说「跑一下 XX」即可点火。
    AI 只有<b>点火权</b>：不能建、不能改、不能删流程。另有会议行动项 / 智能摘要 / 动态监控三个企业工作包。</p>
  </div>
</div>
<p class="note">真实数据：审计表 <code>admin_audit</code> 里 <b>run_python 3 次</b>（全部放行，如「Compute 12345 × 6789」）、<b>mcp.call 15 次</b>、people.create 1 次。
这轮把三个空表补上了：<code>sandbox_approvals</code> <b>1 条</b>（pending —— 让模型跑联网代码，真被网关拦下并登记 <code>sha256(代码)+理由</code>）、
<code>workflow_tools</code> <b>1 条</b>（注册了 <code>echo-demo</code>）、<code>mcp_servers</code> <b>1 条</b>
（把平台自己的 <code>/webhook/mcp</code> 注册成外部服务器，<code>mcp_list_tools</code> 真返回 <b>17 个工具</b>）。详见「功能全景 ⑩」。</p>
""", "这页是全套里工程含量最高的。要讲清「边界」：静态扫描只是减速带，真正的边界是容器 + rlimits；想联网必须显式提出来由人决定。这轮我把审批通道真的触发了一次——让模型跑联网代码，它被拦下并登记成 pending，模型自己也会告诉用户「系统已把审批推给机主，批准后我用一字不差的同一段代码重跑」。出向 MCP 也真跑了：注册的是平台自己的 MCP 端点，mcp_list_tools 返回 17 个工具，说明自己连自己的链路是通的。"))

SLIDES.append(("功能全景 ⑤", "治理与可观测", f"""
<h2>治理与可观测：出问题能查到哪一步</h2>
<div class="cols" style="grid-template-columns:1.1fr 1fr">
  <div class="col">
    {shot("32_settings.png", "Settings 页 · 本机实拍（告警阈值 / 嵌入额度 / 保留策略）")}
  </div>
  <div class="col">
    <h3>四个机制</h3>
    <ul class="tight">
      <li><b>请求级幂等</b>：显式 <code>X-Idempotency-Key</code> + 隐式 <code>session + 工具 + sha256(args)</code>，
          只保护副作用工具。防的是「客户端超时重发 → 一句『记一下买牛奶』变成两条待办」</li>
      <li><b>tool_trace</b>：每轮每次工具调用都记 <code>round / tool / ms / ok / replayed / idem / args</code>，
          排障时一眼分清是「模型没调工具」「工具报错」还是「被幂等折叠」</li>
      <li><b>多 Key 与限流</b>：托管 key 哈希存储、可单独吊销、60 秒滚动窗口，超限返回 429</li>
      <li><b>数据保留</b>：消息 30 天 / 执行记录 90 天 / 幂等记录 7 天，每日 3:00 先 dryRun 计数再真删</li>
    </ul>
  </div>
</div>
<p class="note">真实数据：<code>chat_executions</code> <b>255 行</b>（含 tool_trace）、<code>idempotency_records</code> <b>2 条</b>（都是显式 key 折叠的 <code>todo_add</code>）、<code>gateway_keys</code> 1 个、
<code>ops_alerts</code> <b>1 条</b>（错误率告警真触发且 <code>delivered=ok</code>，见「功能全景 ⑪」）。
诚实标注：隐式幂等与限流 429 <b>尚未被真实触发过</b>；成本告警同样没触发过 —— 24 小时只花了 $0.0073，阈值是 $2。</p>
""", "这页证明「不是能跑就行」。左图是真实配置页，右边四个机制每个都指得出表。特别值得说的是 tool_trace——以前只知道「用了几轮」，出了问题只能猜；现在每一轮每次调用都有痕迹。这轮还把告警链路整条跑通了：真造错误率、真越阈值、真落库、真投递，单独用一页讲（功能全景 ⑪）。"))

SLIDES.append(("功能全景 ⑥", "语音与图片：端到端实测", f"""
<h2>语音与图片：不是「代码里有」，是刚跑过</h2>
<div class="cols" style="grid-template-columns:1.02fr 1fr">
  <div class="col">
    <h3>语音 · 双向链路都通了</h3>
    <ul class="tight">
      <li><b>出</b>：文本 → <code>/voice/reply</code> → qwen-tts（音色 Cherry）→ <code>sendVoice</code>，
          实测返回 <code>HTTP 200 {{"ok":true,"mode":"voice"}}</code>，真的发到了 Telegram</li>
      <li><b>进</b>：同一段音频回灌 qwen3-asr-flash → 文本与原文<b>相似度 0.830</b></li>
    </ul>
    <div class="audio">
      <span class="lbl">▶ 实测音频</span>
      <audio controls preload="metadata" src="{VOICE_WAV}"></audio>
    </div>
    <p class="note" style="margin-top:8px">16 kHz 单声道 · 15.2 秒 · 728,684 字节。就是上面那次 <code>/voice/reply</code> 的返回值，直接嵌在 HTML 里。</p>
  </div>
  <div class="col">
    <h3>图片 · 网上找一张，喂给平台网关</h3>
    <figure class="photo"><img src="{TEST_PHOTO}" alt="图片测试输入">
      <figcaption>测试输入 · Wikimedia 猫图（送入模型的是原图，此处仅 CSS 裁切展示）</figcaption></figure>
    <div class="quote">模型原话：<b>「图里是一只橘色虎斑猫（橘猫）的头部特写，<u>背景虚化处能看到一根红色管子状物体</u>和浅灰色地面。它的状态是清醒且警觉 —— 双耳竖起、胡须向前张开，琥珀色眼睛睁大盯向画面右侧偏上方。」</b></div>
  </div>
</div>
<p class="note"><b>为什么「红色管子」这句是重点</b>：那是背景里虚化的一根杂物，没真看到图是编不出来的 —— 这比「认出是猫」更能证明视觉真的通了。
调用的是<b>平台自己的网关</b> <code>/webhook/v1/chat/completions</code>，model=<code>deepseek-v4-flash</code>，图片以 base64 data URI 放进 content 数组，和对话前台发图走同一条路；实测 <code>usage.prompt_tokens: 3557</code>。<br>
两个诚实标注：① 自建控制台的 Playground 是<b>纯文本</b>的（无上传/粘贴），所以图只能从对话前台或 Telegram 进；② <code>/voice/transcribe</code> 与 <code>/image/fetch</code> 只接受 Telegram <code>file_id</code>，没有直接传原始文件的 HTTP 口。</p>
""", "这是全场的转折点：面试官最容易怀疑「语音图片是不是只是写了代码」。所以我现场跑了两条——语音合成后用识别回灌比对（相似度 0.83），图片找网图直接喂平台网关。音频就嵌在这一页，点一下就能听。图片如果被追问「会不会是模型编的」，就指背景那根红色管子：虚化杂物，没真看到图编不出来。补充一句实话：同一个问题我跑过两次，措辞不同（网关会带上该会话的历史），但「橘猫 + 红管 + 眼神方向」两次都稳定说对。另外把「为什么控制台测不了图」讲清楚：是控制台 Playground 纯文本，不是平台不支持。"))

SLIDES.append(("功能全景 ⑦", "Telegram 双向入口", f"""
<h2>Telegram：一个真的能用的双向入口</h2>
<div class="cols" style="grid-template-columns:1.06fr 1fr">
  <div class="col">{shot("41_telegram_bridge.png", "telegram-bridge 工作流 · 本机实拍（真实 n8n 画布）")}</div>
  <div class="col">
    <h3>两条链路，不是一条</h3>
    <ul class="tight">
      <li><b>入向</b>：Webhook → Auth 校验 → 分流（异常走 Respond Error）→ 进对话网关；文本与语音都收</li>
      <li><b>出向</b>：Schedule Poll 轮询 → Bridge → Respond —— 主动推送不依赖 webhook 回包</li>
    </ul>
    <h3>几个不显眼但必要的设计</h3>
    <ul class="tight">
      <li><b>Auth 前置</b>：未授权请求在第一个 Code 节点就被挡掉，不进模型、不花 token</li>
      <li><b>错峰锁</b>：<code>telegram_state.lock_ts</code> 防轮询重叠（已写 400+ 次）</li>
      <li><b>断点续拉</b>：<code>last_update_id</code> 持久化，重启不丢消息（当前 424322547）</li>
      <li><b>inline 按钮</b>：推送带「已完成 / 1 小时后再响」，点完写回原数据行</li>
    </ul>
  </div>
</div>
<p class="note">运行痕迹（<b>以库和运行痕迹为准</b>）：24 条工作流全部 <code>active=t</code>；<code>telegram_state.lock_ts</code> 持续被轮询循环写入（我核对时距上次写入仅 62 秒），<code>last_update_id</code> 已推进到 <code>424322547</code>。<br>
一个真实的坑：<b>上面这张截图里，画布右上角显示 Inactive、还弹了「Schedule Poll is not running」</b> —— 而同一时刻库里是 active、轮询锁刚写过，属于编辑器侧的显示滞后。
所以判据是：<b>工作流有没有在跑，看库和运行痕迹，不看画布徽标。</b></p>
""", "这一页讲「双入口」里的第二个入口。要强调的是入向和出向是两套机制：入向靠 webhook，出向靠轮询——因为主动推送的时候没有请求可以回包。另外 Auth 前置这一点值得说，它决定了「别人拿到 webhook 地址」能不能烧你的 token。最后那条徽标的事是我踩过的坑：截图里显示 Inactive，但库里是 active、轮询锁刚写过——所以我在这一页主动说清楚判据。"))

SLIDES.append(("功能全景 ⑧", "运维与工程化", """
<h2>运维与工程化：坏了能修，改错了能回</h2>
<div class="metrics">
  <div class="metric"><b>25<span> 个</span></b><p>备份产物（5 轮 × 5 件）</p></div>
  <div class="metric"><b>25/25</b><p>gzip -t 独立复验通过</p></div>
  <div class="metric"><b>24</b><p>工作流已源码化入仓</p></div>
  <div class="metric"><b>63<span> 条</span></b><p>cron_runs 定时运行留痕</p></div>
</div>
<div class="cards2">
  <div class="card">
    <h4>定时备份 + 完整性校验</h4>
    <p>每日 14:21 一轮、5 件产物，跑完写 <code>.last-ok</code> 标记。<b>已积累 5 轮 / 25 个产物</b>；
    脚本自报完整性 <b>4/4</b>，我另外用 <code>gzip -t</code> 独立复验<b>全部 25 个包，0 个损坏</b>。</p>
  </div>
  <div class="card">
    <h4>心跳：备份到底跑没跑</h4>
    <p>备份容器反过来向平台上报，落 <code>heartbeats</code> 表（最新一条 <code>job=backup</code> / <code>ok=1</code> / <code>n=5</code> / <code>integrity=4/4</code>）。
    「备份没跑」和「跑了但没上报」是两回事，这张表能分开。</p>
  </div>
  <div class="card">
    <h4>工作流源码化 + CI 双 job</h4>
    <p>24 条工作流全部以 JSON 入仓（<code>n8n/workflows/</code>），可 diff、可回滚、可评审。
    CI 两个 job：<code>frontend-typecheck</code>（控制台 <code>pnpm typecheck</code>）+ <code>workflows-validate</code>（校验工作流结构与 compose 环境变量卫生）。</p>
  </div>
  <div class="card">
    <h4>对象存储与额度计量</h4>
    <p>RustFS（MinIO 兼容）承载对话前台的 S3 文件桶 <code>lobechat-files</code>，path-style 访问。
    <b>通路已实测</b>：用平台自身凭据 PUT/HEAD/GET/LIST 全部 200、字节一致。
    嵌入额度单独计量：<code>kb_usage</code> 记 <b>369 tokens</b> / 配额 1,000,000。</p>
  </div>
</div>
<table class="mini">
  <tr><th>一轮备份的 5 件产物</th><th>装什么</th><th>最新一轮（10-07 16:13）</th></tr>
  <tr><td>pg-n8n-*.sql.gz</td><td>n8n 主库（工作流 / 执行历史）</td><td>58.4 MB</td></tr>
  <tr><td>pg-lobechat-*.sql.gz</td><td>对话前台库</td><td>60.3 KB</td></tr>
  <tr><td>n8n-data-*.tar.gz</td><td>n8n 卷</td><td>2.0 MB</td></tr>
  <tr><td>minio-data-*.tar.gz</td><td>对象存储卷</td><td>14.4 KB</td></tr>
  <tr><td>config-*.tar.gz</td><td>配置快照</td><td>10.6 KB</td></tr>
</table>
<p class="note">诚实标注：<b>对象桶当前 0 个对象</b>（还没通过对话前台传过文件）；CI 只覆盖<b>静态校验</b>——集成冒烟测试需要 owner 手工创建的 API Key、无法 headless 引导，所以写在 CI 注释里改为部署后执行。这是取舍，不是遗漏。</p>
""", "这一页回答「这东西你敢不敢交给别人运维」。四个点里最容易被忽略的是心跳：备份脚本写了不等于每天真的在跑，所以让备份容器反过来上报，把「没跑」和「没上报」分开。备份那件我要强调「我自己复验过」——脚本自报 4/4 是它自己说的，gzip -t 25/25 是我独立验的。CI 那条要主动说清边界：只做静态校验，冒烟测试是部署后跑的，因为 n8n 的 owner key 没法在 CI 里自动生成。"))

SLIDES.append(("功能全景 ⑨", "文档工厂：把内容变成能发出去的成品", f"""
<h2>文档工厂：内容 → 成品 → 出口</h2>
<div class="cols" style="grid-template-columns:1.02fr 1fr">
  <div class="col">
    {shot("10_docs.png", "Docs 页 · 本机实拍（列表里是真的成品文档，不是空态）")}
  </div>
  <div class="col">
    <h3>一条链路：原料 → 成品 → 出口</h3>
    <ul class="tight">
      <li><b>原料</b>：会议原文 / 周报数据 / 晨报正文</li>
      <li><b>成品</b>：一篇能直接打印或另存 PDF 的 HTML（不是一段 Markdown）</li>
      <li><b>出口</b>：<code>推送</code> 发到 TG · <code>复制链接</code> 生成 <b>7 天免登录链接</b> · <code>归档</code> 回写知识库</li>
    </ul>
    <h3>真实产物（不是空态）</h3>
    <ul class="tight">
      <li><code>documents</code> 表 1 篇：《平台部署验证会》，<code>kind=minutes</code></li>
      <li>摘要：「- 三条链路全部打通，自检 42/47」</li>
      <li>自动抽出 <b>2 条行动项 / 3 个章节</b>（<code>meta={{"actions":2,"sections":3}}</code>）</li>
      <li>归档后回写知识库：<code>kb_doc_id: kb-52d8ef4c31cc3c1a</code> —— 之后在对话里就能问到它</li>
    </ul>
  </div>
</div>
<p class="note">这轮补齐：<code>weekly_reviews</code> 现在是 <b>1 行</b> —— 真跑了一次「导出本周周报」，产出 194 字回顾并推 TG，
总览页的「周报」卡片已经能看到内容（「🗓️ 本周回顾 · 2026-10-05 ~ 2026-10-11（更新至 2026-10-08）」「【晨报】本周 3 份」）。
所以现在能拿出来的成品是 <b>会议纪要 1 篇 + 周报 1 份</b>。</p>
""", "这一页补的是「企业工作包」那一类功能：会议行动项 / 智能摘要 / 动态监控。前面几页只提了一句，这页给证据——列表里那篇《平台部署验证会》是真生成的，摘要、章节数、行动项条数、回写知识库的 doc_id 都在库里能查到。要讲清它的定位：不是又一个聊天窗口，而是「把平台里的内容变成能发出去、能打印的成品」，三个出口（TG 推送 / 免登录链接 / 归档回知识库）才是它的价值。上一版演示时周报还是 0 行，这轮真跑了一份，所以现在成品是「1 篇纪要 + 1 份周报」。"))

SLIDES.append(("功能全景 ⑩", "把「就绪但没跑过」的能力真跑一遍", f"""
<h2>补上这一页：10 个「就绪但没跑过」的能力，今天全跑了一遍</h2>
<div class="cols" style="grid-template-columns:1.08fr 1fr">
  <div class="col">
    {shot("50_alerts_fired.png", "告警页 · 本机实拍：错误率 89.7% 真触发，状态「已送达」")}
  </div>
  <div class="col">
    <table class="mini">
      <tr><th>能力</th><th>数据表</th><th>跑前</th><th>跑后</th></tr>
      <tr><td>沙箱人工审批</td><td><code>sandbox_approvals</code></td><td>0</td><td><b>1</b></td></tr>
      <tr><td>L2 自建流程工具</td><td><code>workflow_tools</code></td><td>0</td><td><b>1</b></td></tr>
      <tr><td>出向 MCP</td><td><code>mcp_servers</code></td><td>0</td><td><b>1</b></td></tr>
      <tr><td>周报 Weekly Review</td><td><code>weekly_reviews</code></td><td>0</td><td><b>1</b></td></tr>
      <tr><td>动态监控关键词</td><td><code>topic_watch</code></td><td>0</td><td><b>1</b></td></tr>
      <tr><td>错误率告警</td><td><code>ops_alerts</code></td><td>0</td><td><b>1</b></td></tr>
      <tr><td>告警静默窗口</td><td><code>ops_alert_silence</code></td><td>0</td><td><b>1</b></td></tr>
      <tr><td>长期记忆提取</td><td><code>agent_memories</code></td><td>0</td><td><b>2</b></td></tr>
      <tr><td>对象存储 S3 通路</td><td><code>lobechat-files</code></td><td>0</td><td><b>1</b></td></tr>
      <tr><td>产品级文件上传<br><span class="dim">（从对话前台真传）</span></td><td>LobeChat <code>files</code></td><td>0</td><td><b>1</b></td></tr>
    </table>
  </div>
</div>
<p class="note"><b>怎么触发的</b>：沙箱审批＝让模型跑联网代码，被网关拦下并登记 <code>sha256(代码)+理由</code>；
L2 工具＝注册 <code>echo-demo</code>；出向 MCP＝把平台自己的 <code>/webhook/mcp</code> 注册成外部服务器，
<code>mcp_list_tools</code> 真的返回了 <b>17 个工具</b>；周报＝真跑一次并推 TG；动态监控＝加关键词「Agent 平台 开源」并立即扫描；
告警＝造出 <b>26/29（89.7%）</b> 错误率越过 50% 阈值。<br>
<b>后三条是这轮补的</b>：记忆＝拿一轮真实对话过提取器，模型判定出 2 条长期偏好，落本机 pgvector 库
<b>并镜像进 LobeHub</b> 的 <code>user_memories</code>，再用自然语言问回来命中 <b>score 0.71</b>；
对象存储＝用平台自身凭据对 <code>lobechat-files</code> 做 PUT/HEAD/GET/LIST，全部 200、字节一致；
<b>产品级上传＝真从对话前台的 composer 上传了一份 100 KB 的代码规范</b>，
<code>files</code> 落行、对象落盘、取回来 SHA-256 一致 —— 并且顺手修掉了它暴露的两个真实缺陷（见「功能全景 ⑫」）。</p>
""", "这一页是专门补短板的。上一轮演示里我主动标了 7 个「能力就绪但从没跑过」的表，这一轮把它们全部真跑了一遍，后来又补了记忆和对象存储两条，一共 9 条。最值钱的是告警那条：不是造一条假记录，而是真造出 89.7% 的错误率越过阈值，severity=critical，而且 delivered=ok——真的推到 Telegram 了。出向 MCP 也值得说：注册的是平台自己的 MCP 端点，等于自己连自己，mcp_list_tools 真返回 17 个工具，说明出向调用链路是通的。新增的两条里，记忆那条最能体现「双库」设计：本机 pgvector 库 + LobeHub 的 user_memories 表两边都写进去了，而且反查得到。要强调这些不是「代码里有」，是「刚跑过」；同时也要主动说清对象存储那条的边界——通路是通的，但产品级上传入口还没走通过。"))

SLIDES.append(("功能全景 ⑪", "告警链路：从触发到送达，以及静默的设计", f"""
<h2>告警链路：不是「配了个阈值」，是整条链路真跑通了</h2>
{shot("53_overview_alert.png", "总览页「最近告警」卡片 · 本机实拍：错误率 89.7% 真触发（2026/10/8 00:41:56，badge=error_rate）")}
<div class="two" style="margin-top:14px">
  <div>
    <h3>一次真实告警的完整链路</h3>
    <ul class="tight">
      <li><b>触发</b>：60 分钟窗口内 <code>total=29</code> / <code>errors=26</code> → 错误率 <b>89.7%</b>，越过 <code>ALERT_RATE_THRESHOLD=0.5</code></li>
      <li><b>定级</b>：<code>severity=critical</code>（≥ <code>ALERT_SEVERITY_CRITICAL=0.8</code>）</li>
      <li><b>落库</b>：<code>ops_alerts</code> 1 行，message「错误率 89.7%（26/29，窗口 60 分钟）超过阈值 50%」</li>
      <li><b>送达</b>：<code>delivered=ok</code> —— 真的推到了 Telegram，告警页显示「已送达」</li>
    </ul>
  </div>
  <div>
    <h3>静默窗口的一个设计取舍</h3>
    <p>静默<b>只停投递，不丢记录</b>：「suppressing noise must never mean losing history」。
    维护窗口期间告警照常落 <code>ops_alerts</code>，只是不发出去。设 120 分钟窗口用的是
    <code>{{"mode":"silence","action":"set","minutes":120}}</code>，随时可 <code>action:"clear"</code> 解除。</p>
  </div>
</div>
<p class="note">截图里 KPI 的 24h 错误率已回落到 <b>0.0%</b> —— 告警卡片是触发时刻（00:41）的快照，两者不矛盾。
成本告警（<code>ALERT_COST_24H_USD=2</code>）仍未触发过：24 小时花费只有 $0.0073，离阈值很远。</p>
""", "这页单独讲告警，因为它是这轮唯一一条「端到端真的走完」的运维链路。要点：不是插一条假数据，而是真造错误率、真越过阈值、真落库、真投递。然后讲静默的设计——很多系统一静默就什么都不记了，这里刻意分开「记录」和「投递」，因为排障时最怕的就是「那段时间发生了什么完全查不到」。最后坦白成本告警还没触发过，因为花钱太少。"))

SLIDES.append(("功能全景 ⑫", "产品级文件上传：真从界面上传了一个文件", f"""
<h2>产品级文件上传：不是「通路配好了」，是真从界面传了一个文件</h2>
<div class="cols" style="grid-template-columns:1.16fr 1fr">
  <div class="col">
    {shot("60_upload_product.png", "对话前台 · 本机实拍：文件已从 composer 真实上传（无进度条＝已完成）")}
  </div>
  <div class="col">
    <h3>传的是什么</h3>
    <ul class="tight">
      <li>文件：<b>Airbnb JS 规范</b>（100,456 B）+ 复传 <b>Uber Go 规范</b>（87,321 B）</li>
      <li>入口：composer →「添加文件、技能和更多上下文」→ <b>附件</b> → <b>上传文件或图片</b></li>
    </ul>
    <h3>三处都对上了</h3>
    <ul class="tight">
      <li><code>files</code> 表：<b>0 → 2</b>（size 精确对得上 100456 / 87321）</li>
      <li><code>lobechat-files</code> 桶：对象真的落盘</li>
      <li><b class="good">取回来逐字节比对：SHA-256 与本地完全一致</b></li>
    </ul>
  </div>
</div>
<p class="note"><b>这一页的价值不是「成功了」，而是它先后暴露并修掉了两个真实缺陷</b>：</p>
<table class="mini">
  <tr><th>#</th><th>症状</th><th>根因</th><th>修法</th></tr>
  <tr>
    <td>1</td>
    <td>签发预签名 URL 直接报错<br><code>ECONNREFUSED 10.55.251.44:9000</code></td>
    <td><code>S3_ENDPOINT</code> 在<b>容器创建那一刻</b>把 LAN IP 固化了；<br>路由器换 IP（→ <code>192.168.31.91</code>）后容器连不上旧地址</td>
    <td>改 <code>.env</code> 的 <code>PLATFORM_LAN_IP</code>/<code>LAN_IP</code>，<br>用 <code>up -d</code> 重建（<code>restart</code> 不重注环境变量）</td>
  </tr>
  <tr>
    <td>2</td>
    <td>URL 签出来了，但浏览器 <code>PUT</code> 不发出去，<br>应用随即 <code>abortS3Upload</code></td>
    <td><b>RustFS 桶没配 CORS</b>：预检 <code>OPTIONS</code> 回 200 却<b>没有任何 <code>Access-Control-*</code> 头</b>。
    跨域预检不合格，浏览器就<b>不发</b>真正的 PUT</td>
    <td><code>PutBucketCors</code> 放行控制台来源；<br>复验预检已带头</td>
  </tr>
</table>
<p class="note">修完再跑，<code>file_uploads.status</code> 从 <b><code>released</code>（中止）→ <code>settled</code>（完成）</b>，这个状态跃迁就是证明。
<b>只验存储层碰不到这两个坑</b> —— 它们只存在于「浏览器 → 应用 → 对象存储」这条真实链路上。</p>
<p class="note"><b>缺陷 2 是怎么定位的</b>：翻前端的网络记录，四行就锁死了 ——</p>
<pre class="trace">POST  upload.createS3PreSignedUrl   200        ← 签发成功（说明缺陷 1 已修好）
OPTIONS  …/lobechat-files/….md     200        ← 预检"通过"，但<b>没有任何 Access-Control-* 头</b>
PUT      …/lobechat-files/….md     (无状态)   ← 浏览器因此<b>根本没发出去</b>
POST  upload.abortS3Upload          200        ← 应用收到失败，主动放弃</pre>
<p class="note">把预检单独复现一次（带 <code>Origin</code> 头）就坐实了：回的是 <code>200 OK</code> 却只有
<code>x-request-id</code> / <code>content-length</code> —— <b>200 不等于 CORS 通过</b>，这是最容易误判的地方。</p>
""", "这一页补的是上一版唯一的真实缺口：产品级文件上传。要讲的重点不是『成功了』，而是『测试发现了两个真 bug』。第一个是环境变量在容器创建时固化了 LAN IP，路由器换 IP 就断——这类问题只有在真跑的时候才会现形。第二个更隐蔽：RustFS 桶没配 CORS，预检返回 200 但没有任何 CORS 头，浏览器就静默地不发 PUT，应用只能 abort。诊断方法是看前端的 network 记录：createS3PreSignedUrl 200、OPTIONS 200、PUT 无状态码、abortS3Upload 200——这四行就把问题锁死在 CORS 上。修完 file_uploads 的状态从 released 变 settled。最后一定要说清：如果只验存储层（直接调 S3 API），这两个坑一个都碰不到，因为它们只存在于浏览器到应用这条链路上。缺陷 1 的根治方向在「已知问题」页——注意那里写的和这里不一样，因为源码读下来发现原先想当然的修法是错的。"))

SLIDES.append(("前端 ①", "对话前台 · PivotAI（基于 LobeChat 定制）", f"""
<h2>对话前台：把 LobeChat 定制成自己的品牌 PivotAI</h2>
<div class="cols" style="grid-template-columns:1.18fr 1fr">
  <div class="col">
    {shot("23_lobe_pivot_themed.png", "PivotAI 登录页 · 本机实拍（主题已注入生效）")}
  </div>
  <div class="col">
    <h3>这不是「套壳」，是做了哪些改造</h3>
    <ul class="tight">
      <li>往 <b>4 套 SPA bundle</b> 注入受管区块：<b>13 个 CSS + 5 个 JS</b>（实测计数）</li>
      <li>替换品牌与标题 → <code>PivotAI - 从对话到执行 | Chat less. Ship more.</code></li>
      <li>叠加 canvas <b>星空引擎</b>：分层星点、闪烁、星座连线、流星、鼠标交互</li>
      <li>品牌文案全量替换 + 悬浮品牌组件 + AI 面部底图</li>
    </ul>
    <h3>工程上比较讲究的地方</h3>
    <ul class="tight">
      <li><b>幂等</b>：受管区块带 START/END 标记，重复执行是原地更新</li>
      <li><b>可回滚</b>：首次注入留 <code>.pivot-backup</code>，<code>--remove</code> 一键还原</li>
      <li><b>抗重渲染</b>：监听 React 重渲染，带 reduced-motion 与 iframe 保护</li>
      <li><b>看门狗</b>：容器重建会冲掉注入（静态文件清单在启动时快照），配了 5 分钟一次的
          <code>theme-keeper</code> 计划任务自动补刷</li>
    </ul>
  </div>
</div>
""", "这页是本次修正的重点。要说清楚：前端不是从零自研，而是把 LobeChat 定制成自己的品牌。面试官会追问「改了什么、怎么保证不坏」，所以我把幂等、可回滚、抗重渲染、看门狗这四点讲出来。截图是登录页，因为应用本身要登录；主题生效我是直接查了容器里被服务的 CSS/JS 产物来确认的。"))

SLIDES.append(("前端 ②", "控制台 · 自建联调工作台", f"""
<h2>控制台的联调工作台：真流式 + 思考过程可见 + 工具可追踪</h2>
<div class="two">
  {shot("02_ai_chat.png", "真实一轮对话（本机实拍，含思考过程与用量）")}
  {shot("02_ai_chat_empty.png", "空态：快捷卡片引导", small=True)}
</div>
<p class="note">这是<b>面向开发者</b>的页面（头部写着「直连 stream-bridge 与 n8n 网关」），和面向用户的 PivotAI 前台分工不同。
回答下方给出 <b>耗时 5.8s / 146 tokens</b>，思考过程折叠在「思考过程与工具调用」里。</p>
""", "要区分两个前端：PivotAI 是给用户用的产品界面；这一页是给开发/运维用的联调工作台，好处是能把工具调用路径和 token 消耗摊开看。"))

SLIDES.append(("前端 ③", "控制台总览", f"""
<h2>控制台总览：一个页面看清平台在干什么</h2>
{shot("01_overview.png", "Platform Overview · 本机实拍（含真实 24h 数据）", tall=True)}
<div class="grid2">
  <div><b>24h 对话量 32</b><span>成功 28 / 失败 4</span></div>
  <div><b>平均延迟 7,101ms</b><span>含工具轮次</span></div>
  <div><b>24h 成本 $0.0302</b><span>按牌价折算</span></div>
  <div><b>知识库 4 文档 / 5 分块</b><span>嵌入已用 369 / 100 万</span></div>
</div>
<p class="note">同一页还聚合了：待办与提醒（含负责人）、派发、晨报与周报入口、记忆（LobeHub + 本机双库）、平台自检摘要、按模型拆的成本明细、推送与手机访问入口。
  <br><b>这张截图里有一处要看清楚</b>：自检卡片显示的是 <b>2026/10/4 12:30</b> 那次（<b>未通过 41/47、告警 3</b>），
  控制台取的不是最新一次；最新一次是 <b>10-08 00:28 的 45/47</b>（0 失败 / 2 告警），差别与原因见「可验证性」页。</p>
""", "这一页是运维的仪表盘。重点不是数字大小，而是信息密度：运维一个 Agent 平台需要盯的东西，我把它收敛到一屏。"))

SLIDES.append(("前端 ④", "运行态势 · 24 条工作流", f"""
<h2>运行态势：把 n8n 的黑盒摊开</h2>
{shot("09_workflows.png", "Workflows 页 · 24 条工作流实时执行健康度（本机实拍）", tall=True)}
<div class="grid2">
  <div><b>总调用 20 · 成功率 90%</b><span>失败 2</span></div>
  <div><b>平均延迟 6.62s</b><span>独立会话 10</span></div>
  <div><b>按模型分布</b><span>deepseek-agent 20</span></div>
  <div><b>按来源分布</b><span>unknown 12 / selfcheck 7 / playground 1</span></div>
</div>
<p class="note">顶部 24 个胶囊是全部工作流及其节点数 —— 最大的 <b>Platform Admin API 有 68 个节点</b>，Chat Gateway 22 个，Reminders 34 个。</p>
""", "面试官常问「你怎么知道系统是好的」。答案是：把 n8n 的执行数据反查出来，做成实时健康度。每一条执行都有 session、来源、耗时、token、错误原因。"))

SLIDES.append(("前端 ⑤", "n8n 运行总览 · 真实数据", f"""
<h2>n8n 运行总览：这台机器上真的跑了 3,879 次</h2>
{shot("20_n8n_workflows.png", "n8n Overview · 本机实拍（3,879 次生产执行 / 失败率 3.1% / 24 条工作流）", small=True)}
<div class="grid2">
  <div><b>3,879 次</b><span>生产执行</span></div>
  <div><b>119 次</b><span>失败执行</span></div>
  <div><b>3.1%</b><span>失败率</span></div>
  <div><b>3.62s</b><span>平均运行时长</span></div>
</div>
<p class="note">这页回答「编排到底有没有在跑」。24 条工作流全部 <b>Published</b>：Workflow Tools、Weekly Review、Topic Watch、Todos、Telegram Bridge、Stream Log、Smart Summary、Selfcheck …… 不是建好放着，是有真实执行记录的。
<br><b>3,879 是 10-04 实拍那一刻的快照</b>，之后仍在增长 —— 现场核对时数字只会更大，不会更小。</p>
""", "这是最能堵住质疑的一页。很多「Agent 平台」演示里 n8n 是空的、或者只有一条测试工作流。这里 3,879 次生产执行、失败率 3.1%，是长时间真实运行积累出来的数字。"))

SLIDES.append(("前端 ⑥", "n8n 画布 · 真实编辑器", f"""
<h2>n8n 编辑器：真实画布（仓库原演示包缺的就是这一张）</h2>
<div class="two">
  {shot("21_n8n_chat_gateway.png", "Chat Gateway · 22 节点主链路")}
  {shot("22_n8n_mcp_server.png", "MCP Server · 鉴权与分发")}
</div>
<p class="note">Chat Gateway 的真实链路：<b>Webhook → Parse &amp; Validate → 读会话历史 → 拼 LLM Payload → 判定是否调工具 → 执行工具 → 回写消息</b>，并带错误分支（Wait Error / Persist Error / Response Error）。</p>
""", "这一页证明「编排不是嘴上说的」。仓库自带的演示包里，作者尝试登录 n8n 截图但失败了，交付的其实是 PIL 自绘的结构图。我这次真的登进去了，这是浏览器里点开工作流后的原生画布。"))

SLIDES.append(("前端 ⑦", "其余页面速览", f"""
<h2>其余页面速览</h2>
<div class="gallery">
  {shot("03_knowledge.png", "知识库", small=True)}
  {shot("04_keys.png", "API 密钥", small=True)}
  {shot("05_models.png", "模型与成本", small=True)}
  {shot("06_people.png", "人员目录", small=True)}
  {shot("07_alerts.png", "告警", small=True)}
  {shot("10_docs.png", "文档", small=True)}
</div>
<p class="note">六个页面全部是同一套自建控制台里的真实路由，不是模板占位页。</p>
""", "快速翻过，目的是证明「这是一个完整产品而不是一个 Demo 脚本」。如果面试官对某一页感兴趣就停下来展开。"))

SLIDES.append(("工程亮点", "真正难的地方", """
<h2>四个真正花时间的硬仗</h2>
<div class="cards2">
  <div class="card">
    <h4>① 一个 Postgres 报错会静默杀死整个 JS 任务执行器</h4>
    <p>任何 <code>relation/column does not exist</code> 都会触发 <code>pg-protocol</code> 崩溃，表现为 webhook <b>返回 HTTP 200 但响应体为空</b>。没有堆栈、没有 500，只能靠「200+空体」这个特征反推。</p>
  </div>
  <div class="card">
    <h4>② 主题注入必须能扛住容器重建</h4>
    <p>LobeChat 的静态文件清单在<b>容器启动时快照</b>，所以新文件注入后必须重启才生效；而容器一旦重建，注入全部丢失。解法是幂等注入 + 备份可回滚 + 5 分钟一次的看门狗自动补刷。</p>
  </div>
  <div class="card">
    <h4>③ 弹窗藏在闭合的 Shadow DOM 里</h4>
    <p>Clerk 的开发模式提示既不在主文档、也不在 iframe、JS 读不到。最后靠<b>无障碍树拿到元素 ref</b> 点击，再用<b>像素级命中测试</b>定位到 <code>.cl-modalBackdrop</code>，注入 CSS 规则解决（内联样式会被 React 重渲染冲掉）。</p>
  </div>
  <div class="card">
    <h4>④ 一个健康检查因为端口写死而「假绿」</h4>
    <p>自检里硬编码了 <code>host.docker.internal:3000</code>，但本机 3000 被另一个项目占着、控制台在 3001。结果这项检查探测的是<b>别人的服务</b>，一直显示正常。</p>
  </div>
</div>
<p class="note">另外还有：宿主系统代理会让所有 localhost 探测返回 HTTP 000（看起来像 Docker 端口转发挂了）；全页截图会触发重排导致弹窗重新挂载。</p>
""", "这一页是整场的价值所在。不要讲「我用了 n8n」，要讲「我遇到了什么别人遇不到的坑、怎么定位的」。每个坑我都写进了排查手册，下次遇到能直接复用。"))

SLIDES.append(("可验证性", "怎么证明它是好的", """
<h2>可验证性：把「能跑」变成「可证明」</h2>
<div class="metrics">
  <div class="metric"><b>26<span> 次</span></b><p>自检落库留痕，可回溯</p></div>
  <div class="metric"><b>28<span>→45</span></b><p>首跑到最新，失败 14 → 0</p></div>
  <div class="metric"><b>1.000</b><p>知识库检索 hit@5（12/12）</p></div>
  <div class="metric"><b>0.903</b><p>检索 MRR</p></div>
</div>
<h3>自检记录本身就是一份修 bug 日志</h3>
<table>
  <tr><th>运行</th><th>来源</th><th>结果</th><th>说明</th></tr>
  <tr>
    <td>#1 · 10-03 14:20</td><td>手动</td>
    <td class="bad">28 / 47（14 失败）</td>
    <td>首次落地，大面积未配置</td>
  </tr>
  <tr>
    <td>#17 #18 #22 #23</td><td>定时</td>
    <td class="bad">40 / 47（5–6 失败）</td>
    <td>4× 上游 502 + <code>memory api</code> payload 异常</td>
  </tr>
  <tr>
    <td>#25 #26 · 10-08 00:28</td><td>手动</td>
    <td class="good">45 / 47（0 失败 / 2 告警）</td>
    <td>当前状态；2 个告警是 <code>searxng engines</code> + 自指噪声</td>
  </tr>
</table>
<p class="note">47 项检查分五组（基础设施 / 网关 / 流式代理 / 数据 / 文档链路），每次运行落 <code>selfcheck_runs</code> 表（现 <b>26 次</b>）；另有 6 个独立脚本（工作流结构、工具契约、MCP 端到端、冒烟、幂等性、客户端工具隔离）。<br>
<b>两个告警的准确口径</b>：<code>searxng engines</code>（上游 7 个引擎挂起，唯一常驻告警）+
<code>selfcheck ran recently</code>（连着跑两遍就会出现的自指噪声）。所以稳态应读作 <b>45 通过 / 0 失败 / 1 告警</b>。<br>
<b>工具契约的准确说法</b>：网关 15 = 双方共有 12 + 网关独有 3（<code>run_python</code>、<code>mcp_list_tools</code>、<code>mcp_call</code>）；
MCP 17 = 共有 12 + MCP 独有 5（<code>people_list</code>、<code>delegation_view</code>、<code>doc_create/list/get</code>）。<b>不是「两边一样」，是「差集是设计出来的」</b>。</p>
""", "这一页回答「你怎么保证质量」，而且我把自检的历史当证据用：从首次 28/47 修到 45/47，26 次运行全部留痕。这比单说一个数字有力得多——它证明的是一条修 bug 的轨迹。这里要讲得特别准：手动跑是 45 通过 / 0 失败，两个告警里有一个是「刚跑过」的自指噪声，所以稳态其实是 1 个告警；而定时跑仍然会掉到 40/47，那 5-6 项是上游 DeepSeek 的瞬时 502，不是平台缺陷——但我不会把它说成「不是我的问题」，而是「下一步要加退避重试，并把上游瞬时失败和平台真故障分开计」。工具契约那点也要讲准：两边工具数不同不是 bug，差集是设计出来的。"))

SLIDES.append(("已知问题", "还没做好的地方", """
<h2>已知问题与下一步</h2>
<table>
  <tr><th>问题</th><th>现状</th><th>下一步</th></tr>
  <tr>
    <td>定时自检偶发 6 项失败</td>
    <td>手动跑 <b>45/47（0 失败）</b>，但最近两次<b>定时</b>运行都掉到 <b>40/47</b>（6 失败 / 5 失败）</td>
    <td>失败项是 4 个上游 502 + <code>memory api</code> payload，属 DeepSeek 侧瞬时故障，非平台缺陷；应加<b>退避重试</b>，并把「上游瞬时失败」与「平台真故障」分开计</td>
  </tr>
  <tr>
    <td>主题注入不持久</td>
    <td>容器重建会冲掉 PivotAI 注入（静态文件清单启动时快照）；仓库自带 <code>theme-keeper.ps1</code> 看门狗脚本，但本环境<b>未能验证计划任务注册成功</b></td>
    <td>先确认看门狗真的在跑；更彻底的做法是构建<b>自己的镜像</b>，把主题固化进 Dockerfile，从根上不需要看门狗</td>
  </tr>
  <tr>
    <td>SearXNG 部分引擎不可用</td>
    <td>7 个引擎被挂起（SSL 校验失败 / 超时），是唯一常驻告警</td>
    <td>按引擎逐个降级或加证书白名单；不建议直接删掉，会降低检索覆盖</td>
  </tr>
  <tr>
    <td>控制台残留模板页</td>
    <td>还留着 forms / kanban / elements / react-query 等脚手架页面；<b>Notifications 页是写死的假数据</b>（"Sarah Connor 加入团队"之类），却挂在侧边栏里</td>
    <td>收敛路由；模板页要么实现要么从导航里摘掉 —— 一个假的通知页比没有更伤信任</td>
  </tr>
  <tr>
    <td>自检卡片不取最新一次</td>
    <td>总览页卡片显示的不是最新一次；最新一次是 <b>10-08 00:28 的 45/47</b>（表内共 26 次留痕）</td>
    <td>修成按 <code>checked_at</code> 倒序取第一条；在那之前，演示时主动说明这一点</td>
  </tr>
  <tr>
    <td>告警渠道口径不一致</td>
    <td>Settings 页报 <code>webhook_configured=false</code>（未配 <code>ALERT_WEBHOOK_URL</code>），但告警页显示<b>已配置（format: telegram）</b>，且实测告警<b>真的送达了</b>（<code>delivered=ok</code>）</td>
    <td>同一件事两个页面给出相反答案；统一由一处配置推导，避免"看着没配、其实在发"</td>
  </tr>
  <tr>
    <td>沙箱审批只有 TG 一个出口</td>
    <td><code>sandbox_approvals</code> 里那条待审记录状态是 <code>pending</code>：审批按钮只发到 Telegram，<b>控制台没有审批入口</b>，不用 TG 的人无法放行</td>
    <td>在控制台补一个审批队列（列出 pending + 放行/拒绝），否则「人工审批」对非 TG 用户等于不可用</td>
  </tr>
  <tr>
    <td><b class="good">已修复</b>：产品级上传入口</td>
    <td>上一版这里是「通路通、产品没走通」。这轮真从对话前台上传了一份 100 KB 文档，
    并修掉了过程中暴露的两个缺陷：① <code>S3_ENDPOINT</code> 固化了容器创建时的 LAN IP，
    换网就断；② <b>RustFS 桶没配 CORS</b>，预检无 <code>Access-Control-*</code> 头导致浏览器不发 PUT</td>
    <td>已复验：<code>files</code> 落行、对象落盘、取回 bytes 与本地 SHA-256 一致。
    <b>CORS 那条已从「手工修」变成「可重复」</b>：写成幂等脚本
    <code>scripts/provision-bucket.sh</code>（建桶 + 配 CORS + 复验预检，来源域由 <code>.env</code> 推导）。
    <b>但原先设想的「把 <code>S3_ENDPOINT</code> 改成 <code>minio:9000</code>」是错的</b>：
    读 LobeChat 的 <code>FileS3</code> 可见 <code>S3_ENDPOINT</code> 正是浏览器拿到的预签名 URL 的主机名，
    而宿主机不解析 <code>minio</code>。正确的开关是 <code>S3_INTERNAL_ENDPOINT</code>（原未设，
    服务端调用才退回 <code>S3_ENDPOINT</code>、被旧 IP 拖死）—— <b>已设并验证</b>：
    把它指向旧 IP 能<b>按需复现</b> <code>ECONNREFUSED</code>，指向 <code>minio:9000</code> 则复传一份新文档、
    取回 SHA-256 与本地一致</td>
  </tr>
  <tr>
    <td>换网段后上传会失效<br><span class="dim">（有意保留的取舍，非缺陷）</span></td>
    <td>浏览器拿到的预签名链接主机名<b>只能是 <code>S3_ENDPOINT</code> 一个值</b>：
    填 <code>localhost</code> 则手机浏览器上传不了（它指向手机自己），填 LAN IP 则换网后失效。
    <code>S3_PUBLIC_DOMAIN</code> 经查证只参与 CORS 白名单，<b>不能</b>改写链接主机名</td>
    <td><b>选择保留 LAN IP</b> —— 手机在同一 WiFi 下也要能传。
    换网后重跑一次一键启动脚本即可：它会自动同步 IP、<code>up -d</code> 重建、
    并重注被冲掉的主题。
    <b>不做 DHCP 保留</b>：本机在<b>不同网段间漫游</b>（校园 <code>10.55.251.x</code> ↔
    家用 <code>192.168.31.x</code>），保留只在单一子网内有效，解决不了换网络</td>
  </tr>
</table>
<p class="note">把没做好的地方主动列出来，比被问出来要好。</p>
""", "主动暴露问题。注意措辞：区分「上游瞬时故障」和「平台缺陷」，这体现的是排障能力而不是掩盖。主题注入那条尤其能体现工程判断——知道临时方案的边界，并且给出了根治方向。产品级上传那条要主动讲：原先文档里写的『把 S3_ENDPOINT 换成 minio:9000』是错的，读源码才看出它正是浏览器用的主机名；把错误结论改掉本身就是工程判断的一部分。最后那条取舍要讲清楚为什么不做 DHCP 保留：一是这台机器在校园网和家用网之间来回换（一天内 10.55.251.44 → 192.168.31.91 → 又回 10.55.251.44），DHCP 保留只在单一子网内有效，换网络就白搭；二是校园网段的 DHCP 服务器不在我们手上，本来也加不了保留；三是一键启动脚本已经能自动纠偏（同步 IP → up -d → 重注主题），所以保留属于重复建设。结论是保留 LAN IP 并依赖启动脚本自愈，把「手机同 WiFi 也能传」这个能力保住。"))

SLIDES.append(("收尾", "", """
<div class="cover">
  <h1>一句话总结</h1>
  <p class="lead" style="max-width:52ch">
    用 <b>n8n 做编排</b>、<b>对话前台 + 运维控制台做入口</b>、<b>统一网关收口模型</b>，
    在一台普通 Windows 机器上跑起了一套<b>可观测、可验证、可自愈</b>的私有 Agent 平台。
  </p>
  <div class="kpis">
    <div><b>10</b><span>容器全部运行</span></div>
    <div><b>45/47</b><span>自检通过</span></div>
    <div><b>24</b><span>工作流在线</span></div>
    <div><b>1.0</b><span>检索 hit@5</span></div>
  </div>
  <p class="foot">截图均为本机实拍（2026-10-04 ~ 10-08）· 语音与图片为 2026-10-05 现场实测 ·
  「就绪但没跑过」的 7 项能力已于 10-08 全部实跑留痕 · 全部可现场复现</p>
</div>
""", "收尾不要复述功能，给一个判断：这套东西的价值在于「把 Agent 从玩具变成可运维的系统」。"))


def render():
    slides_html, notes_html = [], []
    for i, (tag, sub, body, note) in enumerate(SLIDES, 1):
        slides_html.append(f"""<section class="slide" data-i="{i}">
  <header><span class="tag">{tag}</span>{f'<span class="sub">{sub}</span>' if sub else ''}</header>
  <div class="body">{body}</div>
  <footer><span>{i} / {len(SLIDES)}</span><span class="brand">Agent 协作平台 · 本机实机演示</span></footer>
</section>""")
        notes_html.append(f'<div class="note-slide" data-i="{i}"><h4>第 {i} 页 · {tag}</h4><p>{note}</p></div>')

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent 协作平台 · 面试演示台</title>
<style>
:root{{--bg:#0d1117;--panel:#151b25;--line:#243040;--fg:#e6edf6;--dim:#93a4bd;
  --acc:#4c9aff;--ok:#3fb950;--warn:#d29922;--bad:#f85149;}}
*{{box-sizing:border-box}}
html,body{{margin:0;height:100%;background:var(--bg);color:var(--fg);
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
body{{display:flex;align-items:center;justify-content:center;overflow:hidden}}
#deck{{position:relative;width:min(96vw,1500px);height:min(94vh,900px)}}
.slide{{position:absolute;inset:0;background:var(--panel);border:1px solid var(--line);
  border-radius:16px;padding:30px 38px 44px;display:none;flex-direction:column;
  box-shadow:0 18px 60px rgba(0,0,0,.5)}}
.slide.on{{display:flex}}
header{{display:flex;align-items:baseline;gap:12px;padding-bottom:12px;
  border-bottom:1px solid var(--line);flex:0 0 auto}}
.tag{{font-size:12px;letter-spacing:.1em;color:#0d1117;background:var(--acc);
  padding:3px 10px;border-radius:999px;font-weight:700;white-space:nowrap}}
.sub{{font-size:13px;color:var(--dim)}}
.body{{flex:1 1 auto;overflow:auto;padding-top:16px}}
footer{{position:absolute;left:38px;right:38px;bottom:14px;display:flex;
  justify-content:space-between;font-size:11.5px;color:var(--dim);
  border-top:1px solid var(--line);padding-top:8px}}
h1{{font-size:44px;margin:6px 0 10px;letter-spacing:-.01em}}
h2{{font-size:23px;margin:0 0 14px;font-weight:650}}
h3{{font-size:15px;margin:14px 0 8px;color:#b9c8de}}
h4{{font-size:14px;margin:0 0 6px}}
p,li{{font-size:14px;line-height:1.6;color:#cfdaea}}
ul{{margin:6px 0;padding-left:20px}} li{{margin:5px 0}}
ul.tight li{{margin:4px 0}}
b{{color:#fff}}
code{{background:#0b1220;border:1px solid var(--line);border-radius:4px;
  padding:1px 5px;font-size:12.5px;color:#9ecbff}}
.note{{margin-top:12px;font-size:12.5px;color:var(--dim);
  border-left:3px solid var(--acc);padding-left:12px;line-height:1.6}}
pre.trace{{margin:10px 0 0;background:#0b1220;border:1px solid var(--line);border-radius:8px;
  padding:10px 14px;font-size:12px;line-height:1.75;color:#9ecbff;
  font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap}}
pre.trace b{{color:#ffd08a}}
.cover{{display:flex;flex-direction:column;justify-content:center;height:100%;text-align:center;align-items:center}}
.cover .badge{{font-size:12px;color:var(--acc);border:1px solid #2a4a72;
  background:#0f1c2e;padding:4px 14px;border-radius:999px;margin-bottom:14px}}
.cover .lead{{font-size:17px;color:#c3d2e6;max-width:64ch;margin:0 auto}}
.cover .foot{{font-size:12.5px;color:var(--dim);margin-top:22px}}
.kpis{{display:flex;gap:34px;margin:26px 0 4px;flex-wrap:wrap;justify-content:center}}
.kpis div{{display:flex;flex-direction:column}}
.kpis b{{font-size:30px;color:var(--acc);line-height:1.1}}
.kpis span{{font-size:12px;color:var(--dim)}}
.cols,.two{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}
.cards3{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:6px}}
.cards2{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
.card{{background:#101823;border:1px solid var(--line);border-radius:10px;padding:14px 16px}}
.card p{{font-size:13px;color:#b9c8de;margin:0}}
.good{{color:var(--ok)}} .bad{{color:var(--bad)}}
.grid2{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px}}
.grid2 div{{background:#101823;border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column}}
.grid2 b{{font-size:14px;color:#fff}} .grid2 span{{font-size:11.5px;color:var(--dim)}}
.shot{{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#0b1220}}
.shot img{{display:block;width:100%;height:auto}}
.shot figcaption{{font-size:11.5px;color:var(--dim);padding:7px 10px;
  border-top:1px solid var(--line);background:#0f1620}}
.shot.tall{{max-height:50vh;overflow:auto}}
.shot.small img{{max-height:210px;object-fit:cover;object-position:top}}
.gallery{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}}
.gallery .shot img{{max-height:150px;object-fit:cover;object-position:top}}
.audio{{display:flex;align-items:center;gap:12px;background:#101823;border:1px solid var(--line);
  border-radius:10px;padding:11px 14px;margin:10px 0 2px}}
.audio .lbl{{font-size:12px;color:var(--acc);white-space:nowrap;font-weight:600}}
.audio audio{{flex:1 1 auto;height:36px;min-width:0}}
.photo{{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#0b1220}}
.photo img{{display:block;width:100%;max-height:300px;object-fit:cover;object-position:center 42%}}
.photo figcaption{{font-size:11.5px;color:var(--dim);padding:7px 10px;
  border-top:1px solid var(--line);background:#0f1620}}
.quote{{background:#0f1c2e;border-left:3px solid var(--ok);border-radius:0 8px 8px 0;
  padding:10px 14px;margin:10px 0;font-size:13px;color:#dbe9ff;line-height:1.6}}
.quote b{{color:var(--ok)}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th,td{{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}}
th{{color:var(--dim);font-weight:600;font-size:12px;letter-spacing:.03em}}
td:first-child{{color:#fff;font-weight:600;white-space:nowrap}}
table.mini{{margin-top:12px;font-size:12px}}
table.mini th,table.mini td{{padding:5px 10px}}
.metrics{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}}
.metric{{background:#101823;border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center}}
.metric b{{font-size:30px;color:var(--ok)}} .metric b span{{font-size:15px;color:var(--dim)}}
.metric p{{font-size:12px;color:var(--dim);margin:6px 0 0}}
.arch svg{{width:100%;height:auto;display:block}}
#notes{{position:fixed;left:0;right:0;bottom:0;background:#050a12;border-top:2px solid var(--acc);
  padding:16px 26px;font-size:13.5px;color:#cfe0f5;display:none;max-height:34vh;overflow:auto;z-index:9}}
#notes.on{{display:block}}
#notes h4{{color:var(--acc);margin:0 0 6px;font-size:13px}}
#bar{{position:fixed;top:0;left:0;height:3px;background:var(--acc);z-index:10;transition:width .2s}}
#help{{position:fixed;right:14px;bottom:12px;font-size:11.5px;color:#5d6d85;z-index:11}}
</style></head><body>
<div id="bar"></div>
<div id="deck">{''.join(slides_html)}</div>
<div id="notes">{''.join(notes_html)}</div>
<div id="help">← → 翻页 · N 讲稿 · F 全屏 · 共 {len(SLIDES)} 页</div>
<script>
var slides=[].slice.call(document.querySelectorAll('.slide'));
var notes=[].slice.call(document.querySelectorAll('.note-slide'));
var i=0;
function show(n){{
  i=Math.max(0,Math.min(slides.length-1,n));
  slides.forEach(function(s,k){{s.classList.toggle('on',k===i)}});
  notes.forEach(function(s,k){{s.classList.toggle('on',k===i)}});
  document.getElementById('bar').style.width=((i+1)/slides.length*100)+'%';
  var b=slides[i].querySelector('.body'); if(b) b.scrollTop=0;
}}
document.addEventListener('keydown',function(e){{
  var k=e.key;
  if(k==='ArrowRight'||k==='PageDown'||k===' '){{show(i+1);e.preventDefault();}}
  else if(k==='ArrowLeft'||k==='PageUp'){{show(i-1);e.preventDefault();}}
  else if(k==='Home'){{show(0);}} else if(k==='End'){{show(slides.length-1);}}
  else if(k==='n'||k==='N'){{document.getElementById('notes').classList.toggle('on');}}
  else if(k==='f'||k==='F'){{if(document.fullscreenElement)document.exitFullscreen();
    else document.documentElement.requestFullscreen();}}
}});
document.addEventListener('click',function(e){{
  if(e.target.closest('figure')||e.target.closest('#notes'))return;
  show(e.clientX < window.innerWidth*0.28 ? i-1 : i+1);
}});
show(0);
</script></body></html>"""


html = render().replace("@@ARCH@@", ARCH)
out = OUT / "面试演示台.html"
out.write_text(html, encoding="utf-8")
print("written:", out)
print("slides:", len(SLIDES))
print("size: %.2f MB" % (out.stat().st_size / 1024 / 1024))
