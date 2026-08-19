# Start Metro for the ANDROID EMULATOR with a fresh log file.
# Run this every time you start a debug session on the emulator.
# For a physical phone (QR / LAN), use dev-start-mobile.ps1 instead.
#
# Usage (from the repo root terminal):
#   .\.agents\scripts\dev-start-emulator.ps1                # warm cache, ~10s to first bundle
#   .\.agents\scripts\dev-start-emulator.ps1 -ResetCache    # cold rebuild, ~75s
#
# The emulator must already be RUNNING and past its home screen. This script does
# not boot one - build-emulator.ps1 does that. If the app isn't installed on the
# emulator, this stops with an error rather than starting a Metro with nothing
# attached to it.
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

param(
    # Throw away Metro's transformer cache and rebuild the bundle from scratch.
    #
    # OFF BY DEFAULT, deliberately. This used to be hardcoded on, and it is the
    # single biggest reason emulator runs "felt hung": MEASURED 2026-08-19 on this
    # project, cold bundle 75.6s vs warm 7.2s - a 10x tax paid on EVERY run, during
    # which the terminal prints nothing at all. Silence that long is indistinguishable
    # from a crash, so a genuinely working run looked broken.
    #
    # Use it only when Metro is serving stale code: after a dep change, a
    # metro.config.js/babel.config.js edit, or a branch switch that alters
    # node_modules. A normal JS/TS edit does NOT need it - fast refresh handles that.
    [switch]$ResetCache
)

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

# Kill orphaned Metro/Node processes from previous sessions. Ctrl+C in PowerShell
# doesn't always propagate to child Node processes, leaving zombies that hold file
# handles on the Metro cache AND on the log file below. Those zombies cause
# "Waiting for Watchman watch-project" hangs and EMFILE errors.
#
# TARGETED, never a blanket `Get-Process node | Stop-Process`. On this box a normal
# working session has ~50 node.exe processes (MEASURED 2026-08-18: 51, ~4.8 GB) and
# almost all of them are VS Code language servers and extension hosts. The old
# blanket kill wiped the editor's brains every single run. We take only (a) whoever
# holds port 8081, and (b) node processes whose command line points at Metro/Expo
# inside THIS repo.
#
# RUNS BEFORE THE LOG HANDLING, deliberately. It used to run much later, so a stale
# Metro still holding metro-log.txt made the script exit at the lock check below -
# BEFORE reaching the code that would have killed that very process. The script
# could not recover from a state it already knew how to fix, and its error text
# then recommended the blanket kill. OBSERVED 2026-08-19.
function Stop-StaleMetro {
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
        Start-Sleep -Milliseconds 800
    }
}
Stop-StaleMetro

# Make sure the reports folder exists
$reportsDir = Split-Path $logPath -Parent
if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
}

# Wipe old log (force, ignore if missing or locked)
Remove-Item $logPath -Force -ErrorAction SilentlyContinue

