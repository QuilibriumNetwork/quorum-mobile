---
type: bug
title: "Physical Android device: 'Unable to load script' — full session report"
status: done
created: 2026-06-12
---

# Physical Android device: "Unable to load script" — full session report

**Date:** 2026-06-12
**Status:** RESOLVED ✅ — app loads on the physical phone.
**Device:** Motorola Edge 50 Fusion (ZY22K3XRLP), Android 15 / API 35, arm64-v8a
**Stack:** Expo SDK 54.0.32, react-native 0.81.5, Hermes, bridgeless + split bundles, expo-dev-client 6.0.20
**Branch:** feat/dm-update-profile
**Time cost:** ~3 hours. See "Faster path" at the bottom — this should have been ~30 min.

## THE ROOT CAUSE — there were TWO independent problems stacked

The single "Unable to load script" error screen masked **two completely separate root causes**. Both had to be fixed; fixing either alone still showed the same error, which is what made this so slow to diagnose.

### Root cause #1 — Babel: @polkadot's untranspiled ES2022 class syntax (the BUILD problem)
`@polkadot/*` (direct dep via `@polkadot/api`, `keyring`, `util`, `util-crypto`) ships **untranspiled ES2022 class syntax**: `static { }` blocks, `#private` fields/methods, `#x in obj` brand checks. The Hermes parser in RN 0.81.5 rejects it, and `babel-preset-expo` does NOT lower it inside `node_modules`. The bundle failed to compile/execute.

**Why it was confusing:** the app worked days ago because the complete fix lived on branch `fix/windows-dev-env-emulator` (commits `ca14400` + `7edc492`, Jun 10) — FOUR babel class-feature plugins. **That branch was never merged to master.** Moving to master → `feat/dm-update-profile` left the fix behind, so `babel.config.js` had none of them. Latent until a cold rebuild.

### Root cause #2 — Expo advertised the dead LAN IP instead of localhost (the CONNECT problem)
Even with the bundle building, the Expo dev client opened the app pointed at `http://<pc-lan-ip>:8081` (the PC's LAN IP). On this Windows box that IPv4 LAN address is **unreachable**: Metro binds IPv6-only (`::`) and even the PC can't curl its own `<pc-lan-ip>:8081`. So the device's bundle fetch timed out (`SocketTimeoutException` / `Socket closed`) → "Unable to load script". The `--localhost` CLI flag did NOT fix it (it doesn't override the "press a" deep-link URL). **`REACT_NATIVE_PACKAGER_HOSTNAME=localhost`** is what forces localhost everywhere, so the app loads through the USB `adb reverse` bridge.

## THE FIXES (both required)

### Fix #1 — babel.config.js (scoped to @polkadot)
Lower @polkadot's class syntax via an `overrides` block scoped to `node_modules/@polkadot` ONLY. (Scoping to all of `node_modules` breaks TS-source packages like `expo-file-system`, whose `declare` fields must be transformed by the TypeScript plugin first → HTTP 500 `TransformError`.)

```js
plugins: [
  'react-native-reanimated/plugin', // must be last
],
overrides: [
  {
    test: /node_modules[\\/]@polkadot[\\/]/,
    plugins: [
      '@babel/plugin-transform-class-static-block',
      '@babel/plugin-transform-class-properties',
      '@babel/plugin-transform-private-methods',
      '@babel/plugin-transform-private-property-in-object',
    ],
  },
],
```

All four plugins ship transitively with babel-preset-expo (already in node_modules; no package.json change). After editing babel.config.js you MUST restart Metro with `--reset-cache`.

### Fix #2 — force localhost so the app uses the USB bridge
Start Metro with `REACT_NATIVE_PACKAGER_HOSTNAME=localhost` set (now baked into `.agents/scripts/dev-start-mobile.ps1`). This makes "press a" open the app at `localhost:8081` instead of the dead LAN IP, so it loads through `adb reverse`. `--localhost` alone does NOT work.

```powershell
$env:REACT_NATIVE_PACKAGER_HOSTNAME="localhost"; yarn start --max-workers 2
# then press 'a'  — terminal must show ?url=http://localhost:8081 (NOT 192.168.x.x)
```

