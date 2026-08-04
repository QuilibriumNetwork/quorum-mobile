# Recap: Cassie's fork roll-up (06-19) — UI/UX context

**Why this doc:** Cassandra Heart landed a large fork roll-up on master on 2026-06-19
(commits `a677033` "roll up changes between forks" + merge `9079912`). It is **already in
our current branch** (`fix/composer-emoji-panel-transitions`) — both commits are ancestors of
HEAD, nothing to pull. This is context for UI/UX work going forward, so we don't trip over
changes we didn't make.

Scope: it's a feature roll-up from another fork, not a small commit (~36 files in `a677033`
plus asset re-compression in the merge). Below is only the UI/UX-relevant surface.

---

## 1. The one that bit us first: `package.json` `start` script (Windows breakage)

```diff
-    "start": "expo start",
+    "start": "EXPO_NO_METRO_LAZY=1 NODE_OPTIONS=--max-old-space-size=8192 expo start",
+    "start:lazy": "expo start",
+    "gen:icons": "node ./scripts/gen-tabler-registry.mjs",
```
`start` now uses POSIX env-prefix syntax → fails on Windows cmd (`'EXPO_NO_METRO_LAZY' non è
riconosciuto…`). She also added **`start:lazy`** (plain `expo start`) as the escape hatch.

