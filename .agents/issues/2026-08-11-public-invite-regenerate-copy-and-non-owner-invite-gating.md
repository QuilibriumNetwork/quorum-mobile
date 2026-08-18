---
type: bug
title: "Public invite: 'Generate New Link' claims to invalidate the old link, is offered to non-owners, and never propagates the URL"
status: in-progress
priority: high
ai_generated: true
created: 2026-08-11
updated: 2026-08-18
---

# Public invite: 'Generate New Link' claims to invalidate the old link, is offered to non-owners, and never propagates the URL

> **⚠️ AI-Generated**: May contain errors. Verify before use.

Three defects in the public-invite surface, filed together because they are all
in the same flow.

**Scope correction (2026-08-11, after checking desktop):** findings 1 and 2 are
mobile-only, and desktop is the correct reference for both. Finding 3 is
**cross-client** — desktop has the same propagation gap and needs its own fix.
Do not implement this issue as a mobile-only change.

Desktop reference doc: `quorum-desktop/.agents/docs/features/invite-system-analysis.md`
(the "What Republish is actually for" callout at line 263 already flags mobile's
caption as misleading, and was never actioned on this side).

## Symptoms

### 1. The copy tells the user regenerating kills the old link. It does not.

Two strings promise invalidation:

- `components/InviteModal.tsx:276` — "Anyone with this link can join. You can
  regenerate it at any time to invalidate the old link."
- `components/SpaceSettingsModal.tsx:2451` — "This public link can be shared
  freely. Regenerate to invalidate the old link."

Regenerating produces the **byte-identical URL** and every previously-shared
copy keeps working. An owner who shares a link publicly, regrets it, and presses
"Generate New Link" believes they have revoked access. They have not. Nothing in
the product can revoke a public link today.

The button is also mislabelled: `InviteModal.tsx:291` says "Generate New Link",
which reinforces the false model. Desktop calls the same operation "Republish".

### 2. Every member sees an invite button that can only produce an error.

Mobile has three entry points into the invite UI and gates only two:

| Entry point | Gated to owner? |
|---|---|
| `components/SpaceSettingsModal.tsx:1449` Invites tab | Yes (`memberTabs` is Account + Members only) |
| `app/(tabs)/spaces/[id]/[channelId].tsx:363` channel header | Yes (`isSpaceOwner ? handleOpenInviteModal : undefined`) |
| `app/(tabs)/spaces/[id]/index.tsx:105` space overview banner | **No** |

`SpaceBannerHeader` takes `onInvite` as a required prop and renders the pill
unconditionally (`components/SpaceBannerHeader.tsx:114`), so the space overview
screen offers the invite affordance to every member.

**Members reaching the invite UI is desirable and must be preserved** — a member
sharing the owner's public link is a supported capability, and it is what
desktop deliberately offers. The defect is the *generate/republish* control
being shown to them, not the entry point.

What a non-owner actually gets today depends on whether their local Space record
has `inviteUrl` (see finding 3, which is why it usually does not):

- **`inviteUrl` present** — the modal opens straight into the link view
  (`components/InviteModal.tsx:56-67`) and **Copy and Share both work
  correctly**. Only "Generate New Link" fails. This is close to the desired
  behaviour already.
- **`inviteUrl` absent** — the modal opens on the One-Time / Public toggle, and
  both Generate buttons fail. This is the common case.

Both generate branches fail for a non-owner:

- **Public Link** throws "Owner key not found for space. Only space owners can
  generate public invites." (`services/space/inviteService.ts:305`) because
  `getSpaceKey(spaceId, 'owner')` returns nothing.
- **One-Time** throws "Cannot generate invites from this space. The invite pool
  was not initialized." (`services/space/inviteService.ts:137-138`) because a
  joiner's encryption state is persisted as `{ state: … }` with no `template`
  and no `evals` (`hooks/chat/useSpaceActions.ts:551-571`). The evals pool is
  only ever produced at space creation (`services/crypto/space-session.ts:408`);
  the WebSocket paths at `context/WebSocketContext.tsx:1102-1110` and `:2172`
  merely *preserve* an existing pool, they never create one for a member.

Not a security hole: the owner private key is required locally and the server
verifies the owner signature on the eval upload. It is a dead-end UI that
surfaces a raw internal error string to ordinary members.

