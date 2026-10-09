# 本机部署记录（2026-10-03）

> 这份文件记录的是"在这台机器上把它跑起来"实际做了什么、改了什么、还剩什么。
> 不属于原仓库内容，可以随时删除。

## 当前状态（2026-10-04 12:1x 更新）

**10 个容器全部在运行**：`postgres` `n8n` `minio`(RustFS) `searxng` `n8n-sandbox` `lobechat`
`stream-bridge` `platform-backup` `console` `caddy`。
**DeepSeek 已接通、Telegram 已接通**，两条链路都做了端到端实测。

`console` + `caddy` 已于 2026-10-04 构建成功（耗时 **3 分 23 秒**）。
上一次失败是宿主内存不足，这次的解法：**先临时停掉另一个项目（fastapi-langgraph）的 9 个容器**
（含 `vllm`，单它一个就占 1.85 GiB），Docker VM 内空出约 4.5 GB，构建完再原样启回来。
> 如果以后再遇到构建 OOM，用同样的办法：`docker stop` 另一个项目的容器 → 构建 → `docker start`。

`stream-bridge` 已重建（它之前 Up 15 小时，是在 `.env` 填 Key **之前**启动的，
容器里读不到新变量）。重建后 `/healthz` 四项全绿：`upstream:true embeddings:true voice:true`。

**DeepSeek 接入已完成**（详见 4.1.1）：
- `.env` 的 `UPSTREAM_API_KEY` 已填，实测 `https://api.deepseek.com/models` 返回 200。
- n8n 凭据 `DeepSeek account`（`type=deepSeekApi`，id `dscredV4flash01`）已用 `import:credentials` 建好。
- `node n8n/scripts/deploy.mjs` 重跑成功，**不再报 `no credential deepSeekApi`**。
- 端到端实测：`POST /v1/chat/completions` 返回 `{"content":"成功"}`，响应 id 带 `-n8n-` 前缀
  → 确认走的是 n8n 网关（即凭据真正生效）。

**Telegram 接入已完成**（详见 4.1.2）：
- Bot `@No1MyAgentBot`（id `8579709762`）；`TELEGRAM_CHAT_ID=7020739140`；`ALERT_WEBHOOK_FORMAT=telegram`。
- 端到端实测：用户在 Telegram 发消息 → bridge 执行结果
  `{"processed":1,"sent":2,"sendFailed":0}` → **bot 已成功回复**。

**模型名核对结果（重要）**：你的账号 `/models` 只列出 `deepseek-flash`（显示名 DeepSeek-V4.1-Flash）
和 `deepseek-v4-pro`。但实测 DeepSeek **会把别名静默映射**，以下全部返回 200 正常补全：

| 请求的模型名 | 实际落到 |
| --- | --- |
| `deepseek-v4-flash`（平台默认） | `deepseek-flash` |
| `deepseek-flash` | `deepseek-flash` |
| `deepseek-v4-pro` | `deepseek-v4-pro` |
| `deepseek-chat` / `deepseek-reasoner` | `deepseek-flash` |

→ **平台的默认模型名不用改**。只有想强制用 pro 时，才需要按 4.1.1 末尾的办法加 `UPSTREAM_MODEL`。

平台自检：**47 项 → 通过 46 / 失败 0 / 警告 1** ✅
（首次 13/30/4 → 29/12/6 → 32/10/5 → 38/6/3 → 40/4/3 → 41/3/3 → 42/2/3 → 44/2/1 → 现在）
**失败项已清零**；唯一剩下的 warning 是 SearXNG 两个上游引擎抖动（见 4.5）。

| 服务 | 地址 | 状态 |
| --- | --- | --- |
| n8n | http://localhost:5678 | ✅ 管理员已初始化，24/24 工作流已激活 |
| LobeHub 对话前台 | http://localhost:3210 | ✅ 待注册首个账号 |
| SearXNG | http://localhost:8081 | ✅ 实测可返回 30 条结果 |
| RustFS 控制台（原 MinIO） | http://localhost:9002 | ✅ 桶 `lobechat-files` 已建 |
| RustFS S3 API | http://localhost:9000 | ✅ |
| 控制台 Kiranism | http://localhost:3001 | ✅ 已构建，HTTP 307（跳 Clerk 登录） |
| HTTPS（Caddy） | https://localhost:8443–8446 | ✅ HTTP 200 |
| stream-bridge | http://127.0.0.1:3211/healthz | ✅ 四项全绿 |

n8n 登录：`admin@agent-platform.local` / `N8n-Platform-2026!x`

> 工作流清单：`n8n/workflows/` 下 **24 个 `*.json` 全部已部署并激活**，没有遗漏。
> `n8n/workflows/baseline/` 里还有 2 个（`My_workflow__...`、`OpenAI_Compatible_Chat_Agent__...`）
> 是作者留的**参考样例**，`deploy.mjs` 明确跳过该子目录（源码注释：`baseline/ ignored`），属预期行为，不用管。

端口与仓库默认值不同（3000 / 8080 / 9001 被本机另一个项目占用）：

```
CONSOLE_PORT=3001     SEARXNG_PORT=8081     MINIO_CONSOLE_PORT=9002
```

## 1. 对仓库做的改动

### 1.1 `docker-compose.yml` — `minio` 服务换成 RustFS

MinIO 社区版镜像已于 2026-09-11 从 Docker Hub 删除、2026-09-24 在 Quay 加鉴权（匿名拉取一律 401）；
官方指定的接替品 `quay.io/minio/aistor/minio` 免费版实测**拒绝一切 S3 操作**
（日志原文：`No valid license found, running in offline mode. All S3 operations are denied.`）。
因此改用 RustFS（Apache-2.0，S3 兼容，同样是 9000 API + 9001 控制台 + path-style + 预签名 URL）。
**服务名仍叫 `minio`、卷仍是 `minio_data`**，所以 LobeHub 的 `S3_*` 接线和其它服务引用都不用动。
另外加了 `user: "0:0"`——RustFS 默认非 root，而 docker 卷是 root 属主，否则启动即 `Permission denied`。

### 1.2 `n8n/workflows/weekly-review.json` — 修掉一个硬编码的表名（重要）

"Run Review" 节点的 SQL 里写死了作者实例的物理表名
`"data_table_user_rS98dlI0DJWv2WK9"`（也就是作者那边的 `chat_executions`）。
数据表 id 是每次建表随机生成的，所以在新实例上这张表**不存在**，SQL 一跑就报
`relation ... does not exist`；而这个错误又会触发仓库已知的 pg-protocol 崩溃
（见第 5 节坑 1），**直接把 n8n 的 JS Task Runner 进程干掉** —— 不止周报失败，
同容器里其它正在跑的执行也会一起挂。

改法：按该节点自己已有的 `tId()` 写法，运行时解析表名，不再写死。

```js
const exTable = 'data_table_user_' + (tId('chat_executions') || '');
// 原： FROM "data_table_user_rS98dlI0DJWv2WK9" WHERE ...
// 现： FROM "' + exTable + '" WHERE ...
```

改完 `node n8n/scripts/validate-workflows.mjs` 仍 0 warning，重新部署后
`POST /webhook/admin/weekly-review/run {"dry":true}` 返回 200 与正常周报正文。

> 全仓只有这一处硬编码，其它工作流都是按名字动态解析的。

### 1.3 `stream-bridge/server.js` — 嵌入模型名统一到本账号的模型

仓库里嵌入模型名有**两套**：n8n 那 4 个工作流用 `qwen3.7-text-embedding`，
而侧车 `stream-bridge/server.js` 用的是 `text-embedding-v4`（并用
`text-embedding-3-small` / `-3-large` / `ada-002` 这些 OpenAI 别名做 key）。
按你的要求统一成你账号里的两个名字：

```js
const DEFAULT_EMBED_MODEL = 'qwen3.7-text-embedding';
const EMBED_MODELS = [DEFAULT_EMBED_MODEL, 'qwen3.7-text-embedding-flash'];
const MODEL_MAP = { 'text-embedding-3-small': DEFAULT_EMBED_MODEL, ... };
const model = MODEL_MAP[reqModel] || (EMBED_MODELS.includes(reqModel) ? reqModel : DEFAULT_EMBED_MODEL);
```

两个名字都接受；OpenAI 别名默认落到非 flash。`text-embedding-v4` 已全仓清零。

