---
type: task
title: "Appearance Light/Dark/System Control — Implementation Plan"
status: done
created: 2026-06-15
---

# Appearance Light/Dark/System Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user manually choose Light, Dark, or System for the default Quorum theme via a 3-segment control on the Default row of the Skins modal, persisted across restarts.

**Architecture:** The theme provider already has three-state light/dark override logic (`isDarkOverride: boolean | null`); it is simply never surfaced or persisted. This plan adds an MMKV-persisted `AppearancePref`, seeds the provider from it at boot, exposes a canonical `setAppearance` + `appearance` on the theme context, and renders a segmented control in a new optional `footer` slot of the Default `SkinRow` (shown only when no custom skin is active). The skin engine is untouched.

**Tech Stack:** React Native, Expo Router, TypeScript, react-native-mmkv, existing `@/theme` provider and `@/components/ui/SkinTouchable`.

**Testing note:** This project has NO Jest/test harness (`package.json` has no test script, jest is not a dependency). Verification is therefore static (`tsc`, `expo lint`) plus manual device testing. There are no unit-test steps; each task ends with a typecheck + lint + commit, and the final task is manual device verification.

**Typecheck command (from global CLAUDE.md):**
```
npx tsc --noEmit --jsx react-jsx --skipLibCheck
```
**Lint command:** `yarn lint`

---

### Task 1: Persist the appearance preference (MMKV)

**Files:**
- Modify: `services/theme/skinPrefs.ts` (append after the existing exports, e.g. after line 85)

- [ ] **Step 1: Add the `AppearancePref` type and accessors**

Append to the end of `services/theme/skinPrefs.ts`:

```ts
/** User's manual appearance choice for the BUILT-IN theme. Has no effect while
 *  a custom skin is active (skins pin their own base). Stored independently of
 *  the active skin so it survives switching to a skin and back. */
export type AppearancePref = 'system' | 'light' | 'dark';

const K_APPEARANCE = 'appearancePref';

/** Manual appearance choice; 'system' (follow device) when unset or invalid. */
export function getAppearancePref(): AppearancePref {
  const raw = skinPrefsStore.getString(K_APPEARANCE);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function setAppearancePref(pref: AppearancePref): void {
  // Store only an explicit override; 'system' is the absence of a key.
  if (pref === 'system') skinPrefsStore.remove(K_APPEARANCE);
  else skinPrefsStore.set(K_APPEARANCE, pref);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add services/theme/skinPrefs.ts
git commit -m "Add persisted appearance preference (light/dark/system)"
```

---

### Task 2: Seed + expose appearance in the theme provider

**Files:**
- Modify: `theme/ThemeProvider.tsx`

The provider already has `isDarkOverride` with the exact `null`/`true`/`false` semantics
(`ThemeProvider.tsx:56,60-67,71-77`). We add: a `defaultAppearance` prop to seed it at
construction, a canonical `setAppearance` that persists + updates state, and a derived
`appearance` value on the context for the UI to show the active segment.

- [ ] **Step 1: Import the pref helpers and type**

In the import block near the top of `theme/ThemeProvider.tsx`, change the existing
`skinPrefs` import (currently line 8):

```ts
import { saveSkin, setActiveSkinId } from '@/services/theme/skinPrefs';
```

to:

```ts
import {
  saveSkin,
  setActiveSkinId,
  setAppearancePref,
  type AppearancePref,
} from '@/services/theme/skinPrefs';
```

- [ ] **Step 2: Add `appearance` + `setAppearance` to the context type**

In `ThemeContextType` (starts line 10), add two members. Insert after the
`setIsDark` line (line 16):

```ts
  /** Manual appearance choice for the built-in theme: system | light | dark. */
  appearance: AppearancePref;
  /** Set + persist the appearance choice. Canonical entry point for the UI —
   *  use this instead of setIsDark so the choice survives restarts. */
  setAppearance: (pref: AppearancePref) => void;
```

- [ ] **Step 3: Add the `defaultAppearance` prop**

In `ThemeProviderProps` (starts line 41), add after `forceTheme` (line 44):

