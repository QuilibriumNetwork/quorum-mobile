---
type: task
title: "Make primaryUsername (and isProfilePublic) survive device switch and reach the published profile"
status: done
created: 2026-06-10
updated: 2026-06-16
severity: medium
scope: mobile + quorum-shared (config + public-profile + config→user read-back bridge)
fixes-bug: 2026-06-10-primary-username-not-synced-or-published
fixes-bug: 2026-06-10-isprofilepublic-not-syncing-mobile-to-desktop
blocks: [qns-username-display-cross-platform, qns-username-own-device-sync]
---

# Task: make `primaryUsername` (and `isProfilePublic`) survive a device switch and reliably reach the published public profile

> **Progress 2026-06-16 — code complete (PR #103), runtime verification pending.**
> The `2.1.0-31` shared publish (Gap A) landed and mobile is pinned to it. **Steps 2 + 3 shipped in mobile PR #103 (`cc0386f`):**
> - **Step 2 (outbound):** `primaryUsername` added to the `configUpdates` type + copy-block in `updateProfile` ([AuthContext.tsx:494-509](../../context/AuthContext.tsx#L494)).
> - **Step 3 (read-back bridge):** `primaryUsername` overlaid onto `user` in `configTask` — both the `setUser` functional update and the MMKV merge — gated on the **existing** `configIsNewer` LWW check that PR #81 already built for `bio`/`isProfilePublic` ([AuthContext.tsx:352-379](../../context/AuthContext.tsx#L352)). No new precedence decision: the design choice the original plan flagged was already resolved by #81's timestamp-based bridge.
> tsc-clean (no new errors in `AuthContext.tsx` vs. the pre-existing master baseline); additive pure-JS, no native/wire change.
> **What remains:** (a) Step 4 (Gap C) is verification-only — confirm a published profile reliably carries `primary_username` after the fix; (b) runtime e2e (own-device publish + cross-device sync) is **deferred** — the current test user owns no QNS name, so there's nothing to set as primary. Re-run the Verification checklist once an account owning a QNS name is available on two devices. Only add a re-publish trigger to the "Set as Primary" handlers if the empty-`primary_username` symptom survives the bridge fix.
>
> **Progress 2026-06-13.**
> - **Step 3 (Gap B — config→user read-back bridge): DONE in mobile PR #81** (`fix/profile-settings-sync-mobile-to-desktop`). Bridges `bio` + `isProfilePublic` with timestamp precedence + privacy guard. **CORRECTION:** this fixes the **desktop→mobile** direction (mobile now reads those fields back). It does **NOT** fix the reported `isProfilePublic` **mobile→desktop** sibling bug — investigation on 2026-06-13 proved that bug is **desktop-side** (desktop only server-fetches config at startup; stale until restart). See the corrected sibling bug report + the new desktop bug (quorum-desktop `.agents/bugs/2026-06-13-config-not-refetched-stale-until-restart.md`). `primaryUsername` deliberately not bridged yet (its `UserConfig` field didn't exist when the bridge shipped).
> - **Step 1 (Gap A — add `primaryUsername` to shared `UserConfig`): MERGED** in quorum-shared PR #40 (`feat/userconfig-primary-username`), version bumped to **`2.1.0-30`** on shared master.
> - **Foreground re-sync deliberately NOT added (2026-06-13).** The bridge runs at login only, so a cross-device change needs a mobile relaunch to appear (weak UX). We chose not to add an AppState-foreground re-sync band-aid, mirroring the desktop decision: the lead dev's hub-log migration (bringing mobile's durable per-hub log to desktop, replayed via `log-since` on reconnect/foreground) is the proper real-time delivery vehicle for config-sync signals on BOTH clients. Building a foreground/polling refetch ahead of that migration is throwaway work. Sequence the real-time config refresh WITH the hub-log migration. Same reasoning as the desktop bug `quorum-desktop/.agents/bugs/2026-06-13-config-not-refetched-stale-until-restart.md`.
> - **Remaining before `primaryUsername` syncs end-to-end:** (a) publish `2.1.0-30` to npm — there is NO auto-publish CI in quorum-shared, so it needs a manual `npm publish` (Cassie / whoever has npm access); (b) bump mobile `package.json` `@quilibrium/quorum-shared` → `2.1.0-30`; (c) Step 2 — copy `primaryUsername` into `configUpdates` in `updateProfile`; (d) add the one-line `primaryUsername` overlay to the `configTask` bridge next to `bio`/`isProfilePublic`; (e) Step 4 — verify publish carries `primary_username`.
>
> **Rewritten 2026-06-12 after deep source verification.** The original draft's root-cause analysis for "Gap B" was wrong (the stale-closure-at-publish scenario it described does not exist in the code), its line numbers were stale by ~90-110 lines, its version numbers were wrong, and it mis-stated what unblocks desktop. The corrected analysis below replaces it. The header used to read "sync cross-device and reliably reach the published public profile"; the substance is the same intent, now grounded in what the code actually does. See **Appendix: what changed from the original draft** for the diff of claims.

## Why this task (vs. treating the two bugs separately)

Two bugs were filed together on 2026-06-10 (`primaryUsername` not published, `isProfilePublic` not syncing mobile→desktop). Deep verification shows **they share a single dominant root cause**, so one task fixes both:

> **Synced config fields are written outbound to the server but never read back into the in-memory `user` object.** On login, `configTask` ([context/AuthContext.tsx:311-325](../../context/AuthContext.tsx#L311-L325)) overlays **only** `config.name → user.displayName` and `config.profile_image → user.profileImage`. `isProfilePublic`, `bio`, and (once added) `primaryUsername` are decrypted, validated, and saved to local MMKV by `configService.getConfig` — but **never bridged into `user`**. There is no foreground re-sync either.

This is the engine behind both symptoms:
- **`isProfilePublic` (sibling bug):** value set on device 1 reaches device 2's config storage but never reaches device 2's `user.isProfilePublic`, so the toggle shows stale/OFF on the second device. The original sibling bug listed this missing read-back as a *"possible cause to investigate"* — verification confirms it is **the** cause.
- **`primaryUsername`:** compounded — it isn't even in `UserConfig`, so it never makes it into config storage to begin with (Gap A). Add it to config, and it would still be dropped by the same missing read-back bridge.

**Scope decision (confirmed with user 2026-06-10, reaffirmed 2026-06-12): config + public profile + the config→user read-back bridge.** Do NOT add `primaryUsername` to the per-message profile broadcast in this task — that's a separate lead-dev design call (see Out of scope).

## Ground truth (verified against source 2026-06-12 — line numbers current as of commit `b8ad64d`)

### Transport model (so "server" below isn't misread)

Quorum is decentralized, but the two flows this task touches are **client↔hub**, not P2P, and the value still depends on a central relay. Verified against `quorum-desktop/.agents/docs/config-sync-system.md` and `data-management-architecture-guide.md`:

- **The "Quorum API" / hub** is `https://api.quorummessenger.com` (+ `wss://.../ws`). It is a **relay + encrypted-blob store**, NOT a trusted server that reads your data. It cannot decrypt E2EE messages or the config; it stores ciphertext and verifies Ed448 signatures on write.
- **Config sync** = `POST/GET /api/settings/{address}` carrying an **AES-GCM-encrypted, Ed448-signed `UserConfig` blob**. Cross-device delivery is last-write-wins by timestamp. No peer is involved.
- **Public-profile publish** = `POST /users/:addr/public-profile` carrying a **signed (v1/v2) plaintext profile**. Other users `GET` it. This is the desktop QNS display feature's sole source ("Route A").
- **Mobile note:** mobile has **removed P2P space-sync** and uses a server-side hub-log transport (`listen-hub`/`log-since`); of the two clients, mobile is the *less* P2P one. So "comes from the server" is accurate for mobile's config + public-profile paths. (P2P only governs desktop's space *history* backfill, which this task does not touch.)

Whenever this doc says "server" below, it means this encrypted-blob relay/hub — not a data-reading central authority. **None of the gaps or fixes depend on the transport**: the root cause is a local read-back step on the receiving device, downstream of however the bytes arrive.

### Existing machinery

The publish/signing/wire machinery for `primary_username` **already fully exists**. This is NOT a feature build-out — it's (1) plumbing one value into the synced config, and (2) closing the read-back bridge so config fields actually reach `user`.

- `services/profile/publicProfile.ts` already has a v1/v2 signed-payload scheme and conditionally writes `primary_username` when `input.primaryUsername` is truthy — payload selection at [publicProfile.ts:92-100](../../services/profile/publicProfile.ts#L92-L100), wire body at [:107](../../services/profile/publicProfile.ts#L107). The in-file comment confirms **the server already understands v2** ([:86-91](../../services/profile/publicProfile.ts#L86-L91)). v2 canonical form: `public-profile-v2:address:displayName:profileImage:bio:primaryUsername:` + BE64(timestamp).
- `services/api/quorumClient.ts` `postPublicProfile` already types `primary_username?`. No client type change needed.
- `@quilibrium/quorum-shared` `PublicProfile` already has `primary_username?` ([node_modules/.../src/types/user.ts:116](../../node_modules/@quilibrium/quorum-shared/src/types/user.ts#L116)) — this is the **wire format**, NOT `UserConfig`.
- `UserInfo` (the in-memory app user, [AuthContext.tsx:42-54](../../context/AuthContext.tsx#L42-L54)) **already declares** `primaryUsername?`, `bio?`, and `isProfilePublic?`. So bridging config→user needs **no `UserInfo` type change**.

### Version state (corrected)
- Mobile pins `@quilibrium/quorum-shared` at **`2.1.0-26`** ([package.json:31](../../package.json#L31)), resolved from `node_modules` (versioned package, **not** a workspace link).
- Local source checkout `../quorum-shared` is at **`2.1.0-29`** (3 versions ahead, not 8 as the original draft claimed).
- `UserConfig` has **no** `primaryUsername` in either the installed `-26` copy OR local source `-29`. Confirmed by reading `src/types/user.ts` `UserConfig` (lines 37-96) in both. Only `PublicProfile.primary_username` exists (wire format) — different type, easy to conflate.

## The three real gaps

### Gap A — `primaryUsername` is not in the synced `UserConfig` (MMKV-local only)
- `UserConfig` ([user.ts:37-96](../../node_modules/@quilibrium/quorum-shared/src/types/user.ts#L37-L96)) has no `primaryUsername`/`primary_username` field. Note it uses **camelCase** for app-level fields (`isProfilePublic`, `showMutedChannels`, `hideMutedSpacesFromSidebar`, `favoriteDMs`) and snake_case only for the wire-aligned `name`/`profile_image`/`bio`.
- `updateProfile` builds `configUpdates` with only `name`/`profile_image`/`bio`/`isProfilePublic` ([AuthContext.tsx:434-446](../../context/AuthContext.tsx#L434-L446)) — `primaryUsername` is never copied in, so `saveConfig` never syncs it.
- **Consequence:** a user's primary username never reaches their other devices.

### Gap B — the config→user **read-back bridge** is missing (the dominant root cause, affects BOTH fields)
- `getConfig` decrypts the remote config and persists `isProfilePublic`/`bio` into local MMKV config ([configService.ts:393-404](../../services/config/configService.ts#L393-L404)). That's storage, not `user`.
- On login, `configTask` is the ONLY place that overlays config onto `user`, and it overlays only `displayName`/`profileImage`, gated on `if (config.name || config.profile_image)` ([AuthContext.tsx:313-322](../../context/AuthContext.tsx#L313-L322)):
  ```ts
  const config = await getConfig(parsedUser.address);
  if (config.name || config.profile_image) {
    const updatedUser = {
      ...parsedUser,
      displayName: config.name || parsedUser.displayName,
      profileImage: config.profile_image || parsedUser.profileImage,
    };
    setUser(updatedUser);
    mmkvStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(updatedUser));
  }
  ```
- **No** path reads `config.isProfilePublic` (or a future `config.primaryUsername`) back into `user`. Verified exhaustively: no foreground AppState handler re-fetches config into `user`; `useUserConfig` keeps its own separate hook state and never calls `setUser`/`updateProfile`; onboarding only seeds `name`/`profile_image`. (`AppState` handler at [:382-392](../../context/AuthContext.tsx#L382-L392) refreshes only the Farcaster token.)
- **Consequence:** even after Gap A is fixed, a freshly-synced device's `user.primaryUsername`/`user.isProfilePublic` stay empty/stale. This is exactly the `isProfilePublic` sibling-bug symptom.

### Gap C — the publish path can omit `primary_username` whenever `user.primaryUsername` is empty at publish time
- **The original draft's "stale-closure from the same interaction" framing is wrong and must not be carried forward.** Verified: the three "Set as Primary" entry points each call only `updateProfile({ primaryUsername: name })` + an `Alert`, and **none triggers a publish**:
  - [ProfileModal.tsx:1684](../../components/ProfileModal.tsx#L1684) (owned names list)
  - [ProfileModal.tsx:1778](../../components/ProfileModal.tsx#L1778) (delegated names list)
  - [components/qns/NameDetailModal.tsx:96-99](../../components/qns/NameDetailModal.tsx#L96-L99) (`handleSetPrimary` — the original draft missed this one entirely)
- So no publish ever fires "from the same interaction" that set the primary name. The three actual publish sites are independent user actions that read `user.primaryUsername`:
  - [ProfileModal.tsx:641-648](../../components/ProfileModal.tsx#L641-L648) — "Make Public" toggle handler (`primaryUsername: user.primaryUsername` at [:646](../../components/ProfileModal.tsx#L646))
  - [ProfileModal.tsx:955-962](../../components/ProfileModal.tsx#L955-L962) — avatar-change handler (`:960`)
  - [ProfileModal.tsx:1044-1051](../../components/ProfileModal.tsx#L1044-L1051) — "Save Profile" handler (`:1049`)
- **The actual failure mode** that produced the empty-`primary_username` server symptom in the bug report is one (or more) of:
  1. **Empty source value** — `user.primaryUsername` is empty when a publish fires because Gap B left it un-bridged after a login/sync (the device that published never had the value in memory). This is the most likely cause of the reported symptom and is **fixed by Gap A + Gap B**, not by touching the publish sites.
  2. **No re-publish after setting primary** — the user set primary *after* the profile was already public and never subsequently toggled/saved/changed-avatar, so no publish ran with the new value. A "Set as Primary while public → re-publish" trigger would close this (see Step 4, optional).
  3. **Stale build** — the installed APK predates the `primaryUsername` publish code. Out of repo scope; verify the test device runs current source.
- Because the publish sites already read the right field, Gap C needs **at most** a small reliability nudge (re-publish on Set-as-Primary when public), not a rewrite of how the value is read. Confirm the symptom is gone after Gap A+B before adding anything here.

## Plan

### Step 1 — Add `primaryUsername` to shared `UserConfig`
- File: `../quorum-shared\src\types\user.ts`, `UserConfig` type (lines 37-96).
- Add `primaryUsername?: string;` — **camelCase**, matching `isProfilePublic` and the other app-level config fields. (Do NOT use snake_case `primary_username`; that's reserved for the wire-format `PublicProfile`.)
- **Additive + optional only** — this satisfies the desktop design doc's hard "do not break mobile" guardrail (additive optional field, provably non-breaking).
- **Consumption mechanism:** mobile resolves shared from `node_modules` as a versioned package. So the change must: (1) land in the source repo, (2) be published + version-bumped, (3) mobile's `package.json` dependency bumped to pick it up. Coordinate with desktop so it picks up the same version. **Do NOT hand-edit `node_modules` as the deliverable.**
- **Version drift check:** mobile is 3 shared-versions behind (`-26` vs `-29`). Glance at the `-27..-29` changelog before bumping — the bump may pull in unrelated `UserConfig` drift. (`hideMutedSpacesFromSidebar` is already present in `-26`, so that earlier concern is moot.)

### Step 2 — Sync `primaryUsername` outbound through `updateProfile`
- File: [context/AuthContext.tsx](../../context/AuthContext.tsx), inside `updateProfile` ([:422-462](../../context/AuthContext.tsx#L422-L462)).
- Widen the `configUpdates` type ([:434](../../context/AuthContext.tsx#L434)) to include `primaryUsername?: string`.
- Add the copy after the `isProfilePublic` block ([:444-446](../../context/AuthContext.tsx#L444-L446)):
  ```ts
  if (updates.primaryUsername !== undefined) {
    configUpdates.primaryUsername = updates.primaryUsername;
  }
  ```
- Note: the MMKV write of the full `user` (including `primaryUsername`) already happens synchronously inside the `setUser` updater at [:426](../../context/AuthContext.tsx#L426); only the *config* sync is missing the field.

### Step 3 — Close the config→user read-back bridge (Gap B — the core fix, covers both fields)
- File: [context/AuthContext.tsx](../../context/AuthContext.tsx), `configTask` ([:311-325](../../context/AuthContext.tsx#L311-L325)).
- Extend the overlay so synced config fields actually reach `user`. Two corrections to the existing block:
  1. **Widen the gate.** `if (config.name || config.profile_image)` skips the entire overlay when those are empty — which would drop a synced `isProfilePublic`/`primaryUsername` on an account with no display name set. Broaden the condition (or split it) so the boolean/username fields are applied even when name/image are empty.
  2. **Overlay the extra fields:**
     ```ts
     const updatedUser = {
       ...parsedUser,
       displayName: config.name || parsedUser.displayName,
       profileImage: config.profile_image || parsedUser.profileImage,
       bio: config.bio ?? parsedUser.bio,
       isProfilePublic: config.isProfilePublic ?? parsedUser.isProfilePublic,
       primaryUsername: config.primaryUsername ?? parsedUser.primaryUsername,
     };
     ```
- **Precedence caveat to decide explicitly:** `getConfig` is last-write-wins by server timestamp. If the local MMKV `user` is newer than the remote config (user just changed something offline), blindly overlaying remote could clobber a fresh local value. Mitigations, pick one and document it:
  - Prefer `config.*` only when the remote config timestamp ≥ the local user's last-write (cleanest, mirrors `getConfig`'s own LWW).
  - Or use `??` (config fills only when the local field is `undefined`) — simpler, but won't propagate a *changed* remote value over an existing local one (e.g. turning public OFF on another device won't reflect). For a cross-device toggle this is probably insufficient; lean toward the timestamp approach.
- **Also persist the overlay to MMKV** (as the existing block already does at [:321](../../context/AuthContext.tsx#L321)) so it survives the next cold start without a re-fetch.
- **Optional but recommended:** add a lightweight foreground re-sync (AppState `active`) that re-runs `getConfig` + the same overlay, so a device that was already open picks up a cross-device change without a restart. The existing AppState listener at [:382-392](../../context/AuthContext.tsx#L382-L392) is the natural hook. Gate on `authState === 'authenticated'` and throttle. (If this expands scope too far, ship the launch-time bridge and file a follow-up.)

### Step 4 — Verify publish reliability (Gap C) — likely NO code change needed
- **Do this step as verification first, code change only if the symptom persists.**
- After Steps 1-3, re-run the own-device and cross-device repros below. If the published profile now reliably carries `primary_username`, **Gap C needs no code change** — the empty-source-value failure mode was the cause and it's fixed.
- **Only if a gap remains** (specifically: user sets primary while already public and the server profile still lacks it because nothing re-published): add a re-publish trigger to the "Set as Primary" handlers when `user.isProfilePublic` is true. Apply to all three sites consistently:
  - [ProfileModal.tsx:1684](../../components/ProfileModal.tsx#L1684), [:1778](../../components/ProfileModal.tsx#L1778), [NameDetailModal.tsx:96](../../components/qns/NameDetailModal.tsx#L96).
  - Pass the just-set `name` directly into the publish (don't rely on `user.primaryUsername` having re-rendered) to avoid the async-`setUser` race in the same handler.
- Do **not** rewrite the three existing publish sites' reads — they already read `user.primaryUsername`, which is correct once Gap B keeps it populated.

## Verification

> **Baseline note:** `npx tsc --noEmit --jsx react-jsx --skipLibCheck` is **already failing on master** (pre-existing FlashList `estimatedItemSize`, route-typing, and theme-token errors unrelated to this work). The bar is **"no NEW type errors introduced,"** not "clean." Capture the baseline error set before changes and diff after.

- [ ] **Type-check:** no new errors vs. the captured baseline (`npx tsc --noEmit --jsx react-jsx --skipLibCheck`).
- [ ] **Own-device publish (Gap C):** register/own a QNS name → "Set as Primary" → ensure public profile is ON → trigger a publish (toggle public, save profile, or change avatar). Probe the server:
      `GET https://api.quorummessenger.com/users/<addr>/public-profile` → response keys MUST include `primary_username`.
- [ ] **Cross-device sync (Gap A + Gap B):** with `allowSync` enabled, set primary + toggle public on device 1; on device 2 (same account) cold-launch (or foreground, if Step 3's optional re-sync was added) → `user.primaryUsername` populated AND the public-profile toggle in settings shows ON. **This is the direct fix-test for the `isProfilePublic` sibling bug** — both fields must now round-trip.
- [ ] **v1/v2 signature:** confirm the v2 payload (`public-profile-v2:…`) is signed when `primary_username` is present and the server accepts it (publish succeeds, no signature rejection).
- [ ] **Backwards-compat:** publishing WITHOUT a primary username still uses v1 and still succeeds.
- [ ] **No-name account:** an account with empty display name but `isProfilePublic`/`primaryUsername` set still gets those bridged on launch (confirms the Step 3 gate widening).
- [ ] **Precedence:** changing public OFF on device 1 reflects as OFF on device 2 after sync (confirms the overlay isn't a one-way `??` fill that ignores remote changes).
- [ ] **Desktop:** desktop renders `name.q` for this user once the published profile carries `primary_username` (cross-check with the desktop QNS-display task — desktop reads it from the **published profile**, see note below).

## Important architecture note: what actually unblocks desktop

**Desktop reads `primary_username` from the published public profile (the bug report's "Route A"), NOT from synced `UserConfig`.** Verified in desktop source: `quorum-desktop/src/components/direct/DirectMessage.tsx:234` reads `recipientPublicProfile?.primary_username`; there is no desktop code path that reads `primary_username` from a synced config. The desktop design doc states this explicitly ("the QNS name reaches other users' apps by riding along in the published public profile").

Therefore:
- **What unblocks the desktop cross-platform display feature = Gap C (publish reliably carries `primary_username`),** which is itself made reliable by Gap A+B keeping `user.primaryUsername` populated.
- **Gap A (config sync) alone does NOT unblock desktop.** Its purpose is the user's **own-device** sync (a fresh login on device 2 has the value to publish from), which feeds Gap C indirectly. The original draft's claim that "Gap A unblocks the desktop feature" was inaccurate.

## Out of scope (do not do in this task)

- **Profile broadcast.** Whether `primaryUsername` should ride in the per-message profile broadcast (so the verified name shows without a published public profile) is a lead-dev design decision — see the sibling bug's "Related" note and the desktop design doc. Park it.
- Editing `node_modules/@quilibrium/quorum-shared` as the deliverable (Step 1 must land in the real shared package + be published + bumped).
- Replacing mobile's QNS client or converging it onto the shared resolution helper (desktop-only for now, per the desktop design doc's guardrails).

## Related

- Bug (fixed by this): [`issues/.open/2026-06-10-primary-username-not-synced-or-published.md`](../.open/2026-06-10-primary-username-not-synced-or-published.md)
- Bug (**now also fixed** by Step 3, not just probed): [`issues/.open/2026-06-10-isprofilepublic-not-syncing-mobile-to-desktop.md`](../.open/2026-06-10-isprofilepublic-not-syncing-mobile-to-desktop.md) — the missing config→user read-back bridge is its root cause.
- Desktop feature: `quorum-desktop/.agents/tasks/port-from-mobile/2026-06-10-qns-username-display-{design,plan}.md`

## Appendix: what changed from the original draft (2026-06-12 verification)

| Original draft claim | Verified reality |
|---|---|
| `updateProfile` `configUpdates` at lines 333-345 | Actually 422-462 (block at 434-446). All draft line numbers were stale ~90-110 lines. |
| Publish sites at 581, 874, 956 | Actually 641, 955, 1044. |
| "Set as Primary" at 1623, 1717 | Actually 1684, 1778 — **plus a third site** `NameDetailModal.tsx:96` the draft missed. |
| Mobile on `2.1.0-20`, source `2.1.0-28`, 8 behind | Mobile `2.1.0-26`, source `2.1.0-29`, 3 behind. |
| Gap B = stale-closure when publish fires "from the same interaction that set the primary name" | **No such interaction exists.** All three "Set as Primary" handlers only call `updateProfile` + `Alert`; none publishes. The real Gap B is the missing config→user read-back bridge; the publish symptom is an empty *source value*, not a stale closure. |
| Gap A "unblocks the desktop QNS feature" | Desktop reads `primary_username` from the **published profile**, not config. Gap C (reliable publish) unblocks desktop; Gap A is own-device sync. |
| Step 3 "confirm where the app reads config back into user… add the bridge if missing" (hedged) | Confirmed missing for `isProfilePublic`, `bio`, and `primaryUsername`. Now the centerpiece (Step 3), not a side-check. |
| Verification: "Type-check passes" (implied clean) | Baseline is already failing; bar is "no new errors." |
| `isProfilePublic` bug only "probed," not fixed | Same root cause (Gap B); this task now fixes it. Scope widened per user decision 2026-06-12. |

*Last updated: 2026-06-12*
