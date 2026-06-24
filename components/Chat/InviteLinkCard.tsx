/**
 * InviteLinkCard - Renders an invite link as a card with join button
 *
 * Detects invite links in messages and renders them as rich cards
 * showing space info with a join button.
 */

import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth, useWebSocket } from '@/context';
import { useJoinSpace, useValidateInvite } from '@/hooks/chat/useSpaceActions';
import { useSpaces } from '@/hooks/chat/useSpaces';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { SpaceIcon } from '@/components/ui/SpaceIcon';
import * as Skin from '@/theme/skins/geometry';

// Valid invite link prefixes for detection
const VALID_INVITE_PREFIXES = [
  'https://qm.one/',
  'https://qm.one/#',
  'https://quorummessenger.com/i/',
  'https://www.quorummessenger.com/i/',
  'https://app.quorummessenger.com/#',
  'https://app.quorummessenger.com/invite/#',
  'http://localhost:3000/',
  'http://localhost:3000/i/',
  'qm.one/',
];

/**
 * Check if a string contains an invite link
 */
export function containsInviteLink(text: string): boolean {
  return VALID_INVITE_PREFIXES.some(prefix => text.includes(prefix));
}

/**
 * Extract invite link from text
 */
export function extractInviteLink(text: string): string | null {
  for (const prefix of VALID_INVITE_PREFIXES) {
    const startIndex = text.indexOf(prefix);
    if (startIndex !== -1) {
      // Find the end of the URL (space or end of string)
      const restOfText = text.substring(startIndex);
      const endIndex = restOfText.search(/[\s<>"{}|\\^`[\]]/);
      if (endIndex === -1) {
        return restOfText;
      }
      return restOfText.substring(0, endIndex);
    }
  }
  return null;
}

/**
 * Strip invite link from text, returning the remaining content
 * Returns null if the entire message was just the invite link
 */
export function stripInviteLink(text: string): string | null {
  const inviteLink = extractInviteLink(text);
  if (!inviteLink) return text;

  // Remove the invite link from the text
  const stripped = text.replace(inviteLink, '').trim();

  // Return null if nothing left (message was just the link)
  return stripped.length > 0 ? stripped : null;
}

interface InviteLinkCardProps {
  inviteLink: string;
  messageSenderId?: string;
  onJoinSuccess?: (spaceId: string, channelId: string) => void;
}

export function InviteLinkCard({
  inviteLink,
  messageSenderId,
  onJoinSuccess,
}: InviteLinkCardProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const { user } = useAuth();
  const { subscribe, enqueueOutbound } = useWebSocket();

  // Validate and fetch space info
  const {
    data: spaceInfo,
    isLoading: isValidating,
    error: validationError,
  } = useValidateInvite(inviteLink);

  // Join space mutation
  const joinMutation = useJoinSpace();

  // Check if user already belongs to this space
  const { data: userSpaces } = useSpaces();
  const isAlreadyMember = useMemo(() => {
    if (!spaceInfo || !userSpaces) return false;
    return userSpaces.some(s => s.spaceId === spaceInfo.spaceId);
  }, [spaceInfo, userSpaces]);

  // Check if current user sent this message
  const isSender = useMemo(() => {
    return messageSenderId && user?.address && messageSenderId === user.address;
  }, [messageSenderId, user?.address]);

  // Button state
  const buttonState = useMemo(() => {
    if (joinMutation.isPending) {
      return { text: 'Joining...', disabled: true };
    }
    if (isAlreadyMember && !isSender) {
      return { text: 'Joined', disabled: true };
    }
    if (isSender) {
      return { text: 'Invite sent', disabled: true };
    }
    return { text: 'Join', disabled: false };
  }, [joinMutation.isPending, isAlreadyMember, isSender]);

  const handleJoin = async () => {
    if (buttonState.disabled) return;

    try {
      const result = await joinMutation.mutateAsync({ inviteLink });
      // Subscribe to the new space inbox immediately
      if (result.inboxAddress) {
        await subscribe([result.inboxAddress]);
      }

      // Send join control message to announce ourselves to other participants
      if (result.joinMessageEnvelope) {
        enqueueOutbound(async () => [result.joinMessageEnvelope!]);
      }

      // Hook the new space into the per-hub log transport so existing
      // log entries get delivered without waiting for a WS reconnect.
      const { subscribeAndCatchUpHubLog } = await import('@/services/space/hubLogSync');
      void subscribeAndCatchUpHubLog(result.spaceId, enqueueOutbound);

      onJoinSuccess?.(result.spaceId, result.channelId);
    } catch (error) {
      // Join failed
    }
  };

  // Error state
  if (validationError) {
    const msg = validationError instanceof Error ? validationError.message : '';
    let display = 'Could not validate invite';
    if (msg.includes('Invalid')) display = 'Invalid invite link';
    else if (msg.includes('not found') || msg.includes('404')) display = 'Space manifest missing on server (creator may need to re-upload)';
    else if (msg.includes('manifest') || msg.includes('fetch')) display = 'Space not reachable';
    else if (msg.includes('decrypt')) display = 'Wrong invite key';
    else if (msg) display = msg;
    return (
      <View style={styles.errorContainer}>
        <IconSymbol name="exclamationmark.triangle.fill" size={16} color={theme.colors.warning ?? '#f59e0b'} />
        <Text style={styles.errorText}>{display}</Text>
      </View>
    );
  }

  // Loading state
  if (isValidating || !spaceInfo) {
    return (
      <View style={styles.container}>
        <View style={styles.skeletonIcon} />
        <View style={styles.skeletonContent}>
          <View style={styles.skeletonTitle} />
          <View style={styles.skeletonDescription} />
        </View>
        <View style={styles.skeletonButton} />
      </View>
    );
  }

  // Truncate description
  const description = spaceInfo.description
    ? spaceInfo.description.length > 100
      ? spaceInfo.description.substring(0, 100) + '...'
      : spaceInfo.description
    : null;

  return (
    <View style={styles.container}>
      {/* Card row: icon + info + join button */}
      <View style={styles.cardRow}>
        {/* Space Icon */}
        <View style={styles.iconContainer}>
          {spaceInfo.iconUrl ? (
            <Image source={{ uri: spaceInfo.iconUrl }} style={styles.icon} />
          ) : (
            <SpaceIcon name={spaceInfo.spaceName} size={44} style={styles.icon} />
          )}
        </View>

        {/* Space Info */}
        <View style={styles.infoContainer}>
          <Text style={styles.spaceName} numberOfLines={1}>
            {spaceInfo.spaceName}
          </Text>
          {description && (
            <Text style={styles.description} numberOfLines={2}>
              {description}
            </Text>
          )}
        </View>

        {/* Join Button */}
        <TouchableOpacity
          style={[
            styles.joinButton,
            buttonState.disabled && styles.joinButtonDisabled,
            isAlreadyMember && styles.joinButtonJoined,
          ]}
          onPress={handleJoin}
          disabled={buttonState.disabled}
        >
          {joinMutation.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text
              style={[
                styles.joinButtonText,
                buttonState.disabled && styles.joinButtonTextDisabled,
              ]}
            >
              {buttonState.text}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Join Error — in normal flow below the row so the card grows to fit it
          (was absolutely positioned and clipped when the invite was the last
          message; see issue #20). */}
      {joinMutation.error && (
        <View style={styles.joinErrorContainer}>
          <Text style={styles.joinErrorText}>
            {joinMutation.error instanceof Error
              ? joinMutation.error.message
              : 'Failed to join'}
          </Text>
        </View>
      )}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.border,
      padding: Skin.space(12),
      marginTop: Skin.space(8),
      maxWidth: 400,
    },
    cardRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    iconContainer: {
      marginRight: Skin.space(12),
    },
    icon: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(8),
    },
    infoContainer: {
      flex: 1,
      marginRight: Skin.space(12),
    },
    spaceName: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textStrong,
    },
    description: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
      lineHeight: Skin.font(18),
    },
    joinButton: {
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(8),
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(8),
      minWidth: 70,
      alignItems: 'center',
    },
    joinButtonDisabled: {
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
    },
    joinButtonJoined: {
      backgroundColor: theme.colors.success ?? '#22c55e',
    },
    joinButtonText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: '#fff',
    },
    joinButtonTextDisabled: {
      color: theme.colors.textMuted,
    },
    errorContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: (theme.colors.warning ?? '#f59e0b') + '15',
      borderRadius: Skin.radius(8),
      padding: Skin.space(10),
      marginTop: Skin.space(8),
      gap: Skin.space(8),
    },
    errorText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.warning ?? '#f59e0b',
    },
    joinErrorContainer: {
      marginTop: Skin.space(8),
    },
    joinErrorText: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.danger ?? '#ef4444',
    },
    // Skeleton loading styles
    skeletonIcon: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
      marginRight: Skin.space(12),
    },
    skeletonContent: {
      flex: 1,
      marginRight: Skin.space(12),
    },
    skeletonTitle: {
      width: '70%',
      height: 16,
      borderRadius: Skin.radius(4),
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
    },
    skeletonDescription: {
      width: '90%',
      height: 12,
      borderRadius: Skin.radius(4),
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
      marginTop: Skin.space(6),
    },
    skeletonButton: {
      width: 70,
      height: 32,
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
    },
  });

export default InviteLinkCard;
