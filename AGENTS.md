---
doc: agent-platform 项目地图（面向 LLM / coding agent）
verified_at: 2026-10-31
verified_commit: 6e2ccbc
root: C:\Users\hzh\Documents\Qoder\2026-10-31\4bda7702
human_docs: README.md（1168 行）、DEPLOY-NOTES.md（1044 行）
conventions: 文中 `路径:行号` 为证据位置；标注「确认」= 已读代码，「推断」= 由代码推导
---

# agent-platform — Agent 项目地图

本文件是给大模型 / agent 阅读的入口文档。人读版本见 `README.md`。仓库名与目录名有意保留拼写 `frontent`（不是 frontend）。

## 0. 三十秒心智模型

- **一个自托管平台，跑在一台机器上。** n8n 是唯一的业务逻辑与 Agent 编排中枢；前端（LobeHub / 控制台 / Telegram / MCP）最终都只调用 n8n，彼此不直接互调（唯一旁路是 LobeHub → stream-bridge → n8n，见 §2.1；`README.md:9-17`、`README.md:125`）。
- **12 个常驻 Docker 服务 + 3 个可选 profile。** 不是 README 写的 8 或 9 个（见 §11 偏差 D1）。
- **源码即工作流。** 25 个 n8n workflow 以 JSON 形式入库，部署靠脚本推送，不在 n8n UI 里改（`README.md:1073-1095`）。
- **密钥全在 `.env`（gitignore）。** workflow JSON 内不出现密钥值，运行时读 `$env.*`（`n8n/scripts/validate-workflows.mjs:1-11`）。
- **控制台是 Next.js BFF。** 浏览器只访问 `/api/*`；n8n 的 `N8N_API_KEY` 只在服务端出现（`README.md:271-275`）。

## 1. 服务清单（docker-compose.yml）

### 1.1 常驻服务（`docker compose up -d` 启动，共 12 个）

| # | compose 服务 | 容器名 | 镜像 / 构建 | 宿主端口 | 职责 | 证据 |
|---|---|---|---|---|---|---|
| 1 | `n8n` | `n8n` | `docker.n8n.io/n8nio/n8n:${N8N_VERSION}` | 5678 | 工作流引擎、所有 webhook 与业务逻辑 | `docker-compose.yml:25-120` |
| 2 | `console` | `platform-console` | build `./frontent` | 3000 | 运营控制台（Next.js standalone） | `docker-compose.yml:126-150` |
| 3 | `postgres` | `postgres` | `paradedb/paradedb:latest-pg17` | 不暴露 | 主数据库 + pgvector + pg_search | `docker-compose.yml:154-178` |
| 4 | `redis` | `platform-redis` | `redis:7.4-alpine` | 127.0.0.1:16379 | Platform Runtime 的幂等/锁/限流状态 | `docker-compose.yml:183-199` |
| 5 | `searxng` | `searxng` | `searxng/searxng:latest` | 8080 | 公网搜索，供 agent 工具 `web_search` | `docker-compose.yml:204-215` |
| 6 | `n8n-sandbox` | `n8n-sandbox` | build `./n8n/sandbox.Dockerfile` | 仅内网 8000 | 隔离 Python 执行（`/run`，需共享密钥） | `docker-compose.yml:220-246`、`n8n/sandbox_server.py:162-197` |
| 7 | `lobechat` | `lobechat` | `lobehub/lobehub:latest` | 3210 | 终端用户对话前台（LobeHub 2.x） | `docker-compose.yml:251-308` |
| 8 | `minio` | `minio` | **`rustfs/rustfs:latest`** | 9000 / 9001 | S3 兼容对象存储（服务名沿用 `minio`） | `docker-compose.yml:313-343` |
| 9 | `stream-bridge` | `stream-bridge` | `n8nio/runners:latest` + 只读挂载 `./stream-bridge` | 127.0.0.1:3211 | OpenAI 兼容流式旁路，LobeHub 的模型入口 | `docker-compose.yml:348-377` |
| 10 | `platform-runtime` | `platform-runtime` | build `./platform-runtime` | 127.0.0.1:13220→3220 | 原子协调原语（幂等、任务、锁、限流、指标） | `docker-compose.yml:382-419` |
| 11 | `backup` | `platform-backup` | build `./backup` | 无 | 栈内备份：启动即跑，之后每 N 小时 | `docker-compose.yml:529-554` |
| 12 | `caddy` | `caddy` | `caddy:2-alpine` | 8443-8446 | 局域网 TLS 反向代理（可选停用） | `docker-compose.yml:558-585` |

