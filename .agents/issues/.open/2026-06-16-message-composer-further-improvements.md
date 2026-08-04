---
type: task
title: "Message composer — further improvements"
status: open
created: 2026-06-16
---

# Message composer — further improvements

**Status:** open / backlog — items 1 & 2 closed 2026-06-20 (dev-only glitches, confirmed fine in production); only #3 (iOS verification) and #4 (parked nice-to-haves) remain
**Priority:** low (polish; the composer is shipped and works on Android)
**Context:** follow-ups left after the unified composer landed (see `.done/2026-06-16-unified-message-composer.md` for the build, and `<local tutorials folder>/` for the reusable guide). All items below are polish, not blockers.

---

## 1. Smooth growth animation (1 <-> 2+ lines) — CLOSED (won't-do)

**Verified in a real production build (2026-06-20):** the pill does grow instantly, but it's very quick — far less jarring than the dev build suggested. The remaining gap vs reference messengers is barely perceptible.

Decision: **not worth it.** The only safe technique (explicit animated pill height, below) is fiddly, and the obvious one (`Reanimated.LinearTransition`) is a documented landmine that made the icons worse (commit `1783f69`). Worse, animating pill height is exactly the kind of render/height-timing change that risks reopening the structural composer/keyboard/emoji-panel swap glitch (on-screen position has three uncoordinated owners — see `.agents/docs/features/composer-keyboard-emoji-panel.md`). High regression risk to fix something barely visible in prod.

_Original notes retained below in case it's ever revisited._

The pill currently grows/shrinks **instantly** when the text wraps. Acceptable but not as smooth as reference messengers.

**Do NOT use `Reanimated.LinearTransition` on the pill** — it was tried and removed (commit `1783f69`). It races the native content-driven height change: when the `TextInput` grows a line, the pill height jumps natively while `LinearTransition` animates over ~140ms, and during the animation the bottom-pinned emoji + send icons get laid out at the mid-animation height and are shoved below the pill for a frame, then snap back. Every line change. It made the icons worse than no animation.

**Correct technique if revisited** — drive an explicit animated height:
1. Measure content height via `onContentSizeChange` (already wired: `handleContentSizeChange`).
2. Feed the target into a `useSharedValue`, animate with `withTiming(target, { duration: ~120 })`.
3. Apply the animated height to the pill (or inner wrapper) via `useAnimatedStyle`; the `TextInput` fills it. You own the height value, so it only ever moves along the animated curve — the bottom-pinned buttons never see a transient height.
4. Clamp between one-line and `maxHeight` (120).
5. Keep `textAlignVertical: 'center'` fixed (flipping it is unreliable on Android). Keep `isMultiline` purely cosmetic (radius only). Never reintroduce an `alignItems` flip on the pill (original icon-jump cause).
6. Verify on Android first (the glitch was Android), then iOS.

## 2. Emoji panel open lag — CLOSED (resolved by measurement)

**Verified in a real production build (2026-06-20):** the open hitch is a dev-environment artifact. In production the panel opens cleanly. This item was explicitly gated on "measure in a release build before optimizing" — that measurement is now done and came back clean, so the virtualization work (`ScrollView` -> `FlashList`) is **not needed**. Re-open only if a future build regresses it.

_Original notes retained below._

Tapping the emoji toggle has a perceptible open hitch on the Android dev build.

- Partly **dev-mode overhead** (shrinks a lot in release) — **measure in a release build before optimizing**.
- Partly **real**: the emoji grid uses a non-virtualized `ScrollView` that mounts ~120 nodes (selected category) synchronously on first open. **Pre-existing** — predates this branch (verified on master); the composer rework only moved the grid into the downward panel.
- If still noticeable in release: virtualize the grid (`ScrollView` -> `FlashList`, already a dep). Watch the fiddly cases: category switching resetting scroll, the search-results section (Custom/Stickers/Emoji together), custom-emoji `<Image>` rows, sticker rows at a different column count. Keep the existing `emojiPanelContent` memoization.
- The paperclip/attach delay is **not a bug** — it's the native OS image picker launching. Leave it.

## 3. iOS verification (untested)

The composer has only been tested on **Android**. iOS was hardened defensively but never run. Full checklist lives in `.done/2026-06-16-unified-message-composer.md` ("iOS verification checklist"). Key risks: the `keyboardHeight - tabBarHeight` geometry (pill must sit exactly on the keyboard), single-line vertical centering (`includeFontPadding` is Android-only), caret-keeping + keyboard restore. If anything's off, it's almost certainly a small numeric tweak in `hooks/useComposerPanel.ts`'s spacer, not structural.

## 4. Nice-to-haves (not yet requested, parked)

- Sticker panel wiring (the panel supports stickers but the composer toggle only opens emoji).
- Top breathing room in the multi-line box (currently a tight 4px to the pill top via the uniform padding) — add a touch more if it reads cramped vs reference.

*Last updated: 2026-06-20*
