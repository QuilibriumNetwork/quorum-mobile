---
type: task
title: "Composer one-conductor refactor — single position owner for the keyboard↔panel swap"
status: done
created: 2026-06-19
---

# Composer one-conductor refactor — single position owner for the keyboard↔panel swap

**Status:** implemented (single coherent change) — AWAITING DEVICE VERIFICATION
**Branch:** `feat/composer-one-conductor` (off master @ f2efdc6)
**Priority:** medium (kills a recurring regression class; not blocking a release)
**Origin:** [composer-keyboard-emoji-panel.md](../docs/features/composer-keyboard-emoji-panel.md) — the "Recommended target architecture" section. Tracks the durable fix for the drop/gap/bounce-on-swap bug we keep re-hitting.

## Problem (one line)

The composer's on-screen vertical position has THREE uncoordinated owners
(React `bottom: tabBarHeight`, the Reanimated spacer height, the native keyboard
animation). On panel-open they change on different frames → drop / empty-gap /
bounce. See the feature doc for the full diagnosis.

## The key invariant that makes this fixable

The FINAL pill position is identical in the keyboard-up and panel-open states:
both put the pill bottom at `keyboardHeight` from the screen bottom. Today that
sum is split two different ways across the two owners:

| State | overlay `bottom` | spacer height | pill bottom (sum) |
|-------|------------------|---------------|-------------------|
| closed, kb down | `tabBarHeight` | `bottomInset` (0) | `tabBarHeight` |
| closed, kb up | `tabBarHeight` | `kb − tabBarHeight` | `kb` |
| open (panel) | **0** (jumps!) | `kb` | `kb` |

The overlay `bottom` flips `tabBarHeight → 0` un-animated while the spacer
re-derives — same sum, different decomposition, different frames. That swap of
decomposition IS the bug.

## Verified findings (second-pass review, 2026-06-19)

Three subagent investigations confirmed the design and corrected the blast radius:

1. **Geometry (verified):** under edge-to-edge (`edgeToEdgeEnabled: true` in app.json,
   `navigationBarTranslucent` forced true by the keyboard lib), `useReanimatedKeyboardAnimation().height`
   is the full IME inset from the **true screen bottom**, and the keyboard **overlaps**
   the tab-bar zone. So `spacer = max(liveKb, restingChrome)` is geometrically correct.
   `KeyboardAnimationCallback.kt:434` + `useComposerPanel.ts:153`.
