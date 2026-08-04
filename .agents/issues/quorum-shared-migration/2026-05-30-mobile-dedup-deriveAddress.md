---
type: task
title: Dedupe deriveAddress — 3 local copies → 1 import from keyService
status: in-progress
created: 2026-05-30
shared-pr: none (mobile-internal cleanup)
desktop-pr: none
runtime-test: not-required
---

# Dedupe `deriveAddress` to a single import from `keyService`

## What

Mobile has the canonical `deriveAddress(publicKey: Uint8Array | string)` exported from `services/onboarding/keyService.ts:105`. Three other files re-declare the same logic locally as a private function:

1. `services/space/spaceService.ts:61` — `function deriveAddress(publicKeyBytes: Uint8Array)`
2. `hooks/chat/useChannelManagement.ts:29` — `function deriveAddress(publicKeyBytes: Uint8Array)`
3. `hooks/chat/useSpaceActions.ts:81` — `function deriveAddress(publicKeyBytes: Uint8Array)`

All three are byte-for-byte identical:
```ts
const hash = sha256(publicKeyBytes);
const mhash = multihashes.encode(hash, 'sha2-256');
return bs58.encode(mhash);
```

The canonical `keyService.ts` version is a superset (accepts hex string OR Uint8Array). Replace the three local copies with `import { deriveAddress } from '@/services/onboarding/keyService'` (or whatever path alias the file uses).

## Why

Pure mobile-internal cleanup. Net ~15 LOC removed across 3 files. No shared change, no behavior change, no desktop coordination. Surfaced during the 2026-05-30 mobile bonus C1 sweep.

## Files to touch

For each of the 3 files:
1. Add the import from `keyService`.
2. Delete the local `function deriveAddress(...)` declaration.
3. Confirm call sites unchanged — the signature widening (now accepts `Uint8Array | string`) is backwards compatible with the existing `Uint8Array` call sites.

Also drop the now-unused `sha256` / `multihashes` / `bs58` imports if they were only used by the deleted function.

## Verification gates (all static)

```bash
yarn tsc --noEmit
yarn lint
# Confirm only one declaration remains:
git grep -n "function deriveAddress" -- "*.ts"
# Should return ONE result: services/onboarding/keyService.ts
```

## Runtime test requirements

**Not required.** Identical algorithm, canonical version is a strict superset. tsc + lint + grep are sufficient.

## Pre-filled PR description

```markdown
## What
Dedupe `deriveAddress` — replace 3 local copies (`spaceService`, `useChannelManagement`, `useSpaceActions`) with imports of the canonical export from `services/onboarding/keyService.ts`. Net ~15 LOC removed.

## Cross-repo migration
Pure mobile-internal cleanup. No shared / desktop changes.

## Why this is safe to merge whenever
Identical algorithm to the canonical version (which is a strict superset accepting hex strings too). No behavior change.

## Verification
- [ ] `yarn tsc --noEmit` passes
- [ ] `yarn lint` passes
- [ ] `git grep "function deriveAddress" -- "*.ts"` returns one result (keyService.ts)
```

## Done criteria

- [ ] 3 local copies removed
- [ ] tsc + lint + grep gates pass
- [ ] PR opened against `quorum-mobile`
- [ ] Row added to `mobile-tasks-pending.md`
- [ ] This file moved to `.done/` after PR opened
