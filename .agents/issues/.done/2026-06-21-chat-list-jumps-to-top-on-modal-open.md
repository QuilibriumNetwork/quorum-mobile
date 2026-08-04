---
type: bug
title: "Chat message list jumps to the top (first message) when a modal opens/closes over it"
status: done
created: 2026-06-21
---

# Chat message list jumps to the top (first message) when a modal opens/closes over it

> ⚠️ **REGRESSED 2026-06-26, re-fixed 2026-07-27.** PR #141 (`bf5768c`) added
> `statusBarTranslucent` + `navigationBarTranslucent` to `BaseModal`, `CenterModal`,
> `ImageViewer` and `VideoViewer`, which made their focus-less keyboard event carry a
> POSITIVE `target` — so the `e.target <= 0` guard below stopped catching it. The patch
> now also drops no-op events (`height === 0` while `padding === 0`), which is
> modal-agnostic. See
> `.agents/issues/.done/2026-07-27-chat-list-jumps-to-top-regression-translucent-modals.md`.
> Read that one too before touching this patch.

**Status:** ✅ SOLVED (2026-06-22). Fixed via a `patch-package` patch to
`react-native-keyboard-controller`. Verified on-device (Android): the jump is gone on
EVERY chat modal (Space + DM), including the first long-press of a session, with the
keyboard down — and the keyboard lift still works.

## Symptom

Opening any bottom-sheet modal over a Space or DM chat (user-profile sheet, long-press
message action sheet, Invite, Space Settings, conversation settings, cast-thread) made
the `MessagesList` FlashList **scroll to the top (first message, y=0)** — a visible flash
on open and/or close. Keyboard up or down. App-wide across every chat modal.

## Root cause (confirmed on-device)

It is a REGRESSION introduced by PR #119 (`f7f5a1d`, "chat messages rise with the
keyboard"), which made the chat list scroll through **`KeyboardChatScrollView`** from
`react-native-keyboard-controller` (v1.21.11), wired via `renderScrollComponent`.

A native Android `<Modal>` (a Dialog window) grabs/releases input focus on
mount/unmount, which makes the OS emit a **keyboard-geometry event with NO focused
TextInput**. `KeyboardChatScrollView`'s keyboard worklet treats it as a keyboard change
and `scrollTo`s the list — with `height=0` and stale capture state, the target collapses
to ~0, so the list jumps to the top. It happens on the UI thread with no React re-render
(which is why early JS-level instrumentation saw nothing and mis-blamed FlashList).

**The discriminator:** every keyboard event carries `target` = the focused TextInput's
view tag. A REAL composer lift/dismiss has `target > 0` (confirmed on-device:
`target=10562`). A modal-induced spurious event has `target <= 0` (`target=-1`). That is
a clean, deterministic signal — no heuristics.

## The fix

`patches/react-native-keyboard-controller+1.21.11.patch` — a one-hunk patch adding a
single guard to the lib's `onMove` worklet (the one that does the `scrollTo`):

```
// src/components/KeyboardChatScrollView/useChatKeyboard/index.ts, onMove
if (freeze.value || e.target <= 0) {   // was: if (freeze.value)
  return;
}
```

So the scrolling worklet ignores any focus-less (modal-induced) keyboard event. The list
can no longer be scrolled by a modal; a real keyboard event (`target > 0`) is unaffected.

**Why `onMove` ONLY (not `onStart`/`onEnd`):** the `scrollTo` lives in `onMove`.
`onStart`/`onEnd` only do bookkeeping (set `padding`, capture `offsetBeforeScroll`). An
earlier broader version guarded all three and broke nothing visible for the jump but is
unnecessary — and gating `onStart`/`onEnd` leaves `padding` stale, which the cold-open
emoji-panel lift's math reads. Guarding only `onMove` fixes the jump and leaves all
bookkeeping coherent.

**Why a patch, not app code:** the only race-free place to gate the scroll is inside the
lib's own scrolling worklet. An app-level `useKeyboardHandler` was tried but races the
lib's handler for the same event — the FIRST modal open of a session occasionally still
jumped. The patch has no such race (single worklet, no second handler). Also,
per-modal/BaseModal-level freezing was tried and FAILED: `MessageActionSheet` and other
sheets use their OWN raw `<Modal>`, not `BaseModal`, so any per-modal gate misses paths.
The keyboard-event guard is modal-agnostic and covers every sheet.

`patch-package` is already this repo's convention (2 pre-existing patches incl. a large
native webview one); it re-applies on `postinstall` and fails loudly on a version bump.

## Theories tested on-device and FALSIFIED (do not revisit)

- **FlashList v2 `maintainVisibleContentPosition` re-anchor** (the original bug-report
  theory): set `maintainVisibleContentPosition={{ disabled: true }}` → STILL jumped. Not
  FlashList.
- **Native `contentInset` from `blankSpace`:** set `blankSpace=0` → STILL jumped. Not the
  inset value.
- **Isolation proof:** removing `renderScrollComponent` (FlashList's default ScrollView,
  the `bd267e2` setup) → jump GONE. So `KeyboardChatScrollView` is the cause.
- **Per-modal freeze via BaseModal:** only fixed the one path that routes through
  BaseModal with the right timing; everything else (long-press, settings, all DM modals)
  still jumped, because raw `<Modal>`s bypass BaseModal.

## Verify / re-test

Changes to the patched lib need a Metro cache reset, not just a reload (it's a
`node_modules` change): `.\.agents\scripts\dev-start-mobile-wifi.ps1 -ResetCache`.

Acceptance (all PASSED on-device 2026-06-22, Android, keyboard down):
- Space chat: long-press message, pfp tap, gear→Settings, Invite → no jump (incl. first
  long-press of a session).
- DMs: pfp tap, long-press, conversation settings → no jump.
- Keyboard open/dismiss still lifts/settles the list correctly.

## Out of scope (pre-existing, NOT caused by this fix)

The **cold-open emoji panel lift** (tap the emoji icon from rest, no keyboard → the list
should scroll up to clear the panel) does not lift much. Confirmed pre-existing: it still
behaves identically with the patch REMOVED (A/B'd on-device 2026-06-22). The composer doc
(`.agents/docs/composer-keyboard-emoji-panel.md`, "DO lift on a cold open", lines 263-270)
already documents this as a known small lag driven by a single deferred extra-padding
scroll correction, and notes a per-frame follower "gave NO improvement — do not re-add."
Track separately if it needs improving; it is unrelated to the modal-jump fix.

## Files
- `patches/react-native-keyboard-controller+1.21.11.patch` — THE FIX (committed, tracked).
- No app-code changes. The two pre-existing memoisations from `0560358`
  (`useFarcasterChannel` casts memo, `MessagesList` MVCP/style prop memo) are genuine
  hardening but do NOT fix this bug.

*Solved 2026-06-22 — patch-package guard on KeyboardChatScrollView's onMove worklet
(`e.target <= 0`). FlashList-MVCP, native-inset, and per-modal-freeze theories all
falsified on-device first.*
