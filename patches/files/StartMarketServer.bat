@echo off
setlocal EnableDelayedExpansion
title EvEJS - Start Market Server

for %%I in ("%~dp0.") do set "EVEJS_REPO_ROOT=%%~fI"
set "MARKET_SERVER_DIR=%EVEJS_REPO_ROOT%\externalservices\market-server"
set "MARKET_COMMON_DIR=%MARKET_SERVER_DIR%\crates\market-common"
set "MARKET_SERVER_CONFIG=%MARKET_SERVER_DIR%\config\market-server.local.toml"
set "MARKET_SERVER_PS=%MARKET_SERVER_DIR%\StartMarketServer.ps1"
set "MARKET_SEED_LAUNCHER=%EVEJS_REPO_ROOT%\BuildMarketSeed.bat"
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "VSWHERE_EXE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VS_INSTALL_PATH="
set "VCVARS64_BAT="
set "EVEJS_STDARG_HEADER="
set "EVEJS_NONINTERACTIVE=0"
if not "%~1"=="" set "EVEJS_NONINTERACTIVE=1"

if not exist "%MARKET_SERVER_DIR%\Cargo.toml" (
  echo.
  echo   [!] Market server project not found at:
  echo       %MARKET_SERVER_DIR%
  pause
  exit /b 1
)

call :RequireMarketCommon
if errorlevel 1 exit /b 1

call :ResolveCargo
if errorlevel 1 exit /b 1
call :InitializeMsvcBuildEnvironment
if errorlevel 1 exit /b 1

if /i "%~1"=="serve-release" goto StartRelease
if /i "%~1"=="serve-debug" goto StartDebug
if /i "%~1"=="doctor" goto Doctor
if /i "%~1"=="build-release" goto BuildRelease

echo.
echo   ============================================================
echo     EvEJS - Standalone Market Server
echo   ============================================================
echo.
echo     [1] Start market server - release build (recommended)
echo     [2] Start market server - debug build
echo     [3] Doctor - inspect manifest and cache state
  echo     [4] Build release binary only
  echo     [5] Edit market server config
  echo     [6] Build or refresh market seed
  echo     [7] Open market server README
  echo.
  echo     Ctrl+C in the live server console now performs a clean stop
  echo     and returns you to the menu without the noisy batch warning.
echo.
choice /c 1234567 /n /m "  Choose [1-7]: "
echo.

if errorlevel 7 goto OpenReadme
if errorlevel 6 goto OpenSeeder
if errorlevel 5 goto EditConfig
if errorlevel 4 goto BuildRelease
if errorlevel 3 goto Doctor
if errorlevel 2 goto StartDebug
if errorlevel 1 goto StartRelease

:StartRelease
call :RunPowerShellMode serve-release
goto Finish

:StartDebug
call :RunPowerShellMode serve-debug
goto Finish

:Doctor
call :RunPowerShellMode doctor
goto Finish

:BuildRelease
call :RunPowerShellMode build-release
goto Finish

:EditConfig
if not exist "%MARKET_SERVER_CONFIG%" (
  echo   [!] Config file not found:
  echo       %MARKET_SERVER_CONFIG%
  pause
  exit /b 1
)
start "" notepad "%MARKET_SERVER_CONFIG%"
exit /b 0

:OpenSeeder
if not exist "%MARKET_SEED_LAUNCHER%" (
  echo   [!] Seeder launcher not found:
  echo       %MARKET_SEED_LAUNCHER%
  pause
  exit /b 1
)
call "%MARKET_SEED_LAUNCHER%"
exit /b %errorlevel%

:OpenReadme
start "" notepad "%MARKET_SERVER_DIR%\README.md"
exit /b 0

:RunPowerShellMode
if not exist "%MARKET_SERVER_PS%" (
  echo   [!] PowerShell launcher not found:
  echo       %MARKET_SERVER_PS%
  exit /b 1
)
if not exist "%POWERSHELL_EXE%" (
  echo   [!] PowerShell executable not found:
  echo       %POWERSHELL_EXE%
  exit /b 1
)
"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%MARKET_SERVER_PS%" -Mode %1
set "EVEJS_EXIT=%errorlevel%"
exit /b 0

