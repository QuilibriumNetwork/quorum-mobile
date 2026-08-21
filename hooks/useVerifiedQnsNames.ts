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
import { resolveClaimedNames } from '@/services/api/qnsClient';
import {
  claimedNameBelongsTo,
  QNS_BATCH_LIMIT,
  type QnsBatchResult,
} from '@quilibrium/quorum-shared';

/**
 * Re-exported so mobile's callers keep one import site while the CONSTANT has a
 * single definition shared with desktop.
 *
 * It is a MEASURED server property, not a preference: 101 names returns
 * `400 BATCH_SIZE_EXCEEDED` for the WHOLE request, so an oversized batch does
 * not lose the excess, it loses everything — every name on the screen. That is
 * why chunking is a correctness concern and not a tidiness one, and why two
 * clients disagreeing about the number would be a real bug rather than a style
 * difference.
 */
export { QNS_BATCH_LIMIT };

/** A row carrying an identity claim. Loose, because rows reach the UI from
 *  several queries and not all of them declare the field on their static type. */
export interface ClaimingRow {
  address: string;
  /**
   * The name the resolver reads and renders with a `.q`. Treated as a claim
   * wherever it arrives from, and removed unless it verifies.
   */
  primary_username?: string | null;
  /**
   * A claim delivered over the space/DM broadcast.
   *
   * Stored under a DIFFERENT key from `primary_username` on purpose, and this
   * is a security property rather than a naming preference. `resolveMemberName`
   * reads `primary_username`, and it is reached from surfaces that do not run
   * this verification — notification previews and conversation titles among
   * them. Writing a wire claim straight into that field would render it,
   * unverified, on every one of those paths.
   *
   * Under this key the untrusted value is inert: a surface that skips
   * verification sees no `.q` at all, which is a degradation. Only the promotion
   * below can move it into the field that renders, and only after it resolves
   * back to the claimant. Fail-closed by construction rather than by everyone
   * remembering.
   */
  claimed_primary_username?: string | null;
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
    const name = claimIn(row);
    if (name) seen.add(name);
    if (seen.size >= limit) break;
  }
  return Array.from(seen);
}

/**
 * The name a row is claiming, from either source.
 *
 * A claim reaches a row two ways: read out of a published public profile into
 * `primary_username`, or delivered over the broadcast into
 * `claimed_primary_username`. Neither is trusted, so both are read the same way
 * and both must survive the same check.
 *
 * ## The broadcast wins whenever it is PRESENT, including when it is empty
 *
 * An empty broadcast claim is an un-election, and it has to be able to clear a
 * name. Preferring the profile field would mean a user who drops their primary
 * name keeps rendering as it for everyone else — the un-election arrives and
 * changes nothing, which is the exact failure `NO_PRIMARY_NAME` exists to
 * prevent on the sending side. So presence is the test, not truthiness.
 *
 * An ABSENT broadcast field falls back to the profile, which keeps behaviour
 * unchanged for anyone whose claim only ever arrived that way.
 *
 * **Known simplification, worth a second opinion.** The equivalent merge for
 * global name/icon/bio picks whichever source is NEWER by timestamp rather than
 * ranking the routes. This does not, because the row reaching here has no
 * timestamps on it. The consequence is that a stale broadcast outranks a fresh
 * public profile, which can only ever under-show or mis-show a name the user
 * did once claim — it cannot promote a name they never claimed, because the
 * verification below is unconditional either way.
 *
 * **Exported so `IdentityScopeProvider` applies this exact rule** rather than
 * re-deriving it. The obvious re-derivation — `rosterClaim ?? profileClaim`, or
 * any truthiness test — compiles, reads correctly, and silently drops the
 * un-election case, because it cannot tell an empty claim from an absent one.
 * One copy of the rule, in the file whose docstring explains why it is shaped
 * this way.
 */
export function claimIn(row: Partial<ClaimingRow> | undefined): string {
  const broadcast = row?.claimed_primary_username;
  if (broadcast !== undefined && broadcast !== null) return broadcast.trim();
  return (row?.primary_username ?? '').trim();
}

/**
 * What the resolver answered, keyed by the name that was asked about.
 *
 * This is shared's `resolveNamesBatch` return type, used verbatim rather than
 * converted, so the shape the network produces is the shape these functions
 * consume. It replaced a `Map`, and the swap is what let mobile's own
 * chunk-and-re-zip loop be deleted — the alignment between a name and its
 * record is now made once, by the transport both clients share, instead of
 * again here.
 *
 * Three states collapse to two on purpose. A `null` (the resolver knows nothing
 * about the name) and a MISSING key (the name was never looked up, or the
 * lookup failed) are both UNVERIFIED, and every read below funnels through
 * `claimedNameBelongsTo`, which accepts `null` and `undefined` alike and
 * answers `false` to both.
 *
 * Note `strict` alone does not model that: without `noUncheckedIndexedAccess`,
 * tsc types `records[name]` as non-`undefined` even though a missing key is
 * `undefined` at runtime. That gap is harmless ONLY because the single consumer
 * tolerates `undefined`. Anything else added here must tolerate it too.
 */
