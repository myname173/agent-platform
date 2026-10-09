# 面试演示台

用界面演示这个项目。打开 `面试演示台.html` 即可全屏播放（单文件、图片已内嵌、不依赖网络）。

## 怎么用

| 按键 | 作用 |
|---|---|
| `←` `→` / 空格 | 翻页（也可以点屏幕左右侧） |
| `N` | 显示/隐藏讲稿（每页都有，讲什么、为什么这么讲） |
| `F` | 全屏 |
| `Home` / `End` | 跳到首/尾页 |

共 27 页。顺序是：封面 → **可信度声明** → 问题与定位 → 架构总览 →
**功能全景 ①②③④⑤⑥⑦⑧⑨⑩⑪⑫** → 前端走查 ①②③④⑤⑥⑦ → 工程亮点 → 可验证性 → 已知问题 → 收尾。

「功能全景」11 页是按能力域铺开的，回答的是「你做了什么功能」——它和后面的前端走查是两件事：
前者讲**能力面**，后者讲**界面**。

| 页 | 讲什么 |
|---|---|
| 功能全景 ① | 一张表看懂能力面（含证据分档） |
| 功能全景 ② | 对话能力：15 个网关工具 + 语音/图片 |
| 功能全景 ③ | 定时任务与推送 |
| 功能全景 ④ | 工具与沙箱：run_python / 审批 / 出向 MCP / L2 点火权 |
| 功能全景 ⑤ | 治理与可观测：幂等 / tool_trace / 限流 / 保留 |
| 功能全景 ⑥ | **语音与图片：端到端实测**（页面里可直接播放实测音频） |
| 功能全景 ⑦ | Telegram 双向入口（入向 webhook / 出向轮询） |
| 功能全景 ⑧ | 运维与工程化：备份 / 心跳 / 源码化 / CI / 对象存储 |
| 功能全景 ⑨ | **文档工厂**：会议纪要 → 可打印/可推送/可归档的成品文档（含真实产物） |
| 功能全景 ⑩ | **把「就绪但没跑过」的 10 项能力真跑一遍**（见下节） |
| 功能全景 ⑪ | **告警链路**：从触发到送达，以及静默的设计取舍 |
| 功能全景 ⑫ | **产品级文件上传**：真从对话界面传了一个文件（并修掉它暴露的 2 个缺陷） |

前端走查这 7 页讲的是**两个不同的前端**，别混：

| 页 | 讲的是 | 端口 |
|---|---|---|
| 前端 ① | **对话前台 · PivotAI** —— 基于 LobeChat 定制主题 | `:3210` |
| 前端 ②③④ | **控制台** —— 自建 Next.js 工作台（对话联调 / 总览 / 运行态势） | `:3001` |
| 前端 ⑤⑥ | n8n 原生编辑器（运行总览 + 画布） | `:5678` |
| 前端 ⑦ | 控制台其余页面速览 | `:3001` |

## 截图真实性说明

**`实机截图/` 里 23 张图全部采集自本机正在运行的实例**，采集时间 2026-10-04 22:00 – 10-08 15:13。

| 文件 | 内容 | 采集方式 |
|---|---|---|
| `01_overview.png` | 控制台总览（真实 24h 数据） | Clerk 免密票据登录后整页截图 |
| `02_ai_chat.png` | 自建聊天页真实一轮对话 | 在页面里真实输入并回车，等模型回答完 |
| `02_ai_chat_empty.png` | 聊天页空态 | 同上 |
| `03_knowledge.png` | 知识库 | 同上 |
| `04_keys.png` | API 密钥 | 同上 |
| `05_models.png` | 模型与成本 | 同上 |
| `06_people.png` | 人员目录 | 同上 |
| `07_alerts.png` | 告警 | 同上 |
| `09_workflows.png` | 运行态势（24 条工作流） | 同上 |
| `10_docs.png` | 文档 | 同上 |
| `20_n8n_workflows.png` | n8n 概览（3,879 次执行 / 24 条工作流） | n8n 管理员账号登录后截图 |
| `21_n8n_chat_gateway.png` | Chat Gateway 画布（22 节点） | 同上，已缩放至适应 |
| `22_n8n_mcp_server.png` | MCP Server 画布 | 同上 |
| `23_lobe_pivot_themed.png` | **PivotAI 对话前台登录页（主题已注入生效）** | 见下节「PivotAI 主题」 |
| `30_briefs.png` | 晨报页（含真实检索结果的晨报正文） | Clerk 免密票据登录后截图 |
| `31_topics.png` | 动态监控页（**空态**：当时 0 个关键词） | 同上。**已被 `51` 取代**，见下节 |
| `32_settings.png` | Settings 页（告警阈值 / 嵌入额度 / 保留策略） | 同上 |
| `41_telegram_bridge.png` | **Telegram Bridge 工作流画布**（入向 webhook / 出向轮询） | n8n 管理员账号登录后打开该工作流截图 |
| `50_alerts_fired.png` | **告警页：错误率 89.7% 真触发，状态「已送达」** | 10-08 01:24 采集，见下节「9 项能力实跑」 |
| `51_topics_watch.png` | **动态监控页：已配关键词并真扫描过**（取代 `31` 的空态） | 同上 |
| `52_briefs_weekly.png` | 晨报页（10-05 那篇，含「平台状态」自述段） | 同上，已裁掉页面底部空白 |
| `53_overview_alert.png` | **总览页「最近告警」卡片：89.7% 真触发** | 同上，从整页图中裁出告警卡片区域 |
| `60_upload_product.png` | **对话前台：文件已从 composer 真实上传**（无进度条＝已完成） | 10-08 15:13 采集，见下节「产品级文件上传」 |

### 这轮补齐：10 个「就绪但没跑过」的能力，全部真跑了一遍

上一版演示台里，我主动在「证据分四档」表里标了 7 项**只有代码、没有运行数据**的能力。
这轮把它们全部**真跑了一遍**，之后又补了 3 项（记忆 / 对象存储通路 / 产品级上传），
一共 10 条，每项都在数据库里留下真实运行痕迹（不是插假数据）：

