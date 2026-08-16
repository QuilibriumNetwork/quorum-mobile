---
type: bug
title: "DM send aborts with 'WebSocket not connected' (~5%) — message never sent, and the failed-state UX has no retry"
status: open
created: 2026-07-23
updated: 2026-08-16
severity: HIGH (correctness: ~10-15% of DM sends never arrive — user-observed rate revised UP from 5% on 2026-07-23; UX: sender has no clear recovery)
area: DM send path / WebSocket outbound / message send-status UI
related:
  - "issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (§0 item 1 = Tier-3 H-B space send loss — SAME cure: durable send + resend)"
  - "issues/.open/2026-07-21-fix-space-append-send-loss-ack-resend.md (the space-side durable-send design to mirror/share)"
  - "quorum-desktop/src/services/MessageService.ts:6103 (retryMessage — the retry pattern to port)"
---

# DM send aborts with "WebSocket not connected" + weak failed-state UX

## Status

**2026-08-16 — likely addressed; verify before starting.** The 2026-07-27 recap
judged this likely fixed by PR #175 but never confirmed it. Note the two halves
are separable: the abort itself may be fixed while the failed-state UX (no retry
affordance) is untouched. Check both before closing.

_Carried over from `RECAP.md`'s 2026-07-27 audit, which flagged this file as
possibly stale. Recorded here so the caveat travels with the issue instead of
living only in a dashboard that has to be regenerated to be believed._


> **Capturing a round for this bug?** The DM diagnostic rig lives on the local,
> never-pushed branch `diag/dm-frame-trace`; `master` carries none of it. Get onto
> it with **`git debug`** — it refuses to run on a dirty tree, rebases the rig onto
> master, re-applies the `node_modules` transport patch (wiped by every
> `yarn install`), and prints a BUILD CHECK proving which probes and shipped fixes
> are actually compiled in. **Never check out the rig by SHA** — `git debug`
> rebases, so SHAs written in docs go stale immediately, and a round captured from
> a stale head already faked 21 losses once. Full rig docs:
> [§D of the DM master report](2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md)
> and [scripts/README.md](../.done/2026-06-21-mute-and-block-overhaul/README.md).

## Symptom (user-reported 2026-07-23, screenshot)

**~10-15%** of DM sends (user-observed rate, revised up from an initial ~5% estimate on 2026-07-23)
show a red inline error **"WebSocket not connected. Please check your connection."**
below the message bubble. The message appears in the sender's stream looking roughly normal, but it
**never reaches the recipient** — it was never actually sent. There is no obvious way to retry; the
user has to retype and resend. Confusing because the bubble looks sent (sits in the stream next to
genuinely-sent messages that show ✓✓ receipts).

## Two distinct problems

### A. Correctness: the send is aborted pre-flight and never queued

