# iOS verification checklist

Changes built/tested on **Android** (the current dev runtime) that need confirming on a
real **iPhone**. Dual-purpose doc:

- **For the user / testers:** each item has a **▶ Ask** line — a copy-paste one-liner to
  send an iPhone tester, plus a clear **Pass/Fail**.
- **For the agent:** each item has a **Context** block — why the test exists, why iOS might
  differ, where the code lives, and where to look first if it fails. When the user says
  "test N passed/failed on iPhone," read that item and act from it directly.

**Status legend:** 🔲 untested · ✅ pass · ❌ fails · ⚠️ partial
**On a result:** ✅ → move the item to "Verified" (keep ~1-2 releases, then prune).
❌/⚠️ → open a dated bug in `.agents/bugs/`, link it here, leave the item with notes.
**Adding items:** when you land an Android-only change, add a row (Ask + Pass/Fail +
Context). Keep the Ask to one line; put the depth in Context.

---

## Pending

### 1. Chat list doesn't jump to the top when a modal opens 🔲
**▶ Ask:** "In a chat, scroll up a bit (keyboard closed), then open and close: a profile
(tap a profile pic), the message menu (long-press a message), settings, and Invite. Does
the chat stay put, or does it jump up to the first/oldest message?"
**Pass:** stays put on every open AND close. **Fail:** jumps to the top.

**Context (agent):**
- **What/when:** fix shipped in PR #125 (master, 2026-06-22). Android-verified only.
- **The bug:** any bottom-sheet modal over a chat scrolled the `MessagesList` to y=0.
- **Root cause:** a native Android `<Modal>` grabs/releases input focus on mount/unmount,
  emitting a keyboard event with **no focused TextInput** (`target <= 0`).
  `KeyboardChatScrollView` (react-native-keyboard-controller) chased that bogus 0-height
  event and scrolled to top. Real composer events carry the input's positive view tag.
- **The fix:** `patches/react-native-keyboard-controller+1.21.11.patch` adds
  `|| e.target <= 0` to the lib's `onMove` worklet so it ignores focus-less events.
- **Why iOS may differ:** native `<Modal>` on iOS is a `UIViewController` presentation, not
  an Android Dialog — it may not emit the spurious focus-less keyboard event at all, so the
  bug may never have appeared on iOS. The patch is platform-agnostic and a no-op when no
  such event fires, so it should be harmless regardless.
- **If it FAILS on iOS** (still jumps): the iOS trigger is different — do NOT assume it's
  the same `target<=0` event. Re-instrument: log keyboard events (`onStart/onMove/onEnd`
  `target`/`height`) AND the FlashList `onScroll` y in `MessagesList`, repro on an iOS
  device/sim, and find what actually fires the scroll-to-0 there. Solved-bug writeup with
  the full Android investigation: `.agents/issues/.done/2026-06-21-chat-list-jumps-to-top-on-modal-open.md`.

### 2. Composer ↔ keyboard ↔ emoji-panel choreography 🔲
**▶ Ask:** "In a chat (try both a Space channel and a DM): open the keyboard, then tap the
emoji icon to swap to the emoji panel, then tap the text box to swap back, then open the
emoji panel with no keyboard up, then use the search inside the panel, then close
everything. Is every transition smooth — no flicker, no jump, no empty gap, and the bottom
tab bar never showing on top of the emoji panel?"
**Pass:** all transitions seamless; tab bar never over the panel, never missing.
**Fail:** note which transition + Space vs DM (and which DM type).

**Context (agent):**
- **What:** the whole composer/keyboard/emoji-panel/tab-bar dance, designed + tuned on
  Android over many iterations. Full design + transition matrix:
  [composer-keyboard-emoji-panel.md](composer-keyboard-emoji-panel.md) — read it before
  touching anything here.
- **Why iOS may differ:** the choreography leans on keyboard event timing, animation
  curves, and safe-area/inset behavior that differ between platforms. Position is owned by
  a Reanimated spacer on the UI thread; visibility by shared values. Anything that lags or
  mistimes on iOS reintroduces the historical bug class (drop/bounce/flash/gap/peek).
- **Highest risk:** `FarcasterDirectMessageView` — it uses a flex-column layout (not the
  overlay) and different geometry; verify it specifically.
