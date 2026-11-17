# 一键部署（默认栈 bootstrap + 客户交付步骤）

> 状态：**M1 的 fresh-machine 引导已可用**；客户交付的**配置与步骤已整理**，**实际部署验收仍需隔离目标** —— 本轮未执行任何部署、重启或冒烟。
> 边界：本目录只新增文件，**不改基 `docker-compose.yml` 的语义**（`roadmap/DECOUPLING-CONTRACT.md` R2）；不写共享 `.env`；**不启用任何 AD-1 未决能力**（R7）。

## 1. 用法（现有脚本）

```powershell
# 只读检查：docker CLI、.env、frontent/.env.local、external 资源是否齐备
pwsh deploy/one-click/bootstrap.ps1 -Action check

# 幂等创建 n8n-net / n8n_data，并启动默认 12 个常驻服务
pwsh deploy/one-click/bootstrap.ps1 -Action up
```

等价手工步骤已写进 `README.md` 快速启动：

```bash
docker network create n8n-net
docker volume create n8n_data
docker compose up -d
```

脚本**不读取、不打印、不编辑 `.env`**（`AGENTS.md` §14.5）。`-Action up` 是唯一触碰共享 Docker 栈的命令，执行前必须确认另一 agent 不在 deploy / 重启 / 冒烟（§14.5）。

## 2. 为什么需要它

`docker-compose.yml:659-667` 把网络 `n8n-net` 与卷 `n8n_data` 声明为 `external: true`，Compose 不会自动创建。全新机器直接 `up -d` 会中止 —— 旧版 README 快速启动漏写这一步（`AGENTS.md` §1.3）。

## 3. 每客户交付配置清单

| 项 | 做法 | 约束 |
| --- | --- | --- |
| 客户 `.env` | 从 `.env.example` 复制后**逐项填真实值**；不复用示例值、不复用其他客户的 `.env` | 不进 git、不进备份明文；`AGENTS.md` §14.5 不编辑共享 `.env` |
| `SEARXNG_SECRET` | 每客户独立生成：`openssl rand -hex 32` | 实例本地会话签名，非外部凭证；`searxng/settings.yml` 的默认值只供本机 Pilot |
| 网关 / API 密钥 | `CHAT_API_KEY`、`N8N_API_KEY`、`MCP_API_KEY` 等每客户独立 | 与 `LOBECHAT_OPENAI_API_KEY` 一起轮换（`.env.example:18-25`） |
| 5 个 `*_VERSION` | 默认值沿用当前已知可跑 tag；定值前先记录实际 digest（§4 Step 3） | **不要硬写没跑过的版本号** |
| 控制面 / 计量开关 | `PLATFORM_CONTROL_PLANE_ENABLED=false`、`PLATFORM_METERING_ENABLED=false` **保持关闭** | AD-1 未决、R7 禁止预建；客户 overlay 也不得顺手打开 |
| 备份产物 | 对外交付时加密（密钥异地保存），恢复时由客户单独注入 `.env` | 见 `roadmap/CREDENTIAL-ROTATION-RUNBOOK.md` §5 |

> `CREDENTIAL-ROTATION-RUNBOOK.md` 的 7 项轮换清单适用于**已泄露的历史值**；客户交付按本表生成全新值，两者不是同一件事。

## 4. 交付步骤（顺序；标注本轮未执行的部分）

| Step | 动作 | 状态 |
| --- | --- | --- |
| 1 | `bootstrap.ps1 -Action check`：确认 docker、客户 `.env`、`frontent/.env.local`、external 资源 | 文档已就绪，未执行 |
| 2 | 客户环境准备：生成独立密钥、填 `.env`、确认端口占用 | 文档已就绪，未执行 |
| 3 | 镜像定值：记录实际 digest，再由人决定是否把 `*_VERSION` 改成固定 tag | 需人工确认 |
| 4 | `bootstrap.ps1 -Action up` 启动默认栈 | **需隔离目标 + 人工协调窗口，本轮未执行** |
| 5 | 导入 26 个 workflow（源码即工作流）与所需 data table | **不做全量 deploy**（`AGENTS.md:411` 会覆盖线上漂移），需隔离目标 |
| 6 | 上线验收：health 200、KB schema、selfcheck、客户上线耗时计时 | **需隔离目标，本轮未执行** |

Step 3 的记录命令：

```powershell
docker compose config --images
docker image inspect <image> --format '{{index .RepoDigests 0}}'
```

把确认过的 digest 写进交付清单，再由人决定是否定值到 `.env.example`。详见 `roadmap/CREDENTIAL-ROTATION-RUNBOOK.md` §4（Phase 6.5A 配置冻结）。

## 5. 验收前置条件（缺一不可）

- 独立的目标环境（不复用共享 Docker 栈 / `.env` / 数据库）；
- 与另一 agent 协调部署窗口（同一时刻只允许一方 deploy / 重启 / 冒烟）；
- 不做全量 `deploy.mjs`，只导入该客户需要的 workflow 与表；
- 稳定域名 / TLS / 边缘限流就位前，不暴露 Postgres / Redis / n8n 管理端口；
- 客户上线耗时（clone → health 200 → 首个任务成功）可测量，目标 ≤ 1 天。

> 这些条件与 `roadmap/EVAL-ACCEPTANCE-PRECONDITIONS.md` 的「隔离目标」是两类不同的隔离环境：eval 用隔离栈，客户交付用独立客户环境，不要互相冒充。

## 6. 回滚

- 默认栈：`docker compose down` 后按 `monitoring/production-closeout-plan-2026-10-30.md` 的 6.5A 回滚方式恢复；控制面/计量开关默认关，不存在额外回滚动作。
- 客户 overlay（未来新增时）：删掉该环境变量并重启对应服务；overlay 只叠加、不改基 compose 语义，失败时直接不加载 `-f` 叠加文件即可。
- 文档与 overlay 属于「独立部署 overlay」，按 `ISSUE-BACKLOG.md` §7 不套运行时 flag / 逐字节等价的仪式。

## 7. 与 AD-1 的边界

**客户 overlay 不显式启用控制面 / 计量开关**。上一版待办里写的「显式启用控制面 / 计量开关」与 AD-1 未决、R7 冲突，已移除。若 `roadmap/AD1-PILOT-EVIDENCE.md` 的结论确认为共享多租户，再另立 overlay 与 `D0'` 设计，不在本目录预埋。

## 8. 剩余待办（ISSUE-E3）

- [ ] `docker-compose.customer.yml` overlay：仅叠加客户专属配置，不启用未决能力
- [ ] 客户 `.env` 生成清单脚本化（只生成模板，不写真实值）
- [ ] 备份产物加密 + 密钥异地保存
- [ ] 稳定域名 / TLS / 边缘限流，不暴露管理端口
- [ ] 上线 runbook 与合规检查单（客户上线耗时 ≤ 1 天）
