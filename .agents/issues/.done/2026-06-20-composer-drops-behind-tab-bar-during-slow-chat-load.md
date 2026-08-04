---
type: bug
title: "Composer pill drops behind the tab bar during slow chat load"
status: done
created: 2026-06-20
---

# Composer pill drops behind the tab bar during slow chat load

**Status:** SOLVED (dev-only artifact) — VERIFIED 2026-06-20 in a RELEASE build: the glitch
does NOT reproduce in production. The composer sits in the correct resting position. Several
OTHER small dev glitches also disappeared in release, and the build runs noticeably faster.
This confirms the "deferred first React commit in DEV (Metro JIT)" root cause below — no
production layout bug exists, so no invasive nav change (Option B/C) is needed. The hardened
prefetch (Option A, in tree) is kept as a strictly-better dev-stall removal, not a prod fix.

> Wording note: "cause is evidenced" ≠ "fix is confirmed." The cause was established by
> elimination + timing correlation, then CONFIRMED by direct observation in a release build
> (the decisive test — glitch absent in prod).
**Reported:** 2026-06-20
**Verified (release build):** 2026-06-20
**Affects:** DM and Space channel chat screens (both use `MessageInput` inside `ChatBottomChrome`)
**Branch:** `fix/composer-resting-position-stale-tabbar-height`

---

## ⭐ ROOT CAUSE — STRONGLY EVIDENCED 2026-06-20 (read this first; fix still UNTESTED)

It is a **documented Android native-stack + edge-to-edge transition issue**, NOT a composer
bug. Plain-language version:

- The channel/DM screen slides in with a native `slide_from_right` animation.
- During that slide, Android has BOTH the old and new screen on screen at once. By an
  Android rule, the OLD screen "claims" the safe-area insets, so the NEW (entering) screen
  is told its bottom inset is **0** until the slide finishes.
- With bottom-inset = 0, the entire content area below the header is laid out as if the
  screen ends ~`insets.bottom` px higher than it really does. So EVERYTHING above the tab
  bar — composer, its margins, AND the message area — sits LOW.
