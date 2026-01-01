import { stripImageMetadata } from '@/utils/imageMetadata';

const FARCASTER_BASE_URL = 'https://client.farcaster.xyz';

interface PostCastParams {
  token: string;
  text: string;
  embeds?: any[];
  parentHash?: string; // For replies - the hash of the cast being replied to
  deviceId?: string;
  sessionId?: string | number;
}

export async function postFarcasterCast({
  token,
  text,
  embeds = [],
  parentHash,
  deviceId,
  sessionId,
}: PostCastParams) {
  if (!text?.trim()) {
    throw new Error('Cast text is required.');
  }

  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const body: Record<string, any> = {
    text: text.trim(),
    embeds,
  };

  // Add parent hash for replies
  if (parentHash) {
    body.parent = { hash: parentHash };
  }

  const response = await fetch(`${FARCASTER_BASE_URL}/v2/casts`, {
    method: 'POST',
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
    const message = await safeReadError(response);
    throw new Error(message || `Failed to post cast (${response.status})`);
  }

  return response.json();
}

async function safeReadError(response: Response) {
  try {
    const data = await response.json();
    return data?.message || data?.error;
  } catch {
    return null;
  }
}

const FARCASTER_API_URL = 'https://farcaster.xyz/~api/v2';

interface LikeCastParams {
  token: string;
  castHash: string;
}

export async function likeCast({ token, castHash }: LikeCastParams) {
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const response = await fetch(`${FARCASTER_API_URL}/cast-likes`, {
    method: 'PUT',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({ castHash }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const message = await safeReadError({ json: async () => JSON.parse(errorBody) } as Response);
    throw new Error(message || `Failed to like cast (${response.status})`);
  }

  const result = await response.json();
  return result;
}

export async function unlikeCast({ token, castHash }: LikeCastParams) {
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const response = await fetch(`${FARCASTER_API_URL}/cast-likes`, {
    method: 'DELETE',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({ castHash }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const message = await safeReadError({ json: async () => JSON.parse(errorBody) } as Response);
    throw new Error(message || `Failed to unlike cast (${response.status})`);
  }

  const result = await response.json();
  return result;
}

interface RecastParams {
  token: string;
  castHash: string;
}

export async function recastCast({ token, castHash }: RecastParams) {
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const response = await fetch(`${FARCASTER_API_URL}/recasts`, {
    method: 'PUT',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({ castHash }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const message = await safeReadError({ json: async () => JSON.parse(errorBody) } as Response);
    throw new Error(message || `Failed to recast (${response.status})`);
  }

  const result = await response.json();
  return result;
}

export async function unrecastCast({ token, castHash }: RecastParams) {
  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const response = await fetch(`${FARCASTER_API_URL}/recasts`, {
    method: 'DELETE',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({ castHash }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const message = await safeReadError({ json: async () => JSON.parse(errorBody) } as Response);
    throw new Error(message || `Failed to unrecast (${response.status})`);
  }

  const result = await response.json();
  return result;
}

// ==================== Direct Cast (DM) API ====================

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

// ==================== Image Upload API ====================

interface GenerateImageUploadUrlParams {
  token: string;
}

interface ImageUploadUrlResponse {
  url: string;
}

/**
 * Generate a Cloudflare image upload URL from Farcaster API
 */
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

/**
 * Upload an image to Cloudflare using the pre-signed URL
 */
export async function uploadImageToCloudflare({
  uploadUrl,
  uri,
  name = 'direct-cast-image',
  mimeType = 'image/jpeg',
}: UploadImageParams): Promise<string | undefined> {
  // Strip metadata before upload
  let processedUri = uri;
  try {
    processedUri = await stripImageMetadata(uri);
  } catch (error) {
    console.warn('[FarcasterClient] Failed to strip metadata, using original:', error);
    // Continue with original URI if stripping fails
  }

  const file = {
    uri: processedUri,
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

/**
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
