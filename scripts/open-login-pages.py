#!/usr/bin/env python3
"""Open login pages visibly for user-assisted login; no credentials are entered."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import time

ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / ".tmp-login-browser-profile"
PROFILE.mkdir(exist_ok=True)
URLS = [
    ("Kiranism 控制台", "http://localhost:3000/auth/sign-in"),
    ("LobeChat", "http://localhost:3210"),
    ("n8n", "http://localhost:5678/signin"),
]

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE), channel="chrome", headless=False,
        viewport={"width": 1440, "height": 900},
        args=["--window-size=1460,960"],
    )
    ctx.set_default_navigation_timeout(10000)
    for label, url in URLS:
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="commit", timeout=10000)
            page.wait_for_timeout(1800)
            print(f"OPENED {label}: {page.url}", flush=True)
        except Exception as e:
            print(f"OPENED {label} with navigation warning: {e}", flush=True)
    print("READY: pages are open; no credentials were entered", flush=True)
    try:
        while True:
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        ctx.close()