| 能力 | 数据表 | 跑前 | 跑后 | 怎么触发的 |
|---|---|---|---|---|
| 沙箱人工审批 | `sandbox_approvals` | 0 | **1** | 让模型跑联网代码，被网关拦下并登记 `sha256(代码)+理由`，`status=pending` |
| L2 自建流程工具 | `workflow_tools` | 0 | **1** | 走 `action=register` 注册 `echo-demo` |
| 出向 MCP | `mcp_servers` | 0 | **1** | 把平台自己的 `/webhook/mcp` 注册成外部服务器 |
| 周报 Weekly Review | `weekly_reviews` | 0 | **1** | 真跑一次导出，产出 194 字回顾并推 TG |
| 动态监控关键词 | `topic_watch` | 0 | **1** | 加关键词「Agent 平台 开源」，立即扫描（`scanned=1, new_items=0`） |
| 错误率告警 | `ops_alerts` | 0 | **1** | 造出 `total=29 / errors=26` → 89.7% 越过 50% 阈值，`severity=critical` |
| 告警静默窗口 | `ops_alert_silence` | 0 | **1** | 设 120 分钟维护窗口，再 `action:"clear"` 解除（截图为设窗口状态） |
| **长期记忆提取** | `agent_memories` | 0 | **2** | `action:"extract"` 喂一轮真实对话 → 模型判定出 2 条长期偏好，落库并镜像进 LobeHub |
| **对象存储 S3 通路** | `lobechat-files` | 0 | **1** | 用平台自身凭据 PUT/HEAD/GET/LIST，全部 200、字节一致、对象真的落盘 |
| **产品级文件上传** | LobeChat `files` | 0 | **1** | 真从对话前台 composer 上传一份 100 KB 代码规范，取回后 SHA-256 与本地一致 |

**几个值得单独说的点**：

- **出向 MCP 是「自己连自己」**：注册的是本平台自己的 MCP 端点，
  `mcp_list_tools` 真返回了 **17 个工具** —— 证明出向调用链路是通的，不是只写了个注册接口。
- **告警不是造记录，是造出了真实错误率**：89.7% 越过阈值 → `severity=critical` → 落库 →
  `delivered=ok`（**真的推到了 Telegram**，告警页显示「已送达」）。整条链路走完。
- **记忆是双库闭环**：`agent_memories`（本机 pgvector）**和** LobeHub 的 `user_memories`
  两边都写进去了（`mem_tg0000000001/2`），再用自然语言问回来能命中 **score 0.71** ——
  「记忆」不是写了个表，是写入、镜像、检索三条路径都通。
- **沙箱审批那条停在 `pending`，这是诚实的**：审批按钮只发到 Telegram，
  我没法替用户点那个按钮，所以记录保持待审状态。**这本身就是要讲的证据，
  而且它暴露了一个真实短板 —— 控制台没有审批入口**（已记入「已知问题」）。
- **`mcp_servers` 是只读的，这是设计不是缺陷**：设计原则是「模型可以用它们，但永远不能添加它们」，
  注册只能由 owner 侧写入。

### 对象存储：通路通了 ≠ 产品可用（一个刻意没写满的结论）

S3 通路**实测全通**，但**不能**因此说「文件功能可用」：

| 层面 | 状态 |
|---|---|
| 存储层通路 | ✅ **通** —— PUT/HEAD/GET/LIST 全 200，GET 回来的字节与写入完全一致，容器里能看到对象落盘 |
| 凭据 | ✅ 用的就是 `.env` 里 LobeChat 自己在用的那对（`MINIO_ROOT_USER/PASSWORD`），不是另配的 |
| **产品入口** | ❌ **没走通过** —— 从对话前台真传一个文件这件事还没做过，LobeChat 的 `files` 表仍是 **0 行** |

验证脚本在 `_scratch/s3_probe.py`（用 stdlib 手写 AWS SigV4，因为本环境装不了 `boto3`）。
**演示时要说清这条边界**：能说的是「存储层就绪且经过独立验证」，
不能说的是「上传功能可用」—— 后者需要从产品界面真传一次。

### 一个自相矛盾：告警渠道两个页面口径不一致

| 页面 | 显示 |
|---|---|
| Settings 页 | `webhook_configured = false`（未配 `ALERT_WEBHOOK_URL`） |
| 告警页 | **已配置（format: telegram）** |
| 实测 | 告警**真的送达了**（`delivered=ok`） |

同一件事两个页面给出相反答案 —— 说明 Settings 的判断口径漏了 Telegram 分支。
**已主动记入「已知问题」页**，而不是等面试官翻出来。

### 证据分四档，我在演示台里逐项标了

| 档位 | 含义 | 例子 |
|---|---|---|
| **端到端实测** | 我现场跑通并把原始输出留在页面里 | **语音双向**（页内可播放音频）、**图片视觉**（模型原话）、**告警链路**、**9 项能力实跑** |
| 控制台实拍 | 界面截图可直接看到 | 总览 / 晨报 / Settings / 运行态势 |
| 真实数据表 | 数据落库，可 SQL 核对 | `admin_audit` 里 run_python 3 次、`chat_executions` 202+ 行、`admin_audit` 19 行 |
| 仅源码与端点 | 代码与路由在，但**没有运行数据** | 见下：**这轮已压缩到只剩 1 个缺口** |

**上一版这一档里有 5 项**（沙箱人工审批 / L2 自建工具 / 出向 MCP / 动态监控 / 告警），
这轮跑掉了 4 项，加上周报、静默窗口、记忆、对象存储通路、产品级上传，一共补了 10 项。
**「只有源码、没有运行数据」这一档现在已经清零** —— 最后一个缺口（产品级文件上传）
在 10-08 补完，而且过程中真的踩到了两个 bug，见下节。

有真实数据的：`todos` 3 条、`reminders` 1 条、`chat_executions` 202+ 行、
`idempotency_records` 2 条、`admin_audit` 19 行、`selfcheck_runs` **26 次**、`daily_briefs` **4 篇**、
`cron_runs` **63 条**、`kb_usage` 1 行（369 tokens）、`documents` 1 篇（会议纪要）、
`weekly_reviews` 1 份、`ops_alerts` 1 条、`sandbox_approvals` 1 条（待审）、
`workflow_tools` 1 个、`mcp_servers` 1 个、`topic_watch` 1 条、
`agent_memories` **2 条**（含 LobeHub 镜像）、`lobechat-files` **1 个对象**。

## 产品级文件上传：真从界面传了一个文件（并修掉 2 个真实缺陷）

