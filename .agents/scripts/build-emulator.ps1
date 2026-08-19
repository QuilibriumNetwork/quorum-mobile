# build-emulator.ps1 - one-button native rebuild + install for the ANDROID EMULATOR.
#
# WHY THIS EXISTS (separate from build-app.ps1):
# The emulator is NOT just "the phone build on a different device". Two things
# differ and both will silently break a phone-style build:
#
#   1. ABI. A stock Android Studio emulator on this Intel/Windows host is
#      x86_64. build-app.ps1 builds arm64-v8a ONLY (both physical test phones
#      are arm64), so its APK has no native lib the emulator can load - the app
#      installs but crashes on launch with UnsatisfiedLinkError, or Metro throws
#      "package X doesn't seem to be linked" because the native module's .so
#      isn't in the APK for this ABI. We detect the emulator's ABI at runtime
#      and build exactly that.
#
#   2. Package id. dev-start-emulator.ps1 launches
#      com.quilibrium.quorummobile/.MainActivity (the NON-suffixed id). So the
#      emulator build must NOT set sideBySide (which would produce the .debug
#      id used for the phone). On an emulator there's no real user data to
#      protect, so the plain id is the right, consistent choice and keeps the
#      auto-launch in dev-start-emulator.ps1 working.
#
# It also carries over the two hard-won fixes from build-app.ps1:
#   - accented-username JVM tmpdir fix (forces java.io.tmpdir onto <local temp>/)
#   - the react-native-keyboard-controller < 1.20.5 MAX_PATH pre-flight warning
#
# USAGE - run from the repo root when the emulator is missing the dev build
# (e.g. after adding a native dependency, or on a fresh AVD):
#   .\.agents\scripts\build-emulator.ps1
#   .\.agents\scripts\build-emulator.ps1 -Avd Pixel_7   # boot this AVD if none running
#
# After it finishes, use dev-start-emulator.ps1 for JS/TS iteration.

param(
    # If no emulator is currently running, boot this AVD before building. When
    # omitted and nothing is running, the first AVD from `emulator -list-avds`
    # is booted. Ignored when an emulator is already running.
    [string]$Avd
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

# --- Resolve adb + emulator binaries ---------------------------------------
# ANDROID_HOME is checked before %LOCALAPPDATA% because this machine's SDK lives
# at C:\Android\Sdk, not the Android Studio default.
$sdkRoots = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA "Android\Sdk")) |
    Where-Object { $_ }

$adb = "adb"
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    $sdkAdb = $sdkRoots |
        ForEach-Object { Join-Path $_ "platform-tools\adb.exe" } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
    if ($sdkAdb) { $adb = $sdkAdb }
    else {
        Write-Host "  ERROR: adb not found on PATH, nor under ANDROID_HOME / %LOCALAPPDATA%\Android\Sdk" -ForegroundColor Red
        exit 1
    }
}
$emulatorExe = $null
foreach ($cand in @(
    (Get-Command emulator -ErrorAction SilentlyContinue).Source
) + ($sdkRoots | ForEach-Object { Join-Path $_ "emulator\emulator.exe" })) {
    if ($cand -and (Test-Path $cand)) { $emulatorExe = $cand; break }
}

# --- Find a running emulator, or boot one ----------------------------------
function Get-RunningEmulatorSerial {
    & $adb devices 2>$null |
        Where-Object { $_ -match '^emulator-\d+\s+device$' } |
        ForEach-Object { ($_ -split '\s+')[0] } |
        Select-Object -First 1
}

