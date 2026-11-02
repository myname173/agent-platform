# Phase 6.4 管理读链路优化（2026-10-30）

## 结论

当前管理读请求的主要瓶颈在 n8n 工作流编排和 Data Table API/内存聚合，不是当前规模下的 PostgreSQL 单条查询。Console 的一个总览页面会并发访问 overview、stats、settings、todos 和 people；多个用户同时打开页面时，这些相同的只读请求会重复触发 n8n 执行。

本阶段先落地 Console 服务端短 TTL 读缓存：

- 默认 TTL 3 秒，可由 `CONSOLE_ADMIN_READ_CACHE_TTL_MS` 调整。
- 同一个 key 的并发请求共享一个上游 Promise，避免请求风暴。
- 只缓存成功结果；上游异常和非 2xx 不入缓存。
- 管理写操作成功后主动失效 people、todos、keys、alerts、briefs 对应缓存。
- 返回 `X-Admin-Read-Cache: hit|miss`，便于 Console 验证命中情况。
- 浏览器仍保持 `Cache-Control: private, no-store`，缓存只存在于 Console 服务端进程。

覆盖的主要读接口：`overview`、`stats`、`settings`、`people`、`todos`、`alerts`、`keys`、`models`、`briefs`。

## 副作用边界

本切片没有改 n8n 工作流、Postgres 表结构、Redis 状态、Kafka/Outbox 或业务写接口。读数据最多短暂滞后 3 秒；待办、人员、密钥、告警和晨报的 Console 写操作会立即清除本进程对应缓存。其他入口（例如聊天工具写待办）依赖短 TTL 自然收敛。

该缓存是单个 Console 进程内的 L1 缓存，不宣称多副本共享一致性；在扩展 Console 副本前应切换为 Redis 共享读缓存或保留更短 TTL。

## 验证

- `npm run typecheck`：通过
- `npm run check:boundary`：通过
- `npm run build`：通过
- Console Docker 镜像：构建成功并启动
- `GET /`：200
- 未登录 `GET /api/n8n/overview`：401（登录边界未改变）
- n8n `/healthz`：200
- Platform Runtime `/readyz`：200
- 缓存语义 smoke：并发两次 loader 只执行 1 次；缓存读取命中；`todos:*` 前缀失效会清除全部负责人筛选 key

## 真实浏览器验证（2026-10-30 补，已登录态）

方法：登录后在页面上下文里 `fetch` 同源接口，读到的就是 Network 面板会显示的同一份响应头
（同一个 Cookie、同一个 route handler）。用脚本而不是开面板，是因为工具侧的网络列表接口不返回
响应头，而且这一步需要精确控制两次请求的间隔。环境是本地 Docker Desktop 的 `platform-console`
容器；这份未提交的工作区改动确实已经跑在现网：容器内 `/app/.next` 有 10 个 chunk 含
`X-Admin-Read-Cache`，`CONSOLE_ADMIN_READ_CACHE_TTL_MS=3000`。未登录基线仍是 401 且无缓存头。

| 步骤 | 结果 | 判据 |
| --- | --- | --- |
| overview 首次 | `miss`，385 ms，`generated_at=04:34:50.922Z` | — |
| overview +443 ms 再读 | `hit`，18 ms，`generated_at=04:34:50.922Z`（与首次完全相同） | 命中且真的复用同一次上游结果 |
| stats 首次 / 再读 | `miss` 215 ms → `hit` 14 ms | key 独立，overview 的命中没有让 stats 直接变 hit（证明不是全局缓一份） |
| people 并发两次 | 一条 `miss` + 一条 `hit`，两侧耗时都是 ~317 ms | 单飞共享上游 Promise：只有一次上游，第二侧是等同一个 Promise，而不是各打一次 |
| 静置 >TTL 后再读 overview / stats | 双双回到 `miss`，`generated_at` 变成 `04:34:55.749Z` | 缓存会过期，不会长期钉住旧数据 |
| 过期后紧接着再读 | `hit` | 会重新填充 |

所有响应都带 `Cache-Control: private, no-store`，浏览器侧没有第二层缓存 —— 命中只可能来自 Console 进程内那份。

## 一轮小规模上游控制组

时间：2026-10-30 05:01:42–47 UTC。直接对 n8n 只读管理接口运行现有 `e2e-business-load.mjs`，每个接口 5 次、并发 2，共 25 请求；这轮用于观察未经过 Console L1 缓存时的上游基线。

- 25/25 成功，HTTP 200，传输错误 0，响应形状错误 0
- 模型调用 0，业务写入 0
- p95：stats 416.64ms、overview 535.35ms、settings 503.16ms、people 561.13ms、todos 665.87ms
- Docker 快照：n8n `0.19% -> 0.23%` CPU，Postgres `0.53% -> 0.34%` CPU，Console `0.01% -> 0.00%` CPU；内存变化在单轮样本范围内，无异常增长

