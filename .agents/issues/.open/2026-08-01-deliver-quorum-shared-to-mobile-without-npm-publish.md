---
type: task
title: "Team-wide quorum-shared delivery without waiting for an npm publish (desktop's link: does NOT port to mobile — EAS blocks it)"
status: open
priority: low
ai_generated: true
created: 2026-08-01
updated: 2026-08-01
---

# Deliver quorum-shared to mobile without an npm publish, for everyone

> **⚠️ AI-Generated**: May contain errors. Verify before use.

## The question this answers

Desktop consumes shared as a committed relative-path link:

```json
"@quilibrium/quorum-shared": "link:../quorum-shared"     // quorum-desktop/package.json
```

Can mobile do the same, **committed, for everyone**, so shared changes land without
round-tripping through a publish?

**As-is: no.** But the reason is not the one recorded in the June analysis, and there
are two routes that do work. This file exists so the conversation with the lead dev
starts from measured facts rather than from a re-derivation.

**Not to be confused with** `.agents/docs/local-shared-dev-workflow.md`, which is the
**local-only, one-machine** workflow (copy into gitignored `node_modules`, never touch
`package.json`). That already works and is unaffected by anything here. This task is
about the *team-wide, committed* version, which is a different problem.

## Why `link:` does not port to mobile — the actual blocker

**EAS Build.** Mobile has `eas.json` with `development` / `preview` / `production`
profiles; desktop has no cloud build at all (`electron:build` runs `vite build &&
electron-builder`, always on a machine that already has the sibling repo on disk).

EAS CLI builds its upload archive by "copying all files starting from **the root of the
git repository**, with the exception of `.git`, `node_modules`, and all files matched by
rules from `.gitignore`" — and with `requireCommit: true` it uses `git clone --depth 1`
instead, which is stricter still.
Source: <https://github.com/expo/fyi/blob/main/eas-build-archive.md>

`quorum-shared` is a **separate git repo beside** `quorum-mobile`, not a folder inside
it. It is therefore outside mobile's git root, never enters the archive, and
`yarn install` on the builder cannot resolve `link:../quorum-shared`. **Every cloud
build fails, production included.**

This is a hard constraint on the *delivery mechanism*, not something a `metro.config.js`
change can fix.

> The June task (`issues/.done/2026-06-14-link-quorum-shared-locally-for-faster-iteration.md`)
> framed the risk as "Metro won't follow the symlink". That framing is now outdated on
> both counts: modern Metro does follow symlinks, and EAS — not Metro — is what actually
> forbids the committed `link:`. Read this file instead of that one for the team-wide
> question.

## Second cost, if the link ever were viable: peer-dep duplication

Even ignoring EAS, `link:` is not the one-line change it is on desktop.
`quorum-shared/node_modules` carries **full copies of its 15 `peerDependencies`**, and
several are at different versions than mobile's. Under symlink resolution Metro walks up
from shared's realpath and finds those **first**:

| package | shared's copy | mobile's | already redirected? |
|---|---|---|---|
| `expo-haptics` | 55.0.8 | 15.0.8 | **no** |
| `react-native-safe-area-context` | 5.7.0 | 5.6.1 | yes |
| `react-native-svg` | 15.12.1 | 15.12.1 | no (versions match today) |
| `@tabler/icons-react-native` | 3.40.0 | 3.40.0 | no (versions match today) |
| `react`, `react-dom`, `react-native`, `@tanstack/react-query` | matched | matched | yes |

`metro.config.js`'s `SINGLE_INSTANCE_PACKAGES` covers five of them. A duplicate
`expo-haptics` at a different major, with native module registration, is exactly the
class of bug that costs a day. Any `link:`-shaped solution would need `watchFolders` for
the sibling repo **plus** a redirect covering every entry of shared's
`peerDependencies`, not just the current five.

Measured 2026-08-01 with mobile at shared `2.1.0-39`.

## Options

### A. Git dependency on quorum-shared (recommended — closest to the intent, EAS-safe)

