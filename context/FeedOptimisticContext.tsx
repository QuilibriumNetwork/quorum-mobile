/**
 * useFeedOptimistic — the React action layer over `optimisticFeedStore`.
 *
 * The store owns persistent state; this hook binds the actions that write to
 * Farcaster (like/recast/follow/block/reply/quote/delete), all signed with the
 * account's Hypersnap signer, and
 * runs a single background submission queue that retries pending casts and
 * flips them to `failed` after a few attempts (so the user can be
 * reprompted). A cast Hypersnap accepts is then looked up until it shows up on
 * the network, and only then shown as posted. All views read the same store,
 * so an action in the feed is reflected in the thread and profile instantly.
 *
 * `useFeedOptimisticActions` is the actions alone and doesn't re-render on
 * store changes; `useFeedOptimistic` adds the reads and re-renders on every
 * change.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useFarcasterSubmitCast } from '@/hooks/useFarcasterSubmitCast';
import { prependNewestToFeed } from '@/hooks/useFarcasterFeed';
import { removeOwnCast, setCastReaction, setFollowing } from '@/services/farcaster/hypersnapWrites';
import { logger } from '@quilibrium/quorum-shared';
import * as store from '@/services/feed/optimisticFeedStore';
import type { PendingCast, PendingAuthor } from '@/services/feed/optimisticFeedStore';
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS, findLandedCopy } from '@/services/feed/castConfirmation';

const MAX_SUBMIT_ATTEMPTS = 3;

// Module-level guard so only one drain runs at a time even if the hook is
// mounted by more than one component.
let draining = false;

// One confirmation poll for the app, however many components mount the hook.
// The timer stays set while a check runs, so store changes made by the check
// don't start a second one.
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
let runConfirmCheck: (() => Promise<void>) | undefined;

function scheduleConfirmCheck(): void {
  if (confirmTimer !== undefined) return;
  if (!store.getPending().some((p) => p.status === 'confirming')) return;
  confirmTimer = setTimeout(async () => {
    try {
      await runConfirmCheck?.();
    } finally {
      confirmTimer = undefined;
      scheduleConfirmCheck();
    }
  }, CONFIRM_POLL_MS);
}

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

const normalizeHash = (hash: string) => hash.toLowerCase().replace(/^0x/, '');

/** Whether a cached thread (its casts, flat) holds any of `hashes`. */
function threadHolds(data: unknown, hashes: Set<string>): boolean {
  if (!Array.isArray(data)) return false;
  return data.some(
    (cast: { hash?: string; threadHash?: string }) =>
      (cast?.hash && hashes.has(normalizeHash(cast.hash))) ||
      (cast?.threadHash && hashes.has(normalizeHash(cast.threadHash))),
  );
}

/**
 * The actions, without subscribing the caller to the store: a like elsewhere
 * doesn't re-render whoever calls this. Cells read the state they show through
 * the store's per-key hooks (`useLikeOverride` and friends). The returned object
 * keeps its identity while the account stays the same.
 */
