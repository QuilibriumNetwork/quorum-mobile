/**
 * React Query hooks for QNS marketplace, auctions, and offers
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys, queryConfig } from '@/services/api/queryConfig';
import {
  getQNSClient,
  type ResaleInfo,
  type ResaleListing,
  type PurchaseStatus,
  type AuctionInfo,
  type Auction,
  type AuctionBid,
  type AuctionPurchaseStatus,
  type OfferInfo,
  type Offer,
  type OfferPurchaseStatus,
  type Ownership,
} from '@/services/api/qnsClient';

// Resale / Marketplace Hooks

/**
 * Get resale marketplace info (fees, lock duration)
 */
export function useResaleInfo(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.resaleInfo(),
    queryFn: () => getQNSClient().getResaleInfo(),
    enabled: options?.enabled !== false,
    staleTime: 5 * 60 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get paginated resale listings
 */
export function useResaleListings(
  params?: { limit?: number; offset?: number; search?: string },
  options?: { enabled?: boolean }
) {
  const paramKey = params ? JSON.stringify(params) : undefined;
  return useQuery({
    queryKey: queryKeys.qns.resaleListings(paramKey),
    queryFn: () => getQNSClient().getResaleListings(params),
    enabled: options?.enabled !== false,
    staleTime: 30 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get a single resale listing by ID
 */
export function useResaleListing(id: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.resaleListing(id ?? ''),
    queryFn: () => getQNSClient().getResaleListingById(id!),
    enabled: !!id && options?.enabled !== false,
    staleTime: 15 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get purchase status for a listing (polls during purchase flow)
 */
export function useResalePurchaseStatus(
  listingId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.qns.purchaseStatus(listingId ?? ''),
    queryFn: () => getQNSClient().getResalePurchaseStatus(listingId!),
    enabled: !!listingId && options?.enabled !== false,
    staleTime: 5 * 1000,
    gcTime: queryConfig.gcTime,
    refetchInterval: options?.refetchInterval ?? 5000,
  });
}

/**
 * Get listings by seller address
 */
export function useSellerListings(address: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.sellerListings(address ?? ''),
    queryFn: () => getQNSClient().getSellerListings(address!),
    enabled: !!address && options?.enabled !== false,
    staleTime: 30 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Lock a resale listing for purchase
 */
export function useLockResaleListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      listingId: string;
      buyerAddress: string;
      signature: string;
      chain: string;
    }) => getQNSClient().lockResaleListing(
      params.listingId,
      params.buyerAddress,
      params.signature,
      params.chain
    ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.resaleListing(data.listing_id),
      });
    },
  });
}

/**
 * Submit a resale purchase after payment
 */
export function useSubmitResalePurchase() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      listingId: string;
      buyerAddress: string;
      txHash: string;
      chain: string;
      newOwnership: Ownership;
    }) => getQNSClient().submitResalePurchase(
      params.listingId,
      params.buyerAddress,
      params.txHash,
      params.chain,
      params.newOwnership
    ),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.resaleListing(variables.listingId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.purchaseStatus(variables.listingId),
      });
      // Invalidate listing list
      queryClient.invalidateQueries({
        queryKey: ['qns', 'resale-listings'],
      });
    },
  });
}

/**
 * Cancel a resale listing
 */
export function useCancelResaleListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      listingId: string;
      signature: string;
      timestamp: number;
      nonce: string;
    }) => getQNSClient().cancelResaleListing(
      params.listingId,
      params.signature,
      params.timestamp,
      params.nonce
    ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.resaleListing(variables.listingId),
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'resale-listings'],
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'bucket'],
      });
    },
  });
}

/**
 * Transfer ownership of a name
 */
export function useTransferOwnership() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      name: string;
      nameType: 'username' | 'domain';
      newOwnership: Ownership;
      signature: string;
      timestamp: number;
      nonce: string;
    }) => getQNSClient().transferOwnership(
      params.name,
      params.nameType,
      params.newOwnership,
      params.signature,
      params.timestamp,
      params.nonce
    ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.resolve(variables.name),
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'bucket'],
      });
    },
  });
}

// Auction Hooks

/**
 * Get auction platform info (fees, duration limits, anti-snipe)
 */
