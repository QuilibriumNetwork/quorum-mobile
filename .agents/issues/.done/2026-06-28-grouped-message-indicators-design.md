---
type: task
title: "Design: per-message indicators on grouped (continuation) messages"
status: done
created: 2026-06-28
---

# Design: per-message indicators on grouped (continuation) messages

**Status:** design approved, ready for implementation plan
**Created:** 2026-06-28
**Scope:** cross-repo — quorum-desktop AND quorum-mobile
**Related (mobile):** [2026-06-28-grouped-message-indicators-missing.md](2026-06-28-grouped-message-indicators-missing.md) (the bug), and the shipped grouping feature (mobile PR #146)
**Related (desktop, canonical/team-visible):** `quorum-desktop/.agents/tasks/2026-06-28-grouped-message-indicators-design.md` (same design) and `quorum-desktop/.agents/tasks/2026-06-28-grouped-message-indicators-missing.md`

> The desktop copy is the canonical, committed, team-visible one. This mobile copy
> is local/gitignored. Keep the two in sync if the design changes.

## Problem

When messages are grouped (consecutive messages from the same sender collapse the
repeated avatar + username + timestamp into compact continuation rows), the entire
header is hidden — which silently drops the per-message indicators that live in it
(`(edited)`, pinned, bookmark, unsigned-warning). These describe the individual
message, not the header, so they must still be visible on continuation rows.

Reference for correct behaviour: **Discord** keeps `(edited)` (and similar
per-message indicators) on grouped messages.

Both platforms are buggy:
- **Desktop** (`src/components/message/Message.tsx`): the compact branch (~line 894)
  keeps ONLY the unsigned-warning inline; `(edited)`, pinned, bookmark are in the
  non-compact header branch and dropped on continuation rows.
- **Mobile** (`components/Chat/MessagesList.tsx`): continuation rows hide the whole
  `messageHeader` View (post/embed/sticker renderers), dropping `(edited)`, pinned,
  unsigned-warning, and the sending spinner.

## Core principle

**The header is unchanged.** First-in-group and standalone messages keep all
indicators in the header exactly as today — no visual regression to the common
case. We ONLY add indicators to continuation rows, which currently have nowhere to
show them.

## Indicator classification

The key distinction is **identity** vs **per-message**:

**Identity indicators** — describe the *user*, shown once per group (header only,
never repeated on continuation rows):
- Username, space tag, timestamp
- New-member / seedling icon (marks a new user — belongs next to the username)

**Per-message indicators** — describe *this individual message*; appear in the
header on first-in-group/standalone rows, and inline on continuation rows:
- `(edited)`
- unsigned-warning
- pinned
- bookmark
- DM receipt (check / check-check)

## Rules

1. **First-in-group + standalone messages** → unchanged. All indicators in the
   header as today.

2. **Continuation rows (grouped, headerless)** → per-message indicators render in a
   single **inline trailing group** at the end of the message text (after the last
   word, same line), following the existing DM-receipt placement pattern. They flow
   and wrap naturally with the text (no right-edge float).

3. **Trailing group order** (left → right):
   1. `(edited)`
   2. unsigned-warning
   3. pinned
   4. bookmark
   5. DM receipt (check / check-check) — always last

4. **Styling** → reuse existing header styles, relocated inline: `(edited)` as small
   muted text; icons at `xs` size with their existing muted/accent colours. No new
   style variant.

5. **Media continuation rows (embed / sticker)** → no "last word" to trail; render
   the trailing group in a small left-aligned inline row directly **below** the
   media, regardless of whether a caption is present.

## Worst-case crowding (verified)

- **Channel continuation:** `text (edited) ⚠ 📌 🔖` — no receipts in channels.
- **DM continuation:** `text (edited) ⚠ 🔖 ✓✓`.

Realistic max ~3–4 small trailing elements; wraps naturally when the line is full.
Manageable. (Unsigned-warning is rare; pinned+bookmark+edited simultaneously is
rare.)

## Scope & order

- **Two repos.** Fix desktop first (reference layout, higher-confidence repo), then
  mirror to mobile.
- **Mobile receipts caveat:** DM read/delivery receipts are not yet wired into
  mobile message rows (separate pending task). On mobile the trailing group
  initially covers `(edited)`/unsigned-warning/pinned/bookmark only; the receipt
  slots into position 5 when mobile DM-receipt wiring lands.
- **Mobile sending spinner:** currently also dropped on continuation rows. Minor;
  fold its restoration into the same change (it can sit in the trailing group or
  stay in its current spot — decide during implementation).

## Out of scope

The consecutive-message-grouping feature itself (already shipped on mobile in #146,
matching the then-current desktop compact behaviour). This task fixes the indicator
gap on both platforms.

*Last updated: 2026-06-28*
