---
type: task
title: "Mobile rewire: invite helpers to shared exports"
status: in-progress
status-updated: 2026-06-09
status-reason: awaiting lead-dev call on whether staging/localhost mobile builds are in scope
created: 2026-05-29
triggered-by:
  finding: 2026-05-29 Phase 2 verification (desktop's quorum-shared-migration)
  desktop-task-file: ../quorum-desktop\.agents\tasks\quorum-shared-migration\shipped-log.md (Phase 2 verification entry)
runtime-test: required
priority: high
---

# Mobile rewire: invite helpers → shared exports

> **🚧 Status: blocked on lead-dev call (2026-06-09).** The only behaviour-changing piece of this task is env-aware domain detection — `getInviteUrlBase()` would stop hardcoding `app.quorummessenger.com` and start matching the build target (staging/localhost). If those build targets aren't supported on mobile (a reasonable product call for an app-store-shipped app), the "correctness fix" framing collapses and what's left is ~80 LOC of pure cleanup plus call-site adjustments for shared's wider `parseInviteParams` return shape — not enough to justify the runtime-test cycle on its own.
>
> **Decision needed**: does mobile support staging/localhost build targets that would benefit from env-aware invite-link generation?
> - If **yes** → unblock and ship as originally scoped.
> - If **no** → close as won't-do; the cleanup half isn't worth pursuing independently.
>
> Tracked desktop-side in [`mobile-tasks-pending.md`](../../../../quorum-desktop/.agents/issues/quorum-shared-migration/mobile-tasks-pending.md).

## What

Mobile reimplements `getInviteUrlBase`, `VALID_INVITE_PREFIXES`, and `parseInviteLink` locally in two
files, instead of consuming the existing exports from `@quilibrium/quorum-shared`. This task:
delete the local copies, import the shared versions, adjust call sites for shared's stricter API.

Net: ~80 LOC removed across 2 mobile files + a **real correctness fix** (mobile's local
`getInviteUrlBase` hardcodes `app.quorummessenger.com`, so invite links generated in staging
or localhost builds always point at production).

## What's already in shared

`quorum-shared/src/utils/inviteDomain.ts` (re-exported from package root):

```ts
export function getInviteBaseDomain(): string;        // env-aware: prod/staging/localhost
export function getInviteUrlBase(isPublicInvite: boolean): string;
export function getValidInvitePrefixes(): string[];   // env-aware: returns more prefixes
export function parseInviteParams(inviteLink: string):
  | { spaceId?, configKey?, template?, secret?, hubKey? }
  | null;
```

All four already used by desktop. Mobile has its own local copies that:
- Hardcode the production domain (no staging/localhost detection).
- Lag the shared `VALID_INVITE_PREFIXES` list (mobile's array has 9 entries; shared computes more dynamically).
- Reimplement the parse logic.

## Concrete mobile files

### File 1: `services/space/inviteService.ts`

Three changes:

**Change 1a**: delete local `getInviteUrlBase()` (lines ~68-72), import from shared:

```ts
import { getInviteUrlBase } from '@quilibrium/quorum-shared';
```

**Change 1b**: delete local `VALID_INVITE_PREFIXES` constant (lines ~26-36), use the shared function:

```ts
import { getValidInvitePrefixes } from '@quilibrium/quorum-shared';
// at call site:
const validPrefixes = getValidInvitePrefixes();
```

**Change 1c**: delete local `parseInviteLink()` (lines ~157-189), use shared's `parseInviteParams`:

```ts
import { parseInviteParams } from '@quilibrium/quorum-shared';
// at call site (preserving the existing strict spaceId+configKey requirement):
const params = parseInviteParams(inviteLink);
if (!params?.spaceId || !params.configKey) {
  return null;
}
const inviteInfo = { spaceId: params.spaceId, configKey: params.configKey, ...rest };
```

Same shape desktop's `useInviteValidation` adopted in commit `17e19b70` (2026-05-29 morning).

### File 2: `hooks/chat/useSpaceActions.ts`

Two changes:

**Change 2a**: delete local `VALID_INVITE_PREFIXES` (lines ~26-36), use `getValidInvitePrefixes()` from shared.
**Change 2b**: delete local `parseInviteLink()` (lines ~90-128), use `parseInviteParams()` from shared (same call-site adjustment as Change 1c).

## Shape of change summary

- 2 files modified
- 4 local declarations deleted (~80 LOC)
- 3-4 shared imports added
- Call sites adjusted to handle shared's `parseInviteParams` returning `{spaceId?, configKey?, ...} | null` vs mobile's local `{spaceId, configKey} | null` shape

## Correctness fix (intentional behavior change)

Mobile's local `getInviteUrlBase()` hardcodes `https://app.quorummessenger.com/` regardless of build target. After this rewire, staging and localhost mobile builds will generate invite links that match the build's actual domain. Confirm during runtime testing that:

- A prod-targeted mobile build still produces `https://app.quorummessenger.com/...` invite links.
- A staging build (if such a thing exists) produces staging-domain links.
- A localhost dev build produces localhost links.

If staging/localhost mobile builds didn't exist before, this change adds the capability without breaking the existing prod path.

## Static-analysis verification gates

- [ ] `yarn tsc --noEmit` passes
- [ ] `yarn lint` passes
- [ ] `grep -rn "VALID_INVITE_PREFIXES" .` returns ONLY occurrences in `@quilibrium/quorum-shared` (zero local copies in mobile source)
- [ ] `grep -rn "function parseInviteLink" .` returns zero results in mobile source
- [ ] `grep -rn "function getInviteUrlBase" .` returns zero results in mobile source

## Runtime test requirements

**Required.** Three flows depend on these helpers:

1. **Generate invite link**: from a space settings screen, generate a private invite link. Verify the link starts with the expected domain (prod / staging / localhost matching the build).
2. **Parse incoming invite link**: paste an invite link into the "join space" flow. Verify the spaceId + configKey are correctly extracted and the join proceeds.
3. **Public invite link** (if mobile supports them): same as #1 but with the `/invite/` path. Verify the prefix is correct.

Edge case: paste a malformed invite link (missing `#`, missing required params). Verify the failure mode is graceful (no crash) and matches the pre-refactor behavior.

## Pre-filled mobile PR description

```markdown
## What
Replace mobile's three local invite-helper implementations with the existing
exports from `@quilibrium/quorum-shared`: `getInviteUrlBase`, `getValidInvitePrefixes`,
`parseInviteParams`. Affects `services/space/inviteService.ts` and `hooks/chat/useSpaceActions.ts`.

## Cross-repo migration
- **quorum-shared**: ✅ already exports all three (no change needed)
- **quorum-desktop**: ✅ already uses all three
- **quorum-mobile**: THIS PR

## Why
Mobile had its own copies of these helpers. The local `getInviteUrlBase()` hardcoded
`app.quorummessenger.com`, breaking invite-link generation in staging/localhost builds.
The `VALID_INVITE_PREFIXES` array lagged shared's authoritative list. The `parseInviteLink`
was a verbatim reimplementation of `parseInviteParams`.

Replacing all three: removes ~80 LOC, picks up env-aware domain handling, aligns with
desktop and shared.

## Behavior change (intentional)
Invite links generated in staging / localhost mobile builds will now match the build's
actual domain instead of always pointing at production. Prod-targeted builds are unaffected.

## Verification
- [ ] `yarn tsc --noEmit` passes
- [ ] `yarn lint` passes
- [ ] Manual QA: generate + parse invite link in prod and (if available) staging build
```

## Notes for the executor

- This task is INDEPENDENT of the other two queued mobile tasks (`useTwoStepConfirm`
  adoption, permission helpers rewire). Can ship in any order.
- Bump `@quilibrium/quorum-shared` to the current published version in `package.json`
  if older than whatever already has these exports. Verify before assuming.
- The compatibility nuance: shared's `parseInviteParams` returns a wider type
  `{spaceId?, configKey?, template?, secret?, hubKey?} | null` than mobile's local
  `{spaceId, configKey} | null`. Call sites that expect both fields defined must
  add a null-guard + field check (see Change 1c above).
