/**
 * useVerifiedQnsNames — drop a claimed `.q` unless it really belongs to the
 * account claiming it.
 *
 * ## Where this sits, and why it is not in the resolver
 *
 * ```
 * public profile / broadcast   carries primary_username — a CLAIM, not a fact
 *          ▼
 * useVerifiedQnsNames(rows)    ← the only place here that touches the network
 *          ▼                     strips the claim unless it resolves to the row
 * resolveMemberName()          ← unchanged, still pure and synchronous
 *          ▼
 * every display surface        ← unchanged, all of them
 * ```
 *
 * Verification deliberately happens UPSTREAM of the resolver, by editing the
 * data rather than teaching the resolver about the network. Two things fall out
 * of that for free:
 *
 * - Every surface inherits the check without any of them changing, which is the
 *   entire reason the codebase has one resolver.
 * - An unverified or still-in-flight claim simply is not in the row, so the
 *   resolver renders the global name without knowing verification exists. There
 *   is no "render optimistically" branch anywhere, because there is nothing to
 *   render optimistically FROM.
 *
 * ## Fail closed, on the name only
 *
 * A failed check changes which name renders. It never drops, hides, delays or
 * flags a message. Anything else would be a censorship weapon: forge a profile
 * update as somebody, fail its verification, and watch their messages vanish
 * from every client. Delivery and display stay separate concerns — a message
 * has already passed signature and decryption long before any of this runs.
 *
 * ## Cost
 *
 * Measured against production, 2026-08-09: a 100-name batch resolves in ~190ms
 * and a 1-name batch in ~167ms. **A screenful costs the same as a single name**,
 * which is what makes this affordable rather than merely defensible. Cost scales
 * with distinct claimed NAMES on screen, not with members and not with messages:
 * two accounts claiming `alice` share one lookup and are both compared against
 * its single answer.
 *
 * Members claiming nothing cost nothing, and an empty set never reaches the
 * network — the API answers an empty array with a 400, so a naive call would be
 * an error on every render of the common case rather than a quiet no-op.
 *
 * `staleTime` is a SECURITY parameter here, not a performance one: a name
 * transferred away keeps verifying until the entry expires, and that window is
 * how long its previous owner can still render as it. One hour, matching the
 * public-profile cache so a member's identity does not half-refresh. Do not
 * raise it for performance — the batch is what buys headroom, not the TTL.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { resolveBatch, type NameRecord } from '@/services/api/qnsClient';
import { claimedNameBelongsTo } from '@/utils/verifyQnsClaim';
import { logger } from '@quilibrium/quorum-shared';

/**
 * Most names the resolver accepts in one request.
 *
 * MEASURED, not assumed: 101 names returns `400 BATCH_SIZE_EXCEEDED` for the
 * WHOLE request. So an oversized batch does not lose the excess, it loses
 * everything — every name on the screen — which is why chunking is a
 * correctness concern and not a tidiness one.
 */
export const QNS_BATCH_LIMIT = 100;

/** A row carrying an identity claim. Loose, because rows reach the UI from
 *  several queries and not all of them declare the field on their static type. */
export interface ClaimingRow {
  address: string;
  primary_username?: string | null;
}

/**
 * The distinct names actually being claimed on this screen.
 *
 * Distinct is doing real work in both directions. It is the cost property — one
 * lookup however many members claim the same name — and it is a security
 * property, because both claimants are then judged against the same single
 * answer, so a collision is settled by the very request that verifies whoever
 * genuinely owns it.
 *
 * Whitespace is trimmed so a padded claim cannot dodge the dedupe. Case is NOT
 * folded: the resolver is the authority on what a name matches, and quietly
 * normalising a claim here would mean verifying a name the user never claimed.
 *
 * ## The limit makes "one request per screen" structural
 *
 * Capped at a single batch by default, so no surface can fan out into dozens of
 * requests however many distinct names are on it. Today the claim set is
 * naturally small — a claim only exists where a public profile was already
 * fetched — but once the broadcast carries `primary_username` on every roster
 * row, a 5,000-member space would otherwise mean 50 requests to open Settings.
 * That is the fetch storm both clients already refused once, arriving by a new
 * route.
 *
 * **The overflow degrades safely and in the existing direction**: a name past
 * the cap is simply never verified, so it is stripped and the member renders
 * under their global name — exactly what a member with no cached profile does
 * today. Under-showing a real `.q` is invisible and self-correcting; the cap
 * cannot cause a forged one to render.
 */