### 1.2 可选 profile

| profile | 服务 | 作用 | 证据 |
|---|---|---|---|
| `phase2` | `platform-worker` | Redis Streams 消费者，异步 `kb_save` | `docker-compose.yml:425-453` |
| `observability` | `prometheus` | 抓取 runtime / bridge 指标（127.0.0.1:9090） | `docker-compose.yml:459-479`、`monitoring/prometheus.yml` |
| `event-bus` | `kafka` | KRaft 单节点试点，**不替代** Redis Streams | `docker-compose.yml:485-521` |

### 1.3 网络与卷（fresh clone 注意）

- 只有一张网络 `n8n-net`，声明为 **external**（`docker-compose.yml:587-590`）。
- 卷 `n8n_data` 也是 **external**（`docker-compose.yml:593-595`）；其余卷由 compose 管理。
- 因此全新机器直接 `docker compose up -d` 会因外部资源缺失而失败，需先：
  `docker network create n8n-net && docker volume create n8n_data`
  （迁移脚本里有同样的创建逻辑：`migration/restore.sh:80-86`；README 快速启动**未写**这一步）。

## 2. 请求链路（确认）

### 2.1 对话主链路（实际实现）

```
LobeHub :3210 --OPENAI_PROXY_URL--> stream-bridge:3211/v1
    ├─ 非流式 / 无工具：原样转发 n8n /webhook/v1/chat/completions
    └─ 流式：优先直连 https://api.deepseek.com 快速返回；
              若上游出现 tool_calls，丢弃本次、回落 n8n 网关跑完整工具循环，
              再把结果伪装成 SSE 返回
```

- 装配证据：`docker-compose.yml:261`（LobeHub → bridge）、`docker-compose.yml:357`（bridge → n8n）。
- 行为说明：`stream-bridge/server.js:1-8`、`stream-bridge/server.js:252,330,434`。
- **README 写的「LobeChat 直接 POST 到 n8n」已过时**（`README.md:244-247`），现在是经 stream-bridge。

### 2.2 控制台链路

```
浏览器 → console /api/* (Next Route Handler)
        ├─ /api/chat            → stream-bridge /chat/completions（SSE 透传）
        ├─ /api/n8n/*           → n8n /webhook/admin/* 或 /api/v1/*（X-N8N-API-KEY）
        └─ /api/platform/jobs/* → platform-runtime /v1/jobs/:id
```

- 27 个 route handler：`frontent/src/app/api/**/route.ts`（25 个在 `n8n/` 下）。
- n8n 地址解析：`frontent/src/lib/n8n-client.ts:1-6`（`N8N_URL` → `NEXT_PUBLIC_N8N_URL` → `http://localhost:5678`）。
- 登录守卫：`frontent/src/lib/api-guard.ts:17`；上游 401/403 被重标为 502（`frontent/src/lib/api-guard.ts:32-40`）。
- 例外：`/api/n8n/health` 无鉴权（`frontent/src/app/api/n8n/health/route.ts:4-11`）；`/api/n8n/docs/[id]` 支持 `?t=` 签名免登录（`frontent/src/app/api/n8n/docs/[id]/route.ts:16-30`）。

### 2.3 Telegram 与 MCP

