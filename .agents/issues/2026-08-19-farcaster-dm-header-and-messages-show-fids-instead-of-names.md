---
type: bug
title: "A Farcaster DM shows raw FIDs instead of names, in the header and on every message"
status: in-progress
priority: high
ai_generated: true
created: 2026-08-19
updated: 2026-08-19
area: "Farcaster DMs / identity resolution / chat UI"
---

# A Farcaster DM shows raw FIDs instead of names, in the header and on every message

## Summary

Open a DM from a Farcaster user and the conversation header reads `fid:1043504`
instead of their name, and every message row — both sides — is headed by a bare
FID rather than a name. The DM inbox list beside it shows the correct name the
whole time, which is what makes the defect look like a data problem when it is
purely a rendering one.

Regression from #249 (`ed7592c`, "names resolve through one verified ladder").
Reported by the operator on 2026-08-19.

## Status

Fixed on `fix/farcaster-dm-shows-fid-instead-of-name`. 8 new tests, each shown
RED against the reverted fix and green with it; the 5 pre-existing tests in the
same two files stayed green under that revert, so the arm is controlled. Full
suite 1131/1131. `tsc` unchanged at the 12 pre-existing errors. Lint findings on
the touched files identical before and after (6: 1 error, 5 warnings, all
pre-existing).

Not yet confirmed on a device. That is the remaining verification: the tests
prove the right string is chosen, not that the two-line header lays out
correctly inside a 44px bar on a real screen.

## Mechanism

Quorum and Farcaster are two identity namespaces that look identical to a
string comparison. A Quorum sender is an address; a Farcaster sender is a FID.

Before #249 the message list rendered `item.userName`, the name carried on each
message. #249 replaced that with a live resolution through the Quorum member
ladder — correct for Quorum, and the whole point of that work. Nothing excluded
Farcaster.

The failure is silent by construction:

1. `resolveWithFallback` (`identity/useResolvedName.ts:47`) finds no tier for a
   FID and falls through to `truncateAddress`.
2. `truncateAddress` delegates to shared's `formatAddress`, which returns any
   string shorter than `start + end + 1` **unchanged**.
3. A FID is always shorter than that. So the "truncated address" IS the FID.

No throw, no log, no empty string — just a number where a name belongs.

### The three affected surfaces

| Surface | What it rendered | Why |
|---|---|---|
| DM header (`DMChatHeader.tsx:65`) | `fid:1043504` | Resolved `address`, which for a Farcaster conversation is the synthetic `fid:<n>` string built at `useFarcasterDirectCasts.ts:73` |
| Message rows (`MessagesList.tsx`, 3 sites) | `1043504` | Resolved `item.userId`, which `directCastToDisplayMessage` sets to `String(senderFid)` (`types.ts:605`) |
| Wasted lookups (`MessagesList.tsx`) | — | Every FID entered the QNS enrichment and Apex batches, which can only miss on one |

The DM screen (`app/(tabs)/messages/dm/[id].tsx:396-404`) computed the correct
title all along via the QNS-free `resolveConversationTitle`, but passed it only
to `Stack.Screen options.title`, which nothing renders. The visible header never
received it.

### Why the inbox list was unaffected

`DirectMessagesList.tsx:109` branches on `source === 'farcaster'` and uses
`item.displayName`. That branch is exactly what the header and the message list
were missing.

## Fix

Farcaster senders are excluded from the Quorum ladder, and their own name is
used instead.

- `MessagesList.tsx` gains `isFarcasterNamespace` and an `isFarcasterSender()`
  predicate. The predicate is **per sender, not per list**, because the two
  namespaces genuinely mix: a space channel bound to a Farcaster channel merges
  casts (`fc:`-prefixed, from `castToDisplayMessage`) into a stream of real
  Quorum senders. A whole-list flag would be wrong there.
- `DMChatHeader.tsx` gains `displayName`, used only when the conversation is
  Farcaster. The resolver is handed `''` on that branch so the hook still runs
  unconditionally but resolves nothing and fetches nothing.
- QNS enrichment and Apex batching filter Farcaster senders out **before** the
  `MAX_QNS_LOOKUPS` cap, so in a mixed channel a FID cannot crowd a real Quorum
  sender out of the capped set.

`item.userName` is used as the answer **only** for a Farcaster sender. For a
Quorum member it stays ignored: that field is frozen at write time, so an old
row can carry a stale or forged name, and resolving live is the entire point of
routing through the ladder.

## Linked Quorum identity, added in the same change

The operator asked for the merged-profile `.q` to appear here too, which it did
not — the badge existed but had never been wired into DMs.

`DMChatHeader` now renders `QuorumIdentityBadge` beneath the Farcaster name for
a **one-to-one** Farcaster DM. The route is the sanctioned one:

```
fid → /users/by-fid/:fid → linked Quorum address → the ladder → "name.q"
```

The FID itself is never a ladder input. The `.q` sits *beside* the Farcaster
name, never in place of it — same rule the feed surfaces follow, and for the
same reason: the Farcaster account is who this conversation is actually with,
and replacing its name would hide that.

Withheld for groups. `farcasterFid` is populated from `viewerContext.counterParty`
even for a group, so gating on the FID alone would pin one arbitrary member's
Quorum identity to the whole conversation.

The uncapped-lookup concern in
`.open/2026-08-13-quorum-identity-badge-fires-an-uncapped-fid-link-lookup-per-cast.md`
does not apply: one badge mounts per conversation, which is the bounded fan-out
the badge's own prop doc requires of a caller. That issue is about a feed
rendering hundreds of casts at once.

## Other client

Not applicable. Desktop's Farcaster surface is a 40-line "Coming soon"
placeholder (`src/components/farcaster/FarcasterPage.tsx`); it has no Farcaster
DMs to break.

## Tests

`__tests__/migrated/MessagesList.test.tsx`
- renders the carried name, not the FID, in a Farcaster DM
- never fetches a Quorum profile for a FID
- resolves Quorum senders to their `.q` while leaving cast authors alone in the
  same mixed channel, and spends exactly one profile lookup doing it

`__tests__/migrated/DMChatHeader.test.tsx`
- renders the Farcaster name, not the synthetic FID address
- never resolves the FID against the Quorum ladder
- shows the linked `.q` as a badge beneath the name when profiles are merged
- stays a plain one-line title when the FID has no linked Quorum identity
- shows no badge for a group

Also moved that file's `beforeEach`/`afterEach` to the top level. Per-describe
setup left later blocks sharing the previous block's QueryClient, and a
react-query entry already resolved under an old mock is still fresh (30 minutes
here), so it never refetches and a reassigned mock is never consulted. That
produced a test failing for a reason unrelated to the code under test.

## Follow-up not done here

Message rows in a Farcaster DM still show no linked-identity badge. Only the
header does. Adding it per row would reintroduce exactly the uncapped fan-out
the open badge issue describes, and in a 1:1 DM it would repeat the same two
identities down the whole conversation. Worth revisiting only alongside that
issue.

---

*Last updated: 2026-08-19*
