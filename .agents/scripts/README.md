# Dev / debug scripts

Windows-first helper scripts for the mobile dev loop: starting Metro, building
native variants, driving two phones at once, and capturing logs.

## Setup (once per clone)

**Nothing is required.** The scripts locate the repo from their own path, and
auto-detect connected devices and the LAN IP. Clone anywhere, on any drive, and
run them from the repo root:

```powershell
.\.agents\scripts\dev-start-mobile.ps1
```

Optionally, pin machine-specific values by copying the template:

```powershell
copy .agents\scripts\.env.local.example .agents\scripts\.env.local
```

`.env.local` is gitignored and every key in it is optional. Use it to send
captures somewhere outside the repo, point at a local SDK checkout, or pin a
device serial. `_env.ps1` loads it and is dot-sourced by the PowerShell scripts;
`capture-xptrace.bat` reads the same file, so both agree on one location.

## Conventions worth knowing

- **`_env.ps1` is the bootstrap, not a command.** It sets `$repo` (repo root) and
  `$captureDir`, and exports anything in `.env.local`. Any new PowerShell script
  here should start with `. "$PSScriptRoot\_env.ps1"` rather than computing paths
  itself.
- **No absolute machine paths.** Derive from `$PSScriptRoot`/`$repo`, or read a
  key from `.env.local` with a sensible in-repo default. A hardcoded path breaks
  every other clone.
- **Captures default to `%LOCALAPPDATA%\quorum-mobile\captures`, outside the
  repo.** That is deliberate: logcat/XPTRACE captures can contain real key
  material, so they must not sit in a working tree. Set `QM_CAPTURE_DIR` to
  redirect them, and keep the destination outside the repo.
- **`.agents/reports/metro-log.txt` is regenerated on every run** and is
  gitignored. Do not commit it: PowerShell's transcript header records the
  machine's account and computer name each time.

## Index — every file in this folder

### Daily loop (start here)

| Script | What it's for |
|--------|---------------|
| `dev-start-mobile.ps1` | **The one you use.** Metro + auto-launch on a USB phone, fresh log |
| `dev-start-mobile-wifi.ps1` | Same, but the phone pulls the bundle over Wi-Fi (no cable) |
| `metro-status.ps1` | Inspect / surgically kill only this project's Metro processes |
| `patch-fs-promises.js` | **Library, not a command.** EMFILE guard the `dev-start-*` scripts load via `NODE_OPTIONS` |
| `reset-adb.bat` | Unwedge the adb server (double-click, self-elevates) |

### Builds

| Script | What it's for |
|--------|---------------|
| `build-app.ps1` | Native rebuild + install on the phone (arm64 only by default) |
| `build-prod-variant.ps1` | RELEASE build installed as a third `.preview` package id |
| `build-emulator.ps1` | Emulator build (x86_64, plain package id) — **see the emulator warning** |
| `dev-start-emulator.ps1` | Metro + adb reverse + auto-launch for an emulator — **see the emulator warning** |
| `allow-metro-firewall.ps1` | One-time: open inbound TCP 8081 for the Wi-Fi path |

### DM diagnostic rig (tied to open upstream issue #183)

| Script | What it's for |
|--------|---------------|
| `git-debug.sh` | **Run this first.** `git debug` — rebase the rig onto master, re-arm the transport patch, print a BUILD CHECK |
| `two-device-round.ps1` | **Orchestrator.** One command runs a full two-phone capture round |
| `connect-second-device.ps1` | Attach a second phone to an already-running Metro |
| `capture-xptrace.bat` | Per-device logcat capture, timestamped file per run |
| `patch-rn-ws-diag.mjs` | Per-frame `ws.send` logging inside `node_modules` — **re-run after any `yarn install`** |
| `patch-rn-ws-retain.mjs` | Candidate **fix** patch (not diagnostic): widens the RN websocket send-retry window in `node_modules` so it can be tested on-device without publishing shared. Re-run after any `yarn install` |
| `dr-ablate.mjs` | Offline causation test over captured logs: mutate one ratchet-state property, re-run the identical decrypt against the real wasm, see which property was load-bearing |
| `dr-core-harness.mjs` | Drive the real Double-Ratchet crypto core in Node, no devices |
| `dr-replay.mjs` | Replay a real failed decrypt offline from a desktop `[XPDUMP]` log |
| `dr-advanced-start-fork.mjs` | Deterministic repro of the channel-crate fork filed as issue #183 |
| `clear-dm-encryption-state.sh` | Wipe the DM session store on a debug build for a clean-user baseline |

