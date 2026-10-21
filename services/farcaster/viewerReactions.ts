/**
 * The viewer's own likes and recasts, so a cast they've already liked shows
 * as liked.
 *
 * Hypersnap's `/v2` reads return no viewer context: `viewer_fid` is parsed and
 * ignored, and `viewer_context` is always empty. The hub API answers it
 * instead: `/v1/reactionsByFid` lists an account's current reactions, newest
 * first with `reverse=true`. A reaction message is about 550 bytes, so this
 * fetches a window of the newest ones, which covers what the feed shows (it is
 * recent casts); a cast liked long before that window still shows as not liked.
 */
import { DEFAULT_HYPERSNAP_BASE_URL } from '@quilibrium/quorum-shared';

export type ViewerReactionType = 'Like' | 'Recast';

/** How many of the newest reactions to fetch, per type. */
export const VIEWER_LIKES_WINDOW = 500;
export const VIEWER_RECASTS_WINDOW = 200;

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
