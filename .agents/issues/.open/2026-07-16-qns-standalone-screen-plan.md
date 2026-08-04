---
type: task
title: "QNS Standalone Screen — Implementation Plan"
status: open
created: 2026-07-16
---

# QNS Standalone Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Quilibrium Name Service (QNS) experience out of the Premium tab in `ProfileModal` onto its own skin-independent, QNS-branded expo-router screen (`app/qns.tsx`) with tabs Register / Marketplace / Auctions / My Names / Offers.

**Architecture:** A new `theme/qns/brand.ts` `useQnsBrand()` hook returns the QNS palette for the current light/dark base (values ported from `qns-web`). A new `app/qns.tsx` route hosts a `QnsTabs` strip (wrapping the existing `SegmentedPills`) and per-tab content. Phase 1 builds the shell + Register + My Names tabs (fully QNS-branded) and hosts the existing `MarketplaceModal`/`AuctionsModal`/`OffersModal` bodies as-is; the Premium tab is reduced to Apex + a QNS entry banner. Phase 2 re-skins the marketplace surfaces to QNS tokens. Every QNS element reads color from `useQnsBrand()`, never from `theme.colors`; metrics still come from `Skin.*`.

**Tech Stack:** React Native + Expo (expo-router file routes), TypeScript, `expo-linear-gradient`, existing `@/hooks/useQNS` + `@/hooks/useQNSMarketplace` (React Query), `@/theme` (`useTheme().isDark`), `SegmentedPills`, mobile `Button`/`Card`/`SkinTouchable`/`IconSymbol`/`QnsIcon`, `EmptyState`/`ErrorState`/`LoadingState`.

**Design spec:** `.agents/issues/.open/2026-07-16-qns-standalone-screen-design.md`

---

## ⚠️ Repo reality that shapes this plan (read first)

1. **No test framework.** This project has **no** `test` script, no jest, no
   testing-library, and zero `*.test.tsx` files. Do **not** invent a test harness as part
   of this feature — that is a separate decision for the repo owner. Verification for every
   task is therefore: **(a) TypeScript typecheck, (b) `expo lint`, (c) in-app behavioral
   check.** Where the skill template says "write a failing test", we substitute a concrete
   **typecheck/lint gate** plus a **manual verification checklist**.

2. **Typecheck command** (from global CLAUDE.md):
   ```
   npx tsc --noEmit --jsx react-jsx --skipLibCheck
   ```
   Expected after each task: no new errors introduced by the task's files.

3. **Lint command:** `yarn lint` (alias for `expo lint`).

4. **In-app run:** use the existing dev scripts (do NOT rebuild natively unless a native
   module changes — none do here):
   - `.agents/scripts/dev-start-mobile.ps1` (physical phone) or
     `.agents/scripts/dev-start-emulator.ps1` (emulator).
   Reload JS to see changes; no `build-app.ps1` needed for this pure-JS feature.

5. **`.agents/` is gitignored on mobile.** These plan/spec files are local-only. Do not
   try to commit them. Commit only source files.

6. **Branch + PR discipline** (from project memory): do all of this on **one** well-named
   branch → single squash-merge PR at the end. Branch name must be self-explanatory to
   other devs (no internal jargon): e.g. `qns-standalone-screen`.

7. **NEVER uninstall the real app** (`com.quilibrium.quorummobile`). Not relevant to JS
   work, but stated for safety.

---

## File Structure

**New files (Phase 1):**
- `theme/qns/brand.ts` — `useQnsBrand()` hook + `QnsBrand` type. One responsibility: QNS color tokens for light/dark.
- `theme/qns/index.ts` — barrel re-export.
- `components/qns/screen/QnsHero.tsx` — reusable gradient hero (LinearGradient + title/subtitle/@ motif).
- `components/qns/screen/QnsGradientButton.tsx` — primary CTA with purple→pink gradient fill.
- `components/qns/screen/QnsTabs.tsx` — `SegmentedPills` wrapper forcing QNS brand active state.
- `components/qns/screen/QnsRegisterTab.tsx` — claim flow (hero, search, tiers, invite, health gating, "own N names" nudge).
- `components/qns/screen/QnsMyNamesTab.tsx` — owned/delegated names list + filter.
- `components/qns/screen/QnsScreen.tsx` — the screen body: brand scope + header + tabs + tab switch.
- `app/qns.tsx` — expo-router route wrapper around `QnsScreen`.

