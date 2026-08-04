---
type: task
title: "Grouped/continuation messages drop per-message indicators (desktop + mobile)"
status: done
created: 2026-06-28
---

# Grouped/continuation messages drop per-message indicators (desktop + mobile)

**Status:** open
**Created:** 2026-06-28
**Scope:** cross-repo — quorum-desktop AND quorum-mobile

## Problem

When messages are grouped (consecutive messages from the same sender collapse the
repeated avatar + username + timestamp into compact continuation rows), several
**per-message** indicators are hidden on the continuation rows because the whole
header block is hidden when compact. These indicators belong to the individual
message, not the header, so they should still show on grouped rows.

Reference for correct behaviour: **Discord** — grouped/continuation messages keep
the `(edited)` marker (and other per-message indicators) inline next to the text,
even though the avatar/name/time header is collapsed.

## Affected indicators (currently dropped on compact rows)

- `(edited)` marker — confirmed should show per Discord reference.
- Unsigned-message warning icon — trust/security signal; should not be silently
  dropped on grouped rows.
- Pinned icon.
- Sending spinner (`isSending`) — minor; in-flight on a rapid 2nd message.

## Both platforms are likely buggy

- **Mobile:** continuation rows hide the entire `messageHeader` View
  (`components/Chat/MessagesList.tsx`, the three avatar-bearing renderers —
  post/embed/sticker), which contains `(edited)`, pinned, unsigned-warning, and
  the sending spinner.
- **Desktop:** the compact branch in `src/components/message/Message.tsx`
  (header row, ~lines 895–1084) also hides these. Needs the same audit/fix.
  (Desktop keeps an unsigned-warning icon in the compact branch but drops the
  rest — verify exactly what it keeps vs drops before fixing.)

## Fix direction

Move the per-message indicators out of the header-only branch so they render on
compact rows too — either inline next to the message text (Discord-style) or in
a consistent slot. Keep avatar + username + timestamp collapsed (that's the point
of grouping); only the per-message signals should survive.

## Not in scope

The consecutive-message-grouping feature itself (mobile branch
`feat/consecutive-message-grouping`) ships separately; it intentionally matches
the *current* desktop compact behaviour. This task fixes the indicator gap on
*both* platforms afterward.

*Last updated: 2026-06-28*