- Telegram：`telegram-bridge` workflow 每分钟轮询；推送与双向语音（`n8n/workflows/telegram-bridge.json`）。
- MCP：外部 agent 调 `POST /webhook/mcp`，JSON-RPC，Bearer `MCP_API_KEY`（`n8n/workflows/mcp-server.json`）。

## 3. 代码地图

| 目录 | 文件数 | 运行期角色 | 说明 |
|---|---|---|---|
| `n8n/` | 66 | 运行 | `workflows/*.json` 源码、`scripts/` 部署/校验/回归、`sandbox.Dockerfile` |
| `frontent/` | 649 | 运行 | 控制台（Next 16 App Router；目录名拼写如此） |
| `platform-runtime/` | 8 | 运行 | `platform-runtime/server.js`（533 行）+ 可选 `platform-runtime/worker.js`（phase2 profile） |
| `stream-bridge/` | 1 | 运行 | 单文件 `stream-bridge/server.js`（639 行） |
| `caddy/` | 4 | 运行 | `Caddyfile`、域名版示例、探测脚本 |
| `backup/` | 3 | 运行 | 栈内备份镜像 |
| `searxng/` | 1 | 运行 | 搜索配置 |
| `monitoring/` | 8 | 可选 | Prometheus 配置 + 6 份验收报告 |
| `deploy/` | 23 | 按需 | external / cloudflare / event-bus / k8s 叠加层，主 compose 不引用 |
| `migration/` | 7 | 一次性 | 迁移三件套 preflight → restore → verify |
| `scripts/` | 28 | 开发 | 演示生成、截图采集、S3 校验、密钥扫描、钩子 |
| `custom-theme/` | 13 | 手工 | 注入运行中的 LobeHub 容器（非 compose） |
| `deliverables/` `demo-assets/` `interview-demo/` | 116 | 静态 | 演示包 / 素材 / 面试演示台，**不参与运行** |
| `.github/` | 1 | CI | 仅 `.github/workflows/ci.yml` |

### 3.1 必读文件

| 文件 | 为什么读 |
|---|---|
| `docker-compose.yml` | 唯一部署事实源：端口、依赖、环境变量、profile |
| `.env.example` | 全部配置项与含义（196 行） |
| `n8n/scripts/deploy.mjs` | workflow 部署规则 + 23 张数据表定义 |
| `n8n/workflows/chat-gateway.json` | 对话/鉴权/记忆/工具循环的全部逻辑 |
| `frontent/src/lib/n8n-client.ts` | 控制台到 n8n / runtime 的所有服务端调用 |
| `frontent/src/config/nav-config.ts` | 控制台真实导航（14 项） |
| `platform-runtime/server.js` | 协调 API 契约 |
| `stream-bridge/server.js` | 流式旁路与降级规则 |
| `backup/backup.sh` | 5 类备份产物与新鲜度守卫 |

## 4. n8n：工作流、工具、调度

### 4.1 部署模型（确认）

- `n8n/workflows/*.json` 共 **25** 个可部署 workflow；`n8n/workflows/baseline/` 是 2 个旧快照，**不部署**（`n8n/scripts/deploy.mjs:1-15`、`README.md:1077`）。
- 有 `id` → PUT 更新；无 `id` → POST 新建；`active:true` 会重新注册 webhook；`@table_name` 引用会先建表（`n8n/scripts/deploy.mjs:1-15`）。
- 共 **40** 个唯一 webhook path（`grep '"path"' n8n/workflows/*.json` 去重计数）。
- webhook 本身**没有 n8n 原生鉴权**；鉴权在各 Code 节点里比对 `$env.CHAT_API_KEY`（如 `n8n/workflows/todos.json` 的 Auth 节点）。

### 4.2 工作流分组

