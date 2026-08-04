---
type: task
title: "DM per-conversation delivery + read receipt toggles (blocked on the #9 mobile receipt pipeline)"
status: done
created: 2026-06-25
source: extracted from #35 (2026-06-17-dm-conversation-settings-parity.md), "Delivery + read receipt toggles"
priority: medium
effort: small UI wire-up once #9 exists; no shared work
pairs-with: "#9 (mobile receipt pipeline)"
---

# DM per-conversation receipt toggles

Extracted 2026-06-25 from the retired DM-settings-parity umbrella. Desktop's
`ConversationSettingsModal` exposes per-conversation **Delivery receipts** and
**Read receipts** overrides (each falls back to the global `UserConfig` value
when unset). Mobile should match — but only once the receipt pipeline exists.

## Why it's blocked

Per-conversation receipt overrides only make sense once the **mobile receipt
pipeline (#9)** exists. There is nothing meaningful to toggle until messages
actually carry/emit delivery + read receipts on mobile.

**Shared is NOT the blocker.** All receipt machinery — wire types, a RN-safe
`ReceiptService`, and the per-message / per-conversation / per-config fields
(`deliveryReceipts`, `readReceipts`) — already shipped in published shared
`2.1.0-31` (see memory `dm-receipts-shared-done-in-31`). #9 is pure mobile
wiring. Do not add placeholder receipt UI before #9 lands.

> **#9 now has a dedicated task:** `2026-07-19-dm-receipt-pipeline-and-global-toggles.md`
> (pipeline + global settings toggles). This per-conversation-override task
> unblocks once that lands. The "READ FIRST" notes below are folded into it with
> refreshed line anchors.

## ⚠️ READ FIRST when building #9 (the mobile receipt pipeline)

**Incoming `delivery-ack` / `read-ack` messages are CURRENTLY BEING DROPPED on
mobile** by a guard added 2026-06-28 (PR #145, `context/WebSocketContext.tsx`).
You must REMOVE/REPLACE that guard with a real receipt interceptor, or your
pipeline will never receive acks and you'll waste time debugging "receipts don't
arrive."

Why the guard exists: desktop sends `delivery-ack`/`read-ack` every 5–10s; these
are **flat objects** — `type` is TOP-LEVEL (`{senderId, type:'delivery-ack',
messageIds}`), **no `content` wrapper, no `channelId`** — and fan out to the
user's own devices incl. the phone. Mobile had no receipt handling, so each ack
fell through and created a phantom `selfAddress/selfAddress` conversation row
(own pfp/name, "No messages yet"). The #145 guard drops any **channel-less
self-echo** in all three DM receive branches (init-envelope, JS subsequent-msg,
batch — search `isSelfSyncEcho` / `authenticatedDmSender === user?.address`).

What #9 must do instead:
- Add a receipt interceptor **before** the channel-less-self-echo drop, checking
  the TOP-LEVEL type: `raw.type === 'delivery-ack' || raw.type === 'read-ack'`
  (NOT `raw.content?.type` — that reads `undefined` for these flat objects; this
  is the exact bug that caused the phantom row). Process the ack (update
  `deliveredAt`/`readAt`), then `continue`/`return` so it isn't saved.
- Keep the channel-less-self-echo drop as the BACKSTOP for any *other* unhandled
  channel-less control message — it stays correct after receipts are wired.
- Mirror desktop's `interceptControlMessages` (`quorum-desktop` `MessageService.ts`
  ~386-474), which reads `raw.type` and handles both ack types + piggybacked
  `ackMessageIds` / `readAckUpTo` envelope fields.

Full root-cause writeup: `.agents/issues/.open/2026-06-26-dm-self-profile-overwrites-partner-row.md`
and memory `dm-phantom-self-row-is-unhandled-receipts`.

## What to do (AFTER #9)

1. Add **Delivery receipts** and **Read receipts** rows to `DMSettingsSheet.tsx`,
   driven by the conversation's `deliveryReceipts` / `readReceipts` (undefined =
   inherit the global `UserConfig` value, matching desktop's fallback).
2. Persist via the `updateConversationSetting` helper already in
   `app/(tabs)/messages/dm/[id].tsx` (added 2026-06-25 for edit-history): patch
   `{ deliveryReceipts }` / `{ readReceipts }` onto the stored conversation,
   invalidate the detail + list queries.
3. Mirror desktop: removing the override (back to "inherit global") should clear
   the key rather than store a value.
4. Verify the pipeline honors the per-conversation override (suppresses/sends
   receipts for that conversation per the toggle, independent of the global
   default).

## ⚠️ Receipt INDICATOR positioning (decided 2026-07-15 — for #9, not the toggles)

When #9 renders the delivery/read receipt on a message row, the visual placement
was decided during the grouped-indicators work (shipped in mobile PR #149):

- **Render receipts INLINE, hugging the last word of the message** (WhatsApp-style),
  NOT in the row-below indicator group that #149 introduced for
  `(edited)`/unsigned/spinner.
- **Why different from the other indicators:** receipts (✓ delivered / ✓✓ read)
  appear on EVERY one of your own DM messages. A row-below would fire on nearly
  every continuation row — including one-word messages — stacking
  `word / ✓✓ / word / ✓✓` and defeating message grouping. The other indicators are
  occasional, so row-below is fine; receipts are omnipresent, so they must be inline.
- **How:** use a **checkmark font glyph** (`✓` U+2713 / `✓✓`), which is text and
  flows inline natively. This sidesteps the RN limitation that blocks SVG icons
  (`IconSymbol`) from flowing inside a `<Text>` — the reason `#149`'s icon indicators
  had to go row-below. Plain checkmark glyphs are far safer than `⚠` (no aggressive
  emoji-presentation default), but still CONFIRM the tinted monochrome render on both
  test devices (Motorola Edge 50 + Samsung A40) before trusting it.
- **Gate like desktop:** own messages only, DMs only (not channels).
- **Desktop reference:** `receiptIndicator` in `quorum-desktop`
  `src/components/message/Message.tsx` ~1084 (two `check` Icons for read, one for
  delivered).
- Full context: `.agents/issues/.done/2026-07-15-grouped-message-indicators-mobile-plan.md`
  (Follow-ups section).

## Source

`quorum-desktop/.agents/tasks/port-to-mobile/candidates.md` row 35.

*Last updated: 2026-07-15 — added the receipt-indicator positioning decision (inline checkmark glyph, not row-below) settled during the grouped-indicators work (PR #149); this governs #9's rendering, not the toggles themselves.*
