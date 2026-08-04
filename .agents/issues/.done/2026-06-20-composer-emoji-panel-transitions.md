---
type: task
title: "Composer ↔ keyboard ↔ emoji-panel: transition robustness pass"
status: done
created: 2026-06-20
---

# Composer ↔ keyboard ↔ emoji-panel: transition robustness pass

Branch: `fix/composer-emoji-panel-transitions` (off origin/master).

Goal: make every composer/keyboard/emoji-panel transition solid and kill the
edge cases the user reported on device (Motorola Edge 50 Fusion, Android,
**production variant** — so not a dev-only artifact).

Read first: `.agents/docs/composer-keyboard-emoji-panel.md` (the design) and the
two memories `composer-panel-three-position-owners` +
`prod-build-verifies-dev-only-glitches`.

## Reported issues

1. **Scroll wobble on keyboard mount.** Focus composer → keyboard mounts → list
   scrolls up to show the last message (correct) but the scroll is not
   super-smooth, it "wobbles" slightly. (Note: device shows VRR refresh-rate
   switching 45Hz↔0 in logcat during the slide — may contribute.)

2. **Page scrolls DOWN when emoji panel opens from keyboard.** Keyboard up → tap
   emoji → panel appears in the keyboard's place (correct) → but the message list
   scrolls DOWN (wrong; should hold position).

3. **Empty space below last message after keyboard re-mount from panel.** From #2
   state, tap the keyboard button to bring the keyboard back → list scrolls up a
   bit → ends with a lot of empty space below the last message.

4. **Tab bar disappears (PROD).** During composer/emoji/keyboard interaction the
   `AppTabBar` vanishes entirely, then reappears later after more interaction.
   Non-deterministic. CONFIRMED tied to composer interaction. No native
   crash/exception in logcat → pure JS-state logic bug.

5. **Cold emoji-panel open has no slide-in.** Opening the emoji panel directly
   (composer not focused, no keyboard up) makes the panel just *appear* — no
   smooth animation. When transitioning FROM a mounted keyboard it's smooth (the
   keyboard slides away revealing the already-painted panel). The keyboard itself
   slides in via the OS; the cold panel-open has nothing equivalent.

   Related companion bug doc: `.agents/issues/.done/2026-06-19-tab-bar-visible-above-emoji-panel-channels.md`
   (tab bar visible ABOVE panel in channels — the OPPOSITE direction of #4;
   same root subsystem: `composerBottomBusySV` lifecycle).

## Root-cause analysis

### #4 + the channels bug: `composerBottomBusySV` is a fragile manual latch

The tab bar hides itself with ONE rule:
`opacity: composerBottomBusySV.value === 1 ? 0 : 1` (AppTabBar.tsx:347).

`composerBottomBusySV` is set to 1 in `openPanel()` and must be cleared on EVERY
exit. Clears live in: `onEnd(height>0)`, `onEnd(height==0 && !panelOpen)`,
`closePanel()`, `closePanelAndRestoreKeyboard()` no-keyboard branch.

Two hand-off paths set `panelOpenSV=0` + `closingSV=1` and then RELY ON the
keyboard `onEnd(height>0)` firing to clear busy:
- `onInputFocus()` (tap text field while panel open)
- `closePanelAndRestoreKeyboard()` keyboard branch (tap keyboard button)

If the summoned keyboard never settles with height>0 (focus race, keyboard
already up so no fresh onEnd, OS quirk), busy stays 1 forever → **tab bar stuck
hidden** (= #4). The reverse (busy stuck-or-late on a heavier channel subtree) is
the channels "bar visible above panel" bug. Both are the same brittleness: bar
visibility derives from a hand-latched flag with N exit paths instead of from
observable state.

**Fix direction (chosen): make tab-bar visibility self-correcting.** Keep busy
for the hand-off bridge, but reconcile it against the truth: the bar must be
hidden IFF (panel is open) OR (a keyboard is essentially up AND we're mid
hand-off). Add a `useAnimatedReaction`/derived guard in `useComposerPanel` that
forces `composerBottomBusySV = 0` whenever `panelOpenSV === 0 && closingSV === 0`
(no panel, no hand-off in flight = nothing can legitimately hold the bottom).
That converts "must remember to clear" into "can't stay stuck": any settled state
with no panel + no hand-off self-heals to bar-visible. Cheap, UI-thread, additive.

### #2 + #3: the panel footprint vs keyboard padding mismatch on the list

List bottom inset = `max(blankSpace, keyboardPadding + extraContentPadding)` where
`extraContentPadding = composerFootprintSV + composerPanelFootprintSV`
(ChatKeyboardScrollView.tsx).

- Keyboard up: inset = `kbHeight + F` (F = pill footprint; panelFootprint 0).
- Panel open: `composerPanelFootprintSV` jumps INSTANTLY to
  `spacerHeight = max(lastKb, restingFootprint)` the moment `panelOpenSV=1`
  (useAnimatedReaction), while `keyboardPadding` ANIMATES kbHeight→0 over ~250ms.
  During the dismiss: inset transiently = `kbHeight + F + lastKb` (~double) then
  settles to `F + lastKb`. The settling path is the visible jump (#2).
- #3 empty space: after re-summoning the keyboard, the inset is briefly
  `keyboardPadding(rising) + F + panelFootprint(still lastKb until closingSV
  clears)` — panel footprint and keyboard BOTH counted → over-inset → empty space
  below the last message until `onEnd` clears closingSV and the panel footprint
  drops.

**Fix direction:** the panel footprint and the keyboard padding must never BOTH
be counted for the same vertical zone. Options:
  (a) Publish `composerPanelFootprintSV` as `max(0, panelHeight - liveKeyboard)`
      so as the keyboard slides the panel footprint ramps in continuously and the
      sum stays ≈ constant (no double-count, no jump). Symmetric on re-summon.
  (b) Gate the panel footprint on the keyboard being actually down.
Prefer (a): it's continuous on the UI thread and self-cancels both #2 and #3.

### #5: cold panel-open has no animation

`openPanel()` from a cold composer: `panelOpenSV=1` instantly → `spacerHeight`
jumps from `restingFootprint` to `lastKb` in one frame, and `panelVisibleSV`
flips 0→1 instantly. There's no slide. When opened from a keyboard the *keyboard*
provides the motion (OS slide reveals the painted panel).

**Fix direction:** when opening cold (no keyboard up), drive the spacer from
`restingFootprint` to the panel height with a `withTiming` (or spring) so the
panel slides up like a keyboard would. MUST be gated to the cold-open case only —
the keyboard-handoff path must stay driven by the live keyboard value (animating
it there would fight the OS keyboard, reintroducing the documented bounce). Use
an `openingColdSV` flag + `withTiming` on the target only when no keyboard was up
at open.

### #1: wobble

Lowest-confidence. Candidates: VRR rate switching mid-slide (logcat-confirmed
the panel switches 45Hz↔0), or `scrollEventThrottle={64}` interacting with the
native keyboard lift, or the FlashList autoscroll effect firing during the lift.
Investigate AFTER 2-5 land (they may change the timing). Do not chase invasively.

## Plan / order

1. #4 self-correcting tab-bar guard (highest user impact, lowest risk, additive).
2. #2/#3 panel-footprint continuous ramp (one formula change in useComposerPanel).
3. #5 cold-open slide (gated, additive).
4. #1 wobble — measure, then decide.

Each change verified on the prod variant before the next (these are prod-visible,
not dev artifacts).

*Last updated: 2026-06-20*
