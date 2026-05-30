/**
 * SwapModalContext — single app-wide SwapModal instance that any screen
 * can open as an overlay. Without this, opening a swap from a feed cell
 * required navigating away to the wallet tab, which interrupted the
 * user's scroll position and tore down feed view state.
 *
 * Provider hosts SwapModal as a sibling to the regular route tree, so
 * it appears on top of whatever surface the caller is currently on.
 * Mounted inside the (tabs) layout where every consumer lives.
 */

import React from 'react';
import SwapModal from '@/components/wallet/SwapModal';

interface SwapModalContextValue {
  /** Open the SwapModal preloaded with the given buy token. The buy
   *  token is the JSON shape SwapModal's `initialBuyToken` accepts:
   *  `{"address":"0x..","chainId":N}`. Pass `null` to open with no
   *  initial buy token. */
  openSwap: (buyToken?: string | null) => void;
}

const SwapModalContext = React.createContext<SwapModalContextValue | null>(null);

export function useSwapModal(): SwapModalContextValue {
  const ctx = React.useContext(SwapModalContext);
  if (!ctx) {
    // Defensive: in tests or other surfaces that don't mount the provider,
    // return a no-op so callers don't crash. They just won't open a swap.
    return {
      openSwap: () => {
        // eslint-disable-next-line no-console
        console.warn('[SwapModal] openSwap called outside SwapModalProvider');
      },
    };
  }
  return ctx;
}

export function SwapModalProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = React.useState(false);
  const [buyToken, setBuyToken] = React.useState<string | undefined>(undefined);

  const openSwap = React.useCallback((token?: string | null) => {
    setBuyToken(token ?? undefined);
    setVisible(true);
  }, []);

  const handleClose = React.useCallback(() => {
    setVisible(false);
    // Clear the buy token after close so a subsequent "open empty swap"
    // doesn't re-prefill from a stale tap.
    setBuyToken(undefined);
  }, []);

  const value = React.useMemo(() => ({ openSwap }), [openSwap]);

  return (
    <SwapModalContext.Provider value={value}>
      {children}
      <SwapModal
        visible={visible}
        onClose={handleClose}
        initialBuyToken={buyToken}
      />
    </SwapModalContext.Provider>
  );
}
