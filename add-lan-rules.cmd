@echo off
rem agent-platform: add LAN inbound rules for phone access (run as Administrator)
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [Admin required] Right-click this file -^> "Run as administrator"
  pause
  exit /b 1
)
powershell -NoProfile -Command "New-NetFirewallRule -DisplayName 'agent-platform LAN: LobeHub 3210' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3210 -RemoteAddress LocalSubnet; New-NetFirewallRule -DisplayName 'agent-platform LAN: Console 3000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet; New-NetFirewallRule -DisplayName 'agent-platform LAN: MinIO 9000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9000 -RemoteAddress LocalSubnet; Write-Host 'Rules added.'"
pause
