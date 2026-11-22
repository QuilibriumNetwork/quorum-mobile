---
type: task
title: messagePreview returns empty for call-event / space-call types (inbox preview gap)
status: done
created: 2026-06-13
urgency: Tier 3 (cosmetic, pre-existing)
shared_change: none
version_bump: none
runtime_test: optional
---

# messagePreview missing call / space-call types

## Problem

`utils/messagePreview.ts` derives the one-line inbox preview from a message's content type via a
hardcoded `switch`. It handles `post`, `event`, `embed`, `sticker`, `reaction`, `join`, `leave`,
`kick`, `update-profile`, `remove-message` — and falls through to `default: return ''` for
everything else.

That `default: ''` is hit by three types that ARE persisted and DO render fine in the chat
timeline (they're in `PERSISTABLE_TYPES`):

- `call-event` (1-to-1 voice/video call summary)
- `space-call-start`
- `space-call-end`

So when the most recent message in a space (or DM) is a call event, the unified inbox row shows
an **empty preview** instead of something like "Voice call" / "Call ended".

This was surfaced by the 2026-06-13 code review as a "third parallel type list" — `messagePreview`
duplicates type knowledge that also lives in `getMessageRenderType` and `PERSISTABLE_TYPES`
(`components/Chat/types.ts`), and the three have drifted out of sync.

## Approach

Low-effort, self-contained:

1. Add `case 'call-event'`, `case 'space-call-start'`, `case 'space-call-end'` to the
   `messagePreview` switch (`utils/messagePreview.ts:23`). Reuse the same wording the chat
   renderer already uses in `getMessageText` (`components/Chat/types.ts` ~220-240): e.g.
   `Voice call` / `Video call` / `Call started` / `Call ended`. Consider matching the emoji-prefixed
   style already used for embed/sticker if the inbox shows emoji prefixes elsewhere (it does:
   `📷 Image`, `🎨 Sticker`) — but per the global "no emoji in production UI" rule, prefer plain
   text or a Lucide-style label if this surface is being de-emoji'd. Check the surrounding inbox UI
   for the prevailing convention before picking.

## Acceptance criteria

- [ ] An inbox row whose latest message is a `call-event` shows a non-empty, sensible preview.
- [ ] Same for `space-call-start` / `space-call-end`.
- [ ] Wording is consistent with what the chat timeline shows for the same message
      (`getMessageText`).

## Notes

- Pre-existing; unrelated to the default-deny change beyond having been noticed during its review.
- Optional deeper fix (bigger scope, not required): collapse the preview text and the chat-render
  text into one shared helper so there's a single source of truth for "how does type X read as a
  string". Out of scope unless someone is already refactoring this area.

---
*Created: 2026-06-13*
*Last updated: 2026-06-13*
