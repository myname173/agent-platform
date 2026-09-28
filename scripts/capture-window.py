#!/usr/bin/env python3
"""Capture a real application window to PNG (Win32 PrintWindow).

Why this exists: Playwright can only screenshot browser pages. Screenshots of
desktop apps (Telegram / WeChat / Feishu) need the Win32 API. Two traps cost
real time before:

  1. A process owns MANY top-level windows. Telegram had 15 — shadow windows,
     IME windows, tray-icon windows, GDI+ hook windows. Picking "the first one
     with a title" grabs `Default IME` (0x0) and ShowWindow on it is a no-op.
     Always select by: visible AND titled AND largest area.

  2. A minimized window sits at (-16000,-16000) — Windows parks it offscreen.
     ShowWindow(SW_RESTORE) works, but only on the right HWND, and the rect is
     not updated synchronously; wait ~500 ms before reading it back.

Usage:  python capture-window.py <pid|title-substring> <out.png>
"""
import ctypes, ctypes.wintypes as wt, sys, time
from PIL import Image

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

WM_SYSCOMMAND = 0x0112
SC_RESTORE = 0xF120
SW_RESTORE = 9
PW_RENDERFULLCONTENT = 0x00000002

# ── enumeration helpers ─────────────────────────────────────────────────────
def _pid_of(hwnd):
    p = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
    return p.value

def _title_of(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value

def _rect_of(hwnd):
    r = wt.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return (r.left, r.top, r.right, r.bottom)

def _area(r):
    return max(0, r[2] - r[0]) * max(0, r[3] - r[1])

def all_windows():
    out = []
    user32.EnumWindows(EnumWindowsProc(lambda h, _l: (out.append(h), True)[1]), 0)
    return out

def pick_main_window(selector):
    """selector: int pid, or str substring of the window title.

    Ranks by area among visible+titled candidates — this is the fix for the
    IME-window bug: `Default IME` is titled but 0x0, so area ranking drops it.
    """
    cands = []
    for h in all_windows():
        if isinstance(selector, int):
            if _pid_of(h) != selector:
                continue
        else:
            if selector.lower() not in _title_of(h).lower():
                continue
        t = _title_of(h)
        r = _rect_of(h) or (0, 0, 0, 0)
        if not t:
            continue
        cands.append((h, _area(r), t, r))
    if not cands:
        return None
    # prefer visible; among those, largest area
    vis = [c for c in cands if user32.IsWindowVisible(c[0])]
    pool = vis or cands
    pool.sort(key=lambda c: -c[1])
    return pool[0][0]

# ── restore ─────────────────────────────────────────────────────────────────
def restore(hwnd, wait=0.6):
    """Bring a minimized window back onscreen.

    Tries SW_RESTORE first; falls back to WM_SYSCOMMAND/SC_RESTORE, which is
    what actually wakes a tray-minimized Qt window.
    """
    if user32.IsIconic(hwnd):
        print("  ↳ iconic (minimized) → restoring")
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(wait)
        if user32.IsIconic(hwnd):
            print("  ↳ SW_RESTORE had no effect → WM_SYSCOMMAND/SC_RESTORE")
            user32.SendMessageW(hwnd, WM_SYSCOMMAND, SC_RESTORE, 0)
            time.sleep(wait)
    user32.SetForegroundWindow(hwnd)
    time.sleep(wait * 0.5)
    return not user32.IsIconic(hwnd)

# ── capture ─────────────────────────────────────────────────────────────────
def capture(hwnd, out_path):
    r = _rect_of(hwnd)
    if not r:
        print("  ❌ GetWindowRect failed", file=sys.stderr)
        return False
    w, h = r[2] - r[0], r[3] - r[1]
    print(f"  rect {r[0]},{r[1]} → {w}x{h}")
    if w <= 0 or h <= 0:
        print("  ❌ window has zero area — still minimized or hidden", file=sys.stderr)
        return False

    hdc = user32.GetWindowDC(hwnd)
    if not hdc:
        print("  ❌ GetWindowDC failed", file=sys.stderr)
        return False
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)

    # PW_RENDERFULLCONTENT is what makes Qt/DWM apps render properly;
    # without it many modern apps yield a blank bitmap.
    ok = user32.PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT)
    print(f"  PrintWindow(PW_RENDERFULLCONTENT) = {ok}")

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
                    ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                    ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
                    ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD)]
    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(bi)
    bi.biWidth, bi.biHeight = w, -h          # negative → top-down
    bi.biPlanes, bi.biBitCount = 1, 32
    bi.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    rows = gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
    print(f"  GetDIBits rows = {rows}")

    gdi32.DeleteObject(bmp); gdi32.DeleteDC(mem); user32.ReleaseDC(hwnd, hdc)

    if rows <= 0:
        print("  ❌ GetDIBits returned no rows", file=sys.stderr)
        return False
    img = Image.frombuffer("RGB", (w, h), buf, "raw", "BGRX", 0, 1).copy()
    img.save(out_path, "PNG")
    print(f"  ✅ saved {out_path}  ({w}x{h})")
    return True

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(2)
    sel = sys.argv[1]
    selector = int(sel) if sel.isdigit() else sel
    out_path = sys.argv[2]

    hwnd = pick_main_window(selector)
    if not hwnd:
        print(f"❌ no window matched {selector!r}", file=sys.stderr)
        sys.exit(1)
    print(f"main window: 0x{hwnd:08x}  title={_title_of(hwnd)!r}")
    if not restore(hwnd):
        print("⚠ still iconic after restore attempts — capture may be blank", file=sys.stderr)
    sys.exit(0 if capture(hwnd, out_path) else 1)

if __name__ == "__main__":
    main()