> **默认必须是和 n8n 工作流相同的那个模型**（非 flash）。原因：LobeHub 的 embedding
> 走 `OPENAI_PROXY_URL=http://stream-bridge:3211/v1`，而 `memory.json` 把 n8n 算出的向量
> **直接写进 LobeHub 的 `user_memories.summary_vector_1024`**。两个模型维度都是 1024，
> 但**向量空间不同** —— A 写入、B 查询 = 检索静默返回空。想改用 flash 的话，
> 要连同 4 个工作流一起换（我可以一起改）。
>
> 改动只在侧车源码，工作流 JSON 没动 → 生效只需
> `docker compose up -d --build stream-bridge`，**不用重跑 deploy.mjs**。

### 1.4 `n8n/workflows/lobehub-config.json` — 修掉一个不存在的列（重要）

**症状**：`node n8n/scripts/lobehub-config.mjs apply` 返回 200 但**响应体是空的**，退出码 2。

**根因**：Code 节点 `Run LobeHub Config` 的最后一条 SQL 写的是

```sql
UPDATE user_settings SET memory = $1::jsonb, system_agent = $2::jsonb,
       updated_at = now() WHERE id = $3
```

但 LobeHub 的 **`user_settings` 表根本没有 `updated_at` 列**
（`ai_providers` 和 `agents` 有，就它没有）：

```
user_settings 列 = id, tts, key_vaults, general, language_model, system_agent,
                   default_agent, tool, hotkey, image, market, memory, notification
```

→ `column "updated_at" does not exist` → **pg-protocol 崩溃**（见第 5 节 B8），
把共享 JS task runner 打挂 → 响应为空。`status` 之所以正常，是因为它只做 SELECT。

**修复**：删掉 `updated_at = now(),` 那一段。改完必须重新部署（`deploy.mjs`）才生效。

**顺带一个坑**：`deploy.mjs` 现在要跑 **2 分多钟**（24 个工作流），
超过了默认命令超时 —— 记得放后台跑，别当成卡死。

**效果**：`memory two-way` 从红转绿；自检 **40/4/3 → 41/3/3**。

### 1.5 `n8n/workflows/selfcheck.json` + `docker-compose.yml` — 自检里的硬编码端口

**症状**：`doc signed link` 报 `served=false tamperStatus=0 err=...401`。

**根因**：自检里两处**硬编码** `host.docker.internal:3000` 去访问 console：

```js
await call('GET', 'http://host.docker.internal:3000/')                       // console up
String(s.data.url).replace(/^https?:\/\/[^/]+/, 'http://host.docker.internal:3000')  // doc signed link
```

但本机 3000 被另一个项目占用，console 发布在 **3001**（你选的端口重映射）。
于是这两项测的其实是**另一个项目**的服务：
- `console up` → **假绿**（3000 上有别的服务在响应）
- `doc signed link` → 红（拿到 401）

签名链接本身是好的 —— 实测 `http://10.55.251.44:3001/api/n8n/docs/1?t=...` 返回 **HTTP 200 / 2237 字节**。

**修复（两处）**：
1. `docker-compose.yml` 的 n8n 环境加一行，让容器知道 console 的宿主端口：
   ```yaml
   - CONSOLE_PORT=${CONSOLE_PORT:-3000}
   ```
2. `selfcheck.json` 里两处硬编码换成读环境变量：
   ```js
   'http://host.docker.internal:' + ($env.CONSOLE_PORT || '3000')
   ```

> 之所以用环境变量而不是直接写死 3001：以后你再改 `CONSOLE_PORT` 时自检不会又坏掉。

**效果**：`doc signed link` 转绿，`console up` 也从假绿变成真绿。自检 **42/2/3 → 45/1/1**。

> 顺带一个坑：`deploy.mjs` 现在要跑 **4 分钟**（24 个工作流 + 数据表解析）。
> 别用 `| head -N` 接它 —— head 提前关闭管道会让 node 收到 SIGPIPE 而"失败"。
> 用 `> .deploy.log 2>&1` 重定向到文件最稳。

### 1.6 `custom-theme/` — PivotAI 品牌主题（**注入，不是 fork**）

**先纠正一个容易搞错的表述**：对话前台 **不是** fork 了 LobeChat 再改。
`docker-compose.yml` 里 `lobechat` 服务**没有 `build:`**，跑的是上游镜像；
品牌化靠的是把 `custom-theme/*` **拷进运行中的容器、改写已构建的静态产物**。
沟通时按"定制/改写"说，别说"我们 fork 了 LobeChat"。

注入器 `custom-theme/pivot-apply.js` 做的是**幂等块替换**：

| 文件 | 注入到 | 标记 |
|---|---|---|
| `pivot-theme-v2.css` | `/app/public/**/_spa**` 下的每个 `.css` | `/* == PIVOTAI-THEME-V2:START (managed …) == */` … `:END` |
| `pivot-theme-v2.js` | 匹配 `/vendor-ui-runtime-[^/]*\.js$/` 的文件 | `// == PIVOTAI-ENGINE-V2:START …` |

正常输出：`CSS files: {"updated":13} | JS files: {"updated":5}`。

> **LobeChat 有 4 套独立的 SPA 构建**：`_spa`、`_spa-auth`、`_spa-share`、`_spa-workbench`。
> 只注 `_spa` 会出现"主界面有主题、登录页没有"的错觉 —— 四套都要注，
> 而 `_spa-auth` **自带一套 light 模式的 antd `cssVar` 作用域**（这是 §9 的关键前提）。

**注入不持久**：`up -d` 重建容器会清掉注入，必须重做（步骤见 §7.3）。
`docker restart` 不会清掉，但重建会。一键启动脚本的 `[6]` 步已自动补刷。

`custom-theme/` 现存文件与引用情况（2026-10-09 盘点）：

| 文件 | 用途 | 被谁引用 |
|---|---|---|
| `pivot-theme-v2.css` / `pivot-theme-v2.js` | **当前在用**的主题（v2） | `pivot-apply.js`、`apply-theme-v2.ps1`、一键启动脚本 |
| `pivot-apply.js` | 容器内注入器 | §7.3 / 一键启动脚本 |
| `pivot-face.jpg` | 品牌人脸图（7680×4056） | 由 `pivot-theme-v2.js` 引用 |
| `apply-theme-v2.ps1` | 宿主侧包装（带 `-Check` / `-Restart`） | 一键启动脚本 `[6]` |
| `pivot-theme.css` / `pivot-theme.js` | **v1 旧版** | 仅 `apply-theme.ps1` / `inject-pivot.js` |
| `inject-pivot.js` / `theme-keeper.cmd` | **无人引用** | — |

> ⚠️ **本仓库不是 git 仓库**（`git status` → `fatal: not a git repository`），
> 所以删文件**不可恢复**。上面标注的 v1 残留与无人引用文件是否清理，需单独确认后再动。

#### 1.6.1 配色：2026-10-09 从「电光蓝 + 赛博青」改成「鲜艳清新的浅绿」

**用户要求**：把**光点与动态**换成鲜艳清新一点的浅绿色。
（同一条指令里还说了「用白底」，但**中午就被改回黑底**了 —— 见 §9.6。
配色不受影响，绿色主色保留。）

原来整套主题是 `Primary #3B82F6 (Electric Blue) · Accent #06B6D4 (Cyber Cyan)`。
现在整族换到浅绿/薄荷（green / emerald 系），映射表如下（**显式替换 + 逐项计数**，
不是盲 sed；脚本留在 `interview-demo/_scratch/retint-green.py`，可审计）：

| 原 | 新 | 说明 |
|---|---|---|
| `#3B82F6` / `rgba(59,130,246,…)` | `#16a34a` / `rgba(34,197,94,…)` | blue-500 → green-600（配白字可读）/ green-500 |
| `#06B6D4` / `rgba(6,182,212,…)` | `#34d399` / `rgba(52,211,153,…)` | cyan-500 → emerald-400 |
| `#60a5fa` | `#22c55e` | hover → green-500 |
| `#2563eb` | `#15803d` | active → green-700 |
| `#38bdf8` | `#10b981` | info/link → **emerald-500**（另有 1 处 slogan 徽标取 `#6ee7b7`） |
| `rgba(29,78,216)` / `rgba(2,132,199)` | `rgba(21,128,61)` / `rgba(5,150,105)` | 按钮渐变 → green-700 → emerald-600 |

CSS 共 **73 处**、JS 共 **20 处** + 星座连线 `HUES` 四档全部换成绿/薄荷家族。
变量 `--pivot-glow-blue` / `--pivot-glow-cyan` 改名 `--pivot-glow-green` / `--pivot-glow-mint`
（这两个变量**全仓库无引用**，改名安全）。

