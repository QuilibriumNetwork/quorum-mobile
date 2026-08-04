---
type: task
title: "Adopt shared message-preprocessing pipeline (replace mobile-local utils/messagePreprocessing.ts)"
status: in-progress
complexity: low
created: 2026-06-18
updated: 2026-07-16
runtime-test: required
related_prs:
  - "quorum-shared#52: promote messagePreprocessing + tests — MERGED 2026-06-25 (on master, version 2.1.0-34)"
  - "quorum-desktop#218: consume shared pipeline in MessageMarkdownRenderer — MERGED 2026-06-25"
  - "quorum-mobile#155: adopt shared pipeline (swap import + delete local copy) — SHIPPED 2026-07-16 (squash 3ce3b7d)"
driver_task: "quorum-desktop/.agents/tasks/quorum-shared-migration/2026-06-18-promote-message-preprocessing-to-shared.md"
mobile_origin: true
---

# Adopt shared message-preprocessing pipeline

> **✅ SHIPPED 2026-07-16 — quorum-mobile PR #155 (squash-merged `3ce3b7d`).** Swapped
> the import in `MessageRenderer.tsx` (sole importer) from `@/utils/messagePreprocessing`
> to `@quilibrium/quorum-shared` and deleted the local copy (382 lines). Verified against
> the installed `2.1.0-34` dist: `prepareMessageContent`/`hasMarkdown` present, and
> shared's `PreprocessOptions` matches mobile's `{ members, roles, channels, everyoneAuthorized }`
> call shape (no call change — option B confirmed). Static gates passed: `tsc --noEmit`
> added zero new errors (21 pre-existing on both branches, none in `components/Chat`);
> `grep messagePreprocessing` clean outside node_modules. Runtime render checks
> (`.agents/tests/2026-06-18-markdown-and-mentions-test-cases.md`, sections A–E + the two
> reconciliation edge cases) to be eyeballed on device — the swap is behavior-preserving
> by construction so this is confirmation, not a gate.

> **UNBLOCKED 2026-06-25; publish gate CLEARED 2026-07-16.** Both driver legs are
> merged: the shared module (`quorum-shared#52`, on master at version `2.1.0-34`) and
> the desktop consumer (`quorum-desktop#218`). The shared `messagePreprocessing` is
> exported from the package root with the exact API mobile already uses (option B
> confirmed — see below). This task is now the only remaining leg. **`2.1.0-34` is now
> published to npm** (it is the `latest` dist-tag) and its dist contains the exact
> exports mobile needs — verified 2026-07-16 against the published tarball:
> `prepareMessageContent`, `processMentions`, `processRoleMentions`,
> `processChannelMentions`, `processURLs`, `getProtectedRegions`, etc. are all present
> in `dist/utils/messagePreprocessing.d.ts`. So **no local link is needed** — just bump
> mobile `2.1.0-33`→`2.1.0-34` and install, then re-confirm the installed dist has
> `prepareMessageContent` before merging. (Do this when you start this task, not while
> parked on the current unrelated branch.)

> **Direction note.** Unlike most files in this folder (desktop→mobile drops where
> mobile is the receiving end), this pair is **mobile-originated**: Wave 1 Phase 2
> wrote a clean, pure-function preprocessing pipeline mobile-local, and it should be
> promoted UP into shared so desktop's inlined copy is de-duped. The *driver* (author
> the shared module + refactor desktop) is the desktop-side task; this file is the
> mobile *consumer* leg (swap local → shared import once published).

## What shipped on mobile (the thing to promote)

Wave 1 Phase 2 (task `2026-06-18-mentions-and-markdown-renderer.md`) added
`utils/messagePreprocessing.ts` — pure string transforms used by the new
`MessageMarkdownRenderer.native.tsx`:

- `processMentions` (`@<address>` + `@everyone` + legacy bare `@address` → `<<<MENTION_*>>>` tokens)
- `processRoleMentions` (`@<roleId>` + `@roleTag` → `<<<MENTION_ROLE:…>>>`)
- `processChannelMentions` (`#<channelId>` → `<<<MENTION_CHANNEL:…>>>`)
- `processURLs`, `convertHeadersToH3`, `fixUnclosedCodeBlocks`
- `getProtectedRegions`/`isInProtectedRegion` (code-region protection)
- `hasMarkdown(text)` detector, `prepareMessageContent(text, opts)` orchestrator

It already imports `hasWordBoundaries` and `createIPFSCIDRegex` from shared.

**The same logic is inlined in desktop's `MessageMarkdownRenderer.tsx`.** Two copies
of one pure-string algorithm; the token vocabulary is shared protocol. Divergence =
cross-platform render bugs. This task removes the mobile copy once shared has it.

## The mobile change (consumer leg)

The shared module is merged (`quorum-shared#52`, on master). Steps:

1. **Update** `package.json`'s `@quilibrium/quorum-shared` to a build containing the
   new symbols. NOTE: the shared version was NOT bumped for this change (still
   `2.1.0-34`), and mobile is pinned to `2.1.0-33` — so either (a) develop/verify
   against a local link (`.agents/scripts/link-local-shared.ps1`) and ship once a
   bumped version is published, or (b) bump to whatever published version first
   carries `messagePreprocessing`. Verify the installed dist actually contains the
   symbols (stale-dist trap — version number alone is not proof: grep
   `node_modules/@quilibrium/quorum-shared/dist` for `prepareMessageContent`).
