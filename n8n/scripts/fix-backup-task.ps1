# =============================================================================
# fix-backup-task.ps1 — one-time repair for the "Agent Platform Backup" task
#
# What is wrong: the task is enabled and has a daily 03:30 trigger, but
#   StartWhenAvailable = false  -> a missed start is skipped, never caught up
#   DisallowStartIfOnBatteries = true -> skipped on battery as well
# On a machine that is switched off overnight this means the backup never
# runs. It went unnoticed for 65 hours because the heartbeat was a bare
# "I ran, trust me" ping — that part is fixed in backup-task.sh; this script
# fixes the schedule itself.
#
# Run from a normal PowerShell window (the task is owned by your account, so
# elevation is usually not required). If it complains about access, open
# PowerShell as Administrator and run it again.
# =============================================================================
$ErrorActionPreference = 'Stop'
$name = 'Agent Platform Backup'

$task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
$s = $task.Settings
$s.StartWhenAvailable = $true
$s.DisallowStartIfOnBatteries = $false
# Do not let a backup run for ever if it somehow hangs.
if ($s.ExecutionTimeLimit -eq 'PT72H') { $s.ExecutionTimeLimit = 'PT2H' }

Set-ScheduledTask -TaskName $name -Settings $s -ErrorAction Stop | Out-Null

$v = (Get-ScheduledTask -TaskName $name).Settings
Write-Host ''
Write-Host "  task              : $name" -ForegroundColor Cyan
Write-Host "  StartWhenAvailable: $($v.StartWhenAvailable)      (was false)"
Write-Host "  OnBatteries       : $($v.DisallowStartIfOnBatteries)       (was true)"
Write-Host "  TimeLimit         : $($v.ExecutionTimeLimit)"

if ($v.StartWhenAvailable -and -not $v.DisallowStartIfOnBatteries) {
  Write-Host ''
  Write-Host '  OK — a missed 03:30 run will now start as soon as the machine is back.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host '  The values did not stick. Run this as Administrator.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  Verify: read the newest line of backups\backup-task.log tomorrow, or run'
Write-Host '          the self-check (it now demands artifact evidence, not a bare ping).'
Write-Host ''
Read-Host 'Press Enter to close'
