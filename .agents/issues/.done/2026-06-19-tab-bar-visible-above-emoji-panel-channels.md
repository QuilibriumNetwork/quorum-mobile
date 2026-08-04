---
type: bug
title: "Tab bar visible above the emoji panel — channels only"
status: done
created: 2026-06-19
---

# Tab bar visible above the emoji panel — channels only

**Status:** ROOT-CAUSED + FIXED 2026-06-20 on branch
`fix/composer-emoji-panel-transitions` (commit "keep tab bar hidden when keyboard
settles after panel opens"). Pre-existing (NOT introduced by the
keyboard-synced-list work).
**Reported:** 2026-06-19 (user, on device — Motorola Edge 50 Fusion, Android).

## Root cause (confirmed 2026-06-20)

`useComposerPanel`'s keyboard-settle handler (`useKeyboardHandler.onEnd`) released
`composerBottomBusySV` UNCONDITIONALLY on `e.height > 0`. The height==0 branch was
already guarded with `panelOpenSV !== 1`, but the height>0 branch was not. In a
slow subtree (the heavier Space/channel composer), the keyboard's settle event
can be DELAYED and land AFTER the user has already tapped emoji → `openPanel` set
`panelOpenSV=1` + `composerBottomBusySV=1`. The late settle then ran the height>0
branch and set `composerBottomBusySV=0` while the panel was open → tab bar visible
over the panel, PERSISTENTLY (nothing re-sets it to 1 until the next open). That
matches every observation: channels (slower subtree → the race), persistent (not a
flash), and rare/non-deterministic (needs the settle to lag past the emoji tap).

## Fix

Guard the height>0 release with `panelOpenSV !== 1`, identical to the height==0
branch. A keyboard settle can no longer release the bottom while the panel owns
it. Also added a separate self-correcting guard (a `useAnimatedReaction`) so the
flag can never be left STUCK in either direction — see
`.agents/issues/.done/2026-06-20-composer-emoji-panel-transitions.md`.

---
## Original investigation notes (pre-root-cause)

## Symptom

When the emoji panel opens in a **Space channel**, the bottom tab bar (`AppTabBar`)
is visible ABOVE the panel. It should be hidden (the panel takes the full bottom).
- Happens in **channels** (`SpaceChatArea`).
- Does **NOT** happen in **DMs** (`DMChatArea`) — at least not reproducibly.
- May be non-deterministic (user couldn't fully confirm DM never shows it).

## What we know

- The tab bar hides itself via `composerBottomBusySV` (UI-thread shared value):
  `opacity: composerBottomBusySV.value === 1 ? 0 : 1`. Set to 1 in
  `useComposerPanel.openPanel`, held across the panel↔keyboard hand-off, cleared
  on settle. See `.agents/docs/composer-keyboard-emoji-panel.md` §AppTabBar.
- `MessageInput` (which owns `useComposerPanel` and sets
  `onPanelVisibilityChange: composerPanelVisibleStore.set`) is SHARED identically
  by DM and Space, so the panel→busy→tab-bar-hide path is the same code.
- Both screens pass `tabBarHeight={effectiveChromeHeight}` (0 when panel open) +
  `restingChromeHeight={tabBarHeight}` — structurally identical wiring.

## Why channels differ from DMs (hypotheses, unverified)

The Space `MessageInput` receives many more props than the DM one (`members`,
`channels`, `roles`, `customEmojis`, `stickers`, `space`, `castReplyAvailable`,
…). Candidate causes:
1. A heavier Space composer subtree mounts/commits slower, so on panel-open the
   `composerBottomBusySV=1` write or the tab-bar opacity worklet lands a frame
   late relative to the panel appearing — a transient where the bar shows.
2. The Space channel screen re-renders the tab bar / `effectiveChromeHeight`
   differently (it reads `useComposerPanelVisible()`), and some channel-only
   state nudges the timing.
3. A genuinely different mount path in `SpaceChatArea` (e.g. the read-only-banner
   branch, pinned-messages panel) interferes.

## Next steps to root-cause

- Raise the shared logger above its default `minLevel` and instrument
  `composerBottomBusySV` set/clear + the tab-bar opacity worklet; open the panel
  in a channel vs a DM and compare timing.
- Check whether it's a transient (bar flashes for a frame then hides) vs.
  persistent (bar stays visible the whole time the panel is open). The doc's
  `bottomBusy`-spans-the-handoff design is meant to prevent the transient; a
  PERSISTENT bar points at the busy flag never being set (or being cleared early)
  on the channel path specifically.
- Confirm on DM whether it truly never happens (rule out non-determinism).

## Scope note

Deliberately NOT fixed on `feat/keyboard-synced-chat-list` — that branch is a
focused list-scroll architecture change, and fixing an unrelated pre-existing
choreography bug there would muddy both. Fix as its own task once root-caused.

*Last updated: 2026-06-19*
