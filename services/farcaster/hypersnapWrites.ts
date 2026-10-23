/**
 * Every Farcaster protocol write the app makes: casts, cast deletes, likes,
 * recasts, follows and profile fields. Each is a message signed with the
 * device's Hypersnap signer (`hypersnapProvision.ts`) and submitted to
 * Hypersnap's `/v1/submitMessage`.
 *
 * There is no farcaster.xyz fallback. A write that cannot be signed or that
 * Hypersnap rejects fails with a {@link FarcasterWriteError}, so the caller can
 * roll back its optimistic UI. What still goes to farcaster.xyz (uploads, DMs,
 * mutes and blocks, Audio Spaces) is listed in FARCASTER_TECH_DEBT.md.
 */

import {
  buildSignedMessage,
  CastType,
  DEFAULT_HYPERSNAP_BASE_URL,
  getDefaultHypersnapClient,
  MessageType,
  ReactionType,
  signerFromRecord,
  UserDataType,
  type CastEmbed,
  type MessageDataInput,
} from '@quilibrium/quorum-shared';
import { recordFollowChange } from './socialGraph';

export class FarcasterWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FarcasterWriteError';
  }
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.toLowerCase().startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** True for a full 20-byte cast hash, with or without `0x`. */
export function isFullCastHash(hash: string | undefined): boolean {
  return !!hash && /^(0x)?[0-9a-f]{40}$/i.test(hash);
}

/** Sign `body` as `fid` and submit it. Returns the message hash (0x hex). */
async function submit(
  fid: number,
  type: MessageType,
  body: MessageDataInput['body'],
): Promise<string> {
  if (!Number.isFinite(fid) || fid <= 0) {
    throw new FarcasterWriteError('No Hypersnap account is connected');
  }
  // Loaded on first write: the signer store and its storage graph stay out of
  // modules that only use the lookups below.
  const { getHypersnapSignerFor } = await import('./hypersnapProvision');
  const record = await getHypersnapSignerFor(fid);
  if (!record) {
    throw new FarcasterWriteError(
      "Couldn't sign with your Hypersnap account yet. Check your connection and try again.",
    );
  }
  const { envelope, hash } = await buildSignedMessage({ type, fid, body }, signerFromRecord(record));
  try {
    await getDefaultHypersnapClient().submitMessage(envelope);
  } catch (e) {
    throw new FarcasterWriteError(e instanceof Error ? e.message : String(e));
  }
  return bytesToHex(hash);
}

// ---------------------------------------------------------------------------
// Cast author lookup
// ---------------------------------------------------------------------------

const authorFidByHash = new Map<string, number>();

/** Seed the author cache from casts the UI already has, so a like or reply on
 *  them needs no lookup. */
export function rememberCastAuthor(castHash: string | undefined, authorFid: number | undefined): void {
  if (!castHash || !isFullCastHash(castHash) || !authorFid || authorFid <= 0) return;
  authorFidByHash.set(castHash.toLowerCase().replace(/^0x/, ''), authorFid);
}

/**
 * The FID that authored a cast, from its full hash. Reactions and replies
 * target a cast by (author FID, hash), and several surfaces only carry the
 * hash. Cached for the session; null when Hypersnap does not know the cast.
 */
export async function resolveCastAuthorFid(castHash: string): Promise<number | null> {
  if (!isFullCastHash(castHash)) return null;
  const key = castHash.toLowerCase().replace(/^0x/, '');
  const known = authorFidByHash.get(key);
  if (known) return known;
  try {
    const res = await fetch(
      `${DEFAULT_HYPERSNAP_BASE_URL}/v2/farcaster/cast?identifier=${key}&type=hash`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { cast?: { author?: { fid?: number } } };
    const fid = json.cast?.author?.fid;
    if (typeof fid !== 'number' || fid <= 0) return null;
    authorFidByHash.set(key, fid);
    return fid;
  } catch {
    return null;
  }
}

async function castTarget(castHash: string, authorFid?: number): Promise<{ fid: number; hash: Uint8Array }> {
  const fid = authorFid && authorFid > 0 ? authorFid : await resolveCastAuthorFid(castHash);
  if (!fid) throw new FarcasterWriteError("Couldn't find that cast on Hypersnap");
  return { fid, hash: hexToBytes(castHash) };
}

// ---------------------------------------------------------------------------
// Casts
// ---------------------------------------------------------------------------

/** Byte limits Hypersnap validates casts against. */
export const CAST_BYTE_LIMIT = 320;
export const LONG_CAST_BYTE_LIMIT = 1024;
export const TEN_K_CAST_BYTE_LIMIT = 10_000;

/** The cast type a text needs: each type has a minimum as well as a maximum,
 *  so the type follows the length. Over 1024 bytes needs Farcaster Pro. */
export function castTypeForText(text: string): CastType {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes <= CAST_BYTE_LIMIT) return CastType.CAST;
  if (bytes <= LONG_CAST_BYTE_LIMIT) return CastType.LONG_CAST;
  return CastType.TEN_K_CAST;
}

