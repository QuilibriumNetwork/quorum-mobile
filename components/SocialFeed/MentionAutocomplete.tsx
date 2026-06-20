/**
 * MentionAutocomplete - Autocomplete for @mentions and /channels in cast composer
 */

import type { AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Dimensions, ScrollView } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image } from 'expo-image';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useSearchUsers, useSearchChannels, useDebouncedValue, type SearchUser, type SearchChannel } from '@/hooks/useFarcasterSearch';
import * as Skin from '@/theme/skins/geometry';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export type MentionType = 'user' | 'channel' | null;

export interface MentionInfo {
  type: MentionType;
  text: string;
  replaceStart: number;
  replaceEnd: number;
}

interface MentionAutocompleteProps {
  mentionInfo: MentionInfo | null;
  token?: string;
  onSelectUser: (user: SearchUser) => void;
  onSelectChannel: (channel: SearchChannel) => void;
  theme: AppTheme;
  maxHeight?: number;
}

/**
 * Detects @mention or /channel trigger from text and cursor position
 */
export function getMentionInfo(
  text: string,
  cursorPosition: number
): MentionInfo | null {
  if (!text || cursorPosition <= 0) return null;

  const textUpToCursor = text.slice(0, cursorPosition);

  // Find the last @ or / before cursor
  const lastAtIndex = textUpToCursor.lastIndexOf('@');
  const lastSlashIndex = textUpToCursor.lastIndexOf('/');

  // Determine which trigger is closest to cursor
  const triggerIndex = Math.max(lastAtIndex, lastSlashIndex);
  if (triggerIndex < 0) return null;

  const isUserMention = triggerIndex === lastAtIndex;
  const triggerChar = isUserMention ? '@' : '/';

  // Check that trigger is at start of word (preceded by whitespace or start of string)
  if (triggerIndex > 0) {
    const charBefore = text.charAt(triggerIndex - 1);
    if (!/[\s\n]/.test(charBefore)) return null;
  }

  // Extract the text after the trigger
  const query = textUpToCursor.slice(triggerIndex + 1);

  // Don't match if there's whitespace in the query (mention has ended)
  if (/\s/.test(query)) return null;

  // Validate query - alphanumeric, dots, hyphens, underscores
  if (isUserMention) {
    // User mentions: @username or @username.eth
    if (!/^[a-zA-Z0-9._-]*$/.test(query)) return null;
  } else {
    // Channel mentions: /channel-name
    if (!/^[a-zA-Z0-9-]*$/.test(query)) return null;
  }

  return {
    type: isUserMention ? 'user' : 'channel',
    text: query,
    replaceStart: triggerIndex + 1, // Position after @ or /
    replaceEnd: cursorPosition,
  };
}

/**
 * Replaces mention text with selected username/channel
 */
export function replaceMention(
  text: string,
  mentionInfo: MentionInfo,
  replacement: string
): string {
  return (
    text.slice(0, mentionInfo.replaceStart) +
    replacement +
    ' ' +
    text.slice(mentionInfo.replaceEnd)
  );
}

export function MentionAutocomplete({
  mentionInfo,
  token,
  onSelectUser,
  onSelectChannel,
  theme,
  maxHeight = 200,
}: MentionAutocompleteProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Debounce search query to avoid excessive API calls
  const debouncedQuery = useDebouncedValue(mentionInfo?.text ?? '', 150);

  // Search users when type is 'user'
  const {
    users,
    isPending: isLoadingUsers,
  } = useSearchUsers({
    q: debouncedQuery,
    token,
    limit: 10,
    enabled: mentionInfo?.type === 'user' && debouncedQuery.length > 0,
  });

  // Search channels when type is 'channel'
  const {
    channels,
    isPending: isLoadingChannels,
  } = useSearchChannels({
    q: debouncedQuery,
    token,
    limit: 10,
    enabled: mentionInfo?.type === 'channel' && debouncedQuery.length > 0,
  });

  // Don't show if no mention info
  if (!mentionInfo) return null;

  const isLoading = mentionInfo.type === 'user' ? isLoadingUsers : isLoadingChannels;
  const hasResults = mentionInfo.type === 'user' ? users.length > 0 : channels.length > 0;

  // Show loading or empty state only after typing at least 1 character
  if (mentionInfo.text.length === 0) return null;

  return (
    <View style={[styles.container, { maxHeight }]}>
      {isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      )}

      {!isLoading && !hasResults && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            No {mentionInfo.type === 'user' ? 'users' : 'channels'} found
          </Text>
        </View>
      )}

      {mentionInfo.type === 'user' && users.length > 0 && (
        <ScrollView keyboardShouldPersistTaps="always">
          {users.map((item) => (
            <TouchableOpacity
              key={String(item.fid)}
              style={styles.item}
              onPress={() => onSelectUser(item)}
              activeOpacity={0.7}
            >
              {item.pfp?.url ? (
                <Image source={{ uri: item.pfp.url }} style={styles.avatar} cachePolicy="disk" recyclingKey={item.pfp.url} />
              ) : (
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <Text style={styles.avatarPlaceholderText}>
                    {(item.displayName || item.username || '?')[0].toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.itemContent}>
                <Text style={styles.itemName} numberOfLines={1}>
                  {item.displayName || item.username}
                </Text>
                <Text style={styles.itemUsername} numberOfLines={1}>
                  @{item.username}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {mentionInfo.type === 'channel' && channels.length > 0 && (
        <ScrollView keyboardShouldPersistTaps="always">
          {channels.map((item) => (
            <TouchableOpacity
              key={item.key}
              style={styles.item}
              onPress={() => onSelectChannel(item)}
              activeOpacity={0.7}
            >
              {item.imageUrl ? (
                <Image source={{ uri: item.imageUrl }} style={styles.channelIcon} cachePolicy="disk" recyclingKey={item.imageUrl} />
              ) : (
                <View style={[styles.channelIcon, styles.channelIconPlaceholder]}>
                  <IconSymbol name="number" size={16} color={theme.colors.textMuted} />
                </View>
              )}
              <View style={styles.itemContent}>
                <Text style={styles.itemName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.itemUsername} numberOfLines={1}>
                  /{item.key}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface2,
    borderRadius: Skin.radius(12),
    borderWidth: Skin.border(1),
    borderColor: theme.colors.border ?? theme.colors.surface3,
    overflow: 'hidden',
  },
  loadingContainer: {
    padding: Skin.space(16),
    alignItems: 'center',
  },
  emptyContainer: {
    padding: Skin.space(16),
    alignItems: 'center',
  },
  emptyText: {
    color: theme.colors.textMuted,
    fontSize: Skin.font(14),
    fontFamily: theme.fonts.regular.fontFamily,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Skin.space(10),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.surface3,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: Skin.radius(18),
    backgroundColor: theme.colors.surface3,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: {
    color: theme.colors.textMuted,
    fontSize: Skin.font(14),
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
  },
  channelIcon: {
    width: 36,
    height: 36,
    borderRadius: Skin.radius(8),
    backgroundColor: theme.colors.surface3,
  },
  channelIconPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemContent: {
    flex: 1,
    marginLeft: Skin.space(10),
  },
  itemName: {
    color: theme.colors.textStrong,
    fontSize: Skin.font(15),
    fontFamily: theme.fonts.medium.fontFamily,
    fontWeight: theme.fonts.medium.fontWeight,
  },
  itemUsername: {
    color: theme.colors.textMuted,
    fontSize: Skin.font(13),
    fontFamily: theme.fonts.regular.fontFamily,
    marginTop: Skin.space(1),
  },
});

export default MentionAutocomplete;
