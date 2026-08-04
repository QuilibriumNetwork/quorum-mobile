---
type: bug
title: "Newest message hides under the composer in a short chat, and the list won't scroll"
status: done
created: 2026-08-01
---

# Newest message hides under the composer in a short chat, and the list won't scroll

**Status:** FIXED & SHIPPED 2026-08-01 (scroll correction) · residual entry flicker accepted

> **Two bugs reported alongside this one turned out NOT to be caused by it, after
> A/B against master on device. Do not re-attribute them:**
> - **keyboard↔panel swap flicker** — reproduces on MASTER. Pre-existing.
> - **messages disappearing on panel open** — does NOT reproduce on master; it was
>   introduced by the reverted commit `73de6b8` (a `bottomInset` dependency reached
>   `ScrollComponent`'s `useMemo`, remounting the scroll view). Reverted, not fixed.
>
> Both were initially assumed to be regressions from this fix purely because they
> were noticed after it landed. That assumption cost several hours.
**Reported:** 2026-08-01 (user, on the live build)
**Affects:** every chat surface — DM, Space channel, Farcaster DM (all render `MessagesList`)
**Branch:** `fix/chat-entry-layout-composer-and-short-list`
**Related:** [composer-keyboard-emoji-panel.md](../docs/composer-keyboard-emoji-panel.md) ·
[2026-06-20-composer-mispositioned-on-chat-entry.md](2026-06-20-composer-mispositioned-on-chat-entry.md)
(reported together; **separate causes** — see "Not the same bug" below)

---

## Symptom

Open a conversation that has only one or two messages. The newest message rests
*underneath* the floating composer pill instead of just above it, and:

- **dragging down to reveal it does nothing** — the list does not move;
- focusing the composer (which raises the keyboard) **sometimes** fixes it, sometimes not;
- it happens in DMs and in channels alike;
- it happens specifically when there is a lot of empty space above the messages.

## Root cause — CONFIRMED from library source (not inferred)

Two independent layers each own a different idea of "the bottom of the list", and
they disagree by exactly the composer's resting clearance.

**1. The clearance is a native contentInset, invisible to layout.**
`ChatKeyboardScrollView` hands the resting clearance to
`KeyboardChatScrollView` as `blankSpace`, which becomes
`totalPadding = max(blankSpace, keyboardPadding + extraContentPadding)` and is
applied by `ScrollViewWithBottomPadding` as a native scroll inset —
`contentInset.bottom` on iOS, and on Android a real `scrollView.setPadding(…)`
with `clipToPadding = false`
(`node_modules/react-native-keyboard-controller/android/src/main/java/com/reactnativekeyboardcontroller/views/ClippingScrollViewDecoratorView.kt`).
Either way it **extends the scrollable range below the content; it does not move
the content.**

**2. FlashList bottom-aligns short content to the VIEWPORT, inset and all.**
With `maintainVisibleContentPosition.startRenderingFromBottom` (which
`MessagesList` sets), FlashList v2 pads the cells down with
(`node_modules/@shopify/flash-list/dist/recyclerview/RecyclerView.js`, the
`getAdjustmentMargin` callback):

```js
Math.max(0, windowSize - childContainerSize - firstItemOffset)
```

`windowSize` is the FlashList container's own height — the full chat area, which
by design runs edge-to-edge behind the composer. Nothing in that expression knows
about the inset. So the last cell lands **flush with the screen bottom**, i.e.
behind the composer and the tab bar.

**3. …and its initial scroll aims at the wrong offset.**
`startRenderingFromBottom` also makes FlashList set
`initialScrollIndex = data.length - 1`
(`RecyclerViewManager.getInitialScrollIndex`) and scroll to **that cell's own
`layout.y`** (`useRecyclerViewController.applyInitialScrollIndex`), which it
passes straight to the native `scrollTo` without clamping in JS.

That last detail is what makes the bug **length-dependent**, and explains every
part of the report:

| Conversation | `layout(last).y` | Native clamp | Result |
|---|---|---|---|
| Long | far past the end | clamped to the true end, **inset included** | correct |
| Short (1–2 msgs) | 0 – a few dozen px | nothing to clamp | lands ~0, message under the composer |
| Medium | partway | partially clamped | **partially** revealed → the "sometimes" |

- *"scrolling up to reveal does nothing"* — the list is already at offset 0. The
  only room left is *below*, so the gesture that would reveal the message is a
  drag **up** (scroll down), not down.
- *"focusing the composer sometimes solves it"* — the keyboard's own scroll
  correction (`useChatKeyboard`) lands on the true end when it fires; when the
  keyboard's lift is absorbed into `blankSpace` instead, it does not.
- *"only with one or two messages and lots of empty space"* — that IS the
  condition `childContainerSize < windowSize` under which the adjustment margin
  is non-zero.

## Not the same bug as the composer-position one

Reported in the same message and superficially similar, but the mechanisms do
not overlap: this one is the **message list** resting too low inside a correctly
positioned list, and it is stable (it does not self-correct). The other is the
**composer pill itself** sitting too low for about a second and then snapping up.
Fixing this one cannot fix that one. See its own file.

## Fix (in tree)

[components/Chat/MessagesList.tsx](../../components/Chat/MessagesList.tsx) — when
the content is no taller than the viewport, land on the true end, which the
platform's own `scrollToEnd` computes **with** the inset:

- track the scroll view's viewport height (`onLayout`) and content height
  (`onContentSizeChange`), chaining FlashList's own handlers rather than
  replacing them (FlashList drives cell measurement off both);
- when `contentHeight <= viewportHeight`, call `scrollToEnd({ animated: false })`,
  plus one re-assert 150 ms later because FlashList keeps re-running its own
  initial scroll for ~100 ms after first layout and would otherwise land last.

Scope limits (why it can't fight the user or the composer):

- **Gated on short content only.** A list taller than the viewport is untouched,
  so no user scroll position is ever discarded.
- **Driven by content/viewport/inset changes, never by the panel.** Guarded on
  `composerBottomBusySV !== 1`, the same guard the send-time correction uses.

**Known defect — it corrects AFTER paint.** The message is painted at the wrong
offset and then scrolled into place, which reads as a brief flicker on entering a
short chat (confirmed independently by the user watching the device, and visible
in a 10fps screen capture as ~4 frames). This is inherent to correcting rather
than preventing and cannot be tuned away: FlashList measures, paints, runs its
own initial scroll, and only then can we override it.

**Ordering bug found while measuring (fixed):** the content inset lands ~77ms
AFTER the content size. Native `scrollToEnd` targets `content + inset − viewport`,
so aligning on the content-size event alone computes a target of 0 and does
nothing. The inset event is the trigger that matters.

## Attempted structural fix — REGRESSED, stashed, not merged

To remove the flicker the clearance has to be inside the list's own layout so
FlashList bottom-aligns correctly on the first pass. Attempted: clearance as
`paddingBottom` on the LAST CELL, `blankSpace` → 0, and
`extraContentPadding` = `composerFootprint + panelFootprint + LAST_MESSAGE_GAP −
restingClearance` (negative at rest, which `useExtraContentPadding` handles — it
works on deltas of `max(blankSpace, keyboardPadding + extra)` and skips changes
the floor absorbs).

Measured on device:

| State | Expected | Measured | Verdict |
|---|---|---|---|
| rest, short chat | inset 0, offset 0, message clear of composer | inset 0, offset 0 | ✅ correct, **no scroll, no flicker** |
| keyboard open | 174 + 280 = kb(382)+pill(60)+gap(12) | inset 280 | ✅ matches the derivation exactly |
| emoji panel open | inset ≈ 280 | **inset 766**, composer pill and panel visibly overlapping, messages showing between them | ❌ regressed |

**A/B COMPLETED 2026-08-01 — the regression IS this change's, the ugly geometry is not.**
Same channel, same tap sequence, fallback commit vs stashed structural build:

| Build | inset | offset | Panel geometry | Last message |
|---|---|---|---|---|
| fallback (`f83db31`) | 826 | 442 | pill above panel, panel fills to the screen bottom | ✅ clear of the pill |
| structural (stashed) | 766 | 276 | **identical** | ❌ sits under the pill |

Two separate conclusions, do not conflate them:

1. **The panel's own geometry is pre-existing.** Identical on both builds, so it is
   not caused by anything here. (It also reads as *normal* on inspection — the
   grid simply fills from under the pill to the screen bottom and scrolls.)
2. **The message-position regression is this change's.** Moving the clearance into
   the content shrinks the delta `useExtraContentPadding` scrolls by (it works on
   `currentTotal − previousTotal`), and the in-content clearance does not
   compensate for that on the panel path the way it does on the keyboard path.
   Exact mechanism NOT established — the arithmetic says both builds should end
   up within ~10dp of each other (structural `174 + 276 = 450` vs fallback
   `0 + 442 = 442`) yet they visibly differ, so something outside the derivation
   is in play.

Open lead for whoever picks this up: both builds show a panel footprint around
**766–826**, roughly double a keyboard height (~382). `composerFootprintSV` and
`composerPanelFootprintSV` are MODULE-SCOPE shared values, so every mounted
`MessageInput` writes to the same two globals — and expo-router keeps previously
visited chat screens mounted. Worth checking whether a second live composer (a
Farcaster DM was visited earlier in the same session) is contributing. If that is
real it is its own bug, independent of everything above, and it would also explain
why the derivation and the measurement disagree.

Decision: keep the scroll-correction fix, leave the structural variant stashed as
`structural-fix-wip`. The flicker is a cosmetic defect; the panel regression is a
functional one, so shipping the structural version as-is would be a net loss.

## Verification

- `npx jest` — 160/160 pass.
- `npx tsc --noEmit` — no new findings (pre-existing errors in `app/explore.tsx`
  and `services/calling/*` are untouched).
- **Done on device** (Motorola Edge 50 Fusion, dev build, `# Test` channel in
  *Cross device test*), via temporary `[chatdiag]` instrumentation:

  | | viewport | content | inset | offset | verdict |
  |---|---|---|---|---|---|
  | baseline, short chat | 878 | 878 | 174 | **85** | ❌ needed 174; 85 is exactly the last cell's own `y` |
  | with fix, short chat | 878 | 878 | 174 | **174** | ✅ |
  | long chat (unaffected) | 878 | 2238 | 174 | 1534 | ✅ `gapBelowLast −174` |

  `content == viewport` is the signature of FlashList's adjustment margin being
  active. `offset 85` confirmed the predicted mechanism directly rather than by
  inference.

- **Still outstanding:** the flicker; a DM (not just a channel) with 1–2 real
  messages; and the emoji-panel state on the fallback commit, which was never
  captured.

## Watch-list (not fixed here, noticed while reading)

`distanceFromBottomRef` in `MessagesList` is computed as
`contentSize.height - (contentOffset.y + layoutMeasurement.height)`, which does
**not** include the bottom inset. At the true end that distance is therefore
~`blankSpace` (≈170 px), not ~0, so the `<= 80` gate that decides whether an
incoming message from *someone else* should autoscroll can essentially never
pass. Own messages are unaffected (they bypass the gate). Left alone deliberately
— it is a separate behaviour change and was not part of this report — but it is
worth its own task. `ChatKeyboardScrollView` already accepts an
`onContentInsetChange` prop that would supply the missing term.

## Re-instrumenting

The `[chatdiag]` probe that produced every number above. It lived on the shipped
branch, which was squash-merged and deleted, so it is kept here. In
`MessagesList`'s `ScrollComponent`, chain onto the existing handlers (never
replace them — FlashList measures cells off both):

```ts
onLayout={(e) => { scrollProps.onLayout?.(e); d.viewport = e.nativeEvent.layout.height; log('layout'); }}
onContentSizeChange={(w, h) => { scrollProps.onContentSizeChange?.(w, h); d.content = h; log('contentSize'); }}
onContentInsetChange={(insets) => { d.inset = insets.bottom; log('inset'); }}
```

with `d` a ref and `log` emitting via **`console.warn`** — `console.log` does NOT
reach `adb logcat`; `console.warn` surfaces as `W ReactNativeJS`. Print
`viewport / content / inset / offset`, plus the two derived signals that make the
bug self-evident:

- `short = content > 0 && viewport > 0 && content <= viewport + 1` — true means
  FlashList's bottom-align adjustment margin is active.
- `gapBelowLast = content - offset - viewport` — **healthy is `-inset`**
  (the list resting inside the inset). The bug is `short=true` with
  `gapBelowLast ≈ 0`.

Feed `offset` from the existing `onScroll` handler (`contentOffset.y`).

Read with `adb logcat -d | grep chatdiag`. Git Bash on Windows mangles remote adb
paths — use a leading `//` (`//sdcard/x.mp4`).

*Last updated: 2026-08-01*
