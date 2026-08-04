---
type: task
title: "DM delete-own-message — propagate remove-message to counterparty + own devices (match desktop)"
status: done
created: 2026-06-17
updated: 2026-06-25
source: port-to-mobile candidates #36
priority: medium
effort: send side moderate (mirrors useSendDirectReaction); receive side net-new DM branch (mirrors the reaction branch in applyDMGroupResults)
---

# DM delete-own-message: make it match desktop (delete for everyone)

## Status

code complete, verified static; branch feature/dm-delete-own-message-sync, not yet merged)


## IMPLEMENTED — result (2026-06-25)

Built on branch `feature/dm-delete-own-message-sync`. What shipped vs. the original plan below:

1. **Send** — `useDeleteDirectMessage.ts` now sends a `remove-message` control
   message after the optimistic local delete. **Deviation from the plan:** it
   does NOT use the reaction transport. The reaction transport only reaches ONE
   session/inbox; we route the delete through `sendEncryptedMessageToAllDevices`
   instead — the SAME all-devices fan-out a normal text message uses (recipient
   devices + own other devices, bootstrapping sessions as needed). Fix for
   "delete reaches fewer devices than a message." See memory
   `dm-control-msg-single-session-vs-alldevices-transport`.
2. **No isConnected gate** — the send deliberately does NOT bail on
   `!isConnected`; it enqueues so the WS client flushes on reconnect. Found via
   logging that a transient disconnect was silently dropping deletes. Real bug, fixed.
3. **Receive** — added `remove-message` branches to BOTH DM receive paths in
   `WebSocketContext.tsx` (batch `applyDMGroupResults` + JS fallback
   `handleIncomingMessage`). Folds the control message (no ghost post).
4. **Authorization (security)** — receive honors the delete only when the
   message author equals the **cryptographically-authenticated session sender**
   (pre-self-sync `senderAddress` / `authenticatedDmSender`), NOT the spoofable
   payload `content.senderId`. See master recap + memory
   `dm-control-msg-auth-session-sender-not-payload`. (The plan's `target.userId`
   wording was imprecise — the author field is `content.senderId`.)
5. Drive-by: fixed a pre-existing reaction-branch inbox-cleanup bug (wrong
   function + raw-byte keys → silently no-op'd; now `deleteConversationInboxMessages`
   with hex keys).

**Verification:** tsc + lint clean on changed files; reaction send unchanged
(code moved verbatim); normal receive unaffected (new branches gated on
`type==='remove-message'`); desktop honors a legit cross-account delete (traced).
Could NOT confirm live cross-device propagation — blocked by the pre-existing
desktop↔mobile delivery sync issue
(`.agents/issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md`),
which affects normal messages too. Self-sync to your own DESKTOP is a documented
desktop trade-off (updates on reload); mobile honors self-sync.

Full writeup: `.agents/docs/features/dm-delete-own-message.md`.
Security tracked from `quorum-desktop/.agents/tasks/2026-06-25-MASTER-RECAP-control-message-auth.md`.

---

## Original plan (below) — kept for reference

## Lead-dev decision (2026-06-24) — APPROVED

> "Delete own message — mobile should match desktop (propagate remove-message to
> counterparty). … Sync msg delete to your own devices: desktop already does this
> (your other devices are inboxes, so the delete fans out to them); **rows 1 and 4
> are really one fix.**"

So this task is **unblocked**: mobile DM own-message delete must send a
`remove-message` control message and handle it on receive, exactly like desktop.
Because every device in the conversation (counterparty AND your own other
devices) is an inbox, the single fan-out fixes both "delete reaches the other
person" and "delete reaches my other devices" at once — there is no separate
sync-to-self code to write.

Row 3 (delete what the OTHER person wrote) stays **as-is** — neither platform
allows it. No work. The send is gated to own messages
(`message.userId === user.address`) and the receive handler additionally checks
`senderId === target.userId` (see below).

## Current state (verified against code, 2026-06-24)

- **UI is wired.** `DMChatArea.tsx:482-483` passes `onDelete={handleDeleteMessage}`
  + `canDeleteMessage={checkCanDeleteMessage}` (own-only). `handleDeleteMessage`
  (`DMChatArea.tsx:360`) calls `deleteDirectMessageMutation.mutate(...)`.
- **Send is local-only.** `hooks/chat/useDeleteDirectMessage.ts` does only
  `storage.deleteMessage(messageId)` + cache update. No wire send.
- **No DM receive handler.** The two `remove-message` handlers in
  `context/WebSocketContext.tsx` (~1932 live, ~3340 batch) are **space-only**
  (they use `space?.groups` / `createChannelPermissionChecker`). The DM apply
  path `applyDMGroupResults` (~3644) folds `reaction`/`remove-reaction` but has
  **no** `remove-message` branch, so a delete from a desktop peer is silently
  saved/ignored.
