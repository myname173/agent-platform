param(
  [string]$Topic = 'platform.events.load.interrupt.v1',
  [string]$ConsumerGroup = 'phase5.3-interrupt-check',
  [int]$Partitions = 3,
  [int]$Records = 200000,
  [int]$RecordSize = 256,
  [int]$ProducerRate = 10000,
  [int]$InterruptAfterSeconds = 2
)

$ErrorActionPreference = 'Stop'
$Docker = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }

function Invoke-Docker([string[]]$Arguments) {
  & $Docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
}

Invoke-Docker @(
  'exec', 'platform-kafka', '/opt/kafka/bin/kafka-topics.sh',
  '--bootstrap-server', 'kafka:19092', '--create', '--if-not-exists',
  '--topic', $Topic, '--partitions', $Partitions, '--replication-factor', '1'
)

$producerOut = [System.IO.Path]::GetTempFileName()
$producerErr = [System.IO.Path]::GetTempFileName()
$producer = $null
$runId = [Guid]::NewGuid().ToString('N')
$consumerPidFile = "/tmp/kafka-interrupt-$runId.pid"
$consumerOutFile = "/tmp/kafka-interrupt-$runId.out"
$consumerErrFile = "/tmp/kafka-interrupt-$runId.err"

try {
  $dollar = [string][char]36
  $consumerShell = "echo $dollar$dollar > $consumerPidFile; exec /opt/kafka/bin/kafka-consumer-perf-test.sh --bootstrap-server kafka:19092 --topic $Topic --group $ConsumerGroup --num-records $Records --command-property enable.auto.commit=true --reporting-interval 5000 > $consumerOutFile 2> $consumerErrFile"
  & $Docker exec -d platform-kafka sh -c $consumerShell | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "failed to start consumer in Kafka container: $LASTEXITCODE" }
  $remotePid = ''
  $pidDeadline = (Get-Date).AddSeconds(10)
  do {
    $remotePid = (& $Docker exec platform-kafka cat $consumerPidFile 2>$null).Trim()
    if ($remotePid -match '^\d+$') { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $pidDeadline)
  if ($remotePid -notmatch '^\d+$') { throw 'consumer pid was not created in Kafka container' }
  Start-Sleep -Seconds 2

  $producerArgs = @(
    'exec', 'platform-kafka',
    '/opt/kafka/bin/kafka-producer-perf-test.sh',
    '--bootstrap-server', 'kafka:19092', '--topic', $Topic,
    '--num-records', $Records, '--record-size', $RecordSize,
    '--throughput', $ProducerRate,
    '--command-property', 'client.id=phase5.3-interrupt-producer'
  )
  $producer = Start-Process -FilePath $Docker -ArgumentList $producerArgs `
    -RedirectStandardOutput $producerOut -RedirectStandardError $producerErr -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds $InterruptAfterSeconds

  & $Docker exec platform-kafka kill -KILL $remotePid | Out-Null
  $consumerKillExit = $LASTEXITCODE
  $producer.WaitForExit()

  $lag = & $Docker exec platform-kafka /opt/kafka/bin/kafka-consumer-groups.sh `
    --bootstrap-server kafka:19092 --describe --group $ConsumerGroup

  Write-Output (@{
    topic = $Topic
    group = $ConsumerGroup
    consumer_pid = $remotePid
    consumer_kill_exit = $consumerKillExit
    producer_exit = $producer.ExitCode
    lag_after_interrupt = ($lag -join "`n")
  } | ConvertTo-Json -Compress)
} finally {
  & $Docker exec platform-kafka rm -f $consumerPidFile $consumerOutFile $consumerErrFile 2>$null | Out-Null
  foreach ($path in @($producerOut, $producerErr)) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}
