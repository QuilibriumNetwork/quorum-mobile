/**
 * BoundChannelFeedPanel — when a space-channel is bound to one or more
 * Farcaster channels, this panel surfaces a recent-casts strip directly
 * inside the space view. Co-rendered above the chat: feed on top,
 * conversation underneath, composer always reachable.
 */

import CastComposeModal from '@/components/CastComposeModal';
import { ThreadDetailView } from '@/components/SocialFeed/views/ThreadDetailView';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context/AuthContext';
import { useFarcasterChannel } from '@/hooks/useFarcasterChannel';
import { useTheme, type AppTheme } from '@/theme';
import { router } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface BoundChannelFeedPanelProps {
  /** Linked channel keys for this space-channel. Only the first one is shown
   *  for now — multi-channel composition is a follow-up. */
  channelKeys: string[];
  /** Initial expansion state. Defaults to collapsed. */
  initiallyExpanded?: boolean;
  /** Maximum height (px) the feed area will take when expanded. */
  maxExpandedHeight?: number;
  theme?: AppTheme;
}

export default function BoundChannelFeedPanel({
  channelKeys,
  initiallyExpanded = false,
  maxExpandedHeight = 320,
  theme: themeOverride,
}: BoundChannelFeedPanelProps) {
  const { theme: themeFromCtx } = useTheme();
  const theme = themeOverride ?? themeFromCtx;
  const { user, farcasterAuthToken } = useAuth();
  const currentUserFid = user?.farcaster?.fid;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [activeKey, setActiveKey] = useState<string>(channelKeys[0] ?? '');
  const [activeThread, setActiveThread] = useState<{ username: string; castHashPrefix: string } | null>(null);
  const [composeVisible, setComposeVisible] = useState(false);
  const [likeStates] = useState(() => new Map<string, { liked: boolean; count: number }>());
  const [followStates] = useState(() => new Map<number, boolean>());
  const { height: SCREEN_H } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const listRef = useRef<FlatList<any>>(null);

  // Keep activeKey in sync if bindings change underneath us
  React.useEffect(() => {
    if (channelKeys.length === 0) return;
    if (!channelKeys.includes(activeKey)) {
      setActiveKey(channelKeys[0]);
    }
  }, [channelKeys, activeKey]);

  const { channel, casts, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage, refetch } =
    useFarcasterChannel({
      channelKey: activeKey,
      token: farcasterAuthToken ?? undefined,
      enabled: expanded && Boolean(activeKey),
    });

  if (channelKeys.length === 0) return null;

  // When a thread is open, the panel grows to a comfortable reading size so
  // the user can scan replies without leaving the space.
  const threadHeight = Math.min(SCREEN_H * 0.6, 600);

  return (
    <View style={[styles.container, { borderBottomColor: theme.colors.surface3 }]}>
      <Pressable
        onPress={() => {
          if (activeThread) {
            setActiveThread(null);
          } else {
            setExpanded((v) => !v);
          }
        }}
        style={styles.header}
      >
        {activeThread ? (
          <>
            <IconSymbol name="chevron.left" size={14} color={theme.colors.textMuted} />
            <Text style={[styles.title, { color: theme.colors.textMain }]}>
              Thread · /{activeKey}
            </Text>
          </>
        ) : (
          <>
            <IconSymbol name="link" size={12} color={theme.colors.textMuted} />
            {channelKeys.length === 1 ? (
              <Text style={[styles.title, { color: theme.colors.textMain }]}>
                /{channelKeys[0]}
              </Text>
            ) : (
              <ChannelTabs
                channelKeys={channelKeys}
                activeKey={activeKey}
                setActiveKey={setActiveKey}
                theme={theme}
              />
            )}
          </>
        )}
        <View style={{ flex: 1 }} />
        {!activeThread && farcasterAuthToken && activeKey && (
          <TouchableOpacity
            onPress={(e) => {
              e.stopPropagation?.();
              setComposeVisible(true);
            }}
            hitSlop={8}
            style={styles.composeBtn}
          >
            <IconSymbol name="square.and.pencil" size={14} color={theme.colors.accent} />
          </TouchableOpacity>
        )}
        {!activeThread && (
          <IconSymbol
            name={expanded ? 'chevron.up' : 'chevron.down'}
            size={14}
            color={theme.colors.textMuted}
          />
        )}
      </Pressable>

      {activeThread ? (
        <View style={[styles.body, { height: threadHeight }]}>
          <ThreadDetailView
            username={activeThread.username}
            castHashPrefix={activeThread.castHashPrefix}
            token={farcasterAuthToken ?? undefined}
            currentUserFid={currentUserFid}
            theme={theme}
            onClose={() => setActiveThread(null)}
            onOpenMiniApp={(url) => router.push({ pathname: '/browser', params: { url } })}
            onOpenProfile={(fid, username) => {
              if (username) {
                router.push({ pathname: '/feed', params: { username, castHashPrefix: '' } });
              } else {
                router.push('/(tabs)/feed');
              }
            }}
            onOpenChannel={(channelKey) => router.push({ pathname: '/feed', params: { channelKey } })}
            likeStates={likeStates}
            onLikeToggle={() => { /* like handling lives in the feed tab */ }}
            followStates={followStates}
            onFollow={() => { /* follow handling lives in the feed tab */ }}
          />
        </View>
      ) : expanded ? (
        <View style={[styles.body, { maxHeight: maxExpandedHeight }]} onLayout={onMeasure}>
          {isLoading && casts.length === 0 ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={theme.colors.accent} size="small" />
            </View>
          ) : error ? (
            <Text style={[styles.errorText, { color: theme.colors.textMuted }]}>{error}</Text>
          ) : casts.length === 0 ? (
            <Text style={[styles.emptyText, { color: theme.colors.textMuted }]}>
              No recent casts.
            </Text>
          ) : (
            <FlatList
              ref={listRef}
              data={casts}
              keyExtractor={(c) => c.hash}
              showsVerticalScrollIndicator={false}
              onEndReachedThreshold={0.3}
              onEndReached={() => {
                if (hasNextPage && !isFetchingNextPage) fetchNextPage();
              }}
              renderItem={({ item }) => (
                <CastRow
                  cast={item}
                  channelName={channel?.name}
                  theme={theme}
                  onPress={() => {
                    setActiveThread({
                      username: item.author.username,
                      castHashPrefix: item.hash.slice(0, 10),
                    });
                  }}
                />
              )}
              ListFooterComponent={
                isFetchingNextPage ? (
                  <View style={{ paddingVertical: Skin.space(10), alignItems: 'center' }}>
                    <ActivityIndicator color={theme.colors.accent} size="small" />
                  </View>
                ) : null
              }
            />
          )}
        </View>
      ) : null}

      <CastComposeModal
        visible={composeVisible}
        onClose={() => setComposeVisible(false)}
        token={farcasterAuthToken ?? undefined}
        channelKey={activeKey}
        onPosted={() => refetch()}
      />
    </View>
  );

  function onMeasure(_e: LayoutChangeEvent) {
    // Reserved for future pinch-to-resize; currently a no-op.
  }
}

