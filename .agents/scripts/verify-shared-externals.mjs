// verify-shared-externals.mjs
//
// After link-local-shared.ps1 swaps node_modules/@quilibrium/quorum-shared for a
// local build, check that every DECLARED dependency the shared bundle still
// imports at runtime can actually be resolved from the swapped-in directory.
//
// Why this exists: the shared dist externalizes its deps (it does not bundle
// them). The npm-installed package ships a NESTED node_modules holding the exact
// versions shared needs; a copy that only brings package.json + dist/ drops that
// tree, so those imports fall through to mobile's hoisted copies. When a hoisted
// version differs by a major, resolution breaks. Live example (2026-08-01):
// shared imports "@noble/hashes/sha2", which exists in the nested 1.8.0 but NOT
// in mobile's hoisted 2.0.1 (2.x only exports "./sha2.js") -> Metro bundle fails
// with ERR_PACKAGE_PATH_NOT_EXPORTED.
//
// Only shared's own declared `dependencies` are checked. Host-provided externals
// (react, react-native, expo-*, @tabler/*) are deliberately skipped: they are
// mobile's to supply, and Node cannot resolve RN packages the way Metro does, so
// checking them would produce false alarms.
//
// Usage: node .agents/scripts/verify-shared-externals.mjs [pkgDir]

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const pkgDir =
  process.argv[2] ||
  path.resolve(process.cwd(), 'node_modules/@quilibrium/quorum-shared');

if (!existsSync(path.join(pkgDir, 'package.json'))) {
  console.error(`ERROR: no package.json at ${pkgDir}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));

const distDir = path.join(pkgDir, 'dist');
if (!existsSync(distDir)) {
  console.error(`ERROR: no dist/ at ${pkgDir} — run a build in quorum-shared`);
  process.exit(1);
}

// Metro takes the "react-native" entry; check the others too so a partial build
// (tsup can leave dist half-written between runs) is caught here rather than at
// bundle time.
const entries = ['index.native.js', 'index.js', 'index.mjs'].filter((f) =>
  existsSync(path.join(distDir, f)),
);
if (entries.length === 0) {
  console.error(`ERROR: dist/ has no index entries — stale or partial build`);
  process.exit(1);
}
const missingNative = !existsSync(path.join(distDir, 'index.native.js'));

const packageNameOf = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

const specs = new Set();
for (const entry of entries) {
  const src = readFileSync(path.join(distDir, entry), 'utf8');
  for (const m of src.matchAll(/(?:require\(|from\s*)["']([^"'.][^"']*)["']/g)) {
    if (declared.has(packageNameOf(m[1]))) specs.add(m[1]);
  }
}

// Walk up from dist/ the way a resolver would, to find which copy of a package
// would actually be picked: shared's own nested tree, or mobile's hoisted one.
function findPackageDir(pkgName, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkgName);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Node's CJS loader rejects an import-only subpath (multiformats@13 is ESM-only),
// but Metro resolves it fine — metro.config.js sets unstable_enablePackageExports
// and Metro honours the "import" condition. So a require.resolve() failure is only
// a REAL failure when the subpath is absent from the exports map entirely, which
// is the wrong-major case this script exists to catch.
function subpathIsExported(pkgDirOfDep, subpath) {
  const exp = JSON.parse(
    readFileSync(path.join(pkgDirOfDep, 'package.json'), 'utf8'),
  ).exports;
  if (exp == null) return true; // no exports map: classic resolution, nothing gated
  if (typeof exp === 'string') return subpath === '.';
  const keys = Object.keys(exp);
  if (!keys.some((k) => k.startsWith('.'))) return subpath === '.'; // conditions-only map
  if (keys.includes(subpath)) return true;
  return keys.some((k) => {
    if (!k.includes('*')) return false;
    const [head, tail] = k.split('*');
    return subpath.startsWith(head) && subpath.endsWith(tail);
  });
}

const requireFromDist = createRequire(path.join(distDir, 'index.native.js'));
const nestedMarker = path.join('quorum-shared', 'node_modules');
const failures = [];

for (const spec of [...specs].sort()) {
  const pkgName = packageNameOf(spec);
  const depDir = findPackageDir(pkgName, distDir);
  const where = depDir?.includes(nestedMarker) ? 'nested' : 'hoisted';

  if (!depDir) {
    failures.push({ spec, message: `package "${pkgName}" not found in any node_modules` });
    console.log(`  FAIL  ${spec}  (package missing)`);
    continue;
  }

  try {
    requireFromDist.resolve(spec);
    console.log(`  OK    ${spec}  (${where})`);
    continue;
  } catch (err) {
    const subpath = spec === pkgName ? '.' : `./${spec.slice(pkgName.length + 1)}`;
    if (err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' && subpathIsExported(depDir, subpath)) {
      // Present in the map, just not under a CJS condition — Metro takes it.
      console.log(`  OK    ${spec}  (${where}, ESM-only subpath — Metro resolves it)`);
      continue;
    }
    failures.push({ spec, code: err.code, message: err.message.split('\n')[0], where });
    console.log(`  FAIL  ${spec}  ${err.code}  (would resolve against the ${where} copy)`);
  }
}

const hasNested = existsSync(path.join(pkgDir, 'node_modules'));
console.log(
  `\n  checked ${specs.size} declared-dependency import(s) across ${entries.join(', ')}`,
);
console.log(`  nested node_modules present: ${hasNested ? 'yes' : 'NO'}`);

if (missingNative) {
  console.error(
    `\nERROR: dist/index.native.js is missing — that is the entry Metro uses.\n` +
      `       Run a full 'yarn build' in quorum-shared and re-link.`,
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\nERROR: ${failures.length} import(s) do not resolve:`);
  for (const f of failures) console.error(`  ${f.spec}: ${f.message}`);
  console.error(
    `\nMetro will fail the bundle on these. Most likely cause: the copy dropped\n` +
      `shared's nested node_modules, so its deps fell through to mobile's hoisted\n` +
      `(different-major) copies. Re-run link-local-shared.ps1 -Copy from a state\n` +
      `where the npm backup exists (run 'yarn install' first if it does not).`,
  );
  process.exit(1);
}

console.log('\nAll declared-dependency imports resolve. Safe to bundle.');
