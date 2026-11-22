---
type: task
title: "Cleanup: drop the now-dead isSpaceOwner param from shared permission helpers (+ optional mobile hook dedup)"
status: in-progress
priority: low
created: 2026-06-14
runtime-test: not-required (shared part) / required (optional mobile dedup part)
related:
  - shared PR #41 (fc73eb2) — removed the owner-permission bypass; left the param in place
  - desktop PR #203 (cee20774) — receive-side @everyone check
  - .archived/2026-05-29-mobile-adopt-shared-permission-helpers.md (superseded; the dedup idea is salvaged below)
---

# Cleanup: drop the dead `isSpaceOwner` param (cosmetic) + optional mobile hook dedup

Both items below are unblocked by shared PR #41 (the owner-bypass removal). Neither is urgent;
this is tidy-up, not a fix. Two independent parts — do either, both, or neither.

## Part A — quorum-shared: remove the now-ignored `isSpaceOwner` param (cosmetic)

After PR #41, `hasPermission` and `getUserPermissions` in `quorum-shared/src/utils/permissions.ts`
**ignore** their `isSpaceOwner` / `_isSpaceOwner` argument (kept only to avoid caller churn, with a
doc comment). It's now dead weight and slightly misleading (callers still pass a real owner value
that does nothing).

**The change:** drop the param from both signatures, then fix the call sites that pass it.

- `hasPermission(userAddress, permission, space, _isSpaceOwner = false)` → `hasPermission(userAddress, permission, space)`
- `getUserPermissions(userAddress, space, _isSpaceOwner = false)` → `getUserPermissions(userAddress, space)`

**Caller blast radius (verified 2026-06-14, all in quorum-desktop — mobile doesn't call shared `hasPermission`):**
- `Channel.tsx:1130` — `hasPermission(addr, 'mention:everyone', space, isSpaceOwner || false)` → drop the last arg.
- `MessageService.ts:4666` — `hasPermission(addr, 'mention:everyone', space, isSpaceOwner || false)` → drop the last arg.
- `useChannelMessages.ts:145` and `usePinnedMessages.ts:254` — already pass `false` → drop the last arg.
- `getUserPermissions` has zero callers across all three repos → trivially safe.
- Update `permissions.test.ts` calls that pass `true` as the 4th arg (they assert no-bypass; switch them to assert role-only without the param).

**Why it's safe:** the param is already ignored, so removing it changes no behavior — purely a
signature tidy. Statically verifiable (shared tsc + 277 tests + desktop tsc). Cross-repo: shared
first, then desktop (link: picks it up). No version bump unless desktop CI needs a published build.

**Why low priority:** it's cosmetic. The dead param is harmless; leaving it costs nothing but a
slightly confusing signature.

## Part B — quorum-mobile: optional dedup of the three permission hooks (now viable)

The archived task `2026-05-29-mobile-adopt-shared-permission-helpers.md` wanted to route mobile's
`useHasPermission` / `useUserPermissions` / `useUserRoles` (in `hooks/chat/useRoleManagement.ts`)
through shared's helpers. That task was WON'T-DO **because** it would have pulled in the owner-bypass.
**PR #41 removed the bypass**, so the dedup is now behaviorally safe — shared's `hasPermission` is
role-only, matching what the mobile hooks already do by hand.

**If pursued:** replace the ~60 LOC of inline role-walking in those three hooks with calls to shared
`hasPermission`/`getUserPermissions`/`getUserRoles`, passing `isSpaceOwner: false` (or, after Part A,
no owner arg at all). The mobile hooks' public signatures stay the same; call sites unchanged.

**Caveat:** it touches a real permission code path (pin/delete display gates), so `runtime-test:
required` — needs a mobile run to confirm gating is unchanged. This is the reason it's optional, not
automatic. Pure dedup, no behavior change intended.

**Recommendation:** Part A is a clean quick win whenever someone's in `permissions.ts`. Part B is
genuinely optional — only worth it if convergence-onto-shared is a goal for its own sake; the mobile
hooks already produce the correct result.

---
*Created: 2026-06-14 — split out of the archived owner-permission-helpers task after shared PR #41 removed the bypass that made the original task wrong. Part A = drop the dead param; Part B = the now-safe mobile hook dedup.*
