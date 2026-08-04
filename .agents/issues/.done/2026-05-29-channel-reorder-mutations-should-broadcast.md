---
type: task
title: "Channel reorder mutations should broadcast (not local-only)"
status: done
created: 2026-05-29
updated: 2026-06-09
triggered-by:
  desktop-task: quorum-desktop/.agents/tasks/2026-01-07-channel-ordering-feature.md
  github-issue: QuilibriumNetwork/quorum-mobile#66
  sibling-issue: QuilibriumNetwork/quorum-mobile#65
runtime-test: outbound-verified-inbound-blocked
priority: medium
branch: fix/channel-reorder-broadcast
---

## Runtime verification status (2026-06-09)

**Outbound: verified.** Channel/group mutations on mobile broadcast successfully and appear on desktop.

**Inbound: NOT verified.** Mobile cannot receive desktop's space-manifest updates because of underlying network/sync issues (DMs are also broken desktop-side; only cross-user channel messages sync). This is pre-existing, predates this branch, and is outside the channel-reorder scope.

**Important regression risk added by this PR:** Before this PR, mobile mutations stayed local. Now they broadcast. While inbound is broken, mobile's local space state can be stale, so a mobile mutation broadcasts a stale-state-plus-new-change manifest that clobbers desktop's not-yet-synced channels. The channel becomes invisible from the UI (messages aren't deleted but the channel keypair is lost on desktop). See PR description for warning text.

**Possible mitigations (separate PR):**
1. Fetch latest manifest from server before broadcasting (defends against stale-state clobber)
2. Wait for inbound sync issues to be fixed network-side before merging this

Diagnostic session findings (added/removed `console.log` instrumentation to `context/WebSocketContext.tsx`):
- Mobile WebSocket connects, subscribes to 6 space inboxes correctly
- Mobile receives hundreds of encrypted frames AND `log-since-result` catch-up frames
- However, NONE of those frames produce a visible message on mobile UI — decrypt/process pipeline silently consumes them
- All debug instrumentation reverted before commit

# Channel reorder mutations should broadcast (not local-only)

> **Scope expansion (2026-06-09).** Original task scoped only the 3 reorder mutations. Code dive revealed the bug spans **all 9 space-mutating hooks** in `hooks/chat/useChannelManagement.ts` — channel-reorder is one symptom of a file-wide gap. See "Revised scope" below.

## Problem

`hooks/chat/useChannelManagement.ts` was written without the broadcast pattern entirely. Every mutation persists to `spaceStorage` + MMKV and stops there — no `broadcastSpaceUpdate`, no `enqueueOutbound`. Compare to `hooks/chat/useRoleManagement.ts` and `hooks/chat/useSpaceSettings.ts`, where every mutation broadcasts.

Affected mutations (all in `hooks/chat/useChannelManagement.ts`):

| Mutation | Line | Notes |
|---|---|---|
| `useAddChannel` | [L49](../../hooks/chat/useChannelManagement.ts#L49) | Creates new channel, persists locally only |
| `useUpdateChannel` | [L140](../../hooks/chat/useChannelManagement.ts#L140) | Edits channel metadata |
| `useDeleteChannel` | [L203](../../hooks/chat/useChannelManagement.ts#L203) | Removes channel |
| `useAddGroup` | [L304](../../hooks/chat/useChannelManagement.ts#L304) | Creates group |
| `useUpdateGroup` | [L400](../../hooks/chat/useChannelManagement.ts#L400) | Edits group metadata |
| `useDeleteGroup` | [L349](../../hooks/chat/useChannelManagement.ts#L349) | Removes group |
| `useMoveChannel` | [L457](../../hooks/chat/useChannelManagement.ts#L457) | Same-group reorder + cross-group move |
| `useReorderGroups` | [L533](../../hooks/chat/useChannelManagement.ts#L533) | Group order permutation (exported but not yet UI-wired) |
| `useReorderChannels` | [L587](../../hooks/chat/useChannelManagement.ts#L587) | Channel order within a group |

Each ends with:

```ts
saveSpace(updatedSpace);
const adapter = getMMKVAdapter();
await adapter.saveSpace(updatedSpace);
```

No `broadcastSpaceUpdate` or `enqueueOutbound` call.

## Consequence

- Mobile mutations (add/edit/delete/move/reorder of channels and groups) → stay on the originating device only.
- Desktop mutations → mobile picks them up fine (desktop's `updateSpace` always broadcasts via the manifest pipeline).

Channel/group state diverges per-device whenever mobile initiates the change.

## Why it matters now

Desktop is shipping channel reordering with drag-and-drop — see [quorum-desktop task](../../quorum-desktop/.agents/tasks/2026-01-07-channel-ordering-feature.md). Desktop broadcasts correctly on **all** channel/group mutations (verified in `quorum-desktop/src/hooks/business/channels/useChannelManagement.ts` and `useGroupManagement.ts` — they all call `updateSpace(...)` which broadcasts). The mobile gap means the cross-platform sync story is asymmetric for the entire channel-management surface, not just reordering.

Sibling pattern to [#65](https://github.com/QuilibriumNetwork/quorum-mobile/issues/65) (notification prefs): mobile mutates local state directly when a synced manifest path already exists and is used by other mutations.

## Reference pattern (corrected 2026-06-09)

Original task recommended `await broadcastSpaceUpdate(updatedSpace)` with atomic rollback. **That doesn't match any working reference.** The real pattern across `useUpdateSpace`, `useUpdateRole`, `useAddRole`, `useDeleteRole`, `useAssignRole`, `useRemoveFromRole`, `useToggleRolePermission` is fire-and-forget via the websocket outbound queue:

```ts
import { useWebSocket } from '@/context/WebSocketContext';
import { broadcastSpaceUpdate } from '@/services/space/broadcastSpaceUpdate';

// inside the hook:
const { enqueueOutbound } = useWebSocket();

// inside mutationFn, AFTER saveSpace + adapter.saveSpace:
enqueueOutbound(async () => {
  const result = await broadcastSpaceUpdate(updatedSpace);
  return result ? [result.wsEnvelope] : [];
});
```

`enqueueOutbound` wraps in try/catch (see `context/WebSocketContext.tsx:3679-3692`) so a failed broadcast doesn't fail the mutation. **No rollback is implemented anywhere in the codebase** — the established contract is "save locally, queue the broadcast, accept eventual consistency".

## Revised scope

### Step 1 — Re-remove `usePinChannel`

While reading the file, found that `usePinChannel` (removed by PR #68 / commit `65308e0` on 2026-05-30) was accidentally re-added by Cassandra's grab-bag commit `ccd69e6` ("fix video saving, support 12 word mnemonic imports", 2026-06-02). Re-confirmed zero call sites today. Revert the re-addition: ~54 lines in `useChannelManagement.ts` (the `PinChannelParams` interface + the hook), plus the barrel export line in `hooks/chat/index.ts`.

Commit: `chore(channels): re-remove usePinChannel after accidental re-add`

### Step 2 — Wire broadcast into all 9 mutations

Apply the reference pattern above to every mutation listed in the table.

For each hook:
1. Add `const { enqueueOutbound } = useWebSocket();` near the top of the hook body
2. After `await adapter.saveSpace(updatedSpace);`, append the `enqueueOutbound(...)` block
3. Imports at file top: `useWebSocket` from `@/context/WebSocketContext`, `broadcastSpaceUpdate` from `@/services/space/broadcastSpaceUpdate`

Also update the JSDoc header comment to document the broadcast behavior, matching `useRoleManagement.ts:11-14`.

Commit: `fix(channels): broadcast space updates from channel/group mutations`

## Risks (corrected 2026-06-09)

- ~~**Broadcast cost / debouncing.**~~ Moot — broadcasts go through the websocket queue, not synchronous HTTP. Successive taps queue naturally.
- ~~**Atomic rollback on broadcast failure.**~~ Moot — `enqueueOutbound` swallows errors, established contract is eventual consistency. Matching reference hooks.
- **Owner-only.** `broadcastSpaceUpdate` returns `null` (not throw) when the owner key is missing on this device. Non-owners' broadcasts silent no-op, same as role-management. UI doesn't gate reorder controls by `isOwner` today — verify whether this should change separately (out of scope for this PR).

## Verification

- [ ] Add channel on mobile → appears on desktop within sync interval
- [ ] Update channel name on mobile → appears on desktop
- [ ] Delete channel on mobile → disappears on desktop
- [ ] Add / update / delete group on mobile → reflected on desktop
- [ ] Reorder channel on mobile (arrow buttons in SpaceSettingsModal) → reordered on desktop
- [ ] Reorder channel on mobile A → reordered on mobile B (same account, second device)
- [ ] Cross-group move on mobile → both groups update on desktop
- [ ] Non-owner mobile user attempts a mutation → local save succeeds, broadcast silently no-ops (no crash, no error toast)
- [ ] `usePinChannel` removed cleanly — TypeScript build passes, no stale imports

## Related

- GitHub issue: [quorum-mobile#66](https://github.com/QuilibriumNetwork/quorum-mobile/issues/66)
- Sibling pattern: [quorum-mobile#65](https://github.com/QuilibriumNetwork/quorum-mobile/issues/65) (notification prefs)
- Desktop reordering task: [2026-01-07-channel-ordering-feature.md](../../quorum-desktop/.agents/tasks/2026-01-07-channel-ordering-feature.md)
- Broadcast helper: [services/space/broadcastSpaceUpdate.ts](../../services/space/broadcastSpaceUpdate.ts)
- Reference pattern: [hooks/chat/useRoleManagement.ts](../../hooks/chat/useRoleManagement.ts), [hooks/chat/useSpaceSettings.ts](../../hooks/chat/useSpaceSettings.ts)
- Pin-removal PR (re-reverted in step 1): [#68](https://github.com/QuilibriumNetwork/quorum-mobile/pull/68) / commit `65308e0`
- Accidental re-add of pin: commit `ccd69e6` (2026-06-02)

---

*Last updated: 2026-06-09*
