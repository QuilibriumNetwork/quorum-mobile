import { reportFarcasterAuthFailure } from './farcaster/authTokenEvents';
import { FARCASTER_CLIENT_URL, FARCASTER_SITE_HEADERS, getDirectCastToken } from './farcaster/directCastAuth';
import { stripImageMetadata } from '../utils/stripImageMetadata';

const FARCASTER_BASE_URL = 'https://client.farcaster.xyz';

// Warpcast Wallet API

// Recovery key needed to decrypt the Privy-managed embedded wallet.
export async function fetchWalletRecoveryKey(token: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${FARCASTER_BASE_URL}/v2/wallet/resource`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          origin: 'https://farcaster.xyz',
          referer: 'https://farcaster.xyz/',
        },
        body: JSON.stringify({ name: 'warpcast_wallet_recovery_encryption_key' }),
      }
    );

    if (!response.ok) {
      return null;
    }

    const json = await response.json();
    return json.result?.resource?.value ?? null;
  } catch (error) {
    return null;
  }
}

// Detects Warpcast wallet via 'warpcastWallet' label on verifications.
export async function checkWarpcastWallet(token: string, fid: number): Promise<{ hasWallet: boolean; address?: string }> {
  try {
    const fidInt = Math.floor(Number(fid));
    if (!fidInt || isNaN(fidInt)) {
      return { hasWallet: false };
    }

    // Add timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 10000);

    // Fetch user's verifications and look for warpcastWallet label
    const response = await fetch(
      `${FARCASTER_BASE_URL}/v2/verifications?fid=${fidInt}&limit=100`,
      {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'authorization': `Bearer ${token}`,
        },
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);
    if (!response.ok) {
      const text = await response.text();
      return { hasWallet: false };
    }

    const json = await response.json();
    const verifications = json.result?.verifications ?? [];

    // Look for a verification with the 'warpcastWallet' label that is an Ethereum address
    // Privy creates both ETH and Solana wallets, we only want the ETH one
    const warpcastWalletVerification = verifications.find(
      (v: { labels?: string[]; address?: string }) => {
        const hasLabel = v.labels?.includes('warpcastWallet');
        // Ethereum addresses start with 0x and are 42 chars (0x + 40 hex)
        const isEthAddress = v.address?.startsWith('0x') && v.address?.length === 42;
        return hasLabel && isEthAddress;
      }
    );

    if (warpcastWalletVerification) {
      return {
        hasWallet: true,
        address: warpcastWalletVerification.address,
      };
    }
    return { hasWallet: false };
  } catch (error: unknown) {
    // AbortError or network failure — return no wallet
    return { hasWallet: false };
  }
}

export async function reportWalletExportInitiated(token: string, address: string): Promise<void> {
  try {
    await fetch(`${FARCASTER_BASE_URL}/v2/wallet-export-initiate`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        origin: 'https://farcaster.xyz',
        referer: 'https://farcaster.xyz/',
      },
      body: JSON.stringify({ address }),
    });
  } catch (error) {
    // Non-critical, just log
  }
}

async function safeReadError(response: Response) {
  try {
    const data = await response.json();
    // farcaster.xyz answers errors as { errors: [{ message }] }.
    return data?.errors?.[0]?.message || data?.message || data?.error;
  } catch {
    return null;
  }
}

// Direct Cast (DM) API
//
// The same calls as Quilcast: the inbox, conversations, messages, mark-read and
// sending text (with replies) use the direct-cast token
// (`farcaster/directCastAuth.ts`). A message with an image and reactions go
// through the session token and the older endpoints, as farcaster.xyz's own
// client does. New messages arrive over the socket (`farcaster/directCastSocket.ts`).

export interface DirectCastUser {
  fid: number;
  username?: string;
  displayName: string;
  pfp?: { url: string };
}

export interface DirectCastMessage {
  conversationId: string;
  senderFid: number;
  messageId: string;
  serverTimestamp: number;
  type: 'text' | 'group_name_change' | 'group_membership_addition' | 'group_membership_removal';
  message: string;
  hasMention: boolean;
  reactions: { reaction: string; count: number }[];
  inReplyTo?: DirectCastMessage;
  isPinned: boolean;
  isDeleted: boolean;
  senderContext: {
    fid: number;
    username?: string;
    displayName: string;
    pfp?: { url: string };
  };
  // The target user for membership changes (who was added/removed)
  actionTargetUserContext?: {
    fid: number;
    username?: string;
    displayName: string;
    pfp?: { url: string };
  };
  viewerContext?: {
    reactions: string[];
  };
}

export interface DirectCastConversation {
  conversationId: string;
  name?: string;
  photoUrl?: string;
  /** Not always in the inbox; `/v2/direct-cast-conversation` has it. */
  participants?: DirectCastUser[];
  lastMessage?: DirectCastMessage;
  isGroup: boolean;
  /** Older responses only; the inbox has `viewerContext.unreadCount`. */
  unreadCount?: number;
  /** Older responses only; the inbox has `viewerContext.muted`. */
  muted?: boolean;
  viewerContext: {
    category: 'default' | 'archived' | 'request';
    lastReadAt?: number;
    unreadCount?: number;
    muted?: boolean;
    counterParty?: DirectCastUser;
  };
}

/** A 1:1 conversation's id is the two FIDs, sorted: `<fid>-<fid>`. */
export function isOneToOneConversationId(conversationId: string): boolean {
  return /^\d+-\d+$/.test(conversationId);
}

/**
 * One direct-cast call with the direct-cast token. A 401 means the token was
 * rejected: it's replaced and the call made once more.
 */
async function directCastCall<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const attempt = async (token: string) =>
    fetch(`${FARCASTER_CLIENT_URL}${path}`, {
      method: init.method ?? 'GET',
      // A cancelled query stops downloading, rather than finishing in the
      // background while its replacement downloads the same thing.
      signal: init.signal,
      headers: {
        ...FARCASTER_SITE_HEADERS,
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined && {
          'content-type': 'application/json; charset=utf-8',
          'idempotency-key': newIdempotencyKey(),
        }),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  const token = await getDirectCastToken();
  if (!token) throw new Error("Couldn't open your messages");
  let response = await attempt(token);
  if (response.status === 401) {
    const fresh = await getDirectCastToken({ fresh: true });
    if (fresh) response = await attempt(fresh);
  }
  if (!response.ok) {
    const message = await safeReadError(response);
    throw new Error(message || `Direct casts: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json().catch(() => ({}))) as T;
}

function newIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The inbox (the default category: no requests or archived), newest first. */
export async function getDirectCastConversations({
  cursor,
  limit = 100,
  signal,
}: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{
  conversations: DirectCastConversation[];
  nextCursor?: string;
  requestsCount: number;
}> {
  const params = new URLSearchParams({ category: 'default', limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const json = await directCastCall<{
    result?: { conversations?: DirectCastConversation[]; requestsCount?: number };
    next?: { cursor?: string };
  }>(`/v2/direct-cast-inbox?${params}`, { signal });
  return {
    conversations: json.result?.conversations ?? [],
    nextCursor: json.next?.cursor,
    requestsCount: json.result?.requestsCount ?? 0,
  };
}

/** One conversation, with its participants. */
export async function getDirectCastConversation(conversationId: string): Promise<DirectCastConversation | null> {
  const json = await directCastCall<{ result?: { conversation?: DirectCastConversation } }>(
    `/v2/direct-cast-conversation?${new URLSearchParams({ conversationId })}`,
  );
  return json.result?.conversation ?? null;
}

export async function getDirectCastMessages({
  conversationId,
  cursor,
  limit = 50,
  signal,
}: {
  conversationId: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<{
  messages: DirectCastMessage[];
  nextCursor?: string;
}> {
  const params = new URLSearchParams({ conversationId, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const json = await directCastCall<{
    result?: { messages?: DirectCastMessage[] };
    next?: { cursor?: string };
  }>(`/v2/direct-cast-conversation-messages?${params}`, { signal });
  return {
    messages: json.result?.messages ?? [],
    nextCursor: json.next?.cursor,
  };
}

// Metadata structure for images in direct casts
export interface DirectCastMessageMetadata {
  medias?: {
    height: number;
    width: number;
    staticRaster: string; // The image URL
    version: string; // '2'
  }[];
}

/**
 * Send a text message (or a reply) through `/fc/message`: a group by its id,
 * a 1:1 by the other person's FID. Resolves farcaster.xyz's id for it.
 */
export async function sendDirectCast({
  conversationId,
  isGroup,
  recipientFid,
  message,
  inReplyToId,
}: {
  conversationId: string;
  isGroup: boolean;
  /** The other person in a 1:1. */
  recipientFid?: number;
  message: string;
  inReplyToId?: string;
}): Promise<{ messageId?: string }> {
  if (!isGroup && !recipientFid) throw new Error('No recipient for this message');
  const json = await directCastCall<{ result?: { messageId?: string } }>('/fc/message', {
    method: 'PUT',
    body: {
      ...(isGroup ? { groupId: conversationId } : { recipientFid }),
      message,
      ...(inReplyToId && { inReplyToId }),
    },
  });
  return { messageId: json.result?.messageId };
}

/**
 * Send a message with an image: `/v2/direct-cast-send` with the session token,
 * which is how farcaster.xyz sends media.
 */
export async function sendDirectCastWithMedia({
  token,
  conversationId,
  recipientFids,
  message,
  inReplyToId,
  metadata,
}: {
  token: string;
  conversationId: string;
  recipientFids: number[];
  message: string;
  inReplyToId?: string;
  metadata: DirectCastMessageMetadata;
}): Promise<{ success: boolean }> {
  // Generate UUID manually since crypto.randomUUID may not be available in RN
  const messageId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

  const body: Record<string, unknown> = {
    type: 'text',
    conversationId,
    recipientFids,
    messageId,
    message,
    metadata,
  };
  if (inReplyToId) {
    body.inReplyToId = inReplyToId;
  }

  const response = await fetch(`${FARCASTER_BASE_URL}/v2/direct-cast-send`, {
    method: 'PUT',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': newIdempotencyKey(),
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    reportSessionRejection(response);
    const errorMessage = await safeReadError(response);
    throw new Error(errorMessage || `Failed to send direct cast (${response.status})`);
  }

  const result = await response.json();
  return { success: result.result?.success ?? true };
}

export async function markDirectCastRead({ conversationId }: { conversationId: string }): Promise<void> {
  await directCastCall('/v2/direct-cast-mark-read', { method: 'POST', body: { conversationId } });
}

/** A rejected session token is refreshed in the background (authTokenEvents). */
function reportSessionRejection(response: Response) {
  if (response.status === 401 || response.status === 403) reportFarcasterAuthFailure();
}

interface DirectCastReactionParams {
  token: string;
  conversationId: string;
  messageId: string;
  reaction: string;
}

// Reactions take the session token, as on farcaster.xyz.
export async function addDirectCastReaction({
  token,
  conversationId,
  messageId,
  reaction,
}: DirectCastReactionParams): Promise<void> {
  const idempotencyKey = newIdempotencyKey();

  const response = await fetch(`${FARCASTER_BASE_URL}/v2/direct-cast-message-reaction`, {
    method: 'PUT',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({ conversationId, messageId, reaction }),
  });

  if (!response.ok) {
    reportSessionRejection(response);
    const errorMessage = await safeReadError(response);
    throw new Error(errorMessage || `Failed to add reaction (${response.status})`);
  }
}

export async function removeDirectCastReaction({
  token,
  conversationId,
  messageId,
  reaction,
}: DirectCastReactionParams): Promise<void> {
  const idempotencyKey = newIdempotencyKey();

  const response = await fetch(`${FARCASTER_BASE_URL}/v2/direct-cast-message-reaction`, {
    method: 'DELETE',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({ conversationId, messageId, reaction }),
  });

  if (!response.ok) {
    reportSessionRejection(response);
    const errorMessage = await safeReadError(response);
    throw new Error(errorMessage || `Failed to remove reaction (${response.status})`);
  }
}

// Image Upload API

interface GenerateImageUploadUrlParams {
  token: string;
}

interface ImageUploadUrlResponse {
  url: string;
}

export async function getImageUploadUrl({
  token,
}: GenerateImageUploadUrlParams): Promise<ImageUploadUrlResponse | undefined> {
  const response = await fetch(`${FARCASTER_BASE_URL}/v1/generate-image-upload-url`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    reportSessionRejection(response);
    const errorMessage = await safeReadError(response);
    throw new Error(errorMessage || `Failed to get image upload URL (${response.status})`);
  }

  const json = await response.json();
  return json.result;
}

interface UploadImageParams {
  uploadUrl: string;
  uri: string;
  name?: string;
  mimeType?: string;
}

interface CloudflareUploadResponse {
  success: boolean;
  result: {
    variants: string[];
  };
}

export async function uploadImageToCloudflare({
  uploadUrl,
  uri,
  name = 'direct-cast-image',
  mimeType = 'image/jpeg',
}: UploadImageParams): Promise<string | undefined> {
  // Strip EXIF (e.g. GPS location) before the image leaves the device.
  const safeUri = await stripImageMetadata(uri, mimeType);

  const file = {
    uri: safeUri,
    type: mimeType,
    name,
  };

  const formData = new FormData();
  // @ts-ignore - React Native FormData accepts file objects differently
  formData.append('file', file);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload image to Cloudflare (${response.status})`);
  }

  const json: CloudflareUploadResponse = await response.json();

  if (!json.success || !json.result?.variants) {
    throw new Error('Cloudflare upload failed');
  }

  // Find the original variant URL
  const originalUrl = json.result.variants.find((v) => v.endsWith('/original'));

  if (!originalUrl) {
    throw new Error('Original image variant not found');
  }

  return originalUrl;
}

/*
 * Convenience function to upload an image (get URL + upload)
 */
export async function uploadFarcasterImage({
  token,
  uri,
  name,
  mimeType,
}: {
  token: string;
  uri: string;
  name?: string;
  mimeType?: string;
}): Promise<string | undefined> {
  const urlResponse = await getImageUploadUrl({ token });
  if (!urlResponse?.url) {
    throw new Error('Failed to get upload URL');
  }

  return uploadImageToCloudflare({
    uploadUrl: urlResponse.url,
    uri,
    name,
    mimeType,
  });
}

// Image Upload API

interface ImageUploadUrlResponse {
  url: string;
  optimisticImageId: string;
}

/** Shape returned by Cloudflare Images when you POST a file to a
 *  direct-creator-upload URL. `variants[]` contains the public URLs
 *  for each named variant configured on the account; we use the one
 *  ending in `/original`. */
interface CloudflareImageUploadResponse {
  success: boolean;
  result?: { variants?: string[] };
}

export async function generateImageUploadUrl(token: string): Promise<ImageUploadUrlResponse> {
  const response = await fetch(`${FARCASTER_BASE_URL}/v1/generate-image-upload-url`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const message = await safeReadError(response);
    throw new Error(message || `Failed to generate image upload URL (${response.status})`);
  }

  const json = await response.json();
  return json.result;
}

export interface UploadedImage {
  /** The CDN URL to use as embed */
  url: string;
  /** Local URI for preview */
  localUri: string;
}

export async function uploadImageForCast(
  token: string,
  localUri: string,
  mimeType: string = 'image/jpeg'
): Promise<UploadedImage> {
  // Step 1: ask farcaster for a Cloudflare direct-creator-upload URL.
  // The response also carries `optimisticImageId` which lets us paint
  // the image in the composer before the upload completes, but the
  // CDN URL we hand to the cast embed comes from step 2.
  const { url: uploadUrl } = await generateImageUploadUrl(token);

  // Strip EXIF (e.g. GPS location) before the image leaves the device.
  const safeUri = await stripImageMetadata(localUri, mimeType);

  const formData = new FormData();
  formData.append('file', {
    uri: safeUri,
    type: mimeType,
    name: `image_${Date.now()}.${mimeType.split('/')[1] || 'jpg'}`,
  } as unknown as Blob);

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    body: formData,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload image (${uploadResponse.status})`);
  }

  // Step 2: read the variant URL Cloudflare returns. The account hash
  // is baked into the upload URL itself, so reading the response
  // avoids hard-coding it (and quietly breaking when the upstream
  // account rotates).
  const json = (await uploadResponse.json()) as CloudflareImageUploadResponse;
  if (!json.success || !json.result?.variants?.length) {
    throw new Error('Cloudflare image upload returned no variants');
  }
  const originalVariant = json.result.variants.find((v) => v.endsWith('/original'))
    ?? json.result.variants[0];

  return {
    url: originalVariant,
    localUri,
  };
}

// Notifications
//
// The shape the notification surfaces render: mentions, replies, likes,
// recasts, follows, etc. for the signed-in user. Filled from Hypersnap's
// notifications feed (services/farcaster/haatzNotifications.ts). Inner
// content stays loosely typed and the consumer narrows per-type at render
// time.

export type FarcasterNotificationType =
  | 'cast-mention'
  | 'cast-reply'
  | 'cast-like'
  | 'cast-recast'
  | 'follow'
  | 'mention'
  | string;

export interface FarcasterNotification {
  /** Stable id from the API used for de-dup and read-tracking. */
  id: string;
  type: FarcasterNotificationType;
  /** ms epoch */
  timestamp: number;
  /** Server-provided unread flag — preferred over a local lastSeen
   *  comparison when present, since the server has the canonical
   *  "what has the user already opened" state. */
  isUnread?: boolean;
  /** Number of items grouped under this notification (e.g. 16 likes on
   *  the same cast). When > 1 the title should reflect aggregation. */
  totalItemCount?: number;
  /** Reaction sub-type for cast-reaction notifications ('like' etc.) */
  reactionType?: string;
  actor?: {
    fid: number;
    username?: string;
    displayName?: string;
    pfp?: { url?: string };
  };
  /** Cast that the notification refers to (mention/reply/like/recast). */
  content?: {
    cast?: {
      hash: string;
      author?: { fid: number; username?: string; displayName?: string };
      text?: string;
    };
  };
  /** Mini-app / frame metadata for notifications that originate from a
   *  Farcaster mini app instead of a user. When present, the title
   *  rendering uses the app name as the "who" so the entry isn't
   *  shown as "Someone — mini-app". */
  frame?: {
    name?: string;
    iconUrl?: string;
    /** Where to take the user if they tap (deep-link or web URL). */
    targetUrl?: string;
    /** Free-form body shipped by the app — used as the secondary line
     *  when present (most mini apps send a short description here). */
    body?: string;
  };
  /** Raw payload for callers that want to render a custom view. */
  raw?: Record<string, unknown>;
}

export interface FarcasterNotificationsPage {
  notifications: FarcasterNotification[];
  nextCursor: string | null;
}
