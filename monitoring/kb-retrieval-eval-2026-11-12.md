# KB 检索增益实测（一次性隔离栈，2026-11-12）

状态：**已实跑**。这是 hybrid / rerank / CRAG-lite 三层合并进 main（`bfa106a`）后，
第一次用**真实 DashScope embedding + qwen3-rerank + SearXNG** 量到的检索数字。
此前各设计文档里的「现网增益未验、留部署机」一项，就**冻结语料回归尺子**这一口径而言已兑现。

> 口径边界（先说清楚，避免过度声称）：本实测跑在 **5 文档 / 50 例（40 可答 + 10 拒答 pending）
> 的冻结语料**上，不是现网那 45 文档 / 333 chunk 的真实 KB；量的是**检索排序**（hit@1 / MRR，
> 按 KB 标题），**不是答案正确率、不是拒答能力、不是现网架构**。10 条拒答例仍 pending（尺子不生成答案）。

## 1. 为什么能在本机跑、且零碰现网

此前「真实 eval 只能留部署机」的约束，卡点是本机只有**共享现网栈**，而 eval 设计禁止把
live eval 指向共享业务数据。本次的解法是**自建一次性隔离栈**，完全不碰现网 postgres / n8n / `.env`：

- **一次性 DB**：`docker run -d --name kb-eval-db --network n8n-net -e POSTGRES_HOST_AUTH_METHOD=trust
  -e POSTGRES_USER=n8n -e POSTGRES_DB=n8n paradedb/paradedb:latest-pg17 postgres -c shared_preload_libraries=pg_search,pg_cron`
  —— 匿名卷（随容器删除而消失）、trust 鉴权（无密码、仅 docker 网络可达、**不暴露宿主端口**）、
  与现网同款 paradedb 镜像。`pg_cron` 必须预加载，否则全新卷 bootstrap 会 abort（compose 注释已记录）。
- **一次性 runner**：用现网同款 `docker.n8n.io/n8nio/n8n:2.37.7` 镜像（node v26.5.1 + 自带 `pg`），
  `--rm --user root --entrypoint sh`，把宿主 `n8n/` 只读挂到 `/eval/n8n`、`.eval-local/` 可写挂到
  `/eval/.eval-local`，`ln -s /usr/local/lib/node_modules/n8n/node_modules /eval/node_modules` 让
  `createRequire('pg')` 沿目录上溯解析到 pg 及其全部依赖。DASHSCOPE key 经 `-e DASHSCOPE_API_KEY`
  **名字继承**进容器（值不在 argv、不落盘、不打印）。
- 跑完 `docker rm -f kb-eval-db`，runner 本就 `--rm`。核验：无 kb-eval 容器残留，现网 `postgres`/`n8n` 仍在跑、未被改动。

**首次核实到的现网未验项**：在一次性 DB 上应用 `kb-schema.sql`，guarded DO 块真把
`kb_chunks_bm25` 建出来了（`NOTICE: kb_chunks_bm25 ready`），`pg_extension` 有 `pg_search`、
`to_regclass('public.kb_chunks_bm25')` 非 NULL、`pdb.score` 与 `|||` 算子齐全 —— 即 canonical
`KB_BM25_PROBE_SQL` 会判 `bm25Available=true`，**混合检索真跑、不降级**。现网因为 `pg_search`
扩展未装，这条腿一直没被证实能建出来；本次在隔离栈证实了 DDL 与探测一致。

## 2. 尺子的一个真实局限（本次发现，未改代码）

`kb-eval.mjs` 的 `--hybrid` 旗标**只设置 `requested_mode` 标签，不真正切换检索路径**。
脚本第 232 行恒调 `hybridKbSearch(pg, vec, q, 5, {docIds})`，而该 canonical helper（`kb-hybrid.mjs:102`）
**纯按目录探测**决定 vector / hybrid：bm25 索引在 → hybrid，不在 → vector，**没有 force-vector 选项**。

后果：在**装了 bm25 的隔离 DB** 上，即便不加 `--hybrid`，`retrieval_mode` 也报 `hybrid`
（本次第一跑 `requested_mode=vector` 但 `retrieval_mode=hybrid` 即此）。docstring「without it the run
is vector-only」只在**现网那种 pg_search 缺失**的环境里碰巧成立。

**正确量 vector 基线的办法 = 切换索引本身**（这正是现网的降级机制）：先 `DROP INDEX kb_chunks_bm25`
跑纯向量，再 re-apply schema 建回索引跑 hybrid。两跑都走**同一个 canonical helper**，量的是「有没有
BM25 这条腿」的真实差异。本次即按此法。

