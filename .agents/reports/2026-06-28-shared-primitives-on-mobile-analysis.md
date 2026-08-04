---
type: report
title: "Should mobile adopt quorum-shared UI primitives? (analysis + decision direction)"
status: discussion-captured
created: 2026-06-28
related-task-desktop: ../../../quorum-desktop/.agents/tasks/port-from-mobile/2026-06-11-port-skins-phase-0-1.md
related-task-mobile: ../issues/.deferred/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md
related-doc-desktop: ../../../quorum-desktop/.agents/docs/features/primitives/
---

# Should mobile adopt quorum-shared UI primitives?

Captures a design discussion (LaMat + agent, 2026-06-28) about whether quorum-mobile should
consume the UI primitives in `@quilibrium/quorum-shared` instead of its own local
`components/ui/` layer. **No code was written. This is the reasoning + the decided direction**
so the conclusion isn't re-derived from scratch next time.

> **One-line answer:** Yes, eventually — mobile's UI components should become the `.native.tsx`
> half of the shared primitives — **but it is strictly downstream of the skins-to-desktop port,
> and it must happen once, coherently, in quorum-shared (not via temporary mobile-side wrappers).**
> This mirrors the decision already made for IconSymbol.

---

## 1. The situation today (verified 2026-06-28)

- Mobile depends on `@quilibrium/quorum-shared@2.1.0-33`.
- Mobile imports a **lot** from shared — but **zero UI rendering primitives.** Everything it
  imports is data/logic: `logger`, types, hooks (`useSendMessage`, `useSpaces`…), permission
  helpers (`hasPermission`), `formatAddress`, `queryKeys`, validators, the avatar
  initials/colour math, the icon vocabulary constants. **No `Button`, `Modal`, `Input`, `Flex`,
  `Text`, `Switch`, etc. from shared.**
- Mobile has its **own mature UI layer**: `components/ui/` (Button, Avatar, Card, EmptyState,
  Toast, SegmentedPills, IconSymbol…) and `components/shared/` (BaseModal, CenterModal,
  ActionSheet, ConfirmDialog, ActionRow…), styled with **React Native StyleSheet + a local
  `useTheme()`** (used in ~108 files). No NativeWind/Tailwind.
- Mobile has a **skin system** (`theme/skins/`: geometry scaling, surface-image overlays,
  per-variant overrides) that quorum-shared does **not** have. The local `Button` is
  skin-aware: it reads `useSurface('button.${variant}')` and sizes via `Skin.space()`.

So today the value of "shared" for mobile is entirely the **data layer** (types + sync + hooks +
crypto) — which is the part that must agree byte-for-byte so a message from mobile shows up on
desktop. UI primitives are a **separate, currently-unused** offering.

## 2. What a "shared primitive" actually is (important — avoids a recurring confusion)

A shared primitive is **never one component running on both platforms.** It is a `.native.tsx`
and a `.web.tsx` sitting side-by-side; the bundler picks one (Metro → `.native.tsx`,
Vite → `.web.tsx`). They share only a **`types.ts` contract** and an **import path**
(`import { Button } from '@quilibrium/quorum-shared'`). The actual RN-vs-DOM rendering code
stays separate. You cannot share render code across native and web except in rare cases.

Therefore **"adopt the shared Button on mobile" = "take today's
`components/ui/Button.tsx` (that exact RN code, skins and all) and relocate it into
`quorum-shared/.../Button.native.tsx`, nearly unchanged."** It is a _promotion/relocation_,
not a rewrite into something weaker. Mobile then imports Button from shared instead of `@/`.
Desktop's `Button.web.tsx` is a separate file mobile never touches.

This dissolves the first-pass objection ("you'd lose the skin system"): the skin code travels
**with** the native file into shared. Nothing is lost.

## 3. Why this is downstream of skins, not parallel to it

The skins-to-desktop port (`quorum-desktop/.agents/tasks/port-from-mobile/2026-06-11-port-skins-phase-0-1.md`)
is **committed in direction**: skins become a cross-platform, shared system; desktop will consume
them; eventual full parity incl. geometry. That is what makes shared primitives make sense — the
thing that made mobile's Button "richer" (skin awareness) becomes a **shared capability**, so a
shared skin-aware Button can deliver skins to _both_ apps instead of each app re-implementing
"how a button responds to a skin."

But primitives can't move until the **skin runtime** they call lives in shared. Note the asymmetry:

| Axis                                 | Desktop primitive work   | Why                                                                                                                                                          |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Colour / font / accent**           | **None**                 | Desktop primitives are dumb (`<button className="btn-primary">`); colour lives in CSS vars. SkinService rewrites `--accent-500` → button recolours for free. |
| **Geometry (radii/spacing/borders)** | **Real, but mechanical** | Hardcoded `border-radius: 6px` etc. in SCSS must become `var(--radius-md)`. This is skins-port **Phase 2**, landmines already pre-located.                   |

Desktop is skin-ready on colour **because it has CSS** — an ambient styling layer to mutate.
**Mobile has no CSS.** RN styling lives _inside_ the component (`StyleSheet.create`), so mobile's
skin-awareness is _baked into the component code_ (the `useSurface` / `Skin.space` calls). That
code is already written and correct.

**The real blocker for moving mobile primitives to shared is therefore NOT the primitives — it is
their runtime dependency.** A `Button.native.tsx` living in shared can't `import` from
`quorum-mobile/theme/skins/`. So the skin **runtime** (the `radius()`/`space()` singletons and
`useSurface`) must be reachable from inside shared, AND shared's theme context must carry the
active skin. Today:

