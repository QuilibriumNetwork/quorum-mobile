/*
 * Per-device space signing keys — master-signed announce/revoke statements.
 *
 * Multi-device breaks the single-key verified-signer model: a second device
 * signs with its own per-space key, which no receiver's member table has seen,
 * so its control messages are dropped. The durable fix admits MULTIPLE signing
 * keys per member — one per device — but only inside a statement signed by the
 * user's MASTER identity key (whose hash IS the user_address already in every
 * member row). Mirrors desktop MessageService (PR #245 receive, #249 send).
 *
 * Canonical bytes + verify come from shared (deviceKeys.ts) so desktop and
 * mobile sign/verify byte-identical. Statements never touch the member row's
 * join binding — admissions live in their own MMKV store.
 */

import {
  buildDeviceKeyStatementBytes,
  deriveInboxAddress,
  hexToBytes,
  verifyDeviceKeyStatement,
  type AnnounceKeysStatement,
  type DeviceKeyStatement,
  type RevokeDeviceStatement,
} from '@quilibrium/quorum-shared';
import { base64ToHex } from '../../utils/encoding';
import { NativeCryptoProvider } from '../crypto/native-provider';
import { NativeSigningProvider } from '../crypto/native-signing-provider';
import { getSpaceKey, getSpaceSigningKey } from '../config/spaceStorage';
import { getMMKVAdapter } from '../storage/mmkvAdapter';

export interface MasterKeys {
  privateKeyHex: string;
  publicKeyHex: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function hexToNumberArray(hex: string): number[] {
  return Array.from(hexToBytes(hex));
}

/**
 * Master-sign a statement over the canonical shared bytes (never the JSON
 * envelope). Returns the hex signature.
 */
async function signStatement(
  statement: DeviceKeyStatement,
  privateKeyHex: string
): Promise<string> {
  const bytes = buildDeviceKeyStatementBytes(statement);
  const messageBase64 = bytesToBase64(new TextEncoder().encode(bytes));
  const privateKeyBase64 = bytesToBase64(Uint8Array.from(hexToBytes(privateKeyHex)));
  const sigBase64 = await new NativeCryptoProvider().signEd448(
    privateKeyBase64,
    messageBase64
  );
  return base64ToHex(sigBase64);
}

/** Seal a control statement as a hub-log frame (mirrors sendJoinMessage). */
async function sealControlFrame(
  spaceId: string,
  statement: DeviceKeyStatement
): Promise<string | null> {
  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey?.address || !hubKey.privateKey || !hubKey.publicKey) return null;
  const configKey = getSpaceKey(spaceId, 'config');

  const sealed = await new NativeCryptoProvider().sealHubEnvelope(
    hubKey.address,
    {
      publicKey: hexToNumberArray(hubKey.publicKey),
      privateKey: hexToNumberArray(hubKey.privateKey),
    },
    JSON.stringify({ type: 'control', message: statement }),
    configKey
      ? {
          publicKey: hexToNumberArray(configKey.publicKey),
          privateKey: hexToNumberArray(configKey.privateKey),
        }
      : undefined
  );
  return JSON.stringify({ type: 'log-append', ...sealed });
}

/**
 * Build the announce-keys frame for one space: announces the key this device
 * actually signs with (getSpaceSigningKey = signing ?? inbox). Returns the
 * ws frame to enqueue, or null if the space has no signing key / no device tag.
 */
export async function buildAnnounceKeysFrame(
  spaceId: string,
  master: MasterKeys,
  deviceInboxAddress: string
): Promise<string | null> {
  const signingKey = getSpaceSigningKey(spaceId);
  if (!signingKey?.publicKey || !deviceInboxAddress) return null;

  const statement: AnnounceKeysStatement = {
    type: 'announce-keys',
    userAddress: deriveInboxAddress(master.publicKeyHex),
    userPublicKey: master.publicKeyHex,
    spaceId,
    deviceInboxAddress,
    spaceKeyPublicKey: signingKey.publicKey,
    timestamp: Date.now(),
    signature: '',
  };
  statement.signature = await signStatement(statement, master.privateKeyHex);
  return sealControlFrame(spaceId, statement);
}

/**
 * Build revoke-device frames for each removed device across the given spaces.
 * One master-signed tombstone per (space, device).
 */
export async function buildRevokeDeviceFrames(
  spaceIds: string[],
  deviceInboxAddresses: string[],
  master: MasterKeys
): Promise<string[]> {
  const frames: string[] = [];
  const userAddress = deriveInboxAddress(master.publicKeyHex);
  for (const spaceId of spaceIds) {
    for (const deviceInboxAddress of deviceInboxAddresses) {
      const statement: RevokeDeviceStatement = {
        type: 'revoke-device',
        userAddress,
        userPublicKey: master.publicKeyHex,
        spaceId,
        deviceInboxAddress,
        timestamp: Date.now(),
        signature: '',
      };
      statement.signature = await signStatement(statement, master.privateKeyHex);
      const frame = await sealControlFrame(spaceId, statement);
      if (frame) frames.push(frame);
    }
  }
  return frames;
}

/**
 * Receive an announce-keys / revoke-device statement. Verifies via shared
 * (master-signed, self-certifying id, 30s skew, LWW) and persists the admission
 * or a tombstone. Fails closed. Never writes the member row.
 */
export async function processDeviceKeyStatement(
  statement: DeviceKeyStatement,
  contextSpaceId: string
): Promise<void> {
  // Only honor a statement meant for the space whose hub delivered it.
  if (statement.spaceId !== contextSpaceId) return;

  const adapter = getMMKVAdapter();
  const existing = await adapter.getSpaceMemberDevice(
    statement.spaceId,
    statement.deviceInboxAddress
  );
  const verdict = await verifyDeviceKeyStatement(
    new NativeSigningProvider(),
    statement,
    existing ? { timestamp: existing.timestamp, revoked: !!existing.revoked } : undefined
  );

  if (verdict.action === 'admit') {
    await adapter.saveSpaceMemberDevice(verdict.device);
  } else if (verdict.action === 'revoke') {
    await adapter.saveSpaceMemberDevice({
      spaceId: verdict.spaceId,
      userAddress: verdict.userAddress,
      deviceInboxAddress: verdict.deviceInboxAddress,
      inboxAddress: existing?.inboxAddress ?? '',
      spaceKeyPublicKey: existing?.spaceKeyPublicKey ?? '',
      timestamp: verdict.timestamp,
      revoked: true,
    });
  }
}
