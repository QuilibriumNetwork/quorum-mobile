# iOS UI pitfalls when you can only test on Android

**Read this before writing or changing any navigation, header, or chrome code.**

This repo's dev loop runs on Android only — no Mac, no simulator, no iPhone. That is a
process constraint (how to triage and merge such PRs lives in the private memory vault,
`projects/quorum-mobile/ios-compatibility-discipline.md`). This document is the *technical*
half: **which iOS behaviours an Android device physically cannot show you**, and what to do
about each.

Everything below is grounded in a defect that actually shipped from this repo, with the
bug file named. It is not a generic Human Interface Guidelines summary.

---

## The core asymmetry

React Native draws most of the app identically on both platforms. The exceptions are the
places where RN hands rendering to the **native OS widget**, and on iOS that widget is
UIKit, which has its own inheritance rules, its own lifecycle callbacks, and its own
appearance that Apple restyles between OS versions.

> **Rule of thumb:** if a piece of chrome is drawn by iOS rather than by your JSX, Android
> gives you *zero* signal about it. Not "less signal" — zero.

In this app the native-drawn surfaces are:

| Surface | Drawn by | Android tells you… |
|---|---|---|
| ~~`Stack` header~~ | ~~UIKit `UINavigationBar`~~ | **no longer applicable — see below** |
| `<Modal>` (via `BaseModal`) | UIKit modal presentation | little; stacking differs |
| Keyboard / safe-area insets | UIKit | timing and geometry differ |
| Alerts, action sheets, system controls | UIKit | appearance only |

Everything else — `View`, `Text`, `FlashList`, our own headers, the floating tab bar —
renders from the same code on both, so Android is a genuine proxy.

> **The header row was removed on 2026-08-01.** Every screen now draws its own bar via
> `components/ui/ScreenHeader` and no screen renders a native `UINavigationBar`. That was
> done specifically to move the header from the top table into the bottom paragraph: it
> converted the app's single worst untestable surface into one Android previews faithfully.
> Section 1 below is kept because the failures it describes are what motivated the change,
> and because **the same reasoning applies to any native surface you are tempted to adopt.**
> If you reintroduce a native header, you reintroduce all of it.

---

## 1. The native header is not a React component

Three shipped iOS-only bugs came from this single misunderstanding
(`.agents/issues/.done/2026-08-01-ios-space-header-back-button-dead-and-loading-label.md`).

### 1a. The back button's label is inherited from the previous screen

iOS labels a back button with the **previous screen's** `navigationItem.title`. Android
draws a bare arrow with no label at all, so a wrong label is *invisible* on Android.

We shipped a channel header reading "‹ Loading…" for weeks because
`app/(tabs)/spaces/[id]/index.tsx` set `title: 'Loading...'` during its fetch and then only
set `headerShown: false` once loaded. `navigation.setOptions` **merges**, so the stale title
survived, and `react-native-screens` writes the title onto the `navigationItem` even for a
hidden header.

**Do this:** set `headerBackTitle` explicitly on any screen that can be pushed onto, instead
of relying on inheritance. And never leave a transient title (`'Loading...'`, `'Error'`) as
the last value a screen set — overwrite it with the real one.

### 1b. Toggling `headerShown` has native side effects

`headerShown: false` calls `setNavigationBarHidden:` on the real `UINavigationController`.
That changes which UIKit delegate callbacks fire, which is how we ended up with a back
button that went permanently dead after re-entering a channel
(`react-native-screens` 4.16.0 latched `userInteractionEnabled = false` on the back-button
view and only reset it in a callback that a hidden header suppresses).

**Do this:** prefer deciding `headerShown` **statically in the layout** over flipping it from
inside a screen based on loading state. If a screen renders its own header, hide the native
one for that route in `_layout.tsx` and keep it hidden for the screen's whole life.

### 1c. iOS-only header options are untestable by construction

`headerLargeTitle`, `headerTransparent`, `headerBlurEffect`, `headerBackTitle`,
`headerBackButtonDisplayMode` are all iOS-only. Every one of them sits inside a
`Platform.select({ ios: … })` block in our `_layout.tsx` files, which means **the Android run
you just did exercised none of it**.

**Do this:** when you touch a `Platform.select` iOS branch, say so explicitly in the PR body
and add a line to `.agents/docs/ios-verification-checklist.md`. Treat "it built and Android
looks fine" as no evidence whatsoever.

### 1d. `headerLeft` silently removes the back button

Supplying `headerLeft` replaces the back button on iOS unless
`headerBackButtonInCustomView: true` is also set. On Android the two coexist. So a custom
left header item is a one-way trip out of a stack on iOS.

---

## 2. Apple restyles native widgets between OS versions; your own views are immune

iOS 26 wraps every `UIBarButtonItem` in a Liquid Glass capsule. Nothing in our code asked
for it and there is no opt-out in the `react-native-screens` version Expo SDK 54 pins. Our
Space *banner* header (`components/SpaceBannerHeader.tsx`) was completely unaffected — it is
plain `View`s and `TouchableOpacity`s, so iOS has nothing to restyle.

