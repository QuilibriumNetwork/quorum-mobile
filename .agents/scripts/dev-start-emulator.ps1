# Start Metro for the ANDROID EMULATOR with a fresh log file.
# Run this every time you start a debug session on the emulator.
# For a physical phone (QR / LAN), use dev-start-mobile.ps1 instead.
#
# Usage (from the repo root terminal):
#   .\.agents\scripts\dev-start-emulator.ps1
#
# What it does that the mobile script doesn't:
#   - Verifies an emulator is actually running (adb devices).
#   - Sets up `adb reverse tcp:8081 tcp:8081` so the app reaches Metro via
#     localhost from inside the emulator (the emulator's "localhost" is
#     itself, not your PC; the reverse tunnel bridges that gap). This is the
#     fix for the dev-client "find a server" screen never connecting.
#   - Launches the installed dev build on the emulator so you don't have to
#     tap anything. (App must already be installed via `yarn android` once.)
#
# Between test iterations:
#   1. Press Ctrl+C in this terminal to stop Metro.
#   2. Press Up arrow then Enter to re-run this script.
#   3. In the emulator: press R twice (or Ctrl+M -> Reload).
#
# That guarantees a clean log file every time.

. "$PSScriptRoot\_env.ps1"
$logPath = Join-Path $repo ".agents\reports\metro-log.txt"

# App identifiers (from app.json). The dev-client launch intent is
# <scheme>://expo-development-client/?url=http://localhost:8081
$androidPackage = "com.quilibrium.quorummobile"
$scheme = "quorummobile"

# Resolve adb. Prefer PATH; fall back to the default Android SDK location.
$adb = "adb"
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $sdkAdb) {
        $adb = $sdkAdb
    }
    else {
        Write-Host ""
        Write-Host "  ERROR: adb not found on PATH or at $sdkAdb" -ForegroundColor Red
        Write-Host "  Install Android platform-tools or add adb to PATH." -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
}

# Make sure the reports folder exists
$reportsDir = Split-Path $logPath -Parent
if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
}

# Wipe old log (force, ignore if missing or locked)
Remove-Item $logPath -Force -ErrorAction SilentlyContinue

