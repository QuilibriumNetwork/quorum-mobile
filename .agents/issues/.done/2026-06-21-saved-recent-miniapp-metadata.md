---
type: task
title: "Saved/Recent mini-apps: full metadata for apps not in discovery"
status: done
created: 2026-06-21
---

# Saved/Recent mini-apps: full metadata for apps not in discovery

**Status:** partial fix shipped in profile-screen-rework; this tracks the
remaining gap.

## What was fixed (profile-screen-rework)
Saved/Recent mini-app cards showed a letter placeholder, the domain as the name,
the domain again as the subtitle, and no Farcaster badge. Root cause: local-added
/ recent / sparse-favorite entries only carry `{domain, url}`, and
`localToMiniApp` hardcoded `requiresFarcaster: false` + `description: domain`.
(Pre-existing on master — not caused by the profile rework.)

Fix: enrich each saved/recent entry from the discovery list (`miniApps`,
top-frames) by domain (id) — backfilling real name, icon, and the Farcaster flag
— and suppress the duplicate domain subtitle. See `enrichFromDiscovery` in
`components/MiniAppsModal.tsx`.

## Remaining gap
Enrichment only works for apps present in the top-50 discovery list. A saved app
NOT in that list (e.g. `degendigger.vercel.app`) has no metadata source and still
shows the placeholder + domain.

## Proper fix (separate task)
Fetch + persist real metadata when an app is saved/opened, so it doesn't depend
on the discovery list:
- On save/open (`recordMiniappUse` / add-miniapp), fetch the app manifest
  (name, icon, capabilities incl. requiresFarcaster) and store it alongside the
  domain/url in the local stores (`getAddedMiniapps` / `getRecentMiniapps`).
- Then `localToMiniApp` reads the stored metadata directly; discovery enrichment
  becomes a fallback rather than the only source.

---
*Created: 2026-06-21*
