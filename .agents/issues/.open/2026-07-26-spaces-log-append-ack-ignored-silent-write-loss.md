---
type: bug
title: "Spaces: the hub-log write ack is received and discarded, so a silently dropped space message is invisible to the sender"
status: open
priority: high
ai_generated: true
created: 2026-07-26
updated: 2026-07-31
area: context/WebSocketContext.tsx (hub log transport), services/space/
related:
  - "issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md (CONTEXT ONLY — the DM investigation that found the underlying node-side write loss; §27 has the mobile↔mobile measurement)"
  - "https://github.com/QuilibriumNetwork/quorum-mobile/issues/183 (item 2 = the node write-path loss this report assumes exists)"
---

# Spaces: the hub-log write ack is received and discarded

## Status

the discarded ack is still real and unfixed. ⚠️ BUT its motivating premise changed on 2026-07-31: the "node silently drops writes" assumption is largely superseded by a measured client-side transport bug, and the fix for THAT already covers space sends. Re-scope before building anything here


> **⚠️ AI-Generated**: May contain errors. Verify before use.

## READ THIS FIRST — what is and is not established

This report is a **code-reading assessment only**. No Spaces capture round has
ever been run. Nothing here is measured.

| Claim                                                                                                                              | Status                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space messages are sent over the same `ws.send` path as DM frames                                                                  | **VERIFIED in code**                                                                                                                                |
| `log-append-ack` exists in the protocol and the client's handler for it is empty                                                   | **VERIFIED in code**                                                                                                                                |
| `log-append` frames carry no `request_id`, so acks cannot be correlated to writes                                                  | **VERIFIED in code** — in fact NO frame in the app ever sends one, see §3                                                                           |
| The sender receives its own write back as a hub-log echo, and the client already tracks sent-envelope fingerprints to recognize it | **VERIFIED in code** — see Fix 1b                                                                                                                   |
| The UI marks a space message `sent` before the frame reaches the socket                                                            | **VERIFIED in code** — see Fix 1 step 4                                                                                                             |
| Read-side gap detection + `log-since` refetch works and is well built                                                              | **VERIFIED in code**                                                                                                                                |
| The node silently drops a fraction of writes                                                                                       | **VERIFIED for DMs** (measured, see the DM doc §27); assumed to apply to `log-append` because it is the same transport, **NOT measured for Spaces** |
| Space messages are actually being lost in practice                                                                                 | **UNKNOWN — never tested**                                                                                                                          |
| The Triple Ratchet has a late-join fork like the DM Double Ratchet                                                                 | **UNKNOWN — open question, see §5**                                                                                                                 |

The bug being reported is the **discarded ack** (verified). The impact estimate
depends on the node write loss (verified elsewhere, not here).

### ⚠️ UPDATE 2026-07-31 — the impact estimate above rests on a premise that has since changed

**Read this before acting on anything below.**

This report assumed the DM write loss was the **node silently dropping writes**,
and reasoned that `log-append` inherits it because it rides the same transport.
The first half of that no longer holds; the second half now works in our favour.

**What actually caused the DM loss** (measured 2026-07-30/31, see
`quorum-desktop/.agents/tasks/transport/measurements.md` § ROUND Q onward):

- The relay pings every 9.0 s and kills any client whose pong is >1 s late.
- It kills with **no close frame**, so the client keeps writing into a dead
  socket for **3.5-5 s** before noticing.
- Frames written in that blind window are accepted by `ws.send()`, dropped from
  the queue as "sent", and never delivered or retried.
- Confirmed by joining every sent message to the socket close that followed it:
  **every loss sat 1.4-3.5 s before a close, no survivor sat inside that band**,
  across two rounds, with the second round's predictions published in advance.

So a large share of what this report called "the node dropping writes" was
**frames that never left the phone**. That does not make the discarded ack a
non-bug — it makes the **impact estimate much smaller**, and it changes what a
fix should target.

### ✅ The same-transport observation now cuts the other way

