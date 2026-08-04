---
type: task
title: "Handoff — light-theme contrast (DONE) + nav-bar fix (built, unverified) + dual-device preview setup (the real open problem)"
status: in-progress
created: 2026-06-26
---

# Handoff — light-theme contrast (DONE) + nav-bar fix (built, unverified) + dual-device preview setup (the real open problem)

*Created: 2026-06-26. Branch: `style/light-theme-contrast`.*

## TL;DR for the next session

Two things are basically finished and committed; ONE thing is the actual open problem to solve in the new session:

1. **Light-theme text contrast — DONE, committed, user-verified on device.** Don't reopen.
2. **Android nav-bar light-in-dark-theme fix — DONE + committed (`f5131f7`) + VISUALLY CONFIRMED on the Motorola Edge 50 (Android 16) over WiFi (2026-06-26).** The bottom bar is correctly themed (no longer stuck white) in dark mode. Closed. (The persistent white bar on the old Samsung A40 / Android 11 is an OEM limitation — that device ignores `enforceNavigationBarContrast=false` — not a code bug; do not chase it.)
3. **THE OPEN PROBLEM: a solid, repeatable way to preview on TWO physical devices at once** (one USB + one WiFi). This is what burned 30+ min and what the user wants solved cleanly. **Research this fresh.**

The user explicitly wants: *"a solid solution, something very easy to set up that will work every time."* Don't hand them another fragile sequence of adb commands.

---

## 1. Light-theme contrast — DONE (do not reopen)

