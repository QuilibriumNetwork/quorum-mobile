---
type: bug
title: "Messages jitter when swapping between the keyboard and the emoji panel"
status: open
created: 2026-08-01
---

# Messages jitter when swapping between the keyboard and the emoji panel

**Status:** OPEN · **confirmed PRE-EXISTING on master** (A/B'd on device 2026-08-01)
**Reported:** 2026-08-01
**Affects:** DM and Space channel chat (both render `MessagesList` + `MessageInput`)
**Related:** [composer-keyboard-emoji-panel.md](../../docs/composer-keyboard-emoji-panel.md) ·
[2026-08-01-short-chat-last-message-hidden-behind-composer.md](../.done/2026-08-01-short-chat-last-message-hidden-behind-composer.md)

---

## Symptom

With the keyboard up, tap the emoji button (or the reverse: with the panel open,
tap the input). The messages sitting above the composer **visibly scroll up and
down once** — a fast adjustment, then it settles. Intermittent; the severity
varies by channel.

## It is NOT a regression — do not re-attribute it

This was twice mistaken for a fresh regression, both times because it was noticed
right after unrelated work landed. **Verified on device 2026-08-01 by checking out
`master` and repeating the exact swap in `# Test` (Cross device test): master
flickers too.**

What that A/B also established, and what should not be re-litigated:

- **Messages DISAPPEARING on panel open is a different, separate defect.** It does
  NOT happen on master. It was introduced by commit `73de6b8` (a `bottomInset`
  dependency reached `ScrollComponent`'s `useMemo`, and FlashList remounts the
  scroll view when its scroll component type changes). That commit was reverted.
- The **panel's own geometry** (pill above panel, panel filling to the screen
  bottom) is identical on master and on the fix branch, and reads as correct on
  inspection. It is not part of this bug.

## What is known about the mechanism

On master there is only ONE scroll driver during the swap — the keyboard library
— so this is inside `useChatKeyboard` / `useExtraContentPadding`, not in app code.

`useExtraContentPadding` reacts to changes in `extraContentPadding` and scrolls by
`effectiveDelta = currentTotal − previousTotal`, where
`total = max(blankSpace, keyboardPadding + extraContentPadding)`. The swap is
supposed to be continuous: `useComposerPanel` publishes the panel footprint as
`max(0, panelHeight − liveKeyboard)` precisely so that as the keyboard slides out
the panel footprint ramps in by exactly what the keyboard padding drops (see the
design doc, "No double-count on the swap"). **A jitter is what an imperfect
cancellation between those two ramps would look like** — the total overshoots or
dips for a few frames, and the library faithfully scrolls to match.

### Strongest lead: the panel footprint measures ~2× a keyboard height

Measured on device (Motorola Edge 50 Fusion, `# Test`), via temporary
`[chatdiag]` instrumentation on `onContentInsetChange`:

```
keyboard open, panel closed:   inset 280      (kb ≈ 382, extra ≈ −102)
panel open (master/fallback):  inset 826
panel open (structural build): inset 766
```

With the keyboard down, the inset should settle near `panelHeight + pill + gap`.
`826 − 60 (pill) = 766`, against a real keyboard height of ~382 — i.e. the panel
footprint reads roughly **double** what it should. If the panel footprint is
inflated, the swap's two ramps cannot cancel, which is exactly the shape of this
bug.

Where to look first:

- `composerFootprintSV`, `composerPanelFootprintSV` and `composerListFreezeSV` are
  **module-scope** `makeMutable` shared values (`services/ui/composerFootprint.ts`)
  — one set of globals for the whole app. expo-router keeps previously visited
  chat screens MOUNTED, so more than one `MessageInput` can be alive and writing
  the same three values. A Farcaster DM had been visited earlier in the session
  where these numbers were taken. If two composers are both publishing, the
  values are whatever wrote last — or worse, they fight per frame.
- `useComposerPanel`'s `useAnimatedReaction` that publishes
  `max(0, panelHeight − liveKeyboard)`, and whether `lastKeyboardHeight` is what
  it should be at that moment.

## Reproduction

1. Open a Space channel or DM (seen in both; `# Test` in *Cross device test* works).
2. Tap the composer → keyboard rises.
3. Tap the emoji button → panel replaces the keyboard.
4. Tap the composer again → keyboard returns.
5. Repeat — it does not fire every time.

## How to instrument it

Do NOT eyeball this; it is a few frames long. Two tools, both proven on
2026-08-01:

- **A numeric signal.** Log `onContentInsetChange` from `MessagesList`'s
  `ScrollComponent` with `console.warn` (NOT `console.log` — that does not reach
  `adb logcat`; `console.warn` surfaces as `W ReactNativeJS`). Tag it and read it
  with `adb logcat -d | grep <tag>`. A continuous swap shows a monotonic inset;
  this bug should show a non-monotonic one.
- **Frame-accurate video.** `adb shell screenrecord --time-limit 4 //sdcard/x.mp4`,
  pull it, then
  `ffmpeg -i x.mp4 -vf "fps=30,crop=1080:520:0:1750" f_%03d.png` and tile the
  frames. This is how the entry flicker was timed to ~4 frames.

Note for Git Bash on Windows: remote adb paths need a leading `//` (`//sdcard/x.mp4`)
or they get mangled into a Windows path.

## Do not start by patching `MessagesList`

The short-chat fix already had to be gated OUT of this window
(`cefbfb8` — it now only acts at rest) precisely because adding a second scroll
driver on top of the library's made this worse. Any fix here belongs in the
footprint publishing or in how the swap ramps cancel, not in a second corrective
scroll.

*Last updated: 2026-08-01*
