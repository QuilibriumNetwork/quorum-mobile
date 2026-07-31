// Ambient types for react-test-renderer, which ships none of its own.
//
// Why a local declaration rather than `@types/react-test-renderer`: the harness
// is built on adding no dependencies (see README §"How it stays out of the app's
// way"), and react-test-renderer is not a declared dependency at all — it
// arrives transitively through jest-expo. Depending on types for a package we
// deliberately do not depend on would be incoherent, and the devDependency would
// churn yarn.lock and fire package.json's postinstall cache wipe.
//
// Scope is exactly what the harness calls. This is not an attempt to describe
// the library: bot.ts and two-bot-feasibility.scenario.ts use `create()` and the
// returned `unmount()`, and nothing else. Extend it when a scenario needs more.
//
// ⚠️ If `@types/react-test-renderer` is ever installed, DELETE this file — two
// declarations of the same module collide, and the real ones should win.
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  /** The subset of the renderer instance the harness touches. */
  export interface TestRendererInstance {
    unmount(): void;
  }

  export function create(element: ReactElement): TestRendererInstance;

  const TestRenderer: {
    create: typeof create;
  };

  export default TestRenderer;
}
