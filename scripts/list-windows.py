#!/usr/bin/env python3
"""List visible top-level windows: hwnd, pid, class, title, rect, area."""
import ctypes, ctypes.wintypes as wt

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
out = []
for h in rows:
    t = title_of(h)
    if not t or not user32.IsWindowVisible(h):
        continue
    r = rect_of(h) or (0, 0, 0, 0)
    area = max(0, r[2]-r[0]) * max(0, r[3]-r[1])
    if area < 10000:
        continue
    out.append((area, h, pid_of(h), t, r))
out.sort(reverse=True)
print(f"{'HWND':>10} {'PID':>7} {'RECT':>28} {'AREA':>9}  TITLE")
for area, h, pid, t, r in out:
    print(f"0x{h:08x} {pid:>7} {str(r):>28} {area:>9}  {t[:70]}")
