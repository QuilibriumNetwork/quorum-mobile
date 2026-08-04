---
type: task
title: Port DM update-profile (identity sync over DM sessions) from desktop
status: done
blocked_on: "shared package bump — published 2.1.0-26 dist lacks DMUpdateProfileMessage + Conversation.bio; need a correctly-built version published to npm (or a publish of 2.1.0-29)"
created: 2026-06-09
updated: 2026-06-12
audience: future agent on quorum-mobile
verified_against:
  - "quorum-mobile @ master (HEAD b8ad64d), @quilibrium/quorum-shared 2.1.0-26 installed"
  - "quorum-desktop @ main (profile-sync merged as 9b99ba39, #188, 2026-06-09)"
  - "quorum-shared source @ 2.1.0-29"
related_prs:
  - "quorum-shared#33 (DMUpdateProfileMessage type) — merged to source; NOT in the published 2.1.0-26 dist (stale build)"
  - "quorum-shared#34 (Conversation.bio field) — merged to source; NOT in the published 2.1.0-26 dist (stale build)"
  - "quorum-desktop#188 (feat: profile sync (spaces and DMs)) — merged to main as 9b99ba39"
owns_unblock: "Cassie (lead dev) — the shared-package publish. The repo owner here has no npm account / no publish access, so the rebuilt-and-published shared version must come from her."
---

# Port DM update-profile (identity sync over DM sessions) from desktop

