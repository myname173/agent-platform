#!/usr/bin/env python3
"""Diagnose why a window can't be restored / captured.

Enumerates ALL windows owned by a PID (not just the first titled one) and
reports: handle, class name, rect, IsIconic, visible, cloaked (virtual
desktop / UWP hiding).
"""
import ctypes, ctypes.wintypes as wt, sys

user32 = ctypes.WinDLL("user32", use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
try:
    dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
    _has_dwm = True
except Exception:
    _has_dwm = False

DWMWA_CLOAKED = 14
CLOAKED_APP, CLOAKED_SHELL, CLOAKED_INHERITED = 0x1, 0x2, 0x4

def rect_of(hwnd):
    r = wt.RECT()
    ok = user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right, r.bottom) if ok else None

def title_of(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value

def class_of(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value

def cloaked_of(hwnd):
    if not _has_dwm:
        return None
    v = ctypes.c_uint32()
    hr = dwmapi.DwmGetWindowAttribute(hwnd, ctypes.c_uint32(DWMWA_CLOAKED),
                                      ctypes.byref(v), ctypes.sizeof(v))
    return v.value if hr == 0 else None

def windows_of_pid(pid):
    out = []
    def cb(hwnd, _l):
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid:
            out.append(hwnd)
        return True
    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out

def main(pid):
    hwnds = windows_of_pid(pid)
    print(f"PID {pid} → {len(hwnds)} top-level window(s)\n")
    if not hwnds:
        print("  ❌ no windows at all — process may be tray-only or owned by another session")
        return
    for h in hwnds:
        r = rect_of(h) or (0, 0, 0, 0)
        cl = cloaked_of(h)
        names = {0: "none", CLOAKED_APP: "app", CLOAKED_SHELL: "shell",
                 CLOAKED_INHERITED: "inherited"}
        print(f"  HWND 0x{h:08x}")
        print(f"    class   : {class_of(h)}")
        print(f"    title   : {title_of(h)!r}")
        print(f"    rect    : ({r[0]},{r[1]})-({r[2]},{r[3]})  {r[2]-r[0]}x{r[3]-r[1]}")
        print(f"    visible : {bool(user32.IsWindowVisible(h))}")
        print(f"    iconic  : {bool(user32.IsIconic(h))}   (minimized)")
        print(f"    cloaked : {names.get(cl, cl)}")
        print()

    # pick the most likely main window: visible + titled + biggest area
    best, bestarea = None, -1
    for h in hwnds:
        r = rect_of(h) or (0, 0, 0, 0)
        area = max(0, r[2] - r[0]) * max(0, r[3] - r[1])
        if user32.IsWindowVisible(h) and title_of(h) and area > bestarea:
            best, bestarea = h, area
    print(f"best candidate: 0x{best:08x}" if best else "no visible titled window")

if __name__ == "__main__":
    main(int(sys.argv[1]))