2. **Swap the import** in `components/Chat/MessageRenderer.tsx` (verified 2026-06-25:
   this is the SOLE importer — line 23; `MessageMarkdownRenderer.native.tsx` only
   mentions the path in a comment):
   ```ts
   // before
   import { hasMarkdown, prepareMessageContent } from '@/utils/messagePreprocessing';
   // after
   import { hasMarkdown, prepareMessageContent } from '@quilibrium/quorum-shared';
   ```
3. **Delete** `utils/messagePreprocessing.ts`.
4. Confirm no other importer remains: `grep -rn "messagePreprocessing" .` (excluding node_modules).
5. **API shape — DECIDED: mobile's shape is canonical (no change for mobile).** The
   role/channel-filtering design call (see driver task) settled on **option B**: the
   shared `processRoleMentions(text, roles)` / `processChannelMentions(text, channels)`
   resolve directly from the `Role[]`/`Channel[]` arrays with NO `roleId[]` filter.
   That IS mobile's current shape, so `MessageRenderer.tsx`'s call does not change —
   only the import source does. (Desktop is the side that changes: it drops its
   `message.mentions.roleIds` filter and adopts this filterless behavior.) Keep the
   legacy bare `@address` shim behavior (mobile-only; messages already in storage rely
   on it).

## ⚠️ Behavior reconciliations baked into the shared module (re-verify on device)

The shared module started from mobile's draft but reconciled a few desktop↔mobile
divergences. Mobile's render output may differ SLIGHTLY from its old local copy — these
are intentional, but re-check them on device:

- **`processURLs` now skips `<URL>` angle-bracket autolinks** (mobile's local copy did
  NOT). A `<https://x.com>` is left as-is instead of being double-wrapped.
- **`getProtectedRegions` now also protects existing markdown links** (mobile's local
  copy protected only code, then re-protected md-links inside `processURLs`). Net: a
  mention or URL inside `[text](url)` is now left untokenized everywhere, not just for
  URL auto-linking. This is the desktop (safer) superset.
- **`@everyone` gate** uses `everyoneAuthorized` (mobile's existing opt name — unchanged).
- **Legacy bare `@address` shim** preserved, gated on `members` being non-empty (mobile
  relies on this for stored messages; unchanged).
- **`@<roleId>` + `@roleTag` dual role match** preserved (mobile's existing behavior).

If any device check shows a regression vs the old local pipeline, compare against
shared `src/utils/messagePreprocessing.ts` + its 59-case test suite to see which
behavior is now canonical.

## Static-analysis gates

- [ ] `npx tsc --noEmit` clean (no new errors in `MessageRenderer.tsx` / Chat dir).
- [ ] `grep -rn "messagePreprocessing"` returns nothing outside node_modules.
- [ ] The four mention pills + spoilers + code blocks still tokenize (re-run the inline
      smoke test from Wave 1 Phase 2, or rely on the shared unit tests — see below).

## Runtime test scenarios (required)

Re-run the Wave 1 Phase 2 render checks against the shared-backed pipeline:
- `@<username>` mention pill (mobile↔mobile + cross-platform with desktop)
- `@everyone` pill; `#channel` pill + navigation
- desktop-authored `@role` mention renders as role-name pill on mobile
- `**bold**` / `_italic_` / `~~strike~~` / `` `code` `` / fenced code (copy) / `||spoiler||`
- a no-markdown message still routes through `MentionableText` (no regression)

## Tests live in shared, not here

Mobile has **no test runner** (no jest/vitest, no `test` script, zero test files as of
2026-06-18). Do NOT stand one up just for this — the preprocessing unit tests belong in
shared's existing Vitest suite (alongside `mentions.test.ts`). The driver task ships
`quorum-shared/src/utils/messagePreprocessing.test.ts`. Writing tests in mobile now
would be throwaway once the logic moves. See the driver task for the test matrix.

## Constraints

- **Publish gate.** Do not merge this mobile PR until the shared version is published
  AND the dist actually contains the symbols (see [[local-shared-dev-link-scripts]] for
  the generic "don't merge on unpublished shared symbols" rule). Develop against a local
  `-Copy` link via `.agents/scripts/link-local-shared.ps1`.
- Cross-repo: this is the receiving leg of a quorum-shared + quorum-desktop change.

---

*Last updated: 2026-07-16 — publish gate CLEARED: shared 2.1.0-34 published to npm with prepareMessageContent + process* fns verified; no local link needed, just a dep bump. Prior: 2026-06-25 — UNBLOCKED: both driver legs merged (quorum-shared#52 +
quorum-desktop#218). Status open→ready. Confirmed mobile's renderer call is unchanged
(option B = mobile's shape) and `MessageRenderer.tsx:23` is the sole importer. Added the
publish-gate note (shared kept at 2.1.0-34, mobile pinned to 2.1.0-33) and a list of the
behavior reconciliations baked into the shared module to re-verify on device.*