:Finish
if not "%EVEJS_EXIT%"=="0" (
  echo.
  echo   Market server command exited with code %EVEJS_EXIT%.
  if "%EVEJS_NONINTERACTIVE%"=="0" pause
)
exit /b %EVEJS_EXIT%

:ResolveCargo
set "CARGO_EXE=%USERPROFILE%\.cargo\bin\cargo.exe"
if exist "%CARGO_EXE%" exit /b 0

for /f "delims=" %%I in ('where cargo 2^>nul') do (
  set "CARGO_EXE=%%I"
  exit /b 0
)

echo.
echo   [!] Rust cargo.exe was not found.
echo       Run tools\InstallRustForMarket.bat
echo       or install Rust manually with:
echo       winget install -e --id Rustlang.Rustup
echo.
pause
exit /b 1

:InitializeMsvcBuildEnvironment
call :ResolveVisualCppInstall
if errorlevel 1 goto MsvcMissing
call "%VCVARS64_BAT%" >nul
if errorlevel 1 goto MsvcEnvFailed
where cl.exe >nul 2>&1
if errorlevel 1 goto MsvcCompilerMissing
where link.exe >nul 2>&1
if errorlevel 1 goto MsvcLinkerMissing
call :FindStdargInInclude
if not defined EVEJS_STDARG_HEADER goto MsvcHeaderMissing
exit /b 0

:ResolveVisualCppInstall
set "VS_INSTALL_PATH="
set "VCVARS64_BAT="
call :ResolveVisualCppInstallWithVsWhere "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
if not errorlevel 1 exit /b 0
call :ResolveVisualCppInstallWithVsWhere ""
if not errorlevel 1 exit /b 0
call :ResolveKnownVcvars64
exit /b %errorlevel%

:ResolveVisualCppInstallWithVsWhere
call :ResolveVsWhere
if errorlevel 1 exit /b 1
call :QueryVisualStudioInstall "%~1"
if errorlevel 1 exit /b 1
if not defined VS_INSTALL_PATH exit /b 1
if not exist "%VS_INSTALL_PATH%\VC\Auxiliary\Build\vcvars64.bat" exit /b 1
set "VCVARS64_BAT=%VS_INSTALL_PATH%\VC\Auxiliary\Build\vcvars64.bat"
exit /b 0

:ResolveKnownVcvars64
for %%I in (
  "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
  "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Community"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Professional"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise"
  "%ProgramFiles(x86)%\Microsoft Visual Studio\2019\BuildTools"
  "%ProgramFiles%\Microsoft Visual Studio\2019\BuildTools"
) do (
  if exist "%%~I\VC\Auxiliary\Build\vcvars64.bat" (
    set "VS_INSTALL_PATH=%%~I"
    set "VCVARS64_BAT=%%~I\VC\Auxiliary\Build\vcvars64.bat"
    exit /b 0
  )
)
exit /b 1

:ResolveVsWhere
if exist "%VSWHERE_EXE%" exit /b 0
set "EVEJS_WHERE_RESULT=%TEMP%\evejs-where-vswhere-%RANDOM%-%RANDOM%.txt"
where vswhere > "%EVEJS_WHERE_RESULT%" 2>nul
if errorlevel 1 goto ResolveVsWhereFailed
set /p VSWHERE_EXE=< "%EVEJS_WHERE_RESULT%"
del "%EVEJS_WHERE_RESULT%" >nul 2>&1
if defined VSWHERE_EXE exit /b 0

:ResolveVsWhereFailed
del "%EVEJS_WHERE_RESULT%" >nul 2>&1
exit /b 1

