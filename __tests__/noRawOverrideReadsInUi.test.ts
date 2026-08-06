/**
 * No UI file may read a member's per-space OVERRIDE slot by hand.
 *
 * ## The class of bug this catches
 *
 * A member's name lives in two slots: the per-space OVERRIDE
 * (`display_name` / `name`) and the GLOBAL slot (`global_display_name`).
 * Empty override means "follow global", which is the default, so a surface
 * that reads only the override renders MOST members as a truncated address.
 *
 * For years that was hidden by an accident: joining a space stamped the
 * joiner's global name into the override, so the override was almost never
 * empty. The moment joins were fixed to write the global slot where they
 * belong, every surface relying on that accident broke at once — and it broke
 * in the direction that looks like ordinary missing data, not like a bug.
 *
 * Three such surfaces were found and fixed by hand. "We found them all" was
 * inference. This test converts it into something enforced: a fourth cannot be
 * added without failing the suite.
 *
 * ## The rule
 *
 * Render a name through `resolveMemberName` / `formatResolvedName`, which owns
 * the ladder and reads both slots. Do not touch the raw field.
 *
 * ## Why an allowlist rather than a clever check
 *
 * A few files legitimately touch the raw slot — the editor that WRITES a
 * per-space name, and the autocomplete that matches against every stored field
 * as well as the rendered one. Each is listed with its reason. Adding to this
 * list is allowed; doing it without a reason is not, which is the point.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOTS = ['components', 'app'];

/**
 * Files permitted to mention the override slot, and why. A reason is required:
 * an entry with a vague one is a review flag, not a pass.
 */
const ALLOWED: Record<string, string> = {
  'components/Chat/MessageInput.tsx':
    'Mention autocomplete MATCHES against the raw slots as well as the rendered ' +
    'name, so a member is findable by anything they are stored under. It renders ' +
    'through the resolver.',
  'components/SpaceSettingsModal.tsx':
    'Owns the per-space name EDITOR — it reads your own override into the field ' +
    'and writes it back. This is the one surface that legitimately writes the slot.',
  'components/UnifiedProfileEditModal.tsx':
    'Writes the override as part of saving a profile.',
  'app/(tabs)/messages/dm/[id].tsx':
    'Reads `display_name` off a fetched PUBLIC PROFILE, which is a global name, ' +
    'not a roster override. It feeds the global tier of resolveConversationTitle.',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Does this line read or write the override slot in CODE?
 *
 * Comment lines are excluded deliberately — this area is documented heavily and
 * the field is named constantly in prose. A test that flagged comments would be
 * turned off within a week, which is worse than not having it.
 */
function mentionsOverrideSlotInCode(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return false;
  }
  // `global_display_name` is the GLOBAL slot and is always fine to read.
  return /(?<!global_)display_name/.test(line);
}

describe('no UI file reads the per-space override slot by hand', () => {
  it('finds only files that are allowlisted, with a stated reason', () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const rel = file.split(/[\\/]/).join('/');
        const lines = readFileSync(file, 'utf8').split('\n');
        const hits = lines
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => mentionsOverrideSlotInCode(line));
        if (hits.length === 0) continue;
        if (ALLOWED[rel]) continue;
        offenders.push(`${rel}:${hits.map((h) => h.n).join(',')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An entry left behind after its file stopped touching the slot quietly
    // re-permits the whole file. Catching that keeps the list honest.
    const stale = Object.keys(ALLOWED).filter((rel) => {
      let content: string;
      try {
        content = readFileSync(rel, 'utf8');
      } catch {
        return true; // file moved or deleted — the entry is dead either way
      }
      return !content.split('\n').some(mentionsOverrideSlotInCode);
    });

    expect(stale).toEqual([]);
  });

  it('every allowlist entry states why', () => {
    for (const [rel, reason] of Object.entries(ALLOWED)) {
      expect(reason.length).toBeGreaterThan(40);
      expect(rel).toMatch(/\.tsx?$/);
    }
  });
});
