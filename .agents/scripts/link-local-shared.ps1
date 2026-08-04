# link-local-shared.ps1
#
# Point mobile's node_modules/@quilibrium/quorum-shared at the LOCAL shared repo
# so you can develop + runtime-test mobile against unpublished shared changes
# (e.g. shared 2.1.0-30 before Cassie publishes it to npm).
#
# IMPORTANT DESIGN:
#   - package.json and yarn.lock are NEVER touched. The pin stays at whatever is
#     committed (currently 2.1.0-29). The redirect lives ONLY in node_modules,
#     which is gitignored, so nothing leaks to git / other branches / Cassie.
#   - The real npm-installed package is backed up so unlink restores it without a
#     full reinstall.
#   - Shared is REBUILT first (yarn build) so mobile never tests a stale dist.
#   - The npm package's NESTED node_modules is carried into the copy, and the
#     result is checked with verify-shared-externals.mjs. Shared's dist does not
#     bundle its deps, so a copy of dist/ alone silently repoints them at
#     mobile's hoisted (sometimes wrong-major) copies.
#
# Mechanism: a Windows JUNCTION (no admin needed, Metro's Node crawler follows it
# as a real dir). Use -Copy to do a plain directory copy instead (zero
# symlink/junction risk; re-run after each shared build).
#
# Usage:
#   .\.agents\scripts\link-local-shared.ps1            # build shared + junction
#   .\.agents\scripts\link-local-shared.ps1 -Copy      # build shared + copy
#   .\.agents\scripts\link-local-shared.ps1 -NoBuild   # skip shared rebuild
#
# Undo with: .\.agents\scripts\unlink-local-shared.ps1

