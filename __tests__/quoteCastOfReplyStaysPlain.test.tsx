/**
 * Quote-casting a deep reply must look like a normal quote cast.
 *
 * ## The regression this pins
 *
 * When David quote-casts Charlie's reply (Alice → Bob → Charlie), the quote
 * card shows Charlie's cast alone — author PFP, name, text — and never drags
 * in Charlie's parent/thread context (no "replying to", no Alice/Bob). This
 * is true today because `QuoteCast` renders only author + text + first
 * image; the test exists so that generic ancestor hydration (added for feed
 * thread units in `useFeedThreadAncestors`) can never quietly extend into
 * the quote-card path. The fixture deliberately carries reply metadata
 * (`parentHash`/`threadHash`/`parentAuthor`) beyond the `EmbeddedCast`
 * type, the shape a hydrated NormalizedCast would smuggle in.
 *
 * The quoted author's PFP block must also always render (identity never
 * disappears because the post is displayed inside another interaction) —
 * with no image URL it falls back to initials, per cachedAvatarFallback.
 */
import React from 'react';
import { screen } from '@testing-library/react-native';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { QuoteCast } from '@/components/SocialFeed/content/QuoteCast';
import { DarkTheme } from '@/theme';
import type { EmbeddedCast } from '@/hooks/useFarcasterFeed';

const quotedReply = {
  hash: '0xcharliereply000000000000000000000000000000',
  threadHash: '0xaliceroot0000000000000000000000000000000',
  // Reply metadata a hydrated cast would carry — must not surface in the card.
  parentHash: '0xbobreply000000000000000000000000000000000',
  parentAuthor: { fid: 2, username: 'bob' },
  author: {
    fid: 3,
    displayName: 'Charlie',
    username: 'charlie',
    // no pfp URL -> CachedAvatar renders the initials fallback
  },
  text: 'deep reply being quoted',
  timestamp: 1_700_000_000_000,
} as EmbeddedCast;

describe('QuoteCast of a reply', () => {
  it('renders as a plain quote card: author + text, no thread context', () => {
    renderWithProviders(<QuoteCast cast={quotedReply} theme={DarkTheme} />);

    // The quoted author's identity is fully visible…
    expect(screen.getByText('Charlie')).toBeTruthy();
    expect(screen.getByText('@charlie')).toBeTruthy();
    expect(screen.getByText('deep reply being quoted')).toBeTruthy();

    // …and none of the reply's thread context leaks into the card.
    expect(screen.queryByText(/replying to/i)).toBeNull();
    expect(screen.queryByText(/bob/i)).toBeNull();
    expect(screen.queryByText(/@bob/)).toBeNull();
  });
});
