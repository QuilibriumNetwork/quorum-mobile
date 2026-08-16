/**
 * The account screen is ONE scrolling page with a pinned nav row.
 *
 * ## What this pins, and why it needs pinning
 *
 * Two facts hold the layout together, and both fail silently:
 *
 * 1. `stickyHeaderIndices={[1]}` counts DIRECT children of the scroll's content
 *    view. Adding any sibling above the pill row shifts every index by one, and
 *    the wrong element pins. Nothing throws; you just get a stuck profile card
 *    and pills that scroll away.
 *
 * 2. `ProfileModal` must be told `externalScroll`. Without it, it renders its
 *    own vertical `ScrollView` inside this one, and the inner scroller eats the
 *    gesture — the page stops scrolling as a page. Again, no error.
 *
 * Both are structure, not behaviour, so this test asserts on the element tree
 * rather than on rendered text. What it deliberately does NOT cover: whether
 * the sticky row actually sticks at runtime. That is native ScrollView
 * behaviour on a real device and no Jest renderer can answer it.
 *
 * ## What is real, what is mocked
 *
 * `SegmentedPills` is real — it is the thing being pinned, and it renders a
 * HORIZONTAL ScrollView, which is exactly the child a naive query would
 * confuse with the page scroller. `UnifiedProfileHeader` and `ProfileModal` are
 * stubbed: both drag in the identity ladder, the WebSocket context and the QNS
 * clients, none of which this file is about.
 */
import React from 'react';
import { ScrollView } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CustomThemeProvider } from '@/theme';

// The screen reads `useSafeAreaInsets`, which throws without a provider. Fixed
// metrics rather than a real measurement pass: nothing here depends on the
// numbers, and a provider that has not measured yet renders null children.
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const ADDRESS = 'QmRxwsciKWz7fvph4PobmabjChKPZtvkBcE4oALnogXDYW';

// Captures what UnifiedProfileScreen hands the embedded body, so the
// externalScroll contract is checked at the prop, not by eyeballing the tree.
let profileModalProps: Record<string, unknown> = {};

jest.mock('@/components/ProfileModal', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      profileModalProps = props;
      return <View testID="profile-body" />;
    },
  };
});

jest.mock('@/components/UnifiedProfileHeader', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: () => <View testID="profile-header-stub" />,
  };
});

// Modal shells the screen mounts unconditionally; none of them is under test.
jest.mock('@/components/ProfileSplitModeModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/UnifiedProfileEditModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/qns/AuctionsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/qns/BuyNameModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/qns/MarketplaceModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/qns/OffersModal', () => ({ __esModule: true, default: () => null }));

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { address: ADDRESS, displayName: 'Test User' },
    farcasterAuthToken: null,
    updateProfile: jest.fn(),
  }),
}));
jest.mock('@/context/ToastContext', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('@/hooks/useFarcasterProfile', () => ({ useFarcasterProfile: () => ({ author: null }) }));
jest.mock('@/services/profile/profilePrefs', () => ({
  hasDecidedSplitMode: () => true,
  useProfileSplitMode: () => [false, jest.fn()],
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

import UnifiedProfileScreen from '@/components/UnifiedProfileScreen';

/**
 * The whole tree, including the theme provider.
 *
 * Two reasons it is shaped this way rather than going through
 * `renderWithProviders`:
 *
 *  - `rerender` replaces the ROOT element, and the helper adds its provider
 *    around the element you pass rather than through RTL's `wrapper` option —
 *    so a re-render through it loses the theme and the screen throws. Mount and
 *    re-render have to be the same shape.
 *  - It is a function, not a constant, because React bails out of re-rendering
 *    an element it has already seen BY REFERENCE. A shared constant would make
 *    the re-render control below silently vacuous.
 *
 * The provider props are copied verbatim from `renderWithProviders` so the
 * pinned appearance still matches every other render test.
 */
function screenTree(queryClient: QueryClient) {
  return (
    <CustomThemeProvider defaultAccentColor="blue" defaultAppearance="dark">
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <QueryClientProvider client={queryClient}>
          <UnifiedProfileScreen />
        </QueryClientProvider>
      </SafeAreaProvider>
    </CustomThemeProvider>
  );
}

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(screenTree(queryClient));
  return { ...view, rerenderSame: () => view.rerender(screenTree(queryClient)) };
}

/** The page's own vertical scroller, told apart from SegmentedPills' horizontal
 *  one by testID rather than by position — position is what this test exists to
 *  catch changing. */
function pageScroller() {
  const matches = screen.UNSAFE_getAllByType(ScrollView).filter(
    (node) => node.props.testID === 'settings-page-scroll',
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('account screen scroll structure', () => {
  it('pins the nav pill row, and nothing else, to the top', () => {
    renderScreen();
    const page = pageScroller();

    expect(page.props.stickyHeaderIndices).toEqual([1]);

    const children = React.Children.toArray(
      page.props.children,
    ) as React.ReactElement<{ testID?: string }>[];
    // Index 1 is the pinned one. Asserting the whole shape rather than just
    // children[1] means an inserted sibling fails here even if it happens to
    // land somewhere the index still "works".
    expect(children).toHaveLength(3);
    expect(children[1].props.testID).toBe('settings-nav-pills');
  });

  it('scrolls the profile card away with the page rather than pinning it', () => {
    renderScreen();
    const children = React.Children.toArray(
      pageScroller().props.children,
    ) as React.ReactElement<{ testID?: string }>[];

    // The header (card + Quorum/Farcaster identity switcher) sits ABOVE the
    // sticky index, so it scrolls out of view. If it ever moved below the
    // pills, or became sticky itself, this is where that shows up.
    expect(children[0].props.testID).not.toBe('settings-nav-pills');
    expect(screen.getByTestId('profile-header-stub')).toBeTruthy();
  });

  it('tells the embedded body not to scroll itself', () => {
    renderScreen();
    // The whole point of the page scroller: a second vertical ScrollView
    // nested inside it would trap the drag gesture.
    expect(profileModalProps.externalScroll).toBe(true);
  });

  it('rewinds to the top when a different section is picked', () => {
    // Spied on the prototype rather than the ref: under the test renderer a
    // ScrollView ref is a mock instance whose methods are not the real ones, so
    // asserting on the ref itself would pass against anything.
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
    renderScreen();
    // Mount alone may rewind (harmless — the page is already at 0). Only what
    // the tap causes is under test.
    scrollTo.mockClear();

    fireEvent.press(screen.getByText('Settings'));

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ y: 0, animated: false }),
    );
    scrollTo.mockRestore();
  });

  it('does not rewind on a re-render that leaves the section alone', () => {
    // The control arm, and it earns the name: dropping the effect's dependency
    // array (rewind on EVERY render) leaves the test above green and turns this
    // one red. That bug is worse than the one being fixed — any unrelated state
    // change, mid-scroll, would yank the user back to the top.
    //
    // A press on the already-active pill was tried here first and was useless:
    // SegmentedPills does not re-fire onChange for the active key, so nothing
    // re-renders and the assertion held against a genuinely broken effect.
    // MEASURED, 2026-08-16.
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
    const { rerenderSame } = renderScreen();
    scrollTo.mockClear();

    rerenderSame();

    expect(scrollTo).not.toHaveBeenCalled();
    scrollTo.mockRestore();
  });
});
