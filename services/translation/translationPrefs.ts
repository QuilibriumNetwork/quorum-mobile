/**
 * translationPrefs — persisted target language for on-device translation.
 *
 * The target defaults to the device language and can be overridden by the user
 * via the "Translate to…" picker in Profile settings. Backed by a small
 * dedicated MMKV instance, exported so UI and the `useTranslatable` hook can
 * subscribe reactively via `useMMKVString`, keeping the picker and visible
 * cells in sync without a refetch.
 *
 * An empty stored value means "follow the device language", so switching back
 * to the device default just writes ''.
 */

import { createMMKV } from 'react-native-mmkv';
import { getLocales } from 'expo-localization';

export const translationPrefsStore = createMMKV({ id: 'quorum-translation-prefs' });

export const K_TARGET_LANGUAGE = 'targetLanguage';

/** Device language as an ISO-639 primary code (e.g. "en", "es"). */
export function deviceLanguage(): string {
  try {
    return getLocales()[0]?.languageCode ?? 'en';
  } catch {
    return 'en';
  }
}

/** The effective target language: user override if set, else device language. */
export function getTargetLanguage(): string {
  const v = translationPrefsStore.getString(K_TARGET_LANGUAGE);
  return v && v.length > 0 ? v : deviceLanguage();
}

/** Set a manual override. Pass '' to revert to following the device language. */
export function setTargetLanguage(code: string): void {
  translationPrefsStore.set(K_TARGET_LANGUAGE, code);
}

/** Resolve a possibly-reactive stored value to an effective code. */
export function resolveTarget(stored: string | undefined): string {
  return stored && stored.length > 0 ? stored : deviceLanguage();
}
