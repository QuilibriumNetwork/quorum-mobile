---
type: task
title: "Receipt truthfulness: a read ack must never invent a delivery"
status: done
created: 2026-07-26
priority: high
effort: medium — pure-logic change in shared + 2 wiring sites per platform; no wire-format change
area: DM receipts (delivery + read) — shared/src/receipts + desktop MessageDB + mobile WebSocketContext/messagesDb
repo: quorum-shared (logic) + quorum-desktop (wiring) + quorum-mobile (wiring)
related:
  - "issues/.done/2026-07-24-dm-false-receipt-ticks-on-undelivered-message.md (the observed symptom — this task root-causes hypotheses 2 & 4)"
  - "issues/.done/2026-07-24-mobile-dm-delivery-receipt-messageid-mismatch.md (HARD PREREQUISITE on mobile — see §3)"
  - "issues/.archived/2026-07-24-transport-reliability-START-HERE.md (the losses this fix makes visible)"
  - "issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md"
---

# Receipt truthfulness — a read ack must never invent a delivery

## TL;DR

Read acks use a **high-water mark** ("I read up to timestamp Y"). The sender expands
that into "every message of mine at or below Y was **read AND delivered**". Messages
that never landed on the recipient sit in that range too, so they get stamped ✓✓.

**Fix:** delivery is the single source of truth. `readAt` may only be set on a message
that already carries a genuine `deliveredAt`. A read ack advances a watermark; it never
manufactures a delivery.

**Result:** a lost message shows *nothing* while its neighbours show ✓✓ — a visible gap
that surfaces transport loss instead of hiding it.

---

## 1. The bug

Ten messages in a conversation. #4 and #7 never land on the recipient (dead ratchet,
dropped frame, whatever the transport work is chasing). The recipient never renders them,
so its read-observer never fires for them — it does not even know they exist.

The recipient reads #10 and sends **one** ack: `upToTimestamp = createdDate(#10)`.

The sender then sweeps every own message with `createdDate <= upToTimestamp` and stamps
`readAt` **and** `deliveredAt` on all of them. #4 and #7 light up ✓✓.

The recipient can never contradict this — the false claim is manufactured entirely on the
**sender** side by the timestamp expansion. This is why the bug survives regardless of how
well the recipient behaves.

### The four code sites (identical logic, duplicated per platform)

| Layer | Desktop | Mobile |
|---|---|---|
| React Query cache | `src/components/context/MessageDB.tsx:1173` — `deliveredAt: msg.deliveredAt \|\| now` | `context/WebSocketContext.tsx:5616` — `deliveredAt: m.deliveredAt \|\| now` |
| Persistence | `src/db/messages.ts:499-504` (IndexedDB cursor) | `services/storage/messagesDb.ts:649-651` (SQLite scan) |

Shared's `ReceiptService` is **not** at fault — it only buffers the HWM and fires
`onReadAckProcessed(upToMessageId, upToTimestamp, conversationAddress)`
(`shared/src/receipts/service.ts:96-98`). The faulty sweep lives in each platform's
consumer of that callback.

### Delivery acks are already honest

Delivery acks carry the actual **set** of received message IDs, so a lost message never
enters that set and never earns a real `deliveredAt`. The read-ack backfill is the *only*
thing that fabricates delivery. Remove it and delivery becomes fully truthful; read
becomes truthful by being made subordinate to it.

---

## 2. This root-causes an existing open bug

`issues/.done/2026-07-24-dm-false-receipt-ticks-on-undelivered-message.md` recorded the live
symptom (mobile → desktop, message never landed, sender showed delivered+read) and listed
four hypotheses. **Hypotheses 2 and 4 are now confirmed as a code-level defect** —
"a per-conversation last-read watermark applied to any newer message rather than
per-message acks" is literally what the four sites above do.

Hypotheses 1 (optimistic local ticks) and 3 (multi-device confusion) can be de-prioritised:
mobile already guards self-echoed acks (`raw.senderId !== self`,
`WebSocketContext.tsx:581-598`), and ticks are only written from an ack path.

---

## 3. HARD PREREQUISITE on mobile — do not ship this first

