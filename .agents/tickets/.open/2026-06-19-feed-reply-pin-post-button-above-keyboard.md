---
type: task
title: "Feed reply: pin the Post button above the keyboard (definitive fix)"
status: open
created: 2026-06-19
---

# Feed reply: pin the Post button above the keyboard (definitive fix)

**Status:** todo — a working stopgap is shipped; this task is the solid replacement.
**Branch context:** part of the `feat/nav-bar-redesign` work (floating tab bar / edge-to-edge). See `.agents/docs/2026-06-18-floating-tab-bar-and-edge-to-edge-redesign.md`.

## Problem

In the Farcaster feed thread reply editor (`ThreadDetailView` in `components/SocialFeedModal.tsx`), when the user types a **multi-line** reply, the input grows and eventually pushes the editor footer (image button, char count, **Post** button) down BEHIND the keyboard. The caret stays visible (keyboard avoidance works), but the Post button can scroll off.

Ideal UX (user's words): *"what I always see is the last line I'm typing, but ALSO the Post button."*

## Current stopgap (shipped, good enough for now)

The thread view was ported from the fragile `KeyboardAvoidingView` to `react-native-keyboard-controller`'s `KeyboardAwareScrollView` (cross-platform-correct, same library the chat composer uses). Then `bottomOffset={Skin.space(64)}` was set so the aware-scroll-view keeps ~the footer-row height of space below the focused input visible — so for typical 1–4 line replies the Post button stays in view. **Long replies can still push it off; the user scrolls a hair.** Also, the scroll `contentContainerStyle.paddingBottom` collapses from `16 + bottomInset` to `16` when `isEditorFocused` (keyboard covers the tab-bar zone, so the tab-bar clearance would be dead space).

This is acceptable but not definitive — `bottomOffset: 64` is a heuristic tuned to the current footer height; if the footer grows (e.g. an error row, the "also reply" checkbox, image previews) the Post button goes off-screen again.

## Definitive solution: sticky footer

Pin the editor footer (image button · char count · Post) to the top of the keyboard with `react-native-keyboard-controller`'s **`KeyboardStickyView`**, so it's ALWAYS visible regardless of reply length. The message content (parent casts, the input) scrolls in the `KeyboardAwareScrollView`; the footer rides the keyboard.

### Why it's non-trivial (the cost this task is buying down)

- The footer row currently lives DEEP in the editor card: inside the `marginLeft: 56` text container, inside the editor `<View>` (border/padding card), as the last child of the scroll content (`components/SocialFeedModal.tsx`, the "Bottom row: photo button, post button, character count" block, ~line 3222 at time of writing).
- To stick it, the footer must be RE-PARENTED out of the scroll content to the screen level, wrapped in `KeyboardStickyView`. That visually detaches it from the editor card — it becomes a separate bar above the keyboard. Need to decide the styling so it doesn't look disjointed (e.g. give the sticky bar the same surface + a top border, like the chat composer's pill bar).
- State the footer needs stays in `ThreadDetailView`: `replyText`, `replyImages`, `canReply`, `isPosting`, `handlePickReplyImage`, `handleSubmitReply`, `maxCastLength`, `regularCastByteLimit`. All already in that component's scope, so no prop threading — just move the JSX.
- The char count + image previews: decide whether previews stay in the scroll (above) and only the action row sticks, or the whole footer sticks. Likely: image previews scroll with content, the compact action row (photo · count · Post) sticks.
- When the keyboard is CLOSED, `KeyboardStickyView` should rest the footer at its normal in-card position (or hide the sticky bar and show the in-card footer). Verify the closed state doesn't double-render the footer.

### Acceptance

- Typing any length of reply: the current line AND the Post button are both visible above the keyboard.
- Works on Android AND iOS (the whole reason we're on keyboard-controller — verify both; iOS was untested in the original session).
- Resting (no keyboard): footer sits normally; reply editor clears the floating tab bar.
- The reply FAB (jump-to-editor) still behaves.

### References

- Working pattern to mirror: the chat composer (`components/Chat/MessageInput.tsx` + `hooks/useComposerPanel.ts`) already does keyboard-pinned composer UI with this library — but it uses the animated-spacer approach, which is heavier than needed here. `KeyboardStickyView` is the lighter, right-sized primitive for "pin this bar to the keyboard."
- `react-native-keyboard-controller` exports: `KeyboardAwareScrollView`, `KeyboardStickyView`, `KeyboardAvoidingView`, `KeyboardToolbar`. `KeyboardToolbar` may even be a near-drop-in if the footer maps to a toolbar shape — evaluate it first, it could make this trivial.
- `KeyboardProvider` is already mounted at the app root (`app/_layout.tsx`).

---
*Last updated: 2026-06-19*
