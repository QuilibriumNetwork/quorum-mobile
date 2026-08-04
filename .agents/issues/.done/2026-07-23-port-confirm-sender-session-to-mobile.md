---
type: task
title: "Port ConfirmDoubleRatchetSenderSession semantics to mobile — complete the DM session handshake so sessions confirm instead of churning forever"
status: done
created: 2026-07-23
severity: high (root cause of tier 4: receipts dead + unbounded session churn, likely core of the ~6-month mobile DM unreliability)
area: DM receive path / Double Ratchet session confirmation
related:
  - ".agents/issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (§7c — evidence chain)"
  - "quilibrium-js-sdk-channels/src/channel/channel.ts:1079 (the canonical implementation being mirrored)"
  - "quorum-desktop/src/services/MessageService.ts:3584-3639 (desktop's Confirm call-site pattern incl. ratchet-mutex + immediate save)"
lead-note: protocol-level change, but strictly a 1:1 port of the lead's own shipped SDK logic; flag in PR description, not blocked on review (lead unreachable; validation is behavioral protocol-conformance against desktop)
---

# Port ConfirmDoubleRatchetSenderSession to mobile

## The handshake, in one paragraph
Initiator sends its first DM wrapped in an InitializationEnvelope carrying its `return_inbox_*`
(address + encryption key + Ed448 signing pub/priv + tag). Responder installs a session and replies —
ALSO wrapped in an init envelope carrying the RESPONDER's `return_inbox_*` — to the initiator's
return inbox. The initiator processes that first reply with **ConfirmDoubleRatchetSenderSession**:
unseal → validate ALL return fields present → DR-decrypt the inner message with the unconfirmed
sender state → save the state with the responder's full `sending_inbox` (incl. private key) and
`sentAccept: true`. From then on BOTH sides use plain `dr` envelopes (no more init wrapping). Both
clients wrap every send in an init envelope while their state has `sending_inbox.inbox_public_key
=== ''` — so an unconfirmable session means init-wrapping forever = the observed churn.

## What mobile actually has: a PARTIAL confirm with four exact divergences from the SDK

Mobile's conversation-inbox receive path (WebSocketContext, init-envelope branch with existing
states) trial-decrypts the inner message and, on success, updates `sendingInbox` — a de-facto
confirm. Divergences vs the SDK function (channel.ts:1079):

| # | SDK / desktop | Mobile today | Consequence |
|---|---|---|---|
| 1 | Validates ALL return fields non-empty (address, encryption key, signing PUB and PRIV, tag, message, user_address) — throws otherwise | Accepts partial: `inbox_public_key: unsealed.return_inbox_public_key \|\| ''` | A reply missing the signing pub key silently re-saves `''` → state stays unconfirmed → sender keeps init-wrapping forever |
| 2 | Stores `inbox_private_key` from the envelope's `return_inbox_private_key` | Hardcodes `inbox_private_key: ''` | Missing key material desktop expects in the confirmed state |
| 3 | Saves `sentAccept: true` on confirm | `sentAccept` is NEVER set true anywhere on mobile (grep-verified) | Anything keying off sentAccept sees unconfirmed forever |
| 4 | Confirm is a DISTINCT branch selected when the receiving state has `sending_inbox.inbox_public_key === ''` (desktop MessageService:3591), run under the ratchet mutex with immediate save | Mobile trial-loops ALL states via generic `decryptMessage` and only patches sendingInbox afterwards in the caller | Wrong state can win the trial; the update races the drain; no unconfirmed-state targeting |

Root effect: mobile-initiated sessions can never reach confirmed; desktop's sessions toward mobile
never see a valid confirming reply; both sides init-wrap every message; each wrapped message can
install yet another session on the peer → 22 → 33+ state rows in one afternoon, receipts (which ride
only stored states, no init fallback) fail 100%.

## Implementation plan (mobile-only, additive)

### 1. `encryption-service.ts`: new method `confirmSenderSession`
Mirror the SDK exactly, composed from EXISTING primitives (no new crypto):
```
confirmSenderSession(conversationId, receivedOnInboxAddress, unsealed /* InitializationEnvelope */):
  inside ratchetMutex.runExclusive(conversationId):
    state = getEncryptionState(conversationId, receivedOnInboxAddress)
    guard: state exists AND state.sendingInbox?.inbox_public_key is '' or missing  → else return null (not a confirm case)
    validate (SDK rule): return_inbox_address, return_inbox_encryption_key,
      return_inbox_private_key, return_inbox_public_key, tag, message, user_address all non-empty
      → else return null (fall back to existing generic path)
    result = cryptoProvider.doubleRatchetDecrypt({ ratchet_state: state.state, envelope: unsealed.message })
    on decrypt failure → return null (keep session untouched — Signal rule)
    save immediately (inside the lock): { state: result.ratchet_state, timestamp: Date.now(),
      conversationId, inboxId: state.inboxId, sentAccept: true,
      sendingInbox: { inbox_address, inbox_encryption_key, inbox_public_key, inbox_private_key } from unsealed,
      tag: unsealed.tag }  (latest = true — replies now route to the confirmed inbox)
    return { message: decrypted, userProfile from unsealed }
```

### 2. `WebSocketContext.tsx`: call it FIRST in the conversation-inbox init-envelope branch
Before the existing trial-decrypt loop: if `confirmSenderSession` returns a result → use its
decrypted message and skip the generic path (the [stale-init]/staleness guard is untouched — it
gates X3DH INSTALLS, which confirm never performs). If it returns null → existing behavior exactly
as today (no regression surface).

### 3. Fix divergence 1 & 2 in the EXISTING partial-update path too
Where the trial-decrypt success currently patches `sendingInbox`: require the full field set before
patching (else leave state untouched), store `inbox_private_key`, and set `sentAccept: true` on that
save. Keeps the two paths semantically identical.

### 4. Tests
- Unit-test `confirmSenderSession` guards: not-unconfirmed → null; missing fields → null; decrypt
  fail → null + state untouched; success → sentAccept true + full sendingInbox + tag persisted.
  (Mock cryptoProvider + storage — no native crypto needed to test the bookkeeping, which is the
  only new logic; the crypto calls are existing primitives.)

## Why this is safe (for the record)
No new cryptography: unseal + DR-decrypt are existing primitives used on every message today; the
new code is field validation + state bookkeeping copied 1:1 from the lead's shipped SDK. Additive:
every failure path returns null into today's exact behavior. Reversible: one isolated commit.
Verification is behavioral protocol-conformance: after the fix, (a) receipts appear on mobile,
(b) desktop stops force-init-wrapping (its logs / envelope types), (c) the state-row count for the
conversation STOPS growing, (d) `sentAccept: true` rows appear. Cleanup of the ~33 junk rows can be
a follow-up (one manual reset after confirm works collapses the churn).

## Validation round (ONE, fast now that the hoard is drained)
1. Reset session on mobile for the test conversation (collapses to a clean slate).
2. Mobile sends 1 message → desktop reads.
3. Expect on mobile within ~1 min: message ticks appear (delivery + read), `[RECEIPT-DIAG] ack
   ARRIVED`, no new `EMPTY/FAILED` for fresh envelopes, and the state count stable at ~1-2 rows
   with `sentAccept: true`.

---
*Created: 2026-07-23*
