/**
 * optimisticFeedStore — a small, persistent, app-global store for
 * optimistic Farcaster feed interactions (replies/quotes, likes, recasts,
 * follows, blocks). It's a module-level singleton (not a React context) so
 * its state survives tab switches and feed open/close with no provider
 * mounting, and is shared identically across the feed list, thread view,
 * profile view, and channel view.
 *
 * Design notes:
 *  - Reaction/follow overrides are stored as the user's *intended* state
 *    and applied as a DELTA over the server value, so once a refetch
 *    reflects the action the delta naturally becomes 0 — no double-count,
 *    no manual reconciliation needed. A satisfied override is harmless and
 *    gets swept lazily.
 *  - Reply counts are derived from the live pending list, so they
 *    self-correct as pending replies reconcile.
 *  - Pending casts (reply/quote/top-level) are persisted to MMKV so a
 *    crash or kill mid-send doesn't lose the user's text — mirrors the
 *    audio-space pending-chat pattern.
 *
 * Submission itself is driven from React (it needs the auth token); this
 * module only owns state, persistence, and the pure overlay/reconcile
 * helpers. See `useFeedOptimistic` for the action + background-retry layer.
 */

import { useSyncExternalStore } from 'react';
import { createMMKV } from 'react-native-mmkv';
import { logger } from '@quilibrium/quorum-shared';
import type { ThreadCast } from '@/hooks/useFarcasterThread';

const storage = createMMKV({ id: 'feed-optimistic' });
const PENDING_KEY = 'feed-optimistic-pending:v1';
/** Drop pending stubs older than this if the server never echoed them
 *  back (we assume the send is dead and stop re-surfacing it). */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a stub stays once its cast is on the network. The views refetch
 *  over the next ~5 s (`refetchAfterSubmit`) so the real cast can replace it,
 *  but a feed may never carry the cast: Hypersnap's following feed leaves out
 *  the viewer's own casts unless they follow themselves. Past this the stub
 *  goes, rather than sitting on "Posted" for good. */
export const SENT_STUB_TTL_MS = 20_000;

export type PendingKind = 'reply' | 'quote' | 'top';
// - 'pending': not yet accepted by Hypersnap; the queue submits it.
// - 'confirming': Hypersnap accepted it (realHash set), which only means its
//   mempool took it. The queue looks the cast up until it shows up ('sent') or
//   CONFIRM_TIMEOUT_MS passes ('failed'); see services/feed/castConfirmation.
// - 'sent': on the network. Terminal: the stub only lingers until a refetch
//   reconciles it away, or SENT_STUB_TTL_MS passes.
// - 'failed': not sent, or never showed up; the user can retry or discard.
// The queue MUST NOT re-submit a 'confirming' or 'sent' item — leaving a sent
// item 'pending' caused an infinite re-submit loop (duplicate casts + an ANR).
export type PendingStatus = 'pending' | 'confirming' | 'sent' | 'failed';

export interface PendingAuthor {
  fid: number;
  displayName: string;
  username: string;
  pfpUrl?: string;
}

export interface PendingCast {
  localId: string;
  kind: PendingKind;
  /** Thread root hash (scopes which thread a reply merges into). */
  threadHash?: string;
  /** The cast being replied to (for kind === 'reply'). */
  parentHash?: string;
  /** FID of the parent cast's author (the hypersnap reply path wants it). */
  parentFid?: number;
  /** The cast being quoted (for kind === 'quote'). */
  quotedHash?: string;
  /** Channel to post a top-level cast into (optional). */
  channelKey?: string;
  text: string;
  embedUrls: string[];
  author: PendingAuthor;
  timestamp: number;
  status: PendingStatus;
  attempts: number;
  error?: string;
  /** Hash of the copy Hypersnap last accepted. */
  realHash?: string;
  /** When Hypersnap accepted that copy (ms); confirmation times out from here. */
  acceptedAt?: number;
  /** Hashes of earlier accepted copies that hadn't shown up when the cast was
   *  retried. A retry re-signs (new timestamp, new hash), so an earlier copy
   *  could still land; these are checked before re-signing and while
   *  confirming, so a late copy isn't posted twice. */
  priorHashes?: string[];
}

export interface LikeState {
  liked: boolean;
  count: number;
}
export interface RecastState {
  recasted: boolean;
  count: number;
}

interface OptimisticState {
  // Keyed by cast hash (exact, matching the feed's render reads). Stored as
  // immutable maps replaced on each change so FlashList `extraData` detects
  // them. Absolute counts (server±1 at click time) mirror the prior
  // component-state behaviour; `reconcileReactions` drops an override once
  // the server reflects it so the live count shows through again.
  likes: Map<string, LikeState>;
  recasts: Map<string, RecastState>;
  follows: Map<number, boolean>; // fid -> intended following state
  blocks: Set<number>; // fids hidden optimistically
  deleted: Set<string>; // cast hashes hidden optimistically after delete
  pending: PendingCast[];
  // What the server says the viewer has liked / recast (lowercase hashes):
  // their newest reactions, from the hub API (`services/farcaster/viewerReactions.ts`),
  // kept current with their own writes. The overrides above sit on top.
  viewerLikes: Set<string>;
  viewerRecasts: Set<string>;
}

