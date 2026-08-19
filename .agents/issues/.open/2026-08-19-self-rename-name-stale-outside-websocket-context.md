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

## Reproduction to run first

1. Open a space you are a member of on mobile.
2. Change your own display name via the profile edit modal.
3. Watch your own row in the member list.

**Pass:** name and avatar both update within seconds.
**Fail (expected today):** avatar updates, name does not, until the app is restarted.

## Status

Open, not started. Found during the whole-branch review of the DM identity
reveal ledger branch, filed rather than fixed there because none of that plan's
eight tasks touch these files and widening the branch late would have been scope
creep.

---
*Last updated: 2026-08-19*
