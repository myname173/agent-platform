#!/usr/bin/env python3
"""Build a static-only, truthful flow deck from live captures.

Unlike deliverables/index.html (the original concept deck), this deck contains
no GIFs and no synthetic product-screen renders. It embeds only screenshots
captured from live browser/Desktop windows or raw HTTP API responses, with a
clear source label on each slide.
"""
import base64, html, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "deliverables" / "实机静态截图"
OUT = ROOT / "deliverables" / "静态截图版.html"
manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
items = [x for x in manifest["items"] if "error" not in x]
# Add the Desktop capture made by capture-window.py.
items.append({
    "file": "08_telegram_desktop_live.png",
    "label": "Telegram Desktop 当前窗口",
    "kind": "desktop-ui",
    "url": "Win32 HWND capture via scripts/capture-window.py",
    "final_url": "桌面窗口",
    "http_status": None,
    "title": "真实 Telegram Desktop 窗口",
    "truth": "Win32 PrintWindow(PW_RENDERFULLCONTENT) 直接捕获；不是手机样机"
})

# Stable order: browser entry points → public search/storage → raw evidence → TG.
order = {name: i for i, name in enumerate([
    "01_console_signin.png", "02_lobechat_signin.png", "03_n8n_signin.png",
    "04_searxng_search.png", "05_minio_console.png", "06_platform_health.json.png",
    "07_n8n_workflows.json.png", "08_telegram_desktop_live.png"
])}
items.sort(key=lambda x: order.get(x["file"], 999))
(SRC / "static-manifest.json").write_text(json.dumps({"items": items}, ensure_ascii=False, indent=2), encoding="utf-8")

def data_uri(path):
    mime = "image/png"
    return "data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode()

cards = []
for n, item in enumerate(items, 1):
    p = SRC / item["file"]
    if not p.exists():
        continue
    status = (f"HTTP {item['http_status']}" if item.get("http_status") is not None else "DESKTOP")
    cards.append(f'''<section class="shot" id="shot-{n}">
      <div class="shot-head"><span class="num">{n:02d}</span><div><div class="kicker">{html.escape(item['kind'])}</div><h2>{html.escape(item['label'])}</h2></div><span class="status">{html.escape(status)}</span></div>
      <div class="frame"><img src="{data_uri(p)}" alt="{html.escape(item['label'])}"></div>
      <div class="facts"><b>来源：</b>{html.escape(item.get('url',''))}<br><b>最终页面：</b>{html.escape(item.get('final_url',''))}<br><b>真实性：</b>{html.escape(item.get('truth','当前服务直接截图'))}</div>
    </section>''')

html_doc = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PivotAI · 实机静态截图流程</title>
<style>
:root{{--bg:#f4f6f8;--fg:#111827;--muted:#6b7280;--line:#dbe1e8;--blue:#2563eb;--bluebg:#eff6ff;--green:#15803d;--greenbg:#f0fdf4;--amber:#a16207;--amberbg:#fffbeb}}
*{{box-sizing:border-box}}html,body{{margin:0;background:var(--bg);color:var(--fg);font-family:"Microsoft YaHei","Segoe UI",sans-serif}}body{{padding:32px 0 90px}}
.wrap{{max-width:1280px;margin:0 auto;padding:0 32px}}.cover{{padding:44px 0 34px;border-bottom:1px solid var(--line)}}
.kicker{{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--blue);font-weight:700}}h1{{font-size:42px;line-height:1.15;margin:12px 0 14px}}h2{{font-size:24px;margin:0}}.lead{{font-size:17px;line-height:1.8;color:#374151;max-width:900px}}
.truth{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:22px}}.truth div{{background:#fff;border:1px solid var(--line);border-radius:12px;padding:15px 16px;line-height:1.55;font-size:13px}}.truth b{{display:block;font-size:15px;margin-bottom:5px}}.green{{color:var(--green);background:var(--greenbg)!important}}.amber{{color:var(--amber);background:var(--amberbg)!important}}
.shot{{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;margin:24px 0;box-shadow:0 5px 18px #1118270d;break-inside:avoid}}.shot-head{{display:flex;align-items:center;gap:14px;margin-bottom:16px}}.num{{display:grid;place-items:center;width:40px;height:40px;background:var(--blue);color:white;border-radius:12px;font-weight:800;font-size:16px}}.shot-head .kicker{{font-size:10px;margin-bottom:3px}}.status{{margin-left:auto;border-radius:999px;padding:6px 12px;background:var(--greenbg);color:var(--green);font-size:12px;font-weight:700}}.frame{{background:#111827;border-radius:10px;padding:8px;overflow:auto;text-align:center}}.frame img{{display:block;max-width:100%;max-height:760px;height:auto;margin:0 auto;background:white}}.facts{{font-size:12px;line-height:1.7;color:var(--muted);padding:12px 2px 0;word-break:break-word}}.facts b{{color:#374151}}
.foot{{position:fixed;bottom:0;left:0;right:0;background:#fffffff2;border-top:1px solid var(--line);padding:12px 24px;text-align:center;color:var(--muted);font-size:12px;backdrop-filter:blur(8px)}}
@media print{{body{{padding:0}}.cover{{page-break-after:always}}.shot{{page-break-after:always;box-shadow:none}}.foot{{display:none}}}}
</style></head><body><div class="wrap">
<div class="cover"><div class="kicker">PIVOT AI · STATIC EVIDENCE PACK</div><h1>全流程实机静态截图</h1><p class="lead">这版只放静态截图，不放 GIF，不放 PIL 合成产品界面。画面来自当前运行中的浏览器页面、桌面窗口或原始 HTTP API 响应。受鉴权保护的控制台内页没有被伪造；能截到什么，就如实放什么。</p>
<div class="truth"><div class="green"><b>实机 UI</b>登录页、SearXNG 搜索页、MinIO 登录页、Telegram Desktop 窗口</div><div class="green"><b>原始 API</b>健康响应、n8n 工作流 API 响应；仅作为技术证据，不冒充 UI</div><div class="amber"><b>明确缺口</b>当前没有登录后的控制台/KB/n8n 原生画布静态截图</div></div></div>
{''.join(cards)}
</div><div class="foot">静态截图版 · 由当前服务直接捕获 · 不含合成动效 · 用浏览器滚动或打印为 PDF</div></body></html>'''
OUT.write_text(html_doc, encoding="utf-8")
print(f"✅ {OUT}  ({OUT.stat().st_size/1024/1024:.2f} MB · {len(cards)} 张静态截图)")
