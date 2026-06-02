/**
 * ProfileOverflowButton — the ••• menu on another user's Farcaster profile.
 *
 * Opens a themed ActionSheet with mute/block (or unmute/unblock) actions,
 * wired to the Farcaster web-client visibility endpoints via
 * `useUserVisibilityActions`. There's no protocol-level mute/block, so this
 * is the same mechanism the official app uses. Renders nothing when the
 * viewer is looking at their own profile or isn't signed in to Farcaster.
 */

import React from 'react';
import { Alert, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { ActionSheet, type ActionSheetAction } from '@/components/shared';
import { useAuth } from '@/context/AuthContext';
import { useBlockedFids } from '@/hooks/useBlockedFids';
import { useMutedFids } from '@/hooks/useMutedFids';
import { useUserVisibilityActions } from '@/hooks/useUserVisibilityActions';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface ProfileOverflowButtonProps {
  targetFid: number;
  username?: string;
  theme: AppTheme;
}

export function ProfileOverflowButton({
  targetFid,
  username,
  theme,
}: ProfileOverflowButtonProps) {
  const { user, farcasterAuthToken } = useAuth();
  const ownFid = user?.farcaster?.fid;
  const { fids: blockedFids } = useBlockedFids();
  const { fids: mutedFids } = useMutedFids();
  const { mute, unmute, block, unblock } = useUserVisibilityActions();

  const [sheetOpen, setSheetOpen] = React.useState(false);

  // Don't offer the menu on your own profile, for invalid fids, or when
  // there's no Farcaster token to act with.
  if (!targetFid || targetFid <= 0 || targetFid === ownFid || !farcasterAuthToken) {
    return null;
  }

  const isBlocked = blockedFids.has(targetFid);
  const isMuted = mutedFids.has(targetFid);
  const who = username ? `@${username}` : 'this user';

  const fail = (verb: string) =>
    Alert.alert('Something went wrong', `Couldn't ${verb} ${who}. Please try again.`);

  const actions: ActionSheetAction[] = [
    isMuted
      ? {
          label: 'Unmute',
          icon: 'bell.fill',
          onPress: () => {
            void unmute(targetFid).catch(() => fail('unmute'));
          },
        }
      : {
          label: 'Mute',
          icon: 'bell.slash.fill',
          onPress: () => {
            void mute(targetFid).catch(() => fail('mute'));
          },
        },
    isBlocked
      ? {
          label: 'Unblock',
          icon: 'checkmark.circle',
          onPress: () => {
            void unblock(targetFid).catch(() => fail('unblock'));
          },
        }
      : {
          label: 'Block',
          icon: 'nosign',
          destructive: true,
          onPress: () => {
            Alert.alert(
              `Block ${who}?`,
              "They won't be able to see your casts or interact with you, and their replies are hidden from you.",
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Block',
                  style: 'destructive',
                  onPress: () => {
                    void block(targetFid).catch(() => fail('block'));
                  },
                },
              ],
            );
          },
        },
  ];

  return (
    <View>
      <TouchableOpacity
        onPress={() => setSheetOpen(true)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={{
          width: 36,
          height: 36,
          borderRadius: Skin.radius(18),
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.surface3,
        }}
        accessibilityRole="button"
        accessibilityLabel="More options"
      >
        <IconSymbol name="ellipsis" size={18} color={theme.colors.textMain} />
      </TouchableOpacity>
      <ActionSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={username ? `@${username}` : undefined}
        actions={actions}
      />
    </View>
  );
}
