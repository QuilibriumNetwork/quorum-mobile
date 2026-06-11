/**
 * React Query hooks for QNS (Quilibrium Name Service) API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys, queryConfig } from '@/services/api/queryConfig';
import {
  getQNSClient,
  type NameRecord,
  type AvailabilityResult,
  type PricingInfo,
  type Registration,
  type InviteCodeValidation,
  type VerificationStatus,
  type ReservedNameCheck,
  type Ownership,
} from '@/services/api/qnsClient';

// Health Check Hook

/**
 * Check if the QNS service is healthy/available
 * Returns isHealthy: true if service is up, false if down or errored
 */
export function useQNSHealth(options?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: ['qns', 'health'],
    queryFn: () => getQNSClient().checkHealth(),
    enabled: options?.enabled !== false,
    staleTime: 30 * 1000, // 30 seconds
    gcTime: queryConfig.gcTime,
    retry: 1, // Only retry once
    retryDelay: 1000,
  });

  return {
    ...query,
    isHealthy: query.isSuccess && query.data?.status === 'healthy',
    isServiceDown: query.isError || (query.isSuccess && query.data?.status !== 'healthy'),
  };
}

// Resolution Hooks

/**
 * Resolve a single name to its record
 */
export function useResolveName(name: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.resolve(name ?? ''),
    queryFn: () => getQNSClient().resolveName(name!),
    enabled: !!name && options?.enabled !== false,
    staleTime: queryConfig.staleTime.profile,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Resolve multiple names at once
 */
export function useResolveBatch(names: string[], options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.resolveBatch(names),
    queryFn: () => getQNSClient().resolveBatch(names),
    enabled: names.length > 0 && options?.enabled !== false,
    staleTime: queryConfig.staleTime.profile,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Reverse lookup - find names by authority key or address
 */
export function useReverseLookup(keyOrAddress: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.reverse(keyOrAddress ?? ''),
    queryFn: () => getQNSClient().reverseLookup(keyOrAddress!),
    enabled: !!keyOrAddress && options?.enabled !== false,
    staleTime: queryConfig.staleTime.profile,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Bucket lookup - get all stealth ownership records in a bucket
 * Used for privacy-preserving lookup of Quilibrium names
 * Client should decrypt locally to find owned names
 */
export function useBucketLookup(bucketTag: number | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.bucket(bucketTag ?? 0),
    queryFn: () => getQNSClient().bucketLookup(bucketTag!),
    enabled: bucketTag !== undefined && options?.enabled !== false,
    staleTime: queryConfig.staleTime.profile,
    gcTime: queryConfig.gcTime,
  });
}

// Availability Hook

/**
 * Check if a name is available for registration
 */
export function useCheckNameAvailability(
  name: string | undefined,
  nameType: 'username' | 'domain',
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.qns.availability(name ?? '', nameType),
    queryFn: () => getQNSClient().checkNameAvailability(name!, nameType),
    enabled: !!name && name.length >= 1 && options?.enabled !== false,
    staleTime: 30 * 1000, // 30 seconds - availability can change
    gcTime: queryConfig.gcTime,
  });
}

// Pricing Hooks

/**
 * Get pricing information
 */
export function usePricing(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.pricing(),
    queryFn: () => getQNSClient().getPricing(),
    enabled: options?.enabled !== false,
    staleTime: 5 * 60 * 1000, // 5 minutes - prices don't change often
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Calculate price for a name in a specific token
 */
export function useCalculatePrice(
  name: string | undefined,
  nameType: 'username' | 'domain',
  token: 'wQUIL' | 'USDC',
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.qns.calculatePrice(name ?? '', nameType, token),
    queryFn: () => getQNSClient().calculatePrice(name!, nameType, token),
    enabled: !!name && name.length >= 1 && options?.enabled !== false,
    staleTime: 60 * 1000, // 1 minute - prices can fluctuate
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get the signature message that must be signed to derive a payment address
 */
export function useSignatureMessage(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['qns', 'signatureMessage'],
    queryFn: () => getQNSClient().getSignatureMessage(),
    enabled: options?.enabled !== false,
    staleTime: Infinity, // Message doesn't change
    gcTime: queryConfig.gcTime,
  });
}

// Registration Hooks

/**
 * Get registration by ID
 */
export function useRegistration(id: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.registration(id ?? ''),
    queryFn: () => getQNSClient().getRegistration(id!),
    enabled: !!id && options?.enabled !== false,
    staleTime: 10 * 1000, // 10 seconds - registration state changes
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get all registrations for a wallet
 */
export function useRegistrationsByWallet(
  walletAddress: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.qns.registrationsByWallet(walletAddress ?? ''),
    queryFn: () => getQNSClient().getRegistrationsByWallet(walletAddress!),
    enabled: !!walletAddress && options?.enabled !== false,
    staleTime: 30 * 1000, // 30 seconds
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get verification status for a registration (polls for confirmation)
 */
export function useVerificationStatus(
  registrationId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.qns.verificationStatus(registrationId ?? ''),
    queryFn: () => getQNSClient().getVerificationStatus(registrationId!),
    enabled: !!registrationId && options?.enabled !== false,
    staleTime: 5 * 1000, // 5 seconds
    gcTime: queryConfig.gcTime,
    refetchInterval: options?.refetchInterval ?? 5000, // Poll every 5 seconds by default
  });
}

