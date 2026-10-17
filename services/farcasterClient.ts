import { reportFarcasterAuthFailure } from './farcaster/authTokenEvents';
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
    return data?.message || data?.error;
  } catch {
    return null;
  }
}

// Direct Cast (DM) API

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
  participants: DirectCastUser[];
  lastMessage?: DirectCastMessage;
  isGroup: boolean;
  unreadCount: number;
  muted: boolean;
  viewerContext: {
    category: 'default' | 'archived' | 'request';
    lastReadAt: number;
    unreadCount: number;
    counterParty?: DirectCastUser;
  };
}

interface GetDirectCastConversationsParams {
  token: string;
  category?: 'default' | 'archived' | 'request';
  cursor?: string;
  limit?: number;
}

export async function getDirectCastConversations({
  token,
  category = 'default',
  cursor,
  limit = 20,
}: GetDirectCastConversationsParams): Promise<{
  conversations: DirectCastConversation[];
  nextCursor?: string;
  requestsCount: number;
}> {
  const params = new URLSearchParams({
    category,
    limit: String(limit),
  });
  if (cursor) {
    params.set('cursor', cursor);
  }

  const response = await fetch(
    `${FARCASTER_BASE_URL}/v2/direct-cast-conversation-list?${params}`,
    {
      method: 'GET',
      headers: {
        accept: '*/*',
        authorization: `Bearer ${token}`,
        origin: 'https://farcaster.xyz',
        referer: 'https://farcaster.xyz/',
      },
    }
  );

  if (!response.ok) {
    // The DM list is the most frequent farcaster.xyz token call left, so it
    // is the one that reports a rejected token for a background re-auth.
    if (response.status === 401 || response.status === 403) {
      reportFarcasterAuthFailure();
    }
    const message = await safeReadError(response);
    throw new Error(message || `Failed to fetch conversations (${response.status})`);
  }

  const json = await response.json();

  return {
    conversations: json.result?.conversations ?? [],
    nextCursor: json.next?.cursor,
    requestsCount: json.result?.requestsCount ?? 0,
  };
}

interface GetDirectCastMessagesParams {
  token: string;
  conversationId: string;
  cursor?: string;
  limit?: number;
}

export async function getDirectCastMessages({
  token,
  conversationId,
  cursor,
  limit = 50,
}: GetDirectCastMessagesParams): Promise<{
  messages: DirectCastMessage[];
  nextCursor?: string;
}> {
  const params = new URLSearchParams({
    conversationId,
    limit: String(limit),
  });
  if (cursor) {
    params.set('cursor', cursor);
  }

  const response = await fetch(
    `${FARCASTER_BASE_URL}/v2/direct-cast-conversation-messages?${params}`,
    {
      method: 'GET',
      headers: {
        accept: '*/*',
        authorization: `Bearer ${token}`,
        origin: 'https://farcaster.xyz',
        referer: 'https://farcaster.xyz/',
      },
    }
  );

  if (!response.ok) {
    const message = await safeReadError(response);
    throw new Error(message || `Failed to fetch messages (${response.status})`);
  }

  const json = await response.json();

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

interface SendDirectCastParams {
  token: string;
  conversationId: string;
  recipientFids: number[];
  message: string;
  inReplyToId?: string;
  metadata?: DirectCastMessageMetadata;
}

export async function sendDirectCast({
  token,
  conversationId,
  recipientFids,
  message,
  inReplyToId,
  metadata,
}: SendDirectCastParams): Promise<{ success: boolean }> {
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
  };

  if (inReplyToId) {
    body.inReplyToId = inReplyToId;
  }

  if (metadata) {
    body.metadata = metadata;
  }

  try {
    const response = await fetch(`${FARCASTER_BASE_URL}/v2/direct-cast-send`, {
      method: 'PUT',
      headers: {
        accept: '*/*',
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
        origin: 'https://farcaster.xyz',
        referer: 'https://farcaster.xyz/',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const errorMessage = await safeReadError({ json: async () => JSON.parse(errorBody) } as Response);
      throw new Error(errorMessage || `Failed to send direct cast (${response.status})`);
    }

    const result = await response.json();
    return { success: result.result?.success ?? true };
  } catch (error) {
    throw error;
  }
}

interface MarkDirectCastReadParams {
  token: string;
  conversationId: string;
}

export async function markDirectCastRead({
  token,
  conversationId,
}: MarkDirectCastReadParams): Promise<void> {
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const response = await fetch(`${FARCASTER_BASE_URL}/v2/direct-cast-read`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({ conversationId }),
  });

  if (!response.ok) {
    const errorMessage = await safeReadError(response);
    throw new Error(errorMessage || `Failed to mark as read (${response.status})`);
  }
}

interface DirectCastReactionParams {
  token: string;
  conversationId: string;
  messageId: string;
  reaction: string;
}

export async function addDirectCastReaction({
  token,
  conversationId,
  messageId,
  reaction,
}: DirectCastReactionParams): Promise<void> {
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
