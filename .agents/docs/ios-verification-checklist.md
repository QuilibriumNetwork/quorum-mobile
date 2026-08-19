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

### 13. Channel header call buttons: the "starting a call" spinner 🔲
**▶ Ask:** "Open a Space channel and tap the video call icon in the top bar. While it is
starting, do the two call icons cleanly swap to a single spinner without the header jumping,
shifting the title, or leaving a gap? When it fails and the error toast appears, do both
icons come back exactly as they were?"
**Pass:** header geometry is identical before, during and after; both icons return.
**Fail:** note whether the bar changed height, the title moved, or the icons did not return.

**Context (agent):**
- **What/when:** shipped with the space-call banner fix (branch
  `fix/space-call-stale-banner`, 2026-08-10). Android-only so far.
- **The change:** [ChannelHeader.tsx](../../components/Chat/ChannelHeader.tsx) now renders
  a single `ActivityIndicator` in place of the video + phone `TouchableOpacity` pair while
  `startingCall` is true. Starting a call blocks on the room join first (that reorder is the
  actual bug fix), which takes seconds, so the buttons needed a busy state.
- **Why iOS may differ:** two icon buttons are replaced by one spinner, so the header's
  right-hand slot changes intrinsic width mid-interaction. `ScreenHeader` is drawn in React
  Native, not by UIKit, so this should behave — but iOS 26 Liquid Glass treats header
  controls specially (see #8) and `ActivityIndicator` has a different intrinsic size on iOS
  than on Android, which is exactly the class of difference this dev loop cannot see.
- **Expected in production today:** the spinner will always end in the "Could not start the
  call" toast, because the server serves no call routes
  (`.agents/issues/2026-08-10-space-calls-dead-endpoints-and-stale-banner.md`). That is the
  correct behaviour to observe here — this item is about the header's geometry, not the call.
- **If it FAILS:** give the spinner a fixed-width wrapper matching the two icons' combined
  width rather than swapping the subtree, so the slot's width never changes.

> **Cross-cutting note for #6–#9 and #13:** all of them are the same shape — a native iOS
> surface behaving differently from its Android counterpart, invisible from this dev loop.
> Before writing any new navigation-header, chrome or composer code, read
> `.agents/docs/ios-ui-pitfalls-android-only-testing.md`.

### 14. Account screen: the sticky nav pill row under rubber-band scrolling 🔲
**▶ Ask:** "Open the Account tab. Scroll down: the profile card should slide away and the
Profile/Premium/Settings pill row should stop at the top and stay there. Then (a) while the
row is pinned, tap a different pill — does the page jump back to the very top, with the
profile card visible again? And (b) back at the very top of the list, pull DOWN hard and let
go. Does the pill row stretch, detach, float over the profile card, or leave a gap while the
list bounces back?"
**Pass:** (a) the new section always starts at the top, with no leftover offset from the
previous one; (b) the row pins flush to the top on the way down, and during the bounce it
stays attached to the content, with the background behind it opaque at all times.
**Fail:** for (a) note whether it stayed mid-page or animated visibly; for (b) note whether
the row stretched, hovered, or let content show through it.

**Context (agent):**
- **What/when:** shipped with the account single-page-scroll change (branch
  `feat/settings-single-page-scroll-sticky-pills`, 2026-08-16). Android-only so far.
- **The change:** [UnifiedProfileScreen.tsx](../../components/UnifiedProfileScreen.tsx) now
  wraps the profile card, the pill row and the section body in ONE `ScrollView` with
  `stickyHeaderIndices={[1]}`. [ProfileModal.tsx](../../components/ProfileModal.tsx) takes a
  new `externalScroll` prop that makes its section body a plain `View`, so there is exactly
  one vertical scroller on the page. Because the sections now SHARE that scroller, changing
  section rewinds it to `y: 0` — otherwise the new section inherits the old one's offset.
- **Why iOS may differ:** `stickyHeaderIndices` is the one `ScrollView` feature with a
  genuinely different implementation per platform. iOS drives it natively and combines it
  with **rubber-band overscroll**, which Android does not have (Android shows a glow/stretch
  instead). The pull-down-and-release case therefore has no Android equivalent to observe.
- **If it FAILS:** the usual fix is to move the sticky row's padding and background onto the
  wrapper (already done — `styles.pillRowSticky`) and, failing that, to give the wrapper an
  explicit height so the native sticky implementation has a fixed box to pin.
- **Structural regressions are covered by a test**, so this item is only about the *visual*
  behaviour: `__tests__/migrated/UnifiedProfileScreenScroll.test.tsx` fails if the sticky
  index stops pointing at the pill row, if `externalScroll` is dropped, if the rewind stops
  firing on a section change, or if it starts firing on every render.

### 15. Bundled Inter renders everywhere, and nothing clips at large Dynamic Type 🔲
**▶ Ask:** "Open a Space channel, a DM, and the Farcaster feed. First: does all the text
look like ONE typeface, or do some labels/buttons look subtly different from the message
text next to them? Second: is any bold text smeared or fuzzy rather than crisp? Third: in
Settings → Accessibility → Display & Text Size, turn Larger Text up high, reopen the app,
and check whether usernames are cut off at the top or bottom."
**Pass:** one typeface throughout, crisp bold, no clipped names at large text.
**Fail:** say which of the three, and where (channel / DM / feed).

**Context (agent):**
- **What/when:** typography + bundled font, branch `feat/bundle-inter-and-chat-typography`
  (2026-08-19). Android-verified only; the reporter has no iOS device, so this item is the
  ONLY iOS signal this work will get before release.
- **The change:** the app no longer uses `'System'`. Five static Inter faces
  (400/500/600/700/900) are bundled and registered before first paint
  ([theme/uiFont.ts](../../theme/uiFont.ts)), and `DEFAULT_FONT_FAMILY` points at Inter.
  Chat messages, casts, usernames and cast author names are sized from
  `theme.textStyles.body` / `.headline` (16/22). 101 style blocks that set a weight with no
  family were swept onto the bundled font.
- **Why iOS may differ, part 1 — the typeface.** iOS previously rendered San Francisco,
  which Apple tunes with optical sizing and per-size tracking; Inter has neither for free.
  Expect a slightly different texture, and watch specifically for **faux-bold**: each weight
  is a separate file, so if a family and weight ever name different faces the platform
  synthesizes the gap. `yarn check:fonts` proves no such pair exists statically, but only
  eyes can confirm the rendering.
- **Why iOS may differ, part 2 — Dynamic Type.** `messageHeader` is a fixed-height box
  holding a `<Text>` whose `lineHeight` React Native scales by the OS font scale. Android
  tops out at 1.3 and **passed** with the name fully visible. iOS Dynamic Type reaches
  roughly 3x with accessibility sizes, so it has far more headroom to expose the same
  mechanism. The height is now `Skin.font(22) * PixelRatio.getFontScale()`, which should
  hold, but Android could not test past 1.3.
- **Built-in control arm:** emoji-only messages must look **identical** to before. Their
  size comes from `emojiOnlyScale × (style?.fontSize || 16)` in
  [MentionableText.tsx](../../components/Chat/MentionableText.tsx) — the fallback was
  already `16`, and the style now supplies a real `16`, so the computed value is unchanged.
  If emoji-only messages *do* change size on iOS, the problem is not this diff.
- **If it FAILS — mixed typefaces:** run `yarn check:fonts`. If it is green, the offending
  text is not a style block it can see (an inline `style={{}}` on a `<Text>`, or a
  third-party component) — grep the screen's file for `fontWeight` and check each has a
  family beside it.
- **If it FAILS — names clipped at large text:** `PixelRatio.getFontScale()` is read once
  when the stylesheet is built, so a mid-session Dynamic Type change does not re-apply.
  Confirm the app was **fully relaunched** before treating it as a real failure.
- **If it FAILS — Inter does not load at all** (everything looks like San Francisco): check
  the device log for the `[uiFont]` line. `Font.loadAsync` failures are deliberately
  non-fatal and fall back to the platform font, so a silent failure looks exactly like "we
  never shipped this".

### 16. Farcaster DM header: the linked-Quorum badge doesn't get clipped or crowd the name at larger text sizes 🔲
**▶ Ask:** "Open a Farcaster DM with someone whose profile is merged with Quorum (there's a
small link icon + `name.q` line under their name in the top bar). At your normal iPhone text
size, is that second line fully visible — not clipped top or bottom, and not overlapping the
message list below? Then go to Settings → Accessibility → Display & Text Size and raise
Larger Text a few notches (not the max), come back to that same DM, and check again."
**Pass:** the name and the badge line both stay fully visible and nothing overlaps the bar
below, at both text sizes. **Fail:** note whether it's the name or the badge that clips, and
roughly how far you had raised the slider.

