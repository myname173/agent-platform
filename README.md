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

## 端口分配

| 服务 | 端口 | 用途 |
| --- | --- | --- |
| n8n | 5678 | 核心工作流引擎（Webhook + REST API） |
| LobeChat | 3210 | 终端用户 AI 对话界面 |
| Kiranism | 3000 | 运营管理后台（Next.js dev server） |
| SearXNG | 8080 | 搜索引擎（供 n8n 工具链调用） |

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
   - 校验 Bearer key（读取 n8n env `CHAT_API_KEY`），失败返回 401 + OpenAI 错误格式
   - 解析 `messages`，映射模型别名（`deepseek-agent` → `deepseek-chat`），未知模型返回 404
   - session 身份：`X-Session-Id` 头 > OpenAI `user` 字段 > anonymous
   - 请求只带单条消息时，自动从 Data Table `chat_messages` 合并该会话最近 20 轮历史（服务端记忆）；
     LobeChat 等全量历史的客户端走透传路径
   - 调用 DeepSeek（60s 超时 + 1 次重试），包装为 OpenAI 标准响应（含真实 token usage）
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
返回总量/成功率/平均延迟/按模型与客户端分布/独立会话数/最近 20 条执行。
Kiranism 需要时在 `frontent/src/app/api/n8n/` 下加一条服务端路由代理即可（已有三条路由不受影响）。

## 工作流管理（源码化）

工作流不再只存在于 n8n 数据库中：

- `n8n/workflows/*.json` — 可部署的 workflow 源码（`chat-gateway`、`chat-stats-api`）
- `n8n/workflows/baseline/` — 重构前旧 workflow 的快照（仅存档，勿部署）
- `n8n/scripts/deploy.mjs` — 部署脚本：按 id 更新或创建 workflow、激活生产 webhook、
  自动创建缺失的 Data Table（`chat_messages`、`chat_executions`）

```bash
export N8N_API_KEY=<your-n8n-api-key>
node n8n/scripts/deploy.mjs
```

修改 workflow 的正确姿势：改 `n8n/workflows/*.json` → 跑 deploy → 验证 → 提交。

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

# 停止并删除数据（⚠️ 谨慎）
docker compose down -v
```

## 目录结构

```
agent-platform/
├── docker-compose.yml        # 统一服务编排
├── README.md                 # 本文档
├── frontent/                 # Kiranism 管理后台 (Next.js 16)
│   ├── src/app/              #   App Router 路由
│   ├── src/features/         #   业务功能模块
│   ├── src/components/       #   公共组件
│   └── src/lib/              #   工具库 (含 n8n-client)
├── lobechat/                 # LobeChat 源码 (可选本地开发)
└── backend/                  # n8n 源码 (当前使用 Docker 镜像)
```
