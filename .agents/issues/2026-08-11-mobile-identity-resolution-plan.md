---
type: task
title: "Implementation plan: mobile identity resolution, with verification inside the provider"
status: open
priority: high
created: 2026-08-11
updated: 2026-08-11
area: identity resolution / QNS / cross-client architecture
repos: quorum-mobile (this), quorum-shared (the rule, already shipped), quorum-desktop (the reference implementation)
source: writing-plans, from the survey at reports/2026-08-11-mobile-identity-migration-survey.md and desktop's shipped branch
related:
  - "reports/2026-08-11-mobile-identity-migration-survey.md (THE SURVEY — read §3, §5 and §7 first)"
  - "quorum-desktop/.agents/issues/2026-08-10-identity-resolution-architecture-design.md (the design)"
  - "quorum-desktop/.agents/issues/2026-08-10-identity-resolution-architecture-plan.md ('What actually happened' is the handoff)"
  - "issues/.open/2026-08-10-invite-contact-picker-renders-an-unresolved-name.md (Task 7 closes this)"
  - "issues/.open/2026-08-11-profile-modal-bio-is-read-raw-so-it-vanishes-for-any-unmerged-member.md (Phase D row)"
---

# Mobile Identity Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a partial or unverified member identity impossible to express on mobile, so no surface can render the wrong name or a forged `.q`.

**Architecture:** `quorum-shared@2.1.0-42` already owns the ladder (`resolveIdentity` over a `MemberIdentity` whose fields are all required and explicitly nullable). Mobile gains an identity module keyed on `(address, spaceId?)` that assembles those tiers from the roster, the public-profile cache and locally-known names — **with QNS claim verification inside it**, so the `.q` tier cannot be reached by any path that skipped the check. Render surfaces use `<MemberName>` / `useResolvedName`; the WebSocket receive path keeps a pure function that structurally cannot mint a `.q`.

**Tech Stack:** TypeScript 5.9, React 19, React Native 0.81 / Expo SDK 54, `@tanstack/react-query` 5, MMKV 4, jest + `@testing-library/react-native` 13.x, yarn (never npm).

## Global Constraints

- **Package manager is yarn.** Never `npm install`.
- **`@quilibrium/quorum-shared` must end at `2.1.0-42`.** The bump and Task 1 are one commit; they cannot be separated because the shared change is breaking by design.
- **Never run `expo prebuild`.** See `PREBUILD.md`.
- **Every fix ships with a test shown RED first.** Revert the fix, watch it go red, put it back. Desktop caught three vacuous assertions this way; assume yours is vacuous until you have seen it fail.
- **Label every claim MEASURED / READ / INFERRED** in reports and commit messages. Stating an inference in the voice of a measurement is the single most damaging habit on this subsystem.
- **No `.agents` paths in code comments.** Describe the reason inline instead.
- **Fixture addresses use the repo's placeholder family** (`QmPeerAEgV…`), never a real account address.
- **Farcaster identities are out of scope.** `fid` / `username` / `displayName` on a cast author is a different namespace with no address, no roster and no `.q`. Routing one through the member resolver renders somebody else's name. The exclusions are already listed in `__tests__/rawNameFieldAudit.test.ts`.
- **Gates before any task is "done":** `npx jest` (all green), `npx tsc --noEmit` (must stay at the 12 pre-existing errors), `yarn lint` (must add no new findings; 300 pre-existing `@tabler/icons-react-native` errors are baseline).

---

## What is already built

Do not redo these. Committed on `feat/resolve-identity`:

| Artifact | What it gives you |
|---|---|
| `jest.config.js` (`testMatch` takes `.tsx`, `setupFilesAfterEnv`) | component render tests run at all |
| `jest/renderWithProviders.tsx` | renders a real screen with the theme provider; RTL pinned to 13.x for a stated reason |
| `jest/setup-native.js`, `__mocks__/react-native-mmkv.js` | native modules stubbed so a real screen can mount |
| `__tests__/shareInviteSheetName.test.tsx` | a RED (`it.failing`) test for Task 7 |
| `__tests__/rawNameFieldAudit.test.ts` | the ratchet: 19 defects listed with reasons. **This is Phase D's work-list.** |

**The render instrument's known blind spot, stated because desktop was burned by it:** a test that mounts its own provider with its own data is blind to *where a component sits in the real tree*. Desktop's 1300 tests stayed green through eight provider-wiring bugs. Tasks 5 and 11 exist to cover that class; render tests do not.

---

## File Structure

| File | Responsibility |
|---|---|
| `utils/resolveMemberName.ts` | MODIFY (Task 1). The pure ladder over `resolveIdentity`. Stays permanently as the **non-React** path — it is not a temporary seam. |
| `identity/identityFromMaps.ts` | CREATE (Task 2). Pure tier assembly. The only place tiers merge. |
| `identity/identityProvider.tsx` | CREATE (Task 3). React wiring: profile fetching, claim verification, scope merging. |
| `identity/useResolvedName.ts` | CREATE (Task 4). `useResolvedName`, `useResolvedMemberName`, `useMemberIdentity`. |
| `identity/MemberName.tsx` | CREATE (Task 4). The JSX API; owns the `.q` and the avatar initials. |
| `identity/useNameResolver.ts` | CREATE (Task 4). Bulk/imperative resolution inside React. |
| `identity/index.ts` | CREATE (Task 4). The only public entry point. |
| `hooks/useMultiSpaceRosters.ts` | CREATE (Task 5). `spaceId -> address -> row`, read from MMKV. |
| `app/_layout.tsx` | MODIFY (Task 5). Mounts the ROOT scope. |
| `__tests__/rawNameFieldAudit.test.ts` | MODIFY (every Phase D task). Remove your row. |

`identity/` is the ONLY directory allowed to import `resolveIdentity` from shared, plus `utils/resolveMemberName.ts`. Task 12 enforces that.

---

## Phase A — the seam

### Task 1: Bump shared and migrate the one importing file

**Files:**
- Modify: `package.json`, `yarn.lock`
- Modify: `utils/resolveMemberName.ts:70`, `utils/resolveMemberName.ts:226-234`

**Interfaces:**
- Consumes: `resolveIdentity(identity: MemberIdentity, opts: { scope: 'space' | 'global' }): { name: string; isQnsVerified: boolean }` and `hasReservedQnsSuffix(s: string): boolean`, both from `@quilibrium/quorum-shared`.
- Produces: `resolveMemberName(member: ResolvableMember, opts?: { self?: SelfIdentity }): ResolvedMemberName` — **signature unchanged**, so no other file moves in this task.

- [ ] **Step 1: Bump shared**

```bash
cd /e/GitHub/Quilibrium/quorum-mobile
yarn add @quilibrium/quorum-shared@2.1.0-42
```

- [ ] **Step 2: Watch the existing tests go red, and read WHY**

Run: `npx jest __tests__/resolveMemberName.test.ts`
Expected: FAIL, `TypeError: (0 , _quorumShared.resolveDisplayName) is not a function`.

This is the RED for this task. Five suites fail (`resolveMemberName`, `conversationTitle`, `messageSenderName`, `joinedMemberRendersEverywhere`, `logMentionOrReply`), 41 tests. Record that number; Step 5 must return all of them to green **without editing a single assertion**. If you find yourself changing an expectation, stop — the ladder's behaviour is not supposed to change in this task.

- [ ] **Step 3: Change the import**

In `utils/resolveMemberName.ts`, line 70:

```ts
import { hasReservedQnsSuffix, resolveIdentity } from '@quilibrium/quorum-shared';
```

- [ ] **Step 4: Change the call**

Replace the `resolveDisplayName(...)` call (currently at line 226) with:

```ts
    // `null`, never `undefined`: shared's `MemberIdentity` requires every tier
    // explicitly, so "I didn't look this up" cannot be spelled at all. The
    // conversion happens here because the `present*` helpers above return
    // `undefined` for an absent tier, which is the shape the local gate reads
    // most naturally.
    const resolved = resolveIdentity(
      {
        address: member.address,
        spaceName: override ?? null,
        qnsName: qns ?? null,
        globalName: global ?? null,
      },
      // Always the space ladder. A DM row carries no per-space override, so
      // `spaceName` is null there and both scopes return the same answer —
      // this is not a claim that every caller is inside a Space.
      { scope: 'space' },
    );
```

**Leave the local `presentName` / `presentQnsName` guards and the `if (override || qns || global)` gate exactly as they are.** The file's header explains at length why removing them is a measured regression: the gate is what stops shared's non-Qm-aware `slice(0,6)…slice(-4)` fallback ever reaching the screen, and what keeps `isAddressFallback` truthful.

- [ ] **Step 5: Run the full suite**

Run: `npx jest`
Expected: 61 suites, 795 tests, all green — the same numbers as before the bump, with no assertion edited.

- [ ] **Step 6: Update the header comment**

`utils/resolveMemberName.ts:2` says "Mobile adapter over the shared `resolveDisplayName` rule". Change `resolveDisplayName` to `resolveIdentity` there and at line 162. Do not rewrite the surrounding prose.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit    # must be 12 errors, unchanged
git add package.json yarn.lock utils/resolveMemberName.ts
git commit -m "feat: take quorum-shared 2.1.0-42 and resolve through resolveIdentity

The bump is breaking by design — shared deleted resolveDisplayName — so it
cannot land separately from this call-site change.

