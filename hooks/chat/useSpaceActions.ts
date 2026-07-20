/**
 * useSpaceActions - Hooks for space creation, joining, and invite validation
 *
 * Provides:
 * - useCreateSpace: Mutation to create a new space
 * - useJoinSpace: Mutation to join an existing space via invite link
 * - useValidateInvite: Query to validate and preview an invite link
 */

import { useAuth } from '@/context';
import { base64ToHex, numberArrayToBase64 } from '@/utils/encoding';
import { getQuorumClient } from '@/services/api/quorumClient';
import { saveSpace, saveSpaceKey } from '@/services/config/spaceStorage';
import { encryptionStateStorage } from '@/services/crypto/encryption-state-storage';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, type Space } from '@quilibrium/quorum-shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import bs58 from 'bs58';
import * as multihashes from 'multihashes';
import { useEffect, useState } from 'react';

// Valid invite link prefixes
const VALID_INVITE_PREFIXES = [
  'https://quorummessenger.com/i/',
  'https://www.quorummessenger.com/i/',
  'https://app.quorummessenger.com/#',
  'https://app.quorummessenger.com/invite/#',
  'http://localhost:3000/i/',
  'quorummessenger.com/i/',
  'https://qm.one/',
  'https://qm.one/invite/',
  'qm.one/',
];

interface ValidatedSpace {
  iconUrl: string;
  spaceName: string;
  spaceId: string;
  description?: string;
}

interface InviteInfo {
  spaceId: string;
  configKey: string;
  template?: string;
  secret?: string;
  hubKey?: string;
}

interface CreateSpaceParams {
  name: string;
  description?: string;
  iconData?: string; // Base64 image data
  isRepudiable?: boolean;
  isPublic?: boolean;
}

interface CreateSpaceResult {
  spaceId: string;
  channelId: string;
  inboxAddress: string; // Space inbox address for WebSocket subscription
}

interface JoinSpaceParams {
  inviteLink: string;
}

interface JoinSpaceResult {
  spaceId: string;
  channelId: string;
  inboxAddress: string; // Space inbox address for WebSocket subscription
  joinMessageEnvelope?: string; // Optional join control message to send via WebSocket
}

/**
 * Derive address from public key using multihash
 */
function deriveAddress(publicKeyBytes: Uint8Array): string {
  const hash = sha256(publicKeyBytes);
  const mhash = multihashes.encode(hash, 'sha2-256');
  return bs58.encode(mhash);
}

/**
 * Parse invite link to extract space info
 */
function parseInviteLink(inviteLink: string): InviteInfo | null {
  const trimmed = inviteLink.trim();

  // Check if it matches any valid prefix
  const matchingPrefix = VALID_INVITE_PREFIXES.find((prefix) =>
    trimmed.startsWith(prefix)
  );

  if (!matchingPrefix && !trimmed.includes('#')) {
    return null;
  }

  // Extract hash content
  const hashContent = trimmed.split('#')[1];
  if (!hashContent) {
    return null;
  }

  // Parse parameters
  const params: Record<string, string> = {};
  hashContent.split('&').forEach((part) => {
    const [key, value] = part.split('=');
    if (key && value) {
      params[key] = value;
    }
  });

  if (params.spaceId && params.configKey) {
    return {
      spaceId: params.spaceId,
      configKey: params.configKey,
      template: params.template,
      secret: params.secret,
      hubKey: params.hubKey,
    };
  }

  return null;
}

/**
 * Hook to validate an invite link and preview the space
 */
