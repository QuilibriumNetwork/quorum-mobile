/**
 * QuorumIdentityBadge — compact inline display of a Farcaster user's
 * linked Quorum identity. Shows `name.q · address` when the user has a
 * primary QNS name, otherwise just a truncated address. Hides itself
 * silently when the fid has no linked Quorum identity (common case).
 *
 * Used in the social feed surfaces (ChannelView, ProfileView,
 * ThreadDetailView, QuoteCast) next to the Farcaster username so a
 * Quorum-using Farcaster account is recognizable to other Quorum users.
 */

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { MemberName } from '@/identity';
import { useQuorumIdentityForFid } from '@/hooks/useQuorumIdentityForFid';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface QuorumIdentityBadgeProps {
  fid: number | undefined;
  theme: AppTheme;
  /** Optional override: smaller font/icon for inline placement next to a username. */
  compact?: boolean;
  /**
   * Whether this badge may issue a public-profile fetch for its linked
   * Quorum address. Required, not defaulted: the badge is a LEAF with no
   * view of how many siblings are mounted at once (a windowed FlashList row
   * vs. one of hundreds of casts in a non-windowed ScrollView), so it cannot
   * safely decide this itself. The CALLER must already have bounded its own
   * fan-out to at most `MAX_QNS_LOOKUPS` concurrent enrichments — see
   * `hooks/chat/useConversationsWithQnsNames.ts` — before passing `true`
   * here. A caller that mounts every cast at once (no windowing) must
   * additionally cap WHICH badges enrich, since it cannot rely on windowing
   * to do that for it (see `ThreadDetailView`'s `enrichableFids`).
   */
  enrich: boolean;
}

export function QuorumIdentityBadge({ fid, theme, compact = false, enrich }: QuorumIdentityBadgeProps) {
  const { data } = useQuorumIdentityForFid(fid);
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);

  if (!data) return null;

  return (
    <View style={styles.row}>
      <IconSymbol
        name="link"
        size={compact ? 10 : 12}
        color={theme.colors.accent}
      />
      {/*
        `global`: this badge sits outside any Space (a Farcaster feed
        surface), so the per-space roster ladder never applies to it.
        `enrich`: without a public-profile fetch for this address, the
        provider's `verifiedQnsNames` map can never gain an entry for it, so
        the badge could never show a `.q` at all — the fetch is what makes
        verification possible in the first place, not an optional extra.
        Whether it is SAFE to make that fetch is the caller's call, not this
        component's — see the prop doc above.
      */}
      <MemberName address={data.address} global enrich={enrich} style={styles.text} numberOfLines={1} />
    </View>
  );
}

function createStyles(theme: AppTheme, compact: boolean) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      // The badge is purely informational; let the parent decide
      // padding/spacing. No background — we just want a label.
    },
    text: {
      // Explicit lineHeight, matching the theme's tuned tokens for these sizes
      // (caption2 is 11/13, caption1 is 12/16). Without one, the rendered line
      // box is whatever the platform's font metrics produce — fine in a feed
      // row that sizes to its content, but this badge is now also drawn inside
      // a header bar with a minimum height, and an unknown height there is the
      // difference between fitting and overlapping the content below.
      fontSize: compact ? 11 : 12,
      lineHeight: compact ? 13 : 16,
      color: theme.colors.accent,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: '500',
    },
  });
}

export default QuorumIdentityBadge;