### Shared package

| Script | What it's for |
|--------|---------------|
| `link-local-shared.ps1` | Point `node_modules/@quilibrium/quorum-shared` at the local shared repo |
| `unlink-local-shared.ps1` | Undo it, back to the pinned registry version |
| `verify-shared-externals.mjs` | Check that the deps shared's dist externalizes still resolve from the linked package |

### Assets (one-shot regenerators)

| Script | What it's for |
|--------|---------------|
| `gen-app-icons.js` | Rebuild `icon.png` + `icon-android-adaptive.png` from the immutable backup |
| `gen-splash-densities.js` | Rebuild the per-density Android 12 splash logos |
| `gen-launcher-webp.js` | Re-encode the committed `mipmap-*` launcher webp bitmaps |

### Reference

| File | What it's for |
|------|---------------|
| `_env.ps1` | **Bootstrap, not a command.** Sets `$repo`/`$captureDir`, loads `.env.local`. Dot-sourced by the PowerShell scripts |
| `_adb-preflight.ps1` | **Library, not a command.** `Resolve-QmUsbDevice` — picks the cabled phone, waits out an unauthorized one, discards stray Wi-Fi endpoints. Dot-sourced by the two cable scripts |
| `.env.local.example` | Template for optional machine-local settings — copy to `.env.local` (gitignored) |
| `dev-unblock-user.md` | **A doc, not a script.** One-shot recipe to unblock a user with no UI path |

---

## The only command you need

In the VS Code terminal at the repo root:

```powershell
.\.agents\scripts\dev-start-mobile.ps1              # normal, warm cache
.\.agents\scripts\dev-start-mobile.ps1 -ResetCache  # after a babel/metro.config change
.\.agents\scripts\dev-start-mobile.ps1 -s <device-1-serial>   # pin a serial (two phones plugged in)
```

It starts Metro AND writes all output to `.agents/reports/metro-log.txt`, so the
agent reads the log directly without you pasting anything. It also reclaims
**only orphaned Metro** from a previous crashed session (via `metro-status.ps1`
— never unrelated node like MCP servers or `tsc`), resets the Metro cache, caps
workers at 2, caps Node's heap at 4 GB, and patches the Windows EMFILE /
"Waiting for Watchman watch-project" hang.

> **On a cold start Expo sits silently on "Starting project at..." for ~15-25s**
> before the `a/r` menu appears. That is NOT a hang — wait for the menu, and do
> NOT Ctrl+C during that window (a mid-startup Ctrl+C leaves a dirty PowerShell
> transcript that can make the *next* run look hung too).

### Between tests (when iterating with the agent)

1. **Ctrl+C** in the Metro terminal to stop it.
2. Press **Up arrow** to recall the last command, then **Enter**.
3. On the phone: shake → Reload.

Each restart wipes the old log and starts a clean one. No second terminal, no
manual file clearing.

### Wi-Fi instead of a cable (`dev-start-mobile-wifi.ps1`)

The phone fetches the bundle over Wi-Fi from this PC's LAN IP instead of through
the cable. The script auto-detects the LAN IP (skipping VPN/virtual adapters)
and binds Metro to it.

**First run only:**

