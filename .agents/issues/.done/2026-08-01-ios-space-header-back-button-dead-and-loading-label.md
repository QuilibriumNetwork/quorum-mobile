---
type: bug
title: "iOS-only Space header: dead back button, 'Loading…' back label, and iOS 26 Liquid Glass capsules"
status: done
priority: high
ai_generated: true
created: 2026-08-01
updated: 2026-08-01
---

# iOS-only Space header: dead back button, "Loading…" back label, Liquid Glass capsules

> **⚠️ AI-Generated**: May contain errors. Verify before use.

Three separate iOS-only defects reported together against the Space channel
screen, all reproducible on iPhone 13 Pro / iOS 26 and none reproducible on
Android 16. They have three unrelated root causes; they are filed together
because they were reported together and are fixed in the same branch
(`fix/ios-space-header-back-and-glass`).

**Nothing here has been verified on a device** — no iOS hardware is available
to this repo's dev loop. Every root cause below was traced to a specific line of
code (ours or vendored), and two of the three are confirmed upstream bugs with a
matching public reproduction. See "Verification asks" at the bottom.

---

## 1. Back button in a channel header is dead after leaving and re-entering

### Symptom

> "Cannot get out of spaces by clicking back `<` in the upper left corner. To
> recreate: enter any space, leave and reenter. You are now stuck in this space
> until you close the app."

Swipe-back still works. Only the tappable back button is dead, and it stays dead
for the rest of the app session.

### Root cause — upstream, `react-native-screens` 4.16.0, iOS 26 only

`ios/RNSScreenStack.mm`, `RNSNavigationController`'s `UINavigationBarDelegate`
pair (iOS 26 branch only, which is why Android and iOS < 26 are unaffected):

```objc
- (BOOL)navigationBar:(UINavigationBar *)navigationBar shouldPopItem:(UINavigationItem *)item {
  if (@available(iOS 26, *)) {
    if (self.transitionCoordinator == nil) {
      UIView *button = [navigationBar rnscreens_findBackButtonWrapperView];
      if (button != nil) {
        button.userInteractionEnabled = false;   // <-- latched off here
      }
      return true;
    }
    return false;
  }
  return true;
}

- (void)navigationBar:(UINavigationBar *)navigationBar didPopItem:(UINavigationItem *)item {
  if (@available(iOS 26, *)) {
    UIView *button = [navigationBar rnscreens_findBackButtonWrapperView];
    if (button != nil) {
      button.userInteractionEnabled = true;      // <-- only reset here
    }
  }
}
```

The disable is purely cosmetic — upstream's own comment says it exists so the
tap highlight isn't drawn while the pop animates. The reset lives in
`didPopItem:`. **When the screen being revealed hides its header, UIKit never
delivers `didPopItem:`**, so the flag stays `false`. UIKit reuses that same
back-button wrapper view for subsequent pushes, so every later push inherits a
dead back button until the process is restarted.

Our Spaces stack hits this exactly:

| Stack level | Route | Header |
|---|---|---|
| 1 | `app/(tabs)/spaces/index.tsx` | `headerShown: false` |
| 2 | `app/(tabs)/spaces/[id]/index.tsx` | `headerShown: false` (renders `SpaceBannerHeader` instead) |
| 3 | `app/(tabs)/spaces/[id]/[channelId].tsx` | native header — **this is the back button that dies** |

Popping 3 → 2 reveals a header-less screen, so `didPopItem:` never fires and the
latch sticks. Pushing 3 again gives a dead back button. That is the user's
"enter a space, leave and reenter" repro verbatim.

Messages does not reproduce it: that stack is only two levels deep, so there is
no push after the pop that reveals a header-less screen.

### Upstream status

