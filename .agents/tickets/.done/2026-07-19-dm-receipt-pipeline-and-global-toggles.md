---
type: task
title: "DM delivery + read receipts (#9): mobile pipeline + global settings toggles"
status: done
created: 2026-07-19
source: quorum-desktop/.agents/tasks/port-to-mobile/candidates.md row #9 (feature-port, HIGH)
priority: high
effort: medium (pure mobile wiring, no shared work)
unblocks: 2026-06-25-dm-receipt-toggles.md (per-conversation overrides)
pairs-with: none (typing indicators #7/#16 are a SEPARATE feature — do not conflate)
---

# DM delivery + read receipts — mobile wiring (#9)

## Status

SHIPPED in PR #164 (merged 2026-07-20), with the receipt delivery path completed in #170 (validated live: receipts render, session churn ended) and the inline UI in #171-#174. Status corrected 2026-07-28; the previous "pending device test (not merged)" predated the merge and was stale.


Port desktop's DM delivery/read receipts to mobile. When you send a DM, you see
✓ once the partner's device confirms delivery and ✓✓ once they've read it —
WhatsApp-style. Gated by a global privacy setting (send receipts at all) and,
later, per-conversation overrides (separate blocked task).

## Scope of THIS task

1. **The receipt pipeline** — emit + consume `delivery-ack` / `read-ack`, render
   the inline checkmarks on your own DM messages.
2. **Global settings toggles** — `UserConfig.deliveryReceipts` / `readReceipts`
   in the mobile Settings screen (the "send receipts at all" master switch).

**Out of scope (tracked elsewhere):**

- **Per-conversation override toggles** → existing `2026-06-25-dm-receipt-toggles.md`,
  currently BLOCKED on this task. Landing #9 unblocks it. Do NOT build the
  per-conversation UI here.
- **Typing indicators (#7) and their toggles (#16)** — a different feature
  (`typingIndicatorsDM` / `typingIndicatorsSpaces`). Not part of #9.

## Shared: nothing to do — verified 2026-07-19 against pinned `2.1.0-34`

Mobile pins `@quilibrium/quorum-shared@2.1.0-34`, which already ships everything:

| Piece                                                                          | Location in shared                                                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ReceiptService` (buffer, piggyback, 10s delivery / 5s read timers, flush-all) | `receipts/service.d.ts` — platform-agnostic, RN-safe (DOM listener guarded by `typeof document`; caller wires the foreground signal) |
| Ack wire types                                                                 | `DeliveryAckMessage`, `ReadAckMessage`, `ReceiptControlMessage`, `ReceiptEnvelopeFields` (`types/receipt.d.ts`)                      |
| Per-message fields                                                             | `message.deliveredAt?` / `readAt?` (`types/message.d.ts:267,269`)                                                                    |
| Envelope piggyback fields                                                      | `ackMessageIds?`, `readAckUpTo?` (`types/receipt.d.ts:43,45`)                                                                        |
| Global config toggles                                                          | `UserConfig.deliveryReceipts?` / `readReceipts?` — **typed** (no `as any`)                                                           |
| Per-conversation overrides                                                     | `Conversation.deliveryReceipts?` / `readReceipts?`                                                                                   |

Passes the atlas additive gut-check trivially: **no shared change → no publish,
no version coordination.** Pure mobile wiring. Mobile does not import
`ReceiptService` anywhere yet (grep-confirmed 2026-07-19).

## ⚠️ READ FIRST — receipts are currently dropped as channel-less self-echoes

`delivery-ack` / `read-ack` are **flat objects**: `type` is TOP-LEVEL
(`{ senderId, type: 'delivery-ack', messageIds }`) — **no `content` wrapper, no
`channelId`** — and they fan out to your own devices, incl. the phone.

They arrive looking like a **channel-less self-echo** (`senderAddress === self`,
no `channelId`) and are dropped today by two guards (one per DM receive branch):

- [context/WebSocketContext.tsx:2490](../../context/WebSocketContext.tsx#L2490) — JS / init-envelope branch (`isSelfSyncEcho`, channel-less → drop to avoid a phantom `selfAddress/selfAddress` row).
- [context/WebSocketContext.tsx:4017](../../context/WebSocketContext.tsx#L4017) — batch branch (same logic).

> Note: the `content.type` default-deny guard (~2928 / ~4363) does NOT fire on
> receipts — flat receipts have no `content.type`. Its comments even say so. The
> thing that drops receipts today is the **self-echo** guard above, not that one.
> (This supersedes the older "PR #145 guard" note in `2026-06-25-dm-receipt-toggles.md`,
> whose line anchors have since drifted.)

**What #9 must do:** add a receipt interceptor **BEFORE** the self-echo drop in
BOTH branches, checking the TOP-LEVEL type (`raw.type === 'delivery-ack' ||
raw.type === 'read-ack'` — NOT `raw.content?.type`, which is `undefined` and is
the exact bug that once created the phantom self-row). Process the ack, then
`return` so it isn't saved. Keep the self-echo drop as the BACKSTOP for any other
channel-less self-echo.

**Desktop reference:** `interceptControlMessages` in `quorum-desktop`
`src/services/MessageService.ts` (reads `raw.type`, handles both ack types +
piggybacked `ackMessageIds` / `readAckUpTo` envelope fields). Follow it.

## Phases (each ends in something LaMat can observe on a device)

### Phase 1 — Delivery receipts end-to-end (✓)

- Instantiate one `ReceiptService` (in `WebSocketContext`), wiring its callbacks
  to mobile's encrypted-send + React Query cache + storage:
  - `onFlush(address, messageIds)` → send a `delivery-ack` to that partner.
  - `onAckProcessed(messageIds)` → set `deliveredAt` on those messages (storage +
    query cache) so the ✓ renders.
- On decrypting an inbound DM, call `receiptService.onMessageReceived(partner, id)`
  (buffers a delivery ack). Respect the global `deliveredReceipts`… actually
  gate on nothing for delivery in Phase 1 unless desktop gates it — confirm
  against desktop before adding a gate.
- Add the receipt interceptor (see READ FIRST) so inbound `delivery-ack` reaches
  `receiptService.onAckReceived(messageIds)`.
- Wire a foreground-change signal to `flushAll()` on backgrounding (RN
  `AppState`, since the DOM `visibilitychange` listener is skipped on RN).
- **Render:** inline ✓ glyph hugging the last word of your own DM messages (see
  indicator-positioning decision below).
- **Observable:** send a DM phone→(other device); the ✓ appears once delivered.

### Phase 2 — Read receipts end-to-end (✓✓)

- On viewing a DM (message becomes visible / conversation opened), call
  `receiptService.onMessageRead(partner, id, ts)` — **but only if the global
  `readReceipts` setting is on** (the service docstring says the caller must
  check `readReceipts` BEFORE calling `onMessageRead`).
- `onReadFlush` → send a `read-ack` (`readAckUpTo` high-water mark).
- Interceptor routes inbound `read-ack` to `onReadAckReceived(upToId, upToTs,
partner)`; callback sets `readAt` on all your messages up to that mark.
- **Render:** ✓ → ✓✓ when read.
- **Observable:** the other device opens the DM; your ✓ flips to ✓✓.

### Phase 3 — Global settings toggles

- Add **"Send read receipts"** and **"Send delivery receipts"** switches to the
  mobile Settings screen ([app/settings.tsx](../../app/settings.tsx)), a Privacy
  section. Persist via `updateConfig(user.address, { readReceipts })` /
  `{ deliveryReceipts }` (pattern: `hooks/useUserConfig.ts` — same as `allowSync`).
- These fields are typed in shared `2.1.0-34`, so no `as any` cast.
- Confirm the send paths honor the setting: read-ack suppressed when
  `readReceipts` is off; match desktop's default for `deliveryReceipts`.
- **Observable:** toggle "Send read receipts" off → partner stops seeing ✓✓ on
  your messages; toggle on → they resume.

### After #9 lands

Unblock `2026-06-25-dm-receipt-toggles.md` (per-conversation overrides:
`undefined` = inherit the global value set in Phase 3).

## Receipt INDICATOR positioning (decided 2026-07-15, carried from #35's toggles task)

- Render receipts **INLINE, hugging the last word** (WhatsApp-style), NOT in the
  row-below indicator group that PR #149 introduced for `(edited)`/unsigned/spinner.
- **Why:** receipts appear on EVERY own DM message; a row-below would stack
  `word / ✓✓ / word / ✓✓` and defeat message grouping. The other indicators are
  occasional; receipts are omnipresent → inline.
- **How:** use a **checkmark font glyph** (`✓` U+2713 / `✓✓`) — text flows inline
  natively, sidestepping the RN limit that blocks `IconSymbol` SVGs inside `<Text>`.
  Confirm tinted monochrome render on BOTH test devices (Motorola Edge 50 +
  Samsung A40) — checkmark glyphs are safer than `⚠` but still verify no emoji
  presentation.
- **Gate like desktop:** own messages only, DMs only (not channels).
- **Desktop ref:** `receiptIndicator` in `src/components/message/Message.tsx` (~1084).

## Testing notes (transport is unreliable — see memory)

Desktop↔mobile DM delivery has been flaky for months (memory
`dm-cross-device-sync-unreliable-blocks-testing`). Prove the SEND side with a
temp post-guard log (device count) using `logger.log` (revert before PR), and
test the RECEIVE side desktop↔desktop if mobile receive won't cross. iOS is
review-only (Android-only tester) — do the iOS review pass (Switch styling,
inline glyph render) per the atlas rule.

## Source

`quorum-desktop/.agents/tasks/port-to-mobile/candidates.md` row #9. Shared
readiness re-verified 2026-07-19 against installed `2.1.0-34`.

_Last updated: 2026-07-19_
