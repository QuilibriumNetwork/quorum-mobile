---
status: done
created: 2026-06-12
resolved: 2026-06-16
type: task
title: "Cross-repo fix: remove space-owner permission bypass (shared + desktop + mobile)"
runtime-test: done (C2 verified in code + shared checker; C1 confirmed live by user)
priority: resolved-on-mobile (the high-severity mobile hole — C2 — shipped same-day in PR #76; only cosmetic C1 remained, now done)
spans-repos:
  - quorum-shared (root fix + publish)
  - quorum-desktop (consumes via link:; receive-side @everyone hardening)
  - quorum-mobile (revert 0.1 bypass; receive-side delete validation; version bump)
bug: ../quorum-desktop\.agents\bugs\2026-06-12-everyone-mention-owner-bypass-send-side-only.md
supersedes-framing:
  - quorum-shared-migration/2026-05-29-mobile-adopt-shared-permission-helpers.md (its "owners now see pin/delete — this is a fix" claim is WRONG; see Correction below)
  - 2026-06-12-permission-enforcement-wave-0.md (Wave 0 assumed "route through shared = enforcement"; enforcement is actually receive-side)
---

# Cross-repo fix: remove the space-owner permission bypass

> **RESOLUTION (2026-06-16) — the mobile work is DONE; doc was stale.** This was written as a "plan only" doc on 2026-06-12, but the highest-severity mobile piece (C2) shipped the SAME DAY in **PR #76 (`e6fcc9a`, "Enforce message-delete and read-only-channel permissions on receipt")** and the doc was never updated. Verified 2026-06-16 against compiled code, not the doc:
> - **C2 (receive-side `remove-message` validation) — SHIPPED & CORRECT.** Both message paths re-validate incoming deletes: live [WebSocketContext.tsx:1876-1925](../../context/WebSocketContext.tsx#L1876-L1925) and batch [WebSocketContext.tsx:3171](../../context/WebSocketContext.tsx#L3171). Each builds `createChannelPermissionChecker({ isSpaceOwner: false, ... })` and drops the delete if `canDeleteMessage` is false (clearing the inbox entry so it can't reprocess on reconnect). The shared `canDeleteMessage` (read from installed `node_modules` dist) honors a delete only for the message author, a read-only-channel manager, or a `message:delete` role holder — **no `isSpaceOwner` bypass at the enforcement layer.** The "any sender deletes anyone on mobile" hole is CLOSED.
> - **C1 (send-side pin/delete button illusion) — now DONE (this branch).** `[channelId].tsx:84-85` granted owners the buttons via `|| isSpaceOwner`; recipients rejected the action (per C2) so it was cosmetic. User confirmed live 2026-06-16 that an owner-with-no-role still saw the buttons. Fixed on branch `fix/owner-pin-delete-buttons-role-only`: pin/delete are now role-only (matches desktop). `isSpaceOwner` retained for genuinely owner-only UI (invite, settings entry).
> - **`@everyone` propagating bug — NOT a mobile concern.** That real, propagating bug is **send-side-only on desktop**; it lives in quorum-shared + quorum-desktop, tracked there. Nothing for mobile to do here.
>
> **Net: mobile is fully resolved.** The Phase A (shared root fix) / Phase B (desktop) work below is for the *other* repos and is out of scope for quorum-mobile. Moved to `.done/`. The detailed plan below is retained as provenance.

> **Plan only — implement nothing until reviewed.** This is a coordinated 3-repo change with a `quorum-shared` publish. The full investigation + evidence is in the bug doc [2026-06-12-everyone-mention-owner-bypass-send-side-only.md](../../../quorum-desktop/.agents/bugs/2026-06-12-everyone-mention-owner-bypass-send-side-only.md).

## The finding in one paragraph

Shared `hasPermission` has `if (isSpaceOwner) return true`, granting owners ALL permissions. This contradicts the documented design (owners get NO implicit permissions except **kick** — clients can't verify ownership, so owners must self-assign roles; see #111 / `space-owner-privacy-limitation.md`) and shared's own newer `channelPermissions.ts` (no owner bypass). Impact differs by enforcement model:
- **pin / delete / mute** are **receive-side validated** → owner-bypass is a harmless **local illusion** (recipients reject; confirmed by desktop history #68).
- **`@everyone` is send-side ONLY** (no receive-side check anywhere) → owner-bypass is a **real, propagating, zero-setup bug on desktop today**.
- **mobile receive-side** has NO validation on `remove-message` at all → **any sender** can delete anyone's message on mobile peers (worse than the desktop case).

## Architecture (verified, do not re-litigate)

Clients cannot verify who the space owner is (no `ownerAddress` on the wire — privacy). Therefore:

| Action | Enforcement | Owner-no-role result | Fix needed |
|---|---|---|---|
| kick | protocol ED448 (receiver-verifiable) | works (owner-only) | none — correct |
| delete / pin | send gate + **receive-side role check** | local illusion | remove send-side bypass (cosmetic) + **mobile lacks the receive check** |
| mute | desktop: role-gated (no bypass); mobile: local-only MMKV | desktop fine; mobile = separate convergence | mobile mute gating (Wave-0 0.3) |
| **@everyone** | **send gate ONLY** | **propagates — real bug** | remove send-side bypass (root) + add receive-side check (defense-in-depth) |

## Version mechanics (important — asymmetric)

- `quorum-shared` source is at **`2.1.0-29`**. Build = `tsup && tsc --project tsconfig.build.json`. Publish = manual `npm publish` after a version bump. Tests = `vitest` (`yarn test:run`).
- **Desktop** consumes shared via `"@quilibrium/quorum-shared": "link:../quorum-shared"` → sees source changes **immediately**, no publish required for desktop to pick up the shared fix.
- **Mobile** consumes a **published** `"2.1.0-26"` → needs a **publish + bump** to get the fix. (Mobile is also behind source 2.1.0-29 already; the bump should go to whatever the next published tag is.)
- There are **no existing tests** for `hasPermission`/`getUserPermissions`/`channelPermissions` (verified). The fix should ADD tests — no buggy test to fight. `mentions.test.ts` exists; check its @everyone extraction coverage.

---

## Plan

### Phase A — quorum-shared (root fix)

A1. `src/utils/permissions.ts` `hasPermission`: remove the `if (isSpaceOwner) return true` block. Make it role-only. Keep the `isSpaceOwner` param in the signature (callers pass it; for kick they use other paths) but stop honoring it — OR drop the param entirely and fix callers. **Decision needed:** keep-param-ignored (smaller caller churn) vs remove-param (honest signature, more churn). Recommend keep-param-but-ignored short-term with a doc comment, remove in a follow-up. Update the function's JSDoc (line 12 currently says "owners have all permissions").

A2. `src/utils/permissions.ts` `getUserPermissions`: remove the owner shortlist (`if (isSpaceOwner) return ['message:delete','message:pin','mention:everyone']`). Role-only. (Zero callers in desktop; only the mobile `useUserPermissions` hook, which itself has zero downstream callers — safe.)

A3. `src/utils/channelPermissions.ts`: fix the **stale header comment line 16** ("1. Space Owner - Has ALL permissions everywhere (inherent privilege)") — it contradicts every method body in the same file. Replace with the correct hierarchy (own-content → read-only managers → roles; owner = kick only). No code change in this file (methods are already correct).

A4. Add `src/utils/permissions.test.ts` (vitest) encoding correct behavior:
   - owner with no role → `hasPermission(..., 'message:pin'/'message:delete'/'mention:everyone'/'user:mute')` = **false**
   - user with a role granting X → true for X only
   - `getUserPermissions(owner-no-role)` = `[]`
   - non-member → false / []
   - (kick is not a `hasPermission` concern — assert nothing here)

A5. `yarn lint && yarn typecheck && yarn test:run`. Then **build**. Hold the **publish** until desktop+mobile changes are staged (so a published bad interaction can't ship alone).

### Phase B — quorum-desktop

B1. **Verify the shared fix lands correctly** (desktop uses `link:`, so it sees A1–A3 immediately after rebuild). Confirm:
   - pin/delete UI unchanged (already hardcode `isSpaceOwner:false` / raw role check) — regression check only.
   - mute unchanged (already `channelPermissions`, no bypass).
   - **@everyone**: owner-with-no-role now gets `canUseEveryone=false` at `MessageService.ts:4626` + `Channel.tsx:1130` → composer @everyone option hidden, `everyone:true` not set. **This is the intended fix.** Verify an owner WITH a `mention:everyone` role still can.

B2. **Receive-side @everyone validation (defense-in-depth).** Add a sender-authorization check in the incoming-message notification path so a malicious/old client can't spam @everyone even with the flag set. Shape mirrors the existing delete/pin receive checks: honor `mentions.everyone` only if `space.roles.some(r => r.members.includes(senderId) && r.permissions.includes('mention:everyone'))`. Candidate sites: the `isMentionedWithSettings` caller in `MessageService.ts:4427-4495`, or gate inside `saveMessage`/`addMessage` before the notification fires. **Note:** same privacy constraint — can't protect against owner-self, only enforce the role rule uniformly. Decide whether this is in-scope now or a fast-follow.

B3. Desktop tsc + manual QA (owner-no-role can't @everyone; roled user can; @everyone from an unauthorized sender doesn't notify after B2).

### Phase C — quorum-mobile

C1. **Revert 0.1's owner bypass for pin/delete.** In `app/(tabs)/spaces/[id]/[channelId].tsx`, compute `hasPinPermission`/`hasDeletePermission` role-only (do NOT let `isSpaceOwner` grant them) to match desktop. Options: (a) after Phase A the shared `hasPermission` is already role-only, so `useHasPermission` automatically stops granting owners pin/delete — **no caller change needed**, just verify; (b) if shared isn't bumped yet on mobile, do the interim caller fix (pass a role-only path). Keep `useIsSpaceOwner` for the genuinely owner-only UI (invite button, kick entry). Update the misleading comment added in 0.1 ("folds in the owner short-circuit").

C2. **Add receive-side `remove-message` validation** in `context/WebSocketContext.tsx:1815-1841`. Mirror desktop `MessageService.ts`: before applying an incoming delete, honor it only if (a) it targets the sender's OWN message, or (b) sender is in a role with `message:delete` (regular channel) / is a read-only-channel manager. Look up the target message's sender + the space roles from storage; drop the delete otherwise. This closes the "anyone deletes anyone on mobile" gap. (Pins on mobile are local-only MMKV — no receive path — so no pin receive-check needed.)

C3. **Bump mobile's shared dependency** to the newly published version from Phase A5. `yarn install`. Re-run the static-analysis gates.

C4. mobile tsc (edited files clean) + lint + runtime QA (see matrix).

### Phase D — publish + close-out

D1. Publish `quorum-shared` (the held A5 publish) once B + C are staged and verified against `link:`/local.
D2. Mobile bump (C3) consumes the published version.
D3. Correct the framing in the two superseded docs (see Correction below). Update `candidates.md` rows 26a–c to reflect the receive-side reality. Update bug doc status.

---

## Correction to prior docs (do this — the framing was wrong)

- **`2026-05-29-mobile-adopt-shared-permission-helpers.md`** states as an intentional fix: *"Space OWNERS will now see their owner-derived permissions (message:delete, message:pin, mention:everyone)... This is a fix."* **This is WRONG.** Owners should NOT get implicit pin/delete/everyone (docs #111 + `channelPermissions.ts`). That task adopted the buggy `hasPermission` owner-bypass. The read-side rewire (delegating to shared) is still fine; only the owner-bypass claim is wrong.
- **`candidates.md` rows 26a–c + 27 + the Wave 0 task** assume "route mobile through shared helpers = enforcement." Enforcement for delete/pin/@everyone actually lives **receive-side** (desktop) or is **send-side-only** (@everyone). Routing through `hasPermission` does NOT enforce; in the owner case it perpetuates the bug. The real mobile gaps are: (i) receive-side delete validation (missing entirely), (ii) the send-side button illusion (cosmetic), (iii) mute gating (0.3), (iv) read-only enforcement (0.4 — has its own receive-side question worth checking).

## Runtime test matrix (required)

**Shared/desktop:**
1. Owner, NO role → cannot @everyone (option hidden; sent message has no `everyone:true`); roled user → can.
2. Owner, NO role → pin/delete buttons behave as before the fix from the *recipient's* view (were always rejected on receipt); now also hidden on sender. Owner WITH role → works.
3. After B2: a crafted `everyone:true` from an unauthorized sender does NOT fire @everyone notification on recipients.

**Mobile:**
4. Owner, NO role → no pin/delete button (matches desktop). Owner/user WITH role → has them.
5. **Receive-side:** a `remove-message` from a sender lacking `message:delete` (and not the message author) is DROPPED on mobile (message stays). From an authorized sender (role or message author) → applied. This is the key new test.
6. Self-delete still works for everyone.

## Open decisions for review

1. A1: keep `isSpaceOwner` param (ignored) vs remove it from `hasPermission` signature.
2. B2 scope: receive-side @everyone validation now, or fast-follow after the root fix?
3. C2 scope: full receive-side delete validation now, or split into its own mobile PR (it's the highest-severity mobile item and somewhat independent of the owner-bypass thread)?
4. Publish tag: next `2.1.0-3x`? Confirm versioning convention with lead dev.

*Last updated: 2026-06-16 — resolved on mobile (C2 verified shipped in PR #76; C1 done on branch `fix/owner-pin-delete-buttons-role-only`); moved to `.done/`. Phases A/B remain other-repo work, tracked there.*
