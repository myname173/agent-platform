param(
  [ValidateSet('up', 'check', 'status', 'down')]
  [string]$Action = 'check',
  [int]$Count = 3
)

# P0 consumer-side closure pilot. ASCII-only on purpose (PS 5.1 UTF-8 trap).
# check = seed -> DELIVERED -> ledger recorded -> full-topic replay with a
# second consumer group -> ledger MUST NOT change (negative control) ->
# metrics surface present. Runtime, Redis Streams kb_save and n8n untouched.

$ErrorActionPreference = 'Stop'
$Docker = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
$DockerBin = Split-Path $Docker
$env:Path = "$DockerBin;$env:Path"
$Topic = 'platform.events.outbox.v1'
$Kind = 'kafka-pilot'
$PgUser = 'n8n'
$PgDatabase = 'n8n'
$ConsumerName = 'platform-event-consumer'
# Single-quoted JS on purpose: PS 5.1 strips embedded double quotes when
# passing arguments to native commands (docker.exe), so no " may appear in
# any argument below. Same reason the seed SQL uses jsonb_build_object.
$MetricsJs = 'fetch(''http://127.0.0.1:9102/metrics'').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e.message);process.exit(1)})'
$PublisherMetricsJs = 'fetch(''http://127.0.0.1:9101/metrics'').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e.message);process.exit(1)})'

if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }
if ($Count -lt 1 -or $Count -gt 50) { throw 'Count must be between 1 and 50' }

function Invoke-Docker([string[]]$Arguments) {
  & $Docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
}

function Ensure-Kafka {
  $deadline = (Get-Date).AddSeconds(60)
  do {
    $health = (& $Docker 'inspect' '--format' '{{.State.Health.Status}}' 'platform-kafka' 2>$null).Trim()
    if ($health -eq 'healthy') { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "platform-kafka is not healthy: $health"
}

function Ensure-Topic {
  Invoke-Docker @(
    'exec', 'platform-kafka', '/opt/kafka/bin/kafka-topics.sh',
    '--bootstrap-server', 'kafka:19092', '--create', '--if-not-exists',
    '--topic', $Topic, '--partitions', '1', '--replication-factor', '1'
  )
}

function Ensure-Consumer {
  $state = (& $Docker 'inspect' '--format' '{{.State.Status}}' $ConsumerName 2>$null).Trim()
  if ($state -ne 'running') { throw "consumer is not running ($state); run: .\deploy\event-bus\consumer-pilot.ps1 -Action up" }
}

function Query-Scalar([string]$Sql) {
  $result = & $Docker 'exec' 'postgres' 'psql' '-U' $PgUser '-d' $PgDatabase '-At' '-v' 'ON_ERROR_STOP=1' '-c' $Sql
  if ($LASTEXITCODE -ne 0) { throw "query failed: $Sql" }
  return ([string]($result | Select-Object -First 1)).Trim()
}

function Seed-Outbox {
  $runId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $traceId = [Guid]::NewGuid().ToString('N')
  $values = 1..$Count | ForEach-Object {
    $sequence = $_
    $dedupe = "outbox-pilot:${runId}:$sequence"
    $requestId = "outbox-pilot-${runId}-$sequence"
    # jsonb_build_object keeps the whole SQL double-quote-free (PS 5.1 trap).
    "('$requestId','$traceId','$Kind','$dedupe',jsonb_build_object('probe','outbox-publisher-v1','run_id','$runId','sequence',$sequence))"
  }
  $sql = "INSERT INTO platform.outbox (request_id, trace_id, kind, dedupe_key, payload) VALUES $($values -join ',') ON CONFLICT (dedupe_key) DO NOTHING;"
  & $Docker 'exec' 'postgres' 'psql' '-U' $PgUser '-d' $PgDatabase '-v' 'ON_ERROR_STOP=1' '-c' $sql | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'outbox seed failed' }
  $runId
}

function Wait-Until([scriptblock]$Probe, [int]$TimeoutSec, [string]$What) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    $value = & $Probe
    if ($value) { return $value }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "timed out waiting for $What"
}

function Get-ConsumerCounters([string]$ContainerName) {
  # -join: docker output is a line array; -match on an array filters instead
  # of populating $Matches, which would silently zero every counter.
  $text = (& $Docker 'exec' $ContainerName 'node' '-e' $MetricsJs) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "cannot scrape metrics from $ContainerName" }
  $get = {
    param($name)
    if ($text -match "(?m)^$name (\d+)$") { [long]$Matches[1] } else { 0 }
  }
  @{
    processed  = (& $get 'platform_event_consumer_processed_total')
    duplicates = (& $get 'platform_event_consumer_duplicates_total')
    invalid    = (& $get 'platform_event_consumer_invalid_total')
  }
}

function Get-TopicReplayTarget {
  # Messages a from-beginning replay can actually read: sum(end - start) per
  # partition. Retention deletes old messages, so the end offset alone is NOT
  # the replay target. kafka.tools.GetOffsetShell was removed in
  # apache/kafka:4.4.0; kafka-get-offsets.sh is the supported entry point.
  $offsets = @{}
  foreach ($time in @('-2', '-1')) {
    $lines = & $Docker 'exec' 'platform-kafka' '/opt/kafka/bin/kafka-get-offsets.sh' '--bootstrap-server' 'kafka:19092' '--topic' $Topic '--time' $time
    if ($LASTEXITCODE -ne 0) { throw "kafka-get-offsets --time $time failed" }
    foreach ($line in $lines) {
      if ($line -match '^(.+:\d+):(\d+)$') {
        $key = $Matches[1]
        if (-not $offsets.ContainsKey($key)) { $offsets[$key] = @{} }
        $offsets[$key][$time] = [long]$Matches[2]
      }
    }
  }
  $sum = [long]0
  foreach ($key in $offsets.Keys) {
    $sum += ($offsets[$key]['-1'] - $offsets[$key]['-2'])
  }
  $sum
}

