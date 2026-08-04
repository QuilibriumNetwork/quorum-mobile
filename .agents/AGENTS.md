# AGENTS.md

Guidelines for AI agents working on this project.

## Documentation Workflow

This project uses a `.agents/` folder to organize AI-generated documentation, tasks, bugs, and reports.

### Folder Structure

```
.agents/
├── INDEX.md          # Auto-generated index of all documentation
├── AGENTS.md         # This file - agent guidelines
├── docs/             # Feature documentation
│   ├── features/     # Feature-specific docs
│   └── .archive/     # Archived documentation
├── issues/           # Bugs AND tasks being worked on right now
│   ├── .open/        # Not started, or unfixed bugs nobody is on
│   ├── .secret/     # NEVER TRACKED - exploitable security detail (see below)
│   ├── .deferred/    # Consciously postponed
│   ├── .done/        # Completed tasks and fixed bugs
│   └── .archived/    # Obsolete, cancelled, invalid, won't-fix
└── reports/          # Audits, research, analyses
    ├── .done/        # Completed reports
    └── .archived/    # Outdated reports
```

### Issues: bugs and tasks together

Bugs and tasks share `.agents/issues/`. Which one an item is lives in its
`type: bug` / `type: task` frontmatter, never in its folder path. Setting `type:`
is mandatory.

The bug-vs-task call gets made when an item is created, which is when you know
least about it, and items often turn out to be the other one. Sharing a folder
makes correcting that a one-line edit instead of a file move nobody performs.

**Choosing:** is something observably wrong right now? Yes -> `bug`. It just does
not exist yet -> `task`. Type reflects origin and shape, not size: a bug that
takes a week is still a bug.

**Evolving:** when a bug turns out to need a build-out, change `type:` in place,
add the task sections, keep the Symptoms and Root Cause, keep the filename. Never
open a second file for the same item.

**Epics:** a big issue with many sub-issues gets its own named folder under
`issues/`, which behaves as a miniature issues tree with its own `.open/`,
`.done/` and `.archived/`. It sits at the root while in progress and moves into
`.done/` when the whole epic is finished.

### Security-sensitive issues: `issues/.secret/`

`issues/.secret/` is gitignored and must stay that way. It holds issue files whose
contents would help someone attack users of the shipped app.

**The test, applied when you create the file, not later:**

> Does this document describe an attack that works against code users are running
> today, or materially help someone build one?

If yes, it is created in `.secret/` from the start. This includes the mechanism,
the `file:line` pointers, the vulnerable code excerpt, and the reproduction steps.
Severity is not the test and neither is `status:` - a `done` write-up still belongs
in `.secret/` if the fix has not actually reached users, because release lag is
exactly the window an attacker wants.

If no, file it normally. Reliability bugs, data-loss bugs, crashes and
correctness defects are ordinary engineering work even when serious. A bug is not
security-sensitive just because it sounds alarming.

**Why the folder rather than a judgement call each time.** Both app repos are
public. Anything committed is permanent: deleting a file later does not remove it
from git history, and by then it has been cloned and indexed. So the safe default
has to be structural. When unsure, put it in `.secret/` - a file held back costs
nothing and can be released in one move, a file published cannot be recalled.

**Rules:**

- Never add a `.secret/` file to `INDEX.md`. The index is tracked, so a row there
  republishes the title and the path.
- Never paste `.secret/` detail into a tracked file, a commit message, a PR
  description or a GitHub issue on a public repo.
- A tracked file may reference the existence of the work in neutral language
  ("space-auth hardening, detail held privately") but must not restate the
  mechanism.
- The authoritative cross-repo tracker for this class is the private repo
  `QuilibriumNetwork/quorum-app-prod` (issue #1 for the control-message-auth
  cluster). Link there, not to `.secret/` paths.
- **Releasing a file** once its fix has shipped to users: move it out of
  `.secret/` into `.done/`, add its `INDEX.md` row, and say in the commit that the
  fix is live. That is a deliberate act, never a side effect of tidying.

### File Naming Conventions

- **General**: Use kebab-case: `feature-name.md`
- **Reports**: Include date: `security-audit_2025-01-15.md`
- **Numbered ordering**: Prefix with numbers: `01-setup.md`, `02-config.md`

### Status System

All documents use YAML frontmatter with these statuses:
- `open`: not started, or an unfixed bug nobody is on -- lives in `.open/`
- `in-progress`: Currently being implemented
- `on-hold`: Blocked or paused
- `done`: Completed
- `archived`: No longer relevant

### Creating Documents

Use the **docs-manager** skill for consistent templates:
- Bugs and tasks → `.agents/issues/`
- Documentation → `.agents/docs/features/`
- Reports/Audits → `.agents/reports/`

**Security review gate (this repo).** An issue touching authentication,
encryption, user data, network communication or permissions must be analysed by
the `security-analyst` agent (`.claude/agents/security-analyst.md`) *before*
implementation, and its findings recorded in the issue. This is a project rule,
not part of the shared docs-manager skill.

### Updating the Index

After creating, moving, or deleting files, run the index update script to regenerate INDEX.md:

```bash
python .agents/update-index.py
```

### Before Starting Work

1. Check `INDEX.md` for existing documentation
2. Review open and in-progress work in `.agents/issues/`
3. Check for related bugs in `.agents/issues/` and `.agents/issues/.done/`
4. Look for relevant reports in `.agents/reports/`

### After Completing Work

1. Update task/bug status to `done`
2. Move completed items to `.agents/issues/.done/` (never move a `type: bug`
   issue there without verified testing)
3. Run the index update script
4. Create documentation for significant changes

## DM diagnostic rig — `git debug`

DM/transport instrumentation is **not on `master`** and must never be merged
there. It lives on the local, never-pushed branch `diag/dm-frame-trace`.

```bash
git debug          # alias → .agents/scripts/git-debug.sh
```

Run it before any DM capture round. It rebases the rig onto `master`, re-applies
the `node_modules` transport patch (wiped by every `yarn install`), and prints a
BUILD CHECK proving which probes and shipped fixes are compiled in. **Never check
out the rig by SHA** — it rebases, so SHAs in docs are stale on sight.

`quorum-desktop` has the equivalent `git debug` for `diag/dm-frame-join`.

The alias lives in `.git/config` (machine-local, lost on a fresh clone). If
`git debug` is not found, reinstall it:

```bash
git config --local alias.debug '!bash .agents/scripts/git-debug.sh'
```

Details: [scripts/README.md](scripts/README.md) and §D of
[the DM master report](issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md).
