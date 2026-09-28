#!/usr/bin/env python3
"""E2E check: open the deck, walk every slide, screenshot each one."""
import sys, os
from playwright.sync_api import sync_playwright
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DECK = ROOT / "deliverables" / "index.html"
SHOT = ROOT / "deliverables" / "_verify"
SHOT.mkdir(exist_ok=True)

url = "file:///" + str(DECK).replace("\\", "/")

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))

    pg.goto(url, wait_until="load")
    pg.wait_for_timeout(800)

    # count slides
    n = pg.eval_on_selector_all(".slide", "els => els.length")
    print(f"slides in DOM: {n}")

    # check every <img> actually decoded
    broken = pg.evaluate("""() => {
      const imgs = [...document.querySelectorAll('.media img')];
      return imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.alt || '(no alt)');
    }""")
    print(f"broken images: {broken if broken else 'none'}")

    total = n
    ok = 0
    for i in range(total):
        pg.keyboard.press("ArrowRight") if i else None
        pg.wait_for_timeout(320)
        on = pg.eval_on_selector_all(".slide.on", "els => els.length")
        label = pg.eval_on_selector(".slide.on .kicker", "e => e.textContent.trim()")
        has_media = pg.eval_on_selector_all(".slide.on .media img", "e => e.length")
        if on == 1:
            ok += 1
        pg.screenshot(path=str(SHOT / f"slide_{i+1:02d}.png"))
        print(f"  [{i+1}] on={on} media={has_media}  {label[:34]}")

    # notes panel toggle
    pg.keyboard.press("n")
    pg.wait_for_timeout(400)
    notes_on = pg.eval_on_selector("#notes", "e => e.classList.contains('on')")
    print(f"notes panel toggles: {notes_on}")

    print(f"\n✅ slides rendered uniquely: {ok}/{total}")
    if errors:
        print("❌ console errors:"); [print("   ", e) for e in errors[:10]]
    else:
        print("✅ no console errors")
    b.close()