| 组 | 文件 | webhook 前缀 |
|---|---|---|
| 对话核心 | `chat-gateway`、`chat-stats-api`、`chat-retention`、`chat-alerts` | `v1/*`、`admin/*` |
| 控制台后端 | `platform-admin-api`（68 节点）、`todos`、`reminders` | `admin/*` |
| 定时任务 | `daily-agenda`、`daily-brief`、`weekly-review`、`topic-watch`、`selfcheck`、`heartbeat` | `admin/*` |
| 工具 | `doc-forge`、`smart-summary`、`meeting-actions`、`workflow-tools`、`example-echo` | `admin/tools*`、`admin/docforge` |
| 内部服务 | `memory`、`notify`、`stream-log` | `internal/*` |
| 外部入口 | `mcp-server`、`telegram-bridge`、`lobehub-config`、`kb-ingest` | `mcp`、`admin/*` |

### 4.3 调度（从 workflow JSON 的 Schedule 节点提取）

| workflow | 规则 |
|---|---|
| `daily-agenda` | `30 7,11,15 * * *`（07:30 主槽；当天已有成功推送则补跑槽静默） |
| `chat-alerts` | 每 15 分钟 |
| `chat-retention` | `0 3,14 * * *` |
| `daily-brief` | `30 8,11,15 * * *` |
| `topic-watch` | `0 9,13,17,21 * * *` |
| `weekly-review` | `0 9,14,20 * * 0` |
| `selfcheck` | `15 4,10,16,21 * * *` |
| `reminders` | 每 1 分钟 |
| `telegram-bridge` | 每 1 分钟 |

`daily-agenda` 的纳入范围：自己的 open todo（必须有 `due_date` 且 ≤ 今天）、未确认的委派（`owner_ref` 非空、`ack_at` 为空，无 due 或 ≤ 今天）、pending 且 ≤ 今天的提醒。指纹（item 身份 + 文本 + bucket + due + owner）不变时不推送，也不写 `agenda_runs`；推送失败同样不写，次日会重试。11:30 / 15:30 是补跑槽，`Already Sent Today` 守卫在当天已有成功记录时直接结束，避免一天推两次。

### 4.4 Agent 工具

- 网关静态工具表（`n8n/workflows/chat-gateway.json` 的 `Build Upstream Payload` 节点）共 **16** 个：
  `web_search, kb_search, platform_status, run_brief, list_alerts, kb_save, create_reminder, list_reminders, cancel_reminder, todo_add, meeting_actions, todo_list, todo_done, run_python, mcp_list_tools, mcp_call`。
- 其上还会动态追加：`wf_<name>`（`wf_tools` 注册表里的用户自建流程）与 `client_tools`（客户端自带工具）；因此**工具总数不是固定值**，"16"只指静态表。
- 第 1 轮的 `serverTools` 会作为 `server_tools` 传入第 2 轮，保证工具面不会在循环中途缩小（同节点注释）。
- MCP 暴露 **17** 个工具（`n8n/workflows/mcp-server.json` 的 `Do MCP` 节点）：上述大部分 + `people_list, delegation_view, doc_create, doc_list, doc_get`。
- 工具循环上限由 `MAX_TOOL_ROUNDS` 控制，默认 2（`docker-compose.yml:59`）。
- Code 节点可用的外部模块：`pg`（`NODE_FUNCTION_ALLOW_EXTERNAL=pg`）、内置 `crypto`（`docker-compose.yml:63-67`）。

## 5. 数据与状态

### 5.1 Postgres

- 镜像 `paradedb/paradedb:latest-pg17`，启动参数预加载 `pg_search,pg_cron`（`docker-compose.yml:156-164`；缺 `pg_cron` 会让全新卷启动失败，注释已记录）。
- 卷名是 `postgres_data_pg17`（`docker-compose.yml:596-598`），旧卷 `postgres_data` 留作回滚（`README.md:127-129`）。
- n8n Data Table **23 张**，定义在 `n8n/scripts/deploy.mjs:46-295`：
  `chat_messages, chat_executions, admin_audit, idempotency_records, kb_usage, daily_briefs, workflow_tools, topic_watch, todos, people, tool_contract, mcp_servers, sandbox_approvals, documents, weekly_reviews, selfcheck_runs, heartbeats, telegram_state, reminders, ops_alerts, ops_alert_silence, gateway_keys, agenda_runs`。