```ts
  /** Appearance pref restored from storage at boot (see app/_layout.tsx). */
  defaultAppearance?: AppearancePref;
```

And in the destructured component signature (lines 49-54), add the default:

```ts
export const CustomThemeProvider: React.FC<ThemeProviderProps> = ({
  children,
  defaultAccentColor = 'blue',
  forceTheme = null,
  defaultSkin = null,
  defaultAppearance = 'system',
}) => {
```

- [ ] **Step 4: Seed `isDarkOverride` from `defaultAppearance`**

Change the `isDarkOverride` initializer (line 56) from:

```ts
  const [isDarkOverride, setIsDarkOverride] = useState<boolean | null>(null);
```

to:

```ts
  const [isDarkOverride, setIsDarkOverride] = useState<boolean | null>(
    defaultAppearance === 'system' ? null : defaultAppearance === 'dark',
  );
```

- [ ] **Step 5: Add the `setAppearance` callback + derived `appearance`**

After the `setIsDarkCb` callback (ends line 77), add:

```ts
  const setAppearance = useCallback((pref: AppearancePref) => {
    setAppearancePref(pref); // persist first
    setIsDarkOverride(pref === 'system' ? null : pref === 'dark');
  }, []);

  const appearance: AppearancePref =
    isDarkOverride === null ? 'system' : isDarkOverride ? 'dark' : 'light';
```

- [ ] **Step 6: Wire both into the context value**

In the `value` `useMemo` (starts line 99), add `appearance` and `setAppearance` to the
object, and add them to the dependency array. The object becomes:

```ts
  const value = useMemo(() => ({
    theme,
    isDark,
    accentColor,
    activeSkin: skin,
    appearance,
    setIsDark: setIsDarkCb,
    setAppearance,
    setAccentColor,
    toggleTheme,
    setActiveSkin,
    previewSkin,
  }), [theme, isDark, accentColor, skin, appearance, setIsDarkCb, setAppearance, setAccentColor, toggleTheme, setActiveSkin, previewSkin]);
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add theme/ThemeProvider.tsx
git commit -m "Seed and expose appearance preference in theme provider"
```

---

### Task 3: Restore the appearance preference at boot

**Files:**
- Modify: `app/_layout.tsx`

- [ ] **Step 1: Import the boot-time reader**

The file already imports `getActiveSkin` from skinPrefs (line 68):

```ts
import { getActiveSkin } from '@/services/theme/skinPrefs';
```

Change it to also import the appearance reader:

```ts
import { getActiveSkin, getAppearancePref } from '@/services/theme/skinPrefs';
```

- [ ] **Step 2: Read the pref synchronously at boot**

In `RootLayout` (starts line 256), just below the `bootSkin` `useMemo` block (ends
line 269), add:

```ts
  // Appearance pref is a synchronous MMKV read — available before first paint,
  // same as the skin tokens, so a manual light/dark choice never flashes.
  const bootAppearance = React.useMemo(() => getAppearancePref(), []);
```

- [ ] **Step 3: Pass it to the provider**

Change the `CustomThemeProvider` opening tag (line 293) from:

```tsx
      <CustomThemeProvider defaultAccentColor="blue" defaultSkin={bootSkin}>
```

to:

```tsx
      <CustomThemeProvider defaultAccentColor="blue" defaultSkin={bootSkin} defaultAppearance={bootAppearance}>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/_layout.tsx
git commit -m "Restore appearance preference at boot"
```

---

### Task 4: Add a `footer` slot to `SkinRow`

**Files:**
- Modify: `components/skins/SkinsModal.tsx` (the `SkinRow` component, lines 298-343)

This lets the Default row render content BELOW the touchable, OUTSIDE it, avoiding the
tap conflict (the whole row body is currently a single `TouchableOpacity`). Every other
caller omits `footer`, so they are unchanged.

- [ ] **Step 1: Add the `footer` prop to `SkinRow`'s signature and props type**

In the `SkinRow` function (starts line 298), add `footer` to the destructured params and
to the inline props type:

```tsx
function SkinRow({
  label,
  description,
  active,
  onPress,
  onLongPress,
  onDelete,
  footer,
  theme,
}: {
  label: string;
  description: string;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onDelete?: () => void;
  footer?: React.ReactNode;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
```

- [ ] **Step 2: Wrap the touchable + footer in a container and render the footer**

The current body returns a single `<TouchableOpacity>...</TouchableOpacity>`
(lines 315-342). Wrap it so the footer is a sibling rendered below it. Replace the
`return (` ... `);` body of `SkinRow` with:

```tsx
  return (
    <View>
      <TouchableOpacity
        onPress={onPress}
        onLongPress={onLongPress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: Skin.space(12),
          paddingVertical: Skin.space(14),
          paddingHorizontal: Skin.space(16),
          borderRadius: theme.radii.md,
          backgroundColor: active ? theme.colors.surface3 : 'transparent',
          marginHorizontal: Skin.space(12),
          marginBottom: Skin.space(4),
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.colors.textMain, fontWeight: '600', fontSize: Skin.font(15) }}>{label}</Text>
          <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), marginTop: Skin.space(2) }}>{description}</Text>
        </View>
        {active && <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.accent} />}
        {onDelete && (
          <TouchableOpacity onPress={onDelete} hitSlop={10} style={{ padding: Skin.space(4) }}>
            <IconSymbol name="trash" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
      {footer}
    </View>
  );
```

