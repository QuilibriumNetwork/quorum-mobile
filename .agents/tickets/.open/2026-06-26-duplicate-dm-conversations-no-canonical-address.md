---
type: bug
title: "Duplicate DM conversation rows for the same partner (partner surfaces under two addresses, no dedup)"
status: open
created: 2026-06-26
---

# Duplicate DM conversation rows for the same partner (partner surfaces under two addresses, no dedup)

**Status:** Open — analysis complete, fix not yet applied. Mechanism narrowed
(partner's two keys → two addresses + no partner-level dedup); not yet proven
against the live reproduction — needs the two rows' `conversationId` strings.
**Severity:** Medium (data-model integrity; user-visible duplicate + a "dead" row wearing your own identity)
**Affects:** quorum-mobile AND quorum-desktop (same structural defect on both — see "Desktop" below)
**Related:** [`.solved/2026-06-26-dm-self-profile-overwrites-partner-row.md`](2026-06-26-dm-self-profile-overwrites-partner-row.md) — the self-echo profile bug is what makes the duplicate row wear *your* face.

## Symptom (as reported)

Two conversation rows appeared in the messages list, **both** with the user's
own profile picture + username, **both** for the same partner (user B). When B
replied, only **one** row got corrected (B's name + avatar); the other stayed
frozen showing the user's own identity. Deleting the dead row brings it back on
the next sync/rebuild.

Observed in a multi-client test setup: user A on mobile **and** a desktop
(same account, two devices), user B on a third desktop. Reproduced once.

## Root cause

A DM conversation row is keyed by `conversationId = `${address}/${address}``.
The same partner must always produce the **same** address string, or you get
two independent rows. The store has **no partner-level dedup** — it keys
verbatim on whatever address string each path supplies, and never reconciles
two rows that point at the same human via two different keys/addresses. (An
address itself is deterministic, so the issue is NOT case/format normalization
of one address — see "what an address is" below — it's that the *same person*
can surface under two different addresses and nothing merges them.)

The partner address reaches the conversation store from several paths, each
using a *different* source:

| Path | Partner-address source | File |
|---|---|---|
| Start / new conversation | UI input or `deriveAddress(resolveKey)` for @usernames, else raw typed string | `components/NewConversationModal.tsx:153-164`, `hooks/chat/useStartDirectMessage.ts:40` |
| Send (row update) | the conversation's stored `address` | `hooks/chat/useSendDirectMessage.ts` (onSuccess) |
| Receive (real message from B) | the envelope's self-declared `unsealed.user_address` | `context/WebSocketContext.tsx:2542`, `services/crypto/encryption-service.ts:644` |
| Receive (multi-device self-echo) | `decryptedMessage.channelId` = the address **A** used when starting the DM | `context/WebSocketContext.tsx:2680`, `:3804` |

If any two of these produce a different address string for the same partner,
two rows are born. **The key question is: can they actually differ?**

### First, what an address is (rules out the trivial theories)

An address is `deriveAddress(publicKey) = base58(sha256(publicKey))`
(`services/onboarding/keyService.ts:111-117`). It is **deterministic**: one
public key → exactly one "Qm…" string. There are NOT "two forms of the same
address." base58 has no case ambiguity here. So a duplicate is NOT caused by
casing/whitespace drift of a single address — that earlier hypothesis was
wrong. A duplicate requires the two paths to be hashing **two genuinely
different keys** (or one path supplying an address built from a different key).

Important: the @username path does NOT introduce a different key in the normal
case. When B publishes `@bob`, B sets `resolveKey = user.publicKey`
(`components/ProfileModal.tsx:1535`, `components/qns/NameDetailModal.tsx:148`).
So starting a DM via `@bob` computes `deriveAddress(B.publicKey)` — the **same
string** B's own messages derive from. Normal flow → one row, no duplicate.

### The mechanism that CAN produce a duplicate: B's published key ≠ B's live messaging key

The only way the two paths disagree is if **B's QNS-published `resolveKey`
points at a different key than the identity key B currently signs DM envelopes
with.** Then:
- **Row A (your start/self-echo form):** `deriveAddress(resolveKey)` =
  `QmAAA…` — what QNS advertises for @bob.
- **Row B (B's real reply form):** `unsealed.user_address` =
  `deriveAddress(B's-current-messaging-key)` = `QmBBB…`.

These are two **genuinely different addresses** (different keys), both belonging
to B. They are NOT two encodings of one address. This is plausible exactly in
the reported setup: **B was on a freshly set-up third desktop**, and the account
was re-tested across clients — i.e. a state where B's live identity key can
differ from a stale/earlier QNS `resolveKey` record.

This matches the symptom precisely:
- B's replies always carry B's **current** form (`unsealed.user_address` =
  `QmBBB…`), so they land on **Row B** and update it with B's name/avatar. ✅
- **Row A** (`QmAAA…`, created by your start or your multi-device self-echo via
  `decryptedMessage.channelId`) never receives anything from B — B never signs
  with `QmAAA…`'s key — so it stays frozen, wearing your own identity (the
  separate, now-fixed self-echo-profile bug). ❌

A secondary aggravator: the start-flow dedup check is **case-insensitive**
(`NewConversationModal.tsx:133`, `c.address?.toLowerCase() === searchAddress`)
while storage is **case-sensitive verbatim** (`:159-164`). This is a real
asymmetry worth tightening, but base58 addresses don't realistically drift in
case, so it is unlikely to be the actual trigger here — noted for completeness,
not as the lead hypothesis.

### NOT yet proven from code alone

The code **permits** the key-mismatch mechanism but does not **prove** it
occurred in the one reproduction. Confirming it needs the two rows' actual
`conversationId` strings: if they are two visibly different `Qm…` strings, that
is two different keys = this mechanism. A dev-only log at the two row-creation
points (`WebSocketContext.tsx:2750` + the self-echo path) printing
`conversationId` + address source would make the next reproduction conclusive.

### Why deleting it brings it back

Deletion is **local-only**. The originating message still sits **undeleted on
the server inbox** (ordinary posts aren't `deleteInboxMessages`'d, unlike some
control messages). On the next sync/relaunch it's re-decrypted and re-creates
the row. The resurrection confirms the row is regenerated from a persistent
server-side message, not stale local cache.

## Desktop: same defect

Investigated `quorum-desktop`. **Same structural vulnerability, no extra
protection:**

- `conversationId` is always raw `address + '/' + address` at every path:
  RECEIVE `MessageService.ts:2847`, SEND `:2357`/`:2650`, START
  `NewDirectMessageModal.tsx:69`, `addOrUpdateConversation` `MessageDB.tsx:340`.
- **No canonical normalization** before composing the id or saving. `deriveAddress`
  is called only for QNS @username resolution (`useResolveQnsName.ts:30`), never
  on the raw Qm… path.
- **No partner-level dedup.** `messageDB.saveConversation` (`db/messages.ts:~1004`)
  is a blind `store.put` upsert by exact `conversationId`.
  `useDirectMessageCreation.ts:47-48` compares by `address` for UI only — it
  doesn't prevent a second row.
- Self-sync guard exists (`MessageService.ts:2852-2855`) but, like mobile,
  rewrites to `decryptedContent.channelId` (UI-supplied, non-canonical) under a
  strict `==` compare.

So this is a **cross-repo data-model defect**, not a mobile-only quirk. Desktop
likely just hits it less often because its multi-client / address-form
divergence conditions arise less in normal use.

## Proposed fix (not yet applied — needs lead input, touches both repos)

Order matters: the load-bearing fix is **dedup by partner**, because the two
addresses can be genuinely different (different keys) — both already canonical,
so normalization alone would NOT merge them.

1. **Dedup / reconcile by partner (the real fix).** When saving a `direct`
   conversation, detect that an existing row refers to the same human under a
   different address and **merge** rather than insert a second row. "Same human"
   needs a stable link — e.g. tie the row to B's QNS name or treat the
   QNS-published `resolveKey` address and the live messaging address as
   aliases. This also covers "delete → it comes back," since the regenerating
   server message would merge into the surviving row instead of resurrecting a
   second one.
2. **Investigate the upstream cause: why does B surface under two keys?** The
   duplicate is downstream of a key/identity inconsistency — B's QNS-published
   `resolveKey` not matching B's live DM-signing identity key (likely from
   re-registration / multi-client setup). Worth confirming whether this is
   expected (key rotation) or a registration/onboarding bug on its own. If keys
   should always match, fixing *that* removes the duplicate at the source.
3. **Tighten the start-flow dedup asymmetry** (cheap, low-risk): make the
   "already exists?" check and the stored key use the same comparison
   (`NewConversationModal.tsx:131-133` vs `:159-164`). Minor, not the main
   cause.

A shared `quorum-shared` helper (canonical conversation-id + partner dedup)
would let both apps share one implementation, since the defect is identical on
desktop and mobile. Per atlas §3 "shared before desktop, mobile last" if it
becomes a shared wire/helper change.

## To confirm the mechanism next time it reproduces

- **The two rows' actual `conversationId` strings.** Two different `Qm…`
  strings ⇒ two different keys for B ⇒ the key-mismatch mechanism above. Both
  are already canonical, so the diff IS the proof (not casing).
- B's QNS-published `resolveKey`-derived address vs the `user_address` B's live
  messages actually carry — do they match? If not, that's the upstream cause.
- A dev-only log at the two row-creation points (`WebSocketContext.tsx:2750` +
  the self-echo rewrite) printing `conversationId` + address source would make
  the next reproduction conclusive instead of inferred.

## Scope note

Analysis only — no code changed for this report. The companion self-echo fix
(`fix/dm-self-profile-overwrites-partner-row`) addresses *why the duplicate
wears your face*, not *why the duplicate exists*; this report covers the latter.

*Last updated: 2026-06-26*
