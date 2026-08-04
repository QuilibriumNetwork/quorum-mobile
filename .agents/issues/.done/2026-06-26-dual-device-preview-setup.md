---
type: task
title: "Task: reliable two-device preview setup (test on 2 phones at once)"
status: done
created: 2026-06-26
---

# Task: reliable two-device preview setup (test on 2 phones at once)

*Created: 2026-06-26. Status: DELIVERED 2026-07-26 (pending first live validation). Standalone — not tied to any feature work.*

> **Update 2026-07-26 — built.** The one-command deliverable exists:
> `.agents/scripts/two-device-round.ps1 -s1 <usb-serial> -s2 <serial-or-ip:5555>`
> — spawns Metro + device 1 (dev-start-mobile.ps1 in its own window), tunnels +
> launches device 2 (`connect-second-device.ps1`, USB or Wi-Fi adb, answering
> research question 1: per-device adb reverse works over both), starts both
> logcat captures minimized, relaunches both apps so diag markers land inside
> the captures, auto-verifies the markers, stops everything on Enter. Built for
> the mobile-to-mobile DM round (issues/.done/2026-07-26-mobile-to-mobile-two-device-round.md).
> Wi-Fi drop mitigation: screen on + charger; re-run connect-second-device on drop.
> Close this task after the first successful live run.

## Goal

A **solid, easy-to-set-up, works-every-time** way to run the quorum-mobile dev build on **two physical devices simultaneously** off one machine. The user wants to compare behaviour across devices live (e.g. an old Android vs a modern one). Connection method is whatever is SIMPLEST and most reliable — both USB, both WiFi, or one of each. The user does NOT care which; they care that it's one-command and doesn't break.

**Deliverable:** ideally a single script (or a documented 2-step ritual) that brings up both devices on the same Metro and Just Works. Add it to `.agents/scripts/` alongside the existing launchers and document it. Update relevant memories.

## Hard requirement from the user

> "I want a solid solution, something very easy to set up and that will work every time."

Do NOT hand over a fragile sequence of manual adb commands. If the robust answer turns out to be "both via USB" (likely the most reliable), that's fine — say so plainly.

## What we already know (learned the hard way 2026-06-26)

