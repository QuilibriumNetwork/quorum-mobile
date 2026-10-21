import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { AppState } from 'react-native';

/** How near the top of the list counts as "at the top" (px). */
export const FEED_TOP_THRESHOLD_PX = 120;

/**
 * Refresh a stale feed when it comes back into view: the app returning to the
 * foreground, or the feed screen being focused (`inView` turning true).
 * Queries don't refetch on return by default, and the feed stays mounted
 * behind other tabs, so nothing else does it.
 *
 * Someone reading further down isn't moved: the refresh waits until they
 * scroll back to the top. Call the returned `onScrollY` from the list's
 * `onScroll`. `refreshIfStale` decides whether a refresh is due.
 */
export function useFeedRefreshOnReturn({
  inView,
  scrollYRef,
  refreshIfStale,
}: {
  inView: boolean;
  scrollYRef: RefObject<number>;
  refreshIfStale: () => Promise<void>;
}): { onScrollY: (y: number) => void } {
  const refreshIfStaleRef = useRef(refreshIfStale);
  refreshIfStaleRef.current = refreshIfStale;
  const refreshAtTopRef = useRef(false);

  useEffect(() => {
    if (!inView) return;
    const check = () => {
      if ((scrollYRef.current ?? 0) < FEED_TOP_THRESHOLD_PX) void refreshIfStaleRef.current();
      else refreshAtTopRef.current = true;
    };
    check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => sub.remove();
  }, [inView, scrollYRef]);

  const onScrollY = useCallback((y: number) => {
    if (refreshAtTopRef.current && y < FEED_TOP_THRESHOLD_PX) {
      refreshAtTopRef.current = false;
      void refreshIfStaleRef.current();
    }
  }, []);

  return { onScrollY };
}
