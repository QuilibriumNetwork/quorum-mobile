/**
 * Buffering and pausing shared by the inline video players.
 *
 * expo-video prepares a player as soon as it's created, and on Android
 * ExoPlayer's default load control then buffers up to 50 s ahead whether or
 * not anything is playing. A first-frame preview nobody pressed play on was
 * downloading most of a minute of video.
 */
import { createContext, useContext, useEffect } from 'react';
import type { BufferOptions, VideoPlayer } from 'expo-video';
import { useScreenFocused } from '@/hooks/useScreenFocused';

/** A paused preview holds a couple of seconds: enough for its first frame. */
export const PREVIEW_BUFFER_OPTIONS: BufferOptions = {
  preferredForwardBufferDuration: 2,
  minBufferForPlayback: 1,
  waitsToMinimizeStalling: true,
};

/** expo-video's own defaults, for once the user presses play. */
export const PLAYBACK_BUFFER_OPTIONS: BufferOptions = {};

/** Raise the buffer to the playback defaults and start playing. */
export function startPlayback(player: VideoPlayer): void {
  player.bufferOptions = PLAYBACK_BUFFER_OPTIONS;
  player.play();
}

/**
 * Whether the screen holding this media is the one on top. The feed stacks
 * thread, profile and channel screens over itself and keeps every one mounted,
 * so a screen sets this to false for everything under the top one. Outside a
 * provider it's true.
 */
export const MediaOnTopContext = createContext(true);

/** Whether media here is on a screen the user is looking at: on top, and in a
 *  focused tab (tabs stay mounted when you leave them). */
export function useMediaOnScreen(): boolean {
  const onTop = useContext(MediaOnTopContext);
  const focused = useScreenFocused();
  return onTop && focused;
}

/**
 * Pause `player` when its screen goes out of view. It doesn't resume on
 * return; the user presses play again. `onPaused` lets the caller update its
 * play button.
 */
export function usePauseWhenOffScreen(player: VideoPlayer, onPaused?: () => void): void {
  const onScreen = useMediaOnScreen();
  useEffect(() => {
    if (onScreen) return;
    player.pause();
    onPaused?.();
    // onPaused is a state setter or a fresh closure each render; only a change
    // in visibility should pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen, player]);
}
