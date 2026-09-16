# Agent Platform

统一 AI Agent 中台平台，以 **n8n** 为核心工作流引擎，串联 **LobeChat**（用户对话前台）与 **Kiranism**（运营管理后台）。

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

### LobeChat（通过 docker-compose 环境变量配置）

LobeChat 的自定义模型服务商已在 `docker-compose.yml` 中预配置，指向 n8n 的 OpenAI 兼容 Webhook。S3 文件存储已接线（`S3_ENDPOINT` → MinIO），详见「文件存储（MinIO）」一节。多模态与网关模式：`deepseek-v4-flash` 已声明 vision；客户端按网关设计配套（Responses API 关、联网搜索关、流式输出关、记忆暂关），图片由网关内联后转上游。

## 数据流说明

### 对话链路（LobeChat → n8n Chat Gateway → 大模型）
1. 用户在 LobeChat 发送消息
2. LobeChat 以 OpenAI 协议 POST 到 `http://n8n:5678/webhook/v1/chat/completions`
   （鉴权：`Authorization: Bearer sk-n8n-agent`，与 compose 中 LobeChat 的 `OPENAI_API_KEY` 一致）
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
Authorization: Bearer sk-n8n-agent
```
返回总量/成功率/平均延迟/按模型与客户端分布/独立会话数/成本聚合
（total/24h/7d/按模型/按 key，USD）与最近 20 条执行（含 key_name、cost_usd）。
Kiranism 需要时在 `frontent/src/app/api/n8n/` 下加一条服务端路由代理即可（已有三条路由不受影响）。

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
恢复参考：`gunzip -c backups/pg-n8n-*.sql.gz | docker exec -i postgres psql -U n8n -d n8n`；
`gunzip -c backups/pg-lobechat-*.sql.gz | docker exec -i postgres psql -U n8n -d lobechat`；
MinIO：停 minio 后把归档解回 `minio_data` 卷。每日 03:30 计划任务自动执行（含四项完整性检查）。
归档含凭据与对话数据，妥善保管。

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
