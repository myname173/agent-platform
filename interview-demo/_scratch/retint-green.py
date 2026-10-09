#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 PivotAI 主题的蓝色/青色强调色整体换成「鲜艳清新的浅绿色」。
显式映射表 + 逐项计数，拒绝盲替换。"""
import io, sys, os

CSS = "custom-theme/pivot-theme-v2.css"
JS = "custom-theme/pivot-theme-v2.js"

# ---------- CSS ----------
CSS_MAP = [
    # --- rgb 三元组（带空格，CSS 风格）---
    ("rgba(59, 130, 246",  "rgba(34, 197, 94"),   # blue-500  #3B82F6 -> green-500
    ("rgba(6, 182, 212",   "rgba(52, 211, 153"),  # cyan-500  #06B6D4 -> emerald-400
    ("rgba(96, 165, 250",  "rgba(74, 222, 128"),  # blue-400  -> green-400
    ("rgba(37, 99, 235",   "rgba(22, 163, 74"),   # blue-600  -> green-600
    ("rgba(29, 78, 216",   "rgba(21, 128, 61"),   # blue-700  -> green-700
    ("rgba(2, 132, 199",   "rgba(5, 150, 105"),   # sky-600   -> emerald-600
    ("rgba(99, 102, 241",  "rgba(16, 185, 129"),  # indigo-500-> emerald-500
    # --- 十六进制 ---
    ("#3b82f6", "#16a34a"),   # primary      -> green-600（配白字可读）
    ("#3B82F6", "#16A34A"),
    ("#06b6d4", "#34d399"),   # accent       -> emerald-400
    ("#06B6D4", "#34D399"),
    ("#60a5fa", "#22c55e"),   # primaryHover -> green-500
    ("#2563eb", "#15803d"),   # primaryActive-> green-700
    ("#38bdf8", "#6ee7b7"),   # info/link    -> emerald-300
    # --- 注释里的说明词 ---
    ("(Electric Blue)", "(Vivid Green)"),
    ("(Cyber Cyan)",    "(Fresh Mint)"),
]

# ---------- JS（canvas 光点 + 流星 + 品牌字）----------
JS_MAP = [
    # 背景水洗 / 星云团 / 噪点
    ("rgba(80,110,190,",  "rgba(60,180,120,"),
    ("rgba(96,130,210,",  "rgba(70,200,140,"),
    ("rgba(120,150,230,", "rgba(100,210,160,"),
    ("rgba(190,210,255,", "rgba(200,245,215,"),
    # 星点 sprite（原来是白核，白底上等于隐身 -> 换成浅绿核）
    ("rgba(255,255,255,1)",   "rgba(134,239,172,1)"),    # 核: green-300
    ("rgba(220,240,255,0.5)", "rgba(74,222,128,0.55)"),  # 晕: green-400
    ("rgba(150,200,255,0)",   "rgba(16,185,129,0)"),     # 边: emerald-500
    # 鼠标连线
    ("rgba(103,232,249,", "rgba(134,239,172,"),
    # 流星
    ("rgba(186,230,253,", "rgba(209,250,229,"),
    ("rgba(59,130,246,",  "rgba(34,197,94,"),   # 含 0.3 与 0) 两种
    # 品牌字渐变 + 控制台标记色
    ("#60A5FA", "#4ADE80"),
    ("#22D3EE", "#34D399"),
    ("#3B82F6", "#16A34A"),
    ("#06B6D4", "#34D399"),
]

HUES_OLD = """    var HUES = [
      ['rgba(147,197,253,', 'rgba(96,165,250,'],
      ['rgba(103,232,249,', 'rgba(34,211,238,'],
      ['rgba(196,181,253,', 'rgba(167,139,250,'],
      ['rgba(253,230,190,', 'rgba(245,200,150,']
    ];"""
HUES_NEW = """    /* 星座连线配色：全部收进「浅绿 / 薄荷」家族，保留四档细微层次。
       原来是蓝 / 青 / 紫 / 沙，与新的绿色主调冲突。 */
    var HUES = [
      ['rgba(134,239,172,', 'rgba(74,222,128,'],   // green-300   -> green-400
      ['rgba(110,231,183,', 'rgba(52,211,153,'],   // emerald-300 -> emerald-400
      ['rgba(167,243,208,', 'rgba(16,185,129,'],   // green-200   -> emerald-500
      ['rgba(74,222,128,',  'rgba(34,197,94,']     // green-400   -> green-500
    ];"""


def apply(path, table):
    with io.open(path, encoding="utf-8") as f:
        s = f.read()
    total = 0
    for old, new in table:
        n = s.count(old)
        if n:
            s = s.replace(old, new)
            total += n
            print("  %-28s -> %-24s x%d" % (old, new, n))
        else:
            print("  %-28s -> %-24s x0  (未命中)" % (old, new))
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(s)
    print("  == %s: 共 %d 处\n" % (path, total))
    return total


print("=== CSS ===")
apply(CSS, CSS_MAP)

print("=== JS 色值 ===")
apply(JS, JS_MAP)

print("=== JS HUES 数组 ===")
with io.open(JS, encoding="utf-8") as f:
    s = f.read()
if HUES_OLD in s:
    s = s.replace(HUES_OLD, HUES_NEW)
    with io.open(JS, "w", encoding="utf-8", newline="") as f:
        f.write(s)
    print("  HUES 已替换")
else:
    print("  !! HUES 未匹配，需手工处理")
