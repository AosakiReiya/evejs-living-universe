@echo off
setlocal EnableDelayedExpansion
title EveJS Elysian - Play


rem Resolve the launcher root from this script's location.
for %%I in ("%~dp0.") do set "EVEJS_REPO_ROOT=%%~fI"


rem Load config from the new location first, then older layouts.
call :ResolveConfigDir
if errorlevel 1 exit /b 1
call "%EVEJS_CONFIG_DIR%\EvEJSConfig.bat"
if errorlevel 1 (
  echo.
  echo   [ERROR] Could not load launcher config:
  echo       %EVEJS_CONFIG_DIR%\EvEJSConfig.bat
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     EveJS Elysian - Play
echo   ============================================================
echo.


rem Check whether setup already completed.
set "NEEDS_SETUP=0"

if not defined EVEJS_CLIENT_PATH (
  set "NEEDS_SETUP=1"
) else if not exist "%EVEJS_CLIENT_PATH%" (
  set "NEEDS_SETUP=1"
)

if not exist "%EVEJS_CA_PEM%" (
  set "NEEDS_SETUP=1"
)

set "CLIENT_EXE="
if defined EVEJS_CLIENT_EXE if exist "%EVEJS_CLIENT_EXE%" set "CLIENT_EXE=%EVEJS_CLIENT_EXE%"
if not defined CLIENT_EXE if defined EVEJS_CLIENT_PATH if exist "%EVEJS_CLIENT_PATH%\bin64\exefile.exe" set "CLIENT_EXE=%EVEJS_CLIENT_PATH%\bin64\exefile.exe"
if not defined CLIENT_EXE if defined EVEJS_CLIENT_PATH if exist "%EVEJS_CLIENT_PATH%\bin\exefile.exe" set "CLIENT_EXE=%EVEJS_CLIENT_PATH%\bin\exefile.exe"
if not defined CLIENT_EXE set "NEEDS_SETUP=1"

if "%NEEDS_SETUP%"=="1" (
  echo   [ERROR] First-time setup required.
  if exist "%EVEJS_REPO_ROOT%\tools\ClientSETUP\StartClientSetup.bat" (
    echo       Run tools\ClientSETUP\StartClientSetup.bat first.
  ) else (
    echo       Run the Client Setup launcher that came with this copy first.
  )
  pause
  exit /b 1
)

if not exist "%CLIENT_EXE%" (
  echo   [ERROR] Client executable not found: %CLIENT_EXE%
  echo       Run the setup wizard again or edit %EVEJS_CONFIG_DIR%\EvEJSConfig.bat
  pause
  exit /b 1
)

if not exist "%EVEJS_CA_PEM%" (
  echo   [ERROR] Certificate file missing: %EVEJS_CA_PEM%
  echo       Run the setup wizard again to install certificates.
  pause
  exit /b 1
)

for %%I in ("%CLIENT_EXE%") do set "CLIENT_DIR=%%~dpI"
for %%I in ("%CLIENT_DIR%..") do set "CLIENT_ROOT=%%~fI"

call :ValidateClientSetup
if errorlevel 1 (
  pause
  exit /b 1
)

call :ResolveClientResourceCache
if errorlevel 1 (
  pause
  exit /b 1
)

call :ValidateClientResourceCache
if errorlevel 1 (
  pause
  exit /b 1
)

call :EnsureClientDisplaySafety
if errorlevel 1 (
  pause
  exit /b 1
)

call :EnsureClientCertificateTrust
if errorlevel 1 (
  echo   [ERROR] Could not prepare client certificate trust.
  pause
  exit /b 1
)

call :ApplyClientNetworkPolicy "%EVEJS_PROXY_URL%"
if errorlevel 1 (
  echo   [ERROR] Could not apply client network policy.
  pause
  exit /b 1
)

call :EnsureServerAvailable
if errorlevel 1 (
  pause
  exit /b 1
)

call :WriteLaunchDiagnostics

echo   Launching EVE client...
echo.
echo     Client: %CLIENT_EXE%
echo     ResFiles: %EO_REMOTEFILECACHEFOLDER%
echo     Proxy:  %EVEJS_PROXY_URL%
echo     CA cert: %EVEJS_CA_PEM%
echo     Darkly: blocked by launcher network policy
echo     Diagnostics: %EVEJS_LAUNCH_DIAG%
echo.
echo   ============================================================
echo     Game is running. This window will stay open when you exit.
echo   ============================================================
echo.

if "%EVEJS_DRY_RUN%"=="1" (
  echo   Dry run complete. Client launch skipped.
  ping -n 3 127.0.0.1 >nul 2>&1
  exit /b 0
)

call :PrepareClientCrashDiagnostics

cd /d "%CLIENT_DIR%"
set "EVEJS_CLIENT_STDIO_LOG=%EVEJS_DIAGNOSTICS_DIR%\evejs-client-stdout-%RANDOM%%RANDOM%.log"
echo   Client stdio log: %EVEJS_CLIENT_STDIO_LOG%
echo   Client crash report: %EVEJS_CLIENT_CRASH_REPORT%
echo.
rem Give legacy raw stdout/stderr writes a stable file-backed sink so client-side prints do not hit EBADF/cp0.
"%CLIENT_EXE%" 1>>"%EVEJS_CLIENT_STDIO_LOG%" 2>&1
set "EVEJS_EXIT=%errorlevel%"
call :WriteClientCrashReport
set "EVEJS_CRASH_EVENTS=%errorlevel%"

echo.
if "%EVEJS_EXIT%"=="0" (
  echo   Client exited cleanly. See you next time!
) else (
  echo   Client exited with code %EVEJS_EXIT%.
  echo   Client stdio log: %EVEJS_CLIENT_STDIO_LOG%
  call :PrintClientStdioTail
)
echo   Launch diagnostics: %EVEJS_LAUNCH_DIAG%
echo   Client crash report: %EVEJS_CLIENT_CRASH_REPORT%
if "%EVEJS_CRASH_EVENTS%"=="2" (
  echo.
  echo   Windows recorded a matching client crash event.
  echo   Send the crash report above if this is still failing.
)

echo.
echo   Press any key to close this launcher.
pause >nul
exit /b %EVEJS_EXIT%

:ValidateClientSetup
set "EVEJS_START_INI=%EVEJS_CLIENT_PATH%\start.ini"
if not exist "%EVEJS_START_INI%" (
  echo.
  echo   [ERROR] start.ini was not found in the configured client:
  echo       %EVEJS_START_INI%
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 5.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ini=$env:EVEJS_START_INI; $server=$null; $crypto=$null; foreach($line in Get-Content -LiteralPath $ini){ if($line -match '^\s*(server|serverip)\s*=\s*(.+?)\s*$'){ $server=$Matches[2].Trim() }; if($line -match '^\s*cryptoPack\s*=\s*(.+?)\s*$'){ $crypto=$Matches[1].Trim() } }; if($server -ne '127.0.0.1'){ exit 3 }; if($crypto -ne 'Placebo'){ exit 4 }; exit 0"
set "EVEJS_START_INI_EXIT=%errorlevel%"
if "%EVEJS_START_INI_EXIT%"=="3" (
  echo.
  echo   [ERROR] start.ini is not pointed at the local EvEJS server.
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 5.
  exit /b 1
)
if "%EVEJS_START_INI_EXIT%"=="4" (
  echo.
  echo   [ERROR] start.ini is not using cryptoPack = Placebo.
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 5.
  exit /b 1
)
if not "%EVEJS_START_INI_EXIT%"=="0" (
  echo.
  echo   [ERROR] Could not validate start.ini.
  echo       Run tools\ClientSETUP\StartClientSetup.bat again.
  exit /b 1
)

set "EVEJS_BLUE_DLL=%EVEJS_CLIENT_PATH%\bin64\blue.dll"
if not exist "%EVEJS_BLUE_DLL%" (
  echo.
  echo   [ERROR] blue.dll was not found in the configured client:
  echo       %EVEJS_BLUE_DLL%
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 4.
  exit /b 1
)

:ValidateBlueDllStatus
set "EVEJS_BLUE_STATUS=%TEMP%\evejs-blue-status-%RANDOM%%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\blue_dll_patch.ps1" --status --input "%EVEJS_BLUE_DLL%" >"%EVEJS_BLUE_STATUS%" 2>&1
set "EVEJS_BLUE_EXIT=%errorlevel%"
set "EVEJS_BLUE_STATE="
set "EVEJS_BLUE_MESSAGE="
for /f "usebackq tokens=1,* delims==" %%A in ("%EVEJS_BLUE_STATUS%") do (
  if /I "%%A"=="state" set "EVEJS_BLUE_STATE=%%B"
  if /I "%%A"=="message" set "EVEJS_BLUE_MESSAGE=%%B"
)
del "%EVEJS_BLUE_STATUS%" >nul 2>&1

if not defined EVEJS_BLUE_STATE call :FallbackBlueDllStatus

if not "%EVEJS_BLUE_EXIT%"=="0" (
  echo.
  echo   [ERROR] Could not inspect blue.dll.
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 4.
  exit /b 1
)
if /I "%EVEJS_BLUE_STATE%"=="already_patched" exit /b 0

if /I "%EVEJS_BLUE_STATE%"=="patchable_original" (
  echo   blue.dll is the supported original build. Patching it automatically...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\blue_dll_patch.ps1" --input "%EVEJS_BLUE_DLL%" --in-place >"%TEMP%\evejs-blue-auto-patch.log" 2>&1
  if errorlevel 1 (
    echo.
    echo   [ERROR] Automatic blue.dll patch failed.
    echo       Patch log: %TEMP%\evejs-blue-auto-patch.log
    echo       Configured client: %EVEJS_CLIENT_PATH%
    echo       blue.dll checked:  %EVEJS_BLUE_DLL%
    exit /b 1
  )
  goto ValidateBlueDllStatus
)

if /I not "%EVEJS_BLUE_STATE%"=="already_patched" (
  echo.
  echo   [ERROR] blue.dll is not patched for EvEJS.
  if defined EVEJS_BLUE_MESSAGE echo       %EVEJS_BLUE_MESSAGE%
  echo.
  echo       Config file loaded:
  echo         %EVEJS_CONFIG_DIR%\EvEJSConfig.bat
  echo       Configured client:
  echo         %EVEJS_CLIENT_PATH%
  echo       Client executable that Play.bat will launch:
  echo         %CLIENT_EXE%
  echo       blue.dll file checked:
  echo         %EVEJS_BLUE_DLL%
  echo       Detected blue.dll state:
  echo         %EVEJS_BLUE_STATE%
  echo.
  echo       If you manually copied a patched blue.dll, copy it over the exact
  echo       blue.dll path shown above. If that path is not your EveJS copy,
  echo       run tools\ClientSETUP\StartClientSetup.bat and select the right client.
  exit /b 1
)
exit /b 0

:FallbackBlueDllStatus
for /f "usebackq tokens=1,2 delims=," %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:EVEJS_BLUE_DLL; if(-not (Test-Path -LiteralPath $p -PathType Leaf)){exit 1}; $i=Get-Item -LiteralPath $p; $h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant(); Write-Output ($i.Length.ToString() + ',' + $h)"`) do (
  set "EVEJS_BLUE_SIZE=%%A"
  set "EVEJS_BLUE_HASH=%%B"
)
if "%EVEJS_BLUE_SIZE%"=="12068352" if /I "%EVEJS_BLUE_HASH%"=="7f8e19adfe002ab91d5c2ac0b317bbcfed4514000d6be0f5eb619d614f22d93f" (
  set "EVEJS_BLUE_STATE=already_patched"
  set "EVEJS_BLUE_MESSAGE=blue.dll matches the known stripped EvEJS patched build."
  set "EVEJS_BLUE_EXIT=0"
)
set "EVEJS_BLUE_SIZE="
set "EVEJS_BLUE_HASH="
exit /b 0

:EnsureClientDisplaySafety
if /I "%EVEJS_CLIENT_SAFE_WINDOWED%"=="on" (
  echo   Preparing safe windowed display settings...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\PrepareClientSettings.ps1" -Mode Display
  set "EVEJS_DISPLAY_EXIT=!errorlevel!"
  if not "!EVEJS_DISPLAY_EXIT!"=="0" (
    echo.
    echo   [ERROR] Could not prepare safe client display settings.
    echo       This usually means Windows blocked access to %%LOCALAPPDATA%%\CCP\EVE
    echo       or the configured client path is invalid.
    exit /b !EVEJS_DISPLAY_EXIT!
  )
)
if /I "%EVEJS_CLIENT_SAFE_GRAPHICS%"=="on" (
  call :EnsureClientGraphicsSafety
  exit /b !errorlevel!
)
exit /b 0

:EnsureClientGraphicsSafety
echo   Preparing safe low graphics settings...
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\PrepareClientSettings.ps1" -Mode Graphics
exit /b %errorlevel%

:EnsureServerAvailable
echo   Checking local EvEJS server...
call :CheckGameServerPort
set "EVEJS_GAME_PORT_OK=!errorlevel!"
call :CheckProxyHealth
set "EVEJS_PROXY_OK=!errorlevel!"
call :CheckLivingUniverseReady
set "EVEJS_LIVING_UNIVERSE_OK=!errorlevel!"
if "!EVEJS_GAME_PORT_OK!"=="0" if "!EVEJS_PROXY_OK!"=="0" if "!EVEJS_LIVING_UNIVERSE_OK!"=="0" (
  echo   Local server is ready.
  exit /b 0
)

rem A running Docker server keeps runtime telemetry inside its Linux volume,
rem where this Windows launcher cannot validate either the file or its PID.
rem The reachable game and proxy endpoints remain the cross-mode readiness
rem contract and prevent Play.bat from starting a conflicting native server.
if "!EVEJS_GAME_PORT_OK!"=="0" if "!EVEJS_PROXY_OK!"=="0" (
  echo   Local server is ready.
  exit /b 0
)

if not defined EVEJS_SERVER_START_IN_PROGRESS (
  if not exist "%EVEJS_REPO_ROOT%\StartServer.bat" (
    echo.
    echo   [ERROR] StartServer.bat was not found at:
    echo       %EVEJS_REPO_ROOT%\StartServer.bat
    exit /b 1
  )
  echo   Server is not running. Starting the normal EveJS server stack...
  start "EvEJS Server" "%EVEJS_REPO_ROOT%\StartServer.bat" --background
)

for /L %%N in (1,1,900) do (
  call :CheckGameServerPort
  set "EVEJS_GAME_PORT_OK=!errorlevel!"
  call :CheckProxyHealth
  set "EVEJS_PROXY_OK=!errorlevel!"
  call :CheckLivingUniverseReady
  set "EVEJS_LIVING_UNIVERSE_OK=!errorlevel!"
  if "!EVEJS_GAME_PORT_OK!"=="0" if "!EVEJS_PROXY_OK!"=="0" if "!EVEJS_LIVING_UNIVERSE_OK!"=="0" (
    echo   Local server is ready.
    exit /b 0
  )
  if "%%N"=="1" (
    echo   Waiting for StartServer.bat to finish booting 5,000 pilots, X-Eve, the market, and the proxy...
  )
  ping -n 2 127.0.0.1 >nul 2>&1
)

echo.
echo   [ERROR] EvEJS server is not reachable yet.
echo       Check the EvEJS Server window for the first failing setup step.
echo.
echo       Expected:
echo         Game TCP: 127.0.0.1:26000
echo         Proxy:    %EVEJS_PROXY_URL%health
exit /b 1

:CheckGameServerPort
powershell -NoProfile -ExecutionPolicy Bypass -Command "$client=[Net.Sockets.TcpClient]::new(); try { $iar=$client.BeginConnect('127.0.0.1',26000,$null,$null); if(-not $iar.AsyncWaitHandle.WaitOne(750,$false)){ exit 1 }; $client.EndConnect($iar); exit 0 } catch { exit 1 } finally { $client.Close() }" >nul 2>&1
exit /b %errorlevel%

:CheckProxyHealth
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $base=[Uri]$env:EVEJS_PROXY_URL; $health=[Uri]::new($base,'health').AbsoluteUri; $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $health; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 }; exit 1 } catch { exit 1 }" >nul 2>&1
exit /b %errorlevel%