- When the slide completes, Android re-sends the correct insets, the layout corrects, and
  it all "snaps" up. That snap happens to coincide with messages appearing, which is why it
  looked message-related (it isn't).

**Confirmed on-device** via Android "Show layout bounds": the user saw the WHOLE area above
the tab bar (composer + its margins + the message area) sitting low and snapping to correct
exactly when the slide-in completes + messages render. This is why every JS probe showed
"correct" — `onLayout` only fires AFTER the transition, once insets are already fixed.

This is New Architecture (Fabric = ON, verified in app.json + gradle.properties), which the
docs note WIDENS the snap window.

**Documented sources (via web-research agent, 2026-06-20):**
- Android Fragment-transition inset dispatch (root cause): Chris Banes,
  medium.com/androiddevelopers/windows-insets-fragment-transitions-9024b239a436
- `useSafeAreaInsets()` returns 0 during NativeStack animation; `initialWindowMetrics` does
  NOT fix it: react-native-safe-area-context issue #556.
- react-navigation "Supporting Safe Areas": "If a screen containing safe area is animating,
  it causes jumpy behavior." reactnavigation.org/docs/handling-safe-area
- Animated.View inside native-stack Android screen destabilizes layout; JS Stack fixes it:
  react-native-screens issue #2856.

**Why my earlier "fixes" all failed:** they targeted the composer's spacer / tab-bar height
/ lazy-import timing. The real problem is the SCREEN's frame during the transition, upstream
of all of that. The composer is just one of many things riding the wrong frame.

### Fix options (decision pending — user wants to weigh slowly)

Constraint: the user WANTS to keep the slide animation (good UX; also the foundation for a
future edge-swipe from space → last-visited channel). So options that kill the slide are out.

- **A. Accept for now, verify in a RELEASE build first (agent's lean).** Fabric layout jank
  is worse in debug; the artifact may be milder/absent in production. Don't do an invasive
  nav change for a possibly-debug-only cosmetic glitch until confirmed in release. Prod-
  variant build plan already written: `.agents/tasks/2026-06-20-production-variant-build-
  for-composer-verification.md`.
- **B. JS Stack for the chat screens** (@react-navigation/stack instead of native-stack):
  confirmed to keep a slide while keeping insets stable. Cost: worse native perf, different
  gesture model (may complicate the future edge-swipe), regression risk on delicate chat UI.
- **C. Inset-latch (uncertain):** make the entering chat screen use a stable bottom inset
  instead of the transient 0, without changing the navigator. May not be possible since the
  cause is the fragment FRAME, not a JS inset read. Needs a bounded investigation.
- (Rejected) Lift composer to a root overlay — fixes only the composer, not the message
  area, so wrong scope. (Rejected) Disable the slide — user wants to keep it.

DO NOT pick yet. Weigh A/B/C with the user, slowly, in plain terms.

## Symptom

When opening a DM or channel, the floating composer pill sometimes sits **too low** —
partially **behind/under the bottom tab bar** (`AppTabBar`), with the bar's top edge
overlapping the lower part of the pill. It **snaps up** to the correct resting position
(floating above the bar with a small gap) only once the chat finishes loading.

- Intermittent. Correlates with a slow chat load.
- No spinner shown during the slow window (separate observation — see below).
- Correct resting position: pill floats above the tab bar with a small gap.
- Bug position: pill lower, partially hidden behind the bar.

## Architecture recap (how the composer is positioned)

See `.agents/docs/composer-keyboard-emoji-panel.md` for the full design.

- The composer overlay is anchored at `bottom: 0` in `ChatBottomChrome`
  (`components/Chat/ChatBottomChrome.tsx`), `position: absolute`, child of `chatArea`
  (`flex: 1`) inside `SpaceChatArea` / `DMChatArea`.
- The pill's on-screen height above the bottom is owned SOLELY by an animated spacer:
  a `Reanimated.View` under the pill whose `height` = `spacerHeight` (a
  `useDerivedValue` worklet in `hooks/useComposerPanel.ts`).
- At rest: `spacerHeight = max(liveKeyboard /*0*/, restingChromeHeight + bottomInset)`.
  `restingChromeHeight` = `useBottomTabBarHeight()` from the screen.
- The `MessageInput` container is a column `[footprint(pill)] [spacer]`, anchored at
  `bottom: 0`, so it grows UPWARD: pill sits `spacerHeight` px above the screen bottom.

## Investigation log

### Hypothesis 1 (WRONG, reverted): stale `useBottomTabBarHeight()`

Theory: with a custom `tabBar` (`AppTabBar`), RN's own `BottomTabBar.onLayout` never
fires, so `BottomTabBarHeightContext` is frozen at its `useState` initializer value
(computed from `SafeAreaProviderCompat.initialMetrics`, a static snapshot). On a cold
mount the bottom inset hadn't resolved → frozen value too small → composer too low.

Fix attempted: `AppTabBar` reports its real footprint via
`BottomTabBarHeightCallbackContext` in an effect keyed on `insets.bottom`.

**Result: changed nothing.** Reverted.

**Disproven by instrumentation** (temporary logs in `useComposerPanel.ts`):
```
[composer] props  {"restingChromeHeight":102,"bottomInset":0}   // correct from first render
[composer] spacer {"h":102,"live":0,"resting":102,"panel":0,"closing":0}  // never dips
```
`restingChromeHeight` was 102 and stable the whole time; the spacer worklet resolved to
102 immediately and never dropped. So the position LOGIC is correct — the JS value is
right from frame 0.

### Hypothesis 2 (WRONG): Reanimated commits spacer height 0 before first worklet commit

Theory: the spacer `Reanimated.View` has no static height, so before Reanimated commits
the derived value to the native view, it defaults to 0 → pill drops. The heavy mount
(Metro compiling lazy chunks: SpaceSettingsModal, InviteModal, UserProfileModal,
hubLogSync) delays the native commit.

Fix attempted (CURRENTLY IN TREE): seed a static base height on the spacer view:
`<Reanimated.View style={[{ height: restingChromeHeight + bottomInset }, spacerAnimatedStyle]}>`
in `components/Chat/MessageInput.tsx`.

**Result: NOT fixed.** Counter-reasoning: `useAnimatedStyle` runs its worklet once
synchronously on first render, so `spacerAnimatedStyle` already carries `{height:102}`
from frame 0 and overrides the static base anyway. So the spacer was likely never the
view at 0 — consistent with the logs showing `h:102` throughout.

### Native-layout probes (onLayout) — all FINAL values correct

Added `onLayout` probes to spacer / overlay / chatArea. Reproduced; logs:
```
[composer] CHATAREA native layout {"y":0,"h":866}     // full screen — correct
[composer] OVERLAY  native layout {"y":700,"h":167}   // bottom edge 700+167=867 — correct
[composer] SPACER   native layout {"y":65,"h":102,"seed":102}  // 102 — correct
```
All three measured CORRECT. Note the probes fire only AFTER the heavy bundling lines —
i.e. once layout has resolved. The bad frame happens BEFORE these fire, during JS-thread
starvation. So it's not a layout-VALUE bug; it's a first-PAINT timing bug.

### ROOT CAUSE (confirmed)

The spacer height comes from `spacerAnimatedStyle = useAnimatedStyle(() => ({ height:
composerPanel.spacerHeight.value }))`. `spacerHeight` is a `useDerivedValue` depending on
the keyboard SharedValue (`useReanimatedKeyboardAnimation`), computed on the UI thread
ASYNCHRONOUSLY. On the FIRST synchronous render, `useAnimatedStyle` evaluates its worklet
on the JS thread to produce the initial committed style — and at that instant
`spacerHeight.value` reads **0** (the derived worklet hasn't run on the UI thread yet).

So the first painted frame has spacer height **0** → the `bottom:0` overlay is only the
pill's 65px tall → the pill sits in the bottom 65px → behind the tab bar. Once the
UI-thread derived value lands (102), the spacer grows and the pill snaps up. On a heavy
chat mount (JS thread blocked compiling lazy chunks) that first commit is delayed, so the
0-height frame is visible for a noticeable beat.

Why Hypothesis-2's static base style failed: `[{height:102}, spacerAnimatedStyle]` — the
animated style is LAST and initializes to `{height:0}`, so 0 overrode the static 102.

### FIX (in tree)

Floor the height INSIDE the worklet with the plain JS prop (available synchronously on the
first evaluation), so the initial committed style is never 0:
```js
const spacerRestingHeight = restingChromeHeight + bottomInset;
const spacerAnimatedStyle = useAnimatedStyle(() => ({
  height: Math.max(composerPanel.spacerHeight.value, spacerRestingHeight),
}));
```
The worklet already does `Math.max(..., restingFootprint)`, so flooring here only guards
the initial-0 frame; keyboard/panel heights are always >= resting, so it never fights the
real value. Reanimated v4 (`4.1.1`) evaluates the `useAnimatedStyle` worklet once on the
JS thread at mount for the initial style — so `Math.max(0, 102)=102` is what gets painted
in frame one.

### FIX ATTEMPT FAILED — not the (whole) cause

Reproduced again with the floor in place. Still drops. Logs IDENTICAL to before:
```
[composer] CHATAREA native layout {"y":0,"h":866}
[composer] OVERLAY  native layout {"y":700,"h":167}
[composer] SPACER   native layout {"y":65,"h":102,"seed":102}
```

Key new observations from the identical logs:
- **Each view logs `onLayout` EXACTLY ONCE, at the correct value.** If the spacer were
  going 0 → 102 in React's layout, we'd see TWO spacer layout events (one at 0, one at
  102). We see only one, at 102. => React NEVER commits a 0-height frame. The
  spacer-initial-0 theory (Hyp 3) is therefore also wrong — or at least invisible to
  React layout.
- All probes fire AFTER all `Android Bundled` lines, i.e. after layout resolves. The bad
  frame precedes them.

Conclusion: the misposition is NOT in React's layout/commit at all. It is a **native**
first-paint/transition artifact that JS `onLayout` cannot observe. The channel screen
uses a NATIVE `animation: 'slide_from_right'` (Android, in `app/(tabs)/spaces/_layout.tsx`)
— but that's a HORIZONTAL transform, so it doesn't explain a VERTICAL drop. Ruled out as
the direct cause.

Hypotheses NOT yet ruled out (native layer, invisible to onLayout):
1. The keyboard-controller / edge-to-edge native layer applies the bottom inset or
   keyboard frame late, transiently shifting the absolute overlay.
2. A native transform/inset on the overlay or its ancestor during the stack transition.
3. The pill seen "behind the bar" is painted by the OUTGOING/intermediate native frame of
   the transition before React's first commit lands.

Next step: stop using `onLayout` (only fires on committed layout). Instead log the spacer
SharedValue on the UI THREAD at high frequency (useFrameCallback / useAnimatedReaction on
spacerHeight) to see the value timeline natively, AND get a precise visual description of
the bad frame (does it slide in low? blink low then up? appear low only while the header
is still drawing?) to discriminate the three native hypotheses.

### Attempted fixes so far (all currently reverted EXCEPT the worklet floor)
1. AppTabBar reports real height via BottomTabBarHeightCallbackContext — REVERTED.
2. Static base height `{height: spacerRestingHeight}` under animated style — REVERTED
   (animated style's initial 0 overrode it).
3. Floor inside the worklet `Math.max(spacerHeight.value, spacerRestingHeight)` — IN TREE,
   but did NOT fix. Keep or revert TBD after we identify the native cause.

**Probes still in tree** (MessageInput spacer, ChatBottomChrome overlay, SpaceChatArea
chatArea). Remove all once the real cause is fixed + verified.

### KEY VISUAL DETAIL (from user) + the onLayout blind spot

User: "The pill is sliding in and it's already low. The pill snaps back to position AS SOON
AS THE MESSAGES APPEAR in the chat." => the correction is tied to the MESSAGE-LIST RENDER,
not the slide animation end and not the header.

Reconciling with "onLayout fired once at the correct value":
**`onLayout` does NOT fire for Reanimated-driven height changes.** Reanimated mutates the
native view's `height` via its own animated node, bypassing React's layout/commit, so
`onLayout` only ever reports the INITIAL React-committed height — it is BLIND to the
UI-thread value timeline. So the single `SPACER {h:102}` event tells us only the initial
React commit, NOT what the spacer was during the bad frame. The earlier "spacer is
provably 102 the whole time" conclusion was based on a probe that cannot see the bad frame.

Measured geometry (screen h=866, restingChrome=102): correct resting puts the pill bottom
at ~y765 and the tab bar at y764–866 — i.e. the pill rests ~flush on the bar. So even a
small spacer shortfall during the bad frame drops the pill INTO the bar zone. Consistent
with "slightly behind the bar."

Leading theory now: during the slide-in / before the UI-thread worklet commits, the
spacer's React-committed `height` is effectively 0/auto (its content, the emoji panel, is
unmounted or opacity-0 → auto-height collapses), so the pill sits low. When the JS thread
frees up (which coincides with messages rendering), Reanimated commits the real height and
it snaps up. The "snaps when messages appear" is the JS thread unblocking, not the data.

### Test round 4 — prong 1 CRASHED the app, removed

Prong 1 (`useAnimatedReaction` on `spacerHeight` with `runOnJS(console.log)(...6 args)`)
CRASHED the app on DM/channel entry with NO JS-console error — a UI-thread worklet fault
(runOnJS doesn't marshal 6 positional args reliably; and/or capturing the non-shared JS
values into the worklet). REMOVED. Lesson: UI-thread debug logging must use a single
serialized payload and avoid `runOnJS` arg fan-out. Crash was pure JS/worklet — JS reload
fixes it, NO native rebuild needed.

### Test round 4 — prong 2 (IN TREE, crash-safe)
`minHeight: spacerRestingHeight` static style on the spacer view. Unlike `height`
(overridden by the animated height, incl. its initial 0), `minHeight` floors the box
independently — guarantees >=102 even before/while the animated height is 0/auto. If this
kills the drop, the cause is confirmed as the spacer collapsing pre-commit, and minHeight
is the fix. Verified visually (does the pill still drop?), no UI-thread log needed.

Safe state in tree: `minHeight` floor + worklet `Math.max` floor in MessageInput, plus the
3 harmless `onLayout` probes. `useComposerPanel.ts` reverted to committed state.

### Test round 4 prong 2 RESULT: minHeight did NOT fix it

Reproduced again. Layout STILL correct and identical:
```
[composer] CHATAREA {"y":0,"h":866}
[composer] OVERLAY  {"y":700,"h":167}
[composer] SPACER   {"y":65,"h":102,"seed":102}
```
=> The SPACER is conclusively NOT the dropping element. Ruled out 3 independent ways:
worklet value, static `height` seed, `minHeight` floor — none changed anything, and the
overlay always measures correct.

### ROOT CAUSE (now confident): deferred first React commit in DEV (Metro JIT)

Decisive new reading of the logs: **all three `onLayout` probes fire only AFTER every
`Android Bundled …ms` line** (~3s into entry), i.e. the composer subtree's FIRST React
commit/layout is DEFERRED until Metro finishes JIT-bundling the chunks the screen pulls in.

Where those chunks come from: the screen's mount `useEffect` fires four dynamic imports —
`importSpaceSettingsModal()`, `importUserProfileModal()`, `importInviteModal()` and (in
another effect) `import('@/services/space/hubLogSync')` — plus React.lazy modals. In a DEV
build each `import()` is a round-trip to Metro that compiles the module on demand
(`Android Bundled` lines). Evaluating those freshly-bundled modules synchronously starves
React's commit, so the composer doesn't lay out until bundling completes. During that
window the screen slides in with the composer not-yet-laid-out → pill appears low; it
"snaps" exactly when messages render = when the JS thread frees.

User confirms: pill SLIDES IN already low; snaps when MESSAGES APPEAR (= JS thread frees),
not at slide-end, not at header draw. Matches deferred-commit precisely.

Why this is DEV-ONLY:
- The `Android Bundled …ms` lines cannot occur in a release build — all modules are
  pre-bundled and evaluate at startup; there is no on-demand Metro round-trip and no
  multi-second commit starvation.
- The channel screen renders `<SpaceChatArea>` UNCONDITIONALLY (no loading guard, no
  Suspense boundary above the composer — verified in
  `app/(tabs)/spaces/[id]/[channelId].tsx`), so in production the composer commits on the
  first frame with correct layout. There is no data-gating to defer it.
- Confirmed environment: user is on a DEV build.

Conclusion: the visible drop is a DEV Metro-bundler artifact, not a production layout bug.

### Proposed production-safe hardening (optional, also kills the dev stall)

The mount `useEffect` fires 3–4 `import()`s synchronously on mount; in dev this triggers
the bundling stall that starves the composer's first commit. Defer the prefetch until after
the screen has settled (`InteractionManager.runAfterInteractions`, or a microtask/timeout)
so the composer commits FIRST and modal-warming happens after. Strictly better in prod too
(warming is a nice-to-have, off the critical path) and removes the dev stall. Same pattern
in the DM screen (`app/(tabs)/messages/dm/[id].tsx`).

### FIX LANDED (pending verification — NOT yet "solved")

Decision (user): "Clean revert + harden prefetch."

Done:
1. Reverted all 3 Chat files to baseline — removed every `[composer]` onLayout probe AND
   the ineffective spacer floors (worklet `Math.max`, `minHeight`). They did NOT fix the
   reported bug, so they're gone (not kept as defense-in-depth).
2. Hardened the prefetch in BOTH chat screens so the composer's first React commit isn't
   starved by on-mount dynamic imports:
   - `app/(tabs)/spaces/[id]/[channelId].tsx`: wrapped the modal-warming `useEffect`
     (SpaceSettings/UserProfile/Invite) AND the `hubLogSync` catch-up `useEffect` in
     `InteractionManager.runAfterInteractions(...)`, with `task.cancel()` cleanup.
   - `app/(tabs)/messages/dm/[id].tsx`: same for the DMSettings/UserProfile warming.
   - Added `InteractionManager` to the RN import in both.

Why this is the fix: the on-mount `import()`s are Metro round-trips in dev (the
`Android Bundled …ms` lines) whose synchronous module evaluation starves the chat's first
commit. Deferring them until after the entering transition settles lets the composer +
message list commit first. The deferred work is non-critical (modal PREFETCH; the
hubLogSync is explicitly "opportunistic, safe on every mount"), so a frame-later start is
imperceptible. In a release build there are no Metro round-trips, so this is also strictly
better there (guards against first-commit starvation on slow devices / GC pauses) at zero
user-visible cost.

### Confidence: NOT 100% — explicitly

- The bad frame's wrong position was NEVER directly captured in a log; every probe showed
  the composer CORRECT. The "deferred first commit" cause is established by ELIMINATION +
  timing correlation (probes fire only after bundling), not by observing the bad value.
- "Production unaffected" is a strong INFERENCE (no Metro JIT in release; channel screen
  renders the composer unconditionally with no Suspense/data gate above it), not a measured
  fact. A slow device / GC pause / heavy transition could still defer the first commit in
  prod — far less than the dev 3s, but non-zero.

### Verification plan (decided with user) — DONE
Build a PRODUCTION variant and reproduce there directly (the only way to be SURE about
prod). HARD CONSTRAINT: the phone already has the REAL app
(`com.quilibrium.quorummobile`) and the DEBUG build (`com.quilibrium.quorummobile.debug`)
installed; the new production variant MUST NOT overwrite either — it needs its OWN distinct
applicationId (e.g. a `.preview`/`.prod` suffix) so all three coexist.

### VERIFICATION RESULT — release build, 2026-06-20 (DECISIVE)

Built a release variant installed side-by-side as `com.quilibrium.quorummobile.preview`
(property-gated `applicationIdSuffix '.preview'` on the `release` buildType; build script
`.agents/scripts/build-prod-variant.ps1`; plan
`.agents/issues/.done/2026-06-20-production-variant-build-for-composer-verification.md`). All three
apps coexist; the real app was never touched (APK applicationId asserted as `.preview`
before installing).

**On-device result (user):** the composer drop **does NOT happen** in the release build —
the pill is in the correct resting position above the tab bar from the first frame. The user
also observed that **several other small glitches present in dev are absent in release**, and
that the **release build runs much faster** at runtime. All three observations are consistent
with the DEV-only Metro-JIT / deferred-first-commit cause: in release everything is
pre-bundled, so there is no on-demand bundling stall to starve the first commit.

=> CONFIRMED dev-only. Bug closed. The Option-A prefetch hardening stays in tree (removes the
dev stall; strictly better in prod), Options B/C (JS Stack / inset-latch) are NOT needed.

Build gotchas hit (for next time): (1) run `gradlew` from `android/`, not the repo root;
(2) the release Kotlin compile OOMs the daemon Metaspace (committed cap 512m) — pass
`-Dorg.gradle.jvmargs=...-XX:MaxMetaspaceSize=1024m` on the CLI (do NOT edit the shared
gradle.properties); (3) `applicationIdSuffix` does NOT change the Activity CLASS package, so
launch with the FULL class `com.quilibrium.quorummobile.MainActivity`, not the `.MainActivity`
shorthand (which expands to the non-existent `...preview.MainActivity`).

*Last updated: 2026-06-20*

## Related / separate

- **No spinner during slow load:** `MessagesList` DOES have a spinner
  (`isLoading && messages.length === 0` → ActivityIndicator), but `useMessages`
  synchronously seeds the first page from MMKV (`initialData`) and keeps a 30-min cache,
  so `isLoading` is almost always false for a previously-visited chat. The "slow load
  with no spinner" is most likely a background refetch / WS catch-up (intentionally no
  spinner) or dev-only Metro chunk compilation — NOT the cold-fetch path. This is a
  separate concern from the composer drop.
- **Dev vs prod:** the "several components bundling" lag on channel open is dev-only
  (Metro JIT). The composer drop is a real layout-timing bug that could surface in prod
  whenever the first layout/commit is delayed; must be fixed regardless of environment.

## Files in play

- `components/Chat/MessageInput.tsx` — composer container + pill + spacer (has the
  in-tree attempted fix).
- `components/Chat/ChatBottomChrome.tsx` — `bottom:0` overlay anchor + bottom fade.
- `hooks/useComposerPanel.ts` — spacer worklet (position owner).
- `components/Chat/SpaceChatArea.tsx` / `DMChatArea.tsx` — `chatArea`/`chatAreaInner`
  flex containers; wire `restingChromeHeight`.
- `app/(tabs)/spaces/[id]/[channelId].tsx` / `messages/dm/[id].tsx` — screen container
  (`flex:1`), pass `restingChromeHeight={tabBarHeight}`.

*Last updated: 2026-06-20*
