---
type: bug
status: done
created: 2026-06-09
updated: 2026-06-09
severity: high
blocks: [add-channel, add-group, render-existing-space-with-non-SF-icon]
runtime-repro: confirmed
fix-branch: feat/migrate-iconsymbol-to-shared-icon
fix-task: .agents/issues/.deferred/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md
---

# IconSymbol throws on Tabler icon names received from desktop manifests

## Resolution (2026-06-09)

Fixed on `feat/migrate-iconsymbol-to-shared-icon` by replacing `components/ui/IconSymbol.tsx` with a Tabler-direct shim that:
- Resolves legacy SF Symbol names through a complete SF_TO_TABLER table (~180 entries) → renders the matching Tabler component.
- Falls through to a dynamic Tabler lookup for raw semantic names sent from desktop manifests (`"users"` → `IconUsers`).
- Returns `null` + dev warning for unknown names instead of throwing.
- Cross-platform: `IconSymbol.ios.tsx` deleted, Tabler renders on iOS / Android / web identically.

Companion PR on `quorum-shared` (`feat/icon-mapping-additions-for-mobile-migration`) extends the shared `iconMapping.ts` and `types.ts` with ~55 new semantic names so a future call-site sweep (Phase 2) can use the shared `Icon` primitive directly. Full plan: [`2026-06-09-migrate-iconsymbol-to-shared-icon-primitive`](../.deferred/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md).

Verification: `npx tsc --noEmit --jsx react-jsx --skipLibCheck` shows the same 107 pre-existing errors on this branch as on master — zero new errors introduced.

## Symptoms

When the mobile app tries to render any icon name that isn't in `components/ui/IconSymbol.tsx`'s `MAPPING` table, the entire render tree crashes with:

```
ERROR [Error: IconSymbol: No Android/Material icon mapping for SF Symbol "users".
Add it to MAPPING in IconSymbol.tsx]
```

Reproduced 2026-06-09 while testing add-channel — the crash blocks the add-channel flow even though the failing icon ("users") has nothing to do with the new channel itself. The error surfaces because the parent space's groups contain an icon name picked on desktop that mobile can't render.

## Root cause

Mobile and desktop are on **two different icon systems** that don't share a vocabulary:

| Platform | Icon library | Source |
|---|---|---|
| Desktop | Tabler (`@tabler/icons-react`) | `quorum-desktop/src/components/space/IconPicker/types.ts` — offers 80+ Tabler names including `users`, `bell`, `flame`, etc. |
| Mobile | SF Symbols (iOS) + Material Icons (Android/web), via local `IconSymbol` | `quorum-mobile/components/ui/IconSymbol.tsx` — 200-entry SF Symbol → Material Icon manual mapping |

Icons picked on desktop are stored as raw Tabler names in the space manifest (e.g. `"users"`). When mobile syncs the manifest and renders the space, it passes that string to `IconSymbol`, which:

```ts
// components/ui/IconSymbol.tsx:273-275
const mappedName = MAPPING[name];
if (!mappedName) {
  throw new Error(`IconSymbol: No Android/Material icon mapping for SF Symbol "${name}". Add it to MAPPING in IconSymbol.tsx`);
}
```

Two compounding problems:

1. **Vocabulary mismatch.** Desktop emits Tabler names; mobile expects SF Symbol names. They cannot agree on a string like `"users"` (Tabler) vs `"person.2.fill"` (SF Symbol) because the mapping tables don't share keys.

2. **Hard throw on unknown icon.** Even if vocabulary were fixed, the local `IconSymbol` throws instead of failing soft. Compare to `quorum-shared`'s `Icon.native.tsx:45-47` which logs a warning and returns `null`. A throw inside a render path bubbles up and crashes the surrounding component tree.

## Why this surfaces now

Desktop's drag-and-drop channel ordering work (PR series) shipped a richer `IconPicker` with Tabler icons. Channels/groups created on desktop with the new icons now ride into mobile via the existing manifest sync and trigger the throw on first render.

## Existing infrastructure that should fix this

`@quilibrium/quorum-shared` already ships a cross-platform `Icon` primitive specifically designed to solve this:

- `node_modules/@quilibrium/quorum-shared/src/primitives/Icon/Icon.web.tsx` — Tabler React
- `node_modules/@quilibrium/quorum-shared/src/primitives/Icon/Icon.native.tsx` — Tabler React Native (`@tabler/icons-react-native`)
- `node_modules/@quilibrium/quorum-shared/src/primitives/Icon/iconMapping.ts` — single source of truth, 165 named icons including `users`, `bell`, `flame`, etc.

Same API on both platforms (`name`, `size`, `color`, `variant`). Logs and returns `null` on unknown — no throw. Mobile is **not** using it today but the package is already in its `node_modules` via the workspace dependency.

Tabler ships a React Native build, so platform compatibility is fine — desktop is already using the React variant successfully.

## Proposed fix (rough shape — needs its own task)

Replace mobile's local `IconSymbol` with the shared `Icon` primitive across the app:

1. Add an alias / wrapper so existing call sites (`<IconSymbol name="trash" />`) keep compiling, but the underlying renderer is the shared Tabler primitive
2. Map each existing SF Symbol name in `IconSymbol.tsx`'s `MAPPING` table to the equivalent Tabler name (e.g. `'trash'` → `'trash'`, `'person.2.fill'` → `'users'`, `'xmark'` → `'x'`)
3. Keep the iOS-specific `IconSymbol.ios.tsx` only if there's a deliberate reason to use native SF Symbols on iOS — otherwise replace it too so iOS and Android look identical (and match desktop)
4. Delete the manual `MAPPING` once all call sites are migrated

Risk: visual regression — every icon in the app changes from Material Icons style (filled, rounded) to Tabler (outlined, geometric). That's the intended outcome (cross-platform consistency) but should be reviewed against screenshots before merge.

## Immediate triage options (if a fuller migration is too big)

Two cheaper interim fixes that unblock add-channel without touching the architecture:

a) **Make `IconSymbol` fail soft.** Change the throw at L273-275 to `console.warn` + return a fallback icon (e.g. the `number` mapping). Stops the crash but icons rendered from desktop-Tabler names still appear as the fallback. ~3 lines, near-zero risk.

b) **Add the missing Tabler names to `MAPPING` ad-hoc.** Mirror desktop's `IconPicker/types.ts` list (~80 names) into mobile's `MAPPING`, mapping each Tabler name to its nearest Material Icon equivalent. Brittle and a maintenance burden, but unblocks rendering.

(a) is the minimum to unblock testing. Recommend pairing (a) with the full migration as the durable fix.

## Verification

- [ ] Open a space that contains a group or channel with a Tabler-named icon (e.g. one picked on desktop) → render does not crash
- [ ] Add a new channel from the mobile UI → completes without IconSymbol error
- [ ] Existing iOS-only call sites still render correctly
- [ ] Visual review against screenshots — Material vs Tabler difference is acceptable / matches desktop

## Related

- Triggered while testing: [.agents/issues/.done/2026-05-29-channel-reorder-mutations-should-broadcast.md](2026-05-29-channel-reorder-mutations-should-broadcast.md)
- Desktop IconPicker: `quorum-desktop/src/components/space/IconPicker/types.ts`
- Shared Icon primitive: `node_modules/@quilibrium/quorum-shared/src/primitives/Icon/`
- Mobile IconSymbol (the throw): `components/ui/IconSymbol.tsx:273-275`

---

*Created: 2026-06-09*
