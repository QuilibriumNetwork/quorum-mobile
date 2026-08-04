# One-time fix: allow inbound TCP 8081 (Metro) through Windows Firewall.
#
# WHY THIS EXISTS:
#   The Expo dev client on a physical device fetches the JS bundle from Metro
#   at the PC's LAN IP (e.g. http://<pc-lan-ip>:8081). Expo rewrites a typed
#   "localhost" back to the LAN IP, so the adb-reverse/USB trick is NOT enough
#   on its own. Windows Firewall blocks inbound 8081 by default, so the phone's
#   request is silently dropped and the app shows:
#       "There was a problem loading the project.
#        java.lang.RuntimeException: Unable to load script."
#   Opening this ONE port is the actual root-cause fix. It makes BOTH the
#   Wi-Fi/LAN path and the USB path work, with no per-launch dance.
#
# RUN ONCE (needs admin — this script self-elevates):
#   powershell -ExecutionPolicy Bypass -File .\.agents\scripts\allow-metro-firewall.ps1
#
# SAFE: only opens 8081 for inbound TCP on Private/Domain profiles (not Public),
# so it's not exposed on untrusted networks. Idempotent — re-running is a no-op.

# Self-elevate to admin if not already
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting administrator privileges..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$ruleName = "Metro Bundler 8081 (React Native dev)"

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Firewall rule already exists: '$ruleName'. Nothing to do." -ForegroundColor Green
}
else {
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort 8081 `
        -Profile Private, Domain `
        | Out-Null
    Write-Host "Created firewall rule: '$ruleName' (inbound TCP 8081, Private+Domain)." -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Your phone can now reach Metro at your PC's LAN IP over Wi-Fi." -ForegroundColor Cyan
Write-Host "Press any key to close..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
