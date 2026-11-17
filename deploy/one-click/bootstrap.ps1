<#
.SYNOPSIS
Fresh-machine bootstrap for the default stack (ISSUE-A2 / E3).

.DESCRIPTION
Creates the two external resources that docker-compose.yml declares as
external:true and will not create automatically:

    docker network create n8n-net
    docker volume  create n8n_data

It NEVER reads, prints or edits .env (AGENTS.md 14.5). -Action up calls
docker compose up -d only after all checks pass; the operator must ensure the
other agent sharing this stack is not deploying at the same time (14.5).

.EXAMPLE
    pwsh deploy/one-click/bootstrap.ps1 -Action check
    pwsh deploy/one-click/bootstrap.ps1 -Action up
#>
[CmdletBinding()]
param(
    [ValidateSet('check', 'up')]
    [string]$Action = 'check'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $root
try {
    $fail = 0
    function Check([string]$label, [bool]$ok, [string]$detail = '') {
        $tag = if ($ok) { 'OK  ' } else { 'FAIL' }
        $suffix = if ($detail) { " - $detail" } else { '' }
        Write-Host ("{0} {1}{2}" -f $tag, $label, $suffix)
        if (-not $ok) { $script:fail++ }
    }

    Write-Host '== agent-platform fresh-machine check =='

    try { $null = & docker --version 2>&1; Check 'docker CLI available' $true }
    catch { Check 'docker CLI available' $false 'install Docker Desktop first'; return 1 }

    Check '.env exists' (Test-Path (Join-Path $root '.env')) 'copy .env.example and fill real values'
    Check 'frontent/.env.local exists' (Test-Path (Join-Path $root 'frontent/.env.local')) 'console secrets (gitignored)'
    Check 'docker-compose.yml present' (Test-Path (Join-Path $root 'docker-compose.yml'))

    $net = & docker network ls --filter 'name=^n8n-net$' --format '{{.Name}}' 2>$null
    $vol = & docker volume ls --filter 'name=^n8n_data$' --format '{{.Name}}' 2>$null
    $netExists = ($net -join '') -eq 'n8n-net'
    $volExists = ($vol -join '') -eq 'n8n_data'

    if ($Action -eq 'check') {
        Check 'external network n8n-net' $netExists 'run -Action up to create it'
        Check 'external volume n8n_data' $volExists 'run -Action up to create it'
    }
    else {
        if (-not $netExists) {
            & docker network create n8n-net | Out-Null
            Write-Host 'OK   created external network n8n-net'
        }
        else { Write-Host 'OK   external network n8n-net already present' }
        if (-not $volExists) {
            & docker volume create n8n_data | Out-Null
            Write-Host 'OK   created external volume n8n_data'
        }
        else { Write-Host 'OK   external volume n8n_data already present' }
    }

    if ($fail -gt 0) {
        Write-Host "$fail check(s) failed - nothing was started." -ForegroundColor Yellow
        return 1
    }

    if ($Action -eq 'check') {
        Write-Host 'All preconditions satisfied. Re-run with -Action up to create missing resources and start the stack.' -ForegroundColor Green
        return 0
    }

    Write-Host 'Starting the default stack (12 resident services). Ensure no other agent is deploying.' -ForegroundColor Yellow
    & docker compose up -d
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'compose up failed' -ForegroundColor Red
        return $LASTEXITCODE
    }
    Write-Host 'Done. Verify with: curl http://localhost:5678/healthz' -ForegroundColor Green
    return 0
}
finally {
    Pop-Location
}