:QueryVisualStudioInstall
set "VS_INSTALL_PATH="
set "EVEJS_VS_QUERY_REQUIRES=%~1"
set "EVEJS_VSWHERE_EXE=%VSWHERE_EXE%"
set "EVEJS_VS_QUERY_RESULT=%TEMP%\evejs-vswhere-%RANDOM%-%RANDOM%.txt"
"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $vs = $env:EVEJS_VSWHERE_EXE; if (-not (Test-Path -LiteralPath $vs)) { exit 1 }; $args = @('-latest', '-products', '*'); if ($env:EVEJS_VS_QUERY_REQUIRES) { $args += @('-requires', $env:EVEJS_VS_QUERY_REQUIRES) }; $args += @('-property', 'installationPath'); & $vs @args | Select-Object -First 1" > "%EVEJS_VS_QUERY_RESULT%" 2>nul
if errorlevel 1 goto QueryVisualStudioInstallFailed
set /p VS_INSTALL_PATH=< "%EVEJS_VS_QUERY_RESULT%"
del "%EVEJS_VS_QUERY_RESULT%" >nul 2>&1
if defined VS_INSTALL_PATH exit /b 0

:QueryVisualStudioInstallFailed
del "%EVEJS_VS_QUERY_RESULT%" >nul 2>&1
exit /b 1

:FindStdargInInclude
set "EVEJS_STDARG_HEADER="
set "EVEJS_STDARG_RESULT=%TEMP%\evejs-stdarg-header-%RANDOM%-%RANDOM%.txt"
"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'SilentlyContinue'; foreach ($p in ($env:INCLUDE -split ';')) { if ([string]::IsNullOrWhiteSpace($p)) { continue }; $candidate = Join-Path $p 'stdarg.h'; if (Test-Path -LiteralPath $candidate) { [Console]::Out.WriteLine($candidate); exit 0 } }; exit 1" > "%EVEJS_STDARG_RESULT%" 2>nul
if errorlevel 1 goto FindStdargInIncludeFailed
set /p EVEJS_STDARG_HEADER=< "%EVEJS_STDARG_RESULT%"
del "%EVEJS_STDARG_RESULT%" >nul 2>&1
exit /b 0

:FindStdargInIncludeFailed
del "%EVEJS_STDARG_RESULT%" >nul 2>&1
exit /b 0

:MsvcMissing
echo.
echo   [!] Visual Studio C++ Build Tools could not be found.
echo       Run tools\InstallRustForMarket.bat, then run this again.
pause
exit /b 1

:MsvcEnvFailed
echo.
echo   [!] Failed to initialize the Visual Studio C++ build environment:
echo       %VCVARS64_BAT%
pause
exit /b 1

:MsvcCompilerMissing
echo.
echo   [!] cl.exe was not found after initializing Visual Studio C++.
echo       Run tools\InstallRustForMarket.bat again.
pause
exit /b 1

:MsvcLinkerMissing
echo.
echo   [!] link.exe was not found after initializing Visual Studio C++.
echo       Run tools\InstallRustForMarket.bat again.
pause
exit /b 1

:MsvcHeaderMissing
echo.
echo   [!] Visual Studio C++ headers are missing from this console.
echo       SQLite and other native crates need stdarg.h while compiling.
echo.
echo       Run tools\InstallRustForMarket.bat again. If Windows asks for a
echo       restart after Visual Studio Build Tools, restart and then retry.
pause
exit /b 1

:RequireMarketCommon
if exist "%MARKET_COMMON_DIR%\Cargo.toml" if exist "%MARKET_COMMON_DIR%\src\lib.rs" exit /b 0
echo.
echo   [!] This EveJS folder is missing required market source files.
echo.
echo       Expected:
echo       %MARKET_COMMON_DIR%\Cargo.toml
echo       %MARKET_COMMON_DIR%\src\lib.rs
echo.
echo       This is not a Rust/MSVC installer problem. The EveJS package is
echo       incomplete, old, or was merged into an existing folder.
echo.
echo       Fix:
echo         1. Download the latest full EveJS release zip.
echo         2. Extract it into a fresh empty folder.
echo         3. Run tools\InstallRustForMarket.bat again if needed.
echo         4. Run BuildMarketSeed.bat again.
echo.
pause
exit /b 1
