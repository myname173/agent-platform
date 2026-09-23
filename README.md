# Agent Platform

统一 AI Agent 中台平台，以 **n8n** 为核心工作流引擎，串联 **LobeChat**（用户对话前台）与 **Kiranism**（运营管理后台）。

---

## English

**A self-hosted AI agent platform that runs on one machine.** Eight Docker
Compose services, **24 n8n workflows** as the orchestration core, and four ways
in — a chat front end (LobeHub), an ops console (Next.js), a Telegram bridge,
and an MCP server for external agent clients.

The organising idea: **the entry points never call each other.** Chat, console
and Telegram all talk to n8n and stop there. Business logic lives in one place,
so a change shows up everywhere at once instead of being reimplemented per
surface.

```
 LobeHub :3210 ──┐
 Console :3000 ──┼──▶ n8n :5678 ──▶ DeepSeek / SearXNG / tools / MCP
 Telegram  poll ─┘        │
                          ├── Postgres 17 + pgvector (ParadeDB)
                          ├── MinIO (S3, file uploads)
                          └── stream-bridge :3211 (streaming sidecar)
```

**What it actually does**

- **Tool-using chat loop.** 12 server-side tools (web search, KB search, todos,
  reminders, KB writes, daily brief, alerts…) that the model calls on its own,
  capped at 2 rounds. Tool errors come back as structured messages so the model
  can recover instead of the whole turn failing.
- **RAG over your own documents.** pgvector + HNSW, 1024-d DashScope
  embeddings. Upload PDF/DOCX/TXT/MD from the browser — parsing happens
  client-side, so files never touch the server. Chunking is guarded: an
  oversized chunk fails the daily check instead of silently ruining retrieval.
- **Memory that survives sessions.** Facts are extracted conservatively after
  each conversation and mirrored into LobeHub's memory store.
- **Delegation.** Assign a todo to a person; delivery routes to their channel,
  falls back to you if they have none, nags at 24h intervals, escalates, and
  stops the moment they acknowledge.
- **Pushes you can act on.** Reminders and nudges arrive with inline buttons —
  tap *done* or *snooze* and it writes straight back to the same row.
- **Runs itself.** Daily brief at 08:30, topic watch at 21:00, weekly review,
  a 42-check self-test at 04:15, and five-artifact nightly backups with a
  restore drill into a throwaway database.

**Numbers** (verified 2026-09-21): 8 containers · 24 workflows · 39 webhook
paths · 12 agent tools · 19 data tables · 25 console API routes · smoke test
71/71 · self-check 42/42 · MCP regression 27/27.

**Quick start on a fresh machine**

```bash
git clone https://github.com/myname173/agent-platform && cd agent-platform
cp .env.example .env                                  # fill in the real values
cp frontent/env.example.txt frontent/.env.local       # console secrets (gitignored)
docker compose up -d                                  # 8 containers

# once n8n answers (30–60s): create an n8n API key (Settings → n8n API),
# put it in .env as N8N_API_KEY, then load the workflows
N8N_URL=http://localhost:5678 N8N_API_KEY=<key> node n8n/scripts/deploy.mjs
```

