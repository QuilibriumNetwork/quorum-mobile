---
type: bug
title: "DM sessions never confirm: confirm writes to a state row the send path never reads, send path clobbers it back — full X3DH ×6 devices on every send"
status: done
created: 2026-07-24
updated: 2026-08-16
severity: high (sole remaining cause of DM send latency ~2-3s after the cache fixes; also generates 6 init envelopes per send = inbox spam / envelope hoard fuel)
area: DM Double-Ratchet session lifecycle / encryption-state row schema
related:
  - "issues/.open/2026-07-24-dm-send-latency-10s-production.md (parent: the latency investigation that exposed this)"
  - "issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (§5 'state rows with tag ≠ inboxId' contamination — explained here; §0.4 ghost devices — amplifier)"
---

# DM sessions never confirm — the permanent re-init loop

## Status

**2026-08-16 — closed on a "likely fixed" judgement, not a confirmed one.** The
2026-07-27 recap marked this as likely fixed by PR #177, and noted it was misfiled
as open at the time. It is now `status: done` in `.done/`. The load-bearing word
was "likely": nothing records that anyone confirmed X3DH stopped repeating on
every send. Worth one deliberate check, because the symptom is expensive and
silent.

_Carried over from `RECAP.md`'s 2026-07-27 audit, which flagged this file as
possibly stale. Recorded here so the caveat travels with the issue instead of
living only in a dashboard that has to be regenerated to be believed._


## Measured symptom
Every DM send on the test pairing logs `session split: newSession=0 existingSession=6` and all
6 devices take the `unconfirmed-session re-init` branch → full X3DH + init envelope × 6, ~1.3-3.1s
per send, forever. `[session-confirm]` fires on replies, yet sessions stay unconfirmed.

## Mechanism (verified in code 2026-07-24)

Three cooperating defects in `hooks/chat/useSendDirectMessage.ts`
(`sendEncryptedMessageToAllDevices`) + `services/crypto/encryption-service.ts`
(`confirmSenderSession`, called from WebSocketContext ~2881):

1. **Send path and confirm path use different row keys.**
   - Send finds sessions by `state.tag === device.inboxAddress` (per-device rows created by the
     first-ever send, each keyed `conversationId:<per-device conv inbox>`).
   - Confirm looks up `getEncryptionState(conversationId, receivedOnInboxAddress)` — keyed by
     the inbox the reply ARRIVED on.
2. **The re-init branch funnels all 6 devices into ONE shared row.** It reuses the single
   per-conversation inbox keypair (`getConversationInboxKeypair(conversationId)`) as
   `senderDeviceInboxAddress`, so all 6 saves write the SAME key
   `conversationId:<shared conv inbox>` — last-writer-wins, `sentAccept:false`, `tag` = whichever
   device was processed last. **This is the "tag ≠ inboxId row contamination" flagged in the
   master report §5.**
3. **Confirm hits only the shared row, then gets clobbered.** The init envelope tells the peer to
   reply to the shared conv inbox; the reply confirms the shared row and overwrites its `tag`
   with the PEER's tag (`unsealed.tag`), so it can never match a device inbox again. The next
   send still finds the 6 unconfirmed per-device tag-rows → re-inits → overwrites the shared row
   back to `sentAccept:false`. Loop is self-sustaining.

Additionally: sessions to devices that never reply (own other devices, ghost devices) can never
confirm under the reply-confirms model at all — with `deviceCount` inflated by ghosts (master
item 0.4), most of the 6 rows are unconfirmable by construction.

## Desktop-parity answers (read from quorum-desktop MessageService.ts, 2026-07-24)

Desktop's model (send path ~L3069-3186, confirm ~L3584-3639) is fully consistent:

