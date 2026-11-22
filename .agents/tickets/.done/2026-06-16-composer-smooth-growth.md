---
type: task
title: "Composer smooth growth (deferred polish)"
status: done
created: 2026-06-16
---

# Composer smooth growth (deferred polish)

**Status:** deferred / not started
**Priority:** low (polish; current behavior is acceptable, just instant not animated)
**Origin:** unified composer ([2026-06-16-unified-message-composer.md](2026-06-16-unified-message-composer.md)). The pill currently grows/shrinks **instantly** when the text wraps. Acceptable but not as smooth as Telegram.

## What was tried and why it was removed (don't repeat)

`Reanimated.LinearTransition` on the pill `Reanimated.View` (commit reverted). It **races the native content-driven height change**: when the `TextInput` grows a line, the pill height jumps natively while `LinearTransition` animates over ~140ms. During the animation the bottom-pinned emoji + send icons were laid out at the mid-animation height and **shoved below the pill for a frame, then snapped back** — every single line change. Non-deterministic centering also appeared because the `isMultiline` React state flip (radius + at the time `textAlignVertical`) landed on a different frame than the height change.

Net: `LinearTransition` made the icons worse than no animation. Removed in commit `1783f69`. Current stable behavior: instant growth, no glitch, controls bottom-pinned in both states, `textAlignVertical` always `center`, `isMultiline` only swaps corner radius.

## If revisited — the correct technique

Don't use `LinearTransition` for content-driven height. Instead drive an **explicit animated height**:

1. Measure the input's content height via `onContentSizeChange` (already wired — see `handleContentSizeChange`).
2. Feed that target height into a Reanimated `useSharedValue` and animate it with `withTiming(target, { duration: ~120 })`.
3. Apply the animated height to the pill (or an inner wrapper) via `useAnimatedStyle`, and set the `TextInput` to fill it. The key difference: YOU own the height value and animate it deterministically, so the buttons (bottom-pinned) never see a transient height they didn't expect — the height only ever moves along the animated curve.
4. Clamp the animated height between one-line and `maxHeight` (120) to match current behavior.
5. Verify on Android specifically — the icon push-out was Android; confirm no regression there before iOS.

Watch-outs: keep `textAlignVertical: 'center'` fixed (flipping it is unreliable on Android). Keep `isMultiline` purely cosmetic (radius). Don't reintroduce an `alignItems` flip on the pill (that was the original icon-jump cause).

*Last updated: 2026-06-16*