**Our fix (2026-06-20):** both `.agents/scripts/dev-start-mobile.ps1` and
`dev-start-mobile-wifi.ps1` now call `yarn start:lazy` and set `$env:EXPO_NO_METRO_LAZY="1"`
in the `$env:` block. package.json left untouched (it's committed/shared). `EXPO_NO_METRO_LAZY=1`
disables Metro lazy bundling so the FULL bundle builds before our auto-launch fires.

## 2. Tabler icon system overhaul (real UI plumbing — affects every icon)

- **New:** `components/ui/tablerIconRegistry.ts` (GENERATED, +432 lines) +
  `scripts/gen-tabler-registry.mjs` + `gen:icons` npm script + `tabler-icons-subpath.d.ts`.
- **`IconSymbol.tsx`** no longer imports the `@tabler/icons-react-native` barrel (~6000 icons,
  Metro can't tree-shake in dev → ~14k modules/route → dev-server OOM). It now imports only
  the curated registry of icons we actually use.
- **UX consequence for us:** if you reference a NEW Tabler icon name in `IconSymbol`'s map,
  you MUST add it to the registry and regenerate (`npm run gen:icons`), or it renders **null**
  (IconSymbol's documented "unknown name → null" behavior). Don't assume any Tabler name
  "just works" anymore.

## 3. Composer `MessageInput.tsx` — small but in OUR bug's file

Changed the text input's vertical centering: added `alignSelf: 'center'` on the input,
because the pill uses `alignItems: stretch` and **iOS ignores `textAlignVertical` on multiline
inputs** (a single line would stick to the top on iOS). `alignSelf: center` overrides the
stretch for the input only (buttons stay bottom-pinned). Removed the old "parent alignItems
center" comment.
- **Note for us:** this touches the same composer we just closed the drop-bug on, but it's a
  vertical-centering tweak, unrelated to the slide-in drop. iOS-motivated (we can't runtime-
  test iOS — review-only). Keep in mind if we revisit composer layout.

## 4. NEW user-facing surfaces: mini-apps / dapp browser

Brought in a whole mini-app + in-app browser feature set:
- **`app/browser.tsx`** — full-screen WebView mini-app host (wallet keys, Share, safe-area
  insets, approval modal).
- **`components/BrowserModal.tsx`** — mini-app browser modal (Farcaster cast compose, wallet
  selection, profile/thread views, tx signing).
- **`components/MiniAppApprovalModal.tsx`** — approval UI for wallet tx/message-signing
  requests from mini-apps (uses `BaseModal`, `WalletSelector`, `IconSymbol`). Security: UI
  only, signing happens in parent via SecureSigningService.
- **`components/MiniAppsModal.tsx`** — +217 lines (mini-app launcher/list).
- **`context/MiniappOverlayContext.tsx`** — global `openMiniapp()` overlay provider wrapping
  every tab.
- **Routing change (profile/notifications):** mini-app notification taps now call
  `openMiniapp({url})` directly via the global overlay, instead of bouncing through the wallet
  tab with a `?miniAppUrl=` param (the old path was fragile and likely why some taps didn't
  present the mini app). See `app/(tabs)/profile/index.tsx`.

## 5. Notifications — cold-start deep-link routing (behavioral UX)

- `app/_layout.tsx`: added cold-start notification handling — `processColdStartNotification()`
  reads the tap that launched the app from a killed state, queued until the router is ready
  (`useRootNavigationState().key` → `setNotificationNavigationReady()`). The live listener
  can't see the launching tap, so this fixes "tap notification from killed app → didn't route."
- New/expanded: `NotificationService`, `useUnifiedNotifications`, `useHaatzNotifications`,
  `services/farcaster/haatzNotifications.ts`, plus `notification_icon` assets across densities.
- **UX consequence:** notification taps (incl. from a fully-closed app) now navigate to the
  right screen. Worth a sanity check if we touch notification routing.

## 6. FlashList recycling crash-guards (stability, not visual)

Multiple feed/media components got a `recyclingKey={<source uri>}` prop:
`FrameEmbed`, `QuoteCast`, `ImageViewer`, `CachedAvatar`, `LiveSpacesStrip`, `AutoHeightImage`.
Prevents a use-after-free when a recycled FlashList row rebinds to a fresh (possibly animated)
image and the previous decoded backing store was purged under memory pressure. No visual
change — but if you add an `<Image>` inside a FlashList row, follow this pattern.

## 7. Copy change: Apex price $25 → $5/month

`ApexSubscribeModal.tsx` and `ProfileModal.tsx`: Apex subscription is now **$5/month** (was
$25). User-facing copy + the token-units quote comment. If we touch Apex copy, the number is $5.

## 8. Composer transition robustness pass (2026-06-20, branch `fix/composer-emoji-panel-transitions`)

Follow-up round on the composer ↔ keyboard ↔ emoji-panel choreography after the fork roll-up
surfaced device-level edge cases (Motorola Edge 50 Fusion, prod variant). Shipped fixes:
- **Tab bar getting stuck hidden** after emoji use — added a self-correcting UI-thread guard so
  `composerBottomBusySV` can't be left stuck (was a missed-clear on hand-off paths).
- **Tab bar visible OVER the panel in channels** (the open `2026-06-19` bug) — ROOT-CAUSED:
  the keyboard-settle handler released the bottom-busy flag unconditionally; in a slow channel
  subtree that settle lands AFTER the user taps emoji, releasing the flag while the panel is
  open. Fixed by guarding the height>0 release with `panelOpenSV !== 1` (matching the height==0
  branch). Bug doc moved to root-caused.
- **List scrolled DOWN when opening the panel from the keyboard** — used the keyboard library's
  `freeze` prop (purpose-built for dismiss-to-open-a-sheet) to stop the list chasing the
  dismissing keyboard. Gated on opened-from-keyboard so a COLD open still lifts the list.
- **Emoji panel cold-open now slides in** (was an instant snap) — spacer + list lift ramp over
  220ms; the list lift on cold open has a small acceptable lag (a per-frame follower attempt
  gave no improvement and was reverted — don't re-add it).
- **Scroll jump fixes** to the panel↔keyboard swap (footprint published as
  `max(0, panelHeight − liveKeyboard)` so panel + keyboard never double-count the list inset).
- See `.agents/docs/composer-keyboard-emoji-panel.md` (the design) +
  `.agents/issues/.done/2026-06-20-composer-emoji-panel-transitions.md` (this round).

## 9. Icon registry: `flask` + `ellipsis.vertical` (2026-06-20)

Concrete instance of the §2 rule: `flask` (a desktop-manifest icon name) had no mapping and
`ellipsis.vertical` was mapped but its `IconDotsVertical` component was missing from the
(stale) registry — both warned "no Tabler mapping, rendering nothing." Added the `flask` map
entry and reran `npm run gen:icons`. Reminder cemented: **any new IconSymbol map name needs a
registry regen** or it renders null.

---

## Quick reference — what to remember while doing UI work

- **Icons:** new Tabler name → add to registry + `npm run gen:icons`, else it's null (we hit this with `flask`/`ellipsis.vertical`, §9).
- **Composer:** input now `alignSelf: center` (iOS multiline centering); drop-bug closed/dev-only. Transition robustness pass shipped (§8) — tab-bar-stuck, tab-bar-over-panel, scroll-down-on-open, cold-open slide. Don't re-add a per-frame cold-open scroll follower (tried, no gain, reverted).
- **Mini-apps:** new `openMiniapp()` overlay is the way to present a mini app; don't route via wallet param.
- **Notifications:** cold-start taps route now; assets exist per density.
- **FlashList images:** always pass `recyclingKey` (crash-guard pattern).
- **Apex:** $5/month.
- **Dev scripts:** use `start:lazy`; `start` is POSIX-only (Windows-broken) by design.

*Last updated: 2026-06-20*
