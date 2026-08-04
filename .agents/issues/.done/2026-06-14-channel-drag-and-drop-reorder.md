---
type: task
title: "Drag-and-drop channel reordering (mobile)"
status: done
created: 2026-06-14
runtime-test: required (gesture-heavy)
priority: low (nice-to-have, second pass)
parent: .agents/issues/.done/2026-06-12-channel-group-icon-and-settings.md (sub-task 4, carved out 2026-06-14)
related: .agents/issues/.done/2026-06-14-channel-group-settings-drawer-design.md (touches the same channel rows)
research: refined 2026-06-17 (RN draggable-list landscape, FlashList/scroll-conflict, iOS/Android reorder UX) — see "Research findings" below
---

# Drag-and-drop channel reordering

Carved out of the channel/group settings cluster (parent sub-task 4) because it's a distinct
kind of work — a React Native gesture layer with its own failure modes and heavy runtime testing
— that shouldn't be entangled with the mostly-mechanical settings-drawer build.

## Goal

Replace mobile's current **up/down-arrow** channel reordering with **drag-and-drop** inside each
group. Functional parity with desktop's grip-handle DnD, nicer UX.

## Decisions locked (2026-06-17)

These were open questions; they are now settled, so build to them directly.

| Decision | Choice | Why |
|---|---|---|
| **Activation** | Dedicated **drag handle** (grip icon), NOT long-press-anywhere | Each row is also a tap target (tap → settings drawer). A handle is the only pattern that fully eliminates tap-vs-drag ambiguity. Unanimous across iOS HIG, Material 3, and desktop's own implementation. |
| **Scope (this pass)** | **Reorder channels within a group only** | Lowest-risk first pass. Cross-group move + group reordering stay out (mutations exist — `useMoveChannel` cross-group, `useReorderGroups` — but are deferred). This is also the scope where hand-rolling is cheapest (no nested draggable contexts, no auto-scroll-during-drag worth the name). |
| **Arrows fate** | **Remove the up/down chevrons**; add `accessibilityActions` (Move up / Move down) instead | Cleaner rows, matches desktop's visual. The accessible reorder path becomes VoiceOver/TalkBack custom actions wired to the existing move handlers — which is *better* than desktop, which has NO accessibility fallback at all (PointerSensor-only, no keyboard sensor). |
| **Implementation** | **Hand-roll** with `react-native-gesture-handler` + `react-native-reanimated` (already in the stack) — NO new dependency | See "Why hand-roll, not a library" below. |

## What already exists (the easy part)

