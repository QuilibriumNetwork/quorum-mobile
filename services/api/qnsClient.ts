/**
 * QNS (Quilibrium Name Service) API Client
 *
 * Connects to the QNS API for name registration, resolution, and management
 */

import Constants from 'expo-constants';

const QNS_API_BASE_URL =
  (Constants.expoConfig?.extra as { qnsApiUrl?: string } | undefined)?.qnsApiUrl
  || 'https://names.quilibrium.com';

const DEFAULT_TIMEOUT = 30000;

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
};

// Types

export interface NameRecordHeader {
  authorityKey: string;
  name: string;
  parent: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NameRecord {
  header: NameRecordHeader;
  address: string;
  resolveKey?: string; // Hex-encoded ed448 public key (57 bytes), present if name is publicly resolvable
  metadata: Record<string, unknown> | null;
  ownership?: Ownership; // Included in bucket lookup responses
  resolve_key?: string; // Base64-encoded ed448 public key (57 bytes) - from bucket lookup (different format)
}

export interface AvailabilityResult {
  available: boolean;
  reason?: string;
  requires_invite_code?: boolean;
  price_quil?: number;
  governance_points?: number;
}

export type OwnershipType = 'ethereum' | 'quilibrium';

export interface Ownership {
  type: OwnershipType;
  // Ethereum ownership - plain address (0x+40 hex)
  address?: string;
  // Quilibrium ownership - stealth markers for privacy
  one_time_key?: string; // Base64-encoded ephemeral key R (56 bytes)
  verification_key?: string; // Base64-encoded verification key P (56 bytes)
  bucket_tag?: number; // Bucket tag for privacy-preserving lookup (0-255)
}

export interface Registration {
  id: string;
  name_type: 'username' | 'domain';
  name: string;
  normalized_name: string;
  ownership: Ownership;
  payment_token?: 'wQUIL' | 'USDC';
  payment_chain?: string;
  price_quil: number;
  price_token?: string;
  state: RegistrationState;
  invite_code?: string;
  is_free_redemption: boolean;
  payment_address?: string;
  tx_hash?: string;
  block_number?: number;
  confirmations?: number;
  governance_points: number;
  failure_reason?: string;
  resolve_key?: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export type RegistrationState =
  | 'initiated'
  | 'payment_pending'
  | 'payment_submitted'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'expired';

export interface PaymentInfo {
  registration_id: string;
  payment_address: string;
  token_address: string;
  token: 'wQUIL' | 'USDC';
  chain: string;
  chain_id: number;
  amount: string;
  amount_wei: string;
  expires_at: string;
}

export interface PricingTier {
  min_length: number;
  max_length: number;
  price_quil: number;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  description: string;
  chains: string[];
}

export interface ChainInfo {
  chain: string;
  chain_id: number;
  tokens: string[];
  confirmations: number;
}

export interface PricingInfo {
  prices: {
    // Decimal strings, NOT numbers — the Go server's TokenPrices struct
    // (qns-api internal/services/pricing.go) serializes these as strings.
    quil_price_usd: string;
    wquil_price_usd: string;
    usdc_price_usd: string;
    last_update: string;
  };
  tiers: PricingTier[];
  tokens: TokenInfo[];
  chains: ChainInfo[];
  governance_points_multiplier: number;
}

export interface InviteCodeValidation {
  valid: boolean;
  reason?: string;
  reserved_name?: string;
  name_type?: 'username' | 'domain';
  price_quil?: number;
  governance_points?: number;
}

export interface VerificationStatus {
  registration_id: string;
  state: string;
  tx_hash?: string;
  block_number?: number;
  confirmations?: number;
  required_confirmations?: number;
  message?: string;
}

export interface ReservedNameCheck {
  name: string;
  name_type: string;
  is_reserved: boolean;
  has_invite_code?: boolean;
  reason?: string;
}

export type ResaleListingState = 'active' | 'locked' | 'pending_purchase' | 'sold' | 'cancelled' | 'failed';

export interface ResaleListing {
  listing_id: string;
  id?: string;
  name: string;
  name_type: 'username' | 'domain';
  price_token: 'wQUIL' | 'USDC';
  price_amount: string;
  fee_amount: string;
  seller_amount: string;
  seller_address: string;
  state: ResaleListingState;
  locked_by?: string;
  lock_expires_at?: number;
  created_at?: string | number;
  updated_at?: string;
}

export interface ResaleInfo {
  enabled: boolean;
  platform_fee_percent: number;
  seller_percent: number;
  lock_duration_seconds: number;
  signature_message: string;
}

export interface LockResult {
  listing_id: string;
  name: string;
  state: ResaleListingState;
  lock_expires_at: string;
  price_token: string;
  price_amount: string;
  fee_amount: string;
  seller_amount: string;
  platform_address: string;
  seller_address: string;
}

export interface PurchaseStatus {
  listing_id: string;
  name: string;
  state: ResaleListingState;
  tx_hash?: string;
  confirmations?: number;
  required_confirmations?: number;
  message?: string;
  reorg_detected?: boolean;
  chain_unhealthy?: boolean;
}

export type AuctionState = 'active' | 'awaiting_payment' | 'purchase_pending' | 'confirming' | 'sold' | 'cancelled' | 'failed';

export interface Auction {
  id: string;
  name: string;
  normalized_name: string;
  name_type: 'username' | 'domain';
  state: AuctionState;
  seller_ownership: Ownership;
  seller_address: string;
  token: 'wQUIL' | 'USDC';
  starting_price: string;
  instant_buy_price?: string;
  starts_at: string;
  ends_at: string;
  original_ends_at: string;
  extension_count: number;
  highest_bid_id?: string;
  highest_bid?: string;
  highest_bidder?: string;
  bid_count: number;
  current_payment_position?: number;
  payment_window_ends_at?: string;
  winning_bid_id?: string;
  buyer_ownership?: Ownership;
  fee_payment_address?: string;
  tx_hash?: string;
  confirmations?: number;
  sold_at?: string;
  failure_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface AuctionBid {
  id: string;
  auction_id: string;
  bidder_address: string;
  amount: string;
  position: number;
  bidder_ownership: Ownership;
  created_at: string;
  updated_at: string;
}

export interface AuctionInfo {
  enabled: boolean;
  platform_fee_percent: number;
  seller_percent: number;
  min_duration_seconds: number;
  max_duration_seconds: number;
  min_bid_increment_bps: number;
  anti_snipe_seconds: number;
  cascade_windows_seconds: number[];
  signature_message: string;
}

export interface PlaceBidResult {
  bid_id: string;
  auction_id: string;
  amount: string;
  position: number;
  ends_at: string;
  extension_count: number;
  message?: string;
}

export interface InstantBuyResult {
  auction_id: string;
  name: string;
  state: AuctionState;
  token: 'wQUIL' | 'USDC';
  amount: string;
  fee_amount: string;
  seller_amount: string;
  platform_address: string;
  seller_address: string;
  payment_window: string;
}

export interface AuctionPurchaseStatus {
  auction_id: string;
  name: string;
  state: AuctionState;
  tx_hash?: string;
  confirmations?: number;
  required_confirmations?: number;
  message?: string;
  reorg_detected?: boolean;
  chain_unhealthy?: boolean;
}

export type OfferState = 'pending' | 'accepted' | 'purchase_pending' | 'confirming' | 'completed' | 'rejected' | 'expired' | 'cancelled' | 'failed';
export type OfferType = 'on_listing' | 'on_name';

export interface Offer {
  id: string;
  type: OfferType;
  state: OfferState;
  listing_id?: string;
  name?: string;
  normalized_name?: string;
  name_type?: 'username' | 'domain';
  buyer_address: string;
  buyer_ownership: Ownership;
  token: 'wQUIL' | 'USDC';
  amount: string;
  fee_amount?: string;
  seller_amount?: string;
  owner_address?: string;
  expires_at: number;
  accepted_at?: number;
  accept_lock_expires?: number;
  fee_payment_address?: string;
  tx_hash?: string;
  confirmations?: number;
  completed_at?: number;
  failure_reason?: string;
  created_at: number;
  updated_at?: number;
}

export interface OfferInfo {
  enabled: boolean;
  platform_fee_percent: number;
  seller_percent: number;
  min_expiration_seconds: number;
  max_expiration_seconds: number;
  default_expiration_seconds: number;
  accept_lock_window_seconds: number;
  signature_message: string;
}

export interface CreateOfferResult {
  offer_id: string;
  type: OfferType;
  token: 'wQUIL' | 'USDC';
  amount: string;
  fee_amount: string;
  seller_amount: string;
  expires_at: string;
  state: OfferState;
}

export interface AcceptOfferResult {
  offer_id: string;
  state: OfferState;
  token: 'wQUIL' | 'USDC';
  amount: string;
  fee_amount: string;
  seller_amount: string;
  platform_address: string;
  seller_address: string;
  accept_lock_expires: string;
}

export interface OfferPurchaseStatus {
  offer_id: string;
  state: OfferState;
  tx_hash?: string;
  confirmations?: number;
  required_confirmations?: number;
  message?: string;
  reorg_detected?: boolean;
  chain_unhealthy?: boolean;
}

export interface TransferOwnershipResult {
  name: string;
  name_type: 'username' | 'domain';
  new_ownership: Ownership;
  message: string;
}

// Error Class

export class QNSAPIError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'QNSAPIError';
    this.code = code;
    this.status = status;
  }
}

// Client Class

interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  timeout?: number;
  headers?: Record<string, string>;
}

