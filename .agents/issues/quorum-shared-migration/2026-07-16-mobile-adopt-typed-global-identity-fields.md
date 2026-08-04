---
type: task
title: "Mobile: adopt typed global-identity UpdateProfileMessage fields (retire casts)"
status: in-progress
complexity: low
created: 2026-07-16
---

# Mobile: adopt typed global-identity fields (retire the two-slot casts)

## What & why

The two-slot identity model added a GLOBAL slot to `update-profile` messages
(`globalDisplayName` / `globalUserIcon` / `globalBio`), stored separately from
the per-space OVERRIDE fields. It shipped in both apps 2026-07-16 on branch
`follow-global-profile`, but both apps carried the new wire fields **untyped via
casts** because they weren't yet on the shared `UpdateProfileMessage` type.

quorum-shared PR #57 (merged to `master` 2026-07-16) now adds those three
fields to `UpdateProfileMessage` (optional, additive — old clients unaffected,
`canonicalize` unchanged). Once mobile bumps to a published shared version that
includes PR #57, mobile can drop its casts and read/write the fields typed.

Desktop already did its side (branch
`feat/two-slot-identity-types-and-timestamp-guard`): retired its
`as unknown as UpdateProfileMessage` and `(x as any).global_*` casts.

## Prerequisite — CLEARED 2026-07-27

`@quilibrium/quorum-shared` is now published at `2.1.0-37` (includes PR #57),
and mobile's pin was bumped the same day. Verified
`globalDisplayName?` / `globalUserIcon?` / `globalBio?` are present on
`UpdateProfileMessage` in `node_modules/@quilibrium/quorum-shared/dist/types/message.d.ts`.
The casts below can now be retired.

## The change (once unblocked)

Retire the casts that only existed to paper over the missing shared type:

1. **Send path** — `services/space/spaceMessageService.ts` (`sendUpdateProfileMessage`,
   ~line 961): the `content as MessageContent` cast. The builder already sets
   `globalDisplayName` / `globalUserIcon` / `globalBio` (~933/951); with the
   typed fields, the object should satisfy `UpdateProfileMessage` /
   `MessageContent` without the widening cast (verify — `userIcon` is a required
   field on the wire type, so a global-only send may still need a narrow cast for
   THAT reason, same as desktop; if so, keep the minimal cast and note it).
2. **Member-row writes** — `context/WebSocketContext.tsx`, the `merged` object in
   BOTH `update-profile` handlers (~2194 JS path and the native-batch path):
   the `as SpaceMember & { profileTimestamp; globalProfileTimestamp?; ... }`
   cast. If the member-row type carries these fields, narrow or drop the cast.
3. **Fallback reads** — `hooks/useMembersWithPublicProfileFallback.ts` (~143):
   `(local as { globalProfileTimestamp?: number } | undefined)?.globalProfileTimestamp`
   and any sibling `(local as { global* })` reads. Read typed once the member
   row is typed.

Storage field names stay per-app (mobile `global_profile_image` vs desktop
`global_user_icon`) — only the WIRE names are shared. Do NOT unify storage names.

## Verification

- TS build + lint + grep-clean (statically verifiable — no runtime test needed).
- Confirm no behavior change: this is a pure type/cast cleanup, the runtime
  logic (per-slot LWW guard, presence semantics) is untouched.

## Triggered by

- quorum-shared PR #57 — added optional `globalDisplayName?` / `globalUserIcon?`
  / `globalBio?` to `UpdateProfileMessage`. Merged to `master`, **not yet
  published** (bump held for next batch).
- quorum-desktop `feat/two-slot-identity-types-and-timestamp-guard` — desktop
  retired the equivalent casts + added the per-slot timestamp guard.

*Last updated: 2026-07-27 — shared published `2.1.0-37` (carries PR #57), mobile
pin bumped same day, fields confirmed present in the installed dist. Task
unblocked.*
