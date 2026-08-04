---
type: task
title: "Mobile never piggybacks receipt acks on outgoing DMs — half the port is missing"
status: done
created: 2026-07-27
priority: medium
effort: small — one context method + attach/strip at the DM send site; no wire-format change
area: DM receipts — context/WebSocketContext.tsx (expose the drain) + hooks/chat/useSendDirectMessage.ts (attach/strip)
repo: quorum-mobile only (shared already provides everything; desktop already does this)
shared_change_required: false
related:
  - "issues/.done/2026-07-19-dm-receipt-pipeline-and-global-toggles.md (the port that specified only the standalone half)"
  - "issues/.done/2026-07-26-receipt-truthfulness-delivery-gated-reads.md (§7's transport analysis is wrong for mobile because of this)"
  - "quorum-desktop/.agents/tasks/.done/2026-07-27-combined-receipt-ack-and-protocol-options.md (where this was found; DONE 2026-08-01 — its option 1, the one that overlapped with this, was skipped, so §6 here no longer describes a live decision)"
---

# Mobile never piggybacks receipt acks on outgoing DMs

## TL;DR

A receipt ack can travel two ways: **piggybacked** on a normal DM you were already sending
(free — the encryption is already being paid for), or **standalone** as its own control
message (a full DM through the Double Ratchet: a real publish plus a ratchet advance on both
sides).

Desktop does both. **Mobile only ever sends standalone acks.** It correctly *consumes*
piggybacked acks on receive but never *produces* them.

Not a correctness bug — receipts work. But mobile pays for every ack in every conversation
pattern, and gets worse receipt latency exactly when a conversation is busiest.

---

## 0. What changed between writing this (2026-07-27) and starting it (2026-08-01)

Three things, all verified against master before implementing. Two make the task cheaper,
one makes its prescribed implementation dangerous.

