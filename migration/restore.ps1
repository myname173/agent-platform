#Requires -Version 5.1
<#
.SYNOPSIS
    Restore the agent-platform migration pack on a brand new machine.

.DESCRIPTION
    Runs in order:
      0  preflight        docker / compose / pack layout
      1  copy project     -> $Target
      2  rewrite .env      PLATFORM_LAN_IP / LAN_IP -> this machine's LAN IP
      3  volumes          docker volume create n8n_data   (it is external:true,
                          compose will NOT create it and aborts without it)
      4  postgres only    up + wait for healthy
      5  volume payload   n8n_data / minio_data restored from the tar.gz snapshots
      6  databases        create lobechat db, then feed both pg dumps in
      7  full stack       docker compose up -d --build
      8  hand off         print what to check next

    Order matters: the volume archives must land BEFORE n8n/minio start, and
    the SQL must land BEFORE n8n runs its migrations over an empty schema.

.EXAMPLE
    .\restore.ps1
    .\restore.ps1 -Target D:\agent-platform -LanIp 192.168.1.50
#>
[CmdletBinding()]
param(
    [string]$Target = "C:\agent-platform",
    [string]$LanIp  = ""
)

$ErrorActionPreference = "Stop"
$PackRoot  = Split-Path -Parent $PSScriptRoot
$ProjectSrc = Join-Path $PackRoot "project"
$DataSrc    = Join-Path $PackRoot "data"

function Say($msg, $color = "Cyan") { Write-Host "" ; Write-Host "== $msg" -ForegroundColor $color }
function Ok($msg)   { Write-Host "   OK   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   WARN $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`n   FAIL $msg" -ForegroundColor Red; exit 1 }

function Get-EnvValue([string]$path, [string]$name) {
    if (-not (Test-Path $path)) { return "" }
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -match "^\s*$name\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"').Trim("'") }
    }
    return ""
}

function Invoke-DockerCompose([string]$workDir, [string[]]$composeArgs) {
    Push-Location $workDir
    try {
        $out = & docker compose @composeArgs 2>&1
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            # Older installs only ship the hyphenated binary.
            $out = & docker-compose @composeArgs 2>&1
            $code = $LASTEXITCODE
        }
        return @{ Code = $code; Out = ($out | Out-String) }
    } finally { Pop-Location }
}

# ── 0. preflight ────────────────────────────────────────────────────────────
Say "0/8  preflight"
foreach ($p in @($ProjectSrc, $DataSrc)) {
    if (-not (Test-Path $p)) { Die "missing pack directory: $p" }
}
Ok "pack root    $PackRoot"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "docker not on PATH" }
$dc = Invoke-DockerCompose $PackRoot @("version")
if ($dc.Code -ne 0) { Die "docker compose not usable: $($dc.Out)" }
Ok "docker + compose available"

if (-not $LanIp) {
    $cand = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notmatch "^(127|169\.254|0)\." -and $_.PrefixOrigin -ne "WellKnown" } |
            Sort-Object InterfaceMetric |
            Select-Object -First 1 -ExpandProperty IPAddress
    if ($cand) { $LanIp = $cand } else { $LanIp = "127.0.0.1"; Warn "no LAN adapter found, falling back to 127.0.0.1" }
}
Ok "LAN IP       $LanIp"

# ── 1. copy project ─────────────────────────────────────────────────────────
Say "1/8  copy project -> $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
$rc = & robocopy $ProjectSrc $Target /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2
if ($LASTEXITCODE -ge 8) { Die "robocopy failed with code $LASTEXITCODE" }
Ok "project copied"

$envFile = Join-Path $Target ".env"
if (-not (Test-Path $envFile)) { Die ".env did not land in $Target — the pack is broken" }

