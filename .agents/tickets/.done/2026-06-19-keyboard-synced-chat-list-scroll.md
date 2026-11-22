---
type: task
title: "Keyboard-synced chat list scroll (KeyboardChatScrollView)"
status: done
created: 2026-06-19
---

# Keyboard-synced chat list scroll (KeyboardChatScrollView)

**Status:** planned, NOT started. Own branch off `master` after `fix/farcaster-dm-composer-bottom-fade` merges.
**Date:** 2026-06-19

## The problem

When the soft keyboard opens on a chat screen (DM, Space channel, Farcaster DM),
the message list does NOT rise with the keyboard. The composer pill floats up
(its own animated spacer handles that), but the list content stays put, so the
newest messages end up hidden behind the keyboard. The user must scroll manually,
and even then the list's scrollable range is wrong because the screen isn't
resized for the keyboard (the composer floats over it via the spacer; the native
window does not `adjustResize` the list in practice under edge-to-edge).

Desired behaviour: messages rise WITH the keyboard, as one smooth motion (the
keyboard's own animation curve), in BOTH directions (open and close). Telegram /
WhatsApp behaviour.

## Why the hand-rolled attempts failed (this session)

Tried, in order, all reverted:
1. Add keyboard height (RN `Keyboard.endCoordinates`) to the list `paddingBottom`
   → over-padded by ~tabBarHeight (RN height ≠ keyboard-controller height; two
   sources disagreed) AND clipped because of the mismatch.
2. `max(bottomInset, keyboard + composerConst)` with a guessed 60px composer
   height → wrong for multi-line / image / reply-banner composers.
3. Measured composer footprint via `onLayout` + a `composerSpacerStore` published
   per animation frame via `useAnimatedReaction` → **9-second lag**: re-rendered
   the heavy `MessagesList` 60×/sec, starving the JS thread.
4. Settle-only publish (publish spacer once on keyboard `onEnd`) → fixed the
   storm but the scroll happened AFTER the keyboard settled → 1–2s perceived lag
   and a "jump" instead of a smooth scroll (single discrete `scrollToEnd` after
   the fact, not riding the keyboard curve).

Root lesson (already in `.agents/docs/composer-keyboard-emoji-panel.md`):
keyboard-racing position/visibility MUST be UI-thread, never React state. Every
React-state-driven attempt either lagged or stormed.

## The right solution (researched 2026-06-19)

`react-native-keyboard-controller` (already installed, **v1.21.11**) ships
**`KeyboardChatScrollView`** (added v1.21) — purpose-built for this. Smooth
60/120fps keyboard-synced content lifting, interactive dismissal, identical on
iOS and Android by design (the library's whole premise).

Docs: https://kirillzyusko.github.io/react-native-keyboard-controller/docs/api/components/keyboard-chat-scroll-view
Blog (v1.21): https://kirillzyusko.github.io/react-native-keyboard-controller/blog/chat-scroll-view

### Behaviour modes (`keyboardLiftBehavior` prop)
- `"always"` (default) — bottom messages always lift with the keyboard. **Telegram/WhatsApp. This is what we want.**
- `"whenAtEnd"` — lifts only when scrolled to the end (ChatGPT).
- `"persistent"` — lifts, doesn't drop on hide (Claude).
- `"never"` — keyboard overlays, no movement (Perplexity).

### FlashList integration (via `renderScrollComponent`)
```tsx
import { forwardRef } from "react";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import type { ScrollViewProps } from "react-native";

const ChatScrollWrapper = forwardRef<any, ScrollViewProps>((props, ref) => (
  <KeyboardChatScrollView
    ref={ref}
    automaticallyAdjustContentInsets={false}
    contentInsetAdjustmentBehavior="never"
    keyboardLiftBehavior="always"
    {...props}
  />
));

<FlashList renderScrollComponent={ChatScrollWrapper} ... />
```
- Do NOT wrap FlashList in KeyboardAwareScrollView/KeyboardAvoidingView (nesting scroll solutions = conflicts). `renderScrollComponent` is the supported path.

### Useful props
- `extraContentPadding` (Reanimated `SharedValue`) — padding from NON-keyboard
  elements, e.g. the expanding multi-line composer. This is where our measured
  composer footprint goes (consumed UI-thread, NOT via React re-render — fixes
  the storm by design).
- `offset` — subtract a distance when the input isn't at the very bottom.
- `blankSpace` (`SharedValue`) — minimum inset floor the keyboard "absorbs" into
  rather than adding to (candidate for the resting tab-bar clearance).

## Risks / caveats to handle (from docs)
- **iOS RN 0.81+** `contentInset` hit-test bug → may need
  `applyWorkaroundForContentInsetHitTestBug={true}` (uses runtime method
  swizzling — "inherently fragile"). Verify whether our RN version is affected.
- **New Architecture:** state updates before keyboard events can skip animations
  → `DISABLE_COMMIT_PAUSING_MECHANISM` flag. Check if we're on New Arch.
- **Android Reanimated < 4.3.0:** needs `USE_COMMIT_HOOK_ONLY_FOR_REACT_COMMITS`
  flag. Check our Reanimated version.
- **`scrollToEnd()` miscalculates with an open keyboard** — use the underlying
  scroll component's method instead. DIRECTLY affects our own-message send scroll
  (the `scrollToEnd` in MessagesList) and `scrollToMessage`.
- Inverted lists want a larger `drawDistance` to avoid flash during animation.
  (Our list is NOT inverted — uses `startRenderingFromBottom` — so re-confirm
  interaction with `maintainVisibleContentPosition`.)
- **Choreography risk:** this swaps the scroll mechanism UNDER the composer ↔
  keyboard ↔ emoji-panel choreography that the doc calls structurally fragile.
  The emoji panel opens in the keyboard footprint via the composer's own spacer;
  confirm KeyboardChatScrollView's lifting doesn't double-count or fight the
  panel-open state. Test the full transition matrix from
  `.agents/docs/composer-keyboard-emoji-panel.md`.

## Already shipped (do NOT redo — on branch fix/farcaster-dm-composer-bottom-fade)
- Farcaster DM floating composer + bottom-fade (ChatBottomChrome) — `bc19a74`.
- Gradient stops at composer top, smooth dissolve below — `bc19a74`.
- Removed dead `DirectMessageView` — `bc19a74`.
- Always-scroll-to-own-message-on-send + `currentUserId` wiring — `7ddf37a`.
  NOTE: that `scrollToEnd` is the one the docs warn miscalculates with an open
  keyboard — revisit it when adopting KeyboardChatScrollView (use the underlying
  scroll ref's method).

## Test matrix (both platforms; user can only test Android — iOS needs care)
- Focus composer (at bottom) → messages rise WITH keyboard, smooth, no lag/jump.
- Scrolled-up + focus composer → NOT yanked to bottom (with `always`, content
  lifts but position is preserved — confirm this is the case, vs `whenAtEnd`).
- Send (keyboard open) → own message visible above composer.
- Multi-line composer, image attachment, reply banner → list clears the taller
  composer (`extraContentPadding`).
- Emoji panel open/close, panel↔keyboard hand-off → no fight with the lift.
- Close keyboard → content drops back smoothly.

*Last updated: 2026-06-19*
