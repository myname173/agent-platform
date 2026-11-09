# Production Closeout Plan（2026-10-30）

## 当前判断

平台化 V1 的 Pilot 目标已基本完成，但当前运行态仍是本地 Pilot，不是生产 HA：

- Compose 负责 n8n、Postgres、Redis、Runtime 和 Console。
- `docker-desktop` K8s context 运行单副本 Worker 与 Sandbox Gateway。
- Kafka 是单节点 KRaft 实验；Event Publisher 和 Outbox Publisher 仍是可选实验路径。
- Runtime transactional Outbox 默认关闭；当前 `platform.outbox` 只验证了隔离发布。
- Console 管理读链路已有 3 秒进程内 L1 缓存；多副本共享缓存尚未实现。
- 当前外部入口没有稳定生产域名和 HA Ingress。

结论：可以开始生产化收口，但必须先冻结边界，再逐项提升，不把 Pilot 配置直接当成生产配置。

## 收口顺序

### Phase 6.5A：Release Candidate 配置冻结

目标：让“默认运行态”和“实验运行态”清晰分离，不改变业务语义。

1. 固定 Compose 镜像版本、K8s 镜像标签和关键环境变量清单。
2. 明确默认关闭项：Kafka Publisher、Outbox Publisher、Prometheus、Cloudflare Tunnel。
3. 把当前 Pilot 检查、只读业务 E2E、备份检查和 Console health 纳入一个只读 release gate。
4. 保留当前回滚方式：`PLATFORM_KB_ASYNC_ENABLED=false`，Worker/Gateway 缩容到 0，恢复 Compose 同步路径。
5. 只在配置和文档层改动，不启用新业务链路。

验收：默认 Compose 可以独立启动；Pilot profile 可单独启动；两者的入口、数据卷和回滚步骤明确。

### Phase 6.5B：数据与发布链路决定

目标：决定是否把 Outbox/Kafka 从实验提升为正式事件发布链路。

进入条件：有稳定的事件消费者需求，或明确需要事件重放/多消费者/跨集群复制。

如果正式启用：

- 给 `platform.outbox` 增加明确 lease 字段，不再复用 `next_retry_at` 做临时租约。
- Publisher 使用批量 claim、重试、退避、DLQ/终态统计和消费者幂等。
- 先以 Runtime transactional shadow 方式小范围开启，再进行业务 canary。
- Kafka 目标改为多 broker 或托管 Kafka，补齐 TLS/SASL、ACL、保留策略和监控。

如果暂时不启用：保持 Outbox off，Kafka 继续作为隔离实验，不影响 Redis Streams 主执行路径。

Phase 6.5B 当前决策为：完成显式 lease 基础，但暂不正式启用 Kafka/Outbox。
Runtime transactional 写入仍关闭，Redis Streams 继续作为 `kb_save` 执行
路径；待出现正式消费者、事件重放/多消费者需求，或具备多 broker/托管 Kafka
后，再进行 canary 和业务 promotion。

### Phase 6.5C 当前实现

已新增 `deploy/k8s/phase6-production` production-candidate overlay：Worker
和 Sandbox Gateway 使用两副本滚动升级、PDB、软反亲和；Gateway 增加健康探针。
该 overlay 只做静态渲染，不应用到当前 `docker-desktop` Pilot。真正应用前
仍必须替换 Docker Desktop host-gateway 地址，并明确 Postgres、Redis、n8n
和对象存储的生产托管/StatefulSet 方案。

集群与状态服务归属已确认并记录在
`monitoring/production-topology-decision-2026-10-30.md`：当前两个可用
context 都是单节点本地集群；Compose 命名卷仍是 Postgres、Redis、n8n 和
对象存储的唯一权威。Redis 已纳入栈内备份并通过恢复演练，但备份仍在同一台
机器上。因此当前可按 `single-node-controlled` 受控模式运行，仍不做生产 HA
应用。

### Phase 6.5C：K8s 生产边界

目标：把当前 Docker Desktop Pilot 和真正生产集群区分开。

1. 先确定实际生产 cluster/context；`docker-desktop` 只能作为单节点验证环境。
2. Worker、Sandbox Gateway 至少完成多副本、滚动升级、资源限制、PDB 和 Job GC。
3. Sandbox 保留 Job 超时、`backoffLimit`、`ttlSecondsAfterFinished`、NetworkPolicy 和非 root 身份。
4. 状态服务不要直接复制当前本机 Compose 方案；优先使用托管 Postgres/Redis，或明确 StatefulSet、卷、备份和恢复责任。
5. 把 Runtime、Worker、Sandbox、Console 的健康检查和 metrics 接入现有监控，不新增业务看板。

### Phase 6.5D：外部访问与安全边界

目标：只开放需要给外部用户使用的入口。

- 使用稳定的 Cloudflare Named Tunnel 或正式 Ingress；Quick Tunnel 不作为生产入口。
- 只暴露 Console/Chat 等必要入口，不暴露 Postgres、Redis、Kafka、n8n 管理端口。
- 配置身份访问、边缘限流、TLS、审计和最小权限。
- 没有稳定域名或 DNS 控制权时，保持内部/受控访问，不宣称公网生产可用。

### Phase 6.5E：最终 Release Gate

验收项保持精简：

- 启停与回滚
- 备份恢复演练
- Runtime 幂等/锁/限流/trace
- `kb_save` 同步与异步路径
- Worker/Sandbox 故障和积压恢复
- Kafka/Outbox（若启用）的发布失败与重试
- 只读管理链路命中率与 n8n CPU
- 外部入口 TLS、认证和限流

## 立即执行项

先执行 **Phase 6.5A**。它不改变业务路径，适合在当前 Pilot 仍运行时完成；完成后再根据是否真正需要 Kafka，决定进入 6.5B 还是先做 K8s/外部入口生产边界。

Phase 6.5A 的只读检查脚本为 `deploy/release/phase65a.ps1 -Action check`。

2026-10-30 执行结果：PASS。默认 Compose 只包含核心服务；Kafka、Outbox、Prometheus 和 Docker Worker 均保持 profile 隔离；K8s pilot manifest 渲染成功；当前 context 为 `docker-desktop`；Console、n8n、Runtime 返回 200，Redis 返回 `PONG`。当前运行边界报告为 `pilot-async`，Outbox 写入仍为 `off`。本次检查没有修改服务或业务数据。

当前不做：直接打开 transactional Outbox、把单节点 Kafka 当生产集群、把 Docker Desktop context 当 HA 集群、或为管理读链路再添加一套看板。当前单机路线已补齐 Redis 备份和恢复演练，后续重点转为运行手册与启停/回滚验证。