This report's §1 ("Space messages ride the same transport as DMs") is verified,
and re-verified 2026-07-31: `hooks/chat/useSendSpaceMessage.ts` calls
`enqueueOutbound` from `useWebSocket`, the same client and the same outbound
drain as DMs.

**The DM fix therefore already covers space message sends.** It widens the
existing `pendingEnvelopes` rescue in the shared drain loop — it is not
DM-specific. Measured on DMs: a reproducible 16-17/20 became 20/20.

**Status:** merged into `quorum-shared` master as **b24058e** (PR #69), with the
retention policy in `src/transport/send-retention.ts` and **both** the RN and
browser clients using it. **Not published**, so `quorum-mobile` still runs the
local `node_modules` patch until the lead dev publishes a version. See
`quorum-desktop/.agents/tasks/.done/2026-07-31-ship-send-retention-to-quorum-shared.md`.

Note the shipped version keys retention to the **socket close** rather than to
replay time, so the reconnect gap can no longer eat the budget — strictly more
protective than the patch these numbers were measured against.

### What to do differently because of this

1. **Do not build Fix 1 (use the ack) on the old rationale.** Its value was
   "recover writes the node drops". Most of that class is now handled upstream of
   the ack, in the transport.
2. **The ack still has real value, for a different reason:** _detection_. The
   transport fix makes loss survivable, it does not make it impossible — and the
   sender still has no way to know a write vanished. That is worth fixing on its
   own terms, and it is the same argument as the protocol write-ack ask
   (quorum-mobile#183 item 3).
3. ⭐ **Measure before building.** The top row of the table above still reads
   _"Space messages are actually being lost in practice — UNKNOWN, never tested"_,
   and that is still true. Now there is a cheap way to find out: run a space
   burst with the socket-lifecycle probe armed and join each send to the next
   `[WS-life] CLOSE`, exactly as rounds Q-U did for DMs
   (`quorum-desktop/.agents/scripts/join-losses-to-closes.mjs`). If space losses
   land in the same 1.4-3.5 s band, they are the same bug and already fixed.
4. **Now verified (2026-07-31): EVERY `log-append` goes through
   `enqueueOutbound`**, so the whole space write path inherits the fix. Call
   sites checked: `useSendSpaceMessage`, `useChannelManagement` (9 sites),
   `useDeleteSpaceMessage`, `useEditSpaceMessage`, `useModMuteUser`, plus
   `deviceKeyStatements`. `spaceMessageService` only _builds_ the envelope
   (`JSON.stringify({ type: 'log-append', ...sealed })`) and returns it; the hook
   hands it to `enqueueOutbound`. **No further `quorum-shared` change is needed
   for spaces transport durability.**
   ) with **no DM/space filter**, and reports whatever `spaceId` it finds. A space message `"V 7"` matches identically |
   | `[WS-life]` OPEN / CLOSE / ERROR | ✅ | transport-level, already captures space traffic |
   | `[WS-frame] sent` | ✅ | fires for `log-append` too — it is in the shared drain loop |
   | mobile burst button | ❌ **DM-only** | space messages must be typed by hand |
   | `[DM-send row]` / `[DM-send wire]` | ❌ | DM-specific probes; no per-message send record for spaces |

Two DM-only behaviours carry over harmlessly: the doctor's `misfiled` flag
(`spaceId === ownAddress`) simply reads false for spaces, and its
ghost-conversation section filters `type === 'direct'` so it reports nothing.

⭐ **Useful asymmetry:** a space message is **one** `log-append` frame, not a
6-target fan-out like a DM. So one send = one `[WS-frame] sent`, which is far
easier to pick out of a capture than the DM case was.

) with **no DM/space filter**, and reports whatever `spaceId` it finds. A space message `"V 7"` matches identically |
| `[WS-life]` OPEN / CLOSE / ERROR | YES | transport-level, already captures space traffic |
| `[WS-frame] sent` | YES | fires for `log-append` too — it is in the shared drain loop |
| mobile burst button | NO — **DM-only** | space messages must be typed by hand |
| `[DM-send row]` / `[DM-send wire]` | NO | DM-specific probes; no per-message send record for spaces |

