/**
 * Space Session Initialization
 *
 * This module implements the Triple Ratchet session establishment for spaces,
 * which generates the invite pool (evals) used for one-time invite links.
 *
 * Ported from desktop's EstablishTripleRatchetSessionForSpace
 */

import { bytesToHex, hexToBytes } from '@quilibrium/quorum-shared';
import { NativeCryptoProvider } from './native-provider';
import { arrayToBase64, base64ToArray } from '@/utils/encoding';
import { deriveAddress } from '@/utils/deriveAddress';


// Types matching desktop SDK
export interface Ed448Keypair {
  type: 'ed448';
  public_key: number[];
  private_key: number[];
}

export interface X448Keypair {
  type: 'x448';
  public_key: number[];
  private_key: number[];
}

export interface InboxKeyset {
  inbox_address: string;
  inbox_key: Ed448Keypair;
  inbox_encryption_key: X448Keypair;
}

export interface DeviceKeyset {
  identity_key: X448Keypair;
  pre_key: X448Keypair;
  inbox_keyset: InboxKeyset;
}

export interface UserKeyset {
  user_key: Ed448Keypair;
  peer_key: X448Keypair;
}

export interface DeviceRegistration {
  identity_public_key: string;
  pre_public_key: string;
  inbox_registration: {
    inbox_address: string;
    inbox_encryption_public_key: string;
    inbox_public_key: string;
  };
}

export interface UserRegistration {
  user_address: string;
  user_public_key: string;
  peer_public_key: string;
  device_registrations: DeviceRegistration[];
}

export interface TripleRatchetInitBundle {
  ratchet_state: string;
  metadata: Record<string, string>;
}

export interface SpaceSessionResult {
  state: string;
  template: any;
  evals: number[][];
}

const crypto = new NativeCryptoProvider();

/**
 * Create a new user keyset with the given Ed448 key
 */
export function newUserKeyset(userKey: Ed448Keypair, peerKey: X448Keypair): UserKeyset {
  return {
    user_key: userKey,
    peer_key: peerKey,
  };
}

/**
 * Create a new inbox keyset
 */
export async function newInboxKeyset(): Promise<InboxKeyset> {
  const inboxKey = await crypto.generateEd448();
  const inboxEncryptionKey = await crypto.generateX448();

  // Compute inbox address from public key hash using multihash
  const inboxAddress = deriveAddress(new Uint8Array(inboxKey.public_key));

  return {
    inbox_address: inboxAddress,
    inbox_key: {
      type: 'ed448',
      public_key: inboxKey.public_key,
      private_key: inboxKey.private_key,
    },
    inbox_encryption_key: {
      type: 'x448',
      public_key: inboxEncryptionKey.public_key,
      private_key: inboxEncryptionKey.private_key,
    },
  };
}

/**
 * Create a new device keyset
 */
export async function newDeviceKeyset(): Promise<DeviceKeyset> {
  const identityKey = await crypto.generateX448();
  const preKey = await crypto.generateX448();
  const inboxKeyset = await newInboxKeyset();

  return {
    identity_key: {
      type: 'x448',
      public_key: identityKey.public_key,
      private_key: identityKey.private_key,
    },
    pre_key: {
      type: 'x448',
      public_key: preKey.public_key,
      private_key: preKey.private_key,
    },
    inbox_keyset: inboxKeyset,
  };
}

/**
 * Construct a user registration from keysets
 */
export async function constructUserRegistration(
  userKeyset: UserKeyset,
  existingDeviceKeysets: DeviceRegistration[],
  deviceKeysets: DeviceKeyset[]
): Promise<UserRegistration> {
  // Compute user address from public key hash using multihash
  const userAddress = deriveAddress(new Uint8Array(userKeyset.user_key.public_key));

  return {
    user_address: userAddress,
    user_public_key: bytesToHex(new Uint8Array(userKeyset.user_key.public_key)),
    peer_public_key: bytesToHex(new Uint8Array(userKeyset.peer_key.public_key)),
    device_registrations: [
      ...existingDeviceKeysets,
      ...deviceKeysets.map((d) => ({
        identity_public_key: bytesToHex(new Uint8Array(d.identity_key.public_key)),
        pre_public_key: bytesToHex(new Uint8Array(d.pre_key.public_key)),
        inbox_registration: {
          inbox_address: d.inbox_keyset.inbox_address,
          inbox_encryption_public_key: bytesToHex(new Uint8Array(d.inbox_keyset.inbox_encryption_key.public_key)),
          inbox_public_key: bytesToHex(new Uint8Array(d.inbox_keyset.inbox_key.public_key)),
        },
      })),
    ],
  };
}