**Modified files:**
- `components/ProfileModal.tsx` — remove the QNS Premium-tab block; replace with Apex card (kept) + a QNS entry banner that navigates to `/qns`. Remove now-unused QNS state/hooks/handlers that moved.
- `components/UnifiedProfileScreen.tsx` — drop the marketplace-family modal state it hosted for ProfileModal (`onOpenMarketplace/onOpenAuctions/onOpenOffers`) if now unused, OR leave as harmless until Phase 1 Task 8 cleans it.

**Phase 2 modified files:**
- `components/qns/MarketplaceModal.tsx`, `AuctionsModal.tsx`, `OffersModal.tsx`, `NameDetailModal.tsx`, `BuyNameModal.tsx`, `MakeOfferModal.tsx`, `CreateAuctionModal.tsx` — swap `useTheme().theme.colors` reads for `useQnsBrand()`.

---

# PHASE 1 — Structure & brand shell

## Task 1: QNS brand token layer

**Files:**
- Create: `theme/qns/brand.ts`
- Create: `theme/qns/index.ts`

- [ ] **Step 1: Create the brand hook**

Create `theme/qns/brand.ts`. Values are the authoritative QNS palette from
`qns-web/src/index.css` (light `:root`, dark `html.dark`).

```ts
import { useTheme } from '@/theme';

export interface QnsBrand {
  isDark: boolean;
  brand: string;
  accent: string;
  /** [start, end] stops for the 135° signature gradient. */
  gradient: [string, string];
  bg: { page: string; surface: string; surfaceRaised: string; surfaceSubtle: string };
  text: { primary: string; muted: string };
  border: string;
  success: string;
  danger: string;
}

const LIGHT: Omit<QnsBrand, 'isDark'> = {
  brand: '#6330CA',
  accent: '#FF056D',
  gradient: ['#6330CA', '#FF056D'],
  bg: { page: '#F0E9E4', surface: '#F8F8F8', surfaceRaised: '#FFFFFF', surfaceSubtle: '#F4F0F8' },
  text: { primary: '#251542', muted: 'rgba(37,21,66,0.6)' },
  border: 'rgba(37,21,66,0.15)',
  success: '#22A941',
  danger: '#E74A4A',
};

const DARK: Omit<QnsBrand, 'isDark'> = {
  brand: '#A073FF',
  accent: '#FF468C',
  gradient: ['#A073FF', '#FF468C'],
  bg: { page: '#140E22', surface: '#1A1230', surfaceRaised: '#221840', surfaceSubtle: '#322658' },
  text: { primary: '#EEE8FC', muted: 'rgba(238,232,252,0.58)' },
  border: 'rgba(180,160,230,0.18)',
  success: '#50C841',
  danger: '#F54B82',
};

/**
 * QNS brand tokens for the current light/dark base. Skin-independent: reads only
 * `isDark` from the active theme and ignores skin accent/geometry/fonts/surfaces.
 * Every component on the QNS screen must read color from here, never theme.colors.
 */
export function useQnsBrand(): QnsBrand {
  const { isDark } = useTheme();
  return { isDark, ...(isDark ? DARK : LIGHT) };
}
```

- [ ] **Step 2: Create the barrel**

Create `theme/qns/index.ts`:

```ts
export { useQnsBrand, type QnsBrand } from './brand';
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: no new errors referencing `theme/qns/*`.

- [ ] **Step 4: Commit**

```bash
git add theme/qns/brand.ts theme/qns/index.ts
git commit -m "feat(qns): add useQnsBrand token layer for standalone screen"
```

**Manual verification:** none yet (no consumer). Typecheck is the gate.

---

## Task 2: QnsHero reusable component

**Files:**
- Create: `components/qns/screen/QnsHero.tsx`

- [ ] **Step 1: Implement the hero**

`expo-linear-gradient` is already a dependency (used elsewhere in the app). Verify with
`grep -r "expo-linear-gradient" package.json`; if absent, STOP and report (do not add deps
silently).

```tsx
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Skin from '@/theme/skins/geometry';
import { useQnsBrand } from '@/theme/qns';

interface QnsHeroProps {
  title: string;
  subtitle?: string;
  /** Center the text (name-detail hero) vs left-align (register hero). */
  center?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function QnsHero({ title, subtitle, center, style, children }: QnsHeroProps) {
  const qns = useQnsBrand();
  return (
    <LinearGradient
      colors={qns.gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.hero, center && styles.center, style]}
    >
      <Text style={styles.motif}>@</Text>
      <Text style={[styles.title, center && styles.textCenter]}>{title}</Text>
      {subtitle ? (
        <Text style={[styles.subtitle, center && styles.textCenter]}>{subtitle}</Text>
      ) : null}
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  hero: {
    borderRadius: Skin.radius(16),
    padding: Skin.space(16),
    overflow: 'hidden',
    position: 'relative',
  },
  center: { alignItems: 'center' },
  motif: {
    position: 'absolute',
    right: Skin.space(6),
    top: -Skin.space(4),
    fontSize: Skin.font(72),
    fontWeight: '900',
    color: 'rgba(255,255,255,0.15)',
  },
  title: {
    color: '#ffffff',
    fontSize: Skin.font(20),
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  textCenter: { textAlign: 'center' },
  subtitle: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: Skin.font(10),
    marginTop: Skin.space(6),
  },
});

