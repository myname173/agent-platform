param(
  [ValidateSet('up', 'seed', 'check', 'status', 'down')]
  [string]$Action = 'check',
  [int]$Count = 3
)

$ErrorActionPreference = 'Stop'
$Docker = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
$DockerBin = Split-Path $Docker
$env:Path = "$DockerBin;$env:Path"
$Topic = 'platform.events.outbox.v1'
$Kind = 'kafka-pilot'
$PgUser = 'n8n'
$PgDatabase = 'n8n'

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

function Query-Outbox([string]$RunId) {
  $sql = "SELECT dedupe_key || '|' || state || '|' || attempts FROM platform.outbox WHERE kind = '$Kind' AND dedupe_key LIKE 'outbox-pilot:${RunId}:%' ORDER BY outbox_id;"
  $result = & $Docker 'exec' 'postgres' 'psql' '-U' $PgUser '-d' $PgDatabase '-At' '-v' 'ON_ERROR_STOP=1' '-c' $sql
  if ($LASTEXITCODE -ne 0) { throw 'outbox query failed' }
  @($result | Where-Object { $_ -and $_.Trim() })
}

function Seed-Outbox {
  $runId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $traceId = [Guid]::NewGuid().ToString('N')
  $values = 1..$Count | ForEach-Object {
    $sequence = $_
    $dedupe = "outbox-pilot:${runId}:$sequence"
    $requestId = "outbox-pilot-${runId}-$sequence"
    # jsonb_build_object keeps the whole SQL double-quote-free: PS 5.1 strips
    # embedded double quotes when passing arguments to native commands.
    "('$requestId','$traceId','$Kind','$dedupe',jsonb_build_object('probe','outbox-publisher-v1','run_id','$runId','sequence',$sequence))"
  }
  $sql = "INSERT INTO platform.outbox (request_id, trace_id, kind, dedupe_key, payload) VALUES $($values -join ',') ON CONFLICT (dedupe_key) DO NOTHING;"
  & $Docker 'exec' 'postgres' 'psql' '-U' $PgUser '-d' $PgDatabase '-v' 'ON_ERROR_STOP=1' '-c' $sql | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'outbox seed failed' }
  Write-Output (@{ run_id = $runId; trace_id = $traceId; count = $Count; kind = $Kind } | ConvertTo-Json -Compress)
  $runId
}

function Publisher-Status {
  ((& $Docker 'inspect' '--format' '{{.State.Status}}' 'platform-outbox-publisher' 2>$null).Trim())
}

function Check-Outbox {
  Ensure-Kafka
  Ensure-Topic
  $seedOutput = @(Seed-Outbox)
  $runId = [string]$seedOutput[-1]
  $deadline = (Get-Date).AddSeconds(45)
  $rows = @()
  do {
    Start-Sleep -Milliseconds 500
    $rows = @(Query-Outbox -RunId $runId)
    $delivered = @($rows | Where-Object { $_ -match '\|DELIVERED\|' }).Count
  } while ($delivered -lt $Count -and (Get-Date) -lt $deadline)

  $group = "phase6.2-outbox-$runId"
  $records = & $Docker 'exec' 'platform-kafka' '/opt/kafka/bin/kafka-console-consumer.sh' '--bootstrap-server' 'kafka:19092' '--topic' $Topic '--group' $group '--from-beginning' '--max-messages' '100' '--timeout-ms' '10000'
  if ($LASTEXITCODE -ne 0) { throw 'Kafka consumer failed' }
  $matched = @($records | Where-Object { $_ -match [regex]::Escape($runId) }).Count
  $ok = ($delivered -eq $Count -and $matched -eq $Count)
  if (-not $ok) { throw "outbox check failed: delivered=$delivered kafka_records=$matched expected=$Count" }

  Write-Output (@{
    ok = $true
    topic = $Topic
    kind = $Kind
    run_id = $runId
    delivered = $delivered
    kafka_records = $matched
    publisher = Publisher-Status
    mode = 'isolated outbox pilot; Runtime and kb_save unchanged'
  } | ConvertTo-Json -Compress)
}

switch ($Action) {
  'up' {
    Invoke-Docker @('compose', '--profile', 'event-bus', '--profile', 'event-bus-outbox', 'up', '-d', '--build', 'kafka', 'platform-outbox-publisher')
    Ensure-Kafka
    Ensure-Topic
    Write-Output (@{ ok = $true; topic = $Topic; publisher = Publisher-Status } | ConvertTo-Json -Compress)
  }
  'seed' { Ensure-Kafka; Ensure-Topic; Seed-Outbox }
  'check' { Check-Outbox }
  'status' { Write-Output (@{ publisher = Publisher-Status; topic = $Topic } | ConvertTo-Json -Compress) }
  'down' { Invoke-Docker @('compose', '--profile', 'event-bus', '--profile', 'event-bus-outbox', 'stop', 'platform-outbox-publisher') }
}