- **Key files:** `hooks/useComposerPanel.ts` (state machine + spacer worklet),
  `components/Chat/MessageInput.tsx`, `components/Chat/ChatBottomChrome.tsx`,
  `services/ui/composerFootprint.ts` + `composerPanelVisible.ts` (shared values),
  `components/ui/AppTabBar.tsx` (self-hiding tab bar).
- **Known (not a bug):** opening the emoji panel **from rest** (no keyboard) lifts the list
  slowly / a little — documented + accepted (a single deferred scroll correction; a
  per-frame follower was tried and gave no improvement). Only report it if on iOS the panel
  fully covers the last message with NO lift at all.
- **If it FAILS on iOS:** map the broken transition to its row in the design doc's
  transition matrix, then check the owning shared value (spacer height / `panelVisibleSV` /
  `composerBottomBusySV`). The rule from the doc: anything affecting where the composer sits
  or what's visible *mid-transition* must be a UI-thread shared value, never React state.

### 3. Channel/space notification mute still suppresses pushes on iOS 🔲
**▶ Ask:** "On iPhone, open a space's settings and turn OFF notifications for one channel
(or the whole space). Have someone post in that channel. Do you correctly get NO push
notification for the muted channel, while a non-muted channel still notifies? Then check
the channel list shows the muted channel dimmed with a bell-off icon."
**Pass:** muted channel/space produces no push; the row looks muted (dimmed + bell-off);
unmuting restores pushes. **Fail:** push still arrives when muted, or the visual is wrong.

**Context (agent):**
- **What:** channel/space notification mute moved from a device-local MMKV store to
  `UserConfig` so it syncs cross-device. The MMKV store is kept as a local mirror that the
  notification gates read. The iOS NSE reads that mirror via the App-Group container.
- **Why iOS may differ / needs a check:** the suppression on iOS happens in the
  Notification Service Extension (`ios/.../HubLogClassifier.swift`), which reads the
  App-Group-mirrored MMKV keys. The mute keys themselves are unchanged (we still write the
  same `space:<id>` / `channel:<spaceId>:<channelId>` enabled-flags), so the NSE should keep
  working — but it's only Android-runtime-tested, so confirm the NSE actually sees the
  mirror after a toggle.
- **Also worth confirming:** a mute toggled on another device (or desktop) shows up here
  after config sync (dimmed row + actually suppresses), since the whole point is cross-device.
- **Key files:** `hooks/chat/useChannelMute.ts` (source of truth + mirror), `services/
  notifications/notificationPrefs.ts` (`mirrorSpaceMuteState`), `services/config/
  configService.ts` (UserConfig helpers), `ios/.../HubLogClassifier.swift` (NSE gate),
  channel-row visual in `app/(tabs)/spaces/[id]/index.tsx`.
- **If it FAILS on iOS:** if pushes still arrive when muted, the NSE isn't seeing the mirror
  — verify the App-Group MMKV write lands (`createMirroredMMKV`) and the keys match what the
  Swift reads. If only the visual is wrong, it's pure RN (the `isChannelMuted` read in the
  channel-row), independent of the NSE.

### 4. Moderation "Mute in Space" (role-gated) renders + works on iOS 🔲
**▶ Ask:** "As a space owner/moderator, open a member's profile and use 'Mute in Space' (and
'Unmute in Space'). Does the confirmation sheet open cleanly over the profile, and after
muting does that user's new messages stop appearing for everyone, with their composer
showing a 'You are muted' banner if you log in as them? Does unmute restore it?"
**Pass:** mute/unmute sheet stacks correctly over the profile modal; mute drops the user's
messages on receipt and disables their composer; unmute restores. **Fail:** sheet renders
oddly/clipped, or mute has no effect.

**Context (agent):**
- **What:** role-gated moderation mute (shipped PR #125). Broadcasts a signed `MuteMessage`;
  every client validates + drops the muted user's messages at receive and disables that
  user's composer. This is the LIVE WebSocket-broadcast path (not config), so it should
  propagate cross-device in real time — unlike the personal block/notification mute.
- **Why iOS may differ:** it's mostly RN logic (same on both platforms), so the risk is
  **iOS modal stacking + safe-area**: `MuteUserModal` (a `BaseModal`) opens OVER
  `UserProfileModal` (another `BaseModal`). Two stacked native modals can mis-layer or
  mis-inset on iOS. Verify the sheet isn't clipped/behind, and the duration picker + Switch
  render.
- **Key files:** `components/MuteUserModal.tsx`, `hooks/chat/useModMuteUser.ts`,
  `hooks/chat/useIsUserMuted.ts`, `services/space/modMuteStorage.ts`, receive-side handling
  in `context/WebSocketContext.tsx` (`content.type === 'mute'`).
- **If it FAILS on iOS:** layout/clipping → it's the stacked-BaseModal iOS issue (see the
  general modal note); mute-has-no-effect → check the receive-side permission re-validation,
  which is platform-agnostic so unlikely iOS-specific.