// Invite Code Hooks

/**
 * Validate an invite code
 */
export function useValidateInviteCode(code: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.inviteCode(code ?? ''),
    queryFn: () => getQNSClient().validateInviteCode(code!),
    enabled: !!code && code.length >= 1 && options?.enabled !== false,
    staleTime: 60 * 1000, // 1 minute
    gcTime: queryConfig.gcTime,
  });
}

// Reserved Names Hook

/**
 * Check if a name is reserved
 */
export function useCheckReserved(
  name: string | undefined,
  nameType: 'username' | 'domain',
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.qns.reserved(name ?? '', nameType),
    queryFn: () => getQNSClient().checkReserved(name!, nameType),
    enabled: !!name && name.length >= 1 && options?.enabled !== false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: queryConfig.gcTime,
  });
}

// Mutation Hooks

/**
 * Register a name with payment (atomic registration)
 * Payment must be made before calling this mutation
 */
export function useRegisterWithPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      name,
      nameType,
      ownership,
      payment,
      resolveKey,
    }: {
      name: string;
      nameType: 'username' | 'domain';
      ownership: Ownership;
      payment: {
        txHash: string;
        token: 'wQUIL' | 'USDC';
        chain: string;
        paymentAddress: string;
        tokenAmount: string;
      };
      resolveKey?: Uint8Array;
    }) => getQNSClient().registerWithPayment(name, nameType, ownership, payment, resolveKey),
    onSuccess: (data, variables) => {
      // Invalidate availability check since name is now being registered
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.availability(variables.name, variables.nameType),
      });
      // Add the registration to cache
      queryClient.setQueryData(queryKeys.qns.registration(data.id), data);
      // Start polling verification status
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.verificationStatus(data.id),
      });
    },
  });
}

/**
 * Get a payment address derived from wallet signature
 */
export function useGetPaymentAddress() {
  return useMutation({
    mutationFn: ({
      walletAddress,
      signature,
    }: {
      walletAddress: string;
      signature: string;
    }) => getQNSClient().getPaymentAddress(walletAddress, signature),
  });
}

/**
 * Redeem an invite code for a free name
 * If name/nameType are provided, registers that name (must be available and non-reserved)
 * If not provided, uses the invite code's reserved name (if any)
 */
export function useRedeemInviteCode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      inviteCode,
      ownership,
      name,
      nameType,
      resolveKey,
    }: {
      inviteCode: string;
      ownership: Ownership;
      name?: string;
      nameType?: 'username' | 'domain';
      resolveKey?: Uint8Array;
    }) => getQNSClient().redeemInviteCode(inviteCode, ownership, name, nameType, resolveKey),
    onSuccess: (data, variables) => {
      // Invalidate invite code validation
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.all,
      });
      // Invalidate availability check if name was provided
      if (variables.name && variables.nameType) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.qns.availability(variables.name, variables.nameType),
        });
      }
      // Add the registration to cache
      queryClient.setQueryData(queryKeys.qns.registration(data.id), data);
    },
  });
}

/**
 * Update the resolve key for a name (make publicly resolvable or private)
 * For Quilibrium stealth ownership, wallet address is not required - only signature
 */
export function useUpdateResolveKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      name,
      nameType,
      resolveKey,
      signature,
      timestamp,
      nonce,
      walletAddress,
    }: {
      name: string;
      nameType: 'username' | 'domain';
      resolveKey?: string;
      signature?: string;
      timestamp?: number;
      nonce?: string;
      walletAddress?: string; // Only needed for Ethereum ownership
    }) => getQNSClient().updateResolveKey(name, nameType, resolveKey, signature, timestamp, nonce, walletAddress),
    onSuccess: (data, variables) => {
      // Invalidate resolution queries for this name
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.resolve(variables.name),
      });
      // Invalidate all bucket queries since the resolve key affects bucket lookup results
      queryClient.invalidateQueries({
        queryKey: ['qns', 'bucket'],
      });
    },
  });
}

// Resale / Marketplace Hooks

/**
 * Create a resale listing for a name (Quilibrium stealth ownership)
 */
export function useCreateResaleListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      name,
      nameType,
      priceToken,
      priceAmount,
      sellerAddress,
      signature,
      timestamp,
      nonce,
    }: {
      name: string;
      nameType: 'username' | 'domain';
      priceToken: 'wQUIL' | 'USDC';
      priceAmount: string;
      sellerAddress: string;
      signature: string;
      timestamp: number;
      nonce: string;
    }) => getQNSClient().createResaleListing(name, nameType, priceToken, priceAmount, sellerAddress, signature, timestamp, nonce),
    onSuccess: (data, variables) => {
      // Invalidate resolution queries for this name
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.resolve(variables.name),
      });
      // Invalidate bucket queries
      queryClient.invalidateQueries({
        queryKey: ['qns', 'bucket'],
      });
    },
  });
}

/**
 * Get a resale listing by name
 */
export function useGetResaleListingByName(name: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['qns', 'resaleListing', name ?? ''],
    queryFn: () => getQNSClient().getResaleListingByName(name!),
    enabled: !!name && options?.enabled !== false,
    staleTime: 30 * 1000, // 30 seconds - listing state can change
    gcTime: queryConfig.gcTime,
  });
}
