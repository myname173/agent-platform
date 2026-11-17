# 2026 行业对标（路线图排序依据）

> 调研日期：2026-11-10。**一手** = 已抓取原文逐段核对；**二手** = 仅搜索结果摘要，方向参考，落地前必须在具体 issue 内复核。
> 本文件只回答「为什么这样排序」，不替代 `DECOUPLING-CONTRACT.md` 的技术边界。

## 1. 一手证据

### 1.1 a16z《Big Ideas 2026: Part 1》
<https://a16z.com/newsletter/big-ideas-2026-part-1/> · 2025-12-09

| 作者 | 论点 | 对本项目的排序影响 |
| --- | --- | --- |
| Sarah Wang | **Systems of Record Lose Ground**：界面变成动态 agent 层，传统记录系统退化为商品化持久层，战略杠杆让给「控制员工实际使用的智能执行环境」的一方 | 对外交付的价值在「执行环境/控制面」，不在多加几张表；控制面优先于新工具 |
| Alex Immerman | **Vertical AI → Multiplayer**：2026 垂直 AI 进入多人模式，各方权限、工作流、合规不同；协作层成为护城河与网络效应 | 多租户不是「加一列」，而是权限 / 上下文 / 协作边界 → 独立控制面，且必须服务端强制 |
| Malika Aubakirova | **Agent-Native Infrastructure Becomes Table Stakes**：agent 流量递归、突发、海量；瓶颈在协调——路由、锁、状态管理、策略执行 | 复用 `platform-runtime` 已有锁 / 限流原语，不新造状态层；per-tenant 限流 scope 先于水平扩展 |
| Stephenie Zhang | **Creating for Agents, not Humans**：优化目标从视觉层级变为机器可读性 | 北极星看板要能自动出机器可读报告，而非只做给人看的图表 |
| Santiago Rodriguez | **The End of the Screen Time KPI**：转向结果定价，ROI 叙事最简单的公司跑赢 | 北极星选 TSR / 每成功任务成本 / 客户上线耗时，放弃 screen time 类指标 |
| Jennifer Li | **Startups Tame the Chaos of Multimodal Data**：数据熵（新鲜度、结构化、真实性衰减）是企业 AI 最大瓶颈 | KB / trace 的新鲜度与保留策略是交付准入，不是优化项 |

### 1.2 a16z《Can Agents Use a Computer Yet? We've Got the Data》
<https://a16z.com/can-agents-use-a-computer-yet-weve-got-the-data/> · 2026-08-10 · Fabrizio Serafini / Seema Amble / Eric Zhou

- OSWorld-Verified 一年内 42% → **85%**（人类约 72%），但原文强调「back-office work doesn't grade on a curve」——85% 意味着每 100 个任务仍有 15 个失败，**业务流程要求每一步都对**。→ 不能拿 demo 成功率当交付质量证明，必须有严谨评测。
- 原文核心判断：**模型不再是瓶颈，护城河上移到 context、permissions、process knowledge、validation、escalation、error handling、caching**。买家「为围绕模型的一切付费」，选择标准是「能否报告节省小时数、初级工程师能否运维」。→ 安全、评测、租户权限、一键部署优先于「换更强模型 / 加新工具」。
- 反复出现的生产模式：**agent 跑一次工作流 → 系统缓存成确定性代码 → 之后便宜重复执行 → 模型只在出错时回来诊断 / 修复 / 重新缓存**；成本随工作流生命周期下降。→ 对应 EPIC-F 的确定性工作流缓存。
- 定价 per task / per hour / per outcome；**COGS = 推理 + 重试（失败也烧 token）**。→ 计量必须计入失败尝试，账单才能对账。
- 安全治理清单：credentials、audit logs、data retention、prompt injection、permissioning。→ 合规检查单的直接来源。
- 适合落地的场景特征：**高频、重复、规则稳定、有即时机器可观测的成功证据、失败后果可容忍、升级路径清晰**。→ `ISSUE-0.2` 选旗舰场景的判据。

## 2. 二手证据（方向参考，须复核）

