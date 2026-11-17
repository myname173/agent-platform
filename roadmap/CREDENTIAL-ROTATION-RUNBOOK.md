# 凭证轮换与交付准入 Runbook（ISSUE-A1 / A2）

> **本文件是人工操作清单，不是已执行记录。** 轮换真实凭证必须改 `.env` 与容器，而 `AGENTS.md:394` 明确「任何人不要编辑 `.env`」、`:395`「部署 / 重启 / 冒烟同一时刻只允许一方在跑」。
> **状态更新（2026-11-11）：`A1b` 真实凭证轮换已由用户决定不执行** —— **非完成、非阻塞项**。本文件保留清单与风险登记，供用户后续改变决定时使用；不因「不执行」而宣称风险已消除。

## 1. 背景（必须先理解）

`AGENTS.md:326-330`（§12）：`a0bcb35` 把真实 Postgres 密码写进 `scripts/check-users.mjs`，把真实 MCP Bearer token 与 Telegram chat id 写进 `demo-assets/_data.json`；`ce4a98b` 从工作树移除，**但值仍在 git 历史**。2026-11-09 复核仓库已是 **public**，匿名可拉取该提交的内容，且 `a0bcb35` 仍是 `main` 的祖先。

三条不可绕过的判断：

1. **删文件不算修好**，**翻私有也只缩小暴露面、不撤销已公开的一个多月**。
2. **技术上的处置 = 轮换这些值**；是否重写 git 历史由人决定（`git show ce4a98b`），本项目不擅自重写。**但用户已决定 `A1b` 不执行**，因此这里只能做「风险保留登记」：公开历史值在现网仍可能有效，配置加固不会让它们失效。
3. 若后续改变决定，轮换要在 §14 的单一窗口内完成：另一 agent 不在 deploy / 重启 / 冒烟。

## 2. 轮换清单（**按用户决定不执行**，保留供后续决定）

以下 7 项**当前不执行**，`☐` 保持原样，不代表待办阻塞。若用户后续决定恢复轮换，按顺序执行、每项记录时间，并同步更新 §6 / §7 与 `ISSUE-BACKLOG.md` 的 `A1b` 状态。

| # | 值 | 影响面 | 轮换动作 | 完成 |
| --- | --- | --- | --- | --- |
| 1 | `POSTGRES_PASSWORD` | postgres / n8n / backup / runtime / 迁移脚本 | 改 `.env` → 同步改 Postgres 内已存密码或重建卷（**先备份**）→ 重启依赖服务 | ☐ |
| 2 | `MCP_API_KEY` | `mcp-server.json` 的 Bearer、所有外部 MCP 客户端 | 生成新值 → 改 `.env` → 更新客户端配置 → 验证 `/webhook/mcp` | ☐ |
| 3 | Telegram bot token / `TELEGRAM_CHAT_ID` | `telegram-bridge.json` | 在 BotFather 重置 token、确认 chat id → 改 `.env` | ☐ |
| 4 | `CHAT_API_KEY` / `N8N_API_KEY` | 网关、控制台 BFF、LobeChat 的 `OPENAI_API_KEY`、runtime key | 三处**一起**轮换（`.env.example:18-25` 明确要求一起改） | ☐ |
| 5 | `LOBECHAT_ACCESS_CODE` | 控制台访问码 | 换成 ≥16 字符随机值；**换完才能启用 `--strict`**（见 §4） | ☐ |
| 6 | `N8N_ENCRYPTION_KEY` | 已存 n8n credentials 的可解密性 | **不要误改**：改了已有凭据会解不开（`.env.example:9-12`）。只在确认无存量凭据或准备重建时动 | ☐ |
| 7 | `SEARXNG_SECRET` | 搜索实例会话签名 | `openssl rand -hex 32` 生成后写入客户 `.env` | ☐ |

若恢复轮换，验证命令：

```bash
bash scripts/secret-scan.sh                      # 全量：committed 命中应只剩历史，不得有新增
bash scripts/secret-scan.sh --self-test         # 闸门双向可判
bash scripts/secret-scan.sh --added origin/main..HEAD --strict   # 对外交付闸门
node n8n/scripts/validate-workflows.mjs        # workflow 结构 + compose/env 一致性
```

`--strict` 是新增的可选模式：敏感键名（`KEY|TOKEN|PASSWORD|SECRET|ACCESS_CODE|CREDENTIAL`）即使短于 16 字符也按 `cred` 处理，补上 `monitoring/env-ledger-2026-11-05.md:47-48` 记录的短值盲区。默认不开启，因为 `LOBECHAT_ACCESS_CODE` 的旧值同时是 namespace / 包名，一刀切会让每个提交都命中、闸门被 `--no-verify` 绕过。**第 5 项未轮换前不要启用 `--strict`**。

## 3. 已在仓库内落地的加固（无需人工窗口）

