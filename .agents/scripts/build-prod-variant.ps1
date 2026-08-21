# build-prod-variant.ps1 - one-button RELEASE (production-variant) build + install.
#
# WHY THIS EXISTS:
# Verify whether the "composer area above the tab bar slides in low / snaps at
# transition end" glitch happens in a RELEASE build, or is only a dev-build
# artifact. See .agents/tasks/2026-06-20-production-variant-build-for-composer-
# verification.md and .agents/bugs/2026-06-20-composer-drops-behind-tab-bar-...
#
# It clones the accented-username + MAX_PATH preflight from build-app.ps1, but
# builds the RELEASE variant with -PpreviewVariant=true so it installs as the
# THIRD applicationId `com.quilibrium.quorummobile.preview`, coexisting with:
#   com.quilibrium.quorummobile        (LIVE - real user data - NEVER touch)
#   com.quilibrium.quorummobile.debug  (current debug build      - don't touch)
#
# SAFETY: before installing, it dumps the built APK's actual applicationId and
# REFUSES to install unless it reads `...preview`. If the previewVariant flag
# silently fails to apply, a release build emits the LIVE id and `adb install -r`
# would OVERWRITE the real app - this guard prevents that.
#
# USAGE - run from the repo root:
#   .\.agents\scripts\build-prod-variant.ps1
#
# Phone must be connected via USB (adb device authorized, not the :5555 Wi-Fi entry).
#
# By default this builds arm64-v8a ONLY (the physical test phone is arm64; we never
# use the x86 emulator). Pass -AllAbis to build the full ABI set.

param(
    # Build every Android ABI (armeabi-v7a, arm64-v8a, x86, x86_64) instead of just
    # arm64-v8a. Only needed for an x86 emulator or a genuinely 32-bit device.
    [switch]$AllAbis
)

$ErrorActionPreference = 'Stop'

$LIVE_ID    = 'com.quilibrium.quorummobile'
$DEBUG_ID   = 'com.quilibrium.quorummobile.debug'
$PREVIEW_ID = 'com.quilibrium.quorummobile.preview'

# --- ASCII-safe temp dir (accented-username NitroModules C++ build bug) -------
$asciiTemp = if ($env:QM_ASCII_TEMP) { $env:QM_ASCII_TEMP } else { 'C:\Temp\' }
if (-not (Test-Path $asciiTemp)) {
    New-Item -ItemType Directory -Path $asciiTemp | Out-Null
    Write-Host "Created $asciiTemp" -ForegroundColor DarkGray
}
$tmpArg = "-Djava.io.tmpdir=$asciiTemp"
$env:JAVA_TOOL_OPTIONS = $tmpArg
# Release build (full Kotlin compile + minify) exhausts the committed gradle.properties
# Metaspace cap (512m) and the daemon dies with java.lang.OutOfMemoryError: Metaspace.
# Bump heap + Metaspace here via GRADLE_OPTS (a LOCAL override - we do NOT edit the
# committed android/gradle.properties, which EAS and other devs share). GRADLE_OPTS is
# applied to the daemon JVM on top of the file's jvmargs.
$env:GRADLE_OPTS = "$tmpArg -Xmx4096m -XX:MaxMetaspaceSize=1024m"
$env:TMP = $asciiTemp
$env:TEMP = $asciiTemp

Write-Host "Building RELEASE (.preview) variant with java.io.tmpdir=$asciiTemp ..." -ForegroundColor Cyan
Write-Host "(Works around the accented-username native build bug.)" -ForegroundColor DarkGray
Write-Host ""

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

# --- Windows MAX_PATH (260 char) pre-flight ----------------------------------
$longPaths = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
if ($longPaths -ne 1) {
    Write-Host "Enabling Win32 long paths (general hygiene; approve the UAC prompt)..." -ForegroundColor DarkGray
    Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
        '-NoProfile','-Command',
        'reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f'
    ) | Out-Null
}

# Detect the path-length-vulnerable react-native-keyboard-controller (< 1.20.5).
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
        Write-Host "WARNING: react-native-keyboard-controller $kbcVer is installed (< 1.20.5)." -ForegroundColor Yellow
        Write-Host "This triggers the Windows 260-char native build failure. Upgrade first." -ForegroundColor Yellow
        $ans = Read-Host "Build anyway (will likely fail ~4-9 min in)? (y/N)"
        if ($ans -notmatch '^[Yy]') {
            Write-Host "Aborted. Upgrade react-native-keyboard-controller to >= 1.20.5 first." -ForegroundColor DarkGray
            exit 1
        }
    }
}

Set-Location $repoRoot

