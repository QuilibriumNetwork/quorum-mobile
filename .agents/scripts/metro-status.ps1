# Show (and optionally kill) ONLY this project's Metro/Expo node processes.
#
# Why this exists: Task Manager lumps every node-based runtime under
# "Node.js JavaScript Runtime" - VS Code's extension host / TS server / pty
# host, Brave & Electron helpers, MCP servers, one-off `tsc` runs, AND your
# Metro dev server all show up the same. So a long list there is NOT evidence
# of leaked Metro processes. This script filters to ONLY the Metro/Expo tree
# by command line, so you can see the real picture at a glance.
#
# A healthy SINGLE dev environment is normally 4 node processes:
#   yarn start:lazy            (the launcher)
#     -> cmd.exe shim          (yarn's intermediate shell, not node)
#          -> expo / Metro     (the server, ~1-1.5 GB)
#               -> jest-worker (bundler worker #1)   } count == --max-workers
#               -> jest-worker (bundler worker #2)   }
#
# Usage:
#   .\.agents\scripts\metro-status.ps1            # list the Metro tree only
#   .\.agents\scripts\metro-status.ps1 -Kill      # kill ORPHANED Metro trees (safe)
#   .\.agents\scripts\metro-status.ps1 -Kill -All # kill ALL Metro (even the live one)
#
# -Kill (default): only kills Metro whose ancestor interactive shell is gone
#   (true leaks). Leaves a running dev session and all unrelated node alone.
# -Kill -All: nukes every Metro/Expo node for THIS project, running or not.
#   Use when you just want a clean slate. Still never touches MCP/tsc/VS Code.
param(
    [switch]$Kill,
    [switch]$All
)

. "$PSScriptRoot\_env.ps1"

# Match only the Metro/Expo tree. These substrings appear in the command line
# of the launcher, the server, and its workers respectively. We additionally
# require the repo path OR a metro/expo/jest-worker token so we never match an
# unrelated node process that merely happens to mention "start".
$metroTokens = @('expo\bin\cli', 'expo/bin/cli', 'start:lazy', 'jest-worker', 'metro')

# Pull every node process with its command line + parent. Using CIM (no
# external powershell.exe call needed; runs fine inside this script).
$nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object {
        $cl = $_.CommandLine
        if (-not $cl) { return $false }
        # Must look like Metro/Expo AND belong to this repo (or be a worker,
        # whose command line is the bare jest-worker path under this repo).
        $isMetro = $false
        foreach ($t in $metroTokens) { if ($cl -like "*$t*") { $isMetro = $true; break } }
        $inRepo  = $cl -like "*$($repo)*" -or $cl -like "*quorum-mobile*"
        # The yarn launcher's command line is a corepack path that does NOT
        # mention the repo (e.g. `corepack/dist/yarn.js start:lazy ...`), so the
        # repo gate would wrongly drop it. `start:lazy` is unambiguous enough on
        # its own - it's our custom npm script name, used nowhere else - so let
        # it through without the repo check.
        $isLauncher = $cl -like '*start:lazy*'
        $isMetro -and ($inRepo -or $isLauncher)
    }

if (-not $nodeProcs) {
    Write-Host "No Metro/Expo node processes for this project are running." -ForegroundColor Green
    Write-Host "(Any node you see in Task Manager is VS Code / Brave / MCP / tsc, not Metro.)" -ForegroundColor DarkGray
    return
}

# Helper: walk up the parent chain. Metro is "orphaned" if we never reach a
# live interactive shell (powershell.exe / pwsh.exe / WindowsTerminal / a VS
# Code terminal). If the chain dead-ends at a non-existent parent, it leaked.
function Test-Orphaned([int]$startPid) {
    $cur = $startPid
    $hops = 0
    while ($hops -lt 12) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $p) { return $true }                    # parent gone -> orphan
        if (-not $p.ParentProcessId) { return $true }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
        if (-not $parent) { return $true }               # dead parent -> orphan
        switch -Wildcard ($parent.Name) {
            'powershell.exe' { return $false }           # reached a live shell
            'pwsh.exe'       { return $false }
            'WindowsTerminal.exe' { return $false }
            'Code.exe'       { return $false }           # VS Code integrated terminal
            'explorer.exe'   { return $false }
        }
        $cur = $p.ParentProcessId
        $hops++
    }
    return $false  # chain intact but deep; treat as not-orphaned (safe default)
}

Write-Host ""
Write-Host "  Metro / Expo node processes for quorum-mobile:" -ForegroundColor Cyan
Write-Host ""

$rows = foreach ($n in $nodeProcs) {
    $mb = [math]::Round($n.WorkingSetSize / 1MB)
    $kind =
        if ($n.CommandLine -like '*start:lazy*' -or $n.CommandLine -like '*corepack*yarn*') { 'launcher (yarn)' }
        elseif ($n.CommandLine -like '*expo*bin*cli*') { 'Metro server' }
        elseif ($n.CommandLine -like '*jest-worker*') { 'bundler worker' }
        else { 'metro (other)' }
    $orphan = Test-Orphaned $n.ProcessId
    [PSCustomObject]@{
        PID     = $n.ProcessId
        Kind    = $kind
        MemMB   = $mb
        Orphan  = if ($orphan) { 'YES' } else { '-' }
        _orphan = $orphan
    }
}

$rows | Format-Table PID, Kind, MemMB, Orphan -AutoSize | Out-String | Write-Host

$total = ($nodeProcs | Measure-Object WorkingSetSize -Sum).Sum / 1MB
$orphanRows = $rows | Where-Object { $_._orphan }
Write-Host ("  Total: {0} process(es), {1} MB resident." -f $nodeProcs.Count, [math]::Round($total)) -ForegroundColor DarkGray
if ($orphanRows) {
    Write-Host ("  {0} ORPHANED (leaked) process(es) detected." -f $orphanRows.Count) -ForegroundColor Yellow
} else {
    Write-Host "  No orphans - this is a healthy live dev session." -ForegroundColor Green
}
Write-Host ""

if (-not $Kill) {
    Write-Host "  Run with -Kill to remove orphaned Metro (safe), or -Kill -All to stop everything." -ForegroundColor DarkGray
    return
}

# --- Kill path -------------------------------------------------------------
$targets =
    if ($All) { $nodeProcs }
    else { $nodeProcs | Where-Object { (Test-Orphaned $_.ProcessId) } }

if (-not $targets) {
    if ($All) {
        Write-Host "  Nothing to kill." -ForegroundColor Green
    } else {
        Write-Host "  No orphaned Metro to kill. (Use -All to also stop the live session.)" -ForegroundColor Green
    }
    return
}

$label = if ($All) { "ALL Metro" } else { "orphaned Metro" }
Write-Host ("  Killing {0} {1} process(es)..." -f $targets.Count, $label) -ForegroundColor Yellow
foreach ($t in $targets) {
    try {
        Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop
        Write-Host ("    killed PID {0}" -f $t.ProcessId) -ForegroundColor DarkGray
    } catch {
        Write-Host ("    could not kill PID {0}: {1}" -f $t.ProcessId, $_.Exception.Message) -ForegroundColor Red
    }
}
Write-Host "  Done. Unrelated node (MCP, tsc, VS Code, Brave) was left untouched." -ForegroundColor Green
Write-Host ""
