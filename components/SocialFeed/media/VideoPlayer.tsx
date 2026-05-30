import type { AppTheme } from '@/theme';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { saveMediaToLibrary } from '@/services/media/saveToLibrary';
import { SCREEN_WIDTH, SCREEN_HEIGHT, formatDuration } from '../utils';

// Configure audio mode for silent switch (one-time setup)
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
  } catch (e) {
    // Silently fail - audio will still work, just not in silent mode
  }
}

// Static styles that don't depend on theme or dynamic values
const staticStyles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  durationBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  durationText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  saveButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 18,
    padding: 8,
  },
});

interface VideoPlayerProps {
  url: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  duration?: number;
  theme: AppTheme;
}

/**
 * Video player with thumbnail preview and tap to play/pause.
 */
export function VideoPlayer({
  url,
  thumbnailUrl,
  width,
  height,
  duration,
  theme,
}: VideoPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!url || saving) return;
    setSaving(true);
    const result = await saveMediaToLibrary(url, 'video');
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
  }, [url, saving]);
  const videoRef = useRef<VideoView>(null);
  const aspectRatio = width && height ? height / width : 9 / 16;
  const calculatedHeight = Math.min(SCREEN_WIDTH * aspectRatio, SCREEN_HEIGHT * 0.8);

  const mediaStyle = useMemo(() => ({
    width: SCREEN_WIDTH,
    height: calculatedHeight,
    backgroundColor: theme.colors.surface3,
  }), [calculatedHeight, theme.colors.surface3]);

  // Configure audio mode on mount
  useEffect(() => {
    ensureAudioMode();
  }, []);

  // Create video player
  const player = useVideoPlayer(url, (player) => {
    player.loop = false;
  });

  // Listen for playback status changes
  useEffect(() => {
    const subscription = player.addListener('playingChange', (event) => {
      setIsPlaying(event.isPlaying);
    });

    const endSubscription = player.addListener('playToEnd', () => {
      setIsPlaying(false);
      setHasStarted(false);
      player.currentTime = 0;
    });

    return () => {
      subscription.remove();
      endSubscription.remove();
    };
  }, [player]);

  // Tap on the play button toggles play/pause.
  const handlePlayButtonTap = () => {
    if (!hasStarted) {
      setHasStarted(true);
      setIsPlaying(true);
      player.play();
    } else if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
  };

  // Tap outside the play button enters fullscreen (and starts playback if it
  // hasn't begun yet).
  const handleSurfaceTap = () => {
    if (!hasStarted) {
      setHasStarted(true);
      setIsPlaying(true);
      player.play();
    }
    // Defer until the VideoView is mounted (first start case).
    requestAnimationFrame(() => {
      videoRef.current?.enterFullscreen();
    });
  };

  return (
    <Pressable onPress={handleSurfaceTap} style={staticStyles.container}>
      {!hasStarted ? (
        <>
          <Image
            source={{ uri: thumbnailUrl }}
            style={mediaStyle}
            contentFit="cover"
          />
          {/* Play button overlay (interactive — its own tap target) */}
          <View style={staticStyles.overlay} pointerEvents="box-none">
            <Pressable style={staticStyles.playButton} onPress={handlePlayButtonTap} hitSlop={12}>
              <IconSymbol name="play.fill" color="#fff" size={28} />
            </Pressable>
          </View>
          {/* Save-to-library button. iOS native fullscreen player
              doesn't expose UI hooks, so the save affordance lives on
              the inline preview — visible before playback starts and
              again when paused. */}
          <Pressable
            style={[staticStyles.saveButton, saving && { opacity: 0.5 }]}
            onPress={handleSave}
            disabled={saving}
            hitSlop={8}
            accessibilityLabel="Save video to library"
          >
            <IconSymbol name="square.and.arrow.down" color="#fff" size={18} />
          </Pressable>
          {/* Duration badge */}
          {duration && duration > 0 && (
            <View style={staticStyles.durationBadge} pointerEvents="none">
              <Text style={staticStyles.durationText}>
                {formatDuration(duration)}
              </Text>
            </View>
          )}
        </>
      ) : (
        <>
          <VideoView
            ref={videoRef}
            player={player}
            style={mediaStyle}
            contentFit="contain"
            nativeControls={false}
            allowsFullscreen
          />
          {/* Pause indicator overlay - shown when paused (interactive button) */}
          {!isPlaying && (
            <>
              <View style={staticStyles.overlay} pointerEvents="box-none">
                <Pressable style={staticStyles.playButton} onPress={handlePlayButtonTap} hitSlop={12}>
                  <IconSymbol name="play.fill" color="#fff" size={28} />
                </Pressable>
              </View>
              <Pressable
                style={[staticStyles.saveButton, saving && { opacity: 0.5 }]}
                onPress={handleSave}
                disabled={saving}
                hitSlop={8}
                accessibilityLabel="Save video to library"
              >
                <IconSymbol name="square.and.arrow.down" color="#fff" size={18} />
              </Pressable>
            </>
          )}
        </>
      )}
    </Pressable>
  );
}

export default VideoPlayer;
