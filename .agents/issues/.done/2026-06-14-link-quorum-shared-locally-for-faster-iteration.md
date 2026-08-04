---
type: task
title: "Link quorum-shared locally (link:../quorum-shared) for faster iteration — evaluate Metro risk first, discuss with lead dev"
status: done
created: 2026-06-14
urgency: Tier 3 (workflow speed-up, not a bug)
shared_change: changes how mobile resolves @quilibrium/quorum-shared (build-affecting)
version_bump: none (but effectively upgrades 2.1.0-26 -> 2.1.0-30 if linked to current local source)
runtime_test: required (cold Metro bundle MUST pass before any commit)
---

# Link quorum-shared locally for faster iteration

## Goal

Stop round-tripping through an npm publish to test shared-package changes on mobile. Desktop
already consumes shared via `"@quilibrium/quorum-shared": "link:../quorum-shared"` (a relative
path to the sibling repo). The proposal is to do the same on mobile so local edits to
`../quorum-shared/` are picked up immediately, and so mobile can use shared versions that aren't
yet published to npm (the current blocker for the DM update-profile port and possibly relevant
to the `decrypt_failed` crypto bug).

## Current state (verified 2026-06-14)

- Mobile `package.json`: `"@quilibrium/quorum-shared": "2.1.0-26"` — a **registry tarball** pin
  (`resolved https://registry.yarnpkg.com/...quorum-shared-2.1.0-26.tgz`, with integrity hash).
- Local sibling repo `../quorum-shared/` exists, on `master`, at **version `2.1.0-30`**, with a
  **built `dist/`** that includes `dist/types/message.d.ts`. So it is 4 patch-versions AHEAD of
  what mobile pins.
- Desktop `package.json`: `"@quilibrium/quorum-shared": "link:../quorum-shared"` — the proven
  convention to copy.
- Mobile package manager: **Yarn 1.22.22** (`yarn.lock`; the `package-lock.json` is stale/secondary).
  No workspaces.

## ⚠️ Why this is RISKIER on mobile than on desktop (the key finding)

The ORGANIZATIONAL setup is identical to desktop (sibling repo, `link:` line, lead dev already
has quorum-shared checked out). The added risk is purely TECHNICAL and comes from the bundler:

- **Desktop = webpack/Vite-class tooling** → follows symlinks natively, resolves nested
  `node_modules` up the tree. `link:../quorum-shared` "just works."
- **Mobile = Metro** → historically does NOT follow symlinks, AND `metro.config.js` here further
  pins resolution to mobile's own `node_modules` (`config.resolver.nodeModulesPaths =
  [mobileNodeModules]`, line 51) with a custom `resolveRequest` for single-instance packages.

Yarn 1's `link:` protocol creates a symlink at `node_modules/@quilibrium/quorum-shared`. Two
likely failure modes on Metro:

1. Metro may not resolve through the symlink at all (needs symlink support enabled, or
   `watchFolders` + `extraNodeModules`).
2. quorum-shared's OWN transitive deps (`@noble/*`, `multiformats`, etc.) live in
   `../quorum-shared/node_modules`, not mobile's — so even if the symlink resolves, those deps may
   fail to resolve given the pinned `nodeModulesPaths`. Classic "Unable to resolve module" ~2 min
   into a cold bundle.

So: the same one-line change that is frictionless on desktop is fragile on mobile and will very
likely require `metro.config.js` edits + a cold-bundle verification before it can be trusted.

## Risks (and the team's stance, recorded 2026-06-14)

1. **Breaks the build for anyone without `../quorum-shared` checked out at that exact path.**
   `link:` is a relative-path dep; a fresh clone of quorum-mobile without the sibling repo fails
   `yarn install` / Metro resolve. CI / production clean installs break unless they also clone +
   build quorum-shared.
   - *Team stance:* Only the repo owner + lead dev work on mobile, both already have the sibling
     repo (desktop needs it too). A README warning covers any outside builder. **Accepted.**
2. **Committing the link changes `package.json` / `yarn.lock` for everyone** (shared state, not
   just one machine).
   - *Team stance:* Same "it's just us two" reasoning. **Accepted — but commit only with lead-dev
     buy-in, since it's their build too.**
3. **Silently upgrades 2.1.0-26 -> 2.1.0-30** (4 versions of shared churn, incl. crypto/types).
   Could fix things (maybe even `decrypt_failed` if that's a shared-crypto issue) or introduce new
   breakage.
   - *Team stance:* Believed fine; will be verified locally. **Accepted, but do not conflate this
     version jump with the `decrypt_failed` debugging — note the shared version in that bug.**

The technical (Metro) risk is the one NOT covered by the "it's just us two" reasoning. It is
verifiable locally before any commit, which is the right gate.

## Proposed approach (when greenlit)

1. `package.json`: `"@quilibrium/quorum-shared": "link:../quorum-shared"` (match desktop exactly).
2. `yarn install` (creates the symlink).
3. `metro.config.js`: add a `watchFolders` entry for `path.resolve(__dirname, '../quorum-shared')`
   and an `extraNodeModules` mapping so quorum-shared's transitive deps resolve back to mobile's
   `node_modules` (or enable Metro symlink support). Keep the existing single-instance
   `resolveRequest` intact.
4. **Cold-bundle test**: clear Metro cache (`--reset-cache`), full reload, exercise messaging.
   This is the gate — do NOT commit until a cold bundle succeeds end to end.
5. Add a README warning: "Building this repo requires the sibling `../quorum-shared` repo checked
   out and built (`yarn && yarn build` in quorum-shared). Mobile consumes it via `link:`."
6. Commit package.json + yarn.lock + metro.config.js + README together.

## Alternatives (discuss with lead dev)

- **Don't commit the link — local-only override.** Keep committed `package.json` on the registry
  pin; use a gitignored local mechanism (yarn `resolutions` in a local-only file, or just an
  uncommitted package.json edit) so CI/teammates are unaffected and only this machine links.
  Lowest risk; preserves "registry is the production truth."
- **Bump the registry pin instead.** If a published version with the needed types exists, bump
  `2.1.0-26` -> that version. Avoids relative-path/Metro fragility entirely. (Blocked previously by
  the lead dev being the only one who can publish to npm — see the DM update-profile task.)

## Decision needed

Owner is NOT ready to do this yet (2026-06-14) — wants to discuss with the lead dev first,
specifically because the Metro-symlink risk makes mobile a harder case than desktop. This task
captures the analysis to inform that conversation. Do NOT implement until greenlit.

## Related

- `2026-06-09-port-dm-update-profile-from-desktop.md` — BLOCKED on a shared-package publish;
  linking would unblock it locally.
- `issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md` — the
  `decrypt_failed` crypto bug; jumping to 2.1.0-30 might affect it (do not conflate).

---
*Created: 2026-06-14*
*Last updated: 2026-06-14*
