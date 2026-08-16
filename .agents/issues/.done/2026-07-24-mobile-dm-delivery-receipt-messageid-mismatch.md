---
type: task
title: "Fix mobile DM delivery receipts: outgoing messageId differs between stored and wire copy"
status: done
created: 2026-07-24
updated: 2026-08-16
priority: medium
effort: small — single-file fix in useSendDirectMessage.ts, verify with two-device test
symptom: delivery receipts (✓) never appear for messages sent mobile → desktop; read receipts (✓✓) work both ways; desktop → mobile delivery works
area: hooks/chat/useSendDirectMessage.ts
---

# Mobile DM delivery receipts broken — outgoing messageId mismatch

## Status

**2026-08-16 — closed after being flagged for verification; the check may never
have happened.** The 2026-07-27 recap listed this as ready-but-verify-scope-first,
on the grounds that PRs #171, #172 and #181 might already cover it. It has since
been marked `status: done` and moved to `.done/`. Whether that closure followed
the verification or simply overtook it is recorded nowhere. If delivery receipts
misbehave again, start by re-opening this.

_Carried over from `RECAP.md`'s 2026-07-27 audit, which flagged this file as
possibly stale. Recorded here so the caveat travels with the issue instead of
living only in a dashboard that has to be regenerated to be believed._


## Symptom (observed)

- Message sent **mobile → desktop**: sender (mobile) **never** sees a delivery
  receipt (✓).
- Message sent **desktop → mobile**: delivery receipt works.
- **Read** receipts (✓✓) work in **both** directions.
- Receipt settings are ON on all devices/accounts, so this is NOT a config issue.

## Root cause

Mobile generates the outgoing DM `messageId` **twice, independently**, so the
copy it stores locally has a different `messageId` than the copy that actually
goes on the wire to the recipient.

In `hooks/chat/useSendDirectMessage.ts`:

- **`onMutate`** (optimistic / stored path) mints its own random `nonce` →
  `messageId` **M1** (~line 339-347). This is what gets saved to SQLite and kept
  in the React Query cache.
- **`mutationFn`** (wire path) mints a **separate** random `nonce` → `messageId`
  **M2** (~line 160-171). This is the copy that is encrypted and sent to the
  recipient.
- `mutationFn` already supports pre-generated `_messageId` / `_nonce` /
  `_createdDate` params ("Use pre-generated values from onMutate, or generate new
  ones", ~line 159), but the wiring is **half-done**: `onMutate` does not read
  those params and never feeds its generated values into `mutationFn`. React
  Query hands `mutationFn` only the original variables, not `onMutate`'s locals,
  so the two paths never share a value.
- **`onSuccess`** (~line 464-478) then deliberately KEEPS the optimistic id and
  discards the wire id. Its own comment admits it:
  `// The returned message has a different ID than the optimistic one`
  `// Use the optimistic message ID but update the status.`

Net effect: mobile permanently stores its sent message under **M1**, while the
recipient received **M2**.

## Why this produces exactly the observed symptom

Delivery acks match by **messageId**; read acks match by **timestamp**
(high-water mark). That single difference explains everything:

| Direction | Mechanism | Result |
|---|---|---|
| mobile → desktop delivery | Desktop receives wire msg **M2**, buffers M2, sends `delivery-ack {messageIds:[M2]}`. Mobile `onAckProcessed` patches where `ids.has(m.messageId)` → searches M2, stored is **M1** → no match | ❌ no ✓ |
| desktop → mobile delivery | Desktop's stored id == wire id (single generation, MessageService.ts ~2706-2725), mobile echoes it, desktop matches | ✅ |
| read receipts, either way | Matched by `m.createdDate <= upToTimestamp`. Mobile's stored `createdDate` (from onMutate) ≤ wire `createdDate`, so the high-water mark still covers it | ✅ |

Read receipts were masking the bug: when the recipient reads, the read-ack
backfills `deliveredAt` and jumps straight to ✓✓, so the missing bare ✓ went
unnoticed.

## Reference: desktop does it correctly

Desktop generates `nonce` + `messageId` **once** and uses the same `message`
object for both optimistic display and the wire payload
(`src/services/MessageService.ts` ~line 2706-2725). Stored id == wire id. Mobile
must do the same.

## Fix

Generate `nonce` / `messageId` / `createdDate` **once** and use identical values
for the stored optimistic message and the wire message.

Recommended approach:

1. Generate the three values in the **caller** (or in `onMutate`, writing them
   onto the shared `variables` object — `onMutate` runs before `mutationFn`, so
   `mutationFn`'s `_nonce ?? …` fallback will pick them up).
2. Pass them as `_messageId` / `_nonce` / `_createdDate` so `mutationFn` reuses
   them instead of minting fresh.
3. Update `onMutate` to READ those params rather than generating its own, so the
   optimistic/stored message carries the same id as the wire message.
4. `onSuccess` can then stop treating the returned id as "different" — the
   optimistic id IS the wire id.

Prefer the caller-generates-once pattern (cleanest, avoids relying on
`onMutate` → `mutationFn` ordering via a mutated variables object).

## Fix status (checked 2026-07-27)

**The code fix is in**, landed incidentally in `aaa0b79` (#175) rather than as a
deliberate closure of this task, which is why the status field was stale.
`hooks/chat/useSendDirectMessage.ts` now follows the recommended approach almost
exactly:

- `onMutate` generates `nonce` / `createdDate` / `messageId` **once** and writes
  them back onto the shared `variables` object (`variables._nonce = nonce`,
  `variables._messageId = messageId`, `variables._createdDate = createdDate`,
  ~lines 447-454).
- `mutationFn` picks them up through its existing fallbacks
  (`_nonce ?? …`, `_createdDate ?? …`, and `_messageId ? {…} : generateMessageIdHash(…)`,
  ~lines 250-262).

Stored id == wire id. Note it uses the `onMutate`-writes-to-`variables` variant
rather than the "caller generates once" variant this task preferred; that relies
on `onMutate` running before `mutationFn`, which React Query guarantees.

**What is still missing is the runtime observation** — nobody has watched ✓
actually appear mobile → desktop on two physical devices. Do NOT close this task
until that is seen.

That check is also step 4 of the verification list in
`issues/.done/2026-07-26-receipt-truthfulness-delivery-gated-reads.md`, which is gated on
it for a real reason: before this fix the read-ack backfill was the only thing
setting `deliveredAt` mobile → desktop, and that task removes the backfill. One
two-device session closes both.

## Verification (needs two physical devices)

1. mobile → desktop, recipient sits idle on a Space (DM closed). Wait ~15s for
   the standalone 10s delivery-ack timer. **Expect ✓** on the mobile sender.
2. Confirm ✓ then upgrades to ✓✓ when the desktop opens and reads the DM.
3. Regression: desktop → mobile delivery still works; read receipts still work
   both ways.

## Related

- `.agents/issues/.done/2026-07-19-dm-receipt-pipeline-and-global-toggles.md` — mobile
  receipt pipeline (this bug lives downstream of it).
- Desktop feature doc: `quorum-desktop/.agents/docs/features/messages/dm-receipts.md`.

---
*Last updated: 2026-07-27*
