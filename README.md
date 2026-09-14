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
| Kiranism | 3000 | 运营管理后台（Next.js dev server） |
| SearXNG | 8080 | 搜索引擎（供 n8n 工具链调用） |
| Postgres 17 | 5432（仅内网） | n8n + LobeHub 数据库（pgvector / pg_search，不在宿主机暴露端口） |

## 快速启动

### 1. 启动基础设施服务（n8n + SearXNG + LobeChat）

```bash
cd agent-platform
docker compose up -d
```

### 2. 启动管理后台（开发模式）

```bash
cd frontent
pnpm install    # 首次需要
pnpm dev        # 启动 Next.js dev server → http://localhost:3000
```

### 3. 访问各服务

- **n8n 工作流编辑器**：http://localhost:5678
- **LobeChat 对话界面**：http://localhost:3210
- **Kiranism 管理后台**：http://localhost:3000

## 环境变量

### frontent/.env.local

```bash
NEXT_PUBLIC_N8N_URL=http://localhost:5678   # n8n 地址
N8N_API_KEY=<your-n8n-api-key>              # n8n Public API Key

# Clerk 身份认证
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

### LobeChat（通过 docker-compose 环境变量配置）

LobeChat 的自定义模型服务商已在 `docker-compose.yml` 中预配置，指向 n8n 的 OpenAI 兼容 Webhook。

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
   - **Agent 工具循环**（优先级 5）：请求携带 web_search（SearXNG 公网）与 kb_search（私域知识库）
     两个工具，模型自主决定是否/用哪个搜索；最多 2 轮工具调用，第 2 轮后强制收口；
     usage 跨轮累计计入成本；工具故障时降级为错误说明回答；响应新增 `tool_rounds` 字段
     搜索；最多 2 轮工具调用，第 2 轮后强制收口；usage 跨轮累计计入成本；SearXNG 故障时
     降级为无搜索回答；响应新增 `tool_rounds` 字段（0 = 直接回答）
   - 任何失败统一返回 `{error:{message,type,code}}` + 400/401/404/502
4. 每次执行写入 Data Table `chat_executions`（session/model/client/status/latency/tokens），
   对话轮次写入 `chat_messages`

### 管理链路（Kiranism → n8n API）
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
bash n8n/scripts/backup.sh            # 备份 n8n_data 卷 + Postgres 逻辑导出 + compose/.env
bash n8n/scripts/backup.sh 30         # 保留最近 30 份
bash n8n/scripts/backup.sh restore backups/n8n-data-XXXX.tar.gz   # 恢复卷（会停 n8n 并清空卷）
```
每次备份生成三件：`n8n-data-*.tar.gz`（卷：n8n 配置与旧 SQLite 回滚件）、
`pg-n8n-*.sql.gz`（数据库主存储逻辑导出）、`config-*.tar.gz`（compose + .env）。
Postgres 恢复：`gunzip -c backups/pg-n8n-*.sql.gz | docker exec -i postgres psql -U n8n -d n8n`。
归档含凭据与对话数据，妥善保管。

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
- PivotAI 主题（custom-theme/ + apply-theme.ps1）是 v1 资产，LobeHub 2.x 的样式结构不同，适配待做
- 文件存储（S3）未配置：图片/文件类消息受限，纯对话不受影响

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


## PivotAI 前台视觉与动效系统 (Cyber Glassmorphism & Aurora)

前台已升级为年轻、高辨识度的 **PivotAI** 沉浸式赛博流光视觉风格：
- **品牌与 Slogan**：PivotAI | 从对话到执行 / Chat less. Ship more.
- **色彩规范**：主色 `#3B82F6` (Electric Blue)，强调色 `#06B6D4` (Cyan)，背景 `#030712` (Cyber Deep Black)
- **核心动态与交互**：
  1. **流动 Aurora 渐变光斑**：60fps WebGL/Canvas 极光流转背景，支持鼠标平滑视差（Parallax）
  2. **磨砂玻璃拟态 (Glassmorphism)**：侧边栏、卡片、输入框高斯模糊与高光描边，hover 微浮起
  3. **顺滑气泡动效**：用户与 AI 回复消息平滑滑入；AI 消息具备微光呼吸感
  4. **光感按钮反馈**：按压缩放（Scale）与蓝青流光（Glow）
  5. **输入区聚焦增强**：输入框聚焦激活蓝青多层光晕与高光轮廓
  6. **会话切换平滑过渡**：告别生硬闪切，全组件保持 60fps 顺滑物理阻尼

### 重装或重新应用主题
```powershell
powershell -ExecutionPolicy Bypass -File apply-theme.ps1
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
│   └── pivot-theme.js        #   60fps 极光视差与品牌动态引擎
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