| 项 | 改动 | 验证 |
| --- | --- | --- |
| 短值盲区 | `scripts/secret-scan.sh` 新增 `--strict` + `build_pairs(envfile)`；`--self-test` 增合成用例双向断言 | `bash scripts/secret-scan.sh --self-test` |
| SearXNG 弱密钥 | `searxng/settings.yml:40` 由 `n8nsecretkey123` 换成安装级强随机值；compose 注入 `SEARXNG_SECRET`；`.env.example` 声明 | 搜索 `/search?q=test&format=json` 仍返回非零结果 |
| 镜像漂移 | 5 处 `:latest` 参数化为 `.env.example` 的 `*_VERSION`（默认沿用当前 tag，不臆造版本号） | `node n8n/scripts/validate-workflows.mjs` |
| 快速启动 | README 补 `docker network create n8n-net` / `docker volume create n8n_data`，纠正 D1/D3/D4 数字 | 全新机器按 README 从 clone 到 health 200 |
| backup 最小权限 | `docker-compose.yml` 的 backup 服务加 `no-new-privileges`；见 §5 设计取舍 | `docker compose config -q` |

**这些只是降低暴露面与冻结配置，不能让已公开的历史值失效。**

## 4. 发布配置边界冻结（ISSUE-A2）

沿用 `monitoring/production-closeout-plan-2026-10-30.md:18-29` 的 6.5A 口径：**只在配置与文档层改动，不启用新业务链路**。

- 固定镜像 tag 的正确顺序是「先记录当前实际 digest → 再写进 `.env.example` → 再部署验证」。仓库里**不能直接硬写一个未经验证的版本号**，否则会把现网拉到一个没跑过的镜像上。先把 5 个 tag 抽成变量，记录 digest 的命令写进 `deploy/one-click/README.md`，人工确认后再定值。
- `n8n-net` / `n8n_data` 是 `external: true`（`docker-compose.yml:659-667`），全新机器直接 `up -d` 会失败；README 快速启动已补创建步骤，`deploy/one-click/` 提供脚本。
- 默认 profile 边界保持 6.5A 的检查结果：Kafka / Outbox / Prometheus 各自隔离，不随默认栈启动。

## 5. 一处明确的设计取舍（不要偷偷"修"）

`AGENTS.md:321`（D14）记录 backup 容器只读挂载整个 `.env`（`docker-compose.yml:617`）。核验后发现这不是可以随手删的挂载：

- `backup/backup.sh:65` 把 `docker-compose.yml + .env` 打进 `config-n8n-data-*.tar.gz`，注释明写 **self-contained restore**；
- `migration/restore.sh:51` 要求恢复包里 `.env` 落地，否则 `die ".env did not land in $TARGET"`。

直接移除挂载会让备份产物失去自包含恢复能力，属于用「看起来更安全」换「真实可用性下降」。因此采用**补偿控制 + 显式登记**，而不是假装修好：

1. backup 服务加 `security_opt: ["no-new-privileges:true"]`，降低容器内提权读取的面；
2. backup 不暴露任何端口（现状），且 `.env` 已 `:ro`；
3. **对外交付客户时**：备份产物必须加密（`age` / `openssl enc`，密钥不落同一台机器），恢复时由客户单独注入 `.env`；这一条写进 `roadmap/COMPLIANCE-CHECKLIST.md`；
4. 若首个客户明确要求「容器内零密钥」，则在 `deploy/one-click/` overlay 里改成挂载脱敏配置快照并单独走密钥注入 —— 属于新增能力，不动现网基线。

## 6. 验收状态（单列：配置加固 ≠ 完成轮换）

**`A1b` 已由用户决定不执行；本轮授权不包含改共享运行环境或执行真实凭证轮换。**

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 配置加固（`secret-scan.sh --strict` 自检、SearXNG 强默认值、backup `no-new-privileges`、5 处镜像 tag 参数化、README 数字纠正、一键部署 bootstrap） | 已在仓库内落地 | 只降低暴露面与冻结配置，**不等于**凭证已轮换 |
| Runbook（7 项清单、顺序、验证命令） | 已产出 | 人工操作清单，**不是**执行记录 |
| **真实凭证轮换 + 依赖同步验证（`A1b`）** | **按用户决定不执行（非完成、非阻塞）** | §2 表格 7 项全为 ☐；**公开历史值在现网仍可能有效，风险保留登记，不由本文件消除** |
| `A1b` 的完成标记 | **不标完成** | 状态文字为「按用户决定不执行」，不是「已完成」，也不再是必做阻塞项 |
| `A1a` / `A2` | 已完成 | 配置加固 + Runbook + 配置边界冻结 |

`A1a`（配置加固）与 `A1b`（真实轮换）仍是**两个独立验收单元**。由于 `A1b` 按用户决定不执行，todo `security-release-freeze` 与 M1 门槛**不再以轮换为通过条件、也不再被它阻塞**；但必须显式登记上述残留风险。若用户之后改变决定，按 §2 执行并回来把本节与 M1 门槛改回「以轮换验证为通过条件」。

## 7. 验收门槛（M1）

- **A1b 按用户决定不执行**（非完成、非阻塞）；公开历史值仍可能有效，**风险保留登记**；
- 凭证轮换 Runbook 完成（`A1a`）；
- `bash scripts/secret-scan.sh --added origin/main..HEAD --strict` 零高危（注意：`--strict` 在第 5 项未轮换前不启用，此条按默认模式验证）；
- `node n8n/scripts/validate-workflows.mjs` 全绿（compose 里每个 `${VAR}` 都在 `.env.example` 有声明）；
- 全新机器按 README 从 clone 到 health 200 ≤ 30 分钟，无需人工改 IP、无需 UI 建 key；
- README 开头数字与 `AGENTS.md` 一致（12 服务 / 26 workflow / 43 webhook / 16 静态工具 / 26 张表定义）。