:CheckLivingUniverseReady
if not exist "%EVEJS_REPO_ROOT%\tools\ServerStack\TestLivingUniverseReady.ps1" exit /b 1
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ServerStack\TestLivingUniverseReady.ps1" -RepoRoot "%EVEJS_REPO_ROOT%" >nul 2>&1
exit /b %errorlevel%

:WriteLaunchDiagnostics
call :EnsureDiagnosticsDir
set "EVEJS_LAUNCH_DIAG=%EVEJS_DIAGNOSTICS_DIR%\evejs-launch-diagnostics-%RANDOM%%RANDOM%.txt"
(
  echo EveJS launch diagnostics
  echo Timestamp: %DATE% %TIME%
  echo RepoRoot: %EVEJS_REPO_ROOT%
  echo ConfigDir: %EVEJS_CONFIG_DIR%
  echo ClientPath: %EVEJS_CLIENT_PATH%
  echo ClientExe: %CLIENT_EXE%
  echo ClientDir: %CLIENT_DIR%
  echo ClientRoot: %CLIENT_ROOT%
  echo ResFiles: %EO_REMOTEFILECACHEFOLDER%
  echo CacheRoot: %EVEJS_CLIENT_CACHE_ROOT%
  echo ResourceIndex: %EVEJS_CLIENT_INDEX%
  echo ProxyUrl: %EVEJS_PROXY_URL%
  echo CaPem: %EVEJS_CA_PEM%
  echo DarklyPolicy: blocked
  echo BlockedHosts: %EVEJS_PROXY_BLOCKED_HOSTS%
  echo TLSCaBundle: %SSL_CERT_FILE%
  echo SafeWindowed: %EVEJS_CLIENT_SAFE_WINDOWED%
  echo SafeGraphics: %EVEJS_CLIENT_SAFE_GRAPHICS%
  echo WindowWidth: %EVEJS_CLIENT_WINDOW_WIDTH%
  echo WindowHeight: %EVEJS_CLIENT_WINDOW_HEIGHT%
  echo BlueState: %EVEJS_BLUE_STATE%
  echo BlueMessage: %EVEJS_BLUE_MESSAGE%
  echo StartIni: %EVEJS_START_INI%
  echo.
  echo --- start.ini ---
  type "%EVEJS_START_INI%"
  echo.
  echo --- Connectivity ---
  echo Game TCP 127.0.0.1:26000 checked before launch.
  echo Proxy health %EVEJS_PROXY_URL%health checked before launch.
  echo.
  echo --- User report checklist ---
  echo Send this file, the launcher window text, and the client stdio log if Play.bat prints one after exit.
) > "%EVEJS_LAUNCH_DIAG%" 2>nul
exit /b 0

