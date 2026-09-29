#Requires -Version 5.1
<#
.SYNOPSIS
    Acceptance check for a restored agent-platform.

    Compares what is actually running against SOURCE.json, which was written
    on the machine the pack came from. Run it after restore.ps1, and again
    after the first build finishes (the console image takes minutes).

.EXAMPLE
    .\verify.ps1
#>
[CmdletBinding()]
param([string]$ProjectDir = "")

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"   # else Invoke-WebRequest floods the output
# Kill the inherited machine proxy (VPN / PAC) so localhost probes actually
# hit localhost — otherwise every local endpoint answers 404.
[System.Net.WebRequest]::DefaultWebProxy = $null
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent $PSScriptRoot }
$src = Join-Path $PSScriptRoot "SOURCE.json"
if (-not (Test-Path $src)) { Write-Host "SOURCE.json not found next to this script" -ForegroundColor Red; exit 1 }
# ReadAllText + explicit parse: Get-Content -Raw can come back empty depending
# on how the script is invoked, and a silent $null here turns every comparison
# below into a false FAIL.
$S = [System.IO.File]::ReadAllText($src) | ConvertFrom-Json
if ($null -eq $S -or $null -eq $S.counts -or $null -eq $S.counts.workflows) {
    Write-Host "SOURCE.json did not parse: $src" -ForegroundColor Red; exit 1
}

$pass = 0; $fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Host ("   PASS  {0,-34} {1}" -f $name, $detail) -ForegroundColor Green;  $script:pass++ }
    else     { Write-Host ("   FAIL  {0,-34} {1}" -f $name, $detail) -ForegroundColor Red;    $script:fail++ }
}

function Get-EnvValue([string]$path, [string]$name) {
    if (-not (Test-Path $path)) { return "" }
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -match "^\s*$name\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"').Trim("'") }
    }
    return ""
}
$envFile = Join-Path $ProjectDir ".env"
$pgUser  = Get-EnvValue $envFile "POSTGRES_USER"; if (-not $pgUser) { $pgUser = "n8n" }
$pgDb    = Get-EnvValue $envFile "POSTGRES_DB";   if (-not $pgDb)   { $pgDb   = "n8n" }
$n8nKey  = Get-EnvValue $envFile "N8N_API_KEY"
$lanIp   = Get-EnvValue $envFile "PLATFORM_LAN_IP"

Write-Host "`n=== containers ===" -ForegroundColor Cyan
# Inspect the container_name values from compose directly. Do NOT mix them up
# with service names: service `console` is container `platform-console`, and
# service `backup` is container `platform-backup`.
$containers = @("postgres","n8n","platform-console","lobechat","minio",
                "searxng","n8n-sandbox","stream-bridge","platform-backup","caddy")
foreach ($c in $containers) {
    $state = & docker inspect -f "{{.State.Status}}" $c 2>$null
    if (-not $state) { $state = "absent" }
    Check "container $c" ($state -eq "running") $state
}

Write-Host "`n=== environment ===" -ForegroundColor Cyan
$key = Get-EnvValue $envFile "N8N_ENCRYPTION_KEY"
Check "N8N_ENCRYPTION_KEY matches source" ($key -eq $S.n8n_encryption_key) $(if ($key -eq $S.n8n_encryption_key) { "identical" } else { "DIFFERENT - credentials will not decrypt" })
Check "PLATFORM_LAN_IP set on this host"  ($lanIp -and $lanIp -ne "127.0.0.1") $lanIp
if ($lanIp -and $lanIp -ne "127.0.0.1") {
    $self = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress
    Check "LAN IP belongs to this machine" ($self -contains $lanIp) $lanIp
}

Write-Host "`n=== postgres ===" -ForegroundColor Cyan
function PsqlCount($sql) {
    $out = & docker exec postgres psql -U $pgUser -d $pgDb -tAc $sql 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($out | Out-String).Trim()
}
$wf = PsqlCount "select count(*) from workflow_entity"
Check "workflows = $($S.counts.workflows)" ($wf -eq "$($S.counts.workflows)") "got $wf"
$ex = PsqlCount "select count(*) from execution_entity"
Check "executions >= $($S.counts.executions)" ([int]$ex -ge [int]$S.counts.executions) "got $ex"
$cr = PsqlCount "select count(*) from credentials_entity"
Check "credentials = $($S.counts.credentials)" ($cr -eq "$($S.counts.credentials)") "got $cr"
$dt = PsqlCount "select count(*) from data_table"
Check "n8n data tables = $($S.counts.data_tables)" ($dt -eq "$($S.counts.data_tables)") "got $dt"

Write-Host "`n=== business data tables ===" -ForegroundColor Cyan
# One round trip: n8n data tables live in physical tables named
# data_table_user_<id>, so resolve the id from the data_table catalogue.
$allSql = @"
select d.name || '|' || (xpath('/row/c/text()',
        query_to_xml(format('select count(*) as c from %I', 'data_table_user_' || d.id),
                     false, true, '')))[1]::text::bigint
from data_table d order by d.name
"@
$rows = & docker exec postgres psql -U $pgUser -d $pgDb -tAc $allSql 2>$null
$got = @{}
foreach ($line in ($rows | Out-String).Split("`n")) {
    $t = $line.Trim()
    if ($t -and $t.Contains("|")) {
        $parts = $t.Split("|")
        if ($parts.Count -ge 2) { $got[$parts[0]] = $parts[1] }
    }
}
foreach ($p in $S.data_tables.PSObject.Properties) {
    $name = $p.Name; $want = [int]$p.Value
    $actual = if ($got.ContainsKey($name)) { [int]$got[$name] } else { -1 }
    Check "table $name >= $want" ($actual -ge $want) "got $actual"
}

