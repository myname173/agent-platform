param(
  [ValidateSet('up', 'check', 'down')]
  [string]$Action = 'check'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DockerBin = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin'
$Docker = Join-Path $DockerBin 'docker.exe'
$env:Path = "$DockerBin;$env:Path"
$Topic = 'platform.events.v1'
$RunId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()

if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }

function Invoke-Docker([string[]]$Arguments) {
  & $Docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
}

function Check-Kafka {
  $deadline = (Get-Date).AddSeconds(60)
  do {
    $health = (& $Docker 'inspect' '--format' '{{.State.Health.Status}}' 'platform-kafka' 2>$null).Trim()
    if ($health -eq 'healthy') { break }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  if ($health -ne 'healthy') { throw "platform-kafka is not healthy: $health" }

  Invoke-Docker @('exec', 'platform-kafka', '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'kafka:19092', '--create', '--if-not-exists', '--topic', $Topic, '--partitions', '1', '--replication-factor', '1')

  $payload = (@{
    event_id = "phase5.3-$RunId"
    event_type = 'platform.pilot'
    occurred_at = [DateTime]::UtcNow.ToString('o')
    source = 'kafka-pilot'
    data = @{ probe = 'produce-consume' }
  } | ConvertTo-Json -Compress)

  $payload | & $Docker 'exec' '-i' 'platform-kafka' '/opt/kafka/bin/kafka-console-producer.sh' '--bootstrap-server' 'kafka:19092' '--topic' $Topic
  if ($LASTEXITCODE -ne 0) { throw 'Kafka producer failed' }

  $group = "phase5.3-$RunId"
  $records = & $Docker 'exec' 'platform-kafka' '/opt/kafka/bin/kafka-console-consumer.sh' '--bootstrap-server' 'kafka:19092' '--topic' $Topic '--group' $group '--from-beginning' '--max-messages' '100' '--timeout-ms' '10000'
  if ($LASTEXITCODE -ne 0 -or -not (($records -join "`n") -match [regex]::Escape("phase5.3-$RunId"))) {
    throw 'Kafka consumer did not read the probe event'
  }

  Write-Output (@{
    ok = $true
    topic = $Topic
    event_id = "phase5.3-$RunId"
    mode = 'pilot-only; Redis Streams remains kb_save queue'
  } | ConvertTo-Json -Compress)
}

switch ($Action) {
  'up' {
    Invoke-Docker @('compose', '--profile', 'event-bus', 'up', '-d', 'kafka')
    Check-Kafka
  }
  'check' { Check-Kafka }
  'down' { Invoke-Docker @('compose', '--profile', 'event-bus', 'stop', 'kafka') }
}