resolveMemberName's own signature is unchanged, so no other file moves. The
local forged-suffix guard and the has-any-tier gate stay: the gate is what
keeps shared's non-Qm-aware address fallback off the screen and what keeps
isAddressFallback honest. 795 tests pass with no assertion edited."
```

---

## Phase B — the machinery

### Task 2: The pure tier assembly, with the QNS tier locked to verified names

**Files:**
- Create: `identity/identityFromMaps.ts`
- Test: `__tests__/identityFromMaps.test.ts`

**Interfaces:**
- Consumes: `MemberIdentity` from `@quilibrium/quorum-shared` (Task 1's dependency).
- Produces:
  - `interface RosterNameRow { display_name?: string | null; global_display_name?: string | null }`
  - `interface IdentitySources { rostersBySpace: Record<string, Record<string, RosterNameRow>>; verifiedQnsNames: Record<string, string>; profileGlobalNames: Record<string, string>; locallyKnownNames: Record<string, string>; selfAddress: string | null }`
  - `identityFromMaps(address: string, spaceId: string | undefined, sources: IdentitySources): MemberIdentity`
  - `selfLocalNameEntry(address: string | null | undefined, displayName: string | null | undefined): Record<string, string>`
  - `EMPTY_LOCAL_NAMES`, `EMPTY_ROSTERS_BY_SPACE` — stable empty references.

**This task's whole point is one difference from desktop.** Desktop's `identityFromMaps` reads `profile?.primary_username` straight from the fetched public profile. Mobile must never do that: a `primary_username` is a **claim**, and mobile strips claims that do not resolve back to the claiming address. Taking the QNS tier from a separate `verifiedQnsNames` map — with no access to a raw profile object at all — makes "forgot to verify" unrepresentable rather than merely discouraged.

- [ ] **Step 1: Write the failing test**

Create `__tests__/identityFromMaps.test.ts`:

```ts
/**
 * Tier assembly, and the one property that is a security property.
 *
 * The ladder itself lives in quorum-shared and is tested there. What is pinned
 * here is which SOURCE each tier may come from — in particular that the QNS
 * tier can only ever come from the verified map, so a surface that never ran
 * verification cannot produce a `.q` no matter what it holds.
 */
import {
  identityFromMaps,
  selfLocalNameEntry,
  type IdentitySources,
} from '../identity/identityFromMaps';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const SELF = 'QmPeerBEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

const sources = (over: Partial<IdentitySources> = {}): IdentitySources => ({
  rostersBySpace: {},
  verifiedQnsNames: {},
  profileGlobalNames: {},
  locallyKnownNames: {},
  selfAddress: null,
  ...over,
});

describe('identityFromMaps — where each tier comes from', () => {
  it('takes the per-space name from the roster override slot', () => {
    const r = identityFromMaps(ADDR, 'space-1', sources({
      rostersBySpace: {
        'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } },
      },
    }));
    expect(r).toEqual({
      address: ADDR,
      spaceName: 'Mod Alice',
      qnsName: null,
      globalName: 'Alice',
    });
  });

  it('ignores the roster entirely when no spaceId is given', () => {
    // A DM, or a Space you have left. A per-space nickname is meaningless here.
    const r = identityFromMaps(ADDR, undefined, sources({
      rostersBySpace: {
        'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } },
      },
    }));
    expect(r.spaceName).toBeNull();
    expect(r.globalName).toBeNull();
  });

  it('prefers the roster global slot over a fetched profile name', () => {
    const r = identityFromMaps(ADDR, 'space-1', sources({
      rostersBySpace: {
        'space-1': { [ADDR]: { display_name: '', global_display_name: 'Roster Alice' } },
      },
      profileGlobalNames: { [ADDR]: 'Profile Alice' },
    }));
    expect(r.globalName).toBe('Roster Alice');
  });

  it('falls to a locally-known name last, below the fetched profile', () => {
    // A DM partner who never published a profile. The app knows their name
    // from their own broadcast; rendering an address instead would be a
    // regression desktop shipped and had to send back.
    const r = identityFromMaps(ADDR, undefined, sources({
      locallyKnownNames: { [ADDR]: 'Alice' },
    }));
    expect(r.globalName).toBe('Alice');

    const withProfile = identityFromMaps(ADDR, undefined, sources({
      profileGlobalNames: { [ADDR]: 'Published Alice' },
      locallyKnownNames: { [ADDR]: 'Local Alice' },
    }));
    expect(withProfile.globalName).toBe('Published Alice');
  });

  it('returns an all-null identity for an unknown address, never undefined', () => {
    expect(identityFromMaps(ADDR, undefined, sources())).toEqual({
      address: ADDR,
      spaceName: null,
      qnsName: null,
      globalName: null,
    });
  });

  it('treats a whitespace-only tier as absent', () => {
    const r = identityFromMaps(ADDR, 'space-1', sources({
      rostersBySpace: { 'space-1': { [ADDR]: { global_display_name: '   ' } } },
      locallyKnownNames: { [ADDR]: 'Alice' },
    }));
    expect(r.globalName).toBe('Alice');
  });
});

describe('identityFromMaps — the QNS tier is verified-only (SECURITY)', () => {
  it('takes qnsName from the verified map', () => {
    const r = identityFromMaps(ADDR, undefined, sources({
      verifiedQnsNames: { [ADDR]: 'alice' },
    }));
    expect(r.qnsName).toBe('alice');
  });

  it('has NO other route to a qnsName', () => {
    // The point of the whole file. There is no profile object in
    // IdentitySources at all, so a caller cannot hand over a raw claim even
    // by accident — an unverified name has nowhere to be put.
    const s = sources({ profileGlobalNames: { [ADDR]: 'Alice' } });
    expect(Object.keys(s)).not.toContain('profiles');
    expect(identityFromMaps(ADDR, undefined, s).qnsName).toBeNull();
  });

  it('does not leak one member’s verified name to another', () => {
    const r = identityFromMaps(ADDR, undefined, sources({
      verifiedQnsNames: { [SELF]: 'bob' },
    }));
    expect(r.qnsName).toBeNull();
  });
});

