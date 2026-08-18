/**
 * InviteService - Handles space invite link generation and parsing
 *
 * Provides:
 * - Private invite link generation (one-time use)
 * - Invite link parsing
 * - Invite link validation
 *
 * Invite link formats:
 * - Private: https://qm.one/#spaceId={spaceId}&configKey={configKey}&template={template}&secret={secret}&hubKey={hubKey}
 * - Public: https://qm.one/invite/#spaceId={spaceId}&configKey={configKey}
 */

import { base64ToHex, hexToBase64, numberArrayToBase64 } from '@/utils/encoding';
import { logger, bytesToHex, hexToBytes } from '@quilibrium/quorum-shared';
import { getQuorumClient } from '../api/quorumClient';
import { getSpace, getSpaceKey, saveSpace } from '../config/spaceStorage';
import { encryptionStateStorage } from '../crypto/encryption-state-storage';
import { NativeCryptoProvider } from '../crypto/native-provider';
import { sendSpaceManifestMessage, type SpaceManifest } from './spaceMessageService';
import { republishSpace } from './spaceService';

/**
 * Convert a UTF-8 string to hex encoding
 * React Native compatible - doesn't use Buffer
 */
function stringToHex(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  return bytesToHex(bytes);
}

// Invite domain configuration
const INVITE_DOMAINS = {
  production: 'app.quorummessenger.com',
  staging: 'test.quorummessenger.com',
  development: 'localhost:3000',
};

// Valid invite link prefixes for parsing
const VALID_INVITE_PREFIXES = [
  'https://qm.one/',
  'https://quorummessenger.com/i/',
  'https://www.quorummessenger.com/i/',
  'https://app.quorummessenger.com/#',
  'https://app.quorummessenger.com/invite/#',
  'http://localhost:3000/',
  'http://localhost:3000/i/',
  'qm.one/',
];

export interface InviteParams {
  spaceId: string;
  configKey: string;
  template?: string;
  secret?: string;
  hubKey?: string;
}

export interface GenerateInviteResult {
  inviteLink: string;
  isOneTimeUse: boolean;
}

/**
 * Get the base URL for invite links
 */
function getInviteUrlBase(isPublicInvite: boolean = false): string {
  const domain = INVITE_DOMAINS.production;
  const path = isPublicInvite ? '/invite/' : '/';
  return `https://${domain}${path}`;
}

/**
 * Generate a private invite link for a space (one-time use)
 *
 * This creates a link with all the cryptographic material needed to join:
 * - configKey: For decrypting space manifest
 * - template: DKG ratchet state
 * - secret: One-time join secret
 * - hubKey: For registering with the hub
 */
export async function generatePrivateInviteLink(spaceId: string): Promise<GenerateInviteResult> {
  // Get required keys
  const configKey = getSpaceKey(spaceId, 'config');
  if (!configKey?.privateKey) {
    throw new Error('Config key not found for space');
  }

  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey?.privateKey) {
    throw new Error('Hub key not found for space');
  }

  // Self-heal: ensure the manifest is on the server before handing out an
  // invite. If the original POST at space-creation time silently failed
  // (network blip, server transient), the recipient would see "manifest not
  // found" forever. Re-uploading is idempotent on the server (newer
  // timestamp wins; same data is a no-op).
  const space = getSpace(spaceId);
  logger.debug(`[invite] self-heal: spaceId=${spaceId.slice(0, 12)} hasLocalSpace=${!!space}`);
  if (space) {
    try {
      const client = getQuorumClient();
      await client.getSpaceManifest(spaceId);
      logger.debug('[invite] self-heal: manifest already on server, skipping upload');
    } catch (err: any) {
      logger.debug(`[invite] self-heal: GET threw status=${err?.status} msg=${err?.message}`);
      if (err?.status === 404 || /not found/i.test(err?.message ?? '')) {
        // 404 on the manifest endpoint means the server has no record of
        // the space at all (registration → hub-membership → manifest must
        // all be re-published). Manifest-only upload would 404 again on
        // the missing registration check, so we run the full sequence.
        logger.debug('[invite] self-heal: republishing space (registration + hub membership + manifest)');
        await republishSpace(spaceId);
        logger.debug('[invite] self-heal: republish completed');
      } else {
        logger.debug('[invite] self-heal: non-404 error, skipping re-upload');
      }
    }
  }

  // Get encryption state for template and secret
  const conversationId = `${spaceId}/${spaceId}`;
  const encryptionStates = encryptionStateStorage.getEncryptionStates(conversationId);

  if (encryptionStates.length === 0) {
    throw new Error('No encryption state found for space. Cannot generate invite.');
  }

  const sets = JSON.parse(encryptionStates[0].state);


  // Check if we have the template and evals
  // The evals pool is created when a space is created (via establishTripleRatchetSessionForSpace)
  // or when a rekey is received from another member who generated new invites
  if (!sets.template) {
    throw new Error('Cannot generate invites from this space. The invite pool was not initialized.');
  }

  if (!sets.evals || sets.evals.length === 0) {
    throw new Error('No invite slots remaining. All invites have been used.');
  }

  // Build the template state matching desktop's approach
  // CRITICAL: Make a deep copy of template so we don't mutate the original!
  // The original template must remain unchanged for subsequent invites
  const state = JSON.parse(JSON.stringify(sets.template));
  const ratchet = JSON.parse(state.dkg_ratchet);

  // Calculate ratchet ID based on remaining evals (matches desktop)
  ratchet.id = 10001 - sets.evals.length;

  // Extract root_key from the state object
  if (!sets.state) {
    throw new Error('Encryption state is missing state data.');
  }

  const parsedState = typeof sets.state === 'string' ? JSON.parse(sets.state) : sets.state;

  // Match desktop exactly: only copy root_key and update dkg_ratchet
  // The template already has the correct header keys and other state from DKG initialization
  state.root_key = parsedState.root_key;
  state.dkg_ratchet = JSON.stringify(ratchet);


  // Convert template to hex
  const template = stringToHex(JSON.stringify(state));

  // Consume one eval for the secret
  const indexSecretRaw = sets.evals.shift();
  const secret = bytesToHex(new Uint8Array(indexSecretRaw));

  // Update encryption state after consuming eval
  encryptionStateStorage.saveEncryptionState({
    ...encryptionStates[0],
    state: JSON.stringify(sets),
    timestamp: Date.now(),
  });

  // Construct private invite link
  const inviteLink = `${getInviteUrlBase(false)}#spaceId=${spaceId}&configKey=${configKey.privateKey}&template=${template}&secret=${secret}&hubKey=${hubKey.privateKey}`;

  return {
    inviteLink,
    isOneTimeUse: true,
  };
}