const state: OptimisticState = {
  likes: new Map(),
  recasts: new Map(),
  follows: new Map(),
  blocks: new Set(),
  deleted: new Set(),
  pending: loadPending(),
  viewerLikes: new Set(),
  viewerRecasts: new Set(),
};

// ---- subscription (useSyncExternalStore) --------------------------------
let version = 0;
const listeners = new Set<() => void>();
function emit() {
  version++;
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): number {
  return version;
}

/** Subscribe a component to the store; returns a monotonically-increasing
 *  version so any change triggers a re-render, then read the helpers. */
export function useOptimisticVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Run `cb` after every store change, outside React. Returns the unsubscribe. */
export function subscribeOptimistic(cb: () => void): () => void {
  return subscribe(cb);
}

// Per-key subscriptions. Each returns the entry for one cast or account, and
// re-renders its caller only when that entry changes: the maps are replaced on
// every write, but untouched entries keep their identity, so a like re-renders
// the cell showing that cast and nothing else.
export function useLikeOverride(castHash: string): LikeState | undefined {
  const read = () => state.likes.get(castHash);
  return useSyncExternalStore(subscribe, read, read);
}
export function useRecastOverride(castHash: string): RecastState | undefined {
  const read = () => state.recasts.get(castHash);
  return useSyncExternalStore(subscribe, read, read);
}
export function useFollowOverride(fid: number): boolean | undefined {
  const read = () => state.follows.get(fid);
  return useSyncExternalStore(subscribe, read, read);
}
export function useIsCastDeleted(castHash: string): boolean {
  const read = () => state.deleted.has(lc(castHash));
  return useSyncExternalStore(subscribe, read, read);
}
/** Whether the server says the viewer has liked this cast. */
export function useViewerLiked(castHash: string): boolean {
  const read = () => state.viewerLikes.has(lc(castHash));
  return useSyncExternalStore(subscribe, read, read);
}
/** Whether the server says the viewer has recast this cast. */
export function useViewerRecasted(castHash: string): boolean {
  const read = () => state.viewerRecasts.has(lc(castHash));
  return useSyncExternalStore(subscribe, read, read);
}
// Whole-collection subscriptions, for a view that reads these while rendering
// (the thread view): it re-renders when the collection changes, and not on a
// like or recast elsewhere, which only touch the like/recast maps.
export function usePendingList(): PendingCast[] {
  const read = () => state.pending;
  return useSyncExternalStore(subscribe, read, read);
}
export function useDeletedSet(): Set<string> {
  const read = () => state.deleted;
  return useSyncExternalStore(subscribe, read, read);
}
export function useFollowsMap(): Map<number, boolean> {
  const read = () => state.follows;
  return useSyncExternalStore(subscribe, read, read);
}

/** The pending top-level casts and quotes; re-renders only when that list changes. */
export function usePendingTopLevel(): PendingCast[] {
  return useSyncExternalStore(subscribe, pendingTopLevelSnapshot, pendingTopLevelSnapshot);
}

