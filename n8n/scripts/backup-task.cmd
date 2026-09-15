@echo off
cd /d "%~dp0..\.."
"C:\Program Files\Git\bin\bash.exe" -lc "bash ./n8n/scripts/backup-task.sh"
