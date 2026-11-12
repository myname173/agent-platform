---
doc: agent-platform 项目地图（面向 LLM / coding agent）
verified_at: 2026-11-12
verified_commit: 418e6f4
verified_scope: P0 消费者闭环（§1.2 event-bus-outbox、§5.1 consumed_events、§6 事件总线配置）、P1 沙箱网关准入（§3、§12 边界、deploy/k8s/phase3-pilot）、P2 kind 多节点验证叠加层（deploy/k8s/phase6-kind，仅离线核验，集群演练未跑）、P3 HPA 弹性层（deploy/k8s/phase6-production/components/elastic + phase6-kind-elastic，仅离线核验，弹性演练未跑）与 KB 混合检索（§4.4、§5.1，n8n/lib/kb-hybrid.mjs + 三处 kb_search 内嵌 +  guarded bm25 索引 + kb-eval --hybrid，仅离线核验，现网检索增益未测）按本分支工作树核验；评测分支口径见 §15；其余架构沿用既有核验口径，不表示全量重新核验
root: C:\Users\hzh\Documents\Qoder\2026-10-31\4bda7702
human_docs: README.md（1168 行）、DEPLOY-NOTES.md（1044 行）
conventions: 文中 `路径:行号` 为证据位置；标注「确认」= 已读代码，「推断」= 由代码推导
---

# agent-platform — Agent 项目地图

本文件是给大模型 / agent 阅读的入口文档。人读版本见 `README.md`。仓库名与目录名有意保留拼写 `frontent`（不是 frontend）。

## 0. 三十秒心智模型

- **一个自托管平台，跑在一台机器上。** n8n 是唯一的业务逻辑与 Agent 编排中枢；前端（LobeHub / 控制台 / Telegram / MCP）最终都只调用 n8n，彼此不直接互调（唯一旁路是 LobeHub → stream-bridge → n8n，见 §2.1；`README.md:9-17`、`README.md:125`）。
- **12 个常驻 Docker 服务 + 4 个可选 profile。** 不是 README 写的 8 或 9 个（见 §11 偏差 D1）。
- **源码即工作流。** 26 个 n8n workflow 以 JSON 形式入库，部署靠脚本推送，不在 n8n UI 里改（`README.md:1073-1095`）。
- **密钥全在 `.env`（gitignore）。** workflow JSON 内不出现密钥值，运行时读 `$env.*`（`n8n/scripts/validate-workflows.mjs:1-11`）。
- **控制台是 Next.js BFF。** 浏览器只访问 `/api/*`；n8n 的 `N8N_API_KEY` 只在服务端出现（`README.md:271-275`）。
- **这台机器上有两个 agent 在改这个仓库。** 各自有独立 checkout 与分支，但共用同一个 `.git`、同一个 `.env` 和同一套 Docker 栈。动手前先读 §14。

## 1. 服务清单（docker-compose.yml）

### 1.1 常驻服务（`docker compose up -d` 启动，共 12 个）

| # | compose 服务 | 容器名 | 镜像 / 构建 | 宿主端口 | 职责 | 证据 |
|---|---|---|---|---|---|---|
| 1 | `n8n` | `n8n` | `docker.n8n.io/n8nio/n8n:${N8N_VERSION}` | 5678 | 工作流引擎、所有 webhook 与业务逻辑 | `docker-compose.yml:25-120` |
| 2 | `console` | `platform-console` | build `./frontent` | 3000 | 运营控制台（Next.js standalone） | `docker-compose.yml:126-150` |
| 3 | `postgres` | `postgres` | `paradedb/paradedb:latest-pg17` | 不暴露 | 主数据库 + pgvector + pg_search | `docker-compose.yml:154-178` |
| 4 | `redis` | `platform-redis` | `redis:7.4-alpine` | 127.0.0.1:16379 | Platform Runtime 的幂等/锁/限流状态 | `docker-compose.yml:183-199` |
| 5 | `searxng` | `searxng` | `searxng/searxng:latest` | 8080 | 公网搜索，供 agent 工具 `web_search` | `docker-compose.yml:204-215` |
| 6 | `n8n-sandbox` | `n8n-sandbox` | build `./n8n/sandbox.Dockerfile` | 仅内网 8000 | 隔离 Python 执行（`/run`，需共享密钥） | `docker-compose.yml:220-246`、`n8n/sandbox_server.py:497-545` |
| 7 | `lobechat` | `lobechat` | `lobehub/lobehub:latest` | 3210 | 终端用户对话前台（LobeHub 2.x） | `docker-compose.yml:251-308` |
| 8 | `minio` | `minio` | **`rustfs/rustfs:latest`** | 9000 / 9001 | S3 兼容对象存储（服务名沿用 `minio`） | `docker-compose.yml:313-343` |
| 9 | `stream-bridge` | `stream-bridge` | `n8nio/runners:latest` + 只读挂载 `./stream-bridge` | 127.0.0.1:3211 | OpenAI 兼容流式旁路，LobeHub 的模型入口 | `docker-compose.yml:348-377` |
| 10 | `platform-runtime` | `platform-runtime` | build `./platform-runtime` | 127.0.0.1:13220→3220 | 原子协调原语（幂等、任务、锁、限流、指标） | `docker-compose.yml:382-419` |
| 11 | `backup` | `platform-backup` | build `./backup` | 无 | 栈内备份：启动即跑，之后每 N 小时 | `docker-compose.yml:625-654` |
| 12 | `caddy` | `caddy` | `caddy:2-alpine` | 8443-8446 | 局域网 TLS 反向代理（可选停用） | `docker-compose.yml:658-685` |

### 1.2 可选 profile

| profile | 服务 | 作用 | 证据 |
|---|---|---|---|
| `phase2` | `platform-worker` | Redis Streams 消费者，异步 `kb_save` | `docker-compose.yml:425-453` |
| `observability` | `prometheus` | 抓取 runtime / bridge 指标（127.0.0.1:9090） | `docker-compose.yml:459-479`、`monitoring/prometheus.yml` |
| `event-bus` | `kafka` | KRaft 单节点试点，**不替代** Redis Streams | `docker-compose.yml:485-521` |
| `event-bus-outbox` | `platform-outbox-publisher`、`platform-event-consumer` | Outbox 试点闭环：publisher 租约式投递 `platform.outbox` → Kafka（指标 :9101）；consumer 幂等落 `platform.consumed_events`，重放是计数 no-op（指标 :9102）。Runtime 仍不写 outbox（`PLATFORM_OUTBOX_WRITE_MODE=off`） | `docker-compose.yml:559-587,592-617`、`deploy/event-bus/README.md` |

