---
type: task
title: Adopt shared toggleRolePermission and setRolePermissions in mobile useRoleManagement
status: in-progress
created: 2026-05-30
shipped: 2026-06-14
mobile-pr: https://github.com/QuilibriumNetwork/quorum-mobile/pull/85
shared-pr: https://github.com/QuilibriumNetwork/quorum-shared/pull/21
desktop-pr: https://github.com/QuilibriumNetwork/quorum-desktop/pull/163
shared-version: 2.1.0-21
runtime-test: not-required
---

> **✅ SHIPPED 2026-06-14 — [quorum-mobile PR #85](https://github.com/QuilibriumNetwork/quorum-mobile/pull/85), squash-merged to master (`8934bfc`).**
> Replaced the inline include/filter/spread block in `useToggleRolePermission.mutationFn` with the
> shared `toggleRolePermission` helper. Single call site; `useUpdateRole.mutationFn` left inline as
> scoped. No package bump needed (mobile was already on `2.1.0-29` ≥ the required `2.1.0-21`).
> Static gates all passed: `tsc` 82 errors before == 82 after (zero new), lint clean (one
> pre-existing `useAuth` unused warning), grep gate confirmed only the intentional read-helper
> `permissions.includes` remained. Behaviour-identical refactor, so `runtime-test: not-required`.
> Moved to `.done/` per the folder convention.

# Adopt shared role-mutation helpers in mobile `useRoleManagement`

## What shipped on shared + desktop

quorum-shared 2.1.0-21 exports two pure helpers (`src/utils/roleUtils.ts`):

```ts
export function toggleRolePermission(role: Role, permission: Permission): Role;
export function setRolePermissions(role: Role, permissions: Permission[]): Role;
```

Both are byte-for-byte equivalents of the include/filter/spread and spread-with-new-array patterns currently inlined in mobile.

Desktop (PR #163) refactored `useRoleManagement.ts` to import + use them. Mobile is the last inline holdout.

## Mobile files to touch

Single file: `hooks/chat/useRoleManagement.ts`

Two specific call sites:

### 1. `useToggleRolePermission.mutationFn` (around line 405-425)

Current:
```ts
const existingRole = space.roles[roleIndex];
const hasPermission = existingRole.permissions.includes(params.permission);

const updatedRole: Role = {
  ...existingRole,
  permissions: hasPermission
    ? existingRole.permissions.filter(p => p !== params.permission)
    : [...existingRole.permissions, params.permission],
};
```

Replace with:
```ts
const existingRole = space.roles[roleIndex];
const updatedRole = toggleRolePermission(existingRole, params.permission);
```

### 2. `useUpdateRole.mutationFn` (around line 190-210)

This call site does multi-field updates including `permissions: params.permissions ?? existingRole.permissions`. It is NOT a clean fit for `setRolePermissions` (which only touches `permissions`). **Leave this call site as-is.** The C4 extraction was scoped to the two pure-permissions cases; multi-field role updates stay inline. Mark this as out-of-scope in the PR description.

## Imports to add

```ts
import { toggleRolePermission } from '@quilibrium/quorum-shared';
```

## Package bump

In mobile's `package.json`:
- Bump `@quilibrium/quorum-shared` from current version to `^2.1.0-21` (or whatever the latest published is — check npm).
- Run `yarn install` to update lockfile.

## Verification gates (all static)

```bash
yarn tsc --noEmit
yarn lint
# Confirm zero residual inline copies:
grep -n "permissions.includes" hooks/chat/useRoleManagement.ts
# Should return one match in useUpdateRole.mutationFn only (intentionally out of scope).
# If it returns the useToggleRolePermission match too, the refactor is incomplete.
```

## Runtime test requirements

**Not required.** Pure mechanical refactor with byte-for-byte equivalent semantics. The new function returns the same Role shape from the same inputs. tsc + lint + grep are sufficient to verify completeness.

## Pre-filled PR description

```markdown
## What
Adopt the shared `toggleRolePermission` helper (from `@quilibrium/quorum-shared@2.1.0-21`) in `useToggleRolePermission.mutationFn`. Replaces the inline include/filter/spread block with the shared util.

## Cross-repo migration
- **quorum-shared**: ✅ MERGED — QuilibriumNetwork/quorum-shared#21 (2.1.0-21)
- **quorum-desktop**: ✅ MERGED — QuilibriumNetwork/quorum-desktop#163
- **quorum-mobile**: THIS PR

## Out of scope
`useUpdateRole.mutationFn` does multi-field updates with `permissions: params.permissions ?? existingRole.permissions` — not a clean fit for `setRolePermissions`. Leaving inline. Phase 2 extraction was scoped to the two pure-permissions cases only.

## Why this is safe to merge whenever
Pure mechanical refactor. The new helper returns the same Role shape from the same inputs. Mobile has been on the old shared version (2.1.0-OLD) and continues to work. No production users affected by merge timing.

## Verification
- [ ] `yarn tsc --noEmit` passes
- [ ] `yarn lint` passes
- [ ] `grep "permissions.includes" hooks/chat/useRoleManagement.ts` returns only the `useUpdateRole` match (intentional)
```

## Done criteria

- [ ] Mobile branch created + change applied
- [ ] tsc + lint + grep gates pass
- [ ] PR opened against `quorum-mobile` with the description above
- [ ] Row added to `mobile-tasks-pending.md`
- [ ] This file moved to `.done/` after PR is opened (not after merge — mobile PRs can sit weeks)