Every DM send does a pre-flight connectivity check and THROWS if the client believes it is
disconnected — [useSendDirectMessage.ts:229-231](../../hooks/chat/useSendDirectMessage.ts#L229):

```
if (!isConnected) {
  throw new Error('WebSocket not connected. Please check your connection.');
}
```

The same guard exists in [useSendDirectEmbedMessage.ts:148](../../hooks/chat/useSendDirectEmbedMessage.ts#L148)
and [useSendDirectReaction.ts:112,283](../../hooks/chat/useSendDirectReaction.ts#L112). When it fires,
the message is **never encrypted, never queued, never sent** — it is dropped at the door and marked
failed. `isConnected` is a WebSocket-context state value.

**Why it fires ~10-15% (needs one diagnostic to confirm which):**
- (a) **Genuine transient disconnect** — the socket is briefly down / mid-reconnect (network blip,
  app resume, NAT idle). The transport master report already established mobile has NO heartbeat and
  the foreground handler only reconnects on `!isConnected`, so short disconnected windows are real.
- (b) **Stale `isConnected`** — the React state lags the real `ws.readyState`, so the guard
  false-negatives while the socket is actually usable.
- **Diagnostic:** at the throw, log real `wsClientRef.current?.isConnected` / `ws.readyState`
  alongside the state `isConnected`. Divergence ⇒ (b); agreement ⇒ (a).
- **A 10-15% rate is a strong signal on its own.** A genuinely-disconnected socket 1-in-7 sends
  would be a severe network story; more likely the socket spends a lot of time in a
  reconnecting/`CONNECTING` state (no heartbeat → churn) AND/OR the React `isConnected` prop lags
  reality (b). Either way the elevated rate makes the durable-send fix (don't hard-fail; queue +
  flush on reconnect) clearly worth it — at 10-15%, users lose messages constantly and blame
  themselves ("please check your connection" when their connection is fine).

**Relationship to the transport master report:** same FAMILY (send-side reliability), DISTINCT mode.
This is a *loud* pre-flight abort (message never sent, error shown). Tier-3 H-B (space send) is a
*silent* loss into a zombie OPEN socket (no error). **Both share one cure.**

### Why desktop does NOT have this bug (user-confirmed 2026-07-23) — the exact difference

Desktop's send is **durable-by-queue**: `enqueueOutbound(message)` unconditionally appends to
`outboundQueue` ([quorum-desktop WebsocketProvider.tsx:222](../../../quorum-desktop/src/components/context/WebsocketProvider.tsx#L222));
the drain `processOutbound` only sends when `readyState === OPEN` and otherwise **leaves messages in
the queue to flush on the next reconnect** ([:140-151](../../../quorum-desktop/src/components/context/WebsocketProvider.tsx#L140)).
There is **no pre-flight connectivity throw** — a send issued while disconnected simply waits and
delivers on reconnect. So desktop never shows "not connected" and never loses the message.

Mobile has the SAME durable machinery in its shared client (`rn-websocket.ts` `outboundQueue` +
`pendingEnvelopes`, which buffer while not OPEN and flush on OPEN) — **but the DM send hook
short-circuits with `if (!isConnected) throw` BEFORE it ever calls `enqueueOutbound`.** So mobile
throws away exactly the durability it already has.

> **CORRECTION (verified 2026-07-24):** an earlier version of this doc claimed the `!isConnected`
> throw is DM-specific and that "space sends route through `enqueueOutbound` durably, like desktop."
> **That is false.** Space send hooks ALSO pre-flight-throw on `!isConnected` — see
> `useSendSpaceMessage.ts:47-49` (`'Not connected to server. Please wait for connection.'`),
> `useSendEmbedMessage.ts:44-45`, `useEditSpaceMessage.ts:52-53`, `useSendStickerMessage.ts:28-29`,
> `useSpaceReactions.ts:58,170`. What is genuinely DM-specific is only the exact error *string*
> "WebSocket not connected" and the failed-state bubble UI. The space path additionally has the
> silent fire-and-forget H-B loss (socket reports OPEN but drops the frame), which DMs do not.
> **Implication for the fix:** the durable-send change must remove/bypass the `!isConnected` throw on
> BOTH the DM and space send paths, not the DM path alone.

**Consequence for the fix — low-risk, proven:** the correct behavior already runs in production on
desktop and in mobile's own transport layer. The DM send hook just needs to stop pre-flight-throwing
and let the encrypted envelope flow into the existing durable queue (mark UI `sending`/`queued`,
resolve on ack, `failed` only after a real timeout). This is mirroring shipped desktop behavior, not
inventing a mechanism.

**Mitigation — durable send instead of pre-flight throw:** encrypt + enqueue the outbound envelope
into the shared client's existing durable buffers ([quorum-shared rn-websocket.ts](../../../quorum-shared/src/transport/rn-websocket.ts): `pendingEnvelopes` + `outboundQueue` already flush on the
next `OPEN`) and mark the UI message `sending`/`queued`. Resolve to `sent` on ack; only mark `failed`
after a real send timeout (not merely because the socket blinked). A transient blip then becomes a
self-healing short delay instead of a hard, user-visible failure. This is the DM analogue of the
Tier-3 H-B fix — **consider building them together as one "durable send + resend" capability**
(possibly promoted to quorum-shared, since both platforms and both message families want it).

### B. UX: failed sends are under-surfaced and have no working retry on DMs

Current mobile state (already partly built):
- Send failure IS marked: `onError` sets `sendStatus: 'failed'` +
  `sendError` ([useSendDirectMessage.ts:423-456](../../hooks/chat/useSendDirectMessage.ts#L423)).
- A failed row IS rendered: red exclamation + `sendError` text
  ([MessagesList.tsx:1227-1245](../../components/Chat/MessagesList.tsx#L1227)).
- A **`RetryButton` component EXISTS** ([MessagesList.tsx:278-294](../../components/Chat/MessagesList.tsx#L278)),
  gated on an `onRetryMessage` prop.

**The gap:** `onRetryMessage` is **never wired into the DM chat path** (grep: the prop is declared and
consumed in MessagesList, but no parent passes `onRetryMessage=` for DMs). So the retry button never
renders — the user sees the error with no recovery affordance. Additionally, the failed bubble itself
is not visually de-emphasised (only a small red line below), so at a glance it reads as delivered.

**Desktop parity to mirror:** desktop has a full `retryMessage`
([quorum-desktop MessageService.ts:6103](../../../quorum-desktop/src/services/MessageService.ts#L6103))
plus `sendStatus`/`sendError` fields and `stripEphemeralFields` for clean re-encryption on retry.

## Recommended fixes (prioritised; NOT started — separate from the current branch)

1. **[correctness] Durable DM send — mirror desktop (proven, low-risk).** Remove the `!isConnected`
   pre-flight throw and let the encrypted envelope flow into the EXISTING durable outbound queue
   (`enqueueOutbound` → flush on next `OPEN`), exactly as desktop and mobile's own space sends already
   do. Mark UI `sending`/`queued`; surface `failed` only after a genuine send timeout. This fix works
   regardless of the a-vs-b diagnostic: if the flag was stale (b), removing the throw fixes it
   directly; if it was a real brief disconnect (a), the queue flushes on reconnect. (Apply to the DM
   embed + reaction send hooks too — same pre-flight throw.) Pairs naturally with Tier-3 H-B as a
   shared "durable send + resend" capability, but the DM half is a small, self-contained mirror.
2. **[UX] Wire `onRetryMessage` in the DM path** so the existing Retry button renders; implement the
   handler to re-send the failed optimistic message (mirror desktop's `retryMessage`: strip ephemeral
   fields, re-encrypt, re-queue).
3. **[UX polish] Make failed bubbles visually distinct** — dim/grey the bubble + a clear "Not
   delivered" label, so a non-technical sender immediately sees the message did not land.

## Notes / scope
- Out of scope for the branch active on 2026-07-23; this is a follow-up.
- Fix 1 is the real reliability win (fewer failures); Fix 2 is the safety net for the residual;
  Fix 3 is clarity. Fixes 2+3 are small and independent of Fix 1 — could ship first as a quick UX win.
- Verify the Fix-1 diagnostic (a vs b) before building: if it's mostly (b) stale-flag, the cheapest
  first step is to check `wsClientRef.current?.isConnected` (live) instead of the React state at the
  guard.

---
*Created: 2026-07-23*