export type ClaimRecords = Readonly<QnsBatchResult>;

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
  records: ClaimRecords,
  isExempt?: ClaimExemption,
): readonly T[] {
  let changed = false;
  const out = rows.map((row) => {
    const settled = settleClaim(row, records, isExempt);
    if (settled === row) return row;
    changed = true;
    return settled;
  });

  return changed ? out : rows;
}

/**
 * Decide what a single row's `primary_username` should be, and return the row
 * unchanged when it is already right.
 *
 * Two directions, one rule — a verified claim renders, nothing else does:
 *
 * - a claim in `primary_username` that does not verify is REMOVED
 * - a claim in `claimed_primary_username` that verifies is PROMOTED into
 *   `primary_username`, which is the only way a broadcast claim ever renders
 *
 * Returning the identical row when nothing changes is what keeps the memoised
 * member maps and the virtualised lists from churning.
 */
function settleClaim<T extends Partial<ClaimingRow>>(
  row: T,
  records: ClaimRecords,
  isExempt: ClaimExemption | undefined,
  addressOverride?: string,
): T {
  const claim = claimIn(row);
  const current = (row?.primary_username ?? '').trim();

  if (!claim) {
    // Nothing claimed. Only rewrite if a stale value is sitting in the render
    // field, which would otherwise keep showing after an un-election.
    return current ? ({ ...row, primary_username: undefined } as T) : row;
  }

  // A row with no address cannot be verified against anything, so its claim is
  // dropped. Fails closed: `claimedNameBelongsTo` rejects an empty address
  // rather than treating it as a wildcard match.
  const address = addressOverride || row?.address || '';
  const verified =
    isExempt?.(claim, address) || claimedNameBelongsTo(records[claim], address);

  if (!verified) return current ? ({ ...row, primary_username: undefined } as T) : row;
  return current === claim ? row : ({ ...row, primary_username: claim } as T);
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
  records: ClaimRecords,
  isExempt?: ClaimExemption,
): Record<string, T> {
  let changed = false;
  const out: Record<string, T> = {};

  for (const [key, row] of Object.entries(map)) {
    const settled = settleClaim(row, records, isExempt, row?.address || key);
    if (settled !== row) changed = true;
    out[key] = settled;
  }

  return changed ? out : (map as Record<string, T>);
}

/** Stable identity, so a screen with no claims does not churn every memo below
 *  it by handing them a fresh empty object on each render. Frozen because it is
 *  module-scoped and handed to every caller: one stray write would poison the
 *  "nothing verified" answer for the whole app. */
const NO_RECORDS: ClaimRecords = Object.freeze({});

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

export const DEV_CLAIM_EXEMPTION: ClaimExemption | undefined = FakeQnsModule
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
 *
 * Exported so `IdentityScopeProvider` consumes this exact query rather than
 * keeping its own copy. `staleTime` here is a SECURITY parameter, not a
 * performance one (see above) — two copies of that policy would drift, and
 * a shorter one in a duplicate would quietly widen the impersonation window
 * without either copy's history explaining why.
 */
