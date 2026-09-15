@echo off
rem PivotAI theme keeper wrapper (keeps the scheduled-task command line trivial)
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0theme-keeper.ps1"