```json
"@quilibrium/quorum-shared": "QuilibriumNetwork/quorum-shared#master"
```
or pinned to a commit SHA, which is arguably better provenance than a `-NN` tag.

A remote URL is resolved by the package manager **on the EAS builder**, so nothing has to
be in the upload archive. No `metro.config.js` change: the package lands in mobile's own
`node_modules` with its own nested deps, exactly as the registry version does today.

Costs, both of which need verifying before proposing this:
- **shared needs a `prepare` script.** It has only `prepublishOnly: npm run build`, and
  `dist/` is gitignored, so a git-dep install would fetch a source-only tree and build
  nothing. `prepare` runs on git-dep install (unlike `prepublishOnly`) and would need
  shared's devDeps (`tsup`, `typescript`) present at install time.
- **the repo is private**, so the EAS builder needs credentials to clone it.

### B. Git submodule of quorum-shared inside the mobile repo, then `link:` to it

Puts shared **inside** mobile's git root, so EAS uploads it and `link:` resolves on the
builder. Fully solves the delivery problem. Costs: submodule tax for everyone (clone with
`--recursive`, pointer commits on every shared change), plus the whole peer-dep
duplication section above still applies, since this is still a `link:`.

### C. Vendored tarball committed to the mobile repo

`yarn pack` in shared, commit `vendor/quorum-shared-<sha>.tgz`, depend on
`"file:./vendor/quorum-shared-<sha>.tgz"`. Inside the git root, so EAS uploads it. No
auth, no submodule, no Metro change, and it is a real packed tarball so "linked ≠
installed" divergence disappears. Costs: a binary blob in git history and a manual
refresh per shared change. Good for a **one-off unblock**, bad as a standing workflow.

### D. Status quo

Registry pin + `.agents/scripts/link-local-shared.ps1 -Copy` for local dev. The real pain
is that only the lead dev can publish, so a more frequent `-NN` cadence solves the same
problem with zero build-system risk. Worth naming explicitly as the alternative when
raising A.

## Recommendation

Raise **A** with the lead dev, with **C** as the escape hatch for a single urgent unblock.
It changes how her production builds resolve the package, so it is her call, not ours.
Do not touch `metro.config.js` for this — under A there is nothing to change.

## Verify before proposing (open questions)

1. **Does yarn 1.22 run `prepare` for git dependencies?** Mobile is on yarn 1.22.22
   (`packageManager` field). npm does this reliably; yarn 1's behaviour here has had bugs.
   Test cheaply: add `prepare` to a scratch branch of shared, `yarn add` it by git URL into
   a throwaway project, check whether `dist/` exists in the installed copy.
2. **How does the EAS builder authenticate to a private GitHub repo** during install, and
   is it a token in a secret, an SSH key, or an `.npmrc`? Check current Expo docs; do not
   assume.
3. **Does `requireCommit` get set** in `eas.json` later? It changes archive behaviour
   (`git clone --depth 1`, no `.easignore`) and would rule out C's `.easignore` tricks if
   any were needed.
4. **Does desktop want the same treatment?** If shared moves to a git dep, desktop's
   `link:` still works locally, but the two repos would then disagree about what "the
   current shared" means. Probably fine; worth a sentence in the proposal.

## Still true regardless of route

"Linked ≠ installed." A path-linked or submodule'd package exposes files (`src/`, tests)
and transitive versions that a real install would not, so it can pass locally and break
after publish. Options A and C both go through a real package resolution and mostly close
that gap; B does not.

## Related

- `.agents/docs/local-shared-dev-workflow.md` — the local-only workflow that already
  works, plus the R9 nested-`node_modules` gotcha found 2026-08-01
- `.agents/issues/.done/2026-06-14-link-quorum-shared-locally-for-faster-iteration.md` —
  the original analysis; superseded on the team-wide question by this file
- `.agents/scripts/README.md` §"Developing against unpublished shared changes"

---
*Last updated: 2026-08-01*