# If another Metro process is holding the log file open, we can't delete it.
# Detect that and surface a clear message instead of starting on top of stale logs.
if (Test-Path $logPath) {
    try {
        $fs = [System.IO.File]::Open($logPath, 'Open', 'ReadWrite', 'None')
        $fs.Close()
        Remove-Item $logPath -Force -ErrorAction SilentlyContinue
    }
    catch {
        Write-Host ""
        Write-Host "  ERROR: $logPath is locked by another process." -ForegroundColor Red
        Write-Host "  Another Metro instance is probably still running." -ForegroundColor Yellow
        Write-Host "  Close that terminal, or run: Get-Process node | Stop-Process -Force" -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
}

Push-Location $repo
try {
    # --- Emulator preflight ---------------------------------------------
    # Find a running emulator (device id starting with "emulator-").
    $devicesRaw = & $adb devices 2>$null
    $emulator = $devicesRaw |
        Where-Object { $_ -match '^emulator-\d+\s+device$' } |
        ForEach-Object { ($_ -split '\s+')[0] } |
        Select-Object -First 1

    if (-not $emulator) {
        Write-Host ""
        Write-Host "  ERROR: No running emulator found." -ForegroundColor Red
        Write-Host "  Start one from Android Studio's Device Manager, or run:" -ForegroundColor Yellow
        Write-Host "    emulator -list-avds        # see available virtual devices" -ForegroundColor Yellow
        Write-Host "    emulator -avd <name>       # boot one" -ForegroundColor Yellow
        Write-Host "  Then re-run this script." -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
    Write-Host "  Emulator detected: $emulator" -ForegroundColor DarkGray

    # The key fix: bridge the emulator's localhost:8081 to this PC's Metro.
    & $adb -s $emulator reverse tcp:8081 tcp:8081 | Out-Null
    Write-Host "  adb reverse tcp:8081 -> Metro reachable at localhost:8081 inside emulator" -ForegroundColor DarkGray

    # Confirm the dev build is installed; warn (don't fail) if not.
    $installed = & $adb -s $emulator shell pm list packages 2>$null | Select-String $androidPackage
    if (-not $installed) {
        Write-Host ""
        Write-Host "  WARNING: $androidPackage is not installed on this emulator." -ForegroundColor Yellow
        Write-Host "  Build & install it once with:  yarn android" -ForegroundColor Yellow
        Write-Host "  Metro will still start, but there's no app to connect yet." -ForegroundColor Yellow
        Write-Host ""
    }

    # --- Metro hardening (same as mobile script) ------------------------
    # Kill orphaned Metro/Node processes from previous sessions. Ctrl+C in
    # PowerShell doesn't always propagate to child Node processes, leaving
    # zombies that hold file handles on the Metro cache. Those zombies cause
    # "Waiting for Watchman watch-project" hangs and EMFILE errors.
    $nodeProcs = Get-Process node -ErrorAction SilentlyContinue
    if ($nodeProcs) {
        Write-Host "  Killing $($nodeProcs.Count) orphaned node process(es)" -ForegroundColor DarkGray
        $nodeProcs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }

    # Reset Watchman. A stuck Watchman server is the usual cause of the
    # endless "Waiting for Watchman watch-project (Ns)..." loop.
    if (Get-Command watchman -ErrorAction SilentlyContinue) {
        Write-Host "  Resetting Watchman" -ForegroundColor DarkGray
        watchman watch-del-all 2>$null | Out-Null
        watchman shutdown-server 2>$null | Out-Null
    }

    # Wipe the Metro transformer cache before starting. Prevents EMFILE
    # errors caused by cache file accumulation across sessions.
    #
    # RENAME first, delete in the background - never delete in-line. A direct
    # `Remove-Item -Recurse -Force` walks tens of thousands of small files and
    # BLOCKS, and a blocking Remove-Item does not answer Ctrl+C, so the script
    # hangs with no escape but force-closing the terminal (which then orphans a
    # Metro holding port 8081). Same fix as the two dev-start-mobile scripts.
    $metroCache = Join-Path $env:LOCALAPPDATA "Temp\metro-cache"
    if (Test-Path $metroCache) {
        $cacheParent = Split-Path $metroCache -Parent
        $staleName   = "metro-cache-stale-$PID"
        try {
            Rename-Item -Path $metroCache -NewName $staleName -ErrorAction Stop
            Write-Host "  Cleared $metroCache (deleting in background)" -ForegroundColor DarkGray
            Start-Job -ScriptBlock {
                Get-ChildItem $using:cacheParent -Filter 'metro-cache-stale-*' -Directory -ErrorAction SilentlyContinue |
                    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            } | Out-Null
        } catch {
            Write-Host "  (Metro cache is locked by another process; left in place.)" -ForegroundColor DarkYellow
        }
    }

    # Cap Metro's worker count (see dev-start-mobile.ps1 for the full rationale).
    $env:EXPO_METRO_MAX_WORKERS = "2"
    $env:METRO_MAX_WORKERS = "2"

    # The real EMFILE fix on Windows: cap fs.promises concurrency via a
    # semaphore wrapper required into every Metro/worker process.
    #
    # --max-old-space-size=6144 raises Node's heap ceiling to 6 GB. The
    # default on 64-bit is ~4 GB, and bundling this 7000+ module project
    # blows past it on a cold build ("Reached heap limit Allocation failed
    # - JavaScript heap out of memory"). Dev-host limit only; the shipped
    # app runs a pre-built Hermes bundle and never bundles at runtime.
    $env:NODE_OPTIONS = "--require=$repo\.agents\scripts\patch-fs-promises.js --max-old-space-size=6144"

    # Disable Metro lazy bundling (the auto-launch below wants the full bundle).
    #
    # NOTE: the committed `start` npm script sets this inline as
    # `EXPO_NO_METRO_LAZY=1 NODE_OPTIONS=... expo start` - POSIX env-prefix syntax
    # that Windows cmd cannot run ("'EXPO_NO_METRO_LAZY' non e riconosciuto..."),
    # so `yarn start` fails here. We set the env var the PowerShell way and call
    # `yarn start:lazy` (plain `expo start`) below, leaving package.json untouched.
    $env:EXPO_NO_METRO_LAZY = "1"

    # --- Auto-launch the app once Metro is up ---------------------------
    # Metro runs in the foreground (Tee-Object). Spin off a short background
    # job that waits for port 8081 to answer, then fires the dev-client deep
    # link so the app opens and connects without any manual tapping.
    if ($installed) {
        $launchUrl = "$scheme`://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
        Start-Job -ScriptBlock {
            param($adb, $emulator, $pkg, $url)
            for ($i = 0; $i -lt 60; $i++) {
                try {
                    $c = New-Object System.Net.Sockets.TcpClient
                    $c.Connect("127.0.0.1", 8081)
                    $c.Close()
                    break
                }
                catch { Start-Sleep -Seconds 1 }
            }
            # Re-assert the reverse tunnel (survives across adb restarts).
            & $adb -s $emulator reverse tcp:8081 tcp:8081 | Out-Null
            # Force-stop the stale com.quorum build, which also registers the
            # quorummobile:// scheme and would otherwise win an ambiguous launch.
            & $adb -s $emulator shell am force-stop com.quorum | Out-Null
            # Launch the CURRENT build's component explicitly (-n) so the deep
            # link can't resolve to the wrong package.
            & $adb -s $emulator shell am start -n "$pkg/.MainActivity" -a android.intent.action.VIEW -d $url | Out-Null
        } -ArgumentList $adb, $emulator, $androidPackage, $launchUrl | Out-Null
        Write-Host "  App will auto-launch on $emulator when Metro is ready." -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "  Starting Metro (2 workers, fs.promises concurrency capped). Logs -> $logPath" -ForegroundColor Cyan
    Write-Host "  Stop with Ctrl+C. To restart with a clean log: Up arrow, Enter." -ForegroundColor Cyan
    Write-Host "  In the emulator, reload with R,R (or Ctrl+M -> Reload)." -ForegroundColor Cyan
    Write-Host ""
    # start:lazy = plain `expo start` (no inline POSIX env prefix); env vars set above.
    yarn start:lazy --reset-cache --max-workers 2 2>&1 | Tee-Object -FilePath $logPath
}
finally {
    Pop-Location
}
