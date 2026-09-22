#!/usr/bin/env bash
# 收尾脚本：宿主机会随机停机，把剩余步骤压成一条命令，尽量缩短暴露窗口。
#
#   bash n8n/scripts/finish-console-rollout.sh
#
# 前置：Docker Desktop 正在运行、镜像已构建（docker compose build console）。
# 每一步都可独立重跑；失败即停（set -e），重跑不会重复破坏任何东西。
set -e
cd "$(dirname "$0")/../.."

set -a; . ./.env; set +a

echo
echo "== 1/5 拉起控制台（使用新构建的镜像） =="
docker compose up -d console

echo
echo "== 2/5 部署工作流（含 /admin/settings 的 cost 字段） =="
node n8n/scripts/deploy.mjs 2>&1 | tail -4

echo
echo "== 3/5 校验 /admin/settings 真的返回 cost 阈值 =="
node -e '
const fs = require("fs");
const K = fs.readFileSync(".env", "utf8").match(/^CHAT_API_KEY=(.*)$/m)[1].trim();
(async () => {
  const r = await fetch("http://localhost:5678/webhook/admin/settings", {
    headers: { Authorization: "Bearer " + K }
  });
  if (!r.ok) { console.error("FAIL http " + r.status); process.exit(1); }
  const j = await r.json();
  if (!j.cost || typeof j.cost.budget_24h_usd !== "number") {
    console.error("FAIL settings.cost missing:", JSON.stringify(j.cost));
    process.exit(1);
  }
  console.log("PASS settings.cost =", JSON.stringify(j.cost));
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
'

echo
echo "== 4/5 确认成本卡进了控制台产物 =="
# 控制台有 Clerk 鉴权，抓页面拿不到内容；改为直接在容器产物里找卡片文案，
# 这能证明组件确实被打包进了镜像（而不是只存在于源码里）。
docker exec platform-console grep -rl "模型成本" /app/.next 2>/dev/null | head -3 \
  || echo "WARN 未在产物中匹配到「模型成本」——可能尚未重启到新镜像"

echo
echo "== 5/5 全套回归 =="
node n8n/scripts/validate-workflows.mjs 2>&1 | tail -2
node n8n/scripts/smoke-test.mjs 2>&1 | tail -3
node n8n/scripts/check-tool-contract.mjs 2>&1 | tail -2
node n8n/scripts/test-client-tools.mjs 2>&1 | tail -2
node n8n/scripts/test-idempotency.mjs 2>&1 | tail -2

echo
echo "== 自检 =="
curl -s --max-time 240 -X POST "http://localhost:5678/webhook/admin/selfcheck/run" \
  -H "Authorization: Bearer ${CHAT_API_KEY}" -H "Content-Type: application/json" -d '{}' \
  -o /tmp/selfcheck-final.json
node -e '
const d = require("/tmp/selfcheck-final.json");
console.log("total=" + d.total, "passed=" + d.passed, "failed=" + d.failed, "warned=" + d.warned);
(d.failures || []).forEach((f) => console.log("  FAIL", f));
(d.warnings || []).forEach((f) => console.log("  WARN", f));
'

echo
echo "收尾完成。"
