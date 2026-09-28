# PivotAI Agent Platform · 演示资产包

> 4 份产物,任何电脑双击即放 · 数据快照:`2026-09-28 15:28`

---

## 🚀 怎么用

| 用途 | 文件 | 操作 |
|---|---|---|
| 现场演示 | **`index.html`** | 双击 → 键盘 `← →` 翻页 · `N` 看讲稿 · `F` 全屏 · `P` 自动播放 12s/页 |
| 念稿 | **`讲稿.md`** | 12 页分秒级台词 + 10 个 Q&A |
| 单图调用 | `图库/*.png` | 10 张高清 PNG(实拍 + 数据驱动渲染) |
| 短视频素材 | `动图/*.gif` | 5 个 GIF,3-4 秒循环,可嵌入任何地方 |

> 单文件 `index.html` 自带所有图和动图(`5.6 MB`),**拷到 U 盘、拷到客户电脑、传云盘,双击即可播放**,不需要任何依赖。

---

## 📦 产物清单

### 1️⃣ 图库(10 张)
| 编号 | 文件 | 来源 | 说明 |
|---|---|---|---|
| 10 | `图库/10_kb_dashboard.png` | 数据驱动渲染 | 控制台 · 知识库 11 篇 / 195 切块 / 83K 嵌入 token |
| 11 | `图库/11_kb_search_drill.png` | 数据驱动渲染 | 检索演练 · 6 命中 / 最高 0.912 分 |
| 12 | `图库/12_n8n_tool_canvas.png` | 数据驱动渲染 | Chat Gateway · 15 个服务端工具 |
| 13 | `图库/13_stream_guardrail.png` | 数据驱动渲染 | 自检 19/20 + 流式透传时间线 |
| 14 | `图库/14_telegram_mockup.png` | 实拍合成 | 手机样机 + 本机 Telegram 实拍对话 |
| 02 | `图库/02_lobechat_signin.png` | 实拍 | LobeChat 登录页 1440×900 |
| tg1 | `图库/telegram_full.png` | 实拍 | Telegram Desktop 全屏 |
| tg2 | `图库/telegram_desktop.png` | 实拍 | Telegram 窗口紧凑 |
| n8n | `图库/n8n.png` | 实拍 | n8n 默认界面 |
| lb | `图库/lobechat.png` | 实拍 | LobeChat 主界面 |

> "数据驱动渲染"=图上右下角有 `数据驱动渲染 · 数值取自实机 <时间戳>` 水印,说明这张图的数字来自真机 API,**不是凭空设计的**。

### 2️⃣ 动图(5 个)
| 编号 | 文件 | 时长 | 内容 |
|---|---|---|---|
| 01 | `动图/gif_01_drag_upload.gif` | 2.2 s | 拖拽入库 → 实时切块预览 |
| 02 | `动图/gif_02_search_scoring.gif` | 2.9 s | 检索打分逐条浮现 |
| 03 | `动图/gif_03_n8n_canvas.gif` | 2.8 s | n8n 工具画布 · 执行流经主干 |
| 04 | `动图/gif_04_stream_thinking.gif` | 3.2 s | 流式打字机效果 |
| 05 | `动图/gif_05_telegram.gif` | 3.6 s | 手机样机 · 消息送达 |

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
├── README.md             ← 你正在看
├── 图库/                 ← 10 张 PNG(可独立分发)
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

- **LobeChat 主界面**(`lobechat.png`)和 Telegram 桌面截图(`telegram_*.png`)都是 800×600 老分辨率(用户原先生成的)。其他图都是 1440×900 高清。
- **LobeChat / Telegram 登录页截图** 是没登录前的样子,**不需要凭据即可访问**,所以适合直接放演示里。

---

*所有截图 / 渲染 / 动图 都带有右下角水印 `数据驱动渲染 · 数值取自实机 <时间戳>`,可核。*