export default QnsHero;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add components/qns/screen/QnsHero.tsx
git commit -m "feat(qns): add QnsHero gradient hero component"
```

**Manual verification:** deferred to Task 5 (first screen that mounts it).

---

## Task 3: QnsGradientButton + QnsTabs

**Files:**
- Create: `components/qns/screen/QnsGradientButton.tsx`
- Create: `components/qns/screen/QnsTabs.tsx`

- [ ] **Step 1: QnsGradientButton**

A gradient-filled primary CTA (purple→pink). Wraps a pressable in a LinearGradient rather
than extending mobile `Button`, to keep the gradient contained.

```tsx
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';
import { useQnsBrand } from '@/theme/qns';

interface QnsGradientButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function QnsGradientButton({
  label, onPress, disabled, loading, size = 'md', fullWidth, style,
}: QnsGradientButtonProps) {
  const qns = useQnsBrand();
  const isDisabled = disabled || loading;
  const pad = size === 'sm'
    ? { paddingVertical: Skin.space(4), paddingHorizontal: Skin.space(11) }
    : { paddingVertical: Skin.space(11), paddingHorizontal: Skin.space(20) };
  const fontSize = size === 'sm' ? Skin.font(8) : Skin.font(12);
  return (
    <TouchableOpacity onPress={onPress} disabled={isDisabled} activeOpacity={0.7}
      style={[fullWidth && styles.full, isDisabled && styles.disabled, style]}>
      <LinearGradient colors={qns.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={[styles.grad, pad, { borderRadius: Skin.radius(size === 'sm' ? 7 : 11) }]}>
        {loading
          ? <ActivityIndicator size="small" color="#fff" />
          : <Text style={[styles.label, { fontSize }]}>{label}</Text>}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  grad: { alignItems: 'center', justifyContent: 'center' },
  label: { color: '#ffffff', fontWeight: '700' },
  full: { width: '100%' },
  disabled: { opacity: 0.5 },
});

export default QnsGradientButton;
```

- [ ] **Step 2: QnsTabs (SegmentedPills wrapper)**

Force the QNS brand as the active-pill color via per-item `accentColor`. `SegmentedPills`
uses `accentColor` for the active tint (verified in `components/ui/SegmentedPills.tsx`).

```tsx
import React from 'react';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import { useQnsBrand } from '@/theme/qns';

export type QnsTabKey = 'register' | 'marketplace' | 'auctions' | 'my-names' | 'offers';

const TAB_LABELS: Record<QnsTabKey, string> = {
  register: 'Register',
  marketplace: 'Marketplace',
  auctions: 'Auctions',
  'my-names': 'My Names',
  offers: 'Offers',
};

const ORDER: QnsTabKey[] = ['register', 'marketplace', 'auctions', 'my-names', 'offers'];

interface QnsTabsProps {
  active: QnsTabKey;
  onChange: (key: QnsTabKey) => void;
}

export function QnsTabs({ active, onChange }: QnsTabsProps) {
  const qns = useQnsBrand();
  const items: SegmentedPillItem[] = ORDER.map((key) => ({
    key,
    label: TAB_LABELS[key],
    accentColor: qns.brand, // forces QNS brand active state regardless of skin
  }));
  return (
    <SegmentedPills
      items={items}
      activeKey={active}
      onChange={(k) => onChange(k as QnsTabKey)}
      variant="tinted"
      scrollable
      centerOnSelect
      itemRole="tab"
      pillShape="rect"
    />
  );
}

export default QnsTabs;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: no new errors. If `SegmentedPillItem` lacks `accentColor`, re-check the import
path — it is defined in `components/ui/SegmentedPills.tsx` (line ~55).

- [ ] **Step 4: Commit**

```bash
git add components/qns/screen/QnsGradientButton.tsx components/qns/screen/QnsTabs.tsx
git commit -m "feat(qns): add QnsGradientButton and QnsTabs primitives"
```

---

## Task 4: QnsScreen shell + route (empty tab bodies)

Gets an end-to-end navigable screen ASAP (vertical slice) before porting logic.

**Files:**
- Create: `components/qns/screen/QnsScreen.tsx`
- Create: `app/qns.tsx`

- [ ] **Step 1: QnsScreen with placeholder tab bodies**

```tsx
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';
import { useQnsBrand } from '@/theme/qns';
import { QnsTabs, type QnsTabKey } from './QnsTabs';

export function QnsScreen() {
  const qns = useQnsBrand();
  const [tab, setTab] = React.useState<QnsTabKey>('register');
  return (
    <View style={[styles.root, { backgroundColor: qns.bg.page }]}>
      <Stack.Screen options={{ headerShown: true, title: 'Quilibrium Names',
        headerStyle: { backgroundColor: qns.bg.page }, headerTintColor: qns.text.primary,
        headerShadowVisible: false }} />
      <View style={styles.tabs}><QnsTabs active={tab} onChange={setTab} /></View>
      <View style={styles.body}>
        {/* Placeholder — replaced by real tabs in Tasks 5-6 and hosts in Task 7 */}
        <Text style={{ color: qns.text.muted }}>{tab}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tabs: { paddingHorizontal: Skin.space(12), paddingTop: Skin.space(6), paddingBottom: Skin.space(10) },
  body: { flex: 1, paddingHorizontal: Skin.space(12) },
});

export default QnsScreen;
```

- [ ] **Step 2: Route wrapper**

Create `app/qns.tsx`:

```tsx
import QnsScreen from '@/components/qns/screen/QnsScreen';

export default function QnsRoute() {
  return <QnsScreen />;
}
```

- [ ] **Step 3: Add a TEMPORARY entry point to reach it**

So the screen is reachable for verification before Task 8 wires the real banner: in
`components/ProfileModal.tsx`, at the top of the Premium tab (just below the Apex card,
around line 1751), add a temporary button. Mark it clearly for removal in Task 8.

```tsx
{/* TEMP: remove in Task 8 — early entry to /qns for verification */}
<TouchableOpacity onPress={() => router.push('/qns')} style={{ padding: 12 }}>
  <Text style={{ color: theme.colors.primary }}>Open Quilibrium Names (temp)</Text>
</TouchableOpacity>
```

Ensure `router` is imported (`import { router } from 'expo-router';`) — check existing
imports first; ProfileModal may already import it.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck` → no new errors.
Run: `yarn lint` → no new errors.

- [ ] **Step 5: In-app verification**

Start dev (`.agents/scripts/dev-start-mobile.ps1` or `-emulator`). Navigate: Account tab →
Premium → tap "Open Quilibrium Names (temp)".
**Verify:**
- Screen pushes with header "Quilibrium Names".
- Tab strip shows Register · Marketplace · Auctions · My Names · Offers, horizontally
  scrollable, active pill in QNS purple/pink.
- Tapping tabs updates the placeholder label.
- Toggle device light/dark (or skin): background + text follow QNS light/dark, NOT the skin
  accent.

- [ ] **Step 6: Commit**

```bash
git add components/qns/screen/QnsScreen.tsx app/qns.tsx components/ProfileModal.tsx
git commit -m "feat(qns): add navigable QNS screen shell with brand tabs"
```

---

## Task 5: Register tab (port claim flow)

Port the claim logic from `ProfileModal` — do NOT rewrite it. The hooks live in
`@/hooks/useQNS`. Reference implementation: `components/ProfileModal.tsx` lines ~1246-1810
(health/countdown), ~1461-1610 (invite code + register), ~1752-1809 (hero + countdown UI).

**Files:**
- Create: `components/qns/screen/QnsRegisterTab.tsx`
- Modify: `components/qns/screen/QnsScreen.tsx` (wire the tab)

- [ ] **Step 1: Build QnsRegisterTab**

Compose the claim flow using the real hooks and QNS components. Structure (exact hooks
named; port the handler bodies verbatim from ProfileModal):

```tsx
import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Skin from '@/theme/skins/geometry';
import { useQnsBrand } from '@/theme/qns';
import { QnsHero } from './QnsHero';
import { QnsGradientButton } from './QnsGradientButton';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import {
  useQNSHealth,
  useCheckNameAvailability,
  usePricing,
  useValidateInviteCode,
  useRedeemInviteCode,
  useRegisterWithPayment,
} from '@/hooks/useQNS';
import { useAuth } from '@/contexts/AuthContext'; // verify path used by ProfileModal

interface QnsRegisterTabProps {
  ownedCount: number;
  onGoToMyNames: () => void;
}

export function QnsRegisterTab({ ownedCount, onGoToMyNames }: QnsRegisterTabProps) {
  const qns = useQnsBrand();
  const { isServiceDown, isLoading: isCheckingHealth } = useQNSHealth();
  // ... port: countdown state, username search + debounce, useCheckNameAvailability,
  //     usePricing tiers, invite-code (useValidateInviteCode + useRedeemInviteCode),
  //     register (useRegisterWithPayment). Copy the handler bodies from ProfileModal
  //     unchanged; only swap theme.colors.* -> qns.* and layout to QNS tokens.
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <QnsHero title="Claim your @username"
        subtitle="Your permanent identity on Q. No renewals, yours forever." />
      {/* username search box, availability banner, pricing tiers grid,
          invite-code dashed box, health/countdown gating, own-N-names nudge */}
      <TouchableOpacity onPress={onGoToMyNames} style={[styles.nudge, { backgroundColor: qns.bg.surface, borderColor: qns.border }]}>
        <View>
          <Text style={{ color: qns.text.primary, fontWeight: '600', fontSize: Skin.font(12) }}>
            You own {ownedCount} names
          </Text>
          <Text style={{ color: qns.text.muted, fontSize: Skin.font(9) }}>Manage, set primary, list for sale</Text>
        </View>
        <IconSymbol name="chevron.right" size={16} color={qns.brand} />
      </TouchableOpacity>
    </ScrollView>
  );
}
```

> **Porting rule:** open `ProfileModal.tsx`, copy each QNS handler (username search
> debounce, `handleRegister`, invite validation/redeem) into this file **byte-for-byte**,
> then change only (a) `theme.colors.X` → `qns.X`, (b) container styles to the QNS token
> table in the design spec. Do not "improve" the logic — this is a move, not a refactor.

- [ ] **Step 2: Wire into QnsScreen**

In `QnsScreen.tsx`, replace the placeholder with a switch. `ownedCount` comes from Task 6's
data; for now pass `0` and a no-op that sets tab to `'my-names'`:

```tsx
{tab === 'register' && (
  <QnsRegisterTab ownedCount={0} onGoToMyNames={() => setTab('my-names')} />
)}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck` → no new errors.
Run: `yarn lint` → clean.

- [ ] **Step 4: In-app verification**

Reload app → QNS screen → Register tab. **Verify:**
- Gradient hero renders (purple→pink), `@` motif visible.
- Username field accepts input; availability check fires (type a known-taken and a free
  name); banner shows available/taken in QNS success/danger.
- Pricing tiers render with correct values.
- Invite-code box validates a code (reuse a code you know, or confirm the network call
  fires in Metro logs).
- If service is down/countdown active, the countdown/health state shows (matches old
  Premium-tab behavior).
- The "You own N names" nudge switches to the My Names tab.

- [ ] **Step 5: Commit**

```bash
git add components/qns/screen/QnsRegisterTab.tsx components/qns/screen/QnsScreen.tsx
git commit -m "feat(qns): add Register tab with ported claim flow"
```

---

## Task 6: My Names tab (port owned/delegated list)

Port from `ProfileModal.tsx` lines ~1359-1954 (owned/delegated/resolvable memos, the
`Your Names` and `Delegated to You` sections, `handleMakeResolvable`, set-primary,
List-on-Marketplace, and the NameDetail/ListName/NamePicker modal wiring).

**Files:**
- Create: `components/qns/screen/QnsMyNamesTab.tsx`
- Modify: `components/qns/screen/QnsScreen.tsx` (wire tab + feed `ownedCount` to Register)

- [ ] **Step 1: Build QnsMyNamesTab**

Use a `FlatList` (not `.map`) because the list can be hundreds long. Port the data memos
(`existingNames`, `delegatedNames`, `resolvableNames`) and handlers verbatim. Add the
filter box + segmented filter (All / Owned / Delegated / Listed) per the design spec.
Reuse existing `NameDetailModal` / `ListNameModal` for row taps (import from
`@/components/qns/NameDetailModal` and `@/components/ListNameModal`).

```tsx
// Signature the screen relies on:
export interface QnsMyNamesTabProps {
  onCountChange?: (n: number) => void; // lets Register show "own N names"
}
export function QnsMyNamesTab({ onCountChange }: QnsMyNamesTabProps) { /* ... */ }
```

Emit the owned count via `onCountChange(existingNames.length)` in an effect so the Register
tab can display it.

- [ ] **Step 2: Wire into QnsScreen + lift ownedCount**

```tsx
const [ownedCount, setOwnedCount] = React.useState(0);
// Render My Names always-mounted OR lift the names query to QnsScreen so the count
// survives tab switches. Simplest: lift the owned-names query into QnsScreen and pass
// data down to both tabs. Choose ONE:
//   (a) lift query to QnsScreen (preferred — single source), or
//   (b) keep query in QnsMyNamesTab + onCountChange, accept count=0 until first visit.
```

Pick **(a)**: move the owned/delegated data hooks into `QnsScreen`, pass `names`/`delegated`
down to `QnsMyNamesTab` as props and `ownedCount` to `QnsRegisterTab`. This keeps the count
correct on first paint.

- [ ] **Step 3: Typecheck + lint** → clean.

- [ ] **Step 4: In-app verification**

Reload → My Names tab. **Verify (use an account that owns ≥1 name):**
- Owned names render; primary badge shows on the primary; Set-as-Primary works.
- Make Resolvable works (or fires the update call).
- Delegated names appear under the Delegated filter.
- List-on-Marketplace opens `ListNameModal`.
- Tapping a name opens `NameDetailModal`.
- Filter box narrows the list; segmented filter switches All/Owned/Delegated/Listed.
- Register tab now shows the correct "You own N names".
- Scroll is smooth with a long list (if you can test on a many-name account).

- [ ] **Step 5: Commit**

```bash
git add components/qns/screen/QnsMyNamesTab.tsx components/qns/screen/QnsScreen.tsx
git commit -m "feat(qns): add My Names tab with owned/delegated list and filters"
```

---

## Task 7: Host existing Marketplace / Auctions / Offers as-is

Phase-1 goal: the three heavyweight surfaces work inside the tabs **without** re-skinning.
They are currently `BaseModal`-based (`visible`/`onClose`). Host their *bodies* inline.

**Files:**
- Modify: `components/qns/screen/QnsScreen.tsx`
- Possibly modify: `components/qns/MarketplaceModal.tsx` / `AuctionsModal.tsx` /
  `OffersModal.tsx` — extract the inner content so it can render without the modal chrome.

- [ ] **Step 1: Decide hosting strategy per surface**

Inspect each modal (`MarketplaceModal`, `AuctionsModal`, `OffersModal`). Two options:
  - **(a) Render inline body:** if the component's body is separable, export an inner
    `MarketplaceBody` and render it in the tab. Cleanest.
  - **(b) Always-visible modal:** render `<MarketplaceModal visible={tab==='marketplace'} onClose={()=>setTab('register')} />`. Fast but stacks a modal inside a screen — acceptable
    on Android; on iOS validate it doesn't misbehave (memory note: iOS handles stacked RN
    Modals unreliably).

Prefer **(a)** where the body separates cleanly; fall back to **(b)** otherwise. Document
which you chose in a code comment.

- [ ] **Step 2: Wire the three tabs**

```tsx
{tab === 'marketplace' && <MarketplaceBody onPickListing={...} />}
{tab === 'auctions' && <AuctionsBody />}
{tab === 'offers' && <OffersBody />}
```

Preserve existing purchase/bid/offer callbacks (e.g. `onPurchaseSuccess`).

- [ ] **Step 3: Typecheck + lint** → clean.

- [ ] **Step 4: In-app verification**

Reload. **Verify each tab:**
- Marketplace lists listings; search + sort work; tapping opens Buy flow.
- Auctions lists auctions; Place-bid flow opens.
- Offers shows received/sent; Accept/Decline present.
- These still look **Quorum-themed** (expected in Phase 1 — re-skin is Phase 2).

- [ ] **Step 5: Commit**

```bash
git add components/qns/screen/QnsScreen.tsx components/qns/MarketplaceModal.tsx components/qns/AuctionsModal.tsx components/qns/OffersModal.tsx
git commit -m "feat(qns): host marketplace/auctions/offers inside QNS screen tabs"
```

---

## Task 8: Reduce Premium tab to Apex + QNS banner; remove moved code

**Files:**
- Modify: `components/ProfileModal.tsx`
- Modify: `components/UnifiedProfileScreen.tsx` (drop now-dead marketplace modal wiring)

- [ ] **Step 1: Replace the Premium-tab QNS block with a banner**

In `ProfileModal.tsx`, delete the QNS block (banner + countdown + Your Names + Marketplace/
Auctions/Offers buttons + Delegated + Invite Code — roughly lines 1752-2010, verify exact
bounds) and the TEMP button from Task 4. Keep the Apex card (`ApexSectionCard`, ~line 1745).
Insert a QNS entry banner:

```tsx
{/* QNS entry — full experience lives on /qns */}
<TouchableOpacity onPress={() => router.push('/qns')} activeOpacity={0.85}>
  <LinearGradient colors={['#6330CA', '#FF056D']} start={{x:0,y:0}} end={{x:1,y:1}}
    style={styles.qnsBanner}>
    <QnsIcon size={28} color="#fff" />
    <Text style={styles.qnsBannerTitle}>Claim your @username</Text>
    <Text style={styles.qnsBannerSubtitle}>
      Secure a permanent identity on the Quilibrium network. Browse, bid, and manage your names.
    </Text>
  </LinearGradient>
