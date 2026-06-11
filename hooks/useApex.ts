/**
 * useApex — React hooks for the Quorum Apex subscription feature.
 *
 * Stage 1 (this file): data layer only — the stage-2 UI consumes these.
 *
 *  - useApexSubscription          current user's subscription + derived
 *                                 status (isActive, daysLeft, …), MMKV-
 *                                 persisted so the gold ring survives a
 *                                 cold start.
 *  - useApexStatusForFids         batched "is this author Apex-active?"
 *                                 lookup for the feed (gold pfp ring).
 *  - useApexStatusForAddresses    same, keyed by Quorum address (chat).
 *  - useSpaceApexConfig           a space's published Apex config.
 *  - useSetSpaceApexConfig        owner mutation to publish that config.
 *  - useApexEligibleSpaces        spaces a subscriber can pick for a
 *                                 given payment token.
 *
 * The /apex/* and /spaces/:addr/apex-config server endpoints are NEW
 * backend work (see services/api/quorumClient.ts); every read here
 * degrades gracefully (empty set / null) while they don't exist yet.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { useSpaces } from '@/hooks/chat/useSpaces';
import { getQuorumClient } from '@/services/api/quorumClient';
import {
  getCachedApexSubscription,
  setCachedApexSubscription,
  type ApexSubscriptionRecord,
} from '@/services/offline/apexCache';
import type { ApexToken } from '@/services/apex/config';
import { signSpaceApexConfig } from '@/services/apex/apexSpaceConfig';
import { getDebugApexSubscription } from '@/services/apex/apexDebug';

// ---------------------------------------------------------------------------
// Current user's subscription
// ---------------------------------------------------------------------------

export interface ApexSubscriptionState {
  /** The raw subscription record, or null if never subscribed / expired out. */
  subscription: ApexSubscriptionRecord | null;
  /** True while period_end is in the future. */
  isActive: boolean;
  /** Whole days until period_end, ceil'd, never negative. 0 when inactive. */
  daysLeft: number;
  /**
   * Whether the user may change their four chosen spaces. Spaces are
   * locked for the paid period — changes happen only via a new (renewal)
   * payment — so this is simply !isActive.
   */
  canChangeSpaces: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * The current user's Apex subscription with derived status. Persisted to
 * MMKV so a cold start renders the last-known status instantly.
 */