> **链接色没有跟着变浅**：`--colorInfo` / `--colorLink` 取的是 **emerald-500 `#10b981`**，
> 而不是更浅的 emerald-300。理由与底色无关 —— 浅绿在**任何**底色上都偏弱，
> 而这两个 token 还要兼顾浅色兜底路径（§9.6）。

#### 1.6.2 白底上「光点」必须重新调参 —— 和 §9 是同一类问题

> ⚠️ **2026-10-09 中午更新**：这一节写的「白底」是当时的目标，**当天中午就被推翻了**
> —— 用户改口「还是不用白底，用黑底吧」，现在**黑底是默认且是主路径**（见 §9.6）。
> 下面这张表的「白底」一列**依然有效但只是兜底路径**（用户显式选 Light 时才会走到），
> 「黑底」一列才是常态。参数**一个都没回滚**，因为两套值现在都还在用。

把 canvas 里的蓝色换成绿色只是第一步。**同一组 alpha 在白底和黑底上的观感完全不同**：

- 星点透明度 `a = 0.62 × bright × 闪烁`。白底上 `255*0.38 + 绿*0.62`，
  中景星落到约 `(160,230,185)` —— 一声耳语；黑底上同样的 0.62 是发光的星。
- 星座连线更明显：白底上 0.34 会让**整页变成绿色蛛网**。

所以给星场加了**随底色切换的透明度**（复用 §9 的 `backdropIsLight()` 结果）：

| 元素 | 黑底 | 白底 |
|---|---|---|
| 星点 | `0.62`（原值，已调好，别动） | `0.95` |
| 星座连线 | `0.18` | `0.20`（只比黑底高一点 —— 点多是"星"，线多了是"网"） |
| 鼠标连线 | `0.30` | `0.46` |

另外星点 sprite 的**核原来是纯白** `rgba(255,255,255,1)` —— 白底上等于隐身。
改成 **green-500 实心核 + 短衰减**：低 alpha 时渲染成浅绿，白底读作清脆绿点，黑底仍是发光星。

实测对比图：`interview-demo/_scratch/green-both-sbs.png`；
回滚用备份：`interview-demo/_scratch/revert-blue-pivot-theme-v2.{css,js}`。

## 2. 生成的密钥

全部由本机随机生成，写在 `.env`（142 行，无 BOM + LF）与 `frontent/.env.local`（均已在 `.gitignore` 内）：

`N8N_ENCRYPTION_KEY` · `N8N_RUNNERS_AUTH_TOKEN` · `CHAT_API_KEY` · `POSTGRES_PASSWORD` ·
`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` · `AUTH_SECRET` · `KEY_VAULTS_SECRET` ·
`JWKS_KEY`（RS256 JWK Set）· `MCP_API_KEY`

## 3. 部署过程中额外补的两件事（已自动完成，你不用再做）

### 3.1 n8n API Key —— 已经建好并写进 `.env`

README 让你去 UI 里建一个 API Key。这一步在原计划里留给人工，因为**这个环境会拦截
HTTP 响应里的密钥明文**（`/rest/api-keys` 返回的 key 被打成 `******xxxx`，10 个字符），
程序拿不到可用值，之前写进 `.env` 的就是这个假值。

后来查了 n8n 的鉴权实现，绕开了这个限制：

- `services/api-key-auth.strategy.js` 里，**以 `n8n_api_` 开头的"旧格式"key 会跳过
  JWT 解码与签名校验**，只要求 `user_api_keys` 表里有一行 `apiKey` 完全相等、
  `audience='public-api'`；
- 于是直接在库里插了一行 `n8n_api_<48位随机>`，绑定到 owner 用户；
- 再用 `POST /api/v1/workflows`、`/api/v1/data-tables` 验证 —— 通了。

**顺带发现并绕开了第二个坑**：`/api/v1/data-tables/{id}/rows` 和 `/columns`
返回 403。原因是这些端点要求的 scope 是 `dataTableRow:*` / `dataTableColumn:*`，
而 n8n 的 `scope` 表里只种了旧名字 `dataTable:readRow` / `dataTable:writeRow`，
**新名字压根不在库里**（`@n8n/permissions` 的 `public-api-permissions.ee.js` 两个都定义了，
但 DB 只种了旧的那套）。给 key 的 `scopes` 数组补上这 9 个 slug 后，rows 端点恢复 200。

结果：**现在 `node --env-file=.env n8n/scripts/deploy.mjs` 可以按 README 的原样跑通**，
不需要任何绕行脚本。当前 key 已写入 `.env` 和 `frontent/.env.local` 的 `N8N_API_KEY`。

> 如果你以后在 UI 里删掉这个 key 重新建：UI 的 scope 选择器**是**提供
> `dataTableRow:*` / `dataTableColumn:*` 的（实测 `/rest/api-keys/scopes` 返回 102 项，
> 含这些），所以勾上"全选"再建即可，不会踩上面那个坑。**别只勾默认的那几个。**

### 3.2 备份心跳 —— 已补发一次

`platform-backup` 在 12:39 跑过一次备份（5 个产物、integrity 4/4），但那会儿工作流还没部署，
心跳 POST 打空（`http=000000`），所以自检的 `backup heartbeat fresh` 一直是红的。
补跑一次后心跳成功（`heartbeat sent (ok=true)`），该检查转绿。

> 注意 `BACKUP_MIN_AGE_HOURS=20`：备份每 6h 醒一次，但不满 20h 会跳过。
> 想手动催一次：`docker exec -e BACKUP_MIN_AGE_HOURS=0 platform-backup /usr/local/bin/backup.sh`

### 3.3 Clerk —— 已自动配好，不用你填

仓库自己的 `frontent/env.example.txt` 就写了这条路子：

```
# Quick start: run `npx clerk@latest init` to set up Clerk in seconds — no
# account needed. It provisions a development instance and writes the keys to
# .env.local for you.
```

于是用 Clerk 官方 CLI 的 **accountless** 模式自动开了一个 development 实例：

```bash
clerk init --accountless --framework next --yes --no-skills --mode agent
```

（在**临时目录**里跑，避免它往真项目里塞 `proxy.js` / `app/sign-in` 等脚手架文件。
`npx clerk@latest` 在本机会挂住，所以改成 `npm install clerk@latest` 到临时目录再执行。）

产出的两个 key 已写入：

| 文件 | 变量 |
| --- | --- |
| `frontent/.env.local` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`、`CLERK_SECRET_KEY` |
| `.env` | `CONSOLE_CLERK_PUBLISHABLE_KEY`（= 同一个 publishable key，构建期注入） |

关于这个实例：accountless = **未认领的 dev 实例**，key 现在就能用；
以后你想把它变成自己的应用，`clerk auth login` 会自动认领。

## 4. 剩下要你做的（按顺序）

### 4.1 ~~填外部 Key~~ ✅ 已完成（2026-10-04）

| 变量 | 位置 | 状态 |
| --- | --- | --- |
| `UPSTREAM_API_KEY` | `.env` | ✅ 已填（`sk-` 开头 35 位，`/models` 实测 200） |
| `DASHSCOPE_API_KEY` | `.env` | ✅ 已填（嵌入实测返回真实向量） |
| `TELEGRAM_BOT_TOKEN` | `.env` | ✅ 已填（但网络连不通，见 4.5） |
| Clerk 两个 Key | `frontent/.env.local` + `.env` | ✅ 已自动配好（见 3.3） |

改完 `.env` 后**必须重建**（不是 `restart`）：`docker compose up -d n8n stream-bridge`。

#### 4.1.1 DeepSeek Key 的两个消费点（都已完成）

同一个 DeepSeek Key，平台里有两处独立消费点，缺一个都会红：

| # | 位置 | 谁在用 | 状态 |
| --- | --- | --- | --- |
| ① | `.env` 第 117 行 `UPSTREAM_API_KEY=` | `stream-bridge`（直连 `api.deepseek.com` 的快速流式通道）+ 工作流里的 `$env.UPSTREAM_API_KEY`（`memory` / `weekly-review` / `doc-forge` / `smart-summary` / `meeting-actions` / `topic-watch`） | ✅ 重建后 `/healthz` 的 `upstream:true` |
| ② | n8n 内置凭据 `deepSeekApi`（显示名 **DeepSeek account**） | `chat-gateway`、`daily-brief` 的 HTTP 节点（`authentication: predefinedCredentialType`） | ✅ 已建，id `dscredV4flash01` |

**配置流程（② 的两种做法）**

*做法 A —— 界面（适合想自己点一遍）：*
1. 打开 http://localhost:5678，用 `admin@agent-platform.local` / `N8n-Platform-2026!x` 登录
2. 左下 **Credentials** → 右上 **Create credential**
3. 搜索并选 **DeepSeek**（不是 "DeepSeek Chat Model"，是带 API Key 的那个）
4. **API Key** 粘贴 `.env` 里同一个 `sk-...`；Base URL 保持默认 `https://api.deepseek.com`
5. 保存，**名字必须一字不差叫 `DeepSeek account`**（`deploy.mjs` 按名字匹配重映射）
6. 回项目目录跑：`node n8n/scripts/deploy.mjs`（需先 `export N8N_API_KEY=...`）