:EnsureDiagnosticsDir
if not defined EVEJS_DIAGNOSTICS_DIR set "EVEJS_DIAGNOSTICS_DIR=%EVEJS_REPO_ROOT%\_local\diagnostics"
if not exist "%EVEJS_DIAGNOSTICS_DIR%\" mkdir "%EVEJS_DIAGNOSTICS_DIR%" >nul 2>&1
if not exist "%EVEJS_DIAGNOSTICS_DIR%\" set "EVEJS_DIAGNOSTICS_DIR=%TEMP%"
exit /b 0

:PrepareClientCrashDiagnostics
call :EnsureDiagnosticsDir
set "EVEJS_CLIENT_CRASH_REPORT=%EVEJS_DIAGNOSTICS_DIR%\evejs-client-crash-%RANDOM%%RANDOM%.txt"
set "EVEJS_CLIENT_LAUNCH_UTC="
for /f "delims=" %%T in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Date -Format o"') do set "EVEJS_CLIENT_LAUNCH_UTC=%%T"
if not defined EVEJS_CLIENT_LAUNCH_UTC set "EVEJS_CLIENT_LAUNCH_UTC=%DATE% %TIME%"
call :WritePrelaunchCrashReport
exit /b 0

:WritePrelaunchCrashReport
(
  echo EveJS client crash report
  echo Timestamp: %DATE% %TIME%
  echo Status: Created before exefile.exe launched. If this file still says pre-launch, the launcher was closed or killed before the client returned control.
  echo Launch UTC: %EVEJS_CLIENT_LAUNCH_UTC%
  echo Client exe: %CLIENT_EXE%
  echo Client path: %EVEJS_CLIENT_PATH%
  echo blue.dll: %EVEJS_BLUE_DLL%
  echo Blue state: %EVEJS_BLUE_STATE%
  echo Blue message: %EVEJS_BLUE_MESSAGE%
  echo ResFiles: %EO_REMOTEFILECACHEFOLDER%
  echo CacheRoot: %EVEJS_CLIENT_CACHE_ROOT%
  echo ResourceIndex: %EVEJS_CLIENT_INDEX%
  echo Proxy: %EVEJS_PROXY_URL%
  echo Launch diagnostics: %EVEJS_LAUNCH_DIAG%
) > "%EVEJS_CLIENT_CRASH_REPORT%" 2>nul
exit /b 0

