# Start Metro for a PHYSICAL MOBILE DEVICE over Wi-Fi / LAN (NO USB CABLE).
#
# Use this when you want to develop without a cable. The phone fetches the JS
# bundle from this PC's LAN IP (e.g. http://<pc-lan-ip>:8081) over Wi-Fi.
# For the cable-bound, rock-solid path use dev-start-mobile.ps1 (adb reverse).
# For the Android emulator, use dev-start-emulator.ps1.
#
# REQUIREMENTS for the Wi-Fi path to work on THIS machine:
#   1. Phone and PC on the SAME Wi-Fi network (no "AP isolation" / guest mode).
#   2. Inbound TCP 8081 allowed through Windows Firewall. This script ensures
#      the rule exists (re-using allow-metro-firewall.ps1's rule name); if it's
#      missing it tells you to run that script once (it self-elevates to admin).
#   3. VPN OFF while coding. A VPN reroutes/blocks phone<->PC LAN traffic, so
#      the bundle request never arrives. Kill the VPN before running this.
#
# Why a separate script (and not just the USB one minus the cable):
#   dev-start-mobile.ps1 FORCES localhost (REACT_NATIVE_PACKAGER_HOSTNAME and
#   --localhost) precisely to push traffic through the USB `adb reverse` bridge,
#   because on this box Metro otherwise binds IPv6-only and the IPv4 LAN address
#   is dead. This script does the opposite: it pins Metro to the real IPv4 LAN
#   IP so the phone can reach it over Wi-Fi.
#
# Usage (from the repo root terminal):
#   .\.agents\scripts\dev-start-mobile-wifi.ps1               # warm cache (fast)
#   .\.agents\scripts\dev-start-mobile-wifi.ps1 -ResetCache   # after babel/metro.config change
#   .\.agents\scripts\dev-start-mobile-wifi.ps1 -HostIp <pc-lan-ip>   # pin a specific IP
#   .\.agents\scripts\dev-start-mobile-wifi.ps1 -DryRun       # validate only (no launch, ~2s)
#
# The app auto-opens on the phone ONCE THE BUNDLE FINISHES BUILDING. On a cold
# start (or with -ResetCache) the first build is ~2.5 min. Do NOT open the app
# yourself before then, or it times out (SocketTimeoutException).
param(
    [switch]$ResetCache,
    # NOTE: do NOT name this -Host. $Host is a read-only PowerShell automatic
    # variable, so a parameter named Host fails to bind ("Impossibile
    # sovrascrivere la variabile Host"). Use -HostIp instead.
    [string]$HostIp,
    # -DryRun runs ALL the detection (LAN IP, firewall, adb) and prints the exact
    # command it WOULD run, then exits WITHOUT killing node / clearing cache /
    # starting Metro. Use it to validate the script in ~2s instead of waiting for
    # a full ~2.5 min Metro cold boot. Nothing destructive happens in dry-run.
    [switch]$DryRun
)

. "$PSScriptRoot\_env.ps1"

# Fall back to a LAN IP pinned in .env.local. Resolved here rather than as a
# param default because param defaults bind BEFORE the script body runs, so
# _env.ps1 has not loaded .env.local yet at that point. Auto-detection still
# runs when neither is set.
if (-not $HostIp -and $env:QM_HOST_IP) { $HostIp = $env:QM_HOST_IP }

$logPath = Join-Path $repo ".agents\reports\metro-log.txt"

# Make sure the reports folder exists
$reportsDir = Split-Path $logPath -Parent
if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
}

# Wipe old log (force, ignore if missing or locked)
Remove-Item $logPath -Force -ErrorAction SilentlyContinue

# If another Metro process is holding the log file open, we can't delete it.
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

