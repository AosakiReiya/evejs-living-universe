@echo off
setlocal
if "%~1"=="" (
  echo Usage: %~nx0 "C:\path\to\EveJS-v0.12.3" [--run-tests]
  exit /b 2
)
if /I "%~2"=="--run-tests" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Verify-XEvePatch.ps1" -EveJSPath "%~1" -RunTests
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Verify-XEvePatch.ps1" -EveJSPath "%~1"
)
exit /b %errorlevel%
