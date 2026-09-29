#!/usr/bin/env python3
"""Capture real, logged-in screenshots of the running platform.

Why this exists
---------------
Earlier packs only had login pages, because the console (Clerk), LobeChat
(Better Auth) and n8n (own auth) all need a session that Playwright cannot
create on its own. The human has already signed in with a normal browser on
this machine, so instead of faking a session we *copy the login state*
(cookies + localStorage + IndexedDB + the DPAPI key ring in Local State)
into a throwaway Chrome profile and drive that with Playwright.

Everything written out is a real HTTP response rendered by a real Chrome.
Nothing here is drawn by hand. Each capture records its final URL so a
redirect back to a sign-in page is visible in the manifest instead of being
silently passed off as a logged-in screen.
"""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import json, os, shutil, subprocess, sys, urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "deliverables" / "实机静态截图"
OUT.mkdir(parents=True, exist_ok=True)
TMP_PROFILE = ROOT / ".tmp-chrome-profile"

SRC = Path(os.environ.get("CHROME_USER_DATA",
                          r"C:\Users\LINLEE\AppData\Local\Google\Chrome\User Data"))

# Only the pieces that carry identity. Copying the whole profile would move
# ~3 GB of cache and is not needed.
COPY_FILES = ["Local State"]
COPY_DIRS = [
    "Default/Network",           # Cookies live here since Chrome 127
    "Default/Local Storage",
    "Default/Session Storage",
    "Default/IndexedDB",
]
COPY_DEFAULTS = ["Preferences", "Secure Preferences", "Web Data"]


def env_value(name):
    p = ROOT / ".env"
    if not p.exists():
        return ""
    prefix = name + "="
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(prefix):
            return line[len(prefix):].strip().strip("'").strip('"')
    return ""


def prepare_profile():
    """Copy the signed-in identity into a scratch profile Playwright may own."""
    if TMP_PROFILE.exists():
        shutil.rmtree(TMP_PROFILE, ignore_errors=True)
    (TMP_PROFILE / "Default").mkdir(parents=True, exist_ok=True)

    moved = []
    for rel in COPY_FILES:
        s, d = SRC / rel, TMP_PROFILE / rel
        if s.exists():
            shutil.copy2(s, d)
            moved.append(rel)
    for rel in COPY_DIRS:
        s, d = SRC / rel, TMP_PROFILE / rel
        if s.exists():
            shutil.copytree(s, d, dirs_exist_ok=True, ignore=shutil.ignore_patterns("*-wal", "*-shm"))
            moved.append(rel)
    for rel in COPY_DEFAULTS:
        s, d = SRC / rel, TMP_PROFILE / "Default" / rel
        if s.exists():
            shutil.copy2(s, d)
            moved.append("Default/" + rel)
    # Never resume the human's real tab set, and never show the profile picker.
    pref = TMP_PROFILE / "Default" / "Preferences"
    try:
        data = json.loads(pref.read_text(encoding="utf-8"))
        data.setdefault("profile", {})
        data["profile"]["exit_type"] = "Normal"
        data["profile"]["exited_cleanly"] = True
        data["session"] = {"restore_on_startup": 5}
        pref.write_text(json.dumps(data), encoding="utf-8")
    except Exception as e:
        print("  (preferences not rewritten: %s)" % e)
    print("copied login state: %s" % ", ".join(moved))
    return moved


def n8n_targets():
    """Pick a real workflow + execution to screenshot, straight from the API."""
    key = env_value("N8N_API_KEY")
    if not key:
        return None
    req = urllib.request.Request(
        "http://localhost:5678/api/v1/workflows?limit=50&fields=id,name,active",
        headers={"X-N8N-API-KEY": key})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print("  (workflow lookup failed: %s)" % e)
        return None
    wfs = data.get("data", data if isinstance(data, list) else [])
    pick = None
    for kw in ("自检", "selfcheck", "self-check", "晨报", "morning"):
        for w in wfs:
            if kw.lower() in (w.get("name") or "").lower():
                pick = w
                break
        if pick:
            break
    if pick is None:
        pick = next((w for w in wfs if w.get("active")), wfs[0] if wfs else None)
    return pick


