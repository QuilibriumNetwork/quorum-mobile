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
    # Prime through cmd, not `| Out-Null` - on a COLD adb the forked server
    # inherits PowerShell's capture pipe and holds it open, so the pipeline never
    # returns. See _adb-preflight.ps1 for the full write-up (MEASURED 2026-08-21).
    cmd /c "`"$adb`" start-server >nul 2>&1"
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

    Write-Host ""
    Write-Host "  Starting Metro (2 workers, fs.promises concurrency capped). Logs -> $(Split-Path $logPath -Leaf)" -ForegroundColor Cyan
    # Be honest about the wait, because a wrong estimate is as bad as none.
    #
    # The on-disk cache speeds up module TRANSFORMS, but Metro rebuilds its module
    # graph from scratch on every start, so the first bundle after launching Metro
    # is slow no matter what. MEASURED 2026-08-20 with a fully warm disk cache:
    # 196s. The 6-8s figures seen earlier were reloads against an ALREADY-RUNNING
    # Metro, which is a different thing and must not be quoted as startup cost.
    if ($ResetCache -or -not $cacheWasPresent) {
        $why = if ($ResetCache) { "-ResetCache" } else { "no Metro cache on disk" }
        Write-Host "  COLD ($why): first bundle can take 3-5 minutes." -ForegroundColor Yellow
    } else {
        Write-Host "  Warm disk cache: first bundle still takes ~2-4 minutes." -ForegroundColor Yellow
        Write-Host "  (Metro rebuilds its graph on every start. Reloads after this are seconds.)" -ForegroundColor DarkGray
    }
    Write-Host ""

    # --- Metro runs in the BACKGROUND, this script orchestrates -------------
    #
    # It used to be the other way round: Metro held the foreground and the app
    # launch was a fire-and-forget `Start-Job` that reported nothing. That job was
    # the single remaining source of "it works for one person and not another",
    # for two reasons, BOTH observed in a real failing run on 2026-08-20:
    #
    #   1. It waited for a bare TCP connect on 8081. Metro BINDS the port well
    #      before it can serve a bundle, so the app was fired at a server that
    #      wasn't ready, failed to fetch, and landed on DevLauncherErrorActivity -
    #      the dev-client error screen. Logged at 11:27:08 launch -> 11:27:23
    #      error screen. Pure race, which is exactly why it landed differently on
    #      different runs.
    #   2. It reported neither success nor failure. A later run never launched the
    #      app at all and Metro simply sat idle forever with zero bundle requests,
    #      indistinguishable from a slow build.
    #
    # Foreground orchestration fixes the class, not the instance: we can wait for
    # REAL readiness (/status), verify the app actually came up, retry when it
    # didn't, and say plainly which happened.
    $metroArgs = @('start:lazy', '--max-workers', '2')
    if ($ResetCache) { $metroArgs += '--reset-cache' }

    # -RedirectStandardOutput writes the child's raw UTF-8 bytes straight to disk,
    # which also sidesteps PS 5.1's Tee-Object writing UTF-16LE and making the log
    # unsearchable.
    $errPath   = "$logPath.err"
    $metroProc = Start-Process -FilePath "yarn.cmd" -ArgumentList $metroArgs `
                    -NoNewWindow -PassThru `
                    -RedirectStandardOutput $logPath -RedirectStandardError $errPath

    # --- Wait for Metro to be genuinely ready ------------------------------
    # /status returning "packager-status:running" is the real signal. A TCP
    # connect is not - see the note above.
    # Read /status with WebClient.DownloadString, NOT Invoke-WebRequest.
    #
    # On PowerShell 5.1, `Invoke-WebRequest -UseBasicParsing` hands back .Content as
    # a Byte[] for this response, so `-match 'packager-status:running'` compares
    # against the literal text "112 97 99 107 ..." and can NEVER match. VERIFIED on
    # this box. That would have burned the full 180s timeout and then reported a
    # failure against a perfectly healthy Metro - i.e. a brand new silent hang, of
    # exactly the kind this whole script is meant to stop. DownloadString always
    # returns a string.
    function Test-MetroReady {
        try {
            $wc = New-Object System.Net.WebClient
            return ($wc.DownloadString("http://127.0.0.1:8081/status") -match 'packager-status:running')
        } catch { return $false }
    }

    Write-Host "  Waiting for Metro to be ready..." -ForegroundColor DarkGray -NoNewline
    $metroReady = $false
    for ($i = 0; $i -lt 180; $i++) {
        if ($metroProc.HasExited) { break }
        if (Test-MetroReady) { $metroReady = $true; break }
        if ($i % 5 -eq 4) { Write-Host "." -ForegroundColor DarkGray -NoNewline }
        Start-Sleep -Seconds 1
    }
    Write-Host ""

    if (-not $metroReady) {
        Write-Host ""
        Write-Host "  ERROR: Metro never became ready." -ForegroundColor Red
        if ($metroProc.HasExited) { Write-Host "  The Metro process exited (code $($metroProc.ExitCode))." -ForegroundColor Yellow }
        Write-Host "  Last lines of $(Split-Path $logPath -Leaf):" -ForegroundColor Yellow
        Get-Content $logPath -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
        Get-Content $errPath -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
        exit 1
    }
    Write-Host "  Metro is ready and serving." -ForegroundColor Green

    # --- Pre-build the bundle BEFORE the app asks for it -------------------
    #
    # This is the actual fix for the launches that "randomly" failed.
    # `packager-status:running` only means Metro's HTTP server is up; the bundle
    # does not exist yet and is built on first request. The dev client asks, waits,
    # gives up, and lands on DevLauncherErrorActivity - while Metro carries on
    # building in the background. That is why a later attempt succeeds and why the
    # old fire-once launch worked perhaps one time in three.
    #
    # MEASURED 2026-08-20 before this change: attempts 1 and 2 hit the error screen,
    # attempt 3 succeeded at "Bundled 6853ms" - i.e. it only worked once the build
    # the earlier attempts had triggered was finished.
    #
    # Requesting the bundle from the host first means the app's very first request
    # is served from a finished build. -OutFile avoids materialising ~30 MB of
    # JavaScript as a PowerShell string.
    $bundleUrl = "http://127.0.0.1:8081/index.bundle?platform=android&dev=true&minify=false"
    $warmFile  = Join-Path $env:TEMP "qm-prewarm-$PID.bundle"
    Write-Host "  Pre-building the bundle (so the app never waits on it)." -ForegroundColor DarkGray
    # PowerShell's own download progress overlay is suppressed: we render Metro's
    # real module-count progress below instead, which is the useful number.
    $prevProgressPref = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    $swWarm = [System.Diagnostics.Stopwatch]::StartNew()

    # Download ASYNCHRONOUSLY so the foreground can render Metro's real progress.
    #
    # A blocking Invoke-WebRequest here is what hid the progress bar: Metro runs in
    # the background with stdout going to the log, so while this thread is parked on
    # the download nothing reads that log and the operator sees a frozen screen. The
    # async task lets us poll Metro's own "x% (n/total)" lines out of the log and
    # redraw them on one line, which is the bar you get on a physical device.
    $wcWarm  = New-Object System.Net.WebClient
    $warmTask = $wcWarm.DownloadFileTaskAsync($bundleUrl, $warmFile)

    $progPos  = 0
    $lastPct  = ''
    $warmFail = $null
    while (-not $warmTask.IsCompleted) {
        try {
            $fs = [System.IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
            if ($fs.Length -gt $progPos) {
                $fs.Seek($progPos, 'Begin') | Out-Null
                $sr  = New-Object System.IO.StreamReader($fs)
                $new = $sr.ReadToEnd()
                $progPos = $fs.Length
                $sr.Close()
                # Metro emits e.g. "Android .\index.js  62.5% (7640/12223)". Take the
                # most recent one in this chunk.
                $m = [regex]::Matches($new, '(\d{1,3}(?:\.\d+)?)%\s*\((\d+)/(\d+)\)')
                if ($m.Count -gt 0) { $lastPct = $m[$m.Count - 1] }
            }
            $fs.Close()
        } catch { }

        if ($lastPct) {
            $pct   = [double]$lastPct.Groups[1].Value
            $done  = $lastPct.Groups[2].Value
            $total = $lastPct.Groups[3].Value
            $fill  = [int]([math]::Round($pct / 100 * 30))
            $bar   = ('#' * $fill) + ('-' * (30 - $fill))
            Write-Host ("`r  Bundling [{0}] {1,5:N1}% ({2}/{3})  {4:N0}s   " -f `
                        $bar, $pct, $done, $total, $swWarm.Elapsed.TotalSeconds) -NoNewline -ForegroundColor Cyan
        } else {
            Write-Host ("`r  Starting the bundler... {0:N0}s   " -f $swWarm.Elapsed.TotalSeconds) -NoNewline -ForegroundColor DarkGray
        }

        if ($swWarm.Elapsed.TotalSeconds -gt 600) { $warmFail = "timed out after 600s"; break }
        Start-Sleep -Milliseconds 300
    }
    Write-Host ""   # end the progress line

    $swWarm.Stop()
    if (-not $warmFail -and $warmTask.IsFaulted) {
        $warmFail = $warmTask.Exception.GetBaseException().Message
    }
    if ($warmFail) {
        Write-Host "  Pre-build failed: $warmFail" -ForegroundColor DarkYellow
        Write-Host "  Continuing anyway - the launch retries below can still recover." -ForegroundColor DarkGray
    }
    else {
        $mb = [math]::Round((Get-Item $warmFile).Length / 1MB, 1)
        Write-Host ("  Bundle ready: {0} MB in {1:N0}s." -f $mb, $swWarm.Elapsed.TotalSeconds) -ForegroundColor Green
    }
    Remove-Item $warmFile -Force -ErrorAction SilentlyContinue
    $ProgressPreference = $prevProgressPref

    # --- Launch the app, VERIFY it, retry if it didn't take ----------------
    $launchUrl = "$scheme`://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
    $appUp     = $false

    for ($attempt = 1; $attempt -le 3 -and -not $appUp; $attempt++) {
        Write-Host "  Launching the app (attempt $attempt of 3)..." -ForegroundColor DarkGray

        # Re-assert the reverse tunnel; it does not survive an adb server restart.
        & $adb -s $emulator reverse tcp:8081 tcp:8081 | Out-Null
        # Force-stop BOTH the current build and the legacy com.quorum one, which
        # also registers the quorummobile:// scheme and would win an ambiguous launch.
        & $adb -s $emulator shell am force-stop com.quorum         | Out-Null
        & $adb -s $emulator shell am force-stop $androidPackage    | Out-Null
        Start-Sleep -Seconds 1
        # Clear logcat AFTER the force-stops, immediately before launching.
        # Clearing it earlier let the teardown of the PREVIOUS attempt's error
        # activity land in the buffer, so the next attempt would "detect" an error
        # screen that had already gone - a false failure that burns a retry.
        & $adb -s $emulator logcat -c 2>$null | Out-Null
        # Launch the CURRENT build's component explicitly (-n) so the deep link
        # cannot resolve to the wrong package.
        & $adb -s $emulator shell am start -n "$androidPackage/.MainActivity" `
              -a android.intent.action.VIEW -d $launchUrl | Out-Null

        # Success = the app process is alive AND Metro actually served a bundle.
        # Process-alive alone is not enough: the dev-client error screen is also
        # a live process, and that is precisely the state that used to look fine.
        $deadline = (Get-Date).AddSeconds($(if ($ResetCache -or -not $cacheWasPresent) { 180 } else { 90 }))
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2

            $onErrorScreen = & $adb -s $emulator logcat -d 2>$null |
                Select-String -SimpleMatch 'DevLauncherErrorActivity' -Quiet
            if ($onErrorScreen) {
                Write-Host "  Dev-client error screen detected - the bundle fetch failed. Retrying." -ForegroundColor DarkYellow
                break
            }

            $bundled = Select-String -Path $logPath -Pattern 'Android Bundled \d+ms' -Quiet -ErrorAction SilentlyContinue
            if ($bundled) {
                $proc = & $adb -s $emulator shell pidof $androidPackage 2>$null
                if ($proc) { $appUp = $true; break }
            }
        }
    }

    Write-Host ""
    if ($appUp) {
        $line = (Select-String -Path $logPath -Pattern 'Android Bundled \d+ms.*' -ErrorAction SilentlyContinue |
                 Select-Object -Last 1).Matches.Value
        Write-Host "  READY. App is running on $emulator. $line" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: the app did not come up after 3 attempts." -ForegroundColor Red
        Write-Host "  Metro IS running, so this is a launch problem, not a bundler problem." -ForegroundColor Yellow
        Write-Host "  Check the emulator screen, then see $(Split-Path $logPath -Leaf)." -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Streaming Metro output. Ctrl+C stops Metro and exits." -ForegroundColor Cyan
    Write-Host "  In the emulator, reload with R,R (or Ctrl+M -> Reload)." -ForegroundColor Cyan
    Write-Host ""

    # --- Stream the log to the console until Metro exits or Ctrl+C ---------
    # Replaces the old foreground pipe. Same visible behaviour for the operator.
    $pos = 0
    while (-not $metroProc.HasExited) {
        try {
            $fs = [System.IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
            if ($fs.Length -gt $pos) {
                $fs.Seek($pos, 'Begin') | Out-Null
                $sr = New-Object System.IO.StreamReader($fs)
                $new = $sr.ReadToEnd()
                $pos = $fs.Length
                $sr.Close()
                if ($new) { Write-Host $new -NoNewline }
            }
            $fs.Close()
        } catch { }
        Start-Sleep -Milliseconds 400
    }
}
finally {
    # Never leave an orphaned Metro holding port 8081 - that orphan is what makes
    # the NEXT run look broken, and it holds ~1.6 GB of RAM until something kills it.
    #
    # MUST kill the whole TREE. `Start-Process yarn.cmd` gives us the yarn/cmd
    # wrapper's PID, but the real Metro is a node.exe GRANDCHILD. Stop-Process on
    # the wrapper alone leaves that node alive and still bound to 8081 - OBSERVED
    # 2026-08-20: PID 27804 node.exe still listening, its parent already gone.
    # taskkill /T walks the tree; the port sweep afterwards catches anything that
    # had already been reparented and so was invisible to /T.
    if ($metroProc -and -not $metroProc.HasExited) {
        Write-Host ""
        Write-Host "  Stopping Metro..." -ForegroundColor DarkGray
        & taskkill.exe /PID $metroProc.Id /T /F 2>$null | Out-Null
    }
    Get-NetTCPConnection -State Listen -LocalPort 8081 -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Pop-Location
}
