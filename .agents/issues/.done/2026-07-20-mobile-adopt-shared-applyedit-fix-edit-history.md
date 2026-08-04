---
type: task
title: "Mobile: adopt shared applyEdit + fix EditHistoryModal (preserve original version)"
status: done
priority: medium
created: 2026-07-20
implemented: 2026-07-21 (branch fix/mobile-adopt-shared-applyedit, commit 53fe3f3) — code-complete + tsc-clean; on-device UI verification (Original→B→Current) still pending
severity: MEDIUM (latent data/display bug — mobile edit history loses the original version)
platforms: quorum-mobile (+ depends on a quorum-shared publish)
related:
  - quorum-mobile .agents/issues/.done/2026-07-17-promote-edit-logic-to-quorum-shared.md (origin)
  - quorum-shared PR #64 (merged master — the applyEdit fix mobile must adopt)
---

# Mobile: adopt shared `applyEdit` + fix EditHistoryModal

## Why (self-contained)

quorum-shared's edit-history helpers were **buggy**: `buildLocalEdits` /
`applyReceivedEdit` appended the **new** text to `edits[]` and never captured
the original. Result: the first version of an edited message is **lost** and the
current version is **duplicated** in the edit-history timeline. Masked because
~zero beta users have edit history enabled.

This was fixed in **quorum-shared PR #64 (squash-merged to master)**: both
helpers were REPLACED by a single `applyEdit`, embodying the correct model that
desktop already used. Desktop adopted it (branch
`refactor/desktop-use-shared-edit-history`) as a pure refactor. **Mobile still
imports the removed helpers and still has the buggy display**, so mobile must
adopt `applyEdit` and fix its `EditHistoryModal`.

## The correct model (what `applyEdit` implements)

- `edits[]` retains **prior versions**, oldest first. The message's live
  `content` / `text` is always the **current** version.
- The **first** edit seeds the **original** into `edits[0]` (keyed by the
  original nonce/createdDate). Each later edit appends the version it replaces.
- A viewer reconstructs the full timeline as **`[...edits, current]`** — never
  losing the original, never duplicating the current.
- `saveEditHistory` OFF → `edits: []`. RECEIVE replay guard: an edit whose
  `editNonce` equals the stored `lastModifiedHash` is a no-op (`changed:false`);
  empty `editNonce` (legacy) skips the guard and always applies.

## New shared API (replaces the two old functions)

```ts
applyEdit(
  current: {
    text: string | string[];   // CURRENT (pre-edit) text — becomes a prior version
    createdDate: number;
    modifiedDate: number;
    nonce: string;             // original message nonce (keys the seeded original)
    lastModifiedHash?: string; // last applied edit nonce (drives replay guard)
    edits?: Message['edits'];  // prior versions already retained
  },
  params: { editedAt: number; editNonce?: string; saveEditHistory: boolean },
): {
  changed: boolean;            // false = replay, make NO change
  modifiedDate: number;        // set message.modifiedDate to this when changed
  lastModifiedHash: string;    // set message.lastModifiedHash to this when changed
  edits: EditEntry[];          // prior versions after this edit
}
```

