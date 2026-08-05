---
type: bug
title: "Notification previews are stored unencrypted on device, and the generic message rows are neither precise nor tappable"
status: open
priority: high
created: 2026-08-05
area: notifications / at-rest encryption / background message service
runtime_test: required
related:
  - "issues/.open/2026-08-05-space-private-keys-and-ratchet-state-unencrypted-at-rest.md"
  - "issues/.done/2026-08-05-scoped-clear-notifications-including-farcaster.md"
  - "issues/.open/2026-06-23-dms-in-global-notification-panel.md"
  - "docs/features/notification-system.md"
---

# Notification previews sit in plaintext, and the generic rows go nowhere

Two problems found together while scoping the scoped-clear work. They are filed
together because the fix for the second (make rows precise) makes the first
(previews stored in the clear) materially worse, so they have to be decided as
one.

## 0. Sequencing correction (2026-08-05) — §1 does NOT block the rest

This issue originally gated the UX work on encrypting the notification previews.
**That ordering was wrong**, and it was corrected once the surrounding storage
was actually surveyed rather than assumed:

**Space private keys and Double Ratchet state are already stored unencrypted**
in `quorum-spaces` and the encryption-state store (both plain
`createMirroredMMKV`, no `encryptionKey`). Filed separately and at higher
priority: `2026-08-05-space-private-keys-and-ratchet-state-unencrypted-at-rest.md`.

Given that baseline, anyone with file access already holds the keys that decrypt
the messages. Notification previews are a strictly smaller subset of what those
keys unlock, so encrypting them changes little while the key material is in the
clear.

**Consequences:**
- The UX work (§2, §3, §4 — rich in-app rows, generic OS banners) is
  **unblocked**. Its marginal exposure against this baseline is near zero.
- §1 stays worth doing, but as a **follow-on to the key-material issue**, not a
  gate before the UX work.
- If the key-material issue is resolved by encrypting those stores, do §1 in the
  same pass with the same derivation — the two share every implementation
  problem (lazy store creation, the iOS App Group mirror).

## 1. The privacy problem — real, but no longer the blocker

**Message preview text is persisted unencrypted on device.**

- `mentionReplyLog` stores `preview: MessagePreview` — real message text from
  space mentions and replies — in `createMMKV({ id: 'quorum-mention-reply-log' })`.
- `notificationLog` stores notification `title`/`body` in
  `createMMKV({ id: 'quorum-notifications' })`.
- **No MMKV store in this app passes an `encryptionKey`.** All 20+ `createMMKV`
  call sites pass `{ id }` only. Verified 2026-08-05 by grep across
  `services/`, `hooks/`, `context/`.
- The installed `react-native-mmkv` **does** support `encryptionKey`
  (`lib/specs/MMKVFactory.nitro.d.ts:52`). This is a gap, not a limitation.

**Why this is inconsistent with the app's own threat model.** Message bodies
live in SQLCipher-encrypted SQLite, keyed by HKDF from the user's Ed448 private
key (`services/storage/messagesDb.ts`). The app therefore explicitly does NOT
rely on OS sandboxing to protect message content — it layers app-level
encryption on top. Storing the same content as plaintext previews next to it
contradicts that decision.

**Exposure, stated accurately (do not overstate this, but do not undersell it):**

- MMKV files live in app-private storage. On a **non-rooted, passcode-locked**
  device, other apps cannot read them, and the OS encrypts at rest while locked
  (Android FBE / iOS Data Protection).
- They ARE readable given: root/jailbreak, forensic extraction, a device handed
  over unlocked, or any process running as the app.
- `android:allowBackup="true"` (`android/app/src/main/AndroidManifest.xml:24`)
  makes MMKV contents eligible for Android's cloud backup, i.e. preview text can
  leave the device. Modern Android encrypts that backup with the device PIN, but
  for an app whose premise is E2E this deserves an explicit decision rather than
  an inherited default.

**This is pre-existing and it is ours.** Space-mention previews already ship this
way today — it is not introduced by any current branch, and it was implemented on
this side rather than by the lead dev, so it has not had the lead dev's review.

### Options

1. **Encrypt the notification MMKV stores** with a key derived the same way
   `messagesDb` derives its cipher key. Matches the existing posture, costs the
   user nothing, needs no setting, and is strictly better than a toggle because
   it does not make privacy opt-in.
