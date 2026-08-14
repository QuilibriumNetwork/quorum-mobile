# Bridge and launch the dev client on a SECOND USB phone against the Metro
# that dev-start-mobile.ps1 already started. One Metro serves both devices;
# each device just needs its own USB tunnel (adb reverse) and a launch pinned
# to the .debug package.
#
# Two-device round procedure:
#   1. .\.agents\scripts\dev-start-mobile.ps1 -s <serial1>   (Metro + device 1)
#   2. wait until device 1's app has opened (bundle is built)
#   3. .\.agents\scripts\connect-second-device.ps1 -s <serial2>
#
# Serials come from `adb devices`. (-s is adb-style; -Serial also works.)
#
# Device 2 can be USB (plain serial) OR Wi-Fi adb (serial like <phone-ip>:5555)
# - the adb reverse tunnel is per-device and works over both (verified research,
# tasks/2026-06-26-dual-device-preview-setup.md). Wi-Fi notes:
#   * ORDER MATTERS: dev-start-mobile.ps1 DISCONNECTS every Wi-Fi adb endpoint
#     when it starts (its anti-ambiguity auto-heal), so run THIS script only
#     AFTER Metro + device 1 are up.
#   * First-time Wi-Fi enable (classic method): plug the phone in briefly,
#     `adb tcpip 5555`, unplug, find the phone's IP, then use <ip>:5555 here.
#   * Wi-Fi adb is known to drop (device offline). Keep the phone's screen ON
#     and on a charger during the round; if it stops loading or the capture
#     dies, just re-run this script (it re-connects + re-tunnels).
param(
    # Defaults to QM_DEVICE_2 from .env.local when not passed.
    [Alias('s')]
    [string]$Serial
)

. "$PSScriptRoot\_env.ps1"
if (-not $Serial -and $env:QM_DEVICE_2) { $Serial = $env:QM_DEVICE_2 }
if (-not $Serial) {
    Write-Host "ERROR: no device 2 serial. Pass -s <serial>, or set QM_DEVICE_2 in .agents/scripts/.env.local." -ForegroundColor Red
    Write-Host "       Serials come from ``adb devices``. Wi-Fi serials look like <ip>:5555." -ForegroundColor Yellow
    exit 1
}

$adb = "adb"
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $sdkAdb) { $adb = $sdkAdb }
}
$pkg = "com.quilibrium.quorummobile.debug"

# Wi-Fi endpoint (has a colon): establish the adb connection first.
if ($Serial -match ':') {
    Write-Host "Wi-Fi adb endpoint - connecting $Serial ..."
    $conn = & $adb connect $Serial 2>&1
    Write-Host "  $conn" -ForegroundColor DarkGray
    if ($conn -notmatch 'connected') {
        Write-Host "ERROR: adb could not connect to $Serial. Same Wi-Fi network? tcpip mode enabled?" -ForegroundColor Red
        exit 1
    }
}

# A USB serial (no colon) must actually be attached. QM_DEVICE_2 in .env.local is
# only the phone used last, so it goes stale the moment you swap a cable - and the
# adb calls below would then fail one by one with "device not found" instead of
# saying the obvious thing once, up front.
if ($Serial -notmatch ':') {
    . "$PSScriptRoot\_adb-preflight.ps1"
    $ready = @(Get-QmAdbDevices -Adb (Get-QmAdb) | Where-Object { $_.State -eq 'device' } | ForEach-Object { $_.Serial })
    if ($ready -notcontains $Serial) {
        Write-Host ""
        Write-Host "ERROR: device 2 ($Serial) is not attached and ready." -ForegroundColor Red
        if ($ready.Count -gt 0) {
            Write-Host "       Currently attached and ready: $($ready -join ', ')" -ForegroundColor Yellow
        } else {
            Write-Host "       Nothing is attached and ready right now." -ForegroundColor Yellow
        }
        Write-Host "       Pass -s <serial>, or update QM_DEVICE_2 in .agents/scripts/.env.local." -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
}

# USB tunnel: this device's localhost:8081 -> Metro on the PC.
& $adb -s $Serial reverse tcp:8081 tcp:8081
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: adb reverse failed for $Serial. Is the device authorized? (adb devices)" -ForegroundColor Red
    exit 1
}

# Same safety as dev-start-mobile.ps1: never let the deep link fall through to
# the user's REAL app if the debug package is missing.
$pkgList = & $adb -s $Serial shell pm list packages $pkg 2>$null
if (-not ($pkgList -match "package:$pkg")) {
    Write-Host "ERROR: $pkg is NOT installed on $Serial." -ForegroundColor Red
    Write-Host "Install the dev client on this phone first (build-app.ps1 with only" -ForegroundColor Yellow
    Write-Host "this device plugged in, or adb -s $Serial install <dev-client apk>)." -ForegroundColor Yellow
    exit 1
}

# Wait for Metro's bundle to answer (dev-start-mobile.ps1 must be running).
$bundleUrl = "http://127.0.0.1:8081/index.bundle?platform=android&dev=true"
Write-Host "Waiting for Metro's bundle to be ready (instant if device 1 already opened)..."
$ready = $false
for ($i = 0; $i -lt 72; $i++) {
    try {
        $r = Invoke-WebRequest -Uri $bundleUrl -Method Head -TimeoutSec 300 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 5
}
if (-not $ready) {
    Write-Host "ERROR: Metro's bundle never answered. Is dev-start-mobile.ps1 running?" -ForegroundColor Red
    exit 1
}

# Re-assert the tunnel and launch, constrained to the .debug package.
& $adb -s $Serial reverse tcp:8081 tcp:8081 | Out-Null
& $adb -s $Serial shell am force-stop $pkg | Out-Null
$launchUrl = "quorummobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
& $adb -s $Serial shell am start -a android.intent.action.VIEW -d $launchUrl $pkg | Out-Null

Write-Host ""
Write-Host "Second device $Serial is connected to the same Metro and launching." -ForegroundColor Green
Write-Host "If the app shows 'Unable to load script', wait a few seconds and shake -> Reload." -ForegroundColor DarkGray