- **One Metro on 8081 CAN serve multiple devices.** The question is purely how each device reaches it.
- **USB device → `adb reverse tcp:8081 tcp:8081`:** rock solid. Phone hits `localhost:8081`, tunnels over USB. This is the reliable path. The existing `.agents/scripts/dev-start-mobile.ps1` does this for one USB device.
- **WiFi device → the fragile part.** Two sub-problems hit today:
  1. **WiFi `adb` drops** (`device offline` mid-session). So a WiFi device's `adb reverse` tunnel dies intermittently → app can't reach Metro.
  2. Even pointing the WiFi app at the PC LAN IP `http://<pc-lan-ip>:8081` (PC's WiFi IP; phone was `<phone-ip>`; NOT `localhost`), the phone SHELL could curl Metro fine (`packager-status:running`) but the dev-client APP threw **"Unable to load script. Make sure you're running Metro / device on same WiFi."** Cause still unknown — see research questions.
- **Firewall is NOT the blocker.** Verified an inbound allow rule `Metro Bundler 8081 (React Native dev)` (TCP 8081, any remote) already exists + enabled, plus a Node.js allow rule. So `allow-metro-firewall.ps1` does not solve this.
- **Two-device confusion was real:** with both the USB Samsung AND the WiFi Motorola connected + a port-8082 Metro fallback in play, things got tangled. When the user UNPLUGGED the Samsung and loaded ONLY the Motorola over WiFi, **it loaded fine.** So the WiFi "unable to load script" was likely caused by the two-device/two-Metro confusion, NOT a fundamental WiFi limitation. This is the key clue.

## The two test devices (context, not a constraint)

See memory `test-devices-samsung-a40-old-motorola-edge50`:
- Samsung Galaxy A40 — SM-A405FN, Android 11, USB serial `<device-1-serial>`.
- Motorola Edge 50 Fusion — Android 16, seen over WiFi as `<phone-ip>:5555`.
- PC WiFi IP today: `<pc-lan-ip>`. (Both must be on the same LAN/subnet for any WiFi path.)

## Existing assets to build on

- `.agents/scripts/dev-start-mobile.ps1` — USB single device (adb reverse + auto-launch). Memory `dev-start-mobile-must-stay-interactive`, `dev-start-mobile-not-hung-slow-expo-start-plus-dirty-transcript`.
- `.agents/scripts/dev-start-mobile-wifi.ps1` — pins LAN IP via `REACT_NATIVE_PACKAGER_HOSTNAME` + `--lan`; has `-DryRun`. Memory `dev-start-wifi-expo-host-flag-and-dryrun`, `ps-host-reserved-param-name` (never name a param `-Host`). PROBLEM: tries to start a SECOND Metro → collides with the first device's Metro on 8081 ("log locked").
- `.agents/scripts/dev-start-emulator.ps1` — emulator path.
- `.agents/scripts/allow-metro-firewall.ps1` — firewall (already satisfied here, but keep in mind for fresh machines).
- Memory `physical-device-load-script-firewall` — the "unable to load script" + firewall + IPv6-bind history.

## Research questions to answer in this task

1. **Canonical multi-device Metro setup.** What's the supported Expo/RN way to run ONE Metro serving two devices at once? Hypothesis: one Metro on 8081; each device gets its OWN `adb reverse tcp:8081 tcp:8081` (works for USB AND WiFi-adb — it's per-device). Then every device just uses `localhost:8081`, sidestepping LAN-IP/firewall entirely. Verify this is reliable for a WiFi-adb device despite the drop issue (maybe re-running `adb connect` + `adb reverse` on reconnect is enough, or maybe both-USB is simply better).
2. **Why did the WiFi dev-client throw "unable to load script" when the shell could reach Metro?** Candidates: dev-launcher cached a stale bundle URL (`localhost` from a dead reverse) — fix via dev menu → "Change bundle location" / shake → Settings → Debug server host; OR the dev build's default `index.bundle` host was wrong because `REACT_NATIVE_PACKAGER_HOSTNAME` wasn't set; OR the second Metro on 8082 served a different/empty graph. Reproduce with ONLY the WiFi device connected (which worked once) to isolate.
3. **Simplest reliable topology.** Compare: (a) both USB + `adb reverse` each [probably most reliable], (b) one USB + one WiFi, (c) both WiFi. Recommend ONE as the default and script it. The user said both-USB is acceptable if it's the solid one.
4. **Does `dev-start-mobile.ps1` already work for N devices?** If it sets `adb reverse` per connected device and launches each, maybe the fix is just "run it, it loops over `adb devices`." Check whether it targets a single device or all.

## Suggested shape of the solution

A `dev-start-mobile-multi.ps1` (or extend the existing launcher) that:
1. Starts ONE Metro on 8081 (reuse if already running; never double-start → that was the "log locked" bug).
2. Enumerates ALL connected devices (`adb devices`), and for EACH: `adb -s <serial> reverse tcp:8081 tcp:8081` (+8082 if used), then launches `com.quilibrium.quorummobile.debug` with an explicit `-n .../.MainActivity` (see memory `emulator-stale-package-wrong-launch`).
3. For WiFi devices: handle the drop case — re-`adb connect` + re-`reverse` on reconnect, or document that WiFi devices should be plugged in for the initial load.
4. Keeps the interactive `a`/`r` keypress menu working (memory `dev-start-mobile-must-stay-interactive` — don't pipe expo through Tee-Object).
5. `-DryRun` to validate without launching (pattern from the wifi script).

## Acceptance

- Run ONE command → both devices load the dev build off the same Metro, reliably, repeatably.
- Documented in the script header + a memory entry. The user can do it again next week without re-figuring it out.

*Last updated: 2026-06-26*
