---
type: bug
title: "Mobile applies stale space manifests replayed from the hub log — no staleness guard clobbers newer local changes"
status: done
created: 2026-06-13
severity: high
repo: quorum-mobile
root-cause: "context/WebSocketContext.tsx 'space-manifest' handler calls saveSpace(updatedSpace) unconditionally. It uses manifest.timestamp only to verify the signature, never to decide whether to apply. The mobile hub-log transport replays historical entries (log-since-result) on every reconnect, so OLD manifests arrive routinely and overwrite newer local state."
fix: "Add a fail-open staleness guard before saveSpace: skip the manifest when incoming manifest.timestamp < stored space.modifiedDate. Mobile-only; matches the hub-log transport. Shipped together with the outbound channel/group broadcast fix on branch fix/mobile-channel-sync-to-desktop."
related-branch: fix/mobile-channel-sync-to-desktop
fixed-in: "PR #80 (squash 98c9cd6) on master, 2026-06-13"
related-bug: .solved/2026-06-12-space-manifest-changes-not-syncing-to-mobile-silent-failure.md
related-task: 2026-05-29-channel-reorder-mutations-should-broadcast.md
---

# Mobile applies stale space manifests (no staleness guard)

> **Status: fix in progress on `fix/mobile-channel-sync-to-desktop`.** This is the
> "clobber" risk that the channel-broadcast task flagged in the abstract, now
> **confirmed live in the logs** on 2026-06-13. It is a SEPARATE, pre-existing bug
> from PR #79 (which fixed the Android timestamp overflow) and from the outbound
> broadcast gap (which the same branch fixes). All three are facets of "make
> mobile<->desktop space sync actually work".

## Symptom (observed)

On a physical Android device, signed in as the space owner:

- Rename a **channel** on mobile -> appears on desktop. (Works: this is the new
  outbound broadcast.)
- Rename the **space** on mobile -> appears on desktop briefly, then on mobile the
  name **snaps back to the old value**. Sometimes a change "works once, then stops
  working" on subsequent attempts.

The "works once then reverts" pattern is the tell: it is not a send failure, it is
an inbound overwrite arriving slightly later.

## Confirmed root cause (no staleness guard on inbound apply)

`context/WebSocketContext.tsx`, `case 'space-manifest'` (~line 1357-1361 before the
fix):

```ts
const updatedSpace = JSON.parse(decryptedText) as Space;
// Save updated space
saveSpace(updatedSpace);   // <-- UNCONDITIONAL. No timestamp comparison.
```

`manifest.timestamp` is read only to build the bytes that the Ed448 signature is
verified against (line ~1305). It is **never** compared against the currently
stored space. So any correctly-signed manifest is applied, including an **older**
one.

### Why old manifests arrive at all (the mobile-specific trigger)

Mobile does NOT use desktop's P2P sync. It uses a **server-side per-hub log**
(`listen-hub` + `log-since`). On every reconnect the hub **replays historical log
entries**. The logs show this clearly and repeatedly:

```
[WS-in ...] log-since-result hub=Qm... entries=200 hasMore=true
...
[space-manifest] received for space=Qma7EGH7RdfE
[space-manifest] applied + saved for space=Qma7EGH7RdfE (name="Quorum Test 2", channels=5)
```

`name="Quorum Test 2"` (the OLD name) is applied over and over from the replayed
backlog, overwriting the newer rename that the user just made on the device.

### Why desktop does NOT have this bug

Desktop's inbound path (`src/services/ConfigService.ts` ~line 130-180) **pulls the
current manifest from the API** (`getSpaceManifest`) and saves that. Its inbound
channel cannot deliver a *stale* manifest by construction, so it needs no guard.
Mobile's hub-log replay *can* and *does*. This is therefore a mobile-only fix; no
change is needed in desktop or quorum-shared for the immediate symptom.

## The fix applied on this branch (surgical, fail-open)

Before `saveSpace`, compare timestamps and skip if the incoming manifest is older:

```ts
const existingSpace = getSpace(spaceId);
const incomingTs = manifest.timestamp;
const existingTs = existingSpace?.modifiedDate;
if (
  existingSpace &&
  typeof existingTs === 'number' &&
  typeof incomingTs === 'number' &&
  incomingTs < existingTs
) {
  logger.debug(`[space-manifest] skipped: stale manifest ...`);
  break;
}
saveSpace(updatedSpace);
```

**Fail-open by design:** applies when there is no stored space yet, when the stored
space has no `modifiedDate`, or on an exact-timestamp tie. It only ever blocks a
strictly-older manifest, so it can never drop a first-seen or legitimately-newer
update.

Compares the signed `manifest.timestamp` (broadcast-time `Date.now()` on the
sender) against the stored space's `modifiedDate` (the sender's `Date.now()` when it
last wrote the space). These are set at effectively the same instant on the sender.

## What this fix does NOT solve (-> architecture, lead dev decision)

The guard stops *old-data clobber*. It does **not** give correct concurrent-edit
semantics, because of two deeper design properties:

1. **Whole-object manifests, not deltas.** A manifest carries the entire `Space`.
   With the guard, if device A edits channel X at T=100 and device B edits channel Y
   at T=90, B's whole manifest is discarded as "older" even though it touched a
   different channel. B's channel-Y edit is lost. True fix = per-field merge /
   CRDT / version vectors. Cross-repo (shared + desktop + mobile).

2. **Wall-clock LWW depends on device clocks.** A device whose clock is behind can
   have its genuinely-newer edit judged "older" and dropped. Desktop has the same
   exposure. Proper fix = logical clocks.

Both are architectural and span repos. See the follow-up task:
`.agents/issues/.deferred/2026-06-13-space-manifest-sync-architecture-improvement.md`.

## Verification

- [ ] Reload app, rename space on mobile -> name STICKS on mobile (no snap-back).
- [ ] Logs show `[space-manifest] skipped: stale manifest ...` rejecting replayed old manifests.
- [ ] Logs show the NEW name as the last `[space-manifest] applied + saved`.
- [ ] Channel rename still reaches desktop (outbound fix unaffected).
- [ ] A genuinely newer desktop change still reaches mobile (guard not over-blocking).

## Related

- Outbound half + this guard: branch `fix/mobile-channel-sync-to-desktop`
- Prior inbound fix (Android overflow): [.solved/2026-06-12-space-manifest-changes-not-syncing-to-mobile-silent-failure.md](2026-06-12-space-manifest-changes-not-syncing-to-mobile-silent-failure.md)
- Outbound task: [2026-05-29-channel-reorder-mutations-should-broadcast.md](2026-05-29-channel-reorder-mutations-should-broadcast.md)
- Architecture follow-up task: [2026-06-13-space-manifest-sync-architecture-improvement.md](../.deferred/2026-06-13-space-manifest-sync-architecture-improvement.md)

---

*Last updated: 2026-06-13*
