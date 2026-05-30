/**
 * Custom entry point.
 *
 * expo-router's default entry (`expo-router/entry`) eagerly requires every
 * file under app/ via require.context to build the route tree. That means
 * individual route files (and their transitive imports like @solana/web3.js,
 * @polkadot/api, bitcoinjs-lib, etc. — all of which poke at `global.Buffer`
 * at module-evaluation time) get loaded in an order we don't control.
 *
 * Polyfills MUST land on the global before any of those modules evaluate, so
 * we install them here and only then hand control to expo-router.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./services/polyfills/buffer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('react-native-get-random-values');

// Register background-task handlers BEFORE the route tree loads. expo-task-manager
// looks up handlers immediately on bridge init when iOS BGTaskScheduler or
// Android WorkManager fires a registered task. If `defineTask` runs later
// (e.g. as a side-effect of _layout.tsx, which only evaluates after
// expo-router/entry builds its route tree), the OS wakes the app, finds no
// handler, and silently terminates — no notification, no error, no log.
// Importing here guarantees the side-effect runs before any expo-router
// machinery, so the handler is in place when the OS dispatches.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./services/notifications/backgroundTask');
// Same rationale as backgroundTask: the silent-push task handler must be
// defined before any code can dispatch to it, so we register it here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./services/notifications/pushReceivedTask');

// LiveKit (audio spaces) is the official web SDK + a thin WebRTC
// global shim. The shim has to land before any module touches
// `livekit-client`, otherwise its `new RTCPeerConnection()` calls bail.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./services/spaces/livekitPolyfill').installLivekitWebrtcPolyfill();

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('expo-router/entry');
