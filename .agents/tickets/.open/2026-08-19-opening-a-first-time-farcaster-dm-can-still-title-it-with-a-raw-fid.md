---
type: bug
title: "Opening a first-time Farcaster DM can still title it with a raw FID"
status: open
priority: low
ai_generated: true
created: 2026-08-19
updated: 2026-08-19
area: "Farcaster DMs / identity resolution"
---

# Opening a first-time Farcaster DM can still title it with a raw FID

## Summary

Same visible symptom as
`2026-08-19-farcaster-dm-header-and-messages-show-fids-instead-of-names.md` —
a raw `fid:9999001` where a person's name belongs — but reached by a different
route that that fix does not touch. Pre-existing, not a regression from it.

Found by two independent reviewers during the review of that fix.

## Mechanism

Tapping "Message" on a Farcaster profile navigates to the DM screen with the
person's details as route params. The conversation does not exist server-side
yet, so the screen synthesises one:

```ts
displayName: params.fcDisplayName || (params.fcUsername ? `@${params.fcUsername}` : `fid:${fcFid}`)
```

The only caller (`components/SocialFeed/ProfileActionButtons.tsx`, `openDm`)
passes `fcUsername: username ?? ''` and `fcDisplayName: displayName ?? ''`, and
both props are optional on that component. If a profile reaches it with neither
populated — a sparse cast-author object, or a deep link opened before profile
data has loaded — both fall back to `''`, and the synthesised `displayName`
becomes the literal string `fid:9999001`.

That string then renders as the conversation title. `resolveConversationTitle`
cannot save it: a non-empty `global_display_name` is trusted as-is, and
`fid:9999001` is non-empty.

## Why it is low priority

- Transient: once the conversation exists server-side, the real record replaces
  the synthetic one and the correct name appears.
- You reached this screen by tapping "Message" on that person's profile, so you
  just saw their name a moment ago.
- Requires a Farcaster profile with neither a display name nor a username, which
  is unusual — a registered fname is the normal case.

Not confirmed reachable in practice; the code path is READ, not MEASURED
against a real profile that hits it.

## Fix sketch

The honest fallback is not another id-shaped string. Options, roughly in order
of preference:

1. Drop the `fid:` fallback and let `displayName` be `undefined`, so the header
   shows its own `'Unknown'` — a placeholder that reads as a placeholder rather
   than as a name.
2. Make `ProfileActionButtons` not pass empty strings (`username || undefined`),
   so the `||` chain in the screen behaves as written.
3. Have `resolveConversationTitle` treat an `fid:`-shaped `displayName` as no
   name at all.

(1) and (2) together are the smallest change that removes the id-shaped output
at both ends.

## Test to add

There is no screen-level test for `app/(tabs)/messages/dm/[id].tsx` at all —
the existing tests drive `DMChatHeader` directly with hand-built props, so
nothing exercises the synthesis. A test that mounts the screen with only
`fcFid` set would pin this and close that gap at the same time.

---

*Last updated: 2026-08-19*
