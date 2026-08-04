---
type: report
title: "UI touchable audit findings — buttons/rows-in-disguise across quorum-mobile"
status: done
created: 2026-06-28
parent-task: ../issues/.open/2026-06-28-ui-button-consistency-audit-and-sweep.md
method: 5 parallel read-only agents, one per feature-area cluster
---

# UI touchable audit findings

Full classification of every touchable in `components/` + `app/` into **(A) button-in-disguise**
(→ `<Button>`), **(B) row-in-disguise** (→ `<ActionRow>`), **(C) legitimately bespoke** (keep, ideally
`SkinTouchable`). Drives the sweep in the parent task. Method: 5 parallel Explore agents, one per area.

## Headline result

The "~1,416 raw touchables" figure was **misleading in the alarming direction** — the app is in much
better shape than the raw count implied:

- **The vast majority are bucket C (legitimate)** and **already on `SkinTouchable`** (the skin-aware
  drop-in). Icon-only taps, avatars, cards, feed items, call controls, composer controls, gesture
  surfaces — all correctly bespoke. Raw `react-native` touchables that *should* be `SkinTouchable`
  are a small minority (mostly in SocialFeed embeds: `Pressable` in VideoPlayer, LiveSpacesStrip,
  AudioSpaceEmbed, FarcasterTokenEmbed; plus `AppTabBar`).
- **The row pattern is mostly already solved.** ActionRow/ActionRowGroup (from the 2026-06-15 audit)
  is widely adopted: MessageActionSheet, DMSettingsSheet, ChannelSettingsSheet, UserProfileModal,
  ShareInviteSheet are all migrated. Only a handful of inline rows remain.
- **The real, concentrated gap is BUTTONS.** ~105 labelled action buttons are hand-rolled instead of
  using the canonical `<Button>`, which is imported in only ~7 files. This is the actual prize.

### Consolidated counts (approximate)

| Area cluster | Bucket A (→Button) | Bucket B (→ActionRow) | Bucket C (legit) |
|---|---|---|---|
| SocialFeed | ~10 | 0 | ~45 |
| Call + Chat | 6 | 0 (all migrated) | ~69 |
| Loose `components/*.tsx` | ~42 | ~8 | ~40 |
| wallet / qns / apex | ~34 | ~8 | ~69 |
| ui / onboarding / shared / skins / app | ~14 | ~7 | ~70 |
| **Total** | **~105** | **~23** | **~290** |

## The 5 cross-cutting findings (this is the real deliverable)

These turn ~128 scattered edits into a small set of decisions. Address these and most of the long
tail collapses.

### Finding 1 — Confirmation-modal button pairs (HIGHEST value, lowest risk)
Every confirm/destructive modal hand-rolls an identical `Cancel` + `Confirm` button pair with
duplicate `cancelButton`/`primaryButton`/`confirmEnabled`/`confirmDisabled` styles:
`ConfirmDialog`, `TypeToConfirmModal`, `BlockUserModal`, `KickUserModal`, `MuteUserModal`,
`TransactionWarningModal`, `MiniAppApprovalModal`, `ReportModal`.
**`ConfirmDialog` and `TypeToConfirmModal` are shared shells** — converting just those two propagates
to many call sites. `disabled={!matches}` collapses two style objects into one `<Button disabled>`.
→ Convert the two shared shells first (thread a `loading?` prop through while doing it), then the
individual modals.

### Finding 2 — Canonical `<Button>` is missing variants (BLOCKER — do FIRST)
Several conversions can't be clean until `<Button>` grows a few **additive** capabilities. None break
existing usage:
- **`variant="success"`** — needed by: SpaceCallBubble "Join", InviteLinkCard "Joined",
  OffersModal "Accept", several governance vote buttons. (Currently green via raw `theme.colors.success`.)
- **An outlined/bordered variant** (transparent fill + border) — needed by: ProfileActionButtons
  "Message", SpaceSettingsModal "Leave Space", FarcasterReimportSheet "Cancel", NFTDetailModal
  "View on Explorer", SkinEditor `btnOutline` buttons. `secondary` has a fill; `ghost` has no border.
  Add `variant="outline"` (or a `bordered` prop).
- **A custom fill `color` (or named brand variants)** — needed by: wallet biometric Send/Swap
  (`#8B5CF6` purple), ApexSubscribeModal pay (`APEX_GOLD`). Either a `color?: string` prop or
  `variant="apex"`.
- **`iconPosition="top"` / stacked layout** — needed by: AssetDetailModal + WalletModal
  Send/Receive/Swap (icon-above-label). Lower priority; these could also stay bespoke.
- **`variant="warning"`** — governance "Vote AGAINST" (amber). Optional; could fold into the success/
  outline work.
- **Pill radius** — many buttons use `radius 16–24`. The existing `style` escape hatch already covers
  this; document it rather than adding a `shape` prop, unless it proves common enough.

