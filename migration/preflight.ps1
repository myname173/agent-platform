#Requires -Version 5.1
<#
.SYNOPSIS
    Check that THIS machine can actually run the stack, before anything is
    copied or started.

.DESCRIPTION
    Run it right after unzipping the pack. It answers the questions that
    otherwise only surface 20 minutes into a failed restore:

      - is the Docker daemon reachable (Desktop not just installed, running)?
      - is `docker compose` v2 available?
      - is there enough disk, and is there enough RAM?
      - are the host ports free? (a port held by Docker itself is NOT a
        conflict — that is our own stack, which happens on a re-run)
      - is a system proxy on, and does it bypass localhost?
      - is a TUN-mode proxy (Clash/mihomo) active? If it is, it must be up
        BEFORE docker starts, otherwise containers cache pre-TUN DNS.

    Nothing here writes anything except .env, and only with -FixPorts.

.EXAMPLE
    .\preflight.ps1
    .\preflight.ps1 -FixPorts         # rewrite .env to move off busy ports
#>
[CmdletBinding()]
param(
    [string]$ProjectDir = "",
    [switch]$FixPorts
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
[System.Net.WebRequest]::DefaultWebProxy = $null

if (-not $ProjectDir) {
    # Works both inside the pack (migration/ next to project/) and after a
    # restore (migration/ inside the project dir).
    $here = Split-Path -Parent $PSScriptRoot
    $ProjectDir = if (Test-Path (Join-Path $here "project")) { Join-Path $here "project" } else { $here }
}
$envFile = Join-Path $ProjectDir ".env"

$pass = 0; $warn = 0; $fail = 0
function Ok($m)   { Write-Host ("   OK    {0}" -f $m) -ForegroundColor Green;  $script:pass++ }
function Warn($m) { Write-Host ("   WARN  {0}" -f $m) -ForegroundColor Yellow; $script:warn++ }
function Bad($m)  { Write-Host ("   FAIL  {0}" -f $m) -ForegroundColor Red;    $script:fail++ }
function Head($m) { Write-Host "`n--- $m" -ForegroundColor Cyan }

function Get-EnvValue([string]$path, [string]$name, [string]$default = "") {
    if (-not (Test-Path $path)) { return $default }
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -match "^\s*$name\s*=\s*(.*)$") {
            $v = $Matches[1].Trim().Trim('"').Trim("'")
            if ($v) { return $v }
        }
    }
    return $default
}

# Host ports, in the order they matter. `key` is the .env variable.
$PORTS = @(
    @{ Key = "CONSOLE_PORT";        Def = 3000; What = "Kiranism console" },
    @{ Key = "LOBECHAT_PORT";       Def = 3210; What = "LobeHub chat" },
    @{ Key = "N8N_PORT";            Def = 5678; What = "n8n" },
    @{ Key = "SEARXNG_PORT";        Def = 8080; What = "SearXNG" },
    @{ Key = "MINIO_API_PORT";      Def = 9000; What = "MinIO S3 API" },
    @{ Key = "MINIO_CONSOLE_PORT";  Def = 9001; What = "MinIO console" },
    @{ Key = "STREAM_BRIDGE_PORT";  Def = 3211; What = "stream-bridge (127.0.0.1 only)" },
    @{ Key = "CADDY_PORT_CONSOLE";  Def = 8443; What = "HTTPS console" },
    @{ Key = "CADDY_PORT_LOBEHUB";  Def = 8444; What = "HTTPS LobeHub" },
    @{ Key = "CADDY_PORT_N8N";      Def = 8445; What = "HTTPS n8n" },
    @{ Key = "CADDY_PORT_MINIO";    Def = 8446; What = "HTTPS MinIO" }
)

# Is our own stack already up? If it is, the ports are held by our containers
# and a re-run must NOT remap them — that would silently move the whole stack
# to different ports for no reason.
$OURS = @("postgres","n8n","platform-console","lobechat","minio","searxng",
          "n8n-sandbox","stream-bridge","platform-backup","caddy")
$script:StackRunning = $false
function Test-StackRunning {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    $names = & docker ps --format "{{.Names}}" 2>$null
    if (-not $names) { return $false }
    foreach ($n in $names) { if ($OURS -contains $n.Trim()) { return $true } }
    return $false
}