export function useFeedOptimisticActions() {
  const { user } = useAuth();
  const fid = user?.farcaster?.fid;
  const { submitCast } = useFarcasterSubmitCast();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // Once a pending cast is on the network, the thread it's in and the feed must
  // pick it up so the real server copy appears and the stub reconciles away. The
  // cast can take a moment to index server-side, so this checks twice. Only the
  // threads holding one of `castHashes` (a reply's parent, a deleted cast) are
  // refetched: every thread was, and stacked thread screens and chat cast cards
  // stay mounted, each a whole thread download. The feed only has its newest
  // casts pulled into the top: invalidating it refetched every page it held,
  // four times over, about 24 requests a post.
  const refetchAfterSubmit = useCallback((castHashes: (string | undefined)[] = []) => {
    const changed = new Set(castHashes.filter((h): h is string => !!h).map(normalizeHash));
    const kick = () => {
      if (changed.size > 0) {
        void queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === 'farcaster-thread' && threadHolds(query.state.data, changed),
        });
      }
      if (fid) {
        prependNewestToFeed(queryClient, fid).catch((e) => {
          logger.warn('[feedOptimistic] feed refresh failed:', e instanceof Error ? e.message : e);
        });
      }
    };
    setTimeout(kick, 1500);
    setTimeout(kick, 5000);
  }, [queryClient, fid]);

  const author: PendingAuthor = {
    fid: user?.farcaster?.fid ?? 0,
    displayName: user?.displayName ?? user?.farcaster?.username ?? '',
    username: user?.farcaster?.username ?? '',
    pfpUrl: user?.farcaster?.pfpUrl,
  };

  // ---- reactions --------------------------------------------------------
  // `castAuthorFid` saves a lookup when the caller has it; without it the
  // author is resolved from the hash.
  const toggleLike = useCallback(
    async (castHash: string, currentlyLiked: boolean, currentCount: number, castAuthorFid?: number) => {
      if (!fid) return;
      const next = !currentlyLiked;
      const nextCount = next ? currentCount + 1 : Math.max(0, currentCount - 1);
      store.setLike(castHash, next, nextCount);
      try {
        await setCastReaction({ fid, castHash, castAuthorFid, kind: 'like', active: next });
        store.setViewerReaction('like', castHash, next);
      } catch (e) {
        store.setLike(castHash, currentlyLiked, currentCount); // rollback
        logger.warn('[feedOptimistic] like failed:', e instanceof Error ? e.message : e);
        showToast({ type: 'error', title: "Couldn't update", message: 'Check your connection and try again.' });
      }
    },
    [fid, showToast],
  );

  const toggleRecast = useCallback(
    async (castHash: string, currentlyRecasted: boolean, currentCount: number, castAuthorFid?: number) => {
      if (!fid) return;
      const next = !currentlyRecasted;
      const nextCount = next ? currentCount + 1 : Math.max(0, currentCount - 1);
      store.setRecast(castHash, next, nextCount);
      try {
        await setCastReaction({ fid, castHash, castAuthorFid, kind: 'recast', active: next });
        store.setViewerReaction('recast', castHash, next);
      } catch (e) {
        store.setRecast(castHash, currentlyRecasted, currentCount);
        logger.warn('[feedOptimistic] recast failed:', e instanceof Error ? e.message : e);
        showToast({ type: 'error', title: "Couldn't update", message: 'Check your connection and try again.' });
      }
    },
    [fid, showToast],
  );

  const toggleFollow = useCallback(
    async (targetFid: number, currentlyFollowing: boolean) => {
      if (!fid || !targetFid) return;
      const next = !currentlyFollowing;
      store.setFollow(targetFid, next);
      try {
        await setFollowing({ fid, targetFid, following: next });
      } catch (e) {
        store.setFollow(targetFid, currentlyFollowing);
        logger.warn('[feedOptimistic] follow failed:', e instanceof Error ? e.message : e);
        showToast({ type: 'error', title: "Couldn't update", message: 'Check your connection and try again.' });
      }
    },
    [fid, showToast],
  );

  // Block has no write endpoint yet — this is an immediate local hide; if a
  // block-write API is added, call it here and roll back on failure.
  const toggleBlock = useCallback((targetFid: number, currentlyBlocked: boolean) => {
    if (!targetFid) return;
    store.setBlock(targetFid, !currentlyBlocked);
  }, []);

  // Delete one of the user's own casts. Hides it immediately, then removes it
  // server-side in the background (a signed CAST_REMOVE). Restores it if the
  // removal fails.
  const deleteCast = useCallback(
    async (castHash: string) => {
      if (!fid) return;
      store.setDeleted(castHash, true);
      try {
        await removeOwnCast({ fid, castHash });
        // Reflect the removal once the server catches up (and drop the stale
        // copy from any cached feed/thread).
        refetchAfterSubmit([castHash]);
      } catch (e) {
        store.setDeleted(castHash, false); // restore
        logger.warn('[feedOptimistic] delete failed:', e instanceof Error ? e.message : e);
        showToast({ type: 'error', title: "Couldn't delete", message: 'Check your connection and try again.' });
      }
    },
    [fid, refetchAfterSubmit, showToast],
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
    if (draining || !fid) return;
    draining = true;
    let anyLanded = false;
    // The threads a landed reply belongs in.
    const landedThreads: (string | undefined)[] = [];
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
          // A retried cast: an earlier copy may have landed since. Re-signing
          // gives a new hash, so check those first rather than post it twice.
          if (p.priorHashes?.length) {
            const earlier = await findLandedCopy(p.author.fid, p.priorHashes);
            if (typeof earlier === 'object') {
              store.updatePending(p.localId, { status: 'sent', realHash: earlier.landed, priorHashes: undefined });
              anyLanded = true;
              landedThreads.push(p.parentHash, p.threadHash);
              continue;
            }
            if (earlier === 'unknown') throw new Error("Couldn't check whether it already posted");
          }
          const hash = await submitOne(p);
          // Accepted: Hypersnap's mempool took it. It's 'sent' once it shows
          // up on the network (`confirmPending`). 'confirming' is excluded
          // from the queue above, so it is never resubmitted.
          store.updatePending(p.localId, {
            realHash: hash,
            status: 'confirming',
            acceptedAt: Date.now(),
            attempts: p.attempts + 1,
          });
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
    if (anyLanded) refetchAfterSubmit(landedThreads);
  }, [fid, submitOne, refetchAfterSubmit]);

  // Look up each accepted cast until one of its copies shows up ('sent': the
  // stub stays until a refetch replaces it, or SENT_STUB_TTL_MS), or until
  // Hypersnap has said it isn't there past CONFIRM_TIMEOUT_MS ('failed'). A
  // lookup that fails proves nothing either way, so it keeps waiting.
  const confirmPending = useCallback(async () => {
    let anyLanded = false;
    const landedThreads: (string | undefined)[] = [];
    const due = store.getPending().filter((p) => p.status === 'confirming' && p.realHash);
    for (const p of due) {
      const result = await findLandedCopy(p.author.fid, [p.realHash as string, ...(p.priorHashes ?? [])]);
      const current = store.getPending().find((x) => x.localId === p.localId);
      if (!current || current.status !== 'confirming' || current.realHash !== p.realHash) continue;
      if (typeof result === 'object') {
        store.updatePending(p.localId, { status: 'sent', realHash: result.landed, priorHashes: undefined });
        anyLanded = true;
        landedThreads.push(p.parentHash, p.threadHash);
      } else if (result === 'absent' && Date.now() - (p.acceptedAt ?? p.timestamp) >= CONFIRM_TIMEOUT_MS) {
        store.updatePending(p.localId, { status: 'failed', error: "Didn't reach the network" });
      }
    }
    if (anyLanded) refetchAfterSubmit(landedThreads);
  }, [refetchAfterSubmit]);

  useEffect(() => {
    runConfirmCheck = confirmPending;
    scheduleConfirmCheck();
  }, [confirmPending]);

  // Kick the queue when the account arrives and after every store change. It
  // runs on the next tick, so a change made inside a drain (a failed attempt
  // recorded) is retried once that drain has finished, as it was when this ran
  // from a render effect.
  useEffect(() => {
    void drainQueue();
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = store.subscribeOptimistic(() => {
      scheduleConfirmCheck();
      if (scheduled !== undefined) return;
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void drainQueue();
      }, 0);
    });
    return () => {
      unsubscribe();
      if (scheduled !== undefined) clearTimeout(scheduled);
    };
  }, [drainQueue]);

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

  // A retry re-signs: the timestamp has to be fresh or the mempool rejects
  // it, so the hash changes. The copy Hypersnap accepted last time may still
  // land, so its hash is kept and checked before re-signing.
  const retryPending = useCallback(
    (localId: string) => {
      const p = store.getPending().find((x) => x.localId === localId);
      if (!p) return;
      const priorHashes = p.realHash ? [...(p.priorHashes ?? []), p.realHash] : p.priorHashes;
      store.updatePending(localId, {
        status: 'pending',
        attempts: 0,
        error: undefined,
        realHash: undefined,
        acceptedAt: undefined,
        priorHashes,
      });
      void drainQueue();
    },
    [drainQueue],
  );

  const discardPending = useCallback((localId: string) => {
    store.removePending(localId);
  }, []);

  return useMemo(
    () => ({
      reconcileReactions: store.reconcileReactions,
      reconcilePending: store.reconcilePending,
      reconcilePendingByHash: store.reconcilePendingByHash,
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
    }),
    [
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
    ],
  );
}

/**
 * The actions plus the store's reads, re-rendering the caller on any optimistic
 * change. For a view that reads the store while rendering (the thread view);
 * a list should use `useFeedOptimisticActions` and per-key hooks instead.
 */
export function useFeedOptimistic() {
  store.useOptimisticVersion();
  const actions = useFeedOptimisticActions();
  return {
    getLikes: store.getLikes,
    getRecasts: store.getRecasts,
    getFollows: store.getFollows,
    replyCountFor: store.replyCountFor,
    followView: store.followView,
    isBlocked: store.isBlocked,
    isDeleted: store.isDeleted,
    isViewerLiked: store.isViewerLiked,
    isViewerRecasted: store.isViewerRecasted,
    pendingRepliesAsThreadCasts: store.pendingRepliesAsThreadCasts,
    pendingTopLevel: store.pendingTopLevel,
    ...actions,
  };
}
