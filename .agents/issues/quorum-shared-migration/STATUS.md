---
type: task
status: in-progress
title: "Quorum-shared migration — mobile-side STATUS (all 8 tasks triaged)"
created: 2026-06-14
updated: 2026-06-14
audience: future sessions deciding which shared-migration plumbing to pick up
supersedes-table-in: README.md (its status table only listed 1 of 8 tasks; this is the full triage)
note: "Living status file for this folder — keep current as tasks ship/unblock. Intentionally named STATUS.md (no date prefix) so it stays the stable entry point."
---

# Quorum-shared migration — mobile-side STATUS

> **Why this file exists.** On 2026-06-14 we triaged every task file in this folder to answer a
> simple question: *"these look like simple plumbing — which can we actually do right now, and
> what's the risk?"* The answer split cleanly into three buckets. The folder's `README.md` status
> table was stale (listed only 1 of 8 tasks), so this snapshot is the authoritative state until the
> README is regenerated. All symbol-availability claims below were **verified directly against the
> installed `node_modules/@quilibrium/quorum-shared` `2.1.0-29` dist**, not trusted from the task prose.

## Key environment facts

> **UPDATE 2026-07-16: mobile now pins `@quilibrium/quorum-shared@2.1.0-34`** (package.json:33).
> The facts below were originally verified against `2.1.0-29`; the `-31`/`-34` bumps carried the
> byte validators, optional `UpdateProfileMessage.displayName`, and the promoted
> `messagePreprocessing` pipeline (`prepareMessageContent` verified present in the installed `-34`
> dist). Still ABSENT in `-34`: the `globalDisplayName`/`globalUserIcon`/`globalBio` fields from
> shared PR #57 (blocks Bucket 4) — verified absent in the installed dist 2026-07-16.

- **Mobile pins `@quilibrium/quorum-shared@2.1.0-34`** (package.json:33). Was `2.1.0-29` at first triage.
  Several task files still say "currently on `2.1.0-26`/`-29`/`-33`" — that prose is **stale**, ignore it.
