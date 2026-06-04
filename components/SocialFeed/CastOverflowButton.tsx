/**
 * CastOverflowButton — the ••• moderation menu on an individual cast (feed
 * or thread). Opens a themed ActionSheet with Report / Mute / Block (or
 * Unmute / Unblock). Mute & block hit the Farcaster web-client visibility
 * endpoints via `useUserVisibilityActions` (no protocol-level support);
 * report is delegated up via `onReport` so the host can drive its existing
 * ReportModal flow.
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
import { requestTranslateText } from '@/services/translation/forceTranslate';
import {
  ensureAvailabilityProbed,
  translationAvailableCached,
} from '@/services/translation/availability';
import type { AppTheme } from '@/theme';

interface CastOverflowButtonProps {
  castHash: string;
  authorFid?: number;
  authorUsername?: string;
  /** The cast body text — enables the "Translate" action when present. */
  castText?: string;
  /** Opens the host's report flow for this cast. */
  onReport: (castHash: string, authorFid?: number) => void;
  /** Deletes the cast — only wired/shown for the viewer's own casts. */
  onDelete?: (castHash: string) => void;
  theme: AppTheme;
  /** Icon size — defaults to 16 to sit in a cast header/action row. */
  size?: number;
  color?: string;
}

export function CastOverflowButton({
  castHash,
  authorFid,
  authorUsername,
  castText,
  onReport,
  onDelete,
  theme,
  size = 16,
  color,
}: CastOverflowButtonProps) {
  const { user, farcasterAuthToken } = useAuth();
  const ownFid = user?.farcaster?.fid;
  const { fids: blockedFids } = useBlockedFids();
  const { fids: mutedFids } = useMutedFids();
  const { mute, unmute, block, unblock } = useUserVisibilityActions();

  const [sheetOpen, setSheetOpen] = React.useState(false);

  // Show "Translate" only when on-device translation is available. Optimistic
  // until the one-time probe resolves (most devices support it).
  const [translateAvailable, setTranslateAvailable] = React.useState(
    translationAvailableCached() ?? true
  );
  React.useEffect(() => {
    ensureAvailabilityProbed().then(setTranslateAvailable);
  }, []);
  const canTranslate = translateAvailable && !!castText && castText.trim().length > 0;

  const who = authorUsername ? `@${authorUsername}` : 'this user';
  const fail = (verb: string) =>
    Alert.alert('Something went wrong', `Couldn't ${verb} ${who}. Please try again.`);

  // Mute/block need the author's fid, a Farcaster token, and that it isn't us.
  const canModerateUser =
    typeof authorFid === 'number' &&
    authorFid > 0 &&
    authorFid !== ownFid &&
    Boolean(farcasterAuthToken);
  const isMuted = canModerateUser && mutedFids.has(authorFid!);
  const isBlocked = canModerateUser && blockedFids.has(authorFid!);

  // Delete is offered only for the viewer's own casts, and only when the host
  // wired an `onDelete` handler.
  const isOwnCast =
    typeof authorFid === 'number' && authorFid > 0 && authorFid === ownFid && !!onDelete;

  const actions: ActionSheetAction[] = [
    ...(isOwnCast
      ? [
          {
            label: 'Delete cast',
            icon: 'trash',
            destructive: true,
            onPress: () => {
              Alert.alert(
                'Delete cast?',
                'This permanently removes your cast for everyone.',
                [
                  { text: 'Cancel', style: 'cancel' as const },
                  {
                    text: 'Delete',
                    style: 'destructive' as const,
                    onPress: () => onDelete!(castHash),
                  },
                ],
              );
            },
          },
        ]
      : []),
    ...(canTranslate
      ? [
          {
            label: 'Translate',
            icon: 'globe',
            onPress: () => requestTranslateText(castText!),
          },
        ]
      : []),
    {
      label: 'Report cast',
      icon: 'flag',
      destructive: true,
      onPress: () => onReport(castHash, authorFid),
    },
    ...(canModerateUser
      ? [
          isMuted
            ? {
                label: `Unmute ${who}`,
                icon: 'bell.fill',
                onPress: () => {
                  void unmute(authorFid!).catch(() => fail('unmute'));
                },
              }
            : {
                label: `Mute ${who}`,
                icon: 'bell.slash.fill',
                onPress: () => {
                  void mute(authorFid!).catch(() => fail('mute'));
                },
              },
          isBlocked
            ? {
                label: `Unblock ${who}`,
                icon: 'checkmark.circle',
                onPress: () => {
                  void unblock(authorFid!).catch(() => fail('unblock'));
                },
              }
            : {
                label: `Block ${who}`,
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
                          void block(authorFid!).catch(() => fail('block'));
                        },
                      },
                    ],
                  );
                },
              },
        ]
      : []),
  ];

  return (
    <View>
      <TouchableOpacity
        onPress={() => setSheetOpen(true)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="More options"
      >
        <IconSymbol name="ellipsis" size={size} color={color ?? theme.colors.textMuted} />
      </TouchableOpacity>
      <ActionSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={authorUsername ? `@${authorUsername}` : undefined}
        actions={actions}
      />
    </View>
  );
}
