/**
 * availability — single cached probe of whether on-device translation works
 * (iOS 18+ / ML Kit present). Probed once; the cached value lets context menus
 * decide synchronously whether to show a "Translate" action.
 */

import { isTranslationAvailable } from 'quorum-translation';

let cached: boolean | null = null;
let probe: Promise<boolean> | null = null;

export function ensureAvailabilityProbed(): Promise<boolean> {
  if (!probe) {
    probe = isTranslationAvailable().then((v) => {
      cached = v;
      return v;
    });
  }
  return probe;
}

/** null = not yet probed (treat as optimistically available in UI). */
export function translationAvailableCached(): boolean | null {
  return cached;
}
