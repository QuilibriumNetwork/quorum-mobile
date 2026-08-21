# _adb-preflight.ps1 - shared "which phone are we talking to" preflight for the
# CABLE-based dev scripts (dev-start-mobile.ps1, build-app.ps1).
#
# Dot-source it, then call Resolve-QmUsbDevice:
#
#   . (Join-Path $PSScriptRoot '_adb-preflight.ps1')
#   $target = Resolve-QmUsbDevice -Serial $Serial
#   if (-not $target) { exit 1 }
#   $adb = $target.Adb ; $device = $target.Serial
#
# WHY THIS EXISTS (2026-08-13):
# A phone on the USB cable worked for months, then both scripts started failing
# with a message that names the wrong cause:
#
#   This computer is not authorized for developing on Device 192.168.0.3:5555
#   CommandError: No development build (com.quilibrium.quorummobile) for this
#   project is installed.
#
# Nothing was wrong with the cable, the build, or the install. `adb devices` had
# TWO entries: the cabled phone (state "device") and a leftover Wi-Fi endpoint
# from a previous dev-start-mobile-wifi run, stuck in state "unauthorized".
# Expo enumerates devices itself, picked the Wi-Fi one, could not run
# `pm list packages` against an unauthorized endpoint, and reported that failure
# as "no development build installed". The user then rebuilt from scratch
# (~9 min) and hit exactly the same wall, because the build was never the issue.
#
# dev-start-mobile.ps1 already tried to auto-heal this, but its filter was
#   '^\S+:\d+\s+device$'
# so it only pruned Wi-Fi endpoints that were ALREADY HEALTHY, and skipped the
# unauthorized/offline ones - i.e. precisely the ones that break Expo. That
# off-by-one state is the whole bug. This helper prunes by SHAPE (anything with
# a :port is not the cable) and ignores state entirely - but only ONCE a healthy
# USB phone is confirmed, so it can never delete the only endpoint you have.
#
# It also fails FAST and SPECIFICALLY: an unauthorized or missing phone is now
# reported in seconds with the exact thing to tap, instead of surfacing as a
# misleading error at the end of a 9-minute Gradle build.
#
# NOTE: this is for the CABLE scripts only. dev-start-mobile-wifi.ps1,
# connect-second-device.ps1 and two-device-round.ps1 deliberately own <ip>:5555
# endpoints - never wire this helper into those.

# NOTE: deliberately NO Set-StrictMode here. This file is dot-sourced, so a
# strict mode set here would leak into the CALLER's scope and make its existing
# use of never-initialised variables (a normal PowerShell idiom) start throwing.
# A library must not change its caller's language semantics.

# Can we actually BIND this port on loopback? This is the real question, and it
# is NOT the same as "is anything listening". Measured 2026-08-13: binding 8081
# failed with EACCES while `netstat` showed no listener at all, because Windows
# had reserved the whole 7988-8087 range (see Get-QmExcludedPortRanges). A
# LISTENING check is blind to that, which is why the old "port busy" symptom
# looked like a ghost process for months.
function Test-QmPortBindable {
    param([Parameter(Mandatory)][int]$Port)
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { try { $listener.Stop() } catch { } }
    }
}

# Windows port exclusions, as "start-end" strings. Hyper-V / WSL / Docker reserve
# blocks of ports at boot and the blocks MOVE between boots, so a port that
# worked yesterday can be unbindable today with nothing visibly holding it.
function Get-QmExcludedPortRanges {
    $ranges = @()
    try {
        foreach ($line in (netsh interface ipv4 show excludedportrange protocol=tcp 2>$null)) {
            if ("$line" -match '^\s*(\d+)\s+(\d+)') { $ranges += "$($Matches[1])-$($Matches[2])" }
        }
    } catch { }
    return $ranges
}

