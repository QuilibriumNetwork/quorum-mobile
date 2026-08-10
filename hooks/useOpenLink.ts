/**
 * useOpenLink — the single entry point for "the user tapped a link".
 *
 * Every chat surface routes through this so the behaviour cannot drift between
 * Spaces, DMs and link cards: YouTube leaves the app, everything else opens in
 * the in-app browser in link mode, and a failed handoff says so instead of
 * doing nothing.
 */

import { useCallback } from 'react';
import { Linking } from 'react-native';

import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { useToast } from '@/context/ToastContext';
import { shouldOpenExternally } from '@/utils/linkRouting';

export function useOpenLink(): (url: string) => void {
  const { openUrl } = useMiniappOverlay();
  const { showToast } = useToast();

  return useCallback(
    (url: string) => {
      if (shouldOpenExternally(url)) {
        // No `canOpenURL` gate. For an https URL it cannot tell us anything
        // `openURL` won't, and it is half the reason the old "open externally"
        // button failed silently — `canOpenURL` returned false, there was no
        // else branch, and the sheet just closed. Ask for the open and handle
        // the refusal.
        //
        // The OS resolves this to the owning app via Universal Links (iOS) or
        // verified App Links (Android), and falls back to the default browser
        // when the app isn't installed. Both are correct outcomes here.
        Linking.openURL(url).catch(() => {
          showToast({
            type: 'error',
            title: 'Could not open link',
            message: 'No app on this device can handle it.',
          });
        });
        return;
      }

      // Chat-link URLs are user-provided and may target LAN dev hosts, so pass
      // `allowInsecureLAN` to keep dev-time previews working.
      openUrl({ url, allowInsecureLAN: true });
    },
    [openUrl, showToast],
  );
}