- Phase 0 of the skins port promotes only the **pure engine** (types, `validate`, `deriveGeometry`,
  samples) and **explicitly keeps `radius()`/`space()` per-app.**
- Shared's `ThemeProvider` is a flat `{ colors, getColor }` with **no skin field.** Mobile's
  provider is the full ~2000-LOC skin engine (fonts, geometry, skin-reactive styles), consumed by
  158 files. (Swapping mobile onto shared's provider was considered and **rejected** — it would
  delete the skin feature and rewrite 158 call sites. See the IconSymbol task's Out-of-scope.)

So the **missing layer** that no current task owns: a **shared cross-platform skin runtime** —
shared's theme context gains an `activeSkin`, and the geometry/surface runtime becomes a shared
module with native + web implementations behind one interface. Until that exists, a shared
skin-aware native primitive has nothing uniform to call.

## 4. Precedent: this is exactly the IconSymbol decision

`../issues/.deferred/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md` is a worked instance of the
same question (move a mobile component → its shared `.native.tsx` sibling). The decided plan there
is the template for Button and every other primitive:

- **Phase 1 (done):** fix the immediate problem locally without touching call sites.
- **Mobile-side wrapper as a half-step: REJECTED** (LaMat, 2026-06-14): _"I don't want to build
  anything that is too temporary."_ A wrapper would be guaranteed throwaway once skins reach shared.
- **Plan of record: do nothing further on mobile now.** The real migration happens **once,
  coherently, in quorum-shared at skins-port Phase 4** — add the skin branch to shared's
  `Icon.native.tsx`, **plumb `activeSkin` into shared's theme context**, republish + bump, then
  sweep call sites and delete the local shim.

That "plumb `activeSkin` into shared's theme context" line **is** the missing-runtime gap from §3,
already named in a shipped decision. Button/Modal/Input/etc. follow the identical shape.

## 5. The consistency problem — separate from the move, and partly worth doing now

A genuine finding, independent of the shared question: mobile has a perfectly good local `Button`,
but it's used in only **~10–12 call sites**, while there are **~1,400 ad-hoc
`TouchableOpacity`/`Pressable` call sites.** The button story is inconsistent **today.**

Key insight for "should we fix this now, or does the future primitive system make it pointless?":
**moving Button to shared does nothing for those 1,400 call sites.** They bypass the canonical
Button today; after the move they'd bypass the _shared_ canonical Button. The inconsistency is
**orthogonal to where the Button file lives.** So the fixes split cleanly:

**Category A — wasted by the future move (DON'T do now):**

- Renaming mobile's Button API to match desktop (`variant`→`type`, `onPress` semantics,
  `sm`→`small`). The shared `types.ts` contract forces this reconciliation anyway; doing it twice
  is waste.
- Polishing the local Button's internal styling architecture. It's relocating — polish once it
  lands in shared.

**Category B — never wasted, and is literally the prerequisite that makes the move cheap
(worth doing now / anytime):**

- **Routing the worst ad-hoc touchables through the canonical `Button` / `ActionRow` /
  `SkinTouchable`.** Every converted call site "just works" when the canonical component later
  moves to shared (it imports _the Button_, wherever it lives). This improves consistency **today**
  regardless of whether the shared move ever happens, and shrinks the surface the future migration
  must sweep. A messy 1,400-touchable codebase makes the shared move _harder_ (you'd be promoting a
  component almost nobody uses); the sweep is what gives the shared primitive something to land on.
- Killing duplicate/drifted colour literals that should be theme tokens. The theme/skin engine
  wants exactly that; survives the move.

**Recommendation on the fixes:** treat Category B as ordinary, low-risk consistency hygiene that
can proceed independently of the skins/primitives timeline (batch small fixes per the
one-branch-one-PR rule). Do **not** start Category A — let the shared `types.ts` contract drive it
when the primitive actually moves.

## 6. Decision direction (captured, not yet a task)

1. **End-state:** mobile's UI components become the `.native.tsx` half of shared primitives;
   `components/ui` versions collapse to re-exports or are deleted. Architecturally sound, and
   consistent with the IconSymbol precedent.
2. **Hard prerequisite (no task owns this yet):** a **shared cross-platform skin runtime** —
   `activeSkin` in shared's theme context + geometry/surface runtime promoted to shared with
   native + web impls behind one interface. This is the gating dependency; it slots **between**
   skins-port Phase 0 (pure engine, done-ish) and any primitives move.
3. **Do it once, in shared, at skins-port Phase 4.** No temporary mobile wrappers (per the
   IconSymbol ruling). When the runtime exists: promote `Button.native.tsx` (≈ today's mobile
   Button) into shared next to `Button.web.tsx`, reconcile `types.ts`, republish + bump, sweep
   mobile imports, delete the local copy. Repeat per primitive, ordered by value (Button first).
4. **Meanwhile (optional, independent):** Category-B consistency sweep — route ad-hoc touchables
   through the canonical local Button/ActionRow. Never wasted; makes step 3 cheaper.

## 7. Open items this surfaces

- **No task owns the "shared skin runtime" layer** (§3). It's implied by skins-port Phase 4 and by
  the IconSymbol plan ("plumb `activeSkin` into shared's theme context") but isn't scoped on its
  own. It is the true blocker for primitives-in-shared and probably deserves its own task once
  skins-port Phase 1 lands.
- Whether desktop's primitives need geometry var-ification before _or_ in lockstep with mobile's
  primitive move (skins-port Phase 2 vs Phase 4 ordering) — a sequencing question for the
  skins-port owner, not for mobile.

---

_Last updated: 2026-06-28_
