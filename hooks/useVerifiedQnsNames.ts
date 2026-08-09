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
 */
export function claimedNamesIn(rows: readonly ClaimingRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const name = (row?.primary_username ?? '').trim();
    if (name) seen.add(name);
  }
  return Array.from(seen);
}

/** The batch call, injectable so the chunking is testable without a network. */
export type ResolveBatchFn = (names: string[]) => Promise<(NameRecord | null)[]>;

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
export function stripUnverifiedNames<T extends ClaimingRow>(
  rows: readonly T[],
  records: ReadonlyMap<string, NameRecord | null>,
): readonly T[] {
  let changed = false;
  const out = rows.map((row) => {
    const name = (row?.primary_username ?? '').trim();
    if (!name) return row;

    if (claimedNameBelongsTo(records.get(name), row.address)) return row;

    changed = true;
    return { ...row, primary_username: undefined };
  });

  return changed ? out : rows;
}

/**
 * Strip unverified `.q` claims from a set of rows before anything renders them.
 *
 * Pass the rows a surface is about to display — not a whole roster. Cost is
 * bounded by what is on screen, and handing this the full membership of a large
 * space would reintroduce the fetch storm both clients deliberately refused.
 */
export function useVerifiedQnsNames<T extends ClaimingRow>(rows: readonly T[]): readonly T[] {
  const names = useMemo(() => claimedNamesIn(rows), [rows]);

  // Keyed on the name SET, so two surfaces showing the same claimants share one
  // entry. A growing set (scrolling loads more senders) does re-resolve the
  // whole set rather than only the new names — accepted deliberately, because
  // the measurement above says a bigger batch is not a more expensive one. If
  // this ever shows up as a real cost, seed per-name entries instead of
  // shrinking the TTL.
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

  return useMemo(() => stripUnverifiedNames(rows, data ?? new Map()), [rows, data]);
}