:WriteClientCrashReport
if not defined EVEJS_CLIENT_CRASH_REPORT (
  call :PrepareClientCrashDiagnostics
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$report=$env:EVEJS_CLIENT_CRASH_REPORT; try { $start=[DateTime]::Parse($env:EVEJS_CLIENT_LAUNCH_UTC).AddSeconds(-5) } catch { $start=(Get-Date).AddMinutes(-5) }; $exe=[IO.Path]::GetFileName($env:CLIENT_EXE); $lines=New-Object System.Collections.Generic.List[string]; $lines.Add('EveJS client crash report'); $lines.Add('Timestamp: ' + (Get-Date -Format o)); $lines.Add('Launch UTC: ' + $env:EVEJS_CLIENT_LAUNCH_UTC); $lines.Add('Exit code: ' + $env:EVEJS_EXIT); $lines.Add('Client exe: ' + $env:CLIENT_EXE); $lines.Add('Client path: ' + $env:EVEJS_CLIENT_PATH); $lines.Add('blue.dll: ' + $env:EVEJS_BLUE_DLL); $lines.Add('Blue state: ' + $env:EVEJS_BLUE_STATE); $lines.Add('ResFiles: ' + $env:EO_REMOTEFILECACHEFOLDER); $lines.Add('Proxy: ' + $env:EVEJS_PROXY_URL); $lines.Add(''); $lines.Add('Recent Windows Application crash events:'); $found=0; try { $events=Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$start} -ErrorAction Stop | Where-Object { $m=[string]$_.Message; $m -match [regex]::Escape($exe) -or $m -match 'blue\.dll|exefile\.exe|trinity|python|ucrtbase|KERNELBASE|ntdll|d3d|DirectX' } | Select-Object -First 10; foreach($event in $events){ $found++; $lines.Add('---'); $lines.Add('Time: ' + $event.TimeCreated); $lines.Add('Provider: ' + $event.ProviderName); $lines.Add('EventId: ' + $event.Id); $lines.Add('Level: ' + $event.LevelDisplayName); $lines.Add(($event.Message -replace '\r?\n', ' ')) } } catch { $lines.Add('Unable to read Windows Application event log: ' + $_.Exception.Message) }; if($found -eq 0){ $lines.Add('No matching crash events were found since launch.') }; Set-Content -LiteralPath $report -Value $lines -Encoding UTF8; if($found -gt 0){ exit 2 }; exit 0"
set "EVEJS_CRASH_REPORT_EXIT=%errorlevel%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$report=$env:EVEJS_CLIENT_CRASH_REPORT; try { $start=[DateTime]::Parse($env:EVEJS_CLIENT_LAUNCH_UTC).AddSeconds(-30) } catch { $start=(Get-Date).AddMinutes(-10) }; $lines=New-Object System.Collections.Generic.List[string]; $lines.Add(''); $lines.Add('Recent Windows System stability events:'); $found=0; $pattern='Display|nvlddmkm|amdwddmg|igfx|LiveKernelEvent|WHEA|BugCheck|Kernel-Power|Display driver|TDR|DirectX|D3D|hardware error'; try { $events=Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$start; Level=1,2,3} -ErrorAction Stop | Where-Object { $_.ProviderName -match 'Display|nvlddmkm|amdwddmg|igfx|WHEA-Logger|BugCheck|Kernel-Power|Microsoft-Windows-WER-SystemErrorReporting' -or ([string]$_.Message) -match $pattern } | Select-Object -First 15; foreach($event in $events){ $found++; $lines.Add('---'); $lines.Add('Time: ' + $event.TimeCreated); $lines.Add('Provider: ' + $event.ProviderName); $lines.Add('EventId: ' + $event.Id); $lines.Add('Level: ' + $event.LevelDisplayName); $lines.Add(($event.Message -replace '\r?\n', ' ')) } } catch { $lines.Add('Unable to read Windows System event log: ' + $_.Exception.Message) }; if($found -eq 0){ $lines.Add('No matching System stability events were found since launch.') }; Add-Content -LiteralPath $report -Value $lines -Encoding UTF8; if($found -gt 0){ exit 2 }; exit 0"
if not "%errorlevel%"=="0" set "EVEJS_CRASH_REPORT_EXIT=%errorlevel%"
exit /b %EVEJS_CRASH_REPORT_EXIT%

