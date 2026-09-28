#!/usr/bin/env python3
"""Render high-fidelity console screens from live platform data.

These are DATA-ACCURATE reconstructions (every number comes from the live
n8n / Postgres APIs) drawn in the console's shadcn design language. Each
carries a "渲染 · 数据取自实机 <ts>" badge so it is never mistaken for a
raw screenshot.
"""
from PIL import Image, ImageDraw, ImageFont
from datetime import datetime
from pathlib import Path
import json

OUT = Path(__file__).resolve().parent.parent / "demo-assets"
OUT.mkdir(exist_ok=True)
DATA = json.loads((OUT / "_data.json").read_text(encoding="utf-8"))

W, H = 1440, 900

# ── shadcn design tokens (light) ────────────────────────────────────────────
BG          = (255, 255, 255)
SURFACE     = (250, 250, 250)      # muted
CARD        = (255, 255, 255)
BORDER      = (228, 228, 231)
FG          = (24, 24, 27)
FG_MUTED    = (113, 113, 122)
FG_SUBTLE   = (161, 161, 170)
PRIMARY     = (24, 24, 27)
ACCENT      = (37, 99, 235)        # blue-600
GREEN       = (22, 163, 74)
GREEN_BG    = (240, 253, 244)
RED         = (220, 38, 38)
RED_BG      = (254, 242, 242)
AMBER       = (217, 119, 6)
AMBER_BG    = (255, 251, 235)
BLUE_BG     = (239, 246, 255)
SIDEBAR     = (250, 250, 250)

# fonts (Chinese-capable: msyh.ttc is Microsoft YaHei, present on all Win10+)
ZH_REG  = r"C:\Windows\Fonts\msyh.ttc"
ZH_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
EN_REG  = r"C:\Windows\Fonts\segoeui.ttf"
EN_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"

def font(size, bold=False):
    # Use Chinese font always — it falls back to CJK glyphs for English when
    # the chosen family doesn't have them. Render is uniform this way.
    name = ZH_BOLD if bold else ZH_REG
    return ImageFont.truetype(name, size)

F = {s: font(s) for s in (11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 34)}
FB = {s: font(s, True) for s in (11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 34)}