> **▶ NEXT SESSION — resume here.** Status is BLOCKED on the shared-package publish (owned
> by Cassie; this repo's owner has no npm account). When she has published a rebuilt
> version: (1) bump mobile's `package.json` pin + `yarn install`; (2) run the `tsc` probe
> below to CONFIRM the published `dist/` actually exports `DMUpdateProfileMessage` +
> `Conversation.bio` (do NOT trust the version number — `2.1.0-26` had a stale dist);
> (3) only then implement, receive side first. Branch already created: `feat/dm-update-profile`.
> No code or dependency changes have been made yet. Decision recorded 2026-06-12: do NOT
> set up a local `link:` — wait for the publish.

> **Why this exists.** Desktop now propagates a user's **global** profile changes
> (displayName, userIcon, bio) to every existing DM partner via a `dm-update-profile`
> control message sent over the established Double Ratchet session. Mobile neither
> recognizes that message on receive (it renders it as a garbage chat post) nor
> broadcasts it on send. This task brings mobile to parity on both sides.

---

## ⛔ BLOCKER — resolve before writing any code

**The shared types this task needs are NOT usable at mobile's currently-pinned
`@quilibrium/quorum-shared@2.1.0-26`.** The published `2.1.0-26` shipped a **stale
`dist/`**: `DMUpdateProfileMessage` and `Conversation.bio` exist in the package's `src/`
folder but were never compiled into the `dist/*.d.ts` files that TypeScript and Metro
actually resolve (`"types": "./dist/index.d.ts"`). Proven with the compiler:

```
$ npx tsc --noEmit __probe.ts   // importing the two symbols
error TS2724: '@quilibrium/quorum-shared' has no exported member 'DMUpdateProfileMessage'
error TS2353: 'bio' does not exist in type 'Conversation'
```

Why desktop is unaffected: desktop consumes shared via `"link:../quorum-shared"` (a local
symlink to the `2.1.0-29` source, which has a correctly-built dist). **Mobile pins a
REGISTRY version** (`resolved https://registry.yarnpkg.com/...quorum-shared-2.1.0-26.tgz`),
so it gets whatever is published to npm — and what's published lacks the types.

**Therefore a shared-package bump is a HARD PREREQUISITE, not optional.** Open question
(blocked on network access at research time): is a version with the types correctly built
into `dist/` actually PUBLISHED to npm? The source repo is at `2.1.0-29` and HAS them in
its local `dist/`, but a registry bump only works if that build was published. Options:

1. **Bump if published** — `npm view @quilibrium/quorum-shared versions`; if a version with
   the types in `dist/` exists (likely `2.1.0-29`), set mobile's pin to it and `yarn install`.
2. **Publish then bump** — if npm lacks a good build, rebuild + `npm publish` the shared
   package first (separate task, needs publish access), then bump mobile.
3. **`link:` like desktop** — switch mobile to `link:../quorum-shared` / tarball to consume
   the local `2.1.0-29` source. Unblocks dev immediately but diverges from mobile's
   registry-pin convention and breaks CI / other machines. Dev-only stopgap at best.

**Bump regression risk: LOW.** Audited every symbol mobile imports from shared; none of the
changed ones (`MAX_BIO_LENGTH`→`MAX_BIO_BYTES` rename, `validateUserBio`, optional
`UpdateProfileMessage.displayName`, new QNS exports, Input `leftIcon`/`rightIcon`) are
imported by mobile. The bump is a clean drop-in needing **no other mobile code change** —
the ONLY thing standing in the way is getting a correctly-built version installed.

---

## TL;DR for the implementer

- **⛔ Shared types are NOT usable at the pinned `2.1.0-26`** (stale published dist — see
  blocker above). A bump to a correctly-built `2.1.0-29+` is a prerequisite. Until then,
  importing `DMUpdateProfileMessage` or assigning `Conversation.bio` fails typecheck.
- **Receive side**: add an intercept branch in mobile's **two** DM decrypt paths in
  `context/WebSocketContext.tsx` (the JS path and the native-batch path), before the
  message is persisted as a chat post. Mirror the existing space `update-profile` merge.
- **Send side**: mobile does **NOT** broadcast profile from `AuthContext.updateProfile`
  (the task's original "Files to modify" was wrong about this). Mobile broadcasts from
  **two** sites that loop over spaces. The DM broadcast must hook into the same two sites.
- **Field semantics**: `displayName`/`userIcon` → truthy guard (empty = preserve);
  `bio` → `!== undefined` (empty string = clear). This is what both platforms already do.
- **Scope guard**: only the GLOBAL profile save broadcasts to DMs. Per-space saves
  (Space Settings → Account) must NOT.

---

## Verified state (research findings, 2026-06-12)

This task was deep-researched across all three repos before rewriting. The original
draft contained several inaccuracies; they are corrected inline below and flagged with
**⚠ Correction**.

### Shared package — types exist in SOURCE but NOT in the installed/published dist

The wire type (target shape, from `2.1.0-29` source/dist):
```ts
export type DMUpdateProfileMessage = {
  senderId: string;
  type: 'dm-update-profile';
  displayName?: string;
  userIcon?: string;
  bio?: string;
};
```
- It is **intentionally excluded** from the `MessageContent` union (it is a control
  message, never persisted / never rendered). Do **not** add it to the union.
- `Conversation.bio?: string` (comment: "Empty string = explicitly cleared").
- **There is no builder or typeguard** (`buildDMUpdateProfileMessage`,
  `isDMUpdateProfileMessage`, Zod schema). Construct the object literal directly.
- Import path (once a good version is installed):
  `import type { DMUpdateProfileMessage, Conversation } from '@quilibrium/quorum-shared';`

> **⚠ Correction (supersedes the first rewrite)** — an earlier rewrite of THIS task claimed
> the types "ship in the pinned 2.1.0-26, no bump required." **That was wrong.** It was
> based on reading the package's `src/` folder. Mobile's TypeScript/Metro resolve from
> `dist/`, and the published `2.1.0-26` `dist/` is STALE — it has neither
> `DMUpdateProfileMessage` (`dist/types/message.d.ts`) nor `Conversation.bio`
> (`dist/types/conversation.d.ts`). Verified with `tsc` (errors TS2724 + TS2353). See the
> ⛔ BLOCKER section at the top: a bump to a correctly-built version is REQUIRED.
>
> Evidence trail: `grep DMUpdateProfileMessage node_modules/@quilibrium/quorum-shared/dist/`
> → no hits; `grep ... /src/` → hits. The `2.1.0-29` SOURCE repo dist (and desktop's
> `link:`ed install) DO have them (`dist/types/message.d.ts:27`,
> `dist/types/conversation.d.ts:12`). The question is whether `2.1.0-29` (or any
> correctly-built version) is PUBLISHED to npm — mobile installs from the registry.

> **Bump risk = LOW** (audited): `MAX_BIO_BYTES` (256) replaces `MAX_BIO_LENGTH` (160),
> `validateUserBio` reworked, `UpdateProfileMessage.displayName` made optional, new QNS
> exports, Input `leftIcon`/`rightIcon`. **Mobile imports NONE of these** — it defines its
> own local `MAX_NAME_LENGTH`, has its own `resolveName` in `services/api/qnsClient`, and
> never imports the shared `Input` component or any bio validator. The bump needs no other
> mobile code change.

### Desktop reference (the implementation to mirror)

All desktop code is **merged to `main`** (squash commit `9b99ba39`, PR #188).

> **⚠ Correction** — the original draft cited commit `d9af2ac0` and branch
> `feat/profile-sync-spaces-and-dms`. Neither exists; those were pre-squash working
> commits. Read the merged code on `main` instead. Architecture playbook:
> [`quorum-desktop/.agents/docs/debugging/dm-architecture-and-debug-playbook.md`](../../../quorum-desktop/.agents/docs/debugging/dm-architecture-and-debug-playbook.md).

**Receive** — `quorum-desktop/src/services/MessageService.ts`:
- `interceptControlMessages` (lines ~378-477), branch at ~429-446. Called at both DM
  decrypt sites (new-session ~2824, established-session ~4369). Returns `true` for
  `dm-update-profile` → caller does `return`, message never reaches `saveMessage`.
- Anti-spoof: `if (profileMsg.senderId === senderAddress)` where `senderAddress` is the
  cryptographically-authenticated envelope sender. **Returns `true` even on mismatch**
  (still intercepted, just not applied).
- `handleDMProfileUpdate` (~481-503): `conversationId = senderAddress + '/' + senderAddress`,
  `getConversation`, **skip silently if no row**, then merge:
  ```ts
  const merged = {
    ...existing.conversation,
    ...(profileMsg.displayName ? { displayName: profileMsg.displayName } : {}),
    ...(profileMsg.userIcon ? { icon: profileMsg.userIcon } : {}),
    ...(profileMsg.bio !== undefined ? { bio: profileMsg.bio } : {}),
  };
  ```
  Then `saveConversation(merged)` + invalidate `buildConversationsKey({type:'direct'})`
  and `buildConversationKey({conversationId})`.

**Send** — `broadcastProfileToAllDMs` (`MessageService.ts` ~283-328):
- `getConversations({ type: 'direct' })`, loop, skip `conv.address` missing or == self,
  build `DMUpdateProfileMessage` (`bio` spread only if `!== undefined`), call
  `encryptAndSendDm` per partner inside a per-partner `try/catch` (one failure never
  blocks others). The primitive `encryptAndSendDm` (~733-833) **throws if there is no
  established session** for that partner — so the per-partner catch is load-bearing.
- Called from `updateUserProfile` (`components/context/MessageDB.tsx` ~462-471), which is
  the GLOBAL save handler invoked by `useUserSettings.saveChanges()`. Bio is passed as
  `undefined` when unchanged (so the wire omits it).
- Per-space save (`useSpaceProfile.onSave`) does **not** touch DMs — it has no reference
  to `broadcastProfileToAllDMs` at all. Enforced structurally, not by convention.

### Mobile current state (where the port plugs in)

**Receive — TWO DM paths in `context/WebSocketContext.tsx`:**

1. **JS path** inside `handleIncomingMessage`. DM messages are decrypted and
   `JSON.parse`d into `decryptedMessage` at **~line 2294**. Immediately after, a
   `call-` intercept (~2298-2305) does `return` for call-signaling. **Insert the
   `dm-update-profile` intercept right here**, after the `call-` block and before the
   conversation upsert (~2322) / `storage.saveMessage` (~2376). `senderAddress` is
   `conversationId.split('/')[0]` (~2311/2319).
2. **Native batch path** `applyDMGroupResults` (~line 3156). Each result is `JSON.parse`d
   (~3209), has a `call-` intercept (~3216), then a `reaction`/`remove-reaction` fold
   (~3291), then unconditional `storage.saveMessage` (~3366). **Insert the intercept
   alongside the `reaction` branch**, before `saveMessage`.

> Unknown control types are currently NOT intercepted in either path — they hit
> `storage.saveMessage` and `getMessageRenderType` (`components/Chat/types.ts` ~247-269)
> returns `'post'` for them. **That is the "visible scar"**: a `dm-update-profile`
> currently renders as a JSON-ish post bubble. Confirmed.

**Space `update-profile` merge (the pattern to steal)** — also two handlers:
- JS path ~1843-1924 (`merged` object at ~1888-1901)
- batch path `applySpaceGroupResults` ~3014-3069
Both use: `displayName`/`userIcon` truthy guard, `bio !== undefined`. Persist via
`adapter.saveSpaceMember`, refresh via `queryClient.setQueryData(queryKeys.spaces.members(...))`.

> **⚠ Correction** — original draft cited "lines 1796-1877". The real handler starts at
> ~1843. Line 1796 is inside an unrelated `remove-message` branch.

**Send — mobile does NOT broadcast from `AuthContext.updateProfile`:**

`AuthContext.updateProfile` (`context/AuthContext.tsx` ~422-462) only updates React state
+ MMKV + optional `saveConfig` server sync. It has **no broadcast loop**. Mobile
broadcasts profile from **two** sites, both looping spaces via
`maybeSendUpdateProfileMessage` (`services/space/spaceMessageService`):

1. **On-connect rebroadcast** — `useEffect` in `WebSocketContext.tsx` ~4023, gated by
   `lastProfileRebroadcastSigRef`, fires after a 4s `setTimeout`, loops `getAllSpaces()`,
   `enqueueOutbound`s each envelope (~4046-4086).
2. **On-save loops** in `components/ProfileModal.tsx` — avatar save (~904-932) and
   name/bio save (~989-1018). The name/bio loop sends only changed fields and **gates
   `bio` on `user.isProfilePublic`** (`bio: user.isProfilePublic ? newBio : undefined`).

> **⚠ Correction** — original "Files to modify" pointed at `AuthContext.updateProfile`.
> The DM broadcast must instead be wired into the two sites above. See "Send side" below.

**Storage + cache (the mobile mirrors of desktop's MessageDB/queryKeys):**
- `services/storage/mmkvAdapter.ts`: `getConversation(id)`, `saveConversation(conv)`,
  `getConversations({ type: 'direct' })` — all present, signatures match desktop.
- DM row id = `address + '/' + address`.
- Invalidate with `queryKeys.conversations.all('direct')` and
  `queryKeys.conversations.detail(id)` (mobile already does exactly this at
  `WebSocketContext.tsx:460-462`, with `refetchType: 'active'`).
- **`Conversation` in mobile has NO `bio` field yet** — neither the shared base type
  nor the mobile extension in `hooks/chat/useConversations.ts` adds one. (The shared
  `Conversation` type DOES declare `bio?`, so once mobile bumps to a version where the
  installed `.d.ts` carries it, the field is typed. In 2.1.0-26 the installed
  `conversation.ts` already has `bio?`, so `merged.bio` is type-safe — confirmed.)

**DM send primitive:** `hooks/chat/useSendDirectMessage.ts` exports
`sendEncryptedMessageToAllDevices(conversationId, recipientAddress, message,
allTargetDevices, enqueueOutbound, subscribe, deviceKeyset, userAddress, displayName?)`
(~line 808). This is mobile's `encryptAndSendDm` equivalent. Device keyset via
`getDeviceKeyset()` (`services/onboarding/secureStorage`); session states via
`encryptionStateStorage.getEncryptionStates(conversationId)` /
`getLatestState(conversationId)`. There is no "send a DM control message" helper yet —
the new service helper should wrap `sendEncryptedMessageToAllDevices` with an
`update-profile`-shaped `Message.content`.

> Note on the wire `type`: desktop's control message uses `type: 'dm-update-profile'`.
> Mobile's DM transport wraps content in a `Message` whose `content.type` is what the
> receiver switches on. The intercept on receive keys off
> `decryptedMessage.content?.type === 'dm-update-profile'`. Ensure the send side sets
> `content.type` to `'dm-update-profile'` so it matches (NOT the space `'update-profile'`).

---

## What "done" looks like

> **Gate:** do NOT start either side until the ⛔ shared-package bump prerequisite is done
> and the `tsc` probe passes. Both sides import `DMUpdateProfileMessage` / write
> `Conversation.bio`, which don't typecheck at `2.1.0-26`.

### Receive side (ship this first, alone, safely)

In **both** DM decrypt paths in `context/WebSocketContext.tsx`, before the message is
persisted as a chat post, intercept `decryptedMessage.content?.type === 'dm-update-profile'`:

1. Derive `senderAddress = conversationId.split('/')[0]` (already in scope in the JS
   path; derive equivalently in the batch path).
2. Read `senderId` from `decryptedMessage.content`. **Validate `senderId === senderAddress`**.
   On mismatch: `console.warn('[DMProfile] rejected mismatched senderId', ...)` and still
   `return`/`continue` (intercept, drop, never persist) — matching desktop's
   "return true even on mismatch".
3. `const conversationId = senderAddress + '/' + senderAddress;`
   `const existing = await storage.getConversation(conversationId);`
   **If `!existing`, return/continue silently** — no session means no DM row to update.
4. Merge (mirror the space handler and desktop exactly):
   ```ts
   const merged: Conversation = {
     ...existing,
     ...(content.displayName ? { displayName: content.displayName } : {}),
     ...(content.userIcon ? { icon: content.userIcon } : {}),
     ...(content.bio !== undefined ? { bio: content.bio } : {}),
   };
   await storage.saveConversation(merged);
   ```
5. Invalidate caches so the DM list and chat header refresh:
   ```ts
   queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all('direct'), refetchType: 'active' });
   queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(conversationId), refetchType: 'active' });
   ```
6. `return` (JS path) / `continue` (batch path) so the message is never saved as a post.
7. Best-effort: delete the intercepted control message from the server inbox, the same
   way the `call-` intercept does (`getDeviceKeyset().then(dk => deleteInboxMessages(...))`),
   so it doesn't replay on next launch. (JS path has the helper inline; replicate it.)

### Send side (ship after receive adoption is reasonably high)

Add a new service helper `services/dm/dmProfileService.ts` exposing
`broadcastProfileToAllDMs(...)` that mirrors desktop's loop but uses mobile primitives:

1. `const { conversations } = await storage.getConversations({ type: 'direct' });`
2. For each `conv`:
   - Skip if `!conv.address` or `conv.address === selfAddress`.
   - **Skip Farcaster conversations** (`conv.source === 'farcaster'`) — they aren't
     E2EE DM sessions; sending an encrypted control message there is meaningless.
   - Build the `Message` with `content: { type: 'dm-update-profile', senderId: selfAddress,
     ...(displayName ? { displayName } : {}), ...(userIcon ? { userIcon } : {}),
     ...(bio !== undefined ? { bio } : {}) }`.
   - Call `sendEncryptedMessageToAllDevices(conversationId, conv.address, message, ...)`
     inside a per-partner `try/catch` — it THROWS when there is no established session;
     log and continue (`[DMProfile] broadcast to partner failed`). **Never block UI.**
3. Wire `broadcastProfileToAllDMs` into the SAME two mobile broadcast sites that already
   loop spaces:
   - **`components/ProfileModal.tsx`** name/bio save (~989-1018) and avatar save
     (~904-932): after the existing space loop, fire the DM broadcast fire-and-forget.
     **Match mobile's field convention**: send only fields that changed, and gate `bio`
     on `user.isProfilePublic` (`bio: user.isProfilePublic ? newBio : undefined`) — same
     as the space loop does. (This is a mobile-specific convention; desktop sends bio
     unconditionally. Follow mobile's, for consistency with its space broadcast.)
   - **`WebSocketContext.tsx`** on-connect rebroadcast (~4046-4086): after the spaces
     loop, also rebroadcast to DMs, guarded by the same `lastProfileRebroadcastSigRef`
     fingerprint so reconnects don't spam unchanged data.

> Do not put the broadcast in `AuthContext.updateProfile`. It is not where mobile
> broadcasts, and it runs on every in-memory profile mutation (wrong granularity).

### Field semantics — must match desktop and mobile's space handler

| Field | On the wire | Receiver behavior |
|---|---|---|
| `displayName` | omit if unchanged; non-empty string if changed | truthy guard → empty/absent = preserve |
| `userIcon` | omit if unchanged | truthy guard → empty/absent = preserve |
| `bio` | omit if unchanged; `''` = deliberate clear | `!== undefined` → `''` clears, absent preserves |
| `senderId` | always `selfAddress` | must equal envelope sender or message is dropped |

---

## Files to modify

| File | Change |
|---|---|
| `context/WebSocketContext.tsx` (JS DM path ~2294-2305) | Add `dm-update-profile` intercept after the `call-` intercept, before `saveMessage`. |
| `context/WebSocketContext.tsx` (batch DM path `applyDMGroupResults` ~3209-3366) | Add the identical intercept alongside the `reaction` branch, before `saveMessage`. |
| `context/WebSocketContext.tsx` (on-connect rebroadcast ~4046-4086) | After the spaces loop, fire `broadcastProfileToAllDMs` (send side, phase 2). |
| `components/ProfileModal.tsx` (~904-932 avatar, ~989-1018 name/bio) | After each space broadcast loop, fire `broadcastProfileToAllDMs` (send side, phase 2). |
| `services/dm/dmProfileService.ts` (NEW) | `broadcastProfileToAllDMs` + a `sendUpdateProfileDm` per-partner helper wrapping `sendEncryptedMessageToAllDevices`. Mirror `services/space/spaceMessageService.ts` conventions. |

Approximate diff: receive side ~40-60 lines (two intercepts + shared merge helper);
send side ~60-90 lines (service + two wire-in points). Plus tests.

> Consider extracting the receive merge into a single local helper
> (`applyDmProfileUpdate(content, queryClient, storage)`) and calling it from both DM
> paths, so the two intercepts can't drift — the same drift risk the space handler's two
> copies already carry.

---

## Testing

1. **Two clients with an established DM session** (desktop ↔ mobile, and mobile ↔ mobile).
2. **Desktop → mobile (receive):** change global profile on desktop → mobile's DM partner
   row updates (name/icon/bio) AND **no garbage chat post appears**. Without the fix, a
   post bubble appears.
3. **Mobile → desktop (send):** change global profile on mobile → desktop's DM partner row
   updates without a chat post.
4. **Empty-bio clear:** set a bio, save, confirm partner shows it; clear the bio, save,
   confirm partner's row clears (proves `bio !== undefined` path).
5. **Avatar-only / name-only save:** confirm the unchanged fields are NOT clobbered on the
   partner (proves the omit-unchanged-fields convention).
6. **No-session partner:** a DM row with no active encryption state must not crash the
   broadcast — the per-partner catch swallows the throw and the loop continues.
7. **Anti-spoof:** a `dm-update-profile` whose `senderId` ≠ envelope sender is dropped
   (logged), never applied, never persisted.
8. **Per-space save isolation:** saving a per-space profile (Space Settings → Account)
   must NOT update any DM partner row.

---

## Rollout

- **Receive side is safe to ship first and alone** — it only teaches mobile to recognize
  a new control type and stops rendering it as a post. No visible behavior change until
  someone actually sends one.
- **Send side ships next release**, after receive-side adoption is high, so old mobile
  clients (which lack the intercept) don't get spammed with unknown-type messages that
  render as posts.

---

## Gotchas

- **Two paths, not one** — both receive (JS + batch) and send (ProfileModal + on-connect)
  have two sites each. Miss one and the feature is half-broken in exactly the scenarios
  that are hardest to reproduce.
- **Do NOT add `DMUpdateProfileMessage` to the `MessageContent` union.** It's a control
  message; adding it would make it eligible to persist/render.
- **`content.type` must be `'dm-update-profile'`**, distinct from the space
  `'update-profile'`. The receiver keys off it; mixing them up means the space handler or
  the DM handler silently won't fire.
- **Fire-and-forget on send.** The broadcast must never block the save UI. `enqueueOutbound`
  + per-partner `try/catch`, exactly like the space loops.
- **No `bio` backfill from public profile** on mobile — desktop has a third "public-profile
  pull/write-back" path (`useConversationsWithProfileBackfill`) that mobile may not have.
  That is OUT OF SCOPE here; this task is only the push path (path 2). If mobile lacks the
  pull path, stale identity for session-less / public-profile-less contacts is expected
  (a property of the model, not a bug). File a separate task if the backfill is wanted.
- **Global bio vs per-space bio.** Only the global bio flows to DMs. Per-space bio is
  scoped to spaces. Don't cross them.

## Prerequisite: shared package bump (REQUIRED — see ⛔ BLOCKER at top)

This is the first thing to do, and it gates everything else. The installed `2.1.0-26`
does **not** expose `DMUpdateProfileMessage` or `Conversation.bio` (stale published dist —
verified via `tsc`, errors TS2724 + TS2353). Steps:

1. `npm view @quilibrium/quorum-shared versions` — find a published version whose `dist/`
   contains the types. The `2.1.0-29` SOURCE has them built; confirm the registry build does
   too (the `2.1.0-26` registry build did NOT, despite its `src/` having them — so don't
   assume a version number guarantees a correct dist; verify the published tarball or just
   install and run the `tsc` probe below).
2. Bump the pin in `package.json` and `yarn install`.
3. Re-run the probe to confirm the types resolve:
   ```ts
   import type { DMUpdateProfileMessage, Conversation } from '@quilibrium/quorum-shared';
   const m: DMUpdateProfileMessage = { senderId: 'x', type: 'dm-update-profile' };
   const c: Conversation = { conversationId: 'a/a', type: 'direct', timestamp: 0,
     address: 'a', icon: '', displayName: 'n', bio: 'hi' };
   ```
   `npx tsc --noEmit` on that file must pass (no TS2724 / TS2353).
4. If no good build is published, the shared package must be rebuilt + published first
   (separate task, needs publish access). The `link:../quorum-shared` route desktop uses is
   a dev-only stopgap that won't work in CI / on other machines.

Bump regression risk is LOW (see the shared-package section above) — no other mobile code
change is needed, since mobile imports none of the changed symbols. The bio-validation
constant rename (`MAX_BIO_LENGTH`→`MAX_BIO_BYTES`) does not affect mobile (it defines its
own `MAX_NAME_LENGTH` and never imports a shared bio validator).

---

## Related

- [DM Architecture and Debug Playbook (desktop)](../../../quorum-desktop/.agents/docs/debugging/dm-architecture-and-debug-playbook.md) — read first; the three sync paths and the "no session = no-op" rule.
- [DM debug snippets (desktop)](../../../quorum-desktop/.agents/tools/dm-debug/README.md) — adapt for RN debug bridges.
- Desktop send: `quorum-desktop/src/services/MessageService.ts` `broadcastProfileToAllDMs` / `encryptAndSendDm`.
- Desktop receive: `quorum-desktop/src/services/MessageService.ts` `interceptControlMessages` / `handleDMProfileUpdate`.
- Mobile space-side mirror to steal from: `context/WebSocketContext.tsx` ~1843-1924 and ~3014-3069.

---
*Last updated: 2026-06-12 — status set to BLOCKED. Verified the published 2.1.0-26 dist is missing the required types (stale build); a shared-package bump to a correctly-built version is a hard prerequisite. Bump risk audited as LOW.*