Note vs the old helpers: `applyEdit` needs the message's **current text +
createdDate + modifiedDate + nonce** (the old ones didn't). Mobile call sites
have the message object, so pass them. The caller still sets `content.text` to
the NEW text itself; `applyEdit` only computes `edits` + the two hashes.

## STEP 0 — unblock the shared dependency (REQUIRED FIRST) — DONE

Mobile pins `@quilibrium/quorum-shared@2.1.0-36` (bumped from -35). Verified the
installed `dist/utils/editHistory.d.ts` exports `applyEdit` and NO longer
`buildLocalEdits`/`applyReceivedEdit` before writing code.

## IMPLEMENTATION NOTES (2026-07-21)

Done on branch `fix/mobile-adopt-shared-applyedit` (commit 53fe3f3):
- Send/optimistic: `useEditDirectMessage.ts` (mutationFn storage write + onMutate
  cache) and `useEditSpaceMessage.ts` (onMutate cache + stored write) now call
  `applyEdit`. Each preserves mobile's read of the actual `saveEditHistory`
  setting (mobile does NOT get its own edit echoed back, so it can't rely on a
  receive-side reconcile the way desktop's optimistic path does; the local write
  must honor the real setting). onMutate paths pass no `editNonce` (transient
  optimistic state, reconciled by the mutationFn storage write).
- Receive: all 5 `applyReceivedEdit` call sites in `WebSocketContext.tsx`
  swapped to `applyEdit`. The space-batch site had a LOCAL function literally
  named `applyEdit` — renamed to `transformEdit` to avoid shadowing the import.
- Display: `EditHistoryModal.tsx` rebuilt to `[...edits (oldest first), current]`
  mirroring desktop; labels Current / Original (modifiedDate === createdDate) /
  Edit #N. `MessagesList.tsx` call site now passes `currentText` / `currentDate`
  (originalMessage.modifiedDate) / `createdDate` (timestamp) instead of the old
  `originalText` (which mislabeled the CURRENT text as original).
- tsc clean for all 5 files (24 pre-existing repo errors unchanged, none in
  edit-history code). PENDING: on-device UI test (Original A → B → Current C) for
  DM + Space, self-edit AND received edit.

## Mobile scope (exact sites)

**1. Send / optimistic paths — swap `buildLocalEdits` → `applyEdit`:**
- `hooks/chat/useEditDirectMessage.ts` — import at line ~26; calls at ~102, ~234.
- `hooks/chat/useEditSpaceMessage.ts` — import at line ~13; calls at ~142, ~161.

Each currently does `edits: buildLocalEdits(m.edits, newText, editedAt, save)`.
Replace with:
```ts
const applied = applyEdit(
  { text: m.content /* current text */, createdDate: m.createdDate,
    modifiedDate: m.modifiedDate, nonce: m.nonce,
    lastModifiedHash: m.lastModifiedHash, edits: m.edits },
  { editedAt, editNonce, saveEditHistory: save },
);
// then: content.text = newText; modifiedDate = applied.modifiedDate;
//       lastModifiedHash = applied.lastModifiedHash; edits = applied.edits
```
(Confirm the exact field names on mobile's message objects — the desktop
reference uses `content.text`, `createdDate`, `modifiedDate`, `nonce`,
`lastModifiedHash`, `edits`.)

**2. Receive path — swap `applyReceivedEdit` → `applyEdit`:**
- `context/WebSocketContext.tsx` — import at line ~38; calls at ~2021, ~2050,
  ~3002, ~3813, ~4561 (grep `applyReceivedEdit` for the full list).

Each currently does `const applied = applyReceivedEdit(msg, {newText, editedAt,
editNonce, saveEditHistory})` and reads `applied.edits` / `applied.changed`.
Change to `applyEdit(msg-as-current-state, {editedAt, editNonce,
saveEditHistory})` — supply the current text/createdDate/modifiedDate/nonce from
`msg`. Keep honoring `applied.changed` (skip on replay).

**3. Fix `EditHistoryModal` (the display bug):**
- `components/Chat/EditHistoryModal.tsx` builds `timeline = edits + {originalText,
  isOriginal}` and `components/Chat/MessagesList.tsx:1422` passes
  `originalText={editHistoryMessage?.content}` — i.e. the **current** text
  mislabeled as original. Under the new model the original lives in `edits[0]`.
- Fix: mirror desktop's `EditHistoryModal.tsx` — timeline = **`edits` (prior
  versions, oldest first) + the CURRENT message text appended as the latest
  entry**. Stop passing the current content as `originalText`. The "original"
  label is just `edits[0]` (its `modifiedDate === createdDate`).
- `components/Chat/types.ts:494-497` (`isEdited`/`hasEditHistory`/`editedAt` off
  `edits.length`) stays correct — `edits` is still non-empty after an edit with
  history on.

## Reference implementation (desktop — mirror it)

- Apply logic: `quorum-desktop/src/services/MessageService.ts` (receive/DB apply
  site — `applyEdit` + `if (!applied.changed) return;`) and
  `src/components/message/MessageEditTextarea.tsx` (send/optimistic).
- Display: `quorum-desktop/src/components/modals/EditHistoryModal.tsx` —
  `timeline = [...edits (prior, incl. original), current]`.

## Verification

- `tsc` clean; no remaining imports of `buildLocalEdits`/`applyReceivedEdit`.
- UI: enable Save Edit History (DM + Space), post "A", edit → "B", edit → "C",
  open Edit History → timeline shows **Original "A" → "B" → Current "C"** (no
  lost original, no duplicated current). Test both a self-edit AND a received
  edit from another participant (the receive path is the most-changed code).

## Acceptance

- Mobile uses shared `applyEdit` for both send and receive; no local edit-history
  logic remains.
- Mobile Edit History timeline is correct for DM + Space (original preserved,
  current not duplicated), matching desktop.