**0a. ~~The verification problem is solved.~~ WITHDRAWN same day — it is not.** The headless
DM harness has since shipped (`dev/harness/`, PRs #189-#193), and it looked like the rig §7
asks for: two mobile bots exchanging real DMs in Node with `HARNESS_SEND_INTERVAL_MS` as a
knob. **It cannot close checks 1-2** — the observation point is wrong, nothing logs an ack,
and above all the harness never fails, so it is structurally blind to the one failure mode
this feature introduces. Full reasoning in §7; read that before reaching for it.

The generalisable form, and the reason this is worth keeping rather than deleting: *a clean
rig that always passes cannot verify work whose risk is that things sometimes do not arrive.*
It confirms the happy path and reads as "verified" while proving nothing about the failure.

**0b. §5's hazard is smaller than it reads, in two independent ways.**

*It is not a new failure class.* The shipped standalone path has the identical exposure:
`onFlush` drains the buffer and calls `sendDmReceiptAck`, which swallows its own failure with
a `logger.debug` (`WebSocketContext.tsx:5793-5795`) and never retries. Piggybacking changes
which send carries an ack, not whether a failed send loses it.

*And a lost ack now self-heals.* The 2b named-ids work landed (commit `2885d16`) and its own
comment at `WebSocketContext.tsx:5855-5858` states the design: naming the read ids settles ✓✓
for a message whose delivery ack was lost, while the cumulative high-water mark repairs a
dropped read ack. Both directions covered.

**0c. ⚠️ §4b's prescription is wrong for mobile — it would have shipped a silent no-op.**
See §4b, rewritten. This is the single most important line in this document.

---

## 1. Evidence

**Mobile consumes but never produces.** The only references to the envelope fields anywhere
in the mobile codebase are on the receive path:

```
context/WebSocketContext.tsx:646  if (fromPartner && raw.ackMessageIds && …) svc.onAckReceived(raw.ackMessageIds);
context/WebSocketContext.tsx:647  if (fromPartner && raw.readAckUpTo && …) { … }
context/WebSocketContext.tsx:650  delete raw.ackMessageIds;
context/WebSocketContext.tsx:651  delete raw.readAckUpTo;
```

`flushForPiggyback` and `flushReadForPiggyback` — the shared methods that drain the buffers
into an outgoing message — are **never called anywhere in the mobile repo.**

**Desktop does it** in `src/services/MessageService.ts:528-542` (`attachPiggybackedAcks`,
called before encryption) and `548-552` (`stripPiggybackedAcks`, called before persisting).

**Shared has always provided it.** `flushForPiggyback` (`receipts/service.ts:59-66`) and
`flushReadForPiggyback` (`88-94`) are public, and both drain the buffer *and* cancel the
pending standalone timer. The envelope fields are typed in `shared/src/types/receipt.ts:46-51`.
Nothing is missing on the shared side.

---

## 2. Why it was missed (worth reading — it generalises)

The port spec (`issues/.done/2026-07-19-dm-receipt-pipeline-and-global-toggles.md`) specified
**only the standalone paths**:

- Phase 1: `onFlush(address, messageIds)` → send a `delivery-ack` to that partner
- Phase 2: `onReadFlush` → send a `read-ack`

Piggybacking appears in that document three times and never as a deliverable: twice as
inventory ("what shared provides", "envelope fields exist") and once at line 78 pointing at
desktop's `interceptControlMessages` as the reference for handling "both ack types +
piggybacked `ackMessageIds` / `readAckUpTo` envelope fields" — which is the **receive** side,
and mobile implemented it correctly.

So the implementer built what was written. The spec ported half of a two-halves feature.

**The acceptance criteria could not have caught it.** The spec used vertical slices with
observable outcomes, which is the right approach:

> **Observable:** send a DM phone→(other device); the ✓ appears once delivered.
> **Observable:** the other device opens the DM; your ✓ flips to ✓✓.

Both pass perfectly with standalone acks only. **Piggybacking has zero observable behaviour
difference** — same ticks, same states, same UI. It changes only how many encrypted messages
cross the wire and how fast they arrive.

The lesson for future ports: when a feature has a performance-shaped half, "did it work when
I used it" cannot verify it arrived. Such a slice needs a measurable acceptance criterion
(message count, timing), not a visual one.

---

## 3. Impact

### Cost
Every ack is a separate encrypted message with a ratchet advance on both sides (1 write to
`encryption_states` + 1 to `latest_states` per side). Data, battery, server load. Desktop
pays this only when a conversation is idle; mobile pays it always.

### Latency — the part that bites hardest when it matters most
The delivery timer is a **debounce, not a throttle**: every inbound message calls
`resetDeliveryTimer`, which does `clearTimeout(existing)` before setting a fresh 10s window
(`receipts/service.ts:140-154`). Read is the same at 5s.

So the ack fires 10s after the **last** message, not the first. Someone sends you five
messages 4s apart:

- **Desktop:** you reply, the pending acks ride out attached to your reply, immediately.
- **Mobile:** your reply carries nothing. The timer keeps getting pushed back by each new
  inbound message. The ack only goes once the conversation pauses for a full 10s — then as
  its own encrypted message.

Piggybacking is desktop's escape valve from its own debounce. Mobile has none, so it hits the
worst case precisely when the conversation is most active.

### A doc claim that is now known false
The transport analysis in `issues/.done/2026-07-26-receipt-truthfulness-delivery-gated-reads.md` §7
states active back-and-forth costs "**~1.0x** — effectively free" *because* acks piggyback.
That was written from desktop's behaviour. **It is false for mobile**, which pays close to
the standalone cost in every row of that table. Fix the table (or caveat it per-platform) as
part of this work.

---

## 4. The fix

No wire-format change. Both sides already speak this; mobile just never talks.

### 4a. Expose the drain from WebSocketContext

The `ReceiptService` lives in `receiptServiceRef` inside `WebSocketContext`, but the DM send
lives in `hooks/chat/useSendDirectMessage.ts`. The context currently exposes only
`notifyDmRead` (interface at `WebSocketContext.tsx:132`, value at `~6184`), so the send hook
has no way to reach the buffers.

Add one method alongside it, e.g.:

```ts
takePendingReceiptAcks: (partnerAddress: string) => ReceiptEnvelopeFields | null;
```

It should drain both buffers and return `{ ackMessageIds?, readAckUpTo? }` (or `null` when
both are empty), **honouring `isReceiptEnabled('delivery' | 'read', partner)` per half** —
the same gate the standalone send paths use. Do not attach an ack the user's settings say
should not be sent.

### 4b. ⚠️ Send a copy — do NOT attach-then-strip (CORRECTED 2026-08-01)

**The original prescription here was "attach the fields to `message` before the send call and
strip them immediately after, before the return", ported from desktop's
`attachPiggybackedAcks` / `stripPiggybackedAcks`. On mobile that is silently broken.**

Mobile's send is **deferred**. `sendEncryptedMessageToAllDevices` does not serialize anything;
it ends by handing a *thunk* to `enqueueOutbound` (`useSendDirectMessage.ts:1237`), and the
`JSON.stringify(message)` that actually puts bytes on the wire runs inside that thunk
(`~987`), later, when the queue drains. The provider's own comment is explicit:
"enqueueOutbound only appends to a queue processQueues drains on its own schedule"
(`WebSocketContext.tsx:5663-5664`).

So `attach → await send → strip` strips the envelope fields **before the thunk ever
serializes them**. The result is the worst available outcome:

- the buffers are drained and the standalone timers cancelled,
- nothing goes on the wire,
- **the acks are destroyed** — strictly worse than not doing the feature at all,
- and it fails *silently*: no throw, no log, and per §7 there is no observable behaviour to
  notice it by. An assertion on the `message` object would even pass.

Desktop is unaffected because its send encrypts inline, before returning.

**Do this instead: never mutate `message` at all. Hand the send a shallow copy carrying the
fields, and leave the caller's object clean.**

```ts
const piggyback = takePendingReceiptAcks(recipientAddress);
await sendEncryptedMessageToAllDevices(
  conversationId,
  recipientAddress,
  piggyback ? { ...message, ...piggyback } : message,
  …
);
```

This is strictly better than attach/strip on every axis: the copy is captured by the thunk's
closure and survives until serialization, the original never holds a transient wire field so
there is nothing to leak into the cache or storage and no strip to forget, and there is no
ordering hazard left to reason about. Verified safe: the send path only ever reads `message`
(`JSON.stringify` in `buildInitEnvelopeSend` / `buildAcceptSend`); the sole mutations in the
hook are `signature` / `publicKey` at `~301-302`, which happen well before the send.

The stored copy was already safe by construction: `onMutate` persists its own optimistic
message before `mutationFn` runs, so it never sees these fields either.

### 4c. Check the other DM send paths — ANSWERED 2026-08-01

The original text assumed "edits, deletes and reactions … are equally valid carriers."
**Two of the five candidates are not, and the reason only shows up if you check the fan-out.**

A carrier is only valid if it reaches **every** one of the partner's devices, because that is
what the standalone path does (`sendDmReceiptAck` builds `allTargetDevices` from the
registration). Draining into a single-device send trades "arrives everywhere within 10s" for
"arrives on one device now, and on the others never" — the buffer is gone either way.

| site | fan-out | attach? |
|---|---|---|
| `useSendDirectMessage` | `allTargetDevices` — every device | ✅ yes |
| `useEditDirectMessage` | `allTargetDevices` — every device | ✅ yes |
| `useDeleteDirectMessage` | `allTargetDevices` — every device | ✅ yes |
| `useSendDirectReaction` | `sendEncryptedControlMessage` → `getLatestState`, **one** session | ❌ no |
| `useSendDirectEmbedMessage` | `getLatestState`, **one** sealed message | ❌ no |
| `sendDmReceiptAck` | every device | ❌ no — an ack riding an ack |
| `useDeleteConversationSignal` | — | ❌ no — the conversation is being torn down |
| `dmProfileService`, `CallContext` | — | ❌ no — not per-partner conversation traffic |

Worth knowing: the embed path is a first-class user message (sending a photo), so excluding it
does cost real piggyback opportunities in image-heavy conversations. It is excluded on the
fan-out ground alone. If those two paths ever gain full device fan-out, they become valid
carriers and should be revisited together.

A single choke point inside `sendEncryptedMessageToAllDevices` was considered and rejected: it
would swallow the ack path (which must be excluded), and since it is a plain function with no
context access the drain would still have to be passed in per call site — so it saves nothing
and removes the per-site judgement this table encodes.

---

## 5. Gotchas and one real design question

**Fan-out duplication is harmless.** Mobile sends the same message object to every target
device inbox, so N copies each carry the ack. The partner's devices each process it, which is
idempotent — `resolveDeliveryAckPatch` / `resolveReadAckPatch` return `null` when nothing
changes. Copies reaching the user's *own* devices are already ignored by the `fromPartner`
guard at `WebSocketContext.tsx:646-648`.

**⚠️ Draining into a send that might never land loses the acks permanently.** Both drain
methods clear the buffer *and* cancel the standalone timer. If the send then fails, nothing
re-sends those acks — no retry, no error, no visible failure until someone notices missing
ticks. This matters more on mobile than desktop, because mobile's send can be queued while
offline (`enqueueOutbound`) and DM send has a known ~10-15% failure mode
(`issues/.open/2026-07-23-dm-send-websocket-not-connected-abort-and-failed-ux.md`).

**RESOLVED 2026-08-01 — take the best-effort option; do NOT build the confirmed-transmit
drain.** The original recommendation was to drain only once transmission is confirmed, "since
the hook already exists", pointing at `markDmMessageSent`. That signal does not mean what it
needs to mean. It fires inside the socket-OPEN drain (`useSendDirectMessage.ts:407-410`), i.e.
when the frame was handed to `ws.send` on a socket that looked open — which is *precisely* the
boundary the DM investigation showed is untrustworthy. `flushOutbound`'s own docstring says it
outright: "true means 'handed to a live socket', NOT 'delivered' … a socket can read OPEN for
3.5-5s after it is already dead" (`WebSocketContext.tsx:5653-5658`), and the harness README
frames the open bug as frames "handed to `ws.send`, signed, socket open, and never arrive".

So gating the drain on it buys close to nothing while adding buffer state held across an async
boundary. Best-effort, matching desktop, is the right call — and §0b is why it is defensible:
the exposure is not new (the standalone path already drains into an error-swallowing send),
and a lost ack now self-heals via the named-ids / high-water-mark pair.

Revisit only if delivery confirmation ever becomes real at this layer. Then both platforms
should adopt it together, along with the mixed-version hazard in the desktop combined-ack
task (§3 there) — the same class of problem, draining a buffer into a payload that may not
arrive.

---

## 6. Relationship to the combined-ack proposal — RESOLVED, no longer a decision

> **Settled 2026-08-01.** The overlap this section warned about is gone: the combined ack
> (option 1) was **skipped**, and the option that shipped in its place does not touch the
> piggyback path at all. Nothing here needs deciding before starting this task.

`quorum-desktop/.agents/tasks/.done/2026-07-27-combined-receipt-ack-and-protocol-options.md`
proposed bundling the delivery and read acks into one standalone message (its option 1). That
was rejected: combining works by *draining* the delivery buffer, so an older peer that ignores
the extra payload destroys those delivery acks permanently.

What shipped instead (option 2b, all three platforms) is that a read ack **names** the ids it
read alongside the high-water mark, which carries derived data and destroys nothing. It makes
a read ack able to settle ✓✓ for a message whose delivery ack was lost — a correctness gain,
not a traffic one — and leaves the standalone-vs-piggyback question exactly where it was.

So this task keeps its full value and stands alone: mobile-only, no shared change, no publish,
no pin bump, no wire-format compat analysis, and it removes the worst-case ack latency that
only mobile suffers. One consequence of 2b worth knowing while implementing it: the piggyback
envelope's `readAckUpTo` now has an optional `messageIds` alongside `messageId`/`timestamp`,
and `flushReadForPiggyback` returns all three — so attach the payload whole rather than
picking the two fields out of it.

---

## 7. Verification

**The honest problem: there is no UI-observable outcome.** Receipts look identical before and
after. A "does it still work" pass proves nothing. Acceptance must be measurable:

1. **Piggyback actually happens.** Two devices, active back-and-forth. Confirm an outgoing DM
   carries `ackMessageIds` / `readAckUpTo`, and that **no** standalone `delivery-ack` /
   `read-ack` follows for those same IDs. The `[WS-send]` envelope logging in
   `enqueueOutbound` already prints outgoing keys and is a good place to look.
2. **Latency improves.** In a rapid exchange (messages <10s apart), receipts should now
   appear on the peer without waiting for a conversation pause. This is the user-visible
   *benefit*, and the closest thing to an observable outcome.
3. **Idle path still works.** Send a single message and go quiet: the standalone timer path
   must still fire. Easy to break — the drain cancels the timer, so a bug here means acks
   stop entirely in one-sided conversations.
4. **Settings still honoured.** Delivery off → no `ackMessageIds` attached. Read off → no
   `readAckUpTo`. Per-conversation overrides too.
5. **No leakage.** The persisted message and the React Query cache entry must not contain
   `ackMessageIds` / `readAckUpTo` after send.
6. Existing receipt tests stay green (`receiptReconciliation` 17, `receiptWiring` 17 — both
   grew on 2026-08-01 with the named-ids work; the counts here were 12 and 9 before that).

Check 3 is the regression risk. Check 1 is the proof the feature landed.

### What the implementation actually covers (2026-08-01)

Automated, and green: **188 tests / 18 suites** (from 160 / 17 — `piggybackAcks.test.ts` is
new with 17, `receiptWiring.test.ts` went 17 → 28). `tsc` unchanged at 11 pre-existing errors,
none in a touched file; both new files lint clean.

| check | covered by | status |
|---|---|---|
| 3 — idle standalone path still fires | `piggybackAcks.test.ts`, real `ReceiptService` + fake timers | ✅ automated |
| 4 — settings honoured per half | same, incl. "a disabled half is not even drained" | ✅ automated |
| 5 — no leakage into cache/storage | `withPiggybackedAcks` copy + original-left-clean tests | ✅ automated |
| — no duplicate standalone after a piggyback | real service: timer stays disarmed past 30s | ✅ automated |
| — no ack rides an ack; no single-device carrier | `receiptWiring.test.ts` source guards | ✅ automated |
| 1 — piggyback actually happens on the wire | — | ⬜ owed: on-device |
| 2 — latency improves in a rapid exchange | — | ⬜ owed: on-device |

### ⚠️ Correction to §0a — the harness cannot close checks 1-2 (2026-08-01, lead's steer)

§0a claimed the harness solved §7's verification problem. **It does not, and reaching for it
here would have produced a green result that meant almost nothing.** Three reasons, in
increasing order of importance:

1. **`[WS-send]` cannot show it.** That log parses the *sealed* envelope, so its `keys=` are
   `type, inbox_address, envelope, ephemeral_public_key`. The piggyback fields sit inside the
   encrypted blob. §7 check 1 named the wrong observation point.
2. **Nothing logs a piggybacked ack.** The only receipt log line in the provider is
   `'[DM-receipts] ack send failed'`. Producing and consuming an ack are both silent, so even
   the receiving bot would show nothing without new instrumentation.
3. **The harness never fails, and that is the disqualifying one.** Every mobile run to date is
   0.0% loss. The risk this feature carries is §5's: a drained ack dies with a send that does
   not land. The harness cannot produce that condition — no connection drops, WASM crypto
   rather than the native uniffi path, and Node's `ws` rather than RN's native WebSocket,
   which is where the field loss lives. A green run would confirm the happy path while staying
   structurally silent about the only failure mode worth worrying about, and would read as
   "verified" regardless.

**So: verify on-device, in the UI, two real devices.** Drive an exchange faster than the 10s
debounce and confirm the peer's ticks settle without waiting for a pause (check 2 — the
user-visible benefit and the closest thing to an observable outcome), and confirm the idle
one-sided case still settles (check 3, already unit-covered but cheap to confirm live).

The harness keeps exactly one narrow use here: a clean-path existence check that the field is
attached at all, and only after adding the debug lines point 2 says are missing. Those lines
are worth having regardless — a feature with no observable behaviour and no logging is
invisible to every future debugger — but they are instrumentation, not this task's acceptance.

⚠️ **This file was moved to `.done/` on 2026-08-01 with checks 1-2 still open.** The code is
merged (PR #211, `bd76f62`) and unit-covered; the live confirmation is not done.

Note check 3 turned out to be the cheapest to secure, not the riskiest: the drain is per
partner and per half, so the timer it cancels is precisely the one whose acks just left. The
sharper risk was the one §4b hid (see §0c), and it is now pinned by both a unit test on the
copy and a source guard against reintroducing attach/strip.

---

*Last updated: 2026-08-01*
