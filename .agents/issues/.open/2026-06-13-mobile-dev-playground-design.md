---
type: task
title: "Mobile dev playground for primitives + interactions (design)"
status: open
created: 2026-06-13
runtime-test: n/a
priority: low
related:
  - .agents/issues/.done/2026-06-13-destructive-operations-confirmation-standard.md
  - .agents/docs/quorum-shared-architecture.md
---

# Mobile dev playground for primitives + interactions

## Goal

A dev-only screen inside the mobile app to **test primitives and the interactions we're
building** (confirmation dialog, type-to-confirm modal, hold-to-confirm, action sheets,
toasts) — render the real component in the real provider tree and watch it behave. The
immediate driver is the destructive-operations confirmation work (see related task): we
want a live workbench to build and eyeball `TypeToConfirmModal` / `ConfirmDialog` as the
skin styles get written.

This is the mobile counterpart to desktop's `src/dev/primitives-playground`, scaled down
to what mobile actually needs.

## Decisions taken (user, 2026-06-13)

1. **Scope = primitives + interaction testing**, "a little more than just primitives" — but
   NOT the full desktop `/dev` suite (no docs viewer / audit / dependency map / DB inspector
   in this task). Trigger real flows and watch them; build skins against a live preview.
2. **No live prop-control panel.** The desktop `InteractivePropsPanel` (dropdowns/toggles that
   mutate props in real time) is **not wanted**. A few hardcoded example variants per
   component is enough. This removes Storybook's one structural advantage for our use case.
3. **No Storybook.** Storybook for React Native runs as a *separate app entry point* (swap the
   app root via env var) and adds Metro/build config surface — not worth it on top of the
   existing Windows / accented-username native-build pain, especially since the live-controls
   feature (its main draw) isn't needed and stories model state-isolation, not tap→arm→confirm
   *interaction* flows.
4. **Hand-rolled `__DEV__`-gated expo-router route** — the chosen approach. Mirrors the desktop
   mental model (a gated dev page you navigate to in the running app), no new dependencies.

## Approaches considered

| Approach | Verdict | Why |
|---|---|---|
| **(a) Storybook for React Native** | Rejected | Separate entry point + build config; headline feature (live controls) not needed; awkward for interaction flows. High cost, low marginal value here. |
| **(b) Hand-rolled `__DEV__` dev route** | **Chosen** | expo-router makes a screen just a file; renders in the real provider tree (authentic skins/theme/fonts); interaction testing is natural (a button opens the real flow); zero new deps; mirrors desktop. |
| **(c) Hybrid (Storybook + dev route)** | Rejected | Two systems for one need. |

## Architecture

### Structure & routing

```
app/(dev)/
  _layout.tsx        # Stack layout; <Redirect href="/" /> when !__DEV__
  index.tsx          # Dev hub — scrollable list linking to catalog screens
  playground.tsx     # Primitives + interaction catalog (main screen)
components/dev/
  DevSection.tsx     # Labeled section wrapper (title + description + children)
  DevRow.tsx         # Labeled trigger row: "danger variant  → [Open]"
  demos/
    ConfirmDialogDemo.tsx
    TypeToConfirmDemo.tsx
    ActionSheetDemo.tsx
    HoldToConfirmDemo.tsx
    ToastDemo.tsx
    ...one file per primitive / interaction
```

- **Gating:** `if (!__DEV__) return <Redirect href="/" />` in `(dev)/_layout.tsx`. `__DEV__`
  is `false` and dead-code-eliminated in release bundles — the route never ships. This is the
  same guarantee as desktop's `process.env.NODE_ENV === 'development'` gate on `/dev`/`/playground`.
- **Reaching it:** a `__DEV__`-only "Dev Playground" row in Settings →
  `router.push('/(dev)')`. The deep link (`<scheme>://(dev)/playground`) also works.
- **Catalog model, not knobs:** each primitive/interaction = a `DevSection` with a few
  hardcoded `DevRow` triggers (danger / warning / long-text / each keyword), each opening the
  **real** flow. No `InteractivePropsPanel` equivalent (per decision 2).

