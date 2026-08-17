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

// ── This transform now lives in ONE place ───────────────────────────────────
//
// It used to be defined inline here. The app's jest run needs the identical
// transform for the identical reason, so the implementation moved to
// jest/babel-plugin-dynamic-import-to-require.js and babel.config.js adds it
// under its `test` environment.
//
// ⚠️ Applying it twice is NOT harmless, which is why the guard below is a guard
// and not a tidy-up. Each pass lowers `import(x)` to
// `Promise.resolve().then(() => require(x))`; a second pass over that output
// wraps the arrow again and emits `require(function(){...})`. jest's resolver
// then dies with "moduleName.startsWith is not a function" — inside the
// try/catch that nearly every dynamic-import call site here sits in. So the
// symptom is not a crash: verifyConfigSignature returns false, getConfig
// silently keeps the local config, and a config-sync scenario reports a
// perfectly working protocol as broken. Measured on 2026-08-17, from exactly
// that false conclusion.
//
// The check is by identity rather than by NODE_ENV, so the harness keeps the
// transform even if the app config's env branch stops adding it.
const appConfig = require('../../babel.config.js');
const lowerDynamicImport = require('../../jest/babel-plugin-dynamic-import-to-require.js');

module.exports = function (api) {
  const base = appConfig(api);
  const plugins = base.plugins ?? [];
  if (plugins.includes(lowerDynamicImport)) return base;

  return {
    ...base,
    // Prepended, so the app's own plugin order is preserved — reanimated's
    // plugin must stay last, and it still is.
    plugins: [lowerDynamicImport, ...plugins],
  };
};
