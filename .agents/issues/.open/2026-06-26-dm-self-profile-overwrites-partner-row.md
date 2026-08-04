---
type: bug
title: "DM self-echo: phantom self-address row + partner row wears MY identity"
status: open
created: 2026-06-26
---

# DM self-echo: phantom self-address row + partner row wears MY identity

**Status:** 🟡 ROOT-CAUSED AND FIXED 2026-07-27, device verification pending.
PR #186 (`5a49495`, merged to master). Do NOT move to `.solved/` until LaMat
confirms on device that the row stops reappearing after deletion.

## ROOT CAUSE (2026-07-27) — a dead React dependency, not a missing guard

The #145 guards were correct. **They never executed.**

`handleIncomingMessage` in `context/WebSocketContext.tsx` is a `useCallback`
whose dependency array is `[queryClient, storage, applyDmProfileUpdate]` —
**`user` is not in it**, and all three deps are permanently stable
(`queryClient` is a context value, `storage` is `useMemo(() => new
MMKVAdapter(), [])`, `applyDmProfileUpdate` derives from those two).
`WebSocketProvider` is mounted unconditionally inside `AuthProvider`
(`app/_layout.tsx`), while `user` starts `null` and is restored by an async
effect. So the callback is created **once, with `user === null`, and never
recreated** — every `user?.address` inside it is `undefined` for the app's
whole lifetime.

Four guards in the live DM path and one in the batch path were therefore dead
code: the init-envelope self-echo drop, the subsequent-message self-echo drop,
the self-profile drop (which is why the row wore OUR identity), and
`delete-conversation-self` in both paths. A self-echo fell straight through to
the conversation-row save and created `<self>/<self>` with the envelope
profile — ours.

**Why #145 verified and then resurfaced.** The batch path
(`applyDMGroupResults`) was already correct: its `isSelfSyncEcho` uses
`fullUserAddrRef.current`. The delivery/read-ack stream #145 was tested against
arrives batched, so the count held at 1. Init envelopes and individual decrypts
go through the live path, where the comparison was dead — so the row came back
later. The 2026-06-28 hypothesis below (falsy `authenticatedDmSender` on an init
sub-path) was close but not the mechanism: the comparison target was
`undefined`, which is fatal on every sub-path, not just one.

**Why desktop doesn't show this.** Desktop's equivalent lives in
`MessageService`, a plain class — no closure to go stale. Its
`envelope.user_address != self_address` check works. Desktop's version of this
symptom was a genuinely different, genuinely fixed defect.

`react-hooks/exhaustive-deps` had been flagging it the whole time (it names
`user?.address` as a missing dependency) but it is one of 36 warnings on the
file.

**Fix:** the six sites now use `fullUserAddrRef.current`, the ref the file
already declares for this purpose and already uses at ~20 other sites.
Guarded by `__tests__/dmSelfEchoGuards.test.ts`, a static invariant test
(these guards sit inside two ~2000-line callbacks with no harness able to
drive a frame through them); it fails 6/7 against the pre-fix source.

**Still open — follow-up PR:** the same stale-closure comparison remains at
three space-message sites (`participant.address === user?.address` and two
`senderId === user?.address`). Enabling them changes which copy of your own
space message renders (inbox echo vs optimistic update), so it needs its own
testing. They are listed as a named allowlist in the test, so any NEW violation
still fails.

**Meta-lesson:** the guard existed, read correctly, and had a passing live
verification. What was wrong was the _value it compared against_. When a guard
"is there" but the symptom persists, check that the guard's inputs are live
before adding another guard.

---

## HISTORICAL — the 2026-06-28 reopening and its debug plan (superseded above)

**Status at the time:** 🔴 REOPENED — PARTIALLY fixed, NOT solved. PR #145
(merged to master) added the self-echo drop + self-profile-drop and the phantom
row was verified gone _in the moment_ (count held at 1 under the ack stream).
BUT the phantom `selfAddress/selfAddress` row (own pfp/name, "No messages yet")
**RESURFACED later** after the user had deleted it.

> ⚠️ "Verified" in #145 was premature — it held in the moment observed, not
> durably. The resurfacing is the real signal. Verify durably next time, not
> just in-the-moment.

Planned debug approach (never run — the cause was found by code reading
instead; line numbers below are from June and have drifted):

**Resolve this FIRST — it splits the cause cleanly:** does the row resurface LIVE
(an incoming message hits an unguarded creation path) or on RELOAD/RESTART (it
resurrects from storage / an undeleted server-side message on re-sync)? User
couldn't recall which.

Plan:

