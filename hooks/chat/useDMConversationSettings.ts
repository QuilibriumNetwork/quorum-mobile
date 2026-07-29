/**
 * useDMConversationSettings - per-conversation DM settings that sync across a
 * user's devices.
 *
 * The four overrides (save-edit-history, always-sign, delivery/read receipts)
 * live in `UserConfig.conversationSettings`, keyed by conversationId, and travel
 * on the encrypted config blob — the same mechanism as DM mute. Reading and
 * writing go through the shared `conversationSettingsUtils` helpers so desktop
 * and mobile agree byte-for-byte on the map semantics (per-entry last-write-wins
 * merge, empty-but-timestamped entry as a reset tombstone).
 *
 * Follows the "bookmark pattern" like useDMMute: the value is persisted to the
 * local MMKV config and read straight back from there — never routed through the
 * in-memory `user` object (that read-back bridge is the one that broke
 * primaryUsername / isProfilePublic).
 *
 * The map is held in a module-level store exposed via useSyncExternalStore, so
 * every consumer (the settings sheet, the composer signing lock) sees a change
 * immediately instead of each hook instance keeping its own useState copy.
 *
 * OVERRIDES ONLY: a field equal to its inherited global/default is written as
 * `undefined` (inherit), and a save with no genuine override and no existing
 * entry is skipped entirely — so the synced blob never accumulates
 * default-valued entries. Callers are responsible for comparing against the
 * global before calling `saveOverrides`.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/context';
import { createMMKV } from 'react-native-mmkv';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  logger,
  queryKeys,
  setConversationSetting,
  getConversationSetting,
  type Conversation,
  type ConversationSettingsMap,
  type ConversationSettingKey,
} from '@quilibrium/quorum-shared';
import {
  getLocalConversationSettings,
  getLocalUserConfig,
  setLocalConversationSetting,
  setLocalConversationSettings,
} from '@/services/config';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';

/** Patch shape for a save: any subset of the override keys. */
export type ConversationSettingsPatch = Partial<
  Record<ConversationSettingKey, boolean | undefined>
>;

/** The legacy device-local fields this feature replaces. */
const LEGACY_KEYS: ConversationSettingKey[] = [
  'isRepudiable',
  'saveEditHistory',
  'deliveryReceipts',
  'readReceipts',
];

// --- Module-level shared store (one source of truth across hook instances) ---

let settingsMap: ConversationSettingsMap = {};
/**
 * The user's global "always sign messages" preference (desktop's
 * UserConfig.nonRepudiable, default on) — the value an unset conversation
 * inherits. Cached here rather than read per render because getLocalUserConfig
 * parses the whole config blob. Refreshed on load/login, matching the freshness
 * of every other config-carried field (restart / login / config pull, not live).
 */
let globalNonRepudiable = true;
let loadedForAddress: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ConversationSettingsMap {
  return settingsMap;
}

/** Load (once per address) from the local config, then run the legacy sweep. */
function ensureLoaded(address: string, queryClient: QueryClient): void {
  if (loadedForAddress === address) return;
  loadedForAddress = address;
  settingsMap = getLocalConversationSettings(address);
  globalNonRepudiable = getLocalUserConfig(address)?.nonRepudiable ?? true;
  emit();
  // Fire-and-forget: the sweep re-emits if it folds anything in.
  void migrateLegacyConversationSettings(address, queryClient);
}

/**
 * Clear the in-memory map on logout. Without this the module-level state
 * outlives the session (there's no JS reload on sign-out), so a same-address
 * re-login after a config wipe would keep serving the pre-logout overrides.
 */
function resetForLogout(): void {
  if (loadedForAddress === null && Object.keys(settingsMap).length === 0) return;
  loadedForAddress = null;
  settingsMap = {};
  globalNonRepudiable = true;
  emit();
}

// --- One-time migration of the legacy device-local settings ---
//
// Before this feature these four fields lived on the local Conversation record
// and never synced. The sweep folds any existing values into the synced map so a
// user's choices reach their other devices, then STRIPS them from the local
// record: left in place, a stale local value would shadow a reset made on
// another device (the map's empty tombstone entry reads as "no override", so the
// dual-read would fall through to the stale local field forever).

const migrationStore = createMMKV({ id: 'dm-conv-settings' });
/** Schema version — bump to re-run the sweep if the shape ever changes. */
const MIGRATION_KEY_PREFIX = 'migrated:v1:';
/** Low timestamp so any real edit (or already-synced entry) beats a seeded one. */
const MIGRATION_TS = 1;

