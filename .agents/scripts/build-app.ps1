# build-app.ps1 - one-button native rebuild + install for the phone.
#
# WHY THIS EXISTS:
# The Windows account name contains an accented character ("redacted name").
# The Android Gradle Plugin creates a prefab staging dir under the JVM temp dir 
# (java.io.tmpdir), which by default resolves under the accented user profile.
# A Java tool in the NitroModules C++ build then mangles the accent into "??"
# and the build dies with:
#   "invalid value for --output: Illegal char <?> ... redacted name ..."
# It is intermittent - only fires when the C++ artifacts need regenerating
# (cache miss), which is why rebuilds seem to "randomly" fail.
#
# THE FIX: force the Gradle DAEMON's java.io.tmpdir onto an ASCII-only path
# (<local temp>/) so no accented character ever reaches the C++ toolchain. Setting
# TMP/TEMP does NOT work - AGP reads java.io.tmpdir (the JVM temp), not those.
# We set it via JAVA_TOOL_OPTIONS + GRADLE_OPTS (honored by the daemon JVM) and
# stop any running daemon first so a fresh one picks up the new tmpdir.
#
# USAGE - run from the repo root when you need to (re)build the app:
#   .\.agents\scripts\build-app.ps1
#
# By default this builds arm64-v8a ONLY (both physical test phones are arm64;
# we never use the x86 emulator). Pass -AllAbis to build the full ABI set.

param(
    # Build every Android ABI (armeabi-v7a, arm64-v8a, x86, x86_64) instead of just
    # arm64-v8a. Only needed for an x86 emulator or a genuinely 32-bit device - our
    # test phones (Motorola Edge 50 Fusion, Samsung Galaxy A40) are both arm64-v8a.
    [switch]$AllAbis
)

$ErrorActionPreference = 'Stop'

# ASCII-safe temp dir (no accented chars in the path) - create if missing.
$asciiTemp = if ($env:QM_ASCII_TEMP) { $env:QM_ASCII_TEMP } else { 'C:\Temp\' }
if (-not (Test-Path $asciiTemp)) {
    New-Item -ItemType Directory -Path $asciiTemp | Out-Null
    Write-Host "Created $asciiTemp" -ForegroundColor DarkGray
}

# Force the JVM temp dir onto the ASCII path. JAVA_TOOL_OPTIONS is honored by
# every JVM at startup (incl. the Gradle daemon); GRADLE_OPTS is belt+suspenders.
$tmpArg = "-Djava.io.tmpdir=$asciiTemp"
$env:JAVA_TOOL_OPTIONS = $tmpArg
$env:GRADLE_OPTS = $tmpArg
# Also keep TMP/TEMP aligned (harmless, helps any tool that does read them).
$env:TMP = $asciiTemp
$env:TEMP = $asciiTemp

Write-Host "Building app with java.io.tmpdir=$asciiTemp ..." -ForegroundColor Cyan
Write-Host "(Works around the accented-username native build bug.)" -ForegroundColor DarkGray
Write-Host ""

# Repo root (this script lives in .agents\scripts\). Needed by the pre-flight below.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

# --- Windows MAX_PATH (260 char) pre-flight ---------------------------------
# RN New Architecture C++ codegen mirrors each source file's FULL path into its
# ninja object path under android\app\.cxx\... On a deep repo path this blows
# past CMake's 250-char object-path cap (CMAKE_OBJECT_PATH_MAX) and the build
# dies near the end with:
#   "ninja: error: Stat(...ShadowNode.cpp.o): Filename longer than 260 characters"
#
# IMPORTANT (verified 2026-06-16): enabling Win32 long paths in the registry
# (LongPathsEnabled=1) does NOT fix this - the build failed here with the flag
# already ON, because CMake/ninja enforce their own 250-char cap regardless.
# The REAL fix is upgrading the offending library to a version whose codegen
# uses short file names. The current offender is react-native-keyboard-controller:
# the fix landed upstream in v1.20.5 (PR #1248). If you are below that, the
# native build will fail no matter what this script does - bump the dep first.
#
# We still flip LongPathsEnabled on (harmless Windows hygiene, helps OTHER deep
# paths) but we do NOT pretend it solves the codegen case. And we warn loudly if
# the vulnerable kbc version is installed so you don't burn another ~4-9 min.
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
        $v = [version]($kbcVer -replace '-.*$','')   # strip any -beta suffix
        if ($v -lt [version]'1.20.5') { $bad = $true }
    } catch { }
    if ($bad) {
        Write-Host ""
        Write-Host "WARNING: react-native-keyboard-controller $kbcVer is installed." -ForegroundColor Yellow
        Write-Host "Versions < 1.20.5 trigger the Windows 260-char native build failure" -ForegroundColor Yellow
        Write-Host "('Filename longer than 260 characters'). The fix is to UPGRADE the dep" -ForegroundColor Yellow
        Write-Host "to >= 1.20.5 (PR #1248) - LongPathsEnabled does NOT work around it." -ForegroundColor Yellow
        Write-Host "See .agents/scripts (handoff prompt) before bumping - it's a shared dep." -ForegroundColor Yellow
        Write-Host ""
        $ans = Read-Host "Build anyway (will likely fail ~4-9 min in)? (y/N)"
        if ($ans -notmatch '^[Yy]') {
            Write-Host "Aborted. Upgrade react-native-keyboard-controller to >= 1.20.5 first." -ForegroundColor DarkGray
            exit 1
        }
    }
}

