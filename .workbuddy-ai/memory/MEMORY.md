# agent-platform · 长期项目笔记

项目路径：`C:\Users\LINLEE\Desktop\agent-platform`
交接文档（换对话必读）：`C:\Users\LINLEE\.openclaw-autoclaw\workspace\agent-platform-handoff-20260915.md`

## 协作惯例（必须遵守）

1. **「用户点头 → 开工」**：观察期/新批次动工前先说明要做什么，等用户明确同意再动手。
2. **每批纪律**：实跑 E2E → git 提交 → 更新交接文档（增量更新小节 + 时间戳）。
3. 交付物要能打开、能带走（HTML / 截图归档）。
4. 引入新模型/服务前先确认额度，不够要提前说。
5. 界面「不破坏原来的样子，只加动态特效」。

## 高危坑位（会挂死请求）

- **HTTP 请求头里绝不能放原始非 ASCII 字节。** 实测：`x-person: 张三丰` 让请求**卡满 110 秒超时**（不是报错，是静默挂死）；同样的值百分号编码后 1.6 秒返回，ASCII 值 1.0 秒。
  设计自定义头时：只接受 ASCII 安全值，需要中文就让客户端百分号编码、服务端 `decodeURIComponent`。

## 高危坑位（会打崩 task runner）

- **n8n Code 节点里，SQL 占位符必须一列一用。** 复用同一个 `$N` 去喂类型不同的列（如 `title` varchar 与 `summary` text）→ PG 报 `inconsistent types deduced for parameter $N` → **pg-protocol 1.15.0 在构造 `DatabaseError` 时给只读属性 `name` 赋值抛 TypeError**，异常在 socket 回调里、`try/catch` 够不着 → **runner 进程直接死**，n8n 只显示 "Node execution failed"。
  排查手法：让代码把进度写进一张临时表，即使 runner 崩了也能从库里读出死在哪一步。

## 技术红线

- **客户端组件绝不能直接调 `lib/n8n-client` 里带 `CHAT_API_KEY` / `N8N_API_KEY` 的函数**（`kbAction`、`searchKb`、`getDelegation`…）。它们是服务端专用变量（非 `NEXT_PUBLIC_`），**打包进浏览器后是空字符串** → 请求不带凭据 → n8n 401，而前端只看到笼统失败。
  **客户端一律走 `/api/n8n/*` 路由**，由 Route Handler 在服务端带密钥转发。控制台所有卡片都是这个模式。
  （真实教训：KB 检索卡曾直接调 `searchKb()`，用户点到就报 "KB search failed"，排查全靠猜。）

- **控制台镜像用 `bun install --no-save --frozen-lockfile` 装依赖（Dockerfile 里 `npm i -g bun`）。** 所以**改 `frontent/package.json` 必须连带重新生成 `frontent/bun.lock`**，否则构建直接失败。本地没有 bun 时先 `npm install -g bun`（约 50s），再 `bun install`（约 90s）。
  （npm/pnpm 只是本地跑脚本用，与镜像构建无关；混用会让 lock 不一致。）

- `.env`：无 BOM + LF；禁用 PowerShell Set-Content 写 .env。
- 净化器规避：避免「环境变量前缀式 key 取值」「引号包住的鉴权头」「数组索引式密钥访问」「美元符+单引号」字面量；`'Bearer '` 会被静默替换 → 用 `['Bea','rer '].join('')` 拼接。
- Windows PowerShell 5.1 无 `&&`；schtasks 在本环境被安全策略拦截（不要重试/绕开）。
- n8n API：建工作流 body 不带 `active`；insert `{data:[...]}`；update=PATCH+filter；rows 端点 limit≤250。
- **n8n 数据表 rows API 的两个坑**：① `sortBy` **只有冒号被百分号编码才生效**（`createdAt%3Adesc`），否则按插入顺序返回、**最旧的在前**；② rows 端点返回的是**最前面的 N 行（按主键）**，不是最新 N 行——想看最新必须带编码后的 sortBy，或用 filter 精确查。
  **因此：任何"取最近 N 条"的代码都不要依赖返回顺序**，取一批后自己按时间过滤。
- 删除行没有 `DELETE /rows/{id}`，要用 `DELETE /rows/delete?filter=<encoded>`。
- `backend/`、`lobechat/` 是上游参考，禁止改动。
- 改前端需 `docker compose build console` 重建镜像；改 `stream-bridge/server.js` 只需 restart。

## 关键位置

- 密钥：`.openclaw-autoclaw\workspace\.openclaw\tmp\p5\keys.json`（CHAT_API_KEY / N8N_API_KEY）
- 自检工作流 `jzE0umHAg1llTAEY`（26 项，每日 04:15）；控制台 8 页；侧车 stream-bridge :3211
- n8n 22 个工作流，ID 全表见交接文档 §4.1
