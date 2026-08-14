# ONE-COMMAND two-device DM test round (the deliverable of
# tasks/2026-06-26-dual-device-preview-setup.md, built for
# tasks/2026-07-26-mobile-to-mobile-two-device-round.md).
#
#   .\.agents\scripts\two-device-round.ps1 -s1 <serial1-USB> -s2 <serial2>
#
# PREFERRED SETUP: BOTH devices via USB cable (rock solid, verified 2026-07-26).
# Device 2 can also be Wi-Fi adb (<ip>:5555; enable once with `adb tcpip 5555`
# while plugged in) but Wi-Fi adb drops when the phone dozes - fallback only.
# Optional: -ResetCache (pass-through to Metro, use after node_modules edits).
#
# What it does, in order:
#   1. spawns dev-start-mobile.ps1 -s <s1> in its OWN window (Metro stays
#      interactive there - do not close that window during the round)
#   2. waits for the bundle to build, connects device 2 (adb connect if Wi-Fi,
#      per-device adb reverse tunnel, launches the .debug dev client)
#   3. starts BOTH logcat captures (via capture-xptrace.bat, minimized windows)
#   4. force-stops + relaunches BOTH apps so the startup markers land INSIDE
#      the captures (the round-26/27 mistake, automated away)
#   5. polls both capture files and reports the four armed markers
#   6. waits; when the round is done press Enter -> captures stop, file paths
#      are printed
#
# Your part: run the message round on the phones, then press Enter here.
# Prereqs it cannot do for you: dev client installed on BOTH devices, each
# signed into a DIFFERENT account; Wi-Fi device on the same LAN.
param(
    # Default to QM_DEVICE_1 / QM_DEVICE_2 from .env.local when not passed.
    [string]$s1,
    [string]$s2,
    [switch]$ResetCache
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_env.ps1"

# Resolved after _env.ps1 rather than as param defaults: param defaults bind
# before the body runs, so .env.local is not loaded yet at that point.
if (-not $s1 -and $env:QM_DEVICE_1) { $s1 = $env:QM_DEVICE_1 }
if (-not $s2 -and $env:QM_DEVICE_2) { $s2 = $env:QM_DEVICE_2 }
if (-not $s1 -or -not $s2) {
    Write-Host "ERROR: need two device serials." -ForegroundColor Red
    Write-Host "       Pass them:  .\.agents\scripts\two-device-round.ps1 -s1 <serial> -s2 <serial>" -ForegroundColor Yellow
    Write-Host "       Or set QM_DEVICE_1 / QM_DEVICE_2 in .agents/scripts/.env.local." -ForegroundColor Yellow
    Write-Host "       Serials come from ``adb devices``. Wi-Fi serials look like <ip>:5555." -ForegroundColor Yellow
    exit 1
}

# Validate the serials against what is actually attached, BEFORE running a whole
# capture round against a phone that isn't there. QM_DEVICE_1/2 in .env.local are
# just the phones used last: swap a cable and they go stale silently, and the
# failure then surfaces deep inside the round as confusing adb errors. Naming two
# devices explicitly is inherent here (you cannot autodetect "device 2"), so this
# validates rather than substitutes - it tells you exactly what IS connected.
. "$PSScriptRoot\_adb-preflight.ps1"
$attached = @(Get-QmAdbDevices -Adb (Get-QmAdb) | Where-Object { $_.State -eq 'device' } | ForEach-Object { $_.Serial })
$missing  = @(@($s1, $s2) | Where-Object { $attached -notcontains $_ })
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "ERROR: these configured serials are not attached: $($missing -join ', ')" -ForegroundColor Red
    if ($attached.Count -gt 0) {
        Write-Host "       Currently attached and ready: $($attached -join ', ')" -ForegroundColor Yellow
    } else {
        Write-Host "       Nothing is attached and ready right now." -ForegroundColor Yellow
    }
    Write-Host "       Pass -s1/-s2 explicitly, or update QM_DEVICE_1 / QM_DEVICE_2 in .env.local." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
$scripts = Join-Path $repo ".agents\scripts"
$pkg = "com.quilibrium.quorummobile.debug"
$launchUrl = "quorummobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"

$adb = "adb"
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $sdkAdb) { $adb = $sdkAdb }
}

function Sanitize([string]$serial) { return ($serial -replace '[:.]', '-') }

Write-Host ""
Write-Host "=== two-device round: $s1 (USB) + $s2 ===" -ForegroundColor Cyan
Write-Host ""

# --- 0. sanity: both devices visible (Wi-Fi s2 connects later) -------------
# Join to ONE string first: with an array on the left, -notmatch FILTERS (returns
# the non-matching lines) instead of testing, and a non-empty result is truthy -
# so every check fired even with both phones plugged in.
$devs = (& $adb devices) -join "`n"
if ($devs -notmatch [regex]::Escape($s1)) {
    Write-Host "ERROR: device 1 ($s1) is not in the adb device list. Plug it in + authorize." -ForegroundColor Red
    exit 1
}
if (($s2 -notmatch ':') -and ($devs -notmatch [regex]::Escape($s2))) {
    Write-Host "ERROR: device 2 ($s2) is not in the adb device list. Plug it in + authorize." -ForegroundColor Red
    exit 1
}

# --- 1. Metro + device 1 in its own interactive window --------------------
$devStartArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
    '-File', (Join-Path $scripts 'dev-start-mobile.ps1'), '-s', $s1)
if ($ResetCache) { $devStartArgs += '-ResetCache' }
Write-Host "[1/6] Starting Metro + device 1 in a separate window (leave it open)..."
Start-Process powershell -ArgumentList $devStartArgs | Out-Null

