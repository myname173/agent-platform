param(
  [ValidateSet('check')]
  [string]$Action = 'check'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Docker = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
$Kubectl = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin\kubectl.exe'
$env:Path = "$(Split-Path $Docker);$env:Path"

if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }
if (-not (Test-Path $Kubectl)) { throw "kubectl not found: $Kubectl" }

function Invoke-Native([string]$File, [string[]]$Arguments) {
  $output = & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
  @($output)
}

function Get-DotEnvValue([string]$Name) {
  $file = Join-Path $Root '.env'
  if (-not (Test-Path $file)) { return '' }
  $line = Get-Content $file | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
  if (-not $line) { return '' }
  ($line -split '=', 2)[1].Trim()
}

function Assert-Contains([string[]]$Values, [string]$Expected, [string]$Label) {
  if ($Values -notcontains $Expected) { throw "$Label is missing '$Expected'" }
}

if ($Action -eq 'check') {
  Push-Location $Root
  try {
    Invoke-Native $Docker @('compose', 'config', '--quiet') | Out-Null

    $defaultServices = Invoke-Native $Docker @('compose', 'config', '--services')
    foreach ($service in @('postgres', 'n8n', 'redis', 'platform-runtime', 'console', 'backup')) {
      Assert-Contains $defaultServices $service 'default Compose services'
    }
    foreach ($service in @('kafka', 'platform-event-publisher', 'platform-outbox-publisher', 'prometheus', 'platform-worker')) {
      if ($defaultServices -contains $service) { throw "optional service '$service' leaked into default Compose profile" }
    }

    $eventServices = Invoke-Native $Docker @('compose', '--profile', 'event-bus', 'config', '--services')
    Assert-Contains $eventServices 'kafka' 'event-bus profile'
    Assert-Contains $eventServices 'platform-event-publisher' 'event-bus profile'

    $outboxServices = Invoke-Native $Docker @('compose', '--profile', 'event-bus', '--profile', 'event-bus-outbox', 'config', '--services')
    Assert-Contains $outboxServices 'platform-outbox-publisher' 'event-bus-outbox profile'

    $kustomize = Invoke-Native $Kubectl @('kustomize', 'deploy/k8s/phase3-pilot')
    if (-not ($kustomize -match 'kind: Deployment')) { throw 'K8s pilot manifest did not render a Deployment' }

    $contextOutput = @(Invoke-Native $Kubectl @('config', 'current-context'))
    $context = [string]$contextOutput[-1]
    $context = $context.Trim()
    $async = Get-DotEnvValue 'PLATFORM_KB_ASYNC_ENABLED'
    $outbox = Get-DotEnvValue 'PLATFORM_OUTBOX_WRITE_MODE'
    $profile = if ($async -eq 'true') { 'pilot-async' } else { 'compose-sync' }
    if ([string]::IsNullOrWhiteSpace($outbox)) { $outbox = 'off (default)' }

    $health = @{}
    foreach ($entry in @(
      @{ Name = 'console'; Url = 'http://127.0.0.1:3000/' },
      @{ Name = 'n8n'; Url = 'http://127.0.0.1:5678/healthz' },
      @{ Name = 'runtime'; Url = 'http://127.0.0.1:13220/readyz' }
    )) {
      $response = Invoke-WebRequest -UseBasicParsing $entry.Url -TimeoutSec 5
      if ($response.StatusCode -ne 200) { throw "$($entry.Name) health returned $($response.StatusCode)" }
      $health[$entry.Name] = $response.StatusCode
    }

    $redisOutput = @(Invoke-Native $Docker @('exec', 'platform-redis', 'redis-cli', 'ping'))
    $redis = [string]$redisOutput[-1]
    $redis = $redis.Trim()
    if ($redis -ne 'PONG') { throw "Redis health returned '$redis'" }

    [ordered]@{
      ok = $true
      phase = '6.5A'
      mode = $profile
      kubernetes_context = $context
      outbox_write_mode = $outbox
      default_profile = 'core only'
      optional_profiles = @('phase2', 'observability', 'event-bus', 'event-bus-outbox')
      health = $health
      redis = $redis
      side_effects = 'read-only; no services changed; no business writes'
    } | ConvertTo-Json -Compress
  } finally {
    Pop-Location
  }
}