### 1.3 网络与卷（fresh clone 注意）

- 只有一张网络 `n8n-net`，声明为 **external**（`docker-compose.yml:687-690`）。
- 卷 `n8n_data` 也是 **external**（`docker-compose.yml:693-695`）；其余卷由 compose 管理。
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

- 28 个 route handler：`frontent/src/app/api/**/route.ts`（26 个在 `n8n/` 下）。
- n8n 地址解析：`frontent/src/lib/n8n-client.ts:1-6`（`N8N_URL` → `NEXT_PUBLIC_N8N_URL` → `http://localhost:5678`）。
- 登录守卫：`frontent/src/lib/api-guard.ts:17`；上游 401/403 被重标为 502（`frontent/src/lib/api-guard.ts:32-40`）。
- 例外：`/api/n8n/health` 无鉴权（`frontent/src/app/api/n8n/health/route.ts:4-11`）；`/api/n8n/docs/[id]` 支持 `?t=` 签名免登录（`frontent/src/app/api/n8n/docs/[id]/route.ts:16-30`）。

### 2.3 Telegram 与 MCP

- Telegram：`telegram-bridge` workflow 每分钟轮询；推送与双向语音（`n8n/workflows/telegram-bridge.json`）。对话入口＝机主会话 ＋ `people` 表里 active、role≠guest 且配了 `channels.telegram_chat_id` 的成员；成员受 deny-by-default 命令白名单约束，`/done`、`/ack` 只能动派给自己的条目，会话按 `tg-<chat_id>` 隔离（网关据此自动归因 `person_ref`）。
- MCP：外部 agent 调 `POST /webhook/mcp`，JSON-RPC，Bearer `MCP_API_KEY`（`n8n/workflows/mcp-server.json`）。

## 3. 代码地图

| 目录 | 文件数 | 运行期角色 | 说明 |
|---|---|---|---|
| `n8n/` | 88 | 运行 | `workflows/*.json` 源码、`scripts/` 部署/校验/回归、`lib/kb-hybrid.mjs`（混合检索规范模块，内嵌进三处 `kb_search` Code 节点）、`sandbox.Dockerfile`、K8s 沙箱网关（`sandbox_gateway.js` + 准入 `sandbox_admission.js` / 指标 `sandbox_metrics.js` + 离线契约测试） |
| `frontent/` | 620 | 运行 | 控制台（Next 16 App Router；目录名拼写如此） |
| `platform-runtime/` | 13 | 运行 | `platform-runtime/server.js`（533 行）+ 可选 `worker.js`（phase2）+ outbox publisher / 幂等 event-consumer（event-bus-outbox profile） |
| `stream-bridge/` | 1 | 运行 | 单文件 `stream-bridge/server.js`（639 行） |
| `caddy/` | 4 | 运行 | `Caddyfile`、域名版示例、探测脚本 |
| `backup/` | 3 | 运行 | 栈内备份镜像 |
| `searxng/` | 1 | 运行 | 搜索配置 |
| `monitoring/` | 22 | 可选 | Prometheus 配置 + README + 20 份验收/决策报告 |
| `deploy/` | 51 | 按需 | external / cloudflare / event-bus / k8s 叠加层（含 phase6-kind 多节点验证与 phase6-kind-elastic HPA 弹性演练，非生产），主 compose 不引用 |
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
| `n8n/scripts/deploy.mjs` | workflow 部署规则 + 本评测分支 26 张数据表定义（含两张未部署 eval 表，见 §5.1） |
| `n8n/workflows/chat-gateway.json` | 对话/鉴权/记忆/工具循环的全部逻辑 |
| `frontent/src/lib/n8n-client.ts` | 控制台到 n8n / runtime 的所有服务端调用 |
| `frontent/src/config/nav-config.ts` | 控制台真实导航（15 项） |
| `platform-runtime/server.js` | 协调 API 契约 |
| `stream-bridge/server.js` | 流式旁路与降级规则 |
| `backup/backup.sh` | 5 类备份产物与新鲜度守卫 |

## 4. n8n：工作流、工具、调度

### 4.1 部署模型（确认）

- `n8n/workflows/*.json` 共 **26** 个可部署 workflow；`n8n/workflows/baseline/` 是 2 个旧快照，**不部署**（`n8n/scripts/deploy.mjs:1-15`、`README.md:1077`）。
- 有 `id` 且该 id 在本实例存在 → PUT 更新；否则先按 **name** 找线上同名工作流，恰好一个就 PUT 它并把 id 回写源码，一个都没有才 POST 新建（`n8n/scripts/deploy.mjs:1362-1385`）。这道 name 兜底是给 `daily-agenda` / `health-report` 这类源码里没有 `id` 的文件用的：没有它就会在已有实例上再造一个同名工作流，两个 Daily Agenda = 每人每天两份晨报。`active:true` 会重新注册 webhook；`@table_name` 引用会先建表（`n8n/scripts/deploy.mjs:1-15`）。
- 共 **43** 个唯一 webhook path（`grep '"path"' n8n/workflows/*.json` 去重计数）。
- webhook 本身**没有 n8n 原生鉴权**；鉴权在各 Code 节点里比对 `$env.CHAT_API_KEY`（如 `n8n/workflows/todos.json` 的 Auth 节点）。

### 4.2 工作流分组

| 组 | 文件 | webhook 前缀 |
|---|---|---|
| 对话核心 | `chat-gateway`、`chat-stats-api`、`chat-retention`、`chat-alerts` | `v1/*`、`admin/*` |
| 控制台后端 | `platform-admin-api`（80 节点）、`todos`、`reminders`、`health-report` | `admin/*` |
| 定时任务 | `daily-agenda`、`daily-brief`、`weekly-review`、`topic-watch`、`selfcheck`、`heartbeat` | `admin/*` |
| 工具 | `doc-forge`、`smart-summary`、`meeting-actions`、`workflow-tools`、`example-echo` | `admin/tools*`、`admin/docforge` |
| 内部服务 | `memory`、`notify`、`stream-log` | `internal/*` |
| 外部入口 | `mcp-server`、`telegram-bridge`、`lobehub-config`、`kb-ingest` | `mcp`、`admin/*` |