# Pick a Metro port we can actually bind. Prefers $Preferred (8081, which the
# whole USB workflow assumes); falls back to the first bindable candidate.
# Returns 0 if nothing is usable.
function Resolve-QmMetroPort {
    param(
        [int]$Preferred = 8081,
        [int[]]$Fallbacks = @(8288, 8300, 8500, 19000, 19100)
    )

    if (Test-QmPortBindable -Port $Preferred) { return $Preferred }

    # Distinguish "someone is serving on it" from "Windows reserved it" - the
    # remedies are completely different and the messages look identical in Expo.
    $listenerPid = $null
    try {
        $conn = Get-NetTCPConnection -LocalPort $Preferred -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) { $listenerPid = $conn.OwningProcess }
    } catch { }

    if ($listenerPid) {
        $proc = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
        if ($name -eq 'node') {
            Write-Host "  Port $Preferred held by an orphaned node (PID $listenerPid) - killing it." -ForegroundColor Yellow
            Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
            if (Test-QmPortBindable -Port $Preferred) { return $Preferred }
        } else {
            Write-Host "  Port $Preferred is held by '$name' (PID $listenerPid)." -ForegroundColor Yellow
        }
    } else {
        $hit = @(Get-QmExcludedPortRanges | Where-Object {
            $p = $_ -split '-'; [int]$p[0] -le $Preferred -and [int]$p[1] -ge $Preferred
        })
        Write-Host ""
        Write-Host "  Port $Preferred cannot be bound, and NOTHING is listening on it." -ForegroundColor Yellow
        if ($hit.Count -gt 0) {
            Write-Host "  Cause: Windows has reserved the range $($hit -join ', ') (Hyper-V / WSL / Docker)." -ForegroundColor Yellow
            Write-Host "  These blocks are handed out at boot and MOVE between boots, which is why" -ForegroundColor DarkGray
            Write-Host "  a port that worked for months can fail today with no process to blame." -ForegroundColor DarkGray
            Write-Host "  Permanent fix (admin, survives reboots):" -ForegroundColor DarkGray
            Write-Host "    net stop winnat" -ForegroundColor DarkGray
            Write-Host "    netsh int ipv4 add excludedportrange protocol=tcp startport=$Preferred numberofports=1 store=persistent" -ForegroundColor DarkGray
            Write-Host "    net start winnat" -ForegroundColor DarkGray
        }
    }

    foreach ($candidate in $Fallbacks) {
        if (Test-QmPortBindable -Port $candidate) {
            Write-Host "  Using port $candidate instead (adb reverse and the deep link follow it)." -ForegroundColor Cyan
            Write-Host ""
            return $candidate
        }
    }

    Write-Host "  ERROR: none of $Preferred, $($Fallbacks -join ', ') could be bound." -ForegroundColor Red
    return 0
}

