# 半年实现计划 — Issue Backlog（对外交付标准产品）

> 唯一索引。定位 / 周期 / 交付口径来自用户澄清：**对外交付给多个客户的标准产品 / 半年战略 / 可执行开发任务 / 注意解耦**。
> 技术边界与证据分级见 `DECOUPLING-CONTRACT.md`（`F<n>` 已验证事实、`AD<n>` 架构待决项）；排序依据见 `INDUSTRY-BENCHMARK-2026.md`。
> 关键前提：**客户交付形态（共享实例 vs 每客户独立部署）是 AD-1 待决项**，不是已确认事实。P2 及以后多数任务以 AD-1 结论为门。

---

## 0. 一页架构视野

```
四个入口（LobeHub / Console BFF / Telegram / MCP）
        │
        ▼
  ┌──────────── 数据面（现有，业务逻辑保持不动） ──────────┐
  │ stream-bridge → n8n(26 workflows) → 16 静态工具循环     │
  │        └→ ParadeDB(pgvector) / Redis / RustFS(S3)       │
  │ platform-runtime：幂等 / 锁 / 限流 / 任务 / 指标         │
  └───────────────────────────────────────────────────────┘
        │
        ├── AD-1 决策门（试点证据 E1–E4，绑定 M1/W6 书面结论）
        │      ├─ 独立部署为主 → 项目级管理 / 部署配置 / 验收（不建租户控制面）
        │      └─ 共享多租户 → 才设计最小身份→数据隔离链路（AD-2/AD-3）
        │
        └── 交付面（新增 overlay，不依赖 AD-1）
               版本固定 · external 资源 · 上线 runbook · 合规检查单
```

已实现（可演示，F1）：对话与工具循环、RAG/记忆、待办/提醒/委派/项目维度、按人时区晨报、26 个 workflow、15 项控制台导航、备份与自检。
**未收口**（F2/F9/F13）：现网是单机 Pilot；eval 两张表未部署、judge 未校准；无多租户 / 计费 / 服务端 RBAC；历史真实凭证仍在 public git 历史。

## 1. 北极星指标（不用 screen time）

| 指标 | 定义 | 数据源 | 状态 |
| --- | --- | --- | --- |
| 可交付任务成功率 TSR | `pass_1` / `pass_k` / `pass_at_k`，**非自报** | `eval_runs` / `eval_results`（F2：表未部署） | 待 B1 隔离环境验收 |
| 每成功任务成本 | 含失败重试的 COGS / 成功任务数；**仅统计成本完整的成功任务，并同时报覆盖率 = 成本完整的成功任务数 ÷ 成功任务总数**（attempt 覆盖率仅作诊断，不混用） | `C0` 四项业务计量语义定义后才有 | 口径阶段，未实现 |
| 客户上线耗时 TTV | clone → health 200 → 首个任务成功 | 一键部署 overlay + runbook 计时 | 待 E3 |
| 跨租户串数据 | 恒等于 **0** | 负例集 + 审计日志 | **仅当 AD-1 确认为共享多租户才适用** |

> 指标定义本身不变，但**旗舰客户场景与据以验收的实际工作流以目标团队试点为准**，不由文档预设；「每日议程」只是现有内部验收样例（§5），不是旗舰客户场景。

## 2. 里程碑门槛（修订）

| 里程碑 | 周期 | 验收门槛 |
| --- | --- | --- |
| M1 交付准入 | W1–W6 | 凭证轮换 Runbook 完成（`A1a`）；**`A1b` 按用户决定不执行，风险保留登记，既不作为通过条件也不作为阻塞项**；`secret-scan` 零高危（第 5 项未轮换前不启用 `--strict`）；全新机器 30 分钟内 health 200；README 与代码数字一致；配置边界冻结；**AD-1 已有书面试点结论** |
| M2 质量证明 | W7–W12 | judge kappa≥0.70（**真人标签**）、60 条人工筛选真实失败集、nightly 三天绿、三批可比基线、`release_ready=true` 可达；**C0 四项业务计量语义已冻结（2026-11-10）**（不含 per-tenant 聚合、不定实现方案） |
| M3 商业化交付 | W13–W20 | **仅当 AD-1 确认为共享多租户**：串数据 0、28 个 route 服务端 RBAC、per-tenant 报表、billing 可出账、合规检查单通过；**若为独立部署形态**，则改为「项目级管理 + 部署配置 + 验收」通过 |
| M4 生态与指标 | W21–W26 | MCP 授权兼容矩阵、纯读缓存使重复任务成本下降、北极星报告自动生成；**A2A 不列为验收项**（AD-4） |

