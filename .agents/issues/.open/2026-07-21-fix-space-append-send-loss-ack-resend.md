---
type: task
title: "Fix space mobile→desktop send loss: resend log-append on missing hub ack (H-B) — LAYER 2"
status: open
created: 2026-07-21
updated: 2026-08-16
severity: high
area: WebSocket transport / space hub-log send path (MOBILE-ONLY)
parent: "issues/.archived/2026-07-24-transport-reliability-START-HERE.md"
related:
  - ".agents/issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (H-B; Run 3 proved 4/5 in a release build; §1b interim conclusion)"
---

> **VERIFIED CORRECTION (2026-07-24).** Two claims in the original design below are wrong and are
> corrected here after checking BOTH repos:
> 1. **This is mobile-ONLY.** Desktop does not use a hub log — zero `log-append`/`log-append-ack`
>    in desktop `src`; desktop uses P2P mesh sync. So this whole bug and its fix are mobile-only.
> 2. **Do NOT "promote to shared so desktop benefits."** There is nothing on desktop to share it
>    with. The ledger lives in mobile (`WebSocketContext.tsx` + `spaceMessageService.ts`), full stop.
> Also: the hub sees only the **sealed** envelope + assigns a **`seq`** — it cannot read the
> messageId. Correlation is via `seq`/`request_id` (mobile does NOT set `request_id` today, and hub
> echo is UNVERIFIED), OR — preferred, dependency-free — watch for your own message to reappear in
> the decrypted `log-since-result` stream and resend if it doesn't. See START-HERE for the summary.

# Fix space send-side loss (H-B): resend `log-append` on missing ack

## Status

**2026-08-16 — newly unblocked, needs a re-check.** This was deliberately gated
on Layer 1, which shipped as PR #175. The 2026-07-27 recap flagged it as newly
unblocked pending a quick re-check of whether Layer 1 changed the shape of the
remaining work. That re-check has not happened.

_Carried over from `RECAP.md`'s 2026-07-27 audit, which flagged this file as
possibly stale. Recorded here so the caveat travels with the issue instead of
living only in a dashboard that has to be regenerated to be believed._


## Problem (proven, not hypothetical)

Space messages sent mobile→desktop are **permanently lost** at a low rate. Run 3 of the master
report: a PROD-PREVIEW (release) build sent 5 space messages, **4 landed, 1 lost** — so this is
a real shipped bug, not a dev artifact. DMs in the same session were 5/5 (Run 5).

