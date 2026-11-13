// Seed the ISOLATED demo KB via the real product path (POST admin/kb/ingest).
// Embeddings are computed by demo-n8n calling DashScope (key from env, never printed).
// Run: node --env-file=.env interview-demo/_demo/seed-kb.mjs
const N8N = process.env.DEMO_N8N_URL || 'http://127.0.0.1:15678';
const KEY = process.env.CHAT_API_KEY;
if (!KEY) { console.error('CHAT_API_KEY required (run with --env-file=.env)'); process.exit(1); }

const DOCS = [
  {
    title: '平台部署与运维手册',
    source_ref: 'docs/ops-handbook.md',
    text: `本手册说明 agent-platform 的部署与日常运维。平台以 docker compose 编排，常驻十二个服务：n8n 工作流引擎、Next.js 控制台、Postgres（ParadeDB，含 pgvector 与 pg_search）、Redis、SearXNG 搜索、Python 沙箱、LobeHub 对话前台、RustFS 对象存储、stream-bridge 流式旁路、platform-runtime 协调原语、backup 备份与 caddy 反向代理。所有业务逻辑与 Agent 编排都集中在 n8n，前端只调用 n8n 的 webhook。密钥统一放在根目录 .env，工作流 JSON 内不出现密钥明文，运行时通过 $env 读取。备份容器每六小时跑一次，产出数据库、对象存储、工作流、配置与校验五类产物，并带新鲜度守卫。扩容时优先水平扩展无状态服务，数据库与对象存储保持单副本并定期备份。故障排查先看 selfcheck 自检报告，再看 n8n 执行日志与容器日志。`
  },
  {
    title: 'Agent 工具与调用规范',
    source_ref: 'docs/agent-tools.md',
    text: `网关静态工具表共十六个工具：web_search 公网搜索、kb_search 知识库检索、platform_status 平台状态、run_brief 简报、list_alerts 告警列表、kb_save 知识入库、create_reminder 创建提醒、list_reminders 提醒列表、cancel_reminder 取消提醒、todo_add 新建待办、meeting_actions 会议行动项、todo_list 待办列表、todo_done 完成待办、run_python 沙箱执行、mcp_list_tools 与 mcp_call 外部 MCP 工具。此外还会动态追加用户自建流程 wf_<name> 与客户端自带工具，因此工具总数不是固定值。工具循环上限由 MAX_TOOL_ROUNDS 控制，默认两轮。第一轮的 serverTools 会作为 server_tools 传入第二轮，保证工具面不会在循环中途缩小。run_python 在隔离的 Python 沙箱里执行，需要共享密钥，超时与内存都受限。todo_add 与 todo_list 支持可选的 project 参数，合法取值在 todo_list 响应的 projects 登记表里自发现。`
  },
  {
    title: '知识库检索与 RAG 策略',
    source_ref: 'docs/kb-retrieval.md',
    text: `知识库检索采用 Agentic RAG 分层增强。第一层是混合检索：pgvector 的余弦近邻与 ParadeDB 的 BM25 全文两条腿，用 Reciprocal Rank Fusion（k 等于 60，按 chunk_id 融合）合并排序。跑 BM25 前先做目录探测，扩展或索引缺失就回退纯向量，排序与 top-k 与改造前一致，返回里带 retrieval 标志区分 hybrid 与 vector。第二层是可选的交叉编码器重排，调用 DashScope 的 qwen3-rerank，对融合池做 post-retrieval 重排，默认关闭，失败时原样返回融合池。第三层是可选的评分式纠正检索 CRAG-lite，用余弦相似度把证据分成 correct、ambiguous、incorrect 三档，证据不足时记录信号，并可在开启 web 兜底时发一次有界的 SearXNG 调用补充公网证据，同时保留并标注原有知识库条目。重排分是请求内相对值，不能跨请求比较，也不是余弦。`
  },
  {
    title: '财务报销与审批流程',
    source_ref: 'docs/finance-reimbursement.md',
    text: `员工报销须先在控制台提交报销单，填写事由、金额、发票号与所属项目。单笔金额不超过五千元由直属主管审批；超过五千元须部门总监与财务双签。发票必须为增值税发票，抬头与公司税号一致，电子发票需上传原件 PDF。差旅报销另附行程单与住宿水单，餐补按出差自然日计算。报销单提交后进入待审批队列，审批人会在每日议程里收到提醒。审批通过后财务在三个工作日内打款到工资卡。被驳回的报销单会注明原因，申请人补充材料后可重新提交。项目归属必须先在 projects 登记表里登记，未登记的项目 slug 会被拒绝，避免凭空开出无人认领的项目。季度末财务会导出报销台账做成本归集。`
  },
  {
    title: '产品常见问题 FAQ',
    source_ref: 'docs/product-faq.md',
    text: `问：如何登录控制台？答：控制台用 Clerk 做鉴权，浏览器只访问 /api 路由，n8n 的 API Key 只在服务端出现，前端不存 token。问：对话前台是哪个？答：终端用户对话用 LobeHub，模型入口经 stream-bridge 流式旁路再到 n8n 网关；非流式或无工具时原样转发，流式时优先直连上游快速返回，出现工具调用则回落网关跑完整工具循环。问：支持哪些渠道？答：支持控制台、LobeHub、Telegram 与 MCP 外部 agent。Telegram 每分钟轮询，成员受默认拒绝的命令白名单约束。问：模型可以换吗？答：上游模型与 embedding 都由环境变量配置，控制台 models 页可查看当前模型。问：知识库怎么入库？答：通过 kb-ingest 的 ingest 模式提交标题与正文，系统自动分块并计算 embedding。`
  },
  {
    title: '团队与项目协作规范',
    source_ref: 'docs/team-collaboration.md',
    text: `团队按项目分活，projects 是登记表，project_ref 是按名字引用的外键。项目字段包括 slug 名称、显示名、仓库地址、客户、状态与备注。待办与文档都挂 project_ref，提醒暂不按项目分。写入侧要求项目必须已登记，未知 slug 或归档项目会被拒绝。今日议程按人发送，收件人是机主加上 people 表里每个活跃成员，每个人只收到派给自己的逾期、今天到期与未确认的委派。今天和几点都按人各自的时区计算，时区非法会回落 Asia/Shanghai 并标记。投递窗口是每人本地七点半到十六点，窗口外的 tick 跳过。去重与落库都按人独立，指纹只跟本人上一次成功推送比。成员用 /ack 确认委派、/done 完成待办，只能动派给自己的条目。删除项目有引用保护，仍被待办或文档引用时拒绝删除并提示改用归档。`
  }
];

async function ingest(doc) {
  const res = await fetch(`${N8N}/webhook/admin/kb/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ mode: 'ingest', title: doc.title, text: doc.text, source_type: 'text', source_ref: doc.source_ref })
  });
  const txt = await res.text();
  let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 200) }; }
  return { status: res.status, body: j };
}

let ok = 0;
for (const doc of DOCS) {
  const r = await ingest(doc);
  const b = r.body || {};
  const docId = b.doc_id || b.docId || (b.data && b.data.doc_id) || '?';
  const chunks = b.chunks ?? b.chunk_count ?? (b.data && b.data.chunks) ?? '?';
  console.log(`[${r.status}] ${doc.title} -> doc_id=${docId} chunks=${chunks}`);
  if (r.status === 200 && !b.__error) ok++;
  else console.log('   detail:', JSON.stringify(b).slice(0, 300));
}
console.log(`SEEDED ${ok}/${DOCS.length}`);