# ── 2. rewrite .env for this machine ────────────────────────────────────────
Say "2/8  point .env at this machine"
$oldIp = Get-EnvValue $envFile "PLATFORM_LAN_IP"
$text  = [System.IO.File]::ReadAllText($envFile)
$before = $text
$text = $text -replace "(?m)^PLATFORM_LAN_IP=.*$",  "PLATFORM_LAN_IP=$LanIp"
$text = $text -replace "(?m)^LAN_IP=.*$",           "LAN_IP=$LanIp"
# belt and braces: any other occurrence of the source machine's address
if ($oldIp -and $oldIp -ne $LanIp) {
    $text = $text -replace [regex]::Escape($oldIp), $LanIp
}
if ($text -ne $before) {
    [System.IO.File]::WriteAllText($envFile, $text)
    Ok "PLATFORM_LAN_IP / LAN_IP  $oldIp -> $LanIp"
} else {
    Warn ".env had no LAN IP to rewrite"
}
$key = Get-EnvValue $envFile "N8N_ENCRYPTION_KEY"
if (-not $key) { Warn "N8N_ENCRYPTION_KEY is empty — restored credentials will NOT decrypt" }
else           { Ok "N8N_ENCRYPTION_KEY present (credentials stay decryptable)" }

# Telegram is the one channel that is bound to an ACCOUNT, not to a machine.
# TELEGRAM_CHAT_ID is used both as the owner allow-list and as every push
# target, so if the human signs in to Telegram on the new box with a DIFFERENT
# account, the id no longer matches: the bridge silently ignores every message
# ("strangers are ignored") and no alert can be delivered. Nothing errors out.
$tgToken = Get-EnvValue $envFile "TELEGRAM_BOT_TOKEN"
$tgChat = Get-EnvValue $envFile "TELEGRAM_CHAT_ID"
if ($tgToken) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("https://api.telegram.org/bot$tgToken/getMe")
        $req.Proxy = $null; $req.Accept = "*/*"; $req.Timeout = 20000
        $resp = $req.GetResponse()
        $me = ([System.IO.StreamReader]::new($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json
        $resp.Close()
        if ($me.ok) {
            Ok ("telegram bot reachable: @" + $me.result.username)
            if ($tgChat) {
                if ($tgChat -match "^-") { Warn "TELEGRAM_CHAT_ID is negative (a group) — the owner allow-list then matches only group messages" }
                else { Ok "TELEGRAM_CHAT_ID $tgChat is a private-user id" }
            } else { Warn "TELEGRAM_CHAT_ID empty — Telegram is effectively off" }
        } else { Warn "telegram getMe did not return ok (token wrong?)" }
    } catch {
        Warn "telegram not reachable from here (offline ok) — verify by hand later"
    }
} else { Warn "no TELEGRAM_BOT_TOKEN — Telegram channel disabled" }

$pgUser = Get-EnvValue $envFile "POSTGRES_USER"; if (-not $pgUser) { $pgUser = "n8n" }
$pgDb   = Get-EnvValue $envFile "POSTGRES_DB";   if (-not $pgDb)   { $pgDb   = "n8n" }

# ── 3. external resources ───────────────────────────────────────────────────
# compose declares BOTH `n8n-net` (network) and `n8n_data` (volume) as
# external: true, so it creates neither. On a fresh machine `up` aborts with
# "network n8n-net declared as external, but could not be found". Make them.
Say "3/8  create external resources (n8n-net, n8n_data)"
$nets = & docker network ls --format "{{.Name}}"
if ($nets -contains "n8n-net") { Ok "network n8n-net already exists" }
else {
    & docker network create n8n-net | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "docker network create n8n-net failed" }
    Ok "created network n8n-net"
}
$existing = & docker volume ls --format "{{.Name}}"
if ($existing -contains "n8n_data") { Ok "volume n8n_data already exists" }
else {
    & docker volume create n8n_data | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "docker volume create n8n_data failed" }
    Ok "created volume n8n_data"
}

# ── 4. postgres only ────────────────────────────────────────────────────────
Say "4/8  start postgres and wait for healthy"
$r = Invoke-DockerCompose $Target @("up", "-d", "postgres")
if ($r.Code -ne 0) { Die "compose up postgres failed:`n$($r.Out)" }
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline) {
    $st = & docker inspect -f "{{.State.Health.Status}}" postgres 2>$null
    if ($st -eq "healthy") { break }
    Start-Sleep -Seconds 3
}
$st = & docker inspect -f "{{.State.Health.Status}}" postgres 2>$null
if ($st -ne "healthy") { Die "postgres never went healthy (status=$st)" }
Ok "postgres healthy"