**Why spaces lose but DMs don't** (the whole diagnosis in one line): space sends are
**fire-and-forget** — `enqueueOutbound` hands a `log-append` envelope to `ws.send`, the server
replies `log-append-ack`, and mobile's ack handler is an explicit **no-op**
([WebSocketContext.tsx:5544-5546](../../context/WebSocketContext.tsx#L5544-L5546):
"Our own write succeeded ... nothing to do here for now"). On a bad-socket moment the append
dies in the kernel buffer, the ack never comes, and **nothing resends**. DMs use durable inbox
delivery (retried until ack-by-delete) so they self-heal; the space append path has no such
retry. The fix = give the append path the resend the DM path already has.

## Design — sent-appends ledger + resend on missing ack

The protocol already supports correlation: the ack frame type declares an optional
`request_id` ([WebSocketContext.tsx:139](../../context/WebSocketContext.tsx#L139):
`{ type: 'log-append-ack'; hub_address; seq; ts; request_id? }`). Use it (or the message's own
`messageId`) to pair a sent append with its ack.

1. **Tag each append.** When building a `log-append` envelope for a real message send (the
   `enqueueOutbound` calls in `spaceMessageService.ts:302/494/646/1239` and the send wrapper in
   [WebSocketContext.tsx:5179-5201](../../context/WebSocketContext.tsx#L5179)), attach a stable
   `request_id` = the message's `messageId` (already computed via shared
   `buildMessageFingerprint`; receivers dedup on it, so a resend is idempotent). Do NOT tag
   control frames (`listen-hub`, `log-since`) — only real content appends.
2. **Ledger.** Keep `Map<request_id, { hub, envelope, firstSentAt, attempts }>` of appends sent
   but not yet acked. Add on send; remove on matching `log-append-ack` (extend the no-op
   handler at 5544 to `pendingAppends.delete(request_id)`). This is the production version of
   the temporary `pendingAppendsRef` WSTRACE meter already on `debug/transport-trace`.
3. **Resend.** A timer (e.g. every 3–5s) resends any ledger entry whose `firstSentAt`/last
   attempt is older than a timeout (e.g. 5s), with capped attempts (e.g. 4) and light backoff.
   Resend re-enqueues the SAME envelope via `enqueueOutbound` (which already buffers to
   `pendingEnvelopes` when the socket is non-OPEN, so resend + reconnect compose correctly).
4. **Give up loudly, not silently.** After max attempts with no ack, surface a send-failed
   state on the message (there is already `sendStatus`/`sendError` on the message object,
   stripped before sealing in `spaceMessageService.ts:275-276`) so the UI can show "failed —
   tap to retry" instead of a silent black hole. This is the anti-silent-failure requirement.

## Edge cases to verify before shipping
- **Receiver dedup is messageId-based** — confirm desktop + mobile both dedup an append that
  arrives twice (original slow + resend both land). If dedup is by messageId this is safe;
  verify in `ingestEntries` / the desktop equivalent.
- **Ack vs log-update ordering** — today the cursor advances via `log-update`, not the ack
  (5545). Ledger removal must key off the ACK (or a log-update that contains our messageId),
  not assume ordering.
- **Reconnect double-send** — after a reconnect the `log-since` catch-up may show our message
  landed; a resend already in flight is fine (dedup covers it) but avoid unbounded resend after
  the socket is confirmed healthy and the message is visible in `log-since-result`.
- **request_id echo** — confirm the SERVER actually echoes `request_id` on the ack. If it does
  NOT, fall back to correlating by `(hub, seq)` learned from the ack + a locally-remembered
  "next expected" — messier; the request_id path is strongly preferred, so verify server support
  first (ask lead / check server proto).

## Placement — MOBILE-ONLY (corrected 2026-07-24)
This lives in mobile only. The hub-log send path (`log-append` → `log-append-ack`) exists on
**mobile only**; desktop has no hub log (verified: zero `log-append` in desktop `src`, desktop
uses P2P mesh sync). Build the ledger+resend **mobile-side in `WebSocketContext.tsx`**
(extend the no-op ack handler at 5785) + tag appends in `spaceMessageService.ts`. Do NOT try to
promote this to quorum-shared "so desktop benefits" — there is no desktop hub-append path to share
it with. If desktop ever adopts hub-log, revisit then.

## Test plan
1. **Baseline the rate first** (do before coding): prod-preview build, send ~20 space messages
   mobile→desktop, count losses → a real loss rate to compare against.
2. **Dev instrumented check:** with `debug/transport-trace` WSTRACE, the `tx#`/`pending`/
   watchdog `tx-unacked` meters already show an append with no ack (pending stuck > 0). After
   the fix, a stuck pending should trigger a resend and clear.
3. **Post-fix prod-preview:** repeat the ~20-message send; expect ~0 permanent losses (delayed-
   then-delivered is acceptable, silent loss is not).
4. Confirm no duplicate messages on the receiver (dedup working) and that a forced offline
   window surfaces a visible send-failed state rather than a silent drop.

## Out of scope
- The desktop→mobile RECEIVE dev-deafness (separate task
  `2026-07-21-dev-env-receive-deaf-investigation.md`) — that was a dev/Metro artifact, not this.
- DM ratchet serialization (separate KeyedMutex thread).

---
*Created: 2026-07-21*