| 来源 | 要点 | 影响 |
| --- | --- | --- |
| Sequoia AI Ascent 2026 /《Services: The New Software》 | 卖完成的工作成果而非软件授权；垂直 AI 咬的是人力预算而非 IT 预算 | 计费按 task / outcome，不做纯席位订阅 |
| Andrej Karpathy（Cursor 官网引述） | 「最佳的 LLM 应用都应具备一个自主性滑杆，由你控制赋予 AI 多大的自主空间」 | 把 `MAX_TOOL_ROUNDS` 做成按档位可调，但有硬上限（EPIC-F） |
| 2026 agent eval / observability 实践 | 确定性门禁先上 PR（schema、工具签名、延迟 / token 预算、幻觉 canary）；稳定后第二 sprint 再上 LLM-as-judge rubric，且**必须 pin 住裁判模型与 rubric**，否则分数漂移会被误判为 agent 退化 | 与本项目 `eval-judge.mjs` 的 `PROMPT_VERSION` / `prompt_hash` / `MODEL_IDENTITY` 现状对齐，不重复造 |
| 同上 | **trace → eval flywheel**：生产 trace → 失败聚类 → 人工标注 → 写回离线集 → 跑评测 → 劣化告警；离线集一旦停止增长就退化成「记忆面」（prompt 被调去通过数据集） | 60 条**真实失败集**必须来自真实 trace，不能靠想象补充；`eval-mine.mjs` 已是这条链路的起点 |
| 同上 | tail-based sampling：100% 保留错误与高成本 trace + 正常路径采样；PII 脱敏与保留策略；单步 / 整轮 / 端到端三层评测 | EPIC-C 的 trace 采样与数据保留 |
| 同上 | 工具生态 LangSmith / Langfuse / Arize Phoenix / Braintrust / OpenTelemetry GenAI conventions | **明确不引入**：自托管与数据合规是本项目卖点，沿用自研 `eval-*.mjs` |
| 多份 2026 榜单 / 综述 | MCP 管「一个 agent 连工具与数据」（纵向），A2A 管「agent 之间发现、调用、流式协作」（横向），互补非竞争；MCP 1.0 移交 Linux Foundation | EPIC-F 兼容矩阵：现有 `mcp-server.json` 属纵向，A2A 属新增横向边界，不混为一谈 |
| 多份 2026 产品对比 | Cursor / Claude Code / ChatGPT Agent / Codex / Devin / Cline / Manus / Genspark / Salesforce Agentforce / Lindy；**编码 agent 最成熟，因为代码执行提供可验证反馈回路** | 旗舰交付场景必须选「成功可机器验证」的流程，而不是开放式问答 |

## 3. 由对标推出的优先级结论

1. **先证明可靠，再谈可分割售卖**：安全轮换 → 评测验收基线 → 之后才多租户。没有可信 TSR 与成本口径，多租户上线后的质量劣化无法归因，也无法给客户出 ROI 报告（1.1 / 1.2 一手）。
2. **是否做多租户控制面是待决项，不是已确认前提**：护城河在执行环境与协作层（1.1 一手），但「多家客户共用同一实例并互相隔离」**尚未经过试点验证**（AD-1）。若主要是每客户独立部署，优先级应是项目级管理 / 部署配置 / 验收，而不是先建 SaaS 身份与授权平台；`default deny` 只在确认为共享多租户后才是必要安全要求。
3. **计量是结果定价的地基**：按 task / outcome、含失败重试成本（1.2 一手）；**但 per-tenant 聚合必须等可信租户归属**，AD-1 前只定义四项业务计量语义（C0），不定实现方案。
4. **交付体验是产品的一部分**：「初级工程师能运维」是买家选择标准 → 一键部署 / 上线 runbook 与合规检查单是交付能力，不是文档收尾（1.2 一手）；独立部署形态下优先级更高。
5. **不加模型、不加工具、不做通用自主规划**：一手证据一致指向 harness / context / 治理，而非模型能力（也呼应 `README.md:1077-1082` 既有决策）。
6. **共享多租户是待验证假设，行业趋势不能替客户场景做决定**：a16z 的 multiplayer / 执行环境论点支持「协作层有护城河」，但**没有**说明本项目客户会共用实例。不能用行业方向反推「必须先建 D0 身份平台」。先用试点证据 E1–E4（`DECOUPLING-CONTRACT.md` §4.1）验证交付形态，绑定 M1 W6 书面结论；一手资料只用于给**已确定要做的事**排序。

## 4. 证据使用纪律

- 标注「一手」的仅上述两篇 a16z 原文，且只引用原文实际写到的内容。
- 二手条目全部作为**方向假设**，写进 issue 时必须注明「待复核」；任何对外材料不得把二手结论写成既定事实。
- 本项目成绩口径严格遵守 `AGENTS.md:409-414`：26 条本地场景不是 60 条真实失败集，`ported_from` 只是灵感标签，不能当 BFCL / tau-bench / AgentDojo 官方成绩；`--deterministic-only` 不产生 `release_ready=true`。
