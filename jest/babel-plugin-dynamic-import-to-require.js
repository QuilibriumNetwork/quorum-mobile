/**
 * Rewrites `import(x)` to `Promise.resolve().then(() => require(x))`.
 * Applied in the jest environment ONLY — see babel.config.js.
 *
 * Why this exists: the React Native babel preset deliberately leaves `import()`
 * untouched, because Metro turns it into async bundle loading at build time. A
 * jest VM has no Metro, so the call reaches Node's ESM loader and throws
 * "A dynamic import callback was invoked without --experimental-vm-modules".
 *
 * MEASURED 2026-08-17: 64 `await import(...)` call sites across 29 files, of
 * which roughly 24 sit inside a try/catch (crude heuristic — a `try {` within
 * the 20 lines above). Those are the dangerous ones: the throw is swallowed, so
 * under test the code silently takes its ERROR branch and the suite still
 * reports green. The rest at least fail loudly, and only if a test walks them.
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
module.exports = function dynamicImportToRequire({ types: t }) {
  return {
    name: 'dynamic-import-to-require',
    visitor: {
      // `Import` is the callee node of a dynamic `import(...)`, so the parent is
      // the CallExpression carrying the specifier.
      Import(path) {
        const call = path.parentPath;
        if (!call.isCallExpression()) return;

        call.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.callExpression(
                t.memberExpression(t.identifier('Promise'), t.identifier('resolve')),
                []
              ),
              t.identifier('then')
            ),
            [
              t.arrowFunctionExpression(
                [],
                t.callExpression(t.identifier('require'), call.node.arguments)
              ),
            ]
          )
        );
      },
    },
  };
};
