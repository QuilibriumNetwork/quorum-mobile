---
type: bug
title: "Reset App Data leaves a stale SQLCipher key cached, so the next re-onboard bricks every chat"
status: in-progress
priority: high
ai_generated: true
created: 2026-07-26
updated: 2026-08-18
related:
  - "issues/.open/2026-06-25-messages-db-refuses-to-open-on-identity-mismatch.md (same symptom; THIS doc is the concrete trigger its 'why can it hit live users' section was missing)"
---

# Reset App Data leaves a stale SQLCipher key cached, so the next re-onboard bricks every chat

> **⚠️ AI-Generated**: May contain errors. Verify before use.

## Symptoms

After **Reset App Data** followed by onboarding a different account **without killing
the app process**, every space and DM renders a red error instead of messages:

```
Failed to load messages
[messagesDb] cannot open SQLite messages DB with derived cipher key, and the
migration flag is set so the file is presumed to hold canonical history.
Refusing to wipe. Underlying: SQLCipher key probe failed: Call to function
'NativeDatabase.execSync' has been rejected.
 → Caused by: file is not a database
```

The app is otherwise fully functional — navigation, spaces list, profile all work.
Only message surfaces are dead. There is **no in-app recovery path**; the state
survives app restarts forever.

Observed 2026-07-26 on a Samsung A40 (`<device-1-serial>`) running the `.debug` dev
client, while setting up the mobile↔mobile two-device DM round.

## Root Cause

`quorum-messages.db` is encrypted with an SQLCipher key derived deterministically
(HKDF, no salt) from the user's Ed448 identity private key
(`deriveCipherKeyHexFromHex`, `services/storage/messagesDb.ts:124`). That derived
key is memoized in a module-level cache:

```ts
// services/storage/messagesDb.ts:122
let cipherKeyHexCache: string | null = null;
```

**That cache is never invalidated.** A grep for `cipherKeyHexCache` across the module
returns only the declaration (L122) and reads/writes inside the two derivation
functions (L144-149, L162-168). Nothing — including `clearAllMessages()` — ever sets
it back to `null`. It therefore lives as long as the JS process does.

The reset chain is:

| Step | Location |
|---|---|
| `handleResetAppData` | `components/ProfileModal.tsx:874` |
| → `signOut()` | `context/AuthContext.tsx:468` |
| → `clearAllMMKVStorage()` | `services/offline/storage.ts:59` |
| → `clearAllMessages()` — deletes the DB file, removes the migration flag | `services/storage/messagesDb.ts:739` |
| → `clearAllSecureStorage()` — wipes the Ed448 identity | `context/AuthContext.tsx:474` |

Every step does the right thing on disk. But the process keeps running, and the
**old identity's cipher key is still sitting in `cipherKeyHexCache`**. So for the
entire remainder of that app session — including the whole re-onboarding flow — any
code path that opens the messages DB uses the key of the identity that was just
deleted:

1. Reset completes. Disk is clean: no DB file, no migration flag, no keys.
2. User onboards account **B**. New Ed448 identity lands in SecureStore.
3. The first message write (an arriving DM, a space backfill, any `useMessages`
   read) calls `getDb()` → `cipherKeyHexCache` is still hot with key(**A**) →
   `openAndInit` creates a **fresh DB file encrypted under the dead identity A**.
   The probe passes, because on a brand-new file `PRAGMA key` just stamps the
   header (`messagesDb.ts:183-189`).
4. `runMmkvMigration` then runs, finds zero legacy `messages:` keys (MMKV was just
   cleared), and **re-arms the flag to `'done'`** (`messagesDb.ts:404-405`).
5. Next cold start: cache is empty, so the key is derived correctly from identity
   **B**, and it cannot open a file encrypted under **A**. The probe throws, the
   flag reads `'done'`, and the case-B guard (`messagesDb.ts:353`) refuses to wipe.
   **Bricked.**

The case-B guard is not the bug — it is behaving exactly as designed, protecting
what it believes is canonical history. The bug is that steps 3-4 fabricate a file
that *looks* canonical out of a stale in-memory key.

### Confidence

- **Verified by code inspection**: the cache is never invalidated; `runMmkvMigration`
  re-arms the flag on an empty MMKV; the case-B guard fires on flag `'done'`.
- **Verified on-device**: the file existed, was undecryptable under the current
  identity, and the migration flag was set.
- **Inferred**: precisely which caller performed the step-3 write. Several paths
  qualify (incoming DM save, space backfill, `useMessages.initialData`) and the bug
  does not depend on which one wins — any DB touch in that window is sufficient.

## Why this matters more than the existing report

