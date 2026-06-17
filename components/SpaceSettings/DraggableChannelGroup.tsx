import React, { useCallback } from 'react';
import { View, Text, StyleSheet, AccessibilityActionEvent } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import type { Channel } from '@quilibrium/quorum-shared';

// Fixed row height drives the reorder math. Matches `channelItem` in
// SpaceSettingsModal: paddingVertical 8 (x2) + 28px icon button = 44.
export const CHANNEL_ROW_HEIGHT = 44;

export interface DraggableChannelGroupProps {
  groupIndex: number;
  channels: Channel[];
  defaultChannelId: string;
  /**
   * Ref to the RNGH ScrollView wrapping the Channels tab. Threaded down to the
   * Pan gesture (Task 5) so a drag wins over the scroll. In Task 3 (static,
   * pre-drag) this is unused — accept it now so the prop shape is stable.
   * Typed loosely (object | null) to avoid importing the RNGH ScrollView ref
   * type into this file; the gesture only needs the ref object.
   */
  scrollRef: React.RefObject<unknown>;
  /** Resolve a channel iconColor to a hex string (passed from the modal). */
  resolveIconColor: (iconColor: string | undefined, fallback: string) => string;
  /** Tapping a row opens that channel's settings drawer. */
  onOpenChannel: (channelId: string) => void;
  /** Renders the lock/star status glyphs for a channel. */
  renderStatusGlyphs: (channel: Channel) => React.ReactNode;
  /** a11y: move a channel up one position within its group. */
  onMoveUp: (groupIndex: number, channelIndex: number) => void;
  /** a11y: move a channel down one position within its group. */
  onMoveDown: (groupIndex: number, channelIndex: number) => void;
  /** Persist a new full channel order for this group. */
  onReorder: (groupIndex: number, channelOrder: string[]) => void;
}

export function DraggableChannelGroup({
  groupIndex,
  channels,
  defaultChannelId: _defaultChannelId,
  scrollRef: _scrollRef,
  resolveIconColor,
  onOpenChannel,
  renderStatusGlyphs,
  onMoveUp,
  onMoveDown,
  onReorder: _onReorder,
}: DraggableChannelGroupProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const handleAccessibilityAction = useCallback(
    (channelIndex: number) => (e: AccessibilityActionEvent) => {
      if (e.nativeEvent.actionName === 'moveUp') onMoveUp(groupIndex, channelIndex);
      else if (e.nativeEvent.actionName === 'moveDown') onMoveDown(groupIndex, channelIndex);
    },
    [groupIndex, onMoveUp, onMoveDown],
  );

  return (
    <View style={{ height: channels.length * CHANNEL_ROW_HEIGHT }}>
      {channels.map((channel, channelIndex) => {
        const a11yActions = [];
        if (channelIndex > 0) a11yActions.push({ name: 'moveUp', label: 'Move up' });
        if (channelIndex < channels.length - 1)
          a11yActions.push({ name: 'moveDown', label: 'Move down' });

        return (
          <View
            key={channel.channelId}
            style={[styles.row, { top: channelIndex * CHANNEL_ROW_HEIGHT }]}
            accessibilityRole="none"
            accessibilityLabel={`Channel ${channel.channelName}`}
            accessibilityActions={a11yActions}
            onAccessibilityAction={handleAccessibilityAction(channelIndex)}
          >
            <TouchableOpacity
              style={[
                styles.iconButton,
                channel.icon && {
                  backgroundColor:
                    resolveIconColor(channel.iconColor, theme.colors.textMuted) + '20',
                },
              ]}
              onPress={() => onOpenChannel(channel.channelId)}
            >
              <IconSymbol
                name={(channel.icon || 'hashtag') as IconSymbolName}
                size={14}
                color={resolveIconColor(channel.iconColor, theme.colors.textMuted)}
                variant={channel.iconVariant ?? 'outline'}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.nameContainer}
              onPress={() => onOpenChannel(channel.channelId)}
              accessibilityLabel={`Channel ${channel.channelName}. Double tap to open settings.`}
            >
              <Text style={styles.name}>{channel.channelName}</Text>
            </TouchableOpacity>
            {renderStatusGlyphs(channel)}
            <View
              style={styles.handle}
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden={true}
            >
              <IconSymbol name={'grip.vertical' as IconSymbolName} size={16} color={theme.colors.textMuted} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    row: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: CHANNEL_ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(12),
      backgroundColor: theme.colors.surface3,
    },
    iconButton: {
      width: 28,
      height: 28,
      borderRadius: Skin.radius(6),
      backgroundColor: theme.colors.surface4,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: Skin.space(6),
    },
    nameContainer: { flex: 1 },
    name: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    handle: {
      padding: Skin.space(8),
      marginLeft: Skin.space(4),
    },
  });