Desktop's equivalent for a non-owner is a purpose-built read-only view (link box
+ Copy + Send via DM, no generate, no republish, no one-time) at
`quorum-desktop/src/components/modals/SpaceSettingsModal/Invites.tsx:382-470`,
and the Invites category is only reachable for a non-owner when a public link
actually exists (`.../SpaceSettingsModal.tsx:222-229`).

### 3. Generating a public link never tells anyone else about it.

Two separate defects, one mobile-only and one shared by both clients.

**3a — mobile publishes a manifest with no invite URL (mobile only).**
`generatePublicInviteLink` POSTs the manifest at
`services/space/inviteService.ts:464`, then assigns `space.inviteUrl` at `:485`.
The manifest this very operation publishes therefore carries no invite URL, so
even a brand-new joiner fetching via the link gets a Space record without it.

Desktop does this correctly: `space.inviteUrl = inviteLink` at
`quorum-desktop/src/services/InvitationService.ts:363`, *before* the manifest is
encrypted at `:368`. Pure ordering bug on the mobile side.

**3b — neither client tells existing members (mobile AND desktop).**

- Mobile: `broadcastSpaceUpdate` is imported at
  `services/space/inviteService.ts:20` and **never called** anywhere in the file.
  Dead import.
- Desktop: `generateNewInviteLink` finishes with `await this.messageDB.saveSpace(space)`
  plus a `setQueryData` and no broadcast
  (`quorum-desktop/src/services/InvitationService.ts:423-427`).

On both clients the new `inviteUrl` therefore stays local to the owner's device
until the owner happens to edit the space for some unrelated reason (name, icon,
description), which broadcasts the full record.

This directly undermines desktop's own non-owner Invites view, which is built
entirely on the replicated `space.inviteUrl` and is hidden outright when it is
absent (`.../SpaceSettingsModal.tsx:222-229`). The comment at
`.../Invites.tsx:382-386` claims the URL is "replicated to every member's local
Space record via the encrypted manifest" — but the manifest is what *joiners*
fetch, not something existing members re-read.

> **RESOLVED 2026-08-11 (recon R2, see Solution):** existing members never
> refetch the manifest. Every `getSpaceManifest` call site on both clients is a
> join or a device-restore. So an already-joined member on an existing device
> has **no path at all** to a newly generated `inviteUrl` until an unrelated
> space edit happens. 3b is the reason members effectively never receive a
> public invite link, and it is the highest-value fix in this issue.

## Root Cause

