@echo off
setlocal
if "%~1"=="" (
  echo Usage: %~nx0 "C:\path\to\EveJS-v0.12.3"
  exit /b 2
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-XEvePatch.ps1" -EveJSPath "%~1"
exit /b %errorlevel%