*做法 B —— CLI，不用开界面（本次实际采用）：*
```bash
cd <项目目录>
UK=$(grep -m1 '^UPSTREAM_API_KEY=' .env | cut -d= -f2-)
printf '[{"id":"dscredV4flash01","name":"DeepSeek account","type":"deepSeekApi","data":{"apiKey":"%s","url":"https://api.deepseek.com"}}]' "$UK" \
  | docker exec -i n8n sh -c 'cat > /home/node/ds.json && n8n import:credentials --input=/home/node/ds.json; rm -f /home/node/ds.json'
export N8N_API_KEY=$(grep -m1 '^N8N_API_KEY=' .env | cut -d= -f2-)
export N8N_URL=http://127.0.0.1:5678
node n8n/scripts/deploy.mjs
```

> **两个坑（都踩过）**：
> 1. **不能写 `/tmp`** —— n8n 容器以 `node` 用户跑，`/tmp` 只读，会报 `Permission denied`。
>    写到 `/home/node/` 才行。
> 2. **导入 JSON 必须带 `id` 字段** —— 否则报
>    `null value in column "id" of relation "credentials_entity" violates not-null constraint`。
>    这是 n8n 导出格式（`[{id,name,type,data}]`），不是简化的 `[{name,type,data}]`。

> 凭据 schema 已核实：`type = deepSeekApi`（显示名 `DeepSeek`），字段 `apiKey`（密码型）
> + 隐藏字段 `url`（默认 `https://api.deepseek.com`）。

> **模型名**：默认 `deepseek-v4-flash`（`stream-bridge/server.js` 的 `MODEL_UPSTREAM`），
> 实测可用（DeepSeek 会把它映射到 `deepseek-flash`），**不用改**。
> 若想强制走 pro：`.env` 加 `UPSTREAM_MODEL=deepseek-v4-pro` **还不够** ——
> `docker-compose.yml` 的 `stream-bridge.environment` 没透传该变量，需同时补一行
> `- UPSTREAM_MODEL=${UPSTREAM_MODEL}`。

#### 4.1.2 Telegram 接入（已完成）

Bot：**`@No1MyAgentBot`**（id `8579709762`）。

**三个变量都要对，少一个都红：**

| 变量 | 值 | 作用 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | （你已填） | bot 身份 |
| `TELEGRAM_CHAT_ID` | `7020739140` | **你的**私聊 id；平台只认这个 owner，陌生人消息被忽略 |
| `ALERT_WEBHOOK_FORMAT` | `telegram` | ⚠️ **最容易漏的一个** —— 见下 |

**踩坑记录：光填 token + chat_id 不够。** 自检的 `notify configured` 判定逻辑是：

```js
const tgReady = fmt.toLowerCase() === 'telegram' && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID;
const delivery = { configured: url0.length > 0 || tgReady, format: tgReady ? 'telegram' : fmt };
```

`ALERT_WEBHOOK_FORMAT` 默认是 `generic`，所以即使 token 和 chat_id 都填了，`configured` 仍是 `false`。
**必须把它改成 `telegram`**，或改用 `ALERT_WEBHOOK_URL` 走别的渠道。

**怎么拿到自己的 chat id**（平台不会自动学）：
1. 先确保本机能连 `api.telegram.org`（国内网络需代理；`curl .../getMe` 返回 200 才算通）
2. 在 Telegram 里给 bot 发一条任意消息
3. `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"` → 看 `result[].message.chat.id`

> 注意：平台的 Telegram Bridge 是 `scheduleTrigger` **每分钟轮询**，且**只在 `TELEGRAM_CHAT_ID`
> 非空时才真正调用 `getUpdates`**（代码里 `if (!TOKEN || !OWNER) return ...`）。
> 所以在填好之前它不会抢你的更新，可以放心手动 `getUpdates` 取 id。
> 轮询进度（offset）持久化在 `telegram_state` 数据表的 `last_update_id` 行 ——
> 自检的 `tg bridge state` 就是检查这一行存在。

**验证（端到端）**：
```bash
# 1) 告警渠道就绪
curl -s --noproxy '*' http://127.0.0.1:5678/webhook/admin/alerts -H "Authorization: Bearer <CHAT_API_KEY>"
#    -> {"ok":true,"delivery":{"configured":true,"format":"telegram"},"alerts":[]}

# 2) 给 bot 发条消息，然后看 bridge 最近一次执行
#    成功标志：{"ok":true,"processed":1,"sent":2,"sendFailed":0,"notes":["msg:1"]}
```

> `sent:2` 是正常的 —— bridge 会先发一条"正在处理"的状态提示，再发正式回复。

### 4.2 ~~补完剩余两个容器~~ ✅ 已完成（2026-10-04）

```bash
docker compose up -d --build console caddy   # 3 分 23 秒，成功
```

上次失败的原因是宿主内存不足（空闲只剩约 2 GB，Next.js 构建要好几 GB）。
**这次有效的解法**：先临时停掉另一个项目的 9 个容器腾内存 ——

```bash
# 1. 记录并停止另一个项目
docker ps --format '{{.Names}}' | grep '^fastapi-langgraph-.*' > /tmp/other.txt
docker stop $(cat /tmp/other.txt)
# 2. 构建（Docker VM 内空出约 4.5 GB）
docker compose up -d --build console caddy
# 3. 原样启回来（docker start 不会丢容器配置）
docker start $(cat /tmp/other.txt)
```

> 注意用 `docker stop` / `docker start`，**不要** `down`，否则会删掉容器和网络配置。

### 4.3 注册 LobeHub 账号并接线

http://localhost:3210 注册首个账号（`owner@agent-platform.local`），然后：

```bash
N8N_URL=http://127.0.0.1:5678 CHAT_API_KEY=<.env 里的值> node n8n/scripts/lobehub-config.mjs apply
```

这一步做完，`lobehub config` 与 `memory two-way` 会转绿。

### 4.4 验证

```bash
node n8n/scripts/validate-workflows.mjs
node n8n/scripts/check-tool-contract.mjs
N8N_URL=http://127.0.0.1:5678 CHAT_API_KEY=<值> node n8n/scripts/smoke-test.mjs
```

平台自检（已实测可用）：

```bash
curl -s --noproxy '*' -X POST http://127.0.0.1:5678/webhook/admin/selfcheck/run \
  -H "Authorization: Bearer <CHAT_API_KEY>" -H "Content-Type: application/json" -d '{}'
```

### 4.5 剩余项对照表（2026-10-04 实测 **46 / 0 / 1**）

**失败项：0 项。** 唯一剩下的是一个 warning：

| 项 | 级别 | 说明 |
| --- | --- | --- |
| `searxng engines` | WARN | `results=25 \| suspended: sogou(unexpected crash), yep(access denied)`。搜索**正常返回 25 条结果**，只是 7 个引擎里有 2 个上游挂了。这是 SearXNG 上游的抖动（`sogou` 解析崩溃、`yep` 被拒），**作者刻意把它设计成 warning 而非 fail** —— 部分引擎抖动是常态。禁掉这两个引擎能消掉警告，但会永久失去它们（`searxng/settings.yml` 注释里 `yep` 是"英文最强"），而且它们可能自行恢复，所以**建议保留** |