</TouchableOpacity>
```

Add `qnsBanner*` styles (radius `Skin.radius(16)`, padding `Skin.space(16)`, white text).
The banner is intentionally QNS-branded even inside the Quorum-themed tab.

- [ ] **Step 2: Remove now-unused QNS state/hooks/imports from ProfileModal**

Delete the QNS-only imports (`useCheckNameAvailability`, `usePricing`, `useValidateInviteCode`,
`useRedeemInviteCode`, `useRegisterWithPayment`, `useUpdateResolveKey`, `useGetResaleListingByName`,
`useBucketLookup`, `useReverseLookup`, `useResolveName`, `useQNSHealth`), the countdown
state/effect, the owned/delegated/resolvable memos, `handleMakeResolvable`, invite state,
and the NameDetail/ListName/NamePicker state that moved. **Keep** anything still used by
non-QNS parts of ProfileModal (e.g. `updateProfile`, `useAuth`). Let typecheck find the
unused ones: after deletion, `tsc` will flag any leftover references — fix until clean.

- [ ] **Step 3: Clean UnifiedProfileScreen**

Remove `marketplaceModalVisible`/`auctionsModalVisible`/`offersModalVisible` state and the
`onOpenMarketplace/onOpenAuctions/onOpenOffers` props + the modal instances it rendered for
ProfileModal, now that they live on `/qns`. Verify ProfileModal no longer requires those
props (make them optional or remove from its interface).

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck` → **zero** errors (this is the gate
that proves all moved code is accounted for).
Run: `yarn lint` → clean.

