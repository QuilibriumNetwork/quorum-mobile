---
type: task
title: "mobile↔mobile DM round on two physical devices — first-ever test of the majority pairing"
status: done
created: 2026-07-26
updated: 2026-07-26
outcome: "DONE 2026-07-26. Two rounds run (28: reset on A, 3/20 lost; 29: reset on B, 5/20 lost). Round 28's receive side was invalidated by a rig blind spot ([DM-recv wire] missing from the batch decrypt path) which was found, fixed and verified mid-session; round 29 is the first trustworthy both-ends phone↔phone trace. HEADLINE: the node write-layer black hole reproduces mobile↔mobile — 8/25 A→B frames, ALL confirmed handed to the socket, size-blind, ~0% the other direction. Full writeup: §27 of issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md. Open follow-ups live in that doc's frontmatter `next`."
related:
  - "issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md (THE context — read PART I + §21-§26 before anything)"
  - "https://github.com/QuilibriumNetwork/quorum-mobile/issues/183 (the two upstream root causes, filed to the Lead)"
---

# mobile↔mobile DM round on two physical devices

## Why

mobile↔mobile is the **majority pairing and has never been tested once** in six
months of this bug. Both endpoints carry the write-layer black hole (~12% of
writes vanish, bug doc §24-§25) and doubled trigger surface for the upstream
crate fork (§23), so this round has discovery potential, not just confirmation.
The full diag rig runs on BOTH ends for the first time — every frame joins by
envelope fingerprint in both directions.

## Hard constraints (from the bug doc — do not skip)

- **SEND PATH IS FROZEN** (§23): no changes to session/re-key/handshake code,
  no matter what this round shows. Mobile's re-key-per-unconfirmed-send
  accidentally shields the crate fork.
- **No repo edits while the user is mid-run on the devices.**
- **No armed markers = no round.** This rule was violated twice (rounds 26,
  27 — marker predated the logcat window); the fix is: reload the app AFTER
  the capture .bat is running.

## STATUS 2026-07-26 evening — setup attempted, round NOT yet run

the user hit issues bringing the two devices up (details not captured) and
postponed. The orchestrator script has NEVER had a successful live run —
treat its first run as a shakedown: if it misbehaves, get the exact error
from the user and fix, or fall back to the manual ritual at the bottom.
Unknown: whether the Motorola's one-time setup completed. Verify first:
`adb -s <motorola-serial> shell pm list packages com.quilibrium.quorummobile`
— if `...quorummobile.debug` is missing, do the one-time install below.

**the user will have forgotten the details — walk him through step by step,
one instruction at a time, plain language. His known-good solo routine was:
dev-start-mobile.ps1 → press 'a' → capture-xptrace.bat. The orchestrator
replaces all three for two phones; explain it in those terms.**

## Pre-flight (agent side, before the user touches devices)

- [ ] **REPOS ARE PARKED ON master/main** (2026-07-26, deliberate). Switch
      mobile to `diag/dm-frame-trace` (head `99a6a23`) FIRST; if master has
      moved, rebase the branch onto master and rerun tests (tsc 20-error
      baseline, 80/80 suites). Desktop's diag branch is
      `diag/dm-frame-join` in quorum-desktop — NOT needed for this round
      (desktop stays closed) but that's where its rig lives.
- [ ] Transport patch v2 applied: `node .agents/scripts/patch-rn-ws-diag.mjs`
      (idempotent; lives in node_modules so git branch switches do NOT
      remove it, but ANY `yarn install` does — re-run it if in doubt; v2 =
      has the `sig=` field)
- [ ] Metro cache: first run after the branch switch should use
      `-ResetCache` (the orchestrator forwards it:
      `two-device-round.ps1 -s1 ... -s2 ... -ResetCache`)
- [ ] Desktop is NOT involved in this round — desktop app stays closed so
      its drains can't consume anything

## Device setup (the user, one-time for device 2 — may already be done, verify)

Device 1 = Samsung A40, USB serial `<device-1-serial>` (his usual test phone,
fully set up). Device 2 = Motorola Edge 50 Fusion.

- [ ] Both phones plugged in via USB → `adb devices` → note the Motorola's
      serial (accept the USB-debugging prompt on its screen)
- [ ] Install the dev client on it (the APK is a prebuilt shell — its date
      does not matter, all JS comes live from Metro):
      `adb -s <motorola-serial> install -r android\app\build\outputs\apk\debug\app-debug.apk`
- [ ] Open that app on the Motorola and sign into a SECOND account (must be
      a different account than the Samsung's; fresh install = fresh device
      identity — expected and fine)

## The round (the user) — ONE COMMAND

```powershell
.\.agents\scripts\two-device-round.ps1 -s1 <serial1-USB> -s2 <serial2>
```

BOTH devices via USB cable (verified working 2026-07-26 — the reliable
setup; Wi-Fi adb `<ip>:5555` for -s2 stays as fallback only, it drops when
the phone dozes). The orchestrator does everything:
Metro + device 1 (own window, leave it open), device 2 tunnel + launch,
both captures (minimized), relaunches both apps so the markers land inside
the captures, and PRINTS the four-marker check itself (green = round valid).
Then:

1. Reset the DM session from device A, 12 alternating messages each way
   (`a1`, `b1`, `a2`, …), note delivered / not-delivered per message.
2. Press Enter in the orchestrator window → captures stop, it prints the
   two log file paths. Hand those + notes to the analysis session.

Fallback if the orchestrator misbehaves (manual ritual, same pieces):
`dev-start-mobile.ps1 -s <s1>` → wait for app → `connect-second-device.ps1
-s <s2>` → two terminals of `capture-xptrace.bat <serial>` → reload both
apps → check 4 markers by hand.

## Analysis (agent, fresh session)

- [ ] Verify 4 armed markers; identify each side's conversation inboxes
- [ ] Frame-join BOTH directions: `[DM-send wire]` fps ↔ peer's
      `[DM-recv wire]` fps (first round where both ends have both)
- [ ] For every loss, classify: never-left-JS ([WS-frame] absent) /
      handed-to-native-and-vanished (black hole — note `sig=` value) /
      arrived-but-undecryptable (which retry pattern: heals vs permanent —
      permanent + first-frames-lost = crate-fork candidate, §23)
- [ ] Receipt-class vs post-class loss rates (does round 26's 10/10 read-ack
      kill reproduce phone↔phone?)
- [ ] Check the §22 fixes hold on BOTH ends: zero `processing FAILED`
      crash-loops, zero wrong-key redelivery storms
- [ ] Write §27 in the bug doc; update frontmatter status/next + §A/§C
- [ ] If the round surfaces node-side evidence (e.g. black hole reproduces
      phone↔phone), append the data points to issue #183 as a comment —
      more ammunition for the Lead, zero extra asks

## Expected outcomes and what they mean

- **Clean-ish round (loss ≈ desktop rounds, all decrypt failures heal):**
  mobile↔mobile is no worse than mobile↔desktop — the #178-#182 fixes carry
  over. Update §C.6, close the coverage gap.
- **Black hole reproduces (~12%, type-skewed or not):** strong evidence it's
  node-side (two different receivers, same loss) — comment on #183.
- **Permanent one-way decrypt death after a lost establishment frame:** the
  crate fork (§23) observed live phone↔phone — comment on #183 with the
  frame trace; do NOT attempt a client-side fix (frozen).
- **Something new:** it goes in the bug doc as §27 with the same
  evidence-first discipline (offline replay before device time, §E
  meta-lesson).

---

_Last updated: 2026-07-26_