# Move to the repo root ($repoRoot was resolved above for the pre-flight).
Set-Location $repoRoot

# CRITICAL: side-by-side install. The debug buildType only gets the
# `.debug` applicationIdSuffix when the `sideBySide` Gradle property is set
# (android/app/build.gradle). Without it, the dev build uses the SAME package
# name as the real production app (com.quilibrium.quorummobile) and would try
# to install OVER it - which collides with the real app and risks the user's
# real data. With it, the dev build installs as com.quilibrium.quorummobile.debug
# ALONGSIDE the real app, never touching it.
# ORG_GRADLE_PROJECT_<name> is Gradle's standard env-var injection for project
# properties - works regardless of how expo forwards args to gradle.
$env:ORG_GRADLE_PROJECT_sideBySide = 'true'

# --- Target ABI(s) -----------------------------------------------------------
# Default to arm64-v8a ONLY. Both physical test devices (Motorola Edge 50 Fusion,
# Samsung Galaxy A40 - the A40's Exynos 7904 is a 64-bit arm64 chip too) are
# arm64-v8a, and we never use the x86 emulator. Building the full set doubles the
# native (CMake/ninja) compile and forces a slow cross-drive copy of the big
# libreactnative.so once PER ABI (a Gradle cache on a different drive from the
# build output cannot hard-link).
# Overrides the committed gradle.properties default via Gradle's env injection
# (same mechanism as sideBySide) - the committed file stays broad for EAS/store.
if ($AllAbis) {
    $env:ORG_GRADLE_PROJECT_reactNativeArchitectures = 'armeabi-v7a,arm64-v8a,x86,x86_64'
    Write-Host "Building ALL ABIs (armeabi-v7a, arm64-v8a, x86, x86_64) - slower." -ForegroundColor Yellow
} else {
    $env:ORG_GRADLE_PROJECT_reactNativeArchitectures = 'arm64-v8a'
    Write-Host "Building arm64-v8a only (Edge 50 + Galaxy A40). Use -AllAbis for the emulator/32-bit." -ForegroundColor DarkGray
}

# Stop any running Gradle daemon so a fresh one starts with the new tmpdir.
# A daemon already running under the old (accented) tmpdir would be reused
# otherwise and the fix wouldn't take effect.
# (The JVM prints "Picked up JAVA_TOOL_OPTIONS" to stderr; that's not an error,
# so relax ErrorActionPreference around the daemon stop to avoid a false abort.)
Write-Host "Stopping any running Gradle daemon..." -ForegroundColor DarkGray
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
cmd /c "`"$repoRoot\android\gradlew.bat`" --stop" 2>&1 | Out-Null
$ErrorActionPreference = $prevEAP

# Native rebuild + install. Installs as the .debug package (side-by-side),
# so it never touches the real production app.
Write-Host "Building the .debug variant (installs alongside your real app)..." -ForegroundColor DarkGray
yarn android

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Build succeeded and app installed." -ForegroundColor Green
    Write-Host "Now run dev-start-mobile.ps1 for JS/TS iteration."
} else {
    Write-Host ""
    Write-Host "Build failed (exit $LASTEXITCODE)." -ForegroundColor Yellow
    Write-Host "If the error still shows an accented path, tell the agent so the fix can be widened." -ForegroundColor Yellow
}
