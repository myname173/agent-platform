param(
  [string]$EnvFile = (Join-Path $PSScriptRoot '..\.env')
)

$ErrorActionPreference = 'Stop'

function Read-DotEnv([string]$Name) {
  $line = Get-Content $EnvFile | Where-Object {
    $_ -match "^$([regex]::Escape($Name))=(.*)$"
  } | Select-Object -First 1
  if (-not $line) { return '' }
  return ($line -split '=', 2)[1].Trim()
}

$token = Read-DotEnv 'duckdns_token'
$domain = Read-DotEnv 'PLATFORM_DOMAIN'
if ([string]::IsNullOrWhiteSpace($token)) { throw 'duckdns_token is required in .env' }
if ([string]::IsNullOrWhiteSpace($domain)) { throw 'PLATFORM_DOMAIN is required in .env' }

$suffix = '.duckdns.org'
if (-not $domain.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "PLATFORM_DOMAIN must end with $suffix"
}
$subdomain = $domain.Substring(0, $domain.Length - $suffix.Length)
$uri = "https://www.duckdns.org/update?domains=$([uri]::EscapeDataString($subdomain))&token=$([uri]::EscapeDataString($token))&verbose=true"
$rawResponse = (Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 15).Content
$response = if ($rawResponse -is [byte[]]) {
  [System.Text.Encoding]::UTF8.GetString($rawResponse)
} else {
  [string]$rawResponse
}
$response = $response.Trim()
if ($response -notmatch '(^|\r?\n)OK(\r?\n|$)') {
  throw "DuckDNS update failed: $($response -replace 'token=[^&\s]+', 'token=<redacted>')"
}
Write-Output "DuckDNS update OK: $domain"
