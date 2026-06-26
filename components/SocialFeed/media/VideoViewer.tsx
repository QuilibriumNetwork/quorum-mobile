import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, StyleSheet, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useVideoPlayer, VideoView } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { saveMediaToLibrary } from '@/services/media/saveToLibrary';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../utils';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ReanimatedView = Reanimated.View;

const SWIPE_DOWN_THRESHOLD = 100;
const VELOCITY_THRESHOLD = 500;

// Mirror VideoPlayer's silent-switch audio setup so fullscreen playback is
// audible even when the device is muted. Idempotent.
let audioModeConfigured = false;
async function ensureAudioMode() {
  if (audioModeConfigured) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      allowsRecording: false,
    });
    audioModeConfigured = true;
  } catch {
    // Audio still plays, just not in silent mode.
  }
}

interface VideoViewerProps {
  visible: boolean;
  url: string;
  /** Preferred URL for save-to-library (the original source). `url` is usually
   *  the HLS manifest, which can't be saved; fall back to it only if needed. */
  downloadUrl?: string;
  onClose: () => void;
}

/**
 * Full-screen video viewer — the in-app counterpart to ImageViewer.
 *
 * We use this instead of expo-video's native `enterFullscreen()` because the
 * feed's VideoView runs with `nativeControls={false}`, so native fullscreen
 * presented with no chrome: no close button, no swipe-to-dismiss, and no way
 * to add a Save affordance. This modal restores all three (swipe-down dismiss,
 * close button, save button) and keeps native transport controls (scrubber /
 * play-pause) for the video itself.
 *
 * Mount it only while fullscreen is active so we don't spin up a second
 * player for every video in the feed.
 */
export function VideoViewer({ visible, url, downloadUrl, onClose }: VideoViewerProps) {
  const [saving, setSaving] = useState(false);
  const insets = useSafeAreaInsets();

  // Prefer the original source for saving; `url` is usually an HLS manifest
  // (can't be saved). Only fall back to `url` if there's no better option.
  const isHls = (u?: string) => !!u && /\.m3u8(\?|#|$)/i.test(u);
  const saveUrl = downloadUrl && !isHls(downloadUrl) ? downloadUrl : url;

  const player = useVideoPlayer(url, (p) => {
    p.loop = false;
    p.play();
  });

  useEffect(() => {
    ensureAudioMode();
  }, []);

  // Pause/resume with visibility (the parent keeps this mounted only while
  // open, but guard anyway).
  useEffect(() => {
    if (visible) player.play();
    else player.pause();
  }, [visible, player]);

  const handleSave = useCallback(async () => {
    if (!saveUrl || saving) return;
    setSaving(true);
    const result = await saveMediaToLibrary(saveUrl, 'video');
    setSaving(false);
    if (result.ok) {
      Alert.alert('Saved', 'Video saved to your library.');
    } else {
      const message =
        result.reason === 'permission_denied'
          ? 'Photo library permission was denied. Enable it in Settings → Quorum.'
          : result.reason === 'download_failed'
            ? `Couldn’t download the video${result.detail ? ` (${result.detail})` : ''}.`
            : result.reason === 'invalid_url'
              ? 'This video can’t be saved.'
              : `Couldn’t save the video${result.detail ? ` (${result.detail})` : ''}.`;
      Alert.alert('Save failed', message);
    }
  }, [saveUrl, saving]);

  // Swipe down to dismiss. activeOffsetY only claims clear downward drags, and
  // failOffsetX lets horizontal scrubber drags fall through to the native
  // video controls underneath.
  const dismissTranslateY = useSharedValue(0);
  const dismissOpacity = useSharedValue(1);

  useEffect(() => {
    if (visible) {
      dismissTranslateY.value = 0;
      dismissOpacity.value = 1;
    }
  }, [visible]);

  const panGesture = Gesture.Pan()
    .activeOffsetY(20)
    .failOffsetX([-20, 20])
    .onUpdate((e) => {
      dismissTranslateY.value = Math.max(0, e.translationY);
      dismissOpacity.value = interpolate(
        e.translationY,
        [0, SCREEN_HEIGHT * 0.3],
        [1, 0.3],
        Extrapolation.CLAMP
      );
    })
    .onEnd((e) => {
      const shouldDismiss =
        e.translationY > SWIPE_DOWN_THRESHOLD || e.velocityY > VELOCITY_THRESHOLD;
      if (shouldDismiss) {
        dismissTranslateY.value = withTiming(SCREEN_HEIGHT, { duration: 200 });
        dismissOpacity.value = withTiming(0, { duration: 200 });
        runOnJS(onClose)();
      } else {
        dismissTranslateY.value = withTiming(0, { duration: 150 });
        dismissOpacity.value = withTiming(1, { duration: 150 });
      }
    });

  const containerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: dismissOpacity.value,
    transform: [{ translateY: dismissTranslateY.value }],
  }));

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      // Full-screen media viewer goes edge-to-edge under the bottom nav bar too.
      navigationBarTranslucent
    >
      <GestureHandlerRootView style={styles.gestureRoot}>
        <ReanimatedView style={[styles.container, containerAnimatedStyle]}>
          {/* Header: save + close (mirrors ImageViewer) */}
          <View style={[styles.header, { top: insets.top + 8 }]}>
            <View />
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={[styles.headerButton, saving && { opacity: 0.5 }]}
                onPress={handleSave}
                disabled={saving}
                hitSlop={8}
                accessibilityLabel="Save video to library"
              >
                <IconSymbol name="square.and.arrow.down" color="#fff" size={22} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.headerButton}
                onPress={onClose}
                hitSlop={8}
                accessibilityLabel="Close"
              >
                <IconSymbol name="xmark" color="#fff" size={24} />
              </TouchableOpacity>
            </View>
          </View>

          <GestureDetector gesture={panGesture}>
            <ReanimatedView style={styles.videoWrap}>
              <VideoView
                player={player}
                style={styles.video}
                contentFit="contain"
                nativeControls
                allowsFullscreen={false}
              />
            </ReanimatedView>
          </GestureDetector>
        </ReanimatedView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  header: {
    position: 'absolute',
    // `top` is applied inline (insets.top + 8) so the buttons clear the status
    // bar / camera cutout in edge-to-edge mode.
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Skin.space(20),
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(8),
  },
  headerButton: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: Skin.radius(20),
    padding: Skin.space(10),
  },
  videoWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
}));

export default VideoViewer;