# Locate adb: PATH first, then the usual SDK roots on this machine.
function Get-QmAdb {
    if (Get-Command adb -ErrorAction SilentlyContinue) { return 'adb' }
    # Environment first, so nothing here is tied to one machine's layout. Set
    # QM_ANDROID_SDK in .agents/scripts/.env.local to override on a box where the
    # SDK lives somewhere unusual and ANDROID_SDK_ROOT/ANDROID_HOME are not set.
    $roots = @()
    if ($env:QM_ANDROID_SDK)   { $roots += $env:QM_ANDROID_SDK }
    if ($env:ANDROID_SDK_ROOT) { $roots += $env:ANDROID_SDK_ROOT }
    if ($env:ANDROID_HOME)     { $roots += $env:ANDROID_HOME }
    if ($env:LOCALAPPDATA)     { $roots += (Join-Path $env:LOCALAPPDATA 'Android\Sdk') }
    if ($env:ProgramFiles)     { $roots += (Join-Path $env:ProgramFiles 'Android\android-sdk') }
    # Last resort only: the Android Studio custom-install default. Every entry
    # above is environment-derived; this one is a guess and must stay last.
    $roots += 'C:\Android\Sdk'
    foreach ($r in $roots) {
        $candidate = Join-Path $r 'platform-tools\adb.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

# Parse `adb devices` into objects. States seen in practice: device,
# unauthorized, offline, authorizing, "no permissions".
function Get-QmAdbDevices {
    param([Parameter(Mandatory)][string]$Adb)

    $devices = @()
    foreach ($line in (& $Adb devices 2>$null)) {
        $text = "$line".Trim()
        if (-not $text) { continue }
        if ($text -like 'List of devices*') { continue }
        if ($text.StartsWith('*')) { continue }   # "* daemon started successfully"
        if ($text -notmatch '^(\S+)\s+(\S+)') { continue }
        $devices += [pscustomobject]@{
            Serial = $Matches[1]
            State  = $Matches[2]
            # The cable has a bare serial; Wi-Fi adb is always <host>:<port>.
            IsTcp  = ($Matches[1] -match '^\S+:\d+$')
        }
    }
    # Plain `return $devices` - NOT `return , $devices`. The unary comma protects
    # a single-element array on ASSIGNMENT, but when the function output is PIPED
    # the outer array unrolls and emits the inner array as ONE object. Where-Object
    # then evaluates $_.IsTcp against the whole array, member enumeration yields
    # @(False,True,True), and every device matches every filter. Measured
    # 2026-08-13: it reported the cabled phone as a Wi-Fi endpoint and found no USB
    # device at all. Callers wrap with @() where they need a guaranteed array.
    return $devices
}

# Resolve the one cabled phone to target, healing what can be healed.
# Returns @{ Adb; Serial } on success, $null on failure (caller should exit).
function Resolve-QmUsbDevice {
    param(
        # HARD pin: the caller passed -Serial explicitly, so they mean this phone
        # and no other. If it is absent we wait for it and then fail.
        [string]$Serial,
        # SOFT pin: a remembered default (QM_DEVICE_1 in .env.local). Used when
        # present, quietly ignored when it is not.
        #
        # These must stay separate. Folding the remembered default into $Serial
        # made the script demand a phone that was merely the LAST one used: swap
        # the cable to your other phone and it waits 45 s for the absent one and
        # gives up, while a perfectly healthy device sits there unused. A
        # remembered preference must never outrank the hardware actually plugged in.
        [string]$Preferred,
        # How long to keep polling while the phone is unauthorized/absent.
        [int]$WaitSeconds = 45
    )

    $adb = Get-QmAdb
    if (-not $adb) {
        Write-Host ""
        Write-Host "  ERROR: adb not found (PATH, ANDROID_SDK_ROOT, ANDROID_HOME, C:\Android\Sdk)." -ForegroundColor Red
        Write-Host "  Install Android platform-tools, or set ANDROID_SDK_ROOT, then retry." -ForegroundColor Yellow
        Write-Host ""
        return $null
    }
    # Prime the server through cmd, NOT `& $adb start-server | Out-Null`.
    # On a COLD adb, any adb call whose output PowerShell captures (a pipeline,
    # `| Out-Null`, or assignment to a variable) hangs forever: the server that
    # adb forks inherits the capture pipe's write handle and holds it open for
    # its whole lifetime, so PowerShell never sees EOF. Going through cmd with
    # `>nul` hands the server a NUL handle instead, so nothing is left holding
    # our pipe. MEASURED 2026-08-21: `| Out-Null` and `Start-Process -Wait` both
    # hang on a cold server; only this form returns. Warm servers fork nothing,
    # which is why the broken form appeared to work for months.
    cmd /c "`"$adb`" start-server >nul 2>&1"

    # --- Wait for a usable cabled phone, then let USB win ----------------------
    # THE RULE: if a phone is connected over USB, discard the Wi-Fi one.
    # Note the ordering - we prune only AFTER the cable is confirmed healthy, and
    # never before. Pruning first would strand the run when no cable is attached
    # (it would delete the only working endpoint, then report "no phone"), so a
    # stray Wi-Fi entry survives exactly when it is the only thing there.
    $warnedUnauthorized = $false
    $warnedMissing      = $false
    $kickedOffline      = $false
    $deadline           = (Get-Date).AddSeconds($WaitSeconds)

    while ($true) {
        $cabled = @(Get-QmAdbDevices -Adb $adb |
            Where-Object { -not $_.IsTcp -and $_.Serial -notlike 'emulator-*' })
        if ($Serial) { $cabled = @($cabled | Where-Object { $_.Serial -eq $Serial }) }

        $ready = @($cabled | Where-Object { $_.State -eq 'device' })
        if ($ready.Count -ge 1) {
            # Honour the soft pin only if that phone is actually here.
            $chosen = $ready[0].Serial
            if ($Preferred -and ($ready.Serial -contains $Preferred)) {
                $chosen = $Preferred
            }
            elseif ($Preferred -and $ready.Count -eq 1) {
                Write-Host "  Remembered phone $Preferred is not plugged in; using $chosen instead." -ForegroundColor Cyan
            }
            if ($ready.Count -gt 1) {
                Write-Host "  Multiple phones on the cable: $($ready.Serial -join ', ')" -ForegroundColor Yellow
                Write-Host "  Using $chosen. Pass -Serial <serial> to pick a different one." -ForegroundColor Yellow
            }

            # USB wins: drop every <ip>:port endpoint, WHATEVER its state. Matching
            # by shape (not by state) is the actual fix for the 2026-08-13 failure -
            # the old filter only pruned Wi-Fi endpoints that were already healthy
            # and left the unauthorized one that breaks Expo. Expo does not honour
            # ANDROID_SERIAL when picking a device, so the only reliable guarantee
            # is leaving it exactly one candidate to choose from.
            foreach ($tcp in @(Get-QmAdbDevices -Adb $adb | Where-Object { $_.IsTcp })) {
                & $adb disconnect $tcp.Serial 2>$null | Out-Null
                Write-Host "  USB phone present - discarded Wi-Fi endpoint $($tcp.Serial) [$($tcp.State)]." -ForegroundColor DarkGray
            }

            # Pin every adb call WE make (Expo's own picking is handled above).
            $env:ANDROID_SERIAL = $chosen
            return @{ Adb = $adb; Serial = $chosen }
        }

        $unauthorized = @($cabled | Where-Object { $_.State -eq 'unauthorized' -or $_.State -eq 'authorizing' })
        $offline      = @($cabled | Where-Object { $_.State -eq 'offline' })

        if ($unauthorized.Count -gt 0 -and -not $warnedUnauthorized) {
            $warnedUnauthorized = $true
            Write-Host ""
            Write-Host "  Phone $($unauthorized[0].Serial) is connected but NOT AUTHORIZED." -ForegroundColor Yellow
            Write-Host "  On the phone: unlock the screen and tap ALLOW on the 'Allow USB debugging?'" -ForegroundColor Yellow
            Write-Host "  prompt (tick 'Always allow from this computer'). Waiting up to $WaitSeconds s..." -ForegroundColor Yellow
            Write-Host "  No prompt? Settings > Developer options > Revoke USB debugging authorisations, then replug." -ForegroundColor DarkGray
            # Resets unauthorized/offline transports, which re-triggers the prompt.
            & $adb reconnect offline 2>$null | Out-Null
        }
        elseif ($offline.Count -gt 0 -and -not $kickedOffline) {
            $kickedOffline = $true
            Write-Host "  Phone $($offline[0].Serial) is OFFLINE - kicking the connection..." -ForegroundColor Yellow
            & $adb reconnect offline 2>$null | Out-Null
        }
        elseif ($cabled.Count -eq 0 -and -not $warnedMissing) {
            $warnedMissing = $true
            $what = if ($Serial) { "Phone $Serial is not connected" } else { "No phone detected on USB" }
            Write-Host ""
            Write-Host "  $what. Waiting up to $WaitSeconds s..." -ForegroundColor Yellow
            Write-Host "  Check: cable seated, phone unlocked, USB mode set to File transfer / MTP" -ForegroundColor DarkGray
            Write-Host "  (charge-only hides the device), Developer options > USB debugging ON." -ForegroundColor DarkGray
            # Surface the cable-free alternative NOW rather than after the wait:
            # a live Wi-Fi endpoint with no cable usually means the wrong script.
            $liveWifi = @(Get-QmAdbDevices -Adb $adb | Where-Object { $_.IsTcp -and $_.State -eq 'device' })
            if ($liveWifi.Count -gt 0) {
                Write-Host "  A Wi-Fi phone IS connected ($($liveWifi[0].Serial)). Left untouched." -ForegroundColor Cyan
                Write-Host "  To use it, Ctrl+C and run:  .\.agents\scripts\dev-start-mobile-wifi.ps1" -ForegroundColor Cyan
            }
        }

        if ((Get-Date) -gt $deadline) { break }
        Start-Sleep -Seconds 2
    }

    # --- Give up with a diagnosis, not a mystery --------------------------------
    $all = @(Get-QmAdbDevices -Adb $adb)
    Write-Host ""
    Write-Host "  ERROR: no usable USB phone after $WaitSeconds s." -ForegroundColor Red
    if ($all.Count -eq 0) {
        Write-Host "  adb sees no devices at all." -ForegroundColor Red
    } else {
        Write-Host "  adb currently sees:" -ForegroundColor Red
        foreach ($d in $all) { Write-Host "    $($d.Serial)  [$($d.State)]" -ForegroundColor Red }
    }
    Write-Host "  Cable-free workflow instead:  .\.agents\scripts\dev-start-mobile-wifi.ps1" -ForegroundColor Yellow
    Write-Host ""
    return $null
}
