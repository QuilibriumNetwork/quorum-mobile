/**
 * ComposeChannelPickerModal — single-pick channel selector for the cast
 * composer. Lets the user choose a target channel for their next cast,
 * or clear the selection to post to their home feed.
 */

import { BaseModal } from '@/components/shared';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context/AuthContext';
import {
  useDebouncedValue,
  useSearchChannels,
  useUserFollowedChannels,
  type SearchChannel,
} from '@/hooks/useFarcasterSearch';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface ComposeChannelPickerModalProps {
  visible: boolean;
  onClose: () => void;
  /** Currently selected channel key (or undefined for home feed). */
  value: string | undefined;
  /** Callback when the user picks a target. Pass `undefined` for home feed. */
  onPick: (channelKey: string | undefined) => void;
}

export default function ComposeChannelPickerModal({
  visible,
  onClose,
  value,
  onPick,
}: ComposeChannelPickerModalProps) {
  const { theme } = useTheme();
  const { user, farcasterAuthToken } = useAuth();
  const fid = user?.farcaster?.fid;
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 200);

  const styles = useMemo(() => createStyles(theme), [theme]);

  const followed = useUserFollowedChannels({
    fid,
    token: farcasterAuthToken ?? undefined,
    enabled: visible && !debounced.trim(),
  });

  const search = useSearchChannels({
    q: debounced,
    token: farcasterAuthToken ?? undefined,
    limit: 25,
    enabled: visible && debounced.trim().length > 0,
  });

  const showSearch = debounced.trim().length > 0;
  const channels: SearchChannel[] = showSearch ? search.channels : (followed.data ?? []);
  const isLoading = showSearch ? search.isLoading : followed.isLoading;

  const handlePick = (key: string | undefined) => {
    onPick(key);
    setQuery('');
    onClose();
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.7} avoidKeyboard>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Cast in…</Text>
          <TouchableOpacity onPress={onClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

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

        {/* Home feed (clears any channel selection) */}
        <TouchableOpacity
          onPress={() => handlePick(undefined)}
          style={styles.row}
          activeOpacity={0.7}
        >
          <View style={[styles.homeIconWrap, { backgroundColor: theme.colors.surface2 }]}>
            <IconSymbol name="house.fill" size={18} color={theme.colors.accent} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowName}>Home feed</Text>
            <Text style={styles.rowKey}>Default visibility — your followers</Text>
          </View>
          {value === undefined && <IconSymbol name="checkmark" size={16} color={theme.colors.accent} />}
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>{showSearch ? 'Results' : 'Your channels'}</Text>

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
              const selected = value === item.key;
              return (
                <TouchableOpacity
                  key={item.key}
                  onPress={() => handlePick(item.key)}
                  style={styles.row}
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
                  {selected && <IconSymbol name="checkmark" size={16} color={theme.colors.accent} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    </BaseModal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(40),
      gap: Skin.space(12),
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      fontSize: Skin.font(18),
      fontWeight: '700',
      color: theme.colors.textStrong,
    },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(10),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.surface1,
    },
    searchInput: {
      flex: 1,
      color: theme.colors.textMain,
      fontSize: Skin.font(15),
      paddingVertical: 0,
      minHeight: 22,
    },
    sectionLabel: {
      fontSize: Skin.font(11),
      fontWeight: '600',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      color: theme.colors.textSubtle,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
      paddingVertical: Skin.space(10),
    },
    homeIconWrap: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      alignItems: 'center',
      justifyContent: 'center',
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
      color: theme.colors.textSubtle,
      marginTop: Skin.space(1),
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
      color: theme.colors.textSubtle,
      textAlign: 'center',
    },
  });
}