Then three one-time steps: create a **DeepSeek credential** in n8n and re-run
`deploy.mjs` (it re-points the credential id and prints what it did), create the
MinIO bucket, and run `node n8n/scripts/lobehub-config.mjs`. Full Chinese
walkthrough: [部署到一台新机器](#部署到一台新机器).

**Verification** — four gates, all runnable locally:

| Command | Covers |
| --- | --- |
| `node n8n/scripts/validate-workflows.mjs` | structure, unique webhook paths, env/compose consistency, secret scan |
| `node n8n/scripts/smoke-test.mjs` | 71 end-to-end checks |
| `POST /webhook/admin/selfcheck/run` | 43 checks, also daily at 04:15 |
| `node n8n/scripts/mcp-test.mjs` | MCP protocol + all 17 tools |
| `node --env-file=.env n8n/scripts/test-client-tools.mjs` | client-tool path (LobeHub): no server tool may pass through unexecuted |
| `node --env-file=.env n8n/scripts/test-idempotency.mjs` | a retried request must not repeat a side effect; `tool_trace` must land |

**About secrets.** No key lives in this repo. Workflows read `$env.*` at
runtime; `.env` has never been committed. `deploy.mjs` pushes workflow JSON to
*your* n8n and needs *your* `N8N_API_KEY` — a clone without those cannot reach
anything.

---

## 架构概览

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   LobeChat      │────▶│      n8n Engine       │◀────│   Kiranism      │
│  用户对话前台    │     │  工作流 & Agent 运行时  │     │  运营管理后台    │
│  :3210          │     │  :5678                │     │  :3000          │
└─────────────────┘     └──────────┬───────────┘     └─────────────────┘
                                   │
                        ┌──────────┼───────────┐
                        ▼          ▼           ▼
                    DeepSeek    SearXNG     外部工具
                    大模型      搜索:8080    & API
```

**核心原则**：两端前台不直接互调，所有业务逻辑与 Agent 编排统一收敛到 n8n。

**数据存储**：Postgres 17（`paradedb/paradedb` 镜像，同时提供 pgvector 与 pg_search；卷 `postgres_data_pg17`）。
2026-09-14 两段迁移：SQLite → Postgres 16（n8n 主存储），随后 Postgres 16 → 17（LobeHub 2.x 需要 pg_search）。
旧卷 `postgres_data`（PG16）保留为回滚件；迁移导出与升级前 dump 归档在 `backups/`。

## 端口分配

| 服务 | 端口 | 用途 |
| --- | --- | --- |
| n8n | 5678 | 核心工作流引擎（Webhook + REST API） |
| LobeChat | 3210 | 终端用户 AI 对话界面 |
| Kiranism (console) | 3000 | 运营管理后台（compose 服务 `platform-console`，亦可 dev 模式） |
| SearXNG | 8080 | 搜索引擎（供 n8n 工具链调用） |
| Postgres 17 | 5432（仅内网） | n8n + LobeHub 数据库（pgvector / pg_search，不在宿主机暴露端口） |
| MinIO | 9000 / 9001 | 对象存储（S3 兼容；9000=API、9001=控制台），LobeHub 文件上传（Phase 4a） |

## 快速启动

### 1. 启动基础设施服务（n8n + SearXNG + LobeChat）

```bash
cd agent-platform
docker compose up -d
```

### 2. 启动管理后台（开发模式）

```bash
# 方式 A（推荐）：容器化运行（前端源码见 frontent/）
docker compose up -d console   # 需在根 .env 配置 CONSOLE_CLERK_PUBLISHABLE_KEY

# 方式 B：dev 模式（首次需要 pnpm install）
cd frontent && pnpm dev        # → http://localhost:3000
```

### 3. 访问各服务

- **n8n 工作流编辑器**：http://localhost:5678
- **LobeChat 对话界面**：http://localhost:3210
- **Kiranism 管理后台**：http://localhost:3000
- **MinIO 控制台**：http://localhost:9001（对象存储；API 在 9000）

## 部署到一台新机器

目标：`git clone` → 填 `.env` → `docker compose up -d` → 一条命令灌入工作流，就能跑。

```bash
git clone <this-repo> agent-platform && cd agent-platform
cp .env.example .env          # 填真实值：CHAT_API_KEY / N8N_API_KEY / POSTGRES_PASSWORD /
                              # DASHSCOPE_API_KEY / UPSTREAM_API_KEY / MCP_API_KEY / MINIO_ROOT_*
cp frontent/env.example.txt frontent/.env.local   # 控制台的 Clerk / n8n 变量（仓库里没有，必须自己建）
docker compose up -d          # 8 个容器
```

> `frontent/.env.local` 是 gitignore 的，全新 clone 没有它。compose 已把它标成
> `required: false`，缺了不会让整个栈起不来，但**控制台会因为没有 Clerk key 而不可用**。

等 n8n 就绪（首次 30–60 秒），把工作流灌进去：

```bash
# 先在 n8n（Settings → n8n API）建一个 API key，写进 .env 的 N8N_API_KEY
N8N_URL=http://localhost:5678 N8N_API_KEY=<key> node n8n/scripts/deploy.mjs
```

`deploy.mjs` 会：创建/更新 24 条工作流 → 建好所有数据表与缺失列 → **把工作流里写死的凭据 ID 重映射到本机同名凭据** → 快照网关工具表。

剩下的手工步骤只有三条：

1. **DeepSeek 凭据**：n8n（Settings → Credentials）新建 `DeepSeek account`，再跑一次 `deploy.mjs`。
   它会打印 `credential deepSeekApi: <旧id> -> <新id>` 并把新 id 写回 JSON；**没有这条凭据时部署不会失败**，只打一行提示。
2. **MinIO 桶**：`docker exec minio mc mb local/lobechat-files`（或在 :9001 控制台建）。
3. **LobeHub 接线**：`N8N_URL=… CHAT_API_KEY=… node n8n/scripts/lobehub-config.mjs`（`status` 看漂移，`apply` 修）。

最后跑一遍 `node n8n/scripts/smoke-test.mjs`（71 项）。

> - 换机器后记得改 `PLATFORM_LAN_IP`：它决定手机能否访问、预签名上传的主机名、以及推到 Telegram 的链接。不填就退回 `127.0.0.1`（仅本机）。
> - **密钥不会随仓库走**：工作流 JSON 里没有任何 key 的值，只在运行时读 `$env.*`；`deploy.mjs` 推的是你自己 n8n 的地址。别人拉下来没有你的 `.env` 和 `N8N_API_KEY`，跑不动。

## 环境变量

### frontent/.env.local

```bash
NEXT_PUBLIC_N8N_URL=http://localhost:5678   # n8n 地址
N8N_URL=http://n8n:5678                     # 容器内运行时地址（compose console 服务注入）
N8N_API_KEY=<your-n8n-api-key>              # n8n Public API Key

# Clerk 身份认证
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

### 根 .env 补充项（控制台容器化）

```bash
CONSOLE_CLERK_PUBLISHABLE_KEY=pk_test_...   # 用于 console 镜像构建（与 frontent/.env.local 保持一致）
```

### 告警与预算阈值（根 .env，改完需 `docker compose up -d n8n`）

```bash
ALERT_WINDOW_MIN=60            # 错误率统计窗口（分钟）
ALERT_RATE_THRESHOLD=0.5       # 错误率阈值
ALERT_MIN_TOTAL=5              # 窗口内最少请求数，低于此不判错误率
ALERT_COOLDOWN_MIN=60          # 告警冷却（分钟）
ALERT_COST_24H_USD=2           # 24h 模型花费预算，超过即告警（warn）
ALERT_COST_CRITICAL_USD=5      # 超过则升级为 critical
ALERT_SEVERITY_CRITICAL=0.8    # 错误率达到多少算 critical
```

### LobeChat（通过 docker-compose 环境变量配置）

LobeChat 的自定义模型服务商已在 `docker-compose.yml` 中预配置，指向 n8n 的 OpenAI 兼容 Webhook。S3 文件存储已接线（`S3_ENDPOINT` → MinIO），详见「文件存储（MinIO）」一节。多模态与网关模式：`deepseek-v4-flash` 已声明 vision；客户端按网关设计配套（Responses API 关、联网搜索关、流式输出关、记忆暂关），图片由网关内联后转上游。

## 数据流说明

### 对话链路（LobeChat → n8n Chat Gateway → 大模型）
1. 用户在 LobeChat 发送消息
2. LobeChat 以 OpenAI 协议 POST 到 `http://n8n:5678/webhook/v1/chat/completions`
   （鉴权：`Authorization: Bearer <CHAT_API_KEY>`，取自根目录 `.env`，与 compose 中 LobeChat 的 `OPENAI_API_KEY` 一致）
3. **Chat Gateway** 工作流（源码在 `n8n/workflows/chat-gateway.json`）：
   - 校验 Bearer key，失败返回 401 + OpenAI 错误格式。两级鉴权：
     主 key（n8n env `CHAT_API_KEY`，与 LobeChat 共用，不限流）+ 托管 key
     （SHA-256 哈希存于 Data Table `gateway_keys`，按 key 限流与记账，
     用 `n8n/scripts/keys.mjs` 管理），命中限流返回 429 + OpenAI 错误格式
   - 解析 `messages`，映射模型别名（`deepseek-agent` → `deepseek-chat`），未知模型返回 404
   - session 身份：`X-Session-Id` 头 > OpenAI `user` 字段 > anonymous
   - 请求只带单条消息时，自动从 Data Table `chat_messages` 合并该会话最近 20 轮历史（服务端记忆）；
     LobeChat 等全量历史的客户端走透传路径
   - 调用 DeepSeek（60s 超时 + 1 次重试），包装为 OpenAI 标准响应（含真实 token usage）
   - **模型路由**：`deepseek-agent`（默认，携工具：web_search + kb_search）、`deepseek-chat`（纯对话）、
     `deepseek-reasoner`（推理，较慢）、`deepseek-v4-flash`（V4 代，快且支持工具）；别名映射在网关
     Parse & Validate 节点（含计价表），新增模型 = 加一条别名 + LobeHub 侧 CUSTOM_MODELS / OPENAI_MODEL_LIST 同步
   - **多模态（4b）**：`deepseek-v4-flash` 已声明 vision（显示名「DeepSeek V4 Flash（网关）」）→ 网关保留其 `image_url` 内容段，并将本地来源图片（`localhost:3210/f/…` 等）改写容器内地址 + 内联 base64 后转上游；其余模型仍拍平为文本
   - **Agent 工具循环**（优先级 5）：请求携带 web_search（SearXNG 公网）与 kb_search（私域知识库）
     两个工具，模型自主决定是否/用哪个搜索；最多 2 轮工具调用，第 2 轮后强制收口；
     usage 跨轮累计计入成本；工具故障时降级为错误说明回答；响应新增 `tool_rounds` 字段
     搜索；最多 2 轮工具调用，第 2 轮后强制收口；usage 跨轮累计计入成本；SearXNG 故障时
     降级为无搜索回答；响应新增 `tool_rounds` 字段（0 = 直接回答）
   - 任何失败统一返回 `{error:{message,type,code}}` + 400/401/404/502
4. 每次执行写入 Data Table `chat_executions`（session/model/client/status/latency/tokens），
   对话轮次写入 `chat_messages`

### 管理链路（Kiranism → n8n API）
0. 平台总览聚合接口：`GET /webhook/admin/overview`（Bearer CHAT_API_KEY；返回 24h 对话量/错误率/延迟/成本、告警摘要、知识库与嵌入额度）—— 对应控制台 “Overview” 页
1. Kiranism 后台通过服务端 API 路由代理访问 n8n
2. `N8N_API_KEY` 仅存在于 Next.js 服务端，不暴露给浏览器
3. 可查看工作流状态、执行记录、健康检查等

### 统计接口（新增，供 Kiranism 后续接入）
```
GET http://localhost:5678/webhook/v1/stats/executions
Authorization: Bearer <CHAT_API_KEY>
```
返回总量/成功率/平均延迟/按模型与客户端分布/独立会话数/成本聚合
（total/24h/7d/按模型/按 key，USD）与最近 20 条执行（含 key_name、cost_usd）。
Kiranism 需要时在 `frontent/src/app/api/n8n/` 下加一条服务端路由代理即可（已有三条路由不受影响）。

### 成本可见性与预算告警（2026-09-22）

成本**一直在算**（Chat Stats 从 priority 3 起就有 `cost` 聚合），但**一直到不了用户眼前**：
TS 类型 `ChatStats` 里压根没声明 `cost` 字段，控制台没有任何地方能读到它，也没有任何阈值。
这是「数据有了、通道没有」——**不算缺失功能，等于缺失功能**。

现在的两条通路：

| 通路 | 位置 | 说明 |
| --- | --- | --- |
| 看得见 | 控制台 Overview →「模型成本」卡 | 24h / 7d / 累计；预算进度条；按模型、按调用方 key 拆分 |
| 会报警 | `chat-alerts` 新增 `cost_budget` 规则 | 24h 花费 ≥ `ALERT_COST_24H_USD` → warn；≥ `ALERT_COST_CRITICAL_USD` → critical |

```bash
# .env（改完要 docker compose up -d n8n，让容器重新读取）
ALERT_COST_24H_USD=2        # 24h 预算，超过即告警
ALERT_COST_CRITICAL_USD=5   # 翻倍到这里升级为 critical
```

**两个设计决定，都是为了不让它变成"接好了但其实不响"**：

1. **告警复用 Chat Stats 的成本数，不自己重算。** `chat-alerts` 本来就取了 250 行执行记录，
   而 Stats 取的是 1000 行 —— 各算一遍会出现「卡片显示 $1.9、告警却在 $2 触发」的错位，
   而那正是最难查的一类问题：**两边都没坏，只是不一致**。
2. **去重按 kind 24h 一次，但 warn → critical 的升级不受去重限制。**
   否则预算从 $2 花到 $6，第一条 warn 发过之后就再也不响了 —— **涨得最凶的时候反而最安静**。

阈值通过 `/admin/settings` 的 `cost` 字段下发到控制台，卡片显示的是**实际生效的配置**，不是前端猜的数。

## 运维

### 密钥与配置（.env）

所有密钥/实例配置在根目录 `.env`（已 gitignore），`docker-compose.yml` 通过变量引用。
首次搭建：`cp .env.example .env` 后填入真实值。**勿把 `.env` 提交到任何远端。**

### 备份与恢复（n8n/scripts/backup.sh）

```bash
bash n8n/scripts/backup.sh            # 备份 n8n 卷/库 + lobechat 库 + MinIO 数据卷 + compose/.env
bash n8n/scripts/backup.sh 30         # 保留最近 30 份
bash n8n/scripts/backup.sh restore backups/n8n-data-XXXX.tar.gz   # 恢复 n8n 卷（会停 n8n 并清空卷）
```
每次备份生成五件：`n8n-data-*.tar.gz`（卷：n8n 配置与旧 SQLite 回滚件）、
`pg-n8n-*.sql.gz`（n8n 库逻辑导出）、`pg-lobechat-*.sql.gz`（LobeHub 库：对话/用户数据）、
`minio-data-*.tar.gz`（对象存储：文件/图片）、`config-*.tar.gz`（compose + .env）。

#### ⚠️ Windows 计划任务的坑（备份为什么曾经停摆 65 小时）

任务 `Agent Platform Backup` 存在且启用，但只有**一个**触发器（每日 03:30），并且：

| 设置 | 值 | 后果 |
| --- | --- | --- |
| `StartWhenAvailable` | **false** | **那个点机器关机/睡眠 → 直接跳过，开机后不补跑** |
| `DisallowStartIfOnBatteries` | true | 用电池时也不跑 |

对一台晚上会关机的机器来说，这等于**备份永远不会跑**。修一次即可：

```powershell
$t = Get-ScheduledTask -TaskName "Agent Platform Backup"
$s = $t.Settings
$s.StartWhenAvailable = $true
$s.DisallowStartIfOnBatteries = $false
Set-ScheduledTask -TaskName "Agent Platform Backup" -Settings $s
```

改完确认：任务属性的「设置」里 **"如果错过了计划开始时间，请尽快运行"** 应为勾选状态。

> 一键修：运行 `n8n/scripts/fix-backup-task.ps1`（右键 → 使用 PowerShell 运行）。
> 它会改这两个设置、把执行超时从 72 小时收到 2 小时，并打印改后的值供核对。
> 若提示权限不足，用管理员身份的终端再跑一次。

**心跳必须带证据**：`backup-task.sh` 上报 `{"stamp","n","bytes","integrity"}`，
自检 `backup heartbeat fresh` 要求 5/5 件、`bytes>0`、`integrity=4/4`——
空心跳（手工 curl 的那种）会被判失败。别再用补心跳的方式"救火"，那正是它骗了 63 小时的原因。

**还有一个更阴的：心跳曾经"发了但没落地"，备份却说成功。** `send_heartbeat` 用字符串拼接造 body，
而 `detail` 本身是一段 JSON，内层引号没转义 → 整个 body 是**非法 JSON** → 端点回 **422**；
而 `curl` 那段只判断退出码、没加 `-f`，于是 4xx 也被记成 `heartbeat sent (ok=true)`。
结果：备份成功、日志报成功、自检却报 `backup heartbeat fresh` 失败——三方互相矛盾，谁都像是坏了。
**已修**：detail 先转义再拼，并且用 `-w '%{http_code}'` 读真实状态码，非 200 要打印响应体。
（教训同"工具清单漂移"：一个环节静默失败，其它环节全绿，最后表现成一个无法定位的矛盾。）

**03:30 这个点本身也要打个问号**：它是 Windows 计划任务，机器开着不代表 Docker 开着。
实测 09-22、09-23 连续两天 03:30 触发时 Docker Desktop 没运行，日志里是
`failed to connect to the docker API` → 备份失败。`StartWhenAvailable` 只能保证"开机后补跑"，
补跑时 Docker 仍未就绪照样失败。**建议把触发器改到你通常已经开了 Docker 的时段**（或再加几个时间点）。
`schtasks` 在本环境被安全策略拦截，改触发器需要你自己跑（管理员终端）：

```powershell
schtasks /change /tn "Agent Platform Backup" /st 10:30
```

恢复参考：`gunzip -c backups/pg-n8n-*.sql.gz | docker exec -i postgres psql -U n8n -d n8n`；
`gunzip -c backups/pg-lobechat-*.sql.gz | docker exec -i postgres psql -U n8n -d lobechat`；
MinIO：停 minio 后把归档解回 `minio_data` 卷。每日 03:30 计划任务自动执行（含四项完整性检查）。
归档含凭据与对话数据，妥善保管。

#### 恢复演练（n8n/scripts/restore-drill.sh）

**没被恢复过的备份只是信念，不是保障。** 该脚本取最新备份集恢复到**临时库**、校验后删除，
全程不碰生产：

```bash
bash n8n/scripts/restore-drill.sh
```

校验 n8n（表数、数据表注册表、documents / people / todos / reminders 等）、
lobechat（表数与 `users` / `agents` / `user_settings` / `ai_providers` 的行——这些正是坏恢复
真正会丢的东西）、MinIO 归档条目数；并报备份新鲜度（超 `MAX_AGE_HOURS` 默认 48 小时即失败）。

「线上有、恢复结果里没有」的表会单列成 **GAP** 而不算演练失败——通常是该表在最后一次备份
之后才创建，对策是再跑一次 `backup.sh`。备份由 Windows 计划任务每日 03:30 触发（只有一个触发器），**新建的表最长要等
12 小时才进入保护**，所以建表后补一次备份是好习惯。

演练在宿主机侧（要访问 `backups/` 与 docker），n8n 容器内看不到，因此**不在每日自检里**，
属于周期性例行。

### 自动校验（四道）

> **最后一次实跑：2026-09-21 18:05**（栈在线，自检三项加固之后）
> smoke **71/71** · 工具契约 **15/15** · 客户端工具路径 **3/3** · 幂等+追踪 **PASS** ·
> 自检 **47 项中 45 通过 / 0 失败 / 2 警告**。
> 两条警告都是真问题：① `searxng engines` 部分引擎仍不稳定（有结果）；
> ② **`selfcheck ran recently` —— 04:15 定时任务已 85.8 小时没跑**（见坑位 9）。
> 这个时间戳是给人看的：三天前全绿不等于现在全绿。
> 而**在此之前**「全绿也不等于能用」：SearXNG 引擎全被封、搜索一律返回空，
> 上面每一道门照样是绿的——见坑位 8。

| 命令 | 覆盖面 | 何时跑 |
| --- | --- | --- |
| `node n8n/scripts/smoke-test.mjs` | 71 项端到端（含控制台守卫 7 项） | 每批交付后 |
| 控制台「自检」/ `POST /webhook/admin/selfcheck/run` | 47 项（只读 + 少量幂等写），每日 04:15 | 每天 |
| `node n8n/scripts/mcp-test.mjs` | MCP 全部 17 个工具（`MCP_TEST_SLOW=1` 额外跑 `run_brief` / `web_search`） | 改 MCP 后 |
| `node n8n/scripts/check-tool-contract.mjs` | 网关清单 ↔ 侧车 `SERVER_TOOLS` ↔ `Execute Tool` 实现，且禁止再出现硬编码副本 | 部署前 |
| `node --env-file=.env n8n/scripts/test-client-tools.mjs` | 带 `client_tools` 的入口（LobeHub）：服务端工具不得被原样透传 | 改工具分类逻辑后 |
| `node --env-file=.env n8n/scripts/test-idempotency.mjs` | 重发不重复副作用 · 换 key 仍执行 · `tool_trace` 落库 | 改工具循环后 |
| `node --env-file=.env n8n/scripts/cap-rate.mjs 7` | 工具轮次分布 / 跑满率 / 撞顶次数 —— 决定循环该多深 | 想调整 `MAX_TOOL_ROUNDS` 前 |

MCP 测试需要 `MCP_API_KEY`（见 `.env`），可选 `CHAT_API_KEY` / `N8N_API_KEY` 用于清理测试数据。

> 为什么 MCP 要单独一套：它是平台**唯一对外的接口**。它坏了，平台内部所有自检都是绿的，
> 而外部客户端完全用不了 —— 这类故障不会被任何其他检查发现。

### 已知坑位（踩过的，别再踩）

1. **n8n Code 节点里 SQL 占位符必须一列一用。** 复用同一个 `$N` 喂类型不同的列（如 `title`
   varchar 与 `summary` text）→ PG 报 `inconsistent types deduced for parameter $N` →
   pg-protocol 1.15.0 在构造 `DatabaseError` 时给**只读属性 `name` 赋值抛 TypeError**，异常在
   socket 回调里、`try/catch` 够不着 → **runner 进程直接死**，n8n 只显示 "Node execution failed"。
   排查手法：让代码把进度写进一张临时表，即使 runner 崩了也能从库里读出死在哪一步。
2. **HTTP 请求头里绝不能放原始非 ASCII 字节。** `x-person: 张三丰` 会让请求**静默挂死 110 秒**；
   同样的值百分号编码后 1.6 秒返回，ASCII 值 1.0 秒。需要中文就让客户端编码、服务端
   `decodeURIComponent`。
3. **n8n 数据表 rows API 的顺序不可依赖。** `sortBy` 只有冒号被百分号编码时才生效
   （`createdAt%3Adesc`），否则按插入顺序返回、**最旧的在前**；且返回的是**最前面 N 行**
   而非最新 N 行。任何「取最近 N 条」的代码都要自己按时间过滤，不要 `break` 在第一条窗口外的行。
4. **删除行没有 `DELETE /rows/{id}`**，要用 `DELETE /rows/delete?filter=<encoded>`。
5. **n8n 数据表 ≠ 同名 Postgres 表。** `documents` 在 `information_schema` 里查不到；真实结构是
   `data_table`（注册表，含 `name`）+ `data_table_column` + `data_table_user_<id>`（数据）。
6. **LobeHub 的关键配置只在数据库里**（`enableResponseApi` / `searchMode` /
   `useModelBuiltinSearch` / `system_agent` / `memory.enabled`），恢复旧备份会静默打回未接线状态。
   用 `N8N_URL=… CHAT_API_KEY=… node n8n/scripts/lobehub-config.mjs`（`apply` 修复，`status` 检查）。
7. **工具定义曾经有四份副本，其中两份是错的，而四道门全绿。**（2026-09-21 实测）
   `build-upstream` 的 `TOOLS`（15）· `append-tool-results` 的 `TOOLS`（12）·
   `check-response` 的 `SERVER_NAMES`（12）· 侧车 `SERVER_TOOLS`（15）。旧版契约门只比首尾两份，
   所以中间两份漂移了也照样绿。后果有两层：① 第 2 轮工具循环里 `run_python` /
   `mcp_list_tools` / `mcp_call` 和**全部 `wf_*` 自建流程工具消失**；② 带 `client_tools`
   的客户端（LobeHub）上，这三个工具被 `SERVER_NAMES` 误判成客户端工具 → 网关整条响应透传、
   自己不执行 → **用户收到一条空消息**，而 smoke / 自检 / MCP 全绿，因为它们都不走那条路径。
   **已修**：第 2 轮复用第 1 轮下发的 `server_tools`，`SERVER_NAMES` 改为从同一份数组推导——
   副本消失，漂移在结构上不可能发生。新增 `check-tool-contract.mjs` 的三项守卫
   （声明 ⊆ 实现 + 禁止硬编码副本）与 `test-client-tools.mjs`（守住那条没人覆盖的路径）。
8. **`web_search` 会「成功」地返回 0 条结果，四道门全绿。**（2026-09-21 实测）
   SearXNG 的引擎会被上游封禁，此时它返回 **HTTP 200 + `results: []`**，
   网关照原样包成 `{ type: 'web', results: [] }` 交给模型 —— 工具没报错、执行记录是 success、
   自检是绿的，但模型拿到的信息是空的，只能回答"查不到"。
   排查命令（在 n8n 容器内打，走容器网络 `searxng:8080` 而不是宿主机 8080）：
   ```bash
   docker exec n8n sh -c "wget -q -O - --timeout=25 --header='User-Agent: Mozilla/5.0' \
     'http://searxng:8080/search?q=test&format=json'"
   # 看 unresponsive_engines 字段：有值就说明引擎被封了
   ```
   2026-09-21 实况：`brave` · `duckduckgo` · `google cse` · `startpage` 全部 Suspended，
   `wikidata` 随后也挂了 —— **只剩 Wikipedia 偶尔响应，且基本只匹配单词查询**
   （`python` → 1 条；`python programming language` / `n8n` / `mount everest` → 0 条）。
   **已证伪的一个猜测**：User-Agent 与能否拿到结果**无关**。无 UA / `Wget/1.21` /
   `Mozilla/5.0` 三种各跑两次，`results` 与 `unresponsive_engines` 完全一致。
   （早前误判"不带 UA 更容易拿到结果"，是因为 shell 引号被拆开让 wget 直接失败了。）
   **别把时间花在 UA 上。**
   **已加护栏**（同日）：① 网关在 0 结果时给工具结果带上 `empty: true` + `notice` +
   `unresponsive_engines`，并**透传给模型**——模型现在会说"搜索后端故障、不代表查不到"，
   而不是断言"不存在"；② 自检新增「searxng engines」一项（43 → **44** 项），
   **真的发一次搜索**再看 `unresponsive_engines`，全挂且有 0 结果即判失败。
   注意原来那项「searxng up」只探首页，只证明进程在听 —— 跟沙箱 healthz 是同一个坑。
   **已修复**：换掉全部被封引擎，`searxng/settings.yml` 改为 `keep_only` 一批
   **免 key、实测可用**的引擎（yep / yandex / bing / sogou / quark / 360search / wikipedia）。
   不用注册任何账号、不引入任何外部依赖。默认搜索现在稳定返回 31–63 条，中英文都行。
   **改配置时的两个坑**（都踩过）：
   ① `keep_only` 只是**从默认名单里挑**，挑出来的 7 个里有 6 个仍是 `disabled: True`
   ——必须再用 `engines: [{name: X, disabled: false}]` 显式打开，否则只有 wikipedia 活着；
   ② `use_default_settings` 必须是**字典**才会读 `keep_only`，写成 `true` 会被静默忽略。

9. **定时任务在 Windows 桌面上是"名义上"的 —— 04:15 那批根本没跑。**（2026-09-21 实测）
   自检装好新鲜度检查后**当场报警**：`scheduled=85.8h`，即每日 04:15 的自检
   **已经 3.6 天没有真正触发过**。90 条运行记录里只有 3 条是 `source=schedule`，
   其余全是手动。根因是环境：容器今天 10:28–14:43 才起来，**04:15 时栈不在线**。
   这与之前"备份定时任务静默停了 65 小时"（提交 `bb3cd6e`）是同一个根因。
   **所有挂在凌晨的定时任务（自检、备份…）在这台机器上都要打个问号。**
   **已修**（提交 `cce2cd3`）：给每日任务**多个时间点**，哪个落在机器在线时就跑哪个：
   | 任务 | 原来 | 现在 | 每日一次守卫 |
   | --- | --- | --- | --- |
   | Selfcheck | 04:15 | `15 4,10,16,21 * * *` | `Already Ran Today`（看 `selfcheck_runs.source='schedule'`） |
   | Chat Retention | 03:00 | `0 3,14 * * *` | 无（清理本身幂等） |
   | Daily Brief | 08:30 | `30 8,11,15 * * *` | `Already Briefed Today`（看 `daily_briefs.brief_date`） |
   | Topic Watch | 21:00 | `0 9,13,17,21 * * *` | `Already Ran Today`（看 `cron_runs`，period=当天） |
   | Weekly Review | 周日 20:00 | `0 9,14,20 * * 0` | `Already Ran This Week`（看 `cron_runs`，period=ISO 周） |
   **守卫是必需的**：否则机器全天在线时自检会跑 4 次、晨报会出 3 份、周报周日会出 3 份。
   加了守卫，多出来的时间点就纯粹是"补跑"——**一天（周）只真跑一次，直到机器开机为止**。
   `topic-watch` / `weekly-review` 原本没有可用于去重的日期字段，所以新建了一张通用的
   `cron_runs` 表（`job` / `period` / `ran_at` / `source`），守卫查它、跑成功后打标记。
   **守卫 fail-open**：查不到状态时放行（宁可重复一次，也不能把任务悄悄掐死）；
   **标记只在跑成功后写**——跑失败时 n8n 会停在这里，标记不落，后面的时间点还有机会补。
   **注意**：自检的 `selfcheck ran recently` 会**分别统计手动与定时** ——
   否则手动跑一次就把定时停摆这件事盖住了。
10. **n8n 数据表 rows 端点不带 `sortBy` 时返回的是"按主键最前面的 N 行"（最旧的）。**
    客户端再排序只是在"最旧的 N 条里挑最新"，会得出完全错的结论
    （实测：真实 age 是 0.1h，这么写会报 30h）。
    **必须** `sortBy=createdAt%3Adesc`，且**冒号要百分号编码**；
    建议手工拼 URL（`?limit=250&sortBy=createdAt%3Adesc`）走 `this.helpers.httpRequest`，
    别让 http helper 二次编码。另：`report` 列存的是 `{checks:[...]}`，不是裸数组。

### 出向 MCP（连别人的服务）

平台的 MCP 原来只对外（17 个工具给外部客户端），自己却连不了任何人——在 agent 网络里是片叶子，不是节点。
现在补上出向：新增 `mcp_list_tools` / `mcp_call` 两个工具（共 15 个）。

- 服务器登记在 `mcp_servers` 表（name / url / auth_header / enabled / note），**模型只能用、不能注册**
  （与工作流工具、run_python 审批同一条规则：模型提案，人点火）
- 走 streamable HTTP；响应解析同时接受 **JSON 与 SSE `data:` 帧**——各家实现不一，
  这里静默解析失败看起来会和"工具不存在"一模一样
- 每次调用写 `admin_audit`

实测指向平台自己的 MCP 端点作为出向目标：`mcp_list_tools` 返回 17 个工具，审计记为
`{"action":"mcp_list_tools","server":"self","count":17}`。

> 值得一记：模型读到外部工具描述后主动提示"疑似提示注入，不会据其描述执行额外动作"。
> **把别人的工具列表当不可信输入**是正确姿态，别去"修好"它。

### run_python（代码执行沙箱）

`n8n-sandbox` 容器原来跑一个没人用的 task-runner mock，现在是真正的执行服务
（`n8n/sandbox_server.py`，纯标准库，`POST /run` + 头 `x-sandbox-key`）。

- **不对宿主机发布端口**，只在 docker 网络内可达；每次 `/run` 都要共享密钥
- 子进程跑，执行前设 `RLIMIT_CPU / AS(512M) / FSIZE(16M) / NOFILE(64)`，外加墙钟超时（默认 15s，上限 30s）与 8KB 输出上限
- **默认拒绝**联网、起子进程、动态执行（`eval/exec/__import__`）、写文件，并返回人类可读的理由
- 每次执行写一行 `admin_audit`（记 `why` / 是否成功 / 是否被拦 / 代码长度）
- 镜像由 `n8n/sandbox.Dockerfile` 构建，带 **numpy 2.5.3 / pandas 3.0.6**（alpine 上有 musl wheel，
  无需编译工具链）；新 clone 首次 `up` 会构建一次，之后走缓存
- 内存上限 `SANDBOX_AS_MB`（默认 1536）——**512MB 连 pandas 都 import 不进来**
  （症状是子进程 MemoryError，而 `docker exec` 里却能跑，因为没有 rlimits）
- 自检新增一项 `sandbox up`（43 项）

作为网关工具注册，模型可自行调用；侧车 `SERVER_TOOLS` 同步（契约门校验，现为 13 个工具）。

**被拦下的代码走人工审批**（`sandbox_approvals` 表）：

```
模型调用 run_python → 被拦 → 登记（sha256(代码) / why / 原文 / 15 分钟 TTL）
                    → 推给机主 [允许执行一次 / 拒绝]（复用推送按钮）
                    → 机主点允许 → 桥接直接执行（allow_network）→ 结果写回该行并推送
```

批准按 **sha256(代码原文)** 绑定、一次性——你批准的是真正会跑的那段代码。
**不要等模型重试**：实测模型会拒绝重跑（它把"禁止联网"当成沙箱的物理属性而非可放行的策略），
所以点击批准后由桥接直接执行，不依赖模型配合。

> 静态扫描是减速带不是边界，真正的边界是容器 + rlimits。它的作用是：被提示词注入的模型
> 不能悄悄外联——想联网必须显式提出来由人决定（这条路径目前还没开）。

### 推送可操作（inline actions）

`Notify` 的 body 可以带 `actions: [{label, kind, id, hours}]`，推送出去就自带按钮：

| kind | 含义 | 写入 |
|---|---|---|
| `td` | 待办完成 | `/webhook/admin/todos/complete` |
| `ta` | 收到（回执，不关闭） | `todos.ack_at` |
| `ts` | 待办推迟 N 小时 | `todos.due_date` |
| `rd` | 提醒知道了 | `/webhook/admin/reminders/cancel` |
| `rs` | 提醒 N 小时后再响 | `reminders.due_at` |

Telegram 渲染成 inline keyboard，点完写回同一行并摘掉按钮（防重复点）；其它渠道降级成一行文字提示。
**不带 `actions` 时行为与改造前逐字一致。**

两个调用点已接线：`Reminders → Check Due`（知道了 / 1 小时后再提醒）、`Reminders → Sweep Overdue Todos`（派出去的：我收到了 / 已完成；自己的：已完成 / 推迟 1 天）。

> 坑：Telegram 桥的 `getUpdates` 原本是 `allowed_updates: ['message']`——**回调会被 Telegram 直接过滤掉**，按钮点了没反应。必须把 `'callback_query'` 加进去。

### 推送渠道（消息触达）

统一出口：`Notify` 工作流（`POST /webhook/internal/notify`，Bearer 同 CHAT key）。晨报、告警与后续的提醒都从这里送出。

配置（约 2 分钟）：
1. 在飞书 / 企业微信建一个**群机器人**，复制其 Webhook URL（飞书：群设置 → 群机器人 → 自定义机器人；企微：群设置 → 群机器人）；
2. 写入根目录 `.env`：`ALERT_WEBHOOK_URL=<你的 URL>`（可选 `ALERT_WEBHOOK_FORMAT=feishu|wecom|slack|discord|generic`，留空按域名自动识别）；
3. `docker compose up -d n8n` 生效；自测：控制台「Briefs」页 →「推送到 IM」。

未配置时一切推送优雅跳过（返回 `skipped:no-channel`），不会报错。`.env` 编辑红线：无 BOM + LF。

（补充）Telegram 通道（已接通，2026-09-16）：
1. BotFather 新建 bot → 复制 token；先在 Telegram 里给 bot 发一条消息（bot 不能先开口）；
2. `.env` 设置 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`（可从 `https://api.telegram.org/bot<token>/getUpdates` 取 `chat.id`）、`ALERT_WEBHOOK_FORMAT=telegram`；
3. `docker compose up -d n8n` 生效；自测：控制台「发送测试」或 `POST /webhook/admin/alerts/test`。

说明：晨报**自动推送**当前关闭（daily-brief 的 Push Brief 节点 `disabled`；控制台手动「推送到 IM」不受影响）；告警与提醒正常推送。

**双向入口（已上线）**：直接给 bot 发消息即与平台对话（长轮询接入 → 网关（session `tg-<chat_id>`，自动带最近 20 条上下文）→ 回复，无需公网地址）；`/help` 看示例、`/reset` 清空该会话记忆；仅响应机主账号，其他人消息被忽略。轮询每分钟一次（一般 1 分钟内响应）。

### 手机访问（局域网）

同一 Wi-Fi 下直接用手机浏览器打开（防火墙与可信来源已配置）：

- 对话（LobeHub）：`http://<LAN-IP>:3210`
- 控制台：`http://<LAN-IP>:3000`

要点：
- Windows 防火墙含入站规则（TCP 3210 / 3000 / 9000，以及 HTTPS 的 8443–8446，仅限本地子网，命名 `agent-platform LAN: *`）；重装或换机后以管理员运行 `add-lan-rules.cmd` 可重建。
- `APP_URL` / `S3_ENDPOINT` / `S3_PUBLIC_DOMAIN` 均使用局域网地址（由 `.env` 的 `PLATFORM_LAN_IP` 控制；换网络时改这一处并重建 **n8n / lobechat**——`console` 不引用这个变量，不用重建）。
- ⚠️ 别把 `PLATFORM_LAN_IP` 填成 **OpenVPN / Hyper-V / WSL 虚拟网卡**的 IP：那些地址只有本机可达，手机和其他 Wi-Fi 设备访问不到。查真实局域网 IP 用 `Get-NetIPAddress -AddressFamily IPv4`，认准 WLAN 那一条。
- 手机可把两个页面「添加到主屏幕」，体验接近 App。
- 已知限制：桌面休眠时手机不可达；出门在外访问属可选进阶（Tailscale）。

### HTTPS 入口（Caddy 反向代理）

现有的 HTTP 端口（3000 / 3210 / 5678 / 9001）**一个都不动**，Caddy 只是在旁边新增一层加密入口：

| 地址 | 转发到 |
| --- | --- |
| `https://<host>:8443` | 控制台 `platform-console:3000` |
| `https://<host>:8444` | LobeHub `lobechat:3210` |
| `https://<host>:8445` | n8n `n8n:5678` |
| `https://<host>:8446` | MinIO 控制台 `minio:9001` |

- 启动 / 停止：`docker compose up -d caddy` / `docker compose stop caddy`（停掉后原来的访问方式照旧可用）。
- 证书：局域网模式用 Caddy 内部 CA 自签（`tls internal`）。首次访问浏览器会提示"证书不受信任"，点继续即可，**流量是真的加密的**。
- 站点名字取自 `.env` 的 `LAN_IP`（compose 回退 `127.0.0.1`）。**换网络后改这一行再 `docker compose restart caddy`**，否则 SNI 对不上会握手失败。
- 正式域名：`caddy/Caddyfile.domain.example`，自动 Let's Encrypt。
- 防火墙：以管理员运行 `add-lan-rules.cmd`（已包含 8443–8446）。

三个坑，都踩过，别改回去：

1. **站点地址不能只写 `:8443`。** 没有主机名时 Caddy 的内部 CA 拿不到任何名字，签不出叶子证书（`/data/caddy/certificates` 会是空的），TLS 握手以 `internal_error`(alert 80) 中断——所有客户端连不上，而 Caddy 日志照样打印 `server running`。这是"看着全绿其实全挂"的典型。
2. **验证时必须用证书里的名字当 Host。** 连 `127.0.0.1:8443` 会带 `Host: 127.0.0.1:8443`，匹配不到站点，Caddy 返回**空 200**（无 content-type、无上游 etag），极易误判成"代理坏了"。另外 Windows 上 curl 会被 `https_proxy` 环境变量劫持，要加 `--noproxy '*'`；判读证书错误用 `openssl s_client` 比 curl 的 Schannel 后端准。
3. **用 IP 访问时客户端不发 SNI**（RFC 6066 禁止把 IP 填进 SNI，浏览器和 curl 都遵守）。没有 SNI，Caddy 匹配不到站点，**握手直接断**——表现是"20ms 就连接失败"，既不是超时也不是证书错误，很容易误判成端口没开。Caddyfile 里用 `default_sni {$LAN_IP}` 兜底。**注意：Node 探针可以显式塞 `servername`，那不是浏览器的真实行为，别拿它当证据。**

LobeHub（8444）额外做了 `header_down Location` 重写：它用 `APP_URL`（`http://<LAN-IP>:3210`）拼**绝对**跳转地址，会把已经走 https 进来的人又送回 http。重写后 `Location` 与 `callbackUrl` 都留在 https，且主机名跟着入口走（从 localhost 进就跳 localhost，从局域网 IP 进就跳局域网 IP）。

验收脚本：`LAN_IP=192.168.209.141 node caddy/probe.mjs`。它会验三种路径（localhost / 局域网 IP / **不发 SNI**）× 四个入口，并断言 `Via: 1.1 Caddy` 与 LobeHub 跳转后仍是 https。当前 **12/12 通过**。

MinIO 加一层 basic auth（可选，默认关闭——避免把没人知道的密码写进配置）：

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext '你的密码'
# 输出写进 .env 的 ADMIN_PASSWORD_HASH（含 $，用单引号包住），
# 然后去掉 caddy/Caddyfile 里 :8446 段落的 basic_auth 注释，
# docker compose restart caddy
```

### 流式输出（打字机）

LobeHub 对话已启用流式回复（首字约 1–3 秒出现）：

- 链路：LobeHub → `stream-bridge` 侧车（`http://stream-bridge:3211/v1`）→ 直连上游 SSE；纯聊天即到即显，含「深度思考」实时展示。
- 工具轮：侧车检测到工具调用后自动降级到网关完成完整工具循环，再以打字机方式把结果流回（工具能力不丢）。
- 统计一致性：流式轮次回写 `chat_messages` + `chat_executions`（client 为 `stream-bridge`），控制台与晨报统计不受影响。
- 运维：侧车代码 `stream-bridge/server.js`（其中工具定义需与 chat-gateway 同步维护）；回退 = 把 `OPENAI_PROXY_URL` 指回 `http://n8n:5678/webhook/v1` 并将 agents `chat_config.enableStreaming` 置 false，重建 lobechat。

### 平台自检（Selfcheck）

一条命令给平台做全链路体检（20 项检查，约 12–20 秒）：

- 入口：控制台首页「平台自检」卡（一键运行）或 `POST /webhook/admin/selfcheck/run`；每日 04:15 自动跑一次。
- 覆盖：基础设施（7 端点）· 网关 golden（闲聊 / 工具轮 / 401 负例）· 流式链路（SSE 直通 / 工具降级 / 非流式代理）· 通道（Notify / TG 桥 / 提醒）· 数据（备份心跳 / 总览 / 统计 / 消息库）。
- 报告：落 `selfcheck_runs` 表（控制台可看）；**失败自动推送 Telegram**。
- 备份心跳：每日备份完成后向 `POST /webhook/admin/heartbeat` 上报（`heartbeats` 表），自检据此判断备份新鲜度（>30h 警告；>40h 或失败 = 不通过）。

### 待办（Todos）

开放循环登记（对话 / 晨报 / 控制台三处接入）：

| 说一句 | 工具 | 动作 |
| --- | --- | --- |
| 「记一下：周五交房租」 | `todo_add` | 登记待办（可带截止日 YYYY-MM-DD） |
| 「我还有什么待办？」 | `todo_list` | 未完成清单（标注逾期 / 今日到期） |
| 「交房租办完了」 | `todo_done` | 按 ID 收口（列表回复里带序号） |

- 晨报联动：每天 08:30 晨报尾部自动附「待办速览」（逾期 / 今日到期 / 其他）。
- 控制台：首页「待办」卡可直接勾掉。
- 设计红线：待办不自动变提醒、提醒不自动变待办（边界清晰）。
- API（Bearer 同 CHAT key）：`GET /webhook/admin/todos`、`POST /webhook/admin/todos/add`、`/complete`；数据表 `todos`。

### 记忆（Memory）

记忆系统已开启：LobeHub + Telegram 双入口，跨话题记住稳定偏好与身份事实。

- 原理：LobeHub 自动提取（偏好 / 身份 / 经历 / 活动）→ 经 `stream-bridge` 转发嵌入（DashScope `text-embedding-v4`，OpenAI 风格模型名自动映射）→ 存本机 lobechat 库（pgvector）；回答时自动检索相关记忆注入上下文。
- 覆盖范围：LobeHub 全端（自动提取，DashScope 嵌入）。
- Telegram 侧：桥接回复前调 `POST /webhook/internal/memory {action: 'retrieve'}` 注入上下文（并一并参考 LobeHub 记忆），回复后 `{action: 'extract'}` 保守提取入库（`agent_memories`，pgvector + qwen3.7 嵌入）。
- 双库说明：TG 可读 LobeHub 记忆，LobeHub 暂不读本机库（单向互通，v2 计划同步）；控制台「记忆」卡可查看两边记忆（只读）。
### 语音（Telegram 双向语音，2026-09-16）

- 规则：**来语音 → 回语音**（镜像模式）；回复超过 900 字自动降级文字；识别或合成失败均降级文字，不丢消息。
- 语音进：TG 语音 → `stream-bridge` `POST /voice/transcribe`（getFile + 下载 + 格式嗅探 + `qwen3-asr-flash` 识别）→ 文本进入全链路（记忆 / 工具照常生效）。
- 语音出：回复文本 → `POST /voice/reply`（`qwen-tts` 合成，音色 Cherry）→ `sendVoice` 发回（WAV 直发，无需转码；失败降级 `sendAudio`）。
- 工程注意：DashScope TTS 结果 URL 在容器网络下必须改用 https 拉取（http 会 502）；音频格式按文件头（RIFF / OggS）嗅探而非扩展名。
### 图片消息（视觉，2026-09-16 修复）

- LobeHub 发图 → 网关 / 桥接自动把平台本地的图片 URL（任意 `host:3210` 与 `host:9000` 形式，含 LAN IP）内联为 base64 data URL，再送上游——本地地址上游无法直接下载。
- 修复记录：此前转换只匹配 `localhost` / `127.0.0.1` 形式，从局域网（`<LAN-IP>:3210`）访问时生成的图片地址会漏转、导致上游报 `Failed to download image`；现已覆盖任意主机形式，且桥接侧同步内联（图片轮次可走真流式，不再降级）。
- Telegram 发图（2026-09-16）：TG 里发照片 / 图片文件（可带文字说明）→ 侧车 `/image/fetch` 取图转 data URI → 网关视觉作答（文字回复）；至此 TG 输入三件套（文字 / 语音 / 图片）齐了。
- TG 排版与体验（2026-09-16）：回复改 HTML 渲染（Markdown 转换，失败自动回退纯文本）、长回复按段落智能分段、长任务 12 秒进度提示；新增 `/memory` · `/todos` · `/reminders` 快捷命令（免模型直查）。
### 周报（Weekly Review，2026-09-16）

- 触发：每周日 20:00（Asia/Shanghai，工作流级时区）；手动 `POST /webhook/admin/weekly-review/run`（`{"force":true}` 可非周日试跑；`{"dry":true}` 只算不发，供自检）。
- 内容：本周待办（完成 / 开放 / 逾期）· 提醒（触发 / 待触发）· 对话轮次（SQL 口径，去重真实会话、排除后台噪声）· 新记忆 · 晨报数 + 模型一句话小结。
- 落库：`weekly_reviews` 表（week_start / week_end / content_md / stats_json）并推送 Telegram（每周一条）；控制台「周报」卡可查看历史与手动试跑（会推送）。

### 时区与调度（2026-09-16 修正）

- n8n 容器 `TZ` + `GENERIC_TIMEZONE=Asia/Shanghai`；含时间点的调度工作流（晨报 08:30 / 自检 04:15 / 保留 03:00 / 周报周日 20:00）均设工作流级 `settings.timezone=Asia/Shanghai`（已实测验证触发时刻）。
- 排障记录：Schedule 节点的 `field: "cron"` 是无效值（正确为 `cronExpression`），会静默退化成随机小时；`weeks.triggerAtDay` 取值 Sunday=0；数据表 rows API 的 `limit` 上限 250（超过返回 400）。
### MCP Server（2026-09-16）

平台对外暴露标准 MCP Server（工具型，2026-07-28 无状态规范）：

### 自建流程工具（L2，2026-09-16）

把你在 n8n 里亲手搭的流程（带 POST Webhook 触发器）注册成"对话工具"：之后在 TG / LobeHub 里说一句「跑一下 XX」即可点火，AI 只有**点火权**（触发），没有改装权（不建 / 不改 / 不删流程）。

- 注册（二选一，或把参数给我帮你注册）：

```bash
curl -X POST http://localhost:5678/webhook/admin/tools \
  -H "Authorization: Bearer <CHAT_API_KEY>" -H "Content-Type: application/json" \
  -d '{"action":"register","name":"bill_export","title":"账单导出","description":"导出当月账单到表格","path":"admin/bill-export"}'
```

- 其他操作：`{"action":"list"}` 查看；`{"action":"toggle","name":"bill_export","enabled":0}` 停用。
- 使用：对话里说「跑一下 账单导出」（TG 里 `/tools` 可看已注册清单）；触发时向你的 Webhook 发送 `{source:"chat", name, text, ts}` + `Authorization: Bearer <CHAT_API_KEY>` 头，返回内容摘要回给对话。
- 示例：`Example Echo Tool` 工作流 + `echo_demo` 注册项是活的最小样例（TG 说「跑一下 回声示例，文本 hello」可验证全链）。
### 企业繁琐工作包（2026-09-16）

三个"把繁杂提取成工作流"的常用场景，已注册为 L2 工具（TG / LobeHub 里说「跑一下 XX」即可）：

| 工具 | 作用 | 用法 |
| --- | --- | --- |
| `meeting_actions` 会议行动项 | 会议记录 → 行动项（人 / 事 / 期限，相对日期自动换算）→ 自动进待办 | 「跑一下 会议行动项，正文：<记录>」 |
| `smart_summary` 智能摘要 | 长文 → 一句话摘要 + 要点 → 自动归档知识库 | 「跑一下 智能摘要，正文：<长文>」 |
| `topic_watch` 动态监控 | 关键词监控（搜索 + 模型筛选）；每晚 21:00 自动扫描，有新发现推 TG | 「跑一下 动态监控，添加：关键词」/「列表」/「跑一下」/「移除：关键词」 |

- 实测：三条链路全过（含相对日期换算、同夜去重、真实新闻摘要与链接）；触发自动鉴权；每次触发是独立工作流执行，失败有错误返回。
- 备注：发票 / 报销类（图片 → 结构化记账）需要新增一个图片入参的侧工具，列为下一候选。
- 边界：注册的路径必须是 POST Webhook；流程自己的副作用由搭建者负责（这正是 L2「AI 只点火"的设计）；MCP 的 tools/list 与 L2 注册表暂不互通（v1.5 事项）。
- 端点：`POST /webhook/mcp`（仅局域网）；暴露 12 个工具（含只读 / 写入 / 长任务风险标注）。
- 鉴权：`Authorization: Bearer <MCP_API_KEY>`（密钥在 `.env`，SHA-256 哈希存 `gateway_keys`，可独立吊销 / 单独设限速）；亦接受主密钥。
- 兼容：同时支持 2026-07-28 无状态请求与旧版 `initialize` 握手客户端；JSON-RPC 通知返回 202。
- 治理：限流 60 次/分/密钥（`gateway_keys.rate_limit_rpm` 可覆盖，429 含重试提示）；每工具级超时（常规 15s / 长任务 90s）；每次 `tools/call` 写审计 `admin_audit`（action=`mcp.call`，含客户端信息 / 参数摘要 / 耗时 / 结果）。
- 运维：自检含 `mcp tools/list` 项；停用 = 工作流 deactivate；与聊天链路完全旁路（统计不互染）。
- 已实测：回归 14/14 全绿；官方 MCP Inspector 实测 `tools/list` 与 `tools/call`；限流 60+1×429 验证。
- 实现注记：非法 JSON 由传输层 422 拒绝（n8n 预解析所限，MCP 客户端 SDK 不受影响）；TLS / OAuth 就位前不暴露公网。
- 关闭方式：`user_settings.memory` 与 agents `chat_config.memory.enabled` 置 false（即时生效）。
- 开启时修复的上游兼容问题（记录备用）：工具消息需保留 `tool_call_id`；思考模式消息需回传 `reasoning_content`（空串亦可）。

### 聊天遥控（平台工具）

对话里直接使唤平台（网关内置工具，LobeHub / API 均可；模型按需自动调用，最多 2 轮工具循环）：

| 说一句 | 工具 | 动作 |
| --- | --- | --- |
| 「平台现在怎么样？」 | `platform_status` | 近 24h 流量 / 错误率 / 延迟 / 成本 / 告警 / 知识库用量 |
| 「帮我跑一份今天的晨报」 | `run_brief` | 立即生成并入库（控制台可见） |
| 「最近有没有告警？」 | `list_alerts` | 最近告警 + 投递状态 |
| 「把这句存进知识库：…」 | `kb_save` | 写入知识库（可被检索） |

与已有 `web_search` / `kb_search` 合并为 6 个服务端工具。LobeHub 新版界面会同时下发客户端工具（文档 / 技能等）：两组工具**合并**——客户端工具原样交还前端执行，平台工具由网关执行。已知边缘：上游 `deepseek-v4-flash` 思考模式不支持强制 `tool_choice`（个别客户端强制指定函数时会被上游拒绝）。

统计口径：平台错误率 / 告警已排除未认证探针流量（session `unknown`，来自冒烟测试的负向用例）。

### 提醒（Reminders）

对话里说一句就能建提醒，到点经推送通道送达（未配置渠道时记录为 `skipped:no-channel`，见上节）：

| 说一句 | 工具 | 动作 |
| --- | --- | --- |
| 「1 分钟后提醒我喝杯水」 | `create_reminder` | 建提醒（支持 `due_at` 或 `delay_minutes`；「明天 9 点」这类口语由模型换算） |
| 「我有哪些提醒？」 | `list_reminders` | 待推送 + 最近记录（含投递状态） |
| 「把那条 XX 取消掉」 | `cancel_reminder` | 按 ID 取消（仅 pending 可取消） |

- 巡检：Reminders 工作流每分钟扫描到期提醒（机器休眠时顺延，唤醒后补投）；投递经 Notify 统一出口；失败自动重试一次。
- API（Bearer 同 CHAT key）：`GET /webhook/admin/reminders`、`POST /webhook/admin/reminders/create`、`/cancel`、`/run`（手动触发巡检）。
- 数据表：`reminders`（text / due_at / status / delivered / attempts / meta）。

### 知识库（KB-DESIGN v1.1）

私域知识库：Postgres + pgvector（`kb_documents` / `kb_chunks` 表，HNSW 索引），
embedding 用阿里百炼 `qwen3.7-text-embedding`（1024 维，text_type 区分 query/document）。
检索经网关 `kb_search` 工具进入 Agent 循环，回答强制标注 [来源: 文档标题]。

```bash
# 摄取（幂等，同内容自动跳过）；mode=retire 下架；mode=list 列出
curl -X POST http://localhost:5678/webhook/admin/kb/ingest \
  -H "Authorization: Bearer $CHAT_API_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"ingest","title":"文档标题","text":"正文……"}'
```

评估：`node --env-file=.env n8n/scripts/kb-eval.mjs`（golden set hit@5 / MRR）。
设计详见 KB-DESIGN 文档；表结构 `n8n/scripts/kb-schema.sql`（换镜像后重跑一次即可）。

### LobeHub 前台（服务端数据库模式）

前台为 LobeHub 2.x（`lobehub/lobehub` 镜像，容器名 `lobechat`，端口 3210）。2.0 起仅支持服务端数据库模式：
聊天记录、设置全部存于 Postgres 的 `lobechat` 库，多浏览器/多设备共享。

- **登录**：首次打开注册即可（Better Auth 邮箱密码制；本机使用 `owner@agent-platform.local`）
- 旧版（v1 客户端模式）的浏览器本地会话数据不在服务端；如需保留，临时移除 DATABASE_URL 重启可切回 v1 导出
- 外观：PivotAI 主题 v2 已注入（见下节）；也可在设置 → 外观调整主题模式/强调色
- 文件存储（S3）：已由 MinIO 承载（Phase 4a，2026-09-15 上线），图片/文件上传可用；浏览器直传需宿主机 hosts 解析 `minio`（见「文件存储（MinIO）」一节）

### 文件存储（MinIO，Phase 4a）

LobeHub 的图片/文件上传由 **MinIO**（S3 兼容对象存储，compose 服务 `minio`）承载；2026-09-15 已端到端联调通过（图片 + 文本真实上传成功）。

- API：http://localhost:9000（健康检查 `/minio/health/live`）；控制台：http://localhost:9001
- Bucket：`lobechat-files`；凭据与 lobechat 的 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` 完全一致（见 docker-compose.yml）
- 镜像源：`quay.io/minio/minio`（Docker Hub 的 `minio/minio` 匿名拉取被拒）
- 接线：`S3_ENDPOINT=http://minio:9000`（容器网络内可达）；`S3_PUBLIC_DOMAIN=http://localhost:9000` 保留备用；`S3_SET_ACL=0` 维持私桶 + 预签名 URL 读取

**必要前提（宿主机 hosts，一次性，需管理员）**：LobeHub 生成的预签名上传地址直接使用容器名 `minio`（应用代码不做 host 改写），宿主浏览器必须能解析它才能直传文件。在 Windows hosts 文件添加：

```
127.0.0.1 minio
```

- 检查：`Resolve-DnsName minio`（应返回 127.0.0.1）；或 `curl.exe -s -o NUL -w "%{http_code}" http://minio:9000/minio/health/live`（应返回 200）
- 换机 / 重建环境时需重新添加；容器侧不受影响（Docker DNS 直接解析服务名）

```powershell
# 桶与对象检查
docker exec minio mc ls --recursive local/lobechat-files
```

### PivotAI 主题（LobeHub 2.x 版）

深空黑 + 粒子星宇宙 + 玻璃拟态皮肤：`custom-theme/pivot-theme-v2.css`（样式）与 `pivot-theme-v2.js`（星宇宙引擎：
Canvas 星尘粒子（景深/闪烁/星座连线/流星/鼠标互动）+ 品牌徽标 + 人脸垫层）。通过 `apply-theme-v2.ps1` 幂等注入到容器内全部 SPA 样式表与共享运行时模块；`pivot-face.jpg` 为超清 AI 人脸（已去水印），以 screen 混合半透明垫入背景（透明度调 CSS `#pivot-face-mat.pivot-face-on` 的 opacity 一行）。

```bash
# 在 custom-theme/ 目录下执行
powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Restart   # 应用/更新（容器重建后必须带 -Restart）
powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Check     # 探针：主题在不在（exit 0/1）
powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Remove    # 卸载（去除注入块，保留原文件）
```

改文案/颜色：编辑仓库 `custom-theme/pivot-theme-v2.*`（颜色集中在 :root 的 --pivot-* 变量）→ 重跑脚本 → 浏览器强刷（Ctrl+Shift+R）。
注意：① 容器重建/升级会重置文件系统，需重跑脚本恢复；② 静态文件列表在容器启动时拍快照，新文件（人脸图）必须重启容器后才可被服务，故推荐直接 `-Restart`；③ 已部署 Windows 计划任务「PivotAI Theme Keeper」每 5 分钟自动巡检，主题被抹掉时自动"重注入+重启"修复（日志 `custom-theme/theme-keeper.log`）；④ 注入器自动为每个文件保留 `.pivot-backup` 原始备份。
- 市场（模板/发现 Agent）需要 LobeHub 云端账号授权（market.lobehub.com 全端点要求登录）；不影响核心对话，注册 lobehub.com 账号后可在应用内连接

### 嵌入额度计量（1M tokens/模型）

阿里百炼的 embedding 模型各带 100 万 tokens 额度。`kb_usage` 数据表记录累计用量（摄取时自动累加，
查询侧调用量小未计）；Chat Alerts 每 15 分钟检查，**用量 ≥ 80% 时自动写入告警**（ops_alerts，`embedding_quota` 类）。
查看当前用量：`POST /webhook/admin/alerts/run`（Bearer）会在响应里带 `embedding_quota`；
或查 `kb_usage` 数据表。额度不足时的选项：购买加油包 / 换成 flash 变体（需全量重嵌，两模型向量空间不通用）。

### 错误率告警（Chat Alerts workflow）

每 15 分钟自动检查最近 60 分钟的网关错误率（读 chat_executions），错误率 ≥ 50% 且
样本 ≥ 5 时写入 ops_alerts 数据表（60 分钟冷却防风暴）。阈值经 .env 的
`ALERT_WINDOW_MIN` / `ALERT_RATE_THRESHOLD` / `ALERT_MIN_TOTAL` / `ALERT_COOLDOWN_MIN` 调整。
手动触发与查询：`POST /webhook/admin/alerts/run`（Bearer CHAT_API_KEY；body `{"mode":"list"}` 查看告警历史）。
错误响应原文落库：chat_executions 的 `error_raw` 列保存上游完整错误体（截断 2000 字符）。

### 多 Key 与限流（n8n/scripts/keys.mjs）

除主 key 外可为其他客户端签发托管 key（哈希存储，泄露即废、可随时吊销）：

```bash
node n8n/scripts/keys.mjs list                  # 列出 key / 限额 / 累计花费
node n8n/scripts/keys.mjs add phone 10          # 签发新 key，限 10 次/分钟（原始 key 只显示一次）
node n8n/scripts/keys.mjs set-limit phone 30    # 调整限额（0 = 不限）
node n8n/scripts/keys.mjs disable phone         # 临时吊销 / enable 恢复 / rm 删除
```

限流按 key 维护 60 秒滚动窗口（以 chat_executions 落库计数），超限返回 429。
每次成功请求按 DeepSeek 牌价折算 cost_usd 记入两表，并累计到 key 的 total_cost；
牌价调整时更新 chat-gateway 工作流里 `Prep Success Log` 节点的 PRICING 表。

### 数据保留（Chat Retention workflow）

每日 3:00 自动清理网关数据表的过期行（先 dryRun 计数、再真删）：
`chat_messages` 默认保留 30 天、`chat_executions` 默认 90 天，由 `.env` 的
`RETENTION_DAYS_MESSAGES` / `RETENTION_DAYS_EXECUTIONS` 控制。
手动触发：`POST /webhook/admin/retention/run`（Bearer CHAT_API_KEY）。
`idempotency_records` 也在清理名单里（`RETENTION_DAYS_IDEMPOTENCY`，默认 7 天）。

### 幂等（重试不会把副作用跑两遍）

客户端超时就会重发。**没有幂等时，一句「记一下买牛奶」在重试后变成两条待办**，
而用户只说过一次。

- **显式**：请求带 `X-Idempotency-Key: <任意字符串>`，同 key + 同工具 → 直接返回上次结果。
- **隐式**：没带 key 时，用 `session_id + 工具名 + sha256(args)` 作为键，窗口内重复即折叠。
  **这条才是真正救命的** —— 客户端不用配合就能防住重试。
- 只保护**副作用工具**（`todo_add` / `todo_done` / `create_reminder` / `cancel_reminder` /
  `kb_save` / `run_python` / `mcp_call` / 全部 `wf_*`）；只读工具不去重。
- 记录落在 `idempotency_records` 表（ idem_key / tool_name / session_id / result ），
  每天随 retention 清理。窗口 `IDEMPOTENCY_WINDOW_SEC`（默认 300 秒，**0 = 关停**）。

### 工具循环可观测（tool_trace）

以前 `chat_executions` 只知道"用了几轮"，不知道每轮干了什么 —— 出了问题只能猜。
现在每一轮的每次工具调用都记下来：

```json
[{"round":1,"tool":"todo_add","ms":247,"ok":true,"replayed":false,"idem":"i:faca966137","args":"{\"text\":\"买牛奶\"}"},
 {"round":2,"tool":"todo_list","ms":303,"ok":true,"replayed":false,"idem":"","args":"{}"}]
```

字段：`round` 轮次 · `tool` 工具名 · `ms` 耗时 · `ok` 成败 · `replayed` 是否被幂等折叠 ·
`idem` 去重键前缀（`k:` 显式 / `i:` 隐式）· `args` 参数摘要。
落在 `chat_executions.tool_trace`（同时新增 `tool_rounds` 列）。

排障时先查这里：是模型没调工具、工具报错、还是被幂等折叠了，一眼可分。

#### 多步编排该多深：先量再改

```bash
node --env-file=.env n8n/scripts/cap-rate.mjs 7      # 近 7 天
```

输出工具轮次分布、跑满率、撞顶次数，并给一句判断。
轮次上限由 `MAX_TOOL_ROUNDS` 控制（默认 2，改它不需要动代码）。

**一个反直觉的事实**：到达上限时网关会**把工具列表整个移除**来强制收口，
所以「模型还想调工具却被截断」这个计数**默认恒为 0** —— 不是没生效，是模型无从调用。
换句话说，截断被"收口"掩盖了：代价不是报错，而是**模型可能在信息不足时直接编答案**。
想测出"模型到底想要几轮"，只能临时把 `MAX_TOOL_ROUNDS` 调高（比如 5），
再跑 `cap-rate.mjs` 看请求自然停在第几轮。

#### 收口提示（BUDGET_NOTE）

到达 `MAX_TOOL_ROUNDS` 时，网关在**最后一次请求**上追加一条 system 消息，明确告诉模型
「工具预算已用完，只能依据已有结果回答；信息不足就直说缺什么，不要编」。
不加这条，模型不知道工具已经被拿走，会继续按"我还能查"的思路推理，最后凭空作答。

提示本身带护栏：「已有信息足以回答就正常回答，不要向用户提及预算」——避免反向误伤。

> **实测结论：效果未证实。** 2026-09-21 做过 A/B（有无提示各跑同一道信息不足题），
> 两边**都**主动承认信息不足，回答长度 707 vs 547，无决定性差异。
> 更关键的是：那次 A/B 测的其实不是提示，而是**坏掉的搜索后端**（见坑位 8）——
> `web_search` 大面积返回空结果，模型不管有没有提示都只能说"查不到"。
> 保留它的理由是它只在跑满轮次的请求上出现（约 4–15%）、且有护栏，属于便宜的保险；
> **不要把它当成已验证的修复**。等搜索后端恢复后值得重跑一次 A/B。

> 设计取舍来自 2026-09-21 的一次调研（Anthropic 内部数据 + METR + Pi 的设计哲学）：
> Claude Code 真实使用中单次会话已能连续调 **21 次**工具，但**超过一半的工程师说
> 只有 0–20% 的工作能「完全委托」**；METR 则显示成功率随任务长度陡降。
> 而本平台自己的样本里 **0 条长输入**。所以结论是**不做通用自主规划**：
> 单步保持现状、2–5 步用「浅循环 + 三重预算」、超过 5 步下沉到 L2 工作流只给点火权。
> 深度上限应该用**预算**表达（步数 / 墙钟 / 成本），而不是简单调大轮数。

## 工作流管理（源码化）

工作流不再只存在于 n8n 数据库中：

- `n8n/workflows/*.json` — 可部署的 workflow 源码（`chat-gateway`、`chat-stats-api`、`chat-retention`）
- `n8n/workflows/baseline/` — 重构前旧 workflow 的快照（仅存档，勿部署）
- `n8n/scripts/deploy.mjs` — 部署脚本：按 id 更新或创建 workflow、激活生产 webhook、
  自动创建缺失的 Data Table（`chat_messages`、`chat_executions`）

```bash
export N8N_API_KEY=<your-n8n-api-key>
node n8n/scripts/deploy.mjs
```

修改 workflow 的正确姿势：改 `n8n/workflows/*.json` → 跑 deploy → 验证 → 提交。


## CI 与契约测试

- **结构校验** `n8n/scripts/validate-workflows.mjs`（无网络/无依赖，CI 用）：workflow JSON
  字段与连线完整性、webhook path 全局唯一、workflow 与 compose 无硬编码密钥、
  compose 引用的每个 `${VAR}` 必须在 `.env.example` 中声明。
- **契约冒烟** `n8n/scripts/smoke-test.mjs`（需已部署的实例）：网关鉴权、请求校验、
  模型路由、真实对话往返 + OpenAI 响应契约、Stats / Retention API 鉴权与响应形状，共 47 项断言。
- **最小 CI** `.github/workflows/ci.yml`：Kiranism typecheck + workflow 结构校验。
  集成 smoke 需要真实实例与 API key（无法 headless 引导），部署后手动跑：

```bash
export N8N_URL=http://localhost:5678
export CHAT_API_KEY=<your-chat-key>
node n8n/scripts/smoke-test.mjs
```


## PivotAI 前台视觉与动效系统 (Cyber Glassmorphism & Star Cosmos)

前台已升级为年轻、高辨识度的 **PivotAI** 沉浸式赛博流光视觉风格：
- **品牌与 Slogan**：PivotAI | 从对话到执行 / Chat less. Ship more.
- **色彩规范**：主色 `#3B82F6` (Electric Blue)，强调色 `#06B6D4` (Cyan)，背景 `#030712` (Cyber Deep Black)
- **核心动态与交互**：
  1. **动态粒子星宇宙**：60fps Canvas 星尘漂移（近大远小景深、闪烁、星座连线、偶发流星）+ 鼠标互动（粒子避让+连线）+ 极淡银河带底纹
  2. **磨砂玻璃拟态 (Glassmorphism)**：侧边栏、卡片、输入框高斯模糊与高光描边，hover 微浮起
  3. **顺滑气泡动效**：用户与 AI 回复消息平滑滑入；AI 消息具备微光呼吸感
  4. **光感按钮反馈**：按压缩放（Scale）与蓝青流光（Glow）
  5. **输入区聚焦增强**：输入框聚焦激活蓝青多层光晕与高光轮廓
  6. **会话切换平滑过渡**：告别生硬闪切，全组件保持 60fps 顺滑物理阻尼

### 重装或重新应用主题
```powershell
# 在 custom-theme/ 目录下执行（容器重建后必须重跑；详见上文主题节）
powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Restart
```

## 常用命令

```bash
# 查看所有服务状态
docker compose ps

# 查看 n8n 日志
docker compose logs -f n8n

# 重启单个服务
docker compose restart lobechat

# 停止所有服务
docker compose down

# 停止并删除数据（⚠️ 谨慎：n8n_data + postgres_data 都会被删除）
docker compose down -v
```

## 目录结构

```
agent-platform/
├── docker-compose.yml        # 统一服务编排
├── README.md                 # 本文档
├── apply-theme.ps1           # PivotAI 视觉主题一键注入脚本
├── custom-theme/             # PivotAI 定制主题源文件
│   ├── pivot-theme.css       #   玻璃拟态与赛博光晕样式表
│   └── pivot-theme.js        #   60fps 星宇宙粒子与品牌动态引擎
├── n8n/
│   ├── workflows/            #   workflow 源码（deploy.mjs 部署）
│   └── scripts/              #   deploy / keys / smoke-test / validate / backup 运维脚本
├── frontent/                 # Kiranism 管理后台 (Next.js 16)
│   ├── src/app/              #   App Router 路由
│   ├── src/features/         #   业务功能模块
│   ├── src/components/       #   公共组件
│   └── src/lib/              #   工具库 (含 n8n-client)
├── lobechat/                 # LobeChat 源码 (可选本地开发)
└── backend/                  # n8n 源码 (当前使用 Docker 镜像)
```