/**
 * Parse an invite link to extract parameters
 */
export function parseInviteLink(inviteLink: string): InviteParams | null {
  if (!inviteLink || typeof inviteLink !== 'string') {
    return null;
  }

  const trimmed = inviteLink.trim();

  // Check if it matches any valid prefix
  const isValidPrefix = VALID_INVITE_PREFIXES.some(
    (prefix) => trimmed.startsWith(prefix) || trimmed.startsWith(prefix.replace('https://', ''))
  );

  if (!isValidPrefix) {
    return null;
  }

  // Find the hash fragment
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex < 0 || hashIndex === trimmed.length - 1) {
    return null;
  }

  const hashContent = trimmed.slice(hashIndex + 1);
  const params: Record<string, string> = {};

  // Parse key=value pairs
  for (const pair of hashContent.split('&')) {
    const [key, value] = pair.split('=');
    if (!key || !value) continue;

    if (['spaceId', 'configKey', 'template', 'secret', 'hubKey'].includes(key)) {
      params[key] = value;
    }
  }

  // spaceId and configKey are required
  if (!params.spaceId || !params.configKey) {
    return null;
  }

  return {
    spaceId: params.spaceId,
    configKey: params.configKey,
    template: params.template,
    secret: params.secret,
    hubKey: params.hubKey,
  };
}

/**
 * Validate an invite link format
 */
export function isValidInviteLink(inviteLink: string): boolean {
  return parseInviteLink(inviteLink) !== null;
}

/**
 * Check if an invite link is a public invite (no template/secret)
 */
export function isPublicInvite(inviteLink: string): boolean {
  const params = parseInviteLink(inviteLink);
  if (!params) return false;

  // Public invites don't have template and secret
  return !params.template && !params.secret;
}

/**
 * Get a shortened version of the invite link for display
 */
export function getShortenedInviteLink(inviteLink: string): string {
  const params = parseInviteLink(inviteLink);
  if (!params) return inviteLink;

  // Show just the domain and first 8 chars of spaceId
  const shortSpaceId = params.spaceId.substring(0, 8);
  return `https://app.quorummessenger.com/invite/#${shortSpaceId}...`;
}

export interface GeneratePublicInviteResult {
  inviteLink: string;
  isPublic: true;
}

/**
 * `enqueueOutbound` from `useWebSocket()`. Required, not optional: publishing a
 * public link without telling existing members is the defect this parameter
 * exists to make unrepresentable, so a caller cannot silently omit it.
 */
export type EnqueueOutbound = (prepare: () => Promise<string[]>) => void;

/**
 * Helper to convert int64 to bytes (big-endian)
 */
function int64ToBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(value), false);
  return bytes;
}

/**
 * Generate a public invite link for a space (reusable, ~200 uses)
 *
 * This creates a public link that stores evaluations on the server.
 * The link only contains spaceId and configKey - evaluations are fetched from server.
 */
