param(
  [ValidateSet('topic', 'produce', 'consume', 'concurrent', 'consumer-group')]
  [string]$Action = 'topic',
  [string]$Topic = 'platform.events.load.v1',
  [int]$Partitions = 6,
  [int]$Records = 50000,
  [int]$RecordSize = 512,
  [int]$Producers = 4,
  [int]$RecordsPerProducer = 25000,
  [int]$Consumers = 6,
  [int]$RecordsPerConsumer = 15000,
  [string]$ConsumerGroup = ''
)

$ErrorActionPreference = 'Stop'
$Docker = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'

if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }
if ($Partitions -lt 1) { throw 'Partitions must be at least 1' }
if ($Records -lt 1) { throw 'Records must be at least 1' }
if ($RecordSize -lt 1) { throw 'RecordSize must be at least 1' }
if ($Producers -lt 1) { throw 'Producers must be at least 1' }
if ($RecordsPerProducer -lt 1) { throw 'RecordsPerProducer must be at least 1' }
if ($Consumers -lt 1) { throw 'Consumers must be at least 1' }
if ($RecordsPerConsumer -lt 1) { throw 'RecordsPerConsumer must be at least 1' }

function Invoke-Docker([string[]]$Arguments) {
  & $Docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
}

function Ensure-Topic {
  Invoke-Docker @(
    'exec', 'platform-kafka', '/opt/kafka/bin/kafka-topics.sh',
    '--bootstrap-server', 'kafka:19092', '--create', '--if-not-exists',
    '--topic', $Topic, '--partitions', $Partitions, '--replication-factor', '1'
  )
}

function Produce([int]$Count, [int]$Size, [string]$ClientId = 'phase5.3-producer') {
  Invoke-Docker @(
    'exec', 'platform-kafka', '/opt/kafka/bin/kafka-producer-perf-test.sh',
    '--bootstrap-server', 'kafka:19092', '--topic', $Topic,
    '--num-records', $Count, '--record-size', $Size, '--throughput', '-1',
    '--print-metrics', '--command-property', "client.id=$ClientId"
  )
}

function Consume([int]$Count) {
  $group = if ($ConsumerGroup) { $ConsumerGroup } else { "phase5.3-load-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" }
  Invoke-Docker @(
    'exec', 'platform-kafka', '/opt/kafka/bin/kafka-consumer-perf-test.sh',
    '--bootstrap-server', 'kafka:19092', '--topic', $Topic, '--group', $group,
    '--num-records', $Count, '--print-metrics', '--reporting-interval', '5000'
  )
}

function Concurrent-Produce {
  $jobs = 1..$Producers | ForEach-Object {
    $producerId = $_
    Start-Job -ScriptBlock {
      param($dockerPath, $topicName, $count, $size, $id)
      & $dockerPath exec platform-kafka /opt/kafka/bin/kafka-producer-perf-test.sh `
        --bootstrap-server kafka:19092 --topic $topicName --num-records $count `
        --record-size $size --throughput -1 --command-property "client.id=phase5.3-producer-$id"
      if ($LASTEXITCODE -ne 0) { throw "producer $id failed with exit code $LASTEXITCODE" }
    } -ArgumentList $Docker, $Topic, $RecordsPerProducer, $RecordSize, $producerId
  }
  try {
    Wait-Job -Job $jobs | Out-Null
    Receive-Job -Job $jobs -ErrorAction Stop
  } finally {
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
  }
}

function Consumer-Group {
  $group = if ($ConsumerGroup) { $ConsumerGroup } else { "phase5.3-consumers-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" }
  $jobs = 1..$Consumers | ForEach-Object {
    $consumerId = $_
    Start-Job -ScriptBlock {
      param($dockerPath, $topicName, $groupName, $count, $id)
      & $dockerPath exec platform-kafka /opt/kafka/bin/kafka-consumer-perf-test.sh `
        --bootstrap-server kafka:19092 --topic $topicName --group $groupName `
        --num-records $count --reporting-interval 5000 `
        --command-property "client.id=phase5.3-consumer-$id"
      if ($LASTEXITCODE -ne 0) { throw "consumer $id failed with exit code $LASTEXITCODE" }
    } -ArgumentList $Docker, $Topic, $group, $RecordsPerConsumer, $consumerId
  }
  try {
    Write-Output ("group=" + $group)
    Wait-Job -Job $jobs | Out-Null
    Receive-Job -Job $jobs -ErrorAction Stop
  } finally {
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
  }
}

switch ($Action) {
  'topic' { Ensure-Topic }
  'produce' { Ensure-Topic; Produce -Count $Records -Size $RecordSize }
  'consume' { Consume -Count $Records }
  'concurrent' { Ensure-Topic; Concurrent-Produce }
  'consumer-group' { Consumer-Group }
}