(`View` is already imported at the top of the file, line 12.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: PASS. (No caller passes `footer` yet — it is optional, so existing rows are unaffected.)

- [ ] **Step 4: Commit**

```bash
git add components/skins/SkinsModal.tsx
git commit -m "Add optional footer slot to SkinRow"
```

---

### Task 5: Build the `AppearanceSegments` control

**Files:**
- Modify: `components/skins/SkinsModal.tsx` (add a new local component, e.g. after the `SkinRow` component near line 343)

A 3-segment pill control matching the existing tab styling (`tabs`/`tab` styles,
lines 399-409). Each segment is its own touchable, so there is no gesture ambiguity.

- [ ] **Step 1: Import the appearance type**

The file imports `SkinOverride` (line 24). Add the `AppearancePref` import. Change the
skinPrefs import (lines 21) — currently:

```ts
import { deleteSkin, listSkins, saveSkin } from '@/services/theme/skinPrefs';
```

to:

```ts
import { deleteSkin, listSkins, saveSkin, type AppearancePref } from '@/services/theme/skinPrefs';
```

- [ ] **Step 2: Add the `AppearanceSegments` component**

Insert after the `SkinRow` component (after its closing brace near line 343):

```tsx
const APPEARANCE_SEGMENTS: { key: AppearancePref; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

function AppearanceSegments({
  value,
  onChange,
  theme,
}: {
  value: AppearancePref;
  onChange: (pref: AppearancePref) => void;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: Skin.space(8),
        paddingHorizontal: Skin.space(16),
        paddingBottom: Skin.space(8),
      }}
    >
      {APPEARANCE_SEGMENTS.map((seg) => {
        const active = value === seg.key;
        return (
          <TouchableOpacity
            key={seg.key}
            onPress={() => onChange(seg.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Appearance: ${seg.label}`}
            style={{
              paddingHorizontal: Skin.space(14),
              paddingVertical: Skin.space(7),
              borderRadius: theme.radii.pill,
              backgroundColor: active ? theme.colors.surface3 : 'transparent',
            }}
          >
            <Text
              style={{
                color: active ? theme.colors.textMain : theme.colors.textMuted,
                fontWeight: '600',
                fontSize: Skin.font(13),
              }}
            >
              {seg.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: PASS. (Component is defined but not yet used — that is fine; it is referenced in Task 6. If lint flags an unused symbol, Task 6 in the same session resolves it; commit both together if needed.)

- [ ] **Step 4: Commit**

```bash
git add components/skins/SkinsModal.tsx
git commit -m "Add AppearanceSegments control"
```

---

### Task 6: Render the segments on the Default row when no skin is active

**Files:**
- Modify: `components/skins/SkinsModal.tsx` (the `SkinsModal` component — `useTheme` destructure line 37, and the Default `SkinRow` lines 243-249)

- [ ] **Step 1: Pull `appearance` + `setAppearance` from the theme context**

Change the destructure (line 37) from:

```tsx
  const { theme, activeSkin, setActiveSkin } = useTheme();
```

to:

```tsx
  const { theme, activeSkin, setActiveSkin, appearance, setAppearance } = useTheme();
```

- [ ] **Step 2: Pass the segments as the Default row's `footer`**

Change the Default `SkinRow` (lines 243-249) from:

```tsx
            <SkinRow
              label="Default"
              description="The built-in Quorum theme"
              active={!activeSkin}
              onPress={() => apply(null)}
              theme={theme}
            />
```

to:

```tsx
            <SkinRow
              label="Default"
              description="The built-in Quorum theme"
              active={!activeSkin}
              onPress={() => apply(null)}
              footer={
                !activeSkin ? (
                  <AppearanceSegments value={appearance} onChange={setAppearance} theme={theme} />
                ) : undefined
              }
              theme={theme}
            />
```

The `!activeSkin` guard means the segments render only when the Default theme is
selected; picking any custom skin hides them (a skin pins its own base).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `yarn lint`
Expected: PASS (no unused-var warning for `AppearanceSegments` now that it is used).

- [ ] **Step 5: Commit**

```bash
git add components/skins/SkinsModal.tsx
git commit -m "Show appearance segments on the Default theme row"
```

---

### Task 7: Manual device verification

**Files:** none (verification only).

No automated test harness exists, so verify on a running app (emulator or device per
the dev-start scripts in `.agents/scripts/`).

- [ ] **Step 1: Build/run and open Skins → My Skins, with the Default theme selected**

Confirm the **System · Light · Dark** segments appear under the Default row, with the
correct one highlighted (System if never changed).

- [ ] **Step 2: System follows device**

With "System" selected, toggle the device's light/dark setting. The app's theme follows
it. Status bar and any back-swipe overlay match.

- [ ] **Step 3: Manual Light / Dark take effect immediately**

Tap "Light" → app goes light at once. Tap "Dark" → dark at once. Status bar style
(`_layout.tsx:245-254`) and back-swipe overlay color (`_layout.tsx:219`) match the chosen
appearance in each case.

- [ ] **Step 4: Persistence across restart (the core gap being fixed)**

With "Dark" selected, fully kill and relaunch the app. It comes back **Dark**, not reset
to System. Repeat with "Light".

- [ ] **Step 5: Skin pins its own base; choice is remembered**

Apply a custom skin → the segments disappear and the skin's base wins. Return to the
Default theme → the segments reappear and the previously chosen segment (e.g. Dark) is
restored and applied.

- [ ] **Step 6: Final commit (if any verification tweaks were needed)**

```bash
git add -A
git commit -m "Appearance control: verification tweaks"
```

(Skip if nothing changed.)

---

## Self-Review

**Spec coverage:**
- Persistence (MMKV, independent of skin) → Task 1. ✓
- Seed `isDarkOverride` + `setAppearance`/`appearance` on context → Task 2. ✓
- Boot restore via `defaultAppearance` prop → Task 3. ✓
- `footer` slot avoiding tap conflict → Task 4. ✓
- `AppearanceSegments` (System·Light·Dark, pill styling) → Task 5. ✓
- Render on Default row only when `!activeSkin` → Task 6. ✓
- Status bar / overlay follow override (verify) → Task 7 steps 2-3. ✓
- "Remember their choice" across skin switch → Task 7 step 5 (mechanism: independent MMKV key from Task 1). ✓
- Restart persistence (core gap) → Task 7 step 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `AppearancePref` defined once in Task 1, imported in Tasks 2/5; `getAppearancePref`/`setAppearancePref`/`setAppearance`/`appearance` names consistent across Tasks 1-6; `defaultAppearance` prop name consistent Tasks 2-3; `footer` prop name consistent Tasks 4 & 6; `AppearanceSegments` props (`value`/`onChange`/`theme`) match the call site in Task 6. ✓

---
*Last updated: 2026-06-15*
