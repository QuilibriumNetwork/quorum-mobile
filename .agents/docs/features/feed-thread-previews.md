# Feed thread previews

The home feed presents replies as compact conversation units without changing
feed ordering or thread navigation.

## Preview selection

`components/SocialFeed/threadPreview.ts` owns the pure selection rules. A unit
contains at most three casts:

- one cast: the original post;
- two casts: immediate parent and focused reply;
- three casts: oldest useful context, immediate parent, and focused reply;
- deeper paths: root, a gap marker, immediate parent, and focused reply.

When the true root is unavailable, the preview uses the oldest resolved cast
and places a leading gap before it. The gap never counts as a cast.

Self-reply paths already present in a feed page are collapsed without changing
the position or row identity of their newest cast. Branches remain separate
units and therefore cannot collide on FlashList keys. A lone
cross-author reply performs at most two ancestor lookups: parent and
grandparent. React Query deduplicates and caches those lookups.

## Visual semantics

Every displayed cast remains a complete `FeedPostCard`, including its own
avatar. Directly adjacent parent/reply cards share an accent rail with a branch
that terminates at each avatar. The rail is interrupted by a gap marker, so
omitted context is never mistaken for a direct reply.

The gap has a screen-reader label. When the omitted count is known it announces
the count; otherwise it announces that earlier replies were omitted.
Visible direct replies announce both authors; replies following a collapsed gap
are announced as replies in a conversation rather than as original posts.

## Invariants

- Quote cards remain ancestry-blind and continue to render through
  `SocialFeed/content/QuoteCast.tsx`.
- Existing card presses, profile presses, reply actions, and thread routing are
  unchanged.
- A failed ancestor lookup falls back to the existing single-card reply
  presentation.
- The feed never walks an unbounded remote ancestor chain.

## Tests

`__tests__/feedThreadPreview.test.ts` covers the three-cast cap, known and
unknown gaps, reply-bumping order, cross-author separation, branching, and
malformed cycles.

Before release, visually verify the rail, gap, custom skins, light/dark themes,
large text, and failed-avatar fallbacks on both iOS and Android.