Two DM-only behaviours carry over harmlessly: the doctor's `misfiled` flag
(`spaceId === ownAddress`) simply reads false for spaces, and its
ghost-conversation section filters `type === 'direct'` so it reports nothing.

**Useful asymmetry:** a space message is **one** `log-append` frame, not a
6-target fan-out like a DM. So one send = one `[WS-frame] sent`, which is far
easier to pick out of a capture than the DM case was.

## HOW TO MEASURE SPACES — read this before building anything

The top of this report says space loss is `UNKNOWN — never tested`, and that is
still true. It is now cheap to answer, and the answer decides whether any of the
fixes below are worth building.

### The prediction to test

**If space losses land in the same 1.4-3.5 s band before a `[WS-life] CLOSE`
that DM losses did, they are the same bug and already fixed** by `quorum-shared`
b24058e. If they land somewhere else — or if spaces lose nothing at all — that
is a genuinely new datapoint.

### Tooling: the receiver side already works, the sender side does not

Checked against the code on 2026-07-31:

| piece                                                          | spaces?               | note                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop DM doctor (`/dev/dm-doctor`) landed/missing/duplicates | YES — **works as-is** | `scanSequence` matches **every row in the whole `messages` store** by text pattern (`^\s*<prefix>\s*(\d+)\s*$`) with **no DM/space filter**, and records whatever `spaceId` it finds. A space message `"V 7"` matches identically |
| `[WS-life]` OPEN / CLOSE / ERROR                               | YES                   | transport-level, already captures space traffic                                                                                                                                                                                   |
| `[WS-frame] sent`                                              | YES                   | fires for `log-append` too — it is in the shared drain loop                                                                                                                                                                       |
| mobile burst button                                            | NO — **DM-only**      | space messages must be typed by hand                                                                                                                                                                                              |
| `[DM-send row]` / `[DM-send wire]`                             | NO                    | DM-specific probes; no per-message send record for spaces                                                                                                                                                                         |

Two DM-only behaviours carry over harmlessly: the doctor's `misfiled` flag
(`spaceId === ownAddress`) simply reads false for spaces, and its
ghost-conversation section filters `type === 'direct'` so it reports nothing.

**Useful asymmetry:** a space message is **one** `log-append` frame, not a
6-target fan-out like a DM. So one send = one `[WS-frame] sent`, which is far
easier to pick out of a capture than the DM case was.

### The round, ~20 minutes

Follow `quorum-desktop/.agents/tasks/transport/runbook.md` — its
rules all apply. The deltas for spaces:

1. `git debug` in quorum-mobile (must print `RIG ARMED`), then
   `node .agents/scripts/patch-rn-ws-retain.mjs` **only if** you want the fix
   active. ⚠️ **Run one round WITHOUT it first** — an unpatched control is what
   tells you whether spaces lose anything at all. That control is the point.
2. Start `capture-xptrace.bat`, reload the app so the armed markers land inside
   the capture, then validate:
   `node ../quorum-desktop/.agents/scripts/validate-capture.mjs <capture.log>`
3. Type `V 1`…`V 20` into a **space channel** at a steady ~2 s pace. Pick a
   letter not already burned (X, Y, Z, P, Q, R, S, T, U are used for DMs).
4. Read the doctor on **both** desktops, immediately and again ~10 minutes later.

### Analysis

`join-losses-to-closes.mjs` needs a burst record it will not have. Join by
timing instead: each space send is a single `log-append` frame, so pair the
`[WS-frame] sent` timestamps against `[WS-life] CLOSE` events and check whether
the missing message numbers sit in the 1.4-3.5 s band.

Approximate rather than exact — good enough for "do spaces lose messages, and do
losses cluster before closes?", which is the question that matters. **If spaces
do lose messages and you want the exact join, extend the burst button to space
channels** (mobile, ~1 h) and every future spaces round becomes as rigorous as
the DM ones.

