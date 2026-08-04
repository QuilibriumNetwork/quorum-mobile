---
type: doc
title: "Testing mobile against local quorum-shared (before an npm publish)"
created: 2026-06-15
audience: self (gitignored, local-only)
---

# Testing mobile against a local quorum-shared build (pre-publish)

> **Scope: this is the LOCAL-ONLY, one-machine workflow.** For the team-wide question
> ("can we commit `link:../quorum-shared` like desktop does?" — no, EAS blocks it) see
> `.agents/issues/.open/2026-08-01-deliver-quorum-shared-to-mobile-without-npm-publish.md`.

> **Version numbers below are from the era this was written (`-29` pinned, `-30` pending).
> The mechanics are unchanged; today's pin is `2.1.0-39`.** Read `-29` as "whatever
> `package.json` pins" and `-30` as "the unpublished local build you want to test".

> ⚠️ **AFTER EVERY copy refresh, you MUST `yarn start --clear` — a plain reload (`r`) is NOT enough.**
> Metro caches resolved `node_modules` package contents and Fast Refresh only tracks
> YOUR source, not `node_modules`. So when `link-local-shared.ps1 -Copy` swaps the
> shared package files, a reload keeps serving the STALE cached shared module. Symptom
> (seen live 2026-06-15): a brand-new shared export throws at runtime
> `TypeError: <symbol> is not a function (it is undefined)` even though it's physically
> in the copy's dist. Fix: stop Metro, `yarn start --clear`, cold-rebuild.

## The problem this solves

Mobile consumes `@quilibrium/quorum-shared` as a **pinned npm version** (currently
`2.1.0-29` in `package.json`). When we land work on shared's `master` that mobile
needs (e.g. the role-color palette + resolver in shared `2.1.0-30`), mobile can't
use it until **Cassie publishes** that version to npm — and that can take a long
time. Meanwhile we want to:

1. develop + runtime-test the mobile side of that work **now**, and
2. keep shipping **other** mobile features on other branches in the meantime,
   without those branches being polluted by a temporary local-shared hack.

This doc is the workflow for (1)+(2), and — importantly — the **risks** of each option.

## The core principle: do NOT put `link:` in package.json

The naive approach is to change `package.json` to
`"@quilibrium/quorum-shared": "link:../quorum-shared"`. **Don't.** That line is
**committed and travels to every branch.** It would:

