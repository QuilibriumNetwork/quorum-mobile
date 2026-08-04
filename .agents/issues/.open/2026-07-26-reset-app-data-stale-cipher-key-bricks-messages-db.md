---
type: bug
title: "Reset App Data leaves a stale SQLCipher key cached, so the next re-onboard bricks every chat"
status: open
priority: high
ai_generated: true
created: 2026-07-26
updated: 2026-07-26
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
(`deriveCipherKeyHexFromHex`, `services/storage/messagesDb.ts:120`). That derived
key is memoized in a module-level cache:

```ts
// services/storage/messagesDb.ts:118
let cipherKeyHexCache: string | null = null;
```

**That cache is never invalidated.** A grep for `cipherKeyHexCache` across the module
returns only the declaration (L118) and reads/writes inside the two derivation
functions (L141-145, L159-164). Nothing — including `clearAllMessages()` — ever sets
it back to `null`. It therefore lives as long as the JS process does.

The reset chain is:

| Step | Location |
|---|---|
| `handleResetAppData` | `components/ProfileModal.tsx:852` |
| → `signOut()` | `context/AuthContext.tsx:467` |
| → `clearAllMMKVStorage()` | `services/offline/storage.ts:59` |
| → `clearAllMessages()` — deletes the DB file, removes the migration flag | `services/storage/messagesDb.ts:696` |
| → `clearAllSecureStorage()` — wipes the Ed448 identity | `context/AuthContext.tsx:473` |

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
   header (`messagesDb.ts:180-183`).
4. `runMmkvMigration` then runs, finds zero legacy `messages:` keys (MMKV was just
   cleared), and **re-arms the flag to `'done'`** (`messagesDb.ts:401`).
5. Next cold start: cache is empty, so the key is derived correctly from identity
   **B**, and it cannot open a file encrypted under **A**. The probe throws, the
   flag reads `'done'`, and the case-B guard (`messagesDb.ts:349`) refuses to wipe.
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

## Solution

**Not yet applied** — the repo was frozen for a live two-device capture round when
this was found.

Primary fix, one line, in `clearAllMessages()` (`services/storage/messagesDb.ts:696`):

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
comment at `messagesDb.ts:130-138` reasons about the cache surviving a *Keystore
desync* (correct, and desirable) but never considers it surviving a *deliberate
identity wipe*.

Worth pairing with, as defence in depth:

- Have `clearAllSecureStorage()` invalidate the messages cipher-key cache too, so
  the cache can never outlive the key it was derived from regardless of call order.
  `secureStorage.ts:549` already does exactly this for its own key caches via
  `clearKeyCache()` — the messages module needs the same treatment.
- Consider whether `runMmkvMigration` should set the flag to `'done'` when it
  migrated *nothing* (`messagesDb.ts:401`). Marking a never-migrated empty DB as
  holding canonical history is what converts a recoverable state into a permanent
  one. Gating the case-B refusal on "the file actually contains rows" would make
  the whole class of stuck states self-healing.

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

*Last updated: 2026-07-26*