export function useApexSubscription(): ApexSubscriptionState {
  const { user } = useAuth();
  const address = user?.address;

  // Synchronous cold-start restore; memoized so MMKV is read once per
  // address, not on every render.
  const cached = useMemo(
    () => (address ? getCachedApexSubscription(address) : undefined),
    [address]
  );

  const query = useQuery({
    queryKey: ['apex', 'subscription', address],
    queryFn: async () => {
      // DEV-ONLY: a debug-activated subscription (simulator testing
      // without paying) takes precedence and never hits the server —
      // otherwise the server's 404 would wipe it on the next refetch.
      if (__DEV__) {
        const debug = getDebugApexSubscription();
        if (debug) return debug;
      }
      const subscription = await getQuorumClient().getApexSubscription(address!);
      setCachedApexSubscription(address!, subscription);
      return subscription;
    },
    enabled: !!address,
    staleTime: 5 * 60_000,
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.updatedAt,
  });

  const subscription = query.data ?? null;
  const now = Date.now();
  const isActive = !!subscription && subscription.period_end > now;
  const daysLeft = subscription
    ? Math.max(0, Math.ceil((subscription.period_end - now) / 86_400_000))
    : 0;

  return {
    subscription,
    isActive,
    daysLeft,
    canChangeSpaces: !isActive,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

// ---------------------------------------------------------------------------
// Batched Apex-active status (gold ring) — fids for the feed, addresses
// for chat. Module-level cache + debounce so N visible authors across N
// components collapse into one /apex/status round trip (modeled on the
// useFarcasterUsersPrefetch batching pattern).
// ---------------------------------------------------------------------------

/** How long a lookup result (positive or negative) is trusted. The server
 *  endpoint may not exist yet — failures cache a negative result for this
 *  long so we don't retry-spam on every render. */
const STATUS_TTL_MS = 10 * 60_000;
const STATUS_DEBOUNCE_MS = 200;

interface StatusBatcher<K extends string | number> {
  /** Queue any unchecked keys; flushes one batched request after a debounce. */
  request(keys: K[]): void;
  /** True if the key is known Apex-active. */
  isActive(key: K): boolean;
  /** Notify on batch completion; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

function createStatusBatcher<K extends string | number>(
  fetchActive: (keys: K[]) => Promise<K[]>
): StatusBatcher<K> {
  const active = new Set<K>();
  const checkedUntil = new Map<K, number>();
  const pending = new Set<K>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    timer = null;
    const batch = Array.from(pending);
    pending.clear();
    if (batch.length === 0) return;
    const expiry = Date.now() + STATUS_TTL_MS;
    try {
      const activeKeys = await fetchActive(batch);
      for (const key of batch) {
        checkedUntil.set(key, expiry);
        active.delete(key);
      }
      for (const key of activeKeys) active.add(key);
      listeners.forEach((listener) => listener());
    } catch {
      // Server endpoint may not exist yet (404) or we're offline — cache
      // the negative result for the TTL and stay silent.
      for (const key of batch) checkedUntil.set(key, expiry);
    }
  };

  return {
    request(keys: K[]) {
      const now = Date.now();
      let queued = false;
      for (const key of keys) {
        const until = checkedUntil.get(key);
        if (until !== undefined && until > now) continue;
        if (!pending.has(key)) {
          pending.add(key);
          queued = true;
        }
      }
      if (queued && timer === null) {
        timer = setTimeout(() => {
          void flush();
        }, STATUS_DEBOUNCE_MS);
      }
    },
    isActive: (key: K) => active.has(key),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const fidStatusBatcher = createStatusBatcher<number>(async (fids) => {
  const result = await getQuorumClient().getApexStatuses({ fids });
  return result.active_fids;
});

const addressStatusBatcher = createStatusBatcher<string>(async (addresses) => {
  const result = await getQuorumClient().getApexStatuses({ addresses });
  return result.active_addresses;
});

function useApexStatus<K extends string | number>(
  batcher: StatusBatcher<K>,
  keys: K[]
): Set<K> {
  const [, setVersion] = useState(0);

  // Stable signature: changes only when the *set* of keys changes, not on
  // every render with a fresh array identity.
  const signature = useKeysSignature(keys);

  useEffect(() => {
    const unsubscribe = batcher.subscribe(() => setVersion((v) => v + 1));
    batcher.request(keys);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, batcher]);

  const activeCount = keys.reduce((n, key) => (batcher.isActive(key) ? n + 1 : n), 0);
  return useMemo(() => {
    const out = new Set<K>();
    for (const key of keys) {
      if (batcher.isActive(key)) out.add(key);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, batcher, activeCount]);
}

function useKeysSignature(keys: (string | number)[]): string {
  const ref = useRef<string>('');
  const next = Array.from(new Set(keys)).sort().join(',');
  if (next !== ref.current) ref.current = next;
  return ref.current;
}

/**
 * Which of the given Farcaster fids are Apex-active (gold ring in the
 * feed). Batched + debounced across all callers; failures (including a
 * not-yet-deployed server endpoint) yield an empty set silently and are
 * cached for 10 minutes.
 */
export function useApexStatusForFids(fids: number[]): Set<number> {
  return useApexStatus(fidStatusBatcher, fids);
}

/**
 * Which of the given Quorum addresses are Apex-active (gold ring in
 * chat). Same batching/degradation semantics as useApexStatusForFids.
 */
export function useApexStatusForAddresses(addresses: string[]): Set<string> {
  return useApexStatus(addressStatusBatcher, addresses);
}

// ---------------------------------------------------------------------------
// Space Apex config (owner side)
// ---------------------------------------------------------------------------

export interface SpaceApexConfig {
  token: ApexToken;
  payout_address: string;
  /** Distinct active subscribers including this space in ≥1 slot. */
  subscriber_count?: number;
}

/** A space's published Apex config, or null if the owner hasn't set one. */
export function useSpaceApexConfig(spaceAddress: string | undefined) {
  return useQuery({
    queryKey: ['apex', 'space-config', spaceAddress],
    queryFn: () => getQuorumClient().getSpaceApexConfig(spaceAddress!),
    enabled: !!spaceAddress,
    staleTime: 5 * 60_000,
  });
}

/**
 * Publish (or update) a space's Apex config. On success the per-space
 * config query is updated in place so the owner UI reflects it
 * immediately.
 */
export function useSetSpaceApexConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      spaceAddress: string;
      token: ApexToken;
      payoutAddress: string;
    }) => {
      // Signing throws if this device doesn't hold the space owner key —
      // that's the real authorization, not just the owner-gated UI.
      const signed = await signSpaceApexConfig(
        params.spaceAddress,
        params.token,
        params.payoutAddress
      );
      return getQuorumClient().setSpaceApexConfig(params.spaceAddress, signed);
    },
    onSuccess: (_data, params) => {
      const next: SpaceApexConfig = {
        token: params.token,
        payout_address: params.payoutAddress,
      };
      queryClient.setQueryData(['apex', 'space-config', params.spaceAddress], next);
      // The subscribe modal's slot picker derives from this — without the
      // invalidation, a just-configured space stays missing from the
      // eligible list until the cache goes stale.
      queryClient.invalidateQueries({ queryKey: ['apex', 'eligible-spaces'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Eligible spaces (subscriber side)
// ---------------------------------------------------------------------------

export interface ApexEligibleSpace {
  spaceAddress: string;
  name: string;
  iconUrl?: string;
  /** ETH address that receives this space's 1/5 of the payment. */
  payoutAddress: string;
  /** Distinct active Apex subscribers supporting this space, if known. */
  subscriberCount?: number;
}

/** Cap on how many candidate spaces get their apex-config fetched. */
const ELIGIBLE_SPACES_FETCH_CAP = 30;

/**
 * Spaces a subscriber can choose for the given payment token: the user's
 * joined spaces plus directory entries, filtered to those whose published
 * Apex config accepts `token`. Configs are fetched in parallel
 * (Promise.allSettled, capped at 30 candidates); spaces without a config
 * or with a different token are dropped.
 */
export function useApexEligibleSpaces(token: ApexToken) {
  const { data: spaces } = useSpaces();

  // Candidate metadata from joined spaces, keyed by address. Memoized on a
  // signature so the query key stays referentially stable across renders.
  const joined = useMemo(
    () =>
      (spaces ?? []).map((space) => ({
        spaceAddress: space.spaceId,
        name: space.spaceName,
        iconUrl: space.iconUrl || undefined,
      })),
    [spaces]
  );
  const joinedSignature = joined.map((s) => s.spaceAddress).sort().join(',');

  return useQuery({
    queryKey: ['apex', 'eligible-spaces', token, joinedSignature],
    queryFn: async (): Promise<ApexEligibleSpace[]> => {
      const client = getQuorumClient();

      // Joined spaces first, then directory entries (deduped). Directory
      // failure is non-fatal — joined spaces alone still work.
      const candidates = new Map<string, { name: string; iconUrl?: string }>();
      for (const space of joined) {
        candidates.set(space.spaceAddress, { name: space.name, iconUrl: space.iconUrl });
      }
      try {
        const directory = await client.exploreSpaces({ limit: ELIGIBLE_SPACES_FETCH_CAP });
        for (const entry of directory.entries) {
          if (!candidates.has(entry.space_address)) {
            candidates.set(entry.space_address, {
              name: entry.name,
              iconUrl: entry.icon || undefined,
            });
          }
        }
      } catch {
        // directory unavailable — proceed with joined spaces only
      }

      const limited = Array.from(candidates.entries()).slice(0, ELIGIBLE_SPACES_FETCH_CAP);
      const settled = await Promise.allSettled(
        limited.map(async ([spaceAddress, meta]): Promise<ApexEligibleSpace | null> => {
          const config = await client.getSpaceApexConfig(spaceAddress);
          if (!config || config.token !== token) return null;
          return {
            spaceAddress,
            name: meta.name,
            iconUrl: meta.iconUrl,
            payoutAddress: config.payout_address,
            subscriberCount: config.subscriber_count,
          };
        })
      );

      const eligible: ApexEligibleSpace[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) eligible.push(result.value);
      }
      return eligible;
    },
    staleTime: 60_000,
  });
}