# The healthcheck is just pg_isready, and the server starts accepting
# connections BEFORE paradedb's 10_bootstrap_paradedb.sh has finished. Loading
# a dump on top of a half-bootstrapped cluster makes the bootstrap fail, the
# entrypoint exit, and the server shut down mid-restore. Give it room.
Write-Host "   letting paradedb bootstrap finish ..."
Start-Sleep -Seconds 30
$st2 = & docker inspect -f "{{.State.Status}}" postgres 2>$null
if ($st2 -ne "running") { Die "postgres stopped during bootstrap - run: docker logs postgres" }
Ok "bootstrap settled (container still running)"

# ── 5. volume payloads ──────────────────────────────────────────────────────
Say "5/8  restore volume snapshots (before n8n/minio start)"
& docker pull alpine 2>&1 | Out-Null
$volMap = @(
    @{ Vol = "n8n_data";   Glob = "n8n-data-*.tar.gz" },
    @{ Vol = "minio_data"; Glob = "minio-data-*.tar.gz" }
)
foreach ($m in $volMap) {
    $file = Get-ChildItem -Path $DataSrc -Filter $m.Glob | Sort-Object Name | Select-Object -Last 1
    if (-not $file) { Warn "no archive for $($m.Vol) — skipped"; continue }
    & docker volume create $m.Vol | Out-Null
    $mount = "{0}:/src:ro" -f ($DataSrc -replace "\\", "/")
    & docker run --rm -v ("{0}:/vol" -f $m.Vol) -v $mount alpine sh -c ("tar xzf /src/{0} -C /vol" -f $file.Name)
    if ($LASTEXITCODE -ne 0) { Die "failed to restore $($m.Vol) from $($file.Name)" }
    Ok "$($m.Vol) <- $($file.Name)"
}

# ── 6. databases ────────────────────────────────────────────────────────────
Say "6/8  load SQL dumps"
# TEMPLATE template0 matters: paradedb's bootstrap injects a `paradedb` schema
# into template1, so a default CREATE DATABASE inherits it and the dump's own
# CREATE SCHEMA paradedb aborts with "already exists". template0 is pristine.
$has = & docker exec postgres psql -U $pgUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='lobechat'"
if (-not $has) {
    & docker exec postgres psql -U $pgUser -d postgres -c "CREATE DATABASE lobechat TEMPLATE template0"
    if ($LASTEXITCODE -ne 0) { Die "could not create database lobechat" }
    Ok "created database lobechat (TEMPLATE template0)"
} else { Ok "database lobechat present" }

$dbMap = @(
    @{ Db = $pgDb;      Glob = "pg-n8n-*.sql.gz" },
    @{ Db = "lobechat"; Glob = "pg-lobechat-*.sql.gz" }
)
foreach ($m in $dbMap) {
    $file = Get-ChildItem -Path $DataSrc -Filter $m.Glob | Sort-Object Name | Select-Object -Last 1
    if (-not $file) { Warn "no dump for db $($m.Db) — skipped"; continue }
    Write-Host ("   loading {0} -> {1}  (this is the slow part)" -f $file.Name, $m.Db)
    $psql = "gunzip -c | psql -U $pgUser -d $($m.Db) -v ON_ERROR_STOP=1 -q"
    cmd /c "docker exec -i postgres sh -c ""$psql"" < ""$($file.FullName)"""
    if ($LASTEXITCODE -ne 0) { Die "failed to load $($file.Name) into $($m.Db)" }
    Ok "$($m.Db) <- $($file.Name)"
}

# ── 7. full stack ───────────────────────────────────────────────────────────
Say "7/8  build and start the whole stack"
$r = Invoke-DockerCompose $Target @("up", "-d", "--build")
if ($r.Code -ne 0) { Die "compose up failed:`n$($r.Out)" }
Ok "stack up (console image build takes several minutes on first run)"

# ── 8. hand off ─────────────────────────────────────────────────────────────
Say "8/8  done"
Write-Host @"

    Next:
      1. wait for build:   docker compose -f $Target\docker-compose.yml ps
      2. accept:           powershell -File $Target\migration\verify.ps1
      3. URLs (use the LAN IP in the certificate, not 127.0.0.1):
           console   http://${LanIp}:3000
           lobechat  http://${LanIp}:3210
           n8n       http://${LanIp}:5678
           https     https://${LanIp}:8443 .. 8446
"@ -ForegroundColor White
