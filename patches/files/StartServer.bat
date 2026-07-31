@echo off
setlocal EnableDelayedExpansion
title EvEJS - Start Server

rem Resolve the launcher root from this script's location.
for %%I in ("%~dp0.") do set "EVEJS_REPO_ROOT=%%~fI"

rem Load config from the new location first, then older layouts. The launcher
rem config is only needed to launch the EVE client, so a missing or example
rem config is not fatal here -- a server-only host must start without one.
call :ResolveConfigDir
if defined EVEJS_CONFIG_FILE (
  call "!EVEJS_CONFIG_FILE!"
  if errorlevel 1 (
    echo.
    echo   [WARN] Could not load launcher config:
    echo       !EVEJS_CONFIG_FILE!
    echo       Continuing; the server does not need it.
    echo.
  )
)

echo.
echo   ============================================================
echo     EvEJS - Start Server
echo   ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Node.js is not installed or not on PATH.
  echo       The server requires Node.js to run.
  echo       Download it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "%EVEJS_REPO_ROOT%\server\index.js" (
  echo   [ERROR] Server not found at %EVEJS_REPO_ROOT%\server
  pause
  exit /b 1
)

set "EVEJS_LOCAL_DATABASE_ROOT=%EVEJS_REPO_ROOT%\_local\gameStore"
set "EVEJS_GAMESTORE_DATA_DIR=%EVEJS_LOCAL_DATABASE_ROOT%\data"
call :MigrateLegacyData
call :EnsureLocalDatabase
if errorlevel 1 exit /b 1

call :EnsureServerDependencies
if errorlevel 1 exit /b 1

set "PLAY_CHOICE=0"
set "EVEJS_BACKGROUND_SERVER=0"
if /i "%~1"=="--background" (
  set "PLAY_CHOICE=1"
  set "EVEJS_BACKGROUND_SERVER=1"
) else if /i "%~1"=="--server-only" (
  set "PLAY_CHOICE=1"
) else if /i "%~1"=="--server-play" (
  set "PLAY_CHOICE=2"
) else (
  echo   Are you also playing on this machine?
  echo.
  echo     [1] Server only  -  just run the server
  echo     [2] Server + Play -  run the server AND launch the game
  echo.
  set /p "PLAY_CHOICE=  Choose [1/2]: "
)

echo.

rem Launching the client needs a completed client setup. Fall back to server-only
rem rather than failing, so a host with no EVE client still starts the server.
if "%PLAY_CHOICE%"=="2" (
  call :EnsureClientReady
  if not "!EVEJS_CLIENT_READY!"=="1" set "PLAY_CHOICE=1"
)

set "EVEJS_PROXY_LOCAL_INTERCEPT=1"
if not exist "%EVEJS_REPO_ROOT%\server\logs\node-reports" mkdir "%EVEJS_REPO_ROOT%\server\logs\node-reports" >nul 2>&1

call :EnsureMarketServer
if errorlevel 1 exit /b 1

if "%PLAY_CHOICE%"=="2" (
  echo   Starting server in background...
  start "EvEJS Server" cmd /c "cd /d "%EVEJS_REPO_ROOT%\server" && set EVEJS_PROXY_LOCAL_INTERCEPT=1 && npm start"
  echo   Server starting up...
  echo.

  rem Give the server a few seconds to initialize.
  ping -n 5 127.0.0.1 >nul 2>&1

  echo   Launching Play.bat...
  echo.
  set "EVEJS_SERVER_START_IN_PROGRESS=1"
  call "%EVEJS_REPO_ROOT%\Play.bat"
) else (
  echo   Starting server...
  echo   Press Ctrl+C to stop.
  echo.
  echo   ============================================================
  echo     Server is running. Players can connect now.
  echo   ============================================================
  echo.

  pushd "%EVEJS_REPO_ROOT%\server"
  call npm start
  set "EVEJS_EXIT=!errorlevel!"
  popd

  if not "!EVEJS_EXIT!"=="0" (
    echo.
    echo   Server exited with code !EVEJS_EXIT!.
    pause
  )

  exit /b !EVEJS_EXIT!
)