export async function generatePublicInviteLink(
  spaceId: string,
  enqueueOutbound: EnqueueOutbound,
): Promise<GeneratePublicInviteResult> {
  const cryptoProvider = new NativeCryptoProvider();
  const client = getQuorumClient();

  const space = getSpace(spaceId);
  if (!space) {
    throw new Error('Space not found');
  }

  // Get required keys
  const ownerKey = getSpaceKey(spaceId, 'owner');
  if (!ownerKey?.privateKey) {
    throw new Error('Owner key not found for space. Only space owners can generate public invites.');
  }

  const hubKey = getSpaceKey(spaceId, 'hub');
  if (!hubKey?.privateKey) {
    throw new Error('Hub key not found for space');
  }

  // Get encryption state for evaluations
  const conversationId = `${spaceId}/${spaceId}`;
  const encryptionStates = encryptionStateStorage.getEncryptionStates(conversationId);

  if (encryptionStates.length === 0) {
    throw new Error('No encryption state found for space. Cannot generate public invite.');
  }

  const session = JSON.parse(encryptionStates[0].state);

  if (!session.evals || session.evals.length === 0) {
    throw new Error('No invite evaluations available. Cannot generate public invite.');
  }

  if (!session.template) {
    throw new Error('No template found in encryption state. Cannot generate public invite.');
  }


  // Use the EXISTING space config key (not a new one)
  // This ensures all space members use the same config key for hub envelope encryption/decryption
  const configKey = getSpaceKey(spaceId, 'config');
  if (!configKey?.privateKey || !configKey?.publicKey) {
    throw new Error('Config key not found for space. Cannot generate public invite.');
  }
  const configPrivateKeyHex = configKey.privateKey;
  const configPublicKeyHex = configKey.publicKey;

  // We still need a config keypair for encryption operations
  const configPair = {
    public_key: Array.from(hexToBytes(configPublicKeyHex)),
    private_key: Array.from(hexToBytes(configPrivateKeyHex)),
  };

  // Generate ephemeral key for encryption
  const ephemeralKey = await cryptoProvider.generateX448();
  const ephemeralPublicKeyHex = bytesToHex(new Uint8Array(ephemeralKey.public_key));

  // Option 2: server now serves the same eval to every joiner instead of
  // popping one per join, so we only need to upload a single evaluation
  // here (was previously generating up to 200, draining the local pool by
  // 200 per public-invite gen and burning ~200x the crypto work for no
  // functional gain). The retained eval is still per-public-invite-link
  // — generating a new public invite still creates a fresh eval.
  const MAX_PUBLIC_EVALS = 1;
  const evalsToProcess = session.evals.slice(0, MAX_PUBLIC_EVALS);
  const spaceEvals: string[] = [];
  let idCounter = 10001 - session.evals.length;


  for (const evalData of evalsToProcess) {
    const sendState = JSON.parse(JSON.stringify(session.template));
    const ratchet = JSON.parse(sendState.dkg_ratchet);

    ratchet.id = idCounter;

    // Copy root_key from current state
    if (session.state) {
      const parsedState = typeof session.state === 'string' ? JSON.parse(session.state) : session.state;
      sendState.root_key = parsedState.root_key;
    }

    // Generate keys for this eval
    const secretPair = await cryptoProvider.generateX448();
    const ephPair = await cryptoProvider.generateX448();

    // Set ratchet parameters
    const evalBytes = new Uint8Array(evalData);
    ratchet.secret = numberArrayToBase64(Array.from(secretPair.private_key));
    ratchet.scalar = numberArrayToBase64(Array.from(evalBytes));

    // Get the point from the scalar (getPublicKeyX448 returns base64 string directly)
    const evalPointBase64 = await cryptoProvider.getPublicKeyX448(numberArrayToBase64(Array.from(evalBytes)));
    ratchet.point = evalPointBase64;
    ratchet.random_commitment_point = numberArrayToBase64(Array.from(secretPair.public_key));

    sendState.dkg_ratchet = JSON.stringify(ratchet);
    sendState.next_dkg_ratchet = JSON.stringify(ratchet);
    sendState.ephemeral_private_key = numberArrayToBase64(Array.from(ephPair.private_key));

    const template = JSON.stringify(sendState);

    const evalPayload = {
      id: idCounter,
      template: template,
      secret: bytesToHex(evalBytes),
      hubKey: hubKey.privateKey,
    };

    // Encrypt the payload
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(evalPayload));
    const ciphertext = await cryptoProvider.encryptInboxMessage({
      inbox_public_key: configPair.public_key,
      ephemeral_private_key: ephemeralKey.private_key,
      plaintext: Array.from(plaintextBytes),
    });

    spaceEvals.push(ciphertext);
    idCounter++;
  }


  // Build the payload to sign (all evals concatenated as UTF-8 bytes)
  const allEvalsBytes: number[] = [];
  for (const evalCiphertext of spaceEvals) {
    const evalBytes = new TextEncoder().encode(evalCiphertext);
    allEvalsBytes.push(...Array.from(evalBytes));
  }

  // Sign the payload with owner key
  const ownerPrivateKeyBase64 = hexToBase64(ownerKey.privateKey);
  const payloadBase64 = numberArrayToBase64(allEvalsBytes);
  const signatureBase64 = await cryptoProvider.signEd448(ownerPrivateKeyBase64, payloadBase64);
  const signatureHex = base64ToHex(signatureBase64);

  // Upload the evaluations to the server
  try {
    await client.postInviteEvals({
      space_address: spaceId,
      config_public_key: configPublicKeyHex,
      space_evals: spaceEvals,
      ephemeral_public_key: ephemeralPublicKeyHex,
      owner_public_key: ownerKey.publicKey,
      owner_signature: signatureHex,
    });
  } catch (error) {
    throw new Error('Failed to upload invite evaluations to server');
  }

  // Construct the public invite link BEFORE the manifest is serialized below.
  // The link is deterministic from the existing config key, so it can be built
  // as soon as that key is known.
  const inviteLink = `${getInviteUrlBase(true)}#spaceId=${spaceId}&configKey=${configPrivateKeyHex}`;

  const timestamp = Date.now();

  // ORDERING IS LOAD-BEARING: the manifest is a snapshot of `space`, so both
  // fields must be set before JSON.stringify below or the manifest we publish
  // advertises no invite URL and a joiner fetching it lands without one.
  // Desktop sets inviteUrl before encrypting for the same reason
  // (InvitationService.ts:363).
  space.inviteUrl = inviteLink;
  // Keep the record monotonic. The receive path applies a manifest when
  // `manifest.timestamp >= stored modifiedDate` and then writes the record
  // wholesale (WebSocketContext.tsx:1921-1937). Broadcasting a fresh timestamp
  // alongside a stale modifiedDate would move a member's watermark BACKWARDS,
  // weakening the guard against the hub replaying historical log entries.
  space.modifiedDate = timestamp;

  // Also upload the space manifest encrypted with the new config key
  // Use the same ephemeral key as the evals (matches desktop behavior)
  const spaceJson = JSON.stringify(space);
  const spaceBytes = new TextEncoder().encode(spaceJson);

  const manifestCiphertext = await cryptoProvider.encryptInboxMessage({
    inbox_public_key: configPair.public_key,
    ephemeral_private_key: ephemeralKey.private_key,
    plaintext: Array.from(spaceBytes),
  });

  // Sign the manifest with timestamp (matches desktop)
  const timestampBytes = int64ToBytes(timestamp);
  const manifestWithTimestamp = new Uint8Array([
    ...new TextEncoder().encode(manifestCiphertext),
    ...timestampBytes,
  ]);
  const manifestPayloadBase64 = numberArrayToBase64(Array.from(manifestWithTimestamp));
  const manifestSignatureBase64 = await cryptoProvider.signEd448(ownerPrivateKeyBase64, manifestPayloadBase64);
  const manifestSignatureHex = base64ToHex(manifestSignatureBase64);

  const manifest: SpaceManifest = {
    space_address: spaceId,
    space_manifest: manifestCiphertext,
    ephemeral_public_key: ephemeralPublicKeyHex,
    timestamp,
    owner_public_key: ownerKey.publicKey,
    owner_signature: manifestSignatureHex,
  };

  await client.postSpaceManifest(spaceId, manifest);

  // The POST above only serves FUTURE joiners: no client ever refetches the
  // manifest for a space it has already joined (every getSpaceManifest call site
  // on both clients is a join or a device-restore). Existing members learn about
  // the new URL exclusively through this control message, so without it a public
  // link never reaches anybody but its author.
  //
  // Reuse the SAME manifest object rather than rebuilding one, and do not route
  // this through broadcastSpaceUpdate: that mints its own ephemeral X448 key,
  // which would break the invite path's deliberate alignment between the eval's
  // ephemeral key and the manifest's.
  enqueueOutbound(async () => [await sendSpaceManifestMessage(spaceId, manifest)]);

  // Remove the processed evals from the local pool (they're now on the server)
  session.evals = session.evals.slice(MAX_PUBLIC_EVALS);
  encryptionStateStorage.saveEncryptionState({
    ...encryptionStates[0],
    state: JSON.stringify(session),
    timestamp: Date.now(),
  });

  // `space` already carries inviteUrl and the bumped modifiedDate (set above, so
  // the published manifest includes them). Persisting only now means a failed
  // upload leaves no local record claiming a link that was never published.
  saveSpace(space);

  return {
    inviteLink,
    isPublic: true,
  };
}

