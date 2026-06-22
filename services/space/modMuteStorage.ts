/**
 * modMuteStorage — local store for MODERATION mute (a moderator with the
 * `user:mute` role silences a user in a space for everyone).
 *
 * This is NOT the personal viewer-side "block" (that hides a user's messages
 * from your own stream only — see hooks/chat/useBlockUser.ts).
 * It is the role-gated moderation action: a `MuteMessage` is broadcast, every
 * client validates the sender's permission on receive and records the mute here,
 * then drops the muted user's incoming messages and disables their composer.
 *
 * Storage: a dedicated MMKV instance, one record per (spaceId, targetUserId),
 * mirroring desktop's `muted_users` IndexedDB store. Records carry `expiresAt`
 * (undefined = forever) so timed mutes auto-expire at read time.
 *
 * Reactivity: a module-level snapshot + `useSyncExternalStore` (the same shape
 * useDMMute uses) so a received mute updates the composer / profile modal / list
 * the instant it lands — no remount. Non-React callers (the receive pipeline)
 * use the plain get/set helpers.
 */

import { createMMKV, type MMKV } from 'react-native-mmkv';

export type MutedUserRecord = {
  spaceId: string;
  targetUserId: string;
  mutedAt: number;
  mutedBy: string;
  /** muteId of the last mute applied — replay/dedup guard. */
  lastMuteId: string;
  /** When the mute expires (ms). Undefined = forever. */
  expiresAt?: number;
};

const storage: MMKV = createMMKV({ id: 'space-user-mod-mutes' });

function recordKey(spaceId: string, targetUserId: string): string {
  return `mute:${spaceId}:${targetUserId}`;
}
function muteIdKey(muteId: string): string {
  return `muteid:${muteId}`;
}

// --- module-level reactive store (one source of truth across all consumers) ---
//
// We don't hold the whole record set in memory; instead we bump a version
// counter on every write and let `useSyncExternalStore` consumers re-read the
// MMKV-backed `isUserMuted` on change. The snapshot IS the version number, so a
// new value => React re-renders => consumers re-evaluate `isUserMuted`.

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribeMutes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMutesVersion(): number {
  return version;
}

// --- reads (non-React safe) ---

/** Is `targetUserId` currently muted in `spaceId`? Honors expiry. */
export function isUserMuted(spaceId: string, targetUserId: string): boolean {
  const raw = storage.getString(recordKey(spaceId, targetUserId));
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw) as MutedUserRecord;
    if (rec.expiresAt !== undefined && rec.expiresAt <= Date.now()) {
      return false; // lapsed — treat as unmuted (lazy expiry; cleaned on next write)
    }
    return true;
  } catch {
    return false;
  }
}

/** Full record (for expiry/“muted for X” display), or null. Honors expiry. */
export function getMuteRecord(
  spaceId: string,
  targetUserId: string,
): MutedUserRecord | null {
  const raw = storage.getString(recordKey(spaceId, targetUserId));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as MutedUserRecord;
    if (rec.expiresAt !== undefined && rec.expiresAt <= Date.now()) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Has this muteId already been applied? Replay-protection for receive. */
export function hasMuteId(muteId: string): boolean {
  return storage.getString(muteIdKey(muteId)) !== undefined;
}

// --- writes (emit so consumers react) ---

export function setMute(rec: MutedUserRecord): void {
  storage.set(recordKey(rec.spaceId, rec.targetUserId), JSON.stringify(rec));
  // Track the muteId so a re-delivered MuteMessage is a no-op (replay guard).
  storage.set(muteIdKey(rec.lastMuteId), '1');
  emit();
}

export function removeMute(spaceId: string, targetUserId: string): void {
  storage.remove(recordKey(spaceId, targetUserId));
  emit();
}

/** Record a processed unmute's muteId so its echo can't re-trigger work. */
export function markMuteIdSeen(muteId: string): void {
  storage.set(muteIdKey(muteId), '1');
}
