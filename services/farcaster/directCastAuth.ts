/**
 * The token for farcaster.xyz direct casts (DMs).
 *
 * farcaster.xyz issues a token that opens an account's direct casts and
 * nothing else. The custody key signs farcaster.xyz's own authorization text
 * (the wording its apps sign, nonce from `/v2/get-dc-nonce`), and
 * `/v2/get-dc-auth-token` exchanges it for the token. Quilcast opens messages
 * the same way.
 *
 * It covers the inbox, conversations, messages, mark-read, sending text and
 * replies (`/fc/message`) and the live socket. Images and reactions still go
 * through the session token (`farcasterAuthToken`), as on farcaster.xyz.
 *
 * The token is kept in secure storage with the FID it was minted for, so a
 * different account mints its own. A rejected token is re-minted, at most once
 * a minute.
 */

import {
  getFarcasterCustodyKey,
  getFarcasterDirectCastToken,
  getFarcasterFid,
  storeFarcasterDirectCastToken,
  deleteFarcasterDirectCastToken,
} from '../onboarding/secureStorage';
import { signPersonalMessage } from '../onboarding/personalSign';

export const FARCASTER_CLIENT_URL = 'https://client.farcaster.xyz';
/** farcaster.xyz's API answers its own site only. */
export const FARCASTER_SITE_HEADERS = {
  origin: 'https://farcaster.xyz',
  referer: 'https://farcaster.xyz/',
};

const MINT_TIMEOUT_MS = 15_000;
/** A token minted this recently isn't replaced when a call says it's rejected. */
const REMINT_COOLDOWN_MS = 60_000;

type Held = { fid: number; token: string };

/** `undefined` until secure storage has been read. */
let held: Held | null | undefined;
let lastMintAt = 0;
let minting: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

function set(next: Held | null) {
  held = next;
  listeners.forEach((fn) => fn());
}

/** The authorization text, worded as farcaster.xyz's own apps sign it. */
export function directCastAuthMessage(fid: number, nonce: string, issuedAt: string): string {
  return `This signature grants access to read and write your Farcaster Direct Casts.

In most cases, this message should get signed invisibly, without your interaction.

If you are seeing this text from a signing prompt in your wallet, tread very carefully.

Direct cast authorization for Farcaster FID ${fid}

URI: https://client.farcaster.xyz/v2/get-dc-auth-token
Version: 1
Chain ID: 1
Nonce: ${nonce}
Issued At: ${issuedAt}`;
}

/** The token held for `fid`, without minting or reading storage. */
export function peekDirectCastToken(fid: number | undefined): string | null {
  return fid != null && held?.fid === fid ? held.token : null;
}

export function subscribeDirectCastToken(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The direct-cast token for the signed-in Farcaster account, minted with the
 * custody key when there's none for this FID. `fresh` replaces one a call just
 * had rejected. Null when the account has no custody key here or farcaster.xyz
 * won't issue one.
 */
export async function getDirectCastToken(opts: { fresh?: boolean } = {}): Promise<string | null> {
  const fid = await getFarcasterFid();
  if (!fid) return null;
  if (held === undefined) {
    const stored = await getFarcasterDirectCastToken();
    // Another call may have minted while storage was read.
    if (held === undefined) held = stored;
  }
  const current = held?.fid === fid ? held.token : null;
  if (current && (!opts.fresh || Date.now() - lastMintAt < REMINT_COOLDOWN_MS)) return current;
  minting ??= mint(fid).finally(() => {
    minting = null;
  });
  return minting;
}

/** Drop the token from memory and storage (sign-out). */
export async function forgetDirectCastToken(): Promise<void> {
  set(null);
  lastMintAt = 0;
  await deleteFarcasterDirectCastToken();
}

async function mint(fid: number): Promise<string | null> {
  const custodyKey = await getFarcasterCustodyKey();
  if (!custodyKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
  const init = { headers: { ...FARCASTER_SITE_HEADERS, accept: 'application/json' }, signal: controller.signal };
  try {
    const nonceResponse = await fetch(`${FARCASTER_CLIENT_URL}/v2/get-dc-nonce`, init);
    if (!nonceResponse.ok) return null;
    const nonce = (await nonceResponse.json())?.result?.nonce;
    if (typeof nonce !== 'string') return null;

    const message = directCastAuthMessage(fid, nonce, new Date().toISOString());
    const signature = signPersonalMessage(message, custodyKey);
    // Query parameters, as farcaster.xyz takes them.
    const tokenResponse = await fetch(
      `${FARCASTER_CLIENT_URL}/v2/get-dc-auth-token?${new URLSearchParams({ message, signature })}`,
      init,
    );
    if (!tokenResponse.ok) return null;
    const token = (await tokenResponse.json())?.result?.token;
    if (typeof token !== 'string' || !token) return null;

    lastMintAt = Date.now();
    set({ fid, token });
    await storeFarcasterDirectCastToken({ fid, token });
    return token;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Test seam: forget module state without touching storage. */
export function __resetDirectCastAuth(): void {
  held = undefined;
  lastMintAt = 0;
  minting = null;
  listeners.clear();
}
