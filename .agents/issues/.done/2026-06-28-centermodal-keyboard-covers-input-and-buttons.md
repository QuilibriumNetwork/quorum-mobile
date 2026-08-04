---
type: bug
title: "CenterModal: keyboard covers the input field AND footer buttons on small screens"
status: done
severity: medium
created: 2026-06-28
found-on: Samsung Galaxy A40 (SM-A405FN, Android 11, ~320dp width)
component: components/shared/CenterModal.tsx
affects: TypeToConfirmModal (and any future CenterModal with a text input)
related: not caused by the button-consistency sweep — pre-existing; surfaced during Wave 2 testing
---

# CenterModal keyboard overlap

## Symptom
On a small device (Galaxy A40), opening a center-anchored confirmation modal that contains a
text input — e.g. **TypeToConfirmModal** ("type `reset` to confirm" for Reset App Data / Delete
Space) — and tapping the input raises the keyboard, which **slides up over the bottom half of the
modal**, hiding BOTH the input field and the Cancel/Confirm buttons. The user can't see what they're
typing or reach the buttons. (Screenshot: 2026-06-28, A40 USB session.)

## Root cause
`components/shared/CenterModal.tsx` centers its card with `justifyContent: 'center'` inside a plain
`<View>` and has **no keyboard avoidance** (`KeyboardAvoidingView` / keyboard-aware repositioning).
The card is pinned to the vertical center of the screen; the soft keyboard is drawn on top of it.

`TypeToConfirmModal` *does* wrap its own content in a `KeyboardAvoidingView`, but that's **nested
inside** CenterModal's already-centered, non-avoiding container, so it has nothing to push against —
the outer container doesn't move, so the inner avoid does nothing useful. The fix must live in
CenterModal (the shell), not the consumer.

On a tall phone (Motorola Edge 50) the keyboard is short relative to the screen, so the centered card
clears it and the bug is invisible — this is a **small-screen-only** manifestation. The A40
(~320dp / short height) is the reference device that exposes it (see
[[test-devices-samsung-a40-old-motorola-edge50]]).

## Fix options
1. **Wrap CenterModal's container in `KeyboardAvoidingView`** (`behavior="padding"` iOS /
   `"height"` or a translate on Android) so the centered card lifts above the keyboard. Simplest;
   keep `justifyContent: center` but let the avoiding view shrink the available height. Verify the
   card doesn't get clipped at the top on the smallest screens (it may need to switch to top-ish
   alignment when the keyboard is up).
2. **Keyboard-aware vertical shift**: subscribe to keyboard height (e.g.
   `useReanimatedKeyboardAnimation` from react-native-keyboard-controller, already a dep — see
   [[keyboardaware-scrollview-offset-no-scroll-bug]]) and translate the card up by enough to clear
   the keyboard. More control, more code.
3. **Make the card scrollable when space is tight** (ScrollView inside the card) so at minimum the
   input + buttons can scroll into view above the keyboard.

Recommend **option 1 first** (smallest change in the shared shell, fixes every CenterModal consumer
at once); fall back to option 2 if padding-avoidance clips the card on the A40.

## Acceptance
- On the A40, open Reset App Data → tap the "reset" input → keyboard appears → **the input field and
  both footer buttons remain visible and reachable** above the keyboard.
- No regression on tall devices (Edge 50): the dialog still centers normally when no keyboard is up.
- Backdrop-tap / hardware-back still cancel (CenterModal's safety invariant preserved).

## Notes
- Distinct from the button-consistency work (`style/canonical-button-adoption`). That sweep only
  changed footer button rendering; this is a CenterModal layout/keyboard issue that predates it.
- Also seen alongside a cosmetic small-screen wrap: long button labels (e.g. "Reset App Data") wrap
  to two lines at `size="lg"` on 320dp. **FIXED 2026-06-28** (user-approved): shortened the Reset App
  Data `confirmLabel` from "Reset App Data" → "Reset" in ProfileModal.tsx (both the route-mode and
  modal-mode instances). The title still reads "Reset App Data", so context is preserved. A broader
  defensive fix (`numberOfLines={1}` / shrink-to-fit on the canonical Button) is still worth doing so
  no future long label can wrap on small screens — not done yet.

---

*Last updated: 2026-06-28*