/**
 * Create group info for triple ratchet initialization
 * Creates temporary user/device keysets for the 4-party DKG
 */
async function createTripleRatchetGroupInfo(): Promise<{
  user_keyset: UserKeyset;
  device_keyset: DeviceKeyset;
  registration: UserRegistration;
}> {
  const userKey = await crypto.generateEd448();
  const peerKey = await crypto.generateX448();

  const userKeyset = newUserKeyset(
    {
      type: 'ed448',
      public_key: userKey.public_key,
      private_key: userKey.private_key,
    },
    {
      type: 'x448',
      public_key: peerKey.public_key,
      private_key: peerKey.private_key,
    }
  );
  const deviceKeyset = await newDeviceKeyset();
  const registration = await constructUserRegistration(userKeyset, [], [deviceKeyset]);

  return {
    user_keyset: userKeyset,
    device_keyset: deviceKeyset,
    registration,
  };
}

/**
 * Run a new triple ratchet session for a participant
 *
 * The peers array must contain 171-byte entries for each peer (excluding self):
 * - inbox_encryption_public_key (57 bytes Ed448 point)
 * - identity_public_key (57 bytes Ed448 point)
 * - pre_public_key (57 bytes Ed448 point)
 */
async function newTripleRatchetSession(
  deviceKeyset: DeviceKeyset,
  peers: UserRegistration[]
): Promise<TripleRatchetInitBundle> {
  // Get self's public key to exclude from peer list
  const selfPubKey = bytesToHex(new Uint8Array(deviceKeyset.inbox_keyset.inbox_encryption_key.public_key));

  // Find self in peer list
  const selfReg = peers.find((p) =>
    p.device_registrations.find(
      (d) => d.inbox_registration.inbox_encryption_public_key === selfPubKey
    )
  );
  if (!selfReg) {
    throw new Error('Self not found in peer set');
  }

  // Build peer set excluding self, sorted by inbox_encryption_public_key
  const peerset = peers
    .map((p) => p.device_registrations)
    .filter(
      (devices) =>
        !devices.find(
          (d) => d.inbox_registration.inbox_encryption_public_key === selfPubKey
        )
    )
    .flatMap((devices) => devices)
    .sort((a, b) =>
      a.inbox_registration.inbox_encryption_public_key.localeCompare(
        b.inbox_registration.inbox_encryption_public_key
      )
    );

  if (peerset.length < 3) {
    throw new Error(`Insufficient peer set size: ${peerset.length}, need at least 3`);
  }

  // Build 171-byte peer entries: inbox_encryption_public_key + identity_public_key + pre_public_key
  const peerBytes = peerset.map((p) => {
    const inboxBytes = hexToBytes(p.inbox_registration.inbox_encryption_public_key);
    const identityBytes = hexToBytes(p.identity_public_key);
    const preBytes = hexToBytes(p.pre_public_key);

    // Concatenate all three keys
    const combined = new Uint8Array(inboxBytes.length + identityBytes.length + preBytes.length);
    combined.set(inboxBytes, 0);
    combined.set(identityBytes, inboxBytes.length);
    combined.set(preBytes, inboxBytes.length + identityBytes.length);

    return Array.from(combined);
  });

  const result = await crypto.newTripleRatchet({
    peers: peerBytes,
    peer_key: deviceKeyset.inbox_keyset.inbox_encryption_key.private_key,
    identity_key: deviceKeyset.identity_key.private_key,
    signed_pre_key: deviceKeyset.pre_key.private_key,
    threshold: 2,
    async_dkg_ratchet: true,
  });

  return {
    ratchet_state: result.ratchet_state,
    metadata: result.metadata,
  };
}