# name, url, label, wait_ms
def build_cases(wf):
    cases = [
        ("10_console_overview.png",   "http://localhost:3000/dashboard/overview",   "控制台总览（登录后）", 7000),
        ("11_console_docs.png",       "http://localhost:3000/dashboard/docs",       "知识库文档页（登录后）", 7000),
        ("12_console_people.png",     "http://localhost:3000/dashboard/people",     "人员目录页（登录后）", 7000),
        ("13_console_topics.png",     "http://localhost:3000/dashboard/topics",     "议题页（登录后）", 7000),
        ("14_console_knowledge.png",  "http://localhost:3000/dashboard/knowledge",  "知识库检索页（登录后）", 8000),
        ("15_console_workflows.png",  "http://localhost:3000/dashboard/workflows",  "工作流页（登录后）", 7000),
        ("16_console_alerts.png",     "http://localhost:3000/dashboard/alerts",     "告警页（登录后）", 7000),
        ("17_console_briefs.png",     "http://localhost:3000/dashboard/briefs",     "简报页（登录后）", 7000),
        ("18_console_models.png",     "http://localhost:3000/dashboard/models",     "模型页（登录后）", 7000),
        ("19_lobechat_home.png",      "http://localhost:3210/",                     "LobeChat 对话界面（登录后）", 9000),
        ("20_n8n_workflows.png",      "http://localhost:5678/workflows",            "n8n 工作流列表（登录后）", 8000),
        ("21_n8n_executions.png",     "http://localhost:5678/executions",           "n8n 执行历史（登录后）", 8000),
    ]
    if wf:
        cases.append((
            "22_n8n_canvas.png",
            "http://localhost:5678/workflow/%s" % wf["id"],
            "n8n 工作流画布（%s，登录后）" % wf.get("name"),
            10000,
        ))
    return cases


def looks_logged_out(url, title, text):
    u = (url or "").lower()
    if "/auth/sign-in" in u or "/signin" in u or "/sign-in" in u or u.rstrip("/").endswith("/signin"):
        return True
    blob = ((title or "") + " " + (text or "")).lower()
    for m in ("sign in to", "log in to", "sign in with", "continue with google", "welcome back"):
        if m in blob:
            return True
    return False


def main():
    print("preparing throwaway Chrome profile from %s" % SRC)
    prepare_profile()
    wf = n8n_targets()
    print("n8n canvas target: %s" % (wf.get("name") if wf else "(none)"))
    cases = build_cases(wf)

    ts = datetime.now(timezone(timedelta(hours=8)))
    manifest = {
        "captured_at": ts.isoformat(timespec="seconds"),
        "method": "real Chrome rendering of live localhost services, reusing the signed-in browser profile",
        "viewport": {"width": 1600, "height": 900},
        "items": [],
    }

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(TMP_PROFILE),
            channel="chrome",
            headless=True,
            viewport={"width": 1600, "height": 900},
            device_scale_factor=1,
            args=["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
        )
        page = ctx.new_page()
        for name, url, label, wait in cases:
            entry = {"file": name, "url": url, "label": label}
            try:
                resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(wait)
                try:
                    page.wait_for_load_state("networkidle", timeout=8000)
                except Exception:
                    pass
                final = page.url
                title = page.title()
                try:
                    text = page.inner_text("body")[:4000]
                except Exception:
                    text = ""
                entry.update({
                    "status": (resp.status if resp else None),
                    "final_url": final,
                    "title": title,
                    "logged_in": not looks_logged_out(final, title, text),
                })
                page.screenshot(path=str(OUT / name))
                size = (OUT / name).stat().st_size
                entry["bytes"] = size
                flag = "OK  " if entry["logged_in"] else "GATE"
                print("%s %-28s %-46s %6.0f KB  %s" % (flag, name, final[:46], size / 1024, title[:40]))
            except Exception as e:
                entry["error"] = str(e)[:300]
                entry["logged_in"] = False
                print("FAIL %-28s %s" % (name, str(e)[:120]))
            manifest["items"].append(entry)
        ctx.close()

    (OUT / "loggedin-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    ok = sum(1 for i in manifest["items"] if i.get("logged_in"))
    print("\n%d/%d logged-in screens" % (ok, len(manifest["items"])))


if __name__ == "__main__":
    main()
