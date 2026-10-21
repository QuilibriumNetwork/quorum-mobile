/**
 * Resolve on the next macrotask, so pending touches, timers, native callbacks
 * and React commits run before the caller continues.
 *
 * `InteractionManager.runAfterInteractions` does not do this here. With the New
 * Architecture its `disableInteractionManager` flag defaults to on, which swaps
 * in a stub that resolves through `setImmediate`, and the bridgeless runtime
 * turns `setImmediate` into a microtask: the "yield" hands the thread straight
 * back, so a loop that awaits it every few items still runs as one long task.
 * `await` on a synchronous MMKV/SQLite read behind `async` doesn't yield either.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