# If something STILL holds the log open after the kill above, fall back to a
# per-run log file rather than refusing to start. A locked log file is a trivial
# problem and must never be the reason a dev session can't begin - the previous
# behaviour was `exit 1`, which turned a stale file handle into a hard blocker.
$logLocked = $false
if (Test-Path $logPath) {
    try {
        $fs = [System.IO.File]::Open($logPath, 'Open', 'ReadWrite', 'None')
        $fs.Close()
        Remove-Item $logPath -Force -ErrorAction SilentlyContinue
    }
    catch { $logLocked = $true }
}
if ($logLocked) {
    $logPath = Join-Path $reportsDir ("metro-log-{0}.txt" -f $PID)
    Write-Host "  metro-log.txt is still locked; logging to $(Split-Path $logPath -Leaf) instead." -ForegroundColor DarkYellow
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

    # Confirm the dev build is installed.
    #
    # MUST wait for the package manager first. `pm list packages` answers with an
    # EMPTY list for a while after boot, before PackageManager is serving queries -
    # so asking too early reports "not installed" for an app that is installed.
    # That false negative is not cosmetic: $installed gates the auto-launch below,
    # so the script would start Metro and then deliberately do nothing, forever,
    # with no error. OBSERVED 2026-08-19 on a freshly booted emulator: run #1 said
    # "not installed" and never launched; run #2 seconds later found it fine.
    # That is the whole reason emulator runs "hang for no reason".
    #
    # Probe for ANY package to prove PM is up, then look for ours.
    $pmReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        $pkgList = & $adb -s $emulator shell pm list packages 2>$null
        if ($pkgList -and ($pkgList | Where-Object { $_ -match '^package:' })) {
            $pmReady = $true
            break
        }
        if ($i -eq 0) { Write-Host "  Waiting for the emulator's package manager..." -ForegroundColor DarkGray }
        Start-Sleep -Seconds 1
    }
    $installed = $pmReady -and ($pkgList | Select-String -SimpleMatch $androidPackage)

    if (-not $pmReady) {
        Write-Host ""
        Write-Host "  ERROR: the emulator's package manager never answered (30s)." -ForegroundColor Red
        Write-Host "  The emulator is probably still booting. Wait for the home screen, then re-run." -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
    if (-not $installed) {
        # Hard stop, NOT a warning. Without the app there is nothing to auto-launch,
        # so continuing just produces a silent Metro that looks like a hang. The old
        # code printed a warning and carried on, which is how that silence happened.
        Write-Host ""
        Write-Host "  ERROR: $androidPackage is not installed on $emulator." -ForegroundColor Red
        Write-Host "  Install it once with:   .\.agents\scripts\build-emulator.ps1" -ForegroundColor Yellow
        Write-Host "  Then re-run this script." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  (Not starting Metro - there would be nothing to connect to it.)" -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
    Write-Host "  Dev build present: $androidPackage" -ForegroundColor DarkGray

    # --- Metro hardening (same as mobile script) ------------------------
    # (Stale Metro/Expo processes were already killed near the top, before the log
    # file was touched - see Stop-StaleMetro and the note about ordering there.)

    # Reset Watchman. A stuck Watchman server is the usual cause of the
    # endless "Waiting for Watchman watch-project (Ns)..." loop.
    if (Get-Command watchman -ErrorAction SilentlyContinue) {
        Write-Host "  Resetting Watchman" -ForegroundColor DarkGray
        watchman watch-del-all 2>$null | Out-Null
        watchman shutdown-server 2>$null | Out-Null
    }

    # Wipe the Metro transformer cache. ONLY under -ResetCache.
    #
    # This used to run unconditionally, which made -ResetCache impossible to opt
    # out of: even without `--reset-cache` on the command line, the cache dir was
    # already gone, so Metro printed "Bundler cache is empty, rebuilding" and paid
    # the full 75.6s cold build EVERY run (vs 7.2s warm). Two independent
    # mechanisms were forcing cold builds; this was the one that actually bit.
    #
    # The justification was "prevents EMFILE errors from cache accumulation", but
    # the REAL EMFILE fix is the fs.promises concurrency cap set below (this
    # script's own comment says so). Wiping the cache is belt-and-braces on top of
    # it, and a 10x slowdown on every single run is far too high a price for that.
    #
    # RENAME first, delete in the background - never delete in-line. A direct
    # `Remove-Item -Recurse -Force` walks tens of thousands of small files and
    # BLOCKS, and a blocking Remove-Item does not answer Ctrl+C, so the script
    # hangs with no escape but force-closing the terminal (which then orphans a
    # Metro holding port 8081). Same fix as the two dev-start-mobile scripts.
    $metroCache = Join-Path $env:LOCALAPPDATA "Temp\metro-cache"
    # Record the REAL cache state, so the timing hint below reports what will
    # actually happen rather than just echoing the switch. Without this the script
    # said "Warm cache, expect ~10s" and then took 94s, because the cache had been
    # wiped by an earlier run - misleading feedback is worse than none.
    $cacheWasPresent = Test-Path $metroCache
    if ($ResetCache -and $cacheWasPresent) {
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

    # SAY HOW LONG THE SILENCE WILL LAST. Metro prints nothing at all while it
    # bundles, and this project takes 75.6s cold / 7.2s warm (MEASURED 2026-08-19).
    # Without this line there is no way to tell a working run from a dead one, which
    # is exactly how working runs got Ctrl+C'd and reported as hangs.
    if ($ResetCache -or -not $cacheWasPresent) {
        $why = if ($ResetCache) { "-ResetCache" } else { "no Metro cache on disk" }
        Write-Host "  COLD build ($why). Expect 90-120s of NO OUTPUT before 'Android Bundled ...'." -ForegroundColor Yellow
        Write-Host "  MEASURED on this project: 93.9s for 12209 modules, slower under load." -ForegroundColor DarkGray
    } else {
        Write-Host "  Warm cache. Expect ~10-20s of no output, then 'Android Bundled ...'." -ForegroundColor Green
        Write-Host "  (Serving stale code? Re-run with -ResetCache.)" -ForegroundColor DarkGray
    }
    Write-Host "  Silence until that line is NORMAL. It is not a hang. Don't Ctrl+C." -ForegroundColor DarkGray
    Write-Host ""

    # start:lazy = plain `expo start` (no inline POSIX env prefix); env vars set above.
    $metroArgs = @('start:lazy', '--max-workers', '2')
    if ($ResetCache) { $metroArgs += '--reset-cache' }

    # Write the log as UTF-8, NOT via Tee-Object.
    #
    # PowerShell 5.1's Tee-Object has no -Encoding parameter and writes UTF-16LE
    # (VERIFIED on this box: PS 5.1.26100, Tee-Object exposes no Encoding param).
    # Every tool that later reads metro-log.txt - grep, ripgrep, an agent - then
    # sees "S t a r t i n g   M e t r o" and finds nothing. That silently breaks
    # the "read the teed log instead of asking a human to watch the console"
    # workflow. Out-File -Encoding utf8 keeps the console output identical while
    # making the file actually greppable.
    yarn @metroArgs 2>&1 | ForEach-Object {
        $_
        $_ | Out-File -FilePath $logPath -Append -Encoding utf8
    }
}
finally {
    Pop-Location
}
