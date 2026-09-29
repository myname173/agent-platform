#!/usr/bin/env python3
"""Log in to LobeChat with the project's own access code and screenshot it.

LobeChat is the only one of the three UIs we can sign into unattended: it
gates on LOBECHAT_ACCESS_CODE from .env (Better Auth), not on an external
identity provider. The console (Clerk/Google) and n8n (owner account with no
stored password) both need the human's session, so they are captured from the
real browser window instead — see capture-real-browser.py.
"""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import json

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "deliverables" / "实机静态截图"
OUT.mkdir(parents=True, exist_ok=True)
URL = "http://localhost:3210/"


def env_value(name):
    p = ROOT / ".env"
    if not p.exists():
        return ""
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(name + "="):
            return line[len(name) + 1:].strip().strip("'").strip('"')
    return ""


def probe(page):
    """Report every editable field so we do not guess at selectors."""
    return page.evaluate("""() => Array.from(document.querySelectorAll(
        'input,button,[role=button]')).slice(0,25).map(e => ({
            tag: e.tagName, type: e.type || '', name: e.name || '',
            id: e.id || '', ph: e.getAttribute('placeholder') || '',
            text: (e.innerText||'').trim().slice(0,40)
        }))""")


def main():
    code = env_value("LOBECHAT_ACCESS_CODE")
    if not code:
        print("no LOBECHAT_ACCESS_CODE in .env")
        return 1
    result = {"url": URL, "captured_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")}
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 900})
        page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(4000)
        result["landing_url"] = page.url
        print("landing:", page.url)
        print(json.dumps(probe(page), ensure_ascii=False, indent=1))

        filled = False
        for sel in ('input[type="password"]', 'input[name="password"]',
                    'input[placeholder*="码" i]', 'input[placeholder*="code" i]',
                    'input[type="text"]', 'input:not([type])'):
            try:
                loc = page.locator(sel).first
                if loc.count() and loc.is_visible():
                    loc.click()
                    loc.fill(code)
                    print("filled:", sel)
                    filled = True
                    break
            except Exception:
                continue
        if filled:
            for bsel in ('button[type="submit"]', 'form button', 'button:has-text("登录")',
                         'button:has-text("Sign in")', 'button:has-text("Continue")'):
                try:
                    bl = page.locator(bsel).first
                    if bl.count() and bl.is_visible():
                        bl.click()
                        print("clicked:", bsel)
                        break
                except Exception:
                    continue
            page.wait_for_timeout(6000)
        result["final_url"] = page.url
        result["title"] = page.title()
        page.screenshot(path=str(OUT / "19_lobechat_home.png"))
        page.screenshot(path=str(OUT / "19_lobechat_home_full.png"), full_page=False)
        print("final:", page.url, "|", page.title())
        b.close()
    (OUT / "lobechat-manifest.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
