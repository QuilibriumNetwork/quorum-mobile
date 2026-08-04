# Shared bootstrap for the PowerShell dev scripts in this folder.
#
# Dot-source it as the first line of any script here:
#     . "$PSScriptRoot\_env.ps1"
#
# It gives you:
#   $repo        - the repository root, derived from this file's location, so the
#                  scripts work from any clone on any machine and any drive.
#   $captureDir  - where logcat/trace captures are written.
#   any KEY=VALUE pairs from .env.local, exported as environment variables.
#
# .env.local is gitignored and holds machine-local paths only. Copy
# .env.local.example to .env.local and edit it. Everything in it is optional -
# the defaults below work out of the box.

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$envFile = Join-Path $PSScriptRoot '.env.local'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $kv = $t -split '=', 2
        if ($kv.Count -eq 2) {
            $key = $kv[0].Trim()
            $val = $kv[1].Trim().Trim('"').Trim("'")
            Set-Item -Path ("Env:" + $key) -Value $val
        }
    }
}

# Capture output directory. Deliberately OUTSIDE the repo: logcat/XPTRACE
# captures can contain real key material, so they must never sit in a working
# tree where a stray `git add -f`, a backup tool or a published branch could
# pick them up. Override with QM_CAPTURE_DIR in .env.local.
if (-not $env:QM_CAPTURE_DIR) {
    $env:QM_CAPTURE_DIR = Join-Path $env:LOCALAPPDATA 'quorum-mobile\captures'
}
$captureDir = $env:QM_CAPTURE_DIR
# Not created here: creating it on every script run litters empty folders. The
# scripts that actually write captures create it on demand.
