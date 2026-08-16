---
type: bug
title: "Space mention notifications bake names at write time, so a .q never renders there"
status: done
priority: high
ai_generated: true
created: 2026-08-16
updated: 2026-08-16
area: "Notifications / identity resolution / desktop parity"
---

# Space mention notifications bake names at write time, so a `.q` never renders there

## Status

**Fixed in `8b6f12b`, confirmed on device by the operator 2026-08-16.**

What landed, matching the Scope section below:

- `partitionNotifications` takes a `resolveName` bound to `@/identity` in
  `useUnifiedNotifications`, applied to the author AND to in-body mention
  tokens, both scoped to the ROW's `spaceId`.
- The resolved author is exposed as `UnifiedNotification.actorName`. The
  renderer (`app/(tabs)/profile/index.tsx`) reads that instead of reaching into
  `raw.quorum.senderDisplayName`, which is what actually produced the reported
  symptom — it bypassed resolution entirely.
- The write path stores mention tokens raw and no longer takes a `self`
  identity. `SelfIdentity` could never carry a `primaryUsername`, so the viewer
  was the one person structurally guaranteed never to see their own `.q` in a
  notification about them. Removed rather than left unused, so it cannot return
  as a second naming path.
- Rows already in MMKV hold baked names, carry no tokens, and render unchanged.
  No migration, by choice.

Proven red before the fix: 10 failed / 7 passed on revert. Full suite 928
passed, tsc unchanged.

**Diagnostic note worth keeping.** The first read of this bug blamed the in-body
mention. A screenshot showed the body already rendering `@qtest.q` correctly
while the author prefix read a global display name — two different fields, two
different sources, and only the second was broken. The screenshot did in one
step what more code reading would not have: the two fields are adjacent on one
line and look like one string.

## Summary

A `.q` must render everywhere a name renders, with one exception: inside a Space
where the member has a deliberate per-space nickname, the nickname wins. That is
the product rule, and `resolveIdentity({ scope: 'space' })` already implements it
exactly — including demoting a per-space name that is merely the join echo.

Space mention/reply notification rows do not follow it. They render the author's
**global display name**, and any `@mention` inside the body likewise, however the
mentioned member's identity actually resolves.

MEASURED 2026-08-16 by the operator: a mention of themselves in a channel showed
their global display name in the notification, while every in-channel surface
showed their `.q`.

## Root cause: write-time vs render-time resolution

`services/notifications/logMentionOrReply.ts` resolves names when the entry is
**written**, on the WebSocket receive path:

- `senderDisplayName` is formatted to a string (`:243-250`)
- in-body `@<Qm…>` tokens are rewritten to names by `resolvePreviewMentions`
  (`:117-144`) and the result is stored

There is no React component above that path, so `@/identity` cannot run, so no
claim can be verified, so no `.q` can ever be produced. The file documents this
(`:16-40`) and treats it as correct — which it is, *given* write-time
resolution. The write-time choice is the actual defect.

`resolveMemberName` is used instead, and it can only take a `.q` from the row's
`primary_username`. The roster handler deliberately never writes an incoming
claim there (only to `claimed_primary_username`), so that tier is structurally
always empty on this path. Self is no better off: `WebSocketContext.tsx:467-473`
builds `SelfIdentity` as `{ address, displayName, username, profileImage }`, with
no `primaryUsername` at all.

## Desktop already does it the other way, and mobile already does for DMs

**Desktop** resolves at render, inside the tree:

- `quorum-desktop/src/components/notifications/NotificationPanel.tsx:315,350` —
  `<MemberName address={senderId ?? ''} spaceId={rowSpaceId} enrich />`
- `NotificationItem.tsx:17` types the prop as
  `displayName: React.ReactNode // an identity-resolved <MemberName>, not a caller-formatted string`
- `GlobalNotificationsModal.tsx:55` resolves in-body mentions through its own
  `useNameResolver()`

**Mobile already adopted this for DM rows** and said why
(`hooks/useUnifiedNotifications.ts:128-143`): the frozen name goes stale on
rename, so the row resolves the CURRENT name at render and the write is left in
place as a fallback. `:179` calls
`formatResolvedName(resolve(senderAddress, { global: true }))`.

So the pattern, the precedent and the primitives are all already in this repo.
Only the space-mention rows were left behind.

## The stated objection does not hold

`logMentionOrReply.ts:113-115` justifies write-time resolution: *"the panel is
global across spaces: resolving later would mean per-space roster lookups from a
surface that has no space."*

The row carries its own space. `SpaceMentionEntry` stores `spaceId` and
`senderId` (`:252-265`). Desktop passes exactly that per row. There is nothing to
look up that the row does not already know.

The companion claim — *"a stored name going stale is acceptable, and arguably
correct: a notification is a point-in-time record"* — is a defensible position
that mobile itself already rejected for DM rows, and that desktop rejects
globally. Parity says follow them.

## Scope

1. **Row author.** Resolve at render with the row's own `spaceId`, so the space
   ladder applies (nickname → `.q` → global → address). Keep the stored
   `senderDisplayName` as the fallback for rows whose sender cannot be resolved,
   exactly as the DM path keeps `lastMessageSenderName`.
2. **In-body mentions.** Stop baking names into `preview.text`; keep the raw
   `@<Qm…>` tokens and resolve them at render, as
   `MentionableText`/`GlobalNotificationsModal` do.
3. **Bound the fan-out.** Any `enrich`/`requestNames` here must use the shared
   `qnsLookupAddresses` / `MAX_QNS_LOOKUPS` cap, not a private copy.
4. **Back-compat.** Entries already in MMKV have names baked into `preview.text`
   and will keep rendering as-is; only new entries carry raw tokens. Do not
   migrate the log — a notification genuinely is historical, and rewriting
   stored rows is a worse trade than letting old ones age out.

## Verification bar

- A space mention row whose author has a verified `.q` renders the `.q`.
- The same author, in a space where they have a deliberate per-space nickname,
  renders the nickname (the `scope: 'space'` exception the product rule names).
- A per-space name that merely repeats the global name does NOT bury the `.q`
  (`resolveIdentity` already demotes it; pin it so a future refactor cannot
  regress it).
- An in-body mention of the viewer renders the viewer's `.q`.
- An impersonated claim renders no `.q`, resolved through a real
  `IdentityScopeProvider` with `verifyQnsClaim` unmocked — the same control every
  other migrated surface carries.
- Prove each fails before the fix.

## Related

- `.agents/issues/2026-08-11-mobile-identity-resolution-plan.md` — the migration
  that moved every other surface to render-time resolution and left this one.
- `.agents/issues/.open/2026-08-16-broadcast-q-claims-never-render-after-the-identity-migration.md`
  — a different gap in the same feature; a user with no public profile has no
  `.q` on ANY surface, which would also mask this one.

---

*Last updated: 2026-08-16*
