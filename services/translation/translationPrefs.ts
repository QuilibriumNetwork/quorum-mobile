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
 *
 * The sentinel TRANSLATION_OFF ('off' — not a valid ISO-639 code) disables the
 * feature entirely: no toggles, no context-menu Translate. Consumers gate on
 * `isTranslationOff(stored)`; the resolve helpers below never leak the sentinel
 * as a language code.
 */

import { createMMKV } from 'react-native-mmkv';
import { getLocales } from 'expo-localization';

export const translationPrefsStore = createMMKV({ id: 'quorum-translation-prefs' });

export const K_TARGET_LANGUAGE = 'targetLanguage';

/** Stored in K_TARGET_LANGUAGE to mean "do not translate anywhere". */
export const TRANSLATION_OFF = 'off';

/** Whether the stored value disables the translation feature entirely. */
export function isTranslationOff(stored: string | undefined): boolean {
  return stored === TRANSLATION_OFF;
}

/** Device language as an ISO-639 primary code (e.g. "en", "es"). */
export function deviceLanguage(): string {
  try {
    return getLocales()[0]?.languageCode ?? 'en';
  } catch {
    return 'en';
  }
}

/** The effective target language: user override if set, else device language.
 *  Returns the device language for TRANSLATION_OFF — check isTranslationOff. */
export function getTargetLanguage(): string {
  const v = translationPrefsStore.getString(K_TARGET_LANGUAGE);
  return resolveTarget(v);
}

/** Set a manual override. Pass '' to revert to following the device language. */
export function setTargetLanguage(code: string): void {
  translationPrefsStore.set(K_TARGET_LANGUAGE, code);
}

/** Resolve a possibly-reactive stored value to an effective code. The OFF
 *  sentinel resolves to the device language so it never reaches the translator
 *  as a bogus code — callers gate the feature via isTranslationOff first. */
export function resolveTarget(stored: string | undefined): string {
  if (!stored || stored.length === 0 || stored === TRANSLATION_OFF) return deviceLanguage();
  return stored;
}