2. **Privacy toggle** ("rich notifications" on/off). Considered and NOT
   recommended as the primary fix: it complicates the surface, and its default
   value is either insecure or useless.
3. **Store no preview text** — keep rows structural (who + where, no content).
   Safe, but throws away the feature.

**Recommendation: option 1**, with option 3 as the fallback for any context where
the key genuinely is not available.

### RESOLVED 2026-08-05 — the key IS reachable where it matters

Investigated before committing to the approach. Answer: **encrypt the mention
log; keep the ping log content-free.** The constraint and the exposure do not
overlap.

**The key.** HKDF-SHA256 over the Ed448 private key, read from SecureStore under
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`services/storage/messagesDb.ts:50-52`), then
**memoized in module scope** (`:122`, `cipherKeyHexCache`).

That memoization is decisive. Once a live process derives the key it stays in
memory, and lock state stops mattering for that process. The only genuinely
unreachable case is a **cold background process never unlocked since launch**
(push wake / background fetch on a phone locked since boot).

**And that case is iOS-only.** `keychainAccessible` is marked `@platform ios` in
expo-secure-store's type definitions; Android ignores it. So the constraint bites
on exactly one platform, in exactly one process state.

**Mapped onto the two logs:**

| Log | Written by | Cold bg process? | Encryptable |
|---|---|---|---|
| mention log (holds message text) | only `logMentionOrReply` ← `WebSocketContext` | no — needs a live React tree | **yes** |
| ping log (generic strings only) | `BackgroundMessageService` | yes | not reliably on iOS |

Writer set verified exhaustively: `appendMentionReplyLog` has one caller
(`logMentionOrReply`), which has two (`WebSocketContext` live ~L2924 and catch-up
~L4757). Both require a live app process, so the key is always already cached.

**The log carrying the actual exposure is the encryptable one. The log that
cannot be encrypted carries no message content today.**

### Consequences for the rest of this issue

- **§1 → encrypt the mention log.** No toggle, no user decision, no fallback path
  needed. Make "the ping log never holds message content" an explicit rule rather
  than an accident.
- **§3 Quorum DM precision has no conflict.** The DM task already writes from the
  decrypted WebSocket path, which lands in the mention log — encrypted *and*
  precise. The wanted behaviour is the architecturally cheap one.
- **§2 Farcaster DC precision should not persist content at all.** Join the
  stored ping to the live conversation list at render (`useFarcasterDirectCasts`
  already fetches it) instead of writing sender/preview into the log. Rich rows,
  nothing added at rest, and it sidesteps the one path that cannot encrypt.

### Two implementation notes

- **MMKV takes its key at `createMMKV()`**, and these stores are module-scope
  constants created at import, before any key exists. They need lazy creation on
  first use. `recrypt()` exists but does not dodge the ordering problem.
