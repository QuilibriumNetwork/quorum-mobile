/**
 * A YouTube link shows its thumbnail until tapped, then loads the player.
 *
 * ## The regression this pins
 *
 * Every YouTube link in a cast mounted `react-native-youtube-iframe`'s player
 * as it scrolled into view: a WebView loading YouTube's iframe API and player
 * page, megabytes per link, for videos nobody pressed play on.
 *
 * ## What is asserted
 *
 * - Before a tap there is no player, only the thumbnail from i.ytimg.com.
 * - A tap mounts the player for the same video and asks it to play.
 * - The player is told to pause when its screen is covered.
 */
import React from 'react';
import { act, cleanup, fireEvent } from '@testing-library/react-native';
import { Image as ExpoImage } from 'expo-image';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { YouTubeEmbed } from '@/components/SocialFeed/media/YouTubeEmbed';
import { MediaOnTopContext } from '@/components/SocialFeed/media/videoPlayback';
import { DarkTheme } from '@/theme';

const mockPlayerProps: { videoId?: string; play?: boolean }[] = [];
jest.mock('react-native-youtube-iframe', () => ({
  __esModule: true,
  default: (props: { videoId?: string; play?: boolean }) => {
    mockPlayerProps.push(props);
    return null;
  },
}));

const VIDEO_ID = 'dQw4w9WgXcQ';

let setOnTop: (onTop: boolean) => void = () => {};

function Screen() {
  const [onTop, setState] = React.useState(true);
  setOnTop = setState;
  return (
    <MediaOnTopContext.Provider value={onTop}>
      <YouTubeEmbed videoId={VIDEO_ID} theme={DarkTheme} width={320} />
    </MediaOnTopContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  mockPlayerProps.length = 0;
});

it('shows the thumbnail and no player until tapped, then plays', () => {
  const root = renderWithProviders(<Screen />);
  expect(mockPlayerProps).toHaveLength(0);
  expect(root.UNSAFE_getByType(ExpoImage).props.source.uri).toBe(
    `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
  );

  fireEvent.press(root.getByLabelText('Play YouTube video'));
  const latest = mockPlayerProps[mockPlayerProps.length - 1];
  expect(latest.videoId).toBe(VIDEO_ID);
  expect(latest.play).toBe(true);
});

it('tells the player to pause when its screen is covered', () => {
  const root = renderWithProviders(<Screen />);
  fireEvent.press(root.getByLabelText('Play YouTube video'));

  act(() => setOnTop(false));
  expect(mockPlayerProps[mockPlayerProps.length - 1].play).toBe(false);
});