- 另有 `platform` schema（`CREATE SCHEMA IF NOT EXISTS platform`，`n8n/scripts/platform-schema.sql:7`），runtime 使用 `platform.requests / platform.events / platform.tool_runs`（`platform-runtime/server.js:133-230`）。

### 5.2 Redis

- 仅 platform-runtime 与其 worker 使用；键前缀 `platform:`，任务流 `platform:jobs`（`platform-runtime/server.js:436`、`docker-compose.yml:435`）。
- 主机仅绑定 `127.0.0.1:16379`（`docker-compose.yml:190`）。

## 6. 配置矩阵（根 `.env`，见 `.env.example`）

| 类别 | 变量 | 关键约束 |
|---|---|---|
| 身份/密钥 | `CHAT_API_KEY`、`N8N_API_KEY`、`N8N_ENCRYPTION_KEY`、`MCP_API_KEY`、`DASHSCOPE_API_KEY`、`UPSTREAM_API_KEY`、`POSTGRES_*`、`MINIO_ROOT_*`、`AUTH_SECRET`、`KEY_VAULTS_SECRET`、`JWKS_KEY`、`TELEGRAM_*` | `CHAT_API_KEY` 必须与 LobeHub 的 `OPENAI_API_KEY` 一致；`N8N_ENCRYPTION_KEY` 有凭据后不可改（`.env.example:9-25`、`docker-compose.yml:40-44`） |
| 运行时回退 | `PLATFORM_RUNTIME_KEY` | 留空即复用 `CHAT_API_KEY`（`.env.example:34-36`、`platform-runtime/server.js:11`） |
| 局域网 | `PLATFORM_LAN_IP`、`LAN_IP` | 手机访问、预签名上传、Caddy 证书 SAN 都依赖它（`.env.example:108-118`） |
| 端口 | `N8N_PORT`、`CONSOLE_PORT`、`LOBECHAT_PORT`、`SEARXNG_PORT`、`MINIO_*_PORT`、`STREAM_BRIDGE_PORT`、`CADDY_PORT_*` | 只改宿主端口，容器端口固定（`docker-compose.yml:11-18`） |
| 资源/行为 | `RETENTION_DAYS_*`、`IDEMPOTENCY_WINDOW_SEC`、`MAX_TOOL_ROUNDS`、`PLATFORM_RATE_LIMIT_RPM`、`EMBEDDING_*`、`ALERT_*` | 多数有代码内默认值 |
| 备份 | `BACKUP_INTERVAL_HOURS=6`、`BACKUP_MIN_AGE_HOURS=20`、`BACKUP_OFFSITE_DIR` | 新鲜度守卫（`.env.example:126-136`） |
| 控制台 | `CONSOLE_CLERK_PUBLISHABLE_KEY`、`frontent/.env.local` | 前者是构建参数（改后需重建镜像），后者被 compose 以 `required:false` 挂入（`docker-compose.yml:129-140`） |

## 7. 命令手册（全部可在仓库根执行）

```bash
# 启动 / 停止
docker compose up -d                 # 12 个常驻服务（需先创建 n8n-net 与 n8n_data）
docker compose --profile phase2 up -d platform-worker
docker compose --profile observability up -d prometheus
docker compose --profile event-bus up -d kafka

# 工作流：源码 → 运行实例
N8N_URL=http://localhost:5678 N8N_API_KEY=<key> node n8n/scripts/deploy.mjs

# 校验（无网络，可在 CI 跑）
node n8n/scripts/validate-workflows.mjs

# 集成冒烟（需已部署实例）
N8N_URL=... CHAT_API_KEY=... node n8n/scripts/smoke-test.mjs

# 控制台本地开发
cd frontent && bun install && bun run dev        # http://localhost:3000
cd frontent && bun run typecheck

# 一次性接线
bash scripts/provision-bucket.sh                              # 建桶 + CORS
node n8n/scripts/lobehub-config.mjs                           # LobeHub ↔ 网关
```

