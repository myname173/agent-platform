# P0 consumer closure — live acceptance (2026-11-12)

Scope: the `event-bus-outbox` pilot on the local single-node Docker stack
(`apache/kafka:4.4.0`, KRaft, 1 partition; Postgres `platform` schema).
Business paths untouched: Runtime does not write the outbox
(`PLATFORM_OUTBOX_WRITE_MODE=off`), Redis Streams `kb_save` and n8n unchanged.
This is pilot acceptance, not a production HA claim.

## Commands

```powershell
.\deploy\event-bus\consumer-pilot.ps1 -Action up
.\deploy\event-bus\consumer-pilot.ps1 -Action check
.\deploy\event-bus\outbox-pilot.ps1 -Action check   # regression after seed fix
```

## Results

Consumer closed-loop check (`run_id=1794461593373`):

```json
{"ok":true,"topic":"platform.events.outbox.v1","kind":"kafka-pilot",
 "delivered":3,"ledger_rows_for_run":3,
 "ledger_total_before_replay":12,"ledger_total_after_replay":12,
 "replay_processed":0,"replay_duplicates":12,
 "mode":"isolated outbox pilot; Runtime and kb_save unchanged"}
```

What this proves on real infrastructure (the offline fakes cannot):

- 3 seeded outbox rows were delivered by the lease-based publisher and each
  `dedupe_key` landed in `platform.consumed_events` exactly once — real
  `ON CONFLICT (topic, dedupe_key) DO NOTHING` semantics.
- A SECOND consumer group (`replay-<runId>`) re-read the whole retained topic
  from the beginning: all 12 messages were counted duplicates, zero new
  effects, ledger total 12 -> 12. Crash-style redelivery is a counted no-op.
- Publisher metrics expose all five outbox states (PENDING, DELIVERING,
  DELIVERED, RETRY, DEAD_LETTER) — the check throws if any series is missing.

Publisher-side regression (`run_id=1794461624356`): `delivered=3`,
`kafka_records=3`, `ok=true`.

## Defects found and fixed during live verification

The first live runs failed; each failure was diagnosed before fixing, and the
fixes are in this PR:

1. **PS 5.1 native-argument quote stripping (both pilot scripts).**
   `ConvertTo-Json` payloads embed double quotes; PowerShell 5.1 strips them
   when passing arguments to `docker.exe`, so Postgres received `{run_id:...}`
   and rejected the seed. The pre-existing `outbox-pilot.ps1` fails the same
   way on this machine today (its 2026-10-30 report does not record which
   shell was used; no pwsh exists here). Fix: build the payload with SQL
   `jsonb_build_object` and keep every native argument double-quote-free
   (single-quoted JS for the metrics scrapes).
2. **`kafka.tools.GetOffsetShell` removed in Kafka 4.4.0.** Replaced with the
   supported `bin/kafka-get-offsets.sh` (same `topic:partition:offset` output).
3. **Replay catch-up ruler ignored retention.** The target was the topic END
   offset (55), but 7-day retention had deleted the 2026-10-30 history
   (start offset 49), so only 6 messages were readable and the wait could
   never succeed. Fix: target = sum(end - start) per partition.
4. **PowerShell `-match` on docker's line array.** `-match` against an array
   filters instead of populating `$Matches`, silently zeroing every scraped
   counter; the publisher `-notmatch` assertion was likewise always true.
   Fix: `-join` the output into one string before matching. Verified against
   the live main consumer (processed=9 at that point) before re-running.

None of these touched the consumer/publisher delivery logic; all four are
pilot-script measurement or argument-passing defects.

## Boundaries

- Single-node controlled pilot; `kind=kafka-pilot` rows only, no business
  side effects. Offline green plus this check is not production acceptance.
- Remaining promotion blockers (unchanged): Runtime transactional-outbox
  canary, durable cursor for the direct `platform.events.v1` publisher,
  multi-broker or managed Kafka target. See `deploy/event-bus/README.md`.