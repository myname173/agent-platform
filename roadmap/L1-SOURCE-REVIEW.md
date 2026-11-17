# L1 只读源码核对（轻任务分流 + 自检测试桩）

> 核对日期：2026-11-11。**全程只读**：未修改 L1 相关任何文件、未部署、未重启、未跑集成冒烟、未触碰共享 `.env` / Docker 栈。
> 本文件只记录源码事实与待办，**不代表 L1 已验收通过**。证据格式为 `路径:行号`，均为当前工作树。

## 1. 核对范围与结论

| 项 | 结论 |
| --- | --- |
| 轻任务分流实现 | 已存在，请求级 `task_lane`（`auto` / `light` / `agent`）+ 硬编码正则规则，**侧车与网关各实现一遍** |
| 自检测试桩 | `n8n/scripts/selfcheck-test-stub.mjs`（未跟踪，169 行）已存在，纯离线、无网络、无第三方依赖 |
| 是否可独立验证 | **测试桩可**；**路由效果不可** —— 需重启 stream-bridge 容器、导入 workflow、执行 deploy 补列，均属共享栈操作，本轮未执行 |
| 是否需先部署共享环境 | 用户明确「不需要先部署到共享环境」；本轮零部署 |

## 2. 实现事实（F 标记，`[源码定义]`）

| ID | 事实 | 证据 |
| --- | --- | --- |
| L1-F1 | `routeTask()` 优先级：`model === 'deepseek-light'` → `light/model_alias`；`X-Task-Lane` 或 `body.task_lane` 为 `light`/`agent` → `explicit`；默认 `auto` 按「消息数 ≤2、无 tools、文本 ≤1600 字符、命中 `LIGHT_TRANSFORM_PREFIX`（翻译/总结/改写…）、且不含 `LIGHT_DYNAMIC_CUE` / `LIGHT_ACTION_CUE`」判定 `simple_transform`，否则 `default_agent`；非法值 400 `invalid_task_lane` | `stream-bridge/server.js:201-215,293-298` |
| L1-F2 | 网关侧规则等价，额外要求 `lastUser` 是最后一条消息，并有 `carriedReason` 兼容侧车回退带入的 `simple_transform` / `default_agent`；`light` 下 `tools_enabled=false` | `n8n/workflows/chat-gateway.json:25` |
| L1-F3 | `light` 上游：`deepseek-flash`、`thinking:disabled`、不带任何 tools、`max_tokens` 上限 512；`agent` 上游 `deepseek-v4-flash` + 服务端/wf/客户端工具 | `stream-bridge/server.js:24-25,334-350` |
| L1-F4 | 上游失败 / SSE 中断 / 出现 `tool_calls` → 回退到网关非流式全工具循环，请求体带 `task_lane` 与 `task_route_reason` | `stream-bridge/server.js:405-424,467-472` |
| L1-F5 | 结果与原因落库：`logTurn` → `stream-log.json` 读 `task_lane` / `task_route_reason` → `chat_executions` 新增两列 | `stream-bridge/server.js:419`；`n8n/workflows/stream-log.json:96`；`n8n/scripts/deploy.mjs:58,65-66` |
| L1-F6 | 配置：`.env.example:205-210` 声明 `UPSTREAM_LIGHT_*` 三个变量；`docker-compose.yml:266,270,364-368` 注入；LobeHub 模型列表新增 `deepseek-light` | 同上 |
| L1-F7 | stub 离线执行 `selfcheck.json` 的 `Run Selfcheck` Code 节点，用 `AsyncFunction` 注入 `$env/$input/$` 与 mock `helpers.httpRequest`，跑 healthy / degraded 两场景，输出 `mode: 'offline-stub-only'`，文件头明确「不报告运行中部署的健康状况」 | `n8n/scripts/selfcheck-test-stub.mjs:3-7,15-18,139-147,157-168` |
| L1-F8 | stub 断言：`output.total === 49`、`persisted === true`、`blockedHosts` 为空、healthy 负例不含 `n8n healthz`、degraded 含 `n8n healthz`；主机白名单固定，Data Table 写入进内存 Map | `n8n/scripts/selfcheck-test-stub.mjs:22-25,45-60,64-97,149-160` |
| L1-F9 | stub 与 `AGENTS.md:324`(D16)、`README.md:55,88` 的 49 条断言口径一致；**未接入 CI**（`.github/workflows/ci.yml:62-75` 只有 eval offline contracts） | 同上 |

