/**
 * useFarcasterSubmitCast — single entry point for every cast / reply
 * the app publishes. Casts are signed with the device's Hypersnap signer
 * and submitted to Hypersnap (`publishCast`); there is no farcaster.xyz
 * path. Adds the composer-side preprocessing that the read path's
 * normalization expects:
 *
 *   - `@username` extraction → `(mentions, mentionsPositions)` pair
 *     (skipped when `extractMentions: false`, for chat-share / browser
 *     paths where chat handles can collide with Farcaster usernames).
 *   - `farcaster.xyz` / `warpcast.com` cast-link embeds promoted to
 *     canonical `castId` embeds.
 *   - Channel key → parent_url resolution.
 *
 * Reply parents may be hash-only: `publishCast` looks up the parent's
 * author FID, which the protocol needs to address the reply.
 */

import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { extractMentions } from '@/services/farcaster/mentionExtraction';
import { translateEmbedUrls } from '@/services/farcaster/embedTranslation';
import { resolveChannelParentUrl } from '@/services/farcaster/channelUrlResolver';
import { FarcasterWriteError, publishCast } from '@/services/farcaster/hypersnapWrites';

// Channel key → parent_url: a cast joins a channel ONLY when parent_url
// exactly equals the channel's canonical FIP-2 `url` (warpcast.com/~/channel
// form for most, chain:// URIs for original channels). Constructing the URL
// from the key produces identifiers Farcaster's backend doesn't recognize,
// so resolveChannelParentUrl fetches (and caches) the canonical URL from the
// Farcaster API instead.

export interface SubmitCastInput {
  text: string;
  /** Plain URL strings collected by the composer (image uploads, page
   *  links, cast links). Get translated into protocol-level
   *  `CastEmbed[]` before submit. */
  embedUrls?: string[];
  /** When set, this becomes a reply to that cast. `fid` is the parent's
   *  author; looked up from the hash when omitted. */
  parent?: { castHashHex: string; fid?: number } | { url: string };
  channelKey?: string;
  /** Default `true`. Set `false` for chat-share / browser flows where
   *  @-handles in the text might not be Farcaster usernames. */
  extractMentions?: boolean;
}

export interface SubmitCastResult {
  /** 0x-prefixed hex of the published cast's hash. */
  hash: string;
}

export function useFarcasterSubmitCast() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;

  const mutation = useMutation<SubmitCastResult, Error, SubmitCastInput>({
    mutationFn: async (input) => {
      if (!fid) throw new FarcasterWriteError('No Hypersnap account is connected');

      const { text, mentions, mentionsPositions } = (input.extractMentions ?? true)
        ? await extractMentions(input.text, qc)
        : { text: input.text, mentions: [] as number[], mentionsPositions: [] as number[] };

      const embeds = await translateEmbedUrls(input.embedUrls ?? [], qc);

      let parent: { castHash: string; fid?: number } | { url: string } | undefined;
      if (input.parent && 'url' in input.parent) {
        parent = { url: input.parent.url };
      } else if (input.parent) {
        parent = { castHash: input.parent.castHashHex, fid: input.parent.fid ?? undefined };
      } else if (input.channelKey) {
        parent = { url: await resolveChannelParentUrl(input.channelKey) };
      }

      const hash = await publishCast({ fid, text, embeds, mentions, mentionsPositions, parent });
      return { hash };
    },
  });

  const { mutateAsync } = mutation;
  const submitCast = useCallback(
    (input: SubmitCastInput): Promise<SubmitCastResult> => mutateAsync(input),
    [mutateAsync],
  );

  return {
    submitCast,
    isPending: mutation.isPending,
    error: mutation.error,
  };
}
