// Babel config for the harness jest run ONLY. The app's babel.config.js is
// untouched and is reused verbatim here — this file adds exactly one transform
// on top of it.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// Mobile's DM send path uses lazy `await import(...)` in several places
// (useSendDirectMessage → useRecipientRegistration, sendEncryptedMessageToAllDevices
// → the crypto provider). jest's CJS runtime cannot execute a dynamic import
// without --experimental-vm-modules, and neither babel-preset-expo nor
// @babel/plugin-transform-modules-commonjs lowers it here (measured, not
// assumed: the emitted code still contains a bare `import(...)`).
//
// The alternatives were worse. --experimental-vm-modules switches jest to real
// ESM, which does not coexist well with the moduleNameMapper this harness is
// built on. Adding babel-plugin-dynamic-import-node would mean a new dependency
// and a yarn.lock change in a repo other people build from — a much larger blast
// radius than a local transform for a config nothing else reads.
//
// ⚠️ Limit worth knowing: `require()` returns module.exports where a real
// dynamic import resolves to a module NAMESPACE. For babel-compiled modules with
// named exports — which is every call site on the DM paths — those are the same
// object. A future `const m = await import('x'); m.default(...)` against a true
// ESM package would not be, and would need interop added here.

/** Rewrites `import(x)` into `Promise.resolve().then(() => require(x))`. */
function lowerDynamicImport({ types: t }) {
  return {
    name: 'harness-lower-dynamic-import',
    visitor: {
      Import(path) {
        // The Import node is the callee; its parent is the whole `import(x)`
        // call, which is what has to be replaced.
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
}

const appConfig = require('../../babel.config.js');

module.exports = function (api) {
  const base = appConfig(api);
  return {
    ...base,
    // Prepended, so the app's own plugin order is preserved — reanimated's
    // plugin must stay last, and it still is.
    plugins: [lowerDynamicImport, ...(base.plugins ?? [])],
  };
};
