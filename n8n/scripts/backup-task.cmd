@echo off
cd /d "%~dp0..\.."
echo [%date% %time%] task invoked >> "backups\backup-task.log"

rem ---------------------------------------------------------------------------
rem Docker Desktop 4.x installs per-user (%LOCALAPPDATA%\Programs\DockerDesktop)
rem and is NOT on the machine PATH. A scheduled task inherits the system PATH, so
rem this script got "docker: command not found" and every 03:30 run failed while
rem the in-stack backup loop kept succeeding - which is why the self-check said
rem "last backup reported failure" for days. Resolve it explicitly, same rule as
rem custom-theme\apply-theme-v2.ps1's Resolve-Docker.
rem NOTE: no parenthesised blocks here on purpose - %ProgramFiles(x86)% contains
rem a ")" and silently truncates an if(...) block in cmd.exe.
rem ---------------------------------------------------------------------------
set "DOCKER_BIN=%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin"
if not exist "%DOCKER_BIN%\docker.exe" set "DOCKER_BIN=%ProgramFiles%\Docker\Docker\resources\bin"
if not exist "%DOCKER_BIN%\docker.exe" set "DOCKER_BIN="

if defined DOCKER_BIN echo [%date% %time%] docker resolved: %DOCKER_BIN%>> "backups\backup-task.log"
if not defined DOCKER_BIN echo [%date% %time%] WARNING: docker.exe not found in any known location>> "backups\backup-task.log"
if defined DOCKER_BIN set "PATH=%DOCKER_BIN%;%PATH%"

"C:\Program Files\Git\bin\bash.exe" -lc "bash ./n8n/scripts/backup-task.sh"
