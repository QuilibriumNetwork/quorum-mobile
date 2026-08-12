/**
 * DMChatHeader — the top bar for a direct-message conversation.
 *
 * A thin composition over ScreenHeader, which owns all header geometry and
 * explains why these bars are drawn in React Native rather than by the native
 * navigation stack. Only the DM-specific content lives here: a tappable
 * avatar + name that opens the counterparty's profile, and the call/settings
 * controls (all suppressed for Farcaster conversations, which have neither).
 */

import type { AppTheme } from '@/theme';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { ScreenHeader, headerIconHitSlop } from '@/components/ui/ScreenHeader';
import { useResolvedName } from '@/identity';
import React from 'react';
import { Image, StyleSheet, Text } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface DMChatHeaderProps {
  /** Avatar URL, if the conversation has one. */
  icon?: string;
  /** Counterparty address. The header resolves its own display name from this
   *  (global scope — a DM has no per-space nickname) rather than trusting a
   *  name string the caller already computed, so the title text and the
   *  avatar's initials can never disagree about who this conversation is
   *  with. Also feeds the deterministic initials avatar fallback. */
  address: string;
  /** Safe-area top inset — the bar paints into the status bar area itself. */
  insetTop: number;
  onBack: () => void;
  /** Tapping the avatar or name opens the same profile modal an in-chat pfp does. */
  onTitlePress: () => void;
  /**
   * Farcaster DMs are read through the upstream API and support neither calls
   * nor our DM settings, so the whole trailing group is dropped for them.
   */
  isFarcasterConversation: boolean;
  onVideoCall: () => void;
  onAudioCall: () => void;
  onOpenSettings: () => void;
  /** Dev-only test-burst affordance; pass undefined outside __DEV__. */
  onDevBurst?: () => void;
  theme: AppTheme;
}

export const DMChatHeader = React.memo(function DMChatHeader({
  icon,
  address,
  insetTop,
  onBack,
  onTitlePress,
  isFarcasterConversation,
  onVideoCall,
  onAudioCall,
  onOpenSettings,
  onDevBurst,
  theme,
}: DMChatHeaderProps) {
  const styles = React.useMemo(() => createStyles(theme), [theme]);
  // `global`: a DM has no per-space nickname. `enrich`: bounded to exactly one
  // address per mount (this header renders one conversation at a time), so
  // the profile fetch that makes a `.q` possible here is affordable.
  const title = useResolvedName(address, { global: true, enrich: true });

  return (
    <ScreenHeader
      insetTop={insetTop}
      onBack={onBack}
      accessibilityBackLabel="Back to messages"
      theme={theme}
      title={
        <TouchableOpacity
          onPress={onTitlePress}
          activeOpacity={0.7}
          hitSlop={8}
          style={styles.titleRow}
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}'s profile`}
        >
          {icon ? (
            <Image source={{ uri: icon }} style={styles.avatar} />
          ) : (
            <DefaultAvatar resolvedName={title} address={address} size={28} />
          )}
          <Text style={styles.name} numberOfLines={1}>
            {title}
          </Text>
        </TouchableOpacity>
      }
      right={
        isFarcasterConversation ? undefined : (
          <>
            {onDevBurst && (
              <TouchableOpacity
                onPress={onDevBurst}
                hitSlop={headerIconHitSlop}
                accessibilityRole="button"
                accessibilityLabel="DM test burst (dev)"
              >
                <IconSymbol name="flask" color={theme.colors.textMuted} size={20} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={onVideoCall}
              hitSlop={headerIconHitSlop}
              accessibilityRole="button"
              accessibilityLabel="Start a video call"
            >
              <IconSymbol name="video" color={theme.colors.primary} size={20} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onAudioCall}
              hitSlop={headerIconHitSlop}
              accessibilityRole="button"
              accessibilityLabel="Start a voice call"
            >
              <IconSymbol name="phone" color={theme.colors.primary} size={20} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onOpenSettings}
              hitSlop={headerIconHitSlop}
              accessibilityRole="button"
              accessibilityLabel="Conversation settings"
            >
              <IconSymbol name="gearshape" color={theme.colors.textMain} size={20} />
            </TouchableOpacity>
          </>
        )
      }
    />
  );
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      minWidth: 0,
    },
    avatar: {
      width: 28,
      height: 28,
      borderRadius: Skin.circleOrSquare(14),
      backgroundColor: theme.colors.surface5,
    },
    name: {
      flexShrink: 1,
      ...theme.textStyles.headline,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
  });

export default DMChatHeader;