这是上一版**唯一剩下的真实缺口**。10-08 补完，而且它不是「顺手就通了」——
测试过程先后暴露了两个**只在真实链路上才会现形**的缺陷。

### 传了什么、怎么传的

| | |
|---|---|
| 文件 | ① **Airbnb JavaScript 代码规范**（`.md`，**100,456 B / 3,480 行**）<br>② **Uber Go 代码规范**（`.md`，**87,321 B**，修复生效后复传） |
| 入口 | 对话前台 composer →「添加文件、技能和更多上下文」→ **附件** → **上传文件或图片** |
| 截图 | `实机截图/60_upload_product.png`（文件 chip 已挂在 composer 上，无进度条＝已完成） |

### 三处都对上了

| 层面 | 结果 |
|---|---|
| `lobechat.files` | **0 → 2 行**：`file_Vnyp8Br7t97w`（100456 B）、`file_2QzjIBwGe2G5`（87321 B） |
| `lobechat-files` 桶 | **2 → 3 个对象**落盘（RustFS 内部存成 `xl.meta`） |
| **字节级回读** | 两份都从 S3 取回对象，**SHA-256 与本地文件逐字节一致**：<br>`a86cece67595d5e0…13cdad`（Airbnb）· `9f29ffce…c09a`（Uber Go） |
| `file_uploads.status` | `released`（中止）→ **`settled`（完成）** —— 这个状态跃迁本身就是证据 |

> **为什么传了两次。** LobeChat **按内容 hash 去重**：第二份文档必须与第一份 hash 不同，
> 才能真的走一遍**写入**路径（否则只是命中已有记录，`files` 表纹丝不动）。
> 第一次复传同一份 Airbnb 文档时 `files` 表就是 0 变化 —— 这反而侧面印证了去重逻辑。
> 换用 Uber Go 规范（`sha256` 不同）后，`files` 1 → 2、桶 2 → 3，写入路径确认跑通。

### 缺陷 1：`S3_ENDPOINT` 固化了容器创建时的 LAN IP

```
Error in tRPC handler on path: upload.createS3PreSignedUrl, type: mutation
Error [TRPCError]: connect ECONNREFUSED 10.55.251.44:9000
```

- **根因**：`docker-compose.yml` 里 `S3_ENDPOINT=http://${PLATFORM_LAN_IP}:9000`，
  而环境变量是**容器创建那一刻**注入的。路由器换了 IP（`10.55.251.44` → `192.168.31.91`）后，
  容器里还留着旧地址，连不上。
  再往下挖一层：签发预签名 URL **之前**，服务端要先 stat 一次对象（`reserveUpload` 拿到了
  `FileS3` 实例），这次调用走的是**服务端 S3 客户端**。而 LobeChat 只在 `S3_INTERNAL_ENDPOINT`
  有值时才为服务端单独建客户端 —— **该变量当时没设**，服务端就退回去用 `S3_ENDPOINT`，撞上旧 IP。
- **诊断**：在容器内逐个探端点，一眼看出是地址问题而不是 S3 挂了：

  | 从 lobechat 容器内访问 | 结果 |
  |---|---|
  | `http://10.55.251.44:9000`（当时的配置） | **Timeout ✗** |
  | `http://minio:9000`（Docker 服务名） | **403 ✓ 可达** |
  | `http://127.0.0.1:9000` | ECONNREFUSED（那是容器自己的 localhost） |
  | `http://host.docker.internal:9000` | **403 ✓ 可达** |

- **修法**：改 `.env` 的 `PLATFORM_LAN_IP` / `LAN_IP`，然后 **`docker compose up -d`** 重建
  （`restart` 不会重新注入环境变量）。改前已备份 `.env.bak-*`。
- **根治方向（2026-10-08 修正过，第一版写错了）**：第一版写的是「把 `S3_ENDPOINT` 换成 Docker
  服务名 `minio:9000`」—— **这是错的**。读 LobeChat 的 `FileS3` 才看清：`S3_ENDPOINT` 正是用来
  构建 **presignClient** 的，也就是**浏览器拿到的预签名 URL 的主机名**；而宿主机并不解析
  `minio`（hosts 里没有该条目，`ping minio` 失败）。改成容器名只会让浏览器拿到一个解析不了的
  主机名，把上传弄坏 —— 恰恰是它想修的那个功能。
  **正确的开关是 `S3_INTERNAL_ENDPOINT`**（服务端专用，当时未设），已写进 `docker-compose.yml`
  并默认 `http://minio:9000`（容器内实测 403 可达，旧 LAN IP 实测不可达）。
  注意它只修好一半：**浏览器那一半仍然嵌着 LAN IP**，所以换网后照样要 `up -d` 重建，
  只是服务端不会再先炸、错误也会更晚才出现。
  **这一半是「有意保留的取舍」，不是没修完** —— 见下。
- **为什么保留 LAN IP（而不是换成 `localhost`）**：链接主机名只能是**一个固定值**，
  `S3_PUBLIC_DOMAIN` 经读码确认**只参与 CORS 白名单、不改写链接主机名**，所以是个真二选一：

  | 填什么 | 宿主机浏览器 | 手机浏览器（同一 WiFi） | 换网后 |
  |---|---|---|---|
  | `localhost:9000` | 能传 | **不能**（`localhost` = 手机自己） | 不受影响 |
  | **LAN IP（当前选择）** | 能传 | **能传** | **失效，需重跑启动脚本** |

  选 LAN IP 是为了保住「手机同 WiFi 也能从网页上传」。**代价有解**：
  重跑一次 `启动Agent平台.cmd` 即可 —— 它会自动同步 IP、`up -d` 重建、并重注被冲掉的主题。
  **Telegram 完全不受影响**：`stream-bridge` 只有出站的 `getFile`/`sendVoice`/`sendMessage`，
  **没有 `setWebhook`**，所以手机发命令/语音/图片走的是「手机 → Telegram 云 → 平台出站去拉」，
  **不经过局域网 IP**。
- **为什么不干脆做 DHCP 保留**：本机是**在不同网段之间漫游**（一天内 `10.55.251.44` →
  `192.168.31.91` → 又回 `10.55.251.44`），而 DHCP 保留只在**单一子网内**有效，换网络就白搭；
  校园网段的 DHCP 服务器也不在本机手上。加上启动脚本已经能自愈，保留属于重复建设。
  完整评估见仓库 `DEPLOY-NOTES.md §8`。
