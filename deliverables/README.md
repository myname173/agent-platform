# PivotAI Agent Platform · 演示资产包

> 4 份产物,任何电脑双击即放 · 数据快照:`2026-09-28 15:28`

---

## 🚀 怎么用

| 用途 | 文件 | 操作 |
|---|---|---|
| 现场演示 | **`index.html`** | 双击 → 键盘 `← →` 翻页 · `N` 看讲稿 · `F` 全屏 · `P` 自动播放 12s/页 |
| 念稿 | **`讲稿.md`** | 12 页分秒级台词 + 10 个 Q&A |
| 单图调用 | `图库/*.png` | 10 张 PNG（实机截图 / 合成演示，真实性见 `截图真实性清单.md`） |
| 短视频素材 | `动图/*.gif` | 5 个 GIF,3-4 秒循环,可嵌入任何地方 |

> 单文件 `index.html` 自带所有图和动图(`5.6 MB`),**拷到 U 盘、拷到客户电脑、传云盘,双击即可播放**,不需要任何依赖。

---

## 📦 产物清单

### 1️⃣ 图库(10 张)

> **真实性先说清楚**：这不是 10 张实机截图。当前图库由 **4 张纯实机窗口/浏览器截图 + 1 张实机登录页 + 1 张来源待核验 + 1 张实拍合成 + 4 张数据驱动合成渲染**组成。逐张证据见 `截图真实性清单.md`。

| 编号 | 文件 | 真实性 | 准确说明 |
|---|---|---|---|
| 10 | `图库/10_kb_dashboard.png` | 合成演示渲染 | KPI 来自实机快照；文档行和流水线为示意，不是控制台原图 |
| 11 | `图库/11_kb_search_drill.png` | 合成演示渲染 | 检索界面示意；0.912 等命中分数是脚本内演示数据 |
| 12 | `图库/12_n8n_tool_canvas.png` | 合成演示渲染 | 按真实工具契约重绘，不是 n8n 原生画布截图 |
| 13 | `图库/13_stream_guardrail.png` | 合成演示渲染 | 自检摘要来自快照，流式时间线为讲解示意 |
| 14 | `图库/14_telegram_mockup.png` | 实拍截图 + 合成 | Telegram 屏幕来自真实窗口；手机框和右侧卡片是后期合成 |
| 02 | `图库/02_lobechat_signin.png` | 实机浏览器截图 | LobeChat 登录页，1440×900；不是登录后的对话页 |
| tg1 | `图库/telegram_full.png` | 实机桌面窗口截图 | Telegram Desktop 1100×815；与 `telegram_desktop.png` 为同一张实拍副本 |
| tg2 | `图库/telegram_desktop.png` | 实机桌面窗口截图副本 | 同上，不是第二次独立采集 |
| n8n | `图库/n8n.png` | 实机浏览器截图 | n8n 登录页；不是工作流画布 |
| lb | `图库/lobechat.png` | 实机浏览器截图 | 也是登录页；原先写“LobeChat 主界面”不准确 |

> 合成图右下角的 `数据驱动渲染 · 数值取自实机 <时间戳>` 只证明其中标注的 KPI 来自快照，**不代表整张图是实机截图**。

### 2️⃣ 动图(5 个)

> 5 个 GIF 全部是**后期演示动效，不是产品录屏**。GIF 05 的底图含真实 Telegram 窗口截图，但手机框和消息出现动画仍是合成。

| 编号 | 文件 | 时长 | 内容 |
|---|---|---|---|
| 01 | `动图/gif_01_drag_upload.gif` | 2.2 s | 合成画面上的拖拽入库 / 切块动效 |
| 02 | `动图/gif_02_search_scoring.gif` | 2.9 s | 合成画面上的检索打分动效 |
| 03 | `动图/gif_03_n8n_canvas.gif` | 2.8 s | 合成工具图上的主干高亮动效 |
| 04 | `动图/gif_04_stream_thinking.gif` | 3.2 s | 合成画面上的流式打字机动效 |
| 05 | `动图/gif_05_telegram.gif` | 3.6 s | 真实 Telegram 窗口截图 + 合成手机消息动效 |

