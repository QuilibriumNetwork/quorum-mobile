---
type: task
title: "Port desktop's init-envelope staleness guard to mobile — fix the DM session forks that kill receipts"
status: done
created: 2026-07-23
severity: high (receipts dead partner→mobile; sessions silently re-fork on every connect)
area: DM receive path / Double Ratchet session install / init envelopes
related:
  - ".agents/issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (§7b — the [RECEIPT-DIAG] evidence chain)"
  - "quorum-desktop/.agents/bugs/.solved/2026-07-02-dm-message-delivery-unreliable-master.md (mechanism 3 = the SAME disease, fixed on desktop 2026-07-17)"
  - "quorum-desktop/src/utils/initEnvelopeGuard.ts (the implementation to port; used at MessageService.ts:3364)"
  - ".agents/issues/.done/2026-07-23-bounded-retry-inbox-poison-skiplist.md (the poison guard — sibling mitigation, interacts, see below)"
---

# Port the init-envelope staleness guard to mobile

## The proven failure (2026-07-23, [RECEIPT-DIAG] live capture)

Desktop (`QmYVto…`) read mobile's (`QmQuCG…`) messages and sent read-ack + delivery-ack
(`sent OK`, addressed correctly). Mobile received them seconds later as 4 envelopes (2 acks ×
2 session states, inboxes `QmQfaNuz3o` + `QmexLNDboF`) — **all failed DR decryption**
(`fresh DM decrypt EMPTY/FAILED`). Both of desktop's stored sessions toward mobile are
forked: desktop encrypts with ratchets mobile cannot advance. Receipts therefore never show;
every failed ack also joins the poison hoard. Normal messages still land only because the
normal send path fans out over the registration and can mint fresh init sessions, while acks
(`encryptAndSendDm`, desktop MessageService.ts:870-884) ride ONLY stored states — the forked
ones — with no fallback and no feedback.

## Root cause: mobile never got desktop's mechanism-3 fix

Desktop's solved DM master report identified **stale init-envelope redelivery** as its
dominant session killer: an init envelope **unconditionally replaces** the receiver's session
for its device tag; the server redelivers any envelope whose ack-by-delete failed; so every
reconnect replayed old envelopes that replaced the CURRENT healthy session with a months-old
zombie the sender no longer holds. Desktop fixed it 2026-07-17 with `isStaleInitEnvelope`
([quorum-desktop/src/utils/initEnvelopeGuard.ts:28](../../../quorum-desktop/src/utils/initEnvelopeGuard.ts#L28),
called at MessageService.ts:3364): refuse envelopes not strictly newer than the session rows
they'd replace, and server-delete refused ones (defuse the mine).

**Mobile parity audit (2026-07-23, grep-verified):**
| Desktop fix | Mobile status |
|---|---|
| 1. Don't destroy session on decrypt failure (PR #235) | ✅ OK — mobile's only `deleteEncryptionState` call is a space path |
| 2. Ratchet mutex (PR #236/#237) | ✅ OK — `ratchetMutex.runExclusive` since #165 (master report §8's "zero lock" note is OUTDATED) |
| 3. Stale init-envelope guard (PR #238-era) | ❌ **MISSING — no `isStaleInitEnvelope` anywhere in mobile or shared** |

And mobile is in the worst possible environment for mechanism 3: its device inbox held
~240 stale init envelopes (2026-06-25 → 07-17) replaying on EVERY connect. Each one that
processes successfully silently replaces mobile's current session with a zombie → desktop's
next ack fails → fork observed. This also explains why the forks keep coming back.

## Interaction with the poison guard (subtle, important)

The bounded-retry poison guard only bounds envelopes that FAIL: a stale init envelope that
*processes successfully* gets `clearInboxAttempt` → replays forever, re-forking the session
each connect, fully immune to the poison guard. The staleness guard is the complement: it
refuses exactly those "successful" zombies. Together: staleness guard kills session-replacing
mines; poison guard bounds undecryptable junk. Both are needed; neither replaces the other.

## The fix (mirror desktop, adapted to mobile's two receive paths)

1. **Port `isStaleInitEnvelope`** from desktop `src/utils/initEnvelopeGuard.ts` (pure logic —
   compare envelope timestamp against existing session rows for the same device tag; exact
   match = redelivery, older than newest row beyond 2-min skew = zombie). Port into mobile
   (`services/crypto/initEnvelopeGuard.ts`); consider promoting to quorum-shared later (both
   platforms would then share one guard — lead-gated, don't block on it).
2. **Gate the JS init path**: [WebSocketContext.tsx:2806-2839](../../context/WebSocketContext.tsx#L2806)
   (unsealed content is an InitializationEnvelope → session install). Refuse stale → skip
   install; delete the envelope server-side (desktop-parity mine defusal — desktop ships
   exactly this, so the behavior is already lead-blessed on desktop).
3. **Gate the native-batch init path**: the native side writes DR/init session states
   directly to MMKV (`applyDMGroupResults` comment), so staleness must be checked BEFORE
   batching: in `preclassifyAndGatherState` (or the drain-loop gate we already added), any
   `is_init_envelope` message whose envelope fails the staleness check is dropped from
   `batchInput` (and server-deleted per (2)). This prevents the native path from installing
   zombies the JS gate would have refused.
4. **Heal the two existing forked sessions**: once the guard prevents re-forking, the current
   bad states still need one manual reset (desktop has the Reset Session button; check what
   mobile offers — worst case, clear the conversation's encryption states on mobile so the
   next exchange re-inits). Verify receipts flow after reset.

## What NOT to do
- Do NOT build the full auto-heal ladder yet — desktop's own autoheal task was DOWNGRADED
  after the staleness guard shipped because the disease stopped. Mirror that sequencing:
  guard first, evaluate, heal only if forks still occur.
- Do NOT touch desktop's code — its guard is shipped and proven; mobile is the gap.

## Validation plan
1. Unit-test the ported guard with desktop's cases (redelivery exact-match; zombie older;
   legitimate newer envelope passes; 2-min skew tolerance).
2. Dev on-device: connect with the hoard present → `[STALE-INIT]` refusals logged, NO session
   replacement; then reset the forked conversation once; then desktop sends messages + acks →
   mobile: `fresh DM decrypted OK {type: read-ack}` and receipts VISIBLE on sent messages.
3. Reconnect several times → sessions survive (desktop's live-verification recipe).
4. Regression: brand-new DM conversation init still works (guard must not refuse genuinely
   new sessions).

---
*Created: 2026-07-23*