# --- 2. wait for the bundle, then bring up device 2 -----------------------
Write-Host "[2/6] Waiting for the bundle (cold build can take ~2.5 min; -ResetCache longer)..."
$bundleUrl = "http://127.0.0.1:8081/index.bundle?platform=android&dev=true"
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
    try {
        $r = Invoke-WebRequest -Uri $bundleUrl -Method Head -TimeoutSec 300 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 5
}
if (-not $ready) {
    Write-Host "ERROR: bundle never became ready. Check the Metro window." -ForegroundColor Red
    exit 1
}
Write-Host "      Bundle ready."
Write-Host "[3/6] Connecting device 2 ($s2)..."
& (Join-Path $scripts 'connect-second-device.ps1') -s $s2
if ($LASTEXITCODE -ne 0) { exit 1 }

# --- 3. start both captures (proven .bat path, minimized windows) ----------
Write-Host "[4/6] Starting both logcat captures..."
$capBat = Join-Path $scripts 'capture-xptrace.bat'
$capProcs = @()
$capTags = @{}
foreach ($s in @($s1, $s2)) {
    $p = Start-Process cmd -ArgumentList '/c', "`"$capBat`" $s" -WindowStyle Minimized -PassThru
    $capProcs += $p
    $capTags[$s] = "xptrace-mobile-$(Sanitize $s)-*.log"
}
Start-Sleep -Seconds 4   # let the .bats create their files

$capFiles = @{}
foreach ($s in @($s1, $s2)) {
    $f = Get-ChildItem (Join-Path $captureDir $capTags[$s]) -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $f) {
        Write-Host "ERROR: capture file for $s never appeared - check the minimized capture window." -ForegroundColor Red
        exit 1
    }
    $capFiles[$s] = $f.FullName
    Write-Host "      $s -> $($f.FullName)"
}

# --- 4. relaunch BOTH apps so the armed markers land in the captures -------
Write-Host "[5/6] Relaunching both apps (markers must land INSIDE the captures)..."
foreach ($s in @($s1, $s2)) {
    & $adb -s $s reverse tcp:8081 tcp:8081 | Out-Null
    & $adb -s $s shell am force-stop $pkg | Out-Null
    Start-Sleep -Milliseconds 500
    & $adb -s $s shell am start -a android.intent.action.VIEW -d $launchUrl $pkg | Out-Null
}

# --- 5. verify the four markers -------------------------------------------
# A dev-client cold JS load takes 90-140 s (the bundle comes over the adb
# tunnel), and `adb logcat > file` is block-buffered on top of that, so lines
# reach disk in chunks. The old 90 s deadline expired while the apps were still
# booting and declared a perfectly good rig INVALID. Wait 5 min and narrate.
Write-Host "[6/6] Verifying armed markers (apps are still booting - up to 5 min)..."
$markers = @('[DM-diag] armed', '[WS-diag] transport patch armed')
$deadline = (Get-Date).AddSeconds(300)
$allOk = $false
while ((Get-Date) -lt $deadline) {
    $allOk = $true
    $pending = 0
    foreach ($s in @($s1, $s2)) {
        $content = Get-Content $capFiles[$s] -Raw -ErrorAction SilentlyContinue
        foreach ($m in $markers) {
            if (-not $content -or -not $content.Contains($m)) { $allOk = $false; $pending++ }
        }
    }
    if ($allOk) { break }
    $left = [int](($deadline - (Get-Date)).TotalSeconds)
    Write-Host ("      $pending of 4 markers still pending, ${left}s left...") -ForegroundColor DarkGray
    Start-Sleep -Seconds 10
}
Write-Host ""
foreach ($s in @($s1, $s2)) {
    $content = Get-Content $capFiles[$s] -Raw -ErrorAction SilentlyContinue
    foreach ($m in $markers) {
        $ok = $content -and $content.Contains($m)
        $color = if ($ok) { 'Green' } else { 'Red' }
        $state = if ($ok) { 'OK ' } else { 'MISSING' }
        Write-Host ("  {0}  {1,-34} {2}" -f $state, $m, $s) -ForegroundColor $color
    }
}
Write-Host ""
if (-not $allOk) {
    Write-Host "NOT all markers present - the round is INVALID. Common causes:" -ForegroundColor Red
    Write-Host "  missing [DM-diag]: build is not the diag branch (reload the app: shake -> Reload)" -ForegroundColor Yellow
    Write-Host "  missing [WS-diag]: transport patch gone - run: node .agents/scripts/patch-rn-ws-diag.mjs, then re-run with -ResetCache" -ForegroundColor Yellow
    Write-Host "You can still proceed for a smoke test, but frame tracing will be incomplete." -ForegroundColor Yellow
} else {
    Write-Host "ALL FOUR MARKERS PRESENT - the round is valid. Go!" -ForegroundColor Green
}
Write-Host ""
Write-Host "Run the message round now (reset the DM session from one device, then" -ForegroundColor Cyan
Write-Host "12 alternating messages each way: a1, b1, a2, ... noting delivered/not)." -ForegroundColor Cyan
Write-Host ""
Read-Host "When the round is DONE, press Enter here to stop both captures"

# --- 6. stop captures, report ---------------------------------------------
foreach ($p in $capProcs) {
    if (-not $p.HasExited) {
        & taskkill /PID $p.Id /T /F 2>$null | Out-Null
    }
}
Write-Host ""
Write-Host "Captures stopped. Hand these two files (plus your delivered/not notes)" -ForegroundColor Green
Write-Host "to the analysis session:" -ForegroundColor Green
foreach ($s in @($s1, $s2)) {
    Write-Host "  $($capFiles[$s])"
}
Write-Host ""
Write-Host "(The Metro window is still running - leave it if you plan another round," -ForegroundColor DarkGray
Write-Host " Ctrl+C it when you're done for the day.)" -ForegroundColor DarkGray
