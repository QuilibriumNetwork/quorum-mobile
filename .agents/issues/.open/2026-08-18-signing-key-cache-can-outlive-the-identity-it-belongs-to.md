---
type: bug
title: "The cached Ed448 signing key can outlive the identity it belongs to, the same way the SQLCipher key did"
status: open
priority: low
ai_generated: true
created: 2026-08-18
updated: 2026-08-18
related:
  - "issues/.done/2026-07-26-reset-app-data-stale-cipher-key-bricks-messages-db.md (identical defect shape, on the at-rest encryption key; shipped as #258)"
---

# The cached Ed448 signing key can outlive the identity it belongs to, the same way the SQLCipher key did

> **⚠️ AI-Generated**: May contain errors. Verify before use.

## What & Why

Found by an independent review of PR #258, which fixed exactly this defect on the
messages database's SQLCipher key. This is the same mistake on the Ed448 *signing*
key, one module over. Filed separately rather than folded into #258 because the
blast radius is very different and key handling deserves its own branch and tests.

`getPrivateKey()` (`services/onboarding/secureStorage.ts:104-109`) memoizes the
Ed448 identity private key for the session, for the documented reason that Android
Keystore reads cost 650-900ms each:

```ts
export async function getPrivateKey(): Promise<string | null> {
  if (cachedPrivateKey !== null) return cachedPrivateKey;
  const value = await SecureStore.getItemAsync(STORAGE_KEYS.QUORUM_PRIVATE_KEY);
  if (value !== null) cachedPrivateKey = value;   // <-- unconditional
  return value;
}
```

`clearAllSecureStorage()` (`secureStorage.ts:549`) calls `clearKeyCache()` at its
**top**, then awaits the deletes. Two windows follow, exactly the pair that #258
had to close on the other key:

1. **A read in flight across the wipe.** A `getPrivateKey()` awaiting SecureStore
   when `clearKeyCache()` runs resolves afterwards and unconditionally re-caches
   the deleted identity's key. There is no epoch guard.
2. **The identity still readable during the deletes.** More likely, and it needs no
   interleaving at all: for the ~1s the awaited deletes take, the key is still in
   SecureStore. Any fresh `getPrivateKey()` in that window legitimately returns the
   old identity and caches it. The WebSocket is still connected throughout
   (`signOut` does not mark the session unauthenticated until teardown finishes)
   and both `WebSocketContext.tsx:6458` and `configService.ts:402,666` call
   `getPrivateKey()`, so the window is reachable in practice.

## Why this is `priority: low`, unlike #258

Every route that could *consume* the stale key after a reset is closed by
something else. Traced 2026-08-18:

| Candidate consumer | Why it cannot fire |
|---|---|
| Session restore resurrecting the old account (`AuthContext.tsx:203`) | Gated on a stored user in MMKV, which the reset clears. Dead branch. |
| Onboarding adopting the stale key | It never reads first — it generates a keypair and *writes* it (`OnboardingContext.tsx:327`), overwriting the cache. |
| `signMessage` (`AuthContext.tsx:571`) | Throws unless `userRef.current` is set, and the reset nulls the user. |
| Calls, public profile, reporting, skins | All require an active session, which does not exist between the reset and the new account. |

So the realistic outcome today is a stale value sitting in memory until onboarding
overwrites it, with no observed path that acts on it — as opposed to #258, which
fired on the normal flow every time and left the app permanently unusable.

**INFERRED, not proven:** a background task firing inside that same window (a
config publish, a deferred `InteractionManager` task, a socket reconnect) could
sign as the outgoing identity. No concrete path was found, but not every timer was
traced. It would be transient and self-correcting, not destructive.

## Solution

Mirror what #258 did for the cipher key. Both halves are needed; either alone
leaves one of the two windows open.

- [ ] Add an epoch counter next to `cachedPrivateKey`, bumped by `clearKeyCache()`,
      captured before the `await` in `getPrivateKey()` and checked after it. On a
      mismatch, return the value **without** caching it (or return `null`) rather
      than committing a key the wipe has invalidated. Closes window 1.
- [ ] Move the `clearKeyCache()` call in `clearAllSecureStorage()` to **after** the
      `await Promise.all([...])` deletes. Clearing it while the identity is still
      readable just invites an immediate re-derive of the same dead key. Closes
      window 2. (`messagesDb.clearCipherKeyCache()` is already called there, for
      this exact reason — put them together.)
- [ ] Test both, and confirm each goes red when its own fix is reverted.
      `__tests__/resetAppDataCipherKey.test.ts` has a working pattern for the
      in-flight-read race: a keychain fake that captures the value at call time and
      then blocks on a gate the test releases.
- [ ] Check the sibling caches — `cachedPublicKey` and `cachedDeviceKeyset`
      (`secureStorage.ts:63-65`) — have the same shape and the same two windows.

**Definition of done:** after a reset, no code path can obtain the deleted
identity's Ed448 key from the cache, and the two tests above fail if either half
of the fix is removed.

## Prevention

Same lesson #258 wrote down, restated because it recurred one file away: any
module-level cache keyed on user identity needs (a) an invalidation hook wired into
teardown, and (b) an epoch check on every async path that repopulates it, because
clearing a cache does nothing about a read already in flight. Clearing it *before*
the underlying secret is deleted is worse than useless — it schedules a re-read of
the value being destroyed.

*Last updated: 2026-08-18*
