---
type: doc
title: Quorum Ecosystem Architecture
status: done
created: 2026-01-09T00:00:00.000Z
updated: 2026-08-19T00:00:00.000Z
---

# Quorum Ecosystem Architecture

> **This document is maintained in the `quorum-desktop` repository**, at
> `.agents/docs/quorum-shared-architecture.md`. Read it there.
>
> It used to be duplicated here, and the copies drifted. This one sat two months
> stale and described invite-domain behaviour that had already changed: it still
> called `getInviteBaseDomain` environment-aware after shared #84 made every
> generated link carry the production host. Nothing flagged the contradiction,
> because both copies read as authoritative.
>
> **Do not restore a copy.** Both clients consume the same
> `@quilibrium/quorum-shared` package, so there is one architecture to describe,
> not two. Edit the desktop copy.

## Mobile-specific notes

The few things true of this repo that the shared architecture doc does not
cover, kept here because they are about *this* client rather than the ecosystem:

- **Mobile consumes `@quilibrium/quorum-shared` as a pinned npm version**, not as
  a local path — see the exact pin in `package.json`. Desktop uses
  `link:../quorum-shared`, so a change to shared reaches desktop as soon as
  shared is rebuilt, and reaches mobile only after a publish and a version bump.
  Full workflow: [local-shared-dev-workflow.md](local-shared-dev-workflow.md).
- **Mobile does not import shared's invite-domain helpers at all.** It has its
  own generator in `services/space/inviteService.ts`, already hardcoded to the
  production host, plus its own accept-list. Converging the two is tracked in
  the `quorum-shared-migration` issue folder.

---

*Last updated: 2026-08-19*
