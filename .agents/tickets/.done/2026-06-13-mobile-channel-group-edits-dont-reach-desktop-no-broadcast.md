---
type: bug
title: "Mobile channel/group edits (rename, delete, add, reorder, move) don't reach desktop — mutations never broadcast"
status: done
created: 2026-06-13
severity: high
repo: quorum-mobile
root-cause: "hooks/chat/useChannelManagement.ts persisted every mutation locally (saveSpace + MMKV) and stopped there. Unlike useSpaceSettings (space rename) and useRoleManagement (roles), it never called broadcastSpaceUpdate / enqueueOutbound, so the updated manifest was never sent to other members. Channel/group state diverged per-device whenever mobile initiated the change."
fix: "Add the established broadcast pattern (enqueueOutbound -> broadcastSpaceUpdate) to all 9 channel/group mutations, matching useSpaceSettings / useRoleManagement. Also re-removed the dead usePinChannel hook (accidentally re-added in an earlier merge)."
related-branch: fix/mobile-channel-sync-to-desktop
related-task: 2026-05-29-channel-reorder-mutations-should-broadcast.md
related-bug: 2026-06-13-mobile-applies-stale-space-manifests-no-staleness-guard.md
supersedes-pr: 73
fixed-in: "PR #80 (squash 98c9cd6) on master, 2026-06-13"
---

# Mobile channel/group edits don't reach desktop (no broadcast)

> **Status: fix in progress on `fix/mobile-channel-sync-to-desktop`.** This is the
> OUTBOUND half of mobile<->desktop space sync. The INBOUND half (Android timestamp
> overflow) was PR #79; the stale-manifest clobber is a sibling bug fixed on the same
> branch. Originally tracked as task `2026-05-29-channel-reorder-mutations-should-broadcast.md`
> and the abandoned PR #73 (which was conflicted, 16 commits behind, and polluted with
> 123 build-artifact files + an unrelated OTA feature). Redone clean here.

## Symptom

Edit a channel or group ON mobile (rename, delete, add, move between groups,
reorder) -> the change does NOT appear on desktop, even after refresh. The reverse
(desktop -> mobile) worked, which made the sync look one-directional.

## Root cause

`hooks/chat/useChannelManagement.ts` was written without the broadcast pattern. Every
mutation ended at:

```ts
saveSpace(updatedSpace);
const adapter = getMMKVAdapter();
await adapter.saveSpace(updatedSpace);   // <-- stops here. Local only.
```

No `broadcastSpaceUpdate`, no `enqueueOutbound`. Compare `hooks/chat/useSpaceSettings.ts`
(space rename) and `hooks/chat/useRoleManagement.ts` (roles), which broadcast on every
mutation — which is exactly why renaming a SPACE on mobile reached desktop but renaming
a CHANNEL did not.

Affected mutations (all in `useChannelManagement.ts`): `useAddChannel`,
`useUpdateChannel`, `useDeleteChannel`, `useAddGroup`, `useUpdateGroup`,
`useDeleteGroup`, `useMoveChannel`, `useReorderGroups`, `useReorderChannels`.

## Fix

After the local save in each mutation, append the established fire-and-forget pattern:

```ts
const { enqueueOutbound } = useWebSocket();
// ...after saveSpace + adapter.saveSpace:
enqueueOutbound(async () => {
  const result = await broadcastSpaceUpdate(updatedSpace);
  return result ? [result.wsEnvelope] : [];
});
```

`enqueueOutbound` wraps in try/catch, so a failed broadcast doesn't fail the mutation
(eventual consistency, matching the reference hooks). `broadcastSpaceUpdate` returns
`null` for non-owners (broadcast silently no-ops), same as role management.

Also re-removed the dead `usePinChannel` hook + its barrel export (it was removed by
PR #68 then accidentally re-added by a later grab-bag commit; zero call sites).

## Runtime verification (2026-06-13)

Renaming a channel on mobile appeared on desktop; deleting a channel synced too.
Confirmed in Metro logs: `[WS-send ...] inbox=... hub=... keys=...` fired on each
channel mutation (the broadcast going on the wire).

> Note: a follow-on clobber surfaced during testing (old replayed manifests reverting
> the change) — that's the sibling bug
> `2026-06-13-mobile-applies-stale-space-manifests-no-staleness-guard.md`, fixed on the
> same branch. With both fixes, channel/space rename + delete sync correctly both ways.
> Channel ICONS are a separate known issue (vocabulary mismatch, not sync) — see
> `.solved/2026-06-09-iconsymbol-throws-on-tabler-icon-names-from-desktop.md` and
> `2026-06-13-channel-icons-dont-render-cross-platform-vocabulary-mismatch.md`.

## Verification checklist

- [x] Rename channel on mobile -> appears on desktop
- [x] Delete channel on mobile -> disappears on desktop
- [ ] Add channel / add-update-delete group on mobile -> reflected on desktop
- [ ] Reorder / cross-group move on mobile -> reflected on desktop
- [ ] Non-owner mobile mutation -> local save ok, broadcast silently no-ops (no crash)
- [x] `usePinChannel` removed cleanly — lint + type-check pass

## Related

- Branch: `fix/mobile-channel-sync-to-desktop`
- Task: [2026-05-29-channel-reorder-mutations-should-broadcast.md](2026-05-29-channel-reorder-mutations-should-broadcast.md)
- Sibling bug (clobber): [2026-06-13-mobile-applies-stale-space-manifests-no-staleness-guard.md](2026-06-13-mobile-applies-stale-space-manifests-no-staleness-guard.md)
- Inbound fix (Android overflow): [.solved/2026-06-12-space-manifest-changes-not-syncing-to-mobile-silent-failure.md](2026-06-12-space-manifest-changes-not-syncing-to-mobile-silent-failure.md)
- Abandoned PR: #73

---

*Last updated: 2026-06-13*
