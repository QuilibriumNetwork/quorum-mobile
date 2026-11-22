---
type: task
title: "Home feed: conversation relationships are not visually obvious (PFP connectors, deep-reply collapse, 3-post cap)"
status: open
priority: medium
ai_generated: true
created: 2026-08-21
updated: 2026-08-21
area: "Farcaster social feed / thread presentation"
---

# Home feed: conversation relationships are not visually obvious

## Summary

The chrono/reply-bumping feed makes it hard to see who is replying to whom
without reading usernames. Bounty spec ("Make Quorum Conversation Threads
Visually Obvious", poidh.xyz): presentation only, no behavior changes.

Concretely, in `components/SocialFeedModal.tsx` today:

1. A reply unit marks nesting with a flat accent `borderLeft` rail — there is
   no visual connection between the parent's PFP and the replier's PFP.
2. `ParentContextLine`'s mini parent preview shows the parent's text with **no
   avatar**, so the parent author's identity disappears from the row.
3. Only ONE ancestor level is ever fetched (`FeedReplyCard`'s single
   `useFarcasterCast`), so a deep reply shows just its immediate parent — the
   thread root is never visible, and there is no collapsed "..." context.
4. Self-reply chains (`collapseSelfChains`) render **uncapped**: a 12-cast
   chain renders 12 full cards in one feed unit.

## Acceptance (from the bounty, adapted to this codebase)

- PFPs visible on every representation of a cast (incl. the parent mini
  preview).
- Twitter/X-style vertical connector between the parent avatar and the reply
  avatar for stacked feed units; works for deep nesting.
- Deep replies render as `root … parent reply` with a tappable elision row;
  never more than 3 posts of one thread per feed unit.
- Ancestor hydration must have a HARD fetch ceiling (see
  `__tests__/threadDetailViewFetchBound.test.tsx` precedent) — bounded by
  construction and pinned by a test.
- Quote casts of replies keep rendering as plain quote cards (no dragged-in
  thread context) — regression-pinned.
- No changes to tap/navigation behavior.

## Resolution (this branch)

- `components/SocialFeed/threadUnit.ts` — pure unit composer
  (`buildThreadUnit`, cap = 3) + `collapseSelfChains` moved out of the modal
  so both are unit-testable without mounting `SocialFeedModal`.
- `hooks/useFeedThreadAncestors.ts` — fixed-slot (3) chained ancestor fetch;
  ceiling is structural, pinned by `__tests__/useFeedThreadAncestors.test.tsx`.
- `FeedPostCard` gains a `threadPosition` prop: thread-gutter layout with the
  avatar-to-avatar connector line; `ParentContextLine` mini preview gains the
  parent's avatar; new `components/SocialFeed/ThreadElisionRow.tsx`.
- Tests: `feedThreadUnit.test.ts`, `useFeedThreadAncestors.test.tsx`,
  `threadElisionRow.test.tsx`, `quoteCastOfReplyStaysPlain.test.tsx`.