## 3. 执行顺序（修订）

```
P0  0.1/0.2 锚点 · A1a 配置加固 · A2 配置冻结 · AD-1 决策门
             · B1 隔离环境验收步骤整理（不部署）· L1 用户侧接续
                          │
P1  B2/B3 质量证明（需真人标签与隔离环境）· C0 四项业务计量语义（不含 per-tenant）
                          │
        ┌─────────────────┴─────────────────┐
        │ AD-1 结论（书面，绑定 M1）         │
        ├─ 独立部署为主 → E2/E3 部署体验优先 │
        └─ 共享多租户   → D0'→D1→D2→C1→E1   │
P3  F1 MCP 授权 / F2 纯读缓存 / F3 北极星（A2A 不做）
```

**顺序依据**：修正 1（计量依赖可信租户归属，F5）+ AD-1（售卖形态未验证，不预建控制面）。

## 4. Issue 清单

### P0 交付准入 + 不依赖 AD-1 的并行工作

| ID | 目标 | 真实文件 | 验收条件 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `0.1` | 核验改动面，产出契约 / backlog / 行业对标，加 F/AD 可追溯标记 | `roadmap/DECOUPLING-CONTRACT.md`、`ISSUE-BACKLOG.md`、`INDUSTRY-BENCHMARK-2026.md`；`AGENTS.md` §16 | F 附路径:行号 + 核验范围；源码定义 / 隔离环境实测 / 线上状态分开写；AD 附试点证据与判据；三份文档口径一致 | — | 本轮完成 |
| `0.2` | 整理现有内部验收样例（每日议程）与 SLA；**旗舰客户场景待试点工作流确定** | 本文件 §5 | 样例有机器可观测成功判据与失败升级路径；不预设旗舰客户场景 | — | 已定义 |
| `A1a` | 密钥加固 + 凭证轮换 Runbook（**仅配置与文档**） | `roadmap/CREDENTIAL-ROTATION-RUNBOOK.md`；`scripts/secret-scan.sh`（`--strict` 自检）；`searxng/settings.yml:40`；`docker-compose.yml:617` `no-new-privileges` | `secret-scan --self-test` 双向可判；`validate-workflows.mjs` 全绿；Runbook 含 7 项轮换清单与人工窗口 | 0.1 | 本轮完成 |
| **`A1b`** | **真实凭证轮换及依赖同步验证** | 目标凭证与其依赖（见 Runbook §2） | 原验收「7 项全部轮换 + 依赖同步验证」**按用户决定不执行**；不标完成、不再是必做阻塞项；**公开历史值仍可能有效，风险保留登记** | — | **按用户决定不执行（非完成、非阻塞）** |
| `A2` | 发布配置边界冻结 | `docker-compose.yml`（5 处 `:latest` 参数化）、`README.md` 数字与快速启动、`.env.example`、`deploy/one-click/bootstrap.ps1` | 全新机器不再因 external 资源缺失失败；`validate-workflows.mjs` 全绿；镜像 digest 定值待人工确认 | 0.1 | 大部分落地 |
| **`AD-1`** | **架构决策门**（试点验证，非实现任务） | `DECOUPLING-CONTRACT.md` §4.1 证据 E1–E4；`roadmap/AD1-PILOT-EVIDENCE.md`（采集模板） | 由人给出书面结论（共享实例 / 独立部署），绑定 M1 W6；未出结论不得启动 D0'/D1/C1/E1 | 试点客户 | **采集模板已备，待真实试点反馈；结论待决（W6）** |
| `B1` | **整理隔离环境 eval 部署验收步骤与前置条件**（不部署、不设计表） | `roadmap/EVAL-ACCEPTANCE-PRECONDITIONS.md` [NEW]；只读引用 `deploy.mjs:322-355`、`chat-stats-api.json:128`、`eval-run.mjs:63-81` | 前置条件清单与验收命令齐全；**无隔离目标时不执行任何部署**；不碰共享 `.env` / Docker 栈 / 全量 workflow 部署 | 0.1 | 本轮完成（仅步骤整理） |
| `L1` | 轻任务分流 + 自检测试桩 | `n8n/scripts/selfcheck-test-stub.mjs` 等用户侧接续文件 | **只读**源码核对完成，结论见 `roadmap/L1-SOURCE-REVIEW.md`；未改这些文件、未部署 | — | 只读核对完成（文件仍由用户侧维护） |

### P1 质量证明 + 计量口径（不含 per-tenant 聚合）