`health-report` 是「一键出验收报告」：`POST /webhook/admin/report/health`（Bearer `CHAT_API_KEY`）把最近一条 `selfcheck_runs.report` 渲染成一份 doc-forge 文档（`kind=custom`），自己**不落库**，也不改 selfcheck。

- `audience=internal`（默认）：全部断言名 + 失败明细 + 内部主机名；默认**不签名**（不给免登录链接）。
- `audience=client`：只给分组计数（infra/gateway/stream/channel/data）与结论，不含任何断言名与明细；默认签名出 `?t=` 免登录链接（默认 7 天），`push:true` 再走 `/webhook/internal/notify` 推送。
- 新鲜度守卫：`checked_at` 超过 `max_age_hours`（默认 24）→ `409 stale_selfcheck`，必须显式传 `force:true` 才放行，且结果标 `stale_but_forced`；一条记录都没有 → `404 no_selfcheck_run`。
- 脱敏**失败即拒**：37 条黑名单扫「渲染结果 + 调用方传的 title」，命中就 `500 scrub_failed` 且**不创建文档**（fail closed，不会先写后删）。

### 4.3 调度（从 workflow JSON 的 Schedule 节点提取）

| workflow | 规则 |
|---|---|
| `daily-agenda` | `*/30 * * * *`（每半小时 tick；**按人**只在他自己时区的 07:30–16:00 窗口内送达一次） |
| `chat-alerts` | 每 15 分钟 |
| `chat-retention` | `0 3,14 * * *` |
| `daily-brief` | `30 8,11,15 * * *` |
| `topic-watch` | `0 9,13,17,21 * * *` |
| `weekly-review` | `0 9,14,20 * * 0` |
| `selfcheck` | `15 4,10,16,21 * * *` |
| `reminders` | 每 1 分钟 |
| `telegram-bridge` | 每 1 分钟 |

`daily-agenda` 是**按人发**的：收件人 = 机主（`owner_ref=''`，走 notify 的默认目标，与改造前逐字节一致）+ `people` 里每个 active 且 role≠owner 的人（走各自的 `channels`；没有可用通道的人**照样发**，由 notify 降级投给机主并在消息尾部注明，不静默丢弃）。机主那份的纳入范围没变：自己的 open todo（必须有 `due_date` 且 ≤ 今天）、未确认的委派（`owner_ref` 非空、`ack_at` 为空，无 due 或 ≤ 今天）、全部 pending 且 ≤ 今天的提醒。成员那份只含派给自己的：逾期、今天到期、以及还没 `/ack` 的（页脚直接告诉他 `/ack` 确认、`/done` 完成）；已确认又没到期的不打扰。

「今天」和「几点」都是**按人算**的：`people.tz` 用 `Intl.DateTimeFormat` 解析（DST 感知），机主取 `role=owner` 那一行的 `tz`；改它走控制台 People 页（`/dashboard/people`）的「时区」字段，默认 `Asia/Shanghai`。时区为空或非法一律回落 `Asia/Shanghai`，非法的那个额外在输出里标 `tz_invalid: true`，不静默用错的时间发。每个人的「今天」、提醒的到期判断、`agenda_date` 都来自他自己那口钟，所以 UTC+9 的成员不会在 UTC+8 的 23:30 被叫起来收「今天」的议程。

投递窗口是每人本地 **07:30–16:00**（对应改造前的 07:30 主槽与 15:30 最后一个补跑槽），窗口外的 tick 直接跳过他（`skipped.reason = outside_window`）。半小时 tick 不是「一天推 48 次」，而是自愈式补跑：谁进了窗口、谁被派了新活儿，最迟半小时后就收到，之后当天对他静默。原来的全局 `Already Sent Today` 守卫节点**已删除**——「今天」一旦按人算，任何全局预判都不可能对；权威判断是 `Load & Build` 里逐人的当日检查。手工触发 `POST /webhook/admin/agenda/run` 传 `{"force":true}` 只绕过窗口，**不**绕过「当天已送达」与指纹去重。

去重与落库都按人独立：`agenda_runs.owner_ref` 标记这一行是谁的，指纹（item 身份 + 文本 + bucket + due + owner + 项目 label）只跟**他自己**上一次成功推送比。改造前写入的旧行没有 `owner_ref`，算作机主的历史，所以升级当天不会给机主白推一次。推送失败不为该人落行，下一个 tick 或次日重试；`Push Agenda` 带 `onError: continueRegularOutput`，一个人投递失败不影响其他人。

### 4.4 Agent 工具

- 网关静态工具表（`n8n/workflows/chat-gateway.json` 的 `Build Upstream Payload` 节点）共 **16** 个：
  `web_search, kb_search, platform_status, run_brief, list_alerts, kb_save, create_reminder, list_reminders, cancel_reminder, todo_add, meeting_actions, todo_list, todo_done, run_python, mcp_list_tools, mcp_call`。
- 其上还会动态追加：`wf_<name>`（`wf_tools` 注册表里的用户自建流程）与 `client_tools`（客户端自带工具）；因此**工具总数不是固定值**，"16"只指静态表。
- 第 1 轮的 `serverTools` 会作为 `server_tools` 传入第 2 轮，保证工具面不会在循环中途缩小（同节点注释）。
- MCP 暴露 **17** 个工具（`n8n/workflows/mcp-server.json` 的 `Do MCP` 节点）：上述大部分 + `people_list, delegation_view, doc_create, doc_list, doc_get`。
- `todo_add` / `todo_list` 各带一个可选 `project`（slug 或 label）；工具**数量没变**，只是参数变宽。合法取值不额外开工具去查——`todo_list` 的响应里就带 `projects` 登记表，模型调一次列表即可自发现（与 `owner` 靠 `people` 字段自发现同一套路）。
- 工具循环上限由 `MAX_TOOL_ROUNDS` 控制，默认 2（`docker-compose.yml:59`）。
- Code 节点可用的外部模块：`pg`（`NODE_FUNCTION_ALLOW_EXTERNAL=pg`）、内置 `crypto`（`docker-compose.yml:63-67`）。
- `kb_search` 是**混合检索**（Agentic RAG）：pgvector ANN + ParadeDB BM25 两条腿用 RRF（k=60，按 `chunk_id` 融合）合并。规范模块 `n8n/lib/kb-hybrid.mjs` 因沙箱不能 import 而**逐字内嵌**进 `chat-gateway`(Execute Tool)、`kb-ingest`(Run KB Ops)、`mcp-server`(Do MCP) 三处，`kb-hybrid.test.mjs` 的漂移守卫盯着三份副本不许分叉。**降级是核心安全属性**：跑 BM25 前先做目录探测（`pg_extension`/`to_regclass`/`pg_proc`/`pg_operator`，缺则回 0/NULL 不报错，遵守 §9 第 13 条），`pg_search` 或 `kb_chunks_bm25` 索引不在就回退纯向量、排序与 top-k 与改造前逐字一致；返回里带 `retrieval` 标志（`hybrid`/`vector`）防静默空转。现网 Postgres 的 `pg_search` 只是 available、扩展未装，所以当前一律走向量、零回归。MCP 的 `score>0.2` 过滤只在向量模式保留（混合模式 score 是 RRF 值不是余弦）。工具**数量没变**。

