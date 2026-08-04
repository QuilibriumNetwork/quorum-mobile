---
type: doc
title: "Inbox envelope lifecycle, the undecryptable-envelope hoard, and the bounded-retry poison guard"
status: current (as-built)
created: 2026-07-23
area: WebSocket receive path / message queue drain / native batch
related:
  - "issues/.done/2026-07-23-bounded-retry-inbox-poison-skiplist.md (the implementation spec + verification)"
  - "issues/.done/2026-07-21-dev-env-receive-deaf-investigation.md (how the freeze was diagnosed on-device)"
  - "issues/.done/2026-07-21-investigate-receive-cursor-wedge-bug-or-intentional.md (the sibling cursor-wedge fix, 1ce7bb1)"
---

# Inbox envelope lifecycle & the poison guard

How incoming messages flow from the server inbox through the receive drain, why a
class of *undecryptable* envelopes used to pile up and freeze the whole receive
pipeline, and how the **bounded-retry poison guard** fixes that without losing
real messages. Read this before touching `deleteInboxMessages`, the message-queue
drain in `processMessageQueue`, or the new `inboxAttemptTracker`.

---

## 1. What an "inbox" is, and what `deleteInboxMessages` actually deletes

Each device has server-side **inbox mailboxes**. When someone sends you a message,
the node drops an encrypted **envelope** into one of your inboxes. The receive
pipeline fetches envelopes, decrypts them, persists the decrypted message to the
**local message DB**, and then tells the server "got it — drop your copy" via
`deleteInboxMessages`. It is POP3-style: download, process, delete-from-server.

**Crucial distinction:** `deleteInboxMessages` deletes the *undecrypted envelope
from the server mailbox only*. It never touches the decrypted message in your
local DB, and it only affects **your own** device's mailbox — not the sender's
copy and not any other recipient. So "deleting an envelope" can never destroy
readable content or reach into another user's data; the most it can cost is your
own device's future chance at re-processing that one envelope.

Three inbox flavors, three signing keys, three delete helpers (all in
[context/WebSocketContext.tsx](../../context/WebSocketContext.tsx)):
- **device inbox** → `deleteInboxMessages` (Ed448 device inbox key). Carries DMs.
- **space inbox** → `deleteSpaceInboxMessages` (space inbox key). Legacy `'group'`
  fan-out copy of channel messages.
- **conversation inbox** → `deleteConversationInboxMessages` (conversation key).

## 2. Two delivery paths for channel messages — why channels can't hoard

Channel/space messages arrive by **two** mechanisms (dual-write, deduped
downstream):
1. **Hub-log via `log-since` cursor** — the primary path. A per-hub cursor
   ([services/space/hubLogCursor.ts](../../services/space/hubLogCursor.ts)) tracks
   the highest sequence ingested; reconnect catch-up refetches from it. After each
   drained batch, [WebSocketContext.tsx ~5030](../../context/WebSocketContext.tsx)
   advances the cursor along a **contiguous run** of `__logSeq` values found in the
   batch — *regardless of whether each entry decrypted*. So a channel message that
   fails to decrypt still lets the cursor move past it → `log-since` never refetches
   it → **it cannot replay forever**. Channels are structurally hoard-proof.
2. **Space inbox (legacy `'group'` fan-out)** — deleted on successful processing
   (20+ `deleteSpaceInboxMessages` call sites, all on success paths), so ordinary
   channel traffic self-cleans.

## 3. The bug: DMs hoard, then a poison envelope freezes everything

