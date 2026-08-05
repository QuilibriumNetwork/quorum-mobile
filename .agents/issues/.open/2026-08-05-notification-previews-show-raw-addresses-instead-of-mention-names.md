---
type: bug
title: "Mention notifications show the raw @<Qm…> address instead of the mentioned person's name (desktop resolves it, mobile does not)"
status: open
priority: medium
created: 2026-08-05
area: notifications / mention rendering / identity resolution
runtime_test: required
source: observed on device 2026-08-05 — a mention row in the Notifications tab read "@<QmQuCGpEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imXST1>" as its entire preview
related:
  - "issues/.open/2026-08-05-rich-in-app-notifications-plan.md"
  - "issues/.open/2026-08-04-one-identity-resolver-so-names-and-avatars-match-everywhere.md"
  - "docs/features/notification-system.md"
---

# A mention notification shows an address where a name should be

## Symptom

A mention row in the Notifications tab renders its preview as the raw wire-format
mention token:

```
Quorum Test Community Space  #Test chan…
@<QmQuCGpEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imXST1>
22h ago
```

When the message body is mostly a mention, the preview is almost entirely a
40-character hash — the row carries no usable information at all.

## Cause

`logMentionOrReply` builds the stored preview with `messagePreview(message)`
(`services/notifications/logMentionOrReply.ts:145`), which takes the raw message
text. Nothing resolves mention tokens on the way in, and nothing resolves them on
the way out either — the panel renders `preview.text` directly.

Note the contrast within the same function: the **sender's** name is handled
carefully, and deliberately falls back to nothing rather than showing a hash
(`senderDisplayName`, `:131-133`). Mentions *inside the body* got no equivalent
treatment.

The chat view does resolve them, but the logic lives inside a component
(`MENTION_REGEX` in `components/Chat/MentionableText.tsx:66`) rather than a
reusable util, so the notification path cannot call it.

## Desktop already does this correctly — parity gap

`quorum-desktop/src/components/notifications/NotificationItem.tsx` takes a
`mapSenderToUser` prop, commented *"For rendering mentions with display names"*,
tokenizes the content and renders `tokenData.type === 'mention'` as a named span
(with `spaceRoles` / `spaceChannels` for role and channel mentions too).

So this is a mobile-only defect, and desktop is the reference implementation.

## Approach — decide before building

The panel is **global across spaces**, which is what makes this less trivial than
it looks: resolving at render time needs member data for arbitrary spaces, not
just the open one. Two options:

1. **Resolve at write time**, in `logMentionOrReply`. It is already async and
   already calls `ctx.getSpaceMember` for the sender, so resolving the mentioned
   addresses is the same mechanism repeated. Stored names go stale if someone
   renames — but a notification is a point-in-time record of what arrived, so
   that is arguably correct rather than a flaw.
2. **Resolve at render time**, in the panel. Always current, but needs per-space
   member lookups from a global surface. Heavier.

**Suggested: option 1**, unless the identity-resolver work
(`2026-08-04-one-identity-resolver-so-names-and-avatars-match-everywhere.md`)
makes cross-space lookup cheap, in which case option 2 gets it for free. Check
that issue's state first — this is exactly the kind of thing it exists to fix,
and doing it twice would be waste.

Either way, **extract the token parsing out of `MentionableText` into a util** so
the chat view and the notification path share one parser. Two regexes for one
wire format is how they drift.

## Scope

1. Extract a plain-text mention resolver (`@<address>` → `@Name`, `@everyone`
   unchanged, `@roleTag` → role name) into a util both callers can use.
2. Apply it on the chosen path.
3. Handle the unresolved case deliberately: if the address does not resolve to a
   member, show a shortened address rather than the full 40-char hash — mirroring
   how `senderDisplayName` already refuses to surface a raw hash.

## Verify

- Get mentioned by someone whose profile has synced → the row shows their name.
- Get mentioned by someone unsynced → shortened address, not a 40-char hash.
- `@everyone` and a role mention both render their intended text.
- A message with several mentions resolves all of them.
- The chat view still renders mention pills exactly as before (same parser now).

*Last updated: 2026-08-05*
