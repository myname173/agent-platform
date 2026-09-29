#!/usr/bin/env python3
"""Open one login page in its own visible Chrome window."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import sys, time

if len(sys.argv) != 4:
    raise SystemExit("usage: open-one-login.py <profile-name> <label> <url>")
name, label, url = sys.argv[1:]
root = Path(__file__).resolve().parent.parent
profile = root / (".tmp-login-" + name)
profile.mkdir(exist_ok=True)
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(profile), channel="chrome", headless=False,
        viewport={"width": 1440, "height": 900},
        args=["--window-size=1460,960"],
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    try:
        page.goto(url, wait_until="commit", timeout=12000)
        page.wait_for_timeout(2200)
        print(f"OPENED {label}: {page.url}", flush=True)
    except Exception as e:
        print(f"OPENED {label} with navigation warning: {e}", flush=True)
    print("READY", flush=True)
    try:
        while True: time.sleep(2)
    except KeyboardInterrupt: pass
    finally: ctx.close()