## 3. 只读核对发现（不改造，仅登记）

1. **测试桩未覆盖轻任务分流**：stub 只跑 `selfcheck.json` 的 Code 节点，未引用 `routeTask` 或 `chat-gateway.json` 的分流逻辑；L1 路由规则目前**无离线回归**（`selfcheck-test-stub.mjs:15-18,139-147`；`README.md:87`）。
2. **无启停 / 回滚开关**：auto 规则硬编码在正则里（`server.js:201-203`、`chat-gateway.json:25`）；`README.md:760` 给出的「回退」是改 `OPENAI_PROXY_URL` 并重建 lobechat，不是开关级回滚。这与 `DECOUPLING-CONTRACT.md` R1/R5 的适用范围一致 —— L1 **会改变运行时行为**，若后续纳入 issue，应补开关与回滚方案。
3. **回退仍带 `light` 标记**：`server.js:470` 回退时传 `task_lane: body.task_lane || route.lane`，而 `chat-gateway.json:25` 在 `light` 下把工具置空（`tools_enabled=false`），与 `server.js:423` 注释宣称的「full gateway tool-loop fallback」不一致 —— **值得优先复核的行为差异**。
4. **auto 分流仅覆盖流式路径**：`server.js:666` 只有 `body.stream === true` 才进 `handleStream`；非流式走 `proxyGateway:270-277` 原样转发，仅由 `traceHeaders:90` 透传头。
5. **配置声明不完整**：`server.js:24` 的 `UPSTREAM_MODEL`、`server.js:14` 的 `UPSTREAM_BASE_URL` 未在 `.env.example` 声明，compose `:364` 把主上游地址硬编码；主模型名实际不可经 env 配置。
6. **命名口径差异**：侧车主上游默认名 `deepseek-v4-flash`，网关别名表所有别名的 `upstream` 为 `deepseek-flash`（`chat-gateway.json:25`）；`README.md:277` 用「按 Flash 价位计费」解释，但两处名字不同，排查时易混。
7. **桩 fixture 易漂移**：固定 15 张表 fixture、硬编码 49、`blockedHosts` 固定白名单；`AGENTS.md:324` 已记录断言数从 20/42/43/47/48 漂到 49。桩也不要求 49 项全绿（只验 `n8n healthz` 正负例，其余失败打印为 `otherFixtureFailures`）。
8. **文档自身矛盾**（`AGENTS.md:324` D16 已登记）：`README.md:55/88` 为 49，`:507` 48 项、`:764` 20 项、`:497` 47 项中 45 通过、`:964` 第 48 项、`:575` 43→44 项；`README.md:88`「daily at 04:15」与 `README.md:595` / `AGENTS.md:165` 的 `15 4,10,16,21 * * *`（每日 4 次）不符。
9. **「L1」名称歧义**：`n8n/workflows/lobehub-config.json:87,96` 的 `L1` 是「配置固化」节点前缀，与 `ISSUE-BACKLOG.md:82` 的 L1（分流 + 测试桩）不是同一事物。

## 4. 与共享运行环境的耦合（本轮未触碰）

- 测试桩**不耦合**：纯 Node、全离线、不报告部署健康（`selfcheck-test-stub.mjs:3-7,22-25,152,167`），可在本地独立运行。
- 路由效果**强耦合**：`docker-compose.yml:354-360` stream-bridge 以 `./stream-bridge:/app:ro` 只读挂载 → 改 `server.js` 需重启容器；workflow JSON 需导入 n8n；`deploy.mjs:65-66` 新增两列需执行 deploy 才落到表；LobeHub 模型列表改动需重建/重启（`README.md:760`）。`AGENTS.md:411-412,424` 明确全量 deploy 可能覆盖线上漂移、不自动执行。
- 因此：**离线桩能验证 selfcheck Code 节点控制流，但不能证明轻任务分流正确、两列已落地或 49 项自检真实结果**。这些结论须在隔离 / 协调窗口内部署后才有。

## 5. 本轮交付边界

- 已交付：只读源码核对、事实与发现登记、耦合面结论。
- 未交付（不得声称完成）：L1 验收、路由效果验证、CI 接入、开关与回滚方案、上述 9 项问题的修复。**未修改 L1 相关任何文件**（`stream-bridge/server.js`、`chat-gateway.json`、`stream-log.json`、`deploy.mjs`、`selfcheck.json`、`selfcheck-test-stub.mjs`、`.env.example`、`docker-compose.yml` 中 L1 相关行）。