- pollute `master` and every other feature branch you cut,
- force a manual "reset before PR" on *every* PR (easy to forget → ships a broken pin),
- rewrite `yarn.lock` into a `link:`-referencing state that breaks a fresh
  `yarn install` for anyone else (and for Cassie's production build).

Instead, point at local shared at the **`node_modules` level only**, leaving
`package.json` and `yarn.lock` **completely untouched**. `node_modules/` is
gitignored, so nothing leaks into git, into other branches, or to Cassie.

## Two mechanisms (pick per the Metro verification below)

Both replace the installed `node_modules/@quilibrium/quorum-shared` with our local
build. `package.json` stays pinned at `-29` the whole time.

Mobile (Metro) consumes the **built `dist/`**, not shared's `src/`. Shared's
`package.json` entry for RN is `react-native: ./dist/index.native.js`. So whichever
mechanism you use:

> **After ANY change to shared source, run `yarn build` in quorum-shared** to
> refresh `dist/` before mobile sees it. (Right now `dist/` already contains the
> committed `-30` role-color work, so you're ready without rebuilding.)

### Option A — COPY into node_modules (safest on this machine)

Replace the installed package dir with a copy of the local shared repo's built
output. No symlink-following, no out-of-root file crawl, no Watchman interaction —
sidesteps every Metro-on-Windows risk below.

- Pro: maximally robust; behaves exactly like a normally-installed package.
- Con: you must **re-copy after every `yarn build` in shared** (a script makes this one command).

### Option B — SYMLINK node_modules dir → local shared repo

`node_modules/@quilibrium/quorum-shared` → `../quorum-shared`.

- Pro: edits to shared's `dist/` are picked up without re-copying (still need the
  shared `yarn build`).
- Con: relies on Metro following a symlink whose target is **outside the project
  root and not in `watchFolders`** — historically flaky, especially on this setup.
  See risk #1.

## CRITICAL: "linked" is NOT the same as "installed" — link ≠ proof it ships

A local link/junction/copy lets you **develop and iterate**, but it is **NOT proof
the published package will work**. Things can pass while linked and then break after
a real `npm install` of the published version. This applies to **every**
local-redirect method — the junction/copy scripts here included, not just a
`package.json` `link:`. The divergences:

1. **Shipped files ⊂ repo files.** `npm publish` ships only what the package's
   `files` allowlist / `.npmignore` permits (typically just `dist/` + `package.json`).
   A junction/copy of the **whole repo** exposes everything (`src/`, tests, dev
   files). So an import that **resolves locally** (the file exists in the repo) can
   **fail after publish** if that file isn't in the published tarball. Linked =
   "every repo file is present"; installed = "only the allowlisted subset."
   - We use a **dist-built** junction/copy here, which narrows this gap — but a copy
     that grabbed more than `dist/` + `package.json`, or a junction to the repo root,
     still exposes non-shipped files. Don't import deep paths that aren't part of the
     package's public `exports`.

2. **Dependency resolution differs.** An installed package's transitive deps are
   flattened/deduped by **mobile's** lockfile. A linked repo may resolve **its own**
   `node_modules` (different versions / its own copies), so a transitive dep can be
   one version linked and another installed → works one way, breaks the other.

3. **Entry-point / `exports` resolution can differ** between a linked directory and
   an installed package (conditional exports, peer deps), which is exactly the kind
   of thing that passes locally and fails on a clean install.

**Therefore:** the link is a development convenience, not a release gate. The ONLY
proof the published package works is the final step — bump to the real published
`-30`, run a clean `yarn install`, and runtime-test THAT. Never conclude "it works"
from the linked state alone; always re-verify after the real install before merging.

## Metro verification (do FIRST, decides A vs B)

This repo's `metro.config.js` has three properties that make symlinks risky here:

1. `config.resolver.nodeModulesPaths = [mobileNodeModules]` — Metro is told to
   resolve **only** from the project's `node_modules`. There are **no
   `watchFolders`**, so a symlink target outside the project root is not in a
   watched/crawled root.
2. `if (process.platform === 'win32') config.resolver.useWatchman = false` — on
   Windows we already use Metro's **Node crawler** (because the accented Windows
   account name breaks Watchman's named pipe). The Node crawler
   following a symlink out to another repo is the **untested combination** here.
3. `resolveRequest` hard-redirects a `SINGLE_INSTANCE_PACKAGES` set to the mobile
   copy. `@quilibrium/quorum-shared` is **not** in that set, so it resolves
   normally — good, no special handling needed — but it confirms Metro is doing a
   real resolve walk for shared.

**Verification step:** after setting up Option B (symlink), start Metro and import
a brand-new `-30` symbol (e.g. `getRoleColorHex`) somewhere mobile bundles. If the
bundle resolves it, symlink works — keep Option B. If Metro throws
"unable to resolve" or doesn't pick up shared edits, **fall back to Option A (copy)**.

## When Cassie publishes (`-30` lands on npm)

1. In the **mobile Phase-C PR branch only**, bump `package.json`
   `"@quilibrium/quorum-shared": "2.1.0-29"` → `"2.1.0-30"`.
2. Run a normal `yarn install`. This **removes the local copy/symlink** and pulls
   the real registry version, restoring `node_modules` + `yarn.lock` to a clean,
   publishable state.
3. **Verify the published dist actually exports the new symbols** (don't trust the
   version number — RECAP lesson): the `-30` dist must contain `getRoleColorHex`,
   `getDefaultRoleColor`, `ROLE_COLORS`, and the widened `IconColor`.
4. Runtime-test against the real installed `-30`, then that PR carries the bump.
5. Other feature branches pick up `-30` whenever they next rebase past that merge.

## Risk register (read before relying on this)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **Metro doesn't follow the symlink** (Option B) on Windows/no-Watchman/out-of-root | Medium | Dev-only; bundle fails to resolve shared | Verify first (above); fall back to Option A (copy) |
| R2 | **Stale `dist/`** — you edit shared `src` but forget `yarn build`, so mobile tests old code | High (easy to forget) | Tests pass/fail against wrong code → false conclusions | Always `yarn build` in shared after a src change; the copy script can run build first |
| R3 | **Accidental commit of the hack** | Low (node_modules is gitignored) | Would pollute the branch | We never touch package.json/yarn.lock; `node_modules` is gitignored — verify `git status` is clean after setup |
| R4 | **`yarn install` on another branch wipes the local copy** | High (expected) | Mobile silently reverts to npm `-29`; "my fix disappeared" | Known behavior: re-run the copy/symlink setup after any `yarn install`. Document the one command. |
| R5 | **Version skew illusion** — you test against local `-30` source, but ship a PR pinned at a not-yet-published `-30` (if you pin early) | Medium | PR is "correct but un-installable" until publish; a fresh `yarn install` fails | **Don't pin `-30` early.** Keep `package.json` at `-29` until Cassie publishes, then bump (above). No mobile CI exists today (no `.github/workflows`), so an early pin wouldn't red-X a PR — but a fresh clone/install would still fail. |
| R8 | **"Linked ≠ installed"** — passes while linked, breaks after a real install (non-shipped file resolved, different transitive dep version, exports mismatch) | Medium | False "it works"; breaks post-publish | See the dedicated section above. The link develops; only a clean install of the published `-30` proves it ships. Always re-verify after the real install before merging. |
| R6 | **`dist` entry mismatch** — mobile uses `react-native: ./dist/index.native.js`; if that entry is stale vs `index.js` you'd test the wrong bundle | Low | Wrong code under test | `yarn build` in shared rebuilds all entries together; don't hand-edit dist |
| R7 | **Single-instance packages** — if local shared bundled its own copy of react/react-query it could break Context | Very low | Runtime crash | metro's `resolveRequest` already hard-redirects those to the mobile copy; shared has them as peer/externals, not bundled |
| R9 | **Copy drops shared's nested `node_modules`** — its externalized deps silently repoint at mobile's hoisted, sometimes wrong-major copies (`@noble/hashes` 1.8.0 vs 2.0.1) | **Materialized 2026-08-01** | Cold bundle fails on a package you never touched | `-Copy` now carries the nested tree over; `verify-shared-externals.mjs` gates the link. Re-check drift whenever either repo bumps a shared dep |

## Net assessment

- **Your reasoning is sound:** keep `package.json` correct, test locally, and when
  Cassie does a production build her `package.json` (bumped to `-30` by our PR)
  **forces** her to install the published `-30` — she can't build otherwise. So the
  shipped artifact is always the real registry version, never the local hack.
- **The footgun is NOT package.json — it's the lockfile + "forgetting to rebuild
  shared" (R2) + "yarn install wipes the link" (R4).** The `node_modules`-level
  approach removes the lockfile risk entirely; R2/R4 are operational and handled by
  a single setup script you re-run when needed.
- **Recommended:** keep `package.json` at `-29`, use **Option A (copy)** unless the
  Metro symlink verification passes cleanly, always `yarn build` shared after a src
  change, and bump to `-30` only in the mobile PR after the publish.

## Scripts (deterministic — use these, don't hand-do it)

Two PowerShell scripts in `.agents/scripts/` automate this safely. They NEVER
touch `package.json`/`yarn.lock`, rebuild shared first (kills R2), back up the npm
package for fast restore, and verify the git tree stays clean (R3).

```powershell
# Link mobile -> local shared (rebuilds shared, junctions it in):
.\.agents\scripts\link-local-shared.ps1

# If Metro can't resolve the junction (R1), use a plain copy instead:
.\.agents\scripts\link-local-shared.ps1 -Copy

# Skip the shared rebuild (dist/ already fresh):
.\.agents\scripts\link-local-shared.ps1 -NoBuild

# Undo - restore the npm-pinned version (from backup, fast):
.\.agents\scripts\unlink-local-shared.ps1

# Force a clean reinstall instead of backup-restore:
.\.agents\scripts\unlink-local-shared.ps1 -Reinstall
```

After linking, **restart Metro with a cleared cache** (`yarn start --clear`) so it
re-resolves the swapped package. To verify the link took, import a `-30`-only
symbol (e.g. `getRoleColorHex`) and confirm the bundle resolves it — if it fails,
re-run with `-Copy`.

**Re-link after any `yarn install`** (R4): `yarn install` restores the npm version
and wipes the link. Just re-run `link-local-shared.ps1`.

**Metro A-vs-B verification — RESOLVED 2026-06-15: USE `-Copy`. The junction does NOT
work with this project's Metro.** Confirmed empirically: with the junction in place,
Node/filesystem resolved everything fine (`2.1.0-30`, `dist/index.native.js`, helpers
all reachable), but `yarn start` Metro bundling FAILED with `Unable to resolve
"@quilibrium/quorum-shared"` — even from a pre-existing import (`hexToBytes` in
`services/notifications/hubLogClassifier.ts`). This is R1 materializing: Metro's
resolver (`nodeModulesPaths` locked to the project root, no `watchFolders`, Windows
Node-crawler) does not follow a junction out to another repo. Switching to `-Copy`
(a real directory copy of `dist/` + `package.json`) fixes it — Metro resolves a real
`node_modules` dir normally. **So on this machine: always link with `-Copy`.** The
junction path is left in the script but is a dead end for Metro here.

Note: plain `node -e "require('@quilibrium/quorum-shared')"` on the full barrel fails
with a `multiformats` `ERR_PACKAGE_PATH_NOT_EXPORTED` regardless of junction-vs-copy —
that is a **Node-CLI loader quirk, NOT a Metro failure** (Metro sets
`unstable_enablePackageExports`), so don't use that as a resolution test.

**GOTCHA confirmed live (R2):** running the link script with `-NoBuild` against a
**stale/partial dist** bit us — `dist/index.native.js` was missing (only `index.js`
+ `index.mjs` present), so mobile's RN entry wouldn't resolve. `tsup`'s "Cleaning
output folder" can leave the dist partial between runs. **Do NOT use `-NoBuild`
unless you just confirmed a full `yarn build` produced all three entries**
(`index.js`, `index.mjs`, `index.native.js`). The default (build-first) path is
safe; `-NoBuild` is the footgun.

**GOTCHA confirmed live 2026-08-01 (R9) — the copy MUST carry shared's nested
`node_modules`.** Shared's `dist` does not bundle its dependencies, it externalizes
them: `dist/index.native.js` still contains bare `require("@noble/hashes/sha2")`,
`require("dayjs")`, `require("multiformats/bases/base58")` and friends. The
npm-installed package ships a **nested `node_modules`** holding the exact versions
shared resolved (`@noble/hashes@1.8.0`, `unified@11.0.0`, `@ungap/structured-clone@1.3.1`).
The original `-Copy` implementation copied only `package.json` + `dist/`, so those
imports fell through to mobile's **hoisted** copies — and they are not the same major:

| dep | shared's nested | mobile hoisted |
|-----|-----------------|----------------|
| `@noble/hashes` | 1.8.0 (exports `./sha2` **and** `./sha2.js`) | 2.0.1 (exports `./sha2.js` only) |

So `@noble/hashes/sha2` resolves against the nested 1.8.0 and **fails** against the
hoisted 2.0.1 with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Metro honours the `exports` map
(`unstable_enablePackageExports = true`), so this is a hard bundle failure, ~2 minutes
into a cold build, pointing at a package you never touched. Both directions verified
by resolution test on 2026-08-01.

Fixed: `-Copy` now copies the backed-up nested `node_modules` across, and the script
ends with `verify-shared-externals.mjs`, which resolves every declared-dependency
import found in the dist entries and fails the link if any of them would not resolve.
Run it standalone any time to re-check:

```bash
node .agents/scripts/verify-shared-externals.mjs
```

One subtlety it handles: `multiformats@13` is ESM-only, so `require.resolve` on
`multiformats/bases/base58` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` even in a perfectly
healthy tree. The subpath **is** in the exports map, just gated behind the `import`
condition, and Metro takes it. The verifier distinguishes "subpath absent from the map"
(a real break) from "present but ESM-only" (fine) rather than reporting both as failures.
This is the same Node-CLI quirk the note above warns about — do not use a bare
`node -e "require(...)"` as a resolution test.

> A skill wrapping these + the "is -30 published yet?" check + the package.json
> bump step may come later; the scripts are the deterministic substance.

---
*Last updated: 2026-08-01*
