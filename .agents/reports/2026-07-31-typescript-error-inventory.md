# TypeScript error inventory

Triage of every `npx tsc --noEmit` error in quorum-mobile as of 2026-07-31.

**Counts: 28 → 11.** Two commits on `fix/harness-type-errors`: the 10
`dev/harness` errors, then 7 app-side ones. The 11 that remain are the three
items nobody should fix without a decision from someone who owns the feature.

## Why this document exists

There is no `typecheck` script in `package.json` and nothing in CI runs `tsc`.
So this output is never read, and errors accumulate in it silently. That is not
a hypothetical cost: **two of the errors below are live bugs**, and one of them
had a correct call site twelve lines away in the same file.

Adding `"typecheck": "tsc --noEmit"` is only worth doing once the count reaches
zero — a script that always fails gets ignored exactly like the current output.

## How to read the verdicts

- **REAL** — verified to misbehave at runtime, with the evidence that proves it.
- **TYPE-ONLY** — the code is correct; the types cannot see why. Verified
  against the library source, not assumed.

Everything below was checked against the installed packages, not from memory.

---

## REAL bugs

### 1. `sendStickerMessage` passes `sealHubEnvelope` its arguments in the wrong order

`services/space/spaceMessageService.ts:399` · **FIXED** · **highest severity here**

The signature is `(hubAddress, hubKeypair, message: string, configKey?: {publicKey, privateKey})`.
`sendStickerMessage` passes the **config key third and the message fourth**:

```ts
// services/space/spaceMessageService.ts:396 — inside sendStickerMessage
await cryptoProvider.sealHubEnvelope(
  hubKey.address,
  hubKeypair,
  configKey?.publicKey ? hexToNumberArray(configKey.publicKey) : undefined,  // → `message: string`
  hubMessagePayload,                                                         // → `configKey?: {...}`
);
```

Compare `sendSpaceMessage` at line 290 of the same file, which passes the same
four arguments in the correct order. The sticker path is the odd one out.

Runtime consequence: `message` receives `number[] | undefined`, and `configKey`
receives the JSON payload string. `configKey` is then truthy, so
`native-provider.ts:754` takes the config-key branch and sets
`x448PublicKey = configKey.publicKey` — `undefined` on a string. The wrong data
is sealed with a broken key.

Fixed by swapping the two arguments and adopting line 290's `configKey` guard
verbatim, so the two call sites are now identical.

**Still needs a human check.** Nothing tests sticker sending, and the path is
gated on a space actually having stickers configured, which is the likely reason
this survived. The wiring is live end to end
(`SpaceChatArea.tsx:619` → `useSendStickerMessage` → here), so it is not dead
code. If stickers were somehow working before this change, the reading above is
wrong and the commit should be reverted.

### 2. `generateFarcasterLink` throws on every call — the feature is silently dead

`services/calling/farcaster-link.ts:41-42` · 3 errors

`@noble/curves` 2.0.1 changed the `secp256k1` API and this file was never
updated. Probed against the installed build:

```
secp256k1.sign(hash, '00'.repeat(32))  →  THROWS "expected Uint8Array, got type=string"
sign() returns                          →  Uint8Array   (was: a Signature object)
sig.toCompactHex                        →  undefined
sig.recovery                            →  ABSENT
```

So line 41 throws before line 42 is ever reached. All three call sites in
`components/ProfileModal.tsx` (around lines 709, 1088, 1202) wrap the call in
`try/catch` → `logger.warn` → publish the profile without the link. **Nothing
surfaces to the user**; the Farcaster ↔ Quorum bidirectional link simply never
gets generated.

Both the noble 2.x bump and this file entered history in the same squashed
import commit, so it has been broken for as long as it has been in this repo.

Fix (~3 lines): `hexToBytes(custodyKeyHex)` for the key, and either
`sign(..., { format: 'recovered' })` or `.toBytes('compact')` plus the recovery
byte. **Deliberately left alone** — the feature's intended behaviour needs
confirming with whoever owns it before changing signature output.

### 3. `generateKeyPair` calls a noble API that no longer exists — dead code

`services/onboarding/keyService.ts:89` · **FIXED** · 1 error

