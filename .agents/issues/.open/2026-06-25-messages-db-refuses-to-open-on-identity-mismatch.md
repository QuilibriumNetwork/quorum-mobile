---
type: bug
title: "SQLCipher messages DB refuses to open on identity-key mismatch — user sees empty chats, no in-app recovery"
status: open
created: 2026-06-25
updated: 2026-07-26
severity: high (was "medium, edge-case" — a common in-app trigger was found 2026-07-26, see below)
area: services/storage/messagesDb.ts
related:
  - "issues/2026-07-26-reset-app-data-stale-cipher-key-bricks-messages-db.md (the concrete trigger; answers this doc's open question)"
---

# Messages DB refuses to open when the file's identity key no longer matches

## Symptom

All spaces and DMs render empty. Logcat:

```
WARN [messagesDb] sync open failed: [messagesDb] cannot open SQLite messages
DB with derived cipher key, and the migration flag is set so the file is
presumed to hold canonical history. Refusing to wipe.
Underlying: SQLCipher key probe failed: ... file is not a database
D sqlcipher: ERROR CORE sqlite3Codec: error decrypting page 1 data: 1
```

## Cause

`quorum-messages.db` is encrypted with an SQLCipher key derived deterministically
(HKDF, no salt) from the user's Ed448 identity private key
(`deriveCipherKeyHexFromHex`, `messagesDb.ts:120`). When the file was encrypted
under a *previous* identity (re-onboard / import of a different seed / device
restore) the current identity can't decrypt it → "file is not a database".

The wrong-key auto-recovery (`openWithCipherKey`, `messagesDb.ts:358-361`)
deletes + recreates the file cleanly **only when the migration flag is unset**
(case A). When the flag is `'done'` (case B, `messagesDb.ts:349`) it deliberately
refuses to wipe — it assumes the file holds canonical history. Result:
safe-but-bricked. The user sees zero messages and there is **no in-app recovery
path**; only a reinstall / clear-app-data fixes it.

## Why it can hit live users (not just dev)

> **CORRECTION 2026-07-26.** The paragraph below was wrong, and its conclusion —
> that the standard sign-out flow is safe — is exactly backwards. `clearAllMessages()`
> does clean the disk, but it never invalidates the module-level `cipherKeyHexCache`,
> so the wiped identity's cipher key stays live for the rest of the process and
> recreates the DB under the dead key during re-onboarding. **Reset App Data followed
> by onboarding another account is the single most likely way a real user reaches
> this stuck state**, and it needs none of the exotic triggers listed below. Full
> analysis: `issues/2026-07-26-reset-app-data-stale-cipher-key-bricks-messages-db.md`.
> Reproduced on-device 2026-07-26. Severity raised medium → high accordingly.

Normal `signOut → clearAllMMKVStorage → clearAllMessages` (`messagesDb.ts:648`,
wired in `AuthContext.tsx:470`) wipes the file + resets the flag, so the standard
log-out/log-in-as-someone-else flow is safe. The flag is `'done'` for every user
post-MMKV→SQLite migration, so the ONLY protection is that sign-out.

A user reaches the stuck state by getting a key mismatch **without** signing out:
- **iOS device-backup restore** — app files restored onto a device whose Keychain
  (SecureStore) holds a different Ed448 identity. Most plausible real trigger.
- **Keystore/SecureStore desync** where the mnemonic can't re-derive the original
  key (the L136-138 comment assumes it always can — "DB survives a Keystore
  desync as long as the mnemonic does").
- **A future identity-key format / derivation change** shipped in a release would
  mismatch every existing user's DB at once.

## Open question for the lead dev

Is anything in `quorum-messages.db` **non-recoverable from the hub**? Messages are
E2E and re-sync, so if the DB is purely a cache, the case-B "refuse to wipe" guard
is protecting *cache*, not canonical data.

## Proposed fixes (depends on the answer)

- **If pure cache:** auto-wipe + recreate + re-sync even when the flag is `'done'`
  (drop the case-B refusal, or gate it on "is there anything non-syncable here").
  Deepest fix — the whole stuck-state class disappears.
- **If something is canonical/local-only:** add an in-app **"Rebuild local message
  cache"** action (calls `clearAllMessages()` + forces re-sync), and detect the
  stuck state to surface a one-time recovery modal instead of silently showing
  empty chats.

## Repro / workaround used

Dev device hit case B after an identity change. Workaround that unblocked it:
`adb shell pm clear com.quilibrium.quorummobile.debug` (clears the file AND the
MMKV migration flag together), then re-onboard. **Only ever the `.debug` package
— never the suffix-less real app.** ~~Deleting just the DB file is NOT enough: the
MMKV flag stays `'done'` and the app re-enters case B.~~

> **CORRECTION 2026-07-26.** Deleting just the DB file **is** enough, and it costs
> no re-onboard. The flag only matters when an *existing* file fails to decrypt;
> a missing file takes the create-fresh path in `openAndInit` and never reaches the
> `catch` where the guard lives. What the original note was missing is that the app
> must then be **force-stopped** — otherwise the still-running process recreates the
> file under the same stale cached key and the state returns:
>
> ```bash
> adb -s <serial> shell run-as com.quilibrium.quorummobile.debug rm files/SQLite/quorum-messages.db
> adb -s <serial> shell am force-stop com.quilibrium.quorummobile.debug
> ```
>
> Verified on `<device-1-serial>` 2026-07-26: chats recovered, MMKV untouched, user stayed
> signed in. `pm clear` still works but is the heavier hammer.

## Notes

- Not introduced by any current branch work — `messagesDb.ts` is untouched by the
  in-flight DM-mute / edit-history branch. Pre-existing.
- Discord report posted 2026-06-25.

*Last updated: 2026-07-26*
