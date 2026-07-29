// react-native replacement for Node.
//
// react-native's entrypoint is untranspiled Flow/ESM, so jest's CJS runner
// cannot load it. Transforming the package instead was the alternative and was
// rejected: it pulls a very large dependency graph through babel to obtain a
// handful of values, and it drags in native-module registration the harness has
// no use for.
//
// Only the surface mobile's non-UI code paths actually reach is provided
// (enumerated by grep over services/, context/, hooks/ — not guessed). The UI
// exports are present as inert placeholders so a module that merely IMPORTS them
// at top level can still load; a scenario that tries to RENDER is out of scope
// for this harness by design.
//
// Behavioural choices worth knowing, because they shape what scenarios observe:
//   - AppState is permanently 'active'. Mobile flushes ratchet state on
//     background; headlessly there is no background, so those paths simply never
//     fire. Backgrounding bugs stay device-only.
//   - InteractionManager runs work immediately instead of deferring past
//     animations. There are no animations here, and deferring would only add
//     nondeterminism to timing-sensitive DM scenarios.

type Listener = (...args: unknown[]) => void;

const noopSubscription = { remove: () => {} };

export const AppState = {
  currentState: 'active' as const,
  addEventListener: (_type: string, _listener: Listener) => noopSubscription,
  removeEventListener: () => {},
};

export type AppStateStatus = 'active' | 'background' | 'inactive';

export const Platform = {
  OS: 'android' as const,
  Version: 34,
  select: <T,>(specifics: { android?: T; ios?: T; native?: T; default?: T }): T | undefined =>
    specifics.android ?? specifics.native ?? specifics.default,
};

export const InteractionManager = {
  // Immediate rather than deferred — see header.
  runAfterInteractions: (task?: () => void) => {
    task?.();
    return { then: (cb: () => void) => cb(), done: () => {}, cancel: () => {} };
  },
  createInteractionHandle: () => 0,
  clearInteractionHandle: () => {},
};

/**
 * Alert must never silently swallow. On a device it is a visible prompt; here a
 * swallowed alert would hide a real error path from the scenario, so surface it.
 */
export const Alert = {
  alert: (title: string, message?: string) => {
    // eslint-disable-next-line no-console
    console.warn(`[harness] Alert.alert: ${title}${message ? ` — ${message}` : ''}`);
  },
};

export const Dimensions = {
  get: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }),
  addEventListener: () => noopSubscription,
};

export const Linking = {
  openURL: async () => {},
  canOpenURL: async () => false,
  addEventListener: () => noopSubscription,
  getInitialURL: async () => null,
};

export const Share = { share: async () => ({ action: 'dismissedAction' }) };

export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  flatten: (style: unknown) => style,
  absoluteFillObject: {},
  hairlineWidth: 1,
};

export const NativeModules: Record<string, unknown> = {};

export const DeviceEventEmitter = {
  addListener: () => noopSubscription,
  emit: () => {},
  removeAllListeners: () => {},
};

export const useColorScheme = () => 'dark' as const;

// --- inert UI placeholders: importable, not renderable (see header) ---
export const View = 'View' as unknown as never;
export const Image = 'Image' as unknown as never;
export const Animated = {
  View: 'Animated.View' as unknown as never,
  Value: class {
    constructor(public value: number) {}
    setValue(v: number) { this.value = v; }
    interpolate() { return this; }
  },
  timing: () => ({ start: (cb?: () => void) => cb?.() }),
  spring: () => ({ start: (cb?: () => void) => cb?.() }),
};
export const PanResponder = { create: () => ({ panHandlers: {} }) };

export default {
  AppState,
  Platform,
  InteractionManager,
  Alert,
  Dimensions,
  Linking,
  Share,
  StyleSheet,
  NativeModules,
  DeviceEventEmitter,
  useColorScheme,
  View,
  Image,
  Animated,
  PanResponder,
};
