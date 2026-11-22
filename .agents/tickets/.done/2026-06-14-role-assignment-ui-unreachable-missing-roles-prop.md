---
type: task
title: "Role-assignment UI is built but unreachable (UserProfileModal missing `roles` prop)"
status: done
created: 2026-06-14
urgency: Tier 2 — a complete, working feature is dark because of a one-line wiring gap; blocks the whole role workflow from being usable on a phone
shared_change: none
version_bump: none
runtime_test: required
source-investigation: 2026-06-14 trace of the full mobile role/permission chain (Q "do roles work on mobile + can we assign them + do options show in the drawer")
related:
  - 2026-06-12-permission-enforcement-wave-0.md (enforcement side — separate from this assignment-UI gap)
  - 2026-06-12-owner-permission-bypass-cross-repo-fix.md (the isSpaceOwner bypass + 2.1.0-30 publish)
---

# Role-assignment UI is built but unreachable on mobile

## TL;DR

Mobile's role system is essentially complete end-to-end — **define → check → gate the message drawer → enforce on receive all work** — with ONE practical hole that makes the whole workflow unusable on a phone:

**You cannot assign a role to a user from the UI today.** The assignment UI is fully implemented in `UserProfileModal`, but the only screen that opens it (the channel screen, via tapping a user's avatar/name on a message) **does not pass the `roles` prop**, and the modal gates the entire roles section on `roles && roles.length > 0`. So the section never renders. The `SpaceSettingsModal` Members tab — desktop's *second* entry point — has no assign/remove controls at all (only Kick).

Net: a role can be created, it correctly gates pin/delete in the long-press drawer and is enforced on receipt — but there is no way to actually put a member into that role from the app.

## What WORKS today (verified 2026-06-14, do not re-investigate)

- **Permissions defined:** `components/SpaceSettingsModal.tsx:118-123` — `mention:everyone`, `message:pin`, `user:mute`, `message:delete`.
- **Checking hook:** `hooks/chat/useRoleManagement.ts:57-74` `useHasPermission` (also `useUserPermissions`, `useUserRoles`).
- **Drawer gating (Q3):** `app/(tabs)/spaces/[id]/[channelId].tsx:56-59` computes `hasPinPermission`/`hasDeletePermission` (= `hasRole* || isSpaceOwner`) → `SpaceChatArea` → `MessageActionSheet`. Pin shows iff `canPin`; Delete shows iff `canDelete` (own message OR `hasDeletePermission`). `SpaceChatArea.tsx:567-571` is `canDeleteMessage`. **This gating is correct.**
- **Assign/remove mutations:** `useAssignRole` / `useRemoveFromRole` (`hooks/chat/useRoleManagement.ts:291-339`, `345-390`) — implemented, persist to MMKV, broadcast the space manifest. They work.
- **Role CRUD** (create/edit/delete role, toggle permissions): complete in `SpaceSettingsModal` and matches desktop.

## The gap (Q2) — the actual bug

`components/UserProfileModal.tsx` has the full assignment UI:
- Lines 63-64: `useAssignRole()` / `useRemoveFromRole()`.
- Line 142: `const showRolesSection = roles && roles.length > 0 && (userRoles.length > 0 || isSpaceOwner)` ← gated on the `roles` prop being non-empty.
- Lines 198-219: current roles as removable badges (owner only).
- Lines 222-243: available roles as `+ @roleTag` assign buttons (owner only).

But the **caller does not pass `roles`** — `app/(tabs)/spaces/[id]/[channelId].tsx:275-291`:
```tsx
<UserProfileModal
  visible
  onClose={() => setSelectedUserProfile(null)}
  user={selectedUserProfile}
  spaceId={spaceId}
  isSpaceOwner={isSpaceOwner}
  onOpenFarcasterProfile={...}
/>
```
No `roles={...}`. With `roles` undefined, `showRolesSection` is falsy → the assignment UI never renders. The avatar-tap flow is the ONLY way to reach `UserProfileModal`.

Second gap: `SpaceSettingsModal.tsx` `renderMembersTab()` (~1719-1807) shows each member's roles **display-only** + a Kick button (`isSpaceOwner`). No `+role` / `×role` controls. Desktop offers role management from the members list too; mobile does not.

## Why it's not just "pass the prop and done" — verify first

Before wiring, confirm the data source and the owner-gate interaction:
1. **Where do `roles` come from on the channel screen?** `useRoles(spaceId)` is already used at `[channelId].tsx:56-59` (the permission hooks consume it). Confirm a `roles` array is in scope (or add `const { data: roles } = useRoles(spaceId)`), then pass `roles={roles}` to `UserProfileModal`.
2. **Owner-gate caveat (cross-link).** The assign/remove buttons are gated on `isSpaceOwner` inside `UserProfileModal`. `isSpaceOwner` is only ever true on the owner's OWN device (`!!getSpaceKey(spaceId, 'owner')`). That's correct for *assignment* (only the owner should hand out roles), unlike the pin/delete *bypass* which is the documented bug tracked in `2026-06-12-owner-permission-bypass-cross-repo-fix.md`. Don't conflate the two: assignment SHOULD be owner-gated; pin/delete should NOT be owner-bypassed. This task does not touch the bypass.
3. **Does assignment actually propagate cross-platform?** `useAssignRole` broadcasts the space manifest (whole-object LWW — see `mobile-space-manifest-whole-object-lww-clobber`). Confirm a role assigned on mobile shows up on desktop (and survives the staleness guard). Runtime-test both directions.

## Approach

1. On `[channelId].tsx`, ensure `roles` from `useRoles(spaceId)` is in scope and pass `roles={roles}` to `UserProfileModal` (line ~275-291). Smallest fix — makes the existing UI reachable.
2. Runtime-test: as space owner, tap a member's avatar on a message → the roles section appears → assign a role → that member now has it → the role's permission (e.g. `message:pin`) now shows in their long-press drawer.
3. (Optional, larger — separate PR) Add assign/remove controls to the `SpaceSettingsModal` Members tab for parity with desktop's second entry point.

## Acceptance criteria

- [ ] Tapping a user's avatar/name on a space message, as the space owner, shows the roles section in `UserProfileModal`.
- [ ] Owner can assign an existing role to a member and remove it.
- [ ] A non-owner does NOT see assign/remove controls (display-only).
- [ ] After assigning a `message:pin` / `message:delete` role, that user's long-press drawer shows Pin / Delete (verifies the end-to-end loop).
- [ ] The assignment broadcasts and is reflected on desktop (cross-platform), surviving the inbound staleness guard.
- [ ] `tsc` + `lint` clean.

## Notes

- This is a **wiring gap, not missing logic** — the mutations, the UI, the permission checks, and the drawer gating all already exist and are correct. One missing prop dark-fires the whole assignment workflow.
- Scope boundary: this is the **assignment** half of roles. The **enforcement** half (owner-bypass removal, `@everyone` receive-check) lives in `2026-06-12-owner-permission-bypass-cross-repo-fix.md` and is blocked on the `2.1.0-30` shared publish. This task is independent of that publish.

## Resolution (2026-06-15)

The wiring fix is in place on `[channelId].tsx`:
- `const { data: roles } = useRoles(spaceId)` is in scope (line ~68).
- `roles={roles}` is passed to `<UserProfileModal>` (line ~289).

This makes the existing assignment UI in `UserProfileModal` reachable, as the task required. The owner-gate, mutations, drawer gating, and CRUD were already correct (see "What WORKS today"). The optional Phase 3 (assign/remove controls on the `SpaceSettingsModal` Members tab) was explicitly scoped as a separate, larger PR and is not part of this task.

---
*Created: 2026-06-14*
*Last updated: 2026-06-15*