exit /b 0

:EnsureMarketServer
set "EVEJS_MARKET_BOOTSTRAP=%EVEJS_REPO_ROOT%\tools\ServerStack\EnsureMarketServer.ps1"
if not exist "%EVEJS_MARKET_BOOTSTRAP%" (
  echo.
  echo   [ERROR] Living Universe market bootstrap is missing:
  echo       %EVEJS_MARKET_BOOTSTRAP%
  if "%EVEJS_BACKGROUND_SERVER%"=="0" pause
  exit /b 1
)

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_MARKET_BOOTSTRAP%" -RepoRoot "%EVEJS_REPO_ROOT%"
set "EVEJS_MARKET_EXIT=!errorlevel!"
if not "!EVEJS_MARKET_EXIT!"=="0" (
  echo.
  echo   [ERROR] Living Universe market startup failed with code !EVEJS_MARKET_EXIT!.
  echo       First launch requires Rust and Visual Studio C++ Build Tools.
  echo       If they are missing, run tools\InstallRustForMarket.bat once.
  if "%EVEJS_BACKGROUND_SERVER%"=="0" pause
  exit /b !EVEJS_MARKET_EXIT!
)
exit /b 0

:EnsureServerDependencies
if exist "%EVEJS_REPO_ROOT%\server\node_modules\express\package.json" exit /b 0

echo   Server dependencies are not installed.
echo   Running npm ci in the server directory...
echo.

pushd "%EVEJS_REPO_ROOT%\server"
call npm ci
set "EVEJS_NPM_EXIT=!errorlevel!"
popd

if not "!EVEJS_NPM_EXIT!"=="0" (
  echo.
  echo   [ERROR] npm ci failed with code !EVEJS_NPM_EXIT!.
  echo       Check your internet connection and npm configuration.
  pause
  exit /b !EVEJS_NPM_EXIT!
)

echo.
echo   Dependencies installed successfully.
echo.
exit /b 0

:EnsureLocalDatabase
if exist "%EVEJS_LOCAL_DATABASE_ROOT%\manifest.json" exit /b 0

if not exist "%EVEJS_REPO_ROOT%\tools\DatabaseCreator\CreateDatabase.bat" (
  echo   [ERROR] Local database has not been generated and DatabaseCreator is missing.
  echo       Expected: %EVEJS_REPO_ROOT%\tools\DatabaseCreator\CreateDatabase.bat
  pause
  exit /b 1
)

echo   Local database not found.
echo   Running tools\DatabaseCreator\CreateDatabase.bat...
echo.

call "%EVEJS_REPO_ROOT%\tools\DatabaseCreator\CreateDatabase.bat"
set "EVEJS_DB_EXIT=!errorlevel!"
if not "!EVEJS_DB_EXIT!"=="0" (
  echo.
  echo   [ERROR] Database generation failed with code !EVEJS_DB_EXIT!.
  pause
  exit /b !EVEJS_DB_EXIT!
)

echo.
echo   Local database ready: %EVEJS_GAMESTORE_DATA_DIR%
echo.
exit /b 0

:MigrateLegacyData
rem One-time: the data layer used to live under _local\newDatabase. Move it to
rem _local\gameStore (and rename the SQLite file) so an existing install carries
rem its data forward instead of regenerating from scratch.
if exist "%EVEJS_REPO_ROOT%\server\src\gameStore\migrateLegacyNewDatabase.js" (
  node "%EVEJS_REPO_ROOT%\server\src\gameStore\migrateLegacyNewDatabase.js"
)
rem One-time: character portraits and alliance logos used to be written into the
rem source tree, so they were left behind when an install was copied to a new
rem folder. Move them next to gamestore.sqlite where the rest of the runtime
rem data lives. Silent when there is nothing to move.
if exist "%EVEJS_REPO_ROOT%\server\src\gameStore\migrateRuntimeImages.js" (
  node "%EVEJS_REPO_ROOT%\server\src\gameStore\migrateRuntimeImages.js" --quiet
)
exit /b 0