**The design lever:** when a piece of chrome must look identical on both platforms and must
stay stable across OS releases, **render it yourself**. When you want it to feel native and
track the platform, use the native widget and accept that Apple will change how it looks.

For headers this decision is now made: **render them ourselves, everywhere.** Use
`components/ui/ScreenHeader` — it owns height, padding, typography and the back affordance,
and richer bars (`ChannelHeader`, `DMChatHeader`) compose it rather than re-implementing it.
Do not add a fourth header component; a component that merely looks like the live header is
how a fix once landed in the wrong file.

For genuinely system-level things — alerts, action sheets, the keyboard, text selection —
the opposite answer is right: those *should* track the platform, and reimplementing them
would be worse than letting Apple restyle them.

**Also: don't stack two design eras.** Our layouts used to force
`headerBlurEffect: 'systemChromeMaterial'` (an iOS 13-era `UIBlurEffect`) under buttons that
iOS 26 renders in glass. Two materials on one bar is what testers described as "a weird
effect around all the buttons". Those options are gone from every `_layout.tsx` now, and
each one carries a comment saying not to put them back.

Note the empty `Platform.select({ ios: {} })` branches left behind in those layouts: they
look like dead code and are not. Deleting the `ios` key makes iOS fall through to `default`
and inherit Android's `slide_from_right`, silently replacing the native iOS push animation.

---

## 3. Nested native modals

`BaseModal` wraps RN's `<Modal>`, which on iOS is a real `UIViewController` presentation, not
an in-tree view. Stacking one over another (e.g. `BlockUserModal` over `UserProfileModal`) is
the single most common iOS-specific failure in this app: clipping, wrong insets, backdrop
behind the wrong layer. Android renders a `Dialog` instead and is much more forgiving.

If several stacked-modal features fail on iOS the same way, fix `BaseModal`, not each
feature. See the cross-cutting note in `.agents/docs/ios-verification-checklist.md`.

---

## 4. Know what ships over the air and what needs a rebuild

Testers waste real time here, and a "still broken" report from the wrong build type sends
you chasing a fix that already worked.

| Change | Reaches a tester via |
|---|---|
| JS/TSX | OTA update or a JS reload |
| `patches/*.patch` on native code (`.mm`, `.java`) | **native rebuild only** |
| `ios/**/Info.plist`, entitlements, `expo.ios.*` | **native rebuild only**, and never in Expo Go |
| `app.json` `ios.infoPlist` | only if the value also reaches `ios/Quorum/Info.plist` — this repo does **not** run `expo prebuild`, see `PREBUILD.md` |

Always state which category a fix is in when you ask someone to verify it.

---

## 5. How to debug an iOS bug you cannot reproduce

This is the method that resolved all three bugs in the 2026-08-01 report, from Windows,
without a device. Use it instead of guessing.

1. **Get the exact versions first.** `react-native-screens`, `@react-navigation/native-stack`,
   `expo`, and the reporter's **iOS version**. iOS-version-gated native code paths
   (`if (@available(iOS 26, *))`) are invisible until you know the target.
2. **Read the vendored native source.** `node_modules/react-native-screens/ios/*.mm` is right
   there. Reading `RNSScreenStackHeaderConfig.mm` is what proved the back-button label comes
   from `prevItem.title`; reading `RNSScreenStack.mm` is what found the
   `userInteractionEnabled` latch. This beats any amount of reasoning about how it "should"
   work.
3. **Search upstream issues with the version number**, then read the linked PR diff. Both
   iOS-only defects were known bugs with public reproductions matching our navigation shape
   exactly.
4. **Prefer the minimal patch you can justify line-by-line** over a version bump you cannot
   test. We applied only the two-line cause from upstream PR #3173 rather than the whole PR,
   because the rest reworked the swipe-back gesture and we could not verify that.
5. **Write the verification ask before you think you're done.** If you cannot phrase a
   one-line question a non-technical tester can answer pass/fail, you do not actually know
   what you fixed.

---

## Pre-flight checklist for any UI change

- [ ] Does this touch a `Stack.Screen` option, a `_layout.tsx`, or `headerShown` — or reintroduce a NATIVE header anywhere?
- [ ] Does it add or change a `Platform.OS === 'ios'` / `Platform.select` branch?
- [ ] Does it set a screen `title` that is transient (loading/error), and does something
      overwrite it afterwards?
- [ ] Does it add a `headerLeft`, or a modal opened from another modal?
- [ ] Does it rely on safe-area insets or keyboard timing?

Any box ticked → mark the PR **iOS untested**, and add an item to
`.agents/docs/ios-verification-checklist.md` with a one-line pass/fail Ask.

## Related

- `.agents/docs/ios-verification-checklist.md` — the live list of things awaiting an iPhone
- `.agents/issues/.done/2026-08-01-ios-space-header-back-button-dead-and-loading-label.md` — the
  worked examples behind sections 1 and 2
- `.agents/issues/.done/2026-08-01-adopt-ios26-liquid-glass.md` — the dated deadline attached to
  section 2
- `.agents/docs/composer-keyboard-emoji-panel.md` — keyboard/inset timing, the other big
  cross-platform divergence in this app

*Last updated: 2026-08-01*