function Test-PortFree([int]$port) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { return $true }
    if ($script:StackRunning) { return $true }   # held by our own containers
    foreach ($c in $conns) {
        $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        $nm = if ($proc) { $proc.ProcessName } else { "" }
        # Docker Desktop holds published ports in com.docker.backend.
        if ($nm -notmatch "com\.docker\.backend|docker-proxy|dockerd|vmmem") {
            return $false
        }
    }
    return $true
}

function Find-FreePort([int]$start) {
    $p = $start
    for ($i = 0; $i -lt 200; $i++) {
        if ((Test-PortFree $p) -and $p -lt 60000) { return $p }
        $p++
    }
    return 0
}

# ── docker ──────────────────────────────────────────────────────────────────
Head "docker"
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) { Bad "docker not on PATH — install Docker Desktop first" }
else {
    $info = & docker info 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $info -match "Cannot connect to the docker daemon") {
        Bad "docker is installed but the daemon is not running — start Docker Desktop and wait for the whale to stop animating"
    } else {
        Ok "docker daemon reachable"
        $ver = (& docker version --format "{{.Server.Version}}" 2>$null)
        if ($ver) { Ok "server version $ver" }
    }
    $cv = & docker compose version 2>&1 | Out-String
    if ($cv -match "v2|version") { Ok "docker compose available ($($cv.Trim()))" }
    else { Bad "docker compose v2 not available — update Docker Desktop" }
}

# ── resources ───────────────────────────────────────────────────────────────
Head "resources"
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $ramGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $freeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    if ($ramGb -ge 8) { Ok "RAM ${ramGb} GB (free ${freeGb} GB)" }
    else { Warn "RAM only ${ramGb} GB — 10 containers plus a Next.js build wants 8 GB or more" }
} catch { Warn "could not read RAM" }

if (Test-Path $envFile) {
    $drive = (Resolve-Path $ProjectDir).Path.Substring(0, 2)
    try {
        $d = Get-PSDrive -Name $drive.TrimEnd(':') -ErrorAction Stop
        $free = [math]::Round(($d.Free / 1GB), 1)
        if ($free -ge 15) { Ok "disk ${drive} free ${free} GB" }
        elseif ($free -ge 6) { Warn "disk ${drive} only ${free} GB free — dumps plus volumes plus a build want ~6 GB minimum" }
        else { Bad "disk ${drive} has only ${free} GB free — not enough" }
    } catch { Warn "could not read disk space on ${drive}" }
} else {
    Warn ".env not found at $envFile — run this from inside the pack"
}

# ── ports ───────────────────────────────────────────────────────────────────
Head "host ports"
$script:StackRunning = Test-StackRunning
if ($script:StackRunning) {
    Write-Host "   (the stack is already running — its own ports are not treated as conflicts)" -ForegroundColor White
}
$busy = @()
foreach ($p in $PORTS) {
    $want = [int](Get-EnvValue $envFile $p.Key "$($p.Def)")
    $free = Test-PortFree $want
    if ($free) { Ok ("{0,-28} {1}" -f $p.What, $want) }
    else {
        $alt = Find-FreePort ($want + 1)
        $busy += @{ P = $p; Want = $want; Alt = $alt }
        if ($alt) { Warn ("{0,-28} {1} BUSY -> would move to {2}" -f $p.What, $want, $alt) }
        else      { Bad  ("{0,-28} {1} BUSY and no free port found" -f $p.What, $want) }
    }
}

if ($busy.Count -gt 0 -and $FixPorts -and (Test-Path $envFile)) {
    Head "rewriting .env to avoid port conflicts"
    $text = [System.IO.File]::ReadAllText($envFile)
    foreach ($b in $busy) {
        if (-not $b.Alt) { continue }
        $text = $text -replace ("(?m)^{0}=.*$" -f $b.P.Key), ("{0}={1}" -f $b.P.Key, $b.Alt)
        if ($text -notmatch ("(?m)^{0}=" -f $b.P.Key)) { $text += "`n{0}={1}`n" -f $b.P.Key, $b.Alt }
        Ok ("{0}  {1} -> {2}" -f $b.P.Key, $b.Want, $b.Alt)
    }
    [System.IO.File]::WriteAllText($envFile, $text)
    Write-Host "   .env updated — the stack will come up on the ports listed above" -ForegroundColor White
} elseif ($busy.Count -gt 0) {
    Write-Host "   re-run with -FixPorts to move these automatically" -ForegroundColor White
}