**Important nuance:** an earlier partial fix (static-block plugin ONLY, applied app-wide) let the bundle BUILD (HTTP 200) but it still failed to LOAD on device, because the `#private` syntax was still present. That false-positive ("bundle builds, so babel is fine") cost time. **The build succeeding is NOT proof the fix is complete — the device load is the real test.**

## SAFETY FOR OTHER DEVS (lead dev: Mac + Android emulator)
- **babel.config.js** is the ONLY repo change. It is additive, syntax-only, scoped to `node_modules/@polkadot`, platform-agnostic (identical on Mac/emulator), and is the same fix a teammate already shipped on a branch. It cannot break a working setup — on a platform where Hermes already coped it's a no-op; where it didn't, it's the fix.
- All `.ps1` scripts + the firewall rule + `REACT_NATIVE_PACKAGER_HOSTNAME` are **Windows-machine-local**, not in the repo, never touch the lead dev.

## TIMELINE OF THE SESSION (what was tried, in order)

1. **Connection layer (real but secondary):**
   - Phone was `unauthorized` for USB debugging → authorized it.
   - `adb reverse tcp:8081 tcp:8081` resets overnight; without it the app falls back to the LAN IP.
   - Windows Firewall blocked inbound 8081 → added rule (`.agents/scripts/allow-metro-firewall.ps1`). Phone↔PC ping: 100% loss → 0%.
   - Metro binds IPv6-only (`::`); even the PC can't reach its own LAN IPv4:8081 → USB `adb reverse` (routes phone localhost → PC 127.0.0.1, which answers) is the reliable path.
2. **Partial babel fix:** added `@babel/plugin-transform-class-static-block` (app-wide). Bundle went HTTP 500 ("Static class blocks are not enabled") → HTTP 200. Looked solved, wasn't.
3. **dev-start-mobile.ps1 fix:** removed `Tee-Object` (it consumed stdin and killed the Expo `a`/`r` keypress menu, forcing manual adb launches). Added auto adb-reverse + auto-launch.
4. **Full native rebuild** (`yarn android`, 13m40s, BUILD SUCCESSFUL) + clean uninstall/reinstall — chasing a native/JS mismatch theory. Same error. (Note: build.gradle hardcodes `versionCode 1`; the previously-installed app was v45, so local installs were downgrade-blocked until `adb uninstall`. Consider bumping versionCode.)
5. **Web search** (per the research-before-debugging rule) surfaced expo/expo #27027, #26364 (SDK 50+ bridgeless Android dev client, bundle reachable, no BUNDLE log) and the getDevServer/@expo/metro-runtime issue.
6. **Git archaeology** (triggered by user recalling "it worked during the icon-shim commit") found the lost `fix/windows-dev-env-emulator` branch with the COMPLETE four-plugin babel fix. ← the actual answer.

## VERIFIED FACTS (evidence)
- Bundle byte-stable: 58,238,924 bytes every fetch (NOT corruption — rules out the emulator byte-loss bug).
- Phone downloads full bundle over USB: HTTP 200, 33 MB/s, 1.7s (network/tunnel fine).
- Metro serves bundle: HTTP 200.
- Debug manifest has `usesCleartextTraffic="true"` (localhost HTTP allowed).
- expo-dev-client is in `dependencies` (not devDependencies) — correct.
- partial fix (static-block only) → bundle builds but `expo-file-system` `declare` field broke when adding the other three app-wide → must scope to node_modules.

## RULED OUT (don't re-investigate)
Network/firewall/bridge, bundle byte-corruption, USB tunnel choke on 56 MB, native/JS version mismatch, wedged dev-client state, expo-dev-client-in-devDependencies, cleartext-blocked, stale launcher URL.

## THE FASTER PATH (what should have happened — ~30 min, not 3 hours)

The two facts that actually cracked it both came from the USER, late: "it worked during the icon-shim commit" and "the fix commits were for the emulator". Had we acted on the "it worked recently" signal FIRST, the path is short:

1. **`git diff` the last-known-good state vs now, FIRST.** The moment the user says "it worked a few days ago", run `git log --all --oneline` + check `git branch -a` + reflog for recent fix branches. The complete fix was sitting in an unmerged branch (`fix/windows-dev-env-emulator`, commits ca14400/7edc492) the entire time. Diffing babel.config.js across branches would have surfaced all four plugins in minutes. **This single step would have saved ~2 hours.**
2. **Separate "builds" from "loads" from "connects" immediately.** Three distinct layers, three distinct tests — run all three up front:
   - builds: `curl localhost:8081/index.bundle` (HTTP 200 vs 500 = babel/transform problem)
   - connects: what URL does the terminal show on "press a"? (`192.168.x.x` vs `localhost` = the LAN-IP problem)
   - loads: device logcat for SocketTimeout vs SyntaxError vs generic.
   We conflated these for hours; the generic "Unable to load script" screen looks identical for all three.
3. **Read the interactive Metro terminal early.** The `› Opening ...?url=http://<pc-lan-ip>:8081` line — the literal smoking gun for root cause #2 — was visible in the user's terminal the whole time but we were driving via adb (which hid it). Ask to see the Metro terminal output in the first 10 minutes.
4. **Don't trust "the bundle builds" as success.** The partial babel fix gave HTTP 200 and we moved on; the device still failed. Always verify on-device load, not just bundle status.

### Mistakes that cost the most time (ranked)
1. Treating it as ONE problem when it was TWO stacked (babel + LAN-IP). ~1h.
2. Not checking git branches/reflog when user said "it worked recently". ~1h.
3. Chasing a full `yarn android` native rebuild (14 min) on an unverified native-mismatch theory. ~30m.
4. Repeated adb deep-link launches that don't honor the URL, instead of the interactive `press a` flow. ~30m.

## RESOLVED side-findings
- `clsx` is genuinely missing (`@quilibrium/quorum-shared` imports it). Breaks the WEB build only, not Android. `yarn add clsx` when convenient.
- build.gradle hardcodes `versionCode 1`; previously-installed app was v45, blocking local reinstalls until `adb uninstall`. Consider bumping versionCode.
- `@expo/metro-runtime` 6.1.2 / `unstable_enablePackageExports` warnings — investigated, NOT the cause. The export-resolution WARNs are benign.

## DIAGNOSTIC COMMANDS (copy-paste)
```bash
# bundle build status (the REAL test, not "does the app connect"):
curl -s -m 240 -o /tmp/b.js -w "HTTP %{http_code} %{size_download}b %{time_total}s\n" "http://localhost:8081/index.bundle?platform=android&dev=true"
# a small size_download (~9KB) with HTTP 500 = TransformError; cat the file for the message.

# phone can reach bundle over USB bridge:
adb reverse tcp:8081 tcp:8081
adb shell "curl -s -m 90 -o /dev/null -w '%{http_code} %{size_download}\n' 'http://localhost:8081/index.bundle?platform=android&dev=true'"

# device-side load error:
adb logcat -d | grep -iE "ReactNativeJS|BridgelessReact|DevLauncher|hermes|Unable to load"

# launch at localhost:
adb shell am start -a android.intent.action.VIEW -d "quorummobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" com.quilibrium.quorummobile.debug
```

## LESSONS
- **A bundle that BUILDS (HTTP 200) is not proof the babel/JS is correct.** The device LOAD is the real test. The partial static-block fix gave a false-positive that cost hours.
- **When "it worked recently," find the commit where it worked and diff** — don't theorize. The fix was sitting in an unmerged branch the whole time. (The user remembered this; the agent should have checked reflog/branches first.)
- **The user is not a mobile dev** — verify from git/logs, don't ask them for technical specifics. But their memory of *workflow* facts ("worked during icon-shim", "fix commits were for emulator") was the key that cracked it.

## ACTION ITEMS
- [ ] Confirm scoped babel fix loads the app on device (in progress).
- [ ] Commit the babel fix to this branch (it was lost from an unmerged branch; ensure it lands on master this time).
- [ ] Consider cherry-picking the rest of `ca14400`/`7edc492` if anything else is missing.
- [ ] Consider bumping `versionCode` in android/app/build.gradle so local rebuilds aren't downgrade-blocked.

## Sources
- https://github.com/expo/expo/issues/27027 / #26364 (bridgeless Android dev client, bundle reachable, no BUNDLE log)
- https://github.com/expo/expo/discussions/37799 (getDevServer / @expo/metro-runtime)
- https://github.com/expo/expo/discussions/36551 (libs incompatible with Metro package-exports)
- Lost local commits: ca14400, 7edc492 (branch fix/windows-dev-env-emulator)

---
*Last updated: 2026-06-12*