### 5. Personal Block + the "Blocked" manage section on iOS 🔲
**▶ Ask:** "Open a user's profile and tap Block — does a confirm sheet appear explaining
you won't see their messages (only for you, only in this space)? After confirming, do their
messages disappear from your view? Then in Space Settings → Members, at the top is there a
'Blocked' section you can expand to Unblock them? Does unblocking bring their messages back?"
**Pass:** Block confirm sheet renders over the profile; blocked user's messages vanish from
your stream; the top 'Blocked (N)' accordion lists them and Unblock works. **Fail:** sheet
clipped/mis-layered, block has no visual effect, or the Blocked section is missing/empty.

**Context (agent):**
- **What:** personal viewer-side block (shipped PR #127), synced via `UserConfig.blockedUsers`.
  A render-time filter hides the blocked user's messages from YOUR stream only, per space.
  Mirrors desktop. Distinct from moderation mute (#4) and notification mute (#3).
- **Why iOS may differ:** pure RN (the filter + UI are platform-agnostic), so the only real
  iOS risk is again **modal stacking**: `BlockUserModal` opens over `UserProfileModal`. Also
  confirm the temporary Unblock icon (`eye`) and the Block icon (`hand.raised.fill`) render.
- **Key files:** `hooks/chat/useBlockUser.ts`, `components/BlockUserModal.tsx`,
  `components/UserProfileModal.tsx` (Block/Unblock row), `components/SpaceSettingsModal.tsx`
  (the "Blocked" accordion), `services/config/configService.ts` (`blockedUsers` helpers).
- **Reachability note:** the "Blocked" accordion reads from the synced block config (not the
  member list), so it must list blocked users even when they're absent from the member list —
  verify that specifically. If a blocked user is unreachable, that's the gap this section
  exists to close.
- **If it FAILS on iOS:** clipping/layering → stacked-BaseModal iOS issue; filter not applied
  → platform-agnostic (unlikely iOS-specific); accordion empty → the `useBlockUser` store /
  `blockedUsers` config read, also platform-agnostic.

> **Cross-cutting iOS note for #4 & #5 (and any chat modal):** several of these stack a
> second `BaseModal` over `UserProfileModal`. `BaseModal` uses a native RN `<Modal>`; nested
> native modals are the most likely iOS-specific failure (clipping, wrong insets, backdrop
> behind). If multiple stacked-modal items fail the same way, the fix is at `BaseModal`, not
> per-feature.

### 6. Channel back button still works after leaving and re-entering a channel 🔲
**▶ Ask:** "Open a Space, open a channel, tap `<` back, then open the SAME channel again and
tap `<` back again. Repeat a third time. Does back work every single time?"
**Pass:** back works every time, indefinitely. **Fail:** back goes dead from the second
entry on and stays dead until you force-quit the app (swipe-back still works — that's the
tell for this exact bug).

**Context (agent):**
- **What:** fix for a confirmed upstream bug, reported by a tester on iPhone 13 Pro / iOS 26,
  not reproducible on Android 16. Full writeup:
  `.agents/issues/.done/2026-08-01-ios-space-header-back-button-dead-and-loading-label.md` §1.
- **Root cause:** `react-native-screens` 4.16.0 (the version Expo SDK 54 pins) disables
  `userInteractionEnabled` on the nav bar's back-button wrapper view in
  `navigationBar:shouldPopItem:` and only re-enables it in `navigationBar:didPopItem:`.
  When the revealed screen hides its header, `didPopItem:` never fires, the flag stays
  latched off, and UIKit reuses that view for every later push. iOS 26 code path only.
- **Why our Spaces stack hits it:** `spaces/index` and `spaces/[id]/index` both set
  `headerShown: false`, so popping the channel screen always reveals a header-less screen.
  Messages is only two levels deep and doesn't reproduce it.
- **The fix:** `patches/react-native-screens+4.16.0.patch` removes only the cosmetic latch
  and keeps the `transitionCoordinator` double-pop guard. Upstream fixed it wholesale in
  4.17.0 via software-mansion/react-native-screens#3173.
- **Needs a native rebuild** — patched `.mm`, will not arrive over OTA.
- **If it FAILS on iOS:** confirm the patch is actually in the binary first (`postinstall`
  runs patch-package; a fresh `npm ci` or an EAS build cache miss is the usual culprit). If
  it is in and back still dies, the remaining suspect is the `shouldPopItem` guard returning
  `false` with a stuck `transitionCoordinator` — take all of PR #3173 (it deletes both
  delegate methods) or bump to `react-native-screens@4.17.1`.

### 7. Channel back button is labelled with the space name, never "Loading…" 🔲
**▶ Ask:** "Force-quit the app, reopen it, and go straight into a Space you haven't opened
yet this session, then into a channel. What text sits next to the `<` in the top left?"
**Pass:** the space name, or "Back" if the name is too long. **Fail:** "Loading…".

**Context (agent):**
- **What:** iOS derives a native back button's label from the PREVIOUS screen's
  `navigationItem.title`. `spaces/[id]/index` set `title: 'Loading...'` while fetching and
  then only `headerShown: false` once loaded — and `setOptions` merges, so the stale title
  survived and leaked into the channel screen's back button.
- **Why "sporadic":** only on a React Query cache miss. Cached space → `isLoading` is false
  on first render → the `'Loading...'` branch never runs → label read "Space". Hence the
  force-quit in the Ask: it's the reliable way to force a cache miss.
- **The fix:** `spaces/[id]/index.tsx` now sets `title: spaceData.spaceName` alongside
  `headerShown: false`; `spaces/[id]/[channelId].tsx` also sets `headerBackTitle` explicitly
  so it no longer depends on the previous screen at all.
- **JS-only** — this one ships over OTA.
- **If it FAILS on iOS:** check whether the label is stale rather than wrong (a cached
  `UINavigationItem` not re-read). Writeup: same bug file, §2.

### 8. No frosted "glass" capsules behind header buttons (iOS 26) 🔲
**▶ Ask:** "On every screen with a top bar — a channel, a DM, Discover Spaces, Account — is
there a frosted rounded rectangle behind the back chevron or behind the icons on the right?
Compare with Android: they should look the same on both."
**Pass:** flat buttons on a plain bar, matching Android. **Fail:** capsules/blobs behind the
buttons.

**Context (agent):**
- **What:** iOS 26 Liquid Glass. Apple, not us — UIKit wraps every `UIBarButtonItem` in a
  glass capsule and `react-native-screens` 4.16.0 exposes no opt-out.
- **How it is fixed now:** structurally, not with a flag. **No screen renders a native
  header any more** — every bar is `components/ui/ScreenHeader` drawn in RN, so there is no
  `UIBarButtonItem` for iOS to restyle. `UIDesignRequiresCompatibility` was the original
  stopgap and has been **removed** (it expires with Xcode 27 anyway).
- **Needs a rebuilt binary** for the `Info.plist` removal to take effect, though the header
  conversions themselves are JS and ship over the air.
- **If it FAILS on iOS:** find which screen. If it is one of ours, something is still
  showing a native header — grep for a missing `headerShown: false`. Writeup: same bug
  file, §3, and the archived task `.agents/issues/.done/2026-08-01-adopt-ios26-liquid-glass.md`.

### 10. Converted headers look right on iOS: DM, Discover Spaces, Account 🔲
**▶ Ask:** "Open a DM, then Spaces → Discover, then your Account screen. On each: is the top
bar the right height, does the title sit clear of the status bar / notch, is the back chevron
tappable, and does tapping a DM's avatar or name open that person's profile?"
**Pass:** all four on all three screens. **Fail:** note which screen and which symptom.

**Context (agent):**
- **What:** the same conversion as #6/#7, extended to the last three native headers, plus a
  shared `components/ui/ScreenHeader` primitive that `ChannelHeader` and `DMChatHeader` now
  compose. Geometry is defined once, so a spacing bug is one fix, not four.
- **Why iOS may differ:** we now own the top safe-area inset that the native bar used to
  apply for free. Android has a uniform status bar; iOS has the notch/Dynamic Island. The
  inset comes from `useSafeAreaInsets().top`, which is the part Android geometry cannot
  fully vouch for.
- **Also check:** a very long DM display name or channel name should ellipsize, not push the
  right-hand icons off screen.
- **Bonus behaviour worth confirming:** open a DM or channel from a push notification, then
  press back. It should land on the conversation/channel list rather than doing nothing —
  both screens now fall back to an explicit route when there is no history beneath them.
- **If it FAILS on iOS:** a too-short bar or a title under the status bar means the inset
  isn't arriving; check that the screen passes `insets.top` into `ScreenHeader` and that the
  screen is inside a `SafeAreaProvider`.

### 9. Keyboard is opaque — no emoji grid bleeding through it (iOS 26) 🔲
**▶ Ask:** "In any chat, tap the message box to bring the keyboard up. Can you see faint
coloured shapes — yellow blobs especially — showing through the keyboard keys, or is the
keyboard solid?"
**Pass:** solid keyboard, nothing visible behind it. **Fail:** translucent keyboard with
coloured artifacts behind the keys.

**Context (agent):**
- **Reported as:** "iOS keyboard being semi-transparent when coming up with some weird
  yellow artifacts" (2026-08-01, screenshot pending). Faint yellow blobs are also visible
  through the keyboard in the original iOS screenshot filed with bug #6–#8.
- **Strong hypothesis — this is ours, not Apple's.** `hooks/useComposerPanel.ts`
  (`panelVisibleSV`, ~line 380) deliberately **paints the emoji grid at opacity 1 behind the
  keyboard** whenever the keyboard is essentially fully up, as a preload so that opening the
  panel reveals an already-rendered grid. Its own comment says the panel "is either behind
  the keyboard or in the collapsed resting spacer". That is correct on any platform with an
  **opaque** keyboard — Android, and iOS < 26. iOS 26 made the system keyboard translucent,
  so the preloaded emoji faces (yellow!) now show through.
- **Same bug class as #6–#8:** iOS 26 made a native surface see-through, revealing something
  we always drew behind it. Nothing about it is visible from Android.
- **Fixed on `feat/rn-channel-header` (2026-08-01):** `panelVisibleSV` now paints the grid
  only while the panel is actually open. The mount latch is untouched, so the ~120-node
  build still happens ahead of time; only the rasterisation moved to the tap frame. Applied
  on both platforms on purpose — an iOS-only paint path is one this project cannot test.
- **Android pre-check before this reaches iOS:** in a chat, type to raise the keyboard, then
  tap the emoji button. The panel should appear as the keyboard slides away with no stutter
  or blank frame. That is the only thing this change can plausibly regress, and it regresses
  identically on both platforms, so Android is a real test of it.
- **If iOS still shows artifacts after this:** the panel is no longer the culprit. Next
  suspect is the tab bar, which the design doc's transition matrix also leaves at opacity 1
  and merely "covered" by the keyboard. See the callout under that matrix in
  `.agents/docs/composer-keyboard-emoji-panel.md`.
- **Do NOT fix a hitch by restoring the preload** — that reinstates this bug. The next lever
  is an opaque scrim above the panel while the keyboard is up.

### 11. Farcaster re-import sheet is usable with the keyboard up 🔲
**▶ Ask:** "In a dev build, go to Account → Settings, find the dashed 'Farcaster re-import
sheet' box, expand it and tap Open. Tap the text box so the keyboard comes up. Can you still
see the text box and both buttons? Then: does pressing Return close the keyboard, and does
tapping the dimmed area above the sheet close it too?"
**Pass:** input + Cancel + Import all stay visible above the keyboard; Return closes the
keyboard; a tap on the dim area closes the keyboard (a second tap closes the sheet).
**Fail:** anything sits behind the keyboard, or the keyboard can't be dismissed.

**Context (agent):**
- **What:** upstream issue #78, reported twice from iPhone (TestFlight 1.1.0 b55, and again
  2026-07-19). The sheet was bottom-anchored inside a raw `<Modal>` with no keyboard
  avoidance, an inert backdrop `View`, and a `multiline` input — so the keyboard covered the
  entire sheet and none of drag / tap-outside / Return dismissed it. Full writeup:
  `.agents/issues/2026-06-12-reimport-sheet-keyboard-covers-and-traps.md`.
