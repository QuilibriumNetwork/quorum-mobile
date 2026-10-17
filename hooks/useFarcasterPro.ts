/**
 * Hook to detect Farcaster Pro status and get cast limits.
 *
 * The limits are the ones Hypersnap validates casts against
 * (`castTypeForText` picks the matching cast type at publish time):
 *   - up to 320 bytes: a regular cast, shown in full on the timeline
 *   - up to 1024 bytes: a long cast, open to everyone
 *   - up to 10,000 bytes: Farcaster Pro only
 *
 * Pro status is read from the account's on-chain tier purchases on Hypersnap
 * (`isProUser`), computed the same way the hub does.
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { isProUser } from '@/services/farcaster/hypersnapUsers';
import {
  CAST_BYTE_LIMIT,
  LONG_CAST_BYTE_LIMIT,
  TEN_K_CAST_BYTE_LIMIT,
} from '@/services/farcaster/hypersnapWrites';

export interface FarcasterCastLimits {
  /** Regular cast byte limit (shown on timeline) */
  regularCastByteLimit: number;
  /** Long cast byte limit (the most this account can post) */
  longCastByteLimit: number;
  /** Whether the user has Farcaster Pro */
  isPro: boolean;
  /** Whether we're still loading the data */
  isLoading: boolean;
}

/**
 * Hook to fetch the user's Farcaster cast limits and Pro status
 */
export function useFarcasterCastLimits(): FarcasterCastLimits {
  const fid = useAuth().user?.farcaster?.fid;

  const { data: isPro, isLoading } = useQuery({
    queryKey: ['farcaster-pro', fid],
    queryFn: () => isProUser(fid as number),
    enabled: !!fid,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
  });

  return {
    regularCastByteLimit: CAST_BYTE_LIMIT,
    longCastByteLimit: isPro ? TEN_K_CAST_BYTE_LIMIT : LONG_CAST_BYTE_LIMIT,
    isPro: !!isPro,
    isLoading,
  };
}

/**
 * Get the appropriate max cast length based on Pro status
 */
export function getMaxCastLength(isPro: boolean, longCastByteLimit: number): number {
  return isPro ? longCastByteLimit : LONG_CAST_BYTE_LIMIT;
}

/**
 * Check if a cast exceeds the regular limit but is within long cast limit
 * (Used to show the "only first N characters visible on timeline" warning)
 */
export function isLongCast(
  textLength: number,
  regularLimit: number,
  longLimit: number
): boolean {
  return textLength > regularLimit && textLength <= longLimit;
}
