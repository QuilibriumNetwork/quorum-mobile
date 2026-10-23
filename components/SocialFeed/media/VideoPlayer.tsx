import type { AppTheme } from '@/theme';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { saveMediaToLibrary } from '@/services/media/saveToLibrary';
import { VideoViewer } from './VideoViewer';
import { startPlayback, usePauseWhenOffScreen } from './videoPlayback';
import { SCREEN_WIDTH, SCREEN_HEIGHT, formatDuration } from '../utils';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

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
const staticStyles = createSkinnable(() => StyleSheet.create({
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
    borderRadius: Skin.circleOrSquare(30),
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  durationBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: Skin.space(6),
    paddingVertical: Skin.space(2),
    borderRadius: Skin.radius(4),
  },
  durationText: {
    color: '#fff',
    fontSize: Skin.font(12),
    fontFamily: Skin.fontFamily('medium'),
    fontWeight: '500',
  },
  saveButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: Skin.radius(18),
    padding: Skin.space(8),
  },
}));

interface VideoPlayerProps {
  url: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  duration?: number;
  theme: AppTheme;
}

/**
 * Video with a poster, tap to play/pause. It shows the poster (or a sized
 * placeholder when there isn't one) until the user taps play, and only then
 * creates a native player. Creating one on mount, as this used to, prepared
 * and buffered every video in a thread or profile as it scrolled into view.
 */
export function VideoPlayer(props: VideoPlayerProps) {
  const { url, thumbnailUrl, width, height, duration, theme } = props;
  // The URL the user pressed play on. Reset when a recycled cell moves to
  // another video.
  const [activated, setActivated] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const save = useSaveVideo(url);

  const aspectRatio = width && height ? height / width : 9 / 16;
  const calculatedHeight = Math.min(SCREEN_WIDTH * aspectRatio, SCREEN_HEIGHT * 0.8);
  const mediaStyle = useMemo(() => ({
    width: SCREEN_WIDTH,
    height: calculatedHeight,
    backgroundColor: theme.colors.surface3,
  }), [calculatedHeight, theme.colors.surface3]);

  const viewer = fullscreen ? (
    <VideoViewer visible url={url} onClose={() => setFullscreen(false)} />
  ) : null;

  if (activated === url) {
    return (
      <>
        <LiveVideoPlayer
          {...props}
          mediaStyle={mediaStyle}
          save={save}
          onOpenFullscreen={() => setFullscreen(true)}
        />
        {viewer}
      </>
    );
  }

  return (
    <>
    <Pressable onPress={() => setFullscreen(true)} style={staticStyles.container}>
      <VideoPoster
        thumbnailUrl={thumbnailUrl}
        duration={duration}
        mediaStyle={mediaStyle}
        save={save}
        onPlay={() => setActivated(url)}
      />
    </Pressable>
    {viewer}
    </>
  );
}

/** Save-to-library state and handler for a video. */
function useSaveVideo(url: string) {
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
  return { saving, handleSave };
}

type SaveVideo = ReturnType<typeof useSaveVideo>;

function SaveButton({ save }: { save: SaveVideo }) {
  return (
    <Pressable
      style={[staticStyles.saveButton, save.saving && { opacity: 0.5 }]}
      onPress={save.handleSave}
      disabled={save.saving}
      hitSlop={8}
      accessibilityLabel="Save video to library"
    >
      <IconSymbol name="square.and.arrow.down" color="#fff" size={18} />
    </Pressable>
  );
}

function PlayButton({ onPress }: { onPress: () => void }) {
  return (
    <View style={staticStyles.overlay} pointerEvents="box-none">
      <Pressable
        style={staticStyles.playButton}
        onPress={onPress}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Play video"
      >
        <IconSymbol name="play.fill" color="#fff" size={28} />
      </Pressable>
    </View>
  );
}

/** The poster with its play button, save button and duration badge. */
function VideoPoster({
  thumbnailUrl,
  duration,
  mediaStyle,
  save,
  onPlay,
}: {
  thumbnailUrl: string;
  duration?: number;
  mediaStyle: { width: number; height: number; backgroundColor: string };
  save: SaveVideo;
  onPlay: () => void;
}) {
  return (
    <>
      <Image
        source={{ uri: thumbnailUrl }}
        style={mediaStyle}
        contentFit="cover"
      />
      {/* Play button overlay (interactive — its own tap target) */}
      <PlayButton onPress={onPlay} />
      {/* Save-to-library button. iOS native fullscreen player
          doesn't expose UI hooks, so the save affordance lives on
          the inline preview — visible before playback starts and
          again when paused. */}
      <SaveButton save={save} />
      {/* Duration badge */}
      {duration && duration > 0 && (
        <View style={staticStyles.durationBadge} pointerEvents="none">
          <Text style={staticStyles.durationText}>
            {formatDuration(duration)}
          </Text>
        </View>
      )}
    </>
  );
}

/** The video with its native player, mounted by a tap on play. */
function LiveVideoPlayer({
  url,
  thumbnailUrl,
  duration,
  mediaStyle,
  save,
  onOpenFullscreen,
}: VideoPlayerProps & {
  mediaStyle: { width: number; height: number; backgroundColor: string };
  save: SaveVideo;
  onOpenFullscreen: () => void;
}) {
  const [isPlaying, setIsPlaying] = useState(true);
  const [hasStarted, setHasStarted] = useState(true);
  const videoRef = useRef<VideoView>(null);

  // Configure audio mode on mount
  useEffect(() => {
    ensureAudioMode();
  }, []);

  const player = useVideoPlayer(url, (player) => {
    player.loop = false;
  });

  // Mounted by a tap on play: start right away.
  useEffect(() => {
    startPlayback(player);
  }, [player]);

  // Tabs stay mounted when you leave them; don't keep playing there.
  usePauseWhenOffScreen(player, () => setIsPlaying(false));

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
      startPlayback(player);
    } else if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      startPlayback(player);
      setIsPlaying(true);
    }
  };

  // Tap outside the play button opens the in-app fullscreen viewer (which has
  // its own player, close button, swipe-to-dismiss, and save button). Pause
  // the inline player so the two don't play over each other.
  const handleSurfaceTap = () => {
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    }
    onOpenFullscreen();
  };

  return (
    <Pressable onPress={handleSurfaceTap} style={staticStyles.container}>
      {!hasStarted ? (
        // Played to the end: back to the poster.
        <VideoPoster
          thumbnailUrl={thumbnailUrl}
          duration={duration}
          mediaStyle={mediaStyle}
          save={save}
          onPlay={handlePlayButtonTap}
        />
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
              <PlayButton onPress={handlePlayButtonTap} />
              <SaveButton save={save} />
            </>
          )}
        </>
      )}
    </Pressable>
  );
}

export default VideoPlayer;
