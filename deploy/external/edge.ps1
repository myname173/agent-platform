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
$ExternalCompose = Join-Path $Root 'deploy\external\docker-compose.external.yml'

if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }

function Invoke-Docker([string[]]$Arguments) {
  & $Docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
}

function Validate-EdgeConfig {
  if (-not (Test-Path (Join-Path $Root '.env'))) { throw ".env is required: $Root\.env" }
  $envText = Get-Content (Join-Path $Root '.env') -Raw
  foreach ($name in @('PLATFORM_DOMAIN', 'ACME_EMAIL')) {
    if ($envText -notmatch "(?m)^$([regex]::Escape($name))=.+$") {
      throw "$name is required in .env before enabling the external edge"
    }
  }
  $hashLine = Get-Content (Join-Path $Root '.env') | Where-Object {
    $_ -match '^ADMIN_PASSWORD_HASH=(.+)$' -and -not [string]::IsNullOrWhiteSpace($Matches[1])
  } | Select-Object -First 1
  if (-not $hashLine) { throw 'ADMIN_PASSWORD_HASH is required in .env before enabling the external edge' }
  $hashValue = ($hashLine -split '=', 2)[1].Trim()
  if ($hashValue.Contains('$') -and -not ($hashValue.StartsWith("'") -and $hashValue.EndsWith("'"))) {
    throw 'ADMIN_PASSWORD_HASH must be wrapped in single quotes in .env because bcrypt hashes contain $ characters'
  }
  Invoke-Docker @('compose', '-f', $BaseCompose, '-f', $ExternalCompose, 'config', '--quiet')
}

$Compose = @('-f', $BaseCompose, '-f', $ExternalCompose)
switch ($Action) {
  'check' {
    Validate-EdgeConfig
    Write-Output 'external edge configuration is valid'
  }
  'up' {
    Validate-EdgeConfig
    Invoke-Docker (@('compose') + $Compose + @('up', '-d'))
  }
  'down' {
    Validate-EdgeConfig
    Invoke-Docker (@('compose') + $Compose + @('down'))
  }
  'status' {
    Validate-EdgeConfig
    Invoke-Docker (@('compose') + $Compose + @('ps'))
  }
}
