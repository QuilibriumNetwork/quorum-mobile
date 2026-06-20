// Regenerates components/ui/tablerIconRegistry.ts from the icon names
// referenced in components/ui/IconSymbol.tsx.
//
// Why this exists: importing the @tabler/icons-react-native barrel pulls all
// ~6000 icons into every Metro bundle (no dev tree-shaking), inflating each
// route to ~14k modules and OOM-crashing the dev server. The registry
// deep-imports ONLY the icons we use.
//
// Run after adding/removing an icon in IconSymbol's SF_TO_TABLER map:
//   node scripts/gen-tabler-registry.mjs   (or: npm run gen:icons)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'components/ui/IconSymbol.tsx');
const OUT = path.join(root, 'components/ui/tablerIconRegistry.ts');
const ICONS_DIR = path.join(root, 'node_modules/@tabler/icons-react-native/dist/esm/icons');

const have = new Set(
  fs
    .readdirSync(ICONS_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.map'))
    .map((f) => f.replace(/\.mjs$/, '')),
);

const src = fs.readFileSync(SRC, 'utf8');
const names = new Set();
for (const m of src.matchAll(/\bIcon[A-Za-z0-9]+\b/g)) {
  if (have.has(m[0])) names.add(m[0]);
}
const sorted = [...names].sort();

const header = `/**
 * tablerIconRegistry — GENERATED. Do not edit by hand.
 *
 * Explicit deep-imports of ONLY the Tabler icons IconSymbol.tsx references.
 * IconSymbol previously imported the whole @tabler/icons-react-native barrel
 * (~6000 icons), which Metro can't tree-shake in dev — every route bundled
 * ~14k modules and OOM-crashed the dev server. This keeps the graph small.
 *
 * Regenerate after changing IconSymbol's icon map:
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