> 建议（另开分支、另授权，本次未做）：给尺子加一个真正的 force-vector 选项，或修正 docstring，
> 使 `--hybrid` 语义与代码一致。这是尺子缺陷，不是被测检索代码的缺陷。

## 3. 检索增益（40 可答例，真实 embedding）

| 模式 | requested → retrieval | hit@1 | MRR | hit@5 | 报告（`.eval-local/judge/`） |
|---|---|---|---|---|---|
| 纯向量（索引摘除） | vector → **vector** | **0.900** | **0.950** | 1.0 | `kb-mwdowf0j.json` |
| 混合（BM25+RRF） | vector* → **hybrid** | **0.925** | **0.963** | 1.0 | `kb-mwdotpbc.json` |
| 混合 + 重排 | hybrid+rerank → **hybrid+rerank** | **1.000** | **1.000** | 1.0 | `kb-mwdoza5e.json` |

\* 混合那跑没加 `--hybrid`，故 requested 标签是 vector，但 retrieval 实测 hybrid（见 §2）。

**逐例归因**（向量基线恰好 miss 4 例，全部 rank=2）：

- **BM25 混合腿修好 1 例**（关键词型）：`网关的鉴权和限流是按什么维度做的？`
  向量 top1 误判「流式与工具链」，BM25 的「鉴权/限流」词面匹配把正确文档顶到 rank1。
- **交叉编码器重排修好另外 3 例**（语义改述型）：
  `写入结果不确定时怎么处理？可以自动重试吗？`、`外网接入有哪两种可选方式？`、`SearXNG 供哪个工具使用？`
  —— 混合后仍 rank2，qwen3-rerank 重排后全部 rank1。
- 终态 **40/40 rank1**。`retrieval_mode=hybrid+rerank` 证明重排**真跑**（非 fail-open 降级；
  若 key/endpoint 缺失或 API 错，会退回 `hybrid` 标签且分数不变）。

**解读**：混合腿补的是**词面/关键词**召回，重排补的是**语义改述**排序，两者互补。在 5 文档冻结
语料上叠加到满分。**这不是现网 45 文档 KB 的增益**——语料越大、越噪，绝对数字会不同，需部署机另量。

## 4. CRAG-lite 评分分布与 web 触发（真实 SearXNG）

重排后（hit@1=1.0）再叠 CRAG-lite，**余弦三档 grader**（LOW=0.2 / HIGH=0.5，作用在 `vectorScore`
而非重排相对分）：

| web 兜底 | graded | correct | incorrect | ambiguous | web_triggered | 报告 |
|---|---|---|---|---|---|---|
| OFF（默认安全路径） | 40 | 22 | 0 | 18 | 0 | `kb-mwdp208r.json` |
| ON | 40 | 22 | 0 | 18 | **17** | `kb-mwdp7e5i.json` |

两跑 hit@1/MRR 都仍是 **1.000** —— 证实 CRAG **不污染标题排序**（web 补充无 KB 标题，不进 hit@1/MRR），与设计一致。

**两个硬发现**：

1. **默认 HIGH=0.5 对本 embedding 模型偏保守**：即便检索**全对**，仍有 **18/40（45%）** 例 topCos
   落在 0.2–0.5 被判 `ambiguous`。说明 `qwen3.7-text-embedding-flash` 的余弦分布里，正确匹配也常
   不到 0.5。**阈值校准确属未验、且确有必要**——这不是离线能拍的数。
2. **web 兜底过触发是真实风险**：web ON 时 **17/40（42.5%）** 例触发了 web 补充，**尽管检索已经全对**。
   KB 是内部私有文档，这些公网补充大概率是噪声。18 ambiguous → 17 triggered 的差额，是某例 SearXNG
   返回空/失败 → fail-open 回 `action:none`（降级路径也在线证实）。**结论：决策 C 的「web 默认关」
   是对的；贸然开 web 会在私库上浪费 ~42% 查询、引噪声。开 web 前必须先校准阈值。**

CRAG 的**答案质量增益**尺子量不了（web 补充无 KB 标题、不能混进排序）——那仍是 agent answer-eval，未验。

## 5. 本次证实 vs 仍未验