/**
 * Establish a triple ratchet session for a space
 *
 * This creates a 4-party DKG to generate the invite pool (evals).
 * Returns the state, template, and array of invite evals.
 */
export async function establishTripleRatchetSessionForSpace(
  userKeyset: UserKeyset,
  deviceKeyset: DeviceKeyset,
  registration: UserRegistration,
  total: number = 10000
): Promise<SpaceSessionResult> {
  // Filter registration to only include current device
  let filteredRegistration = { ...registration };
  if (filteredRegistration.device_registrations.length > 1) {
    const peerPubKey = bytesToHex(new Uint8Array(deviceKeyset.inbox_keyset.inbox_encryption_key.public_key));
    filteredRegistration.device_registrations = filteredRegistration.device_registrations.filter(
      (d) => d.inbox_registration.inbox_encryption_public_key === peerPubKey
    );
  }

  // Create 4 participants: the real user + 3 ephemeral ones
  const groupInfos = await Promise.all([1, 2, 3].map(() => createTripleRatchetGroupInfo()));
  const set = [
    { user_keyset: userKeyset, device_keyset: deviceKeyset, registration: filteredRegistration },
    ...groupInfos,
  ];

  // Initialize all 4 sessions
  let outs = await Promise.all(
    set.map((info) =>
      newTripleRatchetSession(info.device_keyset, set.map((s) => s.registration))
    )
  );

  // Get sender identifiers (base64 encoded public keys)
  const senders = set.map((info) =>
    arrayToBase64(info.device_keyset.inbox_keyset.inbox_encryption_key.public_key)
  );

  // Run all 4 init rounds
  const initRounds = [
    crypto.tripleRatchetInitRound1.bind(crypto),
    crypto.tripleRatchetInitRound2.bind(crypto),
    crypto.tripleRatchetInitRound3.bind(crypto),
    crypto.tripleRatchetInitRound4.bind(crypto),
  ];

  for (const initRound of initRounds) {
    // Collect metadata from all participants
    const inboxes: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 4; i++) {
      const sender = senders[i];
      if (!inboxes[sender]) inboxes[sender] = {};
      for (const recipient of Object.keys(outs[i].metadata)) {
        if (!inboxes[recipient]) inboxes[recipient] = {};
        inboxes[recipient][sender] = outs[i].metadata[recipient];
      }
    }

    // Run the init round for each participant
    outs = await Promise.all(
      outs.map(async (out, i) => {
        const result = await initRound({
          ratchet_state: out.ratchet_state,
          metadata: inboxes[senders[i]] || {},
        });
        return {
          ratchet_state: result.ratchet_state,
          metadata: result.metadata,
        };
      })
    );
  }

  // Find participants with id=1 and id=2 (needed for resize)
  const index1 = [0, 1, 2, 3].find((i) => {
    try {
      const state = JSON.parse(outs[i].ratchet_state);
      const dkgRatchet = JSON.parse(state.dkg_ratchet);
      return dkgRatchet.id === 1;
    } catch (e) {
      return false;
    }
  });

  const index2 = [0, 1, 2, 3].find((i) => {
    const state = JSON.parse(outs[i].ratchet_state);
    const dkgRatchet = JSON.parse(state.dkg_ratchet);
    return dkgRatchet.id === 2;
  });

  if (index1 === undefined || index2 === undefined) {
    throw new Error('Failed to find required DKG participants');
  }

  // Initialize the ratchet with a message
  const initializeResult = await crypto.tripleRatchetEncrypt({
    ratchet_state: outs[index1].ratchet_state,
    message: Array.from(new TextEncoder().encode('initialize')),
  });

  // All participants decrypt the initialize message
  const initializedSet = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const result = await crypto.tripleRatchetDecrypt({
        ratchet_state: outs[i].ratchet_state,
        envelope: initializeResult.envelope,
      });
      return result;
    })
  );

  // Commit the initialization
  const commitResult = await crypto.tripleRatchetEncrypt({
    ratchet_state: initializedSet[index1].ratchet_state,
    message: Array.from(new TextEncoder().encode('commit')),
  });

  // All participants decrypt the commit message
  const commitInitialized = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const result = await crypto.tripleRatchetDecrypt({
        ratchet_state: initializedSet[i].ratchet_state,
        envelope: commitResult.envelope,
      });
      return result;
    })
  );

  // Get the scalar from participant 2 for resize
  const state2 = JSON.parse(commitInitialized[index2].ratchet_state);
  const dkgRatchet2 = JSON.parse(state2.dkg_ratchet);
  const otherScalar = bytesToHex(base64ToArray(dkgRatchet2.scalar));

  // Generate the evals pool
  const evals = await crypto.tripleRatchetResizeForInvites(
    commitInitialized[index1].ratchet_state,
    otherScalar,
    2,
    total
  );

  // Build the final state and template
  const state = JSON.parse(commitInitialized[index1].ratchet_state);
  const stateTemplate = JSON.parse(commitInitialized[index2].ratchet_state);

  // Update state with proper peer mappings
  const selfPubKeyBase64 = arrayToBase64(deviceKeyset.inbox_keyset.inbox_encryption_key.public_key);

  state.current_receiving_chain_length = {
    [selfPubKeyBase64]: 1,
  };

  // Generate new secret pair for the ratchet
  const secretPair = await crypto.generateX448();
  const evalPriv = evals.shift()!;
  const evalPubBase64 = await crypto.getPublicKeyX448(arrayToBase64(evalPriv));

  // Update dkg_ratchet in state
  const existingDkgRatchet = JSON.parse(state.dkg_ratchet);
  state.dkg_ratchet = JSON.stringify({
    threshold: 2,
    total: 1,
    id: 1,
    frags_for_counterparties: {},
    frags_from_counterparties: {},
    zkpok: existingDkgRatchet.zkpok,
    secret: arrayToBase64(secretPair.private_key),
    scalar: arrayToBase64(evalPriv),
    generator: 'FPow8lt5CJityNdOLBO9/cQ5fOYc/9M618KgBR6ceIdAmKNsc3PqS2LHyVY3IHaIJLy2bnFGP2kA',
    public_key: existingDkgRatchet.public_key,
    point: evalPubBase64,
    random_commitment_point: arrayToBase64(secretPair.public_key),
    round: 4,
    zkcommits_from_counterparties: {},
    points_from_counterparties: {},
  });
  state.next_dkg_ratchet = state.dkg_ratchet;

  // Update template dkg_ratchet with placeholders
  stateTemplate.dkg_ratchet = JSON.stringify({
    threshold: 2,
    total: -1,
    id: -1,
    frags_for_counterparties: {},
    frags_from_counterparties: {},
    zkpok: existingDkgRatchet.zkpok,
    secret: '<missing gen priv>',
    scalar: '<missing eval>',
    generator: 'FPow8lt5CJityNdOLBO9/cQ5fOYc/9M618KgBR6ceIdAmKNsc3PqS2LHyVY3IHaIJLy2bnFGP2kA',
    public_key: existingDkgRatchet.public_key,
    point: '<missing raised eval>',
    random_commitment_point: '<missing gen pub>',
    round: 4,
    zkcommits_from_counterparties: {},
    points_from_counterparties: {},
  });
  stateTemplate.next_dkg_ratchet = stateTemplate.dkg_ratchet;

  // Update peer mappings
  state.id_peer_map = {
    1: {
      public_key: selfPubKeyBase64,
      identity_public_key: arrayToBase64(deviceKeyset.identity_key.public_key),
      signed_pre_public_key: arrayToBase64(deviceKeyset.pre_key.public_key),
    },
  };
  stateTemplate.id_peer_map = state.id_peer_map;

  state.peer_channels = {};
  stateTemplate.peer_channels = {};

  state.peer_id_map = {
    [selfPubKeyBase64]: 1,
  };
  stateTemplate.peer_id_map = {
    [selfPubKeyBase64]: 1,
  };

  state.peer_key = arrayToBase64(deviceKeyset.inbox_keyset.inbox_encryption_key.private_key);
  stateTemplate.peer_key = '<missing ibx priv>';

  state.previous_receiving_chain_length = {};
  stateTemplate.previous_receiving_chain_length = {};

  stateTemplate.ephemeral_private_key = '<missing gen priv>';

  return {
    state: JSON.stringify(state),
    template: stateTemplate,
    evals: evals,
  };
}
