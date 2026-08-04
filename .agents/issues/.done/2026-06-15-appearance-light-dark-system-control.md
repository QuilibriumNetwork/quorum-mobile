---
type: task
title: "Appearance control: Light / Dark / System for the Default theme"
status: done
created: 2026-06-15
---

# Appearance control: Light / Dark / System for the Default theme

**Date:** 2026-06-15
**Status:** Spec — pending implementation plan
**Branch context:** `ui-polish-chat-feed-menus` (or a dedicated branch)

## Problem

The default Quorum theme follows the device's system light/dark preference. This is
good default UX. But a user cannot manually choose Light or Dark *while staying on the
default theme* — their only lever is to pick a different skin. Light and dark skins
exist, but choosing the **default** theme explicitly in light or dark is impossible:
it is always tied to the system setting.

## Key discovery

The capability is ~95% already built and simply never surfaced or persisted.

- `theme/ThemeProvider.tsx` already has `setIsDark` / `toggleTheme` with three-state
  semantics via `isDarkOverride: boolean | null`:
  - `null` → follow the device (`deviceColorScheme === 'dark'`)
  - `true` → pinned dark
  - `false` → pinned light
  See `ThemeProvider.tsx:56,60-64,71-77`.
- **Nothing in the UI calls them.** `setIsDark` / `toggleTheme` are on the context but
  no screen wires them to a control. Only `setActiveSkin` is wired (in `SkinsModal`).
- The override only matters for the **default theme**. When a custom skin is active,
  light/dark is hard-pinned to the skin's authored `base`:
  `const isDark = skin ? skin.base === 'dark' : baseIsDark;` (`ThemeProvider.tsx:67`).
- **The one real gap is persistence.** `isDarkOverride` is in-memory only, so it resets
  to `null` (follow-system) on every app restart. The skin choice *does* persist (MMKV,
  read back at boot in `_layout.tsx:261-269`); the appearance pref does not.

## Decision: do NOT model this as a second skin

A "default dark" skin would fight the design at `ThemeProvider.tsx:67` — a custom skin
pins its own base and bypasses the manual override. Modeling default-dark as a skin
would create three competing deciders of "am I dark?" (system, override, skin base).
Instead, expose and persist the override that already exists. The skin engine is left
untouched.

## Design

Three small, well-bounded changes.

### 1. Persistence — `services/theme/skinPrefs.ts`

Add one MMKV key storing the appearance preference, stored **independently of the
active skin** so it survives switching to a skin and back.

```ts
export type AppearancePref = 'system' | 'light' | 'dark';

const K_APPEARANCE = 'appearancePref';

export function getAppearancePref(): AppearancePref {
  const raw = skinPrefsStore.getString(K_APPEARANCE);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function setAppearancePref(pref: AppearancePref): void {
  if (pref === 'system') skinPrefsStore.remove(K_APPEARANCE);
  else skinPrefsStore.set(K_APPEARANCE, pref);
}
```

Defaults to `'system'` when unset or invalid.

### 2. Theme provider — `theme/ThemeProvider.tsx`

The three-state logic already exists. Two changes:

- Accept a `defaultAppearance?: AppearancePref` prop and use it to **seed**
  `isDarkOverride` at construction:
  - `'system'` → `null`
  - `'light'` → `false`
  - `'dark'` → `true`

  This fixes the restart-resets-to-System gap.

- Add a single canonical `setAppearance(pref: AppearancePref)` callback to the context
  that BOTH updates `isDarkOverride` state AND writes MMKV via `setAppearancePref`. The
  UI calls this (not the bare `setIsDark`) so persistence is guaranteed and there is one
  source of truth.

  ```ts
  const setAppearance = useCallback((pref: AppearancePref) => {
    setAppearancePref(pref); // persist
    setIsDarkOverride(pref === 'system' ? null : pref === 'dark');
  }, []);
  ```

- Expose `appearance: AppearancePref` on the context (derived from `isDarkOverride`) so
  the UI can show which segment is active:
  - `isDarkOverride === null` → `'system'`
  - `isDarkOverride === true` → `'dark'`
  - `isDarkOverride === false` → `'light'`

