/**
 * Mobile QuorumApiClient Implementation
 *
 * Implements the @quilibrium/quorum-shared QuorumApiClient interface using fetch
 */

import type {
  QuorumApiClient,
  SendMessageParams,
  SendDirectMessageParams,
  AddReactionParams,
  RemoveReactionParams,
  EditMessageParams,
  DeleteMessageParams,
  Space,
  Message,
  Conversation,
} from '@quilibrium/quorum-shared';

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
};

/**
 * Inbox registration info
 */
export interface InboxRegistration {
  /** Inbox address for receiving encrypted messages */
  inbox_address: string;
  /** X448 inbox encryption public key (hex string) */
  inbox_encryption_public_key: string;
  /** Ed448 inbox signing public key for delete requests (hex string) */
  inbox_public_key: string;
}

/**
 * Device registration info for E2E encryption
 * Contains keys for a specific device
 */
export interface DeviceRegistration {
  /** X448 identity public key (hex string) */
  identity_public_key: string;
  /** X448 pre-key for X3DH (hex string) */
  pre_public_key: string;
  /** Inbox registration info */
  inbox_registration: InboxRegistration;
}

/**
 * User registration info for E2E encryption
 * Used for X3DH key exchange when initiating encrypted conversations
 */
export interface UserRegistration {
  /** User's address */
  user_address: string;
  /** User's public key (Ed448 for signing) */
  user_public_key: string;
  /** User's peer public key */
  peer_public_key: string;
  /** Device registrations (usually just one) */
  device_registrations: DeviceRegistration[];
  /** Ed448 signature over the registration data (hex string) */
  signature: string;
}

export interface DirectoryEntry {
  space_address: string;
  name: string;
  description: string;
  icon: string;
  invite_link: string;
  category: string;
  status: string;
  submitted_at: number;
  reviewed_at?: number;
  member_count?: number;
}

export interface DirectoryResponse {
  entries: DirectoryEntry[];
  total: number;
  has_more: boolean;
}

import { getApiConfig } from './config';

interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeout?: number;
  headers?: Record<string, string>;
  /**
   * Optional hard cap on response body size in bytes. When set, the
   * response's Content-Length header is checked BEFORE the body is
   * consumed; oversized responses cause the call to throw a
   * `RESPONSE_TOO_LARGE` error code so the caller can decide whether
   * to surface or swallow it. Defends against RN's
   * BlobModule/okhttp OOMs when a server returns a huge body (e.g.
   * a user profile with an uncompressed multi-MB avatar inline).
   * Responses without a Content-Length header bypass the check.
   */
  maxResponseBytes?: number;
}

export class QuorumMobileClient implements QuorumApiClient {
  // Optional explicit override for tests / per-instance use. When unset, every
  // fetch resolves the URL dynamically via getApiConfig() so the dev-mode
  // toggle takes effect immediately without restarting the app.
  private explicitBaseUrl: string | undefined;
  private userAddress: string | null = null;
  private signMessage: ((message: string) => Promise<string>) | null = null;

  constructor(baseUrl?: string) {
    this.explicitBaseUrl = baseUrl;
  }

  private get baseUrl(): string {
    return this.explicitBaseUrl ?? getApiConfig().baseUrl;
  }

  setUserAddress(address: string): void {
    this.userAddress = address;
  }

  setSignMessage(signFn: (message: string) => Promise<string>): void {
    this.signMessage = signFn;
  }

