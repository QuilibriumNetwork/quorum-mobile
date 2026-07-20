/**
 * SpaceSyncService - Handles syncing spaces from config
 *
 * When a user config is synced from a remote device, this service:
 * 1. Decrypts the space manifest using the config key
 * 2. Saves the space and keys locally
 * 3. Subscribes to the hub for receiving space messages
 * 4. Saves the encryption state for the space
 *
 * This mirrors the desktop's ConfigService space sync logic.
 */

import { base64ToHex, numberArrayToBase64 } from '@/utils/encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import * as multihashes from 'multihashes';
import { getQuorumClient } from '../api/quorumClient';
import { NativeCryptoProvider } from '../crypto/native-provider';
import { encryptionStateStorage } from '../crypto/encryption-state-storage';
import {
  saveSpace,
  saveSpaceKey,
  getSpace,
  getSpaceKey,
  type SpaceKey,
} from './spaceStorage';
import { type Space } from '@quilibrium/quorum-shared';
import { hexToBytes, bytesToHex } from '@quilibrium/quorum-shared';
import { getMMKVAdapter } from '../storage/mmkvAdapter';

/**
 * Space key info from UserConfig.spaceKeys
 */
export interface SpaceKeyInfo {
  spaceId: string;
  encryptionState: {
    conversationId: string;
    inboxId: string;
    state: string;
    timestamp: number;
  };
  keys: {
    keyId: string;
    address?: string;
    publicKey: string;
    privateKey: string;
    spaceId: string;
  }[];
}

/**
 * User info for saving as space member during sync
 */
export interface SyncUserInfo {
  address: string;
  displayName?: string;
  profileImage?: string;
}

/**
 * Derive address from public key using multihash (same as Quorum address derivation)
 */
function deriveAddress(publicKeyBytes: Uint8Array): string {
  const hash = sha256(publicKeyBytes);
  const multihash = multihashes.encode(hash, 'sha2-256');
  return bs58.encode(multihash);
}

/**
 * Sync a space from config to local storage
 *
 * @param spaceKeyInfo - Space key info from UserConfig.spaceKeys
 * @param userInfo - Current user's info to save as a member
 * @param onListenRequest - Callback to request WebSocket subscription to inbox
 * @returns true if sync was successful
 */
