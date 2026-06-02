/**
 * SpaceChannelBindingPicker — reusable picker that shows the user's followed
 * Farcaster channels (or search results) and lets them toggle which ones are
 * linked to a given space. Bindings persist via `channelBindings` MMKV store.
 *
 * Used both as the body of `SpaceChannelBindingModal` and as the "Linked"
 * tab inside Space Settings.
 */

import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context/AuthContext';
import { useWebSocket } from '@/context/WebSocketContext';
import {
  useDebouncedValue,
  useSearchChannels,
  useUserFollowedChannels,
  type SearchChannel,
} from '@/hooks/useFarcasterSearch';
import {
  updateSpaceBindings,
  useSpaceBindings,
} from '@/services/space/channelBindings';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface SpaceChannelBindingPickerProps {
  spaceId: string;
  /** Set false when not actually visible to skip network fetches. */
  enabled?: boolean;
  /** Optional override for the outer container style (e.g. flex sizing). */
  containerStyle?: ViewStyle;
  /** When true, suppress the description blurb (the embedding context already
   *  shows one, e.g. inside Space Settings). */
  hideDescription?: boolean;
}

export default function SpaceChannelBindingPicker({
  spaceId,
  enabled = true,
  containerStyle,
  hideDescription = false,
}: SpaceChannelBindingPickerProps) {
  const { theme } = useTheme();
  const { user, farcasterAuthToken } = useAuth();
  const { enqueueOutbound } = useWebSocket();
  const fid = user?.farcaster?.fid;
  const [bindings, setBindings] = useSpaceBindings(spaceId);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);

  const styles = useMemo(() => createStyles(theme), [theme]);

  const followed = useUserFollowedChannels({
    fid,
    token: farcasterAuthToken ?? undefined,
    enabled: enabled && !debounced.trim(),
  });

  const search = useSearchChannels({
    q: debounced,
    token: farcasterAuthToken ?? undefined,
    limit: 25,
    enabled: enabled && debounced.trim().length > 0,
  });

  const showSearch = debounced.trim().length > 0;
  const channels: SearchChannel[] = showSearch ? search.channels : (followed.data ?? []);
  const isLoading = showSearch ? search.isLoading : followed.isLoading;

  const toggleBinding = (key: string) => {
    const next = bindings.includes(key)
      ? bindings.filter((k) => k !== key)
      : [...bindings, key];
    setBindings(next);
    // Persists locally + uploads manifest via HTTP + enqueues the WS
    // control message so live members are notified immediately.
    updateSpaceBindings(spaceId, next, enqueueOutbound);
  };

  return (
    <View style={[styles.container, containerStyle]}>
      {!hideDescription && (
        <Text style={styles.subtitle}>
          When this space is open, casts from linked channels appear alongside the chat.
        </Text>
      )}

      <View style={styles.searchRow}>
        <IconSymbol name="magnifyingglass" size={16} color={theme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search channels..."
          placeholderTextColor={theme.colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')}>
            <IconSymbol name="xmark.circle.fill" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {!showSearch && bindings.length > 0 && (
        <View style={styles.activeBindings}>
          <Text style={styles.sectionLabel}>Linked</Text>
          <View style={styles.chipRow}>
            {bindings.map((k) => (
              <TouchableOpacity
                key={k}
                onPress={() => toggleBinding(k)}
                style={styles.chip}
                activeOpacity={0.7}
              >
                <Text style={styles.chipText}>/{k}</Text>
                <IconSymbol name="xmark" size={11} color={theme.colors.textMain} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <Text style={styles.sectionLabel}>{showSearch ? 'Results' : 'Following'}</Text>

      {isLoading && channels.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : channels.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>
            {showSearch ? 'No channels match your search.' : "You don't follow any channels yet."}
          </Text>
        </View>
      ) : (
        <View>
          {channels.map((item) => {
            const linked = bindings.includes(item.key);
            return (
              <TouchableOpacity
                key={item.key}
                style={styles.row}
                onPress={() => toggleBinding(item.key)}
                activeOpacity={0.7}
              >
                <CachedAvatar
                  source={item.imageUrl ? { uri: item.imageUrl } : null}
                  style={styles.avatar}
                />
                <View style={styles.rowText}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.rowKey} numberOfLines={1}>/{item.key}</Text>
                </View>
                <View
                  style={[
                    styles.checkbox,
                    linked && { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
                  ]}
                >
                  {linked && <IconSymbol name="checkmark" size={12} color="#fff" />}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      gap: Skin.space(12),
    },
    subtitle: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      lineHeight: Skin.font(18),
    },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(10),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.surface3,
      backgroundColor: theme.colors.surface1,
    },
    searchInput: {
      flex: 1,
      color: theme.colors.textMain,
      fontSize: Skin.font(15),
      paddingVertical: 0,
      minHeight: 22,
    },
    activeBindings: {
      gap: Skin.space(6),
    },
    sectionLabel: {
      fontSize: Skin.font(11),
      fontWeight: '600',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      color: theme.colors.textMuted,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(6),
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      paddingHorizontal: Skin.space(10),
      paddingVertical: Skin.space(5),
      borderRadius: Skin.radius(14),
      backgroundColor: theme.colors.surface2,
      borderWidth: Skin.border(1),
      borderColor: theme.colors.surface3,
    },
    chipText: {
      fontSize: Skin.font(12),
      color: theme.colors.textMain,
      fontWeight: '500',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
      paddingVertical: Skin.space(10),
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      backgroundColor: theme.colors.surface3,
    },
    rowText: {
      flex: 1,
      minWidth: 0,
    },
    rowName: {
      fontSize: Skin.font(15),
      fontWeight: '600',
      color: theme.colors.textStrong,
    },
    rowKey: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(1),
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: Skin.radius(11),
      borderWidth: Skin.border(2),
      borderColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    loadingWrap: {
      paddingVertical: Skin.space(30),
      alignItems: 'center',
    },
    emptyWrap: {
      paddingVertical: Skin.space(30),
      alignItems: 'center',
    },
    emptyText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
  });
}
