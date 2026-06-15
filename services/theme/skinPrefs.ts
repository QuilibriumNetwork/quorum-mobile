/**
 * skinPrefs — persisted active skin + the local skin library.
 *
 * Mirrors the MMKV pattern in services/farcaster/feedPrefs.ts. MMKV reads are
 * synchronous, so the active skin's *tokens* (colors/radii/borders) are
 * available before first paint with zero async work — only the embedded font
 * and wallpaper image are loaded asynchronously.
 *
 * Stored skins are always re-validated on read (see getSkin): the store could
 * have been written by an older/newer build, and a skin must never be applied
 * without passing the same allow-list validation used at import time.
 */

import { createMMKV } from 'react-native-mmkv';
import { validateSkin } from '@/theme/skins/validate';
import type { SkinOverride } from '@/theme/skins/types';

export const skinPrefsStore = createMMKV({ id: 'quorum-skin-prefs' });

const K_ACTIVE_SKIN_ID = 'activeSkinId';
const K_SKIN_PREFIX = 'skin:';
const K_INSTALLED_IDS = 'installedSkinIds';

/** Id of the currently-applied skin, or null for the built-in theme. */
export function getActiveSkinId(): string | null {
  return skinPrefsStore.getString(K_ACTIVE_SKIN_ID) ?? null;
}

export function setActiveSkinId(id: string | null): void {
  if (id) skinPrefsStore.set(K_ACTIVE_SKIN_ID, id);
  else skinPrefsStore.remove(K_ACTIVE_SKIN_ID);
}

/** Read + validate a stored skin. Returns null if missing or no longer valid. */
export function getSkin(id: string): SkinOverride | null {
  const raw = skinPrefsStore.getString(`${K_SKIN_PREFIX}${id}`);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = validateSkin(parsed);
  return result.ok ? result.skin : null;
}

/** Persist a skin into the local library (assumed already validated). */
export function saveSkin(skin: SkinOverride): void {
  skinPrefsStore.set(`${K_SKIN_PREFIX}${skin.id}`, JSON.stringify(skin));
  const ids = getInstalledIds();
  if (!ids.includes(skin.id)) {
    skinPrefsStore.set(K_INSTALLED_IDS, JSON.stringify([...ids, skin.id]));
  }
}

export function deleteSkin(id: string): void {
  skinPrefsStore.remove(`${K_SKIN_PREFIX}${id}`);
  skinPrefsStore.set(K_INSTALLED_IDS, JSON.stringify(getInstalledIds().filter((x) => x !== id)));
  if (getActiveSkinId() === id) setActiveSkinId(null);
}

function getInstalledIds(): string[] {
  const raw = skinPrefsStore.getString(K_INSTALLED_IDS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** All locally-saved skins (validated). */
export function listSkins(): SkinOverride[] {
  return getInstalledIds()
    .map((id) => getSkin(id))
    .filter((s): s is SkinOverride => s !== null);
}

/** The active skin object (validated), or null. */
export function getActiveSkin(): SkinOverride | null {
  const id = getActiveSkinId();
  return id ? getSkin(id) : null;
}

/** User's manual appearance choice for the BUILT-IN theme. Has no effect while
 *  a custom skin is active (skins pin their own base). Stored independently of
 *  the active skin so it survives switching to a skin and back. */
export type AppearancePref = 'system' | 'light' | 'dark';

const K_APPEARANCE = 'appearancePref';

/** Manual appearance choice; 'system' (follow device) when unset or invalid. */
export function getAppearancePref(): AppearancePref {
  const raw = skinPrefsStore.getString(K_APPEARANCE);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function setAppearancePref(pref: AppearancePref): void {
  // Store only an explicit override; 'system' is the absence of a key.
  if (pref === 'system') skinPrefsStore.remove(K_APPEARANCE);
  else skinPrefsStore.set(K_APPEARANCE, pref);
}