:PrintClientStdioTail
if not exist "%EVEJS_CLIENT_STDIO_LOG%" exit /b 0
echo.
echo   Last client stdio lines:
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Get-Content -LiteralPath $env:EVEJS_CLIENT_STDIO_LOG -Tail 25 } catch { Write-Host ('Unable to read client stdio log: ' + $_.Exception.Message) }"
exit /b 0

:ApplyClientNetworkPolicy
if "%~1"=="" exit /b 1

set "EVEJS_PROXY_TARGET=%~1"
set "EVEJS_PROXY_LOCAL_INTERCEPT=1"
set "EVEJS_PROXY_UNHANDLED_HOST_POLICY=block"
set "EVEJS_DARKLY_BLOCK_HOSTS=launchdarkly.com,.launchdarkly.com,clientstream.launchdarkly.com,events.launchdarkly.com,mobile.launchdarkly.com,app.launchdarkly.com,sdk.launchdarkly.com,stream.launchdarkly.com,launchdarkly.us,.launchdarkly.us,launchdarkly.eu,.launchdarkly.eu"
if defined EVEJS_PROXY_BLOCKED_HOSTS (
  set "EVEJS_PROXY_BLOCKED_HOSTS=!EVEJS_PROXY_BLOCKED_HOSTS!,!EVEJS_DARKLY_BLOCK_HOSTS!"
) else (
  set "EVEJS_PROXY_BLOCKED_HOSTS=api.ipify.org,sentry.io,.sentry.io,google-analytics.com,.google-analytics.com,!EVEJS_DARKLY_BLOCK_HOSTS!"
)

