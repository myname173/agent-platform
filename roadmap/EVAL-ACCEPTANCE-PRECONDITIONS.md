# B1 — 隔离环境 eval 部署验收：步骤与前置条件

> **当前状态（2026-11-10）：仅整理步骤，未执行任何部署。** 本轮授权不包含改共享运行环境；没有隔离目标时，B1 的交付物就是本文件，不是「验收通过」。
> 对应 `ISSUE-BACKLOG.md` 的 `B1`、`DECOUPLING-CONTRACT.md` 的 F2/F3/F8/F13。

## 0. 三条口径必须分开写

| 类别 | 内容 | 状态 |
| --- | --- | --- |
| **源码定义**（`[源码定义]`） | `eval_runs` / `eval_results` 两张表的 schema 已在 `n8n/scripts/deploy.mjs:322-355`；`chat-stats-api.json:128` 的 `const bizRows = rows.filter(... !== 'eval')` eval 流量隔离**源码已有** | 已核验，可复现 |
| **线上状态**（`[线上状态·文档自述]`） | 两张 eval 表缺失、线上 Chat Stats API 无 eval 隔离、nightly 未安装、judge 未校准（`monitoring/README.md:110-115,141-164`；`AGENTS.md:409-414`） | 引自仓库内报告，**本次未实测现网** |
| **隔离环境实测**（`[隔离环境实测]`） | `--preflight` 全绿、shakedown、replay gate、三批基线 | **尚未产生**；需 §1 全部前置条件满足 |

**B1 的任务是「在真正隔离的环境里部署与验收」，不是重新设计表，也不是补 `bizRows` 代码。** 把「源码已有」误当成「线上已有」、或把「离线契约绿」当成「线上验收通过」，都是 fail-closed 设计明确要防的误判。

## 1. 前置条件（全部 ☐，未满足前不得执行 §2）

| # | 前置条件 | 为什么 | 状态 |
| --- | --- | --- | --- |
| P1 | 独立的 n8n 实例 + 独立 Postgres / Redis（或明确快照），与现网数据、密钥**完全隔离** | `AGENTS.md:394-395` 两个 agent 共用同一套 Docker 栈；`monitoring/README.md:125-131` 明确 `--isolated-stack` **只是操作者确认、不是技术沙箱** | ☐ |
| P2 | 独立的 `.env`（**不复用共享 `.env`**），独立的 `CHAT_API_KEY` / `N8N_API_KEY` | `AGENTS.md:394`「任何人不要编辑 `.env`」；本轮授权也不含改共享环境 | ☐ |
| P3 | 与另一 agent 协调部署窗口，确认同一时刻只有一方在 deploy / 重启 / 冒烟 | `AGENTS.md:394-395` | ☐ |
| P4 | 只向隔离实例建两张 eval 表；**不跑全量 `deploy.mjs`** | `AGENTS.md:411`「全量 deploy 可能覆盖已存在的线上漂移」；`deploy.mjs:1485-1487` 会遍历全部 26 张表 | ☐ |
| P5 | 只把 `chat-stats-api.json` 的 eval 隔离部署到隔离实例 | 线上 workflow 部署属于改共享运行环境 | ☐ |
| P6 | 确认安全用例的副作用范围：注入失败可能真创建 / 取消业务记录 | `monitoring/README.md:125-127`，不能拿共享业务库冒充 fixture | ☐ |
| P7 | 评测原始报告 / 回放落到已 ignore 的 `.eval-local/`，人工脱敏前不提交 | `AGENTS.md:412`；远端是 public 仓库 | ☐ |

> **硬边界**：不碰共享 `.env`、不碰共享 Docker 栈、不做全量 workflow 部署。这三条与本轮用户授权一致。

## 2. 验收步骤（**仅在 §1 全部满足后执行**，本轮不执行）