1. **One session row per target device**, keyed `inboxId = session.receiving_inbox.inbox_address`
   (that session's OWN per-device return inbox), with `tag = target device inbox` stored inside
   the state JSON. Send selects by tag; confirm selects by arrival inbox = that same
   `receiving_inbox`. **Both paths land on the SAME row.** The loop closes.
2. **Unconfirmed re-send uses `DoubleRatchetInboxEncryptForceSenderInit` on the EXISTING set** —
   it re-init-wraps but keeps the session (same receiving_inbox, same tag, advancing ratchet),
   and the save goes back into the same row. No fresh X3DH per send, no row collision.
3. **Confirm saves `tag: result.tag`** (the session's own tag, preserved by the SDK) — NOT the
   peer's tag. Mobile's confirm writes `tag: unsealed.tag` (the peer's), which un-links the row
   from its device.
4. **Desktop prunes sessions whose tag is no longer in the current device-registration list** on
   every send (ghost-session cleanup, L3081-3085). Mobile never prunes.

Mobile's equivalent of ForceSenderInit ALREADY EXISTS in the single-device legacy path
(`sendEncryptedMessage` in useSendDirectMessage.ts: encrypt with existing session via
`encryptWithExistingSession`, rewrap in an init envelope reusing the stored X3DH ephemeral). The
multi-device path (`sendEncryptedMessageToAllDevices`) simply doesn't use it — it calls
`encryptMessageForNewDevice` (fresh X3DH) instead, with a comment asserting the receiver can't
decrypt advanced states; the receiver's ephemeral-key cache (and desktop's working model) prove
that assertion wrong.

**Additional defect found:** mobile stores only ONE conversation-inbox keypair per conversation
(`CONVERSATION_INBOX_KEY + conversationId`, last-writer-wins), so of the per-device return
inboxes created in `newSessionPrepData`, only the last device's private key survives locally.
(Replies still decrypt only because the init envelope embeds return_inbox_private_key and the
peer echoes it back.) The fix should key stored conversation-inbox keypairs by inbox address.

## Mobile fix plan (desktop parity) — REVISED after deeper analysis

**Foundational insight:** on desktop, the arrival inbox IS the session identifier (each session
has its own receiving inbox, keypair persisted per session). Mobile CANNOT close the confirm
loop while the re-init envelope advertises the SHARED conversation inbox as return address —
confirm keys off the arrival inbox and will never find the per-device row. Per-inbox keypair
storage is therefore step 1, not a follow-up.

Two more defects found while planning:
- `encryptWithExistingSession`'s state save DROPS `x3dhEphemeralPublicKey/PrivateKey` (not in
  the saved object) — so even the single-device ForceSenderInit-style path loses its ephemeral
  after one send and regenerates (receiver cache miss). Preserve those fields.
- `saveConversationInboxKeypair` is single-slot per conversation (last-writer-wins), so most
  per-device return-inbox private keys are never retained locally.

**Implementation order:**
1. **Per-inbox keypair storage**: key `ConversationInboxKeypair` by inbox address (new storage
   key `conversationInboxByAddr:<inboxAddress>`), write both old + new locations for backward
   compat, read new-first. `getConversationInboxKeypairByAddress` reads the new key directly.
2. **Unconfirmed re-init branch** (`sendEncryptedMessageToAllDevices`): replace
   `encryptMessageForNewDevice` with the ForceSenderInit equivalent — DR-encrypt with the
   EXISTING state via `encryptWithExistingSession(state.inboxId)`, rewrap in init envelope
   reusing stored X3DH ephemeral, return inbox = the STATE's OWN inbox (keypair from step 1).
   If that keypair is unavailable (pre-fix rows), do a one-time full re-init with a FRESH
   per-device inbox (keypair saved under step-1 storage) and save the row under that new
   inboxId — after one send, every device row is confirmable.
3. **Save preserves row identity**: re-init save goes under the state's own `inboxId` with `tag`
   preserved; `encryptWithExistingSession` save preserves the ephemeral fields.
4. **Confirm fix**: `confirmSenderSession` preserves the row's existing `tag` (never
   `unsealed.tag`).