function Check-Consumer {
  Ensure-Kafka
  Ensure-Topic
  Ensure-Consumer
  $runId = Seed-Outbox

  # 1) Publisher delivers the seeded rows.
  $delivered = Wait-Until -TimeoutSec 45 -What 'outbox DELIVERED' -Probe {
    $n = Query-Scalar "SELECT count(*) FROM platform.outbox WHERE kind = '$Kind' AND dedupe_key LIKE 'outbox-pilot:${runId}:%' AND state = 'DELIVERED';"
    if ([int]$n -ge $Count) { [int]$n } else { $null }
  }

  # 2) Consumer records each dedupe_key exactly once.
  $ledgerRun = Wait-Until -TimeoutSec 45 -What 'consumer ledger rows' -Probe {
    try {
      $n = Query-Scalar "SELECT count(*) FROM platform.consumed_events WHERE topic = '$Topic' AND dedupe_key LIKE 'outbox-pilot:${runId}:%';"
      if ([int]$n -ge $Count) { [int]$n } else { $null }
    } catch { $null }
  }
  $ledgerTotalBefore = [long](Query-Scalar 'SELECT count(*) FROM platform.consumed_events;')

  # 3) Negative control: a SECOND consumer group replays the whole topic from
  #    the beginning. Every message is already in the ledger, so the replay
  #    must be all duplicates and the ledger must not grow by even one row.
  $replayName = "platform-event-consumer-replay-$runId"
  $replayGroup = "replay-$runId"
  try {
    $expectedTotal = Get-TopicReplayTarget
    Invoke-Docker @(
      'compose', '--profile', 'event-bus', '--profile', 'event-bus-outbox',
      'run', '-d', '--name', $replayName,
      '-e', "PLATFORM_CONSUMER_GROUP=$replayGroup",
      '-e', 'PLATFORM_CONSUMER_FROM_BEGINNING=true',
      'platform-event-consumer'
    ) | Out-Null
    $replay = Wait-Until -TimeoutSec 90 -What 'replay consumer catch-up' -Probe {
      try {
        $c = Get-ConsumerCounters $replayName
        if (($c.processed + $c.duplicates + $c.invalid) -ge $expectedTotal) { $c } else { $null }
      } catch { $null }
    }
    $ledgerTotalAfter = [long](Query-Scalar 'SELECT count(*) FROM platform.consumed_events;')
    $ledgerRunAfter = [int](Query-Scalar "SELECT count(*) FROM platform.consumed_events WHERE topic = '$Topic' AND dedupe_key LIKE 'outbox-pilot:${runId}:%';")
    if ($ledgerTotalAfter -ne $ledgerTotalBefore) { throw "replay created effects: ledger $ledgerTotalBefore -> $ledgerTotalAfter" }
    if ($ledgerRunAfter -ne $Count) { throw "replay changed run rows: $ledgerRunAfter != $Count" }
    if ($replay.duplicates -lt $Count) { throw "replay did not actually re-read the seeded messages: duplicates=$($replay.duplicates)" }
  } finally {
    & $Docker 'rm' '-f' $replayName 2>$null | Out-Null
  }

  # 4) Metrics surface: publisher must expose all five outbox states.
  $publisherMetrics = (& $Docker 'exec' 'platform-outbox-publisher' 'node' '-e' $PublisherMetricsJs) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'cannot scrape publisher metrics' }
  foreach ($state in @('PENDING', 'DELIVERING', 'DELIVERED', 'RETRY', 'DEAD_LETTER')) {
    if ($publisherMetrics -notmatch "platform_outbox_rows\{kind=`"$Kind`",state=`"$state`"\}") {
      throw "publisher metrics missing state series: $state"
    }
  }

  Write-Output (@{
    ok = $true
    topic = $Topic
    kind = $Kind
    run_id = $runId
    delivered = $delivered
    ledger_rows_for_run = $ledgerRun
    ledger_total_before_replay = $ledgerTotalBefore
    ledger_total_after_replay = $ledgerTotalAfter
    replay_processed = $replay.processed
    replay_duplicates = $replay.duplicates
    mode = 'isolated outbox pilot; Runtime and kb_save unchanged'
  } | ConvertTo-Json -Compress)
}

switch ($Action) {
  'up' {
    Invoke-Docker @('compose', '--profile', 'event-bus', '--profile', 'event-bus-outbox', 'up', '-d', '--build', 'kafka', 'platform-outbox-publisher', 'platform-event-consumer')
    Ensure-Kafka
    Ensure-Topic
    Write-Output (@{ ok = $true; topic = $Topic; consumer = $ConsumerName } | ConvertTo-Json -Compress)
  }
  'check' { Check-Consumer }
  'status' {
    $consumerState = (& $Docker 'inspect' '--format' '{{.State.Status}}' $ConsumerName 2>$null).Trim()
    $publisherState = (& $Docker 'inspect' '--format' '{{.State.Status}}' 'platform-outbox-publisher' 2>$null).Trim()
    Write-Output (@{ consumer = $consumerState; publisher = $publisherState; topic = $Topic } | ConvertTo-Json -Compress)
  }
  'down' { Invoke-Docker @('compose', '--profile', 'event-bus', '--profile', 'event-bus-outbox', 'stop', 'platform-event-consumer') }
}