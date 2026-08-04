---
type: task
title: "Coalesce replayed update-profile during hub-log catch-up to stop display-name flicker"
status: open
priority: medium
created: 2026-06-28
scope: quorum-mobile (app-side effect-batching; NOT quorum-shared)
source: surfaced during quorum-desktop UX investigation 2026-06-28 (new-device history replay flicker)
related:
  - 2026-06-28-coalesce-replay-space-manifest-flicker.md (the harder half — space/channel flicker, split out)
  - 2026-06-13-space-manifest-sync-architecture-improvement.md (DIFFERENT problem — concurrent-edit correctness)
---

# Coalesce replayed update-profile during catch-up (stop display-name flicker)

> **This is the easy half.** The harder `space-manifest` (space/channel) flicker
> was split into its own task:
> [2026-06-28-coalesce-replay-space-manifest-flicker.md](2026-06-28-coalesce-replay-space-manifest-flicker.md).
> Do this one first — it validates the coalescing approach on a low-risk type.

## Symptom

On a new device (or any hub-log catch-up that replays history), a contact's
**display name** visibly "scrubs" through 3-4 old names until it settles on the
current one. Final state is correct — purely visible intermediate re-renders.

(The analogous **space name / channel** flicker is the sibling task
[2026-06-28-coalesce-replay-space-manifest-flicker.md](2026-06-28-coalesce-replay-space-manifest-flicker.md).)

## Root cause (verified 2026-06-28 against `context/WebSocketContext.tsx`)

Hub-log replay enqueues every historical entry individually
(`ingestEntries` → `messageQueueRef` → `processMessageQueue`) and applies them
one-by-one in `applySpaceGroupResults`. For state-convergent event types, each
event triggers an immediate storage write **and** a `queryClient.setQueryData`,
so React re-renders once per historical event.

**`update-profile`** (`applySpaceGroupResults`, ~L3562-3618): per-event
`adapter.saveSpaceMember()` + `setQueryData(queryKeys.spaces.members(spaceId))`.
A `profileTimestamp >= ts` guard exists, but it only blocks **backward** rewinds
on an already-synced device. On a **fresh** device there's no stored timestamp,
so every increasing-timestamp event passes the guard and renders → forward scrub.

The infrastructure to fix this **already exists in the same function**:
`pendingStorageUpdates` / `pendingCacheTransforms` (L3271-3290) already coalesce
**reactions and edits** into a single end-of-batch flush (L3729-3750).
`update-profile` was simply left out of that coalescing.

## The fix (`update-profile` — simple, low-risk)

Extend the existing end-of-batch coalescing to cover `update-profile`. During the
loop, instead of writing per event, stash the **latest profile per `senderId`**
(keep the one with the highest `createdDate`, honoring the existing
`profileTimestamp` guard). After the loop, write each once: one `saveSpaceMember`
+ one `setQueryData` per distinct sender. Collapses N writes/renders into 1.
Final state is provably identical — this only removes intermediate renders.

The harder `space-manifest` half is its own task:
[2026-06-28-coalesce-replay-space-manifest-flicker.md](2026-06-28-coalesce-replay-space-manifest-flicker.md).
Do this profile fix first to validate the approach on a low-risk type.

## Why app-side, NOT quorum-shared

The flicker is an **effect-batching** problem (storage writes + cache updates).
quorum-shared deliberately holds **pure decisions/shapes only** — its entire
`utils/` tree is free of `queryClient`/`setQueryData`/MMKV/IndexedDB (verified
2026-06-28; the only `window.*` uses are read-only env detection). Batching
effects is each app's job by the architecture's own consistent rule
("Storage implementation → each app"). The only shareable sliver — a pure
"latest-per-sender" grouping — is ~8 lines and too trivial to justify a shared
PR + version bump + two consumers right now. If it ever grows non-trivial it has
a natural home next to `utils/resolveDisplayName.ts`; deferring costs nothing.

## Related tasks (don't conflate)

- [2026-06-28-coalesce-replay-space-manifest-flicker.md](2026-06-28-coalesce-replay-space-manifest-flicker.md)
  — the harder half (space/channel flicker). Same class of fix, riskier apply path.
- [2026-06-13-space-manifest-sync-architecture-improvement.md](../.deferred/2026-06-13-space-manifest-sync-architecture-improvement.md)
  — a **different** problem: concurrent-edit *correctness* (whole-object LWW can
  silently drop a concurrent edit — wrong final state). This task is about replay
  *flicker* (correct final state, but visibly scrubs). Independent of it.

## Desktop counterpart

Desktop has the same root cause in its P2P sync-delta path today, but desktop is
expected to migrate to the hub-log transport. The desktop fix is therefore
**deferred** until the hub-log port lands — tracked in
`quorum-desktop/.agents/tasks/.todo/2026-06-28-coalesce-replay-state-updates-flicker.md`.
At port time, desktop writes its own batch-flush against IndexedDB/MessageDB
(mirroring this one through desktop's storage/cache). NOTE: the hub-log port
alone does NOT fix the flicker — mobile already runs the hub-log and still
scrubs; the fix must come along with the port.

*Last updated: 2026-06-28*
