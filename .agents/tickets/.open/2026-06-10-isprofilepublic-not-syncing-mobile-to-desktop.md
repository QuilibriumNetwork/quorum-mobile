---
type: bug
title: "isProfilePublic toggle not syncing mobile to desktop (same account)"
status: open
created: 2026-06-10
updated: 2026-06-13
root-cause-repo: quorum-desktop
real-root-cause: "Desktop only server-fetches config at app startup (RegistrationPersister). useConfig reads IndexedDB only (no network), and there is no periodic/foreground/websocket config refetch. So a config change made on mobile reaches the server but desktop keeps showing its stale cached value until a restart."
severity: medium
runtime-repro: confirmed
discovered-by: quorum-desktop QNS-usernames port testing
needs-investigation: true
---

# `isProfilePublic` toggle not syncing mobile → desktop (same account)

> **Umbrella:** this is one symptom of the broader config-sync issue tracked in
> `2026-06-22-userconfig-blob-not-live-synced-cross-device-master.md` (UserConfig blob is
> restart-gated, not live). Fix it there (a live config-refetch trigger) and this resolves
> with it.

## Symptoms

On LaMat's account:
- **Mobile**: public-profile toggle is ON (and a public profile is published — confirmed on the server).
- **Desktop** (same account, logged in as LaMat, dev + a Netlify test prod build): the public-profile toggle in User Settings shows **OFF**.

So the user's own setting set on mobile is not reaching their desktop instance.

## Why this is notable

Unlike `primaryUsername` (which isn't in the synced config — see sibling bug), `isProfilePublic` **is** part of the synced `UserConfig` (`@quilibrium/quorum-shared` `UserConfig.isProfilePublic`), and `context/AuthContext.tsx` `updateProfile` **does** copy it into the config-sync path (`configUpdates.isProfilePublic = updates.isProfilePublic` when `allowSync`). So it *should* propagate cross-device. It isn't.

## Root cause (CORRECTED 2026-06-13 — it's DESKTOP-side, not the mobile bridge)

> **The 2026-06-12 analysis below was wrong.** It blamed the missing mobile config→user read-back bridge. Source verification on 2026-06-13 (both repos) disproved that for THIS direction. The reported symptom is mobile→desktop (mobile is the *sender*, desktop the *receiver*), and:
>
> - **Mobile sends correctly:** `updateProfile` copies `isProfilePublic` into `configUpdates` and `saveConfig` syncs it to the server ([context/AuthContext.tsx:504-505](../../context/AuthContext.tsx#L504-L505)). ✅
> - **Desktop reads correctly:** `useUserSettings` sets the toggle from `config.isProfilePublic` ([quorum-desktop/src/hooks/business/user/useUserSettings.ts:133](../../../quorum-desktop/src/hooks/business/user/useUserSettings.ts#L133)). ✅
> - **The gap is desktop's REFETCH:** desktop's `useConfig` query reads **IndexedDB only, never the network** (`buildConfigFetcher` → `messageDB.getUserConfig`; the file comment literally says "This query uses IndexedDB, not network"). The only thing that pulls the latest config from the server into IndexedDB is `ConfigService.getConfig` (which does correct timestamp LWW), and it runs essentially **once at app startup** (`RegistrationPersister`). There is **no periodic / foreground / websocket-driven config refetch**. So after desktop has started, a config change made on mobile reaches the server but desktop keeps serving its stale IndexedDB copy until a restart (or hard reset). This exactly matches the observed "only a full hard reset shows the change" behavior.
>
> **This bug therefore lives in quorum-desktop, not quorum-mobile.** It is tracked as a separate desktop config-refetch bug: see `quorum-desktop `.agents/bugs/2026-06-13-config-not-refetched-stale-until-restart.md``.

### What the mobile work (PR #81) actually addressed

quorum-mobile PR #81 added the mobile config→user read-back bridge for `bio`/`isProfilePublic`. That fixes the **reverse** direction (a change made on desktop/another device is picked up by *mobile* on next launch) and lays the bridge for `primaryUsername`. It does **not** fix this mobile→desktop bug — that needs the desktop refetch fix.

### Superseded analysis (kept for history)

The 2026-06-12 "missing mobile bridge is THE cause" conclusion was incorrect for this direction (see above). The original "possible causes" list below was actually closer — desktop caching a stale value (the `cachedConfig` short-circuit + IndexedDB-only fetch) is the real mechanism.

### ~~Possible causes to investigate~~ (superseded — see Root cause above)

- `allowSync` is false on this account/device, so `saveConfig` never ran.
- The config-sync channel isn't delivering to the desktop instance (config not fetched/applied on that device, or a one-directional sync issue).
- Desktop reads `isProfilePublic` from a different source than the synced config, or caches a stale value.
- Timing: the toggle was changed on mobile but the desktop instance hasn't re-fetched config since.

## Impact

- User confusion: the toggle disagrees across a user's own devices.
- May share a root cause with the missing `name.q` display symptom during the QNS-usernames test (if LaMat's config simply isn't reaching desktop, both the toggle state and any config-carried profile data would be stale on desktop). Worth confirming whether config sync is flowing at all for this account.

## Repro

1. Log into the same account on mobile and desktop.
2. Toggle public profile ON on mobile, save.
3. Open User Settings on desktop → toggle shows OFF.

## Fix

- **The real fix is desktop-side** — make desktop refetch config from the server after startup (periodic, on window focus, or websocket-driven invalidation of the config query), so a cross-device change reflects without a restart. Tracked in `quorum-desktop `.agents/bugs/2026-06-13-config-not-refetched-stale-until-restart.md``.
- quorum-mobile PR #81 is related but fixes the **reverse** direction (desktop→mobile read-back) + lays the `primaryUsername` bridge; it does not fix this bug.

## Related

- Sibling bug: [`2026-06-10-primary-username-not-synced-or-published.md`](2026-06-10-primary-username-not-synced-or-published.md).
- Surfaced during the desktop QNS-usernames port (`quorum-desktop/.agents/tasks/port-from-mobile/2026-06-10-qns-username-display-design.md`).

*Last updated: 2026-06-12*
