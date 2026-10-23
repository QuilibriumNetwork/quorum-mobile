// Per-space send gate for this device's `announce-keys` statement.
//
// The statement tells a space's members which per-space signing key this
// device signs with (see deviceKeyStatements.ts). It used to be built and sent
// for EVERY space on EVERY transition to connected — app launch, foreground
// reconnect, every network blip. Each one is a `log-append`, so it lands in the
// space's hub log permanently and every member downloads it, now and on every
// future catch-up from an older cursor. Nothing about it had changed: the
// receiver keeps the newest statement per device (last-write-wins on its
// timestamp), so the hundredth identical announce told nobody anything.
//
// So a space is announced to when what we would announce differs from what we
// last announced there (a new signing key, a new device inbox, a different
// account), and otherwise at most once per ANNOUNCE_KEYS_INTERVAL_MS as a
// self-heal for a receiver that somehow missed it. The hub log keeps every
// past announce, so a member who joins later still replays it from there.

import { createMMKV, type MMKV } from 'react-native-mmkv';
import { getSpaceSigningKey } from '../config/spaceStorage';

/** Minimum gap between two announces of an unchanged key to the same space. */
export const ANNOUNCE_KEYS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AnnounceKeysRecord {
  /** What was announced — see announceKeysFingerprint. */
  fp: string;
  /** When it was enqueued. */
  at: number;
}

/**
 * Everything the statement binds together, so a change to any of them counts
 * as a new announce rather than a repeat: the account (master public key), the
 * device (its inbox tag) and the per-space key it signs with.
 */
export function announceKeysFingerprint(parts: {
  userPublicKey: string;
  deviceInboxAddress: string;
  spaceKeyPublicKey: string;
}): string {
  return `${parts.userPublicKey}:${parts.deviceInboxAddress}:${parts.spaceKeyPublicKey}`;
}

/** Send when never sent here, when the announced key changed, or once the interval has passed. */
export function shouldAnnounceKeys(
  record: AnnounceKeysRecord | null,
  fp: string,
  now: number,
): boolean {
  if (!record) return true;
  if (record.fp !== fp) return true;
  return now - record.at >= ANNOUNCE_KEYS_INTERVAL_MS;
}

export function parseAnnounceKeysRecord(raw: string | null | undefined): AnnounceKeysRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AnnounceKeysRecord> | null;
    if (parsed && typeof parsed.fp === 'string' && Number.isFinite(parsed.at)) {
      return { fp: parsed.fp, at: parsed.at as number };
    }
  } catch {
    // Unreadable — treated as never announced, which costs one frame.
  }
  return null;
}

let store: MMKV | null = null;
function getStore(): MMKV {
  if (!store) store = createMMKV({ id: 'quorum-announce-keys-gate' });
  return store;
}

/**
 * The fingerprint to announce for this space, or null when nothing is due:
 * either the space has no signing key yet, or this exact key was announced
 * there within the interval. Storage failures fail open — an extra announce
 * costs one frame, a suppressed one can leave this device's messages
 * unverifiable for other members.
 */
export function announceKeysDue(
  spaceId: string,
  userPublicKey: string,
  deviceInboxAddress: string,
  now: number = Date.now(),
): string | null {
  const spaceKeyPublicKey = getSpaceSigningKey(spaceId)?.publicKey;
  if (!spaceKeyPublicKey || !deviceInboxAddress) return null;
  const fp = announceKeysFingerprint({ userPublicKey, deviceInboxAddress, spaceKeyPublicKey });
  let record: AnnounceKeysRecord | null = null;
  try {
    record = parseAnnounceKeysRecord(getStore().getString(spaceId));
  } catch {
    record = null;
  }
  return shouldAnnounceKeys(record, fp, now) ? fp : null;
}

/** Record that `fp` was handed to the transport for this space. */
export function markKeysAnnounced(spaceId: string, fp: string, now: number = Date.now()): void {
  try {
    getStore().set(spaceId, JSON.stringify({ fp, at: now } satisfies AnnounceKeysRecord));
  } catch {
    // The next connect announces again; no worse than before the gate.
  }
}
