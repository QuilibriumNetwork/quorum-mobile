---
type: task
title: "Adopt shared field validators (drop local validateSpaceName)"
status: in-progress
shipped: 2026-06-14
mobile-pr: https://github.com/QuilibriumNetwork/quorum-mobile/pull/86
complexity: low
created: 2026-06-14
runtime-test: required
related_prs:
  - quorum-shared: https://github.com/QuilibriumNetwork/quorum-shared/pull/20 (MERGED 2026-05-28)
  - quorum-desktop: https://github.com/QuilibriumNetwork/quorum-desktop/pull/162 (MERGED 2026-05-28)
related_docs:
  - ../quorum-desktop\.agents\tasks\quorum-shared-migration\.done\2026-05-28-migrate-validation-hooks.md
  - ../quorum-desktop\.agents\tasks\quorum-shared-migration\2026-05-28-cross-repo-workflow.md
---

> **✅ SHIPPED 2026-06-14 — [quorum-mobile PR #86](https://github.com/QuilibriumNetwork/quorum-mobile/pull/86), squash-merged to master (`4905c66`).**
> Dropped the local `validateSpaceName` + inline length constants from `SpaceModal.tsx` and
> `SpaceSettingsModal.tsx`; routed space name + description through shared `validateSpaceName` /
> `validateSpaceDescription`. Added `hooks/validation/errorTranslator.ts` mapping shared errorKeys
> → mobile English strings. Min/max rules unchanged (name 2/50, description 300); the only new
> behaviour is the shared HTML-tag (XSS) guard on both fields (matches desktop). **Runtime-tested
> on the physical phone** (create + edit space forms): required/min/max errors render as before,
> `<script` rejected, valid names save. Confirmed the XSS rule is a targeted `<`+[letter/`/`/`!`/`?`]
> tag-opener check, so `<3` / `<\` / `<|` are intentionally allowed (not a bug). Static gates passed
> (tsc 82==82, lint: new file clean, two modals identical to master). Moved to `.done/`.

# Adopt shared field validators (drop local `validateSpaceName`)

> **Dropped by the 2026-05-28 desktop session.** The validation hooks migration on desktop moved the validators to shared (`@quilibrium/quorum-shared` 2.1.0-19). Mobile has its own duplicate `validateSpaceName` + inline length checks that should consume the shared API instead.
>
> **Why deferred to a future session:** touches runtime code (form validation in user-facing modals). Requires running the mobile app to verify the create-space + space-settings flows still work end-to-end. Per the workflow's mobile-testing constraint, we don't run mobile in normal migration sessions.

## What shipped on shared + desktop

**Shared (`@quilibrium/quorum-shared@2.1.0-19`)** added a new `validation` module:

```ts
import {
  // Single-result validators
  validateSpaceName,
  validateDisplayName,
  validateChannelName,
  validateChannelTopic,
  validateGroupName,
  validateDeviceName,
  // Multi-result validators (return arrays)
  validateSpaceDescription,
  validateUserBio,
  validateUserNote,
  // Result types
  type FieldValidationResult,
  isValidField,
  // Constants
  MAX_BIO_LENGTH,        // 160
  MAX_USER_NOTE_LENGTH,  // 256
  DEVICE_NAME_PATTERN,
} from '@quilibrium/quorum-shared';

// Also exposed (already present, value bumped):
import { MAX_NAME_LENGTH, MIN_NAME_LENGTH, MAX_TOPIC_LENGTH } from '@quilibrium/quorum-shared';
// MAX_NAME_LENGTH bumped 40 → 50 (aligned to mobile's previous value)
// MIN_NAME_LENGTH = 2 (new constant, matches mobile's existing inline value)
```

**Return shape** (the `errorKey` pattern — see workflow doc section "i18n in shared"):

```ts
type FieldValidationOk = { ok: true };
type FieldValidationErr = {
  ok: false;
  errorKey: string;                              // e.g. 'spaceName.required'
  errorVars?: Record<string, string | number>;   // e.g. { min: 2 } or { max: 50 }
};
```

**Desktop wrapper pattern** (proven in PR — to be linked when opened):

Desktop wraps each shared validator with a `errorKey → Lingui string` lookup in `src/hooks/business/validation/errorTranslator.ts`. The hooks (`useSpaceNameValidation` etc.) keep their public surface (`{ error, isValid }`) and just delegate.

## Concrete mobile file list

Grep verified against `origin/master` on 2026-05-28:

```bash
cd <repo root>/
git grep -lnE "validateSpaceName|MIN_NAME_LENGTH|MAX_NAME_LENGTH|MAX_DESCRIPTION_LENGTH" origin/master -- "components/**" "hooks/**"
# Returns:
#   components/SpaceModal.tsx
#   components/SpaceSettingsModal.tsx
```

### `components/SpaceModal.tsx` (lines 38-50, ~135)

Has the local `validateSpaceName(name)` function + inline `MIN_NAME_LENGTH`, `MAX_NAME_LENGTH`, `MAX_DESCRIPTION_LENGTH` constants. The `nameError` block at line ~135 calls the local validator.

### `components/SpaceSettingsModal.tsx` (lines ~630-650)

Inline `nameError` and `descriptionError` `useMemo` blocks referencing `MIN_NAME_LENGTH`, `MAX_NAME_LENGTH`, `MAX_DESCRIPTION_LENGTH`. Same hardcoded English error strings.

## Shape of the mobile change

### Step 1: Add a thin translation wrapper

Create `hooks/validation/errorTranslator.ts` (or place wherever mobile organizes UI helpers — match the existing convention):

```ts
import type { FieldValidationResult } from '@quilibrium/quorum-shared';

type Vars = Record<string, string | number> | undefined;

const messages: Record<string, (vars: Vars) => string> = {
  'spaceName.required': () => 'Space name is required',
  'spaceName.tooShort': (vars) => `Name must be at least ${vars!.min} characters`,
  'spaceName.tooLong': (vars) => `Name must be ${vars!.max} characters or less`,
  'spaceName.invalidChars': () => 'Space name cannot contain special characters',

  'spaceDescription.invalidChars': () => 'Description cannot contain special characters',
  'spaceDescription.tooLong': (vars) => `Description must be ${vars!.max} characters or less`,

  // Add more entries when mobile wires up display/channel/group/device validators.
  // For now, just space name + description match mobile's existing surfaces.
};

export function translateValidationResult(
  result: FieldValidationResult
): string | undefined {
  if (result.ok) return undefined;
  return messages[result.errorKey]?.(result.errorVars) ?? result.errorKey;
}

export function translateValidationResults(
  results: FieldValidationResult[]
): string[] {
  return results
    .map(translateValidationResult)
    .filter((s): s is string => s !== undefined);
}
```

> **When mobile adopts Lingui later** (separate effort): only this file changes. The `messages` map becomes Lingui macro calls. Everything below stays untouched.

### Step 2: Replace `components/SpaceModal.tsx` validation

Delete the local constants and `validateSpaceName` function (lines 38-50). Replace with:

```ts
import { validateSpaceName as validateSpaceNameShared, MAX_NAME_LENGTH } from '@quilibrium/quorum-shared';
import { translateValidationResult } from '@/hooks/validation/errorTranslator';

// Keep this constant local — mobile-specific UI affordance for the description textarea
const MAX_DESCRIPTION_LENGTH = 300;

// Inline at the existing nameError computation (line ~135):
const nameError = translateValidationResult(validateSpaceNameShared(spaceName)) ?? null;
```

### Step 3: Replace `components/SpaceSettingsModal.tsx` validation

Delete the local `MIN_NAME_LENGTH` / `MAX_NAME_LENGTH` constants (~line 94). Import from shared. Replace the `nameError` `useMemo` (line ~633) with the shared validator + translator. Same for `descriptionError` using `validateSpaceDescription`.

### Step 4: Bump shared dep + install

```bash
cd <repo root>/
# Edit package.json: "@quilibrium/quorum-shared": "^2.1.0-19"
yarn install
```

## Static-analysis verification gates (run all)

```bash
cd <repo root>/

# 1. TS check — must pass clean
npx tsc --noEmit

# 2. Grep confirms zero residual references to the deleted symbols
git grep -nE "function validateSpaceName" components/
# Expected: zero results (we deleted the local function)

git grep -nE "const MIN_NAME_LENGTH|const MAX_NAME_LENGTH" components/
# Expected: zero results (we deleted the local constants, importing from shared instead)
```

## Runtime test requirements

**`runtime-test: required` — needs Expo dev build session.** The validation runs in user-facing forms:

1. **Create Space flow** (`SpaceModal.tsx`):
   - Open modal, switch to Create tab
   - Empty name → error appears
   - 1-char name → "Name must be at least 2 characters" appears
   - 51-char name → "Name must be 50 characters or less" appears (was 50 before — no behavioural change, just sourced from shared)
   - `<script>` → "Space name cannot contain special characters" appears (NEW — mobile didn't have XSS check before)
   - Valid name → no error, can submit

2. **Edit Space flow** (`SpaceSettingsModal.tsx`):
   - Same name validations on the General tab
   - Description over 300 chars → error appears

## Pre-filled mobile PR description (copy/paste when opening)

```markdown
## What
Adopt the new shared field validators from `@quilibrium/quorum-shared@2.1.0-19`. Delete mobile's local `validateSpaceName` + inline length/XSS checks in `SpaceModal.tsx` and `SpaceSettingsModal.tsx`; route through the shared validator + a thin mobile English-string translator.

## Cross-repo migration

This is part of a 3-repo change, both upstream legs already shipped:
- **quorum-shared**: ✅ MERGED — QuilibriumNetwork/quorum-shared#20 (version 2.1.0-19, available on npm)
- **quorum-desktop**: ✅ MERGED — QuilibriumNetwork/quorum-desktop#162
- **quorum-mobile** (this PR): adopt the shared validators

## Why

Mobile previously had a comment "matches desktop" on its inline `validateSpaceName` — explicit intent to converge. This PR delivers that convergence using the new errorKey pattern (see [the workflow doc](../../tasks/quorum-shared-migration/2026-05-28-cross-repo-workflow.md) section "i18n in shared"). Net behavioural changes for mobile:
- Adds XSS check on space name input (defense-in-depth — mobile had `validateNameForXSS` available but wasn't using it)
- Otherwise behaviourally identical (min 2, max 50 are mobile's existing values, now sourced from shared instead of local)

## Why this is safe to merge whenever

Mobile is on shared `^2.1.0` and continues to work. This PR bumps to `^2.1.0-19` and adapts. No production users affected by merge timing.

## Verification

- [ ] `npx tsc --noEmit` passes
- [ ] Grep confirms zero `function validateSpaceName` in `components/`
- [ ] Grep confirms zero local `const MIN_NAME_LENGTH | const MAX_NAME_LENGTH` in `components/`
- [ ] Manual: create-space flow (empty, 1-char, 51-char, `<script>`, valid name)
- [ ] Manual: edit-space flow (same name validations + description-too-long)
```

## Done criteria

- [ ] Translation wrapper file added
- [ ] `SpaceModal.tsx` migrated
- [ ] `SpaceSettingsModal.tsx` migrated
- [ ] Shared dep bumped to `^2.1.0-19`
- [ ] All static-analysis gates pass
- [ ] All runtime test scenarios passed in Expo dev build
- [ ] PR opened with the description template above
- [ ] Move this file to `.done/` when the mobile PR opens

## PR link

- quorum-mobile: TBD
