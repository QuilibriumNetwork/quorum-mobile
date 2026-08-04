---
type: task
title: "Emoji panel open lag — virtualize the grid"
status: done
created: 2026-06-16
---

# Emoji panel open lag — virtualize the grid

**Status:** deferred / not started
**Priority:** low (polish; not blocking)
**Origin:** noticed while building the unified composer ([2026-06-16-unified-message-composer.md](2026-06-16-unified-message-composer.md)). Kept OUT of that branch on purpose — separate concern, separate risk profile.

## Symptom

Tapping the emoji toggle takes a perceptible moment (a frame or two of hitch) before the panel appears, on the Android dev build.

## Diagnosis (already done — don't re-investigate)

The lag has two parts:

1. **Dev-mode overhead** — the dev build is unoptimized (dev-mode React, no minification, Reanimated strict logger). This portion shrinks substantially in a release build. **Measure in a release build before assuming the lag is real.**
2. **A real cost** — the emoji grid renders inside a plain **non-virtualized `ScrollView`** ([components/Chat/MessageInput.tsx](../../components/Chat/MessageInput.tsx), `styles.emojiGrid`). The selected category mounts ALL its nodes synchronously on first open. Worst case is the "smileys" category at ~120 `TouchableOpacity`+`Text` nodes (total emoji across categories ~623, but only the selected category renders at a time). Mounting ~120 nodes in one frame blocks the JS thread briefly.

**This is pre-existing, NOT introduced by the composer branch** — verified: `git show master:components/Chat/MessageInput.tsx` already uses `ScrollView` for the grid. The composer rework only moved the grid into the downward panel; it didn't change its virtualization.

The paperclip/attach button's delay is unrelated and NOT a bug — it's the native OS image picker (`pickImage('library')`) launching the system gallery. Same in production. Leave it.

## Plan (only if release-build lag is still noticeable)

1. **Measure first.** Build a release APK, open the emoji panel, judge the lag. If acceptable, close this task — no code change.
2. If still noticeable, **virtualize the grid**: swap the emoji `ScrollView` for `FlashList` (already a dependency — `@shopify/flash-list`) or `FlatList`, so only visible rows mount.
   - Emoji are fixed-size cells → a known `estimatedItemSize` / grid via `numColumns` makes this clean.
   - Watch the edge cases that make this fiddly (the reason it's its own task): category switching resetting scroll, the search-results path (which renders Custom / Stickers / Emoji sections together), custom-emoji `<Image>` rows, and sticker rows at a different column count.
   - Keep the existing memoization (`emojiPanelContent` is already `useMemo`'d and gated on `showEmojiPicker`).
3. Verify open feels instant on a low-end Android device and on iOS.

## Watch-outs

- `FlashList` inside an animated, height-constrained container (the keyboard spacer) needs a concrete height — it gets one from the spacer, but verify it doesn't collapse to 0 on first mount.
- Don't regress the search view, custom emoji, or sticker grids — they share the same scroll container today.

*Last updated: 2026-06-16*