# Poll, don't ask once. The first `adb devices` after a reboot also STARTS the adb
# server and returns before that server has finished scanning the emulator console
# ports, so it reports an empty list while a healthy emulator is running.
# MEASURED 2026-08-18: call #1 empty, call #2 listed emulator-5554.
& $adb start-server 2>$null | Out-Null
$serial = $null
for ($i = 0; $i -lt 10; $i++) {
    $serial = Get-RunningEmulatorSerial
    if ($serial) { break }
    Start-Sleep -Seconds 1
}
if (-not $serial) {
    if (-not $emulatorExe) {
        Write-Host ""
        Write-Host "  ERROR: no emulator running and the emulator binary wasn't found." -ForegroundColor Red
        Write-Host "  Boot one from Android Studio's Device Manager, then re-run this script." -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
    # Pick the AVD to boot: the -Avd param, else the first available.
    $avds = & $emulatorExe -list-avds 2>$null | Where-Object { $_ -and $_.Trim() }
    if (-not $avds) {
        Write-Host "  ERROR: no AVDs exist. Create one in Android Studio's Device Manager first." -ForegroundColor Red
        exit 1
    }
    $target = if ($Avd) {
        if ($avds -notcontains $Avd) {
            Write-Host "  ERROR: AVD '$Avd' not found. Available: $($avds -join ', ')" -ForegroundColor Red
            exit 1
        }
        $Avd
    } else { @($avds)[0] }

    Write-Host "  No emulator running - booting AVD '$target'..." -ForegroundColor Cyan
    # Launch detached; the emulator window stays up after this script exits.
    Start-Process -FilePath $emulatorExe -ArgumentList @('-avd', $target) | Out-Null

    Write-Host "  Waiting for the emulator to come online (up to 180s)..." -ForegroundColor DarkGray
    for ($i = 0; $i -lt 180; $i++) {
        $serial = Get-RunningEmulatorSerial
        if ($serial) { break }
        Start-Sleep -Seconds 1
    }
    if (-not $serial) {
        Write-Host "  ERROR: emulator did not appear in 'adb devices' within 180s." -ForegroundColor Red
        exit 1
    }
    # Wait for Android itself to finish booting (sys.boot_completed=1).
    for ($i = 0; $i -lt 180; $i++) {
        $booted = (& $adb -s $serial shell getprop sys.boot_completed 2>$null | Out-String).Trim()
        if ($booted -eq '1') { break }
        Start-Sleep -Seconds 1
    }
}
Write-Host "  Target emulator: $serial" -ForegroundColor Green

# The AVD name is what Expo's --device flag matches (NOT the adb serial - passing
# 'emulator-5554' fails with 'Could not find device with name'). `emu avd name`
# prints the name then 'OK'; take the first non-empty line.
$avdName = (& $adb -s $serial emu avd name 2>$null |
    Where-Object { $_ -and $_.Trim() -and $_.Trim() -ne 'OK' } |
    Select-Object -First 1)
if ($avdName) { $avdName = $avdName.Trim() }

# Detect the emulator's primary ABI so we build a matching native lib.
$abi = (& $adb -s $serial shell getprop ro.product.cpu.abi 2>$null | Out-String).Trim()
if (-not $abi) { $abi = 'x86_64' }   # sane default for a Windows/Intel emulator
Write-Host "  Emulator ABI: $abi   AVD name: $avdName" -ForegroundColor DarkGray

# Warn (don't fail) if a phone is also attached - we pin the install to the
# emulator below, so the phone is safe, but it's worth surfacing.
$others = & $adb devices 2>$null |
    Where-Object { $_ -match '^\S+\s+device$' -and $_ -notmatch "^$serial\s" } |
    ForEach-Object { ($_ -split '\s+')[0] }
if ($others) {
    Write-Host "  Other device(s) attached ($($others -join ', ')) - install is pinned to $serial, they are untouched." -ForegroundColor DarkGray
}

# --- accented-username JVM tmpdir fix (see build-app.ps1 for the full story) --
# AGP's prefab/C++ staging runs under java.io.tmpdir, which resolves under the
# accented Windows profile and mangles into '??', killing the NitroModules C++
# build. Force java.io.tmpdir onto an ASCII-only path.
$asciiTemp = if ($env:QM_ASCII_TEMP) { $env:QM_ASCII_TEMP } else { 'C:\Temp\' }
if (-not (Test-Path $asciiTemp)) { New-Item -ItemType Directory -Path $asciiTemp | Out-Null }
$tmpArg = "-Djava.io.tmpdir=$asciiTemp"
$env:JAVA_TOOL_OPTIONS = $tmpArg
$env:GRADLE_OPTS = $tmpArg
$env:TMP = $asciiTemp
$env:TEMP = $asciiTemp

# --- Windows MAX_PATH pre-flight (react-native-keyboard-controller) ----------
$longPaths = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
if ($longPaths -ne 1) {
    Write-Host "  Enabling Win32 long paths (general hygiene; approve the UAC prompt)..." -ForegroundColor DarkGray
    Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
        '-NoProfile','-Command',
        'reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f'
    ) | Out-Null
}
$kbcPkg = Join-Path $repoRoot 'node_modules\react-native-keyboard-controller\package.json'
if (Test-Path $kbcPkg) {
    $kbcVer = (Get-Content $kbcPkg -Raw | ConvertFrom-Json).version
    $bad = $false
    try {
        $v = [version]($kbcVer -replace '-.*$','')
        if ($v -lt [version]'1.20.5') { $bad = $true }
    } catch { }
    if ($bad) {
        Write-Host ""
        Write-Host "  WARNING: react-native-keyboard-controller $kbcVer (< 1.20.5) can trigger the" -ForegroundColor Yellow
        Write-Host "  Windows 260-char native build failure. Upgrade the dep first (PR #1248)." -ForegroundColor Yellow
        $ans = Read-Host "  Build anyway? (y/N)"
        if ($ans -notmatch '^[Yy]') { exit 1 }
    }
}

Set-Location $repoRoot

# --- Build config: emulator ABI, plain package id (NOT side-by-side) ---------
# Build ONLY the emulator's ABI (fast; avoids the slow per-ABI copy of
# libreactnative.so). Overrides gradle.properties via Gradle's env injection.
$env:ORG_GRADLE_PROJECT_reactNativeArchitectures = $abi
# Do NOT set ORG_GRADLE_PROJECT_sideBySide: we want the plain
# com.quilibrium.quorummobile id that dev-start-emulator.ps1 launches.
Remove-Item Env:\ORG_GRADLE_PROJECT_sideBySide -ErrorAction SilentlyContinue

# Pin every adb call (Expo's install step) to the emulator so a connected phone
# can't receive this x86_64 build.
$env:ANDROID_SERIAL = $serial

# `expo run:android` also starts Metro and launches the app, so it needs the same
# hostname override as dev-start-emulator.ps1. This machine has a PERSISTENT user
# env var REACT_NATIVE_PACKAGER_HOSTNAME=<pc-lan-ip>; inherited, it makes the dev
# client fetch the bundle across the emulator's NAT to the host LAN address, where
# the chunked response is corrupted and the app hangs on "Bundling 100.0%..." with
# no on-screen error. See the long comment in dev-start-emulator.ps1.
$env:REACT_NATIVE_PACKAGER_HOSTNAME = "localhost"

Write-Host ""
Write-Host "  Building the emulator dev build (ABI=$abi, java.io.tmpdir=$asciiTemp)." -ForegroundColor Cyan
Write-Host "  Installs as com.quilibrium.quorummobile on $serial only." -ForegroundColor Cyan
Write-Host ""

# Fresh Gradle daemon so it picks up the ASCII tmpdir.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
cmd /c "`"$repoRoot\android\gradlew.bat`" --stop" 2>&1 | Out-Null
$ErrorActionPreference = $prevEAP

# Target the emulator by AVD name (Expo matches --device on the name). If we
# somehow couldn't read the AVD name, fall back to ANDROID_SERIAL alone.
if ($avdName) {
    yarn android --device "$avdName"
} else {
    Write-Host "  (AVD name unavailable; relying on ANDROID_SERIAL=$serial to target the install.)" -ForegroundColor DarkYellow
    yarn android
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "  Build succeeded and installed on $serial." -ForegroundColor Green
    Write-Host "  Now run:  .\.agents\scripts\dev-start-emulator.ps1   (for JS/TS iteration)"
} else {
    Write-Host ""
    Write-Host "  Build failed (exit $LASTEXITCODE)." -ForegroundColor Yellow
    Write-Host "  If the error shows an accented path, tell the agent so the tmpdir fix can be widened." -ForegroundColor Yellow
}
