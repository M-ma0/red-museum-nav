@echo off
rem  Double-click launcher for publish.ps1 (ASCII only on purpose:
rem  cmd.exe mis-parses UTF-8 batch files, so all Chinese text lives in the .ps1)
setlocal
set "PS=pwsh"
where pwsh >nul 2>&1 || set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
echo.
pause