1. Open the firewall once for inbound TCP 8081 (self-elevates to admin):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\.agents\scripts\allow-metro-firewall.ps1
   ```
2. **Turn the VPN OFF** — a VPN blocks phone↔PC LAN traffic, so the bundle never arrives.
3. Phone and PC on the **same Wi-Fi** (no guest network / AP isolation).

**Every run:**

```powershell
.\.agents\scripts\dev-start-mobile-wifi.ps1                      # auto-detect IP
.\.agents\scripts\dev-start-mobile-wifi.ps1 -HostIp <pc-lan-ip>  # pin a specific IP
.\.agents\scripts\dev-start-mobile-wifi.ps1 -DryRun              # validate only (~2s, no launch)
```

> "Unable to load script" on the phone? Almost always, in order: VPN still on,
> firewall rule missing (run step 1), or router AP isolation. Fall back to
> `dev-start-mobile.ps1` (USB) if Wi-Fi won't cooperate.

## Rebuilding the app (`build-app.ps1`)

```powershell
.\.agents\scripts\build-app.ps1                        # arm64-v8a only (both test phones)
.\.agents\scripts\build-app.ps1 -AllAbis               # full ABI set
.\.agents\scripts\build-app.ps1 -Serial <device-1-serial>   # pick one of two cabled phones
.\.agents\scripts\build-app.ps1 -BuildOnly             # compile the APK with no phone attached
```

One button — full native rebuild + install. Run this when:
- you see the red **"[runtime not ready]: Failed to get NitroModules"** screen,
- you changed native code (`android/`, `ios/`) or installed a package,
- a Metro reload isn't picking up what you expect (stale native binary).

After it finishes, `dev-start-mobile.ps1` is all you need for JS/TS work — that
only needs a Reload, not a rebuild.

> **Why the wrapper:** the Windows account name has an accent, and the
> NitroModules/prefab C++ step mangles it into `??` inside JVM temp paths,
> failing the build intermittently (only on C++ cache misses — which is why it
> seems random). The script forces the Gradle daemon's `java.io.tmpdir` onto
> `<local temp>/` so no accent reaches the toolchain. Setting `TMP`/`TEMP` does **not**
> work — AGP reads `java.io.tmpdir`.

### Release build (`build-prod-variant.ps1`)

```powershell
.\.agents\scripts\build-prod-variant.ps1
```

Builds the RELEASE variant and installs it as a **third** application id,
`com.quilibrium.quorummobile.preview`, coexisting with the live app and the
debug build. Use it to check whether a symptom is a dev-build artifact — several
transport bugs behaved completely differently in release.

> **Safety guard:** before installing it dumps the built APK's actual
> applicationId and REFUSES to install unless it reads `...preview`. If the
> `previewVariant` flag ever silently fails to apply, a release build emits the
> LIVE id and `adb install -r` would overwrite the real app with real user data.
> Do not remove that check.

## ⚠️ The emulator scripts have never worked

`build-emulator.ps1` and `dev-start-emulator.ps1` are logically correct and kept
for a future attempt, but **no emulator dev session has ever succeeded on this
machine** (as of 2026-07-25). The physical phone is the only working dev path.

The blocker: the installed dev client has the PC's LAN IP (`<pc-lan-ip>:8081`)
baked in as its server URL from the first install, and ignores the `adb reverse`
tunnel even after `pm clear`. It freezes at "Loading from <pc-lan-ip>:8081...".

If you pick this up again, the untried lever is **`http://10.0.2.2:8081`** — the
emulator's permanent alias for the host, which needs no `adb reverse` at all.
Enter it manually on the dev-client home screen, or rebuild with **only** the
emulator attached so that URL gets baked in. Don't spend time on the reverse
tunnel; it was already verified working and is not the problem.

## The DM diagnostic rig

