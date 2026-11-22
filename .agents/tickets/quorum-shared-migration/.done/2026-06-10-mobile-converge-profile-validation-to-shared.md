---
type: task
title: "Converge mobile bio + display-name inputs to shared byte validators (Farcaster-aligned) + hard-block at publish boundary"
status: in-progress
status-reason: "byte validators (MAX_BIO_BYTES/MAX_DISPLAY_NAME_BYTES) not in published 2.1.0-29 dist; needs a shared publish ≥ the version containing PR #37, then a mobile bump"
status-updated: 2026-06-14
complexity: medium
created: 2026-06-10
runtime-test: required
supersedes:
  - 2026-06-08-mobile-converge-bio-length-to-shared.md
  - 2026-06-10-mobile-adopt-shared-display-name-validation.md
related_prs:
  - quorum-shared: "#37 (merged 2026-06-10 → 2.1.0-28) — byte-based bio + display-name validators matching Farcaster USER_DATA limits; adds .q dot rule; removes MAX_BIO_LENGTH"
  - quorum-desktop: "#189 (merged 2026-06-10) — desktop consumes the same byte validators"
related_docs:
  - ../quorum-desktop\.agents\tasks\port-from-mobile\2026-06-10-qns-username-display-design.md
  - ../quorum-shared\src\validation\userBio.ts
  - ../quorum-shared\src\validation\displayName.ts
---

# Converge mobile bio + display-name validation to shared byte validators