  private async fetch<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
    const { method = 'GET', body, timeout = DEFAULT_TIMEOUT, headers = {}, maxResponseBytes } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          ...DEFAULT_HEADERS,
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorBody);
        } catch {
          errorData = { message: errorBody };
        }
        // Server uses {"error": "..."} consistently; fall back to that before HTTP code.
        throw Object.assign(new Error(errorData.message || errorData.error || `HTTP ${response.status}`), {
          status: response.status,
          code: errorData.code,
        });
      }

      // Size cap before body read so BlobModule doesn't materialize a
      // huge byte array. Bypassed on chunked responses where
      // Content-Length is absent.
      if (maxResponseBytes !== undefined) {
        const len = response.headers.get('content-length');
        if (len) {
          const parsed = parseInt(len, 10);
          if (Number.isFinite(parsed) && parsed > maxResponseBytes) {
            // Drain so the socket is released, but don't materialize.
            try { await response.text(); } catch { /* */ }
            throw Object.assign(new Error(`Response too large: ${parsed} > ${maxResponseBytes}`), {
              status: response.status,
              code: 'RESPONSE_TOO_LARGE',
            });
          }
        }
      }

      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        return response.json();
      }
      return response.text() as unknown as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw Object.assign(new Error('Request timeout'), {
          status: 408,
          code: 'TIMEOUT',
        });
      }
      throw error;
    }
  }

  // Spaces

  async fetchSpaces(): Promise<Space[]> {
    if (!this.userAddress) {
      throw new Error('User address not set');
    }
    const response = await this.fetch<{ spaces: Space[] }>(
      `/users/${this.userAddress}/spaces`
    );
    return response.spaces || [];
  }

  async fetchSpace(spaceId: string): Promise<Space> {
    return this.fetch<Space>(`/spaces/${spaceId}`);
  }

  async joinSpace(inviteCode: string): Promise<Space> {
    return this.fetch<Space>('/spaces/join', {
      method: 'POST',
      body: { inviteCode },
    });
  }

  // Messages

  /**
   * Fetch sealed hub-log entries for a given hub. Used by the iOS NSE
   * (via a Swift port of this call) and the Android background push
   * task to decrypt an incoming push payload and decide whether to
   * suppress the notification for control-type messages
   * (update-profile, edit-message, remove-message).
   *
   * Read-only, no auth — payloads are sealed HubSealedMessage JSON,
   * useless without the recipient's per-hub TR state. The push
   * payload carries the seq so callers fetch just the single entry
   * with `after = seq - 1, limit = 1`.
   */
  async fetchHubLog(params: {
    hubAddress: string;
    after?: number;
    limit?: number;
  }): Promise<Array<{ seq: number; ts: number; payload: string }>> {
    const queryParams = new URLSearchParams();
    if (params.after !== undefined) queryParams.set('after', params.after.toString());
    if (params.limit !== undefined) queryParams.set('limit', params.limit.toString());
    const query = queryParams.toString();
    const endpoint = `/hub/${params.hubAddress}/log${query ? `?${query}` : ''}`;
    return this.fetch<Array<{ seq: number; ts: number; payload: string }>>(endpoint);
  }

  async fetchMessages(params: {
    spaceId: string;
    channelId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ messages: Message[]; nextPageToken?: string }> {
    const queryParams = new URLSearchParams();
    if (params.cursor) queryParams.set('cursor', params.cursor);
    if (params.limit) queryParams.set('limit', params.limit.toString());

    const query = queryParams.toString();
    const endpoint = `/spaces/${params.spaceId}/channels/${params.channelId}/messages${query ? `?${query}` : ''}`;

    return this.fetch<{ messages: Message[]; nextPageToken?: string }>(endpoint);
  }

  async sendMessage(params: SendMessageParams): Promise<Message> {
    return this.fetch<Message>(
      `/spaces/${params.spaceId}/channels/${params.channelId}/messages`,
      {
        method: 'POST',
        body: {
          text: params.text,
          repliesToMessageId: params.repliesToMessageId,
        },
      }
    );
  }

  async editMessage(params: EditMessageParams): Promise<Message> {
    return this.fetch<Message>(
      `/spaces/${params.spaceId}/channels/${params.channelId}/messages/${params.messageId}`,
      {
        method: 'PATCH',
        body: { text: params.text },
      }
    );
  }

  async deleteMessage(params: DeleteMessageParams): Promise<void> {
    await this.fetch<void>(
      `/spaces/${params.spaceId}/channels/${params.channelId}/messages/${params.messageId}`,
      { method: 'DELETE' }
    );
  }

  // Reactions

  async addReaction(params: AddReactionParams): Promise<void> {
    await this.fetch<void>(
      `/spaces/${params.spaceId}/channels/${params.channelId}/messages/${params.messageId}/reactions`,
      {
        method: 'POST',
        body: { reaction: params.reaction },
      }
    );
  }

  async removeReaction(params: RemoveReactionParams): Promise<void> {
    await this.fetch<void>(
      `/spaces/${params.spaceId}/channels/${params.channelId}/messages/${params.messageId}/reactions/${encodeURIComponent(params.reaction)}`,
      { method: 'DELETE' }
    );
  }

  // Conversations

  async fetchConversations(): Promise<Conversation[]> {
    if (!this.userAddress) {
      throw new Error('User address not set');
    }
    const response = await this.fetch<{ conversations: Conversation[] }>(
      `/users/${this.userAddress}/conversations`
    );
    return response.conversations || [];
  }

  async createConversation(params: { address: string }): Promise<Conversation> {
    return this.fetch<Conversation>('/conversations', {
      method: 'POST',
      body: { address: params.address },
    });
  }

  async sendDirectMessage(params: SendDirectMessageParams): Promise<Message> {
    return this.fetch<Message>(
      `/conversations/${params.conversationId}/messages`,
      {
        method: 'POST',
        body: {
          text: params.text,
          repliesToMessageId: params.repliesToMessageId,
        },
      }
    );
  }

  async fetchDirectMessages(params: {
    conversationId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ messages: Message[]; nextPageToken?: string }> {
    const queryParams = new URLSearchParams();
    if (params.cursor) queryParams.set('cursor', params.cursor);
    if (params.limit) queryParams.set('limit', params.limit.toString());

    const query = queryParams.toString();
    const endpoint = `/conversations/${params.conversationId}/messages${query ? `?${query}` : ''}`;

    return this.fetch<{ messages: Message[]; nextPageToken?: string }>(endpoint);
  }

  // User Registration (E2E Encryption)

  // Short-TTL registration cache. Every DM operation (send, receipt, reaction,
  // edit, delete, embed) was re-fetching both users' registrations over the
  // network — measured at 0.5-3.7s per send. Registrations change only when a
  // device is added/removed, so a 5-minute TTL is safe; the trust model is
  // unchanged (a cached response is exactly as trustworthy as a fresh one from
  // the same server). Callers that MERGE into the registration before
  // re-uploading (device registration) must pass { fresh: true } — a stale
  // read there could drop another device's entry.
  private registrationCache = new Map<string, { reg: UserRegistration; ts: number }>();
  private static readonly REGISTRATION_TTL_MS = 5 * 60 * 1000;

  /**
   * Fetch a user's registration info for E2E encryption
   * Contains identity key, signed pre-key, and inbox address needed for X3DH
   *
   * @param opts.fresh - Bypass the TTL cache. REQUIRED for read-modify-write
   *                     flows (own-device registration).
   */
  async fetchUserRegistration(
    address: string,
    opts?: { fresh?: boolean }
  ): Promise<UserRegistration> {
    if (!opts?.fresh) {
      const cached = this.registrationCache.get(address);
      if (cached && Date.now() - cached.ts < QuorumMobileClient.REGISTRATION_TTL_MS) {
        return cached.reg;
      }
    }
    const reg = await this.fetch<UserRegistration>(`/users/${address}`);
    this.registrationCache.set(address, { reg, ts: Date.now() });
    return reg;
  }

  /** Drop cached registrations (all, or one address). */
  invalidateRegistrationCache(address?: string): void {
    if (address) {
      this.registrationCache.delete(address);
    } else {
      this.registrationCache.clear();
    }
  }

  /**
   * Register user's encryption keys for E2E messaging
   * Called after onboarding to publish keys so others can initiate encrypted conversations
   *
   * @param registration - Full UserRegistration structure matching server expectations
   */
  async uploadRegistration(registration: UserRegistration): Promise<void> {
    await this.fetch<void>(`/users/${registration.user_address}`, {
      method: 'POST',
      body: registration,
    });
    // Our own registration just changed — never serve the stale copy.
    this.invalidateRegistrationCache(registration.user_address);
  }

  /**
   * Delete messages from inbox after successful decryption
   * Uses Ed448 signature to authenticate the delete request
   *
   * @param params.inbox_address - The inbox address to delete messages from
   * @param params.timestamps - Array of message timestamps to delete
   * @param params.inbox_public_key - Ed448 public key for verification (hex)
   * @param params.inbox_signature - Ed448 signature of (inbox_address + timestamps) (hex)
   */
  async deleteInboxMessages(params: {
    inbox_address: string;
    timestamps: number[];
    inbox_public_key: string;
    inbox_signature: string;
  }): Promise<void> {
    await this.fetch<void>('/inbox/delete', {
      method: 'POST',
      body: params,
    });
  }

  async registerPushToken(params: {
    inbox_address: string;
    inbox_public_key: string;
    expo_token: string;
    platform: 'ios' | 'android';
    farcaster_fid?: number;
    timestamp: number;
    inbox_signature: string;
  }): Promise<void> {
    await this.fetch<void>('/push/register', { method: 'POST', body: params });
  }

  async unregisterPushToken(params: {
    inbox_address: string;
    inbox_public_key: string;
    expo_token: string;
    timestamp: number;
    inbox_signature: string;
  }): Promise<void> {
    await this.fetch<void>('/push/unregister', { method: 'POST', body: params });
  }

  /**
   * Sync notification preferences for a push token so the server can
   * filter ALERT pushes before they reach the device (device-local
   * checks can't suppress OS-rendered lock-screen notifications).
   *
   * Server contract (POST /push/prefs):
   *   { expo_token, inbox_address, inbox_public_key,
   *     inbox_signature: <hex ed448>, timestamp: <unix ms>,
   *     enabled, muted_hubs: [<hub_address>, ...] }
   *
   * Signature is Ed448 over:
   *   "push-prefs" || expo_token || (0x01 if enabled else 0x00)
   *     || mutedHubsSorted.join(',') || be64(timestamp)
   * with muted_hubs sorted ascending (plain string sort) before joining.
   * The signing key is a registered inbox's Ed448 key, same as
   * registerPushToken.
   */
  async postPushPrefs(params: {
    expo_token: string;
    inbox_address: string;
    inbox_public_key: string;
    inbox_signature: string;
    timestamp: number;
    enabled: boolean;
    muted_hubs: string[];
  }): Promise<void> {
    await this.fetch<void>('/push/prefs', { method: 'POST', body: params });
  }

  // Pinning

  async pinMessage(params: {
    spaceId: string;
    channelId: string;
    messageId: string;
  }): Promise<void> {
    await this.fetch<void>(
      `/spaces/${params.spaceId}/channels/${params.channelId}/messages/${params.messageId}/pin`,
      { method: 'POST' }
    );
  }

  async unpinMessage(params: {
    spaceId: string;
    channelId: string;
    messageId: string;
  }): Promise<void> {
    await this.fetch<void>(
      `/spaces/${params.spaceId}/channels/${params.channelId}/messages/${params.messageId}/pin`,
      { method: 'DELETE' }
    );
  }

  // User Config (E2E Encrypted Settings Sync)

  /**
   * Remote user config response from server
   * Contains encrypted config, timestamp, and signature for verification
   */
  /**
   * Fetch user's encrypted config from server
   * Returns encrypted user config, timestamp, and Ed448 signature for verification
   *
   * Config is encrypted with AES-GCM using SHA-512(user_private_key)[0:32] as key
   * Signature is Ed448 over (encrypted_config + timestamp_bytes)
   *
   * @param address - User's address
   * @returns Remote config or null if not found (404)
   */
  async getUserSettings(address: string): Promise<{
    user_config: string;
    timestamp: number;
    signature: string;
  } | null> {
    try {
      return await this.fetch<{
        user_config: string;
        timestamp: number;
        signature: string;
      }>(`/users/${address}/config`);
    } catch (error: unknown) {
      // 404 is expected for new users who haven't synced config yet
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Upload user's encrypted config to server
   * Config must be encrypted with AES-GCM and signed with Ed448
   *
   * @param address - User's address
   * @param payload - Encrypted config with signature
   * @param payload.user_address - User's address
   * @param payload.user_public_key - Ed448 public key (hex)
   * @param payload.user_config - Encrypted config (hex ciphertext + IV)
   * @param payload.timestamp - Unix timestamp
   * @param payload.signature - Ed448 signature (hex)
   */
  async postUserSettings(
    address: string,
    payload: {
      user_address: string;
      user_public_key: string;
      user_config: string;
      timestamp: number;
      signature: string;
    }
  ): Promise<{ status: string }> {
    return this.fetch<{ status: string }>(`/users/${address}/config`, {
      method: 'POST',
      body: payload,
    });
  }

  // Space Registration

  /**
   * Register a new space
   * Creates the space registration on the server
   *
   * @param spaceAddress - Space address
   * @param registration - Space registration data with signatures
   */
  async postSpace(
    spaceAddress: string,
    registration: {
      space_address: string;
      space_public_key: string;
      space_signature: string;
      config_public_key: string;
      owner_public_keys: string[];
      owner_signatures: string[];
      timestamp: number;
    }
  ): Promise<{ status: string }> {
    return this.fetch<{ status: string }>(`/spaces/${spaceAddress}`, {
      method: 'POST',
      body: registration,
    });
  }

  // Space Manifest

  /**
   * Fetch space registration (public info about a space)
   * Used to verify owner signatures on space-manifest updates
   *
   * @param spaceAddress - Space address
   * @returns Space registration with owner public keys
   */
  async getSpaceRegistration(spaceAddress: string): Promise<{
    space_address: string;
    space_public_key: string;
    space_signature: string;
    config_public_key: string;
    owner_public_keys: string[];
    owner_signatures: string[];
    timestamp: number;
  }> {
    return this.fetch<{
      space_address: string;
      space_public_key: string;
      space_signature: string;
      config_public_key: string;
      owner_public_keys: string[];
      owner_signatures: string[];
      timestamp: number;
    }>(`/spaces/${spaceAddress}`);
  }

  /**
   * Fetch space manifest (encrypted space metadata)
   * Used to decrypt space info when syncing from config
   *
   * @param spaceAddress - Space address
   * @returns Encrypted manifest with ephemeral key
   */
  async getSpaceManifest(spaceAddress: string): Promise<{
    space_address: string;
    space_manifest: string;
    ephemeral_public_key: string;
  }> {
    return this.fetch<{
      space_address: string;
      space_manifest: string;
      ephemeral_public_key: string;
    }>(`/spaces/${spaceAddress}/manifest`);
  }

  /**
   * Upload space manifest
   *
   * @param spaceAddress - Space address
   * @param manifest - Encrypted manifest data with owner signature
   */
  async postSpaceManifest(
    spaceAddress: string,
    manifest: {
      space_address: string;
      space_manifest: string;
      ephemeral_public_key: string;
      timestamp?: number;
      owner_public_key?: string;
      owner_signature?: string;
    }
  ): Promise<{ status: string }> {
    return this.fetch<{ status: string }>(`/spaces/${spaceAddress}/manifest`, {
      method: 'POST',
      body: manifest,
    });
  }

  // Hub Operations

  /**
   * Add inbox to hub for receiving space messages
   * Called when joining a space to subscribe to hub updates
   *
   * @param params - Hub control message with signatures
   */
  async postHubAdd(params: {
    hub_address: string;
    hub_public_key: string;
    hub_signature: string;
    inbox_public_key: string;
    inbox_signature: string;
  }): Promise<{ status: string }> {
    return this.fetch<{ status: string }>('/hub/add', {
      method: 'POST',
      body: params,
    });
  }

  /**
   * Remove inbox from hub
   *
   * @param params - Hub control message with signatures
   */
  async postHubDelete(params: {
    hub_address: string;
    hub_public_key: string;
    hub_signature: string;
    inbox_public_key: string;
    inbox_signature: string;
  }): Promise<{ status: string }> {
    return this.fetch<{ status: string }>('/hub/delete', {
      method: 'POST',
      body: params,
    });
  }

  /**
   * Send a sealed message to the hub
   * Used for sending encrypted space messages
   *
   * @param message - Sealed hub message
   */
  async postHub(message: {
    hub_address: string;
    sealed_message: string;
  }): Promise<{ status: string }> {
    return this.fetch<{ status: string }>('/hub', {
      method: 'POST',
      body: message,
    });
  }

  // Public Invite Links

  /**
   * Upload public invite evaluations
   * Used for generating public invite links with reusable evaluations
   *
   * @param params - Invite evaluations with signatures
   */
  async postInviteEvals(params: {
    space_address: string;
    config_public_key: string;
    space_evals: string[];
    ephemeral_public_key: string;
    owner_public_key: string;
    owner_signature: string;
  }): Promise<{ status: string }> {
    return this.fetch<{ status: string }>('/invite/evals', {
      method: 'POST',
      body: params,
    });
  }

  /**
   * Fetch a public invite evaluation
   * Used when joining via a public invite link.
   *
   * Returns the encrypted eval payload AND the ephemeral pubkey it was
   * encrypted under. The eph key is what makes joins survive manifest
   * rotations — broadcastSpaceUpdate (kicks, role grants, settings edits)
   * regenerates the manifest with a fresh ephemeral key and overwrites
   * it on the server, but evals stay put. Decoupling the two lets the
   * joiner decrypt the eval with the right key regardless of how many
   * times the manifest has been rotated since it was uploaded.
   *
   * Backwards compat: legacy server returned a bare JSON string
   * (the ciphertext envelope). New server returns an object. We accept
   * both shapes; when only the ciphertext is returned, callers fall
   * back to the manifest's ephemeral pubkey.
   *
   * @param configPublicKey - The config public key for this invite
   * @returns Eval payload + (optional) ephemeral pubkey, or null if 404
   */
  async getInviteEval(configPublicKey: string): Promise<
    { ciphertext: string; ephemeralPublicKey: string | null } | null
  > {
    try {
      const response = await this.fetch<unknown>('/invite/eval', {
        method: 'POST',
        body: configPublicKey,
        headers: {
          'Content-Type': 'text/plain',
        },
      });
      if (typeof response === 'string') {
        return { ciphertext: response, ephemeralPublicKey: null };
      }
      if (response && typeof response === 'object' && 'ciphertext' in response) {
        const obj = response as { ciphertext: string; ephemeral_public_key?: string };
        return {
          ciphertext: obj.ciphertext,
          ephemeralPublicKey: obj.ephemeral_public_key ?? null,
        };
      }
      return null;
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // Moderation reports — see services/reporting/reportService.ts for the
  // full payload shape. The body is opaque to this client beyond having
  // the right top-level fields; the service module builds and signs it.
  async postReport(report: Record<string, unknown>): Promise<{ status: string; id: string }> {
    return this.fetch('/reports', {
      method: 'POST',
      body: report,
    });
  }

  // Public profile (plaintext, signed by user — gated client-side on
  // isProfilePublic). Used as a fallback when an in-space update-profile
  // hasn't reached this client yet, e.g. for users we share spaces with
  // but joined before they set their profile.

  async getPublicProfile(address: string): Promise<{
    display_name: string;
    profile_image: string;
    bio: string;
    primary_username?: string;
    timestamp: number;
    signature: string;
    farcaster?: {
      fid: number;
      custodyAddress: string;
      farcasterSignature: string;
      quorumSignature: string;
    };
  } | null> {
    try {
      return await this.fetch(`/users/${address}/public-profile`, {
        // 2MB cap. A well-formed profile after avatar compression
        // is <250KB. Anything bigger is a pre-fix user whose avatar
        // was uploaded uncompressed; surface as "no profile" rather
        // than OOM the JVM heap on the read path.
        maxResponseBytes: 2 * 1024 * 1024,
      });
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
        return null;
      }
      // Same fallthrough for oversized — treat as no profile rather
      // than propagating to the caller (which would surface a
      // visible error toast for what should be a soft fallback).
      if (error && typeof error === 'object' && 'code' in error && error.code === 'RESPONSE_TOO_LARGE') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Reverse-resolve a Farcaster fid to the linked Quorum identity.
   * Returns the address + the linked user's public profile in one round
   * trip so the caller can render display name / avatar / QNS name
   * without a second fetch.
   *
   * The mapping is server-maintained from the `farcaster-fid/<fid>`
   * index, written whenever a user posts a public profile with a
   * Farcaster link whose Quorum-side signature verifies. Returns null
   * (not throw) on 404 — the common case when looking up a Farcaster
   * user who hasn't linked their Quorum identity, which we want to
   * silently fall through to "no badge."
   */
  async getUserByFarcasterFid(fid: number): Promise<{
    address: string;
    public_profile: {
      display_name: string;
      profile_image: string;
      bio: string;
      primary_username?: string;
      timestamp: number;
      signature: string;
      farcaster?: {
        fid: number;
        custodyAddress: string;
        farcasterSignature: string;
        quorumSignature: string;
      };
    };
  } | null> {
    try {
      return await this.fetch(`/users/by-fid/${fid}`, {
        maxResponseBytes: 2 * 1024 * 1024,
      });
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
        return null;
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'RESPONSE_TOO_LARGE') {
        return null;
      }
      throw error;
    }
  }

  async postPublicProfile(
    address: string,
    profile: {
      display_name: string;
      profile_image: string;
      bio: string;
      primary_username?: string;
      timestamp: number;
      signature: string;
      farcaster?: {
        fid: number;
        custodyAddress: string;
        farcasterSignature: string;
        quorumSignature: string;
      };
    },
  ): Promise<{ status: string }> {
    return this.fetch(`/users/${address}/public-profile`, {
      method: 'POST',
      body: profile,
    });
  }

  async deletePublicProfile(
    address: string,
    body: { timestamp: number; signature: string },
  ): Promise<{ status: string }> {
    return this.fetch(`/users/${address}/public-profile`, {
      method: 'DELETE',
      body,
    });
  }

  // Directory

  async exploreSpaces(params?: {
    search?: string;
    category?: string;
    offset?: number;
    limit?: number;
  }): Promise<DirectoryResponse> {
    const queryParts: string[] = [];
    if (params?.search) queryParts.push(`search=${encodeURIComponent(params.search)}`);
    if (params?.category) queryParts.push(`category=${encodeURIComponent(params.category)}`);
    if (params?.offset !== undefined) queryParts.push(`offset=${params.offset}`);
    if (params?.limit !== undefined) queryParts.push(`limit=${params.limit}`);
    const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    return this.fetch<DirectoryResponse>(`/directory${query}`);
  }

  async reportSpace(spaceAddress: string, reason: string): Promise<void> {
    await this.fetch<{ status: string }>(`/directory/${spaceAddress}/report`, {
      method: 'POST',
      body: { reason },
    });
  }

  // Quorum Apex (subscriptions)
  //
  // NOTE: every endpoint in this section is NEW server work — the
  // quorum-api routes don't exist yet. The doc comment on each method is
  // the server contract the backend needs to implement. Client-side
  // callers (hooks/useApex.ts) degrade gracefully on 404 so the app keeps
  // working before the server ships.

  /**
   * Publish a space's Apex config — the token the owner accepts for Apex
   * subscriptions and the Ethereum address subscription payouts go to.
   *
   * Server contract: POST /spaces/{spaceAddress}/apex-config
   * Body: { token: 'wQUIL'|'SNAP'|'USDC', payout_address: '0x…' (20-byte
   * hex), timestamp: number (unix ms), owner_public_key: hex,
   * owner_signature: hex Ed448 }. The signature covers the UTF-8 bytes of
   * `apex-config:{spaceAddress}:{token}:{lowercase payout_address}:{timestamp}`
   * (built by services/apex/apexSpaceConfig.ts). The server MUST verify:
   * (1) owner_public_key matches the space registration's owner key,
   * (2) the Ed448 signature is valid over the rebuilt canonical message,
   * (3) timestamp is recent (e.g. within 10 minutes) to prevent replaying
   * an old config. Upsert on success. Returns { status: 'ok' }.
   */
  async setSpaceApexConfig(
    spaceAddress: string,
    config: {
      token: 'wQUIL' | 'SNAP' | 'USDC';
      payout_address: string;
      timestamp: number;
      owner_public_key: string;
      owner_signature: string;
    }
  ): Promise<{ status: string }> {
    return this.fetch<{ status: string }>(`/spaces/${spaceAddress}/apex-config`, {
      method: 'POST',
      body: config,
    });
  }

  /**
   * Fetch a space's Apex config, or null if the owner hasn't published
   * one (404).
   *
   * Server contract: GET /spaces/{spaceAddress}/apex-config →
   * { token: 'wQUIL'|'SNAP'|'USDC', payout_address: '0x…',
   *   subscriber_count?: number } | 404.
   * subscriber_count = number of DISTINCT subscribers with an active
   * (period_end in the future) subscription that includes this space in
   * at least one slot. Optional so older servers stay compatible.
   */
  async getSpaceApexConfig(spaceAddress: string): Promise<{
    token: 'wQUIL' | 'SNAP' | 'USDC';
    payout_address: string;
    subscriber_count?: number;
  } | null> {
    try {
      return await this.fetch<{
        token: 'wQUIL' | 'SNAP' | 'USDC';
        payout_address: string;
        subscriber_count?: number;
      }>(`/spaces/${spaceAddress}/apex-config`);
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Register a paid Apex subscription after the splitter transaction is
   * sent. The server should verify the tx on-chain (ApexPayment event
   * from the splitter: payer, token, amountEach, 5 recipients with
   * recipients[0] = the Q Inc registry address) before marking the
   * subscriber active for the period.
   *
   * Server contract: POST /apex/subscriptions
   * Body: { address (Quorum address), tx_hash, chain_id, token,
   * amount_each (decimal string of token base units), space_addresses
   * (the 4 chosen slots — REPEATS ARE ALLOWED: a subscriber may assign
   * multiple or all four slots to one space; the server must NOT enforce
   * distinctness, only that each slot's space has a matching apex-config
   * payout in the verified event's recipients), period_start, period_end
   * (unix ms) }. Returns { status: 'ok' }. The chosen space_addresses are
   * locked for the period; a renewal payment (new POST) may change them.
   *
   * Amount verification: the server must check the event's amountEach
   * against the CURRENT MARKET exchange rate — USDC pegged at $1, wQUIL
   * and SNAP from DexScreener's Ethereum pair priceUsd (the same source
   * the client quotes from: GET api.dexscreener.com/latest/dex/tokens/
   * {tokenAddress}), NOT the QNS pricing API's internal rate. Require
   * amountEach >= ($25/5)-equivalent at verification time with a tolerance
   * band (e.g. accept >= 90%) to absorb price drift between the client's
   * quote and on-chain confirmation.
   */
  async registerApexSubscription(params: {
    address: string;
    tx_hash: string;
    chain_id: number;
    token: 'wQUIL' | 'SNAP' | 'USDC';
    amount_each: string;
    space_addresses: string[];
    period_start: number;
    period_end: number;
  }): Promise<{ status: string }> {
    return this.fetch<{ status: string }>('/apex/subscriptions', {
      method: 'POST',
      body: params,
    });
  }

  /**
   * Fetch a user's current Apex subscription, or null if they've never
   * subscribed / the record expired out (404).
   *
   * Server contract: GET /apex/subscriptions/{address} →
   * { address, token, tx_hash, space_addresses: string[], period_start,
   * period_end, subscribed_since } | 404. Timestamps are unix ms;
   * subscribed_since is the period_start of the user's first-ever
   * subscription (for "member since" display).
   */
  async getApexSubscription(address: string): Promise<{
    address: string;
    token: 'wQUIL' | 'SNAP' | 'USDC';
    tx_hash: string;
    space_addresses: string[];
    period_start: number;
    period_end: number;
    subscribed_since: number;
  } | null> {
    try {
      return await this.fetch<{
        address: string;
        token: 'wQUIL' | 'SNAP' | 'USDC';
        tx_hash: string;
        space_addresses: string[];
        period_start: number;
        period_end: number;
        subscribed_since: number;
      }>(`/apex/subscriptions/${address}`);
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Bulk Apex-active lookup for rendering the gold subscriber ring.
   * Either or both of addresses (Quorum addresses, for chat) and fids
   * (Farcaster fids, for the feed — resolved server-side via the
   * farcaster-fid index) may be provided.
   *
   * Server contract: GET /apex/status?addresses=a,b&fids=1,2 →
   * { active_addresses: string[], active_fids: number[] } — the subsets
   * of the queried ids whose subscription period_end is in the future.
   */
  async getApexStatuses(params: {
    addresses?: string[];
    fids?: number[];
  }): Promise<{ active_addresses: string[]; active_fids: number[] }> {
    const queryParts: string[] = [];
    if (params.addresses?.length) {
      queryParts.push(`addresses=${params.addresses.map(encodeURIComponent).join(',')}`);
    }
    if (params.fids?.length) {
      queryParts.push(`fids=${params.fids.join(',')}`);
    }
    const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    return this.fetch<{ active_addresses: string[]; active_fids: number[] }>(
      `/apex/status${query}`
    );
  }
}

// Singleton instance
let quorumClient: QuorumMobileClient | null = null;

export function getQuorumClient(): QuorumMobileClient {
  if (!quorumClient) {
    quorumClient = new QuorumMobileClient();
  }
  return quorumClient;
}