The reorder **mutation is done**: within-group reorder is just `useMoveChannel` with
`fromGroupIndex === toGroupIndex` (broadcast + persist already wired, including the outbound fix
from PR #80) — exactly what the current arrow handlers already call. There is also a dedicated
`useReorderChannels` (takes a full `channelOrder: string[]`) which is cleaner for a drag that
produces a final ordering in one shot.
[useChannelManagement.ts](../../hooks/chat/useChannelManagement.ts)

The existing arrow handlers we will **reuse for the a11y actions**:
- [SpaceSettingsModal.tsx:1206](../../components/SpaceSettingsModal.tsx#L1206) `handleMoveChannelUp`
- [SpaceSettingsModal.tsx:1227](../../components/SpaceSettingsModal.tsx#L1227) `handleMoveChannelDown`

This task is **purely the gesture-UI layer** — no data/mutation work.

## Why hand-roll, not a library

The research surveyed the 2026 RN draggable-list landscape (full notes below). The realistic
options were `react-native-reorderable-list` (best-maintained, handle-only drag, Reanimated-4
compat *probably* fixed) vs `react-native-sortables` vs hand-rolling. **Hand-rolling wins for
this specific task:**

1. **The chosen scope is the cheap case.** "Within-group reorder only" strips out exactly the
   parts a library earns its keep on — nested cross-group contexts, drop-on-group-header,
   auto-scroll while dragging a long list. What's left is one short vertical reorder: a
   handle-scoped Pan gesture, a `translateY` shared value, a swap-index calc, and persist on
   release. This is the well-trodden ~150-line Reanimated pattern, not a multi-day build.
2. **The library's headline risk lands on this project's sore spot.** `react-native-reorderable-list`'s
   Reanimated-4 compatibility rests on two *closed* GitHub issues (#62, #63, Oct–Nov 2025) with
   **no changelog entry confirming the fix** — the research agent explicitly said "smoke-test
   before committing." On this stack a smoke test means a **native rebuild**, which the memory
   notes repeatedly flag as slow/painful and "never speculative"
   ([[verify-statically-before-expensive-rebuilds]]). Hand-rolling reuses `react-native-gesture-handler`
   2.28.0 + `react-native-reanimated` 4.1.1 already running in production → zero new native
   surface, nothing new to smoke-test.
3. **Dependency hygiene.** A reorder-within-a-group nicety doesn't justify a new native dep,
   given the clean-install discipline this repo already follows
   ([[local-shared-dev-link-scripts]] / batch-and-merge rules).

**Fallback:** if runtime testing shows the hand-rolled gesture can't be made to coexist with the
modal's swipe-to-dismiss and the inner ScrollView (see the gotchas below), drop in
`react-native-reorderable-list@>=0.18.0` (`useReorderableDrag()` hook gives handle-only drag,
peerDep `react-native-reanimated >=3.12.0` covers 4.1.1). Treat that as plan B, not plan A.

## The hard part (why it's its own task)

These are the runtime failure modes to design against, in priority order:

### 1. Three competing gestures in the same view tree
The channels list lives inside **`SpaceSettingsModal` → `BaseModal` (a RN `<Modal>`)**, and the
Channels tab content is a **`<ScrollView>`** ([SpaceSettingsModal.tsx:1779](../../components/SpaceSettingsModal.tsx#L1779)).
So a drag must coexist with:
- **The inner `ScrollView`'s vertical scroll** (the list can exceed one screen).
- **`BaseModal`'s swipe-to-dismiss** (`useModalAnimation` / `snapBack` pan on the sheet).
- The **row tap** (opens the drawer) — already solved by scoping the gesture to the handle.

The clean fix (per the gesture-conflict research): attach the `Gesture.Pan()` **only to the grip
handle**, not the row body or the scroll area. Touches on the row body / empty space flow
unimpeded to the ScrollView and the modal sheet. For the handle's pan, use
`simultaneousWithExternalGesture(scrollViewRef)` so a drag near the scroll doesn't get cancelled,
and import `ScrollView` **from `react-native-gesture-handler`** (not `react-native`) so RNGH can
coordinate. Do NOT try to disambiguate by axis (`activeOffsetX`/`failOffsetY`) — a vertical drag
inside a vertical scroll shares the axis, so thresholds can't separate intent; the handle is what
separates them.

### 2. Gestures inside a RN `<Modal>` need their own `GestureHandlerRootView` (Android)
The app root has a `GestureHandlerRootView` ([app/_layout.tsx:321](../../app/_layout.tsx#L321)),
but RN `<Modal>` renders in a **separate native view hierarchy**, so on **Android** gestures inside
the modal silently do nothing unless the modal content is *also* wrapped in its own
`GestureHandlerRootView`. `BaseModal` currently is not. Either wrap `BaseModal`'s content in a
`GestureHandlerRootView` (cleanest, benefits any future in-modal gesture) or wrap just the
Channels tab. **Verify on a physical Android device** — this is the single most likely "drag does
literally nothing" cause.

### 3. Scroll container choice — keep `ScrollView`, do NOT introduce FlashList
For a 5–40 row settings list, FlashList is the wrong tool: its view **recycling actively fights
drag reordering** (a dragged row's view can be recycled mid-drag) and no maintained draggable
library supports FlashList 2.0 as the scroll container anyway. The list already uses `ScrollView`;
keep it. (FlashList is for large recycling feeds, not a short static settings list.)

### 4. Accessibility (now the *better-than-desktop* path)
Removing the arrows means the accessible reorder path is `accessibilityActions` on each row:
```tsx
accessibilityActions={[
  { name: 'moveUp', label: 'Move up' },
  { name: 'moveDown', label: 'Move down' },
]}
onAccessibilityAction={(e) => {
  if (e.nativeEvent.actionName === 'moveUp') handleMoveChannelUp(groupIndex, channelIndex);
  else if (e.nativeEvent.actionName === 'moveDown') handleMoveChannelDown(groupIndex, channelIndex);
}}
```
RN's `accessibilityActions` maps to iOS `accessibilityCustomActions` (VoiceOver swipe-down menu)
and Android `addAccessibilityAction` (TalkBack local context menu) — this is the
platform-mandated accessible alternative to drag (Apple HIG + Android a11y docs both require
custom move actions for reorderable lists). The drag handle itself should carry an
`accessibilityLabel` like "Drag to reorder {channelName}". Disable the move actions at the ends
(first row → no Move up, last row → no Move down) by omitting them.

## Build outline (hand-rolled)

A `DraggableChannelRow` + a small reorder controller scoped to one group:

1. **Grip handle** on the trailing edge of each row (matches desktop + both platform conventions;
   Tabler `grip-vertical` / IconSymbol — confirm the name resolves in `IconSymbol`). Muted color.
   The handle is the only element with the Pan gesture.
2. **Row layout tracking.** Measure each row's height (rows are uniform height → one constant is
   enough; `onLayout` on the first row, or a fixed row-height constant). Track the dragged row's
   `translateY` in a `useSharedValue`.
3. **Pan gesture** (`Gesture.Pan()`, RNGH new API via `GestureDetector`) on the handle:
   `onStart` → set `activeIndex`, haptic Light, raise `zIndex`/elevation/scale 1.03;
   `onUpdate` → update `translateY`, compute the hovered index from `translateY / rowHeight`,
   shift the other rows to open a gap (`withSpring` translateY on neighbors);
   `onEnd` → compute final order, `runOnJS`(persist via `useReorderChannels` for the group),
   haptic Medium, reset shared values.
4. **Persist** with `useReorderChannels({ spaceId, groupIndex, channelOrder })` (one-shot final
   order — cleaner than chaining `useMoveChannel`). After mutation, `setSpace(getSpace(spaceId))`
   to re-sync local state like the arrow handlers do.
5. **Visual drag state** (cross-platform synthesis from HIG + M3): lifted row gets
   `shadowOpacity ~0.3` / `shadowRadius 8` (iOS) + `elevation 8` (Android) + `scale 1.03` +
   `zIndex 999`, background shifts to `surface3`. The gap at the drop target is a semi-transparent
   `surface3` slot, not blank space (blank reads as "deleted").
6. **Haptics** (`expo-haptics`, already a dep): `ImpactFeedbackStyle.Light` on lift,
   `Haptics.selectionAsync()` on each discrete position swap (NOT every frame), and
   `ImpactFeedbackStyle.Medium` on drop. On Android these map to `EFFECT_TICK`/`EFFECT_CLICK`.
7. **Accessibility actions** as above; handle `accessibilityLabel`.

## Verification (when built)

- [ ] Drag a channel by its grip handle reorders within the group; order persists and syncs to a second client.
- [ ] Drag does not fight the inner ScrollView scroll, and does not trigger `BaseModal`'s swipe-to-dismiss.
- [ ] Tap-to-open-drawer still works on the same rows (no gesture conflict) — tap the row body, not the handle.
- [ ] **Android specifically:** drag actually works inside the modal (the `GestureHandlerRootView`-in-modal fix is in place — this is the #1 "drag does nothing" trap).
- [ ] VoiceOver (iOS) and TalkBack (Android): each row exposes "Move up" / "Move down" custom actions wired to the existing move handlers; first/last rows omit the impossible direction.
- [ ] Haptics fire on lift / swap / drop (not on every frame).
- [ ] The old up/down chevron buttons are gone; no dead handlers left dangling (the move handlers stay — they're reused by the a11y actions).
- [ ] `npx tsc --noEmit` + `yarn lint` clean.

## Sequencing

The settings drawer has shipped (branch `feat/channel-group-settings-drawer`), so the row's
tap-target behavior is settled and the handle can be designed not to conflict with it. This task
can start once that branch is merged.

---

## Research findings (2026-06-17)

Three parallel research streams (RN library landscape, FlashList/gesture-conflict, iOS+Android
UX conventions). Key load-bearing conclusions, with the desktop reference for parity.

### Desktop reference (the parity target)
`quorum-desktop/src/components/modals/SpaceSettingsModal/Channels.tsx` uses **`@dnd-kit/core` +
`@dnd-kit/sortable`**. UX: a **grip-vertical handle** carries the drag listeners (NOT the whole
row — row body stays clickable for edit). Activation = movement-distance threshold (touch 15px,
pointer 8px), **no long-press**. Both channels AND groups draggable; cross-group move supported.
`touchAction: 'none'` on draggables, `pan-y` on container. **No keyboard/accessible fallback at
all** — the grip handle is the only reorder path (no up/down arrows on desktop). Mobile's
`accessibilityActions` approach is therefore strictly better on a11y.

### Library landscape (RN, this stack: RN 0.81.5 / Reanimated 4.1.1 / RNGH 2.28.0 / Expo 54 / Fabric)
- **react-native-draggable-flatlist** — DO NOT USE. Last release >1yr ago, 200+ open issues,
  confirmed flicker/regression on *this exact stack* (issue #609: Expo 54 + Reanimated 4.1.x + RNGH 2.28 on Android).
- **react-native-reorderable-list** (omahili, v0.18.0) — best-maintained option *if* using a lib.
  Handle-only drag via `useReorderableDrag()`. peerDep `react-native-reanimated >=3.12.0` covers 4.1.1.
  RN4 + Expo-54 issues (#62, #63) **closed Oct–Nov 2025 but NOT in the changelog** → needs a smoke
  test (= native rebuild on this repo). FlatList-based; no FlashList.
- **react-native-sortables** (MatiPl01, v1.9.4) — richer (first-class `Sortable.Handle`, built-in
  haptics, RN4 + New Arch explicitly supported, `>=3.0.0` peer range). Heavier; docs had gaps.
- **react-native-reanimated-dnd** (v2.0.0) — purpose-built for RN4 but targets **Expo SDK 55+** (we're on 54) → skip.
- **react-native-drax** (v1.1.0) — general DnD, FlashList-agnostic via `component` prop, but overkill for a vertical reorder.
- **None installed** in this repo today → any library = a new (native) dependency.

### FlashList / scroll-conflict
- FlashList 2.0 **recycling fights drag** (dragged view can recycle mid-drag); no maintained
  draggable lib supports FlashList 2.0 as the scroll container. For 5–40 rows, plain
  `ScrollView`/`FlatList` is correct — virtualization brings no benefit and recycling actively hurts.
- Canonical scroll-vs-drag fix for a vertical drag in a vertical scroll = **dedicated handle**
  (the only thing that truly separates intent; axis thresholds can't, same axis). Use
  `simultaneousWithExternalGesture(scrollRef)` and import RNGH's `ScrollView`. `manualActivation`
  + `Gesture.Exclusive(longPress, pan)` is the fallback if a handle is ever unacceptable (it
  isn't here).

### iOS / Android UX conventions
- **Handle, not long-press**, for dual-purpose rows — iOS HIG explicitly: "Use a drag handle when
  the element is also a tap target." Material 3: drag handle (vertical-dots) communicates
  reorderability. Discord uses full-row long-press only because its reorder screen removes the tap
  action first — not our case.
- **Handle on the trailing edge** on both platforms (M3 LTR + iOS UITableView reorder control).
- **Always-visible handle, no edit-mode gate** — right default for a management screen.
- **Haptics**: Light on lift, `selectionChanged`/`selectionAsync` per swap, Medium on drop
  (Apple "Playing Haptics" guidance). Don't fire per-frame.
- **Visual drag state**: elevation/shadow + slight scale (~1.03, iOS) + reflow gap placeholder.
- **Accessibility**: drag is inaccessible to screen-reader/motor users; both Apple and Google
  **require custom "move" actions** on reorderable rows. RN `accessibilityActions` →
  iOS `accessibilityCustomActions` + Android `addAccessibilityAction`. This is *the* accessible
  path (the visible-arrow approach is a weaker, optional extra — and we chose to drop the arrows).

### Sources
- desktop: `quorum-desktop/.../SpaceSettingsModal/Channels.tsx`
- gesture-handler Pan / manual / composition docs (docs.swmansion.com); RNGH issues #1658, #1933, #2885; discussion #1826
- FlashList v2 migration + recycling docs (shopify.github.io/flash-list); Shopify Engineering FlashList v2 post
- npm/GitHub: omahili/react-native-reorderable-list (#62, #63), MatiPl01/react-native-sortables, computerjazz/react-native-draggable-flatlist (#609)
- Apple HIG: Drag and drop, Lists and tables, Playing haptics, Accessibility (custom actions); developer.apple.com
- Material 3: Lists guidelines, interaction states (m3.material.io); Android a11y custom actions (developer.android.com)
- RN docs: accessibility#accessibilityactions (reactnative.dev)

---
*Last updated: 2026-06-17*