DMs are different. They live in the **device inbox** and are deleted only on
**successful** decrypt. The decrypt-failure paths (e.g.
[WebSocketContext.tsx:2937](../../context/WebSocketContext.tsx#L2937) —
empty/"Decryption failed"; and the "No encryption state" skip at
[2926](../../context/WebSocketContext.tsx#L2926)) `return` **without** deleting.
So a DM envelope that fails to decrypt stays in the inbox and **replays on every
connect, forever** — a monotonically growing **hoard**.

This is normally just wasted bandwidth. It became acute because of the native
batch: `processMessageQueue` drains the queue in slices of `MAX_BATCH_DRAIN_SIZE`
(250) and decrypts each slice in one bridge crossing via
`cryptoProvider.batchProcessMessages`. When the hoard contained large
`init:true` session-init envelopes, that **native call hung forever** — freezing
the entire receive drain (spaces AND DMs) until app restart. Diagnosed on-device
2026-07-21 (stage stuck at `native-batch(sp=0,dm=1)`, ~240 all-`init` envelopes
~2 months old on a test account).

A 30s **watchdog** ([ed1aeaa]) already caps any single hung batch: on timeout it
throws to the individual-processing fallback and disables DM native-batching for
the session. That un-freezes receive, but the hoard still re-arrives and re-stalls
on every connect. The watchdog is the safety net; it is not the cure.

## 4. Why not just delete on failure (what desktop does)?

quorum-desktop deletes the envelope **even when decryption fails**
([quorum-desktop MessageService.ts:3519](../../../quorum-desktop/src/services/MessageService.ts#L3519)),
so it never hoards. But that is a deliberate **"black-hole" tradeoff**: a message
that failed *transiently* (e.g. a key not loaded yet, a race) is thrown away before
any retry could succeed. Mobile's no-delete is the opposite extreme — more
conservative (never loses a transient) but it hoards.

Neither extreme is right:
| Client | Policy | Transient-safe? | Bounds the hoard/freeze? |
|---|---|---|---|
| Mobile (old) | retry forever (never delete on failure) | yes | **no** — hoards → freezes |
| Desktop | delete on first failure | **no** — black-hole | yes |
| **Mobile (now)** | **bounded retry, then skip** | **yes** | **yes** |

## 5. The fix: bounded-retry poison guard (as built, 2026-07-23)

Middle ground: give a failing DM envelope several chances across reconnects
(transient failures recover), then stop feeding it to the decryptor once it's
provably dead (hoard/freeze bounded). **Skip-only: no envelope is deleted from the
server** — the fix is non-destructive and fully reversible.

**Tracker** — [services/space/inboxAttemptTracker.ts](../../services/space/inboxAttemptTracker.ts)
(MMKV, mirrors `hubLogCursor.ts`). Per-envelope key `${inboxAddress}/${timestamp}`,
value = attempt count. Policy consts: `MAX_DECRYPT_ATTEMPTS = 5`,
`MAX_ENVELOPE_AGE_MS = 7 days`.

```
isInboxEnvelopePoisoned(inbox, ts) =
     attempts >= MAX_DECRYPT_ATTEMPTS
  || (attempts >= 1 && (now - ts) > MAX_ENVELOPE_AGE_MS)
```

**SAFETY RULE (the important one):** a **never-attempted** envelope is *never*
poison, regardless of age. It always gets its first try. This protects a legit DM
that arrives old because the recipient was offline for a while — it is tried,
decrypts, and is delivered. The age cap only bites *after* at least one recorded
failure.

**Gate** — in `processMessageQueue`, right after the queue splice: filter the batch,
dropping poisoned envelopes so they never reach the native call (this is what
prevents the freeze). **Channel (`__logSeq`) entries are exempt** — skipping one
would remove its seq from the contiguous cursor-advance scan and re-open the
cursor-wedge the sibling fix closed. Because only the DM-batch paths ever call
`recordInboxAttempt`, only DM envelopes can ever become poisoned; space-inbox and
control messages read `attempts === 0` and always pass.

**Counting** (driven by authoritative native results, not inference):
- On the **timeout/throw** path: `recordInboxAttempt` for every DM in the hung
  batch (the freeze signal).
- After `applyDMGroupResults`: `clearInboxAttempt` on `decrypted`/`init_decrypted`
  (a recovered transient resets to zero); `recordInboxAttempt` on `decrypt_failed`/
  `no_state`. **`unseal_failed` is deliberately NOT counted** — those route to the
  JS init-envelope fallback and usually succeed there, so counting them would
  penalise legitimate DMs.

**Convergence:** each connect tags one batch (≤250) of the hoard; it converges over
as many connects as the hoard spans batches, then stops stalling. Cost is one ~30s
watchdog stall per still-untagged batch, once.

## 6. Scope, and what was deliberately left out
- **DM / device-inbox only.** Channels are exempt (cursor coupling) and can't hoard
  anyway (§2). Space-inbox-on-failure hoarding, if it exists, is a separate future
  analysis of the `deleteSpaceInboxMessages` failure path — not bundled here.
- **No server deletion.** Skip-only ships. Server-side deletion of provably-dead
  envelopes (desktop parity) is parked behind an off-by-default flag — the only
  lead-sensitive behavior, isolated from the safe fix.
- **Desktop unchanged.** Bounded-retry is the right policy for both clients, so
  converging desktop off its delete-on-failure tradeoff is a **follow-up to raise
  with the lead**, not a silent divergence.

## 7. Tuning / gotchas for the next person
- Thresholds (5 attempts / 7 days) are module consts in the tracker; conservative-
  generous on purpose. Retune only with on-device evidence.
- Age uses the **envelope's own `timestamp`** (send time, ms epoch), i.e. message
  age — not tracking age.
- `clearInboxAttempt` on success is what keeps the tracker itself from becoming a
  second hoard: only currently-failing envelopes ever hold a key.
- The tracker is DM-scoped *by construction* (only DM paths count), not by an
  explicit type check in the gate — keep counting confined to the DM batch paths if
  you extend it.

---
*Last updated: 2026-07-23*
