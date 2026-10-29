param(
  [ValidateSet('apply', 'check', 'forward')]
  [string]$Action = 'check',
  [switch]$BuildImages
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$DockerBin = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin'
$Kubectl = Join-Path $DockerBin 'kubectl.exe'
$Docker = Join-Path $DockerBin 'docker.exe'
$EnvFile = Join-Path $Root '.env'
$PilotDir = $PSScriptRoot

if (-not (Test-Path $Kubectl)) { throw "kubectl not found: $Kubectl" }
if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

function Get-DotEnvValue([string]$Name) {
  if (-not (Test-Path $EnvFile)) { throw ".env is required: $EnvFile" }
  $line = Get-Content $EnvFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
  if (-not $line) { return '' }
  return ($line -split '=', 2)[1]
}

function Apply-Manifest([string]$Name) {
  Invoke-Native $Kubectl @('apply', '-n', 'agent-platform', '-f', (Join-Path $PilotDir $Name))
}

$context = (& $Kubectl config current-context).Trim()
if ($context -ne 'docker-desktop') { throw "expected kubectl context docker-desktop, got '$context'" }

if ($Action -eq 'forward') {
  & $Kubectl '-n' 'agent-platform' 'port-forward' 'service/platform-sandbox-gateway' '--address' '127.0.0.1' '18080:8080'
  exit $LASTEXITCODE
}

if ($Action -eq 'apply') {
  if ($BuildImages) {
    Invoke-Native $Docker @('build', '-f', 'n8n/sandbox.Dockerfile', '-t', 'agent-platform/sandbox:3.14-k8s-pilot', 'n8n')
    Invoke-Native $Docker @('build', '-f', 'n8n/sandbox-gateway.Dockerfile', '-t', 'agent-platform/sandbox-gateway:0.2', 'n8n')
  }

  Invoke-Native $Kubectl @('apply', '-f', (Join-Path $PilotDir 'namespace.yaml'))
  $chatKey = Get-DotEnvValue 'CHAT_API_KEY'
  if ([string]::IsNullOrWhiteSpace($chatKey)) { throw 'CHAT_API_KEY is empty in .env' }
  $runtimeKey = Get-DotEnvValue 'PLATFORM_RUNTIME_KEY'
  $secretYaml = & $Kubectl '-n' 'agent-platform' 'create' 'secret' 'generic' 'platform-runtime-secrets' "--from-literal=CHAT_API_KEY=$chatKey" "--from-literal=PLATFORM_RUNTIME_KEY=$runtimeKey" '--dry-run=client' '-o' 'yaml'
  if ($LASTEXITCODE -ne 0) { throw 'failed to render platform-runtime-secrets' }
  $secretYaml | & $Kubectl 'apply' '-f' '-'
  if ($LASTEXITCODE -ne 0) { throw 'failed to apply platform-runtime-secrets' }

  Apply-Manifest 'sandbox-serviceaccount.yaml'
  Apply-Manifest 'sandbox-networkpolicy.yaml'
  Apply-Manifest 'worker-configmap.yaml'
  Apply-Manifest 'worker-networkpolicy.yaml'
  Apply-Manifest 'worker-deployment.yaml'
  Apply-Manifest 'sandbox-gateway-rbac.yaml'
  Apply-Manifest 'sandbox-gateway-deployment.yaml'
  Apply-Manifest 'sandbox-gateway-service.yaml'
  Invoke-Native $Kubectl @('rollout', 'status', 'deployment/platform-worker', '-n', 'agent-platform', '--timeout=90s')
  Invoke-Native $Kubectl @('rollout', 'status', 'deployment/platform-sandbox-gateway', '-n', 'agent-platform', '--timeout=90s')
  Write-Output 'Pilot resources applied. Install the loopback bridge with: .\sandbox-bridge.ps1 -Action install'
  exit 0
}

if ($Action -eq 'check') {
  Invoke-Native $Kubectl @('rollout', 'status', 'deployment/platform-worker', '-n', 'agent-platform', '--timeout=30s')
  Invoke-Native $Kubectl @('rollout', 'status', 'deployment/platform-sandbox-gateway', '-n', 'agent-platform', '--timeout=30s')

  foreach ($url in @('http://127.0.0.1:5678/healthz', 'http://127.0.0.1:13220/healthz', 'http://127.0.0.1:18080/healthz')) {
    $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 5
    if ($response.StatusCode -ne 200) { throw "$url returned $($response.StatusCode)" }
    Write-Output "$url -> $($response.StatusCode)"
  }

  $redis = (& $Docker 'exec' 'platform-redis' 'redis-cli' 'ping').Trim()
  if ($redis -ne 'PONG') { throw "Redis health check returned '$redis'" }
  $pending = (& $Docker 'exec' 'platform-redis' 'redis-cli' 'XPENDING' 'platform:jobs' 'platform-kb-workers').Trim()
  $pendingCount = ($pending -split '\s+')[0]
  if ($pendingCount -ne '0') { throw "Redis pending jobs are not zero: $pending" }
  Write-Output 'redis -> PONG; platform-kb-workers pending -> 0'
  Invoke-Native $Kubectl @('get', 'deployment,pod,service', '-n', 'agent-platform', '-l', 'app.kubernetes.io/part-of=agent-platform', '-o', 'wide')
}
