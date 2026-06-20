// Regenerates components/ui/tablerIconRegistry.ts.
//
// Why this exists: importing the @tabler/icons-react-native barrel pulls all
// ~6000 icons into every Metro bundle (no dev tree-shaking), inflating each
// route to ~14k modules and OOM-crashing the dev server. The registry
// deep-imports ONLY the icons we actually use.
//
// TWO sources feed the registry — keep BOTH or the channel icon picker blanks:
//   1. Every `IconXxx` token literally referenced in components/ui/IconSymbol.tsx
//      (the SF_TO_TABLER table + any direct references).
//   2. The shared channel/group icon-picker vocabulary (`ICON_OPTIONS` +
//      `FILLED_ICONS` in @quilibrium/quorum-shared). The picker renders those
//      SEMANTIC names (e.g. `robot`, `leaf`), which IconSymbol resolves to a
//      Tabler component at RUNTIME via its SF_TO_TABLER map or a PascalCase
//      fallback (`robot` -> IconRobot). Those names never appear as `IconXxx`
//      tokens in source, so source-scraping alone (source 1) MISSES them and
//      the picker shows blank cells. We resolve the vocabulary here with the
//      SAME logic IconSymbol uses, so "the picker can offer it" always implies
//      "the registry contains it" — including filled variants.
//
// Run after changing IconSymbol's map OR when shared's picker vocabulary grows:
//   node scripts/gen-tabler-registry.mjs   (or: npm run gen:icons)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'components/ui/IconSymbol.tsx');
const OUT = path.join(root, 'components/ui/tablerIconRegistry.ts');
const ICONS_DIR = path.join(root, 'node_modules/@tabler/icons-react-native/dist/esm/icons');
const VOCAB = path.join(
  root,
  'node_modules/@quilibrium/quorum-shared/src/primitives/Icon/pickerVocabulary.ts',
);

// The set of Tabler component names that actually exist in the installed package.
const have = new Set(
  fs
    .readdirSync(ICONS_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.map'))
    .map((f) => f.replace(/\.mjs$/, '')),
);

const src = fs.readFileSync(SRC, 'utf8');
const names = new Set();

// --- Source 1: every IconXxx token referenced in IconSymbol.tsx ---------------
for (const m of src.matchAll(/\bIcon[A-Za-z0-9]+\b/g)) {
  if (have.has(m[0])) names.add(m[0]);
}

// --- Resolution helpers, mirroring IconSymbol.tsx's resolveTablerComponent -----
// Parse the SF_TO_TABLER / picker-vocabulary entries:  'name': tabler('IconBase'[, 'IconFilled']),
const sfToTabler = {};
for (const m of src.matchAll(
  /'([a-z0-9.\-]+)':\s*tabler\('(Icon[A-Za-z0-9]+)'(?:\s*,\s*'(Icon[A-Za-z0-9]+)')?\)/g,
)) {
  const [, key, base, filled] = m;
  if (!(key in sfToTabler)) sfToTabler[key] = { base, filled };
}

function pascalCase(s) {
  return s
    .split(/[-.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// Resolve a semantic name to its OUTLINE Tabler component, the same way
// IconSymbol does: SF_TO_TABLER base, else `Icon${PascalCase}`.
function resolveBase(name) {
  const entry = sfToTabler[name];
  if (entry) return entry.base;
  return `Icon${pascalCase(name)}`;
}

// Resolve a semantic name to its FILLED Tabler component (if any): SF_TO_TABLER's
// explicit `filled`, else `${base}Filled`. Returns null when no filled form exists.
function resolveFilled(name) {
  const entry = sfToTabler[name];
  if (entry && entry.filled) return entry.filled;
  const base = resolveBase(name);
  return `${base}Filled`;
}

// --- Source 2: the shared icon-picker vocabulary ------------------------------
// Read pickerVocabulary.ts SOURCE directly (not via require — the package's ESM
// exports map can't be loaded by a plain Node script, confirmed 2026-06-20).
const missingFromPackage = [];
if (fs.existsSync(VOCAB)) {
  const vocab = fs.readFileSync(VOCAB, 'utf8');

  // ICON_OPTIONS entries:  { name: 'robot', tier: 5, category: 'Sci-Fi' },
  const optionNames = [...vocab.matchAll(/name:\s*'([a-z0-9.\-]+)'/g)].map((m) => m[1]);
  // FILLED_ICONS set members (semantic names whose filled form the picker renders).
  const filledBlock = (vocab.match(/FILLED_ICONS[^[]*\[([\s\S]*?)\]/) || [])[1] || '';
  const filledNames = [...filledBlock.matchAll(/'([a-z0-9.\-]+)'/g)].map((m) => m[1]);

  for (const name of optionNames) {
    const base = resolveBase(name);
    if (have.has(base)) names.add(base);
    else missingFromPackage.push(`${name} -> ${base} (outline)`);
  }
  for (const name of filledNames) {
    const filled = resolveFilled(name);
    if (have.has(filled)) names.add(filled);
    else missingFromPackage.push(`${name} -> ${filled} (filled)`);
  }
} else {
  console.warn(
    `WARNING: shared picker vocabulary not found at\n  ${VOCAB}\n` +
      `Registry built from IconSymbol.tsx only — picker icons may render blank. ` +
      `Is @quilibrium/quorum-shared installed?`,
  );
}

const sorted = [...names].sort();

const header = `/**
 * tablerIconRegistry — GENERATED. Do not edit by hand.
 *
 * Explicit deep-imports of ONLY the Tabler icons the app can render. Built from
 * TWO sources (see scripts/gen-tabler-registry.mjs):
 *   1. every IconXxx token referenced in components/ui/IconSymbol.tsx, and
 *   2. the shared channel-icon-picker vocabulary (ICON_OPTIONS + FILLED_ICONS),
 *      resolved through IconSymbol's runtime logic so picker cells never blank.
 *
 * IconSymbol previously imported the whole @tabler/icons-react-native barrel
 * (~6000 icons), which Metro can't tree-shake in dev — every route bundled
 * ~14k modules and OOM-crashed the dev server. This keeps the graph small.
 *
 * Regenerate after changing IconSymbol's map OR when the shared picker
 * vocabulary grows:
 *   node scripts/gen-tabler-registry.mjs   (npm run gen:icons)
 *
 * Names not listed here resolve to null in IconSymbol (its documented
 * "unknown names render null" behavior).
 */

`;
const imports = sorted.map((n) => `import ${n} from '@tabler/icons-react-native/${n}';`).join('\n');
const registry = `export const TablerIcons = {\n${sorted.map((n) => `  ${n},`).join('\n')}\n};\n`;

fs.writeFileSync(OUT, header + imports + '\n\n' + registry);
console.log(`Wrote ${path.relative(root, OUT)} with ${sorted.length} icons.`);

// Surface any picker name that resolved to a Tabler component NOT present in the
// installed package — those would still blank. (Expected: none. If this prints,
// the name needs an explicit SF_TO_TABLER mapping in IconSymbol.tsx.)
if (missingFromPackage.length) {
  console.warn(
    `\nWARNING: ${missingFromPackage.length} picker icon(s) resolved to a Tabler ` +
      `component that does NOT exist in @tabler/icons-react-native — these will ` +
      `render blank until given an explicit mapping in IconSymbol.tsx:\n` +
      missingFromPackage.map((x) => `  ${x}`).join('\n'),
  );
}
