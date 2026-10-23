/**
 * Inbox and notification avatars are disk-cached and asked for at their size.
 *
 * ## The regression this pins
 *
 * The messages inbox, the DM list, the DM header and the notifications list
 * drew avatars with React Native's `Image`: the full upload for a 28-48 pt
 * circle, cached in memory only, so every face was downloaded again after a
 * relaunch or once evicted. They now go through `CachedAvatar` (expo-image,
 * disk cache, a still copy at the size shown, initials if it fails).
 *
 * ## What is asserted
 *
 * - A DM list row asks for a sized still copy through expo-image.
 * - None of the four files imports React Native's `Image` any more. (The
 *   inbox and notifications screens need most of the app mounted to render, so
 *   for those this reads the source, as other tests here do.)
 */
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { PixelRatio, Image as RNImage } from 'react-native';
import { cleanup, render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Image as ExpoImage } from 'expo-image';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { DarkTheme } from '@/theme';
import type { Conversation } from '@/hooks/chat';

jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({ getPublicProfile: jest.fn().mockResolvedValue(null) }),
}));
jest.mock('@/services/api/qnsClient', () => ({ resolveClaimedNames: jest.fn().mockResolvedValue({}) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import { DirectMessagesList } from '@/components/Chat/DirectMessagesList';

const AVATAR = 'https://imagedelivery.net/acct/avatar-id/original';

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

it('asks for a DM row avatar at its size, through expo-image', () => {
  jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const row: Conversation = {
    conversationId: 'fc-1',
    address: 'fid:7',
    displayName: 'Erin',
    icon: AVATAR,
    type: 'direct',
    source: 'farcaster',
    timestamp: 1_700_000_000_000,
  } as Conversation;

  const root = render(
    <QueryClientProvider client={queryClient}>
      <IdentityScopeProvider rostersBySpace={{}} selfAddress={null}>
        <DirectMessagesList conversations={[row]} onSelectConversation={() => {}} theme={DarkTheme} />
      </IdentityScopeProvider>
    </QueryClientProvider>,
  );

  expect(root.UNSAFE_queryAllByType(RNImage)).toHaveLength(0);
  // 48 pt at 2x is 96 px; a still frame, as for every avatar.
  expect(root.UNSAFE_getByType(ExpoImage).props.source.uri).toBe(
    'https://imagedelivery.net/acct/avatar-id/anim=false,w=96',
  );
  queryClient.clear();
});

it.each([
  'app/(tabs)/messages/index.tsx',
  'components/Chat/DirectMessagesList.tsx',
  'components/Chat/DMChatHeader.tsx',
  'app/(tabs)/profile/index.tsx',
])('%s does not use React Native’s Image', (file) => {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const fromReactNative = source.match(/import\s*\{[^}]*\}\s*from\s*'react-native';/g) ?? [];
  expect(fromReactNative.join('\n')).not.toMatch(/\bImage\b/);
});
