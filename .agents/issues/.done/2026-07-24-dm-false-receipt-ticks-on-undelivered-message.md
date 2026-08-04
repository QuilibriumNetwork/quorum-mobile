---
type: bug
title: "DM receipt ticks (delivered/read) appear on a message that never landed on the receiver"
status: done
created: 2026-07-24
severity: high (trust/correctness — the sender is actively told a message was delivered/read when it never arrived)
area: DM receipts (delivery + read) / receipt-tick display logic
repo: quorum-mobile (sender side, where the false tick shows) + quorum-desktop (receiver, which never got the message)
related:
  - "issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (transport master — this surfaced during send-side testing)"
  - "issues/.done/2026-07-19-dm-receipt-pipeline-and-global-toggles.md (mobile receipt pipeline)"
  - "issues/.done/2026-07-23-inline-dm-receipts-mobile.md (inline receipt UI)"
  - "issues/.archived/2026-07-24-transport-reliability-START-HERE.md (send-side work in flight when this was found)"
---

# DM receipt ticks show delivered/read for a message that never landed

## Status

root-caused 2026-07-26 (hypotheses 2 & 4 confirmed in code). Fix planned in issues/.done/2026-07-26-receipt-truthfulness-delivery-gated-reads.md


> **Capturing a round for this bug?** The DM diagnostic rig lives on the local,
> never-pushed branch `diag/dm-frame-trace`; `master` carries none of it. Get onto
> it with **`git debug`** — it refuses to run on a dirty tree, rebases the rig onto
> master, re-applies the `node_modules` transport patch (wiped by every
> `yarn install`), and prints a BUILD CHECK proving which probes and shipped fixes
> are actually compiled in. **Never check out the rig by SHA** — `git debug`
> rebases, so SHAs written in docs go stale immediately, and a round captured from
> a stale head already faked 21 losses once. Full rig docs:
> [§D of the DM master report](../.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md)
> and [scripts/README.md](2026-06-21-mute-and-block-overhaul/README.md).

## Symptom (observed 2026-07-24, live)
Sending a DM **mobile → desktop**: the message never landed on desktop (it did not appear
anywhere on the receiver, confirmed on the desktop side). Yet on the **mobile sender** the message
showed receipt ticks **as if the recipient had received AND read it**. So the sender's UI actively
reported delivered/read for a message that was never delivered.

This is worse than showing no tick: a missing tick is honest ("not confirmed"); a false read tick
is a lie the user will trust.

## What we know / context
- Same session, the underlying conversation had a **broken DM encryption session** — messages
  mobile→desktop were silently failing to land until the user **manually reset the encryption**
  (conversation settings), after which delivery worked normally. Desktop→mobile worked throughout.
- So at the time the false ticks appeared, the message was almost certainly **encrypted under a
  dead/forked ratchet** and dropped on the desktop side (never decrypted, never displayed).
- The false receipt is therefore **decoupled from real delivery** — the tick logic reported
  delivered/read even though no real message (and so no real receipt ack) could have round-tripped.

## Why this matters
Receipts are the ONLY reliable "did it land" signal a sender has (there is no other delivery
confirmation in the DM send UX). If ticks can show delivered/read without a real ack, that signal
is untrustworthy — it defeats the purpose of receipts and misleads users into thinking lost
messages arrived.

## ROOT CAUSE — confirmed 2026-07-26 (hypotheses 2 & 4)

Read acks use a **high-water mark** ("read up to timestamp Y"). The sender expands that
into "every own message with `createdDate <= Y` was read **and** delivered", stamping
`readAt` AND backfilling `deliveredAt`. A message that never landed sits in that range too,
so it gets ✓✓. The recipient can never contradict it — the false claim is manufactured
entirely on the **sender** side.

Four sites, identical logic duplicated per platform:
- mobile `context/WebSocketContext.tsx:5616` + `services/storage/messagesDb.ts:649-651`
- desktop `src/components/context/MessageDB.tsx:1173` + `src/db/messages.ts:499-504`

Shared's `ReceiptService` is not at fault (it only buffers the HWM and fires a callback).

**Why it bit mobile → desktop specifically:** per
`issues/.done/2026-07-24-mobile-dm-delivery-receipt-messageid-mismatch.md`, mobile mints the
outgoing `messageId` twice, so delivery acks never match and `deliveredAt` is never set
legitimately in that direction. The read-ack backfill was therefore the *only* thing
writing `deliveredAt` — which is exactly the fabrication path.

**Hypotheses 1 and 3 de-prioritised:** ticks are only written from an ack path, and mobile
already guards self-echoed acks (`raw.senderId !== self`, `WebSocketContext.tsx:581-598`).

**Still open — a possible second mechanism:** if the receiver *decrypted* the message (so
it genuinely sent a delivery ack) but dropped it before persist/display, the tick is honest
about decryption and wrong about arrival. The planned fix cannot cure that. If false ticks
survive the fix, that is evidence for this second mechanism, not a failed fix.

→ Fix design, cross-platform plan, and transport analysis:
`issues/.done/2026-07-26-receipt-truthfulness-delivery-gated-reads.md`

## Hypotheses to investigate (original triage — 2 & 4 now CONFIRMED above)
1. **Optimistic/local ticks:** mobile may be rendering delivered/read state locally without
   requiring a genuine receipt ack back from the recipient device.
2. **Stale receipt reuse:** a receipt from a *previous* message in the same conversation may be
   getting applied to the new (undelivered) message — e.g. keyed too coarsely (per-conversation
   "last read" watermark applied to any newer message rather than per-message acks).
3. **Self/multi-device confusion:** the tick may reflect the sender's own other-device state or a
   cached read-state rather than the actual recipient's ack.
4. **Read-watermark semantics:** if "read" is derived from a conversation-level read cursor/
   timestamp, an unrelated read event could mark an undelivered message as read.

## Where to look (starting points, not conclusions)
- Mobile receipt-tick rendering: `components/Chat/MessagesList.tsx` (the `renderReceipt` path).
- Receipt pipeline / how delivered/read state is derived and stored on mobile (see the .done
  receipt-pipeline + inline-receipts tasks above for the intended design).
- Confirm the invariant that SHOULD hold: a delivered/read tick must require a genuine receipt
  ack that could only exist if the recipient actually decrypted the message. Find where that
  invariant is (or isn't) enforced.

## Repro (best-effort — needs a clean reproduction)
1. Mobile sender ↔ desktop receiver, a DM conversation whose session is broken/forked (or force
   one). 2. Send mobile→desktop; confirm it never appears on desktop. 3. Observe the mobile
   sender showing delivered/read ticks anyway.
- NOTE: reproduction likely depends on the broken-session precondition; verify whether the false
  tick also happens on a HEALTHY session where a single message is merely lost in transport.

## Explicitly separate from (do not conflate)
- **Send-side reliability** (Layer 1/2, `2026-07-24-transport-reliability-START-HERE.md`) — why a
  message is lost. This bug is about the receipt LYING regardless of why it was lost.
- **DM session health / auto-heal** — why the session was broken and needed a manual reset. Also
  separate; that's the delivery failure, not the false tick.

---
*Last updated: 2026-07-26*