export function useAuctionInfo(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.auctionInfo(),
    queryFn: () => getQNSClient().getAuctionInfo(),
    enabled: options?.enabled !== false,
    staleTime: 5 * 60 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get paginated auctions
 */
export function useAuctions(
  params?: { limit?: number; offset?: number; search?: string; state?: string },
  options?: { enabled?: boolean }
) {
  const paramKey = params ? JSON.stringify(params) : undefined;
  return useQuery({
    queryKey: queryKeys.qns.auctions(paramKey),
    queryFn: () => getQNSClient().getAuctions(params),
    enabled: options?.enabled !== false,
    staleTime: 15 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get a single auction by ID
 */
export function useAuction(id: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.auction(id ?? ''),
    queryFn: () => getQNSClient().getAuction(id!),
    enabled: !!id && options?.enabled !== false,
    staleTime: 10 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get bid history for an auction
 */
export function useAuctionBids(id: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.auctionBids(id ?? ''),
    queryFn: () => getQNSClient().getAuctionBids(id!),
    enabled: !!id && options?.enabled !== false,
    staleTime: 10 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get auction purchase status (polls after winning)
 */
export function useAuctionPurchaseStatus(
  auctionId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.qns.auctionStatus(auctionId ?? ''),
    queryFn: () => getQNSClient().getAuctionPurchaseStatus(auctionId!),
    enabled: !!auctionId && options?.enabled !== false,
    staleTime: 5 * 1000,
    gcTime: queryConfig.gcTime,
    refetchInterval: options?.refetchInterval ?? 5000,
  });
}

/**
 * Place a bid on an auction
 */
export function usePlaceBid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      auctionId: string;
      amount: string;
      bidderAddress: string;
      bidderOwnership: Ownership;
      signature: string;
      chain?: string;
    }) => getQNSClient().placeBid(params.auctionId, {
      amount: params.amount,
      bidder_address: params.bidderAddress,
      ownership: params.bidderOwnership,
      signature: params.signature,
      chain: params.chain,
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.auction(variables.auctionId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.auctionBids(variables.auctionId),
      });
    },
  });
}

/**
 * Instant buy an auction
 */
export function useInstantBuy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      auctionId: string;
      buyerAddress: string;
      buyerOwnership: Ownership;
      signature: string;
      chain?: string;
    }) => getQNSClient().instantBuy(params.auctionId, {
      buyer_address: params.buyerAddress,
      ownership: params.buyerOwnership,
      signature: params.signature,
      chain: params.chain,
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.auction(variables.auctionId),
      });
    },
  });
}

/**
 * Submit auction payment after winning
 */
export function useSubmitAuctionPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      auctionId: string;
      buyerAddress: string;
      txHash: string;
      chain: string;
      buyerOwnership: Ownership;
    }) => getQNSClient().submitAuctionPayment(params.auctionId, {
      buyer_address: params.buyerAddress,
      tx_hash: params.txHash,
      chain: params.chain,
      ownership: params.buyerOwnership,
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.auction(variables.auctionId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.auctionStatus(variables.auctionId),
      });
    },
  });
}

/**
 * Create a new auction
 */
export function useCreateAuction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      name: string;
      nameType: 'username' | 'domain';
      token: 'wQUIL' | 'USDC';
      startingPrice: string;
      instantBuyPrice?: string;
      durationHours: number;
      sellerAddress: string;
      signature: string;
      timestamp: number;
      nonce: string;
    }) => getQNSClient().createAuction({
      name: params.name,
      name_type: params.nameType,
      token: params.token,
      starting_price: params.startingPrice,
      instant_buy_price: params.instantBuyPrice,
      duration_seconds: Math.round(params.durationHours * 3600),
      seller_address: params.sellerAddress,
      signature: params.signature,
      timestamp: params.timestamp,
      nonce: params.nonce,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['qns', 'auctions'],
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'bucket'],
      });
    },
  });
}

/**
 * Cancel an auction
 */
export function useCancelAuction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      auctionId: string;
      signature: string;
      timestamp: number;
      nonce: string;
    }) => getQNSClient().cancelAuction(params.auctionId, {
      signature: params.signature,
      timestamp: params.timestamp,
      nonce: params.nonce,
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.auction(variables.auctionId),
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'auctions'],
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'bucket'],
      });
    },
  });
}

// Offer Hooks

/**
 * Get offer platform info
 */
