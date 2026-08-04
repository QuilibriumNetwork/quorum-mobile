@echo off
rem One-click XPTRACE logcat capture for the DM cross-platform trace.
rem
rem Writes a TIMESTAMPED file per run, so an earlier capture is never
rem overwritten - each round's log is the evidence the bug analysis rests on
rem and cannot be recreated after the fact.
rem
rem Ctrl+C to stop. The file is written continuously, so it survives being
rem interrupted.
rem
rem If this window ever sits blank with just a cursor, the adb server is
rem wedged - run reset-adb.bat in this folder, then try again. Every step
rem below announces itself first so you can always see where it stopped.

echo.
echo === XPTRACE logcat capture ===
echo.

rem Optional first argument: an adb device SERIAL, for two-device rounds
rem (mobile-to-mobile). Run this .bat TWICE in two terminals, once per serial:
rem     capture-xptrace.bat <serial-of-phone-1>
rem     capture-xptrace.bat <serial-of-phone-2>
rem Serials come from `adb devices`. With no argument: single-device as before.
set DEVSEL=
set DEVTAG=
if not "%~1"=="" (
  set DEVSEL=-s %~1
  set DEVTAG=-%~1
)
rem Wi-Fi serials look like <phone-ip>:5555 - colons and dots are not valid
rem in Windows filenames, so sanitize the tag (the -s argument stays as-is).
if defined DEVTAG set DEVTAG=%DEVTAG::=-%
if defined DEVTAG set DEVTAG=%DEVTAG:.=-%

rem Where captures land. Reads QM_CAPTURE_DIR from .env.local (gitignored) if it
rem is set there, else falls back to a folder inside the repo. Same key the
rem PowerShell scripts use via _env.ps1, so both agree on one location.
if exist "%~dp0.env.local" for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0.env.local") do if /i "%%A"=="QM_CAPTURE_DIR" set QM_CAPTURE_DIR=%%B
if not defined QM_CAPTURE_DIR set QM_CAPTURE_DIR=%LOCALAPPDATA%\quorum-mobile\captures
if not exist "%QM_CAPTURE_DIR%" mkdir "%QM_CAPTURE_DIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%i
set OUT=%QM_CAPTURE_DIR%\xptrace-mobile%DEVTAG%-%TS%.log

echo [1/3] Checking adb and connected devices...
echo       (if it hangs HERE, the adb server is wedged - run reset-adb.bat)
adb devices
if errorlevel 1 goto adbfail

echo.
echo [2/3] Clearing the log buffer...
adb %DEVSEL% logcat -c
if errorlevel 1 goto adbfail

echo.
echo [3/3] Capturing to:
echo       %OUT%
echo.
echo Reload the app NOW. Then, BEFORE running the round, validate the capture
echo in a second terminal - do not eyeball it, the check is automatic:
echo.
echo    node ../quorum-desktop/.agents/scripts/validate-capture.mjs "%OUT%"
echo.
echo It exits 0 = usable, 1 = REJECTED (re-arm and start over), 2 = degraded.
echo A REJECTED capture cannot support a measurement. Round 25 was captured,
echo analysed and thrown away because this check was left to a human.
echo The diag rig lines to expect during the test:
echo   [DM-send row]   per send: which session + shape was chosen
echo   [DM-send wire]  per drain batch: target inboxes + fingerprints
echo   [WS-frame]      per frame at the actual ws.send call (len/ib/ba)
echo   [DM-recv wire]  per arriving DM frame: inbox + fingerprint
echo Press Ctrl+C when the test is finished.
echo.
adb %DEVSEL% logcat -v time ReactNativeJS:V *:S > "%OUT%"
goto :eof

:adbfail
echo.
echo adb FAILED. Run reset-adb.bat in this folder, then try again.
echo If the device list above was empty: replug the cable, unlock the phone,
echo and accept the "Allow USB debugging" prompt.
echo.
pause
