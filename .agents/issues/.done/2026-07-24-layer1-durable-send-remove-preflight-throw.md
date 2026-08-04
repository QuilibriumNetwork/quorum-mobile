---
type: task
title: "Layer 1 — durable send: remove the pre-flight `!isConnected` throw (DM + space)"
status: done
created: 2026-07-24
severity: high
area: send path (DM + space) / WebSocket outbound / send-status UI
parent: "issues/.archived/2026-07-24-transport-reliability-START-HERE.md"
related:
  - "issues/.open/2026-07-23-dm-send-websocket-not-connected-abort-and-failed-ux.md (the DM half — analyzed)"
  - "issues/.open/2026-07-21-fix-space-append-send-loss-ack-resend.md (Layer 2 — deferred; do NOT bundle)"
verified: "All file:line refs + the durable-queue behavior verified against code 2026-07-24."
---

# Layer 1 — durable send (remove the pre-flight throw)

## Status

PR #175 **MERGED** 2026-07-24 (branch fix/durable-send-remove-preflight-throw). Scope = throw-removal core only. Retry button (§3) + failed-timeout + failed-bubble polish (§4) MOVED to Layer 2 (needs delivery confirmation) and are deliberately NOT part of this task. Code verified 2026-07-28. **On-device airplane-mode verification passed 2026-08-01** — see "Verification result" below. *(Previously read "PR OPEN — #175"; it merged 2026-07-24.)*


## Problem

Every send hook does a pre-flight `if (!isConnected) throw` and abandons the message **before**
it is encrypted or queued — even though the shared RN WebSocket client already has a durable
outbound buffer that would deliver it on the next reconnect. Result: DM sends fail loudly
(~10-15%, red "WebSocket not connected") and space sends fail on any brief disconnect too.

## Why this is low-risk

The correct behavior already runs in production: **desktop has no pre-flight throw** —
`enqueueOutbound` unconditionally queues and `processOutbound` only sends when `readyState ===
OPEN`, leaving messages queued to flush on reconnect (quorum-desktop `WebsocketProvider.tsx:140-151,222`).
Mobile has the **same machinery** in `quorum-shared/src/transport/rn-websocket.ts`
(`outboundQueue` + `pendingEnvelopes` buffer while not OPEN and flush on OPEN) — the send hooks
just short-circuit before reaching it. This change makes mobile use the durability it already has.

## The fix

### 1. Remove the `!isConnected` pre-flight throw — BOTH families

DM hooks (exact string "WebSocket not connected"):

- `hooks/chat/useSendDirectMessage.ts:229-231`
- `hooks/chat/useSendDirectEmbedMessage.ts:147-149`
- `hooks/chat/useSendDirectReaction.ts:111-113` and `:282-284`

Space hooks (string "Not connected to server. Please wait for connection." — same bug, different text):

- `hooks/chat/useSendSpaceMessage.ts:47-49`
- `hooks/chat/useSendEmbedMessage.ts:44-45`
- `hooks/chat/useEditSpaceMessage.ts:52-53`
- `hooks/chat/useSendStickerMessage.ts:28-29`
- `hooks/chat/useSpaceReactions.ts:58` and `:170`

In each: delete the throw and let the flow proceed to `enqueueOutbound`. (Keep genuinely
different guards — e.g. `!hasDeviceKeys`, "no target devices" — those are real preconditions.)

### 2. Status handling (mirror desktop parity)

- On enqueue: the optimistic message is marked `sending` (onMutate), then `sent` once the
  mutation resolves (which, post core-fix, happens as soon as the envelope is queued).
- Desktop treats "queued, will flush" as `sent` — message waits, delivers on reconnect. The
  core commit matches that: a transient offline window is now a self-healing short delay.

> **FINDING (2026-07-24) — a real "failed after timeout" needs Layer 2, do NOT fake it.**
> We cannot reliably flip a queued-but-undelivered message to `failed` on a timer. After the
> core fix, an offline send is marked `sent` once queued; to know it _didn't_ actually arrive we
> need a delivery signal. `enqueueOutbound` only tells us "handed to the socket" — and the whole
> H-B premise is that handing to an OPEN socket can still silently fail. So a reliable failed-
> state requires the **append-ack / delivery confirmation that is Layer 2**. A naive timer would
> mark genuinely-delivered messages as failed. Conclusion: the delivery-timeout belongs to Layer
> 2, not here. `failed` here is only reached on genuine send errors (no device keys / no target
> devices / new-conversation registration fetch fails while offline).

### 3. Wire the existing retry button

`RetryButton` exists (`components/Chat/MessagesList.tsx:280-295`, rendered ~1320-1326 when
`onRetryMessage` is truthy) but **no parent ever passes `onRetryMessage`** — so it never renders.
Wire it for the DM (and space) chat paths; implement the handler to re-send the failed optimistic
message (strip ephemeral fields, re-encrypt, re-enqueue — mirror desktop `retryMessage`,
quorum-desktop `MessageService.ts:6103`). This is the safety net for the residual after (1).

### 4. (Optional polish) de-emphasise a truly-failed bubble

Dim/grey + a clear "Not delivered" label so a failed send doesn't read as delivered. Small,
independent; can be its own commit.

## Edge cases to verify

- **Offline → online flush order:** a message queued offline should flush in order on reconnect
  (rn-websocket already does this; confirm no re-encryption staleness for DMs whose session
  advanced meanwhile).
- **Don't mark `failed` on a normal reconnect** — the whole point; verify the timeout is real.
- **Space vs DM parity:** apply to all listed hooks; a half-fix (DM only) leaves space sends
  still aborting on a blip.

## Test plan (user-observable — this is how LaMat verifies)

1. **DM, airplane mode:** turn wifi off, send a DM → it shows `sending` (no red error); turn wifi
   back on → it delivers and shows `sent`. Recipient receives it.
2. **Space, airplane mode:** same with a channel message → `sending` → delivered on reconnect,
   no "Not connected to server" error.
3. **Forced hard failure:** stay offline past the timeout → the bubble shows a clear failed state
   with a working **Retry** button; tapping it re-sends successfully once back online.
4. **No duplicates** on reconnect flush.

## Verification result (2026-08-01)

LaMat on-device, airplane mode, DM and space: **PASS**. Messages compose and queue
while disconnected with no red error, and deliver on reconnect. Steps 1, 2 and 4
of the test plan above are satisfied.

Step 3 (forced hard failure → failed bubble + working Retry) was **not** run: it
requires the retry button of §3, which this task deliberately did not ship. It
belongs to Layer 2 along with the delivery-timeout that would produce a genuine
`failed` state in the first place.

> **Blocker found while verifying — fixed separately.** The offline test could
> not run as written at first: only ONE message could be queued per disconnect,
> because both composers gated sending on the send mutation's `isPending`, which
> the durable queue keeps true for the whole offline window. Two gates (the send
> button, and an early return at the top of each send handler). Fixed on branch
> `fix/offline-composer-allows-one-message-only`; written up in
> `issues/.done/2026-08-01-offline-composer-queues-only-one-message.md`. The PASS
> above was recorded with that fix applied.

## Out of scope (do NOT bundle)

- **Layer 2** (space append-ack ledger + resend for the silent-drop-on-healthy-socket case) —
  deferred, mobile-only, tracked separately in `2026-07-21-fix-space-append-send-loss-ack-resend.md`.
  Layer 1 will NOT fix the ~1/5 silent space loss; that's expected. Ship + measure Layer 1 first.

---

_Last updated: 2026-08-01_
