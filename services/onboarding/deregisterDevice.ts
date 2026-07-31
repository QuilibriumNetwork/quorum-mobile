import { logger } from '@quilibrium/quorum-shared';
import { getPrivateKey, getPublicKey, getInboxAddress } from './secureStorage';
import { removeDeviceFromRegistration } from './keyService';
import { getSpaceIds } from '../config/spaceStorage';
import { buildRevokeDeviceFrames } from '../space/deviceKeyStatements';

export type LegOutcome =
  /** Confirmed done. */
  | 'ok'
  /** Attempted, not confirmed — assume it didn't happen. */
  | 'failed'
  /** Couldn't attempt it (no keys, or nothing to revoke). */
  | 'skipped';

export interface DeregisterOutcome {
  /** The hub's device list no longer includes this device. */
  hub: LegOutcome;
  /** revoke-device tombstones for this device reached the socket. */
  spaces: LegOutcome;
}

/**
 * Per-leg budgets. Separate on purpose: the hub leg is an HTTP round trip,
 * while the socket leg either drains quickly or is not going to. Sharing one
 * budget lets a slow socket report the hub write as failed after it succeeded,
 * which is how the desktop version of this told users their device might still
 * be listed when it had already been removed.
 *
 * The legs run in parallel, so the user waits for the longer one, not the sum.
 */
export const HUB_TIMEOUT_MS = 8000;
export const SPACES_TIMEOUT_MS = 4000;

const TIMED_OUT = Symbol('timed-out');

/**
 * Race against a deadline, clearing the timer once the work settles so a fast
 * result doesn't leave a pending timeout behind. Harmless in the app, but it
 * keeps a test runner's event loop alive after the assertions are done.
 */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

export interface DeregisterDeps {
  userAddress: string;
  enqueueOutbound: (prepareMessage: () => Promise<string[]>) => void;
  flushOutbound: (timeoutMs?: number) => Promise<boolean>;
}

/**
 * Remove THIS device from the account before Reset App Data destroys its keys.
 *
 * signOut() clears secure storage (the device keyset and the master key) and
 * MMKV (the space list). Those are the only handles to this device's hub entry
 * and to its per-space signing admission, so wiping first orphans both: the hub
 * entry can then only be cleared by hand from another device, and every reset +
 * re-login appends a fresh one. Hence the goodbye runs while the keys exist.
 *
 * Two independent cleanups, reported separately because they fail separately:
 *   1. hub UserRegistration — re-sign the device list without this device
 *   2. spaces — master-signed revoke-device tombstones, flushed to the socket
 *
 * Best-effort by design: a reset must work offline and when things are already
 * broken, so every failure path resolves rather than throws and the caller
 * always proceeds to the wipe. The cost of failure is a leftover entry the user
 * can remove by hand, which beats a reset that refuses to run.
 */
export async function deregisterThisDevice({
  userAddress,
  enqueueOutbound,
  flushOutbound,
}: DeregisterDeps): Promise<DeregisterOutcome> {
  const [privateKeyHex, publicKeyHex, inboxAddress] = await Promise.all([
    getPrivateKey(),
    getPublicKey(),
    getInboxAddress(),
  ]);

  if (!privateKeyHex || !publicKeyHex || !inboxAddress || !userAddress) {
    logger.warn('[Deregister] missing keys at reset time — skipping the goodbye');
    return { hub: 'skipped', spaces: 'skipped' };
  }

  const removeFromHub = async (): Promise<LegOutcome> => {
    try {
      // Reads the registration fresh before rewriting it, so a device
      // registered elsewhere since this session started is not clobbered.
      const status = await removeDeviceFromRegistration(
        userAddress,
        publicKeyHex,
        privateKeyHex,
        inboxAddress
      );
      if (status === 'failed') return 'failed';
      // 'last-device' is a refusal, not a success: the entry is still listed.
      // Reporting it honestly is what stops it being mistaken for a clean
      // goodbye. Mobile leaves the account with at least one device on
      // purpose; see the divergence note on removeDeviceFromRegistration.
      if (status === 'last-device') {
        logger.warn('[Deregister] refused to remove the only device — it stays listed');
        return 'failed';
      }
      return 'ok'; // 'removed' or 'not-listed' — either way it is not listed now
    } catch (err) {
      logger.warn('[Deregister] hub deregister failed', err);
      return 'failed';
    }
  };

  // Revoke even when the hub entry was already gone: the signing admission is
  // anchored to the master key, not the device list, so the two can be out of
  // step. Idempotent (LWW) if another device already revoked it.
  const revokeInSpaces = async (): Promise<LegOutcome> => {
    try {
      const spaceIds = getSpaceIds();
      if (spaceIds.length === 0) return 'skipped';

      // Sign now, while the master key still exists. Once built, the frames
      // are just strings — wiping the keys afterwards cannot invalidate them.
      const frames = await buildRevokeDeviceFrames(spaceIds, [inboxAddress], {
        privateKeyHex,
        publicKeyHex,
      });
      if (frames.length === 0) return 'skipped';

      for (const frame of frames) enqueueOutbound(async () => [frame]);

      // Enqueueing isn't sending. Signing out disconnects the client, so
      // without confirming the flush these frames are discarded and the
      // revoke silently never happens.
      const flushed = await flushOutbound(SPACES_TIMEOUT_MS);
      if (!flushed) {
        logger.warn('[Deregister] revoke frames were not confirmed on the wire');
        return 'failed';
      }
      return 'ok';
    } catch (err) {
      logger.warn('[Deregister] revoke broadcast failed', err);
      return 'failed';
    }
  };

  // Independently bounded so a slow leg can never overwrite the other leg's
  // result, and parallel because they share no ordering.
  const [hub, spaces] = await Promise.all([
    withTimeout(removeFromHub(), HUB_TIMEOUT_MS),
    withTimeout(revokeInSpaces(), SPACES_TIMEOUT_MS),
  ]);

  return {
    hub: hub === TIMED_OUT ? 'failed' : hub,
    spaces: spaces === TIMED_OUT ? 'failed' : spaces,
  };
}
