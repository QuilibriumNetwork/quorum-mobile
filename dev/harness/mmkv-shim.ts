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

/** Test helper — drop every store. Not part of the real MMKV API. */
export function __resetAllMMKV(): void {
  stores.clear();
}

export default { createMMKV };
