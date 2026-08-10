/**
 * MiniappOverlayContext — global host for the one active miniapp.
 *
 * Replaces the per-host `<BrowserModal>` mounts so we can keep a single
 * WebView mounted across navigation and minimize states. Hosts only
 * need to call `openMiniapp({ url, isQNative })`; the provider's
 * `<BrowserModal>` sibling renders it (and stays mounted when
 * minimized so the WebView's JS state survives).
 *
 * "Minimize" is true preserve — the BrowserModal slides off-screen
 * but stays in the tree, so the WebView's RN view doesn't get torn
 * down. Restore is just an `Animated.spring` back into view.
 */

import React from 'react';
import BrowserModal from '@/components/BrowserModal';
import { MinimizedMiniappChip } from '@/components/MinimizedMiniappChip';
import { recordMiniappUse } from '@/services/miniapp/recentMiniapps';

/**
 * What the overlay is hosting.
 *
 * - `miniapp` — a Farcaster/Q mini app. Gets the SDK bridge, the wallet chip and
 *   the signing modals, and is recorded in the launcher's recents.
 * - `link` — an arbitrary website someone sent in chat. Gets none of that: it is
 *   a browser, not an app host.
 */
export type MiniappOverlayMode = 'link' | 'miniapp';

export interface MiniappOverlayEntry {
  url: string;
  mode: MiniappOverlayMode;
  isQNative: boolean;
  allowInsecureLAN?: boolean;
  /** Bump to force-remount of BrowserModal when reopening the same URL
   *  (otherwise React reuses the existing instance and the WebView
   *  doesn't reload). */
  timestamp: number;
  /** Optional metadata for the minimized-chip restore affordance. */
  name?: string;
  iconUrl?: string;
}

interface MiniappOverlayContextValue {
  entry: MiniappOverlayEntry | null;
  minimized: boolean;
  openMiniapp: (opts: { url: string; isQNative?: boolean; allowInsecureLAN?: boolean; name?: string; iconUrl?: string }) => void;
  /** Open a plain web link. Prefer `useOpenLink()` at call sites — it also
   *  handles the URLs that should leave the app entirely. */
  openUrl: (opts: { url: string; allowInsecureLAN?: boolean }) => void;
  closeMiniapp: () => void;
  minimizeMiniapp: () => void;
  restoreMiniapp: () => void;
}

const MiniappOverlayContext = React.createContext<MiniappOverlayContextValue | null>(null);

export function useMiniappOverlay(): MiniappOverlayContextValue {
  const ctx = React.useContext(MiniappOverlayContext);
  if (!ctx) {
    // Safe no-op so test renders + unwrapped previews don't crash.
    return {
      entry: null,
      minimized: false,
      openMiniapp: () => {
        console.warn('[MiniappOverlay] openMiniapp called outside provider');
      },
      openUrl: () => {
        console.warn('[MiniappOverlay] openUrl called outside provider');
      },
      closeMiniapp: () => {},
      minimizeMiniapp: () => {},
      restoreMiniapp: () => {},
    };
  }
  return ctx;
}

export function MiniappOverlayProvider({ children }: { children: React.ReactNode }) {
  const [entry, setEntry] = React.useState<MiniappOverlayEntry | null>(null);
  const [minimized, setMinimized] = React.useState(false);

  const openMiniapp = React.useCallback((opts: {
    url: string;
    isQNative?: boolean;
    allowInsecureLAN?: boolean;
    name?: string;
    iconUrl?: string;
  }) => {
    setEntry({
      url: opts.url,
      mode: 'miniapp',
      isQNative: opts.isQNative ?? false,
      allowInsecureLAN: opts.allowInsecureLAN,
      timestamp: Date.now(),
      name: opts.name,
      iconUrl: opts.iconUrl,
    });
    setMinimized(false);
    // Record for the launcher's "Recently used" tab (device-local).
    recordMiniappUse({ url: opts.url, name: opts.name, iconUrl: opts.iconUrl });
  }, []);

  /**
   * Open a plain web link. Deliberately NOT `openMiniapp` with a flag: a link
   * from a stranger in a Space is not an app the user chose to run, so it must
   * not reach `recordMiniappUse` — chat links were previously landing in the
   * launcher's "Recently used" shelf alongside the user's actual mini apps.
   */
  const openUrl = React.useCallback((opts: { url: string; allowInsecureLAN?: boolean }) => {
    setEntry({
      url: opts.url,
      mode: 'link',
      isQNative: false,
      allowInsecureLAN: opts.allowInsecureLAN,
      timestamp: Date.now(),
    });
    setMinimized(false);
  }, []);

  const closeMiniapp = React.useCallback(() => {
    setEntry(null);
    setMinimized(false);
  }, []);

  const minimizeMiniapp = React.useCallback(() => {
    setMinimized(true);
  }, []);

  const restoreMiniapp = React.useCallback(() => {
    setMinimized(false);
  }, []);

  const value = React.useMemo<MiniappOverlayContextValue>(
    () => ({ entry, minimized, openMiniapp, openUrl, closeMiniapp, minimizeMiniapp, restoreMiniapp }),
    [entry, minimized, openMiniapp, openUrl, closeMiniapp, minimizeMiniapp, restoreMiniapp],
  );

  return (
    <MiniappOverlayContext.Provider value={value}>
      {children}
      {entry && (
        <BrowserModal
          // Force a fresh instance on each open — otherwise re-opening
          // the same URL after closeMiniapp() reuses the WebView and
          // the miniapp's mount-time hooks don't re-fire.
          key={entry.timestamp}
          visible={true}
          minimized={minimized}
          url={entry.url}
          mode={entry.mode}
          isQNative={entry.isQNative}
          allowInsecureLAN={entry.allowInsecureLAN ?? false}
          timestamp={entry.timestamp}
          onClose={closeMiniapp}
          onMinimize={minimizeMiniapp}
        />
      )}
      {/* Rendered AFTER BrowserModal so the chip stacks above the
          overlay container in the View tree — when minimized the
          overlay is transparent + pointerEvents='box-none', so taps
          on the chip work normally. */}
      <MinimizedMiniappChip />
    </MiniappOverlayContext.Provider>
  );
}
