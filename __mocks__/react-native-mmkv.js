/**
 * In-memory MMKV, used automatically by every jest test.
 *
 * ## Why this file exists at all
 *
 * `react-native-mmkv` reaches NitroModules at IMPORT time, which needs a native
 * binary that does not exist under jest. So merely importing anything that
 * touches storage — and the theme provider does, three levels down — throws
 * `'NitroModules' could not be found` before a single line of a test runs.
 *
 * That is survivable for a function-level test, which can import one pure module
 * and stub the rest by hand. It is not survivable for a RENDER test: rendering a
 * real screen pulls in its real provider chain, so the stub has to be in place
 * for the whole app, not for one import.
 *
 * ## Why a root `__mocks__` file rather than a setup file
 *
 * For a package in `node_modules`, jest uses a root-level `__mocks__/<name>.js`
 * AUTOMATICALLY — no `jest.mock()` call, no `setupFiles` entry, no ordering to
 * get wrong. Ordering is the trap here: the mock must be registered before the
 * module graph is walked, and a setup file that runs "early enough" today can
 * quietly stop being early enough later.
 *
 * It also leaves the existing per-file `jest.mock('react-native-mmkv', ...)`
 * calls working unchanged, since a local mock still wins over this one. Nothing
 * had to be edited to add this.
 *
 * ## Behaviour
 *
 * A real store, not a null object: values written are readable again. Several
 * modules write a default at import time and read it straight back, and a stub
 * that silently dropped writes would make those read as "no value stored",
 * which is a different app state rather than an obviously broken one.
 *
 * Each `createMMKV()` call returns its OWN store, matching the real library,
 * where separate instance IDs are separate partitions. Sharing one map here
 * would let an unrelated module's key collide with yours and pass.
 */

/**
 * Change listeners by store id. The real library keeps one process-wide
 * registry keyed by the store's id and notifies it on every `set`, `remove`
 * and `clearAll` (`cpp/MMKVValueChangedListenerRegistry.cpp`), so hooks that
 * re-read on change (rather than poll) behave here as they do on a device.
 */
const listenersById = new Map();

function notify(id, key) {
  const listeners = listenersById.get(id);
  if (!listeners) return;
  for (const listener of [...listeners]) listener(key);
}

function createStore(id = 'mmkv.default') {
  const store = new Map();
  const removeKey = (k) => {
    const had = store.delete(k);
    if (had) notify(id, k);
    return had;
  };

  return {
    getString: (k) => store.get(k),
    getNumber: (k) => (store.has(k) ? Number(store.get(k)) : undefined),
    getBoolean: (k) => (store.has(k) ? store.get(k) === true || store.get(k) === 'true' : undefined),
    set: (k, v) => {
      store.set(k, v);
      notify(id, k);
    },
    delete: removeKey,
    // The adapter code calls `remove` in places and `delete` in others; the real
    // library has both, so a stub missing one fails only on some paths.
    remove: removeKey,
    getAllKeys: () => Array.from(store.keys()),
    contains: (k) => store.has(k),
    clearAll: () => {
      const keys = Array.from(store.keys());
      store.clear();
      for (const k of keys) notify(id, k);
    },
    recrypt: () => {},
    // Compaction has no in-memory equivalent. `size` approximates the live-data
    // byte count the real one reports, which is all its callers use it for.
    trim: () => {},
    get size() {
      let n = 0;
      for (const [k, v] of store) n += String(k).length + String(v).length;
      return n;
    },
    addOnValueChangedListener: (listener) => {
      let listeners = listenersById.get(id);
      if (!listeners) {
        listeners = new Set();
        listenersById.set(id, listeners);
      }
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
}

const createMMKV = (config) => createStore(config && config.id);

/** Class form, for the `new MMKV()` call sites. */
class MMKV {
  constructor(config) {
    Object.assign(this, createStore(config && config.id));
  }
}

/** Hook forms. Inert rather than reactive: no render test asserts on a stored
 *  preference changing mid-test, and a fake subscription would be a second
 *  behaviour to keep in step with the real one for no gain. */
const useMMKVString = () => [undefined, () => {}];
const useMMKVNumber = () => [undefined, () => {}];
const useMMKVBoolean = () => [undefined, () => {}];
const useMMKVObject = () => [undefined, () => {}];

module.exports = {
  createMMKV,
  MMKV,
  useMMKVString,
  useMMKVNumber,
  useMMKVBoolean,
  useMMKVObject,
};
