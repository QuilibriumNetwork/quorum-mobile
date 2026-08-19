# DM identity emission map

**The question this answers:** *which code paths can put a user's `display_name`
or `user_icon` on the wire, and what gates each one?*

That question now comes up on every change touching DMs, calls, or the receive
path. This map is the audited answer as of 2026-08-19. It was derived twice
independently: once by the implementer of the emission audit, once from scratch
by the whole-branch reviewer, and the two agreed.

---

## The rule being enforced

Stated by the operator, 2026-08-19:

> The **sender**'s identity IS shown to the receiver. It's just the **receiver**'s
> identity that is not shown until they reply, unless they already had previous
> conversations or sessions with the same sender.

Three consequences worth stating plainly, because each one is load-bearing:

1. **Initiating is itself the consent.** Sending someone a first message, or
   placing a call, reveals you to them. That is intended, not a leak.
2. **The asymmetry is the point.** They do not get to see *you* back until you
   deliberately engage. Replying to a message, or answering a call, is that act.
3. **Consent belongs to the relationship, not the session.** Once you have ever
   deliberately messaged someone, any new device or session of theirs can be
   answered immediately, without asking you again.

The failure mode all of this exists to prevent: **a spammer harvesting your
identity by merely messaging or ringing you.** Your client answers automatic
frames on its own — delivery receipts, read acks, ICE candidates, hangups. If
any of those carried identity, being contacted would be enough to unmask you.

**So the invariant is: an automatic frame reveals nothing. Ever.**

## The consent record

`services/dm/dmRevealLedger.ts` — a persisted, **per-device** record of
"this user has deliberately messaged this partner at least once."

- Set **only** by deliberate acts. Never by a receipt, a typing indicator, or any
  automatic frame.
- **Fails CLOSED.** A storage error, a malformed identifier, or any uncertainty
  reads as *not revealed*. This is deliberately the OPPOSITE posture from the
  profile send-gates in `services/dm/dmProfileGate.ts`, which fail OPEN because
  their worst case is a harmless duplicate push. **Do not unify the two.** Both
  are correct for their own risk.
- `ensureRevealBootstrap` derives the answer once from local history for
  conversations that predate the ledger, by scanning for a self-authored message.
  It never persists a negative, so a later reply can still flip it.

## The map

| Path | Gate | Why |
|---|---|---|
| `useSendDirectMessage.ts` init/accept envelopes (4 sites) | none needed | sending IS the deliberate act |
| `useSendDirectEmbedMessage.ts` init/accept envelopes (2 sites) | none needed | same |
| `dmProfileService.sendProfileToPartner` | **caller must already hold consent** | documented precondition; it performs no check itself, deliberately, so Task 6 can call it right after recording a reveal |
| `broadcastProfileToAllDMs` (on-connect / on-rename sweep) | `ensureRevealBootstrap` per partner | a conversation row is created by a *stranger's inbound message*, so having a row is NOT consent |
| `onDeliberateDmSend` (reply / initiate / call-answer) | sets the ledger itself | it *is* the consent event |
| `autoRevealOnInboundSession` (partner's new device) | `ensureRevealBootstrap` + 1h debounce | the debounce matters: init envelopes can be redelivered, and without it one new device becomes a push storm |
| `CallContext.sendSignal` — **offer**, **answer** | explicit opt-in, plus records the reveal | placing a call = first message; answering = replying |
| `CallContext.sendSignal` — ICE ×2, hangup, event, renegotiate-answer, rotation | never passes identity | all fire with no human act behind them |
| `WebSocketContext` DM receipt ack | identity argument removed entirely | the archetypal automatic frame |
| `useDeleteConversationSignal.ts` | identity argument removed entirely | see the leak note below |
| `useDeleteDirectMessage.ts` / `useEditDirectMessage.ts` | `ensureRevealBootstrap` | see the per-device note below |
| `useSendDirectReaction.ts` | structurally cannot emit | reactions ride an existing session; no init envelope is ever built |

## Two traps that were live bugs, kept here so they are not re-introduced

**1. "They have a conversation row" is not consent.**
A row is created by an inbound message from a stranger. Two separate leaks came
from treating a row as permission:

- The broadcast sweep pushed your identity to every row, so renaming yourself
  announced you to people you had never chosen to talk to.
- Deleting a never-replied stranger's conversation sent them your `display_name`
  as the very first frame you ever sent them, routed through the `accept`-shaped
  session envelope (`sessionSendShape.ts` → `buildAcceptSend`), with no check
  anywhere in that path.

**2. "A self-authored message exists" is not consent *on this device*.**
The ledger is per-device by design. A message you sent from device A syncs to
device B and is stored there with your own `senderId`, but nothing in the receive
path records a reveal on B. So B can hold self-authored history with its ledger
unset. Editing or deleting that message on B would emit an init envelope — B's
first ever frame to that partner — carrying full identity, unchecked. The fix is
`ensureRevealBootstrap`, which scans that same local history and therefore
answers correctly on B while still being a *verified* reason rather than an
assumed one.

## Known gaps, all fail-safe

Each of these can only cause a **delayed or missed** reveal, never an
unauthorised one.

- **Native batch path skips the auto-reveal for `call-*` frames.** Its
  call-signal early `continue` runs before the `user_profile` auto-reveal check,
  whereas the JS path checks first. Filed as
  `issues/.open/2026-08-19-batch-decrypt-path-skips-auto-reveal-for-call-frames.md`.
- **The native auto-reveal trigger is narrower than "a new session appeared."**
  It fires on `user_profile` presence, which the native module only emits when
  the partner's envelope carries a non-empty `display_name` or `user_icon`
  (`QuorumCryptoModule.kt:1370-1374`, `QuorumCryptoModule.swift:1537-1541`). A
  partner with an empty profile is missed on that path; the JS paths and the
  on-connect sweep still cover it.
- **The auto-reveal debounce is keyed on partner address alone**, process-global.
  Under account switching on one device it can suppress a legitimate reveal for
  up to an hour. It never mixes identity across accounts.
- **`useDeleteDirectMessage` deletes the row before the history scan runs.** If
  the deleted message was the only self-authored one in that conversation, the
  scan finds nothing and fails closed.

## If you are changing any of this

- Add your new emission path to the table above, or explain why it cannot emit.
- The tests that protect this are in `__tests__/dmRevealLedger.test.ts`,
  `__tests__/dmRevealTriggers.test.ts` and `__tests__/dmIdentitySourceGuards.test.ts`.
  Several are static source-greps, which is an established convention here.
- **Prove your test can fail.** Every guard in this feature was verified by
  deliberately breaking the protection and confirming the test went red. An
  assertion that passes either way is worse than no test, because it manufactures
  confidence. The fail-closed proof in this very feature shipped unfalsifiable
  the first time and had to be rebuilt — the mock storage could not throw, so the
  safety branch was unreachable from any test.

---
*Last updated: 2026-08-19*
