/**
 * Audio-space chat = direct replies to the cast that the space is
 * embedded in.
 *
 * This module is the imperative (non-React) version of the thread
 * fetcher, suitable for calling inside the AudioSpaceContext effect
 * loop. We deliberately don't import the React-Query hook here — the
 * context already runs its own poll and shouldn't double-cache.
 *
 * Sending a chat = publishing a reply to the root cast, signed with the
 * account's Hypersnap signer (`publishCast`).
 */

import {
  getDefaultHypersnapClient,
  type HypersnapConversationCast,
} from '@quilibrium/quorum-shared';
import { publishCast, rememberCastAuthor } from './hypersnapWrites';

/** Lighter shape than `ThreadCast` — we only carry the fields the
 *  chat panel actually renders. Decouples the chat module from the
 *  full thread shape. */
export interface SpaceChatCast {
  hash: string;
  text: string;
  /** Unix ms epoch (parsed from the ISO timestamp the hypersnap
   *  endpoint returns). */
  timestamp: number;
  parentHash?: string;
  author: {
    fid: number;
    username?: string;
    displayName?: string;
    pfpUrl?: string;
  };
  /** Farcaster reaction/reply counts + the viewer's own reaction state.
   *  Default 0/false for optimistic stubs that haven't been confirmed. */
  likeCount?: number;
  recastCount?: number;
  replyCount?: number;
  liked?: boolean;
  recasted?: boolean;
}

/** The hypersnap conversation endpoint returns hashes WITHOUT the `0x`
 *  prefix, but the rest of the app keys casts by the `0x`-prefixed form. */
function ensure0x(h?: string): string | undefined {
  if (!h) return h;
  const lower = h.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

function normalizeReply(c: HypersnapConversationCast): SpaceChatCast {
  // A like, recast or reply on this message needs its author; record it so
  // that write needs no lookup.
  rememberCastAuthor(ensure0x(c.hash), c.author.fid);
  return {
    hash: ensure0x(c.hash)!,
    text: c.text,
    timestamp: Date.parse(c.timestamp) || 0,
    parentHash: ensure0x(c.parent_hash),
    author: {
      fid: c.author.fid,
      username: c.author.username,
      displayName: c.author.display_name,
      pfpUrl: c.author.pfp_url,
    },
    likeCount: c.reactions?.likes_count ?? 0,
    recastCount: c.reactions?.recasts_count ?? 0,
    replyCount: c.replies?.count ?? 0,
    liked: c.viewer_context?.liked ?? false,
    recasted: c.viewer_context?.recasted ?? false,
  };
}

/** Flatten the conversation tree (host's replies + their replies) into a
 *  single time-ordered list. Replying to a chat message posts a depth-2
 *  reply, so we go two levels deep to surface those inline. */
function flatten(casts: HypersnapConversationCast[], out: SpaceChatCast[]): void {
  for (const c of casts) {
    out.push(normalizeReply(c));
    if (c.direct_replies?.length) flatten(c.direct_replies, out);
  }
}

/**
 * Fetch replies to the space's root cast as chat messages. We pull two
 * levels deep and flatten so that replies to individual chat messages
 * appear inline alongside top-level chat.
 */
export async function fetchSpaceChat(rootCastHash: string): Promise<SpaceChatCast[]> {
  const stripped = rootCastHash.toLowerCase().replace(/^0x/, '');
  if (stripped.length < 40) return [];
  const client = getDefaultHypersnapClient();
  try {
    const res = await client.getCastConversation(stripped, { replyDepth: 2 });
    const replies = res.conversation.cast.direct_replies ?? [];
    const out: SpaceChatCast[] = [];
    flatten(replies, out);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

/**
 * Post a reply to the space's root cast (or to one chat message), as `fid`.
 * Returns the created cast's hash; throws on failure.
 */
export async function submitSpaceChatReply(
  parentCastHash: string,
  text: string,
  fid: number,
): Promise<string> {
  return publishCast({ fid, text, parent: { castHash: parentCastHash } });
}