export interface PublishCastInput {
  fid: number;
  text: string;
  embeds?: CastEmbed[];
  /** Mentioned FIDs, aligned with `mentionsPositions` (byte offsets into `text`). */
  mentions?: number[];
  mentionsPositions?: number[];
  /** A reply (author FID resolved from the hash when omitted), or a channel /
   *  URL parent. */
  parent?: { castHash: string; fid?: number } | { url: string };
}

/** Publish a cast. Returns its hash (0x hex). */
export async function publishCast(input: PublishCastInput): Promise<string> {
  let parent: { castId: { fid: number; hash: Uint8Array } } | { url: string } | undefined;
  if (input.parent && 'url' in input.parent) {
    parent = { url: input.parent.url };
  } else if (input.parent) {
    parent = { castId: await castTarget(input.parent.castHash, input.parent.fid) };
  }
  const hash = await submit(input.fid, MessageType.CAST_ADD, {
    castAddBody: {
      text: input.text,
      embeds: input.embeds && input.embeds.length > 0 ? input.embeds : undefined,
      mentions: input.mentions && input.mentions.length > 0 ? input.mentions : undefined,
      mentionsPositions:
        input.mentionsPositions && input.mentionsPositions.length > 0 ? input.mentionsPositions : undefined,
      parent,
      type: castTypeForText(input.text),
    },
  });
  rememberCastAuthor(hash, input.fid);
  return hash;
}

/** Delete one of the signed-in user's own casts. */
export async function removeOwnCast(params: { fid: number; castHash: string }): Promise<void> {
  await submit(params.fid, MessageType.CAST_REMOVE, {
    castRemoveBody: { targetHash: hexToBytes(params.castHash) },
  });
}

// ---------------------------------------------------------------------------
// Reactions and follows
// ---------------------------------------------------------------------------

/** Like / unlike or recast / un-recast a cast. */
export async function setCastReaction(params: {
  fid: number;
  castHash: string;
  /** The cast's author, when the caller has it; looked up otherwise. */
  castAuthorFid?: number;
  kind: 'like' | 'recast';
  active: boolean;
}): Promise<void> {
  const castId = await castTarget(params.castHash, params.castAuthorFid);
  await submit(params.fid, params.active ? MessageType.REACTION_ADD : MessageType.REACTION_REMOVE, {
    reactionBody: {
      type: params.kind === 'like' ? ReactionType.LIKE : ReactionType.RECAST,
      target: { castId },
    },
  });
}

/** Follow or unfollow another account. */
export async function setFollowing(params: { fid: number; targetFid: number; following: boolean }): Promise<void> {
  await submit(params.fid, params.following ? MessageType.LINK_ADD : MessageType.LINK_REMOVE, {
    linkBody: { type: 'follow', targetFid: params.targetFid },
  });
  // The viewer's follow set is refetched only every few hours; keep it in step.
  recordFollowChange(params.fid, params.targetFid, params.following);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface ProfileFields {
  displayName?: string;
  bio?: string;
  location?: string;
  url?: string;
  /** An already-hosted https image URL. */
  pfp?: string;
}

const USER_DATA_TYPES: Record<keyof ProfileFields, UserDataType> = {
  displayName: UserDataType.DISPLAY,
  bio: UserDataType.BIO,
  location: UserDataType.LOCATION,
  url: UserDataType.URL,
  pfp: UserDataType.PFP,
};

/** Set profile fields. Each field is its own signed message; they are sent in
 *  order and the first rejection stops the rest. */
export async function setProfileFields(params: { fid: number; fields: ProfileFields }): Promise<void> {
  for (const key of Object.keys(USER_DATA_TYPES) as (keyof ProfileFields)[]) {
    const value = params.fields[key];
    if (value === undefined) continue;
    await submit(params.fid, MessageType.USER_DATA_ADD, {
      userDataBody: { type: USER_DATA_TYPES[key], value },
    });
  }
}
