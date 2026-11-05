# 运行 `.env` 键位台账核对（2026-11-05）

本文档不含任何密钥值。只记键名、在 `.env` 中的行号，以及「已填 / 空」状态；核对过程中没有把任何取值写进命令参数或输出。

## 结论

本轮只核对**本机** `.env`（`C:\Users\LINLEE\Desktop\agent-platform\.env`，6981 字节，未跟踪，`.gitignore:12-13` 覆盖 `.env` 与 `.env.*`，`git ls-files .env` 与全历史均为 0 命中）。它是 `.env.example` 的 93 个声明键里落地的那一份：实有 62 个赋值行、61 个唯一键、60 行有值。15 个关键键全部已填（`CHAT_API_KEY`、`N8N_API_KEY`、`N8N_ENCRYPTION_KEY`、`MCP_API_KEY`、`DASHSCOPE_API_KEY`、`UPSTREAM_API_KEY`、`POSTGRES_PASSWORD`、`MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD`、`AUTH_SECRET`、`KEY_VAULTS_SECRET`、`JWKS_KEY`、`TELEGRAM_BOT_TOKEN`、`PLATFORM_LAN_IP`、`CONSOLE_CLERK_PUBLISHABLE_KEY`），所以栈能起来。

入账的两条都不是启动阻塞项，而是**静默失真**类：一条是空值让某个出口不投递且不报错，一条是同名键写了两遍、实际生效的那条取决于加载器的取值顺序。

## 明细

### 1. `ALERT_WEBHOOK_URL` 为空 → 告警出站静默丢弃

现象：`.env` 第 58 行 `ALERT_WEBHOOK_URL=`，等号后为空（实测原始行尾只有 `=`，没有注释或引号）。

注入路径：`docker-compose.yml:91` 写作 `- ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL:-}`，带 `:-` 兜底，所以缺值不会让 compose 报错，n8n 容器起来后这个变量就是空串。

影响面：`n8n/workflows/notify.json` 与 `n8n/workflows/chat-alerts.json` 是这条出口的调用方。空值的结果是错误率/告警类推送没有下游可投递，而链路本身不抛错 —— 也就是"看起来在跑，实际没人收到"。这与 `README.md` 里"错误率看不见 admin webhook"那一类观测盲区同源。

处置建议：要么补一个真实接收端（飞书群机器人 / 自建 webhook），要么显式把它标为"本部署不启用告警外推"，并在 selfcheck 里加一条断言区分「未配置」与「配置了但投递失败」；两者都空着不表态是最坏的一种。

### 2. `ADMIN_PASSWORD_HASH` 在 `.env` 里出现两次

现象：第 80 行为空，第 112 行有值（62 字符长度的哈希，值不外泄）。同一份 `.env` 里同名键赋值两次，61 个唯一键 / 62 个赋值行的差额就是它。

判别试验（不是推断）：在临时目录写一份 `.env`，内容为 `DUP=first-value` 与 `DUP=second-value` 两行，配一个引用 `${DUP}` 的最小 compose 文件，跑 `docker compose config` → 输出 `DUP: second-value`。本机结论：**compose 取同名键的最后一次赋值**。因此现在生效的是第 112 行那份，`monitoring/README.md` 的 Phase 6.1 那段所要求的"真实 `ADMIN_PASSWORD_HASH` 存在才允许 external Caddy edge 启动"目前确实满足。

为什么仍是隐患，两个原因：

- 顺序敏感。谁把第 80 行填上（比如从旧备份恢复、或手动补一份"占位"值），第 112 行就被静忽略，主栈 `docker-compose.yml:640` 的 `${ADMIN_PASSWORD_HASH:-}` 会把错的值传给 caddy，认证行为变了但没有任何报错。
- 两个 compose 文件的失败模式不一致。主栈是 `:-`（缺值→空串，静默）；`deploy/external/docker-compose.external.yml:47` 是 `${ADMIN_PASSWORD_HASH:?ADMIN_PASSWORD_HASH is required}`（缺值→立刻失败）。也就是说删掉第 112 行时，external 边缘会响亮地拒绝启动，而主栈会安静地带着空凭据起 —— 排查时容易只看到"主栈正常"。

