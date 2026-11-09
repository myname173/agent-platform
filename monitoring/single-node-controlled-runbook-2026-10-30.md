# Single-Node Controlled Runbook（2026-10-30）

## 运行边界

当前机器按 `PLATFORM_DEPLOYMENT_MODE=single-node-controlled` 运行：

- Docker Compose 是 n8n、Postgres、Redis、Runtime、Console 和对象存储的权威运行面。
- Docker Desktop Kubernetes 只承载可选 Worker/Sandbox 执行边缘，不承载状态服务。
- Kafka、Outbox Publisher、Prometheus 和外部边缘入口保持关闭，除非单独做实验。
- 这不是多节点 HA；Docker Desktop、宿主机或本地磁盘故障仍会造成整体中断。

## 启动与检查

```powershell
docker compose up -d --build
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/release/phase65a.ps1 -Action check
docker logs --tail 30 platform-backup
```

启动时 `backup` 会执行一次；若距离上次成功备份不足
`BACKUP_MIN_AGE_HOURS`（默认 20 小时），它会按预期跳过。备份成功需要五个
核心产物和 Redis RDB 快照，Redis 快照失败会让本轮备份失败。

## 恢复演练

在 Git Bash 中运行：

```bash
bash n8n/scripts/restore-drill.sh
```

演练只恢复到临时 Postgres 数据库、列举 MinIO 归档并校验 Redis RDB 格式，
不会覆盖在线服务数据。

## 停止与回滚

```powershell
docker compose stop
```

停止不会删除命名卷。恢复业务同步路径时，将 `.env` 中
`PLATFORM_KB_ASYNC_ENABLED` 设为 `false`，然后执行：

```powershell
docker compose up -d n8n platform-runtime console
```

Kubernetes Worker/Sandbox 如需回退，缩容或停止 `deploy/k8s/phase3-pilot`，不触碰
Compose 的 Postgres/Redis 卷。

## 进入真正生产前的门槛

需要至少一个真实多节点/托管集群，以及托管 Postgres/Redis 或明确的
StatefulSet、持久卷、异地备份和恢复责任。在此之前不应用
`deploy/k8s/phase6-production`，也不把本机单节点状态称为 HA 生产集群。