### Background a fresh agent needs

- `quorum-desktop/.agents/tasks/transport/index.md` — the map. Its §0
  has a ready-made briefing paragraph.
- `quorum-desktop/.agents/tasks/transport/measurements.md` § ROUND Q onward — how
  the DM mechanism was measured and the fix sized. The method transfers directly.
- `quorum-desktop/.agents/tasks/transport/2026-07-30-mobile-frames-lost-into-a-dying-websocket.md`
  — the root cause this report's premise now defers to.
- `quorum-mobile/.agents/docs/message-transport-architecture.md` — DMs and spaces.
- ⚠️ `quorum-mobile/.agents/` is **gitignored** (0 tracked files). Everything in
  this repo's `.agents/` exists only on the operator's machine.

Re-verified against the code 2026-07-26 (second pass): all code claims held; the
`WebSocketContext.tsx` line numbers had drifted ~50 lines and were corrected.
**This file shifts constantly — grep for the quoted code, not the line number.**

## Symptoms

None reported by users yet. This is a latent silent-failure path found by reading
the code, not a reproduction. If it fires, the symptom would be: **a space
message that appears to send normally on the author's device and never appears
for anyone else, with no error, no retry, and no way for the author to know.**

## Root Cause

### 1. Space messages ride the same transport as DMs

Space sends build a websocket frame, not an HTTP request:

- `services/space/spaceMessageService.ts:302`, `:494`, `:646`, `:1239` —
  `JSON.stringify({ type: 'log-append', ...sealedMessage })`
- `services/space/deviceKeyStatements.ts:88` — same, for device-key statements

These go out through the same `ws.send` the DM path uses
(`enqueueOutbound` → the shared client's `outboundQueue` → `ws.send`,
`quorum-shared/src/transport/rn-websocket.ts:336-357`). The DM investigation
measured that path silently losing 8 of 25 frames in one direction of one round
(DM doc §27.2), with every lost frame confirmed handed to the socket. **Spaces
has no structural protection against that** — it is the same socket, same node.
Note the client itself is robust _locally_: the `pendingEnvelopes` buffer
survives transient disconnects, consistent with the loss happening after
`ws.send` succeeds.

One extra client-side member of the same silent-loss family:
`enqueueOutbound` drops the whole send with only a debug-level log when
`wsClientRef.current` is null (`context/WebSocketContext.tsx:5513-5515`).
Rare — the ref exists once the first connect has happened — but it is a
pre-node loss that the same ack/echo watchdog would catch.

> **Trap for a fresh agent:** `quorumClient.ts:723` defines `postHub()`, an HTTP
> `POST /hub`, and `spaceMessageService.ts:13` documents "Send via postHub API
> endpoint". **Both are stale.** `postHub` has zero call sites in the repo; the
> HTTP design was replaced by the ws `log-append` path and the docstring was
> never updated. Reading either one first leads to the wrong conclusion that
> space writes are HTTP-acked. (Worth deleting/fixing as cleanup — see §4.)

### 2. The read side IS well protected — this is why Spaces feels reliable

The hub log is **sequenced**, and the client keeps a per-hub cursor
(`services/space/hubLogCursor.ts` — `getHubLastSeq` / `setHubLastSeq` /
`clearHubCursor`). The ingest path advances that cursor only across strictly
contiguous sequence numbers (`context/WebSocketContext.tsx:5284-5286`
as of 2026-07-26):

```js
if (seq <= advance) continue;
if (seq === advance + 1) advance = seq;
else break; // gap — stop and let next log-since refetch
```

A gap stops the cursor, and the next `log-since` refetches from there. So a
message that **was written but not delivered** is recovered automatically. DMs
have nothing equivalent; they rely on node redelivery plus bounded retries,
which is exactly where DM frames were observed dying. **Do not "fix" this part.**