处置建议：`.env` 里删掉第 80 行那条空赋值，只保留一份；同时在 `.env.example` 给 `ADMIN_PASSWORD_HASH` 补一句注释，说明 external 叠加层用 `:?` 强制要求它。本轮不自动改 `.env` —— 它不在版本控制里，是运行中栈的实际配置源，改动应当由人手工执行。

## 同批核出、未列入本轮处置的两项

- `.env` 比 `.env.example` 少 35 个键，集中在 event-bus / outbox / runtime / Prometheus 那一批（`PLATFORM_OUTBOX_*`、`PLATFORM_KAFKA_TOPIC`、`PLATFORM_EVENT_*`、`PROMETHEUS_*`、`RETENTION_DAYS_IDEMPOTENCY`、`IDEMPOTENCY_WINDOW_SEC`、`MAX_TOOL_ROUNDS`、`PLATFORM_RATE_LIMIT_RPM` 等），另有刚随上游进来的 `CONSOLE_ADMIN_READ_CACHE_TTL_MS`（`monitoring/management-read-cache-2026-10-30.md` 描述的 3 秒读缓存 TTL）。这些在 compose 里都是 `${VAR:-默认}` 形态，实测"compose 以无默认值形式引用、且 `.env` 缺失"的键数为 **0**（无默认值引用的键共 26 个，全部存在），所以不影响启动，只是全按代码默认值跑。正在做 outbox/kafka 的人要注意：默认值不等于试点时想要的值。
- `.env` 里有 3 个键在 `.env.example` 中未声明：`ZoneID`、`AccountID`、`cloudflare_token`（取值一律不记录）。它们躲得过提交前的密钥闸门，因为 `scripts/secret-scan.sh` 只扫被提交的行，而 `.env` 永不进树。属于"密钥位没有文档化"，不是泄露。

## 扫描器副产物：一条真缺陷与一个闸门盲区

跑 `bash scripts/secret-scan.sh --added origin/main..HEAD` 时，本文档被判了一条 `(cfg) [LOBECHAT_ACCESS_CODE]`。查因（全程不打印该值）：它长度 14、字符类别是「小写 + 连字符」，与仓库目录名同形，所以本文档里引用本机路径时把那串字符带进去了 —— 属于**误报**，不是泄露，且 `git ls-files .env` 与历史都证明值没进过树。

但顺带暴露两件事，值得单独记账：

- 那个访问码本身是一个通用词形状的短值。对话前台的准入若等同「知道项目名」，就不是准入。这里不写出它等于什么，处置方向是改成一个足长随机串，改完注意它是 LobeHub 库内配置、不在 `.env` 之外的任何地方兜底。
- 闸门盲区：`scripts/secret-scan.sh:14` 写的判据是「≥16 字符、非 URL、非裸域名/IP、非纯数字」，实现落在同文件 `classify()`（35–41 行）的 `if (length(v) < 16) return "cfg"`（第 36 行）—— 14 字符的值只会进「配置类、不拦截」区间。也就是说把 LobeChat 访问码写进被提交的文件，这道门**不会拦**。要让它拦得住，阈值需要按值的「熵 / 是否通用词」判定而不是纯长度，或把这类已知短值显式列入凭据名单。

## 验证

- 键位与空值统计：以"逐行匹配 `^\s*键名=`"的解析器数得 62 赋值行 / 61 唯一键 / 2 空值行；两个数字口径不一致时先怀疑尺子，最终定位到重复键，而不是解析漏行。
- compose 取值顺序：见上面判别试验，输入是自己造的假值，与被测栈无关，也不含任何真实密钥。
- `docker compose config` **没有**对本机真实 `.env` 跑过 —— 它会把解析后的值打进输出，与密钥处理纪律冲突，故意不做。
- 未验：现网主机的 `.env` 未核对（本机这份不代表线上）；`node-repl` / n8n 运行时读到的 `ALERT_WEBHOOK_URL` 实际为空串这一点未在容器内确认；`.env.example` 补注释的改动本轮没做。
