/**
 * ChannelHeader — the top bar for a Space channel.
 *
 * A thin composition over ScreenHeader, which owns all header geometry and
 * explains why these bars are drawn in React Native rather than by the native
 * navigation stack. Only the channel-specific controls live here.
 */

import type { AppTheme } from '@/theme';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { ScreenHeader, headerIconHitSlop } from '@/components/ui/ScreenHeader';
import React from 'react';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';

interface ChannelHeaderProps {
  channelName: string;
  /** Safe-area top inset — the bar paints into the status bar area itself. */
  insetTop: number;
  onBack: () => void;
  onStartVideoCall: () => void;
  onStartAudioCall: () => void;
  /** Invite is owner-only, mirroring the space settings entry point. */
  onInvite?: () => void;
  onOpenSettings: () => void;
  theme: AppTheme;
}

export const ChannelHeader = React.memo(function ChannelHeader({
  channelName,
  insetTop,
  onBack,
  onStartVideoCall,
  onStartAudioCall,
  onInvite,
  onOpenSettings,
  theme,
}: ChannelHeaderProps) {
  return (
    <ScreenHeader
      title={`# ${channelName}`}
      insetTop={insetTop}
      onBack={onBack}
      accessibilityBackLabel="Back to channel list"
      theme={theme}
      right={
        <>
          <TouchableOpacity
            onPress={onStartVideoCall}
            hitSlop={headerIconHitSlop}
            accessibilityRole="button"
            accessibilityLabel="Start a video call"
          >
            <IconSymbol name="video" color={theme.colors.primary} size={20} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onStartAudioCall}
            hitSlop={headerIconHitSlop}
            accessibilityRole="button"
            accessibilityLabel="Start a voice call"
          >
            <IconSymbol name="phone" color={theme.colors.primary} size={20} />
          </TouchableOpacity>
          {onInvite && (
            <TouchableOpacity
              onPress={onInvite}
              hitSlop={headerIconHitSlop}
              accessibilityRole="button"
              accessibilityLabel="Invite people to this space"
            >
              <IconSymbol name="person.badge.plus" color={theme.colors.textMain} size={20} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={onOpenSettings}
            hitSlop={headerIconHitSlop}
            accessibilityRole="button"
            accessibilityLabel="Space settings"
          >
            <IconSymbol name="gearshape" color={theme.colors.textMain} size={20} />
          </TouchableOpacity>
        </>
      }
    />
  );
});

export default ChannelHeader;