# --- Resolve the LAN IP to bind Metro to --------------------------------------
# Either the explicit -Host value, or auto-detect the real Wi-Fi/Ethernet IPv4.
# Auto-detect deliberately SKIPS VPN/virtual adapters (TAP, WireGuard, Hyper-V,
# WSL, vEthernet, Loopback) because binding to those makes the phone unable to
# reach Metro. We prefer an interface that has a default gateway (i.e. the one
# actually carrying LAN traffic) and a private 192.168/10/172.16-31 address.
function Resolve-LanIp {
    param([string]$Explicit)
    if ($Explicit) { return $Explicit }

    $skip = '(?i)(VPN|TAP|WireGuard|OpenVPN|Proton|Nord|Express|CyberGhost|Hyper-V|vEthernet|WSL|Loopback|Virtual)'

    # Interfaces that have a default route are the ones really on the LAN.
    $routed = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object RouteMetric |
        Select-Object -ExpandProperty InterfaceIndex -Unique

    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' -and
            $_.InterfaceAlias -notmatch $skip
        }

    # Prefer addresses on a default-route interface.
    $best = $candidates | Where-Object { $routed -contains $_.InterfaceIndex } | Select-Object -First 1
    if (-not $best) { $best = $candidates | Select-Object -First 1 }
    return $best.IPAddress
}

