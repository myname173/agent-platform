@echo off
cd /d "%~dp0..\.."
echo [%date% %time%] task invoked >> "backups\backup-task.log"
"C:\Program Files\Git\bin\bash.exe" -lc "bash ./n8n/scripts/backup-task.sh"