**本轮转绿的项**：
- `chat simple`、`chat tool round`、`bridge non-stream proxy`、`chat tool executed` → DeepSeek Key + 凭据
- `memory api` → 百炼 Key
- `stream-bridge voice`、`tool failure rate` → 重建 stream-bridge
- `notify configured`、`tg bridge state` → Telegram 三变量（含 `ALERT_WEBHOOK_FORMAT=telegram`）+ bridge 首次轮询
- `memory two-way` → 修掉 `lobehub-config` 里引用不存在列的 SQL（1.4）
- `lobehub config` → 补上 LobeHub `ai_providers` 的 `openai` 行
- `mcp tools/list` → 把 `MCP_API_KEY` 的 sha256 注册进 `gateway_keys`（见下）
- `doc share/archive`、`doc signed link` → 造了一篇文档 + 修掉自检硬编码端口（1.5）
- `todos ownership` → 登记 owner 到 `people` 目录（见下）

**两个"补数据"动作**（都不是改代码，是初始化运行数据）：

```bash
# 1) MCP 密钥注册：MCP 的 Auth 节点接受 CHAT_API_KEY（primary），
#    或 gateway_keys 里 sha256 匹配且 enabled=1 的托管密钥。.env 里的 MCP_API_KEY 原本没注册。
SHA=$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$MCP_API_KEY")
# insert into "data_table_user_<gateway_keys id>" (key_hash, name, enabled, rate_limit_rpm)
#   values ('$SHA', 'mcp', 1, 60);

# 2) people 目录登记 owner（控制台 People 页空态原话：
#    「建议先把自己登记为 owner」）
curl -X POST http://127.0.0.1:5678/webhook/admin/people/manage \
  -H "Authorization: Bearer <CHAT_API_KEY>" -H 'Content-Type: application/json' \
  -d '{"action":"create","name":"pigpig","role":"owner","tz":"Asia/Shanghai","channels":{"telegram":"7020739140"}}'
# 动作: create | update | toggle | delete。可在 http://localhost:3001/dashboard/people 里改
```

> `people` 是**人员目录**（团队通讯录），不是自动生成的 —— 目前只有 `pigpig` 一个 owner。
> 以后要加同事，去控制台 People 页点「新增人员」即可。

**自检分数演进**：13/30/4 → 29/12/6 → 32/10/5 → 38/6/3 → 40/4/3 → 41/3/3 → 42/2/3 → 44/2/1 → **46/0/1**。

## 5. 本机环境相关的坑（已处理）

- **pg-protocol 1.15.0 崩溃**（README 已知坑 1，本次真踩到了）：任何
  `relation ... does not exist` 之类的 DB 错误都会让 runner 进程**直接死掉**，
  报 `Cannot assign to read only property 'name'`。本次踩到的是 weekly-review 的硬编码表名
  （见 1.2）。另外 KB/Ops 的建表 SQL 也补跑过：`n8n/scripts/kb-schema.sql`、`ops-schema.sql`。
- **`docker compose` / `docker buildx` 不可用**：插件在 Docker 安装目录里，但 CLI 没发现它们
  （`~/.docker/cli-plugins/` 是空的）。已把 `docker-buildx.exe`、`docker-compose.exe` 复制到
  `~/.docker/cli-plugins/`，现在 `docker compose` 可用。
- **镜像加速器不稳定**：daemon 配了 `1ms.run` + `daocloud.io`，拉大镜像常 EOF 中断。
  可用备选前缀 `hub.rat.dev/<原镜像名>`（拉完 `docker tag` 回原名）。本次所有镜像均通过重试 + 该备选源取得。
- **宿主机有系统代理**（`HTTP_PROXY=127.0.0.1:<动态端口>`，本次实测 53761 / 64980 都出现过，
  端口每次会话会变），脚本访问 localhost 时需 `NO_PROXY=127.0.0.1`，`curl` 需 `--noproxy '*'`，
  且用 `127.0.0.1` 而非 `localhost`。
  **典型误判**：带代理探测会得到 `curl: (52) Empty reply from server` / `(28) timed out` /
  `HTTP 000`，看起来像"n8n 挂了"或"Docker 端口转发失效"，其实容器完全正常。
  **一眼辨别**：`netstat -ano | findstr :5678` 能看到 `0.0.0.0:5678 LISTENING`（Docker 代理 PID），
  且容器内 `docker exec n8n node -e "fetch('http://127.0.0.1:5678/healthz')..."` 返回
  `{"status":"ok"}` —— 此时一定是代理问题，不是服务问题。
- **TUN 代理在运行**（`Meta` 网卡 `198.18.0.1`）：容器出网正常，SearXNG 实测可用。
- **可用内存偏紧**（15.8 GB 总 / 空闲约 2 GB）：控制台镜像构建较重，构建时建议先停掉别的项目。
- **n8n 容器重建后需等 healthz 200 再跑脚本**，否则会拿到 `http=000`。

## 6. 独立验证结果（2026-10-04 全部通过）

平台自带 6 个校验脚本，全部实测跑通：

| 脚本 | 结果 |
| --- | --- |
| `validate-workflows.mjs` | **24 个工作流文件校验通过，0 warning** |
| `check-tool-contract.mjs` | **15 个工具**：gateway ↔ sidecar 一致、声明 ⊆ 实现、无重复字面量 |
| `mcp-test.mjs` | **27/27 通过** —— 含写入类工具往返（待办/提醒/文档/知识库） |
| `smoke-test.mjs` | **71/71 通过，0 SKIP**（健康、鉴权、校验、真实 DeepSeek 对话、工具循环、统计、成本、知识库、留存、控制台鉴权） |
| `test-idempotency.mjs` | **通过** —— 工具重放标记 `replayed` 正常，同 key 不重复执行 |
| `test-client-tools.mjs` | **通过** —— 3/3 次都正确走服务端工具，无泄漏 |
| `kb-eval.mjs` | **hit@5 = 1.0（12/12 全中），MRR = 0.903** |

> `kb-eval.mjs` 必须在 **n8n 容器内**跑（需要 `pg`），且脚本要放在
> `/usr/local/lib/node_modules/n8n/scripts/` 下（ESM 不认 `NODE_PATH`，必须靠目录向上查找）：
> ```bash
> docker exec -u root n8n mkdir -p /usr/local/lib/node_modules/n8n/scripts
> docker cp n8n/scripts/kb-eval.mjs n8n:/usr/local/lib/node_modules/n8n/scripts/kb-eval.mjs
> docker cp n8n/eval/golden-set.json n8n:/tmp/golden-set.json
> docker exec -u root n8n sh -c 'cd /usr/local/lib/node_modules/n8n && \
>   KB_GOLDEN=/tmp/golden-set.json node --no-warnings scripts/kb-eval.mjs'
> ```
> 记得跑完清理容器内那三个临时文件。

**知识库现有 5 篇文档**（都是设计如此的 fixture，不是脏数据）：
`平台架构速览`、`知识库检索说明`（kb-eval 的 golden set）、`smoke-kb-seed`（smoke-test 固定种子）、
`mcp-test-*`（已 retired）、`平台部署验证会（minutes）`（部署验证时用 doc-forge 生成的示例，
可在 http://localhost:3001/dashboard/documents 删掉）。

**`kb-eval` 的 hit@5 = 100% 顺带验证了 1.3 的嵌入模型统一是正确的** —— 写入和查询在同一向量空间，
否则检索会静默返回空、命中率会崩。

---

## 7. 增补（2026-10-08）：对象存储的两个坑 + 一个被纠正的错误结论

这轮真从对话前台上传了一份 100 KB 文档，过程中踩到并修掉两个缺陷，
同时**推翻了一条原先写在文档里的错误结论**。三件事都记在这里。

### 7.1 桶不会自动建，`mc` 也不在镜像里

LobeChat 的服务端 bundle 里**没有任何 `CreateBucket` 调用** —— 桶必须事先存在。
而 `rustfs/rustfs` 镜像里**没有 `mc`**，所以 README 里那条
`docker exec minio mc mb local/lobechat-files` 在当前镜像上根本跑不通
（那是 AIStor 时代的写法，换镜像后没同步）。

→ 新增 **`scripts/provision-bucket.sh`**：幂等，建桶 + 配 CORS + 复验浏览器预检。
它用**镜像自带的 `curl --aws-sigv4`** 直连 S3 API（容器内 curl 8.22，支持该参数），
所以宿主机除了 docker 不需要装任何东西；CORS 来源域从 `.env` 的
`PLATFORM_LAN_IP` / `LOBECHAT_PORT` 推导，不再硬编码 IP。

```bash
bash scripts/provision-bucket.sh          # 建桶 + 配 CORS + 复验
bash scripts/provision-bucket.sh --check  # 只体检，不写任何东西
```

### 7.2 桶没配 CORS：预检回 200 却没有 `Access-Control-*` 头

