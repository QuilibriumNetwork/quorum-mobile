---
type: task
title: "Plan: production-variant build (side-by-side) to verify the composer-drop glitch in prod"
status: done
created: 2026-06-20
---

# Plan: production-variant build (side-by-side) to verify the composer-drop glitch in prod

**Status:** ✅ DONE 2026-06-20. Build succeeded; `.preview` variant installed alongside live

- debug (real app untouched). RESULT: the glitch does NOT reproduce in release — confirmed
  dev-only. Bug marked SOLVED. No fix needed. Reusable artifacts produced (see below).

**Outcome / reusable artifacts:**

- `.agents/scripts/build-prod-variant.ps1` — one-button RELEASE (.preview) build+install,
  with the APK-id safety guard (refuses to install unless id is `...preview`). RE-RUN ANYTIME
  to rebuild/retest the prod variant (incremental, fast — warm Gradle cache on C:\ SSD).
- `android/app/build.gradle` — property-gated `applicationIdSuffix '.preview'` on the release
  buildType. DECIDED: keep LOCAL-ONLY, do NOT commit. Rationale: the block is only useful
  WITH the build script, and the script lives in gitignored `.agents/` so other devs don't
  get it — committing the block to the shared repo gives them unexplained, unusable
  machinery in a sensitive build file. It works for us uncommitted (the script reads the
  working-tree gradle). Default release path (EAS/prod, no flag) is unchanged regardless.

  **🔒 PROTECTED via skip-worktree (applied 2026-06-20).** The edit is hidden from git so a
  future `git add .` can't accidentally commit it to the shared repo:
  `git update-index --skip-worktree android/app/build.gradle`
  Consequences a future session MUST know (skip-worktree is invisible in `git status`):
  - The file shows CLEAN in `git status` even though it has a local edit. Verify with
    `git ls-files -v android/app/build.gradle` → leading `S` = skip-worktree active.
  - To genuinely edit/commit build.gradle, or if a `git pull`/merge complains about local
    changes to it: `git update-index --no-skip-worktree android/app/build.gradle`, do the
    pull/edit, then (if keeping the preview block) re-apply skip-worktree.
  - If the edit is ever lost, restore from the exact snippet in the "native edit" section
    below (this `.agents/` doc persists across checkouts), then re-apply skip-worktree.

- Release-build OOM discovered + worked around in the script (GRADLE_OPTS Metaspace/heap
  bump; committed gradle.properties NOT touched).

**Created:** 2026-06-20
**Why (original):** Test whether the "area above the tab bar slides in low / snaps at
transition end" glitch happens in a RELEASE build, or is only a dev-build artifact. Cause is
an Android native-stack + edge-to-edge transition inset issue (worse on Fabric/debug) — see
`.agents/issues/.done/2026-06-20-composer-drops-behind-tab-bar-during-slow-chat-load.md`. ANSWERED:
dev-only; no production layout bug; no nav change needed.

---

## ✅ READY TO EXECUTE (run in a SEPARATE session — keep the bug session clean)

This session (the one that diagnosed the bug) stays as context. Run the build in a fresh
session. Everything needed is below — no re-investigation required.

### Environment — VERIFIED 2026-06-20 (do NOT re-derive)

- Gradle cache already on SSD: `GRADLE_USER_HOME=C:\gradle` (populated). ✓ nothing to do.
- Accented-username workaround: handled by forcing `java.io.tmpdir=<local temp>/` — the existing
  `.agents/scripts/build-app.ps1` already does this; the prod script clones it. ✓
- MAX_PATH gate satisfied: `react-native-keyboard-controller` = 1.21.11 (needs ≥1.20.5). ✓
- `$HOME` resolves via the `LaMat` junction → paths stay accent-free. ✓
- New Arch / Fabric = ON (relevant: widens the transition snap window).
- Phone: user connects via USB for this build (was Wi-Fi adb `<phone-ip>:5555` during
  diagnosis). Confirm with `adb devices` showing a USB device (not the `:5555` Wi-Fi entry).

### Build mode — DECIDED: build APK first, install separately. Phone via USB.