set "http_proxy=%EVEJS_PROXY_TARGET%"
set "https_proxy=%EVEJS_PROXY_TARGET%"
set "HTTP_PROXY=%EVEJS_PROXY_TARGET%"
set "HTTPS_PROXY=%EVEJS_PROXY_TARGET%"
set "all_proxy=%EVEJS_PROXY_TARGET%"
set "ALL_PROXY=%EVEJS_PROXY_TARGET%"

set "EVEJS_NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=%EVEJS_NO_PROXY%"
set "NO_PROXY=%EVEJS_NO_PROXY%"

rem Blank the retail Sentry DSN at process start so the client never boots it.
set "EVE_CLIENT_SENTRY_DSN="

rem The native LaunchDarkly SDK can bypass proxy environment variables on some
rem Windows machines. Pin external TLS trust to the local EveJS CA for this
rem child process so local HTTPS still works, while retail Darkly endpoints do not.
if defined EVEJS_CA_PEM if exist "%EVEJS_CA_PEM%" (
  set "SSL_CERT_FILE=%EVEJS_CA_PEM%"
  set "REQUESTS_CA_BUNDLE=%EVEJS_CA_PEM%"
  set "CURL_CA_BUNDLE=%EVEJS_CA_PEM%"
)
set "SSL_CERT_DIR="
set "LD_OFFLINE=true"
set "LAUNCHDARKLY_OFFLINE=true"
set "LAUNCHDARKLY_SEND_EVENTS=false"
set "LD_SEND_EVENTS=false"

