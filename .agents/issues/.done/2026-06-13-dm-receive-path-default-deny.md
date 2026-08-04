---
type: task
title: Extend default-deny to the DM receive path (parity with the space feed)
status: done
created: 2026-06-13
updated: 2026-07-16
urgency: Tier 3 (pre-existing gap, no user-visible symptom; disk-hygiene + fail-closed hardening)
shared_change: none
version_bump: none
runtime_test: hard (DM cross-device sync unreliable — rely on static verification + independent review)
branch: fix/dm-receive-path-default-deny
---

# Extend default-deny to the DM receive path

## Status

code-complete + independently reviewed, Option A) — ready to ship; runtime unverified (DM sync unreliable, relied on static review)


> **🛑 2026-07-16 — independent code review caught a CRITICAL regression in the naive guard.**
> A first implementation (commit on `fix/dm-receive-path-default-deny`) added the plain
> allow-list guard to both DM paths. An independent review + code re-verification found:
>
> **CRITICAL — `edit-message` would be wrongly dropped AND deleted from the server.**
> `edit-message` is handled ONLY on the two SPACE paths (`WebSocketContext.tsx:1874` live /
> `:3470` batch). There is **NO** `edit-message` handler on either DM path, and it's NOT in
> `PERSISTABLE_TYPES`. So the naive guard catches a DM `edit-message`, drops it, and deletes it
> from the inbox. Desktop DOES send `edit-message` over DMs (verified in `quorum-desktop`
> `MessageService.ts:1148/1631` + a "DM edit-message authorization (anti-spoofing)" unit test).
> Result: a desktop→mobile DM edit would be permanently lost.
>
> **Why the 2026-07-15 premise was wrong:** it claimed "DMs now have handlers for all applied
> types." They have handlers for remove-message / dm-update-profile / delete-conversation(-self)
> — but NOT edit-message. That one was never ported to DMs.
>
> **State of mobile DM edit today (verified):** `hooks/chat/useEditDirectMessage.ts` is
> **local-only** — despite its header comment it does NOT send `edit-message` over the wire
> (no `sendEncrypted*` call; it only does a local `storage.saveMessage`). So mobile→mobile DM
> edits never travel. The only real cross-device DM edit is desktop→mobile, which today lands
> as saved-but-invisible junk; the naive guard would make it worse (dropped + server-deleted).
>
> **HIGH — batch path saves the conversation row (preview/timestamp) BEFORE the type checks**
> (`saveConversation` at ~3990/4000, before the reaction/remove/guard block at ~4011+). So a
> dropped type still leaves a stale `lastMessagePreview`. Pre-existing quirk the guard makes
> more visible; JS path already guards before its conversation-save.
>
> **MEDIUM — receipts bypass the guard.** `delivery-ack`/`read-ack` are FLAT objects
> (`content?.type` is undefined), so `dmContentType` is falsy and the guard never fires — they
> still leak to `saveMessage`. This is the known phantom-self-row bug
> ([[dm-phantom-self-row-is-unhandled-receipts]]); the guard neither fixes nor worsens it, but
> the guard comment must not claim it "handles all cases."

## ✅ DECISION NEEDED / RECOMMENDED PATH (2026-07-16)

Three ways to ship this safely:

- **Option A (RECOMMENDED) — carve `edit-message` OUT of the guard, ship the rest.** Let
  `edit-message` fall through unchanged (saved-but-invisible today, NOT deleted) instead of
  being dropped. This ships the fail-closed hardening for genuinely-unknown/future types with
  **zero regression** vs today. Fully statically verifiable, no risky DM runtime test. The
  DM-edit gap stays a separate task. ~2-line change to the guard on each path. **Do the HIGH
  batch-ordering fix in the same PR** so the guard is consistent with the JS path.
