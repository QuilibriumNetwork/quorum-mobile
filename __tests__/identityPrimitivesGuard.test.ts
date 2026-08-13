/**
 * No file outside the identity module reaches its two unverified PRIMITIVES
 * directly.
 *
 * ## Why primitives, not modules
 *
 * An earlier version of this idea on desktop named the modules being deleted
 * during that migration. Once the deletion finished, the list of banned
 * imports pointed at files that no longer existed, so the test could never
 * fail again — a tombstone, not a guard. This version names the two things
 * that keep existing after the migration and must stay contained:
 *
 * - `resolveIdentity`, imported from `@quilibrium/quorum-shared` — the raw
 *   tier-merge rule. It trusts whatever `qnsName` it is handed; nothing about
 *   it checks that the name was actually verified. Calling it directly is how
 *   a surface renders a `.q` for a claim nobody checked.
 * - `identityFromMaps`, this module's own tier assembly — trusted precisely
 *   because every caller of it is `identity/`'s own code, which populates
 *   `verifiedQnsNames` from a real verification query and never from a raw
 *   profile. A caller from outside `identity/` has no such guarantee and could
 *   feed it an unverified claim just as easily as a verified one.
 *
 * Both are meant to be reached through exactly one seam each: `identity/`'s
 * own files (which own the verification step), and `utils/resolveMemberName.ts`
 * (the pure, non-hook adapter kept for the receive path and for pure
 * transforms that cannot call a hook — see that file's own header, and
 * `components/Chat/types.ts`'s entry in `rawNameFieldAudit.test.ts` for a
 * caller of it). Anything else reaching either primitive has stepped around
 * the seam rather than through it.
 *
 * ## Honesty, not coverage
 *
 * This walks the tree as text and looks for the primitives as NAMED IMPORT
 * SPECIFIERS, not as any use of either word. A namespace import
 * (`import * as shared from '@quilibrium/quorum-shared'`) or a dynamic
 * `require`/`import()` would not be seen — nothing in this codebase uses
 * either form for this package today, and the class of bug this guards
 * against (a new render surface reaching for the primitive the same way every
 * existing caller does) is what a named-import scan catches.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Directories not scanned: build/native/vendor output that is never this
 * app's own render or data-transform code, and `identity/` itself, which
 * legitimately imports both primitives as the one place their trust
 * boundary is enforced.
 */
const EXCLUDED_DIRS = [
  'node_modules',
  'android',
  'ios',
  'assets',
  'splash-assets',
  '__tests__',
  '__mocks__',
  'jest',
  'identity',
  'patches',
  'scripts',
  'plugins',
];

/**
 * The one file outside `identity/` allowed to reach the primitives directly.
 * See its own header comment for why the pure, non-hook seam has to exist at
 * all, and `identity/index.ts` for why nothing else should import from here
 * instead of `@/identity`.
 */
const ALLOWED_FILE = 'utils/resolveMemberName.ts';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.includes(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Every `import { ... } from '...'` statement in the file, as
 * (raw specifier list, module path) pairs. Character classes match across
 * newlines already, so a specifier list wrapped onto several lines is found
 * without a multiline flag.
 */
function importedSpecifierBlocks(source: string): { specifiers: string; path: string }[] {
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  const out: { specifiers: string; path: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    out.push({ specifiers: m[1], path: m[2] });
  }
  return out;
}

/** Exported so the rule can be exercised directly, without walking the tree. */
export function offendingImports(source: string): string[] {
  const offenses: string[] = [];
  for (const { specifiers, path } of importedSpecifierBlocks(stripComments(source))) {
    if (path === '@quilibrium/quorum-shared' && /\bresolveIdentity\b/.test(specifiers)) {
      offenses.push('resolveIdentity');
    }
    // Any path: `identityFromMaps` is reached via the `@/identity` barrel or
    // `@/identity/identityFromMaps` directly, and both must be caught. A
    // type-only import of a sibling export (`RosterNameRow`, `IdentitySources`)
    // does not mention the function's name in the specifier list, so it is
    // not flagged — see `hooks/useMultiSpaceRosters.ts` for the real case this
    // has to stay quiet on.
    if (/\bidentityFromMaps\b/.test(specifiers)) {
      offenses.push('identityFromMaps');
    }
  }
  return offenses;
}

describe('no file outside identity/ reaches its unverified primitives directly', () => {
  it('finds only the one allowed adapter file', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('.')) {
      const rel = file.split(/[\\/]/).join('/').replace(/^\.\//, '');
      if (rel === ALLOWED_FILE) continue;
      const offenses = offendingImports(readFileSync(file, 'utf8'));
      if (offenses.length) offenders.push(`${rel}: ${offenses.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });

  it('the allowed adapter file still needs its exception', () => {
    // If `utils/resolveMemberName.ts` ever stopped importing `resolveIdentity`
    // itself, `ALLOWED_FILE` would be a stale allowance nobody notices — the
    // same staleness the sibling audits guard against, just for a one-entry
    // list instead of a map.
    expect(offendingImports(readFileSync(ALLOWED_FILE, 'utf8'))).toContain('resolveIdentity');
  });

  it('is not vacuous — fires on either primitive, stays quiet on a type-only import', () => {
    expect(
      offendingImports("import { resolveIdentity } from '@quilibrium/quorum-shared';"),
    ).toEqual(['resolveIdentity']);
    expect(
      offendingImports("import { identityFromMaps } from '@/identity';"),
    ).toEqual(['identityFromMaps']);
    // A `resolveIdentity`-named import from anywhere OTHER than shared is not
    // this primitive — same word, different binding, out of scope.
    expect(
      offendingImports("import { resolveIdentity } from './someLocalHelper';"),
    ).toEqual([]);
    // The real shape of `hooks/useMultiSpaceRosters.ts`: a type-only import of
    // a SIBLING export must not trip the guard.
    expect(
      offendingImports("import type { RosterNameRow } from '@/identity/identityFromMaps';"),
    ).toEqual([]);
    // Both primitives imported together are both reported, not just the first.
    expect(
      offendingImports(
        [
          "import { resolveIdentity } from '@quilibrium/quorum-shared';",
          "import { identityFromMaps } from '@/identity';",
        ].join('\n'),
      ),
    ).toEqual(['resolveIdentity', 'identityFromMaps']);
    // A comment mentioning the name is not an import.
    expect(
      offendingImports('// do not call resolveIdentity or identityFromMaps directly here'),
    ).toEqual([]);
  });
});
