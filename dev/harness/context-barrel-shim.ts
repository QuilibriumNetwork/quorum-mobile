// Replacement for mobile's `@/context` barrel.
//
// The barrel re-exports EVERY context, so importing it for one hook drags in all
// of them. useSendDirectMessage — squarely on the DM send path — imports
// `{ useAuth, useWebSocket }` from it, and that single line pulls
// OnboardingContext (→ expo-router, untransformable JSX in node_modules) and the
// two calling contexts (→ WebRTC native modules). None of it is reachable from a
// DM.
//
// So this re-exports the REAL implementations of the three contexts the DM paths
// use, straight from their own modules, and omits the rest. The app code is
// unchanged; only the barrel's breadth is narrowed.
//
// ⚠️ The omitted exports are not silently absent — reaching one throws by name.
// A silent `undefined` would surface later as a confusing "not a function" deep
// inside app code, and a scenario that genuinely needs a call context should say
// so loudly rather than appear to work.
export {
  StorageProvider,
  useStorageAdapter,
} from '@/context/StorageContext';
export {
  AuthProvider,
  useAuth,
  useUser,
  useIsAuthenticated,
} from '@/context/AuthContext';
export type {
  AuthState,
  PrivacyLevel,
  FarcasterInfo,
  UserInfo,
} from '@/context/AuthContext';
export {
  WebSocketProvider,
  useWebSocket,
  useWebSocketConnection,
} from '@/context/WebSocketContext';

function omitted(name: string): never {
  throw new Error(
    `[harness] ${name} is not available: the harness narrows the @/context ` +
      `barrel to the DM contexts (Storage, Auth, WebSocket). ${name} belongs to ` +
      `a UI or calling context whose module graph cannot load in Node. If a ` +
      `scenario genuinely needs it, widen dev/harness/context-barrel-shim.ts ` +
      `and expect to shim its native dependencies.`
  );
}

export const ApiClientProvider = () => omitted('ApiClientProvider');
export const useApiClient = () => omitted('useApiClient');
export const useApiClientContext = () => omitted('useApiClientContext');
export const OnboardingProvider = () => omitted('OnboardingProvider');
export const useOnboarding = () => omitted('useOnboarding');
export const useOnboardingState = () => omitted('useOnboardingState');
export const CallProvider = () => omitted('CallProvider');
export const useCall = () => omitted('useCall');
export const SpaceCallProvider = () => omitted('SpaceCallProvider');
export const useSpaceCall = () => omitted('useSpaceCall');