# --- Prime the adb server BEFORE any adb call whose output we capture --------
# On a COLD adb (server not yet running) `$x = & adb devices` NEVER RETURNS on
# Windows. PowerShell captures a native command's output through a pipe; the
# server that `adb devices` forks inherits that pipe's write handle and holds it
# open for its whole lifetime, so PowerShell waits forever for an EOF that cannot
# arrive. The symptom is the script freezing immediately after adb prints
# "* daemon started successfully", with no further output.
#
# Spawning through `cmd /c ... >nul` is the ONLY priming that works, because cmd
# hands the server a NUL handle instead of our pipe. MEASURED 2026-08-21 on four
# private adb ports: `& adb start-server | Out-Null` and
# `Start-Process adb start-server -Wait` both hang exactly the same way (they
# also give the server a pipe); only the cmd form returned.
#
# This stayed hidden for months because the server is normally already warm from
# dev-start-mobile.ps1 / the emulator scripts, and a warm `start-server` forks
# nothing. It only bites on the first adb call after a reboot or `adb kill-server`.
cmd /c "adb start-server >nul 2>&1"

# --- Confirm a USB device is connected & authorized --------------------------
$adbDevices = & adb devices
$usbDevice = $adbDevices | Select-String -Pattern '^\S+\s+device$' | Where-Object { $_ -notmatch ':5555' }
if (-not $usbDevice) {
    Write-Host "No authorized USB adb device found. Connect the phone via USB and authorize it." -ForegroundColor Red
    Write-Host "adb devices output:" -ForegroundColor DarkGray
    $adbDevices | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    exit 1
}
# Extract the serial of the first authorized USB device for targeted adb calls.
$serial = ($usbDevice[0] -split '\s+')[0]
Write-Host "Using USB device: $serial" -ForegroundColor DarkGray

# --- Pre-install package snapshot (must be exactly LIVE + DEBUG) -------------
Write-Host "Packages BEFORE build:" -ForegroundColor DarkGray
$before = & adb -s $serial shell pm list packages | Select-String 'quilibrium'
$before | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

# --- The previewVariant flag (Gradle env-var injection) ----------------------
$env:ORG_GRADLE_PROJECT_previewVariant = 'true'

# --- Target ABI(s) -----------------------------------------------------------
# Default to arm64-v8a ONLY (the connected test phone is arm64; we never use the
# x86 emulator). Building the full set doubles the native compile and forces a
# slow cross-drive copy of libreactnative.so per ABI. Overrides the committed
# gradle.properties default locally (same env-injection as previewVariant above);
# the committed file stays broad for EAS/store builds. Pass -AllAbis to restore.
if ($AllAbis) {
    $env:ORG_GRADLE_PROJECT_reactNativeArchitectures = 'armeabi-v7a,arm64-v8a,x86,x86_64'
    Write-Host "Building ALL ABIs (armeabi-v7a, arm64-v8a, x86, x86_64) - slower." -ForegroundColor Yellow
} else {
    $env:ORG_GRADLE_PROJECT_reactNativeArchitectures = 'arm64-v8a'
    Write-Host "Building arm64-v8a only. Use -AllAbis for the emulator/32-bit." -ForegroundColor DarkGray
}

# The Gradle build root is android/ (where gradlew.bat + settings.gradle live).
# gradlew resolves the build dir from cwd, so we Set-Location into android/ for
# the gradle calls (passing -p is unreliable with the RN wrapper's path logic).
$androidDir = Join-Path $repoRoot 'android'

# Stop any running Gradle daemon so a fresh one picks up the new tmpdir.
Write-Host "Stopping any running Gradle daemon..." -ForegroundColor DarkGray
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location $androidDir
cmd /c "`"$androidDir\gradlew.bat`" --stop" 2>&1 | Out-Null
Pop-Location
$ErrorActionPreference = $prevEAP

# --- Force a FRESH JS bundle + embedded assets on EVERY run -------------------
# WHY (bug found 2026-07-21): Gradle treats the JS-bundle and expo-updates
# asset-embedding tasks as up-to-date when only files under assets/ change, so a
# rebuild silently ships a STALE bundle + embedded asset manifest. That is how
# the Apex icon (asset added 2026-06-16) stayed blank in release for weeks: the
# embedded manifest was last generated 2026-06-11 and never regenerated, so the
# image was never embedded and RN could not resolve it at runtime. Deleting
# these generated outputs forces the bundle + manifest (and their downstream
# merge/package tasks) to regenerate against the CURRENT source every run, while
# the native (.so / Kotlin) compile stays incrementally cached (so this is NOT a
# full ~30-min clean rebuild). This makes "run the script" ALWAYS reflect the
# current JS + assets, which is the behaviour we want for a verification build.
Write-Host "Forcing fresh JS bundle + embedded assets (clearing stale generated outputs)..." -ForegroundColor Cyan
$staleGenerated = @(
    'app\build\generated\assets\createBundleReleaseJsAndAssets',
    'app\build\generated\assets\createReleaseUpdatesResources',
    'app\build\generated\res\createBundleReleaseJsAndAssets',
    'app\build\intermediates\assets\release',
    'app\build\intermediates\merged_res\release',
    'app\build\intermediates\packaged_res\release'
)
foreach ($rel in $staleGenerated) {
    $full = Join-Path $androidDir $rel
    if (Test-Path $full) {
        Remove-Item -Recurse -Force $full -ErrorAction SilentlyContinue
        Write-Host "  cleared $rel" -ForegroundColor DarkGray
    }
}

# --- Build the release APK (no install yet - APK id guard must run first) ----
Write-Host ""
Write-Host "Assembling RELEASE APK (-PpreviewVariant=true). This is slower than debug (~5-12 min)..." -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'
# Pass the heap/Metaspace bump explicitly as a Gradle command-line property too.
# `-Dorg.gradle.jvmargs=...` on the CLI overrides the committed gradle.properties
# value unambiguously (GRADLE_OPTS alone can be shadowed by the file's jvmargs).
$jvmArgs = "$tmpArg -Xmx4096m -XX:MaxMetaspaceSize=1024m"
Push-Location $androidDir
cmd /c "`"$androidDir\gradlew.bat`" :app:assembleRelease `"-Dorg.gradle.jvmargs=$jvmArgs`""
$buildExit = $LASTEXITCODE
Pop-Location
$ErrorActionPreference = 'Stop'

