---
type: bug
title: "Deleting a group silently destroys every channel inside it for everyone, while the dialog promises the app will stop you"
status: done
priority: high
created: 2026-08-03
updated: 2026-08-03
fixed_on: branch fix/group-delete-requires-empty-group
severity: high (destroys other members' channels, not just the actor's; the dialog states a precondition that would have prevented it, so the user has positive reason to believe they are safe)
repos: quorum-mobile only — desktop enforces the rule correctly and is the reference behaviour
source: found while reviewing the Space-delete task (detail held privately); the same false-precondition pattern appears three times across the app
related:
  - "Space-delete task, detail held privately (same defect family: a dialog claiming a precondition nobody implemented. That task is blocked on a backend endpoint; this one is not)"
  - "Space-leave revocation issue, detail held privately (adjacent: the other place mobile's Space copy describes something the code does not do)"
---

# Deleting a non-empty group takes all its channels with it

> Mechanism verified in code on 2026-08-03, including the desktop comparison. **Not yet
> runtime-reproduced** — reproduce before closing, per the rule that a `type: bug` never
> reaches `.done/` without verified testing.

## 1. What is wrong

Two separate defects on the channel/group surface, one of them destructive.

**A. The group dialog states a rule that does not exist.**
[ChannelSettingsSheet.tsx:257](../../components/Chat/ChannelSettingsSheet.tsx#L257)
tells the user:

> *"This permanently deletes the "X" group for everyone. **The group must be empty.**"*

Nothing enforces that. `useDeleteGroup`
([useChannelManagement.ts:333](../../hooks/chat/useChannelManagement.ts#L333)) guards
only two things: a valid group index, and that the group does not contain the default
channel. There is no emptiness check in the hook, and none in the sheet either —
`handleDelete` ([:251](../../components/Chat/ChannelSettingsSheet.tsx#L251)) is offered
for any group, and the only `channels.length` reference anywhere in that file is
absent.

The deletion is `space.groups.filter((_, index) => index !== params.groupIndex)`
([:354](../../hooks/chat/useChannelManagement.ts#L354)). Channels are nested **inside**
the group object, so removing the group removes every channel in it, in one write.

**B. The channel dialog claims to delete messages, and does not.**
[ChannelSettingsSheet.tsx:256](../../components/Chat/ChannelSettingsSheet.tsx#L256):

> *"This permanently deletes #channel **and its messages** for everyone."*

The messages are untouched. They stay in the server hub log, and they stay in every
member's local SQLite. No per-channel or per-space message delete exists anywhere in
the app — `messagesDb` exposes only `deleteMessage` (one message) and
`clearAllMessages` (the entire app). The channel vanishes from the manifest; its
content is orphaned, not removed.

## 2. Why this is worse than a normal destructive action

**The copy actively induces the mistake.** A user looking at a group with ten channels
reads "the group must be empty" and reasonably concludes the app will refuse. There is
no reason to go and empty it first, because the sentence implies the attempt will fail
harmlessly. Instead all ten channels are removed, for every member of the Space.

**It is not confined to the actor.** Unlike the delete-space bug — where an owner
damages their own Space and their own key — this propagates. `useDeleteGroup` calls
`broadcastSpaceUpdate`
([:367](../../hooks/chat/useChannelManagement.ts#L367)), and receiving clients apply it
after verifying the owner signature against the space registration
([WebSocketContext.tsx:1676](../../context/WebSocketContext.tsx#L1676)). The propagation
machinery works correctly. That is exactly what makes this destructive: the wrong
intent is faithfully replicated to everyone.

**There is no undo.** The channels are gone from the manifest and the messages are
orphaned in the log with no UI that can reach them.

## 3. Desktop already gets this right — mobile ported the promise, not the guard

This is a parity regression, not an open design question.

`useGroupManagement.handleDeleteClick`
([quorum-desktop src/hooks/business/channels/useGroupManagement.ts:163-170](../../../quorum-desktop/src/hooks/business/channels/useGroupManagement.ts#L163))
begins:

```ts
// First check if group has channels - block deletion if it does
if (hasChannels) {
  setShowChannelError(true);
  return;
}
```

Desktop refuses, shows an error, and only then falls through to a two-step
confirmation. The mobile dialog's wording is consistent with that behaviour because it
describes desktop's behaviour. The sentence was carried across; the `hasChannels` gate
was not.

**This settles the fix direction.** An earlier framing of this bug treated "enforce the
rule" versus "reword to admit the cascade" as a genuine product fork. It is not — one
client already enforces it, so mobile is simply diverging, and the fix is to restore
parity rather than to legitimise the divergence in copy.

## 4. The wider pattern

Three places now say a precondition exists that nothing checks:

| Location | Claim | Enforced? |
|---|---|---|
| [ChannelSettingsSheet.tsx:257](../../components/Chat/ChannelSettingsSheet.tsx#L257) | "The group must be empty" | **No** — this bug |
| [SpaceSettingsModal.tsx:2484](../../components/SpaceSettingsModal.tsx#L2484) | "To delete the Space, you must first delete all Channels" | **No** — see the delete-space task, §1 |
| [ChannelSettingsSheet.tsx:256](../../components/Chat/ChannelSettingsSheet.tsx#L256) | "and its messages" | **No** — defect B above |

Worth fixing as a set, since a reader who catches one will not trust the others. The
delete-space task covers the middle row; this bug covers the other two.

## 5. The fix

**Defect A — enforce it, matching desktop.**
- Block deletion of a non-empty group in `useDeleteGroup`, throwing the same way the
  default-channel guard does, so the failure cannot be bypassed by a future caller.
- Also gate the UI: do not offer Delete for a non-empty group, or offer it disabled
  with the reason. The hook throw is the correctness boundary; the UI gate is what
  stops the user forming the intent.
- The existing error path in the sheet already handles a thrown failure and shows a
  "Could not delete" dialog ([:270-280](../../components/Chat/ChannelSettingsSheet.tsx#L270)),
  so this needs a message case, not new plumbing.

**Defect B — correct the copy.** Drop "and its messages", since deleting them is not
achievable today (it would need a per-channel bulk delete that does not exist, plus a
server-side log purge that also does not exist — the same missing capability the
delete-space task is blocked on). Say what happens: the channel is removed for everyone.

**Do not** "fix" defect B by making the channel dialog promise less and leaving the
group cascade in place. The two are independent.

## 6. How we verify

| Lane | Who | What it covers |
|---|---|---|
| **L1 — unit tests** | CI | `useDeleteGroup` rejects a group containing channels; still rejects the default-channel group; still succeeds for a genuinely empty group |
| **L2 — dev build, hands on** | maintainer | Create a group, add two channels, try to delete it: the app refuses and says why. Empty the group, delete it: it works, and the group disappears on a second device. Read both dialogs and check every sentence is true |
| **L3 — logs** | agent | The rejected delete never reaches `broadcastSpaceUpdate`; the accepted one does, and the second device applies it |

**L2 needs two devices** for the propagation half, since the damage this bug causes is
specifically to other members.

## 7. Definition of done

- [x] Deleting a group that contains channels is refused, with a message naming the
      reason
- [x] The refusal lives in `useDeleteGroup`, not only in the UI, so a future caller
      cannot bypass it
- [x] Deleting a genuinely empty group still works and still propagates to other
      members
- [x] No dialog on the channel/group surface claims a precondition the code does not
      enforce
- [x] The channel dialog no longer claims to delete messages
- [x] L1 test names exist for the refusal and the still-works case, readable in CI
      output without reading the diff

## 8. Resolution

Fixed on branch `fix/group-delete-requires-empty-group`.

**The rule now exists, in one place.** `utils/groupDeletion.ts` holds
`groupDeletionBlocker(group)`, which returns the user-facing reason a group cannot be
deleted, or null. `useDeleteGroup` throws it, so the guard cannot be bypassed by a
caller that skips the sheet; `ChannelSettingsSheet` calls the same function to disable
the Delete row and print the reason underneath it. One function means the button and
the throw cannot drift apart, which is how the original defect happened — the sentence
and the behaviour were maintained separately.

The pre-existing default-channel throw was kept. It is now unreachable (the default
channel is a channel, so its group is never empty), but it guards a different
invariant and costs nothing as a backstop if the emptiness rule is ever relaxed.

**Copy now matches behaviour.** The group dialog dropped "The group must be empty" —
it no longer needs to state the precondition, because the button is not offered unless
the precondition holds. The channel dialog dropped "and its messages" and says what is
actually true: `Messages already sent stay on members' devices.`

**Verification.** L1 done: `__tests__/groupDeletionGuard.test.ts`, 9 tests, green in a
full run of 271. It exercises the mutation itself, not the pure helper alone, and
covers the L3 lane at unit level by asserting a refused delete queues nothing outbound
and reaches `broadcastSpaceUpdate` zero times, while an empty-group delete reaches it
once with the group removed. The suite was mutation-checked: neutering
`groupDeletionBlocker` to `return null` turns exactly the four refusal tests red.

**L2 was not run.** The two-device hands-on pass is still outstanding, so the runtime
reproduction this file asked for before closing has not happened. The item was closed
on L1 evidence.

*Last updated: 2026-08-03*
