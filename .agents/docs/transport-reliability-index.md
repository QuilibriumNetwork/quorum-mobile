---
type: doc
title: "Transport & DM reliability — cross-repo index (POINTER — canonical file lives in quorum-desktop)"
status: pointer — do not add content here; edit the canonical file
created: 2026-07-28
updated: 2026-07-28
area: WebSocket transport / DM Double Ratchet / spaces hub-log / receipts
---

# Transport & DM reliability — cross-repo index (pointer)

The July 2026 transport work spans this repo, `quorum-desktop`, `quorum-shared` and
two upstream causes. **One index covers all of it.** It lives in the desktop repo
because that is where the DM ratchet investigation and the debug tooling live:

```
quorum-desktop/.agents/tasks/transport/index.md
```

On this machine: `<checkout root>\quorum-desktop\.agents\tasks\transport\index.md`.
The repos are siblings, so from this repo `../quorum-desktop/.agents/tasks/transport/index.md`
also resolves.

It indexes every bug, task, doc, tool, PR and the upstream GitHub issue, with a
read-first ladder and a "traps / stale statuses" section. **Start there, not here.**
This file carries no content of its own — edit the canonical file.

## The two entry points it sends you to

| for | read |
|---|---|
| transport (send/receive, spaces, hub-log) | `quorum-mobile/.agents/tasks/2026-07-24-transport-reliability-START-HERE.md` — in this repo |
| DM Double Ratchet / decrypt failures | `quorum-desktop/.agents/tasks/transport/2026-07-26-dm-desktop-to-desktop-resurfaced.md` |

## The upstream issue

[quorum-mobile#183 — DM message loss: two upstream root causes](https://github.com/QuilibriumNetwork/quorum-mobile/issues/183)
(OPEN). Item 1a is the `channel` crate skipped-key lookup bug; item 2 is the node
write path silently dropping a slice of inbox writes. Both are outside the app repos.

---
*Last updated: 2026-07-28*