## 5. 数据与状态

### 5.1 Postgres

- 镜像 `paradedb/paradedb:latest-pg17`，启动参数预加载 `pg_search,pg_cron`（`docker-compose.yml:156-164`；缺 `pg_cron` 会让全新卷启动失败，注释已记录）。
- 卷名是 `postgres_data_pg17`（`docker-compose.yml:696-698`），旧卷 `postgres_data` 留作回滚（`README.md:127-129`）。
- 此评测分支的 n8n Data Table 定义为 **26 张**（不是现网实存数量）：原 `n8n/scripts/deploy.mjs:46-315` 的 24 张，加 PR #8 在 320-353 行定义的 `eval_runs`（18 列）与 `eval_results`（12 列）。
  原 24 张为 `chat_messages, chat_executions, admin_audit, idempotency_records, kb_usage, daily_briefs, workflow_tools, topic_watch, todos, people, projects, tool_contract, mcp_servers, sandbox_approvals, documents, weekly_reviews, selfcheck_runs, heartbeats, telegram_state, reminders, ops_alerts, ops_alert_silence, gateway_keys, agenda_runs`。2026-11-10 本机 API 只读核验两张 eval 表尚未部署，见 §15。
- 实例上还可能有额外的 `cron_runs`（列 `job/period/ran_at/source`）：它**不在** `DATA_TABLE_COLUMNS` 里，是 `topic-watch` 与 `weekly-review` 的守卫节点在运行时「查不到就自己建」出来的，因此不受 `ensureColumns` 保护（`n8n/workflows/topic-watch.json` 的 `Already Ran Today` / `Mark Ran`）。
- 另有 `platform` schema（`CREATE SCHEMA IF NOT EXISTS platform`，`n8n/scripts/platform-schema.sql:7`），runtime 使用 `platform.requests / platform.events / platform.tool_runs`（`platform-runtime/server.js:133-230`）。事件总线试点另用两张：`platform.outbox`（事务 outbox，publisher 租约投递）与 `platform.consumed_events`（消费者幂等台账，PK `(topic, dedupe_key)`，consumer 启动自建；`n8n/scripts/platform-schema.sql:101-113`、`platform-runtime/event-consumer.js:25-37`）。
- `deploy.mjs` 只造 data table，**下面这些它一概不碰**，缺了得自己补：`vector` 扩展 + `kb_documents` / `kb_chunks`（`n8n/scripts/kb-schema.sql`，第一行就是 `CREATE EXTENSION IF NOT EXISTS vector`）、`ops_alerts`（`n8n/scripts/ops-schema.sql`）、`agent_memories`（`memory.json` 的 `ensureTable` 运行时自建，但它的 `embedding vector(1024)` 依赖上面那个扩展）、LobeHub 自己的 `lobechat` 库（由 LobeHub 容器首启时建，记忆镜像写它的 `user_memories`）。生产镜像 paradedb 自带 pgvector，`postgres:*-alpine` **不带**；本地用 alpine 镜像就必须自己补扩展，否则任何 `::vector` 都会让 Postgres 回错误响应，后果见 §9 第 13 条。
- `kb-schema.sql` 末尾另有一段 **guarded** 的可选 BM25 索引：`DO $$ … IF pg_available_extensions 里有 pg_search THEN CREATE EXTENSION + CREATE INDEX IF NOT EXISTS kb_chunks_bm25 … USING bm25 (chunk_id, content) WITH (key_field='chunk_id') … EXCEPTION WHEN OTHERS THEN RAISE NOTICE … $$`。装不上（缺扩展/没预加载/版本不符）只记 notice、不报错，留下纯向量检索；幂等可重跑。它是 §4.4 混合检索的 BM25 腿来源，运行时探测到它存在才会跑 BM25。vector 扩展与 HNSW 索引不动。现网验收（索引真建出来、中文分词排序、hit@1/MRR 增益）未测，见 `monitoring/kb-hybrid-search-2026-11-12.md`。

### 5.1.1 项目维度（`projects` + `project_ref`）

一个小型交付团队的活儿是**按项目**分的，所以 `projects` 是登记表、`project_ref` 是外键（按名字引用，不是数字 id）。