**Context (agent):**
- **What/when:** commit bed2c21, `fix(chat): a Farcaster DM shows names again, not raw
  FIDs`. Wires `QuorumIdentityBadge` into `DMChatHeader` for a 1:1 Farcaster conversation
  whose counterparty has a merged Quorum profile — a second line under the name, inside
  `ScreenHeader`'s fixed `HEADER_BAR_HEIGHT = 44` bar.
- **The arithmetic:** at OS scale 1.0, name (`theme.textStyles.headline`, 16/22) plus the
  badge (fontSize 11, no explicit `lineHeight` set in `QuorumIdentityBadge.tsx`, so its real
  height is font-metric-dependent, estimated ~13-17px) total roughly 35-39px inside the 44px
  bar — it fits, but with only ~3-9px of headroom on either side. `ScreenHeader.tsx`'s
  `bar.height` is a hard constant; nothing there multiplies it by `PixelRatio.getFontScale()`,
  unlike `MessagesList.tsx:1837`'s `messageHeader`, which was fixed to do exactly that for the
  same bug class (`.agents/issues/.done/2026-08-19-chat-message-text-renders-at-react-native-default-14.md`).
  Both `Text`s scale with the OS font size but the bar does not, so the two-line block likely
  exceeds 44px well before Android's own previously-tested max of 1.3x — the estimate lands
  around scale ~1.15-1.25, inside normal Settings, not even into accessibility sizes.
- **Why iOS may differ:** iOS Dynamic Type's *normal* range already overlaps that estimated
  overflow threshold, and reaches roughly 3x at accessibility sizes (see item 15) — far past
  what Android's 1.3 cap was ever verified against for this two-line case. No `overflow:
  hidden` is set anywhere in `ScreenHeader`, so the likely failure mode is the badge (or the
  bottom of the name) bleeding into the message list below rather than being cleanly clipped.
- **Also worth confirming:** the badge pops in a beat after the header first renders (it waits
  on a `useQuorumIdentityForFid` fetch), so the header grows from one line to two live on
  screen. Check that this doesn't read as a jarring jump.
- **If it FAILS:** either scale `nameColumn`'s (or the whole bar's) height by
  `PixelRatio.getFontScale()` the same way `messageHeader` does, or cap the name/badge with
  `maxFontSizeMultiplier` so the two-line block can't exceed the room available. Also worth
  giving `QuorumIdentityBadge`'s text an explicit `lineHeight` (currently unset) so its size is
  a known quantity instead of platform/font-metric-dependent.

---

## Verified

_(none yet — move ✅ items here with the date + tester)_

---

*Last updated: 2026-08-19*