Write-Host "`n=== HTTP endpoints ===" -ForegroundColor Cyan
function HttpOk($url, $expect) {
    # HttpWebRequest with an explicit null proxy. Invoke-WebRequest inherits the
    # machine proxy (OpenVPN, corporate PAC), which sends even localhost through
    # it and returns 404 for perfectly healthy local services.
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Proxy = $null
    $req.AllowAutoRedirect = $false
    $req.Timeout = 15000
    # n8n 2.x content-negotiates and answers 404 to a request with NO Accept
    # header. curl always sends `Accept: */*`, which is why it looks healthy
    # from a shell but 404s from .NET. Set it explicitly.
    $req.Accept = "*/*"
    try {
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return @{ Code = $code; Ok = ($expect -contains $code) }
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            return @{ Code = $code; Ok = ($expect -contains $code) }
        }
        return @{ Code = 0; Ok = $false }
    } catch {
        return @{ Code = 0; Ok = $false }
    }
}
$eps = @(
    # A redirect is a healthy answer here — all three UIs bounce to a sign-in
    # page (307/302) when the probe has no session cookie.
    @{ Name = "console   :3000";  Url = "http://localhost:3000/";                 Expect = @(200,302,307) },
    @{ Name = "lobechat  :3210";  Url = "http://localhost:3210/";                 Expect = @(200,302,307) },
    @{ Name = "n8n       :5678";  Url = "http://localhost:5678/signin";           Expect = @(200) },
    @{ Name = "n8n healthz";      Url = "http://localhost:5678/healthz";          Expect = @(200) },
    @{ Name = "minio     :9001";  Url = "http://localhost:9001/";                 Expect = @(200,302,307) },
    @{ Name = "searxng   :8080";  Url = "http://localhost:8080/";                 Expect = @(200) }
)
foreach ($e in $eps) {
    $r = HttpOk $e.Url $e.Expect
    Check $e.Name ($r.Ok -or ($e.Expect -contains $r.Code)) ("HTTP " + $r.Code)
}

Write-Host "`n=== telegram channel ===" -ForegroundColor Cyan
# The only channel tied to an ACCOUNT rather than a machine. getMe proves the
# bot token works; getChat proves the owner's chat id is still valid. When the
# human signs in on the new box with a different Telegram account, getChat
# returns "chat not found" and everything Telegram silently goes dead.
$tgToken = Get-EnvValue $envFile "TELEGRAM_BOT_TOKEN"
$tgChat  = Get-EnvValue $envFile "TELEGRAM_CHAT_ID"
function TgApi($method, $token) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("https://api.telegram.org/bot$token/$method")
        $req.Proxy = $null; $req.Accept = "*/*"; $req.Timeout = 20000
        $resp = $req.GetResponse()
        $body = ([System.IO.StreamReader]::new($resp.GetResponseStream())).ReadToEnd()
        $resp.Close()
        return ($body | ConvertFrom-Json)
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $body = ([System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())).ReadToEnd()
            return ($body | ConvertFrom-Json)
        }
        return $null
    } catch { return $null }
}
if ($tgToken -and $tgChat) {
    $me = TgApi "getMe" $tgToken
    Check "telegram bot token valid" ($me -and $me.ok) ("@" + $(if ($me -and $me.result) { $me.result.username } else { "?" }))
    $chat = TgApi "getChat?chat_id=$tgChat" $tgToken
    if ($chat -and $chat.ok) {
        $t = $chat.result.type
        $nm = if ($chat.result.username) { "@" + $chat.result.username } else { $chat.result.first_name }
        Check "telegram owner chat reachable" $true "$t $nm"
        Check "TELEGRAM_CHAT_ID is a private chat" ($t -eq "private") $t
    } else {
        $why = if ($chat) { $chat.description } else { "no response" }
        Check "telegram owner chat reachable" $false ($why + " -- sign in to Telegram with the SAME account, or update TELEGRAM_CHAT_ID")
    }
} else {
    Write-Host "   (no TELEGRAM_* in .env, Telegram channel disabled)" -ForegroundColor Yellow
}

Write-Host "`n=== n8n API ===" -ForegroundColor Cyan
if ($n8nKey) {
    try {
        $r = Invoke-RestMethod -Uri "http://localhost:5678/api/v1/workflows?limit=250" -Headers @{ "X-N8N-API-KEY" = $n8nKey } -TimeoutSec 30
        $n = @($r.data).Count
        Check "n8n API workflows = $($S.counts.workflows)" ($n -eq [int]$S.counts.workflows) "got $n"
    } catch { Check "n8n API reachable" $false $_.Exception.Message }
} else { Write-Host "   (no N8N_API_KEY in .env, skipped)" -ForegroundColor Yellow }

Write-Host ""
if ($fail -eq 0) { Write-Host "ALL $pass CHECKS PASSED" -ForegroundColor Green }
else             { Write-Host "$pass passed, $fail FAILED" -ForegroundColor Red }
Write-Host ""
exit $(if ($fail -eq 0) { 0 } else { 1 })
