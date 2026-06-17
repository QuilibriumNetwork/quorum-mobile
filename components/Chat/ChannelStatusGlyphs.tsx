/**
 * ChannelStatusGlyphs — small muted glyphs trailing a channel name so state is
 * scannable without opening the drawer. star = default channel, lock = read-only.
 * Both can show at once. Deliberately subtle (no bg, no label).
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { Channel, Space } from '@quilibrium/quorum-shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface ChannelStatusGlyphsProps {
  channel: Pick<Channel, 'channelId' | 'isReadOnly'>;
  defaultChannelId: Space['defaultChannelId'];
  size?: number;
}

export function ChannelStatusGlyphs({ channel, defaultChannelId, size = 13 }: ChannelStatusGlyphsProps) {
  const { theme } = useTheme();
  const isDefault = channel.channelId === defaultChannelId;
  const isReadOnly = !!channel.isReadOnly;
  if (!isDefault && !isReadOnly) return null;

  return (
    <View style={styles.row}>
      {isDefault && <IconSymbol name="star.fill" size={size} color={theme.colors.textMuted} />}
      {isReadOnly && <IconSymbol name="lock.fill" size={size} color={theme.colors.textMuted} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) },
});