- [ ] **Step 5: In-app verification**

Reload. **Verify:**
- Premium tab now shows ONLY the Apex card + the QNS gradient banner. No leftover Your
  Names / Marketplace buttons / Invite code inline.
- Tapping the banner pushes `/qns`.
- Everything that used to work in the Premium tab now works on the QNS screen (spot-check
  claim + a name action).
- No dead "temp" button remains.

- [ ] **Step 6: Commit**

```bash
git add components/ProfileModal.tsx components/UnifiedProfileScreen.tsx
git commit -m "feat(qns): reduce Premium tab to Apex + QNS banner, move QNS to /qns"
```

**End of Phase 1 — the feature is shippable here.** The QNS screen is fully branded for
Register + My Names; the three marketplace surfaces work but are still Quorum-themed.

---

# PHASE 2 — Re-skin marketplace surfaces to QNS brand

Each task is one surface, independently verifiable. Pattern for all: replace
`const { theme } = useTheme()` color reads with `const qns = useQnsBrand()` and map tokens
per the design spec's element tables. Keep `Skin.*` metrics. Keep `getChainColor()` as-is.

## Task 9: Re-skin MarketplaceModal / body

**Files:** Modify `components/qns/MarketplaceModal.tsx` (+ `BuyNameModal.tsx` if it shows on this surface).