Same root cause as #2: `ed448.utils.randomPrivateKey` was renamed
`randomSecretKey` in noble 2.x. Confirmed `randomPrivateKey` is `undefined` on
the installed build, so the call is a `TypeError` waiting to happen.

It never happened because **`generateKeyPair` has zero callers** — the export is
unreferenced across the whole repo. Renamed to `randomSecretKey`. It is still an
uncalled export; deleting it outright is also defensible, but that is a
judgement call about whether it is kept deliberately.

---

## TYPE-ONLY — code is correct, types cannot see it

### `webrtc-manager.ts` — 7 errors

`services/calling/webrtc-manager.ts:111-169`

`react-native-webrtc` creates `onicecandidate`, `ontrack`,
`onconnectionstatechange` and `oniceconnectionstatechange` **dynamically** via
`defineEventAttribute` from `event-target-shim` (see the package's
`src/RTCPeerConnection.ts:823-832`). They exist at runtime; they are absent from
the shipped `.d.ts` because TypeScript cannot see a runtime-defined accessor.

The two `TS7006` implicit-`any` errors are downstream of that — once the
property is unknown, its callback parameter is too. The `TS2531` at line 169 is
narrowing lost inside a `forEach` callback, which is safe here because the
callback runs synchronously.

Fix: switch to `addEventListener`, or add a module augmentation declaring the
four handlers. **Lowest value of anything in this document** — 7 errors of pure
cosmetics in a file worth not destabilising.

### `native-call.ts` — 3 errors · **FIXED**

`services/calling/native-call.ts:15, 23, 102`

Three symptoms of expo SDK drift, none of which broke at runtime. Two were
trivial: `Subscription` → `EventSubscription` (renamed in expo-modules-core 3.x,
installed 3.0.29), and dropping the `new EventEmitter(QuorumCrypto)` wrapper,
whose constructor overload expo marks `@deprecated` because a `NativeModule`
already is an EventEmitter.

The third is worth recording, because the obvious fix does not work.
`'onCallAction'` was rejected as not assignable to `never`, which looks like a
missing events map — but **passing one to `NativeModule<...>` changes nothing**:

```ts
// expo-modules-core@3.0.29, build/NativeModule.d.ts
export type NativeModule<TEventsMap extends EventsMap = Record<never, never>>
  = typeof ExpoGlobal.NativeModule<EventsMap>;
```

`TEventsMap` is declared and then discarded, and the right-hand side is the
**constructor** type, so `interface X extends NativeModule<Anything>` inherits no
instance members at all. That is the actual reason for the original
"missing addListener, removeListener, removeAllListeners, emit, listenerCount"
error, and attempting the events-map fix first produces
"Property 'addListener' does not exist" instead.

Fixed by declaring `addListener` on `QuorumCryptoModule` directly, typed by a
`CallActionEvent` that mirrors what the native side actually sends
(`ios/QuorumCryptoModule.swift`'s four CXProvider delegate methods, and Android's
`handleCallAction`). That also removed the four per-field casts in the switch.

### `farcasterClient.ts` — 1 error · **FIXED**

