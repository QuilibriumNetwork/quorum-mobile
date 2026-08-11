/**
 * Native-module stubs, so a test can render a REAL screen.
 *
 * ## The problem this solves
 *
 * A function-level test imports one pure module and hand-stubs whatever that
 * module happens to touch. A render test cannot: mounting a real screen walks
 * its real import graph, and several third-party packages reach for a native
 * binary at IMPORT time. Under jest there is no binary, so the suite dies
 * before the first assertion — not with a wrong answer, but with
 * "doesn't seem to be linked".
 *
 * Each entry below is a package that actually blocked a render, added one at a
 * time as it did. This is not a precautionary list; do not add to it
 * speculatively. If a package here stops being needed, delete it — a stub for a
 * module nobody imports is a small lie about what the app depends on.
 *
 * ## Official mocks are preferred over hand-written ones
 *
 * Both entries here ship a mock maintained by the package itself, so they track
 * the real API when it changes. A hand-written stub of somebody else's module is
 * a second implementation to keep in step, and it fails in the worst way: the
 * test keeps passing against a shape the real library no longer has.
 *
 * `react-native-mmkv` is the exception and is stubbed by hand in
 * `__mocks__/react-native-mmkv.js` — it ships no jest mock, and the reason it
 * lives there rather than here is explained in that file.
 *
 * ## Why setupFilesAfterEnv rather than setupFiles
 *
 * `jest-expo`'s preset owns `setupFiles`, and setting that key would REPLACE the
 * preset's list rather than extend it — silently removing React Native's own
 * test bootstrap. `setupFilesAfterEnv` is unused by the preset, runs before the
 * test file's imports are evaluated, and so registers these mocks in time.
 */

// Reanimated's own mock. Animations resolve instantly instead of driving the
// UI thread, which is what a render test wants: assert the end state, not a
// frame of the transition.
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

// Reaches NativeEventEmitter at import time, so it throws on require, not on
// use — meaning even a screen that never shows a keyboard is affected.
jest.mock(
  'react-native-keyboard-controller',
  () => require('react-native-keyboard-controller/jest'),
);