Root cause: app used `theme.colors.textMuted` (#b6b6b6 light = placeholder/disabled tone) as the PRIMARY color for description/subtitle/label/callout text → invisible on light surfaces. Fix: re-point those to `textSubtle` (#818181 light); a few info-callouts on tinted cards → `textMain`. Dark `textSubtle` was quieted #bfb5c8→#9b8fa6 so dark didn't get louder.

Committed (this branch): `67c2c3a`, `a9fd2e9`, `0c5df30`, `093d34f`, `a8ee4b5` (the app-wide sweep of ~370 spots). Full audit JSON: `.agents/tasks/light-theme-contrast/2026-06-26-textmuted-audit.json`. User confirmed light + dark both look good on device. NOTE: an apply-workflow made 3 out-of-scope edits that were caught + reverted (smart quotes, a removed confirm dialog, a hallucinated banner feature) — see memory `apply-workflow-needs-diff-integrity-scan`.

## 2. Android nav-bar light-in-dark-theme — CODE DONE, NOT visually confirmed

**Symptom:** in dark theme, the Android bottom system nav bar shows LIGHT on some screens (button-opened modals: SpaceSettings, UserProfile, ProfileSplitMode, etc.). Correct (dark) on others.

**Root cause (verified against Expo's own installed type docs, not guessed):** app is edge-to-edge (`edgeToEdgeEnabled: true`). `android/app/src/main/res/values/styles.xml` had `android:enforceNavigationBarContrast = true`, which makes Android auto-paint a contrast scrim behind the nav bar — reads light. Confirmed via `node_modules/expo-navigation-bar/build/NavigationBar.d.ts` (nav-bar control requires `enforceNavigationBarContrast=false`) and `@expo/config-types` schema (`enforceContrast` default true = "keep nav bar translucent for contrast"). Also RN Modals in edge-to-edge need `navigationBarTranslucent` (expo/expo#39749, zoontek/react-native-edge-to-edge#25).

**Fix applied (committed — verify with `git log`):**
- `android/app/src/main/res/values/styles.xml`: `enforceNavigationBarContrast` true→**false** (THIS is the real fix; it's the file that actually compiles — this project builds the committed `android/` directly, NO prebuild, see `package.json` prebuild guard).
- `app.json`: added top-level `androidNavigationBar.enforceContrast: false` (config mirror; only matters if anyone ever prebuilds).
- `navigationBarTranslucent` prop added to RN `<Modal>` in: `BaseModal.tsx` (committed by the OTHER agent in `3c878fe`), `CenterModal.tsx`, `CreateSpaceSheet.tsx`, `AudioSpaceOverlay.tsx`, `MigrationModal.tsx`, `SocialFeed/media/ImageViewer.tsx`, `SocialFeed/media/VideoViewer.tsx`.

**Why it needs a NATIVE rebuild (not a reload):** `styles.xml` is a compiled Android resource. There is NO runtime JS API to flip `enforceNavigationBarContrast` (checked the whole `expo-navigation-bar` export surface). A Metro reload cannot change it.

**Build status:** native `.debug` rebuild SUCCEEDED (`BUILD SUCCESSFUL in 3m 10s`), APK at `android/app/build/outputs/apk/debug/app-debug.apk`, manually installed onto the Motorola over WiFi (`adb -s <phone-ip>:5555 install -r ...` → Success). So the fix IS on the Motorola — we just never saw it because the app wouldn't load its JS bundle.

**Device caveat (test-device notes):** the Samsung Galaxy A40 (SM-A405FN, Android 11, USB serial `<device-1-serial>`) is OLD and its One UI IGNORES `enforceNavigationBarContrast=false` — so the light bar persists there NO MATTER WHAT. That is an OEM limitation, NOT a code bug; do not chase it. The reference device is the **Motorola Edge 50 Fusion (Android 16, WiFi `<phone-ip>:5555`)** which DOES honor the flag. **The only thing left for this fix is: load the app on the Motorola in dark theme, open Space Settings, confirm the bottom bar is dark.**

## 3. THE OPEN PROBLEM — solid dual-device preview (research this fresh)

Goal: preview on BOTH the USB Samsung AND the WiFi Motorola reliably, easy to set up, works every time. What we learned the hard way:

- ONE Metro on 8081 can serve both devices. USB device uses `adb reverse` (rock solid). WiFi device is the problem.
- WiFi `adb` keeps DROPPING (`device offline` mid-session) → any `adb reverse` tunnel for the WiFi device dies with it. So `adb reverse` is NOT reliable for the WiFi device.
- Pointing the Motorola app at the PC LAN IP `http://<pc-lan-ip>:8081` (PC's WiFi IP; phone is `<phone-ip>`; do NOT use `localhost` = the phone itself): the phone's SHELL could curl Metro successfully (`packager-status:running`), but the APP threw **"Unable to load script. Make sure you're running Metro / on the same WiFi"**.
- **Firewall is NOT the cause** — checked: an inbound allow rule `Metro Bundler 8081 (React Native dev)` for TCP 8081 already EXISTS and is enabled (+ a Node.js allow rule). So the usual `allow-metro-firewall.ps1` fix does not apply here.
- So the app-level "unable to load script" over LAN has some OTHER cause (dev-client URL handling? the dev-launcher caching a stale `localhost`/reverse URL? two-Metro confusion from the earlier port-8082 fallback? `REACT_NATIVE_PACKAGER_HOSTNAME` not set so the dev build defaults to the wrong host?). **This is the thing to RESEARCH in the new session.**

Existing assets to leverage (memories + scripts):
- `.agents/scripts/dev-start-mobile-wifi.ps1` — pins LAN IP via `REACT_NATIVE_PACKAGER_HOSTNAME` + `--lan`; has a `-DryRun` switch. Memory `dev-start-wifi-expo-host-flag-and-dryrun`. This is probably the RIGHT path for the WiFi device but it tries to start a SECOND Metro (collides with the USB device's Metro on 8081 → "log locked"). Need a way to either share one Metro across both or run a second Metro on another port cleanly.
- `.agents/scripts/dev-start-mobile.ps1` (USB), `.agents/scripts/dev-start-emulator.ps1`.
- Memories: `physical-device-load-script-firewall`, `dev-start-mobile-must-stay-interactive`, `dev-start-mobile-not-hung-slow-expo-start-plus-dirty-transcript`, `ps-host-reserved-param-name`.

**Suggested research questions for the new session:**
1. What's the canonical Expo/RN way to run ONE Metro serving a USB device AND a WiFi device simultaneously? (Likely: one Metro on 8081, USB via `adb reverse`, WiFi via `REACT_NATIVE_PACKAGER_HOSTNAME=<PC LAN IP>` baked so the dev build's `index.bundle` URL points at the LAN IP — NOT `localhost`.)
2. Why does the dev-client throw "unable to load script" when the shell can reach Metro? (dev-launcher saved-URL cache? clear via the dev menu → "Change bundle location"? the dev build was launched before `adb reverse` so it cached `localhost`?)
3. Should the Motorola be moved to USB for the FIRST load (reliable), confirmed, then the fix is done — and treat WiFi dual-preview as a separate nice-to-have? (Pragmatic: the user has a USB cable; plugging the Motorola in once to confirm the nav-bar fix is the 2-min path, vs solving WiFi dual-preview which is the bigger project.)

## Git state at handoff
- Branch `style/light-theme-contrast`, NOT merged (mobile's higher bar; nav-bar fix unconfirmed on a honoring device).
- A SECOND agent is/was working in this same tree (it committed `bdb52b6`, `3c878fe` incl. our BaseModal nav prop). Leave its changes alone.
- The nav-bar files (styles.xml, app.json, 6 modal props) — committed by this session (see `git log`). If `git status` shows them still pending, commit them so the tree is clean before the new session.

## Active `adb reverse` / connection state when we stopped
- Samsung `<device-1-serial>` (USB): `adb reverse` tcp:8081+8082 → Metro. Working.
- Motorola `<phone-ip>:5555` (WiFi): had `adb reverse` set too but the WiFi link drops; app couldn't load bundle. This is the unsolved part.
- A Metro is/was running on 8081 (the user's, for the USB device). Don't kill it blindly.

*Last updated: 2026-06-26*