`services/farcasterClient.ts:1334`. `rawFrame` is the union of three aliases
declared at lines 1301-1303; `frame` and `miniApp` both declare `body?: string`
and `app` did not, so reading `.body` off the union failed. Added it to `app`,
which is plainly what the surrounding comment ("we accept several aliases so the
title doesn't regress ... when the shape shifts") intends.

### `WebSocketContext.tsx` — 1 error · **FIXED**

`context/WebSocketContext.tsx:5493`. `setMessageHandler` expects a
`MessageHandler` returning `Promise<void>`; `throttledMessageHandler` returned
`void`. Marked `async`. Behaviour is unchanged: the body awaits nothing, and both
invocation sites in the shared bundle are `await this.messageHandler(message)`
inside a `try/catch`, which catches a synchronous throw and a rejected promise
identically.

### `app/explore.tsx` — 1 error · **NOT fixed, needs a product decision**

`app/explore.tsx:6` is `<Redirect href="/(tabs)/explore" />`, and **there is no
`explore` route under `app/(tabs)/`**. That group holds `account`, `feed`,
`messages`, `profile`, `spaces` and `wallet`; the nearest thing to an Explore
screen is `spaces/discover`. Nothing anywhere links to `/explore` except this
file, so it is a legacy route pointing at a screen that was renamed or removed.

This is not a type problem with a right answer — the two options are deleting
the file or repointing it at whatever replaced Explore, and that is the owner's
call.

---

## Fixed (branch `fix/harness-type-errors`) — all 10 `dev/harness` errors

Two were real defects, not noise:

- **`ping.scenario.ts` and `transport.scenario.ts` asserted nothing.**
  `RNWebSocketClient` has no `listen()`; the real method is `subscribe()`. Both
  scenarios called `ws.listen?.([...])`, so the optional-call short-circuited,
  the subscribe never ran, and the following assertion only re-checked a
  connection that was already up. `transport.scenario.ts`'s own comment claimed
  it "exercises the send path" — it did not. Now `subscribe()`, called
  unguarded, along with `onStateChange` and `disconnect` (all three are required
  members, so `?.` bought nothing and hid this).
- **`dm-two-bot.scenario.ts` could miscount deliveries.** `textOf` declared
  `text?: string`, but `PostMessage.text` is `string | string[]`. An array
  reached the tag regex as an array; a one-element array coerces to exactly the
  text and matches, a multi-element one does not — and an unparsed message is
  counted as **lost**, which is the single measurement this harness exists to
  produce. Now typed against the real `Message` and joined with `''`, matching
  `useSendDirectMessage.ts`, which produced the messages.

The rest were resolution artefacts of the harness's deliberate design:

- `@quilibrium/quilibrium-js-sdk-channels` is intentionally not a mobile
  dependency; jest maps it to the sibling desktop checkout at runtime. Added the
  equivalent `paths` entry in `tsconfig.json` so tsc resolves what jest already
  resolves. It does not make the SDK shippable — absent from `package.json`,
  Metro cannot bundle it.
- `UserRegistration` was imported from `@quilibrium/quorum-shared`, which has
  never exported it (checked all 221 `.d.ts` files). It is mobile's own type,
  from `services/api/quorumClient.ts`. Type imports are erased, so this compiled
  to nothing and the harness ran fine while the name did not exist.
- `react-test-renderer` ships no types and is not a declared dependency (it
  arrives transitively via jest-expo). Added a local ambient declaration in
  `dev/harness/` covering the two members used, rather than a devDependency —
  the harness's stated design adds no dependencies, and depending on types for a
  package we deliberately do not depend on would be incoherent.
- `storage-shims.scenario.ts` guessed at `getMessages`' return shape. It is
  `GetMessagesResult` with a non-optional `messages` array, so the array branch
  was unreachable and the fallback would have turned an empty read into a pass.

Verified: 0 `dev/harness` errors remain, app-side errors byte-identical before
and after, `HARNESS_OFFLINE=1 yarn harness` green (4 suites passed, 4 networked
skipped, 13 tests). The `react-test-renderer is deprecated` warning in that
output is React 19's own unconditional notice, unrelated.

## What is left, and who has to decide it

| # | Errors | Item | Blocked on |
|---|---|---|---|
| 1 | 3 | `farcaster-link` | What the verifier expects. The noble 2.x call is mechanical, but the output is a signature someone checks, and no test covers it. |
| 2 | 1 | `app/explore` | Delete the legacy route, or repoint it at whatever replaced Explore. |
| 3 | 7 | `webrtc-manager` | Nothing — purely a question of whether cosmetics in the live call path are worth the churn. Lowest value here. |

Only after those reach zero is `"typecheck": "tsc --noEmit"` worth adding to
`package.json` and CI. A script that always fails gets ignored exactly like the
current output does.

## Verification for the two commits on `fix/harness-type-errors`

- `npx tsc --noEmit`: 28 → 11 errors, and every remaining one is in the table above
- `yarn test`: 15 suites, 126 tests, all pass
- `HARNESS_OFFLINE=1 yarn harness`: 4 suites passed, 4 networked skipped, 13 tests
- `npx eslint` on every touched file: 0 errors

Not covered by any of that, because nothing automated reaches it: sticker sending
(#1 above) and the native call UI, which needs a physical device.

*Last updated: 2026-07-31*