export async function syncSpaceFromConfig(
  spaceKeyInfo: SpaceKeyInfo,
  userInfo?: SyncUserInfo,
  onListenRequest?: (inboxAddresses: string[]) => void
): Promise<boolean> {
  const { spaceId, encryptionState, keys } = spaceKeyInfo;

  // Check if space already exists locally
  const existingSpace = getSpace(spaceId);
  if (existingSpace) {
    // Heal path: a space synced before the signing-key split has only its
    // per-device (fresh) inbox key, whose signatures no receiver's member
    // table can resolve — so control messages (delete/edit/mute/…) from this
    // device get dropped fleet-wide. When another device has since published
    // the original join-bound keypair under 'signing', adopt it.
    //
    // Adoption rule: a key this device holds with 'origin' provenance (its
    // own create/join flow — provably correct) is NEVER replaced. Anything
    // else ('promoted' = migration guess that misfires on pre-split synced
    // devices, 'adopted', or unmarked) yields to the blob, so a device that
    // wrongly self-promoted converges to the join device's published key as
    // soon as that device's config save reaches the blob.
    // Best-effort: storage failures are swallowed and the whole block re-runs
    // on the next config receive; all steps are idempotent.
    try {
      const localSigning = getSpaceKey(spaceId, 'signing');
      if (!localSigning || localSigning.provenance !== 'origin') {
        const payloadSigning = keys.find((k) => k.keyId === 'signing');
        if (
          payloadSigning?.privateKey &&
          payloadSigning.publicKey &&
          payloadSigning.publicKey !== localSigning?.publicKey
        ) {
          saveSpaceKey({
            spaceId,
            keyId: 'signing',
            address:
              payloadSigning.address ??
              deriveAddress(Uint8Array.from(hexToBytes(payloadSigning.publicKey))),
            publicKey: payloadSigning.publicKey,
            privateKey: payloadSigning.privateKey,
            provenance: 'adopted',
          });
        }
      }
      // Re-anchor the local self member row to the signing identity whenever
      // they disagree — the pre-split sync bound it to this device's fresh
      // mailbox key, which breaks resolving the user's OTHER devices'
      // signatures here. Runs on every config receive (not only when a key
      // was just adopted) so an interrupted heal repairs itself.
      const signingKey = getSpaceKey(spaceId, 'signing');
      if (signingKey?.address && userInfo?.address) {
        const adapter = getMMKVAdapter();
        const selfRow = await adapter.getSpaceMember(spaceId, userInfo.address);
        if (selfRow && selfRow.inbox_address !== signingKey.address) {
          await adapter.saveSpaceMember(spaceId, {
            ...selfRow,
            inbox_address: signingKey.address,
          });
        }
      }
    } catch {
      // Heal is best-effort; retried on the next config receive.
    }
    return true;
  }

  try {
    // Find required keys
    const configKey = keys.find((k) => k.keyId === 'config');
    const hubKey = keys.find((k) => k.keyId === 'hub');

    if (!configKey) {
      return false;
    }

    if (!hubKey) {
      return false;
    }

    // Save all keys first. A payload 'signing' key is marked 'adopted' (came
    // from the blob, replaceable if the blob later offers a different one);
    // provenance is a local-only field, never serialized back into the blob.
    for (const key of keys) {
      saveSpaceKey({
        spaceId: key.spaceId,
        keyId: key.keyId,
        address: key.address,
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        ...(key.keyId === 'signing' ? { provenance: 'adopted' as const } : {}),
      });
    }

    // Fetch space registration info
    const client = getQuorumClient();
    let spaceRegistration;
    try {
      spaceRegistration = await client.fetchSpace(spaceId);
    } catch (error) {
      return false;
    }

    // Fetch space manifest
    let manifestPayload;
    try {
      manifestPayload = await client.getSpaceManifest(spaceId);
    } catch (error) {
      return false;
    }

    if (!manifestPayload || !manifestPayload.space_manifest) {
      return false;
    }

    // Parse the encrypted manifest
    let ciphertext;
    try {
      ciphertext = JSON.parse(manifestPayload.space_manifest) as {
        ciphertext: string;
        initialization_vector: string;
        associated_data?: string;
      };
    } catch (error) {
      return false;
    }

    // Decrypt the manifest using config key
    const cryptoProvider = new NativeCryptoProvider();
    const configPrivateKeyBytes = hexToBytes(configKey.privateKey);
    const ephemeralPublicKeyBytes = hexToBytes(manifestPayload.ephemeral_public_key);

    let decryptedManifest: Space;
    try {
      const decryptResult = await cryptoProvider.decryptInboxMessage({
        inbox_private_key: configPrivateKeyBytes,
        ephemeral_public_key: ephemeralPublicKeyBytes,
        ciphertext: {
          ciphertext: ciphertext.ciphertext,
          initialization_vector: ciphertext.initialization_vector,
          associated_data: ciphertext.associated_data,
        },
      });
      decryptedManifest = JSON.parse(
        new TextDecoder().decode(new Uint8Array(decryptResult))
      ) as Space;
    } catch {
      // Decryption can fail if the user was kicked (manifest re-encrypted with new key),
      // the config key was rotated, or the manifest data is corrupted
      return false;
    }

    // Generate new inbox keypair for this space
    const inboxKeypair = await cryptoProvider.generateEd448();
    const inboxAddress = deriveAddress(new Uint8Array(inboxKeypair.public_key));

    // Save the space
    saveSpace(decryptedManifest);

    // Save encryption state with new inbox address
    encryptionStateStorage.saveEncryptionState(
      {
        ...encryptionState,
        inboxId: inboxAddress,
      },
      true
    );

    // Register inbox with hub
    try {
      // Build hub signature: sign("add" + inbox_public_key_hex)
      const hubPrivateKeyBase64 = btoa(
        String.fromCharCode(...hexToBytes(hubKey.privateKey))
      );
      const addMessage = 'add' + bytesToHex(new Uint8Array(inboxKeypair.public_key));
      const addMessageBase64 = btoa(addMessage);
      const hubSignatureBase64 = await cryptoProvider.signEd448(
        hubPrivateKeyBase64,
        addMessageBase64
      );
      const hubSignatureHex = base64ToHex(hubSignatureBase64);

      // Build inbox signature: sign("add" + hub_public_key)
      const inboxPrivateKeyBase64 = numberArrayToBase64(inboxKeypair.private_key);
      const inboxAddMessage = 'add' + hubKey.publicKey;
      const inboxAddMessageBase64 = btoa(inboxAddMessage);
      const inboxSignatureBase64 = await cryptoProvider.signEd448(
        inboxPrivateKeyBase64,
        inboxAddMessageBase64
      );
      const inboxSignatureHex = base64ToHex(inboxSignatureBase64);

      await client.postHubAdd({
        hub_address: hubKey.address!,
        hub_public_key: hubKey.publicKey,
        hub_signature: hubSignatureHex,
        inbox_public_key: bytesToHex(new Uint8Array(inboxKeypair.public_key)),
        inbox_signature: inboxSignatureHex,
      });
    } catch (error) {
      // Continue - the space is saved, just won't receive real-time updates
    }

    // Request WebSocket subscription to new inbox
    if (onListenRequest) {
      onListenRequest([inboxAddress]);
    }

    // Save inbox key — the per-device MAILBOX key (hub registration + WS
    // listen + inbox deletion). This deliberately overwrites the payload's
    // 'inbox' entry (another device's mailbox, useless here). It is NOT the
    // signing identity: that is the 'signing' key the payload loop saved
    // above — the join-bound keypair every receiver's member table resolves
    // signatures against. Pre-split payloads have no 'signing' entry; then
    // this device signs with this fresh key via the getSpaceSigningKey
    // fallback and control messages stay broken until a device holding the
    // original promotes it (see promoteSpaceSigningKeys in configService).
    saveSpaceKey({
      spaceId,
      keyId: 'inbox',
      address: inboxAddress,
      publicKey: bytesToHex(new Uint8Array(inboxKeypair.public_key)),
      privateKey: bytesToHex(new Uint8Array(inboxKeypair.private_key)),
    });

    // Save current user as a member of the synced space. The row's
    // inbox_address is the SIGNING identity binding (what the join broadcast
    // announced), never this device's fresh mailbox address — binding the
    // mailbox key here is what used to make the user's other devices'
    // signatures unresolvable locally. Unknown (pre-split payload) → leave
    // empty rather than assert a wrong binding.
    if (userInfo?.address) {
      const payloadSigning = keys.find((k) => k.keyId === 'signing');
      const signingAddress = payloadSigning
        ? payloadSigning.address ??
          deriveAddress(Uint8Array.from(hexToBytes(payloadSigning.publicKey)))
        : '';
      const adapter = getMMKVAdapter();
      await adapter.saveSpaceMember(spaceId, {
        address: userInfo.address,
        display_name: userInfo.displayName,
        profile_image: userInfo.profileImage,
        inbox_address: signingAddress,
      });
    }

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Sync all spaces from config
 *
 * @param spaceKeys - Array of space key info from UserConfig.spaceKeys
 * @param userInfo - Current user's info to save as a member
 * @param onListenRequest - Callback to request WebSocket subscriptions
 * @returns Number of spaces successfully synced
 */
export async function syncSpacesFromConfig(
  spaceKeys: SpaceKeyInfo[],
  userInfo?: SyncUserInfo,
  onListenRequest?: (inboxAddresses: string[]) => void
): Promise<number> {
  // Process spaces sequentially with delays to avoid CPU overload
  // Parallel processing causes UI freezes due to heavy crypto operations
  const DELAY_BETWEEN_SPACES_MS = 1000; // 1 second between spaces for smoother UI
  let successCount = 0;

  for (let i = 0; i < spaceKeys.length; i++) {
    const spaceKeyInfo = spaceKeys[i];
    const result = await syncSpaceFromConfig(spaceKeyInfo, userInfo, onListenRequest);
    if (result) {
      successCount++;
    }

    // Add delay between spaces to yield to UI thread (except for last one)
    if (i < spaceKeys.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_SPACES_MS));
    }
  }

  return successCount;
}
