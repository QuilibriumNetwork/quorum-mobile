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

# Resolve adb. Prefer PATH; fall back to the SDK. ANDROID_HOME is checked before
# %LOCALAPPDATA% because this machine's SDK lives at C:\Android\Sdk, NOT the
# Android Studio default - the old %LOCALAPPDATA%-only fallback silently misses it.
$adb = "adb"
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    $sdkRoots = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA "Android\Sdk")) |
        Where-Object { $_ }
    $sdkAdb = $sdkRoots |
        ForEach-Object { Join-Path $_ "platform-tools\adb.exe" } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
    if ($sdkAdb) {
        $adb = $sdkAdb
    }
    else {
        Write-Host ""
        Write-Host "  ERROR: adb not found on PATH, nor under ANDROID_HOME / %LOCALAPPDATA%\Android\Sdk" -ForegroundColor Red
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
        Write-Host "  ERROR: .agents\reports\metro-log.txt is locked by another process." -ForegroundColor Red
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
    #
    # MUST poll, not ask once. The FIRST `adb devices` after a reboot also STARTS
    # the adb server, and adb answers before that server has finished its scan of
    # the emulator console ports - so it returns an EMPTY list while a perfectly
    # healthy emulator is sitting there. MEASURED 2026-08-18: call #1 listed
    # nothing, call #2 seconds later listed emulator-5554. The old single-shot
    # check turned that race into "ERROR: No running emulator found" and this
    # script refused to run at all.
    & $adb start-server 2>$null | Out-Null
    $emulator = $null
    for ($i = 0; $i -lt 10; $i++) {
        $emulator = & $adb devices 2>$null |
            Where-Object { $_ -match '^emulator-\d+\s+device$' } |
            ForEach-Object { ($_ -split '\s+')[0] } |
            Select-Object -First 1
        if ($emulator) { break }
        Start-Sleep -Seconds 1
    }

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
    #
    # TARGETED, never a blanket `Get-Process node | Stop-Process`. On this box a
    # normal working session has ~50 node.exe processes (MEASURED 2026-08-18: 51,
    # ~4.8 GB) and almost all of them are VS Code language servers and extension
    # hosts. The old blanket kill wiped the editor's brains every single run,
    # which is a large part of why emulator sessions "just behaved weirdly".
    # We only take (a) whoever holds port 8081, and (b) node processes whose
    # command line points at Metro/Expo inside THIS repo.
    $metroPids = @()
    Get-NetTCPConnection -State Listen -LocalPort 8081 -ErrorAction SilentlyContinue |
        ForEach-Object { $metroPids += $_.OwningProcess }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match '(metro|expo)' -and $_.CommandLine -like "*$repo*" } |
        ForEach-Object { $metroPids += $_.ProcessId }
    $metroPids = $metroPids | Sort-Object -Unique
    if ($metroPids) {
        Write-Host "  Killing $($metroPids.Count) stale Metro/Expo node process(es) (editor processes untouched)" -ForegroundColor DarkGray
        $metroPids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
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
            # Unexpanded on purpose - $metroCache runs through the user profile and
            # this output is mirrored to a log file. See dev-start-mobile.ps1.
            Write-Host "  Cleared %LOCALAPPDATA%\Temp\metro-cache (deleting in background)" -ForegroundColor DarkGray
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

    # THE fix that made the emulator work at all (root-caused 2026-08-18).
    #
    # This machine carries a PERSISTENT Windows *user* environment variable
    # REACT_NATIVE_PACKAGER_HOSTNAME=<pc-lan-ip>, set long ago for Wi-Fi work on a
    # physical phone. Metro reads it and advertises that LAN address as the bundle
    # URL, so the dev client ignored whatever URL we deep-linked and fetched the
    # bundle from the LAN IP instead. From inside the emulator that route goes out
    # through the emulator's NAT and back to the host's own LAN address, and the
    # chunked multipart bundle response gets mangled on the way:
    #
    #   java.net.ProtocolException: Expected leading [0-9a-fA-F] character but was 0xd
    #     at okhttp3.internal.http1.Http1ExchangeCodec$ChunkedSource.readChunkSize
    #     at com.facebook.react.devsupport.BundleDownloader.processMultipartResponse
    #
    # RN logs that at INFO level and shows nothing on screen, so the app just sat
    # on "Bundling 100.0%..." forever with no visible error. That is the freeze
    # that made every previous emulator attempt look unexplainable, and it is why
    # `pm clear` never helped - the address was never in the app, it was here.
    #
    # Forcing "localhost" sends the bundle over the `adb reverse` tunnel set up
    # above, which bypasses the emulator's NAT entirely. MEASURED after this
    # change: bundle downloads clean, zero ProtocolException, app renders.
    # Same lever as dev-start-mobile.ps1; only this script was missing it.
    $env:REACT_NATIVE_PACKAGER_HOSTNAME = "localhost"

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
    Write-Host "  Starting Metro (2 workers, fs.promises concurrency capped). Logs -> .agents\reports\metro-log.txt" -ForegroundColor Cyan
    Write-Host "  Stop with Ctrl+C. To restart with a clean log: Up arrow, Enter." -ForegroundColor Cyan
    Write-Host "  In the emulator, reload with R,R (or Ctrl+M -> Reload)." -ForegroundColor Cyan
    Write-Host ""
    # start:lazy = plain `expo start` (no inline POSIX env prefix); env vars set above.
    yarn start:lazy --reset-cache --max-workers 2 2>&1 | Tee-Object -FilePath $logPath
}
finally {
    Pop-Location
}
