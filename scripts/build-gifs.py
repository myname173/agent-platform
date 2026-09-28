#!/usr/bin/env python3
"""Generate 5 animated GIFs from existing screenshots / renders.

Each GIF loops in 3–8 s and is small enough to embed in the demo deck.
"""
from PIL import Image, ImageDraw, ImageFont, ImageSequence
from pathlib import Path
import math, time

OUT = Path(__file__).resolve().parent.parent / "demo-assets"

ZH_REG  = r"C:\Windows\Fonts\msyh.ttc"
ZH_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
def F(size, bold=False): return ImageFont.truetype(ZH_BOLD if bold else ZH_REG, size)
FF = {s: F(s) for s in (10, 11, 12, 13, 14, 15, 16, 18, 20, 24)}
FFB = {s: F(s, True) for s in (10, 11, 12, 13, 14, 15, 16, 18, 20, 24)}

def t(d, xy, s, size=14, color=(24, 24, 27), bold=False, anchor=None):
    d.text(xy, s, font=(FFB if bold else FF)[size], fill=color, anchor=anchor)

def w(d, s, size=14, bold=False):
    return d.textbbox((0, 0), s, font=(FFB if bold else FF)[size])[2]

def rrect(d, box, r=10, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def clip(s, maxw, size=12, bold=False):
    if w(_dummy_draw(), s, size, bold) <= maxw: return s
    return s[:max(0, maxw // size - 2)] + "…"

class _dummy_draw:
    def textbbox(self, *_a, **_kw): return (0, 0, w_draw(*_a, **_kw), 0)
def w_draw(s, size, bold): return ImageDraw.Draw(Image.new("RGB",(10,10))).textbbox((0,0),s,font=(FFB if bold else FF)[size])[2]


def save_gif(path, frames, duration=80, loop=0):
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=duration, loop=loop, optimize=True)
    kb = path.stat().st_size // 1024
    print(f"✅ {path.name}  ({len(frames)} 帧 · {kb} KB · {duration*len(frames)/1000:.1f}s)")


# ═══════════════════════════════════════════════════════════════════════════
# GIF 1 · 拖拽入库 + 切块预览
# ═══════════════════════════════════════════════════════════════════════════
def gif_drag_upload():
    W, H = 900, 540
    base = Image.open(OUT / "10_kb_dashboard.png").convert("RGB").resize((W, H), Image.LANCZOS)
    frames = []
    n = 32

    cursor = (640, 200)  # file being dragged

    for i in range(n):
        f = base.copy()
        d = ImageDraw.Draw(f)
        prog = i / (n - 1)
        # drop zone highlight grows then fades
        opa = max(0, 1 - abs(prog - 0.55) * 2.5)
        if opa > 0:
            rrect(d, [180, 260, 720, 360], r=18, fill=(37, 99, 235, int(opa*40)))
            rrect(d, [180, 260, 720, 360], r=18, outline=(37, 99, 235, int(opa*255)), width=3)
            t(d, (450, 296), "松开即可入库", 16, (37, 99, 235, int(opa*255)), bold=True, anchor="mm")
        # ghost file being dragged
        cx, cy = cursor
        # animate file from upper right to drop zone
        if prog < 0.5:
            jx = cx - (0.5 - prog) * 280
            jy = cy - (0.5 - prog) * 80
        else:
            jx, jy = cx, cy
        rrect(d, [jx - 60, jy - 30, jx + 60, jy + 30], r=8, fill=(255, 255, 255), outline=(37, 99, 235), width=2)
        t(d, (jx, jy - 4), "📄 平台手册.docx", 12, (24, 24, 27), anchor="mm")
        t(d, (jx, jy + 12), "1.2 MB", 10, (113, 113, 122), anchor="mm")
        # chunk preview animation: after 60% of progress
        if prog > 0.62:
            chunk_alpha = min(1, (prog - 0.62) / 0.18)
            cy2 = 430 + (1 - chunk_alpha) * 16
            rrect(d, [180, int(cy2), 720, int(cy2) + 90], r=12, fill=(255, 255, 255), outline=(228, 228, 231))
            t(d, (200, int(cy2) + 10), "正在切块…", 12, (37, 99, 235), bold=True)
            # animated chunk bars
            for k in range(6):
                bx = 200 + k * 86
                bh = int((math.sin(time.time()*4 + k) * 0.5 + 0.5) * 28) + 6
                rrect(d, [bx, int(cy2) + 60 - bh, bx + 76, int(cy2) + 60], r=4, fill=(37, 99, 235))
            t(d, (200, int(cy2) + 36), "已切 18 chunk · 嵌入中…", 11, (113, 113, 122))
        frames.append(f)
    save_gif(OUT / "gif_01_drag_upload.gif", frames, duration=70)


# ═══════════════════════════════════════════════════════════════════════════
# GIF 2 · 检索打分实时滚动
# ═══════════════════════════════════════════════════════════════════════════
def gif_search_scoring():
    W, H = 900, 540
    base = Image.open(OUT / "11_kb_search_drill.png").convert("RGB").resize((W, H), Image.LANCZOS)
    frames = []
    n = 36

    # 6 hits with progressive scores
    titles = ["告警阈值决策记录", "平台运维手册 v3", "成本预算口径说明",
              "SearXNG 调优记录", "备份恢复演练记录", "n8n 工具契约规范"]
    targets = [0.912, 0.856, 0.741, 0.688, 0.612, 0.547]

    chip_x, chip_y = 800, 102
    for i in range(n):
        f = base.copy()
        d = ImageDraw.Draw(f)
        prog = i / (n - 1)
        # counter at top-right that fills in
        if prog < 0.7:
            show = int(prog / 0.7 * 6) + 1
            t(d, (260, 80), f"命中 {show} / top_k=6", 14, (24, 24, 27), bold=True)
        else:
            t(d, (260, 80), "命中 6 / top_k=6", 14, (24, 24, 27), bold=True)
            t(d, (w(d, "命中 6 / top_k=6", 14, True) + 274, 82), "耗时 312 ms", 11, (113, 113, 122))
        # hit chips appear one by one
        for k, target in enumerate(targets):
            appear_at = (k + 1) / 7
            if prog < appear_at: continue
            local_p = (prog - appear_at) / max(1 - appear_at, 0.01)
            score = target * min(1, local_p * 3)
            col = (22, 163, 74) if score >= 0.85 else ((37, 99, 235) if score >= 0.7 else (113, 113, 122))
            bg = (240, 253, 244) if score >= 0.85 else ((239, 246, 255) if score >= 0.7 else (244, 244, 245))
            # find row position from base image
            hy = 162 + k * 92
            rrect(d, [290, hy, 880, hy + 86], r=10, fill=(252, 252, 252), outline=(228, 228, 231))
            d.rectangle([290, hy, 294, hy + 86], fill=col)
            t(d, (308, hy + 8), f"#{k+1}", 10, (161, 161, 170), bold=True)
            t(d, (332, hy + 8), titles[k], 13, (24, 24, 27), bold=True)
            rrect(d, [chip_x - 70, hy + 6, chip_x, hy + 30], r=12, fill=bg)
            t(d, (chip_x - 35, hy + 11), f"{score:.3f}", 12, col, bold=True, anchor="mm")
        frames.append(f)
    save_gif(OUT / "gif_02_search_scoring.gif", frames, duration=80)


# ═══════════════════════════════════════════════════════════════════════════
# GIF 3 · n8n 工具画布平移 + 工具高亮
# ═══════════════════════════════════════════════════════════════════════════
def gif_canvas_pan():
    W, H = 900, 540
    base = Image.open(OUT / "12_n8n_tool_canvas.png").convert("RGB").resize((W, H), Image.LANCZOS)
    frames = []
    n = 40

    # simulate horizontal pan then bounce back, with a glow traveling through the pipeline
    glow_color = (37, 99, 235)
    for i in range(n):
        f = base.copy()
        d = ImageDraw.Draw(f)
        prog = i / (n - 1)
        pan_x = int(math.sin(prog * math.pi * 2) * 12)
        if pan_x != 0:
            f = base.transform((W, H), Image.AFFINE, (1, 0, pan_x, 0, 1, 0), resample=Image.BILINEAR)
            d = ImageDraw.Draw(f)
        # glow traveling through the spine nodes (left column ~150-300 px)
        path_y = [150, 240, 330, 420, 510, 600, 690, 780]
        idx_f = prog * (len(path_y) - 1)
        idx = int(idx_f)
        if idx < len(path_y) - 1:
            x, y = 125, path_y[idx] + int((idx_f - idx) * (path_y[idx+1] - path_y[idx]))
        else:
            x, y = 125, path_y[-1]
        d.ellipse([x - 14, y - 14, x + 14, y + 14], fill=glow_color)
        d.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(255, 255, 255))
        # caption at the bottom
        if prog < 0.5:
            msg = "组装上游负载 · 注入 15 个服务端工具"
        else:
            msg = "模型自主决策 → 调用 → 回合结束"
        rrect(d, [200, 490, 700, 530], r=12, fill=(24, 24, 27))
        t(d, (450, 510), msg, 13, (255, 255, 255), bold=True, anchor="mm")
        frames.append(f)
    save_gif(OUT / "gif_03_n8n_canvas.gif", frames, duration=70)


# ═══════════════════════════════════════════════════════════════════════════
# GIF 4 · 流式思考透传（打字机效果）
# ═══════════════════════════════════════════════════════════════════════════
def gif_stream_thinking():
    W, H = 900, 540
    # start from the stream page
    base = Image.open(OUT / "13_stream_guardrail.png").convert("RGB").resize((W, H), Image.LANCZOS)
    frames = []
    n = 40

    # overlay typing area at the bottom
    full_text = "根据 0.912 分命中那段，告警阈值 50% / 60 分钟是最关键的——窗口太短会被单次抖动带偏，样本太少会把偶发当趋势。这两个数字 9/14 那次误报复盘后定下的。"
    for i in range(n):
        f = base.copy()
        d = ImageDraw.Draw(f)
        prog = i / (n - 1)
        # dim everything except the bottom
        mask = Image.new("RGB", (W, H), (255, 255, 255))
        # crop: erase top to highlight bottom area
        rrect(d, [60, 380, 840, 530], r=12, fill=(255, 255, 255), outline=(228, 228, 231), width=2)
        # type
        shown = full_text[: int(prog * len(full_text))]
        # wrap to width
        line1, line2 = "", ""
        for ch in shown:
            test = line1 + ch
            if w(d, test, 13) > 760:
                line2 = line2 + ch if not line2 else line2
                # actually fill line2
                break
            line1 += ch
        # simpler: render two lines with hard wrap
        line1 = shown
        if w(d, line1, 13) > 760:
            # split into two roughly equal halves
            cut = len(line1) * 760 // max(w(d, line1, 13), 1)
            line1, line2 = shown[:cut], shown[cut:]
            # rebalance: walk line1 to where width exceeds 760
            while w(d, line1, 13) > 760:
                line2 = line1[-1] + line2; line1 = line1[:-1]
        # simulate cursor
        cursor = "▍" if int(time.time() * 3) % 2 == 0 else " "
        t(d, (80, 400), "🤖 模型", 12, (37, 99, 235), bold=True)
        t(d, (130, 400), "(流式透传 · 不假死)", 11, (113, 113, 122))
        t(d, (80, 420), line1 + cursor, 13, (24, 24, 27))
        if line2: t(d, (80, 442), line2 + ("▍" if int(time.time() * 3) % 2 == 0 else ""), 13, (24, 24, 27))
        # pulse on the timeline
        ty = 100 + 460 * 30
        d.ellipse([296, ty + 4, 306, ty + 14], fill=(37, 99, 235))
        frames.append(f)
    save_gif(OUT / "gif_04_stream_thinking.gif", frames, duration=80)


# ═══════════════════════════════════════════════════════════════════════════
# GIF 5 · 电报手机样机
# ═══════════════════════════════════════════════════════════════════════════
def gif_telegram():
    W, H = 900, 540
    base = Image.open(OUT / "14_telegram_mockup.png").convert("RGB").resize((W, H), Image.LANCZOS)
    frames = []
    n = 36

    # animate a typing indicator appearing then a message bubble
    for i in range(n):
        f = base.copy()
        d = ImageDraw.Draw(f)
        prog = i / (n - 1)
        # typing dots: 1, 2, 3 dots alternating
        dots = "." * (((i // 3) % 3) + 1)
        # overlay a fake bubble on the phone chat area
        # phone center is around (300, 270) in base scaled to 900x540
        px, py = int(W * 0.25), int(H * 0.20)
        # typing indicator bubble inside screen
        if prog < 0.5:
            bubble_text = f"生成中{dots}"
            bw = w(d, bubble_text, 12) + 24
            rrect(d, [px + 24, py + 200, px + 24 + bw, py + 232], r=12, fill=(255, 255, 255), outline=(220, 220, 224))
            t(d, (px + 36, py + 209), bubble_text, 12, (113, 113, 122))
        else:
            # message appears
            local = (prog - 0.5) / 0.5
            msg = "[PivotAI] 晨报 · 2026-09-28\n要点 1：阿里云霍嘉指出企业\n级大模型能力不足…"
            # two-line bubble
            lines = msg.split("\n")
            bw = max(w(d, l, 12) for l in lines) + 24
            bh = len(lines) * 22 + 12
            rrect(d, [px + 24, py + 200, px + 24 + bw, py + 200 + bh], r=12, fill=(255, 255, 255), outline=(220, 220, 224))
            # typing text gradually appears
            for li, line in enumerate(lines):
                shown = line[: int(local * len(line))]
                t(d, (px + 36, py + 206 + li * 22), shown, 12, (24, 24, 27))
            # send indicator
            if local > 0.95:
                t(d, (px + 24 + bw + 8, py + 220), "已送达 ✓", 10, (37, 99, 235))
        frames.append(f)
    save_gif(OUT / "gif_05_telegram.gif", frames, duration=100)


if __name__ == "__main__":
    gif_drag_upload()
    gif_search_scoring()
    gif_canvas_pan()
    gif_stream_thinking()
    gif_telegram()
    print("\n📁 全部 GIF →", OUT)