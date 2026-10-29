param(
  [ValidateSet('check', 'up', 'down', 'status')]
  [string]$Action = 'check'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DockerBin = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin'
$Docker = Join-Path $DockerBin 'docker.exe'
$env:Path = "$DockerBin;$env:Path"
$BaseCompose = Join-Path $Root 'docker-compose.yml'
$TunnelCompose = Join-Path $Root 'deploy\cloudflare\docker-compose.tunnel.yml'

if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }

function Invoke-Docker([string[]]$Arguments) {
  & $Docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
}

function Read-DotEnv([string]$Name) {
  $line = Get-Content (Join-Path $Root '.env') -ErrorAction SilentlyContinue |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=(.*)$" } |
    Select-Object -First 1
  if (-not $line) { return '' }
  return ($line -split '=', 2)[1].Trim().Trim("'").Trim('"')
}

function Validate-TunnelConfig {
  $envFile = Join-Path $Root '.env'
  if (-not (Test-Path $envFile)) { throw ".env is required: $envFile" }

  $domain = Read-DotEnv 'CLOUDFLARE_DOMAIN'
  if ($domain -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$') {
    throw 'CLOUDFLARE_DOMAIN must be a DNS name managed by Cloudflare'
  }

  $token = Read-DotEnv 'CLOUDFLARE_TUNNEL_TOKEN'
  if ([string]::IsNullOrWhiteSpace($token) -or $token -eq 'replace-me') {
    throw 'CLOUDFLARE_TUNNEL_TOKEN is required in .env'
  }

  Invoke-Docker @('compose', '-f', $BaseCompose, '-f', $TunnelCompose, 'config', '--quiet')
}

$Compose = @('-f', $BaseCompose, '-f', $TunnelCompose)
switch ($Action) {
  'check' {
    Validate-TunnelConfig
    Write-Output 'Cloudflare Tunnel configuration is valid'
  }
  'up' {
    Validate-TunnelConfig
    Invoke-Docker (@('compose') + $Compose + @('up', '-d'))
  }
  'down' {
    Validate-TunnelConfig
    Invoke-Docker (@('compose') + $Compose + @('down'))
  }
  'status' {
    Validate-TunnelConfig
    Invoke-Docker (@('compose') + $Compose + @('ps', 'cloudflared'))
  }
}