`issues/.open/2026-06-25-messages-db-refuses-to-open-on-identity-mismatch.md` documents the
same dead-end but rates it *medium — edge-case trigger*, and its "Why it can hit
live users" section lists only speculative causes (iOS backup restore, Keystore
desync, a future derivation change). It explicitly notes that the normal
sign-out flow "wipes the file + resets the flag, so the standard log-out/log-in-as-
someone-else flow is safe."

**That conclusion is wrong.** The sign-out flow is exactly the trigger. Reset App
Data is a documented, discoverable, in-app action, and following it with a
re-onboard in the same session is the *expected* user journey — the app has no
separate sign-out, so this is the only way to switch accounts. No device restore or
keystore weirdness is required. Hence `priority: high` here rather than medium.

## Status

Fixed on branch `fix/reset-app-data-stale-cipher-key` (2026-08-18), not yet merged.

The one-line fix below turned out to be necessary but **not sufficient**. An
independent review found a second, narrower route to the identical brick, and
verifying it surfaced a third. All three are closed on the branch:

1. **The stale cache itself** — `clearAllMessages()` now calls a new
   `clearCipherKeyCache()`, which drops both the memoized key and the open
   connection. This is the fix described below.
2. **A wipe landing mid-derivation** — `ensureCipherKeyAsync()` awaits the
   keychain and used to commit whatever it got back unconditionally. A read
   issued just before the wipe resolves just after it, re-arming the dead key
   through a narrower door. Closed with a `cipherKeyEpoch` counter: bumped on
   every cache clear, captured before the await, checked after, and on mismatch
   the result is discarded (`NoIdentityKeyError`) instead of cached. The sync
   path needs no equivalent guard — it never awaits, so nothing can clear the
   cache mid-call.
3. **The identity still being readable during teardown** — even with an empty
   cache and a perfect epoch guard, `clearAllSecureStorage()`'s deletes are
   awaited and each Android Keystore op costs 650-900ms. A write landing in that
   window read identity A legitimately and re-created the file *after* the local
   wipe had already run. Closed by reordering `signOut()`
   (`context/AuthContext.tsx`): secure storage is wiped **first**, so a late
   write fails cleanly with no identity to derive from, and the local wipe runs
   last (in a `finally`) to remove anything that did land. The `finally` matters
   — "identity gone, database still on disk under it" is exactly the bricking
   state, so it must run even if the secure wipe throws.

Regression coverage, 10 tests across two files:

- `__tests__/resetAppDataCipherKey.test.ts` (7) — the storage layer. Its
  `expo-sqlite` mock simulates SQLCipher key enforcement (stamp the key on file
  creation, throw on mismatch) because plain SQLite ignores `PRAGMA key` and
  cannot reproduce a wrong-key open at all; the fakes live on `globalThis` so
  `jest.resetModules()` models "disk survives a cold start, module caches do not".
- `__tests__/signOutTeardownOrder.test.tsx` (3) — the teardown order itself, plus
  the two error paths. The order looks backwards, so it is exactly what a later
  refactor would "tidy up"; this fails loudly if it does.

Each fix was verified by reverting it **in isolation** and confirming only its
own test goes red. The primary one reproduces the reported error verbatim:
"Refusing to wipe ... file is not a database". Full suite green (114 suites,
1063 tests), `tsc` at its pre-existing 12-error baseline, eslint 0 errors.

**Not verified on-device.** Everything above is automated-test evidence. The
on-device check worth doing before release is the original repro: reset, onboard
a different account without killing the app, send/receive a message, then
force-stop and relaunch. Messages should load.

### Known adjacent defect, deliberately not fixed here

`getPrivateKey()` (`services/onboarding/secureStorage.ts:104-109`) has the same
shape as fix 2: it awaits SecureStore and then unconditionally repopulates
`cachedPrivateKey` with no epoch guard, so a read in flight across a wipe can
re-cache the deleted identity's signing key. Pre-existing, untouched by this
branch, and a different blast radius (signing, not at-rest encryption). Worth its
own issue rather than widening this one.

### Desktop is not affected (checked 2026-08-18)

