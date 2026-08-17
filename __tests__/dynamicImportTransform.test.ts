/**
 * Guards the jest-only transform that makes `await import(...)` work.
 *
 * ## What breaks without it, and why nothing tells you
 *
 * The React Native babel preset deliberately leaves `import()` alone, because
 * Metro turns it into async bundle loading at build time. A jest VM has no
 * Metro, so the call reaches Node's ESM loader and throws "A dynamic import
 * callback was invoked without --experimental-vm-modules".
 *
 * MEASURED 2026-08-17: 93 dynamic-import call sites across 40 files, 41 of them
 * inside a `try`/`catch`. For those 41 the throw is SWALLOWED — the code under
 * test runs, silently takes its error branch, and the suite still reports green.
 * That is the failure mode this file exists to prevent, and it leaves no symptom
 * at all: deleting the plugin from `babel.config.js` turns no other test red.
 * (MEASURED the same day: with the transform off, 1026 of 1030 tests still pass.)
 *
 * So the guard cannot be "some test somewhere would notice". It has to be a test
 * that asserts the transform is wired, in both directions:
 *   - present under `test`, or every silent call site goes back to lying;
 *   - absent under `development`, or a jest-only workaround ships to production.
 *
 * The config assertions read the EMITTED CODE rather than running anything.
 * That is deliberate: the fault being guarded is one that running tests
 * swallows, so a test that only ran code would inherit the same blind spot.
 */

import { transformSync } from '@babel/core';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');

/** The exact shape of the 41 silent call sites: awaited, inside a try/catch. */
const SNIPPET = `
export async function load() {
  try {
    return await import('./some-module');
  } catch {
    return null;
  }
}
`;

function emit(configFile: string, envName: string): string {
  const result = transformSync(SNIPPET, {
    filename: path.join(ROOT, 'services', 'probe.ts'),
    root: ROOT,
    configFile: path.join(ROOT, configFile),
    babelrc: false,
    envName,
  });
  if (!result?.code) throw new Error(`babel produced no output for ${configFile} @ ${envName}`);
  return result.code;
}

describe('dynamic import transform — the jest-only lowering is wired', () => {
  it('lowers `import()` to `require()` under the test environment', () => {
    const code = emit('babel.config.js', 'test');

    expect(code).toContain("require('./some-module')");
    // No bare `import(` left. Anchored on the call form so the static
    // `import x from` that babel has already rewritten cannot satisfy it.
    expect(code).not.toMatch(/[^.\w$]import\s*\(/);
  });

  it('CONTROL ARM — leaves `import()` alone under the development environment', () => {
    // Without this arm the test above passes just as well if someone drops the
    // `api.env('test')` guard and applies the transform everywhere — which would
    // defeat Metro's code splitting in the shipped app. The two arms together
    // pin the transform to exactly one environment.
    const code = emit('babel.config.js', 'development');

    expect(code).toMatch(/[^.\w$]import\s*\(\s*'\.\/some-module'\s*\)/);
    expect(code).not.toContain("require('./some-module')");
  });

  it('applies the transform exactly once through the harness config', () => {
    // A second pass rewrites the first pass's output and emits
    // `require(function(){...})`, which jest's resolver rejects with
    // "moduleName.startsWith is not a function" — thrown INSIDE the try/catch
    // that nearly every call site sits in, so it surfaces as a working feature
    // reported broken rather than as a crash. That actually happened on
    // 2026-08-17; `babel.harness.js` carries an identity guard because of it.
    const code = emit(path.join('dev', 'harness', 'babel.harness.js'), 'test');

    expect(code).toContain("require('./some-module')");
    expect(code).not.toMatch(/require\(\s*function/);
    expect(code).not.toMatch(/require\(\s*\(/);
  });
});

describe('dynamic import transform — the runtime behaviour it buys', () => {
  it('resolves a try/catch-wrapped `await import()` instead of taking the catch', async () => {
    // Deliberately written in the failing shape rather than as a bare await: a
    // bare await would at least throw loudly, and the whole point is that this
    // shape does not.
    let tookTheCatch = false;
    let loaded: typeof import('../utils/formatAddress') | null = null;
    try {
      loaded = await import('../utils/formatAddress');
    } catch {
      tookTheCatch = true;
    }

    expect(tookTheCatch).toBe(false);
    expect(loaded).not.toBeNull();
    // Reach assertion, not just a shape check — the module really evaluated.
    expect(loaded!.truncateAddress('QmAbcdefghijklmnop', 'short')).toContain('…');
  });

  it('lets `jest.mock()` reach a module loaded through a dynamic import', async () => {
    // The other half of why these paths were untestable: before the transform
    // the module was never routed through jest's registry, so mocking it was
    // impossible and the call site could only ever be exercised via its catch.
    const mod = await import('../modules/quorum-crypto/src');

    expect(await mod.verifyEd448('pk', 'msg', 'sig')).toBe(MOCK_SENTINEL);
  });
});

const MOCK_SENTINEL = 'mocked-by-jest';
jest.mock('../modules/quorum-crypto/src', () => ({
  verifyEd448: jest.fn().mockResolvedValue('mocked-by-jest'),
}));
