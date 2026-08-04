---
type: task
title: "Mobile: conversation inbox keypairs must be PER DEVICE, not per conversation"
status: done
created: 2026-07-25
severity: high (silent message loss to any peer with 2+ devices — the ordinary case)
area: DM session storage / multi-device
related:
  - "issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md (§7.2, §20-quinquies — the parent bug; read §0 and §20 first)"
---

# Mobile: per-device conversation inbox (PART 1) + the missing accept (PART 2)

## Status

moved to .done/ 2026-07-28 (PR #180 merge confirmed against git; device verification recorded below). SHIPPED 2026-07-25 as PR #180 (master = `a780a80`) — PART 1 + PART 2 merged, 80/80 green, three independent reviews. ⚠️ THIS TASK is complete; the residual narrower loss noted below is NOT — it lives in the parent bug `issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md` §20-undecies, which remains open. PART 2 WORKS — reset-from-mobile went 0/3 → 5/5 both directions, the first clean pass in this bug's history, and the `invalid initialization envelope` flood is gone from live traffic. A narrower loss remains (inner-ratchet decrypt failures at the peer, possibly caused by the reverted `dfe9e96` — undecided); the next step is the BASELINE round in the bug doc §20-undecies, with the upgraded diag branches. Do NOT implement the "self-healing accept" in risk 3 below — measured live, wrong, reverted (see the warning in place).


> **Read this first if you are picking the task up.** PART 1 is written, tested,
> committed to a branch, and verified on devices as **not sufficient**. PART 2 is
> the newly-found mechanism, backed by SDK source, and is what actually blocks
> delivery. Do not re-litigate PART 1; do PART 2 on top of it.

---

## PART 1 — one conversation inbox per DEVICE session (IMPLEMENTED, NOT SUFFICIENT)

### The defect

Mobile keys state rows `(conversationId, inboxId)`, so the inbox a session
advertises IS its row key. The re-init path in `sendEncryptedMessageToAllDevices`
fetched ONE conversation-wide inbox (`getConversationInboxKeypair(conversationId)`)
and handed it to every device of a peer, so all their sessions re-initialized
into the SAME row: last writer won, the others were destroyed, and messages to
those devices were lost. Desktop mints a keyset per session and never had this.

### What was implemented — branch `fix/per-device-conversation-inbox`, commit 13a6b9e

- **`services/crypto/sessionReturnInbox.ts` (new)** owns the rule: a session's
  return inbox is the inbox its OWN row is keyed by. Rows within a conversation
  are unique by `inboxId`, so two sessions can no longer collide _by
  construction_ — this is structural, not a convention.
- Re-init reuses the session's own inbox; a new session mints one. Both are
  resolved BEFORE `enqueueOutbound`, so a freshly minted inbox is subscribed
  before anything is sent (the peer's confirming reply was otherwise lost).
- **Migration is lazy and idempotent** — no launch-time pass. A row whose
  keypair we no longer hold (written before the per-address store of #177, or
  missing its Ed448 half) mints a fresh inbox and re-initializes. Inbox mappings
  are only added, never deleted, so routing to older addresses survives (#252).
- Same rule applied to the embed send path and to the receive path's
  `ourConversationInbox` (the caller subscribes to whatever it returns).
- **`getConversationInboxKeypair(conversationId)` deleted** from the storage
  class so the pattern cannot come back. Removing it also cleared 2 pre-existing
  type errors: the old code assigned possibly-undefined signing keys — the
  compiler was already pointing at the shared slot being wrong.
- One shared init-envelope builder for new + re-initialized sessions.
- A session with no usable `sendingInbox` now warns instead of skipping the
  device silently.
- 10 new tests in `__tests__/perDeviceSessionInbox.test.ts` (67 total green),
  including a regression test pinning the old shared-inbox collapse.

### Deviation from the original design, and why

The original plan was to key keypairs by `(conversationId, deviceTag)`. That was
not implemented, deliberately: a device-keyed slot is a SECOND source of truth
that can drift from the row key, and when several rows share a device tag
(§20-bis — legitimate and common) it would hand back a different row's inbox and
re-create the exact collision being fixed. Deriving the inbox from the row makes
collisions impossible instead of merely unlikely, and needs no migration table.

### Live result (2026-07-25, LaMat on devices) — NOT FIXED

| Round | Setup                                   | mobile→desktop | desktop→mobile |
| ----- | --------------------------------------- | -------------- | -------------- |
| 1     | reset from MOBILE, mobile sends first   | **1/3**        | 3/3            |
| 2     | reset from DESKTOP, desktop sends first | **0/3**        | 3/3            |

PART 1 is still correct and stays in — but it is upstream plumbing, and the
pairing dies for a different reason described below.

---

## PART 2 — mobile never sends the SDK "accept" (THE ACTUAL BLOCKER)

### The evidence

Round 2 desktop console, repeated for every mobile frame:

```
[MessageService] DM decrypt failed (ConfirmDoubleRatchetSenderSession)
  — skipping frame, keeping session   Error: invalid initialization envelope
```

Round 1 desktop console, for messages 2 and 3:

```
[MessageService] DM decrypt failed (DoubleRatchetInboxDecrypt)
  — skipping frame, keeping session   SyntaxError: Unexpected token 'D', "Decryption"...
```

### The mechanism, from SDK source

`quilibrium-js-sdk-channels/src/channel/channel.ts`, `DoubleRatchetInboxEncrypt`
(L976+) branches its send on **`sent_accept`** — not on whether we know the
peer's inbox key:

```js
const ciphertext = state.sent_accept
  ? js_encrypt_inbox_message(<plain DR envelope>)      // 2nd frame onward
  : js_encrypt_inbox_message(<InitializationEnvelope>) // FIRST frame: the accept
...
outbound.push({ ..., sent_accept: true })
```

So **every session's first outbound frame is init-wrapped**, even when the peer's
return inbox is already known. That first frame is the _accept_: it carries our
own return inbox so the peer's unconfirmed sender session can confirm.

The receiving side is the other half. Desktop `MessageService.ts` (~L3660) picks
its decrypt path from ITS OWN row:

```js
if (freshKeys.sending_inbox.inbox_public_key === '') {
  ConfirmDoubleRatchetSenderSession(...)   // REQUIRES an init envelope
} else {
  DoubleRatchetInboxDecrypt(...)
}
```

and `ConfirmDoubleRatchetSenderSession` (channel.ts L1079+) throws
`invalid initialization envelope` unless the plaintext carries
`return_inbox_address`, `return_inbox_encryption_key`, `return_inbox_public_key`,
`return_inbox_private_key`, `tag`, `message`, `user_address`.

**Mobile branches on the wrong field.** Every mobile send path uses:

```js
const needsInitEnvelope = !sendingInbox || sendingInbox.inbox_public_key === "";
```

Since #177, a recipient session created from a peer's init envelope is born with
the peer's FULL return-inbox keyset, so `inbox_public_key` is already set and
mobile sends its very first reply as a PLAIN frame. The peer's sender session is
still unconfirmed, takes the Confirm branch, finds no init envelope, and rejects
every frame. `sentAccept` exists on mobile's `EncryptionState`, is written by
`initializeRecipientSession` (false), `encryptMessageForNewDevice` (false) and
`confirmSenderSession` (true), is faithfully preserved by every save — and is
**read by no send path at all**.

This is a deadlock, not a race: whoever resets creates an unconfirmed sender
session, and the peer can never confirm it. It explains §20-ter's symmetry ("the
dead direction is always the one pointing back at whoever reset") without any
send-selection defect, and it explains why desktop↔desktop is fine — desktop
follows the SDK and always sends the accept.

### What desktop ACTUALLY puts on the wire (decisive — checked, not assumed)

Desktop serializes its state blob as `{ratchet_state, receiving_inbox,
sending_inbox, tag}` and keeps `sentAccept` in a **separate DB column that is
never put back into the blob** (`MessageService.ts` L958-994). So the object
handed to `DoubleRatchetInboxEncrypt` has `sent_accept === undefined` → falsy →
desktop takes the else branch **every time**.

**Desktop init-wraps every frame it ever sends.** The SDK's plain-frame branch is
effectively dead code in production. That is why desktop↔desktop has never
broken: every frame satisfies the Confirm branch, and desktop's confirmed branch
explicitly tolerates an init envelope (`maybeInit.user_profile`). Mobile is the
only participant that ever emits a bare DR frame, and every one of them dies at a
peer whose row is still unconfirmed.

### The change required

1. **Make mobile announce its return inbox on every send, desktop-parity
   (RECOMMENDED)** — the behaviour proven in production by desktop↔desktop, and
   it removes the entire class of "the two sides disagree about who is
   confirmed". The init envelope wraps the SAME DR envelope, so the ratchet is
   untouched; it only adds the `return_inbox_*` fields to the sealed plaintext.
   Mobile already tolerates init envelopes on confirmed sessions (it decrypts
   desktop's, 3/3, in both live rounds), so this is symmetric with what works.

   The alternative is strict SDK-parity — `needsInitEnvelope = !state.sentAccept
|| !sendingInbox?.inbox_public_key`, flipping `sentAccept` after the first
   init-wrapped send. It is what the SDK _intends_, but nobody runs it: it leaves
   mobile emitting plain frames that only work if the peer is confirmed, which is
   precisely the assumption that just failed. Prefer parity with the wire, not
   with the intent.

2. Whichever is chosen, `sentAccept` must stop being write-only: today it is
   stored in three places, preserved by every save, and read by no send path.

3. **The accept must NOT re-run X3DH.** It encrypts with the EXISTING ratchet
   and wraps that envelope in an init envelope advertising our row's own inbox
   (PART 1 is what makes that address correct). The fan-out's re-init path
   currently calls `encryptMessageForNewDevice`, which mints a fresh X3DH session
   and replaces the row — correct for an unconfirmed sender, destructive for a
   recipient session the peer is actively using. These are two different sends
   and need two different builders.

   > Not a repeat of the abandoned Attempt 1 in §0: that rewrote _unconfirmed
   > sender_ sends to advanced-state frames aimed at DEVICE inboxes. The accept
   > goes to the peer's CONVERSATION inbox, where a live session row exists —
   > which §0 states is exactly where the SDK model works.

4. Apply to every send path that builds an init envelope: the fan-out in
   `useSendDirectMessage.ts`, the embed path, reactions, receipts.

### IMPLEMENTED — commit 8194b01, 78/78 green

`services/crypto/sessionSendShape.ts` returns `init | accept | plain |
unsendable` and documents the receiver-side contract. `accept` wraps the
existing ratchet (no X3DH) and is signed, because it is written to the peer's
conversation inbox. `encryptionService.markAcceptSent` flips the flag only after
the sealed frame exists, re-reading inside the ratchet lock. Applied to the
device fan-out (text, delete, edit, receipts, profile, calls) and the embed path.

Three risks were raised before implementation; here is where each landed.

1. **"`sentAccept` must be persisted or mobile init-wraps forever."** Persisted,
   and pinned by a test. Worth knowing for risk appetite: if that write were
   missed the cost is small, not catastrophic. An init-wrapped frame on an
   established session does **not** trigger session replacement — the peer's
   `DoubleRatchetInboxDecrypt` handles the init shape on the same ratchet
   (channel.ts, the `maybe_initialization_info_and_message.user_address`
   branch), which is exactly what desktop does to mobile on every frame today.
   The cost of a missed flip is a larger envelope, not a reset loop.
2. **"Verify the two `sentAccept` semantics converge."** They do, and there is a
   test for it. The flag means _the peer has our return inbox_. On a session we
   opened, `confirmSenderSession` sets it on **proof** — only our return inbox
   could have carried their reply. On a session they opened, the accept sets it
   on **assertion** — we sent it.
3. **NEW, and the weak point: assertion is not proof.** If the accept frame is
   lost, mobile has already flipped to plain and will never re-announce. That is
   the six-month bug's exact failure mode, re-armed on a narrower window.
   Desktop is immune only because its `sent_accept` never round-trips, so it
   re-announces forever by accident.

   ~~**A wire signal exists to close this and is NOT yet implemented.** The SDK
   sets `inbox_signature` only when `sending_inbox.inbox_public_key !== ''`
   (DoubleRatchetInboxEncrypt), so an incoming frame on one of our
   conversation inboxes with an empty `inbox_public_key` is proof the sender is
   still unconfirmed — i.e. our accept never landed. Clearing `sentAccept` on
   that observation makes the handshake self-healing.~~

   > **⚠️ DO NOT IMPLEMENT (2026-07-25).** This was implemented as `dfe9e96`,
   > measured live in round 23, and REVERTED (`69e7363`): it fired hundreds of
   > times on STALE redelivered frames (every frame desktop ever sent while
   > unconfirmed sits undeleted on our conversation inboxes with an empty
   > `inbox_public_key` and re-drains on every reconnect), not on live signal.
   > The round-23 desktop log later proved desktop was never unconfirmed in
   > that round — see the bug doc §20-undecies and §E. The "proof on the wire"
   > reasoning fails because the wire replays history: an unsigned frame is
   > evidence about the moment it was SENT, not about the peer's state now.

### Verification

- Unit (11 new): a recipient session's first send is `accept` and its second is
  `plain`; an unconfirmed sender still sends `init` even if `sentAccept` is
  somehow set; `markAcceptSent` is idempotent, preserves the rest of the row,
  and never regresses a ratchet advanced concurrently; both paths to the flag
  converge on `plain`.
- Live: rounds 1 and 2 above, expecting 3/3 both directions after a one-sided
  reset from either side.

### Known gap left open deliberately

`useSendDirectReaction.ts` always sends a plain frame — it has no init/accept
branch at all. A reaction sent as the FIRST thing on a session the peer opened
will be dropped. In practice the first text message accepts the session and
reactions work from then on. Fixing it means giving that path the accept
builder; left out to keep this change reviewable.

### Still unexplained after PART 2 lands

Round 1's messages 2 and 3 failed with `DoubleRatchetInboxDecrypt` on a row
desktop considered confirmed — a genuine ratchet divergence, not a branch
mismatch, in the same family as §11/§13b ("desktop chronically one ratchet
behind"). PART 2 may or may not remove it. If it survives, instrument rather than
guess: the XPTRACE/XPDUMP rigs in §20b give an exact 1:1 frame join across both
logs via `envFp`.

## Do NOT

- Do not delete inbox mappings anywhere (undoes #252).
- Do not assume mobile↔mobile is healthy — untested, and the code says otherwise.
- Do not treat extra devices as a test-account artefact. Multi-device is normal
  and must not lose messages.
- Do not revert PART 1 to "fix" PART 2 — they are independent defects.

## Open question for the Lead Dev (separate subsystem, unverified)

Fan-out happens at SEND time against the registration as it was then. A device
that is offline still receives (frames queue in its inbox), but a device **added
after** a message was sent was never a target and has no copy. Whether a
newly-added device gets history depends on a separate sync/backup path that has
NOT been verified.

---

_Last updated: 2026-07-25_
