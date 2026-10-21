/**
 * Which React Query entries are allowed onto disk.
 *
 * Lives in its own module, apart from the provider that uses it, for one
 * reason: it is a SECURITY rule and it needs a test. Inline in `app/_layout.tsx`
 * it was reachable only by mounting the entire provider stack, so it had none —
 * and the rule below is exactly the kind that can be deleted in good faith by
 * someone who reads it as an optimisation.
 */
import {
  defaultShouldDehydrateMutation,
  defaultShouldDehydrateQuery,
  type Mutation,
  type Query,
} from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';

/**
 * The only query families written to disk. Everything else either keeps its
 * own on-device copy (messages in SQLCipher; conversations, spaces, rosters
 * and members in MMKV; the Farcaster feed, threads, profiles, users and DMs in
 * their own caches; wallet balances; block, mute and follow lists) or is
 * refetched after launch.
 *
 * An allow-list, not a deny-list: a query added later stays off disk until
 * someone decides it belongs here. The deny-list it replaced persisted
 * everything, including decrypted message pages copied out of the encrypted
 * messages database into this unencrypted file.
 *
 * - `hypersnap-notifications`: no other copy; the badge and list paint at
 *   launch from it. Its first page only (see `queryPersister.ts`).
 * - `user-public-profile`: names and avatars for members with no local
 *   profile; no other copy.
 */
export const PERSISTED_QUERY_ROOTS: ReadonlySet<string> = new Set([
  'hypersnap-notifications',
  'user-public-profile',
]);

function isPersistedRoot(queryKey: readonly unknown[]): boolean {
  return typeof queryKey[0] === 'string' && PERSISTED_QUERY_ROOTS.has(queryKey[0]);
}

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
  return (
    isPersistedRoot(query.queryKey) &&
    query.queryKey[0] !== QNS_VERIFY_CLAIMS_KEY &&
    !isSecretQueryKey(query.queryKey) &&
    !isNeverPersistMeta(query.meta) &&
    defaultShouldDehydrateQuery(query)
  );
}

// ---------------------------------------------------------------------------
// Key material never reaches disk.
//
// The persisted cache is a plain, unencrypted MMKV file. Private keys and
// mnemonics belong in SecureStore and are read there at the moment of signing
// (`services/wallet/walletKeyCache.ts`, `getWarpcastWalletPrivateKey()`), so no
// query or mutation should ever hold them. These rules hold the line regardless.
// They apply three ways: when a query is written, when a paused mutation is
// written, and when a cache is read back from disk (`stripNeverPersisted`), so
// they hold for any cache on disk, whatever wrote it.
// ---------------------------------------------------------------------------

/**
 * Query-key prefixes that are never persisted, whatever their data.
 *
 * - `['wallet', 'keys']`: reserved for wallet key material, which is never a
 *   query (see `services/wallet/walletKeyCache.ts`). Refused so that a query
 *   created under it can never be written.
 * - `['warpcastWallet']`: the imported Warpcast wallet. Its queries hold only
 *   public data. The whole family is refused because it sits next to the key.
 */
export const SECRET_QUERY_KEY_PREFIXES: readonly (readonly string[])[] = [
  ['wallet', 'keys'],
  ['warpcastWallet'],
];

export function isSecretQueryKey(queryKey: readonly unknown[]): boolean {
  return SECRET_QUERY_KEY_PREFIXES.some((prefix) =>
    prefix.every((part, i) => queryKey[i] === part),
  );
}

/** Any query or mutation can opt out with `meta: { neverPersist: true }`. */
function isNeverPersistMeta(meta: Record<string, unknown> | undefined): boolean {
  return meta?.neverPersist === true;
}

/** Field names that mark a mutation's variables as carrying key material. */
const KEY_MATERIAL_FIELDS = ['privateKey', 'mnemonic'] as const;

/** True when a mutation's variables carry a key, whoever forgot to mark it. */
export function carriesKeyMaterial(variables: unknown): boolean {
  if (typeof variables !== 'object' || variables === null) return false;
  return KEY_MATERIAL_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(variables, field));
}

/**
 * Which mutations are allowed onto disk: none.
 *
 * React Query persists PAUSED mutations (an offline queue), and their
 * variables go with them. A restored one can't run: this app registers no
 * `setMutationDefaults`, so it comes back with no `mutationFn` and fails with
 * "No mutationFn found" when resumed. Writing them only put their variables
 * on disk. The key-material and opt-out checks stay, so the rule still holds
 * if someone makes them resumable and returns this to the default.
 */
export function shouldPersistMutation(mutation: Mutation): boolean {
  return (
    PERSIST_PAUSED_MUTATIONS &&
    !isNeverPersistMeta(mutation.meta) &&
    !carriesKeyMaterial(mutation.state.variables) &&
    defaultShouldDehydrateMutation(mutation)
  );
}

/** Off until paused mutations can resume after a restart (see above). */
const PERSIST_PAUSED_MUTATIONS = false;

/**
 * Apply the same rules to a cache read back from disk, before it is hydrated:
 * only allow-listed, non-secret queries, and no mutations. React Query
 * hydrates whatever the blob holds, whatever the write rules say, so this is
 * what stops a cache written under other rules coming back. Returns the
 * cleaned client and how many entries were dropped, so the caller can rewrite
 * the file when anything was.
 */
export function stripNeverPersisted(client: PersistedClient): { client: PersistedClient; removed: number } {
  const { queries, mutations } = client.clientState;
  const keptQueries = queries.filter(
    (q) =>
      isPersistedRoot(q.queryKey) &&
      q.queryKey[0] !== QNS_VERIFY_CLAIMS_KEY &&
      !isSecretQueryKey(q.queryKey) &&
      !isNeverPersistMeta(q.meta),
  );
  const keptMutations = mutations.filter(
    (m) =>
      PERSIST_PAUSED_MUTATIONS && !isNeverPersistMeta(m.meta) && !carriesKeyMaterial(m.state.variables),
  );
  const removed = queries.length - keptQueries.length + (mutations.length - keptMutations.length);
  if (removed === 0) return { client, removed };
  return {
    client: { ...client, clientState: { ...client.clientState, queries: keptQueries, mutations: keptMutations } },
    removed,
  };
}
