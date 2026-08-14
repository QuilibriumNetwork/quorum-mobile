# Start Metro for a PHYSICAL MOBILE DEVICE with a fresh log file.
# Run this every time you start a debug session on a real phone (QR / LAN).
# For the Android emulator, use dev-start-emulator.ps1 instead.
#
# Usage (from the repo root terminal):
#   .\.agents\scripts\dev-start-mobile.ps1              # normal, warm cache (fast)
#   .\.agents\scripts\dev-start-mobile.ps1 -ResetCache  # after a babel/metro.config change
#
# The app auto-opens on the phone ONCE THE BUNDLE FINISHES BUILDING. On a cold
# start (or with -ResetCache) the first build is ~2.5 min. Do NOT open the app
# yourself before then, or it times out (SocketTimeoutException).
#
# Between test iterations:
#   1. Press Ctrl+C in this terminal to stop Metro.
#   2. Press Up arrow then Enter to re-run this script.
#   3. On mobile: shake -> Reload.
param(
    [switch]$ResetCache,
    # Force a specific adb device serial (e.g. -s <device-1-serial>, adb-style; the
    # long form -Serial also works). Only needed when two USB phones are
    # plugged in at once; otherwise auto-detected.
    [Alias('s')]
    [string]$Serial
)

. "$PSScriptRoot\_env.ps1"

# A serial pinned in .env.local is a PREFERENCE, not a requirement - it is just
# the phone you happened to use last. Keep it out of $Serial: assigning it there
# made the script demand that exact phone, so swapping the cable to the other
# device made it wait 45 s for an absent phone and give up while a healthy one
# sat unused (2026-08-14). Explicit -Serial still means "this phone or nothing".
# Read here rather than as a param default: defaults bind BEFORE the script body,
# so _env.ps1 has not loaded .env.local at that point.
$preferredSerial = $env:QM_DEVICE_1

$logPath = Join-Path $repo ".agents\reports\metro-log.txt"

# Make sure the reports folder exists
$reportsDir = Split-Path $logPath -Parent
if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
}

# Wipe old log (force, ignore if missing or locked)
Remove-Item $logPath -Force -ErrorAction SilentlyContinue

