const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const mobileNodeModules = path.resolve(__dirname, 'node_modules');

// Honor the "exports" conditional-resolution field. Needed for ESM-only
// transitive deps like multiformats@13 that have no CJS main entry.
config.resolver.unstable_enablePackageExports = true;

// Packages that must resolve to a single instance app-wide. Duplicate
// copies pulled in transitively would break React Context (react,
// @tanstack/react-query) or crash native module registration
// (react-native-safe-area-context's RNCSafeAreaProvider view).
const SINGLE_INSTANCE_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-native',
  '@tanstack/react-query',
  'react-native-safe-area-context',
]);

// Hard-redirect every import of those packages to the mobile project's copy.
// resolveRequest runs after Metro has already done its own walk-up and
// supersedes whatever it would have picked, including any nested copy.
// The fallback to context.resolveRequest preserves Metro's default behavior
// for every other request.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Match either the bare package name ("react") or a deep import
  // ("@tanstack/react-query/persistQueryClient").
  const firstSegment = moduleName.startsWith('@')
    ? moduleName.split('/').slice(0, 2).join('/')
    : moduleName.split('/')[0];

  if (SINGLE_INSTANCE_PACKAGES.has(firstSegment)) {
    const subpath = moduleName.slice(firstSegment.length);
    return context.resolveRequest(
      context,
      path.join(mobileNodeModules, firstSegment + subpath),
      platform,
    );
  }

  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

config.resolver.nodeModulesPaths = [mobileNodeModules];

// Standard nested-node-modules blocklist.
config.resolver.blockList = [
  /node_modules\/quorum-crypto\/node_modules\/.*/,
];

module.exports = config;
