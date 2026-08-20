---
type: bug
title: "Native batch decrypt path skips the DM auto-reveal for call frames, unlike the JS path"
status: open
priority: low
created: 2026-08-19
updated: 2026-08-19
area: DM identity / receive path
related:
  - "issues/2026-08-18-dm-identity-reveal-ledger-plan.md (Task 7 built the auto-reveal this asymmetry affects)"
---

# The batch receive path short-circuits past the auto-reveal for `call-*` frames

## Summary

The DM identity reveal ledger work added an auto-reveal: when a partner we have
already deliberately messaged opens a **new inbound session** (their new device,
or a reinstall), we answer immediately with one identity push, so their fresh
device does not have to wait for our next rename or reply.

It is wired into four receive-path points. Three are on the JS path and one is
on the native/batch path. **The two paths order their checks differently**, and
the batch path can skip the auto-reveal entirely.

READ, `context/WebSocketContext.tsx`, 2026-08-19:

- **JS path** — the three `autoRevealRef.current?.(...)` calls at `:3133`, `:3295`
  and `:3428` fire *before* `decryptedMessage` is parsed at all, so they run
  regardless of what the message turns out to be.
- **Batch/native path** — the call-signal interception at `:4984-4991`
  (`if (decryptedMessage.content?.type?.startsWith('call-') ...) { ...; continue; }`)
  runs *before* the `user_profile`-triggered auto-reveal check at `:5098-5099`,
  and `continue`s past it for every `call-*` frame.

## The scenario it affects

A long-standing partner installs on a brand-new device and their **first-ever**
contact with us is a **phone call** rather than a text message, decrypted through
the native batch path (the common path).

Our device does not proactively push our identity back via the dedicated
"friend's new device" mechanism.

## Severity: low, and it fails safe

This never over-reveals. It can only cause a *delayed* reveal, and two
independent mechanisms already cover the case:

1. If the call is **answered**, `acceptCall` reveals identity unconditionally via
   the answer frame — answering is a deliberate act under the product rule.
2. The on-connect broadcast sweep and any later text reply are independent
   backstops.

So it only matters when the call is missed or declined AND no other
init-carrying frame follows before the next sweep.

## Fix

Reorder the batch path so the `user_profile` / auto-reveal check runs before, or
independently of, the `call-*` early `continue` — mirroring the JS path, which
checks first and parses after.

**Treat this as a receive-path change and prove it.** Message delivery is the
one area where a silent regression can run for months undetected. Do not ship on
reasoning alone; the existing arms in `__tests__/dmRevealTriggers.test.ts` are
the place to add coverage.

## Status

Open, not started. Found by the final whole-branch review of the DM identity
reveal ledger branch. Deliberately NOT fixed there: it is a receive-path
reordering in a 7000-line file, arriving at the end of a long branch, for a
fail-safe gap with two working backstops. Filing beat bolting it on.

---
*Last updated: 2026-08-19*