- **A/B 实证（2026-10-08，不是推测）**：为证明这条根因，做了一次对照实验 ——
  - **阶段 A**：用 `S3_INTERNAL_ENDPOINT=http://10.55.251.44:9000`（已死的旧 IP）重建容器，
    从真实 UI 上传。**服务端日志精确复现了原始故障**：
    `Failed to verify existing file hash storage object: Error: connect ECONNREFUSED 10.55.251.44:9000`
    —— 注意它是 **hash 校验那一步**炸的，正是 `reserveUpload` 里的服务端对象调用。
  - **阶段 B**：用 compose 默认值（`http://minio:9000`）重建，同一份文件重新上传，
    `files` 表真的多了行、桶里真的多了对象、回读 SHA-256 一致，**日志里 0 条 ECONNREFUSED**。
  - 两个阶段唯一变量就是这一个环境变量，故障随之出现、随之消失。
- **已生效**：`lobechat` 容器已按新 compose 重建（`b9c79b77` → `ff3804d6` → 当前），
  `printenv` 确认 `S3_INTERNAL_ENDPOINT=http://minio:9000` 已在运行时生效，
  PivotAI 主题也已重新注入并复验（13 CSS + 5 JS，登录页实际服务的 CSS 里含主题标记）。

### 缺陷 2：RustFS 桶没配 CORS —— 200 不等于 CORS 通过

预签名 URL 签发成功了，但浏览器的 `PUT` **根本不发出去**，应用随即 `abortS3Upload`。
翻前端的网络记录，四行就锁死了：

```
POST  upload.createS3PreSignedUrl   200        ← 签发成功（说明缺陷 1 已修好）
OPTIONS  …/lobechat-files/….md     200        ← 预检"通过"，但没有任何 Access-Control-* 头
PUT      …/lobechat-files/….md     (无状态)   ← 浏览器因此根本没发出去
POST  upload.abortS3Upload          200        ← 应用收到失败，主动放弃
```

把预检单独复现一次（带上 `Origin` 头）就坐实了 —— 回的是 `200 OK`，但响应头只有
`x-request-id` / `x-amz-request-id` / `content-length` / `date`：**一个 CORS 头都没有**。
浏览器从 `:3210` 直传 `:9000` 属跨域，预检不合格就**不会发**真正的 PUT。
**200 不等于 CORS 通过，这是最容易误判的地方。**

- **修法**：给桶 `PutBucketCors`，放行控制台来源。脚本 `_scratch/set_bucket_cors.py`。
- **复验**：预检已经返回 `access-control-allow-origin` / `-methods` / `-headers` / `-max-age`。

### 修复的证明：状态跃迁

```
file_uploads.status
  修复前  released  ×2   （中止）
  修复后  settled   ×1   （完成）
```

### 为什么这两个坑「只验存储层」永远碰不到

直接调 S3 API 验通路时，请求由**我**发出：我不介意跨域（curl 没有 CORS 概念），
我也不经过宿主机的 LAN IP。而真实链路是
**浏览器 → 应用服务端（签发预签名 URL）→ 对象存储**，
缺陷 1 卡在第二跳，缺陷 2 卡在第一跳。**这就是为什么必须测产品入口，而不是测底层通路。**

> 复现用脚本都在 `_scratch/`（含一份 `_scratch/README.md` 说明用法）：
> `upload_via_ui.sh`（走真实 UI 上传）、`set_bucket_cors.py`（配 CORS 的一次性脚本）、
> `verify_upload.py`（取回比对 SHA-256）、`s3_probe.py`（纯存储层通路）、
> `dexec.sh`（Docker API 抖动时的重试包装）。
>
> **其中配 CORS 那件事已经「毕业」出 `_scratch/`**：正式版是仓库根的
> `scripts/provision-bucket.sh`（幂等、来源域从 `.env` 推导、自带预检复验），
> `set_bucket_cors.py` 保留为当时的原始证据。

## 语音与图片：现场实测（第 10 页）

这一页是**跑出来的**，不是从代码推出来的。测试素材放在 `测试素材/`：

| 文件 | 大小 | 说明 |
|---|---|---|
| `语音测试.wav` | 485,804 B | 16 kHz 单声道 / 15.2 s。qwen-tts（音色 Cherry）合成，**已 base64 内嵌进 HTML，可直接播放** |
| `图片测试-输入.jpg` | 279,603 B | Wikimedia 猫图，喂给平台网关做视觉测试 |

**语音**：`POST http://127.0.0.1:3211/voice/reply`（`{text, chat_id}`）→ 实测 `HTTP 200 {"ok":true,"mode":"voice"}`，
合成音频 728,684 字节并**真的发到了 Telegram**；再把同一段音频回灌 qwen3-asr-flash，
识别文本与原文**相似度 0.830**。

**图片**：`POST http://127.0.0.1:5678/webhook/v1/chat/completions`，model=`deepseek-v4-flash`，
图片以 base64 data URI 放进 content 数组 → 实测 `HTTP 200`、`usage.prompt_tokens: 3557`。
模型答出「**背景虚化处能看到一根红色管子状物体**」—— 那根红管是背景里的虚化杂物，
**没真看到图是编不出来的**，这比「认出是猫」更能证明视觉真的通了。

**两个必须主动说的边界**：

1. 自建控制台的 Playground 是**纯文本**的（无上传 / 粘贴），所以图只能从**对话前台**或 **Telegram** 进。
2. `stream-bridge` 的 `/voice/transcribe` 与 `/image/fetch` **只接受 Telegram `file_id`**，
   没有直接提交原始音频 / 图片的 HTTP 口 —— 所以「发一条 TG」才是这两个端点的真实入口。
3. 同一个问题跑两次，**措辞会不同**（网关会带上该会话的历史），但「橘猫 + 红管 + 眼神方向」两次都稳定说对。

## 文档工厂（第 13 页）：企业工作包的真实产物

「会议行动项 / 智能摘要 / 动态监控」这三个企业工作包之前只在 ④ 页提了一句，第 13 页补了证据。

`10_docs.png` 是控制台的 **Docs 页**，列表里躺着 1 篇**真生成的成品文档**：

