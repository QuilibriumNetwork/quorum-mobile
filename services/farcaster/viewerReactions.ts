/**
 * The viewer's own likes and recasts, so a cast they've already liked shows
 * as liked.
 *
 * Hypersnap's `/v2` reads return no viewer context: `viewer_fid` is parsed and
 * ignored, and `viewer_context` is always empty. The hub API answers it
 * instead: `/v1/reactionsByFid` lists an account's current reactions, newest
 * first with `reverse=true`. A reaction message is about 550 bytes, so this
 * keeps a window of the newest ones, which covers what the feed shows (it is
 * recent casts); a cast liked long before that window still shows as not liked.
 *
 * The full window is 700 messages, about 100 KB compressed, so it isn't
 * downloaded on every launch: the last window is kept on the phone, and a
 * refresh fetches only the newest few and puts them on top
 * (`refreshViewerReactions`). The list holds only reactions that still exist,
 * so an unlike made on another client never shows up in the newest few; the
 * whole window is downloaded again once a day to drop those.
 */
import { DEFAULT_HYPERSNAP_BASE_URL } from '@quilibrium/quorum-shared';
import { createMMKV, type MMKV } from 'react-native-mmkv';

export type ViewerReactionType = 'Like' | 'Recast';

/** How many of the newest reactions to keep, per type. */
export const VIEWER_LIKES_WINDOW = 500;
export const VIEWER_RECASTS_WINDOW = 200;
/** How many of the newest a refresh fetches, per type. */
export const VIEWER_REACTIONS_HEAD = 50;
/** How often the whole window is downloaded again. */
export const VIEWER_REACTIONS_FULL_MS = 24 * 60 * 60 * 1000;

export interface ViewerReactions {
  /** Newest first. */
  likes: string[];
  recasts: string[];
  /** When the whole window was last downloaded. */
  fullAt: number;
  fetchedAt: number;
}

interface ReactionsByFidResponse {
  messages?: {
    data?: {
      type?: string;
      reactionBody?: { targetCastId?: { hash?: string } };
    };
  }[];
}

/** Hashes (lowercase, `0x`-prefixed) of the casts `fid`'s newest `limit`
 *  reactions of `type` target. Throws on transport failure, so a query keeps
 *  its last good answer. */
export async function fetchViewerReactionHashes(
  fid: number,
  type: ViewerReactionType,
  limit: number,
): Promise<string[]> {
  const params = new URLSearchParams({
    fid: String(fid),
    reaction_type: type,
    pageSize: String(limit),
    reverse: 'true',
  });
  const res = await fetch(`${DEFAULT_HYPERSNAP_BASE_URL}/v1/reactionsByFid?${params.toString()}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`reactionsByFid failed (${res.status})`);
  const json = (await res.json()) as ReactionsByFidResponse;
  const hashes: string[] = [];
  for (const message of json.messages ?? []) {
    if (message.data?.type !== 'MESSAGE_TYPE_REACTION_ADD') continue;
    const hash = message.data.reactionBody?.targetCastId?.hash;
    if (!hash) continue;
    hashes.push(`0x${hash.toLowerCase().replace(/^0x/, '')}`);
  }
  return hashes;
}

/**
 * `fresh` (newest first) on top of `known`, capped at `window`; null when
 * `fresh` doesn't reach anything in `known`, so there may be a gap between
 * them and only a full download is complete.
 */
export function mergeNewestReactions(known: string[], fresh: string[], window: number): string[] | null {
  if (known.length === 0) return fresh.slice(0, window);
  const have = new Set(known);
  const firstKnown = fresh.findIndex((hash) => have.has(hash));
  // A full page with nothing we hold: more may have happened than it shows.
  if (firstKnown < 0 && fresh.length >= VIEWER_REACTIONS_HEAD) return null;
  const added = (firstKnown < 0 ? fresh : fresh.slice(0, firstKnown)).filter((hash) => !have.has(hash));
  return [...added, ...known].slice(0, window);
}

/**
 * The viewer's reactions brought up to date from `previous`: the newest few
 * merged on top, or the whole window when there's nothing to merge into, it
 * was last downloaded a day ago, or the newest few don't reach it.
 */
export async function refreshViewerReactions(
  fid: number,
  previous: ViewerReactions | null,
  now = Date.now(),
): Promise<ViewerReactions> {
  const full = async (): Promise<ViewerReactions> => {
    const [likes, recasts] = await Promise.all([
      fetchViewerReactionHashes(fid, 'Like', VIEWER_LIKES_WINDOW),
      fetchViewerReactionHashes(fid, 'Recast', VIEWER_RECASTS_WINDOW),
    ]);
    return { likes, recasts, fullAt: now, fetchedAt: now };
  };
  if (!previous || now - previous.fullAt >= VIEWER_REACTIONS_FULL_MS) return full();

  const [newestLikes, newestRecasts] = await Promise.all([
    fetchViewerReactionHashes(fid, 'Like', VIEWER_REACTIONS_HEAD),
    fetchViewerReactionHashes(fid, 'Recast', VIEWER_REACTIONS_HEAD),
  ]);
  const likes = mergeNewestReactions(previous.likes, newestLikes, VIEWER_LIKES_WINDOW);
  const recasts = mergeNewestReactions(previous.recasts, newestRecasts, VIEWER_RECASTS_WINDOW);
  if (!likes || !recasts) return full();
  return { likes, recasts, fullAt: previous.fullAt, fetchedAt: now };
}

// Its own small store, as the follow set has (socialGraph.ts).
let store: MMKV | null = null;
const getStore = () => (store ??= createMMKV({ id: 'quorum-viewer-reactions' }));
const storageKey = (fid: number) => `viewer-reactions:${fid}`;

export function loadViewerReactions(fid: number): ViewerReactions | null {
  try {
    const raw = getStore().getString(storageKey(fid));
    const parsed = raw ? (JSON.parse(raw) as ViewerReactions) : null;
    return parsed && Array.isArray(parsed.likes) && Array.isArray(parsed.recasts) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveViewerReactions(fid: number, value: ViewerReactions): void {
  try {
    getStore().set(storageKey(fid), JSON.stringify(value));
  } catch {
    // Not kept: the next launch downloads the window again.
  }
}

/** Forget every kept window (reset / sign-out). */
export function clearViewerReactions(): void {
  try {
    getStore().clearAll();
  } catch {
    // Nothing kept.
  }
}