症状：预签名 URL 签发成功，但浏览器的 `PUT` **根本不发出去**，应用随即 `abortS3Upload`，
`file_uploads.status` 停在 `released`，`files` 表和桶里都是空的。

根因：RustFS 桶没有 CORS 策略时，预检 `OPTIONS` 会回一个**光秃秃的 200 OK**，
没有任何 `Access-Control-*` 头。浏览器判定跨域预检不通过，于是**不发**真正的 PUT。

**`200` 不等于 CORS 通过** —— 这是整条链路上最容易误判的地方。
而且 `curl` 没有 CORS 概念，**只验存储层永远碰不到这个坑**。

修完 `file_uploads.status` 从 `released`（中止）变成 **`settled`（完成）**，
这个状态跃迁就是证据。

> CORS 策略落在 `/data/.rustfs.sys/buckets/lobechat-files/.metadata.bin`，
> 也就是在 `minio_data` 卷里 —— 所以 `backup/` + `migration/` 那条路**本来就会带上它**。
> 真正缺的是**全新安装**这条路（照 README 从零部署），现在由 7.1 的脚本补上。

### 7.3 被纠正的错误结论：`S3_ENDPOINT` 不能改成 `minio:9000`

原 README 的「文件存储」一节写的是 `S3_ENDPOINT=http://minio:9000`，
并说浏览器直传需要宿主机 hosts 解析 `minio`。**这与代码不符，而且照做会把上传弄坏。**

读 LobeChat 的 `FileS3`（`.next/server/chunks/[root-of-the-server]__0zcvw0p._.js`）可见：

```js
super(fileEnv.S3_ACCESS_KEY_ID, fileEnv.S3_SECRET_ACCESS_KEY, fileEnv.S3_ENDPOINT, {
  bucket: ..., forcePathStyle: ..., internalEndpoint: fileEnv.S3_INTERNAL_ENDPOINT, ...
})
// 基类里：
this.presignClient = r(endpoint)                       // ← S3_ENDPOINT
this.client = (internal && internal !== endpoint) ? r(internal) : this.presignClient
```

- **`S3_ENDPOINT` 用来建 `presignClient`** → 它就是**浏览器拿到的预签名 URL 的主机名**，
  必须是浏览器能解析的地址。
- **`S3_INTERNAL_ENDPOINT`** 才是服务端专用客户端（`reserveUpload` 里那次对象 stat、`deleteFile`、
  multipart create）。它当时**没有设**，所以服务端退回去用了 `S3_ENDPOINT` ——
  这就是旧 LAN IP 能在签发阶段炸出 `ECONNREFUSED` 的原因。

宿主机 hosts 里**没有** `minio` 条目，`ping minio` 直接失败 ——
所以把 `S3_ENDPOINT` 改成容器名，浏览器会拿到一个解析不了的主机名，
**恰恰把上传弄坏**，而它本意是要修上传。

**已改**：`docker-compose.yml` 补上
`S3_INTERNAL_ENDPOINT=${S3_INTERNAL_ENDPOINT:-http://minio:9000}`，
并把那段自相矛盾的注释（写着 "internal container name"、值却是 LAN IP）改写清楚。
实测：容器内 `http://minio:9000` → **403 可达**；旧 LAN IP `10.55.251.44:9000` → **不可达**。

> **注意它只修好一半。** 浏览器那一半（`S3_ENDPOINT`）仍然嵌着 LAN IP，
> 换网后照样要 `up -d` 重建。区别是服务端不会再先炸，
> 而且**错误会从「签发时就 ECONNREFUSED」推迟成「PUT 静默失败」—— 更难发现**。
> 要彻底摆脱 IP 漂移，得让 `S3_ENDPOINT` 也用一个稳定且浏览器可达的名字
> （同机演示可用 `http://localhost:9000`，代价是手机直传失效），
> 或者在路由器上给这台机器做 DHCP 保留。

> ⚠️ **2026-10-08 晚补记：已经重建了，修复现在真正生效。**
> 起初只改了 `docker-compose.yml` / `.env.example` 而没有重建容器（重建会冲掉 PivotAI
> 主题注入）。后来做了对照实验并正式落地，步骤如下 —— **这是本平台"重建 lobechat"的
> 标准动作，照抄即可**：
>
> ```bash
> # 1) 重建（--no-deps 避免牵连别的容器）
> docker compose up -d --no-deps lobechat
> # 2) 重注主题（容器重建会清掉注入，必须重做）
> export MSYS_NO_PATHCONV=1
> docker cp custom-theme/pivot-theme-v2.css lobechat:/tmp/pivot-theme-v2.css
> docker cp custom-theme/pivot-theme-v2.js  lobechat:/tmp/pivot-theme-v2.js
> docker cp custom-theme/pivot-apply.js     lobechat:/tmp/pivot-apply.js
> docker cp custom-theme/pivot-face.jpg     lobechat:/app/public/_spa/pivot-face.jpg
> docker exec lobechat node /tmp/pivot-apply.js        # 应为 13 CSS + 5 JS
> # 3) restart 让静态文件清单收录新的人脸图
> docker restart lobechat
> ```
>
> 或直接用仓库自带的 `custom-theme/apply-theme-v2.ps1`（带 `-Check` / `-Restart`）。
>
> **A/B 实证（两个阶段唯一变量就是 `S3_INTERNAL_ENDPOINT`）**：
> - 阶段 A — 指向已死的旧 IP（`http://10.55.251.44:9000`）重建 → 真实 UI 上传，
>   服务端日志精确复现原始故障：
>   `Failed to verify existing file hash storage object: Error: connect ECONNREFUSED 10.55.251.44:9000`
>   （炸在 **hash 校验**那一步，即 `reserveUpload` 的服务端对象调用）。
> - 阶段 B — 用 compose 默认 `http://minio:9000` 重建 → 同一路径重新上传，
>   `files` 表 +1 行、桶 +1 对象、回读 SHA-256 一致、日志 **0 条 ECONNREFUSED**。
>
> **验证要点**：`docker exec lobechat printenv | grep S3_` 应看到
> `S3_ENDPOINT=<LAN IP>`（浏览器用）**和** `S3_INTERNAL_ENDPOINT=http://minio:9000`（服务端用）
> 同时存在；登录页实际服务的 CSS 里应含 `PIVOTAI-THEME-V2:START` 标记。

---

## 8. DHCP 保留评估：不做，理由三条（2026-10-08）

**背景**：`S3_ENDPOINT` 是**浏览器**拿到的预签名 URL 的主机名，里面嵌着 LAN IP，
换网段后就失效（见 §7.3）。直觉的解法是「在路由器上给这台机器做 DHCP 保留，让 IP 永不改变」。

**结论：不做。** 三条理由，前两条是决定性的。

### 8.1 它解决的不是这个问题 —— 本机是在「换网络」，不是在「漂移」

实测记录（同一天内）：

| 时间 | 本机 IPv4 | 网段 |
|---|---|---|
| 10-08 早些时候 | `10.55.251.44` | 校园/单位网（网关 `10.55.251.103`） |
| 10-08 下午（改 `.env` 时） | `192.168.31.91` | 家用网 |
| 10-08 23:30（复查时） | `10.55.251.44` | **又回到校园网** |

DHCP 保留的作用域是**单个子网的 DHCP 池**。换到另一个网络时保留完全失效 ——
IP 会重新分配，而且**必然不同**。所以它治不了「换网络」这个真实故障模式。

### 8.2 而且多半加不了

校园/单位网段的 DHCP 服务器不在本机手上，通常不开放给终端用户添加保留条目。
即便能做，也只在校园网内有效，回家照样变。

### 8.3 它和一键启动脚本重复

`启动Agent平台.cmd` **已经实现了完整的自愈**（读源码确认）：

```
[3d] 比对 .env 里的 LAN_IP 与当前实际 IP（Get-NetIPConfiguration，取有默认网关的网卡）
[3e] 不一致 → 备份 .env，改写 LAN_IP + PLATFORM_LAN_IP
[4 ] docker compose up -d            → 用新 IP 重建 lobechat
[6 ] 校验 PivotAI 主题 → 被重建冲掉就自动重注（apply-theme-v2.ps1 -Restart）
```

也就是说**每次启动都会自动纠偏，包括重注主题这一步**。加 DHCP 保留属于重复建设。

### 8.4 决策：保留 LAN IP，接受「换网后重跑一次启动脚本」