| 字段 | 值 |
|---|---|
| 标题 | 平台部署验证会 |
| 类型 | 会议纪要（`kind=minutes`） |
| 摘要 | `- 三条链路全部打通，自检 42/47` |
| 来源 | `raw:2026-10-04 平台部署复盘会 参会：pigpig…` |
| 生成时间 | 2026/10/4 12:56:01 |
| 结构 | `meta={"actions":2,"sections":3}` —— 自动抽出 2 条行动项 / 3 个章节 |
| 归档 | 回写知识库 `kb_doc_id: kb-52d8ef4c31cc3c1a`，之后对话里能检索到 |

三个出口：**推送**（发到 TG）· **复制链接**（生成 **7 天免登录链接**）· **归档**（正文存进知识库）。

**这轮补齐**：「导出本周周报」按钮之前只跑过 `dryRun`（`weekly_reviews` 表 0 行），
这轮**真跑了一份**：产出 194 字回顾、`saved=true`、`pushed=true`（推到了 TG），
总览页的「周报」卡片已经能看到内容（「🗓️ 本周回顾 · 2026-10-05 ~ 2026-10-11（更新至 2026-10-08）」「【晨报】本周 3 份」）。
**所以现在能拿出来的成品是「会议纪要 1 篇 + 周报 1 份」。**

## 一个踩过的坑：n8n 画布徽标会滞后

第 11 页那张 Telegram Bridge 画布截图里，右上角显示 **Inactive**、还弹了
「Schedule Poll is not running! Activate workflow to enable it.」。
但同一时刻：

- `workflow_entity` 表里 **24 条工作流全部 `active=t`**；
- `telegram_state.lock_ts` 刚被轮询循环写过（核对时距上次写入仅 **62 秒**）。

所以这是**编辑器侧的显示滞后**。判据是：**工作流有没有在跑，看库和运行痕迹，不看画布徽标。**
（我尝试重新加载页面复现，第二次直接白屏，所以截图保留了第一次那张 —— 这个"不一致"本身留在演示台里当例子讲。）

### 没有用的一张截图

`Notifications` 页虽然挂在控制台侧边栏里，但内容是**写死的假数据**
（"Sarah Connor 加入了 Engineering 工作区""Dashboard Pro 已加入目录"），
是 shadcn 脚手架模板残留。**因此没有放进演示台**，只在「已知问题」页里作为问题列出。

### PivotAI 主题：这是怎么来的

仓库 `custom-theme/` 里带了一套把 LobeChat 改成自有品牌 **PivotAI** 的注入脚本，
但默认没有应用到运行中的容器。我把它**真的跑了一遍**：

1. 执行 `pivot-apply.js`（在 `lobechat` 容器内运行），往 `/app/public/_spa*/` 下的
   4 套 SPA bundle 注入受管区块，实测 **13 个 CSS + 5 个 JS**。
   受管区块带 `PIVOTAI-THEME-V2:START/END` 标记，重复执行是原地更新；首次注入会写
   `.pivot-backup`，`--remove` 可一键还原。
2. 重启 `lobechat` 容器 —— **LobeChat 的静态文件清单是启动时快照的**，不重启不会生效。
3. 验证生效（不是"看着像"）：
   - 登录页实际被服务的 `/_spa-auth/assets/vendor-antd-*.css` 与 `index-*.css` 里
     都能 grep 到 `PIVOTAI-THEME-V2:START`；
   - 页面标题变成 `PivotAI - 从对话到执行 | Chat less. Ship more.`；
   - 页面上出现主题的 canvas 星空引擎（`canvas` 节点数 = 1）。

**如实说明两点**：

- 截图是**登录页**，因为 LobeChat 应用本身要登录才能进主界面。登录页已经能看出
  品牌替换（"登录或注册你的 PivotAI 账号"）+ 星空底图 + 右上角 PivotAI 徽标。
- 主题是**注入进容器内的**，所以 `docker compose up` 重建容器或重新拉镜像会冲掉，
  需要重跑一次。仓库自带的 `theme-keeper.ps1`（计划任务，5 分钟一次自动补刷）我**没能验证**——
  当前环境不允许注册计划任务，所以这一环只在演示里说明机制，不声称已验证。

### 品牌人脸「注进去了却看不见」——一个值得讲的排查（2026-10-09 补）

主题里有一张 `pivot-face.jpg`（7680×4056 的女性数字人像），是 PivotAI 的品牌图。
但它**在登录页上看不到**。第一反应是「图没注进去」或「用错前端了」，**两个都不是**：

| 怀疑 | 实测 | 结论 |
|---|---|---|
| 图片有问题 | 2,093,512 B，7680×4056，可正常解码 | 排除 |
| 没注进去 | 4 套 SPA 目录都含 `PIVOTAI-THEME-V2:START` | 排除 |
| 元素没生成 | `#pivot-face-mat` 在 DOM 里，`background-image` 正确，`opacity: 0.28` 生效 | 排除 |

**是「在，但看不见」。** 根因其实有**四条**：前两条是当天凌晨查出来的，
后两条是中午把底色定成黑的时候才浮出来的。

1. **深色底被自己后面的规则冲掉了。** CSS 第 74 行写 `html, body { background-color: #030712 !important }`，
   但第 100 行又写 `html, body, #__next, #root, … { background: transparent !important }`
   —— **同等特异性、位置更后，后者胜**。而 canvas 只铺 alpha ≤ 0.05 的淡绿，
   **没有任何元素真正画出那块深色底**，页面回落到浏览器默认白。
2. **`mix-blend-mode: screen` 是「变亮」混合。** 深底上是一张发光水印脸，
   白底上 `screen` 结果无限接近纯白 —— **脸彻底消失**。这才是症状的真正来源。
3. **LobeChat 在「没存过主题」时默认 light。** 实测：全新会话 `localStorage` 为空
   → `html[data-theme="light"]`、`color-scheme: light`。所以一个干净的浏览器打开 :3210
   **本来就是白底** —— 不是「用户存过浅色」，是**默认就浅**。
4. **`backdropIsLight()` 的遍历方向反了**（这条是修好 1、3 之后才暴露出来的）：
   它**从底往上**找第一个画了底色的元素，html/body 一旦有了真实底色就**永远停在 html**，
   于是无论页面多白都报「深色」→ 浅底上人脸又没了。

**修法**（三处，缺一不可）：

