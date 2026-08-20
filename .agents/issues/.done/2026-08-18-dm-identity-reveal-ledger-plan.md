---
type: task
title: "DM identity: fix the cross-client dialect break, then make identity reveal an explicit, privacy-gated ledger"
status: done
priority: high
created: 2026-08-18
updated: 2026-08-20
area: DM identity / privacy / cross-client parity
repos: quorum-mobile (Tasks 1-8, shipped), quorum-desktop (§D — five items, verified against source 2026-08-19, NOT started; D1 is required to complete the mobile work), quorum-shared (§S — one small typed field plus a documented envelope shape, NOT started)
related:
  - "quorum-desktop/.agents/issues/2026-08-01-dm-partner-identity-lost-on-established-sessions.md (the established-session measurement this plan builds on)"
  - "quorum-desktop/.agents/issues/2026-08-01-space-member-identity-announce-on-connect.md (§7 names receiver-driven as the best shape — that is future work F, not this plan)"
  - "issues/.open/2026-06-26-dm-self-profile-overwrites-partner-row.md (the stale-closure trap this plan must not re-trip)"
  - "issues/2026-08-11-mobile-identity-resolution-plan.md (the resolution ladder these fixes feed)"
---

# DM Identity Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Status

**2026-08-20 — SHIPPED in PR #263** (`fix(dm): a desktop rename reaches mobile
again, and identity only reaches partners you chose to message`), squash-merged
to `master` as `755cd93`. 24 commits.

What landed: mobile's whole half of this plan. Tasks 1-8 complete — the
dual-dialect parser, the roster invalidation, the address-out-of-name-slots fix,
the persisted reveal ledger, the consent-filtered broadcast sweep,
reveal-on-reply, auto-reveal to a known partner's new device, and identity on
init envelopes only for deliberate sends. Two live privacy leaks closed along the
way, one of which (the delete-conversation signal) this plan had not predicted.

**V4 was automated rather than run by hand** — `yarn harness:reveal`
(`dev/harness/dm-reveal-two-bot.scenario.ts`), two headless mobile clients
against the production relay. GREEN as shipped, and MEASURED red-on-revert:
disabling the sweep's consent filter produces `broadcast to 1/1 partner(s)` with
the name arriving on the stranger. See §V.

Also verified on the Android emulator, 2026-08-20: the self-overwrites-partner
trap was NOT re-tripped, and the removal of address-as-name did not leave blank
names (the render layer still falls back to a truncated address —
`identity/useResolvedName.ts:47-52`, covered by 14 passing tests).

**Still open, and deliberately not in this repo's scope:**

- **§D and §S moved to their own plan**, now that they have been verified against
  the desktop source rather than guessed at:
  `quorum-desktop/.agents/issues/.open/2026-08-20-dm-identity-reveal-desktop-and-shared-plan.md`.
  Four tasks, fourteen evidence anchors. **D1 matters most: this branch fixed
  desktop → mobile only. mobile → desktop is still broken**, and worse than the
  bug this fixed — desktop persists the frame as a ghost message rather than
  dropping it.
- **§V lanes V1-V3 remain manual**, and are blocked on D1: with mobile → desktop
  broken, a cross-client failure has two indistinguishable explanations.
- The three follow-ups listed below, plus two more bugs found while verifying on
  device (neither caused by this work):
  `issues/.open/2026-08-20-config-sync-silently-reverts-a-display-name-rename.md`
  and the device-confirmed half of the self-rename issue.

### Historical — state at branch completion, before merge

**All 8 tasks implemented and reviewed, 2026-08-19, on branch
`feat/dm-identity-reveal-ledger`.**

Gates MEASURED at branch completion:
`npx jest` 125 suites / 1180 tests all passing (baseline 119/1140) ·
`npx tsc --noEmit` exactly 12 pre-existing errors (unchanged) ·
`yarn lint` 302 errors / 173 warnings (unchanged).

Every task was implemented by a fresh agent, then reviewed by an independent
one, with fix rounds until clean, then a whole-branch review. Verdict: READY TO
MERGE, no Critical findings, no ungated identity-emission path found.

### What changed versus this plan as written

- **§P's emission table stands, but the operator restated the rule** (2026-08-19)
  and it now governs where the two differ: *"The sender of the DM's identity IS
  shown to the receiver. It's just the receiver's identity that is not shown
  until they reply (unless they already had previous conversations/sessions with
  the same sender."* Initiating is itself the consent; the asymmetry is
  deliberate.
- **Calls were brought under that rule**, which this plan did not cover.
  `sendSignal` in `context/CallContext.tsx` now takes an explicit opt-in identity
  parameter defaulting to silence. Placing a call (offer) and answering one
  (answer) attach identity and record the reveal through `onDeliberateDmSend`;
  the other six signal sites (ICE ×2, hangup, event, renegotiation, circuit
  rotation) attach nothing.
- **Task 8's audit found a real, previously-live leak** the plan had not
  predicted: `hooks/chat/useDeleteConversationSignal.ts` sent your `display_name`
  to a never-replied stranger when you deleted their conversation, via the
  `accept`-shaped session envelope, with no ledger check anywhere in that path.
  Fixed.
- **Task 4's Step 5 RED proof was unfalsifiable as specified.** The jest MMKV
  mock wraps a plain `Map` that cannot throw, so `hasRevealedTo`'s catch branch
  was unreachable from any test — flipping the fail direction left the suite
  green. Tests that make storage genuinely throw were added; the proof now fires.
- **`sendProfileToPartner`'s signature is wider than §Task 5 specified.**
  It takes `SendProfileDeps`, and `buildSendProfileDeps(base: DMBroadcastDeps)`
  is the seam single-partner callers use. Tasks 6 and 7 keep the narrow public
  signature this plan specified and call the builder internally.
- **Task 3 touched 9 sites, not 7** — an unbriefed third `substring(0, 8)` at
  the old line 3773 turned out to be a discarded `saveMessage` argument.

### Deliberately NOT done (filed separately)

- `issues/.open/2026-08-19-self-rename-name-stale-outside-websocket-context.md`
- `issues/.open/2026-08-19-batch-decrypt-path-skips-auto-reveal-for-call-frames.md`
- `issues/.open/2026-08-19-fire-and-forget-dynamic-imports-lack-catch.md`
- §D (the desktop mirror) and §Q (the wire-shape and `request-profile` questions)
  remain open, exactly as this plan scoped them.

### What still needs a human on a device

The §V lanes below, plus one new call-specific lane derived from the batch-path
finding. No automated test on this branch can cover real sockets, real push
delivery, or cross-device timing. **V4 is the control arm for the entire privacy
design: if it fails, stop, the rule is broken.**

**Goal:** A DM partner's name and avatar reach every device that is *entitled* to them — and never reach anyone who is not — across all four client pairings (mobile↔mobile, mobile↔desktop, desktop↔mobile, desktop↔desktop).

**Architecture:** Two halves. First, repair the transport: the `dm-update-profile` control message exists on both clients but they speak different dialects (desktop: flat object; mobile: wrapped in `content`), so cross-client identity pushes are silently consumed without applying — MEASURED, see §E. Second, make the product's privacy rule ("you do not see someone's name/pfp unless they reply to you") an explicit, persisted **reveal ledger** consulted by every identity emission site, instead of an emergent accident of transport races. The ledger is what makes the friend-on-a-new-device case work *within* the rule.

**Tech Stack:** TypeScript 5.9, React 19, React Native 0.81 / Expo SDK 54, MMKV 4 (`react-native-mmkv`), jest, yarn (never npm).

## Global Constraints

- **Package manager is yarn.** Never `npm install`.
- **Never run `expo prebuild`.** See `PREBUILD.md`.
- **Every fix ships with a test shown RED first.** Revert the fix, watch it go red, put it back. An assertion that passes either way is worse than no test.
- **Label every claim MEASURED / READ / INFERRED** in commit messages and reports.
- **No `.agents` paths in code comments.** State the reason inline instead.
- **Fixture addresses use the repo's placeholder family** (`QmPeerAEgV…`), never a real account address.
- **Stale-closure rule for `context/WebSocketContext.tsx`:** any value from React state read inside the big receive callbacks must go through a ref (`fullUserAddrRef` pattern). A direct `user?.address` read there is dead code — this exact bug shipped once already and cost weeks.
- **Gates before any task is done:** `npx jest` (all green, same suite count as the branch baseline), `npx tsc --noEmit` (must stay at the pre-existing error count, currently 12), `yarn lint` (no new findings; the ~300 `@tabler/icons-react-native` errors are baseline).
- **Privacy fail-direction is CLOSED.** Where a storage read fails, the answer is "do not reveal". This is deliberately the opposite of the send-gates (which fail open, because a redundant push is harmless). Both postures are correct for their own risk; do not "unify" them.

---

## §E. Evidence this plan is built on

| # | Claim | Status |
|---|---|---|
| E1 | Desktop pushed `dm-update-profile` to the emulator twice; mobile consumed both without applying (`[DM-recv] payload has no messageId — consuming without saving (batch)`, `type: dm-update-profile`, 16:14:35 and 16:24:00 on 2026-08-18) | **MEASURED** (adb logcat) |
| E2 | Desktop sends `dm-update-profile` FLAT: `{ type, senderId, displayName, userIcon }`, no `content`, no `messageId` (`quorum-desktop/src/services/MessageService.ts` `broadcastProfileToAllDMs`) | READ |
| E3 | Mobile sends it WRAPPED: full `Message` with `messageId: 'dm-profile-…'` and the payload under `content` (`services/dm/dmProfileService.ts` `buildDmProfileMessage`) | READ |
| E4 | Mobile's interceptor reads only `content.type` (`context/WebSocketContext.tsx` `applyDmProfileUpdate` ~line 736); desktop's reads only top-level `raw.type` (`MessageService.ts` ~line 907). Each client understands only its own dialect | READ |
| E5 | An **established** DM session never carries sender identity — only init-variant frames do (desktop docstring: "measured absent on every established-session frame") | MEASURED (desktop) |
| E6 | The responder's ONE init-carrying frame (the confirm) is usually spent by an automatic, identity-less receipt before the human finishes typing a reply (`[session-confirm] sender session CONFIRMED` at 16:00:16, minutes before the first reply could exist) | READ + INFERRED for the specific run |
| E7 | Space `update-profile` writes MMKV + updates `queryKeys.spaces.members`, but never invalidates `['identity-roster', spaceId]`, the query the name ladder reads. Avatar updates live, name waits for an app restart. Operator restarted the app and the name appeared | **MEASURED** (device, 2026-08-18) |
| E8 | Mobile's DM broadcast loop iterates ALL direct conversation rows with no replied-filter (`dmProfileService.ts:261-266` skips only self + farcaster); desktop's loop likewise. A row created by an inbound stranger message is included → identity is pushed to never-replied strangers (mobile→mobile it renders; cross-client it is currently masked by E1-E4) | READ |
| E9 | Mobile's init envelope carries `display_name` but never sets `user_icon`, though shared's `InitializationEnvelope` declares it (`quorum-shared/src/crypto/types.ts:124-130`; `hooks/chat/useSendDirectMessage.ts:761-781`) | READ |
| E10 | Mobile stamps `senderAddress.substring(0, 8)` into the conversation row's `displayName`, and `displayName \|\| userAddress` into envelope `display_name` — address prefixes stored in NAME slots, which poison the ladder's `locallyKnownNames` tier | READ |

## §P. The privacy rule, stated once

> **In a DM, you do not see the other person's name/pfp UNLESS they have deliberately messaged you.** Their client's automatic frames (delivery receipts, typing) must never reveal them.

Corollary the operator specified: **consent belongs to the relationship, not the session.** If I have ever deliberately messaged you, my client may (re-)announce my identity to any new device/session of yours without asking me again.

The mechanism: a persisted, per-device **reveal ledger** — `revealed(self → partner)` — set only by deliberate sends, consulted by every identity emission:

| Emission site | Ledger says NOT revealed | Ledger says revealed |
|---|---|---|
| My init envelope when **I** message someone | attach my name+icon (messaging someone IS the deliberate act — this sets the ledger) | same |
| My **first chat reply** in a conversation | this SETS the ledger + fires one `dm-update-profile` | already set; gate dedups |
| Inbound **new session** from a partner (their new device) | **silence** | auto-announce immediately — the operator's friend-on-a-new-device case |
| On-connect / on-rename rebroadcast | **skip this partner** (fixes E8) | allowed, gated as today |
| Receipts / typing / any automatic frame | never attach identity | never attach identity |

Why this is defensible: (1) no wire change — every message type and envelope field already exists on both clients; (2) the rule becomes one testable predicate instead of an accident of which frame wins a race; (3) fail-closed; (4) backward compatible — receivers become liberal (both dialects), senders unchanged; (5) it also *fixes a live privacy leak* (E8).

**Alternatives rejected** (keep for the lead-dev conversation):
- *Attach identity to every init-capable frame (incl. receipts):* breaks the rule — a spammer harvests your identity by messaging you, since acks are automatic.
- *Per-session consent:* would make B re-reveal manually for every new device of a decade-old friend. The operator explicitly wants relationship-level consent.
- *Receiver-driven `request-profile` only:* right long-term shape (future work F) but it is a wire change needing sign-off, and it does not fix the dialect break that eats the pushes we already send.
- *Rely on public profiles:* opt-in and rare; the measured case (B) has none.

---

## File Structure (mobile)

| File | Responsibility |
|---|---|
| `services/dm/dmProfileWire.ts` | CREATE (Task 1). Pure dual-dialect parser for `dm-update-profile`. The only place wire shapes are known. |
| `context/WebSocketContext.tsx` | MODIFY (Tasks 1, 2, 3, 7). Interceptor uses the parser; roster invalidation; drop address stamps; auto-reveal hook via ref. |
| `identity/invalidateRoster.ts` | CREATE (Task 2). One helper both update-profile paths call. |
| `services/dm/dmRevealLedger.ts` | CREATE (Task 4). The ledger: MMKV shim + pure decision + history bootstrap. |
| `services/dm/dmProfileService.ts` | MODIFY (Tasks 5, 6, 7). Stranger filter in the broadcast loop; extract `sendProfileToPartner`; `onDeliberateDmSend`; `autoRevealOnInboundSession`. |
| `hooks/chat/useSendDirectMessage.ts` | MODIFY (Tasks 6, 8). Reveal-on-send trigger; `user_icon` in init envelopes; drop the address fallback. |
| `hooks/chat/useSendDirectEmbedMessage.ts` | MODIFY (Tasks 6, 8). Same two changes. |
| `__tests__/dmProfileWire.test.ts`, `__tests__/dmRevealLedger.test.ts`, `__tests__/dmRevealTriggers.test.ts`, `__tests__/dmIdentitySourceGuards.test.ts` | Tests per task. |

Suggested PR slicing: **PR-1 = Tasks 1-3** (pure defect fixes, no behaviour policy change), **PR-2 = Tasks 4-8** (the ledger). Desktop mirror (§D) is its own PR in that repo.

---

### Task 1: Dual-dialect parser for `dm-update-profile` (fixes desktop→mobile, E1-E4)

**Files:**
- Create: `services/dm/dmProfileWire.ts`
- Modify: `context/WebSocketContext.tsx` (~lines 722-777, `applyDmProfileUpdate`)
- Test: `__tests__/dmProfileWire.test.ts`

**Interfaces:**
- Produces: `parseDmProfileUpdate(decrypted: unknown): DmProfileUpdatePayload | null` where `DmProfileUpdatePayload = { senderId?: string; displayName?: string; userIcon?: string; bio?: string; primaryUsername?: string }`. Returns `null` for anything that is not a `dm-update-profile` in either dialect.
- Consumed by: `applyDmProfileUpdate` (both DM receive paths already funnel through it — one wiring point covers live JS and native batch).

- [ ] **Step 1: Write the failing test**

Create `__tests__/dmProfileWire.test.ts`:

```ts
/**
 * dm-update-profile arrives in two dialects and BOTH must apply:
 *  - wrapped (mobile senders): a full Message, payload under `content`
 *  - flat (desktop senders):   { type, senderId, ... } at top level,
 *    no content, no messageId
 * The flat dialect was being consumed by the no-messageId backstop without
 * applying — measured live: a desktop rename never reached the mobile row.
 */
