@echo off
rem Restart a wedged adb server.
rem
rem Symptom this fixes: capture-xptrace.bat (or any adb command) opens a window
rem and just sits there with a blinking cursor. That means the adb SERVER is
rem stuck, not the script - every adb client then blocks forever waiting on it.
rem
rem Killing adb.exe needs administrator rights, so this script self-elevates.

net session >nul 2>&1
if not errorlevel 1 goto elevated
echo Requesting administrator rights...
powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
exit /b

:elevated
echo.
echo === adb reset ===
echo.
echo Killing any running adb processes...
taskkill /F /IM adb.exe 2>nul
if errorlevel 1 echo   (none were running)

echo.
echo Starting a fresh adb server...
adb start-server

echo.
echo Devices now visible:
adb devices

echo.
echo If the list above is empty: replug the USB cable, unlock the phone, and
echo accept the "Allow USB debugging" prompt if it appears.
echo.
pause