param(
    [switch]$Copy,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'

$MobileRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # ...\quorum-mobile
$SharedRepo  = Join-Path (Split-Path -Parent $MobileRoot) 'quorum-shared'
$PkgDir      = Join-Path $MobileRoot 'node_modules\@quilibrium\quorum-shared'
$BackupDir   = Join-Path $MobileRoot 'node_modules\@quilibrium\.quorum-shared.npm-backup'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- sanity checks ---------------------------------------------------------
if (-not (Test-Path $SharedRepo))        { Fail "Local shared repo not found at $SharedRepo" }
if (-not (Test-Path (Join-Path $SharedRepo 'package.json'))) { Fail "$SharedRepo is not a package (no package.json)" }
if (-not (Test-Path (Join-Path $MobileRoot 'node_modules\@quilibrium'))) {
    Fail "node_modules/@quilibrium missing - run 'yarn install' in mobile first"
}

Write-Host "Mobile : $MobileRoot"
Write-Host "Shared : $SharedRepo"

# --- 1. rebuild shared so dist/ is fresh (kills the 'stale dist' footgun) ---
if (-not $NoBuild) {
    Write-Host "`n[1/4] Building quorum-shared (yarn build)..." -ForegroundColor Cyan
    Push-Location $SharedRepo
    try { & yarn build; if ($LASTEXITCODE -ne 0) { Fail "shared 'yarn build' failed" } }
    finally { Pop-Location }
} else {
    Write-Host "`n[1/4] -NoBuild: skipping shared rebuild (dist/ used as-is)" -ForegroundColor Yellow
}

$sharedVersion = (Get-Content (Join-Path $SharedRepo 'package.json') | ConvertFrom-Json).version
$pinnedVersion = ((Get-Content (Join-Path $MobileRoot 'package.json') | ConvertFrom-Json).dependencies.'@quilibrium/quorum-shared')
Write-Host "      local shared version : $sharedVersion"
Write-Host "      mobile package.json pin (UNCHANGED): $pinnedVersion"

# --- 2. back up the real npm-installed package (once) ----------------------
Write-Host "`n[2/4] Backing up the npm-installed package..." -ForegroundColor Cyan
$existingIsLink = $false
if (Test-Path $PkgDir) {
    $item = Get-Item $PkgDir -Force
    if ($item.LinkType) { $existingIsLink = $true }   # already a junction/symlink
}
if ($existingIsLink) {
    Write-Host "      already linked - removing the old link before relinking"
    (Get-Item $PkgDir -Force).Delete()
} elseif (Test-Path $PkgDir) {
    if (Test-Path $BackupDir) {
        Write-Host "      backup already exists - removing current (stale link copy?) dir"
        Remove-Item $PkgDir -Recurse -Force
    } else {
        Move-Item $PkgDir $BackupDir
        Write-Host "      npm package moved to $($BackupDir | Split-Path -Leaf)"
    }
}

# --- 3. create the junction (or copy) --------------------------------------
if ($Copy) {
    Write-Host "`n[3/5] COPY mode: copying shared repo into node_modules..." -ForegroundColor Cyan
    # Copy package.json + dist (what Metro resolves) + any runtime files.
    New-Item -ItemType Directory -Path $PkgDir | Out-Null
    Copy-Item (Join-Path $SharedRepo 'package.json') $PkgDir
    Copy-Item (Join-Path $SharedRepo 'dist') (Join-Path $PkgDir 'dist') -Recurse
    Write-Host "      copied package.json + dist/"

    # The shared dist does NOT bundle its deps - it externalizes them. The npm
    # package ships a NESTED node_modules with the exact versions it needs, and
    # dropping that tree makes those imports fall through to mobile's hoisted
    # copies. Where the hoisted version differs by a major that breaks the
    # bundle: shared imports "@noble/hashes/sha2", which the nested 1.8.0 exports
    # but mobile's hoisted 2.0.1 does not (2.x only exports "./sha2.js").
    # So carry the backed-up nested tree across.
    $BackupNodeModules = Join-Path $BackupDir 'node_modules'
    if (Test-Path $BackupNodeModules) {
        Copy-Item $BackupNodeModules (Join-Path $PkgDir 'node_modules') -Recurse
        $carried = (Get-ChildItem (Join-Path $PkgDir 'node_modules') -Directory).Count
        Write-Host "      carried over the npm package's nested node_modules ($carried entries)"
    } else {
        Write-Host "      WARNING: no nested node_modules in the backup to carry over." -ForegroundColor Yellow
        Write-Host "               If step [5/5] reports unresolved imports, run 'yarn install'" -ForegroundColor Yellow
        Write-Host "               to restore the npm package, then re-run this script." -ForegroundColor Yellow
    }
} else {
    Write-Host "`n[3/5] JUNCTION mode: linking node_modules dir -> shared repo..." -ForegroundColor Cyan
    New-Item -ItemType Junction -Path $PkgDir -Target $SharedRepo | Out-Null
    Write-Host "      junction: $PkgDir -> $SharedRepo"
}

# --- 4. verify git is clean (the hack must NOT be staged) ------------------
Write-Host "`n[4/5] Verifying git tree is unaffected..." -ForegroundColor Cyan
Push-Location $MobileRoot
try {
    $dirty = & git status --porcelain -- package.json yarn.lock
    if ($dirty) { Fail "package.json/yarn.lock changed - they must stay untouched! $dirty" }
    Write-Host "      package.json + yarn.lock unchanged (good)"
} finally { Pop-Location }

# --- 5. verify shared's own deps still resolve from the swapped-in dir ------
# Catches the "copy dropped the nested node_modules" break BEFORE a 2-minute
# cold bundle fails on it, and any future dep drift between shared and mobile.
Write-Host "`n[5/5] Verifying shared's externalized deps resolve..." -ForegroundColor Cyan
& node (Join-Path $PSScriptRoot 'verify-shared-externals.mjs') $PkgDir
if ($LASTEXITCODE -ne 0) { Fail "shared's dependencies do not resolve from the linked package (see above) - Metro would fail the bundle" }

# confirm the resolved version mobile will now see
$resolved = (Get-Content (Join-Path $PkgDir 'package.json') | ConvertFrom-Json).version
Write-Host "`nLINKED. Mobile now resolves @quilibrium/quorum-shared@$resolved (LOCAL)" -ForegroundColor Green
Write-Host "Next: restart Metro with a CLEARED cache so it picks up the swap:" -ForegroundColor Yellow
Write-Host "      yarn start --clear     (or: npx expo start -c)"
Write-Host "Verify: import a -30 symbol (e.g. getRoleColorHex) and confirm the bundle resolves it."
Write-Host "If Metro can't resolve the junction, re-run with -Copy."
Write-Host "Undo: .\.agents\scripts\unlink-local-shared.ps1"
