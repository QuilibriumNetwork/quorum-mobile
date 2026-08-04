---
type: task
title: "Coalesce replayed space-manifest during hub-log catch-up to stop space/channel flicker"
status: open
priority: medium
created: 2026-06-28
scope: quorum-mobile (app-side effect-batching; NOT quorum-shared)
source: split out of 2026-06-28-coalesce-replay-state-updates-stop-flicker.md (the harder half)
related:
  - 2026-06-28-coalesce-replay-state-updates-stop-flicker.md (the easy half — update-profile)
  - 2026-06-13-space-manifest-sync-architecture-improvement.md (DIFFERENT problem — concurrent-edit correctness)
---

# Coalesce replayed space-manifest during catch-up (stop space/channel flicker)

> **This is the harder half**, split out of
> [2026-06-28-coalesce-replay-state-updates-stop-flicker.md](2026-06-28-coalesce-replay-state-updates-stop-flicker.md)
> so it can't get forgotten when the easy `update-profile` half ships. Do the
> profile task first; it validates the coalescing approach on a low-risk type.

## Symptom

On a new device (or any hub-log catch-up that replays history), a **space name**,
**channel list**, and **channel names** visibly flicker through their entire edit
history before settling on the current state. Final state is correct — only the
intermediate re-renders are the problem.

## Why this is harder than the profile fix

`update-profile` is applied in `applySpaceGroupResults` as a near-pure state merge
(`saveSpaceMember` + `setQueryData`), so coalescing it into the existing
end-of-batch flush is trivial.

`space-manifest` is **not** a pure merge. It is routed as a `control` message and
processed via `await handleIncomingMessage(originalMsg)` **one at a time**
(`applySpaceGroupResults`, ~L3318-3349). Inside `handleIncomingMessage` the
`space-manifest` case (~L1332-1485) performs:

- owner signature verification
- decryption with the space config key
- `spaceTag` validation/sanitization
- channel-thread reconciliation
- `saveSpace` + `setQueryData(queryKeys.spaces.detail)` + `setQueryData(spaces.all)`
  + `invalidateQueries(channels.bySpace)` + `invalidateQueries(spaces.all)`

A staleness guard exists (`manifest.timestamp < existingSpace.modifiedDate` → skip),
but on a fresh device with no stored `modifiedDate` it passes for every
increasing-timestamp manifest, so each one applies and re-renders → forward scrub.

## Approach (keep side effects intact)

Do **not** try to fold `space-manifest` into the reaction/edit `pendingCacheTransforms`
flush — those side effects (verify/decrypt/thread-reconcile) must still run.

Instead, **pre-scan the batch and apply only the latest manifest per space**:
before the control-message loop, group the batch's `space-manifest` entries by
`spaceId` and keep only the one with the highest `manifest.timestamp` per space.
Process that single latest manifest through `handleIncomingMessage`; skip the
older ones entirely (they are strictly superseded — same final state, minus the
intermediate renders and minus the redundant verify/decrypt work).

This requires being able to read each entry's `spaceId` + `manifest.timestamp`
without fully processing it. Verify where in the pipeline that metadata is cheaply
available (control_payload vs. needing decryption first). If timestamp is only
available post-decrypt, the pre-scan still works but decrypts each manifest once
to read the timestamp — acceptable, since it still collapses N renders to 1.

## Coordinate with the concurrent-edit task

[2026-06-13-space-manifest-sync-architecture-improvement.md](../.deferred/2026-06-13-space-manifest-sync-architecture-improvement.md)
may change manifest granularity (option B: per-entity/field-level merge instead of
whole-object). If that lands first, "latest manifest per space" may become "merge
of latest per entity". Check that task's A/B/C resolution before implementing, so
this fix is consistent with the conflict-resolution model. The two are independent
in principle (correctness vs. flicker) but both touch the same apply path.

## Desktop counterpart

Deferred until the hub-log transport lands on desktop:
`quorum-desktop/.agents/tasks/.todo/2026-06-28-coalesce-replay-space-manifest-flicker.md`.

## Why app-side, NOT quorum-shared

Same reasoning as the profile task: effect-batching (storage + cache writes) is
app-owned; quorum-shared holds pure decisions/shapes only (verified 2026-06-28).
The only conceivably-shareable sliver is a pure "latest manifest per space"
selector, which is trivial and not worth cross-repo machinery now.

*Last updated: 2026-06-28*
