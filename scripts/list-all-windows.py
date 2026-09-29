#!/usr/bin/env python3
"""Debug: list ALL top-level windows of a pid, including iconic/offscreen."""
import ctypes, ctypes.wintypes as wt, sys

user32 = ctypes.WinDLL("user32", use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

def pid_of(h):
    p = wt.DWORD()
    user32.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value

def title_of(h):
    n = user32.GetWindowTextLengthW(h)
    b = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(h, b, n + 1)
    return b.value

def rect_of(h):
    r = wt.RECT()
    if not user32.GetWindowRect(h, ctypes.byref(r)):
        return None
    return (r.left, r.top, r.right, r.bottom)

rows = []
user32.EnumWindows(EnumWindowsProc(lambda h, _l: (rows.append(h), True)[1]), 0)
for h in rows:
    t = title_of(h)
    r = rect_of(h) or (0, 0, 0, 0)
    vis = user32.IsWindowVisible(h)
    ico = user32.IsIconic(h)
    print(f"0x{h:08x} pid={pid_of(h):>6} vis={int(vis)} ico={int(ico)} rect={r} title={t[:60]!r}")
