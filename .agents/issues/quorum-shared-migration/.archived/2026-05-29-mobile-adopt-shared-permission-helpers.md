---
type: task
title: "Mobile adoption: shared permission helpers (hasPermission, getUserPermissions, getUserRoles)"
status: in-progress
status-updated: 2026-06-14
created: 2026-05-29
urgency-reassessed: 2026-06-09
triggered-by:
  finding: 2026-05-29 Phase 2 verification (desktop's quorum-shared-migration)
  desktop-task-file: ../quorum-desktop\.agents\tasks\quorum-shared-migration\2026-05-29-migrate-role-mutation-helpers.md
runtime-test: required
priority: medium-high (correctness framing) / low-medium (actual user-visible impact — see 2026-06-09 reassessment)
---

# Mobile adoption: shared permission helpers (hasPermission, getUserPermissions, getUserRoles)

> ## ⛔ WON'T DO 2026-06-14 — this task's PREMISE IS WRONG. Do not implement it.
>
> Started implementing on 2026-06-14, then a deep dive (+ user catch) proved the whole task is
> wrong-headed. **Abandoned the branch, discarded all code.** Here's why:
>
> The task's stated goal — *"route the three permission hooks through shared, picking up the
> `isSpaceOwner` short-circuit so owners get pin/delete"* — **contradicts the verified Quorum design**:
> - **Other clients CANNOT know who the space owner is** (no `ownerAddress` on the wire — privacy by
>   design; desktop bug #111 `space-owner-privacy-limitation.md`). So owner-initiated moderation is
>   **not verifiable by receivers.**
> - **KICK is the ONLY action an owner can do as owner** — it's verified at the protocol level via the
>   owner's Ed448 key (server rejects an unsigned kick). **Everything else (pin, delete, post in
>   read-only, @everyone) requires a verifiable ROLE**, enforced on the RECEIVE side against the
>   synced manifest. An owner with no role must assign themselves a role.
> - The shared `hasPermission`'s `if (isSpaceOwner) return true` (and `getUserPermissions`'s owner
>   branch) is a **documented BUG**, not a feature — it grants owners implicit pin/delete/@everyone
>   that receivers then reject. The cross-repo fix plan says to **REMOVE** it.
>
> Verified live on mobile (2026-06-14 trace): an owner-with-no-role tapping **Delete** sends a normal
> `remove-message`; every receiver runs `createChannelPermissionChecker({ isSpaceOwner: false })` and
> **drops it as unauthorized** (`WebSocketContext.tsx` ~1903 / ~3188). **Pin** is local-MMKV-only — no
> wire effect at all. So the `|| isSpaceOwner` on `[channelId].tsx:58-59` shows buttons for actions
> that don't work cross-client. This task would have *entrenched* that bypass in the hook — the exact
> opposite of the fix.
>
> **The correct work is the inverse and it's NOT a mobile-only task:** remove the owner-bypass from
> shared `hasPermission` (a shared+desktop change needing a publish — lead-dev/shared territory).
> Tracked in **[`../2026-06-12-owner-permission-bypass-cross-repo-fix.md`](../../.done/2026-06-12-owner-permission-bypass-cross-repo-fix.md)** (which already names THIS task as wrong) and the findings index
> **[`../../reports/2026-06-12-permission-and-message-parity-findings-index.md`](../../reports/2026-06-12-permission-and-message-parity-findings-index.md)**.
>
> **The only salvageable nugget** (if anyone ever revisits): the ~60-LOC dedup of the three hooks ONTO
> shared could be fine ON ITS OWN — but only AFTER shared's owner-bypass is removed, and you'd pass
> `isSpaceOwner: false` (mobile already proved that's the right value on the receive side). Until then,
> leave the hooks as-is; routing them through the buggy shared helpers makes things worse, not better.
>
> Corrections to the stale prose below (recorded for provenance): the `isSpaceOwner` source is
> `!!getSpaceKey(spaceId,'owner')` not `space.ownerAddress` (no such field); `useHasPermission` has two
> call sites not one. These don't rescue the task — the premise is still wrong.

> **🔍 2026-06-09 — Call-site audit reassessment.** The original framing called this a correctness fix because mobile's hooks ignore `isSpaceOwner`, so owners' permissions silently return `false`. A call-site sweep on `quorum-mobile@master` (2026-06-09) found this is **latent risk, not a user-visible regression**:
>
> - **`useHasPermission`** — exactly ONE caller in the entire mobile codebase: [`app/(tabs)/spaces/[id]/[channelId].tsx`](../../app/(tabs)/spaces/[id]/[channelId].tsx) lines 51-59. That caller already manually OR's `isSpaceOwner` into the result:
>   ```ts
>   const isSpaceOwner = useMemo(() => !!getSpaceKey(spaceId, 'owner'), [spaceId]);
>   const hasRolePin = useHasPermission(spaceId, user?.address, 'message:pin');
>   const hasRoleDelete = useHasPermission(spaceId, user?.address, 'message:delete');
>   const hasPinPermission = hasRolePin || isSpaceOwner;
>   const hasDeletePermission = hasRoleDelete || isSpaceOwner;
>   ```
>   The variable naming (`hasRolePin`, `hasRoleDelete`) shows the caller knows the hook only covers role-derived permissions. Bug is masked.
> - **`useUserPermissions`** — exported from [`hooks/chat/index.ts`](../../hooks/chat/index.ts), but **zero downstream callers**. Bug can't trigger.
> - **`useUserRoles`** — exported, but **zero downstream callers**. Bug can't trigger.
>
> **Implications for prioritisation:**
> - The ~60 LOC removal (pure cleanup) is the real value of this task.
> - The "correctness fix" is defence-in-depth against a future caller forgetting to OR in `isSpaceOwner` — real value, but no production bug exists today.
> - Runtime test cost stays the same (permission UI gates real actions; can't skip).
> - This task is **not** the urgent one in the queue. Channel-reorder broadcast (cross-device sync bug) and bio-length convergence (missing XSS check) outrank it on user-visible impact.

## What

Mobile's `hooks/chat/useRoleManagement.ts` defines three React hook wrappers — `useHasPermission`,
`useUserPermissions`, `useUserRoles` — that re-implement logic already available as pure
functions in `@quilibrium/quorum-shared`.

This task: refactor mobile's three hooks to be thin wrappers over the shared pure functions.
Net: ~60 LOC removed from mobile + correctness improvement (mobile currently ignores
`isSpaceOwner`, so owners' permissions are silently dropped).

## What's already in shared

`quorum-shared/src/utils/permissions.ts` (re-exported from package root):

```ts
export function hasPermission(
  userAddress: string,
  permission: Permission,
  space: Space | undefined,
  isSpaceOwner: boolean = false,
): boolean;

export function getUserPermissions(
  userAddress: string,
  space: Space | undefined,
  isSpaceOwner: boolean = false,
): Permission[];

export function getUserRoles(
  userAddress: string,
  space: Space | undefined,
): Role[];
```

All three handle the same logic mobile's hooks reimplement (`role.members.includes(userAddress) && role.permissions.includes(permission)`), plus the `isSpaceOwner` short-circuit mobile is missing.

## Mobile's current implementation (origin/master)

`hooks/chat/useRoleManagement.ts:56-115` (approximate). Each hook takes `(spaceId, userAddress, ...)` and uses `useRoles(spaceId)` internally to fetch the roles array reactively. Then inlines the logic.

Critical correctness gap: none of the three hooks accept or check an `isSpaceOwner` parameter. Space owners' permissions are silently returned as `false` / `[]` even when shared's logic would correctly return `true` / full set.

## Shape of change

The rewire is NOT a 1-line import swap — it's a composition refactor. Mobile's hooks need to:

1. Keep their existing signature (consumers depend on `useHasPermission(spaceId, userAddress, permission)`).
2. Fetch via `useRoles(spaceId)` as before.
3. Build a minimal `Space`-shaped object (just `{ roles }` is enough — shared's functions only read `space.roles`).
4. Determine `isSpaceOwner` from somewhere (this is the new piece — see notes below).
5. Call into shared's pure function.

### Per-hook skeleton

```ts
// hooks/chat/useRoleManagement.ts

import {
  hasPermission as hasPermissionShared,
  getUserPermissions as getUserPermissionsShared,
  getUserRoles as getUserRolesShared,
} from '@quilibrium/quorum-shared';

// Helper for the isSpaceOwner check (extracted once if all three use it)
function useIsSpaceOwner(spaceId: string | undefined, userAddress: string | undefined): boolean {
  // Source the truth here. Existing space query? Owner address comparison? Pick whatever
  // mobile's other code already uses — DO NOT invent a new pattern.
  // ...
}

export function useHasPermission(
  spaceId: string | undefined,
  userAddress: string | undefined,
  permission: Permission,
): boolean {
  const { data: roles } = useRoles(spaceId);
  const isOwner = useIsSpaceOwner(spaceId, userAddress);
  if (!userAddress) return false;
  return hasPermissionShared(userAddress, permission, roles ? { roles } as any : undefined, isOwner);
}

export function useUserPermissions(
  spaceId: string | undefined,
  userAddress: string | undefined,
): Permission[] {
  const { data: roles } = useRoles(spaceId);
  const isOwner = useIsSpaceOwner(spaceId, userAddress);
  if (!userAddress) return [];
  return getUserPermissionsShared(userAddress, roles ? { roles } as any : undefined, isOwner);
}

export function useUserRoles(
  spaceId: string | undefined,
  userAddress: string | undefined,
): Role[] {
  const { data: roles } = useRoles(spaceId);
  if (!userAddress) return [];
  return getUserRolesShared(userAddress, roles ? { roles } as any : undefined);
}
```

Note on `{ roles } as any`: shared's signature wants `Space | undefined`. Mobile only has `Role[]`. The two options are: (a) cast a `{ roles }` partial as `Space` (works because shared only reads `roles`); (b) update shared's signature to accept `{ roles: Role[] } | undefined` more loosely. The cast is fine for this task; the signature loosening could be a follow-up if it bothers anyone.

### The `isSpaceOwner` piece (the real work)

Currently no mobile hook in `useRoleManagement.ts` checks ownership. Search mobile for how owner status is determined elsewhere:

```bash
git grep -i "isSpaceOwner\|space.owner\|ownerAddress" origin/master -- "*.ts" "*.tsx"
```

Likely it's: compare `space.ownerAddress` (from `useSpace(spaceId)` query) to the current user's address. If that pattern exists elsewhere, lift it into a small `useIsSpaceOwner` helper. If not, just inline it for these three hooks.

## Static-analysis verification gates

- [ ] `yarn tsc --noEmit` passes
- [ ] `yarn lint` passes
- [ ] `grep -rn "role.members.includes" hooks/` returns zero results (confirms inline reimplementations all removed)
- [ ] `grep -rn "useHasPermission\|useUserPermissions\|useUserRoles" .` shows consumers still pass the same params

## Runtime test requirements

**Required.** Permission checks gate critical UI: kick buttons, edit-message affordances, channel-management actions, role-edit screens. The `isSpaceOwner` correctness fix changes BEHAVIOR — owners who previously saw `false` for permissions will now see `true`. That's the intended fix, but it must be smoke-tested:

1. Open a space you OWN. Verify owner-only actions appear (kick others, edit channels, manage roles). Pre-refactor this was likely working via other code paths; verify the refactor doesn't break it.
2. Open a space you do NOT own but where you have a role with specific permissions. Verify those permissions show as available, non-permitted actions stay gated.
3. Open a space with no role membership at all. Verify all permission-gated actions are correctly hidden.
4. Switch identities mid-session if possible. Verify the hooks update.

## Pre-filled mobile PR description

```markdown
## What
Refactor `useHasPermission`, `useUserPermissions`, `useUserRoles` to delegate to shared's pure
functions (`hasPermission`, `getUserPermissions`, `getUserRoles`). Removes ~60 LOC of duplicated
logic and adds the `isSpaceOwner` short-circuit mobile was missing.

## Cross-repo migration
- **quorum-shared**: ✅ already exports `hasPermission`/`getUserPermissions`/`getUserRoles` (no change needed)
- **quorum-desktop**: not affected (desktop already uses these helpers directly)
- **quorum-mobile**: THIS PR

## Why
Mobile reimplements logic already available in shared. The reimplementation is missing the
`isSpaceOwner` short-circuit, so owners' permissions are silently returned as false. This PR
collapses the duplication and picks up the correctness fix.

## Behavior change (intentional)
Space OWNERS will now see their owner-derived permissions (`message:delete`, `message:pin`,
`mention:everyone`) returned from `useUserPermissions` and `useHasPermission`. This is a fix —
the current behavior incorrectly returned empty/false for owners unless they were also explicitly
assigned a role with the permission.

## Verification
- [ ] `yarn tsc --noEmit` passes
- [ ] `yarn lint` passes
- [ ] `grep -rn "role.members.includes" hooks/` returns zero results
- [ ] Manual QA: owner sees owner permissions; non-owner with role sees role permissions; non-member sees nothing
```

## Notes for the executor

- This task is INDEPENDENT of the `toggleRolePermission` / `setRolePermissions` extraction task
  ([`2026-05-29-mobile-adopt-shared-role-mutation-helpers.md`](2026-05-29-mobile-adopt-shared-role-mutation-helpers.md)) — that one will be queued separately after the desktop-side extraction merges. You can ship this read-side rewire independently.
- The shared package version that already has these functions is whatever mobile currently has installed. Verify in `package.json`. No version bump strictly required for this task.
