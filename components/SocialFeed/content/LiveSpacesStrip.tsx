/**
 * LiveSpacesStrip — horizontal carousel of currently-live audio
 * spaces, surfaced above the cast list. This is the entry point for
 * spaces that aren't being shared via a cast embed.
 *
 * The strip self-hides when the discovery list is empty / errors out,
 * so feeds without any live rooms look identical to the pre-spaces
 * layout.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { CreateSpaceSheet } from '@/components/CreateSpaceSheet';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAudioSpace } from '@/context/AudioSpaceContext';
import { useAuth } from '@/context/AuthContext';
import {
  listLiveAudioRooms,
  listScheduledAudioRooms,
  type AudioRoom,
} from '@/services/spaces/spacesClient';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

/** 5s stale, 10s refetch. Listener counts move on that cadence and
 *  tighter sync keeps the strip from drifting visibly. */
const STALE_TIME_MS = 5_000;
const REFETCH_INTERVAL_MS = 10_000;

export function LiveSpacesStrip() {
  const { theme } = useTheme();
  const { farcasterAuthToken } = useAuth();
  const { join, active } = useAudioSpace();

  const { data: liveRooms } = useQuery<AudioRoom[]>({
    queryKey: ['discover-audio-rooms', 'live'] as const,
    queryFn: () => listLiveAudioRooms(farcasterAuthToken as string),
    enabled: Boolean(farcasterAuthToken),
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  // Scheduled rooms tick on a slower cadence — they only change when
  // someone creates one. 5 minutes keeps the strip warm without
  // hammering the server.
  const { data: scheduledRooms } = useQuery<AudioRoom[]>({
    queryKey: ['discover-audio-rooms', 'scheduled'] as const,
    queryFn: () => listScheduledAudioRooms(farcasterAuthToken as string),
    enabled: Boolean(farcasterAuthToken),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const live = React.useMemo(
    () => (liveRooms ?? []).filter((r) => r.state === 'live'),
    [liveRooms],
  );

  // Show scheduled rooms that start within 24h so the strip doesn't
  // fill with months-away placeholders. Sorted soonest first.
  const upcoming = React.useMemo(() => {
    const now = Date.now();
    const horizon = now + 24 * 60 * 60_000;
    return (scheduledRooms ?? [])
      .filter((r) => r.state === 'scheduled')
      .map((r) => ({ r, at: r.scheduledAt ? Date.parse(r.scheduledAt) : Number.NaN }))
      .filter(({ at }) => Number.isFinite(at) && at >= now && at <= horizon)
      .sort((a, b) => a.at - b.at)
      .map(({ r }) => r);
  }, [scheduledRooms]);

  const [createOpen, setCreateOpen] = React.useState(false);
  // Hide the whole strip only when there's no content AND no auth —
  // an authed user with no live/upcoming rooms still wants the create
  // tile so they can be the one to start a space.
  if (!farcasterAuthToken && live.length === 0 && upcoming.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: theme.colors.textMuted }]}>
        {live.length > 0
          ? 'Live spaces'
          : upcoming.length > 0
            ? 'Upcoming spaces'
            : 'Spaces'}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {farcasterAuthToken && (
          <CreateTile onPress={() => setCreateOpen(true)} />
        )}
        {live.map((room) => (
          <SpaceCard
            key={room.id}
            room={room}
            isJoined={active?.id === room.id}
            onPress={() => join(room.id, { castHash: room.rootCastHash })}
          />
        ))}
        {upcoming.map((room) => (
          <SpaceCard
            key={room.id}
            room={room}
            isJoined={false}
            // Scheduled rooms aren't live-joinable; tapping shows the
            // preview/RSVP sheet via the context's `state: 'scheduled'`
            // branch.
            onPress={() => join(room.id, { castHash: room.rootCastHash })}
          />
        ))}
      </ScrollView>
      <CreateSpaceSheet visible={createOpen} onClose={() => setCreateOpen(false)} />
    </View>
  );
}

/** Leftmost tile in the strip — opens the CreateSpaceSheet. */
function CreateTile({ onPress }: { onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.createTile,
        {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.accent,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: Skin.radius(18),
          backgroundColor: theme.colors.accent,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: Skin.space(8),
        }}
      >
        <IconSymbol name="plus" size={20} color="#fff" />
      </View>
      <Text
        style={{
          color: theme.colors.textStrong,
          fontSize: Skin.font(13),
          fontWeight: '600',
          textAlign: 'center',
        }}
      >
        Start a space
      </Text>
      <Text
        style={{
          color: theme.colors.textMuted,
          fontSize: Skin.font(11),
          marginTop: Skin.space(2),
          textAlign: 'center',
        }}
      >
        Now or schedule
      </Text>
    </Pressable>
  );
}

