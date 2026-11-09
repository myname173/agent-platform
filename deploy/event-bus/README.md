# Phase 5.3 Kafka Event-Bus Pilot

This is an optional readiness pilot. It does not replace the Redis Streams
`kb_save` execution queue and it is not a production Kafka cluster.

The profile uses the Apache Kafka JVM image in single-node KRaft mode. It binds
only to host loopback `127.0.0.1:19092`; other Compose services reach it as
`kafka:19092` on `n8n-net`.

The local named-volume pilot runs the broker as root so the official image can
initialize the newly mounted volume. This is a Docker Desktop pilot choice,
not a production security baseline.

## Start and verify

```powershell
.\deploy\event-bus\kafka-pilot.ps1 -Action up
.\deploy\event-bus\kafka-pilot.ps1 -Action check
```

The check creates `platform.events.v1`, writes one probe event, and reads it
back through a fresh consumer group. It has no business side effects.

When the Pilot is started, `platform-event-publisher` also polls the durable
`platform.events` table and publishes new state events to `platform.events.v1`.
It starts at the current highest event by default, so old platform history is
not replayed automatically. Set `PLATFORM_EVENT_START_ID=0` when a deliberate
history replay is needed. The publisher is an event fan-out experiment and
does not replace the Redis Streams `kb_save` queue.

## Outbox Publisher v1 experiment

This is a separate experiment. It does not change Runtime state writes and it
only claims rows whose `kind` is `kafka-pilot`. The script seeds those rows into
the existing `platform.outbox` table and publishes them to a separate topic:

```powershell
.\deploy\event-bus\outbox-pilot.ps1 -Action up
.\deploy\event-bus\outbox-pilot.ps1 -Action check
```

The pilot verifies outbox claim, Kafka publish, `DELIVERED` confirmation and
unique seed keys. The Phase 6.5B schema now uses explicit `lease_until`,
`locked_at` and `locked_by` fields for `DELIVERING` rows; `next_retry_at`
remains the retry schedule. A production promotion still needs consumer-side
idempotency, pending/retry/dead-letter metrics and a multi-broker or managed
Kafka target.

Stop only the isolated publisher with:

```powershell
.\deploy\event-bus\outbox-pilot.ps1 -Action down
```

## 高吞吐实验

压测使用独立 Topic，不会触发 n8n、`kb_save`、模型调用或业务写入：

```powershell
# 创建 6 分区压测 Topic，并进行单生产者吞吐测试
.\deploy\event-bus\kafka-load.ps1 -Action produce

# 消费上面的 50,000 条消息并观察消费吞吐与 lag
.\deploy\event-bus\kafka-load.ps1 -Action consume

# 4 个 Producer 并发，每个默认发送 25,000 条 256 字节消息
.\deploy\event-bus\kafka-load.ps1 `
  -Action concurrent `
  -Topic platform.events.load.concurrent.v1 `
  -RecordSize 256

# 6 个 Consumer 加入同一个消费组，每个默认读取 15,000 条
.\deploy\event-bus\kafka-load.ps1 `
  -Action consumer-group `
  -Topic platform.events.load.concurrent.v1 `
  -Consumers 6 `
  -RecordsPerConsumer 15000
```

默认压测 Topic 是 `platform.events.load.v1`。重复消费时请换一个
`-ConsumerGroup`，否则 Kafka 会从已有消费位点继续读取。

可以用同一个 `-ConsumerGroup` 分两次执行 `consume`，观察停止后的 lag
和重新加入后的 offset 恢复：先消费一部分，再根据
`kafka-consumer-groups.sh --describe` 输出的总 lag 消费剩余消息。

真实中断实验使用专用脚本。它会让 Consumer 先加入消费组，启动限速
Producer，几秒后终止 Consumer，再输出中断时的分区 lag：

```powershell
.\deploy\event-bus\kafka-interrupt.ps1
```

实验完成后，用同一个消费组执行 `kafka-load.ps1 -Action consume`，直到
各分区 `LAG` 回到 0。

本次实验记录在
`monitoring/kafka-pilot-2026-10-30.md`。它测量的是单节点 Docker Kafka
的 Broker、分区和消费组能力，不代表生产 HA 容量。

Stop the pilot without deleting its volume:

```powershell
.\deploy\event-bus\kafka-pilot.ps1 -Action down
```

## Event contract

The pilot topic uses this envelope shape for future producers:

```json
{
  "event_id": "uuid-or-request-id",
  "event_type": "platform.<domain>.<verb>",
  "occurred_at": "ISO-8601 UTC",
  "source": "service-name",
  "trace_id": "optional-trace-id",
  "data": {}
}
```

Use `event_id` as the idempotency key and keep `trace_id` unchanged across
producer and consumer boundaries. Do not publish credentials or full user
content into the pilot topic.

## Promotion rule

The current business path remains Redis Streams. Promote a Kafka topic into a
real producer/consumer path only after a measured need for sustained high
event throughput, multiple independent consumers, long replay retention or
cross-cluster replication. A single-node Docker Kafka instance is for contract
and recovery experiments, not HA.
