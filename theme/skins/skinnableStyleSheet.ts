/**
 * Skin-reactive static stylesheets.
 *
 * `StyleSheet.create({...})` runs once at module load, so any `Skin.radius()` /
 * `Skin.space()` / `Skin.font()` inside a module-level static stylesheet
 * captures the BOOT skin and never updates on a live skin switch. Wrapping the
 * stylesheet in `createSkinnable(() => StyleSheet.create({...}))` makes each
 * top-level style entry a getter that re-runs the factory when the skin
 * geometry changes (version bump). Components already re-render on skin change
 * (they consume `useTheme` for colors), so on that re-render they read the
 * getters and get freshly-scaled geometry — no relaunch, no tree remount.
 *
 * Colors aren't affected (static styles only ever hold intentional fixed
 * colors); this is purely about re-scaling geometry/typography live.
 */

let version = 0;

/** Invalidate all skinnable static stylesheets (call on skin/geometry change). */
export function bumpStyleVersion(): void {
  version++;
}

/**
 * Wrap a `() => StyleSheet.create({...})` factory so its entries re-resolve
 * after a `bumpStyleVersion()`. The factory runs once eagerly to discover the
 * keys, then again lazily whenever the version has advanced.
 */
export function createSkinnable<T extends Record<string, unknown>>(factory: () => T): T {
  let cached = factory();
  let cachedVersion = version;
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(cached)) {
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      get() {
        if (cachedVersion !== version) {
          cached = factory();
          cachedVersion = version;
        }
        return cached[key];
      },
    });
  }
  return out as T;
}
