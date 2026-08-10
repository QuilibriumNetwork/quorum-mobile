---
type: task
title: "In-app browser: split link mode from miniapp mode, hand off YouTube to the native app, rebuild the chrome"
status: in-progress
priority: high
created: 2026-08-10
updated: 2026-08-10
depends_on: []
blocks: []
---

# In-app browser: link mode, native app handoff, chrome rebuild

## Status

Slices 1–5 are implemented on `feat/in-app-browser-link-mode`. Awaiting the
device pass in [Verification](#verification) — until that runs, nothing here is
confirmed on real hardware.

**Automated checks (MEASURED):** `tsc --noEmit` 11 errors, identical to the
master baseline of 11 (all in untouched files). ESLint on touched files 17
problems vs 18 on master. Jest 750/750 across 57 suites, including 42 new
`shouldOpenExternally` cases. Both guards in that predicate were revert-checked:
removing the scheme guard reddens 3 tests, removing the leading dot from the
host suffix test reddens 3 others.

**An independent review agent** verified the miniapp no-op claims against the
actual `react-native-webview` and `@farcaster/miniapp-host` sources, and
confirmed the link-mode security cut is closed with no reachable path from a
page to the SDK, the wallet address, or a signing prompt.

### Where the plan turned out to be wrong

Recorded because the plan asserted these confidently and they did not survive
contact with the code or the device.

1. **"Non-http schemes dead-end" (§6) is wrong.** `react-native-webview` applies
   `originWhitelist` *before* calling `onShouldStartLoadWithRequest`, and already
   routes anything failing it to `Linking.canOpenURL`/`openURL` itself
   (`WebViewShared.js`, `createOnShouldStartLoadWithRequest`). A `mailto:` was
   never dead. It did fail *silently* when `canOpenURL` returned false — only a
   `console.warn` — so link mode now widens `originWhitelist` to `['*']` to take
   ownership and surface a toast. Real, but smaller than described.
2. **"YouTube auto-hands-off" was implemented too narrowly at first.** The
   original rule was "playable content only", on the assumption that channel and
   search pages behaved fine in the WebView. Testing showed the bare
   `https://youtube.com` homepage hits the same bot wall. The rule is now **any
   YouTube host**: the wall exists because our WebView carries no YouTube
   session, and that is true of every page on the domain, not just videos.
3. **Slice 4's "confirm before deleting" found the opposite of what was
   expected.** `BrowserLink` is live (`components/Chat/MessagesList.tsx`), and
   `app/browser.tsx` was also reachable from `CastThreadModal` and
   `BoundChannelFeedPanel`. All three were repointed at the overlay before the
   route was deleted. Separately, `BoundChannelFeedPanel` has **no mount points
   at all** — it is dead code, unrelated to this work, and left alone.
4. **`handleOpenInBrowser` is shared with the miniapp footer**, so its fix is the
   one place this work does not leave the miniapp path untouched. A failed
   external open now keeps the sheet open with a toast instead of closing as if
   it had worked. Deliberate: the silent close was a bug in both modes.

### Deliberately not done

- The **user-agent theory remains INFERRED.** Link mode now sends a real mobile
  browser UA instead of `"warpcast"`, which is an improvement regardless, but
  nothing here measures whether the old UA was what triggered YouTube's wall.
  Since YouTube links no longer reach the WebView at all, the user-visible
  symptom is resolved either way. The control-arm experiment in
  [Verification](#verification) is still worth running if the wall shows up on
  another site.
- The **YouTube parser was left where it is.** An earlier draft extracted
  `parseYouTubeUrl` into `utils/` so link routing could reuse it; once the rule
  became host-based that dependency vanished, and the extraction was reverted
  rather than kept as unjustified churn in a component the Farcaster feed uses.

## Summary

Tapping a link in chat opens `BrowserModal` — the **same component, with the same
wallet bridge and the same fake user agent, that hosts Farcaster miniapps**. The
operator's suspicion was right: the link browser was never designed, it was
inherited wholesale from the miniapp browser.

Three consequences, in descending order of user pain:

1. YouTube shows a sign-in / "confirm you're not a bot" wall inside the WebView.
2. Links that a native app could handle (YouTube above all) never reach that app.
3. The chrome is miniapp furniture: a wallet address in the header of a random
   website, a five-icon footer where one icon is an unlabelled compass, and a
   header + footer that between them eat a large slice of a phone screen.

This plan fixes the browser and the link routing. **The YouTube facade in chat is
explicitly out of scope** and is recorded as a follow-up (see
[Out of scope](#out-of-scope--follow-ups)).

`type: task` because the headline deliverables (a link mode, native app handoff)
do not exist yet; the defects listed below are consequences of that absence, and
this plan closes them.

---

## What is actually there today

Every claim below is READ from the current tree, with the pointer. Inferences are
labelled as such and none of them are load-bearing without a test.

### 1. One component serves both link and miniapp

`context/MiniappOverlayContext.tsx:108-122` mounts a single `BrowserModal` for
everything. Both chat surfaces route plain links into it:

- Space chat: `app/(tabs)/spaces/[id]/[channelId].tsx:190-194`
- DMs: `app/(tabs)/messages/dm/[id].tsx:215-219`

Both call `openMiniapp({ url, isQNative: false, allowInsecureLAN: true })`. The
call is literally named `openMiniapp`. A link from a stranger in a Space is
handed to the miniapp host.

### 2. The user agent is `"warpcast"`

`components/BrowserModal.tsx:1060` sets `userAgent="warpcast"` — not a real
browser UA string, a seven-character token, chosen for Farcaster miniapp
compatibility.

**INFERRED, not measured:** this is the leading candidate for the YouTube auth
wall. YouTube serves a verification challenge to clients whose UA it cannot place.
This must be confirmed by test before it is treated as the cause — see
[Verification](#verification). It is cheap to falsify and cheap to fix if true.

### 3. The header carries miniapp furniture

`components/BrowserModal.tsx:1006-1013` renders the connected-wallet chip —
`activeWallet.address.slice(0, 4)…slice(-3)`, tappable to open a wallet selector.
That is the "ETH address" the operator spotted.

For a miniapp it is correct and important: it says which wallet the dapp can see.
On a news article it is noise, and arguably worse than noise, because it implies a
wallet is connected to a site that never asked for one.

Vertical budget, top to bottom: a 5% screen gap (`SHEET_TOP`, `:904`), a grab
handle, then a URL pill with 10pt vertical padding wrapping two text rows (domain
at 14pt, page title at 11pt). Roughly 80pt of chrome before a pixel of page.

### 4. The footer

Five equal-weight icons (`components/BrowserModal.tsx:1115-1168`):

| Icon | Handler | Works? |
|---|---|---|
| ◀ back | `:849-858` | **Yes.** Gated on `canGoBack` from `onNavigationStateChange` (`:841-847`). Defers to the miniapp SDK's `backEnabled` first, which is dead weight in link mode. |
| ▶ forward | `:860-864` | **Yes.** Gated on `canGoForward`. |
| ↻ reload | `:866-870` | Yes. |
| ⇪ share | `:872-880` | Yes. Empty catch, but cancelling a share sheet is not an error. |
| 🧭 compass | `:882-892` | **Yes, but silently.** |

So: the arrows do work. The compass is `handleOpenInBrowser` — `Linking.canOpenURL`
then `Linking.openURL`, then close. It is the "open in the real browser" button.

Two problems with it:

- **It fails silently.** If `canOpenURL` returns false there is no `else`, and the
  `catch` is empty (`:888-890`). The sheet closes and nothing happens. The user
  cannot tell success from failure.
- **`IconSymbol name="safari"` maps to `tabler('IconCompass')`** (`components/ui/IconSymbol.tsx:169`).
  On iOS the intent was Safari's compass, which is the platform convention (see
  [Prior art](#prior-art-how-other-messengers-do-this)); rendered as a generic
  tabler compass among four other icons, it reads as nothing.

### 5. A second browser exists, and its compass is a stub

`app/browser.tsx` is a separate route with near-identical chrome. Its
`handleOpenInBrowser` (`:343-347`) is:

```ts
const handleOpenInBrowser = () => {
  // In a real app, you would use Linking.openURL(currentUrl)
  // For now, we'll just go back
  router.back();
};
```

A genuinely dead button. Reached via `components/BrowserLink.tsx:29-35`, whose own
`openInApp={false}` branch (`:36-38`) is also an empty stub with the same comment.

### 6. Non-http schemes dead-end

`BrowserModal`'s WebView (`:1030-1081`) sets no `onShouldStartLoadWithRequest`.
A `mailto:`, `tel:`, `intent:` or app deep link encountered inside the page is
handed to the WebView, which cannot load it. There is likewise no
`setSupportMultipleWindows`/`onOpenWindow` handling, so `target="_blank"` links do
nothing on Android.

### 7. The YouTube pieces already exist, just not in chat

`components/SocialFeed/media/YouTubeEmbed.tsx` is complete and working:

- `parseYouTubeUrl` (`:145`) handles `watch`, `youtu.be`, `shorts`, `embed`,
  `live`, `/v/`, and playlists — richer than `quorum-shared`'s
  `extractYouTubeVideoId` (`quorum-shared/src/utils/youtubeUtils.ts:24`).
- `extractYouTubeMatchesFromText` (`:216`) with dedupe across URL forms.
- A real inline player and an "open on YouTube" fallback (`:54-77`).

Used by the Farcaster feed (`components/SocialFeedModal.tsx:1589`,
`components/SocialFeed/views/ThreadDetailView.tsx:556`). **Never used by chat.**
Chat links are inline `<Text onPress>` runs with no YouTube branch at all
(`components/Chat/MentionableText.tsx:636-654`).

### 8. Desktop's facade is sender-side — which is why the handoff matters most

Worth stating precisely, because it changes the priority:

- `generateYouTubePreviews` defaults to **false** (`quorum-desktop/src/hooks/business/user/useUserSettings.ts:82`).
- The Privacy tooltip (`quorum-desktop/src/components/modals/UserSettingsModal/Privacy.tsx:275`):
  *"When on, your device fetches thumbnails from YouTube for the links you send,
  which reveals your IP to Google. When off, recipients see a plain link instead."*
- `YouTubeFacade` takes `thumbnailSrc` as a **pre-resolved data URI**
  (`quorum-desktop/src/components/ui/YouTubeFacade.tsx:10-11`) — the thumbnail
  travels inside the message.

So the facade only renders when the **sender** opted in. With the default setting,
the recipient sees a plain link. **Plain links are the common case, not the edge
case** — which is exactly why fixing the tap target is worth more right now than
building the facade, and why doing the browser first is the right call.

---

## Prior art: how other messengers do this

The operator asked how Telegram handles the "open externally" affordance rather
than guessing. Researched rather than assumed:

- **Telegram iOS** puts a **Safari icon in the bottom-right corner** of the in-app
  browser. Icon-only, no label.
- **Telegram Android** puts **"Open in browser" / "Open in Chrome" in a top-right
  three-dot overflow menu**, as a labelled row.
- **Telegram also ships a global setting**: Android under Settings → Chat Settings,
  iOS under Settings → Data and Storage, to choose the in-app browser vs the
  default browser app.
- **Facebook/Messenger** moved the equivalent out of the overflow menu into
  Settings → Media → "Links open externally".

Conclusions for us:

1. **The current bottom-right placement is right.** It is not misplaced — it is
   unlabelled, visually generic, buried among four peers of equal weight, and
   silent on failure. Fix those, do not move it.
2. **Do not copy Telegram's iOS/Android split.** See
   [Why this is not platform-forked](#why-this-is-not-platform-forked). Their
   split is incidental to their history, not a principle, and it does not survive
   contact with this codebase's stated position on platform branches.
3. **Label the control; do not ship a bare icon.** Telegram's bare iOS glyph works
   because **Safari's compass is a system-recognised app icon** — users read it as
   "that other app". Ours is a generic Tabler compass
   (`components/ui/IconSymbol.tsx:169`), and we cannot do better: we cannot ship
   Safari's glyph on Android, and the user's default browser varies. We inherit
   the bare-icon treatment without inheriting what made it legible.

### Why this is not platform-forked

An earlier draft of this plan proposed a bottom-right icon on iOS and a top-right
overflow row on Android, copying Telegram. That was wrong and is retracted.

This project has already taken a position, in
`components/Chat/SpaceChatArea.tsx:235-236`:

> *"This removed the last `Platform.OS === 'ios'` branch in this file — which
> mattered, because an iOS-only layout branch is a branch this project cannot
> test."*

That is consistent with the whole tree. Every `Platform.OS` branch in
`components/` and `app/` is platform **mechanics** — keyboard event names,
`KeyboardAvoidingView` behavior, iOS-only Haptics, Android `blurRadius`, an
accessibility role, a 6-vs-10pt padding nudge. **Not one** is a design divergence,
and the app's geometry comes from a single skin (`@/theme/skins/geometry`) applied
identically to both platforms.

The cost is concrete and lands on the reviewer: a forked control doubles the
hand-tested device matrix for a surface nobody can verify by reading a diff.

**One design, both platforms.**

Sources: [Telegram's built-in browser](https://smartbotsland.com/blog/social-networks/telegram/telegram-updates/telegram-internal-browser/),
[Telegram on choosing your browser](https://x.com/telegram/status/1577644788161167362),
[Fixing links not opening in Telegram](https://www.guidingtech.com/how-to-fix-links-not-opening-in-telegram/),
[Selecting the default browser in Facebook on Android](https://jefftkaufman.substack.com/p/selecting-the-default-browser-in-facebook-on-android).

---

## Decisions taken

| Question | Decision |
|---|---|
| Separate the two browsers how? | **`mode: 'link' \| 'miniapp'` prop on `BrowserModal`.** One component; link mode does not mount the miniapp bridge, wallet chip or approval modals. No duplicated WebView plumbing, and the miniapp path is untouched so it cannot regress. |
| YouTube rendering in chat | **Deferred.** Desktop's facade is not fully ready either; the sender-side setting means plain links dominate. Ship the browser and the handoff first. |
| How aggressively do links leave the app? | **YouTube auto-hands-off; everything else opens internally** with a clear, working external-open affordance. No curated domain list yet. |
| Shape of the external-open affordance | **A labelled "Open in browser ↗" action in the footer, identical on both platforms.** Placement stays bottom-right where it already is. Explicitly **not** platform-forked — see [Why this is not platform-forked](#why-this-is-not-platform-forked). A global setting is a candidate follow-up, not slice-one work. |

---

## The plan

Vertical slices. Each ends in something observable on a device without reading a
diff. Order is by user value, and each slice is independently shippable.

### Slice 1 — YouTube links open the YouTube app

**Outcome:** tap a YouTube link in any chat. The YouTube app opens if installed;
otherwise the system browser. The in-app browser never appears.

- Add `utils/linkRouting.ts` with `shouldOpenExternally(url)`. First rule:
  `parseYouTubeUrl(url) !== null`, reusing the existing parser from
  `components/SocialFeed/media/YouTubeEmbed.tsx` (do **not** reimplement it, and do
  **not** swap in `quorum-shared`'s narrower `extractYouTubeVideoId` — it does not
  cover shorts or playlists).
- In both `handleLinkPress` sites
  (`app/(tabs)/spaces/[id]/[channelId].tsx:190`, `app/(tabs)/messages/dm/[id].tsx:215`),
  branch to `Linking.openURL(url)` when the rule matches.
- **Do not gate on `Linking.canOpenURL`.** For https URLs it adds a failure mode
  without adding information, and it is half the reason the compass fails silently
  today. Call `openURL` and handle the rejection.
- On rejection, surface a toast. Silence is the current bug; do not reproduce it.

Handoff behaviour is a platform guarantee, not a trick: iOS resolves Universal
Links to the owning app, Android resolves verified app links (`autoVerify`) the
same way. Both fall back to the browser when the app is absent.

### Slice 2 — Links no longer look like miniapps

**Outcome:** open any non-YouTube link from chat. No wallet address in the header,
noticeably more page visible, and the footer reads as a browser.

- Add `mode?: 'link' | 'miniapp'` to `BrowserModal`, defaulting to `'miniapp'` so
  every existing caller is unchanged. `MiniappOverlayEntry` carries it through
  `MiniappOverlayContext`.
- Chat surfaces pass `mode: 'link'`. Consider renaming the context method to
  `openUrl` with `openMiniapp` kept as an alias — the current name is actively
  misleading at the call site.
- In link mode:
  - Do not render the wallet chip (`:1006-1013`).
  - Do not mount `MiniAppApprovalModal`, `SwapModal`, `SendModal`, or the compose
    and profile/cast overlays.
  - **Do not call `useMiniAppBridge`.** Hooks cannot be called conditionally
    (see `AGENTS.md` → React Hooks Rules), so this is the one part of the slice
    that is not a simple `&&`. Two options, decide during implementation:
    extract the WebView + chrome into a shared child and let two thin parents
    (`LinkBrowserHost`, `MiniappHost`) own their own hooks; or give the bridge an
    `enabled` flag it honours internally. The extract is cleaner; the flag is
    smaller. Whichever is chosen, `bridgeReady` must not gate WebView render in
    link mode — today `:1029` blocks the WebView until the bridge is ready.
  - Collapse the header to one row: lock glyph, domain, close. Drop the page-title
    second row, or move it to a single truncated row with the domain.
- Fix `handleGoBack` (`:849`) to skip the `backEnabled` SDK branch in link mode.

### Slice 3 — The external-open button works and is legible

**Outcome:** the bottom-right icon reliably opens the current page in the real
browser or its owning app, and when it cannot, it says so.

- Rewrite `handleOpenInBrowser` (`:882-892`): drop `canOpenURL`, `await openURL`,
  toast on rejection, and only close the sheet **after** a resolved open.
- **One layout on both platforms** — no `Platform.OS` branch in this chrome. See
  [Why this is not platform-forked](#why-this-is-not-platform-forked).
- **Label it.** The control becomes a labelled **"Open in browser ↗"** action, not
  a bare compass. This is the fix for the operator's actual complaint (the icon
  means nothing) and it sidesteps the unsolvable problem of picking a glyph for a
  browser we cannot name.
- **Declutter by moving reload into the header**, next to the URL — which is
  already what the older route does (`app/browser.tsx:415-417`), so it is an
  existing in-repo pattern rather than a new invention. That leaves a four-item
  footer:

  ```
  header   [🔒 example.com                    ↻   ✕]
  footer   [ ◀    ▶              ⇪ Share   Open in browser ↗ ]
  ```

- Give the external-open action visual weight above the bare nav icons; it is the
  one footer item that is a decision rather than a nudge.
- A global "open links in" setting stays a follow-up, not slice-3 work.

### Slice 4 — Delete the dead second browser

**Outcome:** no route in the app has a button that does nothing.

- `app/browser.tsx` and `components/BrowserLink.tsx` are the older path. Establish
  whether anything still reaches them (`BrowserLink` had no callers in the sweep
  for this plan — confirm before deleting).
- If dead: delete both. If live: point them at `MiniappOverlayContext` and delete
  the duplicated chrome.
- Either way, `app/browser.tsx:343-347` and `components/BrowserLink.tsx:36-38`
  must not survive as stubs.

### Slice 5 — Non-http schemes and new windows

**Outcome:** tapping a `mailto:` in a page opens the mail app; a `target="_blank"`
link opens instead of doing nothing on Android.

- Add `onShouldStartLoadWithRequest` to the WebView: for any non-`http(s)` scheme,
  return `false` and `Linking.openURL` it.
- Route in-page navigations that match `shouldOpenExternally` out to the native
  app too, so a YouTube link followed *inside* the browser behaves like one tapped
  in chat.
- Handle `target="_blank"` (`setSupportMultipleWindows` + `onOpenWindow`, or load
  the target in the same WebView).

---

## Verification

Per the standing rule that a fix without an instrument is not a fix, and that the
user-agent theory is inference until measured:

1. **Falsify the UA theory before relying on it.** Load a YouTube watch URL in the
   current `BrowserModal` and record the wall. Change only `userAgent` to a real
   mobile Safari/Chrome string and reload the same URL. If the wall persists, the
   cause is elsewhere (cookies, `domStorageEnabled`, WebView vintage) and this
   plan's slices 2–5 still stand while the diagnosis continues. **Control arm:**
   load a non-Google site under both UAs; it should be unaffected. If both arms
   change, the instrument is wrong.
2. **Unit tests** on `shouldOpenExternally`: every form `parseYouTubeUrl` accepts,
   plus negatives that must *not* hand off (a youtube.com channel page, a URL with
   `youtube.com` in a query parameter, a lookalike host).
3. **Revert-the-fix check.** For each new test, revert the change and confirm the
   test goes red. A test that passes either way is worse than no test.
4. **Device pass** (the residue that genuinely needs a human), one scripted
   sequence with pass/fail written in advance:
   - YouTube link in a Space, YouTube app installed → YouTube app opens. PASS/FAIL.
   - Same, app uninstalled → system browser opens. PASS/FAIL.
   - Non-YouTube link → in-app browser, **no wallet address in header**. PASS/FAIL.
   - "Open in browser" in the footer → system browser opens. PASS/FAIL.
     **Same control, same place, same label on both platforms** — if the two
     devices need different instructions here, slice 3 was built wrong.
   - Open a miniapp from the launcher → wallet chip present, signing still works.
     PASS/FAIL. **This is the regression arm and must not be skipped.**

---

## Out of scope — follow-ups

- **YouTube facade in chat.** Mirror desktop exactly: a standalone URL on its own
  line renders a facade, a URL inline in a sentence stays a plain link, and the
  whole thing is contingent on the **sender's** `generateYouTubePreviews` setting
  and the thumbnail data URI travelling in the message. Mobile has the player
  (`YouTubeEmbed`) but not the sender-side plumbing, and desktop's own
  implementation is not fully settled. Blocked on that, not on this plan.
  Note that a facade must render as a **block sibling below** the message body —
  `MentionableText` renders links as inline `<Text>` runs and cannot host one.
- **A global "open links in" setting**, matching Telegram and Messenger. Worth it
  once the browser is good enough to be a real choice.
- **Curated app-handoff domain list** (maps, x, spotify). Deliberately deferred:
  each domain is a judgement call and users will disagree.
- **Consolidating the two YouTube parsers.** Mobile's `parseYouTubeUrl` is strictly
  richer than `quorum-shared`'s `extractYouTubeVideoId`. Promoting mobile's into
  shared would benefit desktop, but doing it during this work risks a silent
  regression on both clients for no user-visible gain.

---

*Last updated: 2026-08-10*
