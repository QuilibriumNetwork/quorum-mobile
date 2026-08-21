---
type: bug
title: "Remaining TypeScript errors needing lead-dev review"
status: open
created: 2026-06-15
updated: 2026-08-21
---

# Remaining TypeScript errors needing lead-dev review

## Status

**Updated 2026-08-21. The count is 11, not the 23 described below.** The original text is
left intact as the record of what was reported to the lead dev; read it through this section.

Most of the reduction is recorded in
`.agents/reports/2026-07-31-typescript-error-inventory.md`, which triaged every error and
took the count 28 → 11. That report is the authoritative source; this issue is the request
for a decision.

**Still open — the only three items that remain (11 errors):**

| Section below | Site | Errors | Blocked on |
|---|---|---|---|
| 1 | `services/calling/farcaster-link.ts:41-42` | 3 | What the verifier expects. See note below. |
| 2 | `services/calling/webrtc-manager.ts:111-169` | 7 | Nothing technical. Confirmed TYPE-ONLY. |
| 4 | `app/explore.tsx:6` | 1 | Product decision: delete or repoint. |

**Recorded as fixed** in the 2026-07-31 report: `keyService.ts:89` (section 1),
`native-call.ts` (section 2), `farcasterClient.ts` (section 4), the `WebSocketContext`
`MessageHandler` (section 3), plus all ten `dev/harness` errors.

**No longer in `tsc` output, but not explicitly recorded as fixed anywhere** — verify before
assuming, they may have moved rather than been fixed: `configService.ts:7` (section 1), and
all of section 3 except the `MessageHandler` item (`WebSocketContext.tsx:3591` `DeviceKeyset`,
`useSendDirectMessage.ts:1010-1011`, `spaceMessageService.ts:440` and `:830`).

### Two corrections to the text below

- **Section 2, `webrtc-manager`: the "may or may not fire at runtime" question is settled.**
  The handlers ARE created at runtime, via `defineEventAttribute` from `event-target-shim`
  (`react-native-webrtc`'s own `src/RTCPeerConnection.ts:823-832`). They are absent from the
  shipped `.d.ts` only because TypeScript cannot see a runtime-defined accessor. The code is
  correct; this is cosmetics in the live call path, and the 2026-07-31 report rates it the
  lowest-value item in the backlog.
- **Section 1, `farcaster-link`: worse than "broken at runtime".** All three call sites in
  `components/ProfileModal.tsx` (around lines 709, 1088, 1202) wrap the call in `try/catch` →
  `logger.warn` → publish the profile without the link. Nothing surfaces to the user, so the
  bidirectional link has silently never been generated. That makes this the highest-value item
  here, not merely the riskiest.

Section 4's `app/explore.tsx` reading below is correct and re-verified 2026-08-21: there is no
`explore` route under `app/(tabs)/` (it holds `account`, `feed`, `messages`, `profile`,
`spaces`, `wallet`), and nothing links to `/explore` except the file itself.

---

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

*Last updated: 2026-08-21*
