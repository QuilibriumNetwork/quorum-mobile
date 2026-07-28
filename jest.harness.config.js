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

    // ---- THE crypto seam ----
    // Swap mobile's uniffi-backed provider for the WASM one. This is the single
    // substitution that lets services/ run unmodified: every call site does a
    // bare `new NativeCryptoProvider()`, so replacing the MODULE replaces the
    // backend with no app change at all.
    //
    // The pattern must catch every spelling in use — './native-provider' from
    // within services/crypto, '../crypto/native-provider' from siblings, and
    // '@/services/crypto/native-provider' from elsewhere. It deliberately does
    // NOT match native-signing-provider, which is a different module.
    '^(.*/)?native-provider$': '<rootDir>/dev/harness/wasm-provider-shim.ts',

    // ---- native modules that cannot exist in Node ----
    // Each is a real device API with no Node equivalent. Swapping them here
    // rather than in app code is what lets mobile's own services/ run unmodified
    // — no #ifdefs, no injection seams, no test-only branches in shipping code.
    // react-native's entrypoint is untranspiled Flow/ESM; jest's CJS runner
    // cannot load it and transforming the package would drag a huge graph
    // through babel for a handful of values.
    '^react-native$': '<rootDir>/dev/harness/react-native-shim.ts',
    '^react-native-mmkv$': '<rootDir>/dev/harness/mmkv-shim.ts',
    '^expo-secure-store$': '<rootDir>/dev/harness/securestore-shim.ts',
    '^expo-sqlite$': '<rootDir>/dev/harness/sqlite-shim.ts',
    // messagesDb imports the /legacy entrypoint; same module either way.
    '^expo-file-system/legacy$': '<rootDir>/dev/harness/filesystem-shim.ts',
    '^expo-file-system$': '<rootDir>/dev/harness/filesystem-shim.ts',
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
    // The two mappings below are lifted from the app's jest.config.js, which hit
    // the same problems loading the shared bundle. Kept verbatim rather than
    // re-derived — if the app's version changes, change this to match.
    //
    // multiformats only exposes an ESM `import` condition for this subpath, so
    // jest's CJS resolver cannot find it; point at the concrete file.
    '^multiformats/bases/base58$':
      '<rootDir>/node_modules/multiformats/dist/src/bases/base58.js',
    // The shared bundle mixes crypto with web-UI, markdown and date utilities
    // that other exports use lazily and the crypto paths never touch — several
    // not even installed here. Stub them so loading the bundle does not require
    // untransformable ESM / web-only packages. The real crypto deps (@noble/*,
    // multiformats, @tanstack/react-query) resolve normally.
    '^(unified|remark-gfm|remark-parse|remark-stringify|strip-markdown|clsx|react-dom|react-dropzone|react-tooltip|@tabler/icons-react)(/.*)?$':
      '<rootDir>/jest/empty-module.js',
  },
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { configFile: path.resolve(__dirname, 'babel.config.js') }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@quilibrium/quorum-shared|multiformats|@noble|bs58|base-x|uint8arrays))',
  ],
};
