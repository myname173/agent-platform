# 解耦契约（对外交付标准产品）

> 定位：同一套栈要交付给多个客户。**但「多家客户是否共用同一实例并互相隔离」尚未验证，是架构待决项 AD-1，不是已确认前提。**
> 硬约束（用户原话）：**「要注意解耦！」** —— 商业化能力不得侵入现有业务核心；每个任务可独立实现、独立验收、独立合并与回滚。
> 本文件只描述边界，不含排期；排期见 `ISSUE-BACKLOG.md`，排序依据见 `INDUSTRY-BENCHMARK-2026.md`。

**证据标记规则**：`F<n>` = 已验证事实（附路径:行号 + 核验范围）；`AD<n>` = 架构待决项（附决策所需证据/判据）。**两者不得混写**；把 AD 写成 F 是本契约最需要防的错误。

**核验范围分三类，必须分开写**：
- `[源码定义]` — 只读当前工作树源码，可复现；
- `[线上状态·文档自述]` — 引自仓库内 `monitoring/` 报告的历史只读核验记录，**本次未实测现网**；
- `[隔离环境实测]` — **尚未进行**，需 `EVAL-ACCEPTANCE-PRECONDITIONS.md` 的前置条件全部满足后才会产生。

本次修订为**只读静态核验**（2026-11-10），未运行 docker/git 对现网做实测。

---

## 1. 为什么必须先定边界

当前运行态是一台机器上的单机 Pilot（F8），且两个 agent 共用同一个 `.git`、同一个 `.env`、同一套 Docker 栈（F9）。任何"把租户字段撒进 26 个 workflow 与 24 张 data table"的侵入式改造，都会同时：阻塞现网（部署/重启/冒烟同一时刻只允许一方）、让回滚只能整体回滚、把"对外交付"和"本机 Pilot"绑成同一个失败域。

因此商业化能力做成**入口与数据面之间一层默认关闭的薄适配**；**但这层适配是否包含租户身份与授权，取决于 AD-1 的结论**。本轮不实现任何租户身份平台。

## 2. 分层（目标态，非本轮实现范围）

```mermaid
flowchart TB
    subgraph ENTRY[入口层 现有]
      LOBE[LobeHub / Console BFF / Telegram / MCP]
    end
    subgraph DECISION{AD-1 决策门}
      Q[试点验证：共享实例 还是 每客户独立部署?]
    end
    subgraph CONTROL[控制面 仅 AD-1 确认共享多租户后才设计]
      CP[最小身份到数据隔离链路 形态待决]
    end
    subgraph CORE[数据面 现有 业务逻辑保持不动]
      BRIDGE[stream-bridge]
      N8N[n8n 26 workflows]
      RT[platform-runtime]
      PG[(ParadeDB pgvector)]
      REDIS[(Redis)]
    end
    subgraph DELIVERY[交付面 新增 overlay 不依赖 AD-1]
      OV[版本固定 · external 资源 · 上线 runbook]
    end
    ENTRY --> Q
    Q -.确认为共享多租户.-> CONTROL
    Q -.确认为独立部署.-> DELIVERY
    CONTROL -.待决 不预先冻结.-> CORE
    ENTRY --> CORE
    DELIVERY -.叠加.-> CORE
```

**撤回**：上一版把 `TenantContext`（`tenantId/actorRef/plan/traceId/flags`）以及签名 `TenantAssertion`、全量 service principal 登记写成"唯一耦合点/已冻结契约"。这些属于 AD-2/AD-3 的**待决候选**，不是当前契约。理由是用户复核意见：面向小型 AI 产品与 Agent 落地团队，客户交付形态未验证就启动整套 SaaS 身份与授权工程，是在解决尚未出现的问题。

## 3. 已验证事实 F（只读核验，2026-11-10）