export function useValidateInvite(inviteLink: string | undefined) {
  const [debouncedLink, setDebouncedLink] = useState<string | undefined>();

  // Debounce the invite link to avoid too many API calls
  useEffect(() => {
    if (!inviteLink || inviteLink.trim().length < 10) {
      setDebouncedLink(undefined);
      return;
    }

    const timer = setTimeout(() => {
      setDebouncedLink(inviteLink);
    }, 500);

    return () => clearTimeout(timer);
  }, [inviteLink]);

  return useQuery({
    queryKey: ['validateInvite', debouncedLink],
    queryFn: async (): Promise<ValidatedSpace | null> => {
      if (!debouncedLink) return null;

      const inviteInfo = parseInviteLink(debouncedLink);
      if (!inviteInfo) {
        throw new Error('Invalid invite link format');
      }

      const client = getQuorumClient();
      const manifest = await client.getSpaceManifest(inviteInfo.spaceId);

      if (!manifest || !manifest.space_manifest) {
        throw new Error('Could not fetch space info');
      }

      // Parse the encrypted manifest
      const ciphertext = JSON.parse(manifest.space_manifest) as {
        ciphertext: string;
        initialization_vector: string;
        associated_data?: string;
      };

      // Decrypt using config key
      const cryptoProvider = new NativeCryptoProvider();
      const configPrivateKeyBytes = hexToBytes(inviteInfo.configKey);
      const ephemeralPublicKeyBytes = hexToBytes(manifest.ephemeral_public_key);

      const decryptResult = await cryptoProvider.decryptInboxMessage({
        inbox_private_key: configPrivateKeyBytes,
        ephemeral_public_key: ephemeralPublicKeyBytes,
        ciphertext: {
          ciphertext: ciphertext.ciphertext,
          initialization_vector: ciphertext.initialization_vector,
          associated_data: ciphertext.associated_data,
        },
      });

      const space = JSON.parse(
        new TextDecoder().decode(new Uint8Array(decryptResult))
      ) as Space;

      return {
        iconUrl: space.iconUrl,
        spaceName: space.spaceName,
        spaceId: space.spaceId,
        description: space.description,
      };
    },
    enabled: !!debouncedLink && debouncedLink.trim().length >= 10,
    retry: false,
    staleTime: 60000, // Cache for 1 minute
  });
}

/**
 * Hook to join a space via invite link
 */
