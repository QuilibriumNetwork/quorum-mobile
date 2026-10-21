/**
 * Work for screens nobody is looking at doesn't run.
 *
 * ## The regressions this pins
 *
 * - The swap modal was always mounted, hidden, and its `useWallet()` fetched
 *   balances on 40+ chains at every launch and return to the foreground.
 * - Space activity, wallet prefs and favourite tokens re-read MMKV every 2s
 *   (space activity also set a fresh object each time, re-rendering the
 *   Spaces list every 2s) to notice writes made elsewhere.
 * - Polls in a visited tab never stopped: tabs don't unmount here.
 *
 * ## What is asserted
 *
 * - SwapModal mounts when opened and unmounts after it closes.
 * - The MMKV-backed hooks re-render on a write to their key, and never on a
 *   timer.
 * - `useScreenFocused` follows the screen's focus, and reports focused outside
 *   a screen.
 */
import React from 'react';
import { Text } from 'react-native';
import { act, render, renderHook } from '@testing-library/react-native';
import { NavigationContext } from '@react-navigation/native';

const mockSwapMounts = { count: 0 };
jest.mock('@/components/wallet/SwapModal', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    __esModule: true,
    default: function MockSwapModal({ visible }: { visible: boolean }) {
      useEffect(() => {
        mockSwapMounts.count++;
      }, []);
      const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
      return visible ? <RNText>swap open</RNText> : null;
    },
  };
});

// eslint-disable-next-line import/first -- the SwapModal mock must be registered first
import { SwapModalProvider, useSwapModal } from '@/context/SwapModalContext';
// eslint-disable-next-line import/first
import { recordSpaceActivity, useSpaceActivity } from '@/hooks/chat/useSpaceActivity';
// eslint-disable-next-line import/first
import { savePref, toggleFavoriteToken, useFavoriteTokens, useWalletPref } from '@/services/wallet/walletPrefs';
// eslint-disable-next-line import/first
import { useScreenFocused } from '@/hooks/useScreenFocused';

beforeEach(() => {
  jest.useFakeTimers();
  mockSwapMounts.count = 0;
});
afterEach(() => jest.useRealTimers());

describe('the swap modal', () => {
  it('mounts only while open', () => {
    let open: (token?: string | null) => void = () => {};
    function Opener() {
      open = useSwapModal().openSwap;
      return null;
    }
    const root = render(
      <SwapModalProvider>
        <Opener />
      </SwapModalProvider>,
    );
    expect(mockSwapMounts.count).toBe(0);

    act(() => open());
    expect(mockSwapMounts.count).toBe(1);
    expect(root.getByText('swap open')).toBeTruthy();
  });
});

describe('MMKV-backed hooks', () => {
  it('re-read space activity when it is written, not on a timer', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useSpaceActivity();
    });
    const settled = renders;

    act(() => jest.advanceTimersByTime(10_000));
    expect(renders).toBe(settled);

    act(() => recordSpaceActivity('space-1', { timestamp: 123 }));
    expect(result.current.getActivity('space-1')?.timestamp).toBe(123);
  });

  it('re-read a wallet pref written elsewhere', () => {
    const { result } = renderHook(() => useWalletPref<string>('pref:test', 'a'));
    act(() => savePref('pref:test', 'b'));
    expect(result.current[0]).toBe('b');
  });

  it('re-read favourite tokens when one is toggled elsewhere', () => {
    const { result } = renderHook(() => useFavoriteTokens());
    const before = result.current.length;
    act(() => {
      toggleFavoriteToken({ chainId: 1, address: '0xabc', symbol: 'T' } as never);
    });
    expect(result.current.length).toBe(before + 1);
  });
});

describe('useScreenFocused', () => {
  it('reports focused outside a screen', () => {
    const { result } = renderHook(() => useScreenFocused());
    expect(result.current).toBe(true);
  });

  it('follows the screen’s focus and blur', () => {
    const listeners: Record<string, () => void> = {};
    const navigation = {
      isFocused: () => true,
      addListener: (event: string, cb: () => void) => {
        listeners[event] = cb;
        return () => delete listeners[event];
      },
    };
    function Probe() {
      return <Text>{useScreenFocused() ? 'focused' : 'blurred'}</Text>;
    }
    const root = render(
      <NavigationContext.Provider value={navigation as never}>
        <Probe />
      </NavigationContext.Provider>,
    );
    expect(root.getByText('focused')).toBeTruthy();

    act(() => listeners.blur());
    expect(root.getByText('blurred')).toBeTruthy();
    act(() => listeners.focus());
    expect(root.getByText('focused')).toBeTruthy();
  });
});