### Finding 3 — Save / Submit / Retry buttons everywhere (mechanical, post-Finding-2)
Repeated across wallet (SendModal, TipModal, SwapModal, 4× "Retry"), qns (Place Bid, Done, Try Again,
Create Auction, Send Offer, Transfer), SpaceSettings (Save profile / Save Apex / Save Changes),
SocialFeed (Submit Proposal, Post vote ×2, Vote), onboarding (Create New Account + 3 import options),
browser (mini-app primary button), CreateProposalSheet. Many use a three-branch
`isSending ? <View><Spinner> : disabled ? <View> : <Touchable>` that collapses to a single
`<Button loading={isSending} disabled={!ready}>`. Pure mechanical conversions once Finding 2 lands.

### Finding 4 — Inline rows → `<ActionRow>` (small, high-clarity)
The remaining bucket-B rows, concentrated and textbook:
- **qns/NameDetailModal** — 6 identical action rows (Set as Primary / Make Resolvable / Make Private /
  List / Cancel Listing[destructive] / Transfer). Removes ~100 lines.
- **SkinsModal** — local `ActionButton` component (used 5×) is a hand-rolled ActionRow; delete it.
- **WalletModal** — "Show unknown/zero-value assets" settings row (eye + label + toggle).
- **ComposeChannelPickerModal + SpaceChannelBindingPicker** — avatar + name + sublabel + checkmark
  channel rows (use `leading` + `trailing`).
- **translation/TranslateLanguageModal** — language selection rows (label + sublabel + checkmark).
- **wallet/HistoryTab** — transaction rows (icon + label + status + chevron); note the rows are
  currently *duplicated* (a `renderTransaction` fn defined but the JSX inlines a second copy).
- **NFTDetailModal** — Contract / Token ID copy rows.
ActionRow gaps to add while doing this: **`onLongPress?`** (SkinsModal SkinRow needs it) and document
that `trailing` accepts a multi-node `<View>` (checkmark + trash).

### Finding 5 — Segmented / toggle pills → `<SegmentedPills>`, NOT `<Button>`
A distinct pattern that should route to the existing `SegmentedPills`, not Button:
chart-type & timeframe toggles (AssetDetailModal), token/duration/expiry selectors (CreateAuctionModal,
MakeOfferModal, ListNameModal, ApexConfigSection, InviteModal one-time/public), tab switchers
(ProfileModal Profile/Premium/Settings, SkinsModal Local/Gallery, GovernanceView Protocol/Client),
and two **local re-implementations of SegmentedPills** worth deleting: `Segmented` in SkinEditor.tsx
and `AppearanceSegments` in SkinsModal.tsx. Mutual-exclusive toggles are not action buttons.

## Bucket C — keep as-is (don't re-flag)
Recorded so future passes don't waste time: icon-only header/nav buttons, avatars, content/feed/NFT
cards, call controls (mute/hangup/flip — icon-only circles, often need `Animated.View` wrappers),
composer controls, emoji/reaction pills, picker dropdown items, tap-to-copy address rows, option
cards (privacy-setup, ProfileSplitMode, HypersnapSigner), stepper +/- controls, gesture surfaces
(HoldToConfirm uses PanResponder, no touchable at all). These are correctly bespoke. The only C-level
cleanup worth doing opportunistically: migrate the minority of **raw `react-native` `Pressable`/
`TouchableOpacity`** (SocialFeed embeds, AppTabBar, ChannelSettingsSheet group chips) to
`SkinTouchable` so they participate in skin button-surface overrides.

## Recommended sweep order (for the parent task)
1. **`<Button>` additive props** (Finding 2): `success` + `outline` + `color`/brand variants
   (+ optional `warning`, `iconPosition="top"`). One small PR, statically verifiable. **Unblocks the rest.**
2. **Shared confirm shells** (Finding 1): ConfirmDialog + TypeToConfirmModal → `<Button>` (+ `loading?`
   passthrough). Propagates widely; low risk.
3. **EmptyState + ErrorState** action buttons → `<Button>` (every empty/error surface benefits).
4. **Save/Submit/Retry sweep** (Finding 3), one PR per feature area (wallet, qns, SpaceSettings,
   SocialFeed governance, onboarding). Mechanical.
5. **ActionRow conversions** (Finding 4): NameDetailModal, SkinsModal ActionButton, the picker rows,
   WalletModal settings row, translation rows, HistoryTab (+dedupe).
6. **SegmentedPills consolidation** (Finding 5), including deleting the two local segmented controls.
7. **Opportunistic**: raw-`Pressable`/`TouchableOpacity` → `SkinTouchable` in the noted embeds.

Each step: one branch → one PR (batch-fixes rule), `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
clean per PR, **and mobile-run visual verification per area** (this is a visible change to many
surfaces; static TS check is only a proxy). Steps 1–3 are the highest value-to-risk ratio; do them
first even if the long tail waits.

---

*Last updated: 2026-06-28*
