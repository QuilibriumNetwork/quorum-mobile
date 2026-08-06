---
type: bug
title: "primaryUsername is never synced to config and may not reach the published public profile"
status: open
created: 2026-06-10
updated: 2026-08-06
severity: medium
blocks: [qns-username-display-cross-platform, qns-username-own-device-sync]
runtime-repro: confirmed
discovered-by: quorum-desktop QNS-usernames port (the first consumer of primary_username)
---

# `primaryUsername` is never synced to config and may not reach the published public profile

> **Progress 2026-06-13.** Gap A (add `primaryUsername` to shared `UserConfig`) is MERGED to quorum-shared master + bumped to `2.1.0-30` (PR #40) — but NOT yet published to npm (no auto-publish CI). Gap B's *mechanism* (the config→user read-back bridge) shipped in mobile PR #81, but it deliberately does NOT bridge `primaryUsername` because the field doesn't exist in the installed shared type yet. Still OPEN/BLOCKED. To finish once `2.1.0-30` is published + mobile dep bumped: Step 2 (copy `primaryUsername` into `configUpdates`) + one-line addition to the `configTask` bridge. See task `2026-06-10-primary-username-sync-and-publish.md`.

## Symptoms

A user (LaMat) has:
1. Registered a QNS name (`lamat` resolves via `https://names.quilibrium.com/resolve/lamat`).
2. Set it as their primary username in the mobile profile UI (`updateProfile({ primaryUsername: 'lamat' })`).
3. Toggled public profile ON and re-saved.

Yet the **published public profile on the server still has no `primary_username`**:

```
GET https://api.quorummessenger.com/users/QmUserUserEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imz/public-profile
→ keys: ['display_name', 'profile_image', 'bio', 'timestamp', 'signature']   // no primary_username
```

(Confirmed via direct server probe after the re-save, 2026-06-10.)

## Root cause (two interacting issues)

### A. `primaryUsername` is not part of the synced config — it's MMKV-local only

`context/AuthContext.tsx` `updateProfile` (lines ~321-360) saves the full user (incl. `primaryUsername`) to MMKV, but when it mirrors changes into the **synced server config** it only copies `name`, `profile_image`, `bio`, `isProfilePublic`:

```ts
const configUpdates: { name?; profile_image?; bio?; isProfilePublic? } = {};
// ...primaryUsername is NOT copied into configUpdates...
```

`UserConfig` (in `@quilibrium/quorum-shared`) has no `primaryUsername`/`primary_username` field at all. So the primary username **cannot propagate across a user's own devices** — it lives only on the device where it was set.

### B. The published profile omits `primary_username` because the source value is empty (CORRECTED 2026-06-12)

The publish machinery is **already complete** — this is a data-availability bug, not missing code:
- `services/profile/publicProfile.ts` has a v1/v2 signed-payload scheme and conditionally writes `primary_username` when `input.primaryUsername` is truthy (payload selection ~lines 92-100, wire body ~107). The server already understands v2 (per the in-file comment).
- `quorumClient.postPublicProfile` already types `primary_username?`.

The break is the *value fed in being empty at publish time*. **Correction to the original framing:** there is **no** "stale closure from the same interaction." The three "Set as Primary" entry points (ProfileModal.tsx:1684, ProfileModal.tsx:1778, NameDetailModal.tsx:96) each only call `updateProfile({ primaryUsername })` + an `Alert` — **none triggers a publish**. The three actual publish sites (ProfileModal.tsx:641, :955, :1044) read `user.primaryUsername`, which is correct *once the value is in `user`*.

Why it's empty at publish time on the affected device:
1. **Most likely:** the publishing device never had `primaryUsername` in `user` because it was set on another device and the config→`user` read-back bridge is missing (see Gap A + the sibling bug — `configTask` only bridges `name`/`profile_image`, never `primaryUsername`/`isProfilePublic`).
2. The user set primary *after* the profile was already public and never re-published (no toggle/save/avatar-change since).
3. Stale build: the installed APK predates the publish code.

Gap A compounds this: `primaryUsername` isn't even in `UserConfig`, so it can't reach config storage, let alone be bridged into `user`.

## Impact

- **Cross-device (own account):** a user's primary username never reaches their other devices (e.g. desktop logged into the same account) because it's not in the synced config.
- **Cross-user display:** other users can only see a `name.q` handle if the publishing user's published profile actually carries `primary_username`. With this bug, it often doesn't, so the verified-name handle never appears anywhere.
- Surfaced by the desktop QNS-usernames feature, which is the first code to read `primary_username` for display. Desktop's read/render path is correct; it has nothing to render because the field isn't published.

## Suggested fix direction (mobile + shared) — corrected 2026-06-12

1. Add `primaryUsername?: string` (camelCase) to shared `UserConfig` so it can sync cross-device.
2. Copy `primaryUsername` into `configUpdates` in `AuthContext.updateProfile` so it's persisted to the synced config.
3. **Close the config→`user` read-back bridge** in `configTask` so synced `primaryUsername`/`isProfilePublic` actually reach `user` on login (and ideally on foreground). This is the core fix and is shared with the sibling bug.
4. Publish path: verify-only. It already reads `user.primaryUsername` correctly; once (3) keeps it populated the symptom should clear. Add a re-publish-on-Set-as-Primary trigger only if a residual gap remains.

## Fix task

- [`issues/.done/2026-06-10-primary-username-sync-and-publish.md`](../.done/2026-06-10-primary-username-sync-and-publish.md) — scoped to config + public profile only (profile-broadcast question parked as a lead-dev call). Also serves as a live probe for the `isProfilePublic` sibling bug.

## Related

- Desktop feature: `quorum-desktop/.agents/tasks/port-from-mobile/2026-06-10-qns-username-display-{design,plan}.md`.
- Broader UX question (raise with lead dev): should `primaryUsername` also ride in the **profile broadcast** sent with messages, so the verified name shows without requiring a published public profile at all? (See the desktop design doc + the pending lead-dev Telegram note.)
- Sibling bug: [`2026-06-10-isprofilepublic-not-syncing-mobile-to-desktop.md`](2026-06-10-isprofilepublic-not-syncing-mobile-to-desktop.md) — same config→`user` read-back root cause.

*Last updated: 2026-06-12*

## Updates
- **2026-08-04 14:08**: 2026-08-04 re-check. The 2026-06-13 blockers are RESOLVED in code: installed shared 2.1.0-39 has UserConfig.primaryUsername (dist/types/user.d.ts:76); AuthContext.updateProfile copies it into configUpdates (line 510); the configTask read-back bridges it into both setUser and MMKV (lines 359, 379); publicProfile.ts already publishes it when truthy. So Gap A and Gap B's mechanism are both complete. BUT the symptom persists: re-running the issue's own server probe today returns keys [bio, display_name, profile_image, signature, timestamp] - still no primary_username. Open question is whether that account simply has not re-published since the fixes landed (cause 2 in the body) or the chain is still broken. Next step: save/re-publish the profile once, then re-probe. Do not close on the code reading alone.
- **2026-08-04 14:20**: CORRECTION to the note above (same day). The server probe in it is NOT evidence and should be ignored: it hit the address recorded in this issue back in June, which is not the account under test today, and the account actually being tested has no registered QNS name at all - so primary_username would be absent regardless of whether the code works. The code-reading half of that note still stands (all Gap A/B mechanisms are present in 2.1.0-39 + AuthContext + configTask + publicProfile.ts). What remains genuinely unverified is whether the chain PUBLISHES correctly, and verifying it needs an account that (a) has a registered QNS name, (b) has it set as primary, and (c) has public profile ON. Without such an account this cannot be measured, only read. Do not re-run the probe against the June address expecting a signal.
- **2026-08-06 — the open question in the note above is ANSWERED, and the answer is two causes, not one.**

  That note said verifying the publish chain needed an account with a registered
  QNS name, set primary, public profile ON, and that without one this "cannot be
  measured, only read". It turned out not to need such an account: the dev
  fake-QNS panel drives the same publish path on an account owning no name, so
  the whole round trip became measurable. Both causes are now identified.

  **Cause 1 (client) — electing a name never triggered a publish at all.**
  `handleSetPrimary` was `updateProfile({ primaryUsername })` plus an alert. The
  publish path read `user.primaryUsername` correctly, as this issue's step 4
  said, but nothing ever ran it on election. So the field only ever reached the
  server if some unrelated edit happened to publish afterwards. Step 4's
  "add a re-publish-on-Set-as-Primary trigger only if a residual gap remains"
  was exactly the residual gap. **Fixed in PR #238.**

  **Cause 2 (server) — the publish is refused, for everyone.** With cause 1
  fixed, the POST now happens and comes back:

  ```
  HTTP 400
  qns primary username failed validation: qns lookup: Get "./": stopped after 10 redirects
  ```

  Two names tried seconds apart from one account — one unregistered, one
  genuinely resolvable to a different address — produced byte-identical errors,
  so the failure precedes any consideration of the name. The server's own
  outbound QNS lookup URL is malformed. Filed as
  [`2026-08-06-server-rejects-every-primary-username-publish.md`](2026-08-06-server-rejects-every-primary-username-publish.md).

  **This explains the June probe rather than leaving it ambiguous.** Re-running
  it today against the same LaMat address returns the same key list, and now we
  know it is not a stale account or an unpublished profile: that record could
  not have carried a `primary_username` however many times it was re-saved.

  **Stays open.** Cause 1 is fixed and shipped; cause 2 is not ours. The
  end-to-end symptom this issue describes is unchanged until the server lookup is
  fixed, so this is not closable on the client work alone.

*Last updated: 2026-08-06*