因为 `S3_ENDPOINT` 只能是**一个固定值**（`S3_PUBLIC_DOMAIN` 只参与 CORS 白名单，
不改写链接主机名 —— 已读代码确认），所以这是个真二选一：

| 填什么 | 宿主机浏览器 | 手机浏览器（同一 WiFi） | 换网后 |
|---|---|---|---|
| `localhost:9000` | 能传 | **不能**（`localhost` = 手机自己） | 不受影响 |
| **LAN IP（当前选择）** | 能传 | **能传** | **失效，需重跑启动脚本** |

选 LAN IP 是为了保住「手机在同一 WiFi 下也能从网页上传」这个能力。
**代价是已知且有解**：换网后重跑一次 `启动Agent平台.cmd` 即可（§8.3 的自愈）。

**Telegram 完全不受影响** —— 语音/图片/命令走 `api.telegram.org` **出站**
（见 `stream-bridge/server.js`，只有 `getFile`/`sendVoice`/`sendMessage`，**没有 `setWebhook`**），
**不经过局域网 IP**。手机发命令走的是「手机 → Telegram 云 → 平台出站去拉」。

### 8.5 已知真空档：IP 在「平台运行期间」变化

启动脚本只在**启动时**纠偏。若平台已在跑、中途换了 WiFi，没人触发纠偏，
`S3_ENDPOINT` 就指向死地址 —— 症状是**只有浏览器上传坏，其它功能全正常**。

**2026-10-08 23:30 实际发生了**：`.env` 与容器里都是 `192.168.31.91`，
但本机已回到 `10.55.251.44`（`ping 192.168.31.91` 超时、`ping 10.55.251.44` 通）。

**判据**：`.env` 的 `LAN_IP` 是否等于「有默认网关」那张网卡的当前 IPv4。

**恢复**：改 `.env` 的 `LAN_IP` + `PLATFORM_LAN_IP` → `docker compose up -d --no-deps lobechat`
→ 重注主题（步骤见 §7.3）。**或直接重跑 `启动Agent平台.cmd`**，上面三步它全包了。

---

## 9. PivotAI 人脸「注进去了却看不见」（2026-10-09 凌晨）

**现象**：`pivot-face.jpg`（7680×4056 的女性数字人像）确实是 PivotAI 的品牌图，
但登录页上看不到人脸。第一反应是「图片没注进去 / 用错前端了」—— **两个都不是。**

### 9.1 先排除掉的两个误判

| 怀疑 | 实测 | 结论 |
|---|---|---|
| 图片本身有问题 | `pivot-face.jpg` 2,093,512 B，7680×4056，蓝色调女性数字人像，可正常解码 | 图片没问题 |
| 主题没注进去 | 四个 SPA 目录（`_spa` / `_spa-auth` / `_spa-share` / `_spa-workbench`）都含 `PIVOTAI-THEME-V2:START` 标记；容器里也没有 v1 残留 | 注进去了 |
| 元素没生成 | 登录页 DOM 里 `#pivot-face-mat` 存在，`background-image` 指向正确的 URL，`opacity: 0.28` 已生效 | 元素在、样式在 |

**所以是「在，但看不见」。**

### 9.2 根因：两件事叠在一起

**① 深色底被自己的后一条规则冲掉了。**

`pivot-theme-v2.css` 第 72 行写了：

```css
html, body { background-color: #030712 !important; }
```

但同一文件更靠后的第 98 行又写了（**同等特异性、位置更后 → 后者胜**）：

```css
html, body, #__next, #root, [class*="layout__app"] { background: transparent !important; }
```

于是 `html` / `body` 的计算背景是 `rgba(0, 0, 0, 0)`。而粒子 canvas 的 `paintBackdrop()`
只铺 alpha ≤ 0.05 的淡蓝，**没有任何元素真正画出那块深色底** → 页面回落到浏览器默认白。

**② `mix-blend-mode: screen` 是「变亮」混合，在白底上等于隐身。**

人脸层用的是 `mix-blend-mode: screen`（第 357 行）。screen 的数学是 `1-(1-a)(1-b)`，
**只会把底色提亮**：放在深底上是一张发光的水印脸，放在白底上 `screen` 的结果无限接近纯白 ——
脸就彻底消失了。**这是症状的真正来源，和图片、注入都无关。**

### 9.3 为什么不能简单地「把底改回深色」

因为登录页**不归我们的主题管**：`_spa-auth` 自带一套 **light 模式的 antd `cssVar` 作用域**
（`css-var-_r_2_`），实测：

```json
{"htmlBg":"rgba(0, 0, 0, 0)", "bodyBg":"rgba(0, 0, 0, 0)"}
{"tag":"DIV","cls":"acss-644054","color":"rgb(8, 8, 8)","txt":"登录或注册你的 PivotAI 账号"}
{"cardCls":"css-ch9ese ant-app auth-layout css-var-_r_2_"}
```

标题文字是 **`rgb(8, 8, 8)`（近黑）**。如果强行把底铺成 `#030712`，
**字会一起被吞掉** —— 那是拿一个更严重的问题换一个更轻的问题。

### 9.4 修法：让图层自己适应底色

不再假设底色一定是深的，而是**运行时探测**，再切换混合模式：

- `pivot-theme-v2.js` 新增 `backdropIsLight()`：用 `document.elementsFromPoint(0.85W, 0.5H)`
  （取右侧、mask 最强处）拿到元素栈，**从底往上**找第一个真正画了颜色的元素
  （`backgroundColor` alpha > 0.5），换算相对亮度 `> 0.5` 即判为浅底；
  一个都没画 → 判定为浏览器默认白，**返回 true**。
- `pivot-theme-v2.css` 新增 `.pivot-face-light` 覆盖块：把 `screen` 换成
  **`multiply`（变暗混合）**，配一套更柔的 mask。

> ⚠️ 上面这个「**从底往上**」的遍历方向在 §9.6 被推翻了 —— 它只在 html/body
> 恰好是透明的时候才等价于「用户看到的那一层」。别照着这里抄，见 §9.6 第 3 条。

> 只跳过主题自己的两个元素（`#pivot-face-mat`、`#pivot-particle-canvas`），
> **不要按「有没有 id」过滤** —— 真正画底色的元素往往没有 id，那样会全部跳过、
> 永远落到「返回 true」的兜底分支。

### 9.4b ⚠️ 第一版修法是错的：只采样一次会锁死在错误的模式上

第一版在 `initFaceMat()` 里**只采样一次**就定死。实机切换主题一测就露馅：

```
初始（浅底）      matClass = "pivot-face-light pivot-face-on"   blend=multiply   ✓
切到深色（不刷新） matClass = "pivot-face-light pivot-face-on"   blend=multiply   ✗ 脸又没了
```

**根因是竞态**：`initFaceMat()` 跑的时候应用**还没把持久化的主题应用上去**
（要等 hydration），此刻底色仍是浏览器默认白 → 锁上 `multiply`；
随后应用翻成深色，而 `multiply` 在深底上等于把脸压进黑色 ——
**正是我们要修的那个症状，只是镜像了一遍。**

**改法**：把「采样 + 切类」抽成 `syncFaceBlend()`，并让它持续跟住：

| 触发时机 | 为什么需要 |
|---|---|
| 初始化时立即一次 | 常规路径 |
| 6 个有界定时器（120/400/900/1800/3000/5000 ms） | 主题在 hydration **之后**才落地 |
| `<html>` 上的 `MutationObserver`（class / style / data-theme / data-color-scheme） | 用户**运行时切换**主题就落在这些属性上 |
| `matchMedia('(prefers-color-scheme: dark)')` 的 change | "Auto" 跟随系统 |

`MutationObserver` 回调用 `requestAnimationFrame` 节流（hydration 期间会连发）；
且整体包在 try/catch 里 —— **引擎绝不能把宿主应用搞崩**。

### 9.4c 浅底的不透明度是按算术定的，不是凭手感

`multiply` 在纯白上只能**压暗**：`结果 = 255*(1-a) + p*a`。
旧值 `a = 0.20 × mask峰值 0.78 ≈ 0.156` → 只压暗约 **17/255** 级 ——
DOM 里在、人眼看不见。调到 `0.34 × 0.92 ≈ 0.31`（约翻倍）后轮廓才真正读得出来。

> 顺带一个必须说清的副作用：`multiply` 只能变暗，所以浅底上显现的是图像的
> **暗部结构**（头发、侧脸阴影），不是受光面。这就是浅底那一版把
> `contrast` 调高、`brightness` 略微压低的理由 —— 让暗部结构更明确。