- **Why this one IS Android-testable, unusually:** an RN `<Modal>` gets its own window, and
  `KeyboardProvider` sets modal windows to `SOFT_INPUT_ADJUST_NOTHING`
  (`ModalAttachedWatcher.kt:96`), so Android never resized it either. The Android run is
  therefore real signal here — but only for the lift. The iOS-specific parts are still the
  keyboard *height and timing* and the `submitBehavior` Return handling, which goes through
  `RCTBackedTextInputDelegateAdapter.mm` rather than Android's `ReactEditText`.
- **Reachability:** the sheet has no product entry point unless the custody key is missing
  from SecureStore while the profile still claims a fid. Hence the `__DEV__` panel
  (`components/dev/FarcasterReimportPanel.tsx`) — it will not be in a TestFlight build, so
  an external iOS tester cannot run this Ask. It needs an internal dev build.
- **JS-only** — ships over OTA once verified.
- **If it FAILS on iOS:** if the card is lifted but by the wrong amount, the suspect is
  `insets.bottom` being double-counted (iOS home-indicator inset is inside the keyboard
  frame). If Return still inserts a newline, `submitBehavior` isn't reaching the native
  view — check the Fabric path in `RCTTextInputComponentView.mm` (`getSubmitBehavior`).

### 12. In-app browser link mode: chrome, native hand-off, and the mini app regression arm 🔲
**▶ Ask:** "Tap a normal web link (a news article) in a Space chat. (a) Is there an ETH
wallet address in the bar at the top? There should NOT be. (b) Tap 'Open in browser' at the
bottom right — does your normal browser open on that same page? (c) Go back into the app,
tap a YouTube link in a chat — does the YouTube app itself open, not a browser inside
Quorum? Try both a video link and a plain `youtube.com` homepage link — both should leave
the app. (d) Now open a mini app from the Apps launcher — is the wallet address back in the
top bar, and does signing still work?"
**Pass:** (a) no address, (b) real browser opens the same page, (c) YouTube app opens,
(d) address present and signing works.
**Fail:** note which of a–d, and whether the sheet closed without anything happening.