- **Do NOT "fix" this by switching to `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.** It
  would make the key reachable everywhere, but it is the SAME key the messages DB
  uses, so it weakens that too — and an existing keychain item does not pick up a
  changed accessibility attribute without being rewritten (INFERRED, unverified).
  That is the lead dev's crypto posture; do not change it as a side effect of a
  notifications feature.

## 2. The generic rows are neither precise nor tappable

The "New Messages / You have a new direct message" rows in the panel:

**They do nothing when tapped.** `checkFarcasterDirectCasts` writes
`data: { type: 'message', messageId: 'fc-…' }` with no `conversationId`
(`BackgroundMessageService.ts:125-131`). `handlePress` routes on either
`spaceId + channelId` or `conversationId` (`app/(tabs)/profile/index.tsx`), so
with neither it matches no branch and silently returns. Same for the Quorum
`bg-` ping.

**The destination already exists.** `useFarcasterDirectCasts` keys conversations
as `farcaster:<conversationId>`, and `app/(tabs)/messages/dm/[id].tsx:106`
already handles that prefix. Writing
``conversationId: `farcaster:${conversation.conversationId}` `` into the ping
makes the existing routing carry the tap — no new screen.

**They could be precise.** That background loop already holds full
`DirectCastConversation` objects (`services/farcasterClient.ts:497-512`) with
`viewerContext.counterParty` (display name + pfp), `lastMessage.message` (the
text), and `lastMessage.senderContext.displayName`. It discards all of it and
emits one aggregate count. Farcaster direct casts are not E2E — the app fetches
them in plaintext from the API — so there is no crypto barrier here, only the §1
at-rest question and the OS-banner question below.

### Decision taken: rich in-app, generic on the lock screen

`showMessageNotification` currently writes the OS notification AND the in-app log
from the same `title`/`body` (`services/notifications/NotificationService.ts:134`),
so enriching one enriches the other. It needs to take two payloads: a generic one
for the OS banner, a rich one for the in-app log. (Confirmed with the operator
2026-08-05.)

## 3. Quorum DMs in the panel — the "blocker" is narrower than it looks

There is **no blocker for the foreground case.** A DM arriving while the app runs
is decrypted in `WebSocketContext` on the `decryptedMessage` path; sender and
plaintext are both in hand — the same data that fills `lastMessagePreview` in the
Messages tab. We simply never call anything to log it. Space messages call
`logMentionOrReply` at their receive point; DMs have no equivalent. Adding that
call is the whole fix, and it is already specced in
`issues/.open/2026-06-23-dms-in-global-notification-panel.md`.

The **only** thing that cannot be fixed is the app-closed case: the background
task at `BackgroundMessageService.ts:239` receives `data.encrypted_content` with
no keys loaded, so it can never say more than "you have new messages". That row
can be superseded by a precise one on catch-up when the app reopens.

So: Quorum DMs can appear with sender + preview for anything received while the
app is running or on catch-up. The generic row only covers the window when the
app was closed.

## 4. The per-row trash icon is on the wrong rows

`showTrash = item.source === 'chat'` puts the delete affordance only on the
generic rows, where per-row deletion is meaningless because they are all
identical, and gives the precise mention rows none. `removeMentionReplyEntry(id)`
already exists in `mentionReplyLog.ts` and is unwired. Wiring it to Quorum rows
is nearly free — but it only becomes worth doing once rows are distinguishable,
which is why it is filed here rather than done separately.

## Scope

Reordered per §0 — the UX work leads, encryption follows the key-material issue.

- **B, C, D first.** They are what the operator actually wants and their
  marginal exposure is near zero against the §0 baseline.
- **A. Encrypt the mention log — deferred**, to be done with the key-material
  issue rather than before the UX work. The key-availability question is already
  resolved (every mention-log writer runs in a live process with the cipher key
  cached), so this is ready to implement whenever the key work happens. Requires
  moving the store from module-scope `createMMKV` to lazy creation on first use.
  Keep "the ping log never holds message content" as a rule regardless — it is
  the one path that genuinely cannot encrypt.
  - **Do not miss `quorum-dev-notification-snapshot`** (`services/dev/notificationSnapshot.ts`).
    It holds a full second copy of both logs, preview text included, in its own
    unencrypted MMKV store. Encrypting the two primary logs while leaving it
    alone puts a plaintext copy of exactly the protected data right beside them.
    It is `__DEV__`-only so it never reaches users, but a dev device is still a
    device — either encrypt it with the same key or have it store structural
    fields only.
- **B. Make the pings tappable.** Add `conversationId` at both call sites. Small
  and independent of the content question — a row that does nothing on tap is a
  bug regardless.
- **C. Split the OS payload from the in-app payload** in
  `showMessageNotification`, then enrich the Farcaster direct-cast rows while
  the OS banner stays generic. Per the resolution above, enrich them at RENDER
  time from the live conversation list rather than by persisting sender/preview
  into the ping log — that path cannot encrypt, so the content should never
  reach it.
- **D. Wire the trash icon** to Quorum mention rows.
- **E.** Revisit `android:allowBackup="true"` — decide deliberately, and exclude
  the notification stores from backup if it stays on.

## Verify

- Inspect the MMKV file on a dev device before/after the §1 fix and confirm
  preview text is not readable as plaintext in the after case. **This is the
  test that matters** — a code reading is not evidence here.
- Tap a Farcaster direct-cast row → lands in that conversation.
- Lock-screen banner stays generic after the §C split, while the in-app row is
  rich. Check both surfaces in the same run, or the split is unproven.
- Muted DM → still no row, still no banner.

*Last updated: 2026-08-05*
