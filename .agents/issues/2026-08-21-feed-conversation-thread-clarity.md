---
type: task
title: "Make feed conversation threads visually obvious"
status: in-progress
created: 2026-08-21
updated: 2026-08-21
---

# Make feed conversation threads visually obvious

## Goal

Make the home feed communicate parent/reply relationships at a glance while
preserving the existing chronological/reply-bumping behavior and post-click
navigation.

## Current state

`SocialFeedModal` already promotes the immediate parent of a lone reply and
collapses self-reply chains found in the loaded feed. The current presentation
still has three important gaps:

- a self-reply chain can render far more than three casts;
- nested cards use a generic left rail rather than a connector between avatars;
- omitted ancestors have no explicit collapsed-context marker.

Quote cards already render independently of their quoted cast's ancestry and
must remain that way.

## Implementation

- Extract a pure, deterministic thread-preview selector.
- Limit a home-feed unit to three casts, preferring root, immediate parent, and
  focused/bumped reply.
- Insert a visual gap marker whenever intermediate ancestors are omitted.
- Draw reply connectors in the avatar column and interrupt them across a gap.
- Keep every displayed cast's avatar and existing click behavior.
- Preserve graceful single-card fallback when parent data cannot be resolved.
- Add focused tests for deep chains, missing context, branching, malformed
  parent graphs, and quote-card isolation.

## Acceptance checks

- Original casts render unchanged.
- Direct replies render parent then reply with both avatars visible.
- Deep chains never display more than three casts in one feed unit.
- A gap marker distinguishes omitted context from a direct reply.
- Quote casts do not display reply ancestry inside the quote card.
- Existing cast and reply navigation targets do not change.
- Light/dark themes, large text, iOS, and Android remain legible.

## Verification

- Focused Jest tests: 12 passing across preview selection, reply-bumping row
  identity, branching, cycles, navigation targets, and quote isolation.
- Neighboring avatar fallback and thread-fetch-bound suites also pass; together
  the relevant regression run covers 21 tests. The existing thread test leaves
  an open Jest handle after completion, so that combined process requires manual
  termination even though every assertion passes.
- Targeted ESLint: zero errors (pre-existing warnings remain in
  `SocialFeedModal`).
- `npx tsc --noEmit`: no errors in changed files; the repository retains its
  unrelated pre-existing TypeScript backlog.
- `yarn lint`: repository-wide command remains red from unrelated pre-existing
  errors; targeted lint for changed files is clean.
- Native visual pass on Android and iOS remains required before release. No
  Android SDK/ADB or iOS environment is available in the current Windows
  workspace.
