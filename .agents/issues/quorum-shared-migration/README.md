---
type: task
title: "Quorum Shared Migration — Mobile-side tracker"
status: in-progress
created: 2026-05-29
audience: future sessions picking up mobile-side adoption work
---

# Quorum Shared Migration — Mobile-side tracker

> **🔴 New session? Read these first, in order:**
> 1. **This file** — what's queued on mobile, what's done, what's the convention here.
> 2. **`../quorum-desktop\.agents\tasks\quorum-shared-migration\2026-05-28-cross-repo-workflow.md`** — the cross-repo workflow rules (mobile-testing constraint, additive-vs-breaking, "follow mobile patterns", proactive mobile task drop). The desktop side owns the canonical workflow doc; don't duplicate it here.
> 3. The specific task file you're working on (one row from the table below).

> **What this folder is.** Mobile's receiving end of the `@quilibrium/quorum-shared` migration that's primarily driven from `quorum-desktop`. Each file in this folder is a proactive task drop from a desktop session where a shared+desktop migration shipped but the mobile-side adoption needs a separate session (usually because it requires Expo runtime testing — see the workflow's mobile-testing rule).

> **What this folder is NOT.** Not the master tracker for the whole migration — that's [`quorum-desktop/.agents/tasks/quorum-shared-migration/README.md`](../../../../quorum-desktop/.agents/issues/quorum-shared-migration/README.md). Not a place for new architecture docs or audits — those live desktop-side too.

## How mobile fits in the migration

- **Desktop and shared are self-merged.** They ship promptly.
- **Mobile PRs go to the lead dev** for review and merge. They can sit for weeks.
- **Mobile is the receiving end** most of the time: a shared+desktop pair ships, and mobile catches up later by bumping the shared dep and adapting consumers.
- **When mobile already has a working pattern**, the migration follows it (don't disrupt the lead's territory — see the workflow's "follow mobile patterns" rule).
- **We don't run the mobile app in normal sessions.** Tasks marked `runtime-test: required` wait for a dedicated mobile-test session; tasks that are statically verifiable can be opened as PRs directly.

## Status table

> **⚠️ This table was stale (listed only 1 of 8 tasks). For the full, verified triage of all 8
> tasks — what's ship-now, what's blocked on a shared publish, and what's superseded — read
> [`STATUS.md`](STATUS.md) (the authoritative status snapshot, last triaged 2026-06-14).** The
> one-row table below is kept only as a historical pointer; trust the snapshot.

Legend: 📋 open · 🔵 in progress · ⏸️ blocked · ✅ done

| Drop date | Task | What it covers | Triggered by (desktop PR) | Runtime test? | Status |
|---|---|---|---|---|---|
| 2026-05-28 | [`2026-05-28-adopt-shared-validators.md`](.done/2026-05-28-adopt-shared-validators.md) | Drop mobile's local `validateSpaceName` + inline length constants in `SpaceModal.tsx` and `SpaceSettingsModal.tsx`; consume shared validators via a thin English-string translator. Adds XSS check on space name (defense-in-depth). | [quorum-desktop#162](https://github.com/QuilibriumNetwork/quorum-desktop/pull/162) (validation hooks migration) | ✅ required | 📋 open — Bucket 1 (ship-now), see snapshot |

## Conventions for this folder

Mirror the desktop convention, with mobile-specific tweaks:

1. **One file per adoption task.** Date-prefixed: `YYYY-MM-DD-<thing>.md`. The desktop session that drops the task names it.
2. **Frontmatter must include** `type: task`, `status: open|in-progress|done`, `complexity`, `created`, `runtime-test: required|not-required`, and `related_prs` (the shared + desktop PRs that triggered this).
3. **Body must include** what shipped on shared+desktop, concrete mobile file list (grep-verified at drop time), shape of the mobile change with code samples, static-analysis verification gates, runtime test scenarios (if required), and a pre-filled PR description.
4. **When a mobile PR opens**, fill the PR URL into the task file and the desktop-side mirror tracker. Move the task to `.done/` (create the subfolder if missing) once the PR is merged by the lead.
5. **Don't author new workflow / design docs here.** Anything strategic goes desktop-side; this folder is for executable adoption work only.

## Picking up a task

For each task in the table:

1. Open the task file. Read frontmatter and the "Concrete mobile file list" section.
2. **Re-verify the grep.** Mobile may have moved since the task was dropped — confirm the listed files still contain the listed symbols.
3. **Re-verify the shared version.** Open `package.json` and check what shared version is currently pinned; the task assumes a specific version is available.
4. If `runtime-test: not-required`, you can ship the PR in this session.
5. If `runtime-test: required`, you need an Expo dev build available (or the work pauses).
6. Follow the steps in the task file's "Shape of the mobile change" section.
7. Run all static-analysis gates. If `runtime-test: required`, run the listed scenarios.
8. Open the PR using the pre-filled description from the task file.
9. **Update desktop-side bookkeeping** at [`mobile-tasks-pending.md`](../../../../quorum-desktop/.agents/issues/quorum-shared-migration/mobile-tasks-pending.md) — change status, add PR link.
10. Move the task file to `.done/` after merge.

## If a task can't be done as-written

If you discover during execution that the task is wrong (mobile has changed, the shared version isn't actually published, the assumed file paths no longer exist), DON'T silently rewrite the task. Add a note at the top of the task file explaining what changed, update the status to `blocked` or `needs-redrop`, and update the desktop-side tracker. The next desktop session can re-drop with current info.

## Open follow-ups (not yet dropped as tasks)

When the desktop side ships a shared+desktop migration that would benefit mobile but hasn't been formalized as a mobile task, list it here as a placeholder. Move to a real task file when ready.

- *(none yet)*

---

*Created 2026-05-29 — first mobile-side tracker for the quorum-shared migration. Mirrors the structure of the desktop-side [`README.md`](../../../../quorum-desktop/.agents/issues/quorum-shared-migration/README.md) but scoped to mobile's role as the receiving end.*