Push-Location $repo
try {
    # Reclaim ONLY orphaned Metro from a previous crashed/closed session.
    #
    # Metro on this project crashes under RAM pressure; when it does, its
    # jest-workers (each ~600-770 MB) can survive as orphans and just sit there
    # eating RAM. The old code here ran `Get-Process node | Stop-Process` - a
    # blunt hammer that ALSO killed every unrelated node (MCP servers, a running
    # `tsc`, other dev servers, VS Code's own node helpers). metro-status.ps1
    # -Kill surgically kills only orphaned Metro/Expo trees for THIS repo and
    # leaves everything else alone. We do NOT pass -All, so a Metro you have
    # running in another terminal is left untouched.
    $metroStatus = Join-Path $repo ".agents\scripts\metro-status.ps1"
    if (Test-Path $metroStatus) {
        & $metroStatus -Kill | Out-Null
    } else {
        # Fallback to the old blunt kill if the helper is missing.
        $nodeProcs = Get-Process node -ErrorAction SilentlyContinue
        if ($nodeProcs) {
            Write-Host "  Killing $($nodeProcs.Count) node process(es) (metro-status.ps1 not found)" -ForegroundColor DarkGray
            $nodeProcs | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }

    # Wipe the Metro transformer cache before starting.
    #
    # RENAME first, delete in the background - never delete in-line. A direct
    # `Remove-Item -Recurse -Force` here walks tens of thousands of small files
    # and BLOCKS, and a blocking Remove-Item does not answer Ctrl+C. That is the
    # "hangs forever right after 'No Metro/Expo node processes'" symptom
    # (reported 2026-08-13). Escaping it by force-closing the terminal does NOT
    # reliably kill the node tree, so an orphaned Metro survives holding port
    # 8081 - which makes the NEXT run drift to port 8288 and silently break the
    # `adb reverse` bridge. One blocking delete, three downstream failures.
    #
    # A rename is a single metadata operation (instant on the same volume) and
    # fails fast when a handle is still held, so we skip instead of blocking.
    $metroCache = Join-Path $env:LOCALAPPDATA "Temp\metro-cache"
    if (Test-Path $metroCache) {
        $cacheParent = Split-Path $metroCache -Parent
        $staleName   = "metro-cache-stale-$PID"
        try {
            Rename-Item -Path $metroCache -NewName $staleName -ErrorAction Stop
            # Print the UNEXPANDED path: $metroCache resolves through the Windows
            # user profile, and this console output is mirrored into
            # reports/metro-log.txt, so expanding it writes the account name into
            # a file. Keep the operator's name out of logs entirely.
            Write-Host "  Cleared %LOCALAPPDATA%\Temp\metro-cache (deleting in background)" -ForegroundColor DarkGray
            Start-Job -ScriptBlock {
                # This run's cache, plus any left by a previous run that was
                # killed before its background delete finished.
                Get-ChildItem $using:cacheParent -Filter 'metro-cache-stale-*' -Directory -ErrorAction SilentlyContinue |
                    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            } | Out-Null
        } catch {
            Write-Host "  (Metro cache is locked by another process; left in place.)" -ForegroundColor DarkYellow
        }
    }

    # --- Port preflight ---------------------------------------------------------
    # Everything downstream must agree on ONE port: `adb reverse tcp:N tcp:N`, the
    # dev-client deep link, and Metro itself. When 8081 is unusable Expo does not
    # fail - it asks "Use port 8288 instead?" and auto-answers yes, serving the
    # bundle on a port the phone has no route to. The run then dies with a
    # SocketTimeout or a misleading "No development build is installed".
    #
    # MEASURED 2026-08-13: the reason 8081 was unusable was NOT a leftover Metro.
    # Binding it failed with EACCES while netstat showed no listener, because
    # Windows had reserved 7988-8087 (Hyper-V/WSL grab blocks at boot, and the
    # blocks move between boots - hence "it worked for months, today it doesn't").
    # Resolve-QmMetroPort tests bindability, explains which case it hit, and
    # falls back to a port that actually works. $port then flows everywhere.
    . (Join-Path $PSScriptRoot '_adb-preflight.ps1')
    $port = Resolve-QmMetroPort -Preferred 8081
    if ($port -eq 0) {
        Write-Host "  Cannot start Metro without a bindable port. See the note above." -ForegroundColor Red
        exit 1
    }

    # Cap Metro's worker count. Default is (cpus - 1); on a many-core
    # Windows box this spawns enough parallel file-open requests to hit
    # the per-process file-descriptor ceiling on a large project (16k+
    # modules). Capping at 2 keeps bundling fast while staying well
    # under the limit. Setting all known names so it works across
    # Expo/Metro versions.
    $env:EXPO_METRO_MAX_WORKERS = "2"
    $env:METRO_MAX_WORKERS = "2"
    # Expo CLI flag (passed below as --max-workers 2)

    # The real EMFILE fix on Windows: cap fs.promises concurrency.
    #
    # Node 22 on Windows has a hard 8192 CRT file-descriptor ceiling. Metro's
    # metro-cache FileStore uses fs.promises (NOT the callback fs that
    # graceful-fs patches), and DeltaBundler's buildSubgraph fans out with
    # unbounded Promise.all. On a 16k-module project this trivially blows
    # past 8192 simultaneous opens, especially on cold cache.
    #
    # patch-fs-promises.js wraps fs.promises in a semaphore (max 200 in
    # flight, retries on EMFILE). The Metro process and every worker
    # inherits this via NODE_OPTIONS.
    #
    # --max-old-space-size=4096 caps Node's heap at 4 GB. In practice Metro for
    # this project peaks ~1.5 GB; the workers do the heavy lifting in their own
    # processes. The old 6144 just GAVE node room to balloon, which on a machine
    # that's already near full (32 GB, often <3 GB free with VS Code + Brave +
    # Android Studio running) starves everything else and triggers the OOM
    # crashes that then orphan the workers. 4 GB is comfortably above the real
    # peak and fails fast+clean instead of dragging the whole OS into swap.
    # Bump back toward 6144 ONLY if you actually hit "Reached heap limit" on a
    # cold build. Dev-host limit only; the shipped app runs a pre-built Hermes
    # bundle and never bundles at runtime.
    $env:NODE_OPTIONS = "--require=$repo\.agents\scripts\patch-fs-promises.js --max-old-space-size=4096"

    # Disable Metro lazy bundling so the FULL bundle builds before the app opens
    # (the auto-launch below waits for /index.bundle to return 200 - lazy bundling
    # would defer modules and break that contract).
    #
    # NOTE: the committed `start` npm script sets this inline as
    # `EXPO_NO_METRO_LAZY=1 NODE_OPTIONS=... expo start` - POSIX env-prefix syntax
    # that Windows cmd cannot run ("'EXPO_NO_METRO_LAZY' non e riconosciuto..."),
    # so `yarn start` fails here. We set the env var the PowerShell way and call
    # `yarn start:lazy` (plain `expo start`) instead, leaving package.json untouched.
    $env:EXPO_NO_METRO_LAZY = "1"

    # Force Expo to advertise localhost:8081 everywhere, including the "press a"
    # dev-client deep link. Without this, Expo opens the app pointed at the PC's
    # LAN IP (192.168.x.x), which is unreachable here (Metro binds IPv6-only),
    # so the device shows "Unable to load script". With localhost, the app loads
    # through the USB `adb reverse` bridge. (The `--localhost` CLI flag alone is
    # NOT enough - it does not override the deep-link URL used by "press a".)
    $env:REACT_NATIVE_PACKAGER_HOSTNAME = "localhost"

    # --- USB device preflight (the part the old script was missing) ---------
    # The Expo dev client on a physical phone fetches the bundle from the PC's
    # LAN IP and defaults to it. On this Windows box that LAN IP is unreachable
    # (firewall + Metro IPv6-only bind), so the app shows "Unable to load
    # script". The reliable route is USB: `adb reverse tcp:8081 tcp:8081` makes
    # the phone's localhost:8081 tunnel to Metro on the PC (127.0.0.1, which
    # answers). We set the bridge here, and auto-launch the app at localhost
    # once Metro is up, so there's nothing to do by hand on the phone.
    $androidPackage = "com.quilibrium.quorummobile.debug"
    $scheme = "quorummobile"

    # --- Auto-heal + pick the cabled phone ------------------------------------
    # Resolve-QmUsbDevice waits out an unauthorized/absent phone with actionable
    # instructions, then - once the cable is confirmed healthy - discards every
    # stray Wi-Fi endpoint whatever its state, and pins ANDROID_SERIAL.
    # See _adb-preflight.ps1 for the failure this exists to stop.
    # (Already dot-sourced above for the port preflight.)
    $target = Resolve-QmUsbDevice -Serial $Serial -Preferred $preferredSerial
    $adb    = if ($target) { $target.Adb } else { (Get-QmAdb) }
    $device = if ($target) { $target.Serial } else { $null }

    $skipAutoLaunch = $false

    if ($device) {
        & $adb -s $device reverse "tcp:$port" "tcp:$port" | Out-Null
        Write-Host "  USB device $device : adb reverse tcp:$port set (phone localhost -> Metro)" -ForegroundColor DarkGray

        # SAFETY: the debug app MUST be installed before we try to launch it.
        # If com.quilibrium.quorummobile.debug is missing, the quorummobile://
        # deep link resolves to the only app that registers that scheme - the
        # user's REAL app (com.quilibrium.quorummobile) - and we'd silently open
        # production instead. Verify the .debug package exists; if not, refuse to
        # auto-launch and tell the user to build it first. NEVER fall through to
        # the real app.
        $pkgList = & $adb -s $device shell pm list packages $androidPackage 2>$null
        $debugInstalled = $pkgList -match "package:$androidPackage"
        if (-not $debugInstalled) {
            Write-Host ""
            Write-Host "  ERROR: $androidPackage is NOT installed on the phone." -ForegroundColor Red
            Write-Host "  Refusing to auto-launch - the deep link would open your REAL app instead." -ForegroundColor Red
            Write-Host "  Build and install the debug app first:  .\.agents\scripts\build-app.ps1" -ForegroundColor Yellow
            Write-Host "  Metro will still start so the build can use it; just don't expect auto-open." -ForegroundColor Yellow
            Write-Host ""
            $skipAutoLaunch = $true
        }

        # Auto-launch the app at localhost once the BUNDLE IS BUILT. Runs in a
        # background job so it doesn't block the interactive Metro console.
        #
        # Critical: we wait for /index.bundle to return 200, NOT just for the
        # port to open. The first cold build takes ~2.5 min; if the app loads
        # before the bundle is ready, its HTTP client times out
        # (SocketTimeoutException) and shows "Unable to load script". Waiting for
        # an actual 200 from the bundle endpoint guarantees the app only opens
        # once there's something to serve it instantly.
        if (-not $skipAutoLaunch) {
            $launchUrl    = "$scheme`://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$port"
            $autoLaunchLog = Join-Path $repo ".agents\reports\autolaunch-log.txt"
            Start-Job -ScriptBlock {
                param($adb, $device, $pkg, $url, $port, $logFile)

                # Everything here runs in a background runspace whose output nobody
                # ever reads, so an unlogged failure is INVISIBLE - the app just
                # doesn't open and there is nothing to look at. Hence this log.
                function Note($msg) {
                    "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg |
                        Add-Content -Path $logFile -Encoding utf8 -ErrorAction SilentlyContinue
                }
                Set-Content -Path $logFile -Value '' -ErrorAction SilentlyContinue
                Note "waiting for the bundle on port $port"

                # GET, not HEAD. Metro builds the bundle in response to the request
                # and answers GET with 200; a HEAD is not reliably answered the same
                # way, and the old code only ever broke out of this loop on a 200 -
                # so when HEAD did not give one it burned the whole 6-minute budget
                # before launching. That is the "sometimes it just doesn't open"
                # case. Over loopback the body is cheap.
                $ready = $false
                for ($i = 0; $i -lt 72; $i++) {
                    try {
                        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/index.bundle?platform=android&dev=true" `
                                               -Method Get -TimeoutSec 300 -UseBasicParsing
                        if ($r.StatusCode -eq 200) { $ready = $true; Note "bundle ready (HTTP 200)"; break }
                        Note "bundle not ready (HTTP $($r.StatusCode))"
                    } catch {
                        if ($i % 6 -eq 0) { Note "waiting... ($($_.Exception.Message))" }
                    }
                    Start-Sleep -Seconds 5
                }
                if (-not $ready) { Note "gave up waiting for a 200; launching anyway" }

                # Re-assert the bridge (survives adb daemon restarts) and clear the
                # dev launcher's cached error state so it doesn't bounce straight to
                # the error screen, then launch at localhost. The `-d $url $pkg`
                # form constrains the deep link to the .debug package explicitly,
                # so it can never resolve to the real app even if both register
                # the quorummobile:// scheme.
                & $adb -s $device reverse "tcp:$port" "tcp:$port" 2>&1 | Out-Null
                & $adb -s $device shell am force-stop $pkg 2>&1 | Out-Null

                # Launch, then VERIFY - `am start` exits 0 even when the activity
                # never came up, so its exit code proves nothing. Check for a live
                # pid instead, and retry: a cold dev client occasionally loses the
                # first intent while it is still initialising.
                for ($attempt = 1; $attempt -le 3; $attempt++) {
                    $out = & $adb -s $device shell am start -a android.intent.action.VIEW -d $url $pkg 2>&1
                    Start-Sleep -Seconds 3
                    $livePid = (& $adb -s $device shell pidof $pkg 2>$null | Out-String).Trim()
                    if ($livePid) { Note "launched OK on attempt $attempt (pid $livePid)"; break }
                    Note "attempt $attempt did not start the app: $out"
                    if ($attempt -eq 3) {
                        Note "AUTO-LAUNCH FAILED - press 'a' in the Metro window, or open the app by hand."
                    }
                }
            } -ArgumentList $adb, $device, $androidPackage, $launchUrl, $port, $autoLaunchLog | Out-Null
            Write-Host "  App will auto-open AFTER the bundle finishes building (~2.5 min on a cold start)." -ForegroundColor DarkGray
            Write-Host "  >> Do NOT open the app yourself before then, or it will time out. <<" -ForegroundColor Yellow
            # Print the path RELATIVE to the repo. $autoLaunchLog is derived from
            # $repo (never hardcoded), but echoing it absolute puts a machine-
            # specific path into the console and into metro-log.txt. Repo-relative
            # is also the form that still makes sense if the repo ever moves - a
            # drive move (D: -> E:) has already caused one hard-to-find bug here.
            Write-Host "  If it does NOT open, press 'a' - and see why in:" -ForegroundColor DarkGray
            Write-Host "  .agents\reports\autolaunch-log.txt" -ForegroundColor DarkGray
        }
    }
    else {
        # Resolve-QmUsbDevice already printed the specific diagnosis (unauthorized,
        # absent, offline, or adb missing) plus what to do about it. Metro still
        # starts, so plugging the phone in and pressing 'a' recovers without a
        # restart - but nothing is auto-launched, since we have no device to pin to.
        Write-Host "  Continuing without a phone: Metro will start anyway." -ForegroundColor Yellow
        Write-Host "  Fix the device above, then Ctrl+C and re-run this script." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "  Starting Metro (2 workers, fs.promises concurrency capped)." -ForegroundColor Cyan
    Write-Host "  This window is INTERACTIVE: press 'a' to build the bundle, 'r' to reload, Ctrl+C to stop." -ForegroundColor Cyan
    # About 'a': it does TWO things, and only the second one fails here.
    #   1. It makes the dev client request /index.bundle, which is what actually
    #      kicks Metro into bundling. This is useful - Metro builds on demand, so
    #      pressing 'a' is a legitimate way to start the build immediately.
    #   2. It then tries to LAUNCH com.quilibrium.quorummobile, the app id Expo
    #      derives from app.json. But build-app.ps1 installs the dev build with
    #      Gradle's sideBySide applicationIdSuffix, as
    #      com.quilibrium.quorummobile.debug - so the base id is deliberately
    #      never installed and step 2 always reports
    #      "No development build (com.quilibrium.quorummobile) ... is installed".
    # That error is EXPECTED NOISE, not a broken build. The auto-launch job above
    # opens the correct .debug package once the bundle is served.
    Write-Host "  ('a' may then say 'No development build ... is installed' - expected," -ForegroundColor DarkGray
    Write-Host "   it looks for the non-.debug id. The script opens the right app itself.)" -ForegroundColor DarkGray
    Write-Host "  Logs are mirrored to: .agents\reports\metro-log.txt" -ForegroundColor Cyan
    Write-Host ""
    # Expo sits silently on 'Starting project at...' for ~15-25s on a cold start
    # (config + dependency resolution) BEFORE it prints 'Starting Metro Bundler'.
    # Without this note that silence reads as a hang and gets Ctrl+C'd - which
    # then leaves a dirty transcript (see the Stop-Transcript guard below) and
    # makes the NEXT run look hung too. So: warn, and don't kill it early.
    Write-Host "  NOTE: Expo can sit on 'Starting project at...' for 15-25s before the menu appears." -ForegroundColor DarkYellow
    Write-Host "        That is NOT a hang - wait for the 'a/r' menu. Do not Ctrl+C during this window." -ForegroundColor DarkYellow
    Write-Host ""

    # --localhost makes Expo advertise localhost:8081 instead of the PC's LAN IP.
    # The phone then loads the bundle through the USB `adb reverse` bridge
    # (phone localhost -> PC 127.0.0.1), which is reliable. The LAN-IP default
    # fails here because Metro binds IPv6-only and the IPv4 LAN address doesn't
    # answer, producing "Unable to load script" / SocketTimeout on the device.
    #
    # Log capture: use Start-Transcript, NOT a pipe. Tee-Object/`> file` sit in a
    # pipe and consume stdin, which kills the Expo CLI keypress menu (a=Android,
    # r=reload). Start-Transcript hooks the console host's output stream instead,
    # so it writes everything to $logPath while stdin stays free and Metro runs
    # interactively in the foreground.
    # Clear any transcript left "running" by a previous run that was Ctrl+C'd
    # (Ctrl+C while Metro is in the foreground can skip this script's `finally`
    # Stop-Transcript). A dirty transcript makes the NEXT Start-Transcript in
    # the same terminal tab throw or stall, which is the classic "the script
    # hangs / produces no log after re-running" symptom. Stop-Transcript with
    # no active transcript just throws a benign error we swallow.
    try { Stop-Transcript | Out-Null } catch { }
    $transcriptOn = $false
    try {
        Start-Transcript -Path $logPath -Force | Out-Null
        $transcriptOn = $true
    } catch {
        Write-Host "  (Could not start transcript; Metro will still run, just no log file.)" -ForegroundColor DarkYellow
    }

    # No --reset-cache by default: it forces a full ~2.5-min cold rebuild EVERY
    # run, which is the main cause of the "open the app, hit SocketTimeout"
    # trap. The cache is only stale after a babel/metro.config change - for that
    # case run the script with -ResetCache. Normal runs reuse the warm cache and
    # bundle in seconds.
    $resetFlag = if ($ResetCache) { '--reset-cache' } else { '' }
    # start:lazy = plain `expo start` (no inline POSIX env prefix); env vars set above.
    # --port is explicit so Metro cannot end up somewhere the adb bridge and the
    # deep link are not pointing. The preflight above already guaranteed it free.
    yarn start:lazy --max-workers 2 --localhost --port $port $resetFlag
}
finally {
    if ($transcriptOn) { Stop-Transcript | Out-Null }
    Pop-Location
}
