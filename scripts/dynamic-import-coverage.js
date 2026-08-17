#!/usr/bin/env node
/**
 * Answers "which dynamic `import(...)` call sites does the test suite actually
 * walk, and which have never executed once".
 *
 * Usage:
 *   yarn test:dyn-trace          run the suite with tracing on, then report
 *   node scripts/dynamic-import-coverage.js        report on existing trace data
 *   node scripts/dynamic-import-coverage.js --json machine-readable
 *
 * The traced run writes `.dyn-import-trace/<pid>.jsonl` (see
 * jest/dynamic-import-trace.js); this script joins that against a static scan of
 * every call site in the app source and prints the covered / uncovered split.
 *
 * `--run` drives jest itself rather than leaving that to a package script,
 * because the env var and `--no-cache` both have to be set together and neither
 * is optional: jest keys its transform cache on the babel config, which does not
 * change when TRACE_DYNAMIC_IMPORTS does, so a cached run silently reports zero
 * coverage. Doing it here also keeps the repo free of cross-env and rimraf,
 * which are not currently dependencies.
 *
 * ## Why the static half is a regex and not a parser
 *
 * It only has to find `import(` outside comments and strings, which a blanking
 * pass does reliably; nothing downstream depends on the AST. The runtime half is
 * the authoritative one — a site is "covered" because it was OBSERVED to run,
 * never because this file decided it should be reachable.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIRS = ['app', 'components', 'context', 'hooks', 'services', 'modules', 'utils'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Blank comments and string bodies in place, preserving offsets and newlines. */
function blankNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === q) break;
        if (q !== '`' && src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function scanSites() {
  const sites = [];
  for (const file of SRC_DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
    const raw = fs.readFileSync(file, 'utf8');
    const src = blankNonCode(raw);
    const re = /(^|[^.\w$])import\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const idx = m.index + m[1].length;
      const line = src.slice(0, idx).split('\n').length;
      const spec = (raw.slice(idx).match(/^import\s*\(\s*([^)]*)\)/) || [, '?'])[1]
        .trim()
        .replace(/\s+/g, ' ');

      // Enclosing try/catch — the sites whose failure is SILENT.
      let depth = 0;
      let inTry = false;
      for (let i = idx; i >= 0; i--) {
        const c = src[i];
        if (c === '}') depth++;
        else if (c === '{') {
          if (depth === 0) {
            if (/\btry\s*$/.test(src.slice(Math.max(0, i - 40), i))) {
              inTry = true;
              break;
            }
          } else depth--;
        }
      }
      sites.push({
        site: `${path.relative(ROOT, file).replace(/\\/g, '/')}:${line}`,
        spec,
        inTry,
      });
    }
  }
  return sites;
}

function readTrace() {
  const dir = path.join(ROOT, '.dyn-import-trace');
  const hits = new Map();
  if (!fs.existsSync(dir)) return hits;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (!hits.has(rec.site)) hits.set(rec.site, []);
      hits.get(rec.site).push(rec);
    }
  }
  return hits;
}

if (process.argv.includes('--run')) {
  const { spawnSync } = require('child_process');
  fs.rmSync(path.join(ROOT, '.dyn-import-trace'), { recursive: true, force: true });
  // jest's own entry point run under this node, rather than `npx jest` — an npx
  // spawn on Windows needs a shell and fails silently without one, which looks
  // exactly like "the suite covers nothing".
  //
  // Resolved as a plain path, not via require.resolve: `jest` declares an
  // `exports` map that does not list `./bin/jest.js`, so require.resolve throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED even though the file is right there.
  const jestBin = [
    path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
    path.join(ROOT, 'node_modules', 'jest-cli', 'bin', 'jest.js'),
  ].find((p) => fs.existsSync(p));
  if (!jestBin) {
    console.error('Could not find jest. Run `yarn install` first.');
    process.exit(1);
  }
  const jest = spawnSync(
    process.execPath,
    // Remaining args pass through to jest, so `yarn test:dyn-trace configPublish`
    // traces one file. Our own flags are stripped first.
    [jestBin, '--no-cache', ...process.argv.slice(2).filter((a) => a !== '--run' && a !== '--json')],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TRACE_DYNAMIC_IMPORTS: '1' } }
  );
  if (jest.error) {
    console.error('Could not start jest:', jest.error.message);
    process.exit(1);
  }
  // A non-zero exit is NOT fatal here: a failing test still produces valid trace
  // data, and the coverage answer is the point of the run. Exiting would throw
  // away the measurement over an unrelated red test.
  if (jest.status !== 0) console.log('\n(jest exited non-zero — report below is still valid)\n');
}

const sites = scanSites();
const hits = readTrace();
const covered = sites.filter((s) => hits.has(s.site));
const uncovered = sites.filter((s) => !hits.has(s.site));
const orphanHits = [...hits.keys()].filter((k) => !sites.some((s) => s.site === k));

const asJson = process.argv.includes('--json');
if (asJson) {
  console.log(JSON.stringify({ sites, covered, uncovered, orphanHits, hits: [...hits] }, null, 2));
  process.exit(0);
}

console.log(`Dynamic import call sites: ${sites.length} (${sites.filter((s) => s.inTry).length} inside a try/catch)`);
console.log(`Covered by the suite:      ${covered.length}`);
console.log(`Never executed:            ${uncovered.length}`);
if (hits.size === 0) {
  console.log('\nNo trace data. Run: TRACE_DYNAMIC_IMPORTS=1 yarn test');
  process.exit(0);
}

console.log('\n=== COVERED — these paths really run, so the pre-fix error branch was live ===');
for (const s of covered) {
  console.log(`\n${s.site}  ${s.inTry ? '[silent: in try/catch]' : '[loud]'}  import(${s.spec})`);
  const byTest = new Map();
  for (const h of hits.get(s.site)) byTest.set(`${h.path} > ${h.test}`, true);
  for (const label of [...byTest.keys()].sort()) console.log(`    ${label}`);
}

if (orphanHits.length) {
  console.log('\n=== TRACED BUT NOT IN THE STATIC SCAN (scan gap — investigate) ===');
  for (const o of orphanHits) console.log(`  ${o}`);
}

console.log('\n=== NEVER EXECUTED under any test ===');
for (const s of uncovered) {
  console.log(`  ${s.site}  ${s.inTry ? '[silent]' : '[loud] '}  import(${s.spec})`);
}
