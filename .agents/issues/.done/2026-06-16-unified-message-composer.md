---
type: task
title: "Unified message composer"
status: done
created: 2026-06-16
---

# Unified message composer

**Branch:** `feat/unified-message-composer`
**Status:** Android-verified and polished; library upgraded to 1.21.11; iOS NOT yet tested — hardened defensively, checklist below.

## iOS verification checklist (Android works; iPhone untested)

The implementation was made cross-device-robust by construction (self-sizing pill via `alignItems:center` + no fixed height; keyboard avoidance via `react-native-keyboard-controller`'s normalized height; `keepFocus`/`setFocusTo` confirmed implemented in the lib's iOS native source). The known iOS-risk spots were reviewed and are either already clamped or platform-agnostic. Still, verify on a real iPhone (notch + home-indicator device, e.g. 14/15, AND a no-notch/SE):

- [ ] **Composer rides exactly on top of the keyboard** when the input is focused — not floating above it (over-subtracting tab bar) nor hidden behind it (under-subtracting). This is the #1 iOS risk: the `keyboardHeight - tabBarHeight` geometry in `useComposerPanel` spacer. If the pill floats too high on iOS, the tab-bar subtraction is too large; if it's covered, too small.
- [ ] **Single-line text is vertically centered** in the pill (the `includeFontPadding:false` fix is Android-only; iOS relies on flex centering — confirm no top/bottom drift).
- [ ] **Caret stays visible** when the emoji panel opens (`dismiss({keepFocus:true})`), and the keyboard returns on close (`setFocusTo('current')`) — both are iOS-native in the lib, but confirm the caret actually shows.
- [ ] **No drop-and-bounce** of the pill when closing the panel via the keyboard icon (close hand-off is timing-independent, should hold on iOS's slower keyboard curve).
- [ ] **Bottom gap** below the pill is the same small amount with and without the keyboard, and clears the home indicator.
- [ ] **Pill ends are perfect semicircles** (borderRadius:999 — device-agnostic, but confirm).
- [ ] Repeat in a DM and a Farcaster DM (different `bottomInset` plumbing).

If any spacing is off on iOS, it's almost certainly a small numeric tweak in `useComposerPanel`'s spacer (tab-bar term) or the input style — not a structural problem.

## Progress (2026-06-16)

- ✅ `react-native-keyboard-controller@1.18.5` installed, `KeyboardProvider` at app root.
- ✅ `hooks/useComposerPanel.ts` owns keyboard↔panel choreography (animated spacer; resting safe-area inset fades via keyboard progress).
- ✅ `MessageInput.tsx` rebuilt: single pill (left buttons + input + circular send), `+` hides while composing, emoji panel renders in the downward spacer at measured keyboard height.
- ✅ All 4 parents dropped `KeyboardAvoidingView` + manual `androidKeyboardHeight`.
- ✅ `npx tsc --noEmit`: all touched files clean (23 remaining errors are pre-existing, unrelated files).
- ✅ `eslint` on touched files: 0 errors (only pre-existing unused-import warnings).
- ✅ Committed: `feat: unified pill composer with downward-opening emoji panel`.
- ⏳ **Native rebuild required** (keyboard-controller ships native code) before the swap can run on device. Then verify per checklist below.

## Goal

Rework the chat message composer into a single pill-shaped container with a downward-opening emoji panel:

1. **Unified pill container** — the input text area, the left-side buttons (emoji + attach), and the circular send button all live inside ONE pill-shaped container. Today the pill is only the `TextInput`; the buttons float outside it ([MessageInput.tsx:754-855](../../components/Chat/MessageInput.tsx)).
2. **Circular send button** pinned to the right edge of the pill (already circular, just needs to live inside the pill).
3. **Left side of pill:** emoji-panel toggle + a `+` button that opens the attach-image flow.
4. **Emoji panel opens DOWNWARD, replacing the keyboard** — not floating above the input as it does now. Tapping the emoji button dismisses the soft keyboard and reveals the panel occupying the keyboard's footprint; tapping it again (or focusing the input) brings the keyboard back. No layout jump/flicker during the swap.
5. **Hide the `+` (attach) button while the user is typing** (non-empty input); keep the emoji button. When the input is empty again, `+` reappears.

Stickers: not wired into the composer today — out of scope, emoji panel only.

## Decisions (confirmed with user 2026-06-16)

- **Build vs buy:** ADD `react-native-keyboard-controller` for the keyboard↔panel choreography. The pill + emoji-grid UI stays fully in-house. Rationale: the "panel occupies keyboard space, no flicker" swap is the hardest part of mobile chat UIs; this lib is the New-Arch-native standard (project is `newArchEnabled=true`, RN 0.81, Reanimated 4.1, Expo 54). Lets us delete the manual `androidKeyboardHeight` tracking in the parents.
- **Typing state:** hide `+` only, keep emoji.
- **Rollout:** all 4 screens that consume `MessageInput`.
- **Naming:** do NOT reference any third-party app anywhere (branch, commits, PR, code comments). Generic descriptions only.

## Affected files

- `package.json` — add `react-native-keyboard-controller` (done, 1.18.5).
- `app/_layout.tsx` — wrap app in `<KeyboardProvider>` (done).
- `hooks/useComposerPanel.ts` — new hook owning the keyboard↔panel height/state choreography (done).
- `components/Chat/MessageInput.tsx` — the bulk: unified pill, downward panel, typing-state button visibility, panel height = measured keyboard height.
- Parent screens (remove now-redundant `KeyboardAvoidingView` + manual `androidKeyboardHeight`, replaced by composer self-avoidance):
  - `components/Chat/SpaceChatArea.tsx`
  - `components/Chat/DMChatArea.tsx`
  - `components/Chat/DirectMessageView.tsx`
  - `components/Chat/FarcasterDirectMessageView.tsx`

## Approach

### Keyboard choreography (the hard part) — `useComposerPanel`

Use `react-native-keyboard-controller`:

- `KeyboardProvider` at root.
- `useReanimatedKeyboardAnimation()` gives a Reanimated `height` SharedValue tracking the live keyboard.
- `useKeyboardHandler` latches the last real keyboard height into a SharedValue (+ mirrored JS state for panel content layout).
- A single animated spacer `Reanimated.View` sits BELOW the pill. Its height:
  - panel closed → follows live keyboard height (this is the keyboard avoidance; pill rides up with the keyboard).
  - panel open → holds the stored keyboard height; the emoji grid renders inside it. So dismissing the keyboard and showing the panel happens in the same space → no jump.
- Swap: emoji tap → `setPanelOpen(true)` + `Keyboard.dismiss()`. Tap again / input focus → `setPanelOpen(false)` + refocus.
- Because the composer self-avoids, the parents drop their `KeyboardAvoidingView` + `androidKeyboardHeight` math.

### Pill layout

Single rounded container (`borderRadius` ~ half min height). Row: `[+] [emoji]` … growing `TextInput` … `[send]`. `+` conditionally rendered on `value.trim().length === 0`. Keep multiline auto-grow (maxHeight ~100). Send stays circular, inside the pill at the right.

### Emoji panel

Reuse the existing emoji grid / category / search markup. Only its container changes: instead of `marginBottom` above the pill with hardcoded `height:280`, it renders inside the animated spacer below the pill at the measured keyboard height.

## Risks / watch-outs

- Native rebuild required after install (keyboard-controller has native code). Use `.\.agents\scripts\build-app.ps1`.
- iOS vs Android keyboard-height + safe-area interplay — keyboard-controller normalizes this but verify on both.
- The 4 parents each have a slightly different KAV setup; verify each still positions correctly after the switch to composer self-avoidance.
- Don't regress: reply/edit/attachment previews, mention/channel autocomplete, draft persistence, send-on-return.

## Verification

- `npx tsc --noEmit` clean.
- On device/emulator: open a space channel — pill shape correct, send circular at right, `+`+emoji at left; type → `+` hides; tap emoji → keyboard slides out, panel slides in at same height, no jump; pick emoji → inserts; tap emoji/input → keyboard returns. Repeat in a DM.

*Last updated: 2026-06-16*
