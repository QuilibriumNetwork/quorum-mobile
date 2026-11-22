---
type: bug
title: "quorum-shared WS transport: uncaught reconnect rejection floods dev LogBox"
status: open
priority: medium
ai_generated: true
created: 2026-07-28
updated: 2026-07-28
---

# quorum-shared WS transport: uncaught reconnect rejection floods dev LogBox

> **⚠️ AI-Generated**: May contain errors. Verify before use.

## Symptoms

- Dev builds show a persistent red LogBox toast at the bottom of the screen:
  `Uncaught (in promise, id: N) Error: WebSocket error`, covering the tab bar
  and making navigation nearly impossible.
- Reappears every few seconds on flaky connectivity (observed on H+ cellular,
  2026-07-28; LaMat reports the same toast seen in earlier sessions too).
- Production/release builds are unaffected (LogBox is dev-only), but each
  occurrence is a real unhandled promise rejection at runtime.

## Root Cause

The bug is in **`@quilibrium/quorum-shared`** (installed `2.1.0-37`), not in
mobile's own code. In `src/transport/rn-websocket.ts`:

- `ws.onerror` does `reject(new Error('WebSocket error'))` on the in-flight
  connect promise (line ~144-148).
- `ws.onclose` schedules reconnection with
  `setTimeout(() => this.doConnect(), this.reconnectInterval)` (line ~140)
  — the promise returned by `doConnect()` is **never awaited or caught**.

So every reconnect attempt that fails produces one uncaught rejection → one
LogBox toast. The same pattern exists in the sibling
`src/transport/browser-websocket.ts` (affects desktop/web consumers).

Mobile's own three `new WebSocket(...)` sites were audited and are clean
(`BackgroundMessageService` resolves with `{success:false}`,
`farcasterSpaceSocket` no-ops onerror, harness is comment-only).

## Solution

Two layers; only the first is done:

1. **Mobile workaround (applied 2026-07-28, this repo):** dev-only LogBox
   suppression in `app/_layout.tsx` — `LogBox.ignoreLogs([/WebSocket error/])`.
   Hides the toast; metro/terminal logging and the globalErrorReporter hook
   are unaffected.
2. **Real fix (pending, quorum-shared repo — Lead Dev's package):** catch the
   reconnect promise, e.g.
   `setTimeout(() => { void this.doConnect().catch(() => {}) }, ...)`
   (the error is already surfaced via `emitError`), in BOTH
   `rn-websocket.ts` and `browser-websocket.ts`. Needs a version bump +
   republish, then bump the dependency here and remove the LogBox suppression.

- File changes (workaround): `app/_layout.tsx` (LogBox.ignoreLogs block)
- Key insight: the toast text never matched any app source because the
  throw site is inside `node_modules/@quilibrium/quorum-shared/src/transport/`.

## Prevention

- Any fire-and-forget call of a promise-returning method (`setTimeout(() =>
this.doConnect())`) must attach a `.catch`; transports that auto-reconnect
  are the classic offender.
- When a LogBox error matches nothing in the repo, grep `node_modules` for the
  literal message before assuming app code is at fault.
- Remove the `_layout.tsx` suppression once quorum-shared ships the fix, so
  genuinely new WebSocket rejections become visible again.
