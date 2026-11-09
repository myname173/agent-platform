# Kafka Pilot Throughput Experiment

Run date: 2026-10-30 (Asia/Shanghai)

Scope: a single Apache Kafka 4.4.0 broker in Docker Desktop KRaft mode. The
business `kb_save` path stayed on Redis Streams. The load topics below were
separate from `platform.events.v1` and produced no n8n, model or business
database activity.

## Broker and probe

- `platform-kafka`: healthy
- Broker address: `kafka:19092` on the Compose network
- Host binding: loopback `127.0.0.1:19092`
- `platform.events.v1`: created and verified with a producer/consumer probe

## Measurements

| Test | Configuration | Result |
| --- | --- | --- |
| Single producer | 50,000 records, 512 bytes, 6 partitions | 23,223 records/s; 11.34 MB/s; no record errors |
| Single consumer | 50,000 records, 6 assigned partitions | 1,647 records/s; 0.858 MB/s; final lag 0 |
| Concurrent producers | 4 clients, 25,000 records each, 256 bytes, 6 partitions | 5,972-7,211 records/s per client; no reported producer errors |
| Concurrent producer consumer | 100,000 records, 256 bytes, 6 partitions | 75,586 records/s; 18.45 MB/s; 100,000 records consumed |
| Consumer group scaling | 6 consumers in one group, 6 partitions | 4,842-8,886 records/s per client; rebalance time 1.4-2.8 s |
| Offset recovery | 60,000 records, 3 partitions; consume in two phases | First phase left 39,808 lag; second phase 56,226 records/s; final lag 0 |
| Real consumer interruption | 120,000 records, 3 partitions, Consumer killed after producer started | Consumer group became empty; recovery read 120,000 records at 146,341 records/s; final lag 0 |

The producer results show the effect of concurrent clients and batching. The
consumer result cleared the test topic successfully, while the consumer
metrics also exposed rebalance and partition lag during the read. These are
useful learning signals, not a production capacity claim.

The consumer-group run first consumed 90,696 records across six clients. A
follow-up consumer read the remaining 9,304 records. The final
`kafka-consumer-groups.sh --describe` output reported `LAG 0` on all six
partitions, confirming that the group recovered from the initial rebalances and
drained the topic.

The offset recovery run used the same consumer group across two separate
processes. After the first process stopped, the three partitions reported lag
of `12,261`, `11,952` and `15,595`. The restarted consumer read the exact
39,808-record backlog and the final group description reported `LAG 0` on all
three partitions.

The real interruption used `kafka-interrupt.ps1` to kill the Consumer process
inside the Kafka container while a producer was still writing. The interrupted
group had no committed current offsets, so the recovery Consumer replayed the
120,000-record topic. Its final group description showed offsets equal to log
end on all three partitions and `LAG 0`. This demonstrates the at-least-once
boundary: an abrupt stop can replay records that were read but not committed.

The first implementation terminated only the host-side `docker exec` client;
the container-side Java Consumer continued running. The script now records the
container PID and terminates the actual Consumer process, which makes the
failure injection repeatable.

## Project event publisher validation

The optional `platform-event-publisher` was started with the `event-bus`
Compose profile. It initialized at event cursor `344`, then the Runtime
contract test generated four durable state-transition rows (`event_id` 345-348).
The publisher logged `count: 4, cursor: 348` and a fresh Kafka consumer read the
same events from `platform.events.v1`.

The published envelope preserved the Runtime `trace_id` across the four state
transitions (`RECEIVED -> VALIDATED -> RUNNING -> ...`). This verifies the
first useful integration boundary: durable platform events can be fanned out to
Kafka without changing the request state machine or the Redis Streams
`kb_save` execution path.

## Boundary

The Kafka profile remains opt-in. Redis Streams is still the execution queue
for asynchronous `kb_save`. Kafka is currently an event-bus and throughput
experiment only; enabling or stopping it does not change business semantics.

The publisher currently keeps its cursor in memory and starts at the current
highest event by default. That is deliberate for this pilot: it avoids replaying
old history and does not claim durable delivery. A production promotion would
persist a publish cursor or use the existing `platform.outbox` transactionally,
then add retry and duplicate handling. The `kb_save` execution queue remains
unchanged.
A production-style Kafka design would still need multiple brokers,
replication, authentication, retention policy and independent monitoring.