| ID | 事实 | 路径:行号 | 核验范围 |
| --- | --- | --- | --- |
| F1 | 12 常驻 compose 服务 + 3 可选 profile；26 可部署 workflow；43 唯一 webhook path；16 静态网关工具 / MCP 17 工具 | `docker-compose.yml:21-658`、`n8n/workflows/`、`AGENTS.md:26-49,131-145,178-184` | `[源码定义]` |
| F2 | 26 张 Data Table **定义**（24 原表 + `eval_runs` 18 列 / `eval_results` 12 列）；两张 eval 表**线上缺失** | `n8n/scripts/deploy.mjs:46-356`（`eval_runs:322-341`、`eval_results:342-355`）；`monitoring/README.md:110-115` | 定义 `[源码定义]`；线上缺失 `[线上状态·文档自述]` |
| F3 | `chat-stats-api.json` 的 `Build Stats` **源码已有** `const bizRows = rows.filter(r => String(r.client||'') !== 'eval')`，缺的是**部署**不是补代码 | `n8n/workflows/chat-stats-api.json:128`；`n8n/scripts/eval-run.mjs:77-80` | `[源码定义]` |
| F4 | 全仓 `tenant_id\|tenantId\|A2A` 仅命中 3 个非实现文件 → 无多租户、无 A2A 实现；MCP 已有 17 工具实现 | `demo-assets/_data.json`、`n8n/workflows/baseline/`、`frontent/skills-lock.json`；`n8n/workflows/mcp-server.json` | `[源码定义]` |
| F5 | `gateway_keys` / `chat_executions` / `platform.events` **无可信 tenant 归属**；`n8n-client.ts` 里 `userId\|clerk\|x-person\|x-tenant` **零命中** → 控制台多数 API 不向 n8n 传 Clerk 身份 | `n8n/scripts/deploy.mjs:47-93,288-308`；`frontent/src/lib/n8n-client.ts:1-11`；`platform-runtime/server.js:126-158` | `[源码定义]` |
| F6 | 43 个 webhook path **无 n8n 原生鉴权**，靠各 Code 节点比对 `$env.CHAT_API_KEY` → 裸租户头可被直连 webhook 伪造 | `AGENTS.md:134`；`n8n/workflows/chat-gateway.json:25`（`Parse & Validate`） | `[源码定义]` |
| F7 | 管理读缓存是进程内 `Map`（TTL 3000ms），**key 不含租户归属**；10 个 GET 的 key 在各自 `:11`；`nav-rbac` 只是客户端 UX，**非安全边界**；`n8n/health` 是唯一完全无鉴权读接口 | `frontent/src/lib/admin-read-cache.ts:17,19,26-30,56-67`；`frontent/docs/nav-rbac.md:7,23`；`frontent/src/app/api/n8n/health/route.ts:4-11`；`monitoring/management-read-cache-2026-10-30.md:68-70` | `[源码定义]` |
| F8 | `release_ready` 恒 false；校准需 ≥20 条**真人**标签 + kappa≥0.70；`--deterministic-only` 只是 shakedown；`--isolated-stack` 只是操作者确认、非技术沙箱 | `n8n/scripts/eval-run.mjs:216,264,274`；`n8n/scripts/eval-judge.mjs:23-24,203-218`；`monitoring/README.md:125-131,141-145` | `[源码定义]` |
| F9 | `a0bcb35` 真实凭证仍在 **public** git 历史（`ce4a98b` 仅从工作树移除）；处置 = 轮换；现网是单机 Pilot 非 HA | `AGENTS.md:326-330`；`monitoring/production-closeout-plan-2026-10-30.md:5-14` | `[源码定义]` + `[线上状态·文档自述]` |
| F10 | 现网与 `.git`/`.env`/Docker 栈由**两个 agent 共用**；不编辑 `.env`、不 `git add -A`、不 push `main`、不执行全量 deploy（会覆盖线上漂移）；部署/重启/冒烟同一时刻只允许一方 | `AGENTS.md:359-405,411` | `[源码定义]` + `[线上状态·文档自述]` |
| F11 | 行号漂移：backup 挂载 `.env` 实际在 `docker-compose.yml:617`（`AGENTS.md:321` 写的 `:547` 已过期）；`deploy.mjs` 的 `DATA_TABLE_COLUMNS` 是 `:46-356`（非 `:46-353`） | `docker-compose.yml:597-626`；`n8n/scripts/deploy.mjs:46-356` | `[源码定义]` |
| F12 | 备份 config bundle 把 `docker-compose.yml + .env` 打进 `config-n8n-data-*.tar.gz`，注释明写 self-contained restore；`restore.sh` 要求恢复包内 `.env` 落地 | `backup/backup.sh:8,65`；`migration/restore.sh:50-51` | `[源码定义]` |
| F13 | **隔离环境实测：尚未进行** —— 两张 eval 表未部署、Chat Stats API 线上无 eval 隔离、nightly 未安装、judge 未校准、60 条真实失败集未形成 | `monitoring/README.md:110-115,141-164`；`AGENTS.md:409-414` | `[隔离环境实测]` 尚未产生；现状为 `[线上状态·文档自述]` |

## 4. 架构待决项 AD（**不得预先冻结为方案**）

