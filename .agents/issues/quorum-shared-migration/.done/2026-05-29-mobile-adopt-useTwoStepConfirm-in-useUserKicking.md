---
type: task
title: "Mobile adoption: useTwoStepConfirm in useUserKicking"
status: in-progress
created: 2026-05-29
closed: 2026-06-14
superseded-by: .agents/issues/.done/2026-06-13-destructive-operations-confirmation-standard.md
triggered-by:
  shared-pr: QuilibriumNetwork/quorum-shared#19 (useTwoStepConfirm, 2.1.0-18)
  desktop-pr: QuilibriumNetwork/quorum-desktop#161
runtime-test: required
priority: medium
---

> **⛔ SUPERSEDED — DO NOT IMPLEMENT (closed 2026-06-14).**
> Reviewing this task is what triggered the [destructive-operations confirmation standard](../../.done/2026-06-13-destructive-operations-confirmation-standard.md), which decided to **eliminate double-tap / two-step confirm on mobile** (two taps on the same coordinate is the weakest fat-finger guard — a thumb double-taps accidentally far more easily than a mouse double-clicks). Adopting `useTwoStepConfirm` here would add the exact pattern the standard removes. Kick User is reframed there as a single-confirm dialog (T2), not two-step. User confirmed 2026-06-14; see `quorum-shared-migration/STATUS.md` row for this file. Kept for provenance; the implementation below is no longer the plan.

# Mobile adoption: useTwoStepConfirm in useUserKicking

## What shipped on shared + desktop

`useTwoStepConfirm` is exported from `@quilibrium/quorum-shared` since `2.1.0-18`.
Desktop's `useUserKicking` and `useSpaceLeaving` already consume it.
See [desktop shipped-log entry 2026-05-28](../../../../quorum-desktop/.agents/tasks/quorum-shared-migration/shipped-log.md).

Shared exports:

```ts
const { confirmationStep, armOrConfirm, resetConfirmation } = useTwoStepConfirm({
  timeoutMs?: number;  // defaults to 5000
});
// confirmationStep: 0 | 1
// armOrConfirm: (onConfirm: () => void | Promise<void>) => void
// resetConfirmation: () => void
```

The implementation uses `useRef` for the timeout handle (avoids re-renders) and an
unmount cleanup effect — a minor correctness improvement over the inlined pattern
mobile currently uses (which stores timeout in `useState`).

## Concrete mobile file

`hooks/chat/useUserKicking.ts`

## Shape of change

1. Add import:

   ```ts
   import { useTwoStepConfirm } from '@quilibrium/quorum-shared';
   ```

2. Remove (origin/master lines roughly 31-33, 43-50):
   - `const [confirmationStep, setConfirmationStep] = useState(0);`
   - `const [confirmationTimeout, setConfirmationTimeout] = useState<...>(null);`
   - the `useEffect` cleanup block that clears `confirmationTimeout` on unmount.

3. Replace with:

   ```ts
   const { confirmationStep, armOrConfirm, resetConfirmation } = useTwoStepConfirm();
   ```

4. Rewrite `handleKickClick` (origin/master lines roughly 103-121) to use `armOrConfirm`:

   ```ts
   const handleKickClick = useCallback(
     (userAddress: string, onSuccess?: () => void) => {
       armOrConfirm(() => kickUserFromSpace(userAddress, onSuccess));
     },
     [armOrConfirm, kickUserFromSpace],
   );
   ```

5. Remove the manual `resetConfirmation` implementation (origin/master lines roughly 128-135);
   expose the one from `useTwoStepConfirm` directly.

6. Bump `@quilibrium/quorum-shared` to `^2.1.0-18` (or the latest published version)
   in mobile's `package.json` if not already there. Run `yarn install`.

The public return shape `{ kicking, confirmationStep, handleKickClick, kickUserFromSpace, resetConfirmation }`
is **unchanged**. No call sites change.

## Static-analysis verification gates

- [ ] `yarn tsc --noEmit` passes (no broken imports, no `confirmationTimeout` leftovers)
- [ ] `yarn lint` passes
- [ ] `grep -rn "confirmationTimeout" hooks/` returns zero results (in case other hooks reference it)
- [ ] `grep -rn "useUserKicking" .` shows all consumers still pass the same params and read the same return shape

## Runtime test requirements

**Required.** `handleKickClick` is a live code path that calls `kickUserService` (full
crypto + WS sequence). The two-step arm-then-confirm flow must be manually exercised
in the Expo app:

1. Open a space where the current user has kick permission.
2. Tap "kick" on a member → button should enter "armed" state (visual feedback).
3. Tap again within 5 seconds → kick should fire (member removed, WS envelope sent).
4. Repeat: tap once, wait >5 seconds → state should reset to idle without firing the kick.
5. Repeat: tap once, then navigate away or call `resetConfirmation` → state should cancel cleanly without firing.

If the UI doesn't expose a "armed" visual state today, smoke-test (3) and (4) at minimum
and confirm the kick fires exactly once with two taps within 5s.

## Pre-filled mobile PR description

```markdown
## What
Replace inlined two-step confirmation state machine in `useUserKicking` with shared `useTwoStepConfirm`.

## Cross-repo migration
This is part of a multi-repo change:
- **quorum-shared**: ✅ MERGED — QuilibriumNetwork/quorum-shared#19 (version 2.1.0-18)
- **quorum-desktop**: ✅ MERGED — QuilibriumNetwork/quorum-desktop#161
- **quorum-mobile**: THIS PR

## Why
Desktop adopted `useTwoStepConfirm` in the same PR-set. Mobile's `useUserKicking`
still inlines the identical ~25-line state machine. This PR removes the duplication.
The public API of `useUserKicking` is unchanged — all call sites unaffected.

Minor implementation improvement: shared's version uses `useRef` for the timeout
handle (no re-render on arm/cancel) and has an unmount cleanup effect; mobile's
inlined version stores the timeout in `useState`.

## Why this is safe to merge whenever
Mobile has been on `2.1.0-18` or older the whole time. Bumping shared is the only
version change; the hook's behaviour is identical to the inlined version it replaces.
No production users affected by merge timing.

## Verification
- [ ] `yarn tsc --noEmit` passes
- [ ] `yarn lint` passes
- [ ] Manual QA: arm-then-confirm within 5s fires kick; arm-then-wait resets; arm-then-reset cancels.
```

## Notes for the executor

- Mobile's `services/offline/mutationQueue.ts` is unrelated; this task does NOT touch the kick implementation (`kickUserService`, `enqueueOutbound`, `invalidateQueries`). Only the confirmation state machine layer changes.
- The audit's original framing ("extract `useKickConfirmation` to shared") is obsolete — `useTwoStepConfirm` already IS the right shared primitive at the right abstraction level. No new shared hook is needed.
- Verified 2026-05-29 against mobile `origin/master` `98d59a4` and desktop's post-refactor `useUserKicking`.
