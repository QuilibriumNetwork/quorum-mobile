/**
 * Which React Query entries are allowed onto disk.
 *
 * Lives in its own module, apart from the provider that uses it, for one
 * reason: it is a SECURITY rule and it needs a test. Inline in `app/_layout.tsx`
 * it was reachable only by mounting the entire provider stack, so it had none —
 * and the rule below is exactly the kind that can be deleted in good faith by
 * someone who reads it as an optimisation.
 */
import { defaultShouldDehydrateQuery, type Query } from '@tanstack/react-query';

/**
 * The claim-verification query key. Must match the key `useClaimRecords`
 * builds; they are two halves of one rule living in two files.
 */
export const QNS_VERIFY_CLAIMS_KEY = 'qns-verify-claims';

/**
 * QNS claim verification is NEVER persisted.
 *
 * ## This is the only thing stopping it, and that is new
 *
 * That query's `staleTime` is a documented SECURITY parameter — the window in
 * which a name transferred away keeps verifying under its previous owner. It is
 * one hour. The persister's `maxAge` is 24 hours, so persisting these answers
 * would silently widen that window to a day, ACROSS RESTARTS: relaunch the app
 * and the previous owner's `.q` renders again from disk, with nothing having
 * re-verified it.
 *
 * Until 2026-08-21 there was a second, accidental guard. The query's data was a
 * `Map`, and `JSON.stringify(new Map([...]))` is `{}`, so the records could not
 * survive the trip even if this rule were removed. (That same property was also
 * a bug: the `{}` rehydrated with no `.get` and crashed the channel screen.)
 *
 * The records are now the plain object `resolveNamesBatch` returns, which
 * serialises and rehydrates PERFECTLY. That fixed the crash, and in doing so it
 * removed the accident that was quietly backing this rule up. Deleting this
 * line no longer produces a crash or an empty object — it produces a working,
 * silent, 24-hour impersonation window. Hence the test.
 *
 * Re-verifying on launch costs one batched request.
 */
export function shouldPersistQuery(query: Query): boolean {
  return query.queryKey[0] !== QNS_VERIFY_CLAIMS_KEY && defaultShouldDehydrateQuery(query);
}