| ID | 待决问题 | 决策所需证据 / 判据 | 避免无限期悬置的门 |
| --- | --- | --- | --- |
| **AD-1** | **目标客户交付形态**：多家客户是否真的共用同一实例并互相隔离，还是通常按客户独立部署？ | 见 §4.1 试点证据清单 E1–E4 | **绑定 M1（W6）**：由人给出书面结论；未出结论不得启动 D0'/D1/C1/E1 |
| AD-2 | 若 AD-1 = 共享多租户：最小「身份 → 数据隔离」链路长什么样？是否需要签名断言？ | AD-1 结论 + 试点实际调用拓扑；F5/F6 决定不能靠裸头 | AD-1 确认后才评估 |
| AD-3 | 哪些内部调用（telegram-bridge、5 个定时任务、selfcheck/heartbeat/notify、eval runner、MCP、stream-bridge）确实需要独立身份？ | AD-1 结论 + 逐调用实际路径抽查 | 按实际调用逐个登记，**不预先全量清单** |
| AD-4 | A2A 是否实现？ | 租户授权边界（AD-2）明确后的兼容需求 | **移出半年必交** |
| AD-5 | 确定性缓存范围 | 纯读操作的实际命中率与成本收益 | **先限定纯读无副作用**（`kb_search`/`doc_get`/`list_*`），显式排除 `todo_add`/`kb_save`/`cancel_reminder` |

### 4.1 AD-1 试点证据清单（判据明确，防止悬置）

| 证据 | 采集方式 | 判据 |
| --- | --- | --- |
| E1 客户交付形态访谈 | ≥2 个真实客户/意向的书面记录：「是否接受与其他客户共用同一实例」 | 任一付费客户明确要求共享实例且接受逻辑隔离 → 进入 AD-2 |
| E2 合规 / 采购问卷 | 数据隔离要求（逻辑隔离 / 物理隔离 / 独立部署） | 出现「必须物理隔离或独立部署」→ 独立部署分支 |
| E3 实际工作流样本 | 抽查 `todos` / `documents` / `chat_messages` 是否会跨客户混写 | 无跨客户共池需求 → 独立部署分支 |
| E4 单客户运维成本 | 共享实例 vs 独立部署的部署 / 运维工时对比 | 独立部署 ≤ 1 人日 → 独立部署分支可行 |

**结论形态**（二选一，由人书面确认）：
- **独立部署为主** → 当前优先级 = 项目级管理 / 部署配置 / 验收；不建 SaaS 租户控制面；计量只做 `C0` 四项业务计量语义（无 per-tenant 维度、不定实现方案）。
- **共享多租户** → 才设计 `D0'` 最小身份 → 数据隔离链路；届时再评估签名断言、哪些内部调用需独立身份、是否 `default deny`。

## 5. 强制规则（R2 已改写、R4 已澄清）

| # | 规则 | 违反后果 | 校验方式 |
| --- | --- | --- | --- |
| R1 | 商业化能力**默认 feature-flag 关闭**；关闭时入口直连 n8n，与改造前逐字节等价 | 现网被未验证代码影响 | 关开关跑既有 smoke，逐字节比对 |
| **R2（改写）** | 数据面**业务逻辑**（工具循环、prompt、编排、26 个 workflow 的分支、现有 28 个 route 的既有分支）不改；**强制过滤点必须改**。新增能力优先新增文件 / route / overlay | 旧版「路由和工作流全不改」与 R4 逻辑冲突，无解 | PR diff 检查：改的是过滤点还是业务分支 |
| R3 | 计量旁路消费已有执行日志与 `platform.events`，不改 `chat-gateway.json:248` 的 `cost_usd` 计算 | 广撒网改动、牌价漂移 | 新增模块只读，不写 n8n data table |
| **R4（澄清）** | 若 AD-1 确认为共享多租户：`tenant_id` 必须进入 SQL 过滤、缓存 key、限流 scope、审计行，且建索引；单靠裸请求头**不能**形成安全边界，必须处理直连 webhook 路径，并 `default deny` 未归属请求 | 跨租户串数据（对外交付致命） | 跨租户负例集全绿、串数据计数 0 |
| R5 | 每个 issue 一个分支、一个默认关闭的 flag、独立验收、可单独关停回滚 | 无法灰度 / 无法定位回归 | PR 描述含「开关 + 回滚一行命令」 |
| R6 | **不编辑 `.env`、不 `git add -A`、不 push `main`、不执行全量 deploy**；eval 部署只在隔离环境 | 覆盖现网漂移 / 泄露真实密钥 | 部署走人工协调窗口 |
| **R7（新增）** | **AD-1 未出结论前，不实现** `tenants`/`tenant_members` 注册表、签名断言、全量 service principal 清单、逐请求验签、`default deny` 上线；也不把未确认租户结构写进 schema | 把「也许要做多租户」扩大成整套身份与授权工程 | 本轮产物中不含任何 tenant 表 / 断言代码 |