- [ ] **Step 1:** Swap theme color reads for `useQnsBrand()` in the styles factory
  (`createStyles(theme,...)` → pass/consume `qns`). Map: surface bg → `qns.bg.surface`,
  text → `qns.text.primary`/`qns.text.muted`, borders → `qns.border`, primary/Buy action →
  QNS gradient (use `QnsGradientButton` for the Buy CTA), chain badge unchanged.
- [ ] **Step 2:** Typecheck + lint → clean.
- [ ] **Step 3:** In-app: Marketplace tab now renders in QNS purple/pink; listing rows,
  search, sort, and Buy match the design spec; light/dark follows base, not skin.
- [ ] **Step 4:** Commit `style(qns): re-skin Marketplace to QNS brand`.

## Task 10: Re-skin AuctionsModal / body (compact rows)

**Files:** Modify `components/qns/AuctionsModal.tsx`.

- [ ] **Step 1:** Re-skin to QNS tokens AND compact the auction cards to Marketplace row
  density per Decision 9: one row = name + `LIVE` badge (accent-tint) on top; meta line
  "Bid {amount} · {countdown}" with countdown in `qns.accent`; Bid via `QnsGradientButton`
  size `sm` on the right. Filter (Live/Ending soon/Ended) uses the segmented filter token.
