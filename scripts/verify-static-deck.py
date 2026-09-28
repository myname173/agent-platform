#!/usr/bin/env python3
"""Verify static-only deck: 8 images, no GIFs, no console errors."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DECK = ROOT / "deliverables" / "静态截图版.html"
url = "file:///" + str(DECK).replace("\\", "/")
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url, wait_until="load")
    page.wait_for_timeout(1000)
    imgs = page.locator(".shot img")
    count = imgs.count()
    broken = page.evaluate("""() => [...document.querySelectorAll('.shot img')].filter(i => !i.complete || i.naturalWidth === 0).length""")
    gifs = page.locator("img[src^='data:image/gif']").count()
    print(f"images={count} broken={broken} gifs={gifs} console_errors={len(errors)}")
    if errors:
        for e in errors[:5]: print("  ", e)
    if count != 8 or broken or gifs or errors:
        raise SystemExit(1)
    print("✅ static deck verified")
    b.close()