- **The published `-29` dist is AHEAD of `-26` but BEHIND the shared source.** This is the same
  recurring stale-dist problem that blocks the primaryUsername / DM-update-profile work: shared's
  `src/` has symbols that the npm-published dist doesn't yet contain. Verified absent in `-29`:
  - `MAX_BIO_BYTES`, `MAX_DISPLAY_NAME_BYTES` — **not in dist** (byte-based validators don't exist yet).
  - `UpdateProfileMessage.displayName` is **still `string` (required)**, NOT optional `string | undefined`.
  Verified **present** in `-29`: `toggleRolePermission`, `setRolePermissions`, `hasPermission`,
  `getUserPermissions`, `getUserRoles`, `useTwoStepConfirm`, `validateSpaceName` + name/topic length
  constants, the invite-domain helpers.
- **Runtime testing IS available this session** (2026-06-14): the app is running on the physical
  phone. So `runtime-test: required` is *not* a blocker right now — it just means "eyeball it on the
  phone before shipping," not "wait for a future session." (This is unusual — most sessions can't run
  mobile. See `README.md` and the cross-repo workflow's mobile-testing rule.)

## The three buckets

### ✅ Bucket 1 — ship-now, low-risk plumbing

| Task | Files | Runtime test | Status / why it's safe |
|---|---|---|---|
| ✅ **SHIPPED** [`.done/2026-05-30-mobile-adopt-shared-role-mutation-helpers.md`](.done/2026-05-30-mobile-adopt-shared-role-mutation-helpers.md) | `hooks/chat/useRoleManagement.ts` (1 file, 1 call site) | not-required | **Shipped 2026-06-14 — [quorum-mobile PR #85](https://github.com/QuilibriumNetwork/quorum-mobile/pull/85), squash-merged (`8934bfc`).** Replaced the inline include/filter/spread block with shared `toggleRolePermission`. Static gates passed (tsc 82==82, lint clean, grep gate). Moved to `.done/`. |
| ✅ **SHIPPED** [`.done/2026-05-28-adopt-shared-validators.md`](.done/2026-05-28-adopt-shared-validators.md) | `SpaceModal.tsx`, `SpaceSettingsModal.tsx` + new `hooks/validation/errorTranslator.ts` | required (done — phone up) | **Shipped 2026-06-14 — [quorum-mobile PR #86](https://github.com/QuilibriumNetwork/quorum-mobile/pull/86), squash-merged (`4905c66`).** Dropped local `validateSpaceName` + length constants; routed name + description through shared validators via `hooks/validation/errorTranslator.ts`. Adds the shared HTML-tag XSS guard (matches desktop); min/max rules unchanged. Runtime-tested on the phone. Moved to `.done/`. |

> **Bucket 1 is now empty — both ship-now tasks merged (PR #85 role-mutation, PR #86 validators).**

### ✅ Bucket 2 — SHIPPED (was blocked on a publish; unblocked by `2.1.0-31`)

> **UPDATE 2026-06-16: mobile is now on `@quilibrium/quorum-shared@2.1.0-31`** (not `-29`).
> Verified the byte validators + optional `UpdateProfileMessage.displayName` ARE in the `-31`
> published dist. Both tasks shipped in **mobile PR #105** (`089dd05`). Bucket 2 is now empty.

| Task | Status |
|---|---|
| [`.done/2026-06-10-mobile-converge-profile-validation-to-shared.md`](.done/2026-06-10-mobile-converge-profile-validation-to-shared.md) | ✅ **SHIPPED — PR #105.** Routed bio + display-name across all 4 editors (onboarding, UnifiedProfileEditModal, SpaceSettingsModal, ProfileModal) through shared `validateUserBio`/`validateDisplayName` (byte-based, Farcaster-aligned) via the `errorTranslator`. Hard-cap-by-bytes on input (silent truncate, kinder on mobile than a "too long" error — design call confirmed with user; truncation is mobile-local since shared validates but has no byte-truncate). Content rules (.q/impersonation/XSS) show a live error + disable Save. Farcaster publish-boundary hard-block added. **Validation runtime-tested on device.** Moved to `.done/`. |
| [`.done/2026-06-11-mobile-honor-displayname-clear.md`](.done/2026-06-11-mobile-honor-displayname-clear.md) | ✅ **SHIPPED — PR #105** (rode the same branch). Both `update-profile` receivers flipped to `!== undefined` so an empty displayName is honored as a per-space-name clear. Receive-side; **runtime confirmation blocked by Symptom B** (desktop→mobile delivery) — shipped statically-verified, consistent with PRs #89/#104. NOTE: a **send-side** counterpart bug was found in testing (mobile strips an empty displayName on broadcast, so a clear made ON mobile doesn't propagate) — filed at `issues/.done/2026-06-16-mobile-send-strips-empty-displayname-clear-not-propagated.md`, deferred to a focused follow-up. |

### ✅ Bucket 5 — SHIPPED (was READY; shipped 2026-07-16)

> **Was the one genuinely actionable shared-migration task; now shipped.** Publish gate was clear
> and mobile was already on the version carrying the symbols, so no local link was needed.

| Task | Files | Runtime test | Status |
|---|---|---|---|
| ✅ **SHIPPED** [`.done/2026-06-18-adopt-shared-message-preprocessing.md`](.done/2026-06-18-adopt-shared-message-preprocessing.md) | swapped import in `components/Chat/MessageRenderer.tsx` (sole importer) + deleted `utils/messagePreprocessing.ts` | required (eyeball on device) | **Shipped 2026-07-16 — [quorum-mobile PR #155](https://github.com/QuilibriumNetwork/quorum-mobile/pull/155), squash-merged (`3ce3b7d`).** Import re-pointed to `@quilibrium/quorum-shared`; 382-line local copy deleted; stale doc-comment path fixed. Verified `prepareMessageContent`/`hasMarkdown` present in installed `2.1.0-34` dist and `PreprocessOptions` matches mobile's call shape (no call change, option B). Static gates: `tsc --noEmit` added zero new errors (21 pre-existing on both branches, none in Chat dir); grep clean. Render smoke-test (`.agents/tests/2026-06-18-markdown-and-mentions-test-cases.md` A–E) to eyeball on device. Moved to `.done/`. |

### 🚫 Bucket 3 — don't touch / superseded (decisions taken 2026-06-14)

| Task | Decision | Reason |
|---|---|---|
| [`2026-05-29-mobile-adopt-useTwoStepConfirm-in-useUserKicking.md`](.done/2026-05-29-mobile-adopt-useTwoStepConfirm-in-useUserKicking.md) | **✅ CLOSED (superseded) — moved to `.done/` 2026-06-14** | Superseded by [`../2026-06-13-destructive-operations-confirmation-standard.md`](../.done/2026-06-13-destructive-operations-confirmation-standard.md). The standard **eliminates double-tap/two-step confirm on mobile** (weakest fat-finger guard — two taps on the same coordinate). Adopting `useTwoStepConfirm` would be adding the very pattern we decided to remove. User confirmed 2026-06-14. |
| [`2026-05-30-mobile-dedup-deriveAddress.md`](2026-05-30-mobile-dedup-deriveAddress.md) | **HOLD** — entangled with the crypto bug's lead-dev decision | Behavior-neutral cleanup (3 local `deriveAddress` copies → 1 import), BUT all 3 target files are among the 6 flagged in the HIGH-severity bug [`../.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md`](../.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md). Root cause = mobile's multihash address format vs desktop's raw form; the fix (which side moves) is the **lead dev's call** with a stored-address migration. If the fix is "mobile drops the multihash prefix," the lead will likely want `keyService.ts` + all call sites fixed atomically — so consolidating now could either help (one place to fix) or create a false "it's handled" impression. Don't ship ahead of the format decision. |
| [`2026-05-29-mobile-rewire-invite-helpers-to-shared.md`](2026-05-29-mobile-rewire-invite-helpers-to-shared.md) | **NO (for now)** | Already `status: blocked` pending a lead-dev product decision (whether staging/localhost mobile builds are in scope). User confirmed NO 2026-06-14. Symbols are present in `-29`, so it's *technically* doable, but it's gated on the product call, not the dependency. |
| 📦 **ARCHIVED** [`.archived/2026-05-29-mobile-adopt-shared-permission-helpers.md`](.archived/2026-05-29-mobile-adopt-shared-permission-helpers.md) | **WON'T DO — wrong premise → archived** (2026-06-14) | Goal (route hooks through shared to pick up the `isSpaceOwner` short-circuit) contradicted the verified design (only KICK is owner-only; pin/delete/@everyone need a role). The real fix — **remove the bypass from shared** — was done in **shared PR #41** (`fc73eb2`) + desktop PR #203. Moved to `.archived/`. The one salvageable idea (dedup the 3 mobile hooks onto shared, now safe post-#41) was carried into the cleanup task below. |
| 🧹 **NEW cleanup** [`2026-06-14-cleanup-dead-isspaceowner-param.md`](2026-06-14-cleanup-dead-isspaceowner-param.md) | open, low priority | Post-#41 tidy-up. Part A: drop the now-dead `isSpaceOwner` param from shared `hasPermission`/`getUserPermissions` (ignored since #41; cosmetic, static-verifiable, ~5 desktop call sites). Part B (optional, runtime-test): dedup mobile's 3 permission hooks onto shared, now behaviorally safe. Neither urgent. |

### ✅ Bucket 4 — UNBLOCKED 2026-07-27 (was: blocked on a shared publish)

> **UPDATE 2026-07-27: mobile bumped to `@quilibrium/quorum-shared@2.1.0-37`.**
> Verified `globalDisplayName?`/`globalUserIcon?`/`globalBio?` are present on
> `UpdateProfileMessage` in the installed dist. Publish gate cleared — this is
> now a ready-to-pick pure type/cast cleanup.

| Task | Was blocked on | Status / why |
|---|---|---|
| [`2026-07-16-mobile-adopt-typed-global-identity-fields.md`](2026-07-16-mobile-adopt-typed-global-identity-fields.md) | `@quilibrium/quorum-shared` published > `2.1.0-34` including **PR #57** + mobile pin bump | **READY.** PR #57 (added optional `globalDisplayName`/`globalUserIcon`/`globalBio` to `UpdateProfileMessage`) merged to shared `master` 2026-07-16 and published as `2.1.0-37` (2026-07-27); mobile pin bumped same day. Retire mobile's two-slot casts (`content as MessageContent` in `spaceMessageService.ts`, the `as SpaceMember & {...}` member-row writes in `WebSocketContext.tsx`, and the `(local as {...})` reads in `useMembersWithPublicProfileFallback.ts`). Pure type/cast cleanup, static-verifiable, no runtime test. Desktop already did its half (branch `feat/two-slot-identity-types-and-timestamp-guard`). |

## Recommended order if we pick up Bucket 1 this session

1. **`role-mutation-helpers`** first — smallest, static-only, zero behavior change. Clean warm-up PR.
2. **`adopt-shared-validators`** — slightly larger (2 modals + a translator file) and adds the XSS
   check, so eyeball space create/edit on the phone before shipping. Both touch independent areas
   (`useRoleManagement.ts` vs the space modals) so they don't conflict.

(Both could ride one session branch; per the cross-repo "one session = one PR" default, decide
whether to bundle or split when we start. They're independent enough to bundle cleanly.)

---

*Created: 2026-06-14 — full triage of all 8 mobile-side shared-migration tasks; symbol availability
verified directly against the installed `2.1.0-29` dist. Decisions baked in: useTwoStepConfirm stale
(superseded by the confirmation standard), dedup-deriveAddress on hold (crypto-bug lead decision),
rewire-invite-helpers NO for now, permission-helpers deprioritized.*

*Updated: 2026-06-14 — `role-mutation-helpers` SHIPPED (PR #85, merged) and moved to `.done/`;
`adopt-shared-validators` is the next Bucket 1 task (in progress). Sharpened the converge-profile
entry with the verified byte-vs-char finding (shared source byte-based per user intent; published
`-29` still char-based → blocked on publish).*

*Updated: 2026-06-14 (later) — `adopt-shared-validators` SHIPPED (PR #86) + a follow-on bug fix
(cleared-space-description, PR #87) shipped; Bucket 1 empty. **`permission-helpers` flipped to WON'T
DO**: started implementing, then a deep dive + user catch proved the premise wrong (it would entrench
the owner-permission bypass that the cross-repo fix plan says to REMOVE — receivers can't verify
owner identity, so only KICK works owner-only; pin/delete need a role). Code discarded, branch
deleted, task doc + this row corrected. The real fix is shared-side (lead territory).*

*Updated: 2026-07-16 — added **Bucket 4** (blocked on a shared publish):
`mobile-adopt-typed-global-identity-fields` — retire the two-slot global-identity
casts once shared PR #57 (optional `globalDisplayName`/`globalUserIcon`/`globalBio`
on `UpdateProfileMessage`) is published above `2.1.0-34` and mobile bumps. Desktop
did its half this session; mobile is a pure cast cleanup, unblocked by the publish.*

*Updated: 2026-06-16 — **mobile bumped to `2.1.0-31`**, which unblocked BOTH Bucket 2 tasks
(byte validators + optional `UpdateProfileMessage.displayName` confirmed in the published dist).
Both shipped in **mobile PR #105**: `converge-profile-validation` (validation runtime-tested on
device; byte-cap-on-input UX confirmed with user) and `honor-displayname-clear` (receive side;
runtime blocked by Symptom B). **Bucket 2 is now empty.** A send-side displayName-clear gap was
found in testing and filed as a bug (deferred follow-up). Remaining open in this folder:
`rewire-invite-helpers` (NO, product call), `dedup-deriveAddress` (HOLD, crypto-bug lead decision),
`cleanup-dead-isspaceowner-param` (low priority). No ready-to-pick shared-migration work remains
without a lead decision.*

*Updated: 2026-07-16 — **mobile now on `2.1.0-34`** (was `-31` in the header; package.json:33).
Added **Bucket 5 (READY TO PICK)**: `adopt-shared-message-preprocessing` is now genuinely
actionable — publish gate cleared (shared #52 + desktop #218 merged, `2.1.0-34` published) and
mobile is already on `-34`, with `prepareMessageContent` verified present in the installed dist.
No dep bump / no local link needed; just swap the import in `MessageRenderer.tsx` (sole importer),
delete the mobile-local copy, and re-run the render checks on device. **This is currently the only
ready-to-pick task in the folder.** Bucket 4 (`typed-global-identity-fields`) stays blocked —
`globalDisplayName` verified absent in the installed `-34` dist (needs PR #57 published above `-34`).*

*Updated: 2026-07-16 (later) — **Bucket 5 SHIPPED**: `adopt-shared-message-preprocessing` merged as
[PR #155](https://github.com/QuilibriumNetwork/quorum-mobile/pull/155) (squash `3ce3b7d`), task moved
to `.done/`. Import swapped to `@quilibrium/quorum-shared`, 382-line local copy deleted, static gates
clean (zero new tsc errors). Device render smoke-test still to be eyeballed but the swap is
behavior-preserving by construction. **No ready-to-pick shared-migration work remains** — everything
open is either blocked on a shared publish (Bucket 4) or gated on a lead-dev decision (Bucket 3).*

*Updated: 2026-07-27 — **mobile bumped to `2.1.0-37`** (package.json:34), publishing shared PR #57
(global-identity fields), PRs #63+#65 (conversationSettings helpers, used by the separate
`../.done/2026-07-20-sync-all-conversation-settings.md` task — shipped same day as PR #185), and the `IconLanguage` icon mapping (used by
`../2026-06-25-translate-icon-iconlanguage.md`). Verified all three symbol sets present in the
installed dist. **Bucket 4 is now unblocked** — `mobile-adopt-typed-global-identity-fields` is
ready to pick.*
