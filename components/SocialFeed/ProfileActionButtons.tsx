/**
 * ProfileActionButtons — Follow/Following + Message row for another user's
 * Farcaster profile. Follow toggles via the Farcaster web-client follows
 * endpoint (optimistic); Message opens (or creates) the 1:1 direct-cast
 * conversation and navigates to the DM screen. Renders nothing on your own
 * profile.
 */

import React from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { router } from 'expo-router';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context/AuthContext';
import { followUser, unfollowUser } from '@/services/farcasterClient';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface ProfileActionButtonsProps {
  fid: number;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
  /** Viewer's current following state for this user (from viewerContext). */
  isFollowing?: boolean;
  theme: AppTheme;
}

/**
 * 1:1 direct-cast conversation id — the two participant FIDs, deduped, sorted
 * (lexicographically, matching the Farcaster client) and joined by '-'. Must
 * match the server's id so an existing conversation is reused.
 */
function buildDmConversationId(a: number, b: number): string {
  return Array.from(new Set([a, b])).sort().join('-');
}

export function ProfileActionButtons({
  fid,
  username,
  displayName,
  pfpUrl,
  isFollowing,
  theme,
}: ProfileActionButtonsProps) {
  const { user, farcasterAuthToken } = useAuth();
  const ownFid = user?.farcaster?.fid;

  // Local optimistic follow state, seeded from the profile's viewerContext.
  const [following, setFollowing] = React.useState<boolean>(Boolean(isFollowing));
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setFollowing(Boolean(isFollowing));
  }, [isFollowing]);

  if (!fid || fid <= 0 || fid === ownFid) return null;

  const toggleFollow = async () => {
    if (!farcasterAuthToken || busy) return;
    const next = !following;
    setFollowing(next); // optimistic
    setBusy(true);
    try {
      if (next) await followUser({ token: farcasterAuthToken, targetFid: fid });
      else await unfollowUser({ token: farcasterAuthToken, targetFid: fid });
    } catch {
      setFollowing(!next); // rollback
      Alert.alert('Something went wrong', `Couldn't ${next ? 'follow' : 'unfollow'} @${username ?? fid}.`);
    } finally {
      setBusy(false);
    }
  };

  const openDm = () => {
    if (!ownFid) {
      Alert.alert('Sign in required', 'Connect your Farcaster account to send messages.');
      return;
    }
    const convId = `farcaster:${buildDmConversationId(ownFid, fid)}`;
    router.push({
      pathname: '/messages/dm/[id]',
      params: {
        id: convId,
        fcFid: String(fid),
        fcUsername: username ?? '',
        fcDisplayName: displayName ?? '',
        fcPfp: pfpUrl ?? '',
      },
    });
  };

  return (
    <View style={{ flexDirection: 'row', gap: Skin.space(8), marginTop: Skin.space(12) }}>
      {farcasterAuthToken ? (
        <TouchableOpacity
          onPress={toggleFollow}
          disabled={busy}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: Skin.space(6),
            paddingVertical: Skin.space(9),
            borderRadius: Skin.radius(20),
            backgroundColor: following ? theme.colors.surface3 : theme.colors.accent,
          }}
        >
          {busy ? (
            <ActivityIndicator size="small" color={following ? theme.colors.textMain : '#fff'} />
          ) : (
            <>
              <IconSymbol
                name={following ? 'checkmark' : 'plus'}
                size={14}
                color={following ? theme.colors.textMain : '#fff'}
              />
              <Text
                style={{
                  color: following ? theme.colors.textMain : '#fff',
                  fontWeight: '600',
                  fontSize: Skin.font(14),
                }}
              >
                {following ? 'Following' : 'Follow'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        onPress={openDm}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: Skin.space(6),
          paddingVertical: Skin.space(9),
          borderRadius: Skin.radius(20),
          borderWidth: Skin.border(1),
          borderColor: theme.colors.surface3,
        }}
      >
        <IconSymbol name="bubble.left" size={14} color={theme.colors.textMain} />
        <Text style={{ color: theme.colors.textMain, fontWeight: '600', fontSize: Skin.font(14) }}>
          Message
        </Text>
      </TouchableOpacity>
    </View>
  );
}
