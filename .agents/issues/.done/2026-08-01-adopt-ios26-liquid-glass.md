---
type: task
title: "Adopt iOS 26 Liquid Glass before Xcode 27 removes the opt-out"
status: done
priority: medium
ai_generated: true
created: 2026-08-01
updated: 2026-08-01
---

# Adopt iOS 26 Liquid Glass before Xcode 27 removes the opt-out

> **⚠️ AI-Generated**: May contain errors. Verify before use.

> ## ✅ DONE — 2026-08-01
>
> Option 2 taken for **every** screen. There are no native headers left in the
> app (`+not-found` still declares a native title, but it sits under a `Slot`
> root with no navigator, has no bar buttons, and is unreachable in normal use).
>
> `UIDesignRequiresCompatibility` has been **removed** from `app.json` and
> `ios/Quorum/Info.plist`. The Xcode 27 deadline no longer applies to this app's
> headers: there is nothing left for Liquid Glass to restyle in them.
>
> Landed across three PRs: #206 (patch + compat key), #207 (channel screen),
> and `feat/rn-headers-drop-compat-key` (DM, Discover, Account, key removal).
>
> **What is still Apple's:** `Alert.alert` (187 sites), `ActionSheetIOS` (4),
> `RefreshControl` (20), text-selection menus, form controls and the keyboard
> now render in the iOS 26 style. Those are system dialogs where looking native
> is correct, and no one has reported a problem with them — but they have never
> been seen on a device in the glass style, so give them a glance on the first
> iOS build. That is the residual risk of removing the key, and it is a
> look-at-it item, not a defect.
>
> Kept for the reasoning, the audit, and the options analysis — the same choice
> will recur the next time Apple restyles a native surface.

## Why this exists

On 2026-08-01 we shipped `UIDesignRequiresCompatibility = true` so the app keeps
its pre-iOS-26 appearance (see
`.agents/issues/.done/2026-08-01-ios-space-header-back-button-dead-and-loading-label.md`,
section 3). That key is **temporary by design**: Apple said at WWDC25 that it is
provided "with Xcode 26" and that they "intend this option to be removed in the
next major release". Once the team builds with Xcode 27, the key is ignored and
Liquid Glass comes back whether or not the UI is ready for it.

Historically Apple starts requiring the newest Xcode for App Store submissions
roughly in the spring after release, so treat this as a **deadline, not a
backlog item**. The work must land before the first Xcode 27 build ships.

## What "adopting" actually means here

The visible artefact is that iOS 26 gives every `UIBarButtonItem` — including
custom-view items and the system back button — a frosted glass capsule. Two
things make it read badly in this app today, and they need different fixes.

### A. The material clash (fix this regardless of which path you pick)

`spaces/_layout.tsx`, `messages/_layout.tsx`, `feed/_layout.tsx` and
`profile/_layout.tsx` all set:

```ts
headerTransparent: true,
headerBlurEffect: 'systemChromeMaterial' as const,
```

`react-native-screens` maps `headerBlurEffect` to a legacy `UIBlurEffect`
(`buildAppearance` in `RNSScreenStackHeaderConfig.mm`) and never calls
`configureWithDefaultBackground`, so on iOS 26 the bar background is an iOS
13-era blur while its buttons are iOS 26 glass. Two materials stacked is what
reads as "weird blobs" in the original bug report.

