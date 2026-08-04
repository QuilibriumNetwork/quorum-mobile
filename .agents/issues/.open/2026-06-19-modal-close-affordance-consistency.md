---
type: task
title: "Modal close-affordance consistency"
status: open
created: 2026-06-19
---

# Modal close-affordance consistency

**Status:** todo — audited, not yet implemented. Orthogonal to the nav-bar/edge-to-edge branch (`feat/nav-bar-redesign`); do as its own piece.

## Problem

Close/dismiss affordances are inconsistent across modals: some have a close "X", some don't; some dismiss on backdrop tap, some don't; some allow swipe-down, some don't. The user asked whether this is principled or accidental.

## Audit verdict: partly principled, mostly accidental (two build-eras)

### Intentional — DO NOT change
- **Destructive confirms** (`shared/ConfirmDialog`, `shared/TypeToConfirmModal` via `shared/CenterModal`): backdrop/back/swipe always resolve to **Cancel**, never Confirm. Documented invariant. Correct.
- **`MigrationModal`**: deliberately non-dismissible (blocking progress). Correct.
- **`MiniAppApprovalModal`**, **`TransactionWarningModal`**: backdrop maps to the SAFE side (Reject/Cancel). Correct.

### Accidental inconsistency (the actual problem)
1. **X-button presence tracks the QNS/wallet code cluster, not modal semantics.** Every QNS + wallet modal has an X in the header (even pure-info ones like `AssetDetailModal`/`NFTDetailModal`); the chat/profile/space cluster has NO X (even multi-field forms). Looks like two development eras, not a rule.
2. **Forms can lose typed input on an accidental backdrop tap**, no warning, no X to aim for instead. BaseModal's backdrop + swipe dismiss are always-on with no opt-out prop. Affected forms: `SpaceModal`, `NewConversationModal`, `UnifiedProfileEditModal`, `SpaceSettingsModal`, `ChannelSettingsSheet`, `CreateProposalSheet`, `WarpcastWalletImportModal` (sensitive). (`FarcasterReimportSheet` avoids it — but by being hand-rolled, accidentally, not systematically.)
3. **Backwards hand-rolled modals**: `CreateSpaceSheet` and `SocialFeedModal`'s "Share to Chat" have an X but NO backdrop dismiss — opposite of every BaseModal.

### Primitive defaults (the levers)
- **BaseModal**: no X by default; backdrop tap, swipe-down, handle tap, Android back ALL dismiss — and there is **no prop to disable backdrop/swipe**. (Would need to add one.)
- **CenterModal**: no X; `dismissOnBackdrop?: boolean` (default true); backdrop = onCancel; no swipe.
- **ActionSheet**: BaseModal + handle.

## Proposed consistent rule (to confirm before implementing)

Adopt ONE principle and apply it everywhere:

- **Simple pickers / action sheets / info / read-only** → no X needed; backdrop + swipe + handle dismiss (current BaseModal default). Keep as-is.
- **Forms with text input / multi-step / sensitive** → require a deliberate close: add an X (or "Cancel" text) in the header, AND disable backdrop-tap dismiss (keep swipe? decide) so a stray tap can't nuke typed input. Needs a new BaseModal prop, e.g. `dismissOnBackdrop?: boolean` (default true) mirroring CenterModal.
- **Destructive confirms** → already correct (CenterModal). Leave.
- **Blocking** → already correct (MigrationModal). Leave.

Decisions to make:
- Standardize the X: always an `xmark` icon in the header, or a "Cancel" text button? (Wallet/QNS use xmark; CastCompose uses "Cancel" text.) Pick one.
- For forms, disable backdrop-dismiss only, or also swipe? (Swipe is a more deliberate gesture than a stray backdrop tap — arguably keep swipe, kill backdrop.)
- Fix the two backwards hand-rolled modals (`CreateSpaceSheet`, Share-to-Chat) either way.

## Implementation sketch
1. Add `dismissOnBackdrop?: boolean` (default `true`) to `BaseModal` (and optionally `dismissOnSwipe`). Mirror CenterModal's existing prop.
2. Add a standard header-X helper (or a `BaseModal` `showCloseButton` prop) so forms get a consistent X without each re-implementing it.
3. Set `dismissOnBackdrop={false}` + show X on the form modals listed in problem #2.
4. Fix `CreateSpaceSheet` + Share-to-Chat to match the chosen norm.
5. Leave destructive/blocking modals untouched.

## Scope note
~50 modals total; ~7 forms need the treatment, 2 hand-rolled need straightening, the rest are already consistent within their (correct) category. Not a huge change once the BaseModal props exist — most of it is flipping a prop on the form modals.

---
*Last updated: 2026-06-19*
