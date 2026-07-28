// Jest config for the HEADLESS DM HARNESS — a separate runner from the app's
// jest.config.js, which it must never share.
//
// Why separate: the app config uses the jest-expo preset (React Native
// environment, native module mocks). The harness needs the opposite — a plain
// Node environment with real networking and real crypto, because the whole point
// is to run mobile's client code with nothing about it faked.
//
// Why the app config never picks these files up: its testMatch is
// `**/__tests__/**/*.test.ts` + `**/*.test.ts`. Harness scenarios are named
// `*.scenario.ts`, which matches neither. `yarn test` is untouched by design —
// no testPathIgnorePatterns edit, no risk of collecting these under the wrong
// setup. Keep the naming; it is load-bearing, not cosmetic.
const path = require('path');

// The SDK is NOT a mobile dependency and must not become one. The app uses the
// Rust channel crate through uniffi (libchannel.so, ARM machine code) — it has
// never needed the wasm build. Node cannot load that .so, so the harness needs
// the crate's OTHER binding, the wasm one, which ships in the SDK package.
// Resolved from the sibling desktop checkout so mobile's package.json and
// yarn.lock stay untouched. Same convention as desktop's own harness, which
// already resolves the wasm binary from a sibling repo.
const SDK = path.resolve(
  __dirname,
  '../quorum-desktop/node_modules/@quilibrium/quilibrium-js-sdk-channels'
);

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/dev/harness/**/*.scenario.ts'],
  // Same Windows named-pipe failure the app's jest.config.js works around, and
  // for the same reason: Watchman only speeds up file discovery, so disabling it
  // is behaviour-safe. Without this the runner dies before collecting anything.
  watchman: false,
  // Evaluates before the test module, so the browser-globals shim is guaranteed
  // to land before the SDK bundle assigns `window.Buffer` at import time.
  // Without it every scenario dies with "window is not defined".
  setupFiles: ['<rootDir>/dev/harness/shim.ts'],
  // Scenarios talk to a live relay; the default 5s kills them mid-handshake.
  testTimeout: 4 * 60 * 60 * 1000,
  moduleNameMapper: {
    // Mobile's tsconfig path alias, spelled out for jest.
    '^@/(.*)$': '<rootDir>/$1',
    '^@quilibrium/quilibrium-js-sdk-channels$': SDK,
    // SDK is reached via desktop's node_modules, which on this machine is a
    // yarn-link SYMLINK to the SDK source checkout — and that checkout has no
    // node_modules of its own. So the SDK's own runtime deps cannot resolve
    // relative to it and must be pulled from mobile's tree instead.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
    // The NODE build of shared, not index.native.js — the native barrel imports
    // RN modules (AsyncStorage et al) that are null outside a device. Same
    // reasoning the app's jest.config.js already documents.
    '^@quilibrium/quorum-shared$':
      '<rootDir>/node_modules/@quilibrium/quorum-shared/dist/index.js',
  },
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { configFile: path.resolve(__dirname, 'babel.config.js') }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@quilibrium/quorum-shared|multiformats|@noble|bs58|base-x|uint8arrays))',
  ],
};
