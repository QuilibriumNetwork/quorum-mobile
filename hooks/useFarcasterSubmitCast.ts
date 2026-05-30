/**
 * useFarcasterSubmitCast — single entry point for every cast / reply
 * the app publishes. Wraps quorum-shared's `useSubmitCast` with the
 * mobile-side wiring (signer store, legacy token, channel-URL map) and
 * adds the composer-side preprocessing that the read path's
 * normalization expects:
 *
 *   - `@username` extraction → `(mentions, mentionsPositions)` pair
 *     (skipped when `extractMentions: false`, for chat-share / browser
 *     paths where chat handles can collide with Farcaster usernames).
 *   - `farcaster.xyz/<user>/0x<hash>` URL embeds promoted to canonical
 *     `castId` embeds.
 *   - Channel key → parent_url resolution.
 *
 * Falls back to legacy `client.farcaster.xyz/v2/casts` automatically
 * when no signer is provisioned (handled inside `useSubmitCast`).
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useSubmitCast,
  type SubmitCastResult,
} from '@quilibrium/quorum-shared';
import { useAuth } from '@/context/AuthContext';
import { hypersnapSignerStore } from '@/services/farcaster/hypersnapAdapters';
import { extractMentions } from '@/services/farcaster/mentionExtraction';
import { translateEmbedUrls } from '@/services/farcaster/embedTranslation';

/** Hypersnap accepts a channel as its parent URL — the standard form
 *  used by farcaster.xyz / warpcast is `…/~/channel/<slug>`. We mirror
 *  that here so a known slug always lands in the same canonical bucket. */
function channelKeyToParentUrl(key: string): string {
  return `https://farcaster.xyz/~/channel/${key}`;
}

export interface SubmitCastInput {
  text: string;
  /** Plain URL strings collected by the composer (image uploads, page
   *  links, farcaster.xyz cast links). Get translated into protocol-
   *  level `CastEmbed[]` before submit. */
  embedUrls?: string[];
  /** When set, this becomes a reply to that cast. `fid` is required for
   *  the hypersnap path; surfaces that don't track it (BrowserModal /
   *  miniapp compose) can omit it and the submit will fall through to
   *  the legacy path which accepts hash-only. */
  parent?: { castHashHex: string; fid?: number } | { url: string };
  channelKey?: string;
  /** Default `true`. Set `false` for chat-share / browser flows where
   *  @-handles in the text might not be Farcaster usernames. */
  extractMentions?: boolean;
}

export interface UseFarcasterSubmitCastOptions {
  /** Bearer token for the legacy fallback path. Optional — without it
   *  the submit will fail loudly if the signer path also fails. */
  token?: string;
}

export function useFarcasterSubmitCast(options: UseFarcasterSubmitCastOptions = {}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;

  const mutation = useSubmitCast({
    fid,
    token: options.token,
    signerStore: hypersnapSignerStore,
  });

  const submitCast = useCallback(
    async (input: SubmitCastInput): Promise<SubmitCastResult> => {
      const wantMentions = input.extractMentions ?? true;
      const { text, mentions, mentionsPositions } = wantMentions
        ? await extractMentions(input.text, qc)
        : { text: input.text, mentions: [] as number[], mentionsPositions: [] as number[] };

      const inputUrls = input.embedUrls ?? [];
      const embeds = await translateEmbedUrls(inputUrls, qc);

      // Map from a CastId's hash (hex) → original sharable URL. The
      // legacy `/v2/casts` endpoint only accepts plain URL strings,
      // so when the protocol-shape produced by `translateEmbedUrls`
      // resolved a cast URL into `{castId}`, the legacy path needs
      // the reverse to keep the embed.
      const castIdHashHexToUrl = new Map<string, string>();
      embeds.forEach((e, idx) => {
        if ('castId' in e) {
          const hex = Array.from(e.castId.hash)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          const original = inputUrls[idx];
          if (original) castIdHashHexToUrl.set(hex, original);
        }
      });

      return mutation.mutateAsync({
        text,
        embeds: embeds.length > 0 ? embeds : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        mentionsPositions: mentionsPositions.length > 0 ? mentionsPositions : undefined,
        parent: input.parent,
        channelKey: input.channelKey,
        channelKeyToUrl: input.channelKey ? channelKeyToParentUrl : undefined,
        castIdToUrl: ({ hash }) => {
          const hex = Array.from(hash)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          return castIdHashHexToUrl.get(hex);
        },
      });
    },
    [mutation, qc],
  );

  return {
    submitCast,
    isPending: mutation.isPending,
    error: mutation.error,
    /** Set by the hypersnap path on success; useful for telemetry +
     *  "successfully signed locally" UI affordances. */
    source: mutation.data?.source,
  };
}