- [ ] **Step 2:** Typecheck + lint → clean.
- [ ] **Step 3:** In-app: auctions render as compact rows matching Marketplace height;
  countdown updates; Place-bid works; QNS-branded.
- [ ] **Step 4:** Commit `style(qns): re-skin Auctions to QNS brand with compact rows`.

## Task 11: Re-skin OffersModal / body

**Files:** Modify `components/qns/OffersModal.tsx` (+ `MakeOfferModal.tsx`).

- [ ] **Step 1:** Re-skin to QNS tokens: Received/Sent segmented filter, offer rows (name +
  "Offer from @x", amount in `qns.brand`), Accept (success-tint) / Decline (danger-tint).
- [ ] **Step 2:** Typecheck + lint → clean.
- [ ] **Step 3:** In-app: Offers render QNS-branded; Received/Sent toggle; Accept/Decline
  present and wired.
- [ ] **Step 4:** Commit `style(qns): re-skin Offers to QNS brand`.

## Task 12: Re-skin NameDetailModal

**Files:** Modify `components/qns/NameDetailModal.tsx`.

- [ ] **Step 1:** Re-skin: use `QnsHero center` for the name header (big `@name`, status
  badge), metadata rows in QNS tokens, actions = `QnsGradientButton` (Buy) + mobile `Button`
  `variant="outline" color={qns.brand}` (Make offer) or Set-primary/List when owned.