控制台脚本来自 `frontent/package.json:9-22`；包管理器是 **bun**（`bun.lock`），CI 与 `frontent/Dockerfile` 都固定 **bun 1.4.4**（`frontent/Dockerfile:12-13`、`.github/workflows/ci.yml:22-26`）。

## 8. 改动流程

| 想改什么 | 正确路径 |
|---|---|
| n8n 业务逻辑 | 改 `n8n/workflows/*.json` → `n8n/scripts/deploy.mjs` → `n8n/scripts/smoke-test.mjs` → 提交；**不要**在 UI 里改后不回写（`README.md:1095`） |
| 控制台页面 | `frontent/src/app/dashboard/<x>/page.tsx` + `frontent/src/features/<x>/` + `frontent/src/config/nav-config.ts` |
| 控制台调后端 | 新增 `frontent/src/app/api/n8n/<x>/route.ts`，复用 `frontent/src/lib/n8n-client.ts` 与 `requireUser()` |
| 加配置项 | `.env.example` 声明 → `docker-compose.yml` 注入 → 代码读取（`n8n/scripts/validate-workflows.mjs` 会校验 compose 的 `${VAR}` 都在 `.env.example` 中） |
| 基础设施 | 改 `docker-compose.yml`；可选能力放 `deploy/*` 叠加层，不塞进主栈 |
| 备份策略 | `backup/backup.sh` + `.env` 的 `BACKUP_*`；不要依赖宿主机计划任务（`docker-compose.yml:523-528`） |

## 9. 硬性约束（违反会静默出错）

1. `CHAT_API_KEY`、LobeHub `OPENAI_API_KEY`、backup 心跳、stream-bridge 鉴权是**同一把 key**，必须同步轮换（`docker-compose.yml:40-44`、`backup/backup.sh:23-26,116-138`）。
2. 有凭据后改 `N8N_ENCRYPTION_KEY` 会让所有凭据无法解密（`.env.example:9-13`）。
3. `n8n-net` / `n8n_data` 是 external，必须先存在（`docker-compose.yml:587-595`）。
4. `stream-bridge` 的 `SERVER_TOOLS` 必须与 `n8n/workflows/chat-gateway.json` 手工同步（`stream-bridge/server.js:8`）。
5. LobeHub 有**两个** S3 客户端：浏览器拨 `S3_ENDPOINT`（LAN IP），服务端拨 `S3_INTERNAL_ENDPOINT`（`minio:9000`）；混用会导致上传 403 / ECONNREFUSED（`docker-compose.yml:279-294`）。
6. Caddy 站点必须写主机名；IP 字面量不发 SNI，靠 `default_sni {$LAN_IP}` 兜底；换网段改 `LAN_IP` 后重启 caddy（`caddy/Caddyfile:18-41`）。
7. 不要改名 `minio` 服务与 `minio_data` 卷（RustFS 沿用的历史名，LobeHub 的 S3 变量依赖它，`docker-compose.yml:313-322`）。
8. 控制台容器端口固定 3000；对外只改 `CONSOLE_PORT`（`docker-compose.yml:145-146`）。
9. `MCP_API_KEY` 不是 `CHAT_API_KEY`；MCP 鉴权走 `gateway_keys` 哈希表。
10. 提交必须区分人与代理身份：代理用 `git -c user.name="agent-platform" -c user.email="dev@agent-platform.local" commit`（`README.md:315-330`）。
11. 推送前有 `secret-scan.sh --added` 闸门，新凭证形状（≥16 字符、非 URL）会被拦（`scripts/secret-scan.sh`、`scripts/hooks/pre-push`）；不要用 `--no-verify` 绕过。

## 10. 控制台细节（frontent）

