---
type: task
title: "Mobile's `auth:user` record has no live writer, so a rename made on another device waits for a relaunch"
status: open
priority: low
created: 2026-08-05
updated: 2026-08-11
area: identity resolution / config sync / cross-device
repos: quorum-mobile (this), quorum-desktop (where the question was raised)
source: re-filed 2026-08-11 out of quorum-desktop's `2026-08-05-mobile-identity-parity-after-the-desktop-phase-1-fix.md` §1 row 1, which was closed as a tracker. This was its only remaining item and had no home in this repo.
related:
  - "quorum-desktop/.agents/issues/.done/2026-08-05-mobile-identity-parity-after-the-desktop-phase-1-fix.md (the tracker this came from)"
  - "quorum-desktop/.agents/issues/.done/2026-08-05-own-identity-cross-device-sync-design.md (the desktop equivalent, and how desktop fixed it)"
---

# `auth:user` has no live writer for a rename made on another device

## Status

**Open, and cheaper than it was: the original claim is half refuted.** Nothing has
been fixed; what changed on 2026-08-11 is that the mechanism was traced, so
whoever picks this up does not start from the wrong hypothesis.

## What was originally claimed, and what is actually true

The desktop tracker asserted (as a *guess*, explicitly labelled "probably YES"
and "nothing here is asserted"):

> mobile has the same shape: an MMKV `auth:user` record in `AuthContext`, and its
> **config→user bridge runs only on the login path**. A rename made on desktop may
> not reach mobile's own surfaces until relaunch.

READ 2026-08-11, `context/AuthContext.tsx`:

| the claim | verdict |
|---|---|
| there is an MMKV `auth:user` record read by self surfaces | ✅ **confirmed** — `STORAGE_KEYS.USER = 'auth:user'` (`:91`), read in `WebSocketContext.tsx`, `services/config/configService.ts` and `services/notifications/pushReceivedTask.ts` |
| the config→user bridge **runs only on the login path** | ❌ **REFUTED** — it lives in the *"Load persisted auth state on mount"* effect (`:196-197`), gated only on `storedUser && storedState === 'authenticated'` (`:203`). It runs on **every mount for an already-authenticated user**, not just at login |
| a rename made elsewhere may not land until relaunch | ⚠️ **plausible and unrefuted, for a different reason** — see below |

So the conclusion survives while its reasoning does not, which is the useful part:
**mobile does pick up a remote rename, on every cold start.** The bridge fetches
the config (`:331`), and `displayName: config.name || base.displayName` (`:358`,
mirrored to MMKV at `:372-383`) is a truthy fill that applies regardless of the
`configIsNewer` timestamp comparison. A desktop rename is therefore visible after
a relaunch, reliably.

## The actual, narrower defect

**There is no writer on the receive side while the app is running.** The bridge is
a mount-time task, not a subscription. Nothing re-runs it when a config arrives,
and no live channel writes `auth:user`.

Predicted symptom, NOT yet measured: rename yourself on desktop while mobile is
open and stays open; mobile's own self surfaces keep the old name until the app is
relaunched (or `AuthProvider` remounts).

This is the same shape as the desktop defect that
`2026-08-05-own-identity-cross-device-sync-design.md` §5-A fixed there, and it is
milder — desktop's store had **no writer at all** on the receive side ("not lag,
no path at all"), whereas mobile's has one that only fires at mount.

## How to settle it

One device pair, one observation, no instrumentation needed:

1. Mobile open and foregrounded, showing a self surface with your display name.
2. Rename yourself on desktop, and confirm the desktop config publish succeeded.
3. Watch mobile **without backgrounding or relaunching it** for a few minutes.
4. Then relaunch mobile and look again.

Old name in step 3 and new name in step 4 confirms it exactly. New name in step 3
refutes it and this closes.

⚠️ **Do not background the app between steps** — a background/foreground cycle may
remount `AuthProvider` and would silently turn this into the relaunch case,
producing a false negative.

## Why the priority is low

Cosmetic, self-correcting on the next launch, and it only affects **your own name
on your own device**. Renaming is rare. Contrast with the two live transport bugs
in the desktop repo, which do not self-correct at all.

## Definition of done

- [ ] The step 1-4 observation run, and its result recorded here either way
- [ ] If confirmed: decided with the lead whether a live writer is worth it, or
      whether mount-time refresh is acceptable given the priority above

---

*Last updated: 2026-08-11*