// ---- persistence --------------------------------------------------------
function loadPending(): PendingCast[] {
  try {
    const raw = storage.getString(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingCast[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    // A 'sent' stub from an earlier run already landed and has outlived its
    // refetch window, so only unsent, unconfirmed and failed casts come back.
    return parsed.filter((p) => p.status !== 'sent' && now - p.timestamp < PENDING_TTL_MS);
  } catch {
    return [];
  }
}
function savePending() {
  try {
    storage.set(PENDING_KEY, JSON.stringify(state.pending));
  } catch (e) {
    logger.warn('[optimisticFeed] savePending failed:', e instanceof Error ? e.message : e);
  }
}

const lc = (h?: string) => (h ?? '').toLowerCase();

// ---- reactions ----------------------------------------------------------
// Immutable map replacement on every write so the returned map can be used
// directly as FlashList `extraData` (identity changes => rows re-render),
// exactly like the previous component-state Maps did.
export function setLike(castHash: string, liked: boolean, count: number): void {
  state.likes = new Map(state.likes).set(castHash, { liked, count });
  emit();
}
export function setRecast(castHash: string, recasted: boolean, count: number): void {
  state.recasts = new Map(state.recasts).set(castHash, { recasted, count });
  emit();
}
export function getLikes(): Map<string, LikeState> {
  return state.likes;
}
export function getRecasts(): Map<string, RecastState> {
  return state.recasts;
}

// ---- the viewer's reactions, as the server has them -----------------------
/** Replace the viewer's reaction sets with a fresh fetch (or clear them, for
 *  an account switch). */
export function setViewerReactions(likes: Iterable<string>, recasts: Iterable<string>): void {
  state.viewerLikes = new Set(Array.from(likes, lc));
  state.viewerRecasts = new Set(Array.from(recasts, lc));
  emit();
}
/** Record the viewer's own like/recast once the write has landed, so the set
 *  stays current between fetches. */
export function setViewerReaction(kind: 'like' | 'recast', castHash: string, active: boolean): void {
  const key = lc(castHash);
  const current = kind === 'like' ? state.viewerLikes : state.viewerRecasts;
  if (current.has(key) === active) return;
  const next = new Set(current);
  if (active) next.add(key);
  else next.delete(key);
  if (kind === 'like') state.viewerLikes = next;
  else state.viewerRecasts = next;
  emit();
}
export function isViewerLiked(castHash: string): boolean {
  return state.viewerLikes.has(lc(castHash));
}
export function isViewerRecasted(castHash: string): boolean {
  return state.viewerRecasts.has(lc(castHash));
}

/**
 * Drop like/recast overrides the server now reflects, so the live server
 * count shows through again instead of the frozen click-time count.
 *
 * An override goes once the server agrees on both counts: the viewer's
 * reaction set says the same liked/recast state, and the cast's count from the
 * server has caught up with the one the override holds (at least it, for a
 * like; at most it, for an unlike). Comparing the state alone would drop an
 * override while the cast's count was still from before the click, and the
 * count would step back by one.
 */
export function reconcileReactions(
  casts: { hash?: string; reactions?: { count?: number }; recasts?: { count?: number } }[],
): void {
  let likes = state.likes;
  let recasts = state.recasts;
  const caughtUp = (active: boolean, serverCount: number | undefined, overrideCount: number) =>
    typeof serverCount === 'number' && (active ? serverCount >= overrideCount : serverCount <= overrideCount);
  for (const c of casts) {
    const key = c.hash;
    if (!key) continue;
    const lo = likes.get(key);
    if (lo && state.viewerLikes.has(lc(key)) === lo.liked && caughtUp(lo.liked, c.reactions?.count, lo.count)) {
      if (likes === state.likes) likes = new Map(likes);
      likes.delete(key);
    }
    const ro = recasts.get(key);
    if (
      ro &&
      state.viewerRecasts.has(lc(key)) === ro.recasted &&
      caughtUp(ro.recasted, c.recasts?.count, ro.count)
    ) {
      if (recasts === state.recasts) recasts = new Map(recasts);
      recasts.delete(key);
    }
  }
  if (likes !== state.likes || recasts !== state.recasts) {
    state.likes = likes;
    state.recasts = recasts;
    emit();
  }
}

/** Server reply count + however many un-reconciled pending replies target
 *  this cast. */
export function replyCountFor(castHash: string, serverReplyCount: number): number {
  const key = lc(castHash);
  const extra = state.pending.reduce(
    (n, p) => (p.kind === 'reply' && lc(p.parentHash) === key ? n + 1 : n),
    0,
  );
  return Math.max(0, serverReplyCount) + extra;
}

// ---- follow / block -----------------------------------------------------
export function setFollow(fid: number, following: boolean): void {
  state.follows = new Map(state.follows).set(fid, following);
  emit();
}
export function clearFollow(fid: number): void {
  if (!state.follows.has(fid)) return;
  const next = new Map(state.follows);
  next.delete(fid);
  state.follows = next;
  emit();
}
export function getFollows(): Map<number, boolean> {
  return state.follows;
}
export function followView(fid: number, serverFollowing: boolean): boolean {
  return state.follows.get(fid) ?? serverFollowing;
}

export function setBlock(fid: number, blocked: boolean): void {
  if (blocked) state.blocks.add(fid);
  else state.blocks.delete(fid);
  emit();
}
export function isBlocked(fid: number): boolean {
  return state.blocks.has(fid);
}

// ---- optimistic delete --------------------------------------------------
// Hashes are normalized lowercase (matching the reaction/reconcile reads).
export function setDeleted(castHash: string, deleted: boolean): void {
  const key = lc(castHash);
  if (state.deleted.has(key) === deleted) return;
  // Replaced, not mutated, so a subscriber to the set sees the change.
  const next = new Set(state.deleted);
  if (deleted) next.add(key);
  else next.delete(key);
  state.deleted = next;
  emit();
}
export function isDeleted(castHash: string): boolean {
  return state.deleted.has(lc(castHash));
}

// ---- pending casts ------------------------------------------------------
const sentStubTimers = new Map<string, ReturnType<typeof setTimeout>>();

function expireSentStub(localId: string): void {
  if (sentStubTimers.has(localId)) return;
  sentStubTimers.set(
    localId,
    setTimeout(() => {
      sentStubTimers.delete(localId);
      removePending(localId);
    }, SENT_STUB_TTL_MS),
  );
}

export function addPending(p: PendingCast): void {
  state.pending = [...state.pending, p];
  savePending();
  emit();
}
export function updatePending(localId: string, partial: Partial<PendingCast>): void {
  let changed = false;
  state.pending = state.pending.map((p) => {
    if (p.localId !== localId) return p;
    changed = true;
    return { ...p, ...partial };
  });
  if (changed) {
    savePending();
    emit();
    if (partial.status === 'sent') expireSentStub(localId);
  }
}
export function removePending(localId: string): void {
  const next = state.pending.filter((p) => p.localId !== localId);
  if (next.length !== state.pending.length) {
    state.pending = next;
    savePending();
    emit();
  }
}
export function getPending(): PendingCast[] {
  return state.pending;
}

/** Pending replies for a thread, shaped as ThreadCast so they can be fed
 *  straight into the thread's `organizeReplies` (positioned by parentHash +
 *  timestamp). A `__pending` flag lets the renderer show the status chip. */
export function pendingRepliesAsThreadCasts(threadHash: string): (ThreadCast & {
  __pending: PendingCast;
})[] {
  const key = lc(threadHash);
  return state.pending
    .filter((p) => p.kind === 'reply' && (lc(p.threadHash) === key || lc(p.parentHash) === key))
    .map((p) => ({
      hash: p.realHash ?? p.localId,
      threadHash,
      author: {
        fid: p.author.fid,
        displayName: p.author.displayName,
        username: p.author.username,
        pfp: { url: p.author.pfpUrl },
      },
      text: p.text,
      timestamp: p.timestamp,
      parentHash: p.parentHash,
      reactions: { count: 0 },
      recasts: { count: 0 },
      replies: { count: 0 },
      viewerContext: { reacted: false, recast: false },
      __pending: p,
    }));
}

/** Pending top-level casts / quotes (rendered at the top of the feed). */
export function pendingTopLevel(): PendingCast[] {
  return state.pending.filter((p) => p.kind === 'top' || p.kind === 'quote');
}

// useSyncExternalStore needs the same array back while nothing changed, so the
// filtered list is cached against the `pending` array it came from.
let topLevelSource: PendingCast[] | undefined;
let topLevelCache: PendingCast[] = [];
function pendingTopLevelSnapshot(): PendingCast[] {
  if (topLevelSource !== state.pending) {
    topLevelSource = state.pending;
    const next = pendingTopLevel();
    const same =
      next.length === topLevelCache.length && next.every((p, i) => p === topLevelCache[i]);
    if (!same) topLevelCache = next;
  }
  return topLevelCache;
}

/**
 * Drop pending stubs the server has now echoed back. Match on author FID +
 * exact text within a 60s window of the optimistic timestamp — distinct
 * enough that two different real casts from the same author won't collide,
 * generous enough to cover propagation jitter. Mirrors AudioSpaceContext's
 * reconcilePending.
 */
export function reconcilePending(
  serverCasts: { author?: { fid?: number }; text?: string; timestamp?: number }[],
): void {
  if (state.pending.length === 0) return;
  const next = state.pending.filter((p) => {
    const match = serverCasts.find(
      (s) =>
        s.author?.fid === p.author.fid &&
        s.text === p.text &&
        typeof s.timestamp === 'number' &&
        Math.abs(s.timestamp - p.timestamp) < 60_000,
    );
    return !match;
  });
  if (next.length !== state.pending.length) {
    state.pending = next;
    savePending();
    emit();
  }
}

/** Drop pending stubs whose confirmed real hash now appears in a list of
 *  server hashes (used by the feed/top-level path, which has a real hash
 *  after submit — more reliable than the text+timestamp match). */
export function reconcilePendingByHash(hashes: string[]): void {
  if (state.pending.length === 0) return;
  const set = new Set(hashes.map((h) => lc(h)));
  const next = state.pending.filter((p) => !(p.realHash && set.has(lc(p.realHash))));
  if (next.length !== state.pending.length) {
    state.pending = next;
    savePending();
    emit();
  }
}

/** Test/diagnostic reset. */
export function __resetOptimisticFeed(): void {
  state.likes = new Map();
  state.recasts = new Map();
  state.follows = new Map();
  state.blocks = new Set();
  state.pending = [];
  state.viewerLikes = new Set();
  state.viewerRecasts = new Set();
  for (const timer of sentStubTimers.values()) clearTimeout(timer);
  sentStubTimers.clear();
  savePending();
  emit();
}
