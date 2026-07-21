/**
 * One-shot per-space hub-log refetch for channels that come up empty.
 *
 * The per-space "attempted" flag lives in SQLite alongside the data it
 * gates, so a DB wipe automatically re-arms recovery. Marks attempted
 * before sending so a stuck server can't cause repeated refetches.
 */

import { getSpaceKey } from '@/services/config/spaceStorage';
import {
  hasAttemptedRecovery as hasAttemptedRecoveryDb,
  markRecoveryAttempted as markRecoveryAttemptedDb,
} from '@/services/storage/messagesDb';
import { clearHubCursor } from './hubLogCursor';
import { buildLogSinceFrame, type HubKey } from './hubLogSync';
import { logger } from '@quilibrium/quorum-shared';
const RECOVERY_FETCH_LIMIT = 1000;

export function hasAttemptedRecovery(spaceId: string): boolean {
  return hasAttemptedRecoveryDb(spaceId);
}

export async function attemptHubLogRecovery(
  spaceId: string,
  enqueueOutbound: (prepare: () => Promise<string[]>) => void,
): Promise<void> {
  if (hasAttemptedRecovery(spaceId)) return;

  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey?.address || !hubKey.privateKey || !hubKey.publicKey) {
    markRecoveryAttemptedDb(spaceId);
    return;
  }

  // Mark first so concurrent channel-opens in the same space coalesce.
  markRecoveryAttemptedDb(spaceId);

  // clearHubCursor, not setHubLastSeq(addr, 0) — the setter only advances,
  // so a "reset to 0" was a silent no-op.
  clearHubCursor(hubKey.address);

  const key: HubKey = {
    address: hubKey.address,
    publicKey: hubKey.publicKey,
    privateKey: hubKey.privateKey,
  };

  try {
    const frame = await buildLogSinceFrame(key, 0, RECOVERY_FETCH_LIMIT);
    enqueueOutbound(async () => [frame]);
    logger.debug(`[messageRecovery] requested full hub-log replay for space ${spaceId.slice(0, 12)}`);
  } catch (e) {
    logger.warn(`[messageRecovery] failed to build/send recovery frame for ${spaceId.slice(0, 12)}:`, e);
  }
}