- **No shared work.** `RemoveMessage` (`{ senderId, type:'remove-message',
  removeMessageId }`) already exists in installed shared
  (`message.d.ts:34`). Nothing to publish.

## Implementation

### 1. Send — add a `remove-message` control send to the delete path

Mirror `hooks/chat/useSendDirectReaction.ts` (the `useRemoveDirectReaction`
half is the closest template: it builds a typed control `Message`, runs the
device-keys / session / recipientInfo checks, and calls `sendEncryptedReaction`
→ `enqueueOutbound`).

- In `useDeleteDirectMessage` (or a sibling hook, e.g. extend the mutation),
  after the optimistic local delete, build a control `Message` whose
  `content` is `{ type:'remove-message', senderId: user.address, removeMessageId:
  messageId }` and enqueue it through the same encrypt+seal+`enqueueOutbound`
  path the reaction hook uses. The hook will need `useAuth`, `useWebSocket`
  (`enqueueOutbound`, `isConnected`), the api client, and `recipientInfo` —
  `DMChatArea` already resolves `recipientInfo` for reactions, so pass it into
  `handleDeleteMessage` the same way `handleAddReaction` does.
- Keep the local delete optimistic (and the existing rollback on error). The
  wire send is best-effort like the reaction send.
- The control message is NOT persisted as a chat row (it's a control message);
  don't call `storage.saveMessage` for it.

### 2. Receive — add a DM `remove-message` branch

Add a branch in `applyDMGroupResults` (`WebSocketContext.tsx` ~3777, right where
`reaction`/`remove-reaction` are folded) for `dmContentType === 'remove-message'`:

- Read `removeMessageId` + `senderId` from `decryptedMessage.content`.
- **Authorization (own-message-only).** Look up the target message
  (`storage.getMessage({ spaceId: resolvedSenderAddress, channelId:
  resolvedSenderAddress, messageId: removeMessageId })`). Honor the delete only
  if `target.userId === senderId` (the sender is deleting THEIR OWN message).
  This is the DM analogue of the space handler's receive-side role check, and it
  enforces row 3: a peer can never delete a message you authored. If the target
  is missing, treat as a no-op (still clear the inbox entry).
- Remove from the React Query cache (`queryKeys.messages.infinite(
  resolvedSenderAddress, resolvedSenderAddress)`, filter out `removeMessageId`)
  **and** from storage (`storage.deleteMessage(removeMessageId)`), mirroring the
  space handler at ~1990-1998.
- Best-effort inbox cleanup: reuse the conversation-keypair-aware
  `deleteConversationInboxMessages` / device-keyset fallback block already used
  at the end of `applyDMGroupResults` (~3873) and in the reaction branch.
- `continue;` (don't fall through to `storage.saveMessage`, which would persist
  the control message as a ghost post).

### 3. Self-echo safety

Your own delete's `remove-message` will fan out to your OWN other devices (good
— that's row 4). But the SENDING device must not choke on its own echo:
- The sending device already removed the message locally and optimistically.
  When its own echo arrives, the target lookup returns nothing (already deleted)
  → the receive branch no-ops and clears the inbox entry. Safe.
- Confirm own-echoes aren't otherwise mishandled (the reaction branch relies on
  the same upstream self-sync handling at ~3716-3721; the remove branch sits
  after it, so `resolvedSenderAddress` is already normalized for self-sync).

### 4. JS fallback path note

The JS fallback DM path in `handleIncomingMessage` (~2654-2756) does NOT fold
control messages — it has no reaction branch either (reactions only fold in the
batch `applyDMGroupResults`). So in the rare fallback case a `remove-message`
would currently be saved as a ghost. Two options, decide while implementing:
- (a) Add the same `remove-message` branch to the JS path before `saveMessage`
  (~2708), OR
- (b) Confirm DM control messages always traverse the batch path in practice and
  document why the fallback can't carry one. Reactions already have this exact
  gap and ship fine, suggesting (b) holds — but verify before relying on it.

### 5. Verify cross-device (the whole point)

- Mobile A deletes own DM message → gone on counterparty B (mobile or desktop).
- Desktop deletes own DM message → gone on mobile (receive handler honors it).
- Mobile A deletes own DM message → gone on your own mobile A' (second device).
- Peer attempts to delete a message YOU authored → dropped (row 3 holds).
- Runtime-verify with two real devices; this is crypto-adjacent receive code.

## Notes

- No shared work (the `RemoveMessage` type already exists in installed shared).
- Pairs with #35 (DM conversation settings); ship independently.
- The conversation-delete encryption-reset signal + conversation-delete
  self-sync are tracked in #35 / the delete-semantics report — **separate** from
  this task.

## Source

`quorum-desktop/.agents/tasks/port-to-mobile/candidates.md` row 36.
Delete-semantics analysis: `.agents/reports/2026-06-21-dm-delete-semantics-desktop-vs-mobile.md`.

*Last updated: 2026-06-24*
