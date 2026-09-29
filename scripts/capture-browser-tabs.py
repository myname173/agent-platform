#!/usr/bin/env python3
"""Drive the human's already-signed-in Chrome and screenshot each page.

Why this shape
--------------
Chrome holds Network/Cookies under an exclusive lock (WinError 32), so the
profile cannot be copied into a scratch dir; Chrome also refuses a second
instance on the same profile and ignores `--new-window` once it is running.
Playwright therefore cannot mint a Clerk / n8n session.

Instead we automate the *existing* browser:
    Ctrl+T  -> new throwaway tab        (the human's own tabs stay intact)
    Ctrl+L  -> focus the omnibox
    type URL + Enter
    wait for the page to settle
    PrintWindow(PW_RENDERFULLCONTENT)   -> real pixels
    Ctrl+W  -> close the throwaway tab  (back to whatever tab they had)

Nothing is drawn or composited. The only thing recorded per shot is the real
window title, which is how a redirect back to a login page gets caught.
"""
import ctypes, ctypes.wintypes as wt, importlib.util as ilu, json, sys, time
from pathlib import Path
from datetime import datetime, timezone, timedelta

from PIL import Image, ImageStat

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "deliverables" / "实机静态截图"
OUT.mkdir(parents=True, exist_ok=True)

_spec = ilu.spec_from_file_location("cw", HERE / "capture-window.py")
cw = ilu.module_from_spec(_spec)
_spec.loader.exec_module(cw)

u32, k32 = cw.user32, ctypes.WinDLL("kernel32", use_last_error=True)

# ── input synthesis ─────────────────────────────────────────────────────────
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
VK_CONTROL, VK_MENU, VK_RETURN = 0x11, 0x12, 0x0D


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("ki", KEYBDINPUT), ("pad", ctypes.c_ubyte * 8)]


def _send(flags, vk=0, scan=0):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.ki.wVk = vk
    inp.ki.wScan = scan
    inp.ki.dwFlags = flags
    u32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(inp))
    time.sleep(0.04)


def combo(vk):
    """Ctrl+<vk>. Virtual keys, not scan codes — SendInput ignores wScan
    unless KEYEVENTF_SCANCODE is set, and passing wVk=0 sends nothing."""
    _send(0, vk=VK_CONTROL)
    _send(0, vk=vk)
    _send(KEYEVENTF_KEYUP, vk=vk)
    _send(KEYEVENTF_KEYUP, vk=VK_CONTROL)
    time.sleep(0.15)


VK_T, VK_L, VK_W = 0x54, 0x4C, 0x57


def type_text(text):
    for ch in text:
        _send(KEYEVENTF_UNICODE, 0, ord(ch))
        _send(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, ord(ch))
    time.sleep(0.15)
    _send(0, VK_RETURN)
    _send(KEYEVENTF_KEYUP, VK_RETURN)


def foreground(hwnd, tries=6):
    """Windows only lets a process grab the foreground under conditions.

    Nudge it three ways: an Alt keypress (clears the 'no focus' lock), thread
    input attachment, then the plain call. Verify via GetForegroundWindow.
    """
    if u32.IsIconic(hwnd):
        u32.ShowWindow(hwnd, 9)           # SW_RESTORE
        time.sleep(0.8)
    u32.ShowWindow(hwnd, 5)               # SW_SHOW
    for _ in range(tries):
        _send(0, VK_MENU)
        _send(KEYEVENTF_KEYUP, VK_MENU)
        cur_tid = k32.GetCurrentThreadId()
        tgt_tid = u32.GetWindowThreadProcessId(hwnd, None)
        u32.AttachThreadInput(cur_tid, tgt_tid, True)
        u32.SetForegroundWindow(hwnd)
        u32.BringWindowToTop(hwnd)
        u32.AttachThreadInput(cur_tid, tgt_tid, False)
        time.sleep(0.6)
        if u32.GetForegroundWindow() == hwnd:
            return True
    return False


