---
type: task
title: "UI consistency audit + sweep: route ad-hoc touchables through canonical Button/ActionRow"
status: open
priority: medium
created: 2026-06-28
updated: 2026-06-28
depends_on: []
blocks: []
related-report: ../reports/2026-06-28-shared-primitives-on-mobile-analysis.md
audit-findings: ../reports/2026-06-28-ui-touchable-audit-findings.md
---

> **AUDIT COMPLETE (2026-06-28).** Step 1 done via 5 parallel agents. Full findings + the recommended
> sweep order live in `../reports/2026-06-28-ui-touchable-audit-findings.md`. Headline: the app is in
> BETTER shape than the raw count implied — most touchables are legit bucket-C already on SkinTouchable,
> and the ActionRow row-pattern is mostly already adopted. The concentrated real gap is **~105
> buttons-in-disguise** vs a canonical `<Button>` used in only ~7 files. The five cross-cutting findings
> (confirm-modal pairs, missing Button variants, save/submit/retry sweep, inline ActionRows, SegmentedPills
> consolidation) collapse ~128 scattered edits into a small decision set. **Next: Step 2 sweep, starting
> with the additive `<Button>` props that unblock everything else.** See the report's "Recommended sweep order".

# UI consistency audit + sweep

**The decoupled first step.** Make mobile's interactive elements (buttons especially) use the
canonical local components consistently. This is worth doing **regardless** of whether mobile ever
adopts quorum-shared UI primitives — and it is the prerequisite that makes a future
primitives-to-shared move cheap (you can't usefully promote a `Button` that almost nothing uses).
See the analysis report for the full reasoning and the A/B split.

> **Why this is independent of the skins/primitives timeline:** moving `Button` into quorum-shared
> later does **nothing** for the call sites that bypass `Button` today — they'd just bypass the
> *shared* Button instead. The inconsistency is orthogonal to where the file lives, so fixing it is
> never wasted and never blocks (or is blocked by) the skins port. Do it first, on its own branch.

## The data (measured 2026-06-28)

- **Raw touchables in `components/`:** ~**1,416 occurrences across 126 files**
  (`TouchableOpacity` / `Pressable` / `TouchableHighlight` / `TouchableWithoutFeedback`).
  Plus **14 files** in `app/`.
- **Canonical `Button` (`@/components/ui/Button`):** imported in only **~7 files**
  (mostly onboarding + `BrowserModal`).
- **`ActionRow` / `ActionRowGroup`:** **~10 files.**
- **`SkinTouchable`:** **~123 files** — so the app *does* widely use a touchable abstraction; it's
  the **typed semantic `Button`** (variants, `loading`, `disabled`, icon) that's underused.

**Nuance that shapes the sweep:** the problem is NOT "everyone hand-rolls raw RN touchables." Most
surfaces already go through `SkinTouchable` (skin-aware surface wrapper). The real gap is that
**actual buttons** — labelled, variant-typed actions (primary/secondary/danger/ghost, with loading
spinners and disabled states) — are frequently rebuilt inline as `SkinTouchable`/`TouchableOpacity`
+ `Text` + local StyleSheet instead of using `<Button>`. The audit must separate *legitimately
bespoke* touchables (message rows, list items, swipe targets, custom gesture surfaces — these
SHOULD stay touchables) from *buttons-in-disguise* (these should become `<Button>` / `<ActionRow>`).

## Scope

### Category B only (this task)
Adopt the existing canonical components more consistently. **No API changes, no shared move.**
- `<Button>` for labelled action buttons (variants/sizes/loading/disabled/icon).
- `<ActionRow>` / `<ActionRowGroup>` for icon-left + label rows (settings/menu/sheet rows).
- Keep `SkinTouchable` for genuinely bespoke tappable surfaces.

### Explicitly OUT of scope (Category A — wasted now, the shared `types.ts` contract drives it later)
- Renaming `Button`'s API to match desktop (`variant`→`type`, `sm`→`small`, `onPress` semantics).
- Restructuring `Button`'s internal styling.
- Anything in quorum-shared. Anything skin-runtime related.
See the report §5 for why Category A is deferred.

## Plan

### Step 1 — Audit (produces a report, no code)
- [ ] Classify the ~126+14 touchable-bearing files into buckets:
      **(a) buttons-in-disguise** → should be `<Button>`;
      **(b) menu/settings rows** → should be `<ActionRow>`;
      **(c) legitimately bespoke** → leave as-is (record *why*, so future passes don't re-flag).
- [ ] For (a) and (b), note the variant/size each inline button is emulating, and any prop the
      canonical component is **missing** (e.g. a needed variant, an icon-right case). If the
      canonical `Button`/`ActionRow` needs a small additive prop to absorb a real pattern, record
      it — that's allowed (additive, not an API rename).
- [ ] Write findings to `.agents/reports/2026-XX-XX-ui-touchable-audit-findings.md`:
      per-feature-area counts, the (a)/(b)/(c) split, and a prioritized sweep order.
- [ ] **Consider running this audit as a parallel fan-out** (one agent per feature area:
      chat, spaces, wallet, social-feed, settings, onboarding, qns, modals). It's a wide,
      mechanical classification job — good fit for dispatched agents. Apply the diff-integrity
      discipline from `[[apply-workflow-needs-diff-integrity-scan]]` if any agent edits files.

### Step 2 — Sweep (per feature area, one branch → one PR each)
- [ ] Convert bucket (a)/(b) call sites area-by-area (chat, spaces, wallet, …). ~10–20 files per PR
      per the one-branch-one-PR rule.
- [ ] Visual-review each area against the live app before merge — this is a visual change to many
      surfaces. **Mobile must be run** to verify (dev-test session); static TS check is only a proxy.
      `npx tsc --noEmit --jsx react-jsx --skipLibCheck` must show no new errors vs master per PR.
- [ ] If a small additive prop was identified in Step 1, add it to the local `Button`/`ActionRow`
      first (its own small commit), then use it. Keep it additive so it survives the eventual
      shared move.

## Progress log

**Wave 1 (2026-06-28) — branch `style/canonical-button-adoption-wave-1` (not yet committed/pushed):**
- **Finding 2 (Button additive props) — DONE.** `components/ui/Button.tsx` gained `variant="success"`,
  `variant="outline"` (transparent fill + tinted border), and a `color?` override (for one-off brand
  fills like biometric purple / Apex gold). Purely additive; all existing call sites unchanged. Icon/
  label tint logic updated so `ghost`/`outline` use the override-or-accent color.
- **Finding 1 (shared confirm shells) — DONE.** `ConfirmDialog` + `TypeToConfirmModal` footers now use
  `<Button>` (cancel=`secondary`, confirm=`danger`/`primary` from the existing `variant` prop). The
  manual `confirmEnabled`/`confirmDisabled`/`confirmLabelDisabled` styles collapsed into Button's
  built-in `disabled`. These are shared shells → propagates to every confirm/destructive modal.
- **Finding 3 partial (EmptyState/ErrorState) — DONE.** Both action buttons now use `<Button>`
  (EmptyState→`primary`, ErrorState→`ghost` + `arrow.clockwise` icon). Benefits every empty/error surface.
- **Verification:** `npx tsc --noEmit` → 22 errors, identical to clean-master baseline (zero new). ESLint
  on the 5 files → 0 new warnings (the one `View`-unused warning in Button.tsx pre-existed on master).
  Diff integrity scan clean (no smart quotes, no stray edits). Net **+61/−141 = −80 lines.**
- **Mobile-run visual verification (2026-06-28) — DONE, no regression.** User reloaded the running app:
  - `ConfirmDialog` + `TypeToConfirmModal` (the real, widely-used surfaces) — verified green in-app. ✓
  - `EmptyState` + `ErrorState` — discovered to have **ZERO call sites** (`grep` across components/ + app/
    found no usages). They render nowhere, so the conversions cannot cause a visual regression; untestable
    by absence of any render surface. Edits kept (correct + ready for first use; ErrorState retry is now a
    `ghost` button). User decision 2026-06-28: keep the edits.
  - `Button.tsx` new props are additive — no current screen uses `success`/`outline`/`color`, so existing
    UI is unchanged.
  - **Conclusion: Wave 1 has no known visual regression.**

**DESIGN STANDARD set (2026-06-28, user decision):** ALL modal/dialog footer action buttons use the
canonical `<Button size="lg">` (padding 16 / font 16, ≥44px touch target — meets iOS HIG / Material,
reads as a prominent primary action). Cancel=`secondary`, destructive=`danger`, default=`primary`.
This is the single rule; stop overriding button size at call sites.

**Wave 2 (2026-06-28) — committed `3c9fcd4` on branch `style/canonical-button-adoption`:**
- **Finding 1 individual modals — DONE.** BlockUserModal, KickUserModal, MuteUserModal, ReportModal,
  TransactionWarningModal, MiniAppApprovalModal footers → canonical `<Button size="lg">`. Manual
  `disabled`/`loading`/`buttonDisabled` styles collapsed into Button built-ins (Report + MiniApp use
  `loading` for their spinner; TransactionWarning maps severity→`danger`/`primary`).
- **Wave 1 corrected to the lg standard** (ConfirmDialog + TypeToConfirmModal bumped md→lg) so the
  whole confirm-modal family is now pixel-identical.
- **Verification:** tsc 22 errors (baseline, zero new); lint — fixed the one `TouchableOpacity` I
  orphaned; remaining warnings (KickUserModal `error`, MiniApp `EthereumProviderService`/`formatEther`,
  ReportModal apostrophe) are all PRE-EXISTING on master, unrelated to button work. Net **+82/−213 = −131 lines.**
- **Branch renamed** `...-wave-1` → `style/canonical-button-adoption` (now covers both waves).
- **NOT yet done:** mobile-run visual verification of Wave 2 (see test list handed to user 2026-06-28).

## REMAINING WORK (waves 3-5 — OPEN)

Waves 1-2 shipped on branch `style/canonical-button-adoption` (the `<Button>` primitive + all
modal/dialog confirm footers). What's left, per the findings report's sweep order. Each is its own
branch → PR, `npx tsc --noEmit` clean, **mobile-run visual verification per area before merge**.
Full per-file detail (file:line tables) lives in `../reports/2026-06-28-ui-touchable-audit-findings.md`.

### Wave 3 — Save / Submit / Retry buttons → `<Button>` (Finding 3, ~mechanical)
The largest remaining cluster (~50 buttons). Standard: filled actions use the canonical `<Button>`;
modal/dialog footers use `size="lg"` (the design standard set this session). Many use a three-branch
`isSending ? <View><Spinner> : disabled ? <View> : <Touchable>` that collapses to a single
`<Button loading={...} disabled={...}>`. Split into PRs by area:
- [ ] **wallet/** — SendModal, TipModal, SwapModal (incl. biometric buttons → need `color` override,
      now available), NFTDetailModal "View on Explorer" (→ `outline`), 4× "Retry". ⚠️ money flows — verify carefully.
- [ ] **qns/** — AuctionDetailModal (Place Bid/Done/Back), BuyNameModal, RegisterPaymentModal,
      CreateAuctionModal, MakeOfferModal, OffersModal (Accept→`success`, Reject/Cancel→`danger`),
      NameDetailModal Transfer.
- [ ] **apex/** — ApexSubscribeModal pay button (APEX_GOLD → `color` override), quote-retry.
- [ ] **SpaceSettings/SpaceSettingsModal** — Save profile / Save Apex / Save Changes / Leave Space
      (→ `outline` danger) / Add Channel / Add Group / Add Role / Upload Emoji.
- [ ] **SocialFeed/** — CreateProposalSheet Submit, ProposalVoteBlock + HegemonyGovernanceView vote
      buttons (Vote AGAINST → `warning`/`success`), ProfileActionButtons Follow/Message (→ `outline`),
      GovernanceView "New", SnapEmbed SnapButton.
- [ ] **onboarding/app/** — account-setup CTA + 3 import options, farcaster-setup paste, browser.tsx
      mini-app primary button, QRScannerView/MnemonicDisplayView/HexInputView paste/copy/back buttons.
- [ ] **Chat/** — ChannelSettingsSheet "Create channel", DirectMessagesList "New Conversation",
      SpaceCallBubble Join(→`success`)/Expand, InviteLinkCard Join (→`success`).
- [ ] **misc loose modals** — SpaceModal, NewConversationModal, InviteModal, FarcasterReimportSheet
      (Cancel→`outline`), CastComposeModal, UnifiedProfileEditModal, ListNameModal, WarpcastWalletImportModal.

### Wave 4 — Inline rows → `<ActionRow>` / `<ActionRowGroup>` (Finding 4)
- [ ] **qns/NameDetailModal** — 6 action rows (Set as Primary / Make Resolvable / Make Private / List /
      Cancel Listing[destructive] / Transfer). Removes ~100 lines.
- [ ] **skins/SkinsModal** — delete the local `ActionButton` component (used 5×); it's a hand-rolled ActionRow.
- [ ] **WalletModal** — "Show unknown/zero-value assets" settings row.
- [ ] **ComposeChannelPickerModal + SpaceChannelBindingPicker** — avatar+name+sublabel+checkmark channel rows.
- [ ] **translation/TranslateLanguageModal** — language rows.
- [ ] **wallet/HistoryTab** — transaction rows (+ the duplicated render path noted in findings).
- [ ] **wallet/NFTDetailModal** — Contract / Token ID copy rows.
- [ ] **ActionRow additive props to add along the way:** `onLongPress?` (SkinsModal SkinRow needs it);
      document that `trailing` accepts a multi-node `<View>` (checkmark + trash).

### Wave 5 — Segmented / toggle pills → `<SegmentedPills>` (Finding 5)
NOT `<Button>` — these are mutual-exclusive toggles.
- [ ] AssetDetailModal chart-type + timeframe toggles.
- [ ] CreateAuctionModal / MakeOfferModal / ListNameModal / ApexConfigSection token+duration+expiry selectors.
- [ ] InviteModal one-time/public, ProfileModal tabs, SkinsModal Local/Gallery, GovernanceView Protocol/Client.
- [ ] **Delete two local re-implementations of SegmentedPills:** `Segmented` in SkinEditor.tsx,
      `AppearanceSegments` in SkinsModal.tsx.

### Opportunistic (any time)
- [ ] Migrate the minority of raw `react-native` `Pressable`/`TouchableOpacity` → `SkinTouchable`
      (SocialFeed embeds: VideoPlayer, LiveSpacesStrip, AudioSpaceEmbed, FarcasterTokenEmbed; AppTabBar;
      ChannelSettingsSheet group chips).
- [ ] **Defensive Button fix:** add `numberOfLines={1}` (and/or `adjustsFontSizeToFit`) to the canonical
      Button label so no long label can wrap to two lines on small screens (the A40 "Reset App Data"
      class of bug). One-line change in `components/ui/Button.tsx`; prevents the whole bug class.

## Acceptance
- Buttons-in-disguise across the app render through `<Button>`; menu/settings rows through
  `<ActionRow>`. Bespoke touchables documented and intentionally left.
- No visual regressions (verified in-app per area).
- `Button` usage count climbs from ~7 files toward broad adoption; the audit report records the
  remaining intentional touchables so the number is *explained*, not just reduced.

## Relationship to the bigger picture
- This is **step 1** of the direction in `../reports/2026-06-28-shared-primitives-on-mobile-analysis.md`.
- Steps 2+ (promote primitives into quorum-shared) are **downstream of the skins-to-desktop port**
  and its missing **shared skin-runtime** prerequisite — NOT part of this task. This task
  deliberately needs none of that.
- Precedent for the eventual shared move: `2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md`
  ("do it once in shared, no temporary wrappers").

---

*Last updated: 2026-06-28*