**Context (agent):**
- **What:** split `BrowserModal` into `mode: 'link' | 'miniapp'`, added YouTube hand-off,
  rebuilt the link-mode chrome, deleted the duplicate `app/browser.tsx` route. Plan:
  `.agents/issues/.open/2026-08-10-in-app-browser-link-handling-plan.md`.
- **(d) is the regression arm and must not be skipped.** Everything mini-app-shaped is now
  behind an `isLink` gate; the whole design rests on those gates being no-ops in miniapp
  mode. If the wallet chip is missing or signing breaks in a mini app, a gate is inverted.
- **Why iOS may differ:**
  - **`Platform.select` branch (new):** `LINK_MODE_USER_AGENT` in `components/BrowserModal.tsx`
    sends a Safari string on iOS and a Chrome string on Android. **The Android run exercises
    only the Android branch** — the iOS UA string has never been sent by anything. If a site
    renders oddly *only* on iPhone, suspect this first.
  - **Safe-area insets:** the new link-mode footer (`styles.navigationBarLink`) applies
    `insets.bottom` the same way the mini app footer does, but it is a different layout
    (`space-between` with a pill button, not `space-around` icons). Home-indicator geometry
    differs from Android's nav bar.
  - **Hand-off mechanics differ by construction:** (c) resolves through **iOS Universal
    Links**, Android through **verified App Links**. These are different OS subsystems, so
    an Android pass is no evidence for iOS. If YouTube opens in Safari instead of the app,
    that is the Universal Link not resolving, not our code — check the YouTube app is
    installed and that the user has not previously chosen "open in browser" for that domain.
- **JS-only** — ships over OTA once verified.
- **If (b) FAILS silently** (sheet closes, nothing opens): that is the *old* bug returning.
  `handleOpenInBrowser` deliberately no longer calls `Linking.canOpenURL` and now returns
  early (leaving the sheet open) with a toast on rejection. A silent close means something
  restored the `canOpenURL` gate.

> **Cross-cutting note for #6–#9:** all four are the same shape — a native iOS surface
> behaving differently from its Android counterpart, invisible from this dev loop. Before
> writing any new navigation-header, chrome or composer code, read
> `.agents/docs/ios-ui-pitfalls-android-only-testing.md`.

---

## Verified

_(none yet — move ✅ items here with the date + tester)_

---

*Last updated: 2026-08-10*
