param(
  [ValidateSet('run', 'install', 'uninstall', 'check')]
  [string]$Action = 'check'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$DockerBin = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin'
$Kubectl = Join-Path $DockerBin 'kubectl.exe'
$Script = Join-Path $PSScriptRoot 'sandbox-bridge.ps1'
$TaskName = 'AgentPlatform-SandboxBridge'
$LogFile = Join-Path $env:TEMP 'agent-platform-sandbox-bridge.log'
$ErrorLog = Join-Path $env:TEMP 'agent-platform-sandbox-bridge.err.log'
$HealthUrl = 'http://127.0.0.1:18080/healthz'

if (-not (Test-Path $Kubectl)) { throw "kubectl not found: $Kubectl" }

function Current-Context {
  (& $Kubectl config current-context 2>$null).Trim()
}

function Test-Bridge {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $HealthUrl -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Start-Forward {
  $arguments = @(
    '-n', 'agent-platform', 'port-forward',
    'service/platform-sandbox-gateway',
    '--address', '127.0.0.1', '18080:8080'
  )
  Start-Process -FilePath $Kubectl -ArgumentList $arguments -NoNewWindow `
    -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLog -PassThru
}

function Run-Bridge {
  while ($true) {
    if ((Current-Context) -ne 'docker-desktop') {
      Start-Sleep -Seconds 5
      continue
    }

    $forward = Start-Forward
    try {
      while (-not $forward.HasExited) {
        Start-Sleep -Seconds 3
      }
    } finally {
      if (-not $forward.HasExited) { Stop-Process -Id $forward.Id -Force }
    }
    Start-Sleep -Seconds 3
  }
}

switch ($Action) {
  'run' { Run-Bridge }
  'check' {
    if (-not (Test-Bridge)) { throw "Sandbox bridge is not healthy at $HealthUrl" }
    Write-Output "sandbox bridge -> $HealthUrl -> 200"
  }
  'install' {
    $powershell = (Get-Command powershell.exe).Source
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Action run"
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "installed and started scheduled task: $TaskName"
  }
  'uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "removed scheduled task: $TaskName"
  }
}
