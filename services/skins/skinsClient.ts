/**
 * skinsClient — talk to the quorum-api skins gallery.
 *
 * Publishing is an Ed448-signed write (same identity key as reports/user-config):
 * we sign `manifest || thumbnail || be64(timestamp)`, send the public key, and
 * the server derives + matches the author address. Listing/fetching/installing
 * are plain reads/writes. Every fetched skin is re-validated with `validateSkin`
 * before it's handed back — the server is defense-in-depth, the client validator
 * is the hard gate before a skin is ever applied.
 */

import { getApiConfig } from '@/services/api/config';
import { ensurePrivateKey } from '@/services/onboarding/keyService';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';
import { base64ToHex, numberArrayToBase64 } from '@/utils/encoding';
import { hexToBytes } from '@quilibrium/quorum-shared';
import { validateSkin } from '@/theme/skins/validate';
import type { SkinOverride } from '@/theme/skins/types';

export interface SkinSummary {
  id: string;
  authorAddress: string;
  authorName?: string;
  name: string;
  description?: string;
  base: 'light' | 'dark';
  thumbnail?: string;
  createdAt: number;
  installs: number;
}

export interface SkinGalleryPage {
  entries: SkinSummary[];
  total: number;
  hasMore: boolean;
}

function baseUrl(): string {
  return getApiConfig().baseUrl;
}

/** 8-byte big-endian uint64 — matches the server's binary.BigEndian. */
function int64BE(n: number): Uint8Array {
  const b = new Uint8Array(8);
  let v = BigInt(Math.trunc(n));
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function toBase64(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

interface PublishParams {
  /** The skin to publish. Its `id` is ignored — the server content-addresses it. */
  skin: SkinOverride;
  authorAddress: string;
  authorName?: string;
  /** Optional preview image (data:image/png|jpeg). */
  thumbnail?: string;
}

/**
 * Publish a skin to the gallery. Returns the server-assigned content-hash id.
 */
export async function publishSkin(params: PublishParams): Promise<{ id: string }> {
  const { skin, authorAddress, authorName, thumbnail = '' } = params;

  // Normalize: strip the local id + author so the content hash is stable, and
  // stamp the publishing author into meta.
  const manifestObj: SkinOverride = {
    ...skin,
    id: '',
    meta: { ...skin.meta, authorAddress, authorName },
  };
  const manifest = JSON.stringify(manifestObj);

  const privHex = await ensurePrivateKey();
  if (!privHex) throw new Error('Missing identity key');
  const privB64 = toBase64(hexToBytes(privHex));
  const crypto = new NativeCryptoProvider();
  const pubHex = base64ToHex(await crypto.getPublicKeyEd448(privB64));

  const timestamp = Date.now();
  const enc = new TextEncoder();
  const payload = new Uint8Array([
    ...enc.encode(manifest),
    ...enc.encode(thumbnail),
    ...int64BE(timestamp),
  ]);
  const signature = base64ToHex(
    await crypto.signEd448(privB64, numberArrayToBase64(Array.from(payload))),
  );

  const body = {
    author_address: authorAddress,
    author_public_key: pubHex,
    author_name: authorName,
    name: skin.meta.name,
    description: skin.meta.description,
    base: skin.base,
    manifest,
    thumbnail: thumbnail || undefined,
    timestamp,
    signature,
  };

  const res = await fetch(`${baseUrl()}/skins`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => null);
    throw new Error(e?.error || `Publish failed (${res.status})`);
  }
  const json = (await res.json()) as { id: string };
  return { id: json.id };
}

interface RawSummary {
  id: string;
  author_address: string;
  author_name?: string;
  name: string;
  description?: string;
  base: 'light' | 'dark';
  thumbnail?: string;
  created_at: number;
  installs: number;
}

function mapSummary(r: RawSummary): SkinSummary {
  return {
    id: r.id,
    authorAddress: r.author_address,
    authorName: r.author_name,
    name: r.name,
    description: r.description,
    base: r.base,
    thumbnail: r.thumbnail,
    createdAt: r.created_at,
    installs: r.installs,
  };
}

/** Browse the gallery. `sort` is 'popular' (default) or 'new'. */
export async function fetchSkinGallery(opts: {
  search?: string;
  sort?: 'popular' | 'new';
  offset?: number;
  limit?: number;
} = {}): Promise<SkinGalleryPage> {
  const params = new URLSearchParams();
  if (opts.search) params.set('search', opts.search);
  if (opts.sort) params.set('sort', opts.sort);
  params.set('offset', String(opts.offset ?? 0));
  params.set('limit', String(opts.limit ?? 30));
  const res = await fetch(`${baseUrl()}/skins?${params.toString()}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Gallery failed (${res.status})`);
  const json = (await res.json()) as { entries: RawSummary[]; total: number; has_more: boolean };
  return {
    entries: (json.entries ?? []).map(mapSummary),
    total: json.total ?? 0,
    hasMore: json.has_more ?? false,
  };
}

/**
 * Fetch a full skin bundle and validate it. Returns the validated SkinOverride
 * with its server id stamped in, or throws if it fails validation.
 */
export async function fetchSkin(id: string): Promise<SkinOverride> {
  const res = await fetch(`${baseUrl()}/skins/${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Skin fetch failed (${res.status})`);
  const json = (await res.json()) as { id: string; manifest: string };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.manifest);
  } catch {
    throw new Error('Malformed skin manifest');
  }
  const result = validateSkin(parsed);
  if (!result.ok) throw new Error(`Rejected skin: ${result.error}`);
  // Stamp the server id so storage keys + the font namespace are stable.
  return { ...result.skin, id: json.id };
}

/** Record an install (best-effort popularity ranking; counted once per address). */
export async function recordSkinInstall(id: string, address: string): Promise<void> {
  try {
    await fetch(`${baseUrl()}/skins/${encodeURIComponent(id)}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    });
  } catch {
    // ranking is non-critical
  }
}
