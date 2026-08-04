# unlink-local-shared.ps1
#
# Undo link-local-shared.ps1: restore the npm-installed @quilibrium/quorum-shared
# so mobile is back on the pinned registry version (package.json was never
# changed, so this just restores node_modules to a clean state).
#
# Restores from the backup link-local-shared made (fast). If no backup exists,
# falls back to `yarn install` (re-fetches the pinned version from npm).
#
# Usage:
#   .\.agents\scripts\unlink-local-shared.ps1            # restore from backup
#   .\.agents\scripts\unlink-local-shared.ps1 -Reinstall # force a clean yarn install

param(
    [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'

$MobileRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$PkgDir     = Join-Path $MobileRoot 'node_modules\@quilibrium\quorum-shared'
$BackupDir  = Join-Path $MobileRoot 'node_modules\@quilibrium\.quorum-shared.npm-backup'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

Write-Host "Mobile : $MobileRoot"

# --- remove the current link/copy ------------------------------------------
if (Test-Path $PkgDir) {
    $item = Get-Item $PkgDir -Force
    if ($item.LinkType) {
        Write-Host "Removing junction/symlink at node_modules/@quilibrium/quorum-shared"
        $item.Delete()                       # deletes the link, NOT the shared repo
    } else {
        Write-Host "Removing the linked/copied directory"
        Remove-Item $PkgDir -Recurse -Force
    }
}

# --- restore ---------------------------------------------------------------
if ($Reinstall) {
    Write-Host "`n-Reinstall: running a clean yarn install..." -ForegroundColor Cyan
    if (Test-Path $BackupDir) { Remove-Item $BackupDir -Recurse -Force }
    Push-Location $MobileRoot
    try { & yarn install; if ($LASTEXITCODE -ne 0) { Fail "yarn install failed" } }
    finally { Pop-Location }
} elseif (Test-Path $BackupDir) {
    Write-Host "`nRestoring the npm-installed package from backup..." -ForegroundColor Cyan
    Move-Item $BackupDir $PkgDir
    Write-Host "      restored."
} else {
    Write-Host "`nNo backup found - running yarn install to refetch the pinned version..." -ForegroundColor Yellow
    Push-Location $MobileRoot
    try { & yarn install; if ($LASTEXITCODE -ne 0) { Fail "yarn install failed" } }
    finally { Pop-Location }
}

# --- report -----------------------------------------------------------------
if (Test-Path (Join-Path $PkgDir 'package.json')) {
    $resolved = (Get-Content (Join-Path $PkgDir 'package.json') | ConvertFrom-Json).version
    $pinned   = ((Get-Content (Join-Path $MobileRoot 'package.json') | ConvertFrom-Json).dependencies.'@quilibrium/quorum-shared')
    Write-Host "`nUNLINKED. Mobile resolves @quilibrium/quorum-shared@$resolved (npm); package.json pin: $pinned" -ForegroundColor Green
} else {
    Write-Host "`nUNLINKED, but the package dir is missing - run 'yarn install' in mobile." -ForegroundColor Yellow
}
Write-Host "Restart Metro with cleared cache: yarn start --clear"