- **栈**：Next.js 16.2.12 App Router、React 19.2.4、TypeScript 5.7.2、Tailwind 4、shadcn/ui、Clerk 7、Sentry、zustand、TanStack Query/Table/Form、nuqs（`frontent/package.json:23-88`）。
- **鉴权**：`clerkMiddleware()` 只挂上下文（`frontent/src/proxy.ts:5-12`）；`/dashboard` 段在布局里 `await auth.protect()`（`frontent/src/app/dashboard/layout.tsx:20-22`）。
- **真实页面**（14 个导航项）：`overview, docs, knowledge, topics, briefs, people, ai-chat, workflows, keys, alerts, models, settings, profile, notifications`（`frontent/src/config/nav-config.ts:36-160`）。
- **死路由 16 个**：`billing, chat, elements/icons, exclusive, forms/*, kanban, product, product/[productId], react-query, users, workspaces, workspaces/team` 都调用 `notFound()`（模板残留，`find frontent/src/app/dashboard -name page.tsx | xargs grep -l notFound`）。
- **API**：27 个 route handler；认证 cookie 由 Clerk 管理，前端不存 token。
- **环境变量**：`frontent/env.example.txt` 只有 Clerk/Sentry/`CHAT_API_KEY`；`N8N_URL`、`N8N_API_KEY`、`PLATFORM_RUNTIME_*` 由 compose 运行期注入（`docker-compose.yml:141-144`）或本地自行补进 `.env.local`。

## 11. 已知偏差与坑（写文档时已核对）

| 编号 | 现象 | 证据 | 影响 |
|---|---|---|---|
| D1 | README 说「8 个服务」/「9 个容器」，实际常驻 **12** | `README.md:9,60,177` vs `docker-compose.yml` | 按 README 数容器会漏掉 redis / stream-bridge / runtime / caddy |
| D2 | README 说 LobeChat 直接调 n8n；实际经 `stream-bridge` | `README.md:244-247` vs `docker-compose.yml:261,357` | 排查流式/工具问题会找错层 |
| D3 | 工具数：README 写 12，网关实际 16；MCP 17 | `README.md:31-32` vs `n8n/workflows/chat-gateway.json`、`n8n/workflows/mcp-server.json` | 计数类断言不可信 |
| D4 | 数据表：README 写 19，实际 23 | `README.md:51` vs `n8n/scripts/deploy.mjs:46-295` | 同上 |
| D5 | smoke 断言数 README 内部矛盾（71 / 47） | `README.md:77` vs `README.md:1090-1093` | 以运行输出为准 |
| D6 | 原 CI 用 `pnpm-lock.yaml`（仓库只有 `bun.lock`）→ 已修复并提交（`8400781`）：CI 改用 bun + `bun.lock`，bun 固定 1.4.4 | `.github/workflows/ci.yml:9-43` vs `frontent/bun.lock` | 修复前每个 PR 必红 |
| D7 | `frontent/AGENTS.md` 过期：写 Next 16.0.10、ESLint/Prettier | `frontent/AGENTS.md` vs `frontent/package.json:15-19` | 按它选工具会装错；以本文件与 `frontent/package.json` 为准 |
| D8 | README 数据流段落有重复粘贴 | `README.md:262-266` | 阅读噪声 |
| D9 | ~~文档分享未接通~~ **原判断错误，已更正**：分享链路是通的——`doc-forge` 的 `Run Doc Forge` 节点用 `CHAT_API_KEY` 做 HMAC 签出 `?t=`，`frontent/src/app/api/n8n/docs/[id]/route.ts:21-22` 用 `verifyDocToken` 校验，控制台「复制链接」按钮走 `action:'sign'`（`frontent/src/features/docs/components/docs-panel.tsx:126-138,261-263`），selfcheck 还有 `doc signed link` 断言。真正的问题只是前端 `signDocToken` / `DOC_TOKEN_TTL_DAYS` 两个导出从无调用者（重复实现），已删除 | `n8n/workflows/doc-forge.json`、`frontent/src/lib/doc-token.ts` | 别把它当缺失功能重做一遍 |
| D10 | 控制台元数据仍是模板文案、包名仍是 `next-shadcn-dashboard-starter` | `frontent/src/app/dashboard/layout.tsx:11-18`、`frontent/package.json:2` | 仅观感 |
| D11 | 硬编码局域网 IP `192.168.1.114` | `frontent/src/features/overview/components/push-mobile-card.tsx:13,66-71` | 换网络后推送卡片失效 |
| D12 | `searxng` 使用明文弱密钥 `n8nsecretkey123` | `searxng/settings.yml:40` | SearXNG 仅内网可达，但仍属弱配置 |
| D13 | `.probe.txt` 是 docker 探测输出残留 | `.probe.txt:1-4` | 无功能影响，易误认为凭证 |
| D14 | backup 容器只读挂载整个 `.env` | `docker-compose.yml:547` | 容器内任意执行即可读到全部密钥 |
| D15 | 用字符串拼接绕过密钥扫描：`stream-bridge` 的 `'Bea'+'rer '`，`smoke-test.mjs` 的 `"proc"+"ess"` 与 `["DASH","SCOPE_API","_KEY"].join("")` | `stream-bridge/server.js:23`、`n8n/scripts/smoke-test.mjs:348` | 规避密钥扫描的写法，审计时要认得出 |
| D16 | 断言数以代码为准：`selfcheck.json` 现有 **48** 条 `add()`（README 写 42/42、47 项、45 通过，三处互不相同），`smoke-test.mjs` 现有 **65** 处 `check()` 调用，而它打印的 `total` 只算实际跑到的 pass/fail，缺 env 时整组 SKIP | `n8n/workflows/selfcheck.json`、`n8n/scripts/smoke-test.mjs:51,268,350,423,451` vs `README.md:52,447,476-477,1096` | README 那些数字是历史运行输出，引用前先数代码 |

