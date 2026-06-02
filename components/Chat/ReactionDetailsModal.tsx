/**
 * ReactionDetailsModal — long-press on a reaction badge opens this modal.
 *
 * UX:
 * - Top row: one pill per distinct reaction, showing the emoji and the
 *   count of users who reacted with it. No pill is selected by default.
 * - List below the pills: who reacted with what.
 *   • Pill unselected → flattened list of every reactor + the emoji
 *     they used, grouped by emoji.
 *   • Pill selected   → list filtered to only the reactors for that
 *     emoji.
 * - Tapping the active pill again deselects (back to "show all").
 */

import React, { useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';

import { BaseModal } from '@/components/shared';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useTheme, type AppTheme } from '@/theme';
import { truncateAddress } from '@/utils/formatAddress';
import type { Emoji, SpaceMember } from '@quilibrium/quorum-shared';

import type { DisplayReaction } from './types';
import * as Skin from '@/theme/skins/geometry';

interface ReactionDetailsModalProps {
  visible: boolean;
  onClose: () => void;
  reactions: DisplayReaction[];
  /** Optional members for resolving address → display name + avatar. */
  members?: SpaceMember[];
  /** Space's custom emojis, used to render images for non-Unicode reactions. */
  customEmojis?: Emoji[];
  /** Called when the user taps a reactor's row — typically routes to their
   *  profile modal. Omit to make rows non-interactive. */
  onUserPress?: (address: string) => void;
}

interface ReactorRow {
  address: string;
  emoji: string;
  // Pre-resolved for stable rendering — null when not found in members.
  displayName: string;
  avatar: string | undefined;
}

export function ReactionDetailsModal({
  visible,
  onClose,
  reactions,
  members,
  customEmojis,
  onUserPress,
}: ReactionDetailsModalProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(null);

  // Reset selection whenever the modal opens so it's always "show all"
  // by default per the requested UX.
  React.useEffect(() => {
    if (visible) setSelectedEmoji(null);
  }, [visible]);

  const memberByAddress = useMemo(() => {
    const map = new Map<string, SpaceMember>();
    if (members) for (const m of members) map.set(m.address, m);
    return map;
  }, [members]);

  const customEmojiByKey = useMemo(() => {
    const map = new Map<string, Emoji>();
    if (customEmojis) {
      for (const e of customEmojis) {
        map.set(e.id, e);
        if (e.name) map.set(e.name, e);
      }
    }
    return map;
  }, [customEmojis]);

  // Flattened reactor rows. Order: by reaction list order, then by
  // memberIds order — matches the natural order users see in the badge
  // row. Stable per-render so the list doesn't shuffle on re-renders.
  const rows = useMemo<ReactorRow[]>(() => {
    const out: ReactorRow[] = [];
    for (const r of reactions) {
      for (const addr of r.memberIds) {
        const m = memberByAddress.get(addr);
        out.push({
          address: addr,
          emoji: r.emoji,
          displayName: m?.display_name || m?.name || truncateAddress(addr),
          avatar: m?.profile_image,
        });
      }
    }
    return out;
  }, [reactions, memberByAddress]);

  const filteredRows = useMemo(() => {
    if (!selectedEmoji) return rows;
    return rows.filter((r) => r.emoji === selectedEmoji);
  }, [rows, selectedEmoji]);

  const renderEmoji = (emoji: string, sizeStyle: 'pill' | 'row') => {
    const custom = customEmojiByKey.get(emoji);
    const style = sizeStyle === 'pill' ? styles.pillCustomEmoji : styles.rowCustomEmoji;
    if (custom) {
      return <Image source={{ uri: custom.imgUrl }} style={style} resizeMode="contain" />;
    }
    return (
      <Text style={sizeStyle === 'pill' ? styles.pillEmojiText : styles.rowEmojiText}>{emoji}</Text>
    );
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.6}>
      <View style={styles.container}>
        <Text style={styles.title}>Reactions</Text>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillsRow}
        >
          {reactions.map((r) => {
            const active = selectedEmoji === r.emoji;
            return (
              <TouchableOpacity
                key={r.emoji}
                style={[styles.pill, active && styles.pillActive]}
                onPress={() => setSelectedEmoji(active ? null : r.emoji)}
                activeOpacity={0.7}
              >
                {renderEmoji(r.emoji, 'pill')}
                <Text style={[styles.pillCount, active && styles.pillCountActive]}>
                  {r.count}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {filteredRows.length === 0 ? (
            <Text style={styles.empty}>No reactions yet</Text>
          ) : (
            filteredRows.map((row, idx) => {
              const RowWrapper: React.ComponentType<{
                children: React.ReactNode;
              }> = onUserPress
                ? ({ children }) => (
                    <TouchableOpacity
                      style={styles.row}
                      onPress={() => onUserPress(row.address)}
                      activeOpacity={0.6}
                    >
                      {children}
                    </TouchableOpacity>
                  )
                : ({ children }) => <View style={styles.row}>{children}</View>;

              return (
                <RowWrapper key={`${row.address}:${row.emoji}:${idx}`}>
                  {row.avatar ? (
                    <CachedAvatar source={{ uri: row.avatar }} style={styles.avatar} />
                  ) : (
                    <DefaultAvatar address={row.address} size={36} style={styles.avatar} />
                  )}
                  <Text style={styles.rowName} numberOfLines={1}>
                    {row.displayName}
                  </Text>
                  {/* Show the emoji on the right ONLY when the pill is
                      unselected — when filtered to one pill, the column
                      is redundant. */}
                  {!selectedEmoji && renderEmoji(row.emoji, 'row')}
                </RowWrapper>
              );
            })
          )}
        </ScrollView>
      </View>
    </BaseModal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(4),
    },
    title: {
      fontSize: Skin.font(18),
      fontWeight: '600',
      color: theme.colors.textMain,
      textAlign: 'center',
      marginBottom: Skin.space(12),
    },
    pillsRow: {
      gap: Skin.space(8),
      paddingVertical: Skin.space(4),
      paddingHorizontal: Skin.space(4),
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(16),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.surface3,
      backgroundColor: theme.colors.surface2,
    },
    pillActive: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent + '22',
    },
    pillEmojiText: {
      fontSize: Skin.font(18),
    },
    pillCustomEmoji: {
      width: 20,
      height: 20,
    },
    pillCount: {
      fontSize: Skin.font(14),
      fontWeight: '600',
      color: theme.colors.textMain,
    },
    pillCountActive: {
      color: theme.colors.accent,
    },
    list: {
      flex: 1,
      marginTop: Skin.space(12),
    },
    listContent: {
      paddingBottom: Skin.space(24),
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
      paddingVertical: Skin.space(8),
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
    },
    rowName: {
      flex: 1,
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
    },
    rowEmojiText: {
      fontSize: Skin.font(18),
    },
    rowCustomEmoji: {
      width: 22,
      height: 22,
    },
    empty: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
      paddingVertical: Skin.space(24),
    },
  });
}

export default ReactionDetailsModal;
