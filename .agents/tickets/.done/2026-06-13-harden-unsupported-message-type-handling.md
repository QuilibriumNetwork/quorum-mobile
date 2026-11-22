---
type: task
title: Harden unsupported message-type handling (default-deny render + receive)
status: done
created: 2026-06-13
urgency: Tier 2 (silent correctness footgun, forward-looking)
shared_change: none
version_bump: none
runtime_test: required
---

# Harden unsupported message-type handling

## Problem

Mobile's protection against unrecognized message types is an **allowlist-by-omission**, which is fragile. Today there is exactly one explicit drop guard, covering three types:

```ts
// context/WebSocketContext.tsx:2043-2056 (live path)
// context/WebSocketContext.tsx:3285-3291 (batch path)
if (contentType === 'pin' || contentType === 'mute' || contentType === 'thread') {
  // delete inbox entry + return/continue  → dropped before storage.saveMessage()
}
```

Everything *not* in that list falls through to `storage.saveMessage()` unconditionally
(`WebSocketContext.tsx:2097` live, `:3320` batch). At render time the type mapper
defaults unknown types to `'post'`:

```ts
// components/Chat/types.ts:267-268
default:
  return 'post';
```

and `getMessageText` returns `''` for any type it doesn't recognize
(`components/Chat/types.ts:241`). So an unrecognized type that slips through becomes a
**phantom empty bubble**: sender name + timestamp + blank body. No crash, no data
corruption — but a visible junk row.

The mobile authors documented this risk themselves at `WebSocketContext.tsx:2036-2042`:
> "Without this they fall through to the generic save below and render as junk chat
> bubbles (the renderer defaults unknown types to 'post')."

**The footgun:** the next message type desktop ships (e.g. a future `poll`, `voice-note`,
or any of the 8 `call-*` signaling types if they ever reach a space feed) will produce
silent empty bubbles on mobile until someone remembers to add it to the guard. There is
**no catch-all**. Each new type must be hand-added, or it leaks.

Verified state (2026-06-13 cross-repo review): every CURRENT desktop type is safe — it is
either rendered, applied (reaction/edit/remove/update-profile), or explicitly dropped
(pin/mute/thread). This task is **forward-looking insurance**, not a fix for a live bug.

## Goal

Convert the fragile allowlist-by-omission into an explicit **default-deny**: a future
desktop message type can never silently produce a phantom bubble. It is dropped cleanly
on receive (and rendered as nothing / a graceful "unsupported" row) until mobile
deliberately adds support.

## The canonical type sets (from the 2026-06-13 cross-repo review, re-verified 2026-06-13)

The shared `MessageContent` union (`@quilibrium/quorum-shared` `src/types/message.ts:249-274`)
has **24 members** (re-counted against the dist on disk — an earlier draft said 25; the
`dm-update-profile` type at `message.ts:39` is defined but is NOT a member of the
`MessageContent` union). Mobile's handling buckets them as:

**RENDERED** (have an explicit render branch — must stay rendered):
`post`, `embed`, `sticker`, `join`, `leave`, `kick`, `event`, `call-event`,
`space-call-start`, `space-call-end`
(source: `getMessageRenderType` switch, `components/Chat/types.ts:247-269`)

**APPLIED, not bubble-rendered** (consumed in the receive path, mutate a target, then
return/continue — must NOT be dropped, must keep being applied):
`reaction`, `remove-reaction`, `edit-message`, `remove-message`, `update-profile`
(source: `WebSocketContext.tsx` live ~1688-2055, batch ~3098-3291)

**EXPLICITLY DROPPED** (no handler yet, deliberately discarded):
`pin`, `mute`, `thread`

**NOT EXPECTED on the space/DM message feed** (control/ephemeral — intercepted earlier or
never persisted): the `call-*` signaling types (`call-offer`/`answer`/`reject`/`hangup`/
`ice-candidate`/`renegotiate`) are intercepted in the DM path
(`WebSocketContext.tsx:2467` live, `:3463` batch — `content.type?.startsWith('call-') && type !== 'call-event'`),
and `dm-update-profile` is a DM-only type. NOTE: `delivery-ack`/`read-ack` live in a
SEPARATE wire union (`@quilibrium/quorum-shared` `src/types/receipt.ts`) and
`typing-start`/`typing-stop` in `src/types/typing.ts` — they are NOT members of
`MessageContent` and can never reach `getMessageRenderType` or the space-save path. They
need no default-deny handling; listed here only so the taxonomy is complete.

## Approach (default-deny)

### Receive side (`context/WebSocketContext.tsx`, BOTH the live ~1663 and batch ~3089 paths)

Replace the hardcoded `pin || mute || thread` drop with a default-deny check that runs
AFTER the applied-types handlers (reaction/edit/remove/update-profile) and AFTER the
read-only enforcement, but BEFORE `storage.saveMessage()`:

1. Define a single source-of-truth constant (e.g. in `components/Chat/types.ts` or a small
   shared-locally const file) listing the **persistable + renderable** types:
   `const PERSISTABLE_TYPES = new Set(['post','embed','sticker','join','leave','kick','event','call-event','space-call-start','space-call-end'])`.