set "EVEJS_PROXY_TARGET="
exit /b 0

:ResolveClientResourceCache
set "EVEJS_CLIENT_RESFILES="
set "EVEJS_CLIENT_CACHE_ROOT="

rem ClientSETUP stores EVEJS_CLIENT_PATH as the selected client's tq folder.
rem The EVE resource cache for that same client lives beside tq as ..\ResFiles.
if defined EVEJS_CLIENT_PATH (
  for %%I in ("%EVEJS_CLIENT_PATH%\..") do set "EVEJS_CLIENT_CACHE_ROOT=%%~fI"
)

rem If an explicit executable was configured, derive the same cache from that executable.
if not defined EVEJS_CLIENT_CACHE_ROOT if defined CLIENT_ROOT (
  for %%I in ("%CLIENT_ROOT%\..") do set "EVEJS_CLIENT_CACHE_ROOT=%%~fI"
)

if defined EVEJS_CLIENT_CACHE_ROOT set "EVEJS_CLIENT_RESFILES=%EVEJS_CLIENT_CACHE_ROOT%\ResFiles"
if defined EVEJS_CLIENT_CACHE_ROOT set "EVEJS_CLIENT_INDEX=%EVEJS_CLIENT_CACHE_ROOT%\index_tranquility.txt"

if not defined EVEJS_CLIENT_RESFILES (
  echo.
  echo   [ERROR] Could not resolve the configured client's ResFiles folder.
  echo       Run tools\ClientSETUP\StartClientSetup.bat again.
  exit /b 1
)