:ResolveConfigDir
rem Find the launcher config written by the client setup wizard. A real config
rem in any known location wins; otherwise fall back to the shipped example so a
rem fresh install still has sane defaults. Never fails: only Play needs this.
set "EVEJS_CONFIG_DIR="
set "EVEJS_CONFIG_FILE="
set "EVEJS_CONFIG_IS_EXAMPLE="
set "EVEJS_CONFIG_EXAMPLE_DIR="
set "EVEJS_CONFIG_EXAMPLE_FILE="

call :TryConfigDir "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts"
call :TryConfigDir "%EVEJS_REPO_ROOT%\scripts\windows"
call :TryConfigDir "%~dp0scripts"
call :TryConfigDir "%~dp0scripts\windows"
call :TryConfigDir "%~dp0."

if not defined EVEJS_CONFIG_FILE if defined EVEJS_CONFIG_EXAMPLE_FILE (
  set "EVEJS_CONFIG_DIR=!EVEJS_CONFIG_EXAMPLE_DIR!"
  set "EVEJS_CONFIG_FILE=!EVEJS_CONFIG_EXAMPLE_FILE!"
  set "EVEJS_CONFIG_IS_EXAMPLE=1"
)
exit /b 0

:TryConfigDir
if defined EVEJS_CONFIG_FILE exit /b 0
set "EVEJS_TRY_DIR=%~f1"
if exist "!EVEJS_TRY_DIR!\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=!EVEJS_TRY_DIR!"
  set "EVEJS_CONFIG_FILE=!EVEJS_TRY_DIR!\EvEJSConfig.bat"
  exit /b 0
)
if not defined EVEJS_CONFIG_EXAMPLE_FILE (
  if exist "!EVEJS_TRY_DIR!\EvEJSConfig.example.bat" (
    set "EVEJS_CONFIG_EXAMPLE_DIR=!EVEJS_TRY_DIR!"
    set "EVEJS_CONFIG_EXAMPLE_FILE=!EVEJS_TRY_DIR!\EvEJSConfig.example.bat"
  )
)
exit /b 0

:EnsureClientReady
rem Decide whether Play.bat can actually launch. Play.bat re-reads the config
rem itself, so this only has to answer "is a usable client configured?".
set "EVEJS_CLIENT_READY="
set "EVEJS_CLIENT_EXE_FOUND="

if not defined EVEJS_CLIENT_PATH goto :ClientNotReady
if not exist "!EVEJS_CLIENT_PATH!" goto :ClientNotReady

if defined EVEJS_CLIENT_EXE if exist "!EVEJS_CLIENT_EXE!" set "EVEJS_CLIENT_EXE_FOUND=1"
if not defined EVEJS_CLIENT_EXE_FOUND if exist "!EVEJS_CLIENT_PATH!\bin64\exefile.exe" set "EVEJS_CLIENT_EXE_FOUND=1"
if not defined EVEJS_CLIENT_EXE_FOUND if exist "!EVEJS_CLIENT_PATH!\bin\exefile.exe" set "EVEJS_CLIENT_EXE_FOUND=1"
if not defined EVEJS_CLIENT_EXE_FOUND goto :ClientNotReady

set "EVEJS_CLIENT_READY=1"
exit /b 0

:ClientNotReady
echo   [NOTE] No EVE client is set up on this machine yet, so the game cannot
echo          be launched from here. Starting the server only.
echo.
echo          To play on this machine, run SetupEveJS.bat (or
echo          tools\ClientSETUP\StartClientSetup.bat) and complete the client steps.
echo.
exit /b 0