export function useOfferInfo(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.offerInfo(),
    queryFn: () => getQNSClient().getOfferInfo(),
    enabled: options?.enabled !== false,
    staleTime: 5 * 60 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get incoming offers for an owner
 */
export function useOffersForOwner(address: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.offersForOwner(address ?? ''),
    queryFn: () => getQNSClient().getOffersForOwner(address!),
    enabled: !!address && options?.enabled !== false,
    staleTime: 30 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get outgoing offers by buyer
 */
export function useOffersByBuyer(address: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.offersByBuyer(address ?? ''),
    queryFn: () => getQNSClient().getOffersByBuyer(address!),
    enabled: !!address && options?.enabled !== false,
    staleTime: 30 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get offers for a specific name
 */
export function useOffersForName(name: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.offersForName(name ?? ''),
    queryFn: () => getQNSClient().getOffersForName(name!),
    enabled: !!name && options?.enabled !== false,
    staleTime: 30 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get a single offer by ID
 */
export function useOffer(id: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.qns.offer(id ?? ''),
    queryFn: () => getQNSClient().getOffer(id!),
    enabled: !!id && options?.enabled !== false,
    staleTime: 15 * 1000,
    gcTime: queryConfig.gcTime,
  });
}

/**
 * Get offer purchase status
 */
export function useOfferPurchaseStatus(
  offerId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.qns.offerStatus(offerId ?? ''),
    queryFn: () => getQNSClient().getOfferPurchaseStatus(offerId!),
    enabled: !!offerId && options?.enabled !== false,
    staleTime: 5 * 1000,
    gcTime: queryConfig.gcTime,
    refetchInterval: options?.refetchInterval ?? 5000,
  });
}

/**
 * Create an offer on a listing
 */
export function useCreateOfferOnListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      listingId: string;
      amount: string;
      buyerAddress: string;
      buyerOwnership: Ownership;
      expiresInHours: number;
      signature: string;
      chain?: string;
    }) => getQNSClient().createOfferOnListing({
      listing_id: params.listingId,
      amount: params.amount,
      buyer_address: params.buyerAddress,
      ownership: params.buyerOwnership,
      expiration_seconds: Math.round(params.expiresInHours * 3600),
      signature: params.signature,
      chain: params.chain,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['qns', 'offers-buyer'],
      });
    },
  });
}

/**
 * Create an offer on a name
 */
export function useCreateOfferOnName() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      name: string;
      nameType: 'username' | 'domain';
      token: 'wQUIL' | 'USDC';
      amount: string;
      buyerAddress: string;
      buyerOwnership: Ownership;
      expiresInHours: number;
      signature: string;
      chain?: string;
    }) => getQNSClient().createOfferOnName({
      name: params.name,
      name_type: params.nameType,
      token: params.token,
      amount: params.amount,
      buyer_address: params.buyerAddress,
      ownership: params.buyerOwnership,
      expiration_seconds: Math.round(params.expiresInHours * 3600),
      signature: params.signature,
      chain: params.chain,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['qns', 'offers-buyer'],
      });
    },
  });
}

/**
 * Accept an offer
 */
export function useAcceptOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      offerId: string;
      ownerAddress: string;
      signature: string;
      timestamp: number;
      nonce: string;
    }) => getQNSClient().acceptOffer(params.offerId, {
      owner_address: params.ownerAddress,
      signature: params.signature,
      timestamp: params.timestamp,
      nonce: params.nonce,
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.offer(variables.offerId),
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'offers-owner'],
      });
    },
  });
}

/**
 * Reject an offer
 */
export function useRejectOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      offerId: string;
      signature: string;
      timestamp: number;
      nonce: string;
    }) => getQNSClient().rejectOffer(params.offerId, {
      signature: params.signature,
      timestamp: params.timestamp,
      nonce: params.nonce,
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.offer(variables.offerId),
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'offers-owner'],
      });
    },
  });
}

/**
 * Cancel an offer
 */
export function useCancelOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      offerId: string;
      buyerAddress: string;
      signature: string;
      timestamp: number;
      nonce: string;
    }) => getQNSClient().cancelOffer(params.offerId, {
      buyer_address: params.buyerAddress,
      signature: params.signature,
      timestamp: params.timestamp,
      nonce: params.nonce,
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.offer(variables.offerId),
      });
      queryClient.invalidateQueries({
        queryKey: ['qns', 'offers-buyer'],
      });
    },
  });
}

/**
 * Submit offer payment after acceptance
 */
export function useSubmitOfferPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      offerId: string;
      buyerAddress: string;
      txHash: string;
      chain: string;
      buyerOwnership: Ownership;
    }) => getQNSClient().submitOfferPayment(params.offerId, {
      buyer_address: params.buyerAddress,
      tx_hash: params.txHash,
      chain: params.chain,
      ownership: params.buyerOwnership,
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.offer(variables.offerId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.qns.offerStatus(variables.offerId),
      });
    },
  });
}
