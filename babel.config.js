module.exports = function (api) {
  // Keyed on the environment rather than cached forever, because the config is
  // no longer identical across environments — see the jest-only plugin below.
  // `api.env()` configures the cache itself, which is why `api.cache(true)` is
  // gone; keeping both is a babel error.
  const isTest = api.env('test');

  return {
    presets: [
      [
        'babel-preset-expo',
        {
          unstable_transformImportMeta: true,
        },
      ],
    ],
    plugins: [
      // Makes `await import(...)` reachable under jest, where there is no Metro
      // to resolve it. Without this every such call site throws — 64 of them
      // across 29 files — and the ones sitting inside a try/catch swallow it
      // and take their error branch while the suite still reports green. Full
      // rationale in the plugin file.
      ...(isTest ? ['./jest/babel-plugin-dynamic-import-to-require.js'] : []),
      // Reanimated plugin must remain last.
      'react-native-reanimated/plugin',
    ],
    // @polkadot/* ships untranspiled ES2022 class syntax that Hermes rejects.
    // babel-preset-expo doesn't lower it, so do it here, scoped to the
    // @polkadot packages only. (Applying to all of node_modules breaks
    // TS-source packages like expo-file-system, whose `declare` fields must
    // be transformed by the TypeScript plugin before these class plugins run.)
    overrides: [
      {
        test: /node_modules[\\/]@polkadot[\\/]/,
        plugins: [
          '@babel/plugin-transform-class-static-block',
          '@babel/plugin-transform-class-properties',
          '@babel/plugin-transform-private-methods',
          '@babel/plugin-transform-private-property-in-object',
        ],
      },
    ],
  };
};
