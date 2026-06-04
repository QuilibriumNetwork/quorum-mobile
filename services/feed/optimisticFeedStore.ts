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

export type PendingKind = 'reply' | 'quote' | 'top';
// 'sent' is terminal-success: the submit landed (realHash set) and the stub
// only lingers until a refetch reconciles it away. The queue MUST NOT
// re-submit a 'sent' item — leaving it 'pending' caused an infinite
// re-submit loop (duplicate casts + an ANR).
export type PendingStatus = 'pending' | 'sent' | 'failed';

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
  /** Real cast hash once the server confirms the submit. */
  realHash?: string;
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
}

const state: OptimisticState = {
  likes: new Map(),
  recasts: new Map(),
  follows: new Map(),
  blocks: new Set(),
  deleted: new Set(),
  pending: loadPending(),
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

// ---- persistence --------------------------------------------------------
function loadPending(): PendingCast[] {
  try {
    const raw = storage.getString(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingCast[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((p) => now - p.timestamp < PENDING_TTL_MS);
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

/** Drop like/recast overrides the server now reflects, so the live server
 *  count shows through again instead of the frozen click-time count. */
export function reconcileReactions(
  casts: { hash?: string; viewerContext?: { reacted?: boolean; recast?: boolean } }[],
): void {
  let likes = state.likes;
  let recasts = state.recasts;
  for (const c of casts) {
    const key = c.hash;
    if (!key) continue;
    const lo = likes.get(key);
    if (lo && (c.viewerContext?.reacted ?? false) === lo.liked) {
      if (likes === state.likes) likes = new Map(likes);
      likes.delete(key);
    }
    const ro = recasts.get(key);
    if (ro && (c.viewerContext?.recast ?? false) === ro.recasted) {
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
  if (deleted) state.deleted.add(key);
  else state.deleted.delete(key);
  emit();
}
export function isDeleted(castHash: string): boolean {
  return state.deleted.has(lc(castHash));
}

// ---- pending casts ------------------------------------------------------
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
  savePending();
  emit();
}
