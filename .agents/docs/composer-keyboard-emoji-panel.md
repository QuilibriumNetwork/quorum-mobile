# Message composer ↔ keyboard ↔ emoji panel choreography

How the chat composer, the soft keyboard, the emoji panel, and the bottom tab
bar coordinate so every transition is seamless — no drop, bounce, flash, gap, or
peek. This was a long, iterative build; the design below is the one that finally
holds across all transitions. Read this before touching any of it.

Covers DM and Space chat equally — they share the same composer and choreography
(see [Shared by DM and Space](#shared-by-dm-and-space)).

---

## The guiding principle: reveal, never mount/appear

The whole feature follows one idea: **the thing the user is about to see should
already be there, and a transition just uncovers it.** The keyboard sliding away
should reveal an emoji panel that was already painted behind it; dismissing a
keyboard should reveal a tab bar that was already sitting at the bottom. Anything
that *mounts* or *fades in* on the transition reads as a flash or a lag, because
React mount/commit lands a frame or two after the native animation starts.

Two corollaries drive every decision here:

1. **Position has ONE owner, on the UI thread.** The composer's on-screen
   vertical position is owned solely by an animated spacer (a Reanimated
   `useDerivedValue`). React layout never moves it. (This was learned the hard
   way — see [History](#history-the-bug-class-this-design-killed).)
2. **Visibility of the panel and the tab bar is driven on the UI thread**, from
   the live keyboard height + a couple of shared-value flags — never from
   React state that lags the keyboard.

---

## The pieces

### `useComposerPanel` — the choreography hook
[hooks/useComposerPanel.ts](../../hooks/useComposerPanel.ts)

The state machine. Outputs:

- `panelOpen` (React state) — conditional rendering + which content shows.
- `keyboardVisible` (React state) — keyboard up/down, flipped at animation
  *start* (`useKeyboardHandler.onStart`). Used for the mount latch, not position.
- `spacerHeight` (`SharedValue<number>`) — **the single owner of the composer's
  vertical position.** Applied as the height of a `Reanimated.View` under the
  pill. The panel lives inside that view, so the spacer height *is* the panel
  footprint.
- `panelVisibleSV` (`DerivedValue<number>`, 0/1) — whether the panel content
  should be painted, on the UI thread. Drives the panel's opacity.
- `openPanel` / `closePanel` / `closePanelAndRestoreKeyboard` / `togglePanel` /
  `onInputFocus` / `onSearchFocus` / `onSearchBlur` — the actions.

Internal shared values (UI-thread, so worklets branch without a JS round-trip):

- `lastKeyboardHeight` — last real measured keyboard height, latched on
  `onEnd`. Seeded from a module cache (`lastSessionKeyboardHeight`, fallback
  `290`) so the first open on a fresh mount already has a realistic footprint.
- `panelOpenSV` — `1` while the panel is open.
- `closingSV` — `1` during the close-by-summoning-keyboard hand-off; the spacer
  holds the panel footprint and lets the **rising** keyboard meet it (`Math.max`)
  so the pill never drops then bounces.
- `searchFocusedSV` — `1` while the in-panel search field is focused; lifts the
  panel above the keyboard the search field summons.
- `openedWithKeyboardRef` — whether a keyboard was up at open time. If NOT, the
  close path must not arm the keyboard hand-off (nothing is coming back).

### The spacer worklet — single position owner

The composer overlay is anchored at **`bottom: 0`** (constant — see
`ChatBottomChrome` below). So the spacer alone decides how far the pill floats
above the screen bottom:

```
spacerHeight = useDerivedValue(() => {
  const restingFootprint = restingChromeHeight + bottomInset;   // tab bar + safe inset
  const liveKb = Math.max(-keyboardHeight.value, 0);            // negate; see gotcha below
  if (panelOpenSV.value === 1) {                               // panel open
    const searchLift = searchFocusedSV.value === 1 ? liveKb : 0;
    return Math.max(lastKeyboardHeight.value + searchLift, restingFootprint);
  }
  if (closingSV.value === 1) {                                 // panel→keyboard hand-off
    return Math.max(liveKb, lastKeyboardHeight.value, restingFootprint);
  }
  return Math.max(liveKb, restingFootprint);                   // resting / keyboard following
});
```

Why this is one owner: there is no `bottom: tabBarHeight` React offset anymore.
The tab-bar clearance is folded into the spacer as `restingFootprint` — at rest
the spacer holds it (pill floats above the bar); as the keyboard rises past it,
`liveKb` takes over (the keyboard covers the bar). Keyboard-up and panel-open
both resolve to the same quantity (`lastKeyboardHeight` / `liveKb`), so there is
nothing to desync. The keyboard "hides" the bar simply by exceeding the resting
footprint; no React value flips to move the composer.

The **search lift**: when the in-panel search field is focused, a keyboard rises
over the panel. Adding `liveKb` to the open-panel height pushes the whole panel
up so the search field + top rows stay visible above the keyboard. Gated on
`searchFocusedSV` (not raw keyboard height) so the keyboard *dismiss* that
happens during a normal open doesn't transiently inflate the panel.

### `panelVisibleSV` — panel painted-or-not, on the UI thread

```
panelVisibleSV = useDerivedValue(() => {
  return panelOpenSV.value === 1 ? 1 : 0;                      // painted only while open
});
```

> **Changed 2026-08-01 — the keyboard-up preload was removed.** This used to
> ALSO return 1 whenever a keyboard was essentially fully up (≥90% of its last
> height), painting the grid behind the keyboard so that tapping emoji revealed
> an already-rasterised panel. That was correct on every platform with an
> **opaque** keyboard — all of Android, and iOS before 26. **iOS 26 made the
> system keyboard translucent**, so the preloaded emoji grid began showing
> through the keys; it was reported as "the keyboard is semi-transparent with
> weird yellow artifacts", the yellow being emoji faces.
>
> The panel is still **mounted** ahead of time (the mount latch in
> `MessageInput`, below), so only the pre-rasterisation is gone, not the
> ~120-node build. `panelOpenSV` still flips on the UI thread in the same frame
> as the tap, so the reveal has no React round-trip in it.
>
> Deliberately **not** branched on `Platform.OS`: an iOS-only paint path is one
> this project cannot test. Painting identically on both platforms means any
> hitch it introduces on the keyboard→panel transition shows up on Android,
> where it can be caught. **If a hitch does appear there, do not "fix" it by
> restoring the preload** — that reinstates the iOS 26 bleed-through. The next
> lever is an opaque scrim drawn above the panel while the keyboard is up,
> driven by the same shared values, which keeps the layer rasterised while
> hiding its content.

This is also the fix for the peek-below-the-tab-bar bug:

- As a keyboard **descends to dismiss** (panel not open), the panel is already
  unpainted, on the UI thread → it never peeks in the strip below the tab bar
  (which a React-lagged visibility flag used to cause).

The old `0.9` "keyboard is essentially up" threshold is gone with the preload;
`lastKeyboardHeight` is still used by the spacer worklet and is unaffected.

### `MessageInput` — the composer UI
[components/Chat/MessageInput.tsx](../../components/Chat/MessageInput.tsx)

Renders the pill (emoji toggle, growing `TextInput`, attach, send) and, beneath
it, the spacer `Reanimated.View` (`height: spacerHeight`). Inside the spacer, the
panel content is wrapped in a second `Reanimated.View` whose **opacity =
`panelVisibleSV`** — that's the UI-thread visibility.

Mount vs. visibility are separate concerns:

- **Mount latch** (`panelEverNeeded`, React state): the heavy panel mounts the
  first time it's needed (panel opens OR a keyboard comes up, so the grid is
  pre-built before the first emoji tap), then stays mounted. Reopening is a pure
  reveal with no remount. Resets per chat (the component remounts), so a chat
  where emoji is never opened never builds the grid.
- **Visibility**: opacity via `panelVisibleSV` (UI-thread, above). `pointerEvents`
  follows a React `panelShown` flag (`keyboardVisible || panelOpen`); a frame of
  lag there is harmless because while hidden the panel is either behind the
  keyboard or in the collapsed resting spacer.

The emoji grid is the heavy part (~120 `Text`+touchable cells in a non-virtualized
`ScrollView`). Each cell is a lightweight memoized `EmojiCell` that skips the
app-wide `SkinTouchable` machinery (pure overhead for an always-transparent
button). See [Performance](#performance).

### `ChatBottomChrome` — overlay positioning + fade
[components/Chat/ChatBottomChrome.tsx](../../components/Chat/ChatBottomChrome.tsx)

Anchors the composer overlay at **`bottom: 0`** (a constant — NOT
`bottom: tabBarHeight`). The spacer owns position; this is just the anchor. Also
paints the bottom fade gradient, sized by the (panel-aware) `tabBarHeight` prop —
the fade is the ONE thing that still legitimately takes the panel-aware effective
height (it's a static backdrop, not position).

### `composerPanelVisible` store + `composerBottomBusySV` — cross-tree signals
[services/ui/composerPanelVisible.ts](../../services/ui/composerPanelVisible.ts)

- **`composerPanelVisibleStore`** — a `useSyncExternalStore` bus. `useComposerPanel`
  publishes panel open/close synchronously (via `onPanelVisibilityChange`). The
  chat screens read it to compute `effectiveChromeHeight = panelOpen ? 0 :
  tabBarHeight`, which feeds the bottom fade and the message-list content inset
  (content concerns, NOT position).
- **`composerBottomBusySV`** (UI-thread shared value) — "the composer owns the
  bottom of the screen." Set to `1` on panel open, **held through the entire
  panel↔keyboard hand-off**, cleared only once the keyboard has settled (or on a
  plain close). This is what the tab bar reads to know it must stay hidden — see
  below.
  - **Every release of this flag is guarded by `panelOpenSV !== 1`** (both the
    keyboard-settle handler's height>0 AND height==0 branches). This is
    load-bearing: in a slow subtree (the heavier Space/channel composer) the
    keyboard's settle event can land AFTER the user has already tapped emoji to
    open the panel; an unguarded release then clears the flag while the panel is
    open → tab bar visible OVER the panel, persistently (the
    `2026-06-19-tab-bar-visible-above-emoji-panel-channels` bug, root-caused
    2026-06-20). The height>0 branch originally lacked this guard.
  - **A self-correcting guard** (`useAnimatedReaction` in `useComposerPanel`) is
    bidirectional. It force-RELEASES the flag once the panel is closed AND no
    keyboard hand-off is genuinely in flight (or the summoned keyboard is
    essentially fully up) — so the flag can't be left STUCK hidden if a hand-off's
    settle never arrives (focus race, OS quirk; symptom: tab bar vanishing on the
    prod build). It also force-HOLDS the flag at 1 whenever the panel is open — so
    a stray clear during the open transition can't leave the tab bar VISIBLE over
    the panel. The keyboard-first open path (tap input, then emoji) hit exactly
    that: `openPanel` sets `panelOpenSV=1` on the JS thread, then dismisses the
    keyboard; the dismiss's `onEnd(height=0)` worklet can run on the UI thread
    before that write propagates, so its `panelOpenSV !== 1` guard reads a stale 0
    and clears busy while the panel is open (intermittent — depends on the write
    race). The force-hold re-asserts busy within a frame. The flag can no longer
    get stuck in either direction.

### `AppTabBar` — self-contained, always-mounted, hides itself
[components/ui/AppTabBar.tsx](../../components/ui/AppTabBar.tsx) ·
[app/(tabs)/_layout.tsx](<../../app/(tabs)/_layout.tsx>)

The tab bar is **always mounted** (`_layout` renders `<AppTabBar />`
unconditionally — never `null`). It hides *itself*:

```
hideStyle = useAnimatedStyle(() => ({
  opacity: composerBottomBusySV.value === 1 ? 0 : 1,
}));
```

That's the whole visibility rule, on the UI thread. The bar is hidden **iff the
composer owns the bottom** (`bottomBusy`). It is NOT gated on keyboard height:
for a plain keyboard show/dismiss the OS keyboard is drawn on top and
covers/reveals the always-mounted bar naturally, so it stays `opacity: 1` and the
descending keyboard uncovers an already-present bar (no gap, no appear).
`pointerEvents` follows a React `panelOpen` read so the hidden bar can't catch
taps meant for the panel (lag-harmless: while only a keyboard is up, the keyboard
eats the taps).

Why `bottomBusy` and not just `panelOpen`: on the **panel→keyboard** transition
the panel closes a few frames before the summoned keyboard starts rising. If the
bar keyed on `panelOpen` alone it would flash in during that gap. `bottomBusy`
spans the whole hand-off (open → keyboard settled), bridging the gap so the bar
never flickers.

### Shared by DM and Space

[DMChatArea](../../components/Chat/DMChatArea.tsx) and
[SpaceChatArea](../../components/Chat/SpaceChatArea.tsx) render the same
`MessageInput` in the same `ChatBottomChrome` with identical props
(`bottomInset={0}`, plus `restingChromeHeight` = the raw, stable tab-bar height).
[FarcasterDirectMessageView](../../components/Chat/FarcasterDirectMessageView.tsx)
uses a flex-column layout (not the overlay) and was brought into the same prop
contract — it's the highest regression risk because its geometry differs, so
verify it specifically. The screens pass the RAW tab-bar height (NOT zeroed on
panel open) as `restingChromeHeight`; `useBottomTabBarHeight()` is stable across
the panel's open/close (it reads `tabBarStyle.height` from context, not the
rendered bar), so there's no value to desync.

### The chat list's scroll — clearing the panel without double-counting
[components/Chat/ChatKeyboardScrollView.tsx](../../components/Chat/ChatKeyboardScrollView.tsx) ·
[services/ui/composerFootprint.ts](../../services/ui/composerFootprint.ts)

The message list scrolls via `react-native-keyboard-controller`'s
`KeyboardChatScrollView`. Its bottom inset is
`max(blankSpace, keyboardPadding + extraContentPadding)`, where:
- `blankSpace` = the resting clearance (composer + tab bar), so at rest the newest
  message floats above the composer and the keyboard "absorbs into" it.
- `extraContentPadding` = `composerFootprintSV` (the measured pill + banners) +
  `composerPanelFootprintSV` (the emoji panel's below-pill height while open).

Three things this layer must get right (all added/fixed 2026-06-20):

1. **No double-count on the swap.** The panel footprint and the keyboard padding
   cover the SAME bottom zone. Publishing the full panel height while the keyboard
   is still up (or rising) double-counts it and the list jumps — scrolls DOWN as
   the panel opens from a keyboard, or leaves empty space below the last message
   when the keyboard is re-summoned. Fix: publish the panel footprint as
   `max(0, panelHeight − liveKeyboard)`, so as the keyboard slides out the
   footprint ramps in by exactly the amount the keyboard padding drops (and vice
   versa). `keyboardPadding + panelFootprint` stays continuous through the swap.

2. **Don't chase the dismissing keyboard (open-from-keyboard).** Opening the panel
   dismisses the keyboard; the library reads that as a plain close and actively
   `scrollTo`s the list down to follow the descending keyboard — but the panel is
   taking that space, so the list must hold. Use the library's `freeze` prop
   (`composerListFreezeSV`, its purpose-built "dismiss-to-open-a-sheet" switch) to
   suppress the auto-scroll. The scrollable range still grows for the panel via
   contentInset (freeze gates only the auto-scroll). **Gate freeze on
   opened-FROM-keyboard** (`openedWithKeyboardSV`), see next.

3. **DO lift on a cold open (no keyboard).** When the panel opens from rest there's
   no keyboard to lift the list, so freeze must stay OFF (it would also block the
   extra-padding lift that should scroll the last message above the panel). Gating
   freeze on `openedWithKeyboardSV` gives the keyboard path no-chase and the cold
   path a proper lift. Known minor issue: the cold-open lift has a small lag vs the
   panel slide (the extra-padding scroll is a single deferred correction, not the
   per-frame scroll the keyboard does). A per-frame `scrollToEnd` follower was
   tried and gave NO improvement — do not re-add it; the small lag is accepted.

   **The footprint must publish in ONE step, never ramped** (regression
   2026-06-20→2026-07-28, `2026-07-28-emoji-panel-cold-open-no-list-lift`):
   tracking the spacer's cold-open ramp in the published footprint feeds the
   library per-frame deltas, and its scroll correction computes each target as
   `scroll + delta` from a scroll position that lags its own rAF-deferred
   scrollTo on Android — successive deltas overwrite instead of accumulating
   (~26px of a ~173px lift). The single-step publish is what makes the "single
   deferred correction" above land the full distance.

5. **The clearance is a scroll INSET, and FlashList cannot see it.** This layer's
   whole output — `max(blankSpace, keyboardPadding + extraContentPadding)` — is
   applied by `ScrollViewWithBottomPadding` as a NATIVE scroll inset:
   `contentInset.bottom` on iOS, a real `scrollView.setPadding(...)` with
   `clipToPadding = false` on Android. An inset **extends the scrollable range;
   it never moves content.**

   That matters because `MessagesList` sets
   `maintainVisibleContentPosition.startRenderingFromBottom`, and FlashList v2
   bottom-aligns content shorter than the screen with
   `getAdjustmentMargin() = max(0, windowHeight − cellsHeight − firstItemOffset)`
   — the full chat-area height, with **no term for the inset**. It then scrolls
   to `initialScrollIndex = data.length - 1`'s own `layout.y`
   (`RecyclerViewManager.getInitialScrollIndex` →
   `useRecyclerViewController.applyInitialScrollIndex`), passed to the native
   `scrollTo` unclamped.

   Consequence, measured on device (`viewport 878, content 878, inset 174`):

   | Conversation | Requested offset | Result |
   |---|---|---|
   | long | past the end → platform clamps it, inset included | correct (offset 1534) |
   | 1–2 messages | the last cell's own `y` (85) — nothing to clamp | **newest message parks under the composer** (needed 174) |

   So a short conversation rests too low and cannot be dragged back into view:
   the list is already at offset 0 and the only room left is below it. This is
   a property of the two libraries, present in master today. Anything that
   reasons about "where the bottom of the list is" must know that **the list's
   layout bottom and its scroll bottom differ by the inset.**

   **Shipped fix (2026-08-01):** when the content is no taller than the viewport,
   `MessagesList` lands on the true end — `content + inset − viewport` — which the
   platform's own `scrollToEnd` computes WITH the inset. Gated to that case alone,
   so a scrollable list is never touched and no user scroll position is discarded,
   and guarded on `composerBottomBusySV` so it can't fight the panel.

   Two things about it to know before changing it:
   - **The inset lands ~77ms AFTER the content size.** Aligning on the
     content-size event alone computes a target of 0 and silently does nothing.
     `onContentInsetChange` is the trigger that matters.
   - **It corrects AFTER paint**, so entering a short chat shows a brief
     reposition. Removing that needs the clearance inside the cells' own layout;
     that variant was built and measured (rest and keyboard exactly right) and
     regressed the panel state, so it is NOT in tree. See the bug file before
     retrying it: `.agents/issues/.done/2026-08-01-short-chat-last-message-hidden-behind-composer.md`.

The cold-open panel SLIDE itself (the spacer growing from rest to the panel
height) is driven by `coldOpenSV` (a `withTiming` 0→1 ramp), since there's no OS
keyboard slide to provide the motion. Opening from a keyboard sets `coldOpenSV=1`
immediately so the keyboard's own slide does the reveal.

4. **Send-time correction defers to the panel.** `MessagesList` runs a deferred
   second `scrollToEnd` ~350ms after a new own message (the animated first pass
   targets the pre-measure content size, which under-lands on much-taller-than-
   average cells like emoji-only messages). That snap is gated on
   `composerBottomBusySV !== 1` so it can never fire while the panel owns the
   bottom and fight the panel's own list choreography (freeze / cold-open lift).

---

## The transition matrix (what the design guarantees)

| Transition | Position | Panel | Tab bar |
|------------|----------|-------|---------|
| idle | pill above bar (spacer = restingChrome) | hidden (`panelVisibleSV`=0) | visible |
| typing (kb up) | pill on kb (spacer = liveKb) | mounted, NOT painted (`panelVisibleSV`=0) | hidden (bottomBusy=0 but kb covers it; opacity 1, covered) |
| kb → panel (tap emoji) | spacer holds lastKb throughout | painted on the tap frame → revealed as kb slides | hidden (bottomBusy=1) |
| panel → kb (tap input) | closingSV hand-off holds the pill | hides in lockstep as panel closes | hidden (bottomBusy held across hand-off) |
| panel open → search focus | spacer + searchLift (panel rides up) | visible above the search keyboard | hidden |
| kb → idle (plain dismiss) | spacer follows kb down to restingChrome | hidden (drops <90% immediately) | revealed under the descending kb (always mounted) |

Every cell is driven on the UI thread, so no transition has a frame where
something is visible-but-uncovered or mounting-late.

> **"Covered" is a weaker guarantee on iOS 26 than it looks.** Note the tab-bar
> cell in the `typing (kb up)` row: it is at opacity 1 and merely *covered* by
> the keyboard. That reasoning held while every keyboard was opaque. iOS 26's
> keyboard is translucent, which is what turned the panel's identical
> "painted, covered" state into a visible bug. The tab bar is a thin strip at
> the very bottom so it is a far smaller offender, but if a tester reports
> anything else showing through the keyboard, **this row is where to look
> first** — anything this table calls "covered" is a candidate.

---

## Gotchas (these cost real time)

- **`useReanimatedKeyboardAnimation().height` is NEGATIVE-going** (0 → −kbHeight).
  The library's own components negate it; so do we (`-keyboardHeight.value`). The
  *event* `e.height` in `useKeyboardHandler` is positive — don't conflate them.
- **Position must never depend on React render timing.** This is why the overlay
  is `bottom: 0` (constant) and the spacer is the only position owner. Changing
  *when* the panel content commits no longer perturbs position (that's the point
  of the refactor) — but don't reintroduce a React-driven position offset.
- **Panel/tab-bar VISIBILITY must be UI-thread for anything that races the
  keyboard.** Every flash/peek in this feature's history came from gating
  visibility on React state (`keyboardVisible`, `panelOpen` props) that lags the
  native keyboard slide. Use the shared values (`panelVisibleSV`,
  `composerBottomBusySV`) for visuals; React flags are fine only for
  `pointerEvents` (lag-harmless).
- **`composerBottomBusySV` lifecycle is load-bearing.** It must be set on open and
  cleared on EVERY exit (keyboard settle in either direction, plain close, and
  the no-keyboard close branch). A missed clear leaves the tab bar stuck hidden;
  the `onEnd` height-0 clear is guarded by `panelOpenSV !== 1` so a panel-open
  dismiss (which also settles at height 0) doesn't release the bottom while the
  panel still holds it.
- **The keyboard↔panel swap flickers the message list on MASTER.** Opening the
  panel while the keyboard is up (or the reverse) makes the messages above the
  composer visibly scroll up and down once, intermittently, varying by channel.
  **Confirmed on master 2026-08-01** — it is NOT introduced by any of the
  short-chat work, and it predates it. Recorded here because it was twice
  mistaken for a fresh regression (the reporter noticed it right after an
  unrelated change landed, which is not evidence of causation). Anyone touching
  the list inset should establish the master baseline for this FIRST, before
  attributing it to their own change.

- **`MessagesList`'s `ScrollComponent` identity is load-bearing.** It is memoised
  precisely so FlashList never sees a new scroll component type — a change there
  REMOUNTS the scroll view and the rendered messages vanish. The screens pass
  `bottomInset = useChatListBottomInset(composerPanelOpen ? 0 : tabBarHeight)`,
  so **`bottomInset` changes the moment the emoji panel opens**. Never let it
  reach that `useMemo`'s dependency array, directly or through a `useCallback`
  chain — hold it in a ref instead. (Hit 2026-08-01: a guard added to the
  short-chat scroll correction took `bottomInset` as a dep, and opening the panel
  wiped the message list. Master does NOT do this, so the dep was the trigger.
  It was resolved by REVERTING that commit, not by fixing the dep, so whether the
  ref-based version alone would have cleared it is untested — assume the hazard,
  don't assume the fix.)

- **Module-scope `makeMutable`** is used for `composerBottomBusySV` (a shared
  value outside a hook). Supported, but only imported by components that render
  after Reanimated init — keep it that way.

---

## Performance

Opening the panel mounts ~120 nodes. Two things keep it cheap:

1. **Mount latch** (above): the grid is built once (on first keyboard or first
   open) and kept mounted, so reopening is a pure reveal. The paint-ahead half
   of this pair (the keyboard-up preload) was removed on 2026-08-01 — see
   `panelVisibleSV`. Only rasterisation moved to the tap frame; the node build
   still happens ahead of time.
2. **Lightweight `EmojiCell`**: each cell skips `SkinTouchable`'s per-node
   theme/flatten/color work.

If a release build still shows a hitch on the *very first* build, virtualizing
the grid (`FlashList`) is the remaining lever — fiddly (category switch, search
sections rendered together, sticker column count, concrete height inside the
height-constrained spacer). Do it as its own task; it's not needed for the
reveal feel, which the mount latch already delivers.

Historical note: an early attempt deferred the grid mount with
`requestAnimationFrame`. On the *old* two-owner architecture that perturbed
position and reintroduced the bounce, so it was reverted. With position now
UI-thread-only it would be safe, but the preload makes it unnecessary.

---

## History: the bug class this design killed

For several sessions the keyboard↔panel swap kept regressing with the same
symptom — tap emoji and the composer **drops, leaves an empty gap, then bounces
back up**; or the tab bar **flashes/peeks** during a transition. The root cause
was always the same: **more than one owner of an on-screen value, on different
clocks.**

The original design had the composer overlay at `bottom: tabBarHeight` (React,
un-animated) AND a spacer (Reanimated). On open, the tab bar unmounted and
`effectiveChromeHeight` flipped `tabBarHeight → 0`, repositioning the overlay on
a React frame while the spacer moved on the UI thread and the keyboard moved on
its own — three clocks, visible desync. Each fix (the `closingSV` hand-off, the
synchronous store publish, no-chrome-subtraction-when-open) patched one case and
a later timing change reopened another.

The durable fix was to **collapse to one position owner** (overlay `bottom: 0`,
spacer holds everything) and then, for visibility, to **drive every keyboard-racing
visual from the UI thread** (`panelVisibleSV`, `composerBottomBusySV`) instead of
lagged React state. Once both held, the flashes/peeks/bounces stopped across all
transitions.

**The rule that prevents regression:** if a value affects where the composer sits
or whether the panel/tab-bar is visible *during a transition*, it must be a
shared value read in a worklet — never React state or a React-layout prop. React
decides *what* content and *whether* the panel is open; it is never on the
critical path for *where things sit* or *what's visible mid-slide*.

---

## Quick reference — files

| File | Role |
|------|------|
| [hooks/useComposerPanel.ts](../../hooks/useComposerPanel.ts) | state machine; owns `spacerHeight`, `panelVisibleSV`, the hand-off flags |
| [components/Chat/MessageInput.tsx](../../components/Chat/MessageInput.tsx) | composer pill + panel inside the spacer; mount latch + opacity visibility |
| [components/Chat/ChatBottomChrome.tsx](../../components/Chat/ChatBottomChrome.tsx) | overlay anchored at `bottom: 0` + bottom fade |
| [services/ui/composerPanelVisible.ts](../../services/ui/composerPanelVisible.ts) | panel-open store (fade/inset) + `composerBottomBusySV` (tab bar) |
| [services/ui/composerFootprint.ts](../../services/ui/composerFootprint.ts) | `composerFootprintSV` (pill height), `composerPanelFootprintSV` (panel height), `composerListFreezeSV` (list-scroll freeze) |
| [components/Chat/ChatKeyboardScrollView.tsx](../../components/Chat/ChatKeyboardScrollView.tsx) | wraps `KeyboardChatScrollView`; feeds footprint as `extraContentPadding` + `freeze` |
| [components/ui/AppTabBar.tsx](../../components/ui/AppTabBar.tsx) | always mounted; hides itself via `composerBottomBusySV` (UI-thread opacity) |
| [app/(tabs)/_layout.tsx](<../../app/(tabs)/_layout.tsx>) | always renders `AppTabBar` (no conditional unmount) |
| [app/(tabs)/messages/dm/[id].tsx](<../../app/(tabs)/messages/dm/[id].tsx>) · [spaces/[id]/[channelId].tsx](<../../app/(tabs)/spaces/[id]/[channelId].tsx>) | pass raw `restingChromeHeight` + panel-aware `effectiveChromeHeight` |
| [components/Chat/DMChatArea.tsx](../../components/Chat/DMChatArea.tsx) · [SpaceChatArea.tsx](../../components/Chat/SpaceChatArea.tsx) · [FarcasterDirectMessageView.tsx](../../components/Chat/FarcasterDirectMessageView.tsx) | wire the composer props |

*Last updated: 2026-08-01*
