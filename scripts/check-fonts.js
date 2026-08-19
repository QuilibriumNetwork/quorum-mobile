#!/usr/bin/env node
/**
 * Guards the two font mistakes that are invisible in review and invisible in
 * tests, but obvious on a device — and which both shipped during the Inter
 * migration before this check existed.
 *
 *   1. ORPHAN WEIGHT — a style block sets `fontWeight` with no `fontFamily`.
 *      Harmless while the app used the platform font, because the OS resolved
 *      the weight against whatever it was already drawing. With a bundled font
 *      it means that one block silently stays on the DEVICE font while
 *      everything around it is Inter. The result is two typefaces inside the
 *      same card, which reads as "something looks off" rather than as an
 *      obvious bug.
 *
 *   2. CROSSED PAIR — `fontFamily` names one face and `fontWeight` names a
 *      different one, e.g. the medium family asked for weight 700. Each
 *      bundled face is a separate file carrying its own weight, so this asks
 *      the platform to synthesize the difference. Android obliges with smeared
 *      faux-bold.
 *
 * Neither is a type error and neither fails a unit test: both are only
 * detectable by looking at pixels, which is exactly why they need a static
 * check. Run via `yarn check:fonts`.
 *
 * Deliberately a text scan rather than an AST pass: style objects here are
 * plain literals inside `StyleSheet.create` / `createStyles(theme)`, the shape
 * is highly regular, and a regex-level check has no build step and no parser
 * version to keep in sync. If style authoring ever stops being literal, this
 * should become an ESLint rule instead.
 */

const fs = require('fs');
const path = require('path');

const ROOTS = ['components', 'app', 'theme'];
const EXTS = new Set(['.ts', '.tsx']);

/** Weight each `theme.fonts.<key>` face actually carries. */
const FACE_WEIGHT = {
  regular: '400',
  medium: '500',
  semiBold: '600',
  bold: '700',
  heavy: '900',
};

/** `fontWeight` values that are aliases rather than numbers. */
const WEIGHT_ALIAS = { normal: '400', bold: '700' };

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve a `fontWeight:` right-hand side to a numeric weight, or null when it
 * can't be resolved statically (a ternary, a variable) — unresolvable is not a
 * failure, it just isn't checkable.
 */
function resolveWeight(raw) {
  const viaToken = raw.match(/theme\.fonts\.([a-zA-Z]+)\??\.fontWeight/);
  if (viaToken) return FACE_WEIGHT[viaToken[1]] ?? null;
  const literal = raw.match(/['"]([a-zA-Z0-9]+)['"]/);
  if (!literal) return null;
  const v = literal[1];
  return WEIGHT_ALIAS[v] ?? (/^\d{3}$/.test(v) ? v : null);
}

function checkFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const problems = [];

  let open = null;
  let buf = [];
  let startLine = 0;

  const flush = () => {
    if (!open) return;
    const block = buf.join('\n');
    const hasWeight = /fontWeight:/.test(block);
    if (hasWeight) {
      // A spread of the semantic scale supplies both family and weight.
      const spreadsToken = /\.\.\.\s*theme\.textStyles\./.test(block);
      const famMatch = block.match(/fontFamily:\s*([^,\n]+)/);
      if (!famMatch && !spreadsToken) {
        problems.push({
          line: startLine,
          name: open,
          kind: 'orphan-weight',
          detail: 'sets fontWeight with no fontFamily — will render in the device font',
        });
      } else if (famMatch) {
        const famToken = famMatch[1].match(/theme\.fonts\.([a-zA-Z]+)\??\.fontFamily/);
        const weightRaw = block.match(/fontWeight:\s*([^,\n]+)/)[1];
        const want = famToken ? FACE_WEIGHT[famToken[1]] : null;
        const got = resolveWeight(weightRaw);
        if (want && got && want !== got) {
          problems.push({
            line: startLine,
            name: open,
            kind: 'crossed-pair',
            detail: `family "${famToken[1]}" is weight ${want} but fontWeight is ${got} — forces faux-bold`,
          });
        }
      }
    }
    open = null;
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const m = line.match(/^\s*([a-zA-Z0-9_]+)\s*:\s*\{\s*$/);
      if (m) {
        open = m[1];
        startLine = i + 1;
        buf = [];
      }
      continue;
    }
    if (/^\s*\},?\s*$/.test(line)) {
      flush();
      continue;
    }
    // A nested object means this isn't a flat style block; stop tracking it
    // rather than guess where it ends.
    if (/\{\s*$/.test(line)) {
      open = null;
      buf = [];
      continue;
    }
    buf.push(line);
  }

  return problems;
}

const files = ROOTS.filter(fs.existsSync).flatMap((r) => walk(r));
const all = [];
for (const f of files) {
  for (const p of checkFile(f)) all.push({ file: f, ...p });
}

if (all.length === 0) {
  console.log(`✔ check:fonts — ${files.length} files, no orphan weights or crossed family/weight pairs`);
  process.exit(0);
}

const orphans = all.filter((p) => p.kind === 'orphan-weight');
const crossed = all.filter((p) => p.kind === 'crossed-pair');

console.error(`✖ check:fonts — ${all.length} problem(s) in ${files.length} files\n`);
for (const [label, list] of [
  ['ORPHAN WEIGHT (renders in the device font, not the bundled one)', orphans],
  ['CROSSED PAIR (family and weight name different faces — faux-bold)', crossed],
]) {
  if (!list.length) continue;
  console.error(`${label}: ${list.length}`);
  for (const p of list) console.error(`  ${p.file}:${p.line}  ${p.name} — ${p.detail}`);
  console.error('');
}
console.error('Fix by adding the matching `fontFamily: theme.fonts.<face>.fontFamily`,');
console.error('or by spreading a semantic token (`...theme.textStyles.body`), which');
console.error('carries family, weight, size and line height together.');
process.exit(1);
