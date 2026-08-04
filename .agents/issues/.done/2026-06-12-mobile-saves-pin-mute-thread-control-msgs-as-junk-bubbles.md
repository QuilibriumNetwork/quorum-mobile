---
type: bug
title: "Mobile saves pin / mute / thread control messages as junk timeline bubbles on receipt"
status: done
created: 2026-06-12
fixed: 2026-06-12
fix-commit: "2212339 (branch fix/drop-unhandled-control-messages)"
severity: medium
repo: quorum-mobile
desktop-reference: quorum-desktop/src/services/MessageService.ts
index: ../reports/2026-06-12-permission-and-message-parity-findings-index.md
---

# Mobile saves pin / mute / thread control messages as junk timeline bubbles

> **✅ FIXED 2026-06-12 (commit `2212339`).** The junk-bubble bug is resolved: mobile now drops `pin`/`mute`/`thread` control messages on both receive paths instead of saving them as posts. **Actually receiving + applying these (pin-sync, mute-sync, threads) remains future feature work** — see "Deferred feature work" at the bottom.

> Found during the 2026-06-12 message-type-inventory pass (see the [findings index](../reports/2026-06-12-permission-and-message-parity-findings-index.md), item §5). Verified against current source.

## Symptom

When a **desktop** user pins a message, mutes a user, or creates/closes a thread in a space, **mobile** users in that space get a **garbage message bubble** in the channel timeline instead of the intended effect. The pin/mute/thread action itself never happens on mobile.

## Root cause

Mobile's `context/WebSocketContext.tsx` space-message receive switch has explicit handlers for `reaction`, `remove-reaction`, `edit-message`, `remove-message`, `update-profile`, and the call/join/leave/kick control flows — but **no handler for `pin`, `mute`, or `thread`**. Any unhandled content type falls through to the generic "Regular message" path and is written via `storage.saveMessage(...)` as if it were a normal post. Mobile's render layer defaults unknown content types to `post`, so the control message renders as a chat bubble.

This affects **both** receive paths: the live handler and the batch hub-log handler (each has its own copy of the type switch).

## Affected types + desktop reference behavior

| Type | What desktop does on receipt | What mobile does (bug) |
|---|---|---|
| `pin` (`PinMessage`) | Marks/unmarks the target message as pinned (with `message:pin` role validation). Desktop: `MessageService.ts` ~`pin` branch (~line 1172). | Saves the pin control message as a chat bubble. Target message never gets pinned. |
| `mute` (`MuteMessage`) | Applies/removes a space mute on the target user (with `user:mute` role validation on receipt). Desktop: ~line 1830. | Saves the mute control message as a chat bubble. Mute never applied. (Also = the cross-platform-mute gap: mobile never applies desktop mutes — see findings index §6.) |
| `thread` (`ThreadMessage`) | Creates/updates/closes thread metadata via `threadService.handleThreadReceive()`. Desktop: ~line 1251. | Saves the thread control message as a chat bubble. Thread metadata never updated. |

(Mobile does not currently SEND any of these three, so the bug only manifests for messages originating on desktop. But mobile must handle them on receipt regardless, since spaces are mixed desktop+mobile.)

## Severity

**Medium.** User-visible (junk bubbles appear whenever a desktop user pins/mutes/threads), but no data loss and no access-control hole. It's a correctness/polish gap, not a security issue.

## Fix options (per type)

- **`pin`:** add a receive handler that updates the target message's pinned state in mobile's pin store (mobile keeps pins in MMKV — `usePinnedMessages.ts`). Validate sender `message:pin` role on receipt (no owner bypass), same pattern as the delete + read-only fixes already shipped. At minimum, even before full pin-sync, mobile should **not** render the pin control as a bubble — drop it if it can't be applied.
- **`mute`:** this is the cross-platform mute feature-port (findings index §6). Add a receive handler: validate sender `user:mute` role, apply to a (new) received-mutes store, drop muted users' messages. Larger. At minimum, drop the bubble.
- **`thread`:** mobile has no thread feature at all (candidates.md row 3 — biggest single gap). Full thread support is a large feature-port. **Minimum viable fix now: drop `thread` control messages on receipt so they don't render as bubbles**, deferring real thread support.

## What was done (the fix)

The **minimal fix** above was implemented (commit `2212339`): explicit `pin`/`mute`/`thread` branches were added to BOTH receive switches (live + batch) in `context/WebSocketContext.tsx` that consume-and-drop the control message before it reaches `storage.saveMessage`. Junk bubbles are gone.

**Why pure-drop and not apply-to-store (even for pin, where mobile has a local pin store):** applying a received pin would require receive-side `message:pin` role validation (or it re-creates the "anyone can pin anything" hole, same class as the delete bug) AND a design decision about reconciling mobile's existing *local* pins (keyed `pinnedBy: <local user>`) with incoming *synced* pins. That is feature work, not a bugfix — so it's deferred (below).

## Verification

- ✅ Static: tsc (no new errors) + lint (0 errors).
- ⏳ Runtime (needs a 2nd client): pin/mute/thread on desktop in a shared space → mobile shows NO junk bubble. Low-risk: the change only drops 3 control types that were previously mis-saved; normal messages are untouched.

## Deferred feature work (NOT done here — log as future features)

These are the actual capabilities, separate from the bug:

1. **Pin-sync** — receive desktop's `pin`/unpin broadcasts, validate sender `message:pin` role, apply to mobile's pin store, reflect in UI. Design call: reconcile local vs synced pins; decide whether mobile's local pins should broadcast.
2. **Mute-sync** — the cross-platform mute feature-port (findings index §6): receive desktop's `mute`/unmute, validate sender `user:mute` role, apply, drop muted users' messages. Plus the personal-hide-vs-broadcast-moderation reconciliation already noted.
3. **Threads** — entire feature absent on mobile (candidates.md row 3, biggest single gap). Long-deferred per lead-dev expectation.

---

*Last updated: 2026-06-12*
