/**
 * A budget of native video players for first-frame previews in the feed.
 *
 * Videos from Hypersnap arrive as bare stream URLs with no poster image, so the
 * only preview is the video's own first frame, which needs a native player and
 * a `VideoView` decoding the stream. Creating one for every video row as it
 * mounted cost a player, a decoder and a stream download per row, including rows
 * scrolled straight past. The Farcaster client keeps at most two players alive
 * for the same reason.
 *
 * A row asks for a slot once it has stayed mounted for `PREVIEW_SETTLE_MS`, and
 * the first `MAX_PREVIEW_PLAYERS` rows still asking hold one. When a row leaves
 * (unmounts, or a recycled cell moves to another video) its slot passes to the
 * next row waiting. Rows without a slot show a sized placeholder; tapping play
 * always creates a player, slot or not.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

export const MAX_PREVIEW_PLAYERS = 2;
/** How long a video row must stay mounted before it asks for a preview. */
export const PREVIEW_SETTLE_MS = 300;

let nextToken = 1;
/** Rows asking, in the order they asked. The first MAX_PREVIEW_PLAYERS hold a slot. */
let waiting: number[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function request(token: number): void {
  waiting = [...waiting, token];
  emit();
}
function release(token: number): void {
  const next = waiting.filter((t) => t !== token);
  if (next.length !== waiting.length) {
    waiting = next;
    emit();
  }
}
function holds(token: number): boolean {
  const index = waiting.indexOf(token);
  return index >= 0 && index < MAX_PREVIEW_PLAYERS;
}

/**
 * Whether the caller may hold a preview player for `key` (the video URL) now.
 * Pass `undefined` when no preview is wanted, e.g. once a poster image exists.
 */
export function useVideoPreviewSlot(key: string | undefined): boolean {
  const [token, setToken] = useState<number | null>(null);

  useEffect(() => {
    if (!key) return;
    const mine = nextToken++;
    const timer = setTimeout(() => {
      request(mine);
      setToken(mine);
    }, PREVIEW_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      release(mine);
    };
  }, [key]);

  const read = () => token !== null && holds(token);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test reset. */
export function __resetVideoPreviewSlots(): void {
  waiting = [];
  emit();
}