- **把 `html, body` 从那条透明规则里删掉** —— 只留中间容器，底色由 html/body 自己负责。
  首屏在 hydration 之前就已是深色，也没有白闪。
- **引擎抢先种下 `localStorage.theme='dark'`**（只补 `null` 和 `auto`，用户显式选过就不动）。
  注入的 JS 落在 `vendor-ui-runtime-*.js`，**早于业务模块求值**，所以赶得上在主题模块读取之前写进去。
  **这一步才是真正的修复** —— 让 app 自己变深色，而不是拿 CSS 去盖。
- **`backdropIsLight()` 改判定顺序**：先信 app 自己声明的 `data-theme` / 内联 `color-scheme`，
  再退到 `prefers-color-scheme`，最后才采样；采样也**改为从顶往下**并加覆盖面积过滤。

> 凌晨为什么说「不能简单把底改回深色」？因为那时登录页真的处在 light 模式，
> 标题文字是 `rgb(8, 8, 8)`，硬铺深底会把字一起吞掉。
> **正确做法不是盖 CSS，而是让 app 别处在 light 模式** —— 也就是上面第二条。
> 方向对了，这个顾虑就自己消失了。

**中途还有一版错修法，值得单独说。** 做「图层自适应底色」时，第一版只在初始化时采样一次，
实机一测就露馅：

```
初始（浅底）        blend = multiply   ✓
切到深色（不刷新）  blend = multiply   ✗ 脸又没了
```

根因是**竞态**：初始化时应用还没把持久化的主题应用上去（要等 hydration），底色仍是白 →
锁上 `multiply`；随后翻成深色，而 `multiply` 在深底上等于把脸压进黑色 ——
**正是要修的症状，只是镜像了一遍。** 改成 `syncFaceBlend()` 持续跟住：
有界定时器（120/400/900/1800/3000/5000 ms，因为主题在 hydration 之后才落地）
+ `<html>` 上的 `MutationObserver`（运行时切换主题落在这里）
+ `prefers-color-scheme` 监听（"Auto" 跟随系统）。

**验证（四阶段，逐一读 DOM，不是「看着像」）**：

| 阶段 | 触发 | `data-theme` | `matClass` | blend | opacity |
|---|---|---|---|---|---|
| 1 初始 | 加载 | `dark` | `pivot-face-on` | `screen` | 0.28 |
| 2 切浅色 | 点主题菜单，**不刷新** | `light` | `pivot-face-on pivot-face-light` | `multiply` | 0.34 |
| 3 切回深色 | 点主题菜单，**不刷新** | `dark` | `pivot-face-on` | `screen` | 0.28 |
| 4 深色下刷新 | 重新导航 | `dark` | `pivot-face-on` | `screen` | 0.28 |

阶段 1 现在**直接就是深色**；2/3 证明**运行时切换**双向都对，4 证明**加载路径 + 持久化**也对。
**另测登录后的 `/onboarding` 同样是深色**（人脸 + 星场都在），说明不只是登录页。

证据图在 `_scratch/`：`dark-auth-1.png`、`face-dark-auth.png`、`face-light-noreload.png`、
`chat-dark-2.png`（onboarding）；脚本 `verify-dark.sh`、`capture-both.sh`、`chat-login.sh`（可现场复现）。

> 浅底那版的不透明度是按算术定的：`multiply` 在纯白上 `结果 = 255*(1-a) + p*a`，
> 旧值 `a≈0.156` 只压暗约 17/255 级 —— DOM 里在、人眼看不见。调到 `≈0.31` 才读得出来。
> 浅底现在是**兜底路径**（只有显式选 Light 才会走到），但两套参数都还在用。

> 已知缺口：登录页**左上是 `LobeHub` 的 SVG logo**，品牌替换只改文本节点、换不掉矢量图，
> 于是出现「左上 LobeHub / 右上 PivotAI」的不一致。**未修**。

### 配色换成「鲜艳清新的浅绿」（2026-10-09）

用户要求：光点与动态换成鲜艳清新一点的浅绿。原来整族是
`#3B82F6 (Electric Blue) · #06B6D4 (Cyber Cyan)`，现在换到 green / emerald
（CSS 73 处 + JS 20 处 + 星座连线 `HUES` 四档，脚本 `_scratch/retint-green.py` 可审计）。

**同一条指令里的「用白底」当天中午就改回黑底了**（「还是不用白底，用黑底吧」）。
绿色主色不变，只是底色定为黑 —— 原因见上一节的第 3 条根因。

**星场要按底色分两套参数**：同一组 alpha 在白底/黑底观感完全不同。
星点白底 `0.95`、黑底 `0.62`；**星座连线白底反而要压到 `0.20`**
（点多是「星」，线多了就是「网」—— 给 0.34 时整页变成绿色蛛网）。
星点 sprite 的**核原本是纯白**，白底上等于隐身，改成了绿色实心核。

> ⚠️ **`实机截图/23_lobe_pivot_themed.png` 现在是旧图。** 它拍于换色之前，
> 里面是**蓝色主题 + 看不见人脸**的版本。替换件已备好（同尺寸 1600×1000，可直接替换）：
> `_scratch/face-dark-auth.png`（新：黑底 + 绿色星场 + 人脸可见）。
> 因为 deck 已生成、且改动会牵动「实机截图 23 张」这类计数，**没有擅自替换**，等确认。

### 有意不使用仓库自带的 `deliverables/`

仓库根目录 `deliverables/` 与 `demo-assets/` 里已有一套现成的图和动效，但作者自己写的
`deliverables/截图真实性清单.md` 承认：

- 10 张 PNG 里只有 5 张是实机截图，其中 3 张还是登录页
- 4 张是 PIL 数据驱动**合成渲染**，1 张是实拍+后期合成
- 5 个 GIF **全是后期动效**，不是产品录屏
- **没有**登录后的 n8n 原生画布，**没有**登录后的对话实拍

所以本次全部重新实拍。如果面试官追问"这图是真的吗"，`实机截图/` 里每一张都能现场复现。

### 采集过程中的三处处理（如实说明）

1. **Clerk 开发模式提示框被隐藏**。控制台右上角/中央会弹一个 Clerk 的
   "Organizations feature required" 开发模式提示，它不是产品功能。采集时通过
   点击它的"I'll remove it myself"按钮 + 注入一条 CSS 规则隐藏。**除此之外没有对页面做任何修改**。