export function claimedNamesIn(
  rows: Iterable<Partial<ClaimingRow>>,
  limit: number = QNS_BATCH_LIMIT,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const name = (row?.primary_username ?? '').trim();
    if (name) seen.add(name);
    if (seen.size >= limit) break;
  }
  return Array.from(seen);
}

/** The batch call, injectable so the chunking is testable without a network. */
export type ResolveBatchFn = (names: string[]) => Promise<(NameRecord | null)[]>;

/**
 * An escape hatch for claims that cannot be verified against the real resolver
 * because nothing real is behind them.
 *
 * Exists for exactly one caller: the dev-build fake-QNS overlay, whose
 * synthesized names are registered nowhere and so can never pass the genuine
 * check. Without it the instrument would inject names, verification would strip
 * all of them, and every QNS surface would render exactly as it did before the
 * instrument existed — the panel looking broken while reporting success.
 *
 * Injected rather than imported so these functions stay pure and the exemption
 * is visible at the call site. **There is no production implementation, and
 * adding one would be a way to render an unverified `.q`** — which is the whole
 * thing this file exists to prevent.
 */
export type ClaimExemption = (name: string, address: string) => boolean;

/**
 * Resolve every claimed name, in as few requests as the API allows.
 *
 * Returns a map rather than an array so callers cannot accidentally rely on
 * positional alignment. Alignment IS relied on inside this function, when
 * zipping a chunk back onto its names — get that wrong and one member's claim
 * is judged against another member's record, which is precisely the confusion
 * this whole feature exists to prevent.
 *
 * A resolver failure yields an empty map rather than throwing. Fail closed on
 * the NAME: an outage must cost people their suffix, never take down the
 * surface that was rendering them.
 */
export async function resolveClaimedNames(
  names: readonly string[],
  batch: ResolveBatchFn,
): Promise<Map<string, NameRecord | null>> {
  const out = new Map<string, NameRecord | null>();
  if (!names.length) return out;

  try {
    for (let i = 0; i < names.length; i += QNS_BATCH_LIMIT) {
      const chunk = names.slice(i, i + QNS_BATCH_LIMIT);
      const records = await batch(chunk);
      chunk.forEach((name, j) => out.set(name, records?.[j] ?? null));
    }
  } catch (e) {
    logger.warn('[qns] claim verification lookup failed; names degrade to global', e);
    return new Map();
  }

  return out;
}

/**
 * Remove every claim that has not been proven, leaving the rows otherwise
 * untouched.
 *
 * **Unproven includes not-yet-known.** A lookup still in flight strips the
 * claim exactly as a failed one does. That is the difference between this being
 * a defence and being decoration: a `.q` shown for even the instant before a
 * lookup lands is the whole attack, because a screenshot of that instant does
 * not expire.
 *
 * Returns the SAME array when nothing needed stripping — the common case, since
 * most members claim nothing. These rows feed memoised member maps and a
 * virtualised list, so a fresh array on every render would re-render every row
 * on every tick, on the exact surface this feature most risks making expensive.
 */
export function stripUnverifiedNames<T extends Partial<ClaimingRow>>(
  rows: readonly T[],
  records: ReadonlyMap<string, NameRecord | null>,
  isExempt?: ClaimExemption,
): readonly T[] {
  let changed = false;
  const out = rows.map((row) => {
    const name = (row?.primary_username ?? '').trim();
    if (!name) return row;

    // A row with no address cannot be verified against anything, so its claim
    // is stripped. Fails closed: `claimedNameBelongsTo` rejects an empty
    // address rather than treating it as a wildcard match.
    const address = row?.address ?? '';
    if (isExempt?.(name, address)) return row;
    if (claimedNameBelongsTo(records.get(name), address)) return row;

    changed = true;
    return { ...row, primary_username: undefined };
  });

  return changed ? out : rows;
}

/**
 * The keyed-record form of {@link stripUnverifiedNames}.
 *
 * The chat surfaces carry members as `Record<address, member>` rather than an
 * array, and that one map feeds messages, mentions, reactions and the call
 * screens — so this shape covers the most ground of the two.
 *
 * The row's own `address` is preferred, falling back to the MAP KEY when the
 * row does not carry one. Rows reach these maps from several queries and do not
 * all duplicate the address inside the row; verifying against `undefined` would
 * strip every claim on the surface, which looks exactly like the feature not
 * being built rather than like a bug.
 */