describe('selfLocalNameEntry', () => {
  it('returns a stable empty object when there is nothing to contribute', () => {
    expect(selfLocalNameEntry(null, 'Alice')).toEqual({});
    expect(selfLocalNameEntry(SELF, '  ')).toEqual({});
    // Same REFERENCE, so a caller memoising on it does not churn every render.
    expect(selfLocalNameEntry(null, null)).toBe(selfLocalNameEntry(SELF, ''));
  });

  it('maps the address to the device name when both are present', () => {
    expect(selfLocalNameEntry(SELF, 'My Phone')).toEqual({ [SELF]: 'My Phone' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest __tests__/identityFromMaps.test.ts`
Expected: FAIL — cannot find module `../identity/identityFromMaps`.

- [ ] **Step 3: Implement**

Create `identity/identityFromMaps.ts`:

```ts
import type { MemberIdentity } from '@quilibrium/quorum-shared';

/**
 * Pure tier assembly: the ONE place a member's name tiers are merged.
 *
 * Kept out of React deliberately, for two reasons. It makes the merge
 * unit-testable without mounting anything, and it lets a virtualised list
 * resolve hundreds of rows from maps already in memory without registering a
 * query observer per row.
 *
 * ## The QNS tier is verified-only, and that is structural
 *
 * `IdentitySources` carries NO public-profile object. It carries
 * `verifiedQnsNames` — names that have already been resolved back to the
 * address claiming them — and `profileGlobalNames`, the display name from the
 * same profile, which needs no verification because it makes no trust claim.
 *
 * Splitting the profile into those two maps is the whole design. A
 * `primary_username` arriving from a public profile or a broadcast is a CLAIM;
 * the `.q` suffix rendered from it is the only signal a viewer gets that a name
 * is genuinely owned. If this function could see a raw profile, every future
 * caller would have to remember to verify first, and one that forgot would
 * render a forged verified name. It cannot see one, so there is nowhere to put
 * an unverified claim.
 */

/** The roster fields the identity needs. Mirrors a space member row's name slots. */
export interface RosterNameRow {
  /** Per-space OVERRIDE slot. Non-empty means a deliberate per-space name. */
  display_name?: string | null;
  /** GLOBAL slot — the member's global name, pushed into the roster. */
  global_display_name?: string | null;
}

/**
 * Stable empty references. A fresh `{}` literal per render would invalidate
 * every memo built on it, on the surfaces whose entire cost argument is that
 * they do not recompute per tick.
 */
export const EMPTY_LOCAL_NAMES: Record<string, string> = {};
export const EMPTY_ROSTERS_BY_SPACE: Record<string, Record<string, RosterNameRow>> = {};

export interface IdentitySources {
  /** spaceId -> address -> roster row. Local, read from MMKV. */
  rostersBySpace: Record<string, Record<string, RosterNameRow>>;
  /**
   * address -> QNS name that has been VERIFIED to belong to that address.
   * The only source of the `.q` tier. Never populate this from a raw profile
   * or a broadcast field.
   */
  verifiedQnsNames: Record<string, string>;
  /** address -> display name from a fetched public profile. Carries no trust
   *  claim, so it needs no verification. */
  profileGlobalNames: Record<string, string>;
  /**
   * address -> a name known LOCALLY, with no network round-trip: a DM
   * partner's name learned from their own broadcast, or your own device name.
   *
   * LAST `globalName` tier. A published profile is authoritative when present;
   * this is what the peer told you directly. Without it, a partner who never
   * published a profile renders as a truncated address even though the app
   * knows their name — a regression desktop shipped and had to send back.
   */
  locallyKnownNames: Record<string, string>;
  selfAddress: string | null;
}

const nn = (v?: string | null): string | null => {
  const t = (v ?? '').trim();
  return t.length ? t : null;
};

/**
 * Your own device name, as a `locallyKnownNames` entry.
 *
 * Self resolves from the same tiers as anybody else — there is no self
 * special case in the ladder. But your own device profile is a name source
 * nobody else has, and without it a user who never published a public profile
 * renders as their own address in their own header. It is the LAST tier and it
 * can never supply a `.q`, because a device name is not a QNS name.
 *
 * Returns the stable empty reference when there is nothing to contribute.
 */
export function selfLocalNameEntry(
  address: string | null | undefined,
  displayName: string | null | undefined,
): Record<string, string> {
  const name = nn(displayName);
  if (!address || !name) return EMPTY_LOCAL_NAMES;
  return { [address]: name };
}

export function identityFromMaps(
  address: string,
  spaceId: string | undefined,
  sources: IdentitySources,
): MemberIdentity {
  // Only a real space context can have a per-space nickname. With no spaceId
  // — a DM, or a Space you have left — the roster is not consulted at all.
  const row = spaceId ? sources.rostersBySpace[spaceId]?.[address] : undefined;

  return {
    address,
    spaceName: nn(row?.display_name),
    qnsName: nn(sources.verifiedQnsNames[address]),
    // Live roster slot, then the published profile, then a name known only
    // locally. One merge path, never a second parallel lookup.
    globalName:
      nn(row?.global_display_name) ??
      nn(sources.profileGlobalNames[address]) ??
      nn(sources.locallyKnownNames[address]),
  };
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx jest __tests__/identityFromMaps.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Prove the security test is not vacuous**

Temporarily change `qnsName` to `nn(sources.verifiedQnsNames[address]) ?? nn(sources.profileGlobalNames[address])`. Run the suite.
Expected: the "has NO other route to a qnsName" test goes RED. **Put it back.** Record the transcript in the commit message.

- [ ] **Step 6: Commit**

```bash
git add identity/identityFromMaps.ts __tests__/identityFromMaps.test.ts
git commit -m "feat(identity): pure tier assembly, with the QNS tier verified-only

IdentitySources deliberately carries no profile object. The .q tier reads
from verifiedQnsNames and nothing else, so a surface that skipped
verification has nowhere to put a claim rather than merely being discouraged
from rendering one. The profile's display name is a separate map because it
makes no trust claim and needs no check.

RED proof: adding a profileGlobalNames fallback to qnsName turns the
'no other route' test red."
```

---

### Task 3: The provider — fetching, verification, and scope merging

**Files:**
- Create: `identity/identityProvider.tsx`
- Test: `__tests__/identityProviderMerge.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produces; `publicProfileQueryKey` and `PublicProfile` from `@/hooks/useUserPublicProfile`; `claimedNamesIn`, `resolveClaimedNames` from `@/hooks/useVerifiedQnsNames`; `claimedNameBelongsTo` from `@/utils/verifyQnsClaim`; `resolveBatch` from `@/services/api/qnsClient`.
- Produces:
  - `IdentityScopeProvider` (props: `spaceId?`, `rostersBySpace`, `selfAddress`, `locallyKnownNames?`, `children`)
  - `useIdentityContext(): { sources: IdentitySources; defaultSpaceId?: string; request: (address: string) => void }`
  - `mergeFlat`, `mergeRostersBySpace` — exported for the merge tests.

**Two properties this task exists to get right, both learned expensively on desktop:**

1. **A nested provider MERGES with its parent, never replaces it.** Four desktop surfaces shipped mounting a provider with less data than the root, each silently rendering members as addresses. `rostersBySpace` merges at TWO levels (per space, then per address) so a child still loading a roster cannot blank out an ancestor's loaded one.
2. **`defaultSpaceId` is deliberately NOT merged.** It is always the provider's own prop. This is what stops a DM inheriting a nickname from an unrelated space once the root carries every space's rosters. Getting it wrong is invisible to anyone without a nickname set, which is most testing.

- [ ] **Step 1: Write the failing merge test**

Create `__tests__/identityProviderMerge.test.ts`:

```ts
/**
 * The merge rules, tested as pure functions.
 *
 * These are not a detail. Four desktop surfaces shipped mounting a provider
 * with strictly LESS data than the one above it, each rendering members as raw
 * addresses, each found by hand hours apart. Replacing rather than merging is
 * the bug; these pin the fix.
 */
import { mergeFlat, mergeRostersBySpace } from '../identity/identityProvider';

const A = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const B = 'QmPeerBEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('mergeFlat', () => {
  it('lets the child win per key and the parent fill the rest', () => {
    expect(mergeFlat({ [A]: 'Parent A', [B]: 'Parent B' }, { [A]: 'Child A' })).toEqual({
      [A]: 'Child A',
      [B]: 'Parent B',
    });
  });

  it('returns an input UNCHANGED when the other side is empty', () => {
    // Reference equality, not just deep equality: returning a fresh object
    // when there is nothing to merge reintroduces the per-render allocation
    // the stable empty references exist to avoid.
    const own = { [A]: 'A' };
    expect(mergeFlat({}, own)).toBe(own);
    const parent = { [B]: 'B' };
    expect(mergeFlat(parent, {})).toBe(parent);
  });
});

describe('mergeRostersBySpace', () => {
  it('merges per ADDRESS, so a still-loading child cannot blank the parent', () => {
    // The regression this shape exists to prevent: a child provider that sets
    // map[spaceId] = {} while its own read is in flight would, under a shallow
    // merge, erase every row the parent already had for that space.
    const parent = { 's1': { [A]: { global_display_name: 'Alice' } } };
    const own = { 's1': {} };
    expect(mergeRostersBySpace(parent, own)).toEqual({
      's1': { [A]: { global_display_name: 'Alice' } },
    });
  });

  it('lets a loaded child row win over the parent for the same address', () => {
    const parent = { 's1': { [A]: { global_display_name: 'Stale' } } };
    const own = { 's1': { [A]: { global_display_name: 'Fresh' } } };
    expect(mergeRostersBySpace(parent, own)['s1'][A].global_display_name).toBe('Fresh');
  });

  it('keeps spaces only the parent knows about', () => {
    const parent = { 's1': { [A]: { global_display_name: 'Alice' } } };
    const own = { 's2': { [B]: { global_display_name: 'Bob' } } };
    expect(Object.keys(mergeRostersBySpace(parent, own)).sort()).toEqual(['s1', 's2']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest __tests__/identityProviderMerge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Create `identity/identityProvider.tsx`:

```tsx
import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { getQuorumClient } from '@/services/api/quorumClient';
import { publicProfileQueryKey, type PublicProfile } from '@/hooks/useUserPublicProfile';
import { resolveClaimedNames, QNS_BATCH_LIMIT } from '@/hooks/useVerifiedQnsNames';
import { claimedNameBelongsTo } from '@/utils/verifyQnsClaim';
import { resolveBatch } from '@/services/api/qnsClient';
import {
  EMPTY_LOCAL_NAMES,
  type IdentitySources,
  type RosterNameRow,
} from './identityFromMaps';

/**
 * Shallow merge of a flat `address -> value` map: `own` wins per key, `parent`
 * fills the rest. Returns one of the two inputs UNCHANGED (same reference)
 * when the other is empty, so merging with nothing does not allocate.
 */
export function mergeFlat<T>(
  parent: Record<string, T>,
  own: Record<string, T>,
): Record<string, T> {
  if (Object.keys(parent).length === 0) return own;
  if (Object.keys(own).length === 0) return parent;
  return { ...parent, ...own };
}

/**
 * Merge for `rostersBySpace` — TWO levels (spaceId, then address), not one
 * shallow merge of the outer map.
 *
 * A shallow merge would let a child's roster REPLACE the parent's wholesale
 * for any space both know about. A child whose own read has not resolved yet
 * legitimately holds `{}` for that space, so the shallow version would blank
 * every row the parent already had — introducing the exact regression this
 * merge exists to prevent. Per-address instead: an empty child contributes
 * nothing and the parent's rows keep showing, while a loaded child row still
 * wins for its own key.
 */
export function mergeRostersBySpace(
  parent: Record<string, Record<string, RosterNameRow>>,
  own: Record<string, Record<string, RosterNameRow>>,
): Record<string, Record<string, RosterNameRow>> {
  if (Object.keys(parent).length === 0) return own;
  const ownSpaceIds = Object.keys(own);
  if (ownSpaceIds.length === 0) return parent;

  const merged: Record<string, Record<string, RosterNameRow>> = { ...parent };
  for (const spaceId of ownSpaceIds) {
    const parentRoster = parent[spaceId];
    merged[spaceId] = parentRoster ? mergeFlat(parentRoster, own[spaceId]) : own[spaceId];
  }
  return merged;
}

interface IdentityContextValue {
  sources: IdentitySources;
  /** Scope for call sites that do not pass a spaceId. */
  defaultSpaceId?: string;
  /** Ask for an address's public profile if it is not already cached. */
  request: (address: string) => void;
}

const IdentityContext = React.createContext<IdentityContextValue | null>(null);

export const useIdentityContext = (): IdentityContextValue => {
  const ctx = React.useContext(IdentityContext);
  if (!ctx) {
    throw new Error(
      'useResolvedName/<MemberName> used outside <IdentityScopeProvider>. ' +
        'The root scope is mounted in app/_layout.tsx; a detached host may need its own.',
    );
  }
  return ctx;
};

export const IdentityScopeProvider: React.FunctionComponent<{
  /** The Space this subtree lives in, if any. Absent for DMs and global views.
   *  NOT inherited from an enclosing scope: a detached surface that omits it
   *  gets the global ladder even when an ancestor is scoped to a Space. */
  spaceId?: string;
  rostersBySpace: Record<string, Record<string, RosterNameRow>>;
  selfAddress: string | null;
  locallyKnownNames?: Record<string, string>;
  children: React.ReactNode;
}> = ({
  spaceId,
  rostersBySpace,
  selfAddress,
  locallyKnownNames = EMPTY_LOCAL_NAMES,
  children,
}) => {
  const [requested, setRequested] = React.useState<ReadonlySet<string>>(new Set());
  const request = React.useCallback((address: string) => {
    if (!address) return;
    setRequested((prev) => (prev.has(address) ? prev : new Set(prev).add(address)));
  }, []);

  const addresses = React.useMemo(() => Array.from(requested), [requested]);

  const queries = useQueries({
    queries: addresses.map((address) => ({
      queryKey: publicProfileQueryKey(address),
      queryFn: (): Promise<PublicProfile | null> => getQuorumClient().getPublicProfile(address),
      staleTime: 60 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: false,
    })),
  });

  // `useQueries` returns a fresh array every render, so memo on a fingerprint
  // of the per-query data instead. `dataUpdatedAt` rather than presence:
  // a write that replaces an already-loaded profile is non-null before and
  // after, so a truthy flag cannot see it.
  const updatedAtKey = queries.map((q) => q?.dataUpdatedAt ?? 0).join('|');
  const profiles = React.useMemo(() => {
    const map: Record<string, PublicProfile | null> = {};
    addresses.forEach((a, i) => {
      map[a] = queries[i]?.data ?? null;
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses, updatedAtKey]);

  // The display name needs no verification: it makes no trust claim.
  const profileGlobalNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const [address, profile] of Object.entries(profiles)) {
      const name = (profile?.display_name ?? '').trim();
      if (name) map[address] = name;
    }
    return map;
  }, [profiles]);

  // ── The claim check, INSIDE the provider ────────────────────────────────
  //
  // A `primary_username` on a public profile is a CLAIM. It renders with a
  // `.q`, which is the only signal a viewer gets that a name is genuinely
  // owned, so it may not reach the ladder until it has resolved back to the
  // address claiming it.
  //
  // Doing it here rather than upstream of each surface is decision 5.1: every
  // consumer inherits the check, and a surface that forgets it does not exist,
  // because there is no other way in. Unproven includes NOT-YET-KNOWN — a
  // lookup in flight yields no entry, so the name simply is not there. A `.q`
  // shown for even the instant before a lookup lands is the whole attack.
  const claimedNames = React.useMemo(() => {
    const seen = new Set<string>();
    for (const profile of Object.values(profiles)) {
      const claim = (profile?.primary_username ?? '').trim();
      if (claim) seen.add(claim);
      if (seen.size >= QNS_BATCH_LIMIT) break;
    }
    return Array.from(seen);
  }, [profiles]);

  const namesKey = claimedNames.join('|');
  const { data: claimRecords } = useQuery({
    queryKey: ['qns-verify-claims', namesKey],
    queryFn: () => resolveClaimedNames(claimedNames, resolveBatch),
    enabled: claimedNames.length > 0,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    // A retry would extend the window in which claims are unresolved. They
    // degrade to the global name meanwhile, which is correct but invisible.
    retry: false,
    // Carry the previous answer while a wider set resolves, or every name on
    // screen reverts to its global form for ~200ms whenever a new claimant
    // appears. Safe in the fail-closed direction: a name that is NEW in the
    // wider set is simply absent from the carried map, and absent means
    // unverified, so this can only ever under-show.
    placeholderData: (previous) => previous,
  });

  const verifiedQnsNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    if (!claimRecords) return map;
    for (const [address, profile] of Object.entries(profiles)) {
      const claim = (profile?.primary_username ?? '').trim();
      if (!claim) continue;
      if (claimedNameBelongsTo(claimRecords.get(claim), address)) map[address] = claim;
    }
    return map;
  }, [profiles, claimRecords]);

  // MERGE, not replace. `useContext` rather than `useIdentityContext`: the
  // root provider and any isolated test mount legitimately have no ancestor,
  // and that must degrade to "nothing to merge with" rather than throw. Each
  // level merges only with its DIRECT parent, which already carries
  // everything merged in above it.
  const parent = React.useContext(IdentityContext);

  const mergedRostersBySpace = React.useMemo(
    () => (parent ? mergeRostersBySpace(parent.sources.rostersBySpace, rostersBySpace) : rostersBySpace),
    [parent, rostersBySpace],
  );
  const mergedProfileGlobalNames = React.useMemo(
    () => (parent ? mergeFlat(parent.sources.profileGlobalNames, profileGlobalNames) : profileGlobalNames),
    [parent, profileGlobalNames],
  );
  const mergedVerifiedQnsNames = React.useMemo(
    () => (parent ? mergeFlat(parent.sources.verifiedQnsNames, verifiedQnsNames) : verifiedQnsNames),
    [parent, verifiedQnsNames],
  );
  const mergedLocallyKnownNames = React.useMemo(
    () => (parent ? mergeFlat(parent.sources.locallyKnownNames, locallyKnownNames) : locallyKnownNames),
    [parent, locallyKnownNames],
  );

  React.useEffect(() => {
    if (selfAddress) request(selfAddress);
  }, [selfAddress, request]);

  const value = React.useMemo<IdentityContextValue>(
    () => ({
      sources: {
        rostersBySpace: mergedRostersBySpace,
        verifiedQnsNames: mergedVerifiedQnsNames,
        profileGlobalNames: mergedProfileGlobalNames,
        locallyKnownNames: mergedLocallyKnownNames,
        selfAddress,
      },
      // NOT merged — always this provider's own prop. See the prop docstring.
      defaultSpaceId: spaceId,
      request,
    }),
    [
      mergedRostersBySpace,
      mergedVerifiedQnsNames,
      mergedProfileGlobalNames,
      mergedLocallyKnownNames,
      selfAddress,
      spaceId,
      request,
    ],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
};
```

- [ ] **Step 4: Run the merge test — expect PASS**

Run: `npx jest __tests__/identityProviderMerge.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the merge test is not vacuous**

Change `mergeRostersBySpace` to a shallow `{ ...parent, ...own }`. Run the suite.
Expected: "merges per ADDRESS, so a still-loading child cannot blank the parent" goes RED. **Put it back**, and paste the transcript into the commit message.

- [ ] **Step 6: Commit**

```bash
git add identity/identityProvider.tsx __tests__/identityProviderMerge.test.ts
git commit -m "feat(identity): provider with claim verification and scope merging

Verification runs INSIDE the provider, so every consumer inherits it and a
surface that skips it cannot exist — there is no other route to the .q tier.
A lookup still in flight yields no entry, because a .q shown for the instant
before a lookup lands is the whole attack.

Nested providers MERGE with their parent rather than replacing it;
rostersBySpace merges two-level so a child still loading a roster cannot
blank an ancestor's loaded one. defaultSpaceId is deliberately NOT merged,
which is what stops a DM inheriting a nickname from an unrelated space.

RED proof: a shallow rostersBySpace merge turns the still-loading test red."
```

---

### Task 4: `useResolvedName`, `<MemberName>`, `useNameResolver`

**Files:**
- Create: `identity/useResolvedName.ts`, `identity/MemberName.tsx`, `identity/useNameResolver.ts`, `identity/index.ts`
- Test: `__tests__/memberName.test.tsx`

**Interfaces:**
- Produces:
  - `useResolvedMemberName(address, opts?): { name: string; isQnsVerified: boolean }`
  - `useResolvedName(address, opts?): string` — with `.q` appended when verified
  - `useMemberIdentity(address, opts?): MemberIdentity`
  - `<MemberName address spaceId? global? enrich? style? />` — no avatar props. Unlike desktop's, this one does not render the avatar: mobile has a separate `resolveMemberAvatar` ladder with no QNS step, and Task 6 makes the initials agree by giving `DefaultAvatar` a `resolvedName` prop instead.
  - `useNameResolver(): { resolve(address, opts?): ResolvedMemberName; requestNames(addresses: Iterable<string>): void }`
  - `UseResolvedNameOptions = { spaceId?: string; global?: boolean; enrich?: boolean }`

**The `enrich` policy, final** (survey §7.4, revised by desktop with numbers in hand): resolving reads from memory and issues NO request by default. `enrich` opts into a public-profile fetch. **The member sidebar is the only surface that must never enrich**, because its cardinality is unbounded — desktop MEASURED 200 concurrent requests opening a 200-member space. Everything bounded enriches, including the mention autocomplete and the invite picker; leaving those out produced a visible inconsistency where a dropdown showed a plain name and the posted message showed `alice.q` for the same person.

- [ ] **Step 1: Write the failing render test**

Create `__tests__/memberName.test.tsx`:

```tsx
/**
 * <MemberName> is the only name-rendering API, and it owns the `.q`.
 *
 * NOTE ON WHAT THIS CANNOT SEE: this test mounts its own provider with its own
 * data, so it proves the component resolves correctly GIVEN a provider. It is
 * blind to whether the real tree mounts a provider above this component at all,
 * which is a different bug class that shipped eight times on desktop with a
 * green suite. Task 11 covers that; do not read this file as coverage of it.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { MemberName } from '@/identity/MemberName';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

const wrap = (ui: React.ReactNode, sources: {
  rosters?: Record<string, Record<string, { display_name?: string; global_display_name?: string }>>;
  local?: Record<string, string>;
  spaceId?: string;
}) =>
  render(
    <IdentityScopeProvider
      spaceId={sources.spaceId}
      rostersBySpace={sources.rosters ?? {}}
      selfAddress={null}
      locallyKnownNames={sources.local ?? {}}
    >
      {ui}
    </IdentityScopeProvider>,
  );

describe('MemberName', () => {
  it('renders a deliberate per-space nickname with no .q', () => {
    wrap(<MemberName address={ADDR} />, {
      spaceId: 'space-1',
      rosters: { 'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } } },
    });
    expect(screen.getByText('Mod Alice')).toBeTruthy();
    expect(screen.queryByText(/\.q/)).toBeNull();
  });

  it('renders a locally-known DM name rather than an address', () => {
    // Design constraint 5: a DM partner who never published a profile must
    // still render as a name, from local data, with no fetch.
    wrap(<MemberName address={ADDR} />, { local: { [ADDR]: 'Alice' } });
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('falls back to a truncated address when nothing knows the member', () => {
    wrap(<MemberName address={ADDR} />, {});
    expect(screen.getByText(/Qm/)).toBeTruthy();
  });

  it('never renders a .q from an unverified claim', () => {
    // There is no way to inject one: the provider only writes verifiedQnsNames
    // after a claim resolves back to its address, and nothing else feeds that
    // tier. This asserts the absence rather than a mechanism, deliberately.
    wrap(<MemberName address={ADDR} />, { local: { [ADDR]: 'Alice' } });
    expect(screen.queryByText(/\.q/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest __tests__/memberName.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `identity/useResolvedName.ts`**

```ts
import * as React from 'react';
import { resolveIdentity, type MemberIdentity } from '@quilibrium/quorum-shared';
import { identityFromMaps, type IdentitySources } from './identityFromMaps';
import { useIdentityContext } from './identityProvider';
import { truncateAddress } from '@/utils/formatAddress';

export interface ResolvedMemberName {
  name: string;
  isQnsVerified: boolean;
}

export interface UseResolvedNameOptions {
  /** Override the surrounding scope. Detached surfaces that carry their own
   *  spaceId (bookmarks, notifications) pass it here. */
  spaceId?: string;
  /** Force the global ladder even inside a Space. Rarely needed. */
  global?: boolean;
  /**
   * Opt in to a public-profile fetch for this address. Default `false`: the
   * name resolves from maps already in memory and issues NO request, so a
   * member with no cached profile renders their roster name and no `.q`.
   *
   * This gates only whether a request is ISSUED. A profile some other enriched
   * call site already fetched is still read here.
   *
   * Only the member sidebar must never enrich — its cardinality is a whole
   * Space's membership, and one request per row is a measured fetch storm.
   * Bounded surfaces should enrich.
   */
  enrich?: boolean;
}

function useIdentityAndScope(
  address: string,
  spaceId: string | undefined,
  enrich: boolean,
): { identity: MemberIdentity; effectiveSpaceId: string | undefined; sources: IdentitySources } {
  const { sources, defaultSpaceId, request } = useIdentityContext();
  React.useEffect(() => {
    if (enrich) request(address);
  }, [address, enrich, request]);
  const effectiveSpaceId = spaceId ?? defaultSpaceId;
  const identity = React.useMemo(
    () => identityFromMaps(address, effectiveSpaceId, sources),
    [address, effectiveSpaceId, sources],
  );
  return { identity, effectiveSpaceId, sources };
}

/** The identity behind a name, for callers that need the tiers.
 *
 *  WARNING: these are RAW tiers. They have not been through the ladder, and a
 *  caller rendering one directly skips the forged-suffix guard `resolveIdentity`
 *  applies. Desktop shipped a forgery this way. Render through
 *  `useResolvedMemberName` unless you genuinely need the tiers themselves. */
export function useMemberIdentity(
  address: string,
  { spaceId, enrich = false }: { spaceId?: string; enrich?: boolean } = {},
): MemberIdentity {
  return useIdentityAndScope(address, spaceId, enrich).identity;
}

/** The structured result, for callers that style the suffix. */
export function useResolvedMemberName(
  address: string,
  { spaceId, global = false, enrich = false }: UseResolvedNameOptions = {},
): ResolvedMemberName {
  const { identity, effectiveSpaceId } = useIdentityAndScope(address, spaceId, enrich);
  const scope = global || !effectiveSpaceId ? 'global' : 'space';
  return React.useMemo(() => {
    const resolved = resolveIdentity(identity, { scope });
    // Shared's own fallback is a naive slice(0,6)…slice(-4), which is not
    // Qm-aware. Mobile's truncateAddress counts entropy characters AFTER the
    // constant `Qm` prefix and is parity-matched with desktop, so the last
    // rung stays local — handing it to shared would regress every address
    // label in the app.
    if (!identity.spaceName && !identity.qnsName && !identity.globalName) {
      return { name: truncateAddress(identity.address), isQnsVerified: false };
    }
    return resolved;
  }, [identity, scope]);
}

/** The resolved name as a plain string, with `.q` when verified. For
 *  accessibility labels, notification bodies, search text and modal payloads. */
export function useResolvedName(address: string, opts: UseResolvedNameOptions = {}): string {
  const r = useResolvedMemberName(address, opts);
  return r.isQnsVerified ? `${r.name}.q` : r.name;
}
```

- [ ] **Step 4: Implement `identity/useNameResolver.ts`**

```ts
import * as React from 'react';
import { resolveIdentity } from '@quilibrium/quorum-shared';
import { identityFromMaps } from './identityFromMaps';
import { useIdentityContext } from './identityProvider';
import { truncateAddress } from '@/utils/formatAddress';
import type { ResolvedMemberName, UseResolvedNameOptions } from './useResolvedName';

export interface NameResolver {
  /** Resolve one address synchronously from the maps the surrounding provider
   *  already holds. Safe inside a loop or callback. Does NOT request a
   *  profile — call `requestNames` for addresses that should show a `.q`. */
  resolve: (address: string, opts?: UseResolvedNameOptions) => ResolvedMemberName;
  /** Request public profiles for a whole SET in one call. Dedupes against
   *  addresses already requested, so calling it every render is a no-op. */
  requestNames: (addresses: Iterable<string>) => void;
}

/**
 * Bulk resolution for surfaces that turn N addresses into labels inside a loop,
 * where N is not known until the data is parsed — a `.map()` over reactors, a
 * search filter, a sort key. A hook cannot be called per address in that shape.
 *
 * `resolve` is a pure read of `identityFromMaps` + `resolveIdentity`, the same
 * ladder `<MemberName>` uses, so a pill and a header can never disagree about
 * the same member. Its identity changes only when the provider's sources or
 * default scope change, so it is safe in a dependency array.
 *
 * A single-address surface should use `<MemberName>` instead.
 */
export function useNameResolver(): NameResolver {
  const { sources, defaultSpaceId, request } = useIdentityContext();

  const resolve = React.useCallback(
    (address: string, opts: UseResolvedNameOptions = {}): ResolvedMemberName => {
      const effectiveSpaceId = opts.spaceId ?? defaultSpaceId;
      const identity = identityFromMaps(address, effectiveSpaceId, sources);
      const scope = opts.global || !effectiveSpaceId ? 'global' : 'space';
      if (!identity.spaceName && !identity.qnsName && !identity.globalName) {
        return { name: truncateAddress(identity.address), isQnsVerified: false };
      }
      return resolveIdentity(identity, { scope });
    },
    [sources, defaultSpaceId],
  );

  const requestNames = React.useCallback(
    (addresses: Iterable<string>) => {
      for (const address of addresses) request(address);
    },
    [request],
  );

  return React.useMemo(() => ({ resolve, requestNames }), [resolve, requestNames]);
}
```

- [ ] **Step 5: Implement `identity/MemberName.tsx`**

```tsx
import * as React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useResolvedMemberName, type UseResolvedNameOptions } from './useResolvedName';

interface MemberNameProps extends UseResolvedNameOptions {
  address: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

/**
 * The only name-rendering API.
 *
 * Owns the `.q` suffix. Nothing else in the app may append it: the suffix is
 * the entire trust claim, so it must only ever come from a resolution that
 * earned it.
 *
 * Avatars are deliberately NOT rendered here, unlike desktop's version. Mobile
 * already has a separate avatar ladder (`resolveMemberAvatar`) with no QNS
 * step, because a `.q` carries no picture, and folding the two would merge
 * ladders that are correctly different. What must agree is the INITIALS: pass
 * this component's resolved name to the avatar, never a raw field. That is
 * what `resolvedName` on the avatar primitive is for (Task 6).
 */
export const MemberName: React.FunctionComponent<MemberNameProps> = ({
  address,
  style,
  numberOfLines,
  ...opts
}) => {
  const resolved = useResolvedMemberName(address, opts);
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {resolved.isQnsVerified ? `${resolved.name}.q` : resolved.name}
    </Text>
  );
};
```

- [ ] **Step 6: Implement `identity/index.ts`**

```ts
export { IdentityScopeProvider, useIdentityContext } from './identityProvider';
export {
  identityFromMaps,
  selfLocalNameEntry,
  EMPTY_LOCAL_NAMES,
  EMPTY_ROSTERS_BY_SPACE,
} from './identityFromMaps';
export type { RosterNameRow, IdentitySources } from './identityFromMaps';
export { MemberName } from './MemberName';
export {
  useResolvedName,
  useResolvedMemberName,
  useMemberIdentity,
} from './useResolvedName';
export type { ResolvedMemberName, UseResolvedNameOptions } from './useResolvedName';
export { useNameResolver } from './useNameResolver';
export type { NameResolver } from './useNameResolver';
export type { MemberIdentity, IdentityScope } from '@quilibrium/quorum-shared';
```

- [ ] **Step 7: Run the render test — expect PASS**

Run: `npx jest __tests__/memberName.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 8: Full gates and commit**

```bash
npx jest && npx tsc --noEmit
git add identity/ __tests__/memberName.test.tsx
git commit -m "feat(identity): MemberName, useResolvedName and useNameResolver

Call sites pass an address; you cannot forget a field you never pass.
Resolution reads from memory and issues no request by default — enrich opts
in, and only the member sidebar must never use it.

MemberName does not render the avatar, unlike desktop's: mobile's avatar
ladder is correctly separate (a .q carries no picture). What must agree is
the initials, which take this component's resolved name."
```

---

### Task 5: The ROOT scope, carrying real data

**Files:**
- Create: `hooks/useMultiSpaceRosters.ts`
- Modify: `app/_layout.tsx:329-356`
- Test: `__tests__/rootIdentityScope.test.tsx`

**Do this BEFORE migrating any call site.** Desktop mounted providers surface by surface, hit a crash in the operator's hands (pinning a post threw `used outside <IdentityScopeProvider>`), and had to restructure. Mounting the root first means no migrated surface can ever be outside a provider.

**And the root must carry REAL data, not empty maps as a crash backstop.** Anything rendered from an app-level host inherits the root and would otherwise resolve nothing.

**Interfaces:**
- Produces: `useMultiSpaceRosters(spaceIds: string[]): Record<string, Record<string, RosterNameRow>>`

- [ ] **Step 1: Write the failing test**

Create `__tests__/rootIdentityScope.test.tsx`:

```tsx
/**
 * A component rendered with no provider of its own still resolves.
 *
 * This is the crash class desktop shipped: providers mounted surface by
 * surface, so an app-level modal host sat outside all of them and threw. The
 * root scope is what makes that unrepresentable.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { IdentityScopeProvider } from '@/identity/identityProvider';
import { MemberName } from '@/identity/MemberName';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('the root identity scope', () => {
  it('resolves a member for a descendant that mounts no provider of its own', () => {
    render(
      <IdentityScopeProvider
        rostersBySpace={{ 'space-1': { [ADDR]: { global_display_name: 'Alice' } } }}
        selfAddress={null}
      >
        <MemberName address={ADDR} spaceId="space-1" />
      </IdentityScopeProvider>,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('does not leak a per-space nickname into a DM-shaped resolution', () => {
    // defaultSpaceId is NOT merged. The root carries every space's rosters, so
    // without that rule a DM would inherit a nickname from an unrelated space —
    // invisible to anyone who has never set one, which is most testing.
    render(
      <IdentityScopeProvider
        rostersBySpace={{ 'space-1': { [ADDR]: { display_name: 'Mod Alice', global_display_name: 'Alice' } } }}
        selfAddress={null}
        locallyKnownNames={{ [ADDR]: 'Alice' }}
      >
        <MemberName address={ADDR} />
      </IdentityScopeProvider>,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.queryByText('Mod Alice')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest __tests__/rootIdentityScope.test.tsx`
Expected: FAIL on the second case if `defaultSpaceId` were merged; PASS on the first once Task 4 is in. If BOTH pass immediately, verify the second is not vacuous by temporarily adding `spaceId="space-1"` to the provider — it must go red.

- [ ] **Step 3: Implement `hooks/useMultiSpaceRosters.ts`**

```ts
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import type { RosterNameRow } from '@/identity/identityFromMaps';

/**
 * `spaceId -> address -> name slots`, for every space passed.
 *
 * Reads MMKV, not the network. A roster is a local memory-mapped read, so
 * carrying every space's rosters at the app root costs no requests — which is
 * what makes it affordable for the root scope to hold real data rather than
 * empty maps.
 *
 * A space whose read has not resolved yet contributes `{}` rather than being
 * absent. That is deliberate and safe ONLY because the provider merges
 * rosters per ADDRESS: an empty entry contributes nothing instead of blanking
 * whatever an ancestor already knew for that space.
 */
export function useMultiSpaceRosters(
  spaceIds: string[],
): Record<string, Record<string, RosterNameRow>> {
  const ids = useMemo(() => Array.from(new Set(spaceIds.filter(Boolean))).sort(), [spaceIds]);

  const queries = useQueries({
    queries: ids.map((spaceId) => ({
      queryKey: ['identity-roster', spaceId],
      queryFn: async (): Promise<Record<string, RosterNameRow>> => {
        const members = await getMMKVAdapter().getSpaceMembers(spaceId);
        const map: Record<string, RosterNameRow> = {};
        for (const m of members) {
          const row = m as unknown as {
            address?: string;
            display_name?: string | null;
            global_display_name?: string | null;
          };
          if (row.address) {
            map[row.address] = {
              display_name: row.display_name,
              global_display_name: row.global_display_name,
            };
          }
        }
        return map;
      },
      staleTime: 30 * 1000,
      gcTime: 10 * 60 * 1000,
    })),
  });

  const updatedAtKey = queries.map((q) => q?.dataUpdatedAt ?? 0).join('|');
  return useMemo(() => {
    const out: Record<string, Record<string, RosterNameRow>> = {};
    ids.forEach((spaceId, i) => {
      out[spaceId] = queries[i]?.data ?? {};
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, updatedAtKey]);
}
```

- [ ] **Step 4: Mount the root scope**

In `app/_layout.tsx`, inside `ToastProvider` (so it is above every screen and every modal host, and below auth so `selfAddress` is available), add a small component. Its imports:

```tsx
import { useAuth } from '@/context/AuthContext';
import { useSpaces } from '@/hooks/chat';
import { useMultiSpaceRosters } from '@/hooks/useMultiSpaceRosters';
import { IdentityScopeProvider, selfLocalNameEntry } from '@/identity';
```

```tsx
function RootIdentityScope({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { data: spaces } = useSpaces();
  const spaceIds = React.useMemo(
    () => (spaces ?? []).map((s: { spaceId?: string; id?: string }) => s.spaceId ?? s.id ?? '').filter(Boolean),
    [spaces],
  );
  const rostersBySpace = useMultiSpaceRosters(spaceIds);
  const selfAddress = user?.address ?? null;
  // The device's own name, as the LAST global tier. Without it a user who
  // never published a public profile renders as their own address in their
  // own header. It can never supply a `.q` — a device name is not a QNS name.
  const locallyKnownNames = React.useMemo(
    () => selfLocalNameEntry(selfAddress, user?.displayName),
    [selfAddress, user?.displayName],
  );

  return (
    <IdentityScopeProvider
      rostersBySpace={rostersBySpace}
      selfAddress={selfAddress}
      locallyKnownNames={locallyKnownNames}
    >
      {children}
    </IdentityScopeProvider>
  );
}
```

Wrap the existing children of `ToastProvider` with `<RootIdentityScope>`. **No `spaceId` prop** — the root is always the global ladder; a Space screen refines it with its own provider.

- [ ] **Step 5: Verify the root actually mounts, by reading**

Run: `grep -n "RootIdentityScope" app/_layout.tsx`
Expected: the component is defined and used, inside `ToastProvider`.

**Also confirm the modal hosts are inside it.** Mobile mounts modals inside route trees (`SpaceSettingsModal` at `app/(tabs)/spaces/[id]/index.tsx:178`, `ReactionDetailsModal` at `components/Chat/MessagesList.tsx:1685`), so they should already be covered — but `SpaceSettingsModal` is `React.lazy`, so confirm the provider is above the Suspense boundary, not inside it.

- [ ] **Step 6: Full gates and commit**

```bash
npx jest && npx tsc --noEmit && yarn lint
git add hooks/useMultiSpaceRosters.ts app/_layout.tsx __tests__/rootIdentityScope.test.tsx
git commit -m "feat(identity): one root scope above every screen, carrying real data

Mounted before any call site migrates, deliberately: desktop mounted
providers surface by surface and shipped a crash where an app-level modal
host sat outside all of them.

The root carries every space's rosters plus the device's own name, not empty
maps. Rosters are a local MMKV read, so this costs no requests, and anything
rendered from an app-level host can now resolve. Empty maps would have been
a crash backstop that still rendered addresses."
```

---

## Phase C — the two visible wins

Do these before the bulk. They are what turns this from "a refactor you take on faith" into "two things that were wrong now work".

### Task 6: Avatar initials stop coming from a wallet address

**Files:**
- Modify: `components/ui/DefaultAvatar.tsx:27-40`, `components/ui/CachedAvatar.tsx:67`
- Modify: `__tests__/rawNameFieldAudit.test.ts` (remove both rows)
- Test: `__tests__/defaultAvatarInitials.test.tsx`

`DefaultAvatar` does `displayName || address || ''`, so a member with no per-space nickname gets initials derived from their wallet address, sitting beside a correctly resolved label. Desktop shipped and fixed the same bug. Here it is in the shared primitive, so **every caller inherits it and one change fixes them all**.

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * Initials must come from the name being displayed, never from an address.
 *
 * `Qm7f3a…` yields "Q" — a letter that belongs to no member, next to a label
 * showing their real name. The operator's rule: the initials always render
 * whatever the displayed name is at that moment.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('DefaultAvatar initials', () => {
  it('uses the resolved name', () => {
    render(<DefaultAvatar resolvedName="Alice Smith" address={ADDR} size={40} />);
    expect(screen.getByText('AS')).toBeTruthy();
  });

  it('renders a neutral placeholder rather than initials from an address', () => {
    render(<DefaultAvatar resolvedName={undefined} address={ADDR} size={40} />);
    expect(screen.queryByText('Q')).toBeNull();
    expect(screen.queryByText('QM')).toBeNull();
  });

  it('strips a .q before deriving initials', () => {
    // getInitials splits on non-letters, so "gatto.q" would yield two initials
    // from one name.
    render(<DefaultAvatar resolvedName="gatto.q" address={ADDR} size={40} />);
    expect(screen.getByText('G')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `npx jest __tests__/defaultAvatarInitials.test.tsx`
Expected: FAIL — `resolvedName` is not a prop; the address case renders "Q".

- [ ] **Step 3: Rename the prop and delete the address fallback**

In `components/ui/DefaultAvatar.tsx`, rename `displayName` to `resolvedName`, and replace `const name = displayName || address || '';` with:

```ts
  // No address fallback. Initials from `Qm7f3a…` are a letter belonging to
  // nobody, rendered beside a label showing the member's real name. When there
  // is no name, a neutral placeholder is honest and initials are not. The
  // `.q` is stripped because getInitials splits on non-letters and would
  // otherwise make two initials out of one name.
  const name = (resolvedName ?? '').replace(/\.q$/i, '').trim();
```

Then make the render branch on `name` being empty and show the existing neutral glyph.

- [ ] **Step 4: Fix every caller the rename breaks**

Run `npx tsc --noEmit` and fix each error by passing a resolved name. For callers that have an address and a provider, use `useResolvedMemberName(address).name`. For callers already holding a resolved string, pass it through.

- [ ] **Step 5: Run the test and the suite**

Run: `npx jest`
Expected: all green.

- [ ] **Step 6: Prove it red**

Restore `|| address` in the `name` expression. Expect "renders a neutral placeholder" to fail. **Put it back.**

- [ ] **Step 7: Remove both rows from the audit ratchet and commit**

```bash
npx jest && npx tsc --noEmit && yarn lint
git add components/ui/DefaultAvatar.tsx components/ui/CachedAvatar.tsx __tests__/defaultAvatarInitials.test.tsx __tests__/rawNameFieldAudit.test.ts
git commit -m "fix(identity): avatar initials come from the name, never an address

DefaultAvatar did displayName || address, so a member with no per-space
nickname got initials from their wallet address beside a correctly resolved
label. The prop is now resolvedName and there is no address fallback: a
neutral placeholder is honest where initials are not.

The bug was in the shared primitive, so every caller inherited it and this
one change fixes them all. RED proof: restoring || address turns the
placeholder test red."
```

### Task 7: The invite contact picker resolves

**Files:**
- Modify: `components/ShareInviteSheet.tsx:74,87,173,182-183`
- Modify: `__tests__/shareInviteSheetName.test.tsx` (delete `.failing`)
- Modify: `__tests__/rawNameFieldAudit.test.ts` (remove the row)

The RED test already exists and is marked `it.failing`. Jest will error the moment this task succeeds, asking for the marker to be removed — that is the signal the task is done.

- [ ] **Step 1: Confirm the test is still red for the right reason**

Temporarily change `it.failing` to `it` and run it. Read the failure output: it must show the row rendering `Alice Smith`, not a crash or an empty list. Restore `.failing`.

- [ ] **Step 2: Route conversations through the QNS-name hook**

Wrap the `useConversations` result in `useConversationsWithQnsNames` (`hooks/chat/useConversationsWithQnsNames.ts`), the hook the DM list already uses. Its cost objection does not apply here: the addresses are DM partners the conversation list has already fetched under the same key with a 1h cache, so it is a cache read.

- [ ] **Step 3: Render through the resolver and delete the hand-rolled fallbacks**

Replace `label={conv.displayName || truncateAddress(conv.address)}` with `<MemberName address={conv.address} enrich />` (the picker is the user's own bounded contact list, so it enriches — see Task 4). Delete `|| truncateAddress(...)` at line 173, `|| 'recipient'` at line 87, and stop threading `conv.displayName` into `handleSendToDM` at 182-183; resolve inside instead with `useNameResolver().resolve`.

- [ ] **Step 4: Delete `.failing` and run**

Run: `npx jest __tests__/shareInviteSheetName.test.tsx`
Expected: PASS as a plain `it`.

- [ ] **Step 5: Remove the ratchet row, run the gates, commit**

```bash
npx jest && npx tsc --noEmit && yarn lint
git add components/ShareInviteSheet.tsx __tests__/shareInviteSheetName.test.tsx __tests__/rawNameFieldAudit.test.ts
git commit -m "fix(identity): the invite picker resolves a contact's name

Rendered conv.displayName raw and re-derived a fallback the resolver owns,
so a contact who elected a .q was listed under their old global name. The
render test written against this bug goes from it.failing to a plain it."
```

---

## Phase D — the bulk migration

**Dispatch one subagent per ROW below.** They are independent files. Give the subagent this recipe verbatim plus its row; it must not need to read other tasks.

### The recipe every migration subagent follows

- [ ] **Step 1: Read the constraints.** The Global Constraints section of this plan, and `reports/2026-08-11-mobile-identity-migration-survey.md` §7.3. Do not re-derive the merge rules or the `defaultSpaceId` rule; they are settled and getting them wrong is invisible in testing.

- [ ] **Step 2: Write a render test pinning the CORRECT behaviour, including the `.q`.**

Create `__tests__/migrated/<Surface>.test.tsx`, modelled on `__tests__/memberName.test.tsx`. The load-bearing case is always:

> a member with NO per-space nickname, a global name, and a verified QNS name must render `<qns>.q` — the follow-global default state.

Add a second case with a per-space nickname, which must render the nickname and no `.q`.

- [ ] **Step 3: Run it and watch it FAIL.** If it passes before the migration, it is pinning nothing — rewrite it until it fails. Read the failure output and confirm the surface rendered the WRONG NAME rather than crashing.

- [ ] **Step 4: Migrate.**
  - Replace a raw name read with `<MemberName address={...} />`, or `useResolvedName(address)` where a string is needed.
  - Add `enrich` unless the surface renders an unbounded list. Only the member sidebar is unbounded.
  - **Delete any caller-supplied fallback** (`|| 'Unknown'`, `|| truncateAddress(...)`, `|| address.slice(0, 8)`). The resolver owns the fallback.
  - If the surface carries its own spaceId, pass it: `<MemberName address={a} spaceId={s} />`.
  - If the surface is reachable from both a channel and a DM, do **not** pass a DM's id as a `spaceId` — it queries a space that does not exist and forces the space ladder where the global one is correct.
  - Mount an `IdentityScopeProvider` only if the surface is a detached host that needs its own scope; the root already covers everything else.
  - **If your surface builds a React element eagerly and hands it to a host** (a modal `preview` prop, a confirmation body), remember context resolves where an element is RENDERED, not where it is created. It will resolve under the HOST's provider, not yours. Desktop shipped a mention showing a raw address in a pin/delete confirmation while the identical mention rendered correctly in the panel behind it. Pass the address and let the host render, or give the host its own scope.

- [ ] **Step 5: Remove your file's row from `__tests__/rawNameFieldAudit.test.ts`.**

- [ ] **Step 6: Verify.** All three must pass:

```bash
npx jest
npx tsc --noEmit    # still 12
yarn lint           # no new findings
```

- [ ] **Step 7: Commit.** `git commit -m "refactor(identity): <surface> resolves via MemberName"`

### Migration table

Rows 1-3 first and separately: they are the classes with a security or correctness edge. The rest are mechanical.

| # | File | Surface | Scope | Note |
|---|---|---|---|---|
| 1 | `components/SocialFeed/content/QuorumIdentityBadge.tsx` | identity badge | global | **FORGERY.** Appends `.q` itself from a raw field, bypassing the guard. Nothing outside `identity/` may append that suffix. |
| 2 | `components/Chat/DirectMessagesList.tsx` | DM list row | global | **PLACEHOLDER CLASS.** Hand-rolls truncation then `|| 'Unknown'`. A stored placeholder rendered verbatim is worse than the resolver's own fallback; check for a stored raw address too. |
| 3 | `components/ui/AppTabBar.tsx` | your own avatar | global | **INVERTED LADDER.** `displayName \|\| primaryUsername` ranks the global name above the `.q` for self. |
| 4 | `components/Chat/DMChatArea.tsx` | DM identity rows + header | global | Builds identity rows from raw fields and hand-truncates with `address.slice(0, 8)`. |
| 5 | `components/Chat/DMChatHeader.tsx` | DM header | global | Passes an unresolved title into the avatar. |
| 6 | `components/Chat/DMSettingsSheet.tsx` | DM settings | global | Renders an unresolved name in the header AND in destructive-action confirmation copy. |
| 7 | `components/Call/InCallScreen.tsx` | in-call | global | Raw `recipientDisplayName` off the call payload. |
| 8 | `components/Call/IncomingCallScreen.tsx` | incoming call | global | Raw `callerDisplayName`. |
| 9 | `components/Call/OutgoingCallScreen.tsx` | outgoing call | global | Raw `recipientDisplayName`. |
| 10 | `components/BlockUserModal.tsx` | moderation | context | Unresolved `userName` into the avatar. |
| 11 | `components/KickUserModal.tsx` | moderation | context | Unresolved `userName` into the avatar. |
| 12 | `components/MuteUserModal.tsx` | moderation | context | Unresolved `userName` into the avatar. |
| 13 | `components/UserProfileModal.tsx` | profile modal | context | Hand-composes `userName` + `primaryUsername` as separate pieces. Also fix the raw `member.bio` reads its four callers pass (see the filed bio issue) by adding `resolveMemberBio` beside `resolveMemberAvatar`. |
| 14 | `components/wallet/TipModal.tsx` | tip recipient | global | Raw `recipientQuorumIdentity.displayName`. |
| 15 | `components/SocialFeedModal.tsx` | DM conversation rows | global | MIXED: cast authors are Farcaster and stay; `conv.displayName` is a Quorum name and must resolve. |
| 16 | `components/Chat/FarcasterDirectMessageView.tsx` | conversation title | global | MIXED: same split as row 15. |
| 17 | `components/Chat/MessagesList.tsx` | message headers, reaction list | context | Already imports the resolver; move to `<MemberName>` and add `enrich`. Also carries three of the bio issue's four call sites. |
| 18 | `components/Chat/MessageInput.tsx` | mention autocomplete | context | Enrichment is owned by the RENDERING row, never the filtering hook, so filtering and display cannot disagree. Extend matching to the resolved name, OR'd onto the existing raw-field match. |
| 19 | `components/Chat/MentionableText.tsx` | rendered mention pills | context | Use `useNameResolver`, once at the top, not a hook per pill. |
| 20 | `components/Chat/MessageMarkdownRenderer.native.tsx` | markdown mentions | context | Same shape as row 19. |
| 21 | `components/Chat/ReactionDetailsModal.tsx` | reactor list | context | `useNameResolver` over the reactor set. |
| 22 | `components/SpaceSettingsModal.tsx` | member list | context | **The ONE surface that must NOT enrich** — a whole Space's membership. Keep `useMembersWithCachedQns`, which reads the cache with `enabled: false`. |
| 23 | `components/HeaderAvatar.tsx`, `components/UnifiedProfileHeader.tsx` | your own header | global | **JUDGEMENT — main thread.** Merges `resolveSelfName` into the one path. Keep the live auth profile as a source; it is what lets a space created after your last profile save render your name with no network call. Do this LAST. |
| 24 | `utils/conversationTitle.ts`, `utils/messagePreview.ts`, `services/notifications/logMentionOrReply.ts` | receive path | n/a | **JUDGEMENT — main thread. Do NOT convert these to hooks.** They run inside WebSocket handlers, outside React. They keep using the pure `resolveMemberName`, which structurally cannot mint a `.q` because verification needs React. That degradation is correct and pre-existing. |
| 25 | `components/Chat/BookmarksPanel.tsx:111` | bookmark sender | `spaceId={bookmark.spaceId}` | **FROZEN NAME.** Renders `cachedPreview?.senderName ?? 'Unknown'` — a name frozen at bookmark time, so it never learns a rename or a `.q`. Resolve from `cachedPreview.senderAddress` + the stored `spaceId` instead, and delete the `'Unknown'`. **Leave the write side alone** (decision 5.3): rows written by older builds must keep loading. First check whether `bookmarks` reaches the panel filtered to the current space — if not, the panel needs `useMultiSpaceRosters` like the root does. |
| 26 | `hooks/useUnifiedNotifications.ts:116`, `hooks/chat/useSpaceActivity.ts:19` | notification + activity sender | `spaceId={row.spaceId}` | **FROZEN NAME.** Same shape as row 25 over `senderName` / `lastMessageSenderName`. These surfaces are global (they span spaces), so they need a multi-space roster map. Stop reading the stored field; keep writing it. |

**`components/Call/SpaceCallScreen.tsx` was a hole in this table**, found by the
Task 6 review rather than by the table. Rows 7-9 cover the DM call screens only.
Its three `DefaultAvatar` sites passed an address and no name at all, which
`tsc` cannot see because the prop is optional. Fixed in Task 6 (commit
`70bac8c`) via `useNameResolver` once at the top of the grid, so it needs no row
of its own — but if you are looking for surfaces this table missed, look for
avatars, not labels.

**The ratchet has a SECOND blind spot, distinct from the frozen-name one below.**
It greps for raw name-field *reads*. A surface that reads no name field at all
and simply renders an address — or renders nothing where a name belongs — matches
nothing and is invisible to it. That is exactly how `SpaceCallScreen` escaped.
Neither blind spot has an instrument; both are why Task 9's manual sweep is not
optional.

**Rows 25-26 were NOT found by the audit ratchet, and that is worth knowing.**
`rawNameFieldAudit` matches five spellings of a *name field* (`displayName`,
`primary_username`, …). A frozen `senderName` on a cached preview matches none of
them, so the instrument is blind to the whole frozen class. They are in this
table because decision 5.3 put them there, not because a tool found them. If you
add a surface that stores a rendered name, no test will catch it.

---

## Phase E — close it out

### Task 8: Drive the ratchet to zero and lock the primitives

- [ ] **Step 1: Confirm `TO_MIGRATE` in `__tests__/rawNameFieldAudit.test.ts` is empty.** If any entry remains, it is a Phase D row that was not done; do not delete it to make the suite pass.

- [ ] **Step 2: Repoint the import condition.** Change `RESOLVER_IMPORT` to match `@/identity`, and add `identity/` to the scan exclusions.

- [ ] **Step 3: Add a primitives guard.** A new test asserting that no file outside `identity/` and `utils/resolveMemberName.ts` imports `resolveIdentity` from shared or `identityFromMaps`.

**Restrict the PRIMITIVES, not the deleted modules.** Desktop's first version listed the modules being deleted, so after cleanup it was a tombstone that could never fire.

- [ ] **Step 4: Prove it red.** Add a throwaway `import { resolveIdentity } from '@quilibrium/quorum-shared';` to a component. Watch the test fail, naming the file. Remove it.

- [ ] **Step 5: Commit.**

### Task 9: Sweep with the fake-QNS overlay, with a control arm

**Desktop never ran this**, and its handoff says so plainly. Live testing substituted and still found five bugs. Mobile has its own overlay (`services/dev/fakeQns.ts`, `components/dev/QnsFakePanel.tsx`), so mobile can do the pass desktop skipped.

- [ ] **Step 1:** In a dev build, enable a `.q` for yourself and for everyone.
- [ ] **Step 2: Pin one address to a known non-QNS name as the CONTROL ARM.** With everyone named there is nothing to compare against; if the control row also changes, the instrument is wrong rather than the code.
- [ ] **Step 3:** Walk every surface in the Phase D table plus your own profile header and the tab bar. Leave and re-enter a screen before believing a negative.
- [ ] **Step 4: Report per surface, MEASURED not inferred.** Any failure becomes its own Phase D row.

### Task 10: Two-bot harness

- [ ] Run `yarn harness:qns`. It asserts wire DELIVERY and claim REJECTION on stored rows — **it does not assert rendered names**, so it is not a substitute for Task 9. It is the only instrument for the receive path, because Triple Ratchet participants cannot decrypt their own echoed messages.

### Task 11: The provider-wiring instrument

- [ ] Port desktop's `diagnostics.ts` idea: in dev builds, record every resolution that fell through to the truncated address, with the address, the scope, and which sources were missing. Reconcile with the existing open task for an identity-coverage instrument rather than building it twice.

**This is the class the render tests cannot see** (survey §7.2). "0 degraded resolutions this session" is a readable positive signal; a green suite is not.

Desktop's known blind spot, inherited if ported verbatim: it cannot distinguish "nobody knows this person" from "this provider was never fed local names", because an absent prop and an empty one both arrive as `{}`.

### Task 12: Update the parity index

- [ ] Delete the shared echo-demotion item from `issues/2026-08-06-qns-primary-name-work-and-desktop-parity.md` as absorbed, and say so, so it does not read as dropped.

---

## Definition of done

- [x] `@quilibrium/quorum-shared` at `2.1.0-42`, suite green with no assertion edited (Task 1)
- [x] The `.q` tier is reachable only from verified names, RED-proven (Task 2)
- [x] Nested providers merge; `defaultSpaceId` does not; RED-proven (Task 3)
- [x] One root scope above every screen, carrying real rosters (Task 5)
- [x] Avatar initials never derived from an address (Task 6)
- [x] The invite picker's `it.failing` is a plain `it` (Task 7)
- [x] `TO_MIGRATE` empty; primitives guard shown red (Task 8)
- [ ] Fake-QNS sweep run with a control arm, reported per surface (Task 9) — **needs a dev build; not runnable from here**
- [x] `yarn harness:qns` passes (Task 10) — MEASURED 2026-08-13 against the production relay, both roles green
- [ ] Degraded-resolution diagnostic reporting zero on a normal session (Task 11) — **not built; needs a dev build to be worth anything**

## Outcome

51 commits. 24 live surfaces migrated, 795 → 918 tests, `TO_MIGRATE` empty and
the raw-field audit converted from a migration tracker into a permanent guard,
joined by a second guard restricting the primitives themselves. Both were shown
to fire against a live violation, not merely to pass.

**What Task 10 proved, on real infrastructure** (MEASURED, 2026-08-13, production
relay, both bot roles): a `.q` claim crosses the wire, is stored under the
separate `claimed_primary_username` key, and the receiving side **refuses to
verify it**. That is the receive-path half of the forgery guarantee, end to end,
with no mocks.

**What the render half rests on:** a real derivable ed448 key/address pair, with
`@/utils/verifyQnsClaim` unmocked, so `claimedNameBelongsTo` actually runs.
Impersonation is proven at four levels — the predicate, the provider wiring, and
three separate render surfaces — and a single mutation to the predicate turns all
four red simultaneously.

**Fetch fan-out is bounded and measured, not argued.** MessagesList 60 → 50,
ReactionDetailsModal 80 → 50, ShareInviteSheet 60 → 50, BookmarksPanel 80 → 50,
notifications 80 → 50, ThreadDetailView 61 → 50, DirectMessagesList 60 → 50, and
`SpaceSettingsModal` — whose cardinality is the whole community — **0** on a
200-member roster.

### Known gaps, deliberately left

- **Tasks 9 and 11 need a device.** The fake-QNS sweep with a control arm, and
  the degraded-resolution diagnostic, are the two things automated tests cannot
  substitute for. Task 9 in particular is what would catch a surface that
  resolves correctly in a test and wrongly in the real provider tree — desktop
  stayed green through eight provider-wiring bugs.
- **`useQuorumIdentityForFid` still fans out uncapped**, one fid-link lookup per
  rendered cast. Different endpoint, pre-dates this work, filed separately at
  `issues/.open/2026-08-13-quorum-identity-badge-fires-an-uncapped-fid-link-lookup-per-cast.md`.
- **`components/Chat/DirectMessagesList.tsx` is dead code.** Capped anyway so a
  future revival inherits the right shape; deletion left as a proposal under the
  pre-existing `issues/.open/2026-06-21-dm-favorites-sync-and-wire.md`.
- **`components/Chat/BookmarksPanel.tsx` is not reachable YET — do not delete it.**
  Bookmarks can already be *created* (`addBookmark` is wired into both
  `app/(tabs)/spaces/[id]/[channelId].tsx` and `app/(tabs)/messages/dm/[id].tsx`),
  but the panel listing them is mounted behind a `bookmarksPanelVisible` flag in
  `SpaceChatArea.tsx:883` / `DMChatArea.tsx:603` that nothing sets to `true`.
  **The bookmarks screen is being built and lands within days** (confirmed by the
  operator 2026-08-13), so this is pre-emptive, not dead. Row 25's frozen-name
  fix means that screen ships resolving names correctly rather than shipping the
  bug and needing a follow-up.

  Unlike `DirectMessagesList`, this is NOT a deletion candidate.

  **When the screen lands, the one thing to check** is a bookmark created BEFORE
  you had a `.q`: it must render your current resolved name, not the string
  frozen at bookmark time. That is the whole point of the row and the only case
  that distinguishes a working fix from a broken one.

  **Recorded because the review process did not catch the reachability gap, and
  the reason is instructive:** every brief asked implementers "what renders this
  surface", which is satisfied by finding the JSX. Both the implementer and an
  opus reviewer answered correctly and both missed it. The question that catches
  this class is "what user action opens this, and can a user reach it today".
  Fix the brief template, not the reviewers.
- **Three `act(...)` warnings** remain in `ModerationModals.test.tsx` and
  `UserProfileModal.test.tsx`. Confirmed to pre-date this work, but inconsistent
  with the pristine-output standard the rest of the branch holds to.
- **The guards are grep-shaped**, and say so. A dynamic `require()`, a namespace
  import or a re-export chain would not be seen. Three blind-spot classes are
  documented in the Phase D table.
- **tsc baseline is 11, not 12.** `components/BrowserModal.tsx` stopped erroring
  when a `patch-package` postinstall reapplied; re-measured independently.

---

*Last updated: 2026-08-13*
