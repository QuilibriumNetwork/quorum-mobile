import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
  makeMutable,
  type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
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
   * Pan gesture so a drag wins over the scroll.
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

interface DraggableRowProps {
  channel: Channel;
  index: number;
  count: number;
  styles: ReturnType<typeof createStyles>;
  theme: AppTheme;
  activeIndex: SharedValue<number>;
  dragY: SharedValue<number>;
  animY: SharedValue<number>;
  scale: SharedValue<number>;
  positions: SharedValue<number[]>;
  scrollRef: React.RefObject<unknown>;
  iconColor: string;
  iconBg: string | undefined;
  statusGlyphs: React.ReactNode;
  a11yActions: { name: string; label: string }[];
  onOpen: () => void;
  onAccessibilityAction: (e: AccessibilityActionEvent) => void;
  onSwapHaptic: () => void;
  onLiftHaptic: () => void;
  onDropHaptic: () => void;
  onPersist: (visualOrder: number[]) => void;
  // animY values for ALL rows — needed on the UI thread to spring idle rows on swap
  allAnimY: SharedValue<number>[];
}

function DraggableRow({
  channel, index, count, styles, theme,
  activeIndex, dragY, animY, scale, positions, scrollRef,
  iconColor, iconBg, statusGlyphs, a11yActions,
  onOpen, onAccessibilityAction,
  onSwapHaptic, onLiftHaptic, onDropHaptic, onPersist,
  allAnimY,
}: DraggableRowProps) {
  const ROW = CHANNEL_ROW_HEIGHT;

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(0)
        .simultaneousWithExternalGesture(
          scrollRef as React.RefObject<React.ComponentType | undefined>
        )
        .onStart(() => {
          activeIndex.value = index;
          dragY.value = 0;
          scale.value = withSpring(1.03, { damping: 15, stiffness: 200 });
          runOnJS(onLiftHaptic)();
        })
        .onUpdate((e) => {
          dragY.value = e.translationY;
          // Target slot = which slot the dragged row's centre is currently over,
          // computed from the row's resting top (index * ROW) plus finger offset.
          const absY = index * ROW + e.translationY;
          const targetSlot = Math.max(0, Math.min(count - 1, Math.round(absY / ROW)));
          const currentSlot = positions.value.indexOf(index);
          if (targetSlot !== currentSlot) {
            const next = [...positions.value];
            next.splice(currentSlot, 1);
            next.splice(targetSlot, 0, index);
            positions.value = next;
            // Spring idle rows to their new slot positions immediately
            for (let i = 0; i < next.length; i++) {
              const rowIndex = next[i];
              if (rowIndex !== index) {
                allAnimY[rowIndex].value = withSpring(i * ROW, { damping: 20, stiffness: 220 });
              }
            }
            runOnJS(onSwapHaptic)();
          }
        })
        .onEnd((_, success) => {
          if (!success) return;
          const finalOrder = positions.value;
          // Snap active row to its final resting slot
          const finalSlot = finalOrder.indexOf(index);
          animY.value = withSpring(finalSlot * ROW, { damping: 20, stiffness: 220 });
          runOnJS(onPersist)(finalOrder);
          runOnJS(onDropHaptic)();
        })
        .onFinalize(() => {
          activeIndex.value = -1;
          dragY.value = 0;
          scale.value = withSpring(1, { damping: 15, stiffness: 200 });
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, count, scrollRef]
  );

  const animatedStyle = useAnimatedStyle(() => {
    const isActive = activeIndex.value === index;
    if (isActive) {
      return {
        top: 0,
        transform: [{ translateY: animY.value + dragY.value }, { scale: scale.value }],
        zIndex: 999,
        elevation: 8,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 4 },
        backgroundColor: theme.colors.surface4,
      };
    }
    return {
      top: 0,
      transform: [{ translateY: animY.value }, { scale: 1 }],
      zIndex: 0,
      elevation: 0,
      shadowOpacity: 0,
      backgroundColor: theme.colors.surface3,
    };
  });

  return (
    <Animated.View
      style={[styles.row, animatedStyle]}
      accessibilityRole="adjustable"
      accessibilityLabel={`Channel ${channel.channelName}`}
      accessibilityActions={a11yActions}
      onAccessibilityAction={onAccessibilityAction}
    >
      <TouchableOpacity
        style={[styles.iconButton, iconBg ? { backgroundColor: iconBg } : null]}
        onPress={onOpen}
      >
        <IconSymbol
          name={(channel.icon || 'hashtag') as IconSymbolName}
          size={14}
          color={iconColor}
          variant={channel.iconVariant ?? 'outline'}
        />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.nameContainer}
        onPress={onOpen}
        accessibilityLabel={`Channel ${channel.channelName}. Double tap to open settings.`}
      >
        <Text style={styles.name} numberOfLines={1}>
          {channel.channelName}
        </Text>
      </TouchableOpacity>
      {statusGlyphs}
      <GestureDetector gesture={pan}>
        <View
          style={styles.handle}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden={true}
        >
          <IconSymbol name={'grip.vertical' as IconSymbolName} size={16} color={theme.colors.textMuted} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