$lanIp = Resolve-LanIp -Explicit $HostIp
if (-not $lanIp) {
    Write-Host ""
    Write-Host "  ERROR: could not auto-detect a LAN IPv4 address." -ForegroundColor Red
    Write-Host "  Is the VPN still on, or are you off Wi-Fi? Kill the VPN and retry," -ForegroundColor Yellow
    Write-Host "  or pass it explicitly:  .\.agents\scripts\dev-start-mobile-wifi.ps1 -HostIp 192.168.x.x" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
# NOTE: use $($lanIp):8081 - bare "$lanIp:8081" makes PowerShell parse "lanIp:"
# as a drive-qualified variable, which is empty, so the IP prints blank.
Write-Host "  Binding Metro to LAN IP: $($lanIp):8081" -ForegroundColor Cyan

# --- Ensure the firewall rule exists (inbound TCP 8081) -----------------------
# Without this, the phone's bundle request is silently dropped and the app shows
# "Unable to load script". We don't create it here (that needs admin); we just
# check and point at the one-time script.
$fwRuleName = "Metro Bundler 8081 (React Native dev)"
$fwRule = Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue
if (-not $fwRule) {
    Write-Host ""
    Write-Host "  WARNING: firewall rule '$fwRuleName' is missing." -ForegroundColor Yellow
    Write-Host "  The phone won't reach Metro over Wi-Fi until you run ONCE (it self-elevates):" -ForegroundColor Yellow
    Write-Host "    powershell -ExecutionPolicy Bypass -File .\.agents\scripts\allow-metro-firewall.ps1" -ForegroundColor Yellow
    Write-Host "  Metro will still start; do that, then reload on the phone." -ForegroundColor Yellow
    Write-Host ""
}

Push-Location $repo
try {
    # Reclaim ONLY orphaned Metro from a previous crashed/closed session (orphaned
    # jest-workers also hold file handles on the Metro cache -> Watchman hangs /
    # EMFILE next start, AND each eats ~600-770 MB). metro-status.ps1 -Kill
    # surgically kills only orphaned Metro/Expo trees for THIS repo, leaving
    # unrelated node (MCP, tsc, other dev servers, VS Code helpers) untouched -
    # unlike the old `Get-Process node | Stop-Process` hammer.
    # Skipped in -DryRun (it's destructive and we want to validate, not launch).
    $metroStatus = Join-Path $repo ".agents\scripts\metro-status.ps1"
    if ($DryRun) {
        Write-Host "  [dry-run] WOULD kill orphaned Metro via metro-status.ps1 -Kill" -ForegroundColor DarkGray
    } elseif (Test-Path $metroStatus) {
        & $metroStatus -Kill | Out-Null
    } else {
        $nodeProcs = Get-Process node -ErrorAction SilentlyContinue
        if ($nodeProcs) {
            Write-Host "  Killing $($nodeProcs.Count) node process(es) (metro-status.ps1 not found)" -ForegroundColor DarkGray
            $nodeProcs | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }

    # Wipe the Metro transformer cache before starting (prevents EMFILE).
    #
    # RENAME first, delete in the background - never delete in-line. A direct
    # `Remove-Item -Recurse -Force` walks tens of thousands of small files and
    # BLOCKS, and a blocking Remove-Item does not answer Ctrl+C: the script hangs
    # here with no way out but force-closing the terminal, which does not
    # reliably kill the node tree and so orphans a Metro still holding port 8081.
    # Reported 2026-08-13 as months-long behaviour. A rename is one metadata
    # operation and fails fast when a handle is held, so we skip, never block.
    $metroCache = Join-Path $env:LOCALAPPDATA "Temp\metro-cache"
    if (Test-Path $metroCache) {
        if ($DryRun) {
            Write-Host "  [dry-run] WOULD clear $metroCache" -ForegroundColor DarkGray
        } else {
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
    }

    # Cap Metro worker count (file-descriptor ceiling on this large project).
    $env:EXPO_METRO_MAX_WORKERS = "2"
    $env:METRO_MAX_WORKERS = "2"

    # EMFILE fix on Windows: cap fs.promises concurrency (see USB script header).
    # --max-old-space-size=4096 caps Node's heap at 4 GB. Metro for this project
    # peaks ~1.5 GB; the old 6144 just let it balloon and starve a near-full
    # machine (32 GB, often <3 GB free), which is what triggers the OOM crashes
    # that orphan the workers. 4 GB is well above the real peak and fails clean.
    # Bump back toward 6144 only if you actually hit "Reached heap limit" cold.
    # Dev-host limit only; the shipped app runs a pre-built Hermes bundle.
    $env:NODE_OPTIONS = "--require=$repo\.agents\scripts\patch-fs-promises.js --max-old-space-size=4096"

    # Disable Metro lazy bundling so the FULL bundle builds before the app opens
    # (auto-launch below waits for /index.bundle 200; lazy bundling would break it).
    # The committed `start` npm script sets this as a POSIX env prefix
    # (`EXPO_NO_METRO_LAZY=1 NODE_OPTIONS=... expo start`) which Windows cmd can't
    # run, so `yarn start` fails. We set it the PowerShell way and call
    # `yarn start:lazy` (plain `expo start`) instead, leaving package.json untouched.
    $env:EXPO_NO_METRO_LAZY = "1"

    # THE KEY DIFFERENCE vs the USB script: advertise the real LAN IP, not
    # localhost. This makes Expo serve the bundle URL and the dev-client deep
    # link at http://<lanIp>:8081 so the phone loads it over Wi-Fi.
    $env:REACT_NATIVE_PACKAGER_HOSTNAME = $lanIp

    # --- USB-free device check ------------------------------------------------
    # We don't need a cable, but if a phone happens to be reachable via adb
    # (USB still plugged, or adb-over-TCP already connected) we can auto-launch
    # the app pointed at the LAN URL. If not, you just open the app yourself /
    # scan the QR; Metro is advertising the right LAN IP either way.
    $adb = "adb"
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
        $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
        if (Test-Path $sdkAdb) { $adb = $sdkAdb }
    }
    $androidPackage = "com.quilibrium.quorummobile.debug"
    $scheme = "quorummobile"

    # --- adb-over-Wi-Fi: zero-touch auto-launch without a cable -----------------
    # Goal: same hands-off "app opens itself" behavior as the USB script, but
    # cable-free. adb-over-TCP is the trick. We remember the phone's adb-tcp
    # endpoint in a tiny file so subsequent cable-free runs reconnect on their own.
    #
    #   First run  (USB plugged): we flip the phone to tcpip mode, read its Wi-Fi
    #              IP, `adb connect <ip>:5555`, and SAVE the IP. Then you can
    #              unplug.
    #   Later runs (no cable):    we `adb connect <saved-ip>:5555` over Wi-Fi, and
    #              the device-detection below finds it -> app auto-launches.
    #
    # If none of this works (phone asleep, different network, adb-wifi off) the
    # script still falls through to the manual path - Metro is up either way.
    $adbWifiFile = Join-Path $repo ".agents\reports\adb-wifi-endpoint.txt"

    # Purge any STALE/OFFLINE adb-over-TCP endpoints before we do anything else.
    # A phone that changed its DHCP lease (or slept) leaves a "<ip>:5555 offline"
    # entry behind. That offline entry is poison: a later `yarn android` / Gradle
    # install picks it and dies with "device offline" (adb ... getprop ... device
    # offline), and this script would otherwise waste ~12s in Connect-AdbWifi
    # retrying a dead host. Disconnecting them here fixes both.
    if (-not $DryRun) {
        $offline = & $adb devices 2>$null |
            Where-Object { $_ -match '^\S+\s+offline$' } |
            ForEach-Object { ($_ -split '\s+')[0] }
        foreach ($stale in $offline) {
            Write-Host "  Disconnecting stale/offline adb endpoint: $stale" -ForegroundColor DarkGray
            & $adb disconnect $stale 2>$null | Out-Null
        }
    }

    # Is a USB (or already-connected) device present right now?
    $usbDevice = & $adb devices 2>$null |
        Where-Object { $_ -match '^\S+\s+device$' -and $_ -notmatch '^emulator-' -and $_ -notmatch ':5555' } |
        ForEach-Object { ($_ -split '\s+')[0] } |
        Select-Object -First 1

    # `adb connect` is not instant: right after `tcpip 5555` the phone re-binds
    # adb and the first connect often reports "connected" before the device is
    # actually queryable, or fails outright. So we RETRY connect+verify for a few
    # seconds until `adb devices` shows <ip>:5555 as a real "device". Returns
    # $true once the endpoint is up. (The old fixed 1s sleep was why the very
    # first run said "No phone reachable" and didn't auto-launch.)
    function Connect-AdbWifi {
        param([string]$Adb, [string]$Ip, [int]$TimeoutSec = 12)
        $deadline = $TimeoutSec
        for ($i = 0; $i -lt $deadline; $i++) {
            & $Adb connect "$($Ip):5555" 2>$null | Out-Null
            Start-Sleep -Seconds 1
            $up = & $Adb devices 2>$null |
                Where-Object { $_ -match "^$([regex]::Escape($Ip)):5555\s+device$" }
            if ($up) { return $true }
        }
        return $false
    }

    # Nudge a specific host awake. A dozing phone parks its Wi-Fi radio, so the
    # first adb connect after idle can fail with the endpoint stuck "offline".
    # A few inbound pings wake the radio before we retry the connect.
    function Wake-Host {
        param([string]$Ip, [int]$Count = 4)
        for ($i = 0; $i -lt $Count; $i++) {
            try { (New-Object System.Net.NetworkInformation.Ping).Send($Ip, 500) | Out-Null } catch { }
        }
    }

    # SELF-HEAL discovery. When the remembered endpoint is dead (phone dozed and
    # dropped the link, rebooted onto a new DHCP lease, or we never had a saved IP)
    # find the phone on the LAN automatically instead of giving up. We ping-sweep
    # the local /24 - which ALSO wakes a dozing phone's Wi-Fi radio - then probe
    # each live host on :5555. The phone is the only host running an adb daemon, so
    # the first endpoint that reports a real "device" is it. Returns the phone's IP
    # (left adb-connected) or $null. Locale-independent: matches IP+MAC in `arp -a`
    # output rather than the word "dynamic"/"dinamico".
    function Find-PhoneByScan {
        param([string]$Adb, [string]$HostIp)
        if ($HostIp -notmatch '^(\d+\.\d+\.\d+)\.\d+$') { return $null }
        $prefix = $Matches[1]
        Write-Host "  Self-heal: scanning $prefix.0/24 for the phone (this wakes it if dozing)..." -ForegroundColor Cyan

        # Fire async pings across the whole /24 to (re)populate the ARP table fast.
        # Keep the task references alive until the sleep so the OS completes them.
        $pings = 1..254 | ForEach-Object {
            (New-Object System.Net.NetworkInformation.Ping).SendPingAsync("$prefix.$_", 600)
        }
        Start-Sleep -Seconds 3
        $pings = $null

        # Read the now-populated neighbor table; probe every live host on :5555
        # except ourselves, the gateway (.1) and broadcast (.255).
        $hosts = (& arp -a) 2>$null |
            Select-String -Pattern "($([regex]::Escape($prefix))\.\d+)\s+[0-9a-fA-F]{2}([-:][0-9a-fA-F]{2}){5}" |
            ForEach-Object { $_.Matches[0].Groups[1].Value } |
            Where-Object { $_ -ne $HostIp -and $_ -notmatch '\.(1|255)$' } |
            Select-Object -Unique
        foreach ($ip in $hosts) { & $Adb connect "$($ip):5555" 2>$null | Out-Null }
        Start-Sleep -Seconds 2

        $phone = & $Adb devices 2>$null |
            Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+:5555\s+device$' } |
            ForEach-Object { (($_ -split '\s+')[0] -split ':')[0] } |
            Select-Object -First 1

        # Tidy up: drop any probe endpoints that answered but aren't a real device
        # (offline), so they can't poison a later Gradle install.
        $stale = & $Adb devices 2>$null |
            Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+:5555\s+offline$' } |
            ForEach-Object { ($_ -split '\s+')[0] }
        foreach ($s in $stale) { & $Adb disconnect $s 2>$null | Out-Null }

        return $phone
    }

    if (-not $DryRun) {
        if ($usbDevice) {
            # Read the phone's own Wi-Fi IPv4 (wlan0) so we can reach it over LAN.
            $wlanLine = & $adb -s $usbDevice shell ip -f inet addr show wlan0 2>$null |
                Select-String -Pattern 'inet (\d+\.\d+\.\d+\.\d+)' | Select-Object -First 1
            $phoneIp = if ($wlanLine) { $wlanLine.Matches[0].Groups[1].Value } else { $null }

            if ($phoneIp) {
                Write-Host "  Phone on USB ($usbDevice), Wi-Fi IP $phoneIp - enabling adb-over-Wi-Fi..." -ForegroundColor Cyan
                & $adb -s $usbDevice tcpip 5555 2>$null | Out-Null
                Start-Sleep -Seconds 2   # let the phone re-bind adb after the mode switch
                if (Connect-AdbWifi -Adb $adb -Ip $phoneIp) {
                    # Persist so the NEXT cable-free run reconnects automatically.
                    Set-Content -Path $adbWifiFile -Value $phoneIp -Encoding ASCII
                    Write-Host "  adb-over-Wi-Fi CONNECTED ($phoneIp:5555). You can UNPLUG the cable now; future runs are cable-free." -ForegroundColor Green
                }
                else {
                    Write-Host "  Enabled tcpip but couldn't confirm the Wi-Fi connection. Staying on USB for this run;" -ForegroundColor Yellow
                    Write-Host "  the app will still auto-launch over the cable. (Keep it plugged in this time.)" -ForegroundColor Yellow
                }
            }
            else {
                Write-Host "  Phone on USB but couldn't read its Wi-Fi IP (Wi-Fi off?); staying on USB." -ForegroundColor Yellow
            }
        }
        else {
            # --- CABLE-FREE reconnect, with self-heal --------------------------
            # Fast path: try the remembered endpoint (wake it first in case it
            # dozed). Slow path (self-heal): if that's dead - phone dropped the
            # link, rebooted onto a new DHCP lease, or we have no saved IP at all
            # - scan the LAN to find and reconnect the phone automatically, then
            # remember the (possibly new) IP so the next run is instant again.
            $savedIp = $null
            if (Test-Path $adbWifiFile) {
                $savedIp = Get-Content $adbWifiFile -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($savedIp) { $savedIp = $savedIp.Trim() }
            }

            $connected = $false
            if ($savedIp) {
                # NOTE: "$savedIp:5555" parses as drive-notation (empty), like the
                # $lanIp trap above. Always use $($savedIp):5555.
                Write-Host "  No cable - reconnecting to remembered phone $($savedIp):5555 over Wi-Fi..." -ForegroundColor Cyan
                & $adb disconnect "$($savedIp):5555" 2>$null | Out-Null  # clear any offline entry
                Wake-Host -Ip $savedIp                                   # nudge it out of doze
                if (Connect-AdbWifi -Adb $adb -Ip $savedIp -TimeoutSec 8) {
                    Write-Host "  Reconnected over Wi-Fi ($($savedIp):5555)." -ForegroundColor Green
                    $connected = $true
                }
            }

            if (-not $connected) {
                if ($savedIp) {
                    Write-Host "  Remembered endpoint is dead; self-healing by LAN scan..." -ForegroundColor Yellow
                    & $adb disconnect "$($savedIp):5555" 2>$null | Out-Null
                }
                $foundIp = Find-PhoneByScan -Adb $adb -HostIp $lanIp
                if ($foundIp) {
                    Set-Content -Path $adbWifiFile -Value $foundIp -Encoding ASCII
                    Write-Host "  Self-healed: phone found at $($foundIp):5555 and remembered for next time." -ForegroundColor Green
                    $connected = $true
                }
            }

            if (-not $connected) {
                # Truly no phone reachable - clear stale state and explain.
                Remove-Item $adbWifiFile -Force -ErrorAction SilentlyContinue
                Write-Host "  Couldn't find the phone on the LAN (Wi-Fi off, on another network," -ForegroundColor Yellow
                Write-Host "  rebooted so adb-tcp is off, or powered down)." -ForegroundColor Yellow
                Write-Host "  Unlock the phone once and re-run, or plug in by USB once to re-pair." -ForegroundColor Yellow
            }
        }
    }

    # Now detect ANY usable device (USB or adb-over-Wi-Fi). This is what the
    # auto-launch below keys off; if empty, we fall through to the manual path.
    # PREFER a Wi-Fi endpoint (<ip>:5555): this is the Wi-Fi script, so even if a
    # USB cable is still attached we target the wireless connection. Falling back
    # to any single device otherwise.
    $allReachable = & $adb devices 2>$null |
        Where-Object { $_ -match '^\S+\s+device$' -and $_ -notmatch '^emulator-' } |
        ForEach-Object { ($_ -split '\s+')[0] }
    $device = @($allReachable | Where-Object { $_ -match ':\d+$' })[0]
    if (-not $device) { $device = @($allReachable)[0] }

    if ($device) {
        # Pin Expo (and every adb call it makes) to this device, so a still-plugged
        # USB cable can't trigger a "more than one device/emulator" ambiguity that
        # Expo misreports as "No development build installed" when you press 'a'.
        $env:ANDROID_SERIAL = $device
    }

    $skipAutoLaunch = $false
    if ($device) {
        # SAFETY: never auto-launch unless the .debug package is installed, or the
        # quorummobile:// deep link could resolve to the user's REAL app.
        $pkgList = & $adb -s $device shell pm list packages $androidPackage 2>$null
        $debugInstalled = $pkgList -match "package:$androidPackage"
        if (-not $debugInstalled) {
            Write-Host ""
            Write-Host "  NOTE: $androidPackage is NOT installed; skipping auto-launch" -ForegroundColor Yellow
            Write-Host "  (won't risk opening your REAL app). Open the dev client manually." -ForegroundColor Yellow
            Write-Host ""
            $skipAutoLaunch = $true
        }

        if (-not $skipAutoLaunch -and $DryRun) {
            Write-Host "  [dry-run] phone reachable via adb: WOULD auto-open the app after the bundle builds." -ForegroundColor DarkGray
            $skipAutoLaunch = $true
        }

        if (-not $skipAutoLaunch) {
            # Deep link points at the LAN IP, NOT localhost. Wait for the bundle to
            # build (HEAD 200) before launching so the app doesn't time out.
            $encodedUrl = "http%3A%2F%2F$($lanIp)%3A8081"
            $launchUrl = "$scheme`://expo-development-client/?url=$encodedUrl"
            Start-Job -ScriptBlock {
                param($adb, $device, $pkg, $url, $lanIp)
                $bundleUrl = "http://$($lanIp):8081/index.bundle?platform=android&dev=true"
                for ($i = 0; $i -lt 72; $i++) {
                    try {
                        $r = Invoke-WebRequest -Uri $bundleUrl -Method Head -TimeoutSec 300 -UseBasicParsing
                        if ($r.StatusCode -eq 200) { break }
                    } catch { }
                    Start-Sleep -Seconds 5
                }
                & $adb -s $device shell am force-stop $pkg | Out-Null
                & $adb -s $device shell am start -a android.intent.action.VIEW -d $url $pkg | Out-Null
            } -ArgumentList $adb, $device, $androidPackage, $launchUrl, $lanIp | Out-Null
            Write-Host "  Phone reachable via adb ($device): app will auto-open AFTER the bundle builds (~2.5 min cold)." -ForegroundColor Green
            Write-Host "  >> Hands-off: do NOT open the app yourself and do NOT press 'a', or it will time out. <<" -ForegroundColor Yellow
        }
    }
    else {
        Write-Host ""
        Write-Host "  No phone reachable via adb - can't auto-launch this run." -ForegroundColor Yellow
        Write-Host "  EASIEST FIX (do once): plug the phone in by USB and re-run this script." -ForegroundColor Yellow
        Write-Host "  It'll enable adb-over-Wi-Fi, then every future run is cable-free & hands-off." -ForegroundColor Yellow
        Write-Host "  For now: open the Quorum dev-client app on the phone (or scan the QR below)." -ForegroundColor DarkGray
        Write-Host "  It loads from http://$($lanIp):8081 over Wi-Fi. Do NOT press 'a' (that's emulator/USB only)." -ForegroundColor DarkGray
        Write-Host ""
    }

    # Expo's --host flag ONLY accepts lan|tunnel|localhost (it asserts against
    # /^(lan|tunnel|localhost)$/) - it does NOT take an IP. Passing an IP throws
    # "The input did not match the regular expression". So we use --lan for the
    # MODE, and pin the actual IP via REACT_NATIVE_PACKAGER_HOSTNAME (set above on
    # the $env: block). That env var is what makes Expo advertise the bundle URL
    # at http://<lanIp>:8081 and bind the IPv4 LAN address (fixing the
    # IPv6-only-bind problem on this box). NO --localhost (that would defeat Wi-Fi).
    # Build the argument list dynamically so we never pass an empty '' token.
    # start:lazy = plain `expo start` (no inline POSIX env prefix; env vars set above).
    $startArgs = @('start:lazy', '--max-workers', '2', '--lan')
    if ($ResetCache) { $startArgs += '--reset-cache' }

    if ($DryRun) {
        Write-Host ""
        Write-Host "  [dry-run] Validation complete. Nothing was launched." -ForegroundColor Green
        Write-Host "  [dry-run] REACT_NATIVE_PACKAGER_HOSTNAME = $($env:REACT_NATIVE_PACKAGER_HOSTNAME)" -ForegroundColor Green
        Write-Host "  [dry-run] WOULD run:  yarn $($startArgs -join ' ')" -ForegroundColor Green
        Write-Host ""
        return
    }

    Write-Host ""
    Write-Host "  Starting Metro on $($lanIp):8081 (2 workers, fs.promises capped)." -ForegroundColor Cyan
    Write-Host "  This window is INTERACTIVE: press 'a' for Android, 'r' to reload, Ctrl+C to stop." -ForegroundColor Cyan
    Write-Host "  Logs mirrored to: $logPath" -ForegroundColor Cyan
    Write-Host ""

    # Clear any transcript left "running" by a prior run that was Ctrl+C'd (Ctrl+C
    # while Metro is foregrounded can skip this script's `finally` Stop-Transcript,
    # leaving the host transcript dirty so the NEXT Start-Transcript stalls/throws -
    # the classic "re-running the script hangs / writes no log" symptom).
    try { Stop-Transcript | Out-Null } catch { }
    $transcriptOn = $false
    try {
        Start-Transcript -Path $logPath -Force | Out-Null
        $transcriptOn = $true
    } catch {
        Write-Host "  (Could not start transcript; Metro will still run, just no log file.)" -ForegroundColor DarkYellow
    }

    yarn @startArgs
}
finally {
    if ($transcriptOn) { Stop-Transcript | Out-Null }
    Pop-Location
}