def chrome_window(selector="Google Chrome"):
    best, best_area = None, 0
    for h in cw.all_windows():
        cls = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(h, cls, 256)
        if cls.value != "Chrome_WidgetWin_1":
            continue
        t = cw._title_of(h)
        if not t or selector.lower() not in t.lower():
            continue
        a = cw._area(cw._rect_of(h) or (0, 0, 0, 0))
        if a > best_area:
            best, best_area = h, a
    return best


def shot(hwnd, dest, min_contrast=6.0):
    if not cw.capture(hwnd, str(dest)):
        return None
    st = ImageStat.Stat(Image.open(dest).convert("RGB"))
    return round(max(st.stddev), 1)


def navigate_and_shoot(hwnd, url, dest, settle):
    combo(VK_T)          # Ctrl+T  -> throwaway tab
    time.sleep(0.9)
    combo(VK_L)          # Ctrl+L  -> omnibox
    time.sleep(0.4)
    type_text(url)
    time.sleep(settle)
    title = cw._title_of(hwnd)
    spread = shot(hwnd, dest)
    combo(VK_W)          # Ctrl+W  -> close throwaway tab
    time.sleep(0.7)
    return title, spread


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    hwnd = chrome_window()
    if not hwnd:
        print("no Chrome window found"); return 1
    print("window 0x%08x  %r" % (hwnd, cw._title_of(hwnd)))
    if not foreground(hwnd):
        print("WARNING: could not take foreground — keystrokes may go nowhere")
    time.sleep(0.8)
    print("foreground =", u32.GetForegroundWindow() == hwnd)

    cases = [
        ("10_console_overview.png",  "http://localhost:3000/dashboard/overview",  "Kiranism 控制台 · 总览", 9),
        ("11_console_docs.png",      "http://localhost:3000/dashboard/docs",      "Kiranism 控制台 · 知识库文档", 9),
        ("12_console_people.png",    "http://localhost:3000/dashboard/people",    "Kiranism 控制台 · 人员目录", 8),
        ("13_console_topics.png",    "http://localhost:3000/dashboard/topics",    "Kiranism 控制台 · 议题", 8),
        ("14_console_knowledge.png", "http://localhost:3000/dashboard/knowledge", "Kiranism 控制台 · 知识检索", 9),
        ("15_console_workflows.png", "http://localhost:3000/dashboard/workflows", "Kiranism 控制台 · 工作流", 8),
        ("16_console_alerts.png",    "http://localhost:3000/dashboard/alerts",    "Kiranism 控制台 · 告警", 8),
        ("17_console_briefs.png",    "http://localhost:3000/dashboard/briefs",    "Kiranism 控制台 · 简报", 8),
        ("19_lobechat_home.png",     "http://localhost:3210/",                    "PivotAI (LobeChat) 对话界面", 12),
        ("20_n8n_workflows.png",     "http://localhost:5678/workflows",           "n8n · 工作流列表", 10),
        ("21_n8n_executions.png",    "http://localhost:5678/executions",          "n8n · 执行历史", 10),
    ]
    if only:
        cases = [c for c in cases if only in c[0]]

    ts = datetime.now(timezone(timedelta(hours=8)))
    man = {"captured_at": ts.isoformat(timespec="seconds"),
           "method": "驱动用户已登录的 Chrome（临时标签页导航 + PrintWindow 实拍）",
           "window": "0x%08x" % hwnd, "items": []}
    for name, url, label, settle in cases:
        dest = OUT / name
        print("→ %-28s %s" % (name, url), flush=True)
        try:
            title, spread = navigate_and_shoot(hwnd, url, dest, settle)
        except Exception as e:
            title, spread = None, None
            print("   ERR %s" % str(e)[:120])
        ok = spread is not None and spread >= 6.0 and dest.exists()
        rec = {"file": name, "url": url, "label": label, "window_title": title,
               "contrast": spread, "ok": bool(ok)}
        if dest.exists():
            rec["bytes"] = dest.stat().st_size
        man["items"].append(rec)
        print("   %s title=%r contrast=%s" % ("OK " if ok else "BAD", title, spread), flush=True)
        time.sleep(0.5)

    (OUT / "tabs-manifest.json").write_text(
        json.dumps(man, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n%d/%d ok" % (sum(1 for i in man["items"] if i["ok"]), len(man["items"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