2. **n8n 的引导问卷被跳过**。n8n 首次登录会弹"Customize n8n to you"和升级提示，点 Skip 关闭。
3. **PivotAI 主题被主动注入**（见上节）。这是本仓库自带的定制能力，不是第三方插件；
   演示时应当说明"主题是后注入的"，而不是暗示"镜像自带"。

## 演示里引用的关键数字（都已核实）

| 数字 | 来源 |
|---|---|
| 10 个容器全部运行 | `docker compose ps` |
| 自检 **26 次**留痕，首跑 28/47 → 最新 **45/47（0 失败 / 2 告警）** | `selfcheck_runs` 表（#1 与最新一次，10-08 00:28） |
| 定时自检 40/47（5–6 失败） | 同表，最近两次 schedule 运行 |
| 24 条工作流全部 active | `workflow_entity` 表 |
| n8n 累计 3,879 次执行 / 失败 119 / 失败率 3.1% / 平均 3.62s | n8n 概览页实拍（10-04 快照，之后仍在增长） |
| 控制台 24h：32 次对话 / 成功率 / 平均 7,101ms / 成本 $0.0302 | 总览页实拍 |
| 知识库 4 文档 / 5 分块 / 嵌入 369 / 100 万 | 总览页实拍 |
| 网关向模型暴露 15 个工具 | `stream-bridge /healthz` 实测 |
| MCP 暴露 17 个工具 | MCP `tools/list` 实测 |
| 工具差集：共有 12 · 网关独有 3 · MCP 独有 5 | 上面两次实测对比 |
| 检索 hit@5 = 1.0（12/12）、MRR = 0.903 | `n8n/scripts/kb-eval.mjs` |
| Platform Admin API 68 节点 / Reminders 34 / Todos 23 / Chat Gateway 22 | `workflow_entity` 表实测 |
| 主题注入：13 个 CSS + 5 个 JS | `pivot-apply.js` 实测输出 |
| run_python 真实调用 3 次（全部放行） | `admin_audit` 表 |
| mcp.call 15 次 / people.create 1 次 | `admin_audit` 表 |
| 告警阈值：窗口 60 分钟 / 错误率 50% / 样本 ≥5 / 冷却 60 分钟 | Settings 页实拍 |
| 嵌入额度 1,000,000 tokens；消息保留 30 天；执行记录 90 天 | Settings 页实拍 |
| 语音回灌相似度 0.830；`/voice/reply` 返回 `{"ok":true,"mode":"voice"}` | 现场实测（第 10 页） |
| 图片视觉 `usage.prompt_tokens: 3557`，答出背景红管 | 现场实测（第 10 页） |
| 备份 **5 轮 / 25 个产物**，`gzip -t` 独立复验 **25/25 通过、0 损坏** | `backups/` 目录（10-03 ~ 10-07 五轮） |
| 心跳最新一条 `ok=1` / `n=5` / `integrity=4/4` | `heartbeats` 表 |
| `cron_runs` **63 条**定时运行留痕 | `cron_runs` 表 |
| 嵌入已用 369 tokens | `kb_usage` 表 |
| 工作流源码 24 个 JSON 入仓 | `n8n/workflows/` |
| CI 2 个 job（`frontend-typecheck` + `workflows-validate`） | `.github/workflows/ci.yml` |
| 对象桶 `lobechat-files` 1 个对象（通路验证写入，非产品上传） | RustFS 容器 `/data/lobechat-files` |
| Telegram 轮询锁持续写入（核对时距上次 62 秒） | `telegram_state.lock_ts` |
| 文档工厂产出 1 篇会议纪要（含 2 条行动项）+ 1 份周报 | `documents` / `weekly_reviews` 表 |
| 告警真实触发：`total=29` / `errors=26` → **89.7%** → `severity=critical` → `delivered=ok` | `ops_alerts` 表 + 告警页实拍 |
| 9 项「就绪但没跑过」的能力全部补齐（0 → 1，记忆为 0 → 2） | 各自的表（见上节） |
| 记忆闭环：`agent_memories` 2 条 + LobeHub `user_memories` 镜像 2 条，检索命中 **score 0.71** | `/webhook/internal/memory` 实测 |
| S3 通路：PUT/HEAD/GET/LIST 全 **200**，GET 字节与写入**完全一致** | `_scratch/s3_probe.py` 实测（平台自身凭据） |
| 对象已落盘（RustFS 内部存为 `evidence/s3-path-check.txt/xl.meta`） | `docker exec minio find /data/lobechat-files` |
| **产品级上传**：`files` 0 → **1 行**，对象落盘，取回 SHA-256 与本地**完全一致** | `lobechat` 库 + RustFS 实测 |
| `file_uploads.status`：修复前 `released`（中止）→ 修复后 `settled` | `lobechat` 库实测 |

## 重新生成

截图更新后重跑生成脚本即可（会把 `实机截图/` 的图 + `测试素材/` 的音视频 base64 内嵌进单文件）：

```bash
C:/Users/13682/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe interview-demo/build-deck.py
```

改完内容后建议跑一次体检：deck 每页是固定高度 + `overflow:auto`，内容超高不会报错，
只会"悄悄变成可滚动"，投影时被截断。`check-deck.sh` 用真实浏览器逐页测量**内容高度与余量**：

```bash
bash interview-demo/check-deck.sh
```

当前 **27 页全部通过，0 页溢出**（783px 是 1080p 全屏下每页可用高度）。余量分布：
最紧的是**第 15 页告警链路（98px）**、**第 16 页产品级上传（27px）**、第 4 页架构图（126px）
与第 18 页控制台总览（130px）。
余量偏大的是封面/收尾（0，因为它们本来就是满版）与几张纯文字页（486px）—— 纯文字页余量大有意义，
说明那页讲稿轻、适合快速翻过。

> 注意：`agent-browser` 是全局单例，**不要和别的采集脚本同时跑**，否则两个脚本会互相抢页面
> （我就这样踩过一次：一边跑 n8n 采集一边量 deck，结果量到 slides=0）。

### 追加采集一张截图的正确姿势

`capture-one.sh` 是唯一可靠的单元 —— **一次调用只拍一页**：

```bash
bash interview-demo/capture-one.sh /dashboard/alerts 50_alerts_fired.png
```