Two independent reasons: desktop stores messages in **unencrypted IndexedDB**
(`quorum-desktop/src/db/messages.ts:253`, opened with a fixed non-identity-scoped
name from `src/db/dbVersion.ts:13`), so there is no identity-derived cipher key to
go stale; and its reset path ends in `window.location.reload()`
(`src/components/modals/UserSettingsModal/DangerZone.tsx:58`), which destroys the
whole JS heap before a new identity can be onboarded. That also confirms the
comment at `components/ProfileModal.tsx:911` ("Unlike desktop, nothing reloads
here") is accurate. `quorum-shared` holds no identity-derived cache; the
derivation machinery is local to mobile and was never factored out.

## Solution

Primary fix, in `clearAllMessages()` (`services/storage/messagesDb.ts:739`) —
see `## Status` above for the two further fixes it turned out to need:

```ts
export function clearAllMessages(): void {
  if (dbInstance) {
    try { dbInstance.closeSync(); } catch { /* noop */ }
    dbInstance = null;
  }
  cipherKeyHexCache = null;   // <-- ADD: the key belongs to the identity being wiped
  try {
    SQLite.deleteDatabaseSync(DB_NAME);
  } catch {
    // File didn't exist or already deleted — fine.
  }
  storage.remove(MIGRATION_FLAG_KEY);
}
```

Key insight: `dbInstance` is already correctly torn down there. `cipherKeyHexCache`
is the same class of process-lifetime state and was simply missed. The existing
comment at `messagesDb.ts:139-142` reasons about the cache surviving a *Keystore
desync* (correct, and desirable) but never considers it surviving a *deliberate
identity wipe*.

Worth pairing with, as defence in depth:

- ✅ **Done on the branch.** Have `clearAllSecureStorage()` invalidate the messages
  cipher-key cache too, so the cache can never outlive the key it was derived from
  regardless of call order. `secureStorage.ts:549` already does exactly this for its
  own key caches via `clearKeyCache()` — the messages module needs the same
  treatment. (Implemented *after* the awaited deletes rather than alongside
  `clearKeyCache()`: dropping the cache while the identity is still readable just
  invites an immediate re-derive of the same dead key.)
- ⏭️ **Deferred, and the suggestion below does not work as written.** Consider
  whether `runMmkvMigration` should set the flag to `'done'` when it migrated
  *nothing* (`messagesDb.ts:404-405`). Marking a never-migrated empty DB as holding
  canonical history is what converts a recoverable state into a permanent one.
  Gating the case-B refusal on "the file actually contains rows" would make the
  whole class of stuck states self-healing — **except you cannot count rows in a
  file you cannot decrypt**, which is precisely the state the guard fires in. Any
  real fix needs a separate durable marker recording that the database has held
  rows, written at migration time. That belongs to
  `issues/.open/2026-06-25-messages-db-refuses-to-open-on-identity-mismatch.md`,
  whose whole subject is the guard, and it is deliberately out of scope here: this
  issue is about the stale cache that manufactures the bogus file, not about
  making the guard smarter afterwards.

### Device-level workaround (verified working 2026-07-26)

Deleting only the DB file is sufficient and — contrary to the note in the
2026-06-25 doc — does **not** require clearing the migration flag, because the guard
only runs when an *existing* file fails to decrypt. A missing file takes the
create-fresh path and never reaches the `catch`. This keeps the user signed in:

```bash
adb -s <serial> shell run-as com.quilibrium.quorummobile.debug rm files/SQLite/quorum-messages.db
adb -s <serial> shell am force-stop com.quilibrium.quorummobile.debug
```

The force-stop is not optional — it is what finally kills the poisoned
`cipherKeyHexCache`. Without it the still-running process just recreates the file
under the stale key and you are back where you started.

Only ever against the `.debug` package, never the suffix-less real app. The heavier
`pm clear` from the older doc also works but costs a full re-onboard.

## Prevention

- **Process-lifetime caches derived from identity must die with that identity.**
  Any `let xCache` at module scope keyed on user identity needs an explicit
  invalidation hook wired into the teardown path, and that hook should be added in
  the same commit that introduces the cache.
- **A "delete everything" path is not verified until the app is re-onboarded and
  then cold-started.** Testing the reset itself passes here; the damage only
  becomes visible on the launch *after* the launch that caused it.
- **Be sceptical of "refuse to destroy data" guards that cannot verify the data is
  real.** The case-B guard trusts a boolean flag rather than the file's contents,
  so it defends an empty file just as fiercely as a full one — and turns a
  recoverable glitch into a permanent brick.

*Last updated: 2026-08-18*

## Review Log
**2026-08-18 - claude-fable-5**: Verified against current code: bug still present, mechanism fully accurate, fix NOT applied; refreshed drifted line numbers only
- cipherKeyHexCache (messagesDb.ts:122) still never invalidated - grep shows only declaration + derivation reads/writes, no reset anywhere
- clearAllMessages (now messagesDb.ts:739) still tears down dbInstance but not the cipher key cache
- case-B guard now at messagesDb.ts:353, flag re-arm on empty MMKV at 404-405 - both behave exactly as described
- clearKeyCache (secureStorage.ts:72) still clears only its own three caches, defence-in-depth suggestion still valid
- ProfileModal.tsx:911 comment confirms mobile reset never reloads the JS bundle, so the poisoned cache survives
- line drift corrected: ProfileModal 852->874, AuthContext 467/473->468/474, messagesDb 118->122, 696->739, 349->353, 401->404-405
- status stays open in .open/ - correct, nothing shipped since 2026-07-26 touches this path
