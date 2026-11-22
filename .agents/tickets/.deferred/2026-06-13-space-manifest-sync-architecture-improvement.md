---
type: task
title: "Space-manifest sync: replace whole-object last-write-wins to stop concurrent-edit clobber"
status: deferred
created: 2026-06-13
priority: medium
scope: cross-repo (quorum-shared + quorum-desktop + quorum-mobile)
related-bug: .done/2026-06-13-mobile-applies-stale-space-manifests-no-staleness-guard.md
related-branch: fix/mobile-channel-sync-to-desktop
needs: lead-dev decision (design direction A/B/C)
---

# Space-manifest sync: move off whole-object last-write-wins

## Context

Space changes (name, channels, groups, roles) sync by broadcasting the **entire
`Space` object** as a signed+encrypted manifest. Conflict resolution is **wall-clock
last-write-wins**: whoever writes last wins, wholesale.

A mobile-side staleness guard (shipped on `fix/mobile-channel-sync-to-desktop`) stops
the worst case — old manifests replayed from the hub log overwriting newer local
state — but does NOT give correct concurrent-edit semantics. This task tracks the
deeper fix, which is a design decision and spans repos, so it needs the lead dev.

## The structural weakness

1. **Whole-object manifests, not deltas.** Device A renames channel X at T=100;
   device B renames channel Y at T=90. Both broadcast their whole space. The T=100
   snapshot wins entirely, so B's channel-Y rename is lost even though it never
   touched channel X. The staleness guard only decides which whole snapshot wins; it
   cannot merge.

2. **Wall-clock LWW depends on device clocks.** A device whose clock runs behind can
   have its genuinely-newer edit judged "older" and dropped. Desktop has the same
   exposure.

Masked today because edits are infrequent and usually one device at a time. Will
surface as soon as two members (or one user's two devices) edit space config close
together.

## Options (pick one — lead-dev decision)

- **A. Keep LWW + the staleness guard (status quo after the current branch).**
  Cheapest, no further work. Risk: silent loss of concurrent edits to different parts
  of a space. Acceptable only while co-editing is rare.

- **B. Field-level / per-entity merge.** Broadcast or merge at the granularity of
  individual channels/groups/roles rather than the whole space, so edits to different
  entities don't collide. Medium effort, mostly in `quorum-shared` plus both apply
  paths. Removes the most common clobber without full CRDT machinery. **Pragmatic
  middle — likely recommendation.**

- **C. Version vectors / logical clocks (or CRDT).** Correct concurrent-edit
  semantics, removes clock-skew dependence. Largest effort, cross-repo. Justified only
  if space config becomes frequently co-edited.

## Suggested next steps

1. Lead dev picks A / B / C.
2. If B or C: scope the change in `quorum-shared` first (the manifest shape / merge
   helpers live there), then update the apply paths in desktop + mobile.
3. Add a concurrent-edit test (two devices edit different channels within the same
   second; assert both edits survive).

## Pointers

- Mobile outbound: `hooks/chat/useChannelManagement.ts`
- Mobile inbound + staleness guard: `context/WebSocketContext.tsx` (`case 'space-manifest'`)
- Mobile broadcast helper: `services/space/broadcastSpaceUpdate.ts` (`JSON.stringify(space)` -> whole object)
- Desktop mutation: `quorum-desktop/src/services/SpaceService.ts` `updateSpace()` (also whole-object, no fetch-merge)
- Desktop inbound: `quorum-desktop/src/services/ConfigService.ts` (pulls current manifest from API, so no stale-replay there)

---

*Last updated: 2026-06-13*