2. Anything reaching the pre-save point whose `contentType` is NOT in `PERSISTABLE_TYPES`
   → drop it (delete the inbox entry as the current pin/mute/thread guard does, then
   `return`/`continue`). This subsumes the current `pin || mute || thread` guard AND any
   future unknown type in one rule.
3. Keep the applied-type handlers (reaction/remove-reaction/edit-message/remove-message/
   update-profile) exactly where they are and BEFORE this default-deny — they must still
   run and apply their mutations. Only types that fall past every explicit handler hit the
   default-deny.
4. Log dropped types at `debug` level with the type string, so a future "why didn't my
   new type show up on mobile" is one log line away (and so we can spot if desktop ships
   something mobile silently drops).

**IMPORTANT — keep the two paths in sync.** Live (return) and batch (continue) must apply
the identical rule. The single shared `PERSISTABLE_TYPES` set is what guarantees that;
don't inline two copies of the list.

### Render side (`components/Chat/types.ts`)

Make the fallback explicit instead of defaulting unknown → `'post'`:

- Add a dedicated `'unsupported'` member to the `MessageRenderType` union (`types.ts:13-22`),
  alongside the existing `'error'` member. The existing `'error'` type (for malformed /
  contentless messages, with `buildMessageErrorDetail` + a `renderErrorMessage` branch) is
  the precedent to mirror — `'unsupported'` is the same shape of problem, so follow that
  convention rather than inventing a new one.
- Change `getMessageRenderType`'s `default:` (`types.ts:267-268`) so a genuinely
  unrecognized type returns `'unsupported'` — NOT `'post'`. Map known-but-unrendered types
  (`reaction`/`pin`/etc., which shouldn't reach here anyway) and truly-unknown types to it.
- **Render `'unsupported'` as nothing by FILTERING, not by returning `null` from the row
  renderer.** The list is a `FlashList` (`MessagesList.tsx:1052` `renderItem`,
  `:1115` `getItemType={(item) => item.renderType}`). Returning `null` from `renderItem`
  for a row that still occupies a slot in `data` causes FlashList layout/measurement
  glitches (phantom gaps, recycler confusion). Instead filter `renderType === 'unsupported'`
  out at the single conversion point feeding the list:
  - `SpaceChatArea.tsx` — the `useMemo` that builds `out` already ends with
    `filterMutedMessages(out)` (`:291`). Add the unsupported filter there (e.g. chain it, or
    filter inside `filterMutedMessages`'s caller) — same established pattern.
  - `DMChatArea.tsx:165` — the `allMessages.map(toDisplayMessage)` is a plain map; append
    `.filter((m) => m.renderType !== 'unsupported')`.
  Both areas funnel through `toDisplayMessage` (`types.ts:315`), so the render type is set in
  exactly one place and filtered in exactly two — no third surface to keep in sync.
- (Optional future enhancement, NOT v1: instead of filtering, wire `'unsupported'` through
  the `renderItem` switch + `getItemType` to show a minimal greyed "Unsupported message —
  update the app to view" row, mirroring how `'error'` is wired. Bikeshed-prone; keep v1 as
  a silent filter to match the receive-side drop intent.)
- This is **belt-and-suspenders**: with the receive-side default-deny in place, no
  unsupported type should ever reach render. The render guard protects against a type that
  was persisted by an OLDER mobile build (before this fix) and is now being re-read from
  MMKV. Without it, those legacy-persisted junk rows would still show as empty `'post'`
  bubbles after the user updates.

## Acceptance criteria

- [ ] A synthetic message with an unknown `type` (e.g. `'poll'`) arriving on the live path
      is dropped, not saved (verify via storage inspection / log).
- [ ] Same on the batch/reconnect path.
- [ ] `pin`/`mute`/`thread` are still dropped (behavior unchanged — now via the default-deny
      rather than the explicit list).
- [ ] All RENDERED types still render correctly (post, embed, sticker, join/leave/kick,
      event, call-event, space-call-start/end). Smoke-test in a real space + DM.
- [ ] All APPLIED types still apply (react to a message, edit, delete, profile update —
      all from desktop → mobile). These must NOT regress to being dropped.
- [ ] A message persisted as junk by a pre-fix build no longer renders an empty bubble after
      update (render-side filter removes it — `renderType === 'unsupported'` is filtered out
      in both SpaceChatArea and DMChatArea before reaching the FlashList).
- [ ] Live and batch paths use the SAME `PERSISTABLE_TYPES` set (no divergence).
- [ ] No FlashList layout regression (the unsupported message is absent from the list, not a
      blank/zero-height row) — verify visually that no gap appears where it would have been.

## Notes

- No `@quilibrium/quorum-shared` change and no version bump — this is purely mobile receive +
  render logic. Mobile is on `2.1.0-26`; all relevant types are already in that dist.
- This task is the foundation that makes adding future types (pin-sync, mute parity, threads,
  polls) safe-by-default: a half-finished new type fails closed (dropped) instead of open
  (junk bubble).
- Related: the `2026-06-12-permission-enforcement-wave-0.md` task already touches the
  receive-path read-only enforcement right next to where this default-deny goes — if both are
  done together, coordinate the ordering of guards in `WebSocketContext.tsx` (applied-types →
  read-only enforcement → default-deny → save).

---
*Created: 2026-06-13*
*Last updated: 2026-06-13*
