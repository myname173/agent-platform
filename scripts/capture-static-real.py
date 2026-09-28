#!/usr/bin/env python3
"""Capture a truthful static screenshot pack from currently running services.

This deliberately captures pages as they are; it does not draw synthetic UI.
Each file gets a sidecar manifest entry describing URL, final URL, HTTP title,
and whether it is a login page, a public UI, or raw API evidence.
"""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import json, os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

def env_value(name):
    """Read one value from the local gitignored .env without printing it."""
    p = ROOT / ".env"
    if not p.exists(): return ""
    prefix = name + "="
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(prefix): return line[len(prefix):].strip().strip("'").strip('"')
    return ""
OUT = ROOT / "deliverables" / "实机静态截图"
OUT.mkdir(parents=True, exist_ok=True)

cases = [
    ("01_console_signin.png", "http://localhost:3000/auth/sign-in", "控制台登录页", "browser-ui", 12000),
    ("02_lobechat_signin.png", "http://localhost:3210", "LobeChat登录页", "browser-ui", 3500),
    ("03_n8n_signin.png", "http://localhost:5678/signin", "n8n登录页", "browser-ui", 2500),
    ("04_searxng_search.png", "http://localhost:8080/search?q=agent+platform&format=html", "SearXNG真实搜索结果页", "browser-ui", 3500),
    ("05_minio_console.png", "http://localhost:9001/", "MinIO登录页或控制台", "browser-ui", 3500),
    ("06_platform_health.json.png", "http://localhost:3000/api/n8n/health", "控制台健康 API 原始响应", "raw-api", 1200),
    ("07_n8n_workflows.json.png", "http://localhost:5678/api/v1/workflows?limit=24&fields=id,name,active,updatedAt", "n8n工作流 API 原始响应（不嵌密钥）", "raw-api", 1500),
]

manifest = {"captured_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"), "items": []}

# Render raw API JSON in a real browser page with a minimal built-in browser
# view, so the screenshot is evidence of the actual HTTP response rather than
# a hand-drawn dashboard. The response text remains the source of truth.
raw_api_script = """
async ({url}) => {
  const r = await fetch(url);
  const text = await r.text();
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#0b1020;color:#dbeafe;font:16px Consolas,monospace;white-space:pre-wrap;padding:28px;';
  const h = document.createElement('h2');
  h.textContent = url;
  h.style.cssText = 'font:700 18px Segoe UI,sans-serif;color:#93c5fd;white-space:normal;margin:0 0 18px;';
  const p = document.createElement('div');
  p.textContent = text;
  document.body.append(h,p);
  return {status:r.status, text:text.slice(0,20000)};
}
"""

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    n8n_key = env_value("N8N_API_KEY")
    for filename, url, label, kind, wait in cases:
        try:
            if "localhost:5678/api/v1/" in url and n8n_key:
                page.set_extra_http_headers({"X-N8N-API-KEY": n8n_key})
            else:
                page.set_extra_http_headers({})
            if kind == "raw-api":
                resp = page.goto(url, timeout=20000, wait_until="domcontentloaded")
                page.wait_for_timeout(300)
                result = page.evaluate("""() => {
                  const text = document.body ? document.body.innerText : '';
                  document.body.innerHTML = '';
                  document.body.style.cssText = 'margin:0;background:#0b1020;color:#dbeafe;font:16px Consolas,monospace;white-space:pre-wrap;padding:28px;height:100vh;overflow:hidden;';
                  const h = document.createElement('h2');
                  h.textContent = location.href;
                  h.style.cssText = 'font:700 18px Segoe UI,sans-serif;color:#93c5fd;white-space:normal;margin:0 0 18px;';
                  const p = document.createElement('div'); p.textContent = text;
                  document.body.append(h,p); return text;
                }""")
                status = resp.status if resp else None
                final_url = page.url
                title = label
            else:
                resp = page.goto(url, timeout=20000, wait_until="domcontentloaded")
                page.wait_for_timeout(wait)
                status = resp.status if resp else None
                final_url = page.url
                title = page.title()
            path = OUT / filename
            page.screenshot(path=str(path), full_page=(kind != "raw-api"), timeout=60000)
            manifest["items"].append({
                "file": filename, "label": label, "kind": kind, "url": url,
                "final_url": final_url, "http_status": status, "title": title,
                "truth": "由当前服务页面/HTTP响应直接截取；不含合成动画"
            })
            print(f"✅ {filename} | {status} | {final_url}")
        except Exception as e:
            print(f"❌ {filename} | {e}")
            manifest["items"].append({"file": filename, "label": label, "kind": kind, "url": url, "error": str(e)})
    b.close()

(OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"manifest: {OUT / 'manifest.json'}")
