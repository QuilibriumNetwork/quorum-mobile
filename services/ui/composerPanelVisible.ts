/**
 * composerPanelVisible — reactive module-level store for "the chat composer's
 * emoji panel is open". Two unrelated parts of the tree react to it:
 *   - the Tabs layout hides the bottom tab bar so the panel gets more room; and
 *   - the chat screens drop their EFFECTIVE chrome height to 0 so the bottom fade
 *     and the message-list inset collapse the (now vacated) tab-bar zone. (The
 *     composer's own animated spacer handles the panel reaching the screen
 *     bottom; it is fed the RAW tab-bar height, not this zeroed value.)
 *
 * Why a module-level store and not React context: the producer (MessageInput,
 * deep in a chat screen) and the consumers (the Tabs layout above it, and the
 * chat screen itself) don't share a convenient common provider, and a context
 * would re-render every tab on each toggle. `useSyncExternalStore` gives the
 * consumers a cheap reactive subscription. Mirrors the existing
 * `feedActiveTab` bus rationale, but this one holds state (not a one-shot event).
 */

import { useSyncExternalStore } from 'react';
import { makeMutable, type SharedValue } from 'react-native-reanimated';

let panelOpen = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// UI-thread flag: "the composer owns the bottom of the screen" — 1 from the
// moment the panel opens, held through the panel↔keyboard hand-off, cleared only
// once the keyboard has settled (or on a plain close). It spans the brief gap
// where the panel is already closed but the summoned keyboard hasn't started
// rising yet — without it the tab bar flickers in during that gap. Set by
// useComposerPanel (which owns the hand-off state) and read by the tab bar's
// visibility worklet, so the bar reacts with no React render lag.
export const composerBottomBusySV: SharedValue<number> = makeMutable(0);

export const composerPanelVisibleStore = {
  /** Producer: set whether the composer emoji panel is currently open. */
  set(open: boolean) {
    if (panelOpen === open) return;
    panelOpen = open;
    emit();
  },
  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): boolean {
    return panelOpen;
  },
};

/** Reactive hook: re-renders the caller when the composer panel opens/closes. */
export function useComposerPanelVisible(): boolean {
  return useSyncExternalStore(
    composerPanelVisibleStore.subscribe,
    composerPanelVisibleStore.getSnapshot,
    composerPanelVisibleStore.getSnapshot,
  );
}
