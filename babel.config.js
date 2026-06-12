module.exports = function (api) {
  api.cache(true);
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