> ## ⛔ BLOCKED on a shared npm publish (verified 2026-06-14)
>
> **The byte-based validators this task needs are NOT in the published dist mobile installs.**
> Verified directly against `node_modules/@quilibrium/quorum-shared` at the pinned `2.1.0-29`:
> `MAX_BIO_BYTES` and `MAX_DISPLAY_NAME_BYTES` are **absent**, and `validateUserBio` there is still
> the OLD character-based form (`MAX_BIO_LENGTH = 160`). The byte validators live in shared's
> **source** (`2.1.0-30`, commit `d3b15ae` / PR #37) but were **never published to npm** — the same
> stale-dist wall blocking primaryUsername + DM-update-profile. This task **cannot start** until
> Cassie publishes a dist that actually contains the byte validators (≥ the version that includes
> PR #37) AND mobile bumps to it. The frontmatter says "since `2.1.0-28`" and "bump to `2.1.0-28`" —
> that refers to shared *source* tags, not what's on npm; don't trust the version number, verify the
> symbol is in the installed dist with a grep before starting.
>
> **The intent is confirmed correct (user, 2026-06-14):** bio + display name MUST be byte-based to
> match Farcaster (bio ≤ 256 bytes, display name ≤ 32 bytes), because Farcaster's `USER_DATA` limits
> are in bytes and a character cap lets through values the relay rejects. Shared source already does
> this; mobile does not yet (see the corrected current-state below).
>
> **Current mobile state re-verified 2026-06-14** (one correction to the table below): the
> `ProfileModal.tsx` display-name AND bio inputs have **no `maxLength` at all** (not just "trim-only")
> — the main edit path is completely unconstrained. The publish boundary
> (`services/farcaster/updateProfile.ts`) applies **zero** length/byte checks before PATCHing
> `/v2/me`. So step 4 (hard-block at the publish boundary) is the highest-value part of this task.
>
> **Grouping note:** this is now one of THREE mobile tasks gated on the same shared publish
> (primaryUsername end-to-end, DM-update-profile, this). When pinging Cassie, one correct publish
> unblocks all three — worth bundling the ask.

> **Consolidates two earlier tasks** (`2026-06-08-mobile-converge-bio-length-to-shared.md` and `2026-06-10-mobile-adopt-shared-display-name-validation.md`). They targeted the same editors and both became stale on 2026-06-10 when shared [#37](https://github.com/QuilibriumNetwork/quorum-shared/pull/37) made the bio + display-name validators **byte-based to match Farcaster**, removed `MAX_BIO_LENGTH`, and shipped the `.q` dot rule. This file is the corrected, merged task.

## Why bytes, not characters (the core change)

A Quorum profile can be **published to a merged Farcaster profile**: mobile's `UnifiedProfileEditModal` (scope `farcaster`/`both`) PATCHes `https://client.farcaster.xyz/v2/me` via `services/farcaster/updateProfile.ts`. Farcaster's `USER_DATA` fields are capped in **bytes**, not characters:

| Farcaster type | Limit |
|---|---|
| `USER_DATA_TYPE_DISPLAY` (display name) | **≤ 32 bytes** |
| `USER_DATA_TYPE_BIO` (bio) | **≤ 256 bytes** |

JS `.length` counts UTF-16 code units, not bytes: one emoji is up to 4 bytes, an accented `é` is 2. A character-based cap lets through values the Farcaster relay then **rejects on publish** with an opaque `HTTP 400`. Shared now counts UTF-8 bytes via a `byteLength()` helper.

## Shared source of truth (since `2.1.0-28`, 2026-06-10)

```ts
// @quilibrium/quorum-shared
export const MAX_DISPLAY_NAME_BYTES = 32;   // validation/displayName.ts
export const MAX_BIO_BYTES = 256;           // validation/userBio.ts
// MAX_BIO_LENGTH was REMOVED in 2.1.0-28 — do not import it.
export function validateDisplayName(name: string): FieldValidationResult { ... }  // 32-byte + .q/XSS/impersonation/reserved
export function validateUserBio(bio: string): FieldValidationResult[] { ... }      // 256-byte + XSS
```

Desktop already consumes these for both its global (`UserSettingsModal`) and per-space (`SpaceSettingsModal`) display-name + bio fields.

## Current state on mobile (verified 2026-06-10)

Five hardcoded inputs, none using shared validation:

| Surface | File | Field | Cap today |
|---|---|---|---|
| Onboarding | `app/(onboarding)/profile-setup.tsx` | bio | 160 (counter) |
| Onboarding | `app/(onboarding)/profile-setup.tsx` | display name | 50 |
| Global profile edit | `components/UnifiedProfileEditModal.tsx` | bio | 256 |
| Global profile edit | `components/UnifiedProfileEditModal.tsx` | display name | 60 |
| Per-space profile edit | `components/SpaceSettingsModal.tsx` | bio | 280 |
| Per-space profile edit | `components/SpaceSettingsModal.tsx` + `ProfileModal.tsx` | display name | trim-only |

Mobile imports **neither** `validateUserBio` nor `validateDisplayName` from shared. Display names get `.trim()`-only — **no XSS, no impersonation/homoglyph, no reserved-mention, no `.q` check, no byte cap**.

## What to do

1. **Bump** mobile's `@quilibrium/quorum-shared` to **`2.1.0-28`** or later.

2. **Route all bio inputs** through `validateUserBio` (256 bytes). For the hard `maxLength` on each TextInput, use a coarse char guard equal to `MAX_BIO_BYTES` (matches desktop's `MAX_BIO_INPUT_CHARS` pattern — for ASCII it's exact, for multi-byte text the validator catches the real byte overflow first). Replace the `{bio.length}/160` counter accordingly.

3. **Route all display-name inputs** through `validateDisplayName` (32 bytes + `.q`/XSS/impersonation/reserved). No `maxLength` hard cap needed (desktop relies purely on the validator error); a coarse guard of 32 is fine if you want one.

4. **Hard-block at the Farcaster publish boundary.** In `UnifiedProfileEditModal.saveFarcaster()` (and/or `services/farcaster/updateProfile.ts`), reject a display name > 32 bytes or bio > 256 bytes **before** the `PATCH /v2/me`, with a clear inline message — don't let the relay return an opaque `HTTP 400`. This is the whole point of the byte caps.

5. **Error display:** byte counts are meaningless to users, so show generic "too long" copy with no number (matches desktop's `displayName.tooLong` / `userBio.tooLong` → "Display name is too long" / "Bio is too long"). Use mobile's existing English-string translator pattern from `2026-05-28-adopt-shared-validators.md`.

## Net user-visible cap changes (runtime test required)

| Field | Before (mobile) | After | Direction |
|---|---|---|---|
| Bio (onboarding) | 160 | 256 bytes | **rises** (more room) |
| Bio (global edit) | 256 | 256 bytes | ~same (now byte-accurate) |
| Bio (per-space) | 280 | 256 bytes | **shrinks** |
| Display name (onboarding) | 50 | 32 bytes | **shrinks** |
| Display name (global edit) | 60 | 32 bytes | **shrinks** |

The **shrinking** caps are the ones to flag in release notes: existing display names of 33-50/60 chars and per-space bios of 257-280 chars become invalid on next edit (stored values are not retroactively truncated — only the input is capped going forward).

## Trade-offs

- **Stored data not truncated:** we only cap input. Existing over-limit values survive until the user next edits and re-saves. But re-publishing an over-limit profile to Farcaster will be blocked by step 4 — the user must trim. Acceptable for a corrective convergence.
- **No per-surface special-casing:** all bio inputs use 256 bytes, all display-name inputs use 32 bytes. One rule.

## Runtime test

Required. In the mobile app:
- Each bio editor: paste a 300-char ASCII bio → capped/blocked at 256 bytes with an error, not silent truncation. Paste 65 emoji (260 bytes) → blocked (proves byte counting, not char counting).
- Each display-name editor: `ada.q` → rejected (`.q` rule); `admin` → rejected (impersonation); a 40-char ASCII name → rejected (over 32 bytes); a normal short name → accepted and saves end-to-end.
- Farcaster publish path (scope `both`): set an over-limit name/bio → blocked locally with a clear message **before** any network call to `/v2/me`.

---

*Created 2026-06-10. Consolidates and supersedes the bio-length and display-name tasks after shared #37 (2.1.0-28) made both validators byte-based.*

*Last updated 2026-06-14 — marked `blocked`: verified the byte validators are NOT in the published `2.1.0-29` dist (only in unpublished `2.1.0-30` source), so this can't start until a correct shared publish lands. Confirmed the byte-based intent with the user (Farcaster alignment). Corrected the current-state: `ProfileModal` has no maxLength on either field and the Farcaster publish boundary does no validation.*
