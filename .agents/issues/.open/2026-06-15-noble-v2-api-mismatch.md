---
type: bug
title: "Remaining TypeScript errors needing lead-dev review"
status: open
created: 2026-06-15
---

# Remaining TypeScript errors needing lead-dev review

Report in Discord for lead dev to see

Context: did a pass over `npx tsc --noEmit` and fixed everything safe (import paths, FlashList v2 prop, null guards, a real auctions-list bug, MMKV `.remove()`, etc. — see branch `chore/mobile-small-fixes`). The 23 errors below were left untouched on purpose: they're crypto, native-module, or messaging-protocol contracts where a wrong fix could break correctness silently. Grouped by area.

## 1. @noble v2 API changes (crypto)

Deps are on `@noble/curves@2.0.1` / `@noble/ciphers@2.1.1`; these call sites still use v1 APIs, so they're broken at runtime (symbol `undefined` or wrong return shape). Surfaced after the deep imports were fixed to the v2 `.js` export paths.

- **`services/config/configService.ts:7`** — `randomBytes` is no longer exported by `@noble/ciphers/webcrypto.js` (moved to `@noble/ciphers/utils.js`, same `randomBytes(len)` signature). Used at line 208 for the AES-GCM IV.
- **`services/onboarding/keyService.ts:89`** — `ed448.utils.randomPrivateKey()` removed in v2; replacement is `ed448.utils.randomSecretKey()` (or `ed448.keygen()`). This is the ed448 keypair generation path.
- **`services/calling/farcaster-link.ts:41-42`** — `secp256k1.sign()` now returns a `Uint8Array` (compact bytes) by default, not a Signature object, so `.toCompactHex()` and `.recovery` no longer exist. The Farcaster signature + recovery-byte logic needs rebuilding against the v2 return type. (Note: `farcasterService.ts:476` already casts `secp256k1 as any` for the same call — worth checking it returns what that code expects.)

## 2. Native calling (react-native-webrtc / expo-modules-core)

- **`services/calling/webrtc-manager.ts:111,118,125,129`** — `pc.onicecandidate` / `ontrack` / `onconnectionstatechange` / `oniceconnectionstatechange` aren't on react-native-webrtc's `RTCPeerConnection` type (it exposes `addEventListener` instead). The `on*` assignment may or may not fire at runtime depending on the lib version — needs someone who knows the calling stack to confirm and migrate. (Also 2x implicit-`any` event params and 1x possible-null at line 169 in the same file.)
- **`services/calling/native-call.ts:15,23,102`** — `expo-modules-core` no longer exports `Subscription`; `QuorumCryptoModule` isn't accepted where an `EventEmitter` is expected; `"onCallAction"` event name rejected. Expo SDK type changes around the native module event API.

## 3. Messaging / protocol shapes (crypto-adjacent)

- **`context/WebSocketContext.tsx:3591`** — `{ publicKey, privateKey }` not assignable to `DeviceKeyset`.
- **`context/WebSocketContext.tsx:3922`** — handler `(message: EncryptedWebSocketMessage) => void` not assignable to `MessageHandler`.
- **`hooks/chat/useSendDirectMessage.ts:1010-1011`** — `ConversationInboxKeypair.signingPublicKey/signingPrivateKey` are optional (`number[] | undefined`) but assigned to required `number[]`. Older stored inboxes may lack signing keys — needs a decision (regenerate? skip signing?).
- **`services/space/spaceMessageService.ts:440`** — `sealHubEnvelope` 3rd arg expects `string`, gets `number[] | undefined`.
- **`services/space/spaceMessageService.ts:830`** — the `update-profile` content object isn't assignable to `MessageContent` (shape/union mismatch).

## 4. Other (product/ambiguous)

- **`app/explore.tsx:6`** — redirects to `/(tabs)/explore`, which doesn't exist (tabs are feed/spaces/messages/profile/wallet/account). Nothing references this legacy route. Pick a real target or delete the file. Left it as a product decision.
- **`services/farcasterClient.ts:1327`** — `rawFrame.body` read but `body` isn't on the frame type (`{ name?, iconUrl?, url? }`). Either the type is missing `body` or the read is wrong.

*Last updated: 2026-06-15*