### Demo pattern

Each demo is a self-contained component that owns its own `visible` state and renders the
**real** primitive — never a copy. The playground imports the actual shipping component, so
what you see is what ships.

```tsx
// components/dev/demos/TypeToConfirmDemo.tsx
export function TypeToConfirmDemo() {
  const [open, setOpen] = useState<null | 'delete' | 'reset'>(null);
  return (
    <DevSection title="TypeToConfirmModal" description="T3 / Delete Space — keyword gate">
      <DevRow label="keyword: delete (Delete Space)" onPress={() => setOpen('delete')} />
      <DevRow label="keyword: reset (Reset App Data)" onPress={() => setOpen('reset')} />
      <TypeToConfirmModal
        visible={open !== null}
        keyword={open ?? 'delete'}
        title={open === 'reset' ? 'Reset App Data' : 'Delete Space'}
        stats={open === 'delete' ? { channels: 4, members: 12 } : undefined}
        onConfirm={() => { console.log('confirmed'); setOpen(null); }}
        onCancel={() => setOpen(null)}
      />
    </DevSection>
  );
}
```

Rules that keep it honest and cheap:
- **Real component, real provider tree.** Rendered under the app's existing `_layout.tsx`
  providers → authentic skins/theme/fonts/haptics. (This is exactly what a Storybook separate
  entry point would make harder.)
- **`onConfirm` is a no-op / `console.log`.** Demos never fire real crypto / WS / delete paths.
  Stub the action, exercise the UI.
- **One file per primitive/interaction**, registered in `playground.tsx`'s list. Adding a
  primitive = add a file + one line. Grows linearly; no central machinery.
- **A demo can wrap an unstyled primitive.** Most mobile skin styles aren't built yet, so a
  demo doubles as the **workbench where you build the skin** — iterate on the real component
  with the demo as the live preview.

## Build sequence

1. `app/(dev)/_layout.tsx` (gate) + `index.tsx` (hub) + `playground.tsx` (catalog shell).
2. `components/dev/DevSection.tsx` + `DevRow.tsx` (the two layout primitives).
3. `__DEV__`-only entry row in Settings → `router.push('/(dev)')`.
4. First demos for the **confirmation work** (immediate need): `ConfirmDialogDemo`,
   `TypeToConfirmDemo`. These become the live workbench for the confirmation-standard
   implementation in the other session.
5. Backfill demos for existing primitives opportunistically (`ActionSheet`, `Toast`,
   `HoldToConfirm`) — no big-bang; add as they're touched.

## Out of scope (YAGNI)

- Live prop-control panel (desktop `InteractivePropsPanel`).
- Docs / tasks / bugs viewer, component audit, dependency map (desktop `/dev` extras).
- MMKV/DB inspector — **but** the `(dev)` route group is structured so a future inspector
  could be added as a sibling screen (`app/(dev)/mmkv.tsx`) without rework. Not built now.
- Storybook, and any second app entry point.

## Notes for the executor

- expo-router file-based routing: `(dev)` is a route group (parentheses = no URL segment).
  The gate lives in its `_layout.tsx` so every screen under it inherits the `!__DEV__`
  redirect.
- Verify `__DEV__` dead-code elimination assumption holds in the release bundle (it's standard
  RN behavior; confirm the `(dev)` screens don't appear in a production build's reachable
  routes).
- Demos import the **real** components from `@/components/...`; never duplicate component code
  into the demo. The demo only owns trigger state + stubbed callbacks.
- `.agents/` is gitignored — this doc and the task are local-only; branch/PR text for the
  eventual implementation must be self-explanatory (no internal jargon).
- Reference for the desktop pattern (do NOT port wholesale, just borrow structure):
  `quorum-desktop/src/dev/primitives-playground/` and `quorum-desktop/src/dev/README.md`.

---
*Last updated: 2026-06-13*
</content>
