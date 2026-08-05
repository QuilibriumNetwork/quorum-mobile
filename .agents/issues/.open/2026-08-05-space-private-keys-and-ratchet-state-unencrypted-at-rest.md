---
type: bug
title: "Space private keys and Double Ratchet state are stored unencrypted at rest, while the message archive they protect is SQLCipher-encrypted"
status: open
priority: high
created: 2026-08-05
area: at-rest encryption / key storage / crypto posture
runtime_test: not-applicable
source: found 2026-08-05 while scoping whether notification message previews should be encrypted — the answer turned out to depend on this
related:
  - "issues/.open/2026-08-05-notification-previews-plaintext-and-generic-rows.md"
---

# Key material sits in plaintext next to the archive it decrypts

## Read this first: it may be deliberate

This is filed as `type: bug` because the exposure is real and present, **not**
because it is established to be unintended. It is the lead dev's crypto
architecture. The first action is to ASK, not to change anything.

If the answer is "accepted tradeoff, we rely on OS sandboxing + full-disk
encryption", retype this to `task` or close it — but record the reasoning,
because right now the codebase reads as if the opposite were intended (see §3).

## 1. What was found

**Space private keys are persisted in plaintext MMKV.** `saveSpaceKey()` writes
the entire `SpaceKey` object, `privateKey` field included:

```ts
// services/config/spaceStorage.ts:172-175
export function saveSpaceKey(spaceKey: SpaceKey): void {
  const key = getSpaceKeyStorageKey(spaceKey.spaceId, spaceKey.keyId);
  spaceStorage.set(key, JSON.stringify(spaceKey));
}
```

`spaceStorage` is `createMirroredMMKV({ id: 'quorum-spaces' })`, and
`createMirroredMMKV` calls `createMMKV({ id })` with **no `encryptionKey`**
(`services/storage/mirroredMMKV.ts:46-52`).

**Double Ratchet state likewise.** `services/crypto/encryption-state-storage.ts`
uses the same unencrypted `createMirroredMMKV`, persisting `EncryptionState`
(~L372) and `ConversationInboxKeypair` records (~L425).

**On iOS there are two copies.** `createMirroredMMKV` mirrors every write into
the App Group directory so the notification service extension can read it. Both
copies are unencrypted.

**No MMKV store in the app passes an `encryptionKey`** — all 20+ `createMMKV`
call sites are `{ id }` only. The installed `react-native-mmkv` does support it
(`lib/specs/MMKVFactory.nitro.d.ts:52`).

## 2. Why this outranks the notification-preview question

The notification issue asks whether message *previews* should be encrypted. The
answer is that it barely matters while this stands: anyone with file-level
access to app storage already holds the keys that decrypt the messages
themselves. Previews are a strictly smaller subset of what those keys unlock.

Encrypting previews while space private keys and ratchet state sit unencrypted
in the next file over does not raise the bar. That is why the notification issue
now defers to this one rather than gating on its own encryption work.

## 3. Why the codebase reads as if this were NOT intended

The message archive **is** properly protected: `services/storage/messagesDb.ts`
opens SQLite under SQLCipher with a 32-byte key derived by HKDF-SHA256 from the
Ed448 private key, which itself lives in SecureStore under
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`.

So the app deliberately does not trust the OS to protect stored *messages*, then
stores the *keys to those messages* in the clear. Whatever the intent, those two
decisions do not agree with each other, and that mismatch is the finding.

## 4. Both clients — desktop is not better, it is worse

Per the standing both-clients rule. A grep of `quorum-desktop/src` for
`safeStorage`, `SQLCipher`, `encryptionKey` and `cipher` found **no at-rest
encryption of any kind**; every `ciphertext` hit is wire-protocol envelope
handling, not storage. Electron's IndexedDB is unencrypted by default.

So mobile is AHEAD of desktop here (it at least encrypts the archive). That
strongly suggests a project-wide posture rather than a mobile-specific
oversight, and it means any fix is a cross-client conversation, not a mobile
patch. **Caveat: that was a grep, not an audit — confirm before quoting it.**

## 5. Threat model, stated honestly

Do not overstate this. MMKV files live in app-private storage. On a non-rooted,
passcode-locked device, other apps cannot read them and the OS encrypts them at
rest while locked (Android FBE / iOS Data Protection).

The exposure is: root/jailbreak, forensic extraction, a device handed over
unlocked, any process running as the app, and — on Android —
`android:allowBackup="true"`
(`android/app/src/main/AndroidManifest.xml:24`), which makes app storage
eligible for cloud backup.

The argument is not that any single one of these is likely. It is that the app
already decided the OS is not sufficient for message content, and then did not
apply that decision to the material that unlocks it.

## 6. Suggested next steps

1. **Ask the lead dev.** Is unencrypted key material at rest a deliberate
   tradeoff? This is the whole first step; everything below is contingent on it.
2. If not deliberate, scope encrypting `quorum-spaces` and the encryption-state
   store with a SecureStore-derived key, reusing the `messagesDb` derivation.
   **Known blocker to solve first:** MMKV takes its key at `createMMKV()` time
   and these stores are module-scope constants created at import, before any key
   exists — they need lazy creation. The iOS App Group mirror also has to stay
   readable by the notification extension, which is a real constraint on any
   scheme.
3. Decide on `android:allowBackup="true"` separately; it is cheap to change and
   independent of the rest.

## Verify

There is nothing to runtime-test until a decision is made. If encryption is
adopted, the test that matters is inspecting the MMKV file on a dev device and
confirming key material is not readable as plaintext — a code reading is not
evidence for this class of change.

*Last updated: 2026-08-05*