- `projects` 列：`name`（slug，唯一键，约定用仓库名）· `label`（人读的显示名）· `repo_url` · `customer` · `status`（`active|archived`）· `notes` · `created_at`。
- 建表由 `deploy.mjs` 负责，**行由 `n8n/scripts/seed-projects.mjs` 登记**（deploy.mjs 只造结构、从不写数据）。种子脚本幂等且**只填空**：已经非空的字段一律不动，所以机主手工填的 `customer` 不会被重跑覆盖；默认只报差异，`apply` 才写。
- 挂了 `project_ref` 的表：`todos`、`documents`。`reminders` **还没有**（提醒目前不按项目分）。
- 写入侧一律「必须已登记」：`admin/todos/add`、`doc-forge create`、`admin/report/health` 收到未知 slug 直接 400（`unknown_project`），归档项目 400（`project_archived`）——避免一个错别字凭空开出无人认领的项目。slug 与 label 都能匹配，存进去的永远是 slug。
- 读取侧：`admin/todos?project=<slug|label|none>`、`doc-forge action=list project=…`；响应里额外带 `projects`（登记表）与 `by_project`（分布），`none` 表示未归类。
- 今日议程（`daily-agenda`）把项目渲染成行尾 `[label]` 标签，机主与每个成员各自那一份都带；未挂项目的条目**渲染与加这个功能之前完全一致**；项目 label 参与指纹，所以改归属算「有变化」，会重新推送给相关的人。
- 对外验收报告（`audience=client`）把解析出来的项目 label 也塞进脱敏扫描目标——它和调用方传的 title 一样属于「外部可影响、又会出现在文档标题里」的数据（见 §4.2）。
- 维护入口有两个：`seed-projects.mjs`（批量、幂等、只填空）与控制台「协作 → Projects」页（`/dashboard/projects` → `/api/n8n/projects` → `GET admin/projects` / `POST admin/projects/manage`）。后者是 `platform-admin-api` 里克隆 `people` 那条链得到的 12 个节点，`create/update/archive/delete` 全部写 `admin_audit`；列表顺带算出每个项目的未完成 / 逾期 / 今日到期待办数与文档数，按未完成数倒序。
- **删除有引用保护**：`project_ref` 是按名字引用、没有数据库约束，所以 `delete` 会先数 `todos` / `documents` 里还有多少条指向它，非零就 `409 in_use` 并提示改用归档——否则那些记录会变成指向空气的孤儿引用。`name` 建后不可改，同一个道理。

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
| 事件总线（可选） | `PLATFORM_OUTBOX_*`、`PLATFORM_CONSUMER_GROUP`、`PLATFORM_CONSUMER_FROM_BEGINNING` | 仅 `event-bus-outbox` profile 生效；`PLATFORM_OUTBOX_WRITE_MODE` 保持 `off`（Runtime 不写 outbox）；指标端口 9101/9102 为容器内固定值（`.env.example`、`docker-compose.yml:559-617`） |
| 备份 | `BACKUP_INTERVAL_HOURS=6`、`BACKUP_MIN_AGE_HOURS=20`、`BACKUP_OFFSITE_DIR` | 新鲜度守卫（`.env.example:126-136`） |
| 控制台 | `CONSOLE_CLERK_PUBLISHABLE_KEY`、`frontent/.env.local` | 前者是构建参数（改后需重建镜像），后者被 compose 以 `required:false` 挂入（`docker-compose.yml:129-140`） |

## 7. 命令手册（全部可在仓库根执行）

