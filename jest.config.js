// Jest config for logic/unit tests (no device, no transport).
// Uses the jest-expo preset for RN/Expo module resolution + babel transform.
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  // Disabled to avoid a Watchman named-pipe failure in some local Windows
  // environments (mirrors metro.config.js useWatchman:false). Jest only uses
  // Watchman to speed up file discovery, so turning it off is behavior-safe.
  watchman: false,
  moduleNameMapper: {
    // Resolve quorum-shared to its NON-native build. The native barrel
    // (index.native.js) imports RN native modules (AsyncStorage, etc.) that
    // are null under jest; the pure crypto/auth/permission functions these
    // tests exercise live in the node build with no native deps.
    '^@quilibrium/quorum-shared$':
      '<rootDir>/node_modules/@quilibrium/quorum-shared/dist/index.js',
    // multiformats only exposes an ESM `import` condition for this subpath, so
    // jest's CJS resolver can't find it — point at the concrete file (babel
    // transforms it via transformIgnorePatterns above).
    '^multiformats/bases/base58$':
      '<rootDir>/node_modules/multiformats/dist/src/bases/base58.js',
    // The shared bundle mixes crypto/auth with web-UI, markdown, and date
    // utilities (used lazily by OTHER exports, never on the crypto/auth paths
    // these tests exercise) — several of which aren't even installed in the
    // mobile app. Stub them so loading the bundle doesn't need untransformable
    // ESM / web-only packages. The real crypto deps (@noble/*, multiformats,
    // react/jsx-runtime, @tanstack/react-query) are left to resolve normally.
    // (dayjs is installed + used at module load via dayjs.extend(), so it
    // resolves normally — only its plugins are stubbed if unresolved below.)
    '^(unified|remark-gfm|remark-parse|remark-stringify|strip-markdown|clsx|react-dom|react-dropzone|react-tooltip|@tabler/icons-react)(/.*)?$':
      '<rootDir>/jest/empty-module.js',
  },
  // quorum-shared ships compiled dist but pulls in ESM-only deps (multiformats,
  // @noble/*). Let babel transform them instead of treating them as opaque CJS.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@quilibrium/quorum-shared|multiformats|@noble|bs58|base-x|uint8arrays))',
  ],
};
