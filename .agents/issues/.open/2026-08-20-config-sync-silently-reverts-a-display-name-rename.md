---
type: bug
title: "Config sync silently reverts a display-name rename: config.name wins unconditionally, ignoring the last-write-wins guard beside it"
status: open
priority: high
created: 2026-08-20
updated: 2026-08-20
area: identity / auth / config sync
related:
  - "issues/.open/2026-08-19-self-rename-name-stale-outside-websocket-context.md (found in the same session; DIFFERENT root cause — that one is a cache invalidation miss, this one is a write being overwritten)"
---

# Renaming yourself on one client gets undone by the other client's synced config

## Symptom

Rename yourself on mobile. It appears to work. Later — after an app start, or
whenever the login config task runs — the old name is back, and it is the name
another client last published.

The revert is silent. No error, no conflict prompt, nothing in the UI.

## MEASURED on the Android emulator, 2026-08-20

Read straight out of the app's MMKV store (`files/mmkv/quorum-cache`, key
`auth:user`) via `adb ... run-as`, both copies identical:

```
displayName      : "GattoPardo Desktop"        <- the OLD name, set from desktop
primaryUsername  : "qtest"
profileUpdatedAt : 2026-08-20T11:33:57.871Z    <- ~20 min before the observation
isProfilePublic  : false
```

The operator had renamed themselves on mobile that morning, and the space member
list correctly showed the NEW name. So the identity maps had the new value while
`AuthContext` held the old one — which is why the Space Settings display-name
**placeholder** (`SpaceSettingsModal.tsx:1732` →
`selfNamePlaceholder` → `user.displayName`) rendered the previous name.

The `profileUpdatedAt` stamp is the tell: it is recent, so `updateProfile` DID
run. The record is not stale-because-never-written. It was written and then
overwritten.

## Root cause — READ, `context/AuthContext.tsx`

The login config task has a deliberate last-write-wins guard:

```ts
const configIsNewer =
  typeof config.timestamp === 'number' &&
  config.timestamp > (parsedUser.profileUpdatedAt ?? 0);          // :332-334
```

`bio`, `isProfilePublic` and `primaryUsername` are all correctly gated behind it.
**`displayName` and `profileImage` are not** — they sit outside the guard, in
both the in-memory update and the persisted write:

```ts
displayName: config.name || base.displayName,                      // :358  setUser
displayName: config.name || cur.displayName,                       // :372  merged
...(configIsNewer && { bio, isProfilePublic, primaryUsername }),    // :360-364, :374-381
```

So **any non-empty `config.name` wins, regardless of which value is newer.**

This is not an oversight — the comment above it says so:

> "name/profile_image keep their original truthy-fill behavior to avoid
> regressing the working display-name sync." (`:327-328`)

And the write-back at `:383` re-persists with `...cur`, so `profileUpdatedAt`
keeps its old value. The record therefore looks locally-fresh while carrying a
remotely-sourced name, which is exactly what makes this hard to spot from the
stored data alone.

## Why it is priority: high

It silently undoes a deliberate user action. The user renames themselves, sees it
work, and the change evaporates later with no signal. Under the calibration rule
in AGENTS.md this is the "silent and destructive" category rather than the
"visible and cheap" one: nothing in the UI can tell you it happened, and the only
way the operator noticed at all was a stale placeholder in an unrelated modal.

It also gets worse with more clients. Whichever client published last wins on
every subsequent login, so two clients can ping-pong a name indefinitely.

## Before fixing: understand what the exception was protecting

**Do not just move `displayName` inside `configIsNewer`.** The comment says the
truthy-fill exists to keep display-name sync working, and the likely case it
protects is a device with **no local stamp yet** — a fresh install or a
pre-stamp account, where `profileUpdatedAt` is `undefined`, `configIsNewer` is
`0 > 0` false, and a strict guard would leave the name blank forever.

The `neverStamped` variable already exists two lines below (`:344`) for exactly
this shape of problem on the privacy toggle. The fix is probably:

```ts
const nameMayWin = configIsNewer || neverStamped;
displayName: nameMayWin ? (config.name || base.displayName) : base.displayName,
```

but confirm the fresh-install path before committing to it, and apply the same
reasoning to `profileImage`, which has the identical hole.

## Reproduction

1. Publish a profile with name X from client A (desktop).
2. On mobile, rename to Y. Confirm Y renders.
3. Restart the app so the login config task runs.
4. **Expected today (FAIL):** the name is X again.

Read the stored value directly to be sure the UI is not just caching:

```bash
adb -s emulator-5554 exec-out "run-as com.quilibrium.quorummobile cat files/mmkv/quorum-cache" > qc.bin
# then locate the auth:user key and parse the JSON that follows it
```

## Not caused by the DM identity reveal ledger branch

That branch does not touch `AuthContext`, the config service, or
`UnifiedProfileEditModal`. Found while verifying it on device; pre-existing.

---
*Last updated: 2026-08-20*