```bash
# 启动 / 停止
docker compose up -d                 # 12 个常驻服务（需先创建 n8n-net 与 n8n_data）
docker compose --profile phase2 up -d platform-worker
docker compose --profile observability up -d prometheus
docker compose --profile event-bus up -d kafka
# Outbox + 幂等消费者试点（闭环验收脚本，细节见 deploy/event-bus/README.md）
powershell -File deploy/event-bus/outbox-pilot.ps1 -Action check
powershell -File deploy/event-bus/consumer-pilot.ps1 -Action check

# 工作流：源码 → 运行实例
N8N_URL=http://localhost:5678 N8N_API_KEY=<key> node n8n/scripts/deploy.mjs

# 校验（无网络，可在 CI 跑）
node n8n/scripts/validate-workflows.mjs

# 集成冒烟（需已部署实例）
N8N_URL=... CHAT_API_KEY=... node n8n/scripts/smoke-test.mjs

# 验收报告（把最近一次 selfcheck 结果转成文档；audience=client 走脱敏 + 签名链接）
curl -sS -X POST "$N8N_URL/webhook/admin/report/health" \
  -H "Authorization: Bearer $CHAT_API_KEY" -H 'content-type: application/json' \
  -d '{"audience":"client"}'

# 控制台本地开发
cd frontent && bun install && bun run dev        # http://localhost:3000
cd frontent && bun run typecheck

# 一次性接线
bash scripts/provision-bucket.sh                              # 建桶 + CORS
node n8n/scripts/lobehub-config.mjs                           # LobeHub ↔ 网关
N8N_URL=... N8N_API_KEY=... node n8n/scripts/seed-projects.mjs         # 只报项目登记差异
N8N_URL=... N8N_API_KEY=... node n8n/scripts/seed-projects.mjs apply   # 写入（幂等、只填空）
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
12. Code 节点设了 `mode: runOnceForEachItem` 就必须 `return { json: … }`，**不能**返回数组：数组形式不会报错，但会丢掉 `$('上游节点').item` 的配对（拿到的不是当前 item），于是一条 `Prepare Run Row` 这样的落库节点会静默写错行或什么都不写。多收件人链路（如 `daily-agenda`）依赖这个配对把每人的结果对回他自己那份。已在本地 n8n 2.37.7 实测：裸 item 形式配对正确，穿过 `httpRequest`（含 `onError: continueRegularOutput`）与 `dataTable` 节点后依然正确。

13. **Code 节点里的裸 `pg` 不能让 Postgres 回错误响应**：n8n 2.37.7 的 JS task runner 沙箱冻结了内置原型，而 `pg-protocol@1.15.0` 的 `DatabaseError` 构造时执行 `this.name = name`；类构造体是严格模式，给不可写的继承属性赋值会抛 `TypeError: Cannot assign to read only property 'name'`。它发生在 socket 的 data 事件里、不在任何 promise 链上，所以业务代码的 try/catch **接不到**，直接变成 uncaught exception：**整个 runner 进程退出**，当时在飞的所有 Code 节点一起挂——webhook 回 200 空 body、不落库、日志里只有 `InternalTaskRunnerDisconnectAnalyzer.toDisconnectError` 加一条 runner 重新注册（实测：selfcheck 因此连续三次跑出空 200，`selfcheck_runs` 一行没写，而同一次执行里无关的 `Platform Admin API` 也一起 error）。触发条件是**任意**服务端错误：缺表、缺 `vector` 类型、缺库、唯一键冲突、死锁、语句超时；同一坑的另一种形状早写在 `memory.json` / `lobehub-config.json` 的注释里（复用 SQL 占位符触发 "inconsistent types deduced for parameter $N"）。对策是**碰可选对象前先用目录探测**——`to_regclass('public.x')` 缺表回 NULL、`pg_extension` / `pg_database` 缺东西回 0，这些都不产生错误响应——再决定降级。7 个用 `pg` 的 Code 节点都已按此加固：`platform-admin-api`(Build Overview)、`kb-ingest`(Run KB Ops)、`chat-gateway`(Execute Tool)、`mcp-server`(Do MCP)、`memory`(Do Memory)、`weekly-review`(Run Review)、`lobehub-config`(Run LobeHub Config)。**残留风险**：探测只挡住「对象不存在」这一类，真发生死锁 / 超时 / 约束冲突时 runner 照样死；结构性解法只有改用 n8n 的 Postgres 节点（在主进程执行、不进沙箱）。

## 10. 控制台细节（frontent）

- **栈**：Next.js 16.2.12 App Router、React 19.2.4、TypeScript 5.7.2、Tailwind 4、shadcn/ui、Clerk 7、Sentry、zustand、TanStack Query/Table/Form、nuqs（`frontent/package.json:23-88`）。
- **鉴权**：`clerkMiddleware()` 只挂上下文（`frontent/src/proxy.ts:5-12`）；`/dashboard` 段在布局里 `await auth.protect()`（`frontent/src/app/dashboard/layout.tsx:20-22`）。
- **真实页面**（15 个导航项）：`overview, docs, knowledge, topics, briefs, projects, people, ai-chat, workflows, keys, alerts, models, settings, profile, notifications`（`frontent/src/config/nav-config.ts:36-169`）。
- **死路由 16 个**：`billing, chat, elements/icons, exclusive, forms/*, kanban, product, product/[productId], react-query, users, workspaces, workspaces/team` 都调用 `notFound()`（模板残留，`find frontent/src/app/dashboard -name page.tsx | xargs grep -l notFound`）。
- **死组件层已清除**（653→620，33 个文件）：上表那 16 个路由只是栅栏（保留 `notFound()`，防止有人把模板页重新接回来），它们背后的模板实现是无人引用的代码，已删：`features/{chat,kanban,forms,elements,react-query-demo}` 28 个文件、`features/knowledge/components/kb-search-card.tsx`（IA 文档早记为无引用死代码），以及随之失去最后一个调用者的 `components/ui/kanban.tsx`、`components/ui/file-preview.tsx`、`components/forms/demo-form.tsx`、`hooks/use-stepper.tsx`。核验口径：`git grep -n "features/(chat|kanban|forms|react-query-demo|elements)"` 在 `frontent/src` 内已无外部引用；`tsc --noEmit` 通过（并用一个故意的类型错误确认这道门不是空跑）。**没动** `package.json` 的依赖（`@dnd-kit/*` 现在无调用者，删依赖会牵动 `bun.lock` 与 CI 的 `--frozen-lockfile`，属另一次改动）；`frontent/scripts/cleanup.js` 仍列着这些文件夹，但它对缺失目录有 `fs.existsSync` 守卫（`cleanup.js:418`），所以只是文案过期。**同时悬空的模板文案（未改，属 vendored 文档）**：`frontent/AGENTS.md:126` 与 `frontent/README.md:142` 的目录树仍列 `react-query-demo`（两处本就受 D7「以本文件为准」的判定覆盖），以及 `frontent/.claude/skills/kiranism-shadcn-dashboard/SKILL.md:288` 与 `frontent/.agents/skills/.../references/forms-guide.md:223` 仍教人用已删除的 `@/hooks/use-stepper`——读到这两句时不要再去找那个文件。
- **API**：28 个 route handler；认证 cookie 由 Clerk 管理，前端不存 token。
- **环境变量**：`frontent/env.example.txt` 只有 Clerk/Sentry/`CHAT_API_KEY`；`N8N_URL`、`N8N_API_KEY`、`PLATFORM_RUNTIME_*` 由 compose 运行期注入（`docker-compose.yml:141-144`）或本地自行补进 `.env.local`。

## 11. 已知偏差与坑（写文档时已核对）

| 编号 | 现象 | 证据 | 影响 |
|---|---|---|---|
| D1 | README 说「8 个服务」/「9 个容器」，实际常驻 **12** | `README.md:9,60,177` vs `docker-compose.yml` | 按 README 数容器会漏掉 redis / stream-bridge / runtime / caddy |
| D2 | README 说 LobeChat 直接调 n8n；实际经 `stream-bridge` | `README.md:244-247` vs `docker-compose.yml:261,357` | 排查流式/工具问题会找错层 |
| D3 | 工具数：README 写 12，网关实际 16；MCP 17 | `README.md:31-32` vs `n8n/workflows/chat-gateway.json`、`n8n/workflows/mcp-server.json` | 计数类断言不可信 |
| D4 | 数据表：README 写 19，原 main 定义 24；本评测分支加两张 eval 表后为 26 | `README.md:51` vs `n8n/scripts/deploy.mjs:46-353` | 定义数不等于实例实存数，见 §5.1 |
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
| D16 | 断言数以代码为准：`selfcheck.json` 现有 **49** 条 `add()`（含新增的 `schedules fresh`；README 里同一个数写了 20 / 42 / 43 / 47 / 48 五种，全是历史运行输出），`smoke-test.mjs` 现有 **65** 处 `check()` 调用，而它打印的 `total` 只算实际跑到的 pass/fail，缺 env 时整组 SKIP | `n8n/workflows/selfcheck.json`、`n8n/scripts/smoke-test.mjs:51,268,350,423,451` vs `README.md:52,78,447,476-477,487,744,944,1096` | README 那些数字是历史运行输出，引用前先数代码 |
| D17 | doc-forge 的业务错误走 **HTTP 200**：只有 `Auth` 接了 `Respond Error`（真状态码），`Run Doc Forge` 的 `bad()` 直接进 `Respond Doc Forge`（`firstIncomingItem`），所以 `unknown_kind` / `not_found` / `unknown_project` 都返回 200 + `{__error:true,status,body}` 信封。MCP 的 `doc_create` 原来只判 `r.ok === false`，于是把失败报成 `Document #undefined (weekly) created: undefined` 且 `isError:false`（**已修**：现在要求 `r.id` 存在）；`doc_get` 因为有 `!r.html` 兜底一直是对的 | `n8n/workflows/doc-forge.json` 的 connections 与 `bad()`、`n8n/workflows/mcp-server.json` 的 `doc_create` | 集成方只看状态码会以为成功；新加 `bad()` 分支时必须同时检查调用方。**同形状、尚未修的一处**：`memory.json` 的 6 个 action 分支只有 `try/finally`、没有 `catch`，节点一抛错（例如 §9 第 13 条那个 pgvector 缺失守卫）webhook 就回 **200 空 body**，于是 selfcheck 的 `memory api` 只能报 `bad payload`，真因只留在执行日志里 |

## 12. 安全现状（必须知道）

- **残留凭证（历史，且现在公网可读）**：`a0bcb35`（2026-09-28）把真实 Postgres 密码写进 `scripts/check-users.mjs`，把真实 MCP Bearer token 与 Telegram chat id 写进 `demo-assets/_data.json`；`ce4a98b` 已从工作树移除，但**值仍在 git 历史**。仓库曾于 2026-10-29 翻私有，**2026-11-09 复核时已是 public**：匿名 `api.github.com/repos/myname173/agent-platform` 返回 200 且 `visibility:"public"`，匿名 `git ls-remote`（`GIT_TERMINAL_PROMPT=0`、清空 credential.helper）直接拿到 HEAD，`raw.githubusercontent.com/.../a0bcb35/scripts/check-users.mjs` 与 `.../a0bcb35/demo-assets/_data.json` 均匿名 200，且 `a0bcb35` 仍是 `main` 的祖先。处置=**轮换这些值**；删文件不算修好，翻私有也只是缩小暴露面、不撤销已公开的一个多月。是否重写历史由人决定（`git show ce4a98b`）。
- **当前工作树**：`bash scripts/secret-scan.sh` 报「检查了 32 个长值，命中 10 个」，键为 `CHAT_API_KEY`(12 字符)、`LOBECHAT_OPENAI_API_KEY`(12)、`LOBECHAT_ACCESS_CODE`(14)、`MINIO_ROOT_USER`(14)、`TELEGRAM_CHAT_ID`(10 位纯数字)、`PLATFORM_LAN_IP`/`LAN_IP`(各 15)、`PLATFORM_DOMAIN`(34)、`SANDBOX_URL`/`SANDBOX_APPROVED_URL`(URL 形状)。前两个是占位值、两个 URL 属噪声；但 `PLATFORM_DOMAIN`、两个 LAN 标识与 `TELEGRAM_CHAT_ID` 是真实基础设施标识，public 时等于公开，而 `LOBECHAT_ACCESS_CODE` 是「知道项目名就猜得到」形状的短值（长度 < 16 只进 cfg 档，闸门不拦，见 `monitoring/env-ledger-2026-11-05.md`）。`POSTGRES_PASSWORD`(32) 与 `MCP_API_KEY`(36) 在当前树**零命中**。通用特征扫描里 `gho_`/`ghp_`/`github_pat_`/`eyJhbGciOi` 的命中来自扫描器与校验器自身的正则/样例；`sk-[A-Za-z0-9]{20,}`、`AKIA[0-9A-Z]{16}`、`BEGIN … PRIVATE KEY`、`n8n_api_[0-9a-f]{40,}` 均 0 文件。
- **边界**：n8n webhook 用 `CHAT_API_KEY`；MCP 用 `MCP_API_KEY`（哈希存 `gateway_keys`）；runtime 用 `x-platform-runtime-key`；控制台用 Clerk；Sandbox 用 `x-sandbox-key`（`n8n/sandbox_server.py:514`）。K8s 沙箱网关（`n8n/sandbox_gateway.js`，镜像 0.3）在同一把 key 之上加了请求级准入：`x-sandbox-caller` 身份（仅计费/归因，不是鉴权）、每调用方令牌桶（默认 30 rpm / burst 10）、全局在飞 Job 上限（默认 4）、可选调用方白名单（`SANDBOX_ALLOWED_CALLERS`，空=放行并打标）；拒绝走 401/400/403/429 + 结构化日志 + `:8080/metrics` 计数器。状态在内存、按副本计；现网验收见 `monitoring/sandbox-admission-2026-11-12.md`。

## 13. 如何自行核验本文件

```bash
# 服务与端口
grep -nE "^  [a-z-]+:" docker-compose.yml

# workflow 数与 webhook 数
ls n8n/workflows/*.json | wc -l                          # 26
grep -ho '"path": *"[^"]*"' n8n/workflows/*.json | sort -u | wc -l   # 43

# 控制台路由与死页面
find frontent/src/app/api -name route.ts | wc -l         # 28
grep -rl "notFound()" frontent/src/app/dashboard --include=page.tsx | wc -l  # 16

# 数据表
grep -cE "^  [a-z_]+: \[" n8n/scripts/deploy.mjs         # 本评测分支 26，非现网表数

# §3 的目录文件数：只数受版本控制的文件（构建产物如 tsconfig.tsbuildinfo 不算）
for d in n8n frontent platform-runtime stream-bridge monitoring deploy scripts; do
  echo "$d=$(git ls-files $d | wc -l)"
done                                                      # 88 620 13 1 22 51 28

# 密钥闸门
node n8n/scripts/validate-workflows.mjs
bash scripts/secret-scan.sh --self-test
```

## 14. 多 agent 并行开发（本机两个运行时）

2026-11-09 起，这台机器上有两个 agent 同时在改本仓库。**位置已经隔开，但账户级的东西仍然共享**，违反下面几条会静默出错。

### 14.1 各自的位

| 谁 | workspace root | 用的 checkout |
|---|---|---|
| OpenClaw | `C:\Users\LINLEE\Desktop\openclaw-workspace`（配置键 `agents.list[].workspace`，文件 `C:\Users\LINLEE\.openclaw-autoclaw\openclaw.json`，agent id `agent-ag6dog`） | `openclaw-workspace\agent-platform-wt`，分支 `openclaw/*` |
| 用户 / Qoder | `C:\Users\LINLEE\Desktop\agent-platform`（仓库根） | 仓库根本身，分支 `docs/*`、`chore/*` 等 |

### 14.2 不要"修"它写回来的文件

OpenClaw 的 bootstrap 对标准文件是**无条件** `writeFileIfMissing`（`D:\autoclaw\resources\gateway\openclaw\gateway-bundle.mjs` 的 `ensureAgentWorkspace()`；补写点在**第 225453 行** `await writeFileIfMissing(agentsPath, agentsTemplate);`，模板目录 `D:\autoclaw\resources\gateway\openclaw\docs\reference\templates`，`AGENTS.md` 模板 8,240 B）。只要它的 workspace 指向仓库，删掉 `AGENTS.md` / `SOUL.md` / `HEARTBEAT.md` / `IDENTITY.md` / `USER.md` / `TOOLS.md` / `.agents/` / `projects/`，它就会在下一次 agent 或 session 初始化时按模板补回——实测间隔 **64 秒**（移走 15:38:03，重建 15:39:07）。`setupCompletedAt` 是一个提前返回的 bootstrap 状态判定，挡不住第 225453 行这次补写。

修法是改它的 `workspace` 配置，**不是删文件**。同理：**任何一方都不要把 `/AGENTS.md` 写进 `.gitignore`**——被 ignore 的未跟踪文件落在 merge 要创建的路径上时，git 会把它当可丢弃文件**静默覆盖**（已实测：8,109 B 的本地文件在一次 `git merge main` 后无声变成 40,076 B 的项目地图，exit 0，无任何提示）。

### 14.3 一个主题一个分支，一个集成出口

- 分支从 `main` 切，命名带自己前缀（`openclaw/…`）。不要在别人的分支上提交，不要替别人 merge PR。
- **不要 push `main`。** 集成只有一条路：push 分支 → PR → 两个 CI 检查（"Kiranism typecheck" + "n8n workflow validation"）→ 由用户决定合并。
- 提交身份各用各的，且都用 `git -c user.name=… -c user.email=… commit` 临时指定，**永远不要改 `git config`**。
- 用完的 worktree 自己 `git worktree remove` 清掉；分支 ref 留给人处置，不要 `branch -D`。

### 14.4 事实基准取 `main`，不取当前工作树

两个 checkout 不在同一个 commit 上：仓库根是用户的活动分支（可能落后 `main` 二十多个提交），另一个 worktree 在 `main` 上。数字对不上时，先确认两边量的是**哪棵树、哪个 commit**，再判断谁错。

已验证的实例（2026-11-09）：`n8n/workflows/*.json` 在用户分支 HEAD 是 **24**、`main` 上 **26**（main 新增 `daily-agenda.json`、`health-report.json`）；唯一 webhook path 是 **39** vs **43**；`frontent/src/app/api/**/route.ts` 是 **27** vs **28**，差的正好是 main 新增的 `frontent/src/app/api/n8n/projects/route.ts`。**两边都对。**

### 14.5 共享资源没有隔开，同一时刻只允许一方动

两个 worktree 共用同一个 `.git`，所以这些是共享的：

- `.git/hooks`、`.git/config`：改钩子对两边同时生效；
- `.env`（未跟踪，是现网运行栈的配置源）：**任何人不要编辑它**，`docker compose config` 会打印解析后的密钥值，不要拿真实 `.env` 跑；
- 整套 Docker 栈与现网：`deploy` / 重启容器 / 冒烟测试只能一方在跑，另一边会读到被改到一半的状态。

### 14.6 不要在仓库根 `git add -A`

仓库根的 ignore 规则要等用户把 `main` merge 进自己的分支才生效。在那之前 `.cluster/`（**23 MB**，含三个 Edge profile 的 `Login Data` / `Cookies` / `Web Data`）与 `DELIVERY/` 仍是未跟踪、未忽略的，**而远端是公开仓库**。用显式路径 add，不要 `git add -A` / `git add .`，也不要 `git add -f` 绕过 ignore。

### 14.7 配置归属

`agents.list[].workspace`、`protectedWorkspaceRoots` 等属于 OpenClaw 的运行时配置：改之前先备份原文件，只改目标键，改完核对其他键未动。注意 `protectedWorkspaceRoots` 目前指向它的新 home，**仓库根已不在保护列表里**——若想保留这层护栏，应当**追加**仓库路径而不是替换。

维护规则：任何结构变更（新增服务、workflow、route、数据表、环境变量）都应同步更新本文件对应章节，并更新 `verified_commit` 与 `verified_at`。

## 15. 评测分支接续（2026-11-10，未部署）

- 基点是 OpenClaw PR #8 的 `342959a`，接续分支 `fix/eval-readiness-20261110`。当前 26 条本地场景不是 60 条真实失败集；`ported_from` 是灵感标签，不是已核对的上游题目 ID，不能作为官方 BFCL/tau-bench/AgentDojo 成绩。
- `eval-contract.mjs` 为 `eval-run.mjs`、`eval-gate.mjs` 共用的断言实现；缺 trace、空答案、未实现断言、缺失/过期/不全的回放全部失败。`--dry --runs 3` 为 78 attempts、84 次网关请求，上游模型调用数取决于工具循环。`pass_1`、`pass_k`（全部 k 次成功）、`pass_at_k`（至少一次成功）分开；未完成批次不产生可比较的基线指标。judge 与最终数据库状态验收仍未完成，`--deterministic-only` 只做 shakedown，不能得到 `release_ready=true`。
- `eval-run --preflight` 只读。2026-11-10 本机健康端点在线，但两张 eval 表缺失、线上 Chat Stats API 尚无 eval 隔离。没有执行部署；全量 deploy 可能覆盖已存在的线上漂移，不要据此自动运行。live runner 要求显式 `--isolated-stack`，这是操作者确认，不会自动隔离数据；安全测试失败可能真执行创建/取消操作，不能拿共享业务库冒充 fixture。
- `eval-mine.mjs` 用实际验证过的 `nextCursor` 分页，排除 eval 流量，按 trace/时间关联消息、明确截断与近似关联，输出不可覆盖同日人工标注。默认 `.eval-local/candidates`；runner 原始报告/回放同在 `.eval-local`，目录已 ignore，人工脱敏前不得提交。
- CI 增加 `Eval offline contracts (not live acceptance)`，运行无密钥、无真实模型调用的正负回归；不是线上 26×3 已通过。回放仍需完整真实批次，不能造 fixture 让门禁绿。KB 的不可答题单列 pending，不混入检索分母；50 条 KB 查询也不能计入 26 条 Agent 场景来冒充凑齐 60。`kb-eval.mjs` 现支持 `--isolated-stack [--hybrid]`（`parseEvalFlags` 纯函数把关，顺序无关、拒重复/未知旗标）：两种模式都走 §4.4 那个规范 helper（带冻结语料 `docIds` 白名单），报告记 `requested_mode` 与 `retrieval_mode`——`--hybrid` 却报 `retrieval_mode=vector` 就说明索引/扩展没装、混合根本没跑。这是部署机上量「向量 vs 混合」hit@1/MRR 增益的尺子，本机只离线核验、未跑真实 embedding。
- 一次近三天只读挖矿已完成：2026-11-07 至 11-10 窗口内执行/消息/候选均为 0，扫描未截断；最新执行和消息仍为 11-02。零数据不是零失败。nightly 尚未安装，连续三天、60 条人工筛选、judge 真人校准、三批基线落库仍待验收。命令与边界见 `monitoring/README.md` 的 Evaluation foundation 节。