`issues/.done/2026-07-24-mobile-dm-delivery-receipt-messageid-mismatch.md` documents that mobile
mints the outgoing `messageId` **twice**, so the stored copy and the wire copy disagree.
Consequence recorded there: **mobile → desktop delivery receipts (✓) never appear, while
read receipts (✓✓) work in both directions.**

That is the same root cause seen from the other side: `deliveredAt` never matches, so on
mobile → desktop the *only* thing setting `deliveredAt` today is the read-ack backfill.

**Therefore:** if this truthfulness fix ships on mobile before the messageId mismatch is
fixed, mobile → desktop receipts disappear entirely — no ✓ (mismatch) and no longer any
✓✓ (now gated on a `deliveredAt` that never arrives). Technically honest, but it will read
as "receipts broke".

> **Order on mobile: fix the messageId mismatch first, verify ✓ appears mobile → desktop,
> then ship this.** On desktop and shared there is no such dependency.

### Prerequisite status (checked 2026-07-27): code landed, runtime confirmation still owed

The mismatch **is fixed in code**, in `aaa0b79` ("fix: honest, resilient DM/space send",
PR #175) — not as a deliberate closure of that task, which is why its file still reads
`status: open`. `hooks/chat/useSendDirectMessage.ts` now mints `nonce` / `messageId` /
`createdDate` **once** in `onMutate` and writes them onto the shared `variables` object
(`variables._nonce = nonce` etc., ~450-454); `mutationFn` reads them through its
`_nonce ?? …` / `_messageId ?  … : …` fallbacks (~251-262). Stored id == wire id, which is
exactly the fix that task specifies.

**What is NOT confirmed is the runtime half** — nobody has watched ✓ actually appear
mobile → desktop on two physical devices. So the prerequisite is satisfied *structurally*
but not *observationally*, and that is the one thing that would make this change read as
"receipts broke" rather than "receipts got honest".

**Consequence for shipping order:** implementing and reviewing this on mobile is safe now.
The two-device check in §9 must confirm ✓ mobile → desktop **before** this is treated as
verified, because that single observation covers both the prerequisite and this fix.
`issues/.done/2026-07-24-mobile-dm-delivery-receipt-messageid-mismatch.md` should be closed off
the same test run.

---

## 4. What this fix does NOT cover

The 2026-07-24 observation may have a second, independent mechanism:

- **(A) HWM expansion** — confirmed above. This fix kills it completely.
- **(B) Receiver decrypted but failed to persist/display.** If the recipient decrypts a
  message (so it genuinely sends a delivery ack) but a downstream bug drops it before it
  reaches the UI, the tick is *honest about decryption* and wrong about arrival. This fix
  cannot cure that — the ack is real.

(B) belongs to the transport/persistence stream, not here. State this in the PR: the fix
closes the fabrication path, and if false ticks survive it, that is proof of (B) and a
useful narrowing rather than a failed fix.

---

## 5. Design

### The invariant

> A message may be marked **read** only if it was already confirmed **delivered**.
> A read signal never creates a delivery.

### The ordering trap (why the one-line fix is wrong)

Read debounce is **5s**, delivery debounce is **10s** (`shared/src/receipts/service.ts:18-19`).
When someone reads without replying, the read ack reliably reaches the sender **before**
the delivery acks for those same messages.

So simply deleting the `|| now` backfill and gating on `deliveredAt` breaks the common
case: at read-ack time nothing has `deliveredAt` yet → nothing is marked → the delivery
acks then arrive and set ✓ → but `readAt` was never applied, so messages get stuck at ✓
and never upgrade. Read receipts would silently stop working for anyone who reads without
replying.

The fix must be **order-independent**: whichever ack lands second completes the upgrade.

### The watermark, derived from data we already store

No new schema. Reading a message *proves* it was delivered, so the HWM message itself
(`upToMessageId`) can be stamped safely. That makes the watermark recoverable as
**"the createdDate of the newest own message that has `readAt`"** — survives restart,
needs no new column or store. Cache it in memory per conversation to avoid rescans.

**On read-ack `(upToMessageId, upToTimestamp)`:**
1. Validate `upToTimestamp` — reject unless `0 < ts <= now + 60_000` (clock skew). Without
   this, a peer sending `Number.MAX_SAFE_INTEGER` marks the sender's entire outbound
   history read. Flagged in the 2026-03-24 expert panel, never fixed.
2. Stamp `readAt` + `deliveredAt` on the message whose id is `upToMessageId` (proof by
   reading). This is the **only** place a read ack may write `deliveredAt`.
3. Advance the conversation watermark to `upToTimestamp`.
4. For own messages with `createdDate <= upToTimestamp` **and** an existing `deliveredAt`
   **and** no `readAt`: set `readAt`.
5. Never touch messages lacking `deliveredAt`.

**On delivery-ack `(messageIds)`:**
1. Set `deliveredAt` as today.
2. **New:** if the message's `createdDate <= watermark`, also set `readAt` — this is the
   late half of an upgrade whose read ack already arrived.

A lost message satisfies neither condition and correctly stays blank.

### Considered and rejected

- **Recipient sends the full set of read message IDs** (mirroring delivery acks). Fully
  correct and conceptually simplest, but it is a wire-format change, drops the O(1) ack
  property, and needs old/new peer compat. Keep as a possible future simplification.
- **Recipient-side flush ordering / bundling** (flush delivery whenever flushing read, so
  delivery info always arrives first). Needs a wire change to be atomic, and still leans on
  transport ordering, which the ratchet does not guarantee. The sender-side watermark is
  order-independent by construction.

---

## 6. Implementation plan

Sequencing per the user's instruction and the Atlas wiring rules: desktop → shared is a
**symlink** (instant), mobile → shared is a **pinned npm version** (needs a publish), so
mobile gets a local copy now and swaps to the shared import after publish.

### Step 1 — `quorum-shared`: the decision logic — ✅ DONE (2026-07-26)

Shipped in **PR #66**, squash-merged as `f55b363` on master. Version bumped to
**`2.1.0-37`** (`4db4860`, committed straight to master per the bump convention — bumps
touch `package.json` only, never the lockfile, which is stale at `2.1.0-16` by design).

`dist` rebuilt locally, so **desktop already sees it through the symlink** (verified:
desktop resolves `2.1.0-37` and the new symbols + `reconcile.d.ts`). **Not yet published to
npm**, so mobile still cannot import it — that is what step 4 waits on.

`src/receipts/reconcile.ts`, exported from `src/receipts/index.ts` (and so from the package
root, which already does `export * from './receipts'`).

**API as shipped** — all pure, storage-agnostic, no React:

```ts
const READ_ACK_MAX_CLOCK_SKEW_MS = 60_000;

type ReceiptMessageView = {          // structural, not the full Message, so an
  messageId: string;                 // IndexedDB record or a parsed SQLite
  createdDate: number;               // payload both satisfy it
  deliveredAt?: number;
  readAt?: number;
};
type ReceiptPatch = { deliveredAt?: number; readAt?: number };  // only what changes

isReadAckTimestampValid(upToTimestamp: number, now: number): boolean
resolveReadAckPatch(msg, { upToMessageId, upToTimestamp, now }): ReceiptPatch | null
resolveDeliveryAckPatch(msg, { readWatermark, now }): ReceiptPatch | null
deriveReadWatermark(messages: readonly ReceiptMessageView[]): number   // 0 when none
advanceReadWatermark(current: number, upToTimestamp: number): number   // monotonic
```

Both resolvers are **per-message** (not batch), so a cache `.map()` and a storage cursor
loop can share them. `null` means "nothing to write" — callers skip the row.

Note `resolveDeliveryAckPatch` takes the watermark **for that message's own conversation**.
The delivery-ack callback signature (`onAckProcessed(messageIds)`) does not carry the
conversation, but the caller always has the message row, whose `spaceId`/`channelId` is the
partner address — look the watermark up from there. This is why the shared callback
signature did **not** need to change.

**Verification:** 63 tests pass (25 pre-existing + 38 new), `npm run build` exit 0,
declarations at `dist/receipts/reconcile.d.ts`, symbols present in `index.js`, `index.mjs`
and `index.native.js` (the bundle mobile consumes). `npm run lint` could not run — eslint
is not installed locally; pre-existing, unrelated.

### Step 2 — `quorum-desktop`: wire to shared — ✅ SHIPPED (2026-07-26)

**PR #258**, squash-merged as `2a94ba881` on main. Branch deleted, local main in sync.

> ⚠️ **Merged before the two-device runtime check** — the local dev environment was
> unstable at the time (unrelated: see the ws-proxy note at the end of this file). Static
> verification was thorough (see below), but the runtime behaviour is still unconfirmed.
> Run the three checks in §9 when the dev env is healthy; revert `2a94ba881` if #2 fails.

- `src/components/context/MessageDB.tsx` — `onReadAckProcessed` and `onAckProcessed` now
  call the shared resolvers instead of sweeping inline. Added `readWatermarksRef`
  (`Map<conversationAddress, number>`) right above the `receiptService` useMemo.
- `src/db/messages.ts` — `updateMessagesReadAt` gained an `upToMessageId` param and applies
  `resolveReadAckPatch`; `updateMessageDeliveredAt` gained an optional
  `readWatermarks: ReadonlyMap<string, number>` and applies `resolveDeliveryAckPatch`.
  Each has exactly one caller, both updated.

**Watermark is in-memory only, deliberately.** It exists to bridge the ~5s gap between a
read ack and the delivery acks it outran. A restart mid-window costs at most a few ✓✓,
which the next read ack restores. That avoids a schema change entirely — `deriveReadWatermark`
is available in shared if hydrating on startup ever proves worthwhile.

**Incidental fixes carried in the same commit** (all in the code being rewritten anyway):
- The delivery-ack cache sweep ran once *per messageId* across every conversation; now once
  per conversation with a `Set` lookup.
- Both sweeps shared one `changed` flag across pages, so every page after the first was
  rebuilt needlessly. Now a per-page `pageChanged`, matching mobile's version.
- `updateMessageDeliveredAt`'s rejection was unhandled (flagged in the 2026-03-24 panel).

**Verification done:**
- `npx tsc --noEmit` → exit 0, zero errors
- `npx vitest --run` → **520 passed / 34 files** (was 508/33; +12 new)
- `yarn build` → exit 0
- New `src/dev/tests/db/receiptReconciliation.test.ts` (12 tests) — **proved to catch the
  bug**: temporarily restoring the old logic fails exactly the 4 bug-specific tests
  (undelivered stays blank; the 10-message #4/#7 scenario; read-ack-first convergence;
  lost message blank in both orders), and they pass with the fix.

**Still owed — two-device smoke test** (shipped without it; cannot be automated, needs a
real peer):
1. Normal conversation still reaches ✓✓ in both directions.
2. Read *without replying* still upgrades to ✓✓ — **the highest-risk check.** This is the
   ordering trap: if the watermark wiring is wrong, receipts stall at ✓ and never upgrade.
3. Force a loss (break the session / drop a frame): the lost message stays blank while its
   neighbours show ✓✓.

---

### Dev-env note (unrelated to this task, do not conflate)

While testing this, the desktop dev server logged repeated
`[vite] ws proxy error: write ECONNABORTED`. **Investigated and ruled out as a cause or
consequence of this work:**

- `src/components/context/WebsocketProvider.tsx` (the WS client) last changed `dde4e09d1`,
  **2026-01-04** — it has no keepalive/ping and no `onerror` handler, and has not for ~7 months.
- The `/quorum-ws` proxy that emits the log line was *introduced* by `b15868f52`
  (2026-06-24, #214). The parent commit has **zero** proxy config, so before late June a WS
  drop produced no server-side log at all. The disconnect is old; only the logging is new.
- Mechanism: upstream frames arriving from `api.quorummessenger.com` while the browser's
  socket is already gone. Dev-only — prod and Electron bypass the proxy entirely.

Likely root cause: no client keepalive + an upstream idle timeout. Worth its own task
(add a WS heartbeat + `onerror`), deliberately NOT folded into the receipt work.

### Step 3 — `quorum-mobile`: wire to shared — ✅ SHIPPED (2026-07-27)

**PR #188**, squash-merged as `6c3b395` on master. Branch deleted, local master in sync.

> ⚠️ **Merged before the two-device runtime check**, same as desktop. Static and unit
> verification was thorough (below) and the new tests are proven to fail against the old
> logic, but runtime behaviour on real devices is still unconfirmed. Run the four checks in
> §9; revert `6c3b395` if check 2 (read without replying) fails.

**Steps 3 and 4 collapsed into one.** Shared `2.1.0-37` was already published and
installed by the time mobile came up (`package.json` pin and `node_modules` both at
`2.1.0-37`, `dist/receipts/reconcile.d.ts` present, symbols confirmed in
`dist/index.native.js` — the bundle mobile actually consumes). So the local-copy step was
skipped entirely: mobile imports the resolvers from the package directly, exactly like
desktop. No `services/receipts/reconcile.ts` was ever created, so there is nothing to
delete later and no window in which the platforms could drift.

- `context/WebSocketContext.tsx` — `onAckProcessed` and `onReadAckProcessed` now call the
  shared resolvers instead of sweeping inline. Added `readWatermarksRef`
  (`Map<conversationAddress, number>`) next to `receiptServiceRef`.
- `services/storage/messagesDb.ts` — `updateMessagesReadAt` gained an `upToMessageId`
  param and applies `resolveReadAckPatch`; `updateMessageDeliveredAt` gained an optional
  `readWatermarks: ReadonlyMap<string, number>` and applies `resolveDeliveryAckPatch`.
  Each has exactly one caller, both updated.

**Watermark is in-memory only**, matching desktop and for the same reason (see Step 2).

**The §6 divergence was settled**, as that section required: `isReceiptEnabled` now nests
read under delivery (`kind === 'delivery' ? delivery : delivery && resolve('readReceipts')`)
instead of reading the two flags independently. The settings sheet already hid the read
toggle when delivery was off; the service layer now enforces it too, so a stale
`readReceipts: true, deliveryReceipts: false` override can't produce permanently blank
receipts.

**Incidental fix carried in the same commit:** the delivery-ack cache sweep used
`setQueriesData`, which never exposes the query key, so it could not tell which
conversation a cache belonged to. Switched to `getQueriesData` + per-key `setQueryData`
(desktop's shape) — required for the per-conversation watermark lookup.

**Verification done:**
- `npx tsc --noEmit` → 21 errors, **byte-identical to the pre-change baseline** (all
  pre-existing, in unrelated files: calling/, farcaster, explore.tsx). Zero new.
- `npx jest` → **108 passed / 13 suites** (was 87/11; +21 new)
- `npx eslint` on the two production files → 36 warnings, 0 errors, **identical count
  before and after**. The two new test files add 2 `no-require-imports` warnings, both
  unavoidable (jest hoists mock factories above imports; `jest.resetModules()` needs a
  dynamic re-require). Repo-wide lint is 301 errors / 260 warnings, all pre-existing.
- `__tests__/receiptReconciliation.test.ts` (12 tests) — behavioural, against the **real
  SQL**: `expo-sqlite` is mocked onto node's built-in `node:sqlite`, so the WHERE clause
  and ownership filter are exercised, not just the resolver call. A direct port of
  desktop's suite, so both platforms assert the same behaviour.
  **Proved to catch the bug**: restoring the old logic fails exactly 5 tests (undelivered
  stays blank; the 10-message #4/#7 scenario; the watermark completing a late delivery;
  read-ack-first convergence; lost message blank in both orders) and all 12 pass with the
  fix. Desktop's equivalent caught 4 — mobile catches a fifth because its old delivery-ack
  path also lacked the watermark upgrade.
- `__tests__/receiptWiring.test.ts` (9 tests) — static assertions over the
  WebSocketContext callbacks, the same technique `dmSelfEchoGuards.test.ts` already uses
  for this file (the callbacks live in a `useEffect` inside a ~6000-line provider wired to
  the websocket, MMKV, SQLite and native crypto; there is no harness that can drive an ack
  through them). Guards the mobile-specific risk — the wiring, not the logic: no
  `deliveredAt || now` backfill, timestamp validated before any write, watermark recorded,
  resolvers used instead of an inline sweep, `upToMessageId` threaded to persistence, and
  the read-under-delivery nesting. **All 9 fail against the pre-change file and all 9 pass
  after**, checked by restoring `HEAD:context/WebSocketContext.tsx` and re-running.

**Still owed — two-device smoke test.** Same three checks as desktop (§9). Cannot be
automated; needs a real peer.

### Note: a real divergence to settle in step 3

Desktop forces `effectiveReadReceipts = effectiveDeliveryReceipts && ...`
(`DirectMessage.tsx:194`), so read is structurally impossible without delivery.
Mobile's `isReceiptEnabled` (`WebSocketContext.tsx:562-564`) reads the two flags
**independently** — the nesting is only enforced in the UI (`ProfileModal.tsx:4282`).

This fix makes delivery **load-bearing** for read, so mobile should adopt desktop's
enforcement at the service layer, not just in the UI. Otherwise a stale
`readReceipts: true, deliveryReceipts: false` conversation override yields permanently
blank receipts with no explanation.

---

## 7. Transport impact (the "do receipts bloat the network?" question)

### The fix itself is transport-neutral

Zero wire-format change, zero extra acks, zero extra bytes. It only changes how the sender
*interprets* acks it already receives. Whatever the receipt traffic costs today, it costs
exactly the same after.

### What receipts actually cost today

A standalone ack is a full DM through the Double Ratchet: small payload (a couple hundred
bytes), but a real network publish plus a ratchet advance (1 write to `encryption_states`
+ 1 to `latest_states` per side, overwrite in place — no row growth). Piggybacked acks are
free: they ride the encryption of a message already being sent.

The batching is what keeps this sane. Delivery acks batch an arbitrary number of message
IDs into one ack per 10s window; read acks are O(1) regardless of how many messages were
read.

| Pattern | Acks | Multiplier |
|---|---|---|
| Active back-and-forth (both replying) | almost all piggybacked | **~1.0x** — effectively free |
| One-sided burst (10 msgs, read, no reply) | 1 delivery + 1 read | **~1.2x** |
| Slow trickle (1 msg / 30s, read, no reply) | 1 delivery + 1 read *per message* | **~3.0x** |

> ⚠️ **CORRECTION (2026-07-27): this table describes DESKTOP. It is wrong for mobile.**
> The first row assumes acks piggyback on messages already being sent. **Mobile never
> piggybacks** — it consumes piggybacked acks on receive but never produces them
> (`flushForPiggyback` / `flushReadForPiggyback` are called nowhere in the mobile repo;
> desktop calls both in `MessageService.ts:528-542`). Mobile pays close to the standalone
> cost in every row, including active conversations.
>
> Worse, the 10s delivery flush is a **debounce** (`resetDeliveryTimer` clears the existing
> timer on every inbound message, `receipts/service.ts:140-154`), so it fires 10s after the
> *last* message, not the first. Piggybacking is desktop's escape valve from its own
> debounce; mobile has none, so mobile's receipt latency is worst exactly when a
> conversation is busiest.
>
> Not a correctness issue and not caused by this fix — a missing half of the original port.
> Tracked in `issues/.done/2026-07-27-mobile-piggyback-receipt-acks-on-outgoing-dms.md`.
> Re-derive this table per platform once that lands.

**The reassuring part: the multiplier is worst exactly where the absolute volume is
lowest.** 3x of a trickle is still a trickle. The pathological case is a conversation
sending two messages a minute — tripling that is negligible. The high-volume cases are
precisely the ones batching and piggybacking collapse to ~1x.

For scale, typing indicators throttle at 5s (`shared/src/typing/service.ts:26`) and fire
while someone is *typing*, i.e. repeatedly before a single message exists. In an active
conversation typing indicators cost more than receipts do.

So: real overhead, bounded, already mitigated by the batching design, and comparable to
what every mainstream messenger pays for the same feature. Not a problem worth redesigning
around.

### One genuine new sensitivity

The fix makes delivery acks load-bearing. Today a read ack alone could produce ✓✓; after
the fix, a **permanently lost delivery ack** means a message that really was delivered and
read shows blank or ✓ instead of ✓✓. Mitigations: the Action Queue retries standalone acks
(`maxRetries = 3`, `ActionQueueService.ts:43`), and the HWM-message rule (§5 step 2)
self-heals the newest message in every read ack. The residual failure direction is
**under-claiming**, which is the safe one — far better than asserting delivery that never
happened.

> ⚠️ **CORRECTION (2026-07-27): the Action Queue mitigation is DESKTOP-ONLY.**
> Mobile does not route acks through an action queue — `sendDmReceiptAck` in
> `WebSocketContext.tsx` sends directly and swallows any failure into a
> `logger.debug('[DM-receipts] ack send failed', err)`. **No retry, no surfacing.**
> So on mobile a dropped ack is simply gone, and under this fix that leaves a genuinely
> delivered-and-read message stuck below ✓✓ indefinitely. The HWM self-heal still applies
> (it is platform-independent), so the newest message in each read ack recovers, but the
> back-fill for older ones does not.
>
> This raises the value of ack retry on mobile from "nice to have" to "the thing standing
> between a lost ack and a permanently wrong tick". Worth its own task; folded into the
> considerations in `issues/.done/2026-07-27-mobile-piggyback-receipt-acks-on-outgoing-dms.md` §5,
> which faces the same drain-into-a-send-that-may-not-land problem.

---

## 8. Follow-ups (deliberately NOT in this task)

- **Combined ack to halve the trickle case.** If the read flush also drained the delivery
  buffer into a single ack message, the 3.0x worst case drops to ~2.0x and delivery info
  would arrive atomically with read info. Additive wire change; keep it separate so the
  correctness fix stays wire-neutral and ships fast on both platforms.
  → Now specified for review in
  `quorum-desktop/.agents/tasks/2026-07-27-combined-receipt-ack-and-protocol-options.md`,
  which also covers the two deeper options below. **Note it found a mixed-version hazard**
  (an old peer silently discards the delivery half after the sender already drained its
  buffer), which may reduce this to an ordering fix with no traffic benefit.
- **Mobile piggybacking (NEW, 2026-07-27).** Mobile never attaches acks to outgoing DMs, so
  it pays standalone cost in every conversation pattern and has no escape from the 10s
  debounce. Mobile-only, no shared change, no wire change — plausibly a bigger win than the
  combined ack, and it shrinks the combined ack's value for mobile.
  → `issues/.done/2026-07-27-mobile-piggyback-receipt-acks-on-outgoing-dms.md`
- **UI affordance for an unconfirmed message** ("not delivered — retry"). This fix makes
  the gap *visible*; it does not yet make it *actionable*.
- **Per-conversation sequence numbers.** The deeper problem is that a recipient cannot
  detect a gap — it has no idea a missing message ever existed. A monotonic per-conversation
  counter would let it say "I have 1,2,3,5 — 4 is missing", enabling real retransmission
  instead of just honest silence. Big protocol change, belongs to the transport stream, but
  it is the only thing that would *repair* losses rather than merely stop lying about them.

---

## 9. Verification

- [x] Shared unit tests green (63 passed); `npm run build` exit 0. — 2026-07-26
- [x] Desktop: tsc exit 0, 520 tests pass, `yarn build` exit 0. — 2026-07-26
- [x] Desktop: new tests proven to fail against the old logic (4 bug-specific ones). — 2026-07-26
- [x] Mobile: tsc identical to baseline (21 pre-existing, 0 new), 108 tests pass,
      lint unchanged on production files. — 2026-07-27
- [x] Mobile: new tests proven to fail against the old logic (5 storage-layer,
      9 wiring). — 2026-07-27
- [x] Mobile: §3 messageId prerequisite confirmed landed in code (`aaa0b79`). — 2026-07-27
- [ ] Two-device: normal conversation still reaches ✓✓ both directions (no regression).
- [ ] Two-device: read without replying still upgrades to ✓✓ (the ordering trap).
- [ ] Forced loss: break the session / drop a frame, confirm the lost message stays blank
      while neighbours show ✓✓.
- [ ] Mobile: confirm ✓ appears mobile → desktop (the runtime half of the §3
      prerequisite — closes the messageId-mismatch task too).
- [ ] Restart with a pending read ack: watermark still derived correctly from persisted
      `readAt`.

---

*Last updated: 2026-07-27*