export function useClaimRecords(names: string[]): ClaimRecords {
  // SORTED, so two surfaces holding the same claimants in a different insertion
  // order share one cache entry instead of issuing the same request twice.
  // `claimedNamesIn` builds the set in row order, and row order differs between
  // a member list and a message list showing the same people — without this they
  // are two keys for one answer. Only the KEY is sorted; the array handed to the
  // resolver keeps its original order, since chunk composition is irrelevant to
  // a result that comes back keyed by name.
  const namesKey = [...names].sort().join('|');

  const { data, status } = useQuery({
    queryKey: ['qns-verify-claims', namesKey],
    queryFn: () => resolveClaimedNames(names),
    enabled: names.length > 0,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    // A retry would extend the window in which claims render unverified. They
    // degrade to the global name meanwhile, which is correct but invisible, so
    // prefer settling quickly and refreshing on the next natural cache miss.
    //
    // Note the transport THROWS rather than reporting every name unresolved
    // (see `resolveClaimedNames`). That is what makes `retry: false` safe next
    // to a one-hour `staleTime`: a swallowed error would CACHE "nobody owns
    // anything" for that hour, whereas a rejection caches nothing and the next
    // mount refetches.
    retry: false,
    // Carry the previous answer while a wider set resolves, or every name on
    // screen flickers whenever a new one appears. Scrolling a channel grows the
    // sender set, which changes the key; without this the query returns
    // undefined for that render and EVERY already-verified `.q` reverts to the
    // global name for ~200ms before coming back.
    //
    // Safe in the fail-closed direction, which is why it is allowed here: the
    // carried map is keyed by name and holds the same records this key would
    // fetch, so no verdict changes. A name that is NEW in the wider set is
    // simply absent from it, and absent means unverified — the addition can
    // only ever under-show, never promote something unchecked.
    //
    // BUT only carry forward from a query that actually SUCCEEDED, which is what
    // `previousQuery` is checked for. The bare `(previous) => previous` form has
    // a hole that defeats the status gate below:
    //
    //   React Query picks the placeholder source by "last query that had
    //   defined data", and an ERRORED query still qualifies, because the error
    //   reducer never clears `data`. It then reports the carried value as
    //   `status: 'success'`. So after a failed refetch, one new sender is enough
    //   to resurrect the stale map through a brand-new query — past the gate,
    //   with nothing having re-verified anything.
    //
    // Scrolling a channel is exactly what grows the sender set, so this is the
    // routine path, not an edge case. With `retry: false` the errored query
    // never re-attempts, so the resurrected answer has no expiry at all.
    //
    // MEASURED 2026-08-17 on both clients: the name correctly dropped to
    // unverified after the failure, then came back on the widen.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.state.status === 'success' ? previous : undefined,
  });

  // `data` is not necessarily the shape this function is typed to return: it can
  // arrive from a persisted cache the type system never sees.
  //
  // This used to be `data instanceof Map`, guarding a crash. React Query's cache
  // is persisted to MMKV as JSON (`app/_layout.tsx`) and
  // `JSON.stringify(new Map([...]))` is `{}` — a plain object with no `.get` —
  // so a rehydrated entry made `settleClaim` throw `records.get is not a
  // function` on the first row carrying a claim, taking the channel screen down.
  //
  // Holding the records as a plain object RETIRES that crash class rather than
  // re-guarding it: the legacy on-disk value is `{}`, which is now simply an
  // empty, perfectly readable set of records meaning "nothing verified" — the
  // fail-closed answer, reached by construction instead of by a rescue.
  //
  // ## What this guard is still for: `status`
  //
  // React Query does not clear `data` when a query errors — its reducer spreads
  // the previous state and only flips `status`. So after a name set has resolved
  // once, a FAILED REFETCH leaves the last successful records in place and the
  // shape check alone would happily pass them through.
  //
  // That is the correct default for almost any query, and wrong for this one.
  // `staleTime` here is a SECURITY bound (see `useClaimRecords`' docstring): it
  // is how long a name transferred to somebody else can still verify for its
  // previous owner. Serving the last good records through a failure removes that
  // bound entirely — while refetches keep failing, the old owner keeps rendering
  // the name, with no upper limit and nothing logged.
  //
  // MEASURED 2026-08-17, both arms of the same probe: on a failed refetch the
  // records retained the one stale verifying entry without this check, against
  // zero entries on the implementation that resolved instead of rejecting.
  // Rejecting is still the right call — it is what stops a blip being cached for
  // an hour — but it made this path fail OPEN, and the two have to stay together.
  //
  // A placeholder-carried value still passes, since `placeholderData` reports
  // `success`. That is intended, but it is safe only because `placeholderData`
  // above refuses to carry anything forward from a query that ERRORED. Without
  // that guard, a widening sender set walks straight through this line with the
  // stale records. Read the two together; changing either alone reopens the hole.
  //
  // ## The shape check is kept, narrower
  //
  // Nothing in this file produces anything but a plain object now, so this only
  // catches a value that came from somewhere else — a hand-seeded cache, or a
  // legacy entry. Every rejected shape lands on `NO_RECORDS`, and every shape
  // that gets THROUGH is read with `records[name]`, which answers `undefined`
  // for a key it does not have. Both roads end at unverified, so an unreadable
  // cache can only ever cost a `.q`, never grant one.
  return status === 'success' && isClaimRecords(data) ? data : NO_RECORDS;
}

/**
 * A value that can be safely READ as claim records.
 *
 * Deliberately structural and permissive rather than a validation of every
 * entry. It is not trying to prove the records are trustworthy — the records
 * are never trusted; `claimedNameBelongsTo` re-derives the address from the key
 * on every single read, which is what actually decides a claim. All this needs
 * to establish is that indexing the value cannot throw.
 *
 * Arrays and `null` are excluded because neither can be a records object, and
 * letting them through would mean typing `data` as something it is not.
 *
 * ## The `Map` clause has NO observable effect, and is kept anyway
 *
 * MEASURED by deleting it and re-running the suite: nothing changed. A `Map`
 * that slipped past would be read with `records[name]`, which answers
 * `undefined` for every key a `Map` holds, so it already degrades to "nothing
 * verified" — the same outcome this clause produces, by a different route.
 *
 * It stays because this is a TYPE PREDICATE: without it, tsc would believe a
 * `Map` is a `QnsBatchResult`, and a later `Object.entries(records)` would
 * silently see an empty set with no warning. That is a real hazard, just not a
 * currently reachable one.
 *
 * Do not write a test asserting this clause does something — it cannot fail.
 * `claimRecordsSurviveRehydration.test.tsx` says as much where it feeds a
 * `Map` in.
 */
function isClaimRecords(data: unknown): data is QnsBatchResult {
  return (
    typeof data === 'object'
    && data !== null
    && !Array.isArray(data)
    && !(data instanceof Map)
  );
}

/**
 * Strip unverified `.q` claims from a set of rows before anything renders them.
 *
 * Pass the rows a surface is about to display — not a whole roster. Cost is
 * bounded by what is on screen, and handing this the full membership of a large
 * space would reintroduce the fetch storm both clients deliberately refused.
 */
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