Either drop these two options on iOS 26 and let the bar be a solid themed
surface, or wait for `react-native-screens` to expose the system material
(tracked upstream in
[discussion #4021](https://github.com/software-mansion/react-native-screens/discussions/4021)).

### B. The capsules themselves — pick one

**Option 1 — per-item opt-out (native, keeps native headers).**
`unstable_headerLeftItems` / `unstable_headerRightItems` with
`hidesSharedBackground: true`, e.g.:

```tsx
<Stack screenOptions={{
  unstable_headerRightItems: () => [
    { type: 'custom', element: <HeaderIcons />, hidesSharedBackground: true },
  ],
}} />
```

Requires newer `@react-navigation/native-stack` + `react-native-screens` than
Expo SDK 54 pins (we are on 7.3.26 / 4.16.0 — neither exposes it). Still marked
`unstable_`. **Open question nobody has confirmed:** whether it can suppress the
*system back button's* capsule, or only custom items. Verify that before
committing to this path — if it can't, this option only half-solves it.

**Option 2 — own the header (permanent, platform-independent).**
Set `headerShown: false` and render the header in React Native. No
`UIBarButtonItem`s exist, so iOS applies no glass, on any iOS version, forever.
Also makes iOS and Android pixel-identical, which is what the team wants given
the Android-only test loop.

This app already does exactly this on the Space screen
(`components/SpaceBannerHeader.tsx`), so the pattern is proven in this stack.
`components/Chat/ChannelHeader.tsx` and `components/Chat/DMChatHeader.tsx`
already exist and are currently **imported but never rendered** by
`SpaceChatArea` / `DMChatArea` — leftovers from an earlier design. They are a
plausible starting point, but check them before reuse: `ChannelHeader` hardcodes
`width: SCREEN_WIDTH` from a module-level `Dimensions.get('window')`, which is
wrong on rotation and on iPad split view.

Costs: hand-roll the back affordance, the top safe-area inset, and title
truncation; lose native large-title and scroll-edge behaviour on those screens.

**Option 3 — accept the glass** and restyle around it. Zero work if the material
clash (A) is fixed and the result looks acceptable on a device.

**Bonus:** Option 2 would also have made the dead-back-button bug
(react-native-screens#3294) structurally impossible on those screens, since that
bug can only affect a native back button.

## Blast-radius audit (2026-08-01)

Ran before choosing an option — the native-header surface is **small**, which makes Option 2
much cheaper than it first sounds. Screens that render a native header:

| Screen | Notes |
|---|---|
| `app/(tabs)/spaces/[id]/[channelId].tsx` | the reported one; has a 4-icon `headerRight` |
| `app/(tabs)/spaces/discover.tsx` | title + back only |
| `app/(tabs)/messages/dm/[id].tsx` | has `headerRight` |
| `app/(tabs)/account/index.tsx` | already sets `headerTransparent: false`, `headerBlurEffect: undefined` |
| `app/+not-found.tsx` | irrelevant |

Everything else already sets `headerShown: false` and draws its own chrome. The floating tab
bar (`components/ui/AppTabBar.tsx`) is RN-rendered, so iOS 26 does not touch it.

Also checked: **`headerSearchBarOptions` is not used anywhere** — which is lucky, it carries
its own iOS 26 defect
([react-native-screens#3270](https://github.com/software-mansion/react-native-screens/issues/3270),
back navigation breaks after using it). Do not introduce it on 4.16.0.

Other native surfaces iOS 26 restyles but nobody has complained about: `Alert.alert`
(187 call sites), `ActionSheetIOS` (4), `RefreshControl` (20). Leave them — they are
system-standard and looking native is the point.

**Option 2 has a second benefit the original writeup missed:** an RN-rendered header renders
*identically on both platforms*, so it turns the header from a surface this dev loop cannot
test into one where **the Android device is a faithful preview**. Given the constraint in
`.agents/docs/ios-ui-pitfalls-android-only-testing.md`, that is arguably worth more than the
Liquid Glass fix itself.

## Progress

- **2026-08-01 — channel screen done** (`feat/rn-channel-header`). Option 2 taken for
  `spaces/[id]/[channelId]`: `components/Chat/ChannelHeader.tsx` rewritten from dead code
  into the live header, native header hidden, and the last `Platform.OS === 'ios'` branch in
  `SpaceChatArea` removed with it. Awaiting Android eyeball before it ships.
- **Remaining native headers:** `messages/dm/[id]` (has a dead `DMChatHeader` lookalike,
  same trap — wire it up or delete it), `spaces/discover`, `account/index`.
- The Info.plist key stays until every one of those is converted; it is app-wide, so it
  cannot come out screen by screen.

## Suggested sequence

1. Fix (A) first — it is small, it is correct under every option, and it may
   make the glass acceptable on its own.
2. Get a device screenshot with `UIDesignRequiresCompatibility` removed to see
   what iOS 26 actually looks like after (A). **This is the decision input** —
   do not pick between options 1/2/3 from screenshots of the current build.
3. Choose 1, 2, or 3 based on that, then remove the Info.plist key from both
   `app.json` and `ios/Quorum/Info.plist`.

## Related

- Bug: `.agents/issues/.done/2026-08-01-ios-space-header-back-button-dead-and-loading-label.md`
- Context for anyone touching UI without an iPhone: `.agents/docs/ios-ui-pitfalls-android-only-testing.md`
- Upstream: [react-native-screens#3226](https://github.com/software-mansion/react-native-screens/issues/3226)
  (maintainer confirms Apple forces it, and names the `headerLeftItems`/`headerRightItems` API)

*Last updated: 2026-08-01*
