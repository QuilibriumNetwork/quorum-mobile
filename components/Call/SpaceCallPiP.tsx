/**
 * SpaceCallPiP - Floating picture-in-picture overlay for an active space call.
 */

import React, { useEffect, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { RTCView } from 'react-native-webrtc';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import { useTheme } from '@/theme';
import { useSpaceCall } from '@/context/SpaceCallContext';
import { IconSymbol } from '@/components/ui/IconSymbol';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const VIDEO_PIP_WIDTH = 150;
const VIDEO_PIP_HEIGHT = 100;
const AUDIO_PIP_SIZE = 60;
const SPRING_CONFIG = { damping: 20, stiffness: 200 };

interface SpaceCallPiPProps {
  onExpand: () => void;
}

export function SpaceCallPiP({ onExpand }: SpaceCallPiPProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { state, leaveCall, getLocalStream } = useSpaceCall();
  const [showLeave, setShowLeave] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const isVideo = state.isVideoEnabled;
  const pipW = isVideo ? VIDEO_PIP_WIDTH : AUDIO_PIP_SIZE;
  const pipH = isVideo ? VIDEO_PIP_HEIGHT : AUDIO_PIP_SIZE;

  const minX = 8;
  const minY = insets.top + 8;
  const maxX = SCREEN_WIDTH - pipW - 8;
  const maxY = SCREEN_HEIGHT - pipH - insets.bottom - 80;

  const translateX = useSharedValue(maxX);
  const translateY = useSharedValue(minY);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  useEffect(() => {
    const interval = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const snapToCorner = (x: number, y: number) => {
    'worklet';
    const centerX = x + pipW / 2;
    const centerY = y + pipH / 2;
    const midX = SCREEN_WIDTH / 2;
    const midY = SCREEN_HEIGHT / 2;
    const snapX = centerX < midX ? minX : maxX;
    const snapY = centerY < midY ? minY : maxY;
    translateX.value = withSpring(snapX, SPRING_CONFIG);
    translateY.value = withSpring(snapY, SPRING_CONFIG);
  };

  const panGesture = Gesture.Pan()
    .onStart(() => {
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((e) => {
      translateX.value = Math.max(minX, Math.min(maxX, startX.value + e.translationX));
      translateY.value = Math.max(minY, Math.min(maxY, startY.value + e.translationY));
    })
    .onEnd(() => {
      snapToCorner(translateX.value, translateY.value);
    });

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(onExpand)();
  });

  const longPressGesture = Gesture.LongPress()
    .minDuration(500)
    .onEnd(() => {
      runOnJS(setShowLeave)(true);
    });

  const gesture = Gesture.Race(panGesture, Gesture.Exclusive(longPressGesture, tapGesture));

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  // Auto-hide leave button after 3 seconds
  useEffect(() => {
    if (!showLeave) return;
    const t = setTimeout(() => setShowLeave(false), 3000);
    return () => clearTimeout(t);
  }, [showLeave]);

  const localStream = getLocalStream();
  // @ts-ignore — react-native-webrtc MediaStream has toURL()
  const localStreamURL = localStream ? localStream.toURL() : null;

  const formatShort = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.container, { width: pipW, height: pipH }, animatedStyle]}>
        {isVideo && localStreamURL ? (
          <View style={styles.videoContainer}>
            <RTCView
              // @ts-ignore react-native-webrtc's RTCView types don't expose streamURL on RN ≥0.75
              streamURL={localStreamURL}
              style={styles.video}
              objectFit="cover"
              mirror
            />
            <View style={styles.timerOverlay}>
              <Text style={styles.timerText}>{formatShort(elapsed)}</Text>
            </View>
            {state.isMuted && (
              <View style={styles.mutedBadge}>
                <IconSymbol name="mic.slash.fill" size={10} color="#fff" />
              </View>
            )}
          </View>
        ) : (
          <View style={[styles.audioCircle, { backgroundColor: theme.colors.surface3 }]}>
            <IconSymbol
              name={state.isMuted ? 'mic.slash.fill' : 'speaker.wave.2.fill'}
              size={20}
              color={state.isMuted ? theme.colors.danger : theme.colors.success}
            />
            <Text style={[styles.audioTimer, { color: theme.colors.textMuted }]} numberOfLines={1}>
              {formatShort(elapsed)}
            </Text>
          </View>
        )}

        {showLeave && (
          <TouchableOpacity
            style={styles.leaveButton}
            onPress={() => { leaveCall(); setShowLeave(false); }}
          >
            <IconSymbol name="phone.down.fill" size={12} color="#fff" />
          </TouchableOpacity>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    position: 'absolute',
    zIndex: 9998,
    borderRadius: Skin.radius(12),
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  videoContainer: {
    flex: 1,
    borderRadius: Skin.radius(12),
    overflow: 'hidden',
  },
  video: {
    flex: 1,
  },
  timerOverlay: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: Skin.radius(4),
    paddingHorizontal: Skin.space(4),
    paddingVertical: Skin.space(1),
  },
  timerText: {
    color: '#fff',
    fontSize: Skin.font(10),
    fontVariant: ['tabular-nums'],
  },
  mutedBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(255,59,48,0.8)',
    borderRadius: Skin.radius(8),
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioCircle: {
    flex: 1,
    borderRadius: Skin.radius(30),
    alignItems: 'center',
    justifyContent: 'center',
    gap: Skin.space(2),
  },
  audioTimer: {
    fontSize: Skin.font(9),
    fontVariant: ['tabular-nums'],
  },
  leaveButton: {
    position: 'absolute',
    top: -12,
    right: -12,
    backgroundColor: '#ff3b30',
    borderRadius: Skin.radius(12),
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
