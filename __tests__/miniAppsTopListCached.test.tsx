/**
 * The Mini Apps screen keeps its discover list between visits, renders only
 * the cards near the screen, and asks for icons through expo-image.
 *
 * ## The regression this pins
 *
 * The screen fetched the top-50 list in a mount effect, and the Wallet tab
 * remounts it on every switch to Mini Apps, so each switch fetched it again.
 * All 50 cards then mounted at once in a ScrollView, each icon a React Native
 * `Image` (memory cache only) at its full upload size.
 *
 * ## What is asserted
 *
 * - Unmounting and mounting the screen again doesn't refetch the list.
 * - Fewer than all 50 cards are mounted at first.
 * - Icons are expo-image, at a sized URL where the host makes one.
 */
import React from 'react';
import { PixelRatio, Image as RNImage } from 'react-native';
import { act, cleanup, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Image as ExpoImage } from 'expo-image';
import { renderWithProviders } from '@/jest/renderWithProviders';
import MiniAppsModal from '@/components/MiniAppsModal';
import { sizedImageUrl } from '@/utils/imageVariants';

jest.mock('@/context', () => ({ useAuth: () => ({ farcasterAuthToken: null }) }));
jest.mock('@/services/miniapp/addedMiniapps', () => ({ getAddedMiniapps: () => [] }));
jest.mock('@/services/miniapp/recentMiniapps', () => ({
  getRecentMiniapps: () => [],
  recordMiniappUse: jest.fn(),
}));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const APP_COUNT = 50;
const icon = (i: number) => `https://imagedelivery.net/acct/icon-${i}/original`;
const frames = Array.from({ length: APP_COUNT }, (_, i) => ({
  domain: `app${i}.example`,
  name: `App ${i}`,
  homeUrl: `https://app${i}.example/`,
  iconUrl: icon(i),
}));

let fetchMock: jest.Mock;
let queryClient: QueryClient;

beforeEach(() => {
  jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: { frames } }),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  jest.restoreAllMocks();
});

function renderScreen() {
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <MiniAppsModal visible onClose={() => {}} isRouteMode noTopInset />
    </QueryClientProvider>,
  );
}

const topFrameFetches = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('top-frameapps')).length;

it('keeps the discover list when the screen is left and opened again', async () => {
  // App 5: the first five are also in the Featured row.
  const first = renderScreen();
  await waitFor(() => expect(first.getByText('App 5')).toBeTruthy());
  expect(topFrameFetches()).toBe(1);

  first.unmount();
  const second = renderScreen();
  expect(second.getByText('App 5')).toBeTruthy();
  await act(async () => {});
  expect(topFrameFetches()).toBe(1);
});

it('mounts only the first cards, with sized expo-image icons', async () => {
  const root = renderScreen();
  await waitFor(() => expect(root.getByText('App 5')).toBeTruthy());

  expect(root.queryByText(`App ${APP_COUNT - 1}`)).toBeNull();
  expect(root.UNSAFE_queryAllByType(RNImage)).toHaveLength(0);
  const uris = root.UNSAFE_queryAllByType(ExpoImage).map((i) => i.props.source?.uri);
  expect(uris).toContain(sizedImageUrl(icon(10), 56));
  expect(uris).not.toContain(icon(10));
});