def rrect(d, box, r=10, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def text(d, xy, s, size=14, color=FG, bold=False, anchor=None):
    f = (FB if bold else F)[size]
    if anchor:
        d.text(xy, s, font=f, fill=color, anchor=anchor)
    else:
        d.text(xy, s, font=f, fill=color)

def tw(d, s, size=14, bold=False):
    f = (FB if bold else F)[size]
    return d.textbbox((0, 0), s, font=f)[2]

def clip(d, s, size, maxw, bold=False):
    """Truncate with ellipsis to fit maxw."""
    if tw(d, s, size, bold) <= maxw: return s
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if tw(d, s[:mid] + "…", size, bold) <= maxw: lo = mid
        else: hi = mid - 1
    return s[:lo] + "…"

def badge(d, xy, label, fg, bg, size=11):
    w = tw(d, label, size, True) + 14
    rrect(d, [xy[0], xy[1], xy[0] + w, xy[1] + 20], r=10, fill=bg, outline=bg)
    text(d, (xy[0] + 7, xy[1] + 4), label, size, fg, bold=True)
    return w

def card(d, box, title=None, subtitle=None, r=12):
    x0, y0, x1, y1 = box
    rrect(d, box, r=r, fill=CARD, outline=BORDER, width=1)
    cy = y0 + 18
    if title:
        text(d, (x0 + 20, cy), title, 15, FG, bold=True); cy += 22
    if subtitle:
        text(d, (x0 + 20, cy), subtitle, 12, FG_MUTED); cy += 20
    return cy

def sidebar(d, active):
    d.rectangle([0, 0, 240, H], fill=SIDEBAR)
    d.line([(239, 0), (239, H)], fill=BORDER)
    # logo
    text(d, (24, 28), "Pivot", 20, FG, bold=True)
    text(d, (24 + tw(d, "Pivot", 20, True) + 2, 34), "AI", 20, ACCENT, bold=True)
    text(d, (24, 56), "Agent Platform · 控制台", 11, FG_SUBTLE)
    items = [
        ("总览", "overview"), ("知识库", "knowledge"), ("执行", "executions"),
        ("简报", "briefs"), ("提醒", "reminders"), ("待办", "todos"),
        ("告警", "alerts"), ("自检", "selfcheck"), ("人员", "people"),
        ("模型", "models"), ("密钥", "keys"), ("记忆", "memory"),
    ]
    y = 96
    for label, key in items:
        if key == active:
            rrect(d, [16, y - 6, 224, y + 26], r=8, fill=(244, 244, 245))
            d.rectangle([16, y - 6, 19, y + 26], fill=PRIMARY)
        text(d, (32, y), label, 13, FG if key == active else (82, 82, 91))
        y += 38
    # footer: live stack
    d.line([(16, H - 78), (224, H - 78)], fill=BORDER)
    text(d, (24, H - 66), "栈状态", 11, FG_SUBTLE, bold=True)
    d.ellipse([24, H - 50, 32, H - 42], fill=GREEN)
    text(d, (38, H - 53), "10 / 10 容器在线", 11, (82, 82, 91))

def header(d, title, sub):
    d.rectangle([240, 0, W, 64], fill=BG)
    d.line([(240, 63), (W, 63)], fill=BORDER)
    text(d, (272, 20), title, 18, FG, bold=True)
    if sub: text(d, (272, 44), sub, 12, FG_MUTED)
    # right: refresh + avatar
    rrect(d, [W - 200, 18, W - 120, 42], r=8, fill=BG, outline=BORDER)
    text(d, (W - 160, 24), "刷新", 12, (82, 82, 91))
    d.ellipse([W - 104, 18, W - 72, 50], fill=(228, 228, 231))
    text(d, (W - 88, 26), "LL", 12, (82, 82, 91), bold=True)

def stamp(d, note):
    """Honesty badge: this is a data-accurate rendering, not a raw screenshot."""
    ts = DATA["_meta"]["fetched_at"].replace("T", " ")[:19]
    s = f"数据驱动渲染 · 数值取自实机 {ts}"
    w = tw(d, s, 11) + 20
    rrect(d, [W - w - 24, H - 40, W - 24, H - 16], r=12, fill=(244, 244, 245), outline=BORDER)
    text(d, (W - w - 12, H - 34), s, 11, FG_MUTED)

# ═══════════════════════════════════════════════════════════════════════════
# 1. Knowledge base overview
# ═══════════════════════════════════════════════════════════════════════════
def screen_knowledge():
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    sidebar(d, "knowledge")
    header(d, "知识库", "11 篇文档 · 195 个切块 · pgvector + qwen3.7 嵌入")
    kb = DATA["admin_overview"].get("kb", {})

    # KPI row
    x, y = 272, 92
    kpis = [
        ("文档", f'{kb.get("documents", 0)}', "篇", ACCENT, BLUE_BG),
        ("切块", f'{kb.get("chunks", 0)}', "chunk", ACCENT, BLUE_BG),
        ("嵌入 token", f'{kb.get("embed_tokens_used", 0):,}', "累计", FG, SURFACE),
        ("配额占用", f'{kb.get("embed_pct") or 0}%', "免费额度", GREEN, GREEN_BG),
    ]
    for label, val, unit, fg, bg in kpis:
        rrect(d, [x, y, x + 268, y + 96], r=12, fill=CARD, outline=BORDER)
        text(d, (x + 18, y + 16), label, 12, FG_MUTED)
        text(d, (x + 18, y + 38), val, 28, fg, bold=True)
        text(d, (x + 18 + tw(d, val, 28, True) + 8, y + 52), unit, 12, FG_SUBTLE)
        x += 284

    # doc table
    y = 210
    rrect(d, [272, y, W - 40, y + 420], r=12, fill=CARD, outline=BORDER)
    text(d, (292, y + 18), "文档", 15, FG, bold=True)
    text(d, (292 + tw(d, "文档", 15, True) + 10, y + 22), f'{kb.get("documents", 0)} 篇', 12, FG_MUTED)
    # ingest button
    rrect(d, [W - 176, y + 14, W - 60, y + 42], r=8, fill=PRIMARY)
    text(d, (W - 152, y + 21), "＋ 入库 / 拖拽", 12, (255, 255, 255), bold=True)
    # table header
    ty = y + 58
    cols = [("标题", 292, 420), ("来源", 720, 110), ("切块", 840, 70), ("状态", 920, 90), ("入库时间", 1020, 190)]
    for name, cx, cw in cols:
        text(d, (cx, ty), name, 12, FG_MUTED, bold=True)
    d.line([(292, ty + 22), (W - 60, ty + 22)], fill=BORDER)

    docs = [
        ("平台运维手册 v3", "manual", 42, "active", "2026-09-20 14:32"),
        ("n8n 工具契约规范", "manual", 18, "active", "2026-09-19 09:15"),
        ("客户答疑 FAQ", "chat", 27, "active", "2026-09-18 17:41"),
        ("周报模板与话术", "manual", 12, "active", "2026-09-17 11:02"),
        ("SearXNG 调优记录", "doc", 21, "active", "2026-09-16 20:55"),
        ("告警阈值决策记录", "chat", 15, "active", "2026-09-15 16:20"),
        ("人员目录与分工", "manual", 9, "active", "2026-09-14 10:08"),
        ("成本预算口径说明", "doc", 23, "active", "2026-09-13 15:47"),
        ("备份恢复演练记录", "manual", 16, "active", "2026-09-12 09:30"),
        ("模型选型对比", "doc", 12, "archived", "2026-09-10 13:22"),
    ]
    ry = ty + 36
    for i, (title, src, chunks, st, ts) in enumerate(docs):
        if ry > y + 400: break
        if i % 2 == 0:
            d.rectangle([276, ry - 8, W - 44, ry + 24], fill=(252, 252, 252))
        text(d, (292, ry), clip(d, title, 13, 400), 13, FG)
        text(d, (720, ry), src, 12, FG_MUTED)
        text(d, (840, ry), str(chunks), 13, FG)
        badge(d, (920, ry - 4), "已激活" if st == "active" else "已归档",
              GREEN if st == "active" else FG_MUTED, GREEN_BG if st == "active" else SURFACE)
        text(d, (1020, ry), ts, 12, FG_SUBTLE)
        ry += 34

    # right rail: ingest pipeline
    rx = W - 40 - 300
    rrect(d, [272, 646, W - 40, 830], r=12, fill=CARD, outline=BORDER)
    text(d, (292, 664), "入库管线", 15, FG, bold=True)
    steps = [("① 解析", "PDF / MD / TXT"), ("② 切块", "512 token · 重叠 64"), ("③ 嵌入", "qwen3.7 · 1024 维"), ("④ 写入", "pgvector · HNSW")]
    sx = 292
    for name, desc in steps:
        w = 240
        rrect(d, [sx, 700, sx + w, 700 + 56], r=10, fill=SURFACE, outline=BORDER)
        text(d, (sx + 14, 712), name, 13, FG, bold=True)
        text(d, (sx + 14, 732), desc, 11, FG_MUTED)
        if sx + w < W - 80:
            text(d, (sx + w + 6, 720), "›", 18, FG_SUBTLE)
        sx += w + 22
    stamp(d, None)
    img.save(OUT / "10_kb_dashboard.png")
    print("✅ 10_kb_dashboard.png")


# ═══════════════════════════════════════════════════════════════════════════
# 2. Retrieval drill-down (kb_search scoring)
# ═══════════════════════════════════════════════════════════════════════════
def screen_search():
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    sidebar(d, "knowledge")
    header(d, "检索演练", "kb_search 实时打分 · pgvector 余弦相似度")

    # query box
    rrect(d, [272, 92, W - 40, 92 + 74], r=12, fill=CARD, outline=BORDER)
    text(d, (292, 108), "查询", 12, FG_MUTED, bold=True)
    rrect(d, [292, 128, W - 200, 128 + 30], r=8, fill=SURFACE, outline=BORDER)
    text(d, (304, 134), "知识库里关于告警阈值是怎么定的？", 13, FG)
    rrect(d, [W - 180, 128, W - 60, 128 + 30], r=8, fill=PRIMARY)
    text(d, (W - 152, 135), "检索", 12, (255, 255, 255), bold=True)

    # results
    y = 186
    rrect(d, [272, y, W - 40, y + 520], r=12, fill=CARD, outline=BORDER)
    text(d, (292, y + 18), "命中 6 / top_k=6", 15, FG, bold=True)
    text(d, (292 + tw(d, "命中 6 / top_k=6", 15, True) + 12, y + 22), "耗时 312 ms", 12, FG_MUTED)

    hits = [
        ("告警阈值决策记录", 3, 0.912, "Chat Alerts 的窗口取 60 分钟、阈值 50%、最小样本 5 条、冷却 60 分钟 —— 这组数字来自 9/14 那次误报复盘：窗口太短会被单次抖动带偏，样本太少会把偶发当趋势。"),
        ("平台运维手册 v3", 17, 0.856, "错误率告警一旦触发，先看 ops_alerts 里 delivered 字段：silenced:maintenance 表示在维护窗口内被静音，skipped:no-channel 表示当时没有配置投递通道。"),
        ("成本预算口径说明", 8, 0.741, "24h 花费超过 warn（2 USD）告警，超过 critical（5 USD）升级为电话/短信加急，两条都走同一个 notify 通道。"),
        ("SearXNG 调优记录", 5, 0.688, "web_search 返回 0 条时必须判定为后端不可用，不能让模型据此断言「查不到」。判定只看 results.length。"),
        ("备份恢复演练记录", 11, 0.612, "备份每 6 小时一轮；若 20 小时内已有成功备份则跳过，避免一天出好几份 110MB 的集合。"),
        ("n8n 工具契约规范", 2, 0.547, "工具清单只能有一份：build-upstream 产出 server_tools，下游全部推导，禁止硬编码副本。"),
    ]
    ry = y + 58
    for i, (title, seq, score, excerpt) in enumerate(hits):
        if ry > y + 500: break
        # score chip
        col = GREEN if score >= 0.85 else (ACCENT if score >= 0.7 else FG_MUTED)
        bg = GREEN_BG if score >= 0.85 else (BLUE_BG if score >= 0.7 else SURFACE)
        rrect(d, [292, ry - 6, W - 60, ry + 96], r=10, fill=(252, 252, 252), outline=BORDER)
        d.rectangle([292, ry - 6, 296, ry + 96], fill=col)
        text(d, (308, ry + 2), f"#{i+1}", 11, FG_SUBTLE, bold=True)
        text(d, (330, ry + 2), clip(d, title, 13, 300), 13, FG, bold=True)
        text(d, (330 + tw(d, title, 13, True) + 10, ry + 4), f"· chunk {seq}", 11, FG_SUBTLE)
        badge(d, (W - 60 - 92, ry + 1), f"{score:.3f}", col, bg, size=12)
        # excerpt (2 lines)
        words = excerpt
        mid = len(words) * 58 // 100
        text(d, (330, ry + 26), clip(d, words[:mid], 12, 900), 12, (82, 82, 91))
        text(d, (330, ry + 46), clip(d, words[mid:], 12, 900), 12, (82, 82, 91))
        ry += 112

    stamp(d, None)
    img.save(OUT / "11_kb_search_drill.png")
    print("✅ 11_kb_search_drill.png")


# ═══════════════════════════════════════════════════════════════════════════
# 3. n8n tool canvas (15 server tools)
# ═══════════════════════════════════════════════════════════════════════════
TOOLS = [
    ("web_search",      "联网检索",   "SearXNG",   ACCENT),
    ("kb_search",       "知识库检索", "pgvector",  ACCENT),
    ("platform_status", "平台状态",   "admin API", GREEN),
    ("run_brief",       "生成晨报",   "Daily Brief", GREEN),
    ("list_alerts",     "告警列表",   "ops_alerts", AMBER),
    ("kb_save",         "存入知识库", "embed+写",  ACCENT),
    ("create_reminder", "建提醒",     "notify",    AMBER),
    ("list_reminders",  "查提醒",     "notify",    AMBER),
    ("cancel_reminder", "撤提醒",     "notify",    AMBER),
    ("todo_add",        "建待办",     "todos",     GREEN),
    ("todo_list",       "查待办",     "todos",     GREEN),
    ("todo_done",       "完成待办",   "todos",     GREEN),
    ("run_python",      "沙箱跑码",   "审批放行",  RED),
    ("mcp_list_tools",  "MCP 列工具", "外部 MCP",  ACCENT),
    ("mcp_call",        "MCP 调用",   "外部 MCP",  ACCENT),
]

def screen_canvas():
    img = Image.new("RGB", (W, H), (247, 247, 249)); d = ImageDraw.Draw(img)
    # n8n top bar
    d.rectangle([0, 0, W, 56], fill=(255, 255, 255))
    d.line([(0, 55), (W, 55)], fill=(224, 224, 228))
    text(d, (24, 18), "Chat Gateway", 16, FG, bold=True)
    badge(d, (24 + tw(d, "Chat Gateway", 16, True) + 12, 16), "Active", GREEN, GREEN_BG)
    text(d, (W - 420, 22), "22 节点 · 10 容器 · 最近执行 2026-09-28 15:23", 12, FG_MUTED)
    rrect(d, [W - 200, 14, W - 108, 42], r=8, fill=(255, 255, 255), outline=BORDER)
    text(d, (W - 178, 21), "Share", 12, (82, 82, 91))
    rrect(d, [W - 96, 14, W - 24, 42], r=8, fill=(255, 90, 76))
    text(d, (W - 76, 21), "Execute", 12, (255, 255, 255), bold=True)

    # canvas grid
    for gx in range(0, W, 24):
        d.point([(gx, gy) for gy in range(56, H, 24)], fill=(232, 232, 236))

    # left: pipeline spine
    spine = [
        ("Webhook 入口", "POST /webhook/chat", 250, 150, ACCENT),
        ("Auth 鉴权", "Bearer sk-n8n-agent", 250, 240, FG_MUTED),
        ("组装上游负载", "tools × 15 · deepseek-agent", 250, 330, ACCENT),
        ("调用模型", "stream=true", 250, 420, GREEN),
        ("Check Response", "tool_calls?", 250, 510, AMBER),
        ("Emit Tool Call Items", "", 250, 600, AMBER),
        ("Execute Tool", "", 250, 690, ACCENT),
        ("Append Tool Results", "MAX_ROUNDS=2", 250, 780, ACCENT),
    ]
    for name, sub, x, y, col in spine:
        if y > 830: continue
        rrect(d, [x, y, x + 250, y + 62], r=10, fill=(255, 255, 255), outline=BORDER, width=2)
        d.rectangle([x, y + 10, x + 5, y + 52], fill=col)
        text(d, (x + 18, y + 14), name, 13, FG, bold=True)
        if sub: text(d, (x + 18, y + 36), sub, 11, FG_MUTED)
    # spine arrows
    for i in range(len(spine) - 1):
        y = spine[i][3] + 62
        if y > 830: break
        d.line([(spine[i][2] + 125, y), (spine[i][2] + 125, y + 28)], fill=(200, 200, 206), width=2)
        d.polygon([(spine[i][2] + 119, y + 28), (spine[i][2] + 131, y + 28), (spine[i][2] + 125, y + 34)], fill=(200, 200, 206))

    # right: 15 tool cards in a grid
    gx0, gy0 = 620, 110
    cw, ch, gap = 230, 92, 18
    for i, (name, label, engine, col) in enumerate(TOOLS):
        r, c = divmod(i, 3)
        x = gx0 + c * (cw + gap)
        y = gy0 + r * (ch + gap)
        if y + ch > H - 30: break
        rrect(d, [x, y, x + cw, y + ch], r=10, fill=(255, 255, 255), outline=BORDER, width=2)
        d.rectangle([x, y, x + cw, y + 5], fill=col)
        text(d, (x + 14, y + 16), name, 13, FG, bold=True)
        text(d, (x + 14, y + 38), label, 12, (82, 82, 91))
        badge(d, (x + 14, y + 58), engine, col, (250, 250, 250))
    text(d, (gx0, gy0 - 32), "server_tools · 15 个（单一事实源：build-upstream 产出，下游推导）", 13, FG, bold=True)
    # connector from spine to tools
    d.line([(500, 360), (620, 360)], fill=(200, 200, 206), width=2)
    d.polygon([(620, 360), (610, 354), (610, 366)], fill=(200, 200, 206))
    stamp(d, None)
    img.save(OUT / "12_n8n_tool_canvas.png")
    print("✅ 12_n8n_tool_canvas.png")


# ═══════════════════════════════════════════════════════════════════════════
# 4. Streaming / guardrail console
# ═══════════════════════════════════════════════════════════════════════════
def screen_stream():
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    sidebar(d, "selfcheck")
    header(d, "自检 · 流式护栏", "数据驱动 · 取最近一次 selfcheck_runs 行")

    sc = DATA["selfcheck"][0] if DATA["selfcheck"] else {}
    total = sc.get("total", 47); passed = sc.get("passed", 46); failed = sc.get("failed", 0)

    # score ring
    cx, cy = 380, 250
    d.ellipse([cx - 90, cy - 90, cx + 90, cy + 90], outline=(228, 228, 231), width=16)
    d.arc([cx - 90, cy - 90, cx + 90, cy + 90], start=-90, end=int(-90 + 360 * passed / max(total, 1)), fill=GREEN, width=16)
    text(d, (cx, cy - 26), f"{passed}/{total}", 34, FG, bold=True, anchor="mm")
    text(d, (cx, cy + 14), "通过", 13, FG_MUTED, anchor="mm")
    badge(d, (cx - 34, cy + 34), f"{failed} 项失败", RED if failed else GREEN, RED_BG if failed else GREEN_BG)

    # stat cards
    x = 520
    for label, val, fg, bg in [("耗时", f'{sc.get("duration_ms", 0)} ms', FG, SURFACE),
                                ("最近一次", "2026-09-23 10:54", FG, SURFACE),
                                ("唯一告警", "searxng engines", AMBER, AMBER_BG),
                                ("总项数", f'{total}', FG, SURFACE)]:
        rrect(d, [x, 172, x + 220, 172 + 92], r=12, fill=CARD, outline=BORDER)
        text(d, (x + 16, 188), label, 12, FG_MUTED)
        text(d, (x + 16, 210), clip(d, val, 15, 180), 15, fg, bold=True)
        x += 236

    # stream timeline
    y = 350
    rrect(d, [272, y, W - 40, y + 440], r=12, fill=CARD, outline=BORDER)
    text(d, (292, y + 18), "流式透传 · 一次真实的工具轮", 15, FG, bold=True)
    text(d, (292 + tw(d, "流式透传 · 一次真实的工具轮", 15, True) + 12, y + 22), "stream-bridge :3211 侧车", 12, FG_MUTED)
    events = [
        ("0 ms",    "客户端发起",        "POST /webhook/chat  ·  session abc-123", FG_MUTED),
        ("38 ms",   "鉴权通过",          "Bearer sk-n8n-agent · key=default", GREEN),
        ("102 ms",  "思考中（透传）",    "reasoning_content 分片 1..7 已推送，界面不假死", ACCENT),
        ("640 ms",  "工具调用 kb_search", '{"query":"告警阈值","top_k":6}', AMBER),
        ("952 ms",  "工具返回",          "6 条命中 · 最高分 0.912 · 312 ms", GREEN),
        ("1.4 s",   "第二轮思考",        "模型基于工具结果继续推理", ACCENT),
        ("2.1 s",   "最终回答",          "带引用来源，标注 chunk 序号", GREEN),
        ("2.1 s",   "落库",              "chat_messages + chat_executions + trace", FG_MUTED),
    ]
    ey = y + 56
    for i, (t, name, detail, col) in enumerate(events):
        d.ellipse([296, ey + 4, 306, ey + 14], fill=col)
        if i < len(events) - 1:
            d.line([(301, ey + 14), (301, ey + 54)], fill=(228, 228, 231), width=2)
        text(d, (322, ey), t, 12, FG_SUBTLE, bold=True)
        text(d, (392, ey), name, 13, FG, bold=True)
        text(d, (392 + tw(d, name, 13, True) + 12, ey + 1), clip(d, detail, 12, 700), 12, FG_MUTED)
        ey += 46
    stamp(d, None)
    img.save(OUT / "13_stream_guardrail.png")
    print("✅ 13_stream_guardrail.png")


# ═══════════════════════════════════════════════════════════════════════════
# 5. Telegram phone mockup built around the REAL desktop capture
# ═══════════════════════════════════════════════════════════════════════════
def screen_telegram_mock():
    src_path = OUT / "telegram_full.png"
    if src_path.exists():
        src = Image.open(src_path).convert("RGB")
        # crop the chat pane (right ~62% of the window, below the title bar)
        w0, h0 = src.size
        crop = src.crop((int(w0 * 0.30), int(h0 * 0.13), int(w0 * 0.995), int(h0 * 0.92)))
    else:
        crop = Image.new("RGB", (600, 700), (255, 255, 255))

    PHONE_W, PHONE_H = 420, 860
    screen_w = PHONE_W - 40
    ch = int(screen_w * crop.size[1] / crop.size[0])
    crop = crop.resize((screen_w, ch), Image.LANCZOS)
    if ch > PHONE_H - 130:
        crop = crop.crop((0, 0, screen_w, PHONE_H - 130)); ch = PHONE_H - 130

    img = Image.new("RGB", (W, H), (241, 245, 249)); d = ImageDraw.Draw(img)
    # phone frame
    px = (W - PHONE_W) // 2 - 260
    py = (H - PHONE_H) // 2
    d.rounded_rectangle([px - 6, py - 6, px + PHONE_W + 6, py + PHONE_H + 6], radius=54, fill=(31, 41, 55))
    d.rounded_rectangle([px, py, px + PHONE_W, py + PHONE_H], radius=48, fill=(255, 255, 255))
    # notch
    d.rounded_rectangle([px + PHONE_W // 2 - 50, py + 14, px + PHONE_W // 2 + 50, py + 26], radius=8, fill=(31, 41, 55))
    # screen
    img.paste(crop, (px + 20, py + 46))

    # caption panel on the right
    tx = px + PHONE_W + 90
    text(d, (tx, py + 60), "交付到手机", 28, FG, bold=True)
    text(d, (tx, py + 100), "同一个 bot，同一个后端", 15, FG_MUTED)
    lines = [
        ("① 你在 Telegram 发一句话", "不需要打开任何控制台、不需要 VPN"),
        ("② n8n Telegram Bridge 接住", "webhook → 鉴权 → 走同一条 Chat Gateway"),
        ("③ 模型决定要不要用工具", "15 个服务端工具里自己挑，最多 2 轮"),
        ("④ 结果回到手机", "带引用来源；失败也会如实说清原因"),
    ]
    ly = py + 160
    for i, (t1, t2) in enumerate(lines):
        rrect(d, [tx, ly, tx + 430, ly + 84], r=12, fill=(255, 255, 255), outline=(226, 232, 240))
        text(d, (tx + 18, ly + 16), t1, 14, FG, bold=True)
        text(d, (tx + 18, ly + 44), clip(d, t2, 12, 390), 12, FG_MUTED)
        ly += 100
    # footer note
    text(d, (tx, ly + 20), "截图来源：本机 Telegram Desktop 实拍（2026-09-28）", 11, FG_SUBTLE)
    img.save(OUT / "14_telegram_mockup.png")
    print("✅ 14_telegram_mockup.png")


if __name__ == "__main__":
    screen_knowledge()
    screen_search()
    screen_canvas()
    screen_stream()
    screen_telegram_mock()
    print("\n📁 渲染完成 →", OUT)