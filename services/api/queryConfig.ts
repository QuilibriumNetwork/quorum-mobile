/**
 * Standardized React Query configuration for consistent caching and retry behavior.
 */
export const queryConfig = {
  staleTime: {
    feed: 2 * 60 * 1000,       // 2 minutes - feeds update frequently
    profile: 5 * 60 * 1000,    // 5 minutes - profiles change less often
    channel: 5 * 60 * 1000,    // 5 minutes - channel data is relatively stable
    thread: 1 * 60 * 1000,     // 1 minute - thread replies may come quickly
    messages: 15 * 60 * 1000,  // 15 minutes - messages rarely change; WebSocket handles real-time updates
  },
  gcTime: 5 * 60 * 1000,      // 5 minutes garbage collection time
  retry: 3,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30000),
};

/**
 * Query keys factory for consistent key generation.
 */
export const queryKeys = {
  farcaster: {
    all: ['farcaster'] as const,
    feed: (fid?: number) => ['farcaster-feed', fid] as const,
    thread: (username: string, hashPrefix: string) =>
      ['farcaster-thread', username, hashPrefix] as const,
    profile: (fid: number) => ['farcaster-profile', fid] as const,
    channel: (channelKey: string) => ['farcaster-channel', channelKey] as const,
  },
  qns: {
    all: ['qns'] as const,
    resolve: (name: string) => ['qns', 'resolve', name] as const,
    resolveBatch: (names: string[]) => ['qns', 'resolve-batch', names.join(',')] as const,
    reverse: (keyOrAddress: string) => ['qns', 'reverse', keyOrAddress] as const,
    availability: (name: string, nameType: 'username' | 'domain') =>
      ['qns', 'availability', name, nameType] as const,
    pricing: () => ['qns', 'pricing'] as const,
    calculatePrice: (name: string, nameType: 'username' | 'domain', token: 'wQUIL' | 'USDC') =>
      ['qns', 'calculate-price', name, nameType, token] as const,
    registration: (id: string) => ['qns', 'registration', id] as const,
    registrationsByWallet: (wallet: string) => ['qns', 'registrations', wallet] as const,
    verificationStatus: (id: string) => ['qns', 'verification', id] as const,
    inviteCode: (code: string) => ['qns', 'invite-code', code] as const,
    reserved: (name: string, nameType: 'username' | 'domain') =>
      ['qns', 'reserved', name, nameType] as const,
    bucket: (tag: number) => ['qns', 'bucket', tag] as const,
    resaleInfo: () => ['qns', 'resale-info'] as const,
    resaleListings: (params?: string) => ['qns', 'resale-listings', params] as const,
    resaleListing: (id: string) => ['qns', 'resale-listing', id] as const,
    purchaseStatus: (id: string) => ['qns', 'purchase-status', id] as const,
    sellerListings: (address: string) => ['qns', 'seller-listings', address] as const,
    auctionInfo: () => ['qns', 'auction-info'] as const,
    auctions: (params?: string) => ['qns', 'auctions', params] as const,
    auction: (id: string) => ['qns', 'auction', id] as const,
    auctionBids: (id: string) => ['qns', 'auction-bids', id] as const,
    auctionStatus: (id: string) => ['qns', 'auction-status', id] as const,
    offerInfo: () => ['qns', 'offer-info'] as const,
    offersForOwner: (address: string) => ['qns', 'offers-owner', address] as const,
    offersByBuyer: (address: string) => ['qns', 'offers-buyer', address] as const,
    offersForName: (name: string) => ['qns', 'offers-name', name] as const,
    offer: (id: string) => ['qns', 'offer', id] as const,
    offerStatus: (id: string) => ['qns', 'offer-status', id] as const,
  },
};

export default queryConfig;