### 9.5 ✅ 视觉确认（2026-10-09 11:0x 完成，四阶段实测）

`docker cp` 三个文件 + `pivot-face.jpg` → `pivot-apply.js`（13 CSS + 5 JS）
→ `docker restart lobechat`。**没走 `up -d`，不需要重建。**

在登录页上真的切换主题，四个阶段逐一读 DOM：

| 阶段 | 触发方式 | `matClass` | blend | opacity | 探测到的底色 |
|---|---|---|---|---|---|
| 1 初始浅底 | 页面加载 | `pivot-face-light pivot-face-on` | `multiply` | 0.34 | `rgb(255,255,255)` |
| 2 切深色 | 点主题菜单，**不刷新** | `pivot-face-on` | `screen` | 0.28 | `rgb(13,13,13)` |
| 3 切回浅色 | 点主题菜单，**不刷新** | `pivot-face-on pivot-face-light` | `multiply` | 0.34 | `rgb(255,255,255)` |
| 4 深色下刷新 | 重新导航 | `pivot-face-on` | `screen` | 0.28 | `rgb(13,13,13)` |

阶段 2/3 证明 **observer 路径**（运行时切换）双向都对；
阶段 4 证明 **init 路径**也对。两种底色下人脸均可见，标题文字均清晰可读。

证据图：`interview-demo/_scratch/face-light-noreload.png`、
`face-dark-reload.png`、对比图 `face-both-sbs.png`；采集脚本 `capture-both.sh`。

> **一个采集坑（值 20 分钟）**：别用 `agent-browser open ... | tail -5`。
> daemon 会继承管道写端，`tail` 永远等不到 EOF，**看起来像浏览器卡死**。
> 重定向到文件再读（`>> "$LOG" 2>&1`）即可。另：`screenshot` 的参数是
> `[selector] [path]`，不是 `[path]`。

**排查用的两条命令**（不用截图也能判断有没有生效）：

```bash
# 1) 规则进没进包（注意容器内是 BusyBox grep，不支持 --include=）
docker exec lobechat grep -rl "pivot-face-light" /app/public | head
docker exec lobechat grep -rl "syncFaceBlend"    /app/public | head
# 2) 页面里元素的 class（浏览器控制台）—— 深色下应【不含】pivot-face-light
#    document.getElementById('pivot-face-mat').className
```

### 9.6 ✅ 2026-10-09 中午：底色定为「始终黑」，顺带修掉 §9.4 里方向反了的遍历

上午按用户要求做过一版「白底 + 浅绿星场」（§1.6.2）。中午用户改口：
**「还是不用白底，用黑底吧」**。绿色主色保留，只把底色定死为黑。

结果这变成了第三个独立根因 —— 前两个（§9.2）修完，登录页仍然是白的。

#### 9.6.1 根因三：LobeChat 在「没存过主题」时默认 light

探针 `_scratch/probe-theme-store.sh` + `verify-theme-boot.sh` 实测：

| 会话状态 | `localStorage.theme` | `html[data-theme]` | `<html style>` |
|---|---|---|---|
| 全新（无存储） | `null` | `light` | `color-scheme: light;` |
| 写入 `dark` 后重开 | `dark` | `dark` | `color-scheme: dark;` |
| 写入 `auto` 后重开 | `auto` | `auto` | （无内联样式） |

**结论**：主题偏好存在 `localStorage.theme`（值 `dark` / `light` / `auto`），
app 在**启动时**读它；而「没有这个 key」时的默认值是 **light**。
所以一个干净的浏览器打开 :3210 就是白底 —— 不是「用户存过浅色」，是**默认就浅**。
headless Chromium 的 `prefers-color-scheme` 也是 light，`auto` 同样落到白。

#### 9.6.2 根因四：CSS 里 `html, body` 被自己后面的规则冲掉了

```css
html, body { background-color: #030712 !important; }        /* 第 74 行 */
…
html, body, #__next, #root, … { background: transparent !important; }  /* 第 100 行 */
```

两条**同特异性**，同特异性下后者胜 → `html`/`body` 实际是 `transparent`，
整页底色回落到浏览器默认白。实测四个阶段 `htmlBg`/`bodyBg` 全是 `rgba(0, 0, 0, 0)`。

（第 100 行的本意是「把中间容器打通，让星场透出来」，但把 html/body 也列进去就过头了。）

#### 9.6.3 修法

| # | 改动 | 文件 |
|---|---|---|
| A | 把 `html, body` 从第 100 行那条透明规则里**删掉**，只留中间容器 | `pivot-theme-v2.css` |
| B | 引擎在 `vendor-ui-runtime` 里**抢先**种下 `localStorage.theme='dark'`（只补 `null` 与 `auto`，用户显式选过 light/dark 就不动） | `pivot-theme-v2.js` 第 0 节 |
| C | `backdropIsLight()` 换判定顺序 + 修遍历方向（见下） | `pivot-theme-v2.js` |

B 之所以能生效：注入的 JS 落在 `vendor-ui-runtime-*.js`，**早于业务模块求值**，
所以写 localStorage 时主题模块还没读。实测全新会话直接 `data-theme="dark"`。

#### 9.6.4 被 B/A 暴露出来的 bug：`backdropIsLight()` 的遍历方向反了

A 一落地，四阶段测试立刻全变成 `screen` —— **浅色模式下人脸又消失了**。

原因：`backdropIsLight()` 原本**从底往上**遍历元素栈，取第一个画了底色的元素。
这在 html/body 透明时恰好等于「用户看到的那层」；一旦 html/body 有了真实底色，
遍历**永远停在 html**，于是**无论页面多白都返回「深色」**。
这是 §9.4 埋的雷，被 A 踩响。

改法（优先级从高到低）：

1. 先信 **app 自己声明的主题**：`<html data-theme>`（`light`/`dark`/`auto`），
   再看内联 `color-scheme`（`documentElement.style.colorScheme` —— 只读内联属性，
   所以我们自己那条 `html { color-scheme: dark !important }` **不会污染**它）；
2. 都没有（`auto`）→ 跟 `prefers-color-scheme`；
3. 最后才退回采样，且**改为从顶往下**遍历，并加**覆盖面积过滤**
   （小于半屏的元素视为「按钮/卡片」而不是「底色」）。

#### 9.6.5 ✅ 四阶段复测（2026-10-09 12:3x）

| 阶段 | 触发 | `data-theme` | `matClass` | blend | opacity |
|---|---|---|---|---|---|
| 1 初始 | 页面加载 | `dark` | `pivot-face-on` | `screen` | 0.28 |
| 2 切浅色 | 点菜单，**不刷新** | `light` | `pivot-face-on pivot-face-light` | `multiply` | 0.34 |
| 3 切回深色 | 点菜单，**不刷新** | `dark` | `pivot-face-on` | `screen` | 0.28 |
| 4 深色下刷新 | 重新导航 | `dark` | `pivot-face-on` | `screen` | 0.28 |

阶段 1 现在**直接就是深色**（B 生效）；2/3 证明 observer 双向仍对；4 证明 init + 持久化对。

**另测**：登录后的 `/onboarding` 也是深色（人脸 + 星场都在），
即**认证后的主界面同样是深色** —— 不只是登录页。

证据：`_scratch/dark-auth-1.png`、`face-dark-auth.png`、`face-light-noreload.png`、
`chat-dark-2.png`（onboarding）。脚本：`verify-dark.sh`、`capture-both.sh`、`chat-login.sh`。

#### 9.6.6 顺手记两条

- **注入命令必须加 `MSYS_NO_PATHCONV=1`**。Git Bash 会把 `docker exec … node /tmp/x.js`
  里的 `/tmp/x.js` 改写成 `C:/Users/…/Temp/x.js`，报 `Cannot find module`。
  （`docker cp host lobechat:/tmp/x` 因为带冒号反而不受影响 —— 所以文件其实早就拷进去了，
  只有 `exec` 那一步在炸，很容易误判成「拷贝失败」。）
  已封装成 `_scratch/reinject.sh`，含人脸底图的按需拷贝。
- **登录页左上是 `LobeHub` 的 SVG logo，品牌替换换不掉**。
  `replaceBrandText()` 只改文本节点，logo 是矢量图形 → 出现「左上 LobeHub / 右上 PivotAI」
  的品牌不一致。**已知缺口，未修**（要换得改 SVG 或做遮罩）。