### 3. The write side has an ack, and the client throws it away — THE BUG

The protocol already provides a write acknowledgement, declared at
`context/WebSocketContext.tsx:145`:

```ts
| { type: 'log-append-ack'; hub_address: string; seq: number; ts: number; request_id?: string }
```

It is routed correctly (`:5333-5348`) and then dropped on the floor
(`context/WebSocketContext.tsx:5878-5881`):

```js
} else if (frame.type === 'log-append-ack') {
  // Our own write succeeded — cursor will advance via the log-update
  // broadcast; nothing to do here for now.
}
```

Nothing tracks whether an ack ever arrives. A `log-append` that the node
silently discards produces **no ack, no error, no retry, and no user-visible
signal** — the identical failure shape to the DM black hole, except here the
signal that would catch it is already being delivered and ignored.

Compounding it: **`log-append` never sets a `request_id` — and in fact nothing
does.** `buildLogSinceFrame` (`services/space/hubLogSync.ts:68`) _supports_ a
`requestId` parameter, but none of its three callers pass one
(`requestLogSince` in `WebSocketContext.tsx`, `hubLogSync.ts:100`,
`messageRecovery.ts:49`). No frame in the entire app has ever carried a
`request_id`, so the node's echo behavior is completely unexercised — the
`request_id?` on the ack type may be aspirational typing, not a tested server
feature. There is currently no way to correlate an ack back to a specific
append.

### 4. Desktop is worse

Desktop has no hub log yet (per LaMat, 2026-07-26). That means desktop Spaces have
**neither** layer: no replay to recover undelivered messages, and no ack to
detect dropped writes. Silent permanent loss there is the same class as the DM
bug, with none of the mobile mitigations. **Any Spaces reliability work should
probably start on desktop, not mobile.**

## Solution

Not yet implemented. Ordered by value.

### Fix 1 (the actual bug) — use the ack

This is much cheaper for Spaces than the equivalent DM mitigation (DM doc §26.1
resend-with-dedupe), because for DMs there is no ack to wait on at all, whereas
here it already exists:

1. Set a `request_id` on outgoing `log-append` frames. **Caution:** the ack
   type declares the field, but no frame in the app has ever actually sent one
   (see §3), so node echo support is completely untested — **verify the node
   echoes it back before building on it**.
2. Keep a small in-flight map `request_id -> {spaceId, channelId, payload, sentAt}`.
3. On `log-append-ack`, clear the entry (and optionally record `seq`).
4. On timeout with no ack, resend once or twice, then surface a real send
   failure in the UI instead of a message that looks sent. The UI plumbing
   already exists: messages carry `sendStatus`/`sendError` fields (stripped
   before wire at `spaceMessageService.ts:274-276`). Today
   `useSendSpaceMessage` stamps `sendStatus: 'sent'` fire-and-forget — the
   mutation resolves the moment the envelope is queued, before it reaches the
   socket, and `onError` fires only if encryption throws, never on transport
   loss. So `'sent'` currently means "queued"; the failure-surfacing work is
   wiring, not new UI design.

Resend safety: a duplicate append is not harmful, though the mechanism is
subtler than "dedupe by fingerprint". The sender skips its own echoes via the
sent-envelope fingerprint set (`spaceMessageService.ts:58-89`); a receiver
re-processing an identical TR envelope will most likely FAIL decryption
(message key already consumed) rather than dedupe — but hub-log entries are
poison-exempt, failed decrypts are skipped, and the cursor still advances, so
the net effect is the same: no duplicate shown, nothing wedged.

**If the node does NOT echo `request_id`,** fall back to correlating on
`(hub_address, ts)`, counting outstanding appends per hub — or skip the ack
entirely and use Fix 1b, which needs no correlation at all.

### Fix 1b (alternative or complement, no protocol dependency) — self-echo watchdog