This is a **unit**, not seven independent tools, and it exists to serve one open
bug: `issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md`
(upstream root causes filed as quorum-mobile issue #183). Read that doc's PART I
before running any of it. When #183 closes and the diag branches are deleted,
this whole section can go with them.

**The rig only produces valid data on the diag branch.** Mobile instrumentation
lives on the local never-push branch `diag/dm-frame-trace`; master has none of it
(audited 2026-07-27 — no diag branch is an ancestor of master, and master has zero
`XPTRACE`/`WSTRACE`/`DM-*-wire` occurrences).

### `git debug` — get into a valid capture state

```bash
git debug          # alias → .agents/scripts/git-debug.sh
```

Run this before every round instead of checking out by hand. It:

1. refuses to run on a dirty tree (a half-applied rebase wastes a round),
2. fast-forwards local `master` from origin,
3. rebases `diag/dm-frame-trace` onto it and leaves you checked out there,
4. re-applies `patch-rn-ws-diag.mjs` to `node_modules` (wiped by every
   `yarn install` — this is what invalidated round 25),
5. prints a BUILD CHECK proving what is compiled in:

```
--- BUILD CHECK (marker only reports probes, this reports fixes) ---
rig: 'dm-frame-trace'
send row probe  : 1  (want 1)
send wire probe : 1  (want 1)
recv wire probe : 2  (want 2: individual+batch)
ws transport    : 1  (want 1, index.native.js is what Metro loads)
sent_accept fix : 2  (want >=1)
ratchet mutex   : 2  (want >=1)
send-state pick : 3  (want >=1)
```

Any line short of its `want` means **do not capture**. The in-app `[DM-diag]
armed` marker only reports the JS probes — it cannot tell you the shipped fixes
are present or that the node_modules patch survived, which is what this output
is for. `quorum-desktop` has the equivalent `git debug` for `diag/dm-frame-join`.

Never check out the rig by SHA: `git debug` rebases, so SHAs written in docs go
stale immediately (see DM doc §27.1 — a round captured from a stale head faked
21 losses).

**If `git debug` is not found**, the alias lives in `.git/config`, which is
machine-local and does not survive a fresh clone. Reinstall it:

```bash
git config --local alias.debug '!bash .agents/scripts/git-debug.sh'
```

### One-command two-device round

```powershell
.\.agents\scripts\two-device-round.ps1 -s1 <serial1-USB> -s2 <serial2> [-ResetCache]
```

Spawns Metro for device 1 in its own window, connects device 2, starts both
logcat captures, relaunches both apps so the armed markers land *inside* the
captures, then waits for you to press Enter to stop. Prefer **both devices on
USB** — Wi-Fi adb drops when the phone dozes.

> This orchestrator has **never had a successful live run**. Treat the first one
> as a shakedown; the manual ritual (`dev-start-mobile.ps1` → press `a` →
> `capture-xptrace.bat`) is the fallback.

### The pieces, if you run it manually

- `connect-second-device.ps1 -s <serial2>` — per-device `adb reverse` + a launch
  pinned to the `.debug` package, against the Metro device 1 already started.
  **Order matters:** `dev-start-mobile.ps1` disconnects every Wi-Fi adb endpoint
  on startup, so run this only after Metro and device 1 are up.
- `capture-xptrace.bat [serial]` — timestamped logcat capture to
  `$QM_CAPTURE_DIR/`. Run once per device, in its own terminal.

**No armed markers = no round.** After the capture is running, reload the app and
confirm both lines appear in the file:

```
[DM-diag] armed              -> the build IS the diag branch
[WS-diag] transport patch armed  -> the node_modules transport patch is live
```

Missing `[WS-diag]`? A `yarn install` reset `node_modules`. Re-apply:

```bash
git debug          # does this for you, plus the rebase and the BUILD CHECK
# or, on its own:
node .agents/scripts/patch-rn-ws-diag.mjs
```

It's idempotent, patches every bundle entry point the RN client can resolve to
(`index.native.js` wins over `index.js` under Metro — a round was lost to that),
and survives git branch switches but **not** a reinstall.

### Offline analysis — no devices, no rebuild

```bash
node .agents/scripts/dr-core-harness.mjs                       # ask the crypto core directly
node .agents/scripts/dr-replay.mjs $QM_CAPTURE_DIR/localhost-XXXX.log   # replay a real failure
node .agents/scripts/dr-advanced-start-fork.mjs                # repro the upstream fork
```

All three drive the **real** crypto core — the SDK's wasm build of the same Rust
`channel` crate mobile loads through UniFFI — so they answer protocol questions
in seconds instead of one manual device round per question. `dr-core-harness.mjs`
settled two standing hypotheses about DM loss in minutes; it is meant to be
edited with whatever question you have.

They need the SDK checked out next to this repo
(`../quilibrium-js-sdk-channels`). The harness and replay accept `SDK_DIR=...`;
`dr-advanced-start-fork.mjs` hardcodes the path because it is the repro cited
verbatim in issue #183 — leave it byte-identical unless the issue closes.

> ⚠️ `[XPDUMP]` lines contain **real key material**. Debug branch and throwaway
> test accounts only; delete the logs when the investigation is finished.

### Clean-slate a test account

```bash
./.agents/scripts/clear-dm-encryption-state.sh                 # default debug package
ADB_SERIAL=<serial> ./.agents/scripts/clear-dm-encryption-state.sh
```

Deletes the `quorum-encryption` MMKV (ratchet states, inbox keypairs, inbox
mappings) and restarts the app; sessions re-establish on the next exchange. It
does **not** touch account keys or message history. Debug builds only — `run-as`
needs `android:debuggable`, so the `.preview`/live apps cannot be cleaned this way.

## Developing against unpublished shared changes

```powershell
.\.agents\scripts\link-local-shared.ps1 -Copy      # build shared + copy it in (USE THIS)
.\.agents\scripts\link-local-shared.ps1            # junction instead — Metro can't follow it here
.\.agents\scripts\link-local-shared.ps1 -NoBuild   # skip the shared rebuild
.\.agents\scripts\unlink-local-shared.ps1          # restore the npm-installed package

node .agents/scripts/verify-shared-externals.mjs   # standalone re-check of the linked package
```

Points `node_modules/@quilibrium/quorum-shared` at the local `quorum-shared`
repo so you can runtime-test mobile against shared changes before they're
published. **`package.json` and `yarn.lock` are never touched** — the redirect
lives only in gitignored `node_modules`, so nothing leaks to git or to other
branches. Shared is rebuilt first so mobile never tests a stale `dist`.

**Always use `-Copy`.** Metro here resolves only from the project's own
`node_modules` (`nodeModulesPaths` is pinned, there are no `watchFolders`, and
Windows uses the Node crawler), so it does not follow the junction out to a
sibling repo — confirmed empirically.

The copy also carries over the npm package's **nested `node_modules`**. Shared's
`dist` externalizes its dependencies rather than bundling them, so a copy of
`dist/` alone repoints them at mobile's hoisted copies, which are not always the
same major: shared imports `@noble/hashes/sha2`, which its nested 1.8.0 exports
but mobile's hoisted 2.0.1 does not. `verify-shared-externals.mjs` runs as the
last step and fails the link on any import that Metro could not resolve.

After linking or unlinking, re-run `patch-rn-ws-diag.mjs` if you're mid-diag-round.

## Regenerating icons and splash art

One-shot generators; the assets they produce are committed, so you only run these
when the brand art changes.

```bash
node .agents/scripts/gen-app-icons.js         # icon.png + icon-android-adaptive.png
node .agents/scripts/gen-splash-densities.js  # drawable-*dpi/splashscreen_logo.png
node .agents/scripts/gen-launcher-webp.js     # mipmap-*/ic_launcher*.webp
```

Run them in that order — `gen-launcher-webp.js` encodes whatever the first two
produced. It needs `ffmpeg` (no npm webp encoder is installed). It looks at
`QM_FFMPEG` first, falling back to the default Windows install location, so set
`QM_FFMPEG` in `.env.local` if yours lives elsewhere or is on `PATH`.

`gen-app-icons.js` always extracts the glyph from the immutable
`assets/images/icon-original.png` backup, never from its own output, so
re-running it does not compound artifacts.

## Inspecting / cleaning Metro processes (`metro-status.ps1`)

```powershell
.\.agents\scripts\metro-status.ps1            # list ONLY the Metro tree
.\.agents\scripts\metro-status.ps1 -Kill      # kill ORPHANED (leaked) Metro only — safe
.\.agents\scripts\metro-status.ps1 -Kill -All # stop ALL Metro for this project (clean slate)
```

It filters to **only** this project's Metro/Expo node tree by command line, so it
never confuses VS Code, Brave, Electron, MCP servers, or a one-off `tsc` for
Metro. A healthy **single** dev session is **4 node processes**:

```
yarn start:lazy        (launcher, ~64 MB)
  └─ expo / Metro       (the server, ~1–1.5 GB)
       ├─ jest-worker   (bundler worker #1, ~600 MB)   } count == --max-workers (2)
       └─ jest-worker   (bundler worker #2, ~700 MB)   }
```

- **Default `-Kill`** removes only *orphaned* Metro — a tree whose parent shell
  died (e.g. Metro or the terminal crashed). It leaves a live session and all
  unrelated node untouched. This is what `dev-start-*.ps1` calls on launch.
- **`-Kill -All`** also stops a Metro you have running right now — use it when you
  just want a fully clean slate.

> **"Too many node processes" is almost never a Metro leak.** Task Manager labels
> VS Code's extension host / TS server / pty host, Brave & Electron helpers, MCP
> servers, and `tsc` all as "Node.js JavaScript Runtime" too. Run
> `metro-status.ps1` to see the real Metro count. Genuine leaks only happen when
> Metro or its terminal **crashes** and the jest-workers survive as orphans —
> typically under RAM pressure (this box is 32 GB but often <3 GB free with
> Brave + VS Code + Android Studio open). The 4 GB heap cap and orphan-cleanup
> reduce the fallout; closing a few Brave tabs / a VS Code window before a heavy
> build is the durable fix.

## When adb hangs (`reset-adb.bat`)

A blank window with a blinking cursor means the **adb server** is wedged, not
that the script is broken: every adb client then blocks forever waiting on it.
`adb devices` hanging instead of returning an empty list is the tell.

Double-click `reset-adb.bat`. It self-elevates (killing `adb.exe` needs
administrator rights), restarts the server, and prints the device list.
If that list is empty, replug the cable, unlock the phone, and accept the
"Allow USB debugging" prompt.

## "This computer is not authorized" / "No development build is installed"

If a run dies with either of these — especially both together, and especially
when the cable has worked fine for months:

```
This computer is not authorized for developing on Device 192.168.0.3:5555
CommandError: No development build (com.quilibrium.quorummobile) for this
project is installed. Install a development build on the target device...
```

**your build and your install are almost certainly fine.** The message names the
wrong culprit. Run `adb devices` and look at how many entries come back:

```
<device-1-serial>   device         <- the cabled phone, healthy
192.168.0.3:5555   unauthorized   <- a stale Wi-Fi endpoint
```

Expo picks a device itself, and it does **not** honour `ANDROID_SERIAL`. When it
lands on the Wi-Fi entry it cannot run `pm list packages` against an
unauthorized endpoint, and it reports that failure as "no development build
installed". Rebuilding cannot help, because nothing was wrong with the build —
that is the trap, and it costs ~9 minutes per attempt to fall into.

**Both cable scripts now heal this automatically** (`_adb-preflight.ps1`): once a
healthy USB phone is confirmed, every `<ip>:port` endpoint is disconnected
regardless of its state, leaving Expo exactly one candidate. `build-app.ps1`
resolves the phone *before* Gradle starts, so a device problem costs seconds
rather than surfacing as a bogus build error at the end.

The rule is **USB wins**: with a cable attached, Wi-Fi endpoints are discarded.
With no cable, they are left untouched and the script points you at
`dev-start-mobile-wifi.ps1` instead — so it can never delete the only endpoint
you have.

These ghosts reappear on their own (observed 2026-08-13: a `192.168.0.x` and a
Tailscale-range `100.x.y.z` endpoint both re-materialised as `unauthorized`
minutes after being disconnected, at addresses nobody typed). That is why the
prune runs on **every** invocation and matches on shape rather than on state —
a one-off manual cleanup does not stay clean.

Manual escape hatch, if you ever need it:

```powershell
adb disconnect 192.168.0.3:5555     # drop one endpoint
adb disconnect                      # drop every Wi-Fi endpoint
```

## Standard debug workflow

1. Run `dev-start-mobile.ps1` — Metro running, clean log.
2. Tell the agent what you're testing.
3. Agent adds `console.log` instrumentation in code.
4. Shake → Reload to pick up changes (no rebuild needed).
5. Do the test on the device.
6. Tell the agent "done" — they read the log file directly.
7. Next iteration: Ctrl+C → Up → Enter, then Reload, repeat.

## Notes

- Metro log is **UTF-16LE encoded** (PowerShell `Tee-Object` default). The agent
  knows how to handle this.
- If Metro fails to start because the log file is locked (another Metro is still
  holding it), clean up surgically with `metro-status.ps1 -Kill -All`. Prefer
  that over `Get-Process node | Stop-Process -Force`, which kills *every* Node
  process — including MCP servers, `tsc`, and other dev servers.
- Native code changes (anything in `android/` or `ios/`, or installing new
  packages) require a full rebuild. JS/TS changes only need a Reload.
- Keep the `.ps1` files **ASCII-only**. Windows PowerShell 5.1 reads no-BOM
  scripts as Windows-1252, so a stray em-dash or smart quote breaks string
  parsing.
- Do **not** run `yarn prebuild` — it is deliberately fenced off (`PREBUILD.md`);
  the iOS folder is the source of truth and carries manual customizations.

## Retired 2026-07-26

Deleted during an audit; noted here because older `.agents` docs still reference
them.

| Removed | Why |
|---------|-----|
| `capture-wstrace-logcat.ps1` | Filtered logcat for `[WSTRACE]`; no build has emitted that tag since the receive-deafness work shipped (PR #169/#170). `capture-xptrace.bat` covers the same ground generically. |
| `read-heartbeat.ps1` | Read `files/wstrace-heartbeat.json`; nothing writes it any more. |
| `read-catchup-diag.ps1` | Read `files/catchup-diag.json` from branch `fix/hub-log-catchup-flow-control`, which no longer exists. |
| `gen-android-adaptive-icon.js` | Superseded by `gen-app-icons.js` in the same 2026-06-19 commit; running it would overwrite `icon-android-adaptive.png` with the pre-redesign version. |
| `gen-splash-logo.js` | Superseded by `gen-splash-densities.js`; running it would overwrite `splash-glyph.png` with the older build. |

*Last updated: 2026-08-13*