**Finding 1** — `generatePublicInviteLink` deliberately reuses the space's
existing config key rather than minting a new one
(`services/space/inviteService.ts:332-339`, comment: "Use the EXISTING space
config key (not a new one)"). The URL is built from that key at `:482`, so it is
deterministic per space. What the operation actually refreshes is the
server-side eval (`postInviteEvals`, `:430`) and the manifest snapshot (`:464`).
The copy describes a key-rotation that the implementation deliberately does not
perform.

This is correct behaviour, not a bug in the crypto: rotating the config key
would break hub envelope encryption for existing members. Desktop converged on
the same design and documented it. Only the mobile copy was never updated.

There is also no server-side `DELETE /invite/evals`, so "invalidate the old
link" is not merely inaccurate, it is currently unimplementable.

**Finding 2** — the space overview screen predates the ownership gating that was
later added to the channel header and the settings tabs. `SpaceBannerHeader`
declares `onInvite: () => void` (non-optional, `components/SpaceBannerHeader.tsx:36`)
so the type system actively prevents the caller from omitting it, which is
probably why the gate was never added there.

**Finding 3** — ordering bug plus an abandoned intent. The dead
`broadcastSpaceUpdate` import suggests propagation was planned and dropped.

## Solution

**Proposed. Not yet implemented.** Three changes. Fix 1 is trivial and
independent. Fix 3 touches the space-update broadcast path and needs
cross-client verification. Fix 2 depends on Fix 3 to be useful in practice, so
the sensible order is 1, then 3, then 2 (or 3 and 2 together).

**Design intent to preserve:** a regular member is *supposed* to be able to
share the Space's public invite link. Nothing here should remove that. The goal
is to give members desktop's read-only share view and reserve
generate/republish for owners.

### Fix 1 — correct the copy (low risk)

- `components/InviteModal.tsx:276` → describe the real behaviour. Suggested:
  "Anyone with this link can join. The link does not expire. Republishing keeps
  the same URL and refreshes it if people report it is not working."
- `components/InviteModal.tsx:291` → rename the button "Generate New Link" to
  "Republish", matching desktop.
- `components/SpaceSettingsModal.tsx:2451` → same correction.
- While in `SpaceSettingsModal.tsx`, note the "New" button at `:2446` only clears
  the displayed link (`setGeneratedInviteLink(null)`) and returns the user to the
  Generate button. It does not itself regenerate. Either rename it ("Clear") or
  make it call the mutation.

Match desktop's wording so both clients say the same thing:
- `Invites.tsx:778` — "This link does not expire. Anyone with it can join your Space."
- `Invites.tsx:821` — "If users report that this invite link isn't working,
  click to republish it. The link URL stays the same."

### Fix 2 — give non-owners the read-only invite view (low risk)

**Keep the invite pill for every member.** Sharing the owner's public link is a
capability we want, and desktop already treats it as one. Gate the *generate*
controls, not the entry point.

In `components/InviteModal.tsx`, compute ownership the same way the channel
screen does (`!!getSpaceKey(spaceId, 'owner')`,
`app/(tabs)/spaces/[id]/[channelId].tsx:82-85`) and branch the render for a
non-owner, mirroring desktop's
`quorum-desktop/src/components/modals/SpaceSettingsModal/Invites.tsx:382-470`:

- Hide the One-Time / Public Link toggle entirely (a member can never mint
  either kind).
- Hide "Generate New Link" / "Generate Public Link".
- Show the existing `space.inviteUrl` with Copy and Share, which already work
  unmodified for members.
- Replace the corrected callout with the non-owner variant. Desktop's is
  "This link was generated by a Space owner. It does not expire."

**Decision (2026-08-11): no empty state — hide the entry point instead.** When
there is no public link, a member has nothing to do in this modal, so the invite
affordance is hidden rather than opening a dead-end screen. This is also
desktop's rule for the Invites category
(`quorum-desktop/src/components/modals/SpaceSettingsModal/SpaceSettingsModal.tsx:222-229`)
— though note (found in review, 2026-08-18) desktop currently gates on
**truthiness** (`!!space?.inviteUrl`), not `isPublicInvite()`, so desktop is
exposed to the same `kickUser` hazard described below; the shared helper is what
would truly converge them. Target condition on both clients:

```
canInvite = isSpaceOwner || isPublicInvite(space.inviteUrl ?? '')
```

Call sites:

1. `components/SpaceBannerHeader.tsx:36` — make `onInvite` optional
   (`onInvite?: () => void`) and wrap the pill at `:115` in `{onInvite && (…)}`.
   `rightButtons` is a flex row with a gap (`:238-241`), so the settings pill
   stays correctly placed with the invite pill removed. No layout work.
2. `app/(tabs)/spaces/[id]/index.tsx:105` — `onInvite={canInvite ? () => setInviteVisible(true) : undefined}`.
3. `app/(tabs)/spaces/[id]/[channelId].tsx:363` — relax the owner gate to
   `canInvite`, so all three entry points share one rule.
4. Optional but preferred: put the rule in a `useCanInviteToSpace(spaceId)` hook
   so it cannot drift between call sites again.

**Do not gate on `!!space.inviteUrl`.** `kickUser` overwrites that field with a
`quorum://join#spaceId=…&configKey=…` string
(`services/space/spaceService.ts:1018`, inside `kickUser` at `:532`). That scheme
is absent from `VALID_INVITE_PREFIXES` (`services/space/inviteService.ts:41-50`),
so it is not a usable public link — but it is truthy. After any kick, a
truthiness gate would show members an invite screen containing a dead URL. Use
the existing `isPublicInvite()` helper (`services/space/inviteService.ts:252-258`),
which parses the URL, rejects unknown prefixes, and requires `template` and
`secret` to be absent. It returns `false` for the `quorum://` value and `true`
only for a genuine public link.

> Side finding: `kickUser` writing a `quorum://` URL into `inviteUrl` at all
> looks wrong, and if that Space record is broadcast it would replace a valid
> public link on every member's device. Not investigated here. Worth its own
> issue.

**Fix 3 is a practical prerequisite.** Until `inviteUrl` propagates, most
members have no link, so the visible effect of this fix on its own is the invite
button disappearing for them. That is correct behaviour, but members only *gain*
the ability to share once propagation works. Land 3 first, or land them
together.

Independently, the two error strings in `inviteService.ts:305` and `:137-138`
are internal diagnostics and should not be user-facing. Even with the generate
buttons hidden, give the modal's error banner a friendlier message for the
owner-key case.

### Fix 3 — propagate `inviteUrl` (cross-repo; recon required first)

**Recon complete (2026-08-11). Both questions resolved — READ, from code, not
runtime-measured.**

**R1 — does the broadcast carry `inviteUrl`, and does the receive path write it?
Yes, on both clients.**

- Mobile send: `broadcastSpaceUpdate(space)` serializes the entire Space object
  (`JSON.stringify(space)`, `services/space/broadcastSpaceUpdate.ts:54`), POSTs
  the manifest, and returns a `wsEnvelope` the caller must dispatch.
- Mobile receive: `context/WebSocketContext.tsx:1823` `case 'space-manifest'`
  verifies the owner signature against the registration, decrypts with the
  config key, applies a staleness guard (`manifest.timestamp` vs the stored
  `space.modifiedDate`), then calls `saveSpace(updatedSpace)` at `:1937` — the
  whole record, so `inviteUrl` lands.
- Desktop send: `SpaceService.submitUpdateSpace(manifest)`
  (`src/services/SpaceService.ts:85`) takes an already-built manifest and
  enqueues the hub envelope.
- Desktop receive: `src/services/MessageService.ts:5193` verifies, decrypts,
  casts to `Space` and calls `messageDB.saveSpace(space)` plus `setQueryData`.
  Whole record.

Nothing in the broadcast or receive path drops the field. The fix is purely that
neither invite path ever *sends* one.

**R2 — do existing members ever refetch the manifest? No.** Every
`getSpaceManifest` call site on both clients is either a join or a
device-restore:

| Client | Call site | When |
|---|---|---|
| Mobile | `services/config/spaceSyncService.ts:146` | restoring a space onto a device that does not have it |
| Mobile | `services/space/inviteService.ts:105` | owner-side self-heal before handing out an invite |
| Mobile | `hooks/chat/useSpaceActions.ts:151,214` | joining |
| Desktop | `src/services/ConfigService.ts:375` | restoring a space onto a device that does not have it |
| Desktop | `src/hooks/business/spaces/useInviteValidation.ts:49` | join preview |
| Desktop | `src/services/InvitationService.ts:472,535` | joining |

**So 3b is real, not cosmetic.** An already-joined member on an existing device
has no path to the new `inviteUrl` at all until an unrelated space edit
broadcasts the full record. This is the reason members effectively never see a
public invite link, and it makes 3b the highest-value fix of the three.

### Fix shape (revised after recon)

**Do not call `broadcastSpaceUpdate` from the invite path.** It generates its own
fresh ephemeral X448 key (`broadcastSpaceUpdate.ts:53`) and POSTs its own
manifest, whereas the invite path deliberately encrypts its manifest with the
*same* ephemeral key as the eval (`services/space/inviteService.ts:443-451`).
Calling it would overwrite the eval-aligned manifest with a differently-keyed
one, breaking the legacy-server fallback described in the desktop doc's "The
eval's ephemeral key is NOT the manifest's" callout. Send only the envelope.

**Mobile — `services/space/inviteService.ts::generatePublicInviteLink`:**

1. **(3a)** Move `space.inviteUrl = inviteLink` (currently `:485`) above the
   manifest encryption at `:444`, so the published manifest carries the URL.
   Confirm the ciphertext is built from the same mutated `space` object. Desktop
   already does exactly this at `InvitationService.ts:363` — copy that ordering.
2. **(3b)** Hoist the manifest object currently passed inline to
   `client.postSpaceManifest` at `:464` into a variable, and after the POST call
   `sendSpaceManifestMessage(spaceId, manifest)`
   (`services/space/spaceMessageService.ts:1341`) to build the WS envelope from
   **that same manifest**. No second manifest, no ephemeral-key divergence.
3. Dispatch the envelope through `enqueueOutbound`. Two established patterns:
   - from the mutation hook, as `hooks/chat/useSpaceSettings.ts:89` does
     (preferred — `useGeneratePublicInvite` can call `useWebSocket()`);
   - or thread `enqueueOutbound` into the service as a parameter, as
     `services/space/channelBindings.ts:43-55` does.
4. Delete the now-confirmed-dead `broadcastSpaceUpdate` import at `:20`.

**Desktop — `src/services/InvitationService.ts::generateNewInviteLink`:**

**Tracked separately** in
[`quorum-desktop/.agents/issues/.open/2026-08-11-public-invite-link-never-reaches-existing-members.md`](../../../../quorum-desktop/.agents/issues/.open/2026-08-11-public-invite-link-never-reaches-existing-members.md)
so the two repos can be worked in parallel. Summary of that half:

5. **(3b)** After `postSpaceManifest` at `:410`, call
   `submitUpdateSpace(manifest)` (`src/services/SpaceService.ts:85`) with the
   same manifest object. Desktop needs no 3a fix; its ordering is already
   correct.
6. **Wiring check — resolved 2026-08-11:** `InvitationService` does **not** hold
   a `SpaceService` reference (`src/services/InvitationService.ts:44-67`), and
   `new InvitationService` is constructed *before* `new SpaceService`
   (`src/components/context/MessageDB.tsx:932` vs `:1137`), so plain injection
   needs a reorder or a lazy getter. Preferred alternative: extract
   `submitUpdateSpace` into a standalone helper both services import, which
   mirrors mobile's `sendSpaceManifestMessage` and sidesteps the ordering
   problem. Options weighed in the desktop issue.

**Cross-client acceptance test** (this is the whole point of the fix, so it is
the pass/fail criterion, not an optional extra):

- Owner on mobile generates a public link → a desktop member, already joined and
  online, sees the Invites category appear and the link populate without the
  owner touching space settings.
- Owner on desktop generates a public link → a mobile member sees the invite
  pill appear (once Fix 2 lands) and the link populate.
- Control arm: a member of a *different* space sees no change. If both move, the
  instrument is wrong.

This is a silent-failure class of change (nothing visibly breaks if it fails to
propagate; the link just never appears), so it must not ship on code reading
alone.

## Release sequencing and interop

**Verdict: safe to ship desktop-first. Desktop does not have to wait for a
mobile release.**

Assessed against the standing constraint that a desktop release must never break
interop with the mobile build already in production.

**Why it is safe: the fix adds no new message type and no schema change.**
`space-manifest` is an existing hub control message that today's production
mobile already handles (`context/WebSocketContext.tsx:1823`) and that every
rename, icon change and role grant already sends. Fix 3b only makes the invite
path send one at a moment it currently does not. The payload shape is identical.

| Combination | Result |
|---|---|
| New desktop → **old (production) mobile** | Old mobile receives a message type it already understands, decrypts it, and `saveSpace`s the record including `inviteUrl`. **Today's shipped mobile gains the fix for desktop-generated links without shipping anything.** |
| New mobile → old desktop | Desktop already handles the message (`MessageService.ts:5193`). Fine. |
| New ↔ new | Fully fixed both directions. |

Better than "additive and ignorable" — an unpatched client is an immediate
*beneficiary*, because the gap was never in the receive path.

**The interim state is asymmetric but strictly better, with no regression:**

- Desktop-generated public links start reaching every member (desktop and
  mobile) the moment desktop ships.
- Mobile-generated public links still reach nobody, exactly as today. Unchanged,
  not made worse.

So the only thing waiting on a mobile release is mobile's own ability to
originate a link that propagates. Nothing breaks in the meantime.

### Fold into the fix: bump `modifiedDate` with `inviteUrl`

**INFERRED from reading the guard, not measured — verify before relying on it.**

Mobile's receive path skips a manifest when
`manifest.timestamp < existingSpace.modifiedDate`
(`context/WebSocketContext.tsx:1921-1935`), then writes the record wholesale.
`generatePublicInviteLink` does not currently touch `modifiedDate`, so the
broadcast would carry an **old** `modifiedDate` alongside a **new**
`manifest.timestamp`. The guard passes (the timestamp is fresh), the record is
applied, and the member's stored `modifiedDate` can be written *backwards* —
lowering the watermark that protects against the hub's replay of historical log
entries on reconnect.

Cheap fix: set `space.modifiedDate = timestamp` at the same point as
`space.inviteUrl`, keeping the record monotonic. Do the same on desktop.

Unchecked: whether desktop's receive handler has an equivalent staleness guard.
Only part of `MessageService.ts:5193+` was read.

## quorum-shared

Two pure predicates belong in shared, because both clients must agree on them
and have already drifted twice:

1. **`isPublicInvite(url: string): boolean`** — mobile has a local copy at
   `services/space/inviteService.ts:252-258`; shared has no equivalent, only
   `parseInviteParams`. This is the function that protects the Fix 2 gate from
   `kickUser`'s `quorum://` value, so a divergence between clients means one of
   them shows members a dead link.
2. **`canInviteToSpace({ isOwner, inviteUrl }): boolean`** — the Fix 2 rule.
   Shared already hosts this shape of helper (`src/utils/channelPermissions.ts`),
   and centralising it is what prevents a third round of invite-gating drift.

**Stays per-client:** all UI copy. Desktop uses lingui `<Trans>`, mobile uses
plain strings, and there is no shared i18n layer.

**Nothing in this issue is blocked on a shared publish, and nothing should be
sequenced behind one.** Fix 3b needs no shared change at all. Fix 2 can use
mobile's *existing* local `isPublicInvite` plus the same inline owner check the
channel screen already uses (`[channelId].tsx:82-85`) — that is not new local
duplication, the helper predates this work.

Recommended handling, matching the shared-first default: land the two helpers in
shared whenever convenient (desktop picks them up immediately through `link:`),
and let mobile switch to them at its next pinned-version bump. Do **not** hold
the fixes waiting for a publish, and do **not** write a *new* `canInviteToSpace`
util locally in mobile — inline the expression at the call sites until shared's
version is available.

> **Sequencing hazard — do not bundle with the blocked domain rewire.** Shared
> already exports `getInviteUrlBase`, `getValidInvitePrefixes` and
> `parseInviteParams` from `src/utils/inviteDomain.ts`, and mobile deliberately
> does not consume them. That rewire is tracked separately in
> [`quorum-shared-migration/2026-05-29-mobile-rewire-invite-helpers-to-shared.md`](../quorum-shared-migration/2026-05-29-mobile-rewire-invite-helpers-to-shared.md),
> **blocked since 2026-06-09** pending a lead-dev call on whether mobile supports
> staging/localhost build targets. It touches the same file, and shared's
> `getInviteUrlBase` returns `qm.one` for production while mobile's local copy
> returns `app.quorummessenger.com`. Landing it alongside these fixes would
> change the domain of every generated link at the same moment as the copy
> describing that link. Adding the two new helpers above does **not** require
> unblocking it; keep them separate.

> **Fold-in decided 2026-08-18 — canonical invite domain (tracked in the desktop
> counterpart issue).** Desktop derives the invite-link domain from
> `window.location` (shared `inviteDomain.ts:13-45`): test/localhost builds
> generate test/localhost URLs, which persist in `space.inviteUrl` and — once
> Fix 3 lands — replicate to every member as unshareable links. Mobile's
> `VALID_INVITE_PREFIXES` (`inviteService.ts:41-50`) does not even include
> `test.quorummessenger.com`, so such a link fails `isPublicInvite()` and hides
> the Fix 2 member pill. Decision: shared's `getInviteUrlBase` returns the
> production base unconditionally, matching mobile's already-hardcoded generator
> (`inviteService.ts:68-72`); accept-side prefixes stay permissive so legacy
> links still parse. **Mobile needs no code change.** Plan and desktop call-site
> inventory live in the desktop counterpart issue. Side effect: this moots the
> staging/localhost build-target question that has kept the domain-rewire issue
> above blocked since 2026-06-09 — actually unblocking it stays a separate call.

## Readiness

| Part | State (2026-08-18) |
|---|---|
| Fix 1 (copy) | **Done**, branch `fix/public-invite-propagation-and-gating`. |
| Fix 2 (gate + read-only member view) | **Done.** Rule lives in `hooks/chat/useCanInviteToSpace.ts`, wired into all three entry points. |
| Fix 3a (mobile manifest ordering) | **Done.** `inviteUrl` and `modifiedDate` are both set before serialization. |
| Fix 3b (envelope, mobile side) | **Done.** Same manifest object is POSTed and enqueued; `enqueueOutbound` is a required parameter so it cannot be omitted. |
| Fix 3b (envelope, desktop side) | Not started — filed separately, workable in parallel. |
| Canonical invite domain (shared) | Not started — see the fold-in note above; desktop-side plan lives in the counterpart issue. |
| Cross-client acceptance test | **Not run.** Needs both halves; this is the pass/fail criterion and no amount of unit testing substitutes for it. |

**Desktop counterpart:**
[`quorum-desktop/.agents/issues/.open/2026-08-11-public-invite-link-never-reaches-existing-members.md`](../../../../quorum-desktop/.agents/issues/.open/2026-08-11-public-invite-link-never-reaches-existing-members.md)
(filed 2026-08-11, `type: bug`, `priority: high`). The two halves are
independent code changes and can proceed in parallel. **The acceptance test is
cross-client and needs both** — neither repo can prove its own half alone, since
the whole point is that one client's broadcast reaches the other's members.

**Priority note:** R2 showed 3b is not a polish item. Until it lands, no member
on either client reliably receives a public invite link at all, which makes it
the fix that actually restores the capability. 1 and 2 are correctness and
clarity around a feature that is currently not reaching anyone.

## Prevention

- **Copy that describes a security property must be traced to the code that
  implements it.** "Invalidate", "revoke", "expire" and "rotate" are claims a
  user acts on. This string survived a desktop-side consolidation that
  explicitly documented the opposite behaviour.
- **Gate the capability inside the feature, not at each entry point.** Three
  entry points with three different rules is what per-call-site gating always
  converges to. `InviteModal` knows whether the user is an owner; it should
  decide what to render, so every caller is automatically correct.
- **"Hide the button" is the wrong reflex when the underlying action is
  legitimate.** The first version of this write-up recommended removing the
  invite pill for members, which would have deleted a capability the product
  wants. The failing control was the generate button, not the entry point. When
  a surface errors for a role, ask whether the role should be doing a *narrower*
  version of the thing before removing access to it.
- **An unused import of a broadcast/sync helper is a propagation bug until
  proven otherwise.** Worth a lint rule: `no-unused-vars` on imports would have
  surfaced `broadcastSpaceUpdate` at `:20`.
- **Every bug found in one client gets checked against the other, and "the other
  client got it right" is a claim to verify, not assume.** This write-up
  originally asserted desktop was clean on all three findings, on the strength of
  desktop being correct on the two that were easy to see (copy, gating). Reading
  desktop's generate path to the end showed it shares finding 3b. Partial parity
  reads as full parity unless you check every finding separately.

## Related

- `quorum-desktop/.agents/docs/features/invite-system-analysis.md` — full invite
  architecture, both formats, the eval/manifest ephemeral-key trap. Line 263
  flags mobile's caption; line 307 records that no delete endpoint exists.
- `quorum-desktop/.agents/issues/.done/2026-06-07-consolidate-invite-system-with-mobile.md`
  — the consolidation that made both clients reuse the existing config key.
- `.agents/issues/.open/2026-08-10-invite-contact-picker-renders-an-unresolved-name.md`
  — separate defect in the same invite surface.

---

*Last updated: 2026-08-18*

## Updates
- **2026-08-11 14:09**: Fix 2 revised: keep the invite entry point for members (sharing the public link is a wanted capability), hide it only when no valid public link exists. Gate on isPublicInvite(), not truthiness — kickUser writes a quorum:// value into inviteUrl. Empty state dropped.
- **2026-08-11 14:15**: Checked desktop: finding 3 is cross-client, not mobile-only. Desktop generateNewInviteLink saves locally with no broadcast (InvitationService.ts:420-436), same gap as mobile. Split into 3a (mobile manifest ordering, desktop already correct) and 3b (no broadcast, both clients). Added recon gate R1/R2, cross-client acceptance test, quorum-shared section, readiness table. Desktop counterpart issue still to file.
- **2026-08-11 14:20**: Recon R1/R2 done. R1: broadcast carries full Space and both receive paths saveSpace the whole record (mobile WebSocketContext.tsx:1828-1940, desktop MessageService.ts:5184+); nothing drops inviteUrl, the invite path just never sends. R2: no manifest refetch for existing members on either client - every getSpaceManifest call site is a join or device-restore, so 3b is the reason members never get the link. Fix shape revised: send the WS envelope only (sendSpaceManifestMessage / submitUpdateSpace), do NOT call broadcastSpaceUpdate - it mints a fresh ephemeral key and would break eval/manifest key alignment.
- **2026-08-11 14:20**: Priority medium -> high. R2 showed the public invite link never reaches any existing member on either client, so this is a feature that does not work rather than a copy/UX polish item.
- **2026-08-11 14:24**: Desktop counterpart filed and cross-linked: quorum-desktop/.agents/issues/.open/2026-08-11-public-invite-link-never-reaches-existing-members.md. Wiring check resolved: InvitationService has no SpaceService ref and is constructed before it (MessageDB.tsx:928 vs :1133); preferred fix is extracting submitUpdateSpace to a standalone helper. Not starting implementation today.
- **2026-08-11 14:29**: Interop assessed: safe to ship desktop-first, no wait on a mobile release. No new message type, no schema change - space-manifest is already handled by production mobile, so unpatched mobile BENEFITS from a desktop-only ship. Nothing blocked on a quorum-shared publish either. Added: bump modifiedDate alongside inviteUrl (INFERRED risk that the record regresses the receiver's staleness watermark).
- **2026-08-18 16:33**: Fold-in decided: invite URLs are always generated with the canonical production domain. Desktop's env-derived domains (test./localhost via shared getInviteUrlBase) persist and would replicate as unshareable links once Fix 3 lands; mobile even rejects test.* in isPublicInvite. Shared's getInviteUrlBase becomes production-only, accept prefixes stay permissive, mobile unchanged. Plan recorded in the desktop counterpart issue.
- **2026-08-18 18:27**: Mobile Fix 1 + 2 + 3a/3b implemented on branch fix/public-invite-propagation-and-gating (4 commits). Fix 2 landed as a useCanInviteToSpace hook (owner OR isPublicInvite) wired into all three entry points; SpaceBannerHeader.onInvite made optional; InviteModal branches to a read-only member view. Two extra defects found while implementing and fixed: InviteModal loaded a stored link on truthiness so it displayed kickUser's dead quorum:// URL, and a failed republish rendered no error at all because the banner only existed in the generate view. Also: VALID_INVITE_PREFIXES pinned localhost:3000 while desktop had moved to Vite :5173, which made a real published link invisible on mobile. 1094 tests pass (25 new across 4 files); every new assertion verified red-then-green by reverting the fix. Still open: the desktop 3b half, the shared canonical-domain change, and the cross-client acceptance test which neither repo can run alone.

## Review Log
**2026-08-18 - claude-fable-5**: Re-verified all three findings against current mobile+desktop code (READ): all still valid, none implemented; refreshed drifted line refs; corrected one imprecise desktop claim
- Fix 1 unimplemented: copy intact at InviteModal.tsx:276/:291, SpaceSettingsModal.tsx string drifted 2441->2451
- Fix 2 unimplemented: SpaceBannerHeader.tsx:36 onInvite still required, index.tsx:105 still ungated, channelId.tsx:363 still owner-only
- Fix 3a/3b unimplemented: inviteService.ts inviteUrl assignment still at :485 after manifest POST :464, broadcastSpaceUpdate still dead import at :20; desktop generateNewInviteLink still ends saveSpace+setQueryData with no broadcast, counterpart issue still open in desktop .open/
- Precision fix: desktop gates Invites category on truthiness !!space?.inviteUrl (SpaceSettingsModal.tsx:222-229), not isPublicInvite as implied - same kickUser hazard the issue warns about; noted inline in Fix 2
- Line refs refreshed: mobile WebSocketContext 1828->1823, 1940->1937, 1924-1938->1921-1935, 1107-1114->1102-1110, 2177->2172, useSpaceActions 556-570->551-571, spaceMessageService ~1343->1341, useSpaceSettings path corrected to hooks/chat/; desktop MessageService 5184->5193, InvitationService 420-436->423-427, postSpaceManifest 469->410, MessageDB 928/1133->932/1137, Invites.tsx 775->778, 819-822->821