The sender is subscribed to its own hub (`listen-hub`), so a successful write
comes back to it as a hub-log entry — and the client ALREADY tracks sent
envelope fingerprints specifically to recognize those echoes:
`trackSentEnvelope` / `wasEnvelopeSentBySelf` / `removeSentEnvelope`
(`services/space/spaceMessageService.ts:58-89`; the fingerprint is deleted when
the echo is processed, and the notification classifier shares the set via
`sent_envelope_fingerprints`, `native-provider.ts:1259`).

That is ~90% of an end-to-end delivery detector: **a fingerprint still in the
set N seconds after send means the write never made the log.** Compared to the
ack approach it needs no `request_id`, no node-side support questions, and it
verifies the full write → log → broadcast round trip rather than just node
receipt. Caveats: the set is in-memory (lost on app restart) and capped at 100
entries, and echo latency depends on the log-update broadcast — use a generous
timeout. Recommended shape: ack (if `request_id` proves out) as the fast-path
signal, echo-watchdog as the source of truth.

### Fix 2 (cheap cleanup, prevents the next wrong diagnosis)

Delete `postHub()` (`services/api/quorumClient.ts:723`, zero call sites) and fix
the stale flow docstring at `services/space/spaceMessageService.ts:9-14` to
describe the `log-append` websocket path. This trap cost time during this very
analysis.

Sweep the other stale `postHub` mentions too: `spaceMessageService.ts:184`
("Sends it via the postHub API") and `native-provider.ts:733` / `:1357` (hub
sealed message docs referencing the postHub API). **Leave `postHubAdd` /
`postHubDelete` alone** — those are different, live functions.

### Fix 3 (measurement, if you want the impact number)

The DM diag rig already instruments the exact transport Spaces uses. A Spaces
round needs no new transport work — `[WS-frame]` on the `diag/dm-frame-trace`
branch already logs every `ws.send` (get onto it with `git debug`, which also
re-applies the node_modules transport patch that emits `[WS-frame]`). What is missing is a
space-side twin of `[DM-send wire]`/`[DM-recv wire]` keyed on the hub log `seq`.
**Before building it, read DM doc §27.1** — the DM rig produced a confident,
wrong, 20-frame loss claim because it instrumented only one of two receive
paths. Check every path a space message can take before trusting absence of a
log line.

## §5. Open question — does the Triple Ratchet have a late-join fork?

Spaces use a **Triple Ratchet with shared per-space state**
(`services/space/spaceMessageService.ts:11`), not the per-pair Double Ratchet
DMs use. Issue #183 item 1 is a Double Ratchet receiver whose first processed
frame sits at chain position > 0 forking permanently at the next DH turn.

**Whether the Triple Ratchet fails the same way is untested.** It matters more
here than for DMs: joining a space mid-stream is the _normal_ case, not an edge
case, so if the analogous defect exists it would fire constantly rather than
needing establishment-phase frame loss as a trigger.

This is cheap to answer and needs **no device time**. The DM fork was proven with
an offline harness driving the SDK wasm crate directly — see the repro script
inlined in issue #183, and `.agents/scripts/dr-advanced-start-fork.mjs` /
`dr-core-harness.mjs` in this repo. The same approach pointed at the Triple
Ratchet entry points would settle it in an afternoon. **Recommended as the next
Spaces task** — highest information per unit of effort, and it is the one thing
that could make this report much more serious than it currently looks.

## Prevention

- **An acknowledgement you don't check is not an acknowledgement.** The protocol
  designer did the hard part; the client discarded it with a "nothing to do here
  for now" comment. When a transport offers a delivery signal, wiring it to
  nothing should be treated as a missing feature, not a neutral default.
- **Stale docstrings actively cause wrong diagnoses.** The `postHub` comment
  would have led any reader to conclude space writes were HTTP-acked and
  therefore safe. When a transport is swapped, the module header is part of the
  change.
- **Do not assume a sibling feature inherits a sibling's protections.** Spaces
  looked safer than DMs because its _read_ path is genuinely better engineered.
  The write path is not, and the two were easy to conflate.

_Last updated: 2026-07-31_