它做的事：签一张 Clerk 免密票据 → 登录 → 打开那一页 → **用正面证据确认还登录着**
（页面里存在 `Toggle Sidebar`）→ 关掉 Clerk 开发模式提示 → 注入 CSS 隐藏它的遮罩 → 截图 → 关浏览器。

踩过的坑都写进脚本注释了，重点是两条：

1. **一张票据只能用一次**，所以每次采集都要重新签，不能复用。
2. **别用「没有登录页文字」来判断登录状态** —— SPA 外壳会短暂包含它，会得到假阳性；
   要用正面证据（侧边栏元素存在）。

另外：`agent-browser` 的 `screenshot` 参数顺序是 `[selector] [path]`；
Windows 下路径必须写 `C:/...`，写 `/c/...` 会静默失败。`_scratch/` 里是这轮的调试脚本，可删。

### 验证对象存储（`_scratch/s3_probe.py`）

```bash
C:/Users/13682/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe interview-demo/_scratch/s3_probe.py
```

用**平台自己在用的那对凭据**（从 `.env` 读 `MINIO_ROOT_USER/PASSWORD`）对 `lobechat-files`
做一轮 PUT → HEAD → GET → LIST，并**逐字节比对** GET 回来的内容和写入的是否一致。
预期输出：

```
PUT  evidence/s3-path-check.txt -> HTTP 200
HEAD evidence/s3-path-check.txt -> HTTP 200
GET  evidence/s3-path-check.txt -> HTTP 200 | bytes=161 | identical=True
LIST -> HTTP 200 | objects=1
RESULT: PASS
```

**为什么用 stdlib 手写 SigV4 而不是 boto3**：本环境 `pip install boto3` 被策略拦下
（报 `SIGTERM`）。签名逻辑不到 60 行，用 `hmac`/`hashlib`/`urllib` 就够，反而更少依赖。
两个容易错的点：URL 里的 **查询参数必须按键名排序**再拼进 canonical request；
`host` 头只写 `host:port`，不带 `http://`。

从容器侧交叉确认（RustFS 内部把对象存成 `xl.meta`，所以文件名叫这个）：

```bash
docker exec minio find /data/lobechat-files -type f
# -> /data/lobechat-files/evidence/s3-path-check.txt/xl.meta
```

## 演示时要主动说的"没做好"

**第 25 页（已知问题）**专门列了 7 条。核心几条：

1. **定时自检偶发 6 项失败**（手动跑 45/47）。查过 `selfcheck_runs` 表：最近两次定时运行里
   4 项是 `Request failed with status code 502`，属上游 DeepSeek 侧瞬时故障（此刻已恢复，实测 200）；
   另有 `memory api` payload 异常。**下一步是加上游退避重试，并把"上游瞬时失败"与"平台真故障"分开计。**
2. **自检卡片不取最新一次**。总览页显示的是 10-04 12:30 那次（41/47、3 项失败），而最新一次是
   **10-08 00:28 的 45/47**。演示台**第 18 页**已就地标注，避免截图与结论自相矛盾。
3. **告警渠道口径不一致**（这轮新发现）。Settings 页报 `webhook_configured=false`，
   但告警页显示**已配置（format: telegram）**，且实测告警**真的送达了**（`delivered=ok`）。
   同一件事两个页面给出相反答案 —— 是 Settings 的判断口径漏了 Telegram 分支。
4. **沙箱审批只有 TG 一个出口**（这轮新发现）。`sandbox_approvals` 里那条待审记录停在 `pending`：
   审批按钮只发到 Telegram，**控制台没有审批入口**，不用 TG 的人无法放行。
   所以「人工审批」这个能力对非 TG 用户等于不可用。
5. **SearXNG 7 个引擎被挂起**（SSL 校验失败 / 超时），是唯一常驻告警。不建议直接删掉，会降低检索覆盖。
6. **`Notifications` 页是写死的假数据**却挂在侧边栏（见上文），所以没有放进演示台。
7. **【已修复】产品级上传入口** —— 上一版这里是「通路通、产品没走通」。10-08 真从对话前台上传了
   一份 100 KB 文档，并修掉过程中暴露的**两个真实缺陷**：① `S3_ENDPOINT` 固化了容器创建时的
   LAN IP，换网就断（`ECONNREFUSED`）；② **RustFS 桶没配 CORS**，预检返回 200 却无任何
   `Access-Control-*` 头，浏览器因此不发 PUT。
   **两个坑都已经从「手工修」变成「可重复」**：
   - CORS 那条写成了幂等脚本 **`scripts/provision-bucket.sh`**（建桶 + 配 CORS + 复验浏览器预检，
     来源域由 `.env` 推导，不再硬编码 IP）。
   - 地址那条 **不是**「把 `S3_ENDPOINT` 换成 `minio:9000`」—— 那个第一版结论是错的，读 LobeChat
     源码后已纠正：正确开关是 `S3_INTERNAL_ENDPOINT`，已写进 `docker-compose.yml`。
   详见上文「产品级文件上传」一节。

另外两件**不属于产品缺陷但值得讲**的：

- **CI 只做静态校验**。集成冒烟测试需要 owner 手工创建的 API Key、无法 headless 引导，
  所以写在 CI 注释里改为部署后执行。这是取舍。
- **第 11 页讲了一个采集侧的坑**（n8n 画布徽标滞后）—— 那属于"工具会骗你"，不是产品缺陷，
  但讲出来能体现排查习惯。

### 这一轮的自我修正（可当作「怎么做技术审计」的例子）

上一版演示台做完后，我拿它对着**活的数据库**逐项核对了一遍，结果是：

- 找到 **7 项「能力就绪但从没跑过」**的功能（当时只有 `ops_alerts` 那项在页面上标了，其余 6 项漏标）；
- 找到 **6 处过期数字**（备份 3 轮→5 轮、自检 19 次→26 次、`cron_runs` 42→63、
  `weekly_reviews` 0→1、`chat_executions` 202→255、`ops_alerts` 0→1）；
- 找到 **1 处页面自相矛盾**（告警渠道两个页面口径不一致）。

然后**把 7 项能力全部真跑了一遍**再回来改页面。这一步的价值不在"页面变准了"，
而在于它证明了一件事：**演示材料必须能对着数据核对，否则它只是一个更好看的说法。**
如果面试官问"你怎么知道你的演示是可信的"，这条比任何单页截图都有力。