if not exist "%EVEJS_CLIENT_RESFILES%\" (
  echo.
  echo   [ERROR] Client ResFiles folder is missing:
  echo       %EVEJS_CLIENT_RESFILES%
  echo.
  echo       This usually means only the tq folder was copied.
  echo       Copy the full EVE client/shared-cache folder, including:
  echo         %EVEJS_CLIENT_CACHE_ROOT%\ResFiles
  echo         %EVEJS_CLIENT_CACHE_ROOT%\index_tranquility.txt
  exit /b 1
)

set "EO_REMOTEFILECACHEFOLDER=%EVEJS_CLIENT_RESFILES%"
exit /b 0

:ValidateClientResourceCache
if not exist "%EVEJS_CLIENT_INDEX%" (
  echo.
  echo   [ERROR] Client resource index is missing:
  echo       %EVEJS_CLIENT_INDEX%
  echo.
  echo       The EVE client needs this index to map res:/ files into ResFiles.
  echo       Copy the full EVE client/shared-cache folder, not just EVE\tq.
  exit /b 1
)

echo   Checking client resource cache...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=$env:EO_REMOTEFILECACHEFOLDER; $index=$env:EVEJS_CLIENT_INDEX; if(-not (Test-Path -LiteralPath $root -PathType Container)){exit 2}; if(-not (Test-Path -LiteralPath $index -PathType Leaf)){exit 3}; $hex=@(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^[0-9a-fA-F]{2}$' }); if($hex.Count -lt 240){exit 4}; $count=0; try { foreach($file in [IO.Directory]::EnumerateFiles($root, '*', [IO.SearchOption]::AllDirectories)){ $count++; if($count -ge 50000){break} } } catch { exit 5 }; if($count -lt 50000){exit 6}; exit 0"
set "EVEJS_CACHE_EXIT=%errorlevel%"
if "%EVEJS_CACHE_EXIT%"=="0" exit /b 0

echo.
echo   [ERROR] Client ResFiles cache looks incomplete.
echo       ResFiles: %EO_REMOTEFILECACHEFOLDER%
echo       Index:    %EVEJS_CLIENT_INDEX%
echo.
echo       This client will crash with errors like:
echo         RuntimeError: Couldn't open file: res:/dx9/model/...
echo.
echo       Fix:
echo         1. Open the official EVE launcher and let the client fully download.
echo         2. Copy the whole EVE/shared-cache folder, including ResFiles and
echo            index_tranquility.txt, into this EveJS client copy.
echo         3. Run tools\ClientSETUP\StartClientSetup.bat and select that copy.
echo.
echo       Do not copy only the EVE\tq folder.
exit /b 1

:EnsureClientCertificateTrust
set "EVEJS_CERT_INSTALLER=%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1"
if not exist "%EVEJS_CERT_INSTALLER%" (
  echo.
  echo   [ERROR] Certificate installer is missing:
  echo       %EVEJS_CERT_INSTALLER%
  set "EVEJS_CERT_INSTALLER="
  exit /b 1
)

echo   Checking client certificate trust...
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_CERT_INSTALLER%" -ClientPath "%EVEJS_CLIENT_PATH%"
set "EVEJS_CERT_EXIT=%errorlevel%"
set "EVEJS_CERT_INSTALLER="
if not "%EVEJS_CERT_EXIT%"=="0" exit /b %EVEJS_CERT_EXIT%
exit /b 0

:ResolveConfigDir
set "EVEJS_CONFIG_DIR="
if not exist "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.bat" if exist "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.example.bat" (
  copy /y "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.example.bat" "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.bat" >nul
)
if exist "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts"
  exit /b 0
)
if exist "%EVEJS_REPO_ROOT%\scripts\windows\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%EVEJS_REPO_ROOT%\scripts\windows"
  exit /b 0
)
if exist "%~dp0scripts\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%~dp0scripts"
  exit /b 0
)
if exist "%~dp0scripts\windows\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%~dp0scripts\windows"
  exit /b 0
)
if exist "%~dp0EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%~dp0"
  exit /b 0
)
echo.
echo   [ERROR] Launcher config was not found.
echo       Looked for EvEJSConfig.bat under:
echo       %EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts
echo       %EVEJS_REPO_ROOT%\scripts\windows
echo       %~dp0scripts
echo.
echo       Update your launcher files or run the Client Setup wizard again.
pause
exit /b 1
