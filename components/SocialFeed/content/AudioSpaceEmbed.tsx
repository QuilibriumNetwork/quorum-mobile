/**
 * AudioSpaceEmbed — renders `https://farcaster.xyz/~/spaces/<uuid>`
 * cast embeds as a live audio-space card. Fetches the room metadata
 * (title, host, listener count, state) and surfaces a Join button
 * that hands off to `AudioSpaceContext`.
 *
 * Phase 0 scope — the audio plumbing lives in the context provider's
 * overlay, not here. This component only owns the discovery card.
 */

import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAudioSpace } from '@/context/AudioSpaceContext';
import { useAuth } from '@/context/AuthContext';
import { fetchAudioRoom, type AudioRoom } from '@/services/spaces/spacesClient';
import { useFarcasterUserPersistent } from '@/hooks/useFarcasterUserPersistent';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface AudioSpaceEmbedProps {
  spaceId: string;
  /** Hash of the cast that contains this space embed. Used as the
   *  anchor for chat (direct replies to this cast). When omitted,
   *  the overlay's chat panel will be hidden. */
  castHash?: string;
  /** Fallback action when we can't fetch room details (e.g., user
   *  isn't signed in to Farcaster). Defaults to opening the original
   *  URL externally. */
  onFallbackOpen?: () => void;
}

export function AudioSpaceEmbed({ spaceId, castHash, onFallbackOpen }: AudioSpaceEmbedProps) {
  const { theme } = useTheme();
  const { farcasterAuthToken } = useAuth();
  const { join } = useAudioSpace();

  const { data: room, isLoading } = useQuery<AudioRoom | null>({
    queryKey: ['audio-room', spaceId] as const,
    queryFn: () => fetchAudioRoom(spaceId, farcasterAuthToken as string),
    enabled: Boolean(spaceId) && Boolean(farcasterAuthToken),
    // Rooms tick — listener counts move every few seconds — but we
    // don't want to hammer the API from a feed cell either.
    staleTime: 15_000,
    refetchInterval: (q) => (q.state.data?.state === 'live' ? 20_000 : false),
  });

  // Host comes denormalized on the room snapshot. Fall back to a
  // separate user lookup when the server response only carries a fid
  // (older snapshot shapes).
  const denormalizedHost = room?.host;
  const { data: lookedUpHost } = useFarcasterUserPersistent(
    denormalizedHost ? undefined : (room as { hostFid?: number } | undefined)?.hostFid,
  );
  const host = denormalizedHost ?? lookedUpHost ?? null;
  const hostPfpUrl = denormalizedHost
    ? (denormalizedHost.pfp?.url ?? denormalizedHost.pfpUrl)
    : lookedUpHost?.pfpUrl;

  const isLive = room?.state === 'live';
  const isEnded = room?.state === 'ended';
  const isScheduled = room?.state === 'scheduled';

  // Human-readable scheduled-at: "Today at HH:MM" / "Tomorrow at HH:MM"
  // / "Mon DD at HH:MM".
  const scheduledLabel = React.useMemo(() => {
    if (!isScheduled || !room?.scheduledAt) return null;
    const at = new Date(room.scheduledAt);
    if (Number.isNaN(at.getTime())) return null;
    const now = new Date();
    const today = now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (at.toDateString() === today) return `Today at ${time}`;
    if (at.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
    return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
  }, [isScheduled, room?.scheduledAt]);

  const containerStyle = {
    backgroundColor: theme.colors.surface2,
    borderRadius: Skin.radius(12),
    padding: Skin.space(12),
    marginHorizontal: Skin.space(12),
    borderWidth: Skin.border(1),
    borderColor: isLive ? theme.colors.danger : theme.colors.surface3,
  };

  const handleJoin = () => {
    if (!room || isEnded) {
      onFallbackOpen?.();
      return;
    }
    join(spaceId, { castHash });
  };

  return (
    <Pressable
      onPress={handleJoin}
      style={({ pressed }) => [containerStyle, { opacity: pressed ? 0.85 : 1 }]}
    >
      {/* Header: state pill + listener count */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(8), marginBottom: Skin.space(8) }}>
        <View
          style={{
            backgroundColor: isLive
              ? theme.colors.danger
              : isEnded
                ? theme.colors.surface3
                : theme.colors.accent,
            borderRadius: Skin.radius(4),
            paddingHorizontal: Skin.space(6),
            paddingVertical: Skin.space(2),
            flexDirection: 'row',
            alignItems: 'center',
            gap: Skin.space(4),
          }}
        >
          {isLive && (
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: Skin.radius(3),
                backgroundColor: '#fff',
              }}
            />
          )}
          <Text style={{ color: '#fff', fontSize: Skin.font(11), fontWeight: '700', letterSpacing: 0.5 }}>
            {isLive ? 'LIVE' : isEnded ? 'ENDED' : room?.state === 'scheduled' ? 'SCHEDULED' : 'SPACE'}
          </Text>
        </View>
        {isLive && typeof room?.listenerCount === 'number' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}>
            <IconSymbol name="person.2.fill" size={12} color={theme.colors.textMuted} />
            <Text style={{ color: theme.colors.textSubtle, fontSize: Skin.font(12) }}>
              {room.listenerCount}
            </Text>
          </View>
        )}
        <View style={{ flex: 1 }} />
        {isLoading && <ActivityIndicator size="small" color={theme.colors.textMuted} />}
      </View>

      {/* Title + host */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(10) }}>
        <CachedAvatar
          source={hostPfpUrl ? { uri: hostPfpUrl } : null}
          style={{
            width: 36,
            height: 36,
            borderRadius: Skin.radius(18),
            backgroundColor: theme.colors.surface3,
          }}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(14) }}
            numberOfLines={2}
          >
            {room?.title || 'Audio space'}
          </Text>
          {host?.username && (
            <Text style={{ color: theme.colors.textSubtle, fontSize: Skin.font(12), marginTop: Skin.space(2) }} numberOfLines={1}>
              by @{host.username}
              {scheduledLabel ? ` · ${scheduledLabel}` : ''}
            </Text>
          )}
        </View>
        {!isEnded && (
          <View
            style={{
              backgroundColor: theme.colors.accent,
              borderRadius: Skin.radius(16),
              paddingVertical: Skin.space(6),
              paddingHorizontal: Skin.space(14),
            }}
          >
            <Text style={{ color: '#fff', fontSize: Skin.font(13), fontWeight: '600' }}>
              {isLive ? 'Join' : 'Open'}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}
