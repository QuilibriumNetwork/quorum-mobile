/**
 * forceTranslate — bridges the per-item context menus ("Translate" / long-press)
 * to the inline `useTranslatable` hook that owns translation state.
 *
 * The menu and the text renderer are different components, so we coordinate by
 * the text's hash: the menu calls `requestTranslateText(text)`, and the mounted
 * translatable cell for that text (subscribed by the same hash) runs its
 * translation. If no cell is currently subscribed (rare race), the request is
 * held as pending and consumed by the next subscriber for that hash.
 */

import { hashText } from './translationCache';

const listeners = new Map<number, Set<() => void>>();
const pending = new Set<number>();

/** Ask any mounted cell rendering this exact text to translate now. */
export function requestForceTranslate(hash: number): void {
  const ls = listeners.get(hash);
  if (ls && ls.size > 0) {
    ls.forEach((l) => l());
    return;
  }
  pending.add(hash);
}

/** Convenience: hash the text and request translation for it. */
export function requestTranslateText(text: string): void {
  if (!text) return;
  requestForceTranslate(hashText(text.trim()));
}

/** Subscribe a cell (by its text hash). Consumes a pending request immediately. */
export function subscribeForce(hash: number, listener: () => void): () => void {
  let set = listeners.get(hash);
  if (!set) {
    set = new Set();
    listeners.set(hash, set);
  }
  set.add(listener);

  if (pending.has(hash)) {
    pending.delete(hash);
    listener();
  }

  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(hash);
  };
}