import { parseDmProfileUpdate } from '../services/dm/dmProfileWire';

const PARTNER = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('parseDmProfileUpdate', () => {
  it('parses the wrapped (mobile) dialect', () => {
    const wrapped = {
      messageId: 'dm-profile-1234',
      content: {
        type: 'dm-update-profile',
        senderId: PARTNER,
        displayName: 'Alice',
        userIcon: 'data:image/png;base64,AAA',
      },
    };
    expect(parseDmProfileUpdate(wrapped)).toEqual({
      senderId: PARTNER,
      displayName: 'Alice',
      userIcon: 'data:image/png;base64,AAA',
      bio: undefined,
      primaryUsername: undefined,
    });
  });

  it('parses the flat (desktop) dialect', () => {
    const flat = {
      type: 'dm-update-profile',
      senderId: PARTNER,
      displayName: 'Alice',
      userIcon: 'data:image/png;base64,AAA',
    };
    expect(parseDmProfileUpdate(flat)).toEqual({
      senderId: PARTNER,
      displayName: 'Alice',
      userIcon: 'data:image/png;base64,AAA',
      bio: undefined,
      primaryUsername: undefined,
    });
  });

  it('carries primaryUsername presence-exactly (empty string is an un-election)', () => {
    const flat = { type: 'dm-update-profile', senderId: PARTNER, primaryUsername: '' };
    expect(parseDmProfileUpdate(flat)?.primaryUsername).toBe('');
    const without = { type: 'dm-update-profile', senderId: PARTNER };
    expect(parseDmProfileUpdate(without)?.primaryUsername).toBeUndefined();
  });

  it('returns null for receipts and other flat control frames', () => {
    expect(parseDmProfileUpdate({ type: 'delivery-ack', senderId: PARTNER, messageIds: ['x'] })).toBeNull();
    expect(parseDmProfileUpdate({ type: 'read-ack', senderId: PARTNER })).toBeNull();
    expect(parseDmProfileUpdate({ type: 'typing-start', senderId: PARTNER })).toBeNull();
  });

  it('returns null for ordinary chat messages in both shapes', () => {
    expect(parseDmProfileUpdate({ messageId: 'm1', content: { type: 'post', senderId: PARTNER } })).toBeNull();
    expect(parseDmProfileUpdate({})).toBeNull();
    expect(parseDmProfileUpdate(null)).toBeNull();
  });

  it('prefers the wrapped payload when both shapes are somehow present', () => {
    // A wrapped message whose top level accidentally also says type: the
    // content payload is the authored one and must win.
    const both = {
      type: 'dm-update-profile',
      displayName: 'TopLevel',
      content: { type: 'dm-update-profile', senderId: PARTNER, displayName: 'Wrapped' },
    };
    expect(parseDmProfileUpdate(both)?.displayName).toBe('Wrapped');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest __tests__/dmProfileWire.test.ts`
Expected: FAIL — cannot find module `../services/dm/dmProfileWire`.

- [ ] **Step 3: Implement**

Create `services/dm/dmProfileWire.ts`:

```ts
/**
 * Wire dialects of the `dm-update-profile` control message.
 *
 * There are two on the network today, and both are live in shipped clients:
 *
 *  - WRAPPED: a full Message envelope, payload under `content`, synthetic
 *    `messageId` ('dm-profile-…'). What THIS client sends.
 *  - FLAT: the bare payload at top level — `{ type, senderId, displayName,
 *    userIcon, bio? }` — no `content`, no `messageId`. What desktop sends,
 *    the same family as its flat delivery/read-ack receipts.
 *
 * The receive path must accept BOTH. Before this parser existed the flat
 * dialect matched no interceptor and fell through to the no-messageId
 * backstop, which consumed it without applying — so a desktop partner's
 * rename never reached this device's conversation row, silently, forever.
 */
export interface DmProfileUpdatePayload {
  senderId?: string;
  displayName?: string;
  userIcon?: string;
  bio?: string;
  /** Presence-exact: '' is a deliberate un-election and must survive parsing. */
  primaryUsername?: string;
}

type AnyRecord = Record<string, unknown>;

function fieldsFrom(src: AnyRecord): DmProfileUpdatePayload {
  return {
    senderId: typeof src.senderId === 'string' ? src.senderId : undefined,
    displayName: typeof src.displayName === 'string' ? src.displayName : undefined,
    userIcon: typeof src.userIcon === 'string' ? src.userIcon : undefined,
    bio: typeof src.bio === 'string' ? src.bio : undefined,
    primaryUsername:
      typeof src.primaryUsername === 'string' ? src.primaryUsername : undefined,
  };
}

export function parseDmProfileUpdate(decrypted: unknown): DmProfileUpdatePayload | null {
  if (!decrypted || typeof decrypted !== 'object') return null;
  const msg = decrypted as AnyRecord;

  // Wrapped first: the content payload is the authored one, so it wins if
  // both shapes are somehow present on one object.
  const content = msg.content as AnyRecord | undefined;
  if (content && typeof content === 'object' && content.type === 'dm-update-profile') {
    return fieldsFrom(content);
  }
  if (msg.type === 'dm-update-profile') {
    return fieldsFrom(msg);
  }
  return null;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx jest __tests__/dmProfileWire.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire into `applyDmProfileUpdate`**

In `context/WebSocketContext.tsx`, replace the shape-reading head of `applyDmProfileUpdate` (currently `const content = decryptedMessage.content as … ; if (content?.type !== 'dm-update-profile') return false;`) with:

```ts
      const parsed = parseDmProfileUpdate(decryptedMessage);
      if (!parsed) return false;
```

and change every subsequent `content.<field>` read in that callback to `parsed.<field>`. The senderId anti-spoof check, the no-row drop, the merge semantics (truthy for displayName/userIcon, presence for bio/primaryUsername) and `scheduleConversationRefresh` all stay exactly as they are. Add the import at the top of the file:

```ts
import { parseDmProfileUpdate } from '@/services/dm/dmProfileWire';
```

Both DM receive paths (live JS and native batch) call `applyDmProfileUpdate` **before** their no-messageId backstops (READ: intercept at ~3524 vs backstop at ~3720; batch intercept at ~4994 vs its backstop), so this one change repairs both.

- [ ] **Step 6: Full gates**

Run: `npx jest` && `npx tsc --noEmit` && `yarn lint`
Expected: all green / baseline unchanged.

- [ ] **Step 7: RED proof, then commit**

Temporarily revert Step 5's wiring (restore the `content?.type` check), run `npx jest __tests__/dmProfileWire.test.ts` — still green (parser is pure), so ALSO run the live check in §V lane V1 OR add this static guard to the test file, which must go red on revert:

```ts
import * as fs from 'fs';
import * as path from 'path';

it('applyDmProfileUpdate goes through the dual-dialect parser', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
    'utf8',
  );
  expect(src).toMatch(/parseDmProfileUpdate\s*\(\s*decryptedMessage\s*\)/);
});
```

Restore, commit:

```bash
git add services/dm/dmProfileWire.ts __tests__/dmProfileWire.test.ts context/WebSocketContext.tsx
git commit -m "fix(dm): accept desktop's flat dm-update-profile dialect

Desktop sends the identity push flat (top-level type, no messageId);
mobile only recognized its own wrapped shape, so the flat frame fell
through to the no-messageId backstop and was consumed without applying.
MEASURED: two desktop pushes eaten this way in one session's logcat.
Both dialects now parse through one pure function; merge semantics
unchanged."
```

---

### Task 2: Invalidate the identity roster when a member row changes (fixes E7)

**Files:**
- Create: `identity/invalidateRoster.ts`
- Modify: `context/WebSocketContext.tsx` — both space `update-profile` handlers (JS ~line 2800 after `adapter.saveSpaceMember`, batch ~line 4629's equivalent write), plus any other `saveSpaceMember` call in this file that changes name slots (grep in Step 3)
- Test: `__tests__/invalidateRoster.test.ts`

**Interfaces:**
- Produces: `invalidateRosterCaches(queryClient: QueryClient, spaceId: string): void`

- [ ] **Step 1: Write the failing test**

Create `__tests__/invalidateRoster.test.ts`:

```ts
/**
 * Names and avatars read from DIFFERENT caches:
 *  - avatars: queryKeys.spaces.members(spaceId)  (updated in place by handlers)
 *  - names:   ['identity-roster', spaceId]       (read by the identity ladder)
 * The update-profile handlers updated only the first, so a partner's rename
 * showed its avatar immediately and its name only after an app restart.
 * MEASURED on device 2026-08-18: restart made the name appear.
 */
import { QueryClient } from '@tanstack/react-query';
import { invalidateRosterCaches } from '../identity/invalidateRoster';

describe('invalidateRosterCaches', () => {
  it('invalidates the identity-roster query for exactly that space', async () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    invalidateRosterCaches(qc, 'space-1');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['identity-roster', 'space-1'] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest __tests__/invalidateRoster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement and wire**

Create `identity/invalidateRoster.ts`:

```ts
import type { QueryClient } from '@tanstack/react-query';

/**
 * Tell the identity ladder a space's member rows changed on disk.
 *
 * The ladder's names come from ['identity-roster', spaceId] (an MMKV read,
 * observed at the app root for its whole life), NOT from
 * queryKeys.spaces.members. A permanently-mounted observer never refetches a
 * stale query on its own, so without this call a member's rename reaches the
 * avatar (members cache, patched in place) and not the name — the split a
 * device test caught: avatar live, name only after restart.
 */
export function invalidateRosterCaches(queryClient: QueryClient, spaceId: string): void {
  queryClient.invalidateQueries({ queryKey: ['identity-roster', spaceId] });
}
```

In `context/WebSocketContext.tsx`, immediately after **each** `await adapter.saveSpaceMember(spaceId, merged)` in the two `update-profile` handlers, add:

```ts
              invalidateRosterCaches(queryClient, spaceId);
```

Then `grep -n "saveSpaceMember" context/WebSocketContext.tsx` and add the same line after any OTHER call that writes name slots (the join-row and leave handlers qualify; the leave handler's write changes `inbox_address` only, but a joined member's row carries names — add it there too, it is idempotent and cheap). Import at top: `import { invalidateRosterCaches } from '@/identity/invalidateRoster';`

- [ ] **Step 4: Tests + gates**

Run: `npx jest __tests__/invalidateRoster.test.ts` then the full gates.
Expected: PASS / baseline unchanged.

- [ ] **Step 5: Commit**

```bash
git add identity/invalidateRoster.ts __tests__/invalidateRoster.test.ts context/WebSocketContext.tsx
git commit -m "fix(identity): a member rename reaches the name ladder without an app restart

The update-profile handlers wrote MMKV and patched the members cache the
avatars read, but never invalidated ['identity-roster', spaceId], which the
name ladder reads through a permanently-mounted observer — so a rename
showed its avatar live and its name only after restart (measured on
device). One helper, called wherever a member row is written."
```

---

### Task 3: Stop stamping address prefixes into name slots (fixes E10)

**Files:**
- Modify: `context/WebSocketContext.tsx` (~3736-3761 JS path, ~5066-5067 batch path)
- Test: `__tests__/dmIdentitySourceGuards.test.ts` (static invariant, same pattern as `dmSelfEchoGuards.test.ts`)

**Interfaces:** none new. The conversation row's `displayName` stays EMPTY when no profile is known; previews fall back to the shared Qm-aware `truncateAddress` (`@/utils/formatAddress`) at render, which the ladder and `<MemberName>` already do.

- [ ] **Step 1: Write the failing static test**

Create `__tests__/dmIdentitySourceGuards.test.ts`:

```ts
/**
 * An address prefix is not a name. Stamping `senderAddress.substring(0, 8)`
 * into the row's displayName poisons the ladder's locallyKnownNames tier
 * (identity/identityFromMaps.ts reads conversation rows as a NAME source),
 * which then blocks the honest truncated-address fallback AND wins over a
 * real name arriving later only in surfaces that read the row raw.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
  'utf8',
);

it('no DM row write uses an address slice as a display name', () => {
  expect(src).not.toMatch(/senderAddress\.substring\(0,\s*8\)/);
  expect(src).not.toMatch(/resolvedSenderAddress\.substring\(0,\s*8\)/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest __tests__/dmIdentitySourceGuards.test.ts`
Expected: FAIL — both patterns are present today.

- [ ] **Step 3: Implement**

JS path (~3736): change

```ts
const senderDisplayName = userProfileFromEnvelope?.displayName || existingConversation?.displayName || senderAddress.substring(0, 8);
```

to

```ts
// Empty means absent. An address slice is NOT a name: it would enter the
// identity ladder as a locally-known name and block both the honest
// truncated-address fallback and a real name arriving later.
const senderDisplayName = userProfileFromEnvelope?.displayName || existingConversation?.displayName || '';
```

In the same block, `lastMessageSenderName: senderDisplayName` may now be `''` — the preview renderers already fall back through the resolver; verify with the existing conversation-preview tests (they are part of the full suite).

Batch path (~5066): same change for `resolvedSenderAddress.substring(0, 8)`.

Also in this task (same disease, send side): in `hooks/chat/useSendDirectMessage.ts` (4 sites: ~763, ~870, ~1009, ~1099) and `hooks/chat/useSendDirectEmbedMessage.ts` (2 sites: ~478, ~588), change

```ts
display_name: displayName || userAddress,
```

to

```ts
// Omit rather than fall back to the address: the receiver stores this as a
// NAME, and an address stored as a name can never be corrected by the
// fallback ladder on their side.
...(displayName ? { display_name: displayName } : {}),
```

(`display_name` is optional in shared's `InitializationEnvelope` — READ, `quorum-shared/src/crypto/types.ts:127`. Both clients' unseal paths guard with `unsealed.display_name || unsealed.user_icon`, so absent is safe.)

- [ ] **Step 4: Tests + gates**

Run: `npx jest` (the new static test passes; watch specifically any conversation-preview / conversationTitle suites) then `npx tsc --noEmit`, `yarn lint`.

- [ ] **Step 5: Commit**

```bash
git add __tests__/dmIdentitySourceGuards.test.ts context/WebSocketContext.tsx hooks/chat/useSendDirectMessage.ts hooks/chat/useSendDirectEmbedMessage.ts
git commit -m "fix(dm): an address is never stored as a display name

Row writes stamped senderAddress.substring(0,8) into displayName, and init
envelopes fell back to the full address — both put an address into a NAME
slot, which the identity ladder then trusts as a locally-known name,
blocking its honest truncated-address rung and any real name arriving
later. Empty now means absent, and render-time fallback stays with the
resolver."
```

---

### Task 4: The reveal ledger (§P's mechanism)

**Files:**
- Create: `services/dm/dmRevealLedger.ts`
- Test: `__tests__/dmRevealLedger.test.ts`

**Interfaces (produced — Tasks 5-7 and §D rely on these exact names):**
- `hasRevealedTo(selfAddress: string, partnerAddress: string): boolean` — fail-CLOSED
- `recordReveal(selfAddress: string, partnerAddress: string, now: number): void`
- `clearReveal(selfAddress: string, partnerAddress?: string): void`
- `messagesContainSelfAuthored(messages: readonly { content?: { senderId?: string } }[], selfAddress: string): boolean` — pure
- `ensureRevealBootstrap(selfAddress: string, partnerAddress: string, getMessages: (p: { spaceId: string; channelId: string; limit?: number }) => Promise<{ messages: { content?: { senderId?: string } }[] }>): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `__tests__/dmRevealLedger.test.ts`:

```ts
/**
 * The reveal ledger: "I have deliberately messaged this partner at least
 * once." It is the ONE predicate every identity emission consults, and it
 * fails CLOSED — a storage error means "do not reveal", the opposite posture
 * from the send-gates (where a redundant push is harmless and they fail
 * open). Both postures are deliberate; do not unify them.
 */
import {
  hasRevealedTo,
  recordReveal,
  clearReveal,
  messagesContainSelfAuthored,
  ensureRevealBootstrap,
} from '../services/dm/dmRevealLedger';

const SELF = 'QmMeMeMeEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const PARTNER = 'QmThemThemVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzz';

afterEach(() => clearReveal(SELF));

describe('ledger basics', () => {
  it('is unset by default and set after recordReveal', () => {
    expect(hasRevealedTo(SELF, PARTNER)).toBe(false);
    recordReveal(SELF, PARTNER, 1_000);
    expect(hasRevealedTo(SELF, PARTNER)).toBe(true);
  });

  it('is scoped per (self, partner)', () => {
    recordReveal(SELF, PARTNER, 1_000);
    expect(hasRevealedTo(SELF, 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz')).toBe(false);
    expect(hasRevealedTo('QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz', PARTNER)).toBe(false);
  });

  it('clearReveal(self, partner) unsets one; clearReveal(self) unsets all of self', () => {
    recordReveal(SELF, PARTNER, 1_000);
    clearReveal(SELF, PARTNER);
    expect(hasRevealedTo(SELF, PARTNER)).toBe(false);
  });
});

describe('messagesContainSelfAuthored (pure bootstrap predicate)', () => {
  it('finds a self-authored message', () => {
    const msgs = [
      { content: { senderId: PARTNER } },
      { content: { senderId: SELF } },
    ];
    expect(messagesContainSelfAuthored(msgs, SELF)).toBe(true);
  });
  it('is false for inbound-only history (a stranger who messaged us)', () => {
    expect(messagesContainSelfAuthored([{ content: { senderId: PARTNER } }], SELF)).toBe(false);
    expect(messagesContainSelfAuthored([], SELF)).toBe(false);
  });
});

describe('ensureRevealBootstrap', () => {
  it('derives a reveal from history exactly once, then serves the ledger', async () => {
    const getMessages = jest.fn().mockResolvedValue({
      messages: [{ content: { senderId: SELF } }],
    });
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(true);
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(true);
    expect(getMessages).toHaveBeenCalledTimes(1); // second call hit the ledger
  });

  it('stays false (and does NOT persist a negative) for inbound-only history', async () => {
    const getMessages = jest.fn().mockResolvedValue({
      messages: [{ content: { senderId: PARTNER } }],
    });
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(false);
    // A later reply can still flip it — negative is never persisted.
    recordReveal(SELF, PARTNER, 2_000);
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(true);
  });

  it('fails CLOSED when the history read throws', async () => {
    const getMessages = jest.fn().mockRejectedValue(new Error('db closed'));
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest __tests__/dmRevealLedger.test.ts`
Expected: FAIL — module not found. (The MMKV mock at `__mocks__/react-native-mmkv.js` already backs `createMMKV` in tests — the gate tests use the same setup.)

- [ ] **Step 3: Implement**

Create `services/dm/dmRevealLedger.ts`:

```ts
import { MMKV, createMMKV } from 'react-native-mmkv';

/**
 * The DM reveal ledger: "this device's user has DELIBERATELY messaged this
 * partner at least once."
 *
 * This is the product's DM privacy rule made storable: you do not see
 * someone's name/pfp unless they deliberately messaged you, and consent
 * belongs to the RELATIONSHIP, not the session — once given, any new
 * device/session of the partner may be answered immediately.
 *
 * Set ONLY by deliberate sends (a chat/embed send, or the initiating side of
 * a new conversation). Never by receipts, typing, or any automatic frame.
 * Consulted by every identity emission: the broadcast sweep, the
 * reveal-on-reply trigger, and the inbound-new-session auto-announce.
 *
 * FAILS CLOSED: a storage error reads as "not revealed". Deliberately the
 * opposite of the send-gates (which fail open, because their risk is a
 * harmless duplicate push; ours is a privacy leak).
 *
 * Per-device by design. A device that never sent a message here treats the
 * partner as unrevealed until its own first deliberate send — worst case a
 * friend waits for one reply from THIS device, never a leak.
 */

let store: MMKV | null = null;
function getStore(): MMKV {
  if (!store) store = createMMKV({ id: 'quorum-dm-reveal-ledger' });
  return store;
}

const key = (self: string, partner: string) => `${self}:${partner}`;

// In-memory memo so a hot path (broadcast sweep, list render) never re-reads
// MMKV for the same pair in one session. Positive AND negative memos are safe
// here because recordReveal updates both layers.
const memo = new Map<string, boolean>();

export function hasRevealedTo(selfAddress: string, partnerAddress: string): boolean {
  const k = key(selfAddress, partnerAddress);
  const m = memo.get(k);
  if (m !== undefined) return m;
  try {
    const v = getStore().getString(k) != null;
    memo.set(k, v);
    return v;
  } catch {
    return false; // fail CLOSED — never memoized, so recovery re-reads
  }
}

export function recordReveal(selfAddress: string, partnerAddress: string, now: number): void {
  const k = key(selfAddress, partnerAddress);
  try {
    getStore().set(k, JSON.stringify({ at: now }));
    memo.set(k, true);
  } catch {
    // Storage failed: memo only. The reveal re-derives from message history
    // next launch (the reply that set it IS the history).
    memo.set(k, true);
  }
}

export function clearReveal(selfAddress: string, partnerAddress?: string): void {
  try {
    const s = getStore();
    if (partnerAddress) {
      s.remove(key(selfAddress, partnerAddress));
      memo.delete(key(selfAddress, partnerAddress));
      return;
    }
    const prefix = `${selfAddress}:`;
    for (const k of s.getAllKeys()) {
      if (k.startsWith(prefix)) s.remove(k);
    }
    for (const k of Array.from(memo.keys())) {
      if (k.startsWith(prefix)) memo.delete(k);
    }
  } catch {
    memo.clear();
  }
}

/** Pure: does this page of a DM's history contain a message we authored? */
export function messagesContainSelfAuthored(
  messages: readonly { content?: { senderId?: string } }[],
  selfAddress: string,
): boolean {
  return messages.some((m) => m?.content?.senderId === selfAddress);
}

/** How much history the one-time bootstrap scans. One page, newest-first: a
 *  real relationship has a self-authored message in its recent window; an
 *  inbound-only stranger row has none at any depth. */
const BOOTSTRAP_SCAN_LIMIT = 200;

/**
 * Ledger check with one-time derivation from local history, for
 * conversations that predate the ledger. DM messages are stored under
 * (spaceId = partner, channelId = partner). Negative results are never
 * persisted — a later reply flips the answer through recordReveal.
 */
export async function ensureRevealBootstrap(
  selfAddress: string,
  partnerAddress: string,
  getMessages: (p: {
    spaceId: string;
    channelId: string;
    limit?: number;
  }) => Promise<{ messages: { content?: { senderId?: string } }[] }>,
): Promise<boolean> {
  if (hasRevealedTo(selfAddress, partnerAddress)) return true;
  try {
    const { messages } = await getMessages({
      spaceId: partnerAddress,
      channelId: partnerAddress,
      limit: BOOTSTRAP_SCAN_LIMIT,
    });
    if (messagesContainSelfAuthored(messages, selfAddress)) {
      recordReveal(selfAddress, partnerAddress, Date.now());
      return true;
    }
    return false;
  } catch {
    return false; // fail CLOSED
  }
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npx jest __tests__/dmRevealLedger.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: RED proof for the fail-closed posture**

Temporarily change `hasRevealedTo`'s catch to `return true`. Run the suite — "fails CLOSED when the history read throws" and the storage-error direction must go RED. Put it back. Record in the commit message.

- [ ] **Step 6: Commit**

```bash
git add services/dm/dmRevealLedger.ts __tests__/dmRevealLedger.test.ts
git commit -m "feat(dm): a persisted reveal ledger makes the privacy rule explicit

'You do not see someone's identity unless they deliberately messaged you' —
until now that rule was an accident of which frame won a transport race.
The ledger stores the consent fact per (self, partner), is set only by
deliberate sends, bootstraps once from local history for pre-existing
conversations, and fails CLOSED on any storage error.

RED proof: flipping the fail direction turns the storage-error test red."
```

---

### Task 5: The broadcast sweep respects the ledger (fixes the stranger leak, E8)

**Files:**
- Modify: `services/dm/dmProfileService.ts` (the loop at ~261, plus extract `sendProfileToPartner` from the loop body)
- Test: `__tests__/dmRevealTriggers.test.ts` (started here, extended in Tasks 6-7)

**Interfaces:**
- Produces: `sendProfileToPartner(partnerAddress: string, payload: DMProfilePayload, deps: DMBroadcastDeps): Promise<boolean>` — the extracted per-partner body: gate check → registration fetch → build → send → record gate. Returns true when a frame was enqueued. `broadcastProfileToAllDMs` becomes a loop over `sendProfileToPartner` with the ledger filter in front.

- [ ] **Step 1: Extract `sendProfileToPartner`**

Mechanical extraction of the current loop body (lines ~261-320): everything from the gate read through `writeGate`, parameterized on `partnerAddress`. No behaviour change. The loop keeps its self/farcaster skips and calls the new function. Run `npx jest` — the existing dmProfileService coverage must stay green with no assertion edited.

- [ ] **Step 2: Write the failing test**

Add to `__tests__/dmRevealTriggers.test.ts`:

```ts
/**
 * The on-connect/on-rename broadcast sweep must not push identity to a
 * partner we never deliberately messaged. A conversation row is created by a
 * stranger's INBOUND message, so "has a row" is not consent — the ledger is.
 */
import { broadcastProfileToAllDMs } from '../services/dm/dmProfileService';
import { recordReveal, clearReveal } from '../services/dm/dmRevealLedger';

const SELF = 'QmMeMeMeEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const FRIEND = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const STRANGER = 'QmThemThemVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzz';

const sendSpy = jest.fn().mockResolvedValue(undefined);

jest.mock('@/hooks/chat/useSendDirectMessage', () => ({
  sendEncryptedMessageToAllDevices: (...args: unknown[]) => sendSpy(...args),
}));
jest.mock('@/hooks/chat/useRecipientRegistration', () => ({
  toAllDeviceInfos: () => [{ identityKey: [1], signedPreKey: [1], inboxAddress: 'inbox-x', inboxEncryptionKey: [1] }],
}));
jest.mock('@/services/api/quorumClient', () => ({
  getQuorumClient: () => ({ fetchUserRegistration: jest.fn().mockResolvedValue({ devices: [{}] }) }),
}));
jest.mock('@/services/storage/mmkvAdapter', () => ({
  getMMKVAdapter: () => ({
    getConversations: jest.fn().mockResolvedValue({
      conversations: [
        { address: FRIEND, conversationId: `${FRIEND}/${FRIEND}`, type: 'direct' },
        { address: STRANGER, conversationId: `${STRANGER}/${STRANGER}`, type: 'direct' },
      ],
    }),
    // Bootstrap history: we authored a message with FRIEND, none with STRANGER.
    getMessages: jest.fn(async ({ spaceId }: { spaceId: string }) => ({
      messages: spaceId === FRIEND ? [{ content: { senderId: SELF } }] : [{ content: { senderId: STRANGER } }],
    })),
  }),
}));
// getDeviceKeyset comes from the crypto service — stub it like the existing
// dmProfileService tests do (same module path, resolved during Step 3 by
// copying the mock those tests already use).

describe('broadcast sweep × reveal ledger', () => {
  beforeEach(() => { sendSpy.mockClear(); clearReveal(SELF); });

  it('sends to the revealed friend and SKIPS the never-replied stranger', async () => {
    await broadcastProfileToAllDMs(
      { selfAddress: SELF, displayName: 'Me', userIcon: 'icon' },
      { enqueueOutbound: jest.fn(), subscribe: jest.fn() },
    );
    const targets = sendSpy.mock.calls.map((c) => c[1]);
    expect(targets).toContain(FRIEND);
    expect(targets).not.toContain(STRANGER); // ← the control arm
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx jest __tests__/dmRevealTriggers.test.ts`
Expected: FAIL — the stranger currently receives the push (`targets` contains both). If module mocks need adjusting (e.g. `getDeviceKeyset`'s path), copy the mock setup from the existing dmProfileService test file rather than inventing one; the assertion pair is what matters and must not change.

- [ ] **Step 4: Implement the filter**

In `broadcastProfileToAllDMs`'s loop, after the farcaster skip and before the gate read:

```ts
    // Privacy: identity goes only to partners this user has DELIBERATELY
    // messaged. A conversation row is created by a stranger's inbound
    // message, so having a row is not consent — the reveal ledger is.
    const revealed = await ensureRevealBootstrap(
      payload.selfAddress,
      partnerAddress,
      (p) => adapter.getMessages(p),
    );
    if (!revealed) continue;
```

with `import { ensureRevealBootstrap } from './dmRevealLedger';`

- [ ] **Step 5: Run the test — expect PASS; full gates; commit**

```bash
git add services/dm/dmProfileService.ts services/dm/dmRevealLedger.ts __tests__/dmRevealTriggers.test.ts
git commit -m "fix(dm): the identity broadcast no longer reaches never-replied strangers

The sweep iterated every direct conversation row, and a row is created by a
stranger's inbound message — so changing your name pushed your identity to
people you never chose to talk to. The sweep now consults the reveal
ledger; the stranger arm of the test is the control."
```

---

### Task 6: Reveal-on-reply — the stranger sees you the moment you reply

**Files:**
- Modify: `services/dm/dmProfileService.ts` (add `onDeliberateDmSend`)
- Modify: `hooks/chat/useSendDirectMessage.ts` (`onSuccess`, ~line 584) and `hooks/chat/useSendDirectEmbedMessage.ts` (its equivalent success point)
- Test: extend `__tests__/dmRevealTriggers.test.ts`

**Interfaces:**
- Produces: `onDeliberateDmSend(partnerAddress: string, payload: DMProfilePayload, deps: DMBroadcastDeps): Promise<void>` — if the ledger was unset for this partner: set it, clear the send-gate for this partner (`clearDmProfileBroadcastState(self, partner)` — the currently-unused escape hatch finds its purpose: an eaten-era or exhausted gate must not block the first genuine reveal), then `sendProfileToPartner`. If already set: record only (idempotent, no wire traffic).

- [ ] **Step 1: Write the failing test**

Add to `__tests__/dmRevealTriggers.test.ts`:

```ts
import { onDeliberateDmSend } from '../services/dm/dmProfileService';
import { hasRevealedTo } from '../services/dm/dmRevealLedger';

describe('reveal-on-reply', () => {
  beforeEach(() => { sendSpy.mockClear(); clearReveal(SELF); });

  it('first deliberate send: sets the ledger and fires exactly one identity push', async () => {
    await onDeliberateDmSend(STRANGER, { selfAddress: SELF, displayName: 'Me', userIcon: 'icon' }, deps());
    expect(hasRevealedTo(SELF, STRANGER)).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Second send in the same conversation: ledger already set → no push.
    await onDeliberateDmSend(STRANGER, { selfAddress: SELF, displayName: 'Me', userIcon: 'icon' }, deps());
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

function deps() { return { enqueueOutbound: jest.fn(), subscribe: jest.fn() }; }
```

- [ ] **Step 2: Run — expect FAIL** (`onDeliberateDmSend` not exported).

- [ ] **Step 3: Implement**

In `services/dm/dmProfileService.ts`:

```ts
/**
 * Called after a successful chat/embed send in a DM. THE deliberate act the
 * privacy rule keys on: replying (or initiating) is consent to be seen.
 *
 * On the ledger's unset→set transition the partner's send-gate is CLEARED
 * first: the gate may be exhausted from the era when cross-client pushes
 * were silently eaten, and an exhausted gate must not block the one reveal
 * the user just consented to. Fire-and-forget; never throws into the send
 * path that calls it.
 */
export async function onDeliberateDmSend(
  partnerAddress: string,
  payload: DMProfilePayload,
  deps: DMBroadcastDeps,
): Promise<void> {
  try {
    if (hasRevealedTo(payload.selfAddress, partnerAddress)) return;
    recordReveal(payload.selfAddress, partnerAddress, Date.now());
    clearDmProfileBroadcastState(payload.selfAddress, partnerAddress);
    await sendProfileToPartner(partnerAddress, payload, deps);
  } catch {
    // Never break a message send over an identity push; the on-connect
    // sweep retries through the (now-open) gate.
  }
}
```

with imports from `./dmRevealLedger`.

- [ ] **Step 4: Wire into the send hooks**

In `useSendDirectMessage`'s `onSuccess` (~584) and `useSendDirectEmbedMessage`'s equivalent, after the existing success work, add a fire-and-forget call (payload from the auth user, deps from the hook's existing WebSocket context values — both hooks already hold `enqueueOutbound`/`subscribe` for their own sends):

```ts
      void import('@/services/dm/dmProfileService').then(({ onDeliberateDmSend }) =>
        onDeliberateDmSend(
          recipientAddress,
          {
            selfAddress: user.address,
            displayName: user.displayName || undefined,
            userIcon: user.profileImage || undefined,
            primaryUsername: user.primaryUsername ?? undefined,
          },
          { enqueueOutbound, subscribe },
        ),
      );
```

(Dynamic import matches how `ProfileModal`/`UnifiedProfileEditModal` already invoke this service. If `user` is not in the hook's scope, take it from the same source the hook's optimistic-message path uses — do not add a new context read inside a callback without a ref.)

- [ ] **Step 5: Run tests + full gates; commit**

```bash
git add services/dm/dmProfileService.ts hooks/chat/useSendDirectMessage.ts hooks/chat/useSendDirectEmbedMessage.ts __tests__/dmRevealTriggers.test.ts
git commit -m "feat(dm): replying reveals you — once, at the moment of consent

The privacy rule's positive half: a stranger sees your name and avatar the
moment you deliberately reply, carried by one dm-update-profile push. The
ledger transition clears the partner's send-gate first, so a gate exhausted
in the era when cross-client pushes were eaten cannot block the reveal the
user just consented to."
```

---

### Task 7: Auto-reveal to a known partner's new session — the operator's case

**Files:**
- Modify: `services/dm/dmProfileService.ts` (add `autoRevealOnInboundSession`)
- Modify: `context/WebSocketContext.tsx` (three call sites via a ref)
- Test: extend `__tests__/dmRevealTriggers.test.ts`

**Interfaces:**
- Produces: `autoRevealOnInboundSession(partnerAddress: string, payload: DMProfilePayload, deps: DMBroadcastDeps, getMessages: Parameters<typeof ensureRevealBootstrap>[2]): Promise<void>` — debounced per partner (1h, in-memory); ledger-gated via `ensureRevealBootstrap`; on pass: clear the partner's gate, `sendProfileToPartner`.

- [ ] **Step 1: Write the failing test**

```ts
import { autoRevealOnInboundSession, __resetAutoRevealDebounce } from '../services/dm/dmProfileService';

describe('auto-reveal on inbound new session', () => {
  beforeEach(() => { sendSpy.mockClear(); clearReveal(SELF); __resetAutoRevealDebounce(); });

  it('announces immediately to a REVEALED partner (friend on a new device)', async () => {
    recordReveal(SELF, FRIEND, 1_000);
    await autoRevealOnInboundSession(FRIEND, payload(), deps(), historyWithSelfMessage());
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('stays SILENT for a stranger opening a session at us', async () => {
    await autoRevealOnInboundSession(STRANGER, payload(), deps(), inboundOnlyHistory());
    expect(sendSpy).not.toHaveBeenCalled(); // ← the control arm
  });

  it('debounces per partner: a redelivered init envelope fires no second push', async () => {
    recordReveal(SELF, FRIEND, 1_000);
    await autoRevealOnInboundSession(FRIEND, payload(), deps(), historyWithSelfMessage());
    await autoRevealOnInboundSession(FRIEND, payload(), deps(), historyWithSelfMessage());
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

function payload() { return { selfAddress: SELF, displayName: 'Me', userIcon: 'icon' }; }
function historyWithSelfMessage() { return async () => ({ messages: [{ content: { senderId: SELF } }] }); }
function inboundOnlyHistory() { return async () => ({ messages: [{ content: { senderId: STRANGER } }] }); }
```

(Adjust the `getMessages` argument shape to the real signature from Task 4 — a function of `{spaceId, channelId, limit}`; the helpers above return a stub of that.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

In `services/dm/dmProfileService.ts`:

```ts
// One auto-reveal per partner per hour. An init envelope can be REDELIVERED
// (the receive path bounds replays but does not eliminate them), and each
// one looks like "a new session appeared" — without this, a flapping inbox
// turns one new device into a push storm.
const AUTO_REVEAL_DEBOUNCE_MS = 60 * 60 * 1000;
const autoRevealLastFired = new Map<string, number>();

/** Test hook: the debounce map is process-lifetime state. */
export function __resetAutoRevealDebounce(): void {
  autoRevealLastFired.clear();
}

/**
 * A partner just opened a NEW inbound session at us (their new device, or a
 * reinstall). If the ledger says we already deliberately revealed to them,
 * answer immediately — consent belongs to the relationship, not the session,
 * so their fresh device should not have to wait for our next rename or
 * reply. If the ledger says stranger: total silence.
 */
export async function autoRevealOnInboundSession(
  partnerAddress: string,
  payload: DMProfilePayload,
  deps: DMBroadcastDeps,
  getMessages: (p: { spaceId: string; channelId: string; limit?: number }) => Promise<{ messages: { content?: { senderId?: string } }[] }>,
): Promise<void> {
  try {
    const now = Date.now();
    const last = autoRevealLastFired.get(partnerAddress) ?? 0;
    if (now - last < AUTO_REVEAL_DEBOUNCE_MS) return;

    const revealed = await ensureRevealBootstrap(payload.selfAddress, partnerAddress, getMessages);
    if (!revealed) return;

    autoRevealLastFired.set(partnerAddress, now);
    // The gate may hold "already announced 3x" from before this session
    // existed — that record is about OLD sessions and must not gag the new one.
    clearDmProfileBroadcastState(payload.selfAddress, partnerAddress);
    await sendProfileToPartner(partnerAddress, payload, deps);
  } catch {
    // Best-effort. The reply trigger and on-connect sweep remain as backstops.
  }
}
```

- [ ] **Step 4: Wire the three receive-path call sites**

In `context/WebSocketContext.tsx`, create a ref-backed helper near the on-connect broadcast block (which already assembles the exact payload — reuse its construction: `displayName`/`userIcon` from the same source, `primaryUsername: user.primaryUsername ?? NO_PRIMARY_NAME`):

```ts
  // Ref, not a closure: the receive callbacks are created once and never
  // recreated, so any state they read directly is frozen at mount (the
  // stale-user bug class this file has already shipped once).
  const autoRevealRef = useRef<(partnerAddress: string) => void>(() => {});
  useEffect(() => {
    autoRevealRef.current = (partnerAddress: string) => {
      const self = fullUserAddrRef.current;
      if (!self || !partnerAddress || partnerAddress === self) return;
      // Payload: the SAME values the on-connect rebroadcast block assembles
      // (~line 6665). Extract that block's construction into a local
      // `buildSelfProfilePayload()` in this file as part of this step, and
      // use it in BOTH places — two hand-built copies of the payload is how
      // the signature-gate and the reveal push would drift apart.
      void import('../services/dm/dmProfileService').then(({ autoRevealOnInboundSession }) =>
        autoRevealOnInboundSession(
          partnerAddress,
          buildSelfProfilePayload(),
          { enqueueOutbound, subscribe },
          (p) => getMMKVAdapter().getMessages(p),
        ),
      );
    };
  });
```

Call `autoRevealRef.current?.(partnerAddress)` at the three points where an inbound partner session is (re)established, with the **pre-rewrite authenticated sender**, never the payload senderId:

1. JS device-inbox init success — after `authenticatedDmSender = conversationId.split('/')[0]` (~3129), guarded by `authenticatedDmSender !== fullUserAddrRef.current`;
2. JS conversation-inbox init/confirm — after `userProfileFromEnvelope = confirmResult.userProfile` (~3284) and after the `sessionResult` branch (~3409), same guard;
3. Native batch path — where `msgResult.user_profile` is present and `!isSelfSyncEcho` (~5064): a `user_profile`-carrying result IS the init-variant marker.

- [ ] **Step 5: Run tests + full gates; commit**

```bash
git add services/dm/dmProfileService.ts context/WebSocketContext.tsx __tests__/dmRevealTriggers.test.ts
git commit -m "feat(dm): a friend's new device learns who you are in seconds

When a partner we have deliberately messaged before opens a new session
(new device, reinstall), answer with one identity push instead of waiting
for our next rename. Ledger-gated — a stranger's session gets silence —
and debounced so redelivered init envelopes cannot storm. This is the
new-device case measured live: both users had talked for months, yet the
fresh emulator could never learn the partner's name."
```

---

### Task 8: Identity rides init envelopes only on deliberate sends — and now includes the avatar (fixes E9)

**Files:**
- Modify: `hooks/chat/useSendDirectMessage.ts` (4 envelope sites: ~763, ~870, ~1009, ~1099 — line numbers pre-Task-3; re-locate by searching `initEnvelope: InitializationEnvelope`)
- Modify: `hooks/chat/useSendDirectEmbedMessage.ts` (2 sites: ~478, ~588)
- Test: extend `__tests__/dmIdentitySourceGuards.test.ts`

**Interfaces:** the module-level send helpers gain a `userIcon?: string` parameter alongside the existing `displayName` one (thread it through the same call chain — `sendEncryptedMessageToAllDevices` already carries `displayName` as its last parameter; add `userIcon` after it and update its callers, including `sendProfileToPartner`).

**The audit that makes this safe (do it, record it in the commit):** `grep -n "sendEncryptedMessageToAllDevices\|initEnvelope: InitializationEnvelope" hooks/ services/ context/ -r` and classify every caller as DELIBERATE (chat send, embed send, identity push — attach name+icon) or AUTOMATIC (receipt/ack/typing/any other control — attach NOTHING). The privacy rule lives or dies on this classification: an automatic frame that attaches identity re-opens the harvest-by-messaging hole. If any automatic caller currently passes `displayName`, REMOVE it in this task and say so in the commit message.

- [ ] **Step 1: Extend the static test**

```ts
it('every init envelope that attaches a name also attaches the icon (or neither)', () => {
  const files = [
    'hooks/chat/useSendDirectMessage.ts',
    'hooks/chat/useSendDirectEmbedMessage.ts',
  ].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  for (const src of files) {
    const envelopes = src.split('initEnvelope: InitializationEnvelope').slice(1);
    for (const chunk of envelopes) {
      const head = chunk.slice(0, 600);
      if (/display_name/.test(head)) {
        expect(head).toMatch(/user_icon/);
      }
    }
  }
});
```

- [ ] **Step 2: Run — expect FAIL** (name present, icon absent at all 6 sites).

- [ ] **Step 3: Implement**

At each of the 6 sites, alongside Task 3's presence-guarded name:

```ts
        ...(displayName ? { display_name: displayName } : {}),
        ...(userIcon ? { user_icon: userIcon } : {}),
```

threading `userIcon` from the same source the caller already has (`user.profileImage` in the hooks; `payload.userIcon` in the profile service). Shared's `InitializationEnvelope.user_icon` is already declared optional (READ, `quorum-shared/src/crypto/types.ts:130`), and both clients' unseal paths already read it — desktop captures `envelope.user_icon` on init/confirm, mobile reads `unsealed.user_icon`. No shared bump.

- [ ] **Step 4: Run tests + full gates; commit**

```bash
git add hooks/chat/useSendDirectMessage.ts hooks/chat/useSendDirectEmbedMessage.ts services/dm/dmProfileService.ts __tests__/dmIdentitySourceGuards.test.ts
git commit -m "feat(dm): initiating a conversation reveals your avatar too, not just your name

Mobile's hand-built init envelopes set display_name and never user_icon,
though the shared type declares it and both clients already read it on
unseal — so a mobile user's first message revealed a name and no face.
Audited every envelope-building caller: identity fields attach ONLY on
deliberate sends (chat, embed, identity push); receipts and typing attach
nothing, which is what keeps the privacy rule intact."
```

---

## §V. Verification lanes (run after PR-1, again after PR-2)

| Lane | What | Pass criterion |
|---|---|---|
| V1 (dialect, live) | Desktop user renames while `adb logcat` runs | NO new `consuming without saving … dm-update-profile` line; the DM row shows the new name+pfp without reload |
| V2 (space, live) | Desktop user renames | Name AND avatar change in the space on mobile within seconds, no app restart |
| V3 (new device, live — the operator's original scenario) | Fresh emulator onboard → message a long-standing partner | Partner's name+pfp appear within ~10s of the partner's client processing the init (auto-reveal), before any reply |
| V4 (stranger control) | **AUTOMATED — `yarn harness:reveal`** | See below |
| V5 (regression) | mobile↔mobile rename propagation | unchanged (wrapped dialect end-to-end) |
| V6 (suite) | `npx jest`, `npx tsc --noEmit`, `yarn lint` | green / baseline |

### V4 is automated as of 2026-08-20

`dev/harness/dm-reveal-two-bot.scenario.ts`, run with `yarn harness:reveal`. Two headless
mobile clients, one per process, mobile's real client code on both sides, the **production
relay** in between. A is a stranger who messages B; B renames without replying; A must not
learn the name; B then replies once and A must.

It was planned as a manual device lane and should not go back to being one. The manual
version is n=1, unrepeatable, needs two accounts and a person, and observes a rendered
screen rather than what actually crossed the wire.

**MEASURED 2026-08-20, both directions.** GREEN as shipped. Disabling the
`ensureRevealBootstrap` filter in `broadcastProfileToAllDMs` turned phase 1 RED
(`broadcast to 1/1 partner(s)`; A's stored row became the renamed value); restoring it
turned it GREEN. So the assertion can fail, which is the only reason a green means
anything.

Two design points worth keeping if this is ever edited:

- **Phase 2 is the control arm, not a bonus.** A dead bench, a broken relay or an unpaired
  bot all produce "the stranger learned nothing", which reads as a pass. Phase 2 proves the
  same pair and wire *can* carry a name, so phase 1's silence is a decision.
- **The preconditions are asserted, not assumed.** The first version of the scenario failed
  on exactly this: `useSendDirectMessage` only UPDATES a conversation row (`if
  (conversation)`) and never creates one — the app creates it in the UI
  (`useStartDirectMessage`). A bot that only sent held no row, and the receive path drops an
  identity update for a partner it has no row for, so a leak could not have been observed
  even if pushed. Hence `bot.startConversation()`.

Both bots are mobile deliberately: pairing against desktop would make a failure unreadable
while §D1 stands, since desktop cannot parse mobile's wrapped dialect at all.

**Still needs a human, on the emulator (which works — confirmed 2026-08-20):** whether the
name and avatar actually *render*. The harness asserts on the stored conversation row, which
is deliberate — it separates "the value survived the wire and the merge" from "the resolver
then chose to display it". Those fail for different reasons. V1-V3 remain manual.

## §D. Desktop mirror (separate PR in quorum-desktop)

> **Now has its own plan:** `quorum-desktop/.agents/issues/.open/2026-08-20-dm-identity-reveal-desktop-and-shared-plan.md`
> — four tasks, fourteen verified evidence anchors, and a harness strategy this section
> did not know was possible. **Work from that file, not from this section**, which is kept
> only as the summary that produced it. Two anchors quoted below (`~3679`, `~4037` for the
> inbound init branches) were themselves stale and are corrected there to `:4513` / `:4589`.

**This section was verified against the desktop source on 2026-08-19**, replacing the
predictions it originally contained. Two of the four items turned out to be worse than
guessed. Everything below is READ from `quorum-desktop` at the line numbers given.

**The mobile branch fixed desktop→mobile only. mobile→desktop is still broken, and D1
is not optional — without it the mobile work is half-delivered.**

### D1. Desktop cannot parse the wrapped dialect, and does not merely drop it

`interceptControlMessages` (`src/services/MessageService.ts:847`) binds
`const raw = decryptedContent as any` at `:855` and its 1d branch tests
`raw.type === 'dm-update-profile'` at `:907`. **It never looks at `raw.content.type`.**

Mobile's `buildDmProfileMessage` (`services/dm/dmProfileService.ts:99`) emits a full
`Message` envelope with no top-level `type` and the payload under `content`. So on
desktop the 1d test is false, `interceptControlMessages` returns false, and control
reaches **`saveMessage` at `:6399`** (and the sibling decrypt path at `:4196`).

- READ: the frame is **persisted to IndexedDB as a message in that DM**, carrying a real
  `messageId` (`dm-profile-<nonce>`). This is a ghost row, not a silent drop — strictly
  worse than the desktop→mobile failure the mobile branch fixed, which at least consumed
  the frame cleanly.
- NOT MEASURED: whether it draws a visible bubble, and whether it bumps the conversation
  preview / unread state. Check the renderer's unknown-`content.type` behaviour and
  `db.saveMessage`'s conversation upsert before sizing the fix.

**Fix:** match `decryptedContent?.content?.type === 'dm-update-profile'` as well and feed
the same `handleDMProfileUpdate`. Mobile's `parseDmProfileUpdate`
(`services/dm/dmProfileWire.ts`) is the reference implementation and its
wrapped-wins-over-flat precedence should be mirrored. Pin the ghost-row case in a test:
assert `saveMessage` is NOT called for a wrapped profile frame.

### D2. Desktop has no reveal ledger at all

MEASURED 2026-08-19: `grep -rl "RevealLedger\|hasRevealedTo\|ensureRevealBootstrap"` over
`src/` and `.agents/` returns **zero files**. Nothing on desktop implements §P.

Port `services/dm/dmRevealLedger.ts`. Its five exports are the contract. Two properties
must survive the port or the design is not the design:

- **fail CLOSED** — storage error or malformed identifier reads as *not revealed*. This is
  deliberately the OPPOSITE posture from `src/utils/dmProfileGate.ts`, which fails OPEN.
  Do not unify them.
- **injective key encoding** — `JSON.stringify([self, partner])`, not `${self}:${partner}`.

Bootstrap from IndexedDB history ("any message in this conversation authored by self"),
mirroring `ensureRevealBootstrap`. Never persist a negative.

### D3. `broadcastProfileToAllDMs` has the same stranger leak, live today

`src/services/MessageService.ts:677`, loop at `:696`. It enumerates
`getConversations({ type: 'direct' })` and pushes identity to **every row**. The only gate
is the `dmProfileGate` dedup at `:715`, which suppresses a byte-identical *resend* and says
nothing about consent.

A conversation row is created by a **stranger's inbound message**. So on desktop today,
changing your display name announces you to people you have never replied to — the exact
leak closed on mobile in Task 5, reproduced there as `broadcast to 2/2 partner(s)` with the
stranger in `targets`. `rebroadcastProfileToAllDMsOnConnect` at `:768` calls the same
function on every reconnect, so it fires without any user action at all.

**Fix:** filter each partner through the ledger's bootstrap, as mobile's sweep does.

### D4. Auto-reveal, plus an audit to keep

Wire auto-reveal on inbound init/confirm — the branches at `~3679` and `~4037` already hold
the authenticated sender — with the same 1h debounce mobile uses.

Then **audit and pin** that automatic frames stay identity-free. READ 2026-08-19: today
they do. `sendEphemeralDMControl` (`:630`) forwards a `TypingMessage` unchanged; the
delivery-ack and read-ack branches (`:861`, `:873`) carry no profile fields. That is the
invariant from §P — an automatic frame reveals nothing, ever — and it is currently held by
accident rather than by a test.

### D5. Desktop's send-side init is a different shape — do not assume mobile's fix ports

Mobile's Task 8 worked because mobile hand-attaches `display_name` / `user_icon` to its
init envelopes in `useSendDirectMessage.ts`, so gating them is a local edit. Desktop's
outgoing identity rides `secureChannel`'s `user_profile` on the init-carrying variant of
the decrypt union (see the comment at `:754-758`), which is produced by the crypto layer
during session establishment, not assembled per-message by app code.

The `display_name` fields at `:3844-3848` and `:3868-3873` are **local DB writes recording
the partner's identity onto the conversation row**, not the outgoing wire envelope. Do not
"fix" them.

**Consequence:** D5 is a design question, not a port. Under §P, initiating IS consent, so
identity on a *first outbound* init is correct and needs no gate. Confirm that desktop
never sends an init-carrying frame without a deliberate user act behind it. If it can, that
is a lead-dev conversation about the crypto layer, not an app-level patch.

### Suggested order

D1 first and alone — it is a receive-path change, it is the half of the mobile work that
is currently undelivered, and it is provable in isolation. D2+D3 next as one PR (the ledger
is useless until something consults it, and the sweep is the live leak). D4 after. D5 is a
question to answer before it is a task.

## §S. quorum-shared

One change, small, and it is the reason two clients drifted in the first place.

**`src/types/message.ts:51-57`** declares `DMUpdateProfileMessage` with exactly
`senderId`, `type`, `displayName`, `userIcon`, `bio`. Two gaps:

1. **`primaryUsername` is missing.** Mobile sends it (`dmProfileService.ts:117-119`) via an
   `as DMUpdateProfileMessage` cast, with a comment acknowledging the field is additive and
   untyped — the same pattern the space broadcast uses for its `global*` slots. Desktop's
   `handleDMProfileUpdate` therefore cannot see it even once D1 lands. Add it as optional.
2. **The type describes fields but not the envelope.** Nothing in shared says whether the
   payload travels flat or wrapped, which is precisely how the two clients shipped opposite
   answers without either being wrong. Whatever §Q1 decides, write it down here as a
   comment on the type, next to the fields it governs.

Nothing else in shared needs to change. The reveal ledger is per-device local state and has
no business in a shared package; the two clients' storage layers (MMKV vs IndexedDB) have
nothing in common to factor out.

## §Q. Open questions for the Lead Dev

1. **Canonical wire shape** for `dm-update-profile` — pick one (flat matches the receipt
   family; wrapped matches `Message` plumbing), receivers stay liberal for one release
   cycle either way. **Now urgent rather than academic:** §D1 shows the ambiguity is not a
   tidiness issue, it produces persisted ghost rows on desktop. Record the answer in
   shared per §S2.
2. **Future work F — receiver-driven `request-profile`** (a new control type in shared):
   the deterministic backstop for every remaining miss; must be ledger-gated on the
   responder side. Desktop's cadence research already ranked it best-shape; it is a wire
   change and therefore a sign-off.
3. **Deleting a conversation:** should it `clearReveal` for that partner (un-consent)?
   Product call; one line either way.
4. **Scope assumption to confirm:** the reveal rule is DM-only — in a Space, joining is the
   consent and members see each other freely. Everything above assumes yes.
5. **Desktop's init-carrying frames (§D5):** can `secureChannel` emit one without a
   deliberate user act? If yes, §P is not enforceable on desktop at the app layer.

---
*Last updated: 2026-08-19*