export function DraggableChannelGroup({
  groupIndex,
  channels,
  defaultChannelId: _defaultChannelId,
  scrollRef,
  resolveIconColor,
  onOpenChannel,
  renderStatusGlyphs,
  onMoveUp,
  onMoveDown,
  onReorder,
}: DraggableChannelGroupProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const activeIndex = useSharedValue(-1);
  const positions = useSharedValue<number[]>(channels.map((_, i) => i));

  // Per-row shared values stored in a ref — created once, never recreated.
  // `makeMutable` is Reanimated's low-level shared value factory that can be
  // called outside the render cycle safely (unlike useSharedValue which is
  // a hook). We store them in a ref so they survive re-renders.
  const rowValuesRef = React.useRef<{
    animY: SharedValue<number>[];
    scale: SharedValue<number>[];
    dragY: SharedValue<number>[];
  } | null>(null);

  if (!rowValuesRef.current || rowValuesRef.current.animY.length < channels.length) {
    const prev = rowValuesRef.current;
    const start = prev ? prev.animY.length : 0;
    const animY = prev ? [...prev.animY] : [];
    const scale = prev ? [...prev.scale] : [];
    const dragY = prev ? [...prev.dragY] : [];
    for (let i = start; i < channels.length; i++) {
      animY.push(makeMutable(i * CHANNEL_ROW_HEIGHT));
      scale.push(makeMutable(1));
      dragY.push(makeMutable(0));
    }
    rowValuesRef.current = { animY, scale, dragY };
  }

  const { animY, scale, dragY } = rowValuesRef.current;

  React.useEffect(() => {
    if (activeIndex.value === -1) {
      positions.value = channels.map((_, i) => i);
      // Reset each row's animated position to its natural slot
      for (let i = 0; i < channels.length; i++) {
        animY[i].value = i * CHANNEL_ROW_HEIGHT;
      }
    }
  }, [channels, positions, activeIndex, animY]);

  const persistOrder = useCallback(
    (visualOrder: number[]) => {
      const channelOrder = visualOrder.map((i) => channels[i].channelId);
      onReorder(groupIndex, channelOrder);
    },
    [channels, groupIndex, onReorder]
  );

  const haptic = useCallback((style: 'light' | 'medium' | 'select') => {
    if (style === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (style === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else Haptics.selectionAsync();
  }, []);

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
        const a11yActions: { name: string; label: string }[] = [];
        if (channelIndex > 0) a11yActions.push({ name: 'moveUp', label: 'Move up' });
        if (channelIndex < channels.length - 1)
          a11yActions.push({ name: 'moveDown', label: 'Move down' });
        const color = resolveIconColor(channel.iconColor, theme.colors.textMuted);
        return (
          <DraggableRow
            key={channel.channelId}
            channel={channel}
            index={channelIndex}
            count={channels.length}
            styles={styles}
            theme={theme}
            activeIndex={activeIndex}
            dragY={dragY[channelIndex]}
            animY={animY[channelIndex]}
            scale={scale[channelIndex]}
            positions={positions}
            scrollRef={scrollRef}
            iconColor={color}
            iconBg={channel.icon ? color + '20' : undefined}
            statusGlyphs={renderStatusGlyphs(channel)}
            a11yActions={a11yActions}
            onOpen={() => onOpenChannel(channel.channelId)}
            onAccessibilityAction={handleAccessibilityAction(channelIndex)}
            onLiftHaptic={() => haptic('light')}
            onSwapHaptic={() => haptic('select')}
            onDropHaptic={() => haptic('medium')}
            onPersist={persistOrder}
            allAnimY={animY}
          />
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