- [ ] **Step 2:** Typecheck + lint → clean.
- [ ] **Step 3:** In-app: open a name from any list → detail is QNS-branded; actions work.
- [ ] **Step 4:** Commit `style(qns): re-skin NameDetail to QNS brand`.

## Task 13: Final pass + PR

- [ ] **Step 1:** Full typecheck `npx tsc --noEmit --jsx react-jsx --skipLibCheck` → zero
  errors. `yarn lint` → clean.
- [ ] **Step 2:** Full walkthrough on a real device (both light and dark, and at least one
  non-default skin) confirming every screen matches the design spec and the skin override
  holds (only light/dark changes the QNS screen).
- [ ] **Step 3:** Optional: build a `.preview` release via
  `.agents/scripts/build-prod-variant.ps1` to confirm no dev-only glitches (per project
  memory, some timing/gradient artifacts are dev-only).
- [ ] **Step 4:** Push branch, open ONE PR (squash-merge). PR title/body self-explanatory,
  no internal jargon. Do NOT delete the local branch on merge; delete only the remote.

---

## Self-Review (against the design spec)

**Spec coverage:**
- Full QNS brand + skin override → Task 1 (`useQnsBrand`), enforced across all tasks. ✓
- Light/dark follows base → `useQnsBrand` reads `isDark`. ✓
- Route `app/qns.tsx` + `router.push('/qns')` → Task 4, Task 8. ✓
- Tabs Register/Marketplace/Auctions/My Names/Offers (site vocabulary) → Task 3 `QnsTabs`. ✓
- Register = claim + search + tiers + invite + health + own-N nudge → Task 5. ✓
- My Names own screen, scales to hundreds (FlatList), filter + delegated → Task 6. ✓
- Host existing surfaces as-is (Phase 1) → Task 7. ✓
- Premium tab → Apex + QNS banner, remove moved code → Task 8. ✓
- Re-skin marketplace/auctions/offers/detail (Phase 2) → Tasks 9-12. ✓
- Auctions compact (Decision 9) → Task 10. ✓
- Build on mobile components + QNS tokens, no shared-primitive dependency (Decision 8) →
  all tasks use mobile `Button`/`SegmentedPills`/`SkinTouchable`/`IconSymbol`. ✓
- UI element spec (hero/button/tabs/row/badge tokens) → Tasks 2-3 build the reusable
  elements; per-screen tasks apply them. ✓

**Placeholder scan:** Logic-heavy tasks (5, 6, 7) intentionally say "port verbatim from
ProfileModal lines X-Y" rather than reproducing ~500 lines of existing, working code inline
— this is a MOVE of known-good code, and re-typing it would risk transcription bugs. The
exact source line ranges and hook names are given so the port is mechanical. This is a
deliberate exception to "repeat the code", justified because the code already exists in the
repo and must be moved unchanged.

**Type consistency:** `QnsTabKey`, `useQnsBrand`/`QnsBrand`, `QnsHero`, `QnsGradientButton`,
`QnsTabs`, `QnsRegisterTab`, `QnsMyNamesTab`, `QnsScreen` names are used consistently across
tasks. `onGoToMyNames`/`onCountChange`/`ownedCount` prop names match between Task 5 and 6.

**Known risk flagged for the implementer:** Task 7 hosting strategy (inline body vs
always-visible modal) depends on how separable each modal's body is — the task tells the
implementer to inspect and choose per surface, with the iOS stacked-modal caveat noted.

---
*Last updated: 2026-07-16*
