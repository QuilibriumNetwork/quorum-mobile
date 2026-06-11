/**
 * useFeedOptimistic — the React action layer over `optimisticFeedStore`.
 *
 * The store owns persistent state; this hook binds the actions that need
 * the auth token + submit API (like/recast/follow/block/reply/quote) and
 * runs a single background submission queue that retries pending casts and
 * flips them to `failed` after a few attempts (so the user can be
 * reprompted). All views read the same store, so an action in the feed is
 * reflected in the thread and profile instantly.
 */

import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useFarcasterSubmitCast } from '@/hooks/useFarcasterSubmitCast';
import {
  likeCast,
  unlikeCast,
  recastCast,
  unrecastCast,
  followUser,
  unfollowUser,
} from '@/services/farcasterClient';
import { removeFarcasterCast } from '@/services/farcaster/removeCast';
import { logger } from '@quilibrium/quorum-shared';
import * as store from '@/services/feed/optimisticFeedStore';
import type { PendingCast, PendingAuthor } from '@/services/feed/optimisticFeedStore';

const MAX_SUBMIT_ATTEMPTS = 3;

// Module-level guard so only one drain runs at a time even if the hook is
// mounted by more than one component.
let draining = false;

function newLocalId(): string {
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PostReplyArgs {
  threadHash: string;
  parentHash: string;
  parentFid?: number;
  text: string;
  embedUrls?: string[];
}

export interface PostQuoteArgs {
  quotedHash: string;
  /** The composer's embed URLs (must already include the quoted cast URL). */
  embedUrls: string[];
  text: string;
  channelKey?: string;
}

export function useFeedOptimistic() {
  // Subscribe to the store so consumers re-render on any optimistic change
  // (see `version` below — that single subscription drives re-renders).
  const { farcasterAuthToken, user } = useAuth();
  const { submitCast } = useFarcasterSubmitCast({ token: farcasterAuthToken ?? undefined });
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // After a pending cast lands, the open thread/feed must refetch so the real
  // server copy appears and the optimistic stub reconciles away (otherwise it
  // sits on "Sending…" forever). `invalidateQueries` only refetches mounted
  // queries — i.e. whatever the user is currently looking at. The cast can take
  // a moment to index server-side, so we kick a few times with backoff.
  const refetchAfterSubmit = useCallback(() => {
    const kick = () => {
      void queryClient.invalidateQueries({ queryKey: ['farcaster-thread'] });
      void queryClient.invalidateQueries({ queryKey: ['farcaster-feed'] });
    };
    kick();
    setTimeout(kick, 1500);
    setTimeout(kick, 4000);
    setTimeout(kick, 8000);
  }, [queryClient]);

  const author: PendingAuthor = {
    fid: user?.farcaster?.fid ?? 0,
    displayName: user?.displayName ?? user?.farcaster?.username ?? '',
    username: user?.farcaster?.username ?? '',
    pfpUrl: user?.farcaster?.pfpUrl,
  };

  // ---- reactions --------------------------------------------------------
  const toggleLike = useCallback(
    async (castHash: string, currentlyLiked: boolean, currentCount: number) => {
      if (!farcasterAuthToken) return;
      const next = !currentlyLiked;
      const nextCount = next ? currentCount + 1 : Math.max(0, currentCount - 1);
      store.setLike(castHash, next, nextCount);
      try {
        if (next) await likeCast({ token: farcasterAuthToken, castHash });
        else await unlikeCast({ token: farcasterAuthToken, castHash });
      } catch (e) {
        store.setLike(castHash, currentlyLiked, currentCount); // rollback
        logger.warn('[feedOptimistic] like failed:', e instanceof Error ? e.message : e);
        showToast({ type: 'error', title: "Couldn't update", message: 'Check your connection and try again.' });
      }
    },
    [farcasterAuthToken, showToast],
  );

  const toggleRecast = useCallback(
    async (castHash: string, currentlyRecasted: boolean, currentCount: number) => {
      if (!farcasterAuthToken) return;
      const next = !currentlyRecasted;
      const nextCount = next ? currentCount + 1 : Math.max(0, currentCount - 1);
      store.setRecast(castHash, next, nextCount);
      try {
        if (next) await recastCast({ token: farcasterAuthToken, castHash });
        else await unrecastCast({ token: farcasterAuthToken, castHash });
      } catch (e) {
        store.setRecast(castHash, currentlyRecasted, currentCount);
        logger.warn('[feedOptimistic] recast failed:', e instanceof Error ? e.message : e);
        showToast({ type: 'error', title: "Couldn't update", message: 'Check your connection and try again.' });
      }
    },
    [farcasterAuthToken, showToast],
  );

  const toggleFollow = useCallback(
    async (targetFid: number, currentlyFollowing: boolean) => {
      if (!farcasterAuthToken || !targetFid) return;
      const next = !currentlyFollowing;
      store.setFollow(targetFid, next);
      try {
        if (next) await followUser({ token: farcasterAuthToken, targetFid });
        else await unfollowUser({ token: farcasterAuthToken, targetFid });
      } catch (e) {
        store.setFollow(targetFid, currentlyFollowing);
        logger.warn('[feedOptimistic] follow failed:', e instanceof Error ? e.message : e);
        showToast({ type: 'error', title: "Couldn't update", message: 'Check your connection and try again.' });
      }
    },
    [farcasterAuthToken, showToast],
  );

  // Block has no write endpoint yet — this is an immediate local hide; if a
  // block-write API is added, call it here and roll back on failure.
  const toggleBlock = useCallback((targetFid: number, currentlyBlocked: boolean) => {
    if (!targetFid) return;
    store.setBlock(targetFid, !currentlyBlocked);
  }, []);

  // Delete one of the user's own casts. Hides it immediately, then removes it
  // server-side in the background (hypersnap CAST_REMOVE when a signer is
  // provisioned, legacy DELETE otherwise). Restores it if the removal fails.
  const deleteCast = useCallback(
    async (castHash: string) => {
      store.setDeleted(castHash, true);
      try {
        await removeFarcasterCast({
          castHash,
          fid: user?.farcaster?.fid,
          token: farcasterAuthToken ?? undefined,
        });
        // Reflect the removal once the server catches up (and drop the stale
        // copy from any cached feed/thread).
        refetchAfterSubmit();
      } catch (e) {
        store.setDeleted(castHash, false); // restore
        logger.warn('[feedOptimistic] delete failed:', e instanceof Error ? e.message : e);
        showToast({ type: 'error', title: "Couldn't delete", message: 'Check your connection and try again.' });
      }
    },
    [user?.farcaster?.fid, farcasterAuthToken, refetchAfterSubmit, showToast],
  );

  // ---- background submission queue --------------------------------------
  const submitOne = useCallback(
    async (p: PendingCast): Promise<string | undefined> => {
      if (p.kind === 'reply') {
        const res = await submitCast({
          text: p.text,
          embedUrls: p.embedUrls,
          parent: { castHashHex: p.parentHash ?? '', fid: p.parentFid },
        });
        return res.hash;
      }
      // 'quote' and 'top' both post a top-level cast; the quoted cast URL is
      // already carried in embedUrls.
      const res = await submitCast({
        text: p.text,
        embedUrls: p.embedUrls,
        channelKey: p.channelKey,
      });
      return res.hash;
    },
    [submitCast],
  );

  const drainQueue = useCallback(async () => {
    if (draining || !farcasterAuthToken) return;
    draining = true;
    let anySucceeded = false;
    try {
      // Snapshot the ids to attempt this pass; the store is the source of
      // truth so we re-read each item before submitting. Only un-sent
      // 'pending' items without a realHash are eligible — this is what
      // stops a successfully-sent stub from being resubmitted forever.
      const ids = store
        .getPending()
        .filter((p) => p.status === 'pending' && !p.realHash)
        .map((p) => p.localId);
      for (const localId of ids) {
        const p = store.getPending().find((x) => x.localId === localId);
        if (!p || p.status !== 'pending' || p.realHash) continue;
        try {
          const hash = await submitOne(p);
          // Mark terminal-success. Keep the stub (now with the real hash)
          // until a thread/feed refetch reconciles it away — avoids a
          // flicker where the optimistic cast vanishes before the server
          // copy appears. 'sent' is excluded from the queue above, so it is
          // never resubmitted.
          store.updatePending(p.localId, { realHash: hash, status: 'sent', attempts: p.attempts + 1 });
          anySucceeded = true;
        } catch (e) {
          const attempts = p.attempts + 1;
          if (attempts >= MAX_SUBMIT_ATTEMPTS) {
            store.updatePending(p.localId, {
              status: 'failed',
              attempts,
              error: e instanceof Error ? e.message : 'Failed to send',
            });
          } else {
            store.updatePending(p.localId, { attempts });
          }
        }
      }
    } finally {
      draining = false;
    }
    // A landed cast won't show until the view it lives in refetches.
    if (anySucceeded) refetchAfterSubmit();
  }, [farcasterAuthToken, submitOne, refetchAfterSubmit]);

  // Kick the queue whenever the pending set changes or the token arrives.
  const version = store.useOptimisticVersion();
  useEffect(() => {
    void drainQueue();
  }, [drainQueue, version]);

  // ---- posting actions --------------------------------------------------
  const postReply = useCallback(
    (args: PostReplyArgs): string => {
      const localId = newLocalId();
      const pending: PendingCast = {
        localId,
        kind: 'reply',
        threadHash: args.threadHash,
        parentHash: args.parentHash,
        parentFid: args.parentFid,
        text: args.text,
        embedUrls: args.embedUrls ?? [],
        author,
        timestamp: Date.now(),
        status: 'pending',
        attempts: 0,
      };
      store.addPending(pending); // version bump → drainQueue fires
      return localId;
    },
    // author is derived from user; intentionally not a dep to keep stable
    // identity — the closure reads the latest user via re-render anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.farcaster?.fid, user?.displayName, user?.farcaster?.username, user?.farcaster?.pfpUrl],
  );

  const postTop = useCallback(
    (args: { text: string; embedUrls?: string[]; channelKey?: string }): string => {
      const localId = newLocalId();
      store.addPending({
        localId,
        kind: 'top',
        channelKey: args.channelKey,
        text: args.text,
        embedUrls: args.embedUrls ?? [],
        author,
        timestamp: Date.now(),
        status: 'pending',
        attempts: 0,
      });
      return localId;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.farcaster?.fid, user?.displayName, user?.farcaster?.username, user?.farcaster?.pfpUrl],
  );

  const postQuote = useCallback(
    (args: PostQuoteArgs): string => {
      const localId = newLocalId();
      const pending: PendingCast = {
        localId,
        kind: 'quote',
        quotedHash: args.quotedHash,
        channelKey: args.channelKey,
        text: args.text,
        embedUrls: args.embedUrls,
        author,
        timestamp: Date.now(),
        status: 'pending',
        attempts: 0,
      };
      store.addPending(pending);
      return localId;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.farcaster?.fid, user?.displayName, user?.farcaster?.username, user?.farcaster?.pfpUrl],
  );

  const retryPending = useCallback(
    (localId: string) => {
      store.updatePending(localId, { status: 'pending', attempts: 0, error: undefined });
      void drainQueue();
    },
    [drainQueue],
  );

  const discardPending = useCallback((localId: string) => {
    store.removePending(localId);
  }, []);

  return {
    // reads — the like/recast/follow Maps back the feed's existing
    // `likeStates`/`recastStates`/`followStates` props directly.
    getLikes: store.getLikes,
    getRecasts: store.getRecasts,
    getFollows: store.getFollows,
    reconcileReactions: store.reconcileReactions,
    replyCountFor: store.replyCountFor,
    followView: store.followView,
    isBlocked: store.isBlocked,
    isDeleted: store.isDeleted,
    pendingRepliesAsThreadCasts: store.pendingRepliesAsThreadCasts,
    pendingTopLevel: store.pendingTopLevel,
    reconcilePending: store.reconcilePending,
    reconcilePendingByHash: store.reconcilePendingByHash,
    // actions
    toggleLike,
    toggleRecast,
    toggleFollow,
    toggleBlock,
    deleteCast,
    postReply,
    postQuote,
    postTop,
    retryPending,
    discardPending,
  };
}