function ChannelTabs({
  channelKeys,
  activeKey,
  setActiveKey,
  theme,
}: {
  channelKeys: string[];
  activeKey: string;
  setActiveKey: (k: string) => void;
  theme: AppTheme;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: Skin.space(6) }}>
      {channelKeys.map((k) => {
        const active = k === activeKey;
        return (
          <Pressable
            key={k}
            onPress={(e) => {
              e.stopPropagation?.();
              setActiveKey(k);
            }}
            style={{
              paddingHorizontal: Skin.space(8),
              paddingVertical: Skin.space(3),
              borderRadius: Skin.radius(10),
              backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
              borderWidth: Skin.border(1),
              borderColor: active ? theme.colors.accent : theme.colors.surface3,
            }}
          >
            <Text
              style={{
                fontSize: Skin.font(12),
                fontWeight: '500',
                color: active ? '#fff' : theme.colors.textMain,
              }}
            >
              /{k}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Threshold for marking a cast as "Live": replies + recent timestamp. */
const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
function isCastLive(cast: any): boolean {
  const replies = cast.replies?.count ?? 0;
  if (replies <= 0) return false;
  const ts = typeof cast.timestamp === 'number' ? cast.timestamp : 0;
  return ts > 0 && Date.now() - ts < LIVE_WINDOW_MS;
}

function CastRow({
  cast,
  channelName,
  theme,
  onPress,
}: {
  cast: any;
  channelName?: string;
  theme: AppTheme;
  onPress: () => void;
}) {
  const replyCount = cast.replies?.count ?? 0;
  const reactionCount = cast.reactions?.count ?? 0;
  const ts = formatRelative(cast.timestamp);
  const live = isCastLive(cast);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={[castRowStyles.row, { borderBottomColor: theme.colors.surface2 }]}>
      <CachedAvatar
        source={cast.author?.pfp?.url ? { uri: cast.author.pfp.url } : null}
        style={[castRowStyles.avatar, { backgroundColor: theme.colors.surface3 }]}
      />
      <View style={castRowStyles.body}>
        <View style={castRowStyles.headerRow}>
          <View style={castRowStyles.authorRow}>
            <Text style={[castRowStyles.author, { color: theme.colors.textStrong }]} numberOfLines={1}>
              {cast.author?.displayName ?? cast.author?.username}
            </Text>
            {live && <LivePulse theme={theme} />}
          </View>
          <Text style={[castRowStyles.meta, { color: theme.colors.textMuted }]}>{ts}</Text>
        </View>
        {cast.text ? (
          <Text style={[castRowStyles.text, { color: theme.colors.textMain }]} numberOfLines={3}>
            {cast.text}
          </Text>
        ) : null}
        {(replyCount > 0 || reactionCount > 0) && (
          <View style={castRowStyles.statsRow}>
            {replyCount > 0 && (
              <Text style={[castRowStyles.stat, { color: theme.colors.textMuted }]}>
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </Text>
            )}
            {reactionCount > 0 && (
              <Text style={[castRowStyles.stat, { color: theme.colors.textMuted }]}>
                ♥ {reactionCount}
              </Text>
            )}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

function LivePulse({ theme }: { theme: AppTheme }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <View style={livePulseStyles.row}>
      <Animated.View
        style={[livePulseStyles.dot, { backgroundColor: theme.colors.danger ?? '#ef4444', opacity }]}
      />
      <Text style={[livePulseStyles.label, { color: theme.colors.danger ?? '#ef4444' }]}>LIVE</Text>
    </View>
  );
}

const livePulseStyles = createSkinnable(() => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(4),
    marginLeft: Skin.space(6),
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: Skin.radius(3),
  },
  label: {
    fontSize: Skin.font(9),
    fontWeight: '700',
    letterSpacing: 0.5,
  },
}));

function formatRelative(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      borderBottomWidth: Skin.border(1),
      backgroundColor: theme.colors.surface2,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
      borderLeftWidth: Skin.border(3),
      borderLeftColor: theme.colors.accent,
    },
    title: {
      fontSize: Skin.font(13),
      fontWeight: '600',
    },
    composeBtn: {
      paddingHorizontal: Skin.space(4),
      paddingVertical: Skin.space(2),
    },
    body: {
      flexShrink: 1,
    },
    loadingWrap: {
      paddingVertical: Skin.space(16),
      alignItems: 'center',
    },
    errorText: {
      fontSize: Skin.font(12),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
    },
    emptyText: {
      fontSize: Skin.font(12),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
      textAlign: 'center',
    },
  });
}

const castRowStyles = createSkinnable(() => StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Skin.space(10),
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(10),
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: Skin.radius(16),
  },
  body: {
    flex: 1,
    gap: Skin.space(2),
    minWidth: 0,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Skin.space(6),
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
  },
  author: {
    fontSize: Skin.font(13),
    fontWeight: '600',
    flexShrink: 1,
  },
  meta: {
    fontSize: Skin.font(11),
  },
  text: {
    fontSize: Skin.font(13),
    lineHeight: Skin.font(18),
  },
  statsRow: {
    flexDirection: 'row',
    gap: Skin.space(12),
    marginTop: Skin.space(2),
  },
  stat: {
    fontSize: Skin.font(11),
  },
}));