export function useJoinSpace() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (params: JoinSpaceParams): Promise<JoinSpaceResult> => {
      const inviteInfo = parseInviteLink(params.inviteLink);
      if (!inviteInfo) {
        throw new Error('Invalid invite link');
      }

      const client = getQuorumClient();
      const cryptoProvider = new NativeCryptoProvider();

      // 1. Fetch and decrypt space manifest
      const manifest = await client.getSpaceManifest(inviteInfo.spaceId);
      if (!manifest || !manifest.space_manifest) {
        throw new Error('Could not fetch space manifest');
      }

      const ciphertext = JSON.parse(manifest.space_manifest) as {
        ciphertext: string;
        initialization_vector: string;
        associated_data?: string;
      };

      const configPrivateKeyBytes = hexToBytes(inviteInfo.configKey);
      const ephemeralPublicKeyBytes = hexToBytes(manifest.ephemeral_public_key);

      const decryptResult = await cryptoProvider.decryptInboxMessage({
        inbox_private_key: configPrivateKeyBytes,
        ephemeral_public_key: ephemeralPublicKeyBytes,
        ciphertext: {
          ciphertext: ciphertext.ciphertext,
          initialization_vector: ciphertext.initialization_vector,
          associated_data: ciphertext.associated_data,
        },
      });

      const space = JSON.parse(
        new TextDecoder().decode(new Uint8Array(decryptResult))
      ) as Space;

      // 1.5. Check if this is a public invite (missing template, secret, hubKey)
      // If so, fetch the encrypted evaluation from the server and decrypt it
      if (!inviteInfo.template && !inviteInfo.secret && !inviteInfo.hubKey) {
        // Derive config public key from private key
        const cfgPrivKeyBytes = hexToBytes(inviteInfo.configKey);
        const cfgPrivKeyBase64 = btoa(String.fromCharCode(...cfgPrivKeyBytes));
        const cfgPubKeyBase64 = await cryptoProvider.getPublicKeyX448(cfgPrivKeyBase64);
        const cfgPubKeyBinary = atob(cfgPubKeyBase64);
        let cfgPubKeyHex = '';
        for (let i = 0; i < cfgPubKeyBinary.length; i++) {
          cfgPubKeyHex += cfgPubKeyBinary.charCodeAt(i).toString(16).padStart(2, '0');
        }

        // Fetch encrypted evaluation from server
        const evalResponse = await client.getInviteEval(cfgPubKeyHex);
        if (!evalResponse) {
          throw new Error('This public invite link is no longer valid.');
        }

        // The eval may have been encrypted under an ephemeral key DIFFERENT
        // from the manifest's: every broadcastSpaceUpdate (kicks, role
        // grants, settings edits, channel bindings) re-encrypts the manifest
        // with a fresh ephemeral key but leaves the eval untouched. Use the
        // eval's own eph key when the server provides it; only fall back to
        // the manifest's key on legacy servers that don't yet return it.
        const evalEphPubKeyBytes = evalResponse.ephemeralPublicKey
          ? hexToBytes(evalResponse.ephemeralPublicKey)
          : ephemeralPublicKeyBytes;

        const evalCiphertext = JSON.parse(evalResponse.ciphertext) as {
          ciphertext: string;
          initialization_vector: string;
          associated_data?: string;
        };

        const evalDecryptResult = await cryptoProvider.decryptInboxMessage({
          inbox_private_key: configPrivateKeyBytes,
          ephemeral_public_key: evalEphPubKeyBytes,
          ciphertext: {
            ciphertext: evalCiphertext.ciphertext,
            initialization_vector: evalCiphertext.initialization_vector,
            associated_data: evalCiphertext.associated_data,
          },
        });

        const evalData = JSON.parse(
          new TextDecoder().decode(new Uint8Array(evalDecryptResult))
        ) as {
          id: number;
          secret: string;
          template: string;
          hubKey: string;
        };

        // Update inviteInfo with the decrypted values
        inviteInfo.secret = evalData.secret;
        inviteInfo.template = evalData.template;
        inviteInfo.hubKey = evalData.hubKey;

      }

      // 2. Save the space (both storages for compatibility)
      saveSpace(space);
      // Also save to mmkvAdapter so useSpaces hook can find it
      const adapter = getMMKVAdapter();
      await adapter.saveSpace(space);

      // Mirror linkedFarcasterChannels (set by owner via Space Settings)
      // into the local bindings MMKV so the picker hook surfaces them
      // on first join — without this, only LIVE manifest broadcasts via
      // WS would populate the bindings, missing the case where the owner
      // bound a channel before the user joined.
      const linkedFromManifest = (space as Space & { linkedFarcasterChannels?: unknown }).linkedFarcasterChannels;
      if (Array.isArray(linkedFromManifest)) {
        const keys = linkedFromManifest.filter((k): k is string => typeof k === 'string');
        const { setSpaceBindings } = await import('@/services/space/channelBindings');
        setSpaceBindings(space.spaceId, keys);
      }

      // 3. Save config key - derive public key from private key
      const cfgPrivKeyBytes = hexToBytes(inviteInfo.configKey);
      const cfgPrivKeyBase64 = btoa(String.fromCharCode(...cfgPrivKeyBytes));
      const cfgPubKeyBase64 = await cryptoProvider.getPublicKeyX448(cfgPrivKeyBase64);
      const cfgPubKeyBinary = atob(cfgPubKeyBase64);
      let cfgPubKeyHex = '';
      for (let i = 0; i < cfgPubKeyBinary.length; i++) {
        cfgPubKeyHex += cfgPubKeyBinary.charCodeAt(i).toString(16).padStart(2, '0');
      }

      saveSpaceKey({
        spaceId: space.spaceId,
        keyId: 'config',
        publicKey: cfgPubKeyHex,
        privateKey: inviteInfo.configKey,
      });

      // 4. Save hub key if provided
      if (inviteInfo.hubKey) {
        // Derive hub public key from private key
        const hubPrivateKeyBytes = hexToBytes(inviteInfo.hubKey);
        const hubPrivateKeyBase64 = btoa(String.fromCharCode(...hubPrivateKeyBytes));
        const hubPublicKeyBase64 = await cryptoProvider.getPublicKeyEd448(hubPrivateKeyBase64);

        // Convert base64 public key to hex
        const hubPublicKeyBinary = atob(hubPublicKeyBase64);
        let hubPublicKeyHex = '';
        for (let i = 0; i < hubPublicKeyBinary.length; i++) {
          hubPublicKeyHex += hubPublicKeyBinary.charCodeAt(i).toString(16).padStart(2, '0');
        }

        saveSpaceKey({
          spaceId: space.spaceId,
          keyId: 'hub',
          address: space.hubAddress,
          publicKey: hubPublicKeyHex,
          privateKey: inviteInfo.hubKey,
        });
      }

      // 5. Generate inbox keypair for this space
      const inboxKeypair = await cryptoProvider.generateEd448();
      const inboxAddress = deriveAddress(new Uint8Array(inboxKeypair.public_key));

      saveSpaceKey({
        spaceId: space.spaceId,
        keyId: 'inbox',
        address: inboxAddress,
        publicKey: bytesToHex(new Uint8Array(inboxKeypair.public_key)),
        privateKey: bytesToHex(new Uint8Array(inboxKeypair.private_key)),
      });

      // This keypair is what the join broadcast announces, so the member
      // tables of every receiver bind ITS address — it is the user's signing
      // identity for this space. Persist it under 'signing' so device-sync
      // can later swap 'inbox' to a per-device mailbox key while every
      // device keeps signing with this one.
      saveSpaceKey({
        spaceId: space.spaceId,
        keyId: 'signing',
        address: inboxAddress,
        publicKey: bytesToHex(new Uint8Array(inboxKeypair.public_key)),
        privateKey: bytesToHex(new Uint8Array(inboxKeypair.private_key)),
        provenance: 'origin',
      });

      // 6. Register inbox with hub if we have hub key
      if (inviteInfo.hubKey && space.hubAddress) {
        try {
          // Get hub public key (we derived it in step 4)
          const hubPrivateKeyBytes = hexToBytes(inviteInfo.hubKey);
          const hubPrivateKeyBase64 = btoa(String.fromCharCode(...hubPrivateKeyBytes));
          const hubPublicKeyBase64 = await cryptoProvider.getPublicKeyEd448(hubPrivateKeyBase64);
          const hubPublicKeyBinary = atob(hubPublicKeyBase64);
          let hubPublicKeyHex = '';
          for (let i = 0; i < hubPublicKeyBinary.length; i++) {
            hubPublicKeyHex += hubPublicKeyBinary.charCodeAt(i).toString(16).padStart(2, '0');
          }

          const inboxPublicKeyHex = bytesToHex(new Uint8Array(inboxKeypair.public_key));

          // Hub signature: sign("add" + inbox_public_key_hex)
          const addInboxMessage = 'add' + inboxPublicKeyHex;
          const addInboxMessageBytes = new TextEncoder().encode(addInboxMessage);
          const addInboxMessageBase64 = btoa(String.fromCharCode(...addInboxMessageBytes));
          const hubSignatureBase64 = await cryptoProvider.signEd448(
            hubPrivateKeyBase64,
            addInboxMessageBase64
          );
          const hubSignatureHex = base64ToHex(hubSignatureBase64);

          // Inbox signature: sign("add" + hub_public_key_hex)
          const addHubMessage = 'add' + hubPublicKeyHex;
          const addHubMessageBytes = new TextEncoder().encode(addHubMessage);
          const addHubMessageBase64 = btoa(String.fromCharCode(...addHubMessageBytes));
          const inboxPrivateKeyBase64 = numberArrayToBase64(inboxKeypair.private_key);
          const inboxSignatureBase64 = await cryptoProvider.signEd448(
            inboxPrivateKeyBase64,
            addHubMessageBase64
          );
          const inboxSignatureHex = base64ToHex(inboxSignatureBase64);

          // Register inbox with hub
          await client.postHubAdd({
            hub_address: space.hubAddress,
            hub_public_key: hubPublicKeyHex,
            hub_signature: hubSignatureHex,
            inbox_public_key: inboxPublicKeyHex,
            inbox_signature: inboxSignatureHex,
          });
        } catch (e) {
          // Hub registration failed - can still send but won't receive
        }
      }

      // 6.5. Save joiner as a member of the space
      if (user?.address) {
        await adapter.saveSpaceMember(space.spaceId, {
          address: user.address,
          display_name: user.displayName || user.username,
          profile_image: user.profileImage,
          inbox_address: inboxAddress,
        });
      }

      // 7. Process template and secret to build proper encryption state
      // Track if this was a public invite (template came from server, not URL)
      const isPublicInvite = !params.inviteLink.includes('template=');

      if (inviteInfo.template && inviteInfo.secret) {
        try {
          const conversationId = `${space.spaceId}/${space.spaceId}`;

          // Decode template based on invite type:
          // - Public invites: template is already a JSON string
          // - Private invites: template is hex-encoded JSON (matches desktop InvitationService line 662-664)
          let templateJson: string;
          if (isPublicInvite) {
            // Public invite - template is already JSON
            templateJson = inviteInfo.template;
          } else {
            // Private invite - decode from hex
            const templateHex = inviteInfo.template;
            templateJson = '';
            for (let i = 0; i < templateHex.length; i += 2) {
              templateJson += String.fromCharCode(parseInt(templateHex.substring(i, i + 2), 16));
            }
          }
          const template = JSON.parse(templateJson);

          // Generate new keypairs for this session (matches desktop lines 681-682)
          const secretPair = await cryptoProvider.generateX448();
          const ephPair = await cryptoProvider.generateX448();

          // Parse and modify dkg_ratchet (matches desktop lines 683-708)
          const ratchet = JSON.parse(template.dkg_ratchet);
          ratchet.total++;

          // Set secret from keypair
          ratchet.secret = btoa(String.fromCharCode(...secretPair.private_key));

          // Set scalar from invite secret (hex to base64)
          const secretBytes = hexToBytes(inviteInfo.secret);
          ratchet.scalar = btoa(String.fromCharCode(...secretBytes));

          // Compute point from secret (getPublicKeyX448 takes base64, returns base64)
          // The point should be a base64 string, not an array
          const secretBase64 = btoa(String.fromCharCode(...secretBytes));
          const pointBase64 = await cryptoProvider.getPublicKeyX448(secretBase64);
          // Set point as base64 string (matches desktop which does JSON.parse on the WASM result)
          ratchet.point = pointBase64;
          ratchet.random_commitment_point = pointBase64;

          // Update template with modified ratchet
          template.dkg_ratchet = JSON.stringify(ratchet);
          template.next_dkg_ratchet = JSON.stringify(ratchet);

          // Set peer_key from device's inbox encryption private key (X448)
          // This is critical for Triple Ratchet encryption to work
          const deviceKeyset = await getDeviceKeyset();
          if (!deviceKeyset) {
            throw new Error('Device keyset not found');
          }

          // Convert our public key to base64 (same format as peer_id_map keys)
          const ourPublicKeyBase64 = btoa(String.fromCharCode(...deviceKeyset.inboxEncryptionPublicKey));

          // Check if our key is in the peer_id_map
          if (template.peer_id_map) {
            const ourPeerId = template.peer_id_map[ourPublicKeyBase64];
            if (ourPeerId === undefined) {
              // Our key is NOT in the peer_id_map - this is expected for generic invite links
              // We need to add ourselves with the ID from our dkg_ratchet
              const ourId = ratchet.id;

              // Add our entry to peer_id_map (maps our public key to our ID)
              template.peer_id_map[ourPublicKeyBase64] = ourId;

              // Add our entry to id_peer_map (maps our ID to our peer info)
              // This matches the structure from EstablishTripleRatchetSessionForSpace
              if (!template.id_peer_map) {
                template.id_peer_map = {};
              }
              template.id_peer_map[ourId] = {
                public_key: ourPublicKeyBase64,
                identity_public_key: btoa(String.fromCharCode(...deviceKeyset.identityPublicKey)),
                signed_pre_public_key: btoa(String.fromCharCode(...deviceKeyset.preKeyPublicKey)),
              };
            }
          }

          template.peer_key = btoa(String.fromCharCode(...deviceKeyset.inboxEncryptionPrivateKey));

          // Set ephemeral private key - Rust expects sending_ephemeral_private_key
          template.sending_ephemeral_private_key = btoa(String.fromCharCode(...ephPair.private_key));

          // Build nested session structure (matches desktop lines 709-714)
          const session = {
            state: JSON.stringify(template),
          };

          const finalState = JSON.stringify(session);

          // Save as double-nested JSON (state contains JSON of session which contains JSON of template)
          encryptionStateStorage.saveEncryptionState({
            conversationId,
            inboxId: inboxAddress,
            state: finalState,
            timestamp: Date.now(),
          });

          // Also save as fallback state - this is the original working state before any evolution
          // Desktop may not advance its ratchet, so we need this for decrypting its messages
          encryptionStateStorage.saveFallbackState({
            conversationId,
            inboxId: inboxAddress,
            state: finalState,
            timestamp: Date.now(),
          });

          // 9. Prepare join control message to announce ourselves to other participants
          // This is critical for other members to be able to:
          // - Add us to their peer_id_map/id_peer_map
          // - Decrypt messages FROM us
          // - Encrypt messages TO us
          try {
            const { sendJoinMessage } = await import('@/services/space/spaceMessageService');

            // Get the inbox public key hex (Ed448)
            const inboxPubKeyHex = bytesToHex(new Uint8Array(inboxKeypair.public_key));

            // Get the X448 public key from the secret (same as we set in ratchet.point)
            const secretBytes = hexToBytes(inviteInfo.secret);
            const secretBase64 = btoa(String.fromCharCode(...secretBytes));
            const pubKeyBase64 = await cryptoProvider.getPublicKeyX448(secretBase64);
            const pubKeyBinary = atob(pubKeyBase64);
            let pubKeyHex = '';
            for (let i = 0; i < pubKeyBinary.length; i++) {
              pubKeyHex += pubKeyBinary.charCodeAt(i).toString(16).padStart(2, '0');
            }

            // Get inbox encryption public key (X448)
            const inboxKeyHex = bytesToHex(deviceKeyset.inboxEncryptionPublicKey);

            // Get identity and pre-key public keys
            const identityKeyHex = bytesToHex(deviceKeyset.identityPublicKey);
            const preKeyHex = bytesToHex(deviceKeyset.preKeyPublicKey);

            // Build the message to sign (must match desktop byte-for-byte).
            // Desktop signs a 10-field blob ending in joinedAt (InvitationService.ts:826-838);
            // mobile previously signed only 9 fields (stopping at displayName), so desktop's
            // verify always failed and never saved us as a space member. Append joinedAt last.
            // address + id + inboxAddress + pubKey + inboxKey + identityKey + preKey + userIcon + displayName + joinedAt
            const userIcon = user?.profileImage || '';
            const displayName = user?.displayName || user?.username || '';
            // Mint once so the signed value and the wire value are identical.
            const joinedAt = Date.now();
            const msgToSign = user!.address +
              ratchet.id +
              inboxAddress +
              pubKeyHex +
              inboxKeyHex +
              identityKeyHex +
              preKeyHex +
              userIcon +
              displayName +
              joinedAt;
            // UTF-8 base64 to match desktop's Buffer.from(str,'utf-8').toString('base64').
            // (Plain btoa() is latin1 and throws/diverges on non-ASCII display names or pfp URLs.)
            const msgToSignBase64 = numberArrayToBase64(
              Array.from(new TextEncoder().encode(msgToSign))
            );

            // Sign with the inbox private key (Ed448)
            const inboxPrivateKeyBase64 = numberArrayToBase64(inboxKeypair.private_key);
            const signatureBase64 = await cryptoProvider.signEd448(inboxPrivateKeyBase64, msgToSignBase64);

            const participant = {
              address: user!.address,
              id: ratchet.id,
              inboxAddress: inboxAddress,
              inboxPubKey: inboxPubKeyHex,
              pubKey: pubKeyHex,
              inboxKey: inboxKeyHex,
              identityKey: identityKeyHex,
              preKey: preKeyHex,
              userIcon: userIcon,
              displayName: displayName,
              joinedAt,
              signature: signatureBase64,
            };

            // Create the join message envelope
            const joinMessageEnvelope = await sendJoinMessage({
              spaceId: space.spaceId,
              participant,
            });

            // Return the join message to be sent via WebSocket
            return {
              spaceId: space.spaceId,
              channelId: space.defaultChannelId,
              inboxAddress: inboxAddress,
              joinMessageEnvelope: joinMessageEnvelope,
            };
          } catch (joinMsgError) {
            // Failed to create join message - others won't be able to see us properly
          }
        } catch (e) {
          // Failed to process template/secret - space can still be viewed but not send messages
        }
      }

      return {
        spaceId: space.spaceId,
        channelId: space.defaultChannelId,
        inboxAddress: inboxAddress,
      };
    },
    onSuccess: () => {
      // Invalidate spaces query to refresh list
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}

/**
 * Hook to create a new space with full API registration
 */
export function useCreateSpace() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (params: CreateSpaceParams): Promise<CreateSpaceResult> => {
      // Import the space service dynamically to avoid circular dependencies
      const { createSpace } = await import('@/services/space/spaceService');

      if (!user?.address) {
        throw new Error('User must be logged in to create a space');
      }

      const result = await createSpace({
        name: params.name,
        description: params.description,
        iconData: params.iconData,
        isRepudiable: params.isRepudiable,
        isPublic: params.isPublic,
        userAddress: user.address,
        userDisplayName: user.displayName || user.username,
        userIcon: user.profileImage,
      });

      return {
        spaceId: result.spaceId,
        channelId: result.channelId,
        inboxAddress: result.inboxAddress,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
  });
}
