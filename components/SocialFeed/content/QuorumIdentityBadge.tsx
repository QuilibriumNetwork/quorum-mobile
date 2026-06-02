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
import { StyleSheet, Text, View } from 'react-native';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { truncateAddress } from '@/utils/formatAddress';
import { useQuorumIdentityForFid } from '@/hooks/useQuorumIdentityForFid';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface QuorumIdentityBadgeProps {
  fid: number | undefined;
  theme: AppTheme;
  /** Optional override: smaller font/icon for inline placement next to a username. */
  compact?: boolean;
}

export function QuorumIdentityBadge({ fid, theme, compact = false }: QuorumIdentityBadgeProps) {
  const { data } = useQuorumIdentityForFid(fid);
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);

  if (!data) return null;

  const label = data.primaryUsername
    ? `${data.primaryUsername}.q`
    : truncateAddress(data.address);

  return (
    <View style={styles.row}>
      <IconSymbol
        name="link"
        size={compact ? 10 : 12}
        color={theme.colors.accent}
      />
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
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
      fontSize: compact ? 11 : 12,
      color: theme.colors.accent,
      fontWeight: '500',
    },
  });
}

export default QuorumIdentityBadge;
