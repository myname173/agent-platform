@echo off
rem agent-platform: add LAN inbound rules for phone access (run as Administrator)
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [Admin required] Right-click this file -^> "Run as administrator"
  pause
  exit /b 1
)
rem HTTPS 入口（Caddy 反向代理）：8443 控制台 / 8444 LobeHub / 8445 n8n / 8446 MinIO
powershell -NoProfile -Command "New-NetFirewallRule -DisplayName 'agent-platform LAN: LobeHub 3210' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3210 -RemoteAddress LocalSubnet; New-NetFirewallRule -DisplayName 'agent-platform LAN: Console 3000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet; New-NetFirewallRule -DisplayName 'agent-platform LAN: MinIO 9000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9000 -RemoteAddress LocalSubnet; New-NetFirewallRule -DisplayName 'agent-platform LAN HTTPS: Console 8443' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -RemoteAddress LocalSubnet; New-NetFirewallRule -DisplayName 'agent-platform LAN HTTPS: LobeHub 8444' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8444 -RemoteAddress LocalSubnet; New-NetFirewallRule -DisplayName 'agent-platform LAN HTTPS: n8n 8445' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8445 -RemoteAddress LocalSubnet; New-NetFirewallRule -DisplayName 'agent-platform LAN HTTPS: MinIO 8446' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8446 -RemoteAddress LocalSubnet; Write-Host 'Rules added.'"
pause