### 3️⃣ 演示大屏(单文件)
`index.html` · `5.6 MB` · 12 页 · ← → / Space 翻页 · N 讲稿 · F 全屏 · P 自动播放

12 页主题:
1. 封面(数据快照时间戳)
2. 为什么做这个(4 个真痛点)
3. 架构全景(10 容器 / 24 工作流 / 一条主干)
4. 知识库 · 入库(GIF 1)
5. 知识库 · 检索演练(GIF 2)
6. n8n · 工具画布(GIF 3)
7. 流式 · 不假死(GIF 4)
8. 对话实景(LobeChat 实拍)
9. 交付到手机(GIF 5)
10. 自检护栏(主动暴露 1 项失败)
11. 工程纪律(6 条踩过的坑)
12. 接下来(2 条待决策)

### 4️⃣ 演讲稿
`讲稿.md` · 12 页分秒级台词 + 10 个 Q&A 应答(为什么不用 Coze/为什么 n8n/可迁移/额度/Telegram 挂掉/失败感知/部署时间/代码量/厂商关门……)

---

## 🔄 怎么刷新数据

如果想用最新的实机数据重新生成整套产物:

```bash
python scripts/fetch-demo-data.py   # 从 n8n 拉最新数据 → demo-assets/_data.json
python scripts/render-screens.py    # 重渲染 5 张数据驱动图
python scripts/build-gifs.py        # 重生成 5 个动图
python scripts/build-deck.py        # 重打包单文件 HTML
```

预计耗时:< 60 秒。

---

## 📐 文件结构

```
deliverables/
├── index.html           ← 演示大屏(单文件,5.6 MB,双击即放)
├── 讲稿.md               ← 演讲稿(14 分钟,12 页 + Q&A)
├── 截图真实性清单.md      ← 逐张核验：实机 / 合成 / 待核验
├── README.md             ← 你正在看
├── 图库/                 ← 10 张 PNG(可独立分发,真实性分类见清单)
│   ├── 10_kb_dashboard.png
│   ├── 11_kb_search_drill.png
│   ├── 12_n8n_tool_canvas.png
│   ├── 13_stream_guardrail.png
│   ├── 14_telegram_mockup.png
│   ├── 02_lobechat_signin.png
│   ├── telegram_full.png
│   ├── telegram_desktop.png
│   ├── n8n.png
│   └── lobechat.png
└── 动图/                 ← 5 个 GIF(可独立分发)
    ├── gif_01_drag_upload.gif
    ├── gif_02_search_scoring.gif
    ├── gif_03_n8n_canvas.gif
    ├── gif_04_stream_thinking.gif
    └── gif_05_telegram.gif
```

---

## ⚠️ 已知差异

- `截图真实性清单.md` 是真实性的唯一说明入口；演示现场请按其中的措辞介绍，不要把合成图称为实拍。
- `02_lobechat_signin.png`、`lobechat.png` 都是登录页，不是登录后的 LobeChat 对话实景。
- `n8n.png` 是登录页，不是 n8n 工作流画布。
- `telegram_full.png` 与 `telegram_desktop.png` 都是 1100×815 的同一张真实 Telegram 窗口截图副本，不是两个独立时刻。
- `14_telegram_mockup.png` 与 5 个 GIF 是合成产物；只有其中嵌入的 Telegram 窗口区域来自实拍。
- 合成图有水印；纯实机截图没有这个水印。水印只说明标注的 KPI 来自实机快照，不代表整张图是实拍。

---

*准确说法：4 张纯实机截图 + 1 张实机登录页 + 1 张来源待核验 + 1 张实拍合成 + 4 张数据驱动合成渲染。*