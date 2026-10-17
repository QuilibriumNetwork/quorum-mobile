/**
 * Look a cast up by its full hash on Hypersnap, without knowing its author.
 *
 * quorum-shared's `useFarcasterCast` needs the author FID; a cast link only
 * carries a username and a hash. With the full hash Hypersnap can answer on its
 * own. Only a short hash prefix still needs farcaster.xyz's cast-by-URL lookup
 * (FARCASTER_TECH_DEBT.md).
 */

import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_HYPERSNAP_BASE_URL,
  fromHypersnapCast,
  type HypersnapCast,
  type NormalizedCast,
} from '@quilibrium/quorum-shared';
import { isFullCastHash, rememberCastAuthor } from './hypersnapWrites';

/** The cast with this full hash, or null if Hypersnap does not have it. */
export async function fetchCastByFullHash(hash: string): Promise<NormalizedCast | null> {
  if (!isFullCastHash(hash)) return null;
  const key = hash.toLowerCase().replace(/^0x/, '');
  const res = await fetch(
    `${DEFAULT_HYPERSNAP_BASE_URL}/v2/farcaster/cast?identifier=${key}&type=hash`,
    { headers: { accept: 'application/json' } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Hypersnap ${res.status} looking up cast ${key}`);
  const json = (await res.json()) as { cast?: HypersnapCast };
  if (!json.cast) return null;
  const cast = fromHypersnapCast(json.cast);
  rememberCastAuthor(cast.hash, cast.author.fid);
  return cast;
}

export function useCastByFullHash(hash: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['farcaster', 'cast-by-hash', hash?.toLowerCase().replace(/^0x/, '')] as const,
    queryFn: () => fetchCastByFullHash(hash as string),
    enabled: (options.enabled ?? true) && isFullCastHash(hash),
    staleTime: Infinity,
  });
}