function SpaceCard({
  room,
  isJoined,
  onPress,
}: {
  room: AudioRoom;
  isJoined: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  const isLive = room.state === 'live';
  const isScheduled = room.state === 'scheduled';

  const host = room.host;
  const hostName = host?.displayName || host?.username || (host ? `fid:${host.fid}` : '');
  const hostPfp = host?.pfp?.url ?? host?.pfpUrl;

  const scheduledLabel = (() => {
    if (!isScheduled || !room.scheduledAt) return null;
    const at = new Date(room.scheduledAt);
    if (Number.isNaN(at.getTime())) return null;
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (at.toDateString() === now.toDateString()) return `Today ${time}`;
    if (at.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
    return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  })();

  const accentBorderColor = isLive ? '#FF3B30' : theme.colors.accent;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.colors.surface2,
          borderColor: isJoined ? theme.colors.accent : accentBorderColor,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.cardHeader}>
        {isLive ? (
          <View style={[styles.livePill, { backgroundColor: theme.colors.danger }]}>
            <View style={styles.liveDot} />
            <Text style={styles.livePillText}>LIVE</Text>
          </View>
        ) : (
          <View style={[styles.livePill, { backgroundColor: theme.colors.accent }]}>
            <Text style={styles.livePillText}>{scheduledLabel ?? 'SCHEDULED'}</Text>
          </View>
        )}
        {isLive && typeof room.listenerCount === 'number' && (
          <Text style={[styles.listenerCount, { color: theme.colors.textMuted }]}>
            {formatCount(room.listenerCount)}
          </Text>
        )}
      </View>

      <Text
        style={[styles.title, { color: theme.colors.textStrong }]}
        numberOfLines={2}
      >
        {room.title || 'Audio space'}
      </Text>

      {host && (
        <View style={styles.avatarStack}>
          <View
            style={[
              styles.avatarWrap,
              { borderColor: theme.colors.surface2 },
            ]}
          >
            {hostPfp ? (
              <Image source={{ uri: hostPfp }} style={styles.avatar} recyclingKey={hostPfp} />
            ) : (
              <View style={[styles.avatar, { backgroundColor: theme.colors.surface3 }]} />
            )}
          </View>
          <Text
            style={[styles.hostName, { color: theme.colors.textMain }]}
            numberOfLines={1}
          >
            {hostName}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

const CARD_WIDTH = 220;

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    paddingTop: Skin.space(4),
    paddingBottom: Skin.space(8),
  },
  label: {
    fontSize: Skin.font(12),
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: Skin.space(16),
    marginBottom: Skin.space(8),
  },
  scrollContent: {
    paddingHorizontal: Skin.space(12),
    gap: Skin.space(10),
  },
  card: {
    width: CARD_WIDTH,
    padding: Skin.space(12),
    borderRadius: Skin.radius(12),
    borderWidth: Skin.border(1),
    gap: Skin.space(10),
  },
  createTile: {
    // Narrower than a discovery card — invitation-sized rather than
    // content-sized — and dashed-styled to feel distinct from the
    // populated cards next to it.
    width: 140,
    padding: Skin.space(12),
    borderRadius: Skin.radius(12),
    borderWidth: Skin.border(1),
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(4),
    paddingHorizontal: Skin.space(6),
    paddingVertical: Skin.space(2),
    borderRadius: Skin.radius(4),
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: Skin.radius(3),
    backgroundColor: '#fff',
  },
  livePillText: {
    color: '#fff',
    fontSize: Skin.font(10),
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  listenerCount: {
    fontSize: Skin.font(12),
    fontWeight: '500',
  },
  title: {
    fontSize: Skin.font(14),
    fontWeight: '600',
    lineHeight: Skin.font(18),
  },
  avatarStack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarWrap: {
    width: 24,
    height: 24,
    borderRadius: Skin.radius(12),
    borderWidth: Skin.border(2),
    overflow: 'hidden',
  },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: Skin.radius(10),
  },
  hostName: {
    fontSize: Skin.font(12),
    fontWeight: '500',
    marginLeft: Skin.space(8),
    flex: 1,
  },
}));