这轮只作为上游控制组；结合前面的 Console `miss -> hit` 实测，命中请求不会再次进入这些 n8n 管理工作流。

没测的：**写操作后的主动失效**（要真改待办/人员/密钥等业务数据才能观察，本轮没动业务写接口）、
以及同一时间窗内 n8n execution 数与 CPU 的对比。另外记一笔设计约束：除 `todos` 用
`todos:<owner>` 前缀 key 外，其余 8 个接口都是扁平 key，而这个缓存不区分登录用户 —— 当前这批返回的
都是平台全局数据所以安全，将来凡是"按用户/租户过滤"的只读接口必须像 `todos` 一样把归属写进 key，
否则会跨会话串数据。

## n8n 上游侧对比（2026-10-30 补）

Console 的 `X-Admin-Read-Cache` 只是表象，真正的收益要数 n8n 那边执行了几次。两个上游都是
**webhook**，所以每次上游都会留下一条 execution，可以直接计数：

- `GET /webhook/admin/overview` → workflow **Platform Admin API**（`sWZhrp1Dp567JsnR`，它还同时服务
  keys / alerts / settings / models / briefs / people / delegation，即 9 个缓存读里有 8 个共用这一个 workflow）
- `GET /webhook/v1/stats/executions` → workflow **Chat Stats API**（`uxpuK2mBgwtxAsYM`）

计数方法：`GET /api/v1/executions?workflowId=<id>`（按名字解析 ID，不写死），按 `startedAt`
与我的请求时间对齐；execution id 是全局递增的，Reminders / Telegram Bridge 两个轮询工作流每小时
各产生 ~119 条，所以**窗口内 id 差值不可用于归因**，必须按时间戳逐条对齐。

| 项目 | 实测 |
| --- | --- |
| 10 个请求（5×overview + 5×stats）背靠背 | n8n 只新增 **2** 次执行（每个 workflow 各 1） |
| 第二轮同样 10 个请求 | 同样只新增 2 次，时间点精确落在请求秒（01:49:25.773 / 01:49:26.346） |
| overview 延迟 | miss 271 / 513 ms → hit 14–29 ms |
| stats 延迟 | miss 190–244 ms → hit 13–27 ms |
| 载荷一致性 | 同一批 5 个响应的 `generated_at` 完全相同（`distinct_gen=1`） |

**TTL 与前端刷新间隔的关系（这条会决定优化值不值）**：3 秒 TTL 只能吸收*并发*的重复请求，
吸收不了*周期*性刷新——只要客户端刷新间隔大于 TTL，每次刷新都会打上游。我用 ~5 秒间隔发出
4 组相同请求做对照，结果每组都产生一条新的 execution（01:46:56 / 01:47:01 / 01:47:06 / 01:47:11），
而同一组内背靠背的 5–6 个请求只产生 1 条。`operations-dashboard.tsx:383` 的自动刷新是 15 秒，
所以要让这层缓存真正降低 n8n 负载，`CONSOLE_ADMIN_READ_CACHE_TTL_MS` 必须**大于**前端刷新间隔
（或改用 stale-while-revalidate 让刷新走后台更新），否则它对单用户周期刷新是零收益。

CPU 在这个规模测不出差别：采样时 `n8n` 0.10%、`platform-console` 0.00%（内存 483 MiB / 114 MiB）。
也就是说本切片的收益目前只能以「每页请求数 → n8n 执行数」和响应延迟来论证，不能以 CPU 论证。

两条观测性与可靠性提醒：

1. `hit` 的语义比名字宽。`admin-read-cache.ts` 里两条路径都返回 `hit: true`——命中未过期的值，
   以及并发加入同一个 `pending` Promise。所以 `X-Admin-Read-Cache: hit` 不等于"这是一份旧数据"，
   在算命中率时它把"请求合并"也算进去了。
2. 过期判断依赖墙上时钟（`Date.now()`）。本次验证期间宿主机时钟向前跳了约 45 小时；向前跳会让
   条目立即失效（安全），但 NTP 向后校正或 Docker Desktop 的 VM 暂停/恢复会让"3 秒缓存"实际存活
   数小时。这层缓存要稳，应改用单调时钟（`performance.now()` / `process.hrtime`）计算 TTL。

## 下一步

用已登录 Console 做一次 2-5 秒内的重复读验证 —— 已完成（见上一节，`miss → hit`、payload 同源、
并发单飞、过期回落全部成立）。剩下的对照是同一时间窗口 n8n execution 数和 CPU；若仍是主要瓶颈，
再把 `chat_executions` 聚合下沉为定时快照/直接 SQL 读模型；本阶段不提前引入该结构性改造。