- **Option B — port a full DM `edit-message` receive handler** (mirror space `:1874/:3470` with
  DM session-sender auth), then guard. Makes desktop→mobile DM edits actually apply. But a
  complete feature also needs the SEND side to transmit (today it's local-only), so this is a
  real DM-edit feature port, not hardening — bigger, cross-cutting, and needs the DM runtime
  testing that's currently unreliable. Spin as its own task.
- **Option C — shelve.** Keep this doc updated; ship nothing now.

**Chosen: Option A** — DONE 2026-07-16. Implemented on `fix/dm-receive-path-default-deny`:
- Guard added to both DM paths (JS/fallback + batch), mirroring the space path.
- `DM_GUARD_PASSTHROUGH_TYPES = {'edit-message'}` in `components/Chat/types.ts` — the guards
  skip it, so DM edit-message behavior is IDENTICAL to master (saved-but-hidden, not deleted).
- Batch-path HIGH fix: `saveConversation` deferred below the folds+guard, so a reaction/remove/
  dropped type no longer bumps the DM row's preview/timestamp.
- MEDIUM (flat receipts bypass the guard) left as-is + documented in the guard comments; it's the
  separate DM-receipts wiring task.
- Verified: 0 new tsc/lint errors; TWO independent code reviews (2026-07-16) — the first caught
  the Critical, the second confirmed Option A resolves it with zero regression and the reorder is
  scope-safe.
- **Runtime NOT verified** (DM cross-device sync unreliable — [[dm-cross-device-sync-unreliable-blocks-testing]]);
  shipped on static-review confidence. The one residual manual check if ever possible: a normal
  DM (post/image/sticker) still lands + a call-event still shows.

Follow-up task for the real DM-edit port (Option B — the actual "edits sync desktop↔mobile in DMs
too" feature): `issues/.done/2026-07-16-dm-edit-message-sync-desktop-parity.md`. When that lands, remove
`edit-message` from `DM_GUARD_PASSTHROUGH_TYPES`.

---

> **2026-07-15 re-verification (fresh code read) — PARTIALLY SUPERSEDED by the 07-16 review above.**
> This said the DM path had GAINED applied-type handlers (remove-message, dm-update-profile,
> delete-conversation, delete-conversation-self) — TRUE — and concluded the guard was a clean
> low-risk copy — **FALSE**: it missed that `edit-message` was never ported to DMs (see the
> Critical above). Line numbers below are still current-ish but re-verify before editing.

## What this is (one paragraph)

`PERSISTABLE_TYPES` is a **fail-closed allow-list**: on the SPACE feed, only known content
types (`post`/`embed`/`sticker`/`join`/`leave`/`kick`/`call-event`/`space-call-*`) are saved
to storage; anything else (control types like `pin`/`mute`/`thread`, or any type mobile
doesn't yet understand because desktop ships ahead of mobile) is dropped before save so it
can't become a junk bubble or bloat MMKV. The SPACE path already does this. The **DM path
does not** — it still default-*allows* (saves anything that isn't explicitly intercepted).
This task adds the identical guard to the two DM save points so DMs also fail closed.

## ⚠️ Does this block future DM features (pin/thread/mute/bookmarks)? NO — verified.

The guard is a **backstop placed LAST**, right before `saveMessage`, AFTER all applied-type
handlers. A future feature is added *additively*, never by undoing this:
- **Control action** (pin/thread/mute/bookmark — modifies state, not a new bubble): add a
  handler branch that `return`s, placed ABOVE the guard (exactly like the existing `mute`
  handler on the space path, `WebSocketContext.tsx:2027`). The guard never sees it.
- **New displayable content type**: add its name to `PERSISTABLE_TYPES` + a render branch in
  `getMessageRenderType`. One-line allow-list addition.
The only discipline: future DM handlers go ABOVE the guard. That's why we place the guard at
the very bottom of the per-message block (see Implementation). Nothing here needs reverting later.

## Current state (verified 2026-07-15, `context/WebSocketContext.tsx`)

**`PERSISTABLE_TYPES`** — `components/Chat/types.ts:34` (exported, already used by the space
paths). Do NOT create a DM-specific copy; reuse this set. The `__DEV__` invariant check at
`types.ts:54` enforces "every persistable type has a real render branch."

**SPACE paths (the template — already guarded):**
- live: guard at `WebSocketContext.tsx:2195` (`if (contentType && !PERSISTABLE_TYPES.has(contentType)) { drop-inbox; return; }`)
- batch: guard at `WebSocketContext.tsx:3623` (identical rule)
- Both run AFTER the applied-type handlers: `reaction` (1746/3372), `remove-reaction`
  (1818/3406), `edit-message` (1874/3425), `remove-message` (1949/3462), `mute` (2027/3510),
  `update-profile` (2099/3562) — each `return`/`continue`s before the guard.

**DM paths (the gap — NO guard):**

| DM path | Applied-type handlers present (all `return` before save) | Unguarded save |
|---|---|---|
| **JS / fallback** (~2600–2830) | call-signaling intercept (2679); `dm-update-profile` via `applyDmProfileUpdate` (2722); `remove-message` (2731); `delete-conversation` (2767); `delete-conversation-self` drop (2777) | **`storage.saveMessage` at 2819** — anything reaching here is saved unconditionally |
| **batch** (~3840–4085) | `dm-update-profile` (3852); `delete-conversation` (3871); `delete-conversation-self` (3897); `reaction`/`remove-reaction` fold (3948); `remove-message` fold (4025) | **`storage.saveMessage` at 4081** — same gap |

So on BOTH DM paths, every control type mobile currently understands already `return`s/`continue`s
before the save. What's left hitting the save is: real content (post/embed/sticker/call-event) +
anything unknown. Adding the guard drops only the unknown tail. **The applied-type-safety question
the old task raised is now resolved by code** — those handlers exist and run first.

## Why low-urgency (not a visible bug)

The `DMChatArea` render filter (`renderType !== 'unsupported'`) already hides any junk bubble, so
there's no visible symptom. What remains:
- Unknown-type DMs persist to MMKV forever (saved, never rendered) — slow disk bloat / hygiene.
- `lastMessagePreview` can go `''` for an unsupported type.
This is fail-closed hardening + hygiene, not a correctness/UX fix. Priority accordingly.

## Implementation

Mirror the space-path guard on both DM save points. Place each guard **immediately before the
`storage.saveMessage` call, after all existing applied-type handlers** (so it's the clear
"future handlers go above this line" backstop).

1. **JS/fallback path** — insert before `WebSocketContext.tsx:2819`:
   ```ts
   const dmContentType = decryptedMessage.content?.type;
   if (dmContentType && !PERSISTABLE_TYPES.has(dmContentType)) {
     logger.debug(`[DM] default-deny dropped unsupported type=${dmContentType}`);
     getDeviceKeyset().then(dk => {
       if (dk) deleteInboxMessages(message.inboxAddress, [message.timestamp], dk).catch(() => {});
     });
     return;
   }
   ```
   (Match the inbox-cleanup-before-drop pattern the surrounding handlers already use, e.g. the
   `remove-message` branch at 2759, so a dropped message can't replay on reconnect.)

2. **Batch path** — insert before `WebSocketContext.tsx:4081`, using `continue` (loop context)
   instead of `return`, and the batch path's own inbox-delete pattern (see the `remove-message`
   fold at 4062–4076 for how the batch resolves the original message + signing key). `dmContentType`
   is already in scope on the batch path (used at 3948).

3. Reuse the SAME `PERSISTABLE_TYPES` import already at `WebSocketContext.tsx:21`. No third list.

4. Do NOT touch the applied-type handlers or their order. The guard is purely additive.

## Acceptance criteria

- [ ] An unknown-type DM (synthetic e.g. `'poll'`) is dropped before save on the JS/fallback path.
- [ ] Same on the DM batch/reconnect path.
- [ ] All currently-working DM types still work: post, embed, sticker, call-event, reaction,
      remove-reaction, remove-message (delete-for-everyone), dm-update-profile,
      delete-conversation. (Verify react-from-peer + delete-from-peer still apply.)
- [ ] Both DM paths use the SAME `PERSISTABLE_TYPES` set — and the same set as the space paths.
- [ ] No DM inbox replay loop: a dropped DM message does not reappear after reconnect.
- [ ] Guard sits at the BOTTOM (right before save), after all handlers — so a future
      pin/thread/mute/bookmark handler added above it works without touching the guard.
- [ ] Typecheck + lint green; runtime-tested on device (send/receive a normal DM, a reaction,
      a delete; confirm normal DMs still land).

## Notes / risk

- Risk ranking: (1) placing the guard too high and dropping a legit applied type — avoided by
  putting it last, after every handler; (2) wrong inbox-cleanup call on the batch path — copy the
  exact pattern from the adjacent `remove-message` fold; (3) `continue` vs `return` — batch uses
  `continue`, JS/fallback uses `return`.
- Forward-compat: `delete-conversation-self` is already dropped explicitly (2777/3897) pending
  mobile Part 2 — the new guard would also catch it, but the explicit handlers run first and stay
  the source of truth; leave them.
- Related: `2026-06-25-dm-delete-conversation-signal-and-self-sync.md` (Part 2 will add a real
  `delete-conversation-self` handler above the guard when it lands).

---

## Original background (2026-06-13 — kept for context, superseded by the section above)

The space-feed task `2026-06-13-harden-unsupported-message-type-handling.md` (SHIPPED as PR #83)
converted the space receive path to explicit default-deny and added the render-side
`renderType !== 'unsupported'` filter in both `SpaceChatArea` and `DMChatArea`. A code review of
that change surfaced that the DM receive path had no pre-save default-deny — only the space paths
drop-before-save. At that time the DM path had NO handlers for `edit-message`/`remove-message`/
`update-profile` (only reaction/remove-reaction + call interception), so the task warned that a
DM default-deny must first confirm those control types were genuinely unimplemented before dropping
them. **That concern is now moot: those handlers were subsequently added (PRs #144/#145) and all
`return` before the save — see "Current state (verified 2026-07-15)" above.**

*Created: 2026-06-13*
*Last updated: 2026-07-15*