- Bug: [software-mansion/react-native-screens#3294](https://github.com/software-mansion/react-native-screens/issues/3294)
  — "[iOS 26] Back Button disables if `headerShown: false` or custom header used".
  Reported against 4.16.0, the exact version Expo SDK 54 pins. Public repro:
  [iliapnmrv/rn-screens-ios26-disabled-back-button](https://github.com/iliapnmrv/rn-screens-ios26-disabled-back-button).
  Repro steps in that issue are 1 → 2 (`headerShown: false`) → 3 → back → 3, i.e.
  identical to ours.
- Fix: [PR #3173](https://github.com/software-mansion/react-native-screens/pull/3173),
  shipped in **4.17.0**. It deletes both delegate methods outright.
- Maintainer guidance in #3294: *"I recommend applying the patch from #3173 to
  version 4.16. This fix will be released as part of version 4.17."*

### Our fix

`patches/react-native-screens+4.16.0.patch` (patch-package; `postinstall`
already runs it).

We did **not** take all of PR #3173. That PR also swaps our custom pan
recogniser for iOS 26's native `interactiveContentPopGestureRecognizer` and
makes `fullScreenSwipeEnabled` / `gestureResponseDistance` no-ops — both layouts
here deliberately set `fullScreenGestureEnabled: false` so the chat composer and
FlashList keep their touches, and that behaviour change is not verifiable
without a device.

Instead the patch removes **only** the cosmetic latch, keeping the
`transitionCoordinator == nil` guard (that guard, not the latch, is what
prevents a double pop on a fast double-tap) and keeping `didPopItem:`'s reset as
a harmless safety net. Net behavioural change on iOS 26: the back button briefly
shows its normal tap highlight while the pop animates. That is it.

Upgrading to 4.17.x instead was considered and rejected: it deviates from Expo
SDK 54's `~4.16.0` pin and pulls the full gesture rework onto both platforms.
Revisit at the next Expo SDK bump, and drop the patch then.

---

## 2. Back button label reads "Loading…" instead of the space name

### Symptom

> "Inside a Space the `<` icon in the upper left corner is replaced by 'Loading…'
> sporadically."

### Root cause — ours

iOS derives a native back button's label from the **previous** screen's
`navigationItem.title`. In `@react-navigation/native-stack`
(`views/NativeStackView.native.tsx`):

```js
const backTitle = previousDescriptor
  ? getHeaderTitle(previousDescriptor.options, previousDescriptor.route.name)
  : parentHeaderBack?.title;
```

and in `react-native-screens`' `configureBackItem`, a blank `backTitle` falls
back to `prevItem.title`.

`app/(tabs)/spaces/[id]/index.tsx` rendered `<Stack.Screen options={{ title:
'Loading...' }} />` while fetching the space, then `<Stack.Screen options={{
headerShown: false }} />` once loaded. `setOptions` **merges**, so `title` was
never cleared — and `react-native-screens` still writes it through even for a
hidden header:

```objc
if (shouldHide) {
  navitem.title = config.title;   // 'Loading...' persists on the navigationItem
  return;
}
```

So the channel screen pushed on top inherited `Loading...` as its back label.

**Why "sporadically":** it only happens on a cache miss. When React Query already
has the space cached, `isLoading` is false on first render, the `'Loading...'`
branch never runs, and the label reads `Space` (the layout default) instead.

### Our fix

- `app/(tabs)/spaces/[id]/index.tsx` — the loaded branch now sets
  `title: spaceData.spaceName` alongside `headerShown: false`, overwriting the
  stale value and giving the channel screen a genuinely useful back label.
- `app/(tabs)/spaces/[id]/[channelId].tsx` — belt and braces: sets
  `headerBackTitle: spaceData?.spaceName ?? 'Space'` so the label no longer
  depends on the previous screen's options at all. iOS shortens it to "Back"
  by itself when the name doesn't fit.

`app/(tabs)/messages/dm/[id].tsx` has the same `title: 'Loading...'` pattern but
is **not** affected: nothing is ever pushed on top of a DM, so that title only
ever renders as its own (correct, informative) header title.

---

## 3. Liquid Glass capsules around every header button

### Symptom

> "In a Space the top parts have a weird effect around all the buttons/icons."

Screenshots show a rounded frosted capsule behind the back button and another
behind the video/phone/gear group.

### Root cause — Apple, not us

This is iOS 26's Liquid Glass. UIKit gives every `UIBarButtonItem` a glass
capsule, including custom-view items, and there is no opt-out in
`react-native-screens` 4.16.0 / `@react-navigation/native-stack` 7.3.26 — the
per-item `unstable_headerLeftItems` / `unstable_headerRightItems` API with
`sharesBackground` / `hidesSharedBackground` landed in later versions, and even
then it targets custom items, not the system back button.

Confirmed by the maintainer in
[react-native-screens#3226](https://github.com/software-mansion/react-native-screens/issues/3226):
*"It's not react-native-screens who forces liquid glass. It's Apple."*

Our layouts make it read worse than stock: `spaces/_layout.tsx`,
`messages/_layout.tsx`, `feed/_layout.tsx` and `profile/_layout.tsx` all set
`headerTransparent: true` + `headerBlurEffect: 'systemChromeMaterial'`, which
`react-native-screens` maps to a legacy `UIBlurEffect` bar background. So on iOS
26 the bar wears an iOS 13-era blur while its buttons wear iOS 26 glass — two
different materials stacked, which is exactly the "weird blobs" appearance.
`react-native-screens` never calls `configureWithDefaultBackground`, so the bar
cannot currently use the real system material (see upstream discussion #4021).

### Our fix (stopgap — read the follow-up task)

`UIDesignRequiresCompatibility = true`, added to both `app.json`
(`expo.ios.infoPlist`) and `ios/Quorum/Info.plist`. This project does not run
`expo prebuild` — `ios/` is the source of truth, see `PREBUILD.md` — so the key
must exist in both places or the built app won't get it.

This is Apple's own documented compatibility key and restores the pre-iOS-26
appearance app-wide (headers, alerts, controls), i.e. the design already
verified on Android.

**It expires.** Apple stated at WWDC25 that the key is intended to be removed in
the next major Xcode release, so builds made with Xcode 27 will ignore it. The
permanent path is tracked in
`.agents/issues/.done/2026-08-01-adopt-ios26-liquid-glass.md`.

---

## Verification asks (no iOS hardware in this repo's dev loop)

Added to `.agents/docs/ios-verification-checklist.md`. Summary:

1. **Dead back button** — open a space, open a channel, tap back, open the same
   channel again, tap back. Pass: it works every time, indefinitely.
2. **Back label** — open a space you have never opened this session (forces a
   cache miss) and enter a channel. Pass: the back button reads the space name
   (or "Back"), never "Loading…".
3. **Liquid Glass** — anywhere with a native header. Pass: flat buttons, no
   frosted capsules, matching Android.

Test 3 needs a **rebuilt** iOS binary — `Info.plist` changes do not reach an
existing build, and they have no effect at all in Expo Go. Test 1 also needs a
native rebuild, because the fix is a patched `.mm` file. Test 2 is JS-only and
would ship over OTA.

## Files changed

- `patches/react-native-screens+4.16.0.patch` (new)
- `app/(tabs)/spaces/[id]/index.tsx`
- `app/(tabs)/spaces/[id]/[channelId].tsx`
- `app.json`
- `ios/Quorum/Info.plist`

*Last updated: 2026-08-01*
