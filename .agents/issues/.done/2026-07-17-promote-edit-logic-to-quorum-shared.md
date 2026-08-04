---
type: task
title: "Promote edit-window + apply-received-edit logic into quorum-shared (mobile↔desktop single source of truth)"
status: done
priority: low
created: 2026-07-17
shared_change: required (this IS a shared change) — lead-gated publish
version_bump: required (new shared exports)
blocks: nothing (mobile DM-edit ships without it via mobile-local editHistory)
---

## PROGRESS

**STEP 1 DONE — merged to quorum-shared master** (PR #58, commit 93f5291): added
`src/utils/editHistory.ts` (`MESSAGE_EDIT_WINDOW_MS = 15*60*1000`, `buildLocalEdits`,
`applyReceivedEdit`) + unit test, exported via the utils barrel. Build/typecheck/tests green.

**PUBLISHED (2026-07-20)** — the shared symbols are live in `@quilibrium/quorum-shared@2.1.0-35`
(verified in installed `dist/utils/editHistory.d.ts` on both mobile and desktop). The old "BLOCKED
on lead publishing" note is resolved; steps 2 + 3 are unblocked.

**STEP 3 DONE (mobile, 2026-07-20)** — branch `refactor/edit-logic-use-shared-helpers`, commit
24f3014. Deleted `utils/editHistory.ts`; swapped `buildLocalEdits`/`applyReceivedEdit` +
`MESSAGE_EDIT_WINDOW_MS` imports to `@quilibrium/quorum-shared` in the 3 hooks + WebSocketContext
(incl. the two inline `15 * 60 * 1000` DM-receive window checks). Pure refactor; `tsc` clean (the
lone WebSocketContext:4915 error is pre-existing, confirmed via stash-compare on master). Safe to
merge standalone — no local-shared link involved.

**STEP 2 — WINDOW CONSTANT DONE (desktop, 2026-07-20)** — branch
`refactor/edit-window-use-shared-constant`. Replaced all 5 `15 * 60 * 1000` edit-window literals
with the shared `MESSAGE_EDIT_WINDOW_MS` constant (MessageService.ts 4 sites: 1421, 1935, 2711,
5506 — the `editTimeWindow` alias inlined out; useMessageActions.ts:103). Pure refactor, tsc clean,
eslint 0 errors (3 pre-existing warnings unrelated). Clears the "no `15 * 60 * 1000` literals left"
acceptance criterion for desktop.

**STEP 2 — EDIT-APPLY CONVERGED, but the OTHER way than the task assumed (2026-07-20).** Deep read
found the platforms used INCOMPATIBLE `edits[]` shapes, and the **old shared/mobile helpers were the
buggy ones**:
- **Desktop (correct)**: `edits[]` = prior versions only, seeded on first edit with the *original*
  (keyed by original nonce/createdDate); `content.text` = current; timeline = `[...edits, current]`.
- **Old shared/mobile (buggy)**: `edits[]` appended the *new* text keyed by `editNonce`/`editedAt`,
  never seeding the original → the original version is **lost** and the current version is
  **duplicated** in the timeline (mobile's `EditHistoryModal` even passes `originalText = current
  content`). Masked because ~zero beta users have edit history.

Decision (user, beta, ~zero edit-history users): **converge on desktop's correct model, promoted to
shared.** Done:
- **quorum-shared**: replaced `buildLocalEdits`/`applyReceivedEdit` with a single
  `applyEdit(current, {editedAt, editNonce, saveEditHistory})` embodying desktop's model (replay
  guard inert on send, active on receive). 8 tests green. **PR #64 squash-merged to master.**
- **Desktop**: adopts `applyEdit` (branch `refactor/desktop-use-shared-edit-history`) — receive path
  in `MessageService.ts`, send/optimistic in `MessageEditTextarea.tsx`, plus the 5 window literals →
  `MESSAGE_EDIT_WINDOW_MS`. Pure refactor (matches desktop's prior behavior); tsc + 124 service tests
  green. Consumes shared via local link.

**STILL OPEN — MOBILE (lead's territory):** mobile still imports the removed `buildLocalEdits`/
`applyReceivedEdit`. On its next shared **pin bump** (needs a shared npm publish first) it must:
(1) adopt `applyEdit` (new signature) in the 3 hooks + `WebSocketContext`, and (2) fix
`EditHistoryModal` to pass the *real* original (it currently passes the current content). This fixes
mobile's latent edit-history bug.

# Promote edit logic to quorum-shared

## Why

Spun out of `2026-07-16-dm-edit-message-sync-desktop-parity.md` (2026-07-17). While closing the
mobile DM-edit gap we mapped what is / isn't shared for message editing. Two pieces are duplicated
across mobile and desktop and SHOULD live in quorum-shared so both apps are provably identical:

| Piece | Shared today? | Reality |
|---|---|---|
| `EditMessage` wire type | ✅ shared | both import it — no action |
| `MAX_MESSAGE_LENGTH` (2500) | ✅ shared | both import it — no action |
| **15-min edit window** | ❌ | magic `15 * 60 * 1000` duplicated: mobile (3 hooks) + desktop (MessageService.ts ~5 sites: 1188, 1671, 2500, 5023, + useMessageActions.ts:103) |
| **apply-received-edit / build-edits + editNonce replay guard** | ❌ | mobile factored into `utils/editHistory.ts` (`applyReceivedEdit`, `buildLocalEdits`); **desktop re-inlines** the same isAlreadyApplied / edits-array logic at each edit site (MessageService.ts:1230-1247 etc.) |

## Scope

1. **Add to quorum-shared** (canonical order: shared → publish → desktop → mobile LAST — see
   [[shared-publish-order-new-wire-type]]; this is pure helper logic, NOT a wire type, so it doesn't
   block either app, but the promotion itself is lead-gated):
   - `MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000` — 15-minute window, kept deliberately short. See
     research note below.
   - `applyReceivedEdit()` + `buildLocalEdits()` — lift mobile's `utils/editHistory.ts` verbatim
     (it's already platform-agnostic; the doc comment even says it mirrors desktop MessageService
     ~1100-1160).
2. **Desktop**: replace inlined edit-apply logic + magic windows with the shared helpers/constant.
3. **Mobile**: delete `utils/editHistory.ts`, swap all imports to `@quilibrium/quorum-shared`; swap
   the 3 hooks' local `EDIT_WINDOW_MS` to the shared constant.

## Edit-window research (2026-07-17, why 15 min stays)

Researched real-world edit windows across mainstream messengers. Encrypted/personal-DM apps cluster
at a short window (~15 min); work/community tools are much looser (hours to unlimited). Our 15 min
sits with the short-window group, which is the right fit for encrypted personal DMs — an edit is for
fixing a just-noticed typo, not silently rewriting history a peer already read. Also: a long window
interacts badly with unreliable DM cross-device delivery (edits arriving long after `createdDate`).
Decision (user, 2026-07-17): keep 15 min.

## Acceptance
- One definition each of the window + edit-apply logic, in shared; both apps import it.
- No `15 * 60 * 1000` edit-window literals left in either app; no inlined isAlreadyApplied logic.
- Behavior unchanged in both apps (pure refactor). Typecheck + lint green in both.

*Last updated: 2026-07-20*
