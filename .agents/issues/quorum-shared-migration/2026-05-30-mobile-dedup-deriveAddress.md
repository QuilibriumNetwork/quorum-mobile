---
type: task
title: Dedupe deriveAddress — 5 local copies → 1 import from utils/deriveAddress
status: done
created: 2026-05-30
updated: 2026-08-09
shared-pr: none (mobile-internal cleanup)
desktop-pr: none
runtime-test: not-required
---

# Dedupe `deriveAddress` to a single import from `utils/deriveAddress`

## Status

**2026-08-09 — done.** All five local copies replaced with an import of the
canonical `deriveAddress` from `utils/deriveAddress.ts`. 51 lines removed, 5
added. `git grep "function deriveAddress"` now returns exactly one result.

Two things differ from what this file originally planned, both deliberate:

- **The canonical copy moved.** It is `utils/deriveAddress.ts`, not
  `services/onboarding/keyService.ts`. The old home pulls in mnemonic generation
  and the native Rust crypto module, which is the weight that caused these
  copies to be hand-rolled in the first place — importing it to turn a public
  key into an address meant loading a native module. `keyService` still
  re-exports it, so nothing that imported it from there broke.
- **The "runtime test not required" call was not taken at face value.** The
  algorithm is identical, so the reasoning held, but the failure mode if it had
  not is a DIFFERENT address — messages routed to an inbox nobody reads, roster
  rows that stop matching their members. Silent, and not something using the app
  would reveal. `__tests__/deriveAddress.test.ts` now pins the output against
  hard-coded expectations, so the derivation cannot drift unnoticed.

Verified: 710 tests pass, `tsc --noEmit` shows only the 11 pre-existing errors
in unrelated files, lint clean (remaining warnings in the touched files are
pre-existing unused error handlers).


## What

> **Corrected 2026-08-09 — this issue undercounted, and so did the code comment
> that pointed at it.** The canonical copy has since MOVED: it now lives in
> `utils/deriveAddress.ts` (still re-exported from `keyService` so no caller
> broke), because `keyService` drags in mnemonic generation and the native Rust
> module, which is the weight that caused these copies in the first place.
> A repo-wide `grep "function deriveAddress"` finds **five** local copies, not
> three. Recount before believing any list here.

Mobile has the canonical `deriveAddress(publicKey: Uint8Array | string)` exported from `utils/deriveAddress.ts`. Five other files re-declare the same logic locally as a private function:

1. `services/space/spaceService.ts:61` — `function deriveAddress(publicKeyBytes: Uint8Array)`
2. `hooks/chat/useChannelManagement.ts:37` — `function deriveAddress(publicKeyBytes: Uint8Array)`
3. `hooks/chat/useSpaceActions.ts:81` — `function deriveAddress(publicKeyBytes: Uint8Array)`
4. `services/config/spaceSyncService.ts:63` — `function deriveAddress(publicKeyBytes: Uint8Array)`
5. `services/crypto/space-session.ts:17` — `function deriveAddress(publicKeyBytes: Uint8Array)`

All five are byte-for-byte identical:
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