User chose APK-first (build can't be wasted by a disconnect) and will connect the phone via
USB (more reliable than Wi-Fi adb). So:

- Build (no phone needed):
  `$env:ORG_GRADLE_PROJECT_previewVariant="true"; .\android\gradlew.bat :app:assembleRelease`
  (with the build-app.ps1 tmpdir preflight applied — clone it into `build-prod-variant.ps1`)
- Then install separately (USB):
  `adb install -r android\app\build\outputs\apk\release\app-release.apk`
- Launch explicitly (avoids the deep-link disambiguation dialog):
  `adb shell am start -n com.quilibrium.quorummobile.preview/.MainActivity`

### 🚨 NON-NEGOTIABLE: do NOT overwrite the live app OR the debug app

Three independent applicationIds (= three independent apps, no overwrite) — IF the suffix
applies:

- `com.quilibrium.quorummobile` (LIVE — real user data) — must stay untouched
- `com.quilibrium.quorummobile.debug` (current debug build) — must stay untouched
- `com.quilibrium.quorummobile.preview` (NEW — this build)

THE ONLY WAY THIS GOES WRONG: if the `previewVariant` flag silently fails to apply, the
release build emits `com.quilibrium.quorummobile` (the LIVE id) and `adb install -r` would
OVERWRITE the live app. Guard against it at TWO layers:

1. **Build-time guard (add to build.gradle, fails the build if misconfigured).** Inside the
   `if (project.hasProperty('previewVariant'))` block, after setting the suffix, also assert
   it's a release build, and add a separate hard check that the final id is the preview one.
   Simplest safe form — refuse to build a release without the flag if intent was preview:
   the operator MUST pass the flag; the post-build APK id check below is the real backstop.
2. **Pre/post install assertion (MANDATORY — run both):**
   - Inspect the built APK's actual applicationId BEFORE installing:
     `(& $env:ANDROID_HOME\build-tools\<ver>\aapt.exe dump badging <apk>) | Select-String "package: name"`
     — it MUST read `com.quilibrium.quorummobile.preview`. If it reads
     `com.quilibrium.quorummobile` (no suffix) → STOP, DO NOT INSTALL (flag didn't apply).
   - `adb shell pm list packages | findstr quilibrium` BEFORE install → expect exactly the
     live + debug ids.
   - Install ONLY after the APK id is confirmed `.preview`.
   - `adb shell pm list packages | findstr quilibrium` AFTER → live + debug UNCHANGED, plus
     the new `.preview`. Three entries.

If the APK id is anything other than `...preview`, the flag failed — fix the gradle edit,
rebuild, NEVER install the un-suffixed APK.

### The one native edit to make first (Option A — see below for rationale)

In `android/app/build.gradle`, inside `buildTypes.release { ... }`, add:

```gradle
if (project.hasProperty('previewVariant')) {
    applicationIdSuffix '.preview'
    versionNameSuffix '-preview'
}
```

Leave the rest of `release` unchanged. Plain release (EAS/prod, no flag) stays
`com.quilibrium.quorummobile`. With the flag → installs as
`com.quilibrium.quorummobile.preview` (the required THIRD id).

### What to observe

Open a channel + a DM on the `.preview` app. Watch the area above the tab bar during the
slide-in (use "Show layout bounds" too). Does the whole bottom area still slide in low and
snap at transition end? Report back to the bug session.

## Hard constraint (user)

The phone already has TWO Quorum apps installed (verified via `adb shell pm list packages`):

- `com.quilibrium.quorummobile` — the REAL app (REAL user data — NEVER touch)
- `com.quilibrium.quorummobile.debug` — the current DEBUG build under test (don't touch)

The new production variant **MUST install as a THIRD, distinct applicationId** so all three
coexist. It must NOT overwrite either of the above. (See memory: never-uninstall-real-app-
data-loss — a release build as-currently-configured would collide with the real app.)

## The collision risk (must solve before building)

`android/app/build.gradle`:

- `defaultConfig.applicationId = 'com.quilibrium.quorummobile'`
- `buildTypes.release` → NO applicationId suffix → emits `com.quilibrium.quorummobile`
  → **identical to the real app. A plain release build OVERWRITES the real app. FORBIDDEN.**
- `buildTypes.debug` → `.debug` suffix ONLY when `-PsideBySide=true` (the existing
  side-by-side pattern; this is how the current debug build got its `.debug` id).

So a release variant needs its own distinct applicationId. We do NOT want to change the
real `release` config that EAS/production uses.

## Approach options

### Option A (recommended): release build with a property-gated applicationIdSuffix

Mirror the existing `sideBySide` pattern, but for the `release` build type:

```gradle
release {
    if (project.hasProperty('previewVariant')) {
        applicationIdSuffix '.preview'
        versionNameSuffix '-preview'
    }
    ... (existing release config unchanged otherwise)
}
```

- Build with `-PpreviewVariant=true` → installs `com.quilibrium.quorummobile.preview`.
- Plain release (EAS/production, no flag) → unchanged → `com.quilibrium.quorummobile`.
- Pros: minimal native change, default release path untouched, coexists with both
  installed apps.
- Cons: signs with the debug keystore (release buildType currently uses
  `signingConfigs.debug` — fine for local testing, NOT for store upload).

### Option B: dedicated Gradle product flavor

A `preview` flavor with its own applicationId. More correct/isolated but a heavier native
change (flavor dimensions, source sets, more build config). Overkill for a one-off
verification.

=> Go with Option A unless we expect to keep a permanent third variant.

## Build mechanics (fold in the known gotchas — from build-app.ps1)

The accented Windows username + deep repo path cause two native build failures; the
production build must apply the same workarounds the existing `build-app.ps1` does:

1. Force `java.io.tmpdir=<local temp>/` (ASCII) via `JAVA_TOOL_OPTIONS` + `GRADLE_OPTS`
   (accented-username NitroModules C++ bug). See memory: nitromodules-runtime-not-ready,
   windows-maxpath-260-cold-build-failure.
2. Ensure `LongPathsEnabled` + react-native-keyboard-controller >= 1.20.5 (MAX_PATH cap).
3. Stop the Gradle daemon first so it picks up the tmpdir.

Release build is also SLOWER than debug (minify + proguard + png crunch + JS bundling).
Budget ~5–12 min. Heap OOM is possible — may need Gradle heap bump.

## Steps (proposed — execute after user OK)

1. [ ] Add the property-gated `applicationIdSuffix '.preview'` to `buildTypes.release` in
       `android/app/build.gradle` (Option A). Leave default release path untouched.
2. [ ] Write a `build-prod-variant.ps1` (clone of build-app.ps1) that:
   - applies the same tmpdir/daemon/long-path preflight,
   - runs the RELEASE assemble+install with `-PpreviewVariant=true`
     (`gradlew :app:installRelease -PpreviewVariant=true`, or `expo run:android --variant
release` with the prop passed through `ORG_GRADLE_PROJECT_previewVariant=true`),
   - confirms it installs as `com.quilibrium.quorummobile.preview`.
3. [ ] Pre-build sanity: `adb shell pm list packages | grep quilibrium` BEFORE and AFTER —
       assert the real + debug ids are untouched and a NEW `.preview` id appeared.
4. [ ] Launch the `.preview` app explicitly
       (`adb shell am start -n com.quilibrium.quorummobile.preview/.MainActivity`).
5. [ ] Reproduce: open a channel + a DM. Observe whether the composer slides in low /
       drops behind the tab bar. Release build = no `Android Bundled` lines = no Metro JIT.
   - No drop → confirms the dev-only diagnosis AND that the prefetch fix holds. Mark bug
     solved.
   - Still drops → the cause is NOT (only) the dev bundler; reopen investigation with a
     SAFE UI-thread probe (single serialized payload, no runOnJS arg fan-out) to capture
     the bad frame's actual position.

## Docs verification (2026-06-20, web-research agent — all claims cited)

Plan verified against official docs + a read of the installed `@expo/cli` source. Verdict:
SOUND, with two adjustments.

1. `applicationIdSuffix` on the `release` buildType → `applicationId + suffix` =
   `com.quilibrium.quorummobile.preview`. Side-by-side install is the EXPLICIT documented
   use case. (developer.android.com/build/build-variants)
2. `ORG_GRADLE_PROJECT_previewVariant=true` → `project.hasProperty('previewVariant')` true.
   Exact prefix `ORG_GRADLE_PROJECT_`. (docs.gradle.org build_environment)
3. ADJUSTMENT — `expo run:android` does NOT forward `-P`/`--` extra Gradle args. BUT its
   `spawnGradleAsync` spreads `...process.env` into the Gradle child, so an env var set in
   the launching shell IS inherited. So either:
   - `$env:ORG_GRADLE_PROJECT_previewVariant="true"; npx expo run:android --variant release`
   - OR raw, simpler: `$env:ORG_GRADLE_PROJECT_previewVariant="true"; .\android\gradlew.bat :app:installRelease`
     `installRelease` builds AND installs (no separate adb install). `--variant release` is
     the documented variant selector. (docs.expo.dev/more/expo-cli + installed @expo/cli source)
4. Debug-keystore signing on the release variant: fine for LOCAL install (no device block),
   NOT Play-uploadable. No signature conflict with the real app — different applicationId =
   independent app, certs irrelevant to each other. (developer.android.com app-signing)
5. ADJUSTMENT / WATCH-OUT — `applicationIdSuffix` does NOT change the deep-link scheme.
   Both the real app and `.preview` would still declare the SAME `quorum://` scheme →
   Android shows the disambiguation dialog when such a link is tapped (the exact prior
   two-Quorum-app symptom — see memory: emulator-stale-package-wrong-launch). For this
   verification test that's ACCEPTABLE (we launch the .preview app explicitly by component
   name, not via a link). If it becomes annoying, override the scheme via
   `manifestPlaceholders` in the same `if (project.hasProperty('previewVariant'))` block.
   => Launch with explicit component:
   `adb shell am start -n com.quilibrium.quorummobile.preview/.MainActivity`
6. `expo run:android` SKIPS prebuild when `android/` exists (verified in installed
   `ensureNativeProject.js`), so the manual build.gradle edit persists — never overwritten.
   (Note: the EAS variants doc warns EAS cloud can't detect `applicationIdSuffix` — N/A
   here, we build locally.)

## Notes / risks

- Debug-keystore signing on the release variant is fine for local install, but this APK is
  NOT store-uploadable. Keep it clearly a test artifact.
- Data isolation: `.preview` is a fresh app with empty storage — onboarding/login needed
  to reach a channel. Factor that into the test time.
- Do NOT `expo prebuild` (see package.json prebuild guard — iOS folder is source of truth).
- There is NO composer fix in tree (all attempts reverted). The release APK is the
  UNMODIFIED app — that's the point: test whether the glitch is dev-only.

_Last updated: 2026-06-20_
