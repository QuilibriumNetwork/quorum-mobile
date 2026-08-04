---
type: bug
title: "Composer sits under the tab bar on chat entry, then snaps up"
status: open
created: 2026-08-01
---

# Composer sits under the tab bar on chat entry, then snaps up

**Status:** OPEN · not reproduced on demand · **supersedes**
`.solved/2026-06-20-composer-drops-behind-tab-bar-during-slow-chat-load.md`,
whose conclusion ("dev-only Metro artifact, absent in release") is now DISPROVEN.
**Reported again:** 2026-08-01 — seen repeatedly on the LIVE build, and the user
confirms it also happens on dev; it just would not reproduce on demand that day.

---

## Symptom

Entering a DM or channel, the composer pill sits too low — partly behind the
bottom tab bar. About a second later it snaps up to its correct resting position.
Intermittent.

## Ruled out 2026-08-01 (from installed source — do not re-investigate)

- **`useBottomTabBarHeight()` cannot produce a transient.** In
  `@react-navigation/bottom-tabs@7.4.7`, `BottomTabView` holds it in a
  `useState` **initializer** (`getTabBarHeight({... style: tabBarStyle})`), and
  with a custom `tabBar` prop nothing ever calls `setTabBarHeight`. It is a
  constant for the app's lifetime. If it were wrong it would be wrong
  permanently, not for one second.
- **The spacer is correct in frame one.** Reanimated 4.1.1's `useDerivedValue`
  computes its initial value synchronously on the JS thread via
  `initialUpdaterRun` (`lib/module/hook/useDerivedValue.js`), and `useAnimatedStyle`
  does the same for its initial style. So `spacerHeight` is
  `restingChromeHeight + bottomInset` from the first render.
- Confirmed by the probe below on a healthy entry: `spacer=102 resting=102
  clearance=102` at t=0, and no change for the following 2.5s.

That leaves the remaining hypothesis from the 2026-06-20 file: the ENTERING
screen's own frame during the Android native-stack `slide_from_right`. The probe
discriminates it in one line — see "What the numbers mean".

## Re-instrumenting (the probe, verbatim)

Kept here because the branch it lived on was squash-merged and deleted. Paste
into `components/Chat/MessageInput.tsx`.

Add to the existing reanimated import:
`useAnimatedRef, useFrameCallback, useSharedValue, measure, runOnJS`

At module scope:

```ts
function logPosDiag(line: string) {
  console.warn(line);   // console.log does NOT reach adb logcat; warn does
}
```

Inside the component, just before `return (`:

```ts
const pillProbeRef = useAnimatedRef<View>();
const probeStartedAt = useSharedValue(0);
const probeLastLine = useSharedValue('');
const probeWindowH = useWindowDimensions().height;
useFrameCallback((frame) => {
  'worklet';
  if (probeStartedAt.value === 0) probeStartedAt.value = frame.timeSinceFirstFrame;
  const elapsed = frame.timeSinceFirstFrame - probeStartedAt.value;
  if (elapsed > 2500) return;              // entry window only
  const m = measure(pillProbeRef);
  if (m === null) return;
  // The measured box is the whole composer (footprint + spacer) and its bottom
  // IS the screen bottom, so the PILL's bottom is pageY + height - spacer.
  const spacerNow = composerPanel.spacerHeight.value;
  const clearance = Math.round(probeWindowH - (m.pageY + m.height - spacerNow));
  const line =
    'spacer=' + Math.round(spacerNow) +
    ' resting=' + Math.round(restingChromeHeight + bottomInset) +
    ' clearance=' + clearance +
    ' pageY=' + Math.round(m.pageY) + ' h=' + Math.round(m.height) +
    ' win=' + Math.round(probeWindowH);
  if (line === probeLastLine.value) return;   // log transitions only
  probeLastLine.value = line;
  runOnJS(logPosDiag)('[posdiag] t=' + Math.round(elapsed) + ' ' + line);
});
```

And put the ref on the root view: `<View style={[styles.container, containerDynamicStyle]} ref={pillProbeRef} collapsable={false}>`

Read with `adb logcat -d | grep posdiag`. It is silent while healthy, so it can
be left in during normal use to catch an intermittent fire.

**Crash warning:** an earlier attempt crashed the app with NO JS error by calling
`runOnJS` with six positional args from a worklet. Pass ONE pre-serialised
string. Do not fan out.

**Why this shape and not `onLayout`:** `onLayout` reports only React-committed
layout and **never fires at all for a Reanimated-driven height**, so it is blind
to the bad frame. Every probe in the June investigation was an `onLayout` probe,
which is why they all reported "correct" while the bug was on screen.

## What the numbers mean

- **`clearance` short** (e.g. 54 where `resting` says 102) → the composer really
  is low; the spacer or the resting height is wrong.
- **`clearance` equals `resting` while the pill still LOOKS low** → the composer
  is fine and the SCREEN's frame extends below the visible window. That is the
  Android entering-transition inset theory, and nothing inside the composer can
  fix it. Fix options (JS Stack, inset latch) are weighed in the 2026-06-20 file.

*Last updated: 2026-08-01*
