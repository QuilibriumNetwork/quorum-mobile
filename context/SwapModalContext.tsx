/**
 * SwapModalContext — single app-wide SwapModal instance that any screen
 * can open as an overlay. Without this, opening a swap from a feed cell
 * required navigating away to the wallet tab, which interrupted the
 * user's scroll position and tore down feed view state.
 *
 * Provider hosts SwapModal as a sibling to the regular route tree, so
 * it appears on top of whatever surface the caller is currently on.
 * Mounted inside the (tabs) layout where every consumer lives.
 *
 * SwapModal itself is mounted only while it's open. It runs `useWallet()`,
 * which fetches balances on 40+ chains; mounted always (hidden), it did that
 * at every launch and every return to the foreground for a modal most
 * sessions never open.
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

/** How long SwapModal stays mounted after closing. BaseModal has already
 *  animated out when it calls `onClose`; this only lets the native modal
 *  finish tearing down before the tree goes. */
const UNMOUNT_AFTER_CLOSE_MS = 400;

export function SwapModalProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [buyToken, setBuyToken] = React.useState<string | undefined>(undefined);
  const unmountTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const openSwap = React.useCallback((token?: string | null) => {
    if (unmountTimer.current !== undefined) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = undefined;
    }
    setBuyToken(token ?? undefined);
    setMounted(true);
    setVisible(true);
  }, []);

  const handleClose = React.useCallback(() => {
    setVisible(false);
    // Clear the buy token after close so a subsequent "open empty swap"
    // doesn't re-prefill from a stale tap.
    setBuyToken(undefined);
    if (unmountTimer.current !== undefined) clearTimeout(unmountTimer.current);
    unmountTimer.current = setTimeout(() => {
      unmountTimer.current = undefined;
      setMounted(false);
    }, UNMOUNT_AFTER_CLOSE_MS);
  }, []);

  React.useEffect(
    () => () => {
      if (unmountTimer.current !== undefined) clearTimeout(unmountTimer.current);
    },
    [],
  );

  const value = React.useMemo(() => ({ openSwap }), [openSwap]);

  return (
    <SwapModalContext.Provider value={value}>
      {children}
      {mounted && (
        <SwapModal
          visible={visible}
          onClose={handleClose}
          initialBuyToken={buyToken}
        />
      )}
    </SwapModalContext.Provider>
  );
}
