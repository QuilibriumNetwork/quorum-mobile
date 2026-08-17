---
type: task
title: Mobile lets you finish onboarding with no display name, desktop does not
status: open
priority: medium
created: 2026-08-16
updated: 2026-08-16
---

# Mobile lets you finish onboarding with no display name, desktop does not

## Summary

Desktop **requires** a display name to create an account. Mobile makes it
optional and offers a Skip button. So a mobile-created account can exist with no
name at all, which is a state desktop's UI was written assuming cannot happen.

The operator's call, 2026-08-16: **mobile should do what desktop does.**

## The divergence, measured

|                                    | Desktop  | Mobile   |
| ---------------------------------- | -------- | -------- |
| Display name at signup             | Required | Optional |
| Skip available                     | No       | Yes      |
| Can an account exist with no name? | No       | **Yes**  |

**Desktop** gates the Continue button on `canProceedWithName`
(`quorum-desktop/src/hooks/business/user/useOnboardingFlowLogic.ts:263`), and an
empty name is an explicit error (`:206`, `rawName ? validateDisplayName(rawName)
: 'empty'`). There is no skip affordance on `DisplayNameStep.tsx`.

**Mobile** says so outright in `app/(onboarding)/profile-setup.tsx:109-111`:

> Validate only what the user actually entered — both fields are optional at
> onboarding (the screen is skippable).

and the primary button relabels itself accordingly (`:228`):

```ts
nextLabel={hasAnyInput ? 'Continue' : 'Skip'}
```

`handleSkip` (`:126`) simply calls `skipProfile()` and advances.

## Why it matters beyond tidiness

A nameless account renders **inconsistently against itself**. The shared
resolver's last rung is the truncated address
(`quorum-shared/src/utils/resolveDisplayName.ts:123`), so a nameless user's
LABEL reads `QmYVto…LjDd` everywhere. But two self surfaces deliberately refuse
to derive an avatar from that:

- `components/ui/AppTabBar.tsx:72-79`
- `components/HeaderAvatar.tsx:54-57`

Both pass `''` rather than the resolved name, on the stated grounds that an
address-derived initial "belongs to nobody and would be shared by nearly every
user (most addresses share the same `Qm` prefix)". The result is a label reading
`QmYVto…LjDd` beside an avatar reading `?`.

That is precisely the shape desktop wrote a whole module to eliminate —
`quorum-desktop/src/utils/identityPlaceholder.ts`, whose header describes it as
a bug:

> the same row read as "Unknown User" with a "?" avatar in one place and
> "QmYVto…LjDd" with a "Q" avatar in the other

Note the internal contradiction this creates on mobile: chat messages DO pass
the resolved name (`components/Chat/MessagesList.tsx:787` via
`resolveDisplayName`), so an unresolved member there renders `Q`. Only the self
surfaces opted out. Same app, two answers.

## Proposed change

1. Require a valid display name on `app/(onboarding)/profile-setup.tsx`:
   disable Continue until `validateDisplayName` passes, and remove the Skip
   affordance for the NAME. Bio and profile image stay optional.
2. Decide what happens to the `hasSelfName` opt-out in `AppTabBar.tsx` and
   `HeaderAvatar.tsx`. It becomes unreachable for new accounts but NOT for
   accounts already created without a name, so it cannot simply be deleted.
3. Decide the backfill for existing nameless accounts — there is no migration
   story yet, and this is the part most likely to bite.

## Risk

This is a **signup-funnel** change. Getting it wrong blocks account creation
entirely, which is a far larger blast radius than the avatar rendering work that
surfaced it. It was deliberately kept out of
`fix/avatar-fallback-shows-initials-not-quorum-logo` for that reason and should
ship as its own reviewable change with its own test.

## Open questions

- Should the name be required at the same step, or promoted to its own step to
  match desktop's `DisplayNameStep`?
- What should existing nameless accounts see — a one-time prompt, or a silent
  address-derived name?
- Does the desktop requirement have a bypass path (import/restore of an existing
  account) that mobile would also need?

## Origin

Found 2026-08-16 while investigating why photoless users rendered as an
identical Quorum brand mark on Farcaster surfaces. Tracing the avatar fallback
led to the question "isn't a name always set?", and the answer turned out to
differ between the two clients.