1. Temp probe at EVERY `selfAddress/selfAddress` row creation, logging the PATH +
   decrypted message shape (`type`, `channelId`, `senderId`, `conversation_id`).
   `saveConversation` sites in `context/WebSocketContext.tsx`: live-JS `~2802`
   (new) / `~2814` (update), batch `~3927`/`~3937`. The #145 guards: JS `~2714`
   (`authenticatedDmSender === user?.address`), batch `~3843-3849`
   (`isSelfSyncEcho`). Suspected gaps:
   - JS guard needs `authenticatedDmSender` SET; an init sub-path leaves it `''`
     (falsy) → guard skipped (flagged in an earlier investigation this session).
     _(2026-07-27: close, but not it — see ROOT CAUSE above.)_
   - Resurrection-from-server: deletion is LOCAL-ONLY; the undeleted server inbox
     message re-decrypts on sync and may re-create the row via an unguarded path
     (see the duplicate-rows report's "why deleting brings it back").
     _(2026-07-27: this half was right — it is why deletion doesn't stick.)_
2. Reproduce: delete the row, then (a) leave the app open a while, and (b)
   reload/restart — note which brings it back + capture the probe line.
3. Also glance at `hooks/chat/useStartDirectMessage.ts:42` + embed/send paths,
   though those create with EMPTY identity (not the self-stamp), so less likely.

## What #145 DID land (keep — correct as far as it goes)

PR #145 on master, `context/WebSocketContext.tsx`. Re-applied the never-merged
commit `9365f6d` and extended it (channel-less self-echo drop in 3 receive
branches + self-profile drop). It reduced but did not eliminate the phantom row.

**Two defects, same self-echo origin:**

1. **Phantom self-address row (the new half, root-caused 2026-06-28).** The user's
   own DESKTOP sends DM **delivery-ack / read-ack** receipt control messages
   every 5–10s (`quorum-shared` `ReceiptService`). These are flat objects —
   `type` is TOP-LEVEL (`{senderId, type:'delivery-ack', messageIds}`), **no
   `content` wrapper, no `channelId`** — and they fan out to ALL the user's
   devices incl. the phone. Mobile has **zero receipt handling**, so mobile's
   `decryptedMessage.content?.type` reads `undefined`, the self-sync rewrite
   (which needs `channelId`) is skipped, and the message saved a
   `selfAddress/selfAddress` conversation row (own pfp/name, "No messages yet").
   **Fix:** drop channel-less self-echoes in all 3 receive branches
   (init-envelope, JS subsequent, batch). VERIFIED: with the phantom row deleted,
   the conversation count holds at 1 under the constant ack stream instead of
   regenerating. Confirmed the stream IS receipts (flat top-level `type`,
   `type=undefined` via `content?.type`, self-sender, channel-less, ~5–10s).

2. **Partner row wears MY identity (the original `9365f6d` half).** On a self-echo
   the envelope profile is OURS; both receive paths wrote it into the row. Drop
   the envelope profile on a self-echo (mirrors desktop's
   `envelope.user_address != self_address`).

**Important:** the phantom-row drop is a correct BACKSTOP, not the receipt feature.
Mobile _should_ eventually intercept + process these acks (show ✓/✓✓, send acks
back) — that's the separate, roadmapped **DM-receipts mobile wiring** (shared
already published in `2.1.0-31`, memory `dm-receipts-shared-done-in-31`). A real
receipt interceptor would catch them before this drop; the drop stays correct for
any OTHER unhandled channel-less self-echo.

**File:** `context/WebSocketContext.tsx`

## Symptom

Open a DM with someone who hasn't replied yet (but with whom there's a prior
conversation, especially one carried over from another device): the header /
list row show **my own** display name + avatar in place of the partner's. As
soon as the partner sends a new message, the correct name + avatar appear.
Reproduced once; intermittent because it needs a cross-device self-echo.

## Root cause

Multi-device send fans a DM out to the recipient's devices **and to my own
other devices** (self-sync). The encrypted `InitializationEnvelope` carries the
**sender's** identity (`display_name` / `user_icon`) — which on a self-echo is
**mine**.

The incoming-DM handler correctly rewrites the conversation to point at the
recipient (`if (senderAddress === user.address) conversationId =
recipient/recipient`) but then wrote the conversation row's `displayName`/`icon`
straight from the envelope profile — i.e. **my** identity — until a real
partner message replaced it. Both receive paths had the gap:

- Live/JS path: `userProfileFromEnvelope` (set with no self-check), used at the
  row write (`displayName: userProfileFromEnvelope.displayName`, etc.).
- Native batch path: `msgResult.user_profile`, same.

## Fix

Mirror desktop. Desktop only applies the envelope profile when the sender isn't
self (`if (envelope.user_address != self_address) updatedUserProfile = ...`);
otherwise it falls back to the existing/partner row, so a self-echo never
overwrites the partner.

Mobile now drops the envelope profile on a self-echo in both paths:

- Live: clear `userProfileFromEnvelope` when `authenticatedDmSender ===
user.address` (the true pre-rewrite sender).
- Native: `rowProfile = isSelfSyncEcho ? undefined : msgResult.user_profile`.

The row then keeps the partner's existing/public-profile identity (header +
list already back-fill from `useUserPublicProfile` and fall back to truncated
address + `DefaultAvatar`).

## Scope / risk

Mobile-only, additive, statically verifiable. `npx tsc` and `eslint` show **no
new errors/warnings** (the file's pre-existing baseline error/warnings are
unchanged). No shared/protocol change. iOS unverified at runtime (reasoned via
review; logic is platform-agnostic).

_Last updated: 2026-07-27_