2. **`tabBarHeight` is STABLE (verified):** `useBottomTabBarHeight()` (RN bottom-tabs 7.4.7)
   reads `tabBarStyle.height` from context (`= 54 + insets.bottom`), NOT the measured
   rendered bar. Returning `null` from the `tabBar` prop on panel-open does NOT change it.
   So the desync is NOT `tabBarHeight` moving — it's purely the `effectiveChromeHeight =
   panelOpen ? 0 : tabBarHeight` flip applied to an **un-animated `bottom` prop**. Folding
   the stable raw `tabBarHeight` into the worklet has no value to desync. `BottomTabView.tsx:327`.
3. **Coupling is looser than feared (verified):** the bottom-fade gradient depends ONLY on
   the pill's on-screen resting pixel position (not the overlay `bottom`), so it stays
   correct automatically once the spacer compensates — **no fade rework**. The list inset
   (`useChatListBottomInset`) is content-padding only and keeps its existing
   `effectiveChromeHeight` feed. The only things that must change are the worklet formula,
   the overlay constant, and giving the composer the **raw** (non-zeroed) `tabBarHeight`.

**Decision:** go with the single-owner collapse (overlay `bottom: 0`, all clearance in the
spacer) rather than merely animating the overlay `bottom`. The latter removes this symptom
but leaves TWO animated position owners kept in sync by convention; the former ELIMINATES an
owner so the desync is structurally impossible. The review removed most of the collapse's
extra risk (fade + list wiring stay as-is).

## The fix: collapse to one owner (the spacer)

Make the overlay `bottom` a CONSTANT `0` and fold the tab-bar clearance into the
spacer worklet. Then position has a single owner that lives entirely on the UI
thread and changes atomically.

New spacer target in all states (overlay always `bottom: 0`):

| State | spacer height |
|-------|---------------|
| closed, kb down, tab bar visible | `tabBarHeight + bottomInset` |
| closed, kb up | `keyboardHeight` (kb covers the tab bar) |
| open (panel), tab bar hidden | `keyboardHeight` (panel fills to bottom) |
| closing → kb rising | hold `max(liveKb, lastKb)` until kb catches up |

i.e. `spacer = max(liveKeyboard, restingChrome)` where `restingChrome` is the
tab-bar height + safe inset, fading out as the keyboard rises. The keyboard-up
and panel-open states both resolve to `keyboardHeight` with NO decomposition
change, so there is nothing to desync.

Crucially: the tab-bar height becomes just a TERM INSIDE the worklet. When the
panel opens and the bar hides, that term drops on the UI thread in the same
worklet evaluation as everything else — not via a React prop flip on a later
frame.

## Files to change

1. **[hooks/useComposerPanel.ts](../../hooks/useComposerPanel.ts)**
   - Add `tabBarHeight` (resting chrome) as an input the worklet reads. Today the
     hook gets `bottomChromeHeight` (the tab-bar height to SUBTRACT). Re-frame it:
     the worklet should ADD the resting chrome when nothing is up, not subtract it
     from the keyboard.
   - Rewrite the `spacerHeight` `useDerivedValue` to the single formula above.
     Remove the open-vs-closed `bottomChromeHeight` asymmetry (no more "subtract
     when closed, don't when open").
   - Keep `closingSV` and `openedWithKeyboardRef` — the close hand-off is still
     needed for the rising-keyboard-meets-held-footprint case. But its target is
     now `max(liveKb, lastKb)` (no chrome subtraction anywhere).
   - The store publish (`onPanelVisibilityChange`) stays synchronous AND keeps
     driving the tab-bar unmount — but position no longer depends on it.

2. **[components/Chat/ChatBottomChrome.tsx](../../components/Chat/ChatBottomChrome.tsx)**
   - Overlay `bottom` becomes a constant `0` (was `tabBarHeight`). The composer's
     own spacer now reserves the tab-bar clearance.
   - The bottom FADE gradient still needs to cover the composer→tab-bar zone. It
     currently sizes from `tabBarHeight`. Decide: keep the fade sized by the
     resting `tabBarHeight` (it's a static backdrop, doesn't move with the
     keyboard) — the fade is behind the overlay and ignores touches, so it can
     stay where it is. VERIFY it doesn't leave a seam when the pill rides up.

3. **[app/(tabs)/messages/dm/[id].tsx](<../../app/(tabs)/messages/dm/[id].tsx>)** and **[app/(tabs)/spaces/[id]/[channelId].tsx](<../../app/(tabs)/spaces/[id]/[channelId].tsx>)**
   - Today: `effectiveChromeHeight = panelOpen ? 0 : tabBarHeight`, passed to
     BOTH the overlay position AND the composer AND the list inset.
   - After: the composer gets the REAL resting `tabBarHeight` (constant, not
     zeroed on open) because the spacer worklet now handles hiding it. The
     `effectiveChromeHeight` zeroing-on-open hack can largely go away for the
     composer path. The LIST inset (`useChatListBottomInset`) can stay on resting
     `tabBarHeight` — the list doesn't move with the panel.
   - Net: stop threading `panelOpen` into position math. `panelOpen` should only
     drive (a) the tab-bar unmount in the Tabs layout and (b) which content the
     panel shows.

4. **[components/Chat/DMChatArea.tsx](../../components/Chat/DMChatArea.tsx)** / **[SpaceChatArea.tsx](../../components/Chat/SpaceChatArea.tsx)**
   - Update the props they forward (`tabBarHeight`, `bottomChromeHeight`) to the
     new contract. Keep DM and Space IDENTICAL — they must stay in lockstep.

5. **[components/Chat/FarcasterDirectMessageView.tsx](../../components/Chat/FarcasterDirectMessageView.tsx)**
   - It also takes `tabBarHeight` / `bottomInset`. Audit whether it uses the
     composer the same way; bring it along or explicitly note it's out of scope.

## Build sequence (smallest reversible steps)

> **Correction (2026-06-19, during step 1):** a "rewrite the worklet behind the
> existing decomposition" no-op is NOT possible in isolation. The target formula
> (`max(liveKb, restingChrome)`) only produces correct positions when paired with
> overlay `bottom: 0`; with the overlay still at `bottom: tabBarHeight` it would
> double-count the chrome. The formula and the overlay are coupled and must flip
> together. So the safely-stageable split is "plumb the input first (unused),
> then flip formula+overlay together":

> **Update (2026-06-19):** the "plumb-first" no-op intermediate was dropped — it
> needed either a dead variable (lint noise) or a comment referencing internal
> task docs (not visible to other devs). Done instead as ONE coherent change:

1. **DONE — `useComposerPanel.ts`:** replaced the `bottomChromeHeight` SUBTRACT
   option with a `restingChromeHeight` ADD option. Worklet rewritten to the
   single formula: `max(liveKeyboard, restingChrome + bottomInset)`, with the
   panel-open and closing-handoff branches both using `max(...)` and never
   dropping below the resting footprint. Dropped the now-unused
   `keyboardProgress` and the progress-fade term (the `max` subsumes it).
2. **DONE — `ChatBottomChrome.tsx`:** overlay anchored at `bottom: 0` (was
   `bottom: tabBarHeight`). The `tabBarHeight` prop now ONLY sizes the bottom
   fade (still fed the EFFECTIVE/zeroed height).
3. **DONE — both screens:** pass `restingChromeHeight={tabBarHeight}` (RAW,
   stable) alongside the existing `tabBarHeight={effectiveChromeHeight}`
   (zeroed). The fade + list inset keep the effective value; the composer gets
   the raw one. `effectiveChromeHeight` zeroing retained for fade/list (still
   correct + needed).
4. **DONE — `DMChatArea` / `SpaceChatArea`:** added a `restingChromeHeight` prop,
   forwarded to `MessageInput`. Kept DM and Space identical.
5. **DONE — `FarcasterDirectMessageView`:** renamed its `bottomChromeHeight` pass
   to `restingChromeHeight`; screen feeds it the RAW `tabBarHeight`. NOTE: this
   view uses a flex-column layout (NOT the `ChatBottomChrome` overlay), so its
   geometry differs — it needs its OWN device check (see test matrix). If it
   regresses, it may need a different resting value than the overlay screens.

## Test matrix (DEVICE — this cannot be verified statically)

Per the project rule: native/layout behavior needs a real device; static checks
are necessary but not sufficient. Run each in BOTH a DM and a Space (must be
identical), in BOTH light and dark, ideally on a low-end Android + an iOS device:

- [ ] kb up → tap emoji → panel appears in place, NO drop / gap / bounce.
- [ ] panel open → tap emoji (keyboard icon) → keyboard returns, pill holds.
- [ ] panel open → tap the text input → keyboard returns, pill holds.
- [ ] panel open → start typing on a hardware/Bluetooth keyboard → panel closes,
      no jump.
- [ ] open panel with NO keyboard up (e.g. right after entering the screen) →
      panel appears, closes cleanly with no leftover gap.
- [ ] send a message with panel/keyboard up → refocus behaves.
- [ ] rotate device with keyboard up and with panel open.
- [ ] multiline composer (pill grows) interacting with the panel.
- [ ] the bottom fade still reads correctly (no seam) in resting + raised states.
- [ ] tab bar hides on open and returns on close with no flicker.
- [ ] **Farcaster DM specifically** (flex-column layout, not the overlay): pill
      rests above the tab bar, keyboard avoidance works, no overshoot/gap. This
      view is the highest regression risk because its layout differs from the
      overlay-based DM/Space chat areas.
- [ ] resting state on first render: pill floats above the tab bar immediately,
      no start-at-bottom-then-jump (verified statically that `useBottomTabBarHeight`
      resolves synchronously, but confirm visually).

## Watch-outs / do-NOT-regress

- The `closingSV` rising-keyboard hand-off is load-bearing for the close path —
  keep it.
- The module-level `lastSessionKeyboardHeight` seed (fallback 290) keeps the
  first cold open realistic — keep it.
- Do NOT reintroduce any render-timing dependency for position. The whole point
  is that position is UI-thread-only. (This is why the frame-deferred grid mount
  for perf was reverted — see the feature doc.)
- Perf (emoji grid virtualization) is a SEPARATE task
  ([2026-06-16-emoji-panel-open-lag.md](2026-06-16-emoji-panel-open-lag.md)).
  Don't fold it in here; if revisited, gate any deferred mount on a settle event,
  never a frame guess.
- Keep the lightweight `EmojiCell` change already in the working tree (it's safe
  and unrelated to position).

## Out of scope

- Emoji grid virtualization / open-lag perf (separate task).
- Any change to the autocomplete popup, attach/send micro-animations, or the
  pill shape transitions.

*Last updated: 2026-06-19*
