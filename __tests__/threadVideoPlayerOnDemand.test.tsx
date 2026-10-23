/**
 * A thread or profile video creates its native player only when play is tapped.
 *
 * ## The regression this pins
 *
 * `SocialFeed/media/VideoPlayer` (the thread and profile screens opened from
 * the in-app browser and channel panels) called `useVideoPlayer` as it
 * mounted. expo-video prepares a player as soon as it's created, and ExoPlayer
 * buffers up to 50 s ahead even while paused, so every video row in a thread
 * downloaded most of a minute of video whether or not anyone watched it.
 *
 * ## What is asserted
 *
 * - A row mounts as a poster, with no player.
 * - Tapping play creates the player and starts it.
 * - A playing video pauses when its screen is no longer on top.
 */
import React from 'react';
import { act, cleanup, fireEvent } from '@testing-library/react-native';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { VideoPlayer } from '@/components/SocialFeed/media/VideoPlayer';
import { MediaOnTopContext } from '@/components/SocialFeed/media/videoPlayback';
import { DarkTheme } from '@/theme';

const mockPlayersByUrl = new Map<string, { play: jest.Mock; pause: jest.Mock }>();
jest.mock('expo-video', () => ({
  useVideoPlayer: (url: string, setup?: (player: unknown) => void) => {
    let player = mockPlayersByUrl.get(url);
    if (!player) {
      player = { play: jest.fn(), pause: jest.fn(), addListener: () => ({ remove: () => {} }) } as never;
      mockPlayersByUrl.set(url, player!);
      setup?.(player);
    }
    return player;
  },
  VideoView: () => null,
}));
jest.mock('expo-audio', () => ({ setAudioModeAsync: jest.fn() }));
jest.mock('@/services/media/saveToLibrary', () => ({ saveMediaToLibrary: jest.fn() }));
jest.mock('@/components/SocialFeed/media/VideoViewer', () => ({ VideoViewer: () => null }));

const URL_A = 'https://example.invalid/a.m3u8';
const URL_B = 'https://example.invalid/b.m3u8';

afterEach(() => {
  cleanup();
  mockPlayersByUrl.clear();
});

let setOnTop: (onTop: boolean) => void = () => {};

function Screen() {
  const [onTop, setState] = React.useState(true);
  setOnTop = setState;
  return (
    <MediaOnTopContext.Provider value={onTop}>
      <VideoPlayer url={URL_A} thumbnailUrl="https://example.invalid/a.jpg" theme={DarkTheme} />
      <VideoPlayer url={URL_B} thumbnailUrl="https://example.invalid/b.jpg" theme={DarkTheme} />
    </MediaOnTopContext.Provider>
  );
}

it('shows posters and creates no player until play is tapped', () => {
  const root = renderWithProviders(<Screen />);
  expect(mockPlayersByUrl.size).toBe(0);

  fireEvent.press(root.getAllByLabelText('Play video')[1]);
  expect([...mockPlayersByUrl.keys()]).toEqual([URL_B]);
  expect(mockPlayersByUrl.get(URL_B)!.play).toHaveBeenCalled();
});

it('pauses a playing video when its screen is covered', () => {
  const root = renderWithProviders(<Screen />);
  fireEvent.press(root.getAllByLabelText('Play video')[0]);
  const player = mockPlayersByUrl.get(URL_A)!;
  expect(player.pause).not.toHaveBeenCalled();

  act(() => setOnTop(false));
  expect(player.pause).toHaveBeenCalled();
});