# ── system proxy ────────────────────────────────────────────────────────────
Head "system proxy"
$reg = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
$proxyOn = $false; $proxyServer = ""; $bypass = ""
try {
    $proxyOn = ((Get-ItemProperty -Path $reg -Name ProxyEnable -ErrorAction Stop).ProxyEnable -eq 1)
    $proxyServer = (Get-ItemProperty -Path $reg -Name ProxyServer -ErrorAction Stop).ProxyServer
    $bypass = (Get-ItemProperty -Path $reg -Name ProxyOverride -ErrorAction Stop).ProxyOverride
} catch { Warn "could not read proxy settings" }

if (-not $proxyOn) {
    Ok "system proxy is off — nothing to bypass"
} else {
    Ok "system proxy on: $proxyServer"
    # A browser honours ProxyOverride; .NET's HttpWebRequest does not, which is
    # why verify.ps1 sets Proxy = $null explicitly. Both paths must work.
    if ($bypass -match "localhost|<local>|127\.") {
        Ok "bypass list covers localhost (browser access to local services is fine)"
    } else {
        Warn "bypass list does NOT contain localhost — your browser will send :3000/:8443 through $proxyServer and get nothing back. Add localhost;127.* to the Clash/system bypass list."
    }
}

# ── TUN / transparent proxy ─────────────────────────────────────────────────
# mihomo's TUN mode answers DNS with a Fake-IP out of 198.18.0.0/15. Seeing one
# means TUN is up and container egress is being handled. Seeing a real IP is
# fine too as long as the host can reach the internet directly — the check only
# distinguishes the two so the message below is accurate.
Head "outbound path (affects SearXNG and Telegram)"
$tun = $false
try {
    $r = [System.Net.Dns]::GetHostAddresses("api.telegram.org")
    $ips = @($r | ForEach-Object { $_.IPAddressToString })
    $fake = @($ips | Where-Object { $_ -like "198.18.*" })
    if ($fake.Count -gt 0) {
        $tun = $true
        Ok "TUN-mode proxy is ACTIVE (api.telegram.org resolved to Fake-IP $($fake[0]))"
        Write-Host "         -> SearXNG and Telegram egress go through it. KEEP TUN ON." -ForegroundColor White
        Write-Host "         -> Start Clash BEFORE Docker Desktop, else containers cache pre-TUN DNS." -ForegroundColor White
    } else {
        Ok "no Fake-IP — direct DNS ($($ips -join ', '))"
        Write-Host "         -> If SearXNG/Telegram later fail, this machine has no working" -ForegroundColor White
        Write-Host "            outbound path for them; a TUN/transparent proxy is what usually supplies it." -ForegroundColor White
    }
} catch {
    Warn "could not resolve api.telegram.org — outbound DNS may be blocked"
}

if ($proxyOn -and -not $tun) {
    Write-Host "         -> System proxy is on but TUN is not detected: only apps that" -ForegroundColor White
    Write-Host "            read the proxy setting get out. Containers will NOT." -ForegroundColor White
    Write-Host "            Expect SearXNG to return 0 results; turn on TUN mode." -ForegroundColor White
    $warn++
}

# ── summary ─────────────────────────────────────────────────────────────────
Write-Host ""
if ($fail -eq 0 -and $warn -eq 0) {
    Write-Host "PREFLIGHT CLEAN — $pass checks ok, nothing blocking." -ForegroundColor Green
} else {
    Write-Host "PREFLIGHT: $pass ok, $warn warning(s), $fail blocking." -ForegroundColor $(if ($fail -gt 0) { "Red" } else { "Yellow" })
}
Write-Host ""
exit $(if ($fail -eq 0) { 0 } else { 1 })
