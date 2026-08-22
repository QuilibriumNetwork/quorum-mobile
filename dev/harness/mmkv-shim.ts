// react-native-mmkv replacement for Node.
//
// MMKV is a JSI native module — it does not exist outside a device. Mobile's
// storage layer is built on it in ~29 places, so without this the harness cannot
// import most of services/.
//
// In-memory only, and deliberately so: harness runs must not leave state on the
// developer's machine, and every scenario should start from a known-empty store
// unless it explicitly seeds one.
//
// Instances are keyed by id, matching MMKV's real semantics — two
// `createMMKV({ id: 'quorum-config' })` calls return the SAME store, which
// mobile relies on (configService and others call it at module scope from
// several files).

/** The subset of MMKV's surface mobile actually uses (grepped, not guessed). */
export interface MMKV {
  set(key: string, value: string | number | boolean): void;
  getString(key: string): string | undefined;
  getNumber(key: string): number | undefined;
  getBoolean(key: string): boolean | undefined;
  remove(key: string): void;
  clearAll(): void;
  getAllKeys(): string[];
  contains(key: string): boolean;
}

const stores = new Map<string, Map<string, string | number | boolean>>();

export function createMMKV(opts: { id: string }): MMKV {
  const id = opts?.id ?? 'default';
  let store = stores.get(id);
  if (!store) {
    store = new Map();
    stores.set(id, store);
  }
  const s = store;

  return {
    set: (key, value) => void s.set(key, value),
    // Real MMKV returns undefined for a missing key and does NOT coerce across
    // types, so a value stored as a number must not come back from getString.
    // Matching that matters: mobile branches on `?? null` in several places.
    getString: (key) => {
      const v = s.get(key);
      return typeof v === 'string' ? v : undefined;
    },
    getNumber: (key) => {
      const v = s.get(key);
      return typeof v === 'number' ? v : undefined;
    },
    getBoolean: (key) => {
      const v = s.get(key);
      return typeof v === 'boolean' ? v : undefined;
    },
    remove: (key) => void s.delete(key),
    clearAll: () => s.clear(),
    getAllKeys: () => [...s.keys()],
    contains: (key) => s.has(key),
  };
}

/**
 * Test helper — empty every store in THIS module instance. Not part of the real
 * MMKV API.
 *
 * ⚠️ **It does not reset the app's storage when a scenario imports it as
 * `'./mmkv-shim'`, and that is not fixable from in here.** MEASURED 2026-08-22:
 * a scenario importing it relatively logged `stores = []` while the app's spaces
 * store was populated and being read normally. App code reaches this file
 * through the `^react-native-mmkv$` moduleNameMapper rule, and jest gives the
 * mapped request its own module registry entry — so the two specifiers produce
 * two INSTANCES, each with its own private `stores`. The scenario clears an
 * empty registry and nothing happens.
 *
 * Existing scenarios are unaffected only by luck: they call this once in
 * `beforeAll`, where a fresh jest module registry means the stores were empty
 * regardless. Nothing was silently broken by it — but nothing was reset either.
 *
 * **To actually clear state between tests, use the app's own API**, which by
 * construction holds the same handle as the code under test:
 *
 * ```ts
 * import { clearSpaceStorage } from '@/services/config/spaceStorage';
 * beforeEach(() => clearSpaceStorage());
 * ```
 *
 * The symptom when you get this wrong is not a crash: it is a security
 * assertion passing while the function under test returned early and never ran.
 *
 * The in-place clear below is still the right implementation independent of all
 * that. `createMMKV` closes over its own Map (`s` above), so the previous
 * `stores.clear()` dropped the registry while live handles kept pointing at
 * populated Maps — and a later `createMMKV` for the same id would mint a SECOND
 * Map, leaving two handles to one id silently diverging.
 */
export function __resetAllMMKV(): void {
  for (const store of stores.values()) store.clear();
}

export default { createMMKV };
