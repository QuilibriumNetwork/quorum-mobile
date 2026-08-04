---
type: bug
title: "Clearing a space description doesn't save — empty string coerced to undefined falls back to old value"
status: done
created: 2026-06-14
severity: medium
repo: quorum-mobile
area: spaces / space settings / save path
discovered-during: "manual testing of the adopt-shared-validators PR (#86) — confirmed NOT caused by that change"
fix-pr: TBD (shipping with the validators follow-up)
---

# Clearing a space description can't be saved

## Symptom (observed 2026-06-14, manual test)

In Space Settings → General tab:
- **Clear the description completely** → tap Save → the **old description reappears** (empty is not saved).
- **Replace** the description with different non-empty text → tap Save → new text saves fine.

So an emptied description silently reverts; only non-empty edits persist.

## Root cause — falsy coercion + nullish fallback

Two cooperating sites, both pre-existing:

1. **`components/SpaceSettingsModal.tsx`** `handleSaveGeneral` — the description was sent as
   `description: description.trim() || undefined`. For a cleared field, `"".trim()` is `""`, and
   `"" || undefined` evaluates to `undefined`. The empty string is dropped before the mutation.

2. **`hooks/chat/useSpaceSettings.ts:66`** (`useUpdateSpace`) builds the updated space with
   `description: params.description ?? space.description`. The `??` only falls back on `null`/
   `undefined` — so receiving `undefined` (from site 1) means "no change → keep the old value." This
   `?? space.X` pattern is applied to every field intentionally as a partial-update convention; it's
   correct. The bug is purely that the caller turned a deliberate `""` into `undefined`.

3. **Secondary visual snap-back:** `SpaceSettingsModal` has `useEffect([space])` that resets the
   input via `setDescription(space.description || '')`. After save, `setSpace(updated)` fires with the
   space that still holds the old description, so the field visibly re-fills with the old text.

`""` → `undefined` (site 1) → `?? space.description` keeps old (site 2) → input reset to old (site 3).

## NOT caused by the validators change (PR #86)

Found while testing PR #86 (adopt shared space validators), but that change is innocent: it only
replaced the `nameError`/`descriptionError` computation. The shared `validateSpaceDescription("", max)`
returns `[]` (no error) for an empty string — XSS check passes, `0 > max` is false — so validation
does NOT block saving an empty description. The save button is enabled and `handleSaveGeneral` runs.
The bug is entirely in the save path, which predates this session.

## Fix applied (mobile-side)

`components/SpaceSettingsModal.tsx`, `handleSaveGeneral`:

```ts
// before
description: description.trim() || undefined,
// after
description: description.trim(),   // keep "" so a cleared description saves
```

Now a cleared field sends `""`; `"" ?? space.description` keeps `""` (since `??` skips only
null/undefined), so the empty description persists. `Space.description` is typed `string | undefined`
in shared (`types/space.d.ts:58`), so `""` is valid through storage and broadcast. No change needed in
`useSpaceSettings.ts` — its partial-update `??` is correct; only the caller was wrong.

## Cross-platform note

The save path broadcasts (`broadcastSpaceUpdate` in `useSpaceSettings.ts:85`), so a cleared
description now syncs to desktop as `description: ""` instead of being omitted. An empty description is
a legitimate state and the field is optional everywhere, so this is expected. If desktop has its own
falsy-guard on incoming description, it would be a separate desktop-side issue — not observed, flagged
here for awareness only.

## Verification

- tsc: 82 errors before == 82 after (zero new); `description.trim()` (`string`) assignable to
  `UpdateSpaceParams.description` (`string | undefined`).
- Runtime (verified on the phone 2026-06-14): clear description → Save → stays empty, no snap-back to
  the old value; re-opening settings shows it empty. Normal non-empty edits still save (no regression).

---
*Created: 2026-06-14 — pre-existing falsy-coercion bug found during PR #86 testing; one-line caller fix applied.*