```powershell
# 0) 只读 preflight：检查必需表/列与 active Chat Stats API 的 eval 隔离
node --env-file=<isolated-env> n8n/scripts/eval-run.mjs --preflight
#   期望 ready=true；缺两张表或线上无隔离都要报 problems（eval-run.mjs:63-81）

# 1) 只在隔离实例创建 eval_runs / eval_results，并部署 chat-stats-api 的 eval 隔离
#    （具体命令由隔离环境的部署方式决定；禁止全量 deploy.mjs）

# 2) 再次 preflight，确认业务统计排除 eval 流量
node --env-file=<isolated-env> n8n/scripts/eval-run.mjs --preflight

# 3) 离线契约（无需隔离栈，可先跑，但结果不等于验收）
node n8n/scripts/eval-validate.mjs
node n8n/scripts/eval-run.mjs --dry --runs 3
node --test n8n/scripts/eval-contract.test.mjs n8n/scripts/eval-mine.test.mjs n8n/scripts/eval-judge.test.mjs n8n/scripts/kb-eval.test.mjs

# 4) shakedown（26x3 = 78 attempts / 84 网关请求，仅隔离实例）
node --env-file=<isolated-env> n8n/scripts/eval-run.mjs --isolated-stack --deterministic-only --runs 3 --record

# 5) 回放门禁
node n8n/scripts/eval-gate.mjs --replay-dir .eval-local/replay/<run-id> --runs 3
```

**验收判据**：
- `--preflight` 全绿、业务统计排除 eval 流量；
- DB 持久化 read-back 校验通过（`eval-run.mjs:159-189`）；
- `pass_1` / `pass_k` / `pass_at_k` 分列、缺 trace / 空答案 / 未实现断言 / 回放不全全部失败（fail-closed）；
- `--deterministic-only` **不得**产出 `release_ready=true`（`eval-run.mjs:264,274`）；
- `release_ready=true` 需要 judge 质量与最终 DB 状态验收完成 —— 属于 `B2/B3`，不是 B1。

## 3. Judge 校准：只用真人标签

> **样本现状（2026-11-11 只读核查）**：工作树**无 `.eval-local` 目录 / 回放文件**；`n8n/eval/labels/calibration-30.json` 共 30 行，前 20 行 `human: null` 且 `task` / `answer` 为「shakedown 后自动填充 / 待回填」占位，后 10 行 `MANUAL:` 的 `task` / `answer` 为「手写一个…」占位（`eval-judge.mjs:196-200` 的 `placeholder()` 会判为占位）→ **有效真人样本 = 0**。我这边**没有既有真实回放可提供**，也不会用占位内容凑数或代真人打分。需先由隔离 shakedown 产出真实任务—回答对，再由真人按正确性打 1–5 分、≥20 条有效样本。

- `eval-judge.mjs:203-218` 在**发起任何裁判请求之前**要求 ≥20 条真实、非占位的人标；`calibration-30.json` 当前 30 行全是「待回填 / human:null」，**不是校准数据**。
- `eval-judge.mjs:221-250` 要求 quadratic weighted kappa ≥0.70，且明确标注「统计校准检查不是 release-gate 批准」。
- `MODEL_IDENTITY.status = 'unverified'`（`eval-judge.mjs:25-28`），别名不同不等于实际模型不同。
- **真人标注不可由 agent 代做**；不得用占位骨架、自动打分或想象样本凑数。裁判模型与 rubric 必须 pin（`PROMPT_VERSION` / `prompt_hash`，`eval-judge.mjs:22,45`）。
- 60 条真实失败集必须来自 `eval-mine.mjs` 的真实生产 trace 并经人工筛选；`ported_from` 只是灵感标签，不能当 BFCL / tau-bench / AgentDojo 官方成绩。

## 4. 与后续 issue 的边界

| 后续 | 依赖本文件 | 说明 |
| --- | --- | --- |
| `B2` | 真人标签 + 真实 trace | 需隔离环境与人工投入，本轮不启动 |
| `B3` | 完整脱敏回放 fixture + 三批基线 + nightly 连续三天 | 不能造 fixture 让门禁绿（`AGENTS.md:413`） |
| `C0` | 无 | 四项业务计量语义定义不依赖隔离环境，可独立推进 |
| `AD-1` | 无 | 客户交付形态决策门，与 eval 验收并行 |

## 5. 本轮交付与未交付

- **已交付**：前置条件清单、验收命令与判据、Judge 校准口径、硬边界。
- **未交付（不得声称完成）**：两张表部署、eval 流量隔离上线、`--preflight` 结果、shakedown、replay gate、基线、`release_ready`。原因：无隔离目标，且本轮授权不含改共享运行环境。
