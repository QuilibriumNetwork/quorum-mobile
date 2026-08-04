---
type: task
title: "Destructive operations: tiered confirmation standard for mobile"
status: done
created: 2026-06-13
updated: 2026-06-15
supersedes:
  - .agents/issues/quorum-shared-migration/.done/2026-05-29-mobile-adopt-useTwoStepConfirm-in-useUserKicking.md
  - .agents/tasks/2026-06-13-themed-confirmation-dialog-for-destructive-actions.md
runtime-test: required
priority: medium
branch: feat/destructive-ops-confirmation
---

# Destructive operations: tiered confirmation standard for mobile

## ✅ MERGED (2026-06-15) — PR #93, squash `c601fd1` on master

Shipped via PR #93 ("Standardize destructive-action confirmations"), squash-merged to mobile master
as `c601fd1`; branch deleted. Built on top of role-color PR #92 (`cd3d216`). Shared `2.1.0-31`.
Runtime-tested on Android (user-confirmed). iOS NOT verified (no device); no iOS-specific logic
paths exist (only `CenterModal`'s cosmetic a11y role branch), so risk is visual-only. The
pre-merge branch was `feat/destructive-ops-confirmation` (commits `02b8786`/`1fedf60`/`cb15455`/
merge `7bbd9ea`), now squashed.

Commits:
- `02b8786` Part 1 — primitives + T3 type-to-confirm + single-press kick.
- `1fedf60` Part 2 — `useConfirmDialog` + migrate the Alert.alert sites + dead-wiring fixes + strip
  dead kick/leave machinery.
- `cb15455` — remove the shared ActionSheet Cancel button (app-wide; cast/profile/wallet menus) +
  reorder the Farcaster cast menu (least→most destructive).
- `7bbd9ea` — merge latest master (#92). One conflict in `UserProfileModal` role pill, resolved to
  keep BOTH our whole-pill-tappable remove + #92's tinted-background + color-dot visuals.

**Part 1 (committed `02b8786`):**
- ✅ Primitives (`components/shared/`): `CenterModal` (center-anchored RN-Modal shell, owns the
  a11y + Android-back/backdrop-→cancel contract), `ConfirmDialog` (T1/T2, red button on iOS+Android),
  `TypeToConfirmModal` (T3, keyword-gated + optional stats). Exported from `components/shared/index.ts`.
- ✅ T3 Reset App Data → `TypeToConfirmModal` (`reset`). T3 Delete Space → `TypeToConfirmModal`
  (`delete`, channel/member stats); removed `deleteConfirmStep`.
- ✅ Kick User → single-press; kept the rich `KickUserModal`, dropped the in-modal double-tap.

**Part 2 (committed `1fedf60`):**
- ✅ `useConfirmDialog` hook — promise-based `const ok = await confirm({...})`. Returns a rendered
  `confirmDialog` ELEMENT (NOT a `ConfirmDialogHost` component) so the dialog reconciles in place
  (close animation plays, no remount churn) — this was the fix from the code review. Rendered as
  `{confirmDialog}` per component.
- ✅ Migrated the T2/T1 Alert.alert sites: delete channel/group/role/emoji/sticker, leave space
  (double-tap removed), delete message (space+DM via `MessageActionSheet`), delete cast, remove
  device, reset DM sessions, disconnect Farcaster, delete DM conversation, reset single DM session.
- ✅ Added confirms to the 2 unguarded broadcasts: action-sheet Unpin + Remove-from-Role. The role
  confirm was NOT already present (the task's note was wrong — it lived only on the held role branch).
  Also made the whole role pill tappable (only the ✕ was before).
- ✅ Fixed the 2 dead-wiring bugs: Delete DM Conversation (wired `onDeleteConversation` →
  `storage.deleteConversation` + invalidate + `router.back`) and Delete DM message (wired
  `onDelete`/`canDeleteMessage` into `DMChatArea`'s `MessagesList`, own-messages-only).
- ✅ Stripped dead kick machinery from `useUserKicking.ts` (`confirmationStep`/`handleKickClick`/
  `resetConfirmation`); swept all `leaveConfirmStep`/"Click again" strings.

**Code review (high-effort, 7 angles) — applied:**
- FIXED #1 (real): `ConfirmDialogHost` was a `useCallback` → new identity each render → Modal
  remounted (no fade). Changed the hook to return a stable `confirmDialog` element.
- FIXED #2 (hardening): `MessageActionSheet` + `DMSettingsSheet` now ignore their own
  back/backdrop dismissal while a confirm is open (`isConfirming` guard) so Android-back cancels the
  confirm, not the sheet. Everything else REFUTED or benign (safe-by-default: failures degrade to
  "nothing happens", never a misfire).

**Bug found + fixed during QA:** the `ConfirmDialogHost`/Reset-App-Data modal were only rendered in
ProfileModal's modal-mode return, but Settings opens it in ROUTE mode → Remove Device / Disconnect
Farcaster / Reset App Data "did nothing". Added the dialog + TypeToConfirmModal to the route-mode
return too. (Lesson: a per-component dialog must render in EVERY return branch of its host.)

**Runtime QA (Android, user-confirmed all good):** role pill (merged visuals + tappable remove),
the route-mode confirms, the 3 Cancel-less sheets dismiss fine, cast menu order, Android
back/backdrop = cancel. tsc 82 (baseline) / lint baseline-clean throughout.

**Remaining:** none for shipping. Optional follow-up: verify iOS visual rendering of the dialogs
when a device is available (no logic risk, cosmetic only).

---


## Origin

While reviewing the open task "adopt `useTwoStepConfirm` in `useUserKicking`", the user
questioned whether double-tap-to-confirm is good mobile UX at all: on a phone a thumb
double-taps the same target by accident far more easily than a mouse double-clicks on
desktop. That is correct, and it surfaced a deeper problem: mobile has **three different
confirmation patterns applied with no consistent logic**, and severity is not correlated
with friction.

This task replaces the narrow `useTwoStepConfirm` migration with a single tiered standard
for every destructive operation in the app.

**Merged 2026-06-13** with a parallel analysis ("themed confirmation dialog for destructive
actions") that approached the same problem from the UX-container and shared-architecture
angle. That doc is now superseded and its unique contributions are folded in below:
- the **sheet-vs-center-modal** placement rule (see "Where the dialog sits"),
- the **accessibility obligations** a custom dialog inherits from `Alert.alert`,
- the resolution of the old desktop `ConfirmationModal.native.tsx` question (see
  "Do NOT mirror the old cross-platform primitive").

## Decisions taken (user, 2026-06-13)

1. **Eliminate double-tap-to-confirm on mobile.** It is a desktop-borrowed pattern and the
   weakest guard against fat-finger taps (two taps on the *same* coordinate). The shared
   `useTwoStepConfirm` hook is **not adopted on mobile** — the old migration task is closed
   with this rationale.
2. **Native confirmation dialog is the default workhorse** for High and Medium tiers.
3. **Type-to-confirm applies to Reset App Data AND Delete Space** — matching desktop, for
   cross-platform muscle memory. Keywords mirror desktop exactly: `reset` / `delete`.
4. **Design doc first**, reviewed, then implement.

## Why `Alert.alert` / dialog beats double-tap (the rationale to preserve)

| | Double-tap-to-confirm | Confirmation dialog |
|---|---|---|
| Second action lands on | the **same** button, same coordinate | a **different** button that wasn't there before |
| Fat-finger resistance | low (accidental double-taps hit the same spot) | high (must hit a new target in a new position) |
| Platform convention | desktop only | iOS HIG + Material standard |
| Self-documenting | no (label flips to "Click again") | yes (states consequence, destructive verb) |
| Copy says "Click" on a touch device | yes (a tell) | no |

## The tiered standard

Friction scales with **irreversibility × scope**. Four tiers.

### T3 — Catastrophic: type-to-confirm
Permanent, total, unrecoverable loss (identity/keys). The only true T3 is **Reset App Data**.
- Full-screen / large modal, NOT a transient alert.
- Body copy: explicit "cannot be undone" + "back up your recovery phrase first".
- Text input: user types `reset` (case-insensitive, trimmed) — mirrors desktop `DangerZone`.
- Destructive button disabled until the typed keyword matches.

### T2 — High: confirmation dialog with consequence copy
Affects a whole space / other people irreversibly, or permanent content loss.
- Custom skin-styled `ConfirmDialog` with a **destructive verb** button (see "Q1 RESOLVED" —
  custom over native, for a real red button on Android + brand consistency).
- Body spells out the consequence ("This removes the channel for everyone. Can't be undone.").
- **Exception: Delete Space is promoted to T3-style type-to-confirm** (type `delete`) to match
  desktop, even though mobile's delete is local-only. This is a deliberate desktop-parity
  decision, not blast-radius-driven.

### T1 — Medium: plain confirmation dialog
Reversible-ish but affects others or is non-trivial to redo, or local data loss.
- Same `ConfirmDialog` component as T2, plain "Are you sure?" body, destructive-styled button.
- Differs from T2 **only in copy weight**, same mechanism.

### T0 — Low: no dialog, but reversible
Local-only, trivially reversible, or a pure toggle.
- No confirmation. Where a tap deletes something local and non-toggle, show a toast with
  **Undo** instead of a blocking dialog.

## Where the dialog sits: center modal, not bottom sheet

A distinct decision from *which tier* an operation is: **what container the confirm uses.**
The app has two confirmation-shaped surfaces and they do different jobs — don't conflate them:

| What's shown | Container | Rule |
|---|---|---|
| A **menu of actions** (Edit / Pin / Report / Delete…) | **Bottom sheet** ([ActionSheet.tsx](../../components/shared/ActionSheet.tsx)) | thumb-reachable, scales to N options, low commitment |
| A single **"are you sure? yes/no"** for a destructive action (T1/T2) | **Center modal** | interrupts, plants in the visual center, the "are you sure" lands on a **different** target than the action that opened it (the fat-finger defence from the table above) |
| **T3 / Delete Space** type-to-confirm | **Center modal** (large) | needs a text input + stats; never a sheet |

So: keep using bottom sheets for action *menus* (already correct), and put the destructive
yes/no confirm in a **center-anchored** modal. iOS HIG + Material both assign "confirm a
consequential/destructive action" to centered alert/dialogs, and "offer a set of choices"
to sheets/menus.

Concrete consequence for the build: the new `ConfirmDialog` / `TypeToConfirmModal` must be
**center-anchored**. Do **NOT** build them on [BaseModal](../../components/shared/BaseModal.tsx)
— it is bottom-anchored (slides up from the bottom edge, has a drag handle). Use React Native
`Modal` directly with a centered card (the way `BaseModal` itself wraps RN `Modal` internally),
or a small new center-modal wrapper. The current break to fix is exactly this: e.g.
[MessageActionSheet.tsx:161](../../components/Chat/MessageActionSheet.tsx#L161) opens a themed
bottom **sheet** for the message menu, then hands the final delete confirm to a native
`Alert.alert` — a center-anchored themed confirm closes that visual seam.

> Note: with the custom `ConfirmDialog` (Q1 RESOLVED → custom), this is a **real build
> constraint**: the dialog must be center-anchored on RN `Modal`, NOT `BaseModal`. (Had we kept
> native `Alert.alert`, the OS would have centered it for free — but we're going custom for the
> Android-red-button + branding reasons in Q1.)

## Per-operation mapping (from the 2026-06-13 audit)

Legend for "Current": `alert` = native Alert.alert single-confirm · `2tap` = double-tap ·
`none` = no guard.

> **Reading the "Target" column after the Q1 custom decision:** every T1/T2 target dialog is now
> the custom `ConfirmDialog`, not native `Alert.alert`. So **"keep"** below means *"this op already
> has a working single-confirm — migrate it to `ConfirmDialog` and verify its consequence copy"*,
> NOT "leave it on the native alert". The rows marked "keep" are low-risk (behavior already
> correct, only the component + styling change); the rows marked **bold** (2tap removal, add
> dialog, fix wiring) are where real logic changes. The migration is a near-mechanical swap of
> `Alert.alert(...)` call sites for `<ConfirmDialog .../>` once the component exists.

### T3 — type-to-confirm
| Operation | File | Current | Target |
|---|---|---|---|
| Reset App Data | [ProfileModal.tsx:706](../../components/ProfileModal.tsx#L706) | alert | **type `reset`** (large modal, backup reminder) |
| Delete Space | [SpaceSettingsModal.tsx:1330](../../components/SpaceSettingsModal.tsx#L1330) | 2tap | **type `delete`** (desktop parity; show channel/member counts) |

### T2 — dialog + consequence copy
| Operation | File | Current | Target |
|---|---|---|---|
| Kick User | [useUserKicking.ts:102](../../hooks/chat/useUserKicking.ts#L102) / [KickUserModal.tsx:150](../../components/KickUserModal.tsx#L150) | 2tap | dialog, single "Remove from Space" |
| Delete Channel | [SpaceSettingsModal.tsx:1262](../../components/SpaceSettingsModal.tsx#L1262) | alert | keep (good) — verify consequence copy |
| Delete Channel Group | [SpaceSettingsModal.tsx:1200](../../components/SpaceSettingsModal.tsx#L1200) | alert | keep |
| Delete Role | [SpaceSettingsModal.tsx:1136](../../components/SpaceSettingsModal.tsx#L1136) | alert | keep |
| Delete Message (space) | [MessageActionSheet.tsx:161](../../components/Chat/MessageActionSheet.tsx#L161) | alert | keep |
| Delete Farcaster Cast | [CastOverflowButton.tsx:96](../../components/SocialFeed/CastOverflowButton.tsx#L96) | alert | keep |
| Remove Device Key | [ProfileModal.tsx:3958](../../components/ProfileModal.tsx#L3958) | alert | keep |
| Reset All DM Sessions | [ProfileModal.tsx:3979](../../components/ProfileModal.tsx#L3979) | alert | keep |
| Disconnect Farcaster | [ProfileModal.tsx:2084](../../components/ProfileModal.tsx#L2084) | alert | keep |

### T1 — plain dialog
| Operation | File | Current | Target |
|---|---|---|---|
| Leave Space | [SpaceSettingsModal.tsx:1683](../../components/SpaceSettingsModal.tsx#L1683) | 2tap | **dialog** (remove double-tap) |
| Delete DM Conversation | [DMSettingsSheet.tsx:146](../../components/Chat/DMSettingsSheet.tsx#L146) | alert (DEAD) | keep dialog + **fix dead wiring** (see gaps) |
| Delete Custom Emoji | [SpaceSettingsModal.tsx:2105](../../components/SpaceSettingsModal.tsx#L2105) | alert | keep |
| Delete Custom Sticker | [SpaceSettingsModal.tsx:1062](../../components/SpaceSettingsModal.tsx#L1062) | alert | keep |
| Reset single DM session | [DMSettingsSheet.tsx:134](../../components/Chat/DMSettingsSheet.tsx#L134) | alert | keep |
| Remove User from Role | [UserProfileModal.tsx:209](../../components/UserProfileModal.tsx#L209) | **none** | **add dialog** (broadcasts to all) |
| Unpin Message (action sheet) | [MessageActionSheet.tsx:265](../../components/Chat/MessageActionSheet.tsx#L265) | **none** | **add dialog or Undo toast** (broadcasts) |

### T0 — no dialog (reversible / toggle) — leave as-is
Mutes (DM / space member / Farcaster), bookmarks, clear notifications, delete single
notification, unpin from personal pinned-panel, disable Hypersnap signer, mute/block
Farcaster. These are local toggles or trivially reversible — **no change**, except optionally
adding an Undo toast where a tap deletes a local non-toggle item (clear-notifications,
delete-notification-entry).

## Do NOT mirror the old cross-platform primitive

Desktop ships `src/components/modals/ConfirmationModal.native.tsx` (a React Native confirm
modal built on shared `Modal`/`Button` primitives). **It is a leftover from the abandoned
"one fully cross-platform repo" experiment, predating the current quorum-shared architecture
(user, 2026-06-13).** Do **not** adopt it and do **not** pull the shared `Modal`/`Button`
primitives into mobile for this — mobile renders through its **skin system**
(`@/theme/skins`), which those primitives don't use, so the result would look off-brand.

What we *do* mirror from desktop is the **contract and behavior**, not the rendering:
- the **keyword logic** for type-to-confirm (verified in the desktop sources below),
- the **no-accidental-dismiss** rules (buttons only; backdrop/back handled deliberately),
- the prop shape / tier semantics.

The pixels come from mobile's own skin system. This matches how `ActionSheet` already relates
to desktop's action menus: same job, mobile-native rendering.

## Reusable primitives to build

Mobile has **no** confirm/type-to-confirm component today (grep for `ConfirmModal`/`useConfirm`/
`TypeToConfirm` returns nothing). Build **one shared center-modal shell** and two thin views on
top of it — all **center-anchored** (see "Where the dialog sits" — NOT on `BaseModal`):

0. **`CenterModal` shell** (new, internal) — a skin-styled centered card on RN `Modal` that owns
   the cross-cutting concerns once: backdrop, centered card, skin colors/fonts, and the full
   **accessibility + back-button contract** below. Both views below render their content inside it.
   This is the single place the `Alert.alert`-for-free behaviors get re-implemented, so they're
   written and tested **once**.
1. **`ConfirmDialog`** (T1/T2) — `CenterModal` + title + body + Cancel/destructive buttons.
   Props: `{ visible, title, message, confirmLabel, variant?: 'danger', onConfirm, onCancel }`.
   The destructive button uses the skin **danger token** so it's visibly red on **both** iOS and
   Android (native `Alert.alert` cannot do this on Android — the core reason for going custom).
2. **`TypeToConfirmModal`** (T3 + Delete Space) — `CenterModal` + a stats preview block +
   `TextInput` + a destructive button disabled until `input.trim().toLowerCase() === keyword`.
   Mirror the **logic** (not the rendering) of desktop
   [Danger.tsx](../../../quorum-desktop/src/components/modals/SpaceSettingsModal/Danger.tsx)
   (`confirmInput.trim().toLowerCase() === 'delete'`, placeholder "Type DELETE to confirm") and
   [DangerZone.tsx](../../../quorum-desktop/src/components/modals/UserSettingsModal/DangerZone.tsx)
   (`=== 'reset'`) — both verified 2026-06-13. Props: `{ visible, title, body, keyword,
   confirmLabel, stats?, onConfirm, onCancel }`.

**Why a custom `ConfirmDialog` instead of native `Alert.alert` for T1/T2 (the decisive point):**
the `TypeToConfirmModal` *must* be a custom center modal regardless (it needs a text input native
alerts can't host), so the `CenterModal` shell + its a11y checklist get built **either way**.
Once that cost is paid, reusing the shell for `ConfirmDialog` is marginal, and it buys the two
things native can't give: a **red destructive button on Android** (native renders it as a plain
neutral button there) and **brand/skin consistency** (no stock-OS-dialog seam mid-app). See the
full risk weighing under "Q1 RESOLVED".

### Accessibility — owned by us the moment we leave `Alert.alert`

Native `Alert.alert` gives focus trapping, screen-reader announcement, and back-button dismissal
for free. Since **both** our dialogs are custom (Q1 RESOLVED → custom `ConfirmDialog`), the shared
`CenterModal` shell **must replicate all of it** — this is a build requirement, not a follow-up
(per the project a11y baseline). Implementing it in the shell means it's written and tested **once**
and inherited by both `ConfirmDialog` and `TypeToConfirmModal`:
- `accessibilityViewIsModal` + an `accessibilityRole` on the dialog; move focus to it on open.
- Title + body announced to screen readers.
- **Android hardware-back wired to `onCancel` (never to confirm)** via `Modal`'s `onRequestClose`.
- Backdrop tap = cancel (mobile-expected) and must never fire the destructive action.

> **Non-negotiable, gets an explicit test:** Android hardware-back and backdrop-tap must resolve
> to **cancel**, never confirm. This is the only failure mode in the whole standard that can
> *trigger* the destructive action instead of merely looking wrong (e.g. back-button deletes a
> Space). Test it on Android for both `ConfirmDialog` and `TypeToConfirmModal`.

Going custom does mean we own this a11y surface rather than getting it free from the OS — that is
the main *risk/cost* of the Q1 decision. It is mitigated by concentrating it in the one `CenterModal`
shell (finite, known checklist) and is outweighed by native's unfixable gaps on Android (see
"Q1 RESOLVED"). Correctly implemented, the custom guard is actually **safer** than native on
Android, where the native destructive button carries no visual danger cue at all.

## Bugs / dead wiring found in the audit (fix alongside)

- **Delete DM Conversation is a dead no-op** — `DMSettingsSheet` shows the confirm dialog but
  `app/(tabs)/messages/dm/[id].tsx` never passes `onDeleteConversation`. Wire it to
  `mmkvAdapter.deleteConversation`.
- **Delete DM message is absent** — `useDeleteDirectMessage` exists but `DMChatArea` never
  passes `onDelete`/`canDeleteMessage` to `MessagesList`, so the action never renders.
- **Remove User from Role / Unpin (action sheet)** fire with **no confirmation** despite
  broadcasting to all members.
- Copy cleanup: every "Click again to confirm" string dies with the double-tap removal; any
  remaining "Click"/"Tap" copy should read naturally on touch.

## Build sequence (proposed — for the implementation task)

1. Build the `CenterModal` shell (center-anchored, skin-styled, owns the full a11y +
   back-button contract above), then `ConfirmDialog` and `TypeToConfirmModal` on top of it. Add
   unit-ish render checks **including the Android-back-and-backdrop-resolve-to-cancel test**. Do
   NOT use `BaseModal` (bottom-anchored) or the old desktop shared-primitive
   `ConfirmationModal.native.tsx`.
2. T3: Reset App Data → `TypeToConfirmModal` (`reset`). Delete Space → `TypeToConfirmModal`
   (`delete`) with channel/member stats. Remove the `deleteConfirmStep` double-tap machinery.
3. T2: Kick User → `ConfirmDialog`, drop `useUserKicking` confirmation state machine (keep the
   kick service path untouched). Then migrate the existing T2 `Alert.alert` call sites (Delete
   Channel / Group / Role / Message / Cast, Remove Device, Reset All DM Sessions, Disconnect
   Farcaster) to `ConfirmDialog` and verify each has consequence copy.
4. T1: Leave Space → `ConfirmDialog` (drop `leaveConfirmStep`). Migrate the existing T1
   `Alert.alert` call sites to `ConfirmDialog`. **Add** `ConfirmDialog` to the two unguarded
   broadcasts (Remove-from-Role, action-sheet Unpin). Fix the two dead-wiring bugs.
5. Sweep for leftover `confirmationStep` / `deleteConfirmStep` / `leaveConfirmStep` /
   `confirmationTimeout` and any "Click again" strings.
6. `yarn tsc --noEmit` + `yarn lint`. Runtime QA on each converted op (esp. that the kick and
   delete-space crypto paths still fire exactly once).

## Resolved questions (2026-06-13)

The three former open questions are resolved; only #1 wants a lead-dev sign-off (it sets the
build's component surface). #2 and #3 are settled.

1. **`ConfirmDialog` mechanism** — **RESOLVED (user + analysis, 2026-06-13): build a custom
   skin-styled `ConfirmDialog` for T1/T2 (sharing a `CenterModal` shell with
   `TypeToConfirmModal`). Do NOT keep T1/T2 on native `Alert.alert`.** This reverses the earlier
   draft recommendation. *Still wants a one-line lead-dev sign-off* — it's the decision that sets
   the build's component surface — but the direction is decided.

   **Web-verified platform facts** (iOS HIG + RN guidance, 2026-06-13):
   - Native alerts *are* HIG-sanctioned for app destructive confirms — the "native-only-for-OS-stuff"
     intuition is **not** an actual platform rule. So native isn't *wrong*.
   - BUT: `Alert.alert`'s `destructive` style **only colors the button red on iOS; on Android it
     renders as a plain neutral button** — no visual danger cue at all. Unfixable via the API.
   - And native alerts **cannot carry the skin** (fonts, danger token), leaving a stock-OS-dialog
     seam mid-app (the same seam already noted at `MessageActionSheet.tsx:161`).

   **Why custom wins despite real risks:**
   - *Decisive:* this is a standard whose whole job is making dangerous actions *look* dangerous —
     and native gives ~half the userbase (Android) no red cue. That guts the purpose.
   - *Cost is already sunk:* `TypeToConfirmModal` must be custom regardless (needs a text input),
     so the `CenterModal` shell + a11y checklist are built **either way**. Reusing the shell for
     `ConfirmDialog` is marginal extra work — this flips the earlier "a11y paid once → choose
     native" argument, since it's paid once *either way*.

   **Risks of going custom (accepted, mitigated):** we inherit focus-trap, screen-reader announce,
   Android-hardware-back, and backdrop-tap handling that native gave for free — and getting the
   back/backdrop ones wrong could *trigger* the destructive action. Mitigated by concentrating all
   of it in the single `CenterModal` shell with the mandatory test (see the a11y section). Net: a
   correctly-built custom guard is *safer* than native on Android, not just prettier.

   **Rejected — hybrid (custom T2, native T1):** worst of both. You build the custom component
   anyway (no work saved) *and* ship two confirm patterns (less consistent than either pure
   option). Only saves converting a few T1 call sites — not worth the fragmentation.

   (Independent of the *old desktop primitive* question — resolved separately under "Do NOT mirror
   the old cross-platform primitive". Custom here means a **fresh skin-native** component, never
   the shared `Modal`/`Button` primitives.)
2. **Undo toasts** — **RESOLVED: deferred, T0 stays as-is.** Premise corrected: mobile already
   has [components/ui/Toast.tsx](../../components/ui/Toast.tsx) (~15 call sites), but it's
   transaction-feedback specific (txHash/explorerUrl, success/error/info), has no action/Undo
   button and no global imperative host (each call site renders its own `<Toast>` with local
   `visible` state). Undo would need an `action`/`onAction` prop + a global host — a small
   extension, not a missing dependency. Out of scope for this task.
3. **Delete-space stats preview** — **RESOLVED: feasible, include it.** Mobile exposes
   `useSpaceMembers(spaceId)` ([useSpaces.ts:25](../../hooks/chat/useSpaces.ts#L25), already
   exported via [hooks/chat/index.ts](../../hooks/chat/index.ts#L9) and used by the Members tab),
   so member count = `useSpaceMembers(spaceId).data?.length ?? 0`. Channel count is derivable
   from `space.groups` exactly as desktop's `Danger.tsx` does:
   `space.groups.reduce((n, g) => n + (g.channels?.length ?? 0), 0)`. The `TypeToConfirmModal`
   `stats?` prop carries these into the Delete-Space instance.

---
## Sources (platform guidance, verified 2026-06-13)

- [iOS HIG — Alerts](https://miniring.gitbook.io/hig/views/alerts) — alerts are sanctioned for
  confirming destructive actions; use action sheets for choice menus; mark destructive buttons
  with the destructive style; provide a Cancel.
- [A Developer's Guide to Using Alert in React Native (gluestack)](https://market.gluestack.io/blog/alert-in-react-native)
  — `destructive` style turns the button red **on iOS only; on Android it looks like a default
  button**; switch to custom modals for branded/consistent destructive styling.
- [Best Tips to Use Custom React-Native Alert (folio3)](https://www.folio3.com/mobile/blog/use-custom-react-native-alert/)
  — native alert's platform-specific look doesn't fit a branded app; custom modals give full
  control over colors/fonts/layout for a consistent cross-platform experience.

---
*Last updated: 2026-06-15 — status → merged. Shipped PR #93 (squash `c601fd1`) to mobile master;
branch deleted. Built across Part 1 (`02b8786`) + Part 2 (`1fedf60`) + ActionSheet Cancel removal &
cast reorder (`cb15455`); merged latest master / role PR #92 (`7bbd9ea`). High-effort code review
applied (stable `confirmDialog` element + nested-Modal back guard); fixed a route-mode-vs-modal-mode
dialog-placement bug found in QA. Runtime-tested on Android (user-confirmed); iOS visual unverified.
tsc 82 / lint baseline.*

*Previously: 2026-06-13 — Q1 REVERSED to custom: after web-verifying that native `Alert.alert`
gives no red destructive button on Android and can't carry the skin, decided to build a custom
skin-styled `ConfirmDialog` for T1/T2 sharing a `CenterModal` shell with `TypeToConfirmModal`
(a11y + Android-back-must-cancel as a hard, tested build requirement). Pending one-line lead-dev
sign-off. Earlier same-day: Q2 Undo toasts (deferred), Q3 delete-space stats preview (feasible,
include it); and merged the "themed confirmation dialog" analysis (sheet-vs-center-modal placement
rule, accessibility obligations, don't-mirror-old-shared-primitive resolution, corrected toast
premise).*