export class QNSClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? QNS_API_BASE_URL;
  }

  private async fetch<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
    const { method = 'GET', body, timeout = DEFAULT_TIMEOUT, headers = {} } = options;
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...DEFAULT_HEADERS,
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new QNSAPIError(
          'PARSE_ERROR',
          `Failed to parse response as JSON: ${responseText.substring(0, 100)}`,
          response.status
        );
      }

      if (!response.ok) {
        const errorData = data as { error?: { code?: string; message?: string } };
        throw new QNSAPIError(
          errorData.error?.code || 'UNKNOWN_ERROR',
          errorData.error?.message || `HTTP ${response.status}`,
          response.status
        );
      }

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof QNSAPIError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new QNSAPIError('TIMEOUT', 'Request timeout', 408);
      }
      throw error;
    }
  }

  // Health Check API

  /**
   * Check if the QNS service is healthy/available
   */
  async checkHealth(): Promise<{ status: string }> {
    const response = await this.fetch<{ success: true; data: { status: string } }>('/health');
    return response.data;
  }

  // Resolution APIs

  /**
   * Resolve a single name to its record
   */
  async resolveName(name: string): Promise<NameRecord> {
    return this.fetch<NameRecord>(`/resolve/${encodeURIComponent(name)}`);
  }

  /**
   * Resolve multiple names at once (max 100)
   */
  async resolveBatch(names: string[]): Promise<(NameRecord | null)[]> {
    const response = await this.fetch<{ records: (NameRecord | null)[] }>('/resolve/batch', {
      method: 'POST',
      body: { names },
    });
    return response.records;
  }

  /**
   * Reverse lookup - find names by authority key or address (ethereum only)
   */
  async reverseLookup(keyOrAddress: string): Promise<string[]> {
    return this.fetch<string[]>(`/reverse/${encodeURIComponent(keyOrAddress)}`);
  }

  /**
   * Fetch a single page of stealth ownership records from a bucket
   */
  private async fetchBucketPage(
    bucketTag: number,
    limit: number,
    offset: number
  ): Promise<{ records: NameRecord[]; total_count: number; limit: number; offset: number }> {
    return this.fetch<{ records: NameRecord[]; total_count: number; limit: number; offset: number }>(
      `/bucket/${bucketTag}?limit=${limit}&offset=${offset}`
    );
  }

  /**
   * Bucket lookup - get all stealth ownership records in a bucket (quilibrium privacy lookup)
   * Pages through GET /bucket/{tag} until all records are fetched.
   * Client should decrypt locally to find owned names
   */
  async bucketLookup(bucketTag: number): Promise<NameRecord[]> {
    const limit = 100;
    let offset = 0;
    const all: NameRecord[] = [];
    // Page until a short page is returned
    for (;;) {
      const response = await this.fetchBucketPage(bucketTag, limit, offset);
      const records = response.records ?? [];
      all.push(...records);
      if (records.length < limit || all.length >= response.total_count) {
        break;
      }
      offset += records.length;
    }
    return all;
  }

  /**
   * Find a single stealth ownership record by name within a bucket.
   * The server only exposes ownership markers (one_time_key / verification_key)
   * via GET /bucket/{tag} - there is no GET /names/{name} route - so we page
   * through the bucket until the record for this name is found.
   * Returns null if the name is not present in the bucket.
   */
  async getNameRecordFromBucket(bucketTag: number, name: string): Promise<NameRecord | null> {
    const limit = 100;
    let offset = 0;
    for (;;) {
      const response = await this.fetchBucketPage(bucketTag, limit, offset);
      const records = response.records ?? [];
      const match = records.find(
        r => ((r as { name?: string }).name || r.header?.name) === name
      );
      if (match) {
        return match;
      }
      if (records.length < limit || offset + records.length >= response.total_count) {
        return null;
      }
      offset += records.length;
    }
  }

  /**
   * Get subdomains of a parent domain
   */
  async getSubdomains(parent: string): Promise<NameRecord[]> {
    return this.fetch<NameRecord[]>(`/subdomains/${encodeURIComponent(parent)}`);
  }

  // Name Management APIs

  /**
   * Check if a name is available for registration
   */
  async checkNameAvailability(
    name: string,
    nameType: 'username' | 'domain'
  ): Promise<AvailabilityResult> {
    const response = await this.fetch<{ success: true; data: AvailabilityResult }>('/names/check', {
      method: 'POST',
      body: { name, name_type: nameType },
    });
    return response.data;
  }

  // Pricing APIs

  /**
   * Get pricing information
   */
  async getPricing(): Promise<PricingInfo> {
    const response = await this.fetch<{ success: true; data: PricingInfo }>('/pricing');
    return response.data;
  }

  /**
   * Calculate price for a name in a specific token
   */
  async calculatePrice(
    name: string,
    nameType: 'username' | 'domain',
    token: 'wQUIL' | 'USDC'
  ): Promise<{
    price_quil: number;
    price_token: string;
    token: string;
    governance_points: number;
    price_usd: number;
  }> {
    const response = await this.fetch<{
      success: true;
      data: {
        price_quil: number;
        price_token: string;
        token: string;
        governance_points: number;
        price_usd: number;
      };
    }>('/pricing/calculate', {
      method: 'POST',
      body: { name, name_type: nameType, token },
    });
    return response.data;
  }

  /**
   * Get the signature message that must be signed to derive a payment address
   */
  async getSignatureMessage(): Promise<{ message: string }> {
    const response = await this.fetch<{ success: true; data: { message: string } }>(
      '/pricing/signature-message'
    );
    return response.data;
  }

  /**
   * Get a payment address derived from wallet signature (EIP-191 personal_sign)
   * The payment address is deterministic based on the wallet's signature
   * @param walletAddress The wallet address that signed the message
   * @param signature The EIP-191 personal_sign signature of the signature message
   */
  async getPaymentAddress(
    walletAddress: string,
    signature: string
  ): Promise<{
    payment_address: string;
    signature_message: string;
  }> {
    const response = await this.fetch<{
      success: true;
      data: {
        payment_address: string;
        signature_message: string;
      };
    }>('/pricing/payment-address', {
      method: 'POST',
      body: {
        wallet_address: walletAddress,
        signature,
      },
    });
    return response.data;
  }

  // Invite Code APIs

  /**
   * Validate an invite code
   */
  async validateInviteCode(code: string): Promise<InviteCodeValidation> {
    const response = await this.fetch<{ success: true; data: InviteCodeValidation }>(
      '/invite-codes/validate',
      {
        method: 'POST',
        body: { code },
      }
    );
    return response.data;
  }

  /**
   * Redeem an invite code for a free name
   * If name/nameType are provided, registers that name (must be available and non-reserved)
   * If not provided, uses the invite code's reserved name (if any)
   * @param inviteCode The invite code to redeem
   * @param ownership Ownership details (ethereum or quilibrium stealth)
   * @param name Optional name to register (if not using invite code's reserved name)
   * @param nameType Required if name is provided
   * @param resolveKey Optional ed448 public key (57 bytes) for public resolution
   */
  async redeemInviteCode(
    inviteCode: string,
    ownership: Ownership,
    name?: string,
    nameType?: 'username' | 'domain',
    resolveKey?: Uint8Array
  ): Promise<Registration> {
    const response = await this.fetch<{ success: true; data: Registration }>('/invite-codes/redeem', {
      method: 'POST',
      body: {
        invite_code: inviteCode,
        ownership,
        ...(name && { name }),
        ...(nameType && { name_type: nameType }),
        ...(resolveKey && { resolve_key: btoa(String.fromCharCode(...resolveKey)) }),
      },
    });
    return response.data;
  }

  // Registration APIs

  /**
   * Register a name with payment (atomic registration)
   * Payment must be made before calling this endpoint
   * @param name Name to register
   * @param nameType 'username' or 'domain'
   * @param ownership Ownership details (ethereum or quilibrium stealth)
   * @param payment Payment details including tx_hash
   * @param resolveKey Optional ed448 public key (57 bytes) for public resolution
   */
  async registerWithPayment(
    name: string,
    nameType: 'username' | 'domain',
    ownership: Ownership,
    payment: {
      txHash: string;
      token: 'wQUIL' | 'USDC';
      chain: string;
      paymentAddress: string;
      tokenAmount: string;
    },
    resolveKey?: Uint8Array
  ): Promise<Registration> {
    const response = await this.fetch<{ success: true; data: Registration }>('/registrations', {
      method: 'POST',
      body: {
        name,
        name_type: nameType,
        ownership,
        payment: {
          tx_hash: payment.txHash,
          token: payment.token,
          chain: payment.chain,
          payment_address: payment.paymentAddress,
          token_amount: payment.tokenAmount,
        },
        ...(resolveKey && { resolve_key: btoa(String.fromCharCode(...resolveKey)) }),
      },
    });
    return response.data;
  }

  /**
   * Get registration by ID
   */
  async getRegistration(id: string): Promise<Registration> {
    const response = await this.fetch<{ success: true; data: Registration }>(`/registrations/${id}`);
    return response.data;
  }

  /**
   * Get all registrations for a wallet
   */
  async getRegistrationsByWallet(walletAddress: string): Promise<Registration[]> {
    const response = await this.fetch<{ success: true; data: { registrations: Registration[] } }>(
      `/registrations?wallet=${encodeURIComponent(walletAddress)}`
    );
    return response.data.registrations;
  }

  /**
   * Get registration verification status
   */
  async getVerificationStatus(registrationId: string): Promise<VerificationStatus> {
    const response = await this.fetch<{ success: true; data: VerificationStatus }>(
      `/registrations/${registrationId}/status`
    );
    return response.data;
  }

  // Reserved Names APIs

  /**
   * Check if a name is reserved
   */
  async checkReserved(name: string, nameType: 'username' | 'domain'): Promise<ReservedNameCheck> {
    const response = await this.fetch<{ success: true; data: ReservedNameCheck }>(
      '/reserved-names/check',
      {
        method: 'POST',
        body: { name, name_type: nameType },
      }
    );
    return response.data;
  }

  // Resolve Key APIs

  /**
   * Update the resolve key for a name (make publicly resolvable or private)
   * For Quilibrium stealth ownership, uses signature against verificationKey
   * @param name The name to update
   * @param nameType 'username' or 'domain'
   * @param resolveKey Hex-encoded ed448 public key (57 bytes), or undefined to make private
   * @param signature Hex-encoded Schnorr signature (112 bytes) for ownership verification
   * @param timestamp Unix timestamp when signature was created
   * @param nonce Random nonce to prevent replay attacks
   * @param walletAddress Optional - only needed for Ethereum ownership
   */
  async updateResolveKey(
    name: string,
    nameType: 'username' | 'domain',
    resolveKey?: string,
    signature?: string,
    timestamp?: number,
    nonce?: string,
    walletAddress?: string
  ): Promise<{ name: string; isPublic: boolean; resolveKey?: string }> {
    // Convert hex resolveKey to base64 for API (expects []byte which JSON encodes as base64)
    let resolveKeyBase64: string | undefined;
    if (resolveKey) {
      const bytes = new Uint8Array(resolveKey.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
      resolveKeyBase64 = btoa(String.fromCharCode(...bytes));
    }

    const response = await this.fetch<{
      success: true;
      data: { name: string; is_public: boolean; resolve_key?: string };
    }>('/names/resolve-key', {
      method: 'PUT',
      body: {
        name,
        name_type: nameType,
        resolve_key: resolveKeyBase64,
        signature,
        timestamp,
        nonce,
        ...(walletAddress && { wallet_address: walletAddress }),
      },
    });
    return {
      name: response.data.name,
      isPublic: response.data.is_public,
      resolveKey: response.data.resolve_key,
    };
  }

  // Resale / Marketplace APIs

  /**
   * Create a resale listing for a name owned via Quilibrium stealth address
   * @param name The name being listed
   * @param nameType 'username' or 'domain'
   * @param priceToken Payment token ('wQUIL' or 'USDC')
   * @param priceAmount Decimal price string (e.g., "1000.00")
   * @param sellerAddress Ethereum address to receive payment (99% of sale)
   * @param signature Hex-encoded 112-byte Schnorr signature
   * @param timestamp Unix timestamp when signature was created
   * @param nonce Random unique string to prevent replay attacks
   */
  async createResaleListing(
    name: string,
    nameType: 'username' | 'domain',
    priceToken: 'wQUIL' | 'USDC',
    priceAmount: string,
    sellerAddress: string,
    signature: string,
    timestamp: number,
    nonce: string
  ): Promise<ResaleListing> {
    const response = await this.fetch<{ success: true; data: ResaleListing }>('/resale/listings', {
      method: 'POST',
      body: {
        name,
        name_type: nameType,
        price_token: priceToken,
        price_amount: priceAmount,
        seller_address: sellerAddress,
        signature,
        timestamp,
        nonce,
      },
    });
    return response.data;
  }

  /**
   * Get a resale listing by name
   * @param name The name to look up
   */
  async getResaleListingByName(name: string): Promise<ResaleListing | null> {
    try {
      const response = await this.fetch<{ success: true; data: ResaleListing }>(`/resale/listings/name/${encodeURIComponent(name)}`);
      return response.data;
    } catch (error) {
      // Return null if listing not found (404)
      if (error instanceof QNSAPIError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // Extended Resale Marketplace APIs

  async getResaleInfo(): Promise<ResaleInfo> {
    const response = await this.fetch<{ success: true; data: ResaleInfo }>('/resale/info');
    return response.data;
  }

  async getResaleListings(params?: { limit?: number; offset?: number; search?: string }): Promise<{ listings: ResaleListing[]; total_count: number }> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    if (params?.search) searchParams.set('search', params.search);
    const query = searchParams.toString();
    const response = await this.fetch<{ success: true; data: { listings: ResaleListing[]; total_count: number; limit: number; offset: number } }>(`/resale/listings${query ? `?${query}` : ''}`);
    return response.data;
  }

  async getResaleListingById(id: string): Promise<ResaleListing> {
    const response = await this.fetch<{ success: true; data: ResaleListing }>(`/resale/listings/${id}`);
    return response.data;
  }

  async lockResaleListing(listingId: string, buyerAddress: string, signature: string, chain?: string): Promise<LockResult> {
    const response = await this.fetch<{ success: true; data: LockResult }>(`/resale/listings/${listingId}/lock`, {
      method: 'POST',
      body: { buyer_address: buyerAddress, signature, ...(chain && { chain }) },
    });
    return response.data;
  }

  async submitResalePurchase(listingId: string, buyerAddress: string, txHash: string, chain: string, newOwnership: Ownership): Promise<{ listing_id: string; name: string; state: ResaleListingState; tx_hash: string; purchase_expires_at: string; message: string }> {
    const response = await this.fetch<{ success: true; data: { listing_id: string; name: string; state: ResaleListingState; tx_hash: string; purchase_expires_at: string; message: string } }>(`/resale/listings/${listingId}/purchase`, {
      method: 'POST',
      body: { buyer_address: buyerAddress, tx_hash: txHash, chain, new_ownership: newOwnership },
    });
    return response.data;
  }

  async getResalePurchaseStatus(listingId: string): Promise<PurchaseStatus> {
    const response = await this.fetch<{ success: true; data: PurchaseStatus }>(`/resale/listings/status/${listingId}`);
    return response.data;
  }

  async cancelResaleListing(listingId: string, signature: string, timestamp: number, nonce: string): Promise<void> {
    await this.fetch<{ success: true; data: { message: string } }>(`/resale/listings/${listingId}`, {
      method: 'DELETE',
      body: { signature, timestamp, nonce },
    });
  }

  async getSellerListings(sellerAddress: string): Promise<ResaleListing[]> {
    const response = await this.fetch<{ success: true; data: { listings: ResaleListing[] } }>(`/resale/sellers/${encodeURIComponent(sellerAddress)}/listings`);
    return response.data.listings;
  }

  // Name Transfer API

  async transferOwnership(name: string, nameType: 'username' | 'domain', newOwnership: Ownership, signature: string, timestamp: number, nonce: string): Promise<TransferOwnershipResult> {
    const response = await this.fetch<{ success: true; data: TransferOwnershipResult }>('/names/transfer', {
      method: 'POST',
      body: { name, name_type: nameType, new_ownership: newOwnership, signature, timestamp, nonce },
    });
    return response.data;
  }

  // Auction APIs

  async getAuctionInfo(): Promise<AuctionInfo> {
    const response = await this.fetch<{ success: true; data: AuctionInfo }>('/auctions/info');
    return response.data;
  }

  async getAuctions(params?: { limit?: number; offset?: number; search?: string }): Promise<{ auctions: Auction[]; total_count: number }> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    if (params?.search) searchParams.set('search', params.search);
    const query = searchParams.toString();
    const response = await this.fetch<{ success: true; data: { auctions: Auction[]; total_count: number; limit: number; offset: number } }>(`/auctions${query ? `?${query}` : ''}`);
    return response.data;
  }

  async getAuction(id: string): Promise<Auction> {
    const response = await this.fetch<{ success: true; data: Auction }>(`/auctions/${id}`);
    return response.data;
  }

  async createAuction(params: {
    name: string;
    name_type: 'username' | 'domain';
    token: 'wQUIL' | 'USDC';
    starting_price: string;
    instant_buy_price?: string;
    duration_seconds: number;
    seller_address: string;
    signature: string;
    timestamp: number;
    nonce: string;
  }): Promise<{ auction_id: string; name: string; token: 'wQUIL' | 'USDC'; starting_price: string; instant_buy_price?: string; ends_at: string; state: AuctionState }> {
    const response = await this.fetch<{ success: true; data: { auction_id: string; name: string; token: 'wQUIL' | 'USDC'; starting_price: string; instant_buy_price?: string; ends_at: string; state: AuctionState } }>('/auctions', {
      method: 'POST',
      body: params,
    });
    return response.data;
  }

  async placeBid(auctionId: string, params: {
    bidder_address: string;
    amount: string;
    ownership: Ownership;
    signature: string;
    chain?: string;
  }): Promise<PlaceBidResult> {
    const response = await this.fetch<{ success: true; data: PlaceBidResult }>(`/auctions/bids/${auctionId}`, {
      method: 'POST',
      body: params,
    });
    return response.data;
  }

  async instantBuy(auctionId: string, params: {
    buyer_address: string;
    ownership: Ownership;
    signature: string;
    chain?: string;
  }): Promise<InstantBuyResult> {
    const response = await this.fetch<{ success: true; data: InstantBuyResult }>(`/auctions/instant-buy/${auctionId}`, {
      method: 'POST',
      body: params,
    });
    return response.data;
  }

  async submitAuctionPayment(auctionId: string, params: {
    buyer_address: string;
    tx_hash: string;
    chain: string;
    ownership: Ownership;
  }): Promise<{ auction_id: string; name: string; state: AuctionState; tx_hash: string; purchase_expires_at: string; message: string }> {
    const response = await this.fetch<{ success: true; data: { auction_id: string; name: string; state: AuctionState; tx_hash: string; purchase_expires_at: string; message: string } }>(`/auctions/payment/${auctionId}`, {
      method: 'POST',
      body: params,
    });
    return response.data;
  }

  async getAuctionPurchaseStatus(auctionId: string): Promise<AuctionPurchaseStatus> {
    const response = await this.fetch<{ success: true; data: AuctionPurchaseStatus }>(`/auctions/status/${auctionId}`);
    return response.data;
  }

  async getAuctionBids(auctionId: string): Promise<AuctionBid[]> {
    const response = await this.fetch<{ success: true; data: { bids: AuctionBid[] } }>(`/auctions/bids/${auctionId}`);
    return response.data.bids;
  }

  async cancelAuction(auctionId: string, params: { signature: string; timestamp: number; nonce: string }): Promise<void> {
    await this.fetch<{ success: true; data: { message: string } }>(`/auctions/${auctionId}`, {
      method: 'DELETE',
      body: params,
    });
  }

  // Offer APIs

  async getOfferInfo(): Promise<OfferInfo> {
    const response = await this.fetch<{ success: true; data: OfferInfo }>('/offers/info');
    return response.data;
  }

  async createOfferOnListing(params: {
    listing_id: string;
    buyer_address: string;
    ownership: Ownership;
    amount: string;
    expiration_seconds: number;
    signature: string;
    chain?: string;
  }): Promise<CreateOfferResult> {
    const response = await this.fetch<{ success: true; data: CreateOfferResult }>('/offers/listing', {
      method: 'POST',
      body: params,
    });
    return response.data;
  }

  async createOfferOnName(params: {
    name: string;
    name_type: 'username' | 'domain';
    buyer_address: string;
    ownership: Ownership;
    token: 'wQUIL' | 'USDC';
    amount: string;
    expiration_seconds: number;
    signature: string;
    chain?: string;
  }): Promise<CreateOfferResult> {
    const response = await this.fetch<{ success: true; data: CreateOfferResult }>('/offers/name', {
      method: 'POST',
      body: params,
    });
    return response.data;
  }

  async getOffer(id: string): Promise<Offer> {
    const response = await this.fetch<{ success: true; data: Offer }>(`/offers/${id}`);
    return response.data;
  }

  async acceptOffer(offerId: string, params: {
    owner_address: string;
    signature: string;
    timestamp: number;
    nonce: string;
  }): Promise<AcceptOfferResult> {
    const response = await this.fetch<{ success: true; data: AcceptOfferResult }>(`/offers/${offerId}/accept`, {
      method: 'POST',
      body: params,
    });
    return response.data;
  }

  async rejectOffer(offerId: string, params: {
    signature: string;
    timestamp: number;
    nonce: string;
  }): Promise<void> {
    await this.fetch<{ success: true; data: { message: string } }>(`/offers/${offerId}/reject`, {
      method: 'POST',
      body: params,
    });
  }

  async cancelOffer(offerId: string, params: {
    buyer_address: string;
    signature: string;
    timestamp: number;
    nonce: string;
  }): Promise<void> {
    await this.fetch<{ success: true; data: { message: string } }>(`/offers/${offerId}/cancel`, {
      method: 'POST',
      body: params,
    });
  }

  async submitOfferPayment(offerId: string, params: {
    buyer_address: string;
    tx_hash: string;
    chain: string;
    ownership: Ownership;
  }): Promise<{ offer_id: string; state: OfferState; tx_hash: string; purchase_expires_at: string; message: string }> {
    const response = await this.fetch<{ success: true; data: { offer_id: string; state: OfferState; tx_hash: string; purchase_expires_at: string; message: string } }>(`/offers/${offerId}/payment`, {
      method: 'POST',
      body: params,
    });
    return response.data;
  }

  async getOfferPurchaseStatus(offerId: string): Promise<OfferPurchaseStatus> {
    const response = await this.fetch<{ success: true; data: OfferPurchaseStatus }>(`/offers/status/${offerId}`);
    return response.data;
  }

  async getOffersForOwner(ownerAddress: string): Promise<Offer[]> {
    const response = await this.fetch<{ success: true; data: { offers: Offer[] } }>(`/offers/owners/${encodeURIComponent(ownerAddress)}`);
    return response.data.offers;
  }

  async getOffersByBuyer(buyerAddress: string): Promise<Offer[]> {
    const response = await this.fetch<{ success: true; data: { offers: Offer[] } }>(`/offers/buyers/${encodeURIComponent(buyerAddress)}`);
    return response.data.offers;
  }

  async getOffersForName(name: string): Promise<Offer[]> {
    const response = await this.fetch<{ success: true; data: { offers: Offer[] } }>(`/offers/name/${encodeURIComponent(name)}`);
    return response.data.offers;
  }
}

// Singleton Instance

let qnsClient: QNSClient | null = null;

export function getQNSClient(): QNSClient {
  if (!qnsClient) {
    qnsClient = new QNSClient();
  }
  return qnsClient;
}

// Convenience Functions

// These mirror the web client's function exports for easy migration

export async function resolveName(name: string): Promise<NameRecord> {
  return getQNSClient().resolveName(name);
}

export async function resolveBatch(names: string[]): Promise<(NameRecord | null)[]> {
  return getQNSClient().resolveBatch(names);
}

export async function reverseLookup(keyOrAddress: string): Promise<string[]> {
  return getQNSClient().reverseLookup(keyOrAddress);
}

export async function checkNameAvailability(
  name: string,
  nameType: 'username' | 'domain'
): Promise<AvailabilityResult> {
  return getQNSClient().checkNameAvailability(name, nameType);
}

export async function getPricing(): Promise<PricingInfo> {
  return getQNSClient().getPricing();
}

export async function validateInviteCode(code: string): Promise<InviteCodeValidation> {
  return getQNSClient().validateInviteCode(code);
}

export async function registerWithPayment(
  name: string,
  nameType: 'username' | 'domain',
  ownership: Ownership,
  payment: {
    txHash: string;
    token: 'wQUIL' | 'USDC';
    chain: string;
    paymentAddress: string;
    tokenAmount: string;
  },
  resolveKey?: Uint8Array
): Promise<Registration> {
  return getQNSClient().registerWithPayment(name, nameType, ownership, payment, resolveKey);
}

export async function getSignatureMessage(): Promise<{ message: string }> {
  return getQNSClient().getSignatureMessage();
}

export async function getPaymentAddress(
  walletAddress: string,
  signature: string
): Promise<{
  payment_address: string;
  signature_message: string;
}> {
  return getQNSClient().getPaymentAddress(walletAddress, signature);
}