| ID | 目标 | 真实文件 | 验收条件 | 依赖 |
| --- | --- | --- | --- | --- |
| `B2` | 真实失败集 + 真人 judge 校准 | `eval-mine.mjs`、`eval-judge.mjs:203-250`、`n8n/eval/labels/calibration-30.json`、`n8n/eval/suites/*.json` | ≥20 条**真人**标签且 kappa≥0.70；60 条人工筛选真实失败集；裁判模型与 rubric 已 pin；`ported_from` 只作灵感标签 | B1 隔离环境 + 真人标注（**不可由 agent 代做**） |
| `B3` | nightly + 三批基线 + release gate | `eval-{run,gate,contract}.mjs`；`.github/workflows/eval-nightly.yml` [NEW] | 连续三天夜跑绿、三批可比 TSR/pass-k 基线入库、`release_ready=true` 可达；`--deterministic-only` 仍不产出 release_ready | B1,B2 |
| **`C0`** | **只定义四项业务计量语义**：什么算一次成本 / 失败重试 / eval 流量排除 / 牌价依据 | `roadmap/METERING-CONTRACT.md` | 四问口径无歧义且彼此不矛盾；口径限 **token 计费的上游调用**；`cost_usd` 为派生字段、遥测或牌价缺失记 unknown；任务内任一 attempt 成本未知则任务总成本视为不完整；平均成本覆盖率固定为「成本完整的成功任务数 ÷ 成功任务总数」，attempt 覆盖率仅作诊断；**重复投递不重复计费作为结果要求，本阶段不决定键或存储**；不含实现方案 / 租户结构，不建表不接运行链路；**业务口径已冻结（2026-11-10）** | 0.1 |
| `C1` | **per-tenant 计量聚合** | 待定 | 可按租户出「每成功任务成本」报表 | **AD-1 确认 + D1（可信 tenant_id）**，见修正 1 |

### P2 **仅当 AD-1 确认为共享多租户** 才启动

| ID | 目标 | 验收条件 | 门 |
| --- | --- | --- | --- |
| `D0'` | 最小租户身份与成员关系（此时才设计 `tenants`/`tenant_members`、是否签名断言） | 身份源单一、客户端不可伪造 | AD-1 书面结论 |
| `D1` | 服务端强制隔离（R2 改写后的**强制过滤点**）：`tenant_id` 列+索引、缓存 key 带归属、限流 scope、审计行 | 绕过前端直调 API 越权失败；串数据 0 | D0' |
| `D2` | 跨租户串数据负例集 + 合规证据 | 负例全绿，输出可作合规证据 | D1 |
| `C1` | per-tenant 计量聚合 | 报表可对账 | D1（F5：当前无可信 tenant_id） |
| `E1` | billing 可出账 | COGS 含失败重试 | C1, B3 |

### P3 交付与生态

| ID | 目标 | 验收条件 | 备注 |
| --- | --- | --- | --- |
| `E2/E3` | 一键部署 overlay + 合规检查单 + 上线 runbook | 客户上线 ≤ 1 天；换网络不需改 `LAN_IP` 后重建 lobechat | **独立部署形态下优先级更高**；只新增 overlay，不改基 compose 语义；配置与交付步骤已整理（`deploy/one-click/README.md`），**实际部署验收仍需隔离目标** |
| `F1` | **MCP 授权与兼容矩阵**（MCP 已有 `mcp-server.json` 17 工具） | 兼容矩阵有测试；租户授权边界清晰 | **A2A 移出半年必交（AD-4）** |
| `F2` | 确定性缓存 **仅纯读无副作用** | 仅限 `kb_search` / `doc_get` / `list_*`；显式排除 `todo_add` / `kb_save` / `cancel_reminder` 等写操作 | AD-5 |
| `F3` | 北极星看板 + 机器可读报告 | TSR / 每成功任务成本 / TTV / 隔离证据四项自动出报告 | 依赖 B3/C0/E3 |

---

## 5. 现有内部验收样例（非旗舰客户场景）

**样例：按人时区的每日议程投递**（`n8n/workflows/daily-agenda.json`，`AGENTS.md:158-174`）。它符合 a16z 一手判据「高频、重复、规则稳定、有即时机器可观测成功证据、失败后果可容忍、升级路径清晰」，且已有实现与落库，适合作为**现有内部验收样例**。

**它不是旗舰客户场景。** 旗舰客户场景、以及北极星指标据以验收的实际工作流，须以目标团队试点客户的工作流为准；在 AD-1 试点证据 E1–E4 到位前，本文件不预设对外旗舰场景，也不把内部样例的成功率当作客户 TSR。