async function migrateLegacyConversationSettings(
  address: string,
  queryClient: QueryClient
): Promise<void> {
  const flagKey = `${MIGRATION_KEY_PREFIX}${address}`;
  if (migrationStore.getBoolean(flagKey)) return;

  try {
    const adapter = getMMKVAdapter();
    // Deliberately unbounded: getConversations parses the entire stored list
    // before slicing, so asking for all of it costs nothing, while a truncated
    // page would set the flag below and leave the remaining conversations
    // unmigrated with no retry path.
    const { conversations } = await adapter.getConversations({
      type: 'direct',
      limit: Number.MAX_SAFE_INTEGER,
    });

    // PHASE 1 — collect, writing nothing.
    let map: ConversationSettingsMap = getLocalConversationSettings(address);
    const toStrip: string[] = [];
    let folded = 0;

    for (const conv of conversations) {
      const id = conv.conversationId;
      if (!id) continue;

      const legacy: ConversationSettingsPatch = {};
      for (const key of LEGACY_KEYS) {
        const value = (conv as Conversation)[key];
        if (typeof value === 'boolean') legacy[key] = value;
      }
      if (Object.keys(legacy).length === 0) continue;

      // Fold in only when the synced map has nothing for this conversation —
      // an entry already there came from a real edit (here or on another
      // device) and must not be overwritten by a stale local value.
      if (!map[id]) {
        map = setConversationSetting(map, id, legacy, MIGRATION_TS);
        folded++;
      }
      toStrip.push(id);
    }

    // PHASE 2 — persist the fold BEFORE touching any local record. Order
    // matters: stripping first and saving after would lose settings outright if
    // the app dies mid-sweep, because a stripped record carries nothing to fold
    // on the retry. This way an interruption leaves the values safe in the
    // config and merely defers the cleanup, which the retry finishes.
    if (folded > 0) {
      const persisted = await setLocalConversationSettings(address, map);
      // Drop the result if the session moved on while we were awaiting — a
      // sign-out plus a different sign-in would otherwise leave this user's
      // entries in a store the next account is reading.
      if (loadedForAddress === address) {
        settingsMap = persisted;
        emit();
      }
    }

    // PHASE 3 — drop the legacy fields now that the map owns them. Left behind,
    // a stale local value would shadow a reset made on another device: a reset
    // writes an empty timestamped entry, which reads as "no override", so the
    // dual-read would fall through to the local field forever.
    // Re-read each record rather than writing back the phase-1 copy: phase 2
    // includes a network round-trip, and an incoming message during that window
    // updates the conversation (preview, timestamp, unread). Writing the stale
    // copy would silently revert it.
    for (const id of toStrip) {
      const current = await adapter.getConversation(id);
      if (!current) continue;
      const cleaned = { ...current } as Record<string, unknown>;
      for (const key of LEGACY_KEYS) delete cleaned[key];
      await adapter.saveConversation(cleaned as Conversation);
    }

    if (toStrip.length > 0) {
      // Cached conversation objects still carry the fields just stripped from
      // storage, and the dual-read's fallback reads them off that cache.
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all('direct') });
      for (const id of toStrip) {
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) });
      }
      logger.log(
        `[DMConversationSettings] migrated ${folded} legacy conversation setting(s) into synced config (${toStrip.length} local record(s) cleaned)`
      );
    }

    migrationStore.set(flagKey, true);
  } catch (error) {
    // Non-fatal: the dual-read fallback keeps legacy values working. The flag
    // stays unset so the sweep retries on the next launch.
    logger.warn(
      `[DMConversationSettings] migration sweep failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Shared session wiring: load on first sight of an address, clear on sign-out. */
function useSettingsSession(): string | null {
  const { user } = useAuth();
  const address = user?.address ?? null;
  const queryClient = useQueryClient();

  // Load synchronously on first sight of this address so the very first render
  // already has the right values (no one-frame flash of a wrong toggle).
  // `ensureLoaded` is idempotent (guarded on `loadedForAddress`); reading an
  // external store during render is explicitly supported by useSyncExternalStore.
  if (address) ensureLoaded(address, queryClient);

  // Clearing on sign-out is a state change, so it belongs in an effect.
  useEffect(() => {
    if (!address) resetForLogout();
  }, [address]);

  return address;
}

/**
 * Prime the store and run the one-time legacy sweep WITHOUT subscribing to
 * changes. Mount this on the conversation list, mirroring where useDMMute
 * loads: the sweep is what folds a user's existing device-local settings into
 * the synced map, so gating it on opening one specific chat would leave an
 * untouched conversation's settings unsynced indefinitely.
 */
export function useDMConversationSettingsLoader(): void {
  useSettingsSession();
}

export function useDMConversationSettings() {
  const address = useSettingsSession();
  const settings = useSyncExternalStore(subscribe, getSnapshot);

  /**
   * Read one override. `undefined` means no override — the caller falls back to
   * the legacy local Conversation field, then the global setting, then the
   * default.
   */
  const getOverride = useCallback(
    (conversationId: string, key: ConversationSettingKey): boolean | undefined =>
      getConversationSetting(settings, conversationId, key),
    [settings]
  );

  /**
   * Persist a patch of overrides. A key set to `undefined` clears that override
   * (reset-to-global). Bumps the entry's `updatedAt` so the change wins the
   * cross-device merge.
   */
  const saveOverrides = useCallback(
    (conversationId: string, patch: ConversationSettingsPatch): void => {
      if (!address) return;

      // Overrides-only hygiene: with nothing to store AND no entry to clear
      // there is nothing to do — skip so we never write an empty entry that
      // only exists to say "all defaults". When an entry DOES exist we still
      // write, so an all-inherited patch clears it and the reset propagates.
      const hasOverride = Object.values(patch).some((v) => v !== undefined);
      if (!hasOverride && !settingsMap[conversationId]) return;

      // Optimistic in-memory update so the toggle moves immediately; the
      // persisted map is recomputed from the stored config inside
      // setLocalConversationSetting, so rapid toggles compose there too. The
      // two copies can differ only in `updatedAt` (by under a millisecond),
      // which no read path consults.
      settingsMap = setConversationSetting(settingsMap, conversationId, patch);
      emit();

      void setLocalConversationSetting(address, conversationId, patch).catch((error) => {
        // The local MMKV write throwing is the only way to land here (the
        // outbound sync failure is caught and logged one level down). No
        // rollback: the in-memory value is what the user just chose, and the
        // next cold read reconciles from storage.
        logger.warn(
          `[DMConversationSettings] failed to persist override for ${conversationId}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    },
    [address]
  );

  return {
    settings,
    getOverride,
    saveOverrides,
    /** Global "always sign" preference an unset conversation inherits. */
    globalNonRepudiable,
  };
}