export function stripUnverifiedNamesInMap<T extends Partial<ClaimingRow>>(
  map: Readonly<Record<string, T>>,
  records: ReadonlyMap<string, NameRecord | null>,
  isExempt?: ClaimExemption,
): Record<string, T> {
  let changed = false;
  const out: Record<string, T> = {};

  for (const [key, row] of Object.entries(map)) {
    const name = (row?.primary_username ?? '').trim();
    const address = row?.address || key;
    if (
      !name ||
      isExempt?.(name, address) ||
      claimedNameBelongsTo(records.get(name), address)
    ) {
      out[key] = row;
      continue;
    }
    changed = true;
    out[key] = { ...row, primary_username: undefined };
  }

  return changed ? out : (map as Record<string, T>);
}

/**
 * Strip unverified `.q` claims from a set of rows before anything renders them.
 *
 * Pass the rows a surface is about to display — not a whole roster. Cost is
 * bounded by what is on screen, and handing this the full membership of a large
 * space would reintroduce the fetch storm both clients deliberately refused.
 */
/** Stable identity, so a screen with no claims does not churn every memo below
 *  it by handing them a fresh empty map on each render. */
const NO_RECORDS: ReadonlyMap<string, NameRecord | null> = new Map();

/**
 * The dev-only exemption for names the fake-QNS overlay synthesized.
 *
 * Gated at the `require()` itself rather than only at the call site, so neither
 * the overlay nor its storage reaches a release bundle — the same shape as the
 * gate in `quorumClient`. In production this is `undefined`, and the strip
 * functions take the genuine path with no exemption to consult.
 *
 * Held at module scope because the identity must be STABLE: a fresh closure per
 * render would invalidate the memos below on every tick, on the surface whose
 * entire cost argument is that it does not re-render per tick.
 */
const FakeQnsModule = __DEV__
  ? (require('@/services/dev/fakeQns') as typeof import('@/services/dev/fakeQns'))
  : null;

const DEV_CLAIM_EXEMPTION: ClaimExemption | undefined = FakeQnsModule
  ? (name, address) => FakeQnsModule.isFakeClaimFor(name, address)
  : undefined;

/**
 * Resolve a set of claimed names, shared by both public hooks.
 *
 * Keyed on the name SET, so two surfaces showing the same claimants share one
 * entry. A growing set — scrolling loads more senders — re-resolves the whole
 * set rather than only the new names. That is deliberate: the measurement says
 * a bigger batch is not a more expensive one, so one request for everything
 * beats bookkeeping to save part of it. If it ever does show up as a real cost,
 * seed per-name cache entries; do not shrink the TTL, which is a security
 * parameter.
 */
function useClaimRecords(names: string[]): ReadonlyMap<string, NameRecord | null> {
  const namesKey = names.join('|');

  const { data } = useQuery({
    queryKey: ['qns-verify-claims', namesKey],
    queryFn: () => resolveClaimedNames(names, resolveBatch),
    enabled: names.length > 0,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    // A retry would extend the window in which claims render unverified. They
    // degrade to the global name meanwhile, which is correct but invisible, so
    // prefer settling quickly and refreshing on the next natural cache miss.
    retry: false,
  });

  return data ?? NO_RECORDS;
}

export function useVerifiedQnsNames<T extends Partial<ClaimingRow>>(
  rows: readonly T[],
): readonly T[] {
  const names = useMemo(() => claimedNamesIn(rows), [rows]);
  const records = useClaimRecords(names);
  return useMemo(
    () => stripUnverifiedNames(rows, records, DEV_CLAIM_EXEMPTION),
    [rows, records],
  );
}

/**
 * Keyed-record form of {@link useVerifiedQnsNames}, for the chat member maps.
 */
export function useVerifiedQnsNamesInMap<T extends Partial<ClaimingRow>>(
  map: Readonly<Record<string, T>>,
): Record<string, T> {
  const names = useMemo(() => claimedNamesIn(Object.values(map)), [map]);
  const records = useClaimRecords(names);
  return useMemo(
    () => stripUnverifiedNamesInMap(map, records, DEV_CLAIM_EXEMPTION),
    [map, records],
  );
}
