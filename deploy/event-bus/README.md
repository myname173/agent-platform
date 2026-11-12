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
remains the retry schedule. Consumer-side idempotency and pending/retry/
dead-letter metrics now exist (see the consumer section below); a production
promotion still needs a Runtime transactional-write canary and a multi-broker
or managed Kafka target.

Stop only the isolated publisher with:

```powershell
.\deploy\event-bus\outbox-pilot.ps1 -Action down
```

## Idempotent consumer (P0 consumer-side closure)

`platform-event-consumer` (profile `event-bus-outbox`) consumes the outbox
topic and records each `(topic, dedupe_key)` exactly once in
`platform.consumed_events`. The ledger primary key is the idempotency
boundary: the DB transaction commits **before** the Kafka offset, so a crash
in between redelivers the message and `ON CONFLICT DO NOTHING` turns the
replay into a counted no-op. The consumer self-ensures its schema at startup
(the same DDL is appended to `n8n/scripts/platform-schema.sql`).

Scope is the same isolation rule as the publisher: outbox topic only, no
Runtime state writes, no Redis Streams `kb_save`, no n8n side effects. A
crashed consumer exits non-zero so `restart: unless-stopped` recovers it;
it never sits alive-but-stalled.

```powershell
.\deploy\event-bus\consumer-pilot.ps1 -Action up
.\deploy\event-bus\consumer-pilot.ps1 -Action check
```

`check` is a closed-loop proof with a negative control:

1. seed `Count` outbox rows and wait for `DELIVERED`;
2. wait until the ledger holds exactly those `dedupe_key`s;
3. start a **second consumer group** that replays the whole topic from the
   beginning, wait for catch-up, and require the ledger to be unchanged
   (replay must be all duplicates — one new row fails the check);
4. require the publisher metrics surface to expose all five outbox states.

Offline contract tests (no broker, no database, no credentials):

```powershell
cd platform-runtime
npm run test:consumer
```

They cover the dedupe branching, transaction shape, the offset-commit
ordering (a failing handler must not advance the offset) and the metrics
rendering. The live `ON CONFLICT` semantics are covered by step 3 above,
not by the offline fakes.

### Metrics

- `platform-outbox-publisher:9101/metrics` — `platform_outbox_rows{kind,state}`
  for all five states (zero-filled, so `DEAD_LETTER 0` is visible rather than
  absent), `platform_outbox_oldest_ready_seconds`, `platform_outbox_published_total`,
  `platform_outbox_failed_total{outcome="retry|dead_letter"}`.
- `platform-event-consumer:9102/metrics` — `platform_event_consumer_processed_total`,
  `platform_event_consumer_duplicates_total`, `platform_event_consumer_invalid_total`,
  `platform_event_consumer_errors_total`.

`monitoring/prometheus.yml` scrapes both when the `observability` profile is
running; the targets report down while `event-bus-outbox` is stopped, which
is expected.

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

Status of the former promotion blockers: consumer-side idempotency and
pending/retry/dead-letter metrics are implemented and covered by offline
contract tests. The live closed-loop check (`consumer-pilot.ps1 -Action
check`) passed on 2026-11-12 against the local single-node stack: 3 seeded
rows delivered and recorded once, a second consumer group replayed all 12
retained messages as counted duplicates (`processed=0`), and the ledger total
stayed 12 -> 12. Evidence and the script defects fixed along the way:
`monitoring/consumer-closure-2026-11-12.md`. Still open before any production
promotion: a canary for
Runtime transactional outbox writes (`PLATFORM_OUTBOX_WRITE_MODE` stays `off`),
a durable publish cursor or full transactional outbox for the direct
`platform.events.v1` publisher, and a multi-broker or managed Kafka target.