5. **Ghost-session prune on send** (desktop L3081 parity): delete rows whose tag isn't in the
   current device-inbox list.

Verification slice (behavioral): send DM #1 mobile→desktop, have desktop reply, send DM #2 —
logs must show the CONFIRMED branch (no init envelope) and sub-1s prep; receipts intact both
ways; repeat after app restart to prove persistence.

## SDK VERDICT (2026-07-24, read quilibrium-js-sdk-channels/src/channel/channel.ts) — supersedes the plans above

**The `tag` in an init envelope is the SENDER'S DEVICE INBOX ADDRESS** (`tag:
keyset.inbox_keyset.inbox_address` in NewDoubleRatchetSenderSession L509, ForceSenderInit L931,
InboxEncrypt L1032). It is the session's identity: the receiver stores the created recipient
session WITH that tag (`NewDoubleRatchetRecipientSession` returns `tag: initial_message.tag`,
desktop persists it), and BOTH platforms' send paths select sessions by `tag === target device
inbox`. **A recipient session is born send-ready** (the envelope carries the peer's full
return-inbox key set), so in the intended model, the session created by RECEIVING a peer's
message is the one you use to SEND back to that device — confirmed from birth. The
Confirm-sender-session dance is only for the initiator-before-any-reply case.

**Mobile's two SDK divergences (the actual bugs, both one-liners in spirit):**
1. **Receive: mobile DISCARDS the envelope tag.** `initializeRecipientSession` saves rows with
   NO `tag` ([encryption-service.ts:503](../../services/crypto/encryption-service.ts#L503) area),
   and the WebSocketContext receive-side saves never set it. So desktop-initiated, born-confirmed
   sessions are invisible to the send path's tag lookup → mobile spins up its own parallel sender
   sessions that (with defect #2) can never confirm.
2. **Send: mobile emits a NON-SDK tag.** Mobile sets `tag: conversationInboxAddress` (its return
   inbox) instead of its DEVICE inbox. Consequence on desktop: desktop stores mobile-initiated
   sessions tagged with an address that is NOT in any device-registration list → desktop's
   ghost-session prune (MessageService L3081) DELETES them on every send → desktop too keeps
   re-creating sessions toward mobile. The churn is mutual and this explains it.

**Fix plan v2 (small, mobile-architecture-preserving):**
1. Receive path: persist `tag: unsealed.tag` on recipient-session saves (initializeRecipientSession
   both save sites, ephemeral-cache path, WebSocketContext device-inbox init handler).
2. Send path: emit `tag: deviceKeyset.inboxAddress` in init envelopes (all builders in
   useSendDirectMessage + any other DM init-envelope builders: reactions/edits/deletes/profile).
3. Send split: when several rows share a tag, prefer a CONFIRMED row (inbox_public_key !== '');
   optionally delete redundant unconfirmed sender rows for a tag that has a confirmed row.
4. Keep from attempt 1: confirm preserves the row's own tag; per-address keypair storage
   (harmless, useful); ghost-prune stays but MUST come after (2) is deployed on both ends'
   traffic, else desktop prunes mobile sessions tagged with conversation inboxes. DROP the
   ForceSenderInit rewrite (advanced-state envelopes to device inboxes are undecryptable for
   receivers without live session tracking — that's why attempt 1 lost messages).

Convergence: one incoming desktop message per desktop device creates a send-ready tagged row →
mobile's sends to that device become cheap immediately. No migration needed; old junk rows fall
away via the prune once tags are SDK-correct.

## Impact when fixed
- Steady-state DM send drops from ~3s to well under 1s (confirmed sessions take the cheap
  `encryptWithExistingSession` branch, one DR encrypt per device, no X3DH, no init wrapping).
- Kills the 6-init-envelopes-per-send inbox spam (hoard/replay fuel on the receive side).

---
*Last updated: 2026-07-24*