if ($buildExit -ne 0) {
    Write-Host ""
    Write-Host "Build failed (exit $buildExit)." -ForegroundColor Yellow
    Write-Host "If the error still shows an accented path, tell the agent so the fix can be widened." -ForegroundColor Yellow
    exit $buildExit
}

$apk = Join-Path $repoRoot 'android\app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) {
    Write-Host "Build reported success but APK not found at $apk" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "Build succeeded: $apk" -ForegroundColor Green

# --- SAFETY GUARD: inspect the APK's actual applicationId BEFORE installing ---
# Find the newest aapt.exe under build-tools.
$buildTools = Join-Path $env:ANDROID_HOME 'build-tools'
$aapt = Get-ChildItem -Path $buildTools -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'aapt.exe' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
if (-not $aapt) {
    Write-Host "Could not locate aapt.exe under $buildTools - cannot verify APK id. ABORTING (will not install blind)." -ForegroundColor Red
    exit 1
}

$badging = & $aapt dump badging $apk
$pkgLine = $badging | Select-String "package: name="
$apkId = $null
if ($pkgLine -match "package: name='([^']+)'") { $apkId = $Matches[1] }

Write-Host ""
Write-Host "APK applicationId (from aapt): $apkId" -ForegroundColor Cyan

if ($apkId -ne $PREVIEW_ID) {
    Write-Host ""
    Write-Host "ABORT: APK id is '$apkId', expected '$PREVIEW_ID'." -ForegroundColor Red
    Write-Host "The previewVariant flag did NOT apply. Installing would risk overwriting" -ForegroundColor Red
    Write-Host "the LIVE app ($LIVE_ID). NOT INSTALLING. Fix the gradle edit and rebuild." -ForegroundColor Red
    exit 1
}
Write-Host "APK id confirmed as the .preview variant - safe to install." -ForegroundColor Green

# --- Install (now safe) ------------------------------------------------------
Write-Host ""
Write-Host "Installing $PREVIEW_ID ..." -ForegroundColor Cyan
& adb -s $serial install -r $apk
$installExit = $LASTEXITCODE
if ($installExit -ne 0) {
    Write-Host "adb install failed (exit $installExit)." -ForegroundColor Red
    exit $installExit
}

# --- Post-install package snapshot (must be LIVE + DEBUG + PREVIEW = 3) -------
Write-Host ""
Write-Host "Packages AFTER install:" -ForegroundColor DarkGray
$after = & adb -s $serial shell pm list packages | Select-String 'quilibrium'
$after | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

$afterIds = $after | ForEach-Object { ($_ -replace '^package:','').Trim() }
$haveLive    = $afterIds -contains $LIVE_ID
$haveDebug   = $afterIds -contains $DEBUG_ID
$havePreview = $afterIds -contains $PREVIEW_ID

Write-Host ""
if ($haveLive -and $haveDebug -and $havePreview) {
    Write-Host "OK: all three apps coexist (live + debug + preview). Real app untouched." -ForegroundColor Green
} else {
    Write-Host "WARNING: expected all three ids present. live=$haveLive debug=$haveDebug preview=$havePreview" -ForegroundColor Yellow
}

# --- Launch the .preview app explicitly (avoid deep-link disambiguation) ------
# NOTE: applicationIdSuffix changes the install id but NOT the code package, so the
# Activity class stays com.quilibrium.quorummobile.MainActivity. The leading-dot
# shorthand (`$PREVIEW_ID/.MainActivity`) would wrongly expand to
# ...preview.MainActivity, which does not exist. Use the FULL class name.
$mainActivity = 'com.quilibrium.quorummobile.MainActivity'
Write-Host ""
Write-Host "Launching $PREVIEW_ID/$mainActivity ..." -ForegroundColor Cyan
& adb -s $serial shell am start -n "$PREVIEW_ID/$mainActivity"

Write-Host ""
Write-Host "Done. Open a channel + a DM and watch the area above the tab bar during slide-in." -ForegroundColor Green
Write-Host "Use 'Show layout bounds' to see whether it slides in low / snaps at transition end." -ForegroundColor Green
