/**
 * Rewrites `import(x)` to `Promise.resolve().then(() => require(x))`.
 * Applied in the jest environment ONLY — see babel.config.js.
 *
 * Why this exists: the React Native babel preset deliberately leaves `import()`
 * untouched, because Metro turns it into async bundle loading at build time. A
 * jest VM has no Metro, so the call reaches Node's ESM loader and throws
 * "A dynamic import callback was invoked without --experimental-vm-modules".
 *
 * MEASURED 2026-08-17: 93 dynamic-import call sites across 40 files (63 of them
 * awaited), of which 41 sit inside a try/catch. Those 41 are the dangerous ones:
 * the throw is swallowed, so under test the code silently takes its ERROR branch
 * and the suite still reports green. The rest at least fail loudly, and only if
 * a test walks them.
 *
 * MEASURED the same day, by tracing which sites actually execute: exactly ONE of
 * the 93 is reached by the suite (`services/config/configService.ts`, the
 * signature check below). Disabling this transform turns 4 of 1030 tests red,
 * all four on that one site. So the transform's value is not that it repairs
 * existing coverage — it is that it makes the other 92 paths testable at all,
 * and stops the next test written against one of them from passing vacuously.
 * Re-measure with `yarn test:dyn-trace`.
 *
 * The config-blob signature check is the case that surfaced this. Its catch
 * returns `false`, so every test that walked getConfig's adopt path was really
 * exercising "signature invalid" and could never reach the code it named — the
 * first acceptance test written here passed for that reason, not because the
 * behaviour was correct.
 *
 * Written locally rather than pulled in as `@babel/plugin-transform-dynamic-import`,
 * which is not in the tree and is not worth a dependency for twenty lines.
 * `@babel/plugin-transform-modules-commonjs` does NOT cover this: it has no
 * `import(` handling at all, and the transform has lived in its own plugin
 * since Babel 7.5 unified the use cases under `plugin-proposal-dynamic-import`
 * (later renamed `plugin-transform-dynamic-import`). Reaching for the commonjs
 * transform first is the obvious wrong turn here, and it is silent — it applies
 * cleanly and changes nothing.
 *
 * The rewrite is intentionally naive: it does not add ESM interop, because
 * every call site here reads named exports off a module this same jest run
 * already transforms to CommonJS. It also makes `jest.mock()` work on those
 * modules, which is the other half of why the paths were untestable.
 */
const path = require('path');

// Opt-in coverage tracing. Off by default, and read once at module load so the
// emitted code is identical for every file in a run.
//
// Turning the transform on makes these call sites REACHABLE; it does not make
// them covered, and the two are easy to confuse. With the flag set, each rewritten
// site reports itself to `globalThis.__dynImportTrace` when it actually executes,
// so "which of these paths does the suite really walk" becomes a measurement
// instead of a guess. See jest/dynamic-import-trace.js for the collector.
const TRACE = process.env.TRACE_DYNAMIC_IMPORTS === '1';

module.exports = function dynamicImportToRequire({ types: t }) {
  return {
    name: 'dynamic-import-to-require',
    visitor: {
      // `Import` is the callee node of a dynamic `import(...)`, so the parent is
      // the CallExpression carrying the specifier.
      Import(nodePath) {
        const call = nodePath.parentPath;
        if (!call.isCallExpression()) return;

        const requireCall = t.callExpression(t.identifier('require'), call.node.arguments);

        let body = requireCall;
        if (TRACE) {
          const filename = this.file.opts.filename || '<unknown>';
          const rel = path
            .relative(this.file.opts.root || process.cwd(), filename)
            .replace(/\\/g, '/');
          const line = call.node.loc ? call.node.loc.start.line : 0;
          // `globalThis.__dynImportTrace && globalThis.__dynImportTrace('f:l'), require(x)`
          // — a plain `&&` rather than optional chaining, so the emitted code needs
          // no further transform and works whatever the target.
          const traceRef = t.memberExpression(
            t.identifier('globalThis'),
            t.identifier('__dynImportTrace')
          );
          body = t.sequenceExpression([
            t.logicalExpression(
              '&&',
              traceRef,
              t.callExpression(traceRef, [t.stringLiteral(`${rel}:${line}`)])
            ),
            requireCall,
          ]);
        }

        call.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.callExpression(
                t.memberExpression(t.identifier('Promise'), t.identifier('resolve')),
                []
              ),
              t.identifier('then')
            ),
            [t.arrowFunctionExpression([], body)]
          )
        );
      },
    },
  };
};