## 12. 安全现状（必须知道）

- **残留凭证（历史）**：`a0bcb35`（2026-09-28）把真实 Postgres 密码写进 `scripts/check-users.mjs`，把真实 MCP Bearer token 与 Telegram chat id 写进 `demo-assets/_data.json`；`ce4a98b` 已从工作树移除，但**值仍在 git 历史**，且仓库 2026-10-29 之前是公开的。处置=**轮换这些值**，删文件不算修好（`git show ce4a98b`）。
- **当前工作树**：`bash scripts/secret-scan.sh HEAD` 无真实命中（输出只匹配扫描器自身正则）。
- **边界**：n8n webhook 用 `CHAT_API_KEY`；MCP 用 `MCP_API_KEY`（哈希存 `gateway_keys`）；runtime 用 `x-platform-runtime-key`；控制台用 Clerk；Sandbox 用 `x-sandbox-key`（`n8n/sandbox_server.py:162`）。

## 13. 如何自行核验本文件

```bash
# 服务与端口
grep -nE "^  [a-z-]+:" docker-compose.yml

# workflow 数与 webhook 数
ls n8n/workflows/*.json | wc -l                          # 25
grep -ho '"path": *"[^"]*"' n8n/workflows/*.json | sort -u | wc -l   # 40

# 控制台路由与死页面
find frontent/src/app/api -name route.ts | wc -l         # 27
grep -rl "notFound()" frontent/src/app/dashboard --include=page.tsx | wc -l  # 16

# 数据表
grep -cE "^  [a-z_]+: \[" n8n/scripts/deploy.mjs         # 23

# 密钥闸门
node n8n/scripts/validate-workflows.mjs
bash scripts/secret-scan.sh --self-test
```

维护规则：任何结构变更（新增服务、workflow、route、数据表、环境变量）都应同步更新本文件对应章节，并更新 `verified_commit` 与 `verified_at`。