**已证实（隔离栈、真实 API）**：
- bm25 索引 DDL 真能建出来、canonical 探测判 hybrid（现网一直未验的那条）。
- 冻结语料上 vector→hybrid→rerank 的 hit@1/MRR 单调增益（0.900→0.925→1.000），逐例可归因。
- 重排真跑（retrieval_mode 带 +rerank）、CRAG 不污染排序、web 兜底真能端到端触发并 fail-open。
- CRAG 默认阈值在本 embedding 上的评分分布（22 correct / 18 ambiguous / 0 incorrect）与过触发率。

**仍未验（不要从本次数字声称）**：
- 现网 **45 文档 / 333 chunk 真实 KB** 的增益（语料不同，绝对数会不同）。
- **答案正确率 / 拒答正确率**（10 拒答例仍 pending；尺子不生成答案）。
- CRAG **阈值校准**（本次只暴露默认值偏保守，没给出校准后的值）。
- CRAG 对**答案质量**的净增益（需 agent answer-eval）。
- agent shakedown（`eval-run.mjs`）：仍需把 eval 两表 + Chat Stats 隔离部署到一个**隔离 n8n**，
  且会创建/取消真实记录——本次**未跑**，不能拿共享现网 n8n 冒充隔离目标。

## 6. 复现命令（一次性栈，零碰现网）

```bash
# 1) 一次性 DB（paradedb，preload pg_search,pg_cron，trust，仅 docker 网络）
docker run -d --name kb-eval-db --network n8n-net \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=n8n -e POSTGRES_DB=n8n \
  paradedb/paradedb:latest-pg17 postgres -c shared_preload_libraries=pg_search,pg_cron
# 待 pg_isready 后应用 schema（bm25 索引会真建出来）
docker exec -i kb-eval-db psql -U n8n -d n8n -v ON_ERROR_STOP=1 < n8n/scripts/kb-schema.sql

# 2) 纯向量基线：先摘索引（强制 canonical helper 走 vector 降级）
docker exec kb-eval-db psql -U n8n -d n8n -c "DROP INDEX IF EXISTS kb_chunks_bm25"
#    runner（DASHSCOPE key 名字继承，值不在 argv）；--isolated-stack 是操作者确认
docker run --rm --network n8n-net --user root --entrypoint sh \
  -v "$PWD/n8n:/eval/n8n:ro" -v "$PWD/.eval-local:/eval/.eval-local" \
  -e DASHSCOPE_API_KEY -e DB_POSTGRESDB_HOST=kb-eval-db -e DB_POSTGRESDB_PORT=5432 \
  -e DB_POSTGRESDB_DATABASE=n8n -e DB_POSTGRESDB_USER=n8n \
  -e KB_GOLDEN=/eval/n8n/eval/golden-set.json docker.n8n.io/n8nio/n8n:2.37.7 \
  -c 'ln -s /usr/local/lib/node_modules/n8n/node_modules /eval/node_modules && node /eval/n8n/scripts/kb-eval.mjs --isolated-stack'

# 3) 建回索引跑 hybrid / +rerank / +crag（re-apply schema 幂等）
docker exec -i kb-eval-db psql -U n8n -d n8n < n8n/scripts/kb-schema.sql
#    同上 runner，分别加 --hybrid / --hybrid --rerank / --hybrid --rerank --crag
#    crag web 兜底：-e KB_CRAG_WEB_FALLBACK=true（默认 false=只评分）

# 4) 清理
docker rm -f kb-eval-db
```

## 7. 简历口径（守住三档动词 / 第三方作底座 / 三问可答）

- 可声称：「在自建一次性隔离栈上，用真实 embedding + 交叉编码器重排，把冻结语料检索 hit@1 从
  0.90 提到 1.00，并逐例归因 BM25 与重排各自的贡献；实测暴露 CRAG 余弦阈值偏保守、web 兜底在私库
  过触发 ~42%，据此坚持 web 默认关 + 阈值校准前置。」
- **底座非自研**：pgvector / ParadeDB BM25 / DashScope qwen3-rerank / SearXNG 都是第三方；自研的是
  **RRF 融合 + 目录探测降级 + 重排/CRAG 接线 + 这把可复现的尺子**。
- **不可声称**：现网 KB 增益、答案正确率、Self-RAG / 完整 CRAG（本实现是 CRAG-inspired graded
  corrective retrieval **lite**，无训练评估器、无 decompose-recompose、无 query 重写）。
- 三问可答：① 为什么 vector 基线要摘索引而不是关旗标？（§2 尺子局限）② 为什么检索全对还有 45%
  ambiguous？（§4 余弦分布 + 阈值未校准）③ 为什么 web 默认关？（§4 私库过触发实测）。