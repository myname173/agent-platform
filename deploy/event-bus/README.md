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
