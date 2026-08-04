---
type: report
title: "DM delete semantics — desktop vs mobile (message-delete + conversation-delete)"
created: 2026-06-21
status: resolved — lead-dev decided 2026-06-24 (see "Lead-dev decisions" below)
related:
  - .agents/issues/.done/2026-06-17-dm-conversation-settings-parity.md
  - .agents/issues/.done/2026-06-17-delete-own-message-in-dm.md
---

# DM delete semantics: desktop vs mobile

## Lead-dev decisions (2026-06-24) — all open questions answered

| # | Question | Decision |
|---|---|---|
| 1 | Message-delete propagation | **Match desktop.** Send + receive `remove-message`. Tracked in `2026-06-17-delete-own-message-in-dm.md` (now approved/ready). |
| (row 4) | Sync msg-delete to own devices | **Same fix as #1** — the inbox fan-out reaches own devices too; no separate code. |
| 2 | Conversation-delete encryption-reset signal | **Align mobile to desktop.** Send `delete-conversation`, receive = reset encryption session only (don't delete). Tracked in settings-parity task "Delete conversation — approved scope" Part 1. |
| 3 | Conversation-delete sync to own devices | **Build it, but NOT today (gated follow-up).** Net-new on both platforms; needs a new `delete-conversation-self` wire type. Real shared-publish blocker → canonical order: quorum-shared → publish → desktop → mobile last. Part 2 of the settings-parity task. Open: confirm the exact shared type name/shape. |
| (repudiability) | Q4 below | Not addressed in this round — stays a separate settings-parity question. |

Row 3 of the TL;DR ("delete what the OTHER person wrote") confirmed **leave
as-is** — neither platform allows it. The #36 receive handler enforces this by
honoring a delete only when `senderId === target.userId`.

The "open questions" section below is kept for the reasoning trail; the answers
above supersede it.

---

Two distinct delete operations exist in DMs. They behave **differently** between
desktop and mobile. This doc traces both from the actual code (not comments) so
we can ask the lead dev a precise question.

## TL;DR

| Operation | Desktop | Mobile | Divergent? |
|---|---|---|---|
| **Delete own message** | Propagates to counterparty (sends `remove-message`) | Local-only (no wire send) | **YES** |
| **Delete conversation** | Local-only + pings counterparty to reset encryption session | Local-only, sends nothing | Partially |
| **Delete what the OTHER person wrote** | Not possible | Not possible | No (same) |
| **Sync delete to your OWN other devices** | Yes (own devices are inboxes → `remove-message` fans out to them) | No (sends nothing) | **YES** |

> **Rows 1 and 4 are the same fix.** Desktop sends `remove-message` to every
> inbox in the conversation's encryption states *except the sending device*
> (`MessageService.ts:760` and the same filter at lines 2435/2615/5441). Your
> own other devices ARE inboxes in the conversation, so the delete reaches both
> the counterparty AND your other devices through one fan-out — there is no
> separate "sync to self" code. Once mobile sends `remove-message` like desktop,
> it fixes both rows at once. (~85% confidence from code; not yet observed live
> across two devices.)

---

## 1. Delete own message

### Desktop
`src/hooks/business/messages/useMessageActions.ts` → `handleDelete` (line ~284).

For a DM, the online/default path calls:
```ts
onSubmitMessage({
  type: 'remove-message',
  removeMessageId: message.messageId,
});
```
This sends a `remove-message` control message **over the wire to the
counterparty**. The counterparty's device receives it and removes the message
from their view too. (There is also an offline action-queue path, `delete-dm`,
behind the `ENABLE_DM_ACTION_QUEUE` flag, used only when offline; the online
path is the legacy direct-submit above.)

**Effect: deleting your own DM message removes it for the other person too.**

### Mobile
`hooks/chat/useDeleteDirectMessage.ts` — the mutation does only:
```ts
await storage.deleteMessage(params.messageId); // local MMKV only
```
No `remove-message` is sent. The DM receive path in
`context/WebSocketContext.tsx` has **no** `remove-message` handler for DMs (the
two `remove-message` handlers at lines ~1926 and ~3257 are **space-only** —
they use `space?.groups`, `createChannelPermissionChecker`, channel lookups).

**Effect: deleting your own DM message removes it only on your device. The
other person still sees it. A delete coming FROM a desktop peer is also ignored
by mobile (no receive handler).**

### Consequence
This is a real, silent behavioral divergence. The mobile delete **button**
works (task #36's UI wiring is present via `DMChatArea`), but the semantics do
not match desktop. "#36 is done" is only true for the local-UI sense, not for
parity.

---

## 2. Delete conversation

### Desktop
`src/services/MessageService.ts` → `deleteConversation` (line ~5558).

Before local deletion, for a direct conversation it sends ONE control message
to the **counterparty** (addressed to `spaceId`, which for a DM is the
counterparty's address):
```ts
submitMessage(spaceId, { type: 'delete-conversation' }, self, counterparty, ...)
```
Receiver side (`MessageService.ts` ~2775): the counterparty does **NOT** delete
their conversation or messages. It only:
```ts
await this.deleteEncryptionStates({ conversationId });
await this.deleteInboxMessages(...);
```
i.e. it **resets the encryption session**. Next message re-handshakes.

Everything after the send (lines ~5620+) is purely local IndexedDB cleanup on
the deleting device. **Nothing is sent to your own other devices.**

**Effect: conversation-delete removes it from your side only; the counterparty
keeps everything but has their crypto session reset; your other devices are
untouched.**

### Mobile
`app/(tabs)/messages/dm/[id].tsx` → `handleDeleteConversation`:
```ts
await storage.deleteConversation(conversationId); // local only
queryClient.invalidateQueries(...); router.back();
```
No control message sent. Pure local delete.

**Effect: same visible result on your own device, but no encryption-session
reset signal to the counterparty.**

### "Sync conversation-delete to my own other devices" — NET-NEW on both platforms

This is a desired behavior (delete a conversation → it disappears on all my
devices once they sync) that **neither platform implements today**. It must not
be confused with the message-delete fan-out (row 1/4 of the TL;DR):

- **Message-delete** already reaches your own other devices on desktop because
  it names a `messageId` and rides the existing inbox fan-out
  (`remove-message` → all inboxes incl. your other devices).
- **Conversation-delete** does NOT. Desktop's `delete-conversation` is addressed
  to the counterparty only (`MessageService.ts:5606-5616`, targets `spaceId` /
  `counterparty.data`); there is no fan-out to your own inboxes, and on receive
  it only resets the encryption session — it deliberately does NOT delete the
  conversation. So it can't be reused as-is to sync a delete to yourself.

Building this would require **new** work on both platforms:
- a new self-targeted control message (e.g. `delete-conversation-self`) sent to
  your OWN inboxes, and
- a receive handler on each device that deletes the whole conversation locally.

→ Tracked as open question #4 below.

---

## What the user's mental model was (confirmed correct)

- "When you delete a conversation you delete only from your side; you cannot
  delete what the other user sees." → **Correct** for both platforms.
- "If you delete your own messages, those will also be gone from the other
  user." → **Correct on desktop. NOT true on mobile** (this is the divergence).

---

## Open questions for the lead dev — ANSWERED 2026-06-24 (see decisions table at top)

> Q1 → match desktop. Q2 → align mobile to desktop (session-reset signal). Q3 →
> build the net-new self-sync (new wire type, platform TBD). Q4 (repudiability) →
> still open, lives in the settings-parity task. Reasoning retained below.

1. **Message-delete propagation.** Desktop propagates own-message deletes to the
   counterparty (`remove-message`); mobile is local-only. Was mobile
   intentionally left local-only (e.g. crypto path not ready, a deliberate
   privacy/scope choice), or is this just unfinished? Do we want mobile to match
   desktop (send + receive `remove-message` for DMs)?

2. **Conversation-delete encryption-reset signal.** Desktop sends
   `delete-conversation` to reset the counterparty's session. Mobile sends
   nothing. Do we want mobile to send it (and to handle it on receive)? This
   touches the DM encryption/receive pipeline.

3. **Conversation-delete sync to your OWN other devices — NET-NEW on both
   platforms.** Desired: delete a conversation → it disappears on all my devices
   on sync. Neither desktop nor mobile does this today (desktop's
   `delete-conversation` goes to the counterparty only and just resets their
   session; it is NOT a fan-out to your own inboxes and does NOT delete on
   receive). Building it needs a new self-targeted control message
   (e.g. `delete-conversation-self`) + a per-device receive handler that deletes
   the whole conversation locally. Do we want to build this, and on which
   platform first? (Distinct from #1: message-delete already reaches your own
   devices via inbox fan-out; conversation-delete does not.)

4. **Repudiability default — separate but related (see settings-parity task).**
   Desktop's conversation toggle is "Always sign messages" (`nonRepudiable`,
   opt-IN to signing → non-repudiable). Mobile labels it "Repudiable Messages"
   and defaults `isRepudiable ?? false`. The space service also defaults
   `isRepudiable ?? false` (`services/space/spaceService.ts:159`). Which opt-in
   direction is canonical? (Possibly the lead dev set mobile to opt-IN to
   repudiability deliberately.)

## Complexity / risk notes (for deciding whether to ask before building)

- **Message-delete parity**: send side is moderate (mobile already sends typed
  DM control messages like `reaction` through the encrypt+enqueue path; adding
  `remove-message` is similar plumbing). Receive side is **net-new** DM code and
  touches the decrypt/apply pipeline. Both ends touch crypto-adjacent paths →
  not zero-risk → worth confirming intent first.
- **Conversation-delete signal**: similar — send is plumbing, receive (tear down
  encryption states) is net-new and crypto-adjacent.

Recommendation: do **not** build speculatively. Get the lead dev's intent on
(1) and (2) first, since mobile's local-only design may be deliberate.

> **Update 2026-06-24:** intent confirmed (see decisions table at top). #1 + #2
> use already-published shared types and are ready to build; #3 is gated on a new
> `delete-conversation-self` shared type + platform choice.

*Last updated: 2026-06-24*
