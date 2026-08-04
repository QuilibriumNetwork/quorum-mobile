---
type: bug
title: "Emoji panel cold open no longer lifts the message list"
status: done
priority: medium
ai_generated: true
created: 2026-07-28
updated: 2026-07-28
---

# Emoji panel cold open no longer lifts the message list

> **⚠️ AI-Generated**: May contain errors. Verify before use.

## Symptoms

Tapping the composer's emoji button with NO keyboard up (a "cold open") slides
the composer + panel up, but the message list does not lift with it — the last
message stays hidden behind the panel. Opening the keyboard instead lifts the
list correctly. Confirmed by LaMat on-device 2026-07-28, including on a fresh
chat open (no prior send, keyboard never opened) — so this is NOT caused by the
same-day emoji send-scroll correction in `MessagesList` (that code only runs
when a new message lands, and it is additionally guarded off while
`composerBottomBusySV === 1`).

## Expected mechanism (per code + docs)

See `.agents/docs/composer-keyboard-emoji-panel.md`. Cold-open lift chain:

1. `useComposerPanel` publishes `composerPanelFootprintSV` ramping
   restingFootprint → panelHeight over 220ms (`coldOpenSV` withTiming), with
   `composerListFreezeSV` false (freeze only for opened-FROM-keyboard).
2. `ChatKeyboardScrollView` feeds `extraContentPadding = composerFootprintSV +
composerPanelFootprintSV` to the library.
3. The library's `useExtraContentPadding` reaction
   (`react-native-keyboard-controller@1.21.11`,
   `src/components/KeyboardChatScrollView/useExtraContentPadding/index.ts`)
   scrolls by `effectiveDelta = max(blank, kbPad+extra) − max(blank, kbPad+prev)`
   each frame, unconditionally for `keyboardLiftBehavior="always"`.

Static analysis says every link should fire. The device says otherwise, so one
link is dead in practice — instrumentation added (see below).

## Ruled out

- The 2026-07-28 send-scroll correction in `MessagesList` (doesn't execute on
  panel open; also guarded by `composerBottomBusySV`).
- An `extraContentPadding` prop override in `MessagesList` (none — the
  panel-aware default in `ChatKeyboardScrollView` applies).
- `composerListFreezeSV` stuck true (would also kill the keyboard lift, which
  works).
- PR #150's `useComposerPanel` change (tab-bar busy flag only; the footprint
  publisher, freeze gate, and cold-open ramp are untouched since #119/#120).

## Suspects / timeline

- Doc records the cold-open lift as working (with a small lag) on 2026-06-20.
- `patches/react-native-keyboard-controller+1.21.11.patch` was extended
  2026-07-27 (translucent-modals fix, PR #187): NO-OP-event guard on
  onMove+onStart, `actualOpenShift` cleared in onEnd. Mechanically it should
  not affect a cold open (no keyboard events fire), but this exact patch
  family caused this exact regression once before (2026-06-22 cycle — see the
  warning quoted in
  `.agents/issues/.done/2026-07-27-chat-list-jumps-to-top-regression-translucent-modals.md`),
  and its acceptance sweep covered panel open/close "without drifting" but not
  explicitly the fresh COLD open lift.
- Also unverified since June: flash-list / reanimated version bumps, if any.

## Root cause (diagnosed 2026-07-28 via on-device instrumentation)

The whole chain fires — footprint ramps, freeze off, positive per-frame deltas,
sane targets — but each frame's library scroll target is `scroll.value + delta`,
and on Android `scroll.value` lags several frames behind the library's own
rAF-deferred `scrollTo` calls. Successive small deltas are therefore computed
off the SAME stale base and overwrite each other instead of accumulating.
Measured on-device: inset grew ~173px, list moved 26px (4559 → 4585).

The per-frame deltas exist because PR #120 (2026-06-20 15:20) made the
footprint publisher in `useComposerPanel` track the spacer's cold-open ramp
(`rampedPanel` via `coldOpenSV`). Before that, the footprint published in ONE
step — one big delta off a fresh base — which is exactly the working behavior
the choreography doc describes as "a single deferred correction". The doc was
finalized the same day the ramp landed, and every later test opened the panel
keyboard-first, so the cold-open breakage went unnoticed for five weeks.

## Solution

`hooks/useComposerPanel.ts` — the footprint publisher no longer tracks the
cold-open ramp; it publishes the full panel footprint in one step (the SPACER
keeps its visual 220ms ramp — only the list-inset publisher changed). One step
= one delta = the full lift. Cosmetic cost, as originally shipped and accepted:
the list rises slightly ahead of the panel slide.

The keyboard-first open path is untouched (there `coldOpenSV` was already 1
and the `max(0, panel − liveKeyboard)` continuity math does the work).

**Verification pending on-device** (needs Metro cache reset since node_modules
was touched during diagnosis): fresh chat, keyboard never up, tap emoji → last
message must rise above the panel. Also re-check: open panel FROM keyboard (no
jump), close panel (list settles), send message (scrolls to own message).

**iOS note (untested — only Android devices available):** the stale-base
accumulation is Android's scroll path (rAF-deferred `scrollTo` + lagging
`scroll.value`); iOS sets `contentOffset` atomically, so the per-frame ramp may
have worked there. The one-step publish still lands correctly on iOS (single
delta, fresh base) — the only possible iOS difference is cosmetic: a single
quick lift instead of a possibly-smooth ramped one. Sweep the emoji-panel
transitions on the next iOS test run.

## Prevention

- Any change to the keyboard-controller patch OR the footprint publisher must
  re-run the FULL emoji-panel acceptance sweep including the fresh cold open
  lift (chat opened, keyboard never up, tap emoji → last message rises above
  the panel).
- Never publish a per-frame-ramping value into the library's
  `extraContentPadding`: its scroll correction computes targets from a lagging
  scroll position, so only step changes accumulate correctly on Android.
