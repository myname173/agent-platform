#!/usr/bin/env python3
"""Minimal, fast demo asset capture - each page in its own browser instance to avoid hangs."""

import os
from playwright.sync_api import sync_playwright

OUT = "demo-assets"
os.makedirs(OUT, exist_ok=True)

def capture(url, filename, wait=3000, actions=None):
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        page = b.new_page(viewport={"width": 1440, "height": 900})
        try:
            page.goto(url, timeout=20000, wait_until="domcontentloaded")
            page.wait_for_timeout(wait)
            if actions:
                actions(page)
            out = f"{OUT}/{filename}.png"
            page.screenshot(path=out)
            kb = os.path.getsize(out) // 1024
            print(f"✅ {filename}.png ({kb} KB)  URL: {page.url}")
        except Exception as e:
            print(f"❌ {filename}: {e}")
        finally:
            b.close()


# ─── LobeChat landing / signin ─────────────────────────────────────────────
print("\n[1] LobeChat")
capture("http://192.168.209.141:3210", "02_lobechat_signin", wait=4000)

# ─── n8n signin ────────────────────────────────────────────────────────────
print("\n[2] n8n signin")
capture("http://localhost:5678/signin", "03_n8n_signin", wait=2000)

# ─── n8n login attempt → try to get to workflows ───────────────────────────
print("\n[3] n8n workflows (with login attempt)")

def n8n_login(page):
    # type email
    email = page.locator('input').nth(0)
    email.fill("linlee@example.com")
    pw = page.locator('input[type=password]')
    if pw.count():
        pw.fill("Admin1234!")
    page.keyboard.press("Enter")
    page.wait_for_timeout(4000)
    print("  After login URL:", page.url)
    page.screenshot(path=f"{OUT}/03b_n8n_after_login.png")

capture("http://localhost:5678/signin", "03a_n8n_login", wait=2000, actions=n8n_login)

# ─── Kiranism auth page ────────────────────────────────────────────────────
print("\n[4] Kiranism")
capture("http://localhost:3000", "04_kiranism_signin", wait=3000)

# List all files
print("\n📁 demo-assets contents:")
for f in sorted(os.listdir(OUT)):
    size = os.path.getsize(f"{OUT}/{f}")
    print(f"  {f}  ({size//1024} KB)")
