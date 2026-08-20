---
type: bug
title: "A member rename written outside WebSocketContext updates the avatar but not the name until restart"
status: open
priority: medium
created: 2026-08-19
updated: 2026-08-19
area: identity / react-query cache invalidation
related:
  - "issues/2026-08-18-dm-identity-reveal-ledger-plan.md (fixed the same bug class inside WebSocketContext.tsx, Task 2)"
---

# Six `saveSpaceMember` sites still skip the identity-roster invalidation

## Summary

Space member **names** and **avatars** are read from two different React Query
caches:

| Surface | Query key | Who updates it |
|---|---|---|
| avatars | `queryKeys.spaces.members(spaceId)` | patched in place by each write path |
| names | `['identity-roster', spaceId]` | consumed at `hooks/useMultiSpaceRosters.ts:26` |

The roster query is observed by a permanently-mounted observer at the app root,
and a permanently-mounted observer never refetches a stale query on its own. So
any code path that writes a member row without invalidating that key produces a
split: the new **avatar** appears immediately, the new **name** appears only
after an app restart.

This was found on device and fixed for the two `update-profile` handlers plus
the join-row handler in `context/WebSocketContext.tsx` (see the DM identity
reveal ledger work, Task 2, which added `identity/invalidateRoster.ts`).

**Six other write sites were never covered**, because they live outside that
file and outside that plan's scope.

## The uncovered sites

READ, 2026-08-19:

- `components/SpaceSettingsModal.tsx:691` — writes `display_name`, invalidates only `queryKeys.spaces.members`
- `components/UnifiedProfileEditModal.tsx:195` — writes `global_display_name`, invalidates only `queryKeys.spaces.members`
- `hooks/chat/useSpaceActions.ts:452`
- `services/config/spaceSyncService.ts:95`
- `services/config/spaceSyncService.ts:279`
- `services/space/spaceService.ts:300`
- `services/space/spaceService.ts:989`

## CONFIRMED ON DEVICE, 2026-08-20 — this is no longer a theory

Reproduced by the operator on the Android emulator, live session, no reload:

> Changed the per-space display name in **Space Settings → Account**. In the
> channel messages and in the member list, the name shown was still the GLOBAL
> one. The per-space override did not appear until the app was restarted.

That is `components/SpaceSettingsModal.tsx` — READ at `:696`, the write path
invalidates exactly one cache:

```ts
await adapter.saveSpaceMember(spaceId, merged as never);
queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) });
// ← no invalidateRosterCaches(queryClient, spaceId)
```

The comment directly above it explains the members invalidation and is correct
as far as it goes; it simply predates the `['identity-roster', spaceId]` cache
that names are actually read from. So the write lands, the avatar path
refreshes, and the name keeps serving the previous value.

**Severity is higher than "medium" implies for this site specifically.** A
per-space nickname is a feature whose entire observable effect is the name
changing. Until a restart, it appears to do nothing at all.

## A second, probably separate bug found in the same session

The **placeholder** of that same Display-name field showed a STALE GLOBAL NAME —
the operator's previous global name, after they had already changed it and while
the space member list correctly showed the NEW one.

READ: the placeholder is `selfNamePlaceholder(selfResolved, user, …)`
(`SpaceSettingsModal.tsx:1732`), which returns `user.displayName` unless a
verified `.q` exists (`utils/resolveSelfName.ts:109-114`). So it renders
`AuthContext`'s `user.displayName`.

That should NOT be stale: `AuthContext.updateProfile` (`:514-521`) updates state
AND persists to MMKV in the same call, and `SpaceSettingsModal` depends on
`user?.displayName` in its memo deps (`:845`), so it is not a stale closure.

**So the interesting question is which path the global rename actually took.**
If it did not go through `updateProfile`, the identity maps and `AuthContext`
have diverged, and every surface reading `user.*` directly is stale — a wider
problem than the roster invalidation above. UNRESOLVED: needs the exact screen
the global rename was made from before anything is concluded. Do NOT fix this
one by patching the placeholder; that would paper over a divergence.

## Why this probably affects the user's OWN rename

`identity/identityFromMaps.ts:90` states it explicitly:

> Self resolves from the same tiers as anybody else — there is no self special case in the ladder.

So editing your own per-space nickname (`SpaceSettingsModal`) or your own global
display name (`UnifiedProfileEditModal`) writes the row, refreshes the avatar,
and leaves the ladder serving the previous name until the app restarts. That is
the most user-visible instance of this bug and it is entirely local — no network
involved, so it should reproduce every time.

**INFERRED, not yet measured.** Nobody has run this specific case on a device.
Confirm before assuming.

## Fix

The helper already exists. Call it after each write:

```ts
import { invalidateRosterCaches } from '@/identity/invalidateRoster';
// ...after the saveSpaceMember write:
invalidateRosterCaches(queryClient, spaceId);
```

Before adding it blindly to all seven, read each site and decide whether its
write can actually change a name slot. Task 2 deliberately skipped four
`WebSocketContext.tsx` sites (leave / kick / verify-kicked / rekey-kick) after
confirming each spreads an already-correct row and mutates only
`inbox_address` / `isKicked`. Some of these seven may be the same shape.

## Reproduction A — CONFIRMED on device 2026-08-20 (per-space name)

This is the one that has actually been run. It is the **per-space** rename, in
Space Settings, not the global rename the original filing guessed at.

1. Open a Space you are a member of on mobile.
2. **Space Settings → Account → "Your Profile in This Space" → Display name.**
   Set a per-space name and save.
3. Watch the channel messages and your own row in the member list.

**Pass:** the per-space name appears within seconds.
**FAIL — observed:** both keep showing the global name. It only appears after an
app restart.

Site: `components/SpaceSettingsModal.tsx:696`.

> **Not observed either way: the avatar.** The original filing predicted "avatar
> updates, name does not". Only the name half has been tested. Do not repeat the
> avatar claim as fact until someone checks it.

## Reproduction B — NOT yet run (global name)

The original hypothesis, still unconfirmed. Different site, same shape.

1. Open a Space you are a member of on mobile.
2. Change your **global** display name via the profile edit modal.
3. Watch your own row in the member list.

**Fail (predicted):** the name does not update until restart.

> ⚠️ Running this lane is currently confounded by
> `issues/.open/2026-08-20-config-sync-silently-reverts-a-display-name-rename.md`,
> which can revert a global rename outright. Settle that one first, or you cannot
> tell "the cache did not refresh" from "the value was overwritten".

## Status

Open, not started. **Reproduction A confirmed on the Android emulator by the
operator, 2026-08-20**, upgrading this from INFERRED to MEASURED for the
`SpaceSettingsModal` site. The other six sites remain unverified individually.

Found during the whole-branch review of the DM identity reveal ledger branch,
filed rather than fixed there because none of that plan's eight tasks touch these
files and widening the branch late would have been scope creep.

---
*Last updated: 2026-08-19*
