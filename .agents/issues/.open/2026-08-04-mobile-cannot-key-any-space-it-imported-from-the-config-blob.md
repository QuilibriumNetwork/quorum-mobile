---
type: bug
title: "This device can key 0 of 3 Spaces it imported from the config blob"
status: open
priority: high
created: 2026-08-04
updated: 2026-08-04
severity: silent — the device works until something needs a Space key, then fails in a different place each time
area: space import / spaceStorage / encryption-state storage
repos: quorum-mobile (+ quorum-desktop as the visible victim)
---

# This device can key 0 of 3 Spaces it imported from the config blob

## §1. The finding

Measured on a real device, 2026-08-04:

```
[ConfigSync] NOT publishing — would upload 0/3 Spaces (keyed locally 0, …)
```

The phone lists three Spaces in its config and can key **none** of them.
`collectSpaceKeysForSync` (`services/config/configService.ts:507-546`) skips a
Space unless all three hold:

1. it is returned by `getAllSpaces()` (spaceStorage), **and**
2. `getSpaceKeys(spaceId)` is non-empty, **and**
3. `encryptionStateStorage.getEncryptionStates(`${spaceId}/${spaceId}`)` is non-empty

One of those is false for every Space on the device. **Which one is not yet
known** — that is the first thing to find out, and it is a one-line log away.

## §2. Why this is the root cause of a whole day

Every symptom chased on 2026-08-04 reduces to this:

| symptom | how this causes it |
|---|---|
| Desktop's entire Spaces sidebar emptied | mobile published a **zero-length** Space list; desktop applies a remote list verbatim |
| Mobile stopped syncing every setting | the refuse-to-publish guard held on 0/3 (#228) |
| Mobile's stored Space keys were erased | `saveConfig` persisted the empty rebuild over them (#229) |
| Desktop shows an **old** username everywhere except User Settings | see §3 — suspected, not confirmed |

#228 and #229 make config sync survive this. Neither explains it.

## §3. Suspected: it also freezes profile names (NOT confirmed)

Desktop shows the current name in the User Settings field (channel A, the config
blob) but an old one — `name2` of a `name1..name7` test series — everywhere else
(channel C, the Space member roster). See
`quorum-desktop/.agents/docs/features/identity-resolution-and-profile-sync.md`.

Channel C is fed by `update-profile` messages, and
`sendUpdateProfileMessage` (`services/space/spaceMessageService.ts:860-895`)
publishes through `sendGenericMessage({ spaceId, … })` — a real message **into**
the Space, which needs that Space's keys.

So the hypothesis is that mobile has been unable to broadcast any name change
into any Space since it lost the keys, and `name2` is the last one that got
through. That would make the "names don't sync" complaint the same bug, not a
separate pre-existing one.

**Status: INFERRED from reading the send path. Not measured.** Two inferences
about this subsystem were falsified by the device on 2026-08-04, so this one is
recorded as a hypothesis and nothing is to be built on it until a capture shows
whether the send is attempted and what it fails on.

## §4. How to find out which of the three conditions fails

Cheapest first, and the device is reachable over adb:

1. Log the three predicates per Space inside `collectSpaceKeysForSync` — present
   in `getAllSpaces`, key count, encryption-state count. One save then says
   exactly which one is false, and whether it is the same for all three.
2. If the Spaces are missing from `getAllSpaces()` entirely, the failure is in
   `syncSpaceFromConfig` (`services/config/spaceSyncService.ts`). Note its order:
   keys are saved at `:129-141`, but `saveSpace` and `saveEncryptionState` only
   run at `:205-215`, **after** `fetchSpace` and `getSpaceManifest`, each of
   which `return false` on failure (`:145-160`). A network failure there leaves
   keys behind with no Space row and no encryption state — exactly the shape
   that would produce this.
3. If the Spaces are present but the encryption state is missing, check the
   conversationId convention: `collectSpaceKeysForSync` looks under
   `${spaceId}/${spaceId}`, and a writer using a different key would be
   invisible to it.
4. Watch a fresh import: `syncSpacesFromConfig` walks Spaces sequentially with a
   1-second delay each (`:312-327`), so a slow or interrupted import is easy to
   catch in the act.

## §5. Do not "fix" this by widening the fallback

#229 made this survivable by carrying previously-synced keys forward from the
config blob. That is a safety net, not a cure, and it has a cost: the device
republishes key material it cannot verify it still holds, and a genuinely
corrupt Space now looks healthy to every other device.

The fix belongs in the import path, not in more fallbacks.

## §6. Related

- `.done/2026-08-04-mobile-publishes-a-narrowed-space-list-and-empties-every-desktop-sidebar.md`
  — the config-sync half, done; its §9 covers the missing self-heal.
- `quorum-desktop/.agents/issues/.open/2026-07-31-spaces-list-cross-device-sync.md`
  — the cross-device umbrella.
- `quorum-desktop/.agents/issues/.open/2025-12-09-encryption-state-evals-bloat.md`
  — the 1.79 MB blob measured here; a Space whose state is bloated can fail to
  key for a different reason, so rule it in or out early.

---

*Last updated: 2026-08-04*
