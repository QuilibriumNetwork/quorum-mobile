---
type: bug
title: "Messages queued while offline are silently lost if the app process dies"
status: open
priority: medium
ai_generated: true
created: 2026-08-01
updated: 2026-08-01
area: send path / WebSocket outbound queue / send-status UI
related:
  - "issues/.done/2026-07-24-layer1-durable-send-remove-preflight-throw.md (Layer 1 — established the durable queue this exposes the limit of)"
  - "issues/.open/2026-07-21-fix-space-append-send-loss-ack-resend.md (Layer 2 — owns delivery confirmation, needed for a real failed state)"
  - "issues/.done/2026-08-01-offline-composer-queues-only-one-message.md (found while discussing that fix)"
---

# Messages queued while offline are silently lost if the app process dies

> **⚠️ AI-Generated**: May contain errors. Verify before use.

## Symptoms

A message sent while offline queues normally and shows its `sending` spinner. If
the app process is then destroyed before the connection returns, the message is
never sent and never will be. Coming back online does not recover it. The bubble
keeps spinning indefinitely: no error, no failed state, no retry.

Confirmed on device by LaMat 2026-08-01.

## Reproduction

1. Airplane mode ON
2. Send a message — bubble shows `sending`, envelope queues
3. Reload the app
4. Airplane mode OFF

Message never delivers; bubble spins forever.

**The manual reload is only for determinism.** Android reclaims backgrounded
apps on its own, so the same loss happens with no user action: send while
offline, background the app, get killed, message silently gone.

## Not to be confused with the working case

With the app **alive**, a disconnect/reconnect delivers correctly — verified on
device the same day, 3 DM + 3 space messages queued in airplane mode, all
delivered in order on reconnect. Layer 1 works. The queue survives a
*disconnect*; it does not survive a *process restart*. Only the second case is
this bug.

## Root cause

`outboundQueue` and `pendingEnvelopes` are plain in-memory instance fields on the
WS client (`quorum-shared/src/transport/rn-websocket.ts:45,52`) with no
persistence. They are part of the JS context, so destroying the context destroys
them.

## Why the bubble never resolves

Three separate reasons, each deliberate on its own:

- `onFlushed` fires from inside the outbound-queue drain
  (`useSendDirectMessage.ts:1404`). No queue, no callback, so the bubble never
  leaves `sending`.
- No delivery timeout flips it to `failed` — deliberately. See the FINDING note
  in the Layer 1 task: a naive timer marks genuinely delivered messages as
  failed, so a real failed state needs Layer 2's delivery confirmation.
- The Retry button (`MessagesList.tsx`, `onRetryMessage`) is §3 of Layer 1,
  deferred to Layer 2 and still unwired — no parent passes `onRetryMessage`.

Result: a permanent spinner with no signal and no recourse.

## Open questions (decide before implementing)

1. **Persist the queue, or detect and fail on restart?** Persisting means
   writing sealed ciphertext to storage and replaying on boot, which raises
   ratchet-staleness questions: a DM envelope sealed before the restart may be
   stale when it replays. Detecting orphans on boot and marking them `failed` +
   retryable is far simpler and may be sufficient.
2. **If detecting: what marks an orphan?** A persisted message whose
   `sendStatus` was `sending` at write time would do it, but `sendStatus` is
   currently stripped before persisting (`useSendDirectMessage.ts:615-624`)
   precisely so a reload does not restore a stale spinner. That decision hides
   this failure rather than surfacing it, and would need revisiting.
3. **Does this belong to Layer 2?** Both candidate fixes end at "honest failed
   state with a working Retry", which is Layer 2's territory. This may be a
   Layer 2 sub-task rather than independent work.

## Priority note

Filed medium rather than high: the impact is silent message loss, which is
severe, but it requires sending while offline in the first place. Raise it if
offline sending turns out to be common in practice.

## Acceptance

- A message queued offline and then lost to an app restart does **not** present
  as an indefinitely-sending bubble.
- The user gets either delivery (persisted + replayed) or an honest failed state
  with a working retry.
- No regression to the Layer 1 behaviour verified 2026-08-01: a plain
  disconnect/reconnect with the app alive still delivers, in order, no
  duplicates.

---
*Last updated: 2026-08-01*