- `setIsDark` / `toggleTheme` remain unchanged for any other caller.

### 3. Boot wiring — `app/_layout.tsx`

Alongside `getActiveSkin()` in the boot path (`_layout.tsx:261-269`), read
`getAppearancePref()` synchronously (MMKV, no async) and pass it to
`CustomThemeProvider` as `defaultAppearance` (`_layout.tsx:293`). The provider seeds
`isDarkOverride` from it, so the manual choice is live before first paint — no flash,
same pattern the skin already uses.

### 4. The UI control — `components/skins/SkinsModal.tsx`

A 3-segment control (**System · Light · Dark**, System first since it is the default),
rendered **inside the Default row, only when `!activeSkin`**. When a custom skin is
selected, the segments disappear and the Default row collapses back to its plain
single-tap form.

**Avoiding the tap conflict.** The entire `SkinRow` is currently one `TouchableOpacity`
(`SkinsModal.tsx:315-342`). Nesting the segments inside it would make a segment tap
also bubble to the row's `onPress`. Fix: add an optional **`footer` slot** to `SkinRow`
that renders BELOW the touchable, OUTSIDE it, as a sibling. The Default row passes the
segmented control as `footer`. Every other `SkinRow` caller is unchanged (no `footer`).

```
┌─ SkinRow (Default) ───────────────────────────────────┐
│  ┌─ TouchableOpacity (onPress = apply(null)) ──────┐  │  ← select Default theme
│  │  Default                                    ✓   │  │
│  │  The built-in Quorum theme                      │  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─ footer: <AppearanceSegments /> ────────────────┐  │  ← only when !activeSkin
│  │   [ System ] [ Light ] [ Dark ]                 │  │  ← each is its own touchable
│  └─────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

`AppearanceSegments` is a small local component built with the existing
`SkinTouchable` + `Skin.space/font/radius` tokens and `theme.colors`, matching the
pill-tab styling already in the modal (`tabs`/`tab` styles, `SkinsModal.tsx:399-409`).
The active segment uses `surface3` background + accent/main text, mirroring the existing
tab pattern. Calls `setAppearance(seg)` from `useTheme()`.

### Status bar

`StatusBarWrapper` (`_layout.tsx:245-254`) and the loading/back-swipe overlay
(`_layout.tsx:219`) already react to `isDark` from context. The manual override flows
into `isDark`, so they update automatically. **Verify** during implementation; no code
change expected.

## Behavior summary (chosen options)

- **Remember their choice:** the appearance pref is stored independently and survives
  switching to a custom skin and back. Returning to Default restores the last manual
  choice (e.g. Dark).
- **Inline, hidden when skin active:** segments render only when `!activeSkin`.
- **Status bar:** verified to follow the manual override.

## Testing (manual — no theming test harness exists)

1. Default theme + System → app follows device light/dark.
2. Tap Light → app goes light immediately; tap Dark → dark immediately.
3. Kill + relaunch → manual choice persists (NOT reset to System). **Core gap fixed.**
4. Pick a custom skin → segments disappear, skin's `base` wins. Return to Default →
   previous manual choice restored.
5. Status bar + back-swipe overlay match the chosen appearance in all three states.

## Out of scope (YAGNI)

- No second "default dark" skin.
- No appearance control in main Settings (lives only on the Default row in Skins).
- No per-skin appearance override (skins keep authoring their own `base`).

## Files touched

| File | Change |
|------|--------|
| `services/theme/skinPrefs.ts` | Add `AppearancePref` type, `getAppearancePref`, `setAppearancePref` |
| `theme/ThemeProvider.tsx` | `defaultAppearance` prop, seed `isDarkOverride`, `setAppearance` + `appearance` on context |
| `app/_layout.tsx` | Read pref at boot, pass `defaultAppearance` to provider |
| `components/skins/SkinsModal.tsx` | `footer` slot on `SkinRow`; `AppearanceSegments`; render on Default row when `!activeSkin` |

---
*Last updated: 2026-06-15*