| 维度 | 判据 |
| --- | --- |
| 成功证据（机器可观测） | 每个 active 且 role≠owner 的成员当天有且仅有 1 行 `agenda_runs`；机主 1 行；指纹去重命中 |
| 失败后果 | 可容忍：投递失败不落行，下一个半小时 tick 或次日重试（`AGENTS.md:172`） |
| 升级路径 | 成员无可用通道 → notify 降级投给机主并在消息尾部注明（`AGENTS.md:166`） |
| SLA | 投递成功率 ≥99%（按人×日）、重复投递 = 0、窗口外误投递 = 0、时区非法标 `tz_invalid:true` |

不选开放式问答 / 通用自主规划：成功无法机器判定，与 `README.md:1077-1082` 冲突。

## 6. todo 清单与 backlog 的对应关系（同步口径）

| todo id | 对应 issue | 标题语义 / 验收条件 |
| --- | --- | --- |
| `roadmap-backlog-contract` | `0.1` | 修订 roadmap 草稿；F 附路径行号+核验范围、AD 附试点证据判据；验收 = 三份文档口径一致 |
| `security-release-freeze` | `A1a` + `A1b` + `A2` | `A1a` 配置加固 / Runbook 与 `A2` 配置冻结已完成；**`A1b` 按用户决定不执行（非完成、非阻塞，风险保留登记）** |
| `eval-acceptance-loop` | `B1` | 整理隔离环境 eval 部署验收步骤与前置条件；无隔离目标则不部署、不碰共享 `.env`/Docker 栈 |
| `metering-plane` | `C0` | 只定义四项业务计量语义（成本单位 / 失败重试 / eval 排除 / 牌价依据）；`cost_usd` 派生、unknown 三态、重复投递不重复计费为结果要求；不做 per-tenant 聚合、不写未确认租户结构进 schema |
| `tenant-control-plane` | `AD-1` | 架构决策门：整理试点证据清单与判据，不预建租户身份平台 |
| `billing-compliance-delivery` | `E1/E2/E3` | （AD-1 决策后）billing 出账、合规检查单、一键部署 overlay；本轮未授权 |
| `ecosystem-metrics` | `F1/F2/F3` | （AD-1 决策后）MCP 授权兼容矩阵、纯读缓存、北极星看板；A2A 不做 |

> **completed 的语义限定（用户复核修订）**：本轮标为 completed 的 todo **只表示对应的文档 / 定义 / 决策门完成**，不表示运行时能力已落地 ——
> - `roadmap-backlog-contract` = roadmap 草稿修订完成；
> - `eval-acceptance-loop` = **B1 前置条件文档完成**，评测闭环未落地（无隔离目标，未部署任何表）；
> - `metering-plane` = **C0 业务计量语义定义完成**，计量链路未实现（无事件表、无写入代码）；
> - `tenant-control-plane` = **AD-1 决策门（试点证据清单与判据）完成**，租户控制面未实现（待 W6 书面结论）。

## 7. 立项与执行纪律

- 每个 issue 一个分支，从 `main` 切（§14.3）；PR → 两个 CI → 人决定合并；**禁止 push `main`**。
- **仅对会改变运行时行为的 issue**：PR 描述含开关名、关闭后等价行为、回滚一行命令、验收命令。纯文档 / 口径定义 / 架构决策门 / 独立部署 overlay（只新增文件、不改基 compose 语义）**不套同一套仪式**。
- 不得 `git add -A` / `git add .`（§14.6）；用显式路径 add。
- **同一时刻只允许一方**：deploy / 容器重启 / 冒烟 / `docker compose config`（§14.5）。
- `AGENTS.md` 结构变更须同步并刷新 `verified_commit` / `verified_at`（`:405`）。
- 评测原始报告留 `.eval-local/`（已 ignore），人工脱敏前不得提交（§15）。
- **本轮授权边界**：仅 roadmap 草稿修订与上述可独立推进的工作；**不代表授权改共享运行环境或执行真实凭证轮换**；继续避开轻任务分流与自检测试桩文件。

## 8. 明确不做什么

不做生产 HA / 多节点 K8s；不正式启用 Kafka / Outbox；不做通用自主规划、不加 LoRA；不重写 git 历史；不新增第二个指标 exporter / Grafana；不引入托管评测 SaaS；不把 26 条本地场景包装成官方 benchmark 成绩；**不预先建设 SaaS 租户身份与授权平台（AD-1 未决）**；**半年内不实现 A2A（AD-4）**；**缓存不扩展到写操作（AD-5）**；**AD-1 前不做 per-tenant 聚合、不把租户结构写进 schema**。