> **适用范围（用户复核修订）**：R1 的「默认关闭 flag / 逐字节等价」与 R5 的「每个 issue 一个 flag + 一行回滚」**只约束会改变运行时行为的 issue**。纯文档、口径定义、架构决策门，以及独立部署 overlay（只新增文件、不改基 compose 语义）**不必套同一套仪式**。给文档要求运行时开关是无意义的负担。

### 5.1 用户明确保留、不得回退的两项修正

1. **计量依赖可信租户归属**：`per-tenant 计量` 必须排在 `租户身份 / 成员关系 / 服务端强制隔离` 之后（F5：当前无可信 tenant_id）。`C0` 只定义四项业务计量语义（不预先选定队列 / 存储 / 事件结构）；`C1 per-tenant 聚合` 依赖 `D1`。
2. **R2/R4 冲突**：见上表改写。`default deny` 是**真正共享多租户系统**的必要安全要求，**不是**未经 AD-1 验证就启动整套控制面的理由。

## 6. 开关、灰度与回滚（本轮不实现控制面）

- 单一来源：`.env.example` 声明 → `docker-compose.yml` 注入 → 代码读 `process.env`（`AGENTS.md:273`）。**绝不写真实 `.env`**。
- 本轮已声明但**未启用**的开关：`PLATFORM_CONTROL_PLANE_ENABLED=false`、`PLATFORM_METERING_ENABLED=false`；它们只为后续 issue 预留，不代表控制面已存在。
- AD-1 确认共享多租户后，控制面才以客户 overlay 显式开启；回滚 = 删掉该环境变量并重启对应服务。
- 每个 issue 的 PR 描述必须写明「开关名 / 关闭后的等价行为 / 回滚一行命令」。

## 7. 性能与失败设计（**AD-1 确认后才适用的设计约束，非当前任务**）

- 控制面在热路径只做一次解析 + 配额检查，命中 Redis（`platform:` 前缀）为 O(1)，不查业务库、不产生 N+1。
- 计量写异步批量（复用 `platform:jobs` / Redis Streams），不在 HTTP 响应路径同步写库；失败进重试队列。
- 行级过滤下推 SQL、`tenant_id` 建索引；trace 用 tail-based 采样（错误与高成本 100% 保留）+ PII 脱敏。
- 评测 60×k 回放是有界离线开销，放 nightly。
- 已知瓶颈仍是 n8n 单实例 + Postgres 单点（F9）；若 AD-1 确认为共享多租户，先做 per-tenant 限流 scope 与锁，再谈水平扩展。

## 8. 共享栈冲突面与协作边界

`git status` 显示分支 `codex/light-task-routing-selfcheck` 有 12 处 MODIFY 与未跟踪 `n8n/scripts/selfcheck-test-stub.mjs`，另有 7 个 eval 提交（F10）。

- 新增文件优先；必须改共享文件时只用最小增量替换，禁止整文件重写。
- **我维护**：`roadmap/*`、`deploy/one-click/*`、`scripts/secret-scan.sh`、`searxng/settings.yml`；对 `.env.example`/`AGENTS.md`/`README.md`/`docker-compose.yml` 只做增量替换。
- **我不碰**：`n8n/scripts/deploy.mjs`、6 个 `n8n/workflows/*.json`、`stream-bridge/server.js`、`n8n/scripts/selfcheck-test-stub.mjs`，以及**轻任务分流 / 自检测试桩**这条用户侧接续工作。
- 部署 / 重启 / 冒烟 / `docker compose config` 同一时刻只允许一方执行；事实基准取 `main`（`AGENTS.md:383-387`）。

## 9. Explicit non-goals

不做生产 HA / 多节点 K8s（6.5C/6.5D）；不正式启用 Kafka / Outbox（6.5B）；不做通用自主规划（`README.md:1077-1082`）、不加 LoRA（`README.md:269`）；不重写 git 历史（§12 由人决定）；不新增第二个指标 exporter / Grafana；不把 26 条本地场景包装成 BFCL / tau-bench / AgentDojo 成绩（§15）；**不预先建设 SaaS 租户身份与授权平台（AD-1 未决）**；**半年内不实现 A2A（AD-4）**；**确定性缓存不扩展到有副作用的写操作（AD-5）**；**本轮不改共享运行环境、不执行真实凭证轮换**。
