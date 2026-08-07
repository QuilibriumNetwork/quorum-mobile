---
type: bug
title: "Farcaster re-import sheet: keyboard covers the whole sheet and cannot be dismissed"
status: in-progress
severity: high
created: 2026-06-12
updated: 2026-08-07
component: components/FarcasterReimportSheet.tsx
upstream: https://github.com/QuilibriumNetwork/quorum-mobile/issues/78
found-on: iPhone, TestFlight 1.1.0 build 55 (reporter); second reporter 2026-07-19
---

# Re-import sheet keyboard trap

## Status

Fix written on `fix/ios-reimport-sheet-keyboard-trap`, **not yet verified on a device.**
The geometry is READ (from RN and keyboard-controller native source, cited below), not
MEASURED. Android verification is now possible via a new dev panel — see "How to test".

## Symptom

From upstream #78: "When importing a key the Keyboard overlaps the input field and is not
dismissible. Meaning you can't close the keyboard by any means (drag down, tap outside or
pressing return does not dismiss it)." A second reporter on 2026-07-19: "I cannot import my
Farcaster wallet."

The screenshot attached to #78 shows the **feed tab's "Re-import needed" screen** with a
keyboard occupying the bottom half and no sheet visible at all. That is the tell: the sheet
had opened and was sitting entirely *behind* the keyboard.

## Which screen this actually is

Not the onboarding key import, and not the Account tab's "Connect Farcaster Account".
It is `components/FarcasterReimportSheet.tsx`, opened from the only place that mounts it,
`app/(tabs)/feed/index.tsx:174`, behind the `Re-import` button of the `token-missing` /
`no-credentials` state.

Both of the other import surfaces were checked and are fine:

- **Onboarding** (`app/(onboarding)/farcaster-setup.tsx`) sits in `OnboardingLayout`, which
  owns a `KeyboardStickyView` footer and a keyboard-height scroll spacer.
- **Account tab** (`components/ProfileModal.tsx:2419`) renders in route mode inside a plain
  screen with a `ScrollView` — a normal screen, so the platform handles it.

## Root cause

Four independent defects in one component, which is why *every* escape route failed:

1. **No keyboard avoidance.** The card is bottom-anchored (`justifyContent: 'flex-end'`)
   inside a raw `<Modal>`. An RN `<Modal>` is its own window, so nothing resizes it:
   - iOS presents it as a `UIViewController` and never resizes for the keyboard.
   - Android would normally `adjustResize`, but `KeyboardProvider` explicitly sets modal
     windows to `SOFT_INPUT_ADJUST_NOTHING` —
     `react-native-keyboard-controller/android/.../modal/ModalAttachedWatcher.kt:96`.

   So the short card sat wholly under the keyboard. **This reproduces on Android too**,
   which is what makes it testable here.
2. **Inert backdrop.** The backdrop was a plain `View` with no press handler, so
   "tap outside" did literally nothing.
3. **`multiline` with default submit behaviour.** A multiline `TextInput` inserts a newline
   on Return, so the keyboard had no dismiss key at all.
4. **No scroll container**, so "drag down" had nothing to act on.

`CenterModal` had the same class of bug and was fixed on 2026-06-28
([[2026-06-28-centermodal-keyboard-covers-input-and-buttons]]); this component was never
brought along. A sweep found it is the **only** raw `<Modal>` + `TextInput` in the app with
zero keyboard handling — every other one either uses `BaseModal` or handles it itself.

## The fix

`components/FarcasterReimportSheet.tsx`, following the `CenterModal` precedent (which used
`useReanimatedKeyboardAnimation` precisely because `KeyboardAvoidingView` is unreliable
inside a Modal on Android):

- Lift the card by the live keyboard height via `useReanimatedKeyboardAnimation`, adding
  back `insets.bottom` so the card's own safe-area padding (which the keyboard now covers)
  doesn't leave a dead gap.
- Cap the card's `maxHeight` to the space above the keyboard and put the content in a
  `ScrollView`, so a 24-word phrase plus an error line can't run off the top of a short
  screen.
- Backdrop is a `Pressable`: dismisses the keyboard while it's up, closes the sheet once
  it's down. Two-stage so a half-typed recovery phrase survives a stray tap.
- `keyboardShouldPersistTaps="handled"` so tapping the card's own padding drops the
  keyboard, and `keyboardDismissMode="on-drag"`.
- `submitBehavior="blurAndSubmit"` + `returnKeyType="done"` on the input, so Return
  dismisses instead of inserting a newline.

**Pasting is unaffected by the Return change.** Verified in RN's native source:
`RCTBackedTextInputDelegateAdapter.mm:254-267` only applies the blur when
`!textWasPasted`, so a pasted phrase containing newlines still goes in whole.

## How to test

The sheet has **no reachable entry point in a healthy build** — it only appears when the
profile claims a Farcaster account but the custody key is missing from SecureStore, and
nothing in the app produces that state (the one function that deletes the custody key,
`clearAllSecureStorage()`, also deletes the fid and the Quorum identity, landing you in
`no-account` instead). That unreachability is how it shipped broken.

So this branch adds `components/dev/FarcasterReimportPanel.tsx`, a `__DEV__`-gated opener
in the notifications tab (require()-gated, so it's provably absent from a release bundle).
It opens the real sheet; it does not simulate the broken keychain state, which is fine
because a `<Modal>` is its own window and what's behind it can't change its layout.

**Android pass/fail, in order:**

1. Notifications tab → "Farcaster re-import sheet" panel → **Open**. The sheet slides up.
2. Tap the text box. **PASS:** the input, Cancel and Import all stay visible above the
   keyboard. **FAIL:** anything is behind the keyboard.
3. Type gibberish (do NOT paste a real phrase — Import writes to SecureStore).
   Press **Return**. **PASS:** keyboard closes, no newline in the box.
4. Tap the text box again, then tap the dimmed area above the card. **PASS:** keyboard
   closes and the typed text is still there. Tap it again → the sheet closes.
5. Reopen, focus the input, tap **Import**. **PASS:** the error "Recovery phrase must be 12
   or 24 words." is readable, not behind the keyboard.

**Control arm:** before pulling this branch, do step 1-2 on master. It should FAIL there.
If it passes on master, the instrument is measuring the wrong thing, not the code.

## iOS

Same fix, unverified. Added as an item to
[ios-verification-checklist.md](../docs/ios-verification-checklist.md).

---

*Last updated: 2026-08-07*
